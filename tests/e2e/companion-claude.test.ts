import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Locator } from '@playwright/test';
import { builtinBotCompanion } from '../../src/shared/builtin-bot-companions';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { electronLaunchEnv, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Electron owns the application page.
test('seeds Claude with a distinct character card, authored persona and working local character art', async ({}, testInfo) => {
  test.setTimeout(150000);
  testInfo.annotations.push({ type: 'isolated-claude-character-card', description: 'Real Electron renderer, Main IPC, SQLite seeding and bundled image loading. No model, login or DSH session is used.' });
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-claude-ui-'));
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  const evidence = path.resolve('artifacts/companion-claude'); await mkdir(evidence, { recursive: true });
  try {
    const page = await application.firstWindow();
    // Wait for Main's startup loadURL handoff before the first renderer reload.
    await expect(page.locator('[data-application-module="companions"]')).toBeVisible();
    const identity = await application.evaluate(({ app, BrowserWindow }, expected) => {
      if (app.getPath('userData') !== expected) throw Error('Claude acceptance must not use a production profile.');
      const window = BrowserWindow.getAllWindows()[0]!;
      if (!window.webContents.isOffscreen()) throw Error('Claude acceptance must render offscreen.');
      window.on('show', () => window.hide()); window.hide(); window.setMinimumSize(0, 0); window.setSize(1440, 960); window.webContents.setBackgroundThrottling(false);
      const frames = { paints: 0 }; Reflect.set(globalThis, '__claudeUiFrames', frames); window.webContents.on('paint', () => { frames.paints++; });
      return { appPath: app.getAppPath(), packaged: app.isPackaged, profile: app.getPath('userData'), offscreen: window.webContents.isOffscreen() };
    }, profile);
    const builtin = builtinBotCompanion('claude');
    expect(builtin).toBeDefined();
    const state = () => page.evaluate(() => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state' }));
    const dshState = () => page.evaluate(() => (Reflect.get(window, 'worldlinebox') as { dshLauncher: WorldlineBoxDshLauncherApi }).dshLauncher.request({ type: 'state' }));
    const initial = await state(), dshBefore = await dshState();
    expect(initial.ok).toBe(true); expect(dshBefore.ok).toBe(true);
    const claude = initial.snapshot?.companions.filter(person => person.id === 'claude');
    expect(claude).toHaveLength(1); expect(claude?.[0]).toMatchObject({ name: 'Claude', persona: builtin!.persona, workerConcurrency: 5 });
    expect(initial.snapshot?.companions.find(person => person.id === 'builtin-dafeiyu')?.persona).toContain('Claude 很要好');
    const template = await page.evaluate(() => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'companion.personas.get', companionId: 'claude', id: 'default' }));
    expect(template.ok).toBe(true); expect(template.persona?.prompt).toBe(builtin!.persona);
    for (const phrase of ['橙色长发', '洛丽塔少女', '你和大肥鱼很要好', '平时像坐在书桌另一边的朋友', '日常通常一两句', '语气参考']) expect(template.persona?.prompt).toContain(phrase);

    const openClaude = async () => {
      await page.locator('[data-application-module="companions"]').click();
      await page.getByRole('tab', { name: /^联系人/u }).click();
      await page.getByRole('textbox', { name: '搜索', exact: true }).fill('Claude');
      const contact = page.locator('.bot-contact').filter({ has: page.locator('strong', { hasText: /^Claude$/u }) });
      await expect(contact).toHaveCount(1); await expect(contact).toContainText('与大肥鱼是很要好的朋友');
      await contact.click(); await expect(page.locator('.bot-chat-header h2')).toHaveText('Claude');
      const actions = page.locator('.bot-chat-header');
      await expect(actions.getByRole('button', { name: '拨打伙伴电话', exact: true })).toBeVisible();
      await expect(actions.getByRole('button', { name: '任务', exact: true })).toBeVisible();
      await expect(actions.getByRole('button', { name: '角色卡', exact: true })).toBeVisible();
      await expect(actions.getByRole('button', { name: '能力', exact: true })).toHaveCount(0);
      await actions.getByRole('button', { name: '角色卡', exact: true }).click();
      const card = page.getByRole('dialog', { name: '角色卡 · Claude', exact: true }); await expect(card).toBeVisible();
      await expect(card.getByRole('textbox', { name: '人格与相处方式', exact: true })).toHaveValue(builtin!.persona);
      return card;
    };
    const imageProof = async (image: Locator, expectedPath: string) => {
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
      const proof = await image.evaluate((element: HTMLImageElement) => ({ src: element.currentSrc, width: element.naturalWidth, height: element.naturalHeight }));
      expect(decodeURI(proof.src)).toContain(expectedPath); expect(proof.width).toBeGreaterThan(0); expect(proof.height).toBeGreaterThan(0);
      return proof;
    };
    const capture = async (filename: string) => {
      await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
      const previous = await application.evaluate(({ BrowserWindow }) => { const paints = (Reflect.get(globalThis, '__claudeUiFrames') as { paints: number }).paints; BrowserWindow.getAllWindows()[0]!.webContents.invalidate(); return paints; });
      await expect.poll(() => application.evaluate(() => (Reflect.get(globalThis, '__claudeUiFrames') as { paints: number }).paints)).toBeGreaterThan(previous);
      const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const file = testInfo.outputPath(filename); await writeFile(file, Buffer.from(png, 'base64')); await copyFile(file, path.join(evidence, filename)); await testInfo.attach(filename, { path: file, contentType: 'image/png' });
    };
    const layouts: unknown[] = [], images: unknown[] = [];
    for (const [theme, width, height] of [['light', 1440, 960], ['dark', 1440, 960], ['dark', 850, 720]] as const) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height), { width, height });
      await page.evaluate(theme => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme })), theme);
      await page.reload(); const card = await openClaude(); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      images.push({ theme, viewportWidth: width, label: '角色头像', ...await imageProof(card.locator('.bot-editor-header img'), builtin!.portrait.url) });
      if (theme === 'light') await capture('claude-persona-light-1440.png');
      await card.locator('.bot-editor-tabs').getByRole('button', { name: '基本资料', exact: true }).click();
      await card.locator('.bot-character-reference summary').click(); await expect(card.locator('.bot-character-reference')).toHaveAttribute('open', '');
      expect(builtin!.referenceImages?.map(reference => reference.label)).toEqual(['形象三视图', '全身立绘', '原始形象设定']);
      for (const reference of builtin!.referenceImages!) images.push({ theme, viewportWidth: width, label: reference.label, ...await imageProof(card.getByRole('img', { name: `Claude · ${reference.label}`, exact: true }), reference.url) });
      const reference = card.getByRole('img', { name: 'Claude · 形象三视图', exact: true }); await reference.scrollIntoViewIfNeeded();
      const layout = await card.evaluate(element => {
        const panel = element.querySelector<HTMLElement>('.bot-editor-basics:not([hidden])')!, reference = panel.querySelector<HTMLImageElement>('.bot-character-reference img')!;
        const bounds = element.getBoundingClientRect(), content = panel.getBoundingClientRect(), image = reference.getBoundingClientRect();
        return { width: element.clientWidth, scrollWidth: element.scrollWidth, panelWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth, panelLeft: content.left, panelRight: content.right, cardRight: bounds.right, imageLeft: image.left, imageRight: image.right, imageWidth: image.width };
      });
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width); expect(layout.panelScrollWidth).toBeLessThanOrEqual(layout.panelWidth + 1);
      expect(layout.panelRight).toBeLessThanOrEqual(layout.cardRight + 1); expect(layout.imageLeft).toBeGreaterThanOrEqual(layout.panelLeft); expect(layout.imageRight).toBeLessThanOrEqual(layout.panelRight + 1); expect(layout.imageWidth).toBeGreaterThan(200);
      layouts.push({ theme, viewportWidth: width, ...layout });
      if (theme === 'dark') await capture(`claude-reference-dark-${width}.png`);
      await card.locator('.bot-editor-close').click();
    }
    const final = await state(), dshAfter = await dshState();
    expect(final.snapshot?.companions.find(person => person.id === 'claude')).toEqual(claude?.[0]);
    expect(final.snapshot?.messages.filter(message => message.senderId === 'user')).toHaveLength(0);
    expect(dshAfter.ok && dshAfter.state?.instances).toEqual(dshBefore.ok && dshBefore.state?.instances);
    await writeFile(path.join(evidence, 'claude-character-evidence.json'), JSON.stringify({ identity, actualMainIpc: true, actualSeededSqlite: true, characterId: 'claude', distinctPortrait: builtin!.portrait.url, referenceImages: images, layouts, defaultPersonaMatchedAuthoredSource: true, relationshipWithDafeiyu: true, headerEntries: ['拨号', '任务', '角色卡'], userMessagesSent: 0, dshInstancesUnchanged: true }, null, 2));
  } finally { await application.close(); removeCompanionTestDirectory(profile); }
});
