import { lstat, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as Disk from '../../src/main/dsh/disk';
import { writeNativeRuntimeFixture } from '../helpers/dsh-runtime-fixture';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeService } from '../../src/main/dsh/runtime-service';
import { inventoryTree, type TreeHashCacheEntry, type TreeInventoryProgress } from '../../src/main/dsh/files';
import type { OperationContext } from '../../src/main/dsh/operations';
import type { DshRuntime } from '../../src/shared/dsh-launcher';

const control = vi.hoisted(() => ({ runtimeRoot: '', forceCopy: false, copyFaults: 0, corruptCopy: false, targetReads: new Map<string, number>() }));
vi.mock('../../src/main/dsh/disk', async importOriginal => {
  const actual = await importOriginal<typeof Disk>();
  return { ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (control.forceCopy && path.basename(String(args[0])) === 'artifact' && path.dirname(String(args[1])) === control.runtimeRoot) {
        control.forceCopy = false; control.copyFaults++;
        throw Object.assign(Error('controlled cross-device artifact rename'), { code: 'EXDEV' });
      }
      return actual.rename(...args);
    },
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      await actual.copyFile(...args);
      if (control.corruptCopy && String(args[1]).startsWith(control.runtimeRoot + path.sep) && path.basename(String(args[1])) === 'node.exe') {
        control.corruptCopy = false; await actual.writeFile(args[1], 'fixture executablE');
      }
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const file = String(args[0]);
      if (control.runtimeRoot && file.startsWith(control.runtimeRoot + path.sep) && file.includes(path.sep + 'program' + path.sep)) {
        control.targetReads.set(file, (control.targetReads.get(file) ?? 0) + 1);
      }
      return actual.readFile(...args);
    },
  };
});

const roots: string[] = [], services: RuntimeService[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); for (const service of services.splice(0)) service.close();
  control.runtimeRoot = ''; control.forceCopy = false; control.corruptCopy = false; control.copyFaults = 0; control.targetReads.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-runtime-cache-')); roots.push(root);
  const input = path.join(root, 'input'); await writeNativeRuntimeFixture(input);
  await mkdir(path.join(input, 'dependencies'));
  await Promise.all(Array.from({ length: 257 }, (_, index) => writeFile(path.join(input, 'dependencies', `${index}.js`), `module.exports=${index};`)));
  const manager = path.join(root, 'manager'); control.runtimeRoot = path.join(manager, 'runtimes');
  const service = new RuntimeService({ rootPath: manager, onChanged() {} }); services.push(service); await service.init();
  const progress: TreeInventoryProgress[] = [];
  const operation: OperationContext = { id: 'cache-fixture', signal: new AbortController().signal, update: async () => undefined, log: async () => undefined };
  return { root, input, manager, service, progress, operation };
}
async function assertTargetCache(manager: string, runtime: DshRuntime) {
  const index = JSON.parse(await readFile(path.join(manager, 'integrity', runtime.id + '.json'), 'utf8')) as { digest: string; entries: Array<[string, TreeHashCacheEntry]> };
  expect(index.digest).toBe(runtime.contentSha256); expect(index.entries).toHaveLength(runtime.fileCount);
  for (const [relative, value] of index.entries) {
    const stat = await lstat(path.join(manager, 'runtimes', runtime.id, 'program', relative));
    expect(value.fingerprint).toBe(JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.dev]));
  }
}

it('primes renamed sealed file identities for the first normal verification and reuses them after restart while forced checks still read every byte', async () => {
  const f = await fixture(), runtime = await f.service.import(f.input, 'directory', 'fixture', f.operation);
  await f.service.verify(runtime.id, undefined, false, value => f.progress.push(value));
  expect(f.progress.at(-1)).toMatchObject({ phase: 'complete', verifiedFiles: runtime.fileCount, cacheHits: runtime.fileCount, verifiedBytes: runtime.byteLength });
  expect(control.targetReads.size).toBe(0); await assertTargetCache(f.manager, runtime);
  f.service.close();
  const restarted = new RuntimeService({ rootPath: f.manager, onChanged() {} }); services.push(restarted); await restarted.init();
  const progress: TreeInventoryProgress[] = [];
  await restarted.verify(runtime.id, undefined, false, value => progress.push(value));
  expect(progress.at(-1)).toMatchObject({ phase: 'complete', fileCount: runtime.fileCount, verifiedFiles: runtime.fileCount, cacheHits: runtime.fileCount });
  expect(control.targetReads.size).toBe(0);
  await restarted.verify(runtime.id, undefined, true, value => progress.push(value));
  expect(progress.at(-1)).toMatchObject({ phase: 'complete', verifiedFiles: runtime.fileCount, cacheHits: 0 });
  expect(control.targetReads.size).toBe(runtime.fileCount);
  expect([...control.targetReads.values()].every(count => count === 1)).toBe(true);
});

it('hashes every copied target after EXDEV, caches target identities and detects same-size edits even with the original mtime restored', async () => {
  const f = await fixture(); control.forceCopy = true;
  const runtime = await f.service.import(f.input, 'directory', 'fixture', f.operation);
  expect(control.copyFaults).toBe(1); expect(control.targetReads.size).toBe(runtime.fileCount);
  expect([...control.targetReads.values()].every(count => count === 1)).toBe(true);
  await f.service.verify(runtime.id, undefined, false, value => f.progress.push(value));
  expect(f.progress.at(-1)).toMatchObject({ phase: 'complete', cacheHits: runtime.fileCount }); await assertTargetCache(f.manager, runtime);
  f.service.close();
  const restarted = new RuntimeService({ rootPath: f.manager, onChanged() {} }); services.push(restarted); await restarted.init();
  const file = path.join(restarted.directory(runtime.id), 'bin/node.exe'), before = await lstat(file);
  await writeFile(file, 'fixture executablE'); await utimes(file, before.atime, before.mtime);
  await expect(restarted.verify(runtime.id)).rejects.toThrow('changed');
  expect(await readFile(path.join(f.input, 'bin/node.exe'), 'utf8')).toBe('fixture executable');
});

it('rejects a corrupt physical fallback copy before registration rather than trusting staged file fingerprints', async () => {
  const f = await fixture(), original = await inventoryTree(f.input); control.forceCopy = true; control.corruptCopy = true;
  await expect(f.service.import(f.input, 'directory', 'fixture', f.operation)).rejects.toThrow('copy did not match');
  expect(control.copyFaults).toBe(1); expect(f.service.list()).toEqual([]);
  expect(JSON.parse(await readFile(path.join(f.manager, 'runtimes.json'), 'utf8'))).toEqual([]);
  expect((await inventoryTree(f.input)).contentSha256).toBe(original.contentSha256);
});
