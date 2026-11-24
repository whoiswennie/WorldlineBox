import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Locator } from '@playwright/test';
import * as koffi from 'koffi';
import { BOT_CHANNEL, type BotRequest, type BotResponse } from '../../src/shared/companion-bot';
import { BOT_PUSH_TO_TALK_CHANNEL } from '../../src/shared/companion-push-to-talk';
import { LOCAL_SPEECH_CHANNEL, type LocalSpeechRequest } from '../../src/shared/local-speech';
import { removeOwnedDirectorySync } from '../helpers/remove-owned-test-directory';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';
import { enableCallVisualFixture } from './fixtures/call-visual-binding';

// eslint-disable-next-line no-empty-pattern -- Exercises Win32 keyboard input and an isolated microphone.
test('sends Ctrl voice input with interruption priority across chat, video and desktop pet', async ({}) => {
  test.skip(process.platform !== 'win32', 'Win32 global shortcut');
  test.setTimeout(100_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-global-speech-'));
  const user32 = koffi.load('user32.dll');
  const key = user32.func('void __stdcall keybd_event(uint8_t key, uint8_t scan, uint32_t flags, uintptr_t extra)');
  const getForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
  const keyState = user32.func('int16_t __stdcall GetAsyncKeyState(int key)');
  const control = (released = false, right = false) => {
    key(0x11, 0x1d, Number(right) | (released ? 2 : 0), 0);
  };
  const release = () => { control(true); control(true, true); };
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const launch = resolveElectronLaunchOptions();
    app = await electron.launch({ ...launch, args: [...launch.args, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
    const page = await app.firstWindow(), owner = await app.browserWindow(page);
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-binding-backdrop')).toBeVisible();
    await enableCallVisualFixture(app, page);
    await expect(page.locator('.bot-binding-backdrop')).toBeHidden();
    await page.getByRole('tab', { name: /联系人/u }).click();
    await page.locator('.bot-contact').filter({ has: page.getByText('GPT', { exact: true }) }).click();
    const dial = page.getByRole('button', { name: '拨打伙伴电话', exact: true });
    await expect(dial).toBeEnabled();
    await page.evaluate(() => {
      const start = MediaRecorder.prototype.start;
      let recordings = 0;
      Reflect.set(window, 'hotkeyTestRecordings', () => recordings);
      MediaRecorder.prototype.start = function (timeslice) { start.call(this, timeslice); recordings++; };
    });
    const recordingsStarted = () => page.evaluate(() => (Reflect.get(window, 'hotkeyTestRecordings') as () => number)());

    // Isolate model and ASR results while keeping the real renderer, IPC, and WAV capture.
    const foreground = await app.evaluate(async ({ BrowserWindow, ipcMain }, { botChannel, speechChannel, hotkeyChannel }) => {
      type Handler = (event: Electron.IpcMainInvokeEvent, input: BotRequest) => Promise<BotResponse>;
      const original = (Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler>).get(botChannel)!;
      const background = BrowserWindow.getAllWindows()[0]!;
      const observed = { sends: [] as BotRequest[], waves: [] as number[], shortcuts: [] as string[], actions: [] as string[] };
      Reflect.set(background, 'hotkeyTest', observed);
      const send = background.webContents.send.bind(background.webContents);
      background.webContents.send = (channel, ...args) => {
        if (channel === hotkeyChannel) observed.actions.push(String(args[0]));
        send(channel, ...args);
      };
      ipcMain.removeHandler(botChannel);
      ipcMain.handle(botChannel, (event, input: BotRequest) => {
        if (input.type !== 'message.send') return original(event, input);
        observed.sends.push(input);
        return { ok: true, replyMessageIds: ['fixture-reply'] };
      });
      ipcMain.removeHandler(speechChannel);
      ipcMain.handle(speechChannel, (_event, input: LocalSpeechRequest) => {
        if (input.type === 'speech.status' || input.type === 'speech.prepare') return { ok: true, status: { phase: 'ready' } };
        if (input.type !== 'speech.transcribe') return { ok: true };
        const wav = Buffer.from(input.audio, 'base64');
        observed.waves.push(wav.toString('ascii', 0, 4) === 'RIFF' ? wav.readUInt32LE(40) : 0);
        return { ok: true, transcript: { text: '补充第' + observed.waves.length + '句', audioSeconds: 1, engine: 'sensevoice-int8-cpu' } };
      });
      const foreground = new BrowserWindow({ width: 320, height: 240, show: false });
      await foreground.loadURL('data:text/html,<textarea autofocus></textarea>');
      foreground.webContents.on('before-input-event', (event, input) => {
        if (input.control && ['KeyC', 'KeyV'].includes(input.code)) {
          if (input.type === 'keyDown') observed.shortcuts.push(input.code);
          event.preventDefault(); // Keep the fixture from touching the system clipboard.
        }
      });
      const handle = foreground.getNativeWindowHandle();
      return { id: foreground.id, handle: String(handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE()) };
    }, { botChannel: BOT_CHANNEL, speechChannel: LOCAL_SPEECH_CHANNEL, hotkeyChannel: BOT_PUSH_TO_TALK_CHANNEL });
    const observed = () => owner.evaluate(window => Reflect.get(window, 'hotkeyTest') as { sends: BotRequest[]; waves: number[]; shortcuts: string[]; actions: string[] });
    const focusForeground = async () => {
      await app!.evaluate(({ BrowserWindow }, { id, handle, modulePath }) => {
        const window = BrowserWindow.fromId(id)!;
        const modules = process.getBuiltinModule('node:module');
        const ffi = modules.createRequire(modulePath)('koffi') as typeof koffi;
        const user = ffi.load('user32.dll'), kernel = ffi.load('kernel32.dll');
        const foreground = user.func('uintptr_t __stdcall GetForegroundWindow()');
        const windowThread = user.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t window, uintptr_t pid)');
        const currentThread = kernel.func('uint32_t __stdcall GetCurrentThreadId()');
        const attach = user.func('int __stdcall AttachThreadInput(uint32_t source, uint32_t target, int enabled)');
        const bringToTop = user.func('int __stdcall BringWindowToTop(uintptr_t window)');
        const setForeground = user.func('int __stdcall SetForegroundWindow(uintptr_t window)');
        const other = windowThread(foreground(), 0), current = currentThread();
        const attached = other && other !== current && attach(current, other, 1);
        try {
          window.show();
          bringToTop(BigInt(handle));
          setForeground(BigInt(handle));
          window.focus();
          window.webContents.focus();
        } finally { if (attached) attach(current, other, 0); }
      }, { ...foreground, modulePath: path.resolve('package.json') });
      await expect.poll(() => String(getForegroundWindow())).toBe(foreground.handle);
    };
    const record = async (surface: Locator, count: number) => {
      await focusForeground();
      const right = count === 1;
      const actions = (await observed()).actions.length;
      const started = await recordingsStarted();
      control(false, right);
      try {
        await expect.poll(() => (keyState(right ? 0xa3 : 0xa2) & 0x8000) !== 0).toBe(true);
        await expect.poll(async () => (await observed()).actions.slice(actions)).toEqual(['press']);
        await expect(surface.getByText('正在录音，松开发送')).toBeVisible();
        await expect.poll(recordingsStarted).toBeGreaterThan(started);
        control(false, right); // Repeated key-down keeps the same recording.
        await new Promise(resolve => setTimeout(resolve, 800));
        expect((await observed()).sends).toHaveLength(count - 1);
      } finally { control(true, right); }
      await expect.poll(async () => (await observed()).actions.slice(actions)).toEqual(['press', 'release']);
      await expect.poll(async () => (await observed()).sends.length).toBe(count);
      const result = await observed();
      expect(result.waves).toHaveLength(count);
      expect(result.waves[count - 1]).toBeGreaterThan(8000);
      const send = result.sends[count - 1];
      if (send?.type !== 'message.send') throw Error('Missing push-to-talk message receipt.');
      expect(send).toMatchObject({ type: 'message.send', content: '补充第' + count + '句', delivery: 'interrupt',
        ...(count > 1 ? { surface: 'call' } : {}) });
      return send;
    };

    const chat = page.locator('.bot-main');
    const chatSend = await record(chat, 1);
    const recording = chat.getByText('正在录音，松开发送');
    await focusForeground();
    control();
    key(0x43, 0x2e, 0, 0);
    key(0x43, 0x2e, 2, 0);
    await expect.poll(async () => (await observed()).shortcuts).toContain('KeyC');
    await new Promise(resolve => setTimeout(resolve, 300));
    await expect(recording).toHaveCount(0);
    control(true);
    const discarded = (await observed()).actions.length;
    control();
    await expect(recording).toBeVisible();
    key(0x56, 0x2f, 0, 0);
    key(0x56, 0x2f, 2, 0);
    await expect.poll(async () => (await observed()).actions.slice(discarded)).toEqual(['press', 'discard']);
    await expect(recording).toHaveCount(0);
    control(true);
    expect((await observed()).waves).toHaveLength(1);
    await page.bringToFront();
    await dial.click();
    const meeting = page.getByRole('dialog', { name: '与GPT会面' });
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await expect(meeting.getByRole('button', { name: '切换为桌宠', exact: true })).toBeVisible();
    await meeting.getByRole('button', { name: '展开会面输入', exact: true }).click();
    await expect(meeting.getByRole('button', { name: '连续语音对话', exact: true })).toHaveCount(0);
    const videoSend = await record(meeting, 2);
    await page.bringToFront();
    const opening = app.waitForEvent('window');
    await meeting.getByRole('button', { name: '切换为桌宠', exact: true }).click();
    const pet = (await opening).getByRole('dialog', { name: '与GPT会面' });
    await expect(pet.getByRole('button', { name: '挂断', exact: true })).toBeVisible();
    await expect(pet.getByRole('button', { name: '连续语音对话', exact: true })).toHaveCount(0);
    expect(await record(pet, 3)).toMatchObject({ conversationId: videoSend.conversationId });
    expect(videoSend.conversationId).toBe(chatSend.conversationId);
  } finally {
    release();
    await app?.close();
    removeOwnedDirectorySync(profile);
  }
});
