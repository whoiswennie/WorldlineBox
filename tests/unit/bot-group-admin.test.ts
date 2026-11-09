import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshRun, type BotDshCancelAck } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { botRequestSchema } from '../../src/shared/companion-bot';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
class Memory extends BotMemoryService{
  constructor(root:string){super({root,runtime:async()=>{throw Error('No native VCP in group administration test.');},embedding:async()=>{throw Error('No embedding inference.');}});}
  override async withdrawnSources(){return{revision:'0',sourceEventIds:[],sourceMessageIds:[]};}
  override async appendHistory(){return{appended:[]};}
  override async prepareTurn(input:Parameters<BotMemoryService['prepareTurn']>[0]):Promise<BotMemoryPrepared>{return{requestId:input.requestId,scope:input.scope,inputHash:'group-admin',messages:input.messages,metadata:{},events:[],evidence:'',status:'ready',omittedChars:0};}
  override async finishTurn(){return{recorded:true};}
}
class Brain extends BotDshBrain{
  controls:BotDshRun[]=[];
  modelCalls=0;
  proof:(input:Omit<BotDshRun,'prompt'|'onEvent'>)=>Promise<BotDshCancelAck>=async input=>({accepted:false,absent:true,sessionId:BotDshBrain.sessionId(input.laneId),eventId:input.eventId});
  constructor(){super({getHost:async()=>{throw Error('Group test never starts DSH.');}});}
  override async cancelDurable(input:Omit<BotDshRun,'prompt'|'onEvent'>){this.controls.push({...input,prompt:''});return this.proof(input);}
  override async run():Promise<never>{this.modelCalls++;throw Error('Group administration never asks a model to execute.');}
  override async archive(){}
  override async close(){}
}
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'wlb-group-admin-')),brain=new Brain();
  const service=new BotService({root,brain,memory:new Memory(path.join(root,'memory')),model:()=>{throw Error('No model configured.');},onEvent:()=>undefined});
  await service.handle({type:'state'});
  for(const id of ['alice','bob','carol'])service.store.createCompanion({id,name:id,persona:'只处理授权资料。'});
  cleanups.push(async()=>{await service.shutdown();if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('wlb-group-admin-'))throw Error('Unsafe group fixture cleanup.');await rm(root,{recursive:true,force:true});});
  const room=service.store.createGroup({title:'用户管理的群',memberIds:['alice','bob'],participationMode:'all'});
  let sequence=0;
  const source=(recipient='alice')=>{const event=service.store.enqueue({conversationId:room.id,senderId:'user',recipientIds:[recipient],sourceMessageId:`group-admin-${++sequence}`,content:'这个群中的授权目标。'}).events[0]!;
    const claim=service.store.claim({workerId:'admin-fixture'});if(claim?.event.id!==event.id)throw Error('Wrong source claim.');return{event,claim};};
  return{root,service,store:service.store,brain,room,source};
}

it('keeps the user as group owner, validates partners, and applies an idempotent complete member list only to this group',async()=>{
  const f=await fixture(),direct=f.store.openDirect('carol');
  expect(f.room).toMatchObject({ownerId:'user'});
  await f.service.handle({type:'conversation.members',conversationId:f.room.id,memberIds:['bob','carol']});
  const changed=f.store.getConversation(f.room.id)!;expect(changed.memberIds).toEqual(['bob','carol','user']);expect(changed.revision).toBe(f.room.revision+1);
  await f.service.handle({type:'conversation.members',conversationId:f.room.id,memberIds:['user','carol','bob','bob']});
  expect(f.store.getConversation(f.room.id)!.revision).toBe(changed.revision);
  await expect(f.service.handle({type:'conversation.members',conversationId:f.room.id,memberIds:['user']})).rejects.toThrow('群主不能移除');
  await expect(f.service.handle({type:'conversation.members',conversationId:f.room.id,memberIds:['missing']})).rejects.toThrow('有效伙伴');
  await expect(f.service.handle({type:'conversation.members',conversationId:direct.id,memberIds:['alice']})).rejects.toThrow('群主');
  expect(f.store.getConversation(direct.id)).toEqual(direct);
  expect(botRequestSchema.safeParse({type:'conversation.members',conversationId:f.room.id,memberIds:[]}).success).toBe(false);
});

it('archives a dissolved room, retains history, blocks every old access path, and does not resurrect it through group reuse',async()=>{
  const f=await fixture(),original=f.source();f.store.settle({eventId:original.event.id,leaseToken:original.claim.leaseToken,status:'done',content:'保留的历史'});
  const before=f.store.messagesPage(f.room.id).items.length,direct=f.store.openDirect('carol');
  const media=new BotMediaService({root:path.join(f.root,'media'),builtinRoot:path.resolve('resources/bot-stickers'),canUserAccessConversation:id=>{const room=f.store.getConversation(id);return!!room&&!room.dissolvedAt&&room.memberIds.includes('user');}});
  const input=path.join(f.root,'notes.md');await writeFile(input,'# 保留原件\n用户拥有群聊。');const [ref]=await media.importFiles({conversationId:f.room.id,paths:[input]});
  expect((await media.response(new Request(ref!.url))).status).toBe(200);expect((await media.readTextPage({conversationId:f.room.id,id:ref!.id})).content).toContain('保留原件');
  await f.service.handle({type:'conversation.dissolve',conversationId:f.room.id});
  const dissolved=f.store.getConversation(f.room.id)!;expect(dissolved).toMatchObject({ownerId:'user',dissolvedAt:expect.any(String),memberIds:[]});
  expect(f.store.conversations().some(room=>room.id===f.room.id)).toBe(false);expect(f.store.messagesPage(f.room.id).items).toHaveLength(before);
  expect((await media.response(new Request(ref!.url))).status).toBe(403);await expect(media.readTextPage({conversationId:f.room.id,id:ref!.id})).rejects.toThrow('权限已撤销');
  for(const type of ['state','history.search'] as const)await expect(f.service.handle({type,conversationId:f.room.id} as Parameters<BotService['handle']>[0])).rejects.toThrow('已解散');
  expect(()=>f.store.enqueue({conversationId:f.room.id,senderId:'user',content:'不得复活'})).toThrow('已经解散');
  await expect(f.service.handle({type:'conversation.dissolve',conversationId:f.room.id})).rejects.toThrow('已解散');expect(f.store.getConversation(f.room.id)!.revision).toBe(dissolved.revision);
  const replacement=f.store.createGroup({title:f.room.title,memberIds:['alice','bob']});expect(replacement.id).not.toBe(f.room.id);expect(f.store.getConversation(direct.id)).toEqual(direct);
});
