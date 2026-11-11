import { copyFile, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxLocalSpeechApi } from '../../src/shared/local-speech';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';
import { dshRuntimeSchema, type WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

async function removeSpeechProfile(profile: string): Promise<void> {
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-local-speech-e2e-')) throw Error('Unexpected speech acceptance cleanup path');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** Only immutable official runtime code is copied, never an existing instance. */
async function stageSpeechExecutor(profile: string, program: string): Promise<string> {
  const artifact = path.dirname(program), record = dshRuntimeSchema.parse(JSON.parse(await readFile(path.join(artifact, 'artifact.json'), 'utf8')));
  const seal = JSON.parse(await readFile(path.join(artifact, 'seal.json'), 'utf8')) as { contentSha256: string; files: Array<{ path: string }> };
  if (record.contentSha256 !== seal.contentSha256) throw Error('Speech executor source does not match its official seal');
  const target = path.join(profile, 'dsh/runtimes', record.id), jobs = [...seal.files];
  await mkdir(target, { recursive: true });
  await Promise.all(Array.from({ length: 32 }, async () => {
    for (let file = jobs.pop(); file; file = jobs.pop()) {
      const destination = path.resolve(target, 'program', file.path), relative = path.relative(target, destination);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw Error('Invalid runtime fixture path');
      await mkdir(path.dirname(destination), { recursive: true }); await copyFile(path.join(program, file.path), destination);
    }
  }));
  await copyFile(path.join(artifact, 'artifact.json'), path.join(target, 'artifact.json'));
  await copyFile(path.join(artifact, 'seal.json'), path.join(target, 'seal.json'));
  await writeFile(path.join(profile, 'dsh/runtimes.json'), JSON.stringify([record]));
  return record.id;
}

// eslint-disable-next-line no-empty-pattern -- The test owns a real, isolated Electron process and CPU model.
test('real CPU STT warms automatically at startup, records in one click, dictates and persists playable voice', async ({}, testInfo) => {
  test.skip(!existsSync(path.resolve('tests/fixtures/media/sensevoice-zh.wav')) || !existsSync(path.resolve('resources/speech-models/model.int8.onnx')), 'Stage the pinned speech model and official Chinese WAV fixture before native speech acceptance.');
  const nativeProgram = process.env.WORLDLINEBOX_BOT_DSH_PROGRAM;
  test.skip(!nativeProgram || !existsSync(nativeProgram), 'Set WORLDLINEBOX_BOT_DSH_PROGRAM to the official Node runtime: the real composer requires a configured shared executor.');
  test.setTimeout(300000);
  const original = await readFile(path.resolve('tests/fixtures/media/sensevoice-zh.wav'));
  // Official sample is a canonical 16kHz PCM16 WAV.
  const base64 = original.toString('base64');
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-local-speech-e2e-'));
  const runtimeId = await stageSpeechExecutor(profile, nativeProgram!);
  const launch = resolveElectronLaunchOptions();
  const app = await electron.launch({ ...launch, args: [...launch.args, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.resolve('tests/fixtures/media/sensevoice-zh.wav')}`],
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  try {
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) {
      const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData') }));
      expect(identity.packaged).toBe(true); expect(identity.appPath).toMatch(/app\.asar$/u); expect(identity.profile).toBe(profile);
    }
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.hide(); window.webContents.setAudioMuted(true); window.webContents.setBackgroundThrottling(false); window.setSize(1400, 950); } });
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    type Api = { localSpeech: WorldlineBoxLocalSpeechApi; companionBot: WorldlineBoxBotApi; companionBotMedia: WorldlineBoxBotMediaApi; dshLauncher: WorldlineBoxDshLauncherApi };
    // Status is read-only: reaching ready before opening companions proves that
    // startup actually loaded the native worker, rather than only locating files.
    await expect.poll(async () => page.evaluate(async () => (await (Reflect.get(window, 'worldlinebox') as Api).localSpeech.request({ type: 'speech.status' })).status?.phase), { timeout: 120000 }).toBe('ready');
    const startup = await page.evaluate(async () => (Reflect.get(window, 'worldlinebox') as Api).localSpeech.request({ type: 'speech.status' }));
    // Create a fresh shared instance using the real launcher. This acceptance
    // exercises speech input and sending; it does not assert model replies.
    const operation = async (id: string) => page.evaluate(async operationId => {
      const result = await (Reflect.get(window, 'worldlinebox') as Api).dshLauncher.request({ type: 'state' });
      if (!result.ok) throw Error(result.error); return result.state?.operations.find(item => item.id === operationId);
    }, id);
    const created = await page.evaluate(runtimeId => (Reflect.get(window, 'worldlinebox') as Api).dshLauncher.request({ type: 'instance.create', runtimeId, name: '语音验收共享实例' }), runtimeId);
    if (!created.ok) throw Error(created.error);
    await expect.poll(async () => (await operation(created.operationId!))?.status, { timeout: 60000 }).toBe('succeeded');
    await page.locator('[data-application-module="companions"]').click();
    const result = await page.evaluate(async audio => {
      const api = Reflect.get(window, 'worldlinebox') as Api;
      const state = await api.companionBot.request({ type: 'state' });
      const room = state.snapshot!.conversations.find(item => item.kind === 'direct')!.id;
      const dictated = await api.localSpeech.request({ type: 'speech.transcribe', requestId: 'dictate', audio });
      const voice = await api.localSpeech.request({ type: 'speech.voice', requestId: 'voice', conversationId: room, audio });
      if (!voice.ok || !voice.media) throw Error(voice.error ?? 'Voice import failed');
      const sent = await api.companionBot.request({ type: 'message.send', requestId: 'voice-send', conversationId: room, content: '', attachmentIds: [voice.media.id] });
      const other = await api.localSpeech.request({ type: 'speech.attachment', requestId: 'cross-room', conversationId: 'other', attachmentId: voice.media.id });
      const status = await api.localSpeech.request({ type: 'speech.status' });
      // Speech acceptance does not require an unrelated model reply. Finish this
      // fixture's reply so the next voice appears immediately rather than in the
      // ordinary chat queue behind the first native turn.
      for (const messageId of sent.replyMessageIds ?? []) await api.companionBot.request({ type: 'reply.cancel', messageId });
      return { room, dictated, voice, sent, other, status };
    }, base64);
    expect(startup.status?.phase).toBe('ready'); expect(result.dictated.transcript?.text).toContain('9');
    expect(result.voice.media?.voice?.durationSeconds).toBeCloseTo(5.592, 3); expect(result.sent.ok, result.sent.error).toBe(true); expect(result.other.ok).toBe(false);
    // Display the persisted message and its transcription using the actual renderer.
    await page.getByRole('button', { name: '录音发语音', exact: true }).click();
    await expect(page.getByRole('button', { name: '录音发语音', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.bot-voice-elapsed')).toHaveText('00:00');
    await expect(page.getByRole('region', { name: '本地语音' })).not.toContainText(/准备|最长|开始录音|按住空格/u);
    const panelBounds = await page.getByRole('region', { name: '本地语音' }).boundingBox();
    expect(panelBounds!.width).toBeLessThanOrEqual(310); expect(panelBounds!.height).toBeLessThanOrEqual(62); expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 1600);
    await expect(page.getByRole('textbox', { name: '发送消息…', exact: true })).toBeVisible();
    expect((await page.locator('.bot-composer').boundingBox())!.height).toBeLessThan(130);
    await mkdir(path.resolve('artifacts/local-speech'), { recursive: true });
    await page.screenshot({ path: path.resolve('artifacts/local-speech/voice-panel.png') });
    await page.getByRole('button', { name: '关闭语音', exact: true }).click();
    const voiceBubble = page.locator('.bot-voice-message'); await expect(voiceBubble).toHaveCount(1);
    await voiceBubble.getByRole('button', { name: '转文字', exact: true }).click(); await expect(voiceBubble).toContainText(result.dictated.transcript!.text);
    expect(await voiceBubble.locator('audio').getAttribute('preload')).toBe('none');
    const playback = await voiceBubble.locator('audio').evaluate(async audio => { const element = audio as HTMLAudioElement; element.load(); await new Promise<void>((resolve, reject) => { element.onloadedmetadata = () => resolve(); element.onerror = () => reject(Error('Voice media protocol failed')); }); return element.duration; });
    expect(playback).toBeCloseTo(5.592, 2);
    await voiceBubble.getByRole('button', { name: '播放语音消息', exact: true }).click();
    await expect(voiceBubble.getByRole('button', { name: '暂停语音消息', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await voiceBubble.getByRole('button', { name: '暂停语音消息', exact: true }).click();
    // Real MediaRecorder with Chromium's synthetic microphone: dictation fills the draft without sending.
    await page.getByRole('button', { name: '语音转文字', exact: true }).click();
    await expect(page.getByRole('button', { name: '语音转文字', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => Number((await page.locator('.bot-voice-elapsed').textContent())?.split(':')[1]), { timeout: 15000 }).toBeGreaterThanOrEqual(4);
    await expect.poll(async () => page.locator('.bot-voice-live-wave i').evaluateAll(items => items.some(item => Number.parseFloat((item as HTMLElement).style.height) > 3))).toBe(true);
    await page.screenshot({ path: path.resolve('artifacts/local-speech/dictation-recording.png') });
    await page.getByRole('button', { name: '语音转文字', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '发送消息…', exact: true })).not.toHaveValue('');
    await expect(page.locator('.bot-voice-panel')).toHaveCount(0);
    const after = await page.evaluate(async room => (Reflect.get(window, 'worldlinebox') as Api).companionBot.request({ type: 'state', conversationId: room }), result.room);
    expect(after.snapshot!.messages.filter(item => item.senderId === 'user')).toHaveLength(1);
    const dictatedDraft = await page.getByRole('textbox', { name: '发送消息…', exact: true }).inputValue();
    await page.getByRole('button', { name: '录音发语音', exact: true }).click();
    await expect.poll(async () => Number((await page.locator('.bot-voice-elapsed').textContent())?.split(':')[1]), { timeout: 15000 }).toBeGreaterThanOrEqual(4);
    await page.getByRole('button', { name: '结束录音', exact: true }).click();
    await page.getByRole('button', { name: '发送语音', exact: true }).click();
    await expect(page.locator('.bot-voice-panel')).toHaveCount(0);
    await expect.poll(async () => {
      const saved = await page.evaluate(async room => (Reflect.get(window, 'worldlinebox') as Api).companionBot.request({ type: 'state', conversationId: room }), result.room);
      return saved.snapshot?.messages.filter(message => message.senderId === 'user' && message.attachments?.some(file => !!file.voice)).length;
    }).toBe(2);
    await expect(voiceBubble).toHaveCount(2); await expect(page.getByRole('textbox', { name: '发送消息…', exact: true })).toHaveValue(dictatedDraft);
    await page.keyboard.press('Escape'); await expect(page.getByRole('textbox', { name: '发送消息…', exact: true })).toBeVisible();
    const long = Buffer.concat([original.subarray(0, 44), ...Array.from({ length: 14 }, () => original.subarray(44))]); long.writeUInt32LE(long.length - 8, 4); long.writeUInt32LE(long.length - 44, 40);
    const file = path.join(profile, 'long-voice.wav'); await writeFile(file, long);
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, file);
    const longer = await page.evaluate(async ({ room, tooLong }) => {
      const api = Reflect.get(window, 'worldlinebox') as Api;
      const invalid = await api.localSpeech.request({ type: 'speech.transcribe', requestId: 'too-long', audio: tooLong });
      const imported = await api.companionBotMedia.request({ type: 'files.pick', conversationId: room });
      const attachment = await api.localSpeech.request({ type: 'speech.attachment', requestId: 'long-file', conversationId: room, attachmentId: imported.media![0]!.id });
      return { invalid, attachment };
    }, { room: result.room, tooLong: long.toString('base64') });
    expect(longer.invalid.ok).toBe(false); expect(longer.attachment.ok, longer.attachment.error).toBe(true); expect(longer.attachment.transcript?.audioSeconds).toBeGreaterThan(60);
    const cancellable = Buffer.concat([original.subarray(0, 44), ...Array.from({ length: 10 }, () => original.subarray(44))]);
    cancellable.writeUInt32LE(cancellable.length - 8, 4); cancellable.writeUInt32LE(cancellable.length - 44, 40);
    await page.evaluate(audio => {
      const api = Reflect.get(window, 'worldlinebox') as Api;
      Reflect.set(window, '__speechCancellation', api.localSpeech.request({ type: 'speech.transcribe', requestId: 'cancel-running', audio }));
    }, cancellable.toString('base64'));
    await expect.poll(async () => page.evaluate(async () => (await (Reflect.get(window, 'worldlinebox') as Api).localSpeech.request({ type: 'speech.status' })).status?.phase)).toBe('transcribing');
    const cancellation = await page.evaluate(async audio => {
      const api = Reflect.get(window, 'worldlinebox') as Api;
      await api.localSpeech.request({ type: 'speech.cancel', requestId: 'cancel-running' });
      const cancelled = await Reflect.get(window, '__speechCancellation');
      const recovered = await api.localSpeech.request({ type: 'speech.transcribe', requestId: 'after-cancel', audio });
      Reflect.deleteProperty(window, '__speechCancellation'); return { cancelled, recovered };
    }, base64);
    expect(cancellation.cancelled.ok).toBe(false); expect(cancellation.recovered.transcript?.text).toBe(result.dictated.transcript?.text);
    expect(errors).toEqual([]);
    await mkdir(path.resolve('artifacts/local-speech'), { recursive: true });
    const screenshot = testInfo.outputPath('voice-chat.png'); await page.screenshot({ path: screenshot });
    await page.screenshot({ path: path.resolve('artifacts/local-speech/voice-chat.png') });
    await writeFile(path.resolve('artifacts/local-speech/electron-acceptance.json'), JSON.stringify({ startup, ...result, oneClickDictatedDraft: dictatedDraft, longAudio: longer.attachment.transcript, errors }, null, 2));
  } finally {
    await app.close();
    await removeSpeechProfile(profile);
  }
});
