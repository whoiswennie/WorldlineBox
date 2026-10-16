import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuntimeCompatibility, compatibilityContract, readRuntimeCompatibility } from '../../src/main/dsh/runtime-compatibility';
import { supportsSharedDataRuntime } from '../../src/shared/dsh-runtime-compatibility';
import { inventoryTree, removeManaged } from '../../src/main/dsh/files';
import { canonicalRuntimeEntryPaths } from '../../src/main/dsh/runtime-paths';
import { RuntimeIntegrity } from '../../src/main/dsh/runtime-integrity';
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

const fixtureRegistry = process.env.WORLDLINEBOX_DSH_COMPAT_RUNTIME_REGISTRY ?? path.resolve('.tools/dsh-native-node/manager/runtimes.json');
it.skipIf(!existsSync(fixtureRegistry))('uses real native SDKs in isolated temporary profiles, then checks both directions across different sealed artifacts', async () => {
  // Use every locally installed official artifact, including newer releases added for regression checks.
  // The supplied registry and artifacts are read-only; reports, profiles and credentials stay temporary.
  const fixture = { runtimes: JSON.parse(await readFile(fixtureRegistry, 'utf8')) as DshRuntime[] };
  const integrity = new RuntimeIntegrity();
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-compat-native-')); roots.push(root);
  const runtimes: RuntimeServiceLike = {
    list: () => fixture.runtimes,
    get: id => fixture.runtimes.find(runtime => runtime.id === id)!,
    directory: id => path.join(path.dirname(fixtureRegistry), 'runtimes', id, 'program'),
    plan: id => ({ ...canonicalRuntimeEntryPaths(runtimes.directory(id), 'node-cli-web-v1'), env: {} }),
    verify: async id => integrity.verify(runtimes.directory(id), async () => { expect((await inventoryTree(runtimes.directory(id))).contentSha256).toBe(runtimes.get(id).contentSha256); }),
  };
  let lastProgress = '';
  const service = new RuntimeCompatibility({ rootPath: root, runtimes, onChanged() {
    if (process.env.WORLDLINEBOX_DSH_PROBE_PROGRESS !== '1') return;
    const progress = fixture.runtimes.map(runtime => { const report = service.report(runtime); return `${runtime.version}: ${report?.status ?? 'waiting'} ${report?.checks.filter(check => check.status !== 'pending').map(check => `${check.id}=${check.status}${check.status === 'failed' ? ':' + check.detail : ''}`).join(', ')}`; }).join('\n');
    if (progress !== lastProgress) { lastProgress = progress; console.log(progress); }
  } }); await service.init();
  try {
    for (const runtime of fixture.runtimes) {
      const report = await service.check(runtime);
      expect(report.checks.filter(item => item.status !== 'passed'), JSON.stringify(report, null, 2)).toEqual([]);
      expect(supportsSharedDataRuntime({ ...runtime, compatibility: report })).toBe(true);
    }
    expect(service.report(fixture.runtimes[1]!)?.peers).toHaveLength(1);
  } finally { integrity.close(); }
}, 660_000);
