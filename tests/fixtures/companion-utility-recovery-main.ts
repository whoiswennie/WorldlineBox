import {app,BrowserWindow} from 'electron';
import {readFile,writeFile,unlink,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CompanionStorageClient} from '../../src/main/companions/storage-client';
import {CompanionAssetProfileStore} from '../../src/main/companions/asset-profile';
import type {CompanionStorageCommand} from '../../src/shared/companion-storage';

app.disableHardwareAcceleration();
async function main(){
  const config=JSON.parse(await readFile(process.argv[2]!,'utf8')) as {root:string;workerPath:string;reportPath:string;libraryId:string};
  const root=path.resolve(config.root);if(path.dirname(root)!==path.resolve(tmpdir())||!path.basename(root).startsWith('companion-utility-recovery-'))throw new Error('Unexpected isolated recovery root');
  const libraryPath=path.join(root,'library'),selection={libraryPath,libraryId:config.libraryId},databasePath=path.join(libraryPath,'.worldlinebox','companions','messages.sqlite');
  await mkdir(path.join(root,'electron-profile'));app.setPath('userData',path.join(root,'electron-profile'));let client:CompanionStorageClient|undefined;
  const request=async(command:CompanionStorageCommand)=>{if(!client)throw new Error('No recovery fixture storage');const result=await client.request(command);if(!result.ok)throw new Error(result.error);return result;};
  const connect=async()=>{client=new CompanionStorageClient(config.workerPath,databasePath,undefined,undefined,{hostRetention:selection});await client.start();};
  const close=async()=>{const previous=client;client=undefined;await previous?.close();};
  await app.whenReady();
  try{
    await connect();const birth={operationId:randomUUID(),companionId:randomUUID()},prepared=await request({type:'companion.creation.prepare',...birth,request:{kind:'custom',companion:{name:'隔离恢复验证角色',description:'Fixture',persona:'只从真实依据学习。',model:'',avatar:'custom',proactive:false}}});
    if(!prepared.companion)throw new Error('Creation not prepared');const profiles=new CompanionAssetProfileStore(path.join(libraryPath,'伙伴记忆'),{registryStorage:{request}}),profile=await profiles.bootstrap(prepared.companion);
    await request({type:'companion.creation.commit',operationId:birth.operationId});await request({type:'companion.set-active',id:birth.companionId,active:true});
    const room=(await request({type:'conversation.open',companionId:birth.companionId})).conversation!,message=(await request({type:'message.append',message:{conversationId:room.id,authorId:'user',content:'Utility recovery original event',replyDirective:'none'}})).message!;
    const backup=(await request({type:'recovery.backup.create',libraryId:selection.libraryId,operationId:randomUUID(),destinationParent:path.join(root,'backups')})).recovery!;await close();
    await unlink(databasePath);await unlink(path.join(profile.root,'profile.md'));
    const inspected=await CompanionStorageClient.inspectRecoveryPackage(config.workerPath,selection,backup.packagePath);
    if(inspected.manifestHash!==backup.manifestHash||!inspected.databaseRestoreAvailable)throw new Error('Lost-ledger readonly inspection failed');
    // Main passes its full typed workspace command. The transport must pick
    // fields rather than letting that command overwrite the boot protocol.
    const restoreCommand={type:'recovery.restore' as const,mode:'database' as const,libraryId:selection.libraryId,operationId:randomUUID(),packagePath:backup.packagePath,expectedManifestHash:inspected.manifestHash};
    const restored=await CompanionStorageClient.recoverDatabase(config.workerPath,selection,restoreCommand);
    if(!restored.requiresReview||restored.heldOwners!==1)throw new Error('Restore did not preserve explicit review');await connect();
    const state=(await request({type:'state'})).state!;if(state.companions.length!==1||state.companions[0]!.id!==birth.companionId||state.companions[0]!.active)throw new Error('Restored identity activated or changed');
    if((await request({type:'message.get',id:message.id})).message?.content!==message.content)throw new Error('Original event bytes changed');
    if((await profiles.loadProfile(birth.companionId)).profileRevision!==profile.profileRevision)throw new Error('Published personality version changed');
    const page=(await request({type:'recovery.review.page',limit:10})).recoveryReview!;if(page.ownerIds.join()!==birth.companionId||page.hasMore)throw new Error('Bounded review page omitted held owner');
    const rejected=await client!.request({type:'companion.set-active',id:birth.companionId,active:true});if(rejected.ok)throw new Error('Unreviewed recovered owner activated');
    const captures=(await request({type:'jobs.page',kind:'capture',ownerId:birth.companionId,limit:50})).jobPage!;if(!captures.items.length||captures.items.some(job=>job.state!=='parked'))throw new Error('Old jobs were not held');
    await close();await connect();if(!(await request({type:'recovery.review.page',limit:10})).recoveryReview?.ownerIds.includes(birth.companionId))throw new Error('Review gate did not survive another worker restart');
    const stale=await CompanionStorageClient.inspectRecoveryPackage(config.workerPath,selection,backup.packagePath);if(stale.databaseRestoreAvailable)throw new Error('Old package still claims current database authority');
    await close();await writeFile(config.reportPath,JSON.stringify({ready:true,runAsNode:process.env.ELECTRON_RUN_AS_NODE==='1',windows:BrowserWindow.getAllWindows().length,electronVersion:process.versions.electron,
      backupViaWorker:true,lostLedgerPreviewReadonly:true,databaseRestoreViaDedicatedWorker:true,identityVersionExact:true,eventBytesExact:true,unreviewedOwnerInactive:true,oldJobsParked:true,secondRestartGate:true,stalePackageCannotRollback:true,externalModelCalls:0}));app.exit(0);
  }catch(error){await close();await writeFile(config.reportPath,JSON.stringify({error:error instanceof Error?error.stack:String(error)}));app.exit(1);}
}
void main().catch(error=>{process.stderr.write(String(error));app.exit(1);});
