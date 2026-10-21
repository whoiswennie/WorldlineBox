import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { InstanceService, type RuntimeServiceLike } from '../../src/main/dsh/instance-service';
import { OperationStore } from '../../src/main/dsh/operations';
import { RuntimeService } from '../../src/main/dsh/runtime-service';
import { RuntimeCompatibility, compatibilityContract } from '../../src/main/dsh/runtime-compatibility';
import { dshCompatibilityCheckIds, type DshCompatibilityReport } from '../../src/shared/dsh-runtime-compatibility';
import type { DshRuntime } from '../../src/shared/dsh-launcher';

const audit = vi.hoisted(() => ({ enabled: false, active: 0, peak: 0, paths: new Set<string>(),
  slowPath: '', releaseWhen: '', aliasFirst: false, release: undefined as (() => void) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof FsPromises>();
  return { ...original, lstat: async (...args: Parameters<typeof original.lstat>) => {
    if (!audit.enabled) return original.lstat(...args);
    audit.active++; audit.peak = Math.max(audit.peak, audit.active); audit.paths.add(String(args[0]));
    try {
      if (String(args[0]) === audit.slowPath) await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, 2000);
        audit.release = () => { clearTimeout(timeout); resolve(); };
      });
      if (String(args[0]) === audit.releaseWhen && audit.release) { audit.aliasFirst = true; audit.release(); audit.release = undefined; }
      await new Promise(resolve => setTimeout(resolve, 2)); return await original.lstat(...args);
    }
    finally { audit.active--; }
  } };
});

const roots: string[] = [], services: RuntimeService[] = [], instances: InstanceService[] = [];
afterEach(async () => {
  audit.enabled = false; audit.release?.(); audit.release = undefined; audit.slowPath = ''; audit.releaseWhen = ''; audit.aliasFirst = false; vi.restoreAllMocks();
  for (const service of instances.splice(0)) await service.shutdown();
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temporary() { const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-startup-admissions-')); roots.push(root); return root; }
const runtime: DshRuntime = { id: 'runtime-fixture', version: '0.2.0-rc.2', nodeVersion: process.version, electronVersion: 'test', adapter: 'desktop-cli-web-v1', platform: 'win32-x64',
  source: 'fixture', sourceSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), installedAt: new Date().toISOString(), fileCount: 1, byteLength: 1 };

it('audits every file in a growing instance cache with bounded parallel I/O and still rejects external cache junctions', async () => {
  const root = await temporary(), program = path.join(root, 'program'); await mkdir(program);
  const runtimes: RuntimeServiceLike = { list: () => [runtime], get: () => runtime, directory: () => program,
    plan: () => ({ executable: process.execPath, cli: path.join(program, 'unused.cjs'), env: {} }), verify: async () => undefined };
  const operations = new OperationStore(path.join(root, 'operations'), () => undefined); await operations.init();
  const service = new InstanceService({ rootPath: root, runtimes, operations, onChanged() {}, openWorkbench: async () => undefined,
    closeWorkbench: async () => undefined, clearBrowserData: async () => undefined }); instances.push(service); await service.init();
  const instance = await service.create('Large cache audit', runtime.id), cache = path.join(service.getRoot(instance.id), 'cache', 'pnpm-store');
  const files: string[] = [];
  await Promise.all(Array.from({ length: 32 }, async (_, group) => {
    const directory = path.join(cache, `package-${group}`); await mkdir(directory, { recursive: true });
    await Promise.all(Array.from({ length: 32 }, async (_, index) => { const file = path.join(directory, `file-${index}.bin`); files.push(file); await writeFile(file, 'unchanged dependency'); }));
  }));
  audit.paths.clear(); audit.peak = 0; audit.enabled = true;
  const checked = await service.handle({ type: 'instance.check', instanceId: instance.id }); expect(checked.ok).toBe(true); await operations.settle();
  audit.enabled = false;
  expect(operations.list()[0]?.status).toBe('succeeded');
  expect(files.filter(file => audit.paths.has(file))).toHaveLength(1024);
  expect(audit.peak).toBeGreaterThan(1); expect(audit.peak).toBeLessThanOrEqual(32); expect(audit.active).toBe(0);
  const external = await temporary(); await writeFile(path.join(external, 'outside'), 'must not be traversed');
  await symlink(external, path.join(cache, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  audit.paths.clear(); audit.enabled = true;
  expect((await service.handle({ type: 'instance.check', instanceId: instance.id })).ok).toBe(true); await operations.settle(); audit.enabled = false;
  expect(operations.list()[0]?.status).toBe('failed'); expect(operations.list()[0]?.error).toContain('external path');
  expect(audit.paths.has(path.join(external, 'outside'))).toBe(false); expect(audit.active).toBe(0);
});

it('checks home configuration even when a cache junction reaches the same directory first, and breaks internal alias cycles', async () => {
  const root = await temporary(), program = path.join(root, 'program'); await mkdir(program);
  const runtimes: RuntimeServiceLike = { list: () => [runtime], get: () => runtime, directory: () => program,
    plan: () => ({ executable: process.execPath, cli: path.join(program, 'unused.cjs'), env: {} }), verify: async () => undefined };
  const operations = new OperationStore(path.join(root, 'operations'), () => undefined); await operations.init();
  const service = new InstanceService({ rootPath: root, runtimes, operations, onChanged() {}, openWorkbench: async () => undefined,
    closeWorkbench: async () => undefined, clearBrowserData: async () => undefined }); instances.push(service); await service.init();
  const instance = await service.create('Aliases', runtime.id), homeSettings = path.join(instance.homePath, 'settings');
  const file = path.join(homeSettings, 'config.json'), cache = path.join(service.getRoot(instance.id), 'cache'), outside = await temporary();
  await mkdir(homeSettings); await writeFile(file, JSON.stringify({ agentsHome: outside }));
  await symlink(homeSettings, path.join(cache, 'settings-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(cache, path.join(cache, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  audit.slowPath = homeSettings; audit.releaseWhen = file; audit.enabled = true;
  expect((await service.handle({ type: 'instance.check', instanceId: instance.id })).ok).toBe(true); await operations.settle(); audit.enabled = false;
  expect(audit.aliasFirst).toBe(true); expect(audit.active).toBe(0);
  expect(operations.list()[0]?.status).toBe('failed'); expect(operations.list()[0]?.error).toContain('outside');
});

it('shares pending compatibility admissions but retries after both a rejected check and a failed report', async () => {
  const root = await temporary(), service = new RuntimeService({ rootPath: root, sevenZipPath: 'unused', onChanged() {} }); services.push(service); await service.init();
  vi.spyOn(service, 'get').mockReturnValue(runtime);
  const report = (passed: boolean): DshCompatibilityReport => ({ runtimeId: runtime.id, contentSha256: runtime.contentSha256, contract: compatibilityContract(),
    status: passed ? 'passed' : 'failed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), peers: [],
    checks: dshCompatibilityCheckIds.map(id => ({ id, status: passed ? 'passed' : 'failed', detail: passed ? 'fixture evidence' : 'transient failure' })) });
  let rejectFirst!: (error: Error) => void;
  const check = vi.spyOn(RuntimeCompatibility.prototype, 'check').mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
  const first = Promise.allSettled([service.assertSharedCompatible(runtime.id), service.assertSharedCompatible(runtime.id)]);
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1)); rejectFirst(Error('temporary preparation failure'));
  expect((await first).every(result => result.status === 'rejected' && String(result.reason).includes('temporary preparation failure'))).toBe(true);
  check.mockImplementationOnce(async () => { const failed = report(false); await writeFile(path.join(root, 'compatibility', runtime.id + '.json'), JSON.stringify(failed)); return failed; });
  await expect(service.assertSharedCompatible(runtime.id)).rejects.toThrow('尚未通过'); expect(check).toHaveBeenCalledTimes(2);
  let release!: () => void;
  check.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); const passed = report(true);
    await writeFile(path.join(root, 'compatibility', runtime.id + '.json'), JSON.stringify(passed)); return passed; });
  const retried = Promise.all([service.assertSharedCompatible(runtime.id), service.assertSharedCompatible(runtime.id)]);
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(3)); release(); await retried;
  expect(check).toHaveBeenCalledTimes(3);
});
