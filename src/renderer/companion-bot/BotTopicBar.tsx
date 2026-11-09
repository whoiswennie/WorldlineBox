import { useEffect, useRef, useState } from 'react';
import type { BotCompanion, BotRequest, BotResponse } from '../../shared/companion-bot';
import type { BotChatRuntime, BotNativeTopic } from '../../shared/companion-bot-topics';
import { BotIcon } from './BotIcon';
import './bot-topics.css';

/** Topic selection and the durable pending-input queue live beside the composer. */
export function BotTopicBar({conversationId,runtime,members,locale,request,refresh}:{conversationId:string;runtime?:BotChatRuntime;members:BotCompanion[];locale:'zh-CN'|'en';request(input:BotRequest):Promise<BotResponse>;refresh():Promise<void>}){
  const zh=locale==='zh-CN',[open,setOpen]=useState(false),[query,setQuery]=useState(''),[topics,setTopics]=useState<BotNativeTopic[]>([]),[cursor,setCursor]=useState<string>(),[busy,setBusy]=useState(''),[notice,setNotice]=useState('');
  const generation=useRef(0),compactionId=useRef<string|undefined>(undefined),[companionId,setCompanionId]=useState(members[0]?.id??'');
  useEffect(()=>{
    if(!open)return;
    const current=++generation.current;let cancelled=false;
    const timer=setTimeout(()=>{void request({type:'topic.list',conversationId,query}).then(result=>{if(cancelled||generation.current!==current)return;if(result.ok){setTopics(result.topics??[]);setCursor(result.nextTopicCursor);}});},150);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[open,query,conversationId,request]);
  const act=async(key:string,input:BotRequest)=>{
    if(busy)return;setBusy(key);setNotice('');
    try{const result=await request(input);if(result.compactionSettled)compactionId.current=undefined;if(result.ok){if(input.type==='topic.compact'){setNotice(result.compacted?(zh?'已完成原生上下文压缩':'Native context compacted'):(zh?'当前历史较短，无需压缩':'History is too short to compact'));compactionId.current=undefined;}else setOpen(false);await refresh();}}
    finally{setBusy('');}
  };
  return <div className="bot-topic-dock">
    {!!runtime?.queued.length&&<div className="bot-input-queue" aria-label={zh?'待发送消息':'Pending messages'}>
      <div className="bot-queue-heading"><BotIcon name="clock"/><span>{zh?'消息队列':'Message queue'}</span><small>{runtime.queued.length}</small><span>{zh?'当前任务结束后依次执行':'Runs after the current task'}</span></div>
      <ol>{runtime.queued.map(item=><li key={item.messageId} data-queued-message={item.messageId}>
        <div><p>{item.content||(zh?'附件消息':'Attachments')}</p>{!!item.attachmentNames.length&&<small>{item.attachmentNames.join(' · ')}</small>}{item.state!=='queued'&&<small role="status">{item.error?(zh?'投递待确认，消息已保留':'Delivery pending confirmation; message retained'):(zh?'正在同步到当前 DSH 会话…':'Syncing to the current DSH session…')}</small>}</div>
        <button type="button" disabled={!!busy||!runtime.running.length} onClick={()=>void act(item.messageId,{type:'message.guide',conversationId,messageId:item.messageId})}>{zh?'引导':'Steer'}</button>
        {item.state==='queued'&&<button className="bot-queue-remove" type="button" disabled={!!busy} aria-label={zh?'取消排队':'Cancel queued message'} onClick={()=>void act(item.messageId,{type:'message.dequeue',conversationId,messageId:item.messageId})}>×</button>}
      </li>)}</ol>
    </div>}
    <div className="bot-topic-controls">
      <button type="button" disabled={!!busy} onClick={()=>void act('new',{type:'topic.new',conversationId,requestId:crypto.randomUUID()})}><BotIcon name="plus"/>{zh?'新话题':'New topic'}</button>
      <button className="bot-topic-current" type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)} title={zh?'接入之前的话题':'Connect to an earlier topic'}><BotIcon name="history"/><span>{runtime?.topic?.title??(zh?'选择话题':'Choose topic')}</span><BotIcon name="chevron-down"/></button>
      {members.length>1&&<select aria-label={zh?'压缩会话的伙伴':'Companion session to compact'} value={companionId} onChange={event=>setCompanionId(event.target.value)}>{members.map(member=><option value={member.id} key={member.id}>{member.name}</option>)}</select>}
      <button type="button" disabled={!!busy||!runtime?.topic||!!runtime.running.length} title={zh?'使用 DSH 原生压缩保留本话题要点':'Compact this topic using native DSH'} onClick={()=>{compactionId.current??=crypto.randomUUID();void act('compact',{type:'topic.compact',conversationId,topicId:runtime!.topic!.id,companionId,requestId:compactionId.current});}}><BotIcon name="sparkles"/>{busy==='compact'?(zh?'压缩中…':'Compacting…'):(zh?'压缩':'Compact')}</button>
    </div>
    {open&&<div className="bot-topic-picker" role="dialog" aria-label={zh?'接入之前的话题':'Earlier topics'}>
      <header><strong>{zh?'接入之前的话题':'Earlier topics'}</strong><button type="button" aria-label={zh?'关闭话题列表':'Close topic list'} onClick={()=>setOpen(false)}>×</button></header>
      <input aria-label={zh?'搜索话题':'Search topics'} placeholder={zh?'搜索话题':'Search topics'} value={query} onChange={event=>setQuery(event.target.value)}/>
      <div className="bot-topic-list">{topics.map(topic=><button type="button" key={topic.id} disabled={!!busy} aria-pressed={topic.id===runtime?.topic?.id} onClick={()=>void act(topic.id,{type:'topic.select',conversationId,topicId:topic.id})}><span>{topic.title}</span><small>{new Date(topic.updatedAt).toLocaleDateString(zh?'zh-CN':'en')}</small></button>)}{!topics.length&&<p>{zh?'暂无话题':'No topics yet'}</p>}
        {cursor&&<button type="button" disabled={!!busy} onClick={()=>{setBusy('list');void request({type:'topic.list',conversationId,query,before:cursor}).then(result=>{if(result.ok){setTopics(current=>[...current,...result.topics??[]]);setCursor(result.nextTopicCursor);}}).finally(()=>setBusy(''));}}>{zh?'加载更早话题':'Load earlier topics'}</button>}
      </div>
      <p>{zh?'追问会接续选中的原生会话；新话题使用独立上下文。':'Follow-ups continue the selected native session. New topics have independent context.'}</p>
    </div>}
    {notice&&<small className="bot-topic-notice" role="status">{notice}</small>}
  </div>;
}
