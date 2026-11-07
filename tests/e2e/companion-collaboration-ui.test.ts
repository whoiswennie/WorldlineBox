import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { BOT_EVENT_CHANNEL, type WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { seedCollaborationUi, updateCollaborationUi, appendCollaborationUiMessage } from '../fixtures/companion-collaboration-ui-fixture';
import { electronLaunchEnv, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Electron owns its renderer page.
test('renders event-driven collaboration progress and scoped controls in group/private chat and preserves records after restart', async ({}, testInfo) => {
  test.setTimeout(180000);
  testInfo.annotations.push({ type: 'isolated-presentation-fixture', description: 'Real Electron/Main IPC, persisted task fixtures, validated production changed events, real pause/stop controls and real composer submission. Model reasoning/DSH execution is intentionally absent; real collaboration is tested separately.' });
  const prefix = 'wlb-collaboration-ui-', profile = await mkdtemp(path.join(tmpdir(), prefix));
  const fixtureDir = testInfo.outputPath('fixture'); await mkdir(fixtureDir, { recursive: true });
  const fixture = path.join(fixtureDir, 'collaboration.cjs');
  await build({ configFile: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/companion-collaboration-ui-fixture.ts', target: 'node24', outDir: fixtureDir, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: path.basename(fixture) } } } });
  const output = path.resolve('artifacts/companion-collaboration-ui'); await mkdir(output, { recursive: true });
  let application: ElectronApplication | undefined;
  const launch = async () => {
    const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
    await preparePackagedCompanionLaunch(app, profile);
    await app.evaluate(({ app, BrowserWindow }, expected) => {
      if (app.getPath('userData') !== expected) throw Error('Collaboration UI must use its own profile.');
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isOffscreen()) throw Error('Collaboration UI acceptance requires offscreen rendering.');
        window.on('show', () => window.hide()); window.hide(); window.setMinimumSize(0, 0); window.setSize(1440, 960); window.webContents.setBackgroundThrottling(false);
      }
    }, profile);
    return app;
  };
  const capture = async (app: ElectronApplication, name: string) => {
    const page = await app.firstWindow(); await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    const file = testInfo.outputPath(name); await writeFile(file, Buffer.from(png, 'base64')); await copyFile(file, path.join(output, name)); await testInfo.attach(name, { path: file, contentType: 'image/png' });
  };
  const bindingFor = async (conversationId: string, content: string) => application!.evaluate(({ app }, input) => {
    if (app.getPath('userData') !== input.profile) throw Error('Unexpected collaboration followup profile.');
    const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
    const sqlite = require('better-sqlite3') as new (filename: string, options: { readonly: boolean }) => { prepare(sql: string): { all(...args: string[]): unknown[] }; close(): void };
    const store = new sqlite(process.getBuiltinModule('node:path').join(input.profile, 'companion-bot-v2', 'bot.sqlite'), { readonly: true });
    try { return store.prepare('SELECT companion_id,conversation_id,payload_json FROM bot_inbox WHERE source_record_id=(SELECT id FROM bot_messages WHERE conversation_id=? AND content=? ORDER BY sequence DESC LIMIT 1)').all(input.conversationId, input.content) as { companion_id: string; conversation_id: string; payload_json: string }[]; }
    finally { store.close(); }
  }, { profile, conversationId, content });
  try {
    application = await launch(); const page = await application.firstWindow();
    await page.locator('[data-application-module="companions"]').click(); await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    const seed = await application.evaluate(({ app }, input) => {
      if (app.getPath('userData') !== input.profile) throw Error('Unexpected collaboration profile.');
      const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      return (require(input.fixture) as { seedCollaborationUi: typeof seedCollaborationUi }).seedCollaborationUi(input.profile);
    }, { profile, fixture });
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: seed.group.title }).click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText(seed.group.title);
    const seededTasks = [...seed.group.tasks, seed.direct.task, seed.privateGpt.task];
    // A real stop produces a second historical receipt for the same task. Keep
    // checking the original receipt to prove it survives those later events.
    const notice = (id: string) => page.locator(`.bot-task-notice[data-bot-message="${seededTasks.find(task => task.taskId === id)!.noticeId}"]`);
    for (const task of seed.group.tasks) {
      await expect(notice(task.taskId)).toHaveAttribute('data-task-owner', task.companionId);
      await expect(notice(task.taskId)).toHaveAttribute('data-task-state', 'queued');
      await expect(notice(task.taskId)).toContainText(task.title);
    }
    await expect(page.locator('.bot-transcript')).not.toContainText('RAW_FIXTURE_TRANSPORT_NOT_CHAT');
    const update = async (taskId: string, status: Parameters<typeof updateCollaborationUi>[2], phase: string, toolName?: string) => application!.evaluate(({ app, BrowserWindow }, input) => {
      if (app.getPath('userData') !== input.profile) throw Error('Unexpected collaboration update profile.');
      const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      const result = (require(input.fixture) as { updateCollaborationUi: typeof updateCollaborationUi }).updateCollaborationUi(input.profile, input.taskId, input.status, input.phase, input.toolName);
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(input.channel, { type: 'changed', conversationId: result.conversationId });
      return result;
    }, { profile, fixture, taskId, status, phase, toolName, channel: BOT_EVENT_CHANNEL });
    const finance = seed.group.tasks[0]!, audit = seed.group.tasks[1]!, stopping = seed.group.tasks[2]!;
    const transitions = [await update(finance.taskId, 'running', 'using-tool', 'read_file'), await update(audit.taskId, 'running', 'using-tool', 'python')];
    await expect(notice(finance.taskId)).toHaveAttribute('data-task-state', 'running'); await expect(notice(audit.taskId)).toHaveAttribute('data-task-state', 'running');
    await page.locator('.bot-chat-tasks').click();
    const dialog = page.getByRole('dialog', { name: '任务工作台', exact: true });
    await expect(dialog.locator('.bot-tasks-header h3')).toHaveText('群任务工作台');
    await expect(dialog.locator('[data-task-row]')).toHaveCount(3);
    await dialog.locator(`[data-task-row="${finance.taskId}"]`).click();
    await expect(dialog.locator('[data-bot-task]')).toHaveAttribute('data-bot-task', finance.taskId);
    await expect(dialog.locator('.bot-task-activity')).toContainText('read_file');
    transitions.push(await update(finance.taskId, 'running', 'using-tool', 'python'));
    await expect(dialog.locator('.bot-task-activity')).toContainText('python');
    await dialog.getByRole('tab', { name: /执行记录/ }).click(); await expect(dialog.locator('.bot-task-event-list')).toContainText('read_file'); await expect(dialog.locator('.bot-task-event-list')).toContainText('python');
    await dialog.getByRole('tab', { name: '概览', exact: true }).click();
    await capture(application, 'collaboration-group-live-progress.png');
    const layoutChecks = [];
    for (const size of [{ width: 1024, height: 768 }, { width: 1440, height: 960 }]) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height), size);
      await expect(dialog.locator('.bot-task-actionbar')).toBeVisible();
      const layout = await dialog.evaluate(element => {
        const box = (selector: string) => { const r = element.querySelector(selector)!.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; };
        const r = element.getBoundingClientRect(); return { viewport: { width: innerWidth, height: innerHeight }, panel: { x: r.x, y: r.y, right: r.right, bottom: r.bottom }, content: box('.bot-task-content'), actions: box('.bot-task-actionbar'), heading: box('.bot-task-heading') };
      });
      expect(layout.panel.x).toBeGreaterThanOrEqual(0); expect(layout.panel.y).toBeGreaterThanOrEqual(0);
      expect(layout.panel.right).toBeLessThanOrEqual(layout.viewport.width); expect(layout.panel.bottom).toBeLessThanOrEqual(layout.viewport.height);
      expect(layout.content.bottom).toBeLessThanOrEqual(layout.actions.y + 1); expect(layout.heading.bottom).toBeLessThanOrEqual(layout.content.y);
      layoutChecks.push({ size, ...layout, noFooterOverlap: true });
      if (size.width === 1024) await capture(application, 'collaboration-task-panel-1024.png');
    }
    await dialog.getByRole('button', { name: '暂停任务', exact: true }).click();
    await expect(dialog.locator('[data-bot-task]')).toHaveAttribute('data-task-state', 'paused');
    const pausedClock = await dialog.locator('.bot-task-metrics b').first().textContent();
    await page.waitForTimeout(1500); expect(await dialog.locator('.bot-task-metrics b').first().textContent()).toBe(pausedClock);
    await expect(dialog).not.toContainText('等待停止确认');
    await dialog.locator(`[data-task-row="${stopping.taskId}"]`).click();
    await dialog.getByRole('button', { name: '停止任务', exact: true }).click();
    await expect(dialog.locator('[data-bot-task]')).toHaveAttribute('data-task-state', 'cancelled');
    await expect(dialog.locator('.bot-task-heading')).toContainText('已停止');
    const ownerFilter = dialog.getByRole('combobox', { name: '筛选负责伙伴', exact: true }); await ownerFilter.selectOption('gpt');
    await expect(dialog.locator('[data-task-row]')).toHaveCount(2);
    expect(await dialog.locator('[data-task-row] .bot-task-owner').evaluateAll(items => items.every(item => item.getAttribute('data-task-owner') === 'gpt'))).toBe(true);
    await dialog.getByRole('button', { name: '关闭任务', exact: true }).click();
    transitions.push(await update(audit.taskId, 'succeeded', 'succeeded'));
    await expect(notice(audit.taskId)).toHaveAttribute('data-task-state', 'succeeded'); await expect(notice(finance.taskId)).toHaveAttribute('data-task-state', 'paused');
    await expect(notice(stopping.taskId)).toHaveAttribute('data-task-state', 'cancelled');
    const later = await application.evaluate(({ app, BrowserWindow }, input) => {
      if (app.getPath('userData') !== input.profile) throw Error('Unexpected collaboration history profile.');
      const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      const messageId = (require(input.fixture) as { appendCollaborationUiMessage: typeof appendCollaborationUiMessage }).appendCollaborationUiMessage(input.profile, input.conversationId);
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(input.channel, { type: 'changed', conversationId: input.conversationId }); return messageId;
    }, { profile, fixture, conversationId: seed.group.id, channel: BOT_EVENT_CHANNEL });
    await expect(page.locator(`[data-bot-message="${later}"]`)).toContainText('后续消息');
    for (const task of seed.group.tasks) await expect(notice(task.taskId)).toBeVisible();
    await capture(application, 'collaboration-group-terminal-history.png');
    await notice(audit.taskId).getByRole('button').click();
    await dialog.getByRole('button', { name: '继续这个任务', exact: true }).click();
    await expect(page.locator('.bot-task-followup')).toContainText('独立核对统计口径'); await expect(page.locator('.bot-task-followup')).toContainText('GPT');
    const groupIntervention = '补充给 GPT 的核对任务：只解释统计口径，不修改大肥鱼负责的金额核算。';
    await page.locator('.bot-composer textarea').fill(groupIntervention); await capture(application, 'collaboration-group-owner-followup-composer.png');
    await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
    await expect(page.locator('.bot-message-text').filter({ hasText: groupIntervention })).toBeVisible();
    const groupBindings = await bindingFor(seed.group.id, groupIntervention);
    expect(groupBindings).toHaveLength(1); expect(groupBindings[0]!.companion_id).toBe('gpt'); expect(groupBindings[0]!.conversation_id).toBe(seed.group.id);
    expect(JSON.parse(groupBindings[0]!.payload_json).taskFollowup).toEqual({ taskId: audit.taskId });
    // Following a completed task legitimately queues its continuation. This
    // model-free fixture restores a completed presentation state only after
    // verifying the real submission; business continuation is tested elsewhere.
    await expect.poll(async () => (await page.evaluate(async conversationId => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      const state = await api.request({ type: 'state', conversationId }); return state.snapshot?.messages.some(message => message.status === 'running');
    }, seed.group.id)) ?? false).toBe(false);
    transitions.push(await update(audit.taskId, 'succeeded', 'succeeded'));
    await page.locator('.bot-sidebar .bot-conversation').filter({ has: page.locator('strong', { hasText: /^大肥鱼$/u }) }).click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText(seed.direct.title);
    await expect(notice(seed.direct.task.taskId)).toHaveAttribute('data-task-state', 'queued');
    for (const task of seed.group.tasks) await expect(notice(task.taskId)).toHaveCount(0);
    await notice(seed.direct.task.taskId).getByRole('button').click();
    await expect(dialog.locator('[data-bot-task]')).toHaveAttribute('data-bot-task', seed.direct.task.taskId);
    await dialog.getByRole('button', { name: '跟进这个任务', exact: true }).click();
    await expect(page.locator('.bot-task-followup')).toContainText('私聊资料核对'); await expect(page.locator('.bot-task-followup')).toContainText('大肥鱼');
    const intervention = '补充要求：本任务只核对字段名，保留原文件；请暂停后等我继续。';
    await page.locator('.bot-composer textarea').fill(intervention); await capture(application, 'collaboration-direct-followup-composer.png');
    await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
    await expect(page.locator('.bot-message-text').filter({ hasText: intervention })).toBeVisible();
    const directBindings = await bindingFor(seed.direct.id, intervention); expect(directBindings).toHaveLength(1); const binding = directBindings[0]!;
    expect(binding.companion_id).toBe('builtin-dafeiyu'); expect(binding.conversation_id).toBe(seed.direct.id); expect(JSON.parse(binding.payload_json).taskFollowup).toEqual({ taskId: seed.direct.task.taskId });
    const apiState = await page.evaluate(async data => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      const group = await api.request({ type: 'task.list', conversationId: data.groupId, filter: 'all', page: 0, limit: 30 });
      const foreign = await api.request({ type: 'task.get', conversationId: data.groupId, taskId: data.privateTaskId });
      return { group: group.taskPage, foreign: foreign.ok };
    }, { groupId: seed.group.id, privateTaskId: seed.privateGpt.task.taskId });
    expect(apiState.group?.items.map(task => task.id).sort()).toEqual(seed.group.tasks.map(task => task.taskId).sort()); expect(apiState.foreign).toBe(false);
    await application.close(); application = await launch(); const restarted = await application.firstWindow();
    await restarted.locator('[data-application-module="companions"]').click(); await restarted.locator('.bot-sidebar .bot-conversation').filter({ hasText: seed.group.title }).click();
    for (const [taskId, state] of [[finance.taskId, 'paused'], [audit.taskId, 'succeeded'], [stopping.taskId, 'cancelled']]) await expect(restarted.locator(`.bot-task-notice[data-bot-message="${seededTasks.find(task => task.taskId === taskId)!.noticeId}"]`)).toHaveAttribute('data-task-state', state!);
    await expect(restarted.locator(`[data-bot-message="${later}"]`)).toBeVisible();
    await capture(application, 'collaboration-group-after-restart.png');
    const evidence = { seeded: seed, transitions, pausedClock, later, followupBinding: binding, groupFollowupBinding: groupBindings[0], layoutChecks, scopedCatalog: apiState,
      realMainIpc: true, realPauseAndStopControls: true, realComposerSubmission: true, eventDrivenUpdatesWithoutReload: true, restartPreservedHistory: true,
      modelAndWorkerExecution: 'not part of this presentation fixture; separately validated by real provider/DSH scenarios' };
    await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    await writeFile(testInfo.outputPath('collaboration-ui-evidence.json'), JSON.stringify(evidence, null, 2));
  } finally { await application?.close(); removeCompanionTestDirectory(profile); }
});
