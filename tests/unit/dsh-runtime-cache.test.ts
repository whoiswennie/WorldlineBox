import { lstat, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as Disk from '../../src/main/dsh/disk';
import { createPackage } from '@electron/asar';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeService } from '../../src/main/dsh/runtime-service';
import { RuntimeCompatibility, compatibilityContract } from '../../src/main/dsh/runtime-compatibility';
import { inventoryTree, type TreeHashCacheEntry, type TreeInventoryProgress } from '../../src/main/dsh/files';
import type { OperationContext } from '../../src/main/dsh/operations';
import { dshCompatibilityCheckIds, type DshCompatibilityReport } from '../../src/shared/dsh-runtime-compatibility';
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
      if (control.corruptCopy && String(args[1]).startsWith(control.runtimeRoot + path.sep) && path.basename(String(args[1])) === 'DeepSeek Harness.exe') {
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
  const input = path.join(root, 'input'), source = path.join(root, 'asar');
  const host = path.join(source, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host');
  await mkdir(path.join(host, 'lib'), { recursive: true });
  await mkdir(path.join(source, 'dsh', 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  await mkdir(path.join(input, 'resources'), { recursive: true });
  await writeFile(path.join(input, 'DeepSeek Harness.exe'), 'fixture executable');
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.0-rc.2', dependencies: { electron: '44.0.0' } }));
  await writeFile(path.join(source, 'dsh', 'desktop-runtime.json'), JSON.stringify({ platform: 'win32', arch: 'x64', release: { nodeVersion: '24.18.1' } }));
  await writeFile(path.join(host, 'package.json'), JSON.stringify({ version: '0.2.0-rc.2' })); await writeFile(path.join(host, 'lib', 'cli.js'), '// fixture');
  await writeFile(path.join(source, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{}');
  await createPackage(source, path.join(input, 'resources', 'app.asar'));
  await mkdir(path.join(input, 'dependencies'));
  await Promise.all(Array.from({ length: 257 }, (_, index) => writeFile(path.join(input, 'dependencies', `${index}.js`), `module.exports=${index};`)));
  const manager = path.join(root, 'manager'); control.runtimeRoot = path.join(manager, 'runtimes');
  const service = new RuntimeService({ rootPath: manager, sevenZipPath: 'unused', onChanged() {} }); services.push(service); await service.init();
  const progress: TreeInventoryProgress[] = [];
  // The ASAR is a minimal non-executable fixture. Retain the real admission path
  // and full inventory verification; only unrelated native SDK probes are replaced.
  vi.spyOn(RuntimeCompatibility.prototype, 'check').mockImplementation(async (runtime, operation) => {
    await service.verify(runtime.id, operation?.signal, false, value => progress.push(value));
    return report(runtime);
  });
  const operation: OperationContext = { id: 'cache-fixture', signal: new AbortController().signal, update: async () => undefined, log: async () => undefined };
  return { root, input, manager, service, progress, operation };
}
function report(runtime: DshRuntime): DshCompatibilityReport { return { runtimeId: runtime.id, contentSha256: runtime.contentSha256, contract: compatibilityContract(), status: 'passed',
  startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), peers: [], checks: dshCompatibilityCheckIds.map(id => ({ id, status: 'passed', detail: 'fixture' })) }; }
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
  expect(f.progress.at(-1)).toMatchObject({ phase: 'complete', verifiedFiles: runtime.fileCount, cacheHits: runtime.fileCount, verifiedBytes: runtime.byteLength });
  expect(control.targetReads.size).toBe(0); await assertTargetCache(f.manager, runtime);
  f.service.close();
  const restarted = new RuntimeService({ rootPath: f.manager, sevenZipPath: 'unused', onChanged() {} }); services.push(restarted); await restarted.init();
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
  expect(f.progress.at(-1)).toMatchObject({ phase: 'complete', cacheHits: runtime.fileCount }); await assertTargetCache(f.manager, runtime);
  f.service.close();
  const restarted = new RuntimeService({ rootPath: f.manager, sevenZipPath: 'unused', onChanged() {} }); services.push(restarted); await restarted.init();
  const file = path.join(restarted.directory(runtime.id), 'DeepSeek Harness.exe'), before = await lstat(file);
  await writeFile(file, 'fixture executablE'); await utimes(file, before.atime, before.mtime);
  await expect(restarted.verify(runtime.id)).rejects.toThrow('changed');
  expect(await readFile(path.join(f.input, 'DeepSeek Harness.exe'), 'utf8')).toBe('fixture executable');
});

it('rejects a corrupt physical fallback copy before registration rather than trusting staged file fingerprints', async () => {
  const f = await fixture(), original = await inventoryTree(f.input); control.forceCopy = true; control.corruptCopy = true;
  await expect(f.service.import(f.input, 'directory', 'fixture', f.operation)).rejects.toThrow('copy did not match');
  expect(control.copyFaults).toBe(1); expect(f.service.list()).toEqual([]);
  expect(JSON.parse(await readFile(path.join(f.manager, 'runtimes.json'), 'utf8'))).toEqual([]);
  expect((await inventoryTree(f.input)).contentSha256).toBe(original.contentSha256);
});
