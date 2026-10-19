// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../src/renderer/i18n', () => ({ useLocale: () => ({ locale: 'zh-CN' }) }));
import { SelectionAssistant } from '../../src/renderer/capture-tools/SelectionAssistant';
import { DEFAULT_CAPTURE_TOOLS_SETTINGS, type CaptureToolsRequest, type CaptureToolsResponse, type CaptureToolsState, type WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); vi.restoreAllMocks(); });

function fixture() {
  const state: CaptureToolsState = { settings: structuredClone(DEFAULT_CAPTURE_TOOLS_SETTINGS), task: 'selection', revision: 0, downloadPath: 'C:\\Downloads',
    shortcuts: [], ai: { configured: true, model: 'text-only-model', visionSupported: false } };
  let answers = 0;
  const request = vi.fn(async (input: CaptureToolsRequest): Promise<CaptureToolsResponse> => {
    if (input.type === 'selection.ask') return { ok: true, text: ++answers === 1 ? '原文讨论了资源管理。' : '第二次回答。' };
    if (input.type === 'selection.clipboard') return { ok: true, text: '用户明确粘贴的原文。' };
    return { ok: true };
  });
  const api: WorldlineBoxCaptureToolsApi = { request, onChanged: () => () => undefined, onStopRecording: () => () => undefined };
  return { state, request, api, onClose: vi.fn() };
}
async function mount(value: ReturnType<typeof fixture>, initialText = '软件可以保存和整理资源。') {
  await act(() => root.render(<SelectionAssistant api={value.api} state={value.state} initialText={initialText} onClose={value.onClose} />));
}
function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label);
  if (!found) throw Error('Missing button ' + label);
  return found;
}
async function fill(value: string, label = '关于这段文字，想问什么？') {
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="' + label + '"]');
  if (!input) throw Error('Missing textarea ' + label);
  await act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function click(label: string) { await act(() => button(label).click()); }

it('supports temporary multi-turn context with text-only models, clears context and never writes browser storage', async () => {
  const localWrites = vi.spyOn(window.localStorage, 'setItem'), sessionWrites = vi.spyOn(window.sessionStorage, 'setItem');
  const value = fixture(); await mount(value);
  expect(value.request).not.toHaveBeenCalled();
  expect(host.querySelector('.selection-heading small')?.getAttribute('title')).toBe('临时对话 · 关闭即清除');
  expect(host.querySelector('.selection-source-summary')?.textContent).toBe('软件可以保存和整理资源。');
  expect(host.querySelector('textarea[aria-label="选中的文字"]')).toBeNull();
  await fill('这段文字讲了什么？'); await click('发送');
  expect(host.querySelectorAll('.selection-messages article')).toHaveLength(2);
  expect(host.querySelector('textarea[aria-label="选中的文字"]')).toBeNull();
  await fill('它有什么好处？'); await click('发送');
  const requests = value.request.mock.calls.map(([request]) => request).filter(request => request.type === 'selection.ask');
  expect(requests[1]).toMatchObject({ selection: '软件可以保存和整理资源。', messages: [
    { role: 'user', content: '这段文字讲了什么？' }, { role: 'assistant', content: '原文讨论了资源管理。' }, { role: 'user', content: '它有什么好处？' },
  ] });
  await click('清空临时对话');
  expect(host.querySelectorAll('.selection-messages article')).toHaveLength(0);
  expect(host.textContent).not.toContain('原文讨论了资源管理。');
  await fill('从头问一个问题。'); await click('发送');
  expect(value.request).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'selection.ask', messages: [{ role: 'user', content: '从头问一个问题。' }] }));
  expect(localWrites).not.toHaveBeenCalled(); expect(sessionWrites).not.toHaveBeenCalled();
});

it('starts a fresh conversation after close and a new selection, and reads the clipboard only on an explicit click', async () => {
  const value = fixture(); await mount(value);
  await fill('旧原文的私人问题。'); await click('发送'); await click('关闭');
  expect(value.onClose).toHaveBeenCalledOnce();
  await act(() => root.render(null));
  await mount(value, '新的选中文字。');
  expect(host.querySelectorAll('.selection-messages article')).toHaveLength(0);
  expect(host.textContent).not.toContain('旧原文的私人问题。');
  expect(value.request.mock.calls.some(([request]) => request.type === 'selection.clipboard')).toBe(false);
  await click('粘贴剪贴板');
  expect(value.request).toHaveBeenLastCalledWith({ type: 'selection.clipboard' });
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="选中的文字"]')?.value).toBe('用户明确粘贴的原文。');
  await fill('新问题。'); await click('发送');
  expect(value.request).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'selection.ask', selection: '用户明确粘贴的原文。', messages: [{ role: 'user', content: '新问题。' }] }));
});

it('resets conversation when original text is edited and bounds Unicode by UTF-8 bytes', async () => {
  const value = fixture(); await mount(value);
  await fill('原文问题。'); await click('发送');
  await act(() => host.querySelector<HTMLButtonElement>('.selection-source-summary')!.click());
  await fill('已经修改的原文。', '选中的文字');
  expect(host.querySelectorAll('.selection-messages article')).toHaveLength(0);
  expect(host.textContent).toContain('原文已修改，临时对话已重置');
  await fill('新原文问题。'); await click('发送');
  expect(value.request).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'selection.ask', selection: '已经修改的原文。', messages: [{ role: 'user', content: '新原文问题。' }] }));
  await click('清空临时对话');
  await act(() => host.querySelector<HTMLButtonElement>('.selection-source-summary')!.click());
  await fill('字'.repeat(11_000), '选中的文字'); await fill('这个问题不能发送。');
  expect(button('发送').disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('原文超过 32 KiB');
});

it('cancels an active question and ignores late answers without losing the draft', async () => {
  const value = fixture(); let finish!: (value: CaptureToolsResponse) => void;
  value.request.mockImplementation(async input => input.type === 'selection.ask' ? new Promise(resolve => { finish = resolve; }) : { ok: true });
  await mount(value); await fill('暂未回答的问题。'); await click('发送');
  expect(host.textContent).toContain('正在思考');
  const ask = value.request.mock.calls[0]![0];
  await click('停止回答');
  expect(value.request).toHaveBeenLastCalledWith({ type: 'ask.cancel', id: 'id' in ask ? ask.id : '' });
  await act(() => finish({ ok: true, text: '不应显示的过期回答' }));
  expect(host.textContent).not.toContain('不应显示的过期回答');
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="关于这段文字，想问什么？"]')?.value).toBe('暂未回答的问题。');
});

it('withdraws only the pending third question and prevents the Stop click from submitting it again', async () => {
  const value = fixture(); let answer!: (value: CaptureToolsResponse) => void; let asks = 0;
  value.request.mockImplementation(async input => {
    if (input.type !== 'selection.ask') return { ok: true };
    if (++asks === 3) return new Promise(resolve => { answer = resolve; });
    return { ok: true, text: '已完成回答 ' + asks };
  });
  await mount(value);
  await fill('第一轮问题'); await click('发送'); await fill('第二轮问题'); await click('发送');
  const completed = [...host.querySelectorAll('.selection-messages article p')].map(item => item.textContent);
  expect(completed).toEqual(['第一轮问题', '已完成回答 1', '第二轮问题', '已完成回答 2']);
  await fill('第三轮等待取消'); await click('发送');
  expect(host.querySelectorAll('.selection-messages article')).toHaveLength(5);
  const stopClick = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(() => button('停止回答').dispatchEvent(stopClick));
  // Chromium can reuse this button as type=submit before the click's default
  // action runs. Cancelling that default prevents an unintended new request.
  expect(stopClick.defaultPrevented).toBe(true);
  expect([...host.querySelectorAll('.selection-messages article p')].map(item => item.textContent)).toEqual(completed);
  expect(host.querySelector<HTMLTextAreaElement>('.selection-composer textarea')?.value).toBe('第三轮等待取消');
  await act(() => answer({ ok: true, text: '过期的第三轮回答' }));
  expect(asks).toBe(3);
  expect(host.textContent).not.toContain('过期的第三轮回答');
  await click('发送');
  expect(value.request).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'selection.ask', messages: [
    { role: 'user', content: '第一轮问题' }, { role: 'assistant', content: '已完成回答 1' },
    { role: 'user', content: '第二轮问题' }, { role: 'assistant', content: '已完成回答 2' }, { role: 'user', content: '第三轮等待取消' },
  ] }));
});

it('copies answers through the explicit native action and renders page text as plain text', async () => {
  const value = fixture(); await mount(value, '<script>unsafe()</script>');
  expect(host.querySelector('script')).toBeNull();
  await fill('解释原文。'); await click('发送'); await click('复制回答');
  expect(value.request).toHaveBeenLastCalledWith({ type: 'selection.copy', text: '原文讨论了资源管理。' });
  expect(host.textContent).toContain('回答已复制');
});

it('aborts an active question on close and discards its late answer after remounting', async () => {
  const value = fixture(); let finish!: (value: CaptureToolsResponse) => void;
  value.request.mockImplementation(async input => input.type === 'selection.ask' ? new Promise(resolve => { finish = resolve; }) : { ok: true });
  await mount(value); await fill('关闭前的问题。'); await click('发送'); await click('关闭');
  expect(value.onClose).toHaveBeenCalledOnce();
  expect(value.request.mock.calls.some(([input]) => input.type === 'ask.cancel')).toBe(true);
  await act(() => root.render(null));
  await act(() => finish({ ok: true, text: '关闭后收到的过期回答' }));
  await mount(value, '另一次临时选择。');
  expect(host.querySelectorAll('.selection-messages article')).toHaveLength(0);
  expect(host.textContent).not.toContain('关闭后收到的过期回答');
});

it('sends a quick action on an explicit click, preserves context for follow-ups, and never auto-sends selected text', async () => {
  const value = fixture(); await mount(value, '当前应用中选中的原文。');
  expect(value.request).not.toHaveBeenCalled();
  await click('总结重点');
  expect(value.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'selection.ask', selection: '当前应用中选中的原文。', messages: [{ role: 'user', content: '总结重点' }] }));
  expect(host.querySelectorAll('.selection-messages article')).toHaveLength(2);
  await fill('解释其中的关键点。'); await click('发送');
  expect(value.request).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'selection.ask', messages: [
    { role: 'user', content: '总结重点' }, { role: 'assistant', content: '原文讨论了资源管理。' }, { role: 'user', content: '解释其中的关键点。' },
  ] }));
});

it('makes empty selection a manual fallback and cannot send a quick action until text is provided', async () => {
  const value = fixture(); await mount(value, '');
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="选中的文字"]')?.value).toBe('');
  expect(host.textContent).toContain('在任意应用中使用划词快捷键');
  expect(button('解释这段文字').disabled).toBe(true);
  expect(button('总结重点').disabled).toBe(true);
  await fill('用户输入的真实原文。', '选中的文字'); await click('解释这段文字');
  expect(value.request).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'selection.ask', selection: '用户输入的真实原文。' }));
});

it('only pins the window through the explicit pin action and reflects native state instead of assuming success', async () => {
  const value = fixture(); await mount(value);
  expect(button('保持在最前面').getAttribute('aria-pressed')).toBe('false');
  expect(value.request).not.toHaveBeenCalled();
  await click('保持在最前面');
  expect(value.request).toHaveBeenLastCalledWith({ type: 'selection.pin', pinned: true });
  expect(button('保持在最前面').getAttribute('aria-pressed')).toBe('false');
  value.state.selectionPinned = true; await mount(value);
  expect(button('取消置顶').getAttribute('aria-pressed')).toBe('true');
  await click('取消置顶');
  expect(value.request).toHaveBeenLastCalledWith({ type: 'selection.pin', pinned: false });
});

it('sends with Enter but keeps Shift+Enter and IME confirmation available to edit the draft', async () => {
  const value = fixture(); await mount(value); await fill('第一行\n第二行');
  const input = host.querySelector<HTMLTextAreaElement>('.selection-composer textarea')!;
  const newline = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
  const composing = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  await act(() => { input.dispatchEvent(newline); input.dispatchEvent(composing); });
  expect(newline.defaultPrevented).toBe(false); expect(composing.defaultPrevented).toBe(false);
  expect(value.request).not.toHaveBeenCalled();
  const send = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await act(() => input.dispatchEvent(send));
  expect(send.defaultPrevented).toBe(true);
  expect(value.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'selection.ask', messages: [{ role: 'user', content: '第一行\n第二行' }] }));
});

it('scrolls only its conversation container and returns to the top when the content fits', async () => {
  const value = fixture(); await mount(value);
  const scroller = host.querySelector<HTMLElement>('.selection-conversation')!;
  let contentHeight = 540;
  Object.defineProperties(scroller, { scrollHeight: { configurable: true, get: () => contentHeight }, clientHeight: { configurable: true, value: 250 } });
  const scrollAncestor = vi.fn();
  const previous = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollAncestor;
  try {
    await fill('第一轮问题'); await click('发送');
    expect(scroller.scrollTop).toBe(290);
    expect(host.querySelector('.selection-messages article strong')).toBeNull();
    contentHeight = 180;
    await fill('第二轮问题'); await click('发送');
    expect(host.querySelectorAll('.selection-messages article')).toHaveLength(4);
    expect(scroller.scrollTop).toBe(0);
    expect(scrollAncestor).not.toHaveBeenCalled();
  } finally { HTMLElement.prototype.scrollIntoView = previous; }
});
