import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type * as NodeCrypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
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
  sameNativeDisplayTrack: boolean; sameNativeAudioTracks: boolean; nativeRecorder: boolean };

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

// Explicitly captures the user's real monitor. It creates no fixture window,
// canvas source or fake stream, makes no model request, and retains the actual
// desktop PNG/MP4 locally so the user can inspect them.
// eslint-disable-next-line no-empty-pattern
test('the real monitor is captured and recorded in full while the visible main window is automatically hidden', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'This test verifies native Windows monitor capture and capture exclusion.');
  test.setTimeout(180000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-desktop-screen-'));
  const profile = path.join(root, 'profile'); const downloads = path.join(root, 'Downloads'); mkdirSync(downloads);
  const artifacts = path.resolve('artifacts/desktop-screen-capture'); mkdirSync(artifacts, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const beforePath = path.join(artifacts, `${stamp}-before-main-visible.png`);
  const screenshotPath = path.join(artifacts, `${stamp}-desktop-main-hidden.png`);
  const videoPath = path.join(artifacts, `${stamp}-desktop-main-hidden.mp4`);
  const framePath = path.join(artifacts, `${stamp}-recording-first-frame.png`);
  const proofPath = path.join(artifacts, `${stamp}-proof.json`);
  let application: ElectronApplication | undefined; let failed = false; let shutdownError: unknown;
  const proof: Record<string, unknown> = { beforePath, screenshotPath, videoPath, framePath, noModelRequests: true, syntheticSources: false };
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
    await main.waitForTimeout(250);
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
    const captured = opened.source!; expect(captured).toBeTruthy(); expect(captured.title).toBe(before.name); expect(captured.url).toBe('');
    const trace = await application.evaluate(() => Reflect.get(globalThis, '__desktopScreenProof') as NativeCaptureTrace);
    const screenshotCall = trace.captures.find(call => call.types.length === 1 && call.types[0] === 'screen' && call.requested.width > 1);
    expect(screenshotCall).toBeTruthy(); expect(screenshotCall!.mainVisible).toBe(false); expect(screenshotCall!.toolVisible).toBe(false);
    const genuineScreen = screenshotCall!.sources.find(source => source.id === before.sourceId); expect(genuineScreen).toBeTruthy();
    expect(createHash('sha256').update(Buffer.from(captured.dataUrl.split(',')[1]!, 'base64')).digest('hex')).toBe(genuineScreen!.hash);
    nearPhysicalScreen(captured, monitor.physical); expect(await mainNative.evaluate(window => window.isVisible())).toBe(false);
    const saved = await request(tool, { type: 'screenshot.save', dataUrl: captured.dataUrl, filename: 'Actual-desktop.png', destination: 'downloads' });
    expect(path.dirname(saved.path!)).toBe(downloads); copyFileSync(saved.path!, screenshotPath, constants.COPYFILE_EXCL);
    nearPhysicalScreen(await nonemptyScreen(screenshotPath), monitor.physical);
    expect(createHash('sha256').update(readFileSync(screenshotPath)).digest('hex')).not.toBe(createHash('sha256').update(readFileSync(beforePath)).digest('hex'));
    const toolNative = await application.browserWindow(tool); expect(await toolNative.evaluate(window => window.isContentProtected())).toBe(true);
    await Promise.all([tool.waitForEvent('close'), tool.getByRole('button', { name: '关闭截图', exact: true }).click()]);
    await expect.poll(() => mainNative.evaluate(window => window.isVisible())).toBe(true);
    proof.mainHiddenAtNativeScreenshot = true; proof.mainRestoredAfterScreenshotClose = true;

    await request(main, { type: 'open', task: 'recording' }); tool = await toolPage(application);
    const sources = (await request(tool, { type: 'sources.list' })).sources!;
    expect(sources.find(source => source.id === before.sourceId)).toMatchObject({ kind: 'screen', displayId: monitor.id });
    const sourcePicker = tool.getByRole('combobox', { name: '选择屏幕或窗口', exact: true });
    await expect(sourcePicker.locator(`option[value="${before.sourceId}"]`)).toHaveCount(1); await sourcePicker.selectOption(before.sourceId);
    await expect(tool.getByLabel('仅录制选定区域', { exact: true })).not.toBeChecked();
    await expect(tool.getByRole('combobox', { name: '输出格式', exact: true })).toHaveValue('mp4');
    await expect(tool.getByLabel('录制系统声音', { exact: true })).toBeChecked();
    await expect(tool.getByLabel('录制麦克风', { exact: true })).not.toBeChecked();
    expect(await mainNative.evaluate(window => ({ visible: window.isVisible(), opacity: window.getOpacity() }))).toEqual({ visible: true, opacity: 1 });
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
    expect(nativeTracks).toMatchObject({ video: 1, requestedAudio: true, readyState: 'live', sameNativeDisplayTrack: true, sameNativeAudioTracks: true, nativeRecorder: true });
    expect(nativeTracks.audio).toBeGreaterThanOrEqual(0); expect(nativeTracks.audio).toBeLessThanOrEqual(1);
    expect(nativeTracks.audioTracks).toHaveLength(nativeTracks.audio); expect(nativeTracks.audioTracks.every(track => track.readyState === 'live')).toBe(true);
    if (!nativeTracks.audio) await expect(tool.getByText('所选来源未提供系统音轨，将继续录制画面。', { exact: true })).toBeVisible();
    if (nativeTracks.settings.displaySurface) expect(nativeTracks.settings.displaySurface).toBe('monitor');
    nearPhysicalScreen({ width: nativeTracks.settings.width!, height: nativeTracks.settings.height! }, monitor.physical);
    const recordingTrace = await application.evaluate(() => Reflect.get(globalThis, '__desktopScreenProof') as NativeCaptureTrace);
    expect(recordingTrace.grants).toHaveLength(1);
    expect(recordingTrace.grants[0]).toMatchObject({ sourceId: before.sourceId, mainVisible: false, protected: true, videoRequested: true, audioRequested: true, loopback: true });
    await expect.poll(async () => (await request(main, { type: 'state' })).state?.recording?.bytes ?? 0, { timeout: 10000 }).toBeGreaterThan(0);
    hiddenSamples.push(await mainNative.evaluate(window => !window.isVisible()));
    const recordingNative = await application.browserWindow(tool);
    const control = await recordingNative.evaluate(window => { const bytes = window.getNativeWindowHandle(); return { protected: window.isContentProtected(), bounds: window.getBounds(),
      handle: (bytes.length >= 8 ? bytes.readBigUInt64LE() : BigInt(bytes.readUInt32LE())).toString(16) }; });
    expect(control.protected).toBe(true); expect(control.bounds.width).toBeLessThanOrEqual(600); expect(control.bounds.height).toBeLessThanOrEqual(400);
    const affinity = nativeDisplayAffinity(control.handle); expect(affinity).toEqual({ success: true, affinity: 0x11 });
    // Keep the native display stream running for at least three full seconds.
    if (Date.now() - started < 3200) await tool.waitForTimeout(3200 - (Date.now() - started));
    hiddenSamples.push(await mainNative.evaluate(window => !window.isVisible())); expect(hiddenSamples.every(Boolean)).toBe(true);
    await tool.getByRole('button', { name: '停止并保存', exact: true }).click();
    await expect(tool.locator('.capture-recording-status')).toHaveClass(/is-saved/u, { timeout: 60000 });
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
    nearPhysicalScreen(videos[0]!, monitor.physical); expect(Number(media.format.duration)).toBeGreaterThanOrEqual(3); expect(Number(media.format.size)).toBeGreaterThan(10000);
    const decoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', videoPath, '-frames:v', '1', '-update', '1', '-n', framePath],
      { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 65536 });
    expect(decoded.status, decoded.stderr).toBe(0); nearPhysicalScreen(await nonemptyScreen(framePath), monitor.physical);
    Object.assign(proof, { success: true, screenshotCall, recordingGrant: recordingTrace.grants[0], nativeTracks, hiddenSamples,
      control: { ...control, affinity }, media, mainRestoredAfterRecording: true, mainRestoredAfterRecordingClose: true });
    for (const [name, file, contentType] of [['actual-monitor-before', beforePath, 'image/png'], ['actual-monitor-screenshot', screenshotPath, 'image/png'],
      ['actual-monitor-recording', videoPath, 'video/mp4'], ['actual-monitor-recording-first-frame', framePath, 'image/png']] as const) await testInfo.attach(name, { path: file, contentType });
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
