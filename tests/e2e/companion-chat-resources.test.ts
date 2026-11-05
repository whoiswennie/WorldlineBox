import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxBotMediaApi, BotMediaRef } from '../../src/shared/companion-bot-media';
import type { WorldlineBoxBrowserApi } from '../../src/shared/browser';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- The real isolated Electron app owns its page.
test('chat resource cards, inline and document links open the built-in browser and single attachments preview directly', async ({}, testInfo) => {
  test.setTimeout(120000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-chat-resources-'));
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-chat-resources-')) throw Error('Unexpected isolated profile');
  const server = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>内置浏览器资源验收</title><h1>本地资料预览</h1>'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No local server');
  const url = `http://127.0.0.1:${address.port}/preview`;
  const file = path.join(profile, '项目阅读说明.md'); await writeFile(file, `# 项目阅读说明\n\n这是一份隔离测试文件。\n\n[打开资料页](${url}?source=document)`);
  const fixtureDirectory = testInfo.outputPath('fixture'); await mkdir(fixtureDirectory, { recursive: true });
  await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-chat-resources-fixture.ts', target: 'node24', outDir: fixtureDirectory, emptyOutDir: false, rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'seed.cjs' } } } });
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ app, BrowserWindow, shell, dialog }, input) => {
      if (app.getPath('userData') !== input.profile) throw Error('Expected an isolated profile');
      for (const window of BrowserWindow.getAllWindows()) { window.on('show', () => window.hide()); window.webContents.setBackgroundThrottling(false); window.setSize(1440, 1000); window.hide(); }
      Reflect.set(globalThis, '__resourceExternalCalls', []);
      shell.openExternal = async url => { (Reflect.get(globalThis, '__resourceExternalCalls') as string[]).push(url); };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.file] });
    }, { profile, file });
    const companions = page.locator('[data-application-module="companions"]'); await companions.click();
    const conversationId = await page.evaluate(async () => {
      const state = await (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state' });
      return state.snapshot!.conversations.find(room => room.kind === 'direct' && room.memberIds.includes('builtin-dafeiyu'))!.id;
    });
    const imported = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBotMedia: WorldlineBoxBotMediaApi }).companionBotMedia.request({ type: 'files.pick', conversationId }), conversationId);
    expect(imported.ok).toBe(true);
    const seeded = await app.evaluate(({ app }, input) => {
      const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      return (require(input.fixture) as { seedChatResources(profile: string, room: string, url: string, attachments: BotMediaRef[]): { card: string; inline: string; file: string; events: number } }).seedChatResources(input.profile, input.conversationId, input.url, input.attachments);
    }, { profile, conversationId, url, attachments: imported.media!, fixture: path.join(fixtureDirectory, 'seed.cjs') });
    expect(seeded.events).toBe(0); await page.reload(); await companions.click();
    const card = page.locator(`[data-bot-message="${seeded.card}"] .browser-markdown-link-card`);
    await expect(card).toContainText('项目资料预览'); await expect(card).toContainText('内置浏览器打开');
    await expect(page.locator('.bot-message-single-file .bot-attachment-card')).toHaveCount(2);
    const fileMessage = page.locator(`[data-bot-message="${seeded.file}"]`);
    await expect(fileMessage.getByRole('button', { name: '打开预览 项目阅读说明.md', exact: true })).toBeVisible();
    const evidence = path.resolve('artifacts/superagent-bot-development/ui'); await mkdir(evidence, { recursive: true });
    const capture = async (name: string) => {
      await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const file = testInfo.outputPath(name); await writeFile(file, Buffer.from(png, 'base64')); await copyFile(file, path.join(evidence, name));
    };
    await capture('chat-interactive-resources-light.png');
    const assertBrowser = async (expectedUrl: string) => {
      await expect(page.locator('[data-application-module="browser"]')).toHaveAttribute('aria-current', 'page');
      await expect.poll(() => page.evaluate(async expected => {
        const result = await (Reflect.get(window, 'worldlinebox') as { browser: WorldlineBoxBrowserApi }).browser.request({ type: 'state' });
        return result.ok && result.state?.tabs.find(tab => tab.id === result.state!.activeTabId)?.url === expected
          && result.state?.tabs.find(tab => tab.id === result.state!.activeTabId)?.title === '内置浏览器资源验收';
      }, expectedUrl)).toBe(true);
      expect(await app.evaluate(() => Reflect.get(globalThis, '__resourceExternalCalls'))).toEqual([]);
    };
    await card.click(); await assertBrowser(url); await companions.click();
    await page.locator(`[data-bot-message="${seeded.inline}"] .browser-chat-link`).click(); await assertBrowser(url + '?source=inline'); await companions.click();
    await fileMessage.getByRole('button', { name: '打开预览 项目阅读说明.md', exact: true }).click();
    const preview = page.getByRole('dialog', { name: '项目阅读说明.md', exact: true }); await expect(preview).toContainText('这是一份隔离测试文件');
    await preview.locator('.browser-chat-link').click(); await assertBrowser(url + '?source=document'); await companions.click();
    await expect(preview).toHaveCount(0); await expect(card).toBeVisible();
    await writeFile(path.join(evidence, 'chat-resource-browser-evidence.json'), JSON.stringify({ builtinBrowserNavigation: ['card', 'inline', 'document'], externalOpenCalls: 0, nativeHttpPageLoaded: true, singleFileDirectPreview: true, isolatedProfile: true, paidModelCalls: 0 }, null, 2));
  } finally { await app.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
