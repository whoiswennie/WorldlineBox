import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { setGlobalProxyFromEnv } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';

import { ChildNetworkRelay } from '../../src/main/child-network-relay';
import { redact } from '../../src/main/dsh/files';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function listening(server: http.Server | https.Server, hostname = '127.0.0.1'): Promise<number> {
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => undefined); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, hostname, resolve); });
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port'); return address.port;
}
function proxyAuthentication(endpoint: string): string { const url = new URL(endpoint); return `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`; }
async function upstreamProxy(): Promise<{ endpoint: string; requests: string[]; headers: http.IncomingHttpHeaders[] }> {
  const requests: string[] = [], headers: http.IncomingHttpHeaders[] = [];
  const proxy = http.createServer((request, response) => {
    requests.push(request.url!); headers.push(request.headers);
    const target = new URL(request.url!);
    const forwarded = http.request(target, { method: request.method, headers: request.headers, agent: false }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); });
    forwarded.once('error', () => response.destroy()); request.pipe(forwarded);
  });
  proxy.on('connect', (request, client, head) => {
    requests.push(`CONNECT ${request.url}`); headers.push(request.headers);
    const target = new URL(`http://${request.url}`); const socket = net.connect(Number(target.port), target.hostname);
    socket.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) socket.write(head); client.pipe(socket); socket.pipe(client); });
    socket.on('error', () => client.destroy()); client.on('error', () => socket.destroy()); client.once('close', () => socket.destroy());
  });
  return { endpoint: `http://127.0.0.1:${await listening(proxy)}`, requests, headers };
}
async function getThrough(endpoint: string, target: string, auth = proxyAuthentication(endpoint)): Promise<{ status: number; body: string }> {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: url.hostname, port: url.port, path: target, headers: { 'proxy-authorization': auth }, agent: false }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.once('end', () => resolve({ status: response.statusCode!, body }));
    }); request.once('error', reject); request.setTimeout(8000, () => request.destroy(new Error('Fixture timeout')));
  });
}

describe('application proxy routing for already running managed processes', () => {
  it('switches a single running Node process from proxy A to direct to proxy B through its unchanged private endpoint', async () => {
    const receivedHeaders: http.IncomingHttpHeaders[] = [];
    const origin = http.createServer((request, response) => { receivedHeaders.push(request.headers); response.end('real-origin-bytes'); });
    const port = await listening(origin, '127.0.0.2');
    const a = await upstreamProxy(), b = await upstreamProxy();
    let route = a.endpoint;
    const relay = new ChildNetworkRelay(async () => route); cleanup.push(() => relay.close());
    const environment = await relay.environment({ ...process.env, NO_PROXY: '*', http_proxy: 'http://invalid.example:1' });
    expect(environment.http_proxy).toBeUndefined(); expect(environment.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(redact(environment.HTTP_PROXY!)).not.toContain(new URL(environment.HTTP_PROXY!).password);
    const source = `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',async url=>{try{console.log(JSON.stringify({body:await(await fetch(url,{signal:AbortSignal.timeout(8000)})).text(),pid:process.pid}))}catch(error){console.log(JSON.stringify({error:String(error),pid:process.pid}))}});`;
    const child = spawn(process.execPath, ['-e', source], { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    cleanup.push(async () => { child.stdin.end(); if (child.exitCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(); }); });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const probe = () => new Promise<{ body?: string; pid: number; error?: string }>((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error(`Child probe timed out: ${stderr}`)), 12_000);
      const onData = (chunk: Buffer) => { output += chunk.toString(); if (output.includes('\n')) { clearTimeout(timer); child.stdout.off('data', onData); resolve(JSON.parse(output.trim())); } };
      child.stdout.on('data', onData); child.stdin.write(`http://127.0.0.2:${port}/probe?step=${a.requests.length + b.requests.length}\n`);
    });
    expect(await probe()).toEqual({ body: 'real-origin-bytes', pid: child.pid }); expect(a.requests).toHaveLength(1);
    expect(a.requests[0]).toBe(`CONNECT 127.0.0.2:${port}`);
    route = 'DIRECT'; relay.policyChanged();
    expect(await probe()).toEqual({ body: 'real-origin-bytes', pid: child.pid }); expect(a.requests).toHaveLength(1); expect(b.requests).toHaveLength(0);
    route = b.endpoint; relay.policyChanged();
    expect(await probe()).toEqual({ body: 'real-origin-bytes', pid: child.pid }); expect(b.requests).toHaveLength(1);
    route = 'DIRECT'; relay.policyChanged(); expect(await probe()).toEqual({ body: 'real-origin-bytes', pid: child.pid }); expect(b.requests).toHaveLength(1);
    for (const headers of [...receivedHeaders, ...a.headers, ...b.headers]) expect(headers['proxy-authorization']).toBeUndefined();
  }, 35_000);

  it('authenticates the loopback relay and refuses malformed or unsupported upstream targets', async () => {
    let route = 'DIRECT'; const destinations: string[] = [];
    const relay = new ChildNetworkRelay(async destination => { destinations.push(destination); return route; }); cleanup.push(() => relay.close());
    const endpoint = await relay.endpoint();
    expect((await getThrough(endpoint, 'http://example.invalid/', '')).status).toBe(407);
    expect((await getThrough(endpoint, '/relative')).status).toBe(400);
    expect((await getThrough(endpoint, 'https://example.invalid/')).status).toBe(400);
    const connectStatus = (target: string, original: string, auth = proxyAuthentication(endpoint)) => new Promise<number>((resolve, reject) => {
      const url = new URL(endpoint); const request = http.request({ hostname: url.hostname, port: url.port, method: 'CONNECT', path: target, agent: false,
        headers: { 'proxy-authorization': auth, 'x-worldlinebox-pinned-origin': original } });
      request.once('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode!); });
      request.once('response', response => { response.resume(); resolve(response.statusCode!); }); request.once('error', reject); request.end();
    });
    expect(await connectStatus('127.0.0.2:443', 'https://original.example', '')).toBe(407);
    for (const [target, original] of [['hostname.example:443', 'https://original.example'], ['127.0.0.2:443', 'https://original.example/path'],
      ['127.0.0.2:443', 'https://original.example:444'], ['127.0.0.2:443', 'https://user:secret@original.example'], ['127.0.0.2:443', 'ftp://original.example']]) {
      expect(await connectStatus(target!, original!)).toBe(400);
    }
    expect(destinations).toHaveLength(0);
    route = 'socks5://127.0.0.1:1'; expect((await getThrough(endpoint, 'http://example.invalid/')).status).toBe(503);
    const secret = new URL(endpoint).password; expect(secret).toHaveLength(64);
    await relay.close(); await expect(relay.endpoint()).rejects.toThrow('closed');
  });

  it('uses the resolved hop once even when Main has an active global proxy, and closes old streams on a policy change', async () => {
    let streamClosed!: () => void;
    const originClosed = new Promise<void>(resolve => { streamClosed = resolve; });
    const origin = http.createServer((request, response) => {
      if (request.url === '/stream') { response.writeHead(200); response.write('first bytes'); request.once('close', streamClosed); }
      else response.end('direct bytes');
    });
    const port = await listening(origin, '127.0.0.2'); const upstream = await upstreamProxy();
    const restore = setGlobalProxyFromEnv({ HTTP_PROXY: upstream.endpoint, HTTPS_PROXY: upstream.endpoint });
    const relay = new ChildNetworkRelay(async () => 'DIRECT'); cleanup.push(() => relay.close());
    try {
      const endpoint = await relay.endpoint(); expect((await getThrough(endpoint, `http://127.0.0.2:${port}/`)).body).toBe('direct bytes');
      expect(upstream.requests).toHaveLength(0);
      const url = new URL(endpoint);
      let closeStream!: () => void; const closed = new Promise<void>(resolve => { closeStream = resolve; });
      await new Promise<void>((resolve, reject) => {
        const request = http.get({ hostname: url.hostname, port: url.port, path: `http://127.0.0.2:${port}/stream`, agent: false,
          headers: { 'proxy-authorization': proxyAuthentication(endpoint) } }, response => {
          response.once('data', () => resolve()); response.on('error', () => undefined); response.once('close', closeStream); response.resume();
        }); request.once('error', reject);
      });
      relay.policyChanged();
      await Promise.race([Promise.all([closed, originClosed]), new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Stale stream was not closed')), 3000); timer.unref(); })]);
      expect((await getThrough(endpoint, `http://127.0.0.2:${port}/`)).body).toBe('direct bytes'); expect(upstream.requests).toHaveLength(0);
    } finally { restore(); }
  }, 15_000);

  it('keeps TLS validation end to end through direct and upstream CONNECT routes', async () => {
    const [cert, key] = await Promise.all(['cert.pem', 'key.pem'].map(name => readFile(`tests/fixtures/dsh-network/${name}`, 'utf8')));
    const fingerprint = new X509Certificate(cert!).fingerprint256;
    const origin = https.createServer({ cert, key }, (_request, response) => { response.writeHead(200, { connection: 'close' }); response.end('secure-origin-bytes'); });
    const port = await listening(origin, '127.0.0.2'); const upstream = await upstreamProxy();
    let route = 'DIRECT'; const destinations: string[] = [];
    const relay = new ChildNetworkRelay(async destination => { destinations.push(destination); return route; }); cleanup.push(() => relay.close());
    const endpoint = await relay.endpoint();
    const secureProbe = async (trustCertificate: boolean, original?: string): Promise<string> => {
      const url = new URL(endpoint);
      return new Promise<string>((resolve, reject) => {
        const request = http.request({ hostname: url.hostname, port: url.port, path: `127.0.0.2:${port}`, method: 'CONNECT', agent: false,
          headers: { 'proxy-authorization': proxyAuthentication(endpoint), ...(original ? { 'x-worldlinebox-pinned-origin': original } : {}) } });
        request.once('error', reject);
        request.once('connect', (response, socket) => {
          if (response.statusCode !== 200) { socket.destroy(); reject(new Error('CONNECT failed')); return; }
          const secure = tls.connect({ socket, servername: 'localhost', ...(trustCertificate ? { ca: cert } : {}),
            checkServerIdentity: (_hostname, peer) => new X509Certificate(peer.raw).fingerprint256 === fingerprint ? undefined : new Error('Unrecognized certificate') });
          let body = ''; secure.once('error', reject); secure.setTimeout(8000, () => secure.destroy(new Error('TLS fixture timed out')));
          secure.once('secureConnect', () => { expect(secure.authorized).toBe(true); secure.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'); });
          secure.on('data', chunk => { body += chunk; }); secure.once('end', () => resolve(body));
        }); request.end();
      });
    };
    expect(await secureProbe(true)).toContain('secure-origin-bytes'); expect(upstream.requests).toHaveLength(0);
    route = upstream.endpoint; relay.policyChanged(); expect(await secureProbe(true)).toContain('secure-origin-bytes'); expect(upstream.requests).toEqual([`CONNECT 127.0.0.2:${port}`]);
    const original = `https://original-policy.example:${port}`;
    expect(await secureProbe(true, original)).toContain('secure-origin-bytes'); expect(destinations.at(-1)).toBe(`${original}/`);
    expect(upstream.requests.at(-1)).toBe(`CONNECT 127.0.0.2:${port}`);
    expect(upstream.headers.at(-1)?.['x-worldlinebox-pinned-origin']).toBeUndefined();
    await expect(secureProbe(false)).rejects.toThrow(/certificate|self.signed|unable to verify/i);
  }, 25_000);
});
