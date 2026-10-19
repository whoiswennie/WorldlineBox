// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CaptureToolsWindow } from '../../src/renderer/capture-tools/CaptureToolsWindow';
import type { DesktopScreenshotOverlayProps } from '../../src/renderer/capture-tools/DesktopScreenshotOverlay';
import { LocaleProvider } from '../../src/renderer/i18n';
import { DEFAULT_CAPTURE_TOOLS_SETTINGS, type CaptureToolsRequest, type CaptureToolsResponse, type CaptureToolsState, type WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';

vi.mock('../../src/renderer/capture-tools/DesktopScreenshotOverlay', () => ({
  DesktopScreenshotOverlay: (props: DesktopScreenshotOverlayProps) => <div data-overlay-source={props.source.title}>
    <button onClick={() => void props.onSave('data:image/png;base64,AA==', 'capture.png')}>library</button>
    <button onClick={() => void props.onSaveFile?.('data:image/png;base64,AA==', 'capture.png')}>downloads</button>
    <button onClick={() => void props.onLongCapture?.({ x: 2, y: 4, width: 30, height: 40 })}>long</button>
  </div>,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });

async function mount(task: CaptureToolsState['task'] = 'screenshot') {
  const state: CaptureToolsState = { settings: structuredClone(DEFAULT_CAPTURE_TOOLS_SETTINGS), task, revision: 0, downloadPath: 'C:\\Downloads', ai: { configured: true, model: 'vision', visionSupported: true }, shortcuts: [] };
  const source = { title: 'original', width: 100, height: 100, dataUrl: 'data:image/png;base64,AA==', url: '' };
  const request = vi.fn(async (input: CaptureToolsRequest): Promise<CaptureToolsResponse> => {
    if (input.type === 'context') return task === 'selection' ? { ok: true, state, text: '来自上下文的真实选中文字。' } : { ok: true, state, source };
    if (input.type === 'long.begin') return { ok: true, long: { frames: 1, width: 30, height: 40 } };
    if (input.type === 'long.append') return { ok: true, long: { frames: 2, width: 30, height: 65 } };
    if (input.type === 'long.finish') return { ok: true, source: { ...source, title: 'stitched', height: 65 } };
    return { ok: true };
  });
  const api: WorldlineBoxCaptureToolsApi = { request, onChanged: () => () => undefined, onStopRecording: () => () => undefined };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root.render(<LocaleProvider initialPreference="zh-CN"><CaptureToolsWindow api={api} /></LocaleProvider>));
  return { request };
}
function button(text: string) { return [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!; }

it('exposes separate library and Downloads saves from the global screenshot editor', async () => {
  const { request } = await mount();
  // A source without desktop metadata still uses the single overlay component.
  expect(host.querySelector('[data-overlay-source]')?.getAttribute('data-overlay-source')).toBe('original');
  await act(() => button('library').click());
  expect(request).toHaveBeenLastCalledWith({ type: 'screenshot.save', dataUrl: 'data:image/png;base64,AA==', filename: 'capture.png', destination: 'library' });
  await act(() => button('downloads').click());
  expect(request).toHaveBeenLastCalledWith({ type: 'screenshot.save', dataUrl: 'data:image/png;base64,AA==', filename: 'capture.png', destination: 'downloads' });
});

it('passes physical crop coordinates, collects successive frames, then returns the stitched image to the editor', async () => {
  const { request } = await mount();
  await act(() => button('long').click());
  expect(request).toHaveBeenLastCalledWith({ type: 'long.begin', rect: { x: 2, y: 4, width: 30, height: 40 } });
  expect(host.querySelector('[data-overlay-source]')).toBeNull();
  expect(host.textContent).toContain('已采集屏数 1');
  await act(() => button('添加下一屏').click());
  expect(request).toHaveBeenLastCalledWith({ type: 'long.append' });
  expect(host.textContent).toContain('已采集屏数 2');
  await act(() => button('完成拼接').click());
  expect(request).toHaveBeenLastCalledWith({ type: 'long.finish' });
  expect(host.querySelector('[data-overlay-source]')?.getAttribute('data-overlay-source')).toBe('stitched');
});

it('routes selection context to its temporary assistant without requesting desktop sources or screenshots', async () => {
  const { request } = await mount('selection');
  expect(host.querySelector('[data-selection-assistant]')).not.toBeNull();
  expect(host.querySelector('.selection-source-summary')?.textContent).toBe('来自上下文的真实选中文字。');
  expect(request.mock.calls.map(([input]) => input.type)).toEqual(['context']);
});
