import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';

const owned: Array<{ root: string; store: CompanionsStore }> = [];
afterEach(() => { for (const { root, store } of owned.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); } });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'companion-goal-completion-'));
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), [{ id: 'alice', name: 'Alice', description: '', persona: '核查实际结果。', model: '', avatar: 'sister', proactive: false, active: true }]);
  owned.push({ root, store });
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '生成报告，再复核其真实内容。', replyDirective: 'none' });
  const order = store.request({ type: 'work-order.create', ...scope, sourceMessageId: source.id, title: '生成并核验报告', instruction: source.content }).workOrder!;
  const claim = store.request({ type: 'work-order.claim' }).workOrderClaim!;
  const bubble = store.appendMessage({ conversationId: scope.conversationId, authorId: scope.companionId, content: '正在处理独立目标。', replyToId: source.id, replyDirective: 'none' });
  const checkpoint: CompanionLoopCheckpoint = { ...scope, sourceMessageId: source.id, messageId: bubble.id,
    invocationKey: 'goal_fixture', status: 'running', supplements: [], turns: [], context: { system: 'stable persona', user: JSON.stringify({ invocation: {
      id: order.id, kind: 'work', ...scope, goal: order.instruction, authorization: { externalActions: true, sourceMessageIds: [source.id] } } }) } };
  const action = (step: number, callId: string, status: 'succeeded' | 'failed' = 'succeeded') => {
    const result = store.createAction({ ...scope, sourceMessageId: source.id, title: '真实子步骤', status: 'running', parentMessageId: bubble.id, toolCallId: `${step}:${callId}:0` });
    store.updateAction(result.id, { taskId: 'native_task_' + step, status, ...(status === 'succeeded' ? { result: '实际执行结果。' } : { error: '第一次实际执行失败。' }) });
    return result.id;
  };
  const complete = (actionIds: string[]) => store.request({ type: 'work-order.complete', id: order.id, leaseToken: claim.leaseToken,
    goalInvocationId: order.id, goalSlot: 'goal_fixture', result: '已生成并核验报告。', actionIds });
  return { store, scope, source, order, checkpoint, action, complete };
}
it('does not complete a multi-step goal merely because its first DSH child succeeded', () => {
  const f = fixture(), id = f.action(0, 'generate');
  expect(() => f.complete([id])).toThrow(/记录不存在/);
  f.store.request({ type: 'loop.save', checkpoint: f.checkpoint });
  expect(() => f.complete([id])).toThrow(/不匹配/);
  expect(f.store.request({ type: 'work-order.list', ...f.scope, includeHistory: true }).workOrderPage!.items[0]!.status).toBe('running');
});
it('accepts the final brain decision only with children bound to the same owner, invocation bubble and actual calls', () => {
  const f = fixture(), first = f.action(0, 'generate'), second = f.action(1, 'verify');
  f.checkpoint.turns = [
    { text: '', rawText: '', calls: [{ id: 'generate', name: 'dsh', arguments: '{"operation":"run","tasks":[]}' }], results: [{ callId: 'generate', content: '{}' }] },
    { text: '', rawText: '', calls: [{ id: 'verify', name: 'dsh', arguments: '{"operation":"run","tasks":[]}' }], results: [{ callId: 'verify', content: '{}' }] },
    { text: '已生成并核验报告。', rawText: '已生成并核验报告。', calls: [] },
  ]; f.checkpoint.status = 'done'; f.store.request({ type: 'loop.save', checkpoint: f.checkpoint });
  expect(() => f.complete([])).toThrow(/没有提供子任务证据/);
  expect(() => f.complete([first])).toThrow(/缺少实际结果/);
  expect(f.complete([first, second]).workOrder).toMatchObject({ status: 'completed', result: '已生成并核验报告。' });
  expect(f.complete([first, second]).workOrder?.completionMessageId).toBeDefined();
});
it('keeps failed attempts as evidence and permits an actually successful repair before the final review', () => {
  const f = fixture(), failed = f.action(0, 'first', 'failed'), repair = f.action(1, 'repair');
  f.checkpoint.turns = [
    { text: '', rawText: '', calls: [{ id: 'first', name: 'dsh', arguments: '{"operation":"run","tasks":[{}]}' }] },
    { text: '', rawText: '', calls: [{ id: 'repair', name: 'dsh', arguments: '{"operation":"run","tasks":[{}]}' }] },
    { text: '已生成并核验报告。', rawText: '已生成并核验报告。', calls: [] },
  ]; f.checkpoint.status = 'done'; f.store.request({ type: 'loop.save', checkpoint: f.checkpoint });
  expect(f.complete([failed, repair]).workOrder?.status).toBe('completed');
});

it('keeps all 130 same-invocation receipts for final proof beyond the bounded recent actions list', () => {
  const f = fixture(), ids = Array.from({ length: 130 }, (_, step) => f.action(step, 'step_' + step));
  f.checkpoint.turns = ids.map((id, step) => ({ text: '', rawText: '', calls: [{ id: 'step_' + step, name: 'dsh',
    arguments: '{"operation":"run","tasks":[{}]}' }], results: [{ callId: 'step_' + step, content: JSON.stringify({ id, status: 'succeeded' }) }] }));
  f.checkpoint.turns.push({ text: '已生成并核验报告。', rawText: '已生成并核验报告。', calls: [] });
  f.checkpoint.status = 'done'; f.store.request({ type: 'loop.save', checkpoint: f.checkpoint });
  expect(f.store.listAction(f.scope.conversationId)).toHaveLength(100);
  const archive = f.store.request({ type: 'actions.invocation', ...f.scope, parentMessageId: f.checkpoint.messageId! }).actions!;
  expect(archive).toHaveLength(130); expect(new Set(archive.map(action => action.id))).toEqual(new Set(ids));
  expect(f.complete(archive.map(action => action.id)).workOrder).toMatchObject({ status: 'completed', actionIds: ids });
});
