/** Structural host/SQLite verification; no actor decisions or model transport. */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { companionStorageResponseSchema, type CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionMessage } from '../../src/shared/companions';
import { ensureTopicContinuity } from '../../src/main/companions/topic-compaction';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';

vi.mock('../../src/main/companions/topic-narrative-references', () => ({ prepareTopicNarrativeReferences: async () => ({
  status: 'abstained', scope: 'recent_authorized_formal_story_text_not_a_permanent_identity_ledger', selectedSources: [], references: [], conflicts: [],
}) }));
vi.mock('../../src/main/companions/topic-summary-canon-review', () => ({ reviewTopicSummaryCanon: async () => undefined }));

const open: Array<{ root: string; store: CompanionsStore }> = [];
const Database = BetterSqlite3 as unknown as { new(file: string): CompanionConnection };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const watermark = (value: unknown) => Number((value as { throughSequence: number }).throughSequence);
afterEach(() => {
  const current = open.splice(0);
  for (const { store } of current) store.close();
  for (const root of new Set(current.map(item => item.root))) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('topic-late-publication-'))
      throw new Error('Unexpected publication source fixture root.');
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'topic-late-publication-')), file = path.join(root, 'messages.sqlite');
  const seeds: CompanionSeed[] = ['reader', 'peer', 'outsider'].map(id => ({ id, name: id, description: '', persona: '独立角色', model: '', avatar: 'sister', proactive: false, active: true }));
  const store = new CompanionsStore(file, seeds); open.push({ root, store });
  const room = store.createConversation('来源权限机制', ['reader', 'peer']);
  const topic = store.request({ type: 'topic.create', conversationId: room.id, readerId: 'user', kind: 'discussion', title: '真实正式记录' }).topic!;
  for (const readerId of ['reader', 'peer']) store.request({ type: 'topic.join', conversationId: room.id, topicId: topic.id, readerId });
  const read = () => store.request({ type: 'topic.read', conversationId: room.id, topicId: topic.id, readerId: 'reader' });
  const append = (content: string) => store.appendMessage({ conversationId: room.id, topicId: topic.id, authorId: 'user', content, replyDirective: 'none' });
  const draft = (source: CompanionMessage) => {
    const message = store.appendMessage({ conversationId: room.id, topicId: topic.id, authorId: 'reader', replyToId: source.id,
      content: '', loopStep: 0, replyDirective: 'none' });
    const checkpoint: CompanionLoopCheckpoint = { companionId: 'reader', conversationId: room.id, sourceMessageId: source.id,
      messageId: message.id, status: 'running', supplements: [], turns: [] };
    store.request({ type: 'loop.save', checkpoint });
    return { message, publish: (text: string) => {
      store.request({ type: 'loop.save', checkpoint: { ...checkpoint, status: 'done', turns: [{ text, rawText: text, calls: [] }] } });
      return store.getMessage(message.id);
    } };
  };
  const page = (overrides: Partial<Extract<CompanionStorageCommand, { type: 'topic.compaction.sources' }>> = {}) => {
    const response = store.request({ type: 'topic.compaction.sources', conversationId: room.id, topicId: topic.id, readerId: 'reader',
      afterPublicationRevision: 0, legacyAfterSequence: 0, beforeSequence: Number.MAX_SAFE_INTEGER, limit: 100, ...overrides });
    // The same typed boundary is used by native-worker replies, so missing
    // fields or hashes cannot pass only because a test calls Store directly.
    return companionStorageResponseSchema.parse(response).topicCompactionPage!;
  };
  const sql = (operation: (db: CompanionConnection) => void) => {
    const db = new Database(file);
    db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
    db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
    try { operation(db); } finally { db.close(); }
  };
  return { root, file, seeds, store, room, topic, read, append, draft, page, sql };
}

it('returns exact actual formal bytes in publication order after an old draft publishes and a newer pointer replaces it', () => {
  const f = fixture(), original = f.append('实际最初请求。'), delayed = f.draft(original);
  const next = f.append('另一条实际请求。'), fast = f.draft(next), fastFormal = fast.publish('先正式发布的动作。');
  const watermark = f.read().topic!.formalPublicationRevision!;
  const late = delayed.publish('旧创建序号，新的实际正式动作。');
  const later = f.append('后来公开的记录，不包含前一动作。');
  const page = f.page({ afterPublicationRevision: watermark });
  expect(page.items.map(item => item.message.id)).toEqual([late.id, later.id]);
  expect(late.sequence).toBeLessThan(fastFormal.sequence);
  expect(page.items.map(item => item.publicationRevision)).toEqual([watermark + 1, watermark + 2]);
  expect(page.items[0]).toMatchObject({ message: { content: late.content, status: 'sent' }, sourceChecksum: hash(late.content) });
  expect(page.items.every(item => !item.message.isReplyDraft && !item.message.replyDraft)).toBe(true);
  expect(page.legacyComplete).toBe(true); expect(page.hasMore).toBe(false);
  expect(f.read().topic!.lastPublicationRef!.messageId).toBe(later.id);
});

it('revisits a same-id actual revision with its new checksum while exact replay and summary-only updates do not republish', () => {
  const f = fixture(), source = f.append('原始公开请求。'), pending = f.draft(source);
  const first = pending.publish('第一版正式内容。'), before = f.read().topic!.formalPublicationRevision!;
  pending.publish(first.content);
  expect(f.read().topic!.formalPublicationRevision).toBe(before);
  const view = f.read();
  f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader', expectedRevision: view.topic!.revision,
    patch: { workingState: { summary: '本人仅更新工作摘要。', sourceMessageIds: [source.id] } } });
  expect(f.read().topic!.formalPublicationRevision).toBe(before);
  const revised = pending.publish('同一实际消息的新修订内容。'), page = f.page({ afterPublicationRevision: before });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ message: { id: first.id, content: revised.content }, publicationRevision: before + 1, sourceChecksum: hash(revised.content) });
  expect(page.items[0]!.sourceChecksum).not.toBe(hash(first.content));
});

it('redacts withdrawn sources per owner without leaking ids or hashes and still advances a hidden-only page', () => {
  const f = fixture(), secret = f.append('REDACTED_SOURCE_731：本人已要求忘记。'), visible = f.append('后续仍可见的实际原文。');
  f.store.request({ type: 'memory.forget', companionId: 'reader', conversationId: f.room.id, sourceMessageIds: [secret.id] });
  const first = f.page({ limit: 1 });
  expect(first.items).toEqual([]); expect(first.afterPublicationRevision).toBe(1); expect(first.hasMore).toBe(true);
  expect(JSON.stringify(first)).not.toContain(secret.id); expect(JSON.stringify(first)).not.toContain(hash(secret.content));
  const second = f.page({ afterPublicationRevision: first.afterPublicationRevision, throughPublicationRevision: first.throughPublicationRevision,
    legacyAfterSequence: first.legacyScannedThroughSequence, legacyThroughSequence: first.legacyThroughSequence, limit: 1 });
  expect(second.items.map(item => item.message.id)).toEqual([visible.id]);
  expect(f.page({ readerId: 'peer' }).items.map(item => item.message.id)).toEqual([secret.id, visible.id]);
});

it('keeps a derived formal reply out when its real source is withdrawn while another owner retains actual visibility', () => {
  const f = fixture(), source = f.append('可撤回的真实请求。'), derived = f.draft(source).publish('依赖真实请求的正式回复。');
  f.store.request({ type: 'memory.forget', companionId: 'reader', conversationId: f.room.id, sourceMessageIds: [source.id] });
  const page = f.page();
  expect(page.items).toEqual([]); expect(page.afterPublicationRevision).toBe(page.throughPublicationRevision);
  expect(JSON.stringify(page)).not.toContain(derived.id);
  expect(f.page({ readerId: 'peer' }).items.map(item => item.message.id)).toEqual([source.id, derived.id]);
});

it('fails closed on mismatched stored publication bytes and never returns another room or topic through a forged index row', () => {
  const f = fixture(), source = f.append('已登记的真实内容。');
  f.sql(db => db.prepare('UPDATE messages SET content=? WHERE id=?').run('实际字节已变，登记checksum尚未变化。', source.id));
  expect(f.page().items).toEqual([]);
  const privateRoom = f.store.openPrivate('peer'), privateMessage = f.store.appendMessage({ conversationId: privateRoom.id, authorId: 'user', content: 'PRIVATE_ROOM_CANARY_52', replyDirective: 'none' });
  const otherTopic = f.store.request({ type: 'topic.create', conversationId: f.room.id, readerId: 'user', kind: 'discussion', title: '另一端口' }).topic!;
  f.store.request({ type: 'topic.join', conversationId: f.room.id, topicId: otherTopic.id, readerId: 'reader' });
  const otherMessage = f.store.appendMessage({ conversationId: f.room.id, topicId: otherTopic.id, authorId: 'user', content: 'OTHER_TOPIC_CANARY_53', replyDirective: 'none' });
  f.sql(db => {
    for (const message of [privateMessage, otherMessage]) db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)')
      .run('message-topic-publication/' + message.id, JSON.stringify({ topicId: f.topic.id, revision: 1, checksum: hash(message.content) }));
  });
  const page = f.page(); expect(page.items).toEqual([]);
  expect(JSON.stringify(page)).not.toMatch(/PRIVATE_ROOM_CANARY|OTHER_TOPIC_CANARY/);
});

it('requires an actual companion participant and rejects foreign room/topic and withdrawn invocation source', () => {
  const f = fixture(), source = f.append('真实当前调用源。'), other = f.store.openPrivate('peer');
  expect(() => f.page({ readerId: 'user' })).toThrow();
  expect(() => f.page({ readerId: 'outsider' })).toThrow();
  expect(() => f.page({ conversationId: other.id })).toThrow();
  expect(f.page({ sourceMessageId: source.id, sourceChecksum: hash(source.content), beforeSequence: source.sequence }).items.map(item => item.message.id)).toEqual([source.id]);
  expect(() => f.page({ sourceMessageId: source.id, beforeSequence: source.sequence })).toThrow('来源已经失效');
  expect(() => f.page({ sourceMessageId: source.id, sourceChecksum: hash('changed source'), beforeSequence: source.sequence })).toThrow('原文变化');
  f.store.request({ type: 'memory.forget', companionId: 'reader', conversationId: f.room.id, sourceMessageIds: [source.id] });
  expect(() => f.page({ sourceMessageId: source.id, sourceChecksum: hash(source.content), beforeSequence: source.sequence })).toThrow('来源已经失效');
});

it('preserves publication metadata across native SQLite restart without turning an unpublished draft into a source', () => {
  const f = fixture(), source = f.append('重启前正式的请求。'), pending = f.draft(source), formal = f.draft(source).publish('重启前正式的回应。');
  const reopened = new CompanionsStore(f.file, f.seeds); open.push({ root: f.root, store: reopened });
  const response = reopened.request({ type: 'topic.compaction.sources', conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader',
    afterPublicationRevision: 0, legacyAfterSequence: 0, beforeSequence: Number.MAX_SAFE_INTEGER });
  expect(response.topicCompactionPage!.items.map(item => item.message.id)).toEqual([source.id, formal.id]);
  expect(JSON.stringify(response.topicCompactionPage)).not.toContain(pending.message.id);
});

it('actually compacts a late old-sequence formal after the last-publication pointer moves to a newer message', async () => {
  const f = fixture(), source = f.append('开始公开过程。'), delayed = f.draft(source), batches: CompanionMessage[][] = [];
  const initial = Array.from({ length: 8 }, (_, index) => f.append('初始事实_' + index + '：' + '仅保留真实已做事项。'.repeat(12)));
  const compress = async (capacityFeedback = false) => {
    const view = f.read(), recent = f.store.messages({ conversationId: f.room.id, topicId: f.topic.id, limit: 100 }).messages;
    const frame: CompanionReplyInput = { companion: f.store.state().companions.find(role => role.id === 'reader')!, conversation: f.room,
      topic: view.topic, topicState: view.topicState, messages: recent, sourceMessage: recent.at(-1), memories: [] };
    return ensureTopicContinuity({ frame, request: async command => f.store.request(command), capacityFeedback,
      config: { model: 'never-dispatched', apiKey: 'never-dispatched', apiFormat: 'openai_chat' },
      fetchFn: async () => { throw new Error('No model transport is authorized by this structural test.'); },
      policy: { maxMessages: 6, maxChars: 10000, thresholdRatio: .8, retainRatio: .16, minimumTailMessages: 1 },
      extractCanon: async () => ({ additions: [], revisions: [] }), review: async () => ({ supported: true, issues: [] }),
      summarize: async context => { const data = JSON.parse(context.user); batches.push(data.messages);
        return { summary: [data.priorCheckpoint?.summary, ...data.messages.map((message: CompanionMessage) => message.content)].filter(Boolean).join(' / '), stage: '真实公开阶段' }; } });
  };
  await compress();
  const oldThrough = watermark(f.read().topicState!.workingState!.state!.__continuity);
  expect(oldThrough).toBeGreaterThan(delayed.message.sequence);
  const late = delayed.publish('LATE_FACT_ONLY_47：琥珀筹码现在放在锁住的抽屉内。');
  const newer = f.append('后来正式记录只描述当前等待，不重复筹码事实。');
  expect(f.read().topic!.lastPublicationRef!.messageId).toBe(newer.id);
  let result = await compress(true);
  for (let pass = 0; pass < 2 && !batches.flat().some(message => message.id === late.id); pass++) result = await compress(true);
  expect(batches.flat().some(message => message.id === late.id && message.content === late.content)).toBe(true);
  expect(f.read().topicState!.workingState!.summary).toContain(late.content);
  expect(watermark(f.read().topicState!.workingState!.state!.__continuity)).toBeGreaterThanOrEqual(oldThrough);
  expect(new Set([...batches.flat().map(message => message.id), ...result.messages.map(message => message.id)])).toContain(initial.at(-1)!.id);
});

it('calibrates an actual old checkpoint once and never mistakes copied continuity metadata for a newly summarized body', async () => {
  const f = fixture(), original = f.append('旧版实际起点。'), delayed = f.draft(original), batches: Array<Array<{ id: string; content: string }>> = [];
  const initial = Array.from({ length: 8 }, (_, index) => f.append('LEGACY_FORMAL_' + index + '：' + '这是旧版已正式发生的公开内容。'.repeat(9)));
  const compress = async () => {
    const view = f.read(), all = f.store.messages({ conversationId: f.room.id, topicId: f.topic.id, limit: 100 }).messages;
    return ensureTopicContinuity({ frame: { companion: f.store.state().companions.find(role => role.id === 'reader')!, conversation: f.room,
      topic: view.topic, topicState: view.topicState, messages: all, sourceMessage: all.at(-1), memories: [] },
      request: async command => f.store.request(command), capacityFeedback: batches.length > 0,
      config: { model: 'never-dispatched', apiKey: 'never-dispatched', apiFormat: 'openai_chat' },
      fetchFn: async () => { throw new Error('Legacy coverage verification must not use model transport.'); },
      policy: { maxMessages: 6, maxChars: 10000, thresholdRatio: .8, retainRatio: .16, minimumTailMessages: 1 },
      extractCanon: async () => ({ additions: [], revisions: [] }), review: async () => ({ supported: true, issues: [] }),
      summarize: async context => { const data = JSON.parse(context.user); batches.push(data.messages);
        return { summary: [data.priorCheckpoint?.summary, ...data.messages.map((message: CompanionMessage) => message.content)].filter(Boolean).join(' / '), stage: '真实旧档恢复阶段' }; } });
  };
  await compress();
  const actuallySummarized = new Set(batches.flat().map(message => message.id)), countBeforeMigration = batches.length;
  expect(actuallySummarized.has(initial[0]!.id)).toBe(true);
  const originalEvent = f.read().topicState!.workingState!, originalThrough = watermark(originalEvent.state!.__continuity);
  const copiedMarkerBody = f.append('LEGACY_UNSUMMARIZED_MARKER_COPY：该事实从未进入旧摘要。'), view = f.read();
  // A real structured-state update retains the old continuity marker but has
  // a different direct source set. Its copied digest is not proof of summary.
  f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: f.topic.id, readerId: 'reader', expectedRevision: view.topic!.revision,
    patch: { workingState: { state: { actualPhase: 'structured-state-only' }, sourceMessageIds: [copiedMarkerBody.id] } } });
  expect(f.read().topicState!.workingState!.summary).toBe(originalEvent.summary);
  f.sql(db => {
    // Fixture-only migration: keep original events, raw source IDs/checksums,
    // and actual sourceDigest. Remove only the new-version coverage/index.
    db.prepare("UPDATE companion_topic_state SET data=json_remove(data,'$.state.__continuity.publicationCoverage') WHERE topic_id=?").run(f.topic.id);
    db.prepare("UPDATE companion_topic_events SET data=json_remove(data,'$.state.__continuity.publicationCoverage') WHERE topic_id=?").run(f.topic.id);
    db.prepare("DELETE FROM metadata WHERE key GLOB 'message-topic-publication/*'").run();
  });
  const late = delayed.publish('ACTUAL_MIGRATED_LATE_47：旧气泡刚刚才正式发布。');
  f.append('实际新请求，沿用同一公开过程。');
  const page = f.page(), legacy = page.items.filter(item => item.legacyOrderUnknown);
  expect(legacy.some(item => item.message.id === copiedMarkerBody.id)).toBe(true);
  expect(legacy.every(item => !actuallySummarized.has(item.message.id))).toBe(true);
  expect(page.items.some(item => item.message.id === late.id && item.publicationRevision !== undefined && !item.legacyOrderUnknown)).toBe(true);
  for (let pass = 0; pass < 5 && !batches.slice(countBeforeMigration).flat().some(message => message.id === late.id); pass++) await compress();
  const migratedInputs = batches.slice(countBeforeMigration).flat();
  expect(migratedInputs.some(message => message.id === copiedMarkerBody.id)).toBe(true);
  expect(migratedInputs.some(message => message.id === late.id && message.content === late.content)).toBe(true);
  expect(migratedInputs.every(message => !actuallySummarized.has(message.id))).toBe(true);
  expect(f.read().topicState!.workingState!.summary).toContain(late.content);
  expect(watermark(f.read().topicState!.workingState!.state!.__continuity)).toBeGreaterThanOrEqual(originalThrough);
});
