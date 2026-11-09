import { createHash } from 'node:crypto';
import type { BotChatRuntime, BotNativeTopic } from '../../shared/companion-bot-topics';
import type { BotEvent } from './types';
import type { BotStore } from './store';

type TopicRow = { id: string; conversation_id: string; acl_revision: number; title: string; created_at: string; updated_at: string };
export interface BotGuidance { message_id: string; event_id: string; conversation_id: string; text: string; status: string; error?: string }
const topic = (row: TopicRow): BotNativeTopic => ({ id: row.id, conversationId: row.conversation_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at });
const short = (text: string) => Array.from(text.trim().replace(/\s+/gu, ' ')).slice(0, 60).join('') || '新话题';

/** Deterministic topic routing: explicit selection and current-topic follow-ups
 * choose a native Session. No application model classifies or rewrites messages. */
export class BotTopics {
  constructor(private readonly store: BotStore) {}
  private room(conversationId: string) {
    const room = this.store.getConversation(conversationId);
    if (!room || room.dissolvedAt || !room.memberIds.includes('user')) throw Error('当前用户不能管理这个话题。');
    return room;
  }
  get(id: string, conversationId: string): BotNativeTopic {
    this.room(conversationId);return this.readTopic(id,conversationId);
  }
  private readTopic(id:string,conversationId:string):BotNativeTopic{
    const room=this.store.getConversation(conversationId);if(!room||room.dissolvedAt)throw Error('会话不存在或已经解散。');
    const row = this.store.taskTransaction(sql => sql.prepare('SELECT * FROM bot_native_topics WHERE id=? AND conversation_id=? AND acl_revision=?').get(id, conversationId, room.revision)) as TopicRow | undefined;
    if (!row) throw Error('话题不存在，或聊天成员已经变化，请开启新话题。');
    const stale = this.store.taskTransaction(sql => sql.prepare(`SELECT 1 FROM bot_topic_bindings b JOIN bot_lanes l ON l.conversation_id=b.conversation_id AND l.companion_id=b.companion_id WHERE b.topic_id=? AND b.lane_epoch<>l.epoch LIMIT 1`).get(id));
    if (stale) throw Error('这个话题包含已清理或撤回的上下文，请开启新话题。');
    return topic(row);
  }
  current(conversationId: string): BotNativeTopic | undefined {
    const id = this.store.getMetadata('native-topic-active:' + conversationId);
    if (!id) return;
    try { return this.get(id, conversationId); } catch { return; }
  }
  create(conversationId: string, requestId: string, title = '新话题', activate = true): BotNativeTopic {
    const room = this.room(conversationId), id = 'topic-' + createHash('sha256').update(JSON.stringify([conversationId, requestId])).digest('hex');
    this.store.taskTransaction(sql => {
      const stamp = new Date().toISOString();
      sql.prepare('INSERT OR IGNORE INTO bot_native_topics VALUES(?,?,?,?,?,?)').run(id, conversationId, room.revision, short(title), stamp, stamp);
      if (activate) this.store.setMetadata('native-topic-active:' + conversationId, id);
    });
    return this.get(id, conversationId);
  }
  select(conversationId: string, id: string): BotNativeTopic {
    const selected = this.get(id, conversationId); this.store.setMetadata('native-topic-active:' + conversationId, id); return selected;
  }
  /** Import only an explicitly browsed page of WorldlineBox's older sessions.
   * Native DSH workspaces outside this application's event journal are untouched. */
  list(conversationId: string, query = '', before?: string): { items: BotNativeTopic[]; next?: string } {
    const room = this.room(conversationId);
    return this.store.taskTransaction(sql => {
      const older = sql.prepare(`SELECT i.id FROM bot_inbox i JOIN bot_lanes l ON l.id=i.lane_id LEFT JOIN bot_metadata epoch ON epoch.key='event-native-epoch:'||i.id WHERE i.conversation_id=? AND i.acl_revision=? AND i.source='user' AND i.dsh_event_id IS NOT NULL AND (epoch.value IS NULL OR CAST(epoch.value AS INTEGER)=l.epoch)
        AND NOT EXISTS(SELECT 1 FROM bot_topic_events t WHERE t.event_id=i.id) ORDER BY i.sequence DESC LIMIT 40`).all(conversationId, room.revision) as Array<{ id: string }>;
      for (const row of older) {
        const event = this.store.getEvent(row.id)!;
        const lane = this.store.getLane(event.laneId)!;
        if (this.store.getEventNativeEpoch(event.id) !== undefined && this.store.getEventNativeEpoch(event.id) !== lane.epoch) continue;
        const id = 'topic-' + createHash('sha256').update(event.id).digest('hex');
        sql.prepare('INSERT OR IGNORE INTO bot_native_topics VALUES(?,?,?,?,?,?)').run(id, conversationId, room.revision, short(event.content), event.receivedAt, event.receivedAt);
        sql.prepare('INSERT OR IGNORE INTO bot_topic_events VALUES(?,?,?)').run(event.id, conversationId, id);
        sql.prepare('INSERT OR IGNORE INTO bot_topic_bindings VALUES(?,?,?,?,?)').run(id, conversationId, event.companionId, 'turn-' + event.id, lane.epoch);
      }
      let cursor: [string,string] | undefined;
      if (before) { const parsed: unknown = JSON.parse(before); if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some(v => typeof v !== 'string')) throw Error('无效的话题分页位置。'); cursor = [parsed[0],parsed[1]]; }
      const rows = sql.prepare(`SELECT * FROM bot_native_topics WHERE conversation_id=? AND acl_revision=? AND instr(lower(title),lower(?))>0
        ${cursor ? 'AND (updated_at,id)<(?,?)' : ''} ORDER BY updated_at DESC,id DESC LIMIT 31`).all(conversationId, room.revision, query, ...(cursor ?? [])) as TopicRow[];
      const items = rows.slice(0,30), last = items.at(-1);
      return { items: items.map(topic), ...(rows.length>30 && last ? { next: JSON.stringify([last.updated_at,last.id]) } : {}) };
    });
  }
  bind(events: readonly BotEvent[], selected: BotNativeTopic): void {
    this.store.taskTransaction(sql => {
      this.readTopic(selected.id, selected.conversationId);
      for (const event of events) {
        if(event.conversationId!==selected.conversationId)throw Error('事件和话题属于不同聊天。');
        const epoch = this.store.getLane(event.laneId)!.epoch;
        sql.prepare('INSERT OR IGNORE INTO bot_topic_events VALUES(?,?,?)').run(event.id,event.conversationId,selected.id);
        sql.prepare('INSERT OR IGNORE INTO bot_topic_bindings VALUES(?,?,?,?,?)').run(selected.id,event.conversationId,event.companionId,`topic-${selected.id}-${event.companionId}`,epoch);
      }
      if (events.length) sql.prepare("UPDATE bot_native_topics SET title=CASE WHEN title='新话题' THEN ? ELSE title END,updated_at=? WHERE id=?").run(short(events[0]!.content),new Date().toISOString(),selected.id);
    });
  }
  lane(event: BotEvent): string {
    const row = this.store.taskTransaction(sql => sql.prepare(`SELECT b.native_lane_id FROM bot_topic_events t JOIN bot_topic_bindings b ON b.topic_id=t.topic_id WHERE t.event_id=? AND b.companion_id=?`).get(event.id,event.companionId)) as { native_lane_id: string } | undefined;
    return row?.native_lane_id ?? 'turn-' + event.id;
  }
  reference(eventId:string):{id:string;title:string}|undefined{
    return this.store.taskTransaction(sql=>sql.prepare('SELECT t.id,t.title FROM bot_topic_events e JOIN bot_native_topics t ON t.id=e.topic_id WHERE e.event_id=?').get(eventId)) as {id:string;title:string}|undefined;
  }
  started(event:BotEvent):void{
    this.store.taskTransaction(sql=>{
      let binding=sql.prepare('SELECT topic_id FROM bot_topic_events WHERE event_id=?').get(event.id) as {topic_id:string}|undefined;
      if(!binding&&event.causationId){
        const cause=this.store.getEvent(event.causationId);
        if(cause?.conversationId===event.conversationId){const inherited=sql.prepare('SELECT topic_id FROM bot_topic_events WHERE event_id=?').get(cause.id) as {topic_id:string}|undefined;
          if(inherited){const selected=this.readTopic(inherited.topic_id,event.conversationId);this.bind([event],selected);binding=inherited;}}
      }
      const room=this.store.getConversation(event.conversationId);
      if(!binding&&room?.kind==='peer'){
        const causeTopic=event.causationId?sql.prepare('SELECT topic_id FROM bot_topic_events WHERE event_id=?').get(event.causationId) as {topic_id:string}|undefined:undefined;
        const id='topic-'+createHash('sha256').update(JSON.stringify([room.id,causeTopic?.topic_id??event.correlationId])).digest('hex');
        sql.prepare('INSERT OR IGNORE INTO bot_native_topics VALUES(?,?,?,?,?,?)').run(id,room.id,room.revision,short(event.content),event.receivedAt,event.receivedAt);
        this.bind([event],this.readTopic(id,room.id));binding={topic_id:id};
      }
      if(binding&&event.source==='user')this.store.setMetadata('native-topic-active:'+event.conversationId,binding.topic_id);
    });
  }
  assertCurrent(event:BotEvent):void{
    const row=this.store.taskTransaction(sql=>sql.prepare('SELECT topic_id FROM bot_topic_events WHERE event_id=?').get(event.id)) as {topic_id:string}|undefined;
    if(row)this.readTopic(row.topic_id,event.conversationId);
  }
  topicEvent(id: string, conversationId: string, companionId: string): BotEvent {
    this.get(id,conversationId);
    const row = this.store.taskTransaction(sql => sql.prepare(`SELECT i.id FROM bot_topic_events t JOIN bot_inbox i ON i.id=t.event_id WHERE t.topic_id=? AND i.companion_id=? AND i.dsh_event_id IS NOT NULL ORDER BY i.sequence DESC LIMIT 1`).get(id,companionId)) as { id:string } | undefined;
    if (!row) throw Error('这位伙伴尚未在此话题中开始会话。');
    return this.store.getEvent(row.id)!;
  }
  runtime(conversationId: string): BotChatRuntime {
    const running = this.store.taskTransaction(sql => sql.prepare(`SELECT i.reply_message_id AS messageId,i.companion_id AS companionId,c.name AS companionName,t.topic_id AS topicId FROM bot_inbox i JOIN bot_companions c ON c.id=i.companion_id LEFT JOIN bot_topic_events t ON t.event_id=i.id WHERE i.conversation_id=? AND i.status='running' ORDER BY i.sequence`).all(conversationId)) as BotChatRuntime['running'];
    const pending = this.store.taskTransaction(sql => sql.prepare(`SELECT DISTINCT i.source_record_id AS id FROM bot_inbox i WHERE i.conversation_id=? AND i.source='user' AND i.status='queued' AND json_extract(i.payload_json,'$.userQueued')=1 ORDER BY i.sequence LIMIT 80`).all(conversationId)) as Array<{id:string}>;
    const guiding = this.store.taskTransaction(sql => sql.prepare("SELECT DISTINCT message_id AS id FROM bot_guidance WHERE conversation_id=? AND status<>'accepted' LIMIT 80").all(conversationId)) as Array<{id:string}>;
    const hiddenMessageIds: string[] = [];
    const queued: BotChatRuntime['queued'] = [];
    for (const id of new Set([...pending,...guiding].map(row=>row.id))) {
      const message = this.store.getMessage(id); if (!message) continue;
      const events = this.store.taskTransaction(sql => sql.prepare("SELECT * FROM bot_inbox WHERE source_record_id=? AND status='queued'").all(id)) as Array<{reply_message_id:string;companion_id:string}>;
      const guidance = this.store.taskTransaction(sql => sql.prepare("SELECT * FROM bot_guidance WHERE message_id=? AND status<>'accepted'").all(id)) as BotGuidance[];
      hiddenMessageIds.push(id,...events.map(event=>event.reply_message_id));
      queued.push({messageId:id,content:message.content,companionNames:events.map(event=>this.store.getCompanion(event.companion_id)!.name),attachmentNames:message.attachments?.map(file=>file.name)??[],state:guidance.some(item=>item.error)?'attention':guidance.length?'guiding':'queued',error:guidance.find(item=>item.error)?.error});
    }
    const converted = this.store.taskTransaction(sql => sql.prepare("SELECT reply_message_id AS id FROM bot_inbox WHERE conversation_id=? AND error='converted-to-guidance' AND status='cancelled' ORDER BY sequence DESC LIMIT 160").all(conversationId)) as Array<{id:string}>;
    hiddenMessageIds.push(...converted.map(row=>row.id));
    return {topic:this.current(conversationId),running,queued,hiddenMessageIds};
  }
  reserveGuidance(conversationId: string, messageId: string, texts: Map<string,string>): BotGuidance[] {
    this.room(conversationId);
    return this.store.taskTransaction(sql => {
      const prior = sql.prepare('SELECT * FROM bot_guidance WHERE message_id=? AND conversation_id=?').all(messageId,conversationId) as BotGuidance[];
      if (prior.length) return prior;
      const events = sql.prepare("SELECT id FROM bot_inbox WHERE conversation_id=? AND source_record_id=? AND source='user'").all(conversationId,messageId) as Array<{id:string}>;
      if (!events.length) throw Error('没有这条排队消息。');
      for (const row of events) {
        const event = this.store.getEvent(row.id)!;
        if (event.status !== 'queued' || event.dshEventId) throw Error('消息已经开始执行，请向当前任务发送新的补充。');
        const target = sql.prepare("SELECT id FROM bot_inbox WHERE conversation_id=? AND companion_id=? AND status='running' ORDER BY sequence DESC LIMIT 1").get(conversationId,event.companionId) as {id:string}|undefined;
        if (!target || !texts.has(event.id)) throw Error('伙伴当前没有可引导的任务，排队消息已保留。');
        sql.prepare('INSERT INTO bot_guidance VALUES(?,?,?,?,?,NULL)').run(messageId,target.id,conversationId,texts.get(event.id)!,'pending');
        sql.prepare("UPDATE bot_inbox SET status='cancelled',error='converted-to-guidance' WHERE id=?").run(event.id);
        sql.prepare("UPDATE bot_messages SET status='cancelled' WHERE id=?").run(event.replyMessageId);
      }
      return sql.prepare('SELECT * FROM bot_guidance WHERE message_id=?').all(messageId) as BotGuidance[];
    });
  }
  pendingGuidance(): BotGuidance[] { return this.store.taskTransaction(sql => sql.prepare("SELECT * FROM bot_guidance WHERE status='pending' LIMIT 80").all()) as BotGuidance[]; }
  guidanceResult(item: BotGuidance, error?: string): void { this.store.taskTransaction(sql=>sql.prepare('UPDATE bot_guidance SET status=?,error=? WHERE message_id=? AND event_id=?').run(error?'pending':'accepted',error??null,item.message_id,item.event_id)); }
  guidanceNotAccepted(item:BotGuidance):void{
    this.store.taskTransaction(sql=>{
      const target=this.store.getEvent(item.event_id);if(!target)return;
      const rows=sql.prepare("SELECT id,reply_message_id FROM bot_inbox WHERE source_record_id=? AND companion_id=? AND status='cancelled' AND error='converted-to-guidance'").all(item.message_id,target.companionId) as Array<{id:string;reply_message_id:string}>;
      for(const row of rows){sql.prepare("UPDATE bot_inbox SET status='queued',error=NULL,available_at=0 WHERE id=?").run(row.id);sql.prepare("UPDATE bot_messages SET status='queued',error=NULL WHERE id=?").run(row.reply_message_id);}
      sql.prepare("DELETE FROM bot_guidance WHERE message_id=? AND event_id=? AND status='pending'").run(item.message_id,item.event_id);
    });
  }
  guidanceMessages(eventId: string): string[] { return this.store.taskTransaction(sql=>sql.prepare("SELECT message_id FROM bot_guidance WHERE event_id=? AND status='accepted'").all(eventId)).map(row=>(row as {message_id:string}).message_id); }
  cancelQueued(conversationId: string, messageId: string): void {
    this.room(conversationId);
    this.store.taskTransaction(sql=>{
      if(sql.prepare('SELECT 1 FROM bot_guidance WHERE message_id=? LIMIT 1').get(messageId))throw Error('引导投递正在确认，不能同时改为另一种投递。');
      const events=sql.prepare("SELECT id FROM bot_inbox WHERE conversation_id=? AND source_record_id=?").all(conversationId,messageId) as Array<{id:string}>;
      if(!events.length||events.some(row=>this.store.getEvent(row.id)?.status!=='queued'))throw Error('消息已经开始执行。');
      for(const row of events)this.store.cancelEvent(row.id,true);
    });
  }
}
