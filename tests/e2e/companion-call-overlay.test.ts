import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { _electron as electron, expect, test, type Locator } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

interface Bridge { companionBot: WorldlineBoxBotApi }
interface LiveProbe { engine: { getSnapshot(): { live2dParams: Record<string, number> } } }
interface Fiber { return?: Fiber; memoizedState?: { memoizedState?: { current?: LiveProbe }; next?: Fiber['memoizedState'] } }
async function removeProfile(profile: string) {
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-call-overlay-')) throw Error('Unexpected overlay profile cleanup target');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// eslint-disable-next-line no-empty-pattern -- The test owns its real offscreen Electron and WebGL renderer.
test('galgame meeting keeps a centered full-bleed companion, card-free dialogue and collapsible original composer in light and dark appearance', async ({}, testInfo) => {
  test.setTimeout(180000);
  const captureOnly = process.env.WORLDLINEBOX_E2E_CALL_GALGAME_CAPTURE_ONLY === '1';
  if (captureOnly) testInfo.annotations.push({ type: 'presentation-only', description: 'Light/dark layout and screenshots after presentation changes. The separately recorded real media-clock/queue/retry acceptance is not repeated or claimed by this mode.' });
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-call-overlay-'));
  const fixtures = testInfo.outputPath('fixture'); await mkdir(fixtures, { recursive: true });
  await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-call-overlay-fixture.ts', target: 'node24', outDir: fixtures, emptyOutDir: false, rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'seed.cjs' } } } });
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  const errors: string[] = [], checks: unknown[] = [], evidence = path.resolve('artifacts/superagent-bot-development/ui');
  await mkdir(evidence, { recursive: true });
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ app, BrowserWindow }, owned) => {
      if (app.getPath('userData') !== owned.profile) throw Error('Full-bleed layout acceptance requires its own profile');
      for (const window of BrowserWindow.getAllWindows()) { window.on('show', () => window.hide()); window.hide(); window.webContents.setAudioMuted(true); window.webContents.setBackgroundThrottling(false); window.setSize(1600, 1000); }
      const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      const { EdgeTTS } = require('node-edge-tts') as { EdgeTTS: { prototype: { streamAudio: (text: string) => AsyncGenerator<Buffer> } } };
      const mp3 = require('node:fs').readFileSync(owned.mp3) as Buffer;
      Reflect.set(globalThis, '__overlaySpeechAttempts', 0);
      Reflect.set(globalThis, '__overlaySpeechFailure', false);
      Reflect.set(globalThis, '__overlaySpeechDelay', 0);
      // The real media clock/analyser stay active; only the remote stream is replaced.
      EdgeTTS.prototype.streamAudio = async function* () {
        Reflect.set(globalThis, '__overlaySpeechAttempts', Number(Reflect.get(globalThis, '__overlaySpeechAttempts')) + 1);
        if (Reflect.get(globalThis, '__overlaySpeechFailure')) throw Error('Controlled overlay speech transport failure');
        await new Promise(resolve => setTimeout(resolve, Number(Reflect.get(globalThis, '__overlaySpeechDelay')) || 0));
        yield mp3;
      };
    }, { profile, mp3: path.resolve('tests/fixtures/media/xiaoyi-neutral.mp3') });
    await page.locator('[data-application-module="companions"]').click();
    const room = await page.evaluate(async () => (await (Reflect.get(window, 'worldlinebox') as Bridge).companionBot.request({ type: 'state' })).snapshot!.conversations.find(room => room.kind === 'direct' && room.memberIds.includes('builtin-dafeiyu'))!.id);
    const seeded = await app.evaluate(({ app }, input) => {
      const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      return (require(input.fixture) as { seedCallOverlay(profile: string, room: string): { messageIds: string[]; events: number } }).seedCallOverlay(input.profile, input.room);
    }, { fixture: path.join(fixtures, 'seed.cjs'), profile, room });
    expect(seeded.events).toBe(0);
    const incoming = async (key: string, content: string) => app.evaluate(({ app, BrowserWindow }, input) => {
      const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      const result = (require(input.fixture) as { appendCallOverlayReply(profile: string, room: string, key: string, content: string): { messageId: string; events: number } }).appendCallOverlayReply(input.profile, input.room, input.key, input.content);
      BrowserWindow.getAllWindows()[0]!.webContents.send('companion-bot:event', { type: 'changed', conversationId: input.room }); return result;
    }, { fixture: path.join(fixtures, 'seed.cjs'), profile, room, key, content });
    const generating = async (key: string, content: string, status: 'running' | 'sent') => app.evaluate(({ app, BrowserWindow }, input) => {
      const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      const result = (require(input.fixture) as { updateCallOverlayReply(profile: string, room: string, key: string, content: string, status: 'running' | 'sent'): { messageId: string; events: number } }).updateCallOverlayReply(input.profile, input.room, input.key, input.content, input.status);
      BrowserWindow.getAllWindows()[0]!.webContents.send('companion-bot:event', { type: 'changed', conversationId: input.room }); return result;
    }, { fixture: path.join(fixtures, 'seed.cjs'), profile, room, key, content, status });
    const capture = async (name: string) => {
      await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
      // Choose an ordinary open-eye idle frame for the still image, without
      // pausing or changing the continuous performance/automatic blink state.
      await page.evaluate(async () => {
        const stage = document.querySelector('.bot-call-live2d'); if (!stage) return;
        const key = Object.keys(stage).find(key => key.startsWith('__reactFiber')); if (!key) return;
        let runtime: LiveProbe | undefined;
        for (let fiber = Reflect.get(stage, key) as Fiber | undefined; fiber; fiber = fiber.return) for (let hook = fiber.memoizedState; hook; hook = hook.next) { const candidate = hook.memoizedState?.current; if (typeof candidate?.engine?.getSnapshot === 'function') runtime = candidate; }
        for (let frame = 0; runtime && frame < 60; frame++) { const parameters = runtime.engine.getSnapshot().live2dParams; if ((parameters.ParamEyeLOpen ?? 1) > .85 && (parameters.ParamEyeROpen ?? 1) > .85) break; await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); }
      });
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const bytes = Buffer.from(png, 'base64'); await writeFile(testInfo.outputPath(name), bytes); await writeFile(path.join(evidence, name), bytes);
    };
    const within = async (element: Locator, container: Locator) => {
      const box = await element.boundingBox(), frame = await container.boundingBox(); expect(box).not.toBeNull(); expect(frame).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(frame!.x - 1); expect(box!.y).toBeGreaterThanOrEqual(frame!.y - 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 1); expect(box!.y + box!.height).toBeLessThanOrEqual(frame!.y + frame!.height + 1);
    };
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(theme => { localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme })); localStorage.setItem('worldlinebox.companion-call.speech.v1', 'off'); }, theme);
      await page.reload(); await page.locator('[data-application-module="companions"]').click(); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.evaluate(() => { const NativeAudio = window.Audio, sounds: HTMLAudioElement[] = []; Reflect.set(window, '__galgameSounds', sounds); window.Audio = class extends NativeAudio { constructor(src?: string) { super(src); sounds.push(this); } }; });
      await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
      const meeting = page.getByRole('dialog', { name: '与大肥鱼会面', exact: true }); await meeting.getByRole('button', { name: '接通', exact: true }).click();
      await expect(meeting.locator('.bot-call-loading')).toHaveCount(0, { timeout: 90000 }); await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible(); await expect(meeting.locator('.bot-call-model-error')).toHaveCount(0);
      await expect(meeting.locator('.bot-call-chat')).not.toBeVisible();
      const dialogue = meeting.locator('.bot-call-dialogue'); await expect(dialogue).toBeVisible(); await expect(dialogue).toContainText('我在这里。');
      await expect(dialogue).toHaveAttribute('data-call-dialogue-message', seeded.messageIds[1]!);
      await expect(meeting.locator('.bot-call-user-echo')).not.toBeVisible();
      const entry = meeting.getByRole('button', { name: '展开会面输入', exact: true }); await expect(entry).toBeVisible();
      await expect(meeting.locator('.bot-composer')).not.toBeVisible(); await expect(page.locator('.bot-composer:visible')).toHaveCount(0);
      await expect(meeting.locator('.bot-call-live-status')).toHaveCount(1);
      await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
      const metrics = await meeting.evaluate(window => {
        const rect = (element: Element) => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }; };
        const style = (selector: string) => { const element = window.querySelector(selector)!, css = getComputedStyle(element); return { selector, rect: rect(element), background: css.backgroundColor, image: css.backgroundImage, borders: [css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth].map(parseFloat), position: css.position }; };
        const scene = style('.bot-call-scene'), connected = style('.bot-call-connected');
        const transparent = ['.bot-call-chat', '.bot-call-chat>header', '.bot-call-header', '.bot-call-footer'].filter(selector => { const element = window.querySelector(selector); return element && element.getClientRects().length > 0; }).map(style);
        const dialogueSurfaces = ['.bot-call-dialogue', '.bot-call-dialogue .bot-message-bubble', '.bot-call-dialogue .bot-message-text'].map(selector => { const element = window.querySelector(selector)!, css = getComputedStyle(element); return { selector, background: css.backgroundColor, shadow: css.boxShadow }; });
        const character = window.querySelector('.bot-call-live2d')!, characterBox = character.getBoundingClientRect(), sample = { x: characterBox.x + characterBox.width * .5, y: characterBox.y + characterBox.height * .35 };
        const hit = document.elementFromPoint(sample.x, sample.y);
        return { window: rect(window), viewport: { width: innerWidth, height: innerHeight }, scene, connected, transparent, dialogueSurfaces, dialogueRect: rect(window.querySelector('.bot-call-dialogue')!), character: rect(character), characterSampleUnobscured: !!hit?.closest('.bot-call-live2d'), dockHeight: getComputedStyle(window).getPropertyValue('--bot-call-dock-height') };
      });
      expect(metrics.window.width).toBeGreaterThanOrEqual(metrics.viewport.width - 40); expect(metrics.window.height).toBeGreaterThanOrEqual(metrics.viewport.height - 40);
      for (const full of [metrics.scene, metrics.connected]) {
        expect(Math.abs(full.rect.x - metrics.window.x)).toBeLessThanOrEqual(2); expect(Math.abs(full.rect.y - metrics.window.y)).toBeLessThanOrEqual(2);
        expect(full.rect.width).toBeGreaterThanOrEqual(metrics.window.width - 4); expect(full.rect.height).toBeGreaterThanOrEqual(metrics.window.height - 4);
      }
      for (const layer of metrics.transparent) { expect(layer.background).toMatch(/^(?:transparent|rgba\([^)]*,\s*0\))$/u); expect(layer.image).toBe('none'); expect(layer.borders.every(width => width === 0)).toBe(true); }
      for (const layer of metrics.dialogueSurfaces) { expect(layer.background).toMatch(/^(?:transparent|rgba\([^)]*,\s*0\))$/u); expect(layer.shadow).toBe('none'); }
      expect(metrics.characterSampleUnobscured).toBe(true); expect(Math.abs(metrics.character.x + metrics.character.width / 2 - metrics.window.x - metrics.window.width / 2)).toBeLessThan(3);
      expect(metrics.character.width).toBeGreaterThanOrEqual(metrics.window.width - 4);
      await within(entry, meeting); await capture(`companion-call-galgame-${theme}.png`);
      await entry.click(); await expect(page.locator('.bot-composer')).toHaveCount(1); await expect(meeting.locator('.bot-composer')).toBeVisible();
      const composerStyle = await meeting.locator('.bot-call-composer-host').evaluate(element => { const css = getComputedStyle(element); return { background: css.backgroundColor, borders: [css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth], position: css.position }; });
      expect(composerStyle.background).toMatch(/^(?:transparent|rgba\([^)]*,\s*0\))$/u); expect(composerStyle.borders.every(width => width === '0px')).toBe(true); expect(composerStyle.position).toBe('absolute');
      for (const label of ['连续语音对话', '添加文件', '发送 ↑']) await within(meeting.getByRole('button', { name: label, exact: true }), meeting);
      const typed = meeting.getByRole('textbox', { name: '发送消息…', exact: true }); await typed.fill('就在这里，慢慢聊。');
      expect(await typed.evaluate(field => getComputedStyle(field).outlineWidth)).toBe('0px'); await within(typed, meeting);
      const collapse = meeting.getByRole('button', { name: '收起会面输入', exact: true });
      await expect(collapse.locator('svg.bot-icon')).toHaveCount(1); expect(await collapse.textContent()).not.toContain('⌄'); await within(collapse, meeting.locator('.bot-composer'));
      const anchors: unknown[] = [];
      const stableAnchor = async (label: string) => {
        const observed = await meeting.evaluate(window => {
          const rect = (element: Element) => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom }; };
          return { dialogue: rect(window.querySelector('.bot-call-dialogue')!), scene: rect(window.querySelector('.bot-call-scene')!) };
        });
        const dock = await meeting.locator('.bot-call-composer-host').count() ? await meeting.locator('.bot-call-composer-host').boundingBox() : null;
        if (dock) expect(observed.dialogue.bottom, `${theme}: caption clears ${label} composer`).toBeLessThanOrEqual(dock.y - 12);
        expect(observed.dialogue.y, `${theme}: caption clears window header`).toBeGreaterThanOrEqual(metrics.window.y + 66);
        for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(observed.scene[key] - metrics.scene.rect[key]), `${theme}: scene ${label} ${key}`).toBeLessThanOrEqual(1);
        anchors.push({ label, ...observed }); return observed;
      };
      await stableAnchor('expanded');
      await capture(`companion-call-galgame-input-${theme}.png`);
      const firstDockHeight = await meeting.evaluate(window => parseFloat(getComputedStyle(window).getPropertyValue('--bot-call-dock-height')));
      const multiline = '第一行：继续聊天。\n第二行：输入变高时。\n第三行：场景保持全景。\n第四行：台词保持原位。'; await typed.fill(multiline);
      await expect.poll(() => meeting.evaluate(window => parseFloat(getComputedStyle(window).getPropertyValue('--bot-call-dock-height')))).toBeGreaterThan(firstDockHeight);
      const expanded = await stableAnchor('four-lines');
      await typed.press('Escape'); await expect(entry).toBeVisible(); await expect(meeting.locator('.bot-composer')).not.toBeVisible(); await expect(meeting).toBeVisible();
      await stableAnchor('collapsed');
      await entry.click(); await expect(typed).toHaveValue(multiline); await typed.fill('就在这里，慢慢聊。');
      await meeting.getByRole('button', { name: '收起会面输入', exact: true }).click(); await expect(entry).toBeVisible(); await expect(meeting.locator('.bot-composer')).not.toBeVisible();
      const history = meeting.locator('.bot-call-history-toggle'); await expect(history).toHaveAttribute('aria-expanded', 'false'); await history.click(); await expect(history).toHaveAttribute('aria-expanded', 'true');
      await expect(meeting.locator('.bot-call-chat')).toBeVisible(); await expect(meeting.locator('.bot-call-transcript')).toContainText('陪我聊一会儿吧。'); await expect(meeting.locator('.bot-call-transcript')).toContainText('我在这里。');
      await within(meeting.locator('.bot-call-chat'), meeting);
      const historyStyle = await meeting.locator('.bot-call-chat').evaluate(element => { const css = getComputedStyle(element); return { background: css.backgroundColor, borderLeft: css.borderLeftWidth, image: css.backgroundImage, position: css.position }; });
      expect(historyStyle.image).toBe('none'); expect(historyStyle.position).toBe('absolute');
      const historyBounds = await meeting.locator('.bot-call-chat').boundingBox(); expect(historyBounds!.width).toBeLessThan(metrics.window.width * .5); expect(parseFloat(historyStyle.borderLeft)).toBeLessThanOrEqual(1);
      if (theme === 'light') await capture('companion-call-galgame-history.png');
      await history.click(); await expect(meeting.locator('.bot-call-chat')).not.toBeVisible(); await expect(dialogue).toBeVisible();
      await entry.click(); await expect(typed).toHaveValue('就在这里，慢慢聊。');
      await meeting.getByRole('button', { name: '表情', exact: true }).click();
      const picker = meeting.locator('.bot-expression-picker'); await expect(picker).toBeVisible(); await within(picker, meeting);
      await meeting.getByRole('button', { name: '🐳', exact: true }).press('Escape'); await expect(picker).toHaveCount(0); await expect(meeting).toBeVisible();
      const dictate = meeting.getByRole('button', { name: '语音转文字', exact: true }); await dictate.click();
      const input = meeting.getByRole('region', { name: '本地语音', exact: true }); await expect(input).toBeVisible(); await within(input, meeting); await dictate.press('Escape'); await expect(input).toHaveCount(0); await expect(meeting).toBeVisible();
      await typed.press('Escape'); await expect(entry).toBeVisible();
      checks.push({ theme, metrics, expandedComposer: expanded, anchors, svgCollapseInsideComposer: true, composerStyle, historyStyle, historyOnlyOnDemand: true, originalDialogueMessageIds: seeded.messageIds, popoversInsideWindow: true, nativeComposerFocus: true, collapsedInputDefaultAndDraftPreservedOnFold: true });
      if (theme === 'dark' && !captureOnly) {
        const reading = meeting.getByRole('button', { name: '自动朗读伙伴回复', exact: true }); await expect(reading).toBeVisible(); await reading.click();
        const firstText = '这是根据实际语音播放进度逐步出现的对话。声音暂停时文字也应该停留，播放结束后保留完整回复。';
        await app.evaluate(() => Reflect.set(globalThis, '__overlaySpeechDelay', 1600));
        const clockReply = await generating('overlay-audio-clock', '', 'running'); expect(clockReply.events).toBe(0);
        await expect(dialogue).toHaveAttribute('data-call-dialogue-message', clockReply.messageId);
        await expect(dialogue).toContainText('正在回应');
        for (const partial of [firstText.slice(0, 12), firstText.slice(0, 28), firstText]) {
          await app.evaluate(({ BrowserWindow }, input) => BrowserWindow.getAllWindows()[0]!.webContents.send('companion-bot:event', { type: 'text', conversationId: input.room, messageId: input.messageId, text: input.text }), { room, messageId: clockReply.messageId, text: partial });
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await expect(dialogue).toContainText('正在回应'); await expect(dialogue).not.toContainText(partial);
        }
        await generating('overlay-audio-clock', firstText, 'sent'); await expect(dialogue).toContainText('正在准备语音');
        await expect(dialogue).not.toContainText(firstText);
        const spoken = dialogue.locator('.bot-message-text');
        await expect.poll(async () => { const text = (await spoken.innerText()).trim(); return text.length > 0 && text.length < firstText.length; }).toBe(true);
        const mouth: number[] = [];
        await expect.poll(async () => {
          const value = await page.evaluate(() => {
            const stage = document.querySelector('.bot-call-live2d')!, key = Object.keys(stage).find(key => key.startsWith('__reactFiber'))!;
            for (let fiber = Reflect.get(stage, key) as Fiber | undefined; fiber; fiber = fiber.return) for (let hook = fiber.memoizedState; hook; hook = hook.next) { const candidate = hook.memoizedState?.current; if (typeof candidate?.engine?.getSnapshot === 'function') return candidate.engine.getSnapshot().live2dParams.ParamMouthOpenY ?? 0; }
            throw Error('Missing actual mouth runtime');
          }); mouth.push(value); return Math.max(...mouth);
        }).toBeGreaterThan(.08);
        await page.evaluate(async () => {
          const audio = (Reflect.get(window, '__galgameSounds') as HTMLAudioElement[]).findLast(audio => audio.src.startsWith('blob:') && !audio.paused); if (!audio) throw Error('No actual speech media element');
          Reflect.set(window, '__galgamePausedAudio', audio); audio.pause(); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        const pausedText = (await spoken.innerText()).trim(), pausedTime = await page.evaluate(() => (Reflect.get(window, '__galgamePausedAudio') as HTMLAudioElement).currentTime);
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
        expect((await spoken.innerText()).trim()).toBe(pausedText); expect(await page.evaluate(() => (Reflect.get(window, '__galgamePausedAudio') as HTMLAudioElement).currentTime)).toBeCloseTo(pausedTime, 3);
        await page.evaluate(async () => { await (Reflect.get(window, '__galgamePausedAudio') as HTMLAudioElement).play(); });
        await expect(spoken).toHaveText(firstText, { timeout: 15000 });
        await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__galgameSounds') as HTMLAudioElement[]).some(audio => audio.src.startsWith('blob:') && !audio.paused))).toBe(false);
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300))); await expect(spoken).toHaveText(firstText);
        await capture('companion-call-galgame-audio-complete.png');
        await app.evaluate(() => Reflect.set(globalThis, '__overlaySpeechDelay', 0));
        await reading.click();
        const longText = '我们可以把长回复按自然的语句分成短段，当前字幕只保留正在读的一小页。需要回顾时，再打开完整的聊天记录。'.repeat(24);
        const longReply = await incoming('overlay-long-paged-reply', longText); await expect(dialogue).toHaveAttribute('data-call-dialogue-message', longReply.messageId);
        const captionPage = dialogue.locator('.bot-call-caption-text'); await expect(dialogue.getByRole('button', { name: '查看完整回复', exact: true })).toBeVisible();
        const stability = await captionPage.evaluate(async element => {
          const frames: Array<{ width: number; pages: string | null }> = [];
          for (let index = 0; index < 24; index++) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            frames.push({ width: element.getBoundingClientRect().width, pages: element.getAttribute('data-caption-pages') });
          }
          return frames;
        });
        expect(Math.max(...stability.map(frame => frame.width)) - Math.min(...stability.map(frame => frame.width))).toBeLessThan(1);
        expect(new Set(stability.map(frame => frame.pages)).size).toBe(1);
        const stableWidth = await captionPage.evaluate(element => ({ own: element.getBoundingClientRect().width, parent: element.parentElement!.getBoundingClientRect().width }));
        expect(Math.abs(stableWidth.own - stableWidth.parent)).toBeLessThan(2);
        const pageMetrics = await captionPage.evaluate(element => ({ length: element.textContent?.length ?? 0, height: element.getBoundingClientRect().height, overflow: getComputedStyle(element).overflowY, text: element.textContent, page: Number(element.getAttribute('data-caption-page')), pages: element.getAttribute('data-caption-pages') }));
        expect(pageMetrics.length).toBeLessThan(180); expect(pageMetrics.height).toBeLessThan(155); expect(Number(pageMetrics.pages)).toBeGreaterThan(10);
        await dialogue.getByRole('button', { name: '上一段回应', exact: true }).click(); await expect(captionPage).toHaveAttribute('data-caption-page', String(pageMetrics.page - 1));
        await capture('companion-call-long-caption-page.png');
        await dialogue.getByRole('button', { name: '查看完整回复', exact: true }).click(); await expect(meeting.locator('.bot-call-transcript')).toContainText(longText);
        await capture('companion-call-long-caption-history.png');
        await meeting.getByRole('button', { name: '收起会面面板', exact: true }).click(); await expect(dialogue).toBeVisible();
        await reading.click();
        const queueText = '这句话正在播放时，后来排队的消息不能抢走当前台词。';
        const current = await incoming('overlay-current-spoken', queueText); await expect(dialogue).toHaveAttribute('data-call-dialogue-message', current.messageId);
        await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__galgameSounds') as HTMLAudioElement[]).some(audio => audio.src.startsWith('blob:') && !audio.paused))).toBe(true);
        const following = await incoming('overlay-following-spoken', '这是后来排队的下一句话。'); expect(following.events).toBe(0);
        await expect(meeting.locator(`[data-call-message="${following.messageId}"]`)).toHaveCount(1);
        await expect(dialogue).toHaveAttribute('data-call-dialogue-message', current.messageId);
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300))); await expect(dialogue).toHaveAttribute('data-call-dialogue-message', current.messageId);
        await meeting.locator('.bot-call-speech-controls').getByRole('button', { name: '停止朗读', exact: true }).click();
        const attemptsBeforeFailure = await app.evaluate(() => Number(Reflect.get(globalThis, '__overlaySpeechAttempts')));
        await app.evaluate(() => Reflect.set(globalThis, '__overlaySpeechFailure', true));
        const rejected = await incoming('overlay-controlled-speech-failure', '这条回复用于验收收起输入框时的朗读失败提示。'); expect(rejected.events).toBe(0);
        const failure = meeting.locator(`[data-speech-failure="${rejected.messageId}"]`); await expect(failure).toBeVisible(); await expect(meeting.locator('.bot-composer')).not.toBeVisible();
        const snapshot = async () => (await page.evaluate(async room => (Reflect.get(window, 'worldlinebox') as Bridge).companionBot.request({ type: 'state', conversationId: room }), room)).snapshot!;
        const beforeRetry = (await snapshot()).messages.map(message => message.id);
        await failure.getByRole('button', { name: '重试朗读', exact: true }).click();
        await expect.poll(() => app.evaluate(() => Number(Reflect.get(globalThis, '__overlaySpeechAttempts')))).toBe(attemptsBeforeFailure + 2);
        await expect(failure).toBeVisible(); await expect(meeting.locator('.bot-composer')).not.toBeVisible(); expect((await snapshot()).messages.map(message => message.id)).toEqual(beforeRetry);
        checks.push({ generationAndDelayedSynthesisDoNotExposeOrRepeatText: true, longReplyPages: pageMetrics, fullOriginalAvailableInHistory: true, actualMp3ClockControlsReveal: true, pausedMediaTime: pausedTime, pausedText, pauseMs: 350, completedTextPersists: true, queuedLatestDoesNotReplaceSpeakingMessage: true, measuredMouthPeak: Math.max(...mouth) });
        await capture('companion-call-galgame-retry.png');
      }
      await entry.click(); await expect(typed).toHaveValue('就在这里，慢慢聊。'); await typed.fill(''); await typed.press('Escape'); await expect(entry).toBeVisible();
      await meeting.getByRole('button', { name: '结束并关闭会面', exact: true }).click(); await expect(meeting).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: '发送消息…', exact: true })).toHaveValue('');
    }
    expect(errors).toEqual([]);
    await writeFile(path.join(evidence, captureOnly ? 'companion-call-galgame-capture-evidence.json' : 'companion-call-galgame-evidence.json'), JSON.stringify({ displayFixtureOnly: true, paidModelCalls: 0, microphoneOpened: false, presentationOnly: captureOnly, preservedExistingVoicePipeline: true, collapsedSpeechRetryVisibleWithoutOpeningEditorOrResendingChat: captureOnly ? undefined : true, remoteEdgeStreamOnlyFixture: 'Retained neutral MP3 for real media-clock/analyser acceptance; controlled rejection for error UI. No upstream Edge or language-model call; no word-alignment claim.', checks, errors }, null, 2));
  } finally { await app.close(); await removeProfile(profile); }
});

// eslint-disable-next-line no-empty-pattern -- The test owns its isolated hidden Electron window.
test('small meeting layouts keep static portraits, paged captions and the original expanded composer separate without layout oscillation', async ({}, testInfo) => {
  test.setTimeout(150000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-call-overlay-'));
  const fixtures = testInfo.outputPath('small-fixture'); await mkdir(fixtures, { recursive: true });
  await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-call-overlay-fixture.ts', target: 'node24', outDir: fixtures, emptyOutDir: false, rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'seed.cjs' } } } });
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  const evidence = path.resolve('artifacts/superagent-bot-development/ui'), checks: unknown[] = [], errors: string[] = [];
  await mkdir(evidence, { recursive: true });
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ app, BrowserWindow }, owned) => {
      if (app.getPath('userData') !== owned) throw Error('Small meeting acceptance requires an owned profile');
      for (const window of BrowserWindow.getAllWindows()) { window.on('show', () => window.hide()); window.hide(); window.webContents.setAudioMuted(true); window.webContents.setBackgroundThrottling(false); window.setMinimumSize(0, 0); window.setContentSize(1040, 680); }
    }, profile);
    await page.locator('[data-application-module="companions"]').click();
    const rooms = await page.evaluate(async () => {
      const api = (Reflect.get(window, 'worldlinebox') as Bridge).companionBot;
      const name = '静态头像验收伙伴';
      const created = await api.request({ type: 'companion.create', name, persona: '仅用于本地布局验收，不执行任务。' }); if (!created.ok) throw Error('Could not create the static portrait fixture');
      const current = await api.request({ type: 'state' }), companion = current.snapshot!.companions.find(item => item.name === name)!;
      const opened = await api.request({ type: 'conversation.open', companionId: companion.id }); if (!opened.ok || !opened.conversationId) throw Error('Could not open the static portrait fixture');
      const conversations = (await api.request({ type: 'state' })).snapshot!.conversations;
      const live = { id: conversations.find(room => room.kind === 'direct' && room.memberIds.includes('builtin-dafeiyu'))!.id, companionId: 'builtin-dafeiyu', name: '大肥鱼', kind: 'live2d' };
      return [{ id: opened.conversationId, companionId: companion.id, name, kind: 'static' }, live, { ...live, kind: 'fallback' }];
    });
    for (const room of rooms) {
      const longText = '这一段字幕需要在有限的窗口中自然分段。当前页面显示短句，完整内容随时可以从聊天记录查看。'.repeat(28);
      await app.evaluate(({ app }, input) => {
        const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
        const fixture = require(input.fixture) as { seedCallOverlay(profile: string, room: string, companionId: string): unknown; appendCallOverlayReply(profile: string, room: string, key: string, text: string, companionId: string): unknown };
        fixture.seedCallOverlay(input.profile, input.room.id, input.room.companionId);
        fixture.appendCallOverlayReply(input.profile, input.room.id, `small-${input.room.kind}`, input.longText, input.room.companionId);
      }, { fixture: path.join(fixtures, 'seed.cjs'), profile, room, longText });
      await page.evaluate(() => localStorage.setItem('worldlinebox.companion-call.speech.v1', 'off'));
      await page.reload(); await page.locator('[data-application-module="companions"]').click();
      if (room.kind === 'fallback') await page.evaluate(() => {
        const fetch = window.fetch.bind(window);
        window.fetch = (input, options) => String(input).includes('/companion-call/deepseek/catalog.json') ? Promise.resolve(new Response('', { status: 404 })) : fetch(input, options);
      });
      await page.locator('.bot-sidebar .bot-conversation').filter({ has: page.getByText(room.name, { exact: true }) }).click();
      await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
      const meeting = page.getByRole('dialog', { name: `与${room.name}会面`, exact: true }); await meeting.getByRole('button', { name: '接通', exact: true }).click();
      if (room.kind === 'live2d') { await expect(meeting.locator('.bot-call-loading')).toHaveCount(0, { timeout: 90000 }); await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible(); }
      else await expect(meeting.locator('.bot-call-portrait')).toBeVisible();
      if (room.kind === 'fallback') await expect(meeting.locator('.bot-call-composer-status .bot-call-model-error')).toContainText('可以继续打字聊天');
      const entry = meeting.getByRole('button', { name: '展开会面输入', exact: true });
      for (const size of [{ width: 1040, height: 680 }, { width: 850, height: 620 }, { width: 680, height: 520 }]) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), size);
        for (const expanded of [false, true]) {
          if (expanded) { await entry.click(); await meeting.getByRole('textbox', { name: '发送消息…', exact: true }).fill('第一行：保留原输入框。\n第二行：继续编辑。\n第三行：字幕在上方。\n第四行：头像与字幕不重叠。'); }
          await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
          const frames = await meeting.evaluate(async shell => {
            const rect = (selector: string) => { const element = shell.querySelector<HTMLElement>(selector); if (!element || !element.getClientRects().length) return null; const bounds = element.getBoundingClientRect(); return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }; };
            const result = [];
            for (let frame = 0; frame < 28; frame++) {
              await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
              const caption = shell.querySelector<HTMLElement>('.bot-call-caption-text')!;
              result.push({ shell: shell.getBoundingClientRect().toJSON(), header: rect('.bot-call-header'), portrait: rect('.bot-call-portrait'), avatar: rect('.bot-call-portrait>.bot-avatar'), name: rect('.bot-call-portrait h2'), description: rect('.bot-call-portrait p'), dialogue: rect('.bot-call-dialogue')!, dock: rect('.bot-call-composer-host'), entry: rect('.bot-call-input-row'), status: rect('.bot-call-live-status'), modelError: rect('.bot-call-model-error'), caption: rect('.bot-call-caption-text')!, captionScrollHeight: caption.scrollHeight, pages: caption.dataset.captionPages, text: caption.textContent });
            }
            return result;
          });
          const stable = frames.at(-1)!;
          expect(new Set(frames.map(frame => frame.pages)).size).toBe(1); expect(new Set(frames.map(frame => frame.text)).size).toBe(1);
          for (const part of ['dialogue', 'caption'] as const) for (const dimension of ['x', 'y', 'width', 'height'] as const) expect(Math.max(...frames.map(frame => frame[part][dimension])) - Math.min(...frames.map(frame => frame[part][dimension])), `${room.kind} ${size.width} ${expanded} ${part} ${dimension} oscillates`).toBeLessThan(1);
          expect(stable.dialogue.y).toBeGreaterThanOrEqual(stable.header!.bottom + 8);
          expect(stable.captionScrollHeight).toBeLessThanOrEqual(stable.caption.height + 1);
          expect(stable.dialogue.bottom).toBeLessThanOrEqual((stable.dock ?? stable.entry)!.y - 12);
          if (stable.modelError) expect(stable.dialogue.bottom).toBeLessThanOrEqual((stable.dock ?? stable.status)!.y - 12);
          if (stable.portrait && stable.portrait.height > 0) {
            expect(stable.portrait.bottom).toBeLessThanOrEqual(stable.dialogue.y - 8);
            for (const part of [stable.avatar, stable.name, stable.description].filter(Boolean)) { expect(part!.y).toBeGreaterThanOrEqual(stable.portrait.y - 1); expect(part!.bottom).toBeLessThanOrEqual(stable.portrait.bottom + 1); }
          }
          const name = `companion-call-${room.kind}-${size.width}x${size.height}-${expanded ? 'expanded' : 'collapsed'}.png`;
          const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
          await writeFile(path.join(evidence, name), Buffer.from(png, 'base64')); checks.push({ kind: room.kind, size, expanded, stable, stableFrames: frames.length, screenshot: name });
          if (expanded) await meeting.getByRole('button', { name: '收起会面输入', exact: true }).click();
        }
      }
      await meeting.getByRole('button', { name: '结束并关闭会面', exact: true }).click();
      await page.getByRole('textbox', { name: '发送消息…', exact: true }).fill('');
    }
    expect(errors).toEqual([]);
    await writeFile(path.join(evidence, 'companion-call-small-layout-evidence.json'), JSON.stringify({ displayFixtureOnly: true, paidModelCalls: 0, microphoneOpened: false, checks, errors }, null, 2));
  } finally { await app.close(); await removeProfile(profile); }
});
