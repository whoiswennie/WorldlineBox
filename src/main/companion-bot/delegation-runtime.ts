import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {BotStore} from './store';
import type {BotEvent,BotTask} from './types';
import {isBotParticipantRequest} from './participant-request';

const id=z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/u);
const inputSchema=z.strictObject({recipientId:id,peerConversationId:id,contactEventId:id,proxyTaskId:id,goal:z.string().trim().min(1).max(32000),title:z.string().trim().min(1).max(120)});
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp=()=>new Date().toISOString();
const eventBinding=(event:BotEvent)=>[event.id,event.companionId,event.conversationId,event.laneId,event.securityDomainId,event.audienceScopeId,event.aclRevision,event.source,
  event.senderType,event.senderId,event.correlationId,event.causationId,event.sourceMessageRecordId,event.sourceMessageId,event.sourceInstanceId,event.sourceMessageSequence,event.content,event.payload];
export interface BotDelegationTicket {
  id:string;sourceEventId:string;requesterId:string;recipientId:string;sourceConversationId:string;peerConversationId:string;contactEventId:string;proxyTaskId:string;
  goal:string;title:string;state:'active'|'completed'|'cancelled';correlationId:string;sourceAclRevision:number;createdAt:string;updatedAt:string;
}
export interface BotDelegationResultInput {content:string;attachmentIds?:string[];messageId?:string}
export interface BotDelegationResultReceipt {delegationId:string;callId:string;fingerprint:string;content:string;attachmentIds:string[];messageId?:string;recordedAt:string}
export type BotDelegationCreateInput=z.infer<typeof inputSchema>;
type JsonRow={record_json:string;fingerprint:string};

/** Main-owned narrow delegation facts. This module never sends a message,
 * starts a Worker, grants an attachment or infers work from ordinary chat. */
export class BotDelegationRuntime {
  constructor(private readonly store:BotStore){
    store.taskTransaction(sql=>{
      sql.prepare(`CREATE TABLE IF NOT EXISTS bot_delegations(id TEXT PRIMARY KEY,requester_id TEXT NOT NULL,recipient_id TEXT NOT NULL,source_conversation_id TEXT NOT NULL,
        peer_conversation_id TEXT NOT NULL,source_event_id TEXT NOT NULL,contact_event_id TEXT NOT NULL UNIQUE,proxy_task_id TEXT NOT NULL UNIQUE,record_json TEXT NOT NULL,fingerprint TEXT NOT NULL)`).run();
      sql.prepare('CREATE INDEX IF NOT EXISTS bot_delegations_requester ON bot_delegations(requester_id,source_conversation_id)').run();
      sql.prepare('CREATE INDEX IF NOT EXISTS bot_delegations_recipient ON bot_delegations(recipient_id,peer_conversation_id)').run();
      sql.prepare('CREATE TABLE IF NOT EXISTS bot_delegation_events(event_id TEXT PRIMARY KEY,delegation_id TEXT NOT NULL,event_fingerprint TEXT NOT NULL)').run();
    });
  }
  private save(ticket:BotDelegationTicket):void{
    const record=JSON.stringify(ticket);
    this.store.taskTransaction(sql=>sql.prepare(`INSERT INTO bot_delegations VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json,fingerprint=excluded.fingerprint`)
      .run(ticket.id,ticket.requesterId,ticket.recipientId,ticket.sourceConversationId,ticket.peerConversationId,ticket.sourceEventId,ticket.contactEventId,ticket.proxyTaskId,record,digest(record)));
  }
  get(ticketId:string):BotDelegationTicket|undefined{
    const row=this.store.taskTransaction(sql=>sql.prepare('SELECT record_json,fingerprint FROM bot_delegations WHERE id=?').get(id.parse(ticketId))) as JsonRow|undefined;
    if(!row)return;if(digest(row.record_json)!==row.fingerprint)throw Error('伙伴委派记录校验失败。');
    const ticket=JSON.parse(row.record_json) as BotDelegationTicket;
    if(ticket.id!==ticketId||!['active','completed','cancelled'].includes(ticket.state))throw Error('伙伴委派身份或状态无效。');return ticket;
  }
  private require(ticketId:string):BotDelegationTicket{const ticket=this.get(ticketId);if(!ticket)throw Error('伙伴委派不存在。');return ticket;}
  private assertEvent(event:BotEvent):BotEvent{
    const current=this.store.getEvent(event.id),room=this.store.getConversation(event.conversationId);
    if(!current||digest(eventBinding(current))!==digest(eventBinding(event))||!room||room.dissolvedAt||room.revision!==current.aclRevision
      ||room.securityDomainId!==current.securityDomainId||room.audienceScopeId!==current.audienceScopeId||!room.memberIds.includes(current.companionId)
      ||this.store.withdrawnIn(current.companionId,current.securityDomainId,[current.id,current.sourceMessageRecordId,...this.store.eventSourceIds(current.id)]).size)throw Error('委派事件来源或聊天权限已经失效。');
    return current;
  }
  private assertGrant(ticket:BotDelegationTicket):BotEvent{
    const source=this.store.getEvent(ticket.sourceEventId),contact=this.store.getEvent(ticket.contactEventId);
    if(!source||!contact)throw Error('委派缺少原始用户请求或真实转达事件。');
    this.assertEvent(source);this.assertEvent(contact);
    const room=this.store.getConversation(source.conversationId)!,peer=this.store.getConversation(contact.conversationId)!;
    if(!isBotParticipantRequest(source,room)||source.status==='cancelled'
      ||source.companionId!==ticket.requesterId||source.conversationId!==ticket.sourceConversationId||source.aclRevision!==ticket.sourceAclRevision
      ||source.correlationId!==ticket.correlationId||contact.source!=='companion'||contact.senderType!=='companion'||contact.senderId!==ticket.requesterId
      ||contact.companionId!==ticket.recipientId||contact.conversationId!==ticket.peerConversationId||contact.causationId!==source.id
      ||contact.correlationId!==ticket.correlationId||contact.status==='cancelled'||peer.kind!=='peer'
      ||JSON.stringify([...peer.memberIds].sort())!==JSON.stringify([ticket.requesterId,ticket.recipientId].sort()))throw Error('委派没有匹配的原始用户授权及伙伴私聊。');
    const prefix=`peer-contact:${source.id}:`;
    if(!contact.sourceMessageId.startsWith(prefix))throw Error('委派不是 Main 已提交的伙伴联系。');
    const saved=this.store.getMetadata(`peer-contact-receipt:${source.id}:${contact.sourceMessageId.slice(prefix.length)}`);
    const receipt=saved?JSON.parse(saved) as Record<string,unknown>:undefined;
    const message=this.store.getMessage(contact.sourceMessageRecordId);
    if(!receipt||!message||!['peer','user'].includes(String(receipt.destination))||receipt.recipientId!==ticket.recipientId||receipt.conversationId!==ticket.peerConversationId
      ||receipt.messageId!==contact.sourceMessageRecordId||receipt.fingerprint!==digest([ticket.recipientId,receipt.destination,message.content]))throw Error('委派缺少可核实的伙伴转达回执。');
    if(receipt.transferFingerprint||message.attachments?.length){
      const sources=this.store.messageSourceIds(message.id).filter(sourceId=>sourceId!==message.id).sort();
      if(receipt.transferFingerprint!==digest([JSON.stringify(message.attachments??[]),JSON.stringify(sources)]))throw Error('委派附件或原始授权血缘与真实转达回执不匹配。');
    }
    return source;
  }
  private proxy(ticket:BotDelegationTicket):BotTask{
    const proxy=this.store.getTask(ticket.proxyTaskId);
    if(!proxy||proxy.sourceEventId!==ticket.sourceEventId||proxy.companionId!==ticket.requesterId||proxy.conversationId!==ticket.sourceConversationId
      ||proxy.goal!==ticket.goal||typeof proxy.extra.delegationId==='string'&&proxy.extra.delegationId!==ticket.id
      ||typeof proxy.extra.externalDelegationId==='string'&&proxy.extra.externalDelegationId!==ticket.id)throw Error('委派代理任务与原始用户请求不匹配。');
    return proxy;
  }
  assertActive(ticket:BotDelegationTicket):void{
    const current=this.require(ticket.id);
    const immutable=(value:BotDelegationTicket)=>({...value,state:'active',updatedAt:''});
    if(digest(immutable(current))!==digest(immutable(ticket))||current.state!=='active')throw Error('伙伴委派已经结束或停止，不能自动重开。');
    this.assertGrant(current);const proxy=this.proxy(current);
    if(!['queued','running','waiting'].includes(proxy.status)||proxy.extra.removedAt||proxy.extra.humanStopped||proxy.extra.cancelRequested||proxy.extra.pauseRequested
      ||this.store.taskSourcesWithdrawn(proxy.id))throw Error('原始委派任务已停止、暂停、结束或来源已失效。');
  }
  create(source:BotEvent,callId:string,input:BotDelegationCreateInput):BotDelegationTicket{
    const actual=this.assertEvent(source),args=inputSchema.parse(input);id.parse(callId);
    if(!isBotParticipantRequest(actual,this.store.getConversation(actual.conversationId)!)||args.recipientId===actual.companionId)throw Error('跨伙伴委派需要有效的用户或伙伴请求及另一位伙伴。');
    const ticketId='delegation-'+digest([actual.id,callId]).slice(0,40),now=stamp();
    const ticket:BotDelegationTicket={...args,id:ticketId,sourceEventId:actual.id,requesterId:actual.companionId,sourceConversationId:actual.conversationId,
      state:'active',correlationId:actual.correlationId,sourceAclRevision:actual.aclRevision,createdAt:now,updatedAt:now};
    this.assertGrant(ticket);this.proxy(ticket);
    return this.store.taskTransaction(sql=>{
      const previous=this.get(ticketId);
      if(previous){const {recipientId,peerConversationId,contactEventId,proxyTaskId,goal,title}=previous;
        if(digest({recipientId,peerConversationId,contactEventId,proxyTaskId,goal,title})!==digest(args))throw Error('同一委派调用不能用于不同目标或任务。');return previous;}
      this.assertActiveNew(ticket);this.save(ticket);
      sql.prepare('INSERT INTO bot_delegation_events VALUES(?,?,?)').run(ticket.contactEventId,ticket.id,digest(eventBinding(this.store.getEvent(ticket.contactEventId)!)));
      return ticket;
    });
  }
  private assertActiveNew(ticket:BotDelegationTicket):void{
    const proxy=this.proxy(ticket);
    if(!['queued','running','waiting'].includes(proxy.status)||proxy.extra.removedAt||proxy.extra.humanStopped||proxy.extra.cancelRequested||proxy.extra.pauseRequested
      ||this.store.taskSourcesWithdrawn(proxy.id))throw Error('已停止、暂停或失效的代理任务不能新建委派。');
  }
  forEvent(event:BotEvent):BotDelegationTicket|undefined{
    const current=this.assertEvent(event);
    const bound=this.store.taskTransaction(sql=>sql.prepare('SELECT delegation_id,event_fingerprint FROM bot_delegation_events WHERE event_id=?').get(current.id)) as {delegation_id:string;event_fingerprint:string}|undefined;
    if(bound){
      if(bound.event_fingerprint!==digest(eventBinding(current)))throw Error('委派更新事件绑定发生变化。');
      const ticket=this.require(bound.delegation_id);
      if(current.companionId!==ticket.recipientId||current.conversationId!==ticket.peerConversationId||current.correlationId!==ticket.correlationId)throw Error('委派事件不属于接收方聊天。');return ticket;
    }
    if(current.source!=='task'||current.senderId!=='task-service'||typeof current.payload.taskId!=='string')return;
    const task=this.store.getTask(current.payload.taskId);
    const delegationId=task?.extra.delegationId??task?.extra.parentDelegationId;
    if(!task||typeof delegationId!=='string')return;
    const ticket=this.require(delegationId);
    if(task.id===ticket.proxyTaskId||task.companionId!==ticket.recipientId||task.conversationId!==ticket.peerConversationId)return;
    if(current.companionId!==ticket.recipientId||current.conversationId!==ticket.peerConversationId||current.correlationId!==ticket.correlationId
      ||current.causationId!==task.sourceEventId)throw Error('任务通知不属于此伙伴委派。');
    return ticket;
  }
  /** Only Main may bind a newly created, explicitly requested update. An
   * ordinary causal reply never acquires this binding by itself. */
  bindEvent(ticketId:string,eventId:string):void{
    const ticket=this.require(ticketId);this.assertActive(ticket);const value=this.store.getEvent(eventId);if(!value)throw Error('委派更新事件不存在。');const event=this.assertEvent(value);
    if(event.source!=='companion'||event.senderType!=='companion'||event.senderId!==ticket.requesterId||event.companionId!==ticket.recipientId
      ||event.conversationId!==ticket.peerConversationId||event.correlationId!==ticket.correlationId)throw Error('委派更新不属于明确的接收方私聊。');
    this.store.taskTransaction(sql=>{
      const prior=sql.prepare('SELECT delegation_id,event_fingerprint FROM bot_delegation_events WHERE event_id=?').get(eventId) as {delegation_id:string;event_fingerprint:string}|undefined;
      if(prior&&(prior.delegation_id!==ticket.id||prior.event_fingerprint!==digest(eventBinding(event))))throw Error('同一事件不能绑定不同委派。');
      sql.prepare('INSERT OR IGNORE INTO bot_delegation_events VALUES(?,?,?)').run(eventId,ticket.id,digest(eventBinding(event)));
    });
  }
  tasks(ticketId:string):BotTask[]{
    const ticket=this.require(ticketId);
    const rows=this.store.taskTransaction(sql=>sql.prepare(`SELECT id FROM bot_tasks WHERE companion_id=? AND conversation_id=? AND id<>? AND (json_extract(extra_json,'$.delegationId')=? OR json_extract(extra_json,'$.parentDelegationId')=?) ORDER BY created_at,id`)
      .all(ticket.recipientId,ticket.peerConversationId,ticket.proxyTaskId,ticket.id,ticket.id)) as Array<{id:string}>;
    return rows.flatMap(row=>{const task=this.store.getTask(row.id);return task?[task]:[];});
  }
  causalParent(event:BotEvent):BotDelegationTicket|undefined{
    const visited=new Set<string>();let current:BotEvent|undefined=this.assertEvent(event);
    while(current){
      if(visited.has(current.id)||visited.size>=32)throw Error('任务因果链无效。');visited.add(current.id);
      const ticket=this.forEvent(current);if(ticket){this.assertActive(ticket);return ticket;}
      current=current.causationId?this.store.getEvent(current.causationId):undefined;
    }
  }
  controlledTasks(ticketId:string):BotTask[]{
    const own=this.tasks(ticketId),rows=this.store.taskTransaction(sql=>sql.prepare("SELECT id FROM bot_tasks WHERE id<>? AND json_extract(extra_json,'$.causalDelegationId')=? ORDER BY created_at,id")
      .all(this.require(ticketId).proxyTaskId,ticketId)) as Array<{id:string}>;
    return [...new Map([...own,...rows.flatMap(row=>{const task=this.store.getTask(row.id);return task?[task]:[];})].map(task=>[task.id,task])).values()];
  }
  allowsWork(event:BotEvent):boolean{
    try{
      const visited=new Set<string>();let current:BotEvent|undefined=event;
      // Equal participant privileges do not revive a stopped delegation via a
      // late ordinary peer message derived from its old Worker or contact.
      while(current){
        if(visited.has(current.id)||visited.size>=32)return false;visited.add(current.id);
        const ticket=this.forEvent(current);if(ticket)this.assertActive(ticket);
        current=current.causationId?this.store.getEvent(current.causationId):undefined;
      }
      return true;
    }catch{return false;}
  }
  scoped(event:BotEvent,ticketId:string):BotDelegationTicket{
    const current=this.assertEvent(event),ticket=this.require(ticketId);
    if(!(current.companionId===ticket.requesterId&&current.conversationId===ticket.sourceConversationId)
      &&!(current.companionId===ticket.recipientId&&current.conversationId===ticket.peerConversationId))throw Error('伙伴委派不属于当前角色和聊天。');return ticket;
  }
  status(event:BotEvent,ticketId?:string,options:{offset?:number;limit?:number}={}){
    this.assertEvent(event);const offset=Math.max(0,Math.min(30000000,Number.isSafeInteger(options.offset)?options.offset!:0)),limit=Math.max(1,Math.min(10,Number.isSafeInteger(options.limit)?options.limit!:10));
    const tickets=ticketId?[this.scoped(event,ticketId)]:this.store.taskTransaction(sql=>(sql.prepare(`SELECT id FROM bot_delegations WHERE requester_id=? AND source_conversation_id=? OR recipient_id=? AND peer_conversation_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .all(event.companionId,event.conversationId,event.companionId,event.conversationId,limit+1,offset) as Array<{id:string}>).map(row=>this.require(row.id)));
    return{tickets:tickets.slice(0,limit).map(ticket=>{
      let available=true;try{this.assertGrant(ticket);}catch{available=false;}
      let allowsWork=false;try{this.assertActive(ticket);allowsWork=true;}catch{/* A read-only status must not restore stopped authority. */}
      const tasks=available?this.tasks(ticket.id):[];
      const ownIds=new Set(tasks.map(task=>task.id)),derived=available?this.controlledTasks(ticket.id).filter(task=>!ownIds.has(task.id)):[];
      return{...ticket,title:available?ticket.title:'',goal:available?ticket.goal.slice(0,2000):'',available,allowsWork,taskCount:tasks.length,
        derivedTaskCount:derived.length,derivedTasks:derived.slice(0,10).map(task=>({id:task.id,companionId:task.companionId,status:task.extra.removedAt?'removed':task.status})),
        tasks:tasks.slice(0,10).map(task=>({id:task.id,status:task.extra.removedAt?'removed':task.status,title:typeof task.extra.title==='string'?task.extra.title.slice(0,120):task.goal.slice(0,120),
          updatedAt:task.updatedAt,...(task.extra.progress&&typeof task.extra.progress==='object'?{progress:{phase:String((task.extra.progress as Record<string,unknown>).phase??'').slice(0,100),detail:String((task.extra.progress as Record<string,unknown>).detail??'').slice(0,1000)}}:{})}))};
    }),...(tickets.length>limit?{nextOffset:offset+limit}:{})};
  }
  finish(ticketId:string,state:'completed'|'cancelled'):BotDelegationTicket{
    if(!['completed','cancelled'].includes(state))throw Error('委派结束状态无效。');
    return this.store.taskTransaction(()=>{const ticket=this.require(ticketId);if(ticket.state===state)return ticket;if(ticket.state!=='active')throw Error('已结束委派不能自动重开或改写结果。');
      if(state==='completed'){this.assertGrant(ticket);const proxy=this.proxy(ticket);if(proxy.status==='cancelled'||proxy.extra.humanStopped||proxy.extra.cancelRequested||proxy.extra.removedAt)throw Error('已停止委派不能发布完成结果。');}
      const next={...ticket,state,updatedAt:stamp()};this.save(next);return next;});
  }
  cancelScope(event:BotEvent):{tickets:BotDelegationTicket[];taskIds:string[]};
  cancelScope(conversationId:string,requesterId?:string):{tickets:BotDelegationTicket[];taskIds:string[]};
  cancelScope(scope:BotEvent|string,requesterId?:string):{tickets:BotDelegationTicket[];taskIds:string[]}{
    if(typeof scope!=='string'){this.assertEvent(scope);requesterId=scope.companionId;scope=scope.conversationId;}
    id.parse(scope);if(requesterId)id.parse(requesterId);
    return this.store.taskTransaction(sql=>{
      const rows=sql.prepare(`SELECT id FROM bot_delegations WHERE source_conversation_id=?${requesterId?' AND requester_id=?':''}`).all(scope,...(requesterId?[requesterId]:[])) as Array<{id:string}>;
      const tickets=rows.map(row=>this.require(row.id)).filter(ticket=>ticket.state==='active');const taskIds=[...new Set(tickets.flatMap(ticket=>this.controlledTasks(ticket.id).map(task=>task.id)))];
      return{tickets:tickets.map(ticket=>this.finish(ticket.id,'cancelled')),taskIds};
    });
  }
  private resultInput(input:BotDelegationResultInput){
    const value=z.strictObject({content:z.string().max(24000),attachmentIds:z.array(id).max(64).optional(),messageId:id.optional()}).parse(input);
    const attachments=[...new Set(value.attachmentIds??[])];if(!value.content.trim()&&!attachments.length)throw Error('委派成果不能为空。');
    return{...value,attachmentIds:attachments};
  }
  resultReceipt(ticketId:string,callId:string,input?:BotDelegationResultInput):BotDelegationResultReceipt|undefined{
    this.require(ticketId);id.parse(callId);const saved=this.store.getMetadata('delegation-result:'+digest([ticketId,callId]));if(!saved)return;
    const receipt=JSON.parse(saved) as BotDelegationResultReceipt;
    if(receipt.delegationId!==ticketId||receipt.callId!==callId||input&&receipt.fingerprint!==digest(this.resultInput(input)))throw Error('委派成果回执参数不匹配。');return receipt;
  }
  recordResult(ticketId:string,callId:string,input:BotDelegationResultInput):BotDelegationResultReceipt{
    const value=this.resultInput(input);id.parse(callId);
    return this.store.taskTransaction(()=>{
      const prior=this.resultReceipt(ticketId,callId,value);if(prior)return prior;
      const ticket=this.require(ticketId);this.assertActive(ticket);
      if(value.messageId){const message=this.store.getMessage(value.messageId);if(!message||message.conversationId!==ticket.sourceConversationId||message.status!=='sent'||message.senderId!==ticket.requesterId||message.senderType!=='companion'
        ||message.content!==value.content||digest((message.attachments??[]).map(ref=>ref.id))!==digest(value.attachmentIds))throw Error('委派成果没有匹配的真实原聊天交付消息。');}
      const receipt:BotDelegationResultReceipt={delegationId:ticketId,callId,fingerprint:digest(value),...value,recordedAt:stamp()};
      this.store.setMetadata('delegation-result:'+digest([ticketId,callId]),JSON.stringify(receipt));return receipt;
    });
  }
}
