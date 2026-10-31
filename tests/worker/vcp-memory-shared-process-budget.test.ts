import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import { ColdKnowledgeService } from '../../src/main/vcp-memory/cold-service';
import { VcpMemoryProcessBroker } from '../../src/main/vcp-memory/process-broker';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { nativeManagementHarness } from '../fixtures/vcp-management-native';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

it('reuses published cold data after repeated actual native hot/cold LRU while sharing one process slot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-native-shared-budget-'));
  const native = await nativeManagementHarness(root, async () => { throw new Error('This transport fixture does not invoke management storage.'); });
  const broker = new VcpMemoryProcessBroker(1), live = new Set<symbol>(); let peak = 0;
  const launch: typeof native.launch = file => {
    const transport = native.launch(file), identity = Symbol(file); live.add(identity); peak = Math.max(peak, live.size);
    transport.on('exit', () => live.delete(identity)); return transport;
  };
  const ownerIndex = path.join(root, 'alice', '.运行', '索引');
  const hot = new VcpMemoryClient({ dataRoot: path.join(ownerIndex, 'hot', 'a'.repeat(64)), vendorRoot: path.resolve('vendor/vcp-memory'),
    workerPath: path.resolve('src/main/vcp-memory/worker.cjs'), embedding: native.embedding, processBroker: broker, launch });
  const cold = new ColdKnowledgeService({ dataRoot: path.join(ownerIndex, 'cold', 'b'.repeat(64)), boundOwnerId: 'alice', vendorRoot: path.resolve('vendor/vcp-memory'),
    workerPath: path.resolve('src/main/vcp-memory/cold-worker.cjs'), embedding: native.embedding, processBroker: broker, launch, authorize: async () => true });
  try {
    const text = 'group0 Actual immutable cold source with verified number 475.';
    const sourceDigest = createHash('sha256').update(text).digest('hex');
    await cold.ingest('alice', { id: 'cold-source', sourceId: 'cold-source', sourceDigest, sourceVersion: sourceDigest, sourceType: 'memory', text });
    for (let index = 0; index < 3; index++) {
      await hot.remember({ scopeId: 'hot-owner' }, { id: `hot-${index}`, content: `group0 Actual hot source ${index}`, tags: ['group0'] });
      expect(broker.snapshot()).toMatchObject({ processes: 1, active: 0 });
      const recalled = await cold.search('alice', 'group0', { expand: true });
      expect(recalled.results.some(hit => hit.text === text)).toBe(true); expect(hot.hasOpenScope({ scopeId: 'hot-owner' })).toBe(false);
      expect(broker.snapshot()).toMatchObject({ processes: 1, active: 0 });
    }
    expect(peak).toBe(1);
  } finally {
    await cold.close(); await hot.close(); await broker.close(); await native.close(); expect(live.size).toBe(0);
    await removeOwnedDirectory(root);
  }
}, 120000);
