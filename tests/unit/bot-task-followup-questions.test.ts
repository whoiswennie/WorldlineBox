import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BotService } from '../../src/main/companion-bot/service';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';
import type { BotToolCall } from '../../src/main/companion-bot/tool-server';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
class Memory extends BotMemoryService {
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> { return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'followup', metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 }; }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async appendHistory() { return { archived: true }; }
  override async finishTurn() { return { recorded: true }; }
  override async close() {}
}
const questionId = (taskId: string) => 'question-' + createHash('sha256').update(`work-${taskId}:ask-format`).digest('hex').slice(0, 48);

it('binds a selected follow-up to its original question and refuses another waiting task, a rewritten question, bulk controls and new work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-followup-questions-'));
  const firstTask = 'first-waiting-task', selectedTask = 'selected-waiting-task', selectedQuestion = questionId(selectedTask);
  const host = vi.fn(async () => { throw Error('Controlled native worker boundary; no model or DSH is used by this protocol test.'); });
  let phase = 0, observedBinding: unknown, finalReply = false;
  let acceptedCall: BotToolCall | undefined;
  const failures: string[] = [];
  const toolErrors: Array<{ error?: string; executed?: boolean; allowed?: boolean; reason?: string }> = [];
  const model: BotAppBrain = new BotAppBrain({ root: path.join(root, 'router'), reconcileTool: (call, signal) => service.reconcileToolReceipt(call, signal), fetchFn: async (url, init) => {
    if (new URL(String(url)).pathname === '/bot/tool') {
      const call = JSON.parse(String(init!.body)) as BotToolCall;
      if (call.name === 'dsh_task_control' && call.args.operation === 'answer' && call.args.taskId === selectedTask && call.args.questionId === selectedQuestion) acceptedCall = call;
      return fetch(url, init);
    }
    const body = JSON.parse(String(init!.body)) as { messages: Array<{ role: string; content: string }> };
    const envelope = body.messages.filter(message => message.role === 'user').map(message => { try { return JSON.parse(message.content) as { trigger?: { taskFollowup?: unknown } }; } catch { return undefined; } }).findLast(value => value?.trigger?.taskFollowup);
    if (!envelope) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '本地协议夹具。' } }] });
    observedBinding = envelope.trigger!.taskFollowup;
    const call = (id: string, name: string, args: object) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const answers = [{ id: 'format', selected: ['正文'] }];
    if (phase++ === 0) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [
      call('wrong-task-answer', 'dsh_task_control', { operation: 'answer', taskId: firstTask, questionId: questionId(firstTask), answers }),
      call('wrong-task-cancel', 'dsh_task_control', { operation: 'cancel', taskId: firstTask }),
      call('wrong-question', 'dsh_task_control', { operation: 'answer', taskId: selectedTask, questionId: questionId(firstTask), answers }),
      call('bypass-question', 'dsh_task_control', { operation: 'send', taskId: selectedTask, text: '正文' }),
      call('wrong-bulk', 'dsh_task_control', { operation: 'cancel_all' }),
      call('wrong-new-work', 'dsh_task', { goal: '另建同目标任务', title: '重复任务' }),
    ] } }] });
    if (phase === 2) {
      for (const message of body.messages.filter(message => message.role === 'tool')) toolErrors.push(JSON.parse(message.content));
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [call('correct-original-answer', 'dsh_task_control', { operation: 'answer', taskId: selectedTask, questionId: selectedQuestion, answers })] } }] });
    }
    finalReply = true;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '已将正文选项交给你选中的原任务。' } }] });
  } });
  const service: BotService = new BotService({ root, brainRuntime: 'worldlinebox', brain: new BotBrainRouter({ app: model, worker: new BotDshBrain({ getHost: host }) }),
    memory: new Memory({ root: path.join(root, 'memory'), runtime: async () => { throw Error('No VCP fixture'); }, embedding: async () => { throw Error('No embedding fixture'); } }),
    model: () => ({ apiFormat: 'openai_chat', model: 'local-followup-protocol', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture-no-billing', contextWindow: 65536, maxTokens: 1024 }), onEvent: () => undefined, report: error => failures.push(error instanceof Error ? error.stack ?? error.message : String(error)) });
  cleanups.push(async () => { await service.shutdown(); if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-followup-questions-')) throw Error('Invalid fixture root'); await rm(root, { recursive: true, force: true }); });
  await service.handle({ type: 'state' }); service.store.createCompanion({ id: 'alice', name: 'Alice', persona: '只依据真实回执工作。' });
  const room = service.store.openDirect('alice'), tasks = new BotTaskRuntime(service.store);
  for (const id of [firstTask, selectedTask]) {
    const source = service.store.enqueue({ conversationId: room.id, senderId: 'user', sourceMessageId: 'seed-' + id, content: '整理一份只读报告。' }).events[0]!;
    const claim = service.store.claim({ workerId: 'seed' })!; expect(claim.event.id).toBe(source.id);
    service.store.settle({ eventId: source.id, leaseToken: claim.leaseToken, status: 'done', content: '' });
    const task = service.store.createTask({ id, conversationId: room.id, companionId: 'alice', sourceEventId: source.id, goal: '整理只读报告', extra: { workerAccess: 'full', nativeAttempted: true, retryAt: Date.now() + 60000 } });
    service.companionRuntime.bindTask(task);
    tasks.question(task, { questionId: questionId(id), callId: 'ask-format', questions: [{ id: 'format', question: '报告使用哪种格式？', options: [{ label: '表格' }, { label: '正文' }] }] });
    for (let notice = service.store.claim({ workerId: 'seed-notices' }); notice; notice = service.store.claim({ workerId: 'seed-notices' })) service.store.settle({ eventId: notice.event.id, leaseToken: notice.leaseToken, status: 'done', content: '' });
  }
  // Initial question notices are already observed in this fixture. The next
  // model input must be only the user's explicit selected-task follow-up.
  for (let claim = service.store.claim({ workerId: 'seed-notices' }); claim; claim = service.store.claim({ workerId: 'seed-notices' })) service.store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: '' });
  const sent = await service.handle({ type: 'message.send', conversationId: room.id, content: '选正文。', requestId: 'selected-answer', replyToTaskId: selectedTask });
  expect(sent.ok).toBe(true);
  const followup = service.store.taskTransaction(sql => sql.prepare('SELECT id FROM bot_inbox WHERE source_record_id=?').get(sent.messageId)) as { id: string };
  service.store.setMetadata(`skipCapture:${followup.id}`, 'true');
  const deadline = Date.now() + 10000;
  while (service.store.getEvent(followup.id)?.status !== 'done') {
    const event = service.store.getEvent(followup.id); if (event?.status === 'failed') throw Error(event.error + '\n' + failures.join('\n'));
    if (Date.now() > deadline) throw Error('Selected question protocol did not complete.');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  expect(observedBinding).toEqual({ taskId: selectedTask, questionId: selectedQuestion }); expect(finalReply).toBe(true);
  expect(toolErrors).toHaveLength(6); expect(toolErrors.slice(0, 5).every(result => typeof result.error === 'string' && result.executed === false)).toBe(true); expect(toolErrors[5]).toMatchObject({ allowed: false });
  expect(tasks.attention(firstTask)?.state).toBe('queued'); expect(service.store.getTask(firstTask)?.extra.cancelRequested).not.toBe(true);
  expect(tasks.answeredQuestions(selectedTask)).toMatchObject([{ questionId: selectedQuestion, answers: [{ id: 'format', selected: ['正文'] }] }]);
  expect(service.store.getTask(selectedTask)?.extra.pendingControls).toBeUndefined();
  expect(service.store.getEvent(followup.id)?.payload.taskFollowup).toEqual({ taskId: selectedTask });
  expect(service.store.taskTransaction(sql => sql.prepare('SELECT state FROM bot_task_followups WHERE task_id=? AND event_id=?').get(selectedTask, followup.id))).toEqual({ state: 'delivered' });
  // Fault injection: retain the real accepted question control but remove the
  // outer tool receipt and delivery mark, as if the process exited between them.
  service.store.taskTransaction(sql => {
    sql.prepare('DELETE FROM bot_metadata WHERE key=?').run(`effect:${acceptedCall!.eventId}:${acceptedCall!.callId}`);
    sql.prepare("UPDATE bot_task_followups SET state='queued' WHERE task_id=? AND event_id=?").run(selectedTask, followup.id);
  });
  expect(acceptedCall).toBeDefined(); expect(await service.reconcileToolReceipt(acceptedCall!)).toMatchObject({ state: 'committed', result: { accepted: true, questionId: selectedQuestion } });
  expect(tasks.answeredQuestions(selectedTask)).toHaveLength(1);
  expect(service.store.taskTransaction(sql => sql.prepare('SELECT state FROM bot_task_followups WHERE task_id=? AND event_id=?').get(selectedTask, followup.id))).toEqual({ state: 'delivered' });
  expect(service.store.listTasks(room.id).map(task => task.id).sort()).toEqual([firstTask, selectedTask].sort());
});
