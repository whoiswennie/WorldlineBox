import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const HOST_LIFECYCLE_MARKER = '// WorldlineBox managed native DSH Host lifecycle v1';
export const HOST_LIFECYCLE_TOKEN_ENV = 'WORLDLINEBOX_DSH_HOST_LIFECYCLE_TOKEN';
const MESSAGE_TYPE = 'worldlinebox:dsh-host:stop';
const ACK_TYPE = 'worldlinebox:dsh-host:stop-ack';

export interface ManagedHostBootstrap {
  bootstrapPath: string;
  nativeCli: string;
  /** Ephemeral per-process capability; never write it to instance records or logs. */
  token: string;
}

export interface ManagedHostStopResult {
  graceful: boolean;
  reason?: 'no-ipc' | 'native-handler-unavailable' | 'native-timeout' | 'timeout' | 'ipc-failed' | 'abnormal-exit';
  exitCode: number | null;
}

/**
 * RC 2 and alpha 2 expose runCli() and register SIGTERM after composing the
 * profile. Their signal handler disposes the Cordis tree, including buffered
 * session persistence. Windows ChildProcess.kill() skips that JavaScript path.
 * This private parent-child IPC bridge asks that same native handler to run.
 */
export function hostLifecycleBootstrapSource(): string {
  return `${HOST_LIFECYCLE_MARKER}\n` + String.raw`
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const TOKEN=process.env.WORLDLINEBOX_DSH_HOST_LIFECYCLE_TOKEN;
delete process.env.WORLDLINEBOX_DSH_HOST_LIFECYCLE_TOKEN;
if(!process.connected||typeof process.send!=='function'||typeof TOKEN!=='string'||!/^[a-f0-9]{64}$/.test(TOKEN))throw Error('DSH_HOST_PRIVATE_CHANNEL_REQUIRED');
const nativeCli=realpathSync.native(process.argv[2]);
process.argv=[process.execPath,nativeCli,...process.argv.slice(3)];
let stopping=false;
const acknowledge=(accepted)=>new Promise((resolve,reject)=>process.send({type:'worldlinebox:dsh-host:stop-ack',token:TOKEN,accepted},error=>error?reject(error):resolve()));
process.on('message',message=>{
 if(!message||typeof message!=='object'||message.type!=='worldlinebox:dsh-host:stop'||message.token!==TOKEN||stopping)return;
 if(process.listenerCount('SIGTERM')===0){void acknowledge(false).catch(()=>{});return;}
 stopping=true;
 void (async()=>{
  await acknowledge(true);
  // Emit once: native DSH escalates a second signal to immediate exit.
  process.emit('SIGTERM');
 })();
});
process.on('disconnect',()=>{
 if(stopping)return;
 if(process.listenerCount('SIGTERM')>0){stopping=true;process.emit('SIGTERM');}
 else process.exit(1);
});
const native=await import(pathToFileURL(nativeCli).href);
if(typeof native.runCli!=='function')throw Error('DSH_HOST_NATIVE_CLI_API_UNAVAILABLE');
await native.runCli();
`;
}

/** Place launcher-owned code beside private configuration, never inside a sealed runtime. */
export async function prepareManagedHostBootstrap(instanceRoot: string, nativeCli: string): Promise<ManagedHostBootstrap> {
  const root = await realpath(instanceRoot);
  const launcher = path.join(root, 'launcher');
  const current = await lstat(launcher).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (current && (current.isSymbolicLink() || !current.isDirectory())) throw new Error('Managed Host launcher directory is not an owned ordinary directory.');
  if (!current) await mkdir(launcher);
  const canonicalLauncher = await realpath(launcher);
  if (path.relative(root, canonicalLauncher) !== 'launcher') throw new Error('Managed Host bootstrap escaped private instance storage.');
  const bootstrapPath = path.join(canonicalLauncher, 'host-lifecycle.mjs');
  const source = hostLifecycleBootstrapSource();
  const previous = await lstat(bootstrapPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (previous) {
    if (!previous.isFile() || previous.isSymbolicLink() || previous.size > 32_768) throw new Error('Managed Host bootstrap is not an owned ordinary file.');
    const existing = await readFile(bootstrapPath, 'utf8');
    if (!existing.startsWith(`${HOST_LIFECYCLE_MARKER}\n`)) throw new Error('An unmanaged file occupies the Host bootstrap path.');
    if (existing === source) return { bootstrapPath, nativeCli: await realpath(nativeCli), token: randomBytes(32).toString('hex') };
  }
  const temporary = `${bootstrapPath}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, source, { flag: 'wx', mode: 0o600 });
  await rename(temporary, bootstrapPath);
  return { bootstrapPath, nativeCli: await realpath(nativeCli), token: randomBytes(32).toString('hex') };
}

/**
 * A successful stop requires an acknowledged native handler and normal exit
 * before the native five-second escalation window. This observes native
 * shutdown rather than a separate filesystem flush receipt; the upstream
 * handler also exits 0 when one of its disposers rejects.
 * On failure, the caller's exact owned-Job termination remains the final fence.
 * Return the fallback reason so the caller records incomplete graceful cleanup.
 */
export async function stopManagedHost(child: ChildProcess, token: string,
  forceOwnedStop: () => Promise<void>, timeoutMs = 15_000): Promise<ManagedHostStopResult> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid private Host lifecycle capability.');
  if (child.exitCode !== null || child.signalCode !== null) return {
    graceful: child.exitCode === 0, ...(child.exitCode === 0 ? {} : { reason: 'abnormal-exit' as const }), exitCode: child.exitCode,
  };
  if (!child.connected || typeof child.send !== 'function') {
    await forceOwnedStop(); return { graceful: false, reason: 'no-ipc', exitCode: child.exitCode };
  }
  let accepted = false;
  const requestedAt = Date.now();
  let finished = false;
  let finish!: (reason?: ManagedHostStopResult['reason']) => void;
  const pending = new Promise<ManagedHostStopResult['reason']>(resolve => {
    finish = reason => { if (!finished) { finished = true; resolve(reason); } };
  });
  const onMessage = (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const value = message as Record<string, unknown>;
    if (value.type !== ACK_TYPE || value.token !== token) return;
    if (value.accepted === true) accepted = true;
    else if (value.accepted === false) finish('native-handler-unavailable');
  };
  const onExit = (code: number | null) => finish(!accepted || code !== 0 ? 'abnormal-exit'
    : Date.now() - requestedAt >= 4_500 ? 'native-timeout' : undefined);
  const onError = () => finish('ipc-failed');
  child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
  const timer = setTimeout(() => finish('timeout'), timeoutMs);
  try {
    try { child.send({ type: MESSAGE_TYPE, token }, error => { if (error) finish('ipc-failed'); }); }
    catch { finish('ipc-failed'); }
    const reason = await pending;
    if (reason) await forceOwnedStop();
    return { graceful: !reason, ...(reason ? { reason } : {}), exitCode: child.exitCode };
  } finally {
    clearTimeout(timer);
    child.removeListener('message', onMessage); child.removeListener('exit', onExit); child.removeListener('error', onError);
  }
}
