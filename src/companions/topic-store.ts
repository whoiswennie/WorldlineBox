import { randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import { companionTopicSchema, type CompanionTopic, type CompanionTopicState } from '../shared/companion-topic';
import { persistTopicParticipation, type TopicParticipationReceipt } from './topic-participation';

type Row = Record<string, string | number | null>;
const row = (value: unknown) => value as Row;
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
type Command = Extract<CompanionStorageCommand, { type: `topic.${string}` }>;
/** Shared canonical state and each participant's private working memory have separate storage and projections. */
export class CompanionTopicStore {
  constructor(private readonly db: CompanionConnection, private readonly members: (conversationId: string) => string[],
    private readonly participation?: (receipt: TopicParticipationReceipt) => void,
    private readonly changed?: (conversationId: string, topicId: string, readerId?: string) => void,
    private readonly checkpointSourcesValid?: (conversationId: string, readerId: string, sourceMessageIds: readonly string[]) => boolean) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_topics(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_topics_room ON companion_topics(conversation_id,id);
      CREATE TABLE IF NOT EXISTS companion_topic_current(conversation_id TEXT NOT NULL REFERENCES conversations(id),reader_id TEXT NOT NULL,topic_id TEXT REFERENCES companion_topics(id),PRIMARY KEY(conversation_id,reader_id));
      CREATE TABLE IF NOT EXISTS companion_topic_state(topic_id TEXT NOT NULL REFERENCES companion_topics(id),reader_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(topic_id,reader_id));
      CREATE TABLE IF NOT EXISTS companion_topic_participation(topic_id TEXT NOT NULL REFERENCES companion_topics(id),reader_id TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(topic_id,reader_id));
      CREATE TABLE IF NOT EXISTS companion_topic_events(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL REFERENCES companion_topics(id),reader_id TEXT NOT NULL,author_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_message_topics(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,topic_id TEXT NOT NULL REFERENCES companion_topics(id));
      CREATE INDEX IF NOT EXISTS companion_message_topic ON companion_message_topics(topic_id,message_id);`);
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
    const chosen = replyToId ? inherited : topicId ?? (topicId === undefined && authorId === 'user' ? this.current(conversationId, authorId) : undefined);
    if (replyToId && topicId !== undefined && (topicId ?? undefined) !== inherited) throw new Error('回复必须保留实际来源的话题，不能随当前选中项切换。');
    if (!chosen) return;
    const topic = this.topic(chosen, conversationId);
    if (topic.deletedAt) throw new Error('话题已删除，不能继续向原话题发言。');
    if (topic.status !== 'active' && !replyToId) throw new Error('话题已暂停或结束，请先恢复或切回普通聊天。');
    if (authorId !== 'system' && this.paused(topic.id, authorId)) throw new Error('本人已暂停这个话题，请先恢复再发言。');
    if (authorId !== 'system' && !topic.participantIds.includes(authorId) && !(draft && topic.invitedIds.includes(authorId))) throw new Error('请先自主加入这个话题，再正式发言。');
    this.db.prepare('INSERT INTO companion_message_topics(message_id,topic_id) VALUES(?,?)').run(messageId, chosen);
  }
  fictionalMessage(messageId: string): boolean {
    const found = this.db.prepare("SELECT 1 FROM companion_message_topics m JOIN companion_topics t ON t.id=m.topic_id WHERE m.message_id=? AND json_extract(t.data,'$.kind') IN('game','story')").get(messageId);
    return !!found;
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
      if (checkpoint && readerId !== 'user' && checkpoint.sourceMessageIds.length
        && !this.checkpointSourcesValid?.(topic.conversationId, readerId, checkpoint.sourceMessageIds)) return undefined;
      return checkpoint; };
    return { topicId: topic.id, readerId, shared: load('*'), workingState: topic.participantIds.includes(readerId) ? load(readerId) : undefined, trust: 'topic_state_not_real_world_facts' };
  }
  private paused(topicId: string, readerId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM companion_topic_participation WHERE topic_id=? AND reader_id=? AND status='paused'").get(topicId, readerId);
  }
  private project(topic: CompanionTopic, readerId: string): CompanionTopic {
    return topic.status === 'active' && this.paused(topic.id, readerId) ? { ...topic, status: 'paused' } : topic;
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (!command.type.startsWith('topic.')) return;
    return this.db.transaction(() => this.dispatch(command as Command)).immediate();
  }
  private dispatch(command: Command): CompanionStorageResponse {
    const roomMembers = this.members(command.conversationId);
    if (command.readerId !== 'user' && !roomMembers.includes(command.readerId)) throw new Error('话题请求者不属于当前会话。');
    if (command.type === 'topic.list') {
      const found = this.db.prepare("SELECT rowid,data FROM companion_topics WHERE conversation_id=? AND rowid<? AND json_extract(data,'$.deletedAt') IS NULL AND (?='' OR CASE WHEN json_extract(data,'$.status')='active' AND EXISTS(SELECT 1 FROM companion_topic_participation p WHERE p.topic_id=companion_topics.id AND p.reader_id=? AND p.status='paused') THEN 'paused' ELSE json_extract(data,'$.status') END=?) AND (?='' OR instr(lower(json_extract(data,'$.title')||' '||json_extract(data,'$.tags')),lower(?))>0) AND (?='user' OR EXISTS(SELECT 1 FROM json_each(data,'$.participantIds') WHERE value=?) OR EXISTS(SELECT 1 FROM json_each(data,'$.invitedIds') WHERE value=?)) AND (?='[]' OR EXISTS(SELECT 1 FROM json_each(data,'$.tags') t JOIN json_each(?) q ON lower(t.value)=lower(q.value))) ORDER BY rowid DESC LIMIT ?")
        .all(command.conversationId, command.before ?? Number.MAX_SAFE_INTEGER, command.status ?? '', command.readerId, command.status ?? '', command.query ?? '', command.query ?? '', command.readerId, command.readerId, command.readerId,
          JSON.stringify(command.tags ?? []), JSON.stringify(command.tags ?? []), (command.limit ?? 50) + 1);
      return { ok: true, topics: found.slice(0, command.limit ?? 50).map(item => this.project(companionTopicSchema.parse(decode(row(item).data)), command.readerId)),
        hasMore: found.length > (command.limit ?? 50), ...(found.length > (command.limit ?? 50) ? { topicNextCursor: Number(row(found[(command.limit ?? 50) - 1]).rowid) } : {}) };
    }
    if (command.type === 'topic.activate' && command.topicId === null) {
      this.db.prepare('DELETE FROM companion_topic_current WHERE conversation_id=? AND reader_id=?').run(command.conversationId, command.readerId); return { ok: true };
    }
    if (command.type === 'topic.create') {
      const invited = [...new Set(command.participantIds ?? ['user', ...roomMembers])].filter(id => id !== command.readerId);
      const participants = [command.readerId];
      if (invited.some(id => id !== 'user' && !roomMembers.includes(id))) throw new Error('受邀者必须是本会话真实参与者。');
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
    if (command.type === 'topic.sources.valid') return { ok: true, topicSourcesValid: command.readerId === 'user'
      || !command.sourceMessageIds.length || !!this.checkpointSourcesValid?.(topic.conversationId, command.readerId, command.sourceMessageIds) };
    if (command.type === 'topic.read') return { ok: true, topic: this.project(topic, command.readerId), topicState: this.state(topic, command.readerId) };
    if (command.type === 'topic.join' || command.type === 'topic.leave') {
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
    if (command.type === 'topic.delete') {
      if (command.readerId !== 'user') throw new Error('删除话题档案仅能由用户界面明确操作，伙伴可以暂停、退出或结束。');
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
      if (patch.workingState?.state && '__continuity' in patch.workingState.state && command.maintenance !== true) throw new Error('话题连续性游标由宿主维护，不能由模型或界面伪造。');
      if (![...topic.participantIds, ...topic.invitedIds].includes(recipient) || recipient !== command.readerId && command.readerId !== topic.moderatorId && command.readerId !== 'user') throw new Error('只能更新本人工作记忆，主持人可分发指定成员私密设定。');
      if ((patch.shared || patch.title) && topic.kind !== 'discussion' && command.readerId !== topic.moderatorId && command.readerId !== 'user') throw new Error('游戏或故事的公共规则与阶段由真实主持人维护；参与者只更新本人工作记忆。');
      for (const [reader, checkpoint] of [['*', patch.shared], [recipient, patch.workingState]] as const) if (checkpoint) {
        for (const messageId of checkpoint.sourceMessageIds ?? []) {
          const source = this.db.prepare('SELECT m.author_id FROM messages m JOIN companion_message_topics t ON t.message_id=m.id WHERE m.id=? AND m.conversation_id=? AND t.topic_id=? AND m.status=?').get(messageId, topic.conversationId, topic.id, 'sent');
          if (!source || row(source).author_id !== 'system' && !topic.participantIds.includes(String(row(source).author_id))) throw new Error('话题checkpoint来源必须是这个话题的真实发言。');
        }
        const previous = this.db.prepare('SELECT data FROM companion_topic_state WHERE topic_id=? AND reader_id=?').get(topic.id, reader);
        const previousData = previous ? decode<NonNullable<CompanionTopicState['workingState']>>(row(previous).data) : undefined;
        const state = checkpoint.state ? { ...checkpoint.state,
          ...(command.maintenance !== true && previousData?.state?.__continuity ? { __continuity: previousData.state.__continuity } : {}) } : previousData?.state;
        const eventId = randomUUID(), at = new Date().toISOString(), data = { ...previousData, ...checkpoint, ...(state ? { state } : {}), sourceEventId: eventId, updatedAt: at,
          authorId: command.readerId, revision: topic.revision + 1 };
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
