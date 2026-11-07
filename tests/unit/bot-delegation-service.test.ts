import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {BotService} from '../../src/main/companion-bot/service';
import {BotStore} from '../../src/main/companion-bot/store';
import {BotTaskRuntime} from '../../src/main/companion-bot/task-runtime';
import {BotCompanionRuntime} from '../../src/main/companion-bot/companion-runtime';
import {BotWorkflowRuntime} from '../../src/main/companion-bot/workflow-runtime';
import {BotDelegationRuntime} from '../../src/main/companion-bot/delegation-runtime';
import {BotMediaService} from '../../src/main/companion-bot/media-service';
import type {BotEvent,BotTask,BotClaim} from '../../src/main/companion-bot/types';
import type {BotToolCall} from '../../src/main/companion-bot/tool-server';

const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
interface Controller {
  executeTool(event:BotEvent,call:BotToolCall,signal:AbortSignal):Promise<unknown>;
  controlQueue(conversationId:string,operation:'cancel_all',requestId:string,companionId?:string,controllingEventId?:string):Promise<unknown>;
  controlTask(task:BotTask,operation:'pause'|'resume_paused',text:string|undefined,requestId:string,input:{caller:'user'}):Promise<unknown>;
  finishTask(task:BotTask,status:'succeeded'|'failed'|'cancelled',text?:string):void;
  refreshDelegations():void;
  remindDelegationReturn(event:BotEvent):void;
  launchTask(task:BotTask):void;
  taskWorkdir(task:BotTask,securityDomainId:string):string;
}
async function fixture(){
  const root=await mkdtemp(path.join(tmpdir(),'wlb-delegation-service-')),store=new BotStore(path.join(root,'bot.sqlite'),{activityBudget:{maxActions:100,maxTasks:100,maxDerivedEvents:100}});
  closes.push(async()=>{store.close();if(path.dirname(root)!==path.resolve(tmpdir())||!path.basename(root).startsWith('wlb-delegation-service-'))throw Error('Invalid owned delegation integration directory');await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
  for(const id of ['alice','bob','carol'])store.createCompanion({id,name:id,persona:'独立角色的真实事件与授权测试。'});
  const room=store.openDirect('alice'),media=new BotMediaService({root:path.join(root,'media'),builtinRoot:path.resolve('resources/bot-stickers')}),delegations=new BotDelegationRuntime(store);
  const workflows:BotWorkflowRuntime=new BotWorkflowRuntime(store,{authority:event=>companionRuntime.workAuthority(event)});
  const companionRuntime:BotCompanionRuntime=new BotCompanionRuntime(store,{taskAuthority:task=>workflows.taskAuthority(task),authorityGuard:event=>delegations.allowsWork(event)});
  const service=Object.create(BotService.prototype) as BotService,launch=vi.fn();
  Object.assign(service,{store,delegations,workflows,companionRuntime,taskRuntime:new BotTaskRuntime(store),options:{root,media},closed:false,
    maintenanceAbort:new AbortController(),
    taskRuns:new Map(),taskPreparations:new Map(),taskAccessUpgrades:new Map(),toolRuns:new Map(),delegationCleanup:new Set(),delegationCursor:0,
    scheduler:{wake:vi.fn(),cancel:vi.fn()},toolServer:{releaseWorker:vi.fn()},changed:vi.fn(),maintainSafely:vi.fn(),taskProgress:vi.fn(),
    launchTask:launch,flushTaskControls:vi.fn(async()=>undefined),flushExecutorControl:vi.fn(async()=>undefined)});
  const controller=service as unknown as Controller;
  const claim=(event:BotEvent):BotClaim=>{
    const value=store.claim({workerId:'delegation-integration',leaseMs:300000});expect(value?.event.id).toBe(event.id);store.bindEventNativeEpoch(event.id,1);return value!;
  };
  const call=(event:BotEvent,name:string,args:Record<string,unknown>,callId:string):BotToolCall=>({eventId:event.id,laneId:event.laneId,name,args,callId});
  const execute=(event:BotEvent,name:string,args:Record<string,unknown>,callId=name)=>controller.executeTool(event,call(event,name,args,callId),new AbortController().signal);
  const source=(content='请让 Bob 分析指定原件并把核验成果交回本聊天。',attachmentIds:string[]=[])=>{
    return media.resolveForConversation(room.id,attachmentIds).then(attachments=>{const event=store.enqueue({conversationId:room.id,senderId:'user',sourceMessageId:'user-root',content,attachments}).events[0]!;return{event,claim:claim(event)};});
  };
  const delegate=async(event:BotEvent,attachmentIds?:string[])=>{
    const args={companionId:'bob',title:'跨伙伴原件核验',goal:'仅核验已选择的两份原件，比较金额和政策约束，将真实核验后的报告交回。',...(attachmentIds?{attachmentIds}:{})};
    const receipt=await execute(event,'companion_delegate',args,'delegate') as {delegationId:string;taskId:string};
    const ticket=delegations.get(receipt.delegationId)!;return{receipt,ticket,peer:store.getEvent(ticket.contactEventId)!};
  };
  return{root,store,media,delegations,workflows,companionRuntime,taskRuntime:(service as unknown as {taskRuntime:BotTaskRuntime}).taskRuntime,service,controller,launch,room,claim,call,execute,source,delegate};
}

it('keeps ordinary contact as communication and never runs a delegated proxy as a local Worker',async()=>{
  const f=await fixture(),root=await f.source();
  await f.execute(root.event,'companion_contact',{companionId:'bob',destination:'peer',message:'用户请你聊一句晚安。'},'greeting');
  expect(f.store.listTasks()).toEqual([]);expect(f.delegations.status(root.event).tickets).toEqual([]);expect(f.launch).not.toHaveBeenCalled();
  const delegated=await f.delegate(root.event,[]),proxy=f.store.getTask(delegated.receipt.taskId)!;
  const actual=(BotService.prototype as unknown as Controller).launchTask;actual.call(f.service,proxy);
  expect(f.launch).not.toHaveBeenCalled();expect(proxy.extra).toMatchObject({delegationProxy:true,externalDelegationId:delegated.ticket.id});expect(proxy.extra.nativeAttempted).toBeUndefined();
  const tasks=f.store.listTasks();expect(tasks).toHaveLength(1);expect(tasks[0]!.companionId).toBe('alice');
});

it('stops an original-owner queue and its recipient children while preserving unrelated peer, direct and group tasks',async()=>{
  const f=await fixture(),root=await f.source(),delegated=await f.delegate(root.event,[]);f.claim(delegated.peer);
  const worker=await f.execute(delegated.peer,'dsh_task',{goal:'核算指定原件。',title:'Bob核算',attachmentIds:[]},'bob-worker') as {taskId:string};
  const unrelatedPeer=f.store.createTask({id:'bob-unrelated-peer',conversationId:delegated.peer.conversationId,companionId:'bob',sourceEventId:delegated.peer.id,goal:'独立私聊工作。'});
  const direct=f.store.openDirect('bob'),directEvent=f.store.enqueue({conversationId:direct.id,senderId:'user',content:'Bob 独立工作',sourceMessageId:'bob-direct'}).events[0]!;
  const unrelatedDirect=f.store.createTask({id:'bob-unrelated-direct',conversationId:direct.id,companionId:'bob',sourceEventId:directEvent.id,goal:'独立用户工作。'});
  const group=f.store.createGroup({title:'其他群',memberIds:['bob','carol']}),groupEvent=f.store.enqueue({conversationId:group.id,senderId:'user',content:'另一群任务',sourceMessageId:'group-task',recipientIds:['bob']}).events[0]!;
  const unrelatedGroup=f.store.createTask({id:'bob-unrelated-group',conversationId:group.id,companionId:'bob',sourceEventId:groupEvent.id,goal:'群内任务。'});
  expect(await f.controller.controlQueue(f.room.id,'cancel_all','original-stop','alice',root.event.id)).toMatchObject({accepted:true,affected:1,cancelled:1});
  expect(f.store.getTask(delegated.receipt.taskId)?.status).toBe('cancelled');expect(f.store.getTask(worker.taskId)?.status).toBe('cancelled');expect(f.delegations.get(delegated.ticket.id)?.state).toBe('cancelled');
  for(const task of [unrelatedPeer,unrelatedDirect,unrelatedGroup])expect(f.store.getTask(task.id)?.status).toBe('queued');
  expect(f.companionRuntime.authorize(delegated.peer,'late-work')).toMatchObject({allowed:false});
  const previous=f.store.listTasks().length;expect(await f.execute(delegated.peer,'dsh_task',{goal:'不应迟到启动',attachmentIds:[]},'late-create')).toMatchObject({allowed:false});expect(f.store.listTasks()).toHaveLength(previous);
  await expect(f.execute(delegated.peer,'dsh_plan',{operation:'create',title:'禁止重开',stages:[{key:'extra',title:'额外任务',dependsOn:[]}]},'late-plan')).rejects.toThrow();
});

async function completedRoundTrip(){
  const f=await fixture(),ledger=path.join(f.root,'ledger.csv'),policy=path.join(f.root,'policy.md'),unrelated=path.join(f.root,'private.txt');
  await writeFile(ledger,'项目,金额\n订单,230\n退款,-23\n');await writeFile(policy,'退款必须减计，净额保留两位小数。');await writeFile(unrelated,'PRIVATE_UNRELATED_CONTEXT');
  const originals=await f.media.importFiles({conversationId:f.room.id,paths:[ledger,policy,unrelated]}),root=await f.source('请仅将账单和政策原件交给 Bob 核验。',originals.map(ref=>ref.id));
  const delegated=await f.delegate(root.event,originals.slice(0,2).map(ref=>ref.id)),peerClaim=f.claim(delegated.peer),peerRefs=f.store.getMessage(delegated.peer.sourceMessageRecordId)!.attachments!;
  expect(peerRefs.map(ref=>ref.name)).toEqual(['ledger.csv','policy.md']);expect(f.store.modelAttachments(delegated.peer).map(ref=>ref.name).sort()).toEqual(['ledger.csv','policy.md']);
  expect(JSON.stringify(f.delegations.status(root.event))).not.toContain('PRIVATE_UNRELATED_CONTEXT');
  const worker=await f.execute(delegated.peer,'dsh_task',{goal:'按账单与政策计算净额并生成核验报告。',title:'核算原件'},'bob-finance') as {taskId:string};
  const task=f.store.getTask(worker.taskId)!;expect(task.extra.attachmentIds).toEqual(peerRefs.map(ref=>ref.id));expect(task.extra.delegationId).toBe(delegated.ticket.id);
  f.store.settle({eventId:delegated.peer.id,leaseToken:peerClaim.leaseToken,status:'done',content:'我已派发实际核验任务。'});
  f.store.updateTask(task.id,{status:'running',extra:{...task.extra,nativeAttempted:true}});
  const report=path.join(f.root,'verified-report.md'),reportText='净额 = 230.00 - 23.00 = 207.00；退款已减计。';await writeFile(report,reportText);
  const [artifact]=await f.media.importFiles({conversationId:delegated.peer.conversationId,paths:[report]});
  const peerPublication=f.store.publishForTask(task.id,'verified-output',{content:'已实际核验报告。',attachments:[artifact!]});
  f.controller.finishTask(f.store.getTask(task.id)!,'succeeded',reportText);
  const notice=f.store.taskTransaction(sql=>sql.prepare("SELECT id FROM bot_inbox WHERE source='task' AND json_extract(payload_json,'$.taskId')=? ORDER BY sequence DESC LIMIT 1").get(task.id)) as {id:string};
  const event=f.store.getEvent(notice.id)!;f.claim(event);
  return{...f,profileRoot:f.root,originals,root,delegated,task,event,artifact:artifact!,reportText,peerPublication};
}

it('transfers real multi-file analysis input and real verified output back to the original chat with grants and exact bytes',async()=>{
  const f=await completedRoundTrip(),args={operation:'result',message:f.reportText};
  const other=path.join(f.profileRoot,'not-the-ticket-output.txt');await writeFile(other,'UNRELATED_B_WORKER_OUTPUT');const [otherRef]=await f.media.importFiles({conversationId:f.delegated.peer.conversationId,paths:[other]});
  const unrelatedTask=f.store.createTask({id:'unrelated-output-worker',conversationId:f.delegated.peer.conversationId,companionId:'bob',sourceEventId:f.delegated.peer.id,goal:'独立Worker',extra:{nativeAttempted:true}});
  f.store.updateTask(unrelatedTask.id,{status:'running'});f.store.publishForTask(unrelatedTask.id,'other-output',{attachments:[otherRef!]});f.store.updateTask(unrelatedTask.id,{status:'succeeded'});
  const result=await f.execute(f.event,'companion_delegation',args,'submit-real-result') as {messageId:string;attachmentIds:string[]};
  const message=f.store.getMessage(result.messageId)!;expect(message.conversationId).toBe(f.room.id);expect(message.senderId).toBe('alice');expect(message.attachments).toHaveLength(1);
  const [returned]=message.attachments!;expect(returned).toMatchObject({name:'verified-report.md',sha256:f.artifact.sha256});expect(returned!.id).not.toBe(f.artifact.id);
  expect(await readFile((await f.media.getForAgent(f.room.id,returned!.id)).path,'utf8')).toBe(f.reportText);expect(f.store.modelAttachments(f.root.event,{ids:[returned!.id]})).toEqual([returned]);
  expect(f.store.getTask(f.delegated.receipt.taskId)?.status).toBe('succeeded');expect(f.store.getTask(f.delegated.receipt.taskId)?.extra.nativeAttempted).toBeUndefined();expect(f.delegations.get(f.delegated.ticket.id)?.state).toBe('completed');
  const proof=await f.service.reconcileToolReceipt(f.call(f.event,'companion_delegation',args,'submit-real-result'));expect(proof).toMatchObject({state:'committed',result:{sent:true,messageId:message.id}});
  expect(f.store.publicationsForTask(f.delegated.receipt.taskId)).toHaveLength(1);
  const grant=f.store.modelAttachmentGrants(f.root.event,{ids:[returned!.id]})[0]!;expect(f.store.attachmentGrantSourceIds([grant.grantId])).toContain(f.event.id);
  f.store.withdrawSources('bob',f.delegated.peer.securityDomainId,[f.peerPublication.id]);
  expect(f.store.peerWithdrawalTargets('bob',f.delegated.peer.securityDomainId)).toContainEqual({conversationId:f.room.id,messageId:message.id});
  f.store.withdrawSources('alice',f.root.event.securityDomainId,[message.id]);expect(f.store.modelAttachments(f.root.event,{ids:[returned!.id]})).toEqual([]);
});

it('never accepts mutated result parameters as a committed recovery and leaves the real publication singular',async()=>{
  const f=await completedRoundTrip(),args={operation:'result',message:f.reportText,attachmentIds:[f.artifact.id]};await f.execute(f.event,'companion_delegation',args,'result-fingerprint');
  const proof=await f.service.reconcileToolReceipt(f.call(f.event,'companion_delegation',{...args,message:'未实际核验的另一结果'},'result-fingerprint'));expect(proof).toEqual({state:'unknown'});
  await expect(f.execute(f.event,'companion_delegation',{...args,message:'未实际核验的另一结果'},'result-fingerprint')).rejects.toThrow(/回执|参数|匹配/u);
  expect(f.store.publicationsForTask(f.delegated.receipt.taskId)).toHaveLength(1);
});

it('does not return an unrelated same-peer Worker artifact through an explicit result attachment ID',async()=>{
  const f=await completedRoundTrip(),foreignPath=path.join(f.profileRoot,'unrelated-private-worker.txt');await writeFile(foreignPath,'PRIVATE_OTHER_TASK_FILE');
  const [foreignRef]=await f.media.importFiles({conversationId:f.delegated.peer.conversationId,paths:[foreignPath]});
  const foreign=f.store.createTask({id:'foreign-task',conversationId:f.delegated.peer.conversationId,companionId:'bob',sourceEventId:f.delegated.peer.id,goal:'本委派范围外的工作。',extra:{nativeAttempted:true}});
  f.store.updateTask(foreign.id,{status:'running'});f.store.publishForTask(foreign.id,'foreign-file',{attachments:[foreignRef!]});f.store.updateTask(foreign.id,{status:'succeeded'});
  f.store.cancelEvent(f.event.id);
  const notice=f.store.enqueue({conversationId:f.delegated.peer.conversationId,senderId:'task-service',source:'task',recipientIds:['bob'],content:'重新核对本委派的实际结果。',kind:'task_done',
    sourceMessageId:'later-delegation-result',causationId:f.task.sourceEventId,correlationId:f.delegated.ticket.correlationId,payload:{taskId:f.task.id}}).events[0]!;f.claim(notice);
  expect(f.store.modelAttachments(notice,{ids:[foreignRef!.id]})).toEqual([foreignRef]);
  await expect(f.execute(notice,'companion_delegation',{operation:'result',message:f.reportText,attachmentIds:[foreignRef!.id]},'foreign-result')).rejects.toThrow(/委派|产物|授权/u);
  expect(f.store.publicationsForTask(f.delegated.receipt.taskId)).toEqual([]);expect(f.delegations.get(f.delegated.ticket.id)?.state).toBe('active');
});

it('refuses an apparent result while any actual recipient Worker is still unfinished',async()=>{
  const f=await fixture(),root=await f.source(),delegated=await f.delegate(root.event,[]);f.claim(delegated.peer);
  await f.execute(delegated.peer,'dsh_task',{goal:'核验原件。',attachmentIds:[]},'unfinished-worker');
  await expect(f.execute(delegated.peer,'companion_delegation',{operation:'result',message:'模型自称已经完成，但没有实际终态。'},'premature-result')).rejects.toThrow('实际Worker');
  expect(f.store.getTask(delegated.receipt.taskId)?.status).toBe('queued');expect(f.delegations.get(delegated.ticket.id)?.state).toBe('active');
});

it('forwards explicit original-chat supplemental guidance to the same bound peer ticket without creating another proxy',async()=>{
  const f=await fixture(),root=await f.source(),delegated=await f.delegate(root.event,[]);
  const result=await f.execute(root.event,'companion_delegation',{operation:'send',delegationId:delegated.ticket.id,message:'用户补充：只使用税后金额。'},'supplement');expect(result).toMatchObject({accepted:true,taskId:delegated.receipt.taskId});
  const rows=f.store.taskTransaction(sql=>sql.prepare("SELECT id FROM bot_inbox WHERE conversation_id=? AND id<>? ORDER BY sequence").all(delegated.peer.conversationId,delegated.peer.id)) as Array<{id:string}>;
  expect(rows).toHaveLength(1);const update=f.store.getEvent(rows[0]!.id)!;expect(update.content).toContain('只使用税后金额');expect(f.delegations.forEvent(update)?.id).toBe(delegated.ticket.id);expect(f.store.listTasks()).toHaveLength(1);
});

it('explicitly refuses unsupported supplemental attachment IDs instead of claiming a successful file delivery',async()=>{
  const f=await fixture(),file=path.join(f.root,'later-input.txt');await writeFile(file,'后来明确选择的补充材料');const [ref]=await f.media.importFiles({conversationId:f.room.id,paths:[file]});
  const root=await f.source('请让 Bob 核验，稍后再补充材料。',[ref!.id]),delegated=await f.delegate(root.event,[]);
  await expect(f.execute(root.event,'companion_delegation',{operation:'send',delegationId:delegated.ticket.id,message:'请加入这一份补充材料。',attachmentIds:[ref!.id]},'unsupported-file-supplement')).rejects.toThrow(/附件|文字/u);
  const updates=f.store.taskTransaction(sql=>sql.prepare("SELECT id FROM bot_inbox WHERE conversation_id=? AND id<>? AND source='companion'").all(delegated.peer.conversationId,delegated.peer.id));expect(updates).toEqual([]);
});

it('projects a recipient Worker question as a durable original-router event and forwards its factual supplement along the original delegation',async()=>{
  const f=await fixture(),root=await f.source(),delegated=await f.delegate(root.event,[]);f.store.settle({eventId:root.event.id,leaseToken:root.claim.leaseToken,status:'done',content:'已委派给 Bob。'});
  f.claim(delegated.peer);const worker=await f.execute(delegated.peer,'dsh_task',{goal:'核验发票政策。',attachmentIds:[]},'question-worker') as {taskId:string};
  const task=f.store.updateTask(worker.taskId,{status:'running'}),callId='ask-tax';
  f.taskRuntime.question(task,{callId,questionId:'question-'+createHash('sha256').update(`work-${task.id}:${callId}`).digest('hex').slice(0,48),questions:[{id:'tax',question:'政策使用税前还是税后金额？'}]});
  f.controller.refreshDelegations();expect(f.store.getTask(delegated.receipt.taskId)?.status).toBe('waiting');
  const fact=f.store.taskTransaction(sql=>sql.prepare("SELECT id FROM bot_inbox WHERE companion_id='alice' AND json_extract(payload_json,'$.delegationId')=? ORDER BY sequence DESC LIMIT 1").get(delegated.ticket.id)) as {id:string};
  const event=f.store.getEvent(fact.id)!;expect(event.source).toBe('task');expect(event.content).toContain('税前还是税后');f.claim(event);
  const result=await f.execute(event,'companion_delegation',{operation:'send',delegationId:delegated.ticket.id,message:'原始政策中明确使用税后金额，请按税后计算。'},'answer-known-fact');expect(result).toMatchObject({accepted:true});
  const events=f.store.taskTransaction(sql=>sql.prepare("SELECT id FROM bot_inbox WHERE conversation_id=? AND id<>? AND source='companion' ORDER BY sequence").all(delegated.peer.conversationId,delegated.peer.id)) as Array<{id:string}>;
  expect(events).toHaveLength(1);expect(f.delegations.forEvent(f.store.getEvent(events[0]!.id)!)?.id).toBe(delegated.ticket.id);expect(f.store.listTasks()).toHaveLength(2);
});

it('freezes the proxy and only its recipient Workers on a user pause, then resumes the same identities',async()=>{
  const f=await fixture(),root=await f.source(),delegated=await f.delegate(root.event,[]);f.claim(delegated.peer);
  const worker=await f.execute(delegated.peer,'dsh_task',{goal:'核验原件',attachmentIds:[]},'pause-worker') as {taskId:string};
  await f.controller.controlTask(f.store.getTask(delegated.receipt.taskId)!,'pause',undefined,'user-pause',{caller:'user'});
  expect(f.store.getTask(worker.taskId)?.status).toBe('paused');expect(f.store.getTask(delegated.receipt.taskId)?.status).toBe('paused');expect(f.delegations.allowsWork(delegated.peer)).toBe(false);
  await f.controller.controlTask(f.store.getTask(delegated.receipt.taskId)!,'resume_paused',undefined,'user-resume',{caller:'user'});
  expect(f.store.getTask(worker.taskId)?.status).toBe('queued');expect(f.store.getTask(delegated.receipt.taskId)?.status).toBe('running');expect(f.delegations.allowsWork(delegated.peer)).toBe(true);expect(f.store.listTasks()).toHaveLength(2);
});

async function publishWestInCurrentResultTurn(f:Awaited<ReturnType<typeof completedRoundTrip>>){
  const directory=f.controller.taskWorkdir(f.task,f.event.securityDomainId);await mkdir(directory,{recursive:true});
  const bytes='WEST_SAME_EVENT_VERIFIED_OUTPUT\nnet=207.00\n';await writeFile(path.join(directory,'west.csv'),bytes);
  const sent=await f.execute(f.event,'chat_send_file',{taskId:f.task.id,path:'west.csv',caption:'当前回执轮次发布核验文件。'},'publish-west-current-turn') as {messageId:string;attachmentIds:string[]};
  const ref=f.store.getMessage(sent.messageId)!.attachments![0]!;return{...sent,ref,bytes};
}

it('returns a real chat_send_file output published in the same recipient task_done turn beyond its frozen input watermark',async()=>{
  const f=await completedRoundTrip(),west=await publishWestInCurrentResultTurn(f),message=f.store.getMessage(west.messageId)!;
  expect(message.sequence).toBeGreaterThan(f.event.sourceMessageSequence);
  expect(f.store.modelAttachmentGrants(f.event,{ids:west.attachmentIds,throughSourceSequence:f.event.sourceMessageSequence})).toEqual([]);
  expect(f.store.modelAttachmentGrants(f.event,{ids:west.attachmentIds,throughSourceSequence:f.event.sourceMessageSequence,ownPublicationsFromEventId:f.event.id}).map(item=>item.ref)).toEqual([west.ref]);
  const listed=await f.execute(f.event,'chat_list_files',{}) as {files:Array<{id:string}>};expect(listed.files.map(file=>file.id)).toContain(west.ref.id);
  const result=await f.execute(f.event,'companion_delegation',{operation:'result',message:'当前轮次实际发布 west.csv，内容已经核验。',attachmentIds:west.attachmentIds},'return-west') as {messageId:string};
  const returned=f.store.getMessage(result.messageId)!.attachments![0]!;expect(returned.name).toBe('west.csv');expect(returned.sha256).toBe(west.ref.sha256);
  expect(await readFile((await f.media.getForAgent(f.room.id,returned.id)).path,'utf8')).toBe(west.bytes);
});

it('keeps later foreign events, user files and peer files outside the watermark and rejects a withdrawn same-turn publication',async()=>{
  const f=await completedRoundTrip(),west=await publishWestInCurrentResultTurn(f),refs=[];
  for(const [senderId,name] of [['alice','later-peer-file.txt'],['bob','later-other-event-file.txt']] as const){
    const file=path.join(f.profileRoot,name);await writeFile(file,'UNSEEN_LATER_'+senderId);const [ref]=await f.media.importFiles({conversationId:f.delegated.peer.conversationId,paths:[file]});refs.push(ref!);
    const delivered=f.store.enqueue({conversationId:f.delegated.peer.conversationId,senderId,source:'companion',recipientIds:[],content:'水位之后的独立消息。',sourceMessageId:'later-'+senderId,
      attachments:[ref!],sourceIds:[f.delegated.peer.id]});expect(delivered.message.sequence).toBeGreaterThan(f.event.sourceMessageSequence);
  }
  const userPath=path.join(f.profileRoot,'later-user-input.txt');await writeFile(userPath,'UNSEEN_OTHER_ROOM_USER');const [userRef]=await f.media.importFiles({conversationId:f.room.id,paths:[userPath]});
  f.store.enqueue({conversationId:f.room.id,senderId:'user',content:'原聊天水位之后的新用户文件。',sourceMessageId:'later-user',attachments:[userRef!]});
  const visible=f.store.modelAttachmentGrants(f.event,{all:true,throughSourceSequence:f.event.sourceMessageSequence,ownPublicationsFromEventId:f.event.id}).map(item=>item.ref.id);
  expect(visible).toContain(west.ref.id);for(const ref of [...refs,userRef!])expect(visible).not.toContain(ref.id);
  expect(()=>f.store.modelAttachmentGrants(f.event,{all:true,throughSourceSequence:f.event.sourceMessageSequence,ownPublicationsFromEventId:f.root.event.id})).toThrow('身份不匹配');
  await expect(f.execute(f.event,'chat_send_file',{attachmentId:refs[0]!.id},'cannot-forward-later-peer')).rejects.toThrow('尚未在当前聊天分享');
  f.store.withdrawSources('bob',f.event.securityDomainId,[west.messageId]);
  expect(f.store.modelAttachmentGrants(f.event,{ids:west.attachmentIds,all:true,throughSourceSequence:f.event.sourceMessageSequence,ownPublicationsFromEventId:f.event.id})).toEqual([]);
  await expect(f.execute(f.event,'companion_delegation',{operation:'result',message:'不应返回已撤回产物。',attachmentIds:west.attachmentIds},'withdrawn-west-result')).rejects.toThrow(/撤回|失效|停止/u);
  expect(f.store.publicationsForTask(f.delegated.receipt.taskId)).toEqual([]);
});

it('reminds a completed real delegation at most twice and never treats ordinary peer chat as delivery',async()=>{
  const f=await completedRoundTrip();
  const response=await f.execute(f.event,'message_peer',{companionId:'alice',content:'计算完成，普通聊天不能替代交付。'},'wrong-delivery');
  expect(response).toMatchObject({sent:false,requiredNextAction:'companion_delegation.result'});
  for(let i=0;i<5;i++)f.controller.remindDelegationReturn(f.event);
  const reminders=f.store.taskTransaction(sql=>sql.prepare("SELECT id FROM bot_inbox WHERE source_message_id LIKE ?").all(`delegation-return-reminder:${f.delegated.ticket.id}:%`)) as Array<{id:string}>;
  expect(reminders).toHaveLength(2);
  for(const row of reminders){const event=f.store.getEvent(row.id)!;expect(f.delegations.forEvent(event)?.id).toBe(f.delegated.ticket.id);}
  const count=f.store.listTasks().length;
  await f.execute(f.event,'companion_delegation',{operation:'result',message:f.reportText},'return-real');
  f.controller.remindDelegationReturn(f.event);
  expect(f.store.listTasks()).toHaveLength(count);expect(f.delegations.get(f.delegated.ticket.id)?.state).toBe('completed');
  expect(f.store.getMetadata(`delegation-return-reminders:${f.delegated.ticket.id}`)).toBe('2');
});
