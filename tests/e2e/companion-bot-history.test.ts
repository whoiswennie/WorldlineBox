import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Electron supplies its own page.
test('chat history searches scoped FTS records and presents real categories in a wide modal', async ({}, testInfo) => {
  test.setTimeout(90000);
  testInfo.annotations.push({ type: 'visual-fixture', description: 'Human-authored isolated history records with real sticker references; no model-output claim.' });
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-bot-history-ui-'));
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-bot-history-ui-')) throw Error('Unexpected history fixture root');
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ ...process.env,
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  try {
    const page = await application.firstWindow(); await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    const context = await page.evaluate(async () => {
      const bridge = Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi; companionBotMedia: WorldlineBoxBotMediaApi };
      const state = await bridge.companionBot.request({ type: 'state' }), conversationId = state.snapshot!.conversations[0]!.id;
      const packs = await bridge.companionBotMedia.request({ type: 'packs.list', conversationId });
      const stickers = await bridge.companionBotMedia.request({ type: 'stickers.list', conversationId, packId: packs.packs![0]!.id });
      return { conversationId, sticker: stickers.media![0]! };
    });
    await application.evaluate(({ app }, fixture) => {
      const path = process.getBuiltinModule('node:path'), { createRequire } = process.getBuiltinModule('node:module');
      if (path.resolve(app.getPath('userData')) !== path.resolve(fixture.profile)) throw Error('History fixture must not use the real profile');
      const require = createRequire(path.join(app.getAppPath(), 'package.json'));
      const Database = require('better-sqlite3') as { new(filename: string): { prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void } };
      const db = new Database(path.join(fixture.profile, 'companion-bot-v2', 'bot.sqlite'));
      try {
        const rows = [
          ['user', '我', '昨天聊到的项目，今天一起把它做完吧。', '2026-11-02T12:10:00Z'],
          ['builtin-dafeiyu', '大肥鱼', '好呀，先把最重要的一小步找出来。', '2026-11-02T12:12:00Z'],
          ['user', '我', '樱花项目的 SQLite 记录方案已经确认。', '2026-11-03T00:10:00Z'],
          ['builtin-dafeiyu', '大肥鱼', '收到。我会沿用这个决定，需要时也可以回看原话。', '2026-11-03T00:11:00Z'],
          ['user', '我', '参考链接：https://example.com/project', '2026-11-03T00:12:00Z'],
          ['builtin-dafeiyu', '大肥鱼', '', '2026-11-03T00:13:00Z'],
        ];
        const insert = db.prepare('INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at,attachments_json) VALUES(?,?,?,?,?,?,?,\'sent\',\'message\',?,?,?)');
        rows.forEach(([senderId, senderName, content, createdAt], index) => insert.run(`history-visual-${index}`, `history-event-${index}`, fixture.conversationId,
          senderId, senderName, senderId === 'user' ? 'user' : 'companion', content, 'history-ui-fixture', createdAt, JSON.stringify(index === rows.length - 1 ? [fixture.sticker] : [])));
      } finally { db.close(); }
    }, { ...context, profile });
    const evidence = path.resolve('artifacts/superagent-bot-development/ui'); await mkdir(evidence, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(theme => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme })), theme);
      await page.reload(); await page.locator('[data-application-module="companions"]').click();
      await page.getByRole('button', { name: '聊天记录', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '聊天记录', exact: true });
      await expect(dialog).toBeVisible(); await expect(dialog.locator('.bot-history-record')).toHaveCount(6);
      await expect(dialog.locator('.bot-history-date')).toHaveCount(2);
      await expect(page.locator('.bot-detail')).toHaveCount(0);
      const avatars = await page.locator('.bot-avatar').evaluateAll(elements => elements.map(element => {
        const bounds = element.getBoundingClientRect(); return { radius: getComputedStyle(element).borderRadius, width: bounds.width, height: bounds.height };
      }));
      expect(avatars.length).toBeGreaterThan(6);
      for (const avatar of avatars) { expect(avatar.radius).toBe('50%'); expect(Math.abs(avatar.width - avatar.height)).toBeLessThan(.1); }
      const bounds = await dialog.boundingBox(), viewport = page.viewportSize();
      expect(bounds!.width).toBeGreaterThan(600); expect(bounds!.height).toBeGreaterThan(400);
      if (viewport) expect(bounds!.width).toBeLessThan(viewport.width);
      await expect(dialog.getByRole('searchbox', { name: '搜索聊天记录', exact: true })).toBeFocused();
      const file = testInfo.outputPath(`history-modal-${theme}.png`); await page.screenshot({ path: file, fullPage: true });
      await copyFile(file, path.join(evidence, `history-modal-${theme}.png`)); await testInfo.attach(`history-modal-${theme}`, { path: file, contentType: 'image/png' });
      await dialog.getByRole('searchbox', { name: '搜索聊天记录', exact: true }).fill('SQLite');
      await expect(dialog.locator('.bot-history-record')).toHaveCount(1);
      await expect(dialog.locator('mark')).toHaveText('SQLite');
      await dialog.getByRole('searchbox', { name: '搜索聊天记录', exact: true }).fill('');
      await dialog.getByRole('tab', { name: '表情', exact: true }).click();
      await expect(dialog.locator('.bot-history-record')).toHaveCount(1); await expect(dialog.locator('.bot-history-thumbnail img')).toBeVisible();
      await dialog.getByRole('tab', { name: '链接', exact: true }).click();
      await expect(dialog.locator('.bot-history-record')).toHaveCount(1); await expect(dialog.locator('.bot-history-preview')).toContainText('https://example.com');
      await dialog.locator('.bot-history-locate').click();
      await expect(dialog).toHaveCount(0); await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '回到最新', exact: true }).click();
      for (const expressions of ['emoji', 'stickers'] as const) {
        await page.getByRole('button', { name: expressions === 'emoji' ? '表情' : '表情包', exact: true }).click();
        const picker = page.locator('.bot-expression-picker'); await expect(picker).toBeVisible();
        if (expressions === 'emoji') await expect(picker.locator('.bot-expression-emoji-grid button').first()).toBeVisible();
        else {
          await expect(picker.locator('.bot-sticker-grid img').first()).toBeVisible();
          await expect.poll(() => picker.locator('.bot-sticker-grid img').first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
          const query = picker.getByRole('textbox', { name: '搜索表情', exact: true });
          await expect(query).toHaveCount(0);
          const fullPackCount = await picker.locator('.bot-sticker-grid button').count();
          const originalName = (await picker.locator('.bot-sticker-grid button').first().getAttribute('title'))!.split('\n')[0]!;
          await expect(picker.locator('.bot-sticker-caption').first()).toHaveText(originalName.replace(/\.[^.]+$/, ''));
          await picker.getByRole('button', { name: '搜索表情包', exact: true }).click();
          await expect(query).toBeFocused(); await query.fill(originalName);
          await expect(picker.locator('.bot-sticker-grid button')).toHaveCount(1);
          await picker.getByRole('button', { name: '收起搜索', exact: true }).click();
          await expect(query).toHaveCount(0); await expect(picker.locator('.bot-sticker-grid button')).toHaveCount(fullPackCount);
        }
        const pickerBounds = await picker.boundingBox(), screen = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        expect(pickerBounds!.width).toBeGreaterThan(300); expect(pickerBounds!.height).toBeGreaterThan(250);
        expect(pickerBounds!.x).toBeGreaterThanOrEqual(0); expect(pickerBounds!.y).toBeGreaterThanOrEqual(0);
        expect(pickerBounds!.x + pickerBounds!.width).toBeLessThanOrEqual(screen.width); expect(pickerBounds!.y + pickerBounds!.height).toBeLessThanOrEqual(screen.height);
        const panelImage = testInfo.outputPath(`${expressions}-panel-${theme}.png`); await page.screenshot({ path: panelImage, fullPage: true });
        await copyFile(panelImage, path.join(evidence, `${expressions}-panel-${theme}.png`)); await testInfo.attach(`${expressions}-panel-${theme}`, { path: panelImage, contentType: 'image/png' });
        await picker.getByRole('button', { name: '关闭表情面板', exact: true }).click(); await expect(picker).toHaveCount(0);
      }
    }
  } finally { await application.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
