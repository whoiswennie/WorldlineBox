import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

interface Probe {
  engine: { getSnapshot(): { live2dParams: Record<string, number>; profile: { parameterMap: { mouthOpen?: { min?: number; max?: number } } } } };
}
interface Fiber { return?: Fiber; memoizedState?: { memoizedState?: { current?: Probe }; next?: Fiber['memoizedState'] } }

// eslint-disable-next-line no-empty-pattern -- Owns the native Electron renderer, real decoded MP3 and actual Live2D rig.
test('neutral audible speech uses a visible jaw range and returns the real character to a closed mouth', async ({}, testInfo) => {
  test.setTimeout(120000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-call-mouth-'));
  const fixtureDirectory = testInfo.outputPath('fixture'); await mkdir(fixtureDirectory, { recursive: true });
  await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-call-speech-fixture.ts', target: 'node24', outDir: fixtureDirectory, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'seed.cjs' } } } });
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  try {
    await app.evaluate(({ app, BrowserWindow }, input) => {
      if (app.getPath('userData') !== input.profile) throw Error('Mouth acceptance requires its own profile');
      for (const window of BrowserWindow.getAllWindows()) { window.on('show', () => window.hide()); window.hide(); window.setSize(1400, 950); window.webContents.setAudioMuted(true); window.webContents.setBackgroundThrottling(false); }
      const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      const bytes = require('node:fs').readFileSync(input.mp3) as Buffer;
      const { EdgeTTS } = require('node-edge-tts') as { EdgeTTS: { prototype: { streamAudio: (text: string) => AsyncGenerator<Buffer> } } };
      EdgeTTS.prototype.streamAudio = async function* () { yield bytes; };
    }, { profile, mp3: path.resolve('tests/fixtures/media/xiaoyi-neutral.mp3') });
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.locator('[data-application-module="companions"]').click();
    const room = await page.evaluate(async () => {
      localStorage.setItem('worldlinebox.companion-call.speech.v1', 'on');
      const state = await (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state' });
      return state.snapshot!.conversations.find(item => item.kind === 'direct' && item.memberIds.includes('builtin-dafeiyu'))!.id;
    });
    await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与大肥鱼会面', exact: true }); await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await expect(meeting.locator('.bot-call-loading')).toHaveCount(0, { timeout: 60000 }); await expect(meeting.locator('.bot-call-model-error')).toHaveCount(0);
    await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible();
    await page.evaluate(() => {
      const stage = document.querySelector('.bot-call-live2d')!, key = Object.keys(stage).find(value => value.startsWith('__reactFiber'))!;
      let probe: Probe | undefined;
      for (let fiber = Reflect.get(stage, key) as Fiber | undefined; fiber; fiber = fiber.return) for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        if (typeof hook.memoizedState?.current?.engine?.getSnapshot === 'function') probe = hook.memoizedState.current;
      }
      if (!probe) throw Error('Missing mounted model runtime');
      const values: number[] = [], range = probe.engine.getSnapshot().profile.parameterMap.mouthOpen;
      Reflect.set(window, '__mouthEvidence', { values, range });
      const sample = () => { values.push(probe!.engine.getSnapshot().live2dParams.ParamMouthOpenY ?? 0); if (values.length < 900) requestAnimationFrame(sample); };
      sample();
    });
    const directory = path.resolve('artifacts/local-speech/mouth'); await mkdir(directory, { recursive: true });
    const capture = async (name: string) => {
      const bytes = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      await writeFile(path.join(directory, name), Buffer.from(bytes, 'base64'));
    };
    await capture('idle-closed.png');
    await app.evaluate(({ app, BrowserWindow }, input) => {
      const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      (require(input.fixture) as { seedCallSpeech(profile: string, room: string, key: string, content: string): unknown }).seedCallSpeech(input.profile, input.room, 'mouth-neutral', '你好，今天也很高兴见到你。我们慢慢聊，我会认真听你说。');
      BrowserWindow.getAllWindows()[0]!.webContents.send('companion-bot:event', { type: 'changed', conversationId: input.room });
    }, { profile, room, fixture: path.join(fixtureDirectory, 'seed.cjs') });
    const peak = () => page.evaluate(() => Math.max(...(Reflect.get(window, '__mouthEvidence') as { values: number[] }).values));
    await expect.poll(peak, { timeout: 15000 }).toBeGreaterThan(.45); await capture('neutral-speaking.png');
    await expect(meeting.locator('.bot-call-speech-controls')).toHaveAttribute('data-speech-phase', 'idle', { timeout: 15000 });
    await expect.poll(async () => page.evaluate(() => (Reflect.get(window, '__mouthEvidence') as { values: number[] }).values.at(-1) ?? 0)).toBeLessThan(.015);
    const evidence = await page.evaluate(() => {
      const value = Reflect.get(window, '__mouthEvidence') as { values: number[]; range: { min?: number; max?: number } };
      return { frames: value.values.length, min: Math.min(...value.values), max: Math.max(...value.values), closedEnd: value.values.at(-1), range: value.range };
    });
    expect(evidence.max).toBeLessThanOrEqual(1); expect(errors).toEqual([]);
    await capture('finished-closed.png');
    await writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ ...evidence, realDecodedNeutralXiaoyiMp3: true, actualLive2DRig: true, simulatedAudioLevels: false, errors }, null, 2));
    await meeting.getByRole('button', { name: '结束并关闭会面', exact: true }).click();
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
