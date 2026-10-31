import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { inspectSelectedCompanionBackup, restoreCompanionDatabase, recoveryFileHash } from '../../src/companions/recovery-package';
import { companionRecoveryFencePath } from '../../src/companions/recovery-fence';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { CompanionJobDisposition } from '../../src/shared/companion-job-control';

const Database=BetterSqlite3 as {new(file:string,options?:{readonly?:boolean;fileMustExist?:boolean}):CompanionConnection};
const roots:string[]=[],stores=new Set<CompanionsStore>(),libraries:CompanionMemoryLibrary[]=[];
afterEach(async()=>{for(const library of libraries.splice(0))await library.close();for(const store of stores)store.close();stores.clear();for(const root of roots.splice(0)){
  if(path.dirname(root)!==path.resolve(tmpdir())||!path.basename(root).startsWith('companion-recovery-package-'))throw new Error('Unexpected recovery fixture root');rmSync(root,{recursive:true,force:true});
}});
async function fixture(){
  const root=mkdtempSync(path.join(tmpdir(),'companion-recovery-package-'));roots.push(root);const libraryPath=path.join(root,'library'),destinationParent=path.join(root,'backups'),data=path.join(libraryPath,'.worldlinebox','companions'),owners=path.join(libraryPath,'伙伴记忆');
  mkdirSync(data,{recursive:true});mkdirSync(owners);mkdirSync(destinationParent);const libraryId=randomUUID(),library=new Database(path.join(libraryPath,'.worldlinebox','library.db'));library.exec('CREATE TABLE library(library_id TEXT PRIMARY KEY)');library.prepare('INSERT INTO library VALUES(?)').run(libraryId);library.close();
  const selection={libraryPath,libraryId},ledger=path.join(data,'messages.sqlite'),options={recoveryAuthority:selection};let store=new CompanionsStore(ledger,[],options);stores.add(store);
  const owner=store.createCompanion({name:'恢复角色',description:'只读身份',persona:'根据有依据的经历逐渐学习。',model:'',avatar:'custom',proactive:false});store.setCompanionActive(owner.id,true);
  const request=async(command:CompanionStorageCommand)=>store.request(command),profiles=new CompanionAssetProfileStore(owners,{registryStorage:{request},initialized:async id=>!!store.request({type:'companion.assets.initialized',companionId:id}).assetProfileInitialized,markInitialized:async id=>{store.request({type:'companion.assets.mark-initialized',companionId:id});}});
  const snapshot=await profiles.bootstrap(owner),registry=await profiles.artifacts(owner.id),scope={companionId:owner.id,conversationId:store.openPrivate(owner.id).id};
  const source=store.appendMessage({conversationId:scope.conversationId,authorId:'user',content:'我说累的时候，先问我需要安静还是需要建议。',replyDirective:'none'});
  const workId=randomUUID();store.request({type:'work.enqueue',work:{id:workId,...scope,sourceMessageId:source.id,status:'queued',createdAt:source.createdAt,updatedAt:source.createdAt,proactive:false}});
  store.request({type:'work.status',id:workId,status:'interrupted',resumeOnRestart:true});
  const note=store.request({type:'memory.record',...scope,candidate:{artifactKind:'episode_memory',content:'用户解释疲倦时，希望先确认需要哪种支持。',tags:[],sourceMessageIds:[source.id],relatedMemoryIds:[],evidence:[{sourceMessageId:source.id,quote:source.content}]}}).memories![0]!;
  const memory=new CompanionMemoryLibrary({libraryDirectory:owners,request,artifacts:async id=>profiles.artifacts(id)});libraries.push(memory);
  const sources=new CompanionMemorySourceFiles({library:memory}),history=new CompanionMemoryHistoryFiles({library:memory});while((await sources.flush(owner.id)).pending){/* Real durable source outbox. */}while((await history.flush(owner.id)).pending){/* Real history/body outbox. */}
  mkdirSync(path.join(data,'attachments'));const attachmentPath='attachments/fixture.bin';writeFileSync(path.join(data,attachmentPath),Buffer.from([0,1,2,255,128]));
  store.registerAttachment({attachment:{id:'fixture',name:'fixture.bin',mime:'application/octet-stream',size:5},relativePath:attachmentPath});
  writeFileSync(path.join(data,'llm-keys.enc.json'),'DO_NOT_COPY_KEY_FILE');writeFileSync(path.join(owners,owner.id,'unknown-private.md'),'DO_NOT_COPY_UNKNOWN');
  const backup=async()=>{const response=await store.recovery({type:'recovery.backup.create',libraryId,operationId:randomUUID(),destinationParent});expect(response.ok).toBe(true);return response.recovery!;};
  return{root,selection,ledger,data,owners,owner,source,note,scope,snapshot,profiles,registry,request,backup,workId,memory,get store(){return store;},close(){store.close();stores.delete(store);},reopen(){store=new CompanionsStore(ledger,[],options);stores.add(store);return store;},raw(){return new Database(ledger,{fileMustExist:true});}};
}
it('backs up real SQLite, current profile, typed evidence/history/body and binary attachments, then restores a missing database without resurrecting auto work',async()=>{
  const f=await fixture(),record=await f.registry.get('memory:'+f.note.id),profileBefore=readFileSync(path.join(f.snapshot.root,'profile.md')),bodyBefore=readFileSync(path.join(f.snapshot.root,record!.relativePath));
  const backup=await f.backup(),manifest=JSON.parse(readFileSync(path.join(backup.packagePath,'manifest.json'),'utf8')) as {snapshot:{ledgerHash:string}};
  expect(recoveryFileHash(path.join(backup.packagePath,'ledger.sqlite')).hash).toBe(manifest.snapshot.ledgerHash);expect(readdirSync(backup.packagePath).sort()).toEqual(['catalog.ndjson','files.ndjson','ledger.sqlite','manifest.json','objects']);
  expect(readFileSync(path.join(backup.packagePath,'files.ndjson'),'utf8')).not.toContain('unknown-private');expect(existsSync(path.join(backup.packagePath,'llm-keys.enc.json'))).toBe(false);
  f.close();unlinkSync(f.ledger);unlinkSync(path.join(f.snapshot.root,'profile.md'));unlinkSync(path.join(f.snapshot.root,record!.relativePath));unlinkSync(path.join(f.data,'attachments','fixture.bin'));
  const operationId=randomUUID(),input={operationId,packagePath:backup.packagePath,expectedManifestHash:backup.manifestHash},restored=restoreCompanionDatabase(f.selection,input);
  expect(restored).toMatchObject({mode:'database',requiresReview:true,heldOwners:1});expect(readFileSync(path.join(f.snapshot.root,'profile.md'))).toEqual(profileBefore);expect(readFileSync(path.join(f.snapshot.root,record!.relativePath))).toEqual(bodyBefore);expect(readFileSync(path.join(f.data,'attachments','fixture.bin'))).toEqual(Buffer.from([0,1,2,255,128]));
  expect(readFileSync(path.join(f.snapshot.root,'unknown-private.md'),'utf8')).toBe('DO_NOT_COPY_UNKNOWN');expect(readFileSync(path.join(f.data,'llm-keys.enc.json'),'utf8')).toBe('DO_NOT_COPY_KEY_FILE');
  expect(restoreCompanionDatabase(f.selection,input).generation).toBe(restored.generation);
  const next=f.reopen(),state=next.request({type:'state',includeHidden:true}).state!;expect(state.companions.find(owner=>owner.id===f.owner.id)?.active).toBe(false);expect(next.getMessage(f.source.id).content).toBe(f.source.content);
  expect(()=>next.setCompanionActive(f.owner.id,true)).toThrow('尚未核对');const jobs=next.request({type:'jobs.page',ownerId:f.owner.id,kind:'capture',limit:50}).jobPage!;expect(jobs.items.length).toBeGreaterThan(0);expect(jobs.items.every(job=>job.state==='parked')).toBe(true);
  const db=f.raw();try{expect((db.prepare("SELECT COUNT(*) n FROM companion_work_queue WHERE status='queued' OR status='running'").get() as {n:number}).n).toBe(0);const work=db.prepare('SELECT status,data FROM companion_work_queue WHERE id=?').get(f.workId) as {status:string;data:string};expect(work.status).toBe('interrupted');expect(JSON.parse(work.data).resumeOnRestart).toBeUndefined();expect((db.prepare('SELECT content_hash FROM companion_artifacts WHERE owner_id=? AND artifact_id=?').get(f.owner.id,'memory:'+f.note.id) as {content_hash:string}).content_hash).toBe(record!.contentHash);}finally{db.close();}
});
it('rejects old database packages after real source revocation and current-files repair cannot return their revoked body',async()=>{
  const f=await fixture(),record=await f.registry.get('memory:'+f.note.id),backup=await f.backup();await f.registry.revoke('source:'+f.source.id+':r1');unlinkSync(path.join(f.snapshot.root,record!.relativePath));
  const repair=await f.store.recovery({type:'recovery.restore',libraryId:f.selection.libraryId,mode:'current_files',operationId:randomUUID(),packagePath:backup.packagePath,expectedManifestHash:backup.manifestHash});expect(repair.recovery?.restoredFiles).toBe(0);expect(existsSync(path.join(f.snapshot.root,record!.relativePath))).toBe(false);
  f.close();unlinkSync(f.ledger);expect(()=>restoreCompanionDatabase(f.selection,{operationId:randomUUID(),packagePath:backup.packagePath,expectedManifestHash:backup.manifestHash})).toThrow('过期');expect(existsSync(f.ledger)).toBe(false);
});
it('rejects a pre-withdrawal backup containing verified checkpoint caches and restores only the current Alice block while preserving Bob',async()=>{
  const f=await fixture(),bob=f.store.createCompanion({name:'Bob恢复对照',description:'独立伙伴',persona:'保留自己的正式来源。',model:'',avatar:'custom',proactive:false});
  f.store.setCompanionActive(bob.id,true);await f.profiles.bootstrap(bob);const bobRoom=f.store.openPrivate(bob.id);
  const bind=(job:{id:string;leaseToken?:string},source:typeof f.source,parents:string[])=>{
    const db=f.raw();let revision:number;try{revision=(db.prepare('SELECT revision FROM messages WHERE id=?').get(source.id) as {revision:number}).revision;}finally{db.close();}
    return f.store.request({type:'topic.compaction.bind',id:job.id,leaseToken:job.leaseToken!,checkpointEventIds:parents,sources:[{id:source.id,revision,checksum:createHash('sha256').update(source.content).digest('hex')}]});
  };
  const checkpoint=(ownerId:string,conversationId:string,source:typeof f.source,summary:string,previous?:string)=>{
    const debt=f.store.request({type:'topic.compaction.enqueue',companionId:ownerId,conversationId,topicId:source.topicId!,sourceMessageId:source.id}).topicCompactionJob!;
    const job=f.store.request({type:'topic.compaction.claim'}).topicCompactionJob!;expect(job.id).toBe(debt.id);bind(job,source,previous?[previous]:[]);
    const current=f.store.request({type:'topic.read',conversationId,topicId:source.topicId!,readerId:ownerId}),checksum=createHash('sha256').update(source.content).digest('hex');
    const committed=f.store.request({type:'topic.update',conversationId,topicId:source.topicId!,readerId:ownerId,expectedRevision:current.topic!.revision,maintenance:true,
      patch:{workingState:{summary,sourceMessageIds:[source.id],state:{__continuity:{topicId:source.topicId!,companionId:ownerId,conversationId,throughSequence:source.sequence,sourceDigest:checksum,compactedMessages:1,createdAt:new Date().toISOString()}}}},
      compaction:{previousWorkingEventId:previous??null,sharedEventId:null,sourceChecksums:{[source.id]:checksum},jobGuard:{id:job.id,leaseToken:job.leaseToken!}}});
    const eventId=committed.topicState!.workingState!.sourceEventId;
    f.store.request({type:'topic.compaction.settle',id:job.id,leaseToken:job.leaseToken!,checkpointEventId:eventId,hasMore:false});return eventId;
  };
  const aliceParent=checkpoint(f.owner.id,f.scope.conversationId,f.source,'ALICE_WITHDRAWN_PREFIX_A');
  const later=f.store.appendMessage({conversationId:f.scope.conversationId,authorId:'user',content:'ALICE_STILL_LAWFUL_TAIL_C',replyDirective:'none'});
  const aliceHead=checkpoint(f.owner.id,f.scope.conversationId,later,'ALICE_HEAD_DERIVED_FROM_A_AND_C',aliceParent);
  const peer=f.store.appendMessage({conversationId:bobRoom.id,authorId:'user',content:'BOB_STILL_LAWFUL_SOURCE',replyDirective:'none'}),bobHead=checkpoint(bob.id,bobRoom.id,peer,'BOB_UNCHANGED_CHECKPOINT');
  const tail=f.store.appendMessage({conversationId:f.scope.conversationId,authorId:'user',content:'ALICE_PENDING_RAW_TAIL_D',replyDirective:'none'});
  const pending=f.store.request({type:'topic.compaction.enqueue',...f.scope,topicId:tail.topicId!,sourceMessageId:tail.id}).topicCompactionJob!;
  const running=f.store.request({type:'topic.compaction.claim'}).topicCompactionJob!;expect(running.id).toBe(pending.id);bind(running,tail,[aliceHead]);
  const inspect=f.store.request({type:'jobs.inspect',ownerId:f.owner.id,kind:'topic_compaction',id:pending.id}).jobDisposition!;
  f.store.request({type:'jobs.control',ownerId:f.owner.id,kind:'topic_compaction',id:pending.id,inputVersion:inspect.inputVersion,expectedRevision:inspect.revision,operationId:randomUUID(),action:'park'});
  const indexed=f.raw();try{
    expect(indexed.prepare('SELECT state FROM companion_topic_checkpoint_nodes WHERE event_id=?').get(aliceHead)).toEqual({state:'valid'});
    expect(indexed.prepare('SELECT parent_event_id FROM companion_topic_checkpoint_edges WHERE event_id=?').all(aliceHead)).toContainEqual({parent_event_id:aliceParent});
    expect(indexed.prepare('SELECT 1 AS yes FROM companion_topic_checkpoint_owner_reads WHERE owner_id=? AND event_id=?').get(f.owner.id,aliceHead)).toEqual({yes:1});
    expect(indexed.prepare('SELECT bound_acl_revision FROM companion_topic_compaction_jobs WHERE id=?').get(pending.id)).toMatchObject({bound_acl_revision:expect.any(String)});
  }finally{indexed.close();}
  const old=await f.backup();
  f.store.request({type:'memory.forget',...f.scope,sourceMessageIds:[f.source.id]});
  const after=f.raw();try{
    expect(after.prepare('SELECT 1 AS yes FROM companion_topic_checkpoint_owner_blocks WHERE owner_id=? AND event_id=?').get(f.owner.id,aliceHead)).toEqual({yes:1});
    expect(after.prepare('SELECT 1 AS yes FROM companion_topic_checkpoint_owner_blocks WHERE owner_id=? AND event_id=?').get(bob.id,bobHead)).toBeUndefined();
  }finally{after.close();}
  expect(f.store.getMessage(f.source.id).content).toBe(f.source.content);
  expect(JSON.stringify(f.store.request({type:'topic.read',conversationId:f.scope.conversationId,topicId:later.topicId!,readerId:f.owner.id}).topicState)).not.toContain('ALICE_HEAD_DERIVED_FROM_A_AND_C');
  expect(f.store.request({type:'topic.read',conversationId:bobRoom.id,topicId:peer.topicId!,readerId:bob.id}).topicState?.workingState?.sourceEventId).toBe(bobHead);
  const fresh=await f.backup();expect(fresh.generation).toBeGreaterThan(old.generation);f.close();unlinkSync(f.ledger);
  expect(()=>restoreCompanionDatabase(f.selection,{operationId:randomUUID(),packagePath:old.packagePath,expectedManifestHash:old.manifestHash})).toThrow('过期');expect(existsSync(f.ledger)).toBe(false);
  expect(restoreCompanionDatabase(f.selection,{operationId:randomUUID(),packagePath:fresh.packagePath,expectedManifestHash:fresh.manifestHash})).toMatchObject({requiresReview:true,heldOwners:2});
  const restored=f.reopen();
  for(const ownerId of [f.owner.id,bob.id]){expect(()=>restored.setCompanionActive(ownerId,true)).toThrow('尚未核对');restored.request({type:'recovery.review.complete',companionId:ownerId});restored.setCompanionActive(ownerId,true);}
  expect(JSON.stringify(restored.request({type:'topic.read',conversationId:f.scope.conversationId,topicId:later.topicId!,readerId:f.owner.id}).topicState)).not.toContain('ALICE_HEAD_DERIVED_FROM_A_AND_C');
  expect(restored.request({type:'topic.read',conversationId:bobRoom.id,topicId:peer.topicId!,readerId:bob.id}).topicState?.workingState?.sourceEventId).toBe(bobHead);
  expect(restored.getMessage(peer.id).content).toBe(peer.content);
});
it('repairs only current accurate missing bytes, preserves changed files, and never rolls back the live SQL state',async()=>{
  const f=await fixture(),backup=await f.backup(),profile=path.join(f.snapshot.root,'profile.md'),before=readFileSync(profile);const player=f.store.getPlayerProfile();f.store.updatePlayerProfile({name:'后来的人类资料',description:''},player.revision);
  unlinkSync(profile);const command={type:'recovery.restore' as const,libraryId:f.selection.libraryId,mode:'current_files' as const,operationId:randomUUID(),packagePath:backup.packagePath,expectedManifestHash:backup.manifestHash};expect((await f.store.recovery(command)).recovery?.restoredFiles).toBe(1);expect(readFileSync(profile)).toEqual(before);expect(f.store.getPlayerProfile().name).toBe('后来的人类资料');
  writeFileSync(profile,'UNKNOWN_EXTERNAL_EDIT');await expect(f.store.recovery({...command,operationId:randomUUID()})).rejects.toThrow('未知外改');expect(readFileSync(profile,'utf8')).toBe('UNKNOWN_EXTERNAL_EDIT');
});
it('leaves a recoverable host fence after a target conflict and resumes exactly the same approved restore without overwriting the conflict',async()=>{
  const f=await fixture(),backup=await f.backup(),profile=path.join(f.snapshot.root,'profile.md');f.close();unlinkSync(f.ledger);writeFileSync(profile,'PRESERVE_CONFLICT');
  const command={operationId:randomUUID(),packagePath:backup.packagePath,expectedManifestHash:backup.manifestHash};expect(()=>restoreCompanionDatabase(f.selection,command)).toThrow('未知不同字节');expect(readFileSync(profile,'utf8')).toBe('PRESERVE_CONFLICT');expect(()=>f.reopen()).toThrow('账本已丢失');
  unlinkSync(profile);expect(restoreCompanionDatabase(f.selection,command).requiresReview).toBe(true);expect(f.reopen().request({type:'state'}).state!.companions[0]!.active).toBe(false);
});
it('rejects corrupt objects, wrong target library and lost host authority before restoring a database',async()=>{
  const f=await fixture(),backup=await f.backup();f.close();unlinkSync(f.ledger);
  expect(()=>restoreCompanionDatabase({...f.selection,libraryId:randomUUID()},{operationId:randomUUID(),packagePath:backup.packagePath,expectedManifestHash:backup.manifestHash})).toThrow('不属于');
  const object=path.join(backup.packagePath,'objects',readdirSync(path.join(backup.packagePath,'objects'))[0]!);writeFileSync(object,'CORRUPT');expect(()=>restoreCompanionDatabase(f.selection,{operationId:randomUUID(),packagePath:backup.packagePath,expectedManifestHash:backup.manifestHash})).toThrow('损坏');expect(existsSync(f.ledger)).toBe(false);
  unlinkSync(companionRecoveryFencePath(f.selection));expect(()=>f.reopen()).toThrow('账本已丢失');expect(existsSync(companionRecoveryFencePath(f.selection))).toBe(false);
});
it('admits existing queued capture work but refuses an unsettled formal publication, including an incomplete new persona',async()=>{
  const f=await fixture();const original=f.request;const registry=await f.profiles.artifacts(f.owner.id);const record=await registry.get('memory:'+f.note.id);
  const db=f.raw();try{db.prepare("UPDATE companion_artifact_publications SET state='prepared' WHERE operation_id=?").run(record!.operationId);}finally{db.close();}
  await expect(f.backup()).rejects.toThrow('尚未结清');expect(original).toBeDefined();
});
it('a package replay cannot use a different manifest under the same restore operation',async()=>{
  const f=await fixture(),first=await f.backup(),second=await f.backup();f.close();unlinkSync(f.ledger);const operationId=randomUUID();restoreCompanionDatabase(f.selection,{operationId,packagePath:first.packagePath,expectedManifestHash:first.manifestHash});
  expect(()=>restoreCompanionDatabase(f.selection,{operationId,packagePath:second.packagePath,expectedManifestHash:second.manifestHash})).toThrow('不同');
});
it('rebuilds an interrupted SQL hold only from the exact immutable ticket-bound database, not a guessed marker',async()=>{
  const f=await fixture(),backup=await f.backup();f.close();unlinkSync(f.ledger);const authority=new Database(companionRecoveryFencePath(f.selection));
  authority.exec("CREATE TRIGGER fail_stage BEFORE UPDATE OF ledger_hash ON recovery_restores BEGIN SELECT RAISE(ABORT,'fixture stage receipt unavailable'); END");
  const input={operationId:randomUUID(),packagePath:backup.packagePath,expectedManifestHash:backup.manifestHash};
  try{expect(()=>restoreCompanionDatabase(f.selection,input)).toThrow('stage receipt unavailable');expect(existsSync(f.ledger)).toBe(false);authority.exec('DROP TRIGGER fail_stage');}finally{authority.close();}
  expect(restoreCompanionDatabase(f.selection,input)).toMatchObject({requiresReview:true,heldOwners:1});expect(f.reopen().getMessage(f.source.id).content).toBe(f.source.content);
});
it('finishes the exact two-link publication pair after interruption, without accepting unrelated hard links',async()=>{
  const f=await fixture(),backup=await f.backup(),profile=path.join(f.snapshot.root,'profile.md');f.close();unlinkSync(f.ledger);writeFileSync(profile,'PRESERVE_CONFLICT');
  const input={operationId:randomUUID(),packagePath:backup.packagePath,expectedManifestHash:backup.manifestHash};expect(()=>restoreCompanionDatabase(f.selection,input)).toThrow('未知不同字节');unlinkSync(profile);
  const entry=readFileSync(path.join(backup.packagePath,'files.ndjson'),'utf8').trim().split('\n').map(line=>JSON.parse(line) as {relativePath:string;hash:string}).find(item=>item.relativePath==='profile.md')!;
  const staging=path.join(f.data,'.recovery-staging','restore-'+input.operationId,'files');mkdirSync(staging,{recursive:true});const staged=path.join(staging,createHash('sha256').update(profile).digest('hex')+'.body');copyFileSync(path.join(backup.packagePath,'objects',entry.hash),staged);linkSync(staged,profile);expect(lstatSync(profile).nlink).toBe(2);
  expect(restoreCompanionDatabase(f.selection,input).requiresReview).toBe(true);expect(lstatSync(profile).nlink).toBe(1);expect(existsSync(staged)).toBe(false);expect(f.reopen().request({type:'state'}).state?.companions[0]?.active).toBe(false);
});
it('previews an approved package with a missing primary ledger using read-only authority and no automatic enrollment',async()=>{
  const f=await fixture(),backup=await f.backup();f.close();unlinkSync(f.ledger);const before=recoveryFileHash(companionRecoveryFencePath(f.selection));
  const inspected=inspectSelectedCompanionBackup(f.selection,backup.packagePath);expect(inspected).toMatchObject({manifestHash:backup.manifestHash,databaseRestoreAvailable:true,mode:'backup'});expect(recoveryFileHash(companionRecoveryFencePath(f.selection))).toEqual(before);expect(existsSync(f.ledger)).toBe(false);
});
it('will not clear the durable review gate while original native work is runnable, and exposes bounded pending owners',async()=>{
  const f=await fixture(),backup=await f.backup();f.close();unlinkSync(f.ledger);restoreCompanionDatabase(f.selection,{operationId:randomUUID(),packagePath:backup.packagePath,expectedManifestHash:backup.manifestHash});const store=f.reopen();
  expect(store.request({type:'recovery.review.page',limit:1}).recoveryReview).toEqual({ownerIds:[f.owner.id],hasMore:false,nextId:undefined});
  store.request({type:'work.enqueue',resume:true,work:{id:f.workId,...f.scope,sourceMessageId:f.source.id,status:'queued',createdAt:f.source.createdAt,updatedAt:f.source.createdAt,proactive:false}});
  expect(()=>store.request({type:'recovery.review.complete',companionId:f.owner.id})).toThrow('尚未核对');expect(()=>store.setCompanionActive(f.owner.id,true)).toThrow('尚未核对');
  store.request({type:'work.status',id:f.workId,status:'interrupted',resumeOnRestart:false});expect(store.request({type:'recovery.review.complete',companionId:f.owner.id}).ok).toBe(true);expect(store.request({type:'recovery.review.page',limit:1}).recoveryReview?.ownerIds).toEqual([]);
});
it('rejects a stale UI library selection before any backup namespace is created',async()=>{
  const f=await fixture(),destination=path.join(f.root,'backups');await expect(f.store.recovery({type:'recovery.backup.create',libraryId:'different-selected-library',operationId:randomUUID(),destinationParent:destination})).rejects.toThrow('资产库已变化');expect(readdirSync(destination)).toEqual([]);
});
it('confirms the original backup after a lost reply even after newer writes, without claiming that its old ticket is still current',async()=>{
  const f=await fixture(),backup=await f.backup(),player=f.store.getPlayerProfile();f.store.updatePlayerProfile({name:'备份后新资料',description:''},player.revision);
  const replay=await f.store.recovery({type:'recovery.backup.create',libraryId:f.selection.libraryId,operationId:backup.operationId,destinationParent:path.dirname(backup.packagePath)});
  expect(replay.recovery).toMatchObject({operationId:backup.operationId,manifestHash:backup.manifestHash,databaseRestoreAvailable:false});expect(f.store.getPlayerProfile().name).toBe('备份后新资料');expect(readdirSync(path.dirname(backup.packagePath))).toHaveLength(1);
});
it('advances an already parked job revision and rejects pre-restore control tokens while old operation replay remains historical',async()=>{
  const f=await fixture(),job=f.store.request({type:'jobs.page',ownerId:f.owner.id,kind:'capture',limit:50}).jobPage!.items[0]!;
  const command={type:'jobs.control' as const,ownerId:f.owner.id,kind:'capture' as const,id:job.id,inputVersion:job.inputVersion,expectedRevision:job.revision,operationId:randomUUID(),action:'park' as const},parked=f.store.request(command).jobDisposition!;
  const backup=await f.backup();f.close();unlinkSync(f.ledger);restoreCompanionDatabase(f.selection,{operationId:randomUUID(),packagePath:backup.packagePath,expectedManifestHash:backup.manifestHash});const store=f.reopen(),current=store.request({type:'jobs.inspect',ownerId:f.owner.id,kind:'capture',id:job.id}).jobDisposition!;
  expect(current.state).toBe('parked');expect(current.revision).toBe(parked.revision+1);expect(current.failureCount).toBe(parked.failureCount);expect(current.cycleFailureCount).toBe(parked.cycleFailureCount);
  expect(()=>store.request({...command,operationId:randomUUID(),action:'resume',expectedRevision:parked.revision})).toThrow(/变化|修订|版本/u);
  expect(store.request(command).jobDisposition?.revision).toBe(parked.revision);expect(store.request({type:'jobs.inspect',ownerId:f.owner.id,kind:'capture',id:job.id}).jobDisposition?.revision).toBe(current.revision);
});
it('preserves parked and abandoned source/history publication rows without inventing formal bodies, advancing every restored control fence',async()=>{
  const f=await fixture(),held:CompanionJobDisposition[]=[],unpublishedNoteIds:string[]=[],originalSourceIds:string[]=[];
  for(const action of ['park','abandon'] as const){
    const source=f.store.appendMessage({conversationId:f.scope.conversationId,authorId:'user',content:'保留原事件供之后核对：'+action,replyDirective:'none'});originalSourceIds.push(source.id);
    const note=f.store.request({type:'memory.record',...f.scope,candidate:{artifactKind:'episode_memory',content:'这份已保存的记忆正文暂未发布：'+action,tags:[],sourceMessageIds:[source.id],relatedMemoryIds:[],evidence:[{sourceMessageId:source.id,quote:source.content}]}}).memories![0]!;
    unpublishedNoteIds.push(note.id);
    for(const kind of ['source_files','history_files'] as const){
      const job=f.store.request({type:'jobs.page',ownerId:f.owner.id,kind,limit:50}).jobPage!.items.find(item=>kind==='source_files'?item.sourceMessageId===source.id:item.memoryId===note.id)!;
      expect(job).toBeDefined();held.push(f.store.request({type:'jobs.control',ownerId:f.owner.id,kind,id:job.id,inputVersion:job.inputVersion,expectedRevision:job.revision,operationId:randomUUID(),action}).jobDisposition!);
    }
    expect(await f.registry.get('memory:'+note.id)).toBeUndefined();
  }
  const backup=await f.backup(),entries=readFileSync(path.join(backup.packagePath,'files.ndjson'),'utf8');
  for(const noteId of unpublishedNoteIds)expect(entries).not.toContain(noteId);
  f.close();unlinkSync(f.ledger);restoreCompanionDatabase(f.selection,{operationId:randomUUID(),packagePath:backup.packagePath,expectedManifestHash:backup.manifestHash});const store=f.reopen();
  for(const previous of held){
    const current=store.request({type:'jobs.inspect',ownerId:f.owner.id,kind:previous.kind,id:previous.id}).jobDisposition!;
    expect(current).toMatchObject({state:previous.state,revision:previous.revision+1,inputVersion:previous.inputVersion,failureCount:previous.failureCount,cycleFailureCount:previous.cycleFailureCount,attemptCount:previous.attemptCount});
    expect(()=>store.request({type:'jobs.control',ownerId:f.owner.id,kind:previous.kind,id:previous.id,inputVersion:previous.inputVersion,expectedRevision:previous.revision,operationId:randomUUID(),action:'resume'})).toThrow(/变化|修订|版本/u);
  }
  expect(store.request({type:'memory.sources.outbox.claim',companionId:f.owner.id}).memorySourceOutbox).toBeUndefined();
  expect(store.request({type:'memory.history.outbox.claim',companionId:f.owner.id}).memoryHistoryOutbox).toBeUndefined();
  for(const sourceId of originalSourceIds)expect(store.getMessage(sourceId).content).toContain('保留原事件');
  for(const noteId of unpublishedNoteIds)expect(await f.registry.get('memory:'+noteId)).toBeUndefined();
  expect(store.request({type:'recovery.review.complete',companionId:f.owner.id}).ok).toBe(true);expect(store.request({type:'state'}).state!.companions[0]!.active).toBe(false);
});
it('refuses active source, history and topic-compaction leases while allowing durable waiting inputs after those leases are released',async()=>{
  const f=await fixture(),source=f.store.appendMessage({conversationId:f.scope.conversationId,authorId:'user',content:'这条经历已保存，但文件还没有正式发布。',replyDirective:'none'});
  f.store.request({type:'memory.record',...f.scope,candidate:{artifactKind:'episode_memory',content:'等待发布的经历。',tags:[],sourceMessageIds:[source.id],relatedMemoryIds:[],evidence:[{sourceMessageId:source.id,quote:source.content}]}});
  const sourceLease=f.store.request({type:'memory.sources.outbox.claim',companionId:f.owner.id}).memorySourceOutbox!;expect(sourceLease).toBeDefined();
  await expect(f.backup()).rejects.toThrow('尚未结清');
  f.store.request({type:'memory.sources.outbox.fail',id:sourceLease.id,leaseToken:sourceLease.leaseToken,error:'Waiting for an explicit host publication.',failureKind:'waiting',retryAfterMs:1000});
  const historyLease=f.store.request({type:'memory.history.outbox.claim',companionId:f.owner.id}).memoryHistoryOutbox!;expect(historyLease).toBeDefined();
  await expect(f.backup()).rejects.toThrow('尚未结清');
  f.store.request({type:'memory.history.outbox.fail',id:historyLease.id,leaseToken:historyLease.leaseToken,error:'Waiting for source evidence publication.',failureKind:'waiting',retryAfterMs:1000});
  expect((await f.backup()).mode).toBe('backup');
  const debt=f.store.request({type:'topic.compaction.enqueue',...f.scope,topicId:source.topicId!,sourceMessageId:source.id}).topicCompactionJob!;
  const topicLease=f.store.request({type:'topic.compaction.claim'}).topicCompactionJob!;expect(topicLease.id).toBe(debt.id);
  await expect(f.backup()).rejects.toThrow('尚未结清');
  f.store.request({type:'topic.compaction.fail',id:topicLease.id,leaseToken:topicLease.leaseToken!,error:'Waiting for the host before continuing the summary.',failureKind:'waiting',retryAfterMs:1000});
  expect((await f.backup()).mode).toBe('backup');
});
it('restores a held topic-compaction debt with its real source and topic while invalidating the pre-restore control revision',async()=>{
  const f=await fixture(),source=f.store.appendMessage({conversationId:f.scope.conversationId,authorId:'user',content:'这一条原始话题消息必须保留，摘要债务可以等待核对。',replyDirective:'none'});
  const debt=f.store.request({type:'topic.compaction.enqueue',...f.scope,topicId:source.topicId!,sourceMessageId:source.id}).topicCompactionJob!;
  expect(debt).toBeDefined();
  const before=f.store.request({type:'jobs.inspect',ownerId:f.owner.id,kind:'topic_compaction',id:debt.id}).jobDisposition!;
  expect(before).toMatchObject({conversationId:f.scope.conversationId,topicId:source.topicId,sourceMessageId:source.id});
  const command={type:'jobs.control' as const,ownerId:f.owner.id,kind:'topic_compaction' as const,id:debt.id,inputVersion:before.inputVersion,expectedRevision:before.revision,operationId:randomUUID(),action:'park' as const};
  const held=f.store.request(command).jobDisposition!,backup=await f.backup();f.close();unlinkSync(f.ledger);
  restoreCompanionDatabase(f.selection,{operationId:randomUUID(),packagePath:backup.packagePath,expectedManifestHash:backup.manifestHash});
  const store=f.reopen(),current=store.request({type:'jobs.inspect',ownerId:f.owner.id,kind:'topic_compaction',id:debt.id}).jobDisposition!;
  expect(current).toMatchObject({state:'parked',revision:held.revision+1,inputVersion:held.inputVersion,topicId:source.topicId,sourceMessageId:source.id,failureCount:held.failureCount,cycleFailureCount:held.cycleFailureCount});
  expect(store.request({type:'topic.compaction.claim'}).topicCompactionJob).toBeUndefined();
  expect(()=>store.request({...command,operationId:randomUUID(),action:'resume',expectedRevision:held.revision})).toThrow(/变化|修订|版本/u);
  expect(store.request(command).jobDisposition?.revision).toBe(held.revision);
  expect(store.request({type:'jobs.inspect',ownerId:f.owner.id,kind:'topic_compaction',id:debt.id}).jobDisposition?.revision).toBe(current.revision);
  expect(store.getMessage(source.id)).toMatchObject({content:source.content,topicId:source.topicId});
  expect(store.request({type:'recovery.review.complete',companionId:f.owner.id}).ok).toBe(true);
  expect(store.request({type:'state'}).state!.companions[0]!.active).toBe(false);
});
it('explicitly refuses an old-format directory without reading it into the current owner or creating a replacement identity',async()=>{
  const f=await fixture(),legacy=path.join(f.root,'old-export');mkdirSync(legacy);writeFileSync(path.join(legacy,'profile.md'),'OLD_PROFILE_NOT_A_BACKUP');writeFileSync(path.join(legacy,'old-diary.md'),'OLD_HISTORY_NOT_A_NEW_EXPERIENCE');const before=f.store.request({type:'state'}).state!.companions.map(owner=>owner.id);
  expect(()=>inspectSelectedCompanionBackup(f.selection,legacy)).toThrow('旧格式目录不会导入');expect(f.store.request({type:'state'}).state!.companions.map(owner=>owner.id)).toEqual(before);
  writeFileSync(path.join(legacy,'manifest.json'),JSON.stringify({schema:'old-backup-v1',profile:'OLD_PROFILE_NOT_A_BACKUP'}));expect(()=>inspectSelectedCompanionBackup(f.selection,legacy)).toThrow('协议或描述不受支持');expect(f.store.request({type:'memory.library.page',companionId:f.owner.id,limit:20}).memoryPage!.items).toHaveLength(1);
});
it('treats an explicit template copy as a new sealed starting point and never imports copied history during registered maintenance',async()=>{
  const f=await fixture(),copy=f.store.createCompanion({name:'显式模板副本',description:'独立新身份',persona:f.snapshot.profile.persona,model:'',avatar:'custom',proactive:false}),profile=await f.profiles.bootstrap(copy),registry=await f.profiles.artifacts(copy.id);
  writeFileSync(path.join(profile.root,'old-diary.md'),f.note.content);await f.memory.sync();
  expect(copy.id).not.toBe(f.owner.id);expect((await registry.get('origin:creation'))!.sourceRefs).toEqual([]);expect((await registry.get('persona:current'))!.sourceRefs).toEqual([]);expect(await registry.get('memory:'+f.note.id)).toBeUndefined();expect((await f.profiles.loadProfile(copy.id)).profile.persona).toBe(f.snapshot.profile.persona);
  expect(f.store.request({type:'memory.library.page',companionId:copy.id,limit:20}).memoryPage!.items).toEqual([]);expect(readFileSync(path.join(profile.root,'old-diary.md'),'utf8')).toBe(f.note.content);expect(f.store.request({type:'memory.library.page',companionId:f.owner.id,limit:20}).memoryPage!.items).toHaveLength(1);
});
