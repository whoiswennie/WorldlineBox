import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingDeviceCapabilityService, EmbeddingDeviceUnavailableError, embeddingDeviceFingerprint,
  parseEmbeddingDeviceInventory } from '../../src/main/embedding-device-capability';
import { LOCAL_TEXT_EMBEDDING_MODEL } from '../../src/shared/embedding/global-profile';
import { embeddingDeviceCapabilitySchema, type EmbeddingDeviceHardware } from '../../src/shared/embedding/device-capability';
import type { LlamaEmbeddingSession } from '../../src/main/embedding-llama-session';

const disk = vi.hoisted(() => ({ resolveLayout: vi.fn(), sha: vi.fn() }));
vi.mock('../../src/main/embedding-text-model-install', () => ({ resolveLocalTextEmbeddingLayout: disk.resolveLayout, fileSha256: disk.sha }));
const roots: string[] = [], services: EmbeddingDeviceCapabilityService[] = [];
const GiB = 1024 ** 3;
const vector = () => [3, 4, ...Array<number>(766).fill(0)];
function localSession(overrides: Partial<LlamaEmbeddingSession> = {}): LlamaEmbeddingSession {
  return { embedText: vi.fn(async () => vector()), embedTexts: vi.fn(async () => [vector()]), embedImage: vi.fn(),
    embedImagePayload: vi.fn(async () => vector()), embedVideoPayload: vi.fn(), embedAudio: vi.fn(), embedAudioPayload: vi.fn(), close: vi.fn(async () => undefined), ...overrides };
}
async function fixture(input: { gpu?: boolean; available?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-device-unit-')); roots.push(root);
  const hardware: EmbeddingDeviceHardware = { observedAt: new Date().toISOString(), platform: 'win32', arch: 'x64', osRelease: 'test-os',
    cpuModel: 'Test CPU', logicalCores: 4, totalMemoryBytes: 8 * GiB, availableMemoryBytes: input.available ?? 6 * GiB,
    gpus: input.gpu ? [{ id: 'Vulkan2', name: 'AMD Radeon Example', totalMemoryMiB: 4096, freeMemoryMiB: 3072, driver: '1.0' }] : [] };
  disk.resolveLayout.mockReturnValue({ corePath: path.join(root, 'core.gguf'), runtimePath: path.join(root, input.gpu ? 'runtime-vulkan' : 'runtime-cpu', 'llama-server.exe'),
    cpuRuntimePath: path.join(root, 'runtime-cpu/llama-server.exe') });
  const local = localSession(), start = vi.fn(async () => local), probe = vi.fn(async () => structuredClone(hardware));
  const options = { userDataPath: root, probeHardware: probe, availableMemory: () => hardware.availableMemoryBytes, startSession: start };
  const service = new EmbeddingDeviceCapabilityService(options); services.push(service);
  return { root, hardware, local, start, probe, options, service };
}
beforeEach(() => {
  disk.resolveLayout.mockReset();
  disk.sha.mockReset().mockImplementation(async (file: string) => path.basename(file) === 'core.gguf' ? LOCAL_TEXT_EMBEDDING_MODEL.sha256
    : path.basename(file) === LOCAL_TEXT_EMBEDDING_MODEL.projectorFileName ? LOCAL_TEXT_EMBEDDING_MODEL.projectorSha256 : 'c'.repeat(64));
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-device-unit-')) throw new Error('Unsafe device test cleanup.');
    await rm(root, { recursive: true, force: true });
  }
});

describe('local embedding device capability', () => {
  it('reads hardware without starting a model and refuses unsafe memory before inference', async () => {
    const { service, start, hardware } = await fixture({ available: 2 * GiB });
    expect(await service.status()).toMatchObject({ state: 'unsupported', reason: 'memory_pressure', retryable: true });
    expect(await service.test({ force: true })).toMatchObject({ state: 'unsupported', reason: 'memory_pressure' });
    expect(start).not.toHaveBeenCalled();
    hardware.availableMemoryBytes = 6 * GiB;
    expect((await service.status()).state).toBe('unchecked'); expect(start).not.toHaveBeenCalled();
    disk.resolveLayout.mockReturnValue(null);
    expect(await service.test({ force: true })).toMatchObject({ state: 'error', reason: 'missing_package' });
    expect(start).not.toHaveBeenCalled();
  });

  it('accepts a measured CPU without a GPU and uses a versioned cache while checking current free RAM', async () => {
    const { service, start, local, hardware, options, root } = await fixture();
    expect((await service.status()).state).toBe('unchecked'); expect(start).not.toHaveBeenCalled();
    const result = await service.test();
    expect(result).toMatchObject({ state: 'supported', backend: 'cpu', cacheUsed: false });
    embeddingDeviceCapabilitySchema.parse(result);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ gpuLayers: 0, contextSize: 8192, files: expect.objectContaining({ projectorPath: expect.any(String) }) }));
    expect(local.embedTexts).toHaveBeenCalledTimes(3); expect(local.embedImagePayload).toHaveBeenCalledWith('image/png', expect.any(String));
    expect(local.close).toHaveBeenCalledOnce();
    const restarted = new EmbeddingDeviceCapabilityService(options); services.push(restarted);
    expect(await restarted.status()).toMatchObject({ state: 'supported', cacheUsed: true, fingerprint: result.fingerprint });
    expect(start).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(path.join(root, 'embedding-models/device-capability-v1.json'), 'utf8')).testedAt).toBe(result.testedAt);
    hardware.availableMemoryBytes = 1 * GiB;
    expect(await restarted.status()).toMatchObject({ state: 'unsupported', reason: 'memory_pressure' });
    await expect(restarted.ensureSupported()).rejects.toBeInstanceOf(EmbeddingDeviceUnavailableError);
    expect(start).toHaveBeenCalledOnce();
  });

  it('tests the actual inventoried GPU regardless of brand and force retests instead of treating installation as capability', async () => {
    const { service, start } = await fixture({ gpu: true });
    const result = await service.test();
    expect(result).toMatchObject({ state: 'supported', backend: 'gpu', deviceId: 'Vulkan2', deviceName: 'AMD Radeon Example' });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ gpuLayers: 99, device: 'Vulkan2' }));
    await service.test(); expect(start).toHaveBeenCalledOnce();
    await service.test({ force: true }); expect(start).toHaveBeenCalledTimes(2);
  });

  it('falls back to the same quantized CPU model after a cleaned GPU startup failure, but refuses uncertain cleanup', async () => {
    const { service, start, local } = await fixture({ gpu: true });
    start.mockRejectedValueOnce(new Error('GPU unavailable'));
    expect(await service.test()).toMatchObject({ state: 'supported', backend: 'cpu', deviceId: undefined });
    expect(start).toHaveBeenNthCalledWith(2, expect.objectContaining({ gpuLayers: 0, files: expect.objectContaining({ corePath: expect.stringContaining('core.gguf') }) }));
    expect(local.close).toHaveBeenCalledOnce();
    start.mockClear().mockRejectedValueOnce(new AggregateError([], 'cleanup failed'));
    expect(await service.test({ force: true })).toMatchObject({ state: 'error', reason: 'runtime' });
    expect(start).toHaveBeenCalledOnce();
  });

  it('invalidates the fingerprint for model runtime, CPU and GPU driver changes but excludes transient free memory', async () => {
    const { hardware } = await fixture({ gpu: true });
    const signature = embeddingDeviceFingerprint(hardware, ['runtime-sha']);
    expect(embeddingDeviceFingerprint({ ...hardware, observedAt: new Date(0).toISOString(), availableMemoryBytes: GiB,
      gpus: hardware.gpus.map(gpu => ({ ...gpu, freeMemoryMiB: 100 })) }, ['runtime-sha'])).toBe(signature);
    expect(embeddingDeviceFingerprint({ ...hardware, cpuModel: 'Changed CPU' }, ['runtime-sha'])).not.toBe(signature);
    expect(embeddingDeviceFingerprint({ ...hardware, gpus: hardware.gpus.map(gpu => ({ ...gpu, driver: '2.0' })) }, ['runtime-sha'])).not.toBe(signature);
    expect(embeddingDeviceFingerprint(hardware, ['changed-runtime'])).not.toBe(signature);
    expect(parseEmbeddingDeviceInventory('Available devices:\n Vulkan1: GPU (4000 MiB, 3000 MiB free)')).toEqual([{ id: 'Vulkan1', name: 'GPU', totalMemoryMiB: 4000, freeMemoryMiB: 3000 }]);
  });

  it('expires cached results and rechecks changed hardware without launching a model from status', async () => {
    const { service, options, start, hardware } = await fixture({ gpu: true });
    const first = await service.test();
    hardware.gpus[0]!.driver = 'new-driver';
    const changed = new EmbeddingDeviceCapabilityService(options); services.push(changed);
    expect(await changed.status()).toMatchObject({ state: 'unchecked', reason: 'hardware_changed' });
    expect(start).toHaveBeenCalledOnce();
    hardware.gpus[0]!.driver = '1.0';
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(first.expiresAt!) + 1);
    try {
      const expired = new EmbeddingDeviceCapabilityService(options); services.push(expired);
      expect(await expired.status()).toMatchObject({ state: 'unchecked', reason: 'hardware_changed' });
      expect(start).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('treats invalid model output as a retryable error and releases the process', async () => {
    const { service, local, start } = await fixture();
    vi.mocked(local.embedImagePayload).mockResolvedValue([0, 0]);
    expect(await service.test()).toMatchObject({ state: 'error', reason: 'runtime', retryable: true });
    expect(local.close).toHaveBeenCalledOnce();
    await expect(service.ensureSupported()).rejects.toBeInstanceOf(EmbeddingDeviceUnavailableError);
    expect(start).toHaveBeenCalledOnce();
  });

  it('reports a runnable but too-slow device as unsupported instead of a runtime error', async () => {
    const { service, local } = await fixture();
    let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.mocked(local.embedTexts!).mockImplementation(async () => { clock += 2100; return [vector()]; });
    expect(await service.test()).toMatchObject({ state: 'unsupported', reason: 'latency', metrics: { textMedianMs: 2100 } });
    expect(local.close).toHaveBeenCalledOnce();
  });

  it('runs one explicit first-use test for concurrent vector requests and keeps status read-only', async () => {
    const { service, start } = await fixture();
    await service.status(); expect(start).not.toHaveBeenCalled();
    await Promise.all([service.ensureSupported(), service.ensureSupported()]);
    expect(start).toHaveBeenCalledOnce(); expect(service.snapshot().state).toBe('supported');
  });

  it('closes the old supported gate synchronously and joins one test while the host drains existing sessions', async () => {
    const { service, start, probe } = await fixture();
    await service.test();
    start.mockClear(); probe.mockClear();
    let release!: () => void;
    const preparation = new Promise<void>(resolve => { release = resolve; });
    const beforeTest = vi.fn(() => preparation);
    const work = service.test({ force: true, beforeTest });
    expect(service.snapshot()).toMatchObject({ state: 'testing', stage: '释放当前模型' });
    let gateSettled = false;
    const joined = service.ensureSupported().then(() => { gateSettled = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(beforeTest).toHaveBeenCalledOnce(); expect(probe).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled(); expect(gateSettled).toBe(false);
    release();
    expect((await work).state).toBe('supported'); await joined;
    expect(start).toHaveBeenCalledOnce(); expect(probe).toHaveBeenCalledOnce();
  });

  it('waits for host drain when cancelled during preparation and never inspects or launches a replacement', async () => {
    const { service, start, probe } = await fixture();
    let release!: () => void;
    const preparation = new Promise<void>(resolve => { release = resolve; });
    const work = service.test({ force: true, beforeTest: () => preparation });
    let cancelSettled = false;
    const cancelled = service.cancel().then(() => { cancelSettled = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(cancelSettled).toBe(false); expect(service.snapshot().state).toBe('testing');
    expect(start).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
    release(); await cancelled;
    expect(await work).toMatchObject({ state: 'unchecked', reason: 'cancelled' });
    expect(start).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  it('keeps a host drain failure as an error without starting another model', async () => {
    const { service, start, probe } = await fixture();
    expect(await service.test({ beforeTest: async () => { throw new Error('owned process drain failed'); } })).toMatchObject({ state: 'error', reason: 'runtime' });
    expect(start).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  it('waits for host drain after the preparation deadline before allowing another test', async () => {
    const { options, start, probe } = await fixture();
    const service = new EmbeddingDeviceCapabilityService({ ...options, timeoutMs: 25 }); services.push(service);
    let release!: () => void;
    const preparation = new Promise<void>(resolve => { release = resolve; });
    let settled = false;
    const work = service.test({ beforeTest: () => preparation }).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(settled).toBe(false); expect(service.snapshot().state).toBe('testing');
    expect(start).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
    release();
    expect(await work).toMatchObject({ state: 'error', reason: 'timeout' });
    expect(start).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });

  it('cancels one library waiter without poisoning the shared device test or another memory waiter', async () => {
    const { service, start, local } = await fixture();
    let finishImage!: (vector: number[]) => void;
    vi.mocked(local.embedImagePayload).mockImplementation(() => new Promise(resolve => { finishImage = resolve; }));
    const library = new AbortController();
    const cancelledLibrary = service.ensureSupported(library.signal);
    const memory = service.ensureSupported();
    await vi.waitFor(() => expect(local.embedImagePayload).toHaveBeenCalled());
    library.abort(new Error('library switched'));
    await expect(cancelledLibrary).rejects.toThrow('library switched');
    expect(service.snapshot().state).toBe('testing'); expect(service.snapshot().reason).not.toBe('cancelled');
    finishImage(vector()); await memory;
    expect(service.snapshot().state).toBe('supported'); expect(start).toHaveBeenCalledOnce(); expect(local.close).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight image request and awaits owned process release without caching a pass', async () => {
    const { service, local, root } = await fixture();
    vi.mocked(local.embedImagePayload).mockImplementation(() => new Promise(() => undefined));
    const work = service.test();
    await vi.waitFor(() => expect(local.embedImagePayload).toHaveBeenCalled());
    await service.cancel();
    expect(await work).toMatchObject({ state: 'unchecked', reason: 'cancelled' });
    expect(local.close).toHaveBeenCalledOnce();
    await expect(readFile(path.join(root, 'embedding-models/device-capability-v1.json'))).rejects.toThrow();
    await expect(service.ensureSupported()).rejects.toBeInstanceOf(EmbeddingDeviceUnavailableError);
  });

  it('times out a stuck inference and releases its temporary process', async () => {
    const { options, local } = await fixture();
    const service = new EmbeddingDeviceCapabilityService({ ...options, timeoutMs: 25 }); services.push(service);
    vi.mocked(local.embedImagePayload).mockImplementation(() => new Promise(() => undefined));
    expect(await service.test()).toMatchObject({ state: 'error', reason: 'timeout' });
    expect(local.close).toHaveBeenCalledOnce();
  });

  it('checks actual model checksums before launching the model', async () => {
    const { service, start } = await fixture();
    disk.sha.mockResolvedValue('unexpected-bytes');
    expect(await service.test()).toMatchObject({ state: 'error', reason: 'integrity' });
    expect(start).not.toHaveBeenCalled();
  });
});
