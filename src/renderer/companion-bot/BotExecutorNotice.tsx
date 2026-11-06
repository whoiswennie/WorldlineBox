import { useEffect, useId, useRef, useState } from 'react';
import type { DshLauncherState, WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import { BotIcon } from './BotIcon';

export function BotExecutorNotice({ api, zh, onOpenLauncher }: { api?: WorldlineBoxDshLauncherApi; zh:boolean; onOpenLauncher?():void }) {
  const [state,setState]=useState<DshLauncherState>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const [detailsOpen,setDetailsOpen]=useState(false),detailsId=useId();
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
  if(!api)return null;
  const instance=state?.instances.find(value=>value.isDefault),readiness=state?.executionReadiness;
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
  const hint=zh?'聊天可照常进行，执行电脑任务时会连接默认 DSH 实例。':'Chat is available. Delegated computer tasks use the default DSH instance.';
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
    <div className="bot-executor-status-row">
      <span className="bot-executor-status-icon" aria-hidden="true"><BotIcon name={pending?'history':'tasks'} /></span>
      <span className="bot-executor-status-label" role={error||failed?'alert':'status'} title={hint}>{text}</span>
      {instance&&!unsupported&&!pending&&<button className="bot-executor-primary" type="button" onClick={()=>void start()}>{zh?'启动':'Start'}</button>}
      {error&&<button type="button" disabled={busy} onClick={()=>setRefresh(value=>value+1)}>{zh?'重试':'Retry'}</button>}
      {diagnostic&&<button type="button" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={()=>setDetailsOpen(value=>!value)}>{zh?'详情':'Details'}</button>}
      {onOpenLauncher&&<button className="bot-executor-launcher" type="button" onClick={onOpenLauncher} title={zh?'前往启动器':'Open launcher'} aria-label={zh?'前往启动器':'Open launcher'}><BotIcon name="external" /></button>}
    </div>
    {diagnostic&&detailsOpen&&<p id={detailsId} className="bot-executor-diagnostic">{diagnostic}</p>}
  </aside>;
}
