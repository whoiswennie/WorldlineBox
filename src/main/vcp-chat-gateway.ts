import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { VcpMemoryPluginConfiguration } from './vcp-memory/contracts';
import { validateCompanionNativeMemoryPrompt, type CompanionNativeMemoryPrompt } from '../shared/companion-native-memory-prompt';

type Generate = (context: { system: string; user: string }, signal: AbortSignal,
  work?: { ownerId?: string; priority: 'foreground' | 'background'; nativePrompt?: CompanionNativeMemoryPrompt }) => Promise<string>;
type OwnerRoute = { ownerId: string; token: string; generate: Generate; active: Set<AbortController> };

/** Converts VCP's internal chat call to the application's global provider, with no credential copy. */
export class VcpChatGateway {
  private server?: Server;
  private pending?: Promise<void>;
  private port?: number;
  private readonly token = randomBytes(32).toString('hex');
  private readonly active = new Set<AbortController>();
  private sourceCredentialDigest?: string;
  private connectionGeneration = 0;
  private readonly routes = new Map<string, OwnerRoute>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly generate?: Generate) {}
  /** The caller closes over a trusted immutable resolved config, never a last
   * owner variable. Only this local capability token selects its provider. */
  async registerOwnerRoute(input: { ownerId: string; semanticProfile: unknown; credential: string; generate: Generate }): Promise<{
    chat: NonNullable<VcpMemoryPluginConfiguration['chat']>; dispose(): Promise<void>;
  }> {
    if (this.closed || !input.ownerId.trim() || input.ownerId.length > 100 || this.routes.size >= 4) throw new Error('Owner generation routes are unavailable.');
    await this.start();
    if (this.closed || this.routes.size >= 4) throw new Error('Owner generation routes are full.');
    const token = randomBytes(32).toString('hex'), route: OwnerRoute = { ownerId: input.ownerId, token, generate: input.generate, active: new Set() };
    this.routes.set(token, route);
    const generation = ++this.connectionGeneration;
    return { chat: { baseUrl: `http://127.0.0.1:${this.port}`, model: 'owner-chat', apiKey: token,
      sourceSignature: createHash('sha256').update(JSON.stringify(input.semanticProfile)).digest('hex'), connectionGeneration: generation },
      dispose: async () => { if (this.routes.get(token) !== route) return; this.routes.delete(token); for (const controller of route.active) controller.abort(); } };
  }
  async configuration(source?: { semanticProfile: unknown; credential: string }) {
    await this.start();
    if (source) {
      const digest = createHash('sha256').update(source.credential).digest('hex');
      if (digest !== this.sourceCredentialDigest) { this.sourceCredentialDigest = digest; this.connectionGeneration++; }
    }
    return { baseUrl: `http://127.0.0.1:${this.port}`, model: 'global-chat', apiKey: this.token,
      ...(source ? { sourceSignature: createHash('sha256').update(JSON.stringify(source.semanticProfile)).digest('hex'),
        connectionGeneration: this.connectionGeneration } : {}) };
  }
  private start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Chat gateway is closed.'));
    return this.pending ??= new Promise((resolve, reject) => {
      const server = createServer(async (request, response) => {
        const controller = new AbortController(); this.active.add(controller);
        let route: OwnerRoute | undefined;
        request.on('aborted', () => controller.abort());
        response.on('close', () => { if (!response.writableEnded) controller.abort(); });
        try {
          const authorization = request.headers.authorization ?? '';
          const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
          route = this.routes.get(token);
          const auth = Buffer.from(authorization), expected = Buffer.from(`Bearer ${route?.token ?? this.token}`);
          if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { response.writeHead(401).end(); return; }
          const generate = route?.generate ?? this.generate;
          if (!generate) { response.writeHead(401).end(); return; }
          route?.active.add(controller);
          if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
          let size = 0; const chunks: Buffer[] = [];
          for await (const chunk of request) {
            size += Buffer.byteLength(chunk as Uint8Array);
            if (size > 2 * 1024 * 1024) { response.writeHead(413).end(); return; }
            chunks.push(Buffer.from(chunk as Uint8Array));
          }
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const messages = body && typeof body === 'object' && 'messages' in body ? body.messages : undefined;
          // Original AIMemo sends one user prompt; TimeLine sends system + user.
          // Both stay inside the authenticated loopback transport.
          if (!Array.isArray(messages) || messages.length < 1 || messages.length > 2) throw new Error('Invalid VCP chat request.');
          const system = messages.length === 2 ? messages[0] as { role?: string; content?: unknown } : undefined;
          const user = messages.at(-1) as { role?: string; content?: unknown } | undefined;
          if (system && (system.role !== 'system' || typeof system.content !== 'string')
            || user?.role !== 'user' || typeof user.content !== 'string') throw new Error('Invalid VCP prompts.');
          const nativeValue = body && typeof body === 'object' && 'nativePrompt' in body ? body.nativePrompt : undefined;
          if (nativeValue !== undefined && (!route || !system)) throw new Error('Native prompt metadata requires an authenticated owner timeline request.');
          const nativePrompt = nativeValue !== undefined ? validateCompanionNativeMemoryPrompt(nativeValue, route!.ownerId, String(system!.content)) : undefined;
          controller.signal.throwIfAborted();
          if (route && this.routes.get(route.token) !== route) throw new Error('Owner route was retired.');
          // AIMemo's prepared user template is opaque transport input. The
          // owner's live asset resolver supplies its current system guidance.
          const content = await generate({ system: typeof system?.content === 'string' ? system.content : '', user: user.content }, controller.signal,
            { ownerId: route?.ownerId, priority: system ? 'background' : 'foreground', ...(nativePrompt ? { nativePrompt } : {}) });
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
        } catch {
          if (!response.headersSent) response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: '全局聊天模型暂不可用。' } }));
        } finally { this.active.delete(controller); route?.active.delete(controller); }
      });
      this.server = server; server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('Chat gateway could not start.'));
        this.port = address.port; resolve();
      });
    });
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= this.closeOperation();
  }
  private async closeOperation(): Promise<void> {
    for (const controller of this.active) controller.abort();
    this.routes.clear();
    await this.pending?.catch(() => undefined);
    if (!this.server) return;
    const server = this.server; this.server = undefined;
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    this.pending = undefined; this.port = undefined;
  }
}
