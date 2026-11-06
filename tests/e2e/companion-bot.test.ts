import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';
import { BUILTIN_BOT_COMPANIONS } from '../../src/shared/builtin-bot-companions';

// eslint-disable-next-line no-empty-pattern -- Electron supplies its own window.
test('new companion UI uses the event runtime, preserves chats, and reports an unconfigured brain honestly', async ({}, testInfo) => {
  test.setTimeout(90000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-bot-ui-'));
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
    ...process.env, WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }) });
  try {
    const page = await application.firstWindow();
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-workspace')).toBeVisible();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    const initial = await page.evaluate(() => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state' }));
    expect(initial.snapshot?.companions).toHaveLength(BUILTIN_BOT_COMPANIONS.length);
    for (const retired of ['default-companion', 'deepseek-sister', 'deepseek-flash']) expect(initial.snapshot?.companions.map(item => item.id)).not.toContain(retired);
    await expect.poll(() => page.locator('.bot-chat-identity img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const chrome = await page.locator('.windows-window-controls').boundingBox();
    for (const control of await page.locator('.bot-chat-header nav button,.bot-chat-header nav select').all()) {
      const bounds = await control.boundingBox();
      expect(bounds!.y).toBeGreaterThanOrEqual(chrome!.y + chrome!.height + 12);
    }
    const evidence = path.resolve('artifacts/superagent-bot-development/ui'); await mkdir(evidence, { recursive: true });
    const capture = async (name: string) => {
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const image = testInfo.outputPath(name);
      const png = await application.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(item => !item.isDestroyed());
        if (!window) throw Error('Owned test window was closed before capture.');
        return (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64');
      });
      await writeFile(image, Buffer.from(png, 'base64')); await copyFile(image, path.join(evidence, name));
      await testInfo.attach(name, { path: image, contentType: 'image/png' });
    };
    await expect(page.getByLabel('形象模式', { exact: true })).toHaveCount(0);
    await capture('chat-empty-light.png');
    await page.getByRole('tab', { name: /联系人/ }).click();
    await capture('chat-contacts-light.png');
    await page.getByRole('tab', { name: '聊天', exact: true }).click();
    await page.getByRole('button', { name: '角色卡', exact: true }).click();
    const profileDialog = page.getByRole('dialog', { name: '角色卡' });
    await profileDialog.getByRole('button', { name: '基本资料', exact: true }).click();
    await profileDialog.getByText('形象设定', { exact: true }).click();
    await expect(profileDialog.locator('.bot-character-reference img')).toHaveCount(2);
    await expect(profileDialog.locator('.bot-character-reference img').first()).toBeVisible();
    await capture('builtin-reference-profile.png');
    await profileDialog.getByRole('button', { name: '关闭', exact: true }).first().click();
    const switchTheme = async (theme: 'light' | 'dark') => {
      await page.evaluate(next => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: next })), theme);
      await page.reload(); await page.locator('[data-application-module="companions"]').click();
      await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    };
    await switchTheme('dark');
    const darkPane = await page.locator('.bot-main').evaluate(element => getComputedStyle(element).backgroundColor);
    expect(darkPane).not.toBe('rgb(247, 247, 248)');
    await capture('chat-empty-dark.png');
    await switchTheme('light');
    await page.locator('.bot-composer textarea').fill('这是一次大肥鱼新主脑界面验收。');
    await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
    await expect(page.locator('.bot-message-text').filter({ hasText: '这是一次大肥鱼新主脑界面验收。' })).toBeVisible();
    await expect(page.getByText('请先在模型设置中配置主脑 API。', { exact: true })).toBeVisible();
    await capture('chat-messages-light.png');
    await page.getByRole('button', { name: '聊天记录', exact: true }).click();
    await page.getByRole('searchbox', { name: '搜索聊天记录' }).fill('大肥鱼新主脑');
    await expect(page.locator('.bot-history-record')).toHaveCount(1);
    await page.locator('.bot-history-locate').click();
    await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '回到最新', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '聊天记录', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '表情', exact: true }).click();
    await page.getByRole('button', { name: '🐳', exact: true }).click();
    await expect(page.locator('.bot-composer textarea')).toHaveValue('🐳');
    await page.getByRole('button', { name: '新伙伴', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新伙伴' });
    await create.getByLabel('名字', { exact: true }).fill('林舟');
    await create.getByLabel('人格与相处方式').fill('喜欢天文的可靠伙伴。');
    await create.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('林舟');
    const state = await page.evaluate(() => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state' }));
    expect(state.snapshot?.runtime).toMatchObject({ engine: 'worldlinebox', memory: 'vcp-memory', ready: false });
    expect(state.snapshot?.companions).toHaveLength(BUILTIN_BOT_COMPANIONS.length + 1);
    await page.getByRole('button', { name: '新群聊', exact: true }).click();
    const group = page.getByRole('dialog', { name: '新群聊' });
    await group.getByLabel('聊天名称').fill('观星小组');
    await group.getByLabel('大肥鱼', { exact: true }).check();
    await group.getByLabel('林舟', { exact: true }).check();
    await group.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('观星小组');
    await capture('new-companion-ui.png');
    await testInfo.attach('new-companion-ui', { path: testInfo.outputPath('new-companion-ui.png'), contentType: 'image/png' });
  } finally {
    await application.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
