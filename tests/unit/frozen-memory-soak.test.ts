import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { freezeMemorySoakImplementation } from '../fixtures/frozen-memory-soak';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

const roots: string[] = [], sha = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(async () => { for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('frozen-memory-soak-')) throw Error('Unsafe cleanup');
  await removeOwnedDirectory(root);
} });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'frozen-memory-soak-')); roots.push(root);
  const repository = path.join(root, 'repo'), run = path.join(root, 'run');
  for (const directory of ['src/main/vcp-memory/nested', 'tests', 'scripts', 'vendor/vcp-memory']) await mkdir(path.join(repository, directory), { recursive: true });
  await mkdir(run); await writeFile(path.join(repository, 'package.json'), '{"name":"isolated-soak-fixture"}'); await writeFile(path.join(repository, 'package-lock.json'), '{"lockfileVersion":3}');
  await symlink(path.resolve('node_modules'), path.join(repository, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const host = path.join(repository, 'src/main/vcp-memory');
  for (const name of ['worker.cjs', 'cold-worker.cjs', 'runtime.cjs', 'nested/later-required.cjs']) await writeFile(path.join(host, name), 'module.exports="frozen v1";');
  await writeFile(path.join(repository, 'src/main.ts'), 'export const version = 1;');
  const vendor = path.join(repository, 'vendor/vcp-memory');
  await writeFile(path.join(vendor, 'upstream.js'), 'module.exports = 1;');
  for (const name of ['upstream-manifest.json', 'peripheral-manifest.json']) await writeFile(path.join(vendor, name), JSON.stringify({ repository: 'synthetic-fixture', commit: 'a'.repeat(40),
    files: [{ path: 'upstream.js', bytes: Buffer.byteLength('module.exports = 1;'), sha256: sha('module.exports = 1;') }] }));
  return { root, repository, run, host, vendor };
}
it('freezes the entire host CJS tree and actual vendor manifest, records loaded code identity and detects source drift', async () => {
  const f = await fixture(), frozen = await freezeMemorySoakImplementation({ fixtureRoot: f.run, repositoryRoot: f.repository, loadedImplementation: { example: () => 1 } });
  expect(frozen.manifest.hostCjs.map(file => file.path)).toContain('nested/later-required.cjs');
  expect(frozen.manifest.vendorManifests).toHaveLength(2); expect(frozen.manifest.loadedImplementation.example).toHaveLength(64);
  expect(frozen.manifest.dependencies.nodeModules).toBe(path.resolve('node_modules')); await frozen.verifyFrozen(); await frozen.verifySources();
  await writeFile(path.join(f.host, 'runtime.cjs'), 'module.exports="changed source v2";');
  expect(await readFile(path.join(frozen.root, 'host/runtime.cjs'), 'utf8')).toBe('module.exports="frozen v1";');
  await frozen.verifyFrozen(); await expect(frozen.verifySources()).rejects.toThrow('Source changed');
  expect(() => frozen.beforeLaunch(path.join(f.host, 'worker.cjs'))).toThrow('outside the frozen host tree');
  expect(() => frozen.beforeLaunch(frozen.workerPath)).not.toThrow();
});
it('refuses a changed frozen host, a corrupt actual vendor manifest and an uncommitted final run', async () => {
  const f = await fixture(), frozen = await freezeMemorySoakImplementation({ fixtureRoot: f.run, repositoryRoot: f.repository });
  await chmod(frozen.workerPath, 0o644); await writeFile(frozen.workerPath, 'module.exports="tampered";');
  expect(() => frozen.beforeLaunch(frozen.workerPath)).toThrow('changed'); await expect(frozen.verifyFrozen()).rejects.toThrow('Frozen implementation changed');
  const another = await fixture(); await writeFile(path.join(another.vendor, 'upstream.js'), 'tampered vendor');
  await expect(freezeMemorySoakImplementation({ fixtureRoot: another.run, repositoryRoot: another.repository })).rejects.toThrow('Vendored manifest mismatch');
  const uncommitted = await fixture(); await expect(freezeMemorySoakImplementation({ fixtureRoot: uncommitted.run, repositoryRoot: uncommitted.repository, requireClean: true }))
    .rejects.toThrow('clean committed');
});
