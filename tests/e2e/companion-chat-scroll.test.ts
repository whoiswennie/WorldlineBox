import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { BOT_EVENT_CHANNEL, type WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Electron supplies the page.
test('keeps the reading position while a reply streams and a new message arrives', async ({}) => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-chat-scroll-'));
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
    ...process.env, WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }) });
  try {
    const page = await app.firstWindow();
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    const dismiss = page.getByRole('button', { name: '稍后设置', exact: true });
    await expect(dismiss).toBeVisible();
    await dismiss.click();
    const conversationId = await page.evaluate(async () => {
      const bridge = Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi };
      return (await bridge.companionBot.request({ type: 'state' })).snapshot!.conversations[0]!.id;
    });
    const publish = async (rows: Array<{ id: string; text: string; status?: 'running' | 'sent' }>) => app.evaluate(({ app: electronApp, BrowserWindow }, fixture) => {
      const paths = process.getBuiltinModule('node:path'), { createRequire } = process.getBuiltinModule('node:module');
      if (paths.resolve(electronApp.getPath('userData')) !== paths.resolve(fixture.profile)) throw Error('Unexpected chat scroll profile');
      const require = createRequire(paths.join(electronApp.getAppPath(), 'package.json'));
      const Database = require('better-sqlite3') as { new(file: string): { prepare(sql: string): { run(...args: unknown[]): void }; close(): void } };
      const db = new Database(paths.join(fixture.profile, 'companion-bot-v2', 'bot.sqlite'));
      try {
        const write = db.prepare(`INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at)
          VALUES(?,?,?,'builtin-dafeiyu','大肥鱼','companion',?,?,'message','scroll-fixture','2026-11-12T08:00:00Z')
          ON CONFLICT(id) DO UPDATE SET content=excluded.content,status=excluded.status`);
        for (const row of fixture.rows) write.run(row.id, row.id, fixture.conversationId, row.text, row.status ?? 'sent');
      } finally { db.close(); }
      BrowserWindow.getAllWindows()[0]!.webContents.send(fixture.channel, { type: 'changed', conversationId: fixture.conversationId });
    }, { rows, profile, conversationId, channel: BOT_EVENT_CHANNEL });
    await publish([...Array.from({ length: 84 }, (_, index) => ({
      id: 'scroll-message-' + index, text: '较早的聊天内容 ' + index + '\n\n' + '用来验证滚动位置的一段正文。'.repeat(12),
    })), { id: 'scroll-active', text: '', status: 'running' }]);
    const log = page.getByRole('log');
    const bottomDistance = () => log.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
    await expect(log.locator('[data-bot-message]')).toHaveCount(80);
    await expect.poll(bottomDistance).toBeLessThanOrEqual(2);
    await log.hover();
    await page.mouse.wheel(0, -750);
    const latest = page.getByRole('button', { name: '回到最新', exact: true });
    await expect(latest).toBeVisible();
    await expect.poll(bottomDistance).toBeGreaterThan(200);
    const position = await log.evaluate(node => node.scrollTop);
    await app.evaluate(({ BrowserWindow }, fixture) => BrowserWindow.getAllWindows()[0]!.webContents.send(fixture.channel, {
      type: 'text', conversationId: fixture.conversationId, messageId: 'scroll-active', text: '伙伴正在流式回复。\n\n'.repeat(12),
    }), { conversationId, channel: BOT_EVENT_CHANNEL });
    await expect(log.locator('[data-bot-message="scroll-active"]')).toContainText('伙伴正在流式回复');
    await expect(page.locator('.bot-jump-latest')).toContainText('有新消息');
    expect(await log.evaluate(node => node.scrollTop)).toBe(position);
    await publish([{ id: 'scroll-active', text: '回复已经完成。\n\n'.repeat(12) }, { id: 'scroll-new', text: '又收到一条消息。' }]);
    await expect(log.locator('[data-bot-message="scroll-new"]')).toHaveText(/又收到一条消息/);
    expect(await log.evaluate(node => node.scrollTop)).toBe(position);
    await latest.click();
    await expect.poll(bottomDistance).toBeLessThanOrEqual(2);
    await expect(latest).toHaveCount(0);
    await publish([{ id: 'scroll-follow', text: '回到底部后继续跟随。' }]);
    await expect(log.locator('[data-bot-message="scroll-follow"]')).toBeVisible();
    await expect.poll(bottomDistance).toBeLessThanOrEqual(2);
    await log.getByRole('button', { name: '查看更早消息', exact: true }).click();
    await expect(log.locator('[data-bot-message="scroll-message-0"]')).toBeAttached();
    await expect(latest).toBeVisible();
    await latest.click();
    await expect(log.locator('[data-bot-message="scroll-message-0"]')).toHaveCount(0);
    await expect.poll(bottomDistance).toBeLessThanOrEqual(2);
  } finally {
    await app.close();
    if (path.dirname(profile) === path.resolve(tmpdir()) && path.basename(profile).startsWith('wlb-chat-scroll-')) await rm(profile, { recursive: true, force: true });
  }
});
