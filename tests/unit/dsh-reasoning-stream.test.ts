import { expect, it } from 'vitest';
import type { NativeHostEvent } from '../../src/main/dsh/native-host-client';
const bridgePath='../../resources/dsh-bridge/index.js';
it('publishes cumulative native thinking at a bounded rate and flushes the final fragment at the attempt boundary',async()=>{
  const {observeAssistantStream}=await import(bridgePath),record={id:'root'},events:NativeHostEvent[]=[];
  const publish=(event:NativeHostEvent)=>events.push(event);
  observeAssistantStream(record,'root',{type:'start',attemptId:'one',turn:1,step:1},publish,0);
  for(let i=0;i<50;i++)observeAssistantStream(record,'root',{type:'chunk',attemptId:'one',chunk:{type:'reasoning-delta',text:'字'}},publish,i);
  expect(events).toHaveLength(1);expect(events[0]!.text).toBe('字');
  observeAssistantStream(record,'root',{type:'end',attemptId:'one',outcome:{kind:'committed',eventType:'assistant/message'}},publish,51);
  expect(events).toHaveLength(2);expect(events[1]).toMatchObject({text:'字'.repeat(50),textMode:'snapshot',nativeSessionId:'root',nativeTurn:1,nativeStep:1,outputState:'committed'});
  expect(events[0]!.streamId).toBe(events[1]!.streamId);
});
it('isolates new attempts, abandoned attempts and child reasoning without promoting reasoning to the final body',async()=>{
  const {observeAssistantStream}=await import(bridgePath),record={id:'root'},events:NativeHostEvent[]=[];
  const publish=(event:NativeHostEvent)=>events.push(event);
  const begin=(id:string,attemptId:string)=>observeAssistantStream(record,id,{type:'start',attemptId,turn:1,step:1},publish,0);
  const think=(id:string,attemptId:string,text:string)=>observeAssistantStream(record,id,{type:'chunk',attemptId,chunk:{type:'reasoning-delta',text}},publish,0);
  begin('root','old');think('root','old','旧思考');
  observeAssistantStream(record,'root',{type:'end',attemptId:'old',outcome:{kind:'abandoned'}},publish,1);
  begin('root','new');begin('child','child-one');think('child','child-one','子思考');think('root','old','迟到的旧片段');think('root','new','新思考');
  expect(events.map(item=>item.text)).toEqual(['旧思考','旧思考','子思考','新思考']);
  expect(events[1]!.outputState).toBe('abandoned');
  expect(events[0]!.streamId).not.toBe(events[3]!.streamId);expect(events.every(item=>item.type==='reasoning')).toBe(true);
});
