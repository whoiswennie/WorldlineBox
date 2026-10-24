/** Actual SQLite publication views and source boundaries; no model transport. */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';

const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const Database = BetterSqlite3 as unknown as { new(file: string): CompanionConnection };
const resources: Array<{ root: string; store: CompanionsStore }> = [];
afterEach(() => {
  const current = resources.splice(0);
  for (const { store } of current) store.close();
  for (const root of new Set(current.map(item => item.root))) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('topic-latest-publication-view-'))
      throw new Error('Unexpected publication view fixture path.');
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(kind: 'game' | 'discussion' = 'discussion') {
  const root = mkdtempSync(path.join(tmpdir(), 'topic-latest-publication-view-')), file = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(file, ['reader', 'peer'].map(id => ({ id, name: id, description: '', persona: '独立角色', model: '',
    avatar: 'sister', active: true, proactive: false })));
  resources.push({ root, store });
  const room = store.createConversation('真实最新发布视图', ['reader', 'peer']);
  const topic = store.request({ type: 'topic.create', conversationId: room.id, readerId: 'user', title: '公开过程', kind }).topic!;
  for (const readerId of ['reader', 'peer']) store.request({ type: 'topic.join', conversationId: room.id, topicId: topic.id, readerId });
  const append = (content: string) => store.appendMessage({ conversationId: room.id, topicId: topic.id, authorId: 'user', content, replyDirective: 'none' });
  const draft = (source: CompanionMessage) => {
    const message = store.appendMessage({ conversationId: room.id, topicId: topic.id, authorId: 'reader', replyToId: source.id,
      content: '', loopStep: 0, replyDirective: 'none' });
    const checkpoint: CompanionLoopCheckpoint = { companionId: 'reader', conversationId: room.id, sourceMessageId: source.id,
      messageId: message.id, status: 'running', turns: [], supplements: [] };
    store.request({ type: 'loop.save', checkpoint });
    return { message, publish: (content: string) => {
      store.request({ type: 'loop.save', checkpoint: { ...checkpoint, status: 'done', turns: [{ text: content, rawText: content, calls: [] }] } });
      return store.getMessage(message.id);
    } };
  };
  const read = (readerId = 'reader') => companionStorageResponseSchema.parse(store.request({ type: 'topic.read', conversationId: room.id, topicId: topic.id, readerId })).topic!;
  const sql = (operation: (db: CompanionConnection) => void) => {
    const db = new Database(file);
    db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
    db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
    try { operation(db); } finally { db.close(); }
  };
  return { root, store, file, room, topic, append, draft, read, sql };
}

it.each(['game', 'discussion'] as const)('keeps independent latest narrative and input publication views in actual %s publication order', kind => {
  const f = fixture(kind), first = f.append('最初的实际输入。'), slow = f.draft(first);
  const second = f.append('第二条实际输入。'), fast = f.draft(second), fastFormal = fast.publish('较晚创建，但较早正式发布的正文。');
  const late = slow.publish('较早创建，实际晚正式发布的正文。');
  const lateRevision = f.read().formalPublicationRevision!;
  expect(late.sequence).toBeLessThan(fastFormal.sequence);
  const latestInput = f.append('后来新的真人输入，不能覆盖上一次实际正式叙事。');
  const view = f.read();
  expect(view.lastNarrativePublicationAvailability).toBe('available');
  expect(view.lastNarrativePublicationRef).toEqual({ messageId: late.id, contentChecksum: hash(late.content), authorId: 'reader', publicationRevision: lateRevision });
  expect(view.lastInputPublicationAvailability).toBe('available');
  expect(view.lastInputPublicationRef).toEqual({ messageId: latestInput.id, contentChecksum: hash(latestInput.content), authorId: 'user', publicationRevision: lateRevision + 1 });
  const afterInput = fast.publish('真人新输入后，另一条已有气泡实际发布了新正文。');
  const next = f.read();
  expect(next.lastNarrativePublicationRef).toEqual({ messageId: afterInput.id, contentChecksum: hash(afterInput.content), authorId: 'reader', publicationRevision: lateRevision + 2 });
  expect(next.lastInputPublicationRef).toEqual(view.lastInputPublicationRef);
});

it.each(['narrative', 'input'] as const)('redacts an unavailable latest %s head for one owner without falling back or hiding it for another owner', target => {
  const f = fixture(), oldSource = f.append('较早可见输入。'), old = f.draft(oldSource).publish('较早可见正文。');
  const source = f.append('最新实际输入。'), current = f.draft(source).publish('最新实际正文。');
  const hidden = target === 'narrative' ? current : source;
  f.store.request({ type: 'memory.forget', companionId: 'reader', conversationId: f.room.id, sourceMessageIds: [hidden.id] });
  const own = f.read(), other = f.read('peer');
  expect(own.lastNarrativePublicationAvailability).toBe('unavailable');
  expect(own.lastNarrativePublicationRef).toBeUndefined();
  expect(JSON.stringify(own)).not.toContain(current.id); expect(JSON.stringify(own)).not.toContain(hash(current.content));
  expect(other.lastNarrativePublicationRef?.messageId).toBe(current.id);
  expect(other.lastNarrativePublicationRef?.messageId).not.toBe(old.id);
  if (target === 'input') {
    expect(own.lastInputPublicationAvailability).toBe('unavailable'); expect(own.lastInputPublicationRef).toBeUndefined();
    expect(JSON.stringify(own)).not.toContain(source.id); expect(other.lastInputPublicationRef?.messageId).toBe(source.id);
  } else expect(own.lastInputPublicationRef?.messageId).toBe(source.id);
});

it('uses the same-id current body checksum and publication version, while exact replay does not create another publication', () => {
  const f = fixture(), source = f.append('实际输入。'), pending = f.draft(source), first = pending.publish('第一版实际正文。');
  const initial = f.read(); pending.publish(first.content);
  expect(f.read().lastNarrativePublicationRef).toEqual(initial.lastNarrativePublicationRef);
  const revised = pending.publish('同一实际消息已经正式修改后的正文。'), view = f.read();
  expect(view.lastNarrativePublicationRef).toEqual({ messageId: first.id, contentChecksum: hash(revised.content), authorId: 'reader',
    publicationRevision: initial.formalPublicationRevision! + 1 });
  expect(view.lastNarrativePublicationRef?.contentChecksum).not.toBe(hash(first.content));
  expect(view.lastInputPublicationRef).toEqual(initial.lastInputPublicationRef);
});

it('fails closed on changed bytes below the latest publication index rather than selecting an older visible narrative', () => {
  const f = fixture(), source = f.append('真实输入。'); f.draft(source).publish('旧可读正文。');
  const current = f.draft(source).publish('最新正式正文。');
  f.sql(db => db.prepare('UPDATE messages SET content=? WHERE id=?').run('实际字节已变化，但并未重新正式发布。', current.id));
  const view = f.read();
  expect(view.lastNarrativePublicationAvailability).toBe('unavailable'); expect(view.lastNarrativePublicationRef).toBeUndefined();
  expect(JSON.stringify(view)).not.toContain(current.id); expect(JSON.stringify(view)).not.toContain(hash(current.content));
});

it.each(['input', 'narrative'] as const)('marks legacy missing-index %s order unknown unless the actual latest-publication pointer proves that class', latest => {
  const f = fixture(), source = f.append('旧版原始输入。'), formal = f.draft(source).publish('旧版实际叙事。');
  const last = latest === 'input' ? f.append('旧版最后一次发布是新输入。') : formal;
  const before = f.read();
  f.sql(db => db.prepare("DELETE FROM metadata WHERE key GLOB 'message-topic-publication/*'").run());
  const view = f.read();
  if (latest === 'input') {
    expect(view.lastInputPublicationAvailability).toBe('available'); expect(view.lastInputPublicationRef?.messageId).toBe(last.id);
    expect(view.lastNarrativePublicationAvailability).toBe('legacy_order_unknown'); expect(view.lastNarrativePublicationRef).toBeUndefined();
  } else {
    expect(view.lastNarrativePublicationAvailability).toBe('available'); expect(view.lastNarrativePublicationRef?.messageId).toBe(last.id);
    expect(view.lastInputPublicationAvailability).toBe('legacy_order_unknown'); expect(view.lastInputPublicationRef).toBeUndefined();
  }
  expect(view.formalPublicationRevision).toBe(before.formalPublicationRevision);
});

it('returns none for an actually empty topic and never exposes a forged other-room publication reference', () => {
  const f = fixture(), empty = f.read();
  expect(empty.lastNarrativePublicationAvailability).toBe('none'); expect(empty.lastInputPublicationAvailability).toBe('none');
  const privateRoom = f.store.openPrivate('peer'), secret = f.store.appendMessage({ conversationId: privateRoom.id, authorId: 'peer', content: 'PRIVATE_OTHER_ROOM_884', replyDirective: 'none' });
  f.sql(db => db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('message-topic-publication/' + secret.id,
    JSON.stringify({ topicId: f.topic.id, revision: 1, checksum: hash(secret.content) })));
  const own = f.read();
  expect(own.lastNarrativePublicationRef).toBeUndefined(); expect(JSON.stringify(own)).not.toContain(secret.id);
  expect(JSON.stringify(own)).not.toContain(hash(secret.content)); expect(JSON.stringify(own)).not.toContain('PRIVATE_OTHER_ROOM_884');
});

it('keeps an unverified system input unavailable without hiding the narrative or falling back after SQLite restart', () => {
  const f = fixture(), source = f.append('真实先前输入。'), formal = f.draft(source).publish('最后正式叙事不会被系统输入覆盖。');
  const system = f.store.appendMessage({ conversationId: f.room.id, topicId: f.topic.id, authorId: 'system', kind: 'notice', content: '实际宿主输入记录。', replyDirective: 'none' });
  const before = f.read();
  expect(before.lastNarrativePublicationRef?.messageId).toBe(formal.id);
  // A generic notice has no host world-observation source receipt. It cannot
  // become readable just because it is the latest indexed input publication.
  expect(before.lastInputPublicationAvailability).toBe('unavailable'); expect(before.lastInputPublicationRef).toBeUndefined();
  expect(JSON.stringify(before)).not.toContain(system.id);
  const reopened = new CompanionsStore(f.file, []); resources.push({ root: f.root, store: reopened });
  const current = reopened.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader' }).topic!;
  expect(current.lastNarrativePublicationRef).toEqual(before.lastNarrativePublicationRef);
  expect(current.lastInputPublicationRef).toEqual(before.lastInputPublicationRef);
  expect(current.lastNarrativePublicationAvailability).toBe('available'); expect(current.lastInputPublicationAvailability).toBe('unavailable');
});

it('does not expose old raw publication IDs or hashes to an actual late joiner who can only read the shared checkpoint', () => {
  const f = fixture(), source = f.append('晚加入者未获权的较早原始输入。'), formal = f.draft(source).publish('晚加入者未获权的正式正文。');
  const current = f.read();
  f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader', expectedRevision: current.revision,
    patch: { shared: { summary: '已公开给后加入者的最小共享阶段。', sourceMessageIds: [source.id, formal.id] } } });
  const newMember = f.store.createCompanion({ name: 'Late', persona: '后来真实加入', description: '', model: '', avatar: 'sister', proactive: false });
  f.store.setCompanionActive(newMember.id, true);
  f.store.updateConversation(f.room.id, { memberIds: ['reader', 'peer', newMember.id] });
  const latest = f.read();
  f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: f.topic.id, readerId: 'user', expectedRevision: latest.revision,
    patch: { invitedIds: [newMember.id] } });
  f.store.request({ type: 'topic.join', conversationId: f.room.id, topicId: f.topic.id, readerId: newMember.id });
  expect(f.store.request({ type: 'memory.sources.filter', companionId: newMember.id, conversationId: f.room.id, ids: [source.id, formal.id] }).memorySources).toEqual([]);
  const late = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: f.topic.id, readerId: newMember.id });
  expect(late.topicState?.shared?.summary).toBe('已公开给后加入者的最小共享阶段。');
  expect(late.topic?.lastPublicationAvailability).toBe('unavailable'); expect(late.topic?.lastPublicationRef).toBeUndefined();
  expect(late.topic?.lastNarrativePublicationAvailability).toBe('unavailable'); expect(late.topic?.lastNarrativePublicationRef).toBeUndefined();
  expect(late.topic?.lastInputPublicationAvailability).toBe('unavailable'); expect(late.topic?.lastInputPublicationRef).toBeUndefined();
  for (const hidden of [source.id, formal.id, hash(source.content), hash(formal.content)]) expect(JSON.stringify(late.topic)).not.toContain(hidden);
  const owner = f.read();
  expect(owner.lastPublicationAvailability).toBe('available'); expect(owner.lastPublicationRef?.messageId).toBe(formal.id);
  expect(owner.lastNarrativePublicationRef?.messageId).toBe(formal.id); expect(owner.lastInputPublicationRef?.messageId).toBe(source.id);
});
