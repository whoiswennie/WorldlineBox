import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as Koffi from 'koffi';

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

type Handle = bigint | number;

interface JobApi {
  createJob(): Handle;
  setLimits(job: Handle, informationClass: number, limits: Buffer, size: number): number;
  openProcess(access: number, inherit: number, pid: number): Handle;
  assignProcess(job: Handle, process: Handle): number;
  terminateJob(job: Handle, exitCode: number): number;
  queryAccounting(job: Handle, informationClass: number, information: Buffer, size: number, returnLength: Handle): number;
  closeHandle(handle: Handle): number;
  lastError(): number;
  limits: Buffer;
}

export interface WindowsProcessJob {
  /** Stop every process assigned to this instance, including descendants. */
  terminate(): void;
  /** Closing the non-inherited last handle also stops every assigned process. */
  close(): void;
  /** Verify every owned descendant has stopped before releasing instance data. */
  waitForEmpty(timeoutMs?: number): Promise<void>;
}

let api: JobApi | undefined;

function loadJobApi(): JobApi {
  if (api) return api;
  // Externalised from the main bundle; do not load a native addon off Windows.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as typeof Koffi;
  const kernel = koffi.load('kernel32.dll');
  const basic = koffi.struct({
    PerProcessUserTimeLimit: 'int64_t',
    PerJobUserTimeLimit: 'int64_t',
    LimitFlags: 'uint32_t',
    MinimumWorkingSetSize: 'size_t',
    MaximumWorkingSetSize: 'size_t',
    ActiveProcessLimit: 'uint32_t',
    Affinity: 'uintptr_t',
    PriorityClass: 'uint32_t',
    SchedulingClass: 'uint32_t',
  });
  const counters = koffi.struct({
    ReadOperationCount: 'uint64_t', WriteOperationCount: 'uint64_t', OtherOperationCount: 'uint64_t',
    ReadTransferCount: 'uint64_t', WriteTransferCount: 'uint64_t', OtherTransferCount: 'uint64_t',
  });
  const extended = koffi.struct({
    BasicLimitInformation: basic,
    IoInfo: counters,
    ProcessMemoryLimit: 'size_t',
    JobMemoryLimit: 'size_t',
    PeakProcessMemoryUsed: 'size_t',
    PeakJobMemoryUsed: 'size_t',
  });
  // Win64: DWORDs remain 32-bit while SIZE_T/ULONG_PTR are 64-bit. A packed
  // or Unix-long layout would silently set the wrong flags or fail with 24.
  if (koffi.sizeof('uintptr_t') !== 8 || koffi.sizeof(basic) !== 64
    || koffi.sizeof(extended) !== 144 || koffi.offsetof(basic, 'LimitFlags') !== 16
    || koffi.offsetof(extended, 'IoInfo') !== 64 || koffi.offsetof(extended, 'ProcessMemoryLimit') !== 112) {
    throw new Error('DSH process supervision requires the Win64 Job Object ABI.');
  }
  const limits = Buffer.alloc(koffi.sizeof(extended));
  limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, koffi.offsetof(basic, 'LimitFlags'));
  api = {
    // NULL security attributes: this handle cannot be inherited. NULL name:
    // no other instance can open the same Job by an accidentally reused name.
    createJob: kernel.func('uintptr_t __stdcall CreateJobObjectW(uintptr_t attributes, uintptr_t name)').bind(null, 0, 0),
    setLimits: kernel.func('int __stdcall SetInformationJobObject(uintptr_t job, int informationClass, uint8_t *information, uint32_t size)'),
    openProcess: kernel.func('uintptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
    assignProcess: kernel.func('int __stdcall AssignProcessToJobObject(uintptr_t job, uintptr_t process)'),
    terminateJob: kernel.func('int __stdcall TerminateJobObject(uintptr_t job, uint32_t exitCode)'),
    queryAccounting: kernel.func('int __stdcall QueryInformationJobObject(uintptr_t job, int informationClass, uint8_t *information, uint32_t size, uintptr_t returnLength)'),
    closeHandle: kernel.func('int __stdcall CloseHandle(uintptr_t handle)'),
    lastError: kernel.func('uint32_t __stdcall GetLastError()'),
    limits,
  };
  return api;
}

function isNullHandle(handle: Handle): boolean { return handle === 0 || handle === 0n; }
function win32Error(api: JobApi, operation: string): Error {
  return new Error(`${operation} failed (Win32 error ${api.lastError()}). DSH instance processes are not safely supervised.`);
}

/**
 * Call synchronously immediately after spawn, before allowing a runtime to
 * start work. Windows 8+ allows an empty Job to become a nested Job even when
 * Electron/its launcher already belongs to a Job; no UI or breakaway limits
 * are added. Children created after assignment inherit this instance's Job.
 *
 * Assignment failures are fatal: the caller must stop the just-spawned owned
 * process tree before unlocking instance data. This helper never falls back
 * to treating an unassigned process as successfully supervised.
 */
export function attachProcessJob(child: ChildProcessWithoutNullStreams, options: {closeOnExit?: boolean} = {}): WindowsProcessJob | undefined {
  if (process.platform !== 'win32') return undefined;
  if (!child.pid || !Number.isSafeInteger(child.pid) || child.pid < 1) {
    throw new Error('Cannot assign a DSH process to a Windows Job without a valid spawned PID.');
  }
  const native = loadJobApi();
  const job = native.createJob();
  if (isNullHandle(job)) throw win32Error(native, 'CreateJobObjectW');
  let processHandle: Handle = 0;
  try {
    if (!native.setLimits(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, native.limits, native.limits.length)) {
      throw win32Error(native, 'SetInformationJobObject');
    }
    processHandle = native.openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child.pid);
    if (isNullHandle(processHandle)) throw win32Error(native, 'OpenProcess');
    if (!native.assignProcess(job, processHandle)) throw win32Error(native, 'AssignProcessToJobObject');
  } catch (error) {
    native.closeHandle(job);
    throw error;
  } finally {
    if (!isNullHandle(processHandle)) native.closeHandle(processHandle);
  }
  let closed = false;
  let terminated = false;
  const supervisor: WindowsProcessJob = {
    terminate() {
      if (closed || terminated) return;
      if (!native.terminateJob(job, 1)) throw win32Error(native, 'TerminateJobObject');
      terminated = true;
    },
    close() {
      if (closed) return;
      if (!native.closeHandle(job)) throw win32Error(native, 'CloseHandle');
      closed = true;
      child.removeListener('exit', onRootExit);
    },
    async waitForEmpty(timeoutMs = 10_000) {
      if (closed) return;
      const accounting = Buffer.alloc(48); const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (!native.queryAccounting(job, 1, accounting, accounting.length, 0)) throw win32Error(native, 'QueryInformationJobObject');
        if (accounting.readUInt32LE(40) === 0) return;
        if (Date.now() >= deadline) throw new Error('Owned terminal processes still hold their Windows Job.');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
  };
  // A normally exited Host must not leave plugin/tool descendants writing to
  // its Home after the service releases the instance lock. A crashed manager
  // requires no JS hook: Windows closes this non-inherited handle itself.
  const onRootExit = (): void => { supervisor.close(); };
  if (options.closeOnExit !== false) child.once('exit', onRootExit);
  return supervisor;
}
