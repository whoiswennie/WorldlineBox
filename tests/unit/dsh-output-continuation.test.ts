import { expect, it } from 'vitest';
const bridgePath='../../resources/dsh-bridge/index.js';
it('continues a native checkpoint exactly once across command retries and a flush interruption',async()=>{
  const {continueBotOutput}=await import(bridgePath),inbox:{id:string}[]=[],events:unknown[]=[];
  let receipt:Record<string,unknown>={status:'complete',result:{status:'failed',outputCheckpoint:77}},fail=true;
  const agent={session:{snapshotEvents:()=>events},inbox:{nextTurn:inbox,nextStep:[]},followup:(message:{id:string})=>inbox.push(message)};
  const record={bot:{eventId:'e'},agent,status:'failed',revision:0};
  const hooks={read:async()=>receipt,write:async(value:Record<string,unknown>)=>{receipt=value;},flush:async()=>{if(fail)throw Error('simulated disk interruption');},freezeMessage:(message:unknown)=>message};
  const input={eventId:'e',continueAfterSeq:77};
  await expect(continueBotOutput(record,input,hooks)).rejects.toThrow('disk interruption');expect(inbox).toHaveLength(1);
  fail=false;await expect(continueBotOutput(record,input,hooks)).resolves.toEqual({accepted:true});expect(inbox).toHaveLength(1);
  expect(inbox[0]!.id).toBe('worldlinebox-bot-output-continuation:e:77');
  receipt={status:'complete',continuedFrom:77,result:{status:'succeeded',text:'done'}};
  expect(await continueBotOutput(record,input,hooks)).toMatchObject({result:{status:'succeeded'}});expect(inbox).toHaveLength(1);
  await expect(continueBotOutput(record,{eventId:'e',continueAfterSeq:99},hooks)).rejects.toThrow('stale');
});
