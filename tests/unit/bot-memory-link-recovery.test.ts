import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, symlink, realpath, lstat, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { removeOwnedDirectorySync } from '../helpers/remove-owned-test-directory';

const require = createRequire(import.meta.url), roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-memory-link-')) throw new Error('Unexpected fixture path');
  removeOwnedDirectorySync(root);
} });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-memory-link-')); roots.push(root);
  const packageRoot = path.join(root, 'package'), home = path.join(root, 'home');
  await mkdir(path.join(packageRoot, 'lib'), { recursive: true }); await mkdir(path.join(packageRoot, 'upstream/toolbox'), { recursive: true });
  await mkdir(path.join(packageRoot, 'node_modules'), { recursive: true }); await mkdir(path.join(home, 'runtime'), { recursive: true });
  await writeFile(path.join(packageRoot, 'upstream/manifest.json'), '{}');
  await writeFile(path.join(packageRoot, 'lib/workspace.cjs'), await readFile(path.resolve('resources/vcp-memory/lib/workspace.cjs')));
  return { root, home, dependencies: path.join(home, 'runtime/node_modules'), expected: path.join(packageRoot, 'node_modules'),
    workspace: require(path.join(packageRoot, 'lib/workspace.cjs')) as { stageRuntime(home: string): string } };
}
it('repairs a dangling dependency junction from another installation without touching its target', async () => {
  const f = await fixture(), old = path.join(f.root, 'old-install/node_modules');
  await symlink(old, f.dependencies, process.platform === 'win32' ? 'junction' : 'dir');
  expect((await lstat(f.dependencies)).isSymbolicLink()).toBe(true);
  f.workspace.stageRuntime(f.home); expect(await realpath(f.dependencies)).toBe(await realpath(f.expected));
  f.workspace.stageRuntime(f.home); expect(await realpath(f.dependencies)).toBe(await realpath(f.expected));
});
it('replaces an old valid junction while preserving all files in the old installation', async () => {
  const f = await fixture(), old = path.join(f.root, 'old-install/node_modules'); await mkdir(old, { recursive: true });
  await writeFile(path.join(old, 'keep.txt'), 'original'); await symlink(old, f.dependencies, process.platform === 'win32' ? 'junction' : 'dir');
  f.workspace.stageRuntime(f.home); expect(await realpath(f.dependencies)).toBe(await realpath(f.expected));
  expect(await readFile(path.join(old, 'keep.txt'), 'utf8')).toBe('original');
});
it('preserves an old physical dependency directory in a local backup and repairs the runtime link', async () => {
  const f = await fixture(); await mkdir(f.dependencies); await writeFile(path.join(f.dependencies, 'keep.txt'), 'user files');
  f.workspace.stageRuntime(f.home); expect(await realpath(f.dependencies)).toBe(await realpath(f.expected));
  const backups = (await readdir(path.join(f.home, 'runtime'))).filter(name => name.startsWith('.node_modules.previous-'));
  expect(backups).toHaveLength(1); expect(await readFile(path.join(f.home, 'runtime', backups[0]!, 'keep.txt'), 'utf8')).toBe('user files');
});
it('starts resident and one-shot workers with the packaged dependencies available to copied plugins', async () => {
  const f = await fixture();
  const library = path.join(f.root, 'package/lib');
  const plugin = path.join(f.home, 'runtime/Plugin');
  await mkdir(plugin, { recursive: true });
  await mkdir(path.join(f.expected, 'fixture-dependency'));
  await writeFile(path.join(f.expected, 'fixture-dependency/index.js'), 'module.exports = "packaged"');
  await writeFile(path.join(plugin, 'index.cjs'), 'module.exports = require("fixture-dependency")');
  await writeFile(path.join(library, 'client.cjs'), await readFile(path.resolve('resources/vcp-memory/lib/client.cjs')));
  await writeFile(path.join(library, 'worker.cjs'), `
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('line', answer);
    if (!process.argv.includes('--serve')) {
      let input = '';
      process.stdin.on('data', chunk => { input += chunk; });
      process.stdin.on('end', () => answer(input));
    }
    function answer(input) {
      const { id, home } = JSON.parse(input);
      const plugin = require('node:path').join(home, 'runtime/Plugin/index.cjs');
      console.log('\\x1eVCP_MEMORY_JSON:' + JSON.stringify({ id, ok: true, result: require(plugin) }));
    }
  `);
  const client = require(path.join(library, 'client.cjs'));
  const options = { home: f.home, nodePath: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const session = client.createSession(options);
  try { await expect(session.request('status')).resolves.toBe('packaged'); }
  finally { await session.close(); }
  await expect(client.request('status', {}, options)).resolves.toBe('packaged');
});
it('times out even when the upstream ingestion kick never resolves', async () => {
  const { waitForIndex } = require(path.resolve('resources/vcp-memory/lib/index-wait.cjs')) as { waitForIndex(input: object): Promise<void> };
  const start = Date.now();
  await expect(waitForIndex({ timeoutMs: 30, kick: () => new Promise(() => undefined), ready: async () => false, message: 'pending' }))
    .rejects.toMatchObject({ code: 'MEMORY_SYNC_TIMEOUT', diagnostics: { pending: true } });
  expect(Date.now() - start).toBeLessThan(1000);
});

const nativePackage = path.resolve(process.env.WORLDLINEBOX_MEMORY_TEST_PACKAGE ?? '.tools/bot-memory-release/vcp-memory');
const nativeNode = path.resolve(process.env.WORLDLINEBOX_BOT_NODE ?? '.tools/node-v24.15.0-win-x64/node.exe');
it.runIf(existsSync(nativeNode) && existsSync(path.join(nativePackage, 'worldlinebox-integration-manifest.json')))
('indexes existing diary notes with the packaged ESM dependency even if the workspace junction disappears after worker startup', async () => {
  const { home, dependencies } = await fixture();
  let indexed = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (!req.url?.endsWith('/v1/embeddings')) { res.writeHead(404).end(); return; }
    const { input } = JSON.parse(raw);
    const texts = Array.isArray(input) ? input : [input]; indexed += texts.length;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: texts.map((_: unknown, index: number) => ({ index,
      embedding: Array.from({ length: 64 }, (_value, axis) => axis === 0 ? 1 : .01) })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const workspace = require(path.join(nativePackage, 'lib/workspace.cjs'));
  const client = require(path.join(nativePackage, 'lib/client.cjs'));
  workspace.initHome(home, { API_URL: base, API_Key: 'fixture-only', WhitelistEmbeddingModel: 'fixture64', VECTORDB_DIMENSION: 64 });
  let logs = '';
  const session = client.createSession({ home, nodePath: nativeNode, onLog: (line: string) => { logs = (logs + line).slice(-5000); }, env: { EMBEDDING_API_URL: base, EMBEDDING_MODEL: 'fixture64', EMBEDDING_API_KEY: 'fixture-only' } });
  try {
    await session.request('status');
    await session.request('sync');
    expect((await lstat(dependencies)).isSymbolicLink()).toBe(true);
    await unlink(dependencies);
    await mkdir(path.join(home, 'dailynote/Companion'));
    await writeFile(path.join(home, 'dailynote/Companion/pending.txt'), '用于验证旧日记向量索引修复的测试记录。');
    await session.request('sync', {}, { timeoutMs: 12000 });
    expect(indexed).toBeGreaterThan(0);
  } catch (error) {
    throw new Error(logs, { cause: error });
  } finally {
    await session.close().catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 25000);
