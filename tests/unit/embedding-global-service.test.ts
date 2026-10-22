import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalEmbeddingService, EmbeddingProfileChangedError, splitLocalEmbeddingText } from '../../src/main/embedding-global-service';
import { LOCAL_TEXT_EMBEDDING_MODEL, LOCAL_TEXT_EMBEDDING_MODEL_ID, prepareGlobalEmbeddingText } from '../../src/shared/embedding/global-profile';
import { embeddingProfileKey } from '../../src/shared/embedding/profile';
import type { LlamaEmbeddingSession } from '../../src/main/embedding-llama-session';

const disk = vi.hoisted(() => ({ resolveLayout: vi.fn(), sha: vi.fn() }));
vi.mock('../../src/main/embedding-text-model-install', () => ({
  resolveLocalTextEmbeddingLayout: disk.resolveLayout, fileSha256: disk.sha, inspectLocalTextEmbeddingInstall: vi.fn(),
}));
const vector = () => [3, 4, ...Array<number>(766).fill(0)];
function session(overrides: Partial<LlamaEmbeddingSession> = {}): LlamaEmbeddingSession {
  return { embedText: vi.fn(async () => vector()), embedTexts: vi.fn(async () => [vector()]),
    embedImage: vi.fn(), embedImagePayload: vi.fn(), embedVideoPayload: vi.fn(), embedAudio: vi.fn(), embedAudioPayload: vi.fn(),
    close: vi.fn(async () => undefined), ...overrides };
}
beforeEach(() => {
  disk.resolveLayout.mockReset().mockReturnValue({ corePath: 'bundled/core.gguf', runtimePath: 'bundled/runtime-cpu/llama-server.exe' });
  disk.sha.mockReset().mockResolvedValue(LOCAL_TEXT_EMBEDDING_MODEL.sha256);
});

describe('one bundled global embedding encoder', () => {
  it('invalidates subscribed derived vector caches immediately and permits observers to detach', async () => {
    const encoder = new GlobalEmbeddingService({ userDataPath: '.' }), notify = vi.fn();
    const detach = encoder.subscribeInvalidation(notify);
    await encoder.invalidate(); expect(notify).toHaveBeenCalledOnce();
    detach(); await encoder.invalidate(); await encoder.close(); expect(notify).toHaveBeenCalledOnce();
  });
  it('keeps metadata readable but never starts the local encoder when the device gate refuses it', async () => {
    const startLocalSession = vi.fn(), ensureDeviceCapability = vi.fn(async () => { throw new Error('当前设备内存不足，向量能力已暂停。'); });
    const encoder = new GlobalEmbeddingService({ userDataPath: '.', startLocalSession, ensureDeviceCapability });
    expect((await encoder.resolveProfile()).dimension).toBe(768);
    expect(ensureDeviceCapability).not.toHaveBeenCalled();
    await expect(encoder.embed(['需要索引的真实记忆'], { purpose: 'document' })).rejects.toThrow('内存不足');
    expect(startLocalSession).not.toHaveBeenCalled();
    expect(disk.sha).not.toHaveBeenCalled();
    await encoder.close();
  });

  it('checks the loading budget once for a resident encoder and checks again after its release', async () => {
    const ensureDeviceCapability = vi.fn(async () => undefined), local = session();
    const encoder = new GlobalEmbeddingService({ userDataPath: '.', startLocalSession: async () => local, ensureDeviceCapability });
    await encoder.embed(['第一篇'], { purpose: 'document' });
    await encoder.embed(['第二篇'], { purpose: 'document' });
    expect(ensureDeviceCapability).toHaveBeenCalledOnce();
    await encoder.invalidate();
    ensureDeviceCapability.mockRejectedValueOnce(new Error('重新加载前设备受限'));
    await expect(encoder.embed(['第三篇'], { purpose: 'document' })).rejects.toThrow('设备受限');
    expect(ensureDeviceCapability).toHaveBeenCalledTimes(2);
    await encoder.close();
  });

  it.each(['cpu', 'gpu'] as const)('uses the %s backend that passed detection instead of a stale automatic device choice', async backend => {
    const startLocalSession = vi.fn(async () => session());
    disk.resolveLayout.mockReturnValue({ corePath: 'readonly/core.gguf', runtimePath: 'readonly/runtime-vulkan/llama-server.exe', cpuRuntimePath: 'readonly/runtime-cpu/llama-server.exe' });
    const encoder = new GlobalEmbeddingService({ userDataPath: '.', startLocalSession,
      ensureDeviceCapability: async () => undefined, devicePreference: () => ({ backend, ...(backend === 'gpu' ? { deviceId: 'Vulkan1' } : {}) }) });
    await encoder.embed(['同一语义空间'], { purpose: 'document' });
    expect(startLocalSession).toHaveBeenCalledWith(expect.objectContaining(backend === 'gpu'
      ? { gpuLayers: 99, device: 'Vulkan1', executable: 'readonly/runtime-vulkan/llama-server.exe' }
      : { gpuLayers: 0, executable: 'readonly/runtime-cpu/llama-server.exe' }));
    await encoder.close();
  });

  it('does not fall back to an unmeasured CPU when the tested GPU can no longer start', async () => {
    const startLocalSession = vi.fn(async () => { throw new Error('GPU unavailable'); });
    const encoder = new GlobalEmbeddingService({ userDataPath: '.', startLocalSession,
      ensureDeviceCapability: async () => undefined, devicePreference: () => ({ backend: 'gpu', deviceId: 'Vulkan0' }) });
    await expect(encoder.embed(['真实记忆'], { purpose: 'document' })).rejects.toThrow('重新检测');
    expect(startLocalSession).toHaveBeenCalledOnce();
    await encoder.close();
  });
  it('resolves the same fixed multimodal profile without consulting legacy selection, external services or keys', async () => {
    const getSelectionId = vi.fn(() => 'svc_external'), loadService = vi.fn(() => null), readKey = vi.fn(() => 'never-read-secret');
    const encoder = new GlobalEmbeddingService({ userDataPath: '.', getSelectionId, loadService, readKey });
    const profile = await encoder.resolveProfile();
    expect(profile).toMatchObject({ selectionId: LOCAL_TEXT_EMBEDDING_MODEL_ID, modelName: LOCAL_TEXT_EMBEDDING_MODEL_ID,
      source: 'local', dimension: 768, modalities: ['text', 'image', 'audio', 'video'], profileKey: embeddingProfileKey('Q4_K_XL') });
    expect(await encoder.resolveProfile(LOCAL_TEXT_EMBEDDING_MODEL_ID)).toEqual(profile);
    expect(getSelectionId).not.toHaveBeenCalled(); expect(loadService).not.toHaveBeenCalled(); expect(readKey).not.toHaveBeenCalled();
    await encoder.close();
  });

  it('rejects every external or alternate model and never silently switches semantic spaces', async () => {
    const startLocalSession = vi.fn(), encoder = new GlobalEmbeddingService({ userDataPath: '.', startLocalSession });
    for (const id of ['svc_abcdefgh', 'embeddinggemma-2-balanced', 'qwen', '']) {
      await expect(encoder.resolveProfile(id)).rejects.toThrow(/only the bundled/i);
    }
    await expect(encoder.embed(['memory'], { purpose: 'document', expectedProfileKey: 'different-model-same-dimension' }))
      .rejects.toBeInstanceOf(EmbeddingProfileChangedError);
    expect(startLocalSession).not.toHaveBeenCalled();
    await encoder.close();
  });

  it('encodes query and document prefixes with the same verified core and normalized 768-dimensional vectors', async () => {
    const local = session(), startLocalSession = vi.fn(async () => local);
    const encoder = new GlobalEmbeddingService({ userDataPath: '.', startLocalSession });
    const profile = await encoder.resolveProfile();
    expect((await encoder.embed(['生日'], { purpose: 'document', expectedProfileKey: profile.profileKey })).vectors[0])
      .toEqual([0.6, 0.8, ...Array<number>(766).fill(0)]);
    await encoder.embed(['birthday'], { purpose: 'query' });
    expect(local.embedTexts).toHaveBeenNthCalledWith(1, ['title: none | text: 生日'], expect.any(AbortSignal));
    expect(local.embedTexts).toHaveBeenNthCalledWith(2, ['task: search result | query: birthday'], expect.any(AbortSignal));
    expect(startLocalSession).toHaveBeenCalledOnce();
    expect(startLocalSession).toHaveBeenCalledWith(expect.objectContaining({ files: { corePath: 'bundled/core.gguf' },
      gpuLayers: 99, pooling: 'mean', contextSize: 8192, modelName: LOCAL_TEXT_EMBEDDING_MODEL_ID }));
    await encoder.close(); expect(local.close).toHaveBeenCalledOnce();
  });

  it('refuses missing or modified bundled weights before spawning inference and requests local repair', async () => {
    const startLocalSession = vi.fn(), encoder = new GlobalEmbeddingService({ userDataPath: '.', startLocalSession });
    disk.resolveLayout.mockReturnValue(null);
    await expect(encoder.embed(['memory'], { purpose: 'document' })).rejects.toThrow(/repair/i);
    disk.resolveLayout.mockReturnValue({ corePath: 'changed.gguf', runtimePath: 'runtime.exe' }); disk.sha.mockResolvedValue('changed-sha');
    await expect(encoder.embed(['memory'], { purpose: 'document' })).rejects.toThrow(/checksum/i);
    expect(startLocalSession).not.toHaveBeenCalled(); await encoder.close();
  });

  it('falls back to the same local weights on the CPU when automatic GPU startup is unavailable', async () => {
    disk.resolveLayout.mockReturnValue({ corePath: 'readonly/core.gguf', runtimePath: 'readonly/runtime-vulkan/llama-server.exe', cpuRuntimePath: 'readonly/runtime-cpu/llama-server.exe' });
    const local = session(), startLocalSession = vi.fn().mockRejectedValueOnce(new Error('GPU unavailable')).mockResolvedValueOnce(local);
    const encoder = new GlobalEmbeddingService({ userDataPath: '.', bundleDirectory: 'readonly', startLocalSession });
    await encoder.embed(['local memory'], { purpose: 'document' });
    expect(startLocalSession.mock.calls.map(([options]) => options.gpuLayers)).toEqual([99, 0]);
    expect(startLocalSession.mock.calls.map(([options]) => options.executable)).toEqual(['readonly/runtime-vulkan/llama-server.exe', 'readonly/runtime-cpu/llama-server.exe']);
    expect(disk.resolveLayout).toHaveBeenCalledWith('.', 'readonly');
    expect(startLocalSession.mock.calls[0]?.[0].files).toEqual(startLocalSession.mock.calls[1]?.[0].files);
    await encoder.close();
  });

  it.each([Array<number>(768).fill(0), [1, 0], [NaN, ...Array<number>(767).fill(0)]].map(invalid => ({ invalid })))(
    'rejects invalid vectors without selecting another provider %#', async ({ invalid }) => {
      const local = session({ embedTexts: vi.fn(async () => [invalid]) });
      const encoder = new GlobalEmbeddingService({ userDataPath: '.', startLocalSession: async () => local });
      await expect(encoder.embed(['memory'], { purpose: 'document' })).rejects.toThrow(/norm is zero|does not match|non-finite/i);
      await encoder.close();
    });

  it('never publishes an in-flight vector after model files or runtime have been invalidated', async () => {
    let complete: ((vectors: number[][]) => void) | undefined;
    const local = session({ embedTexts: vi.fn(() => new Promise<number[][]>(resolve => { complete = resolve; })) });
    const encoder = new GlobalEmbeddingService({ userDataPath: '.', startLocalSession: async () => local });
    const work = encoder.embed(['evidence'], { purpose: 'document' });
    const failure = expect(work).rejects.toBeInstanceOf(EmbeddingProfileChangedError);
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    const invalidating = encoder.invalidate(); complete!([vector()]);
    await failure; await invalidating; expect(local.close).toHaveBeenCalledOnce(); await encoder.close();
  });

  it('splits long inputs with the actual tokenizer while preserving every Unicode code point', async () => {
    const encoder = new GlobalEmbeddingService({ userDataPath: '.' });
    const profile = { ...await encoder.resolveProfile(), contextTokens: 32 };
    const input = '下雨🌧️后在图书馆归还雨伞。'.repeat(12);
    const countTokens = vi.fn(async (text: string) => Array.from(text).length + 2);
    const chunks = await splitLocalEmbeddingText({ countTokens }, profile, input, 'document');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(text => text.slice(profile.documentPrefix.length)).join('')).toBe(input);
    for (const chunk of chunks) expect(await countTokens(chunk)).toBeLessThanOrEqual(30);
    expect(prepareGlobalEmbeddingText(profile, '生日', 'query')).toBe(`${profile.queryPrefix}生日`);
    await encoder.close();
  });
});
