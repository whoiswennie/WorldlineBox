import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { detachRuntimeDependencyLinks, removeOwnedDirectory, removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

interface RuntimeFixture {
  runtimeRoot: string;
  dependencyLinks: Array<{ target: string; source: string }>;
  peripherals?: { close(): Promise<void> };
  kb?: { shutdown(): Promise<void> };
  close(): Promise<void>;
}
const cjs = createRequire(import.meta.url)(path.resolve('src/main/vcp-memory/runtime.cjs')) as {
  VcpMemoryRuntime: new () => RuntimeFixture;
  removeOwnedDirectory(root: string): Promise<void>;
};
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeOwnedDirectory(root); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-vcp-link-safety-')); roots.push(root);
  const source = path.join(root, 'external-source'), owned = path.join(root, 'owned'), runtimeRoot = path.join(owned, 'runtime');
  await mkdir(source); await mkdir(runtimeRoot, { recursive: true });
  await writeFile(path.join(source, 'SENTINEL.txt'), 'source directory must survive every cache cleanup');
  const target = path.join(runtimeRoot, 'node_modules');
  await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  return { root, source, owned, runtimeRoot, target };
}
it.each([['TypeScript parent purge', removeOwnedDirectory], ['CommonJS canary cleanup', cjs.removeOwnedDirectory], ['Playwright synchronous cleanup', async (root: string) => removeOwnedDirectorySync(root)]] as const)(
  '%s unlinks nested junctions without entering their external target', async (_label, remove) => {
    const f = await fixture(); await remove(f.owned);
    expect(await readFile(path.join(f.source, 'SENTINEL.txt'), 'utf8')).toContain('must survive');
    await expect(lstat(f.owned)).rejects.toMatchObject({ code: 'ENOENT' });
  });
it.each([removeOwnedDirectory, async (root: string) => removeOwnedDirectorySync(root)])('rejects a junction as the cleanup root and preserves both its target and link', async remove => {
  const f = await fixture(); await expect(remove(f.target)).rejects.toThrow(/real owned directory/u);
  expect((await lstat(f.target)).isSymbolicLink()).toBe(true);
  expect(await readFile(path.join(f.source, 'SENTINEL.txt'), 'utf8')).toContain('must survive');
});
it('detaches the known links of a killed runtime without reading their external source', async () => {
  const f = await fixture(); await detachRuntimeDependencyLinks(f.owned);
  await expect(lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await lstat(f.runtimeRoot)).isDirectory()).toBe(true);
  expect(await readFile(path.join(f.source, 'SENTINEL.txt'), 'utf8')).toContain('must survive');
});
it('detaches validated dependency junctions even if upstream shutdown throws', async () => {
  const f = await fixture(), runtime = new cjs.VcpMemoryRuntime(); runtime.runtimeRoot = f.runtimeRoot;
  runtime.dependencyLinks = [{ target: f.target, source: f.source }];
  runtime.peripherals = { close: vi.fn(async () => { throw new Error('upstream shutdown failed'); }) };
  runtime.kb = { shutdown: vi.fn(async () => undefined) };
  await expect(runtime.close()).rejects.toThrow('upstream shutdown failed');
  expect(runtime.kb).toBeNull(); await expect(lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(f.source, 'SENTINEL.txt'), 'utf8')).toContain('must survive');
});
it('refuses to detach a dependency whose recorded owner target does not match', async () => {
  const f = await fixture(), runtime = new cjs.VcpMemoryRuntime(); runtime.runtimeRoot = f.runtimeRoot;
  runtime.dependencyLinks = [{ target: f.target, source: path.join(f.root, 'unexpected-source') }];
  await expect(runtime.close()).rejects.toThrow(/target changed/u);
  expect((await lstat(f.target)).isSymbolicLink()).toBe(true);
  expect(await readFile(path.join(f.source, 'SENTINEL.txt'), 'utf8')).toContain('must survive');
});
