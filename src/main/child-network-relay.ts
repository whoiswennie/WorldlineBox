import { randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Duplex } from 'node:stream';

type Route = (destination: string) => Promise<string>;
const HOP_HEADERS = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'x-worldlinebox-pinned-origin', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function forwardHeaders(request: IncomingMessage): http.OutgoingHttpHeaders {
  const skip = new Set([...HOP_HEADERS, ...(request.headers.connection ?? '').split(',').map(value => value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(request.headers).filter(([name]) => !skip.has(name)));
}

/**
 * Stable private proxy endpoint for managed subprocesses, whose environments
 * cannot be changed once running. Every new request resolves the latest app
 * policy. A policy change tears down old tunnels so clients reconnect through
 * the new route. This never changes Windows or another application's proxy.
 */
export class ChildNetworkRelay {
  readonly #authorization = `Basic ${Buffer.from(`worldlinebox:${randomBytes(32).toString('hex')}`).toString('base64')}`;
  readonly #sockets = new Set<Duplex>();
  readonly #server = http.createServer((request, response) => { void this.#forward(request, response); });
  #starting: Promise<string> | undefined;
  #closed = false;
  #revision = 0;

  constructor(private readonly resolveRoute: Route) {
    this.#server.on('connection', socket => this.#track(socket));
    this.#server.on('error', () => undefined);
    this.#server.on('connect', (request, socket, head) => { void this.#connect(request, socket, head); });
    // Malformed client input is an isolated request failure, never an uncaught
    // Main-process exception or a reason to relax TLS validation upstream.
    this.#server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
    this.#server.requestTimeout = 120_000;
    this.#server.headersTimeout = 15_000;
  }

  async endpoint(): Promise<string> {
    if (this.#closed) throw new Error('Managed process network relay is closed.');
    return this.#starting ??= new Promise<string>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', () => {
        this.#server.off('error', reject);
        const address = this.#server.address();
        if (!address || typeof address === 'string') { reject(new Error('Managed process network relay could not bind.')); return; }
        const credentials = Buffer.from(this.#authorization.slice(6), 'base64').toString('utf8');
        resolve(`http://${credentials}@127.0.0.1:${address.port}`);
      });
    });
  }

  async environment(base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    const endpoint = await this.endpoint();
    const env = { ...base };
    for (const key of Object.keys(env)) if (/^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|PROXY|NO_PROXY|npm_config_(?:proxy|https_proxy|noproxy))$/i.test(key)) delete env[key];
    return { ...env, HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint, WORLDLINEBOX_CHILD_NETWORK_RELAY: endpoint,
      npm_config_proxy: endpoint, npm_config_https_proxy: endpoint,
      NO_PROXY: 'localhost,127.0.0.1,::1', npm_config_noproxy: 'localhost,127.0.0.1,::1', NODE_USE_ENV_PROXY: '1' };
  }

  policyChanged(): void {
    this.#revision += 1;
    for (const socket of this.#sockets) socket.destroy();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.policyChanged();
    await this.#starting?.catch(() => undefined);
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) => this.#server.close(error => error ? reject(error) : resolve()));
  }

  #track<T extends Duplex>(socket: T): T {
    this.#sockets.add(socket);
    socket.once('close', () => this.#sockets.delete(socket));
    socket.on('error', () => undefined);
    return socket;
  }

  #authenticated(request: IncomingMessage): boolean {
    const supplied = Buffer.from(request.headers['proxy-authorization'] ?? '');
    const expected = Buffer.from(this.#authorization);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  async #route(destination: string, revision: number): Promise<URL | undefined> {
    const route = await this.resolveRoute(destination);
    if (this.#closed || revision !== this.#revision) throw new Error('Network policy changed.');
    if (route === 'DIRECT') return;
    const proxy = new URL(route);
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password) throw new Error('Managed process proxy route must use HTTP(S).');
    return proxy;
  }

  async #forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#authenticated(request)) {
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="WorldlineBox"', connection: 'close' }); response.end(); return;
    }
    let target: URL;
    try {
      target = new URL(request.url ?? '');
      if (target.protocol !== 'http:' || target.username || target.password || target.hash) throw new Error('Invalid target.');
    } catch { response.writeHead(400, { connection: 'close' }); response.end('Invalid proxy target.'); return; }
    try {
      const proxy = await this.#route(target.href, this.#revision);
      const transport = proxy?.protocol === 'https:' ? https : http;
      const outgoing = transport.request({
        protocol: proxy?.protocol ?? target.protocol, hostname: (proxy?.hostname ?? target.hostname).replace(/^\[|\]$/g, ''),
        port: proxy ? proxy.port || (proxy.protocol === 'https:' ? 443 : 80) : target.port || 80,
        path: proxy ? target.href : `${target.pathname}${target.search}`,
        method: request.method, headers: { ...forwardHeaders(request), host: target.host },
        // The relay already resolved policy. Global Node agents must not route
        // this hop back through the relay or apply an upstream proxy twice.
        agent: false,
      });
      outgoing.on('socket', socket => this.#track(socket));
      outgoing.setTimeout(30_000, () => outgoing.destroy(new Error('Proxy upstream timed out.')));
      request.once('aborted', () => outgoing.destroy());
      response.once('close', () => { if (!response.writableFinished) outgoing.destroy(); });
      outgoing.on('response', upstream => {
        outgoing.setTimeout(0);
        response.writeHead(upstream.statusCode ?? 502, forwardHeaders(upstream));
        upstream.once('error', () => response.destroy());
        upstream.pipe(response);
      });
      outgoing.once('error', () => {
        if (response.headersSent) response.destroy();
        else { response.writeHead(502, { connection: 'close' }); response.end('Global proxy connection failed.'); }
      });
      request.pipe(outgoing);
    } catch { response.writeHead(503, { connection: 'close', 'retry-after': '1' }); response.end('Global network policy is changing or unavailable.'); }
  }

  async #connect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (!this.#authenticated(request)) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="WorldlineBox"\r\nConnection: close\r\n\r\n'); return; }
    let target: URL;
    let destination: string;
    try {
      target = new URL(`https://${request.url ?? ''}`);
      if (!request.url?.includes(':') || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Invalid target.');
      destination = target.href;
      const original = request.headers['x-worldlinebox-pinned-origin'];
      if (original !== undefined) {
        // The secure asset downloader has already validated DNS and pins a
        // numeric connection target. Authenticated origin metadata lets PAC
        // match the original hostname without resolving that hostname again.
        if (typeof original !== 'string' || original.length > 2048 || !net.isIP(target.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Invalid pinned origin.');
        const origin = new URL(original);
        if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || original !== origin.origin
          || Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)) !== Number(target.port || 443)) throw new Error('Invalid pinned origin.');
        destination = origin.href;
      }
    } catch { client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    try {
      const proxy = await this.#route(destination, this.#revision);
      if (client.destroyed) return;
      const attach = (upstream: Duplex, upstreamHead?: Buffer) => {
        this.#track(upstream);
        if (client.destroyed) { upstream.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (upstreamHead?.length) client.write(upstreamHead);
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
        client.once('close', () => upstream.destroy());
        upstream.once('close', () => client.destroy());
      };
      if (!proxy) {
        const upstream = this.#track(net.connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 443) }));
        const timer = setTimeout(() => upstream.destroy(new Error('Direct connection timed out.')), 30_000);
        upstream.once('connect', () => { clearTimeout(timer); attach(upstream); });
        upstream.once('close', () => clearTimeout(timer));
        upstream.once('error', () => client.destroy());
        client.once('close', () => upstream.destroy());
      } else {
        const outgoing = (proxy.protocol === 'https:' ? https : http).request({ protocol: proxy.protocol, hostname: proxy.hostname.replace(/^\[|\]$/g, ''),
          port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), method: 'CONNECT',
          path: `${target.hostname}:${target.port || 443}`, headers: { host: `${target.hostname}:${target.port || 443}` }, agent: false });
        outgoing.on('socket', socket => this.#track(socket));
        outgoing.setTimeout(30_000, () => outgoing.destroy(new Error('Upstream proxy timed out.')));
        outgoing.once('connect', (response, socket, upstreamHead) => {
          outgoing.setTimeout(0);
          if (response.statusCode !== 200) { socket.destroy(); client.destroy(); return; }
          attach(socket, upstreamHead);
        });
        outgoing.once('error', () => client.destroy());
        client.once('close', () => outgoing.destroy());
        outgoing.end();
      }
    } catch { client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); }
  }
}
