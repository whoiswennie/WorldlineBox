import { COMPANION_SUBMIT_RESULT_TOOL } from '../../src/shared/companion-final-proposal';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed, type CompanionConnection } from '../../src/companions/store';
import BetterSqlite3 from 'better-sqlite3';
import { naturalGameTerminalReady, type NaturalGameTerminalReceipt } from '../helpers/natural-game-content-audit';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import { CompanionActivityTaskService, companionActivitySocialObservationFingerprint } from '../../src/main/companions/activity-task-service';
import { companionStorageCommandSchema, type CompanionStorageCommand } from '../../src/shared/companion-storage';
import { companionsRequestSchema } from '../../src/shared/companions';
import { companionWorkspaceRequestSchema } from '../../src/shared/companion-workspace';
import { companionRecallCapabilities, companionTaskInvocation, runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import { activityArgumentsSchema, activityDecisionSchema, type CompanionActivityTask } from '../../src/shared/companion-activity-task';
const seeds: CompanionSeed[] = [{ id: 'alice', name: 'Alice', persona: '尊重实际结果', description: '', model: '', avatar: 'sister', active: true, proactive: true }];
let worldService: CompanionWorldService | undefined;
let root: string, store: CompanionsStore, service: CompanionActivityTaskService | undefined;
const feasibilityReviews: Array<Record<string, unknown>> = [];
beforeEach(() => { feasibilityReviews.length = 0; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-16T10:00:00Z'); root = mkdtempSync(path.join(tmpdir(), 'companion-agent-service-')); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds.map(seed => ({ ...seed, active: true }))); });
afterEach(async () => { await service?.close(); service = undefined; await worldService?.close(); worldService = undefined; store.close(); if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-agent-service-')) throw new Error('Invalid cleanup'); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function setup(fetchFn: typeof fetch, goal = '去自己的沙发坐一会儿，完成后告诉我。', forwardProgressReview = false, forwardFeasibilityReview = false) {
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const world = store.request({ type: 'world.snapshot' }).world!; store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  const routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: goal, replyDirective: 'none' });
  const task = store.request({ type: 'activity.start', ...scope, sourceMessageId: source.id, clientId: 'independent_goal', title: '坐到沙发', goal: source.content }).activityTask!;
  service = new CompanionActivityTaskService({ request: async input => input.type === 'memory.search'
    ? { ok: true, memoryPage: { items: [], hasMore: false } } : store.request(input),
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fake-local-key', baseUrl: 'https://fixture.invalid' }),
    profiles: async () => ({ publicProfiles: [], visualInputs: [] }), fetchFn: forwardProgressReview ? fetchFn : withProgressReview(fetchFn, forwardFeasibilityReview), excludedIds: () => [], changed: vi.fn(), report: error => { throw error; } });
  return { ...scope, task };
}
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
/** Domain fixtures provide controlled review results, separately from actor
 * calls. Dedicated review cases forward their real positive/negative controls. */
function withProgressReview(fetchFn: typeof fetch, forwardFeasibilityReview = false): typeof fetch {
  return async (input, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (data.purpose === 'activity_resource_feasibility' && !forwardFeasibilityReview) {
      feasibilityReviews.push(data);
      return response({ allowed: true, confidence: .99, reason: '受控领域夹具允许本步；实际可行性拒绝与修复由专用正反控制覆盖。' });
    }
    return data.purpose === 'companion_social_progress_review' ? response({ supported: true, correction: '' }) : fetchFn(input, init);
  };
}
function replyToBoundGroupInvitation(task: CompanionActivityTask, topicId: string) {
  const conversationId = task.peerConversationId!, authorId = task.wait!.kind === 'reply' ? task.wait!.targetCompanionId : undefined;
  expect(authorId).toBeDefined();
  for (let attempt = 0; attempt < 8; attempt++) {
    const job = store.request({ type: 'social.job.claim' }).socialJob;
    if (!job) {
      vi.setSystemTime(Date.now() + 60000);
      for (let tick = 0; tick < 1000; tick++) if (!store.request({ type: 'world.tick' }).world?.backlog) break;
      continue;
    }
    vi.setSystemTime(Math.max(Date.now(), Date.parse(job.typingNotBefore)) + 1);
    if (job.conversationId !== conversationId || job.companionId !== authorId) {
      store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: null });
      continue;
    }
    const invitation = store.messages({ conversationId, topicId }).messages.find(message => message.id === job.sourceMessageId);
    expect(invitation).toMatchObject({ authorId: task.companionId, topicId });
    store.request({ type: 'topic.join', conversationId, topicId, readerId: authorId! });
    const reply = store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!,
      text: '已收到这条邀请，我愿意继续讨论；具体方案仍需另行确认。' }).socialMessage!.message;
    expect(reply.replyToId).toBe(job.sourceMessageId);
    return reply;
  }
  throw new Error('本目标的真实群邀请未产生指定伙伴的实际回复机会。');
}
it('keeps report and passive preparation lease commands internal to storage, outside renderer, workspace and actor argument schemas', () => {
  const readset = { schema: 'worldlinebox.companion-execution-readset-v1', companionId: 'alice', conversationId: 'private_alice', complete: true,
    sources: [], memories: [], contexts: [], topics: [], knowledgeReads: [] };
  for (const command of [{ type: 'activity.report.claim' }, { type: 'activity.report.complete', id: 'actual_task', leaseToken: 'lease', executionReadset: readset },
    { type: 'activity.passive.prepare', id: 'actual_task', leaseToken: 'lease', expectedStep: 0, snapshot: { prepared: true } },
    { type: 'activity.report.fail', id: 'actual_task', leaseToken: 'lease', error: 'actual current validation rejected', terminal: true }]) {
    expect(companionStorageCommandSchema.safeParse(command).success).toBe(true);
    expect(companionsRequestSchema.safeParse(command).success).toBe(false);
    expect(companionWorkspaceRequestSchema.safeParse(command).success).toBe(false);
    expect(activityArgumentsSchema.safeParse({ action: command.type })).toEqual(expect.objectContaining({ success: false }));
  }
});
it('reviews a zero-history terminal social claim in-slot before any final report and lets the author report the actual absence of effects', async () => {
  let actors = 0, reviews = 0;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (data.purpose === 'companion_social_progress_review') {
      reviews++; expect(data.verifiedOutbound).toEqual([]); expect(data.facts).toEqual([]);
      return response({ supported: !data.proposedText.includes('已经告诉Bob'), correction: data.proposedText.includes('已经告诉Bob') ? '没有任何真实出站正文，不能称已经告诉Bob规则。' : '' });
    }
    expect(data.purpose).toBe('activity_task_step'); actors++;
    if (actors === 2) expect(data.outputCorrection.error).toContain('没有任何真实出站正文');
    return response({ status: actors === 1 ? 'complete' : 'blocked', action: null, wait: null,
      summary: actors === 1 ? '我已经告诉Bob所有规则。' : '我还没有发出邀请或告知规则，本次没有完成联系。' });
  });
  const scope = setup(fetchFn, '去邀Bob玩一局，结束后汇报。', true);
  await service!.tick();
  const get = () => store.request({ type: 'activity.get', companionId: scope.companionId, conversationId: scope.conversationId, id: scope.task.id }).activityTask!;
  await vi.waitFor(() => expect(get().status, JSON.stringify(get())).toBe('failed'));
  expect({ actors, reviews }).toEqual({ actors: 2, reviews: 3 });
  const report = store.messages({ conversationId: scope.conversationId }).messages.find(message => message.authorId === scope.companionId)!;
  expect(report.content).toContain('还没有发出邀请'); expect(report.content).not.toContain('已经告诉Bob');
  const proof = store.request({ type: 'execution.sources', sourceMessageIds: [report.id], memoryIds: [] }).executionSources?.find(source => source.id === report.id);
  expect(proof?.executionReadset?.sources.map(source => source.id)).toContain(scope.task.sourceMessageId);
  expect(store.request({ type: 'social.conversations', companionId: scope.companionId }).socialConversationPage!.items).toEqual([]);
});
it('waits for the exact actual formal report after terminal commit while its publication review is held', async () => {
  let reviews = 0, publicationHeld = false, release: (() => void) | undefined;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (data.purpose === 'companion_social_progress_review') {
      if (++reviews === 2) { publicationHeld = true; await new Promise<void>(resolve => { release = resolve; }); }
      return response({ supported: true, correction: '' });
    }
    return response({ status: 'complete', action: null, wait: null, summary: '本次检查已经结束，这是实际检查结果。' });
  });
  const scope = setup(fetchFn, '完成本次检查并将结果告诉我。', true);
  const Database = BetterSqlite3 as { new (filename: string, options: { readonly: true }): CompanionConnection };
  const messages = new Database(path.join(root, 'state.sqlite'), { readonly: true });
  const actualReport = (): NaturalGameTerminalReceipt | undefined => {
    const row = messages.prepare('SELECT id,client_id FROM messages WHERE client_id=?').get('activity_result_' + scope.task.id) as { id: string; client_id: string } | undefined;
    if (!row) return undefined;
    const message = store.request({ type: 'memory.sources.filter', companionId: scope.companionId, conversationId: scope.conversationId, ids: [row.id] }).memorySources?.find(message => message.id === row.id);
    return message ? { clientId: row.client_id, message } : undefined;
  };
  try {
    await service!.tick();
    const current = () => store.request({ type: 'activity.get', companionId: scope.companionId, conversationId: scope.conversationId, id: scope.task.id }).activityTask!;
    await vi.waitFor(() => { expect(current().status).toBe('succeeded'); expect(publicationHeld).toBe(true); });
    expect(store.messages({ conversationId: scope.conversationId }).messages.some(message => message.authorId === scope.companionId && message.replyToId === scope.task.sourceMessageId)).toBe(false);
    const oldNaturalLoopWouldStop = ['succeeded', 'failed', 'cancelled'].includes(current().status);
    expect(oldNaturalLoopWouldStop).toBe(true);
    expect(naturalGameTerminalReady(current(), actualReport())).toBe(false);
    release!(); release = undefined;
    await vi.waitFor(() => expect(actualReport()).toBeDefined());
    const receipt = actualReport()!;
    expect(naturalGameTerminalReady(current(), receipt)).toBe(true);
    expect(receipt.message.content).toContain('本次检查已经结束，这是实际检查结果。');
    expect(reviews).toBe(2); expect(fetchFn).toHaveBeenCalledTimes(3);
    for (const changed of [
      { ...receipt, clientId: 'activity_result_wrong_task' },
      { ...receipt, message: { ...receipt.message, authorId: 'foreign_owner' } },
      { ...receipt, message: { ...receipt.message, conversationId: 'foreign_room' } },
      { ...receipt, message: { ...receipt.message, replyToId: 'foreign_source' } },
      { ...receipt, message: { ...receipt.message, status: 'failed' as const } },
      { ...receipt, message: { ...receipt.message, isReplyDraft: true } },
      { ...receipt, message: { ...receipt.message, content: '' } },
    ]) expect(naturalGameTerminalReady(current(), changed)).toBe(false);
    expect(naturalGameTerminalReady({ ...current(), status: 'failed' })).toBe(true);
    expect(naturalGameTerminalReady({ ...current(), status: 'cancelled' })).toBe(true);
    expect(naturalGameTerminalReady({ ...current(), status: 'waiting' }, receipt)).toBe(false);
    // Presence is a delivery condition only. Neutral host fallback content is
    // still judged by the unchanged independent seven semantic acceptance gates.
    expect(naturalGameTerminalReady(current(), { ...receipt, message: { ...receipt.message, content: '这条任务记录已结束，实际结果尚未核验。' } })).toBe(true);
  } finally { release?.(); messages.close(); }
});
it.each([true, false])('verifies an actual current partial recall using its exact context proof instead of the old human sequence valid=%s', async valid => {
  const fetchFn = vi.fn<typeof fetch>(async () => response({ status: 'continue', action: { action: 'query', category: 'scenes', limit: 1 }, wait: null,
    summary: '只按当前已获权资料继续查询。' }));
  const base = setup(fetchFn); await service!.close();
  const calls: CompanionStorageCommand[] = [];
  const contextValid = vi.fn(async (scope: { companionId: string; conversationId: string; beforeSequence?: number }, context: { revision: string; profileKey: string }) => {
    expect(scope).toMatchObject({ companionId: base.companionId, conversationId: base.conversationId });
    expect(scope.beforeSequence).toBeUndefined(); expect(context).toMatchObject({ revision: 'actual-current-revision', profileKey: 'actual-current-profile' }); return valid;
  });
  service = new CompanionActivityTaskService({ request: async command => { calls.push(command); return command.type === 'memory.search' ? { ok: true,
    memoryPage: { items: [], hasMore: false }, memoryContext: { text: '实际当前partial检索资料', revision: 'actual-current-revision', profileKey: 'actual-current-profile',
      evidence: { capturedAt: new Date().toISOString(), corpusHash: 'actual-current-fixture', references: [] } } } : store.request(command); },
    memoryContextValid: contextValid, fetchFn, configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' }),
    profiles: async () => ({ publicProfiles: [], visualInputs: [] }), excludedIds: () => [], changed: vi.fn(), report: error => { throw error; } });
  await service.tick();
  const get = () => store.request({ type: 'activity.get', companionId: base.companionId, conversationId: base.conversationId, id: base.task.id }).activityTask!;
  await vi.waitFor(() => expect(contextValid).toHaveBeenCalled());
  if (valid) { await vi.waitFor(() => expect(get().step, JSON.stringify(get())).toBe(1)); expect(calls.some(command => command.type === 'activity.commit')).toBe(true); }
  else { await vi.waitFor(() => expect(get().stage).toContain('真实资料已经变化')); expect(get().step).toBe(0); expect(calls.some(command => command.type === 'activity.commit')).toBe(false); }
});
it('revises only an uncommitted cached wait after an actual reply races with Main admission, preserving the original invitation and native receipt', async () => {
  let actorCalls = 0;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.purpose).toBe('activity_task_step'); actorCalls++;
    expect(data.outputCorrection.error).toContain('真实回信观察已变化');
    expect(data.recentPeerMessages).toContainEqual(expect.objectContaining({ content: '我收到邀请了，愿意一起玩。' }));
    return response({ status: 'continue', action: { action: 'query', category: 'contacts' }, wait: null, summary: '已读真实回信，先核实可继续联系的伙伴，不重发原邀请。' });
  });
  const base = setup(fetchFn, '联系另一位伙伴，按真实回信继续原目标。');
  store.request({ type: 'activity.cancel', companionId: 'alice', conversationId: base.conversationId, id: base.task.id });
  const bob = store.createCompanion({ name: 'bob', persona: '独立决定', description: '', model: '', avatar: 'sister', proactive: false });
  store.setCompanionActive(bob.id, true);
  const bobScope = { companionId: bob.id, conversationId: store.openPrivate(bob.id).id };
  const routine = store.request({ type: 'routine.get', ...bobScope }).routine!;
  store.request({ type: 'routine.configure', ...bobScope, expectedRevision: routine.revision,
    patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  const task = store.request({ type: 'activity.visit.ensure', companionId: 'alice', conversationId: base.conversationId,
    sourceMessageId: base.task.sourceMessageId!, targetId: bob.id, initialMessage: { text: '想找你一起玩，愿意吗？', clientId: 'actual_lost_wake_invite' } }).activityTask!;
  vi.setSystemTime(Date.now() + 1600); store.request({ type: 'world.tick' });
  const delivery = store.request({ type: 'social.job.claim' });
  expect(delivery.socialJob?.companionId).toBe(bob.id);
  const leased = store.request({ type: 'activity.claim' }).activityTask!;
  expect(leased.id).toBe(task.id);
  expect(store.request({ type: 'activity.observe', id: leased.id, leaseToken: leased.leaseToken! }).activityMessages).toEqual([]);
  const state = store.state(), companion = state.companions.find(role => role.id === 'alice')!, conversation = state.conversations.find(room => room.id === base.conversationId)!;
  const source = store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: base.conversationId, ids: [base.task.sourceMessageId!] }).memorySources![0]!;
  const frame: CompanionReplyInput = { companion, conversation, messages: [], sourceMessage: source, memories: [], proactive: true, audience: 'peers',
    invocation: companionTaskInvocation({ companion, conversationId: conversation.id, id: `${leased.id}_${leased.step}`, kind: 'activity', goal: leased.goal, createdAt: leased.createdAt, source }) };
  const oldWait = { status: 'continue', action: null, wait: { kind: 'reply', targetCompanionId: bob.id }, summary: '本次实际观察尚无回信，等待对方答复。' };
  const nativeId = 'confirmed_read_before_wait';
  const oldFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: nativeId,
    type: 'function', function: { name: 'memory', arguments: JSON.stringify({ action: 'search', query: '只读原有资料' }) } }] } }] })))
    .mockResolvedValueOnce(response(oldWait));
  const config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fake-local-key', baseUrl: 'https://fixture.invalid' };
  const capabilities = companionRecallCapabilities(async command => store.request(command), { companionId: 'alice', conversationId: conversation.id });
  await runCompanionStructuredAgent({ frame, context: { system: '只根据实际回信选择下一步。', user: JSON.stringify({ purpose: 'activity_task_step' }) },
    capabilities, finalObservationFingerprint: '[]', validateOutput: value => activityDecisionSchema.parse(value) }, config, undefined, { fetchFn: oldFetch });
  const runId = createHash('sha256').update(JSON.stringify(['alice', base.conversationId, frame.invocation!.id])).digest('hex');
  const originalRun = store.request({ type: 'agent.run.get', companionId: 'alice', id: runId }).agentRun!;
  expect(originalRun.effects).toHaveLength(1); expect(originalRun.effects[0]?.state).toBe('confirmed');
  store.request({ type: 'work.enqueue', work: { id: 'actual_main_admission_race', companionId: 'alice', conversationId: base.conversationId,
    sourceMessageId: source.id, status: 'queued', proactive: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
  expect(store.request({ type: 'activity.commit', id: leased.id, leaseToken: leased.leaseToken!, expectedStep: leased.step,
    decision: activityDecisionSchema.parse(oldWait) }).activityTask).toMatchObject({ status: 'queued', step: leased.step });
  vi.setSystemTime(Date.now() + 1600);
  const reply = store.request({ type: 'social.job.complete', id: delivery.socialJob!.id, leaseToken: delivery.socialJob!.leaseToken!,
    text: '我收到邀请了，愿意一起玩。' }).socialMessage!.message;
  const exactObservation = companionActivitySocialObservationFingerprint([reply]);
  expect(companionActivitySocialObservationFingerprint([{ ...reply, createdAt: new Date(Date.now() + 1000).toISOString() }])).toBe(exactObservation);
  expect(companionActivitySocialObservationFingerprint([{ ...reply, content: '同ID正文确实改过时必须是不同输入' }])).not.toBe(exactObservation);
  store.request({ type: 'work.status', id: 'actual_main_admission_race', status: 'done' });
  vi.setSystemTime(Date.now() + 6000); store.request({ type: 'world.tick' });
  await service!.tick();
  const get = () => store.request({ type: 'activity.get', companionId: 'alice', conversationId: base.conversationId, id: task.id }).activityTask!;
  await vi.waitFor(() => expect(get().step).toBe(leased.step + 1));
  expect(actorCalls).toBe(1); expect(get()).toMatchObject({ status: 'queued' });
  expect(get().history.at(-1)).toMatchObject({ action: 'query', ok: true });
  const revised = store.request({ type: 'agent.run.get', companionId: 'alice', id: runId }).agentRun!;
  expect(revised.rejectedFinals).toHaveLength(1); expect(revised.rejectedFinals?.[0]?.reason).toContain('真实回信观察已变化');
  expect(revised.turns.slice(0, originalRun.turns.length)).toEqual(originalRun.turns); expect(revised.effects).toEqual(originalRun.effects);
  expect(store.messages({ conversationId: reply.conversationId }).messages.filter(message => message.authorId === 'alice')).toHaveLength(1);
  expect(store.request({ type: 'activity.get', companionId: 'alice', conversationId: base.conversationId, id: base.task.id }).activityTask?.status).toBe('cancelled');
});
it('accepts unused optional nulls as explicit no-ops alongside one actual query, without memory or topic effects', async () => {
  let actorCalls = 0;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content); actorCalls++;
    const decision = { status: 'continue', action: { action: 'query', category: 'people', query: 'Qwen' }, wait: null, summary: '按原目标查询真实公开人物目录。' };
    expect(data.outputCorrection).toBeUndefined();
    expect(store.request({ type: 'activity.get', companionId: 'alice', conversationId: data.task.conversationId, id: data.task.id }).activityTask?.history).toEqual([]);
    return response({ ...decision, memory: null, topic: null, planningState: null });
  });
  const scope = setup(fetchFn, '先按公开目录了解其他伙伴。');
  await service!.tick();
  const get = () => store.request({ type: 'activity.get', companionId: 'alice', conversationId: scope.conversationId, id: scope.task.id }).activityTask!;
  await vi.waitFor(() => expect(get().step).toBe(1));
  expect(actorCalls).toBe(1); expect(get().history).toHaveLength(1); expect(get().history[0]).toMatchObject({ action: 'query', ok: true });
  expect(store.request({ type: 'activity.memory.claim' }).activityMemoryIntent).toBeUndefined();
  expect(store.request({ type: 'topic.list', conversationId: scope.conversationId, readerId: 'alice' }).topics).toEqual([]);
  const runId = createHash('sha256').update(JSON.stringify(['alice', scope.conversationId, `${scope.task.id}_0`])).digest('hex');
  const run = store.request({ type: 'agent.run.get', companionId: 'alice', id: runId }).agentRun!;
  expect(run.rejectedFinals).toBeUndefined(); expect(run.turns).toHaveLength(1);
  expect(JSON.parse(run.turns[0]!.rawText)).toMatchObject({ memory: null, topic: null, planningState: null });
});
it('still rejects non-null malformed proposal fields in the original three slots without any effect', async () => {
  const fetchFn = vi.fn<typeof fetch>(async () => response({ status: 'continue', action: { action: 'query', category: 'people', query: 'Qwen' },
    wait: null, memory: 'not-an-operation', topic: { action: 'made-up-operation' }, planningState: 'not-a-plan', summary: '坏非空字段不能作为no-op接受。' }));
  const scope = setup(fetchFn, '了解其他伙伴。'); await service!.tick();
  const get = () => store.request({ type: 'activity.get', companionId: 'alice', conversationId: scope.conversationId, id: scope.task.id }).activityTask!;
  await vi.waitFor(() => expect(get().status).toBe('failed'));
  expect(fetchFn).toHaveBeenCalledTimes(3); expect(get().history).toEqual([]); expect(get().step).toBe(0);
  expect(store.request({ type: 'activity.memory.claim' }).activityMemoryIntent).toBeUndefined();
  expect(store.request({ type: 'topic.list', conversationId: scope.conversationId, readerId: 'alice' }).topics).toEqual([]);
  const runId = createHash('sha256').update(JSON.stringify(['alice', scope.conversationId, `${scope.task.id}_0`])).digest('hex');
  expect(store.request({ type: 'agent.run.get', companionId: 'alice', id: runId }).agentRun?.rejectedFinals).toHaveLength(3);
});
it('keeps the source-bound whole-goal plan when a later valid query has no new planning proposal', async () => {
  let actorCalls = 0;
  const plan = { summary: '先核实目录，再由本人联系并完成原目标。', nextSteps: ['核实另一位伙伴', '实际联系后按真实回信推进'], constraints: ['不得代替别人报名'] };
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content); actorCalls++;
    if (actorCalls === 2) expect(data.planningState.plan).toEqual(plan);
    return response({ status: 'continue', action: { action: 'query', category: 'people', query: actorCalls === 1 ? 'Qwen' : 'Kimi' }, wait: null,
      planningState: actorCalls === 1 ? plan : null, memory: null, topic: null, summary: '本步只是核实目录，不修改整体路线。' });
  });
  const scope = setup(fetchFn, '了解伙伴并完成整个原目标。');
  const get = () => store.request({ type: 'activity.get', companionId: 'alice', conversationId: scope.conversationId, id: scope.task.id }).activityTask!;
  await service!.tick(); await vi.waitFor(() => expect(get().step).toBe(1));
  vi.setSystemTime(Date.now() + 3000); await service!.tick(); await vi.waitFor(() => expect(get().step).toBe(2));
  expect(actorCalls).toBe(2); expect(get().history.map(item => item.action)).toEqual(['query', 'query']);
  expect(feasibilityReviews).toHaveLength(1);
  expect(feasibilityReviews[0]).toMatchObject({ purpose: 'activity_resource_feasibility', exactProposedDecision: { planningState: plan } });
  vi.setSystemTime(Date.now() + 3000);
  const lease = store.request({ type: 'activity.claim' }).activityTask!;
  const observed = store.request({ type: 'activity.observe', id: lease.id, leaseToken: lease.leaseToken! });
  expect(observed.activityPlanningState).toMatchObject({ taskId: scope.task.id, revision: 2, throughStep: 1, plan });
});
it.each(['string', 'native-wrapper', 'topic-patch-field', 'topic-revision'] as const)('corrects actual invalid topic final shape %s in the original slot before one SQLite topic commit', async shape => {
  let actorCalls = 0;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (data.purpose === 'activity_resource_feasibility' || data.purpose === 'game_shared_state_privacy')
      return response({ allowed: true, confidence: .99, reason: '仅作者本人公开筹备提案，不含秘密或虚构报名。' });
    expect(data.purpose).toBe('activity_task_step'); actorCalls++;
    expect(data.executionContract.finalOutputShape).toContain('独立顶层topic');
    const topic = { action: 'update', roomId: data.gameTopic.topic.conversationId, topicId: data.gameTopic.topic.id,
      expectedRevision: data.gameTopic.topic.revision, patch: { shared: { summary: '作者自行修订的真实公开方案' } } };
    if (actorCalls === 1) return response({ status: 'continue',
      ...(shape === 'topic-patch-field' ? { action: null, topic: { ...topic, patch: { ...topic.patch, sourceMessageIds: ['PRIVATE_REJECTED_SOURCE_VALUE'], PRIVATE_UNKNOWN_FIELD_VALUE: 'PRIVATE_REJECTED_BODY_VALUE' } } }
        : shape === 'topic-revision' ? { action: null, topic: { ...topic, expectedRevision: topic.expectedRevision + 1 } }
          : { action: shape === 'string' ? 'topic' : { ...topic, action: 'topic' } }),
      wait: null, summary: '错误字段结构尚未提交。' });
    if (shape === 'topic-patch-field') {
      expect(data.outputCorrection.error).toContain('"path":"topic.patch.sourceMessageIds"');
      expect(data.outputCorrection.error).toContain('"code":"unrecognized_keys"');
      expect(data.outputCorrection.error).not.toContain('PRIVATE_');
    } else if (shape === 'topic-revision') {
      expect(data.outputCorrection.error).toContain(`expectedRevision=${topic.expectedRevision + 1}`);
      expect(data.outputCorrection.error).toContain(`currentRevision=${topic.expectedRevision}`);
      expect(data.outputCorrection.error).toContain('不要自行+1');
      expect(data.outputCorrection.error).toContain('topic.read');
    } else expect(data.outputCorrection.error).toContain(shape === 'string' ? '"path":"action"' : '"path":"action.action"');
    const feedback = JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content).hostValidationFeedback;
    expect(feedback.error).toBe(data.outputCorrection.error);
    expect(feedback.trust).toBe('host_validation_data_not_new_authorization');
    if (shape !== 'topic-revision') {
    expect(data.outputCorrection.error).toContain('原生world工具');
    expect(data.outputCorrection.error).toContain('顶层action=null且wait=null');
    }
    expect(store.request({ type: 'topic.read', conversationId: topic.roomId, topicId: topic.topicId, readerId: 'alice' }).topicState?.shared).toBeUndefined();
    return response({ status: 'continue', action: null, wait: null, topic, summary: '作者仅修订字段，提交自己的公开筹备提案。' });
  });
  const scope = setup(fetchFn, '找伙伴玩完一局游戏。', false, true);
  for (const name of ['b', 'c']) {
    const peer = store.createCompanion({ name, persona: '独立友好', description: '', model: '', avatar: 'sister', proactive: false });
    store.setCompanionActive(peer.id, true);
    const room = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', peer.id] }).socialConversation!;
    store.request({ type: 'social.message.append', conversationId: room.id, authorId: 'alice', content: '真实认识。', clientId: 'known_' + name, virtualCreatedAt: new Date().toISOString() });
  }
  vi.setSystemTime(Date.now() + 10000); store.request({ type: 'world.tick' });
  const deliveryClientId = 'actual_topic_shape_group';
  const group = store.request({ type: 'world.tool', companionId: 'alice', conversationId: scope.conversationId, sourceMessageId: scope.task.sourceMessageId,
    clientId: deliveryClientId, arguments: { action: 'create_group', recipientIds: store.state().companions.filter(role => role.id !== 'alice').map(role => role.id),
      title: '实际固定群', text: '请本人决定是否参与。', topic: { title: '真实筹备', kind: 'game' } } });
  const bound = store.request({ type: 'activity.social.ensure', companionId: 'alice', conversationId: scope.conversationId,
    sourceMessageId: scope.task.sourceMessageId!, deliveryClientId, operation: 'create_group' }).activityTask!;
  vi.setSystemTime(Date.now() + 310000);
  for (let tick = 0; tick < 1000; tick++) if (!store.request({ type: 'world.tick' }).world?.backlog) break;
  replyToBoundGroupInvitation(bound, group.topic!.id);
  await service!.tick();
  const get = () => store.request({ type: 'activity.get', companionId: 'alice', conversationId: scope.conversationId, id: bound.id }).activityTask!;
  await vi.waitFor(() => expect(get().step, JSON.stringify({ actorCalls, task: get() })).toBe(bound.step + 1));
  expect(actorCalls).toBe(2);
  expect(get().history.filter(item => item.action === 'topic.update')).toHaveLength(1);
  expect(store.request({ type: 'topic.read', conversationId: group.topic!.conversationId, topicId: group.topic!.id, readerId: 'alice' }).topicState?.shared?.summary)
    .toBe('作者自行修订的真实公开方案');
  const runId = createHash('sha256').update(JSON.stringify(['alice', scope.conversationId, `${bound.id}_${bound.step}`])).digest('hex');
  const run = store.request({ type: 'agent.run.get', companionId: 'alice', id: runId }).agentRun!;
  expect(run.rejectedFinals).toHaveLength(1); expect(run.turns).toHaveLength(2); expect(run.effects).toEqual([]);
  expect(JSON.parse(run.turns[0]!.rawText).action).toEqual(shape === 'string' ? 'topic' : shape === 'native-wrapper' ? expect.objectContaining({ action: 'topic' }) : null);
  expect(JSON.parse(run.turns[1]!.rawText)).toMatchObject({ action: null, wait: null, topic: { action: 'update' } });
});
it('hands the same live topic to its consenting participant through the activity host proof without copying private state', async () => {
  let actors = 0, reviews = 0, consentId = '', targetId = '';
  const privateText = 'OLD_MODERATOR_PRIVATE_STATE_MUST_STAY_PRIVATE';
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content);
    if (data.purpose === 'topic_moderator_transfer_consent') {
      reviews++; expect(JSON.stringify(wire)).not.toContain(privateText);
      expect(data.publicSources).toEqual([expect.objectContaining({ id: consentId, authorId: targetId, content: '我愿意接任本话题主持，按大家已经同意的流程继续。' })]);
      return response({ accepted: true, confidence: .99, consentMessageId: consentId, reason: '目标本人公开明确接受主持。' });
    }
    expect(data.purpose).toBe('activity_task_step'); actors++;
    return response({ status: 'continue', action: null, wait: null, topic: { action: 'transfer_moderator',
      roomId: data.gameTopic.topic.conversationId, topicId: data.gameTopic.topic.id, expectedRevision: data.gameTopic.topic.revision,
      targetCompanionId: targetId, sourceMessageIds: [consentId] }, summary: '将同一话题主持交给已明确自愿接任的真实参与者。' });
  });
  const scope = setup(fetchFn, '自行协商并由自愿伙伴主持同一个话题。');
  const peers = ['b', 'c'].map(name => {
    const peer = store.createCompanion({ name, persona: '独立友好', description: '', model: '', avatar: 'sister', proactive: false });
    store.setCompanionActive(peer.id, true);
    const room = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', peer.id] }).socialConversation!;
    store.request({ type: 'social.message.append', conversationId: room.id, authorId: 'alice', content: '真实认识。', clientId: 'transfer_known_' + name, virtualCreatedAt: new Date().toISOString() });
    return peer;
  });
  targetId = peers[0]!.id;
  vi.setSystemTime(Date.now() + 10000); store.request({ type: 'world.tick' });
  const clientId = 'actual_moderator_transfer_group';
  const group = store.request({ type: 'world.tool', companionId: 'alice', conversationId: scope.conversationId, sourceMessageId: scope.task.sourceMessageId,
    clientId, arguments: { action: 'create_group', recipientIds: peers.map(peer => peer.id), title: '实际协作群', text: '由本人决定参与和是否主持。',
      topic: { title: '同一实际话题', kind: 'game' } } });
  const roomId = group.topic!.conversationId, topicId = group.topic!.id;
  store.request({ type: 'topic.update', conversationId: roomId, topicId, readerId: 'alice', expectedRevision: group.topic!.revision,
    patch: { workingState: { summary: privateText, sourceMessageIds: [] } } });
  store.request({ type: 'topic.join', conversationId: roomId, topicId, readerId: targetId });
  const consent = store.appendMessage({ conversationId: roomId, topicId, authorId: targetId,
    content: '我愿意接任本话题主持，按大家已经同意的流程继续。', replyDirective: 'none' });
  consentId = consent.id;
  const bound = store.request({ type: 'activity.social.ensure', companionId: 'alice', conversationId: scope.conversationId,
    sourceMessageId: scope.task.sourceMessageId!, deliveryClientId: clientId, operation: 'create_group' }).activityTask!;
  vi.setSystemTime(Date.now() + 310000);
  for (let tick = 0; tick < 1000; tick++) if (!store.request({ type: 'world.tick' }).world?.backlog) break;
  replyToBoundGroupInvitation(bound, topicId);
  await service!.tick();
  const get = () => store.request({ type: 'activity.get', companionId: 'alice', conversationId: scope.conversationId, id: bound.id }).activityTask!;
  await vi.waitFor(() => expect(get().step, JSON.stringify(get())).toBe(bound.step + 1));
  expect({ actors, reviews }).toEqual({ actors: 1, reviews: 1 });
  expect(get().history.at(-1)).toMatchObject({ action: 'topic.transfer_moderator', ok: true });
  const target = store.request({ type: 'topic.read', conversationId: roomId, topicId, readerId: targetId });
  expect(target.topic?.moderatorId).toBe(targetId); expect(target.topic?.id).toBe(topicId);
  expect(target.topicState?.workingState).toBeUndefined();
  expect(store.request({ type: 'topic.read', conversationId: roomId, topicId, readerId: 'alice' }).topicState?.workingState?.summary).toBe(privateText);
});
it.each([false, true])('uses the real human goal for feasibility, corrects self-made constraints in-slot and preserves explicit eight-player requirements=%s through real SQLite', async fixedEight => {
  const actualGoal = fixedEight ? '必须找齐8名独立玩家，不能减少人数，玩完一局游戏。' : '找伙伴一起玩完一局游戏，结束告诉我结果。';
  let actorCalls = 0, feasibilityCalls = 0, sharedReviews = 0;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (data.purpose === 'activity_resource_feasibility') {
      feasibilityCalls++;
      expect(data.originalHumanGoal).toBe(actualGoal);
      expect(data.actualResourceBounds).toMatchObject({ activeCharacterCount: 3, boundGameRoomMemberCount: 3, otherActiveCharacterCount: 2 });
      expect(data.modelPlanTrust).toContain('model_proposal');
      if (fixedEight) {
        expect(data.exactProposedDecision).toMatchObject({ status: 'blocked', action: null, wait: null,
          planningState: { constraints: [actualGoal] } });
        return response({ allowed: true, confidence: .99, reason: '用户明确固定8人，当前只有两位群内伙伴，真实缺少所需资源，保留用户条件并如实受阻是合法的。' });
      }
      const allowed = data.exactProposedDecision.planningState.constraints.includes('自拟规模可修改，不是用户硬条件');
      return response({ allowed, confidence: .99, reason: allowed ? '作者已自行改成当前两位实际伙伴可参与的方案，不替其他人报名。'
        : '原用户没要求6人；真实房间共3伙伴且主持不抽牌，6人是模型自设且超过当前容量，需自行修改方案，不能沿此计划候人。' });
    }
    if (data.purpose === 'game_shared_state_privacy') { sharedReviews++; return response({ allowed: true, confidence: .99, reason: '只有公开可行性方案，未含私牌。' }); }
    expect(data.purpose).toBe('activity_task_step'); actorCalls++;
    if (fixedEight) return response({ status: 'blocked', action: null, wait: null,
      planningState: { summary: '保留原用户明确的8人要求，实际资源不足，不能擅自降人数。', nextSteps: [], constraints: [actualGoal] },
      summary: '当前实际资源不足以满足原用户明确要求的8名独立玩家，目标尚未完成。' });
    if (actorCalls === 2) expect(data.outputCorrection.error).toContain('原用户没要求6人');
    return response({ status: 'continue', action: null, wait: null,
      planningState: { summary: actorCalls === 1 ? '必须凑6人，继续候人' : '在当前两位伙伴范围提出可行方案，须由本人决定是否报名',
        nextSteps: ['先公开本人的方案，再等真实本人回应'], constraints: actorCalls === 1 ? ['必须6人，主持不抽牌'] : ['自拟规模可修改，不是用户硬条件'] },
      topic: { action: 'update', roomId: data.gameTopic.topic.conversationId, topicId: data.gameTopic.topic.id,
        expectedRevision: data.gameTopic.topic.revision, patch: { shared: { summary: actorCalls === 1 ? 'BAD_SIX_PLAYER_PROPOSAL' : 'AUTHOR_REVISED_FEASIBLE_PROPOSAL' } } },
      summary: '按当前真实资料拟定下一步方案。' });
  });
  const scope = setup(fetchFn, actualGoal, false, true);
  for (const id of ['b', 'c']) {
    const role = store.createCompanion({ name: id, persona: '独立友好', description: '', model: '', avatar: 'sister', proactive: false });
    store.setCompanionActive(role.id, true);
    const peerScope = { companionId: role.id, conversationId: store.openPrivate(role.id).id };
    const routine = store.request({ type: 'routine.get', ...peerScope }).routine!;
    store.request({ type: 'routine.configure', ...peerScope, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
    const room = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', role.id] }).socialConversation!;
    store.request({ type: 'social.message.append', conversationId: room.id, authorId: 'alice', content: '真实认识。', clientId: 'known_' + id, virtualCreatedAt: new Date().toISOString() });
  }
  vi.setSystemTime(Date.now() + 10000); store.request({ type: 'world.tick' });
  const targetIds = store.state().companions.filter(role => role.id !== 'alice').map(role => role.id);
  const group = store.request({ type: 'world.tool', companionId: 'alice', conversationId: scope.conversationId,
    sourceMessageId: scope.task.sourceMessageId, clientId: 'real_feasibility_game', arguments: { action: 'create_group', recipientIds: targetIds,
      title: '实际游戏群', text: '愿意一起玩吗？', topic: { kind: 'game', title: '真实筹备' } } });
  const bound = store.request({ type: 'activity.social.ensure', companionId: 'alice', conversationId: scope.conversationId,
    sourceMessageId: scope.task.sourceMessageId!, deliveryClientId: 'real_feasibility_game', operation: 'create_group' }).activityTask!;
  vi.setSystemTime(Date.now() + 310000);
  for (let tick = 0; tick < 1000; tick++) if (!store.request({ type: 'world.tick' }).world?.backlog) break;
  replyToBoundGroupInvitation(bound, group.topic!.id);
  await service!.tick();
  const get = () => store.request({ type: 'activity.get', companionId: 'alice', conversationId: scope.conversationId, id: scope.task.id }).activityTask!;
  await vi.waitFor(() => fixedEight ? expect(get().status).toBe('failed') : expect(get().step,
    JSON.stringify({ status: get().status, stage: get().stage, actorCalls, feasibilityCalls, sharedReviews })).toBe(2));
  const state = store.request({ type: 'topic.read', conversationId: group.topic!.conversationId, topicId: group.topic!.id, readerId: 'alice' });
  if (fixedEight) {
    expect(get().goal).toBe(actualGoal); expect(get().stage).toContain('8名独立玩家');
    expect(actorCalls).toBe(1); expect(feasibilityCalls).toBe(1); expect(sharedReviews).toBe(0);
    expect(state.topicState?.shared).toBeUndefined();
    expect(store.request({ type: 'activity.social.ensure', companionId: 'alice', conversationId: scope.conversationId,
      sourceMessageId: scope.task.sourceMessageId!, deliveryClientId: 'real_feasibility_game', operation: 'create_group' }).activityTask?.status).toBe('failed');
    return;
  }
  expect(state.topicState?.shared?.summary).toBe('AUTHOR_REVISED_FEASIBLE_PROPOSAL');
  expect(actorCalls).toBe(2); expect(feasibilityCalls).toBe(2); expect(sharedReviews).toBe(1);
  expect(JSON.stringify(get().history)).not.toContain('BAD_SIX_PLAYER_PROPOSAL');
  vi.setSystemTime(Date.now() + 3000); store.request({ type: 'world.tick' });
  const next = store.request({ type: 'activity.claim' }).activityTask!;
  const saved = store.request({ type: 'activity.observe', id: next.id, leaseToken: next.leaseToken! }).activityPlanningState!;
  expect(saved.revision).toBe(1); expect(saved.plan.constraints).toEqual(['自拟规模可修改，不是用户硬条件']);
});
it.each(['找几位伙伴玩完一局游戏。', '必须找齐8名独立玩家，不能减少人数，玩完一局游戏。'])('projects actual activated capacity separately from consent while preserving the exact human goal: %s', async goal => {
  let activeId = '', dormantId = '';
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content), bounds = data.executionContract.resourceBounds;
    expect(data.originalRequest.content).toBe(goal); expect(data.task.goal).toBe(goal);
    expect(bounds).toMatchObject({ activeCharacterCount: 2, includesOwner: true, otherActiveCharacterCount: 1,
      activeCharacterIds: expect.arrayContaining(['alice', activeId]), joinedTopicParticipantIds: [],
      trust: 'host_activated_capacity_not_acquaintance_consent_or_draw_player_count' });
    expect(bounds.activeCharacterIds).not.toContain(dormantId);
    expect(body.messages[0].content).toContain('原目标明确要求的人数、规则或其他约束不能暗自降低');
    return response({ status: 'continue', action: { action: 'query', category: 'people', limit: 10 }, wait: null,
      summary: '先读取当前真实人物资料；容量不是已同意参加，保持原请求约束。' });
  });
  const scope = setup(fetchFn, goal);
  const active = store.createCompanion({ name: 'Active', description: '', persona: '独立伙伴', model: '', avatar: 'sister', proactive: false });
  activeId = active.id; store.setCompanionActive(activeId, true);
  dormantId = store.createCompanion({ name: 'Dormant', description: '', persona: '独立伙伴', model: '', avatar: 'sister', proactive: false }).id;
  await service!.tick(); await vi.waitFor(() => expect(store.request({ type: 'activity.get', companionId: scope.companionId,
    conversationId: scope.conversationId, id: scope.task.id }).activityTask?.step).toBe(1));
  expect(fetchFn).toHaveBeenCalledOnce();
  expect(store.request({ type: 'state', includeHidden: true }).state?.companions.find(role => role.id === dormantId)?.active).toBe(false);
});
it('persists an independent whole-goal proposal through 36 steps, a durable wait and a restart, then cancels on source withdrawal', async () => {
  let seen = 0;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.purpose).toBe('activity_task_step');
    const step = data.task.step;
    if (step) expect(data.planningState).toMatchObject({ taskId: data.task.id, throughStep: step - 1,
      trust: 'model_plan_not_execution_fact_or_authority', plan: { summary: `整体路线第${step}步`, constraints: ['只控制本人，原始条件保持'] } });
    else expect(data.planningState).toBeUndefined();
    seen++;
    return response({ status: 'continue', action: step === 17 ? null : { action: 'query', category: 'scenes', limit: 1 },
      wait: step === 17 ? { kind: 'delay', seconds: 1 } : null, summary: '这一步的短回执会被宿主stage替换',
      planningState: { summary: `整体路线第${step + 1}步`, nextSteps: ['核对真实资料后继续完整目标'], constraints: ['只控制本人，原始条件保持'] } });
  });
  const scope = setup(fetchFn), get = () => store.request({ type: 'activity.get', companionId: scope.companionId,
    conversationId: scope.conversationId, id: scope.task.id }).activityTask!;
  for (let index = 0; index < 36; index++) {
    vi.setSystemTime(Date.now() + 3000); store.request({ type: 'world.tick' }); await service!.tick();
    await vi.waitFor(() => expect(get().step).toBe(index + 1));
    expect(get()).not.toHaveProperty('wholeGoalPlan'); expect(get()).not.toHaveProperty('planningState');
    if (index === 17) expect(get()).toMatchObject({ status: 'waiting', stage: '等待世界时间经过' });
    if (index === 19) {
      await service!.close(); store.close();
      store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
      store.request({ type: 'activity.recover' });
      service = new CompanionActivityTaskService({ request: async input => input.type === 'memory.search'
        ? { ok: true, memoryPage: { items: [], hasMore: false } } : store.request(input), fetchFn: withProgressReview(fetchFn),
        configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' }),
        profiles: async () => ({ publicProfiles: [], visualInputs: [] }), excludedIds: () => [], changed: vi.fn(), report: error => { throw error; } });
    }
  }
  expect(seen).toBe(36); expect(get().history).toHaveLength(32);
  expect(store.request({ type: 'activity.history', companionId: scope.companionId, conversationId: scope.conversationId,
    id: scope.task.id, limit: 100 }).activityHistory?.total).toBe(36);
  store.request({ type: 'memory.forget', companionId: scope.companionId, conversationId: scope.conversationId, sourceMessageIds: [scope.task.sourceMessageId!] });
  vi.setSystemTime(Date.now() + 3000); await service!.tick();
  expect(get()).toMatchObject({ status: 'cancelled', history: [] }); expect(seen).toBe(36);
});
it('requires the exact source, current lease/step and a real completed inference before persisting a plan or committing its action', () => {
  const scope = setup(vi.fn()), leased = store.request({ type: 'activity.claim' }).activityTask!;
  const base = { id: leased.id, leaseToken: leased.leaseToken!, expectedStep: leased.step };
  expect(() => store.request({ type: 'activity.plan.save', ...base, sourceDigest: '0'.repeat(64) })).toThrow('来源或步骤');
  const source = store.messages({ conversationId: scope.conversationId }).messages.find(message => message.id === leased.sourceMessageId)!;
  expect(() => store.request({ type: 'activity.plan.save', ...base, sourceDigest: createHash('sha256').update(source.content).digest('hex') })).toThrow('已完成且来源有效');
  const action = { action: 'query' as const, category: 'people' as const, limit: 1 };
  expect(() => store.request({ type: 'activity.commit', ...base, expectedStep: leased.step + 1,
    decision: { status: 'continue', action, wait: null, summary: '不能提交旧步骤' } })).toThrow('步骤已有真实进展');
  expect(() => store.request({ type: 'activity.reject', ...base, expectedStep: leased.step + 1,
    action, reason: '不能覆盖新步骤' })).toThrow('步骤已有真实进展');
  expect(store.request({ type: 'activity.get', companionId: scope.companionId, conversationId: scope.conversationId,
    id: leased.id }).activityTask).toMatchObject({ status: 'running', step: 0, history: [] });
});
it('freezes an empty passive preparation across steps while preserving explicit memory and actual experience tools', async () => {
  let empty = true;
  const calls: CompanionStorageCommand[] = [];
  const toolMenus: string[][] = [];
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content);
    toolMenus.push(wire.tools.map((tool: { function: { name: string } }) => tool.function.name));
    if (empty) {
      expect(wire.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['memory', 'world', 'wait', COMPANION_SUBMIT_RESULT_TOOL]);
      expect(data.memoryAvailability).toMatchObject({ authorizedCorpusEmpty: true, revision: 'empty-now' });
      if (fetchFn.mock.calls.length === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
        id: 'empty_corpus_experience_days', type: 'function', function: { name: 'world',
          arguments: JSON.stringify({ action: 'experience', parameters: { action: 'days' } }) },
      }] } }] }));
      expect(wire.messages.some((message: { role: string; tool_call_id?: string; content: string }) => message.role === 'tool'
        && message.tool_call_id === 'empty_corpus_experience_days' && message.content.includes('"experienceDays"'))).toBe(true);
      expect(calls.filter(command => command.type === 'experience.days')).toEqual([{ type: 'experience.days', companionId: 'alice', limit: 20 }]);
    }
    else { expect(wire.tools).toHaveLength(4); expect(wire.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['memory', 'world', 'wait', COMPANION_SUBMIT_RESULT_TOOL]); expect(data.memoryAvailability).toMatchObject({ authorizedCorpusEmpty: true, revision: 'empty-now' }); }
    return response({ status: 'continue', action: { action: 'query', category: 'scenes', limit: 1 }, wait: null, summary: '用当前真实上下文继续，回忆可用性每步核实。' });
  });
  const base = setup(fetchFn); await service!.close();
  service = new CompanionActivityTaskService({ request: async input => { calls.push(input); return input.type === 'memory.search' ? { ok: true,
    memoryPage: { items: [], hasMore: false }, ...(empty ? { memoryRetrieval: { mode: 'active', engine: 'none', observedAt: new Date().toISOString(),
      resultCount: 0, candidateQuerySeparateFromContext: true, stages: [], authorizedCorpusEmpty: true, authorizedCorpusRevision: 'empty-now' } } : {}) } : store.request(input); },
    fetchFn: withProgressReview(fetchFn), configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' }),
    profiles: async () => ({ publicProfiles: [], visualInputs: [] }), excludedIds: () => [], changed: vi.fn(), report: error => { throw error; } });
  const get = () => store.request({ type: 'activity.get', companionId: base.companionId, conversationId: base.conversationId, id: base.task.id }).activityTask!;
  await service.tick(); await vi.waitFor(() => expect(toolMenus.length).toBeGreaterThan(0));
  expect(toolMenus[0]).toEqual(['memory', 'world', 'wait', COMPANION_SUBMIT_RESULT_TOOL]);
  await vi.waitFor(() => expect(get().step).toBe(1));
  empty = false; vi.setSystemTime(Date.now() + 3000); await service.tick(); await vi.waitFor(() => expect(get().step, JSON.stringify(get())).toBe(2));
  expect(fetchFn).toHaveBeenCalledTimes(3);
  expect(calls.filter(command => command.type === 'memory.search')).toHaveLength(1);
});
it.each(['ordinary_revision', 'withdrawal'] as const)('keeps one task-level passive receipt through a wait, user stop/resume and process restart: %s', async change => {
  const actorSteps: number[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.purpose).toBe('activity_task_step'); expect(data.memoryContext).toBe('INITIAL_TASK_PASSIVE_FACT');
    actorSteps.push(data.task.step);
    return response({ status: 'continue', action: null, wait: { kind: 'delay', seconds: 1 }, summary: '登记下一次实际观察的等待。' });
  });
  const base = setup(fetchFn, '分两次观察并核对原有约定。'); await service!.close();
  const scope = { companionId: base.companionId, conversationId: base.conversationId };
  const original = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '原有约定的真实来源。', replyDirective: 'none' });
  const note = store.request({ type: 'memory.record', ...scope, candidate: { content: original.content, tags: [], sourceMessageIds: [original.id],
    evidence: [{ sourceMessageId: original.id, quote: original.content }] } }).memories![0]!;
  const frozenDependencies = [{ id: note.id, sources: note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) }];
  const passiveRecall = vi.fn(async () => ({ ok: true, memoryContext: { text: 'INITIAL_TASK_PASSIVE_FACT', revision: 'initial-corpus', profileKey: 'fixture',
    evidence: { capturedAt: new Date().toISOString(), corpusHash: 'initial', dependencyCoverage: 'complete' as const, dependencies: [{ id: note.id, version: note.version }],
      snapshotPolicy: 'task_passive_v1' as const, frozenDependencies } }, memoryPage: { items: [], hasMore: false } }));
  const createService = () => new CompanionActivityTaskService({ request: async input => store.request(input), passiveRecall,
    memoryContextValid: async (_scope, context) => store.request({ type: 'memory.frozen.valid', ...scope,
      memories: (context as Awaited<ReturnType<typeof passiveRecall>>['memoryContext']).evidence.frozenDependencies }).memoryFrozenValid === true,
    fetchFn: withProgressReview(fetchFn), configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' }),
    profiles: async () => ({ publicProfiles: [], visualInputs: [] }), excludedIds: () => [], changed: vi.fn(), report: error => { throw error; } });
  service = createService();
  const get = () => store.request({ type: 'activity.get', ...scope, id: base.task.id }).activityTask!;
  await service.tick(); await vi.waitFor(() => expect(get()).toMatchObject({ step: 1, status: 'waiting' }));
  const history = get().history;
  store.request({ type: 'activity.cancel', ...scope, id: base.task.id });
  store.request({ type: 'task-stop.record', ...scope, taskId: base.task.id, kind: 'activity', title: base.task.title,
    stop: { actor: 'user', reason: 'user_requested', requestedAt: new Date().toISOString() } });
  await service.close(); store.close();
  store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds.map(seed => ({ ...seed, active: true })));
  if (change === 'ordinary_revision') store.request({ type: 'memory.revise', ...scope, id: note.id, expectedVersion: note.version,
    candidate: { content: '普通整理后的另一种表述。', tags: ['整理'], sourceMessageIds: [original.id], evidence: [{ sourceMessageId: original.id, quote: original.content }] } });
  else store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [original.id], persistent: true });
  expect(store.request({ type: 'activity.resume', ...scope, id: base.task.id }).activityTask).toMatchObject({ step: 1, history });
  service = createService(); vi.setSystemTime(Date.now() + 3000); store.request({ type: 'world.tick' }); await service.tick();
  await vi.waitFor(() => expect(get()).toMatchObject(change === 'withdrawal' ? { step: 1, status: 'failed' } : { step: 2, status: 'waiting' }));
  expect(passiveRecall).toHaveBeenCalledOnce(); expect(actorSteps).toEqual(change === 'withdrawal' ? [0] : [0, 1]);
  expect(get().history.slice(0, history.length)).toEqual(history);
  expect(get()).not.toHaveProperty('passiveRecall');
});
it('binds the native initial recall actually consumed by the plan, excludes candidates, and withdraws the plan with its material source', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.memoryContext).toBe('实际被阅读的原始资料'); expect(data.memories).toEqual([]);
    return response({ status: 'continue', action: { action: 'query', category: 'scenes', limit: 1 }, wait: null,
      summary: '依据真实资料拟定路线', planningState: { summary: '从已读资料得来的可修改计划', nextSteps: ['继续核实'], constraints: ['不能把计划当事实'] } });
  });
  const base = setup(fetchFn); await service!.close();
  const scope = { companionId: base.companionId, conversationId: base.conversationId };
  const note = (content: string) => {
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content, replyDirective: 'none' });
    const memory = store.request({ type: 'memory.record', ...scope, candidate: { content, tags: ['资料'], sourceMessageIds: [source.id],
      evidence: [{ sourceMessageId: source.id, quote: content }] } }).memories![0]!;
    return { source, memory };
  };
  const read = note('实际被阅读的原始资料'), candidate = note('仅候选没有读过的资料');
  service = new CompanionActivityTaskService({ request: async input => input.type === 'memory.search' ? { ok: true,
    memoryPage: { items: [{ memory: candidate.memory, score: 1, reasons: ['candidate'], path: [] }], hasMore: false }, memoryContext: { text: read.memory.content,
      revision: 'fixture-native-revision', profileKey: 'fixture-native-profile', evidence: { capturedAt: new Date().toISOString(), corpusHash: 'fixture',
        dependencyCoverage: 'complete', dependencies: [{ id: read.memory.id, version: read.memory.version }], references: [] } } } : store.request(input),
    fetchFn: withProgressReview(fetchFn), configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' }),
    profiles: async () => ({ publicProfiles: [], visualInputs: [] }), excludedIds: () => [], changed: vi.fn(), report: error => { throw error; } });
  await service.tick();
  const get = () => store.request({ type: 'activity.get', ...scope, id: base.task.id }).activityTask!;
  await vi.waitFor(() => expect(get().step, JSON.stringify(get())).toBe(1));
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [candidate.source.id] });
  expect(get()).toMatchObject({ historyAvailable: true, step: 1 });
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [read.source.id] });
  expect(get()).toMatchObject({ historyAvailable: false, history: [] });
  vi.setSystemTime(Date.now() + 3000); await service.tick();
  expect(get().status).toBe('cancelled'); expect(fetchFn).toHaveBeenCalledOnce();
});
it.each([{ initiallyQueued: true, offline: false }, { initiallyQueued: false, offline: false }, { initiallyQueued: true, offline: true }])('continues a visit through a real reply, permission, exit travel and actual arrival, %j', async ({ initiallyQueued, offline }) => {
  vi.setSystemTime('2026-10-16T13:40:00Z');
  let targetId = ''; const purposes: string[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    purposes.push(data.purpose);
    if (data.purpose === 'world_decision') {
      const pending = data.world.visits.find((visit: { hostId: string; status: string }) => visit.hostId === data.companion.id && visit.status === 'requested');
      return response({ action: pending ? { action: 'respond', requestId: pending.id, decision: 'allow', reason: '有空，欢迎来玩。' } : null, reason: '按实际请求回应。', appraisals: [] });
    }
    if (data.purpose === 'world_social') return response({ text: data.identity.self.id === targetId ? '我有空，欢迎来一起看书。' : null, reason: '依据真实来信回应。' });
    if (data.purpose === 'world_social_notification') return response({ text: null, eventId: data.confirmedEvent.eventId, initiatorId: 'user' });
    if (data.purpose === 'visit_peer_speech') {
      expect(JSON.stringify(data)).not.toMatch(/PRIVATE_PLAYER_SECRET|PRIVATE_UNSENT_PLAYER_DRAFT/);
      return response({ text: data.channel === 'face_to_face' ? '我到了，很高兴见到你。' : '想来找你玩，现在方便吗？' });
    }
    if (data.purpose === 'world_message_authorization') return response({ allowed: true, intent: 'visit', requiresContinuation: true, confidence: .99, evidence: [data.source.content], reason: '原委托明确要求本人拜访。' });
    expect(data.purpose).toBe('activity_task_step');
    if (data.task.step > 0) expect(data.task.visitTargetId).toBe(targetId);
    if (data.task.step === 0) return response({ status: 'continue', action: { action: 'message', recipientIds: [targetId], text: '我想去找你玩，现在方便吗？' },
      wait: { kind: 'reply', targetCompanionId: targetId }, summary: '先发一条必要问候，再继续原拜访目标。' });
    if (!data.recentPeerMessages.some((message: { authorId: string }) => message.authorId === targetId))
      return response({ status: 'continue', action: null, wait: { kind: 'reply', targetCompanionId: targetId }, summary: '已留言，等待真实回复。' });
    const visit = data.world.visits.find((visit: { guestId: string; hostId: string }) => visit.guestId === 'alice' && visit.hostId === targetId);
    if (!visit) return response({ status: 'continue', action: { action: 'visit', targetCompanionId: targetId, reason: '我想来找你玩，现在方便吗？' },
      wait: { kind: 'permission', targetCompanionId: targetId }, summary: '根据实际回信申请拜访许可。' });
    if (data.task.visitInteractionAt) return response({ status: 'complete', action: null, wait: null, summary: '我到了Bob的小屋，已经和她当面打招呼、收到回应。' });
    if (data.task.visitArrivedAt) {
      const self = data.world.actors.find((actor: { companionId: string }) => actor.companionId === 'alice');
      const host = data.world.perception.people.find((person: { companionId: string; visible: boolean }) => person.companionId === targetId && person.visible);
      if (!host || Math.hypot(self.position.x - host.position.x, self.position.y - host.position.y) > 4) return response({ status: 'continue', action: { action: 'move', position: host ? { x: host.position.x + 1, y: host.position.y + 1 } : { x: self.position.x, y: Math.max(8, self.position.y - 3) } }, wait: { kind: 'arrival' }, summary: '根据本地感知探索并走近房主。' });
      if (!data.task.history.some((item: { action: string; ok: boolean }) => item.action === 'social' && item.ok)) return response({ status: 'continue', action: { action: 'social', targetCompanionId: targetId, kind: 'greet', text: 'PRIVATE_UNSENT_PLAYER_DRAFT' }, wait: { kind: 'reply', targetCompanionId: targetId }, summary: '当面打招呼并等待真实回应。' });
      return response({ status: 'continue', action: null, wait: { kind: 'reply', targetCompanionId: targetId }, summary: '等待面对面回应。' });
    }
    expect(visit.status).toBe('allowed');
    return response({ status: 'continue', action: { action: 'travel', targetSceneId: visit.destination.sceneId, entryId: visit.destination.entryId }, wait: { kind: 'arrival' }, summary: '从自己的出口前往获准的场景入口。' });
  });
  const base = setup(fetchFn); store.request({ type: 'activity.cancel', companionId: base.companionId, conversationId: base.conversationId, id: base.task.id });
  const target = store.createCompanion({ name: 'Bob', description: '', persona: '友好且如实回应', model: '', avatar: 'sister', proactive: false });
  targetId = target.id; store.setCompanionActive(targetId, true);
  const host = { companionId: targetId, conversationId: store.openPrivate(targetId).id }, routine = store.request({ type: 'routine.get', ...host }).routine!;
  store.request({ type: 'routine.configure', ...host, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  const scope = { companionId: base.companionId, conversationId: base.conversationId };
  const acquaintance = store.request({ type: 'social.conversation.ensure', companionId: scope.companionId, memberIds: [scope.companionId, targetId] }).socialConversation!;
  store.request({ type: 'social.message.append', conversationId: acquaintance.id, authorId: scope.companionId, content: 'Bob你好，我是Alice。', virtualCreatedAt: new Date().toISOString(), clientId: 'actual_prior_acquaintance' });
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '去找Bob玩吧。PRIVATE_PLAYER_SECRET', replyDirective: 'none' });
  const task = initiallyQueued ? store.request({ type: 'activity.visit.ensure', ...scope, sourceMessageId: source.id, targetId,
    initialMessage: { text: '我想去找你玩，现在方便吗？', clientId: 'agent_visit_first_message' } }).activityTask!
    : store.request({ type: 'activity.start', ...scope, sourceMessageId: source.id, clientId: 'explicit_visit_agent', title: '拜访Bob', goal: source.content }).activityTask!;
  const get = () => store.request({ type: 'activity.get', ...scope, id: task.id }).activityTask!;
  const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); };
  for (const person of [scope, host]) {
    const routine = store.request({ type: 'routine.get', ...person }).routine!;
    store.request({ type: 'routine.configure', ...person, expectedRevision: routine.revision, patch: { habits: [{ id: 'soft_rest', title: '午后休息', kind: 'rest', at: '13:30', durationMinutes: 25 }] } });
  }
  advance(30000);
  expect(store.request({ type: 'world.snapshot' }).world!.actors.every(actor => actor.routinePhase === 'resting')).toBe(true);
  if (offline) {
    const running = store.request({ type: 'activity.claim' }).activityTask!;
    store.request({ type: 'activity.commit', id: running.id, leaseToken: running.leaseToken!, decision: { status: 'continue',
      action: { action: 'visit', targetCompanionId: targetId, reason: '有空时想来找你玩。' }, wait: { kind: 'permission', targetCompanionId: targetId }, summary: '等待正式许可' } });
    store.close(); vi.setSystemTime(Date.now() + 3 * 3600000);
    store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds.map(seed => ({ ...seed, active: true })));
    store.request({ type: 'activity.recover' });
    expect(Date.parse(task.deadline)).toBeLessThan(Date.now());
    await service!.tick(); expect(fetchFn).not.toHaveBeenCalled();
    expect(get()).toMatchObject({ status: 'waiting', step: 2 });
  }
  vi.useFakeTimers();
  worldService = new CompanionWorldService({ request: async input => input.type === 'memory.search' ? { ok: true, memoryPage: { items: [], hasMore: false },
    memoryContext: { text: '', revision: store.request({ type: 'memory.snapshot', companionId: input.companionId, conversationId: input.conversationId,
      beforeSequence: input.beforeSequence }).memorySnapshot!.revision, profileKey: 'fixture-vcp-profile' } } : store.request(input), fetchFn,
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' }), changed: vi.fn(), wakeWaiting: vi.fn(), report: error => { throw error; },
    memoryContextValid: async (scope, context) => !context || store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!.revision === context.revision });
  for (let iteration = 0; iteration < 150 && get().status !== 'succeeded'; iteration++) {
    await worldService.tick(); await service!.tick();
    await vi.advanceTimersByTimeAsync(1600); store.request({ type: 'world.tick' });
  }
  expect(get(), JSON.stringify(get())).toMatchObject({ status: 'succeeded', visitTargetId: targetId });
  expect(store.request({ type: 'world.observe', ...scope }).world!.actors[0]!.sceneId).toBe('home_' + targetId);
  expect(get().visitArrivedAt).toBeDefined(); expect(get().visitInteractionAt).toBeDefined();
  expect(get().stage).toContain('双方当面交流'); expect(get().stage).not.toMatch(/茶|烧水|看书/);
  expect(purposes.filter(purpose => purpose === 'world_message_authorization').length).toBe(initiallyQueued ? 0 : 1);
  expect(purposes).toContain('world_decision'); expect(purposes).toContain('world_social');
  const room = store.request({ type: 'social.conversations', companionId: scope.companionId }).socialConversationPage!.items[0]!;
  const exchanged = store.request({ type: 'social.messages', conversationId: room.id }).socialMessagePage!.items;
  expect(JSON.stringify(exchanged)).not.toMatch(/PRIVATE_PLAYER_SECRET|PRIVATE_UNSENT_PLAYER_DRAFT/);
  expect(['alice', targetId].every(id => exchanged.some(item => item.channel === 'face_to_face' && item.message.authorId === id))).toBe(true);
  expect(store.request({ type: 'activity.list', ...scope }).activityTasks?.filter(task => task.sourceMessageId === source.id)).toHaveLength(1);
  expect(store.messages({ conversationId: scope.conversationId }).messages.filter(message => message.content === source.content)).toHaveLength(1);
});
it('rejects an out-of-scope draft without sending it or ending the goal, then lets the planner correct its next action', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (data.purpose === 'world_message_authorization') return response({ allowed: false, intent: 'message', requiresContinuation: false, confidence: .99, evidence: [data.source.content], reason: '原请求只要求自己去沙发坐一会儿。' });
    expect(data.purpose).toBe('activity_task_step');
    if (data.task.step === 0) return response({ status: 'continue', action: { action: 'message', recipientIds: ['unrelated'], text: 'PRIVATE_UNSENT' }, wait: null, summary: '错误的额外联系' });
    expect(data.task.history[0]).toMatchObject({ action: 'message', ok: false });
    expect(data.task.history[0].result).toContain('原任务仍保留');
    if (data.task.step === 1) return response({ status: 'continue', action: { action: 'move', destinationId: 'alice_sofa' }, wait: null, summary: '回到原本的移动目标' });
    return response({ status: 'complete', action: null, wait: null, summary: '已走到自己的沙发旁。' });
  });
  const scope = setup(fetchFn), get = () => store.request({ type: 'activity.get', companionId: scope.companionId, conversationId: scope.conversationId, id: scope.task.id }).activityTask!;
  await service!.tick(); await vi.waitFor(() => expect(get().step).toBe(1));
  expect(get().status).toBe('queued');
  vi.setSystemTime(Date.now() + 2000); await service!.tick(); await vi.waitFor(() => expect(get().step).toBe(2));
  vi.setSystemTime(Date.now() + 20000); store.request({ type: 'world.tick' }); await service!.tick();
  await vi.waitFor(() => expect(get().status).toBe('succeeded'));
  expect(store.request({ type: 'social.conversations', companionId: scope.companionId }).socialConversationPage!.items).toHaveLength(0);
});
it('runs a native model planning loop, sleeps without model polling, then continues and reports without any new player message', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.purpose).toBe('activity_task_step'); expect(data.originalRequest.authorId).toBe('user');
    if (data.task.step === 0) return response({ status: 'continue', action: { action: 'move', destinationId: 'alice_sofa' }, wait: null, summary: '先走到沙发' });
    if (data.task.step === 1) { expect(data.world.actors[0].route).toEqual([]); return response({ status: 'continue', action: { action: 'interact', furnitureId: 'alice_sofa', interaction: 'sit' }, wait: { kind: 'delay', seconds: 2 }, summary: '实际坐一会儿' }); }
    return response({ status: 'complete', action: null, wait: null, summary: '已经走到沙发并坐下休息了。' });
  });
  const scope = setup(fetchFn), get = () => store.request({ type: 'activity.get', companionId: scope.companionId, conversationId: scope.conversationId, id: scope.task.id }).activityTask!;
  await service!.tick(); await vi.waitFor(() => expect(get().status).toBe('waiting'));
  for (let tick = 0; tick < 20; tick++) await service!.tick(); expect(fetchFn).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 20000); store.request({ type: 'world.tick' });
  await service!.tick(); await vi.waitFor(() => expect(get().step).toBe(2)); expect(get().status).toBe('waiting');
  vi.setSystemTime(Date.now() + 3000); store.request({ type: 'world.tick' }); await service!.tick();
  await vi.waitFor(() => expect(get().status).toBe('succeeded')); expect(fetchFn).toHaveBeenCalledTimes(3);
  const messages = store.request({ type: 'messages', conversationId: scope.conversationId, limit: 30 }).messages!;
  expect(messages.filter(message => message.content.includes('已经走到沙发并坐下'))).toHaveLength(1);
  expect(messages.filter(message => message.content === '去自己的沙发坐一会儿，完成后告诉我。')).toHaveLength(1);
});
it('rejects an in-flight result after cancellation, rather than dispatching its late movement', async () => {
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const fetchFn = vi.fn<typeof fetch>(() => pending), scope = setup(fetchFn);
  await service!.tick(); await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  store.request({ type: 'activity.cancel', companionId: scope.companionId, conversationId: scope.conversationId, id: scope.task.id }); service!.cancel(scope.task.id);
  resolve(response({ status: 'continue', action: { action: 'move', destinationId: 'alice_sofa' }, wait: null, summary: '旧规划' }));
  await service!.close();
  expect(store.request({ type: 'world.observe', companionId: scope.companionId, conversationId: scope.conversationId }).world!.actors[0]!.route).toHaveLength(0);
  expect(store.request({ type: 'activity.get', companionId: scope.companionId, conversationId: scope.conversationId, id: scope.task.id }).activityTask!.status).toBe('cancelled');
});

it.each(['private', 'group', 'world', 'world-private-owned', 'private-own-revise', 'private-own-organize'] as const)(
  'reads a real owned material and records sourced personal understanding within the original %s domain', async domain => {
    let materialId = '', sourceId = '', quote = '', learnedId = '';
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      expect(data.purpose).toBe('activity_task_step');
      if (data.task.step === 0) return response({ status: 'continue', action: null, wait: null,
        memory: { operation: 'read', id: materialId }, summary: '先实际阅读这一份本人可见资料，再决定是否形成认识。' });
      const read = data.task.history.find((item: { action: string }) => item.action === 'memory.read');
      expect(read).toBeDefined();
      expect(read.ok).toBe(true);
      const actualRead = JSON.parse(read.result);
      expect(actualRead.memories[0]).toMatchObject({ id: materialId, version: 1, sourceMessageIds: [sourceId] });
      expect(actualRead.sources[0]).toMatchObject({ id: sourceId, content: expect.stringContaining(quote) });
      const ownMutation = domain === 'private-own-revise' || domain === 'private-own-organize';
      if (ownMutation && data.task.step === 1) return response({ status: 'continue', action: null, wait: null,
        memory: domain === 'private-own-organize' ? { operation: 'organize', ids: [materialId], tags: ['学习资料', '已核对出处'] }
          : { operation: 'revise', id: materialId, expectedVersion: 1, candidate: { diaryName: '学习资料', content: '阅读方法：' + quote,
            tags: ['学习资料', '已核对出处'], sourceMessageIds: [sourceId], evidence: [{ sourceMessageId: sourceId, quote }] } }, summary: '按实际阅读结果整理这一份资料。' });
      if (data.task.step === 1 || ownMutation && data.task.step === 2) return response({ status: 'continue', action: null, wait: null,
        memory: { operation: 'record', candidate: { diaryName: '自我认识', content: '读过这份有来源的资料后，我更愿意保留观察背景和原始出处，再形成有条件的个人判断。',
          tags: ['资料学习', '原始出处', '个人认识'], sourceMessageIds: [sourceId], relatedMemoryIds: [materialId], evidence: [{ sourceMessageId: sourceId, quote }] } },
        summary: '根据实际读到的资料，记录可以追溯和撤回的个人理解。' });
      const written = data.task.history.find((item: { action: string }) => item.action === 'memory.record');
      expect(written.ok).toBe(true); learnedId = JSON.parse(written.result).memories[0].id;
      return response({ status: 'complete', action: null, wait: null, summary: '已读完这份资料，并保存有原始来源的个人认识。' });
    });
    const base = setup(fetchFn); store.request({ type: 'activity.cancel', companionId: base.companionId, conversationId: base.conversationId, id: base.task.id });
    await service!.close();
    const scope = { companionId: 'alice', conversationId: domain === 'group' ? store.createConversation('本人的学习小组', ['alice']).id
      : domain.startsWith('world') ? 'world_alice' : base.conversationId };
    const materialScope = domain === 'world-private-owned' ? { companionId: 'alice', conversationId: base.conversationId } : scope;
    const source = domain === 'world' ? store.request({ type: 'memory.world_query', ...scope, category: 'observations', query: '', limit: 2 }).memorySources![0]!
      : store.appendMessage({ conversationId: materialScope.conversationId, authorId: 'user',
        content: domain === 'world-private-owned' ? 'PRIVATE_MATERIAL_DETAIL' : '读资料时保存原始出处，区分实际观察、作者解释和自己的推测，不把一次观察升级为普遍结论。', replyDirective: 'none' });
    sourceId = source.id; quote = source.content.slice(0, 180);
    materialId = store.request({ type: 'memory.record', ...materialScope, candidate: { diaryName: '学习资料', content: source.content, tags: ['学习资料', '阅读方法'],
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!.id;
    const calls: CompanionStorageCommand[] = [];
    service = new CompanionActivityTaskService({ request: async input => { calls.push(input); return input.type === 'memory.search'
      ? { ok: true, memoryPage: { items: [], hasMore: false } } : store.request(input); },
      configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' }),
      profiles: async () => ({ publicProfiles: [], visualInputs: [] }), fetchFn: withProgressReview(fetchFn), excludedIds: () => [], changed: vi.fn(), report: error => { throw error; } });
    const goal = '阅读本人可见资料 ' + materialId + '；只有实际读到内容后才用逐字证据形成个人认识，保持原来源范围。';
    const taskSource = domain.startsWith('world') ? undefined : store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: goal, replyDirective: 'none' });
    const task = store.request({ type: 'activity.start', ...scope, clientId: 'learn_material_' + domain,
      ...(taskSource ? { sourceMessageId: taskSource.id } : {}), title: '阅读指定的本人资料', goal }).activityTask!;
    const get = () => store.request({ type: 'activity.get', ...scope, id: task.id }).activityTask!;
    for (let step = 0; step < 15 && !['succeeded', 'failed'].includes(get().status); step++) {
      await service.tick(); await new Promise(resolve => setImmediate(resolve));
      vi.setSystemTime(Date.now() + 2000); store.request({ type: 'world.tick' });
    }
    expect(get().status).toBe('succeeded');
    expect(calls.find(input => input.type === 'memory.read')).toMatchObject({ ...scope, id: materialId });
    expect(calls.filter(input => input.type === 'memory.record')).toHaveLength(1);
    const learned = store.request({ type: 'memory.read', ...scope, id: learnedId }).memoryRead!.memory;
    expect(learned).toMatchObject({ diaryName: '自我认识', sourceConversationId: materialScope.conversationId });
    expect(learned.sources.map(item => item.messageId)).toEqual([sourceId]);
    expect(get().history.filter(item => item.action.startsWith('memory.')).map(item => item.action)).toEqual(domain === 'private-own-revise'
      ? ['memory.read', 'memory.revise', 'memory.record'] : domain === 'private-own-organize' ? ['memory.read', 'memory.organize', 'memory.record'] : ['memory.read', 'memory.record']);
    store.request({ type: 'memory.forget', ...materialScope, sourceMessageIds: [sourceId] });
    expect(() => store.request({ type: 'memory.read', ...scope, id: learnedId })).toThrow();
    expect(store.request({ type: 'activity.get', ...scope, id: task.id }).activityTask!.history).toEqual([]);
  });

it.each(['revise', 'forget'] as const)('rejects stale learning after a previously read material is externally %s during the next model inference', async change => {
  let materialId = '', planning = false, resolve!: (value: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const fetchFn: typeof fetch = async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (data.task.step === 0) return response({ status: 'continue', action: null, wait: null, memory: { operation: 'read', id: materialId }, summary: '读取指定的本人资料。' });
    expect(data.task.history[0]).toMatchObject({ action: 'memory.read', ok: true }); planning = true; return pending;
  };
  const base = setup(fetchFn); store.request({ type: 'activity.cancel', companionId: base.companionId, conversationId: base.conversationId, id: base.task.id }); await service!.close();
  const scope = { companionId: base.companionId, conversationId: base.conversationId };
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '这是需要保留出处的原始阅读资料。', replyDirective: 'none' });
  const sourceId = source.id, quote = source.content;
  const candidate = { diaryName: '学习资料', content: source.content, tags: ['学习资料'], sourceMessageIds: [sourceId], evidence: [{ sourceMessageId: sourceId, quote }] };
  materialId = store.request({ type: 'memory.record', ...scope, candidate }).memories![0]!.id;
  const calls: CompanionStorageCommand[] = [];
  service = new CompanionActivityTaskService({ request: async input => { calls.push(input); return input.type === 'memory.search'
    ? { ok: true, memoryPage: { items: [], hasMore: false } } : store.request(input); },
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' }),
    profiles: async () => ({ publicProfiles: [], visualInputs: [] }), fetchFn, excludedIds: () => [], changed: vi.fn(), report: error => { throw error; } });
  const request = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '阅读这份资料并形成有来源的个人认识。', replyDirective: 'none' });
  const task = store.request({ type: 'activity.start', ...scope, sourceMessageId: request.id, clientId: 'stale_learning_' + change,
    title: '阅读指定资料', goal: request.content + materialId }).activityTask!;
  for (let step = 0; step < 8 && !planning; step++) { await service.tick(); await new Promise(done => setImmediate(done));
    vi.setSystemTime(Date.now() + 2000); store.request({ type: 'world.tick' }); }
  expect(planning).toBe(true);
  if (change === 'forget') store.request({ type: 'memory.forget', ...scope, id: materialId });
  else store.request({ type: 'memory.revise', ...scope, id: materialId, expectedVersion: 1, candidate: { ...candidate, content: '管理员修订了资料解释，但保留同一份原始出处。' } });
  resolve(response({ status: 'continue', action: null, wait: null, summary: '这是基于旧资料版本的晚到认识。',
    memory: { operation: 'record', candidate: { ...candidate, diaryName: '自我认识', content: '不应落盘的旧版认识', relatedMemoryIds: [materialId] } } }));
  await vi.waitFor(() => expect(calls.some(command => command.type === 'activity.fail')).toBe(true));
  // A rejected in-flight lease is reclaimed by the durable scheduler, without publishing its old result.
  vi.setSystemTime(Date.now() + 122000); store.request({ type: 'world.tick' }); await service.tick();
  expect(calls.some(command => command.type === 'memory.record')).toBe(false);
  const stopped = store.request({ type: 'activity.get', ...scope, id: task.id }).activityTask!;
  expect(stopped).toMatchObject({ status: 'cancelled', history: [] });
  expect(store.request({ type: 'memory.browse', ...scope }).memoryPage!.items.some(hit => hit.memory.content === '不应落盘的旧版认识')).toBe(false);
});
