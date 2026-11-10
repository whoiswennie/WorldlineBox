import { useRef, useState } from 'react';
import type { BotCompanion, BotRequest, BotResponse } from '../../shared/companion-bot';
import type { BotChatRuntime } from '../../shared/companion-bot-topics';
import { BotIcon } from './BotIcon';
import {BotTopicPicker} from './BotTopicPicker';
import {BotContextMeter} from './BotContextMeter';
import './bot-topics.css';

/** Topic selection and the durable pending-input queue live beside the composer. */
export function BotTopicBar({conversationId,runtime,members,locale,request,refresh}:{conversationId:string;runtime?:BotChatRuntime;members:BotCompanion[];locale:'zh-CN'|'en';request(input:BotRequest):Promise<BotResponse>;refresh():Promise<void>}){
  const zh=locale==='zh-CN',[open,setOpen]=useState(false),[busy,setBusy]=useState(''),[notice,setNotice]=useState('');
  const compactionId=useRef<string|undefined>(undefined),[companionChoice,setCompanionChoice]=useState(members[0]?.id??'');
  const companionId=members.some(member=>member.id===companionChoice)?companionChoice:members[0]?.id??'';
  const nativeActivity=runtime?.contexts?.[companionId]?.activity,nativeBusy=!!nativeActivity&&nativeActivity.phase!=='idle';
  const nativeCompacting=nativeActivity?.phase==='compacting'||nativeActivity?.command==='compact';
  const act=async(key:string,input:BotRequest)=>{
    if(busy)return;setBusy(key);setNotice('');
    const compactedTopic=runtime?.topic?.title,compactedCompanion=members.find(member=>member.id===companionId)?.name;
    try{const result=await request(input);if(result.compactionSettled)compactionId.current=undefined;if(result.ok){if(input.type==='topic.compact'){setNotice([compactedCompanion,compactedTopic,result.compacted?(zh?'已完成原生上下文压缩':'Native context compacted'):(zh?'当前历史较短，无需压缩':'History is too short to compact')].filter(Boolean).join(' · '));compactionId.current=undefined;}else setOpen(false);await refresh();}}
    finally{setBusy('');}
  };
  const compact=()=>{compactionId.current??=crypto.randomUUID();void act('compact',{type:'topic.compact',conversationId,topicId:runtime!.topic!.id,companionId,requestId:compactionId.current});};
  return <div className="bot-topic-dock">
    {!!runtime?.queued.length&&<div className="bot-input-queue" aria-label={zh?'待发送消息':'Pending messages'}>
      <div className="bot-queue-heading"><BotIcon name="clock"/><span>{zh?'消息队列':'Message queue'}</span><small>{runtime.queued.length}</small><span>{zh?'当前任务结束后依次执行':'Runs after the current task'}</span></div>
      <ol>{runtime.queued.map(item=><li key={item.messageId} data-queued-message={item.messageId}>
        <div><p>{item.content||(zh?'附件消息':'Attachments')}</p>{!!item.attachmentNames.length&&<small>{item.attachmentNames.join(' · ')}</small>}{item.state!=='queued'&&<small role="status">{item.error?(zh?'投递待确认，消息已保留':'Delivery pending confirmation; message retained'):(zh?'正在同步到当前 DSH 会话…':'Syncing to the current DSH session…')}</small>}</div>
        <button type="button" disabled={!!busy||!runtime.running.length||nativeActivity?.phase==='compacting'||nativeActivity?.phase==='maintenance'} onClick={()=>void act(item.messageId,{type:'message.guide',conversationId,messageId:item.messageId})}>{zh?'引导':'Steer'}</button>
        {item.state==='queued'&&<button className="bot-queue-remove" type="button" disabled={!!busy} aria-label={zh?'取消排队':'Cancel queued message'} onClick={()=>void act(item.messageId,{type:'message.dequeue',conversationId,messageId:item.messageId})}>×</button>}
      </li>)}</ol>
    </div>}
    <div className="bot-topic-controls">
      <button type="button" disabled={!!busy} onClick={()=>void act('new',{type:'topic.new',conversationId,requestId:crypto.randomUUID()})}><BotIcon name="plus"/>{zh?'新话题':'New topic'}</button>
      <button className="bot-topic-current" type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)} title={zh?'接入之前的话题':'Connect to an earlier topic'}><BotIcon name="history"/><span>{runtime?.topic?.title??(zh?'选择话题':'Choose topic')}</span><BotIcon name="chevron-down"/></button>
      {members.length>1&&<select aria-label={zh?'当前话题的伙伴会话':'Companion session in this topic'} title={zh?'选择查看上下文与执行压缩的伙伴':'Choose whose context to inspect or compact'} value={companionId} onChange={event=>setCompanionChoice(event.target.value)}>{members.map(member=><option value={member.id} key={member.id}>{member.name}</option>)}</select>}
      <button type="button" disabled={!!busy||nativeBusy||!runtime?.topic||!!runtime.running.length} title={zh?'使用 DSH 原生压缩保留本话题要点':'Compact this topic using native DSH'} onClick={compact}><BotIcon name="sparkles"/>{busy==='compact'||nativeCompacting?(zh?'压缩中…':'Compacting…'):(zh?'压缩':'Compact')}</button>
      {runtime?.topic&&companionId&&<BotContextMeter key={conversationId+':'+runtime.topic.id+':'+companionId} conversationId={conversationId} topic={runtime.topic} companionId={companionId} companionName={members.find(member=>member.id===companionId)?.name??''} cached={runtime.contexts?.[companionId]} locale={locale} request={request} busy={!!busy} canCompact={!runtime.running.length} onCompact={compact} onNew={()=>void act('new',{type:'topic.new',conversationId,requestId:crypto.randomUUID()})}/>}
    </div>
    {open&&<BotTopicPicker conversationId={conversationId} currentId={runtime?.topic?.id} locale={locale} request={request} refresh={refresh} onClose={()=>setOpen(false)}/>}
    {notice&&<small className="bot-topic-notice" role="status">{notice}</small>}
  </div>;
}
