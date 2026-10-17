import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { nodeInstallEnvironment, runNodeInstall } from '../../src/main/dsh/node-runtime-service';
import { npmPrefetchSource } from '../../src/main/dsh/npm-prefetch';
import { removeManaged } from '../../src/main/dsh/files';
import type { OperationContext } from '../../src/main/dsh/operations';

it.skipIf(process.platform !== 'win32')('uses the real npm HTTPS proxy, fetches duplicate archives once, reuses cache and rejects bad SRI', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-npm-prefetch-'));
  const cert = path.resolve('tests/fixtures/dsh-network/npm-cert.pem');
  let bytes = Buffer.alloc(32 * 1024, 'dependency fixture');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  let requests = 0; let tunnels = 0;
  let compareRoutes = false; let fallbackSeen = false;
  const server = httpsServer({ cert: await readFile(cert), key: await readFile(path.resolve('tests/fixtures/dsh-network/npm-key.pem')) }, (req, res) => {
    requests++;
    if(compareRoutes && req.headers.host === 'registry.npmmirror.com' && req.url === '/fallback.tgz') { res.writeHead(503); res.end('unavailable'); return; }
    if(req.url === '/fallback.tgz') fallbackSeen = true;
    if(compareRoutes && req.headers.host !== 'registry.npmmirror.com') { setTimeout(()=>res.end(bytes),200); return; }
    res.end(bytes);
  });
  const proxy = httpServer();
  proxy.on('connect', (_req, socket, head) => {
    tunnels++;
    const target = connect((server.address() as { port: number }).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); target.write(head); socket.pipe(target); target.pipe(socket);
    });
    socket.on('error', () => target.destroy()); target.on('error', () => socket.destroy()); socket.on('close', () => target.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const url = `https://registry.fixture.test:${(server.address() as { port: number }).port}/same.tgz`;
    const packages = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`node_modules/parent-${i}/node_modules/same`, { resolved: url, integrity }]));
    packages['node_modules/foreign'] = { resolved: url.replace('same', 'unsupported'), integrity, os: ['linux'] } as typeof packages[string];
    const install = path.join(root, 'install'); await mkdir(install);
    await writeFile(path.join(install, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
    const npmCli = path.resolve('resources/portable-tools/win32-x64/node/node_modules/npm/bin/npm-cli.js');
    const tools = { npmCli, nodeExecutable: path.resolve('resources/portable-tools/win32-x64/node/node.exe'), nodeVersion: '24.15.0', npmVersion: '11.12.1' };
    const helper = path.join(root, 'prefetch.cjs'); await writeFile(helper, npmPrefetchSource(npmCli));
    const staging = path.join(root, 'staging'); await mkdir(staging);
    const env = await nodeInstallEnvironment(staging, tools, { registry: url.replace('/same.tgz',''), env: { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, NO_PROXY: '', NODE_EXTRA_CA_CERTS: cert } }, path.join(root, 'content-cache'));
    let output = '';
    const operation: OperationContext = { id:'fixture',signal:AbortSignal.timeout(30_000),update:async()=>undefined,log:async value=>{ output += value; } };
    await runNodeInstall({ ...tools, npmCli: helper }, [], install, env, operation);
    expect(requests).toBe(1); expect(tunnels).toBe(1); expect(output).toContain('1 unique / 150 locations');
    await runNodeInstall({ ...tools, npmCli: helper }, [], install, env, operation);
    expect(requests).toBe(1); // Second installation performs no dependency network request.
    packages['node_modules/parent-0/node_modules/same']!.integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
    await writeFile(path.join(install, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
    await expect(runNodeInstall({ ...tools, npmCli: helper }, [], install, env, operation)).rejects.toThrow(/integrity|EINTEGRITY/);
    compareRoutes = true; bytes = Buffer.alloc(48 * 1024, 'mirror route fixture'); output = '';
    const newIntegrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const mirrorPackages = {
      'node_modules/sample': { resolved:'https://registry.npmjs.org/probe.tgz',integrity:newIntegrity },
      'node_modules/fallback': { resolved:'https://registry.npmjs.org/fallback.tgz',integrity:newIntegrity },
    };
    await writeFile(path.join(install,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:mirrorPackages}));
    await writeFile(helper,npmPrefetchSource(npmCli,'https://registry.npmmirror.com'));
    // Keep this synthetic registry host canonical so the local CONNECT proxy receives both routes.
    await runNodeInstall({ ...tools,npmCli:helper },[],install,{...env,npm_config_registry:'https://registry.npmjs.org'},operation);
    expect(output).toContain('Dependency archive route: https://registry.npmmirror.com');
    // A cache hit may satisfy fallback without HTTP; a different SRI forces the route fallback below.
    bytes = Buffer.alloc(16 * 1024,'fallback fixture');
    mirrorPackages['node_modules/fallback'].integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    await writeFile(path.join(install,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:mirrorPackages}));
    await runNodeInstall({ ...tools,npmCli:helper },[],install,{...env,npm_config_registry:'https://registry.npmjs.org'},operation);
    expect(fallbackSeen).toBe(true);
  } finally {
    proxy.closeAllConnections(); proxy.close(); server.closeAllConnections(); server.close();
    await removeManaged(tmpdir(), root);
  }
}, 40_000);
