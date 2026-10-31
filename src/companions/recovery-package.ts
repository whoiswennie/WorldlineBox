import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { companionArtifactSchema, type CompanionArtifact } from '../shared/companion-artifact';
import { companionRecoveryCatalogEntrySchema, companionRecoveryFileSchema, companionRecoveryManifestSchema, type CompanionRecoveryCatalogEntry, type CompanionRecoveryFile, type CompanionRecoveryManifest, type CompanionRecoveryResult } from '../shared/companion-recovery';
import type { CompanionConnection } from './store';
import { COMPANION_COGNITION_PROTOCOL } from './cognition-protocol';
import { CompanionRecoveryFence, type CompanionRecoverySelection, type CompanionRecoveryTicket } from './recovery-fence';
import { holdRestoredCompanionWork } from './recovery-hold';

type Native = CompanionConnection & { backup(file: string): Promise<unknown> };
const Database = BetterSqlite3 as { new(file: string, options?: { readonly?: boolean; fileMustExist?: boolean }): CompanionConnection };
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), operation = z.uuid(), digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (root: string, file: string) => { const relative=path.relative(root,file); return !!relative&&!relative.startsWith('..')&&!path.isAbsolute(relative); };
function directory(target: string, create=false): void {
  if (!path.isAbsolute(target)) throw new Error('备份恢复路径必须是绝对路径。');
  if (!existsSync(target)) { if(!create) throw new Error('备份恢复目录不存在。'); directory(path.dirname(target),true); mkdirSync(target); }
  const stat=lstatSync(target); if(!stat.isDirectory()||stat.isSymbolicLink()||!same(realpathSync(target),target)) throw new Error('备份恢复目录包含链接或已改变指向。');
}
function managed(root:string,relative:string,create=false):string {
  const parts=relative.split('/'); let parent=root; directory(root,create);
  for(const part of parts.slice(0,-1)){ parent=path.join(parent,part);directory(parent,create); }
  const file=path.join(root,...parts); if(!inside(root,file))throw new Error('备份路径越过目标范围。'); return file;
}
function stamp(stat:NonNullable<ReturnType<typeof lstatSync>>) { return [stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':'); }
/** Fixed-size I/O; no full SQLite/image/body allocation or recursive scan. */
export function recoveryFileHash(file:string, expectedLinks=1):{hash:string;size:number} {
  const before=lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==expectedLinks||!same(realpathSync(file),file))throw new Error('备份文件不是独立受管普通文件。');
  const handle=openSync(file,constants.O_RDONLY),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let size=0;
  try { if(stamp(fstatSync(handle))!==stamp(before))throw new Error('备份文件在打开前变化。');
    for(;;){const count=readSync(handle,buffer,0,buffer.length,null);if(!count)break;hash.update(buffer.subarray(0,count));size+=count;}
    if(stamp(fstatSync(handle))!==stamp(before)||stamp(lstatSync(file))!==stamp(before))throw new Error('备份文件在读取中变化。');
    return {hash:hash.digest('hex'),size};
  }finally{closeSync(handle);}
}
function copyExact(source:string,target:string,expected?:{hash:string;size:number}):{hash:string;size:number} {
  const verified=recoveryFileHash(source);if(expected&&(verified.hash!==expected.hash||verified.size!==expected.size))throw new Error('备份对象校验失败。');
  const targetFd=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);let sourceFd:number;
  try{sourceFd=openSync(source,constants.O_RDONLY);}catch(error){closeSync(targetFd);throw error;}
  const buffer=Buffer.allocUnsafe(64*1024);const before=stamp(fstatSync(sourceFd));
  try{for(;;){const count=readSync(sourceFd,buffer,0,buffer.length,null);if(!count)break;writeAll(targetFd,buffer.subarray(0,count));}
    fsyncSync(targetFd);if(before!==stamp(fstatSync(sourceFd)))throw new Error('备份对象复制中发生变化。');
  }finally{closeSync(sourceFd);closeSync(targetFd);}
  const copied=recoveryFileHash(target);if(copied.hash!==verified.hash||copied.size!==verified.size)throw new Error('备份复制后的精确字节不一致。');return copied;
}
/** Atomic no-overwrite publication. A crash between link and unlink is
 * recoverable only for the exact pair created by this durable operation. */
function installExact(source:string,target:string,expected:{hash:string;size:number},stageRoot:string):boolean{
  directory(stageRoot,true);const staged=path.join(stageRoot,digest(target)+'.body');
  if(existsSync(target)){
    const stat=lstatSync(target);
    if(stat.nlink===2&&existsSync(staged)){
      const other=lstatSync(staged);if(other.dev!==stat.dev||other.ino!==stat.ino||other.nlink!==2||other.isSymbolicLink())throw new Error('恢复目标有未知硬链接。');
      const value=recoveryFileHash(target,2);if(value.hash!==expected.hash||value.size!==expected.size)throw new Error('恢复目标有未知不同字节（未知外改），不会覆盖。');unlinkSync(staged);
    }
    const value=recoveryFileHash(target);if(value.hash!==expected.hash||value.size!==expected.size)throw new Error('恢复目标有未知不同字节（未知外改），不会覆盖。');return false;
  }
  if(!existsSync(staged))copyExact(source,staged,expected);
  const value=recoveryFileHash(staged);if(value.hash!==expected.hash||value.size!==expected.size)throw new Error('恢复发布暂存字节被改变，不会覆盖。');
  try{linkSync(staged,target);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return installExact(source,target,expected,stageRoot);throw error;}
  unlinkSync(staged);return true;
}
function writeAll(fd:number,bytes:Buffer):void{let offset=0;while(offset<bytes.length){const count=writeSync(fd,bytes,offset,bytes.length-offset);if(count<=0)throw new Error('备份文件写入未取得进展。');offset+=count;}}
function writeNew(file:string,body:string):void {const fd=openSync(file,'wx',0o600);try{writeAll(fd,Buffer.from(body));fsyncSync(fd);}finally{closeSync(fd);}}
function append(fd:number,value:unknown):void {writeAll(fd,Buffer.from(JSON.stringify(value)+'\n'));}
function* lines(file:string):Generator<unknown>{
  const fd=openSync(file,'r'),chunk=Buffer.allocUnsafe(64*1024);let rest=Buffer.alloc(0);
  try{for(;;){const n=readSync(fd,chunk,0,chunk.length,null);if(!n)break;const bytes=Buffer.concat([rest,chunk.subarray(0,n)]);let start=0;
      for(let cursor=0;cursor<bytes.length;cursor++)if(bytes[cursor]===10){if(cursor-start>1024*1024)throw new Error('备份索引单项超过结构上限。');yield JSON.parse(bytes.subarray(start,cursor).toString('utf8')) as unknown;start=cursor+1;}
      rest=Buffer.from(bytes.subarray(start));if(rest.length>1024*1024)throw new Error('备份索引单项超过结构上限。');}
    if(rest.length)throw new Error('备份索引结尾不完整。');
  }finally{closeSync(fd);}
}
function* query(db:CompanionConnection,sql:string):Generator<Record<string,unknown>>{
  const statement=db.prepare(sql) as unknown as {iterate():Iterable<Record<string,unknown>>};yield* statement.iterate();
}
function paths(selection:CompanionRecoverySelection){return{ledger:path.join(selection.libraryPath,'.worldlinebox','companions','messages.sqlite'),data:path.join(selection.libraryPath,'.worldlinebox','companions'),owners:path.join(selection.libraryPath,'伙伴记忆')};}
function assertSettled(db:CompanionConnection):void{
  // Queued, failed and deliberately held outbox rows are durable work, not
  // incomplete published files. Preserve their exact SQL inputs in the package;
  // restore holds them and advances their control revision. A live file lease
  // or unfinished Registry publication remains an inconsistent backup boundary.
  for(const [table,condition] of [['companion_artifact_publications',"state IN('prepared','validated','file_published')"],['companion_memory_source_outbox',"status='running' OR lease_token IS NOT NULL OR COALESCE(lease_until,0)>0"],['companion_memory_history_outbox',"status='running' OR lease_token IS NOT NULL OR COALESCE(lease_until,0)>0"],['companion_topic_compaction_jobs',"status='running' OR lease_token IS NOT NULL OR COALESCE(lease_until,0)>0"]])
    if(db.prepare(`SELECT 1 FROM ${table} WHERE ${condition} LIMIT 1`).get())throw new Error('有尚未结清的正式发布或执行租约，请停止执行并核对后再备份。');
  if(db.prepare("SELECT 1 FROM companion_reset_jobs WHERE status!='completed' LIMIT 1").get())throw new Error('退役清理尚未完成，不能备份中间身份。');
}
function catalog(db:CompanionConnection,fd:number):{owners:number;entries:number;external:number}{
  let owners=0,entries=0,external=0;
  for(const row of query(db,"SELECT metadata FROM companion_artifacts WHERE state='committed' ORDER BY owner_id,artifact_id")) {append(fd,companionRecoveryCatalogEntrySchema.parse({type:'artifact',artifact:companionArtifactSchema.parse(JSON.parse(String(row.metadata)))}));++entries;}
  for(const row of query(db,'SELECT id,data FROM companions WHERE deleted_at IS NULL ORDER BY id')){const owner=JSON.parse(String(row.data)) as {avatar:string;avatarAttachmentId?:string;appearanceAttachmentId?:string};append(fd,companionRecoveryCatalogEntrySchema.parse({type:'owner',id:row.id,avatar:owner.avatar,avatarAttachmentId:owner.avatarAttachmentId,appearanceAttachmentId:owner.appearanceAttachmentId}));++owners;++entries;}
  for(const row of query(db,'SELECT id,data,relative_path FROM attachments ORDER BY id')){const body=JSON.parse(String(row.data)) as {path?:string};append(fd,companionRecoveryCatalogEntrySchema.parse(body.path?{type:'external_attachment',id:row.id}:{type:'attachment',id:row.id,relativePath:row.relative_path}));++entries;if(body.path)++external;}
  return{owners,entries,external};
}
function fileTarget(selection:CompanionRecoverySelection,item:CompanionRecoveryFile,create=false):string{
  if(item.area==='attachment'){if(item.ownerId||!/^attachments\/[a-zA-Z0-9_-]{1,100}(?:\.[a-zA-Z0-9]{1,16})?$/u.test(item.relativePath))throw new Error('附件备份路径无效。');return managed(paths(selection).data,item.relativePath,create);}
  return managed(path.join(paths(selection).owners,id.parse(item.ownerId)),item.relativePath,create);
}
function ownerPortraits(selection:CompanionRecoverySelection,entry:Extract<CompanionRecoveryCatalogEntry,{type:'owner'}>):CompanionRecoveryFile[]{
  const result:CompanionRecoveryFile[]=[];
  for(const role of ['avatar','orthographic'] as const){const relative=`形象/.${role}-initialized.json`,root=path.join(paths(selection).owners,entry.id),receipt=path.join(root,...relative.split('/'));
    if(!existsSync(receipt))continue;const info=recoveryFileHash(managed(root,relative));if(info.size>4096)throw new Error('形象回执超过结构上限。');
    const proof=JSON.parse(readFileSync(receipt,'utf8')) as {companionId?:string;role?:string;attachmentId?:string;path?:string};
    const selected=role==='avatar'?entry.avatarAttachmentId:entry.appearanceAttachmentId,name=proof.path??role+'.png';
    if(proof.companionId!==entry.id||proof.role!==role||(proof.attachmentId??null)!==(selected??null)||!new RegExp('^'+role+'\\.(?:png|jpg|webp|gif)$','u').test(name))throw new Error('形象回执与当前运行选择不一致。');
    result.push({area:'owner',ownerId:entry.id,relativePath:relative,...info});
    const image=path.join(root,'形象',name);if(existsSync(image))result.push({area:'owner',ownerId:entry.id,relativePath:'形象/'+name,...recoveryFileHash(managed(root,'形象/'+name))});
  }return result;
}
export async function createCompanionBackup(db:CompanionConnection,fence:CompanionRecoveryFence,selection:CompanionRecoverySelection,input:{operationId:string;destinationParent:string}):Promise<CompanionRecoveryResult>{
  operation.parse(input.operationId);directory(input.destinationParent);if(same(input.destinationParent,selection.libraryPath)||inside(selection.libraryPath,input.destinationParent))throw new Error('备份包必须保存到当前资产库之外。');
  const payloadHash=digest(JSON.stringify([selection.libraryId,path.resolve(input.destinationParent).toLowerCase()]));
  assertSettled(db);const head=fence.reconcile(db),root=path.join(input.destinationParent,input.operationId+'.wlcompanion-backup');
  if(existsSync(root)){const previous=inspectCompanionBackup(root),checked=fence.inspectTicket(previous.manifest.snapshot.id);if(previous.manifestHash!==checked.ticket.manifestHash||previous.manifest.snapshot.id!==input.operationId||previous.manifest.operationPayloadHash!==payloadHash)throw new Error('已有备份不属于这个操作或原保存位置。');return{...result(previous,'backup',input.operationId),historicalReplay:true,databaseRestoreAvailable:checked.current};}
  mkdirSync(root);mkdirSync(path.join(root,'objects'));const ledger=path.join(root,'ledger.sqlite');
  // Native SQLite online backup streams pages and is consistent under WAL;
  // a later generation prevents publication of a raced snapshot.
  await (db as Native).backup(ledger);
  const ledgerInfo=recoveryFileHash(ledger),catalogPath=path.join(root,'catalog.ndjson'),catalogFd=openSync(catalogPath,'wx',0o600);let counts;
  try{counts=catalog(db,catalogFd);fsyncSync(catalogFd);}finally{closeSync(catalogFd);}
  const catalogInfo=recoveryFileHash(catalogPath),index=path.join(root,'files.ndjson'),indexFd=openSync(index,'wx',0o600);let count=0,total=0;
  const add=(item:CompanionRecoveryFile)=>{const parsed=companionRecoveryFileSchema.parse(item),source=fileTarget(selection,parsed),target=path.join(root,'objects',parsed.hash);
    if(!existsSync(target))copyExact(source,target,parsed);else{const actual=recoveryFileHash(target);if(actual.hash!==parsed.hash||actual.size!==parsed.size)throw new Error('内容寻址备份对象冲突。');}append(indexFd,parsed);++count;total+=parsed.size;};
  try{for(const raw of lines(catalogPath)){const entry=companionRecoveryCatalogEntrySchema.parse(raw);
      if(entry.type==='artifact'){const artifact=entry.artifact,info=recoveryFileHash(managed(path.join(paths(selection).owners,artifact.ownerId),artifact.relativePath));if(info.hash!==artifact.contentHash)throw new Error('受管正文与正式登记不一致，不能备份外改字节。');add({area:'owner',ownerId:artifact.ownerId,relativePath:artifact.relativePath,...info,artifactId:artifact.artifactId,artifactRevision:artifact.contentRevision});}
      else if(entry.type==='attachment')add({area:'attachment',relativePath:entry.relativePath,...recoveryFileHash(managed(paths(selection).data,entry.relativePath))});
      else if(entry.type==='owner')for(const item of ownerPortraits(selection,entry))add(item);
    }fsyncSync(indexFd);
  }finally{closeSync(indexFd);}
  const fileInfo=recoveryFileHash(index),manifest=companionRecoveryManifestSchema.parse({schema:'worldlinebox.companion-backup-v1',operationPayloadHash:payloadHash,snapshot:{id:input.operationId,libraryId:selection.libraryId,...head,ledgerHash:ledgerInfo.hash,ledgerSize:ledgerInfo.size,catalogHash:catalogInfo.hash,catalogSize:catalogInfo.size,owners:counts.owners,entries:counts.entries},createdAt:new Date().toISOString(),filesHash:fileInfo.hash,filesSize:fileInfo.size,files:count,contentBytes:total,externalAttachments:counts.external});
  const body=JSON.stringify(manifest)+'\n',manifestHash=digest(body);writeNew(path.join(root,'manifest.json'),body);
  const now=fence.reconcile(db);if(now.lineageId!==head.lineageId||now.generation!==head.generation)throw new Error('备份期间有新写入，本包未获宿主恢复凭据。');
  fence.recordTicket({id:input.operationId,...head,ledgerHash:ledgerInfo.hash,manifestHash});return{...result({packagePath:root,manifest,manifestHash},'backup',input.operationId),databaseRestoreAvailable:true};
}
interface Package {packagePath:string;manifest:CompanionRecoveryManifest;manifestHash:string}
function result(pack:Package,mode:CompanionRecoveryResult['mode'],operationId:string):CompanionRecoveryResult{return{operationId,packagePath:pack.packagePath,manifestHash:pack.manifestHash,libraryId:pack.manifest.snapshot.libraryId,lineageId:pack.manifest.snapshot.lineageId,generation:pack.manifest.snapshot.generation,files:pack.manifest.files,bytes:pack.manifest.contentBytes,mode,externalAttachments:pack.manifest.externalAttachments};}
export function inspectCompanionBackup(packagePath:string):Package {
  directory(packagePath);const manifestFile=managed(packagePath,'manifest.json');if(!existsSync(manifestFile))throw new Error('不是完整的新协议伙伴备份；旧格式目录不会导入、转换或重新创建伙伴。');
  const info=recoveryFileHash(manifestFile);if(info.size>64*1024)throw new Error('备份描述超过结构上限。');
  const body=readFileSync(manifestFile,'utf8');let manifest:CompanionRecoveryManifest;
  try{manifest=companionRecoveryManifestSchema.parse(JSON.parse(body));}catch{throw new Error('备份协议或描述不受支持；未导入、转换或创建任何伙伴。');}const manifestHash=digest(body);
  for(const [name,hash,size] of [['ledger.sqlite',manifest.snapshot.ledgerHash,manifest.snapshot.ledgerSize],['catalog.ndjson',manifest.snapshot.catalogHash,manifest.snapshot.catalogSize],['files.ndjson',manifest.filesHash,manifest.filesSize]] as const){const actual=recoveryFileHash(managed(packagePath,name));if(actual.hash!==hash||actual.size!==size)throw new Error('备份结构文件校验失败。');}
  let count=0,bytes=0;for(const raw of lines(managed(packagePath,'files.ndjson'))){const item=companionRecoveryFileSchema.parse(raw),actual=recoveryFileHash(managed(packagePath,'objects/'+item.hash));if(actual.hash!==item.hash||actual.size!==item.size)throw new Error('备份正文对象损坏。');++count;bytes+=item.size;}
  if(count!==manifest.files||bytes!==manifest.contentBytes)throw new Error('备份索引数量或字节数不一致。');
  return{packagePath,manifest,manifestHash};
}
function validatePackageScope(pack:Package,selection:CompanionRecoverySelection,expected:string):void{
  if(pack.manifestHash!==expected||pack.manifest.snapshot.libraryId!==selection.libraryId)throw new Error('备份不属于宿主选定的资产库或审核的包版本。');
  if(same(pack.packagePath,selection.libraryPath)||inside(selection.libraryPath,pack.packagePath))throw new Error('恢复包不能位于当前目标资产库内部。');
}
/** Preview also works with a lost ledger. It never constructs a Store or
 * creates/reconciles either the primary database or its authority. */
export function inspectSelectedCompanionBackup(selection:CompanionRecoverySelection,packagePath:string):CompanionRecoveryResult{
  const pack=inspectCompanionBackup(packagePath);validatePackageScope(pack,selection,pack.manifestHash);
  const fence=new CompanionRecoveryFence(selection,paths(selection).ledger,undefined,{readonly:true});
  try{const checked=fence.inspectTicket(pack.manifest.snapshot.id);
    if(checked.ticket.ledgerHash!==pack.manifest.snapshot.ledgerHash||checked.ticket.manifestHash!==pack.manifestHash)throw new Error('备份正文与宿主恢复凭据不一致。');
    return{...result(pack,'backup',pack.manifest.snapshot.id),databaseRestoreAvailable:checked.current,unavailableReason:checked.current?undefined:'宿主已有后续写入或未完成恢复；旧包只能核对当前准确登记的缺失正文，不能回滚账本。'};
  }finally{fence.close();}
}
/** Missing bytes only. A stale package never grants an old source/profile. */
export function restoreCurrentCompanionFiles(db:CompanionConnection,fence:CompanionRecoveryFence,selection:CompanionRecoverySelection,input:{operationId:string;packagePath:string;expectedManifestHash:string},sourceVisible:(ownerId:string,messageId:string)=>boolean):CompanionRecoveryResult{
  operation.parse(input.operationId);assertSettled(db);const pack=inspectCompanionBackup(input.packagePath);validatePackageScope(pack,selection,input.expectedManifestHash);const head=fence.reconcile(db);if(head.lineageId!==pack.manifest.snapshot.lineageId)throw new Error('备份不是当前宿主身份谱系。');
  let restored=0;
  for(const raw of lines(managed(pack.packagePath,'files.ndjson'))){const item=companionRecoveryFileSchema.parse(raw);if(item.area!=='owner'||!item.artifactId)continue;
    const current=db.prepare("SELECT a.metadata FROM companion_artifacts a JOIN companions c ON c.id=a.owner_id AND c.deleted_at IS NULL WHERE a.owner_id=? AND a.artifact_id=? AND a.state='committed' AND a.revision=? AND a.content_hash=? AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=a.owner_id AND r.status!='completed')").get(item.ownerId,item.artifactId,item.artifactRevision,item.hash) as {metadata:string}|undefined;if(!current)continue;
    const record=companionArtifactSchema.parse(JSON.parse(current.metadata));if(record.relativePath!==item.relativePath)throw new Error('当前登记路径与备份正文不一致。');
    // Runtime snapshots/logs may deliberately use conservative owner-epoch
    // invalidation rather than an exact source readset. A stale package is
    // never a route for reconstructing those opaque historical payloads.
    if(['context_snapshot','runtime_index','diagnostic_log','task_reference'].includes(record.kind))continue;
    const visited=new Set<string>();
    const allowed=(artifact:CompanionArtifact):boolean=>{
      const key=artifact.artifactId+':'+artifact.contentRevision;if(visited.has(key))return true;if(visited.size>=4096)throw new Error('修复依据闭包超过单对象核验范围，未恢复未知依赖。');visited.add(key);
      if(artifact.kind==='source_evidence'){
        const match=/^source:([a-zA-Z0-9_-]{1,100}):r([1-9][0-9]*)$/u.exec(artifact.artifactId);if(!match)return false;
        const source=db.prepare('SELECT content FROM messages WHERE id=?').get(match[1]) as {content:string}|undefined;
        if(!source||digest(source.content)!==artifact.contentHash||!sourceVisible(artifact.ownerId,match[1]!))return false;
      }
      for(const ref of [...artifact.sourceRefs,...artifact.dependencyRefs]){
        const found=db.prepare("SELECT v.metadata FROM companion_artifact_versions v JOIN companion_artifacts a ON a.owner_id=v.owner_id AND a.artifact_id=v.artifact_id AND a.state='committed' WHERE v.owner_id=? AND v.artifact_id=? AND v.revision=? AND v.content_hash=?").get(artifact.ownerId,ref.artifactId,ref.contentRevision,ref.contentHash) as {metadata:string}|undefined;
        if(!found||!allowed(companionArtifactSchema.parse(JSON.parse(found.metadata))))return false;
      }return true;
    };
    if(!allowed(record))continue;
    const target=fileTarget(selection,item,true);
    if(installExact(managed(pack.packagePath,'objects/'+item.hash),target,item,path.join(paths(selection).data,'.recovery-staging','files-'+input.operationId)))++restored;
  }
  const after=fence.reconcile(db);if(after.generation!==head.generation)throw new Error('修复期间当前权威发生变化，请重新核验。');return{...result(pack,'current_files',input.operationId),generation:after.generation,restoredFiles:restored};
}
export function restoreCompanionDatabase(selection:CompanionRecoverySelection,input:{operationId:string;packagePath:string;expectedManifestHash:string}):CompanionRecoveryResult{
  operation.parse(input.operationId);const pack=inspectCompanionBackup(input.packagePath);validatePackageScope(pack,selection,input.expectedManifestHash);const location=paths(selection),fence=new CompanionRecoveryFence(selection,location.ledger);
  try{
    const prior=fence.restoreReceipt(input.operationId);
    if(prior&&(prior.ticketId!==pack.manifest.snapshot.id||prior.manifestHash!==pack.manifestHash))throw new Error('恢复标识已经绑定不同的备份。');
    if(prior?.state==='ready')return{...result(pack,'database',input.operationId),generation:prior.generation,requiresReview:true,historicalReplay:true};
    if(!prior&&existsSync(location.ledger))throw new Error('当前账本仍存在；灾难恢复不会覆盖它，请使用准确缺失正文修复。');
    for(const suffix of ['-wal','-shm','-journal'])if(existsSync(location.ledger+suffix))throw new Error('目标仍有SQLite运行旁文件，必须先停止原写入进程。');
    const snapshot=pack.manifest.snapshot,ticket:CompanionRecoveryTicket={id:snapshot.id,lineageId:snapshot.lineageId,generation:snapshot.generation,ledgerHash:snapshot.ledgerHash,manifestHash:pack.manifestHash};
    const receipt=fence.beginRestore(input.operationId,ticket),stageRoot=path.join(location.data,'.recovery-staging','restore-'+input.operationId);directory(stageRoot,true);const stage=path.join(stageRoot,'ledger.sqlite');let heldOwners=snapshot.owners;
    if(!receipt.ledgerHash){
      // Rebuild from the immutable, ticket-bound original after an interrupted
      // stage. Never adopt arbitrary SQL merely because its marker looks right.
      const candidate=existsSync(stage)?path.join(stageRoot,'rebuild-'+randomUUID()+'.sqlite'):stage;
      copyExact(managed(pack.packagePath,'ledger.sqlite'),candidate,{hash:snapshot.ledgerHash,size:snapshot.ledgerSize});
      const staged=new Database(candidate,{fileMustExist:true}),clock=new Database(':memory:');try{
        // Trigger timestamps are part of the restored bytes. Rebuilding the
        // same operation uses its durable host timestamp, never today's time.
        const functions=staged as unknown as {function(name:string,options:{varargs:boolean},fn:(...args:unknown[])=>unknown):void};
        functions.function('strftime',{varargs:true},(...args)=>args.length===2&&args[0]==='%Y-%m-%dT%H:%M:%fZ'&&args[1]==='now'?receipt.createdAt
          :(clock.prepare('SELECT strftime('+args.map(()=>'?').join(',')+') AS value').get(...args) as {value:unknown}).value);
        staged.pragma('journal_mode=DELETE');staged.pragma('synchronous=FULL');
        const protocol=staged.prepare('SELECT protocol FROM companion_cognition_protocol WHERE singleton=1').get() as {protocol:string}|undefined,marker=fence.marker(staged);
        if(protocol?.protocol!==COMPANION_COGNITION_PROTOCOL||marker?.lineage_id!==snapshot.lineageId||marker?.generation!==snapshot.generation||staged.pragma('integrity_check',{simple:true})!=='ok'||staged.prepare('PRAGMA foreign_key_check').get())throw new Error('恢复账本协议、完整性或当前宿主水位不一致。');
        staged.transaction(()=>{heldOwners=holdRestoredCompanionWork(staged).owners;staged.prepare('UPDATE companion_recovery_state SET generation=? WHERE singleton=1').run(receipt.generation);}).immediate();
      }finally{staged.close();clock.close();}
      const preparedHash=recoveryFileHash(candidate).hash;
      if(candidate!==stage){const old=recoveryFileHash(stage);
        if(old.hash!==preparedHash&&old.hash!==snapshot.ledgerHash){unlinkSync(candidate);throw new Error('已有恢复暂存字节与准确重建结果不一致，不会覆盖。');}
        if(old.hash===snapshot.ledgerHash){unlinkSync(stage);copyExact(candidate,stage,{hash:preparedHash,size:lstatSync(candidate).size});}
        unlinkSync(candidate);
      }
      fence.stageRestore(input.operationId,preparedHash);
    }
    const prepared=fence.restoreReceipt(input.operationId)!;if(!prepared.ledgerHash||recoveryFileHash(stage).hash!==prepared.ledgerHash)throw new Error('恢复暂存账本与宿主准确指纹不一致。');
    let restored=0;
    const fileStage=path.join(stageRoot,'files');
    for(const raw of lines(managed(pack.packagePath,'files.ndjson'))){const item=companionRecoveryFileSchema.parse(raw),target=fileTarget(selection,item,true);if(installExact(managed(pack.packagePath,'objects/'+item.hash),target,item,fileStage))++restored;}
    installExact(stage,location.ledger,{hash:prepared.ledgerHash,size:lstatSync(stage).size},fileStage);
    const restoredDb=new Database(location.ledger,{fileMustExist:true});try{fence.finishRestore(input.operationId,prepared.ledgerHash,restoredDb);}finally{restoredDb.close();}
    if(recoveryFileHash(stage).hash===prepared.ledgerHash)unlinkSync(stage);
    return{...result(pack,'database',input.operationId),generation:prepared.generation,restoredFiles:restored,heldOwners,requiresReview:true};
  }finally{fence.close();}
}
