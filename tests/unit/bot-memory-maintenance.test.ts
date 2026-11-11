import { describe, expect, it, vi } from 'vitest';
import { BotDshOutputLimitError } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryMaintenance, type BotMemoryMaintenanceCandidate, type BotMemoryMaintenanceOptions, type BotMemoryMaintenancePlan, type BotMemoryMaintenancePrepareInput, type BotMemoryMaintenanceSnapshot } from '../../src/main/companion-bot/memory-maintenance';

const ids = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
const scope = { companionId: 'companion-a', conversationId: 'private-a', securityDomainId: 'private-a' };
function proposal(type: BotMemoryMaintenanceCandidate['type'] = 'organize') {
  const sources = type === 'organize' ? ids.slice(0, 2) : [ids[0]!];
  return { narrative: '这只是基于原文的联想，不是用户事实。', candidates: [{ type, sourceIds: sources, content: type === 'archive' ? '' : '用户将周六湖边计划更正为博物馆，尚未订票。',
    tags: ['计划', '未决'], reason: '同一事件存在明确更正', uncertainties: [], quotes: sources.map((sourceId, index) => ({ sourceId, text: index ? '改为博物馆' : '计划周六去湖边' })) }] };
}
function fixture(output = proposal()) {
  let revision = '0', snapshot: BotMemoryMaintenanceSnapshot | undefined;
  const notes = ids.map((id, index) => ({ id, checksum: String(index + 1).repeat(32), content: ['用户：计划周六去湖边，尚未出发。', '用户：下雨，改为博物馆，尚未订票。', '伙伴：这是推测，尚未验证。'][index]!,
    tags: ['计划'], createdAt: '2026-11-03T10:00:00Z', sourceMessageIds: [`message-${index}`], sourceEventId: `event-${index}`, indexState: 'indexed' }));
  const memory = { catalog: vi.fn(async () => ({ items: notes.map(note => ({ ...note, content: '短预览' })), nextCursor: 'next-page' })),
    readNote: vi.fn(async (_scope, input) => notes.find(note => note.id === input.id)), withdrawnSources: vi.fn(async () => ({ revision, sourceEventIds: [], sourceMessageIds: [] })),
    tool: vi.fn(async () => ({ results: [{ score: 0.73, text: '真实边界的替身结果' }] })), dreamRecall: vi.fn(async () => ({ engine: 'DreamWaveEngine', groups: { 'recent.seeds': [{ id: ids[0], checksum: '1'.repeat(32) }] } })),
    update: vi.fn<BotMemoryMaintenanceOptions['memory']['update']>(async () => ({ state: 'indexed', indexed: true })), organize: vi.fn<BotMemoryMaintenanceOptions['memory']['organize']>(async () => ({ state: 'indexed', indexed: true, archived: ids.slice(0, 2) })),
    maintenanceInsight: vi.fn(async () => ({ state: 'indexed', indexed: true })), maintenanceArchive: vi.fn(async () => ({ state: 'archived', retained: true })), operationReceipt: vi.fn(async () => ({})) };
  const brain = { run: vi.fn<BotMemoryMaintenanceOptions['brain']['run']>(async () => ({ text: JSON.stringify(output), sessionId: 'app-maintenance', eventId: 'maintenance', status: 'succeeded' as const })), archive: vi.fn(async () => undefined) };
  const options = { brain, memory, cwd: () => 'C:/owned-test/maintenance', callback: async () => ({ url: 'http://127.0.0.1/callback', token: 'test' }),
    model: () => ({ model: 'fixture', apiFormat: 'openai_chat' as const, baseUrl: 'http://127.0.0.1', apiKey: 'never-log-this-fixture-secret' }) } satisfies BotMemoryMaintenanceOptions;
  const core = new BotMemoryMaintenance(options);
  const input: BotMemoryMaintenancePrepareInput = { scope, kind: 'organize', operationId: 'job-1', contextEpoch: 1, onSnapshot: async value => { snapshot = value; } };
  return { core, input, brain, memory, notes, getSnapshot: () => snapshot!, revision: (value: string) => { revision = value; } };
}

describe('scoped memory maintenance planning', () => {
  it('keeps long narrative and candidate bodies whole without imposing a candidate-count quota', async () => {
    const output = proposal('insight'); output.narrative = '完整梦境叙事。'.repeat(2000);
    output.candidates = Array.from({ length: 15 }, (_, index) => ({ ...output.candidates[0]!, content: '有来源的完整感悟。'.repeat(1600) + index }));
    const f = fixture(output), result = await f.core.preparePlan({ ...f.input, kind: 'dream' });
    expect(result.candidates).toHaveLength(15); expect(result.narrative).toBe(output.narrative);
    expect(result.candidates[14]!.content).toBe(output.candidates[14]!.content);
  });
  it('continues every native output fragment on the same event until a complete sourced plan is available', async () => {
    const f = fixture(), body = JSON.stringify(proposal()), fragments = Array.from({ length: 6 }, (_, index) => body.slice(Math.floor(body.length * index / 6), Math.floor(body.length * (index + 1) / 6)));
    const saved: unknown[] = [];
    f.brain.run.mockImplementation(async input => {
      const index = input.continueAfterSeq === undefined ? 0 : input.continueAfterSeq;
      if (index < 5) throw new BotDshOutputLimitError(input.eventId, input.laneId, index + 1, fragments[index]!);
      return { text: fragments[5]!, status: 'succeeded', eventId: input.eventId, sessionId: input.laneId };
    });
    const result = await f.core.preparePlan({ ...f.input, admissionAttempt: 8, onContinuation: async checkpoint => { saved.push(checkpoint); } });
    expect(result.candidates).toHaveLength(1); expect(saved).toHaveLength(5);
    expect(new Set(f.brain.run.mock.calls.map(([input]) => input.eventId)).size).toBe(1);
    expect(f.brain.run.mock.calls.slice(1).every(([input]) => input.continuationPrompt?.includes('剩余字符'))).toBe(true);
    expect(f.memory.catalog).toHaveBeenCalledOnce(); expect(f.brain.archive).toHaveBeenCalledOnce();
  });
  it('freezes full sources before an independent action-free AppBrain turn and never writes while planning', async () => {
    const f = fixture(); f.brain.run.mockImplementationOnce(async () => { expect(f.getSnapshot().sources[0]!.content).toContain('尚未出发'); return { text: JSON.stringify(proposal()), sessionId: 'app', eventId: 'e', status: 'succeeded' }; });
    const diagnostic = vi.fn(async () => undefined), plan = await f.core.preparePlan({ ...f.input, onDiagnostic: diagnostic });
    expect(plan.candidates).toHaveLength(1); expect(plan.scan).toMatchObject({ examined: 3, selected: 3, nextCursor: 'next-page' });
    expect(f.memory.catalog).toHaveBeenCalledWith(scope, { cursor: undefined, limit: 24 });
    expect(f.brain.run).toHaveBeenCalledWith(expect.objectContaining({ role: 'brain', laneId: expect.stringMatching(/^memory-maintenance-/u), tools: [], prompt: expect.stringContaining('尚未出发') }));
    expect(f.brain.archive).toHaveBeenCalledOnce(); expect(f.memory.organize).not.toHaveBeenCalled(); expect(f.memory.maintenanceInsight).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('never-log-this-fixture-secret');
  });
  it('uses the real DreamWave RPC contract for dream association, preserving original scores without LightMemo renaming', async () => {
    const f = fixture(proposal('insight')); const plan = await f.core.preparePlan({ ...f.input, kind: 'dream' });
    expect(f.memory.dreamRecall).toHaveBeenCalledWith(scope, { sources: f.notes.map(note => ({ id: note.id, expectedChecksum: note.checksum })), expectedSourceRevision: '0' }, undefined);
    expect(f.memory.tool).not.toHaveBeenCalled(); expect(plan.retrieval.engine).toBe('DreamWaveEngine'); expect(plan.candidates[0]!.type).toBe('insight');
  });
  it('uses a new version as the seed and reads only explicitly associated old notes as complete context', async () => {
    const f = fixture(), associate = vi.fn(async () => [{ id: ids[1]!, checksum: '2'.repeat(32) }]);
    const selectBatch = vi.fn(async () => ({ mode: 'incremental-v1' as const, revision: '0', state: 'processing', items: [{ id: ids[0]!, checksum: '1'.repeat(32) }] }));
    const plan = await f.core.preparePlan({ ...f.input, selectBatch, associate });
    expect(plan.scan).toMatchObject({ incremental: true, examined: 1, selected: 2, context: 1 });
    expect(plan.sources.map(source => source.role)).toEqual(['seed', 'context']); expect(plan.sources[1]!.content).toBe(f.notes[1]!.content);
    expect(f.memory.catalog).not.toHaveBeenCalled(); expect(f.memory.readNote).toHaveBeenCalledTimes(2);
    await f.core.preparePlan({ ...f.input, selectBatch, associate, snapshot: f.getSnapshot() }); expect(selectBatch).toHaveBeenCalledOnce(); expect(associate).toHaveBeenCalledOnce();
  });
  it('does not accept a candidate that only rewrites historical context without a new source', async () => {
    const output = proposal('update'); output.candidates[0]!.sourceIds = [ids[1]!]; output.candidates[0]!.quotes = [{ sourceId: ids[1]!, text: '改为博物馆' }];
    const f = fixture(output);
    await expect(f.core.preparePlan({ ...f.input, selectBatch: async () => ({ mode: 'incremental-v1', revision: '0', state: 'processing', items: [{ id: ids[0]!, checksum: '1'.repeat(32) }] }), associate: async () => [{ id: ids[1]!, checksum: '2'.repeat(32) }] })).rejects.toMatchObject({ code: 'MEMORY_MAINTENANCE_INVALID_PLAN' });
    expect(f.memory.update).not.toHaveBeenCalled();
  });
  it('replays the frozen checkpoint without rescanning changed catalogs and retains a stable model event', async () => {
    const f = fixture(); await f.core.preparePlan(f.input); const snapshot = f.getSnapshot();
    await f.core.preparePlan({ ...f.input, snapshot });
    expect(f.memory.catalog).toHaveBeenCalledOnce(); expect(f.memory.readNote).toHaveBeenCalledTimes(3);
    expect(f.brain.run.mock.calls[0]).toEqual(f.brain.run.mock.calls[1]);
    await f.core.preparePlan({ ...f.input, snapshot, admissionAttempt: 1 });
    expect(f.brain.run.mock.calls[2]![0].laneId).not.toBe(f.brain.run.mock.calls[0]![0].laneId);
  });
  it('keeps an over-budget note whole and deferred while processing other notes and retaining the next cursor', async () => {
    const f = fixture(proposal('update')); f.notes[2]!.content = '很长日记'.repeat(100000);
    const plan = await f.core.preparePlan(f.input);
    expect(plan.scan.deferred).toEqual([{ id: ids[2], reason: expect.stringContaining('预算'), retryable: true, code: 'capacity' }]); expect(plan.sources).toHaveLength(2);
    expect(plan.sources[0]!.content).toBe(f.notes[0]!.content); expect(plan.scan.nextCursor).toBe('next-page');
  });
  it('does not admit a model turn when a source withdrawal invalidates the snapshot', async () => {
    const f = fixture(); await f.core.preparePlan(f.input); f.brain.run.mockClear(); f.revision('1');
    await expect(f.core.preparePlan({ ...f.input, snapshot: f.getSnapshot() })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_WITHDRAWN' }); expect(f.brain.run).not.toHaveBeenCalled();
  });
  it('skips archived and withdrawn sources without treating an ineligible page as an incomplete scan', async () => {
    const f = fixture(); f.notes[0]!.indexState = 'archived'; f.notes[1]!.indexState = 'forgotten'; f.notes[2]!.indexState = 'withdrawing';
    const plan = await f.core.preparePlan(f.input);
    expect(plan.scan).toMatchObject({ examined: 3, selected: 0, deferred: [], nextCursor: 'next-page' });
    expect(f.brain.run).not.toHaveBeenCalled(); expect(f.memory.tool).not.toHaveBeenCalled();
  });
  it('revisits pending and temporarily unreadable notes instead of treating their page as covered', async () => {
    const f = fixture({ narrative: '', candidates: [] }); f.notes[0]!.indexState = 'pending';
    f.memory.readNote.mockImplementation(async (_scope, input) => { if (input.id === ids[1]) throw Object.assign(new Error('temporary transport failure'), { code: 'SESSION_CLOSED' }); return f.notes.find(note => note.id === input.id); });
    const plan = await f.core.preparePlan(f.input);
    expect(plan.scan.deferred).toEqual([{ id: ids[0], reason: '日记索引尚待确认，确认后再维护', retryable: true, code: 'pending' }, { id: ids[1], reason: 'temporary transport failure', retryable: true, code: 'unavailable' }]);
    expect(plan.sources.map(source => source.id)).toEqual([ids[2]]);
  });
  it('discards model output if withdrawal happens during inference', async () => {
    const f = fixture(); f.brain.run.mockImplementationOnce(async () => { f.revision('1'); return { text: JSON.stringify(proposal()), sessionId: 'app', eventId: 'e', status: 'succeeded' }; });
    await expect(f.core.preparePlan(f.input)).rejects.toMatchObject({ code: 'MEMORY_SOURCE_WITHDRAWN' }); expect(f.memory.organize).not.toHaveBeenCalled();
  });
  it('keeps an acknowledged terminal cancellation distinct from a generic aborted signal', async () => {
    const f = fixture(), controller = new AbortController();
    f.brain.run.mockImplementationOnce(async () => { controller.abort(new Error('idle job yielded')); return { text: '', sessionId: 'app', eventId: 'e', status: 'cancelled' }; });
    await expect(f.core.preparePlan({ ...f.input, signal: controller.signal })).rejects.toMatchObject({ code: 'MEMORY_MAINTENANCE_MODEL_CANCELLED' });
    expect(f.brain.archive).toHaveBeenCalledOnce();
  });
  it('preserves unknown model delivery without treating it as cancelled or issuing another admission', async () => {
    const f = fixture(), unknown = Object.assign(new Error('delivery not confirmed'), { code: 'BOT_DELIVERY_UNKNOWN' }); f.brain.run.mockRejectedValueOnce(unknown);
    await expect(f.core.preparePlan(f.input)).rejects.toBe(unknown); expect(f.brain.run).toHaveBeenCalledOnce(); expect(f.memory.organize).not.toHaveBeenCalled();
  });
  it.each(['foreign-source', 'invented-quote', 'missing-source-quote'])('rejects unsupported evidence: %s', async problem => {
    const output = proposal();
    if (problem === 'foreign-source') output.candidates[0]!.sourceIds = ['f'.repeat(64), ids[1]!];
    if (problem === 'invented-quote') output.candidates[0]!.quotes[0]!.text = '已经订票并出发';
    if (problem === 'missing-source-quote') output.candidates[0]!.quotes.pop();
    const f = fixture(output); await expect(f.core.preparePlan(f.input)).rejects.toMatchObject({ code: 'MEMORY_MAINTENANCE_INVALID_PLAN' }); expect(f.memory.organize).not.toHaveBeenCalled();
  });
  it('isolates malformed or overlapping individual candidates while preserving fully validated work', async () => {
    const output = proposal(), invalid = { ...output.candidates[0]! } as Record<string, unknown>; delete invalid.quotes;
    output.candidates.push(invalid as unknown as typeof output.candidates[number], { ...output.candidates[0]! });
    const f = fixture(output), result = await f.core.preparePlan(f.input);
    expect(result.candidates).toHaveLength(1); expect(result.validationIssues).toHaveLength(2); expect(result.scan.deferred).toEqual([]);
    expect(result.validationIssues?.map(issue => issue.candidateIndex)).toEqual([1, 2]);
  });
  it('isolates a paraphrased quote while retaining independently valid candidates and leaving its original for later work', async () => {
    const output = proposal('update'); output.candidates.push({ ...proposal('update').candidates[0]!, sourceIds: [ids[2]!], quotes: [{ sourceId: ids[2]!, text: '凭空还原的聊天原话' }] });
    const f = fixture(output), diagnostic = vi.fn<(phase: string, value: unknown) => Promise<void>>(async () => undefined), plan = await f.core.preparePlan({ ...f.input, onDiagnostic: diagnostic });
    expect(plan.candidates).toHaveLength(1); expect(plan.candidates[0]!.sourceIds).toEqual([ids[0]]);
    expect(plan.validationIssues).toEqual([{ candidateIndex: 1, sourceIds: [ids[2]], reason: expect.stringContaining('原件保留') }]);
    expect(plan.scan.deferred).toContainEqual({ id: ids[2], code: 'invalid_candidate', retryable: true, reason: expect.any(String) });
    expect(diagnostic.mock.calls.some(([phase]) => phase === 'candidate-validation')).toBe(true); expect(f.memory.update).not.toHaveBeenCalled();
  });
});

describe('reviewed maintenance application', () => {
  it('does not impose a character ceiling on an individually approved complete output', async () => {
    const output = proposal(); output.candidates[0]!.content = '用户原计划周六去湖边，后改为博物馆，尚未订票。\n'.repeat(1500);
    const f = fixture(output), plan = await f.core.preparePlan(f.input);
    expect(output.candidates[0]!.content.length).toBeGreaterThan(24000);
    expect((await f.core.applyCandidate({ scope, plan, candidateId: plan.candidates[0]!.id, contextEpoch: plan.contextEpoch, approval: 'review' })).status).toBe('indexed');
    expect(f.memory.organize.mock.calls[0]![1].content).toBe(output.candidates[0]!.content);
  });
  async function ready(type: BotMemoryMaintenanceCandidate['type'] = 'organize') { const f = fixture(proposal(type)); const plan = await f.core.preparePlan({ ...f.input, kind: type === 'insight' ? 'dream' : 'organize' }); return { ...f, plan }; }
  const apply = (plan: BotMemoryMaintenancePlan, approval: 'review' | 'lossless' = 'review') => ({ scope, plan, candidateId: plan.candidates[0]!.id, contextEpoch: 1, approval });
  it('uses source CAS/revision and a stable operation ID, and keeps pending receipts visibly pending', async () => {
    const f = await ready(); f.memory.organize.mockResolvedValueOnce({ state: 'pending', indexed: false, archived: [] });
    const pending = await f.core.applyCandidate(apply(f.plan)), done = await f.core.applyCandidate(apply(f.plan));
    expect(pending.status).toBe('pending'); expect(done.status).toBe('indexed'); expect(done.operationId).toBe(pending.operationId);
    expect(f.memory.organize.mock.calls[0]![1]).toMatchObject({ expectedSourceRevision: '0', sources: f.notes.slice(0, 2).map(note => ({ id: note.id, expectedChecksum: note.checksum })), sourceMessageIds: [] });
    expect(f.memory.organize.mock.calls[0]).toEqual(f.memory.organize.mock.calls[1]);
  });
  it('lossless automation copies complete originals and source times instead of writing a model paraphrase', async () => {
    const f = await ready(); await f.core.applyCandidate(apply(f.plan, 'lossless'));
    const payload = f.memory.organize.mock.calls[0]![1]; expect(payload.content).toContain(f.notes[0]!.content); expect(payload.content).toContain(f.notes[1]!.content); expect(payload.content).toContain(f.notes[0]!.createdAt);
    expect(payload.content).not.toBe(f.plan.candidates[0]!.content);
  });
  it.each(['update', 'insight', 'archive'] as const)('requires individual user approval for %s', async type => {
    const f = await ready(type); await expect(f.core.applyCandidate(apply(f.plan, 'lossless'))).rejects.toMatchObject({ code: 'MEMORY_MAINTENANCE_REVIEW_REQUIRED' });
    expect(f.memory.update).not.toHaveBeenCalled(); expect(f.memory.maintenanceInsight).not.toHaveBeenCalled(); expect(f.memory.maintenanceArchive).not.toHaveBeenCalled();
  });
  it('archives a redundant note without calling source forgetting and accepts only retained/archived confirmation', async () => {
    const f = await ready('archive'); expect((await f.core.applyCandidate(apply(f.plan))).status).toBe('archived');
    expect(f.memory.maintenanceArchive).toHaveBeenCalledWith(scope, expect.objectContaining({ id: ids[0], expectedChecksum: '1'.repeat(32), expectedSourceRevision: '0' }), undefined);
  });
  it('writes insight only through the dedicated lineage-aware host path after review', async () => {
    const f = await ready('insight'); expect((await f.core.applyCandidate(apply(f.plan))).status).toBe('indexed'); expect(f.memory.maintenanceInsight).toHaveBeenCalledOnce(); expect(f.memory.organize).not.toHaveBeenCalled();
  });
  it('retains unknown outcomes without blind retry or false success', async () => {
    const f = await ready(); f.memory.organize.mockRejectedValueOnce(Object.assign(new Error('Resident process closed after dispatch'), { code: 'SESSION_CLOSED' }));
    expect((await f.core.applyCandidate(apply(f.plan))).status).toBe('unknown'); expect(f.memory.organize).toHaveBeenCalledOnce();
  });
  it('rejects changed scope, epoch, content or a withdrawn revision before any mutation', async () => {
    const f = await ready();
    await expect(f.core.applyCandidate({ ...apply(f.plan), scope: { ...scope, securityDomainId: 'group' } })).rejects.toMatchObject({ code: 'MEMORY_MAINTENANCE_INVALID_PLAN' });
    await expect(f.core.applyCandidate({ ...apply(f.plan), contextEpoch: 2 })).rejects.toMatchObject({ code: 'MEMORY_MAINTENANCE_INVALID_PLAN' });
    await expect(f.core.applyCandidate(apply({ ...f.plan, narrative: 'tampered' }))).rejects.toMatchObject({ code: 'MEMORY_MAINTENANCE_INVALID_PLAN' });
    f.revision('1'); await expect(f.core.applyCandidate(apply(f.plan))).rejects.toMatchObject({ code: 'MEMORY_SOURCE_WITHDRAWN' }); expect(f.memory.organize).not.toHaveBeenCalled();
  });
});
