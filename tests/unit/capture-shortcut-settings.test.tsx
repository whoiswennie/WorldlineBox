// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../src/renderer/i18n', () => ({ useLocale: () => ({ locale: 'zh-CN' }) }));
vi.mock('../../src/renderer/shortcut-runtime', () => ({ getShortcutRuntimePlatform: () => 'windows' }));
import { CaptureToolsSettingsPage } from '../../src/renderer/capture-tools/CaptureToolsSettingsPage';
import { DEFAULT_CAPTURE_TOOLS_SETTINGS, type CaptureToolsRequest, type CaptureToolsResponse, type CaptureToolsState, type WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); vi.restoreAllMocks(); });
function fixture() {
  const state: CaptureToolsState = { settings: structuredClone(DEFAULT_CAPTURE_TOOLS_SETTINGS), task: 'screenshot', revision: 1, downloadPath: 'C:\\Downloads\\WorldlineBox',
    shortcuts: [{ task: 'screenshot', accelerator: DEFAULT_CAPTURE_TOOLS_SETTINGS.shortcuts.screenshot, registered: true }], ai: { configured: false, model: '', visionSupported: null } };
  const request = vi.fn(async (input: CaptureToolsRequest): Promise<CaptureToolsResponse> => {
    if (input.type === 'settings.save') { state.settings = structuredClone(input.settings); state.revision++; }
    return { ok: true, state: structuredClone(state) };
  });
  const api: WorldlineBoxCaptureToolsApi = { request, onChanged: () => () => undefined, onStopRecording: () => () => undefined };
  return { state, request, api };
}
async function mount(value: ReturnType<typeof fixture>) { await act(() => root.render(<CaptureToolsSettingsPage api={value.api} />)); }
function input(task = 'screenshot') { return host.querySelector<HTMLInputElement>('#capture-key-' + task)!; }
function button(label: string) {
  const value = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === label || button.textContent === label);
  if (!value) throw Error('Missing button: ' + label); return value;
}
async function click(label: string) { await act(() => button(label).click()); }
async function focus(task = 'screenshot') { await act(() => input(task).focus()); }
async function keys(task: string, key: string, code: string, mods: Partial<KeyboardEventInit> = {}) {
  await act(() => input(task).dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...mods })));
  await act(() => input(task).dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true, ...mods })));
}

it('shows familiar keycaps and registration status without exposing Electron accelerator syntax', async () => {
  const value = fixture(); await mount(value);
  expect(input().readOnly).toBe(true); expect(input().value).toBe('Ctrl+Alt+Shift+S');
  expect([...host.querySelectorAll('#capture-key-screenshot + .capture-key-caps kbd')].map(item => item.textContent)).toEqual(['Ctrl', 'Alt', 'Shift', 'S']);
  expect(host.textContent).not.toContain('CommandOrControl');
  expect(host.textContent).toContain('已注册');
  expect(value.request.mock.calls.map(([request]) => request.type)).toEqual(['state']);
});

it('records a real press and release only after suspending native shortcuts, then saves explicitly', async () => {
  const value = fixture(); await mount(value); await focus();
  expect(value.request).toHaveBeenLastCalledWith({ type: 'shortcuts.capture', active: true });
  await act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })));
  expect(value.request.mock.calls.some(([request]) => request.type === 'settings.save')).toBe(false);
  expect([...host.querySelectorAll('#capture-key-screenshot + .capture-key-caps kbd')].map(item => item.textContent)).toEqual(['Ctrl', 'Alt', 'K']);
  await act(() => input().dispatchEvent(new KeyboardEvent('keyup', { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })));
  expect(value.request).toHaveBeenLastCalledWith({ type: 'shortcuts.capture', active: false });
  expect(input().value).toBe('Ctrl+Alt+K'); expect(host.textContent).toContain('待保存');
  await click('保存设置');
  expect(value.request).toHaveBeenLastCalledWith({ type: 'settings.save', settings: { ...DEFAULT_CAPTURE_TOOLS_SETTINGS, shortcuts: { ...DEFAULT_CAPTURE_TOOLS_SETTINGS.shortcuts, screenshot: 'Ctrl+Alt+K' } } });
});

it('ignores keys while native suspension is pending and restores shortcuts if the page unmounts before the reply', async () => {
  const value = fixture(); let ready!: (result: CaptureToolsResponse) => void;
  value.request.mockImplementation(async request => request.type === 'shortcuts.capture' && request.active ? new Promise(resolve => { ready = resolve; }) : { ok: true, state: value.state });
  await mount(value); await focus();
  expect(input().value).toBe('正在准备…');
  await keys('screenshot', 'k', 'KeyK', { ctrlKey: true, altKey: true });
  expect(value.request.mock.calls.filter(([request]) => request.type === 'shortcuts.capture')).toHaveLength(1);
  await act(() => root.render(null));
  await act(() => ready({ ok: true }));
  expect(value.request).toHaveBeenLastCalledWith({ type: 'shortcuts.capture', active: false });
  expect(value.request.mock.calls.some(([request]) => request.type === 'settings.save')).toBe(false);
});

it('restores native shortcuts on Escape, field blur and window blur without changing the binding', async () => {
  const value = fixture(); await mount(value); await focus();
  await keys('screenshot', 'Escape', 'Escape');
  expect(input().value).toBe('Ctrl+Alt+Shift+S');
  expect(value.request).toHaveBeenLastCalledWith({ type: 'shortcuts.capture', active: false });
  await focus(); await act(() => input().blur());
  expect(value.request).toHaveBeenLastCalledWith({ type: 'shortcuts.capture', active: false });
  await focus(); await act(() => window.dispatchEvent(new Event('blur')));
  expect(value.request).toHaveBeenLastCalledWith({ type: 'shortcuts.capture', active: false });
  expect(input().value).toBe('Ctrl+Alt+Shift+S');
});

it('recovers an ambiguous suspension failure and retries restoration after IPC errors', async () => {
  const value = fixture(); let resumes = 0;
  value.request.mockImplementation(async request => {
    if (request.type === 'shortcuts.capture') {
      if (request.active) throw Error('无法暂停快捷键');
      if (++resumes === 1) throw Error('response lost');
    }
    return { ok: true, state: value.state };
  });
  await mount(value); await focus();
  expect(host.textContent).toContain('无法暂停快捷键'); expect(resumes).toBe(2);
  await keys('screenshot', 'k', 'KeyK', { ctrlKey: true, altKey: true });
  expect(input().value).toBe('Ctrl+Alt+Shift+S');
  expect(value.request.mock.calls.some(([request]) => request.type === 'settings.save')).toBe(false);
});

it('blocks duplicates across all six tools before saving and offers clear and per-tool reset', async () => {
  const value = fixture(); value.state.settings.shortcuts.recording = 'Control+Alt+K'; await mount(value); await focus();
  await keys('screenshot', 'k', 'KeyK', { ctrlKey: true, altKey: true });
  expect(button('保存设置').disabled).toBe(true); expect(host.textContent).toContain('与以下功能重复：录屏'); expect(host.textContent).toContain('与以下功能重复：截图');
  await click('清除截图'); expect(input().value).toBe('未设置'); expect(button('保存设置').disabled).toBe(false);
  await click('重置截图'); expect(input().value).toBe('Ctrl+Alt+Shift+S');
  await click('保存设置');
  expect(value.request).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'settings.save', settings: expect.objectContaining({ shortcuts: { ...DEFAULT_CAPTURE_TOOLS_SETTINGS.shortcuts, recording: 'Control+Alt+K' } }) }));
});

it('rejects bare and reserved combinations, ignores modifier-only presses, and accepts an IME physical key', async () => {
  const value = fixture(); await mount(value); await focus();
  await keys('screenshot', 'Control', 'ControlLeft', { ctrlKey: true });
  expect(input().value).toBe('请按下组合键…');
  await keys('screenshot', 'F7', 'F7'); expect(host.textContent).toContain('请使用 Ctrl、Alt 或 Command');
  await keys('screenshot', 'F4', 'F4', { altKey: true }); expect(host.textContent).toContain('系统保留组合键');
  await keys('screenshot', 'Process', 'KeyJ', { ctrlKey: true, altKey: true });
  expect(input().value).toBe('Ctrl+Alt+J');
  expect(value.request).toHaveBeenLastCalledWith({ type: 'shortcuts.capture', active: false });
});

it('serializes focus transfers so a late reply cannot restore globals while another field is recording', async () => {
  const value = fixture(); let releaseFirst!: (result: CaptureToolsResponse) => void; let starts = 0;
  value.request.mockImplementation(async request => {
    if (request.type === 'shortcuts.capture' && request.active && ++starts === 1) return new Promise(resolve => { releaseFirst = resolve; });
    return { ok: true, state: value.state };
  });
  await mount(value); await focus(); await focus('recording');
  expect(input('recording').value).toBe('正在准备…');
  await act(() => releaseFirst({ ok: true }));
  expect(value.request.mock.calls.filter(([request]) => request.type === 'shortcuts.capture').map(([request]) => 'active' in request && request.active)).toEqual([true, false, true]);
  expect(input('recording').value).toBe('请按下组合键…');
  await keys('recording', 'l', 'KeyL', { ctrlKey: true, altKey: true });
  expect(input('recording').value).toBe('Ctrl+Alt+L'); expect(input().value).toBe('Ctrl+Alt+Shift+S');
  expect(value.request).toHaveBeenLastCalledWith({ type: 'shortcuts.capture', active: false });
});

it('keeps a remounted recorder suspended when an old instance receives its late suspension reply', async () => {
  const value = fixture(); let releaseOld!: (result: CaptureToolsResponse) => void;
  let newStarted!: () => void; const newSuspension = new Promise<void>(resolve => { newStarted = resolve; });
  let starts = 0; let suspended = false;
  value.request.mockImplementation(async request => {
    if (request.type === 'shortcuts.capture') {
      suspended = request.active;
      if (request.active) {
        if (++starts === 1) return new Promise(resolve => { releaseOld = resolve; });
        newStarted();
      }
    }
    return { ok: true, state: value.state };
  });
  await mount(value); await focus();
  await act(() => root.render(null));
  await mount(value); await focus();
  await act(async () => { releaseOld({ ok: true }); await newSuspension; });
  const events = value.request.mock.calls.filter(([request]) => request.type === 'shortcuts.capture').map(([request]) => 'active' in request && request.active);
  expect(events).toEqual([true, false, true]);
  expect(input().value).toBe('请按下组合键…');
  expect(suspended).toBe(true);
});
