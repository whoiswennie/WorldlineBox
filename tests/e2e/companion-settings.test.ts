import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { electronLaunchEnv, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Electron owns the page.
test('unifies companion persona, profile, meeting preferences, concurrency and capabilities in one character settings card', async ({}, testInfo) => {
  test.setTimeout(180000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-companion-settings-'));
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  const evidence = path.resolve('artifacts/companion-settings'); await mkdir(evidence, { recursive: true });
  try {
    await preparePackagedCompanionLaunch(application, profile);
    const page = await application.firstWindow();
    const identity = await application.evaluate(({ app, BrowserWindow }, expected) => {
      if (app.getPath('userData') !== expected) throw Error('Companion settings must use the isolated profile.');
      const window = BrowserWindow.getAllWindows()[0]!;
      if (!window.webContents.isOffscreen()) throw Error('Companion settings screenshots must render offscreen.');
      window.on('show', () => window.hide()); window.hide(); window.setMinimumSize(0, 0); window.setSize(1440, 960); window.webContents.setBackgroundThrottling(false);
      const frames = { paints: 0 }; Reflect.set(globalThis, '__companionSettingsFrames', frames); window.webContents.on('paint', () => { frames.paints++; });
      return { appPath: app.getAppPath(), packaged: app.isPackaged, profile: app.getPath('userData') };
    }, profile);
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    const before = await page.evaluate(() => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state' }));
    expect(before.snapshot?.companions.find(person => person.id === 'builtin-dafeiyu')?.workerConcurrency).toBe(5);
    const otherBefore = before.snapshot?.companions.find(person => person.id === 'gpt');
    await page.getByRole('button', { name: '角色卡', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /角色卡 · 大肥鱼/u }), navigation = dialog.locator('.bot-editor-tabs');
    await expect(dialog).toBeVisible();
    const persona = dialog.getByRole('textbox', { name: '人格与相处方式', exact: true });
    await expect(persona).not.toHaveValue('');
    const originalPersona = await persona.inputValue(), draft = originalPersona + '\n设置切区验收：保留未保存的这行草稿。';
    await persona.fill(draft); await navigation.getByRole('button', { name: '基本资料', exact: true }).click();
    await dialog.locator('input[name=name]').fill('大肥鱼 · 星海');
    await navigation.getByRole('button', { name: '任务执行', exact: true }).click();
    await expect(dialog.getByRole('spinbutton', { name: '同时执行的任务数' })).toHaveValue('5');
    await dialog.getByRole('spinbutton', { name: '同时执行的任务数' }).fill('8');
    await navigation.getByRole('button', { name: '人格提示词', exact: true }).click(); await expect(persona).toHaveValue(draft);
    await navigation.getByRole('button', { name: '任务执行', exact: true }).click(); await dialog.locator('.bot-editor-execution').getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog.locator('.bot-editor-execution [role=status]')).toHaveText('资料与任务设置已保存。');
    await navigation.getByRole('button', { name: '人格提示词', exact: true }).click(); await expect(persona).toHaveValue(draft);
    const saved = await page.evaluate(() => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state' }));
    expect(saved.snapshot?.companions.find(person => person.id === 'builtin-dafeiyu')).toMatchObject({ name: '大肥鱼 · 星海', workerConcurrency: 8, persona: originalPersona });
    expect(saved.snapshot?.companions.find(person => person.id === 'gpt')).toEqual(otherBefore);
    await navigation.getByRole('button', { name: '形象与声音', exact: true }).click();
    await dialog.getByRole('checkbox', { name: '自动朗读伙伴回复' }).uncheck();
    await dialog.getByRole('checkbox', { name: '视线跟随鼠标' }).uncheck();
    await dialog.getByRole('button', { name: '进入会面', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('dialog', { name: '与大肥鱼 · 星海会面', exact: true }).getByRole('button', { name: '结束并关闭会面' }).click();
    await expect(dialog).toBeVisible(); await expect(navigation.getByRole('button', { name: '形象与声音' })).toHaveAttribute('aria-pressed', 'true');
    await navigation.getByRole('button', { name: '人格提示词' }).click(); await expect(persona).toHaveValue(draft);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.locator('.bot-chat-header').getByRole('button', { name: '能力', exact: true })).toHaveCount(0);
    await expect(page.locator('.bot-chat-header').getByRole('button', { name: '拨打伙伴电话', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '角色卡', exact: true }).click();
    await expect(dialog).toBeVisible(); await navigation.getByRole('button', { name: '能力档案', exact: true }).click();
    await expect(navigation.getByRole('button', { name: '能力档案' })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.locator('[data-companion-capabilities]')).toHaveAttribute('data-companion-capabilities', 'builtin-dafeiyu');
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await navigation.getByRole('button', { name: '任务执行' }).click(); await expect(dialog.getByRole('spinbutton', { name: '同时执行的任务数' })).toHaveValue('8');
    await navigation.getByRole('button', { name: '形象与声音' }).click(); await expect(dialog.getByRole('checkbox', { name: '自动朗读伙伴回复' })).not.toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: '视线跟随鼠标' })).not.toBeChecked();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const capture = async (filename: string) => {
      await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
      const previous = await application.evaluate(({ BrowserWindow }) => { const paints = (Reflect.get(globalThis, '__companionSettingsFrames') as { paints: number }).paints; BrowserWindow.getAllWindows()[0]!.webContents.invalidate(); return paints; });
      await expect.poll(() => application.evaluate(() => (Reflect.get(globalThis, '__companionSettingsFrames') as { paints: number }).paints)).toBeGreaterThan(previous);
      const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const file = testInfo.outputPath(filename); await writeFile(file, Buffer.from(png, 'base64')); await copyFile(file, path.join(evidence, filename));
      await testInfo.attach(filename, { path: file, contentType: 'image/png' });
    };
    const layouts: unknown[] = [];
    for (const [theme, width, height] of [['light', 1440, 960], ['dark', 1440, 960], ['dark', 850, 720]] as const) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height), { width, height });
      await page.evaluate(theme => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme })), theme);
      await page.reload(); await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '角色卡', exact: true }).click();
      await expect(dialog).toBeVisible(); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect.poll(() => dialog.locator('.bot-settings-character-portrait img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      for (const [section, label] of [['persona', '人格提示词'], ['profile', '基本资料'], ['appearance', '形象与声音'], ['execution', '任务执行'], ['capabilities', '能力档案']] as const) {
        await navigation.getByRole('button', { name: label, exact: true }).click();
        if (section === 'capabilities') await expect(dialog.locator('.companion-capability-error, .companion-capability-onboarding').first()).toBeVisible();
        const layout = await dialog.evaluate(element => {
          const panel = element.querySelector<HTMLElement>('.bot-editor-tabpanel:not([hidden]),.bot-editor-basics:not([hidden])')!, sidebar = element.querySelector<HTMLElement>('.bot-settings-navigation')!;
          const rect = element.getBoundingClientRect(), content = panel.getBoundingClientRect(), navigation = sidebar.getBoundingClientRect();
          return { width: element.clientWidth, scrollWidth: element.scrollWidth, panelWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth,
            panelRight: content.right, right: rect.right, navigationRight: navigation.right, contentLeft: content.left, bottom: rect.bottom, panelBottom: content.bottom };
        });
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width); expect(layout.panelScrollWidth).toBeLessThanOrEqual(layout.panelWidth + 1);
        expect(layout.panelRight).toBeLessThanOrEqual(layout.right); expect(layout.navigationRight).toBeLessThanOrEqual(layout.contentLeft + 1); expect(layout.panelBottom).toBeLessThanOrEqual(layout.bottom + 1);
        layouts.push({ theme, viewportWidth: width, section, ...layout }); await capture(`companion-settings-${section}-${theme}${width < 1000 ? '-narrow' : ''}.png`);
      }
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    }
    await writeFile(path.join(evidence, 'companion-settings-evidence.json'), JSON.stringify({ identity, layouts, actualMainIpc: true, profileAndConcurrencyPersisted: true, keptPersonaDraftAcrossSectionsAndMeeting: true, scopedLocalMeetingPreferences: true, oneSettingsShell: true, paidRequests: 0 }, null, 2));
  } finally { await application.close(); removeCompanionTestDirectory(profile); }
});
