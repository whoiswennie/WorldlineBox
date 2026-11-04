import { lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { BUILTIN_BOT_COMPANIONS, DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';

/** Human-authored visual fixtures through the actual Main store. All queued
 * events are settled synchronously before Main's scheduler can resume. No model,
 * private production data, DSH task or memory-quality result is fabricated. */
export function seedPeerWorkspace(profile: string) {
  const resolved = path.resolve(profile), stat = lstatSync(resolved);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('wlb-peer-workspace-')
    || !stat.isDirectory() || stat.isSymbolicLink() || path.resolve(realpathSync(resolved)) !== resolved) throw Error('Peer fixtures require their owned temporary profile.');
  const database = path.join(resolved, 'companion-bot-v2', 'bot.sqlite');
  if (lstatSync(database).isSymbolicLink()) throw Error('Peer fixture database cannot be a link.');
  const store = new BotStore(database);
  try {
    const existing = store.taskTransaction(sql => sql.prepare('SELECT COUNT(*) AS count FROM bot_messages').get()) as { count: number };
    if (existing.count) throw Error('Peer fixtures require an empty isolated message store.');
    const origin = BUILTIN_BOT_COMPANIONS.find(person => person.name === 'GPT')!;
    if (!origin || !store.getCompanion(origin.id) || !store.getCompanion(DEFAULT_BOT_COMPANION_ID)) throw Error('Real built-in partners must be initialized by Main.');
    const sourcePrivate = store.openDirect(origin.id), targetPrivate = store.openDirect(DEFAULT_BOT_COMPANION_ID);
    const secrets = { origin: '【GPT 私聊专用】紫色雨伞已放在书架第二层。', target: '【大肥鱼私聊专用】明天午后喝麦茶。' };
    store.enqueue({ conversationId: sourcePrivate.id, source: 'user', senderId: 'user', recipientIds: [], sourceMessageId: 'peer-ui-origin-private', content: secrets.origin });
    store.enqueue({ conversationId: targetPrivate.id, source: 'user', senderId: 'user', recipientIds: [], sourceMessageId: 'peer-ui-target-private', content: secrets.target });
    const source = store.enqueue({ conversationId: sourcePrivate.id, source: 'user', senderId: 'user', recipientIds: [origin.id],
      sourceMessageId: 'peer-ui-user-request', content: '你能让大肥鱼给我发晚安吗' }).events[0]!;
    const privateIntroduction = store.contactPeer(source, DEFAULT_BOT_COMPANION_ID, 'human-authored-user-ui-contact', '用户请你在你与用户的私聊中说一句晚安。', 'user');
    if (!privateIntroduction.accepted || privateIntroduction.events.length !== 1) throw Error('Could not create the actual user-directed contact.');
    const settle = (entries: Array<{ id: string; content: string }>) => {
      const pending = new Map(entries.map(entry => [entry.id, entry.content]));
      while (pending.size) {
        const claim = store.claim({ workerId: 'human-authored-peer-presentation' }), content = claim && pending.get(claim.event.id);
        if (!claim || content === undefined || !store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content })) throw Error('Could not settle the human-authored peer presentation fixture.');
        pending.delete(claim.event.id);
      }
    };
    settle([{ id: source.id, content: '我已把请求交给大肥鱼，她会在你们的私聊中回复。' }, { id: privateIntroduction.events[0]!.id, content: '晚安呀，我们在自己的私聊里继续聊。' }]);
    const userDirectReplyId = privateIntroduction.events[0]!.replyMessageId;
    const peerRequest = store.enqueue({ conversationId: sourcePrivate.id, source: 'user', senderId: 'user', recipientIds: [origin.id],
      sourceMessageId: 'peer-ui-pair-request', content: '你和大肥鱼私聊核对清单，我想旁观你们之间的交流。' }).events[0]!;
    const observed = store.contactPeer(peerRequest, DEFAULT_BOT_COMPANION_ID, 'human-authored-peer-ui-contact', '我们在双方私聊中核对清单，不转入用户私聊历史。', 'peer');
    if (!observed.accepted || observed.events.length !== 1) throw Error('Could not create the actual observed peer conversation.');
    settle([{ id: peerRequest.id, content: '我会与大肥鱼在双方私聊中核对，你可以打开记录旁观。' }, { id: observed.events[0]!.id, content: '这份清单我收到了，我们在私聊里继续核对吧。' }]);
    const observedReplyId = observed.events[0]!.replyMessageId;
    const observedFollowup = store.enqueue({ conversationId: observed.conversationId, source: 'companion', senderId: origin.id, recipientIds: [],
      sourceMessageId: 'peer-ui-pair-followup', content: '好，我们先核对交付顺序。' });
    // Preserve an ordinary user-participating group as a separate visual fixture.
    // It is never the destination of a request to contact the user privately.
    const introduction = store.createGroup({ title: 'GPT × 大肥鱼', memberIds: [origin.id, DEFAULT_BOT_COMPANION_ID], participationMode: 'automatic' });
    const groupIntroduction = store.enqueue({ conversationId: introduction.id, source: 'companion', senderId: origin.id, recipientIds: [],
      sourceMessageId: 'peer-ui-group-introduction', content: '这是我们和用户共同参与的普通群聊。' });
    const targetGroupReply = store.enqueue({ conversationId: introduction.id, source: 'companion', senderId: DEFAULT_BOT_COMPANION_ID, recipientIds: [],
      sourceMessageId: 'peer-ui-target-group-reply', content: '晚安呀，今天也辛苦了。把屏幕暗下来，明天再慢慢聊。🌙' });
    const targetReplyId = targetGroupReply.message.id;
    const originReply = store.enqueue({ conversationId: introduction.id, source: 'companion', senderId: origin.id, recipientIds: [],
      sourceMessageId: 'peer-ui-origin-group-reply', content: '那我也收工啦，把这句晚安好好收下。' });
    const userReply = store.enqueue({ conversationId: introduction.id, source: 'user', senderId: 'user', recipientIds: [],
      sourceMessageId: 'peer-ui-user-group-reply', content: '收到，晚安。明天见！' });
    const pending = store.taskTransaction(sql => sql.prepare("SELECT COUNT(*) AS count FROM bot_inbox WHERE status IN ('queued','running')").get()) as { count: number };
    if (pending.count) throw Error('Human-authored peer fixtures must not leave live model work.');
    return { synthetic: true, actualModelInference: false, actualDshExecution: false, storeContactPeerUsed: true,
      peerId: introduction.id, peerTitle: introduction.title, sourcePrivateId: sourcePrivate.id, targetPrivateId: targetPrivate.id,
      observedId: observed.conversationId, observedTitle: store.getConversation(observed.conversationId)!.title,
      observedMessageIds: [observed.message.id, observedReplyId, observedFollowup.message.id], observedReplyId,
      userDirectIntroductionId: privateIntroduction.message.id, userDirectReplyId,
      sourceCompanionId: origin.id, targetCompanionId: DEFAULT_BOT_COMPANION_ID, secrets,
      peerMessageIds: [groupIntroduction.message.id, targetReplyId, originReply.message.id, userReply.message.id],
      targetReplyId, originReplyId: originReply.message.id, userReplyId: userReply.message.id, pendingEvents: pending.count };
  } finally { store.close(); }
}

export type BotPeerWorkspaceFixture = ReturnType<typeof seedPeerWorkspace>;
