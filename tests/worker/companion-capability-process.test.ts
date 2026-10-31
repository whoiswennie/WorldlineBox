import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { verifyCompanionCapabilityEvidence } from '../../src/main/companions/capability-evidence';
import { guardCompanionExecutionSources } from '../../src/main/companions/source-execution-evidence';

let store: CompanionsStore, root: string;
const at = '2026-10-29T10:00:00.000Z';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at);
  root = mkdtempSync(path.join(tmpdir(), 'capability-process-'));
  store = new CompanionsStore(path.join(root, 'messages.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, persona: '依据真实经历表达。',
    description: '', model: '', avatar: 'sister', active: true, proactive: false })));
});
afterEach(() => {
  store.close(); vi.useRealTimers();
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('capability-process-')) throw Error('Unexpected cleanup');
  rmSync(root, { recursive: true, force: true });
});
function messageCall() {
  const room = store.openPrivate('alice');
  const source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '请查看已有的任务安排。' });
  const reply = store.appendMessage({ conversationId: room.id, authorId: 'alice', content: '', replyToId: source.id, loopStep: 0 });
  store.request({ type: 'loop.save', checkpoint: { companionId: 'alice', conversationId: room.id, sourceMessageId: source.id,
    messageId: reply.id, status: 'running', turns: [], supplements: [] } });
  const command: Extract<CompanionStorageCommand, { type: 'capability.begin' }> = { type: 'capability.begin', companionId: 'alice', conversationId: room.id,
    title: '查看事件', name: 'agenda', callId: 'actual_call', invocationId: source.id + ':alice', input: '{"action":"tasks.read"}',
    sourceMessageId: source.id, parentMessageId: reply.id, loopStep: 0 };
  return { room, source, reply, command };
}
function autonomousCall() {
  const room = store.openPrivate('alice');
  store.request({ type: 'agenda.rule.create', companionId: 'alice', operationId: 'autonomous_capability', authority: { kind: 'system' },
    rule: { title: '自行查看学习安排', intent: '依据真实目标判断下一步。', kind: 'self', executor: 'brain',
      trigger: { kind: 'at', at, timeZone: 'UTC' }, reason: '实际自主安排' } });
  store.request({ type: 'agenda.tick', companionId: 'alice', now: at, facts: { active: true } });
  const claim = store.request({ type: 'agenda.claim', companionId: 'alice', now: at, limit: 1, leaseMs: 30000, excludedOwners: [] }).agendaClaim!;
  expect(claim).toBeDefined();
  const command: Extract<CompanionStorageCommand, { type: 'capability.begin' }> = { type: 'capability.begin', companionId: 'alice', conversationId: room.id,
    title: '查看学习目标', name: 'agenda', callId: 'self_call', invocationId: claim.run.id, input: '{"action":"goals.read"}',
    agendaRunId: claim.run.id, leaseToken: claim.leaseToken };
  return { room, claim, command };
}

it('binds a real message invocation and creates one durable child process without another message bubble', () => {
  const { room, reply, source, command } = messageCall(), before = store.messages({ conversationId: room.id }).messages.length;
  const action = store.request(command).action!;
  expect(action).toMatchObject({ companionId: 'alice', conversationId: room.id, parentMessageId: reply.id, sourceMessageId: source.id,
    status: 'running', canResume: false, capability: { name: 'agenda', invocationId: source.id + ':alice', callId: 'actual_call', audience: 'conversation' } });
  expect(action.events?.[0]).toMatchObject({ type: 'capability.started', contentKind: 'input', content: command.input });
  expect(store.messages({ conversationId: room.id }).messages).toHaveLength(before);
  expect(store.request({ type: 'actions.invocation', companionId: 'alice', conversationId: room.id, parentMessageId: reply.id }).actions?.map(item => item.id)).toContain(action.id);
});

it('replays the same capability identity but rejects input or capability substitution', () => {
  const { command } = messageCall(), action = store.request(command).action!;
  expect(store.request(command).action!.id).toBe(action.id);
  expect(() => store.request({ ...command, input: '{"action":"rule.control"}' })).toThrow('原输入');
  expect(() => store.request({ ...command, name: 'observe' })).toThrow('原输入');
});

it('rejects foreign ports, missing source, invalid parent ownership and stale autonomous leases', () => {
  const { command } = messageCall(), other = store.openPrivate('bob');
  const foreign = store.appendMessage({ conversationId: other.id, authorId: 'user', content: '另一位伙伴的真实消息。' });
  expect(() => store.request({ ...command, sourceMessageId: foreign.id })).toThrow('不属于当前聊天');
  expect(() => store.request({ ...command, parentMessageId: foreign.id })).toThrow('真实消息');
  expect(() => store.request({ ...command, sourceMessageId: undefined })).toThrow('真实消息');
  expect(() => store.request({ ...command, companionId: 'bob' })).toThrow('聊天');
  const self = autonomousCall();
  expect(() => store.request({ ...self.command, leaseToken: 'wrong_lease' })).toThrow('有效执行');
  expect(() => store.request({ ...self.command, agendaRunId: 'invented_run' })).toThrow('有效执行');
});

it('keeps autonomous capability work within its parent slot and out of automatic memory evidence', () => {
  store.request({ type: 'tasks.concurrency.set', companionId: 'alice', limit: 1 });
  const { room, command, claim } = autonomousCall(), scope = { companionId: 'alice', conversationId: room.id };
  const before = store.request({ type: 'memory.status', ...scope }).memoryStatus!;
  const action = store.request(command).action!;
  expect(store.request({ type: 'tasks.concurrency.get', companionId: 'alice' }).taskConcurrency!.policies[0]).toMatchObject({ active: 1, queued: 0 });
  expect(() => store.request({ type: 'tasks.capacity.claim-action', id: action.id })).toThrow('子步骤');
  expect(() => store.request({ type: 'action.resume', id: action.id })).toThrow();
  store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: '实际查询已完成。' } });
  const cards = store.messages({ conversationId: room.id }).messages.filter(message => message.actionId === action.id);
  expect(cards).toHaveLength(0);
  expect(store.getAction(action.id).capability?.audience).toBe('agenda');
  expect(store.request({ type: 'memory.sources.filter', ...scope, ids: cards.map(card => card.id) }).memorySources).toEqual([]);
  expect(store.request({ type: 'memory.status', ...scope }).memoryStatus!.pending).toBe(before.pending);
  expect(store.request({ type: 'agenda.run.read', companionId: 'alice', id: claim.run.id }).agendaRun!.status).toBe('running');
  expect(store.request({ type: 'tasks.concurrency.get', companionId: 'alice' }).taskConcurrency!.policies[0]!.active).toBe(1);
});

it('preserves explicit cancellation when a late capability result returns', () => {
  const { command } = messageCall(), action = store.request(command).action!;
  const cancelled = store.request({ type: 'action.update', id: action.id, patch: { status: 'cancelled', error: '用户已停止本次能力。' } }).action!;
  const late = store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: '迟到结果' } }).action!;
  expect(late).toMatchObject({ status: 'cancelled', error: cancelled.error, canResume: false, finishedAt: cancelled.finishedAt });
  expect(late.result).toBeUndefined(); expect(store.request(command).action!.status).toBe('cancelled');
});

it('looks up only the exact indexed own-port native think receipt and rejects ambiguous bindings', () => {
  const { room, command } = messageCall(), taskId = '11111111-1111-4111-8111-111111111111';
  const lookup: Extract<CompanionStorageCommand, { type: 'capability.for-task' }> = { type: 'capability.for-task', companionId: 'alice', conversationId: room.id, taskId };
  expect(store.request(lookup).action).toBeUndefined();
  const unrelated = store.request({ ...command, callId: 'ordinary_capability' }).action!;
  store.request({ type: 'action.update', id: unrelated.id, patch: { taskId, status: 'succeeded', result: '普通能力没有原生think读取权。' } });
  expect(store.request(lookup).action).toBeUndefined();
  const thinkCommand = { ...command, name: 'think', callId: 'actual_think_call', title: '思考实际问题', input: '{"question":"核对实际资料的限制"}' };
  const thought = store.request(thinkCommand).action!;
  store.request({ type: 'action.update', id: thought.id, patch: { taskId, status: 'succeeded', result: '真实原生任务已返回。' } });
  expect(store.request(lookup).action).toMatchObject({ id: thought.id, companionId: 'alice', conversationId: room.id, taskId, canResume: false, capability: { name: 'think' } });
  expect(store.request({ ...lookup, taskId: 'another_native_task' }).action).toBeUndefined();
  const bob = store.openPrivate('bob'), group = store.createConversation('另一个实际端口', ['alice']);
  expect(store.request({ ...lookup, companionId: 'bob', conversationId: bob.id }).action).toBeUndefined();
  expect(store.request({ ...lookup, conversationId: group.id }).action).toBeUndefined();
  expect(() => store.request({ ...lookup, companionId: 'bob' })).toThrow('聊天');
  const Database = BetterSqlite3 as { new(filename: string, options: { readonly: boolean }): Pick<CompanionConnection, 'prepare' | 'close'> };
  const read = new Database(path.join(root, 'messages.sqlite'), { readonly: true });
  try {
    const plan = read.prepare("EXPLAIN QUERY PLAN SELECT id FROM actions WHERE companion_id=? AND conversation_id=? AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.capability.name')='think' LIMIT 2")
      .all('alice', room.id, taskId) as Array<{ detail: string }>;
    expect(plan.map(item => item.detail).join('\n')).toMatch(/SEARCH actions USING INDEX actions_capability_task/u);
  } finally { read.close(); }
  const duplicate = store.request({ ...thinkCommand, callId: 'duplicate_think_call' }).action!;
  store.request({ type: 'action.update', id: duplicate.id, patch: { taskId, status: 'succeeded' } });
  expect(() => store.request(lookup)).toThrow('多项能力过程');
});

it('verifies real message memory and autonomous agenda capability evidence without requiring a legacy DSH checkpoint', async () => {
  const { room, source, reply, command } = messageCall();
  const call = { id: 'actual_memory_call', name: 'memory', arguments: '{"action":"status"}' };
  store.request({ type: 'loop.save', checkpoint: { companionId: 'alice', conversationId: room.id, sourceMessageId: source.id,
    messageId: reply.id, status: 'running', turns: [{ text: '', rawText: '', calls: [call] }], supplements: [] } });
  const memory = store.request({ ...command, name: call.name, callId: call.id, input: call.arguments, invocationId: source.id + ':alice', title: '核对自己的记忆状态' }).action!;
  const calls: CompanionStorageCommand[] = [];
  const request = async (input: CompanionStorageCommand) => { calls.push(input); return store.request(input); };
  expect(await verifyCompanionCapabilityEvidence(memory, { request })).toBe(true);
  expect(calls.some(input => input.type === 'loop.for-message')).toBe(true);
  expect(calls.some(input => input.type === 'memory.sources.filter')).toBe(true);
  expect(calls.some(input => input.type.startsWith('checkpoint.'))).toBe(false);
  const self = autonomousCall(), agenda = store.request(self.command).action!; calls.splice(0);
  expect(await verifyCompanionCapabilityEvidence(agenda, { request })).toBe(true);
  expect(calls).toContainEqual({ type: 'agenda.run.read', companionId: 'alice', id: self.claim.run.id });
  expect(calls.some(input => input.type.startsWith('checkpoint.'))).toBe(false);
});

it('keeps the actual autonomous capability message visible through the full history guard while running and after completion', async () => {
  const { room, command } = autonomousCall(), action = store.request(command).action!;
  // A pre-fix host wrote a standalone autonomous action bubble. Direct agenda
  // detail reads still validate its provenance; the chat page omits the bubble.
  const card = store.appendMessage({ conversationId: room.id, authorId: 'alice', kind: 'action', actionId: action.id, content: action.title, clientId: 'legacy-card-' + action.id });
  const calls: CompanionStorageCommand[] = [];
  const request = async (input: CompanionStorageCommand) => { calls.push(input); return store.request(input); };
  const read = { type: 'message.get', id: card.id } as const;
  const check = () => guardCompanionExecutionSources(read, store.request(read), { storage: request,
    valid: proof => verifyCompanionCapabilityEvidence(proof, { request }) });
  const proof = store.request({ type: 'execution.sources', sourceMessageIds: [card.id] }).executionSources![0]!;
  expect(proof).toMatchObject({ kind: 'action', id: action.id, capability: action.capability });
  expect(proof.executionReadset).toBeUndefined();
  for (const completed of [false, true]) {
    if (completed) store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: '已核对实际日程。' } });
    expect((await check()).message).toMatchObject({ id: card.id, content: card.content });
    expect((await check()).message?.sourceUnavailable).toBeUndefined();
    expect(store.getAction(action.id).contentAvailable).not.toBe(false);
  }
  expect(calls.some(input => input.type === 'execution.invalidate')).toBe(false);
  expect(store.messages({ conversationId: room.id }).messages.some(message => message.id === card.id)).toBe(false);
  expect(store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: room.id, ids: [card.id] }).memorySources).toEqual([]);
});

it('still withdraws a real autonomous capability presentation when its bound authority is revoked', async () => {
  const { room, command, claim } = autonomousCall();
  const grant = store.request({ type: 'agenda.grant.configure', companionId: 'alice', operationId: 'actual_scope', authority: { kind: 'user' },
    grant: { title: '本次本人范围', capabilities: ['files.deliver'], fileRoots: [], outputRoots: [], windowIds: [], captureSources: [], allowPublicWeb: false } }).agendaGrant!;
  store.request({ type: 'agenda.run.bindGrant', companionId: 'alice', id: claim.run.id, leaseToken: claim.leaseToken, now: at, grantId: grant.id, grantRevision: grant.revision });
  const action = store.request(command).action!, card = store.appendMessage({ conversationId: room.id, authorId: 'alice', kind: 'action', actionId: action.id, content: action.title, clientId: 'legacy-card-' + action.id });
  store.request({ type: 'agenda.grant.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision, operationId: 'revoke_actual_scope', authority: { kind: 'user' } });
  const request = async (input: CompanionStorageCommand) => store.request(input), read = { type: 'message.get', id: card.id } as const;
  const result = await guardCompanionExecutionSources(read, store.request(read), { storage: request,
    valid: proof => verifyCompanionCapabilityEvidence(proof, { request }) });
  expect(result.message).toMatchObject({ id: card.id, content: '', sourceUnavailable: 'execution_source_changed' });
  expect(store.getAction(action.id).contentAvailable).toBe(false);
});

it('isolates old autonomous tool bubbles from chat pages, search, unread and recent previews without erasing the agenda ledger', () => {
  const { room, command } = messageCall(), before = store.state().conversations.find(conversation => conversation.id === room.id)!;
  const autonomous = autonomousCall(), action = store.request({ ...autonomous.command, name: command.name, title: command.title }).action!;
  expect(store.getAction(action.id).capability?.audience).toBe('agenda');
  vi.setSystemTime(new Date(Date.parse(at) + 3600000));
  const card = store.appendMessage({ conversationId: room.id, authorId: 'alice', kind: 'action', actionId: action.id, content: 'BACKGROUND_ONLY_SCOPE_RECEIPT', clientId: 'legacy-background-card' });
  expect(store.getMessage(card.id).audience).toBe('agenda');
  expect(() => store.messages({ conversationId: room.id, around: card.id })).toThrow('日程中查看');
  const page = store.messages({ conversationId: room.id, limit: 1 });
  expect(page.messages).toHaveLength(1); expect(page.messages[0]!.id).not.toBe(card.id); expect(page.hasNewer).toBe(false);
  expect(store.search({ conversationId: room.id, query: 'BACKGROUND_ONLY_SCOPE_RECEIPT', category: 'all', limit: 10 }).messages).toEqual([]);
  const current = store.state().conversations.find(conversation => conversation.id === room.id)!;
  expect(current).toMatchObject({ lastMessage: before.lastMessage, unread: before.unread, updatedAt: before.updatedAt });
  expect(store.request({ type: 'actions', conversationId: room.id }).actions?.some(item => item.id === action.id && item.capability?.audience === 'agenda')).toBe(true);
  expect(store.request({ type: 'agenda.run.read', companionId: 'alice', id: autonomous.claim.run.id }).agendaRun).toBeDefined();
});

it('keeps a real current-conversation capability visible before its reply bubble is mounted and with the source outside the loaded page', () => {
  const room = store.openPrivate('alice'), source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '请核对我这条请求的日程。', replyDirective: 'none' });
  store.request({ type: 'loop.save', checkpoint: { companionId: 'alice', conversationId: room.id, sourceMessageId: source.id, status: 'running', turns: [], supplements: [] } });
  const action = store.request({ type: 'capability.begin', companionId: 'alice', conversationId: room.id, sourceMessageId: source.id,
    invocationId: source.id + ':alice', name: 'agenda', callId: 'before_reply', title: '查看当前请求的安排', input: '{"action":"read"}' }).action!;
  expect(action.capability?.audience).toBe('conversation');
  const page = store.messages({ conversationId: room.id, limit: 1 });
  expect(page.messages).toHaveLength(1); expect(page.messages[0]).toMatchObject({ actionId: action.id, audience: 'conversation', replyToId: source.id });
  expect(page.messages.some(message => message.id === source.id)).toBe(false);
  expect(() => store.request({ type: 'capability.begin', companionId: 'alice', conversationId: room.id, sourceMessageId: source.id,
    invocationId: 'invented_invocation', name: 'agenda', callId: 'forged_root', title: '伪造来源归属', input: '{}' })).toThrow('实际循环');
});

it('attributes group calls to the exact group source and owner loop rather than another private conversation', () => {
  const group = store.createConversation('群聊实际请求', ['alice', 'bob']), privateRoom = store.openPrivate('alice');
  const foreign = store.appendMessage({ conversationId: privateRoom.id, authorId: 'user', content: '仅属于私聊的请求。', replyDirective: 'none' });
  const source = store.appendMessage({ conversationId: group.id, authorId: 'bob', content: '请在这里核对我们的安排。', replyDirective: 'none' });
  store.request({ type: 'loop.save', checkpoint: { companionId: 'alice', conversationId: group.id, sourceMessageId: source.id, status: 'running', turns: [], supplements: [] } });
  const command = { type: 'capability.begin', companionId: 'alice', conversationId: group.id, sourceMessageId: source.id,
    invocationId: source.id + ':alice', name: 'agenda', callId: 'real_group_call', title: '核对本群请求的安排', input: '{"action":"read"}' } as const;
  const action = store.request(command).action!;
  expect(action.capability?.audience).toBe('conversation');
  expect(store.messages({ conversationId: group.id, limit: 1 }).messages[0]).toMatchObject({ actionId: action.id, audience: 'conversation' });
  expect(() => store.request({ ...command, sourceMessageId: foreign.id, invocationId: foreign.id + ':alice', callId: 'cross_room' })).toThrow('不属于当前聊天');
  expect(store.messages({ conversationId: privateRoom.id }).messages.some(message => message.actionId === action.id)).toBe(false);
});
