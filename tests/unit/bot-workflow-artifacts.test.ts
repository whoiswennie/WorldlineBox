import {afterEach,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {BotStore} from '../../src/main/companion-bot/store';
import {BotWorkflowRuntime} from '../../src/main/companion-bot/workflow-runtime';
import type {BotMediaRef} from '../../src/shared/companion-bot-media';

const stores:BotStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
function fixture(){
  const store=new BotStore(':memory:');stores.push(store);store.createCompanion({id:'alice',name:'Alice',persona:'分阶段核验明确原件。'});store.createCompanion({id:'bob',name:'Bob',persona:'另一角色。'});
  const room=store.openDirect('alice'),source=store.enqueue({conversationId:room.id,senderId:'user',sourceMessageId:'artifact-root',content:'请分别核算与审计，再基于两份真实结果汇总。'}).events[0]!;
  const workflows=new BotWorkflowRuntime(store),plan=workflows.create(source,'create','核算与审计汇总',[
    {key:'finance',title:'核算',dependsOn:[]},{key:'audit',title:'审计',dependsOn:[]},{key:'merge',title:'汇总',dependsOn:['finance','audit']},
  ]).plans[0]!;
  const stage=(key:string,files:string[]=[])=>{
    const task=store.createTask({id:key+'-task',conversationId:room.id,companionId:'alice',sourceEventId:source.id,goal:'只处理已选择的当前任务资料。',extra:{workflowId:plan.id,workflowStage:key,nativeAttempted:true}});
    workflows.bind(source,task,plan.id,key);store.updateTask(task.id,{status:'running'});
    const refs:BotMediaRef[]=files.map(name=>({id:key+'-'+name,name:name+'.txt',mimeType:'text/plain',size:name.length,sha256:createHash('sha256').update(name).digest('hex'),kind:'file',url:'worldlinebox://fixture/'+key+'/'+name}));
    if(refs.length)store.publishForTask(task.id,'real-output',{content:'任务已实际发送以下产物。',attachments:refs});
    store.updateTask(task.id,{status:'succeeded',summary:key+' 的真实已核验结果。'});workflows.observedResult(source,store.getTask(task.id)!);return{task:store.getTask(task.id)!,refs};
  };
  return{store,room,source,workflows,plan,stage};
}

it('requires at least one explicitly selected real output from each file-producing prerequisite',()=>{
  const f=fixture(),finance=f.stage('finance',['ledger','notes']),audit=f.stage('audit',['audit']);
  expect(()=>f.workflows.requireDependencyArtifacts(f.source,f.plan.id,'merge',[])).toThrow(finance.task.id);
  expect(()=>f.workflows.requireDependencyArtifacts(f.source,f.plan.id,'merge',[finance.refs[0]!.id])).toThrow(audit.task.id);
  expect(()=>f.workflows.requireDependencyArtifacts(f.source,f.plan.id,'merge',[audit.refs[0]!.id])).toThrow(finance.task.id);
  expect(()=>f.workflows.requireDependencyArtifacts(f.source,f.plan.id,'merge',[finance.refs[1]!.id,audit.refs[0]!.id])).not.toThrow();
  expect(()=>f.workflows.requireDependencyArtifacts(f.source,f.plan.id,'merge',[finance.refs[0]!.id,finance.refs[1]!.id])).toThrow(/可选 outputs.*audit-audit/u);
  expect(f.store.listTasks()).toHaveLength(2);
});

it('allows summary-only prerequisites without inventing or implicitly attaching a file',()=>{
  const f=fixture();f.stage('finance');f.stage('audit');
  const selected:string[]=[];expect(()=>f.workflows.requireDependencyArtifacts(f.source,f.plan.id,'merge',selected)).not.toThrow();expect(selected).toEqual([]);
});

it('rejects a different task artifact as a substitute even when it is visible in the same conversation',()=>{
  const f=fixture(),finance=f.stage('finance',['own-result']);f.stage('audit');
  const unrelated=f.store.createTask({id:'unrelated',conversationId:f.room.id,companionId:'alice',sourceEventId:f.source.id,goal:'独立任务',extra:{nativeAttempted:true}});f.store.updateTask(unrelated.id,{status:'running'});
  const foreign:BotMediaRef={...finance.refs[0]!,id:'other-task-file',name:'other-task.txt'};f.store.publishForTask(unrelated.id,'unrelated-output',{attachments:[foreign]});
  expect(f.store.modelAttachments(f.source,{ids:[foreign.id]})).toEqual([foreign]);
  expect(()=>f.workflows.requireDependencyArtifacts(f.source,f.plan.id,'merge',[foreign.id])).toThrow(finance.task.id);
  expect(()=>f.workflows.requireDependencyArtifacts(f.source,f.plan.id,'merge',[finance.refs[0]!.id])).not.toThrow();
});

it('retains ready, observation, plan scope and original-authorization gates before considering artifact IDs',()=>{
  const f=fixture(),finance=f.stage('finance',['own-result']),audit=f.stage('audit');
  const other=f.store.openDirect('bob'),event=f.store.enqueue({conversationId:other.id,senderId:'user',content:'另一个角色',sourceMessageId:'bob-root'}).events[0]!;
  expect(()=>f.workflows.requireDependencyArtifacts(event,f.plan.id,'merge',[finance.refs[0]!.id])).toThrow('不属于');
  f.store.updateTask(audit.task.id,{summary:'审计结果有新版本，需重新阅读。'});
  expect(()=>f.workflows.requireDependencyArtifacts(f.source,f.plan.id,'merge',[finance.refs[0]!.id])).toThrow('读取');
  f.workflows.observedResult(f.source,f.store.getTask(audit.task.id)!);f.workflows.cancel(f.source,f.plan.id);
  expect(()=>f.workflows.requireDependencyArtifacts(f.source,f.plan.id,'merge',[finance.refs[0]!.id])).toThrow('停止');
});

it('does not require files for a source stage and refuses malformed or oversized automatic selections',()=>{
  const f=fixture();expect(()=>f.workflows.requireDependencyArtifacts(f.source,f.plan.id,'finance',[])).not.toThrow();
  expect(()=>f.workflows.requireDependencyArtifacts(f.source,f.plan.id,'finance',Array(65).fill('one'))).toThrow();
});
