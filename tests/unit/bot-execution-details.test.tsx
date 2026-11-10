// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { BotExecution, BotMessage } from '../../src/shared/companion-bot';
import { BotMessageBody } from '../../src/renderer/companion-bot/BotMessageBody';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
const message: BotMessage = { id: 'reply', eventId: 'event', conversationId: 'room', senderId: 'fish', senderName: '大肥鱼', status: 'running', content: '', sequence: 2, createdAt: '2026-11-09T06:00:00Z' };
const execution: BotExecution = { sessionId: 'fresh-dsh-session', status: 'running', steps: [{ id: '1', type: 'tool_call', summary: '正在读取资料', toolName: 'read_file', text: '原始工具调用内容', at: message.createdAt }] };
afterEach(async () => { await act(() => root?.unmount()); root = undefined; host?.remove(); });
async function render(item: BotMessage, answer = vi.fn(async () => ({ ok: true })),proceed?:(requestId:string)=>Promise<{ok:boolean;error?:string}>) {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(() => root!.render(<BotMessageBody message={item} streamedText="流式正文" statusText="正在回复" locale="zh-CN" onAnswer={answer} onContinue={proceed} />));
  return answer;
}
it('keeps necessary live controls outside the bubble and removes completed execution chrome', async () => {
  await render({ ...message, execution });
  expect(host.querySelector('.bot-message-bubble .bot-execution')).toBeNull();
  const toggle = host.querySelector<HTMLButtonElement>('.bot-message-progress .bot-execution-toggle')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.textContent).toContain('正在读取资料');
  expect(host.querySelector('.bot-execution-contents')?.textContent).toContain('读取文件');
  expect(host.querySelector('.bot-message-text')?.textContent).toBe('流式正文');
  await render({ ...message, status: 'sent', content: '**最终答复**', execution: { ...execution, status: 'succeeded' } });
  expect(host.querySelector('.bot-execution,.bot-message-progress')).toBeNull();
  expect(host.querySelector('.bot-message-text strong')?.textContent).toBe('最终答复');
  expect(host.querySelector('.bot-message-text')?.textContent).not.toContain('流式正文');
});
it('offers explicit native continuation and retries the same command without duplicating an accepted continuation',async()=>{
  let ok=false;const proceed=vi.fn(async()=>({ok,error:ok?undefined:'暂时断开'}));
  await render({...message,status:'failed',execution:{...execution,status:'failed',continuation:{checkpoint:77}}},undefined,proceed);
  expect(host.querySelector('.bot-execution-status')?.textContent).toBe('等待继续');
  const button=host.querySelector<HTMLButtonElement>('.bot-execution-continuation button')!;
  await act(()=>button.click());expect(host.querySelector('[role=alert]')?.textContent).toBe('暂时断开');
  ok=true;await act(()=>button.click());expect(proceed).toHaveBeenCalledTimes(2);expect(proceed.mock.calls[0]).toEqual(proceed.mock.calls[1]);expect(button.disabled).toBe(true);
});
it('shows the actual native tool description and a short live reasoning preview while staying collapsed', async () => {
  await render({ ...message, execution: { ...execution, steps: [{ id: 'call', type: 'tool_call', at: message.createdAt, nativeStep: 4, toolName: 'pwsh', text: JSON.stringify({ description: '导出 56 张示例图片', command: 'secret command is never used as the description' }), summary: '开始调用工具', sequence: 8 }] } });
  expect(host.querySelector('.bot-execution-status')?.textContent).toBe('第 4 步 · 运行命令 · 导出 56 张示例图片');
  expect(host.querySelector('.bot-execution-toggle')?.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('.bot-execution-status')?.textContent).not.toContain('secret command');
  await render({ ...message, execution: { ...execution, steps: [{ id: 'think', type: 'reasoning', at: message.createdAt, nativeStep: 5, text: '先读取图片。\n\n已完成图片读取，接下来核对结果。', sequence: 9 }] } });
  expect(host.querySelector('.bot-execution-status')?.textContent).toBe('第 5 步 · 思考 · 已完成图片读取，接下来核对结果。');
});
it('uses native sequence after coalescing parallel calls rather than showing an older array entry', async () => {
  await render({ ...message, execution: { ...execution, steps: [{ id: 'r', type: 'reasoning', at: message.createdAt, text: '下一步核对文件', sequence: 12 }, { id: 'tool', type: 'tool_call', at: message.createdAt, toolName: 'read_file', text: '{"path":"report.md"}', sequence: 11 }] } });
  expect(host.querySelector('.bot-execution-status')?.textContent).toContain('下一步核对文件');
});
it('offers a compact one-click continuation outside the bubble only after interruption is confirmed', async () => {
  const proceed = vi.fn(async () => ({ ok: true }));
  await render({ ...message, status: 'cancelled', execution: { ...execution, status: 'cancelled', interruption: { state: 'stopping' } } }, undefined, proceed);
  expect(host.querySelector('.bot-message-bubble')).toBeNull();
  expect(host.querySelector('.bot-execution-toggle')).toBeNull();
  expect(host.querySelector('.is-interrupted [role=status]')?.textContent).toContain('正在停止');
  expect(host.querySelector<HTMLButtonElement>('.is-interrupted button')!.disabled).toBe(true);
  await render({ ...message, status: 'cancelled', execution: { ...execution, status: 'cancelled', interruption: { state: 'ready' } } }, undefined, proceed);
  const button = host.querySelector<HTMLButtonElement>('.is-interrupted button')!;
  expect(button.textContent).toBe('继续执行'); expect(button.disabled).toBe(false);
  expect(host.querySelector('textarea')).toBeNull();
  await act(() => button.click()); await act(() => button.click());
  expect(proceed).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(true);
});
it('keeps each reply session and its collapsed state separate from other messages', async () => {
  await render({ ...message, execution });
  await act(() => host.querySelector<HTMLButtonElement>('.bot-execution-toggle')!.click());
  await render({ ...message, id: 'new-reply', execution: { ...execution, sessionId: 'other-dsh-session' } });
  expect(host.querySelector('.bot-execution-toggle')?.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector('.bot-execution')?.getAttribute('data-native-session')).toBe('other-dsh-session');
  expect(host.querySelector('.bot-execution-contents')?.textContent).not.toContain('fresh-dsh-session');
});
it('shows one coherent thinking section per native loop step, including legacy saved token fragments',async()=>{
  const at=message.createdAt;
  const steps:BotExecution['steps']=[{id:'start',type:'status',summary:'开始处理任务',at},
    {id:'loop',type:'status',summary:'开始第 1 步处理',at},
    ...['用户','让我','自我介绍'].map((text,index)=>({id:'reason-'+index,type:'reasoning',text,at}))];
  await render({...message,execution:{...execution,steps}});
  expect(host.querySelectorAll('[data-type=reasoning]')).toHaveLength(1);
  expect(host.querySelector('.bot-execution-reasoning pre')?.textContent).toBe('用户让我自我介绍');
  expect(host.querySelector('.bot-execution-reasoning')?.hasAttribute('open')).toBe(false);
  expect(host.querySelector('.bot-execution-round')?.hasAttribute('open')).toBe(false);
  expect(host.querySelector('.bot-execution-round-title')?.textContent).toBe('第 1 步');
  expect(host.querySelector('.bot-execution-contents')?.textContent).not.toContain('开始处理任务');
});
it('answers the exact DSH question, preserves failed input for retry, and prevents duplicate accepted answers', async () => {
  let ok = false;
  const answer = vi.fn(async () => ({ ok, error: ok ? undefined : '连接中断' }));
  await render({ ...message, execution: { ...execution, question: { id: 'question-1', text: '选择保存位置？' } } }, answer);
  expect(host.querySelector('.bot-execution-question')?.textContent).toContain('选择保存位置？');
  const field = host.querySelector<HTMLTextAreaElement>('.bot-execution-question textarea')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '工作区目录'); field.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(() => host.querySelector<HTMLButtonElement>('.bot-execution-question button')!.click());
  expect(answer).toHaveBeenCalledWith('question-1', '工作区目录');
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('连接中断'); expect(field.value).toBe('工作区目录');
  ok = true; await act(() => host.querySelector<HTMLButtonElement>('.bot-execution-question button')!.click());
  expect(host.querySelector('.bot-execution-question textarea')).toBeNull();
  expect(host.querySelector('.bot-execution-question [role="status"]')?.textContent).toContain('已回复');
  expect(answer).toHaveBeenCalledTimes(2);
});
