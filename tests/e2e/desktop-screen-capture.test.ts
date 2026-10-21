import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type * as NodeCrypto from 'node:crypto';
import type * as NodeModule from 'node:module';
import type * as Koffi from 'koffi';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { expectRecordingPlayback } from './recording-preview-helpers';
import type { CaptureToolsRequest, CaptureToolsResponse, WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = { worldlinebox: { captureTools: WorldlineBoxCaptureToolsApi } };
type NativeCaptureTrace = {
  captures: Array<{ types: string[]; requested: { width: number; height: number }; mainVisible: boolean; toolVisible: boolean;
    sources: Array<{ id: string; displayId: string; name: string; hash: string; width: number; height: number }> }>;
  grants: Array<{ sourceId?: string; mainVisible: boolean; protected: boolean; videoRequested: boolean; audioRequested: boolean; loopback: boolean }>;
};
type NativeRecordingTrace = { video: number; audio: number; readyState: string; settings: MediaTrackSettings & { displaySurface?: string };
  requestedAudio: boolean; audioTracks: Array<{ readyState: string; settings: MediaTrackSettings }>;
  sameNativeDisplayTrack: boolean; sameNativeAudioTracks: boolean; nativeRecorder: boolean; recorderVideoSettings: MediaTrackSettings };

async function request(page: Page, input: CaptureToolsRequest): Promise<Extract<CaptureToolsResponse, { ok: true }>> {
  const result = await page.evaluate(input => (globalThis as unknown as Bridge).worldlinebox.captureTools.request(input), input);
  if (!result.ok) throw Error(result.error);
  return result;
}
async function toolPage(application: ElectronApplication): Promise<Page> {
  await expect.poll(() => application.windows().some(page => page.url().includes('window=capture-tools')), { timeout: 20000 }).toBe(true);
  const page = application.windows().find(page => page.url().includes('window=capture-tools'))!;
  await expect.poll(() => page.evaluate(() => typeof (globalThis as unknown as Bridge).worldlinebox?.captureTools?.request)).toBe('function');
  return page;
}
function cleanup(root: string): void {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-desktop-screen-')) throw Error('Unexpected desktop capture cleanup path');
  rmSync(resolved, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
}
function nearPhysicalScreen(actual: { width: number; height: number }, physical: { width: number; height: number }): void {
  // Allow driver rounding, but a downscaled window/thumbnail cannot pass as a monitor.
  for (const axis of ['width', 'height'] as const) {
    expect(actual[axis], `${axis} should retain the real monitor's physical resolution`).toBeGreaterThanOrEqual(physical[axis] * .9);
    expect(actual[axis]).toBeLessThanOrEqual(physical[axis] * 1.05);
  }
  expect(Math.abs(actual.width / actual.height - physical.width / physical.height)).toBeLessThan(.03);
}
async function nonemptyScreen(file: string): Promise<{ width: number; height: number }> {
  const metadata = await sharp(file).metadata(); expect(metadata.format).toBe('png');
  const stats = await sharp(file).removeAlpha().stats();
  expect(Math.max(...stats.channels.map(channel => channel.stdev)), 'The actual desktop image must contain visible detail').toBeGreaterThan(2);
  expect(Math.max(...stats.channels.map(channel => channel.max))).toBeGreaterThan(20);
  return { width: metadata.width!, height: metadata.height! };
}
function nativeDisplayAffinity(handleHex: string): { success: boolean; affinity: number } {
  if (!/^[0-9a-f]{1,16}$/iu.test(handleHex)) throw Error('Invalid owned capture window handle');
  const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedCaptureAffinity {
  [DllImport("user32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
}
'@
[uint32]$affinity=0
$success=[OwnedCaptureAffinity]::GetWindowDisplayAffinity([IntPtr]::new([Convert]::ToInt64('${handleHex}',16)),[ref]$affinity)
@{success=$success;affinity=$affinity}|ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  if (result.status !== 0) throw Error('Could not inspect the owned tool window capture exclusion: ' + result.stderr);
  return JSON.parse(result.stdout.trim()) as { success: boolean; affinity: number };
}

async function visibleInActualMonitor(application: ElectronApplication, page: Page,
  monitor: { id: string; bounds: { x: number; y: number; width: number; height: number }; physical: { width: number; height: number } },
  area: { x: number; y: number; width: number; height: number }, file: string) {
  // A native flag alone cannot demonstrate remote-capture compatibility. Compare
  // visible tool pixels against an unmodified whole-monitor desktop capture.
  // No fake source, injected overlay or replacement capture implementation is used.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const native = await application.browserWindow(page);
  const expected = await native.evaluate(async (window, area) => ({
    bounds: window.getBounds(), protected: window.isContentProtected(),
    png: (await window.webContents.capturePage({ x: Math.floor(area.x), y: Math.floor(area.y), width: Math.floor(area.width), height: Math.floor(area.height) })).toPNG().toString('base64'),
  }), area);
  expect(expected.protected).toBe(false);
  const captured = await application.evaluate(async ({ desktopCapturer }, monitor) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: monitor.physical, fetchWindowIcons: false });
    const source = sources.find(source => source.display_id === monitor.id);
    if (!source || !source.id.startsWith('screen:')) throw Error('The actual monitor was not available for capture visibility proof');
    return { id: source.id, png: source.thumbnail.toPNG().toString('base64'), size: source.thumbnail.getSize() };
  }, monitor);
  const monitorBytes = Buffer.from(captured.png, 'base64'); writeFileSync(file, monitorBytes, { flag: 'wx' });
  nearPhysicalScreen(captured.size, monitor.physical);
  const sx = captured.size.width / monitor.bounds.width; const sy = captured.size.height / monitor.bounds.height;
  const clip = { left: Math.round((expected.bounds.x + Math.floor(area.x) - monitor.bounds.x) * sx),
    top: Math.round((expected.bounds.y + Math.floor(area.y) - monitor.bounds.y) * sy),
    width: Math.round(Math.floor(area.width) * sx), height: Math.round(Math.floor(area.height) * sy) };
  expect(clip.left).toBeGreaterThanOrEqual(0); expect(clip.top).toBeGreaterThanOrEqual(0);
  expect(clip.left + clip.width).toBeLessThanOrEqual(captured.size.width); expect(clip.top + clip.height).toBeLessThanOrEqual(captured.size.height);
  const sampleWidth = Math.min(480, clip.width); const sampleHeight = Math.max(1, Math.round(clip.height * sampleWidth / clip.width));
  const actual = await sharp(monitorBytes).extract(clip).removeAlpha().resize(sampleWidth, sampleHeight).raw().toBuffer();
  const reference = await sharp(Buffer.from(expected.png, 'base64')).removeAlpha().resize(sampleWidth, sampleHeight).raw().toBuffer();
  writeFileSync(file.replace(/\.png$/u, '-native-window.png'), Buffer.from(expected.png, 'base64'), { flag: 'wx' });
  writeFileSync(file.replace(/\.png$/u, '-monitor-crop.png'), await sharp(monitorBytes).extract(clip).png().toBuffer(), { flag: 'wx' });
  expect(actual.length).toBe(reference.length);
  const errors = Array.from(actual, (value, index) => Math.abs(value - reference[index]!));
  const meanError = errors.reduce((sum, value) => sum + value, 0) / errors.length;
  const closeFraction = errors.filter(value => value <= 35).length / errors.length;
  expect(meanError, 'Whole-monitor capture must contain the real visible tool pixels').toBeLessThan(12);
  expect(closeFraction, 'The real toolbar/controller must be visible to desktop capture').toBeGreaterThan(.9);
  expect((await sharp(Buffer.from(expected.png, 'base64')).removeAlpha().stats()).channels.some(channel => channel.stdev > 10), 'The compared region must contain real tool detail').toBe(true);
  return { sourceId: captured.id, clip, meanError, closeFraction, contentProtected: expected.protected, comparison: 'native tool pixels versus actual whole-monitor pixels' };
}

async function nativeRecordingBorders(application: ElectronApplication) {
  return application.evaluate(async ({ BrowserWindow }) => {
    return Promise.all(BrowserWindow.getAllWindows().filter(window => window.getTitle() === 'WorldlineBox · 录制范围').map(async window => ({
      visible: window.isVisible(), protected: window.isContentProtected(), topmost: window.isAlwaysOnTop(),
      canvas: await window.webContents.executeJavaScript('document.querySelector("canvas").toDataURL("image/png")') as string,
    })));
  });
}

// Explicitly captures the user's real monitor. It creates no fixture window,
// canvas source or fake stream, makes no model request, and retains the actual
// desktop PNG/MP4 locally so the user can inspect them. This verifies ordinary
// Windows desktop capture; it does not claim an actual Sunlogin session was run.
// eslint-disable-next-line no-empty-pattern
test('the real monitor screenshot is edited in place and regional recording controls remain visible outside the recorded pixels while the main window hides', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'This test verifies native Windows monitor capture and display affinity.');
  test.setTimeout(180000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-desktop-screen-'));
  const profile = path.join(root, 'profile'); const downloads = path.join(root, 'Downloads'); mkdirSync(downloads);
  const artifacts = path.resolve('artifacts/desktop-screen-capture'); mkdirSync(artifacts, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const beforePath = path.join(artifacts, `${stamp}-before-main-visible.png`);
  const screenshotPath = path.join(artifacts, `${stamp}-desktop-main-hidden.png`);
  const videoPath = path.join(artifacts, `${stamp}-desktop-main-hidden.mp4`);
  const framePath = path.join(artifacts, `${stamp}-recording-final-frame.png`);
  const overlayPath = path.join(artifacts, `${stamp}-inline-overlay-visible-in-monitor.png`);
  const controllerPath = path.join(artifacts, `${stamp}-recording-controller-visible-in-monitor.png`);
  const proofPath = path.join(artifacts, `${stamp}-proof.json`);
  let application: ElectronApplication | undefined; let failed = false; let shutdownError: unknown;
  const proof: Record<string, unknown> = { beforePath, screenshotPath, videoPath, framePath, overlayPath, controllerPath,
    noModelRequests: true, syntheticSources: false, actualSunloginSession: false };
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(),
      args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '0', WORLDLINEBOX_E2E_USER_DATA_PATH: profile,
        WORLDLINEBOX_E2E_CAPTURE_DOWNLOAD_PATH: downloads }, { gpu: 'hardware' }) });
    const main = await application.firstWindow();
    await expect(main.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 30000 });
    const state = (await request(main, { type: 'state' })).state!;
    expect(state.settings).toMatchObject({ hideApp: true, systemAudio: true, microphone: false, format: 'mp4' });
    expect(state.ai.configured).toBe(false); expect(state.downloadPath).toBe(downloads);

    // Put the real, fully opaque application on the monitor the product will
    // select. Do not make it transparent or hide it using a testing option.
    const mainNative = await application.browserWindow(main);
    const monitor = await application.evaluate(({ BrowserWindow, screen }, mainId) => {
      const main = BrowserWindow.fromId(mainId); if (!main) throw Error('Missing main application window');
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); const work = display.workArea; const current = main.getBounds();
      main.setOpacity(1); main.setBounds({ x: work.x, y: work.y, width: Math.min(current.width, work.width), height: Math.min(current.height, work.height) });
      main.show(); main.moveTop(); main.focus();
      return { mainId, id: String(display.id), bounds: display.bounds, scaleFactor: display.scaleFactor,
        physical: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) } };
    }, await mainNative.evaluate(window => window.id));
    expect(await mainNative.evaluate(window => ({ visible: window.isVisible(), opacity: window.getOpacity() }))).toEqual({ visible: true, opacity: 1 });
    await main.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const before = await application.evaluate(async ({ desktopCapturer, BrowserWindow }, monitor) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: monitor.physical, fetchWindowIcons: false });
      const source = sources.find(source => source.display_id === monitor.id); if (!source || !source.id.startsWith('screen:')) throw Error('The actual monitor source was not found');
      return { sourceId: source.id, name: source.name, mainVisible: BrowserWindow.fromId(monitor.mainId)?.isVisible(), png: source.thumbnail.toPNG().toString('base64') };
    }, monitor);
    expect(before.mainVisible).toBe(true); expect(before.sourceId).toMatch(/^screen:/u);
    writeFileSync(beforePath, Buffer.from(before.png, 'base64'), { flag: 'wx' });
    nearPhysicalScreen(await nonemptyScreen(beforePath), monitor.physical);
    proof.monitor = monitor; proof.sourceId = before.sourceId; proof.sourceKind = 'screen'; proof.mainVisibleBefore = true;

    // Observe the genuine APIs and their unmodified results. The display grant
    // observer records which native source reaches Chromium, not merely UI text.
    await application.evaluate(({ BrowserWindow, desktopCapturer, session }, mainId) => {
      const trace: NativeCaptureTrace = { captures: [], grants: [] }; Reflect.set(globalThis, '__desktopScreenProof', trace);
      const main = () => BrowserWindow.fromId(mainId);
      const tool = () => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('window=capture-tools'));
      const actualSources = desktopCapturer.getSources.bind(desktopCapturer);
      const crypto = process.getBuiltinModule('node:crypto') as typeof NodeCrypto;
      desktopCapturer.getSources = async options => {
        const entry: NativeCaptureTrace['captures'][number] = { types: [...options.types], requested: options.thumbnailSize ?? { width: 0, height: 0 },
          mainVisible: main()?.isVisible() ?? false, toolVisible: tool()?.isVisible() ?? false, sources: [] };
        const sources = await actualSources(options);
        entry.sources = sources.filter(source => source.id.startsWith('screen:')).map(source => ({ id: source.id, displayId: source.display_id, name: source.name,
          hash: crypto.createHash('sha256').update(source.thumbnail.toPNG()).digest('hex'), ...source.thumbnail.getSize() }));
        trace.captures.push(entry); return sources;
      };
      const prototype = Object.getPrototypeOf(session.defaultSession) as Electron.Session;
      const actualHandler = prototype.setDisplayMediaRequestHandler;
      prototype.setDisplayMediaRequestHandler = function(handler, options) {
        if (!handler) return actualHandler.call(this, handler, options);
        return actualHandler.call(this, (details, callback) => handler(details, grant => {
          const video = grant.video;
          trace.grants.push({ sourceId: video && 'id' in video ? video.id : undefined, mainVisible: main()?.isVisible() ?? false,
            protected: tool()?.isContentProtected() ?? false, videoRequested: details.videoRequested, audioRequested: details.audioRequested, loopback: grant.audio === 'loopback' });
          callback(grant);
        }), options);
      };
    }, monitor.mainId);

    const opened = await request(main, { type: 'open', task: 'screenshot' }); let tool = await toolPage(application);
    const captured = opened.source!; expect(captured).toBeTruthy(); expect(captured.title).toBeTruthy(); expect(captured.url).toBe('');
    if (captured.desktop?.pixelBounds) monitor.physical = { width: captured.desktop.pixelBounds.width, height: captured.desktop.pixelBounds.height };
    const trace = await application.evaluate(() => Reflect.get(globalThis, '__desktopScreenProof') as NativeCaptureTrace);
    const screenshotCall = trace.captures.find(call => call.types.length === 1 && call.types[0] === 'screen' && call.requested.width > 1);
    if (screenshotCall) {
      expect(screenshotCall).toBeTruthy(); expect(screenshotCall!.mainVisible).toBe(false); expect(screenshotCall!.toolVisible).toBe(false);
      const genuineScreen = screenshotCall!.sources.find(source => source.id === before.sourceId); expect(genuineScreen).toBeTruthy();
      expect(createHash('sha256').update(Buffer.from(captured.dataUrl.split(',')[1]!, 'base64')).digest('hex')).toBe(genuineScreen!.hash);
    } else {
      // The fast Win32 path need not enumerate Chromium sources. Independently
      // compare its actual monitor pixels against an unmodified Chromium
      // capture with both app windows hidden; tolerate small live UI changes.
      const reference = await application.evaluate(async ({ BrowserWindow, desktopCapturer }, input) => {
        const overlay = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('window=capture-tools'))!;
        overlay.hide();
        try {
          const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: input.physical });
          const source = sources.find(source => source.display_id === input.id)!;
          return { png: source.thumbnail.toPNG().toString('base64'), mainVisible: BrowserWindow.fromId(input.mainId)?.isVisible() };
        } finally { overlay.showInactive(); }
      }, { ...monitor, physical: { width: captured.width, height: captured.height } });
      expect(reference.mainVisible).toBe(false);
      const actual = await sharp(Buffer.from(captured.dataUrl.split(',')[1]!, 'base64')).removeAlpha().raw().toBuffer();
      const pixels = await sharp(Buffer.from(reference.png, 'base64')).removeAlpha().raw().toBuffer();
      writeFileSync(path.join(artifacts, 'native-monitor.png'), Buffer.from(captured.dataUrl.split(',')[1]!, 'base64'));
      writeFileSync(path.join(artifacts, 'chromium-monitor.png'), Buffer.from(reference.png, 'base64'));
      expect(actual.length).toBe(pixels.length);
      let match = 0, samples = 0;
      // The person can keep using other apps during this test. Compare the
      // stable native taskbar strip, rather than assuming their entire desktop
      // stays frozen between two different capture APIs.
      for (let index = captured.width * Math.max(0, captured.height - 32) * 3; index < pixels.length; index += 29 * 3) { samples++; if (Math.abs(actual[index]! - pixels[index]!) < 12 && Math.abs(actual[index + 1]! - pixels[index + 1]!) < 12 && Math.abs(actual[index + 2]! - pixels[index + 2]!) < 12) match++; }
      expect(match / samples, 'Native monitor colors and scale should match the real desktop').toBeGreaterThan(.8);
    }
    nearPhysicalScreen(captured, monitor.physical); expect(await mainNative.evaluate(window => window.isVisible())).toBe(false);
    const saved = await request(tool, { type: 'screenshot.save', dataUrl: captured.dataUrl, filename: 'Actual-desktop.png', destination: 'downloads' });
    expect(path.dirname(saved.path!)).toBe(downloads); copyFileSync(saved.path!, screenshotPath, constants.COPYFILE_EXCL);
    nearPhysicalScreen(await nonemptyScreen(screenshotPath), monitor.physical);
    expect(createHash('sha256').update(readFileSync(screenshotPath)).digest('hex')).not.toBe(createHash('sha256').update(readFileSync(beforePath)).digest('hex'));
    const toolNative = await application.browserWindow(tool); expect(await toolNative.evaluate(window => window.isContentProtected())).toBe(false);
    expect(captured.desktop).toMatchObject({ displayId: monitor.id, bounds: monitor.bounds });
    const windowGeometry = await toolNative.evaluate(async window => ({ bounds: window.getBounds(), contentBounds: window.getContentBounds(), fullScreen: window.isFullScreen(), frame: window.getNormalBounds(),
      viewport: await window.webContents.executeJavaScript('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})') as { width: number; height: number; dpr: number } }));
    const physicalGeometry = await application.evaluate(({ BrowserWindow, app }, id) => {
      const window = BrowserWindow.fromId(id); if (!window) throw Error('Missing owned capture window');
      const module = process.getBuiltinModule('node:module') as unknown as typeof NodeModule;
      const native = module.createRequire(app.getAppPath() + '/package.json')('koffi') as typeof Koffi;
      const user32 = native.load('user32.dll');
      const getRect = user32.func('int __stdcall GetWindowRect(uintptr_t hwnd, uint8_t *rect)');
      const getClient = user32.func('int __stdcall GetClientRect(uintptr_t hwnd, uint8_t *rect)');
      const getDpi = user32.func('uint32_t __stdcall GetDpiForWindow(uintptr_t hwnd)');
      const getContext = user32.func('intptr_t __stdcall GetWindowDpiAwarenessContext(uintptr_t hwnd)');
      const setContext = user32.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)');
      const handle = window.getNativeWindowHandle(); const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
      const previous = setContext(-4) as number | bigint;
      try {
        const rect = Buffer.alloc(16), client = Buffer.alloc(16); getRect(hwnd, rect); getClient(hwnd, client);
        return { x: rect.readInt32LE(0), y: rect.readInt32LE(4), width: rect.readInt32LE(8) - rect.readInt32LE(0), height: rect.readInt32LE(12) - rect.readInt32LE(4),
          clientWidth: client.readInt32LE(8), clientHeight: client.readInt32LE(12), dpi: getDpi(hwnd) as number, dpiContext: String(getContext(hwnd)) };
      } finally { if (previous) setContext(previous); }
    }, await toolNative.evaluate(window => window.id));
    console.log('DESKTOP_OVERLAY_GEOMETRY', JSON.stringify({ ...windowGeometry, physical: physicalGeometry, source: captured.desktop }));
    await testInfo.attach('desktop-overlay-window-geometry', { body: JSON.stringify(windowGeometry), contentType: 'application/json' });
    expect(windowGeometry).toMatchObject({ bounds: monitor.bounds });
    await expect(tool.locator('.desktop-screenshot-overlay')).toBeVisible();
    await expect(tool.getByRole('dialog', { name: '截图工作台', exact: true })).toHaveCount(0);
    await tool.getByRole('button', { name: '使用整个屏幕', exact: true }).click();
    await expect(tool.locator('.desktop-screenshot-toolbar')).toBeVisible();
    await tool.getByRole('button', { name: '遮盖', exact: true }).click();
    const selection = await tool.locator('.desktop-screenshot-selection-canvas').boundingBox(); if (!selection) throw Error('Missing inline editing canvas');
    await tool.mouse.move(selection.x + selection.width * .2, selection.y + selection.height * .2); await tool.mouse.down();
    await tool.mouse.move(selection.x + selection.width * .35, selection.y + selection.height * .35, { steps: 8 }); await tool.mouse.up();
    const toolbarBounds = await tool.locator('.desktop-screenshot-toolbar').boundingBox(); if (!toolbarBounds) throw Error('Missing floating screenshot toolbar');
    const overlayVisibility = await visibleInActualMonitor(application, tool, monitor, toolbarBounds, overlayPath);
    await Promise.all([tool.waitForEvent('close'), tool.getByRole('button', { name: '关闭截图', exact: true }).click()]);
    await expect.poll(() => mainNative.evaluate(window => window.isVisible())).toBe(true);
    proof.mainHiddenAtNativeScreenshot = true; proof.mainRestoredAfterScreenshotClose = true;

    const recordingSource = (await request(main, { type: 'open', task: 'recording' })).source!; tool = await toolPage(application);
    expect(recordingSource.desktop).toMatchObject({ displayId: monitor.id, bounds: monitor.bounds });
    await expect(tool.locator('.desktop-screenshot-overlay')).toBeVisible();
    await expect(tool.locator('.desktop-screenshot-hover')).toBeVisible();
    await expect(tool.locator('.desktop-screenshot-loading')).toHaveCount(0);
    const recordFrom = { x: Math.floor(monitor.bounds.width * .15), y: Math.floor(monitor.bounds.height * .15) };
    const recordTo = { x: Math.floor(monitor.bounds.width * .7), y: Math.floor(monitor.bounds.height * .65) };
    await tool.mouse.move(recordFrom.x, recordFrom.y); await tool.mouse.down();
    await tool.mouse.move(recordTo.x, recordTo.y, { steps: 8 }); await tool.mouse.up();
    const selectedCrop = await tool.locator('.desktop-screenshot-selection').getAttribute('data-pixel-crop');
    if (!selectedCrop) throw Error('The actual desktop recording selection has no physical pixel crop');
    const recordCrop = JSON.parse(selectedCrop) as { x: number; y: number; width: number; height: number };
    const outputSize = { width: Math.floor(recordCrop.width / 2) * 2, height: Math.floor(recordCrop.height / 2) * 2 };
    await expect(tool.locator('[data-desktop-recording-toolbar]')).toBeVisible();
    await expect(tool.getByRole('combobox', { name: '输出格式', exact: true })).toHaveValue('mp4');
    await expect(tool.getByRole('combobox', { name: '录制画质', exact: true })).toHaveValue('original');
    await expect(tool.getByLabel('录制系统声音', { exact: true })).toBeChecked();
    await expect(tool.getByLabel('录制麦克风', { exact: true })).not.toBeChecked();
    expect(await mainNative.evaluate(window => ({ visible: window.isVisible(), opacity: window.getOpacity() }))).toEqual({ visible: false, opacity: 1 });
    await tool.evaluate(() => {
      const actualDisplay = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      let display: MediaStream | undefined;
      const trace: Partial<NativeRecordingTrace> = {}; Reflect.set(globalThis, '__nativeScreenRecording', trace);
      navigator.mediaDevices.getDisplayMedia = async options => {
        display = await actualDisplay(options); const video = display.getVideoTracks()[0];
        Object.assign(trace, { video: display.getVideoTracks().length, audio: display.getAudioTracks().length, readyState: video?.readyState, settings: video?.getSettings(),
          requestedAudio: Boolean(options?.audio), audioTracks: display.getAudioTracks().map(track => ({ readyState: track.readyState, settings: track.getSettings() })) });
        return display;
      };
      const NativeRecorder = MediaRecorder;
      globalThis.MediaRecorder = new Proxy(NativeRecorder, { construct(target, argumentsList) {
        const stream = argumentsList[0] as MediaStream; const recorder = Reflect.construct(target, argumentsList) as MediaRecorder;
        trace.sameNativeDisplayTrack = stream.getVideoTracks()[0] === display?.getVideoTracks()[0];
        trace.recorderVideoSettings = stream.getVideoTracks()[0]?.getSettings();
        const actualAudio = display?.getAudioTracks() ?? [];
        trace.sameNativeAudioTracks = stream.getAudioTracks().length === actualAudio.length && stream.getAudioTracks().every((track, index) => track === actualAudio[index]);
        trace.nativeRecorder = recorder instanceof NativeRecorder;
        return recorder;
      } });
    });
    await tool.getByRole('button', { name: '开始录制', exact: true }).click();
    await expect(tool.locator('.capture-recording-status')).toHaveClass(/is-recording/u, { timeout: 30000 });
    const started = Date.now(); const hiddenSamples: boolean[] = [];
    hiddenSamples.push(await mainNative.evaluate(window => !window.isVisible()));
    const nativeTracks = await tool.evaluate(() => Reflect.get(globalThis, '__nativeScreenRecording') as NativeRecordingTrace);
    expect(nativeTracks).toMatchObject({ video: 1, requestedAudio: true, readyState: 'live', sameNativeDisplayTrack: false, sameNativeAudioTracks: true, nativeRecorder: true,
      recorderVideoSettings: outputSize });
    expect(nativeTracks.audio).toBeGreaterThanOrEqual(0); expect(nativeTracks.audio).toBeLessThanOrEqual(1);
    expect(nativeTracks.audioTracks).toHaveLength(nativeTracks.audio); expect(nativeTracks.audioTracks.every(track => track.readyState === 'live')).toBe(true);
    if (!nativeTracks.audio) await expect(tool.getByText('所选来源未提供系统音轨，将继续录制画面。', { exact: true })).toBeVisible();
    if (nativeTracks.settings.displaySurface) expect(nativeTracks.settings.displaySurface).toBe('monitor');
    nearPhysicalScreen({ width: nativeTracks.settings.width!, height: nativeTracks.settings.height! }, monitor.physical);
    const recordingTrace = await application.evaluate(() => Reflect.get(globalThis, '__desktopScreenProof') as NativeCaptureTrace);
    expect(recordingTrace.grants).toHaveLength(1);
    expect(recordingTrace.grants[0]).toMatchObject({ sourceId: before.sourceId, mainVisible: false, protected: false, videoRequested: true, audioRequested: true, loopback: true });
    await expect.poll(async () => (await request(main, { type: 'state' })).state?.recording?.bytes ?? 0, { timeout: 10000 }).toBeGreaterThan(0);
    hiddenSamples.push(await mainNative.evaluate(window => !window.isVisible()));
    const recordingNative = await application.browserWindow(tool);
    const control = await recordingNative.evaluate(window => { const bytes = window.getNativeWindowHandle(); return { protected: window.isContentProtected(), bounds: window.getBounds(),
      visible: window.isVisible(), topmost: window.isAlwaysOnTop(),
      handle: (bytes.length >= 8 ? bytes.readBigUInt64LE() : BigInt(bytes.readUInt32LE())).toString(16) }; });
    console.log('DESKTOP_RECORDING_CONTROLLER', JSON.stringify(control));
    const layout = await tool.locator('.capture-recorder-floating').evaluate(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      items: [...element.querySelectorAll('button, time')].map(item => ({ label: item.getAttribute('aria-label'), x: item.getBoundingClientRect().x, width: item.getBoundingClientRect().width })) }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    const laidOut = [...layout.items].sort((a, b) => a.x - b.x);
    for (let index = 1; index < laidOut.length; index++) expect(laidOut[index - 1]!.x + laidOut[index - 1]!.width).toBeLessThanOrEqual(laidOut[index]!.x + 1);
    expect(control.protected).toBe(false); expect(control.bounds.width).toBeLessThanOrEqual(600); expect(control.bounds.height).toBeLessThanOrEqual(120);
    const affinity = nativeDisplayAffinity(control.handle); expect(affinity).toEqual({ success: true, affinity: 0 });
    const recordDesktopRect = { x: monitor.bounds.x + recordCrop.x / recordingSource.width * monitor.bounds.width,
      y: monitor.bounds.y + recordCrop.y / recordingSource.height * monitor.bounds.height,
      width: recordCrop.width / recordingSource.width * monitor.bounds.width, height: recordCrop.height / recordingSource.height * monitor.bounds.height };
    const overlap = { width: Math.max(0, Math.min(control.bounds.x + control.bounds.width, recordDesktopRect.x + recordDesktopRect.width) - Math.max(control.bounds.x, recordDesktopRect.x)),
      height: Math.max(0, Math.min(control.bounds.y + control.bounds.height, recordDesktopRect.y + recordDesktopRect.height) - Math.max(control.bounds.y, recordDesktopRect.y)) };
    expect(overlap.width * overlap.height, 'The visible controls must be entirely outside the recorded desktop rectangle').toBe(0);
    // Keep the native display stream running for at least three full seconds.
    if (Date.now() - started < 3200) await tool.waitForTimeout(3200 - (Date.now() - started));
    hiddenSamples.push(await mainNative.evaluate(window => !window.isVisible())); expect(hiddenSamples.every(Boolean)).toBe(true);
    const recordingVisibility = await visibleInActualMonitor(application, tool, monitor,
      { x: 0, y: 0, width: control.bounds.width, height: control.bounds.height }, controllerPath);
    const borderWindows = await nativeRecordingBorders(application);
    expect(borderWindows).toHaveLength(1);
    expect(borderWindows[0]).toMatchObject({ visible: true, protected: false, topmost: true });
    const boundaryPixels = await sharp(Buffer.from(borderWindows[0]!.canvas.split(',')[1]!, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(boundaryPixels.info).toMatchObject({ width: monitor.physical.width, height: monitor.physical.height });
    const expectedBorders = [
      { x: recordCrop.x - 2, y: recordCrop.y - 2, width: recordCrop.width + 4, height: 2 },
      { x: recordCrop.x + recordCrop.width, y: recordCrop.y, width: 2, height: recordCrop.height },
      { x: recordCrop.x - 2, y: recordCrop.y + recordCrop.height, width: recordCrop.width + 4, height: 2 },
      { x: recordCrop.x - 2, y: recordCrop.y, width: 2, height: recordCrop.height },
    ];
    let paintedPixels = 0;
    for (let offset = 3; offset < boundaryPixels.data.length; offset += 4) if (boundaryPixels.data[offset]) paintedPixels++;
    expect(paintedPixels, 'The boundary overlay must be fully transparent except for the four two-pixel lines, with no opaque host gutters').toBe(expectedBorders.reduce((sum, border) => sum + border.width * border.height, 0));
    const borderVisibility = [];
    for (const border of expectedBorders) {
      expect(Math.min(border.width, border.height), 'The visible recording boundary must be exactly two physical pixels wide').toBe(2);
      const overlapWidth = Math.max(0, Math.min(border.x + border.width, recordCrop.x + recordCrop.width) - Math.max(border.x, recordCrop.x));
      const overlapHeight = Math.max(0, Math.min(border.y + border.height, recordCrop.y + recordCrop.height) - Math.max(border.y, recordCrop.y));
      expect(overlapWidth * overlapHeight, 'Visible boundary strips must remain outside the exact output crop').toBe(0);
      const pixels = await sharp(controllerPath).extract({ left: border.x, top: border.y, width: border.width, height: border.height }).removeAlpha().raw().toBuffer();
      let blue = 0; for (let offset = 0; offset < pixels.length; offset += 3) if (pixels[offset]! < 150 && pixels[offset + 1]! > 80 && pixels[offset + 1]! < 200 && pixels[offset + 2]! > 160) blue++;
      const blueFraction = blue / (pixels.length / 3); expect(blueFraction, 'The real monitor capture must show the recording boundary').toBeGreaterThan(.8);
      borderVisibility.push({ ...border, blueFraction });
    }
    await tool.getByRole('button', { name: '停止并保存', exact: true }).click();
    await expect(tool.locator('.capture-recording-status')).toHaveClass(/is-saved/u, { timeout: 60000 });
    const actualPlayback = await expectRecordingPlayback(tool);
    expect(actualPlayback).toMatchObject(outputSize);
    expect(await nativeRecordingBorders(application)).toHaveLength(0);
    const recording = (await request(main, { type: 'state' })).state!.recording!;
    expect(recording.path).toBeTruthy(); expect(path.dirname(recording.path!)).toBe(downloads); expect(recording.path).toMatch(/\.mp4$/u);
    copyFileSync(recording.path!, videoPath, constants.COPYFILE_EXCL);
    await expect.poll(() => mainNative.evaluate(window => window.isVisible())).toBe(true);
    await Promise.all([tool.waitForEvent('close'), tool.getByRole('button', { name: '关闭', exact: true }).click()]);
    expect(await mainNative.evaluate(window => window.isVisible())).toBe(true);

    const ffprobe = path.resolve('resources/ffmpeg/win32-x64/ffprobe.exe'); const ffmpeg = path.resolve('resources/ffmpeg/win32-x64/ffmpeg.exe');
    const inspected = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-show_entries', 'format=duration,size', '-of', 'json', videoPath],
      { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    expect(inspected.status, inspected.stderr).toBe(0);
    const media = JSON.parse(inspected.stdout) as { streams: Array<{ codec_type: string; codec_name: string; width: number; height: number }>; format: { duration: string; size: string } };
    const videos = media.streams.filter(stream => stream.codec_type === 'video'); expect(videos).toHaveLength(1); expect(videos[0]!.codec_name).toBe('h264');
    const audio = media.streams.filter(stream => stream.codec_type === 'audio'); expect(audio).toHaveLength(nativeTracks.audio);
    expect(audio.every(stream => stream.codec_name === 'aac')).toBe(true);
    expect(videos[0]).toMatchObject(outputSize); expect(Number(media.format.duration)).toBeGreaterThanOrEqual(3); expect(Number(media.format.size)).toBeGreaterThan(10000);
    // The container's audio tail can outlast its final video packet. Reverse
    // only the last second to inspect the last decodable frame reliably.
    const decoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-sseof', '-1', '-i', videoPath, '-vf', 'reverse', '-frames:v', '1', '-update', '1', '-n', framePath],
      { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 65536 });
    expect(decoded.status, decoded.stderr).toBe(0); expect(await nonemptyScreen(framePath)).toEqual(outputSize);
    const nativeReference = await sharp(controllerPath).extract({ left: recordCrop.x, top: recordCrop.y, width: recordCrop.width, height: recordCrop.height })
      .removeAlpha().resize(320, 180, { fit: 'fill' }).raw().toBuffer();
    const recordedFrame = await sharp(framePath).removeAlpha().resize(320, 180, { fit: 'fill' }).raw().toBuffer();
    const frameMeanError = Array.from(recordedFrame, (value, index) => Math.abs(value - nativeReference[index]!)).reduce((sum, value) => sum + value, 0) / recordedFrame.length;
    expect(frameMeanError, 'Decoded recording must agree with the live native desktop crop, without its outside controls').toBeLessThan(25);
    // Exercise a quality tier through the real canvas/encoder path and verify
    // that sole-monitor full-screen recording can be stopped from the actual
    // product tray action while its controls remain out of the recording.
    const displayCount = await application.evaluate(({ screen, Tray }) => {
      const setMenu = Tray.prototype.setContextMenu;
      Tray.prototype.setContextMenu = function(menu) { Reflect.set(globalThis, '__captureTrayMenu', menu); return setMenu.call(this, menu); };
      return screen.getAllDisplays().length;
    });
    const fullOpened = await request(main, { type: 'open', task: 'recording' }); tool = await toolPage(application);
    await expect(tool.locator('.desktop-screenshot-hover')).toBeVisible();
    await tool.getByRole('button', { name: '使用整个屏幕', exact: true }).click();
    await tool.getByRole('combobox', { name: '录制画质', exact: true }).selectOption('720p');
    await tool.getByRole('combobox', { name: '输出格式', exact: true }).selectOption('webm');
    await tool.getByLabel('录制系统声音', { exact: true }).uncheck();
    await tool.getByRole('button', { name: '开始录制', exact: true }).click();
    await expect(tool.locator('.capture-recording-status')).toHaveClass(/is-recording/u, { timeout: 30000 });
    const fullNative = await application.browserWindow(tool);
    if (displayCount === 1) expect(await fullNative.evaluate(window => window.isVisible()), 'A sole full monitor has no outside pixels for the controls').toBe(false);
    expect(await fullNative.evaluate(window => window.isContentProtected())).toBe(false);
    await expect.poll(async () => (await request(main, { type: 'state' })).state?.recording?.bytes ?? 0, { timeout: 10000 }).toBeGreaterThan(0);
    await tool.waitForTimeout(1200);
    await application.evaluate(() => {
      const menu = Reflect.get(globalThis, '__captureTrayMenu') as Electron.Menu | undefined;
      const stop = menu?.items.find(item => item.label === '停止录屏并保存');
      if (!stop?.enabled) throw Error('The real stop-and-save tray action must be available while full-screen recording controls are hidden');
      (stop.click as () => void)();
    });
    await expect(tool.locator('.capture-recording-status')).toHaveClass(/is-saved/u, { timeout: 60000 });
    await expectRecordingPlayback(tool);
    const fullRecording = (await request(main, { type: 'state' })).state!.recording!;
    expect(fullRecording.format).toBe('webm'); expect(fullRecording.path).toMatch(/\.webm$/u);
    const scaledProbe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', fullRecording.path!],
      { windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    expect(scaledProbe.status, scaledProbe.stderr).toBe(0);
    const scaledVideo = (JSON.parse(scaledProbe.stdout) as { streams: Array<{ codec_type: string; width: number; height: number }> }).streams.find(stream => stream.codec_type === 'video')!;
    const pixels = fullOpened.source!.desktop!.pixelBounds ?? fullOpened.source!;
    const scale = Math.min(1, 1280 / pixels.width, 720 / pixels.height);
    expect(scaledVideo).toMatchObject({ width: Math.floor(pixels.width * scale / 2) * 2, height: Math.floor(pixels.height * scale / 2) * 2 });
    const scaledPath = path.join(artifacts, `${stamp}-full-monitor-720p.webm`); copyFileSync(fullRecording.path!, scaledPath, constants.COPYFILE_EXCL);
    await testInfo.attach('actual-full-monitor-720p-recording', { path: scaledPath, contentType: 'video/webm' });
    await Promise.all([tool.waitForEvent('close'), tool.getByRole('button', { name: '关闭', exact: true }).click()]);
    Object.assign(proof, { success: true, screenshotCall, recordingGrant: recordingTrace.grants[0], nativeTracks, hiddenSamples,
      control: { ...control, affinity, overlapPixels: 0 }, overlayVisibility, recordingVisibility, borderVisibility, recordCrop, recordDesktopRect, outputSize,
      decodedFrameVsNativeDesktopMeanError: frameMeanError, media, mainRestoredAfterRecording: true, mainRestoredAfterRecordingClose: true,
      fullScreen720p: { dimensions: scaledVideo, hiddenControls: displayCount === 1, trayStopSaved: true, path: scaledPath } });
    for (const [name, file, contentType] of [['actual-monitor-before', beforePath, 'image/png'], ['actual-monitor-screenshot', screenshotPath, 'image/png'],
      ['actual-monitor-recording', videoPath, 'video/mp4'], ['actual-monitor-recording-final-frame', framePath, 'image/png'],
      ['inline-overlay-visible-in-monitor', overlayPath, 'image/png'], ['recording-controller-visible-in-monitor', controllerPath, 'image/png']] as const) await testInfo.attach(name, { path: file, contentType });
  } catch (error) { failed = true; proof.failure = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    writeFileSync(proofPath, JSON.stringify(proof, null, 2), { flag: 'wx' });
    if (application) {
      const logs = path.join(profile, 'logs');
      if (failed && existsSync(logs)) for (const filename of readdirSync(logs)) if (filename.endsWith('.log')) await testInfo.attach(filename, { body: readFileSync(path.join(logs, filename)), contentType: 'text/plain' });
      try { await application.close(); } catch (error) { shutdownError = error; }
    }
    try { cleanup(root); } catch (error) { shutdownError ??= error; }
  }
  if (shutdownError) throw shutdownError;
});
