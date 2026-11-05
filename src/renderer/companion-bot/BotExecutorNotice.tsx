import { useEffect, useRef, useState } from 'react';
import type { DshLauncherState, WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';

export function BotExecutorNotice({ api, zh, onOpenLauncher }: { api?: WorldlineBoxDshLauncherApi; zh:boolean; onOpenLauncher?():void }) {
  const [state,setState]=useState<DshLauncherState>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
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
  const text=error?(instance?(zh?'默认 DSH 实例启动失败。':'The default DSH instance failed to start.'):(zh?'无法确认默认 DSH 实例状态。':'The default DSH instance status could not be confirmed.'))
    :unsupported?(zh?'当前系统不支持本地 DSH 执行器。':'Local DSH execution is unavailable on this system.')
    :!state?(zh?'正在读取默认 DSH 实例状态…':'Checking the default DSH instance…')
    :starting?(zh?'正在启动默认 DSH 实例…':'Starting the default DSH instance…')
    :preparing?(zh?'默认 DSH 实例已启动，正在准备执行环境…':'The default DSH instance is running; preparing its execution environment…')
    :stopping?(zh?'正在停止默认 DSH 实例…':'Stopping the default DSH instance…')
    :failed?(zh?'默认 DSH 实例启动或执行环境准备失败。':'The default DSH instance or its execution environment failed to start.')
    :instance?(zh?'默认 DSH 实例尚未启动。':'The default DSH instance is stopped.')
    :(zh?'尚未配置默认 DSH 实例。':'No default DSH instance is configured.');
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
  return <div className="bot-executor-notice" role={error||failed?'alert':'status'}><span><strong>{text}</strong><small>{error||(failed?instance?.lastError:undefined)||(zh?'伙伴仍可聊天；执行任务时需要 DSH 实例。':'Chat remains available; delegated tasks require DSH.')}</small></span>{error&&<button type="button" disabled={busy} onClick={()=>setRefresh(value=>value+1)}>{zh?'重试读取':'Retry status'}</button>}{instance&&!unsupported&&<button type="button" disabled={starting||preparing||stopping} onClick={()=>void start()}>{starting?zh?'启动中…':'Starting…':preparing?zh?'准备中…':'Preparing…':stopping?zh?'停止中…':'Stopping…':zh?'启动实例':'Start instance'}</button>}{onOpenLauncher&&<button type="button" onClick={onOpenLauncher}>{zh?'前往启动器':'Open launcher'}</button>}</div>;
}
