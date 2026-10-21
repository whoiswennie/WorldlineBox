import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export interface VcpEmbeddingProvider {
  embed(texts: readonly string[], options: { purpose: 'query' | 'document'; selectionId?: string; signal?: AbortSignal }): Promise<{
    profile: { profileKey: string; modelName: string; dimension: number };
    vectors: number[][];
  }>;
}

/** Original VCP HTTP client calls this loopback bridge; model credentials never reach VCP. */
export class VcpEmbeddingGateway {
  private server?: Server;
  private starting?: Promise<void>;
  private port?: number;
  private readonly token = randomBytes(32).toString('hex');
  private readonly requests = new Set<AbortController>();
  constructor(private readonly provider: VcpEmbeddingProvider) {}

  async configuration(selectionId: string, profile: { profileKey: string; modelName: string; dimension: number }) {
    await this.start();
    const identity = Buffer.from(JSON.stringify({ selectionId, profileKey: profile.profileKey }), 'utf8').toString('base64url');
    const base = `http://127.0.0.1:${this.port}/${identity}`;
    return { baseUrl: `${base}/document`, queryBaseUrl: `${base}/query`, model: profile.modelName,
      dimension: profile.dimension, modelSignature: profile.profileKey, apiKey: this.token };
  }

  private start(): Promise<void> {
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
            || !('profileKey' in target) || typeof target.profileKey !== 'string') throw new Error('Invalid profile.');
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
          const result = await this.provider.embed(texts as string[], { purpose: route[2] as 'query' | 'document', selectionId: target.selectionId, signal: controller.signal });
          if (result.profile.profileKey !== target.profileKey) {
            response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Embedding profile changed; rebuild this store.' } })); return;
          }
          if (result.vectors.length !== texts.length || result.vectors.some(vector => vector.length !== result.profile.dimension || vector.some(value => !Number.isFinite(value)))) throw new Error('Invalid embedding output.');
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', model: result.profile.modelName,
            data: result.vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })) }));
        } catch {
          if (!response.headersSent) response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: '全局向量模型暂不可用。' } }));
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
    for (const controller of this.requests) controller.abort();
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    this.starting = undefined; this.port = undefined;
  }
}
