import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionLearningGoal } from '../../src/shared/companion-learning-goals';
import { nextCompanionLearningGoalAt } from '../../src/shared/companion-learning-goal-schedule';
import { createCompanionLearningGoalService, type CompanionLearningGoalIntegrationOptions } from '../../src/main/companions/learning-goal-integration';
import type { CompanionLearningGoalService } from '../../src/main/companions/learning-goal-service';
import type { CompanionLearningAssets } from '../../src/main/companions/learning-service';
import type { AssetSummary } from '../../src/shared/asset-types';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

const model = vi.hoisted(() => ({ structured: vi.fn() }));
const roots: string[] = [], stores = new Set<CompanionsStore>(), services = new Set<CompanionLearningGoalService>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-22T10:00:00Z'); model.structured.mockReset(); });
afterEach(async () => { for (const service of services) await service.close(); services.clear(); for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-learning-goals-')); roots.push(root);
  const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '核对来源后再学习。', model: '', avatar: 'sister', proactive: false, active: true }));
  const file = path.join(root, 'state.sqlite'); const store = new CompanionsStore(file, seeds); stores.add(store);
  const grant = store.request({ type: 'learning.grant', companionId: 'alice', libraryId: 'library', libraryName: '获准教材', libraryPath: root, autonomous: false, intervalMinutes: 30 }).learning!.grants[0]!;
  const create = (text = '持续研究核实资料的方法，逐轮练习并复盘，不要自动结束。', companionId = 'alice', windows: CompanionLearningGoal['schedule']['windows'] = []) => store.request({ type: 'learning.goals.create', companionId, text,
    materials: companionId === 'alice' ? [{ kind: 'library', grantId: grant.id }] : [], allowWeb: false, schedule: { intervalMinutes: 5, windows, timeZone: 'UTC' } }).learningGoal!;
  const rounds = (id: string, cursor = 0, limit = 20) => store.request({ type: 'learning.goals.rounds', companionId: 'alice', id, cursor, limit }).learningRounds!;
  const claim = () => store.request({ type: 'learning.goals.claim' }).learningGoalJob;
  return { root, file, seeds, store, grant, create, rounds, claim };
}
function build(f: ReturnType<typeof fixture>, overrides: Pick<CompanionLearningGoalIntegrationOptions, 'validateWrite'> = {}) {
  const material = { text: '先核对资料出处，再记录结论。', claim: '先核对资料出处。', badEvidence: false, unknownAnswer: false };
  const asset = { assetId: 'asset-one', displayName: '教材.md', currentRevisionId: 'revision', relativeFilePath: '教材.md', mediaType: 'text' } as AssetSummary;
  const assets: CompanionLearningAssets = { catalog: async () => [], grant: async () => ({ libraryName: '获准教材', libraryPath: f.root }),
    page: vi.fn(async () => ({ assets: [asset], hasMore: false })), read: vi.fn(async () => ({ content: material.text, revisionId: sha(material.text), truncated: false })) };
  const request = vi.fn(async (command: CompanionStorageCommand) => f.store.request(command));
  // This is a deterministic adapter unit test. The opt-in real-model fixture uses actual VCP.
  const memory = { schedule: vi.fn(() => { let outbox; while ((outbox = f.store.request({ type: 'memory.outbox.claim' }).memoryOutbox)) f.store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true }); }),
    search: vi.fn(async (query: { companionId: string; conversationId: string }) => {
    const page = f.store.request({ type: 'memory.browse', companionId: query.companionId, conversationId: query.conversationId }).memoryPage!;
    return { ok: true, memoryPage: page, memoryContext: { text: page.items.map(hit => hit.memory.content).join('\n'), revision: 'fixture', profileKey: 'fixture' } };
  }) };
  model.structured.mockImplementation(async (input: { system: string; user: string }) => {
    const data = JSON.parse(input.user).data;
    const stage = /阶段=(\w+)/u.exec(input.system)?.[1];
    if (stage === 'plan') return { focus: '核实资料', questions: ['该怎样核对？'], searchQueries: [] };
    if (stage === 'learn') return { summary: material.claim, claims: [{ text: material.claim, evidence: [{ sourceId: data.reads[0].id, quote: material.text }] }] };
    if (stage === 'consolidate') return { action: 'revise', noteId: data.existing[0].id, content: data.existing[0].content + '\n\n新材料补充：' + material.claim, reason: '同一学习目标的新资料补充，保留旧知识与来源。' };
    if (stage === 'questions') return { questions: ['本轮材料建议怎么做？'] };
    if (stage === 'answer') return { answers: [!material.unknownAnswer && data.recalled.includes(material.claim) ? material.claim : '不知道'] };
    if (stage === 'assess') return { evaluations: [{ evaluation: 'supported', rationale: '模型自评；引文存在不证明客观正确。', evidence: [{ sourceId: data.reads[0].id, quote: material.badEvidence ? 'THIS_WAS_NOT_READ' : material.text }] }], gaps: ['还没有核实外部交叉来源。'], nextPlan: ['下一轮核对另一份材料，并检验矛盾。'] };
    throw new Error('Unexpected stage ' + stage);
  });
  const report = vi.fn();
  const service = createCompanionLearningGoalService({ request, assets, files: { readFile: vi.fn() }, attachmentPath: vi.fn(), memory,
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'unit-only', apiKey: 'unit-only' }),
    fetchFn: async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      const value = await model.structured({ system: wire.messages[0].content, user: wire.messages[1].content });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
    }, changed: vi.fn(), report, ...overrides }); services.add(service);
  return { service, material, assets, request, memory, report };
}
async function completed(f: ReturnType<typeof fixture>, service: CompanionLearningGoalService, goal: CompanionLearningGoal, ordinal: number) {
  await service.tick(); await vi.waitFor(() => expect(f.rounds(goal.id).items[0]).toMatchObject({ ordinal, status: 'completed' }));
}

it('runs persistently, reuses unchanged knowledge, revises changed same-goal knowledge with preserved source history, and self-tests through VCP recall', async () => {
  const f = fixture(), goal = f.create(), b = build(f); await completed(f, b.service, goal, 1);
  const first = f.rounds(goal.id).items[0]!;
  expect(first.reads[0]).toMatchObject({ excerpt: b.material.text, contentHash: sha(b.material.text), grantId: f.grant.id });
  expect(first.integration).toMatchObject({ action: 'recorded', version: 1 }); expect(first.selfTest?.questions[0]?.evaluation).toBe('supported');
  expect(first.memoryIds).toHaveLength(1); const noteId = first.memoryIds[0]!;
  expect(f.store.request({ type: 'memory.library.read', companionId: 'alice', id: noteId }).memoryRead?.memory.sources[0]?.messageId).toBe(first.reads[0]!.sourceMessageId);
  vi.setSystemTime(Date.now() + 5 * 60000); await completed(f, b.service, goal, 2);
  expect(f.rounds(goal.id).items[0]!.integration).toMatchObject({ action: 'reused', noteId, version: 1 });
  b.material.text = '雨天出门前要携带雨伞，并核对天气来源。'; b.material.claim = '雨天出门前要带伞。';
  vi.setSystemTime(Date.now() + 5 * 60000); await completed(f, b.service, goal, 3);
  expect(f.rounds(goal.id).items[0]!.integration).toMatchObject({ action: 'revised', noteId, version: 2 });
  const note = f.store.request({ type: 'memory.library.read', companionId: 'alice', id: noteId }).memoryRead!.memory;
  expect(note.sources).toHaveLength(2); expect(note.sources.some(source => source.messageId === first.reads[0]!.sourceMessageId)).toBe(true);
  const current = f.store.request({ type: 'learning.goals.list', companionId: 'alice' }).learningGoals!.items[0]!;
  expect(current).toMatchObject({ state: 'active', totalRounds: 3, phase: 'idle' }); expect(Date.parse(current.nextAt)).toBeGreaterThan(Date.now());
  expect(current.lastRound?.reads).toEqual([]); expect(current.lastRound?.selfTest).toBeUndefined();
  const answerInputs = model.structured.mock.calls.filter(([input]) => input.system.includes('阶段=answer')).map(([input]) => JSON.parse(input.user));
  expect(answerInputs).toHaveLength(3); for (const input of answerInputs) { expect(input.context).toBeUndefined(); expect(Object.keys(input.data).sort()).toEqual(['questions', 'recalled']); }
  const plans = model.structured.mock.calls.filter(([input]) => input.system.includes('阶段=plan')).map(([input]) => JSON.parse(input.user));
  expect(plans[1].data.previousRound).toMatchObject({ gaps: ['还没有核实外部交叉来源。'], nextPlan: ['下一轮核对另一份材料，并检验矛盾。'] }); expect(plans[1].data.previousRound.reads).toBeUndefined();
  expect(b.report).not.toHaveBeenCalled();
});

it('downgrades invented exam citations to unassessed instead of fabricating a correct rate', async () => {
  const f = fixture(), goal = f.create(), b = build(f); b.material.badEvidence = true; await completed(f, b.service, goal, 1);
  const test = f.rounds(goal.id).items[0]!.selfTest!; expect(test).toMatchObject({ supportedAnswers: 0, assessedQuestions: 0 });
  expect(test.questions[0]).toMatchObject({ evaluation: 'unassessed', evidence: [] }); expect(test.disclaimer).toContain('不代表客观考试正确率');
});

it('links optional learning reflection to the exact formal VCP version and real reads without rewarding self-test scores', async () => {
  const f = fixture(), goal = f.create(), b = build(f), original = model.structured.getMockImplementation()!;
  model.structured.mockImplementation(async (input: { system: string; user: string }) => {
    const output = await original(input);
    if (!input.system.includes('阶段=assess')) return output;
    const data = JSON.parse(input.user).data;
    return { ...output, stateReflection: { focus: '下一轮核对第二份资料是否支持同一结论。', reason: '当前资料只有一个出处，先保持待核实。', evidence: [{ sourceId: data.reads[0].id, quote: b.material.text }] } };
  });
  const scope = { companionId: 'alice', conversationId: 'world_alice' }, before = f.store.request({ type: 'state.get', ...scope }).runtimeState!;
  await completed(f, b.service, goal, 1);
  const round = f.rounds(goal.id).items[0]!, after = f.store.request({ type: 'state.get', ...scope }).runtimeState!;
  expect(round.stateReflection).toMatchObject({ outcome: 'applied', expectedRevision: before.revision });
  expect(after.focus).toBe('下一轮核对第二份资料是否支持同一结论。'); expect(after.affect).toEqual(before.affect); expect(after.relationship).toEqual(before.relationship);
  expect(after.recentChanges?.[0]).toMatchObject({ kind: 'memory', energyDelta: 0, memoryVersions: [{ id: round.integration!.noteId, version: round.integration!.version }], sourceMessageIds: [round.reads[0]!.sourceMessageId] });
  const authoredRevision = after.revision;
  vi.setSystemTime(Date.now() + 5 * 60000); await completed(f, b.service, goal, 2);
  expect(f.rounds(goal.id).items[0]!.stateReflection).toMatchObject({ outcome: 'not_needed' });
  expect(f.store.request({ type: 'state.get', ...scope }).runtimeState!.revision).toBe(authoredRevision);
  f.store.request({ type: 'learning.revoke', companionId: 'alice', id: f.grant.id, expectedRevision: f.grant.revision });
  const withdrawn = f.store.request({ type: 'state.get', ...scope }).runtimeState!;
  expect(withdrawn.focus).toBeUndefined(); expect(withdrawn.recentChanges?.some(change => change.kind === 'memory')).toBe(false);
  expect(f.rounds(goal.id).items[0]!.stateReflection).toBeUndefined();
});

it('keeps newly changed conversational focus while committing a concurrent learning round and records the skipped reflection', async () => {
  const f = fixture(), goal = f.create(), b = build(f), original = model.structured.getMockImplementation()!;
  model.structured.mockImplementation(async (input: { system: string; user: string }) => {
    const output = await original(input);
    if (!input.system.includes('阶段=assess')) return output;
    const s = { companionId: 'alice', conversationId: f.store.openPrivate('alice').id }, source = f.store.appendMessage({ conversationId: s.conversationId, authorId: 'user', content: '先聊聊我们刚才约好的安排。' });
    f.store.request({ type: 'state.update', ...s, proposal: { focus: '正在回应新的聊天安排', reason: '用户刚提出新的实际聊天话题。', sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], appraisals: [] } });
    const data = JSON.parse(input.user).data;
    return { ...output, stateReflection: { focus: '继续学习旧资料', reason: '学习阶段较早提出的关注。', evidence: [{ sourceId: data.reads[0].id, quote: b.material.text }] } };
  });
  await completed(f, b.service, goal, 1); const round = f.rounds(goal.id).items[0]!;
  expect(round.stateReflection).toMatchObject({ outcome: 'skipped' }); expect(round.stateReflection!.detail).toContain('更新');
  expect(f.store.request({ type: 'state.get', companionId: 'alice', conversationId: f.store.openPrivate('alice').id }).runtimeState?.focus).toBe('正在回应新的聊天安排');
  expect(f.store.request({ type: 'memory.library.read', companionId: 'alice', id: round.memoryIds[0]! }).memoryRead?.memory.status).toBe('indexed');
  expect(b.report).not.toHaveBeenCalled();
});

it('does not apply a reflection that invents a quote absent from the real read', async () => {
  const f = fixture(), goal = f.create(), b = build(f), original = model.structured.getMockImplementation()!;
  model.structured.mockImplementation(async (input: { system: string; user: string }) => {
    const output = await original(input); if (!input.system.includes('阶段=assess')) return output;
    return { ...output, stateReflection: { focus: '没有证据的关注', reason: '模型给出的无来源推断。', evidence: [{ sourceId: JSON.parse(input.user).data.reads[0].id, quote: 'NOT_IN_REAL_READ' }] } };
  });
  await completed(f, b.service, goal, 1); expect(f.rounds(goal.id).items[0]!.stateReflection).toBeUndefined();
  expect(f.store.request({ type: 'state.get', companionId: 'alice', conversationId: 'world_alice' }).runtimeState?.focus).toBeUndefined();
});

it('never counts a non-answer as supported even when the model grades the existing material instead of the actual answer', async () => {
  const f = fixture(), goal = f.create(), b = build(f); b.material.unknownAnswer = true; await completed(f, b.service, goal, 1);
  const test = f.rounds(goal.id).items[0]!.selfTest!;
  expect(test).toMatchObject({ supportedAnswers: 0, assessedQuestions: 0, questions: [{ answer: '不知道', evaluation: 'unassessed' }] });
  expect(test.questions[0]!.rationale).toContain('不能把材料中存在答案当作已经答对'); expect(test.recall!.contextCharacters).toBeGreaterThan(0);
});

it('uses the common write policy gate and rejects a newly changed prohibition fence inside the atomic goal commit', async () => {
  const f = fixture(), goal = f.create();
  const validateWrite = vi.fn<NonNullable<CompanionLearningGoalIntegrationOptions['validateWrite']>>(async command => {
    command.expectedProhibitionRevision = f.store.request({ type: 'memory.prohibitions', companionId: command.companionId, conversationId: command.conversationId,
      sourceMessageIds: command.candidate.sourceMessageIds }).memoryProhibitionRevision;
    f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: 'world_alice', tag: '校验后新增的主题限制', persistent: true });
  });
  const b = build(f, { validateWrite }); await b.service.tick();
  await vi.waitFor(() => expect(f.rounds(goal.id).items[0]).toMatchObject({ status: 'failed' }));
  expect(validateWrite).toHaveBeenCalledOnce(); expect(f.rounds(goal.id).items[0]!.error).toContain('禁记规则已变化'); expect(f.store.listMemory('alice')).toEqual([]);
});

it('never writes a goal note when the unified semantic policy validator refuses its content', async () => {
  const f = fixture(), goal = f.create(); const validateWrite = vi.fn(async () => { throw new Error('已禁止记录这个主题。'); });
  const b = build(f, { validateWrite }); await b.service.tick();
  await vi.waitFor(() => expect(f.rounds(goal.id).items[0]).toMatchObject({ status: 'failed', error: '已禁止记录这个主题。' }));
  expect(f.store.listMemory('alice')).toEqual([]); expect(b.memory.schedule).not.toHaveBeenCalled();
});

it('rejects paused stale leases atomically before source or memory writes and refuses foreign goal revisions', () => {
  const f = fixture(), goal = f.create(), job = f.claim()!;
  f.store.request({ type: 'learning.goals.update', companionId: 'alice', id: goal.id, expectedRevision: 1, state: 'paused' });
  expect(() => f.store.request({ type: 'learning.goals.checkpoint', id: goal.id, leaseToken: job.leaseToken, round: job.round })).toThrow('取消');
  expect(() => f.store.request({ type: 'learning.goals.integrate', id: goal.id, leaseToken: job.leaseToken, content: '不能写入', claimHash: sha('不能写入'), reason: '不能写入', expectedProhibitionRevision: sha(''), evidence: [{ sourceMessageId: 'nonexistent', quote: '不能写入' }] })).toThrow('取消');
  expect(f.claim()).toBeUndefined(); expect(() => f.store.request({ type: 'learning.goals.update', companionId: 'bob', id: goal.id, expectedRevision: 2, state: 'active' })).toThrow('已变化');
});

it('keeps revoked readings and their derived old test/knowledge unavailable in history and withdrawals reach the same memory ledger', async () => {
  const f = fixture(), goal = f.create(), b = build(f); await completed(f, b.service, goal, 1);
  f.store.request({ type: 'learning.revoke', companionId: 'alice', id: f.grant.id, expectedRevision: f.grant.revision });
  const history = f.rounds(goal.id).items[0]!;
  expect(history.reads[0]!.excerpt).toBe(''); expect(history.claims).toEqual([]); expect(history.selfTest).toBeUndefined(); expect(history.memoryIds).toEqual([]);
  expect(f.store.request({ type: 'memory.browse', companionId: 'alice', conversationId: 'world_alice' }).memoryPage!.items).toEqual([]);
});

it('honors formal forgotten-source barriers in old round history and the next planning context', async () => {
  const f = fixture(), goal = f.create(), b = build(f); await completed(f, b.service, goal, 1);
  const source = f.rounds(goal.id).items[0]!.reads[0]!.sourceMessageId!;
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: 'world_alice', sourceMessageIds: [source] });
  const round = f.rounds(goal.id).items[0]!; expect(round.reads[0]!.excerpt).toBe(''); expect(round.summary).toBeUndefined(); expect(round.selfTest).toBeUndefined(); expect(round.claims).toEqual([]);
  vi.setSystemTime(Date.now() + 5 * 60000); await completed(f, b.service, goal, 2);
  const latestPlan = model.structured.mock.calls.filter(([input]) => input.system.includes('阶段=plan')).at(-1)!;
  expect(JSON.parse(latestPlan[0].user).data.previousRound.summary).toBeUndefined();
});

it('resumes the same checkpoint after restart, keeps all old rounds paginated, and leases at most two goals including two for one owner', () => {
  const f = fixture(), goal = f.create(); f.create('另一个并行目标'); f.create('第三个等待资源');
  const first = f.claim()!, second = f.claim()!; expect(first.goal.companionId).toBe(second.goal.companionId); expect(f.claim()).toBeUndefined();
  first.round.plan = { focus: '已完成的计划', questions: [], searchQueries: [] };
  f.store.request({ type: 'learning.goals.checkpoint', id: first.goal.id, leaseToken: first.leaseToken, round: first.round });
  f.store.close(); stores.delete(f.store); const reopened = new CompanionsStore(f.file, f.seeds); stores.add(reopened);
  const resumed = reopened.request({ type: 'learning.goals.claim' }).learningGoalJob!;
  expect(resumed.round).toMatchObject({ id: first.round.id, ordinal: first.round.ordinal, plan: { focus: '已完成的计划' } });
  expect(resumed.leaseToken).not.toBe(first.leaseToken);
  reopened.request({ type: 'learning.goals.finish', id: resumed.goal.id, leaseToken: resumed.leaseToken, round: { ...resumed.round, status: 'completed' } });
  expect(reopened.request({ type: 'learning.goals.rounds', companionId: 'alice', id: goal.id, limit: 1 }).learningRounds!.items).toHaveLength(1);
});

it('honors overnight windows by the starting weekday and never claims a dormant companion', () => {
  const f = fixture();
  const schedule = { intervalMinutes: 5, timeZone: 'Asia/Shanghai', windows: [{ startMinute: 23 * 60, endMinute: 2 * 60, days: [4] }] };
  expect(nextCompanionLearningGoalAt(schedule, Date.parse('2026-10-22T16:30:00Z'))).toBe(Date.parse('2026-10-22T16:30:00Z'));
  expect(nextCompanionLearningGoalAt(schedule, Date.parse('2026-10-22T19:00:00Z'))).toBe(Date.parse('2026-10-29T15:00:00Z'));
  f.create(); f.store.setCompanionActive('alice', false); expect(f.claim()).toBeUndefined();
});

it('retains old rounds beyond one hundred and pages the stored history without loading it into model context', () => {
  const f = fixture(), goal = f.create();
  for (let index = 0; index < 103; index++) {
    if (index) f.store.request({ type: 'learning.goals.run', companionId: 'alice', id: goal.id, expectedRevision: 1 });
    const job = f.claim()!;
    f.store.request({ type: 'learning.goals.finish', id: goal.id, leaseToken: job.leaseToken,
      round: { ...job.round, status: 'failed', error: 'Synthetic pagination receipt, no learning claimed.' }, retryAfterMs: 1000 });
  }
  expect(f.rounds(goal.id, 0, 50)).toMatchObject({ hasMore: true, nextCursor: 50 });
  const oldest = f.rounds(goal.id, 100, 50); expect(oldest.items.map(round => round.ordinal)).toEqual([3, 2, 1]); expect(oldest.hasMore).toBe(false);
  expect(f.store.request({ type: 'learning.goals.list', companionId: 'alice' }).learningGoals!.items[0]!.state).toBe('active');
});

it('cancels an in-flight read after pause and never lets the late file result become a memory source', async () => {
  const f = fixture(), goal = f.create(), b = build(f); let release!: (value: Awaited<ReturnType<CompanionLearningAssets['read']>>) => void;
  b.assets.read = vi.fn(() => new Promise<Awaited<ReturnType<CompanionLearningAssets['read']>>>(resolve => { release = resolve; }));
  await b.service.tick(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await b.service.handle({ type: 'memory.learning.goals.update', companionId: 'alice', id: goal.id, expectedRevision: 1, state: 'paused' });
  release({ content: '迟到的文件资料。', revisionId: 'late', truncated: false }); await b.service.drain('alice');
  expect(f.rounds(goal.id).items[0]).toMatchObject({ status: 'cancelled', reads: [] }); expect(f.store.listMemory('alice')).toEqual([]);
  expect(f.store.state(true).conversations.flatMap(room => f.store.messages({ conversationId: room.id }).messages).some(message => message.content.includes('迟到的文件资料'))).toBe(false);
});

it('waits for materials before planning and never calls a model when there is no authorized learning entrance', async () => {
  const f = fixture(), goal = f.create(), b = build(f);
  f.store.request({ type: 'learning.goals.update', companionId: 'alice', id: goal.id, expectedRevision: 1, materials: [], allowWeb: false });
  await b.service.tick(); await vi.waitFor(() => expect(f.rounds(goal.id).items[0]).toMatchObject({ status: 'deferred', phase: 'waiting' }));
  expect(model.structured).not.toHaveBeenCalled(); expect(b.assets.read).not.toHaveBeenCalled();
  expect(f.store.request({ type: 'learning.goals.list', companionId: 'alice' }).learningGoals!.items[0]!.waitReason).toContain('本轮尚未调用模型');
  expect(b.report).not.toHaveBeenCalled();
});
