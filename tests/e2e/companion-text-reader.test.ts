import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';

// eslint-disable-next-line no-empty-pattern -- Real local files, production attachment IPC and renderer; no model inference required.
test('notebook reader supports wheel, keyboard, outline, display modes, font size and bounded large-text pages', async ({}, testInfo) => {
  test.setTimeout(120000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-note-reader-'));
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-note-reader-')) throw Error('Unexpected reader fixture root');
  const markdown = path.join(profile, '项目笔记.md'), text = path.join(profile, '长文本.txt'), evidence = path.resolve('artifacts/companion-text-reader');
  await mkdir(evidence, { recursive: true });
  await writeFile(markdown, '# 项目研究笔记\n\n把资料放回清晰的阅读空间。\n\n> 保留原始资料，核实真实结果。\n\n' + Array.from({ length: 14 }, (_, chapter) => `## ${chapter + 1}. ${['研究背景', '任务边界', '架构设计', '附件交付', '协作方案', '验收记录', '后续计划'][chapter % 7]}\n\n` + Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 条记录：伙伴以独立话题推进工作，核对输入资料、阶段进展与最终交付。使用 **重点说明** 和 \`sessionId\` 标记关键内容。\n\n`).join('')).join('\n') + '\n---\n\n笔记末尾校验：鲸鱼阅读室。');
  await writeFile(text, '# 这是纯文本，不应渲染标题\n' + '大文件分段读取，滚轮在当前正文独立滚动。\n'.repeat(5000) + '纯文本末尾校验：完整到达。');
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1' }) });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow, dialog }, files) => { const win = BrowserWindow.getAllWindows()[0]!; win.setMinimumSize(0, 0); win.setSize(1680, 1040); win.webContents.setBackgroundThrottling(false); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [markdown, text]);
    await page.locator('[data-application-module="companions"]').click();
    const imported = await page.evaluate(async () => {
      const bridge = Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi; companionBotMedia: WorldlineBoxBotMediaApi };
      const room = (await bridge.companionBot.request({ type: 'state' })).snapshot!.conversations[0]!;
      const result = await bridge.companionBotMedia.request({ type: 'files.pick', conversationId: room.id });
      if (!result.ok || result.media?.length !== 2) throw Error(result.error ?? 'Local file import failed'); return { roomId: room.id, media: result.media };
    });
    // Seed only the owned fixture's transcript. File bytes, import, validation,
    // paged reads, security scope and all reader interactions are production.
    await app.evaluate(({ app }, input) => {
      const paths = process.getBuiltinModule('node:path');
      if (paths.resolve(app.getPath('userData')) !== paths.resolve(input.profile)) throw Error('Cannot seed a user profile');
      const require = process.getBuiltinModule('node:module').createRequire(paths.join(app.getAppPath(), 'package.json'));
      const Database = require('better-sqlite3') as { new(filename: string): { prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void } };
      const db = new Database(paths.join(input.profile, 'companion-bot-v2', 'bot.sqlite'));
      try { db.prepare("INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at,attachments_json) VALUES('reader-fixture','reader-fixture',?,'user','我','user','本地文档阅读验收资料。','sent','message','reader-fixture',?,?)").run(input.roomId, new Date().toISOString(), JSON.stringify(input.media)); } finally { db.close(); }
    }, { profile, ...imported });
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    const dismiss = page.getByRole('button', { name: '稍后设置', exact: true });
    await expect(dismiss.or(page.locator('.bot-binding-blocked')).first()).toBeVisible(); if (await dismiss.isVisible()) await dismiss.click();
    await page.getByRole('button', { name: '展开 2 个附件', exact: true }).click();
    await page.getByRole('button', { name: '打开预览 项目笔记.md', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: '项目笔记.md', exact: true }), body = viewer.getByRole('region', { name: '文档正文', exact: true });
    const capture = async (name: string) => { const filename = path.join(evidence, name + '.png'); await page.screenshot({ path: filename, fullPage: true }); await testInfo.attach(name, { path: filename, contentType: 'image/png' }); };
    await expect(viewer.locator('.bot-attachment-document h1')).toHaveText('项目研究笔记');
    await expect(viewer.getByRole('navigation', { name: '文档章节' }).getByRole('button')).toHaveCount(15);
    await capture('notebook-reader-light');
    const header = await viewer.locator('.bot-attachment-viewer-header').boundingBox(), chatTop = await page.locator('.bot-transcript').evaluate(node => node.scrollTop);
    expect(await body.evaluate(node => node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY === 'auto')).toBe(true);
    await body.hover(); await page.mouse.wheel(0, 950);
    await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(300);
    expect((await viewer.locator('.bot-attachment-viewer-header').boundingBox())!.y).toBe(header!.y);
    expect(await page.locator('.bot-transcript').evaluate(node => node.scrollTop)).toBe(chatTop);
    await body.focus(); const beforeKey = await body.evaluate(node => node.scrollTop); await page.keyboard.press('PageDown');
    await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(beforeKey + 50);
    await viewer.getByRole('navigation', { name: '文档章节' }).getByRole('button', { name: '5. 协作方案', exact: true }).click();
    await expect.poll(() => viewer.getByRole('navigation', { name: '文档章节' }).locator('[aria-current=location]').innerText()).toBe('5. 协作方案');
    await viewer.getByRole('button', { name: '放大字号', exact: true }).click();
    await expect.poll(() => viewer.locator('.browser-markdown').evaluate(node => getComputedStyle(node).fontSize)).toBe('16px');
    const readPosition = await body.evaluate(node => node.scrollTop);
    await viewer.getByRole('button', { name: '原文', exact: true }).click(); await expect(viewer.locator('.bot-attachment-document>pre')).toContainText('## 5. 协作方案');
    await body.hover(); await page.mouse.wheel(0, 700); await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
    await viewer.getByRole('button', { name: '阅读', exact: true }).click(); await expect.poll(() => body.evaluate((node, target) => Math.abs(node.scrollTop - target), readPosition)).toBeLessThan(3);
    await viewer.getByRole('button', { name: '回到文档顶部', exact: true }).click(); await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(0);
    await body.focus(); await page.keyboard.press('Control+End'); await expect.poll(() => viewer.getByLabel('阅读进度').innerText()).toBe('100%');
    await capture('notebook-reader-scrolled'); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '打开预览 长文本.txt', exact: true }).click();
    const plain = page.getByRole('dialog', { name: '长文本.txt', exact: true });
    await expect(plain.locator('.bot-attachment-document>pre')).toContainText('# 这是纯文本'); await expect(plain.locator('.bot-attachment-document h1')).toHaveCount(0);
    let pages = 1;
    while (await plain.getByRole('button', { name: '下一段', exact: true }).isEnabled()) {
      expect((await plain.locator('.bot-attachment-document').innerText()).length).toBeLessThan(66000);
      await plain.getByRole('button', { name: '下一段', exact: true }).click(); await expect(plain.getByRole('region', { name: '文档正文' })).toHaveAttribute('aria-busy', 'false'); pages++; if (pages > 12) throw Error('Unexpected unbounded text pagination');
    }
    await expect(plain.locator('.bot-attachment-document')).toContainText('纯文本末尾校验：完整到达。'); expect(pages).toBeGreaterThan(2);
    await page.keyboard.press('Escape');
    await page.evaluate(() => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'dark' })));
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    await expect(dismiss.or(page.locator('.bot-binding-blocked')).first()).toBeVisible(); if (await dismiss.isVisible()) await dismiss.click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 800));
    await page.getByRole('button', { name: '展开 2 个附件', exact: true }).click(); await page.getByRole('button', { name: '打开预览 项目笔记.md', exact: true }).click();
    await expect(viewer).toBeVisible(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(viewer.locator('.bot-attachment-document h1')).toHaveText('项目研究笔记');
    expect(await viewer.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true);
    await body.hover(); await page.mouse.wheel(0, 750); await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(200);
    await capture('notebook-reader-narrow-dark');
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, realFiles: true, productionIpc: true, wheel: true, keyboardScroll: true, outlineNavigation: true, fontSize: true, preservesModeScroll: true, chatScrollUnchanged: true, boundedPages: pages, darkAndNarrow: true }, null, 2));
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
