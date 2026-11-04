import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BotStore } from '../../src/main/companion-bot/store';
import type { BotMediaRef } from '../../src/shared/companion-bot-media';
import type { BotEvent } from '../../src/main/companion-bot/types';

let store: BotStore, root: string;
const file: BotMediaRef = { id: 'shared-file', name: 'source.txt', mimeType: 'text/plain', sha256: 'a'.repeat(64), size: 12, kind: 'file', url: 'worldlinebox://bot-media/file' };
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'wlb-media-lineage-')); store = new BotStore(path.join(root, 'bot.sqlite')); store.createCompanion({ id: 'alice', name: 'Alice', persona: 'A' }); store.createCompanion({ id: 'bob', name: 'Bob', persona: 'B' }); });
afterEach(() => { store.close(); if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-media-lineage-')) throw Error('Invalid lineage cleanup'); rmSync(root, { recursive: true, force: true }); });
function complete(event: BotEvent, content: string) {
  let claim = store.claim({ workerId: 'fixture' });
  while (claim && claim.event.id !== event.id) { store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: '其他伙伴确认' }); claim = store.claim({ workerId: 'fixture' }); }
  if (!claim) throw Error('Expected queued event'); return () => store.settle({ eventId: event.id, leaseToken: claim!.leaseToken, status: 'done', content });
}
it('pins one grant across forwarding, task staging, completed summaries and automatic replies; explicit user reattachment creates independent authority', () => {
  const group = store.createGroup({ title: '资料群', memberIds: ['alice', 'bob'] });
  const source = store.enqueue({ conversationId: group.id, senderId: 'user', sourceMessageId: 'original-file', content: '最初提供的资料', attachments: [file], recipientIds: ['alice'] }).events[0]!;
  complete(source, '收到资料')();
  const request = store.enqueue({ conversationId: group.id, senderId: 'user', sourceMessageId: 'later-request', content: '继续处理前面的资料', recipientIds: ['alice'] }).events[0]!;
  const settleRequest = complete(request, '已经委派');
  const grant = store.modelAttachmentGrants(request, { ids: [file.id] })[0]!, pin = { mediaId: file.id, grantId: grant.grantId };
  const active = store.createTask({ conversationId: group.id, companionId: 'alice', sourceEventId: request.id, goal: '已复制文件的任务', extra: { attachmentIds: [file.id], nativeAttempted: true }, attachmentGrants: [pin] });
  store.updateTask(active.id, { status: 'running' });
  const finished = store.createTask({ conversationId: group.id, companionId: 'alice', sourceEventId: request.id, goal: '产生完整摘要的任务', extra: { attachmentIds: [file.id] }, attachmentGrants: [pin] });
  const resent = store.publishForEvent(request.id, 'resend', { attachments: [file], attachmentGrants: [pin] });
  const peer = store.enqueue({ conversationId: group.id, senderId: 'alice', source: 'companion', sourceMessageId: 'forward-file', content: '', attachments: [file], attachmentGrants: [pin], sourceIds: store.eventSourceIds(request.id), recipientIds: ['bob'], causationId: request.id });
  store.finishTask(finished.id, { status: 'succeeded', summary: '机密的原文件分析结论' }, { conversationId: group.id, senderId: 'task-service', source: 'task', sourceMessageId: 'completed-task-notice', content: '机密的原文件分析结论', recipientIds: ['alice'], payload: { taskId: finished.id }, causationId: request.id });
  settleRequest();
  const notice = store.messagesPage(group.id).items.find(message => message.senderId === 'task-service')!, noticeEvent = store.taskTransaction(sql => sql.prepare('SELECT id FROM bot_inbox WHERE source_record_id=?').get(notice.id)) as { id: string };
  const automatic = store.getEvent(noticeEvent.id)!; complete(automatic, '主脑转述机密结论')();
  store.withdrawSources('alice', group.securityDomainId, [source.id]);
  expect(store.taskSourcesWithdrawn(active.id)).toBe(true); expect(store.taskSourcesWithdrawn(finished.id)).toBe(true);
  expect(() => store.publishForTask(active.id, 'late-file', { attachments: [file] })).toThrow('有效');
  expect(store.modelAttachments(request, { ids: [file.id] })).toEqual([]);
  const hidden = [resent.id, peer.message.id, notice.id, automatic.replyMessageId, request.replyMessageId];
  expect(store.withdrawnIn('alice', group.securityDomainId, hidden)).toEqual(new Set(hidden));
  const archived = store.withdrawnMessagesPage(request, {}).items.map(item => item.messageId); for (const id of hidden) expect(archived).toContain(id);
  const renewed = store.enqueue({ conversationId: group.id, senderId: 'user', sourceMessageId: 'explicit-new-share', content: '我现在重新提供同一文件', attachments: [file], recipientIds: ['alice'] }).events[0]!;
  const replacement = store.modelAttachmentGrants(renewed, { ids: [file.id] })[0]!; expect(replacement.grantId).not.toBe(pin.grantId);
  const newTask = store.createTask({ conversationId: group.id, companionId: 'alice', sourceEventId: renewed.id, goal: '使用新的明确授权', extra: { attachmentIds: [file.id] }, attachmentGrants: [{ mediaId: file.id, grantId: replacement.grantId }] });
  expect(store.taskSourcesWithdrawn(newTask.id)).toBe(false); expect(store.taskSourcesWithdrawn(active.id)).toBe(true);
});
it('uses append order for native withdrawal sync when an older UI message is forgotten later', () => {
  const conversation = store.openDirect('alice'), older = store.enqueue({ conversationId: conversation.id, senderId: 'user', recipientIds: [], content: '较早消息', sourceMessageId: 'old' }).message;
  const newer = store.enqueue({ conversationId: conversation.id, senderId: 'user', recipientIds: [], content: '较新消息', sourceMessageId: 'new' }).message;
  const scope = { companionId: 'alice', conversationId: conversation.id, securityDomainId: conversation.securityDomainId };
  store.withdrawSources('alice', scope.securityDomainId, [newer.id]); const first = store.withdrawnMessagesPage(scope, {}).items;
  store.withdrawSources('alice', scope.securityDomainId, [older.id]); const second = store.withdrawnMessagesPage(scope, { after: first.at(-1)!.sequence }).items;
  expect(second.map(item => item.messageId)).toEqual([older.id]); expect(second[0]!.sequence).toBeGreaterThan(first[0]!.sequence);
});
