import { strict as assert } from 'node:assert';
import http from 'node:http';
import net, { type Socket } from 'node:net';
import path from 'node:path';
import { app, net as electronNet, session } from 'electron';
import { getApplicationNetwork } from '../../../src/main/application-network';
import { LibraryWorkerClient } from '../../../src/main/worker-client';
import { generateCompanionStructured } from '../../../src/main/companions/model';
import { postEmbeddingHttp } from '../../../src/main/embedding-http';
import type { AppLogger } from '../../../src/main/app-logger';
import { defaultPinnedHttpTransport } from '../../../src/worker/secure-http-download';

const root = process.env.WORLDLINEBOX_GLOBAL_NETWORK_COVERAGE_ROOT!;
const companionHostname = 'global-network.fixture.test';
app.setPath('userData', path.join(root, 'electron-data'));
app.commandLine.appendSwitch('host-resolver-rules', `MAP ${companionHostname} 127.0.0.1`);
app.on('window-all-closed', () => undefined);
const servers: http.Server[] = [];
const sockets = new Set<Socket>();
async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const address = server.address(); assert(address && typeof address !== 'string'); return address.port;
}
async function relay(originPort: number) {
  const paths: string[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!);
    if (!['127.0.0.2', companionHostname].includes(url.hostname) || url.port !== String(originPort)) { response.writeHead(403).end(); return; }
    paths.push(url.pathname);
    const upstream = http.request({ host: '127.0.0.1', port: originPort, method: request.method,
      path: url.pathname + url.search, headers: request.headers, agent: false }, incoming => {
      response.writeHead(incoming.statusCode!, incoming.headers); incoming.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502).end(); }); request.pipe(upstream);
  });
  server.on('connect', (request, incoming, head) => {
    if (![`127.0.0.2:${originPort}`, `127.0.0.1:${originPort}`, `${companionHostname}:${originPort}`].includes(request.url!)) { incoming.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    assert.equal(request.headers['proxy-authorization'], undefined);
    assert.equal(request.headers['x-worldlinebox-pinned-origin'], undefined);
    const upstream = net.connect(originPort, '127.0.0.1'); sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    incoming.on('error', () => upstream.destroy()); incoming.once('close', () => upstream.destroy());
    upstream.on('error', () => incoming.destroy());
    upstream.once('connect', () => {
      incoming.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head);
      // Capture the HTTP request path inside CONNECT as well as absolute-form HTTP proxy requests.
      let first = true; incoming.on('data', chunk => { if (first) { first = false; paths.push(String(chunk).split(' ')[1]!); } });
      incoming.pipe(upstream); upstream.pipe(incoming);
    });
  });
  return { paths, url: `http://127.0.0.1:${await listen(server)}` };
}

app.whenReady().then(async () => {
  let worker: LibraryWorkerClient | undefined;
  try {
    const served: string[] = [];
    let pacSource = '';
    const origin = http.createServer(async (request, response) => {
      if (request.url === '/network.pac') {
        response.setHeader('content-type', 'application/x-ns-proxy-autoconfig'); response.end(pacSource); return;
      }
      if (request.url === '/pinned-resource') {
        assert.equal(request.headers['proxy-authorization'], undefined);
        assert.equal(request.headers['x-worldlinebox-pinned-origin'], undefined);
        response.end('pinned resource through PAC'); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      assert.equal((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string }).model, 'fixture-model');
      served.push(request.url!); response.setHeader('content-type', 'application/json'); response.setHeader('cache-control', 'no-store');
      if (request.url!.startsWith('/semantic/')) response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }));
      else response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ fixture: 'ok' }) } }] }));
    });
    const port = await listen(origin); const first = await relay(port); const second = await relay(port);
    const network = await getApplicationNetwork();
    await network.patch({ proxyMode: 'custom', proxyUrl: first.url });
    const logger = { worker: (scope: string, data: unknown) => console.log('WORKER_' + scope + ' ' + String(data).trim()),
      info: (scope: string) => console.log(scope), error: (scope: string, error: unknown) => console.error(scope, error) } as unknown as AppLogger;
    worker = new LibraryWorkerClient(path.join(__dirname, 'library_worker.js'), logger);
    await worker.start();
    const base = `http://127.0.0.2:${port}`;
    const probe = async (phase: string, providerBase = base) => {
      const before = served.length;
      const result = await worker!.request({ type: 'ai.test-connection', apiFormat: 'openai_chat', apiKey: 'fixture-key', model: 'fixture-model', baseUrl: `${providerBase}/worker` });
      assert(result.ok, JSON.stringify(result));
      assert.deepEqual(await generateCompanionStructured({ system: 'Return JSON', user: 'Fixture' },
        { apiFormat: 'openai_chat', model: 'fixture-model', apiKey: 'fixture-key', baseUrl: `http://${companionHostname}:${port}/companions` }, undefined,
        { fetchFn: (input, init) => electronNet.fetch(String(input), { ...init, credentials: 'omit' }), timeoutMs: 8000 }), { fixture: 'ok' });
      assert.deepEqual(await postEmbeddingHttp({ baseUrl: `${providerBase}/semantic`, modelName: 'fixture-model', apiKey: null,
        inputs: ['fixture query'], dimensions: 3, timeoutMs: 8000 }), [[1, 0, 0]]);
      assert.equal(served.length - before, 3);
      console.log('GLOBAL_COVERAGE_PHASE ' + JSON.stringify({ phase, worker: 'real LibraryWorkerClient and production Worker AI adapter', companions: 'production structured provider using net.fetch', semantic: 'production Main HTTP embeddings', requests: served.slice(before) }));
    };
    await probe('proxy-a');
    assert(first.paths.some(url => url.startsWith('/worker/'))); assert(first.paths.some(url => url.startsWith('/companions/'))); assert(first.paths.some(url => url.startsWith('/semantic/')));
    assert.equal(second.paths.length, 0);
    const beforeDirect = first.paths.length;
    await network.setProxyEnabled(false); await probe('direct');
    assert.equal(first.paths.length, beforeDirect); assert.equal(second.paths.length, 0);
    await network.patch({ proxyMode: 'custom', proxyUrl: second.url }); await probe('proxy-b');
    assert.equal(first.paths.length, beforeDirect);
    assert(second.paths.some(url => url.startsWith('/worker/'))); assert(second.paths.some(url => url.startsWith('/companions/'))); assert(second.paths.some(url => url.startsWith('/semantic/')));

    // Install a real Chromium PAC in the fixture instead of editing Windows
    // system settings. LauncherNetwork still selects its real system branch.
    // The npm destination is DIRECT while actual AI destinations use proxy A.
    const pacOrigin = `http://${companionHostname}:${port}`;
    pacSource = `function FindProxyForURL(url, host) { return host === '${companionHostname}' || host === 'pinned-origin.fixture.test' ? 'PROXY ${new URL(first.url).host}' : 'DIRECT'; }`;
    for (const scope of [session.defaultSession, session.fromPartition('persist:worldlinebox-dsh-network')]) {
      const setProxy = scope.setProxy.bind(scope);
      scope.setProxy = config => setProxy(config.mode === 'system'
        ? { mode: 'pac_script', pacScript: `http://127.0.0.1:${port}/network.pac` } : config);
    }
    const aBeforePac = first.paths.length; const bBeforePac = second.paths.length;
    await network.patch({ proxyMode: 'system' });
    assert.equal(await network.resolveProxy('https://registry.npmjs.org'), 'DIRECT');
    assert.equal(await network.resolveProxy(`${pacOrigin}/semantic`), first.url);
    await probe('system-pac-per-destination', pacOrigin);
    assert.equal(second.paths.length, bBeforePac);
    assert.deepEqual(first.paths.slice(aBeforePac), ['/worker/chat/completions', '/companions/chat/completions', '/semantic/v1/embeddings']);
    const pinned = await defaultPinnedHttpTransport({ url: new URL(`http://pinned-origin.fixture.test:${port}/pinned-resource`),
      address: '127.0.0.1', family: 4, signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'WorldlineBox pinned PAC fixture' } });
    const pinChunks: Uint8Array[] = []; if (pinned.body) for await (const chunk of pinned.body) pinChunks.push(chunk);
    assert.equal(Buffer.concat(pinChunks).toString(), 'pinned resource through PAC');
    assert.equal(first.paths.at(-1), '/pinned-resource');
    console.log('GLOBAL_COVERAGE_PAC ' + JSON.stringify({ realChromiumPac: true, npm: 'DIRECT', models: first.url,
      liveWorker: true, privateRelayOriginMetadata: true, pinnedNumericConnect: true, noPrivateHeadersForwarded: true }));
    await worker.shutdown(); worker = undefined;
    console.log('GLOBAL_NETWORK_COVERAGE_RESULT ' + JSON.stringify({ ok: true, requests: served.length + 1, firstProxyPaths: first.paths, secondProxyPaths: second.paths }));
    for (const socket of sockets) socket.destroy(); for (const server of servers) server.close(); app.exit(0);
  } catch (error) {
    console.error(error); await worker?.shutdown().catch(() => undefined);
    for (const socket of sockets) socket.destroy(); for (const server of servers) server.close(); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
