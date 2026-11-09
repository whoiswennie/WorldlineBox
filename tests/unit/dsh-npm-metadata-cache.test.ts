import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { nodeInstallEnvironment, prepareOfficialNodeRuntime, runNodeInstall } from '../../src/main/dsh/node-runtime-service';
import { removeManaged } from '../../src/main/dsh/files';
import type { OperationContext } from '../../src/main/dsh/operations';

it.skipIf(process.platform !== 'win32').each([
  { version: '0.2.2-rc.1', staleMirror: false },
  { version: '9.8.7-rc.99', staleMirror: true },
])('installs $version with cached metadata and mirror lag while reusing verified archives', async ({ version, staleMirror }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-npm-metadata-'));
  const npmCli = path.resolve('resources/portable-tools/win32-x64/node/node_modules/npm/bin/npm-cli.js');
  const tools = { npmCli, nodeExecutable: path.resolve('resources/portable-tools/win32-x64/node/node.exe'), nodeVersion: '24.15.0', npmVersion: '11.12.1' };
  const tar = createRequire(npmCli)('tar') as { c(options: { cwd: string; file: string; gzip: boolean }, files: string[]): Promise<void> };
  const cert = path.resolve('tests/fixtures/dsh-network/npm-cert.pem');
  const archives = new Map<string, Buffer>();
  const manifests = new Map<string, Record<string, unknown>>();
  let published = false; let metadataRequests = 0; let archiveRequests = 0;
  const server = httpsServer({ cert: await readFile(cert), key: await readFile(path.resolve('tests/fixtures/dsh-network/npm-key.pem')) }, (req, res) => {
    const name = decodeURIComponent(req.url!.slice(1));
    if (archives.has(name)) { archiveRequests++; res.end(archives.get(name)); return; }
    metadataRequests++;
    const visible = published && !(staleMirror && req.headers.host === 'registry.npmmirror.com');
    const versions = Object.fromEntries([...manifests.values()].filter(item => item.name === name && (visible || item.version !== '4.1.0')).map(item => [item.version as string, item]));
    res.setHeader('content-type', 'application/json');
    // A fresh cached response also needs revalidation when the next DSH version is installed.
    res.setHeader('cache-control', 'public, max-age=31536000');
    res.end(JSON.stringify({ name, 'dist-tags': { latest: name.endsWith('/cordis') ? visible ? '4.1.0' : '4.0.5' : version }, versions }));
  });
  const proxy = httpServer();
  proxy.on('connect', (_req, socket, head) => {
    const target = connect((server.address() as { port: number }).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); target.write(head); socket.pipe(target); target.pipe(socket);
    });
    socket.on('error', () => target.destroy()); target.on('error', () => socket.destroy()); socket.on('close', () => target.destroy());
  });
  let output = '';
  const operation: OperationContext = { id: 'metadata-cache', signal: AbortSignal.timeout(40_000), update: async () => undefined, log: async value => { output += value; } };
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const registry = staleMirror ? 'https://registry.npmmirror.com' : `https://registry.fixture.test:${(server.address() as { port: number }).port}`;
    for (const [name, packageVersion] of [['dsh', version], ['dsh-base', version], ['dsh-web-app', version], ['dsh-headless', version], ['cordis', '4.0.5'], ['cordis', '4.1.0']]) {
      const source = path.join(root, `${name}-${packageVersion}`);
      await mkdir(path.join(source, 'package', 'lib'), { recursive: true });
      const manifest = { name: `@deepseek-ai/${name}`, version: packageVersion, ...(name === 'dsh' ? {
        type: 'module', bin: { dsh: 'lib/bin.js' }, repository: { url: 'git+https://github.com/deepseek-ai/deepseek-harness.git' },
        dependencies: { '@deepseek-ai/cordis': '~4.1.0', ...Object.fromEntries(['dsh-base', 'dsh-web-app', 'dsh-headless'].map(core => [`@deepseek-ai/${core}`, version])) },
      } : {}) };
      await writeFile(path.join(source, 'package', 'package.json'), JSON.stringify(manifest));
      await writeFile(path.join(source, 'package', 'lib', 'bin.js'), 'console.log("fixture");');
      const archive = path.join(source, 'package.tgz');
      await tar.c({ cwd: source, file: archive, gzip: true }, ['package']);
      const bytes = await readFile(archive); const location = `@deepseek-ai/${name}/-/${name}-${packageVersion}.tgz`;
      archives.set(location, bytes);
      manifests.set(`${name}@${packageVersion}`, { ...manifest, dist: { tarball: `${registry}/${location}`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } });
    }
    const envWithProxy = { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, NO_PROXY: '', NODE_EXTRA_CA_CERTS: cert };
    const network = { registry, env: envWithProxy, ...(staleMirror ? { fallback: { registry: 'https://registry.npmjs.org', env: envWithProxy } } : {}) };
    const cache = path.join(root, 'cache'); const seed = path.join(root, 'seed'); await mkdir(seed);
    const env = await nodeInstallEnvironment(seed, tools, network, cache);
    // Seed the previous version directory, then publish the dependency required by the new CLI.
    await runNodeInstall(tools, ['view', '@deepseek-ai/cordis', 'versions', '--json'], seed, env, operation);
    published = true;
    const before = metadataRequests;
    await expect(runNodeInstall(tools, ['view', '@deepseek-ai/cordis@~4.1.0', 'version'], seed, env, operation)).rejects.toThrow('E404');
    expect(metadataRequests).toBe(before);
    const cli = manifests.get(`dsh@${version}`)!;
    const release = { version, tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`, integrity: (cli.dist as { integrity: string }).integrity };
    const bytes = archives.get(`@deepseek-ai/dsh/-/dsh-${version}.tgz`)!;
    for (let attempt = 0; attempt < 2; attempt++) {
      const staging = path.join(root, `install-${attempt}`); const program = path.join(staging, 'program');
      await prepareOfficialNodeRuntime({ release, staging, program, tools, network: async () => network,
        fetch: async () => new Response(Uint8Array.from(bytes)), operation, contentCache: cache });
      const installed = JSON.parse(await readFile(path.join(program, 'dsh/node_modules/@deepseek-ai/cordis/package.json'), 'utf8'));
      expect(installed.version).toBe('4.1.0');
      expect(archiveRequests).toBe(4); // The second installation reuses every SRI-verified archive.
    }
    expect(metadataRequests).toBeGreaterThan(before);
    expect(output).toContain('4 unique');
    if (staleMirror) expect(output.match(/retrying once/g)).toHaveLength(2);
  } finally {
    proxy.closeAllConnections(); proxy.close(); server.closeAllConnections(); server.close();
    await removeManaged(tmpdir(), root);
  }
}, 50_000);
