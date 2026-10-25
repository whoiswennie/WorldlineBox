import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify, stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import { lstat, mkdir, readFile, rm, writeFile } from './disk';
import { atomicJson } from './files';
import { sanitizeOutput, terminateOwnedProcess, type RuntimeLaunchPlan } from './instance-process';
import { attachProcessJob, type WindowsProcessJob } from './windows-job';
import type { DshInstance, DshRuntime } from '../../shared/dsh-launcher';
import type * as Koffi from 'koffi';
import { PTY_WORKER_MARKER, terminalPtyWorkerSource } from './terminal-pty-worker';

const execute = promisify(execFile);
const OUTPUT_LIMIT = 64 * 1024;
const CONTEXT_FORMAT = 'worldlinebox-native-dsh-cli-v1';
const CMD_MARKER = ':: WorldlineBox managed DSH command v1';
const SHIM_MARKER = '// WorldlineBox managed DSH shim v1';
/** ConPTY receives this plain object directly; Windows aliases must not compete. */
export function managedTerminalEnvironment(base: NodeJS.ProcessEnv, commandDirectory: string): NodeJS.ProcessEnv {
  const inheritedPath = Object.entries(base).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const env = { ...base };
  for (const key of Object.keys(env)) if (/^(PATH$|ELECTRON_RUN_AS_NODE$|WORLDLINEBOX_DSH_CLI_CONTEXT$)/i.test(key)) delete env[key];
  env.PATH = `${commandDirectory}${path.delimiter}${inheritedPath}`;
  return env;
}

export interface DshCliSelection {
  instance: DshInstance; plan: RuntimeLaunchPlan; env: NodeJS.ProcessEnv; workspacePath: string;
  runtimeVersion?: string; nativeArgs?: string[];
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
interface PersistedCliContext {
  format: string; instanceId: string; runtimeId: string; runtimeVersion: string;
  executable: string; nativeCli: string; nativeArgs: string[]; workspacePath: string;
  env: Record<string, string>;
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
  constructor(private readonly options: {
    rootPath: string; onChanged: () => void; onOutput?: (output: DshTerminalOutput) => void;
    resolveSelection: () => Promise<DshCliSelection>;
  }) {
    this.root = path.resolve(options.rootPath); this.directory = path.join(this.root, 'cli');
    this.contextFile = path.join(this.directory, 'native-selection.json'); this.bin = path.join(this.directory, 'bin');
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
    const shim = path.join(this.directory, 'shim.cjs');
    await this.writeManaged(shim, SHIM_MARKER, externalShimSource(this.root, this.contextFile));
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
        && within(path.join(this.root, 'instances'), (raw as PersistedCliContext).workspacePath)) this.selected = raw as PersistedCliContext;
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
  private async persistedContext(selection: DshCliSelection): Promise<PersistedCliContext> {
    const instance = selection.instance;
    if (!within(path.join(this.root, 'instances', instance.id), instance.homePath)
      || !within(path.join(this.root, 'instances', instance.id), instance.workspacePath)
      || !within(path.join(this.root, 'runtimes', instance.runtimeId), selection.plan.cli)) throw new Error('Unmanaged native CLI selection.');
    return { format: CONTEXT_FORMAT, instanceId: instance.id, runtimeId: instance.runtimeId,
      runtimeVersion: selection.runtimeVersion ?? '', executable: selection.plan.executable, nativeCli: selection.plan.cli,
      nativeArgs: ['--profile', 'web'], workspacePath: selection.workspacePath,
      env: { DSH_HOME: instance.homePath, DSH_AGENTS_HOME: instance.agentsPath } };
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
  async shutdown(): Promise<void> { await this.close(); }
  private async closeOwned(session:TerminalSession):Promise<void> {
    const child=session.worker;if(!child)return;
    if(child.connected)try{child.send({type:'close'},()=>undefined);}catch{/* A racing worker exit is verified through the Job below. */}
    const timeout=setTimeout(()=>{try{session.job?.terminate();if(!session.job)child.kill();}catch{/* Final Job accounting decides completion. */}},2000);
    try{await session.finished;}
    finally{clearTimeout(timeout);}
  }
}

/** Thin native CLI dispatch. DSH owns plugin resolution and all configuration. */
export function externalShimSource(rootPath: string, contextFile: string): string {
  return `${SHIM_MARKER}\n` + String.raw`
'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = ${JSON.stringify(rootPath)}, selected = process.env.WORLDLINEBOX_DSH_CLI_CONTEXT || ${JSON.stringify(contextFile)};
const inside = (base, value) => { const relative = path.relative(base, value); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
try {
 if (!inside(path.join(root, 'cli'), selected) || fs.lstatSync(selected).isSymbolicLink()) throw Error('Invalid CLI selection.');
 const context = JSON.parse(fs.readFileSync(selected, 'utf8'));
 if (context.format !== ${JSON.stringify(CONTEXT_FORMAT)} || !/^[a-z0-9-]{1,80}$/.test(context.instanceId) || !/^[a-z0-9-]{1,80}$/.test(context.runtimeId)) throw Error('Select a native DSH instance.');
 const program = path.join(root, 'runtimes', context.runtimeId, 'program');
 if (!inside(program, context.executable) || !inside(program, context.nativeCli)) throw Error('Unmanaged DSH runtime.');
 const env = { ...process.env, DSH_HOME: path.join(root, 'instances', context.instanceId, 'home'), DSH_AGENTS_HOME: path.join(root, 'instances', context.instanceId, 'agents') };
 delete env.ELECTRON_RUN_AS_NODE; delete env.WORLDLINEBOX_DSH_CLI_CONTEXT;
 const args = process.argv.slice(2);
 const result = cp.spawnSync(context.executable, ['--expose-internals', context.nativeCli, '--profile', 'web', ...args], { stdio: 'inherit', env, windowsHide: true });
 if (result.error) throw result.error; process.exitCode = result.status ?? 1;
} catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; }
`;
}
