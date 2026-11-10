import { createHash } from 'node:crypto';
import type { BotStore } from './store';
import type { BotEvent } from './types';

const key = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
type Route = { event_id: string; source_event_id: string; source_epoch: number; target_epoch: number; result_event_id: string | null; return_event_id: string | null };
export const BOT_PEER_RETURN_SOURCE = 'peer-return-v1';

/** A contact is a request with a durable return address, not an autonomous
 * conversation loop. Only the addressed worker's committed result crosses this
 * boundary. Fan-out joins once; nested delegation completes its parent only
 * after the delegate has processed its own workers' results. */
export class BotPeerReturns {
  constructor(private readonly store: BotStore) {}
  register(source: BotEvent, targets: readonly BotEvent[]): void {
    this.store.taskTransaction(sql => {
      const live = this.store.getEvent(source.id), room = this.store.getConversation(source.conversationId);
      if (!live || !room || room.dissolvedAt || room.revision !== source.aclRevision || !room.memberIds.includes(source.companionId)
        || this.store.withdrawnIn(source.companionId, source.securityDomainId, this.store.eventSourceIds(source.id)).size) throw Error('伙伴委托的原始会话授权已失效。');
      for (const target of targets) {
        if (target.senderId !== source.companionId || target.causationId !== source.id || target.correlationId !== source.correlationId) throw Error('伙伴回传路径与实际委托不符。');
        sql.prepare('INSERT OR IGNORE INTO bot_peer_returns(event_id,source_event_id,source_epoch,target_epoch) VALUES(?,?,?,?)')
          .run(target.id, source.id, this.store.getLane(source.laneId)!.epoch, this.store.getLane(target.laneId)!.epoch);
      }
    });
  }
  isDirected(event: BotEvent): boolean {
    return event.sourceInstanceId === BOT_PEER_RETURN_SOURCE || !!this.store.taskTransaction(sql => sql.prepare('SELECT 1 FROM bot_peer_returns WHERE event_id=? OR source_event_id=? LIMIT 1').get(event.id,event.id));
  }
  canReadResult(event: BotEvent, messageId: string): boolean {
    if(event.sourceInstanceId!==BOT_PEER_RETURN_SOURCE)return false;
    return this.store.taskTransaction(sql=>{
      const route=sql.prepare(`SELECT r.* FROM bot_peer_returns r JOIN bot_inbox i ON i.id=r.result_event_id
        WHERE r.return_event_id=? AND i.reply_message_id=? LIMIT 1`).get(event.id,messageId) as Route|undefined;
      const source=route&&this.store.getEvent(route.source_event_id),request=route&&this.store.getEvent(route.event_id),result=route?.result_event_id&&this.store.getEvent(route.result_event_id);
      return !!route&&!!source&&!!request&&!!result&&source.companionId===event.companionId
        &&this.valid(source,route.source_epoch)&&this.valid(request,route.target_epoch)&&this.valid(result,route.target_epoch)
        &&this.store.isMessageVisibleToCompanion(messageId,event.companionId)
        &&!this.store.withdrawnIn(event.companionId,result.securityDomainId,[messageId]).size;
    });
  }
  /** Called inside terminal settlement's transaction: a crash cannot commit a
   * worker result while losing its return notification. No network/model I/O. */
  settled(event: BotEvent): void {
    this.store.taskTransaction(sql => {
      const continuation = event.sourceInstanceId === BOT_PEER_RETURN_SOURCE ? event.payload.peerReturn as { assignmentEventId?: string } | undefined : undefined;
      const assignmentId = continuation?.assignmentEventId ?? event.id;
      // The visible acknowledgement of a delegated task is not its completion.
      if (event.status!=='done' || !sql.prepare('SELECT 1 FROM bot_peer_returns WHERE source_event_id=? LIMIT 1').get(event.id)) {
        sql.prepare('UPDATE bot_peer_returns SET result_event_id=? WHERE event_id=? AND result_event_id IS NULL').run(event.id,assignmentId);
      }
      const route = sql.prepare('SELECT source_event_id FROM bot_peer_returns WHERE event_id=?').get(assignmentId) as {source_event_id:string}|undefined;
      if (route) this.flush(route.source_event_id);
      this.flush(event.id); // Workers can finish before their requester settles.
    });
  }
  private valid(event: BotEvent, epoch: number): boolean {
    const room = this.store.getConversation(event.conversationId);
    return !!room && !room.dissolvedAt && room.revision === event.aclRevision && room.memberIds.includes(event.companionId)
      && !!this.store.getCompanion(event.companionId) && this.store.getCompanion(event.companionId)?.enabled !== false && this.store.getLane(event.laneId)?.epoch === epoch
      && !this.store.withdrawnIn(event.companionId,event.securityDomainId,this.store.eventSourceIds(event.id)).size;
  }
  private flush(sourceId: string): void {
    this.store.taskTransaction(sql => {
      const routes = sql.prepare('SELECT * FROM bot_peer_returns WHERE source_event_id=? ORDER BY event_id').all(sourceId) as Route[];
      const source = this.store.getEvent(sourceId);
      if (!source || !routes.length || routes.some(route => route.return_event_id || !route.result_event_id)
        || ['queued','running'].includes(source.status)) return;
      if (source.status !== 'done' || !this.valid(source,routes[0]!.source_epoch)) return;
      const results = routes.map(route => ({ route, request: this.store.getEvent(route.event_id)!, result: this.store.getEvent(route.result_event_id!)! }));
      if (results.some(({route,request,result}) => !request || !result || !this.valid(request,route.target_epoch) || !this.valid(result,route.target_epoch))) return;
      const sourceReply=this.store.getMessage(source.replyMessageId);
      // A requester may have explicitly read the real reply while its original
      // native turn was still running. That turn can deliver the answer itself;
      // don't follow it with a second, redundant "formal result" notification.
      const consumed=!!sourceReply?.content.trim() && results.every(({result})=>sql.prepare(`SELECT 1 FROM bot_peer_bridges
        WHERE source_owner=? AND source_id=? AND target_message_id=? LIMIT 1`).get(source.companionId,result.replyMessageId,source.replyMessageId));
      if(consumed){
        sql.prepare('UPDATE bot_peer_returns SET return_event_id=? WHERE source_event_id=?').run(source.id,source.id);
        const assignment=source.sourceInstanceId===BOT_PEER_RETURN_SOURCE?(source.payload.peerReturn as {assignmentEventId:string}).assignmentEventId:source.id;
        sql.prepare('UPDATE bot_peer_returns SET result_event_id=? WHERE event_id=? AND result_event_id IS NULL').run(source.id,assignment);
        const parent=sql.prepare('SELECT source_event_id FROM bot_peer_returns WHERE event_id=?').get(assignment) as {source_event_id:string}|undefined;
        if(parent)this.flush(parent.source_event_id);
        return;
      }
      const room = this.store.getConversation(source.conversationId)!;
      const contentLimit = Math.min(16000,Math.floor(48000/results.length));
      const items = results.map(({request,result}) => {
        const message = this.store.getMessage(result.replyMessageId)!;
        const directGrant = this.store.getMetadata('peer-user-reply-grant:'+request.id);
        return { companionId: result.companionId, companionName: this.store.getCompanion(result.companionId)!.name,
          requestEventId: request.id, requestMessageId: request.sourceMessageRecordId, conversationId: result.conversationId,
          messageId: message.id, status: result.status, content: message.content.slice(0,contentLimit), contentIsExcerpt: message.content.length > contentLimit,
          error: result.error, attachmentIds: message.attachments?.map(ref => ref.id) ?? [],
          readArgs: { messageId:message.id,offset:0,limit:1200 },
          userDirectDelivery: !!(directGrant && JSON.parse(directGrant).reply) };
      });
      const last = results.reduce((latest,item)=>this.store.getMessage(item.result.replyMessageId)!.sequence>this.store.getMessage(latest.replyMessageId)!.sequence?item.result:latest,results[0]!.result), speaker = this.store.getCompanion(last.companionId)!;
      const id = 'event-'+key(['peer-return',source.id]), replyId = 'reply-'+id;
      const previous = source.sourceInstanceId === BOT_PEER_RETURN_SOURCE ? source.payload.peerReturn as {assignmentEventId:string} : undefined;
      const payload = { hop: Number(source.payload.hop ?? 0), directedPeer: true,
        peerReturn: { assignmentEventId: previous?.assignmentEventId ?? source.id, sourceEventId: source.id,
          originalMessageId: source.sourceMessageRecordId, coordinatorId: source.companionId, request: source.content.slice(0,4000), results: items } };
      const content = JSON.stringify({ type:'peer-results', results:items });
      const stamp = new Date().toISOString();
      // Reuse the actual published peer message. There is no forged incoming
      // bubble in the user's direct room and no membership expansion.
      sql.prepare('INSERT OR IGNORE INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(replyId,id,room.id,source.companionId,this.store.getCompanion(source.companionId)!.name,'companion','','queued','message',source.correlationId,stamp);
      // This is a reserved return of work already admitted, not fresh automatic
      // discussion. Capacity limits must never silently drop its completion.
      sql.prepare(`INSERT OR IGNORE INTO bot_inbox(id,lane_id,conversation_id,companion_id,source,source_instance_id,source_message_id,sender_id,sender_type,sender_name,scope_id,domain_id,acl_revision,kind,content,payload_json,correlation_id,causation_id,source_record_id,reply_message_id,status,occurred_at,received_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,source.laneId,room.id,source.companionId,'companion',BOT_PEER_RETURN_SOURCE,last.replyMessageId,
          speaker.id,'companion',speaker.name,room.audienceScopeId,room.securityDomainId,room.revision,'message',content,JSON.stringify(payload),source.correlationId,source.id,last.replyMessageId,replyId,'queued',stamp,stamp);
      sql.prepare('UPDATE bot_peer_returns SET return_event_id=? WHERE source_event_id=?').run(id,source.id);
      // A withdrawal in any worker's domain must also invalidate the returned
      // summary. Existing durable withdrawal propagation handles the bridge.
      for (const {result} of results) for (const sourceId of this.store.eventSourceIds(result.id))
        sql.prepare('INSERT OR IGNORE INTO bot_peer_bridges VALUES(?,?,?,?,?)').run(result.companionId,result.securityDomainId,sourceId,room.id,replyId);
    });
  }
}
