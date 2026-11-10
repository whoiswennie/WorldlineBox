import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { BotRequest, BotMessage, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Production IPC and real configured model in the owned acceptance profile.
test('stops a real native tool, switches topics and cold-resumes the same reply without sending another message', async ({}, testInfo) => {
  test.skip(process.env.WORLDLINEBOX_BOT_INTERRUPT_REAL !== '1', 'Opt in with the owned real-model acceptance profile.');
  test.setTimeout(600000);
  const profile = path.resolve(process.env.WORLDLINEBOX_BOT_PROJECT_PROFILE ?? '');
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-project-real-')) throw Error('Requires an owned real-test profile.');
  const evidence = path.resolve('artifacts/companion-interrupt-real'), work = path.join(profile, 'interrupt-resume-' + Date.now().toString(36));
  await mkdir(evidence, { recursive: true }); await mkdir(work, { recursive: true });
  const marker = 'INTERRUPT_' + randomUUID(), title = '中断与继续验收 ' + Date.now().toString(36);
  const report: Record<string, unknown> = { profile, realModel: true, nativeDsh: true, productionIpc: true, work, stages: [] };
  let app: ElectronApplication | undefined;
  let page!: Page;
  let roomId = '', messageId = '', topicId = '', sessionId = '';
  const stage = async (name: string) => { (report.stages as object[]).push({ name, at: new Date().toISOString() }); console.log('[real interrupt] ' + name); await writeFile(path.join(evidence, 'progress.json'), JSON.stringify(report, null, 2)); };
  const request = (input: BotRequest) => page.evaluate(input => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request(input), input);
  const state = async () => (await request({ type: 'state', conversationId: roomId })).snapshot!;
  const reply = async () => (await state()).messages.find(message => message.id === messageId);
  const capture = async (name: string) => { const filename = path.join(evidence, name + '.png'); await page.screenshot({ path: filename, fullPage: true }); await testInfo.attach(name, { path: filename, contentType: 'image/png' }); };
  const launch = async () => {
    app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1' }) });
    page = await app.firstWindow(); await expect(page.locator('[data-application-module="companions"]')).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]!; win.setSize(1680, 1040); win.webContents.setBackgroundThrottling(false); });
    await page.locator('[data-application-module="companions"]').click();
    roomId = (await request({ type: 'conversation.open', companionId: 'builtin-dafeiyu' })).conversationId!;
    await page.locator('.bot-sidebar .bot-conversation').filter({ has: page.locator('.bot-conversation-title strong', { hasText: /^大肥鱼$/ }) }).click();
  };
  const selectOriginal = async () => {
    await page.locator('.bot-topic-current').click(); await page.getByLabel('搜索话题', { exact: true }).fill(title);
    await page.locator(`[data-topic-id="${topicId}"] .bot-topic-open`).click(); await expect(page.locator('.bot-topic-current')).toContainText(title);
  };
  try {
    await launch(); await stage('start-real-file-task');
    await page.getByRole('button', { name: '新话题', exact: true }).click();
    topicId = (await state()).chatRuntime!.topic!.id;
    expect((await request({ type: 'topic.rename', conversationId: roomId, topicId, title, requestId: randomUUID() })).ok).toBe(true);
    const before = Math.max(0, ...(await state()).messages.map(message => message.sequence));
    await page.locator('.bot-composer textarea').fill(`真实中断/继续验收，不代表用户资料，不要联系其他伙伴。工作目录：${work.replaceAll('\\', '/')}。请直接用 DSH 原生文件与命令工具做：
1. 先检查 started.txt 是否存在。首次执行时写入 started.txt，内容必须是 ${marker}，然后在同一次前台命令中等待45秒，再写 delivery.txt，内容必须是 ${marker} 和“文件交付完成”。不要后台或分离运行。不要向用户提问。
2. 若任务被中断后恢复，先核实目录实际状态；started.txt 已有就不要改写，不要重复45秒等待。此时请用原生命令前台等待5秒（仅用于观察恢复后的实时阶段），再补写缺失的 delivery.txt。已有的操作不重复执行。
3. 使用 DSH 原生 present/present_files 交付 delivery.txt。最后只回复“原任务已继续并完成”，不要表情。`);
    await page.locator('.bot-composer .bot-send').click();
    await expect.poll(async () => { const message = (await state()).messages.find(message => message.sequence > before && message.senderId === 'builtin-dafeiyu'); messageId = message?.id ?? ''; sessionId = message?.execution?.sessionId ?? ''; return !!sessionId; }, { timeout: 120000, intervals: [500] }).toBe(true);
    await expect.poll(async () => readFile(path.join(work, 'started.txt'), 'utf8').catch(() => ''), { timeout: 120000, intervals: [300] }).toContain(marker);
    await stage('stop-during-native-tool');
    const row = page.locator(`[data-bot-message="${messageId}"]`);
    await row.getByRole('button', { name: '停止', exact: true }).click();
    await expect(row.getByRole('button', { name: '继续执行', exact: true })).toBeEnabled({ timeout: 60000 });
    expect((await reply())?.execution).toMatchObject({ sessionId, interruption: { state: 'ready' } });
    expect(await readFile(path.join(work, 'delivery.txt'), 'utf8').catch(() => '')).toBe('');
    await capture('interrupted-compact-control');
    await stage('switch-topics-while-interrupted');
    await page.getByRole('button', { name: '新话题', exact: true }).click();
    const otherTopic = (await state()).chatRuntime!.topic!.id; expect(otherTopic).not.toBe(topicId);
    await selectOriginal(); await expect(row.getByRole('button', { name: '继续执行', exact: true })).toBeEnabled();
    const userMessages = (await state()).messages.filter(message => message.senderId === 'user').map(message => message.id);
    await stage('restart-preserves-user-interruption');
    await app!.close(); app = undefined; await launch(); await selectOriginal();
    expect((await reply())?.status).toBe('cancelled'); await expect(page.locator(`[data-bot-message="${messageId}"]`).getByRole('button', { name: '继续执行', exact: true })).toBeEnabled();
    expect(await readFile(path.join(work, 'delivery.txt'), 'utf8').catch(() => '')).toBe('');
    await capture('interrupted-after-restart');
    await stage('one-click-continue-with-empty-composer');
    const resumedRow = page.locator(`[data-bot-message="${messageId}"]`);
    await expect(page.locator('.bot-composer textarea')).toHaveValue('');
    const beforeResumeSteps = (await reply())!.execution!.steps.map(step => step.id);
    await page.evaluate(messageId => {
      const frames: Array<{ type: string; text?: string; at: string }> = []; Reflect.set(window, 'interruptResumeFrames', frames);
      (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.onEvent(event => {
        if (event.type === 'text' && event.messageId === messageId) frames.push({ type: event.type, text: event.text, at: new Date().toISOString() });
      });
    }, messageId);
    await resumedRow.getByRole('button', { name: '继续执行', exact: true }).click();
    await expect(resumedRow.locator('.bot-reply-progress')).toBeVisible();
    await expect.poll(async () => { const message = await reply(); return message?.status === 'running' && message.execution?.steps.some(step => !beforeResumeSteps.includes(step.id) && step.type === 'tool_call'); }, { timeout: 120000, intervals: [100] }).toBe(true);
    await expect(resumedRow.locator('.bot-execution-toggle')).toBeVisible();
    await expect(resumedRow.locator('.bot-execution-status')).not.toContainText('开始调用工具');
    await expect(resumedRow.locator('.bot-execution-status')).toContainText(' · ');
    await expect(resumedRow.locator('.bot-reply-progress')).toHaveAttribute('data-phase', 'using-tool');
    report.liveAfterResume = { running: true, nativeSessionId: (await reply())!.execution!.sessionId, phase: await resumedRow.locator('.bot-reply-progress').getAttribute('data-phase'), label: await resumedRow.locator('.bot-execution-status').innerText(), newSteps: (await reply())!.execution!.steps.filter(step => !beforeResumeSteps.includes(step.id)) };
    await capture('continued-live-native-progress');
    let completed: BotMessage | undefined;
    await expect.poll(async () => { completed = await reply(); if (completed?.status === 'failed') throw Error(completed.error ?? 'Native continuation failed'); return completed?.status; }, { timeout: 240000, intervals: [750] }).toBe('sent');
    expect(completed!.execution?.sessionId).toBe(sessionId); expect(completed!.execution?.interruption).toBeUndefined();
    expect(completed!.content).toContain('原任务已继续并完成');
    expect((await state()).messages.filter(message => message.senderId === 'user').map(message => message.id)).toEqual(userMessages);
    expect(await readFile(path.join(work, 'started.txt'), 'utf8')).toContain(marker);
    expect(await readFile(path.join(work, 'delivery.txt'), 'utf8')).toContain(marker);
    expect(completed!.attachments?.some(file => file.name === 'delivery.txt')).toBe(true);
    const frames = await page.evaluate(() => Reflect.get(window, 'interruptResumeFrames') as Array<{ type: string; text?: string; at: string }>);
    expect(frames.some(frame => frame.text?.includes('原任务已继续并完成'))).toBe(true); report.streamedAfterResume = frames;
    await expect(resumedRow.locator('.bot-execution,.bot-execution-continuation,.bot-stop')).toHaveCount(0);
    await expect(resumedRow.locator('.bot-message-single-file')).toBeVisible(); await capture('continued-native-delivery');
    report.passed = true; report.topicId = topicId; report.messageId = messageId; report.sessionId = sessionId; report.sameReplyAndSession = true; report.noNewUserMessage = true; report.coldResume = true; report.delivery = completed!.attachments;
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); await writeFile(path.join(evidence, 'failure.json'), JSON.stringify(report, null, 2)); if (page!) await capture('failure').catch(() => undefined); throw error; }
  finally { await app?.close(); }
});
