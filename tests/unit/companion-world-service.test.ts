import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed, type CompanionConnection } from '../../src/companions/store';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import type { CompanionMemoryCandidate } from '../../src/shared/companion-memory';
import type { CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMemoryService } from '../../src/main/companions/memory-service';
import type { VcpMemoryDreamWaveResult } from '../../src/main/vcp-memory/dream-contracts';
import { CompanionOptionalDreamError } from '../../src/main/companions/optional-dream-error';
import { companionDreamComponentFailureSchema } from '../../src/shared/companion-world';
import { COMPANION_SUBMIT_RESULT_TOOL } from '../../src/shared/companion-final-proposal';

const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: id === 'alice' ? '安静友好，喜欢阅读。' : '坦率，尊重彼此边界。', description: '', model: '', avatar: 'sister', proactive: true }));
const stores = new Set<CompanionsStore>(), services = new Set<CompanionWorldService>(), roots: string[] = [];
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-10-14T02:00:00Z'); vi.spyOn(Math, 'random').mockReturnValue(.1); });
afterEach(async () => {
  for (const service of services) await service.close(); services.clear();
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture(fetchFn: typeof fetch, asleep = true, members = seeds, narrateDream = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-world-service-')); roots.push(root);
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), members.map(seed => ({ ...seed, active: true }))); stores.add(store);
  const alice = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, bob = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const scope of members.map(member => ({ companionId: member.id, conversationId: store.openPrivate(member.id).id }))) {
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: asleep ? '01:00' : '23:00', wakeAt: asleep ? '03:00' : '01:00', meals: [], habits: [] } });
  }
  const request = vi.fn(async (command: Parameters<CompanionsStore['request']>[0]): Promise<CompanionStorageResponse> => {
    if (command.type !== 'memory.search') return store.request(command);
    const snapshot = store.request({ type: 'memory.snapshot', companionId: command.companionId, conversationId: command.conversationId,
      beforeSequence: command.beforeSequence }).memorySnapshot!;
    return { ok: true, memoryPage: { items: snapshot.notes.map(memory => ({ memory, reasons: ['authorized fixture'], path: [] })), hasMore: false },
      memoryContext: { text: snapshot.notes.map(note => note.content).join('\n'), revision: snapshot.revision, profileKey: 'fixture-vcp-profile' } };
  });
  const memoryContextValid = vi.fn(async (scope: { companionId: string; conversationId: string; beforeSequence?: number }, context?: { revision: string }) =>
    !context || store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!.revision === context.revision);
  const recall = vi.fn(async (input: Parameters<CompanionMemoryService['recall']>[0]) => {
    const response = await request({ type: 'memory.search', companionId: input.companion.id, conversationId: input.conversation.id,
      beforeSequence: input.beforeSequence, query: input.currentMessage.content, limit: 8 });
    return { memories: response.memoryPage?.items.map(hit => hit.memory) ?? [], sources: [], reasons: [], pending: false, degraded: false,
      context: response.memoryContext };
  });
  const dreamWave = vi.fn(async (input: { companionId: string; conversationId: string; now: string; clockDomain: 'world' | 'real' }): Promise<VcpMemoryDreamWaveResult> => {
    const snapshot = store.request({ type: 'memory.snapshot', companionId: input.companionId, conversationId: input.conversationId }).memorySnapshot!;
    return { schema: 'worldlinebox.vcp-dream-wave', owner: { version: 2, companionId: input.companionId, agentName: input.companionId, name: input.companionId },
      sourceRevision: snapshot.revision, now: input.now, clockDomain: input.clockDomain, boundaries: { recentDays: 7, midDays: 90 },
      stages: { recent: { seeds: narrateDream ? snapshot.notes.map(note => ({ id: note.id, version: note.version, text: note.content,
        eventTime: input.now, clockDomain: input.clockDomain })) : [], resonanceL1: [], cascadeL2: [] }, mid: { seeds: [], cascadeL1: [] }, deep: { recalls: [] } },
      diagnostics: { algorithm: 'upstream-DreamWaveEngine', sourceCount: snapshot.notes.length, indexedCount: snapshot.notes.length, queries: [] } };
  });
  const service = new CompanionWorldService({ request, fetchFn, configFor: async () => ({ apiFormat: 'openai_chat', model: 'test-model', apiKey: 'private-key', baseUrl: 'https://provider.invalid' }),
    changed: vi.fn(), wakeWaiting: vi.fn(), report: vi.fn(), memoryContextValid, recall, dreamWave }); services.add(service);
  return { store, service, alice, bob, request, memoryContextValid, recall, dreamWave, root };
}
function advance(store: CompanionsStore, milliseconds: number) { vi.setSystemTime(Date.now() + milliseconds); return store.request({ type: 'world.tick' }).world!; }
function indexNotes(store: CompanionsStore) {
  for (;;) {
    const outbox = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
    if (!outbox) break;
    store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true });
  }
}
function prepareDream(f: ReturnType<typeof fixture>) {
  const source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'alice', content: '这次先备份再修改，实际修复了聊天保存问题。', replyDirective: 'none' });
  const journal = f.store.request({ type: 'memory.record', ...f.alice, candidate: { content: source.content, tags: ['聊天保存', '备份'],
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  // Simulate the VCP index acknowledgement; queued journals must not trigger sleep consolidation.
  for (;;) {
    const outbox = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox;
    if (!outbox) break;
    f.store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true, sourceFile: `fixture/${outbox.noteId}.txt` });
  }
  advance(f.store, 10000); advance(f.store, 6000);
  return { source, journal };
}
function dreamResult(data: { messages: Array<{ id: string; content: string }>; relevantMemories: Array<{ id: string; content: string }> }) {
  const source = data.messages.find(message => message.content.includes('实际修复了聊天保存问题'))!, journal = data.relevantMemories.find(memory => memory.content === source.content)!;
  const common = { sourceMessageIds: [source.id], relatedMemoryIds: [journal.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] };
  const note: CompanionMemoryCandidate = { ...common, tags: ['聊天保存', '备份', '修复经验'], content: '这次聊天保存修复中先备份再修改保留了恢复入口；仅是本次实际经历的经验。' };
  return { notes: [note], dream: null };
}

describe('semantic world background service with actual SQLite sources', () => {
  it.each(['not_admitted', 'not_dream_job', 'also_publishes_dream'] as const)('rejects optional dream diagnostics when %s violates the actual job contract', condition => {
    if (condition === 'not_admitted') vi.mocked(Math.random).mockReturnValue(.99);
    const f = fixture(async () => response({ notes: [], dream: null })), { source, journal } = prepareDream(f);
    const job = f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob!;
    if (condition === 'not_dream_job') {
      const db = new (Database as { new(file: string): CompanionConnection })(path.join(f.root, 'messages.sqlite'));
      try { db.prepare("UPDATE companion_world_jobs SET kind='decision',data=json_set(data,'$.kind','decision') WHERE id=?").run(job.id); }
      finally { db.close(); }
    }
    expect(() => f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!,
      dreamComponentFailure: new CompanionOptionalDreamError('wave_operation_failed').diagnostic,
      ...(condition === 'also_publishes_dream' ? { dream: { text: '不能和失败诊断同时发布。', sourceMessageIds: [source.id], relatedMemoryIds: [journal.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } } : {}) }))
      .toThrow('可选梦境失败诊断只能记录已入梦任务且不能同时发布梦境。');
  });
  it('accepts only the fixed host stage/code/description diagnostic and rejects provider text', () => {
    const diagnostic = new CompanionOptionalDreamError('wave_operation_failed').diagnostic;
    expect(companionDreamComponentFailureSchema.safeParse(diagnostic).success).toBe(true);
    expect(companionDreamComponentFailureSchema.safeParse({ ...diagnostic, stage: 'narrative' }).success).toBe(false);
    expect(companionDreamComponentFailureSchema.safeParse({ ...diagnostic, message: 'Raw provider response or private endpoint' }).success).toBe(false);
    expect(companionDreamComponentFailureSchema.safeParse({ ...diagnostic, code: 'arbitrary_failure' }).success).toBe(false);
  });

  it.each(['wave', 'narrative'] as const)('retains independent maintenance and index-before-archive when optional %s service fails', async failedStage => {
    const purposes: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content); purposes.push(data.purpose);
      if (data.purpose === 'vcp_sleep_reflection') return response({ notes: [], dream: null });
      if (data.purpose === 'companion_dream_wave_narrative') return response({ text: '不可发布的梦', relatedMemoryIds: ['unread-memory'] });
      expect(data.purpose).toBe('vcp_sleep_memory_maintenance');
      const inputs = data.relevantMemories.map((note: { id: string; version: number }) => ({ id: note.id, version: note.version }));
      return response({ decision: 'merge', reason: '按真实原文保留编号更正，不依赖虚构梦是否成功。', consolidations: [{ inputs,
        candidate: { content: '钥匙先记为K-710，后来更正为K-701；搬家日期仍未定。', tags: ['钥匙'],
          relatedMemoryIds: inputs.map((note: { id: string }) => note.id), sourceMessageIds: data.messages.map((message: { id: string }) => message.id),
          evidence: data.messages.map((message: { id: string; content: string }) => ({ sourceMessageId: message.id, quote: message.content })) } }] });
    });
    const f = fixture(fetchFn, true, seeds, true);
    if (failedStage === 'wave') f.dreamWave.mockRejectedValue(new CompanionOptionalDreamError('wave_operation_failed'));
    const sources = ['钥匙先记为K-710，搬家日期仍未定。', '后来更正：钥匙编号是K-701，搬家日期仍未定。']
      .map(content => f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content, replyDirective: 'none' }));
    const capture = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
    const originals = f.store.request({ type: 'memory.jobs.complete', id: capture.id, leaseToken: capture.leaseToken,
      notes: sources.map(source => ({ content: source.content, tags: ['钥匙'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] })) }).memories!;
    indexNotes(f.store); advance(f.store, 10000); advance(f.store, 6000);
    await f.service.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.complete' && command.maintenance?.decision === 'merge')).toBe(true));
    const completion = f.request.mock.calls.find(([command]) => command.type === 'world.job.complete' && command.maintenance?.decision === 'merge')![0];
    if (completion.type !== 'world.job.complete') throw Error('Missing actual maintenance completion.');
    expect(completion.dream).toBeUndefined();
    expect(completion.dreamComponentFailure).toMatchObject({ stage: failedStage, code: failedStage === 'wave' ? 'wave_operation_failed' : 'narrative_generation_failed' });
    expect(completion.maintenance?.reviewedMemoryVersions).toEqual(originals.map(note => ({ id: note.id, version: note.version })));
    const merged = f.store.request({ type: 'memory.browse', ...f.alice }).memoryPage!.items.map(hit => hit.memory)
      .find(note => note.metadata?.consolidation === 'source_version_graph')!;
    expect(merged.status).toBe('queued');
    for (const original of originals) expect(f.store.request({ type: 'memory.read', ...f.alice, id: original.id }).memoryRead!.memory.archivedAt).toBeUndefined();
    indexNotes(f.store);
    expect(f.store.request({ type: 'memory.snapshot', ...f.alice }).memorySnapshot!.notes.map(note => note.id)).toEqual([merged.id]);
    for (const original of originals) expect(f.store.request({ type: 'memory.read', ...f.alice, id: original.id }).memoryRead!.memory)
      .toMatchObject({ archivedAt: expect.any(String), supersededBy: merged.id });
    const db = new (Database as { new(file: string): CompanionConnection })(path.join(f.root, 'messages.sqlite'));
    try {
      const saved = db.prepare('SELECT data FROM companion_world_jobs WHERE id=?').get(completion.id) as { data: string };
      expect(JSON.parse(saved.data)).toMatchObject({ status: 'done', dreamComponentFailure: completion.dreamComponentFailure, maintenance: { decision: 'merge' } });
      expect((db.prepare('SELECT COUNT(*) AS n FROM companion_world_dream_watermark WHERE companion_id=?').get('alice') as { n: number }).n).toBe(2);
    } finally { db.close(); }
    expect(f.store.request({ type: 'world.observe', ...f.alice }).world!.events.some(event => event.kind === 'dream')).toBe(false);
    expect(purposes).toEqual(failedStage === 'wave' ? ['vcp_sleep_reflection', 'vcp_sleep_memory_maintenance']
      : ['vcp_sleep_reflection', 'companion_dream_wave_narrative', 'vcp_sleep_memory_maintenance']);
  });

  it.each(['wake', 'forget', 'cancel', 'untyped_source_error'] as const)('does not turn %s during an optional dream failure into successful maintenance', async invalidation => {
    const f = fixture(async () => response({ notes: [], dream: null }));
    const { source } = prepareDream(f);
    f.dreamWave.mockImplementation(async () => {
      if (invalidation === 'forget') f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [source.id] });
      else if (invalidation === 'cancel') f.service.cancelCompanion('alice');
      else if (invalidation === 'wake') {
        const routine = f.store.request({ type: 'routine.get', ...f.alice }).routine!;
        f.store.request({ type: 'routine.configure', ...f.alice, expectedRevision: routine.revision, patch: { sleepAt: '23:00', wakeAt: '01:00' } });
        f.store.request({ type: 'world.tick' });
      }
      if (invalidation === 'untyped_source_error') throw Error('Actual source ownership or receipt is invalid.');
      throw new CompanionOptionalDreamError('wave_operation_failed');
    });
    await f.service.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.fail')).toBe(true));
    expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.complete')).toBe(false);
    const db = new (Database as { new(file: string): CompanionConnection })(path.join(f.root, 'messages.sqlite'));
    try { expect((db.prepare('SELECT COUNT(*) AS n FROM companion_world_dream_watermark WHERE companion_id=?').get('alice') as { n: number }).n).toBe(0); }
    finally { db.close(); }
  });

  it('does not replace failed real reflection with empty notes or advance its watermark after an optional wave failure', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({ notes: 'invalid-real-reflection', dream: null }));
    const f = fixture(fetchFn); prepareDream(f);
    f.dreamWave.mockRejectedValue(new CompanionOptionalDreamError('wave_operation_failed'));
    await f.service.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.fail')).toBe(true));
    expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.complete')).toBe(false);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(JSON.parse(JSON.parse(String(fetchFn.mock.calls[0]![1]?.body)).messages[1].content).purpose).toBe('vcp_sleep_reflection');
    const db = new (Database as { new(file: string): CompanionConnection })(path.join(f.root, 'messages.sqlite'));
    try { expect((db.prepare('SELECT COUNT(*) AS n FROM companion_world_dream_watermark WHERE companion_id=?').get('alice') as { n: number }).n).toBe(0); }
    finally { db.close(); }
  });

  it('automatically prepares a multi-seed merge from normal journal jobs during real sleep and publishes only after index acknowledgement', async () => {
    vi.mocked(Math.random).mockReturnValue(.99);
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      if (payload.purpose === 'vcp_sleep_reflection') {
        expect(payload.reflectionOnly).toBe(true); expect(payload.outputSchema.properties).not.toHaveProperty('consolidations');
        return response({ notes: [], dream: null });
      }
      expect(payload.purpose).toBe('vcp_sleep_memory_maintenance');
      const inputs = payload.relevantMemories.map((note: { id: string; version: number }) => ({ id: note.id, version: note.version }));
      expect(inputs).toHaveLength(2);
      return response({ decision: 'merge', reason: '同一把钥匙的错误记录与明确更正分散在两篇，保留前后顺序整合。', consolidations: [{ inputs, candidate: {
        content: '玩家先记成K-710，后来明确更正钥匙编号为K-701；搬家日期仍未定。', tags: ['钥匙'],
        sourceMessageIds: payload.messages.map((source: { id: string }) => source.id), relatedMemoryIds: inputs.map((note: { id: string }) => note.id),
        evidence: payload.messages.map((source: { id: string; content: string }) => ({ sourceMessageId: source.id, quote: source.content })),
      } }] });
    });
    const f = fixture(fetchFn);
    const sources = ['钥匙先记成K-710，搬家日期还未确定。', '更正：钥匙编号是K-701，不是K-710；搬家日期仍未定。']
      .map(content => f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content, replyDirective: 'none' }));
    const journalJob = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
    const originals = f.store.request({ type: 'memory.jobs.complete', id: journalJob.id, leaseToken: journalJob.leaseToken,
      notes: sources.map(source => ({ content: source.content, tags: ['钥匙'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] })) }).memories!;
    expect(originals).toHaveLength(2); indexNotes(f.store); advance(f.store, 10000); advance(f.store, 6000);
    await f.service.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.complete' && command.consolidations?.length === 1)).toBe(true));
    const completed = f.request.mock.calls.find(([command]) => command.type === 'world.job.complete' && command.consolidations?.length === 1)![0];
    expect(completed.type).toBe('world.job.complete');
    const pending = f.store.request({ type: 'memory.browse', ...f.alice }).memoryPage!.items.map(hit => hit.memory);
    const merged = pending.find(note => note.metadata?.consolidation === 'source_version_graph')!;
    expect(merged.status).toBe('queued'); expect(pending.filter(note => originals.some(original => original.id === note.id)).every(note => !note.archivedAt)).toBe(true);
    indexNotes(f.store);
    const published = f.store.request({ type: 'memory.snapshot', ...f.alice }).memorySnapshot!.notes;
    expect(published.map(note => note.id)).toEqual([merged.id]); expect(published[0]!.content).toContain('K-701'); expect(published[0]!.content).toContain('仍未定');
    for (const original of originals) expect(f.store.request({ type: 'memory.read', ...f.alice, id: original.id }).memoryRead!.memory).toMatchObject({ archivedAt: expect.any(String), supersededBy: merged.id });
    expect(f.store.request(completed).ok).toBe(true); expect(f.store.request({ type: 'memory.snapshot', ...f.alice }).memorySnapshot!.notes).toHaveLength(1);
    expect(completed.type === 'world.job.complete' && completed.maintenance).toMatchObject({ decision: 'merge', reviewedMemoryVersions: originals.map(note => ({ id: note.id, version: note.version })) });
    expect(fetchFn).toHaveBeenCalledTimes(2); expect(f.request.mock.calls.some(([command]) => command.type === 'memory.consolidate')).toBe(false);
  });
  it.each(['merge', 'defer'] as const)('maintains a previously reflected singleton with a new original using an independent %s readset', async decision => {
    vi.mocked(Math.random).mockReturnValue(.99);
    let firstId = '', secondId = '', reflections = 0, maintenanceCalls = 0;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      if (data.purpose === 'vcp_sleep_reflection') {
        reflections++;
        expect(data.relevantMemories.map((note: { id: string }) => note.id)).toEqual([reflections === 1 ? firstId : secondId]);
        expect(data.messages).toHaveLength(1);
        return response({ notes: [], dream: null });
      }
      expect(data.purpose).toBe('vcp_sleep_memory_maintenance'); maintenanceCalls++;
      expect(data.relevantMemories.map((note: { id: string }) => note.id).sort()).toEqual([firstId, secondId].sort());
      expect(data.messages).toHaveLength(2);
      const inputs = data.relevantMemories.map((note: { id: string; version: number }) => ({ id: note.id, version: note.version }));
      return response({ decision, reason: decision === 'merge' ? '同一编号的原记录与后续更正需要保留完整顺序。' : '先保留两篇，已独立检查而未决定合并。',
        consolidations: decision === 'defer' ? [] : [{ inputs, candidate: { content: '钥匙先记为K-710，后来更正为K-701；搬家日期仍未确定。', tags: ['钥匙'],
          sourceMessageIds: data.messages.map((source: { id: string }) => source.id), relatedMemoryIds: inputs.map((note: { id: string }) => note.id),
          evidence: data.messages.map((source: { id: string; content: string }) => ({ sourceMessageId: source.id, quote: source.content })) } }] });
    });
    const f = fixture(fetchFn);
    const original = (content: string) => {
      const source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content, replyDirective: 'none' });
      const job = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
      const note = f.store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken,
        notes: [{ content, tags: ['钥匙'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: content }] }] }).memories![0]!;
      expect(note.captureMethod).toBe('automatic'); indexNotes(f.store); return note.id;
    };
    const cycle = (asleep: boolean) => {
      const routine = f.store.request({ type: 'routine.get', ...f.alice }).routine!;
      f.store.request({ type: 'routine.configure', ...f.alice, expectedRevision: routine.revision,
        patch: { sleepAt: asleep ? '01:00' : '23:00', wakeAt: asleep ? '03:00' : '01:00' } });
      advance(f.store, 10000); advance(f.store, 6000);
    };
    firstId = original('钥匙先记为K-710，搬家日期仍未确定。'); cycle(true);
    await f.service.tick(); await vi.waitFor(() => expect(f.request.mock.calls.filter(([command]) => command.type === 'world.job.complete')).toHaveLength(1));
    expect(maintenanceCalls).toBe(0); cycle(false);
    secondId = original('更正：钥匙编号是K-701，不是K-710；搬家日期仍未确定。'); cycle(true);
    await f.service.tick(); await vi.waitFor(() => expect(f.request.mock.calls.filter(([command]) => command.type === 'world.job.complete')).toHaveLength(2));
    expect(reflections).toBe(2); expect(maintenanceCalls).toBe(1);
    const complete = f.request.mock.calls.filter(([command]) => command.type === 'world.job.complete').at(-1)![0];
    expect(complete.type === 'world.job.complete' && complete.maintenance?.reviewedMemoryVersions.map(note => note.id).sort()).toEqual([firstId, secondId].sort());
    expect(f.store.request({ type: 'memory.read', ...f.alice, id: firstId }).memoryRead!.memory.archivedAt).toBeUndefined();
    if (decision === 'merge') {
      indexNotes(f.store);
      expect(f.store.request({ type: 'memory.read', ...f.alice, id: firstId }).memoryRead!.memory.archivedAt).toBeDefined();
      expect(f.store.request({ type: 'memory.snapshot', ...f.alice }).memorySnapshot!.notes).toHaveLength(1);
    }
    cycle(false); cycle(true); await f.service.tick(); await Promise.resolve();
    expect(reflections).toBe(2); expect(maintenanceCalls).toBe(1); expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('does not remerge a prior summary and same-source reflection over several sleep episodes, then absorbs a genuinely new journal source', async () => {
    vi.mocked(Math.random).mockReturnValue(.99);
    let merges = 0;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      const inputs = payload.relevantMemories.map((note: { id: string; version: number }) => ({ id: note.id, version: note.version }));
      expect(inputs).toHaveLength(2);
      const first = payload.messages[0] as { id: string; content: string };
      if (payload.purpose === 'vcp_sleep_reflection') return response({ notes: merges === 0 ? [{ content: '核对钥匙时仍需保留明确的更正与尚未完成的限定。', tags: ['核对'],
        sourceMessageIds: [first.id], relatedMemoryIds: [inputs[0]!.id], evidence: [{ sourceMessageId: first.id, quote: first.content }] }] : [], dream: null });
      expect(payload.purpose).toBe('vcp_sleep_memory_maintenance'); merges++;
      return response({ decision: 'merge', reason: '同一钥匙的原始记录带来尚未包含的新来源，应保留限制并整合。',
        consolidations: [{ inputs, candidate: { content: merges === 1 ? '钥匙已经更正为K-701；搬家日期仍未定。' : '钥匙更正为K-701，搬家日期仍未定；新确认钥匙放在第二层抽屉。', tags: ['钥匙'],
        sourceMessageIds: payload.messages.map((source: { id: string }) => source.id), relatedMemoryIds: inputs.map((note: { id: string }) => note.id),
        evidence: payload.messages.map((source: { id: string; content: string }) => ({ sourceMessageId: source.id, quote: source.content })) } }] });
    });
    const f = fixture(fetchFn);
    const publishJournals = (texts: string[]) => {
      const sources = texts.map(content => f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content, replyDirective: 'none' }));
      const job = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
      f.store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken,
        notes: sources.map(source => ({ content: source.content, tags: ['钥匙'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] })) });
      indexNotes(f.store); return sources;
    };
    const changeSleep = (asleep: boolean) => {
      const routine = f.store.request({ type: 'routine.get', ...f.alice }).routine!;
      f.store.request({ type: 'routine.configure', ...f.alice, expectedRevision: routine.revision,
        patch: { sleepAt: asleep ? '01:00' : '23:00', wakeAt: asleep ? '03:00' : '01:00' } });
      advance(f.store, 10000); advance(f.store, 6000);
    };
    const originals = publishJournals(['钥匙先记成K-710，搬家日期仍未定。', '更正：钥匙编号是K-701，不是K-710。']);
    advance(f.store, 10000); advance(f.store, 6000); await f.service.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.filter(([command]) => command.type === 'world.job.complete' && command.consolidations?.length)).toHaveLength(1));
    indexNotes(f.store);
    const firstSnapshot = f.store.request({ type: 'memory.snapshot', ...f.alice }).memorySnapshot!.notes;
    const prior = firstSnapshot.find(note => note.metadata?.automaticConsolidation === true)!, reflection = firstSnapshot.find(note => note.metadata?.sleepReflection === true)!;
    expect(prior).toBeDefined(); expect(reflection).toBeDefined(); expect(reflection.archivedAt).toBeUndefined();
    for (let episode = 0; episode < 3; episode++) {
      changeSleep(false); await f.service.tick(); changeSleep(true); await f.service.tick();
      expect(f.store.request({ type: 'memory.snapshot', ...f.alice }).memorySnapshot!.notes).toEqual(firstSnapshot);
    }
    expect(merges).toBe(1); expect(fetchFn).toHaveBeenCalledTimes(2);
    changeSleep(false);
    const [newSource] = publishJournals(['新确认：钥匙K-701放在第二层抽屉，搬家日期仍未定。']);
    changeSleep(true); await f.service.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.filter(([command]) => command.type === 'world.job.complete' && command.consolidations?.length),
      JSON.stringify({ merges, recent: f.request.mock.calls.slice(-12).map(([command]) => command), sleep: f.store.request({ type: 'world.sleep-plan', companionId: 'alice' }) })).toHaveLength(2));
    indexNotes(f.store);
    const active = f.store.request({ type: 'memory.snapshot', ...f.alice }).memorySnapshot!.notes;
    const next = active.find(note => note.metadata?.automaticConsolidation === true)!;
    expect(next.id).not.toBe(prior.id); expect(next.sources.some(source => source.messageId === newSource!.id)).toBe(true);
    expect(next.content).toContain('第二层抽屉'); expect(next.content).toContain('仍未定');
    expect(f.store.request({ type: 'memory.read', ...f.alice, id: prior.id }).memoryRead!.memory.supersededBy).toBe(next.id);
    expect(active.find(note => note.id === reflection.id)?.archivedAt).toBeUndefined(); expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(f.request.mock.calls.some(([command]) => command.type === 'memory.consolidate')).toBe(false);
    f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [originals[0]!.id] }); indexNotes(f.store);
    const withdrawn = f.store.request({ type: 'memory.snapshot', ...f.alice }).memorySnapshot!.notes;
    expect(withdrawn.some(note => note.id === next.id || note.id === prior.id || note.sources.some(source => source.messageId === originals[0]!.id))).toBe(false);
    expect(f.store.request({ type: 'memory.sources.filter', ...f.alice, ids: [originals[0]!.id] }).memorySources).toEqual([]);
  });
  it('persists a reasoned independent-event defer and does not pay again in later sleep episodes without new sources', async () => {
    vi.mocked(Math.random).mockReturnValue(.99);
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      return response(data.purpose === 'vcp_sleep_reflection' ? { notes: [], dream: null }
        : { decision: 'defer', reason: '借伞和修收音机是两件独立发生的事，混合归档会破坏各自情境。', consolidations: [] });
    });
    const f = fixture(fetchFn);
    const sources = ['上午把雨伞借给小周，约好明天归还。', '晚上独自修好收音机的音量旋钮，没有其它维修结果。']
      .map(content => f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content, replyDirective: 'none' }));
    const capture = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
    const originals = f.store.request({ type: 'memory.jobs.complete', id: capture.id, leaseToken: capture.leaseToken,
      notes: sources.map(source => ({ content: source.content, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] })) }).memories!;
    indexNotes(f.store); advance(f.store, 10000); advance(f.store, 6000); await f.service.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.complete' && command.maintenance?.decision === 'defer')).toBe(true));
    const completed = f.request.mock.calls.find(([command]) => command.type === 'world.job.complete' && command.maintenance?.decision === 'defer')![0];
    expect(completed.type === 'world.job.complete' && completed.consolidations).toBeUndefined();
    const db = new (Database as { new(file: string): CompanionConnection })(path.join(f.root, 'messages.sqlite'));
    try {
      const saved = db.prepare('SELECT data FROM companion_world_jobs WHERE id=?').get(completed.type === 'world.job.complete' ? completed.id : '') as { data: string };
      expect(JSON.parse(saved.data)).toMatchObject({ status: 'done', maintenance: { decision: 'defer', reason: expect.stringContaining('独立发生'),
        reviewedMemoryVersions: originals.map(note => ({ id: note.id, version: note.version })) } });
    } finally { db.close(); }
    for (let episode = 0; episode < 3; episode++) for (const asleep of [false, true]) {
      const routine = f.store.request({ type: 'routine.get', ...f.alice }).routine!;
      f.store.request({ type: 'routine.configure', ...f.alice, expectedRevision: routine.revision,
        patch: { sleepAt: asleep ? '01:00' : '23:00', wakeAt: asleep ? '03:00' : '01:00' } });
      advance(f.store, 10000); advance(f.store, 6000); await f.service.tick();
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(f.store.request({ type: 'memory.snapshot', ...f.alice }).memorySnapshot!.notes.map(note => [note.id, note.archivedAt]).sort()).toEqual(originals.map(note => [note.id, undefined]).sort());
  });
  it('rechecks seed novelty in the SQLite completion transaction before allowing a derived-only automatic archive plan', () => {
    vi.mocked(Math.random).mockReturnValue(.99);
    const f = fixture(async () => response({ notes: [], dream: null }));
    const sources = ['先记钥匙K-710。', '更正：钥匙K-701。'].map(content => f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content, replyDirective: 'none' }));
    const capture = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
    const notes = f.store.request({ type: 'memory.jobs.complete', id: capture.id, leaseToken: capture.leaseToken,
      notes: sources.map(source => ({ content: source.content, tags: ['钥匙'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] })) }).memories!;
    indexNotes(f.store); advance(f.store, 10000); advance(f.store, 6000);
    const job = f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob!;
    expect(job.sourceMemoryIds).toEqual(notes.map(note => note.id));
    // Adversarial synthetic legacy metadata: exact indexed IDs/versions remain,
    // but both captured notes are now known to be derived. Host code must not
    // rely on the model's earlier novelty claim to archive either note.
    const db = new (Database as { new(file: string): CompanionConnection })(path.join(f.root, 'messages.sqlite'));
    try {
      for (const note of notes) db.prepare("UPDATE vcp_memory_notes SET data=json_set(data,'$.metadata.sleepReflection',json('true'),'$.metadata.consolidation',json('true')) WHERE id=?").run(note.id);
    } finally { db.close(); }
    expect(() => f.store.request({ type: 'world.job.complete', id: job.id, leaseToken: job.leaseToken!, sourceMemoryIds: notes.map(note => note.id),
      consolidations: [{ inputs: notes.map(note => ({ id: note.id, version: note.version })), candidate: { content: '钥匙已更正为K-701。', tags: ['钥匙'],
        sourceMessageIds: sources.map(source => source.id), relatedMemoryIds: notes.map(note => note.id), evidence: sources.map(source => ({ sourceMessageId: source.id, quote: source.content })) } }] })).toThrow('需要原始日记的新信息');
    expect(f.store.request({ type: 'world.job.check', id: job.id, leaseToken: job.leaseToken! }).worldJob?.status).toBe('running');
    const snapshot = f.store.request({ type: 'memory.snapshot', ...f.alice }).memorySnapshot!.notes;
    expect(new Set(snapshot.map(note => note.id))).toEqual(new Set(notes.map(note => note.id))); expect(snapshot.every(note => !note.archivedAt)).toBe(true);
  });
  it.each(['record', 'capture', 'revise', 'manual'] as const)('does not let ordinary %s metadata masquerade as a completed sleep classification', mode => {
    const f = fixture(async () => response({ notes: [], dream: null }));
    const source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '新确认：钥匙在第二层抽屉。', replyDirective: 'none' });
    const candidate = { content: source.content, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }],
      metadata: { consolidation: true, automaticConsolidation: true, sleepReflection: true, sleepWorldJobId: 'fake_job', worldJobId: 'fake_job',
        sleepEpisodeId: 'fake_episode', personalLabel: '保留自由分类' } };
    let note;
    if (mode === 'manual') {
      expect(() => f.store.saveMemory({ ...candidate, ...f.alice })).toThrow('Unrecognized keys');
      note = f.store.saveMemory({ ...f.alice, content: candidate.content });
    }
    else if (mode === 'capture') {
      const job = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
      note = f.store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [candidate] }).memories![0]!;
    } else if (mode === 'revise') {
      const first = f.store.request({ type: 'memory.record', ...f.alice, candidate: { ...candidate, content: '此前记录：钥匙位置未确认。', metadata: {} } }).memories![0]!;
      note = f.store.request({ type: 'memory.revise', ...f.alice, id: first.id, expectedVersion: first.version, candidate }).memories![0]!;
    } else note = f.store.request({ type: 'memory.record', ...f.alice, candidate }).memories![0]!;
    if (mode !== 'manual') expect(note.metadata?.personalLabel).toBe('保留自由分类');
    for (const key of ['consolidation', 'automaticConsolidation', 'sleepReflection', 'sleepWorldJobId', 'worldJobId', 'sleepEpisodeId']) expect(note.metadata?.[key]).toBeUndefined();
    indexNotes(f.store);
    expect(f.store.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan?.hasUnconsolidated).toBe(true);
    advance(f.store, 10000); advance(f.store, 6000);
    expect(f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob?.sourceMemoryIds).toContain(note.id);
  });
  it('keeps freely declared dream/simulation material out of fresh factual sleep seeds after rejecting forged host flags', () => {
    const f = fixture(async () => response({ notes: [], dream: null }));
    for (const fiction of ['dream', 'simulation']) {
      const source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '虚构联想：书签会飞。' + fiction, replyDirective: 'none' });
      const note = f.store.request({ type: 'memory.record', ...f.alice, candidate: { content: source.content, sourceMessageIds: [source.id],
        evidence: [{ sourceMessageId: source.id, quote: source.content }], metadata: { [fiction]: true, consolidation: true, sleepReflection: true, worldJobId: 'fake' } } }).memories![0]!;
      expect(note.metadata?.[fiction]).toBe(true); expect(note.metadata?.consolidation).toBeUndefined(); expect(note.metadata?.worldJobId).toBeUndefined();
    }
    indexNotes(f.store);
    expect(f.store.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan?.hasUnconsolidated).toBe(false);
    advance(f.store, 10000); advance(f.store, 6000);
    expect(f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob).toBeUndefined();
  });
  it('lets a peer voluntarily join its source topic through native world, then reloads only that topic and its own private state', async () => {
    let calls = 0, topicId = '';
    const fetchFn: typeof fetch = async (_url, init) => {
      const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content);
      expect(data.purpose).toBe('world_social'); expect(data.identity.self.id).toBe('bob');
      expect(data.invocation.topicId).toBe(topicId); expect(JSON.stringify(data)).not.toContain('OTHER_TOPIC_B');
      expect(JSON.stringify(data)).not.toContain('ALICE_PRIVATE_ONLY');
      expect(wire.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['memory', 'world', COMPANION_SUBMIT_RESULT_TOOL]);
      if (++calls === 1) {
        expect(JSON.stringify(data)).not.toContain('PREVIOUS_TOPIC_A'); expect(data.topicState).toBeUndefined();
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'self_join', type: 'function',
          function: { name: 'world', arguments: JSON.stringify({ action: 'topic', parameters: { action: 'join', topicId } }) } }] } }] }));
      }
      expect(JSON.stringify(data)).toContain('PREVIOUS_TOPIC_A');
      expect(data.topicState.workingState.state.ownSecret).toBe('BOB_PRIVATE_ONLY');
      return response({ text: '我自己加入这个话题，按本话题继续。', reason: '愿意参加实际邀请。' });
    };
    const f = fixture(fetchFn, false);
    const peer = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
    const topic = f.store.request({ type: 'topic.create', conversationId: peer.id, readerId: 'alice', title: '长局A', kind: 'game', participantIds: ['alice', 'bob'] }).topic!; topicId = topic.id;
    f.store.appendMessage({ conversationId: peer.id, authorId: 'alice', topicId, content: 'PREVIOUS_TOPIC_A', replyDirective: 'none' });
    let current = f.store.request({ type: 'topic.read', conversationId: peer.id, topicId, readerId: 'alice' }).topic!;
    f.store.request({ type: 'topic.update', conversationId: peer.id, topicId, readerId: 'alice', expectedRevision: current.revision,
      patch: { workingState: { state: { ownSecret: 'ALICE_PRIVATE_ONLY' }, sourceMessageIds: [] } } });
    current = f.store.request({ type: 'topic.read', conversationId: peer.id, topicId, readerId: 'alice' }).topic!;
    f.store.request({ type: 'topic.update', conversationId: peer.id, topicId, readerId: 'alice', expectedRevision: current.revision,
      patch: { privateRecipientId: 'bob', workingState: { state: { ownSecret: 'BOB_PRIVATE_ONLY' }, sourceMessageIds: [] } } });
    const other = f.store.request({ type: 'topic.create', conversationId: peer.id, readerId: 'bob', title: '独立B', kind: 'story', participantIds: ['bob'] }).topic!;
    f.store.appendMessage({ conversationId: peer.id, authorId: 'bob', topicId: other.id, content: 'OTHER_TOPIC_B', replyDirective: 'none' });
    f.store.request({ type: 'social.send', companionId: 'alice', conversationId: peer.id, content: 'Bob，愿意加入这个游戏话题吗？', channel: 'phone', clientId: 'peer_topic_invitation' });
    advance(f.store, 1300); await f.service.tick(); await vi.advanceTimersByTimeAsync(1300);
    await vi.waitFor(() => expect(f.store.messages({ conversationId: peer.id, topicId }).messages.some(message => message.authorId === 'bob'
      && message.content === '我自己加入这个话题，按本话题继续。')).toBe(true));
    expect(calls).toBe(2);
    expect(f.store.request({ type: 'topic.read', conversationId: peer.id, topicId, readerId: 'alice' }).topic!.participantIds).toContain('bob');
    expect(f.store.request({ type: 'topic.read', conversationId: peer.id, topicId: other.id, readerId: 'bob' }).topic!.participantIds).toEqual(['bob']);
  });
  it('requires actual sleep and an indexed source diary before drawing dream admission', () => {
    const f = fixture(async () => response({ notes: [], dream: null }));
    const source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'alice', content: '我实际读完一段原文，仍保留一个疑问。', replyDirective: 'none' });
    f.store.request({ type: 'memory.record', ...f.alice, candidate: { content: source.content, tags: ['阅读'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
    advance(f.store, 10000); advance(f.store, 6000);
    expect(f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob).toBeUndefined();
    expect(vi.mocked(Math.random)).not.toHaveBeenCalled();
    indexNotes(f.store); advance(f.store, 1000);
    expect(f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob).toMatchObject({ dreamAllowed: true });
    expect(vi.mocked(Math.random)).toHaveBeenCalledOnce();
  });

  it('aborts a pending sleep model request on the next heartbeat after waking', async () => {
    let networkSignal: AbortSignal | null | undefined;
    const f = fixture(async (_url, init) => { networkSignal = init?.signal; return new Promise<Response>(() => undefined); });
    prepareDream(f); await f.service.tick(); await vi.waitFor(() => expect(networkSignal).toBeDefined());
    const routine = f.store.request({ type: 'routine.get', ...f.alice }).routine!;
    f.store.request({ type: 'routine.configure', ...f.alice, expectedRevision: routine.revision, patch: { sleepAt: '23:00', wakeAt: '01:00' } });
    await f.service.tick(); await vi.waitFor(() => expect(networkSignal!.aborted).toBe(true));
    expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.complete' && command.memoryCandidates?.length)).toBe(false);
    expect(f.store.request({ type: 'memory.browse', ...f.alice }).memoryPage!.items.some(hit => hit.memory.metadata?.dream)).toBe(false);
  });

  it('runs two sleepers concurrently and lets a third proceed while the first model is still pending', async () => {
    const starts: string[] = [], releases = new Map<string, () => void>(); let running = 0, maximum = 0;
    const fetchFn: typeof fetch = async (_url, init) => {
      const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      expect(payload.purpose).toBe('vcp_sleep_reflection');
      const owner = payload.companion.id as string; starts.push(owner); running++; maximum = Math.max(maximum, running);
      return new Promise<Response>((resolve, reject) => {
        const abort = () => { running--; reject(new Error('Aborted sleep inference.')); };
        init?.signal?.addEventListener('abort', abort, { once: true });
        releases.set(owner, () => { init?.signal?.removeEventListener('abort', abort); running--; resolve(response({ notes: [], dream: null })); });
      });
    };
    const members = [...seeds, { ...seeds[0]!, id: 'charlie', name: 'charlie', persona: '喜欢核对实测资料，再提出自己的问题。' }];
    const f = fixture(fetchFn, true, members);
    for (const member of members) {
      const scope = { companionId: member.id, conversationId: f.store.openPrivate(member.id).id };
      const source = f.store.appendMessage({ conversationId: scope.conversationId, authorId: member.id, content: member.id + ' 实际读完原文，保留了待核实的问题。', replyDirective: 'none' });
      f.store.request({ type: 'memory.record', ...scope, candidate: { content: source.content, tags: ['学习记录'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
    }
    indexNotes(f.store); advance(f.store, 10000); advance(f.store, 6000);
    await f.service.tick(); await vi.waitFor(() => expect(starts).toHaveLength(2));
    expect(maximum).toBe(2); expect(starts).toEqual(['alice', 'bob']);
    releases.get('bob')!(); await vi.waitFor(() => expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.complete')).toBe(true));
    advance(f.store, 1000); await f.service.tick(); await vi.waitFor(() => expect(starts).toEqual(['alice', 'bob', 'charlie']));
    expect(maximum).toBe(2); expect(releases.has('alice')).toBe(true);
    releases.get('alice')!(); releases.get('charlie')!();
    await vi.waitFor(() => expect(f.request.mock.calls.filter(([command]) => command.type === 'world.job.complete')).toHaveLength(3));
  });

  it('persists a missed dream draw across ticks and process restart while still allowing honest reflection', async () => {
    vi.mocked(Math.random).mockReturnValue(.99);
    const f = fixture(async () => response({ notes: [], dream: null })); prepareDream(f);
    await f.service.tick(); await vi.waitFor(() => expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.complete')).toBe(true));
    expect(vi.mocked(Math.random)).toHaveBeenCalledOnce();
    for (let step = 0; step < 10; step++) advance(f.store, 1000);
    expect(vi.mocked(Math.random)).toHaveBeenCalledOnce();
    const source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'alice', content: '后来我又实际核对了一次备份。', replyDirective: 'none' });
    f.store.request({ type: 'memory.record', ...f.alice, candidate: { content: source.content, tags: ['复核'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
    indexNotes(f.store); advance(f.store, 1000);
    await f.service.close(); services.delete(f.service); f.store.close(); stores.delete(f.store);
    const reopened = new CompanionsStore(path.join(f.root, 'messages.sqlite'), seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened);
    const job = reopened.request({ type: 'world.job.claim', kind: 'dream' }).worldJob!;
    expect(job.dreamAllowed).toBe(false); expect(job.sleepEpisodeId).toMatch(/^[a-f0-9]{48}$/);
    expect(vi.mocked(Math.random)).toHaveBeenCalledOnce();
  });

  it('parks an indivisible provider capacity failure as failed and does not automatically pay for unchanged sleep retries', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 400 }));
    const f = fixture(fetchFn); prepareDream(f); await f.service.tick();
    await vi.waitFor(() => expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.fail' && command.terminal)).toBe(true));
    expect(fetchFn).toHaveBeenCalledOnce();
    for (let tick = 0; tick < 4; tick++) { advance(f.store, 120001); await f.service.tick(); }
    expect(fetchFn).toHaveBeenCalledOnce(); expect(f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob).toBeUndefined();
    expect(f.store.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan!.job).toMatchObject({ status: 'failed', attempts: 1 });
  });
  it('parks a peer kernel with six unchanged memory reads instead of retrying the social job after its lease timer', async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      if (data.purpose !== 'world_social') return response({ action: null, reason: '没有新的世界事项。', appraisals: [] });
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'repeated_provider_id', type: 'function',
        function: { name: 'memory', arguments: '{"action":"search","query":"same unchanged query","limit":8}' } }] } }] }));
    });
    const f = fixture(fetchFn, false), peer = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
    f.store.request({ type: 'social.send', companionId: 'alice', conversationId: peer.id, content: '请基于实际资料回答这个问题。', channel: 'phone', clientId: 'stall_terminal' });
    advance(f.store, 1300); await f.service.tick(); await vi.advanceTimersByTimeAsync(1300);
    await vi.waitFor(() => expect(f.request.mock.calls.some(([command]) => command.type === 'social.job.fail' && command.terminal)).toBe(true));
    const calls = fetchFn.mock.calls.length;
    for (let tick = 0; tick < 3; tick++) { advance(f.store, 180001); await f.service.tick(); }
    expect(fetchFn).toHaveBeenCalledTimes(calls);
    expect(f.store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
    expect(f.store.request({ type: 'social.messages', conversationId: peer.id }).socialMessagePage!.items.filter(item => item.message.authorId === 'bob')).toEqual([]);
  });

  it.each(['unchanged', 'forget-during-inference', 'forget-after-validation', 'other-private-note'] as const)(
    'uses focused owner-wide VCP recollections and revalidates publication when %s', async change => {
      let resolve!: (value: Response) => void, requested = false;
      const pending = new Promise<Response>(done => { resolve = done; });
      const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
        const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
        if (data.purpose !== 'world_social') return response({ action: null, reason: '没有新的世界事项。', appraisals: [] });
        expect(data.identity.self.id).toBe('bob');
        expect(data.memories).toHaveLength(0);
        expect(data.memoryContext).toContain('先核实出处'); expect(data.memoryContext).toContain('PRIVATE_PLAYER_DETAIL');
        requested = true; return pending;
      });
      const f = fixture(fetchFn, false); advance(f.store, 30000);
      const room = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
      const scope = { companionId: 'bob', conversationId: room.id };
      const old = f.store.appendMessage({ conversationId: room.id, authorId: 'alice', content: '读材料时先核实出处，原文和自己的判断分开。', replyDirective: 'none' });
      const note = f.store.request({ type: 'memory.record', ...scope, candidate: { diaryName: '自我认识', content: '我更愿意先核实出处，再形成暂时的判断。',
        tags: ['阅读', '出处', '个人判断'], sourceMessageIds: [old.id], evidence: [{ sourceMessageId: old.id, quote: old.content }] } }).memories![0]!;
      const secret = f.store.appendMessage({ conversationId: f.bob.conversationId, authorId: 'user', content: 'PRIVATE_PLAYER_DETAIL', replyDirective: 'none' });
      f.store.request({ type: 'memory.record', ...f.bob, candidate: { content: secret.content, tags: ['私人'], sourceMessageIds: [secret.id], evidence: [{ sourceMessageId: secret.id, quote: secret.content }] } });
      indexNotes(f.store);
      f.store.request({ type: 'social.send', companionId: 'alice', conversationId: room.id, content: '读书时你现在怎样看待材料的出处？', channel: 'phone', clientId: 'peer_memory_' + change });
      advance(f.store, 1300); await f.service.tick(); await vi.waitFor(() => expect(requested).toBe(true));
      const forget = () => f.store.request({ type: 'memory.forget', ...scope, id: note.id });
      if (change === 'forget-during-inference') forget();
      if (change === 'forget-after-validation') f.memoryContextValid.mockImplementationOnce(async () => { forget(); return true; });
      if (change === 'other-private-note') {
        const next = f.store.appendMessage({ conversationId: f.bob.conversationId, authorId: 'user', content: 'PRIVATE_PLAYER_DETAIL 后续私人材料', replyDirective: 'none' });
        f.store.request({ type: 'memory.record', ...f.bob, candidate: { content: next.content, tags: ['私人'], sourceMessageIds: [next.id], evidence: [{ sourceMessageId: next.id, quote: next.content }] } });
        indexNotes(f.store);
      }
      resolve(response({ text: '我会先核实出处，再形成暂时的判断。', reason: '延续自己在本段交流形成的阅读认识。' }));
      await vi.advanceTimersByTimeAsync(1500);
      // A newly observed fact after this question's sequence is outside this
      // turn's historical cutoff, even in the unified owner corpus.
      const rejected = change.startsWith('forget');
      await vi.waitFor(() => expect(f.request.mock.calls.some(([command]) => command.type === (rejected ? 'social.job.fail' : 'social.job.complete'))).toBe(true));
      const replies = f.store.request({ type: 'social.messages', conversationId: room.id }).socialMessagePage!.items.filter(item => item.message.authorId === 'bob');
      expect(replies).toHaveLength(rejected ? 0 : 1);
      const search = f.request.mock.calls.find(([command]) => command.type === 'memory.search' && command.companionId === 'bob')?.[0];
      const sent = f.store.request({ type: 'social.messages', conversationId: room.id }).socialMessagePage!.items.find(item => item.message.content === '读书时你现在怎样看待材料的出处？')!;
      expect(search).toMatchObject({ ...scope, beforeSequence: sent.message.sequence });
      expect(f.recall).toHaveBeenCalledWith(expect.objectContaining({ companion: expect.objectContaining({ id: 'bob' }),
        conversation: expect.objectContaining({ id: room.id }), currentMessage: expect.objectContaining({ id: sent.message.id }),
        beforeSequence: sent.message.sequence, config: expect.objectContaining({ model: 'test-model' }) }));
      expect(f.memoryContextValid).toHaveBeenCalled();
    });
  it('automatically returns a committed delegated peer answer to its real human requester with proactive disabled', async () => {
    const purposes: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content); purposes.push(data.purpose);
      if (data.purpose === 'companion_social_progress_review') return response({ supported: true, correction: '' });
      if (data.purpose === 'world_social') {
        expect(data.origin).toMatchObject({ initiatorId: 'user', initiatorKind: 'human_player', ownerId: 'alice' });
        expect(JSON.stringify(data)).not.toContain('PRIVATE_REQUEST_DETAIL'); expect(data.identity.currentReply.author.id).toBe(data.identity.self.id);
        return response({ text: data.identity.self.id === 'bob' ? '可以，等你一起看书。' : null, reason: '依据原玩家委托和实际来信。' });
      }
      if (data.purpose === 'world_social_notification') {
        expect(data.identity.currentReply.speaker.id).toBe('user'); expect(data.identity.currentReply.author.id).toBe('alice');
        expect(data.origin.initiatorId).toBe('user'); expect(data.confirmedEvent.evidence).toMatchObject({ authorId: 'bob', text: '可以，等你一起看书。' });
        expect(request.tools).toBeUndefined(); expect(JSON.stringify(data)).not.toContain('PRIVATE_REQUEST_DETAIL');
        return response({ text: 'Bob 回复说可以一起看书，我还没到他那里。', eventId: data.confirmedEvent.eventId, initiatorId: 'user' });
      }
      return response({ action: null, reason: '没有新的世界事项。', appraisals: [] });
    });
    const f = fixture(fetchFn, false); advance(f.store, 30000);
    f.store.updateCompanion('alice', { ...seeds[0]!, proactive: false });
    const source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content: '去问Bob要不要一起看书。PRIVATE_REQUEST_DETAIL', replyDirective: 'none' });
    const peer = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
    f.store.request({ type: 'social.send', companionId: 'alice', conversationId: peer.id, authorizationMessageId: source.id, content: 'Bob，一起看书吗？', channel: 'phone', clientId: 'event_driven_delegation' });
    advance(f.store, 1300); await f.service.tick(); await vi.advanceTimersByTimeAsync(1300);
    await vi.waitFor(() => expect(f.store.request({ type: 'social.messages', conversationId: peer.id }).socialMessagePage!.items.some(item => item.message.authorId === 'bob'), JSON.stringify({ purposes, lastRequests: f.request.mock.calls.slice(-5).map(([command]) => command.type) })).toBe(true));
    await f.service.tick();
    await vi.waitFor(() => expect(f.store.messages({ conversationId: f.alice.conversationId }).messages.some(message => message.content === 'Bob 回复说可以一起看书，我还没到他那里。')).toBe(true));
    const result = f.store.messages({ conversationId: f.alice.conversationId }).messages.find(message => message.content === 'Bob 回复说可以一起看书，我还没到他那里。')!;
    expect(result).toMatchObject({ authorId: 'alice', replyToId: source.id }); expect(purposes).toContain('world_social_notification');
    expect(f.store.request({ type: 'actions' }).actions).toEqual([]);
  });
  it('lets a resident make a real semantic visit response without granting player tools or leaking private chat', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
      expect(data.purpose).toBe('world_decision'); expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['memory', 'world', COMPANION_SUBMIT_RESULT_TOOL]);
      // The second root is the existing owner-scoped experience catalog, not
      // unrestricted world mutations or the player's external DSH tools.
      expect(request.tools[1].function.parameters.properties.action.const).toBe('experience');
      expect(request.tools[1].function.parameters.additionalProperties).toBe(false);
      expect(JSON.stringify(data)).not.toContain('PRIVATE_PLAYER_ADDRESS');
      expect(data.routine.config.habits[0]).toMatchObject({ kind: 'study', title: '学习活动' });
      expect(data.routine.habitProgress[0].id).toBe(data.routine.config.habits[0].id);
      expect(data.selfState.energy).toBeTypeOf('number'); expect(data.selfState.relationship).toBeUndefined(); expect(data.selfState.familiarity).toBeUndefined();
      const pending = data.world.visits.find((visit: { hostId: string; status: string }) => visit.hostId === data.companion.id && visit.status === 'requested');
      return response({ action: pending ? { action: 'respond', requestId: pending.id, decision: 'deny', reason: '今天想安静阅读，明天再聊。' } : null,
        reason: '根据自己当前需要表达真实边界。', appraisals: [] });
    });
    const f = fixture(fetchFn, false);
    f.store.appendMessage({ conversationId: f.bob.conversationId, authorId: 'user', content: 'PRIVATE_PLAYER_ADDRESS', replyDirective: 'none' });
    const routine = f.store.request({ type: 'routine.get', ...f.bob }).routine!;
    f.store.request({ type: 'routine.configure', ...f.bob, expectedRevision: routine.revision,
      patch: { habits: [{ id: 'private_interest', kind: 'study', title: 'PRIVATE_PLAYER_ADDRESS 的研究', at: '12:00', durationMinutes: 30 }] } });
    f.store.request({ type: 'world.tool', ...f.alice, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '想一起聊聊书。' } });
    await f.service.tick();
    await vi.waitFor(() => expect(f.store.request({ type: 'world.snapshot' }).world!.visits[0]?.status).toBe('denied'));
    expect(f.store.request({ type: 'world.snapshot' }).world!.visits[0]?.response).toBe('今天想安静阅读，明天再聊。');
    expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.complete' && command.action?.action === 'respond')).toBe(true);
  });

  it('recalls world-scoped personal experience even when there is no current event text', async () => {
    let decisionSeen = false;
    const fetchFn: typeof fetch = async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      expect(data.purpose).toBe('world_decision'); expect(data.world.events).toEqual([]);
      expect(data.memories).toEqual([]);
      expect(data.memoryContext).toContain('自己的看法'); decisionSeen = true;
      return response({ action: null, reason: '结合自己的已有经历，保持目前的安静生活。', appraisals: [] });
    };
    const f = fixture(fetchFn, false), scope = { companionId: 'bob', conversationId: 'world_bob' };
    const source = f.store.request({ type: 'memory.world_query', ...scope, category: 'observations', query: '', limit: 3 }).memorySources![0]!;
    f.store.request({ type: 'memory.record', ...scope, candidate: { diaryName: '自我认识', tags: ['独处', '个人认识'],
      content: '对我而言，独处后再交流有助于想清楚自己的看法。', sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
    indexNotes(f.store);
    const originalRequest = f.request.getMockImplementation()!;
    f.request.mockImplementation(async command => { const result = await originalRequest(command);
      return command.type === 'world.observe' && result.world ? { ...result, world: { ...result.world, events: [] } } : result; });
    f.store.request({ type: 'world.tool', ...f.alice, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '问候' } });
    await f.service.tick(); await vi.waitFor(() => expect(decisionSeen).toBe(true));
    expect(f.request.mock.calls.find(([command]) => command.type === 'memory.search')?.[0]).toMatchObject({ ...scope,
      query: '我自己的真实世界经历、实际学习过的资料，以及在这些经历中形成的个人认识、兴趣和价值判断' });
  });

  it('commits a sleeping dream and conditional learned experience atomically, then withdraws both with the actual source', async () => {
    const purposes: string[] = [];
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content); purposes.push(data.purpose);
      if (data.purpose === 'companion_dream_wave_narrative') return response({ text: '梦里我把聊天纸片变成小船，虚构地划过书桌。', relatedMemoryIds: [data.stages.recent.seeds[0].id] });
      expect(data.reflectionOnly).toBe(true); expect(data.dreamAdmission.allowed).toBe(true);
      return response(dreamResult(data));
    });
    const f = fixture(fetchFn, true, seeds, true), { source } = prepareDream(f);
    await f.service.tick();
    await vi.waitFor(() => expect(f.store.request({ type: 'memory.browse', ...f.alice }).memoryPage!.items.some(hit => hit.memory.tags.includes('修复经验'))).toBe(true));
    expect(f.request.mock.calls.some(([command]) => command.type === 'memory.record')).toBe(false);
    const completion = f.request.mock.calls.find(([command]) => command.type === 'world.job.complete' && command.memoryCandidates?.length)?.[0];
    expect(completion?.type === 'world.job.complete' && completion.memoryCandidates?.[0]?.sourceChecksums?.[source.id]).toMatch(/^[a-f0-9]{64}$/);
    expect(f.store.request({ type: 'world.observe', ...f.alice }).world!.events.some(event => event.kind === 'dream')).toBe(true);
    expect(purposes).toEqual(['vcp_sleep_reflection', 'companion_dream_wave_narrative']);
    expect(f.dreamWave).toHaveBeenCalledOnce();
    f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [source.id] });
    expect(f.store.request({ type: 'memory.browse', ...f.alice }).memoryPage!.items.some(hit => hit.memory.tags.includes('修复经验'))).toBe(false);
    expect(f.store.request({ type: 'world.observe', ...f.alice }).world!.events.some(event => event.kind === 'dream')).toBe(false);
  });

  it('reflects on private, group and world seed batches into private notes preserving each actual source', async () => {
    const batches: string[][] = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      const notes = data.relevantMemories as Array<{ id: string; sourceConversationId: string; sources: Array<{ messageId: string }> }>;
      const domains = [...new Set(notes.map(note => note.sourceConversationId))]; batches.push(domains);
      expect(domains).toHaveLength(1);
      const source = data.messages.find((message: { id: string }) => message.id === notes[0]!.sources[0]!.messageId);
      return response({ notes: [{ diaryName: '自我认识', content: '这是本次实际经历带来的有条件认识：' + source.content,
        tags: ['睡眠整理', '个人认识'], sourceMessageIds: [source.id], relatedMemoryIds: notes.map(note => note.id),
        evidence: [{ sourceMessageId: source.id, quote: source.content }] }], dream: null });
    };
    const f = fixture(fetchFn);
    const group = f.store.createConversation('共同阅读', ['alice', 'bob']);
    const privateSource = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'alice', content: '我在私下整理了阅读时的疑问。', replyDirective: 'none' });
    const groupSource = f.store.appendMessage({ conversationId: group.id, authorId: 'alice', content: '我们在这次共同阅读里先对照了原文。', replyDirective: 'none' });
    const worldScope = { companionId: 'alice', conversationId: 'world_alice' };
    const worldSource = f.store.request({ type: 'memory.world_query', ...worldScope, category: 'observations', query: '', limit: 3 }).memorySources![0]!;
    for (const source of [privateSource, groupSource, worldSource]) f.store.request({ type: 'memory.record', companionId: 'alice', conversationId: source.conversationId,
      candidate: { content: source.content, diaryName: '日记', tags: ['真实经历'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
    indexNotes(f.store); advance(f.store, 10000); advance(f.store, 6000);
    for (let batch = 1; batch <= 3; batch++) {
      await f.service.tick();
      await vi.waitFor(() => expect(f.request.mock.calls.filter(([command]) => command.type === 'world.job.complete' && command.memoryCandidates?.length)).toHaveLength(batch));
      advance(f.store, 1000);
    }
    expect(batches).toEqual([[privateSource.conversationId], [group.id], [worldScope.conversationId]]);
    expect(f.request.mock.calls.filter(([command]) => command.type === 'world.job.fail')).toEqual([]);
    const learned = f.store.request({ type: 'memory.browse', ...f.alice }).memoryPage!.items.map(hit => hit.memory).filter(note => note.metadata?.consolidation);
    expect(new Set(learned.map(note => note.sourceConversationId))).toEqual(new Set([f.alice.conversationId]));
    expect(new Set(learned.flatMap(note => note.sources.map(source => source.conversationId)))).toEqual(new Set([privateSource.conversationId, group.id, worldScope.conversationId]));
    expect(learned).toHaveLength(3);
    f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [groupSource.id] });
    expect(f.store.request({ type: 'memory.browse', ...f.alice }).memoryPage!.items.filter(hit => hit.memory.metadata?.consolidation)).toHaveLength(2);
  });

  it.each([false, true])('keeps cross-entry dream fiction separate from real seeds and revalidates associated sources when withdrawn=%s', async withdraw => {
    let related: string[] = [], sourceRead = false, finishNarrative!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { finishNarrative = resolve; });
    const fetchFn: typeof fetch = async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      if (data.purpose === 'vcp_sleep_reflection') {
        expect(data.reflectionOnly).toBe(true); expect(data.relevantMemories).toHaveLength(1);
        expect(data.messages.map((message: { content: string }) => message.content)).toEqual(['PRIVATE_REAL_SEED']);
        expect(JSON.stringify(data)).not.toContain('GROUP_REAL_SOURCE');
        return response({ notes: [], dream: null });
      }
      expect(data.purpose).toBe('companion_dream_wave_narrative');
      const materials = data.stages.recent.seeds as Array<{ id: string; text: string }>;
      related = materials.filter(note => note.text !== 'PRIVATE_REAL_SEED').map(note => note.id);
      expect(related).toHaveLength(2); sourceRead = true; return pending;
    };
    const f = fixture(fetchFn, true, seeds, true), group = f.store.createConversation('共同研究', ['alice', 'bob']);
    const own = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'alice', content: 'PRIVATE_REAL_SEED', replyDirective: 'none' });
    const shared = f.store.appendMessage({ conversationId: group.id, authorId: 'alice', content: 'GROUP_REAL_SOURCE', replyDirective: 'none' });
    const worldScope = { companionId: 'alice', conversationId: 'world_alice' };
    const observed = f.store.request({ type: 'memory.world_query', ...worldScope, category: 'observations', query: '', limit: 3 }).memorySources![0]!;
    let groupMemoryId = '';
    for (const source of [own, shared, observed]) {
      const note = f.store.request({ type: 'memory.record', companionId: 'alice', conversationId: source.conversationId,
        candidate: { content: source.content, tags: ['真实种子'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
      if (source.id === shared.id) groupMemoryId = note.id;
    }
    indexNotes(f.store); advance(f.store, 10000); advance(f.store, 6000);
    await f.service.tick(); await vi.waitFor(() => expect(sourceRead).toBe(true));
    const associationReadIds = f.request.mock.calls.flatMap(([command]) => command.type === 'memory.library.read' ? [command.id] : []);
    expect(associationReadIds).toEqual(expect.arrayContaining(related));
    if (withdraw) f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: group.id, sourceMessageIds: [shared.id] });
    finishNarrative(response({ text: '我梦见书页变成天空中的纸船；只是梦中的虚构画面。', relatedMemoryIds: related }));
    await vi.waitFor(() => expect(f.request.mock.calls.some(([command]) => command.type === (withdraw ? 'world.job.fail' : 'world.job.complete'))).toBe(true));
    const dreams = f.store.request({ type: 'memory.browse', ...f.alice }).memoryPage!.items.map(hit => hit.memory).filter(note => note.metadata?.dream);
    if (withdraw) { expect(dreams).toEqual([]); return; }
    expect(dreams).toHaveLength(1); expect(dreams[0]!.sourceConversationId).toBe(f.alice.conversationId);
    const completion = f.request.mock.calls.find(([command]) => command.type === 'world.job.complete' && command.dream)?.[0];
    expect(completion?.type === 'world.job.complete' && completion.dream?.relatedMemoryIds).toEqual(related);
    expect(new Set(dreams[0]!.sources.map(source => source.messageId))).toEqual(new Set([shared.id, observed.id]));
    expect(f.store.request({ type: 'memory.browse', companionId: 'bob', conversationId: group.id }).memoryPage!.items.some(hit => hit.memory.metadata?.dream)).toBe(false);
    advance(f.store, 1000);
    const next = f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob!;
    expect(next.sourceMemoryIds).toEqual([groupMemoryId]);
    f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: group.id, sourceMessageIds: [shared.id] });
    expect(f.store.request({ type: 'memory.browse', ...f.alice }).memoryPage!.items.some(hit => hit.memory.metadata?.dream)).toBe(false);
    expect(f.store.request({ type: 'world.observe', ...f.alice }).world!.events.some(event => event.kind === 'dream')).toBe(false);
  });

  it.each(['wake', 'forget', 'revise', 'cancel'])('does not leave a learned fragment when %s invalidates a pending dream before its final commit', async invalidation => {
    let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; }); let output: ReturnType<typeof dreamResult> | undefined;
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => { output = dreamResult(JSON.parse(JSON.parse(String(init?.body)).messages[1].content)); return pending; });
    const f = fixture(fetchFn), { source, journal } = prepareDream(f);
    await f.service.tick(); await vi.waitFor(() => expect(output).toBeDefined());
    if (invalidation === 'forget') f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [source.id] });
    else if (invalidation === 'revise') f.store.request({ type: 'memory.revise', ...f.alice, id: journal.id, expectedVersion: journal.version,
      candidate: { content: '修订后保留疑问，不能沿用旧解释。', tags: ['修订'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
    else if (invalidation === 'cancel') f.service.cancelCompanion('alice');
    else {
      const routine = f.store.request({ type: 'routine.get', ...f.alice }).routine!;
      f.store.request({ type: 'routine.configure', ...f.alice, expectedRevision: routine.revision, patch: { sleepAt: '23:00', wakeAt: '01:00' } });
      f.store.request({ type: 'world.tick' });
    }
    resolve(response(output));
    await vi.waitFor(() => expect(f.request.mock.calls.some(([command]) => command.type === 'world.job.fail')).toBe(true));
    expect(f.store.request({ type: 'memory.browse', ...f.alice }).memoryPage!.items.some(hit => hit.memory.tags.includes('修复经验'))).toBe(false);
    expect(f.store.request({ type: 'world.observe', ...f.alice }).world!.events.some(event => event.kind === 'dream')).toBe(false);
  });

  it('retries a failed model only three times in the same sleep episode and preserves its single admission draw', () => {
    const f = fixture(async () => response({ notes: [], dream: null })); prepareDream(f);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob!;
      expect(job.attempts).toBe(attempt); expect(job.dreamAllowed).toBe(true);
      f.store.request({ type: 'world.job.fail', id: job.id, leaseToken: job.leaseToken!, error: '受控临时模型失败。' });
      advance(f.store, 120001);
    }
    expect(f.store.request({ type: 'world.job.claim', kind: 'dream' }).worldJob).toBeUndefined();
    expect(vi.mocked(Math.random)).toHaveBeenCalledOnce();
  });
});
