import { useEffect, useRef, useState } from 'react';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionWorkspaceLibrary, CompanionWorkspaceRequest } from '../../shared/companion-workspace';
import { companionRecoveryCommandSchema, companionRecoveryResultSchema, type CompanionRecoveryResult } from '../../shared/companion-recovery';
import { DialogShell } from '../ui/patterns';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { Icon } from '../Icons';
import './companion-recovery.css';

type Write=Extract<CompanionWorkspaceRequest,{type:'recovery.backup.create'|'recovery.restore'}>;
const storageKey=(libraryId:string)=>'companion-recovery-operation-v1/'+libraryId;
function saved(libraryId:string):Write|undefined{
  try{const value=localStorage.getItem(storageKey(libraryId));if(!value)return;const parsed=companionRecoveryCommandSchema.parse(JSON.parse(value));if(parsed.type!=='recovery.package.inspect'&&parsed.libraryId===libraryId)return parsed;}catch{/* An unknown local draft grants no operation authority. */}
}
function size(bytes:number):string {return bytes<1024*1024?`${(bytes/1024).toFixed(1)} KiB`:`${(bytes/1024/1024).toFixed(1)} MiB`;}
export function CompanionRecoveryPanel({api,library,onClose,onBusy}:{api:WorldlineBoxCompanionsApi;library:CompanionWorkspaceLibrary;onClose():void;onBusy?(busy:boolean):void}){
  const [destination,setDestination]=useState(''),[preview,setPreview]=useState<CompanionRecoveryResult>(),[confirmation,setConfirmation]=useState<Write>(),[frozen,setFrozen]=useState<Write|undefined>(()=>saved(library.libraryId));
  const [result,setResult]=useState<CompanionRecoveryResult>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[stage,setStage]=useState('');
  const lock=useRef(false),alive=useRef(true);useDialogFocusTrap(true,'伙伴备份与恢复:'+busy);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const progress=(value:boolean,text='')=>{lock.current=value;setBusy(value);setStage(text);onBusy?.(value);};
  async function choose(kind:'backup_destination'|'package'){
    if(lock.current||frozen||!api.workspace)return;progress(true,kind==='package'?'只读检查备份包':'选择备份位置');setError('');
    try{
      const chosen=await api.workspace({type:'recovery.choose',kind});if(!alive.current)return;if(chosen.cancelled)return;if(!chosen.ok||!chosen.recoveryPath)throw new Error(chosen.error??'没有收到有效目录。');
      if(kind==='backup_destination'){setDestination(chosen.recoveryPath);return;}
      const response=await api.workspace({type:'recovery.package.inspect',packagePath:chosen.recoveryPath});if(!alive.current)return;
      if(!response.ok)throw new Error(response.error??'备份未通过只读检查。');const parsed=companionRecoveryResultSchema.safeParse(response.recovery);if(!parsed.success)throw new Error('备份检查结果不完整，未准备恢复。');const inspected=parsed.data;
      if(inspected.libraryId!==library.libraryId||inspected.packagePath!==chosen.recoveryPath||inspected.mode!=='backup')throw new Error('检查结果不属于当前资产库或刚选择的备份包。');
      setPreview(inspected);setResult(undefined);
    }catch(cause){if(alive.current){setPreview(undefined);setError(cause instanceof Error?cause.message:'无法检查备份。');}}
    finally{if(alive.current)progress(false);}
  }
  async function execute(command:Write){
    if(lock.current||!api.workspace)return;progress(true,command.type==='recovery.backup.create'?'已请求暂停伙伴执行，正在备份':'已请求暂停伙伴执行，正在核验并恢复');setError('');setResult(undefined);
    try{
      // Persist identity before dispatch. Closing/reopening this panel must not
      // turn a lost response into a new restore operation or an automatic retry.
      localStorage.setItem(storageKey(library.libraryId),JSON.stringify(command));setFrozen(command);setConfirmation(undefined);
      const response=await api.workspace(command);if(!alive.current)return;if(!response.ok)throw new Error(response.error??'操作尚未获确认。');const parsed=companionRecoveryResultSchema.safeParse(response.recovery);if(!parsed.success)throw new Error('未收到格式完整的宿主完成凭据，保留原操作等待核对。');const receipt=parsed.data;
      if(receipt.operationId!==command.operationId||receipt.libraryId!==command.libraryId||receipt.mode!==(command.type==='recovery.backup.create'?'backup':command.mode)
        ||command.type==='recovery.restore'&&(receipt.manifestHash!==command.expectedManifestHash||receipt.packagePath!==command.packagePath))throw new Error('返回凭据与原操作不一致，仍保留同一操作等待核对。');
      localStorage.removeItem(storageKey(library.libraryId));setFrozen(undefined);setPreview(undefined);setResult(receipt);
    }catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:'操作结果尚未确认，请保留原操作标识。');}
    finally{if(alive.current)progress(false);}
  }
  const prepare=(mode:'database'|'current_files')=>{if(!preview||lock.current||frozen)return;setConfirmation({type:'recovery.restore',libraryId:library.libraryId,operationId:crypto.randomUUID(),mode,packagePath:preview.packagePath,expectedManifestHash:preview.manifestHash});};
  return <div className="dialog-backdrop companion-recovery-backdrop" role="presentation"><DialogShell className="create-dialog companion-recovery-panel" dialogId="companion-recovery-dialog" tabIndex={-1} aria-busy={busy}
    title="伙伴备份与恢复" description="保存当前人格、原始经历与正式版本；恢复仍遵守当前宿主的撤回记录。" onRequestClose={()=>{if(!busy)onClose();}}
    headerActions={<button type="button" className="dialog-close" disabled={busy} aria-label="关闭备份与恢复" onClick={onClose}><Icon name="close" size={16}/></button>}>
    <div className="companion-recovery-content"><div className="companion-recovery-library"><Icon name="folder" size={20}/><div><strong>{library.displayName}</strong><small>{library.libraryPath}</small></div><span>当前资产库</span></div>
      <p className="companion-recovery-policy">执行备份或恢复时，伙伴聊天、生活与后台学习会先暂停并停止正在执行的请求。完成后可重新打开伙伴；从备份恢复的旧任务先搁置，结果不明的请求不会自动重发。</p>
      {busy&&<p role="status" className="companion-recovery-progress"><Icon name="activity" size={16}/>{stage}。请保留窗口，完成前不能更换资产库。</p>}
      {error&&<p role="alert" className="companion-recovery-error">{error}</p>}
      {frozen&&<section className="companion-recovery-pending" aria-label="待核对的原操作"><h3>保留原操作等待核对</h3><p>尚未收到一致的完成凭据。再次提交会使用原操作标识与原负载，不会自动另建恢复作业。</p><code>{frozen.operationId}</code><button type="button" disabled={busy} onClick={()=>void execute(frozen)}>重试同一次备份或恢复</button></section>}
      {result&&<section className="companion-recovery-success" role="status"><h3>{result.mode==='backup'?'备份已获宿主凭据':result.mode==='database'?result.historicalReplay?'原账本恢复操作已核对':'账本已恢复，伙伴保持休眠':'当前缺失正文已核验'}</h3><p>{result.mode==='backup'?`已登记 ${result.files} 个文件，正文逻辑大小 ${size(result.bytes)}。`:result.mode==='database'?result.historicalReplay?'这是先前操作的完成凭据，没有重新覆盖当前账本。当前伙伴与作业是否已恢复执行，仍以其当前状态为准。':'已保留当前人格与来源版本。旧任务需要核对后明确恢复，未表示原发送已成功。':`补回 ${result.restoredFiles??0} 个仍获权的准确文件；当前账本保持原版本。`}</p>{result.mode==='backup'&&result.databaseRestoreAvailable===false&&<p>这是原备份操作的历史完成凭据。宿主已有后续写入，不能用本包回滚当前账本。</p>}<small>{result.packagePath}</small>{!!result.externalAttachments&&<p>其中 {result.externalAttachments} 个外部文件引用保留原授权引用，包内不包含其外部字节。</p>}</section>}
      <div className="companion-recovery-grid"><section><span className="companion-recovery-kicker">保存</span><h3>创建完整备份</h3><p>包含新协议账本、正式人格与记忆正文、来源和已管理的附件。密钥、未知文件与资产库外的文件内容不会自动收集。</p><button type="button" disabled={busy||!!frozen} onClick={()=>void choose('backup_destination')}>选择备份位置</button>{destination&&<small className="companion-recovery-path">{destination}</small>}<button type="button" className="primary-button" disabled={busy||!!frozen||!destination} onClick={()=>setConfirmation({type:'recovery.backup.create',libraryId:library.libraryId,operationId:crypto.randomUUID(),destinationParent:destination})}>创建完整备份</button></section>
        <section><span className="companion-recovery-kicker">核验</span><h3>从已有备份恢复</h3><p>先只读核验备份及宿主凭据。旧包不能覆盖后来的消息、人格变化、撤回或退役。</p><button type="button" disabled={busy||!!frozen} onClick={()=>void choose('package')}>选择并检查备份包</button>{preview&&<div className="companion-recovery-preview" aria-label="备份检查结果"><strong>{preview.databaseRestoreAvailable?'宿主凭据仍为当前版本':'可核对正文，不能回滚账本'}</strong><small>{preview.packagePath}</small><p>{preview.files} 个正式文件 · {size(preview.bytes)}</p>{preview.unavailableReason&&<p>{preview.unavailableReason}</p>}<button type="button" disabled={busy||!!frozen} onClick={()=>prepare('current_files')}>仅补回当前缺失正文</button><button type="button" disabled={busy||!!frozen||!preview.databaseRestoreAvailable} onClick={()=>prepare('database')}>恢复丢失的账本</button><details><summary>查看核验凭据</summary><dl><dt>包指纹</dt><dd>{preview.manifestHash}</dd><dt>宿主谱系</dt><dd>{preview.lineageId}</dd><dt>备份水位</dt><dd>{preview.generation}</dd></dl></details></div>}</section></div>
      {confirmation&&!frozen&&<section className="companion-recovery-confirm" aria-label="确认备份或恢复"><h3>{confirmation.type==='recovery.backup.create'?'暂停执行并创建备份':confirmation.mode==='database'?'恢复丢失的账本并搁置旧任务':'只修复当前仍获权的缺失文件'}</h3><p>{confirmation.type==='recovery.backup.create'?'将暂停当前资产库内的伙伴执行，生成带有宿主凭据的独立备份。':confirmation.mode==='database'?'只有原账本已经丢失、包仍有当前宿主凭据时才可执行。现存未知文件不会被覆盖。恢复后伙伴保持休眠，旧任务先搁置。':'需要当前账本仍可用。只补回当前正式登记的准确缺失字节，外改文件不会被覆盖。'}</p><div><button type="button" disabled={busy} onClick={()=>setConfirmation(undefined)}>暂不执行</button><button type="button" className="primary-button" disabled={busy} onClick={()=>void execute(confirmation)}>确认暂停并执行</button></div></section>}
    </div></DialogShell></div>;
}
