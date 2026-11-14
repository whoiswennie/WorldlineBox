import { writeNativeRuntimeFixture } from '../helpers/dsh-runtime-fixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuntimeService } from '../../src/main/dsh/runtime-service';
import { copyTree, inventoryTree, redact, removeManaged, safeRelative } from '../../src/main/dsh/files';
import { OperationStore } from '../../src/main/dsh/operations';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(tmpdir(), root); });
async function temporary() { const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-dsh-runtime-')); roots.push(root); return root; }

async function fixture(root: string, version: string) {
  const program = path.join(root, `program-${version}`); await writeNativeRuntimeFixture(program, version);
  return program;
}

describe('fixed DSH runtime inventory', () => {
  it.runIf(process.platform === 'win32' && process.arch === 'x64')('accepts a delete with a real Windows sharing lock, keeps it deleted after restart, and reclaims files once released', async () => {
    const root = await temporary();
    const manager = path.join(root, 'manager');
    const service = new RuntimeService({ rootPath: manager, onChanged() {} });
    const operations = new OperationStore(path.join(manager, 'operations'), () => undefined);
    await service.init();
    await operations.init();
    await operations.run('import', 'fixture', undefined, async op => {
      await service.import(await fixture(root, '0.9.0-locked'), 'directory', 'fixture', op);
    });
    await operations.settle();
    const record = service.list()[0]!;
    const runtimeRoot = path.dirname(service.directory(record.id));
    const { default: koffi } = await import('koffi');
    const kernel = koffi.load('kernel32.dll');
    const openDirectory = kernel.func('uintptr_t __stdcall CreateFileW(const str16 file, uint32_t access, uint32_t share, uintptr_t security, uint32_t creation, uint32_t flags, uintptr_t template)');
    const closeHandle = kernel.func('int __stdcall CloseHandle(uintptr_t handle)');
    const lock = openDirectory(runtimeRoot, 0x80000000, 3, 0, 3, 0x02000000, 0);
    expect(BigInt(lock)).not.toBe(0xffffffffffffffffn);
    let open = true;
    const cleanupFinished = vi.fn();
    const reopened = new RuntimeService({ rootPath: manager, onChanged: cleanupFinished });
    try {
      await expect(rename(runtimeRoot, path.join(manager, 'locked-fixture-rename'))).rejects.toMatchObject({ code: expect.stringMatching(/^(EBUSY|EPERM|EACCES)$/) });
      await service.delete(record.id, false);
      expect(service.list()).toEqual([]);
      expect(service.pendingDeletionVersions()).toEqual([record.version]);
      expect((await lstat(runtimeRoot)).isDirectory()).toBe(true);
      await service.close();
      // Emulate interruption immediately after writing the deletion journal.
      await writeFile(path.join(manager, 'runtimes.json'), JSON.stringify([record]));
      await reopened.init();
      expect(reopened.list()).toEqual([]);
      expect(reopened.pendingDeletionVersions()).toEqual([record.version]);
      expect(() => reopened.plan(record.id)).toThrow('not installed');
      await vi.waitFor(() => expect(cleanupFinished).toHaveBeenCalled(), { timeout: 10_000 });
      expect(reopened.pendingDeletionVersions()).toEqual([record.version]);
      closeHandle(lock);
      open = false;
      await vi.waitFor(() => expect(reopened.pendingDeletionVersions()).toEqual([]), { timeout: 20_000 });
      await expect(lstat(runtimeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(path.join(manager, 'runtime-deletions'))).toEqual([]);
      const final = new RuntimeService({ rootPath: manager, onChanged() {} });
      await final.init();
      expect(final.list()).toEqual([]);
      await final.close();
    } finally {
      if (open) closeHandle(lock);
      await service.close();
      await reopened.close();
    }
  });

  it('deletes installed bytes without resurrection, cleans only runtime scratch, and recovers an interrupted removal before the index commit', async () => {
    const root = await temporary(); const manager = path.join(root, 'manager');
    const service = new RuntimeService({ rootPath: manager, onChanged() {} });
    const operations = new OperationStore(path.join(manager, 'operations'), () => undefined);
    await service.init(); await operations.init();
    await operations.run('import', 'fixture', undefined, async op => { await service.import(await fixture(root, '0.9.0-delete'), 'directory', 'fixture', op); });
    await operations.settle(); const runtime = service.list()[0]!;
    await mkdir(path.join(manager, 'shared'), { recursive: true }); await writeFile(path.join(manager, 'shared', 'precious-save'), 'preserve');
    await mkdir(path.join(manager, 'runtime-trash'), { recursive: true });
    await rename(path.dirname(service.directory(runtime.id)), path.join(manager, 'runtime-trash', `${runtime.id}-crash`));
    const recovered = new RuntimeService({ rootPath: manager, onChanged() {} }); await recovered.init();
    expect(recovered.list()).toHaveLength(1); await recovered.verify(runtime.id);
    await recovered.delete(runtime.id, false); expect(recovered.list()).toHaveLength(0);
    await vi.waitFor(() => expect(recovered.pendingDeletionVersions()).toHaveLength(0));
    await recovered.close();
    const restarted = new RuntimeService({ rootPath: manager, onChanged() {} }); await restarted.init(); expect(restarted.list()).toHaveLength(0);
    for (const name of ['staging', 'quarantine', 'runtime-trash']) { await mkdir(path.join(manager, name, 'unused'), { recursive: true }); await writeFile(path.join(manager, name, 'unused', 'scratch'), 'discard'); }
    await mkdir(path.join(manager, 'cache'), { recursive: true }); await writeFile(path.join(manager, 'cache', `${'a'.repeat(64)}.exe`), 'installer'); await writeFile(path.join(manager, 'cache', 'unknown-user-file'), 'preserve');
    await operations.run('runtime.cleanup', 'fixture', undefined, op => restarted.cleanup(op)); await operations.settle();
    expect(operations.list()[0]?.status).toBe('succeeded');
    expect(await readdir(path.join(manager, 'cache'))).toEqual(['unknown-user-file']);
    expect(await readFile(path.join(manager, 'shared', 'precious-save'), 'utf8')).toBe('preserve');
    for (const name of ['staging', 'quarantine', 'runtime-trash']) expect(await readdir(path.join(manager, name))).toEqual([]);
  });
  it('keeps two exact releases independently, deduplicates content, detects drift and preserves source installs', async () => {
    const root = await temporary();
    const service = new RuntimeService({ rootPath: path.join(root, 'manager'), onChanged: () => undefined });
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
    await writeFile(path.join(service.directory(runtime.id), 'bin/node.exe'), 'modified');
    await expect(service.verify(runtime.id)).rejects.toThrow('运行文件发生变化或缺失');
    expect((await inventoryTree(a)).contentSha256).toBe(sourceSeal.contentSha256);
    await expect(service.delete(runtime.id, true)).rejects.toThrow('引用');
    const relaunched = new RuntimeService({ rootPath: path.join(root, 'manager'), onChanged: () => undefined });
    await relaunched.init(); expect(relaunched.list()).toEqual(service.list());
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
