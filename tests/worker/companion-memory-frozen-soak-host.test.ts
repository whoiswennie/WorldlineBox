import { cp, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { VcpMemoryProcessBroker } from '../../src/main/vcp-memory/process-broker';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { freezeMemorySoakImplementation } from '../fixtures/frozen-memory-soak';
import { nativeManagementHarness } from '../fixtures/vcp-management-native';
import { ownerGenerationRuntime } from '../fixtures/owner-generation-runtime';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

it('executes the copied actual native host/vendor and counts helper, hot and generation children in one real two-process broker', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-frozen-native-')), repository = path.join(root, 'isolated-source'), run = path.join(root, 'run');
  try {
    for (const directory of ['src/main', 'tests', 'scripts', 'vendor']) await mkdir(path.join(repository, directory), { recursive: true });
    await mkdir(run);
    await cp(path.resolve('src/main/vcp-memory'), path.join(repository, 'src/main/vcp-memory'), { recursive: true, filter: source => !path.extname(source) || source.endsWith('.cjs') });
    await cp(path.resolve('vendor/vcp-memory'), path.join(repository, 'vendor/vcp-memory'), { recursive: true });
    await cp(path.resolve('package-lock.json'), path.join(repository, 'package-lock.json')); await writeFile(path.join(repository, 'package.json'), '{"name":"isolated-frozen-native-fixture"}');
    await symlink(path.resolve('node_modules'), path.join(repository, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const frozen = await freezeMemorySoakImplementation({ fixtureRoot: run, repositoryRoot: repository }), broker = new VcpMemoryProcessBroker(2);
    const native = await nativeManagementHarness(run, async () => { throw new Error('No storage call expected.'); }, {
      workerPath: frozen.workerPath, vendorRoot: frozen.vendorRoot, processBroker: broker, maxLiveProcesses: 2, beforeLaunch: frozen.beforeLaunch });
    const routed = ownerGenerationRuntime(run, native.embedding, native.launch, undefined, { workerPath: frozen.workerPath, vendorRoot: frozen.vendorRoot, processBroker: broker, nativeProcessLimit: 2 });
    try {
      await native.client.remember({ scopeId: 'helper-scope' }, { id: 'helper-note', content: 'group0 actual helper fixture note.', tags: ['group0'] });
      const core = await routed.runtime.get({ ownerId: 'alice' });
      try { await core.client.remember({ scopeId: 'owner-hot' }, { id: 'hot-note', content: 'group1 actual owner hot fixture note.', tags: ['group1'] }); }
      finally { await core.release?.(); }
      const generation = await routed.runtime.acquireGeneration({ ownerId: 'alice', config: { apiFormat: 'openai_chat', baseUrl: 'https://fixture.invalid', model: 'synthetic-native-host', apiKey: 'synthetic-only' } });
      try { await generation.client.remember({ scopeId: 'owner-generation' }, { id: 'generation-note', content: 'group2 actual generation fixture note.', tags: ['group2'] }); }
      finally { await generation.release(); }
      expect(native.processSnapshot()).toMatchObject({ peak: 2, limitViolations: 0, configuredGlobalLimit: 2, helperServerChildProcesses: 0 });
      expect(native.processSnapshot().processes.length).toBeGreaterThanOrEqual(3);
      expect(native.processSnapshot().processes.every(process => process.file === frozen.workerPath)).toBe(true);
      expect(broker.snapshot()).toMatchObject({ limit: 2, processes: 2 }); await frozen.verifyFrozen(); await frozen.verifySources();
    } finally {
      await routed.close(); await native.close(); await broker.close();
      expect(native.processSnapshot().live).toBe(0); expect(broker.snapshot().processes).toBe(0);
    }
  } finally { await removeOwnedDirectory(root); }
}, 120_000);
