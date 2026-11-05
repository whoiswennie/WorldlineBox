import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, symlink, realpath, lstat, readdir } from 'node:fs/promises';
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
it('times out even when the upstream ingestion kick never resolves', async () => {
  const { waitForIndex } = require(path.resolve('resources/vcp-memory/lib/index-wait.cjs')) as { waitForIndex(input: object): Promise<void> };
  const start = Date.now();
  await expect(waitForIndex({ timeoutMs: 30, kick: () => new Promise(() => undefined), ready: async () => false, message: 'pending' }))
    .rejects.toMatchObject({ code: 'MEMORY_SYNC_TIMEOUT', diagnostics: { pending: true } });
  expect(Date.now() - start).toBeLessThan(1000);
});
