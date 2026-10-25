import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { recordUrgentAttention } from '../helpers/companion-world-fixture';
import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { companionPeerActivitySourceValid } from '../../src/companions/peer-activity-source';
import { buildCompanionSocialNotification } from '../../src/main/companions/social-notification-model';

const ids = ['deepseek-flash', 'phoebe', 'deepseek-sister'];
const seeds: CompanionSeed[] = ids.map(id => ({ id, name: id, persona: '保持独立身份。', description: '', model: '', avatar: 'flash', proactive: false }));
const roots: string[] = [], stores = new Set<CompanionsStore>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T10:00:00Z'); });
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-social-continuity-')) throw new Error('Unexpected continuity fixture path.');
    rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});
function advance(store: CompanionsStore, ms: number) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); }
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-social-continuity-')); roots.push(root);
  const filename = path.join(root, 'messages.sqlite'), store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true }))); stores.add(store);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const id of ids) {
    const scope = { companionId: id, conversationId: store.openPrivate(id).id }, routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } });
  }
  advance(store, 10000);
  const playerRoom = store.openPrivate('deepseek-flash');
  const source = store.appendMessage({ conversationId: playerRoom.id, authorId: 'user', content: '你去找菲比玩吧。PRIVATE_USER_DETAIL不得分享。', replyDirective: 'none' });
  const peer = store.request({ type: 'social.conversation.ensure', companionId: 'deepseek-flash', memberIds: ['deepseek-flash', 'phoebe'] }).socialConversation!;
  return { root, filename, store, playerRoom, source, peer };
}
function replied(f: ReturnType<typeof fixture>, content = '好呀，等你过来一起玩。', clientId = 'player_delegated_invitation') {
  const send = { type: 'social.send', companionId: 'deepseek-flash', conversationId: f.peer.id, channel: 'phone',
    content: '菲比，可以一起玩吗？', authorizationMessageId: f.source.id, clientId } as const;
  expect(f.store.request(send).socialPending).toBe(true); advance(f.store, 1300);
  const incoming = f.store.request({ type: 'social.job.claim' });
  expect(incoming.socialMessage!.message.authorId).toBe('deepseek-flash');
  const job = incoming.socialJob!;
  expect(job.companionId).toBe('phoebe'); expect(job.origin).toMatchObject({ initiatorId: 'user', initiatorKind: 'human_player', ownerId: 'deepseek-flash', sharedText: send.content });
  for (const secret of ['PRIVATE_USER_DETAIL', f.playerRoom.id, f.source.id]) expect(JSON.stringify(job)).not.toContain(secret);
  expect(companionStorageResponseSchema.safeParse(incoming).success).toBe(true);
  advance(f.store, 1300);
  const reply = f.store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: content }).socialMessage!;
  return { job, reply };
}
function secondReply(f: ReturnType<typeof fixture>, text = '我再找点茶，找到了再告诉你。') {
  const owner = f.store.request({ type: 'social.job.claim' }).socialJob!;
  expect(owner.companionId).toBe('deepseek-flash'); advance(f.store, 1300);
  f.store.request({ type: 'social.job.complete', id: owner.id, leaseToken: owner.leaseToken!, text: '好，我知道了。' });
  const peer = f.store.request({ type: 'social.job.claim' }).socialJob!;
  expect(peer.companionId).toBe('phoebe'); advance(f.store, 1300);
  return f.store.request({ type: 'social.job.complete', id: peer.id, leaseToken: peer.leaseToken!, text }).socialMessage!.message;
}
it('coalesces waiting replies from one delegation, commits one bubble and consumes every event exactly once', () => {
  const f = fixture(), { reply } = replied(f), second = secondReply(f);
  const claimed = f.store.request({ type: 'social.notification.claim' }), notice = claimed.socialNotification!;
  expect(companionStorageResponseSchema.safeParse(claimed).success).toBe(true);
  expect(notice.events?.map(event => event.eventId)).toEqual([reply.message.id, second.id]);
  const command = { type: 'social.notification.complete' as const, id: notice.id, leaseToken: notice.leaseToken!, text: '菲比说可以去玩，还会找点茶。' };
  const sent = f.store.request(command).message!;
  expect(f.store.request(command).message!.id).toBe(sent.id);
  expect(f.store.request({ type: 'social.notification.claim' }).socialNotification).toBeUndefined();
  expect(f.store.messages({ conversationId: f.playerRoom.id }).messages.filter(message => message.authorId === 'deepseek-flash')).toHaveLength(1);
});
it('delivers at most four exact quotations per batch and leaves the fifth real event available for its own delivery', () => {
  const f = fixture(), sourceIds: string[] = [];
  for (let index = 0; index < 5; index++) {
    sourceIds.push(replied(f, '这是第' + index + '条真实回复。', 'bounded_notice_' + index).reply.message.id);
    const followup = f.store.request({ type: 'social.job.claim' }).socialJob!;
    expect(followup.companionId).toBe('deepseek-flash'); advance(f.store, 1300);
    f.store.request({ type: 'social.job.complete', id: followup.id, leaseToken: followup.leaseToken!, text: null });
  }
  const deliver = (notice: NonNullable<ReturnType<typeof f.store.request>['socialNotification']>) => {
    const text = buildCompanionSocialNotification({ companion: { id: 'deepseek-flash' }, conversation: f.playerRoom, source: f.source,
      notification: notice, members: seeds, eventMessages: f.store.request({ type: 'social.messages', conversationId: f.peer.id }).socialMessagePage!.items.map(item => item.message) });
    const command = { type: 'social.notification.complete' as const, id: notice.id, leaseToken: notice.leaseToken!, text };
    const message = f.store.request(command).message!;
    expect(f.store.request(command).message!.id).toBe(message.id);
    expect(message.replyToId).toBe(f.source.id); return message;
  };
  const first = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(first.events?.map(event => event.eventId)).toEqual(sourceIds.slice(0, 4));
  const firstMessage = deliver(first); expect(firstMessage.content).not.toContain(sourceIds[4]);
  const second = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(second.events?.map(event => event.eventId)).toEqual(sourceIds.slice(4));
  expect(deliver(second).content).toContain(sourceIds[4]);
  expect(f.store.request({ type: 'social.notification.claim' }).socialNotification).toBeUndefined();
  expect(f.store.messages({ conversationId: f.playerRoom.id }).messages.filter(message => message.authorId === 'deepseek-flash')).toHaveLength(2);
});
it('claims only this human goal actual sent bodies and binds authority and real reads atomically without unrelated raw rooms', () => {
  const f = fixture(), { reply } = replied(f);
  const otherSource = f.store.appendMessage({ conversationId: f.playerRoom.id, authorId: 'user', content: '另一个独立目标', replyDirective: 'none' });
  const other = f.store.request({ type: 'social.conversation.ensure', companionId: 'deepseek-flash', memberIds: ['deepseek-flash', 'deepseek-sister'] }).socialConversation!;
  f.store.request({ type: 'social.send', companionId: 'deepseek-flash', conversationId: other.id, authorizationMessageId: otherSource.id,
    content: 'UNRELATED_ROOM_PRIVATE_CANARY', channel: 'phone', clientId: 'unrelated_goal_send' }); advance(f.store, 1500);
  const notice = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(notice.progressEvidence?.outbound).toHaveLength(1);
  expect(notice.progressEvidence?.outbound[0]).toMatchObject({ recipientIds: ['phoebe'], message: { content: '菲比，可以一起玩吗？', authorId: 'deepseek-flash' } });
  expect(JSON.stringify(notice)).not.toContain('UNRELATED_ROOM_PRIVATE_CANARY'); expect(JSON.stringify(notice)).not.toContain('PRIVATE_USER_DETAIL');
  const message = f.store.request({ type: 'social.notification.complete', id: notice.id, leaseToken: notice.leaseToken!, text: '菲比回复愿意一起玩，我先前发出了邀约。' }).message!;
  const Database = BetterSqlite3 as { new (filename: string, options: { readonly: true }): CompanionConnection };
  const db = new Database(f.filename, { readonly: true });
  try {
    const proof = JSON.parse((db.prepare('SELECT value FROM metadata WHERE key=?').get('message-execution-readset/' + message.id) as { value: string }).value);
    expect(proof.complete).toBe(true); expect(proof.sources).toContainEqual({ id: f.source.id, conversationId: f.source.conversationId, checksum: createHash('sha256').update(f.source.content).digest('hex') });
    expect(proof.sources.map((source: { id: string }) => source.id)).toContain(reply.message.id);
    expect(proof.sources.map((source: { id: string }) => source.id)).toContain(notice.progressEvidence!.outbound[0]!.message.id);
    const unrelated = f.store.request({ type: 'social.messages', conversationId: other.id }).socialMessagePage!.items.find(item => item.message.content === 'UNRELATED_ROOM_PRIVATE_CANARY');
    if (unrelated) expect(JSON.stringify(proof)).not.toContain(unrelated.message.id);
    expect(proof.sources.some((source: { checksum: string }) => source.checksum === createHash('sha256').update('').digest('hex'))).toBe(false);
  } finally { db.close(); }
  const sent = notice.progressEvidence!.outbound[0]!.message;
  f.store.request({ type: 'memory.forget', companionId: 'deepseek-flash', conversationId: sent.conversationId, sourceMessageIds: [sent.id] });
  expect(f.store.request({ type: 'memory.sources.filter', companionId: 'deepseek-flash', conversationId: f.playerRoom.id, ids: [message.id] }).memorySources).toEqual([]);
});
it('exposes own sent history only through the exact currently authorized task progress read', () => {
  const f = fixture(), scope = { companionId: 'deepseek-flash', conversationId: f.playerRoom.id };
  const task = f.store.request({ type: 'activity.start', ...scope, sourceMessageId: f.source.id,
    clientId: 'read_actual_goal_progress', title: '联系菲比', goal: f.source.content }).activityTask!;
  expect(f.store.request({ type: 'activity.progress', ...scope, id: task.id }).activityProgressEvidence?.outbound).toEqual([]);
  replied(f);
  const progress = f.store.request({ type: 'activity.progress', ...scope, id: task.id });
  expect(progress.activityProgressEvidence?.outbound).toHaveLength(1);
  const sent = progress.activityProgressEvidence!.outbound[0]!;
  expect(sent).toMatchObject({ recipientIds: ['phoebe'], message: { authorId: 'deepseek-flash', status: 'sent', content: '菲比，可以一起玩吗？' } });
  expect(companionStorageResponseSchema.safeParse(progress).success).toBe(true);
  expect(() => f.store.request({ type: 'activity.progress', companionId: 'phoebe', conversationId: f.store.openPrivate('phoebe').id, id: task.id })).toThrow('范围');
  f.store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [f.source.id] });
  const withdrawn = f.store.request({ type: 'activity.progress', ...scope, id: task.id });
  expect(withdrawn.activityTask?.historyAvailable).toBe(false);
  expect(withdrawn.activityProgressEvidence).toBeUndefined();
  expect(JSON.stringify(withdrawn)).not.toContain(sent.message.content);
});
it('defers a reviewed notification if the same human goal gains an actual durable executor before commit, without replaying its sent invitation', () => {
  const f = fixture(); replied(f);
  const notice = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  const task = f.store.request({ type: 'activity.start', companionId: 'deepseek-flash', conversationId: f.playerRoom.id,
    sourceMessageId: f.source.id, clientId: 'actual_new_goal_executor', title: '继续原目标', goal: f.source.content }).activityTask!;
  expect(task.status).toBe('queued');
  expect(f.store.request({ type: 'social.notification.complete', id: notice.id, leaseToken: notice.leaseToken!, text: '我只有原来一条邀约回执。' }).socialPending).toBe(true);
  const after = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(after.progressEvidence?.observationChecksum).not.toBe(notice.progressEvidence?.observationChecksum);
  const command = { type: 'social.notification.complete' as const, id: after.id, leaseToken: after.leaseToken!, text: '邀请已发出，原目标也已保存为持续任务，仍会按真实回复继续确认。' };
  const first = f.store.request(command).message!; expect(f.store.request(command).message?.id).toBe(first.id);
  expect(f.store.request({ type: 'social.messages', conversationId: f.peer.id }).socialMessagePage!.items.filter(item => item.message.content === '菲比，可以一起玩吗？')).toHaveLength(1);
});
it('regenerates against a late peer correction instead of publishing an obsolete invitation first', () => {
  const f = fixture(); replied(f, '可以来玩。');
  const owner = f.store.request({ type: 'social.job.claim' }).socialJob!; advance(f.store, 1300);
  f.store.request({ type: 'social.job.complete', id: owner.id, leaseToken: owner.leaseToken!, text: '我准备一下。' });
  const peer = f.store.request({ type: 'social.job.claim' }).socialJob!;
  const earlier = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(earlier.events).toHaveLength(1); advance(f.store, 1300);
  f.store.request({ type: 'social.job.complete', id: peer.id, leaseToken: peer.leaseToken!, text: '临时有事，现在不方便来了，改天约吧。' });
  expect(f.store.request({ type: 'social.notification.complete', id: earlier.id, leaseToken: earlier.leaseToken!, text: '菲比说可以过去玩。' }).socialPending).toBe(true);
  const latest = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(latest.events).toHaveLength(2); expect(latest.events?.at(-1)?.evidence.text).toContain('临时有事');
  f.store.request({ type: 'social.notification.complete', id: latest.id, leaseToken: latest.leaseToken!, text: '菲比刚临时有事，我们改天约。' });
  expect(f.store.messages({ conversationId: f.playerRoom.id }).messages.filter(message => message.authorId === 'deepseek-flash').map(message => message.content)).toEqual(['菲比刚临时有事，我们改天约。']);
});
it('passes the initial reply and already delivered progress into the next report, with no peer private history', () => {
  const f = fixture();
  const initial = f.store.appendMessage({ conversationId: f.playerRoom.id, authorId: 'deepseek-flash', content: '我先问问她方便不方便。' });
  replied(f);
  const first = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(first.dialogue?.map(message => message.id)).toEqual([initial.id]);
  const sent = f.store.request({ type: 'social.notification.complete', id: first.id, leaseToken: first.leaseToken!, text: '菲比说有空，可以过去一起玩。' }).message!;
  const second = secondReply(f);
  const next = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(next.events?.map(event => event.eventId)).toEqual([second.id]);
  expect(next.dialogue?.map(message => message.id)).toEqual([initial.id, sent.id]);
  expect(next.dialogue?.every(message => message.conversationId === f.playerRoom.id)).toBe(true);
  expect(JSON.stringify(next.dialogue)).not.toContain('PRIVATE_USER_DETAIL');
  for (let index = 0; index < 55; index++) f.store.appendMessage({ conversationId: f.playerRoom.id, authorId: 'user', content: `其它话题 ${index}`, replyDirective: 'none' });
  expect(f.store.request({ type: 'social.notification.complete', id: next.id, leaseToken: next.leaseToken!, text: '基于过期上下文的回报' }).socialPending).toBe(true);
  const afterLongChat = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(afterLongChat.dialogue?.map(message => message.id)).toContain(sent.id);
  expect(afterLongChat.dialogue).toHaveLength(50);
});
it('discards a stale report after the dialogue changes and can durably consume a redundant update without a bubble', () => {
  const f = fixture(); replied(f); const notice = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  const other = f.store.appendMessage({ conversationId: f.playerRoom.id, authorId: 'deepseek-flash', content: '菲比已经答应了，我们稍后见。' });
  expect(f.store.request({ type: 'social.notification.complete', id: notice.id, leaseToken: notice.leaseToken!, text: '菲比回话了，她答应了。' }).socialPending).toBe(true);
  expect(f.store.messages({ conversationId: f.playerRoom.id }).messages.map(message => message.content)).not.toContain('菲比回话了，她答应了。');
  const fresh = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(fresh.dialogue?.map(message => message.id)).toContain(other.id);
  const done = { type: 'social.notification.complete' as const, id: fresh.id, leaseToken: fresh.leaseToken!, text: null };
  expect(f.store.request(done).message).toBeUndefined(); expect(f.store.request(done).message).toBeUndefined();
  f.store.close(); stores.delete(f.store);
  const reopened = new CompanionsStore(f.filename, seeds); stores.add(reopened);
  expect(reopened.request({ type: 'social.notification.claim' }).socialNotification).toBeUndefined();
  expect(reopened.messages({ conversationId: f.playerRoom.id }).messages.filter(message => message.authorId === 'deepseek-flash')).toHaveLength(1);
});
it('releases every fact in a failed batch for a single retry after restart', () => {
  const f = fixture(); replied(f); secondReply(f);
  const notice = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  f.store.request({ type: 'social.notification.fail', id: notice.id, leaseToken: notice.leaseToken!, error: '网络暂时中断' });
  expect(f.store.request({ type: 'social.notification.claim' }).socialNotification).toBeUndefined();
  f.store.close(); stores.delete(f.store);
  const restarted = new CompanionsStore(f.filename, seeds); stores.add(restarted); advance(restarted, 20001);
  const retry = restarted.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(retry.events).toEqual(notice.events); expect(retry.leaseToken).not.toBe(notice.leaseToken);
  expect(() => restarted.request({ type: 'social.notification.complete', id: notice.id, leaseToken: notice.leaseToken!, text: '迟到结果' })).toThrow('租约');
  restarted.request({ type: 'social.notification.complete', id: retry.id, leaseToken: retry.leaseToken!, text: '一起玩并准备茶。' });
  expect(restarted.request({ type: 'social.notification.claim' }).socialNotification).toBeUndefined();
});
it('keeps a terminal failed notification batch failed across time and restart without publishing or automatically reclaiming it', () => {
  const f = fixture(); replied(f); secondReply(f);
  const notice = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  f.store.request({ type: 'social.notification.fail', id: notice.id, leaseToken: notice.leaseToken!, error: '实际容量不足，当前来源不可拆分', terminal: true });
  f.store.close(); stores.delete(f.store);
  const restarted = new CompanionsStore(f.filename, seeds); stores.add(restarted);
  for (let retry = 0; retry < 4; retry++) { advance(restarted, 900001); expect(restarted.request({ type: 'social.notification.claim' }).socialNotification).toBeUndefined(); }
  expect(restarted.messages({ conversationId: f.playerRoom.id }).messages.filter(message => message.authorId === 'deepseek-flash')).toEqual([]);
  expect(() => restarted.request({ type: 'social.notification.complete', id: notice.id, leaseToken: notice.leaseToken!, text: '不得作为成功交付' })).toThrow('租约');
});
it.each([false, true])('records genuine peer work atomically with the real publisher and receiver decision accept=%s, without player authority', accept => {
  const f = fixture(), content = '请帮我读一下我写的海边散文，整理三条修改建议。';
  const { reply } = replied(f, content), job = f.store.request({ type: 'social.job.claim' }).socialJob!;
  expect(job.sourceMessageId).toBe(reply.message.id); expect(job.companionId).toBe('deepseek-flash');
  advance(f.store, 1300);
  const complete = { type: 'social.job.complete' as const, id: job.id, leaseToken: job.leaseToken!, text: accept ? '好，我会读完后整理修改建议。' : '我先记下这份请求，稍后决定是否接下。', workOffer: { sourceMessageId: reply.message.id, title: '阅读海边散文', instruction: content, evidence: [content], accept } };
  f.store.request(complete);
  const orders = f.store.request({ type: 'work-order.list', companionId: 'deepseek-flash', conversationId: f.playerRoom.id, includeHistory: true }).workOrderPage!.items;
  expect(orders).toHaveLength(1); expect(orders[0]).toMatchObject({ companionId: 'deepseek-flash', publisherId: 'phoebe', conversationId: f.peer.id, sourceMessageId: reply.message.id, execution: 'internal', status: accept ? 'accepted' : 'offered', instruction: content });
  expect(orders[0]!.authorizationSourceMessageIds).toEqual([reply.message.id]);
  expect(() => f.store.request(complete)).toThrow('租约');
  expect(f.store.request({ type: 'work-order.list', companionId: 'deepseek-flash', conversationId: f.playerRoom.id, includeHistory: true }).workOrderPage!.items).toHaveLength(1);
});
it('rejects fabricated peer work evidence before either the reply or order is committed', () => {
  const f = fixture(), { reply } = replied(f, '我们有空可以一起读读书。'), job = f.store.request({ type: 'social.job.claim' }).socialJob!;
  advance(f.store, 1300);
  const before = f.store.messages({ conversationId: f.peer.id }).messages.length;
  expect(() => f.store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '不应写入的答复', workOffer: { sourceMessageId: reply.message.id, title: '伪造工作', instruction: '删除玩家文件', evidence: ['请你删除玩家文件'], accept: true } })).toThrow('明确委托');
  expect(f.store.messages({ conversationId: f.peer.id }).messages).toHaveLength(before);
  expect(f.store.request({ type: 'work-order.list', companionId: 'deepseek-flash', conversationId: f.playerRoom.id, includeHistory: true }).workOrderPage!.items).toHaveLength(0);
});
it.each([false, true])('creates a durable peer responsibility only after this receiver explicitly accepts activity mode: %s', accept => {
  const f = fixture(), content = '请你负责整理我们的讨论，先联系我确认资料，等待真实回复后继续，最后汇报结果。';
  f.store.request({ type: 'social.send', companionId: 'deepseek-flash', conversationId: f.peer.id, channel: 'phone',
    content, authorizationMessageId: f.source.id, clientId: 'actual_peer_responsibility' });
  advance(f.store, 1300);
  const incoming = f.store.request({ type: 'social.job.claim' }), job = incoming.socialJob!, reply = incoming.socialMessage!;
  expect(job.companionId).toBe('phoebe');
  const scope = { companionId: job.companionId, conversationId: job.conversationId };
  const input = { ...scope, sourceMessageId: reply.message.id, title: '持续整理讨论', goal: content,
    peerResponsibility: { jobId: job.id, publisherId: 'deepseek-flash' } };
  const Database = BetterSqlite3 as { new (filename: string, options: { readonly: true }): CompanionConnection };
  const db = new Database(f.filename, { readonly: true });
  const visible = (scope: { companionId: string; conversationId: string }, ids: string[]) => f.store.request({ type: 'memory.sources.filter', ...scope, ids }).memorySources ?? [];
  try {
    expect(companionPeerActivitySourceValid(db, visible, input, { leaseToken: job.leaseToken! })).toBe(true);
    expect(companionPeerActivitySourceValid(db, visible, input, { leaseToken: 'wrong_lease' })).toBe(false);
    expect(companionPeerActivitySourceValid(db, visible, { ...input, peerResponsibility: { jobId: job.id, publisherId: 'user' } }, { leaseToken: job.leaseToken! })).toBe(false);
    expect(companionPeerActivitySourceValid(db, visible, input)).toBe(false);
    advance(f.store, 1300);
    const complete = { type: 'social.job.complete' as const, id: job.id, leaseToken: job.leaseToken!, text: accept ? '我接下这份持续整理责任。' : '这份责任我暂不接下。',
      workOffer: { sourceMessageId: reply.message.id, title: input.title, instruction: content, evidence: [content], mode: 'activity' as const, accept } };
    f.store.request(complete);
    const tasks = f.store.request({ type: 'activity.list', ...scope }).activityTasks!;
    expect(tasks).toHaveLength(accept ? 1 : 0);
    expect(f.store.request({ type: 'work-order.list', ...scope, includeHistory: true }).workOrderPage!.items).toHaveLength(0);
    const stored = JSON.parse((db.prepare('SELECT data FROM companion_social_jobs WHERE id=?').get(job.id) as { data: string }).data);
    expect(stored.status).toBe('done');
    if (accept) {
      const task = tasks[0]!;
      expect(task).toMatchObject({ ...input, historyAvailable: true });
      expect(stored.acceptedActivity).toMatchObject({ taskId: task.id, sourceMessageId: reply.message.id, publisherId: 'deepseek-flash', title: input.title, instruction: content });
      expect(companionPeerActivitySourceValid(db, visible, task)).toBe(true);
      expect(companionPeerActivitySourceValid(db, visible, { ...task, goal: '替换成另一份责任' })).toBe(false);
      expect(companionPeerActivitySourceValid(db, visible, { ...task, id: 'foreign_task' })).toBe(false);
      expect(companionPeerActivitySourceValid(db, visible, { ...task, companionId: 'deepseek-flash' })).toBe(false);
      expect(() => f.store.request(complete)).toThrow('租约');
      const lastReply = f.store.request({ type: 'social.job.claim' }).socialJob!;
      expect(lastReply.companionId).toBe('deepseek-flash'); advance(f.store, 1300);
      f.store.request({ type: 'social.job.complete', id: lastReply.id, leaseToken: lastReply.leaseToken!, text: null });
      expect(companionPeerActivitySourceValid(db, visible, task)).toBe(true); // Natural dialogue end does not end the responsibility.
    } else expect(stored.acceptedActivity).toBeUndefined();
  } finally { db.close(); }
  f.store.close(); stores.delete(f.store);
  const restarted = new CompanionsStore(f.filename, seeds); stores.add(restarted);
  const tasks = restarted.request({ type: 'activity.list', ...scope }).activityTasks!;
  expect(tasks).toHaveLength(accept ? 1 : 0);
  if (accept) {
    expect(tasks[0]!.historyAvailable).toBe(true);
    restarted.request({ type: 'memory.forget', companionId: 'deepseek-flash', conversationId: f.playerRoom.id, sourceMessageIds: [f.source.id] });
    expect(restarted.request({ type: 'activity.get', ...scope, id: tasks[0]!.id }).activityTask?.historyAvailable).toBe(false);
  }
});
it('carries the actual human initiator across every peer turn and atomically returns one factual continuation despite proactive=false', () => {
  const f = fixture(), { reply } = replied(f);
  const next = f.store.request({ type: 'social.job.claim' }).socialJob!;
  expect(next.companionId).toBe('deepseek-flash'); expect(next.origin).toMatchObject({ initiatorId: 'user', ownerId: 'deepseek-flash', provenance: 'current_player_request' });
  advance(f.store, 1300); f.store.request({ type: 'social.job.complete', id: next.id, leaseToken: next.leaseToken!, text: null });
  const claimed = f.store.request({ type: 'social.notification.claim' }), notice = claimed.socialNotification!;
  expect(companionStorageResponseSchema.safeParse(claimed).success).toBe(true);
  expect(notice).toMatchObject({ companionId: 'deepseek-flash', conversationId: f.playerRoom.id, sourceMessageId: f.source.id,
    kind: 'peer_reply', eventId: reply.message.id, evidence: { authorId: 'phoebe', text: reply.message.content } });
  const complete = { type: 'social.notification.complete', id: notice.id, leaseToken: notice.leaseToken!, text: '菲比回复说可以一起玩，我还没有到她家。' } as const;
  const message = f.store.request(complete).message!;
  expect(message).toMatchObject({ authorId: 'deepseek-flash', conversationId: f.playerRoom.id, replyToId: f.source.id, content: complete.text });
  expect(f.store.request(complete).message!.id).toBe(message.id);
  expect(f.store.messages({ conversationId: f.playerRoom.id }).messages.filter(value => value.content === complete.text)).toHaveLength(1);
  expect(f.store.request({ type: 'social.notification.claim' }).socialNotification).toBeUndefined();
});
it('recovers the same event after a crashed lease without accepting a stale completion or overwriting an explicit opt-out', () => {
  const f = fixture(); replied(f);
  const before = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  f.store.close(); stores.delete(f.store); vi.setSystemTime(Date.now() + 180001);
  const store = new CompanionsStore(f.filename, seeds.map(seed => ({ ...seed, proactive: true }))); stores.add(store); advance(store, 1);
  expect(store.request({ type: 'state' }).state!.companions.find(role => role.id === 'deepseek-flash')!.proactive).toBe(false);
  const after = store.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(after.id).toBe(before.id); expect(after.attempts).toBe(2); expect(after.leaseToken).not.toBe(before.leaseToken);
  expect(() => store.request({ type: 'social.notification.complete', id: before.id, leaseToken: before.leaseToken!, text: '过期回报' })).toThrow('租约');
  const committed = store.request({ type: 'social.notification.complete', id: after.id, leaseToken: after.leaseToken!, text: '菲比已经回复邀请。' }).message!;
  expect(committed.replyToId).toBe(f.source.id); expect(store.request({ type: 'social.notification.claim' }).socialNotification).toBeUndefined();
});
it.each(['forget', 'reset'] as const)('blocks an already claimed result after original source %s', async action => {
  const f = fixture(); replied(f); const notice = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  if (action === 'forget') f.store.request({ type: 'memory.forget', companionId: 'deepseek-flash', conversationId: f.playerRoom.id, sourceMessageIds: [f.source.id] });
  if (action === 'reset') {
    const reset = f.store.request({ type: 'companion.reset', id: 'deepseek-flash', scope: 'all' }).reset!;
    f.store.request({ type: 'companion.reset.cleanup', id: 'deepseek-flash', jobId: reset.id });
    for (let count = 0; count < 500 && f.store.request({ type: 'companion.reset.status', id: 'deepseek-flash' }).reset?.status !== 'completed'; count++) await f.store.advanceReset();
  }
  expect(() => f.store.request({ type: 'social.notification.complete', id: notice.id, leaseToken: notice.leaseToken!, text: '已撤回的结果不得回流。' })).toThrow();
  expect(f.store.request({ type: 'social.notification.claim' }).socialNotification).toBeUndefined();
  const conversationId = action === 'reset' ? f.store.openPrivate('deepseek-flash').id : f.playerRoom.id;
  expect(f.store.messages({ conversationId }).messages.some(value => value.content === '已撤回的结果不得回流。')).toBe(false);
});
it('does not return a claimed event to a deleted custom owner', () => {
  const f = fixture(), owner = f.store.createCompanion({ name: '独立伙伴', description: '', persona: '友好', model: '', avatar: 'custom', proactive: false });
  f.store.setCompanionActive(owner.id, true);
  const room = f.store.openPrivate(owner.id), routine = f.store.request({ type: 'routine.get', companionId: owner.id, conversationId: room.id }).routine!;
  f.store.request({ type: 'routine.configure', companionId: owner.id, conversationId: room.id, expectedRevision: routine.revision,
    patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } }); advance(f.store, 10000);
  const source = f.store.appendMessage({ conversationId: room.id, authorId: 'user', content: '找菲比聊聊。', replyDirective: 'none' });
  const peer = f.store.request({ type: 'social.conversation.ensure', companionId: owner.id, memberIds: [owner.id, 'phoebe'] }).socialConversation!;
  const send = { type: 'social.send', companionId: owner.id, conversationId: peer.id, authorizationMessageId: source.id, content: '一起玩吗？', channel: 'phone', clientId: 'custom_origin' } as const;
  f.store.request(send); advance(f.store, 1300); const job = f.store.request({ type: 'social.job.claim' }).socialJob!;
  advance(f.store, 1300); f.store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '好呀。' });
  const notice = f.store.request({ type: 'social.notification.claim' }).socialNotification!; expect(notice.companionId).toBe(owner.id);
  f.store.deleteCompanion(owner.id);
  expect(() => f.store.request({ type: 'social.notification.complete', id: notice.id, leaseToken: notice.leaseToken!, text: '不得给已删除伙伴生成旧回报。' })).toThrow();
  expect(f.store.request({ type: 'social.notification.claim' }).socialNotification).toBeUndefined();
});
it('binds a deferred player visit by exact source/target/reason and reports actual permission, not an invented arrival', () => {
  const f = fixture(), scope = { companionId: 'deepseek-flash', conversationId: f.playerRoom.id }, reason = '玩家让我来找菲比一起玩。';
  f.store.request({ type: 'social.delegation.record', ...scope, sourceMessageId: f.source.id, recipientIds: ['phoebe'], sharedText: reason, intent: 'visit' });
  f.store.request({ type: 'world.tool', ...scope, sourceMessageId: f.source.id, arguments: { action: 'visit', targetCompanionId: 'phoebe', reason } });
  const visit = f.store.request({ type: 'world.snapshot' }).world!.visits.find(value => value.guestId === 'deepseek-flash' && value.hostId === 'phoebe')!;
  const host = { companionId: 'phoebe', conversationId: 'world_phoebe' };
  f.store.request({ type: 'world.tool', ...host, arguments: { action: 'respond', requestId: visit.id, decision: 'allow', reason: '可以来玩。' } });
  advance(f.store, 120000);
  const notice = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(notice).toMatchObject({ kind: 'visit_permission', sourceMessageId: f.source.id, origin: { initiatorId: 'user' },
    evidence: { authorId: 'phoebe', visitId: visit.id, visitStatus: 'allowed', text: '可以来玩。' } });
});
it('blocks fresh unsolicited social contact when disabled without disabling an explicit current-player delegation', () => {
  const f = fixture();
  expect(() => f.store.request({ type: 'social.send', companionId: 'deepseek-flash', conversationId: f.peer.id, content: '自主问候', channel: 'phone', clientId: 'disabled' })).toThrow('关闭主动');
  expect(() => replied(f)).not.toThrow();
});
function visitResponse(f: ReturnType<typeof fixture>, sharedResponse = '今天不方便，因为WITHDRAWN_HOST_SECRET。') {
  const scope = { companionId: 'deepseek-flash', conversationId: f.playerRoom.id }, reason = '玩家让我来找菲比一起玩。';
  f.store.request({ type: 'social.delegation.record', ...scope, sourceMessageId: f.source.id, recipientIds: ['phoebe'], sharedText: reason, intent: 'visit' });
  f.store.request({ type: 'world.tool', ...scope, sourceMessageId: f.source.id, arguments: { action: 'visit', targetCompanionId: 'phoebe', reason } });
  const visit = f.store.request({ type: 'world.snapshot' }).world!.visits.find(visit => visit.guestId === scope.companionId && visit.hostId === 'phoebe')!;
  // Bind the real requested visit before the host makes her decision.
  expect(f.store.request({ type: 'social.notification.claim' }).socialNotification).toBeUndefined();
  const host = { companionId: 'phoebe', conversationId: f.store.openPrivate('phoebe').id };
  const responseSource = f.store.appendMessage({ conversationId: host.conversationId, authorId: 'user', content: '这次不方便，因为WITHDRAWN_HOST_SECRET。只共享约定好的简短回复。', replyDirective: 'none' });
  f.store.request({ type: 'world.tool', ...host, sourceMessageId: responseSource.id, arguments: { action: 'respond', requestId: visit.id, decision: 'deny', reason: sharedResponse } });
  advance(f.store, 120000);
  return { host, visit, responseSource };
}
it('does not enqueue a raw visit response after the host has forgotten its actual private source', () => {
  const f = fixture(), { host, responseSource, visit } = visitResponse(f);
  f.store.request({ type: 'memory.forget', ...host, sourceMessageIds: [responseSource.id] });
  const publicVisit = f.store.request({ type: 'world.snapshot' }).world!.visits.find(item => item.id === visit.id)!;
  expect(publicVisit.status).toBe('denied'); expect(publicVisit.response).not.toContain('WITHDRAWN_HOST_SECRET');
  expect(f.store.request({ type: 'social.notification.claim' }).socialNotification).toBeUndefined();
  expect(f.store.messages({ conversationId: f.playerRoom.id }).messages.some(message => message.content.includes('WITHDRAWN_HOST_SECRET'))).toBe(false);
});
it.each(['forget', 'reset'] as const)('rejects a claimed visit response after its host source %s without undoing the public permission fact', async action => {
  const f = fixture(), { host, responseSource, visit } = visitResponse(f);
  const notice = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  expect(notice.evidence.text).toContain('WITHDRAWN_HOST_SECRET');
  if (action === 'forget') f.store.request({ type: 'memory.forget', ...host, sourceMessageIds: [responseSource.id] });
  else {
    const reset = f.store.request({ type: 'companion.reset', id: host.companionId, scope: 'all' }).reset!;
    f.store.request({ type: 'companion.reset.cleanup', id: host.companionId, jobId: reset.id });
    for (let count = 0; count < 500 && f.store.request({ type: 'companion.reset.status', id: host.companionId }).reset?.status !== 'completed'; count++) await f.store.advanceReset();
    expect(f.store.request({ type: 'companion.reset.status', id: host.companionId }).reset?.status).toBe('completed');
  }
  expect(() => f.store.request({ type: 'social.notification.complete', id: notice.id, leaseToken: notice.leaseToken!, text: '不得回流WITHDRAWN_HOST_SECRET。' })).toThrow();
  expect(f.store.request({ type: 'social.notification.claim' }).socialNotification).toBeUndefined();
  expect(f.store.messages({ conversationId: f.playerRoom.id }).messages.some(message => message.content.includes('WITHDRAWN_HOST_SECRET'))).toBe(false);
  if (action === 'forget') expect(f.store.request({ type: 'world.snapshot' }).world!.visits.find(item => item.id === visit.id)!.status).toBe('denied');
});
it('reports only the response deliberately shared by the host and preserves an already committed public report', () => {
  const f = fixture(), shared = '今天不方便接待，改天再约。', { host, responseSource } = visitResponse(f, shared);
  const claimed = f.store.request({ type: 'social.notification.claim' }), notice = claimed.socialNotification!;
  expect(companionStorageResponseSchema.safeParse(claimed).success).toBe(true);
  expect(notice.evidence.text).toBe(shared);
  for (const secret of ['WITHDRAWN_HOST_SECRET', responseSource.id, host.conversationId]) expect(JSON.stringify(notice)).not.toContain(secret);
  const completion = { type: 'social.notification.complete', id: notice.id, leaseToken: notice.leaseToken!, text: '菲比说今天不方便接待，我们改天再约。' } as const;
  const sent = f.store.request(completion).message!;
  f.store.request({ type: 'memory.forget', ...host, sourceMessageIds: [responseSource.id] });
  expect(f.store.request(completion).message!.id).toBe(sent.id);
  expect(f.store.messages({ conversationId: f.playerRoom.id }).messages.filter(message => message.id === sent.id)).toHaveLength(1);
});
it('delivers a peer outbox independently while the same owner replies in the player port without duplicate send', () => {
  const f = fixture(), scope = { companionId: 'deepseek-flash', conversationId: f.playerRoom.id };
  expect(f.store.request({ type: 'world.work.begin', ...scope, workId: 'player_phone', kind: 'chat', sourceMessageId: f.source.id }).worldWork!.status).toBe('ready');
  f.store.request({ type: 'social.send', ...scope, conversationId: f.peer.id, content: '菲比，可以一起玩吗？', channel: 'phone', authorizationMessageId: f.source.id, clientId: 'lease_outbox' });
  advance(f.store, 1500); expect(f.store.request({ type: 'social.job.claim' }).socialMessage!.message.content).toBe('菲比，可以一起玩吗？');
  expect(f.store.messages({ conversationId: f.peer.id }).messages).toHaveLength(1);
  f.store.request({ type: 'world.work.end', companionId: scope.companionId, workId: 'player_phone' }); advance(f.store, 1);
  expect(f.store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined(); advance(f.store, 1300);
  expect(f.store.request({ type: 'social.job.claim' }).socialMessage).toBeUndefined();
  expect(f.store.messages({ conversationId: f.peer.id }).messages).toHaveLength(1);
});
it('does not let a waiting player request steal an active peer lease or block its actual reply', () => {
  const f = fixture(); replied(f); const job = f.store.request({ type: 'social.job.claim' }).socialJob!;
  const source = f.store.appendMessage({ conversationId: f.playerRoom.id, authorId: 'user', content: '有空时和我聊聊。', replyDirective: 'none' });
  expect(f.store.request({ type: 'world.work.begin', companionId: 'deepseek-flash', conversationId: f.playerRoom.id, workId: 'waiting_player_phone', kind: 'chat', sourceMessageId: source.id }).worldWork!.status).toBe('ready');
  advance(f.store, 1300);
  const committed = f.store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '好的，我们稍后见。' });
  expect(committed.socialMessage!.message.authorId).toBe('deepseek-flash');
});
it('keeps an existing peer reply in its original port while an urgent player chat runs independently', () => {
  const f = fixture(); replied(f); const job = f.store.request({ type: 'social.job.claim' }).socialJob!;
  advance(f.store, 1300); const before = f.store.messages({ conversationId: f.peer.id }).messages.length;
  const source = f.store.appendMessage({ conversationId: f.playerRoom.id, authorId: 'user', content: '紧急，请先回应我。', replyDirective: 'none' });
  recordUrgentAttention(f.store, 'deepseek-flash', source);
  expect(f.store.request({ type: 'world.work.begin', companionId: 'deepseek-flash', conversationId: f.playerRoom.id, workId: 'urgent_player_phone', kind: 'chat', sourceMessageId: source.id, urgent: true }).worldWork!.status).toBe('ready');
  expect(f.store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '在原伙伴会话回应，与玩家急事保持独立。' }).socialMessage!.message.conversationId).toBe(f.peer.id);
  expect(f.store.messages({ conversationId: f.peer.id }).messages).toHaveLength(before + 1);
  const next = f.store.request({ type: 'social.job.claim' }).socialJob!;
  expect(next.id).not.toBe(job.id); expect(next.companionId).toBe('phoebe'); expect(next.conversationId).toBe(f.peer.id);
  f.store.request({ type: 'world.work.end', companionId: 'deepseek-flash', workId: 'urgent_player_phone' }); advance(f.store, 1);
  expect(f.store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
  expect(f.store.messages({ conversationId: f.peer.id }).messages).toHaveLength(before + 1);
});
it('serializes delegated notification claim and late completion with actual ready player chats', () => {
  const f = fixture(); replied(f);
  const scope = { companionId: 'deepseek-flash', conversationId: f.playerRoom.id };
  expect(f.store.request({ type: 'world.work.begin', ...scope, workId: 'notice_player_phone', kind: 'chat', sourceMessageId: f.source.id }).worldWork!.status).toBe('ready');
  expect(f.store.request({ type: 'social.notification.claim' }).socialNotification).toBeUndefined();
  f.store.request({ type: 'world.work.end', companionId: scope.companionId, workId: 'notice_player_phone' }); advance(f.store, 1);
  const notice = f.store.request({ type: 'social.notification.claim' }).socialNotification!;
  const urgent = f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '紧急，先和我说一件事。', replyDirective: 'none' }); recordUrgentAttention(f.store, scope.companionId, urgent);
  expect(f.store.request({ type: 'world.work.begin', ...scope, workId: 'notice_urgent_phone', kind: 'chat', sourceMessageId: urgent.id, urgent: true }).worldWork!.status).toBe('ready');
  expect(f.store.request({ type: 'social.notification.complete', id: notice.id, leaseToken: notice.leaseToken!, text: '此时不应插入的旧回报' }).socialPending).toBe(true);
  expect(f.store.messages({ conversationId: scope.conversationId }).messages.some(message => message.content === '此时不应插入的旧回报')).toBe(false);
  f.store.request({ type: 'world.work.end', companionId: scope.companionId, workId: 'notice_urgent_phone' }); advance(f.store, 1);
  const reclaimed = f.store.request({ type: 'social.notification.claim' }).socialNotification!; expect(reclaimed.id).toBe(notice.id); expect(reclaimed.attempts).toBe(2);
  expect(f.store.request({ type: 'social.notification.complete', id: reclaimed.id, leaseToken: reclaimed.leaseToken!, text: '菲比已实际回复邀请。' }).message!.replyToId).toBe(f.source.id);
});
