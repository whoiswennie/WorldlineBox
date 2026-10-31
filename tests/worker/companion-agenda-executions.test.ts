import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { companionAgendaExecution } from '../../src/shared/companion-agenda-execution';
import { companionAgendaModelView } from '../../src/main/companions/agenda-model-view';

let root: string, store: CompanionsStore;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'companion-agenda-executions-'));
  store = new CompanionsStore(path.join(root, 'messages.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, persona: '核对真实任务。', description: '', model: '', avatar: 'sister', proactive: false })));
});
afterEach(() => { store.close(); if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-agenda-executions-')) throw Error('Unexpected fixture path'); rmSync(root, { recursive: true, force: true }); });
function action(owner = 'alice', conversationId = store.openPrivate(owner).id) {
  const source = store.appendMessage({ conversationId, authorId: 'user', content: '实际学习一下这个视频。' });
  return store.createAction({ companionId: owner, conversationId, sourceMessageId: source.id, title: '分析实际视频', status: 'queued' });
}
it('shows a real action immediately without a second agenda rule and reflects subsequent real status and approval changes', () => {
  const created = action();
  const read = () => store.request({ type: 'agenda.tasks.read', companionId: 'alice', limit: 50 });
  expect(read().agendaTasks).toEqual([{ form: 'execution', execution: expect.objectContaining({ id: created.id, status: 'queued', title: '分析实际视频' }) }]);
  store.request({ type: 'action.update', id: created.id, patch: { status: 'running', stage: '核对字幕与画面' } });
  expect(read().agendaTasks![0]).toMatchObject({ execution: { id: created.id, status: 'running', stage: '核对字幕与画面' } });
  store.request({ type: 'action.update', id: created.id, patch: { events: [{ sequence: 1, type: 'approval_required', summary: '等待确认', receivedAt: new Date().toISOString(),
    content: JSON.stringify({ requestId: 'actual_approval', reason: '需要启动浏览器。' }) }] } });
  expect(read().agendaTasks![0]).toMatchObject({ execution: { status: 'running', waitingApproval: true, stage: '等待你确认执行权限。' } });
  const agenda = store.request({ type: 'agenda.read', companionId: 'alice', limit: 50 }).agenda!;
  expect(agenda.rules.some(rule => rule.referenceId === created.id)).toBe(false);
  store.request({ type: 'action.update', id: created.id, patch: { status: 'succeeded', result: '实际结果。' } });
  expect(read().agendaTasks).toEqual([]);
  expect(store.request({ type: 'agenda.tasks.read', companionId: 'alice', executionStatus: 'ended', limit: 50 }).agendaTasks![0]).toMatchObject({ execution: { id: created.id, status: 'succeeded' } });
});
it('keeps native capability traces out of the real task list', () => {
  const created = action(), source = store.getMessage(created.sourceMessageId!);
  const reply = store.appendMessage({ conversationId: source.conversationId, authorId: 'alice', content: '', replyToId: source.id, loopStep: 0 });
  store.request({ type: 'loop.save', checkpoint: { companionId: 'alice', conversationId: source.conversationId, sourceMessageId: source.id,
    messageId: reply.id, status: 'running', turns: [], supplements: [] } });
  const trace = store.request({ type: 'capability.begin', companionId: 'alice', conversationId: source.conversationId,
    title: '查看任务', name: 'agenda', callId: 'actual_read_call', invocationId: source.id + ':alice', input: '{"action":"tasks.read"}',
    sourceMessageId: source.id, parentMessageId: reply.id, loopStep: 0 }).action!;
  const items = store.request({ type: 'agenda.tasks.read', companionId: 'alice', limit: 50 }).agendaTasks!;
  expect(items.flatMap(task => task.form === 'execution' ? [task.execution.id] : [])).toEqual([created.id]);
  expect(JSON.stringify(items)).not.toContain(trace.id);
});
it('paginates all owner executions across private and group ports without silently using a recent history window', () => {
  const group = store.createConversation('真实讨论', ['alice', 'bob']);
  const ids = Array.from({ length: 105 }, (_, index) => action('alice', index % 2 ? group.id : store.openPrivate('alice').id).id);
  const foreign = action('bob');
  const seen: string[] = []; let afterId: string | undefined;
  do {
    const page = store.request({ type: 'agenda.tasks.read', companionId: 'alice', limit: 17, afterId });
    seen.push(...page.agendaTasks!.flatMap(task => task.form === 'execution' ? [task.execution.id] : []));
    afterId = page.agendaHasMore ? page.agendaNextId : undefined;
  } while (afterId);
  expect(new Set(seen).size).toBe(105); expect(seen.sort()).toEqual(ids.sort()); expect(seen).not.toContain(foreign.id);
  const privateActive = store.request({ type: 'actions.ongoing', companionId: 'alice', conversationId: store.openPrivate('alice').id }).actions!;
  expect(privateActive).toHaveLength(53); expect(privateActive.every(item => item.companionId === 'alice' && item.conversationId === store.openPrivate('alice').id)).toBe(true);
});
it('does not return completed history or capability processes when preparing unfinished goals', () => {
  const active = action(), ended = action(), other = action('bob');
  store.request({ type: 'action.update', id: ended.id, patch: { status: 'succeeded', result: '已完成的旧内容' } });
  const result = store.request({ type: 'actions.ongoing', companionId: 'alice', conversationId: active.conversationId });
  expect(result.actions?.map(item => item.id)).toEqual([active.id]);
  expect(JSON.stringify(result)).not.toContain('已完成的旧内容'); expect(result.actions?.map(item => item.id)).not.toContain(other.id);
  expect(() => store.request({ type: 'actions.ongoing', companionId: 'bob', conversationId: active.conversationId })).toThrow('成员');
});
it('preserves actual status while withholding invalid or cross-port task contents in the read projection', () => {
  const created = action(), hidden = companionAgendaExecution({ ...created, status: 'running', title: 'PRIVATE_target', contentAvailable: false, result: 'PRIVATE_output', canResume: true });
  expect(hidden).toMatchObject({ status: 'running', contentAvailable: false, canResume: false });
  expect(JSON.stringify(hidden)).not.toContain('PRIVATE_'); expect(hidden.sourceMessageId).toBeUndefined();
  const privateTask = companionAgendaExecution({ ...created, status: 'running', title: 'PRIVATE_target' });
  const result = companionAgendaModelView({ ok: true, agendaTasks: [{ form: 'execution', execution: privateTask }] }, { conversationId: 'unrelated_group', allowPrivate: false });
  expect(result.agendaTasks![0]).toMatchObject({ execution: { id: created.id, status: 'running', contentAvailable: false, taskId: undefined } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
});
