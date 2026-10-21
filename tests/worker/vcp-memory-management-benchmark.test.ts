import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { CompanionMemoryManagementSearch } from '../../src/main/companions/memory-management-search';
import { nativeManagementHarness } from '../fixtures/vcp-management-native';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const enabled = process.env.WORLDLINEBOX_VCP_BENCHMARK === '1';
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))]!;
it.skipIf(!enabled)('measures original VCP management ingestion, warm reuse and bounded repeated query work at 100 and 1000 notes', async () => {
  const measurements = [];
  for (const count of [100, 1000]) {
    const root = await mkdtemp(path.join(tmpdir(), 'worldline-vcp-management-benchmark-'));
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-vcp-management-benchmark-')) throw new Error('Unsafe benchmark cleanup.');
    const store = new CompanionsStore(path.join(root, 'state.sqlite'), [{ id: 'alice', name: 'Alice', description: '', persona: '合成测试人格。', avatar: 'sister', model: '', proactive: false, active: true }]);
    const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
    const request = vi.fn(async (command: CompanionStorageCommand) => store.request(command));
    const native = await nativeManagementHarness(root, request);
    let manager: CompanionMemoryManagementSearch | undefined;
    try {
      for (let index = 0; index < count; index++) store.saveMemory({ ...scope, content: `group${index % 16} 合成公开记录编号${index}：今天观察了花园植物并整理学习笔记。`, tags: [`group${index % 16}`], diaryName: ['日记', '资料', '自我认识'][index % 3] });
      manager = native.makeManager();
      const ready = async (current: CompanionMemoryManagementSearch, label: string) => {
        const started = performance.now(); let progress = -1;
        let result = await current.search('alice', 'group0', 10);
        while (result.state !== 'ready') {
          if (result.state === 'error' || native.errors.length) throw new Error(native.errors.map(String).join('\n') || result.error);
          if (performance.now() - started > 540000) throw new Error('Native benchmark exceeded nine-minute build budget.');
          if (Math.floor(result.indexed / 100) !== progress) { progress = Math.floor(result.indexed / 100); console.log(`[VCP benchmark ${count}/${label}] ${result.indexed}/${result.total}`); }
          await new Promise(resolve => setTimeout(resolve, 100)); result = await current.search('alice', 'group0', 10);
        }
        return { result, elapsedMs: performance.now() - started };
      };
      const first = await ready(manager, 'build'); expect(first.result.indexed).toBe(count);
      const auditBefore = native.audit(), inputCount = () => native.embeddingRequests.filter(row => row.path.startsWith('/document/')).flatMap(row => row.input).length;
      const documentsBefore = inputCount(), pagesBefore = request.mock.calls.filter(([command]) => command.type === 'memory.library.index-page').length;
      const queryMs = [];
      for (let index = 0; index < 20; index++) { const started = performance.now(); const result = await manager.search('alice', `group${index % 16}`, 10); expect(result.state).toBe('ready'); expect(result.hits.length).toBeGreaterThan(0); queryMs.push(performance.now() - started); }
      expect(native.audit()).toEqual(auditBefore); expect(inputCount()).toBe(documentsBefore);
      const auditAfterQueries = native.audit();
      expect(request.mock.calls.filter(([command]) => command.type === 'memory.library.index-page')).toHaveLength(pagesBefore);
      await manager.close(); manager = native.makeManager();
      const restarted = await ready(manager, 'reopen'); expect(restarted.result.indexed).toBe(count); expect(inputCount()).toBe(documentsBefore);
      expect(request.mock.calls.filter(([command]) => command.type === 'memory.library.index-page')).toHaveLength(pagesBefore);
      measurements.push({ notes: count, buildMs: first.elapsedMs, queryP50Ms: percentile(queryMs, .5), queryP95Ms: percentile(queryMs, .95), reopenMs: restarted.elapsedMs,
        querySamples: queryMs.length, recordReadsDuringQueries: auditAfterQueries.recordReads - auditBefore.recordReads, recordDirectoryScansDuringQueries: auditAfterQueries.recordDirectoryScans - auditBefore.recordDirectoryScans,
        recordReadsDuringReopen: native.audit().recordReads - auditAfterQueries.recordReads,
        documentInputsDuringQueries: inputCount() - documentsBefore, bootstrapPages: pagesBefore });
    } finally {
      await manager?.close(); await native.close(); store.close();
      await removeOwnedDirectory(root);
    }
  }
  const output = path.resolve('artifacts/vcp-validation/management-native-benchmark.json'); await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), measurements, limitations: ['Real upstream DailyNote ingestion, SQLite, Rust tag geometry and native River queries; synthetic 16-dimensional loopback vectors measure engine orchestration, not semantic model quality.', '100/1000-note synthetic corpus; this is not evidence for 100000-note build time, memory use or latency.', 'Reported warm queries do not reread note journals, request bootstrap pages, or re-embed documents; upstream vector search and authorization of at most 100 returned candidates still run.'] }, null, 2) + '\n');
}, 1200000);
