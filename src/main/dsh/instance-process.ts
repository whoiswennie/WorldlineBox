import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { DshInstance } from '../../shared/dsh-launcher';
import { redact } from './files';
import { attachProcessJob, ownedWindowsProcessCreatedAt, type WindowsProcessJob } from './windows-job';
const processJobs = new WeakMap<ChildProcessWithoutNullStreams, WindowsProcessJob>();
const processTerminations = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();

const execute = promisify(execFile);
export interface RuntimeLaunchPlan { executable: string; cli: string; env: NodeJS.ProcessEnv }
export interface ProcessIdentity { pid: number; executable: string; cli: string; createdAt?: string }
export interface OwnedWindowsProcess { pid: number; parentPid: number; executable: string; createdAt: string }
export interface WindowsTerminationTools {
  inspect(pids: number[]): Promise<OwnedWindowsProcess[]>;
  killTree(pid: number): Promise<void>;
  killIdentity(identity: OwnedWindowsProcess): Promise<void>;
  pause(): Promise<void>;
}

function powershellPath(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
function validPid(pid: number): void { if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process ID.'); }
function parseProcessIdentities(stdout: string): OwnedWindowsProcess[] {
  if (!stdout.trim()) return [];
  const decoded: unknown = JSON.parse(stdout); const values = Array.isArray(decoded) ? decoded : [decoded];
  return values.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Could not identify the owned Harness process tree.');
    const fields = value as Record<string, unknown>;
    if (typeof fields.pid !== 'number' || typeof fields.parentPid !== 'number' || typeof fields.executable !== 'string'
      || typeof fields.createdAt !== 'string' || !Number.isFinite(Date.parse(fields.createdAt))) throw new Error('Could not identify the owned Harness process tree.');
    validPid(fields.pid);
    return { pid: fields.pid, parentPid: fields.parentPid, executable: fields.executable, createdAt: fields.createdAt };
  });
}

/** A child predating its parent belongs to an old use of that parent's PID. */
export function buildOwnedProcessTree(processes: OwnedWindowsProcess[], rootPid: number): OwnedWindowsProcess[] {
  const root = processes.find(process => process.pid === rootPid); if (!root) return [];
  const owned = [root]; const visited = new Set([rootPid]);
  for (let index = 0; index < owned.length; index++) {
    const parent = owned[index]!;
    for (const process of processes) if (!visited.has(process.pid) && process.parentPid === parent.pid
      && Date.parse(process.createdAt) >= Date.parse(parent.createdAt)) { visited.add(process.pid); owned.push(process); }
  }
  return owned;
}

/** Read only executable and creation identity for this root's descendants; never print command lines or environment. */
export async function inspectOwnedWindowsTree(rootPid: number): Promise<OwnedWindowsProcess[]> {
  validPid(rootPid);
  const command = `$all = @(Get-CimInstance Win32_Process); $root = $all | Where-Object { $_.ProcessId -eq ${rootPid} }; $owned = @(); $seen = @{}; if ($root) { $owned = @($root); $seen[${rootPid}] = $true; for ($index = 0; $index -lt $owned.Count; $index++) { $parent = $owned[$index]; foreach ($child in $all) { if ($child.ParentProcessId -eq $parent.ProcessId -and !$seen.ContainsKey([int]$child.ProcessId) -and $child.CreationDate -ge $parent.CreationDate) { $seen[[int]$child.ProcessId] = $true; $owned += $child } } } }; $values = @($owned | ForEach-Object { @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; executable = $_.ExecutablePath; createdAt = $_.CreationDate.ToUniversalTime().ToString('o') } }); ConvertTo-Json -InputObject $values -Compress`;
  const { stdout } = await execute(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15_000 });
  return parseProcessIdentities(stdout);
}

async function inspectWindowsIdentities(pids: number[]): Promise<OwnedWindowsProcess[]> {
  if (!pids.length) return [];
  pids.forEach(validPid);
  const filter = pids.map(pid => `ProcessId = ${pid}`).join(' OR ');
  const command = `$values = @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; executable = $_.ExecutablePath; createdAt = $_.CreationDate.ToUniversalTime().ToString('o') } }); ConvertTo-Json -InputObject $values -Compress`;
  const { stdout } = await execute(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10_000 });
  return parseProcessIdentities(stdout);
}
function matchesIdentity(expected: OwnedWindowsProcess, current: OwnedWindowsProcess | undefined): boolean {
  return !!current && current.pid === expected.pid && current.createdAt === expected.createdAt
    && path.resolve(current.executable).toLowerCase() === path.resolve(expected.executable).toLowerCase();
}

const windowsTerminationTools: WindowsTerminationTools = {
  inspect: inspectWindowsIdentities,
  killTree: async pid => { const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'); await execute(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20_000 }); },
  killIdentity: async identity => {
    validPid(identity.pid);
    const executable = identity.executable.replaceAll("'", "''"); const createdAt = identity.createdAt.replaceAll("'", "''");
    // Acquire the native process handle before checking identity, then Kill through that handle. A reused PID cannot redirect the kill.
    const command = `$ErrorActionPreference = 'Stop'; try { $native = [System.Diagnostics.Process]::GetProcessById(${identity.pid}); $handle = $native.Handle } catch [System.ArgumentException] { exit 0 }; try { $current = Get-CimInstance Win32_Process -Filter 'ProcessId = ${identity.pid}'; if ($current -and $current.ExecutablePath -ieq '${executable}' -and $current.CreationDate.ToUniversalTime().ToString('o') -ceq '${createdAt}' -and $native.Path -ieq '${executable}' -and [Math]::Abs(($native.StartTime.ToUniversalTime() - [DateTimeOffset]::Parse('${createdAt}').UtcDateTime).TotalMilliseconds) -lt 1) { $native.Kill() } } finally { $native.Dispose() }`;
    await execute(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10_000 });
  },
  pause: () => new Promise(resolve => setTimeout(resolve, 100)),
};

/** taskkill can report stale child errors after the tree has already exited. Identity, not its exit status, decides success. */
export async function stopOwnedWindowsTree(tree: OwnedWindowsProcess[], tools: WindowsTerminationTools = windowsTerminationTools): Promise<void> {
  if (!tree.length) return;
  const remaining = async () => {
    const current = await tools.inspect(tree.map(process => process.pid));
    return tree.filter(expected => matchesIdentity(expected, current.find(process => process.pid === expected.pid)));
  };
  const root = tree[0]!;
  const currentRoot = (await tools.inspect([root.pid])).find(process => process.pid === root.pid);
  if (matchesIdentity(root, currentRoot)) {
    try { await tools.killTree(root.pid); } catch { /* Inspect exact saved identities before deciding whether anything remains. */ }
  }
  let alive: OwnedWindowsProcess[] = [];
  for (let attempt = 0; attempt < 3; attempt++) { alive = await remaining(); if (!alive.length) return; await tools.pause(); }
  for (const identity of alive.toReversed()) {
    const current = (await tools.inspect([identity.pid])).find(process => process.pid === identity.pid);
    if (!matchesIdentity(identity, current)) continue;
    try { await tools.killIdentity(identity); } catch { /* A racing exit is accepted only after the final identity check. */ }
  }
  for (let attempt = 0; attempt < 8; attempt++) { alive = await remaining(); if (!alive.length) return; await tools.pause(); }
  throw new Error(`Owned Harness processes did not stop: ${alive.map(process => process.pid).join(', ')}. Instance data remains locked.`);
}

/** Native DSH namespaces isolate instances; tools retain the real user's environment. */
export async function instanceEnvironment(root: string, instance: DshInstance, plan: RuntimeLaunchPlan): Promise<NodeJS.ProcessEnv> {
  await Promise.all([instance.homePath, instance.agentsPath, instance.workspacePath, path.join(root, 'logs')]
    .map(directory => mkdir(directory, { recursive: true })));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(DSH_HOME$|DSH_AGENTS_HOME$|DSH_DESKTOP_|WORLDLINEBOX_DSH_|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key];
  return { ...env, ...plan.env, DSH_HOME: instance.homePath, DSH_AGENTS_HOME: instance.agentsPath, NO_COLOR: '1', FORCE_COLOR: '0' };
}

export async function launchCli(plan: RuntimeLaunchPlan, args: string[], env: NodeJS.ProcessEnv, cwd: string, options?: { ipc?: boolean }): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(plan.executable, ['--expose-internals', plan.cli, ...args], {
    cwd, env, shell: false, windowsHide: true, stdio: options?.ipc ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  // Keep spawn errors observed across the async handoff; the supervisor also attaches its own diagnostic listener.
  child.once('error', () => undefined);
  try {
    const job = attachProcessJob(child, { closeOnExit: false });
    if (job) {
      processJobs.set(child, job);
      // Keep Job accounting after the root exits: descendants may still be
      // terminating. Explicit cleanup joins this same verified operation.
      child.once('exit', () => { void terminateOwnedProcess(child).catch(() => undefined); });
    }
  }
  catch (error) { await terminateOwnedProcess(child); throw error; }
  return child;
}

export function sanitizeOutput(value: string): string {
  return redact(value.replace(/(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/[^\s?#]*)\?[^\s"']+/gi, '$1?[redacted]')
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s,"'\r\n}]+/gi, '$1[redacted]'));
}

export function parseReadyUrl(line: string): string | undefined {
  const match = stripVTControlCharacters(line).match(/^dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?[^\s]+)\s*$/);
  if (!match?.[1]) return undefined;
  const url = new URL(match[1]);
  const port = Number(url.port);
  if (port < 1 || port > 65535 || !url.search || url.username || url.password || url.hash) return undefined;
  return url.href;
}

/** Validate the owned Host's token exchange, instead of accepting any service on the port. */
export async function verifyReadyUrl(url: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
  const location = response.headers.get('location');
  const cookie = response.headers.get('set-cookie');
  await response.body?.cancel();
  if (response.status !== 303 || location !== './' || !cookie) throw new Error('Harness Host did not complete its authenticated readiness exchange.');
}

/** The identity is checked before recovering an orphan; a reused PID is never terminated. */
export async function inspectProcess(pid: number): Promise<{ executable: string; commandLine: string; createdAt: string } | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process ID.');
  if (process.platform !== 'win32') return undefined;
  const command = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { @{ executable = $p.ExecutablePath; commandLine = $p.CommandLine; createdAt = $p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`;
  const { stdout } = await execute(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10_000 });
  if (!stdout.trim()) return undefined;
  const value = JSON.parse(stdout) as Record<string, unknown>;
  if (typeof value.executable !== 'string' || typeof value.commandLine !== 'string' || typeof value.createdAt !== 'string') throw new Error('Could not identify the owned Harness process.');
  return { executable: value.executable, commandLine: value.commandLine, createdAt: value.createdAt };
}

/** A short-lived CLI can exit while CIM is formatting its record; an observed exit is authoritative. */
export async function inspectManagedProcess(child: ChildProcessWithoutNullStreams): Promise<{ createdAt: string } | undefined> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return undefined;
  try {
    const createdAt = ownedWindowsProcessCreatedAt(child.pid);
    return createdAt ? { createdAt } : undefined;
  }
  catch (error) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (child.exitCode !== null || child.signalCode !== null) return undefined;
    throw error;
  }
}

export function terminateOwnedProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  const existing = processTerminations.get(child); if (existing) return existing;
  const pending = Promise.resolve().then(async () => {
    const job = processJobs.get(child);
    job?.terminate();
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      if (process.platform === 'win32' && !job) await stopOwnedWindowsTree(await inspectOwnedWindowsTree(child.pid));
      else if (process.platform !== 'win32') child.kill('SIGTERM');
      let timeout: NodeJS.Timeout | undefined;
      try { if (child.exitCode === null && child.signalCode === null) await Promise.race([exited, new Promise<void>((_, reject) => { timeout = setTimeout(() => reject(new Error('Owned Harness process did not stop.')), 15_000); timeout.unref(); })]); }
      finally { if (timeout) clearTimeout(timeout); }
    }
    // Root exit alone does not prove that its tools released their files.
    if (job) { await job.waitForEmpty(); job.close(); processJobs.delete(child); }
  });
  processTerminations.set(child, pending);
  void pending.catch(() => { if (processTerminations.get(child) === pending) processTerminations.delete(child); });
  return pending;
}

export async function recoverOwnedProcess(identity: ProcessIdentity): Promise<boolean> {
  if (process.platform !== 'win32') {
    try { process.kill(identity.pid, 0); throw new Error('A previously owned Harness process may still be running; its identity cannot be verified on this platform.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  }
  const current = await inspectProcess(identity.pid);
  if (!current) return false;
  if (path.resolve(current.executable).toLowerCase() !== path.resolve(identity.executable).toLowerCase()
    || !current.commandLine.toLowerCase().includes(identity.cli.toLowerCase())) return false;
  if (!identity.createdAt) throw new Error('A Harness process still exists but its saved creation identity is missing. Stop it before changing this instance.');
  if (current.createdAt !== identity.createdAt) return false;
  const tree = await inspectOwnedWindowsTree(identity.pid);
  if (!tree[0] || tree[0].createdAt !== identity.createdAt || path.resolve(tree[0].executable).toLowerCase() !== path.resolve(identity.executable).toLowerCase()) return false;
  await stopOwnedWindowsTree(tree);
  return true;
}
