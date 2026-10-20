import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify, stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import { rmdir } from 'node:fs/promises';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from './disk';
import { atomicJson } from './files';
import { inspectProcess, sanitizeOutput, terminateOwnedProcess, type RuntimeLaunchPlan } from './instance-process';
import { attachProcessJob, type WindowsProcessJob } from './windows-job';
import type { DshInstance, DshRuntime } from '../../shared/dsh-launcher';
import type * as Koffi from 'koffi';
import { PTY_WORKER_MARKER, terminalPtyWorkerSource } from './terminal-pty-worker';
import { CLI_MODEL_OVERLAY_MARKER,cliModelOverlaySource } from './cli-model-overlay';
import { supportsSharedDataRuntime } from '../../shared/dsh-runtime-compatibility';
import { compatibilityContract, readRuntimeCompatibility } from './runtime-compatibility';
import { CliAdmission } from './cli-admission';

const execute = promisify(execFile);
const OUTPUT_LIMIT = 64 * 1024;
const CONTEXT_FORMAT = 'worldlinebox-dsh-cli-context-v1';
const CMD_MARKER = ':: WorldlineBox managed DSH command v1';
const SHIM_MARKER = '// WorldlineBox managed DSH shim v1';
const ENV_KEYS = new Set(['DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_DESKTOP_NODE_EXECUTABLE', 'DSH_DESKTOP_RUNTIME_ROOT',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'PNPM_HOME',
  'npm_config_cache', 'npm_config_store_dir', 'pnpm_config_store_dir', 'pnpm_config_cache_dir', 'pnpm_config_state_dir',
  'PYTHONPYCACHEPREFIX', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'PUPPETEER_CACHE_DIR',
  'GIT_CONFIG_GLOBAL', 'HISTFILE', 'NODE_REPL_HISTORY', 'NO_COLOR', 'FORCE_COLOR']);

/** ConPTY receives this plain object directly; Windows aliases must not compete. */
export function managedTerminalEnvironment(base: NodeJS.ProcessEnv, commandDirectory: string): NodeJS.ProcessEnv {
  const inheritedPath = Object.entries(base).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const env = { ...base };
  for (const key of Object.keys(env)) if (/^(PATH$|ELECTRON_|PSModulePath$|WORLDLINEBOX_DSH_CLI_CONTEXT$)/i.test(key)) delete env[key];
  env.PATH = `${commandDirectory}${path.delimiter}${inheritedPath}`;
  env.PSModulePath = path.join(env.SystemRoot ?? process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return env;
}

export interface DshCliSelection {
  instance: DshInstance; plan: RuntimeLaunchPlan; env: NodeJS.ProcessEnv; workspacePath: string;
  routingPatch: string; runtimeVersion?: string; nativeCli?: string; nativeArgs?: string[];
  runtime?: DshRuntime;
}
export interface DshTerminalSummary {
  id: string; instanceId: string; runtimeVersion: string; status: 'running' | 'stopped'; cwd: string;
  pid?: number; lastExitCode?: number | null;
  output: string; outputOffset: number; outputRevision: number; cols: number; rows: number; transport: 'conpty' | 'pipe';
}
export interface DshCliTerminalState {
  selectedInstanceId?: string; commandPath: string; binPath: string; pathEnabled: boolean;
  output: string; terminal?: DshTerminalSummary; terminals: DshTerminalSummary[]; activeTerminalId?: string;
}
export interface DshTerminalOutput { terminalId: string; stream: 'stdout' | 'stderr' | 'system'; text: string }
interface TerminalSession extends DshTerminalSummary {
  worker?: ChildProcessWithoutNullStreams; job?: WindowsProcessJob; finished?: Promise<void>;
  closing?: Promise<void>;
  pendingInputBytes?: number;
}
export interface DshCliUseJournal {
  format: 'worldlinebox-dsh-cli-use-v1'; instanceId: string; pid: number; executable: string; createdAt: string;
  childPid?: number; childExecutable?: string; childCreatedAt?: string;
}
/** Only exact recorded process identities count; reused PIDs never block or get killed. */
export async function activeDshCliUses(rootPath: string, instanceId?: string): Promise<DshCliUseJournal[]> {
  const directory = path.join(path.resolve(rootPath), 'shared', '.cli-users');
  const stats = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!stats) return [];
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('CLI activity directory is not managed.');
  const entries = (await readdir(directory)).filter(name => /^[1-9][0-9]*\.json$/.test(name));
  if (entries.length > 1000) throw new Error('Too many CLI activity records to safely inspect.');
  const active: DshCliUseJournal[] = [];
  for (const name of entries) {
    const file = path.join(directory, name); const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Invalid CLI activity record.');
    const bytes = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (bytes === undefined) continue;
    const journal = JSON.parse(bytes) as DshCliUseJournal;
    if (journal.format !== 'worldlinebox-dsh-cli-use-v1' || !/^[a-z0-9-]{1,80}$/.test(journal.instanceId)
      || !Number.isSafeInteger(journal.pid) || journal.pid < 1 || `${journal.pid}.json` !== name
      || typeof journal.executable !== 'string' || !path.isAbsolute(journal.executable) || typeof journal.createdAt !== 'string' || !Number.isFinite(Date.parse(journal.createdAt))) throw new Error('Unsupported CLI activity identity.');
    if (instanceId && journal.instanceId !== instanceId) continue;
    const owner = await inspectProcess(journal.pid);
    if (owner && samePath(owner.executable, journal.executable) && owner.createdAt === journal.createdAt) { active.push(journal); continue; }
    if (journal.childPid !== undefined) {
      if (!Number.isSafeInteger(journal.childPid) || journal.childPid < 1 || typeof journal.childExecutable !== 'string'
        || !path.isAbsolute(journal.childExecutable) || typeof journal.childCreatedAt !== 'string' || !Number.isFinite(Date.parse(journal.childCreatedAt))) throw new Error('Unsupported CLI child identity.');
      const child = await inspectProcess(journal.childPid);
      if (child && samePath(child.executable, journal.childExecutable) && child.createdAt === journal.childCreatedAt) active.push(journal);
    }
  }
  return active;
}
/** Exclude .cli-users and .cli-exclusive.lock from shared-data archive inventories. */
export async function withDshCliExclusive<T>(rootPath: string, operation: () => Promise<T>, instanceId?: string): Promise<T> {
  const shared = path.join(path.resolve(rootPath), 'shared'); const stats = await lstat(shared);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Shared CLI data root is not managed.');
  const barrier = path.join(shared, '.cli-exclusive.lock');
  const ownerFile = path.join(barrier, 'owner.json');
  const acquire = async (): Promise<void> => {
    try { await mkdir(barrier); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const metadata = await lstat(ownerFile).catch(() => undefined);
      if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) throw new Error('An exclusive shared-data operation has an unverifiable lock; retain it for recovery.', { cause: error });
      const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as { format: string; pid: number; executable: string; createdAt: string };
      if (owner.format !== 'worldlinebox-dsh-cli-exclusive-v1' || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.executable !== 'string' || typeof owner.createdAt !== 'string') throw new Error('Unsupported exclusive-operation identity.', { cause: error });
      const current = await inspectProcess(owner.pid);
      if (current && samePath(current.executable, owner.executable) && current.createdAt === owner.createdAt) throw new Error('Another exclusive shared-data operation is in progress.', { cause: error });
      if ((await readdir(barrier)).some(entry => entry !== 'owner.json')) throw new Error('Interrupted CLI admission metadata needs inspection.', { cause: error });
      await rm(ownerFile); await rmdir(barrier); await mkdir(barrier);
    }
  };
  await acquire();
  try {
    const owner = await inspectProcess(process.pid);
    await atomicJson(ownerFile, { format: 'worldlinebox-dsh-cli-exclusive-v1', pid: process.pid, executable: owner?.executable ?? process.execPath, createdAt: owner?.createdAt ?? new Date().toISOString() });
    const active = await activeDshCliUses(rootPath, instanceId);
    if (active.length) throw new Error(`CLI tasks still own instance data: ${active.map(use => use.instanceId).join(', ')}. Stop those CLI tasks before this operation.`);
    return await operation();
  } finally { await rm(ownerFile, { force: true }); await rmdir(barrier); }
}
interface PersistedCliContext {
  format: typeof CONTEXT_FORMAT; instanceId: string; runtimeId: string; runtimeVersion: string;
  runtimeContentSha256: string; executable: string; nativeCli: string; nativeArgs: string[];
  routingPatch: string; workspacePath: string; env: Record<string, string>;
}
function powershellPath(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
function quotedPowerShell(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function within(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function samePath(first: string, second: string): boolean {
  const a = path.resolve(first); const b = path.resolve(second);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
/** Strip display controls before matching keys, including whole quoted credential values. */
export function maskDshTerminalOutput(value: string): string {
  return sanitizeOutput(stripVTControlCharacters(value).replace(/(https?:\/\/)[^/@\s]+@/gi,'$1[redacted]@').replace(/(authorization\s*["']?\s*[:=]\s*)(?:bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,}\s]+)/gi, '$1[redacted]').replace(
    /((?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,}\s]+)/gi,
    '$1[redacted]',
  ));
}

export class DshCliTerminal {
  private readonly root: string;
  private readonly directory: string;
  private readonly contextFile: string;
  private readonly bin: string;
  private readonly command: string;
  private selected?: PersistedCliContext;
  private readonly terminals = new Map<string, TerminalSession>();
  private activeTerminalId?: string;
  private contextOutput = '';
  private readonly opening = new Set<string>();
  private pathEnabled = false;
  private notification?: NodeJS.Timeout;
  private admission?: CliAdmission;
  constructor(private readonly options: {
    rootPath: string; onChanged: () => void; onOutput?: (output: DshTerminalOutput) => void;
    resolveSelection: () => Promise<DshCliSelection>;
    toolchain?: () => Promise<{ pathDirectories: string[]; gitCaBundle?: string }>;
    verifyRuntime?: (id: string, digest: string) => Promise<void>;
  }) {
    this.root = path.resolve(options.rootPath); this.directory = path.join(this.root, 'cli');
    this.contextFile = path.join(this.directory, 'context.json'); this.bin = path.join(this.directory, 'bin');
    this.command = path.join(this.bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  }
  state(): DshCliTerminalState {
    const terminals = [...this.terminals.values()].map(({id,instanceId,runtimeVersion,status,cwd,pid,lastExitCode,output,outputOffset,outputRevision,cols,rows,transport}) =>
      ({id,instanceId,runtimeVersion,status,cwd,pid,lastExitCode,output,outputOffset,outputRevision,cols,rows,transport}));
    const terminal = terminals.find(item => item.id === this.activeTerminalId);
    return { selectedInstanceId: this.selected?.instanceId, commandPath: this.command, binPath: this.bin,
      pathEnabled: this.pathEnabled, terminals, activeTerminalId: this.activeTerminalId,
      output: terminal ? maskDshTerminalOutput(terminal.output) : this.contextOutput, ...(terminal ? {terminal} : {}) };
  }
  private changed(): void {
    if (this.notification) return;
    this.notification = setTimeout(() => { this.notification = undefined; this.options.onChanged(); }, 100);
    this.notification.unref();
  }
  private emit(stream: DshTerminalOutput['stream'], value: string, session?: TerminalSession, raw = false): void {
    const text = raw ? value : maskDshTerminalOutput(value); if (!text) return;
    if (session) {
      const combined = session.output + text; let removed = Math.max(0, combined.length - OUTPUT_LIMIT);
      if(removed>0&&/[\uDC00-\uDFFF]/u.test(combined[removed]??'')&&/[\uD800-\uDBFF]/u.test(combined[removed-1]??''))removed++;
      session.output = combined.slice(removed); session.outputOffset += removed;
    } else this.contextOutput = (this.contextOutput + text).slice(-OUTPUT_LIMIT);
    try { this.options.onOutput?.({ terminalId: session?.id ?? 'context', stream, text }); } catch { /* UI delivery cannot take ownership away from the manager. */ }
    this.changed();
  }
  async init(): Promise<void> {
    await this.ensureOwnedDirectory(this.bin);
    if (this.options.verifyRuntime) { this.admission = new CliAdmission(this.root, this.options.verifyRuntime); await this.admission.start(); }
    const shim = path.join(this.directory, 'shim.cjs');
    // This pinned dependency path belongs to the application, not the selected
    // runtime/context. Packaged Electron resolves its unpacked native addon.
    const koffiModule = require.resolve('koffi');
    const toolchain = await this.options.toolchain?.();
    if (toolchain) {
      if (toolchain.pathDirectories.length > 32) throw new Error('Invalid bundled tool PATH.');
      for (const directory of toolchain.pathDirectories) {
        const info = await lstat(directory);
        if (!path.isAbsolute(directory) || !info.isDirectory() || info.isSymbolicLink()) throw new Error('Bundled tools require ordinary absolute directories.');
      }
      if (toolchain.gitCaBundle) {
        const info = await lstat(toolchain.gitCaBundle);
        if (!path.isAbsolute(toolchain.gitCaBundle) || !info.isFile() || info.isSymbolicLink()) throw new Error('Bundled Git CA data is invalid.');
      }
    }
    await this.writeManaged(shim, SHIM_MARKER, externalShimSource(this.root, this.contextFile, koffiModule, toolchain));
    await this.writeManaged(path.join(this.directory,'cli-model-overlay.mjs'),CLI_MODEL_OVERLAY_MARKER,cliModelOverlaySource());
    await this.writeManaged(path.join(this.directory, 'pty-worker.cjs'), PTY_WORKER_MARKER,
      terminalPtyWorkerSource(require.resolve('node-pty')));
    if (process.platform === 'win32') {
      const escape = (text: string) => text.replaceAll('%', '%%');
      await this.writeManaged(this.command, CMD_MARKER, `${CMD_MARKER}\r\n@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${escape(process.execPath)}" "${escape(shim)}" %*\r\nexit /b %errorlevel%\r\n`);
      const userPath = await this.readPersistentPath('User'); const machinePath = await this.readPersistentPath('Machine');
      const resolved = await this.commandOnPath([...this.pathEntries(machinePath), ...this.pathEntries(userPath)]);
      this.pathEnabled = resolved !== undefined && samePath(resolved, this.command);
    } else {
      const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
      await this.writeManaged(this.command, '# WorldlineBox managed DSH command v1', `# WorldlineBox managed DSH command v1\n#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(shim)} "$@"\n`, 0o700);
    }
    try {
      const raw: unknown = JSON.parse(await readFile(this.contextFile, 'utf8'));
      if (raw && typeof raw === 'object' && (raw as PersistedCliContext).format === CONTEXT_FORMAT
        && /^[a-z0-9-]{1,80}$/.test((raw as PersistedCliContext).instanceId)
        && typeof (raw as PersistedCliContext).workspacePath === 'string'
        && within(path.join(this.root, 'shared'), (raw as PersistedCliContext).workspacePath)) this.selected = raw as PersistedCliContext;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.emit('system', 'The previous CLI selection was invalid; select an instance again.\n'); }
  }
  private async ensureOwnedDirectory(directory: string): Promise<void> {
    if (!within(this.root, directory)) throw new Error('CLI path escapes the launcher root.');
    let current = this.root;
    for (const segment of ['', ...path.relative(this.root, directory).split(path.sep).filter(Boolean)]) {
      if (segment) current = path.join(current, segment);
      const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (stats && (stats.isSymbolicLink() || !stats.isDirectory())) throw new Error('CLI directory is not an owned ordinary directory.');
      if (!stats) await mkdir(current, { recursive: segment === '' });
    }
  }
  private async writeManaged(file: string, marker: string, source: string, mode = 0o600): Promise<void> {
    const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.size > 1024 * 1024)) throw new Error('CLI refuses to replace an unmanaged command file.');
    if (existing && !(await readFile(file, 'utf8')).startsWith(marker)) throw new Error('An existing dsh command is not managed by WorldlineBox.');
    await writeFile(file, source, { mode });
  }
  async selectContext(context?: DshCliSelection): Promise<DshCliTerminalState> {
    const selection = context ?? await this.options.resolveSelection();
    const next = await this.persistedContext(selection);
    await this.ensureOwnedDirectory(this.directory); await atomicJson(this.contextFile, next); this.selected = next;
    this.options.onChanged(); return this.state();
  }
  async pinContext(selection:DshCliSelection):Promise<{contextFile:string;dispose:()=>Promise<void>}>{
    const context=await this.persistedContext(selection);const directory=path.join(this.directory,'sessions',randomUUID());
    await this.ensureOwnedDirectory(directory);const contextFile=path.join(directory,'context.json');await atomicJson(contextFile,context);
    let disposed=false;return{contextFile,dispose:async()=>{if(disposed)return;const info=await lstat(contextFile).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;});if(info&&(!info.isFile()||info.isSymbolicLink()))throw new Error('Pinned CLI context is not an owned ordinary file.');await rm(contextFile,{force:true});await rmdir(directory);disposed=true;}};
  }
  private async persistedContext(selection: DshCliSelection): Promise<PersistedCliContext> {
    const instance = selection.instance;
    if (!/^[a-z0-9-]{1,80}$/.test(instance.id) || !/^[a-z0-9-]{1,80}$/.test(instance.runtimeId)) throw new Error('Invalid CLI instance/runtime identity.');
    const instanceRoot = path.join(this.root, 'instances', instance.id);
    const program = path.join(this.root, 'runtimes', instance.runtimeId, 'program');
    const records: unknown = JSON.parse(await readFile(path.join(this.root, 'runtimes.json'), 'utf8'));
    const runtime = Array.isArray(records) ? records.find((record: DshRuntime) => record.id === instance.runtimeId) as DshRuntime | undefined : undefined;
    if (!runtime || !/^[a-f0-9]{64}$/.test(runtime.contentSha256)) throw new Error('Selected CLI runtime is not registered.');
    if(selection.runtimeVersion!==undefined&&selection.runtimeVersion!==runtime.version)throw new Error('Selected CLI runtime version does not match its registered identity.');
    if(!supportsSharedDataRuntime({...runtime,compatibility:await readRuntimeCompatibility(this.root,runtime)}))throw new Error('共享存档兼容性检测尚未通过，请先在运行版本页执行检测。');
    const executable = runtime.adapter === 'node-cli-web-v1' ? path.join(program, 'bin', 'node.exe')
      : runtime.adapter === 'desktop-cli-web-v1' ? path.join(program, 'DeepSeek Harness.exe') : undefined;
    if (!samePath(instance.homePath, path.join(instanceRoot, 'home')) || !samePath(instance.agentsPath, path.join(instanceRoot, 'agents'))
      || !executable || !samePath(selection.plan.executable, executable)
      || !within(program, selection.nativeCli ?? selection.plan.cli) || !within(instanceRoot, selection.routingPatch)
      || !within(path.join(this.root, 'shared'), selection.workspacePath)) throw new Error('CLI selection contains an unmanaged path.');
    const env = Object.fromEntries(Object.entries(selection.env).filter((entry): entry is [string, string] => ENV_KEYS.has(entry[0]) && typeof entry[1] === 'string'));
    env.DSH_HOME = instance.homePath; env.DSH_AGENTS_HOME = instance.agentsPath; env.DSH_DESKTOP_NODE_EXECUTABLE = selection.plan.executable;
    const next: PersistedCliContext = { format: CONTEXT_FORMAT, instanceId: instance.id, runtimeId: instance.runtimeId,
      runtimeVersion: selection.runtimeVersion ?? runtime.version, runtimeContentSha256: runtime.contentSha256,
      executable: selection.plan.executable, nativeCli: selection.nativeCli ?? selection.plan.cli,
      nativeArgs: selection.nativeArgs ?? ['web', '--patch', selection.routingPatch], routingPatch: selection.routingPatch,
      workspacePath: selection.workspacePath, env };
    if (next.nativeArgs.length > 128 || next.nativeArgs.some(argument => typeof argument !== 'string' || argument.length > 16_384 || argument.includes('\0'))) throw new Error('Invalid native CLI routing arguments.');
    return next;
  }
  private async readPersistentPath(scope: 'User' | 'Machine'): Promise<string> {
    const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write([Environment]::GetEnvironmentVariable('Path','${scope}'))`;
    return (await execute(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10_000 })).stdout;
  }
  private pathEntries(value: string): string[] {
    return value.split(';').map(entry => entry.trim().replace(/^"|"$/g, '').replace(/%([^%]+)%/g, (all, name: string) =>
      Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? all)).filter(Boolean);
  }
  private async commandOnPath(entries: string[]): Promise<string | undefined> {
    for (const entry of entries) for (const suffix of ['.exe', '.cmd', '.bat', '.ps1']) {
      const file = path.join(entry, `dsh${suffix}`); if (await lstat(file).catch(() => undefined)) return file;
    }
    return undefined;
  }
  async installCommand(): Promise<DshCliTerminalState> {
    if (process.platform !== 'win32') throw new Error('Managed user PATH installation currently requires Windows.');
    const machineEntries = this.pathEntries(await this.readPersistentPath('Machine'));
    const machineCommand = await this.commandOnPath(machineEntries);
    if (machineCommand && !samePath(machineCommand, this.command)) throw new Error('An existing dsh command on machine PATH takes precedence. Machine PATH and existing files were preserved; use the scoped launcher terminal or the managed command path.');
    const userEntries = this.pathEntries(await this.readPersistentPath('User'));
    for (const directory of this.pathEntries(process.env.PATH ?? '')) {
      if (samePath(directory, this.bin) || machineEntries.some(entry => samePath(entry, directory)) || userEntries.some(entry => samePath(entry, directory))) continue;
      if (await this.commandOnPath([directory])) throw new Error('An existing dsh command in the current custom PATH may take precedence; use the scoped launcher terminal. No existing command was replaced.');
    }
    const script = `$entry=${quotedPowerShell(this.bin)}; $existing=[Environment]::GetEnvironmentVariable('Path','User'); $entries=@($existing -split ';' | Where-Object { $_ -and $_ -ine $entry }); [Environment]::SetEnvironmentVariable('Path',((@($entry) + $entries) -join ';'),'User')`;
    await execute(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10_000 });
    try {
      // Notify Explorer/new shells without replacing the environment of any
      // existing user shell. Only the explicit install action broadcasts.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const koffi = require('koffi') as typeof Koffi;
      const broadcast = koffi.load('user32.dll').func('uintptr_t __stdcall SendMessageTimeoutW(uintptr_t hwnd, uint32_t message, uintptr_t wparam, str16 lparam, uint32_t flags, uint32_t timeout, uint8_t *result)');
      broadcast(0xffff, 0x001a, 0, 'Environment', 2, 1000, Buffer.alloc(8));
    } catch { /* The registry commit remains valid when a desktop listener is unavailable. */ }
    this.pathEnabled = true; this.options.onChanged(); return this.state();
  }
  async open(context?: DshCliSelection): Promise<DshCliTerminalState> {
    if([...this.terminals.values()].filter(session=>session.status==='running').length+this.opening.size>=8)throw new Error('Stop a terminal before opening more than eight terminals.');
    const id=randomUUID();this.opening.add(id);
    try{return await this.openSession(context,id);}finally{this.opening.delete(id);}
  }
  private async openSession(context:DshCliSelection|undefined,id:string):Promise<DshCliTerminalState> {
    if (process.platform !== 'win32') throw new Error('The managed ConPTY terminal currently requires Windows.');
    if ([...this.terminals.values()].filter(session=>session.status==='running').length >= 8) throw new Error('Stop a terminal before opening more than eight terminals.');
    if(this.terminals.size>=8){const stopped=[...this.terminals.values()].find(session=>session.status==='stopped');if(stopped)this.remove(stopped.id);}
    const selection = context ?? await this.options.resolveSelection();
    const pinned = await this.persistedContext(selection);
    if (!this.selected) await this.selectContext(selection);
    const sessionDirectory = path.join(this.directory, 'sessions', id);
    await this.ensureOwnedDirectory(sessionDirectory);
    const contextFile = path.join(sessionDirectory, 'context.json'); await atomicJson(contextFile, pinned);
    const env = managedTerminalEnvironment(selection.env, this.bin);
    env.WORLDLINEBOX_DSH_CLI_CONTEXT = contextFile;
    const session: TerminalSession = {id,instanceId:selection.instance.id,runtimeVersion:pinned.runtimeVersion,
      status:'running',cwd:selection.workspacePath,output:'',outputOffset:0,outputRevision:0,cols:80,rows:24,transport:'conpty'};
    this.opening.delete(id);this.terminals.set(id, session); this.activeTerminalId = id;
    // The worker cannot create a shell until main attaches the Job and sends start.
    const child = spawn(process.execPath, [path.join(this.directory, 'pty-worker.cjs')], {
      cwd:selection.workspacePath,env:{...env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,shell:false,stdio:['pipe','pipe','pipe','ipc'],
    }) as ChildProcessWithoutNullStreams;
    session.worker = child; child.stdin.end(); child.once('error',()=>undefined);
    try { session.job = attachProcessJob(child,{closeOnExit:false}); }
    catch(error){await terminateOwnedProcess(child);this.terminals.delete(id);throw error;}
    let readyResolve!:()=>void;let readyReject!:(error:Error)=>void;
    const ready = new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    let receivedExitCode:number|undefined;
    child.on('message', (message: unknown) => {
      if(!message||typeof message!=='object')return;const event=message as Record<string,unknown>;
      if(event.type==='data'&&event.revision===session.outputRevision&&typeof event.data==='string'&&event.data.length<=OUTPUT_LIMIT)this.emit('stdout',event.data,session,true);
      else if(event.type==='ready'&&typeof event.pid==='number'&&Number.isSafeInteger(event.pid)&&event.pid>0){session.pid=event.pid;readyResolve();this.options.onChanged();}
      else if(event.type==='exit'&&typeof event.exitCode==='number')receivedExitCode=event.exitCode;
      else if(event.type==='error'){this.emit('stderr','ConPTY failed. Close this terminal and open a new tab.\r\n',session);readyReject(new Error('ConPTY could not start.'));}
    });
    for(const stream of ['stdout','stderr'] as const)child[stream].on('data',()=>undefined);
    child.once('error',()=>readyReject(new Error('The owned ConPTY worker could not start.')));
    session.finished = new Promise<void>((resolve,reject)=>child.once('exit', (code)=>{
      readyReject(new Error('The owned ConPTY worker exited before readiness.'));
      void (async()=>{
        session.job?.terminate();await session.job?.waitForEmpty();session.job?.close();
        session.worker=undefined;session.job=undefined;session.status='stopped';session.lastExitCode=receivedExitCode??code;delete session.pid;
        this.emit('system',`\r\n[Terminal stopped: ${session.lastExitCode??'signal'}]\r\n`,session);this.options.onChanged();resolve();
      })().catch(reject);
    }));
    // Keep teardown failures observable without an unhandled rejection during a natural exit.
    session.finished.catch(()=>this.emit('stderr','Owned terminal cleanup is incomplete; instance data remains locked.\r\n',session));
    const utf8Bootstrap='[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding';
    child.send({type:'start',file:powershellPath(),args:['-NoLogo','-NoProfile','-NoExit','-Command',utf8Bootstrap],env,cwd:session.cwd,cols:session.cols,rows:session.rows});
    let timeout:NodeJS.Timeout|undefined;
    try{await Promise.race([ready,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('ConPTY startup timed out.')),15_000);})]);}
    catch(error){await this.close(id);throw error;}
    finally{if(timeout)clearTimeout(timeout);}
    this.options.onChanged();return this.state();
  }
  private session(terminalId?:string):TerminalSession {
    const selected=terminalId??this.activeTerminalId;const session=selected?this.terminals.get(selected):undefined;
    if(!session)throw new Error('This terminal tab does not exist.');return session;
  }
  write(text: string, terminalId?:string): void {
    const session=this.session(terminalId);
    if(session.status!=='running'||!session.worker?.connected)throw new Error('The managed terminal is not running.');
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > OUTPUT_LIMIT) throw new Error('Terminal input must be text up to 64 KiB.');
    const bytes=Buffer.byteLength(text,'utf8');if((session.pendingInputBytes??0)+bytes>256*1024)throw new Error('The terminal input channel is busy.');
    session.pendingInputBytes=(session.pendingInputBytes??0)+bytes;
    session.worker.send({type:'input',text},()=>{session.pendingInputBytes=Math.max(0,(session.pendingInputBytes??0)-bytes);});
  }
  resize(terminalId:string,cols:number,rows:number):void {
    if(!Number.isInteger(cols)||!Number.isInteger(rows)||cols<2||cols>600||rows<2||rows>300)throw new Error('Invalid terminal dimensions.');
    const session=this.session(terminalId);session.cols=cols;session.rows=rows;
    if(session.worker?.connected)session.worker.send({type:'resize',cols,rows});this.changed();
  }
  select(terminalId:string):DshCliTerminalState{this.session(terminalId);this.activeTerminalId=terminalId;this.options.onChanged();return this.state();}
  clear(terminalId?:string):void {
    if(!terminalId&&!this.activeTerminalId){this.contextOutput='';this.options.onChanged();return;}
    const session=this.session(terminalId);session.output='';session.outputOffset=0;session.outputRevision++;
    if(session.worker?.connected)session.worker.send({type:'clear',revision:session.outputRevision});this.options.onChanged();
  }
  export(terminalId?:string):string {const session=this.session(terminalId);return maskDshTerminalOutput(session.output);}
  remove(terminalId:string):void {const session=this.session(terminalId);if(session.status==='running')throw new Error('Stop this terminal before removing its tab.');this.terminals.delete(terminalId);if(this.activeTerminalId===terminalId)this.activeTerminalId=[...this.terminals.keys()].at(-1);this.options.onChanged();}
  async invalidate(instanceId: string): Promise<void> {
    if (this.selected?.instanceId !== instanceId) return;
    const stats = await lstat(this.contextFile).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (stats && (stats.isSymbolicLink() || !stats.isFile())) throw new Error('CLI selection is not an owned ordinary context file.');
    await rm(this.contextFile, { force: true }); this.selected = undefined; this.options.onChanged();
  }
  async close(terminalId?:string):Promise<void> {
    const targets=terminalId?[this.session(terminalId)]:[...this.terminals.values()].filter(session=>session.status==='running');
    await Promise.all(targets.map(session=>{
      session.closing??=this.closeOwned(session).finally(()=>{session.closing=undefined;});return session.closing;
    }));
  }
  async shutdown(): Promise<void> { await this.close(); await this.admission?.close(); }
  private async closeOwned(session:TerminalSession):Promise<void> {
    const child=session.worker;if(!child)return;
    if(child.connected)try{child.send({type:'close'},()=>undefined);}catch{/* A racing worker exit is verified through the Job below. */}
    const timeout=setTimeout(()=>{try{session.job?.terminate();if(!session.job)child.kill();}catch{/* Final Job accounting decides completion. */}},2000);
    try{await session.finished;}
    finally{clearTimeout(timeout);}
  }
}

/** Standalone Node shim: no account data or executable location comes from PATH. */
export function externalShimSource(rootPath: string, contextFile: string, koffiModule: string,
  toolchain?: {pathDirectories: string[];gitCaBundle?: string}): string {
  return `${SHIM_MARKER}\n` + String.raw`
'use strict';
let fs;try{fs=require('original-fs')}catch{fs=require('node:fs')}
const path=require('node:path'),crypto=require('node:crypto'),{spawn,execFileSync}=require('node:child_process'),readline=require('node:readline');
const ROOT=${JSON.stringify(rootPath)},CONTEXT=${JSON.stringify(contextFile)},KOFFI=${JSON.stringify(koffiModule)};
const POWERSHELL=${JSON.stringify(powershellPath())};
const TOOLCHAIN=${JSON.stringify(toolchain ?? {pathDirectories:[]})};
function sharedCompatible(record){const file=path.join(ROOT,'compatibility',record.id+'.json');if(!fs.existsSync(file))return false;const r=json(file);return r.contract===${JSON.stringify(compatibilityContract())}&&r.runtimeId===record.id&&r.contentSha256===record.contentSha256&&r.status==='passed'&&${JSON.stringify(['integrity','native-api','session-roundtrip','writer-lock','workspace','attachments','credentials','model-settings','native-cli','cross-runtime','cleanup'])}.every(id=>r.checks?.some(c=>c.id===id&&c.status==='passed'));}
const ENV_KEYS=new Set(${JSON.stringify([...ENV_KEYS])});
const inside=(root,file)=>{const r=path.relative(path.resolve(root),path.resolve(file));return r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r)};
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const json=file=>{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>32*1024*1024)throw Error('Invalid CLI metadata');return JSON.parse(fs.readFileSync(file,'utf8'))};
const ordinary=file=>{const s=fs.lstatSync(file);if(s.isSymbolicLink())throw Error('CLI refuses linked metadata/code');return s};
const hash=file=>{const h=crypto.createHash('sha256'),f=fs.openSync(file,'r'),b=Buffer.alloc(256*1024);try{for(;;){const n=fs.readSync(f,b,0,b.length,null);if(!n)break;h.update(b.subarray(0,n))}return h.digest('hex')}finally{fs.closeSync(f)}};
async function admission(c){
 const file=path.join(ROOT,'cli','admission.json');if(!fs.existsSync(file))return false;
 const endpoint=json(file);if(!Number.isInteger(endpoint.port)||endpoint.port<1||endpoint.port>65535||!/^[a-f0-9]{64}$/.test(endpoint.token))throw Error('Invalid launcher admission endpoint');
 return new Promise((resolve,reject)=>{let connected=false,reply='';const socket=require('node:net').connect({host:'127.0.0.1',port:endpoint.port});socket.setTimeout(360000,()=>socket.destroy(Error('CLI integrity verification timed out')));socket.once('connect',()=>{connected=true;socket.write(JSON.stringify({token:endpoint.token,runtimeId:c.runtimeId,digest:c.runtimeContentSha256})+'\n')});socket.on('data',bytes=>{reply+=String(bytes);if(reply.length>4096)socket.destroy(Error('Invalid CLI admission response'))});socket.once('end',()=>{try{if(JSON.parse(reply).ok!==true)throw Error('The selected runtime failed launcher integrity verification');resolve(true)}catch(error){reject(error)}});socket.once('error',error=>{if(!connected&&['ECONNREFUSED','ENOENT'].includes(error.code))resolve(false);else reject(error)})});
}
async function context(){
 let selectedContext=CONTEXT;const override=process.env.WORLDLINEBOX_DSH_CLI_CONTEXT;
 if(override){const sessions=path.join(ROOT,'cli','sessions'),relative=path.relative(sessions,path.resolve(override)),parts=relative.split(path.sep);if(!inside(sessions,override)||parts.length!==2||!/^[a-f0-9-]{36}$/.test(parts[0])||parts[1]!=='context.json')throw Error('Invalid pinned terminal context');let current=ROOT;for(const part of path.relative(ROOT,path.resolve(override)).split(path.sep)){current=path.join(current,part);ordinary(current)}selectedContext=path.resolve(override)}
 const c=json(selectedContext);if(c.format!=='worldlinebox-dsh-cli-context-v1'||!/^[a-z0-9-]{1,80}$/.test(c.instanceId)||!/^[a-z0-9-]{1,80}$/.test(c.runtimeId))throw Error('Select a valid CLI instance in WorldlineBox first');
 const instance=path.join(ROOT,'instances',c.instanceId),artifact=path.join(ROOT,'runtimes',c.runtimeId),program=path.join(artifact,'program');
 ordinary(instance);ordinary(artifact);ordinary(program);
 const registry=json(path.join(ROOT,'runtimes.json')),record=registry.find(r=>r.id===c.runtimeId),seal=json(path.join(artifact,'seal.json'));
 const executable=record?.adapter==='node-cli-web-v1'?path.join(program,'bin','node.exe'):record?.adapter==='desktop-cli-web-v1'?path.join(program,'DeepSeek Harness.exe'):undefined;
 if(!executable||!same(c.executable,executable)||!inside(program,c.nativeCli)||!inside(instance,c.routingPatch)||!inside(path.join(ROOT,'shared'),c.workspacePath)||!same(c.env.DSH_HOME,path.join(instance,'home'))||!same(c.env.DSH_AGENTS_HOME,path.join(instance,'agents')))throw Error('CLI context paths are not managed');
 ordinary(c.routingPatch);if(!ordinary(c.workspacePath).isDirectory())throw Error('Shared workspace is missing');
 if(!record||record.version!==c.runtimeVersion||record.contentSha256!==c.runtimeContentSha256||seal.contentSha256!==c.runtimeContentSha256||c.runtimeId!=='runtime-'+c.runtimeContentSha256.slice(0,24)||!Array.isArray(seal.files)||seal.files.length>150000)throw Error('CLI runtime seal does not match its selected version');
 if(!sharedCompatible(record))throw Error('This DSH version has no verified shared-data adapter');
 if(crypto.createHash('sha256').update(JSON.stringify(seal.files)).digest('hex')!==seal.contentSha256)throw Error('CLI runtime inventory identity changed');
 if(!await admission(c)){
 const expected=new Set();let bytes=0;
 for(const entry of seal.files){if(typeof entry.path!=='string'||entry.path.split(/[\/]/).some(x=>!x||x==='.'||x==='..'||/[:<>"|?*]/.test(x))||!Number.isSafeInteger(entry.size)||entry.size<0||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Invalid sealed runtime entry');const file=path.join(program,entry.path);if(!inside(program,file))throw Error('Runtime path escapes its version');const stats=ordinary(file);if(!stats.isFile()||stats.size!==entry.size||hash(file)!==entry.sha256)throw Error('Selected DSH runtime changed; import a clean version before running CLI');expected.add(path.relative(program,file).toLowerCase());bytes+=entry.size;if(bytes>6*1024**3)throw Error('CLI runtime inventory is too large')}
 const walk=directory=>{for(const name of fs.readdirSync(directory)){const file=path.join(directory,name),stats=ordinary(file);if(stats.isDirectory())walk(file);else if(!stats.isFile()||!expected.has(path.relative(program,file).toLowerCase()))throw Error('Selected DSH runtime contains unsealed files')}};walk(program);
 }
 if(!Array.isArray(c.nativeArgs)||c.nativeArgs.length>128||c.nativeArgs.some(a=>typeof a!=='string'||a.length>16384||a.includes('\0')))throw Error('Invalid CLI routing arguments');
 if(!c.env||Object.keys(c.env).some(key=>!ENV_KEYS.has(key)||typeof c.env[key]!=='string'))throw Error('CLI context contains unsupported environment overrides');
 for(const [key,value]of Object.entries(c.env)){if(['NO_COLOR','FORCE_COLOR','HOMEDRIVE','HOMEPATH'].includes(key))continue;if(!inside(instance,value)&&!inside(program,value))throw Error('CLI environment escapes the selected private instance/runtime')}
 for(let index=0;index<c.nativeArgs.length;index++)if(c.nativeArgs[index]==='--patch'){const file=c.nativeArgs[++index];if(typeof file!=='string'||(!inside(instance,file)&&!inside(program,file)))throw Error('CLI patch escapes the selected environment');if(inside(instance,file))ordinary(file)}
 c.runtimeAdapter=record.adapter;return c;
}
function guardPluginMutation(c,input){if(input[0]!=='plugin')return;const action=input.find(value=>['add','remove','install','update','link','unlink','import','deploy','prune','rebuild'].includes(value));if(!action)return;const journal=path.join(ROOT,'instances',c.instanceId,'process.json');if(fs.existsSync(journal))throw Error('Stop this instance Host before changing its private plugins');const instances=json(path.join(ROOT,'instances.json'));if(Array.isArray(instances)&&instances.some(instance=>instance.id===c.instanceId&&['starting','running','stopping'].includes(instance.status)))throw Error('Stop this instance Host before changing its private plugins')}
function endpoint(value,protocols){let url;try{url=new URL(value)}catch{throw Error('Invalid launcher network settings')}if(!protocols.includes(url.protocol)||!url.hostname||url.username||url.password||url.hash||url.search)throw Error('Invalid launcher network settings');return url.href.replace(/\/$/,'')}
function network(){const file=path.join(ROOT,'network.json');const value=fs.existsSync(file)?json(file):{proxyMode:'system',npmRegistry:'https://registry.npmjs.org',pythonIndex:'https://pypi.org/simple'};if(!['system','direct','custom'].includes(value.proxyMode))throw Error('Invalid launcher network mode');const registry=endpoint(value.npmRegistry,['https:']),pythonIndex=endpoint(value.pythonIndex,['https:']);let proxy='';if(value.proxyMode==='custom')proxy=endpoint(value.proxyUrl,['http:','https:','socks5:']);else if(value.proxyMode==='system'&&process.platform==='win32'){const address=registry.replaceAll("'","''"),script="$ErrorActionPreference='Stop'; $uri=[Uri]'"+address+"'; $proxy=[Net.WebRequest]::GetSystemWebProxy().GetProxy($uri); [Console]::Write($proxy.AbsoluteUri)";try{const resolved=execFileSync(POWERSHELL,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:10000}).trim();if(resolved&&new URL(resolved).href!==new URL(registry).href)proxy=endpoint(resolved,['http:','https:','socks5:'])}catch{throw Error('The current system proxy could not be resolved')}}return{registry,pythonIndex,proxy}}
function managedRelay(){const value=process.env.WORLDLINEBOX_CHILD_NETWORK_RELAY;if(!value)return;const url=new URL(value);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username!=='worldlinebox'||!/^[a-f0-9]{64}$/.test(url.password)||!url.port||url.pathname!=='/'||url.search||url.hash)throw Error('Invalid managed process network relay');return value}
function environment(c){const env={...process.env};let inheritedPath='';for(const key of Object.keys(env)){if(key.toUpperCase()==='PATH'){inheritedPath=env[key]??'';delete env[key]}else if(/^(DSH_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_|DEEPSEEK_|OPENAI_|ANTHROPIC_|GEMINI_|GOOGLE_API_KEY$|AZURE_OPENAI_|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$|NPM_TOKEN$|NPM_CONFIG_|PNPM_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|PIP_INDEX_URL$|PYTHONHOME$|PYTHONPATH$|PYTHONUSERBASE$|PYTHONNOUSERSITE$|PIP_USER$|PSModulePath$|GIT_EXEC_PATH$|GIT_SSL_CAINFO$)/i.test(key))delete env[key]}Object.assign(env,c.env);env.PATH=[path.dirname(c.executable),...TOOLCHAIN.pathDirectories,inheritedPath].filter(Boolean).join(path.delimiter);env.PYTHONUSERBASE=path.join(ROOT,'instances',c.instanceId,'user','python-userbase');env.PIP_USER='1';env.PSModulePath=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules');if(TOOLCHAIN.gitCaBundle)env.GIT_SSL_CAINFO=TOOLCHAIN.gitCaBundle;if(c.runtimeAdapter==='desktop-cli-web-v1')env.ELECTRON_RUN_AS_NODE='1';const current=network();const relay=managedRelay();if(relay)current.proxy=relay;c.registry=current.registry;if(current.proxy)Object.assign(env,{HTTP_PROXY:current.proxy,HTTPS_PROXY:current.proxy,ALL_PROXY:current.proxy,npm_config_proxy:current.proxy,npm_config_https_proxy:current.proxy});Object.assign(env,{NO_PROXY:'localhost,127.0.0.1,::1',npm_config_registry:current.registry,PIP_INDEX_URL:current.pythonIndex,NODE_USE_ENV_PROXY:'1'});return env}
function job(child){
 if(process.platform!=='win32')return{close(){},terminate(){child.kill('SIGTERM')},async finish(){this.terminate()}};
 const koffi=require(KOFFI),k=koffi.load('kernel32.dll');
 const create=k.func('uintptr_t CreateJobObjectW(uintptr_t,uintptr_t)'),set=k.func('int SetInformationJobObject(uintptr_t,int,uint8_t*,uint32_t)'),open=k.func('uintptr_t OpenProcess(uint32_t,int,uint32_t)'),assign=k.func('int AssignProcessToJobObject(uintptr_t,uintptr_t)'),close=k.func('int CloseHandle(uintptr_t)'),terminate=k.func('int TerminateJobObject(uintptr_t,uint32_t)'),query=k.func('int QueryInformationJobObject(uintptr_t,int,uint8_t*,uint32_t,uintptr_t)');
 const h=create(0,0),limits=Buffer.alloc(144);limits.writeUInt32LE(0x2000,16);let closed=false,p=0;
 try{if(!h||!set(h,9,limits,144))throw Error('Could not supervise the DSH CLI job');p=open(0x101,0,child.pid);if(!p||!assign(h,p))throw Error('Could not assign the DSH CLI job')}catch(e){if(h)close(h);child.kill();throw e}finally{if(p)close(p)}
 const result={close(){if(!closed){close(h);closed=true}},terminate(){if(!closed)terminate(h,1)},async finish(){if(closed)return;this.terminate();const accounting=Buffer.alloc(48);for(let attempt=0;attempt<500;attempt++){if(!query(h,1,accounting,48,0))throw Error('Cannot verify the CLI process tree has stopped');if(accounting.readUInt32LE(40)===0){this.close();return}await new Promise(resolve=>setTimeout(resolve,20))}throw Error('CLI descendants still own instance data')}};
 child.once('exit',()=>result.terminate());return result;
}
function args(c,input,modelPatch){if(input[0]==='plugin'){const rest=input.slice(1),operation=rest.find(value=>['add','remove','install','update','link','unlink','import','deploy','prune','rebuild'].includes(value));return ['plugin',...(rest.includes('--profile')?[]:['--profile','web']),...rest,...(operation&&!rest.some(value=>value==='--registry'||value.startsWith('--registry='))?['--registry',c.registry]:[])]}if(input[0]==='--version'||input[0]==='-V')return input;const models=modelPatch?['--patch',modelPatch]:[];if(input[0]==='web'||input[0]==='--profile')return [...input.slice(0,input[0]==='web'?1:2),'--patch',c.routingPatch,...models,...input.slice(input[0]==='web'?1:2)];if(input[0]==='headless')input=input.slice(1);return [...c.nativeArgs,...models,...input]}
function createdAt(pid){const code="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=Get-CimInstance Win32_Process -Filter 'ProcessId = "+pid+"'; if (!$p) { throw 'CLI owner process was not found' }; [Console]::Write($p.CreationDate.ToUniversalTime().ToString('o'))";return execFileSync(POWERSHELL,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:10000}).trim()}
function registration(c){const barrier=path.join(ROOT,'shared','.cli-exclusive.lock'),directory=path.join(ROOT,'shared','.cli-users'),file=path.join(directory,process.pid+'.json');if(fs.existsSync(barrier))throw Error('Shared saves are being backed up or migrated; retry after the operation finishes');fs.mkdirSync(directory,{recursive:true});ordinary(directory);const stamp=createdAt(process.pid);if(fs.existsSync(file)){const old=json(file);if(old.pid!==process.pid||old.createdAt!==stamp)fs.unlinkSync(file);else throw Error('This CLI process already owns a running task')}const temporary=file+'.'+crypto.randomUUID()+'.tmp';const record={format:'worldlinebox-dsh-cli-use-v1',instanceId:c.instanceId,pid:process.pid,executable:process.execPath,createdAt:stamp};const publish=()=>{fs.writeFileSync(temporary,JSON.stringify(record),{flag:'wx',mode:0o600});fs.renameSync(temporary,file)};publish();if(fs.existsSync(barrier)){fs.unlinkSync(file);throw Error('Shared saves are being backed up or migrated; retry after the operation finishes')}return{child(child){record.childPid=child.pid;record.childExecutable=c.executable;record.childCreatedAt=createdAt(child.pid);publish()},close(){if(fs.existsSync(file))fs.unlinkSync(file)}}}
function modelPlan(c,input){
 const canonical=path.join(ROOT,'shared','model-settings.json');
 if(!sharedCompatible({id:c.runtimeId,contentSha256:c.runtimeContentSha256})||!fs.existsSync(canonical)||['plugin','--version','-V'].includes(input[0]))return;
 const file=ordinary(canonical);if(!file.isFile()||file.size>8*1024*1024)throw Error('Shared CLI model settings are not readable');
 const explicit=input[0]==='web'||input[0]==='--profile',profile=explicit?(input[0]==='web'?'web':input[1]):'web';
 if(typeof profile!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(profile))throw Error('Invalid CLI profile name');
 const patches=explicit?[c.routingPatch]:c.nativeArgs.flatMap((value,index,all)=>value==='--patch'?[all[index+1]]:[]);
 const helper=path.join(ROOT,'cli','cli-model-overlay.mjs');if(!ordinary(helper).isFile())throw Error('Native CLI model composer is missing');
 const instance=path.join(ROOT,'instances',c.instanceId),directory=path.join(instance,'launcher','cli-model-overlays');fs.mkdirSync(directory,{recursive:true});let current=instance;for(const part of path.relative(instance,directory).split(path.sep)){current=path.join(current,part);if(!ordinary(current).isDirectory())throw Error('CLI model overlay directory is not managed')}
 const output=path.join(directory,crypto.randomUUID()+'.json');return{helper,output,arguments:[path.join(ROOT,'runtimes',c.runtimeId,'program'),profile,canonical,c.instanceId,JSON.stringify(patches),output]};
}
async function prepareModels(c,input,env,use){
 const plan=modelPlan(c,input);if(!plan)return;
 const child=spawn(c.executable,['--expose-internals',plan.helper,...plan.arguments],{cwd:c.workspacePath,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
 child.stdout.resume();child.stderr.resume();let owned;
 const result=new Promise((resolve,reject)=>{child.once('error',()=>reject(Error('Native CLI model settings could not be composed')));child.once('close',resolve)});
 try{owned=job(child);use.active=true;try{use.child(child)}catch{/* The wrapper identity still owns a fast helper. */}}catch(error){await result.catch(()=>undefined);throw error}
 const interrupt=()=>owned.terminate(),timer=setTimeout(interrupt,30000);process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
 try{const code=await result;await owned.finish();use.active=false;if(code!==0)throw Error('Native CLI model settings could not be composed');return plan.output}
 catch(error){if(fs.existsSync(plan.output))fs.unlinkSync(plan.output);throw error}
 finally{clearTimeout(timer);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt)}
}
async function invoke(c,input,task){
 if(input[0]==='web'&&!input.some(value=>['--help','--dump-config'].includes(value)))throw Error('WebUI is managed by WorldlineBox. Start or switch the single workbench in the launcher; use dsh for CLI tasks.');
 if(input[0]==='--profile'&&!input.some(value=>['--help','--dump-config'].includes(value)))throw Error('Use the selected instance profile through dsh or dsh headless. WebUI profiles are managed by the launcher.');
 guardPluginMutation(c,input);const use=registration(c);let modelPatch,admitted=false;
 try{
  const env=environment(c);modelPatch=await prepareModels(c,input,env,use);
  const child=spawn(c.executable,['--expose-internals',c.nativeCli,...args(c,input,modelPatch)],{cwd:c.workspacePath,env,windowsHide:true,shell:false,stdio:task===undefined?'inherit':['pipe','pipe','pipe']});
  const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});let owned;
  try{owned=job(child);admitted=true;try{use.child(child)}catch{/* Fast help/version processes can exit before the identity query. */}}catch(error){await completion.catch(()=>undefined);throw error}
  let sessionId,buffer='';if(task!==undefined){child.stdin.end(task);child.stderr.pipe(process.stderr);const decoder=new(require('node:string_decoder').StringDecoder)('utf8');child.stdout.on('data',chunk=>{buffer+=decoder.write(chunk);if(buffer.length>1024*1024){process.stdout.write(buffer);buffer='';return}let at=buffer.indexOf('\n');while(at>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const event=JSON.parse(line);if(event.type==='session'&&typeof event.sessionId==='string'){sessionId=event.sessionId;process.stdout.write('[Session '+sessionId+']\n')}else if(event.type==='final'&&typeof event.text==='string')process.stdout.write(event.text+'\n');else process.stdout.write(line+'\n')}catch{process.stdout.write(line+'\n')}at=buffer.indexOf('\n')}})}
  const interrupt=()=>owned.terminate();process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  try{const code=await completion;await owned.finish();admitted=false;if(buffer)process.stdout.write(buffer);return{code:code??1,sessionId}}
  finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt)}
 }finally{if(!admitted&&!use.active)use.close();if(modelPatch&&fs.existsSync(modelPatch))fs.unlinkSync(modelPatch)}
}
async function main(){
 const input=process.argv.slice(2);if(input.length){const result=await invoke(await context(),input);process.exitCode=result.code;return}
 const lines=readline.createInterface({input:process.stdin,output:process.stdout,terminal:process.stdin.isTTY&&process.stdout.isTTY});let sessionId;
 const prompt=()=>{if(!lines.closed)process.stdout.write('DSH> '+(process.stdout.isTTY?'':'\n'))};
 process.stdout.write('WorldlineBox DSH CLI — private instance plugins, shared session history.\nEnter a task; /new starts a new session; /exit closes the CLI.\n');prompt();
 for await(const raw of lines){const text=raw.trim();if(text==='/exit'||text==='exit'){lines.close();break}if(text==='/new'){sessionId=undefined;process.stdout.write('[New session]\n');prompt();continue}if(!text){prompt();continue}try{const c=await context(),result=await invoke(c,['--json',...(sessionId?['--session-id',sessionId]:[]),'-'],raw);if(result.sessionId)sessionId=result.sessionId;if(result.code)process.stdout.write('[DSH task exited '+result.code+']\n')}catch(error){process.stderr.write('DSH CLI: '+error.message+'\n')}prompt()}
}
main().catch(error=>{process.stderr.write('WorldlineBox DSH CLI: '+error.message+'\n');process.exitCode=1});
`;
}
