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
async function render(item: BotMessage, answer = vi.fn(async () => ({ ok: true }))) {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(() => root!.render(<BotMessageBody message={item} streamedText="流式正文" statusText="正在回复" locale="zh-CN" onAnswer={answer} />));
  return answer;
}
it('shows native live stages inside a pending bubble and collapses automatically on completion while preserving the final body', async () => {
  await render({ ...message, execution });
  expect(host.querySelector('.bot-message-bubble')?.classList.contains('is-inline-media-only')).toBe(false);
  let toggle = host.querySelector<HTMLButtonElement>('.bot-execution-toggle')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.textContent).toContain('正在读取资料');
  expect(host.querySelector('.bot-execution-contents')?.textContent).toContain('read_file');
  expect(host.querySelector('.bot-message-text')?.textContent).toBe('流式正文');
  await render({ ...message, status: 'sent', content: '**最终答复**', execution: { ...execution, status: 'succeeded' } });
  toggle = host.querySelector<HTMLButtonElement>('.bot-execution-toggle')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector<HTMLElement>('.bot-execution-contents')?.hidden).toBe(true);
  expect(host.querySelector('.bot-message-text strong')?.textContent).toBe('最终答复');
  expect(host.querySelector('.bot-message-text')?.textContent).not.toContain('流式正文');
  await act(() => toggle.click());
  expect(host.querySelector<HTMLElement>('.bot-execution-contents')?.hidden).toBe(false);
  expect(host.querySelector('.bot-execution-contents')?.textContent).toContain('原始工具调用内容');
});
it('keeps each reply session and its collapsed state separate from other messages', async () => {
  await render({ ...message, execution });
  await act(() => host.querySelector<HTMLButtonElement>('.bot-execution-toggle')!.click());
  await render({ ...message, id: 'new-reply', execution: { ...execution, sessionId: 'other-dsh-session' } });
  expect(host.querySelector('.bot-execution-toggle')?.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('.bot-execution-session')?.textContent).toContain('other-dsh-session');
  expect(host.querySelector('.bot-execution-session')?.textContent).not.toContain('fresh-dsh-session');
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
