import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow, clipboard, desktopCapturer, globalShortcut, session, shell, type IpcMainInvokeEvent } from 'electron';
import { CaptureToolsService, canonicalCaptureShortcut, type CaptureToolsServiceOptions } from '../../src/main/capture-tools/service';
import { CAPTURE_TOOLS_STOP_RECORDING, DEFAULT_CAPTURE_TOOLS_SETTINGS, type CaptureImageSource, type CaptureToolsSettings } from '../../src/shared/capture-tools';
import { readFocusedSelectedText } from '../../src/main/capture-tools/selected-text';
import { answerSelectedText } from '../../src/main/capture-tools/text-answer';
import { answerCaptureImage } from '../../src/main/capture-tools/visual-answer';
import { CAPTURE_TOOLS_ANSWER_PROGRESS, type CaptureAnswerUpdate } from '../../src/shared/capture-answer';
import type * as SelectedText from '../../src/main/capture-tools/selected-text';
import type * as DesktopRegions from '../../src/main/capture-tools/desktop-regions';
import { positionCaptureWindowInPhysicalPixels, readWindowsCaptureMonitor } from '../../src/main/capture-tools/desktop-regions';
import { windowsSnapshot } from '../../src/main/capture-tools/windows-snapshot';

const mock = vi.hoisted(() => ({ windows: [] as unknown[], png: Buffer.alloc(0), scope: {} as Record<string, unknown>, callbacks: new Map<string, () => void>(), boundaryLoad: undefined as (() => Promise<void>) | undefined }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  let nextId = 0;
  class Window extends EventEmitter {
    id = ++nextId; destroyed = false; visible = true; focused = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => this.destroyed, send: vi.fn(), setWindowOpenHandler: vi.fn(), capturePage: vi.fn(async () => ({})) });
    constructor(readonly options: { show?: boolean }) { super(); this.visible = options.show !== false; mock.windows.push(this); }
    static getAllWindows() { return mock.windows; }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isFocused() { return this.focused; }
    hide() { this.visible = false; } show() { this.visible = true; } showInactive() { this.visible = true; } focus() {}
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
    getMediaSourceId() { return 'window:' + this.id + ':0'; }
    getNativeWindowHandle() { const output = Buffer.alloc(8); output.writeBigUInt64LE(BigInt(this.id)); return output; }
    loadURL = vi.fn(async () => { await mock.boundaryLoad?.(); });
    setOpacity = vi.fn(); setMinimumSize = vi.fn(); setSize = vi.fn(); setBounds = vi.fn(); setResizable = vi.fn(); setMovable = vi.fn(); setContentProtection = vi.fn(); setAlwaysOnTop = vi.fn(); setIgnoreMouseEvents = vi.fn(); setShape = vi.fn(); moveTop = vi.fn(); removeMenu = vi.fn();
  }
  const scope = { protocol: { handle: vi.fn((_scheme: string, fn: unknown) => { mock.scope.preview = fn; }), unhandle: vi.fn() }, setPermissionCheckHandler: (fn: unknown) => { mock.scope.check = fn; }, setPermissionRequestHandler: (fn: unknown) => { mock.scope.permission = fn; }, setDisplayMediaRequestHandler: (fn: unknown) => { mock.scope.display = fn; } };
  const image = { isEmpty: () => false, toPNG: () => mock.png, toDataURL: () => 'data:image/png;base64,' + mock.png.toString('base64') };
  return { BrowserWindow: Window, app: { getPath: () => 'unused' }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    globalShortcut: { register: vi.fn((key: string, callback: () => void) => { mock.callbacks.set(key, callback); return true; }), unregister: vi.fn() },
    desktopCapturer: { getSources: vi.fn(async () => [{ id: 'screen:1:0', name: 'Screen', display_id: '1', thumbnail: image }]) },
    session: { fromPartition: vi.fn(() => scope) }, nativeImage: { createFromBuffer: () => image }, clipboard: { writeImage: vi.fn(), readText: vi.fn(() => 'Clipboard selection'), writeText: vi.fn() },
    shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => ''), openExternal: vi.fn(async () => undefined) }, powerMonitor: new EventEmitter(),
    screen: { getCursorScreenPoint: () => ({ x: 20, y: 30 }),
      getDisplayNearestPoint: () => ({ id: 1, size: { width: 2160, height: 1354 }, bounds: { x: 0, y: 0, width: 2160, height: 1354 }, workArea: { x: 0, y: 0, width: 2160, height: 1314 }, scaleFactor: 1 }),
      getAllDisplays: () => [{ id: 1, size: { width: 2160, height: 1354 }, bounds: { x: 0, y: 0, width: 2160, height: 1354 }, workArea: { x: 0, y: 0, width: 2160, height: 1314 }, scaleFactor: 1 }],
      screenToDipRect: (_window: unknown, rect: unknown) => rect, dipToScreenRect: (_window: unknown, rect: unknown) => rect },
  };
});
vi.mock('../../src/main/capture-tools/visual-answer', () => ({ getCaptureAiState: () => ({ configured: true, model: 'vision-test', visionSupported: true }),
  answerCaptureImage: vi.fn(async () => 'Answer from image') }));
vi.mock('../../src/main/capture-tools/text-answer', () => ({ answerSelectedText: vi.fn(async () => 'Answer from selected text') }));
vi.mock('../../src/main/capture-tools/windows-snapshot', () => ({ windowsSnapshot: vi.fn(async () => undefined) }));
vi.mock('../../src/main/capture-tools/selected-text', async importOriginal => ({ ...await importOriginal<typeof SelectedText>(), readFocusedSelectedText: vi.fn(async () => 'Native selected text') }));
vi.mock('../../src/main/capture-tools/desktop-regions', async importOriginal => ({ ...await importOriginal<typeof DesktopRegions>(), readWindowsCaptureMonitor: vi.fn(() => undefined), positionCaptureWindowInPhysicalPixels: vi.fn(() => true), readWindowsDesktopRegions: vi.fn(() => ({ available: true, windows: [{ id: 'window:123', name: 'External editor', bounds: { x: 100, y: 100, width: 800, height: 600 } }] })) }));
const roots: string[] = [];
const services: CaptureToolsService[] = [];
beforeEach(async () => { mock.windows.length = 0; mock.scope = {}; mock.callbacks.clear(); mock.boundaryLoad = undefined; vi.clearAllMocks(); mock.png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123456' } }).png().toBuffer(); });
afterEach(async () => { for (const service of services.splice(0)) await service.shutdown(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function event(window: BrowserWindow, frame = window.webContents.mainFrame) { return { sender: window.webContents, senderFrame: frame } as IpcMainInvokeEvent; }
async function fixture(validateShortcuts?: (settings: CaptureToolsSettings) => void, onStateChanged?: CaptureToolsServiceOptions['onStateChanged']) {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-capture-service-')); roots.push(root);
  const main = new BrowserWindow({}); const saveToLibrary = vi.fn<() => Promise<void>>(async () => undefined);
  const source: CaptureImageSource = { dataUrl: 'data:image/png;base64,' + mock.png.toString('base64'), width: 64, height: 64, title: 'Provided browser', url: 'https://actual.example/page' };
  const captureBrowser = vi.fn(async () => source);
  const readBrowserSelection = vi.fn(async () => 'Actual browser selection');
  const service: CaptureToolsService = new CaptureToolsService({ root, downloadPath: path.join(root, 'Downloads'), getMainWindow: () => main, preloadPath: 'minimal-preload.js', loadWindow: async window => {
    expect(window.isVisible()).toBe(false);
    expect((await service.handle(event(main), { type: 'surface.ready' })).ok).toBe(false);
    expect((await service.handle(event(window, {} as Electron.WebFrameMain), { type: 'surface.ready' })).ok).toBe(false);
    expect((await service.handle(event(window), { type: 'surface.ready' })).ok).toBe(true);
    expect(window.isVisible()).toBe(false);
  },
    getModelConfig: () => ({ apiFormat: 'openai_chat', model: 'vision-test', apiKey: 'SECRET' }), saveToLibrary, getFfmpeg: () => undefined, readBrowserSelection, validateShortcuts, onStateChanged });
  services.push(service); await service.init(); await service.open('screenshot', source, captureBrowser);
  const tool = mock.windows.at(-1) as BrowserWindow;
  return { service, root, main, tool, source, saveToLibrary, captureBrowser, readBrowserSelection };
}
function handler(name: string) { return mock.scope[name] as (...args: unknown[]) => unknown; }

describe('isolated capture tools authorization and settings', () => {
  it('starts long capture from a fresh native screen without enumerating a fake source ID', async () => {
    const { service } = await fixture();
    vi.mocked(windowsSnapshot).mockResolvedValueOnce(mock.png);
    await service.open('screenshot'); const tool = mock.windows.at(-1) as BrowserWindow;
    const result = await service.handle(event(tool), { type: 'long.begin', rect: { x: 0, y: 0, width: 32, height: 64 } });
    expect(result).toMatchObject({ ok: true, long: { frames: 1, width: 32, height: 64 } });
  });
  it('sends cumulative bounded answer progress only to the requesting tool and flushes its final snapshot', async () => {
    const changed = vi.fn(); const { service, main, tool, source } = await fixture(undefined, changed);
    let emit!: (update: CaptureAnswerUpdate) => void, resolve!: (text: string) => void;
    vi.mocked(answerCaptureImage).mockImplementationOnce(options => { emit = options.onUpdate!; return new Promise<string>(done => { resolve = done; }); });
    vi.mocked(tool.webContents.send).mockClear(); vi.mocked(main.webContents.send).mockClear(); changed.mockClear();
    const pending = service.handle(event(tool), { type: 'screenshot.ask', id: 'stream-one', dataUrl: source.dataUrl, messages: [{ role: 'user', content: 'Explain' }] });
    await vi.waitFor(() => expect(emit).toBeTypeOf('function'));
    emit({ text: '', reasoning: 'Provider summary' });
    emit({ text: '**Partial**', reasoning: 'Provider summary' });
    emit({ text: 'bad'.repeat(20000), reasoning: '' });
    expect(tool.webContents.send).toHaveBeenCalledTimes(1);
    expect(tool.webContents.send).toHaveBeenLastCalledWith(CAPTURE_TOOLS_ANSWER_PROGRESS, { id: 'stream-one', sequence: 1, text: '', reasoning: 'Provider summary' });
    resolve('**Final**'); expect(await pending).toMatchObject({ ok: true, text: '**Final**' });
    expect(tool.webContents.send).toHaveBeenCalledTimes(2);
    expect(tool.webContents.send).toHaveBeenLastCalledWith(CAPTURE_TOOLS_ANSWER_PROGRESS, { id: 'stream-one', sequence: 2, text: '**Final**', reasoning: 'Provider summary' });
    expect(main.webContents.send).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
    expect(JSON.stringify(service.state())).not.toContain('Provider summary');
    emit({ text: 'late', reasoning: 'late' }); expect(tool.webContents.send).toHaveBeenCalledTimes(2);
  });
  it('drops queued and late reasoning after cancellation and after replacing the temporary window', async () => {
    const { service, tool } = await fixture();
    let emit!: (update: CaptureAnswerUpdate) => void, resolve!: (text: string) => void;
    vi.mocked(answerSelectedText).mockImplementationOnce(options => { emit = options.onUpdate!; return new Promise<string>(done => { resolve = done; }); });
    const pending = service.handle(event(tool), { type: 'selection.ask', id: 'cancel-stream', selection: 'Selected text', messages: [{ role: 'user', content: 'Explain' }] });
    await vi.waitFor(() => expect(emit).toBeTypeOf('function'));
    vi.mocked(tool.webContents.send).mockClear(); emit({ text: '', reasoning: 'First' }); emit({ text: 'queued', reasoning: 'First' });
    await service.handle(event(tool), { type: 'ask.cancel', id: 'cancel-stream' });
    await service.handle(event(tool), { type: 'close' }); await service.open('selection'); const next = mock.windows.at(-1) as BrowserWindow;
    vi.mocked(next.webContents.send).mockClear(); emit({ text: 'late', reasoning: 'late' }); resolve('late');
    expect(await pending).toMatchObject({ ok: false });
    await new Promise(done => setTimeout(done, 55));
    expect(vi.mocked(tool.webContents.send).mock.calls.filter(([channel]) => channel === CAPTURE_TOOLS_ANSWER_PROGRESS)).toHaveLength(1);
    expect(next.webContents.send).not.toHaveBeenCalled();
  });
  it('opens only explicit safe web links from its isolated main frame', async () => {
    const { service, main, tool } = await fixture(); const safe = { type: 'link.open', url: 'https://example.com/docs?q=test' };
    expect((await service.handle(event(main), safe)).ok).toBe(false);
    expect((await service.handle(event(tool, {} as Electron.WebFrameMain), safe)).ok).toBe(false);
    for (const url of ['javascript:alert(1)', 'file:///C:/private.txt', 'data:text/html,hello', 'https://user:secret@example.com']) expect((await service.handle(event(tool), { type: 'link.open', url })).ok).toBe(false);
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect((await service.handle(event(tool), safe)).ok).toBe(true); expect(shell.openExternal).toHaveBeenCalledWith(safe.url);
    vi.mocked(shell.openExternal).mockRejectedValueOnce(Error('private system failure'));
    expect(await service.handle(event(tool), safe)).toEqual({ ok: false, error: '无法打开链接，请检查系统默认浏览器。' });
  });
  it('rechecks the requesting tool identity after asynchronous initialization', async () => {
    const { service, tool } = await fixture();
    const pending = service.handle(event(tool), { type: 'link.open', url: 'https://example.com' }); tool.destroy();
    expect(await pending).toEqual({ ok: false, error: '问答窗口已关闭。' }); expect(shell.openExternal).not.toHaveBeenCalled();
  });
  it('rejects a global hotkey owned by application shortcuts before saving or replacing registrations', async () => {
    const validate = vi.fn(() => { throw Error('Application shortcut conflict'); });
    const { service, main, root } = await fixture(validate);
    const settings = structuredClone(DEFAULT_CAPTURE_TOOLS_SETTINGS); settings.shortcuts.screenshot = 'Control+Shift+S';
    vi.mocked(globalShortcut.unregister).mockClear();
    expect(await service.handle(event(main), { type: 'settings.save', settings })).toMatchObject({ ok: false, error: 'Application shortcut conflict' });
    expect(validate).toHaveBeenCalledOnce(); expect(service.state().settings).toEqual(DEFAULT_CAPTURE_TOOLS_SETTINGS);
    expect(globalShortcut.unregister).not.toHaveBeenCalled();
    await expect(readFile(path.join(root, 'settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('limits main UI to settings/open/state and rejects web contents from another window or an iframe', async () => {
    const { service, main, tool, source } = await fixture();
    expect((await service.handle(event(main), { type: 'state' })).ok).toBe(true);
    expect((await service.handle(event(main), { type: 'screenshot.save', dataUrl: source.dataUrl, destination: 'downloads' })).ok).toBe(false);
    expect((await service.handle(event(tool, {} as Electron.WebFrameMain), { type: 'context' })).ok).toBe(false);
    expect((await service.handle(event(new BrowserWindow({})), { type: 'context' })).ok).toBe(false);
    const context = await service.handle(event(tool), { type: 'context' }); expect(context.ok && context.source?.url).toBe(source.url);
    expect(JSON.stringify(context)).not.toContain('SECRET');
    const options = (tool as unknown as { options: { webPreferences: Record<string, unknown> } }).options.webPreferences;
    expect(options).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, additionalArguments: ['--worldlinebox-capture-tools'] });
  });

  it('saves normalized PNG without overwriting and only reveals known files or its exact Downloads directory', async () => {
    const { service, tool, main, source, root } = await fixture();
    const first = await service.handle(event(tool), { type: 'screenshot.save', dataUrl: source.dataUrl, filename: '../image.exe', destination: 'downloads' });
    const second = await service.handle(event(tool), { type: 'screenshot.save', dataUrl: source.dataUrl, filename: '../image.exe', destination: 'downloads' });
    expect(first.ok && first.path).not.toBe(second.ok && second.path);
    if (!first.ok || !first.path) throw Error('No saved file');
    expect(path.dirname(first.path)).toBe(path.join(root, 'Downloads')); expect(path.extname(first.path)).toBe('.png'); expect((await sharp(await readFile(first.path)).metadata()).format).toBe('png');
    expect((await service.handle(event(tool), { type: 'reveal', path: path.join(root, 'private-secret') })).ok).toBe(false);
    expect((await service.handle(event(tool), { type: 'reveal', path: first.path })).ok).toBe(true); expect(shell.showItemInFolder).toHaveBeenCalledWith(first.path);
    const downloads = service.state().downloadPath;
    expect((await service.handle(event(main), { type: 'reveal', path: downloads })).ok).toBe(true); expect(shell.openPath).toHaveBeenCalledWith(downloads);
    expect((await service.handle(event(main), { type: 'reveal', path: root })).ok).toBe(false);
  });

  it('waits for the asset import before reporting screenshot save success', async () => {
    const { service, tool, source, saveToLibrary } = await fixture(); let release!: () => void; let settled = false;
    saveToLibrary.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const saving = service.handle(event(tool), { type: 'screenshot.save', dataUrl: source.dataUrl, destination: 'library' }).then(result => { settled = true; return result; });
    for (let count = 0; !release && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(settled).toBe(false); release(); expect((await saving).ok).toBe(true);
    expect((await readdir(service.state().downloadPath).catch(() => []))).toEqual([]);
  });

  it('persists settings immediately and rejects bare keys and equivalent duplicate accelerators', async () => {
    const { service, main, root } = await fixture(); const settings = structuredClone(DEFAULT_CAPTURE_TOOLS_SETTINGS);
    settings.hideApp = false; settings.shortcuts.screenshot = 'Control+Alt+P';
    expect((await service.handle(event(main), { type: 'settings.save', settings })).ok).toBe(true);
    expect(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')).hideApp).toBe(false);
    expect(globalShortcut.unregister).toHaveBeenCalled(); expect(globalShortcut.register).toHaveBeenCalledWith('Control+Alt+P', expect.any(Function));
    settings.shortcuts.ocr = 'Alt+Ctrl+P'; expect((await service.handle(event(main), { type: 'settings.save', settings })).ok).toBe(false);
    settings.shortcuts.ocr = 'X'; expect((await service.handle(event(main), { type: 'settings.save', settings })).ok).toBe(false);
    expect(canonicalCaptureShortcut('Control+Alt+P')).toBe(canonicalCaptureShortcut('Alt+Ctrl+P'));
  });

  it('routes the retired browser capture request to the real desktop overlay and hides the application', async () => {
    const { service, main, captureBrowser } = await fixture();
    const opened = await service.handle(event(main), { type: 'open', task: 'screenshot', source: 'browser' });
    expect(opened.ok && opened.source?.desktop).toBeTruthy(); expect(opened.ok && opened.source?.url).toBe('');
    expect(captureBrowser).not.toHaveBeenCalled(); expect(desktopCapturer.getSources).toHaveBeenCalled(); expect(main.isVisible()).toBe(false);
  });

  it('opens a real screen as a frameless display overlay including the taskbar and remains remotely capturable', async () => {
    const { service, main } = await fixture();
    const response = await service.open('screenshot');
    const tool = mock.windows.at(-1) as BrowserWindow;
    expect(response.ok && response.source?.desktop).toMatchObject({ displayId: '1', bounds: { x: 0, y: 0, width: 2160, height: 1354 },
      workArea: { x: 0, y: 0, width: 2160, height: 1314 }, cursor: { x: 20, y: 30 }, windowSnapping: true });
    expect(response.ok && response.source?.desktop?.candidates.map(candidate => candidate.kind)).toEqual(['window', 'workarea', 'screen']);
    expect((tool as unknown as { options: unknown }).options).toMatchObject({ frame: false, thickFrame: false, resizable: true, movable: false, skipTaskbar: true, enableLargerThanScreen: true,
      x: 0, y: 0, width: 2160, height: 1354, minWidth: 1, minHeight: 1 });
    expect(tool.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 2160, height: 1354 });
    expect(tool.setContentProtection).toHaveBeenCalledWith(false); expect(tool.setContentProtection).not.toHaveBeenCalledWith(true);
    expect(main.isVisible()).toBe(false);
    await service.handle(event(tool), { type: 'close' }); expect(main.isVisible()).toBe(true);
  });

  it('keeps every utility type remotely visible, including selection and recording controls', async () => {
    const { service } = await fixture();
    for (const task of ['selection', 'recording', 'ocr', 'translate', 'long-screenshot'] as const) {
      await service.open(task); const tool = mock.windows.at(-1) as BrowserWindow;
      expect(tool.setContentProtection).toHaveBeenCalledWith(false); expect(tool.setContentProtection).not.toHaveBeenCalledWith(true);
      if (task === 'recording') expect((await service.handle(event(tool), { type: 'context' })).ok).toBe(true);
    }
  });

  it('requests exact rcMonitor pixels and corrects native overlay placement instead of resampling rounded DIP sizes', async () => {
    const { service } = await fixture();
    const native = { bounds: { x: 0, y: 0, width: 2560, height: 1600 }, workArea: { x: 0, y: 0, width: 2560, height: 1528 } };
    vi.mocked(readWindowsCaptureMonitor).mockReturnValueOnce(native);
    const response = await service.open('screenshot');
    const tool = mock.windows.at(-1) as BrowserWindow;
    expect(response.ok && response.source?.desktop?.pixelBounds).toEqual(native.bounds);
    expect(desktopCapturer.getSources).toHaveBeenLastCalledWith(expect.objectContaining({ thumbnailSize: { width: 2560, height: 1600 } }));
    expect(positionCaptureWindowInPhysicalPixels).toHaveBeenLastCalledWith(tool.getNativeWindowHandle(), native.bounds);
  });

  it('reuses one ephemeral session across repeated tool windows while rejecting their previous owners', async () => {
    const { service, source, captureBrowser } = await fixture();
    const scope = vi.mocked(session.fromPartition).mock.results[0]!.value;
    let tool = mock.windows.at(-1) as BrowserWindow;
    for (let count = 0; count < 3; count++) {
      const previous = tool;
      expect((await service.handle(event(previous), { type: 'close' })).ok).toBe(true);
      await service.open('screenshot', source, captureBrowser); tool = mock.windows.at(-1) as BrowserWindow;
      expect((await service.handle(event(previous), { type: 'context' })).ok).toBe(false);
      const context = await service.handle(event(tool), { type: 'context' }); expect(context.ok && context.source?.url).toBe(source.url);
      const preferences = (tool as unknown as { options: { webPreferences: Record<string, unknown> } }).options.webPreferences;
      expect(preferences).toMatchObject({ session: scope, sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ['--worldlinebox-capture-tools'] });
      const denied = vi.fn(); handler('display')({ frame: tool.webContents.mainFrame, videoRequested: true, audioRequested: true }, denied); expect(denied).toHaveBeenCalledWith({});
    }
    expect(session.fromPartition).toHaveBeenCalledTimes(1);
  });
});

describe('temporary selected text assistant', () => {
  it('opens a small normal window near the pointer, keeps the main app visible and pins only by explicit owned request', async () => {
    const { service, main } = await fixture(); await service.openSelection('Foreground selected text'); const tool = mock.windows.at(-1) as BrowserWindow;
    expect(main.isVisible()).toBe(true); expect(service.state().selectionPinned).toBe(false);
    expect((tool as unknown as { options: unknown }).options).toMatchObject({ x: 38, y: 48, width: 420, height: 520, minWidth: 340, minHeight: 360, resizable: true, frame: false });
    expect(tool.setAlwaysOnTop).toHaveBeenCalledWith(false, 'floating');
    for (const actor of [event(main), event(tool, {} as Electron.WebFrameMain), event(new BrowserWindow({}))]) {
      expect((await service.handle(actor, { type: 'selection.pin', pinned: true })).ok).toBe(false);
    }
    expect((await service.handle(event(tool), { type: 'selection.pin', pinned: true })).ok).toBe(true);
    expect(tool.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'floating'); expect(service.state().selectionPinned).toBe(true);
    expect((await service.handle(event(tool), { type: 'selection.pin', pinned: false })).ok).toBe(true);
    expect(tool.setAlwaysOnTop).toHaveBeenLastCalledWith(false, 'floating');
    await service.handle(event(tool), { type: 'close' }); await service.openSelection('New session');
    expect(service.state().selectionPinned).toBe(false);
  });

  it('reads native selection before changing tool focus and ignores a background main window browser selection', async () => {
    const { service, main, tool, readBrowserSelection } = await fixture();
    expect(main.isFocused()).toBe(false);
    vi.mocked(readFocusedSelectedText).mockImplementationOnce(async () => { expect(tool.isDestroyed()).toBe(false); return 'Native foreground selection'; });
    await service.open('selection'); const selectedTool = mock.windows.at(-1) as BrowserWindow;
    const context = await service.handle(event(selectedTool), { type: 'context' }); expect(context.ok && context.text).toBe('Native foreground selection');
    expect(readBrowserSelection).not.toHaveBeenCalled(); expect(desktopCapturer.getSources).not.toHaveBeenCalled(); expect(clipboard.readText).not.toHaveBeenCalled();
  });

  it('prefers actual browser selected text only when the main window is focused and supports an explicit browser launch', async () => {
    const { service, main, readBrowserSelection } = await fixture(); (main as unknown as { focused: boolean }).focused = true;
    await service.open('selection'); let tool = mock.windows.at(-1) as BrowserWindow;
    let context = await service.handle(event(tool), { type: 'context' }); expect(context.ok && context.text).toBe('Actual browser selection'); expect(readFocusedSelectedText).not.toHaveBeenCalled();
    expect(readBrowserSelection).toHaveBeenCalledOnce();
    await service.handle(event(tool), { type: 'close' }); (main as unknown as { focused: boolean }).focused = false;
    const opened = await service.handle(event(main), { type: 'open', task: 'selection', source: 'browser' }); expect(opened.ok && opened.text).toBe('Actual browser selection');
    tool = mock.windows.at(-1) as BrowserWindow; context = await service.handle(event(tool), { type: 'context' }); expect(context.ok && context.text).toBe('Actual browser selection');
    expect(readBrowserSelection).toHaveBeenCalledTimes(2); expect(readFocusedSelectedText).not.toHaveBeenCalled();
  });

  it('requires the owned main frame for text inference and explicit clipboard actions, and never persists conversation text', async () => {
    const { service, main, root } = await fixture(); await service.openSelection('Temporary reference'); const tool = mock.windows.at(-1) as BrowserWindow;
    const ask = { type: 'selection.ask', id: 'text-answer', selection: 'Edited reference', messages: [{ role: 'user', content: 'Explain it' }] };
    for (const input of [ask, { type: 'selection.clipboard' }, { type: 'selection.copy', text: 'Answer' }]) {
      expect((await service.handle(event(main), input)).ok).toBe(false);
      expect((await service.handle(event(tool, {} as Electron.WebFrameMain), input)).ok).toBe(false);
    }
    const answer = await service.handle(event(tool), ask); expect(answer.ok && answer.text).toBe('Answer from selected text');
    expect(answerSelectedText).toHaveBeenCalledWith(expect.objectContaining({ selection: 'Edited reference', messages: ask.messages }));
    expect((await service.handle(event(tool), { type: 'selection.clipboard' })).ok).toBe(true); expect(clipboard.readText).toHaveBeenCalledOnce();
    expect((await service.handle(event(tool), { type: 'selection.copy', text: 'Copied answer' })).ok).toBe(true); expect(clipboard.writeText).toHaveBeenCalledWith('Copied answer');
    await service.handle(event(tool), { type: 'close' }); await service.openSelection('');
    const next = mock.windows.at(-1) as BrowserWindow; const context = await service.handle(event(next), { type: 'context' }); expect(context.ok && context.text).toBe('');
    expect(await readdir(root)).toEqual([]);
  });
});

describe('global shortcut key capture lifecycle', () => {
  async function focusedFixture() {
    const value = await fixture(); (value.main as unknown as { focused: boolean }).focused = true; return value;
  }
  it('rejects a delayed capture request after the main window has already lost focus', async () => {
    const { service, main } = await fixture(); expect(main.isFocused()).toBe(false);
    vi.mocked(globalShortcut.unregister).mockClear();
    expect(await service.handle(event(main), { type: 'shortcuts.capture', active: true })).toMatchObject({ ok: false, error: expect.stringContaining('切回主窗口') });
    expect(globalShortcut.unregister).not.toHaveBeenCalled(); expect(main.listenerCount('blur')).toBe(0);
    expect(main.webContents.listenerCount('render-process-gone')).toBe(0);
  });

  it.each(['render-process-gone', 'destroyed'] as const)('restores shortcuts when focused main contents emit %s without a window blur', async reason => {
    const { service, main } = await focusedFixture();
    await service.handle(event(main), { type: 'shortcuts.capture', active: true }); vi.mocked(globalShortcut.register).mockClear();
    const revision = service.state().revision;
    main.webContents.emit(reason);
    expect(main.isFocused()).toBe(true); expect(globalShortcut.register).toHaveBeenCalledTimes(6);
    expect(service.state().revision).toBeGreaterThan(revision);
    expect(main.webContents.send).toHaveBeenLastCalledWith('worldlinebox:capture-tools:changed', expect.objectContaining({ shortcuts: expect.arrayContaining([expect.objectContaining({ task: 'screenshot', registered: true })]) }));
    for (const name of ['render-process-gone', 'destroyed', 'did-start-navigation']) expect(main.webContents.listenerCount(name)).toBe(0);
    expect(main.listenerCount('blur')).toBe(0); expect(main.listenerCount('closed')).toBe(0);
  });

  it('ignores iframe and same-document navigation but restores on a main document reload and removes all listeners', async () => {
    const { service, main } = await focusedFixture(); await service.handle(event(main), { type: 'shortcuts.capture', active: true }); vi.mocked(globalShortcut.register).mockClear();
    main.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    main.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(globalShortcut.register).not.toHaveBeenCalled(); expect(main.webContents.listenerCount('did-start-navigation')).toBe(1);
    main.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); expect(globalShortcut.register).toHaveBeenCalledTimes(6);
    for (const name of ['render-process-gone', 'destroyed', 'did-start-navigation']) expect(main.webContents.listenerCount(name)).toBe(0);
    await service.handle(event(main), { type: 'shortcuts.capture', active: true }); expect(main.webContents.listenerCount('did-start-navigation')).toBe(1);
    await service.shutdown();
    for (const name of ['render-process-gone', 'destroyed', 'did-start-navigation']) expect(main.webContents.listenerCount(name)).toBe(0);
  });

  it('suspends only owned shortcuts from the main frame, keeps them suspended while saving and restores on blur', async () => {
    const { service, main, tool } = await focusedFixture();
    expect((await service.handle(event(tool), { type: 'shortcuts.capture', active: true })).ok).toBe(false);
    expect((await service.handle(event(main, {} as Electron.WebFrameMain), { type: 'shortcuts.capture', active: true })).ok).toBe(false);
    vi.mocked(globalShortcut.unregister).mockClear(); vi.mocked(globalShortcut.register).mockClear();
    expect((await service.handle(event(main), { type: 'shortcuts.capture', active: true })).ok).toBe(true);
    expect(globalShortcut.unregister).toHaveBeenCalledTimes(6);
    expect(globalShortcut.unregister).not.toHaveBeenCalledWith('Another applications shortcut');
    const settings = structuredClone(DEFAULT_CAPTURE_TOOLS_SETTINGS); settings.shortcuts.selection = 'Control+Alt+F11';
    expect((await service.handle(event(main), { type: 'settings.save', settings })).ok).toBe(true); expect(globalShortcut.register).not.toHaveBeenCalled();
    main.emit('blur');
    expect(globalShortcut.register).toHaveBeenCalledWith('Control+Alt+F11', expect.any(Function));
    expect(service.state().shortcuts.find(value => value.task === 'selection')).toMatchObject({ accelerator: 'Control+Alt+F11', registered: true });
    expect(main.listenerCount('blur')).toBe(0); expect(main.listenerCount('closed')).toBe(0);
  });

  it('restores shortcut registration when the setting ends, refuses suspension during recording and removes listeners on shutdown', async () => {
    const { service, main, tool } = await focusedFixture();
    await service.handle(event(main), { type: 'shortcuts.capture', active: true });
    await service.handle(event(main), { type: 'shortcuts.capture', active: false }); expect(main.listenerCount('blur')).toBe(0);
    const recording = await service.handle(event(tool), { type: 'recording.prepare', sourceId: 'screen:1:0', format: 'webm', systemAudio: false, microphone: false });
    expect(recording.ok).toBe(true);
    expect(await service.handle(event(main), { type: 'shortcuts.capture', active: true })).toMatchObject({ ok: false, error: expect.stringContaining('先结束录屏') });
    if (recording.ok && recording.id) await service.handle(event(tool), { type: 'recording.cancel', id: recording.id });
    await service.handle(event(main), { type: 'shortcuts.capture', active: true }); expect(main.listenerCount('blur')).toBe(1);
    await service.shutdown(); expect(main.listenerCount('blur')).toBe(0); expect(main.listenerCount('closed')).toBe(0);
  });
});

describe('desktop recording grants', () => {
  it.each(['saved', 'failed'] as const)('permits native player fullscreen only for an owned %s recording result main frame', async status => {
    const { service, main, tool: previous } = await fixture(); await service.open('recording'); const tool = mock.windows.at(-1) as BrowserWindow;
    const permitted = (contents: unknown, isMainFrame = true) => {
      const check = handler('check')(contents, 'fullscreen', '', { isMainFrame });
      const reply = vi.fn(); handler('permission')(contents, 'fullscreen', reply, { isMainFrame });
      expect(reply).toHaveBeenCalledWith(check); return check;
    };
    expect(permitted(tool.webContents)).toBe(false);
    const prepared = await service.handle(event(tool), { type: 'recording.prepare', sourceId: 'screen:1:0', format: 'webm', systemAudio: false, microphone: false });
    if (!prepared.ok || !prepared.id) throw Error('Recording did not prepare'); const id = prepared.id;
    expect(permitted(tool.webContents)).toBe(false);
    await service.handle(event(tool), { type: 'recording.chunk', id, sequence: 0, chunk: status === 'saved' ? Buffer.from('1a45dfa3010203040506', 'hex') : Buffer.from([0x1a]) });
    const finished = await service.handle(event(tool), { type: 'recording.finish', id }); expect(finished.ok).toBe(status === 'saved');
    expect(permitted(tool.webContents)).toBe(false);
    const result = await service.handle(event(tool), { type: 'recording.preview', id }); expect(result.ok).toBe(true);
    expect(permitted(tool.webContents)).toBe(true);
    for (const contents of [main.webContents, previous.webContents, {}, null]) expect(permitted(contents)).toBe(false);
    expect(permitted(tool.webContents, false)).toBe(false);
    expect(handler('check')(tool.webContents, 'media', '', { isMainFrame: true, mediaType: 'video' })).toBe(false);
    expect((await service.handle(event(tool), { type: 'screenshot.capture' })).ok).toBe(true);
    expect(permitted(tool.webContents)).toBe(false);
    await service.open('screenshot'); const screenshot = mock.windows.at(-1) as BrowserWindow;
    expect(permitted(tool.webContents)).toBe(false); expect(permitted(screenshot.webContents)).toBe(false);
    expect((await service.handle(event(screenshot), { type: 'recording.preview', id })).ok).toBe(true);
    expect(permitted(screenshot.webContents)).toBe(false);
  });
  it('allows result playback and system opening only for the owned tool frame and revokes URLs before another capture', async () => {
    const { service, main } = await fixture(); await service.open('recording'); const tool = mock.windows.at(-1) as BrowserWindow;
    const prepared = await service.handle(event(tool), { type: 'recording.prepare', sourceId: 'screen:1:0', format: 'webm', systemAudio: false, microphone: false });
    if (!prepared.ok || !prepared.id) throw Error('Recording did not prepare'); const id = prepared.id;
    expect((await service.handle(event(tool), { type: 'recording.preview', id })).ok).toBe(false);
    const bytes = Buffer.from('1a45dfa3010203040506', 'hex');
    await service.handle(event(tool), { type: 'recording.chunk', id, sequence: 0, chunk: bytes });
    const finished = await service.handle(event(tool), { type: 'recording.finish', id }); expect(finished.ok).toBe(true);
    for (const type of ['recording.preview', 'recording.open']) {
      expect((await service.handle(event(main), { type, id })).ok).toBe(false);
      expect((await service.handle(event(tool, {} as Electron.WebFrameMain), { type, id })).ok).toBe(false);
      expect((await service.handle(event(tool), { type, id: 'unknown' })).ok).toBe(false);
    }
    const result = await service.handle(event(tool), { type: 'recording.preview', id });
    if (!result.ok || !result.preview) throw Error('No recording preview');
    expect(result.preview).toMatchObject({ mimeType: 'video/webm', bytes: bytes.length });
    const respond = mock.scope.preview as (request: Request) => Promise<Response>;
    const range = await respond(new Request(result.preview.url, { headers: { Range: 'bytes=1-3' } }));
    expect(range.status).toBe(206); expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(1, 4));
    expect((await service.handle(event(tool), { type: 'recording.open', id })).ok).toBe(true);
    expect(shell.openPath).toHaveBeenCalledWith(finished.ok && finished.path);
    const next = await service.handle(event(tool), { type: 'recording.prepare', sourceId: 'screen:1:0', format: 'webm', systemAudio: false, microphone: false });
    expect((await respond(new Request(result.preview.url))).status).toBe(404);
    if (next.ok && next.id) await service.handle(event(tool), { type: 'recording.cancel', id: next.id });
  });
  it('shows one transparent click-through canvas for outside-crop range borders and destroys it on stop/cancel', async () => {
    const { service } = await fixture(); await service.open('recording'); const tool = mock.windows.at(-1) as BrowserWindow;
    const prepared = await service.handle(event(tool), { type: 'recording.prepare', sourceId: 'screen:1:0', format: 'webm', systemAudio: false, microphone: false,
      rect: { x: 8, y: 8, width: 32, height: 32 } });
    if (!prepared.ok || !prepared.id) throw Error('No prepared regional recording');
    const lines = (mock.windows as BrowserWindow[]).filter(window => (window as unknown as { options: { title?: string } }).options.title === 'WorldlineBox · 录制范围');
    expect(lines).toHaveLength(1);
    for (const line of lines) {
      expect((line as unknown as { options: unknown }).options).toMatchObject({ x: 0, y: 0, width: 2160, height: 1354,
        frame: false, thickFrame: false, focusable: false, hasShadow: false, skipTaskbar: true, transparent: true, backgroundColor: '#00000000',
        webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
      const prefs = (line as unknown as { options: { webPreferences: Record<string, unknown> } }).options.webPreferences;
      expect(prefs).not.toHaveProperty('preload');
      const url = vi.mocked(line.loadURL).mock.calls[0]![0]; expect(url).toMatch(/^data:text\/html;charset=utf-8,/);
      expect(decodeURIComponent(url.split(',').slice(1).join(','))).toContain('Content-Security-Policy');
      expect(line.setContentProtection).toHaveBeenCalledWith(false); expect(line.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
      expect(line.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver'); expect(line.moveTop).toHaveBeenCalled();
      expect((await service.handle(event(line), { type: 'state' })).ok).toBe(false);
    }
    service.stopRecording(); expect(lines.every(window => window.isDestroyed())).toBe(true);
    expect(tool.webContents.send).toHaveBeenCalledWith(CAPTURE_TOOLS_STOP_RECORDING);
    await service.handle(event(tool), { type: 'recording.cancel', id: prepared.id });
  });

  it.each(['stop', 'cancel', 'load-rejection'] as const)('does not resurrect a range overlay if %s occurs while its page is loading', async action => {
    const { service } = await fixture(); await service.open('recording'); const tool = mock.windows.at(-1) as BrowserWindow;
    let release!: () => void, reject!: (error: Error) => void;
    mock.boundaryLoad = () => new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
    const preparing = service.handle(event(tool), { type: 'recording.prepare', sourceId: 'screen:1:0', format: 'webm', systemAudio: false, microphone: false,
      rect: { x: 8, y: 8, width: 32, height: 32 } });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const overlay = mock.windows.at(-1) as BrowserWindow;
    const id = service.state().recording!.id;
    if (action === 'cancel') await service.handle(event(tool), { type: 'recording.cancel', id });
    else service.stopRecording();
    if (action === 'load-rejection') reject(Error('Window destroyed while loading')); else release();
    await preparing;
    expect(overlay.isDestroyed()).toBe(true); expect(overlay.isVisible()).toBe(false); expect(overlay.moveTop).not.toHaveBeenCalled();
    if (action !== 'cancel') await service.handle(event(tool), { type: 'recording.cancel', id });
  });

  it('cleans range borders on renderer loss and excludes them from capture sources', async () => {
    const { service } = await fixture(); await service.open('recording'); const tool = mock.windows.at(-1) as BrowserWindow;
    const prepared = await service.handle(event(tool), { type: 'recording.prepare', sourceId: 'screen:1:0', format: 'webm', systemAudio: false, microphone: false,
      rect: { x: 8, y: 8, width: 32, height: 32 } });
    if (!prepared.ok || !prepared.id) throw Error('No prepared regional recording');
    const lines = (mock.windows as BrowserWindow[]).filter(window => (window as unknown as { options: { title?: string } }).options.title === 'WorldlineBox · 录制范围');
    const listed = await desktopCapturer.getSources({ types: ['screen'] });
    vi.mocked(desktopCapturer.getSources).mockResolvedValueOnce([...listed, { ...listed[0]!, id: lines[0]!.getMediaSourceId(), name: 'Recording border' }]);
    const response = await service.handle(event(tool), { type: 'sources.list' });
    expect(response.ok && response.sources?.some(source => source.name === 'Recording border')).toBe(false);
    tool.webContents.emit('render-process-gone'); expect(lines.every(window => window.isDestroyed())).toBe(true);
  });
  it.each(['recording.cancel', 'recording.finish', 'shutdown'] as const)('cleans every native range border on %s', async action => {
    const { service } = await fixture(); await service.open('recording'); const tool = mock.windows.at(-1) as BrowserWindow;
    const prepared = await service.handle(event(tool), { type: 'recording.prepare', sourceId: 'screen:1:0', format: 'webm', systemAudio: false, microphone: false,
      rect: { x: 8, y: 8, width: 32, height: 32 } });
    if (!prepared.ok || !prepared.id) throw Error('No prepared regional recording');
    const lines = (mock.windows as BrowserWindow[]).filter(window => (window as unknown as { options: { title?: string } }).options.title === 'WorldlineBox · 录制范围');
    expect(lines).toHaveLength(1);
    if (action === 'recording.cancel') expect((await service.handle(event(tool), { type: action, id: prepared.id })).ok).toBe(true);
    else {
      let shuttingDown: Promise<void> | undefined;
      if (action === 'shutdown') {
        shuttingDown = service.shutdown(); expect(lines.every(window => window.isDestroyed())).toBe(true);
      }
      expect((await service.handle(event(tool), { type: 'recording.chunk', id: prepared.id, sequence: 0, chunk: Buffer.from('1a45dfa3010203040506', 'hex') })).ok).toBe(true);
      expect((await service.handle(event(tool), { type: 'recording.finish', id: prepared.id })).ok).toBe(true);
      await shuttingDown;
    }
    expect(lines.every(window => window.isDestroyed())).toBe(true);
  });
  it('keeps recording chunks and cancellation working if a tray observer fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const observer = vi.fn(() => { throw Error('A destroyed tray cannot update'); });
      const { service } = await fixture(undefined, observer); await service.open('recording'); const tool = mock.windows.at(-1) as BrowserWindow;
      const prepared = await service.handle(event(tool), { type: 'recording.prepare', sourceId: 'screen:1:0', format: 'webm', systemAudio: false, microphone: false });
      if (!prepared.ok || !prepared.id) throw Error('Recording did not prepare');
      expect((await service.handle(event(tool), { type: 'recording.chunk', id: prepared.id, sequence: 0, chunk: Buffer.from('1a45dfa3010203040506', 'hex') })).ok).toBe(true);
      expect((await service.handle(event(tool), { type: 'recording.cancel', id: prepared.id })).ok).toBe(true);
      expect(observer).toHaveBeenCalled(); expect(warning).toHaveBeenCalledWith('[WorldlineBox capture] Status observer failed.');
    } finally { warning.mockRestore(); }
  });
  it('moves the controller wholly outside a regional recording before granting the stream', async () => {
    const { service } = await fixture(); await service.open('recording'); const tool = mock.windows.at(-1) as BrowserWindow;
    const prepared = await service.handle(event(tool), { type: 'recording.prepare', sourceId: 'screen:1:0', format: 'webm', systemAudio: false, microphone: false,
      rect: { x: 0, y: 0, width: 32, height: 32 } });
    expect(prepared.ok && prepared.recordingControls).toMatchObject({ hidden: false, bounds: { width: 320, height: 44 } });
    expect(tool.isVisible()).toBe(false);
    if (!prepared.ok || !prepared.id || !prepared.recordingControls?.bounds) throw Error('No regional controller');
    expect((await service.handle(event(tool), { type: 'recording.controls.ready', id: 'stale' })).ok).toBe(false);
    expect(tool.isVisible()).toBe(false);
    expect((await service.handle(event(tool), { type: 'recording.controls.ready', id: prepared.id })).ok).toBe(true);
    expect(tool.isVisible()).toBe(true);
    expect(prepared.recordingControls.bounds.y).toBeGreaterThanOrEqual(677);
    expect(tool.setBounds).toHaveBeenLastCalledWith(prepared.recordingControls.bounds);
    await service.handle(event(tool), { type: 'recording.cancel', id: prepared.id });
  });

  it('hides a controller for full monitor recording and restores it after stopping instead of excluding it from sharing', async () => {
    const { service, main } = await fixture(); await service.open('recording'); const tool = mock.windows.at(-1) as BrowserWindow;
    const prepared = await service.handle(event(tool), { type: 'recording.prepare', sourceId: 'screen:1:0', format: 'webm', systemAudio: false, microphone: false });
    expect(prepared.ok && prepared.recordingControls).toEqual({ hidden: true }); expect(tool.isVisible()).toBe(false); expect(main.isVisible()).toBe(false);
    if (!prepared.ok || !prepared.id) throw Error('No prepared recording');
    await service.handle(event(tool), { type: 'recording.cancel', id: prepared.id });
    expect(tool.isVisible()).toBe(true); expect(main.isVisible()).toBe(true);
    expect(tool.setContentProtection).not.toHaveBeenCalledWith(true);
  });
  it('permits Electron 43 empty-media desktop preflight only for a fresh owned main-frame grant', async () => {
    const { service } = await fixture(); await service.open('recording'); const tool = mock.windows.at(-1) as BrowserWindow;
    const check = (contents: unknown, details: Record<string, unknown>) => { const reply = vi.fn(); handler('permission')(contents, 'media', reply, details); return reply; };
    expect(check(tool.webContents, { isMainFrame: true, mediaTypes: [] })).toHaveBeenCalledWith(false);
    const prepared = await service.handle(event(tool), { type: 'recording.prepare', sourceId: 'screen:1:0', format: 'webm', systemAudio: true, microphone: false });
    if (!prepared.ok || !prepared.id) throw Error('Recording did not prepare');
    expect(check(tool.webContents, { isMainFrame: false, mediaTypes: [] })).toHaveBeenCalledWith(false);
    expect(check({}, { isMainFrame: true, mediaTypes: [] })).toHaveBeenCalledWith(false);
    expect(check(tool.webContents, { isMainFrame: true, mediaTypes: ['video'] })).toHaveBeenCalledWith(false);
    expect(check(tool.webContents, { isMainFrame: true, mediaTypes: ['audio'] })).toHaveBeenCalledWith(false);
    expect(check(tool.webContents, { isMainFrame: true })).toHaveBeenCalledWith(false);
    expect(check(tool.webContents, { isMainFrame: true, mediaTypes: [] })).toHaveBeenCalledWith(true);
    expect(check(tool.webContents, { isMainFrame: true, mediaTypes: [] })).toHaveBeenCalledWith(false);
    const stream = vi.fn(); handler('display')({ frame: tool.webContents.mainFrame, videoRequested: true, audioRequested: true }, stream);
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ video: expect.objectContaining({ id: 'screen:1:0' }) }));
    expect(check(tool.webContents, { isMainFrame: true, mediaTypes: [] })).toHaveBeenCalledWith(false);
    await service.handle(event(tool), { type: 'recording.cancel', id: prepared.id });
  });

  it('grants a selected desktop only once to the owned main frame, and only explicitly requested microphone audio', async () => {
    const { service } = await fixture(); await service.open('recording'); const tool = mock.windows.at(-1) as BrowserWindow;
    const prepared = await service.handle(event(tool), { type: 'recording.prepare', sourceId: 'screen:1:0', format: 'webm', systemAudio: true, microphone: true });
    if (!prepared.ok || !prepared.id) throw Error('Recording did not prepare');
    const denied = vi.fn(); handler('display')({ frame: {}, videoRequested: true, audioRequested: true }, denied); expect(denied).toHaveBeenCalledWith({});
    const allowed = vi.fn(); handler('display')({ frame: tool.webContents.mainFrame, videoRequested: true, audioRequested: true }, allowed);
    expect(allowed).toHaveBeenCalledWith(expect.objectContaining({ video: expect.objectContaining({ id: 'screen:1:0' }) }));
    const duplicate = vi.fn(); handler('display')({ frame: tool.webContents.mainFrame, videoRequested: true, audioRequested: false }, duplicate); expect(duplicate).toHaveBeenCalledWith({});
    const camera = vi.fn(); handler('permission')(tool.webContents, 'media', camera, { isMainFrame: true, mediaTypes: ['video'] }); expect(camera).toHaveBeenCalledWith(false);
    const microphone = vi.fn(); handler('permission')(tool.webContents, 'media', microphone, { isMainFrame: true, mediaTypes: ['audio'] }); expect(microphone).toHaveBeenCalledWith(true);
    const twice = vi.fn(); handler('permission')(tool.webContents, 'media', twice, { isMainFrame: true, mediaTypes: ['audio'] }); expect(twice).toHaveBeenCalledWith(false);
    await service.handle(event(tool), { type: 'recording.cancel', id: prepared.id });
    const ended = vi.fn(); handler('display')({ frame: tool.webContents.mainFrame, videoRequested: true, audioRequested: true }, ended); expect(ended).toHaveBeenCalledWith({});
  });

  it('keeps IPC alive long enough to accept the final chunk and finish during shutdown', async () => {
    const { service } = await fixture(); await service.open('recording'); const tool = mock.windows.at(-1) as BrowserWindow;
    const prepared = await service.handle(event(tool), { type: 'recording.prepare', sourceId: 'screen:1:0', format: 'webm', systemAudio: false, microphone: false });
    if (!prepared.ok || !prepared.id) throw Error('Recording did not prepare');
    const id = prepared.id; const stopping = service.shutdown();
    expect(tool.webContents.send).toHaveBeenCalledWith(CAPTURE_TOOLS_STOP_RECORDING);
    expect((await service.handle(event(tool), { type: 'recording.chunk', id, sequence: 0, chunk: Buffer.from('1a45dfa3010203040506', 'hex') })).ok).toBe(true);
    const result = await service.handle(event(tool), { type: 'recording.finish', id }); expect(result.ok).toBe(true);
    await stopping; expect(result.ok && result.path).toBeDefined(); expect(tool.isDestroyed()).toBe(true);
  });
});
