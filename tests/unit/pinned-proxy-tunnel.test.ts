import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net, { type Socket } from 'node:net';
import tls from 'node:tls';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pinnedDownloadProxy } from '../../src/worker/pinned-proxy-tunnel';
import { defaultPinnedHttpTransport } from '../../src/worker/secure-http-download';

const servers: http.Server[] = [];
const sockets = new Set<Socket>();
const originalCertificates = tls.getCACertificates('default');
const originCertificate = readFileSync('tests/fixtures/dsh-network/npm-cert.pem', 'utf8');
const originKey = readFileSync('tests/fixtures/dsh-network/npm-key.pem', 'utf8');
const proxyCertificate = readFileSync('tests/fixtures/dsh-network/cert.pem', 'utf8');
const proxyKey = readFileSync('tests/fixtures/dsh-network/key.pem', 'utf8');

beforeEach(() => {
  for (const name of ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) vi.stubEnv(name, undefined);
});
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  tls.setDefaultCACertificates(originalCertificates);
  vi.unstubAllEnvs();
});
async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test server.');
  return address.port;
}
async function proxy(status = 200, hang = false, secure = false) {
  const targets: string[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const handler: http.RequestListener = (_request, response) => { response.writeHead(405).end(); };
  const server = secure ? https.createServer({ cert: proxyCertificate, key: proxyKey }, handler) : http.createServer(handler);
  server.on('connect', (request, client, head) => {
    targets.push(request.url!);
    headers.push(request.headers);
    if (hang) return;
    if (status !== 200) { client.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`); return; }
    const target = new URL(`http://${request.url}`);
    const upstream = net.connect(Number(target.port), target.hostname.replace(/^\[|\]$/gu, ''));
    sockets.add(upstream);
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy()); upstream.once('close', () => sockets.delete(upstream));
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
  });
  return { targets, headers, url: `${secure ? 'https' : 'http'}://127.0.0.1:${await listen(server)}` };
}
async function download(url: URL, signal = AbortSignal.timeout(5000)) {
  const response = await defaultPinnedHttpTransport({ address: '127.0.0.1', family: 4,
    url, headers: { 'User-Agent': 'WorldlineBox test' }, signal });
  const chunks: Uint8Array[] = [];
  if (response.body) for await (const chunk of response.body) chunks.push(chunk);
  return { status: response.status, text: Buffer.concat(chunks).toString() };
}

describe('pinned downloader global proxy', () => {
  it('switches A → direct → B without losing the validated IP or original HTTP Host', async () => {
    const hosts: string[] = [];
    const port = await listen(http.createServer((request, response) => { hosts.push(request.headers.host!); response.end('asset'); }));
    const a = await proxy(); const b = await proxy();
    const url = new URL(`http://does-not-resolve.invalid:${port}/asset.png`);
    vi.stubEnv('HTTP_PROXY', a.url);
    expect(await download(url)).toEqual({ status: 200, text: 'asset' });
    vi.stubEnv('HTTP_PROXY', '');
    expect(await download(url)).toEqual({ status: 200, text: 'asset' });
    vi.stubEnv('HTTP_PROXY', b.url);
    expect(await download(url)).toEqual({ status: 200, text: 'asset' });
    expect(a.targets).toEqual([`127.0.0.1:${port}`]);
    expect(b.targets).toEqual([`127.0.0.1:${port}`]);
    expect(hosts).toEqual(Array(3).fill(`does-not-resolve.invalid:${port}`));
  });

  it('retains origin SNI, certificate verification and Host through the numeric CONNECT tunnel', async () => {
    tls.setDefaultCACertificates([...originalCertificates, originCertificate]);
    const received: Array<{ host?: string; servername?: string | false | null }> = [];
    const origin = https.createServer({ cert: originCertificate, key: originKey }, (request, response) => {
      received.push({ host: request.headers.host, servername: (request.socket as tls.TLSSocket).servername }); response.end('secure asset');
    });
    const port = await listen(origin); const route = await proxy(); vi.stubEnv('HTTPS_PROXY', route.url);
    expect(await download(new URL(`https://registry.fixture.test:${port}/image.png`))).toEqual({ status: 200, text: 'secure asset' });
    expect(route.targets).toEqual([`127.0.0.1:${port}`]);
    expect(received).toEqual([{ host: `registry.fixture.test:${port}`, servername: 'registry.fixture.test' }]);
    await expect(download(new URL(`https://wrong-origin.invalid:${port}/image.png`))).rejects.toThrow(/Hostname\/IP does not match/u);
    expect(received).toHaveLength(1);
  });

  it('rejects untrusted origin certificates and never falls back to direct on proxy failure', async () => {
    let requests = 0;
    const port = await listen(https.createServer({ cert: originCertificate, key: originKey }, (_request, response) => { requests++; response.end('unexpected'); }));
    const route = await proxy(); vi.stubEnv('HTTPS_PROXY', route.url);
    await expect(download(new URL(`https://registry.fixture.test:${port}/image.png`))).rejects.toThrow(/self.signed certificate/iu);
    const refused = await proxy(403); vi.stubEnv('HTTPS_PROXY', refused.url);
    await expect(download(new URL(`https://registry.fixture.test:${port}/image.png`))).rejects.toThrow('HTTP 403');
    expect(requests).toBe(0);
  });

  it('supports a TLS proxy while validating both proxy and origin certificates', async () => {
    const port = await listen(https.createServer({ cert: originCertificate, key: originKey }, (_request, response) => response.end('nested TLS asset')));
    const route = await proxy(200, false, true); vi.stubEnv('HTTPS_PROXY', route.url);
    tls.setDefaultCACertificates([...originalCertificates, originCertificate]);
    await expect(download(new URL(`https://registry.fixture.test:${port}/image.png`))).rejects.toThrow(/self.signed certificate/iu);
    expect(route.targets).toHaveLength(0);
    tls.setDefaultCACertificates([...originalCertificates, originCertificate, proxyCertificate]);
    expect(await download(new URL(`https://registry.fixture.test:${port}/image.png`))).toEqual({ status: 200, text: 'nested TLS asset' });
    expect(route.targets).toEqual([`127.0.0.1:${port}`]);
  });

  it('authenticates only the private loopback relay and provides its original origin without dropping the numeric pin', async () => {
    let originHeaders: http.IncomingHttpHeaders | undefined;
    const port = await listen(http.createServer((request, response) => { originHeaders = request.headers; response.end('private relay asset'); }));
    const route = await proxy(); const endpoint = new URL(route.url);
    endpoint.username = 'worldlinebox'; endpoint.password = 'a'.repeat(64);
    vi.stubEnv('HTTP_PROXY', endpoint.href);
    const url = new URL(`http://pinned-origin.fixture.test:${port}/private-path?token=private-secret`);
    expect(await download(url)).toEqual({ status: 200, text: 'private relay asset' });
    expect(route.targets).toEqual([`127.0.0.1:${port}`]);
    expect(route.headers[0]).toMatchObject({
      'proxy-authorization': `Basic ${Buffer.from(`worldlinebox:${'a'.repeat(64)}`).toString('base64')}`,
      'x-worldlinebox-pinned-origin': `http://pinned-origin.fixture.test:${port}`,
    });
    expect(JSON.stringify(route.headers)).not.toContain('private-secret');
    expect(route.headers[0]?.authorization).toBeUndefined();
    expect(originHeaders?.['proxy-authorization']).toBeUndefined();
    expect(originHeaders?.['x-worldlinebox-pinned-origin']).toBeUndefined();
    for (const rejected of ['http://user:password@127.0.0.1:7896', `http://worldlinebox:${'a'.repeat(64)}@example.com:7896`]) {
      expect(() => pinnedDownloadProxy(url, { HTTP_PROXY: rejected })).toThrow('without URL credentials');
    }
  });

  it('cancels a pending CONNECT and preserves the caller abort reason', async () => {
    const route = await proxy(200, true); vi.stubEnv('HTTP_PROXY', route.url);
    const controller = new AbortController();
    const result = download(new URL('http://does-not-resolve.invalid:80/image.png'), controller.signal);
    const rejected = expect(result).rejects.toThrow('cancel fixture');
    await vi.waitFor(() => expect(route.targets).toHaveLength(1));
    controller.abort(new Error('cancel fixture')); await rejected;
  });

  it('honors explicit destination bypasses without confusing ports or domain suffixes', () => {
    const environment = { HTTP_PROXY: 'http://127.0.0.1:7896', NO_PROXY: 'localhost,.example.com,exact.test:8080,[::1]' };
    for (const url of ['http://localhost/a', 'http://cdn.example.com/a', 'http://exact.test:8080/a', 'http://[::1]/a']) {
      expect(pinnedDownloadProxy(new URL(url), environment)).toBeUndefined();
    }
    for (const url of ['http://notexample.com/a', 'http://exact.test:8081/a', 'http://localhostname/a']) {
      expect(pinnedDownloadProxy(new URL(url), environment)?.href).toBe('http://127.0.0.1:7896/');
    }
    expect(pinnedDownloadProxy(new URL('https://public.test/a'), { HTTPS_PROXY: environment.HTTP_PROXY, NO_PROXY: '*' })).toBeUndefined();
    expect(() => pinnedDownloadProxy(new URL('https://public.test/a'), { HTTPS_PROXY: 'socks5://127.0.0.1:7891' })).toThrow('HTTP(S)');
  });
});
