import {expect,it,vi} from 'vitest';
const bridgePath='../../resources/dsh-bridge/index.js';
async function fixture(){
  const {deliverBotGuidance}=await import(bridgePath);
  const receipts=new Map<string,Record<string,unknown>>(),inbox:{id:string}[]=[],events:Array<{type:string;data:{id:string}}>=[];
  const record={bot:{eventId:'event',audience:{conversationId:'room'}},status:'running',revision:0,agent:{session:{snapshotEvents:()=>events},inbox:{nextTurn:[],nextStep:inbox},steer:vi.fn((message:{id:string})=>inbox.push(message)),followup:vi.fn()}};
  const effects={read:async(key:string)=>receipts.get(key),write:async(receipt:Record<string,unknown>)=>{receipts.set(String(receipt.eventId),receipt);},flush:vi.fn(async()=>{}),freezeMessage:(message:object)=>message};
  const input={eventId:'event',messageId:'message',text:'补充实际资料',mode:'steer'};
  return{record,receipts,effects,input,send:()=>deliverBotGuidance(record,input,effects)};
}
it('delivers once and reconciles a lost response after the task has completed',async()=>{
  const f=await fixture();expect(await f.send()).toEqual({accepted:true});f.record.status='succeeded';
  expect(await f.send()).toEqual({accepted:true});expect(f.record.agent.steer).toHaveBeenCalledOnce();
});
it('reconciles a prepared native inbox admission before declaring a completed task unavailable',async()=>{
  const f=await fixture();let failed=true;f.effects.flush.mockImplementation(async()=>{if(failed)throw Error('flush response lost');});
  await expect(f.send()).rejects.toThrow('lost');f.record.status='succeeded';failed=false;
  expect(await f.send()).toEqual({accepted:true});expect(f.record.agent.steer).toHaveBeenCalledOnce();
});
it('confirms non-admission when the original task ended and prevents ID reuse with changed content',async()=>{
  const f=await fixture();f.record.status='succeeded';expect(await f.send()).toEqual({accepted:false});expect(f.record.agent.steer).not.toHaveBeenCalled();
  f.record.status='running';await f.send();f.input.text='不同内容';await expect(f.send()).rejects.toThrow('different content');
});
