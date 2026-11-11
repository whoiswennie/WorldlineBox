import {useEffect,useRef,useState} from 'react';
import type {BotRequest,BotResponse} from '../../shared/companion-bot';
import type {BotNativeTopic,BotTopicListMode} from '../../shared/companion-bot-topics';
import {BotIcon} from './BotIcon';

export function BotTopicPicker({conversationId,currentId,locale,request,refresh,onClose}:{conversationId:string;currentId?:string;locale:'zh-CN'|'en';request(input:BotRequest):Promise<BotResponse>;refresh():Promise<void>;onClose():void}){
  const zh=locale==='zh-CN',[mode,setMode]=useState<BotTopicListMode>('recent'),[query,setQuery]=useState(''),[topics,setTopics]=useState<BotNativeTopic[]>([]),[next,setNext]=useState<string>(),[cursors,setCursors]=useState<string[]>([]),[revision,setRevision]=useState(0),[loading,setLoading]=useState(false),[busy,setBusy]=useState(''),[menu,setMenu]=useState('');
  const [rename,setRename]=useState<{topic:BotNativeTopic;draft:string;requestId:string}>(),host=useRef<HTMLDivElement>(null),working=useRef(false);
  const cursor=cursors.at(-1),pending=topics.some(topic=>topic.renamePending);
  const [stale,setStale]=useState(false);
  useEffect(()=>{
    let cancelled=false,reading=false;
    const read=()=>{if(reading||working.current)return;reading=true;void request({type:'topic.list',conversationId,query,mode,before:cursor}).then(result=>{if(cancelled)return;if(result.ok){setTopics(result.topics??[]);setNext(result.nextTopicCursor);setStale(!!result.topicListStale);}else setStale(true);}).catch(()=>{if(!cancelled)setStale(true);}).finally(()=>{reading=false;if(!cancelled)setLoading(false);});};
    const timer=setTimeout(()=>{setLoading(true);read();},query?150:0),poll=setInterval(read,1500);
    return()=>{cancelled=true;clearTimeout(timer);clearInterval(poll);};
  },[conversationId,query,mode,cursor,revision,request]);
  useEffect(()=>{if(!pending)return;const timer=setTimeout(()=>setRevision(value=>value+1),1200);return()=>clearTimeout(timer);},[pending,topics]);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(event.target instanceof Element&&!host.current?.contains(event.target)&&!event.target.closest('.bot-topic-current'))onClose();};
    document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
  },[onClose]);
  const mutate=async(input:BotRequest,key:string)=>{
    if(working.current)return;working.current=true;setBusy(key);
    try{const result=await request(input);if(result.ok){setMenu('');setRename(undefined);setRevision(value=>value+1);await refresh();if(input.type==='topic.select')onClose();}}
    finally{working.current=false;setBusy('');}
  };
  return <div className="bot-topic-picker" ref={host} role="dialog" aria-label={zh?'接入之前的话题':'Earlier topics'} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();if(rename)setRename(undefined);else if(menu)setMenu('');else onClose();}}}>
    <header><strong>{zh?'话题':'Topics'}</strong><button type="button" aria-label={zh?'关闭话题列表':'Close topic list'} onClick={onClose}>×</button></header>
    {stale&&<small role="status">{zh?'DSH 暂未连接，显示上次确认的会话':'DSH unavailable; showing last confirmed sessions'}</small>}
    <div className="bot-topic-tabs" role="tablist" aria-label={zh?'话题分类':'Topic categories'}>{(['recent','all','favorites'] as const).map(value=><button type="button" key={value} role="tab" aria-selected={mode===value} onClick={()=>{setMode(value);setCursors([]);setMenu('');}}>{value==='favorites'&&<BotIcon name="star"/>}{value==='recent'?(zh?'最近':'Recent'):value==='all'?(zh?'全部':'All'):(zh?'收藏夹':'Favorites')}</button>)}</div>
    <input aria-label={zh?'搜索话题':'Search topics'} placeholder={mode==='favorites'?(zh?'模糊搜索收藏话题':'Search favorite topics'):(zh?'模糊搜索话题':'Search topics')} value={query} onChange={event=>{setQuery(event.target.value);setCursors([]);setMenu('');}}/>
    {rename&&<form className="bot-topic-rename" role="dialog" aria-label={zh?'重命名话题':'Rename topic'} onSubmit={event=>{event.preventDefault();void mutate({type:'topic.rename',conversationId,topicId:rename.topic.id,title:rename.draft.trim(),requestId:rename.requestId},rename.topic.id);}}>
      <label>{zh?'话题名称':'Topic name'}<input autoFocus maxLength={100} value={rename.draft} onChange={event=>setRename({...rename,draft:event.target.value})}/></label>
      <small>{zh?'同步修改此话题在 DSH 中的会话名称。':'Also renames this topic’s native DSH sessions.'}</small><div><button type="button" disabled={!!busy} onClick={()=>setRename(undefined)}>{zh?'取消':'Cancel'}</button><button type="submit" disabled={!!busy||!rename.draft.trim()}>{busy?(zh?'保存中…':'Saving…'):(zh?'保存名称':'Save name')}</button></div>
    </form>}
    <div className="bot-topic-list" aria-busy={loading}>{topics.map(topic=><div className="bot-topic-row" key={topic.id} data-topic-id={topic.id}>
      <button className="bot-topic-open" type="button" disabled={!!busy} aria-pressed={topic.id===currentId} onClick={()=>void mutate({type:'topic.select',conversationId,topicId:topic.id},topic.id)}>
        {topic.pinned&&<BotIcon name="pin"/>}<span title={topic.title}>{topic.title}</span>{topic.favorite&&<BotIcon name="star"/>}<small title={new Date(topic.updatedAt).toLocaleString(locale)}>{new Date(topic.updatedAt).toLocaleDateString(locale)}</small>{topic.renamePending&&<span className="bot-topic-sync" title={zh?'等待同步到 DSH':'Waiting to sync to DSH'}><BotIcon name="clock"/></span>}
      </button>
      <button className="bot-topic-more" type="button" aria-label={`${zh?'管理话题':'Manage topic'} ${topic.title}`} aria-expanded={menu===topic.id} onClick={()=>setMenu(menu===topic.id?'':topic.id)}><BotIcon name="more"/></button>
      {menu===topic.id&&<div className="bot-topic-menu" role="menu">
        <button role="menuitem" type="button" disabled={!!busy} onClick={()=>void mutate({type:'topic.flags',conversationId,topicId:topic.id,pinned:!topic.pinned},topic.id)}><BotIcon name="pin"/>{topic.pinned?(zh?'取消置顶':'Unpin'):(zh?'置顶话题':'Pin topic')}</button>
        <button role="menuitem" type="button" disabled={!!busy} onClick={()=>void mutate({type:'topic.flags',conversationId,topicId:topic.id,favorite:!topic.favorite},topic.id)}><BotIcon name="star"/>{topic.favorite?(zh?'取消收藏':'Remove favorite'):(zh?'收藏话题':'Favorite topic')}</button>
        <button role="menuitem" type="button" onClick={()=>{setMenu('');setRename({topic,draft:topic.title,requestId:crypto.randomUUID()});}}><BotIcon name="edit"/>{zh?'重命名':'Rename'}</button>
      </div>}
    </div>)}{!topics.length&&<p>{loading?(zh?'正在查找…':'Searching…'):zh?'没有匹配的话题':'No matching topics'}</p>}</div>
    <footer>{mode==='recent'&&!query?<><small>{zh?'显示最近 6 条，置顶优先':'Latest 6, pinned first'}</small><button type="button" onClick={()=>{setMode('all');setCursors([]);}}>{zh?'更多话题':'More topics'}</button></>:<><button type="button" disabled={!cursors.length||loading} onClick={()=>setCursors(current=>current.slice(0,-1))}>{zh?'上一页':'Previous'}</button><small>{zh?'按最近活动排序':'Latest activity first'}</small><button type="button" disabled={!next||loading} onClick={()=>next&&setCursors(current=>[...current,next])}>{zh?'下一页':'Next'}</button></>}</footer>
  </div>;
}
