import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import type { CompanionMemoryRuntime } from '../../src/main/companions/vcp-runtime';
import type { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { VcpMemoryNote, VcpMemoryScope, VcpMemoryProjectionDescriptor } from '../../src/main/vcp-memory/contracts';
import { canonicalMemoryFiles } from '../fixtures/canonical-memory-files';
import { recordSourceBackedMemory } from '../fixtures/source-backed-memory';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(persistent = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-active-projection-'));
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), [{ id: 'alice', name: 'Alice', description: '', persona: 'Read real sources.', avatar: 'sister', proactive: false, model: '' }]);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const originals = Array.from({ length: 6 }, (_, i) => recordSourceBackedMemory(store, { ...scope, content: `约定 ${i}：周三归还雨伞。`, diaryName: '资料' }));
  const config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fixture', baseUrl: 'http://unused.invalid' };
  const files = await canonicalMemoryFiles(root, store, config), request = vi.fn(files.request);
  const graphs = new Map<string, VcpMemoryNote[]>(), opened = new Set<string>();
  let beforeReturn: (() => Promise<void>) | undefined;
  const client = {
    supportsDetachedRecall: false,
    hasOpenScope: (view: VcpMemoryScope) => opened.has(view.scopeId),
    inspectProjection: persistent ? vi.fn(async (view: VcpMemoryScope, descriptors: VcpMemoryProjectionDescriptor[]) => {
      opened.add(view.scopeId); const existing = graphs.get(view.scopeId) ?? [], ids = new Set(descriptors.map(note => note.id));
      const removedIds = existing.filter(note => !ids.has(note.id)).map(note => note.id);
      graphs.set(view.scopeId, existing.filter(note => ids.has(note.id)));
      const upsertIds = descriptors.filter(proof => !existing.some(note => note.id === proof.id
        && createHash('sha256').update(note.content).digest('hex') === proof.contentHash
        && note.metadata?.hostMemoryVersion === proof.annotations.metadata?.hostMemoryVersion)).map(note => note.id);
      return { upsertIds, removedIds, reused: descriptors.length - upsertIds.length };
    }) : undefined,
    replace: vi.fn(async (view: VcpMemoryScope, notes: VcpMemoryNote[]) => { opened.add(view.scopeId); graphs.set(view.scopeId, structuredClone(notes)); }),
    remember: async (view: VcpMemoryScope, note: VcpMemoryNote) => { graphs.set(view.scopeId, [...graphs.get(view.scopeId) ?? [], structuredClone(note)]); return { id: note.id, indexed: true }; },
    applyProjectionDelta: vi.fn(async (view: VcpMemoryScope, notes: VcpMemoryNote[], removed: string[]) => {
      opened.add(view.scopeId);
      graphs.set(view.scopeId, [...graphs.get(view.scopeId) ?? []].filter(note => !removed.includes(note.id) && !notes.some(next => next.id === note.id)).concat(notes));
    }),
    search: vi.fn(async (view: VcpMemoryScope) => ({ results: (graphs.get(view.scopeId) ?? []).map(note => ({ id: note.id, score: .9, engine: 'river' })) })),
    pluginCall: async (view: VcpMemoryScope) => {
      const notes = graphs.get(view.scopeId) ?? [];
      await beforeReturn?.();
      return { result: notes.map(note => note.content).join('\n'), contextReferenceCoverage: 'observed',
        contextReferences: notes.map(note => ({ id: note.id, role: 'returned', textHash: createHash('sha256').update(note.content).digest('hex') })) };
    },
    purgeScope: async (view: VcpMemoryScope) => { graphs.delete(view.scopeId); },
    interruptScope: async () => undefined, importTimelineArtifacts: async () => ({}), close: async () => undefined,
  };
  const runtime: CompanionMemoryRuntime = { supportsProjectionDelta: true,
    get: async () => ({ client: client as unknown as VcpMemoryClient, profileKey: 'fixture-vector' }),
    describeEmbedding: async () => ({ profileKey: 'fixture-vector' }), close: async () => undefined };
  const materialize = vi.fn(files.projection.materializeNotes), canonical = vi.fn(files.projection.canonicalInputs);
  const createMemory = () => new CompanionMemoryService({ request, runtime, configFor: async () => config, fetchFn: vi.fn(),
    ...(persistent ? { cacheRoot: path.join(root, 'views') } : {}),
    materializeNotes: materialize, canonicalInputs: canonical, validateFiles: (owner, receipts, window) => files.live.validate(owner, receipts, window),
    prepareFiles: owner => files.library.prepareOwnerFiles(owner), busy: () => false, changed: () => undefined, report: () => undefined });
  let memory = createMemory(); memory.schedule = () => undefined;
  cleanups.push(async () => { await memory.close(); await files.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  await memory.drainDeliveries();
  return { get memory() { return memory; }, request, canonical, materialize, client, files, store, scope, originals,
    restart: async () => { await memory.close(); opened.clear(); memory = createMemory(); memory.schedule = () => undefined; },
    onResult: (hook: () => Promise<void>) => { beforeReturn = hook; } };
}

it('keeps native ordering and exact page prose while warm active recall avoids whole-corpus body/source scans', async () => {
  const f = await fixture();
  const cold = await f.memory.search({ ...f.scope, query: '雨伞约定', limit: 2 }, 'active');
  expect(cold.ok, cold.error).toBe(true); expect(cold.memoryPage?.items).toHaveLength(2);
  f.request.mockClear(); f.canonical.mockClear(); f.materialize.mockClear(); f.client.replace.mockClear();
  const warm = await f.memory.search({ ...f.scope, query: '雨伞归还时间', limit: 2 }, 'active');
  expect(warm.ok, warm.error).toBe(true);
  expect(warm.memoryPage?.items.map(item => item.memory.content)).toEqual(cold.memoryPage?.items.map(item => item.memory.content));
  expect(warm.memoryContext?.text).toBe(cold.memoryContext?.text);
  expect(await f.memory.contextValid(f.scope, warm.memoryContext)).toBe(true);
  expect(f.request.mock.calls.some(([command]) => command.type === 'memory.snapshot')).toBe(false);
  expect(f.canonical.mock.calls.every(([, notes]) => notes.length === 2)).toBe(true);
  expect(f.materialize.mock.calls.every(([, notes]) => notes.length === 2)).toBe(true);
  expect(f.client.replace).not.toHaveBeenCalled();
});
it('rejects an actual candidate file edit that arrives before the file watcher has updated SQL', async () => {
  const f = await fixture();
  const cold = await f.memory.search({ ...f.scope, query: '雨伞', limit: 2 }, 'active');
  const receipt = cold.memoryContext?.fileReceipts?.[0]; expect(receipt).toBeDefined();
  f.onResult(async () => { await writeFile(receipt!.path, '外部修改的正文，不应返回旧的回忆。', 'utf8'); });
  await expect(f.memory.search({ ...f.scope, query: '同一来源', limit: 2 }, 'active')).rejects.toThrow();
});
it('returns an exact empty native result without reopening every unrelated memory body', async () => {
  const f = await fixture();
  await f.memory.search({ ...f.scope, query: '雨伞', limit: 2 }, 'active');
  f.request.mockClear(); f.canonical.mockClear(); f.materialize.mockClear();
  f.client.search.mockResolvedValueOnce({ results: [] });
  const empty = await f.memory.search({ ...f.scope, query: '没有相关内容', limit: 2 }, 'active');
  expect(empty.ok, empty.error).toBe(true);
  expect(empty.memoryPage?.items).toEqual([]);
  expect(empty.memoryContext?.text).toBe('');
  expect(empty.memoryContext?.fileReceipts).toEqual([]);
  expect(f.request.mock.calls.some(([command]) => command.type === 'memory.snapshot')).toBe(false);
  expect(f.canonical).not.toHaveBeenCalled();
  expect(f.materialize).not.toHaveBeenCalled();
});

it('reopens a clean persisted native view without all-body materialization or re-ingestion', async () => {
  const f = await fixture(true);
  await f.memory.search({ ...f.scope, query: 'first', limit: 2 });
  await f.restart(); f.canonical.mockClear(); f.materialize.mockClear(); f.client.replace.mockClear(); f.client.applyProjectionDelta.mockClear();
  const restored = await f.memory.search({ ...f.scope, query: 'after restart', limit: 2 });
  const mainScope = f.client.inspectProjection!.mock.calls.at(-1)![0].scopeId;
  expect(restored.memoryPage?.items).toHaveLength(2);
  expect(f.canonical.mock.calls.every(([, notes]) => notes.length === 2)).toBe(true);
  expect(f.materialize.mock.calls.every(([, notes]) => notes.length === 2)).toBe(true);
  expect(f.client.replace.mock.calls.some(([scope]) => scope.scopeId === mainScope)).toBe(false);
  expect(f.client.replace.mock.calls.every(([, notes]) => notes.length === 2)).toBe(true);
  expect(f.client.applyProjectionDelta).not.toHaveBeenCalled();
  expect(restored.memoryContext?.fileReceipts).toHaveLength(2);
});
it('reopens after a new indexed note with only its canonical delta, and removes withdrawn records without resurrection', async () => {
  const f = await fixture(true); await f.memory.search({ ...f.scope, query: 'first', limit: 2 });
  const added = recordSourceBackedMemory(f.store, { ...f.scope, content: '新记录：周末归还银色书签。' });
  await f.memory.drainDeliveries(); await f.restart(); f.canonical.mockClear(); f.client.replace.mockClear(); f.client.applyProjectionDelta.mockClear();
  await f.memory.search({ ...f.scope, query: 'new record', limit: 2 });
  const mainScope = f.client.inspectProjection!.mock.calls.at(-1)![0].scopeId;
  expect(f.client.replace.mock.calls.some(([scope]) => scope.scopeId === mainScope)).toBe(false);
  expect(f.client.applyProjectionDelta.mock.calls.flatMap(([, notes]) => notes.map(note => note.id))).toEqual([added.id]);
  f.store.request({ type: 'memory.forget', ...f.scope, id: f.originals[0]!.id, sourceMessageIds: [] });
  await f.restart(); f.client.replace.mockClear();
  const current = await f.memory.search({ ...f.scope, query: 'after withdrawal', limit: 100 });
  expect(current.memoryPage?.items.some(item => item.memory.id === f.originals[0]!.id)).toBe(false);
  expect(f.client.replace).not.toHaveBeenCalled();
});
