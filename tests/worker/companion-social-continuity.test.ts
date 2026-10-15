import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { recordUrgentAttention } from '../helpers/companion-world-fixture';

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
  const filename = path.join(root, 'messages.sqlite'), store = new CompanionsStore(filename, seeds); stores.add(store);
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
function replied(f: ReturnType<typeof fixture>, content = '好呀，等你过来一起玩。') {
  const send = { type: 'social.send', companionId: 'deepseek-flash', conversationId: f.peer.id, channel: 'phone',
    content: '菲比，可以一起玩吗？', authorizationMessageId: f.source.id, clientId: 'player_delegated_invitation' } as const;
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
it('holds an initial peer outbox while the same owner is actually replying to the player, then resumes it once', () => {
  const f = fixture(), scope = { companionId: 'deepseek-flash', conversationId: f.playerRoom.id };
  expect(f.store.request({ type: 'world.work.begin', ...scope, workId: 'player_phone', kind: 'chat', sourceMessageId: f.source.id }).worldWork!.status).toBe('ready');
  f.store.request({ type: 'social.send', ...scope, conversationId: f.peer.id, content: '菲比，可以一起玩吗？', channel: 'phone', authorizationMessageId: f.source.id, clientId: 'lease_outbox' });
  advance(f.store, 1500); expect(f.store.request({ type: 'social.job.claim' }).socialMessage).toBeUndefined();
  expect(f.store.messages({ conversationId: f.peer.id }).messages).toHaveLength(0);
  f.store.request({ type: 'world.work.end', companionId: scope.companionId, workId: 'player_phone' }); advance(f.store, 1);
  expect(f.store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined(); advance(f.store, 1300);
  expect(f.store.request({ type: 'social.job.claim' }).socialMessage!.message.content).toBe('菲比，可以一起玩吗？');
  expect(f.store.messages({ conversationId: f.peer.id }).messages).toHaveLength(1);
});
it('does not let a waiting player request steal an active peer lease or block its actual reply', () => {
  const f = fixture(); replied(f); const job = f.store.request({ type: 'social.job.claim' }).socialJob!;
  const source = f.store.appendMessage({ conversationId: f.playerRoom.id, authorId: 'user', content: '有空时和我聊聊。', replyDirective: 'none' });
  expect(f.store.request({ type: 'world.work.begin', companionId: 'deepseek-flash', conversationId: f.playerRoom.id, workId: 'waiting_player_phone', kind: 'chat', sourceMessageId: source.id }).worldWork!.status).toBe('waiting');
  advance(f.store, 1300);
  const committed = f.store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '好的，我们稍后见。' });
  expect(committed.socialMessage!.message.authorId).toBe('deepseek-flash');
});
it('returns a late peer reply to pending after verified urgent player phone takeover, then reclaims the same job', () => {
  const f = fixture(); replied(f); const job = f.store.request({ type: 'social.job.claim' }).socialJob!;
  advance(f.store, 1300); const before = f.store.messages({ conversationId: f.peer.id }).messages.length;
  const source = f.store.appendMessage({ conversationId: f.playerRoom.id, authorId: 'user', content: '紧急，请先回应我。', replyDirective: 'none' });
  recordUrgentAttention(f.store, 'deepseek-flash', source);
  expect(f.store.request({ type: 'world.work.begin', companionId: 'deepseek-flash', conversationId: f.playerRoom.id, workId: 'urgent_player_phone', kind: 'chat', sourceMessageId: source.id, urgent: true }).worldWork!.status).toBe('ready');
  expect(f.store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '此时不应发出的旧peer回复' }).socialPending).toBe(true);
  expect(f.store.messages({ conversationId: f.peer.id }).messages).toHaveLength(before);
  expect(f.store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
  f.store.request({ type: 'world.work.end', companionId: 'deepseek-flash', workId: 'urgent_player_phone' }); advance(f.store, 1);
  const reclaimed = f.store.request({ type: 'social.job.claim' }).socialJob!; expect(reclaimed.id).toBe(job.id); expect(reclaimed.attempts).toBe(2);
  advance(f.store, 1300); expect(f.store.request({ type: 'social.job.complete', id: reclaimed.id, leaseToken: reclaimed.leaseToken!, text: '已经处理完紧急对话，现在回复你。' }).socialMessage!.message.authorId).toBe('deepseek-flash');
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
