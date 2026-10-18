import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow, clipboard, desktopCapturer, globalShortcut, session, shell, type IpcMainInvokeEvent } from 'electron';
import { CaptureToolsService, canonicalCaptureShortcut } from '../../src/main/capture-tools/service';
import { CAPTURE_TOOLS_STOP_RECORDING, DEFAULT_CAPTURE_TOOLS_SETTINGS, type CaptureImageSource } from '../../src/shared/capture-tools';
import { readFocusedSelectedText } from '../../src/main/capture-tools/selected-text';
import { answerSelectedText } from '../../src/main/capture-tools/text-answer';
import type * as SelectedText from '../../src/main/capture-tools/selected-text';

const mock = vi.hoisted(() => ({ windows: [] as unknown[], png: Buffer.alloc(0), scope: {} as Record<string, unknown>, callbacks: new Map<string, () => void>() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  let nextId = 0;
  class Window extends EventEmitter {
    id = ++nextId; destroyed = false; visible = true; focused = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => this.destroyed, send: vi.fn(), setWindowOpenHandler: vi.fn() });
    constructor(readonly options: unknown) { super(); mock.windows.push(this); }
    static getAllWindows() { return mock.windows; }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isFocused() { return this.focused; }
    hide() { this.visible = false; } show() { this.visible = true; } showInactive() { this.visible = true; } focus() {}
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
    getMediaSourceId() { return 'window:' + this.id + ':0'; }
    setMinimumSize = vi.fn(); setSize = vi.fn(); setContentProtection = vi.fn(); setAlwaysOnTop = vi.fn(); removeMenu = vi.fn();
  }
  const scope = { setPermissionCheckHandler: (fn: unknown) => { mock.scope.check = fn; }, setPermissionRequestHandler: (fn: unknown) => { mock.scope.permission = fn; }, setDisplayMediaRequestHandler: (fn: unknown) => { mock.scope.display = fn; } };
  const image = { isEmpty: () => false, toPNG: () => mock.png, toDataURL: () => 'data:image/png;base64,' + mock.png.toString('base64') };
  return { BrowserWindow: Window, app: { getPath: () => 'unused' }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    globalShortcut: { register: vi.fn((key: string, callback: () => void) => { mock.callbacks.set(key, callback); return true; }), unregister: vi.fn() },
    desktopCapturer: { getSources: vi.fn(async () => [{ id: 'screen:1:0', name: 'Screen', display_id: '1', thumbnail: image }]) },
    session: { fromPartition: vi.fn(() => scope) }, nativeImage: { createFromBuffer: () => image }, clipboard: { writeImage: vi.fn(), readText: vi.fn(() => 'Clipboard selection'), writeText: vi.fn() },
    shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') }, powerMonitor: new EventEmitter(),
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ id: 1 }), getAllDisplays: () => [{ size: { width: 2160, height: 1354 }, scaleFactor: 1 }] },
  };
});
vi.mock('../../src/main/capture-tools/visual-answer', () => ({ getCaptureAiState: () => ({ configured: true, model: 'vision-test', visionSupported: true }),
  answerCaptureImage: vi.fn(async () => 'Answer from image') }));
vi.mock('../../src/main/capture-tools/text-answer', () => ({ answerSelectedText: vi.fn(async () => 'Answer from selected text') }));
vi.mock('../../src/main/capture-tools/selected-text', async importOriginal => ({ ...await importOriginal<typeof SelectedText>(), readFocusedSelectedText: vi.fn(async () => 'Native selected text') }));
const roots: string[] = [];
const services: CaptureToolsService[] = [];
beforeEach(async () => { mock.windows.length = 0; mock.scope = {}; mock.callbacks.clear(); vi.clearAllMocks(); mock.png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123456' } }).png().toBuffer(); });
afterEach(async () => { for (const service of services.splice(0)) await service.shutdown(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function event(window: BrowserWindow, frame = window.webContents.mainFrame) { return { sender: window.webContents, senderFrame: frame } as IpcMainInvokeEvent; }
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-capture-service-')); roots.push(root);
  const main = new BrowserWindow({}); const saveToLibrary = vi.fn<() => Promise<void>>(async () => undefined);
  const source: CaptureImageSource = { dataUrl: 'data:image/png;base64,' + mock.png.toString('base64'), width: 64, height: 64, title: 'Provided browser', url: 'https://actual.example/page' };
  const captureBrowser = vi.fn(async () => source);
  const readBrowserSelection = vi.fn(async () => 'Actual browser selection');
  const service = new CaptureToolsService({ root, downloadPath: path.join(root, 'Downloads'), getMainWindow: () => main, preloadPath: 'minimal-preload.js', loadWindow: async () => undefined,
    getModelConfig: () => ({ apiFormat: 'openai_chat', model: 'vision-test', apiKey: 'SECRET' }), saveToLibrary, getFfmpeg: () => undefined, captureBrowser, readBrowserSelection });
  services.push(service); await service.init(); await service.open('screenshot', source, captureBrowser);
  const tool = mock.windows.at(-1) as BrowserWindow;
  return { service, root, main, tool, source, saveToLibrary, captureBrowser, readBrowserSelection };
}
function handler(name: string) { return mock.scope[name] as (...args: unknown[]) => unknown; }

describe('isolated capture tools authorization and settings', () => {
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

  it('captures the browser through its trusted provider without hiding it and uses dynamic global AI state', async () => {
    const { service, main, captureBrowser } = await fixture();
    const opened = await service.handle(event(main), { type: 'open', task: 'screenshot', source: 'browser' });
    expect(opened.ok && opened.source?.title).toBe('Provided browser'); expect(captureBrowser).toHaveBeenCalledTimes(1); expect(desktopCapturer.getSources).not.toHaveBeenCalled();
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

describe('desktop recording grants', () => {
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
