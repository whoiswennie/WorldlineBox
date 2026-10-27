import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { createHash } from 'node:crypto';
import { companionsRequestSchema } from '../../src/shared/companions';

const roots: string[] = [], stores: CompanionsStore[] = [];
const seed = (id: string): CompanionSeed => ({ id, name: id, description: '', persona: '保持真实身份。', model: '', avatar: 'sister', proactive: false, active: true });
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) { if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-topics-')) throw new Error('Unexpected topic fixture cleanup.'); rmSync(root, { recursive: true, force: true }); }
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-topics-')); roots.push(root);
  const file = path.join(root, 'companions.sqlite'), store = new CompanionsStore(file, ['alice', 'bob'].map(seed)); stores.push(store);
  const room = store.request({ type: 'conversation.create-group', title: '群聊', memberIds: ['alice', 'bob'] }).conversation!;
  const create = (title: string, readerId = 'user') => store.request({ type: 'topic.create', conversationId: room.id, title, kind: 'game', readerId }).topic!;
  return { file, store, room, create };
}
it('keeps one primary topic synchronized with the actual group audience while preserving other selected topics', () => {
  const f = fixture(), primaryId = f.room.defaultTopicId!, separate = f.create('独立游戏');
  const newcomer = f.store.createCompanion({ name: '新成员', description: '', persona: '认真', model: '', avatar: 'sister', proactive: false });
  f.store.updateConversation(f.room.id, { memberIds: ['alice', 'bob', newcomer.id] });
  const primary = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: primaryId, readerId: newcomer.id }).topic!;
  expect(primary.participantIds).toEqual(['user', 'alice', 'bob', newcomer.id]);
  expect(f.store.request({ type: 'topic.list', conversationId: f.room.id, readerId: 'user' }).topics!.filter(topic => topic.isPrimary)).toHaveLength(1);
  expect(f.store.state().conversations.find(room => room.id === f.room.id)?.activeTopicId).toBe(separate.id);
  expect(f.store.appendMessage({ conversationId: f.room.id, authorId: newcomer.id, content: '向主要群聊发言。' }).topicId).toBe(primaryId);
});
it('transfers only the existing moderator with exact live consent and preserves every participant private state', () => {
  const f = fixture(), topic = f.create('同一话题主持移交', 'alice');
  const read = (readerId = 'alice') => f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: topic.id, readerId });
  const command = { type: 'topic.transfer_moderator' as const, conversationId: f.room.id, topicId: topic.id, readerId: 'alice',
    expectedRevision: topic.revision, targetCompanionId: 'bob', sourceMessageIds: [] as string[], operationId: 'actual_moderator_handoff' };
  expect(() => f.store.request(command)).toThrow('自行加入');
  f.store.request({ type: 'topic.join', conversationId: f.room.id, topicId: topic.id, readerId: 'bob' });
  for (const readerId of ['alice', 'bob']) f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: topic.id,
    readerId, expectedRevision: read().topic!.revision, patch: { workingState: { summary: readerId + '_PRIVATE', state: { secret: readerId + '_ONLY' }, sourceMessageIds: [] } } });
  const consent = f.store.appendMessage({ conversationId: f.room.id, topicId: topic.id, authorId: 'bob', content: '我本人愿意接任本话题主持。' });
  const current = read().topic!, beforeAlice = read('alice').topicState, beforeBob = read('bob').topicState;
  const approval = { schema: 'worldlinebox.companion-topic-moderator-transfer-v1' as const, companionId: 'alice', conversationId: f.room.id,
    topicId: topic.id, previousModeratorId: 'alice', targetCompanionId: 'bob', expectedRevision: current.revision,
    consentMessageId: consent.id, sourceRefs: [{ id: consent.id, checksum: createHash('sha256').update(consent.content).digest('hex') }] };
  const approved = { ...command, expectedRevision: current.revision, sourceMessageIds: [consent.id], moderatorTransferApproval: approval };
  const publicCommand = { type: command.type, conversationId: f.room.id, topicId: topic.id, expectedRevision: current.revision,
    targetCompanionId: 'bob', sourceMessageIds: [consent.id] };
  expect(companionsRequestSchema.safeParse(publicCommand).success).toBe(true);
  expect(companionsRequestSchema.safeParse({ ...publicCommand, moderatorTransferApproval: approval }).success).toBe(false);
  expect(() => f.store.request({ ...approved, readerId: 'bob' })).toThrow('当前主持');
  expect(() => f.store.request({ ...approved, moderatorTransferApproval: undefined })).toThrow('宿主同意');
  expect(() => f.store.request({ ...approved, expectedRevision: current.revision - 1 })).toThrow('新进展');
  expect(() => f.store.request({ ...approved, moderatorTransferApproval: { ...approval, sourceRefs: [{ id: consent.id, checksum: 'a'.repeat(64) }] } })).toThrow('公开原文');
  const changed = f.store.request(approved);
  expect(changed.topic).toMatchObject({ id: topic.id, moderatorId: 'bob', revision: current.revision + 1,
    participantIds: current.participantIds, invitedIds: current.invitedIds });
  expect(read('alice').topicState).toEqual(beforeAlice); expect(read('bob').topicState).toEqual(beforeBob);
  expect(JSON.stringify(read('bob'))).not.toContain('alice_ONLY');
  expect(f.store.request(approved).topic!.revision).toBe(changed.topic!.revision);
  expect(() => f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: topic.id, readerId: 'alice',
    expectedRevision: changed.topic!.revision, patch: { shared: { summary: '旧主持不能再改公共阶段', sourceMessageIds: [] } } })).toThrow('真实主持人');
  // The ordinary user command retains its existing direct configuration authority.
  const restored = f.store.request({ ...command, readerId: 'user', expectedRevision: changed.topic!.revision,
    targetCompanionId: 'alice', operationId: 'actual_user_handoff' }).topic!;
  expect(restored.moderatorId).toBe('alice');
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id, sourceMessageIds: [consent.id] });
  expect(() => f.store.request({ ...approved, operationId: 'withdrawn_consent', expectedRevision: restored.revision,
    moderatorTransferApproval: { ...approval, expectedRevision: restored.revision } })).toThrow('公开原文');
  const reopened = new CompanionsStore(f.file, ['alice', 'bob'].map(seed)); stores.push(reopened);
  expect(reopened.request({ type: 'topic.read', conversationId: f.room.id, topicId: topic.id, readerId: 'bob' }).topic).toMatchObject({ id: topic.id, moderatorId: 'alice' });
  expect(reopened.request({ type: 'topic.read', conversationId: f.room.id, topicId: topic.id, readerId: 'bob' }).topicState).toEqual(beforeBob);
});
it('keeps per-reader topic selections, invitations, pause state and private working memory independent across restart', () => {
  const f = fixture(), first = f.create('狼人杀'), second = f.create('小说', 'bob');
  expect(first.participantIds).toEqual(['user']); expect(first.invitedIds).toEqual(['alice', 'bob']);
  f.store.request({ type: 'topic.join', conversationId: f.room.id, topicId: first.id, readerId: 'alice' });
  expect(f.store.request({ type: 'state' }).state!.conversations.find(room => room.id === f.room.id)?.activeTopicId).toBe(first.id);
  let topic = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: first.id, readerId: 'user' }).topic!;
  f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: first.id, readerId: 'user', expectedRevision: topic.revision,
    patch: { shared: { summary: '共有规则：九人局。', state: { rules: '九人局' }, sourceMessageIds: [] }, privateRecipientId: 'alice',
      workingState: { summary: 'ALICE_SECRET_ROLE', state: { role: 'seer' }, sourceMessageIds: [] } } });
  expect(JSON.stringify(f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: first.id, readerId: 'bob' }))).not.toContain('ALICE_SECRET_ROLE');
  expect(JSON.stringify(f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: first.id, readerId: 'alice' }))).toContain('ALICE_SECRET_ROLE');
  topic = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: first.id, readerId: 'user' }).topic!;
  f.store.request({ type: 'topic.pause', conversationId: f.room.id, topicId: first.id, readerId: 'user', expectedRevision: topic.revision });
  expect(f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: first.id, readerId: 'user' }).topic?.status).toBe('paused');
  expect(f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: first.id, readerId: 'alice' }).topic?.status).toBe('active');
  expect(() => f.store.appendMessage({ conversationId: f.room.id, authorId: 'user', content: '暂停时禁止误发' })).toThrow('暂停');
  const bobMessage = f.store.appendMessage({ conversationId: f.room.id, authorId: 'bob', topicId: second.id, content: '小说B继续。' });
  expect(bobMessage.topicId).toBe(second.id);
  const reopened = new CompanionsStore(f.file, ['alice', 'bob'].map(seed)); stores.push(reopened);
  expect(reopened.request({ type: 'topic.read', conversationId: f.room.id, topicId: first.id, readerId: 'user' }).topic?.status).toBe('paused');
  expect(JSON.stringify(reopened.request({ type: 'topic.read', conversationId: f.room.id, topicId: first.id, readerId: 'alice' }))).toContain('ALICE_SECRET_ROLE');
});
it('anchors replies and paginated history to the original topic while ordinary chat and another topic continue', () => {
  const f = fixture(), first = f.create('第一局');
  f.store.request({ type: 'topic.join', conversationId: f.room.id, topicId: first.id, readerId: 'alice' });
  const source = f.store.appendMessage({ conversationId: f.room.id, authorId: 'user', content: 'A_TOPIC_SOURCE' });
  const second = f.create('第二个讨论');
  const newer = f.store.appendMessage({ conversationId: f.room.id, authorId: 'user', content: 'B_TOPIC_SOURCE' });
  const ordinary = f.store.appendMessage({ conversationId: f.room.id, topicId: null, authorId: 'user', content: 'ORDINARY_SOURCE' });
  const reply = f.store.appendMessage({ conversationId: f.room.id, authorId: 'alice', content: 'A_TOPIC_REPLY', replyToId: source.id });
  expect(reply.topicId).toBe(first.id); expect(newer.topicId).toBe(second.id); expect(ordinary.topicId).toBe(f.room.defaultTopicId);
  expect(f.store.messages({ conversationId: f.room.id, topicId: first.id }).messages.map(message => message.content)).toEqual(['A_TOPIC_SOURCE', 'A_TOPIC_REPLY']);
  expect(f.store.messages({ conversationId: f.room.id, topicId: null }).messages.map(message => message.content)).toEqual(['ORDINARY_SOURCE']);
  expect(f.store.messages({ conversationId: f.room.id, topicId: first.id, after: source.sequence - 1, before: reply.sequence + 1 }).messages.map(message => message.id)).toEqual([source.id, reply.id]);
  expect(() => f.store.appendMessage({ conversationId: f.room.id, authorId: 'alice', topicId: second.id, content: '错误回复', replyToId: source.id })).toThrow('保留实际来源');
  expect(f.store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: f.room.id, ids: [source.id] }).memorySources?.[0]?.id).toBe(source.id);
});
it('projects withdrawn checkpoint sources per reader while preserving canonical shared state, other owners and source-free settings', () => {
  const f = fixture(), topic = f.create('来源隔离');
  for (const readerId of ['alice', 'bob']) f.store.request({ type: 'topic.join', conversationId: f.room.id, topicId: topic.id, readerId });
  const source = f.store.appendMessage({ conversationId: f.room.id, authorId: 'user', content: 'CHECKPOINT_ORIGINAL_SECRET', topicId: topic.id });
  const update = (readerId: string, patch: { shared?: { summary: string; sourceMessageIds: string[] }; workingState?: { summary: string; sourceMessageIds: string[]; state?: Record<string, unknown> } }) => {
    const current = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: topic.id, readerId }).topic!;
    return f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: topic.id, readerId, expectedRevision: current.revision, patch });
  };
  update('user', { shared: { summary: 'SHARED_DERIVED_SECRET', sourceMessageIds: [source.id] } });
  update('alice', { workingState: { summary: 'ALICE_DERIVED_SECRET', sourceMessageIds: [source.id] } });
  update('bob', { workingState: { summary: 'BOB_PRIVATE_STATE', sourceMessageIds: [source.id] } });
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.room.id, sourceMessageIds: [source.id] });
  const read = (readerId: string) => f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: topic.id, readerId });
  expect(read('alice').topicState?.shared).toBeUndefined(); expect(read('alice').topicState?.workingState).toBeUndefined();
  expect(read('bob').topicState?.shared?.summary).toBe('SHARED_DERIVED_SECRET');
  expect(read('bob').topicState?.workingState?.summary).toBe('BOB_PRIVATE_STATE');
  expect(JSON.stringify(read('bob'))).not.toContain('ALICE_DERIVED_SECRET');
  expect(read('user').topicState?.shared?.summary).toBe('SHARED_DERIVED_SECRET');
  expect(f.store.getMessage(source.id).content).toBe('CHECKPOINT_ORIGINAL_SECRET');
  expect(f.store.request({ type: 'topic.sources.valid', conversationId: f.room.id, topicId: topic.id, readerId: 'alice', sourceMessageIds: [source.id] }).topicSourcesValid).toBe(false);
  expect(f.store.request({ type: 'topic.sources.valid', conversationId: f.room.id, topicId: topic.id, readerId: 'bob', sourceMessageIds: [source.id] }).topicSourcesValid).toBe(true);
  const recall = (companionId: string, query = '') => f.store.request({ type: 'memory.world_query', companionId, conversationId: f.room.id, category: 'topics', topicId: topic.id, query, limit: 10 });
  expect(JSON.stringify(recall('alice'))).not.toContain('SHARED_DERIVED_SECRET');
  expect(JSON.stringify(recall('alice'))).not.toContain('ALICE_DERIVED_SECRET');
  expect(recall('alice', 'SHARED_DERIVED_SECRET').worldKnowledge?.items).toEqual([]);
  expect(JSON.stringify(recall('bob'))).toContain('SHARED_DERIVED_SECRET');
  expect(JSON.stringify(recall('bob'))).toContain('BOB_PRIVATE_STATE');
  update('user', { shared: { summary: '主持人设置的独立规则', sourceMessageIds: [] } });
  update('alice', { workingState: { summary: '独立的游戏设定', sourceMessageIds: [], state: { sourceMessageIds: [source.id] } } });
  expect(read('alice').topicState?.shared?.summary).toBe('主持人设置的独立规则');
  expect(read('alice').topicState?.workingState?.summary).toBe('独立的游戏设定');
  expect(JSON.stringify(recall('alice'))).toContain('独立的游戏设定');
});
it('keeps shared checkpoint access for late invitees without granting its original chat messages', () => {
  const f = fixture();
  f.store.request({ type: 'conversation.update', id: f.room.id, memberIds: ['alice'] });
  const topic = f.create('迟到的参与者');
  const source = f.store.appendMessage({ conversationId: f.room.id, topicId: topic.id, authorId: 'user', content: 'SHARED_ORIGIN_BEFORE_BOB_JOINED' });
  f.store.request({ type: 'conversation.update', id: f.room.id, memberIds: ['alice', 'bob'] });
  const current = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: topic.id, readerId: 'user' }).topic!;
  f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: topic.id, readerId: 'user', expectedRevision: current.revision,
    patch: { shared: { summary: '已公开的游戏阶段', sourceMessageIds: [source.id] }, invitedIds: ['alice', 'bob'] } });
  expect(f.store.request({ type: 'memory.sources.filter', companionId: 'bob', conversationId: f.room.id, ids: [source.id] }).memorySources).toEqual([]);
  expect(f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: topic.id, readerId: 'bob' }).topicState?.shared?.summary).toBe('已公开的游戏阶段');
  expect(f.store.request({ type: 'topic.sources.valid', conversationId: f.room.id, topicId: topic.id, readerId: 'bob', sourceMessageIds: [source.id] })).toEqual({ ok: true, topicSourcesValid: true });
});
it('lets the human manage companion-only topics without joining them or reading another participant private state', () => {
  const f = fixture();
  const topic = f.store.request({ type: 'topic.create', conversationId: f.room.id, readerId: 'alice', participantIds: ['bob'], title: '伙伴自己的游戏', kind: 'game' }).topic!;
  f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: topic.id, readerId: 'alice', expectedRevision: topic.revision,
    patch: { workingState: { summary: 'ALICE_PRIVATE_ROLE', sourceMessageIds: [] }, shared: { summary: '公开规则', sourceMessageIds: [] } } });
  const admin = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: topic.id, readerId: 'user' });
  expect(admin.topic?.participantIds).toEqual(['alice']);
  expect(admin.topicState?.shared?.summary).toBe('公开规则');
  expect(JSON.stringify(admin)).not.toContain('ALICE_PRIVATE_ROLE');
  expect(f.store.request({ type: 'topic.list', conversationId: f.room.id, readerId: 'user' }).topics?.filter(item => !item.isPrimary).map(item => item.id)).toEqual([topic.id]);
  expect(f.store.state().conversations.find(room => room.id === f.room.id)?.activeTopicId).toBe(f.room.defaultTopicId);
  expect(() => f.store.appendMessage({ conversationId: f.room.id, topicId: topic.id, authorId: 'user', content: '尚未加入' })).toThrow('自主加入');
});
it('records participation for a never-activated companion without activating a world body', () => {
  const f = fixture();
  const dormant = f.store.createCompanion({ name: '未激活伙伴', description: '', persona: '独立人格', model: '', avatar: 'sister', proactive: false });
  const room = f.store.createConversation('包含休眠伙伴', ['alice', dormant.id]);
  const topic = f.store.request({ type: 'topic.create', conversationId: room.id, readerId: 'user', title: '实际加入体验', kind: 'game' }).topic!;
  expect(f.store.request({ type: 'topic.join', conversationId: room.id, readerId: dormant.id, topicId: topic.id }).topic?.participantIds).toContain(dormant.id);
  const state = f.store.state();
  expect(state.companions.find(companion => companion.id === dormant.id)?.active).toBe(false);
  expect(f.store.request({ type: 'world.snapshot' }).world?.actors.some(actor => actor.companionId === dormant.id)).toBe(false);
  const sources = f.store.messages({ conversationId: 'world_' + dormant.id, limit: 20 }).messages;
  expect(sources).toHaveLength(1); expect(sources[0]?.content).toContain('实际加入体验');
});
it('protects host continuity markers and excludes deleted topic data from ordinary windows and search listings', () => {
  const f = fixture(), topic = f.create('标签测试');
  const source = f.store.appendMessage({ conversationId: f.room.id, authorId: 'user', content: '持久规则原文' });
  f.store.request({ type: 'topic.join', conversationId: f.room.id, topicId: topic.id, readerId: 'alice' });
  let current = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: topic.id, readerId: 'alice' }).topic!;
  expect(() => f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: topic.id, readerId: 'alice', expectedRevision: current.revision,
    patch: { workingState: { state: { __continuity: { throughSequence: 999999 } }, sourceMessageIds: [source.id] } } })).toThrow('宿主维护');
  const saved = f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: topic.id, readerId: 'alice', expectedRevision: current.revision, maintenance: true,
    patch: { workingState: { summary: 'COMPACTED_OWN_STATE', state: { __continuity: { throughSequence: source.sequence } }, sourceMessageIds: [source.id] } } });
  expect(saved.topicState?.workingState?.state?.__continuity).toEqual({ throughSequence: source.sequence });
  current = saved.topic!;
  f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: topic.id, readerId: 'user', expectedRevision: current.revision, patch: { tags: ['狼人杀', '长局'] } });
  expect(f.store.request({ type: 'topic.list', conversationId: f.room.id, readerId: 'user', query: '标签', tags: ['长局'] }).topics?.map(item => item.id)).toEqual([topic.id]);
  current = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: topic.id, readerId: 'user' }).topic!;
  f.store.request({ type: 'topic.delete', conversationId: f.room.id, topicId: topic.id, readerId: 'user', expectedRevision: current.revision });
  expect(f.store.request({ type: 'topic.list', conversationId: f.room.id, readerId: 'user' }).topics?.filter(item => !item.isPrimary)).toEqual([]);
  expect(f.store.messages({ conversationId: f.room.id, topicId: null }).messages).toEqual([]);
  expect(f.store.messages({ conversationId: f.room.id }).messages).toEqual([]);
  expect(f.store.state().conversations.find(room => room.id === f.room.id)?.lastMessage).toBe('');
  expect(() => f.store.messages({ conversationId: f.room.id, topicId: topic.id })).toThrow('已删除');
  expect(() => f.store.request({ type: 'message.get', id: source.id })).toThrow('已删除');
  expect(f.store.search({ conversationId: f.room.id, query: '持久规则', category: 'all', limit: 20 }).messages).toEqual([]);
  expect(() => f.store.appendMessage({ conversationId: f.room.id, authorId: 'user', content: '不能续写已删话题', replyToId: source.id })).toThrow('已删除');
  expect(() => f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: topic.id, readerId: 'alice' })).toThrow('当前读者');
});
