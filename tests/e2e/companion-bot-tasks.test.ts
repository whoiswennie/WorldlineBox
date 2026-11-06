import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { BOT_EVENT_CHANNEL } from '../../src/shared/companion-bot';
import type { seedGroupTaskWorkspace, seedTaskActivityHistory, appendTaskActivityConversationMessage } from '../fixtures/bot-task-workspace-fixture';
import { electronLaunchEnv, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

async function sha256(file: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }

// eslint-disable-next-line no-empty-pattern -- Electron owns the page.
test('task workspace uses real paged IPC and queue controls with compact receipts and parallel activity', async ({}, testInfo) => {
  test.setTimeout(120000);
  testInfo.annotations.push({ type: 'isolated-store-fixture', description: 'Human-authored task and progress fixtures via actual BotStore; actual Main IPC handles task.list/get/queue controls. Packaged identity is checked when a packaged executable is configured. No DSH execution or paid model is claimed.' });
  const prefix = 'wlb-task-workspace-', profile = await mkdtemp(path.join(tmpdir(), prefix));
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith(prefix) || (await lstat(profile)).isSymbolicLink() || path.resolve(await realpath(profile)) !== path.resolve(profile)) throw new Error('Unexpected task workspace test profile');
  const fixtureDirectory = testInfo.outputPath('fixture'); await mkdir(fixtureDirectory, { recursive: true });
  await build({ configFile: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-task-workspace-fixture.ts', target: 'node24', outDir: fixtureDirectory, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'seed.cjs' } } } });
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  try {
    await preparePackagedCompanionLaunch(application, profile);
    const page = await application.firstWindow();
    const identity = await application.evaluate(({ app, BrowserWindow }, expected) => {
      if (app.getPath('userData') !== expected) throw new Error('Task fixtures must not access a production profile');
      const frames = { paints: 0 }; Reflect.set(globalThis, '__taskUiFrames', frames);
      for (const owned of BrowserWindow.getAllWindows()) { owned.on('show', () => owned.hide()); owned.webContents.setBackgroundThrottling(false); owned.webContents.on('paint', () => { frames.paints++; }); owned.setMinimumSize(0, 0); owned.setSize(1800, 1000); owned.hide(); }
      return { pid: process.pid, packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData'), offscreen: BrowserWindow.getAllWindows()[0]!.webContents.isOffscreen() };
    }, profile);
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) { expect(identity.packaged).toBe(true); expect(identity.appPath).toMatch(/app\.asar$/u); }
    expect(identity.offscreen).toBe(true);
    const asarBefore = identity.packaged ? await sha256(identity.appPath) : undefined;
    await writeFile(testInfo.outputPath('task-workspace-launch.json'), JSON.stringify({ ...identity, asarBefore }, null, 2));
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    const conversationId = await page.evaluate(async () => {
      const state = await (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state' });
      return state.snapshot!.conversations.find(room => room.kind === 'direct' && room.memberIds.includes('builtin-dafeiyu'))!.id;
    });
    const seeded = await application.evaluate(({ app }, input) => {
      if (app.getPath('userData') !== input.profile) throw new Error('Unexpected fixture profile');
      const { createRequire } = process.getBuiltinModule('node:module'); const require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      return (require(input.fixture) as { seedTaskWorkspace(profile: string, room: string): unknown }).seedTaskWorkspace(input.profile, input.conversationId);
    }, { profile, conversationId, fixture: path.join(fixtureDirectory, 'seed.cjs') });
    await page.evaluate(() => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'light' })));
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('.bot-chat-identity .bot-presence-dot')).toBeVisible();
    await expect(page.locator('.bot-presence-feedback')).toHaveCount(0);
    await expect(page.locator('.bot-task-notice')).toHaveCount(2); await expect(page.locator('.bot-transcript')).not.toContainText('MASSIVE EXECUTOR RECEIPT');
    await expect(page.locator('.bot-followup-receipt')).toContainText('已交给原任务');
    await expect(page.locator('.bot-followup-receipt')).toContainText('整理项目目录 1');
    await expect(page.locator('.browser-markdown-link-card strong')).toHaveText('视频链接');
    expect(await page.locator('.browser-markdown-link:not(.browser-markdown-link-card)').evaluate(element => {
      const style = getComputedStyle(element); return { border: style.borderTopWidth, padding: style.paddingTop, background: style.backgroundColor };
    })).toEqual({ border: '0px', padding: '0px', background: 'rgba(0, 0, 0, 0)' });
    const receiptState = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId }), conversationId);
    expect(receiptState.snapshot!.messages.some(message => message.senderId === 'user' && message.taskFollowup?.state === 'delivered')).toBe(true);
    const inlineNotice = page.locator('.bot-task-notice').first();
    await expect(inlineNotice).toHaveAttribute('data-task-owner', 'builtin-dafeiyu');
    await expect(inlineNotice.locator('.bot-task-notice-meta strong')).toHaveText('大肥鱼');
    await expect(inlineNotice.locator('.bot-avatar img')).toBeVisible();
    await expect.poll(() => inlineNotice.locator('.bot-avatar img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const inlineMetadata = await page.evaluate(async conversationId => {
      const state = await (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId });
      const element = document.querySelector<HTMLElement>('.bot-task-notice')!, message = state.snapshot!.messages.find(item => item.id === element.dataset.botMessage)!;
      return { messageId: message.id, companionId: message.taskNotice?.companionId, createdAt: message.createdAt,
        expectedClock: new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }), text: element.textContent };
    }, conversationId);
    expect(inlineMetadata.companionId).toBe('builtin-dafeiyu');
    await expect(inlineNotice.locator('time')).toHaveAttribute('datetime', inlineMetadata.createdAt);
    await expect(inlineNotice.locator('time')).toHaveText(inlineMetadata.expectedClock);
    expect(inlineMetadata.text).not.toMatch(/MASSIVE|task-presentation-|succeeded|完整任务要求/u);
    await expect(page.locator('.bot-transcript')).not.toContainText('ALREADY REPORTED TRANSPORT RECEIPT');
    await expect(page.locator('.bot-transcript')).toContainText('我已经把整理结果带回来啦。');
    const receiptBounds = await inlineNotice.boundingBox(); expect(receiptBounds!.width).toBeLessThanOrEqual(482);
    const retained = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'history.search', conversationId, query: 'ALREADY', limit: 20 }), conversationId);
    expect(retained.history?.items.some(message => message.content.includes('ALREADY REPORTED TRANSPORT RECEIPT'))).toBe(true);
    await expect(page.locator('.bot-active-tasks')).toHaveCount(0);
    const before = await page.locator('.bot-transcript').boundingBox();
    await page.locator('.bot-chat-tasks').click(); const dialog = page.getByRole('dialog', { name: '任务工作台' }); await expect(dialog).toBeVisible();
    expect(await page.locator('.bot-transcript').boundingBox()).toEqual(before);
    await expect(dialog.locator('[data-task-row]')).toHaveCount(6); await expect(dialog.locator('[data-bot-task]')).toHaveCount(1);
    await expect(dialog.locator('.bot-tasks-pagination')).toContainText('19'); await expect(dialog.locator('details')).toHaveCount(0);
    await expect(dialog.getByRole('tab', { name: '概览', exact: true })).toHaveAttribute('aria-selected', 'true');
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill('已停止的隔夜任务');
    await expect(dialog.locator('[data-task-row]')).toHaveCount(1);
    await expect(dialog.locator('.bot-task-heading')).toContainText('已停止');
    await expect(dialog.locator('.bot-task-metrics')).toContainText('执行用时');
    await expect(dialog.locator('.bot-task-metrics b')).toHaveText('1 分 30 秒');
    await expect(dialog.locator('[data-task-row="task-presentation-18"] .bot-task-row-activity')).toContainText('1 分 30 秒');
    await expect(dialog.getByRole('button', { name: '移除记录', exact: true })).toBeVisible();
    await expect(dialog).not.toContainText('等待停止确认');
    await expect(dialog).not.toContainText('停止待核实');
    await expect(dialog.getByRole('button', { name: '重新核实停止', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '再次请求停止', exact: true })).toHaveCount(0);
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill(''); await expect(dialog.locator('[data-task-row]')).toHaveCount(6);
    await dialog.getByRole('button', { name: '下一页任务' }).click(); await expect(dialog.locator('.bot-tasks-pagination')).toContainText('2 / 4');
    await dialog.getByRole('button', { name: '上一页任务' }).click();
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill('整理项目目录 1');
    await expect(dialog.locator('[data-task-row="task-presentation-00"] .bot-task-row-activity')).toContainText('shell');
    await expect(dialog.locator('.bot-task-heading h4')).not.toContainText('完整任务要求');
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill('核对附件格式 3');
    await expect(dialog.locator('[data-task-row]')).toHaveCount(1);
    await dialog.getByRole('tab', { name: /执行记录/ }).click();
    await expect(dialog.locator('.bot-task-diagnostic')).toContainText('58');
    await expect(dialog.locator('.bot-task-diagnostic pre')).toContainText('original worker session');
    await dialog.getByRole('tab', { name: '任务详情', exact: true }).click(); await expect(dialog.locator('.bot-task-goal')).toContainText('完整任务要求');
    await dialog.getByRole('tab', { name: '概览', exact: true }).click();
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill(''); await expect(dialog.locator('[data-task-row]')).toHaveCount(6);
    const evidence = path.resolve('artifacts/superagent-bot-development/ui'); await mkdir(evidence, { recursive: true });
    const capture = async (name: string) => {
      await expect(page.locator('.application-navigation')).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const beforePaint = await application.evaluate(({ BrowserWindow }) => {
        const previous = (Reflect.get(globalThis, '__taskUiFrames') as { paints: number }).paints;
        BrowserWindow.getAllWindows()[0]!.webContents.invalidate(); return previous;
      });
      await expect.poll(() => application.evaluate(() => (Reflect.get(globalThis, '__taskUiFrames') as { paints: number }).paints)).toBeGreaterThan(beforePaint);
      const png = await application.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); return image.toPNG().toString('base64');
      });
      const file = testInfo.outputPath(name); await writeFile(file, Buffer.from(png, 'base64')); await copyFile(file, path.join(evidence, name)); await testInfo.attach(name, { path: file, contentType: 'image/png' });
    };
    await dialog.getByRole('button', { name: '关闭任务', exact: true }).click(); await expect(dialog).toBeHidden();
    await capture('chat-followup-receipt-links-light.png');
    await page.locator('.bot-followup-receipt button').click(); await expect(dialog).toBeVisible();
    await expect(dialog.locator('.bot-task-heading h4')).toContainText('整理项目目录 1');
    await dialog.getByRole('button', { name: '关闭任务', exact: true }).click();
    const context = page.getByRole('complementary', { name: '聊天信息', exact: true });
    await expect(context).toBeVisible();
    const summaryState = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId }), conversationId);
    expect(summaryState.snapshot?.taskSummary).toMatchObject({ activeCount: 13, queuedCount: 11 });
    const expectedSummaryIds = ['task-presentation-00', 'task-presentation-01', 'task-presentation-02', 'task-presentation-03', 'task-presentation-04'];
    expect(new Set(summaryState.snapshot?.taskSummary?.items.map(task => task.id))).toEqual(new Set(expectedSummaryIds));
    await expect(context.locator('.bot-context-task')).toHaveCount(5);
    expect(await context.locator('.bot-context-task strong').allTextContents()).toEqual(expectedSummaryIds.map(id => summaryState.snapshot!.taskSummary!.items.find(task => task.id === id)!.title));
    const clocks = await context.locator('.bot-context-task time').evaluateAll(items => items.map(item => ({ datetime: item.getAttribute('datetime'), label: item.textContent })));
    expect(clocks).toHaveLength(5); for (const clock of clocks) { expect(Number.isFinite(Date.parse(clock.datetime!))).toBe(true); expect(clock.label).toMatch(/开始|提交/u); }
    expect(summaryState.snapshot?.brainContexts?.['builtin-dafeiyu']?.lastRequest).toBeUndefined();
    await expect(context.getByRole('meter')).toHaveCount(0);
    await expect(context.locator('.bot-context-no-metrics')).toContainText('尚无本轮上下文用量记录');
    const hideContext = context.getByRole('button', { name: '收起聊天信息', exact: true });
    await expect(hideContext).toHaveAttribute('aria-expanded', 'true'); await expect(hideContext).not.toContainText('×');
    await capture('chat-summary-tasks-packaged-light.png');
    await hideContext.click(); await expect(context).toHaveCount(0);
    const expandContext = page.getByRole('button', { name: '展开聊天信息', exact: true });
    await expect(expandContext).toBeVisible(); await expect(expandContext).toHaveAttribute('aria-expanded', 'false');
    await capture('chat-summary-collapsed-packaged-light.png');
    await expandContext.click(); await expect(context).toBeVisible();
    await context.getByRole('button', { name: '任务中心', exact: true }).click(); await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill('已停止的隔夜任务');
    await expect(dialog.locator('[data-bot-task]')).toHaveAttribute('data-bot-task', 'task-presentation-18');
    await capture('tasks-workspace-v2-stop-light.png');
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill('整理项目目录 1');
    await dialog.locator('[data-task-row="task-presentation-00"]').click();
    await expect(dialog.locator('.bot-task-activity')).toContainText('shell');
    await capture('tasks-workspace-v2-light.png');
    await dialog.getByRole('button', { name: '跟进这个任务', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const followup = page.locator('.bot-task-followup'), composer = page.locator('.bot-composer textarea');
    await expect(followup).toContainText('跟进任务 · 整理项目目录 1'); await expect(followup).toContainText('大肥鱼');
    await expect(followup).not.toContainText('task-presentation-00'); await expect(composer).toBeFocused();
    await composer.fill('补充：只分析文件名，先不要修改文件。'); await capture('task-followup-composer-light.png');
    await followup.getByRole('button', { name: '取消任务跟进', exact: true }).click();
    await expect(followup).toHaveCount(0); await expect(composer).toHaveValue('补充：只分析文件名，先不要修改文件。');
    await composer.fill(''); // This fixture never sends or starts synthetic work.
    for (const [theme, width, height] of [['dark', 1440, 960], ['dark', 850, 720]] as const) {
      await application.evaluate(({ BrowserWindow }, size) => { const owned = BrowserWindow.getAllWindows()[0]!; owned.setMinimumSize(0, 0); owned.setSize(size.width, size.height); }, { width, height });
      await page.evaluate(theme => { localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme })); }, theme);
      await page.reload(); await page.locator('[data-application-module="companions"]').click(); await page.locator('.bot-chat-tasks').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(dialog).toBeVisible(); await expect(dialog.locator('[data-task-row]')).toHaveCount(6); await expect(dialog.locator('[data-bot-task]')).toHaveCount(1);
      const geometry = await dialog.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, columns: getComputedStyle(element).gridTemplateColumns, panel: element.getBoundingClientRect().toJSON(), footer: element.querySelector('.bot-task-actionbar')!.getBoundingClientRect().toJSON(), selected: element.querySelector('.bot-task-selected')!.getBoundingClientRect().toJSON() }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
      expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.panel.bottom); expect(geometry.footer.top).toBeGreaterThan(geometry.panel.top);
      await capture(width < 1000 ? 'tasks-workspace-v2-narrow-dark.png' : 'tasks-workspace-v2-dark.png');
    }
    // Real Main controls pause an undelivered fixture. Moving only renderer
    // Date forward and reloading simulates the next morning without making
    // native/model calls or waiting overnight. Both clocks must remain frozen.
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill('整理最近的笔记 4'); await expect(dialog.locator('[data-task-row]')).toHaveCount(1);
    await expect(dialog.locator('[data-bot-task]')).toHaveAttribute('data-bot-task', 'task-presentation-03');
    await dialog.getByRole('button', { name: '暂停任务', exact: true }).click(); await expect(dialog.locator('.bot-task-heading')).toContainText('已暂停');
    await expect(dialog.getByRole('button', { name: '继续任务', exact: true })).toBeVisible(); await expect(dialog.getByRole('button', { name: '移除记录', exact: true })).toHaveCount(0);
    const pausedClock = await dialog.locator('.bot-task-metrics b').textContent();
    const pausedReceipt = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'task.get', conversationId, taskId: 'task-presentation-03' }), conversationId);
    expect(pausedReceipt.task).toMatchObject({ status: 'paused', elapsedMs: 0 });
    expect(pausedReceipt.task?.timerStartedAt).toBeUndefined();
    await page.clock.setFixedTime(new Date(Date.now() + 18 * 3600000));
    await page.reload(); await page.locator('[data-application-module="companions"]').click(); await page.locator('.bot-chat-tasks').click();
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill('整理最近的笔记 4');
    await expect(dialog.locator('.bot-task-heading')).toContainText('已暂停');
    await expect(dialog.locator('.bot-task-metrics b')).toHaveText(pausedClock!);
    await expect(dialog.locator('[data-task-row="task-presentation-03"] .bot-task-row-activity')).toContainText(pausedClock!);
    await capture('tasks-workspace-v2-paused-dark.png');
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill('已停止的隔夜任务');
    await expect(dialog.locator('.bot-task-heading')).toContainText('已停止');
    await expect(dialog.locator('.bot-task-metrics b')).toHaveText('1 分 30 秒');
    await expect(dialog.locator('[data-task-row="task-presentation-18"] .bot-task-row-activity')).toContainText('1 分 30 秒');
    await expect(dialog.locator('.bot-task-stage-flow')).toHaveCount(0);
    await expect(dialog).not.toContainText('停止待核实');
    await capture('tasks-workspace-stopped-overnight-dark.png');
    await page.clock.setFixedTime(new Date());
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill('整理最近的笔记 4');
    await expect(dialog.locator('.bot-task-heading')).toContainText('已暂停');
    await dialog.getByRole('button', { name: '停止任务', exact: true }).click(); await expect(dialog.locator('.bot-task-heading')).toContainText('已停止');
    await expect(dialog.getByRole('button', { name: '继续任务', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '移除记录', exact: true })).toBeVisible();
    await expect(dialog.locator('.bot-task-metrics b')).toHaveText(pausedClock!);
    const stoppedReceipt = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'task.get', conversationId, taskId: 'task-presentation-03' }), conversationId);
    expect(stoppedReceipt.task).toMatchObject({ status: 'cancelled', elapsedMs: 0 });
    expect(stoppedReceipt.task?.timerStartedAt).toBeUndefined();
    const clockEvidence = { simulatedRendererHoursLater: 18, overnightStoppedHoursAgo: 18, overnightExecutionMs: 90000,
      paused: { label: pausedClock, status: pausedReceipt.task?.status, elapsedMs: pausedReceipt.task?.elapsedMs },
      stopped: { status: stoppedReceipt.task?.status, elapsedMs: stoppedReceipt.task?.elapsedMs }, rowAndDetailAgree: true, reloadPreservesFrozenTimers: true };
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill(''); await expect(dialog.locator('[data-task-row]')).toHaveCount(6);
    await dialog.getByRole('button', { name: '管理任务队列', exact: true }).click(); await dialog.getByRole('menuitem', { name: '清理排队', exact: true }).click();
    const confirmation = page.getByRole('alertdialog'); await expect(confirmation).toContainText('10 项排队任务'); await confirmation.getByRole('button', { name: '确认', exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect.poll(async () => {
      const state = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'task.list', conversationId, filter: 'all', page: 0, limit: 30 }), conversationId);
      return state.taskPage?.items.filter(task => task.status === 'cancelled').length;
    }).toBe(12);
    const result = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'task.list', conversationId, filter: 'all', page: 0, limit: 30 }), conversationId);
    expect(result.ok).toBe(true); expect(result.taskPage?.items.filter(task => task.status === 'cancelled')).toHaveLength(12);
    expect(result.taskPage?.items.filter(task => task.status === 'succeeded')).toHaveLength(5); expect(result.taskPage?.activeCount).toBe(2);
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill('检索项目说明 18'); await expect(dialog.locator('[data-task-row]')).toHaveCount(1);
    await expect(dialog.locator('[data-bot-task]')).toHaveAttribute('data-bot-task', 'task-presentation-17');
    await dialog.getByRole('button', { name: '移除记录', exact: true }).click(); await expect(dialog.locator('[data-task-row]')).toHaveCount(0);
    const removed = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'task.get', conversationId, taskId: 'task-presentation-17' }), conversationId);
    expect(removed).toMatchObject({ ok: true, taskRemoved: true });
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill(''); await expect(dialog.locator('[data-task-row]')).toHaveCount(6);
    await dialog.getByRole('button', { name: '管理任务队列', exact: true }).click(); await dialog.getByRole('menuitem', { name: '清理已结束', exact: true }).click();
    await expect(confirmation).toContainText('16 项已结束记录'); await confirmation.getByRole('button', { name: '确认', exact: true }).click();
    await expect(confirmation).toBeHidden(); await expect(dialog.locator('[data-task-row]')).toHaveCount(2);
    const cleared = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'task.list', conversationId, filter: 'all', page: 0, limit: 30 }), conversationId);
    expect(cleared.taskPage).toMatchObject({ total: 2, activeCount: 2, finishedCount: 0 });
    const oldNotice = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'history.search', conversationId, query: 'MASSIVE', limit: 20 }), conversationId);
    const noticeId = oldNotice.history?.items.find(item => item.taskNotice?.taskId === 'task-presentation-17')?.id; expect(noticeId).toBeTruthy();
    await dialog.getByRole('button', { name: '关闭任务', exact: true }).click(); await expect(dialog).toBeHidden();
    const linkDiagnostic = await page.evaluate(async ({ conversationId, noticeId }) => {
      const state = await (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId });
      const notice = state.snapshot?.messages.find(message => message.id === noticeId), reply = state.snapshot?.messages.find(message => message.id === notice?.taskNotice?.replyMessageId);
      return { notice, reply, messageCount: state.snapshot?.messages.length, noticeInCurrentDom: !!document.querySelector(`[data-bot-message="${noticeId}"]`), visibleReceipts: [...document.querySelectorAll<HTMLElement>('.bot-task-notice')].map(element => ({ id: element.dataset.botMessage, text: element.textContent })) };
    }, { conversationId, noticeId });
    await writeFile(testInfo.outputPath('removed-notice-link-diagnostic.json'), JSON.stringify(linkDiagnostic, null, 2));
    // Locate the retained original through the same history interface a user
    // uses. A bounded chat window need not still render an older receipt.
    await page.getByRole('button', { name: '聊天记录', exact: true }).click();
    const history = page.getByRole('dialog', { name: '聊天记录', exact: true }); await history.getByRole('searchbox', { name: '搜索聊天记录', exact: true }).fill('MASSIVE');
    await history.getByRole('button', { name: /MASSIVE EXECUTOR RECEIPT/u }).click(); await expect(history).toBeHidden();
    await page.locator(`[data-bot-message="${noticeId}"] button`).click();
    await expect(dialog.locator('.bot-tasks-blank')).toContainText('该任务记录已移除'); await expect(dialog.locator('[role="alert"]')).toHaveCount(0);
    await dialog.getByRole('button', { name: '返回任务列表', exact: true }).click(); await expect(dialog.locator('[data-bot-task]')).toHaveCount(1);
    await dialog.getByRole('button', { name: '关闭任务', exact: true }).click();
    const groupSeed = await application.evaluate(({ app }, input) => {
      if (app.getPath('userData') !== input.profile) throw Error('Unexpected group task fixture profile');
      const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      return (require(input.fixture) as { seedGroupTaskWorkspace: typeof seedGroupTaskWorkspace }).seedGroupTaskWorkspace(input.profile);
    }, { profile, fixture: path.join(fixtureDirectory, 'seed.cjs') });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1800, 1000));
    await page.evaluate(() => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'light' })));
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    const openGroupTasks = async () => {
      await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: groupSeed.title }).click();
      await page.locator('.bot-chat-tasks').click(); await expect(dialog).toBeVisible();
    };
    await openGroupTasks();
    await expect(dialog.locator('.bot-tasks-header h3')).toHaveText('群任务工作台');
    await expect(dialog.locator('.bot-tasks-pagination')).toContainText('共 16 项');
    await expect(dialog.locator('[data-task-row]')).toHaveCount(6);
    expect(new Set(await dialog.locator('[data-task-row] .bot-task-owner').evaluateAll(items => items.map(item => item.getAttribute('data-task-owner'))))).toEqual(new Set(groupSeed.owners));
    await expect(dialog.locator('.bot-task-heading .bot-task-owner')).toBeVisible();
    await capture('group-tasks-owners-packaged-light.png');
    const ownerSelect = dialog.getByRole('combobox', { name: '筛选负责伙伴', exact: true });
    await ownerSelect.selectOption('gpt');
    await expect(dialog.locator('.bot-tasks-pagination')).toContainText('共 8 项');
    await expect(dialog.locator('[data-task-row]')).toHaveCount(6);
    expect(await dialog.locator('[data-task-row] .bot-task-owner').evaluateAll(items => items.every(item => item.getAttribute('data-task-owner') === 'gpt' && item.textContent?.includes('GPT')))).toBe(true);
    await expect(dialog.locator('.bot-task-heading .bot-task-owner')).toHaveAttribute('data-task-owner', 'gpt');
    await dialog.getByRole('button', { name: '下一页任务' }).click(); await expect(dialog.locator('[data-task-row]')).toHaveCount(2); await expect(dialog.locator('.bot-tasks-pagination')).toContainText('2 / 2');
    await dialog.getByRole('button', { name: '关闭任务' }).click();
    await page.evaluate(() => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'dark' })));
    await page.reload(); await page.locator('[data-application-module="companions"]').click(); await openGroupTasks(); await ownerSelect.selectOption('gpt');
    await expect(dialog.locator('.bot-tasks-pagination')).toContainText('共 8 项');
    await capture('group-tasks-filtered-owner-packaged-dark.png');
    await dialog.getByRole('textbox', { name: '搜索任务' }).fill('group-owner-1-7'); await expect(dialog.locator('[data-task-row]')).toHaveCount(1);
    await dialog.getByRole('button', { name: '管理任务队列' }).click(); await dialog.getByRole('menuitem', { name: '清理该伙伴排队', exact: true }).click();
    await expect(confirmation).toContainText('本群 · GPT'); await expect(confirmation).toContainText('5 项排队任务'); await expect(confirmation).toContainText('关键词与状态筛选不改变');
    await confirmation.getByRole('button', { name: '确认', exact: true }).click(); await expect(confirmation).toBeHidden();
    const inspectGroupScope = () => page.evaluate(async data => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      const owner = await api.request({ type: 'task.list', conversationId: data.conversationId, companionId: 'gpt', filter: 'all', page: 0, limit: 30 });
      const other = await api.request({ type: 'task.list', conversationId: data.conversationId, companionId: 'builtin-dafeiyu', filter: 'all', page: 0, limit: 30 });
      const privateRoom = await api.request({ type: 'task.list', conversationId: data.privateConversationId, companionId: 'gpt', filter: 'all', page: 0, limit: 30 });
      const foreignDetail = await api.request({ type: 'task.get', conversationId: data.conversationId, taskId: data.privateTaskId });
      return { owner, other, privateRoom, foreignDetail };
    }, groupSeed);
    await expect.poll(async () => (await inspectGroupScope()).owner.taskPage?.finishedCount).toBe(8);
    const stoppedOwnerScope = await inspectGroupScope();
    expect(stoppedOwnerScope.other.taskPage).toMatchObject({ total: 8, activeCount: 5, queuedCount: 5, finishedCount: 3 });
    expect(stoppedOwnerScope.privateRoom.taskPage).toMatchObject({ total: 6, activeCount: 5, queuedCount: 5, finishedCount: 1 });
    expect(stoppedOwnerScope.foreignDetail.ok).toBe(false);
    await dialog.getByRole('button', { name: '管理任务队列' }).click(); await dialog.getByRole('menuitem', { name: '清理该伙伴已结束', exact: true }).click();
    await expect(confirmation).toContainText('本群 · GPT'); await expect(confirmation).toContainText('8 项已结束记录');
    await confirmation.getByRole('button', { name: '确认', exact: true }).click(); await expect(confirmation).toBeHidden();
    await expect(dialog.locator('[data-task-row]')).toHaveCount(0);
    const clearedOwnerScope = await inspectGroupScope();
    expect(clearedOwnerScope.owner.taskPage).toMatchObject({ total: 0, activeCount: 0, finishedCount: 0 });
    expect(clearedOwnerScope.other.taskPage).toMatchObject({ total: 8, activeCount: 5, finishedCount: 3 });
    expect(clearedOwnerScope.privateRoom.taskPage).toMatchObject({ total: 6, activeCount: 5, finishedCount: 1 });
    await dialog.getByRole('button', { name: '关闭任务', exact: true }).click();
    const realTaskUpdateTransitions = [];
    for (const [index, theme] of ['light', 'dark'].entries()) {
      // Reload establishes the session's unread baseline. Every new update
      // below comes from actual Main-service cancellation, not DOM fixtures.
      await page.evaluate(theme => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme })), theme);
      await page.reload(); await page.locator('[data-application-module="companions"]').click();
      await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: groupSeed.title }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const taskButton = page.locator('.bot-chat-tasks'), updates = taskButton.locator('.bot-task-updates');
      await expect(updates).toHaveCount(0); await expect(taskButton).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('.bot-presence-feedback, [data-presence-event]')).toHaveCount(0);
      const transcriptBeforeUpdates = await page.locator('.bot-transcript').boundingBox();
      const transition = await page.evaluate(async input => {
        const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
        const before = await api.request({ type: 'state', conversationId: input.conversationId });
        const previous = before.snapshot?.presence;
        const results = await Promise.all(input.tasks.map(task => api.request({ type: 'task.control', operation: 'cancel', conversationId: task.conversationId,
          taskId: task.taskId, requestId: `native-unread-${input.theme}-${task.taskId}` })));
        const after = await api.request({ type: 'state', conversationId: input.conversationId });
        const completed = input.tasks.map((task, offset) => ({ ...task, result: results[offset], previous: previous?.[task.companionId]?.lastEvent,
          event: after.snapshot?.presence?.[task.companionId]?.events?.find(event => event.taskId === task.taskId && event.status === 'cancelled') }));
        return { completed, taskCount: after.snapshot?.tasks.filter(task => task.status === 'cancelled').length };
      }, { conversationId: groupSeed.conversationId, theme, tasks: [
        { conversationId: groupSeed.conversationId, companionId: 'builtin-dafeiyu', taskId: `group-owner-0-${index * 2}` },
        { conversationId: groupSeed.conversationId, companionId: 'builtin-dafeiyu', taskId: `group-owner-0-${index * 2 + 1}` },
        { conversationId: groupSeed.privateConversationId, companionId: 'gpt', taskId: `private-owner-${index}` },
      ] });
      for (const item of transition.completed) {
        expect(item.result?.ok).toBe(true);
        expect(item.event).toMatchObject({ taskId: item.taskId, conversationId: item.conversationId, kind: 'task-completed', status: 'cancelled' });
        expect(item.event!.sequence).toBeGreaterThan(item.previous?.sequence ?? 0);
      }
      await expect(updates).toHaveCount(1); await expect(updates).toHaveAttribute('data-count', '2'); await expect(updates).toHaveText('新动态 2');
      await expect(page.locator('.bot-presence-feedback, [data-presence-event]')).toHaveCount(0);
      expect(await page.locator('.bot-transcript').boundingBox()).toEqual(transcriptBeforeUpdates);
      await capture(`task-updates-packaged-${theme}.png`);
      await taskButton.click(); await expect(dialog).toBeVisible(); await expect(taskButton).toHaveAttribute('aria-pressed', 'true'); await expect(updates).toHaveCount(0);
      await dialog.getByRole('button', { name: '关闭任务', exact: true }).click();
      await expect(taskButton).toHaveAttribute('aria-pressed', 'false'); await expect(updates).toHaveCount(0);
      // Reading the group cannot consume a different room's pending update.
      // Returning through real conversation navigation also refreshes snapshots
      // and proves that the just-read group events do not reappear.
      await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: 'GPT' }).click(); await expect(page.locator('.bot-chat-header h2')).toHaveText('GPT');
      await expect(updates).toHaveAttribute('data-count', '1');
      await taskButton.click(); await expect(dialog).toBeVisible(); await expect(updates).toHaveCount(0); await dialog.getByRole('button', { name: '关闭任务', exact: true }).click();
      await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: groupSeed.title }).click(); await expect(page.locator('.bot-chat-header h2')).toHaveText(groupSeed.title);
      await expect(updates).toHaveCount(0); await expect(page.locator('.bot-presence-feedback, [data-presence-event]')).toHaveCount(0);
      realTaskUpdateTransitions.push({ ...transition, theme, aggregatedGroupCount: 2, independentPrivateCount: 1, readClearedOnlyCurrentRoom: true, automaticOverlay: false });
    }
    const asarAfter = identity.packaged ? await sha256(identity.appPath) : undefined; expect(asarAfter).toBe(asarBefore);
    const taskEvidence = { identity: { ...identity, asarBefore, asarAfter }, seeded, inlineMetadata, clockEvidence, realTaskUpdateTransitions, summary: summaryState.snapshot?.taskSummary, summaryClocks: clocks, groupSeed, stoppedOwnerScope, clearedOwnerScope, groupOwnerServerPagingAndIsolation: true, noSyntheticBrainUsage: true, queueResult: result.taskPage, clearedResult: cleared.taskPage, removed, receiptCompact: true, actualIpc: true, syntheticProgress: true, localUndeliveredPauseOnly: true };
    await writeFile(testInfo.outputPath('task-workspace-evidence.json'), JSON.stringify(taskEvidence, null, 2));
    await writeFile(path.join(evidence, 'task-stop-clock-evidence.json'), JSON.stringify(taskEvidence, null, 2));
  } finally { await application.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

// eslint-disable-next-line no-empty-pattern -- Electron owns the page.
test('retains task activity after natural replies and later messages in private and group history', async ({}, testInfo) => {
  test.setTimeout(180000);
  testInfo.annotations.push({ type: 'isolated-store-fixture', description: 'Durable BotStore task notices, settled natural replies, paged Main IPC and validated changed events. No DSH execution or paid model request.' });
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-task-activity-history-'));
  const fixtureDirectory = testInfo.outputPath('history-fixture'); await mkdir(fixtureDirectory, { recursive: true });
  await build({ configFile: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-task-workspace-fixture.ts', target: 'node24', outDir: fixtureDirectory, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'seed.cjs' } } } });
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  const evidence = path.resolve('artifacts/task-activity-history'); await mkdir(evidence, { recursive: true });
  try {
    await preparePackagedCompanionLaunch(application, profile);
    const page = await application.firstWindow();
    const identity = await application.evaluate(({ app, BrowserWindow }, expectedProfile) => {
      if (app.getPath('userData') !== expectedProfile) throw Error('Activity history fixtures must use their isolated profile.');
      const window = BrowserWindow.getAllWindows()[0]!;
      if (!window.webContents.isOffscreen()) throw Error('Task activity screenshots require offscreen rendering.');
      window.on('show', () => window.hide()); window.hide(); window.setMinimumSize(0, 0); window.setSize(1440, 960); window.webContents.setBackgroundThrottling(false);
      const frames = { paints: 0 }; Reflect.set(globalThis, '__taskHistoryFrames', frames);
      window.webContents.on('paint', () => { frames.paints++; });
      return { packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData') };
    }, profile);
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) { expect(identity.packaged).toBe(true); expect(identity.appPath).toMatch(/app\.asar$/u); }
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    const directConversationId = await page.evaluate(async () => {
      const response = await (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state' });
      return response.snapshot!.conversations.find(room => room.kind === 'direct' && room.memberIds.includes('builtin-dafeiyu'))!.id;
    });
    const seeded = await application.evaluate(({ app }, input) => {
      if (app.getPath('userData') !== input.profile) throw Error('Unexpected task activity profile.');
      const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      return (require(input.fixture) as { seedTaskActivityHistory: typeof seedTaskActivityHistory }).seedTaskActivityHistory(input.profile, input.conversationId);
    }, { profile, conversationId: directConversationId, fixture: path.join(fixtureDirectory, 'seed.cjs') });
    const capture = async (filename: string) => {
      await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
      const previous = await application.evaluate(({ BrowserWindow }) => { const count = (Reflect.get(globalThis, '__taskHistoryFrames') as { paints: number }).paints; BrowserWindow.getAllWindows()[0]!.webContents.invalidate(); return count; });
      await expect.poll(() => application.evaluate(() => (Reflect.get(globalThis, '__taskHistoryFrames') as { paints: number }).paints)).toBeGreaterThan(previous);
      const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const file = testInfo.outputPath(filename); await writeFile(file, Buffer.from(png, 'base64')); await copyFile(file, path.join(evidence, filename));
      await testInfo.attach(filename, { path: file, contentType: 'image/png' });
    };
    const measurements: unknown[] = [];
    for (const [theme, preset, width, height] of [['light', 'worldlinebox', 1440, 960], ['dark', 'worldlinebox', 850, 720], ['light', 'shuimo-danqing', 1440, 960]] as const) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height), { width, height });
      await page.evaluate(({ theme, preset }) => {
        localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme }));
        localStorage.setItem('worldlinebox.theme-profile.v3', JSON.stringify({ version: 3, preset, overrides: {} }));
      }, { theme, preset });
      await page.reload(); await page.locator('[data-application-module="companions"]').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      if (preset === 'shuimo-danqing') {
        await expect(page.locator('html')).toHaveAttribute('data-bg-main-panel', 'on');
        await expect.poll(() => page.locator('.app-animated-background-video').evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
      }
      for (const room of [
        { conversationId: directConversationId, title: '大肥鱼', tasks: [seeded.direct], group: false },
        { conversationId: seeded.group.conversationId, title: seeded.group.title, tasks: seeded.group.tasks, group: true },
      ]) {
        await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: room.title }).click();
        await expect(page.locator('.bot-chat-header h2')).toHaveText(room.title);
        await expect(page.locator('.bot-task-notice')).toHaveCount(room.tasks.length);
        for (const task of room.tasks) {
          const notice = page.locator(`[data-bot-message="${task.noticeId}"]`);
          await expect(notice).toHaveAttribute('data-task-id', task.taskId);
          await expect(notice).toHaveAttribute('data-task-owner', task.companionId);
          await expect(notice.locator('.bot-task-notice-meta strong')).toHaveText(task.companionId === 'gpt' ? 'GPT' : '大肥鱼');
          await expect(notice.locator('.bot-task-notice-footer')).toContainText('查看详情');
          await expect(page.locator(`[data-bot-message="${task.replyId}"]`)).toContainText(task.replyText);
          await expect(page.locator('.bot-transcript')).not.toContainText('HUMAN_AUTHORED_RAW_EXECUTOR_RESULT');
          const layout = await notice.evaluate(element => {
            const card = element.querySelector<HTMLElement>('.bot-task-notice-open')!, title = element.querySelector<HTMLElement>('.bot-task-notice-title')!, badge = element.querySelector<HTMLElement>('.bot-task-notice-state')!;
            const rect = card.getBoundingClientRect(), transcript = element.closest('.bot-transcript')!.getBoundingClientRect(), titleRect = title.getBoundingClientRect(), badgeRect = badge.getBoundingClientRect();
            return { width: element.getBoundingClientRect().width, height: rect.height, overflow: card.scrollWidth > card.clientWidth + 1,
              left: rect.left, right: rect.right, transcriptLeft: transcript.left, transcriptRight: transcript.right,
              titleHeight: titleRect.height, lineHeight: Number.parseFloat(getComputedStyle(title).lineHeight), titleRight: titleRect.right, titleBottom: titleRect.bottom, badgeLeft: badgeRect.left, badgeTop: badgeRect.top,
              background: getComputedStyle(card).backgroundColor, state: element.getAttribute('data-task-state'), badge: badge.textContent };
          });
          expect(layout.width).toBeLessThanOrEqual(482); expect(layout.height).toBeLessThan(170); expect(layout.overflow).toBe(false);
          expect(layout.left).toBeGreaterThanOrEqual(layout.transcriptLeft); expect(layout.right).toBeLessThanOrEqual(layout.transcriptRight);
          expect(layout.titleHeight).toBeLessThanOrEqual(layout.lineHeight * 2 + 1);
          expect(layout.titleRight <= layout.badgeLeft || layout.titleBottom <= layout.badgeTop).toBe(true);
          measurements.push({ theme, preset, viewportWidth: width, group: room.group, taskId: task.taskId, ...layout });
        }
        const state = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId }), room.conversationId);
        if (!room.group) expect(state.snapshot?.tasks.some(task => task.id === seeded.direct.taskId)).toBe(false);
        for (const task of room.tasks) {
          const notice = state.snapshot?.messages.find(message => message.id === task.noticeId);
          expect(notice?.taskNotice).toMatchObject({ taskId: task.taskId, companionId: task.companionId, title: task.title, replyMessageId: task.replyId });
          expect(state.snapshot?.messages.find(message => message.id === task.replyId)?.status).toBe('sent');
        }
        await page.locator('.bot-transcript').evaluate(element => { element.scrollTop = element.scrollHeight; });
        await capture(`task-history-${room.group ? 'group' : 'direct'}-${preset}-${theme}${width < 1000 ? '-narrow' : ''}.png`);
        // Every card opens its exact task, even the historical record outside
        // the bounded current-task snapshot and either owner inside a group.
        for (const task of room.tasks) {
          const button = page.locator(`[data-bot-message="${task.noticeId}"] button`);
          await button.focus(); await button.press('Enter');
          const dialog = page.getByRole('dialog', { name: '任务工作台', exact: true });
          await expect(dialog.locator('.bot-tasks-header h3')).toHaveText(room.group ? '群任务工作台' : '任务工作台');
          await expect(dialog.locator('[data-bot-task]')).toHaveAttribute('data-bot-task', task.taskId);
          await expect(dialog.locator('.bot-task-heading h4')).toHaveText(task.title);
          await dialog.getByRole('button', { name: '关闭任务', exact: true }).click(); await expect(dialog).toBeHidden();
        }
      }
    }
    const laterMessages: unknown[] = [];
    for (const room of [{ id: directConversationId, title: '大肥鱼', tasks: [seeded.direct] }, { id: seeded.group.conversationId, title: seeded.group.title, tasks: seeded.group.tasks }]) {
      await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: room.title }).click();
      const messageId = await application.evaluate(({ app, BrowserWindow }, input) => {
        if (app.getPath('userData') !== input.profile) throw Error('Unexpected task history append profile.');
        const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
        const messageId = (require(input.fixture) as { appendTaskActivityConversationMessage: typeof appendTaskActivityConversationMessage }).appendTaskActivityConversationMessage(input.profile, input.conversationId);
        BrowserWindow.getAllWindows()[0]!.webContents.send(input.channel, { type: 'changed', conversationId: input.conversationId });
        return messageId;
      }, { profile, fixture: path.join(fixtureDirectory, 'seed.cjs'), conversationId: room.id, channel: BOT_EVENT_CHANNEL });
      await expect(page.locator(`[data-bot-message="${messageId}"]`)).toContainText('后续消息');
      for (const task of room.tasks) await expect(page.locator(`[data-bot-message="${task.noticeId}"]`)).toBeVisible();
      await page.reload(); await page.locator('[data-application-module="companions"]').click();
      await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: room.title }).click();
      await expect(page.locator(`[data-bot-message="${messageId}"]`)).toContainText('后续消息');
      for (const task of room.tasks) await expect(page.locator(`[data-bot-message="${task.noticeId}"]`)).toBeVisible();
      laterMessages.push({ conversationId: room.id, messageId, retainedNoticeIds: room.tasks.map(task => task.noticeId), survivedReload: true });
    }
    await writeFile(path.join(evidence, 'task-history-evidence.json'), JSON.stringify({ identity, seeded, measurements, laterMessages, actualIpc: true, syntheticStoreData: true, rawExecutorTextHidden: true }, null, 2));
  } finally { await application.close(); removeCompanionTestDirectory(profile); }
});
