import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

const phase = process.env.WORLDLINEBOX_BOT_EDITOR_AUDIT_PHASE ?? 'after';
if (!['before', 'after'].includes(phase)) throw Error('Editor audit phase must be before or after.');
const evidence = path.resolve('artifacts/superagent-bot-development/ui');
const longPersona = '认真表达，保留自己的边界与真实经历。\n'.repeat(1500).slice(0, 23960);

async function contrast(page: Page, selector = '.bot-modal .bot-editor-primary:visible') {
  return page.locator(selector).evaluate(button => {
    const context = document.createElement('canvas').getContext('2d')!;
    const rgba = (value: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
    const style = getComputedStyle(button), canvas = rgba(getComputedStyle(button.closest('.bot-modal,.bot-memory-workspace,.bot-composer')!).backgroundColor), background = rgba(style.backgroundColor), foreground = rgba(style.color);
    const blend = (front: number[], back: number[]) => front.slice(0, 3).map((value, index) => value * front[3]! / 255 + back[index]! * (1 - front[3]! / 255));
    const bg = blend(background, canvas), fg = blend(foreground, [...bg, 255]);
    const luminance = (rgb: number[]) => rgb.reduce((sum, value, index) => { const v = value / 255; return sum + (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]!; }, 0);
    const a = luminance(fg), b = luminance(bg);
    return { contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), color: style.color, background: style.backgroundColor, opacity: style.opacity,
      width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height };
  });
}
async function sample(page: Page, selector: string, backdropSelector: string, blur: boolean, initial: string, scrollSelector?: string) {
  return page.evaluate(async ({ selector, backdropSelector, blur, initial, scrollSelector }) => {
    const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!, backdrop = document.querySelector<HTMLElement>(backdropSelector)!;
    const scrolling = scrollSelector ? document.querySelector<HTMLElement>(scrollSelector)! : field;
    const previous = backdrop.style.backdropFilter;
    const siblings = [...document.querySelectorAll<HTMLElement>('.bot-workspace>.bot-sidebar,.bot-workspace>.bot-main')];
    const previousFilters = siblings.map(item => item.style.filter);
    if (!blur) backdrop.style.backdropFilter = 'none';
    if (!blur) siblings.forEach(item => { item.style.filter = 'none'; });
    const frame = () => new Promise<number>((resolve, reject) => { const timer = setTimeout(() => reject(Error('Hidden renderer animation frame did not progress')), 5000); requestAnimationFrame(value => { clearTimeout(timer); resolve(value); }); });
    const set = Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!;
    set.call(field, initial); field.dispatchEvent(new Event('input', { bubbles: true })); await frame(); await frame();
    let dateFormats = 0;
    const original = Date.prototype.toLocaleTimeString;
    Date.prototype.toLocaleTimeString = function (this: Date, ...args: Parameters<Date['toLocaleTimeString']>) { dateFormats++; return original.apply(this, args); };
    const dispatch: number[] = [], inputFrames: number[] = [], scrollFrames: number[] = [];
    try {
      for (let i = 0; i < 12; i++) {
        const started = performance.now(); set.call(field, initial + '新的约定'.slice(0, i % 4 + 1)); field.dispatchEvent(new Event('input', { bubbles: true }));
        dispatch.push(performance.now() - started); await frame(); inputFrames.push(performance.now() - started);
      }
      const formats = dateFormats;
      for (let i = 0; i < 24; i++) { const started = performance.now(); scrolling.scrollTop = i % 2 ? 0 : scrolling.scrollHeight; await frame(); scrollFrames.push(performance.now() - started); }
      const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { p50Ms: sorted[Math.floor(sorted.length * .5)]!, p95Ms: sorted[Math.floor(sorted.length * .95)]!, maxMs: sorted.at(-1)!, samples: values.length }; };
      return { blur, computedBackdrop: getComputedStyle(backdrop).backdropFilter, backgroundFilters: siblings.map(item => getComputedStyle(item).filter), inputLength: initial.length, transcriptRows: document.querySelectorAll('[data-bot-message]').length,
        dateFormats: formats, dispatch: stats(dispatch), inputFrames: stats(inputFrames), scrollFrames: stats(scrollFrames), scrollable: scrolling.scrollHeight > scrolling.clientHeight,
        fieldSelector: selector, scrollSelector: scrollSelector ?? selector };
    } finally { Date.prototype.toLocaleTimeString = original; backdrop.style.backdropFilter = previous; siblings.forEach((item, index) => { item.style.filter = previousFilters[index]!; }); }
  }, { selector, backdropSelector, blur, initial, scrollSelector });
}

for (const renderer of ['software', 'hardware'] as const) {
  // eslint-disable-next-line no-empty-pattern -- Electron supplies its own page.
  test(`companion editor contrast and long-input rendering (${renderer})`, async ({}, testInfo) => {
    test.setTimeout(90000);
    const profile = await mkdtemp(path.join(tmpdir(), 'wlb-bot-editor-ui-'));
    if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-bot-editor-ui-')) throw Error('Unexpected editor fixture root');
    const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ ...process.env,
      WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_ENABLE_HARDWARE_GPU: renderer === 'hardware' ? '1' : '0', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
    const measurements: Record<string, unknown> = { phase, rendererRequested: renderer, fixture: '400 human-authored messages; no model/DSH; hidden offscreen=true isolated window with background throttling disabled; identical before/after paint path', samples: [], contrasts: [] };
    try {
      const page = await application.firstWindow();
      measurements.gpu = await application.evaluate(async ({ app, BrowserWindow }, expected) => {
        const path = process.getBuiltinModule('node:path'); if (path.resolve(app.getPath('userData')) !== path.resolve(expected)) throw Error('Only hide the owned performance profile');
        for (const owned of BrowserWindow.getAllWindows()) {
          owned.on('show', () => owned.hide()); owned.webContents.setBackgroundThrottling(false); owned.hide();
          const counters = { paints: 0 }; Reflect.set(globalThis, '__editorPaints', counters); owned.webContents.on('paint', () => { counters.paints++; });
        }
        const window = BrowserWindow.getAllWindows()[0]!; window.setContentSize(1440, 902);
        return { featureStatus: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic').catch(() => null),
          application: { packaged: app.isPackaged, version: app.getVersion(), path: app.getAppPath() },
          switches: { hardwareFlag: process.env.WORLDLINEBOX_E2E_ENABLE_HARDWARE_GPU, disableGpu: app.commandLine.hasSwitch('disable-gpu') } };
      }, profile);
      await page.locator('[data-application-module="companions"]').evaluate(element => (element as HTMLElement).click());
      await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
      const keepHidden = () => application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.webContents.setBackgroundThrottling(false); window.hide(); } });
      await keepHidden();
      if (phase === 'after') {
        await expect.poll(() => page.locator('html').getAttribute('data-ui-effects')).toMatch(/^(full|reduced)$/);
        measurements.effects = await page.locator('html').getAttribute('data-ui-effects');
        if (renderer === 'software') {
          expect(measurements.effects).toBe('reduced');
          const controls = await page.evaluate(() => {
            const probe = document.createElement('div'); probe.style.backdropFilter = 'blur(12px)'; probe.style.filter = 'grayscale(1)'; document.body.append(probe);
            const style = getComputedStyle(probe), result = { backdrop: style.backdropFilter, artisticFilter: style.filter,
              standardSupported: CSS.supports('backdrop-filter', 'blur(1px)'), webkitSupported: CSS.supports('-webkit-backdrop-filter', 'blur(1px)') }; probe.remove(); return result;
          });
          expect(controls.backdrop).toBe('none'); expect(controls.artisticFilter).toBe('grayscale(1)'); measurements.reducedGlobalProbe = controls;
        }
      }
      const conversationId = await page.evaluate(async () => {
        const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
        return (await api.request({ type: 'state' })).snapshot!.conversations[0]!.id;
      });
      await application.evaluate(({ app }, { profile, conversationId }) => {
        const path = process.getBuiltinModule('node:path'), { createRequire } = process.getBuiltinModule('node:module');
        if (path.resolve(app.getPath('userData')) !== path.resolve(profile)) throw Error('Editor test must not use the real profile');
        const Database = createRequire(path.join(app.getAppPath(), 'package.json'))('better-sqlite3') as { new(filename: string): { prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void } };
        const db = new Database(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
        try {
          const insert = db.prepare("INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at) VALUES(?,?,?,?,?,? ,?,'sent','message',?,?)");
          for (let i = 0; i < 400; i++) insert.run(`editor-fixture-${i}`, `editor-event-${i}`, conversationId, 'builtin-dafeiyu', '大肥鱼', 'companion', `第${i + 1}条隔离测试聊天。` + '保留有来源的交流与清楚的相处边界。'.repeat(5), 'editor-fixture', '2026-11-03T00:00:00Z');
        } finally { db.close(); }
      }, { profile, conversationId });
      await page.reload(); await page.locator('[data-application-module="companions"]').evaluate(element => (element as HTMLElement).click());
      await keepHidden();
      for (let i = 0; i < 4; i++) { await page.getByRole('button', { name: '查看更早消息', exact: true }).evaluate(element => (element as HTMLElement).click()); await expect(page.locator('[data-bot-message]')).toHaveCount((i + 2) * 80); }
      measurements.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, physicalWidth: innerWidth * devicePixelRatio, physicalHeight: innerHeight * devicePixelRatio, visibility: document.visibilityState }));
      measurements.webgl = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl'); if (!gl) return { available: false };
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        return { available: true, vendor: debug && gl.getParameter(debug.UNMASKED_VENDOR_WEBGL), renderer: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) };
      });
      await mkdir(evidence, { recursive: true });
      for (const blur of [true, false]) {
        await page.getByRole('button', { name: '角色卡', exact: true }).evaluate(element => (element as HTMLElement).click());
        (measurements.samples as unknown[]).push({ surface: 'persona', ...await sample(page, '.bot-modal textarea', '.bot-modal-backdrop', blur, longPersona) });
        await page.getByRole('dialog', { name: '角色卡' }).locator('.bot-editor-close').evaluate(element => (element as HTMLElement).click());
      }
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme })), theme);
        await page.reload(); await page.locator('[data-application-module="companions"]').evaluate(element => (element as HTMLElement).click());
        await keepHidden();
        for (let i = 0; i < 4; i++) { await page.getByRole('button', { name: '查看更早消息', exact: true }).evaluate(element => (element as HTMLElement).click()); await expect(page.locator('[data-bot-message]')).toHaveCount((i + 2) * 80); }
        await page.getByRole('button', { name: '角色卡', exact: true }).evaluate(element => (element as HTMLElement).click());
        const dialog = page.getByRole('dialog', { name: '角色卡' }), save = dialog.getByRole('button', { name: '保存修改', exact: true });
        await dialog.getByRole('textbox', { name: '人格与相处方式', exact: true }).fill('用于当前主题按钮对比验收的人格草稿。');
        for (const state of ['normal', 'hover', 'disabled']) {
          if (state === 'normal') await page.mouse.move(10, 10);
          if (state === 'hover') await save.hover();
          if (state === 'disabled') await dialog.getByRole('textbox', { name: '模板名称', exact: true }).fill('');
          await page.waitForTimeout(180);
          const check = await contrast(page); (measurements.contrasts as unknown[]).push({ kind: 'save', theme, state, ...check });
          if (phase === 'after') expect(check.contrast).toBeGreaterThanOrEqual(state === 'disabled' ? 3 : 4.5);
          if (renderer === 'software') {
            const screenshot = testInfo.outputPath(`editor-${phase}-${theme}-${state}.png`);
            const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
            await writeFile(screenshot, Buffer.from(png, 'base64'));
            await copyFile(screenshot, path.join(evidence, `editor-${phase}-${theme}-${state}.png`));
          }
        }
        await dialog.locator('.bot-editor-close').evaluate(element => (element as HTMLElement).click());
        await page.getByRole('button', { name: '新群聊', exact: true }).evaluate(element => (element as HTMLElement).click());
        const group = page.getByRole('dialog', { name: '新群聊' });
        await group.getByRole('textbox', { name: '聊天名称', exact: true }).fill('仅测试按钮对比的群聊草稿'); await group.getByRole('checkbox').first().evaluate(element => (element as HTMLInputElement).click());
        for (const state of ['normal', 'hover', 'disabled']) {
          if (state === 'normal') await page.mouse.move(10, 10);
          if (state === 'hover') await group.getByRole('button', { name: '创建', exact: true }).hover();
          if (state === 'disabled') await group.getByRole('textbox', { name: '聊天名称', exact: true }).fill('');
          await page.waitForTimeout(180); const check = await contrast(page); (measurements.contrasts as unknown[]).push({ kind: 'create', theme, state, ...check });
          if (phase === 'after') expect(check.contrast).toBeGreaterThanOrEqual(state === 'disabled' ? 3 : 4.5);
        }
        await group.getByRole('button', { name: '取消', exact: true }).evaluate(element => (element as HTMLElement).click());
        await page.getByRole('button', { name: '记忆', exact: true }).evaluate(element => (element as HTMLElement).click()); await page.getByRole('button', { name: '召回试查', exact: true }).evaluate(element => (element as HTMLElement).click());
        const query = page.getByRole('textbox', { name: '想回想什么？', exact: true }); await query.fill('只测本地输入与按钮，不提交查询');
        for (const state of ['normal', 'hover', 'disabled']) {
          if (state === 'normal') await page.mouse.move(10, 10);
          if (state === 'hover') await page.getByRole('button', { name: '开始试查', exact: true }).hover();
          if (state === 'disabled') await query.fill('');
          await page.waitForTimeout(180); const check = await contrast(page, '.bot-memory-recall-controls>button'); (measurements.contrasts as unknown[]).push({ kind: 'query', theme, state, ...check });
          if (phase === 'after') expect(check.contrast).toBeGreaterThanOrEqual(state === 'disabled' ? 3 : 4.5);
        }
        await page.getByRole('button', { name: '关闭记忆工作台', exact: true }).evaluate(element => (element as HTMLElement).click());
      }
      if (phase === 'after') {
        await page.locator('.bot-composer textarea').fill('只检查发送按钮，不发送'); await page.locator('.bot-compose-footer .bot-send').hover();
        const round = await page.locator('.bot-compose-footer .bot-send').evaluate(button => ({ radius: getComputedStyle(button).borderRadius, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height }));
        expect(round.radius).toBe('50%'); expect(round.width).toBe(round.height);
        const sendContrast = await contrast(page, '.bot-compose-footer .bot-send'); expect(sendContrast.contrast).toBeGreaterThanOrEqual(4.5); measurements.roundSendHover = { ...round, ...sendContrast };
        await page.locator('.bot-composer textarea').fill('');
        await page.getByRole('button', { name: '角色卡', exact: true }).evaluate(element => (element as HTMLElement).click());
        const dialog = page.getByRole('dialog', { name: '角色卡' }), full = '设'.repeat(23998) + '😀';
        await dialog.getByRole('textbox', { name: '人格与相处方式', exact: true }).fill(full);
        expect(await dialog.locator('textarea').evaluate(field => getComputedStyle(field).resize)).toBe('none');
        await dialog.getByRole('button', { name: '保存修改', exact: true }).evaluate(element => (element as HTMLElement).click());
        await expect(dialog.locator('.bot-personas__feedback')).toContainText('已保存并启用');
        const saved = await page.evaluate(async () => {
          const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
          return (await api.request({ type: 'state' })).snapshot!.companions.find(item => item.id === 'builtin-dafeiyu')!.persona;
        });
        expect(saved).toBe(full); measurements.completePersonaSave = { utf16Length: saved.length, originalEquality: saved === full };
        await dialog.locator('.bot-editor-close').evaluate(element => (element as HTMLElement).click());
      }
      await page.getByRole('button', { name: '记忆', exact: true }).evaluate(element => (element as HTMLElement).click());
      await page.getByRole('button', { name: '召回试查', exact: true }).evaluate(element => (element as HTMLElement).click());
      for (const blur of [true, false]) (measurements.samples as unknown[]).push({ surface: 'memory-recall-query', ...await sample(page, '.bot-memory-recall-query textarea', '.bot-memory-backdrop', blur, '过去讨论的具体事实与现在的决定。\n'.repeat(250).slice(0, 3960)) });
      const personaSamples = (measurements.samples as Array<{ surface: string; dateFormats: number }>).filter(item => item.surface === 'persona');
      for (const item of personaSamples) expect(item.dateFormats).toBe(phase === 'before' ? 4800 : 0);
      if (phase === 'after' && renderer === 'software') for (const item of measurements.samples as Array<{ computedBackdrop: string; backgroundFilters: string[] }>) {
        expect(item.computedBackdrop).toBe('none'); expect(item.backgroundFilters.every(value => value === 'none')).toBe(true);
      }
      await page.getByRole('button', { name: '关闭记忆工作台', exact: true }).evaluate(element => (element as HTMLElement).click());
      await page.getByRole('button', { name: '设置', exact: true }).evaluate(element => (element as HTMLElement).click());
      const settings = page.getByRole('dialog', { name: '通用设置', exact: true }); await expect(settings).toBeVisible();
      await settings.getByRole('tab', { name: '全局模型', exact: true }).evaluate(element => (element as HTMLElement).click());
      await expect(settings.locator('#ai-config-profile-name')).toBeVisible();
      const originalProfileName = await settings.locator('#ai-config-profile-name').inputValue();
      const settingsSamples = [];
      for (const blur of [true, false]) settingsSamples.push(await sample(page, '#ai-config-profile-name', '.app-settings-backdrop', blur, '仅限临时测试的配置名称草稿，不保存也不测试连接', '.app-settings-content'));
      await settings.locator('#ai-config-profile-name').fill(originalProfileName);
      for (const item of settingsSamples) { expect(item.scrollable).toBe(true); if (renderer === 'software' && phase === 'after') expect(item.computedBackdrop).toBe('none'); }
      const backdropState = () => page.locator('.app-settings-backdrop').evaluate(backdrop => {
        const style = getComputedStyle(backdrop); return { backdrop: style.backdropFilter, transition: style.transitionProperty, duration: style.transitionDuration, adjusting: backdrop.classList.contains('is-adjusting'), background: style.backgroundColor };
      });
      const normalBackdrop = await backdropState();
      if (phase === 'after') { expect(normalBackdrop.transition).not.toMatch(/backdrop-filter|\ball\b/); expect(normalBackdrop.transition).toBe('background-color'); }
      await settings.locator('#app-settings-tab-appearance').evaluate(element => (element as HTMLElement).click());
      const appearance = settings.locator('input[type="range"],input[type="color"],[role="slider"],[role="radio"],[role="switch"],.elevation-pad,.app-settings-theme-profile').first();
      await expect(appearance).toBeVisible(); await appearance.dispatchEvent('pointerdown', { pointerType: 'mouse', button: 0 });
      await expect(page.locator('.app-settings-backdrop')).toHaveClass(/is-adjusting/);
      const adjustingBackdrop = await backdropState();
      if (phase === 'after') { expect(adjustingBackdrop.transition).not.toMatch(/backdrop-filter|\ball\b/); expect(adjustingBackdrop.transition).toBe('background-color'); }
      await appearance.dispatchEvent('pointerup', { pointerType: 'mouse', button: 0 });
      await page.emulateMedia({ reducedMotion: 'reduce' }); const reducedMotionBackdrop = await backdropState();
      if (phase === 'after') expect(reducedMotionBackdrop.transition).toBe('none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      measurements.settings = { input: 'Global model profile-name draft only; never saved or connected', samples: settingsSamples,
        backdropStates: { normal: normalBackdrop, adjusting: adjustingBackdrop, reducedMotion: reducedMotionBackdrop } };
      await settings.getByRole('button', { name: '关闭', exact: true }).evaluate(element => (element as HTMLElement).click());
      measurements.nativeWindows = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), throttled: window.webContents.getBackgroundThrottling(), offscreen: window.webContents.isOffscreen(), paints: (Reflect.get(globalThis, '__editorPaints') as { paints: number }).paints })));
      expect((measurements.nativeWindows as Array<{ visible: boolean }>).every(window => !window.visible)).toBe(true);
      expect((measurements.nativeWindows as Array<{ paints: number; offscreen: boolean }>).every(window => window.offscreen && window.paints > 0)).toBe(true);
      measurements.status = 'passed';
    } catch (error) { measurements.status = 'failed'; measurements.failure = error instanceof Error ? error.message : String(error); throw error;
    } finally {
      await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, `editor-performance-${phase}-${renderer}.json`), JSON.stringify(measurements, null, 2) + '\n');
      await application.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
}
