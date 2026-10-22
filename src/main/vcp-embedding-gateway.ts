import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';

type Profile = { profileKey: string; modelName: string; dimension: number };
type EmbeddingResult = { profile: Profile; vectors: number[][] };
export interface VcpEmbeddingProvider {
  /** Metadata only. Without authoritative profile resolution the bridge cannot safely cache. */
  resolveProfile?(selectionId?: string): Promise<Profile>;
  subscribeInvalidation?(listener: () => void): () => void;
  embed(texts: readonly string[], options: { purpose: 'query' | 'document'; selectionId?: string; signal?: AbortSignal }): Promise<{
    profile: Profile;
    vectors: number[][];
  }>;
}
type Fill = { controller: AbortController; consumers: Set<symbol>; promise: Promise<number[][]> };
class ProfileChanged extends Error {}
function cacheLimit(value: number | undefined, maximum: number): number {
  // Invalid internal overrides must not turn comparisons against a bound into NaN.
  return value === undefined ? maximum : Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;
}

/** Original VCP HTTP client calls this loopback bridge; model credentials never reach VCP. */
export class VcpEmbeddingGateway {
  private server?: Server;
  private starting?: Promise<void>;
  private port?: number;
  private readonly token = randomBytes(32).toString('hex');
  private readonly requests = new Set<AbortController>();
  private readonly cache = new Map<string, { vector: Float64Array; bytes: number }>();
  private readonly pending = new Map<string, { fill: Fill; index: number }>();
  private cacheBytes = 0;
  private generation = 0;
  private closed = false;
  private profileIdentity?: string;
  private readonly unsubscribe?: () => void;
  private readonly maxCachedVectors: number;
  private readonly maxCacheBytes: number;
  constructor(private readonly provider: VcpEmbeddingProvider, limits: { maxCachedVectors?: number; maxCacheBytes?: number } = {}) {
    this.maxCachedVectors = cacheLimit(limits.maxCachedVectors, 4096);
    this.maxCacheBytes = cacheLimit(limits.maxCacheBytes, 32 * 1024 * 1024);
    this.unsubscribe = provider.subscribeInvalidation?.(() => this.invalidate());
  }

  /** No text or key material is exposed; useful for checking the actual resource bound. */
  cacheSnapshot(): { vectors: number; bytes: number; inflight: number } { return { vectors: this.cache.size, bytes: this.cacheBytes, inflight: this.pending.size }; }
  invalidate(): void {
    this.generation++; this.cache.clear(); this.cacheBytes = 0; this.profileIdentity = undefined;
    for (const { fill } of this.pending.values()) fill.controller.abort(new ProfileChanged('Embedding cache invalidated.'));
    this.pending.clear();
  }
  private remember(key: string, vector: number[]): void {
    // Float64 retains the exact provider JS numbers. Budget includes conservative
    // per-entry Map/key/object overhead in addition to the real external buffer.
    const bytes = vector.length * 8 + 512;
    if (!this.maxCachedVectors || bytes > this.maxCacheBytes) return;
    const previous = this.cache.get(key); if (previous) { this.cache.delete(key); this.cacheBytes -= previous.bytes; }
    while (this.cache.size >= this.maxCachedVectors || this.cacheBytes + bytes > this.maxCacheBytes) {
      const oldest = this.cache.keys().next().value; if (!oldest) break;
      this.cacheBytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
    }
    this.cache.set(key, { vector: new Float64Array(vector), bytes }); this.cacheBytes += bytes;
  }
  private validate(result: EmbeddingResult, count: number): void {
    if (!Number.isSafeInteger(result.profile.dimension) || result.profile.dimension < 1 || result.vectors.length !== count
      || result.vectors.some(vector => vector.length !== result.profile.dimension || vector.some(value => !Number.isFinite(value)))) throw new Error('Invalid embedding output.');
  }
  private async documents(texts: string[], selectionId: string, expected: string, dimension: number, signal: AbortSignal): Promise<EmbeddingResult> {
    if (!this.provider.resolveProfile) return this.provider.embed(texts, { purpose: 'document', selectionId, signal });
    signal.throwIfAborted();
    const profile = await this.provider.resolveProfile(selectionId);
    if (profile.profileKey !== expected || profile.dimension !== dimension) { this.invalidate(); throw new ProfileChanged(); }
    const identity = JSON.stringify([profile.profileKey, profile.dimension, profile.modelName]);
    if (this.profileIdentity && this.profileIdentity !== identity) this.invalidate();
    this.profileIdentity = identity;
    const generation = this.generation, consumer = Symbol(), fills = new Set<Fill>();
    const keys = texts.map(text => createHash('sha256').update(JSON.stringify([selectionId, profile.profileKey, 'document', profile.dimension, text])).digest('hex'));
    const ready = new Map<string, number[]>(), missing = new Map<string, string>();
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!, cached = this.cache.get(key);
      if (cached) { this.cache.delete(key); this.cache.set(key, cached); ready.set(key, Array.from(cached.vector)); }
      else {
        const entry = this.pending.get(key);
        if (!entry || entry.fill.controller.signal.aborted) { this.pending.delete(key); missing.set(key, texts[index]!); }
      }
    }
    if (missing.size) {
      const entries = [...missing], controller = new AbortController();
      const fill: Fill = { controller, consumers: new Set(), promise: Promise.resolve([]) };
      fill.promise = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        const result = await this.provider.embed(entries.map(([, text]) => text), { purpose: 'document', selectionId, signal: controller.signal });
        this.validate(result, entries.length); controller.signal.throwIfAborted();
        const current = await this.provider.resolveProfile!(selectionId);
        controller.signal.throwIfAborted();
        if (this.closed || generation !== this.generation || current.profileKey !== profile.profileKey || current.dimension !== profile.dimension
          || result.profile.profileKey !== profile.profileKey || result.profile.dimension !== profile.dimension) throw new ProfileChanged();
        const vectors = result.vectors.map(vector => vector.slice());
        entries.forEach(([key], index) => this.remember(key, vectors[index]!)); return vectors;
      }).finally(() => { for (const [key] of entries) if (this.pending.get(key)?.fill === fill) this.pending.delete(key); });
      // The operation may fail before a caller starts awaiting its individual rows.
      void fill.promise.catch(() => undefined);
      entries.forEach(([key], index) => this.pending.set(key, { fill, index }));
    }
    const work = Promise.all(keys.map(key => {
      if (ready.has(key)) return ready.get(key)!;
      const entry = this.pending.get(key)!; fills.add(entry.fill); entry.fill.consumers.add(consumer);
      return entry.fill.promise.then(vectors => vectors[entry.index]!.slice());
    }));
    let abort: (() => void) | undefined;
    try {
      const vectors = await Promise.race([work, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new Error('Embedding request cancelled.'));
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      })]);
      const current = await this.provider.resolveProfile(selectionId);
      signal.throwIfAborted();
      if (this.closed || generation !== this.generation || current.profileKey !== profile.profileKey || current.dimension !== profile.dimension) throw new ProfileChanged();
      return { profile, vectors };
    } catch (error) {
      if (error instanceof ProfileChanged) this.invalidate();
      throw error;
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
      for (const fill of fills) { fill.consumers.delete(consumer); if (!fill.consumers.size) fill.controller.abort(); }
    }
  }

  async configuration(selectionId: string, profile: { profileKey: string; modelName: string; dimension: number }) {
    await this.start();
    const identity = Buffer.from(JSON.stringify({ selectionId, profileKey: profile.profileKey, dimension: profile.dimension }), 'utf8').toString('base64url');
    const base = `http://127.0.0.1:${this.port}/${identity}`;
    return { baseUrl: `${base}/document`, queryBaseUrl: `${base}/query`, model: profile.modelName,
      dimension: profile.dimension, modelSignature: profile.profileKey, apiKey: this.token };
  }

  private start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Embedding gateway is closed.'));
    return this.starting ??= new Promise((resolve, reject) => {
      const server = createServer(async (request, response) => {
        const controller = new AbortController();
        this.requests.add(controller);
        request.on('aborted', () => controller.abort());
        response.on('close', () => { if (!response.writableEnded) controller.abort(); });
        try {
          const auth = Buffer.from(request.headers.authorization ?? '');
          const expected = Buffer.from(`Bearer ${this.token}`);
          if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
            response.writeHead(401).end(); return;
          }
          const route = /^\/([a-zA-Z0-9_-]+)\/(query|document)\/v1\/embeddings$/.exec(request.url ?? '');
          if (request.method !== 'POST' || !route) { response.writeHead(404).end(); return; }
          const target: unknown = JSON.parse(Buffer.from(route[1]!, 'base64url').toString('utf8'));
          if (!target || typeof target !== 'object' || !('selectionId' in target) || typeof target.selectionId !== 'string'
            || !('profileKey' in target) || typeof target.profileKey !== 'string'
            || !('dimension' in target) || typeof target.dimension !== 'number' || !Number.isSafeInteger(target.dimension) || target.dimension < 1) throw new Error('Invalid profile.');
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of request) {
            size += Buffer.byteLength(chunk as Uint8Array);
            if (size > 4 * 1024 * 1024) { response.writeHead(413).end(); return; }
            chunks.push(Buffer.from(chunk as Uint8Array));
          }
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const input = body && typeof body === 'object' && 'input' in body ? body.input : undefined;
          const texts = typeof input === 'string' ? [input] : input;
          if (!Array.isArray(texts) || !texts.length || texts.length > 256 || texts.some(text => typeof text !== 'string')) throw new Error('Invalid embedding input.');
          const result = route[2] === 'document' ? await this.documents(texts as string[], target.selectionId, target.profileKey, target.dimension, controller.signal)
            : await this.provider.embed(texts as string[], { purpose: 'query', selectionId: target.selectionId, signal: controller.signal });
          if (result.profile.profileKey !== target.profileKey || result.profile.dimension !== target.dimension) {
            this.invalidate();
            response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Embedding profile changed; rebuild this store.' } })); return;
          }
          this.validate(result, texts.length); controller.signal.throwIfAborted();
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', model: result.profile.modelName,
            data: result.vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })) }));
        } catch (error) {
          if (!response.headersSent) response.writeHead(error instanceof ProfileChanged ? 409 : 503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: error instanceof ProfileChanged ? 'Embedding profile changed; rebuild this store.' : '全局向量模型暂不可用。' } }));
        } finally { this.requests.delete(controller); }
      });
      this.server = server;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('Embedding gateway could not start.')); return; }
        this.port = address.port; resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true; this.unsubscribe?.(); this.invalidate();
    for (const controller of this.requests) controller.abort();
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    this.starting = undefined; this.port = undefined;
  }
}
