import {useEffect,useRef,useState} from 'react';
import type {BotRequest,BotResponse} from '../../shared/companion-bot';
import type {BotNativeTopic} from '../../shared/companion-bot-topics';
import {botContextIsNewer,botContextOccupancy,type BotNativeContext,type BotTopicContext} from '../../shared/companion-native-context';
import {BotIcon} from './BotIcon';
import './bot-context-meter.css';

const short=(value:number)=>value>=1_000_000?`${Number((value/1_000_000).toFixed(2))}M`:value>=1000?`${Number((value/1000).toFixed(1))}K`:String(value);
export function BotContextMeter({conversationId,topic,companionId,companionName,cached,locale,request,busy,canCompact,onCompact,onNew}:{conversationId:string;topic:BotNativeTopic;companionId:string;companionName:string;cached?:BotNativeContext;locale:'zh-CN'|'en';request(input:BotRequest):Promise<BotResponse>;busy:boolean;canCompact:boolean;onCompact():void;onNew():void}){
  const zh=locale==='zh-CN',[open,setOpen]=useState(false),[report,setReport]=useState<BotTopicContext>(),[refresh,setRefresh]=useState(0),[loading,setLoading]=useState(false),root=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    let stopped=false,timer:ReturnType<typeof setTimeout>;
    const read=async()=>{
      setLoading(true);
      try{const result=await request({type:'topic.context',conversationId,topicId:topic.id,companionId});if(!stopped){if(result.ok&&result.topicContext?.topicId===topic.id&&result.topicContext.companionId===companionId)setReport(result.topicContext);else if(!result.ok)setReport(previous=>({...previous,topicId:topic.id,companionId,stale:true,error:result.error}));}}
      catch{if(!stopped)setReport(previous=>({...previous,topicId:topic.id,companionId,stale:true,error:zh?'DSH 统计连接暂不可用。':'DSH statistics are unavailable.'}));}
      finally{if(!stopped){setLoading(false);timer=setTimeout(()=>void read(),open?1000:3000);}}
    };
    void read();return()=>{stopped=true;clearTimeout(timer);};
  },[conversationId,topic.id,companionId,request,open,refresh,zh]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(false);};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open]);
  const sample=cached&&(!report?.sample||botContextIsNewer(cached,report.sample))?cached:report?.sample;
  const stale=!!sample&&(!report||!!report.stale&&(!report.sample||sample===report.sample)),occupancy=botContextOccupancy(sample),breakdown=sample?.breakdown,usage=sample?.usage;
  const composition=breakdown?breakdown.systemTokens+breakdown.toolsTokens+breakdown.messageTokens:0;
  const rows=breakdown?[{key:'system',label:zh?'系统提示词':'System instructions',value:breakdown.systemTokens},{key:'tools',label:zh?'工具定义':'Tool definitions',value:breakdown.toolsTokens},{key:'messages',label:zh?'对话消息':'Conversation',value:breakdown.messageTokens}]:[];
  const exact=(value:number)=>value.toLocaleString(locale),reading=occupancy?`${occupancy.percent}%`:(zh?'待统计':'Pending');
  const activity=sample?.activity,compaction=activity?.compaction,nativeBusy=!!activity&&activity.phase!=='idle';
  const activityLabel=activity?.phase==='compacting'?(compaction?.origin==='automatic'?(zh?'正在自动压缩':'Auto compacting'):(zh?'正在压缩':'Compacting'))
    :activity?.phase==='maintenance'?(activity.command==='compact'?(zh?'正在准备压缩':'Preparing compaction'):(zh?'DSH 正在维护会话':'DSH session maintenance'))
    :activity?.phase==='running'?(zh?'DSH 正在执行':'DSH is running'):activity?.phase==='recovering'?(zh?'会话待恢复':'Session awaiting recovery'):undefined;
  return <div className={`bot-context-meter${occupancy&&occupancy.percent>=80?' is-high':''}`} data-native-context-session={sample?.sessionId} ref={root}>
    {activityLabel&&!stale&&<span className="bot-native-activity" role="status"><BotIcon name={activity?.phase==='running'?'clock':'sparkles'}/>{activityLabel}</span>}
    <button className="bot-context-trigger" type="button" aria-label={occupancy?(zh?`上下文已用 ${reading}`:`Context used ${reading}`):(zh?'上下文待统计':'Context pending')} aria-haspopup="dialog" aria-expanded={open} title={occupancy?`~${exact(occupancy.tokens)} / ${exact(occupancy.capacity)} tokens`:(zh?'查看 DSH 原生上下文统计':'View native DSH context')} onClick={()=>setOpen(value=>!value)}>
      <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><circle className="bot-context-ring-track" cx="9" cy="9" r="6.5"/><circle className="bot-context-ring-value" cx="9" cy="9" r="6.5" pathLength="100" strokeDasharray={`${occupancy?.percent??0} 100`} opacity={occupancy?.percent?1:0} transform="rotate(-90 9 9)"/></svg>
      <span>{zh?'上下文':'Context'}</span><strong>{reading}</strong>{stale&&<BotIcon name="clock"/>}
    </button>
    {open&&<section className="bot-context-panel" role="dialog" aria-label={zh?'DSH 上下文':'DSH context'}>
      <header><div><span className="bot-context-eyebrow">DSH · {zh?'原生会话统计':'Native session'}</span><h3>{zh?'上下文占用':'Context occupancy'}</h3></div><button type="button" aria-label={zh?'关闭上下文详情':'Close context details'} onClick={()=>setOpen(false)}>×</button></header>
      <div className="bot-context-topic"><strong>{companionName}</strong><span title={topic.title}>{topic.title}</span></div>
      {activityLabel&&!stale&&<p className="bot-context-maintenance" role="status">{activityLabel} · {activity?.phase==='recovering'?(zh?'发送消息后会接续原生会话。':'Send a message to resume this native session.'):(zh?'新消息会保留并排队，完成后继续。':'New messages are retained and queued until this finishes.')}</p>}
      {compaction&&compaction.state!=='running'&&<p className={`bot-context-compaction is-${compaction.state}`} role={compaction.state==='failed'?'status':undefined}>{compaction.state==='succeeded'?(zh?'最近压缩已完成':'Latest compaction completed'):compaction.state==='interrupted'?(zh?'上次压缩已中断；会话记录已保留。':'Previous compaction was interrupted; session history is retained.'):(zh?'上次压缩失败；会话记录已保留。':'Previous compaction failed; session history is retained.')}{compaction.error&&<span>{compaction.error}</span>}</p>}
      {occupancy?<><div className="bot-context-reading"><strong>{occupancy.percent}<small>%</small></strong><div title={`~${exact(occupancy.tokens)} / ${exact(occupancy.capacity)} tokens`}><span>~{short(occupancy.tokens)} <i>/ {short(occupancy.capacity)}</i></span><small>{zh?'当前占用 / 上下文容量':'Current usage / capacity'}</small></div></div>
        <div className="bot-context-bar" role="progressbar" aria-label={zh?'上下文占用':'Context occupancy'} aria-valuenow={occupancy.percent} aria-valuemin={0} aria-valuemax={100}>{composition?rows.filter(row=>row.value>0).map(row=><span className={`is-${row.key}`} key={row.key} style={{width:`${occupancy.percent*row.value/composition}%`}}/>):<span className="is-total" style={{width:`${occupancy.percent}%`}}/>}</div>
      </>:<p className="bot-context-empty">{loading?(zh?'正在读取 DSH 统计…':'Reading DSH statistics…'):sample?.state==='unsupported'?(zh?'此 DSH 版本尚未提供上下文统计。':'This DSH version does not expose context statistics.'):zh?'DSH 尚未返回本话题的上下文用量。首次请求完成后会自动显示。':'DSH has not reported context usage for this topic yet. It appears after the first request.'}</p>}
      {!!rows.length&&<><div className="bot-context-section-label">{zh?'上下文构成 · 估算':'Context composition · estimated'}</div><dl className="bot-context-composition">{rows.map(row=><div key={row.key}><dt><span className={`bot-context-dot is-${row.key}`}/>{row.label}</dt><dd title={exact(row.value)}>~{short(row.value)}</dd></div>)}</dl></>}
      {sample?.pressure?.pressureTokens!==undefined&&<dl className="bot-context-last"><div><dt>{zh?'最近请求输入':'Latest request input'}</dt><dd title={exact(sample.pressure.pressureTokens)}>{short(sample.pressure.pressureTokens)}</dd></div></dl>}
      {usage&&<details className="bot-context-usage"><summary>{zh?'会话累计用量':'Cumulative session usage'}<BotIcon name="chevron-down"/></summary><dl>{[{label:zh?'未缓存输入':'Uncached input',value:usage.uncachedInputTokens},{label:zh?'缓存读取':'Cache read',value:usage.cacheReadTokens},{label:zh?'缓存写入':'Cache write',value:usage.cacheWriteTokens},{label:zh?'输出':'Output',value:usage.outputTokens}].map(row=><div key={row.label}><dt>{row.label}</dt><dd title={exact(row.value)}>{short(row.value)}</dd></div>)}</dl><small>{zh?'累计用量不等于当前上下文占用。':'Cumulative usage is separate from current context occupancy.'}</small></details>}
      <p className="bot-context-note">{zh?'与 DSH 相同统计口径。占用基于原生请求用量及会话变化；构成项为近似估算，不作为占用总和。':'Uses the same native projections as DSH. Composition is an estimate and does not sum to occupancy.'}</p>
      {(stale||report?.error||sample?.state==='migration-required')&&<p className="bot-context-unavailable" role="status">{sample?.state==='migration-required'?(zh?'此原生会话需要在 DSH 中完成迁移。':'This session needs migration in DSH.'):stale?(zh?'DSH 暂未连接，显示上次保存的统计。':'DSH is unavailable; showing the last saved statistics.'):zh?'暂时无法获取 DSH 统计，可稍后刷新。':'DSH statistics are unavailable. Try refreshing later.'}</p>}
      <div className="bot-context-updated"><span>{sample?.sampledAt?<>{zh?'更新于 ':'Updated '}<time dateTime={sample.sampledAt}>{new Date(sample.sampledAt).toLocaleTimeString(locale,{hour12:false})}</time></>:zh?'等待原生统计':'Waiting for native statistics'}</span><button type="button" disabled={loading} onClick={()=>setRefresh(value=>value+1)}>{zh?'刷新':'Refresh'}</button></div>
      <footer><button type="button" disabled={busy||nativeBusy||!canCompact} onClick={()=>{setOpen(false);onCompact();}}><BotIcon name="sparkles"/>{zh?'压缩当前会话':'Compact session'}</button><button type="button" disabled={busy} onClick={()=>{setOpen(false);onNew();}}><BotIcon name="plus"/>{zh?'开启新话题':'New topic'}</button></footer>
    </section>}
  </div>;
}
