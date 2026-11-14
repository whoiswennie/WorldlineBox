import { useEffect, useRef, useState } from 'react';
import type { DshLauncherState, WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import { useDismissibleDetails } from '../use-dismissible-details';
import { BotIcon } from './BotIcon';
import { sharedDshInstance } from './useBotDshBindings';

export function BotExecutorNotice({ api, zh, companionIds, onOpenLauncher }: { api?: WorldlineBoxDshLauncherApi; zh:boolean; companionIds?: readonly string[]; onOpenLauncher?():void }) {
  const [state,setState]=useState<DshLauncherState>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const detailsRef=useDismissibleDetails<HTMLDetailsElement>();
  const revision=useRef(0),generation=useRef(0);
  useEffect(()=>{
    if(!api)return;
    let live=true;const current=++generation.current;
    const unsubscribe=api.onChanged(value=>{if(live){revision.current++;setState(value);setError('');}});
    const requestedAt=revision.current;
    void Promise.resolve().then(()=>{
      if(!live)return;
      if(revision.current===requestedAt){setState(undefined);setBusy(false);setError('');}
      return api.request({type:'state'});
    }).then(result=>{
      if(!live||generation.current!==current||revision.current!==requestedAt)return;
      if(result?.ok&&result.state)setState(result.state);
      else setError(!result||result.ok?(zh?'执行器未返回状态。':'The executor returned no status.'):result.error);
    }).catch(()=>{if(live&&revision.current===requestedAt)setError(zh?'执行器状态暂时无法读取。':'Executor status is unavailable.');});
    return()=>{live=false;generation.current=current+1;unsubscribe();};
  },[api,zh,refresh]);
  if(!api||!companionIds?.length)return null;
  const readiness=state?.executionReadiness;
  const instance=sharedDshInstance(state);
  const failed=instance?.status==='failed'||readiness?.instanceId===instance?.id&&readiness?.status==='failed';
  const warming=readiness?.instanceId===instance?.id&&readiness?.status==='warming';
  const starting=busy||instance?.status==='starting',preparing=instance?.status==='running'&&warming,stopping=instance?.status==='stopping',unsupported=state?.supported===false;
  if(instance?.status==='running'&&!error&&!starting&&!preparing&&!failed&&!unsupported)return null;
  const pending=starting||preparing||stopping||!state&&!error;
  const text=error?(zh?'DSH 暂时不可用':'DSH is unavailable')
    :unsupported?(zh?'此系统暂不支持 DSH':'DSH is unavailable on this system')
    :!state?(zh?'正在连接 DSH…':'Checking DSH…')
    :starting?(zh?'DSH 正在启动…':'DSH is starting…')
    :preparing?(zh?'DSH 正在准备…':'DSH is preparing…')
    :stopping?(zh?'DSH 正在关闭…':'DSH is stopping…')
    :failed?(zh?'DSH 启动失败':'DSH could not start')
    :instance?(zh?'DSH 未启动':'DSH is stopped')
    :(zh?'尚未配置 DSH':'DSH is not configured');
  const diagnostic=error||(failed?instance?.lastError:undefined);
  const canStart=instance&&!unsupported&&!pending;
  const label=<><span className="bot-executor-status-icon" aria-hidden="true"><BotIcon name="assets" /></span>
    <span className="bot-executor-status-label">{text}</span></>;
  const start=async()=>{
    if(!instance||busy||starting||preparing||stopping||unsupported)return;
    const current=generation.current,requestedAt=revision.current;
    setBusy(true);setError('');
    try{
      const result=await api.request({type:'instance.start',instanceId:instance.id});
      if(current!==generation.current||requestedAt!==revision.current)return;
      if(!result.ok)setError(result.error);
      else if(result.state){setState(result.state);setError('');}
      else setRefresh(value=>value+1);
    }catch(failure){if(current===generation.current&&requestedAt===revision.current)setError(failure instanceof Error?failure.message:String(failure));}
    finally{if(current===generation.current)setBusy(false);}
  };
  return <aside className="bot-executor-notice" data-state={error||failed?'failed':pending?'pending':'idle'} aria-label={zh?'DSH 执行器状态':'DSH executor status'}>
    <span className="bot-sr-only" role={error||failed?'alert':'status'}>{text}</span>
    {canStart||diagnostic||onOpenLauncher?<details ref={detailsRef}>
      <summary className="bot-executor-trigger" title={text}>{label}<BotIcon name="chevron-down" /></summary>
      <div className="bot-executor-panel">
        <p className="bot-executor-panel-title">{text}</p>
        {diagnostic&&<p className="bot-executor-diagnostic">{diagnostic}</p>}
        {canStart&&!diagnostic&&!failed&&<p className="bot-executor-description">{zh?'伙伴共用此 DSH，聊天时会按需启动。':'Companions share this DSH, which starts on demand.'}</p>}
        {(canStart||error||onOpenLauncher)&&<div className="bot-executor-actions">
          {canStart&&<button className="bot-executor-primary" type="button" onClick={()=>void start()}>{zh?'启动':'Start'}</button>}
          {error&&<button type="button" disabled={busy} onClick={()=>setRefresh(value=>value+1)}>{zh?'重试':'Retry'}</button>}
          {onOpenLauncher&&<button type="button" onClick={()=>{detailsRef.current?.removeAttribute('open');onOpenLauncher();}}>{zh?'前往启动器':'Open launcher'}<BotIcon name="external" /></button>}
        </div>}
      </div>
    </details>:<span className="bot-executor-trigger">{label}</span>}
  </aside>;
}
