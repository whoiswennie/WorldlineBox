import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CaptureToolsRequest, CaptureToolsResponse, WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';
import { expectRecordingPlayback } from './recording-preview-helpers';

type Bridge = { worldlinebox: { captureTools: WorldlineBoxCaptureToolsApi } };
async function raw(page: Page, input: CaptureToolsRequest): Promise<CaptureToolsResponse> {
  return page.evaluate(input => (globalThis as unknown as Bridge).worldlinebox.captureTools.request(input), input);
}
async function request(page: Page, input: CaptureToolsRequest) {
  const result = await raw(page, input); if (!result.ok) throw Error(result.error); return result;
}
async function toolPage(application: ElectronApplication): Promise<Page> {
  await expect.poll(() => application.windows().some(page => page.url().includes('window=capture-tools')), { timeout: 20000 }).toBe(true);
  const tool = application.windows().find(page => page.url().includes('window=capture-tools'))!;
  await expect.poll(() => tool.evaluate(() => typeof (globalThis as unknown as Bridge).worldlinebox?.captureTools?.request)).toBe('function');
  return tool;
}
function cleanup(root: string): void {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-capture-tools-')) throw Error('Unexpected capture tools fixture cleanup path');
  rmSync(resolved, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
}

// The recorder obtains a real display stream. Instrumentation only counts its
// tracks; it never replaces getDisplayMedia with a synthetic or silent stream.
// eslint-disable-next-line no-empty-pattern
test('global screenshot tools isolate privileges, flatten edits, persist shortcuts and record a real MP4', async ({}, testInfo) => {
  test.setTimeout(240000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-capture-tools-'));
  const profile = path.join(root, 'profile'); const downloads = path.join(root, 'Downloads'); mkdirSync(downloads);
  const launch = () => electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile,
      WORLDLINEBOX_E2E_CAPTURE_DOWNLOAD_PATH: downloads }, { gpu: 'hardware' }) });
  let application: ElectronApplication | undefined;
  let electronErrors = '';
  let originalFailure = false;
  let cleanupFailure: unknown;
  let previousClipboard: { text: string; html: string; rtf: string; image: string } | undefined;
  try {
    application = await launch(); application.process().stderr?.on('data', data => { electronErrors = (electronErrors + String(data)).slice(-12000); }); let main = await application.firstWindow();
    await expect(main.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 30000 });
    const initial = (await request(main, { type: 'state' })).state!;
    expect(initial.downloadPath).toBe(downloads); expect(initial.settings).toMatchObject({ systemAudio: true, microphone: false, format: 'mp4', hideApp: true });
    expect(initial.shortcuts).toHaveLength(6);
    for (const shortcut of initial.shortcuts) { expect(shortcut.accelerator).not.toBe(''); if (!shortcut.registered) expect(shortcut.error).toBeTruthy(); }
    const denied = await main.evaluate(async () => {
      const api = (globalThis as unknown as Bridge).worldlinebox.captureTools;
      return Promise.all([api.request({ type: 'context' }), api.request({ type: 'screenshot.capture' }), api.request({ type: 'screenshot.copy', dataUrl: 'data:image/png;base64,YmFk' }),
        api.request({ type: 'recording.chunk', id: 'invalid', sequence: 0, chunk: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]) })]);
    });
    expect(denied.every(result => !result.ok)).toBe(true);
    const duplicate = structuredClone(initial.settings); duplicate.shortcuts.screenshot = 'Control+Alt+F11'; duplicate.shortcuts.ocr = 'Control+Alt+F11';
    const duplicateResult = await raw(main, { type: 'settings.save', settings: duplicate }); expect(duplicateResult.ok).toBe(false);
    const settings = { ...initial.settings, hideApp: false, shortcuts: { screenshot: '', recording: '', ocr: '', translate: '', 'long-screenshot': '', selection: '' } };
    const savedSettings = await request(main, { type: 'settings.save', settings }); expect(savedSettings.state!.shortcuts.every(item => !item.registered && item.accelerator === '')).toBe(true);
    expect(JSON.parse(readFileSync(path.join(profile, 'capture-tools', 'settings.json'), 'utf8'))).toEqual(settings);
    expect(await application.evaluate(({ globalShortcut }, shortcuts) => shortcuts.some(value => globalShortcut.isRegistered(value)), initial.shortcuts.map(item => item.accelerator))).toBe(false);

    // Capture an actual isolated native window rather than persisting unrelated
    // desktop contents in test artifacts.
    const fixture = await application.evaluate(async ({ BrowserWindow }) => {
      const window = new BrowserWindow({ title: 'WorldlineBox Capture Fixture', width: 800, height: 600, frame: false, show: false,
        backgroundColor: '#e6efff', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head><title>WorldlineBox Capture Fixture</title></head><body style="margin:0;background:#e6efff;font:32px Segoe UI;color:#233f77"><div style="padding:50px">Actual desktop capture fixture</div><div style="height:250px;background:#3f85dd;margin:30px;border-radius:25px"></div><canvas id="clock" width="700" height="80"></canvas><script>setInterval(()=>{const c=document.getElementById("clock").getContext("2d");c.fillStyle="#e6efff";c.fillRect(0,0,700,80);c.fillStyle="#233f77";c.font="28px Segoe UI";c.fillText(new Date().toLocaleString("zh-CN",{hour12:false}) + "." + String(new Date().getMilliseconds()).padStart(3,"0"),50,50)},100)</script></body></html>'));
      window.showInactive(); window.moveTop(); return { id: window.id, sourceId: window.getMediaSourceId() };
    });
    await application.evaluate(({ session }) => {
      const entries: Array<Record<string, unknown>> = []; Reflect.set(globalThis, '__capturePermissionTrace', entries);
      const prototype = Object.getPrototypeOf(session.defaultSession) as Electron.Session;
      const check = prototype.setPermissionCheckHandler; const permission = prototype.setPermissionRequestHandler; const display = prototype.setDisplayMediaRequestHandler;
      prototype.setPermissionCheckHandler = function(handler) {
        if (!handler) return check.call(this, handler);
        return check.call(this, (contents, name, origin, details) => {
          const allowed = handler(contents, name, origin, details);
          entries.push({ kind: 'check', name, contents: contents?.id, main: details.isMainFrame, mediaType: details.mediaType, allowed }); return allowed;
        });
      };
      prototype.setPermissionRequestHandler = function(handler) {
        if (!handler) return permission.call(this, handler);
        return permission.call(this, (contents, name, callback, details) => handler(contents, name, allowed => {
          entries.push({ kind: 'request', name, contents: contents?.id, main: details.isMainFrame, mediaTypes: (details as Electron.MediaAccessPermissionRequest).mediaTypes, allowed }); callback(allowed);
        }, details));
      };
      prototype.setDisplayMediaRequestHandler = function(handler, options) {
        if (!handler) return display.call(this, handler, options);
        return display.call(this, (details, callback) => handler(details, grant => {
          entries.push({ kind: 'display', videoRequested: details.videoRequested, audioRequested: details.audioRequested, frame: details.frame?.routingId, video: !!grant.video, audio: grant.audio }); callback(grant);
        }), options);
      };
    });
    await request(main, { type: 'open', task: 'screenshot' }); let tool = await toolPage(application);
    expect(await tool.evaluate(() => ({ keys: Object.keys((globalThis as unknown as Bridge).worldlinebox), process: typeof Reflect.get(globalThis, 'process'), require: typeof Reflect.get(globalThis, 'require') })))
      .toEqual({ keys: ['captureTools'], process: 'undefined', require: 'undefined' });
    const captured = (await request(tool, { type: 'screenshot.capture', sourceId: fixture.sourceId })).source!;
    expect(captured.title).toContain('WorldlineBox Capture Fixture'); expect(captured.width).toBeGreaterThan(100); expect(captured.height).toBeGreaterThan(100);
    expect((await sharp(Buffer.from(captured.dataUrl.split(',')[1]!, 'base64')).metadata()).format).toBe('png');
    await tool.reload(); await expect(tool.getByLabel('截图编辑画布')).toBeVisible();
    await expect(tool.locator('.screenshot-studio')).toHaveCount(0);
    await tool.getByRole('button', { name: '遮盖', exact: true }).click();
    const surface = tool.getByLabel('截图编辑画布'); const bounds = await surface.boundingBox(); if (!bounds) throw Error('Missing screenshot editing canvas');
    await tool.mouse.move(bounds.x + bounds.width * .2, bounds.y + bounds.height * .2); await tool.mouse.down();
    await tool.mouse.move(bounds.x + bounds.width * .4, bounds.y + bounds.height * .4, { steps: 8 }); await tool.mouse.up();
    previousClipboard = await application.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage().toDataURL() }));
    await tool.getByRole('button', { name: '复制图片', exact: true }).click(); await expect(tool.getByRole('status')).toContainText('已复制截图');
    const copied = await application.evaluate(({ clipboard }) => Array.from(clipboard.readImage().toPNG()));
    expect((await sharp(Buffer.from(copied)).metadata()).width).toBe(captured.width);
    const copiedCenter = await sharp(Buffer.from(copied)).extract({ left: Math.floor(captured.width * .3), top: Math.floor(captured.height * .3), width: 1, height: 1 }).removeAlpha().raw().toBuffer(); expect([...copiedCenter]).toEqual([0, 0, 0]);
    const artifacts = path.resolve('.tools/test-output'); mkdirSync(artifacts, { recursive: true });
    await tool.screenshot({ path: path.join(artifacts, 'capture-tools-editor.png') });
    await tool.getByRole('button', { name: '保存到下载目录', exact: true }).click(); await expect.poll(() => tool.isClosed()).toBe(true);
    await expect.poll(() => readdirSync(downloads).filter(file => file.endsWith('.png')).length).toBe(1);
    const saved = path.join(downloads, readdirSync(downloads).find(file => file.endsWith('.png'))!); const savedBytes = readFileSync(saved); const meta = await sharp(savedBytes).metadata();
    expect([meta.width, meta.height]).toEqual([captured.width, captured.height]);
    const center = await sharp(savedBytes).extract({ left: Math.floor(captured.width * .3), top: Math.floor(captured.height * .3), width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    expect([...center]).toEqual([0, 0, 0]);

    await request(main, { type: 'open', task: 'recording' }); tool = await toolPage(application);
    // Keep explicit window-source recording covered alongside the separate
    // real-monitor region-overlay scenario.
    await request(tool, { type: 'screenshot.capture', sourceId: fixture.sourceId }); await tool.reload();
    await expect(tool.getByRole('combobox', { name: '选择屏幕或窗口', exact: true })).toBeVisible();
    await expect.poll(() => tool.locator('select option').allTextContents()).toContain('窗口 · WorldlineBox Capture Fixture');
    await tool.getByRole('combobox', { name: '选择屏幕或窗口', exact: true }).selectOption(fixture.sourceId);
    await expect(tool.getByLabel('录制系统声音', { exact: true })).toBeChecked(); await expect(tool.getByLabel('录制麦克风', { exact: true })).not.toBeChecked();
    await tool.evaluate(() => {
      const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = async options => {
        try {
          const stream = await original(options);
          Reflect.set(globalThis, '__captureDisplayStream', stream);
          Reflect.set(globalThis, '__captureTrackProbe', { video: stream.getVideoTracks().length, audio: stream.getAudioTracks().length, requestedAudio: options?.audio === true });
          return stream;
        } catch (error) {
          Reflect.set(globalThis, '__captureDisplayError', error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) });
          throw error;
        }
      };
      const NativeRecorder = MediaRecorder;
      const events: Array<Record<string, unknown>> = []; Reflect.set(globalThis, '__captureRecorderEvents', events);
      globalThis.MediaRecorder = new Proxy(NativeRecorder, { construct(target, argumentsList) {
        const recorder = Reflect.construct(target, argumentsList) as MediaRecorder;
        Reflect.set(globalThis, '__captureNativeRecorder', recorder); Reflect.set(globalThis, '__captureRecordingStream', argumentsList[0]);
        for (const name of ['start', 'dataavailable', 'pause', 'resume', 'stop', 'error']) recorder.addEventListener(name, event => {
          const detail = event as Event & { data?: Blob; error?: DOMException };
          const entry: Record<string, unknown> = { name, time: performance.now(), size: detail.data?.size, error: detail.error?.message };
          events.push(entry);
          if (detail.data) void detail.data.slice(0, 8).arrayBuffer().then(bytes => { entry.prefix = Array.from(new Uint8Array(bytes)); });
        });
        return recorder;
      } });
    });
    await tool.getByRole('button', { name: '开始录制', exact: true }).click();
    await expect.poll(async () => (await tool.locator('.capture-recording-status').getAttribute('class'))?.includes('is-preparing'), { timeout: 30000 }).toBe(false);
    if (!(await tool.locator('.capture-recording-status').getAttribute('class'))?.includes('is-recording')) {
      const diagnostic = await tool.evaluate(() => ({ display: Reflect.get(globalThis, '__captureDisplayError'), tracks: Reflect.get(globalThis, '__captureTrackProbe'), alert: document.querySelector('[role="alert"]')?.textContent,
        status: document.querySelector('.capture-recording-status')?.textContent, active: document.hasFocus(), secure: isSecureContext }));
      const permissions = await application.evaluate(() => Reflect.get(globalThis, '__capturePermissionTrace'));
      await testInfo.attach('recording-start-diagnostic', { body: JSON.stringify({ ...diagnostic, state: (await request(main, { type: 'state' })).state?.recording, permissions, stderr: electronErrors }), contentType: 'application/json' });
      throw Error('Real desktop recording did not start: ' + JSON.stringify({ ...diagnostic, permissions }));
    }
    const tracks = await tool.evaluate(() => Reflect.get(globalThis, '__captureTrackProbe') as { video: number; audio: number; requestedAudio: boolean });
    expect(tracks.video).toBe(1); expect(tracks.requestedAudio).toBe(true);
    try {
      await expect.poll(async () => (await request(main, { type: 'state' })).state!.recording?.bytes ?? 0, { timeout: 8000 }).toBeGreaterThan(0);
    } catch (cause) {
      const diagnostic = await tool.evaluate(() => {
        const display = Reflect.get(globalThis, '__captureDisplayStream') as MediaStream | undefined;
        const stream = Reflect.get(globalThis, '__captureRecordingStream') as MediaStream | undefined;
        const recorder = Reflect.get(globalThis, '__captureNativeRecorder') as MediaRecorder | undefined;
        const tracks = (stream: MediaStream | undefined) => stream?.getTracks().map(track => ({ kind: track.kind, muted: track.muted, enabled: track.enabled, readyState: track.readyState, settings: track.getSettings() }));
        return { events: Reflect.get(globalThis, '__captureRecorderEvents'), display: tracks(display), recording: tracks(stream), recorder: { state: recorder?.state, mimeType: recorder?.mimeType }, alert: document.querySelector('[role="alert"]')?.textContent };
      });
      const state = (await request(main, { type: 'state' })).state?.recording;
      await testInfo.attach('recording-data-diagnostic', { body: JSON.stringify({ ...diagnostic, state, stderr: electronErrors }), contentType: 'application/json' });
      throw Error('Real desktop stream produced no recording bytes: ' + JSON.stringify({ ...diagnostic, state }), { cause });
    }
    const tone = await application.evaluate(async ({ BrowserWindow }, id) => {
      const source = BrowserWindow.fromId(id); if (!source) throw Error('Missing real recording fixture'); source.webContents.setAudioMuted(false);
      return source.webContents.executeJavaScript(`(async()=>{const a=new AudioContext();const o=a.createOscillator();const g=a.createGain();o.frequency.value=440;g.gain.value=.01;o.connect(g).connect(a.destination);o.start();await a.resume();setTimeout(()=>{o.stop();void a.close()},4000);return{state:a.state,sampleRate:a.sampleRate}})()`, true) as Promise<{ state: string; sampleRate: number }>;
    }, fixture.id);
    expect(tone.state).toBe('running');
    await tool.waitForTimeout(1200);
    await tool.getByRole('button', { name: '暂停', exact: true }).click(); await expect(tool.locator('.capture-recording-status')).toHaveClass(/is-paused/u);
    await tool.waitForTimeout(400); await tool.getByRole('button', { name: '继续', exact: true }).click();
    await tool.waitForTimeout(1500); await tool.getByRole('button', { name: '停止并保存', exact: true }).click();
    await expect(tool.locator('.capture-recording-status')).toHaveClass(/is-saved/u, { timeout: 60000 });
    const playback = await expectRecordingPlayback(tool);
    const resultWindow = await application.browserWindow(tool);
    const resultBounds = await resultWindow.evaluate(window => window.getBounds());
    await resultWindow.evaluate(window => window.setSize(640, 420));
    await expect.poll(() => tool.evaluate(() => innerWidth)).toBe(640);
    const compactLayout = await tool.locator('.capture-recording-result').evaluate(element => ({
      fits: element.scrollWidth <= element.clientWidth,
      stage: element.querySelector('.capture-result-stage')!.getBoundingClientRect().height,
      footerBottom: element.querySelector('footer')!.getBoundingClientRect().bottom, viewport: innerHeight,
    }));
    expect(compactLayout.fits).toBe(true); expect(compactLayout.stage).toBeGreaterThan(100);
    expect(compactLayout.footerBottom).toBeLessThanOrEqual(compactLayout.viewport);
    await resultWindow.evaluate((window, bounds) => window.setBounds(bounds), resultBounds);
    await tool.screenshot({ path: path.resolve('artifacts/recording-result-preview.png') });
    const recording = (await request(main, { type: 'state' })).state!.recording!;
    expect(recording.path).toBeTruthy(); expect(path.dirname(recording.path!)).toBe(downloads); expect(recording.path).toMatch(/\.mp4$/u);
    const ffprobe = path.resolve('resources/ffmpeg/win32-x64/ffprobe.exe'); const ffmpeg = path.resolve('resources/ffmpeg/win32-x64/ffmpeg.exe');
    const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-show_entries', 'format=duration,size', '-of', 'json', recording.path!], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    expect(probe.status, probe.stderr).toBe(0);
    const inspected = JSON.parse(probe.stdout) as { streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>; format: { duration: string } };
    expect(inspected.streams.filter(stream => stream.codec_type === 'video')).toHaveLength(1); expect(inspected.streams.some(stream => stream.codec_name === 'h264')).toBe(true);
    expect(inspected.streams.filter(stream => stream.codec_type === 'audio').length).toBe(tracks.audio > 0 ? 1 : 0);
    expect(Number(inspected.format.duration)).toBeGreaterThan(1);
    const decoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', recording.path!, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true, timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
    expect(decoded.status, decoded.stderr.toString()).toBe(0); expect(decoded.stdout.length).toBeGreaterThan(10000);
    expect(decoded.stdout.some(value => value > 20)).toBe(true);
    let audioPeak: number | undefined;
    if (tracks.audio) {
      const audio = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', recording.path!, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
      expect(audio.status, audio.stderr.toString()).toBe(0); audioPeak = 0;
      for (let offset = 0; offset + 1 < audio.stdout.length; offset += 2) audioPeak = Math.max(audioPeak, Math.abs(audio.stdout.readInt16LE(offset)));
      expect(audioPeak, 'The real system loopback should contain the fixture tone, not an invented silent audio track').toBeGreaterThan(2);
    }
    if (!tracks.audio) await expect(tool.getByText('所选来源未提供系统音轨，将继续录制画面。', { exact: true })).toBeVisible();
    await tool.screenshot({ path: path.join(artifacts, 'capture-tools-recording-saved.png') });
    // A second real session covers the crop canvas, no-audio GIF branch,
    // recording restart, and FFmpeg's animated-image conversion together.
    expect(playback.width).toBe(inspected.streams.find(stream => stream.codec_type === 'video')!.width);
    await tool.getByRole('button', { name: '再次录制', exact: true }).click();
    await tool.getByRole('combobox', { name: '输出格式', exact: true }).selectOption('gif');
    await expect(tool.getByLabel('录制系统声音', { exact: true })).not.toBeChecked();
    await expect(tool.getByLabel('录制系统声音', { exact: true })).toBeDisabled();
    await tool.getByLabel('仅录制选定区域', { exact: true }).check();
    for (const [name, value] of [['左侧 %', '25'], ['顶部 %', '25'], ['宽度 %', '50'], ['高度 %', '50']]) await tool.getByRole('spinbutton', { name, exact: true }).fill(value!);
    await tool.getByRole('button', { name: '开始录制', exact: true }).click();
    await expect(tool.locator('.capture-recording-status')).toHaveClass(/is-recording/u, { timeout: 15000 });
    const gifTracks = await tool.evaluate(() => Reflect.get(globalThis, '__captureTrackProbe') as { video: number; audio: number; requestedAudio: boolean });
    expect(gifTracks).toEqual({ video: 1, audio: 0, requestedAudio: false });
    await tool.waitForTimeout(2200); await tool.getByRole('button', { name: '停止并保存', exact: true }).click();
    await expect(tool.locator('.capture-recording-status')).toHaveClass(/is-saved/u, { timeout: 60000 });
    const gifPreview = tool.locator('.capture-result-stage > img');
    await expect.poll(() => gifPreview.evaluate(image => (image as HTMLImageElement).naturalWidth), { timeout: 15000 }).toBeGreaterThan(0);
    const gifRecording = (await request(main, { type: 'state' })).state!.recording!; expect(gifRecording.path).toMatch(/\.gif$/u);
    const gifProbe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_frames', '-show_entries', 'format=duration', '-of', 'json', gifRecording.path!], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    expect(gifProbe.status, gifProbe.stderr).toBe(0);
    const gifInspected = JSON.parse(gifProbe.stdout) as { streams: Array<{ codec_type: string; codec_name: string; width: number; height: number; nb_frames: string }>; format: { duration: string } };
    expect(gifInspected.streams).toHaveLength(1); expect(gifInspected.streams[0]?.codec_name).toBe('gif');
    const originalVideo = inspected.streams.find(stream => stream.codec_type === 'video')!;
    expect(gifInspected.streams[0]?.width).toBe(Math.floor(originalVideo.width! * .5 / 2) * 2);
    expect(gifInspected.streams[0]?.height).toBe(Math.floor(originalVideo.height! * .5 / 2) * 2);
    expect(Number(gifInspected.streams[0]?.nb_frames)).toBeGreaterThan(1); expect(Number(gifInspected.format.duration)).toBeGreaterThan(1);
    const gifPixels = await sharp(readFileSync(gifRecording.path!)).removeAlpha().raw().toBuffer(); expect(gifPixels.some(value => value > 20)).toBe(true);
    const recorderEvents = await tool.evaluate(() => Reflect.get(globalThis, '__captureRecorderEvents'));

    // Scroll a real native window manually and stitch its desktop captures.
    // The fixture contains unique colored tiles to make false overlap matches
    // distinguishable from a correct physical-pixel translation.
    const viewport = await application.evaluate(async ({ BrowserWindow }, id) => {
      const source = BrowserWindow.fromId(id); if (!source) throw Error('Missing scrolling fixture');
      return source.webContents.executeJavaScript(`(()=>{document.body.innerHTML='';document.body.style.cssText='margin:0;overflow-x:hidden;background:white';const c=document.createElement('canvas');const d=devicePixelRatio;c.width=Math.floor(innerWidth*d);c.height=Math.floor(1800*d);c.style.width=innerWidth+'px';c.style.height='1800px';c.style.display='block';document.body.append(c);const x=c.getContext('2d');x.scale(d,d);let seed=81273;for(let y=0;y<1800;y+=12)for(let xx=0;xx<innerWidth;xx+=16){seed=(Math.imul(seed,1664525)+1013904223)>>>0;x.fillStyle='rgb('+((seed>>>24)%160+60)+','+((seed>>>16)%160+60)+','+((seed>>>8)%160+60)+')';x.fillRect(xx,y,16,12)}scrollTo(0,0);return{width:innerWidth,height:innerHeight}})()`, true) as Promise<{ width: number; height: number }>;
    }, fixture.id);
    await request(main, { type: 'open', task: 'long-screenshot' }); tool = await toolPage(application);
    const firstLong = (await request(tool, { type: 'screenshot.capture', sourceId: fixture.sourceId })).source!;
    const longRect = { x: 20, y: 20, width: firstLong.width - 60, height: firstLong.height - 40 };
    const begun = await request(tool, { type: 'long.begin', rect: longRect, sourceId: fixture.sourceId }); expect(begun.long?.frames).toBe(1);
    const scrollY = await application.evaluate(async ({ BrowserWindow }, id) => {
      const source = BrowserWindow.fromId(id); if (!source) throw Error('Missing scrolling fixture');
      return source.webContents.executeJavaScript('scrollTo(0,220);scrollY', true) as Promise<number>;
    }, fixture.id);
    expect(scrollY).toBe(220);
    const appended = await request(tool, { type: 'long.append' }); expect(appended.long?.frames).toBe(2);
    const delta = appended.long!.height - longRect.height;
    expect(delta).toBeGreaterThan(100); expect(Math.abs(delta - scrollY * firstLong.height / viewport.height)).toBeLessThan(5);
    const completed = (await request(tool, { type: 'long.finish' })).source!;
    expect([completed.width, completed.height]).toEqual([longRect.width, appended.long!.height]);
    const longWindow = await application.browserWindow(tool); const longSize = await longWindow.evaluate(window => window.getContentSize());
    expect(Math.abs(longSize[0]! / longSize[1]! * completed.height - completed.width)).toBeLessThan(5);
    await expect(tool.locator('.screenshot-studio')).toHaveCount(0); await expect(tool.locator('body')).not.toContainText('截图工作台');
    const longBytes = Buffer.from(completed.dataUrl.split(',')[1]!, 'base64'); const longMetadata = await sharp(longBytes).metadata();
    expect(longMetadata).toMatchObject({ format: 'png', width: completed.width, height: completed.height });
    const firstBytes = Buffer.from(firstLong.dataUrl.split(',')[1]!, 'base64');
    const originalTop = await sharp(firstBytes).extract({ left: longRect.x, top: longRect.y, width: longRect.width, height: 80 }).removeAlpha().raw().toBuffer();
    expect(await sharp(longBytes).extract({ left: 0, top: 0, width: longRect.width, height: 80 }).removeAlpha().raw().toBuffer()).toEqual(originalTop);
    const originalBottom = await sharp(firstBytes).extract({ left: longRect.x, top: longRect.y + longRect.height - 80, width: longRect.width, height: 80 }).removeAlpha().raw().toBuffer();
    const newBottom = await sharp(longBytes).extract({ left: 0, top: completed.height - 80, width: longRect.width, height: 80 }).removeAlpha().raw().toBuffer(); expect(newBottom.equals(originalBottom)).toBe(false);
    await tool.reload(); await expect(tool.getByLabel('截图编辑画布')).toHaveAttribute('height', String(completed.height));
    if (previousClipboard) { await application.evaluate(({ clipboard, nativeImage }, previous) => clipboard.write({ text: previous.text, html: previous.html, rtf: previous.rtf, image: nativeImage.createFromDataURL(previous.image) }), previousClipboard); previousClipboard = undefined; }
    await application.close(); application = undefined;

    application = await launch(); main = await application.firstWindow(); await expect(main.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 30000 });
    expect((await request(main, { type: 'state' })).state!.settings).toEqual(settings);
    const evidence = { isolatedToolBridge: true, mainCannotCaptureOrWrite: true, editedPngAndClipboard: true, defaultsPersisted: true,
      realDesktopStream: tracks, tone, audioPeak, recorderEvents, mp4: inspected, croppedGif: gifInspected,
      nativeLongScreenshot: { frames: appended.long!.frames, width: completed.width, height: completed.height, newPhysicalPixels: delta, originalTopPreserved: true, duplicatedBottom: false }, savedImagePixels: [0, 0, 0], syntheticStreamUsed: false };
    console.log('CAPTURE_TOOLS_E2E_RESULT', JSON.stringify(evidence));
    await testInfo.attach('capture-tools-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
  } catch (cause) {
    originalFailure = true;
    throw cause;
  } finally {
    if (application && previousClipboard) await application.evaluate(({ clipboard, nativeImage }, previous) => clipboard.write({ text: previous.text, html: previous.html, rtf: previous.rtf, image: nativeImage.createFromDataURL(previous.image) }), previousClipboard).catch(() => undefined);
    let closingError: unknown;
    try { await application?.close(); } catch (cause) { closingError = cause; }
    const logs = path.join(profile, 'logs');
    if (testInfo.status !== testInfo.expectedStatus && existsSync(logs)) for (const name of readdirSync(logs)) if (name.endsWith('.log')) await testInfo.attach(name, { body: readFileSync(path.join(logs, name)), contentType: 'text/plain' });
    try { cleanup(root); } catch (cause) {
      if (!originalFailure && !closingError) cleanupFailure = cause;
      else await testInfo.attach('cleanup-diagnostic', { body: cause instanceof Error ? cause.message : String(cause), contentType: 'text/plain' });
    }
    if (!originalFailure && closingError) cleanupFailure = closingError;
  }
  if (cleanupFailure) throw cleanupFailure;
});
