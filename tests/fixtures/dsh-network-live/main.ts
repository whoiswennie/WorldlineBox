import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net, { type Socket } from 'node:net';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { app, session, BrowserWindow, WebContentsView, net as electronNet } from 'electron';
import { LauncherNetwork, DEFAULT_LAUNCHER_NETWORK } from '../../../src/main/dsh/launcher-network';
import { applyNodeNetworkEnvironment, networkEnvironmentSchema } from '../../../src/shared/network-environment';
import { getApplicationNetwork } from '../../../src/main/application-network';

const root = process.env.WORLDLINEBOX_NETWORK_LIVE_ROOT!;
app.setPath('userData', path.join(root, 'electron-data'));
app.on('window-all-closed', () => undefined);
function relay(upstream?: URL) {
  const targets: string[] = []; const sockets = new Set<Socket>();
  const server = http.createServer((_request, response) => { response.writeHead(405); response.end(); });
  server.on('connect', (request, incomingStream, head) => {
    const incoming = incomingStream as Socket;
    targets.push(request.url ?? ''); const destination = new URL('https://' + request.url);
    const outgoing = net.connect(upstream ? Number(upstream.port) : Number(destination.port || 443), upstream?.hostname ?? destination.hostname);
    sockets.add(incoming); sockets.add(outgoing);
    incoming.on('error', () => outgoing.destroy()); outgoing.on('error', () => incoming.destroy());
    incoming.on('close', () => { sockets.delete(incoming); outgoing.destroy(); }); outgoing.on('close', () => sockets.delete(outgoing));
    incoming.setTimeout(25_000, () => incoming.destroy()); outgoing.setTimeout(25_000, () => outgoing.destroy());
    outgoing.once('connect', () => {
      if (upstream) outgoing.write(`CONNECT ${request.url} HTTP/1.1\r\nHost: ${request.url}\r\n\r\n`);
      else incoming.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) outgoing.write(head); incoming.pipe(outgoing); outgoing.pipe(incoming);
    });
  });
  return { targets, async start() { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`; },
    stop() { for (const socket of sockets) socket.destroy(); server.close(); } };
}
app.whenReady().then(async () => {
  const system = await session.defaultSession.resolveProxy('https://registry.npmjs.org');
  const match = /^PROXY\s+([^;]+)/.exec(system); const upstream = match ? new URL('http://' + match[1]) : undefined;
  const first = relay(upstream); const second = relay(upstream);
  const firstUrl = await first.start(); const secondUrl = await second.start();
  const create = () => new LauncherNetwork(path.join(root, 'settings'), () => undefined, () => session.fromPartition('network-live-' + Date.now() + '-' + Math.random()));
  let service = create(); await service.init();
  const hook = async () => service.setEnvironmentHandler(env => applyNodeNetworkEnvironment(networkEnvironmentSchema.parse({
    HTTP_PROXY: env.HTTP_PROXY, HTTPS_PROXY: env.HTTPS_PROXY, ALL_PROXY: env.ALL_PROXY, NO_PROXY: env.NO_PROXY,
    npm_config_registry: env.npm_config_registry, PIP_INDEX_URL: env.PIP_INDEX_URL, NODE_USE_ENV_PROXY: '1',
  })));
  const results: Record<string, unknown>[] = [];
  const fetchBytes = async (url: string, name: string, node = false) => {
    const started = Date.now(); const signal = AbortSignal.timeout(35_000);
    const response = node ? await fetch(url, { signal }) : await service.fetch(url, { signal, redirect: 'manual' });
    assert.equal(response.status, 200, response.url + ' HTTP ' + response.status);
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; assert(size < 2 * 1024 * 1024); chunks.push(item.value); } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const bytes = Buffer.concat(chunks); await writeFile(path.join(root, name), bytes, { flag: 'wx' });
    results.push({ name, requested: url, served: response.url, bytes: bytes.length, elapsedMs: Date.now() - started, sha256: createHash('sha256').update(bytes).digest('hex'), node });
    console.log('NETWORK_LIVE_PROGRESS ' + JSON.stringify(results.at(-1))); return bytes;
  };
  try {
    await mkdir(path.join(root, 'downloads'), { recursive: true });
    await service.save({ ...DEFAULT_LAUNCHER_NETWORK, proxyMode: 'custom', proxyUrl: firstUrl, npmDownloadRoute: 'registry', proxyProfiles: [{ id: 'first', name: 'temporary A', url: firstUrl }, { id: 'second', name: 'temporary B', url: secondUrl }] });
    await hook();
    const metadata = JSON.parse((await fetchBytes('https://registry.npmjs.org/is-number/7.0.0', 'official-metadata.json')).toString()) as { dist: { tarball: string; integrity: string } };
    const canonical = metadata.dist.tarball;
    const bytes = await fetchBytes(canonical, 'downloads/official.tgz');
    assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), metadata.dist.integrity);
    await fetchBytes(canonical, 'downloads/node-official.tgz', true);
    const firstCount = first.targets.length; assert(firstCount > 0); assert.equal(second.targets.length, 0);
    await service.save({ ...service.state().settings, proxyUrl: secondUrl, npmRegistry: 'https://registry.npmmirror.com',
      sourceProfiles: [{ id: 'mirror', name: 'new mirror', kind: 'npm', url: 'https://registry.npmmirror.com' }] });
    await service.inspect(); assert(service.state().inspection!.routes.every(route => route.proxy === secondUrl));
    assert.deepEqual(await fetchBytes(canonical, 'downloads/mirror.tgz'), bytes);
    assert.deepEqual(await fetchBytes('https://registry.npmmirror.com/is-number/-/is-number-7.0.0.tgz', 'downloads/node-mirror.tgz', true), bytes);
    assert.equal(first.targets.length, firstCount); assert(second.targets.some(target => target.startsWith('registry.npmmirror.com:')));
    service = create(); await service.init(); await hook();
    assert.equal(service.state().settings.proxyUrl, secondUrl); assert.equal(service.state().settings.sourceProfiles?.[0]?.name, 'new mirror');
    assert.deepEqual(await fetchBytes(canonical, 'downloads/restarted.tgz'), bytes);
    await service.save({ ...service.state().settings, pythonIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple', sourceProfiles: [...service.state().settings.sourceProfiles!, { id: 'python', name: 'new Python mirror', kind: 'python', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' }] });
    assert.equal((await service.environment()).PIP_INDEX_URL, 'https://pypi.tuna.tsinghua.edu.cn/simple');
    await fetchBytes('https://pypi.tuna.tsinghua.edu.cn/simple/idna/', 'python-index.html');
    const beforeDirect = second.targets.length;
    await service.save({ ...service.state().settings, proxyMode: 'direct' });
    assert.equal((await service.environment()).HTTP_PROXY, undefined);
    assert.deepEqual(await fetchBytes(canonical, 'downloads/direct-mirror.tgz'), bytes);
    assert.equal(second.targets.length, beforeDirect); assert.equal(first.targets.length, firstCount);
    const applicationNetwork = await getApplicationNetwork();
    await applicationNetwork.save({ ...DEFAULT_LAUNCHER_NETWORK, proxyMode: 'custom', proxyUrl: firstUrl, npmDownloadRoute: 'registry' });
    const browserScope = session.fromPartition('persist:network-live-browser'); await applicationNetwork.attachSession(browserScope);
    const host = new BrowserWindow({ show: false }); const browser = new WebContentsView({ webPreferences: { session: browserScope, nodeIntegration: false, sandbox: true, contextIsolation: true } });
    host.contentView.addChildView(browser);
    await browser.webContents.loadURL('https://registry.npmjs.org/is-number/7.0.0?proof=browser-a');
    const globalFirstCount = first.targets.length; assert(globalFirstCount > firstCount);
    await applicationNetwork.save({ ...applicationNetwork.state().settings, proxyUrl: secondUrl });
    await browser.webContents.loadURL('https://registry.npmjs.org/is-number/7.0.0?proof=browser-b');
    const applicationResponse = await electronNet.fetch('https://registry.npmjs.org/is-number/7.0.0?proof=default-session'); assert.equal(applicationResponse.status, 200); await applicationResponse.text();
    const nodeResponse = await fetch('https://registry.npmjs.org/is-number/7.0.0?proof=global-node'); assert.equal(nodeResponse.status, 200); await nodeResponse.text();
    assert.equal(first.targets.length, globalFirstCount); assert(second.targets.length > beforeDirect);
    browser.webContents.close(); host.destroy();
    console.log('NETWORK_LIVE_GLOBAL ' + JSON.stringify({ browserSession: true, applicationDefaultSession: true, nodeRuntime: true, firstProxyStoppedReceivingNewConnections: true }));
    await writeFile(path.join(root, 'result.json'), JSON.stringify({ upstream: upstream?.href ?? 'DIRECT', firstUrl, secondUrl, firstTargets: first.targets, secondTargets: second.targets, results }, null, 2));
    console.log('NETWORK_LIVE_RESULT ' + JSON.stringify({ ok: true, requests: results.length + 4, firstConnections: first.targets.length, secondConnections: second.targets.length, globalBrowserAndNode: true, integrity: 'official SHA-512 matched all package copies', root }));
    first.stop(); second.stop(); app.exit(0);
  } catch (error) { console.error(error); first.stop(); second.stop(); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
