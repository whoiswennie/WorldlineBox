// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CaptureToolsSettingsPage } from '../../src/renderer/capture-tools/CaptureToolsSettingsPage';
import { RecorderPanel } from '../../src/renderer/capture-tools/RecorderPanel';
import { DEFAULT_CAPTURE_TOOLS_SETTINGS, type CaptureToolsRequest, type CaptureToolsResponse, type CaptureToolsState, type WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';
import { LocaleProvider } from '../../src/renderer/i18n';
import * as media from '../../src/renderer/capture-tools/recording-media';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function state(): CaptureToolsState {
  return { settings: structuredClone(DEFAULT_CAPTURE_TOOLS_SETTINGS), task: 'recording', downloadPath: 'C:\\Downloads\\WorldlineBox', shortcuts: [], ai: { configured: false, model: '', visionSupported: null }, revision: 1 };
}
function bridge(snapshot = state()) {
  const request = vi.fn(async (request: CaptureToolsRequest) => {
    if (request.type === 'sources.list') return { ok: true as const, sources: [{ id: 'screen:0', name: '屏幕 1', displayId: '0', kind: 'screen' as const, thumbnail: '' }] };
    return { ok: true as const, state: snapshot };
  });
  const api: WorldlineBoxCaptureToolsApi = { request, onChanged: vi.fn(() => () => undefined), onStopRecording: vi.fn(() => () => undefined) };
  return { api, request };
}
async function mount(element: React.ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root.render(<LocaleProvider initialPreference="zh-CN">{element}</LocaleProvider>));
}
function button(text: string) { return [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === text || item.textContent === text)!; }

it('loads global defaults and saves microphone changes without changing shortcut bindings', async () => {
  const { api, request } = bridge();
  await mount(<CaptureToolsSettingsPage api={api} />);
  const inputs = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(inputs).toHaveLength(3);
  expect(inputs[1]!.checked).toBe(true); expect(inputs[2]!.checked).toBe(false);
  await act(() => inputs[2]!.click());
  await act(() => button('保存设置').click());
  expect(request).toHaveBeenLastCalledWith({ type: 'settings.save', settings: { ...DEFAULT_CAPTURE_TOOLS_SETTINGS, microphone: true } });
});

it('shows actual shortcut registration failures and allows resetting custom settings', async () => {
  const snapshot = state();
  snapshot.settings.shortcuts.screenshot = 'Alt+F7';
  snapshot.shortcuts = [{ task: 'screenshot', accelerator: 'Alt+F7', registered: false, error: '此快捷键已被占用' }];
  const { api, request } = bridge(snapshot);
  await mount(<CaptureToolsSettingsPage api={api} />);
  expect(host.textContent).toContain('此快捷键已被占用');
  await act(() => button('恢复默认').click());
  await act(() => button('保存设置').click());
  expect(request).toHaveBeenLastCalledWith({ type: 'settings.save', settings: DEFAULT_CAPTURE_TOOLS_SETTINGS });
});

it('shows sources, defaults to system sound, disables audio for GIF and offers editable regions', async () => {
  const { api } = bridge();
  await mount(<RecorderPanel api={api} state={state()} onClose={() => undefined} />);
  expect(host.textContent).toContain('屏幕 1');
  const sound = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(sound[1]!.checked).toBe(true); expect(sound[2]!.checked).toBe(false);
  await act(() => sound[0]!.click());
  expect(host.querySelectorAll('.capture-region-fields input')).toHaveLength(4);
  const format = [...host.querySelectorAll<HTMLSelectElement>('select')].find(item => item.value === 'mp4')!;
  await act(() => { format.value = 'gif'; format.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(sound[1]!.disabled).toBe(true); expect(sound[1]!.checked).toBe(false); expect(sound[2]!.disabled).toBe(true);
  expect(host.textContent).toContain('最长录制 60 秒');
});

it('streams recording chunks in order and waits for the last chunk before saving', async () => {
  const recorders: FakeRecorder[] = [];
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state = 'inactive';
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    onerror?: () => void;
    constructor() { recorders.push(this); }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob([new Uint8Array([3])]) }); this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('navigator', { languages: ['zh-CN'], mediaDevices: { getDisplayMedia: vi.fn() } });
  const cleanup = vi.fn();
  const track = new EventTarget();
  vi.spyOn(media, 'desktopRecordingMedia').mockResolvedValue({ stream: { getAudioTracks: () => [], getVideoTracks: () => [{ getSettings: () => ({ width: 1920, height: 1080 }) }] } as unknown as MediaStream, display: { getVideoTracks: () => [track] } as unknown as MediaStream, cleanup, missingSystemAudio: false, hasSystemAudio: false, hasMicrophone: false });
  const snapshot = state();
  const recorded: number[][] = [];
  const { api, request } = bridge(snapshot);
  request.mockImplementation(async input => {
    if (input.type === 'sources.list') return { ok: true, sources: [{ id: 'screen:0', name: '屏幕 1', displayId: '0', kind: 'screen', thumbnail: '' }] };
    if (input.type === 'recording.prepare') return { ok: true, state: snapshot, id: 'recording-a' };
    if (input.type === 'recording.chunk') recorded.push([...input.chunk]);
    return { ok: true, state: snapshot, path: 'C:\\Downloads\\WorldlineBox\\recording.mp4' };
  });
  await mount(<RecorderPanel api={api} state={snapshot} onClose={() => undefined} />);
  await act(() => button('开始录制').click());
  const recorder = recorders[0]!;
  expect(host.querySelector('.capture-recorder')?.classList.contains('is-active')).toBe(true);
  expect(host.querySelector('fieldset')).toBeNull();
  let release!: (value: ArrayBuffer) => void;
  const first = { size: 2, arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve; }) } as Blob;
  await act(() => { recorder.ondataavailable?.({ data: first }); recorder.ondataavailable?.({ data: new Blob([new Uint8Array([2])]) }); });
  await act(() => button('停止并保存').click());
  expect(request.mock.calls.some(([input]) => input.type === 'recording.finish')).toBe(false);
  await act(() => release(new Uint8Array([0, 1]).buffer));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(recorded).toEqual([[0, 1], [2], [3]]);
  expect(request.mock.calls.filter(([input]) => input.type === 'recording.chunk').map(([input]) => input.type === 'recording.chunk' ? input.sequence : -1)).toEqual([0, 1, 2]);
  expect(request).toHaveBeenLastCalledWith({ type: 'recording.finish', id: 'recording-a' });
  expect(cleanup).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('录制已保存');
});

it('preserves the recoverable WebM after conversion fails and reports actual audio availability', async () => {
  const recorders: FakeRecorder[] = [];
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state = 'inactive';
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    onerror?: () => void;
    constructor() { recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2])]) }); this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('navigator', { languages: ['zh-CN'], mediaDevices: { getDisplayMedia: vi.fn() } });
  vi.spyOn(media, 'desktopRecordingMedia').mockResolvedValue({ stream: { getAudioTracks: () => [], getVideoTracks: () => [{ getSettings: () => ({ width: 1920, height: 1080 }) }] } as unknown as MediaStream,
    display: { getVideoTracks: () => [new EventTarget()] } as unknown as MediaStream, cleanup: vi.fn(), missingSystemAudio: true, hasSystemAudio: false, hasMicrophone: false });
  const snapshot = state();
  const recoveryPath = 'C:\\Downloads\\.WorldlineBox-Recording-recover.webm.part';
  const request = vi.fn(async (input: CaptureToolsRequest) => {
    if (input.type === 'sources.list') return { ok: true as const, sources: [{ id: 'screen:0', name: '屏幕 1', displayId: '0', kind: 'screen' as const, thumbnail: '' }] };
    if (input.type === 'recording.prepare') return { ok: true as const, state: snapshot, id: 'recover' };
    if (input.type === 'recording.finish') {
      snapshot.recording = { id: 'recover', status: 'failed', format: 'mp4', bytes: 2, startedAt: '', path: recoveryPath, error: '转换失败' };
      return { ok: false as const, error: '转换失败，原始 WebM 已保留。' };
    }
    return { ok: true as const, state: snapshot };
  });
  const api: WorldlineBoxCaptureToolsApi = { request, onChanged: () => () => undefined, onStopRecording: () => () => undefined };
  await mount(<RecorderPanel api={api} state={snapshot} onClose={() => undefined} />);
  await act(() => button('开始录制').click());
  expect(recorders).toHaveLength(1);
  expect(host.querySelector('.capture-recording-audio > span')?.textContent).toBe('录制系统声音: —');
  expect(host.textContent).toContain('所选来源未提供系统音轨');
  await act(() => button('停止并保存').click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(request.mock.calls.some(([input]) => input.type === 'recording.cancel')).toBe(false);
  expect(host.textContent).toContain('原始 WebM 录制文件已保留');
  expect(host.textContent).toContain(recoveryPath);
  await act(() => button('查看文件').click());
  expect(request).toHaveBeenLastCalledWith({ type: 'reveal', path: recoveryPath });
});

it('mutes and restores already granted system and microphone tracks from the floating recording controls', async () => {
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state = 'inactive'; onstop?: () => void;
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('navigator', { languages: ['zh-CN'], mediaDevices: { getDisplayMedia: vi.fn() } });
  const system = vi.fn(), microphone = vi.fn();
  vi.spyOn(media, 'desktopRecordingMedia').mockResolvedValue({ stream: { getAudioTracks: () => [], getVideoTracks: () => [{ getSettings: () => ({ width: 1920, height: 1080 }) }] } as unknown as MediaStream,
    display: { getVideoTracks: () => [new EventTarget()] } as unknown as MediaStream, cleanup: vi.fn(), missingSystemAudio: false, hasSystemAudio: true, hasMicrophone: true,
    setSystemAudioEnabled: system, setMicrophoneEnabled: microphone });
  const snapshot = state(); const { api, request } = bridge(snapshot);
  request.mockImplementation(async input => input.type === 'sources.list'
    ? { ok: true, sources: [{ id: 'screen:0', name: '屏幕 1', displayId: '0', kind: 'screen', thumbnail: '' }] }
    : { ok: true, id: 'live-audio', state: snapshot });
  await mount(<RecorderPanel api={api} state={snapshot} onClose={() => undefined} />);
  await act(() => button('开始录制').click());
  const toggle = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  await act(() => toggle('录制系统声音').click()); expect(system).toHaveBeenLastCalledWith(false); expect(microphone).not.toHaveBeenCalled();
  await act(() => toggle('录制麦克风').click()); expect(microphone).toHaveBeenLastCalledWith(false);
  await act(() => toggle('录制系统声音').click()); expect(system).toHaveBeenLastCalledWith(true);
  expect(request.mock.calls.filter(([input]) => input.type === 'recording.prepare')).toHaveLength(1);
  await act(() => button('停止并保存').click());
});

it('honors a tray or global stop while desktop media permission is still pending', async () => {
  const constructed = vi.fn();
  vi.stubGlobal('MediaRecorder', class { constructor() { constructed(); } });
  vi.stubGlobal('navigator', { languages: ['zh-CN'], mediaDevices: { getDisplayMedia: vi.fn() } });
  let resolveMedia!: (value: media.DesktopRecordingMedia) => void;
  const cleanup = vi.fn();
  vi.spyOn(media, 'desktopRecordingMedia').mockImplementation(() => new Promise(resolve => { resolveMedia = resolve; }));
  const snapshot = state(); const { api, request } = bridge(snapshot);
  request.mockImplementation(async input => input.type === 'sources.list'
    ? { ok: true, sources: [{ id: 'screen:0', name: '屏幕 1', displayId: '0', kind: 'screen', thumbnail: '' }] }
    : { ok: true, id: 'pending-desktop', state: snapshot });
  await mount(<RecorderPanel api={api} state={snapshot} onClose={() => undefined} />);
  await act(() => button('开始录制').click());
  const stop = vi.mocked(api.onStopRecording).mock.calls.at(-1)![0];
  await act(() => stop());
  expect(request.mock.calls.some(([input]) => input.type === 'recording.cancel' && input.id === 'pending-desktop')).toBe(true);
  await act(async () => resolveMedia({ stream: {} as MediaStream, display: {} as MediaStream, cleanup, missingSystemAudio: false, hasSystemAudio: false, hasMicrophone: false }));
  expect(constructed).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('录制已取消'); expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('does not cancel accepted recording data when a disk failure is still publishing its recovery state', async () => {
  const recorders: FakeRecorder[] = [];
  class FakeRecorder {
    static isTypeSupported() { return true; }
    state = 'inactive';
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    onerror?: () => void;
    constructor() { recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('navigator', { languages: ['zh-CN'], mediaDevices: { getDisplayMedia: vi.fn() } });
  vi.spyOn(media, 'desktopRecordingMedia').mockResolvedValue({ stream: { getAudioTracks: () => [], getVideoTracks: () => [{ getSettings: () => ({ width: 1920, height: 1080 }) }] } as unknown as MediaStream,
    display: { getVideoTracks: () => [new EventTarget()] } as unknown as MediaStream, cleanup: vi.fn(), missingSystemAudio: false, hasSystemAudio: false, hasMicrophone: false });
  const snapshot = state();
  snapshot.recording = { id: 'disk-failure', status: 'recording', format: 'mp4', bytes: 1024, startedAt: '' };
  const recoveryPath = 'C:\\Downloads\\.WorldlineBox-Recording-disk.webm.part';
  let reads = 0;
  const request = vi.fn(async (input: CaptureToolsRequest): Promise<CaptureToolsResponse> => {
    if (input.type === 'sources.list') return { ok: true, sources: [{ id: 'screen:0', name: '屏幕 1', displayId: '0', kind: 'screen', thumbnail: '' }] };
    if (input.type === 'recording.prepare') return { ok: true, state: snapshot, id: 'disk-failure' };
    if (input.type === 'recording.chunk') return { ok: false, error: '磁盘写入失败' };
    if (input.type === 'recording.finish') return { ok: false, error: '磁盘文件正在关闭' };
    if (input.type === 'state' && ++reads > 1) snapshot.recording = { ...snapshot.recording!, status: 'failed', path: recoveryPath, error: '磁盘写入失败' };
    return { ok: true, state: structuredClone(snapshot) };
  });
  const api: WorldlineBoxCaptureToolsApi = { request, onChanged: () => () => undefined, onStopRecording: () => () => undefined };
  await mount(<RecorderPanel api={api} state={snapshot} onClose={() => undefined} />);
  await act(() => button('开始录制').click());
  await act(() => recorders[0]!.ondataavailable?.({ data: new Blob([new Uint8Array([1])]) }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
  expect(request.mock.calls.some(([input]) => input.type === 'recording.finish')).toBe(true);
  expect(request.mock.calls.some(([input]) => input.type === 'recording.cancel')).toBe(false);
  expect(reads).toBeGreaterThan(1);
  expect(host.textContent).toContain(recoveryPath);
  expect(host.textContent).toContain('原始 WebM 录制文件已保留');
});
