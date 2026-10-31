import { createHash } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import type { CompanionMemoryViewCache } from '../../src/main/companions/memory-view-cache';
import type { CompanionMemoryRuntime } from '../../src/main/companions/vcp-runtime';
import type { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { VcpMemoryNote, VcpMemoryScope, VcpMemoryProjectionDescriptor } from '../../src/main/vcp-memory/contracts';
import { canonicalProjectionInputs } from '../../src/main/companions/canonical-projection-inputs';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionConnection } from '../../src/companions/store';

it('cancels an obsolete idle SQLite snapshot without committing it, reprimes fresh, and still rejects a withdrawn foreground result', async () => {
  const f = managedMemoryFiles(), source = f.source('确切的原始约定：周三归还雨伞。');
  const note = f.record('周三归还雨伞。', [source.id]); await f.publish();
  const graphs = new Map<string, VcpMemoryNote[]>(), opened = new Set<string>();
  let externalWrite = true, withdrawDuringQuery = false;
  const client = {
    supportsDetachedRecall: false,
    hasOpenScope: (view: VcpMemoryScope) => opened.has(view.scopeId),
    inspectProjection: vi.fn(async (view: VcpMemoryScope, descriptors: VcpMemoryProjectionDescriptor[]) => {
      opened.add(view.scopeId); return { upsertIds: descriptors.map(item => item.id), removedIds: [], reused: 0 };
    }),
    applyProjectionDelta: vi.fn(async (view: VcpMemoryScope, notes: VcpMemoryNote[]) => {
      graphs.set(view.scopeId, notes);
      if (externalWrite) {
        externalWrite = false;
        const other = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
        try { other.prepare("UPDATE companions SET data=json_set(data,'$.description','external metadata update') WHERE id='bob'").run(); }
        finally { other.close(); }
      }
    }),
    replace: vi.fn(async (view: VcpMemoryScope, notes: VcpMemoryNote[]) => { opened.add(view.scopeId); graphs.set(view.scopeId, notes); }),
    prepare: vi.fn(async () => ({ ready: true, corpusEpoch: 0 })),
    search: vi.fn(async (view: VcpMemoryScope) => ({ results: (graphs.get(view.scopeId) ?? []).map(item => ({ id: item.id, score: .9, engine: 'river' })) })),
    pluginCall: vi.fn(async (view: VcpMemoryScope) => {
      const notes = graphs.get(view.scopeId) ?? [];
      if (withdrawDuringQuery) f.store.request({ type: 'memory.forget', ...f.scope, id: note.id, sourceMessageIds: [] });
      return { result: notes.map(item => item.content).join('\n'), contextReferenceCoverage: 'observed',
        contextReferences: notes.map(item => ({ id: item.id, role: 'returned', textHash: createHash('sha256').update(item.content).digest('hex') })) };
    }),
    interruptScope: vi.fn(async () => undefined), purgeScope: vi.fn(async () => undefined), importTimelineArtifacts: vi.fn(async () => ({})),
  };
  const release = vi.fn(async () => undefined), report = vi.fn(), model = vi.fn();
  const runtime: CompanionMemoryRuntime = { supportsPreparation: true, supportsProjectionDelta: true,
    get: async () => ({ client: client as unknown as VcpMemoryClient, profileKey: 'real-sql-fixture', release }),
    describeEmbedding: async () => ({ profileKey: 'real-sql-fixture' }), prepareEmbedding: async () => undefined, close: async () => undefined };
  const memory = new CompanionMemoryService({ request: f.request, runtime, configFor: model, fetchFn: model,
    busy: () => false, changed: () => undefined, report,
    warmupCandidates: async () => f.store.state(),
    canonicalInputs: (scope, notes) => canonicalProjectionInputs(f.history, scope, notes, f.library),
    materializeNotes: (owner, notes) => f.live.projectionNotes(owner, notes), validateFiles: (owner, receipts) => f.live.validate(owner, receipts) });
  const cache = (memory as unknown as { views: CompanionMemoryViewCache }).views, original = cache.prepareMetadata.bind(cache), commits = vi.fn();
  vi.spyOn(cache, 'prepareMetadata').mockImplementation(async (...args) => {
    const view = await original(...args), commit = view.commit;
    return Object.assign(view, { commit: () => { commits(); return commit(); } });
  });
  const internal = memory as unknown as { warmedViews: Map<string, string>; warmupRequested: boolean };
  try {
    const before = f.store.request({ type: 'memory.projection.state', ...f.scope }).memoryProjectionState!;
    await memory.primeIdle();
    const after = f.store.request({ type: 'memory.projection.state', ...f.scope }).memoryProjectionState!;
    expect(after.externalVersion).toBeGreaterThan(before.externalVersion);
    expect([after.revocationEpoch, after.resetRevision, after.generation]).toEqual([before.revocationEpoch, before.resetRevision, before.generation]);
    expect(commits).not.toHaveBeenCalled(); expect(client.prepare).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled();
    expect(internal.warmedViews.has('alice')).toBe(false); expect(internal.warmupRequested).toBe(true);
    await memory.primeIdle();
    expect(commits).toHaveBeenCalledOnce(); expect(client.prepare).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledTimes(2);
    expect(internal.warmedViews.has('alice')).toBe(true); expect(internal.warmupRequested).toBe(false);
    const authorized = await memory.search({ ...f.scope, query: '雨伞约定', limit: 8 }, 'active');
    expect(authorized.memoryPage?.items.map(item => item.memory.id)).toEqual([note.id]);
    expect(authorized.memoryContext).toBeDefined();
    withdrawDuringQuery = true;
    const withdrawn = await memory.search({ ...f.scope, query: '雨伞约定', limit: 8 }, 'active');
    // The old candidate is refused. Existing foreground retry may admit the
    // now-empty current corpus, but it must never return the withdrawn body.
    expect(withdrawn.memoryPage?.items).toEqual([]); expect(withdrawn.memoryContext).toBeUndefined();
    expect(await memory.contextValid(f.scope, authorized.memoryContext)).toBe(false);
    expect(model).not.toHaveBeenCalled();
  } finally { await memory.close(); await f.close(); }
});
