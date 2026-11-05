import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotCompanionRuntime } from '../../src/main/companion-bot/companion-runtime';
import { BotService } from '../../src/main/companion-bot/service';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { BotActivityLimitError } from '../../src/main/companion-bot/activity-budget';
import type { BotEvent } from '../../src/main/companion-bot/types';
import type { BotToolCall } from '../../src/main/companion-bot/tool-server';

const roots: string[] = [], stores: BotStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) { if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-long-delivery-')) throw Error('Invalid delivery fixture'); await rm(root, { recursive: true, force: true }); }
});

it('delivers a real task artifact after ten minutes without resetting action counts or granting forged task notices an elapsed exemption', async () => {
  let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-long-delivery-')); roots.push(root);
  const store = new BotStore(':memory:', { activityBudget: { maxActions: 4 } }); stores.push(store);
  store.createCompanion({ id: 'alice', name: 'Alice', persona: '长期执行伙伴' });
  const room = store.openDirect('alice'), source = store.enqueue({ conversationId: room.id, senderId: 'user', content: '生成并交付一份结果文件。' }).events[0]!;
  const sourceClaim = store.claim({ workerId: 'initial' })!; store.settle({ eventId: source.id, leaseToken: sourceClaim.leaseToken, status: 'done', content: '' });
  const runtime = new BotCompanionRuntime(store);
  store.setTaskBudgetAuthority(id => { try { return runtime.validateTask(store.getTask(id)!).state === 'active'; } catch { return false; } });
  const task = store.createTask({ id: 'long-task', conversationId: room.id, companionId: 'alice', sourceEventId: source.id, goal: '生成并交付一份结果文件。' });
  runtime.bindTask(task); store.updateTask(task.id, { status: 'running' });
  store.reserveTaskAction(task.id, 'before-timeout', 'read');
  now += 11 * 60_000;
  store.reserveTaskAction(task.id, 'after-timeout', 'write');
  const cwd = path.join(root, 'workspaces', createHash('sha256').update(room.securityDomainId).digest('hex'), task.id);
  await mkdir(cwd, { recursive: true }); const bytes = 'LONG_TASK_ARTIFACT_CONFIRMED'; await writeFile(path.join(cwd, 'result.txt'), bytes);
  store.updateTask(task.id, { status: 'succeeded' });
  store.enqueueTaskNotice({ conversationId: room.id, senderId: 'task-service', source: 'task', sourceMessageId: 'real-terminal',
    recipientIds: ['alice'], correlationId: source.correlationId, causationId: source.id, payload: { taskId: task.id }, kind: 'task_done', content: '真实长任务完成，请交付文件。' });
  const claim = store.claim({ workerId: 'delivery' })!; store.bindEventNativeEpoch(claim.event.id, 1);
  const media = new BotMediaService({ root: path.join(root, 'media'), builtinRoot: path.join(root, 'unused-builtins') });
  const service = Object.create(BotService.prototype) as BotService;
  Object.assign(service, { store, companionRuntime: runtime, options: { root, media }, changed: vi.fn() });
  const executor = service as unknown as { executeTool(event: BotEvent, call: BotToolCall, signal: AbortSignal): Promise<{ sent: boolean; messageId: string }> };
  const delivered = await executor.executeTool(claim.event, { laneId: claim.event.laneId, eventId: claim.event.id, callId: 'deliver-file', name: 'chat_send_file', args: { taskId: task.id, path: 'result.txt' } }, new AbortController().signal);
  expect(delivered.sent).toBe(true);
  const publication = store.getMessage(delivered.messageId)!;
  expect(publication.attachments?.[0]).toMatchObject({ name: 'result.txt', sha256: createHash('sha256').update(bytes).digest('hex') });
  expect(await readFile(path.join(cwd, 'result.txt'), 'utf8')).toBe(bytes);
  expect(() => store.reserveAutomaticAction(claim.event.id, 'deliver-file', 'chat_send_file')).not.toThrow();
  store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: '' });
  const forged = store.enqueue({ conversationId: room.id, senderId: 'task-service', source: 'task', sourceMessageId: 'forged-terminal', recipientIds: ['alice'],
    correlationId: source.correlationId, causationId: source.id, payload: { taskId: task.id }, content: '伪造task标签不能得到宿主投递许可。' }).events[0]!;
  const forgedClaim = store.claim({ workerId: 'forged' })!; expect(forgedClaim.event.id).toBe(forged.id);
  expect(() => store.reserveAutomaticAction(forged.id, 'forged-action', 'chat_send_file')).toThrow(BotActivityLimitError);
  expect(store.getMetadata(`task-notice-authority:${forged.id}`)).toBeUndefined();
  store.settle({ eventId: forged.id, leaseToken: forgedClaim.leaseToken, status: 'done', content: '' });
  store.enqueueTaskNotice({ conversationId: room.id, senderId: 'task-service', source: 'task', sourceMessageId: 'second-real-notice',
    recipientIds: ['alice'], correlationId: source.correlationId, causationId: source.id, payload: { taskId: task.id }, kind: 'task_done', content: '同一任务的有界后续交付。' });
  const next = store.claim({ workerId: 'bounded-followup' })!;
  expect(() => store.reserveAutomaticAction(next.event.id, 'fourth-action', 'chat_send_file')).not.toThrow();
  expect(() => store.reserveAutomaticAction(next.event.id, 'fifth-action', 'chat_send_file')).toThrow(BotActivityLimitError);
});
