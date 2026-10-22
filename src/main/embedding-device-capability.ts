import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, release, totalmem } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { EMBEDDING_DEVICE_BENCHMARK_VERSION, embeddingDeviceCapabilitySchema,
  type EmbeddingDeviceCapability, type EmbeddingDeviceHardware, type EmbeddingDeviceMetrics } from '../shared/embedding/device-capability';
import { LOCAL_TEXT_EMBEDDING_MODEL } from '../shared/embedding/global-profile';
import { chooseEmbeddingGpuDevice, startLlamaEmbeddingSession, type LlamaEmbeddingSession } from './embedding-llama-session';
import { fileSha256, resolveLocalTextEmbeddingLayout } from './embedding-text-model-install';

const MiB = 1024 * 1024;
const CACHE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** Safety and interaction budgets, not model quality scores or GPU brand requirements. */
export const EMBEDDING_DEVICE_BUDGETS = Object.freeze({
  minimumAvailableMemoryBytes: 3 * 1024 * MiB, textMedianMs: 2000, imageMs: 10000, startupMs: 45000, totalMs: 60000,
});
const TEXT_SAMPLES = [
  'title: none | text: 小肥鱼记得和伙伴约好周末去海边散步，带上一本书和一壶温水。约定还没有实现，不能记成已经发生。',
  'task: search result | query: 谁和我约好了去海边，准备带些什么？',
  'title: none | text: A companion keeps a diary, studies a shared document, and recalls the source without confusing a plan with a completed event.',
];
const execFileAsync = promisify(execFile);
type Layout = NonNullable<ReturnType<typeof resolveLocalTextEmbeddingLayout>>;
type Inspection = { hardware: EmbeddingDeviceHardware; layout: Layout | null; fingerprint: string };
export type EmbeddingDeviceCapabilityOptions = {
  userDataPath: string; bundleDirectory?: string; koffiPath?: string;
  onStatus?(status: EmbeddingDeviceCapability): void;
  /** Tests substitute hardware and owned sessions; production never supplies synthetic results. */
  probeHardware?(executable: string | undefined, signal?: AbortSignal): Promise<EmbeddingDeviceHardware>;
  startSession?: typeof startLlamaEmbeddingSession;
  availableMemory?: () => number;
  /** A shorter deadline is useful for controlled cancellation tests. */
  timeoutMs?: number;
};

export class EmbeddingDeviceUnavailableError extends Error {
  constructor(readonly capability: EmbeddingDeviceCapability) {
    super(capability.message); this.name = 'EmbeddingDeviceUnavailableError';
  }
}
class ProbeFailure extends Error {
  constructor(readonly reason: NonNullable<EmbeddingDeviceCapability['reason']>, message: string) { super(message); }
}

/** Parse the runtime's real device inventory; shared memory is never described as dedicated VRAM. */
export function parseEmbeddingDeviceInventory(listing: string): EmbeddingDeviceHardware['gpus'] {
  return listing.split(/\r?\n/u).flatMap(line => {
    const match = /^\s*([A-Za-z]+\d+):\s*(.+)\s+\((\d+) MiB,\s*(\d+) MiB free\)/u.exec(line);
    return match ? [{ id: match[1]!, name: match[2]!.trim(), totalMemoryMiB: Number(match[3]), freeMemoryMiB: Number(match[4]) }] : [];
  }).slice(0, 32);
}

export async function probeEmbeddingDeviceHardware(executable: string | undefined, signal?: AbortSignal): Promise<EmbeddingDeviceHardware> {
  signal?.throwIfAborted();
  const hardware: EmbeddingDeviceHardware = { observedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    osRelease: release(), cpuModel: cpus()[0]?.model ?? 'Unknown CPU', logicalCores: Math.max(1, availableParallelism()),
    totalMemoryBytes: totalmem(), availableMemoryBytes: freemem(), gpus: [] };
  if (executable && path.basename(path.dirname(executable)) === 'runtime-vulkan') {
    try {
      const output = await execFileAsync(executable, ['--list-devices'], { windowsHide: true, timeout: 12000, maxBuffer: 128 * 1024, signal });
      hardware.gpus = parseEmbeddingDeviceInventory(`${output.stdout}\n${output.stderr}`);
    } catch (error) {
      signal?.throwIfAborted();
      hardware.gpuProbeError = error instanceof Error ? error.message.slice(0, 300) : 'GPU inventory is unavailable; CPU remains eligible.';
    }
  }
  if (process.platform === 'win32' && hardware.gpus.length) {
    try {
      const output = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024, signal });
      const parsed: unknown = JSON.parse(output.stdout), drivers = Array.isArray(parsed) ? parsed : [parsed];
      for (const gpu of hardware.gpus) {
        const driver = drivers.find((value): value is { Name: string; DriverVersion: string } => !!value && typeof value === 'object'
          && typeof value.Name === 'string' && typeof value.DriverVersion === 'string' && (gpu.name.includes(value.Name) || value.Name.includes(gpu.name)));
        if (driver) gpu.driver = driver.DriverVersion.slice(0, 100);
      }
    } catch { signal?.throwIfAborted(); /* Driver metadata is optional; inference still decides actual support. */ }
  }
  return hardware;
}

/** Cache only stable device properties; current memory pressure is checked separately every time. */
export function embeddingDeviceFingerprint(hardware: EmbeddingDeviceHardware, runtimeHashes: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ benchmark: EMBEDDING_DEVICE_BENCHMARK_VERSION, budgets: EMBEDDING_DEVICE_BUDGETS,
    model: { revision: LOCAL_TEXT_EMBEDDING_MODEL.revision, core: LOCAL_TEXT_EMBEDDING_MODEL.sha256,
      projector: LOCAL_TEXT_EMBEDDING_MODEL.projectorSha256, runtime: LOCAL_TEXT_EMBEDDING_MODEL.runtimeRelease, context: LOCAL_TEXT_EMBEDDING_MODEL.contextTokens },
    platform: hardware.platform, arch: hardware.arch, osRelease: hardware.osRelease, cpu: hardware.cpuModel,
    cores: hardware.logicalCores, ram: hardware.totalMemoryBytes,
    gpus: hardware.gpus.map(gpu => ({ id: gpu.id, name: gpu.name, totalMemoryMiB: gpu.totalMemoryMiB, driver: gpu.driver })).sort((a, b) => a.id.localeCompare(b.id)), runtimeHashes,
  })).digest('hex');
}

/** Explicit, disposable native self-test. Merely viewing settings never loads any weights. */
export class EmbeddingDeviceCapabilityService {
  #state: EmbeddingDeviceCapability = this.#initial();
  #active?: Promise<EmbeddingDeviceCapability>;
  #controller?: AbortController;
  #closed = false;
  #inspection?: { until: number; promise: Promise<Inspection> };
  constructor(private readonly options: EmbeddingDeviceCapabilityOptions) {}
  #initial(): EmbeddingDeviceCapability {
    return { version: 1, benchmarkVersion: EMBEDDING_DEVICE_BENCHMARK_VERSION, state: 'unchecked', stage: '尚未检测',
      message: '运行一次本机检测后即可启用伙伴记忆与资产语义搜索。普通资产管理和全文搜索可以继续使用。',
      retryable: true, cacheUsed: false, budgets: { ...EMBEDDING_DEVICE_BUDGETS } };
  }
  snapshot(): EmbeddingDeviceCapability { return structuredClone(this.#state); }
  #publish(state: EmbeddingDeviceCapability): EmbeddingDeviceCapability {
    this.#state = state; this.options.onStatus?.(this.snapshot()); return this.snapshot();
  }
  #cachePath(): string { return path.join(this.options.userDataPath, 'embedding-models', 'device-capability-v1.json'); }
  async #inspect(force = false, signal?: AbortSignal): Promise<Inspection> {
    if (!force && this.#inspection && this.#inspection.until > Date.now()) return this.#inspection.promise;
    const promise = (async () => {
      const layout = resolveLocalTextEmbeddingLayout(this.options.userDataPath, this.options.bundleDirectory);
      const hardware = await (this.options.probeHardware ?? probeEmbeddingDeviceHardware)(layout?.runtimePath, signal);
      const hashes: string[] = [];
      for (const executable of new Set([layout?.runtimePath, layout?.cpuRuntimePath].filter((value): value is string => !!value))) {
        signal?.throwIfAborted();
        try { hashes.push(await fileSha256(executable)); } catch { hashes.push('unavailable'); }
      }
      if (layout) for (const file of [layout.corePath, path.join(path.dirname(layout.corePath), LOCAL_TEXT_EMBEDDING_MODEL.projectorFileName)]) {
        try { const info = await stat(file); hashes.push(`${info.size}:${info.mtimeMs}`); } catch { hashes.push('model-metadata-unavailable'); }
      }
      signal?.throwIfAborted();
      return { hardware, layout, fingerprint: embeddingDeviceFingerprint(hardware, hashes) };
    })();
    this.#inspection = { until: Date.now() + 30000, promise };
    try { return await promise; } catch (error) { this.#inspection = undefined; throw error; }
  }
  #staticFailure(inspection: Inspection): EmbeddingDeviceCapability | undefined {
    const base = { ...this.#initial(), hardware: inspection.hardware, fingerprint: inspection.fingerprint };
    if (!inspection.layout) return { ...base, state: 'error', stage: '内置模型文件待修复', reason: 'missing_package', message: '应用内置模型文件或运行组件不完整，请先验证与修复，再重新检测。' };
    if (inspection.hardware.availableMemoryBytes < EMBEDDING_DEVICE_BUDGETS.minimumAvailableMemoryBytes) {
      return { ...base, state: 'unsupported', stage: '当前可用内存不足', reason: 'memory_pressure',
        message: '为给模型及软件保留运行空间，检测前至少需要 3 GiB 可用内存。关闭其他高占用程序后可以重新检测；普通资产管理和全文搜索仍可使用。' };
    }
    return undefined;
  }
  async status(): Promise<EmbeddingDeviceCapability> {
    if (this.#active || this.#closed) return this.snapshot();
    try {
      const inspected = await this.#inspect(), inspection = { ...inspected, hardware: { ...inspected.hardware,
        availableMemoryBytes: (this.options.availableMemory ?? freemem)() } };
      if (this.#active) return this.snapshot();
      if (this.#state.state === 'unchecked' && this.#state.reason === 'cancelled') {
        return this.#publish({ ...this.#state, hardware: inspection.hardware, fingerprint: inspection.fingerprint });
      }
      const failure = this.#staticFailure(inspection);
      if (failure) return this.#publish(failure);
      let cached: EmbeddingDeviceCapability | undefined;
      try { cached = embeddingDeviceCapabilitySchema.parse(JSON.parse(await readFile(this.#cachePath(), 'utf8'))); } catch { /* No trusted cached measurement. */ }
      if (this.#active) return this.snapshot();
      if (cached && cached.fingerprint === inspection.fingerprint && cached.testedAt && cached.expiresAt && Date.parse(cached.expiresAt) > Date.now()
        && Date.parse(cached.testedAt) <= Date.now() && (cached.state === 'supported' || cached.state === 'unsupported') && cached.metrics
        && (cached.backend !== 'gpu' || inspection.hardware.gpus.some(gpu => gpu.id === cached.deviceId && gpu.freeMemoryMiB >= 1536))) {
        return this.#publish({ ...cached, hardware: inspection.hardware, cacheUsed: true });
      }
      if (this.#state.fingerprint === inspection.fingerprint && this.#state.state === 'error') return this.snapshot();
      return this.#publish({ ...this.#initial(), hardware: inspection.hardware, fingerprint: inspection.fingerprint,
        ...(cached ? { reason: 'hardware_changed' as const, message: '设备、模型或检测版本已变化，或上次结果已过期。请重新检测后启用本地向量功能。' } : {}) });
    } catch (error) {
      return this.#publish({ ...this.#initial(), state: 'error', reason: 'runtime', stage: '设备信息读取失败', message: safeMessage(error) });
    }
  }
  test(input: { force?: boolean; signal?: AbortSignal;
    /** Host-only drain barrier; never passed by automatic first-use tests or Renderer input. */
    beforeTest?: () => Promise<void> } = {}): Promise<EmbeddingDeviceCapability> {
    if (this.#active) return this.#active;
    if (this.#closed) return Promise.resolve(this.snapshot());
    const controller = new AbortController(); this.#controller = controller;
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const promise = this.#test(signal, input.force === true, input.beforeTest).finally(() => { this.#active = undefined; this.#controller = undefined; });
    this.#active = promise; return promise;
  }
  async cancel(): Promise<void> {
    this.#controller?.abort(new ProbeFailure('cancelled', '检测已取消，临时模型进程已释放。可以随时重新检测。'));
    await this.#active;
  }
  async close(): Promise<void> { this.#closed = true; await this.cancel(); }
  async ensureSupported(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#closed) throw new EmbeddingDeviceUnavailableError({ ...this.snapshot(), state: 'error', reason: 'runtime', stage: '检测服务已停止', message: '本地模型检测服务已停止。', retryable: false });
    let status = signal ? await abortable(this.status(), signal) : await this.status();
    // Called only by a real vector-dependent action, never application startup or the read-only status page.
    if (status.state === 'unchecked' && status.reason !== 'cancelled' || status.state === 'testing') {
      // A library switch may cancel its waiter; it must not cancel the shared device test used by other features.
      const test = this.test(); status = signal ? await abortable(test, signal) : await test;
    }
    if (status.state !== 'supported') throw new EmbeddingDeviceUnavailableError(status);
  }
  async #test(signal: AbortSignal, force: boolean, beforeTest?: () => Promise<void>): Promise<EmbeddingDeviceCapability> {
    const started = performance.now(), timeout = AbortSignal.timeout(Math.min(this.options.timeoutMs ?? EMBEDDING_DEVICE_BUDGETS.totalMs, EMBEDDING_DEVICE_BUDGETS.totalMs));
    const scoped = AbortSignal.any([signal, timeout]);
    let session: LlamaEmbeddingSession | undefined, monitor: ReturnType<typeof setInterval> | undefined;
    let preparation: Promise<void> | undefined;
    let minimumAvailable = (this.options.availableMemory ?? freemem)();
    const safety = new AbortController(), workSignal = AbortSignal.any([scoped, safety.signal]);
    this.#publish({ ...this.#initial(), state: 'testing', stage: beforeTest ? '释放当前模型' : '读取设备信息',
      message: beforeTest ? '正在等待当前模型任务结束并释放进程，随后进行本机检测。' : '正在读取 CPU、内存和可用图形设备，尚未加载模型。', retryable: false });
    try {
      workSignal.throwIfAborted();
      if (beforeTest) {
        preparation = Promise.resolve().then(beforeTest);
        await abortable(preparation, workSignal);
        this.#publish({ ...this.#state, stage: '读取设备信息', message: '当前模型已释放，正在读取 CPU、内存和可用图形设备。' });
      }
      const inspection = await abortable(this.#inspect(true, workSignal), workSignal), failure = this.#staticFailure(inspection);
      if (failure) return this.#publish(failure);
      if (!force) {
        try {
          const cached = embeddingDeviceCapabilitySchema.parse(JSON.parse(await readFile(this.#cachePath(), 'utf8')));
          if (cached.fingerprint === inspection.fingerprint && cached.state === 'supported' && cached.metrics && cached.testedAt && Date.parse(cached.testedAt) <= Date.now()
            && cached.expiresAt && Date.parse(cached.expiresAt) > Date.now()
            && (cached.backend !== 'gpu' || inspection.hardware.gpus.some(gpu => gpu.id === cached.deviceId && gpu.freeMemoryMiB >= 1536))) {
            return this.#publish({ ...cached, hardware: inspection.hardware, cacheUsed: true });
          }
        } catch { /* An explicit test can proceed without a cache. */ }
      }
      await rm(this.#cachePath(), { force: true });
      this.#publish({ ...this.#state, hardware: inspection.hardware, fingerprint: inspection.fingerprint, stage: '核验内置模型', message: '正在核验随应用提供的量化模型和多模态组件。' });
      const layout = inspection.layout!, projectorPath = path.join(path.dirname(layout.corePath), LOCAL_TEXT_EMBEDDING_MODEL.projectorFileName);
      const hashes = await abortable(Promise.all([fileSha256(layout.corePath), fileSha256(projectorPath)]), workSignal);
      if (hashes[0] !== LOCAL_TEXT_EMBEDDING_MODEL.sha256 || hashes[1] !== LOCAL_TEXT_EMBEDDING_MODEL.projectorSha256) {
        throw new ProbeFailure('integrity', '内置量化模型未通过校验，请验证与修复应用文件后重新检测。');
      }
      if ((this.options.availableMemory ?? freemem)() < EMBEDDING_DEVICE_BUDGETS.minimumAvailableMemoryBytes) {
        throw new ProbeFailure('memory_pressure', '加载模型前可用内存已不足 3 GiB，检测已停止。释放其他程序占用后可以重新检测。');
      }
      const listing = inspection.hardware.gpus.map(gpu => `${gpu.id}: ${gpu.name} (${gpu.totalMemoryMiB} MiB, ${gpu.freeMemoryMiB} MiB free)`).join('\n');
      const selected = chooseEmbeddingGpuDevice(listing);
      const gpu = inspection.hardware.gpus.find(item => item.id === selected);
      let backend = selected && path.basename(path.dirname(layout.runtimePath)) === 'runtime-vulkan' ? 'gpu' as const : 'cpu' as const;
      this.#publish({ ...this.#state, backend, ...(gpu && backend === 'gpu' ? { deviceId: gpu.id, deviceName: gpu.name } : {}), stage: '临时加载量化模型',
        message: `正在使用${backend === 'gpu' ? gpu!.name : ' CPU'}执行短文本与小图检测，完成后释放临时模型。` });
      monitor = setInterval(() => {
        minimumAvailable = Math.min(minimumAvailable, (this.options.availableMemory ?? freemem)());
        if (minimumAvailable < 512 * MiB) safety.abort(new ProbeFailure('memory_pressure', '检测时可用内存降至 512 MiB 以下，已停止模型以保留软件运行空间。关闭其他程序后可以重新检测。'));
      }, 250);
      const launchAt = performance.now();
      const launch = (mode: 'gpu' | 'cpu') => (this.options.startSession ?? startLlamaEmbeddingSession)({ executable: mode === 'gpu' ? layout.runtimePath : layout.cpuRuntimePath ?? layout.runtimePath,
        files: { corePath: layout.corePath, projectorPath }, gpuLayers: mode === 'gpu' ? 99 : 0, ...(mode === 'gpu' && selected ? { device: selected } : {}),
        modelName: LOCAL_TEXT_EMBEDDING_MODEL.id, contextSize: LOCAL_TEXT_EMBEDDING_MODEL.contextTokens,
        pooling: LOCAL_TEXT_EMBEDDING_MODEL.pooling, threads: Math.max(1, Math.min(4, availableParallelism())),
        startupTimeoutMs: EMBEDDING_DEVICE_BUDGETS.startupMs, requestTimeoutMs: EMBEDDING_DEVICE_BUDGETS.imageMs + 1000,
        signal: workSignal, koffiPath: this.options.koffiPath });
      const native = launch(backend).catch(async error => {
        // Native startup reaps its process before rejecting. Never start another process when cleanup failed.
        if (backend !== 'gpu' || workSignal.aborted || error instanceof AggregateError) throw error;
        backend = 'cpu';
        this.#publish({ ...this.#state, backend, deviceId: undefined, deviceName: undefined, stage: '使用 CPU 进行短测',
          message: '当前图形设备未能启动模型，正在使用同一量化模型检测 CPU 运行速度。' });
        return launch('cpu');
      });
      // Native startup observes workSignal and waits for its process owner to exit before rejecting.
      session = await native;
      const startupMs = performance.now() - launchAt, textMs: number[] = [];
      this.#publish({ ...this.#state, stage: '检测中文与英文短文本', message: '正在测量 3 个固定短文本的真实推理时间与向量格式。' });
      for (const text of TEXT_SAMPLES) {
        const at = performance.now();
        const vector = await abortable(session.embedTexts ? session.embedTexts([text], workSignal).then(result => result[0]) : session.embedText(text), workSignal);
        validVector(vector); textMs.push(performance.now() - at);
      }
      this.#publish({ ...this.#state, stage: '检测小图像', message: '正在测量固定 224 × 224 小图的真实推理时间；结果只代表常规短输入，不保证超大媒体的处理速度。' });
      const imageAt = performance.now();
      validVector(await abortable(session.embedImagePayload('image/png', fixedProbePng().toString('base64')), workSignal));
      const imageMs = performance.now() - imageAt;
      minimumAvailable = Math.min(minimumAvailable, (this.options.availableMemory ?? freemem)());
      const metrics: EmbeddingDeviceMetrics = { startupMs, textMs, textMedianMs: [...textMs].sort((a, b) => a - b)[1]!, imageMs,
        totalMs: performance.now() - started, minimumAvailableMemoryBytes: minimumAvailable };
      const supported = startupMs <= EMBEDDING_DEVICE_BUDGETS.startupMs && metrics.textMedianMs <= EMBEDDING_DEVICE_BUDGETS.textMedianMs && imageMs <= EMBEDDING_DEVICE_BUDGETS.imageMs;
      const testedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + CACHE_LIFETIME_MS).toISOString();
      const result: EmbeddingDeviceCapability = { ...this.#state, state: supported ? 'supported' : 'unsupported', stage: supported ? '检测通过' : '当前速度未达到常规使用预算',
        message: supported ? '短文本与小图检测通过，可以启用本地向量功能。大型图片、音视频与大量资料仍按需排队处理。'
          : '模型能够运行，但短文本或小图处理超出常规交互预算。请释放资源后复测；普通资产管理和全文搜索可以继续使用。',
        retryable: true, cacheUsed: false, ...(supported ? {} : { reason: 'latency' as const }), metrics, testedAt, expiresAt };
      // Publish and persist only after the owned temporary process has actually exited.
      this.#publish({ ...this.#state, stage: '释放临时模型', message: '检测已完成，正在释放临时模型进程。' });
      if (monitor) { clearInterval(monitor); monitor = undefined; }
      await session.close(); session = undefined;
      workSignal.throwIfAborted();
      const cache = this.#cachePath(); await mkdir(path.dirname(cache), { recursive: true });
      await writeFile(`${cache}.tmp`, JSON.stringify(result), 'utf8'); await rename(`${cache}.tmp`, cache);
      workSignal.throwIfAborted();
      return this.#publish(result);
    } catch (error) {
      // Cancellation must not reopen the gate until the host confirms the previous owned processes have drained.
      if (preparation) await preparation.catch(() => undefined);
      const cause = workSignal.aborted ? workSignal.reason : error;
      const reason = cause instanceof ProbeFailure ? cause.reason : timeout.aborted ? 'timeout' : 'runtime';
      const cancelled = reason === 'cancelled' || signal.aborted;
      await rm(this.#cachePath(), { force: true }).catch(() => undefined);
      // The UI must not report a finished/cancelled operation until its temporary runtime is gone.
      if (monitor) { clearInterval(monitor); monitor = undefined; }
      safety.abort(cause);
      if (session) {
        try { await session.close(); session = undefined; }
        catch (cleanup) { return this.#publish({ ...this.#state, state: 'error', reason: 'runtime', stage: '临时进程释放失败', retryable: true, cacheUsed: false, message: safeMessage(cleanup) }); }
      }
      return this.#publish({ ...this.#state, state: cancelled ? 'unchecked' : reason === 'memory_pressure' ? 'unsupported' : 'error',
        reason: cancelled ? 'cancelled' : reason, stage: cancelled ? '检测已取消' : '检测未完成', retryable: true, cacheUsed: false,
        message: timeout.aborted ? '本机检测超过 60 秒，已停止临时模型。可以释放资源后重试。'
          : cancelled ? '检测已取消，临时模型进程已释放。可以随时重新检测。' : safeMessage(cause) });
    } finally {
      if (monitor) clearInterval(monitor);
      // Abort interrupts native requests as well as startup; close waits for its private process owner.
      safety.abort(new Error('Device self-test finished.'));
      if (session) await session.close().catch(error => {
        this.#publish({ ...this.#state, state: 'error', reason: 'runtime', stage: '临时进程释放失败', retryable: true, message: safeMessage(error) });
      });
    }
  }
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : '本机模型检测未完成，请释放资源后重试。').slice(0, 1000);
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) listener();
    })]);
  } finally { if (listener) signal.removeEventListener('abort', listener); }
}
function validVector(vector: number[] | undefined): void {
  if (!vector || vector.length !== LOCAL_TEXT_EMBEDDING_MODEL.dimension || vector.some(value => !Number.isFinite(value))
    || Math.hypot(...vector) < 1e-9) throw new ProbeFailure('runtime', '模型没有返回有效的 768 维向量，请验证与修复本地运行组件后重试。');
}
/** A deterministic small gradient image, generated locally without downloads or user files. */
function fixedProbePng(): Buffer {
  const crc = (bytes: Buffer): number => {
    let value = 0xffffffff;
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(224, 0); header.writeUInt32BE(224, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(224 * (1 + 224 * 3));
  for (let y = 0; y < 224; y++) for (let x = 0; x < 224; x++) {
    const offset = y * (1 + 224 * 3) + 1 + x * 3;
    pixels[offset] = x; pixels[offset + 1] = y; pixels[offset + 2] = 128;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
