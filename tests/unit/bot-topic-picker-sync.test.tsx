// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotTopicPicker } from '../../src/renderer/companion-bot/BotTopicPicker';
import type { BotResponse } from '../../src/shared/companion-bot';
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let root:Root|undefined,host:HTMLDivElement;
afterEach(async()=>{await act(()=>root?.unmount());root=undefined;host?.remove();vi.useRealTimers();});
it('follows native renames and removals while open, retaining the previous list when disconnected',async()=>{
  let response:BotResponse={ok:true,topics:[{id:'actual',conversationId:'room',title:'原生会话',createdAt:'2026-11-11T08:00:00.000Z',updatedAt:'2026-11-11T08:00:00.000Z'}]};
  const request=vi.fn(async()=>response),refresh=async()=>undefined;
  vi.useFakeTimers();host=document.createElement('div');document.body.append(host);root=createRoot(host);
  await act(()=>root!.render(<BotTopicPicker conversationId="room" locale="zh-CN" request={request} refresh={refresh} onClose={()=>undefined}/>));
  await act(async()=>{await vi.advanceTimersByTimeAsync(1);});expect(host.querySelector('[title="原生会话"]')).toBeTruthy();
  response={...response,topics:[{...response.topics![0]!,title:'DSH 新名称'}]};
  await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});expect(host.querySelector('[title="DSH 新名称"]')).toBeTruthy();
  request.mockRejectedValueOnce(new Error('Disconnected'));
  await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});expect(host.querySelector('[role="status"]')?.textContent).toContain('上次确认');expect(host.querySelector('[title="DSH 新名称"]')).toBeTruthy();
  response={ok:true,topics:[]};await act(async()=>{await vi.advanceTimersByTimeAsync(1500);});expect(host.querySelector('[title="DSH 新名称"]')).toBeNull();
  await act(()=>root!.unmount());root=undefined;const reads=request.mock.calls.length;await act(async()=>{await vi.advanceTimersByTimeAsync(6000);});expect(request).toHaveBeenCalledTimes(reads);
});
