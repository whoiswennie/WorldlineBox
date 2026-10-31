import { availableParallelism } from 'node:os';
import {
  GLOBAL_EMBEDDING_SELECTION_ID, LOCAL_TEXT_EMBEDDING_MODEL, LOCAL_TEXT_EMBEDDING_MODEL_ID,
  isLocalTextEmbeddingModelId, localTextEmbeddingProfileKey, prepareGlobalEmbeddingText,
  type EmbeddingPurpose, type GlobalEmbeddingProfile,
} from '../shared/embedding/global-profile';
import { meanPoolEmbeddings, normalizeEmbedding } from '../shared/embedding/profile';
import { startLlamaEmbeddingSession, type LlamaEmbeddingSession } from './embedding-llama-session';
import type { EmbeddingServiceRecord } from './embedding-service-registry';
import { fileSha256, inspectLocalTextEmbeddingInstall, resolveLocalTextEmbeddingLayout } from './embedding-text-model-install';

export { isLocalTextEmbeddingModelId as isManagedTextEmbeddingId } from '../shared/embedding/global-profile';

/** An adapter view for the existing durable asset index. Inference uses the injected embed callback. */
export function createManagedTextEmbeddingService(id: string, userDataPath: string): (EmbeddingServiceRecord & { profileKey: string }) | null {
  if (!isLocalTextEmbeddingModelId(id)) return null;
  const status = inspectLocalTextEmbeddingInstall(userDataPath);
  return {
    id, name: LOCAL_TEXT_EMBEDDING_MODEL.name, description: 'Bundled multilingual and multimodal embedding model',
    adapter: 'openai-embeddings-v1', destination: 'loopback', baseUrl: 'http://127.0.0.1',
    modelName: id, textStatus: status.phase === 'ready' ? 'verified' : 'declared', probeFailure: null,
    dimensions: LOCAL_TEXT_EMBEDDING_MODEL.dimension, grantedLibraryIds: [], modalities: ['text'],
    maxImageEdgePx: 1024, maxImageBytes: 10 * 1024 * 1024, profileKey: localTextEmbeddingProfileKey(),
  };
}

export type GlobalEmbeddingServiceOptions = {
  userDataPath: string;
  /** Immutable app resources; weights and DLLs are read directly without a userData copy. */
  bundleDirectory?: string;
  /** Migration-only callbacks are never consulted; the bundled model is fixed. */
  getSelectionId?: () => string | null;
  loadService?: (id: string) => EmbeddingServiceRecord | null;
  readKey?: (id: string) => string | null;
  koffiPath?: string;
  /** Test seam; production uses the existing owned llama process implementation. */
  startLocalSession?: typeof startLlamaEmbeddingSession;
  /** Production device gate; metadata/profile reads never load the encoder. */
  ensureDeviceCapability?: (signal?: AbortSignal) => Promise<void>;
  devicePreference?: () => { backend?: 'cpu' | 'gpu'; deviceId?: string };
};

export class EmbeddingProfileChangedError extends Error {
  constructor() { super('The embedding model changed. Rebuild this index before using new vectors.'); this.name = 'EmbeddingProfileChangedError'; }
}

/** One bundled encoder and semantic identity for assets and companion memory. */
export class GlobalEmbeddingService {
  #session: { key: string; session: LlamaEmbeddingSession } | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #generation = 0;
  #closed = false;
  #active = new Set<AbortController>();
  #runtimeController: AbortController | null = null;
  #invalidationListeners = new Set<() => void>();
  constructor(private readonly options: GlobalEmbeddingServiceOptions) {}

  subscribeInvalidation(listener: () => void): () => void { this.#invalidationListeners.add(listener); return () => { this.#invalidationListeners.delete(listener); }; }

  async resolveProfile(selectionId = GLOBAL_EMBEDDING_SELECTION_ID): Promise<GlobalEmbeddingProfile> {
    if (selectionId !== GLOBAL_EMBEDDING_SELECTION_ID && !isLocalTextEmbeddingModelId(selectionId)) {
      throw new Error('Only the bundled EmbeddingGemma 2 model is available.');
    }
    return {
      selectionId: LOCAL_TEXT_EMBEDDING_MODEL_ID, profileKey: localTextEmbeddingProfileKey(), modelName: LOCAL_TEXT_EMBEDDING_MODEL_ID,
      dimension: LOCAL_TEXT_EMBEDDING_MODEL.dimension, source: 'local', modalities: ['text', 'image', 'audio', 'video'],
      queryPrefix: LOCAL_TEXT_EMBEDDING_MODEL.queryPrefix, documentPrefix: LOCAL_TEXT_EMBEDDING_MODEL.documentPrefix,
      contextTokens: LOCAL_TEXT_EMBEDDING_MODEL.contextTokens,
    };
  }

  async embed(texts: readonly string[], input: {
    purpose: EmbeddingPurpose;
    selectionId?: string;
    expectedProfileKey?: string;
    signal?: AbortSignal;
  }): Promise<{ profile: GlobalEmbeddingProfile; vectors: number[][] }> {
    if (this.#closed) throw new Error('Embedding service is closed.');
    if (texts.length > 512 || texts.some(text => typeof text !== 'string' || text.length > 1_000_000)) throw new RangeError('Embedding batch is too large.');
    input.signal?.throwIfAborted();
    const generation = this.#generation;
    const selection = input.selectionId ?? GLOBAL_EMBEDDING_SELECTION_ID;
    const profile = await this.resolveProfile(selection);
    if (input.expectedProfileKey && input.expectedProfileKey !== profile.profileKey) throw new EmbeddingProfileChangedError();
    const work = async (): Promise<{ profile: GlobalEmbeddingProfile; vectors: number[][] }> => {
      input.signal?.throwIfAborted();
      if (this.#closed || generation !== this.#generation || (await this.resolveProfile(selection)).profileKey !== profile.profileKey) throw new EmbeddingProfileChangedError();
      const controller = new AbortController();
      this.#active.add(controller);
      const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
      try {
        let vectors: number[][];
        if (!texts.length) vectors = [];
        else {
          const session = await this.#localSession(profile, signal);
          vectors = [];
          for (const text of texts) {
            signal.throwIfAborted();
            const chunks = await splitLocalEmbeddingText(session, profile, text, input.purpose, signal);
            const encoded: number[][] = [];
            // Keep each complete prefixed chunk inside the encoder's actual token window.
            for (const chunk of chunks) {
              const result = session.embedTexts ? (await session.embedTexts([chunk], signal))[0] : await session.embedText(chunk);
              if (!result) throw new Error('Local embedding runtime returned an empty vector.');
              encoded.push(normalizeEmbedding(result, profile.dimension));
            }
            vectors.push(meanPoolEmbeddings(encoded));
          }
        }
        signal.throwIfAborted();
        if (vectors.length !== texts.length) throw new Error('Embedding service returned an incomplete batch.');
        if (generation !== this.#generation || (await this.resolveProfile(selection)).profileKey !== profile.profileKey) throw new EmbeddingProfileChangedError();
        return { profile, vectors: vectors.map(vector => normalizeEmbedding(vector, profile.dimension)) };
      } finally { this.#active.delete(controller); }
    };
    const task = this.#queue.then(work, work);
    this.#queue = task.catch(() => undefined);
    return task;
  }

  /** Idle physical admission only: no synthetic text, vector or semantic job. */
  async prepare(input: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.#closed) throw new Error('Embedding service is closed.');
    input.signal?.throwIfAborted();
    const generation = this.#generation, profile = await this.resolveProfile();
    const work = async () => {
      input.signal?.throwIfAborted();
      if (this.#closed || generation !== this.#generation) throw new EmbeddingProfileChangedError();
      const controller = new AbortController(); this.#active.add(controller);
      // Once admitted, physical loading is shared with foreground requests.
      // Caller cancellation yields the graph lane after this same load settles;
      // only device invalidation/shutdown tears down the global session startup.
      const signal = controller.signal;
      try { await this.#localSession(profile, signal); signal.throwIfAborted(); input.signal?.throwIfAborted();
        if (this.#closed || generation !== this.#generation) throw new EmbeddingProfileChangedError();
      } finally { this.#active.delete(controller); }
    };
    const task = this.#queue.then(work, work); this.#queue = task.catch(() => undefined); return task;
  }

  async invalidate(): Promise<void> {
    this.#generation++;
    for (const listener of this.#invalidationListeners) { try { listener(); } catch { /* A cache observer cannot prevent model teardown. */ } }
    for (const controller of this.#active) controller.abort(new EmbeddingProfileChangedError());
    this.#runtimeController?.abort(new EmbeddingProfileChangedError());
    await this.#queue;
    const session = this.#session;
    this.#session = null;
    this.#runtimeController = null;
    if (session) await session.session.close();
  }

  async close(): Promise<void> { this.#closed = true; await this.invalidate(); }

  async #localSession(profile: GlobalEmbeddingProfile, signal: AbortSignal): Promise<LlamaEmbeddingSession> {
    if (this.#session?.key === profile.profileKey) return this.#session.session;
    if (this.#session) { await this.#session.session.close(); this.#session = null; }
    await this.options.ensureDeviceCapability?.(signal);
    signal.throwIfAborted();
    const layout = resolveLocalTextEmbeddingLayout(this.options.userDataPath, this.options.bundleDirectory);
    if (!layout) throw new Error('The bundled embedding model is unavailable. Repair its local files in settings.');
    if (await fileSha256(layout.corePath) !== LOCAL_TEXT_EMBEDDING_MODEL.sha256) throw new Error('The bundled embedding model failed its checksum. Repair its local files in settings.');
    signal.throwIfAborted();
    const runtimeController = new AbortController();
    this.#runtimeController = runtimeController;
    const startSession = this.options.startLocalSession ?? startLlamaEmbeddingSession;
    const preference = this.options.devicePreference?.();
    const sessionOptions = {
      executable: layout.runtimePath, files: { corePath: layout.corePath }, modelName: profile.modelName,
      contextSize: profile.contextTokens ?? 4096, signal: runtimeController.signal, koffiPath: this.options.koffiPath,
      pooling: LOCAL_TEXT_EMBEDDING_MODEL.pooling,
      threads: Math.max(1, Math.min(4, availableParallelism())),
    };
    let session: LlamaEmbeddingSession;
    const cancelStartup = () => runtimeController.abort(signal.reason);
    signal.addEventListener('abort', cancelStartup, { once: true });
    try {
      // Match the asset encoder: a GPU-capable bundled backend may offload automatically.
      // The shipped CPU build has no GPU dependency and continues to execute on the CPU.
      session = await startSession({ ...sessionOptions, gpuLayers: preference?.backend === 'cpu' ? 0 : 99,
        ...(preference?.backend === 'cpu' ? { executable: layout.cpuRuntimePath ?? layout.runtimePath } : {}),
        ...(preference?.backend === 'gpu' && preference.deviceId ? { device: preference.deviceId } : {}),
      });
    } catch (error) {
      if (signal.aborted || runtimeController.signal.aborted || error instanceof AggregateError) throw error;
      if (preference?.backend) throw new Error('已通过检测的向量运行设备未能启动，请在设置的全局模型中重新检测。', { cause: error });
      session = await startSession({ ...sessionOptions, executable: layout.cpuRuntimePath ?? layout.runtimePath, gpuLayers: 0 });
    } finally { signal.removeEventListener('abort', cancelStartup); }
    if (signal.aborted) { await session.close(); signal.throwIfAborted(); }
    this.#session = { key: profile.profileKey, session };
    return session;
  }
}

/** Use the model's own tokenizer, splitting losslessly instead of silently dropping long memories. */
export async function splitLocalEmbeddingText(
  session: Pick<LlamaEmbeddingSession, 'countTokens'>,
  profile: GlobalEmbeddingProfile,
  text: string,
  purpose: EmbeddingPurpose,
  signal?: AbortSignal,
): Promise<string[]> {
  const prepared = prepareGlobalEmbeddingText(profile, text, purpose);
  if (!session.countTokens || !profile.contextTokens) return [prepared];
  const limit = Math.max(16, profile.contextTokens - 2);
  if (await session.countTokens(prepared, signal) <= limit) return [prepared];
  const characters = Array.from(text);
  if (characters.length < 2) throw new Error('Embedding input cannot fit the model context.');
  const middle = Math.floor(characters.length / 2);
  return [
    ...await splitLocalEmbeddingText(session, profile, characters.slice(0, middle).join(''), purpose, signal),
    ...await splitLocalEmbeddingText(session, profile, characters.slice(middle).join(''), purpose, signal),
  ];
}
