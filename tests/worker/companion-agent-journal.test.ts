import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { companionAgentJournal, captureCompanionAgentMemories } from '../../src/main/companions/agent-journal';
import { createHash } from 'node:crypto';
import { companionRecallCapabilities, runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';
import { companionTopicCapabilities } from '../../src/main/companions/topic-capabilities';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import { activityDecisionSchema } from '../../src/shared/companion-activity-task';
import { companionFinalValidationFailures, type CompanionAgentRun } from '../../src/shared/companion-agent-run';

let root: string, store: CompanionsStore, frame: CompanionReplyInput;
const seeds = [{ id: 'alice', name: 'Alice', persona: '认真核对事实', description: '', model: '', avatar: 'sister' as const, proactive: false, active: true }];
const config = { apiFormat: 'openai_chat' as const, model: 'test', baseUrl: 'https://test.invalid/v1', apiKey: 'synthetic-only' };
const domain = { system: '只输出JSON {answer:string}。', user: JSON.stringify({ purpose: 'durable_test' }) };
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'companion-agent-journal-'));
  store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  const conversation = store.openPrivate('alice');
  const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: '建立一个独立讨论话题。', replyDirective: 'none' });
  frame = { companion: store.state().companions[0]!, conversation, messages: [source], sourceMessage: source, memories: [],
    invocation: { id: 'actual_job', kind: 'player', companionId: 'alice', conversationId: conversation.id,
      sourceMessageId: source.id, goal: source.content, status: 'running', createdAt: source.createdAt,
      messagePort: { kind: 'conversation' }, authorization: { kind: 'player', sourceMessageIds: [source.id], externalActions: false } } };
});
afterEach(() => {
  store.close(); const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('companion-agent-journal-')) throw new Error('Invalid cleanup');
  rmSync(resolved, { recursive: true, force: true });
  vi.useRealTimers();
});
const response = (content: string, tool?: object) => new Response(JSON.stringify({ choices: [{ message: { content, ...(tool ? { tool_calls: [tool] } : {}) } }] }));
async function legacyActivityFinal(withEffect = false, finalObservationFingerprint?: string) {
  store.close();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-24T10:00:00Z');
  store = new CompanionsStore(path.join(root, 'legacy-state.sqlite'), seeds);
  const conversation = store.openPrivate('alice');
  const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: '建立一个独立讨论话题。', replyDirective: 'none' });
  frame = { companion: store.state().companions[0]!, conversation, messages: [source], sourceMessage: source, memories: [],
    invocation: { id: 'actual_job', kind: 'player', companionId: 'alice', conversationId: conversation.id, sourceMessageId: source.id,
      goal: source.content, status: 'running', createdAt: source.createdAt, messagePort: { kind: 'conversation' },
      authorization: { kind: 'player', sourceMessageIds: [source.id], externalActions: false } } };
  const scope = { companionId: 'alice', conversationId: frame.conversation.id };
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  const routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:59', wakeAt: '00:01', meals: [], habits: [] } });
  vi.setSystemTime(Date.now() + 10000); store.request({ type: 'world.tick' });
  const task = store.request({ type: 'activity.start', ...scope, sourceMessageId: frame.sourceMessage!.id, title: '原活动', goal: frame.sourceMessage!.content, clientId: 'actual_legacy_activity' }).activityTask!;
  const leased = store.request({ type: 'activity.claim' }).activityTask!;
  expect(leased?.id).toBe(task.id);
  frame.invocation = { ...frame.invocation!, id: `${task.id}_${leased.step}`, kind: 'activity', authorization: {
    kind: 'self', sourceMessageIds: [frame.sourceMessage!.id], externalActions: false }, messagePort: { kind: 'invocation', messageIds: [] } };
  const capabilities = () => {
    const recall = companionRecallCapabilities(async command => store.request(command), scope);
    return withEffect ? companionTopicCapabilities(async command => store.request(command), scope, recall) : recall;
  };
  const fetchFn = vi.fn<typeof fetch>();
  if (withEffect) fetchFn.mockResolvedValueOnce(response('', { id: 'legacy_confirmed_topic', type: 'function', function: { name: 'world',
    arguments: JSON.stringify({ action: 'topic', parameters: { action: 'create', kind: 'discussion', title: '旧流程已经实际建立的唯一话题' } }) } }));
  fetchFn.mockResolvedValueOnce(response('{"legacy":"unexecuted_proposal"}'));
  await runCompanionStructuredAgent({ context: domain, frame, capabilities: capabilities(), finalObservationFingerprint }, config, undefined, { fetchFn });
  const id = createHash('sha256').update(JSON.stringify(['alice', frame.conversation.id, frame.invocation.id])).digest('hex');
  const run = store.request({ type: 'agent.run.get', companionId: 'alice', id }).agentRun!;
  const command = (input: Parameters<NonNullable<Parameters<typeof runCompanionStructuredAgent>[0]['reviseFinal']>>[0], lease = leased.leaseToken!) => ({
    type: 'agent.run.revise_final' as const, companionId: 'alice', id: input.runId, expectedRevision: input.expectedRevision,
    activityTaskId: task.id, leaseToken: lease, expectedStep: leased.step, turnStep: input.step, proposalChecksum: input.proposalChecksum, reason: input.reason,
    ...(input.hostObservation ? { hostObservation: input.hostObservation } : {}) });
  const reject = { runId: id, expectedRevision: run.revision, step: run.turns.length - 1,
    proposalChecksum: createHash('sha256').update(run.turns.at(-1)!.rawText).digest('hex'), reason: '旧提案不符合当前实际资料，尚未执行。' };
  return { scope, task: leased, run, id, command, reject, capabilities };
}
it('reuses an unchanged host observation without another model call and never replays confirmed native effects', async () => {
  const f = await legacyActivityFinal(true, '[]');
  const fetchFn = vi.fn<typeof fetch>();
  expect(await runCompanionStructuredAgent({ context: domain, frame, capabilities: f.capabilities(), finalObservationFingerprint: '[]',
    reviseFinal: async input => store.request(f.command(input)).agentRun }, config, undefined, { fetchFn })).toEqual({ legacy: 'unexecuted_proposal' });
  expect(fetchFn).not.toHaveBeenCalled();
  const unchanged = store.request({ type: 'agent.run.get', companionId: 'alice', id: f.id }).agentRun!;
  expect(unchanged.rejectedFinals).toBeUndefined(); expect(unchanged.turns).toEqual(f.run.turns); expect(unchanged.effects).toEqual(f.run.effects);
});
it('reopens an obsolete done final for new native work without spending the third semantic correction or replaying confirmed effects', async () => {
  const f = await legacyActivityFinal(true, '[]');
  const reviseFinal = async (input: Parameters<NonNullable<Parameters<typeof runCompanionStructuredAgent>[0]['reviseFinal']>>[0]) => store.request(f.command(input)).agentRun;
  const firstFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(response('{"invalid":true}'))
    .mockResolvedValueOnce(response('{"answer":"依据旧观察尚未执行的提案"}'));
  await runCompanionStructuredAgent({ context: domain, frame, capabilities: f.capabilities(), finalObservationFingerprint: '[]', reviseFinal,
    validateOutput: value => { if (!(value as { answer?: string }).answer) throw new Error('作者提案缺少真实结论。'); return value; } }, config, undefined, { fetchFn: firstFetch });
  const before = store.request({ type: 'agent.run.get', companionId: 'alice', id: f.id }).agentRun!;
  expect(before.status).toBe('done'); expect(companionFinalValidationFailures(before)).toBe(2);
  const bob = store.createCompanion({ name: 'Bob', persona: '独立回应', description: '', model: '', avatar: 'sister', proactive: false });
  store.setCompanionActive(bob.id, true);
  const pair = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', bob.id] }).socialConversation!;
  const message = store.request({ type: 'social.message.append', conversationId: pair.id, authorId: bob.id, content: '实际新回信要求继续核实资料。',
    clientId: 'actual_observation', virtualCreatedAt: new Date().toISOString() }).socialMessage!.message;
  store.request({ type: 'activity.observe', id: f.task.id, leaseToken: f.task.leaseToken! });
  const current = { context: { ...domain, user: JSON.stringify({ purpose: 'durable_test', recentPeerMessages: [message] }) },
    fingerprint: JSON.stringify([[message.id, message.conversationId, message.sequence, createHash('sha256').update(message.content).digest('hex')]]) };
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response('', { id: 'new_observation_work', type: 'function', function: { name: 'world',
    arguments: JSON.stringify({ action: 'topic', parameters: { action: 'create', kind: 'discussion', title: '新观察后的独立核验话题' } }) } }))
    .mockResolvedValueOnce(response('{"answer":"作者根据本次新观察自行交付的提案"}'));
  expect(await runCompanionStructuredAgent({ context: current.context, frame, capabilities: f.capabilities(),
    finalObservationFingerprint: current.fingerprint, reviseFinal }, config, undefined, { fetchFn })).toEqual({ answer: '作者根据本次新观察自行交付的提案' });
  expect(fetchFn).toHaveBeenCalledTimes(2);
  const refreshed = store.request({ type: 'agent.run.get', companionId: 'alice', id: f.id }).agentRun!;
  expect(refreshed.status).toBe('done'); expect(companionFinalValidationFailures(refreshed)).toBe(2);
  expect(refreshed.rejectedFinals?.filter(item => item.hostObservation)).toHaveLength(1);
  expect(refreshed.turns.slice(0, before.turns.length)).toEqual(before.turns);
  expect(refreshed.effects.slice(0, f.run.effects.length)).toEqual(f.run.effects); expect(refreshed.effects).toHaveLength(2);
  const noMoreFetch = vi.fn<typeof fetch>();
  await expect(runCompanionStructuredAgent({ context: current.context, frame, capabilities: f.capabilities(), finalObservationFingerprint: current.fingerprint,
    validateOutput: () => { throw new Error('第三次模型语义错误。'); }, reviseFinal }, config, undefined, { fetchFn: noMoreFetch })).rejects.toThrow('第三次模型语义错误');
  expect(noMoreFetch).not.toHaveBeenCalled();
  const exhausted = store.request({ type: 'agent.run.get', companionId: 'alice', id: f.id }).agentRun!;
  expect(exhausted.rejectedFinals).toHaveLength(4); expect(companionFinalValidationFailures(exhausted)).toBe(3);
  expect(exhausted.effects).toEqual(refreshed.effects);
  store.close(); store = new CompanionsStore(path.join(root, 'legacy-state.sqlite'), seeds);
  const later = vi.fn<typeof fetch>();
  await expect(runCompanionStructuredAgent({ context: current.context, frame, capabilities: f.capabilities(), finalObservationFingerprint: current.fingerprint,
    reviseFinal }, config, undefined, { fetchFn: later })).rejects.toThrow('第三次模型语义错误');
  expect(later).not.toHaveBeenCalled();
  expect(store.request({ type: 'topic.list', conversationId: frame.conversation.id, readerId: 'alice' }).topics).toHaveLength(2);
});
it.each(['withdrawn', 'lease_changed', 'cancelled'] as const)('does not let a changed observation reopen a saved final after the live activity is %s', async invalid => {
  const f = await legacyActivityFinal(true, '[]');
  if (invalid === 'withdrawn') store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [frame.sourceMessage!.id] });
  if (invalid === 'cancelled') store.request({ type: 'activity.cancel', ...f.scope, id: f.task.id });
  if (invalid === 'lease_changed') {
    store.request({ type: 'activity.recover' }); vi.setSystemTime(Date.now() + 3000); store.request({ type: 'world.tick' });
    expect(store.request({ type: 'activity.claim' }).activityTask?.leaseToken).not.toBe(f.task.leaseToken);
  }
  const fetchFn = vi.fn<typeof fetch>();
  await expect(runCompanionStructuredAgent({ context: domain, frame, capabilities: f.capabilities(), finalObservationFingerprint: 'changed-host-observation',
    reviseFinal: async input => store.request(f.command(input)).agentRun }, config, undefined, { fetchFn })).rejects.toThrow();
  expect(fetchFn).not.toHaveBeenCalled();
  if (invalid !== 'withdrawn') {
    const run = store.request({ type: 'agent.run.get', companionId: 'alice', id: f.id }).agentRun!;
    expect(run.rejectedFinals).toBeUndefined(); expect(run.turns).toEqual(f.run.turns); expect(run.effects).toEqual(f.run.effects);
  }
  if (invalid === 'cancelled') expect(store.request({ type: 'activity.get', ...f.scope, id: f.task.id }).activityTask?.status).toBe('cancelled');
});
it('repairs a saved done final only for the same still-uncommitted actual activity after restart while preserving all confirmed native effects', async () => {
  const f = await legacyActivityFinal(true);
  store.close(); store = new CompanionsStore(path.join(root, 'legacy-state.sqlite'), seeds);
  store.request({ type: 'activity.recover' }); vi.setSystemTime(Date.now() + 3000); store.request({ type: 'world.tick' });
  const current = store.request({ type: 'activity.claim' }).activityTask!;
  expect(current).toMatchObject({ id: f.task.id, step: 0, status: 'running' }); expect(current.leaseToken).not.toBe(f.task.leaseToken);
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.outputCorrection.error).toContain('旧提案');
    return response('{"answer":"依据当前事实修订后的原目标下一步"}');
  });
  const result = await runCompanionStructuredAgent({ context: domain, frame, capabilities: f.capabilities(),
    validateOutput: value => { if ((value as { legacy?: string }).legacy) throw new Error('旧提案与当前实际资料不一致。'); return value; },
    reviseFinal: async input => store.request(f.command(input, current.leaseToken)).agentRun }, config, undefined, { fetchFn });
  expect(result).toEqual({ answer: '依据当前事实修订后的原目标下一步' }); expect(fetchFn).toHaveBeenCalledOnce();
  const revised = store.request({ type: 'agent.run.get', companionId: 'alice', id: f.id }).agentRun!;
  expect(revised.status).toBe('done'); expect(revised.turns.slice(0, f.run.turns.length)).toEqual(f.run.turns);
  expect(revised.effects).toEqual(f.run.effects); expect(revised.effects).toHaveLength(1);
  expect(revised.rejectedFinals).toMatchObject([{ step: 1, proposalChecksum: f.reject.proposalChecksum, activityTaskId: f.task.id, activityStep: 0 }]);
  expect(store.request({ type: 'topic.list', conversationId: frame.conversation.id, readerId: 'alice' }).topics).toHaveLength(1);
  expect(store.request({ type: 'activity.get', ...f.scope, id: f.task.id }).activityTask).toMatchObject({ status: 'running', step: 0 });
});
it.each(['cancelled', 'failed', 'succeeded', 'withdrawn', 'lease_changed', 'lease_expired', 'wrong_checksum', 'wrong_step', 'foreign_task'] as const)('does not reopen a legacy final when its actual activity proof is %s', async invalid => {
  const f = await legacyActivityFinal();
  let command = f.command(f.reject);
  if (invalid === 'cancelled') store.request({ type: 'activity.cancel', ...f.scope, id: f.task.id });
  if (invalid === 'failed' || invalid === 'succeeded') store.request({ type: 'activity.commit', id: f.task.id, leaseToken: f.task.leaseToken!,
    decision: { status: invalid === 'failed' ? 'blocked' : 'complete', action: null, wait: null, summary: '原活动已经实际收束。' } });
  if (invalid === 'withdrawn') store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [frame.sourceMessage!.id] });
  if (invalid === 'lease_changed') { store.request({ type: 'activity.recover' }); vi.setSystemTime(Date.now() + 3000); store.request({ type: 'world.tick' }); store.request({ type: 'activity.claim' }); }
  if (invalid === 'lease_expired') vi.setSystemTime(Date.now() + 120001);
  if (invalid === 'wrong_checksum') command = { ...command, proposalChecksum: '0'.repeat(64) };
  if (invalid === 'wrong_step') command = { ...command, expectedStep: 9 };
  if (invalid === 'foreign_task') command = { ...command, activityTaskId: 'another_task' };
  expect(() => store.request(command)).toThrow();
  if (invalid !== 'withdrawn') expect(store.request({ type: 'agent.run.get', companionId: 'alice', id: f.id }).agentRun).toEqual(f.run);
});
it('keeps default callers from reopening a stored final without a live-domain host proof', async () => {
  const f = await legacyActivityFinal();
  const fetchFn = vi.fn<typeof fetch>();
  await expect(runCompanionStructuredAgent({ context: domain, frame, capabilities: f.capabilities(),
    validateOutput: () => { throw new Error('当前契约拒绝旧final'); } }, config, undefined, { fetchFn })).rejects.toThrow('当前契约');
  expect(fetchFn).not.toHaveBeenCalled();
  expect(store.request({ type: 'agent.run.get', companionId: 'alice', id: f.id }).agentRun).toEqual(f.run);
});
it('persists the three-proposal validation budget across a saved-final repair and restart without clock-triggered model retries', async () => {
  const f = await legacyActivityFinal();
  const validateOutput = () => { throw new Error('当前提案仍不符合实际资料。'); };
  const reviseFinal = async (input: Parameters<NonNullable<Parameters<typeof runCompanionStructuredAgent>[0]['reviseFinal']>>[0]) => store.request(f.command(input)).agentRun;
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => response('{"still":"invalid"}'));
  await expect(runCompanionStructuredAgent({ context: domain, frame, capabilities: f.capabilities(), validateOutput, reviseFinal }, config, undefined, { fetchFn })).rejects.toThrow('当前提案');
  expect(fetchFn).toHaveBeenCalledTimes(2);
  const exhausted = store.request({ type: 'agent.run.get', companionId: 'alice', id: f.id }).agentRun!;
  expect(exhausted.rejectedFinals).toHaveLength(3); expect(exhausted.turns).toHaveLength(3);
  store.close(); store = new CompanionsStore(path.join(root, 'legacy-state.sqlite'), seeds);
  const later = vi.fn<typeof fetch>();
  await expect(runCompanionStructuredAgent({ context: domain, frame, capabilities: f.capabilities(), validateOutput, reviseFinal }, config, undefined, { fetchFn: later })).rejects.toThrow('当前提案');
  expect(later).not.toHaveBeenCalled();
  const altered: CompanionAgentRun = { ...exhausted, revision: exhausted.revision + 1, rejectedFinals: [] };
  expect(() => store.request({ type: 'agent.run.save', run: altered, expectedRevision: exhausted.revision })).toThrow('拒绝凭证');
});
it('awaits semantic rejection before persisting a final proposal, then stores only the corrected accepted turn', async () => {
  const validateOutput = vi.fn(async (value: unknown) => {
    await new Promise(resolve => setImmediate(resolve));
    if ((value as { unsafe?: boolean }).unsafe) throw new Error('共享载荷包含未公开的其他成员秘密，未写入。');
    return value;
  });
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response('{"unsafe":true}')).mockResolvedValueOnce(response('{"safe":true}'));
  const request = async (command: CompanionStorageCommand) => store.request(command);
  expect(await runCompanionStructuredAgent({ context: domain, frame, validateOutput,
    capabilities: companionRecallCapabilities(request, { companionId: 'alice', conversationId: frame.conversation.id }) }, config, undefined, { fetchFn })).toEqual({ safe: true });
  const id = createHash('sha256').update(JSON.stringify(['alice', frame.conversation.id, frame.invocation!.id])).digest('hex');
  const run = store.request({ type: 'agent.run.get', companionId: 'alice', id }).agentRun!;
  expect(run.status).toBe('done'); expect(run.turns).toHaveLength(1); expect(run.turns[0]!.rawText).toBe('{"safe":true}');
  expect(validateOutput).toHaveBeenCalledTimes(2);
});

it.each(['topic', 'wait'] as const)('repairs an empty continue in the same journal slot to a legal %s step without storing the empty plan or reviving a terminal task', async operation => {
  const scope = { companionId: 'alice', conversationId: frame.conversation.id };
  const terminal = store.request({ type: 'activity.start', ...scope, sourceMessageId: frame.sourceMessage!.id, clientId: 'actual_terminal', title: '旧实际目标', goal: frame.sourceMessage!.content }).activityTask!;
  store.request({ type: 'activity.cancel', ...scope, id: terminal.id });
  const topic = store.request({ type: 'topic.create', conversationId: frame.conversation.id, readerId: 'alice', title: '实际话题', kind: 'discussion' }).topic!;
  const empty = { status: 'continue', action: null, wait: null, summary: '我下一步会去读取话题。',
    planningState: { summary: '只是可修改计划', nextSteps: ['读取当前真实话题'], constraints: ['不能把计划当已经执行'] } };
  const valid = { ...empty, ...(operation === 'topic' ? { topic: { action: 'read', roomId: topic.conversationId, topicId: topic.id } }
    : { wait: { kind: 'delay', seconds: 1 } }) };
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(JSON.stringify(empty))).mockImplementationOnce(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.outputCorrection.error).toContain('status=continue必须');
    return response(JSON.stringify(valid));
  });
  const result = await runCompanionStructuredAgent({ context: domain, frame, validateOutput: value => activityDecisionSchema.parse(value),
    capabilities: companionRecallCapabilities(async command => store.request(command), { companionId: 'alice', conversationId: frame.conversation.id }) }, config, undefined, { fetchFn });
  expect(result).toEqual(valid); expect(fetchFn).toHaveBeenCalledTimes(2);
  const id = createHash('sha256').update(JSON.stringify(['alice', frame.conversation.id, frame.invocation!.id])).digest('hex');
  const run = store.request({ type: 'agent.run.get', companionId: 'alice', id }).agentRun!;
  expect(run.turns).toHaveLength(1); expect(JSON.parse(run.turns[0]!.rawText)).toEqual(valid);
  expect(store.request({ type: 'activity.list', ...scope, limit: 50 }).activityTasks).toMatchObject([{ id: terminal.id, status: 'cancelled' }]);
  expect(store.request({ type: 'activity.claim' }).activityTask).toBeUndefined();
  for (const status of ['complete', 'blocked'] as const) expect(activityDecisionSchema.parse({ status, action: null, wait: null, summary: '如实记录实际终态。' }).status).toBe(status);
});

it('keeps a confirmed native effect while repairing only the final empty continue to a real wait', async () => {
  const wait = { status: 'continue', action: null, wait: { kind: 'delay', seconds: 1 }, summary: '已有真实话题回执，等待实际时间后再继续。' };
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response('', { id: 'actual_create', type: 'function', function: { name: 'world',
    arguments: JSON.stringify({ action: 'topic', parameters: { action: 'create', title: '真实只创建一次', kind: 'discussion' } }) } }))
    .mockResolvedValueOnce(response(JSON.stringify({ ...wait, wait: null, summary: '下步再看。' }))).mockResolvedValueOnce(response(JSON.stringify(wait)));
  const request = async (command: CompanionStorageCommand) => store.request(command);
  expect(await runCompanionStructuredAgent({ context: domain, frame, validateOutput: value => activityDecisionSchema.parse(value),
    capabilities: companionTopicCapabilities(request, { companionId: 'alice', conversationId: frame.conversation.id },
      companionRecallCapabilities(request, { companionId: 'alice', conversationId: frame.conversation.id })) }, config, undefined, { fetchFn })).toEqual(wait);
  expect(fetchFn).toHaveBeenCalledTimes(3);
  expect(store.request({ type: 'topic.list', conversationId: frame.conversation.id, readerId: 'alice' }).topics).toHaveLength(1);
  const id = createHash('sha256').update(JSON.stringify(['alice', frame.conversation.id, frame.invocation!.id])).digest('hex');
  expect(store.request({ type: 'agent.run.get', companionId: 'alice', id }).agentRun?.turns).toHaveLength(2);
});
it('recovers a committed topic effect after receipt acknowledgement fails, without creating another topic or model decision', async () => {
  let failAcknowledgement = true;
  const request = async (command: CompanionStorageCommand) => {
    if (command.type === 'agent.run.save' && (command.run.effects ?? []).some(effect => effect.state === 'confirmed') && failAcknowledgement) {
      failAcknowledgement = false; throw new Error('simulated acknowledgement failure');
    }
    return store.request(command);
  };
  const capabilities = () => companionTopicCapabilities(request, { companionId: 'alice', conversationId: frame.conversation.id },
    companionRecallCapabilities(request, { companionId: 'alice', conversationId: frame.conversation.id }));
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response('', { id: 'provider_call', type: 'function', function: { name: 'world',
    arguments: JSON.stringify({ action: 'topic', parameters: { action: 'create', title: '唯一讨论', kind: 'discussion' } }) } }))
    .mockResolvedValueOnce(response('{"answer":"话题已建立"}'));
  await expect(runCompanionStructuredAgent({ context: domain, frame, capabilities: capabilities() }, config, undefined, { fetchFn })).rejects.toThrow('acknowledgement');
  const topics = () => store.request({ type: 'topic.list', conversationId: frame.conversation.id, readerId: 'alice' }).topics!;
  expect(topics()).toHaveLength(1);
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  await expect(runCompanionStructuredAgent({ context: domain, frame, capabilities: capabilities() }, config, undefined, { fetchFn })).resolves.toEqual({ answer: '话题已建立' });
  expect(topics()).toHaveLength(1); expect(fetchFn).toHaveBeenCalledTimes(2);
});
it('uses compare-and-swap for concurrent journals and rejects a withdrawn source before restoring raw history', async () => {
  const journal = companionAgentJournal(async command => store.request(command));
  const run = await journal.load(frame, domain); await journal.save(run);
  const stale = structuredClone(run); await journal.save(run);
  await expect(journal.save(stale)).rejects.toThrow('另一个执行器');
  const source = frame.sourceMessage!;
  store.request({ type: 'memory.forget', companionId: 'alice', conversationId: source.conversationId, sourceMessageIds: [source.id] });
  expect(await journal.valid(run)).toBe(false);
  await expect(journal.load(frame, domain)).rejects.toThrow(/撤回|更新/);
});

it('invalidates a resumed private-port inference when its separate game private checkpoint source is withdrawn', async () => {
  const room = frame.conversation.id;
  const topic = store.request({ type: 'topic.create', conversationId: room, readerId: 'alice', title: '实际本局', kind: 'game' }).topic!;
  const roleSource = store.appendMessage({ conversationId: room, topicId: topic.id, authorId: 'alice', content: '本人实际收到的私牌与行动。', replyDirective: 'none' });
  const read = store.request({ type: 'topic.update', conversationId: room, topicId: topic.id, readerId: 'alice', expectedRevision: topic.revision,
    patch: { workingState: { summary: '本人的合法私态', sourceMessageIds: [roleSource.id], state: { role: 'seer' } } } });
  expect(read.ok).toBe(true);
  frame.gameCommunication = { gamePort: { conversationId: room, topicId: topic.id }, topic: read.topic!, topicState: read.topicState!,
    binding: { jobId: 'actual_job', companionId: 'alice', sourceMessageId: frame.sourceMessage!.id, sourceConversationId: room,
      sourceChecksum: createHash('sha256').update(frame.sourceMessage!.content).digest('hex') }, trust: 'actual_job_same_game_reference_not_source_or_human_authority' };
  const journal = companionAgentJournal(async command => store.request(command));
  const run = await journal.load(frame, domain); await journal.save(run);
  expect(run.topics).toEqual([{ conversationId: room, topicId: topic.id, checkpointEventIds: [read.topicState!.workingState!.sourceEventId], sourceMessageIds: [roleSource.id] }]);
  store.request({ type: 'memory.forget', companionId: 'alice', conversationId: room, sourceMessageIds: [roleSource.id] });
  expect(store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: room, ids: [frame.sourceMessage!.id] }).memorySources).toHaveLength(1);
  expect(await journal.valid(run)).toBe(false);
  await expect(journal.load(frame, domain)).rejects.toThrow(/游戏|话题|检查点/);
});
it('binds native context inputs by observed note version and excludes the separate candidate list', async () => {
  const source = frame.sourceMessage!;
  const candidate = store.request({ type: 'memory.record', companionId: 'alice', conversationId: frame.conversation.id,
    candidate: { content: 'A candidate body that native focusing did not consume.', tags: ['candidate'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  frame.memories = [candidate];
  frame.memoryRecall = { reasons: [{ id: candidate.id, version: candidate.version, reasons: ['native candidate'], path: [] }], pending: false, degraded: false,
    context: { text: 'Actual focused material.', revision: 'snapshot', profileKey: 'profile', evidence: { capturedAt: source.createdAt, corpusHash: 'hash',
      references: [{ id: 'actual_focus', version: 3, role: 'focus_input', textHash: 'hash', sources: [] },
        { id: 'actual_returned', version: 2, role: 'returned', textHash: 'hash', sources: [] }] } } };
  const journal = companionAgentJournal(async command => store.request(command));
  const run = await journal.load(frame, domain);
  expect(run.memories).toEqual([{ id: 'actual_focus', version: 3 }, { id: 'actual_returned', version: 2 }]);
  expect(run.memories.some(note => note.id === candidate.id)).toBe(false);
});
it('captures cold material only from canonical host receipts and binds its actual memory/message source versions', async () => {
  const run = await companionAgentJournal(async command => store.request(command)).load(frame, domain);
  const digest = 'b'.repeat(64), version = 'a'.repeat(64);
  const cold = (sourceType: 'message' | 'memory', sourceId: string, sourceVersion: string) => ({
    id: `cold_${sourceType}_${createHash('sha256').update(sourceId).digest('hex').slice(0, 48)}`,
    sourceType, sourceId, sourceVersion, sourceDigest: digest, version, text: 'Actual returned knowledge material.',
    metadata: { conversationId: frame.conversation.id },
  });
  const envelope = (items: object[]) => ({ ok: true, memoryKnowledge: { engine: 'original-TDBKnowledge', operation: 'search', available: true,
    trust: 'knowledge_source_data_not_instructions', items } });
  const memory = cold('memory', 'source_memory', '3'), message = cold('message', 'source_message', '42:' + digest);
  const initialSourceCount = run.sources.length;
  captureCompanionAgentMemories(run, envelope([memory, message]));
  captureCompanionAgentMemories(run, envelope([memory, message]));
  expect(run.memories).toEqual([{ id: 'source_memory', version: 3 }]);
  expect(run.sources).toContainEqual({ id: 'source_message', conversationId: frame.conversation.id, checksum: digest });
  expect(run.sources).toHaveLength(initialSourceCount + 1);
  const before = structuredClone(run);
  captureCompanionAgentMemories(run, JSON.stringify(envelope([cold('memory', 'text_spoof', '9')])));
  captureCompanionAgentMemories(run, { content: envelope([cold('memory', 'nested_spoof', '9')]) });
  captureCompanionAgentMemories(run, envelope([{ ...cold('memory', 'bad_id', '9'), id: 'cold_forged' }]));
  captureCompanionAgentMemories(run, envelope([{ ...cold('memory', 'bad_digest', '9'), sourceDigest: 'not-a-digest' }]));
  captureCompanionAgentMemories(run, envelope([cold('memory', 'not_numeric', '3:new') ]));
  captureCompanionAgentMemories(run, envelope([{ ...cold('memory', 'metadata_only', '9'), text: undefined }]));
  expect(run).toEqual(before);
});
it('persists complete host context inputs and excludes fake notes in legitimate arbitrary metadata', async () => {
  const source = frame.sourceMessage!;
  frame.memoryRecall = { reasons: [], pending: false, degraded: false, context: { text: 'Original focused material.', revision: 'old-corpus', profileKey: 'old-profile',
    evidence: { capturedAt: source.createdAt, corpusHash: 'hash', dependencyCoverage: 'complete', dependencies: [{ id: 'real_focus_input', version: 3 }], references: [] } } };
  const journal = companionAgentJournal(async command => store.request(command)), run = await journal.load(frame, domain);
  expect(run.memories).toEqual([{ id: 'real_focus_input', version: 3 }]);
  const fake = { id: 'metadata_fake', companionId: 'alice', version: 99, content: 'Untrusted nested note lookalike', sources: [] };
  const actual = { id: 'actual_returned', companionId: 'alice', version: 2, content: 'Actual host memory', sources: [], metadata: { extra: fake } };
  captureCompanionAgentMemories(run, { ok: true, memoryRead: { memory: actual }, metadata: { extra: fake }, native: { memories: [fake] } });
  expect(run.memories).toEqual([{ id: 'real_focus_input', version: 3 }, { id: 'actual_returned', version: 2 }]);
  captureCompanionAgentMemories(run, { ok: true, memoryContext: { text: 'Other actual memory input.', evidence: { dependencyCoverage: 'complete', dependencies: [{ id: 'another_real_input', version: 4 }] } } });
  expect(run.memories).toContainEqual({ id: 'another_real_input', version: 4 }); expect(run.memories.some(note => note.id === fake.id)).toBe(false);
});
