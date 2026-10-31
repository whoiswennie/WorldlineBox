import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CompanionVcpRuntime } from '../../src/main/companions/vcp-runtime';
import type { VcpMemoryCommand, VcpMemoryPluginConfiguration } from '../../src/main/vcp-memory/contracts';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
vi.mock('electron',()=>({utilityProcess:{fork:vi.fn()}}));
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const storage=(root:string)=>async(ownerId:string)=>{const workspaceRoot=path.resolve(root),ownerRoot=path.join(workspaceRoot,ownerId);return{ownerId,workspaceRoot,ownerRoot,indexRoot:path.join(ownerRoot,'.运行', '索引'),ownerPrompts:{aimemoTemplate:'fixture {{knowledge_base}}',timelineTemplate:'fixture {{agentName}} {{month}}',summaryTemplate:'fixture summary {{agentName}} {{month}}'}};};
const embedding={baseUrl:'http://127.0.0.1',model:'localfixture',dimension:4,apiKey:'local',modelSignature:'actual-profile'};
describe('owner runtime actual transport and cleanup',()=>{
  it('stops a current core historical view before deleting its directory while leaving the peer running and resolving no model',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'worldline-owner-hot-purge-')),exited:string[]=[],sent:string[]=[];
    const resolveEmbedding=vi.fn(async()=>embedding);
    const launch=()=>{const events=new EventEmitter();let scope='',done=false;const exit=()=>{if(done)return;done=true;exited.push(scope);events.emit('exit',0);};
      return {on:events.on.bind(events),kill:exit,postMessage(message:unknown){const envelope=message as {requestId:string;command:VcpMemoryCommand};
        if(envelope.command.type==='initialize')scope=envelope.command.configuration.scope.scopeId;
        sent.push(scope+':'+envelope.command.type);events.emit('message',{requestId:envelope.requestId,ok:true,value:[]});if(envelope.command.type==='close')exit();}};};
    const service=new CompanionVcpRuntime({resolveOwnerStorage:storage(root),resolveOwnerCleanupStorage:storage(root),vendorRoot:'unused',workerPath:'unused',resolveEmbedding,launch});
    try{
      const core=await service.get({ownerId:'alice'}),peer=await service.get({ownerId:'bob'});await core.client.list({scopeId:'historical-alice'});await peer.client.list({scopeId:'peer-bob'});
      const alice=path.join(root,'alice','.运行', '索引','hot',hash(core.profileKey),hash('historical-alice')),bob=path.join(root,'bob','.运行', '索引','hot',hash(core.profileKey),hash('peer-bob'));
      await mkdir(alice,{recursive:true});await mkdir(bob,{recursive:true});await writeFile(path.join(alice,'sentinel'),'alice');await writeFile(path.join(bob,'sentinel'),'bob');
      resolveEmbedding.mockRejectedValue(new Error('encoder removed'));
      await service.purgeOwner('alice',{historicalViews:[{profileKey:core.profileKey,scopeId:'historical-alice'}]});
      expect(resolveEmbedding).toHaveBeenCalledTimes(2);expect(exited).toEqual(['historical-alice']);await expect(lstat(alice)).rejects.toMatchObject({code:'ENOENT'});
      expect(await readFile(path.join(bob,'sentinel'),'utf8')).toBe('bob');expect(peer.client.hasOpenScope({scopeId:'peer-bob'})).toBe(true);
      await peer.client.list({scopeId:'peer-bob'});expect(sent.filter(value=>value==='peer-bob:initialize')).toHaveLength(1);
    }finally{await service.close();await removeOwnedDirectory(root);}
  });
  it('refuses linked generation and legacy profile ancestors without touching their external files',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'worldline-owner-link-purge-')),external=await mkdtemp(path.join(tmpdir(),'worldline-owner-external-'));
    const resolver=vi.fn(async()=>{throw new Error('not configured');});
    const service=new CompanionVcpRuntime({resolveOwnerStorage:storage(root),resolveOwnerCleanupStorage:storage(root),vendorRoot:'unused',workerPath:'unused',resolveEmbedding:resolver});
    try{
      await mkdir(path.join(external,hash('alice')));await writeFile(path.join(external,hash('alice'),'sentinel'),'external survives');
      await mkdir(path.join(root,'alice','.运行', '索引'),{recursive:true});
      await symlink(external,path.join(root,'alice','.运行', '索引','generation'),process.platform==='win32'?'junction':'dir');
      await expect(service.purgeOwner('alice')).rejects.toThrow('文件夹');expect(await readFile(path.join(external,hash('alice'),'sentinel'),'utf8')).toBe('external survives');
      expect(resolver).not.toHaveBeenCalled();
    }finally{await service.close();await removeOwnedDirectory(root);await removeOwnedDirectory(external);}
  });
  it('disposes a route resolved after owner cancellation without constructing or spawning its client',async()=>{
    let finish!:(value:{plugins:VcpMemoryPluginConfiguration,dispose():Promise<void>})=>void,started!:()=>void;
    const startedPromise=new Promise<void>(resolve=>{started=resolve;}),dispose=vi.fn(async()=>undefined),launch=vi.fn();
    const service=new CompanionVcpRuntime({resolveOwnerStorage:storage(path.resolve('unused')),resolveOwnerCleanupStorage:storage(path.resolve('unused')),vendorRoot:'unused',workerPath:'unused',resolveEmbedding:async()=>embedding,launch,
      resolveGenerationPlugins:()=>{started();return new Promise(resolve=>{finish=resolve;});}});
    const acquiring=service.acquireGeneration({ownerId:'alice',config:{apiFormat:'openai_chat',model:'selected-model',baseUrl:'https://provider.invalid',apiKey:'private'}});
    const rejected=expect(acquiring).rejects.toThrow('取消');await startedPromise;await service.interruptOwner('alice');finish({plugins:{},dispose});await rejected;
    expect(dispose).toHaveBeenCalledOnce();expect(launch).not.toHaveBeenCalled();await service.close();
  });
});
