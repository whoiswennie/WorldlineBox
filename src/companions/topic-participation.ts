import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import { companionTopicSchema, type CompanionTopic } from '../shared/companion-topic';

export interface TopicParticipationReceipt {
  id:string;topicId:string;conversationId:string;companionId:string;action:'joined'|'left'|'closed';
  title:string;kind:CompanionTopic['kind'];tags:string[];topicRevision:number;occurredAt:string;
  trust:'actual_participation_only';
}
export function topicParticipationMemoryContent(receipt:TopicParticipationReceipt):string {
  const action=receipt.action==='joined'?'我加入了话题':receipt.action==='left'?'我退出了话题':'我参与的以下话题已结束：';
  return `${receipt.occurredAt}，${action}「${receipt.title}」（${receipt.kind}，话题ID ${receipt.topicId}）。这里只记录实际参与事件，不代表认同或经历其中的虚构身份、秘密和情节。`;
}
export function topicParticipationMemoryTags(receipt:TopicParticipationReceipt):string[] {
  return [...new Set(['话题参与','话题:'+receipt.topicId,'类型:'+receipt.kind,...receipt.tags])].slice(0,50);
}
export function initializeTopicParticipationReceipts(db:CompanionConnection):void {
  db.exec(`CREATE TABLE IF NOT EXISTS companion_topic_participation_receipts(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL REFERENCES companion_topics(id),companion_id TEXT NOT NULL REFERENCES companions(id),data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS companion_topic_receipt_owner ON companion_topic_participation_receipts(companion_id,topic_id);`);
}
/** Called only after a real host-owned topic transition; never accepts model-authored event data. */
export function persistTopicParticipation(db:CompanionConnection, subject:CompanionTopic, companionId:string, action:TopicParticipationReceipt['action']):TopicParticipationReceipt|undefined {
  if (companionId==='user') return;
  const found=db.prepare('SELECT data FROM companion_topics WHERE id=?').get(subject.id) as {data:string}|undefined;
  if(!found) throw Error('话题参与凭证缺少实际话题。');
  const topic=companionTopicSchema.parse(JSON.parse(found.data));
  if(topic.revision!==subject.revision) throw Error('话题参与凭证版本已变化。');
  if(!db.prepare('SELECT 1 FROM conversation_members m JOIN companions c ON c.id=m.companion_id WHERE m.conversation_id=? AND m.companion_id=? AND c.deleted_at IS NULL').get(topic.conversationId,companionId)) return;
  const member=topic.participantIds.includes(companionId);
  if(action==='joined'&&!member||action==='left'&&(member||!topic.invitedIds.includes(companionId))||action==='closed'&&(!member||topic.status!=='closed')) throw Error('话题参与凭证与实际参与状态不一致。');
  const id='topic_participation_'+createHash('sha256').update(JSON.stringify([topic.id,companionId,action,topic.revision])).digest('hex').slice(0,48);
  const existing=db.prepare('SELECT data FROM companion_topic_participation_receipts WHERE id=?').get(id) as {data:string}|undefined;
  if(existing) return JSON.parse(existing.data) as TopicParticipationReceipt;
  const receipt:TopicParticipationReceipt={id,topicId:topic.id,conversationId:topic.conversationId,companionId,action,title:topic.title,kind:topic.kind,tags:[...topic.tags],topicRevision:topic.revision,occurredAt:topic.updatedAt,trust:'actual_participation_only'};
  db.prepare('INSERT INTO companion_topic_participation_receipts(id,topic_id,companion_id,data) VALUES(?,?,?,?)').run(id,topic.id,companionId,JSON.stringify(receipt));
  return receipt;
}
