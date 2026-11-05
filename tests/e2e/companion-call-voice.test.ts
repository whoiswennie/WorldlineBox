import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { BotSnapshot, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { startBotProtocolModel } from '../fixtures/bot-protocol-model';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

interface Bridge { companionBot: WorldlineBoxBotApi; llm: WorldlineBoxLlmApi }
interface MediaProbe {
  streams: MediaStream[]; contexts: AudioContext[]; sounds: HTMLAudioElement[];
  playback: Array<{ activeMicTracks: number; captures: number }>;
  mouthPeak: number; watch: boolean;
}
interface LiveProbe { engine: { getSnapshot(): { live2dParams: Record<string, number> } } }
interface Fiber { return?: Fiber; memoizedState?: { memoizedState?: { current?: LiveProbe }; next?: Fiber['memoizedState'] } }
/** The isolated build needs the real VCP package at the same relative path as development. */
async function stageCallMemory(applicationRoot: string): Promise<void> {
  if (path.resolve(applicationRoot) === process.cwd() || process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) return;
  const owned = path.resolve('.tools/e2e-app');
  if (path.resolve(applicationRoot) !== owned || path.resolve(await realpath(owned)) !== owned) throw Error('Unexpected isolated call app directory');
  const source = path.resolve('.tools/bot-memory-release'), parent = path.join(owned, '.tools'), target = path.join(parent, 'bot-memory-release');
  if (!existsSync(path.join(source, 'vcp-memory/lib/client.cjs'))) throw Error('Stage the real VCP memory package before call acceptance');
  if ((await lstat(source)).isSymbolicLink() || path.resolve(await realpath(source)) !== source) throw Error('Unexpected VCP package source');
  await mkdir(parent, { recursive: true });
  if ((await lstat(parent)).isSymbolicLink() || path.resolve(await realpath(parent)) !== parent) throw Error('Unexpected VCP fixture parent');
  if (existsSync(target)) { if (!(await lstat(target)).isSymbolicLink() || await realpath(target) !== await realpath(source)) throw Error('Unexpected existing VCP fixture directory'); return; }
  // Only this exact leaf is a junction. Never link all of .tools (which would
  // recursively include this isolated app), or recursively remove the junction.
  await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}
async function removeVoiceProfile(profile: string): Promise<void> {
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-call-voice-')) throw Error('Unexpected voice-call cleanup path');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// eslint-disable-next-line no-empty-pattern -- The test owns its isolated Electron, synthetic microphone and CPU ASR.
test('meeting turns real microphone ASR into the original chat and resumes listening only after measured TTS playback', async ({}, testInfo) => {
  test.skip(!existsSync(path.resolve('tests/fixtures/media/sensevoice-zh.wav')) || !existsSync(path.resolve('resources/speech-models/model.int8.onnx')), 'Stage the pinned CPU ASR model and official Chinese WAV sample before native speech acceptance.');
  test.setTimeout(240000);
  testInfo.annotations.push({ type: 'voice-roundtrip-boundary', description: 'Real Chromium MediaRecorder, local SenseVoice, original Main chat and App Agent, actual MP3 playback/Live2D. The language model is a deterministic localhost protocol fixture; only the remote Edge stream uses a retained neutral MP3. No production profile or real microphone is accessed.' });
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-call-voice-'));
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-call-voice-')) throw Error('Unexpected isolated voice-call profile');
  const model = await startBotProtocolModel(), launch = resolveElectronLaunchOptions();
  await stageCallMemory(launch.cwd);
  const app = await electron.launch({ ...launch, args: [...launch.args, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.resolve('tests/fixtures/media/sensevoice-zh.wav')}`],
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ app, BrowserWindow }, input) => {
      if (app.getPath('userData') !== input.profile) throw Error('Voice-call acceptance must use its own profile');
      for (const window of BrowserWindow.getAllWindows()) { window.on('show', () => window.hide()); window.webContents.setAudioMuted(true); window.webContents.setBackgroundThrottling(false); window.setSize(1600, 1000); window.hide(); }
      const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      const bytes = require('node:fs').readFileSync(input.mp3) as Buffer;
      const { EdgeTTS } = require('node-edge-tts') as { EdgeTTS: { prototype: { streamAudio: (text: string) => AsyncGenerator<Buffer> } } };
      Reflect.set(globalThis, '__callVoiceEdgeTexts', []);
      Reflect.set(globalThis, '__callVoiceEdgeFailNext', false);
      EdgeTTS.prototype.streamAudio = async function* (text: string) {
        (Reflect.get(globalThis, '__callVoiceEdgeTexts') as string[]).push(text);
        if (Reflect.get(globalThis, '__callVoiceEdgeFailNext')) { Reflect.set(globalThis, '__callVoiceEdgeFailNext', false); throw Error('Controlled speech transport failure for retry acceptance'); }
        yield bytes;
      };
    }, { profile, mp3: path.resolve('tests/fixtures/media/xiaoyi-neutral.mp3') });
    const configured = await page.evaluate(baseUrl => (Reflect.get(window, 'worldlinebox') as Bridge).llm.setConfig({ apiFormat: 'openai_chat', model: 'protocol-fixture', baseUrl, apiKey: 'localhost-protocol-fixture-no-real-secret' }), model.baseUrl);
    expect(configured.ok).toBe(true);
    await page.locator('[data-application-module="companions"]').click();
    const original = await page.evaluate(async () => {
      const state = await (Reflect.get(window, 'worldlinebox') as Bridge).companionBot.request({ type: 'state' });
      return { room: state.snapshot!.conversations.find(room => room.kind === 'direct' && room.memberIds.includes('builtin-dafeiyu'))!.id, rooms: state.snapshot!.conversations.map(room => room.id) };
    });
    await page.evaluate(() => {
      localStorage.setItem('worldlinebox.companion-call.speech.v1', 'on');
      const probe: MediaProbe = { streams: [], contexts: [], sounds: [], playback: [], mouthPeak: 0, watch: true }; Reflect.set(window, '__callVoiceMedia', probe);
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => { const stream = await getUserMedia(constraints); probe.streams.push(stream); return stream; };
      const NativeAudio = window.Audio, NativeContext = window.AudioContext, play = HTMLMediaElement.prototype.play;
      window.Audio = class extends NativeAudio { constructor(src?: string) { super(src); probe.sounds.push(this); } };
      window.AudioContext = class extends NativeContext { constructor(options?: AudioContextOptions) { super(options); probe.contexts.push(this); } };
      HTMLMediaElement.prototype.play = function () {
        if (this.src.startsWith('blob:')) probe.playback.push({ activeMicTracks: probe.streams.flatMap(stream => stream.getTracks()).filter(track => track.readyState === 'live').length, captures: probe.streams.length });
        return play.call(this);
      };
    });
    await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与大肥鱼会面', exact: true }); await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await expect(meeting.locator('.bot-call-loading')).toHaveCount(0, { timeout: 90000 });
    await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible(); await expect(meeting.locator('.bot-call-model-error')).toHaveCount(0);
    await meeting.getByRole('button', { name: '展开会面输入', exact: true }).click();
    await expect(meeting.locator('.bot-composer')).toHaveCount(1); await expect(page.locator('.bot-composer')).toHaveCount(1);
    const composerBounds = await meeting.locator('.bot-call-composer-host').boundingBox(), meetingBounds = await meeting.boundingBox();
    expect(composerBounds).not.toBeNull(); expect(meetingBounds).not.toBeNull();
    expect(composerBounds!.x).toBeGreaterThanOrEqual(meetingBounds!.x); expect(composerBounds!.y).toBeGreaterThanOrEqual(meetingBounds!.y);
    expect(composerBounds!.x + composerBounds!.width).toBeLessThanOrEqual(meetingBounds!.x + meetingBounds!.width + 1); expect(composerBounds!.y + composerBounds!.height).toBeLessThanOrEqual(meetingBounds!.y + meetingBounds!.height + 1);
    const typed = meeting.getByRole('textbox', { name: '发送消息…', exact: true });
    await expect(meeting.getByRole('button', { name: '添加文件', exact: true })).toBeVisible(); await expect(meeting.getByRole('button', { name: '语音转文字', exact: true })).toBeVisible();
    await meeting.getByRole('button', { name: '表情', exact: true }).click(); await meeting.getByRole('button', { name: '🐳', exact: true }).click();
    await expect(typed).toHaveValue('🐳'); await typed.fill('');
    expect(await page.evaluate(() => (Reflect.get(window, '__callVoiceMedia') as MediaProbe).streams.length)).toBe(0); // Dial/connect alone never opens the microphone.
    await page.evaluate(() => {
      const element = document.querySelector('.bot-call-live2d')!, key = Object.keys(element).find(key => key.startsWith('__reactFiber'))!;
      let runtime: LiveProbe | undefined;
      for (let fiber = Reflect.get(element, key) as Fiber | undefined; fiber; fiber = fiber.return) for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const candidate = hook.memoizedState?.current; if (typeof candidate?.engine?.getSnapshot === 'function') runtime = candidate;
      }
      if (!runtime) throw Error('Missing the mounted display-only Live2D runtime');
      const probe = Reflect.get(window, '__callVoiceMedia') as MediaProbe, mountedRuntime = runtime;
      const sample = () => { if (!probe.watch) return; probe.mouthPeak = Math.max(probe.mouthPeak, mountedRuntime.engine.getSnapshot().live2dParams.ParamMouthOpenY ?? 0); requestAnimationFrame(sample); }; requestAnimationFrame(sample);
    });
    const voice = meeting.getByRole('region', { name: '会面语音对话', exact: true });
    const continuous = meeting.getByRole('button', { name: '连续语音对话', exact: true }); await expect(continuous).toHaveAttribute('aria-pressed', 'false');
    await continuous.click(); await expect(continuous).toHaveAttribute('aria-pressed', 'true');
    await expect(voice).toContainText('正在聆听', { timeout: 60000 });
    await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__callVoiceMedia') as MediaProbe).streams.length)).toBe(1);
    const evidence = path.resolve('artifacts/superagent-bot-development/ui'); await mkdir(evidence, { recursive: true });
    const capture = async (name: string) => {
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const bytes = Buffer.from(png, 'base64'); await writeFile(testInfo.outputPath(name), bytes); await writeFile(path.join(evidence, name), bytes);
    };
    await capture('companion-call-voice-listening.png');
    // A real synthetic utterance is recorded. The same control also permits a
    // person to finish explicitly instead of waiting for the silence endpoint.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 4000)));
    const finish = meeting.getByRole('button', { name: '说完了', exact: true }); if (await finish.isVisible()) await finish.click();
    await expect(meeting.locator('.bot-call-transcript article.is-user')).toHaveCount(1, { timeout: 60000 });
    const state = async (): Promise<BotSnapshot> => (await page.evaluate(async room => (Reflect.get(window, 'worldlinebox') as Bridge).companionBot.request({ type: 'state', conversationId: room }), original.room)).snapshot!;
    await expect.poll(async () => {
      const snapshot = await state(), reply = snapshot.messages.find(message => message.senderId === 'builtin-dafeiyu');
      if (reply?.status === 'failed') { await writeFile(path.join(evidence, 'companion-call-voice-failed.json'), JSON.stringify({ reply, runtime: snapshot.runtime, modelCounters: model.counters }, null, 2)); throw Error(`The original chat reply failed: ${reply.error ?? reply.content}`); }
      return reply?.status;
    }, { timeout: 90000 }).toBe('sent');
    const transcript = (await state()).messages.find(message => message.senderId === 'user')!;
    expect(transcript.conversationId).toBe(original.room); expect(transcript.content).toMatch(/开放|时间|早上|下午|点/u); expect(transcript.attachments ?? []).toEqual([]);
    await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__callVoiceMedia') as MediaProbe).playback.length), { timeout: 30000 }).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__callVoiceMedia') as MediaProbe).mouthPeak), { timeout: 10000 }).toBeGreaterThan(.08);
    await capture('companion-call-voice-speaking.png');
    await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__callVoiceMedia') as MediaProbe).streams.length), { timeout: 30000 }).toBe(2);
    await expect(voice).toContainText('正在聆听');
    const firstCycle = await page.evaluate(() => { const probe = Reflect.get(window, '__callVoiceMedia') as MediaProbe; return { playback: probe.playback, mouthPeak: probe.mouthPeak, firstTracksEnded: probe.streams[0]!.getTracks().every(track => track.readyState === 'ended'), nextTracksLive: probe.streams[1]!.getTracks().every(track => track.readyState === 'live') }; });
    expect(firstCycle.playback.every(start => start.activeMicTracks === 0)).toBe(true); expect(firstCycle.firstTracksEnded).toBe(true); expect(firstCycle.nextTracksLive).toBe(true);
    // Fail only the next remote TTS stream. Retrying it must keep the original
    // reply/message IDs and the draft; it must not ask the chat brain again.
    await app.evaluate(() => Reflect.set(globalThis, '__callVoiceEdgeFailNext', true));
    await typed.fill('朗读故障验收：这仍然是同一段会面聊天。'); await meeting.getByRole('button', { name: '发送 ↑', exact: true }).click();
    const speechError = meeting.locator('.bot-call-speech-error'); await expect(speechError).toBeVisible({ timeout: 60000 });
    const routerRequests = () => model.counters.requests - model.counters.captures - model.counters.summaries;
    const beforeRetry = await state(), callsBeforeRetry = routerRequests();
    await typed.fill('保留这段文字草稿，重试朗读时不发送它。');
    await expect(meeting.getByRole('button', { name: '发送 ↑', exact: true })).toBeEnabled();
    await capture('companion-call-voice-retry.png');
    await speechError.getByRole('button', { name: '重试朗读', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__callVoiceMedia') as MediaProbe).playback.length)).toBeGreaterThan(firstCycle.playback.length);
    await expect(voice).toContainText('正在聆听', { timeout: 30000 });
    await expect(typed).toHaveValue('保留这段文字草稿，重试朗读时不发送它。');
    const afterRetry = await state(); expect(afterRetry.messages.map(message => message.id)).toEqual(beforeRetry.messages.map(message => message.id)); expect(routerRequests()).toBe(callsBeforeRetry);
    await continuous.click(); await expect(continuous).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__callVoiceMedia') as MediaProbe).streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
    // A new capture is cancelled by hangup before it can become an old-room send.
    await continuous.click(); await expect(voice).toContainText('正在聆听');
    await meeting.getByRole('button', { name: '结束并关闭会面', exact: true }).click(); await expect(meeting).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => { const probe = Reflect.get(window, '__callVoiceMedia') as MediaProbe; return probe.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')) && probe.contexts.every(context => context.state === 'closed') && probe.sounds.every(audio => audio.paused); })).toBe(true);
    const after = await state();
    expect(after.conversations.map(room => room.id)).toEqual(original.rooms); expect(after.messages.filter(message => message.senderId === 'user')).toHaveLength(2);
    expect(after.messages.filter(message => message.senderId === 'builtin-dafeiyu' && message.status === 'sent')).toHaveLength(2);
    await expect(page.locator('.bot-transcript')).toContainText(transcript.content);
    await expect(page.getByRole('textbox', { name: '发送消息…', exact: true })).toHaveValue('保留这段文字草稿，重试朗读时不发送它。');
    expect(model.counters.requests).toBeGreaterThan(0); expect(model.counters.toolCalls).toBe(0); expect(errors).toEqual([]);
    const edgeTexts = await app.evaluate(() => Reflect.get(globalThis, '__callVoiceEdgeTexts') as string[]); expect(edgeTexts).toContain('你好，伙伴主脑已经接入。');
    await page.evaluate(() => { (Reflect.get(window, '__callVoiceMedia') as MediaProbe).watch = false; });
    await writeFile(path.join(evidence, 'companion-call-voice-evidence.json'), JSON.stringify({ microphone: 'Chromium fake microphone using the official Chinese sample; no real device', asr: 'Real local SenseVoice INT8 CPU through production Main IPC', model: 'Existing App Agent against deterministic localhost protocol fixture; no model-quality claim or paid request', tts: 'Production authorized Edge speech pipeline, with remote stream alone replaced by retained neutral Xiaoyi MP3', conversationId: original.room, recognizedText: transcript.content, noNewConversation: true, noPersistentCallRecordingAttachment: true, firstCycle, listeningResumedAfterPlayback: true, ttsFailureRetryPreservesChatAndDraftWithoutModelResend: true, originalFullComposerWithEmojiAndAttachments: true, sameDraftPreservedAfterHangup: true, closeAndHangupReleaseAllCaptureAndPlayback: true, hangupDoesNotSendIncompleteCapture: true, modelCounters: model.counters, edgeTexts, errors }, null, 2));
  } finally {
    await app.close(); await model.close();
    await removeVoiceProfile(profile);
  }
});
