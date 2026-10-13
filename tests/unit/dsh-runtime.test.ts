import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPackage } from '@electron/asar';
import { RuntimeService, validate7zListing } from '../../src/main/dsh/runtime-service';
import { copyTree, inventoryTree, redact, removeManaged, safeRelative } from '../../src/main/dsh/files';
import { OperationStore } from '../../src/main/dsh/operations';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(tmpdir(), root); });
async function temporary() { const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-dsh-runtime-')); roots.push(root); return root; }

async function fixture(root: string, version: string) {
  const program = path.join(root, `program-${version}`); const source = path.join(root, `asar-${version}`);
  await mkdir(path.join(source, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host'), { recursive: true });
  await mkdir(path.join(source, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib'), { recursive: true });
  await writeFile(path.join(source, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'), '// fixture');
  await mkdir(path.join(source, 'dsh', 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  await mkdir(path.join(program, 'resources'), { recursive: true });
  await writeFile(path.join(program, 'DeepSeek Harness.exe'), 'fixture executable');
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version, dependencies: { electron: '44.0.0' } }));
  await writeFile(path.join(source, 'dsh', 'desktop-runtime.json'), JSON.stringify({ platform: 'win32', arch: 'x64', release: { nodeVersion: '24.18.1' } }));
  for (const name of ['dsh', 'dsh-desktop-host']) await writeFile(path.join(source, 'dsh', 'node_modules', '@deepseek-ai', name, 'package.json'), JSON.stringify({ name, version }));
  await createPackage(source, path.join(program, 'resources', 'app.asar'));
  return program;
}

describe('fixed DSH runtime inventory', () => {
  it('keeps two exact releases independently, deduplicates content, detects drift and preserves source installs', async () => {
    const root = await temporary();
    const service = new RuntimeService({ rootPath: path.join(root, 'manager'), sevenZipPath: 'unused', onChanged: () => undefined });
    const operations = new OperationStore(path.join(root, 'manager', 'operations'), () => undefined);
    await service.init(); await operations.init();
    const a = await fixture(root, '0.2.0-rc.2'); const b = await fixture(root, '0.3.0-test');
    for (const source of [a, b, a]) {
      await operations.run('import', 'fixture', undefined, async op => { await service.import(source, 'directory', 'test-fixture', op); });
      await operations.settle();
      expect(operations.list()[0]?.status).toBe('succeeded');
    }
    expect(service.list().map(value => value.version)).toEqual(['0.2.0-rc.2', '0.3.0-test']);
    const runtime = service.list()[0]!;
    await service.verify(runtime.id);
    const sourceSeal = await inventoryTree(a);
    await writeFile(path.join(service.directory(runtime.id), 'DeepSeek Harness.exe'), 'modified');
    await expect(service.verify(runtime.id)).rejects.toThrow('changed');
    expect((await inventoryTree(a)).contentSha256).toBe(sourceSeal.contentSha256);
    await expect(service.delete(runtime.id, true)).rejects.toThrow('used');
    const relaunched = new RuntimeService({ rootPath: path.join(root, 'manager'), sevenZipPath: 'unused', onChanged: () => undefined });
    await relaunched.init(); expect(relaunched.list()).toEqual(service.list());
  });

  it('rejects installer traversal, links and case collisions before extraction', () => {
    const listing = (entries: string) => `Path = installer.exe\nType = 7z\n\n----------\n${entries}`;
    expect(() => validate7zListing(listing('Path = resources/app.asar\nSize = 100\n'))).not.toThrow();
    for (const name of ['../escape', 'C:/outside', 'foo:stream', 'CON', 'folder/trailing.']) expect(() => validate7zListing(listing(`Path = ${name}\nSize = 1\n`))).toThrow();
    expect(() => validate7zListing(listing('Path = A\nSize = 1\n\nPath = a\nSize = 1\n'))).toThrow('colliding');
    expect(() => validate7zListing(listing('Path = link\nSymbolic Link = ../../outside\n'))).toThrow('links');
  });

  it('does not interpret launch URLs or filesystem identities as harmless display text', async () => {
    expect(redact('dsh web: http://127.0.0.1:1234/?opaque-secret')).not.toContain('opaque-secret');
    for (const name of ['../../foo', '\\server\\share', 'C:\\foo', 'a/b:secret']) expect(() => safeRelative(name)).toThrow();
    const root = await temporary(); await mkdir(path.join(root, 'data')); await writeFile(path.join(root, 'data', 'marker'), 'a');
    await copyTree(path.join(root, 'data'), path.join(root, 'copy'));
    expect((await inventoryTree(path.join(root, 'copy'))).contentSha256).toBe((await inventoryTree(path.join(root, 'data'))).contentSha256);
    await expect(removeManaged(root, root)).rejects.toThrow('outside');
  });

  it('recovers interrupted operations without treating incomplete staging as success', async () => {
    const root = await temporary(); await writeFile(path.join(root, 'operations.json'), JSON.stringify([{ id: 'test-id', kind: 'import', label: 'test', status: 'running', phase: 'copying', startedAt: new Date().toISOString() }]));
    const operations = new OperationStore(root, () => undefined); await operations.init();
    expect(operations.list()[0]?.status).toBe('interrupted');
  });
});
