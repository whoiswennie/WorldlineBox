import { strict as assert } from 'node:assert';
import { X509Certificate } from 'node:crypto';
import dns from 'node:dns';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net, { type Socket } from 'node:net';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, session, utilityProcess, type UtilityProcess } from 'electron';
import { currentNetworkEnvironment, getApplicationNetwork, onNetworkEnvironment } from '../../../src/main/application-network';
import { networkChildEnvironment } from '../../../src/shared/network-environment';
import { isManagedNetworkRelayUrl } from '../../../src/shared/network-relay-url';

const root = process.env.WORLDLINEBOX_PROXY_TOGGLE_FIXTURE_ROOT!;
const hostname = 'worldlinebox-proxy.test';
// This synthetic fixture domain has no public DNS record. Give Node the same
// controlled lookup as Chromium so the real relay can exercise direct routing.
const originalLookup = dns.lookup;
dns.lookup = ((name: string, ...arguments_: unknown[]) => Reflect.apply(originalLookup, dns,
  [name === hostname ? '127.0.0.1' : name, ...arguments_])) as typeof dns.lookup;
console.log('PROXY_TOGGLE_PROGRESS starting');
app.setPath('userData', path.join(root, 'electron-data'));
app.commandLine.appendSwitch('host-resolver-rules', `MAP ${hostname} 127.0.0.1`);
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => undefined);
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
function listen(server: http.Server | https.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '0.0.0.0', () => { const address = server.address(); assert(address && typeof address !== 'string'); resolve(address.port); }));
}

app.whenReady().then(async () => {
  console.log('PROXY_TOGGLE_PROGRESS electron-ready');
  const cert = await readFile(path.resolve('tests/fixtures/dsh-network/cert.pem'), 'utf8');
  const key = await readFile(path.resolve('tests/fixtures/dsh-network/key.pem'), 'utf8');
  const fingerprint = new X509Certificate(cert).fingerprint256;
  const servedPaths: string[] = [];
  const origin = https.createServer({ cert, key }, (request, response) => {
    servedPaths.push(request.url!); response.setHeader('cache-control', 'no-store');
    response.end(request.url?.startsWith('/github-') ? JSON.stringify({ path: request.url }) : '<title>Proxy toggle fixture</title><h1>ok</h1>');
  });
  const plain = http.createServer((_request, response) => { response.setHeader('cache-control', 'no-store'); response.end('node-fetch-ok'); });
  const securePort = await listen(origin); const plainPort = await listen(plain);
  console.log('PROXY_TOGGLE_PROGRESS origins-ready');
  const connections: string[] = []; const forwarded: string[] = []; const sockets = new Set<Socket>();
  const proxy = http.createServer((request, response) => {
    const target = new URL(request.url!);
    if (target.hostname !== '127.0.0.2' || Number(target.port) !== plainPort) { response.writeHead(403); response.end(); return; }
    forwarded.push(target.href);
    const upstream = http.request({ hostname: '127.0.0.1', port: plainPort, path: target.pathname + target.search, method: request.method }, incoming => {
      response.writeHead(incoming.statusCode!, incoming.headers); incoming.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  proxy.on('connect', (request, incomingStream, head) => {
    const incoming = incomingStream as Socket;
    const secure = request.url === `${hostname}:${securePort}`;
    if (!secure && request.url !== `127.0.0.2:${plainPort}`) { incoming.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    connections.push(request.url!);
    const upstream = net.connect(secure ? securePort : plainPort, '127.0.0.1');
    sockets.add(incoming); sockets.add(upstream);
    incoming.on('close', () => { sockets.delete(incoming); upstream.destroy(); }); upstream.on('close', () => sockets.delete(upstream));
    incoming.on('error', () => upstream.destroy()); upstream.on('error', () => incoming.destroy());
    upstream.once('connect', () => { incoming.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); incoming.pipe(upstream); upstream.pipe(incoming); });
  });
  const proxyPort = await listen(proxy); const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const network = await getApplicationNetwork();
  console.log('PROXY_TOGGLE_PROGRESS application-network-ready');
  await network.patch({ proxyMode: 'direct' });
  console.log('PROXY_TOGGLE_PROGRESS direct-applied');
  const browserScope = session.fromPartition('proxy-toggle-browser'); await network.attachSession(browserScope);
  console.log('PROXY_TOGGLE_PROGRESS browser-attached');
  // Trust only this fixture's exact committed certificate, for this synthetic loopback host.
  browserScope.setCertificateVerifyProc((request, callback) => callback(request.hostname === hostname
    && new X509Certificate(request.certificate.data).fingerprint256 === fingerprint ? 0 : -3));
  session.fromPartition('persist:worldlinebox-dsh-network').setCertificateVerifyProc((request, callback) => callback(request.hostname === hostname
    && new X509Certificate(request.certificate.data).fingerprint256 === fingerprint ? 0 : -3));
  console.log('PROXY_TOGGLE_PROGRESS certificate-configured');
  const host = new BrowserWindow({ show: false });
  console.log('PROXY_TOGGLE_PROGRESS host-created');
  const view = new WebContentsView({ webPreferences: { session: browserScope, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  console.log('PROXY_TOGGLE_PROGRESS view-created');
  host.contentView.addChildView(view);
  await view.webContents.loadURL('about:blank');
  console.log('PROXY_TOGGLE_PROGRESS blank-ready');
  const address = `https://${hostname}:${securePort}`;
  let worker: UtilityProcess | undefined; let stopNetworkListener: (() => void) | undefined;
  const pending = new Map<number, (response: { text?: string; error?: string; proxy?: string }) => void>();
  let workerRequest = 0;
  const probeWorker = async (expectedProxy: string | null = process.env.HTTP_PROXY ?? null) => {
    if (!worker) return;
    const id = ++workerRequest;
    const response = new Promise<{ text?: string; error?: string; proxy?: string }>((resolve, reject) => {
      pending.set(id, resolve); setTimeout(() => { if (pending.delete(id)) reject(Error('Worker proxy probe timed out')); }, 10_000).unref();
    });
    worker.postMessage({ type: 'probe', id, url: `http://127.0.0.2:${plainPort}/worker?sequence=${id}` });
    const result = await response; assert.equal(result.error, undefined); assert.equal(result.text, 'node-fetch-ok');
    assert.equal(result.proxy, expectedProxy ?? undefined);
  };
  let sequence = 0;
  const probe = async () => {
    sequence++;
    await view.webContents.loadURL(`${address}/browser?sequence=${sequence}`);
    console.log('PROXY_TOGGLE_PROGRESS browser-' + sequence);
    assert.equal(await view.webContents.executeJavaScript('document.querySelector("h1").textContent'), 'ok');
    assert.equal(await (await fetch(`http://127.0.0.2:${plainPort}/fetch?sequence=${sequence}`, { signal: AbortSignal.timeout(8000) })).text(), 'node-fetch-ok');
    console.log('PROXY_TOGGLE_PROGRESS node-fetch-' + sequence);
    await new Promise<void>((resolve, reject) => {
      const request = https.get(`${address}/node-https?sequence=${sequence}`, { ca: cert,
        lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4),
        checkServerIdentity: (_host, certificate) => new X509Certificate(certificate.raw).fingerprint256 === fingerprint ? undefined : Error('Unexpected test certificate'),
      }, response => { response.resume(); response.once('end', () => { assert.equal(response.statusCode, 200); resolve(); }); }).on('error', reject);
      request.setTimeout(8000, () => request.destroy(Error('Node HTTPS fixture timed out')));
    });
    console.log('PROXY_TOGGLE_PROGRESS node-https-' + sequence);
    await probeWorker();
  };
  try {
    await network.patch({ proxyMode: 'custom', proxyUrl }); console.log('PROXY_TOGGLE_PROGRESS proxy-applied'); await probe();
    worker = utilityProcess.fork(path.join(__dirname, 'worker.cjs'), [], { stdio: 'pipe', env: networkChildEnvironment({ ...process.env,
      WORLDLINEBOX_PROXY_WORKER_ORIGIN: `http://127.0.0.2:${plainPort}/worker-startup` }, currentNetworkEnvironment()) });
    worker.stderr?.on('data', chunk => console.error(String(chunk).trim()));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Worker startup timed out')), 10_000);
      worker!.on('message', (message: { type?: string; id?: number; text?: string; error?: string; inheritedProxy?: string; proxy?: string }) => {
        if (message.type === 'ready') { clearTimeout(timer); try { assert.equal(message.error, undefined); assert.equal(message.text, 'node-fetch-ok'); assert(isManagedNetworkRelayUrl(message.inheritedProxy ?? ''), 'Worker must inherit the private per-destination policy relay'); assert(message.inheritedProxy === currentNetworkEnvironment()!.HTTP_PROXY); resolve(); } catch (error) { reject(error); } }
        else if (message.id !== undefined) { const settle = pending.get(message.id); pending.delete(message.id); settle?.(message); }
      });
      worker!.once('exit', code => reject(Error('Worker exited: ' + code)));
    });
    const startupEnvironment = currentNetworkEnvironment()!;
    // First apply direct to a fresh Worker whose Node dispatcher was instantiated
    // from startup proxy variables; it has never installed an app proxy policy.
    worker.postMessage({ type: 'worker.network-environment', environment: { ...startupEnvironment, HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined } });
    const beforeWorkerDirect = connections.length; await probeWorker(null);
    assert.equal(connections.length, beforeWorkerDirect, 'An initial direct Worker policy must displace its inherited startup proxy');
    // This is the same environment message and application subscription as the library Worker.
    worker.postMessage({ type: 'worker.network-environment', environment: currentNetworkEnvironment() });
    stopNetworkListener = onNetworkEnvironment(environment => worker!.postMessage({ type: 'worker.network-environment', environment }));
    await probeWorker();
    assert(connections.filter(target => target === `${hostname}:${securePort}`).length >= 2, 'Chromium and Node HTTPS must both reach the CONNECT proxy');
    assert(connections.some(target => target === `127.0.0.2:${plainPort}`) || forwarded.length >= 1, 'Node fetch must reach the HTTP proxy');
    const enabledCounts = [connections.length, forwarded.length];
    await network.setProxyEnabled(false);
    assert.equal(await browserScope.resolveProxy(address), 'DIRECT');
    assert(isManagedNetworkRelayUrl(process.env.HTTP_PROXY ?? ''), 'Direct mode keeps the stable private endpoint for already running processes');
    assert(process.env.HTTP_PROXY === process.env.HTTPS_PROXY && process.env.HTTP_PROXY === process.env.ALL_PROXY);
    assert.equal(await network.resolveProxy(address), 'DIRECT');
    await probe();
    assert.deepEqual([connections.length, forwarded.length], enabledCounts, 'Disabled proxy must receive no new Chromium or Node traffic');
    assert.equal(network.state().settings.proxyUrl, proxyUrl);
    await network.setProxyEnabled(true); await probe();
    assert(connections.length > enabledCounts[0]!);
    assert.equal(network.state().settings.proxyMode, 'custom'); assert.equal(network.state().settings.proxyUrl, proxyUrl);
    for (const suffix of ['a', 'b']) {
      const registry = `${address}/npm-${suffix}`;
      await network.patch({ npmRegistry: registry, npmDownloadRoute: 'registry', pythonIndex: `${address}/pypi-${suffix}/simple`, githubMirror: 'custom', githubMirrorUrl: `${address}/github-${suffix}/` });
      const install = await network.nodeInstallNetwork(); assert.equal(install.registry, registry); assert.equal(install.env.npm_config_registry, registry);
      assert.equal(install.env.PIP_INDEX_URL, `${address}/pypi-${suffix}/simple`);
      await (await network.fetch('https://registry.npmjs.org/fixture-package/-/fixture-package-1.0.0.tgz', { signal: AbortSignal.timeout(8000), redirect: 'manual' })).text();
      await (await network.fetch(install.env.PIP_INDEX_URL!, { signal: AbortSignal.timeout(8000), redirect: 'manual' })).text();
      const github = await network.json('https://api.github.com/repos/fixture/package/releases') as { path: string };
      assert(github.path.startsWith(`/github-${suffix}/`));
    }
    assert.equal(servedPaths.filter(item => item === '/npm-a/fixture-package/-/fixture-package-1.0.0.tgz').length, 1);
    assert.equal(servedPaths.filter(item => item === '/npm-b/fixture-package/-/fixture-package-1.0.0.tgz').length, 1);
    assert(servedPaths.includes('/pypi-a/simple')); assert(servedPaths.includes('/pypi-b/simple'));
    console.log('PROXY_TOGGLE_RESULT ' + JSON.stringify({ chromiumConnect: true, nodeHttpsConnect: true, nodeFetch: true, utilityWorkerInheritedProxy: true, utilityWorkerInitialDirect: true, utilityWorkerHotUpdates: true, directBypassesProxy: true, sameProxyRestored: true, npmMirrorLiveBytes: true, pythonMirrorLiveRequest: true, githubMirrorLiveRequest: true, secureCertificateValidation: true, connections: connections.length, forwarded: forwarded.length }));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { dns.lookup = originalLookup; stopNetworkListener?.(); worker?.kill(); for (const socket of sockets) socket.destroy(); origin.closeAllConnections(); plain.closeAllConnections(); proxy.closeAllConnections(); origin.close(); plain.close(); proxy.close(); view.webContents.close(); host.destroy(); }
}).catch(error => { console.error(error); app.exit(1); });
