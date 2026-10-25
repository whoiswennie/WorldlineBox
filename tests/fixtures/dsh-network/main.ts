import { strict as assert } from 'node:assert';
import { createHash, X509Certificate } from 'node:crypto';
import { readFile, mkdir, readdir, rm } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { app, net, session } from 'electron';
import { downloadOfficialPackage } from '../../../src/main/dsh/node-runtime-service';
import { electronHttpsDownload } from '../../../src/main/dsh/electron-https-download';
import type { OperationContext } from '../../../src/main/dsh/operations';

const root = process.env.WORLDLINEBOX_DSH_DOWNLOAD_FIXTURE_ROOT!;
app.setPath('userData', path.join(root, 'electron-data'));
const operation = (id: string, signal = new AbortController().signal): OperationContext => ({ id, signal, update: async () => undefined, log: async () => undefined });
const integrity = (data: string) => 'sha512-' + createHash('sha512').update(data).digest('base64');

app.whenReady().then(async () => {
  const cert = await readFile(path.resolve('tests/fixtures/dsh-network/cert.pem'), 'utf8');
  const key = await readFile(path.resolve('tests/fixtures/dsh-network/key.pem'), 'utf8');
  const fingerprint = new X509Certificate(cert).fingerprint256;
  // This test trusts only its committed localhost certificate; production trust is untouched.
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const supplied = new X509Certificate(request.certificate.data).fingerprint256;
    callback(request.hostname === '127.0.0.1' && supplied === fingerprint ? 0 : -3);
  });
  let receivedHttpDowngrade = false;
  let slowConnectionClosed = false;
  const server = https.createServer({ cert, key }, (request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/installer' }); response.end(); }
    else if (request.url === '/downgrade') { response.writeHead(302, { location: 'http://127.0.0.1:1/insecure' }); response.end(); }
    else if (request.url === '/loop') { response.writeHead(302, { location: '/loop' }); response.end(); }
    else if (request.url === '/failed') { response.writeHead(503); response.end('unavailable'); }
    else if (request.url === '/empty') { response.writeHead(204); response.end(); }
    else if (request.url === '/slow') {
      response.writeHead(200); response.write('partial');
      response.once('close', () => { slowConnectionClosed = true; });
    } else if (request.url === '/truncated') {
      response.writeHead(200, { 'content-length': '100' });
      response.once('finish', () => request.socket.destroy()); response.end('partial');
    }
    else if (request.url === '/insecure') { receivedHttpDowngrade = true; response.end('insecure'); }
    else { response.writeHead(200, { 'content-length': '17' }); response.end('installer fixture'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `https://127.0.0.1:${address.port}`;
  try {
    const original = await net.fetch(`${origin}/redirect`);
    assert.equal(original.url, '');
    assert.equal(await original.text(), 'installer fixture');
    console.log('DSH_DOWNLOAD_PROGRESS original-response-url-reproduced');
    const direct = await electronHttpsDownload(`${origin}/redirect`, { signal: new AbortController().signal, redirect: 'manual' });
    assert.equal(direct.url, `${origin}/installer`);
    assert.equal(await direct.text(), 'installer fixture');
    console.log('DSH_DOWNLOAD_PROGRESS https-redirect-verified');
    for (const [endpoint, expected] of [['/downgrade', /HTTPS/], ['/loop', /too many/]] as const) {
      await assert.rejects(electronHttpsDownload(`${origin}${endpoint}`, { signal: new AbortController().signal, redirect: 'manual' }), expected);
    }
    assert.equal(receivedHttpDowngrade, false);
    console.log('DSH_DOWNLOAD_PROGRESS insecure-redirect-blocked');
    await assert.rejects(electronHttpsDownload('http://127.0.0.1:1/payload', { signal: new AbortController().signal, redirect: 'manual' }), /HTTPS/);
    const createFixture = async (id: string, endpoint: string) => {
      const directory = path.join(root, id); await mkdir(directory, { recursive: true });
      const file = path.join(directory, 'package.tgz');
      return { directory, async download(op: OperationContext, expected = integrity('installer fixture')) {
        try { return await downloadOfficialPackage({ version: '0.2.1-rc.2', tarball: `${origin}${endpoint}`, integrity: expected }, file, electronHttpsDownload, op); }
        catch (error) { await rm(file, { force: true }); throw error; }
      } };
    };
    const good = await createFixture('complete', '/redirect');
    await good.download(operation('complete'), integrity('installer fixture'));
    console.log('DSH_DOWNLOAD_PROGRESS fixture-stream-download-complete');
    assert.equal(await readFile(path.join(good.directory, 'package.tgz'), 'utf8'), 'installer fixture');
    for (const [id, endpoint, digest, expected] of [['failed', '/failed', undefined, /HTTP 503/], ['empty', '/empty', undefined, /HTTP 204/], ['truncated', '/truncated', undefined, /./], ['wrong-digest', '/installer', integrity('wrong'), /SHA-512/]] as const) {
      const fixture = await createFixture(id, endpoint);
      await assert.rejects(fixture.download(operation(id), digest), expected);
      assert.deepEqual(await readdir(fixture.directory), []);
      console.log(`DSH_DOWNLOAD_PROGRESS ${id}-verified`);
    }
    const aborted = await createFixture('cancelled', '/slow');
    const controller = new AbortController();
    const transfer = aborted.download(operation('cancelled', controller.signal));
    const rejected = assert.rejects(transfer, /abort|cancel/i);
    const abortTimer = setTimeout(() => controller.abort(new Error('Test download cancelled.')), 150);
    await rejected; clearTimeout(abortTimer);
    assert.deepEqual(await readdir(aborted.directory), []);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(slowConnectionClosed, true);
    const results: Record<string, unknown> = { electron: process.versions.electron, emptyFetchUrlReproduced: true, httpsRedirect: true, downgradeBlocked: true, digestMismatch: true, cancellation: true, incompleteCleanup: true };
    console.log(`DSH_DOWNLOAD_RESULT ${JSON.stringify(results)}`);
    server.closeAllConnections(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error); server.closeAllConnections(); server.close(); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
