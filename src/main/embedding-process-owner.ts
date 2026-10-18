import { spawn, type ChildProcess } from 'node:child_process';

/**
 * A tiny owner process. Its private stdin pipe is the lifetime signal: if Main
 * exits or is killed, EOF causes this process to reap only its own runtime.
 * The script stays inline so no helper file is extracted beside user data.
 */
export const EMBEDDING_PROCESS_OWNER_SOURCE = String.raw`
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
let child;
let job;
let stopping = false;
let input = '';
let shutdown;

function configureWindowsJob(koffiPath) {
  const koffi = require(koffiPath);
  const kernel32 = koffi.load('kernel32.dll');
  const createJobObject = kernel32.func('void* __stdcall CreateJobObjectW(void*, void*)');
  const setInformation = kernel32.func('bool __stdcall SetInformationJobObject(void*, int32, void*, uint32)');
  const terminateJob = kernel32.func('bool __stdcall TerminateJobObject(void*, uint32)');
  const assignProcess = kernel32.func('bool __stdcall AssignProcessToJobObject(void*, void*)');
  const getCurrentProcess = kernel32.func('void* __stdcall GetCurrentProcess()');
  const closeHandle = kernel32.func('bool __stdcall CloseHandle(void*)');
  const handle = createJobObject(null, null);
  if (!handle) throw new Error('Could not create semantic runtime job.');
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on Windows x64.
  const information = Buffer.alloc(144);
  information.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  if (!setInformation(handle, 9, information, information.length)) {
    closeHandle(handle);
    throw new Error('Could not configure semantic runtime job.');
  }
  if (!assignProcess(handle, getCurrentProcess())) {
    closeHandle(handle);
    throw new Error('Could not assign semantic runtime owner to its job.');
  }
  job = { handle, terminate: terminateJob, closeHandle };
}

function terminateWindowsJob(exitCode, acknowledgement) {
  if (!job) throw new Error('Semantic runtime job is unavailable.');
  if (acknowledgement) {
    // STOP means Main requested close; REAP means the runtime exited and this
    // owner is asking the kernel to terminate remaining job descendants.
    process.stdout.write(acknowledgement, () => {
      if (!job.terminate(job.handle, exitCode)) process.exit(2);
    });
  } else if (!job.terminate(job.handle, exitCode)) {
    process.exit(2);
  }
}

function stop() {
  if (shutdown) return shutdown;
  stopping = true;
  if (process.platform === 'win32') {
    terminateWindowsJob(0, 'WORLDLINEBOX_EMBEDDING_STOP\n');
    shutdown = new Promise(() => {});
    return shutdown;
  }
  shutdown = (async () => {
    if (!child || !child.pid) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    const escalation = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, 1000);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      let groupAlive = false;
      try { process.kill(-child.pid, 0); groupAlive = true; } catch {}
      if (!groupAlive) {
        clearTimeout(escalation);
        return;
      }
      await delay(25);
    }
    clearTimeout(escalation);
    throw new Error('Semantic runtime process group did not stop.');
  })();
  return shutdown;
}

function finish(code) {
  if (process.platform === 'win32') {
    if (stopping) return;
    // The runtime exited independently. Reap remaining job descendants and
    // report that cleanup was requested before terminating this owner too.
    terminateWindowsJob(0, 'WORLDLINEBOX_EMBEDDING_REAP\n');
    return;
  }
  const requestedStop = stopping;
  stop().then(() => process.exit(requestedStop ? 0 : (code || 1)), () => process.exit(2));
}

function requestStop() {
  stopping = true;
  if (process.platform === 'win32') {
    try { terminateWindowsJob(0, 'WORLDLINEBOX_EMBEDDING_STOP\n'); } catch { process.exit(2); }
    return;
  }
  finish(0);
}

process.stdin.on('end', requestStop);
process.stdin.on('error', requestStop);
process.on('SIGTERM', requestStop);
process.on('SIGINT', requestStop);
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

process.stdin.on('data', (chunk) => {
  if (child || stopping) return;
  input += chunk;
  if (input.length > 1024 * 1024) return process.exit(1);
  if (!input.includes('\n')) return;
  try {
    const config = JSON.parse(input.slice(0, input.indexOf('\n')));
    if (typeof config.executable !== 'string' || typeof config.cwd !== 'string'
      || !Array.isArray(config.args) || config.args.some((v) => typeof v !== 'string')) {
      return process.exit(1);
    }
    if (process.platform === 'win32') configureWindowsJob(config.koffiPath);
    child = spawn(config.executable, config.args, {
      cwd: config.cwd, detached: process.platform !== 'win32',
      windowsHide: true, stdio: 'ignore',
    });
    input = '';
    child.once('error', () => finish(1));
    child.once('exit', (code) => finish(code || 0));
  } catch {
    // If setup fails after joining the job, closing the last non-inherited
    // handle kills this owner; Main observes an unacknowledged non-zero exit.
    if (job) {
      try { job.closeHandle(job.handle); } catch {}
    }
    process.exit(1);
  }
});
`;

type OwnerConfig = { executable: string; args: string[]; cwd: string; koffiPath?: string };
type OwnerState = {
  acknowledged: boolean;
  output: string;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};
const ownerStates = new WeakMap<ChildProcess, OwnerState>();

export function trackOwnedEmbeddingRuntimeOwner(
  owner: ChildProcess,
  options: { requireStopAck?: boolean } = {},
): void {
  let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const state: OwnerState = {
    acknowledged: !(options.requireStopAck ?? process.platform === 'win32'),
    output: '',
    exit: null,
    exited: new Promise((resolve) => { resolveExit = resolve; }),
  };
  ownerStates.set(owner, state);
  owner.stdout?.on('data', (chunk: Buffer | string) => {
    state.output += chunk.toString();
    if (state.output.includes('WORLDLINEBOX_EMBEDDING_STOP\n')
      || state.output.includes('WORLDLINEBOX_EMBEDDING_REAP\n')) state.acknowledged = true;
    if (state.output.length > 1024) state.output = state.output.slice(-256);
  });
  owner.once('exit', (code, signal) => {
    state.exit = { code, signal };
    resolveExit(state.exit);
  });
  owner.once('error', () => {
    state.exit ??= { code: null, signal: null };
    resolveExit(state.exit);
  });
}

export function spawnOwnedEmbeddingRuntime(
  executable: string,
  args: string[],
  cwd: string,
  options: { signal?: AbortSignal; koffiPath?: string } = {},
): ChildProcess {
  const config: OwnerConfig = {
    executable,
    args,
    cwd,
    ...(process.platform === 'win32' && options.koffiPath ? { koffiPath: options.koffiPath } : {}),
  };
  const owner = spawn(process.execPath, ['-e', EMBEDDING_PROCESS_OWNER_SOURCE], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  trackOwnedEmbeddingRuntimeOwner(owner);
  owner.stdin?.on('error', () => undefined);
  owner.stdin?.write(`${JSON.stringify(config)}\n`);
  if (options.signal) {
    if (options.signal.aborted) owner.stdin?.end();
    else options.signal.addEventListener('abort', () => owner.stdin?.end(), { once: true });
  }
  return owner;
}

/** Close the ownership pipe and wait until the owner confirms its tree stopped. */
export async function closeOwnedEmbeddingRuntime(owner: ChildProcess): Promise<void> {
  const state = ownerStates.get(owner);
  if (!state) throw new Error('Semantic runtime owner state is unavailable.');
  if (state.exit) {
    if (state.acknowledged && state.exit.code === 0 && !state.exit.signal) return;
    throw new Error('Semantic runtime owner exited before confirming cleanup.');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      owner.kill('SIGKILL'); // Closing the owner also closes its Windows Job handle.
      reject(new Error('Semantic runtime cleanup could not be confirmed within 15 seconds.'));
    }, 15000);
    const exited = (result: { code: number | null; signal: NodeJS.Signals | null }) => {
      clearTimeout(timer);
      if (state.acknowledged && result.code === 0 && !result.signal) resolve();
      else reject(new Error('Semantic runtime owner failed before confirming cleanup.'));
    };
    void state.exited.then(exited);
    owner.stdin?.end();
  });
}
