import { expect, it } from 'vitest';
import type { BotExecutionStep } from '../../src/shared/companion-bot';
import { appendBotExecutionStep, botExecutionRounds } from '../../src/shared/companion-bot-execution';
const at='2026-11-09T09:00:00Z';
const step=(id:number,type:string,patch:Partial<BotExecutionStep>={}):BotExecutionStep=>({id:String(id),sequence:id,type,at,nativeSessionId:'root',nativeTurn:1,nativeStep:1,...patch});
it('coalesces thousands of thinking deltas into one complete phase, while snapshots replace rather than repeat content',()=>{
  let steps:BotExecutionStep[]=[];
  for(let i=1;i<=2000;i++)steps=appendBotExecutionStep(steps,step(i,'reasoning',{text:'想',streamId:'attempt-one'}));
  expect(steps).toHaveLength(1);expect(steps[0]!.text).toBe('想'.repeat(2000));
  const settled=step(2001,'reasoning',{text:'完整的最终思考内容',textMode:'snapshot',streamId:'attempt-one',outputState:'committed'});
  steps=appendBotExecutionStep(steps,settled);steps=appendBotExecutionStep(steps,settled);
  expect(steps).toHaveLength(1);expect(steps[0]!.text).toBe('完整的最终思考内容');
});
it('keeps loop steps, retry attempts and parallel child sessions distinct and pairs tools by native call id',()=>{
  let steps:BotExecutionStep[]=[];
  const updates=[
    step(1,'status',{stage:'step_start'}),
    step(2,'reasoning',{text:'父会话',streamId:'parent-a'}),
    step(3,'reasoning',{text:'子会话',streamId:'child-a',nativeSessionId:'child'}),
    step(4,'reasoning',{text:'完整父会话',textMode:'snapshot',streamId:'parent-a'}),
    step(5,'tool_call',{callId:'read-a',toolName:'read',text:'input-a'}),
    step(6,'tool_call',{callId:'read-b',toolName:'read',text:'input-b'}),
    step(7,'tool_result',{callId:'read-a',text:'result-a'}),
    step(8,'tool_result',{callId:'read-b',text:'result-b'}),
    step(9,'status',{stage:'step_start',nativeStep:2}),
    step(10,'reasoning',{nativeStep:2,text:'重试前',streamId:'attempt-b',outputState:'abandoned'}),
    step(11,'reasoning',{nativeStep:2,text:'重试后',streamId:'attempt-c'}),
  ];
  for(const update of updates)steps=appendBotExecutionStep(steps,update);
  const rounds=botExecutionRounds(steps);
  expect(rounds.map(round=>[round.sessionId,round.step,round.steps.length])).toEqual([['root',1,3],['child',1,1],['root',2,2]]);
  expect(rounds[0]!.steps[0]!.text).toBe('完整父会话');
  expect(rounds[0]!.steps.filter(item=>item.type==='tool_call').map(item=>[item.text,item.output])).toEqual([['input-a','result-a'],['input-b','result-b']]);
});
it('repairs the display of already-saved fragmentary traces without rewriting history',()=>{
  const old:BotExecutionStep[]=[
    {id:'start',type:'status',at,summary:'开始处理任务'},
    {id:'loop',type:'status',at,summary:'开始第 1 步处理'},
    {id:'r1',type:'reasoning',at,text:'用户'},
    {id:'r2',type:'reasoning',at,text:'让我'},
    {id:'r3',type:'reasoning',at,text:'自我介绍'},
    {id:'end',type:'status',at,summary:'第 1 步处理结束'},
  ];
  expect(botExecutionRounds(old)).toMatchObject([{step:1,steps:[{type:'reasoning',text:'用户让我自我介绍'}]}]);
  expect(old).toHaveLength(6);expect(old[2]!.text).toBe('用户');
});
it('coalesces child output snapshots and keeps repeated legacy loop numbers in separate rounds',()=>{
  let steps:BotExecutionStep[]=[];
  for(const [index,text] of ['子','子会话','子会话正文'].entries())steps=appendBotExecutionStep(steps,step(index+1,'child_text_stream',{nativeSessionId:'child',streamId:'child-output',text}));
  steps=appendBotExecutionStep(steps,step(4,'child_text',{nativeSessionId:'child',streamId:'child-output',text:'最终子会话正文',outputState:'committed'}));
  expect(steps).toHaveLength(1);expect(steps[0]!.text).toBe('最终子会话正文');
  const legacy:BotExecutionStep[]=[{id:'a',type:'status',at,summary:'开始第 1 步处理'},{id:'b',type:'reasoning',at,text:'第一轮'},
    {id:'c',type:'status',at,summary:'开始第 1 步处理'},{id:'d',type:'reasoning',at,text:'第二轮'}];
  expect(botExecutionRounds(legacy).map(round=>round.steps[0]!.text)).toEqual(['第一轮','第二轮']);
});
it('accepts a continued native host generation even when its transport sequence restarts at zero',()=>{
  const first=appendBotExecutionStep([],step(100,'reasoning',{streamGeneration:'old-host',streamId:'old',text:'原会话进展'}));
  const continued=appendBotExecutionStep(first,step(0,'reasoning',{streamGeneration:'new-host',streamId:'new',nativeTurn:2,text:'继续后的新进展'}));
  expect(continued.map(item=>item.text)).toEqual(['原会话进展','继续后的新进展']);
});
