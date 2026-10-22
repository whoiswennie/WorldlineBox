import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import { companionSearchTokens, companionSearchFacet } from '../../src/shared/companion-search';

const owned: { root: string; store: CompanionsStore }[] = [];
afterEach(() => { for (const item of owned.splice(0)) { item.store.close(); if (path.dirname(item.root) !== tmpdir() || !path.basename(item.root).startsWith('worldlinebox-collaboration-')) throw new Error('Unexpected fixture'); rmSync(item.root, { recursive: true, force: true }); } });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-collaboration-')), file = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(file, ['a', 'b', 'c'].map(id => ({ id, name: id, description: '', persona: '认真核验', avatar: 'sister', model: '', active: true, proactive: false })));
  owned.push({ root, store });
  const origin = store.openPrivate('a');
  store.appendMessage({ conversationId: origin.id, authorId: 'user', content: 'PRIVATE_A_ONLY_NOT_DELEGATED' });
  const source = store.appendMessage({ conversationId: origin.id, authorId: 'user', content: '请你处理数据，并请b独立用DSH核对这份结果。只在本次工作目录写产物。' });
  const create = () => store.request({ type: 'collaboration.create', companionId: 'a', conversationId: origin.id, sourceMessageId: source.id,
    title: '独立核验', goal: source.content, parentInvocationId: 'parent_goal', evidence: ['请b独立用DSH核对这份结果'],
    participants: [{ companionId: 'b', goal: '读取本次数据和结果，独立计算并写核验报告。只在本次工作目录写产物。' }], clientId: 'collaboration_call' }).collaboration!;
  const child = store.createConversation('B自己的独立任务', ['b']);
  const grant = create();
  const start = () => {
    store.request({ type: 'collaboration.respond', id: grant.id, companionId: 'b', decision: 'accept', reason: '我愿意独立检查这份指定数据。' });
    store.request({ type: 'collaboration.start', id: grant.id, companionId: 'b', invocationId: 'child_goal', conversationId: child.id });
  };
  return { root, file, store, origin, source, child, grant, create, start };
}

it('persists explicit grants without adding the invited partner to the private source conversation or leaking its other messages', () => {
  const f = fixture();
  expect(() => f.store.request({ type: 'memory.sources.filter', companionId: 'b', conversationId: f.origin.id, ids: [f.source.id] })).toThrow(/不是聊天成员/);
  const read = f.store.request({ type: 'collaboration.read', id: f.grant.id, companionId: 'b' }).collaboration!;
  expect(read.sourceContent).toBe(f.source.content); expect(JSON.stringify(read)).not.toContain('PRIVATE_A_ONLY');
  expect(f.create().id).toBe(f.grant.id);
  expect(() => f.store.request({ type: 'collaboration.read', id: f.grant.id, companionId: 'c' })).toThrow(/不属于/);
  expect(() => f.store.request({ type: 'collaboration.start', id: f.grant.id, companionId: 'b', invocationId: 'child_goal', conversationId: f.child.id })).toThrow(/亲自接受/);
});

it('finds a real collaborator when contact queries contain both their display name and ID', () => {
  const f = fixture();
  f.store.request({ type: 'companion.update', id: 'b', companion: { name: '周岚', description: '', persona: '独立核对', avatar: 'sister', model: '', proactive: false } });
  const result = f.store.request({ type: 'memory.world_query', companionId: 'a', conversationId: f.origin.id, category: 'contacts', query: '周岚 b', limit: 10 });
  expect(result.worldKnowledge?.items).toContainEqual(expect.objectContaining({ id: 'b', name: '周岚', source: 'contact_directory' }));
});

it('allows cross-port action and loop lineage only after the invited actor accepts and starts that exact grant', () => {
  const f = fixture();
  const action = { companionId: 'b', conversationId: f.child.id, sourceMessageId: f.source.id, title: '独立检查', status: 'running' as const };
  expect(() => f.store.createAction(action)).toThrow(/来源/);
  expect(() => f.store.createAction({ ...action, authorizationGrantId: f.grant.id })).toThrow(/不匹配/);
  f.start();
  expect(f.store.createAction({ ...action, authorizationGrantId: f.grant.id })).toMatchObject({ authorizationGrantId: f.grant.id, companionId: 'b' });
  expect(() => f.store.createAction({ ...action, companionId: 'c', authorizationGrantId: f.grant.id })).toThrow();
  const bubble = f.store.appendMessage({ conversationId: f.child.id, authorId: 'b', content: '', loopStep: 0 });
  const checkpoint: CompanionLoopCheckpoint = { ...action, authorizationGrantId: f.grant.id, sourceMessageId: f.source.id,
    messageId: bubble.id, invocationKey: 'child_slot', status: 'running', turns: [], supplements: [] };
  expect(f.store.request({ type: 'loop.save', checkpoint }).ok).toBe(true);
  expect(() => f.store.request({ type: 'loop.save', checkpoint: { ...checkpoint, authorizationGrantId: undefined } })).toThrow(/来源/);
});

it('admits delegated computer work with the original human source and keeps ordinary peer speech powerless', () => {
  const f = fixture(); f.start();
  const work = { type: 'world.work.begin' as const, companionId: 'b', conversationId: f.child.id, workId: 'delegated_work', kind: 'action' as const, sourceMessageId: f.source.id };
  expect(() => f.store.request(work)).toThrow(/用户来源|不是聊天成员/);
  expect(() => f.store.request({ ...work, authorizationGrantId: f.grant.id, invocationId: 'wrong_goal' })).toThrow(/不匹配/);
  expect(() => f.store.request({ ...work, authorizationGrantId: f.grant.id, invocationId: 'child_goal', fixed: true })).toThrow(/不能借此扩大/);
  expect(f.store.request({ ...work, authorizationGrantId: f.grant.id, invocationId: 'child_goal' }).worldWork).toMatchObject({ workId: work.workId, companionId: 'b' });
  f.store.request({ type: 'collaboration.cancel', id: f.grant.id, companionId: 'a', reason: '本次原目标停止。' });
  expect(() => f.store.request({ ...work, authorizationGrantId: f.grant.id, invocationId: 'child_goal' })).toThrow(/已取消/);
});

it('finishes only after the actual delegated brain final and its same-grant successful DSH actions', () => {
  const f = fixture(); f.start();
  const bubble = f.store.appendMessage({ conversationId: f.child.id, authorId: 'b', content: '', loopStep: 0 });
  const final = '已实际读取数据并独立核对，核验报告符合原目标。';
  const checkpoint: CompanionLoopCheckpoint = { companionId: 'b', conversationId: f.child.id, sourceMessageId: f.source.id,
    authorizationGrantId: f.grant.id, messageId: bubble.id, invocationKey: 'child_slot', status: 'running', supplements: [],
    context: { system: '稳定身份', user: JSON.stringify({ invocation: { id: 'child_goal', kind: 'collaboration', goal: f.grant.participants[0]!.goal,
      companionId: 'b', conversationId: f.child.id, parentInvocationId: f.grant.parentInvocationId,
      authorization: { externalActions: true, grantId: f.grant.id, sourceMessageIds: [f.source.id] } } }) },
    turns: [{ text: '', rawText: '', calls: [{ id: 'verify', name: 'dsh', arguments: '{"operation":"run","tasks":[]}' }], results: [{ callId: 'verify', content: '{}' }] }] };
  const action = f.store.createAction({ companionId: 'b', conversationId: f.child.id, sourceMessageId: f.source.id, title: '真实核验', status: 'running',
    authorizationGrantId: f.grant.id, parentMessageId: bubble.id, toolCallId: '0:verify:0' });
  f.store.updateAction(action.id, { status: 'succeeded', taskId: 'native_verification', result: '实际DSH结果。' });
  const complete = (actionIds: string[]) => f.store.request({ type: 'collaboration.complete', id: f.grant.id, companionId: 'b', invocationId: 'child_goal', goalSlot: 'child_slot', result: final, actionIds });
  f.store.request({ type: 'loop.save', checkpoint }); expect(() => complete([action.id])).toThrow(/完整主脑/);
  checkpoint.turns.push({ text: final, rawText: final, calls: [] }); checkpoint.status = 'done'; f.store.request({ type: 'loop.save', checkpoint });
  expect(() => complete([])).toThrow(/没有提供子任务证据/);
  expect(complete([action.id]).collaboration).toMatchObject({ status: 'completed', participants: [{ status: 'succeeded', invocationId: 'child_goal', actionIds: [action.id] }] });
});

function finishedBrain(f: ReturnType<typeof fixture>, calls: { id: string; tasks: number }[]) {
  f.start();
  const bubble = f.store.appendMessage({ conversationId: f.child.id, authorId: 'b', content: '', loopStep: 0 });
  const final = '独立核验完成，失败尝试与修复结果均已检查。';
  const checkpoint: CompanionLoopCheckpoint = { companionId: 'b', conversationId: f.child.id, sourceMessageId: f.source.id,
    authorizationGrantId: f.grant.id, messageId: bubble.id, invocationKey: 'child_slot', status: 'done', supplements: [],
    context: { system: '稳定身份', user: JSON.stringify({ invocation: { id: 'child_goal', kind: 'collaboration', companionId: 'b',
      conversationId: f.child.id, goal: f.grant.participants[0]!.goal, parentInvocationId: f.grant.parentInvocationId,
      authorization: { externalActions: true, grantId: f.grant.id, sourceMessageIds: [f.source.id] } } }) },
    turns: [...calls.map(call => ({ text: '', rawText: '', calls: [{ id: call.id, name: 'dsh',
      arguments: JSON.stringify({ operation: 'run', tasks: Array.from({ length: call.tasks }, () => ({ title: '核验', prompt: '独立核验' })) }) }],
    results: [{ callId: call.id, content: '{}' }] })), { text: final, rawText: final, calls: [] }] };
  f.store.request({ type: 'loop.save', checkpoint });
  const action = (slot: string, status: 'succeeded' | 'failed' | 'cancelled') => {
    const value = f.store.createAction({ companionId: 'b', conversationId: f.child.id, sourceMessageId: f.source.id,
      title: '实际执行尝试', status: 'running', authorizationGrantId: f.grant.id, parentMessageId: bubble.id, toolCallId: slot });
    return f.store.updateAction(value.id, { status, ...(status === 'succeeded' ? { taskId: `native_${value.id}`, result: '实际成功结果。' } : { error: '实际失败尝试。' }) });
  };
  const complete = (actionIds: string[]) => f.store.request({ type: 'collaboration.complete', id: f.grant.id, companionId: 'b',
    invocationId: 'child_goal', goalSlot: 'child_slot', result: final, actionIds });
  return { action, complete };
}

it('accepts a failed real attempt followed by a separately executed successful repair', () => {
  const f = fixture(), proof = finishedBrain(f, [{ id: 'first', tasks: 1 }, { id: 'repair', tasks: 1 }]);
  const failed = proof.action('0:first:0', 'failed'), repaired = proof.action('1:repair:0', 'succeeded');
  expect(proof.complete([failed.id, repaired.id]).collaboration?.participants[0]).toMatchObject({ status: 'succeeded', actionIds: [failed.id, repaired.id] });
});

it('rejects omitted DSH task slots even when another real task succeeded', () => {
  const f = fixture(), proof = finishedBrain(f, [{ id: 'parallel', tasks: 2 }]);
  const successful = proof.action('0:parallel:0', 'succeeded');
  expect(() => proof.complete([successful.id])).toThrow(/缺少实际结果的执行步骤/);
  const second = proof.action('0:parallel:1', 'succeeded');
  expect(proof.complete([successful.id, second.id]).collaboration?.status).toBe('completed');
});

it('rejects a final success claim when every actual DSH attempt failed or was cancelled', () => {
  const f = fixture(), proof = finishedBrain(f, [{ id: 'first', tasks: 1 }, { id: 'retry', tasks: 1 }]);
  const failed = proof.action('0:first:0', 'failed'), cancelled = proof.action('1:retry:0', 'cancelled');
  expect(() => proof.complete([failed.id, cancelled.id])).toThrow(/所有现实执行尝试均未成功/);
});

it('preserves a long real user authorization without expanding the delegated goal limit', () => {
  const f = fixture(), content = `${'上下文。'.repeat(5000)}请b核对。`;
  const source = f.store.appendMessage({ conversationId: f.origin.id, authorId: 'user', content });
  const grant = f.store.request({ type: 'collaboration.create', companionId: 'a', conversationId: f.origin.id,
    sourceMessageId: source.id, evidence: ['请b核对。'], title: '长消息中的明确委托', goal: '请b核对。',
    parentInvocationId: 'long_parent', participants: [{ companionId: 'b', goal: '核对指定结果。' }], clientId: 'long_source' }).collaboration!;
  expect(grant.sourceContent).toBe(content); expect(grant.sourceContent.length).toBeGreaterThan(16000);
});

it('revokes cross-port execution when the original user source changes or the participant declines', () => {
  const f = fixture();
  f.store.request({ type: 'collaboration.respond', id: f.grant.id, companionId: 'b', decision: 'decline', reason: '这次不接受。' });
  expect(() => f.start()).toThrow(/不能替换/);
  const db = new (Database as { new(file: string): CompanionConnection })(f.file);
  try { db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens); db.function('companion_search_facet', { deterministic: true }, companionSearchFacet); db.prepare('UPDATE messages SET content=? WHERE id=?').run('用户已撤回原任务。', f.source.id); } finally { db.close(); }
  expect(() => f.store.request({ type: 'collaboration.read', id: f.grant.id, companionId: 'b' })).toThrow(/授权已撤回/);
});

it('reads the same durable invitation from a new store and revokes old participant access after a full reset', async () => {
  const f = fixture();
  const reopened = new CompanionsStore(f.file, []);
  try { expect(reopened.request({ type: 'collaboration.read', id: f.grant.id, companionId: 'b' }).collaboration).toMatchObject({ id: f.grant.id, sourceMessageId: f.source.id }); }
  finally { reopened.close(); }
  f.start();
  const reset = f.store.request({ type: 'companion.reset', id: 'b', scope: 'all' }).reset!;
  f.store.request({ type: 'companion.reset.cleanup', id: 'b', jobId: reset.id });
  for (let step = 0; step < 20000; step++) {
    if (f.store.request({ type: 'companion.reset.status', id: 'b' }).reset?.status === 'completed') break;
    await f.store.advanceReset();
  }
  expect(f.store.request({ type: 'companion.reset.status', id: 'b' }).reset?.status).toBe('completed');
  expect(() => f.store.request({ type: 'collaboration.read', id: f.grant.id, companionId: 'b' })).toThrow(/权限已撤回/);
  expect(f.store.request({ type: 'collaboration.read', id: f.grant.id, companionId: 'a' }).collaboration?.participants[0]).toMatchObject({ status: 'cancelled', accessRevokedAt: expect.any(String) });
});
