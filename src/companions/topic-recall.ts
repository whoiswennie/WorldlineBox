import type { CompanionConnection } from './store';
import { companionTopicSchema, companionTopicCheckpointSchema } from '../shared/companion-topic';
import { companionTopicCheckpointValid } from './topic-context';

interface TopicRecallQuery { query?: string; roomId?: string; topicId?: string; tags?: string[]; limit?: number; }
export interface CompanionTopicCheckpointReference {
  conversationId: string; topicId: string; readerId: string; checkpointEventIds: string[];
}
/** A scoped reference index. Topic roles and private state never become reality claims. */
export function recallCompanionTopics(db: CompanionConnection, ownerId: string, query: TopicRecallQuery,
  sourcesValid: (conversationId: string, sourceMessageIds: readonly string[]) => boolean,
  onCheckpoint?: (reference: CompanionTopicCheckpointReference) => void): Array<Record<string, unknown>> {
  const text = query.query ?? '', tags = JSON.stringify(query.tags ?? []);
  const entries = db.prepare(`SELECT t.data,shared.data AS shared_data,mine.data AS mine_data FROM companion_topics t
    JOIN conversations c ON c.id=t.conversation_id AND c.dissolved_at IS NULL
    JOIN conversation_members member ON member.conversation_id=t.conversation_id AND member.companion_id=?
    LEFT JOIN companion_topic_state shared ON shared.topic_id=t.id AND shared.reader_id='*'
    LEFT JOIN companion_topic_state mine ON mine.topic_id=t.id AND mine.reader_id=?
      AND EXISTS(SELECT 1 FROM json_each(t.data,'$.participantIds') p WHERE p.value=?)
    WHERE json_extract(t.data,'$.deletedAt') IS NULL
      AND (EXISTS(SELECT 1 FROM json_each(t.data,'$.participantIds') p WHERE p.value=?)
        OR EXISTS(SELECT 1 FROM json_each(t.data,'$.invitedIds') p WHERE p.value=?))
      AND (? IS NULL OR t.conversation_id=?) AND (? IS NULL OR t.id=?)
      AND (?='' OR instr(lower(json_extract(t.data,'$.title')||' '||json_extract(t.data,'$.tags')||' '||COALESCE(json_extract(shared.data,'$.summary'),'')||' '||COALESCE(json_extract(mine.data,'$.summary'),'')),lower(?))>0)
      AND (?='[]' OR EXISTS(SELECT 1 FROM json_each(t.data,'$.tags') t JOIN json_each(?) q ON lower(t.value)=lower(q.value)))
    ORDER BY json_extract(t.data,'$.updatedAt') DESC,t.rowid DESC LIMIT ?`)
    .all(ownerId,ownerId,ownerId,ownerId,ownerId,query.roomId??null,query.roomId??null,query.topicId??null,query.topicId??null,text,text,tags,tags,query.limit??10) as Array<{data:string;shared_data:string|null;mine_data:string|null}>;
  return entries.flatMap(entry=>{
    const topic=companionTopicSchema.parse(JSON.parse(entry.data));
    const checkpoint=(data:string|null)=>{const value=data?companionTopicCheckpointSchema.parse(JSON.parse(data)):undefined;
      return value&&companionTopicCheckpointValid(db,topic,ownerId,value,ids=>sourcesValid(topic.conversationId,ids))?value:undefined;};
    const shared=checkpoint(entry.shared_data),mine=checkpoint(entry.mine_data);
    if(text&&!`${topic.title} ${topic.tags.join(' ')} ${shared?.summary??''} ${mine?.summary??''}`.toLowerCase().includes(text.toLowerCase()))return[];
    const checkpointEventIds=[...new Set([shared?.sourceEventId,mine?.sourceEventId].filter((id):id is string=>!!id))];
    if(checkpointEventIds.length)onCheckpoint?.({conversationId:topic.conversationId,topicId:topic.id,readerId:ownerId,checkpointEventIds});
    return [{topicId:topic.id,conversationId:topic.conversationId,title:topic.title,tags:topic.tags,kind:topic.kind,status:topic.status,
      participation:topic.participantIds.includes(ownerId)?'joined':'invited',moderatorId:topic.moderatorId,revision:topic.revision,
      ...(shared?{shared:{stage:shared.stage,summary:shared.summary,revision:shared.revision,updatedAt:shared.updatedAt}}:{}),
      ...(mine?{workingSummary:mine.summary,workingStage:mine.stage,hasWorkingState:true,
        ...(query.topicId?{workingState:mine}:{})}:{}),
      read:{capability:'topic',action:'read',topicId:topic.id},source:'participant_topic_index',trust:'topic_state_not_real_world_facts',
      reality:topic.kind==='discussion'?'discussion_record':'fictional_topic_record'}];
  });
}
