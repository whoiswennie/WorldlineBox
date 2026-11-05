import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import sharp from 'sharp';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxBotSpeechApi } from '../../src/shared/companion-bot-speech';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

interface EdgeFixtureCall { text: string; voice: string }
interface ProbeState { state: string; parameters: Record<string, number>; valence: number }
interface PerformanceProbe { engine: { getSnapshot(): { state: string; live2dParams: Record<string, number>; vad: { current: { valence: number } } } } }
interface ReactFiber { return?: ReactFiber; memoizedState?: { memoizedState?: { current?: PerformanceProbe }; next?: ReactFiber['memoizedState'] } }

// eslint-disable-next-line no-empty-pattern -- The real isolated Electron app owns its page and WebGL renderer.
test('meeting reads real sent replies through Main speech authorization, animates measured audio and continuous idle, and releases playback on stop/mute/end', async ({}, testInfo) => {
  test.setTimeout(240000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-call-speech-'));
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-call-speech-')) throw Error('Unexpected isolated speech profile');
  const fixtureDirectory = testInfo.outputPath('fixture'); await mkdir(fixtureDirectory, { recursive: true });
  await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-call-speech-fixture.ts', target: 'node24', outDir: fixtureDirectory, emptyOutDir: false, rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'seed.cjs' } } } });
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ app, BrowserWindow }, input) => {
      if (app.getPath('userData') !== input.profile) throw Error('Speech acceptance must use its isolated profile');
      for (const window of BrowserWindow.getAllWindows()) { window.on('show', () => window.hide()); window.webContents.setAudioMuted(true); window.webContents.setBackgroundThrottling(false); window.setSize(1600, 1000); window.hide(); }
      const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      const bytes = require('node:fs').readFileSync(input.mp3) as Buffer;
      const { EdgeTTS } = require('node-edge-tts') as { EdgeTTS: { prototype: { streamAudio: (text: string) => AsyncGenerator<Buffer> } } };
      Reflect.set(globalThis, '__callSpeechEdgeCalls', []); Reflect.set(globalThis, '__callSpeechDelay', 0);
      // Replace only the remote stream. The real Main IPC, service authorization,
      // proxy resolution, transport client and audio decoding/playback remain active.
      EdgeTTS.prototype.streamAudio = async function* (this: { voice: string }, text: string) {
        (Reflect.get(globalThis, '__callSpeechEdgeCalls') as EdgeFixtureCall[]).push({ text, voice: this.voice });
        const delay = Reflect.get(globalThis, '__callSpeechDelay') as number;
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        yield bytes;
      };
    }, { profile, mp3: path.resolve('tests/fixtures/media/xiaoyi-neutral.mp3') });
    const companions = page.locator('[data-application-module="companions"]'); await companions.click();
    const rooms = await page.evaluate(async () => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      const initial = await api.request({ type: 'state' }), id = initial.snapshot!.conversations.find(room => room.kind === 'direct' && room.memberIds.includes('builtin-dafeiyu'))!.id;
      const created = await api.request({ type: 'companion.create', name: '语音权限验收伙伴', persona: '用于隔离语音权限验证，不执行任务。' });
      if (!created.ok) throw Error('Cannot create the second speech audience');
      const current = await api.request({ type: 'state' }), companion = current.snapshot!.companions.find(item => item.name === '语音权限验收伙伴')!;
      const opened = await api.request({ type: 'conversation.open', companionId: companion.id });
      if (!opened.ok || !opened.conversationId) throw Error('Cannot open the second speech audience');
      const state = await api.request({ type: 'state', conversationId: id });
      return { id, other: opened.conversationId, ids: state.snapshot!.conversations.map(room => room.id) };
    });
    const seed = async (key: string, content: string, notify = true) => {
      const result = await app.evaluate(({ app, BrowserWindow }, input) => {
        const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
        const result = (require(input.fixture) as { seedCallSpeech(profile: string, room: string, key: string, content: string): { id: string; status: string; events: number } }).seedCallSpeech(input.profile, input.room, input.key, input.content);
        if (input.notify) BrowserWindow.getAllWindows()[0]!.webContents.send('companion-bot:event', { type: 'changed', conversationId: input.room });
        return result;
      }, { fixture: path.join(fixtureDirectory, 'seed.cjs'), profile, room: rooms.id, key, content, notify });
      expect(result.events).toBe(0); expect(result.status).toBe('sent'); return result.id;
    };
    const historyId = await seed('historical', '这是接通前的历史回复，不应该自动重播。', false);
    await page.reload(); await companions.click();
    await page.locator('.bot-sidebar .bot-conversation').filter({ has: page.getByText('大肥鱼', { exact: true }) }).click();
    const denied = await page.evaluate(async input => (Reflect.get(window, 'worldlinebox') as { companionBotSpeech: WorldlineBoxBotSpeechApi }).companionBotSpeech.request({ type: 'speech.synthesize', conversationId: input.other, messageId: input.id, requestId: 'wrong-speech-audience' }), { other: rooms.other, id: historyId });
    expect(denied.ok).toBe(false); expect(denied.audio).toBeUndefined();
    await page.evaluate(() => {
      localStorage.setItem('worldlinebox.companion-call.speech.v1', 'on');
      const sounds: HTMLAudioElement[] = [], contexts: AudioContext[] = [];
      Reflect.set(window, '__callSpeechSounds', sounds); Reflect.set(window, '__callSpeechContexts', contexts);
      const NativeAudio = window.Audio, NativeContext = window.AudioContext;
      window.Audio = class extends NativeAudio { constructor(src?: string) { super(src); sounds.push(this); } };
      window.AudioContext = class extends NativeContext { constructor(options?: AudioContextOptions) { super(options); contexts.push(this); } };
    });
    await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与大肥鱼会面', exact: true }); await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await expect(meeting.locator('.bot-call-loading')).toHaveCount(0, { timeout: 90000 }); expect(await meeting.locator('.bot-call-model-error').allTextContents()).toEqual([]);
    await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible(); await expect(meeting.getByRole('button', { name: '摸摸头', exact: true })).toHaveCount(0);
    const auto = meeting.getByRole('button', { name: '自动朗读伙伴回复', exact: true }); await expect(auto).toHaveAttribute('aria-pressed', 'true');
    const edgeCalls = () => app.evaluate(() => Reflect.get(globalThis, '__callSpeechEdgeCalls') as EdgeFixtureCall[]);
    expect(await edgeCalls()).toEqual([]);
    const evidence = path.resolve('artifacts/superagent-bot-development/ui'); await mkdir(evidence, { recursive: true });
    const capture = async (name: string) => {
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const bytes = Buffer.from(png, 'base64'), file = testInfo.outputPath(name); await writeFile(file, bytes); await copyFile(file, path.join(evidence, name)); return bytes;
    };
    const beforeIdle = await capture('companion-call-idle-before.png');
    const idle = await page.evaluate(async () => {
      const element = document.querySelector('.bot-call-live2d')!, fiberKey = Object.keys(element).find(key => key.startsWith('__reactFiber'))!;
      let fiber = Reflect.get(element, fiberKey) as ReactFiber | undefined, probe: PerformanceProbe | undefined;
      for (let ancestor = 0; fiber && ancestor < 8; ancestor++, fiber = fiber.return) {
        for (let hook = fiber.memoizedState; hook; hook = hook.next) { const candidate = hook.memoizedState?.current; if (typeof candidate?.engine?.getSnapshot === 'function') probe = candidate; }
      }
      if (!probe) throw Error('Cannot inspect the mounted display-only SDK runtime');
      const samples: Record<string, number>[] = [], deadline = performance.now() + 16000;
      while (performance.now() < deadline) { samples.push({ ...probe.engine.getSnapshot().live2dParams }); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); }
      const range = (key: string) => { const values = samples.map(sample => sample[key] ?? 0); return { min: Math.min(...values), max: Math.max(...values), span: Math.max(...values) - Math.min(...values) }; };
      return { frames: samples.length, head: range('ParamAngleX'), tilt: range('ParamAngleZ'), body: range('ParamBodyAngleX'), breath: range('ParamBreath'), eye: range('ParamEyeLOpen'), gaze: range('ParamEyeBallX'), mouth: range('ParamMouthOpenY') };
    });
    const afterIdle = await capture('companion-call-idle-after.png');
    expect(idle.frames).toBeGreaterThan(30); expect(idle.head.span).toBeGreaterThan(.5); expect(idle.body.span).toBeGreaterThan(.2); expect(idle.breath.span).toBeGreaterThan(.3); expect(idle.eye.span).toBeGreaterThan(.15); expect(idle.mouth.max).toBeLessThan(.015);
    const bounds = await meeting.locator('.bot-call-live2d').boundingBox(); if (!bounds) throw Error('No model capture bounds');
    const imageSize = await sharp(beforeIdle).metadata(), viewportWidth = await page.evaluate(() => innerWidth), pixelRatio = imageSize.width! / viewportWidth;
    const crop = { left: Math.ceil((bounds.x + bounds.width * .25) * pixelRatio), top: Math.ceil((bounds.y + bounds.height * .1) * pixelRatio), width: Math.floor(bounds.width * .5 * pixelRatio), height: Math.floor(bounds.height * .8 * pixelRatio) };
    const left = await sharp(beforeIdle).extract(crop).removeAlpha().raw().toBuffer(), right = await sharp(afterIdle).extract(crop).removeAlpha().raw().toBuffer();
    let changedPixels = 0; for (let offset = 0; offset < left.length; offset += 3) if (Math.abs(left[offset]! - right[offset]!) + Math.abs(left[offset + 1]! - right[offset + 1]!) + Math.abs(left[offset + 2]! - right[offset + 2]!) > 30) ++changedPixels;
    const changedRatio = changedPixels / (left.length / 3); expect(changedRatio).toBeGreaterThan(.002);
    const readProbe = () => page.evaluate((): ProbeState => {
      const element = document.querySelector('.bot-call-live2d')!, key = Object.keys(element).find(key => key.startsWith('__reactFiber'))!;
      for (let fiber = Reflect.get(element, key) as ReactFiber | undefined; fiber; fiber = fiber.return) for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const candidate = hook.memoizedState?.current; if (typeof candidate?.engine?.getSnapshot === 'function') { const state = candidate.engine.getSnapshot(); return { state: state.state, parameters: { ...state.live2dParams }, valence: state.vad.current.valence }; }
      }
      throw Error('Mounted SDK runtime is missing');
    });
    const firstId = await seed('first', '你好，今天也很高兴见到你。我们慢慢聊，我会认真听你说。');
    await expect(meeting.locator('.bot-call-speech-controls')).toHaveAttribute('data-speech-phase', 'speaking');
    const voiceSamples: number[] = [];
    await expect.poll(async () => { const state = await readProbe(); voiceSamples.push(state.parameters.ParamMouthOpenY ?? 0); return Math.max(...voiceSamples); }).toBeGreaterThan(.08);
    await capture('companion-call-speaking-xiaoyi.png');
    await expect(meeting.locator('.bot-call-speech-controls')).toHaveAttribute('data-speech-phase', 'idle', { timeout: 15000 });
    await expect.poll(async () => (await readProbe()).parameters.ParamMouthOpenY ?? 0).toBeLessThan(.015);
    expect(await edgeCalls()).toEqual([{ text: '你好，今天也很高兴见到你。我们慢慢聊，我会认真听你说。', voice: 'zh-CN-XiaoyiNeural' }]);
    await meeting.locator('.bot-call-history-toggle').click();
    const firstReply = meeting.locator(`[data-call-message="${firstId}"]`); await firstReply.getByRole('button', { name: '朗读这条消息', exact: true }).click();
    await expect(meeting.locator('.bot-call-speech-controls')).toHaveAttribute('data-speech-phase', 'speaking');
    await meeting.locator('.bot-call-speech-controls').getByRole('button', { name: '停止朗读', exact: true }).click();
    await expect.poll(async () => (await readProbe()).parameters.ParamMouthOpenY ?? 0).toBeLessThan(.015);
    expect((await edgeCalls()).length).toBe(1); // Replay passed through real authorization and the Main cache.
    await auto.click(); await expect(auto).toHaveAttribute('aria-pressed', 'false');
    const mutedId = await seed('muted', '这一条在关闭自动朗读时到达，只显示在原来的聊天里。');
    await expect(meeting.locator(`[data-call-message="${mutedId}"]`)).toContainText('关闭自动朗读');
    expect((await edgeCalls()).length).toBe(1); await auto.click(); await expect(auto).toHaveAttribute('aria-pressed', 'true'); expect((await edgeCalls()).length).toBe(1);
    await app.evaluate(() => Reflect.set(globalThis, '__callSpeechDelay', 1200));
    const delayedId = await seed('delayed', '这是正在生成的语音，停止后不应在后台继续播放。');
    await expect(meeting.locator('.bot-call-speech-controls')).toHaveAttribute('data-speech-phase', 'preparing');
    await expect.poll(async () => (await edgeCalls()).length).toBe(2);
    await meeting.locator('.bot-call-speech-controls').getByRole('button', { name: '停止朗读', exact: true }).click();
    await expect.poll(async () => {
      const state = await page.evaluate(() => ({ active: (Reflect.get(window, '__callSpeechSounds') as HTMLAudioElement[]).some(audio => !audio.loop && !audio.paused), time: performance.now() }));
      return state.active;
    }).toBe(false);
    await app.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 1400)); Reflect.set(globalThis, '__callSpeechDelay', 0); });
    expect(await page.evaluate(() => (Reflect.get(window, '__callSpeechSounds') as HTMLAudioElement[]).some(audio => !audio.loop && !audio.paused))).toBe(false);
    const finalId = await seed('final', '我还在这里，挂断后会停下声音，下次见面继续聊。');
    await expect(meeting.locator('.bot-call-speech-controls')).toHaveAttribute('data-speech-phase', 'speaking');
    await meeting.getByRole('button', { name: '结束并关闭会面', exact: true }).click(); await expect(meeting).toHaveCount(0); await expect(page.locator('.bot-call-live2d canvas')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__callSpeechContexts') as AudioContext[]).every(context => context.state === 'closed'))).toBe(true);
    expect(await page.evaluate(() => (Reflect.get(window, '__callSpeechSounds') as HTMLAudioElement[]).every(audio => audio.paused))).toBe(true);
    const after = await page.evaluate(async room => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId: room }), rooms.id);
    expect(after.snapshot!.conversations.map(room => room.id)).toEqual(rooms.ids); expect(after.snapshot!.messages.filter(message => [historyId, firstId, mutedId, delayedId, finalId].includes(message.id))).toHaveLength(5);
    expect(after.snapshot!.messages.some(message => message.senderId === 'user')).toBe(false);
    expect(errors).toEqual([]);
    await writeFile(path.join(evidence, 'companion-call-speech-evidence.json'), JSON.stringify({ realMainIpcAndSpeechAuthorization: true, crossAudienceRejected: true, noNewAgentEvents: true, noNewConversationDuringMeeting: true, noHeadPatButton: true,
      fixture: 'Human-authored sent replies; node-edge-tts.streamAudio alone replaced with previously live-synthesized neutral Xiaoyi MP3. Live network/auth is separately verified.',
      realAudioContextAndMp3Decoding: true, historyNotReplayed: true, measuredVoiceMouthPeak: Math.max(...voiceSamples), idle, changedModelPixelsRatio: changedRatio,
      replayCache: true, muteSkipsIncomingHistory: true, cancellationNoLatePlayback: true, hangupClosesAudioContext: true, paidModelCalls: 0, edgeStreamCalls: await edgeCalls(), errors }, null, 2));
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
