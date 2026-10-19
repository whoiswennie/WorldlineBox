// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/renderer/i18n', () => ({ useLocale: () => ({ locale: 'zh-CN' }) }));
vi.mock('../../src/renderer/use-dialog-focus-trap', () => ({ useDialogFocusTrap: () => undefined }));
vi.mock('../../src/renderer/browser/screenshot/render', () => ({ drawScreenshot: vi.fn(), exportScreenshot: vi.fn(() => 'data:image/png;base64,RURJVEVE') }));
import { DesktopScreenshotOverlay, type DesktopScreenshotOverlayProps } from '../../src/renderer/capture-tools/DesktopScreenshotOverlay';
import { exportScreenshot } from '../../src/renderer/browser/screenshot/render';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
const props = (): DesktopScreenshotOverlayProps => ({
  source: { dataUrl: 'data:image/png;base64,U09VUkNF', width: 1600, height: 900, title: 'Desktop', url: '',
    desktop: { displayId: 'monitor-left', bounds: { x: -1280, y: 0, width: 1280, height: 720 }, workArea: { x: -1280, y: 0, width: 1280, height: 680 }, scaleFactor: 1.25, cursor: { x: -1100, y: 100 }, windowSnapping: true,
      candidates: [{ id: 'native-window', kind: 'window', name: 'Actual native window', bounds: { x: -1180, y: 60, width: 700, height: 500 } },
        { id: 'workarea', kind: 'workarea', name: 'Work area', bounds: { x: -1280, y: 0, width: 1280, height: 680 } },
        { id: 'screen', kind: 'screen', name: 'Entire screen', bounds: { x: -1280, y: 0, width: 1280, height: 720 } }] } },
  ai: { configured: true, model: 'vision-model', visionSupported: true }, onAsk: vi.fn(async () => '临时回答'),
  onSave: vi.fn(async () => undefined), onSaveFile: vi.fn(async () => undefined), onCopy: vi.fn(async () => undefined), onClose: vi.fn(),
});
class FakeImage {
  naturalWidth = 1600; naturalHeight = 900; onload: (() => void) | null = null; onerror: (() => void) | null = null;
  set src(_value: string) { queueMicrotask(() => this.onload?.()); }
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('Image', FakeImage); vi.stubGlobal('ResizeObserver', class { observe() { /* no layout engine */ } disconnect() { /* noop */ } });
  vi.stubGlobal('innerWidth', 1280); vi.stubGlobal('innerHeight', 720);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  HTMLElement.prototype.setPointerCapture = vi.fn(); HTMLElement.prototype.releasePointerCapture = vi.fn(); HTMLElement.prototype.hasPointerCapture = () => true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(value = props()) { await act(async () => root.render(createElement(DesktopScreenshotOverlay, value))); }
function button(label: string) { const node = [...container.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label); if (!node) throw Error(`Missing ${label}`); return node; }
async function click(label: string) { await act(() => button(label).click()); }
async function pointer(type: string, x: number, y: number, selector = '.desktop-screenshot-overlay') { await act(() => container.querySelector(selector)!.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }))); }
function crop() { return JSON.parse(container.querySelector('.desktop-screenshot-selection')!.getAttribute('data-pixel-crop')!); }
async function fill(value: string, label = '关于这张截图，想问什么？') { const input = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!; await act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }

describe('desktop screenshot overlay', () => {
  it('single-clicks the real window candidate and immediately edits at its screen coordinates', async () => {
    await render(); expect(container.querySelector('.screenshot-studio')).toBeNull();
    expect(container.querySelector('.desktop-screenshot-hover')?.getAttribute('data-candidate-kind')).toBe('window');
    await pointer('pointerdown', 180, 100); await pointer('pointerup', 180, 100);
    expect(crop()).toEqual({ x: 125, y: 75, width: 875, height: 625 }); expect(container.querySelector('.desktop-screenshot-toolbar')).not.toBeNull();
    expect(container.querySelector('.desktop-screenshot-selection-canvas')).not.toBeNull();
    await click('遮盖'); await pointer('pointerdown', 200, 120); await pointer('pointerup', 250, 170); await click('复制图片');
    expect(vi.mocked(exportScreenshot).mock.calls.at(-1)?.[2]).toEqual([{ tool: 'redact', from: { x: 125, y: 75 }, to: { x: 187.5, y: 137.5 }, size: 4 }]);
  });
  it('cycles hover candidates and supports full screen including the taskbar', async () => {
    await render();
    await act(() => container.querySelector('.desktop-screenshot-overlay')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 1 })));
    expect(container.querySelector('.desktop-screenshot-hover')?.getAttribute('data-candidate-kind')).toBe('workarea');
    await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(container.querySelector('.desktop-screenshot-hover')?.getAttribute('data-candidate-kind')).toBe('screen');
    await click('不含任务栏'); expect(crop()).toEqual({ x: 0, y: 0, width: 1600, height: 850 });
    await click('重新选择'); await click('使用整个屏幕'); expect(crop()).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
  });
  it('supports reverse free drags, resize handles, and copies then closes on completion', async () => {
    const value = props(); await render(value); await pointer('pointerdown', 300, 200); await pointer('pointermove', 100, 100); await pointer('pointerup', 100, 100);
    expect(crop()).toEqual({ x: 125, y: 125, width: 250, height: 125 });
    await pointer('pointerdown', 300, 200, '[data-resize-handle="se"]'); await pointer('pointermove', 400, 280); await pointer('pointerup', 400, 280);
    expect(crop()).toEqual({ x: 125, y: 125, width: 375, height: 225 });
    await click('复制并完成'); expect(value.onCopy).toHaveBeenCalledOnce(); expect(value.onClose).toHaveBeenCalledOnce();
  });
  it('preserves temporary multi-turn edited-image Q&A without persistent history', async () => {
    const localWrites = vi.spyOn(localStorage, 'setItem'); const sessionWrites = vi.spyOn(sessionStorage, 'setItem');
    const value = props(); await render(value); await click('使用整个屏幕'); await click('图片问答');
    await fill('第一个问题'); await click('发送'); await fill('根据刚才的回答再解释一下'); await click('发送');
    expect(value.onAsk).toHaveBeenLastCalledWith(expect.objectContaining({ messages: [{ role: 'user', content: '第一个问题' }, { role: 'assistant', content: '临时回答' }, { role: 'user', content: '根据刚才的回答再解释一下' }] }));
    expect(localWrites).not.toHaveBeenCalled(); expect(sessionWrites).not.toHaveBeenCalled();
    await click('清空对话'); expect(container.querySelectorAll('.screenshot-chat-messages article')).toHaveLength(0);
  });
  it('writes text directly on the selected screen and preserves undo/redo in exports', async () => {
    await render(); await click('使用整个屏幕'); await click('文字'); await pointer('pointerdown', 240, 160); await pointer('pointerup', 240, 160);
    await fill('屏幕上的标注', '文字');
    await act(() => container.querySelector<HTMLTextAreaElement>('.desktop-screenshot-text-input')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await click('复制图片');
    expect(vi.mocked(exportScreenshot).mock.calls.at(-1)?.[2]).toEqual([{ tool: 'text', at: { x: 300, y: 200 }, text: '屏幕上的标注', color: '#f04452', size: 26 }]);
    await click('撤销'); await click('复制图片'); expect(vi.mocked(exportScreenshot).mock.calls.at(-1)?.[2]).toEqual([]);
    await click('重做'); await click('复制图片'); expect(vi.mocked(exportScreenshot).mock.calls.at(-1)?.[2]).toHaveLength(1);
  });
  it('right-clicks back to selection, then cancels without saving or copying', async () => {
    const value = props(); await render(value); await click('使用整个屏幕');
    await act(() => container.querySelector('.desktop-screenshot-overlay')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(container.querySelector('.desktop-screenshot-toolbar')).toBeNull(); expect(value.onClose).not.toHaveBeenCalled();
    await act(() => container.querySelector('.desktop-screenshot-overlay')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(value.onClose).toHaveBeenCalledOnce(); expect(value.onCopy).not.toHaveBeenCalled(); expect(value.onSave).not.toHaveBeenCalled();
  });
  it('leaves a failed save reviewable in the overlay', async () => {
    const value = { ...props(), onSaveFile: vi.fn(async () => { throw Error('下载目录没有写入权限'); }) };
    await render(value); await click('使用整个屏幕'); await click('保存到下载目录');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('下载目录没有写入权限'); expect(value.onClose).not.toHaveBeenCalled();
    expect(container.querySelector('.desktop-screenshot-toolbar')).not.toBeNull();
  });
  it('cancels requests on close and ignores late temporary answers', async () => {
    let answer!: (value: string) => void; const value = { ...props(), onAsk: vi.fn<DesktopScreenshotOverlayProps['onAsk']>(() => new Promise(resolve => { answer = resolve; })) };
    await render(value); await click('使用整个屏幕'); await click('图片问答'); await fill('私人问题'); await act(() => button('发送').click());
    await act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(value.onClose).toHaveBeenCalledOnce(); expect(value.onAsk.mock.calls[0]?.[0].signal.aborted).toBe(true);
    await act(() => answer('不应出现的迟到回答')); expect(container.textContent).not.toContain('不应出现的迟到回答');
  });
  it('reuses the same smart region selector for recording configuration', async () => {
    const onSelection = vi.fn(); await render({ ...props(), recording: { onSelection, toolbar: createElement('button', null, '开始录制') } });
    await pointer('pointerdown', 300, 200); await pointer('pointerup', 300, 200);
    expect(onSelection).toHaveBeenLastCalledWith({ x: 125, y: 75, width: 875, height: 625 });
    expect(container.textContent).toContain('开始录制'); expect(container.querySelector('[data-screenshot-tool]')).toBeNull();
    expect(container.querySelector('.desktop-screenshot-chat')).toBeNull();
  });
});
