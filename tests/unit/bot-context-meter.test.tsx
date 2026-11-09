// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {BotContextMeter} from '../../src/renderer/companion-bot/BotContextMeter';
import type {BotNativeContext} from '../../src/shared/companion-native-context';
import type {BotRequest,BotResponse} from '../../src/shared/companion-bot';
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let root:Root|undefined,host:HTMLDivElement;
afterEach(async()=>{await act(()=>root?.unmount());host?.remove();root=undefined;});
const stamp='2026-11-09T12:00:00Z',sample:BotNativeContext={source:'dsh-native-projections',state:'ready',sessionId:'session-a',sampledAt:stamp,asOfSeq:10,pressure:{pressureTokens:32000,projectedTokens:6000,contextWindow:128000},breakdown:{systemTokens:120,toolsTokens:21500,messageTokens:477000},usage:{uncachedInputTokens:500000,cacheReadTokens:900000,cacheWriteTokens:100000,outputTokens:80000}};
const compact=vi.fn(),newTopic=vi.fn();
type Overrides={id?:string;companionId?:string;cached?:BotNativeContext;canCompact?:boolean};
async function render(request:(input:BotRequest)=>Promise<BotResponse>,options:Overrides={}){
  if(!root){host=document.createElement('div');document.body.append(host);root=createRoot(host);compact.mockClear();newTopic.mockClear();}
  const id=options.id??'topic-a',companionId=options.companionId??'actor';await act(()=>root!.render(<BotContextMeter key={id+':'+companionId} conversationId="room" topic={{id,conversationId:'room',title:id,createdAt:stamp,updatedAt:stamp}} companionId={companionId} companionName="伙伴" cached={options.cached} locale="zh-CN" request={request} busy={false} canCompact={options.canCompact??true} onCompact={compact} onNew={newTopic}/>));
}
async function click(selector:string){await act(()=>host.querySelector<HTMLButtonElement>(selector)!.click());}
it('shows DSH occupancy and separate estimated composition and cumulative usage with direct actions',async()=>{
  await render(async()=>({ok:true,topicContext:{topicId:'topic-a',companionId:'actor',sample}}));
  expect(host.querySelector('.bot-context-trigger')?.textContent).toContain('5%');await click('.bot-context-trigger');
  expect(host.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('5');expect(host.querySelector('.bot-context-composition')?.textContent).toContain('工具定义');expect(host.querySelector('.bot-context-usage')?.textContent).toContain('缓存读取');
  expect(host.querySelector('.bot-context-note')?.textContent).toContain('不作为占用总和');await click('footer button');expect(compact).toHaveBeenCalledOnce();
});
it('never displays a fabricated zero percent for a new topic with no native session',async()=>{
  await render(async()=>({ok:true,topicContext:{topicId:'topic-a',companionId:'actor'}}));await click('.bot-context-trigger');
  expect(host.textContent).not.toContain('0%');expect(host.querySelector('[role=progressbar]')).toBeNull();expect(host.textContent).toContain('尚未返回');
});
it('keeps a delayed old-topic response out of the newly selected independent session',async()=>{
  let finish!:(value:BotResponse)=>void;
  const old=new Promise<BotResponse>(resolve=>{finish=resolve;}),next={...sample,sessionId:'session-b',pressure:{projectedTokens:64000,contextWindow:128000}};
  const request=async(input:BotRequest)=>input.type==='topic.context'&&input.topicId==='topic-a'?old:{ok:true,topicContext:{topicId:'topic-b',companionId:'actor',sample:next}};
  await render(request);await render(request,{id:'topic-b'});await act(()=>finish({ok:true,topicContext:{topicId:'topic-a',companionId:'actor',sample}}));
  expect(host.querySelector('.bot-context-trigger')?.textContent).toContain('50%');expect(host.textContent).not.toContain('5%');
});
it('accepts newer pushed statistics and labels a disconnected saved reading without replacing it with zero',async()=>{
  await render(async()=>({ok:true,topicContext:{topicId:'topic-a',companionId:'actor',sample,stale:true,error:'DSH未连接'}}),{cached:sample,canCompact:false});await click('.bot-context-trigger');
  expect(host.querySelector('[role=status]')?.textContent).toContain('上次保存');expect(host.querySelector<HTMLButtonElement>('footer button')?.disabled).toBe(true);
  const pushed={...sample,asOfSeq:20,pressure:{projectedTokens:64000,contextWindow:128000}};
  await render(async()=>({ok:true,topicContext:{topicId:'topic-a',companionId:'actor',sample,stale:true}}),{cached:pushed});expect(host.querySelector('.bot-context-trigger')?.textContent).toContain('50%');
});
it('switches to a different companion session within the same group topic without borrowing its peer usage',async()=>{
  const other={...sample,sessionId:'session-peer',asOfSeq:2,pressure:{projectedTokens:96000,contextWindow:128000}};
  const request=async(input:BotRequest)=>({ok:true,topicContext:{topicId:'topic-a',companionId:input.type==='topic.context'?input.companionId:'actor',sample:input.type==='topic.context'&&input.companionId==='peer'?other:sample}});
  await render(request,{cached:sample});expect(host.textContent).toContain('5%');await render(request,{companionId:'peer',cached:other});
  expect(host.querySelector('.bot-context-meter')?.getAttribute('data-native-context-session')).toBe('session-peer');expect(host.querySelector('.bot-context-trigger strong')?.textContent).toBe('75%');
});
