import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as Disk from '../../src/main/dsh/disk';
import { RuntimeService } from '../../src/main/dsh/runtime-service';
import { RuntimeIntegrity } from '../../src/main/dsh/runtime-integrity';
import { DshTaskPreparationError } from '../../src/main/dsh/task-preparation';
import { writeNativeRuntimeFixture } from '../helpers/dsh-runtime-fixture';
import type { OperationContext } from '../../src/main/dsh/operations';

const control = vi.hoisted(() => ({ root: '', index: '', directory: '', program: '', readDenied: '', directoryDenied: false,
  unsafeDirectory: false, writeDenied: false, deniedReads: 0, transientDenied: '', reads: new Set<string>(), cacheReads: 0, cacheWrites: 0 }));
vi.mock('../../src/main/dsh/disk', async importOriginal => {
  const actual = await importOriginal<typeof Disk>();
  const denied = (file: string) => Object.assign(new Error('Controlled storage access failure.'), { code: 'EACCES', path: file });
  return { ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (control.directoryDenied && String(args[0]) === control.directory) throw denied(control.directory);
      return actual.mkdir(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const result = await actual.lstat(...args);
      if (control.unsafeDirectory && String(args[0]) === control.directory) return { ...result, isDirectory: () => true, isSymbolicLink: () => true };
      return result;
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const filename = String(args[0]);
      if (filename === control.index) control.cacheReads++;
      if (control.program && filename.startsWith(control.program + path.sep)) control.reads.add(filename);
      if (filename === control.readDenied || filename === control.transientDenied && !control.deniedReads) {
        control.deniedReads++; throw denied(filename);
      }
      return actual.readFile(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const filename = String(args[0]);
      if (control.directory && path.dirname(filename) === control.directory) {
        control.cacheWrites++;
        if (control.writeDenied) throw denied(filename);
      }
      return actual.writeFile(...args);
    },
  };
});

const roots: string[] = [], services: RuntimeService[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); for (const service of services.splice(0)) service.close();
  Object.assign(control, { root: '', index: '', directory: '', program: '', readDenied: '', directoryDenied: false,
    unsafeDirectory: false, writeDenied: false, deniedReads: 0, transientDenied: '', reads: new Set(), cacheReads: 0, cacheWrites: 0 });
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-runtime-diagnostics-')); roots.push(root);
  const source = path.join(root, 'source'); await writeNativeRuntimeFixture(source);
  const manager = path.join(root, 'manager'), service = new RuntimeService({ rootPath: manager, onChanged() {} }); services.push(service);
  await service.init();
  const operation: OperationContext = { id: 'diagnostics-fixture', signal: new AbortController().signal, log: async () => undefined, update: async () => undefined };
  const runtime = await service.import(source, 'directory', 'fixture', operation), program = service.directory(runtime.id);
  Object.assign(control, { root: manager, program, directory: path.join(manager, 'integrity'), index: path.join(manager, 'integrity', runtime.id + '.json'),
    reads: new Set(), cacheReads: 0, cacheWrites: 0 });
  return { root, manager, source, service, runtime, program, seal: path.join(path.dirname(program), 'seal.json') };
}

it.each(['bad-json', 'denied-read', 'denied-directory', 'unsafe-directory'] as const)('uses full verified bytes when advisory hash cache is %s', async kind => {
  const f = await fixture();
  if (kind === 'bad-json') await writeFile(control.index, '{broken json');
  if (kind === 'denied-read') control.readDenied = control.index;
  if (kind === 'denied-directory') control.directoryDenied = true;
  if (kind === 'unsafe-directory') control.unsafeDirectory = true;
  await expect(f.service.verify(f.runtime.id)).resolves.toBeUndefined();
  expect(control.reads.size).toBe(f.runtime.fileCount);
  if (kind === 'unsafe-directory' || kind === 'denied-directory') {
    expect(control.cacheReads).toBe(0); expect(control.cacheWrites).toBe(0);
  }
});

it('does not fail a successful full verification when optional cache persistence is denied', async () => {
  const f = await fixture(); control.writeDenied = true;
  await expect(f.service.verify(f.runtime.id, undefined, true)).resolves.toBeUndefined();
  expect(control.reads.size).toBe(f.runtime.fileCount); expect(control.cacheWrites).toBe(1);
});

it('reports bounded real added/missing/changed paths without changing the installed seal or instance data', async () => {
  const f = await fixture(), originalSeal = await readFile(f.seal, 'utf8');
  const verify = vi.spyOn(RuntimeIntegrity.prototype, 'verify');
  const instanceFile = path.join(f.manager, 'instances', 'owned-fixture', 'home', 'save.txt'); await mkdir(path.dirname(instanceFile), { recursive: true }); await writeFile(instanceFile, 'preserve');
  await writeFile(path.join(f.program, 'bin', 'node.exe'), 'edited executable');
  await rm(path.join(f.program, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  for (let index = 0; index < 12; index++) await writeFile(path.join(f.program, `unexpected-${index}.txt`), 'new');
  const error = await f.service.verify(f.runtime.id, undefined, true).catch(value => value) as DshTaskPreparationError;
  expect(error).toBeInstanceOf(DshTaskPreparationError); expect(error.message).toContain('运行文件发生变化或缺失');
  expect(error.diagnostic).toMatchObject({ kind: 'files-changed', runtimeId: f.runtime.id, differences: { added: 12, missing: 1, changed: 1 } });
  expect(error.diagnostic?.differences?.paths).toHaveLength(8); expect(error.message).toContain('bin/node.exe'); expect(error.message).toContain('lib/bin.js');
  expect(error.cause).toBeInstanceOf(Error);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(await readFile(f.seal, 'utf8')).toBe(originalSeal); expect(await readFile(instanceFile, 'utf8')).toBe('preserve');
});

it.runIf(process.platform === 'win32')('retries one transient program-read EACCES and verifies all bytes without trusting advisory hashes', async () => {
  const f = await fixture(); control.transientDenied = path.join(f.program, 'bin', 'node.exe');
  // The first admission must read one uncached entry; the retry must not reuse
  // the otherwise valid index after that entry is temporarily inaccessible.
  const index = JSON.parse(await readFile(control.index, 'utf8'));
  index.entries = index.entries.filter(([relative]: [string]) => relative !== 'bin/node.exe');
  await writeFile(control.index, JSON.stringify(index));
  const verify = vi.spyOn(RuntimeIntegrity.prototype, 'verify');
  await expect(f.service.verify(f.runtime.id)).resolves.toBeUndefined();
  expect(control.deniedReads).toBe(1); expect(verify).toHaveBeenCalledTimes(2);
  expect(verify.mock.calls[1]?.[3]).toBe(true); expect(control.reads.size).toBe(f.runtime.fileCount);
});

it('preserves persistent program-read EACCES and its cause after only one retry', async () => {
  const f = await fixture(); control.readDenied = path.join(f.program, 'bin', 'node.exe');
  const error = await f.service.verify(f.runtime.id, undefined, true).catch(value => value) as DshTaskPreparationError;
  expect(error.diagnostic?.kind).toBe('storage'); expect(error.cause).toMatchObject({ code: 'EACCES', path: control.readDenied });
  expect(control.deniedReads).toBe(process.platform === 'win32' ? 2 : 1);
  expect(error.message).toContain('尚未判定文件损坏'); expect(error.message).not.toContain('Import a clean');
});

it('also preserves mandatory-seal read permissions as storage diagnostics rather than broken metadata', async () => {
  const f = await fixture(); control.readDenied = f.seal;
  const error = await f.service.verify(f.runtime.id).catch(value => value) as DshTaskPreparationError;
  expect(error.diagnostic?.kind).toBe('storage'); expect(error.cause).toMatchObject({ code: 'EACCES', path: f.seal });
  expect(control.reads.size).toBe(0);
});

it('keeps a corrupt mandatory seal distinct from optional cache damage', async () => {
  const f = await fixture(); await writeFile(f.seal, '{broken seal');
  const error = await f.service.verify(f.runtime.id).catch(value => value) as DshTaskPreparationError;
  expect(error.diagnostic?.kind).toBe('manifest'); expect(error.cause).toBeInstanceOf(SyntaxError);
  expect(control.reads.size).toBe(0);
});

it('does not claim program bytes changed when only inventory digest metadata is inconsistent', async () => {
  const f = await fixture(), seal = JSON.parse(await readFile(f.seal, 'utf8'));
  const verify = vi.spyOn(RuntimeIntegrity.prototype, 'verify');
  await writeFile(f.seal, JSON.stringify({ ...seal, contentSha256: '0'.repeat(64) }));
  const error = await f.service.verify(f.runtime.id, undefined, true).catch(value => value) as DshTaskPreparationError;
  expect(error.diagnostic).toMatchObject({ kind: 'manifest', differences: { added: 0, missing: 0, changed: 0 } });
  expect(error.message).toContain('逐项一致'); expect(error.message).not.toContain('运行文件发生变化或缺失');
  expect(verify).toHaveBeenCalledTimes(1);
});

it('recovers once from monitor instability with a forced complete byte check', async () => {
  const f = await fixture(), cause = new Error('运行文件持续发生变化，无法完成完整性检查。');
  const verify = vi.spyOn(RuntimeIntegrity.prototype, 'verify').mockRejectedValueOnce(cause);
  await expect(f.service.verify(f.runtime.id)).resolves.toBeUndefined();
  expect(verify).toHaveBeenCalledTimes(2); expect(verify.mock.calls[1]?.[3]).toBe(true);
  expect(control.reads.size).toBe(f.runtime.fileCount);
});

it('cancels the bounded retry delay without starting another verification', async () => {
  const f = await fixture(), controller = new AbortController(), reason = new DOMException('stop admission', 'AbortError');
  const verify = vi.spyOn(RuntimeIntegrity.prototype, 'verify').mockRejectedValue(new Error('运行文件持续发生变化，无法完成完整性检查。'));
  const admission = f.service.verify(f.runtime.id, controller.signal);
  const timer = setTimeout(() => controller.abort(reason), 20);
  try { await expect(admission).rejects.toMatchObject({ name: 'AbortError', cause: reason }); }
  finally { clearTimeout(timer); }
  expect(verify).toHaveBeenCalledTimes(1); expect(control.reads.size).toBe(0);
});

it.each(['unstable', 'timeout'] as const)('preserves %s monitor/check failure separately from actual file drift', async kind => {
  const f = await fixture(), cause = kind === 'unstable' ? new Error('运行文件持续发生变化，无法完成完整性检查。') : new DOMException('controlled timeout', 'TimeoutError');
  const verify = vi.spyOn(RuntimeIntegrity.prototype, 'verify').mockRejectedValue(cause);
  const error = await f.service.verify(f.runtime.id).catch(value => value) as DshTaskPreparationError;
  expect(error.diagnostic?.kind).toBe(kind); expect(error.cause).toBe(cause); expect(error.message).not.toContain('Import a clean');
  expect(control.reads.size).toBe(0);
  expect(verify).toHaveBeenCalledTimes(kind === 'unstable' ? 2 : 1);
});
