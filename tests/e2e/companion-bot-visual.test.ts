import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Electron supplies its own page.
test('normal-message visual fixtures show compact anime chat bubbles in light and dark themes', async ({}, testInfo) => {
  testInfo.annotations.push({ type: 'visual-fixture', description: 'Synthetic dialogue in an isolated UI database. No model or task execution; not a model-quality result.' });
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-bot-visual-'));
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-bot-visual-')) throw Error('Unexpected visual fixture root');
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ ...process.env,
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  try {
    const page = await app.firstWindow(); await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    const context = await page.evaluate(async () => {
      const bridge = Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi; companionBotMedia: WorldlineBoxBotMediaApi };
      const state = await bridge.companionBot.request({ type: 'state' }), conversationId = state.snapshot!.conversations[0]!.id;
      const packs = await bridge.companionBotMedia.request({ type: 'packs.list', conversationId });
      const stickers = await bridge.companionBotMedia.request({ type: 'stickers.list', conversationId, packId: packs.packs![0]!.id });
      return { conversationId, sticker: stickers.media![0]! };
    });
    await app.evaluate(async ({ app }, fixture) => {
      const path = process.getBuiltinModule('node:path'), { createRequire } = process.getBuiltinModule('node:module');
      if (path.resolve(app.getPath('userData')) !== path.resolve(fixture.profile)) throw Error('Visual fixture must not write the real user profile');
      const require = createRequire(path.join(app.getAppPath(), 'package.json'));
      const Database = require('better-sqlite3') as { new(filename: string): { prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void } };
      const db = new Database(path.join(fixture.profile, 'companion-bot-v2', 'bot.sqlite'));
      try {
        const rows = [
          ['user', '我', '今天有点累，能陪我聊会儿吗？'],
          ['builtin-dafeiyu', '大肥鱼', '当然。先坐一会儿吧，今天最消耗你精力的是哪件事？\n\n不急着把一切整理好，慢慢说就行。🐳'],
          ['user', '我', '一整天都在改方案，好在终于做完了。'],
          ['builtin-dafeiyu', '大肥鱼', '那就先给“做完了”记一笔。辛苦啦，今晚可以给自己留一点不用赶进度的时间。'],
          ['user', '我', ''],
        ];
        const insert = db.prepare('INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at,attachments_json) VALUES(?,?,?,?,?,?,?,\'sent\',\'message\',?,?,?)');
        rows.forEach(([id, name, content], index) => insert.run(`visual-${index}`, `visual-event-${index}`, fixture.conversationId, id, name, id === 'user' ? 'user' : 'companion', content,
          'visual-fixture', new Date(Date.now() - (rows.length - index) * 60000).toISOString(), JSON.stringify(index === rows.length - 1 ? [fixture.sticker] : [])));
      } finally { db.close(); }
    }, { ...context, profile });
    const evidence = path.resolve('artifacts/superagent-bot-development/ui'); await mkdir(evidence, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(theme => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme })), theme);
      await page.reload(); await page.locator('[data-application-module="companions"]').click();
      await expect(page.locator('.bot-message')).toHaveCount(5);
      await expect(page.locator('.bot-message-avatar')).toHaveCount(5);
      const bubble = await page.locator('.from-user .bot-message-text').first().boundingBox(), row = await page.locator('.from-user').first().boundingBox();
      expect(bubble!.width).toBeLessThan(row!.width * .75);
      await page.locator('.bot-transcript').evaluate(element => { element.scrollTop = 0; });
      const file = testInfo.outputPath(`anime-chat-${theme}.png`); await page.screenshot({ path: file, fullPage: true });
      await copyFile(file, path.join(evidence, `anime-chat-${theme}.png`)); await testInfo.attach(`anime-chat-${theme}`, { path: file, contentType: 'image/png' });
    }
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
