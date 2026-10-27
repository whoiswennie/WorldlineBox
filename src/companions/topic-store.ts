import { createHash, randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import { companionTopicSchema, type CompanionTopic, type CompanionTopicState } from '../shared/companion-topic';
import { persistTopicParticipation, type TopicParticipationReceipt } from './topic-participation';
import { companionTopicCheckpointValid, companionTopicCheckpointEventValid, companionTopicAncestorIds } from './topic-context';
import type { CompanionMessage } from '../shared/companions';
import { companionTopicNarrativeApprovalSchema, companionTopicPublicationApprovalSchema, companionTopicNarrativeBasis, companionTopicUserCanonSchema, type CompanionTopicNarrativeApproval, type CompanionTopicPublicationApproval, type CompanionTopicUserCanon } from '../shared/companion-topic-canon';
import { companionMessageFictionalLineage } from './fictional-source';

type Row = Record<string, string | number | null>;
const row = (value: unknown) => value as Row;
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
type Command = Extract<CompanionStorageCommand, { type: `topic.${string}` }>;
type PublicationBasis = { companionId: string; conversationId: string; topicId: string; revision: number; checksum: string; canon?: CompanionTopicUserCanon };
type PublicationCommand = Extract<Command, { type: 'topic.compaction.sources' }>;
export interface TopicPublicationSourcePage {
  items: { messageId: string; publicationRevision?: number; sourceChecksum: string; legacyOrderUnknown?: true }[];
  afterPublicationRevision: number; throughPublicationRevision: number;
  legacyScannedThroughSequence: number; legacyThroughSequence: number; legacyComplete: boolean; hasMore: boolean;
}
/** Shared canonical state and each participant's private working memory have separate storage and projections. */
export class CompanionTopicStore {
  constructor(private readonly db: CompanionConnection, private readonly members: (conversationId: string) => string[],
    private readonly participation?: (receipt: TopicParticipationReceipt) => void,
    private readonly changed?: (conversationId: string, topicId: string, readerId?: string) => void,
    private readonly checkpointSourcesValid?: (conversationId: string, readerId: string, sourceMessageIds: readonly string[]) => boolean,
    private readonly publicationSourcesValid?: (conversationId: string, readerId: string, sourceMessageIds: readonly string[]) => boolean) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_topics(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_topics_room ON companion_topics(conversation_id,id);
      CREATE TABLE IF NOT EXISTS companion_topic_current(conversation_id TEXT NOT NULL REFERENCES conversations(id),reader_id TEXT NOT NULL,topic_id TEXT REFERENCES companion_topics(id),PRIMARY KEY(conversation_id,reader_id));
      CREATE TABLE IF NOT EXISTS companion_topic_state(topic_id TEXT NOT NULL REFERENCES companion_topics(id),reader_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(topic_id,reader_id));
      CREATE TABLE IF NOT EXISTS companion_topic_participation(topic_id TEXT NOT NULL REFERENCES companion_topics(id),reader_id TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(topic_id,reader_id));
      CREATE TABLE IF NOT EXISTS companion_topic_events(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL REFERENCES companion_topics(id),reader_id TEXT NOT NULL,author_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_message_topics(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,topic_id TEXT NOT NULL REFERENCES companion_topics(id));
      CREATE INDEX IF NOT EXISTS companion_message_topic ON companion_message_topics(topic_id,message_id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS companion_topic_publication_page ON metadata(json_extract(value,'$.topicId'),CAST(json_extract(value,'$.revision') AS INTEGER)) WHERE key GLOB 'message-topic-publication/*'`);
  }
  /** A chat always owns an explicit persistent primary topic. */
  ensurePrimary(conversationId: string): CompanionTopic | undefined {
    const peerOnly = !!this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + conversationId);
    const members = this.members(conversationId);
    // A one-owner world evidence port is not dialogue. Real peer pairs and
    // groups use the same persistent topic/context path as player chats.
    if (peerOnly && members.length < 2) return;
    return this.db.transaction(() => {
      const key = 'primary-chat-topic/' + conversationId;
      const saved = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined;
      if (saved) {
        const topic = this.topic(saved.value, conversationId), participants = peerOnly ? members : ['user', ...members];
        if (JSON.stringify(topic.participantIds) !== JSON.stringify(participants)) {
          topic.participantIds = participants; topic.invitedIds = []; topic.revision++; topic.updatedAt = new Date().toISOString();
          this.db.prepare('UPDATE companion_topics SET data=? WHERE id=?').run(JSON.stringify(topic), topic.id);
          for (const reader of participants) this.db.prepare('INSERT OR IGNORE INTO companion_topic_current(conversation_id,reader_id,topic_id) VALUES(?,?,?)').run(conversationId, reader, topic.id);
        }
        return topic;
      }
      const room = this.db.prepare('SELECT kind,updated_at FROM conversations WHERE id=? AND dissolved_at IS NULL').get(conversationId) as { kind: string; updated_at: string } | undefined;
      if (!room) return;
      const id = 'main_' + createHash('sha256').update(conversationId).digest('hex').slice(0, 48);
      const topic: CompanionTopic = { id, conversationId, title: room.kind === 'group' ? '主要群聊' : '主要对话', kind: 'discussion', status: 'active',
        isPrimary: true, participantIds: peerOnly ? members : ['user', ...members], invitedIds: [], tags: [],
        moderatorId: peerOnly ? members[0]! : 'user', revision: 1, createdAt: room.updated_at, updatedAt: room.updated_at };
      this.db.prepare('INSERT INTO companion_topics(id,conversation_id,data) VALUES(?,?,?)').run(id, conversationId, JSON.stringify(topic));
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key, id);
      for (const reader of topic.participantIds) this.db.prepare('INSERT OR IGNORE INTO companion_topic_current(conversation_id,reader_id,topic_id) VALUES(?,?,?)').run(conversationId, reader, id);
      return topic;
    }).immediate();
  }
  primaryId(conversationId: string): string | undefined {
    const found = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('primary-chat-topic/' + conversationId) as { value: string } | undefined;
    return found?.value;
  }
  current(conversationId: string, readerId = 'user'): string | undefined {
    const found = this.db.prepare('SELECT topic_id FROM companion_topic_current WHERE conversation_id=? AND reader_id=?').get(conversationId, readerId);
    return found && row(found).topic_id ? String(row(found).topic_id) : undefined;
  }
  messageTopic(messageId: string): string | undefined {
    const found = this.db.prepare('SELECT topic_id FROM companion_message_topics WHERE message_id=?').get(messageId);
    return found ? String(row(found).topic_id) : undefined;
  }
  topic(id: string, conversationId: string): CompanionTopic {
    const found = this.db.prepare('SELECT data FROM companion_topics WHERE id=? AND conversation_id=?').get(id, conversationId);
    if (!found) throw new Error('话题不存在或属于别的会话。');
    return companionTopicSchema.parse(decode(row(found).data));
  }
  bindMessage(messageId: string, conversationId: string, authorId: string, topicId: string | null | undefined, replyToId?: string, draft = false): void {
    const inherited = replyToId ? this.messageTopic(replyToId) : undefined;
    const primary = this.ensurePrimary(conversationId)?.id;
    const normalized = topicId === null ? primary : topicId;
    const chosen = replyToId ? inherited : normalized ?? (authorId === 'user' ? this.current(conversationId, authorId) : undefined) ?? primary;
    if (replyToId && topicId !== undefined && normalized !== inherited) throw new Error('回复必须保留实际来源的话题，不能随当前选中项切换。');
    if (!chosen) return;
    const topic = this.topic(chosen, conversationId);
    if (topic.deletedAt) throw new Error('话题已删除，不能继续向原话题发言。');
    if (topic.status !== 'active' && !replyToId) throw new Error('话题已暂停或结束，请先恢复或切回普通聊天。');
    if (authorId !== 'system' && this.paused(topic.id, authorId)) throw new Error('本人已暂停这个话题，请先恢复再发言。');
    if (authorId !== 'system' && !topic.participantIds.includes(authorId) && !(draft && topic.invitedIds.includes(authorId))) throw new Error('请先自主加入这个话题，再正式发言。');
    this.db.prepare('INSERT INTO companion_message_topics(message_id,topic_id) VALUES(?,?) ON CONFLICT(message_id) DO UPDATE SET topic_id=excluded.topic_id').run(messageId, chosen);
  }
  fictionalMessage(messageId: string): boolean {
    return companionMessageFictionalLineage(this.db, messageId);
  }
  /** Called only inside the formal reply/loop commit transaction. Approval is
   * bound to actual committed bytes; it is never read from model state JSON. */
  recordNarrativeTime(message: CompanionMessage, input: Omit<CompanionTopicNarrativeApproval, 'userCanon'> & { userCanon?: unknown }): void {
    this.recordNarrativeState(message, companionTopicNarrativeApprovalSchema.parse(input));
  }
  publicationBasis(message: CompanionMessage): PublicationBasis | undefined {
    if (!message.topicId) return;
    const topic = this.topic(message.topicId, message.conversationId); this.allowed(topic, message.authorId);
    const previous = this.state(topic, message.authorId).workingState;
    const canon = companionTopicUserCanonSchema.safeParse(previous?.state?.__topicUserCanon);
    return { companionId: message.authorId, conversationId: message.conversationId, topicId: topic.id,
      revision: topic.formalPublicationRevision ?? 0, checksum: createHash('sha256').update(companionTopicNarrativeBasis(previous)).digest('hex'),
      ...(canon.success ? { canon: canon.data } : {}) };
  }
  recordPublication(message: CompanionMessage, input: CompanionTopicPublicationApproval, clock?: CompanionTopicNarrativeApproval, exactReplay = false, basis?: PublicationBasis): void {
    this.recordNarrativeState(message, clock ? companionTopicNarrativeApprovalSchema.parse(clock) : undefined,
      companionTopicPublicationApprovalSchema.parse(input), exactReplay, basis);
  }
  /** The actual publication transaction owns this bounded counter. It is not
   * an execution receipt, source permission, clock value or model patch field. */
  noteFormalPublication(message: CompanionMessage): void {
    if (!message.topicId || message.status !== 'sent' || message.isReplyDraft || message.replyDraft || !message.content.trim()) return;
    const topic = this.topic(message.topicId, message.conversationId);
    if (topic.deletedAt) return;
    const revision = topic.formalPublicationRevision ?? 0;
    if (!Number.isSafeInteger(revision + 1)) throw new Error('话题正式发布版本已超过安全范围。');
    this.db.prepare('UPDATE companion_topics SET data=json_set(data,\'$.formalPublicationRevision\',?,\'$.lastPublicationRef\',json(?)) WHERE id=? AND conversation_id=?')
      .run(revision + 1, JSON.stringify({ messageId: message.id, contentChecksum: createHash('sha256').update(message.content).digest('hex'), authorId: message.authorId }), topic.id, topic.conversationId);
    this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('message-topic-publication/' + message.id,
      JSON.stringify({ topicId: topic.id, revision: revision + 1, checksum: createHash('sha256').update(message.content).digest('hex') }));
  }
  /** A bounded source projection, not a second event log. Each message keeps
   * only its latest actual publication revision. Legacy rows have no invented
   * publication order; their one-time creation scan is explicitly separate. */
  publicationPage(command: PublicationCommand): TopicPublicationSourcePage {
    const topic = this.topic(command.topicId, command.conversationId); this.allowed(topic, command.readerId);
    if (!topic.participantIds.includes(command.readerId)) throw new Error('只有实际参加者可以装配本人话题工作上下文。');
    const maximum = topic.formalPublicationRevision ?? 0;
    let horizon = maximum, legacyPortThrough = command.beforeSequence;
    if (command.sourceMessageId) {
      const source = this.db.prepare('SELECT m.sequence,m.content FROM messages m JOIN companion_message_topics t ON t.message_id=m.id WHERE m.id=? AND m.conversation_id=? AND t.topic_id=?').get(command.sourceMessageId, topic.conversationId, topic.id) as { sequence: number; content: string } | undefined;
      if (!source || !command.sourceChecksum || createHash('sha256').update(source.content).digest('hex') !== command.sourceChecksum
        || source.sequence > command.beforeSequence || !this.checkpointSourcesValid?.(topic.conversationId, command.readerId, [command.sourceMessageId])) throw new Error('话题压缩调用来源已经失效或原文变化。');
      legacyPortThrough = Math.min(legacyPortThrough, source.sequence);
      // Publication can legitimately finish after its bubble/root was created.
      // Stop before the first different future port instead of pretending that
      // source's own publication revision froze all earlier pending bubbles.
      const barrier = this.db.prepare(`SELECT MIN(CAST(json_extract(p.value,'$.revision') AS INTEGER)) AS revision
        FROM metadata p JOIN messages m ON p.key='message-topic-publication/'||m.id
        WHERE p.key GLOB 'message-topic-publication/*' AND json_extract(p.value,'$.topicId')=?
        AND CAST(json_extract(p.value,'$.revision') AS INTEGER)>? AND (m.sequence>? OR
          (m.sequence>? AND NOT(m.author_id!='user' AND COALESCE(m.reply_to_id,'')=?)))`)
        .get(topic.id, command.afterPublicationRevision, command.beforeSequence, source.sequence, command.sourceMessageId) as { revision: number | null };
      if (barrier.revision !== null) horizon = Math.min(horizon, barrier.revision - 1);
    } else {
      const barrier = this.db.prepare(`SELECT MIN(CAST(json_extract(p.value,'$.revision') AS INTEGER)) AS revision
        FROM metadata p JOIN messages m ON p.key='message-topic-publication/'||m.id
        WHERE p.key GLOB 'message-topic-publication/*' AND json_extract(p.value,'$.topicId')=?
        AND CAST(json_extract(p.value,'$.revision') AS INTEGER)>? AND m.sequence>?`)
        .get(topic.id, command.afterPublicationRevision, command.beforeSequence) as { revision: number | null };
      if (barrier.revision !== null) horizon = Math.min(horizon, barrier.revision - 1);
    }
    const throughPublicationRevision = command.throughPublicationRevision ?? horizon;
    if (throughPublicationRevision > horizon || command.afterPublicationRevision > throughPublicationRevision) throw new Error('话题发布扫描游标超出当前实际来源窗口。');
    const legacyThroughSequence = Math.min(command.legacyThroughSequence ?? legacyPortThrough, legacyPortThrough);
    if (command.legacyAfterSequence > legacyThroughSequence) throw new Error('旧话题来源端口早于已保存覆盖，保留当前进度停止旧调用。');
    const limit = command.limit ?? 100, items: TopicPublicationSourcePage['items'] = [];
    let legacyScannedThroughSequence = command.legacyAfterSequence;
    const legacyRows = this.db.prepare(`SELECT m.id,m.sequence,m.content FROM messages m JOIN companion_message_topics t ON t.message_id=m.id
      WHERE t.topic_id=? AND m.conversation_id=? AND m.sequence>? AND m.sequence<=?
      AND NOT EXISTS(SELECT 1 FROM metadata p WHERE p.key='message-topic-publication/'||m.id) ORDER BY m.sequence LIMIT ?`)
      .all(topic.id, topic.conversationId, command.legacyAfterSequence, legacyThroughSequence, limit) as { id: string; sequence: number; content: string }[];
    const consumed = legacyRows.length ? this.legacyCompactedSources(topic, command.readerId, new Set(legacyRows.map(source => source.id))) : new Set<string>();
    for (const source of legacyRows) {
      legacyScannedThroughSequence = source.sequence;
      if (!consumed.has(source.id)) items.push({ messageId: source.id, sourceChecksum: createHash('sha256').update(source.content).digest('hex'), legacyOrderUnknown: true });
    }
    const legacyComplete = legacyRows.length < limit;
    if (legacyComplete) legacyScannedThroughSequence = legacyThroughSequence;
    let afterPublicationRevision = command.afterPublicationRevision;
    if (legacyComplete && items.length < limit) {
      const available = limit - items.length;
      const publications = this.db.prepare(`SELECT key,value FROM metadata WHERE key GLOB 'message-topic-publication/*'
        AND json_extract(value,'$.topicId')=? AND CAST(json_extract(value,'$.revision') AS INTEGER)>?
        AND CAST(json_extract(value,'$.revision') AS INTEGER)<=? ORDER BY CAST(json_extract(value,'$.revision') AS INTEGER) LIMIT ?`)
        .all(topic.id, afterPublicationRevision, throughPublicationRevision, available) as { key: string; value: string }[];
      for (const entry of publications) {
        const publication = decode<{ revision: number; checksum: string }>(entry.value);
        afterPublicationRevision = publication.revision;
        items.push({ messageId: entry.key.slice('message-topic-publication/'.length), publicationRevision: publication.revision, sourceChecksum: publication.checksum });
      }
      if (publications.length < available) afterPublicationRevision = throughPublicationRevision;
    }
    return { items, afterPublicationRevision, throughPublicationRevision, legacyScannedThroughSequence, legacyThroughSequence, legacyComplete,
      hasMore: !legacyComplete || afterPublicationRevision < throughPublicationRevision };
  }
  private legacyCompactedSources(topic: CompanionTopic, readerId: string, candidates: ReadonlySet<string>): Set<string> {
    const checkpoint = this.state(topic, readerId).workingState;
    const consumed = new Set<string>(), pending = checkpoint ? [checkpoint.sourceEventId] : [], visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id);
      const found = this.db.prepare('SELECT data FROM companion_topic_events WHERE id=?').get(id) as { data: string } | undefined;
      if (!found) continue;
      const event = decode<NonNullable<CompanionTopicState['workingState']>>(found.data);
      const continuity = event.state?.__continuity as { sourceDigest?: string; compactedMessages?: number; previousCheckpointEventId?: string; summarizedMessageIds?: string[] } | undefined;
      const ids = continuity?.summarizedMessageIds ?? event.sourceMessageIds;
      // Narrative/state-only events can copy an older continuity marker. Only
      // the exact original chunk fingerprint proves that this event ate bytes.
      if (continuity?.sourceDigest && continuity.compactedMessages === ids.length && ids.some(sourceId => candidates.has(sourceId))) {
        const sources = ids.map(sourceId => this.db.prepare('SELECT m.id,m.sequence,m.conversation_id,m.author_id,m.content,m.status,t.topic_id FROM messages m JOIN companion_message_topics t ON t.message_id=m.id WHERE m.id=?').get(sourceId)) as (Row | undefined)[];
        if (sources.every(Boolean)) {
          const digest = createHash('sha256').update(JSON.stringify(sources.map(source => [source!.id, source!.sequence, source!.conversation_id, source!.topic_id, source!.author_id, source!.content, source!.status, false, false]))).digest('hex');
          if (digest === continuity.sourceDigest) for (const sourceId of ids) if (candidates.has(sourceId)) consumed.add(sourceId);
        }
      }
      pending.push(...(event.derivedFromEventIds ?? (continuity?.previousCheckpointEventId ? [continuity.previousCheckpointEventId] : [])));
    }
    return consumed;
  }
  private recordNarrativeState(message: CompanionMessage, approval?: CompanionTopicNarrativeApproval,
    publication?: CompanionTopicPublicationApproval, exactReplay = false, basis?: PublicationBasis): void {
    const topicId = this.messageTopic(message.id);
    if (!topicId || message.authorId === 'user' || message.status !== 'sent' || message.isReplyDraft || message.replyDraft) return;
    const topic = this.topic(topicId, message.conversationId);
    if (topic.kind !== 'story' || topic.deletedAt) return;
    const contentHash = createHash('sha256').update(message.content).digest('hex');
    // saveLoop first checks the approved turn and then passes the checksum
    // of the actual full combined formal message into this transaction.
    if (approval && (contentHash !== approval.contentChecksum || !message.content.includes(approval.quote))) throw new Error('叙事时刻审批与实际正式正文不一致。');
    if (publication && (publication.companionId !== message.authorId || publication.conversationId !== message.conversationId
      || publication.topicId !== topicId || contentHash !== publication.contentChecksum)) throw new Error('完整话题发布审批与实际伙伴、端口或正文不一致。');
    const actual = this.db.prepare("SELECT m.content,m.author_id FROM messages m JOIN companion_message_topics t ON t.message_id=m.id WHERE m.id=? AND m.status='sent' AND m.conversation_id=? AND t.topic_id=?").get(message.id, message.conversationId, topicId) as { content: string; author_id: string } | undefined;
    if (!actual || actual.content !== message.content || actual.author_id !== message.authorId || !this.checkpointSourcesValid?.(message.conversationId, message.authorId, [message.id])) throw new Error('正式叙事来源已经失效。');
    if (publication && message.replyToId && !this.checkpointSourcesValid?.(message.conversationId, message.authorId, [message.replyToId]))
      throw new Error('完整话题发布的实际回复来源已经失效。');
    if (exactReplay) return;
    const previous = this.state(topic, message.authorId).workingState;
    if (basis && (basis.companionId !== message.authorId || basis.conversationId !== message.conversationId || basis.topicId !== topicId))
      throw new Error('正式发布前快照不属于当前实际伙伴与话题。');
    if (publication && ((topic.formalPublicationRevision ?? 0) !== publication.expectedFormalPublicationRevision
      || basis && basis.revision !== publication.expectedFormalPublicationRevision
      || (basis?.checksum ?? createHash('sha256').update(companionTopicNarrativeBasis(previous)).digest('hex')) !== publication.expectedStateChecksum))
      throw new Error('话题正式正文或约束在审批后已经变化，不能发布基于旧状态的审批。');
    const canonValue = publication?.userCanon ?? approval?.userCanon ?? previous?.state?.__topicUserCanon;
    if (canonValue === undefined) return;
    const canon = companionTopicUserCanonSchema.parse(canonValue);
    const clock = approval && canon.entries.some(item => item.timeRange) ? approval : undefined;
    if (!publication && !clock) return;
    const rangeDigest = createHash('sha256').update(JSON.stringify(canon.entries.filter(item => item.timeRange).map(item => [item.id, item.timeRange]))).digest('hex');
    if (clock && rangeDigest !== clock.rangeDigest) throw new Error('叙事时刻审批的用户约束已经变化。');
    const sourceIds = [...new Set(canon.entries.map(item => item.sourceMessageId))];
    if (!this.checkpointSourcesValid?.(message.conversationId, message.authorId, sourceIds)) throw new Error('叙事精确约束原文已经失效。');
    const ancestors = companionTopicAncestorIds(this.db, topic);
    const previousCanon = companionTopicUserCanonSchema.safeParse(previous?.state?.__topicUserCanon ?? basis?.canon);
    for (const item of canon.entries) {
      const source = this.db.prepare("SELECT m.content,m.author_id,t.topic_id FROM messages m JOIN companion_message_topics t ON t.message_id=m.id WHERE m.id=? AND m.conversation_id=? AND m.status='sent'").get(item.sourceMessageId, message.conversationId) as { content: string; author_id: string; topic_id: string } | undefined;
      const inherited = previousCanon.success && previousCanon.data.entries.some(prior => JSON.stringify(prior) === JSON.stringify(item));
      if (!source || source.topic_id !== topicId && (!ancestors?.has(source.topic_id) || !inherited)
        || source.author_id !== 'user' || createHash('sha256').update(source.content).digest('hex') !== item.sourceChecksum || !source.content.includes(item.quote)) throw new Error('叙事精确约束与实际用户原文不一致。');
    }
    const last = previous?.state?.__topicNarrativeTime as { sourceMessageId?: string; sourceChecksum?: string; minutes?: number; rangeDigest?: string } | undefined;
    if (clock && last?.sourceMessageId === message.id && last.sourceChecksum === contentHash && last.minutes === clock.minutes && last.rangeDigest === clock.rangeDigest) return;
    if (previousCanon.success && canon.throughSequence < previousCanon.data.throughSequence
      && JSON.stringify(canon.entries) !== JSON.stringify(previousCanon.data.entries)) throw new Error('话题用户约束已被后续正式修订，旧请求的审批不能覆盖当前约束。');
    if (!publication && clock?.expectedStateChecksum && createHash('sha256').update(companionTopicNarrativeBasis(previous)).digest('hex') !== clock.expectedStateChecksum)
      throw new Error('话题正式叙事或约束在审批后已经变化，不能发布基于旧状态的审批。');
    if (!clock && previous && previousCanon.success && JSON.stringify(canon) === JSON.stringify(previousCanon.data)) return;
    const eventId = randomUUID(), at = new Date().toISOString(), ids = [...new Set([...sourceIds, message.id])];
    const data = { ...previous, sourceEventId: eventId, authorId: message.authorId, revision: topic.revision + 1, updatedAt: at,
      sourceMessageIds: ids, sourceChecksums: Object.fromEntries(ids.map(id => [id, createHash('sha256').update(String(row(this.db.prepare('SELECT content FROM messages WHERE id=?').get(id)).content)).digest('hex')])),
      ...(previous ? { derivedFromEventIds: [previous.sourceEventId] } : {}),
      state: { ...previous?.state, __topicUserCanon: canon, ...(clock ? { __topicNarrativeTime: { sourceMessageId: message.id, sourceChecksum: contentHash,
        minutes: clock.minutes, quote: clock.quote, rangeDigest: clock.rangeDigest } } : {}) } };
    this.db.prepare('INSERT INTO companion_topic_events(id,topic_id,reader_id,author_id,data) VALUES(?,?,?,?,?)').run(eventId, topicId, message.authorId, message.authorId, JSON.stringify(data));
    this.db.prepare('INSERT INTO companion_topic_state(topic_id,reader_id,data) VALUES(?,?,?) ON CONFLICT(topic_id,reader_id) DO UPDATE SET data=excluded.data').run(topicId, message.authorId, JSON.stringify(data));
    topic.revision++; topic.updatedAt = at;
    this.db.prepare('UPDATE companion_topics SET data=? WHERE id=?').run(JSON.stringify(topic), topicId);
  }
  private allowed(topic: CompanionTopic, readerId: string): void {
    if (topic.deletedAt || readerId !== 'user' && (![...topic.participantIds, ...topic.invitedIds].includes(readerId) || !this.members(topic.conversationId).includes(readerId))) throw new Error('当前读者不在这个话题中。');
  }
  private state(topic: CompanionTopic, readerId: string): CompanionTopicState {
    this.allowed(topic, readerId);
    const load = (reader: string) => { const found = this.db.prepare('SELECT data FROM companion_topic_state WHERE topic_id=? AND reader_id=?').get(topic.id, reader);
      const checkpoint = found ? decode<NonNullable<CompanionTopicState['shared']>>(row(found).data) : undefined;
      // Canonical state belongs to all participants. A withdrawal only hides
      // this reader's derived view; arbitrary state JSON is never provenance.
      if (checkpoint && !companionTopicCheckpointValid(this.db, topic, readerId, checkpoint, ids => readerId === 'user'
        || !ids.length || !!this.checkpointSourcesValid?.(topic.conversationId, readerId, ids))) return undefined;
      return checkpoint; };
    return { topicId: topic.id, readerId, shared: load('*'), workingState: topic.participantIds.includes(readerId) ? load(readerId) : undefined, trust: 'topic_state_not_real_world_facts' };
  }
  private paused(topicId: string, readerId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM companion_topic_participation WHERE topic_id=? AND reader_id=? AND status='paused'").get(topicId, readerId);
  }
  private project(topic: CompanionTopic, readerId: string): CompanionTopic {
    const result = topic.status === 'active' && this.paused(topic.id, readerId) ? { ...topic, status: 'paused' as const } : { ...topic };
    delete result.lastNarrativePublicationRef; delete result.lastInputPublicationRef;
    const narrative = this.publicationView(topic, readerId, false), input = this.publicationView(topic, readerId, true);
    result.lastNarrativePublicationAvailability = narrative.availability;
    result.lastInputPublicationAvailability = input.availability;
    if (narrative.reference) result.lastNarrativePublicationRef = narrative.reference;
    if (input.reference) result.lastInputPublicationRef = input.reference;
    const reference = topic.lastPublicationRef;
    if (!reference) return (topic.formalPublicationRevision ?? 0) > 0 ? { ...result, lastPublicationAvailability: 'unavailable' } : result;
    if (this.publicationReadable(topic, readerId, reference)) return { ...result, lastPublicationAvailability: 'available' };
    delete result.lastPublicationRef;
    return { ...result, lastPublicationAvailability: 'unavailable' };
  }
  private publicationReadable(topic: CompanionTopic, readerId: string, reference: NonNullable<CompanionTopic['lastPublicationRef']>): boolean {
    const actual = this.db.prepare("SELECT m.content,m.author_id,m.request_fingerprint FROM messages m JOIN companion_message_topics t ON t.message_id=m.id WHERE m.id=? AND m.conversation_id=? AND m.status='sent' AND t.topic_id=? AND NOT EXISTS(SELECT 1 FROM metadata d WHERE d.key='message-loop/'||m.id AND json_extract(d.value,'$.status')!='done') AND (json_extract(m.request_fingerprint,'$.loopStep') IS NULL OR EXISTS(SELECT 1 FROM metadata f WHERE f.key='message-loop/'||m.id AND json_extract(f.value,'$.status')='done'))")
      .get(reference.messageId, topic.conversationId, topic.id) as { content: string; author_id: string } | undefined;
    return !!(actual && actual.content.trim() && actual.author_id === reference.authorId && createHash('sha256').update(actual.content).digest('hex') === reference.contentChecksum
      && (readerId === 'user' || this.publicationSourcesValid?.(topic.conversationId, readerId, [reference.messageId])));
  }
  /** Two bounded derived views keep new input admission separate from the
   * most recently published actor body. Neither can overwrite the other. */
  private publicationView(topic: CompanionTopic, readerId: string, input: boolean): {
    availability: NonNullable<CompanionTopic['lastNarrativePublicationAvailability']>;
    reference?: NonNullable<CompanionTopic['lastNarrativePublicationRef']>;
  } {
    const actor = input ? "m.author_id IN ('user','system')" : "m.author_id NOT IN ('user','system')";
    const maximum = topic.formalPublicationRevision ?? 0;
    const latest = this.db.prepare(`SELECT m.id,m.author_id,p.value FROM metadata p INDEXED BY companion_topic_publication_page
      JOIN messages m ON m.id=substr(p.key,27) WHERE p.key GLOB 'message-topic-publication/*'
      AND json_extract(p.value,'$.topicId')=? AND CAST(json_extract(p.value,'$.revision') AS INTEGER)<=?
      AND ${actor} ORDER BY CAST(json_extract(p.value,'$.revision') AS INTEGER) DESC LIMIT 1`)
      .get(topic.id, maximum) as { id: string; author_id: string; value: string } | undefined;
    const recorded = topic.lastPublicationRef;
    // The old exact global pointer is genuine publication evidence even on a
    // migrated database. It proves only its own kind, never the other tail.
    const lastMatches = recorded && (input === (recorded.authorId === 'user' || recorded.authorId === 'system'));
    const reference = lastMatches && maximum > 0 ? { ...recorded, publicationRevision: maximum } : latest ? (() => {
      const value = decode<{ revision: number; checksum: string }>(latest.value);
      return { messageId: latest.id, authorId: latest.author_id, contentChecksum: value.checksum, publicationRevision: value.revision };
    })() : undefined;
    // Any indexed publication was written by the hook that indexes every new
    // formal commit. Older pre-index history cannot supersede that exact later
    // revision. Only a kind with no such evidence needs legacy calibration;
    // never scan old rows again on the normal indexed hot path.
    const legacy = !reference && this.db.prepare(`SELECT 1 FROM messages m JOIN companion_message_topics t ON t.message_id=m.id
      WHERE t.topic_id=? AND m.conversation_id=? AND ${actor} AND m.status='sent' AND length(trim(m.content))>0
      AND NOT EXISTS(SELECT 1 FROM metadata d WHERE d.key='message-loop/'||m.id AND json_extract(d.value,'$.status')!='done')
      AND (json_extract(m.request_fingerprint,'$.loopStep') IS NULL OR EXISTS(SELECT 1 FROM metadata f WHERE f.key='message-loop/'||m.id AND json_extract(f.value,'$.status')='done'))
      AND NOT EXISTS(SELECT 1 FROM metadata p WHERE p.key='message-topic-publication/'||m.id) LIMIT 1`)
      .get(topic.id, topic.conversationId);
    if (legacy) return { availability: 'legacy_order_unknown' };
    if (!reference) return { availability: 'none' };
    // Do not fall back to an older visible body when the actual newest one is
    // withdrawn, changed or outside this reader's source DAG.
    return this.publicationReadable(topic, readerId, reference) ? { availability: 'available', reference } : { availability: 'unavailable' };
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (command.type === 'topic.compaction.sources') return;
    if (!command.type.startsWith('topic.')) return;
    const response = this.db.transaction(() => {
      const input = command as Command;
      if (!input.operationId || ['topic.read', 'topic.list', 'topic.sources.valid'].includes(input.type)) return this.dispatch(input);
      const key = `topic-operation/${input.conversationId}/${input.readerId}/${input.operationId}`;
      const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const previous = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined;
      if (previous) {
        const receipt = JSON.parse(previous.value) as { digest: string; topicId?: string };
        if (receipt.digest !== digest) throw new Error('话题操作标识已经用于不同参数，不能重用。');
        if (input.type === 'topic.delete') return { ok: true };
        if (receipt.topicId) {
          const current = this.topic(receipt.topicId, input.conversationId); this.allowed(current, input.readerId);
          return { ok: true, topic: this.project(current, input.readerId), topicState: this.state(current, input.readerId) };
        }
        return { ok: true };
      }
      const response = this.dispatch(input);
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key, JSON.stringify({ digest, topicId: response.topic?.id }));
      return response;
    }).immediate();
    return response.topic ? { ...response, topic: this.project(response.topic, (command as Command).readerId) } : response;
  }
  private dispatch(command: Command): CompanionStorageResponse {
    if (command.type === 'topic.compaction.sources') throw new Error('话题原文扫描只能通过宿主来源投影读取。');
    const roomMembers = this.members(command.conversationId);
    if (command.readerId !== 'user' && !roomMembers.includes(command.readerId)) throw new Error('话题请求者不属于当前会话。');
    const primary = this.ensurePrimary(command.conversationId);
    if (command.type === 'topic.list') {
      const found = this.db.prepare("SELECT rowid,data FROM companion_topics WHERE conversation_id=? AND rowid<? AND json_extract(data,'$.deletedAt') IS NULL AND (?='' OR CASE WHEN json_extract(data,'$.status')='active' AND EXISTS(SELECT 1 FROM companion_topic_participation p WHERE p.topic_id=companion_topics.id AND p.reader_id=? AND p.status='paused') THEN 'paused' ELSE json_extract(data,'$.status') END=?) AND (?='' OR instr(lower(json_extract(data,'$.title')||' '||json_extract(data,'$.tags')),lower(?))>0) AND (?='user' OR EXISTS(SELECT 1 FROM json_each(data,'$.participantIds') WHERE value=?) OR EXISTS(SELECT 1 FROM json_each(data,'$.invitedIds') WHERE value=?)) AND (?='[]' OR EXISTS(SELECT 1 FROM json_each(data,'$.tags') t JOIN json_each(?) q ON lower(t.value)=lower(q.value))) ORDER BY rowid DESC LIMIT ?")
        .all(command.conversationId, command.before ?? Number.MAX_SAFE_INTEGER, command.status ?? '', command.readerId, command.status ?? '', command.query ?? '', command.query ?? '', command.readerId, command.readerId, command.readerId,
          JSON.stringify(command.tags ?? []), JSON.stringify(command.tags ?? []), (command.limit ?? 50) + 1);
      return { ok: true, topics: found.slice(0, command.limit ?? 50).map(item => this.project(companionTopicSchema.parse(decode(row(item).data)), command.readerId)),
        hasMore: found.length > (command.limit ?? 50), ...(found.length > (command.limit ?? 50) ? { topicNextCursor: Number(row(found[(command.limit ?? 50) - 1]).rowid) } : {}) };
    }
    if (command.type === 'topic.activate' && command.topicId === null) {
      if (primary) { this.select(command.conversationId, command.readerId, primary.id); return { ok: true, topic: primary, topicState: this.state(primary, command.readerId) }; }
      this.db.prepare('DELETE FROM companion_topic_current WHERE conversation_id=? AND reader_id=?').run(command.conversationId, command.readerId); return { ok: true };
    }
    if (command.type === 'topic.create') {
      const invited = [...new Set(command.participantIds ?? ['user', ...roomMembers])].filter(id => id !== command.readerId);
      const participants = command.readerId === 'user' && command.kind === 'discussion' ? ['user', ...invited] : [command.readerId];
      if (invited.some(id => id !== 'user' && !roomMembers.includes(id))) throw new Error('受邀者必须是本会话真实参与者。');
      if (command.readerId === 'user' && command.kind === 'discussion') invited.splice(0);
      const moderatorId = command.moderatorId ?? command.readerId;
      if (!participants.includes(moderatorId) && !invited.includes(moderatorId)) throw new Error('主持人必须参与或受邀当前话题。');
      const at = new Date().toISOString(), topic: CompanionTopic = { id: randomUUID(), conversationId: command.conversationId,
        title: command.title, kind: command.kind, status: 'active', participantIds: participants, invitedIds: invited, tags: command.tags ?? [], moderatorId, revision: 1, createdAt: at, updatedAt: at };
      this.db.prepare('INSERT INTO companion_topics(id,conversation_id,data) VALUES(?,?,?)').run(topic.id, topic.conversationId, JSON.stringify(topic));
      this.select(topic.conversationId, command.readerId, topic.id);
      const receipt = persistTopicParticipation(this.db, topic, command.readerId, 'joined'); if (receipt) this.participation?.(receipt);
      return { ok: true, topic, topicState: this.state(topic, command.readerId) };
    }
    const topic = this.topic(command.topicId!, command.conversationId); this.allowed(topic, command.readerId);
    if (command.type === 'topic.sources.valid') {
      const sourcesValid = (ids: readonly string[]) => command.readerId === 'user' || !ids.length
        || !!this.checkpointSourcesValid?.(topic.conversationId, command.readerId, ids);
      return { ok: true, topicSourcesValid: sourcesValid(command.sourceMessageIds)
        && (command.checkpointEventIds ?? []).every(id => companionTopicCheckpointEventValid(this.db, topic, command.readerId, id, sourcesValid)) };
    }
    if (command.type === 'topic.read') return { ok: true, topic: this.project(topic, command.readerId), topicState: this.state(topic, command.readerId) };
    if (command.type === 'topic.join' || command.type === 'topic.leave') {
      if (command.type === 'topic.leave' && topic.isPrimary) throw new Error('主要对话随联系人保留；可切换话题或将伙伴休眠。');
      const wasJoined = topic.participantIds.includes(command.readerId);
      if (command.type === 'topic.join') {
        if (!topic.participantIds.includes(command.readerId)) topic.participantIds.push(command.readerId);
        topic.invitedIds = topic.invitedIds.filter(id => id !== command.readerId); this.select(topic.conversationId, command.readerId, topic.id);
        this.db.prepare('DELETE FROM companion_topic_participation WHERE topic_id=? AND reader_id=?').run(topic.id, command.readerId);
      } else {
        topic.participantIds = topic.participantIds.filter(id => id !== command.readerId);
        if (!topic.invitedIds.includes(command.readerId)) topic.invitedIds.push(command.readerId);
        this.db.prepare("INSERT INTO companion_topic_participation(topic_id,reader_id,status) VALUES(?,?,'left') ON CONFLICT(topic_id,reader_id) DO UPDATE SET status='left'").run(topic.id, command.readerId);
        this.db.prepare('DELETE FROM companion_topic_current WHERE conversation_id=? AND reader_id=? AND topic_id=?').run(topic.conversationId, command.readerId, topic.id);
      }
      topic.revision++; topic.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE companion_topics SET data=? WHERE id=?').run(JSON.stringify(topic), topic.id);
      if (command.type === 'topic.leave') this.changed?.(topic.conversationId, topic.id, command.readerId);
      if (wasJoined !== topic.participantIds.includes(command.readerId)) {
        const receipt = persistTopicParticipation(this.db, topic, command.readerId, command.type === 'topic.join' ? 'joined' : 'left');
        if (receipt) this.participation?.(receipt);
      }
      return { ok: true, topic, topicState: this.state(topic, command.readerId) };
    }
    if (command.type === 'topic.activate') {
      if (topic.status !== 'active') throw new Error('话题已暂停或结束，请先恢复。');
      if (this.paused(topic.id, command.readerId)) throw new Error('本人已暂停，请选择恢复这个话题。');
      if (!topic.participantIds.includes(command.readerId)) throw new Error('请先选择加入当前话题，再切换到它。');
      this.select(topic.conversationId, command.readerId, topic.id);
      return { ok: true, topic };
    }
    if (command.type === 'topic.fork') {
      const result = this.dispatch({ type: 'topic.create', conversationId: topic.conversationId, title: command.title,
        kind: topic.kind, participantIds: [...topic.participantIds, ...topic.invitedIds], moderatorId: command.readerId, readerId: command.readerId, tags: topic.tags });
      const cloned = { ...result.topic!, forkedFromTopicId: topic.id };
      this.db.prepare('UPDATE companion_topics SET data=? WHERE id=?').run(JSON.stringify(cloned), cloned.id);
      for (const reader of ['*', command.readerId]) {
        const previous = this.db.prepare('SELECT data FROM companion_topic_state WHERE topic_id=? AND reader_id=?').get(topic.id, reader);
        if (previous) this.db.prepare('INSERT INTO companion_topic_state(topic_id,reader_id,data) VALUES(?,?,?)').run(cloned.id, reader, row(previous).data);
      }
      return { ok: true, topic: cloned, topicState: this.state(cloned, command.readerId) };
    }
    if (command.expectedRevision !== topic.revision) throw new Error('话题已有新进展，请重新读取后保存。');
    if (command.type === 'topic.transfer_moderator') {
      const target = command.targetCompanionId, previousModeratorId = topic.moderatorId;
      if (command.readerId !== 'user' && command.readerId !== previousModeratorId) throw new Error('只有当前主持本人或用户可以移交主持。');
      if (topic.status !== 'active' || command.readerId !== 'user' && this.paused(topic.id, command.readerId)) throw new Error('请先恢复当前话题，再移交主持。');
      if (target === previousModeratorId) throw new Error('接任者已经是当前主持。');
      if (!topic.participantIds.includes(target) || this.paused(topic.id, target) || target !== 'user' && (!roomMembers.includes(target)
        || !this.db.prepare("SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL AND json_extract(data,'$.active')=1").get(target))) throw new Error('接任主持必须已自行加入、仍是本群真实可用成员且未暂停。');
      const approval = command.moderatorTransferApproval;
      if (command.readerId !== 'user') {
        if (!topic.participantIds.includes(command.readerId) || !approval || approval.companionId !== command.readerId
          || approval.conversationId !== topic.conversationId || approval.topicId !== topic.id || approval.previousModeratorId !== previousModeratorId
          || approval.targetCompanionId !== target || approval.expectedRevision !== topic.revision) throw new Error('主持移交缺少本话题本版本的宿主同意证明。');
        const ids = command.sourceMessageIds ?? [], references = approval.sourceRefs;
        if (new Set(ids).size !== ids.length || new Set(references.map(ref => ref.id)).size !== references.length
          || JSON.stringify([...ids].sort()) !== JSON.stringify(references.map(ref => ref.id).sort())
          || !references.some(ref => ref.id === approval.consentMessageId)) throw new Error('主持移交的公开来源与宿主证明不一致。');
        for (const reference of references) {
          const source = this.db.prepare('SELECT author_id FROM messages WHERE id=? AND conversation_id=?').get(reference.id, topic.conversationId) as { author_id: string } | undefined;
          if (!source || reference.id === approval.consentMessageId && source.author_id !== target
            || !this.publicationReadable(topic, command.readerId, { messageId: reference.id, authorId: source.author_id, contentChecksum: reference.checksum }))
            throw new Error('接任同意的公开原文已变化、撤回或不属于本话题真实接任者。');
        }
      }
      topic.moderatorId = target; topic.revision++; topic.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE companion_topics SET data=? WHERE id=?').run(JSON.stringify(topic), topic.id);
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(`topic-moderator-transfer/${topic.id}/${topic.revision}`, JSON.stringify({
        actorId: command.readerId, previousModeratorId, targetCompanionId: target, previousRevision: command.expectedRevision,
        revision: topic.revision, at: topic.updatedAt, ...(command.readerId !== 'user' ? { approval } : { authority: 'explicit_user_command' }) }));
      this.changed?.(topic.conversationId, topic.id);
      return { ok: true, topic, topicState: this.state(topic, command.readerId) };
    }
    if (command.type === 'topic.delete') {
      if (command.readerId !== 'user') throw new Error('删除话题档案仅能由用户界面明确操作，伙伴可以暂停、退出或结束。');
      if (topic.isPrimary) throw new Error('主要对话保存原有聊天，请保留或编辑它；其他话题可单独删除。');
      this.db.prepare('DELETE FROM companion_topic_current WHERE topic_id=?').run(topic.id);
      this.db.prepare('DELETE FROM companion_topic_state WHERE topic_id=?').run(topic.id);
      this.db.prepare('DELETE FROM companion_topic_events WHERE topic_id=?').run(topic.id);
      this.db.prepare('DELETE FROM companion_topic_participation WHERE topic_id=?').run(topic.id);
      // Original chat records retain their topic IDs as detached history; deleting a topic never reclassifies them as ordinary dialogue.
      topic.status = 'closed'; topic.title = '[已删除] ' + topic.title; topic.participantIds = ['user']; topic.invitedIds = []; topic.deletedAt = new Date().toISOString();
      this.db.prepare('UPDATE companion_topics SET data=? WHERE id=?').run(JSON.stringify({ ...topic, revision: topic.revision + 1, updatedAt: new Date().toISOString() }), topic.id);
      this.changed?.(topic.conversationId, topic.id);
      return { ok: true };
    }
    if (command.type === 'topic.update') {
      const patch = command.patch, recipient = patch.privateRecipientId ?? command.readerId;
      if (command.compaction) {
        if (!command.maintenance || !patch.workingState || recipient !== command.readerId || !topic.participantIds.includes(command.readerId)
          || this.project(topic, command.readerId).status !== 'active') throw new Error('话题压缩只允许在本人已参加且活动中的工作上下文提交。');
        const current = this.state(topic, command.readerId);
        if (command.compaction.publicationCoverage) {
          const publication = command.compaction.publicationCoverage;
          if ((topic.formalPublicationRevision ?? 0) !== publication.expectedFormalPublicationRevision) throw new Error('话题正式发布在压缩期间已变化，摘要未提交。');
          for (const [id, revision] of Object.entries(publication.sourcePublicationRevisions)) {
            const actual = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('message-topic-publication/' + id) as { value: string } | undefined;
            const value = actual && decode<{ topicId: string; revision: number; checksum: string }>(actual.value);
            if (!value || value.topicId !== topic.id || value.revision !== revision || value.checksum !== command.compaction.sourceChecksums[id]) throw new Error('话题原文发布版本已变化，摘要未提交。');
          }
        }
        if ((current.workingState?.sourceEventId ?? null) !== command.compaction.previousWorkingEventId
          || (current.shared?.sourceEventId ?? null) !== command.compaction.sharedEventId) throw new Error('话题压缩依赖已经变化，摘要未提交。');
        const ids = patch.workingState.sourceMessageIds ?? [];
        if (!ids.length || Object.keys(command.compaction.sourceChecksums).length !== ids.length
          || !this.checkpointSourcesValid?.(topic.conversationId, command.readerId, ids)) throw new Error('话题压缩来源已经失效，摘要未提交。');
        for (const id of ids) {
          const source = this.db.prepare('SELECT content FROM messages WHERE id=?').get(id) as { content: string } | undefined;
          if (!source || createHash('sha256').update(source.content).digest('hex') !== command.compaction.sourceChecksums[id]) throw new Error('话题压缩原文已变化，摘要未提交。');
        }
      }
      if (patch.workingState?.state && '__continuity' in patch.workingState.state && command.maintenance !== true) throw new Error('话题连续性游标由宿主维护，不能由模型或界面伪造。');
      if (command.maintenance !== true && [patch.workingState?.state, patch.shared?.state].some(state => state && ('__topicUserCanon' in state || '__topicNarrativeTime' in state)))
        throw new Error('话题用户精确约束由宿主维护，不能由模型或界面伪造。');
      if (![...topic.participantIds, ...topic.invitedIds].includes(recipient) || recipient !== command.readerId && command.readerId !== topic.moderatorId && command.readerId !== 'user') throw new Error('只能更新本人工作记忆，主持人可分发指定成员私密设定。');
      if ((patch.shared || patch.title) && topic.kind !== 'discussion' && command.readerId !== topic.moderatorId && command.readerId !== 'user') throw new Error('游戏或故事的公共规则与阶段由真实主持人维护；参与者只更新本人工作记忆。');
      for (const [reader, checkpoint] of [['*', patch.shared], [recipient, patch.workingState]] as const) if (checkpoint) {
        for (const messageId of checkpoint.sourceMessageIds ?? []) {
          const source = this.db.prepare('SELECT m.author_id FROM messages m JOIN companion_message_topics t ON t.message_id=m.id WHERE m.id=? AND m.conversation_id=? AND t.topic_id=? AND m.status=?').get(messageId, topic.conversationId, topic.id, 'sent');
          // Binding already checked membership when the message was committed.
          // A later departure cannot erase what the remaining readers witnessed.
          if (!source) throw new Error('话题checkpoint来源必须是这个话题的真实发言。');
        }
        const previous = this.db.prepare('SELECT data FROM companion_topic_state WHERE topic_id=? AND reader_id=?').get(topic.id, reader);
        const storedPrevious = previous ? decode<NonNullable<CompanionTopicState['workingState']>>(row(previous).data) : undefined;
        const stateReader = reader === '*' ? command.readerId : reader;
        const previousData = storedPrevious && companionTopicCheckpointValid(this.db, topic, stateReader, storedPrevious, ids => stateReader === 'user'
          || !ids.length || !!this.checkpointSourcesValid?.(topic.conversationId, stateReader, ids)) ? storedPrevious : undefined;
        const state = checkpoint.state ? { ...checkpoint.state,
          ...(command.maintenance !== true && previousData?.state?.__continuity ? { __continuity: previousData.state.__continuity } : {}),
          ...(command.maintenance !== true && previousData?.state?.__topicUserCanon ? { __topicUserCanon: previousData.state.__topicUserCanon } : {}),
          ...(command.maintenance !== true && previousData?.state?.__topicNarrativeTime ? { __topicNarrativeTime: previousData.state.__topicNarrativeTime } : {}) } : previousData?.state;
        const eventId = randomUUID(), at = new Date().toISOString(), data = { ...previousData, ...checkpoint, ...(state ? { state } : {}), sourceEventId: eventId, updatedAt: at,
          authorId: command.readerId, revision: topic.revision + 1 };
        if (reader === '*' && data.state) { data.state = { ...data.state }; delete data.state.__topicUserCanon; delete data.state.__topicNarrativeTime; }
        if (command.compaction && reader === recipient) {
          data.derivedFromEventIds = [...new Set([command.compaction.previousWorkingEventId, command.compaction.sharedEventId].filter((id): id is string => !!id))];
          data.sourceChecksums = command.compaction.sourceChecksums;
        } else if (checkpoint.summary !== undefined) {
          // An explicit replacement is a new setting; do not silently retain a
          // previous summary's ancestry or its message coverage watermark.
          delete data.derivedFromEventIds; delete data.sourceChecksums;
          if (command.maintenance !== true && data.state) { data.state = { ...data.state }; delete data.state.__continuity; }
          // A manual/assistant summary can replace prose, never detach the
          // separately retained user canon from its immutable source ancestry.
          if (reader !== '*' && (previousData?.state?.__topicUserCanon || previousData?.state?.__topicNarrativeTime)) data.derivedFromEventIds = [previousData.sourceEventId];
        } else if (previousData) {
          // Updating only private structured state still depends on the summary
          // and state we retained, including that event's direct message set.
          data.derivedFromEventIds = [previousData.sourceEventId];
        }
        data.sourceMessageIds ??= [];
        data.sourceChecksums = Object.fromEntries(data.sourceMessageIds.map(id => [id, createHash('sha256').update(String(row(this.db.prepare('SELECT content FROM messages WHERE id=?').get(id)).content)).digest('hex')]));
        this.db.prepare('INSERT INTO companion_topic_events(id,topic_id,reader_id,author_id,data) VALUES(?,?,?,?,?)').run(eventId, topic.id, reader, command.readerId, JSON.stringify(data));
        this.db.prepare('INSERT INTO companion_topic_state(topic_id,reader_id,data) VALUES(?,?,?) ON CONFLICT(topic_id,reader_id) DO UPDATE SET data=excluded.data').run(topic.id, reader, JSON.stringify(data));
      }
      if (patch.title) topic.title = patch.title;
      if (patch.tags) topic.tags = patch.tags;
      if (patch.invitedIds) {
        if (command.readerId !== 'user' && command.readerId !== topic.moderatorId) throw new Error('只有主持人或用户可以调整话题邀请。');
        if (patch.invitedIds.some(id => id !== 'user' && !roomMembers.includes(id))) throw new Error('只能邀请这个会话的真实成员。');
        topic.invitedIds = [...new Set(patch.invitedIds)].filter(id => !topic.participantIds.includes(id));
      }
    } else {
      if (command.type === 'topic.pause' || command.type === 'topic.resume') {
        if (!topic.participantIds.includes(command.readerId)) throw new Error('请先自愿加入这个话题。');
        if (command.type === 'topic.pause') this.db.prepare("INSERT INTO companion_topic_participation(topic_id,reader_id,status) VALUES(?,?,'paused') ON CONFLICT(topic_id,reader_id) DO UPDATE SET status='paused'").run(topic.id, command.readerId);
        else { this.db.prepare('DELETE FROM companion_topic_participation WHERE topic_id=? AND reader_id=?').run(topic.id, command.readerId); this.select(topic.conversationId, command.readerId, topic.id); }
      } else {
        if (command.readerId !== 'user' && command.readerId !== topic.moderatorId) throw new Error('只有用户或本话题主持人可结束或重开。');
        topic.status = command.type === 'topic.close' ? 'closed' : 'active';
      }
      if (topic.status === 'closed') this.db.prepare('DELETE FROM companion_topic_current WHERE conversation_id=? AND topic_id=?').run(topic.conversationId, topic.id);
      else this.select(topic.conversationId, command.readerId, topic.id);
    }
    topic.revision++; topic.updatedAt = new Date().toISOString();
    this.db.prepare('UPDATE companion_topics SET data=? WHERE id=?').run(JSON.stringify(topic), topic.id);
    if (command.type === 'topic.pause' || command.type === 'topic.close') this.changed?.(topic.conversationId, topic.id, command.type === 'topic.pause' ? command.readerId : undefined);
    if (command.type === 'topic.close') for (const owner of topic.participantIds) {
      const receipt = persistTopicParticipation(this.db, topic, owner, 'closed'); if (receipt) this.participation?.(receipt);
    }
    return { ok: true, topic: this.project(topic, command.readerId), topicState: this.state(topic, command.readerId) };
  }
  private select(conversationId: string, readerId: string, topicId: string): void {
    this.db.prepare('INSERT INTO companion_topic_current(conversation_id,reader_id,topic_id) VALUES(?,?,?) ON CONFLICT(conversation_id,reader_id) DO UPDATE SET topic_id=excluded.topic_id').run(conversationId, readerId, topicId);
  }
}
