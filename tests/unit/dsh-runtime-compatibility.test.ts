import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuntimeCompatibility, compatibilityContract, readRuntimeCompatibility } from '../../src/main/dsh/runtime-compatibility';
import { supportsSharedDataRuntime } from '../../src/shared/dsh-runtime-compatibility';
import { inventoryTree, removeManaged } from '../../src/main/dsh/files';
import { canonicalRuntimeEntryPaths } from '../../src/main/dsh/runtime-paths';
import type { DshRuntime } from '../../src/shared/dsh-launcher';
import type { RuntimeServiceLike } from '../../src/main/dsh/runtime-service';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(tmpdir(), root); });
it('never grants shared access by release name; failed integrity is persisted and independent data remains untouched', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-compat-test-')); roots.push(root);
  const runtime = { id: 'runtime-fixture', version: '0.2.0-rc.2', contentSha256: 'a'.repeat(64) } as DshRuntime;
  const runtimes = { list: () => [runtime], get: () => runtime, directory: () => root, plan: () => ({ executable: '', cli: '', env: {} }), verify: async () => { throw new Error('synthetic corruption'); } } satisfies RuntimeServiceLike;
  const service = new RuntimeCompatibility({ rootPath: root, runtimes, onChanged() {} }); await service.init();
  expect(supportsSharedDataRuntime(runtime)).toBe(false);
  const report = await service.check(runtime); expect(report.status).toBe('failed');
  expect(report.checks.find(item => item.id === 'integrity')).toMatchObject({ status: 'failed', detail: 'synthetic corruption' });
  expect(report.checks.find(item => item.id === 'cleanup')?.status).toBe('passed');
  expect(report.contract).toBe(compatibilityContract());
  expect(await readRuntimeCompatibility(root, runtime)).toEqual(report);
  expect(supportsSharedDataRuntime({ ...runtime, compatibility: report })).toBe(false);
  expect(await readRuntimeCompatibility(root, { ...runtime, contentSha256: 'b'.repeat(64) })).toBeUndefined();
});

const fixtureFile = path.resolve('.tools/dsh-native-node/result.json');
it.skipIf(!existsSync(fixtureFile))('uses real native SDKs in isolated temporary profiles, then checks both directions across different sealed artifacts', async () => {
  const fixture = JSON.parse(await readFile(fixtureFile, 'utf8')) as { root: string; runtimes: DshRuntime[] };
  // Use every locally installed official artifact, including newer releases added for regression checks.
  fixture.runtimes = JSON.parse(await readFile(path.join(fixture.root, 'manager', 'runtimes.json'), 'utf8'));
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-compat-native-')); roots.push(root);
  const runtimes: RuntimeServiceLike = {
    list: () => fixture.runtimes,
    get: id => fixture.runtimes.find(runtime => runtime.id === id)!,
    directory: id => path.join(fixture.root, 'manager', 'runtimes', id, 'program'),
    plan: id => ({ ...canonicalRuntimeEntryPaths(runtimes.directory(id), 'node-cli-web-v1'), env: {} }),
    verify: async id => { expect((await inventoryTree(runtimes.directory(id))).contentSha256).toBe(runtimes.get(id).contentSha256); },
  };
  let lastProgress = '';
  const service = new RuntimeCompatibility({ rootPath: root, runtimes, onChanged() {
    if (process.env.WORLDLINEBOX_DSH_PROBE_PROGRESS !== '1') return;
    const progress = fixture.runtimes.map(runtime => { const report = service.report(runtime); return `${runtime.version}: ${report?.status ?? 'waiting'} ${report?.checks.filter(check => check.status !== 'pending').map(check => `${check.id}=${check.status}${check.status === 'failed' ? ':' + check.detail : ''}`).join(', ')}`; }).join('\n');
    if (progress !== lastProgress) { lastProgress = progress; console.log(progress); }
  } }); await service.init();
  for (const runtime of fixture.runtimes) {
    const report = await service.check(runtime);
    expect(report.checks.filter(item => item.status !== 'passed'), JSON.stringify(report, null, 2)).toEqual([]);
    expect(supportsSharedDataRuntime({ ...runtime, compatibility: report })).toBe(true);
  }
  expect(service.report(fixture.runtimes[1]!)?.peers).toHaveLength(1);
}, 660_000);
