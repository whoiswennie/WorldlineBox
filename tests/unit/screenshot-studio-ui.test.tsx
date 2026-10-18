// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/renderer/i18n', () => ({ useLocale: () => ({ locale: 'zh-CN' }) }));
vi.mock('../../src/renderer/use-dialog-focus-trap', () => ({ useDialogFocusTrap: () => undefined }));
vi.mock('../../src/renderer/browser/screenshot/render', () => ({ drawScreenshot: vi.fn(), exportScreenshot: vi.fn(() => 'data:image/png;base64,RURJVEVE') }));
import { ScreenshotStudio, type ScreenshotStudioProps } from '../../src/renderer/browser/screenshot/ScreenshotStudio';
import { exportScreenshot } from '../../src/renderer/browser/screenshot/render';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
const props = (): ScreenshotStudioProps => ({
  source: { dataUrl: 'data:image/png;base64,U09VUkNF', width: 600, height: 400, title: 'Desktop' },
  ai: { configured: true, model: 'vision-model', visionSupported: true },
  onAsk: vi.fn(async () => '这是模型的回答。'), onSave: vi.fn(async () => undefined), onCopy: vi.fn(async () => undefined), onClose: vi.fn(),
});
class FakeImage {
  naturalWidth = 600; naturalHeight = 400;
  onload: ((event: Event) => void) | null = null; onerror: ((event: Event) => void) | null = null;
  set src(_value: string) { queueMicrotask(() => this.onload?.(new Event('load'))); }
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('ResizeObserver', class { observe() { /* no layout engine */ } disconnect() { /* noop */ } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 600, height: 400, top: 0, left: 0, right: 600, bottom: 400, toJSON: () => ({}) });
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn(); HTMLCanvasElement.prototype.releasePointerCapture = vi.fn(); HTMLCanvasElement.prototype.hasPointerCapture = () => true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(value: ScreenshotStudioProps) { await act(async () => root.render(createElement(ScreenshotStudio, value))); }
function button(text: string): HTMLButtonElement { const element = [...container.querySelectorAll('button')].find(item => item.textContent === text || item.getAttribute('aria-label') === text); if (!element) throw new Error(`Missing button ${text}`); return element; }
async function click(text: string) { await act(() => button(text).click()); }
async function fill(value: string, label = '关于这张截图，想问什么？') { const input = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!; await act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function pointer(type: string, x: number, y: number) { await act(() => container.querySelector('canvas')!.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }))); }

describe('screenshot studio interactions', () => {
  it('crops reverse drags and exports pixel coordinates with newly drawn redaction', async () => {
    const value = props(); await render(value);
    await pointer('pointerdown', 400, 300); await pointer('pointermove', 100, 100); await pointer('pointerup', 100, 100);
    await click('编辑选区');
    expect(container.textContent).toContain('300 × 200 px');
    await click('遮盖'); await pointer('pointerdown', 20, 20); await pointer('pointerup', 80, 80);
    await click('复制图片');
    expect(value.onCopy).toHaveBeenCalledWith('data:image/png;base64,RURJVEVE');
    const call = vi.mocked(exportScreenshot).mock.calls.at(-1)!;
    expect(call[1]).toEqual({ x: 100, y: 100, width: 300, height: 200 });
    expect(call[2]).toEqual([{ tool: 'redact', from: { x: 10, y: 10 }, to: { x: 40, y: 40 }, size: 4 }]);
  });

  it('supports text placement, undo, redo and saved PNG filenames', async () => {
    const value = props(); await render(value); await click('使用整个可见区域'); await click('文字'); await fill('图中文字', '文字');
    await pointer('pointerdown', 50, 70); await pointer('pointerup', 50, 70);
    await click('撤销'); await click('复制图片'); expect(vi.mocked(exportScreenshot).mock.calls.at(-1)?.[2]).toEqual([]);
    await click('重做'); await click('保存到资源库');
    expect(vi.mocked(exportScreenshot).mock.calls.at(-1)?.[2]).toEqual([{ tool: 'text', at: { x: 50, y: 70 }, text: '图中文字', size: 26, color: '#f04452' }]);
    expect(value.onSave).toHaveBeenCalledWith('data:image/png;base64,RURJVEVE', expect.stringMatching(/^Screenshot-.*\.png$/));
  });

  it('never sends an image automatically and uses current edits when the user asks', async () => {
    const value = props(); await render({ ...value, initialTask: 'ocr' });
    expect(value.onAsk).not.toHaveBeenCalled(); await click('使用整个可见区域');
    expect(value.onAsk).not.toHaveBeenCalled();
    await click('遮盖'); await pointer('pointerdown', 10, 10); await pointer('pointerup', 80, 80);
    await click('发送');
    expect(value.onAsk).toHaveBeenCalledWith(expect.objectContaining({ dataUrl: 'data:image/png;base64,RURJVEVE', messages: [{ role: 'user', content: expect.stringContaining('全部文字') }], signal: expect.any(AbortSignal) }));
    expect(vi.mocked(exportScreenshot).mock.calls.at(-1)?.[3]).toEqual({ maxSide: 1600, format: 'image/jpeg' });
    expect(container.textContent).toContain('这是模型的回答。');
  });

  it('cancels in-flight Q&A, restores the question and ignores a late answer', async () => {
    let resolve!: (text: string) => void;
    const value = { ...props(), onAsk: vi.fn<ScreenshotStudioProps['onAsk']>(() => new Promise<string>(done => { resolve = done; })) };
    await render(value); await click('使用整个可见区域'); await click('图片问答'); await fill('这是什么？');
    await act(() => button('发送').click());
    expect(container.textContent).toContain('正在分析图片');
    const signal = value.onAsk.mock.calls[0]?.[0]?.signal;
    await click('停止回答'); expect(signal?.aborted).toBe(true);
    await act(() => resolve('过期回复')); expect(container.textContent).not.toContain('过期回复');
    expect(container.querySelector<HTMLTextAreaElement>('.screenshot-chat-composer textarea')?.value).toBe('这是什么？');
  });

  it('keeps two completed rounds when stopping the third and prevents the Stop click from submitting again', async () => {
    let answer!: (value: string) => void;
    const onAsk = vi.fn<ScreenshotStudioProps['onAsk']>()
      .mockResolvedValueOnce('第一轮回答')
      .mockResolvedValueOnce('第二轮回答')
      .mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    await render({ ...props(), onAsk }); await click('使用整个可见区域'); await click('图片问答');
    await fill('第一轮问题'); await click('发送'); await fill('第二轮问题'); await click('发送');
    const completed = [...container.querySelectorAll('.screenshot-chat-messages article p')].map(item => item.textContent);
    expect(completed).toEqual(['第一轮问题', '第一轮回答', '第二轮问题', '第二轮回答']);
    await fill('第三轮等待取消'); await click('发送');
    expect(container.querySelectorAll('.screenshot-chat-messages article')).toHaveLength(5);
    const stopClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(() => button('停止回答').dispatchEvent(stopClick));
    expect(stopClick.defaultPrevented).toBe(true);
    expect([...container.querySelectorAll('.screenshot-chat-messages article p')].map(item => item.textContent)).toEqual(completed);
    expect(container.querySelector<HTMLTextAreaElement>('.screenshot-chat-composer textarea')?.value).toBe('第三轮等待取消');
    expect(onAsk.mock.calls[2]?.[0].signal.aborted).toBe(true);
    await act(() => answer('过期的第三轮回答'));
    expect(onAsk).toHaveBeenCalledTimes(3);
    expect(container.textContent).not.toContain('过期的第三轮回答');
  });

  it('keeps temporary multi-turn context until cleared without writing chat to browser storage', async () => {
    const localWrites = vi.spyOn(window.localStorage, 'setItem');
    const sessionWrites = vi.spyOn(window.sessionStorage, 'setItem');
    const onAsk = vi.fn<ScreenshotStudioProps['onAsk']>()
      .mockResolvedValueOnce('截图中有三只猫。')
      .mockResolvedValueOnce('左侧的是橘猫。')
      .mockResolvedValueOnce('这是一次新的临时问答。');
    await render({ ...props(), onAsk }); await click('使用整个可见区域'); await click('图片问答');
    await fill('图里有几只猫？'); await click('发送');
    expect(container.querySelectorAll('.screenshot-chat-messages article')).toHaveLength(2);
    await fill('左侧那只是橘猫吗？'); await click('发送');
    expect(onAsk.mock.calls[1]?.[0].messages).toEqual([
      { role: 'user', content: '图里有几只猫？' },
      { role: 'assistant', content: '截图中有三只猫。' },
      { role: 'user', content: '左侧那只是橘猫吗？' },
    ]);
    expect(container.querySelectorAll('.screenshot-chat-messages article')).toHaveLength(4);
    expect(container.textContent).toContain('左侧的是橘猫。');
    await click('清空对话');
    expect(container.querySelectorAll('.screenshot-chat-messages article')).toHaveLength(0);
    expect(container.textContent).not.toContain('图里有几只猫？');
    expect(container.textContent).not.toContain('截图中有三只猫。');
    expect(container.textContent).not.toContain('左侧的是橘猫。');
    await fill('从这里重新开始。'); await click('发送');
    expect(onAsk.mock.calls[2]?.[0].messages).toEqual([{ role: 'user', content: '从这里重新开始。' }]);
    expect(localWrites).not.toHaveBeenCalled();
    expect(sessionWrites).not.toHaveBeenCalled();
  });

  it('starts a fresh temporary conversation after closing and mounting a new capture', async () => {
    const localWrites = vi.spyOn(window.localStorage, 'setItem');
    const sessionWrites = vi.spyOn(window.sessionStorage, 'setItem');
    const onAsk = vi.fn<ScreenshotStudioProps['onAsk']>()
      .mockResolvedValueOnce('第一张截图的私人回答。')
      .mockResolvedValueOnce('第二张截图的回答。');
    const value = { ...props(), onAsk };
    await render(value); await click('使用整个可见区域'); await click('图片问答');
    await fill('第一张截图的私人问题。'); await click('发送');
    await click('关闭截图');
    expect(value.onClose).toHaveBeenCalledOnce();
    await act(() => root.render(null));
    await render({ ...value, source: { ...value.source, title: 'New desktop capture', dataUrl: 'data:image/png;base64,TkVX' } });
    await click('使用整个可见区域'); await click('图片问答');
    expect(container.querySelectorAll('.screenshot-chat-messages article')).toHaveLength(0);
    expect(container.textContent).not.toContain('第一张截图的私人问题。');
    expect(container.textContent).not.toContain('第一张截图的私人回答。');
    await fill('第二张截图是什么？'); await click('发送');
    expect(onAsk.mock.calls[1]?.[0].messages).toEqual([{ role: 'user', content: '第二张截图是什么？' }]);
    expect(localWrites).not.toHaveBeenCalled();
    expect(sessionWrites).not.toHaveBeenCalled();
  });

  it('keeps errors reviewable and never calls image Q&A for a known unsupported model', async () => {
    const value = props(); await render({ ...value, ai: { ...value.ai, visionSupported: false } });
    await click('使用整个可见区域'); await click('图片问答');
    expect(container.textContent).toContain('当前模型未启用图片输入'); expect(button('发送').disabled).toBe(true);
    expect(value.onAsk).not.toHaveBeenCalled();
  });

  it('surfaces save failures and closes with Escape', async () => {
    const value = { ...props(), onSave: vi.fn(async () => { throw new Error('资源库不可用'); }) };
    await render(value); await click('使用整个可见区域'); await click('保存到资源库');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('资源库不可用');
    await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(value.onClose).toHaveBeenCalledOnce();
  });

  it('passes original image pixel coordinates for scrolling capture and offers a separate Downloads save', async () => {
    const onLongCapture = vi.fn(async () => undefined); const onSaveFile = vi.fn(async () => undefined);
    await render({ ...props(), onLongCapture, onSaveFile });
    await pointer('pointerdown', 450, 300); await pointer('pointerup', 150, 80);
    await click('滚动长截图');
    expect(onLongCapture).toHaveBeenCalledWith({ x: 150, y: 80, width: 300, height: 220 });
    await click('编辑选区'); await click('保存到下载目录');
    expect(onSaveFile).toHaveBeenCalledWith('data:image/png;base64,RURJVEVE', expect.stringMatching(/\.png$/));
  });
});
