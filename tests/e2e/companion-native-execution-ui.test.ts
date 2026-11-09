import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { BotExecution, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- The desktop app owns the page.
test('native execution bubbles preserve chat, group and peer UI with a single information sidebar control', async ({}, testInfo) => {
  test.setTimeout(120_000);
  testInfo.annotations.push({ type: 'native-execution-ui', description: 'Real Electron IPC and renderer, isolated profile, synthetic native execution events. No model inference or DSH execution claim.' });
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-native-chat-ui-'));
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-native-chat-ui-')) throw Error('Unexpected fixture profile');
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ ...process.env,
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  try {
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1760, 1000));
    const open = async () => {
      await page.locator('[data-application-module="companions"]').click();
      const dismiss = page.getByRole('button', { name: '稍后设置', exact: true });
      await expect(dismiss.or(page.locator('.bot-peer-observer-dock'))).toBeVisible(); if (await dismiss.isVisible()) await dismiss.click();
    };
    await open(); await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    const context = await page.evaluate(async () => {
      const bridge = Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi; companionBotMedia: WorldlineBoxBotMediaApi };
      const state = await bridge.companionBot.request({ type: 'state' }), conversationId = state.snapshot!.conversations[0]!.id;
      const packs = await bridge.companionBotMedia.request({ type: 'packs.list', conversationId });
      const stickers = await bridge.companionBotMedia.request({ type: 'stickers.list', conversationId, packId: packs.packs![0]!.id });
      return { conversationId, sticker: stickers.media![0]! };
    });
    const running: BotExecution = { sessionId: 'native-fresh-message-session', status: 'running', phase: 'using-tool', steps: [
      { id: '1', type: 'session_created', summary: '在伙伴工作区开启新会话', at: '2026-11-09T07:00:00Z' },
      { id: '2', type: 'tool_call', summary: '正在读取工作区资料', toolName: 'read_file', text: '读取：项目说明.md', at: '2026-11-09T07:00:01Z' },
    ] };
    const seed = async (execution: BotExecution, content: string, status: 'running' | 'sent') => application.evaluate(({ app }, fixture) => {
      const paths = process.getBuiltinModule('node:path'), { createRequire } = process.getBuiltinModule('node:module');
      if (paths.resolve(app.getPath('userData')) !== paths.resolve(fixture.profile)) throw Error('Fixture cannot write a real profile');
      const require = createRequire(paths.join(app.getAppPath(), 'package.json'));
      const Database = require('better-sqlite3') as { new(filename: string): { prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void } };
      const db = new Database(paths.join(fixture.profile, 'companion-bot-v2', 'bot.sqlite'));
      try {
        const insert = db.prepare('INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at,attachments_json) VALUES(?,?,?,?,?,?,?,?,\'message\',?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,status=excluded.status');
        insert.run('native-ui-user', 'native-user-event', fixture.conversationId, 'user', '我', 'user', '请读一下工作区资料，整理重点。', 'sent', 'native-fixture', '2026-11-09T07:00:00Z', '[]');
        insert.run('native-ui-reply', 'native-reply-event', fixture.conversationId, 'builtin-dafeiyu', '大肥鱼', 'companion', fixture.content, fixture.status, 'native-fixture', '2026-11-09T07:00:01Z', JSON.stringify([fixture.sticker]));
        db.prepare('INSERT INTO bot_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('execution:native-ui-reply', JSON.stringify(fixture.execution));
      } finally { db.close(); }
    }, { profile, ...context, execution, content, status });
    const evidence = path.resolve('artifacts/dsh-native-refactor/ui'); await mkdir(evidence, { recursive: true });
    const capture = async (name: string) => {
      const filename = testInfo.outputPath(name); await page.screenshot({ path: filename, fullPage: true });
      await copyFile(filename, path.join(evidence, name)); await testInfo.attach(name, { path: filename, contentType: 'image/png' });
    };
    await seed(running, '', 'running'); await page.reload(); await open();
    const bubble = page.locator('[data-bot-message="native-ui-reply"]');
    await expect(bubble.locator('.bot-execution-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(bubble.locator('.bot-execution-contents')).toContainText('read_file');
    await expect(page.locator('.bot-chat-tasks,.bot-chat-header .bot-context-toggle')).toHaveCount(0);
    await expect(page.locator('.bot-chat-context')).toBeVisible();
    await expect(bubble.locator('.is-sticker img')).toBeVisible();
    await capture('native-chat-running.png');
    await seed({ ...running, status: 'succeeded' }, '**资料已经整理好了。**\n\n伙伴工作区中保留本次结果。', 'sent');
    await page.reload(); await open();
    await expect(bubble.locator('.bot-execution-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(bubble.locator('.bot-execution-contents')).toBeHidden();
    await expect(bubble.locator('.bot-message-text strong')).toHaveText('资料已经整理好了。');
    await capture('native-chat-completed.png');
    await bubble.locator('.bot-execution-toggle').click(); await expect(bubble.locator('.bot-execution-contents')).toBeVisible();
    await bubble.getByText('内容', { exact: true }).click(); await expect(bubble.locator('pre')).toContainText('读取：项目说明.md');
    await capture('native-chat-details.png');
    await page.getByRole('button', { name: '收起聊天信息', exact: true }).click();
    await expect(page.getByRole('button', { name: '展开聊天信息', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: '展开聊天信息', exact: true }).click(); await expect(page.locator('.bot-chat-context')).toBeVisible();
    await page.getByRole('button', { name: '新群聊', exact: true }).click();
    const group = page.getByRole('dialog', { name: '新群聊', exact: true });
    await group.getByLabel('聊天名称', { exact: true }).fill('原生会话测试群');
    await group.getByLabel('大肥鱼', { exact: true }).check(); await group.getByLabel('Claude', { exact: true }).check();
    await group.getByRole('button', { name: '创建', exact: true }).click(); await expect(page.locator('.bot-chat-header h2')).toHaveText('原生会话测试群');
    await expect(page.locator('.bot-group-members-trigger')).toContainText('3 位成员');
    await expect(page.locator('.bot-group-overview')).toBeVisible(); await capture('native-group-chat.png');
    const peer = await page.evaluate(() => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'conversation.peer.open', memberIds: ['builtin-dafeiyu', 'claude'] }));
    await application.evaluate(({ app }, fixture) => {
      const paths = process.getBuiltinModule('node:path'), { createRequire } = process.getBuiltinModule('node:module');
      if (paths.resolve(app.getPath('userData')) !== paths.resolve(fixture.profile)) throw Error('Peer fixture cannot write real profile');
      const Database = createRequire(paths.join(app.getAppPath(), 'package.json'))('better-sqlite3') as { new(filename: string): { prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void } };
      const db = new Database(paths.join(fixture.profile, 'companion-bot-v2', 'bot.sqlite'));
      try { db.prepare("INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at) VALUES(?,?,?,'claude','Claude','companion','我来核对这份资料。','sent','message','native-peer-ui',?)").run('native-peer-message','native-peer-event',fixture.conversationId,'2026-11-09T07:01:00Z'); } finally { db.close(); }
    }, { profile, conversationId: peer.conversationId! });
    expect(peer.ok).toBe(true); await page.reload(); await open();
    await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: '大肥鱼 × Claude' }).click();
    await expect(page.locator('.bot-peer-observer-dock')).toBeVisible();
    await expect(page.locator('.bot-composer,.bot-chat-tasks')).toHaveCount(0); await capture('native-peer-observer.png');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1200, 850)); await page.reload(); await open();
    expect(await page.locator('.bot-main').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await capture('native-chat-narrow.png');
  } finally { await application.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
