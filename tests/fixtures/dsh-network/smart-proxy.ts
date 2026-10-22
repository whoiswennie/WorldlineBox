import { strict as assert } from 'node:assert';
import { X509Certificate } from 'node:crypto';
import dns from 'node:dns';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net, { type Socket } from 'node:net';
import path from 'node:path';
import { app, BrowserWindow, session, type Session } from 'electron';
import { LauncherNetwork } from '../../../src/main/dsh/launcher-network';
import { ChildNetworkRelay } from '../../../src/main/child-network-relay';
import { applyNodeNetworkEnvironment, networkEnvironmentSchema } from '../../../src/shared/network-environment';

const root = process.env.WORLDLINEBOX_SMART_PROXY_ROOT!;
const hosts = ['www.pixiv.net', 'accounts.pixiv.net', 's.pximg.net', 'i.pximg.net', 'www.google.com', 'example.cn'];
const originalLookup = dns.lookup;
dns.lookup = ((name: string, ...args: unknown[]) => Reflect.apply(originalLookup, dns, [hosts.includes(name) ? '127.0.0.1' : name, ...args])) as typeof dns.lookup;
app.setPath('userData', path.join(root, 'electron-data'));
app.commandLine.appendSwitch('host-resolver-rules', hosts.map(host => `MAP ${host} 127.0.0.1`).join(', '));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => undefined);
app.whenReady().then(async () => {
  const sockets = new Set<Socket>();
  const cert = await readFile(path.resolve('tests/fixtures/dsh-network/cert.pem'), 'utf8');
  const key = await readFile(path.resolve('tests/fixtures/dsh-network/key.pem'), 'utf8');
  const fingerprint = new X509Certificate(cert).fingerprint256;
  const origin = https.createServer({ cert, key }, (request, response) => {
    response.setHeader('cache-control', 'no-store');
    if (request.url?.endsWith('.css')) { response.setHeader('content-type', 'text/css'); response.end('h1{color:rgb(12, 34, 56)}'); }
    else if (request.url?.endsWith('.js')) { response.setHeader('content-type', 'application/javascript'); response.end('window.cdnLoaded=true'); }
    else if (request.url?.endsWith('.svg')) { response.setHeader('content-type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>'); }
    else { response.setHeader('content-type', 'text/html'); response.end('<h1>actual origin</h1>'); }
  });
  const listen = (server: http.Server | https.Server) => new Promise<number>(resolve => {
    server.on('connection', socket => { sockets.add(socket); socket.on('error', () => undefined); socket.once('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1', () => { const address = server.address(); assert(address && typeof address !== 'string'); resolve(address.port); });
  });
  const port = await listen(origin);
  const connections: string[] = [];
  const proxy = http.createServer();
  proxy.on('connect', (request, client, head) => {
    const target = new URL('https://' + request.url);
    if (!hosts.includes(target.hostname) || Number(target.port) !== port) { client.destroy(); return; }
    connections.push(target.hostname);
    const upstream = net.connect(port, '127.0.0.1'); sockets.add(upstream);
    upstream.on('error', () => client.destroy()); upstream.once('close', () => sockets.delete(upstream));
    client.once('close', () => upstream.destroy()); client.on('error', () => upstream.destroy());
    upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
  });
  const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  const scope = session.fromPartition('smart-proxy-browser');
  scope.setCertificateVerifyProc((request, callback) => callback(hosts.includes(request.hostname) && new X509Certificate(request.certificate.data).fingerprint256 === fingerprint ? 0 : -3));
  // The health choice is controlled here; real transport and browser policy are not mocked.
  const network = new LauncherNetwork(path.join(root, 'network'), () => undefined, () => scope, async () => ['s.pximg.net']);
  await network.init(); await network.patch({ proxyMode: 'custom', proxyUrl, proxyRouting: 'global' });
  const relay = new ChildNetworkRelay(url => network.resolveProxy(url));
  let revision = network.state().revision;
  const stop = network.subscribe(() => { const next = network.state().revision; if (revision !== next) { revision = next; relay.policyChanged(); } });
  await network.setEnvironmentHandler(async value => applyNodeNetworkEnvironment(networkEnvironmentSchema.parse(await relay.environment({ ...value, NODE_USE_ENV_PROXY: '1' }))));
  const window = new BrowserWindow({ show: false, webPreferences: { session: scope, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  const nodeGet = (host: string) => new Promise<void>((resolve, reject) => {
    const request = https.get(`https://${host}:${port}/node`, { ca: cert, checkServerIdentity: (_host, certificate) => new X509Certificate(certificate.raw).fingerprint256 === fingerprint ? undefined : Error('Wrong fixture certificate') }, response => {
      let body = ''; response.on('data', chunk => { body += String(chunk); }); response.once('end', () => { try { assert(body.includes('actual origin')); resolve(); } catch (error) { reject(error); } });
    }); request.on('error', reject); request.setTimeout(8000, () => request.destroy(Error('Node fixture timed out')));
  });
  const probe = async (smart: boolean, current: Session = scope) => {
    for (const host of hosts) {
      const before = connections.length;
      const url = `https://${host}:${port}/probe?phase=${network.state().revision}`;
      const expected = smart && ['s.pximg.net', 'example.cn'].includes(host) ? 'DIRECT' : proxyUrl;
      assert.equal(await network.resolveProxy(url), expected);
      assert.equal(await current.resolveProxy(url), expected === 'DIRECT' ? 'DIRECT' : `PROXY 127.0.0.1:${new URL(proxyUrl).port}`);
      const response = await current.fetch(url); assert((await response.text()).includes('actual origin'));
      await nodeGet(host);
      assert.equal(connections.length > before, expected !== 'DIRECT', 'Browser and Node route mismatch for ' + host);
    }
  };
  try {
    await probe(false);
    await network.patch({ proxyRouting: 'smart' }); await probe(true);
    for (const url of ['https://10.1.2.3/', 'https://172.16.1.2/', 'https://192.168.1.2/', 'https://[fd12::1]/', 'https://[fe80::1234]/']) {
      assert.equal(await network.resolveProxy(url), 'DIRECT', url); assert.equal(await scope.resolveProxy(url), 'DIRECT', url);
    }
    const later = session.fromPartition('smart-proxy-later');
    later.setCertificateVerifyProc((request, callback) => callback(hosts.includes(request.hostname) && new X509Certificate(request.certificate.data).fingerprint256 === fingerprint ? 0 : -3));
    await network.attachSession(later); await probe(true, later);
    const page = `<!doctype html><link rel="stylesheet" href="https://s.pximg.net:${port}/app.css"><script src="https://s.pximg.net:${port}/app.js"></script><h1>Pixiv resources fixture</h1><img src="https://i.pximg.net:${port}/image.svg">`;
    await window.loadURL('data:text/html,' + encodeURIComponent(page));
    assert.deepEqual(await window.webContents.executeJavaScript('({style:getComputedStyle(document.querySelector("h1")).color,script:window.cdnLoaded,image:document.querySelector("img").naturalWidth})'), { style: 'rgb(12, 34, 56)', script: true, image: 2 });
    await network.patch({ proxyRouting: 'global' }); await probe(false);
    await network.setProxyEnabled(false);
    assert.equal(await network.resolveProxy(`https://i.pximg.net:${port}/`), 'DIRECT');
    await network.setProxyEnabled(true); await probe(false);
    console.log('SMART_PROXY_RESULT ' + JSON.stringify({ chromium: true, node: true, laterSession: true, stylesheet: true, script: true, image: true, globalRestored: true, tunnels: connections.length }));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { dns.lookup = originalLookup; stop(); await relay.close(); for (const socket of sockets) socket.destroy(); origin.close(); proxy.close(); window.destroy(); }
}).catch(error => { console.error(error); app.exit(1); });
