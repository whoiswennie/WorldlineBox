import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { BotReplyPart, BotRequest, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { DshRuntime, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';
import { seedNativeRuntime } from './fixtures/dsh-native-runtime';
import { observeCallRenderedPose } from './fixtures/call-rendered-pose';
import { builtinBotCompanion } from '../../src/shared/builtin-bot-companions';

interface Bridge { companionBot: WorldlineBoxBotApi; llm: WorldlineBoxLlmApi; dshLauncher: WorldlineBoxDshLauncherApi }
/** The isolated build needs the real VCP package at the same relative path as development. */
async function stageCallMemory(applicationRoot: string): Promise<void> {
  if (path.resolve(applicationRoot) === process.cwd() || process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) return;
  const owned = path.resolve('.tools/e2e-app');
  if (path.resolve(applicationRoot) !== owned || path.resolve(await realpath(owned)) !== owned) throw Error('Unexpected isolated call app directory');
  const source = path.resolve('.tools/bot-memory-release'), parent = path.join(owned, '.tools'), target = path.join(parent, 'bot-memory-release');
  if (!existsSync(path.join(source, 'vcp-memory/lib/client.cjs'))) throw Error('Stage the real VCP memory package before call acceptance');
  if ((await lstat(source)).isSymbolicLink() || path.resolve(await realpath(source)) !== source) throw Error('Unexpected VCP package source');
  await mkdir(parent, { recursive: true });
  if ((await lstat(parent)).isSymbolicLink() || path.resolve(await realpath(parent)) !== parent) throw Error('Unexpected VCP fixture parent');
  if (existsSync(target)) { if (!(await lstat(target)).isSymbolicLink() || await realpath(target) !== await realpath(source)) throw Error('Unexpected existing VCP fixture directory'); return; }
  // Only this exact leaf is a junction. Never link all of .tools (which would
  // recursively include this isolated app), or recursively remove the junction.
  await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}
async function removeVoiceProfile(profile: string): Promise<void> {
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-call-voice-')) throw Error('Unexpected voice-call cleanup path');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}


const firstLine = '欢迎来到暮色书房。';
const longLine = '你可以一边听窗外的雨声，一边慢慢说。'.repeat(12);
const finalLine = '下次我们接着聊。';
const hiddenBody = 'INTERNAL_FINAL_DO_NOT_DISPLAY';
const fallbackLine = '晚上好，今天又在这个点找我了？啥事啊。';
const fallbackReasoning = 'INTERNAL_REASONING_DO_NOT_DISPLAY';
const interruptedLine = '这一段已经开始呈现。';
const discardedLine = '这是被打断后应丢弃的表演。';

async function startMeetingModel() {
  let unblock!: () => void, releaseInterrupted!: () => void, releaseFollowup!: () => void;
  const finishGate = new Promise<void>(resolve => { unblock = resolve; });
  const interruptGate = new Promise<void>(resolve => { releaseInterrupted = resolve; });
  const followupGate = new Promise<void>(resolve => { releaseFollowup = resolve; });
  const counters = { stage: 0, invalid: 0, presentation: 0, compact: 0, final: 0, catalog: false, followupContext: false, privateTools: false, plainTurns: 0, rejectedToolChoices: 0 };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'meeting-protocol-fixture', object: 'model' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }>; tool_choice?: string | object };
    if (data.tool_choice && !['auto', 'none'].includes(String(data.tool_choice))) {
      counters.rejectedToolChoices++;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Thinking mode does not support this tool_choice', type: 'invalid_request_error' } }));
      return;
    }
    const contents = data.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''));
    const source = contents.findLastIndex(value => value.includes('"identity":') && value.includes('"delivery":'));
    const envelope = contents[source] ?? '';
    const offered = data.tools?.map(item => item.function.name) ?? [];
    const outcomes = data.messages.slice(source + 1).filter(item => item.role === 'tool').length;
    let call: { name: string; args: object } | undefined, content = '{"notes":[]}', reasoning: string | undefined;
    if (contents.some(value => value.includes('compaction engine'))) { counters.compact++; content = '## Summary\nNative call presentation test. Preserve the conversation about the studio.'; }
    else if (envelope.includes('普通聊天基线')) {
      counters.privateTools = offered.includes('call_present');
      content = '普通聊天仍直接回复。';
    } else if (offered.includes('call_present')) {
      counters.catalog ||= envelope.includes('"mode":"live2d"') && envelope.includes('call.model3.json') && envelope.includes('Interaction:6') && envelope.includes('脸红');
      if (envelope.includes('中途打断验收')) {
        if (!outcomes) call = { name: 'call_present', args: { segments: [
          { text: interruptedLine, gesture: 'nod', durationMs: 20_000 },
          { text: discardedLine, expression: '脸红' },
        ] } };
        else { await interruptGate; content = hiddenBody; }
      } else if (envelope.includes('换个问题继续')) {
        if (!outcomes) { await followupGate; call = { name: 'call_present', args: { segments: [{ text: '好，我们换个话题聊。' }] } }; }
        else content = hiddenBody;
      } else if (envelope.includes('没有生成正文')) {
        content = ''; reasoning = fallbackReasoning;
      } else if (envelope.includes('用第二个话题测试')) {
        counters.plainTurns++;
        content = fallbackLine; reasoning = fallbackReasoning;
      } else if (envelope.includes('接续已经存在的话题')) {
        counters.followupContext ||= contents.some(value => value.includes(firstLine));
        if (!outcomes) call = { name: 'call_present', args: { segments: [{ text: '已进入这个会面话题。' }] } };
        else content = hiddenBody;
      } else if (outcomes === 0) {
        counters.stage++; call = { name: 'call_stage', args: {} };
      } else if (outcomes === 1) {
        counters.invalid++; call = { name: 'call_present', args: { segments: [{ text: '这段无效的表演不应发布。', motion: 'nonexistent' }] } };
      } else if (outcomes === 2) {
        counters.presentation++; call = { name: 'call_present', args: { segments: [{ text: firstLine, expression: '流泪', motion: 'Interaction:6', durationMs: 12_000 }] } };
      } else if (outcomes === 3) {
        await finishGate;
        counters.presentation++; call = { name: 'call_present', args: { segments: [{ text: longLine, expression: '屑屑眼' }, { text: finalLine, expression: '屑屑眼', gesture: 'nod' }] } };
      } else { counters.final++; content = hiddenBody; }
    }
    const delta = call ? { tool_calls: [{ index: 0, id: 'fixture-' + crypto.randomUUID(), type: 'function', function: {
      name: call.name, arguments: JSON.stringify(call.args),
    } }] } : { content, reasoning_content: reasoning };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 8000, completion_tokens: 45, total_tokens: 8045 } }) + '\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port, counters, unblock, releaseFollowup,
    close: async () => { unblock(); releaseInterrupted(); releaseFollowup(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

// eslint-disable-next-line no-empty-pattern -- Real Electron, Chromium recording, SenseVoice, native DSH and the bundled Live2D model.
test('video meeting presents DSH tool segments live after voice input and keeps native topic history', async ({}, testInfo) => {
  test.setTimeout(480_000);
  const manager = process.env.WORLDLINEBOX_CALL_TEST_DSH_MANAGER ?? path.join(process.env.APPDATA ?? '.', 'WorldlineBox', 'dsh');
  const runtimes = JSON.parse(await readFile(path.join(manager, 'runtimes.json'), 'utf8').catch(() => '[]')) as DshRuntime[];
  const runtime = runtimes.find(item => item.version === '0.2.2-rc.2') ?? runtimes.find(item => item.version === '0.2.2-rc.1');
  const wave = path.resolve('tests/fixtures/media/sensevoice-zh.wav');
  test.skip(!runtime || !existsSync(wave) || !existsSync(path.resolve('resources/speech-models/model.int8.onnx')), 'Requires a sealed DSH runtime and local SenseVoice test assets.');
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-call-voice-'));
  const launch = resolveElectronLaunchOptions();
  await seedNativeRuntime(manager, runtime!, profile); await stageCallMemory(launch.cwd);
  const model = await startMeetingModel();
  const app = await electron.launch({ ...launch, args: [...launch.args, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wave],
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ app, BrowserWindow }, expected) => {
      if (app.getPath('userData') !== expected) throw Error('Voice-call acceptance must use its own profile');
      const window = BrowserWindow.getAllWindows()[0]!;
      window.on('show', () => window.hide()); window.hide(); window.setMinimumSize(0, 0); window.setSize(1440, 940);
      window.webContents.setAudioMuted(true); window.webContents.setBackgroundThrottling(false);
    }, profile);
    const capture = async (name: string) => {
      const bytes = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const file = testInfo.outputPath(name + '.png'); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, Buffer.from(bytes, 'base64')); await testInfo.attach(name, { path: file, contentType: 'image/png' });
      const evidence = path.resolve('artifacts/superagent-bot-development/ui');
      await mkdir(evidence, { recursive: true });
      await writeFile(path.join(evidence, name + '.png'), Buffer.from(bytes, 'base64'));
    };
    const configured = await page.evaluate(baseUrl => (Reflect.get(window, 'worldlinebox') as Bridge).llm.setConfig({
      apiFormat: 'openai_chat', model: 'meeting-protocol-fixture', baseUrl, apiKey: 'localhost-only-fixture',
    }), model.baseUrl);
    expect(configured.ok).toBe(true);
    await page.locator('[data-application-module="companions"]').click();
    const setup = page.locator('[data-shared-dsh-setup]');
    await setup.getByRole('combobox', { name: '选择 DSH 版本' }).selectOption(runtime!.id);
    await setup.getByRole('button', { name: '创建并共享', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => {
      const launcher = await (Reflect.get(window, 'worldlinebox') as Bridge).dshLauncher.request({ type: 'state' });
      return launcher.ok ? launcher.state?.executionReadiness?.status : launcher.error;
    }), { timeout: 240_000, intervals: [1000, 2000, 4000] }).toBe('ready');
    const request = (input: BotRequest) => page.evaluate(payload => (Reflect.get(window, 'worldlinebox') as Bridge).companionBot.request(payload), input);
    const direct = (await request({ type: 'conversation.open', companionId: 'builtin-dafeiyu' })).conversationId!;
    const normal = await request({ type: 'message.send', conversationId: direct, content: '普通聊天基线', requestId: 'normal' });
    expect(normal.ok, normal.error).toBe(true);
    await expect.poll(async () => {
      const reply = (await request({ type: 'state', conversationId: direct })).snapshot!.messages.find(item => item.id === normal.replyMessageIds![0]);
      if (reply?.status === 'failed') throw Error(reply.error || 'Native normal-chat baseline failed.');
      return reply?.content;
    }, { timeout: 100_000 }).toBe('普通聊天仍直接回复。');
    expect(model.counters.privateTools).toBe(false);
    await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与大肥鱼会面', exact: true });
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible({ timeout: 90_000 });
    await expect(meeting.locator('.bot-call-loading')).toHaveCount(0, { timeout: 90_000 });
    await expect(meeting.locator('.bot-call-model-error')).toHaveCount(0);
    const renderedPose = await observeCallRenderedPose(page);
    const opened = await request({ type: 'call.open', conversationId: direct });
    const callId = opened.conversationId!;
    expect(callId).not.toBe(direct);
    expect(opened.callModel?.assets.motions.length).toBeGreaterThan(0);
    expect(opened.snapshot?.messages).toEqual([]);
    expect(await page.evaluate(() => 'companionBotSpeech' in Reflect.get(window, 'worldlinebox'))).toBe(false);

    const voice = meeting.getByRole('button', { name: '连续语音对话', exact: true });
    await voice.click();
    await expect(meeting.locator('.bot-call-voice.is-listening')).toBeVisible({ timeout: 90_000 });
    const done = meeting.getByRole('button', { name: '说完了', exact: true });
    await page.waitForTimeout(2_500);
    if (await done.isVisible()) await done.click();
    const state = async () => (await request({ type: 'state', conversationId: callId })).snapshot!;
    const bubble = meeting.locator('.bot-call-bubble-text');
    await expect(bubble).toHaveText(firstLine, { timeout: 150_000 });
    await expect.poll(async () => {
      const pose = await renderedPose();
      return Math.min(pose?.tear ?? 0, pose?.hand ?? 0);
    }, { timeout: 2000, intervals: [40] }).toBeGreaterThan(.5);
    await expect(meeting.locator('.bot-call-visual-novel header .bot-avatar img')).toHaveJSProperty('complete', true);
    expect(await meeting.locator('.bot-call-visual-novel header .bot-avatar img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    expect(model.counters).toMatchObject({ stage: 1, invalid: 1, presentation: 1, final: 0, catalog: true });
    const live = await state(), firstTopic = live.chatRuntime!.topic!;
    const voiceText = live.messages.find(item => item.senderId === 'user')?.content;
    expect(voiceText).toMatch(/[\p{Script=Han}]{2,}/u);
    expect(live.messages.find(item => item.parts?.some(part => part.text === firstLine))?.status).toBe('running');
    await expect(meeting.locator('.bot-call-progress .bot-reply-progress-label')).toBeVisible();
    await expect(meeting.getByRole('group', { name: '当前表演' })).toContainText('流泪');
    await meeting.getByRole('button', { name: '展开会面输入', exact: true }).click();
    const assertDock = async () => {
      const dialogue = (await meeting.locator('.bot-call-visual-novel').boundingBox())!;
      const topics = (await meeting.getByRole('region', { name: '会面话题' }).boundingBox())!;
      const composer = (await meeting.locator('.bot-call-composer-host').boundingBox())!;
      const frame = (await meeting.boundingBox())!;
      const progress = (await meeting.locator('.bot-call-progress').boundingBox())!;
      const bubble = (await meeting.locator('.bot-call-bubble').boundingBox())!;
      expect(Math.abs((dialogue.x + dialogue.width / 2) - (frame.x + frame.width / 2))).toBeLessThan(1.5);
      expect(progress.y + progress.height).toBeLessThanOrEqual(bubble.y);
      expect(dialogue.y + dialogue.height).toBeLessThanOrEqual(topics.y);
      expect(topics.y + topics.height).toBeLessThanOrEqual(composer.y);
      expect(composer.y + composer.height).toBeLessThanOrEqual(frame.y + frame.height);
    };
    await assertDock();
    await capture('live2d-meeting-dialogue');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(950, 590));
    await assertDock();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 940));
    await meeting.getByRole('button', { name: '收起会面输入', exact: true }).click();
    await meeting.getByRole('button', { name: '自动播放', exact: true }).click();
    model.unblock();
    await expect.poll(async () => (await state()).messages.find(item => item.parts?.some(part => part.text === firstLine))?.status).toBe('sent');
    await expect(meeting.locator('.bot-call-voice.is-listening')).toBeVisible();
    await voice.click();
    await expect(bubble).toHaveText(firstLine);
    const next = meeting.getByRole('button', { name: '下一段', exact: true });
    let joined = '';
    while (await next.isEnabled()) {
      await next.click(); const text = await bubble.textContent();
      if (text !== finalLine) joined += text;
    }
    expect(joined).toBe(longLine);
    await expect(bubble).toHaveText(finalLine);
    await expect.poll(async () => (await renderedPose())?.smugEyes ?? 0, { timeout: 1400 }).toBeGreaterThan(.75);
    await meeting.getByRole('button', { name: '继续自动播放', exact: true }).click();
    await expect(meeting.locator('.bot-call-bubble-status')).toHaveText('回应结束 · 可以继续');
    if (process.platform === 'win32') {
      const openedPet = app.waitForEvent('window');
      await meeting.getByRole('button', { name: '切换为桌宠', exact: true }).click();
      const pet = await openedPet;
      await expect(pet.locator('.bot-call-bubble-text')).toHaveText(finalLine);
      const petWindow = await app.browserWindow(pet);
      const bytes = await petWindow.evaluate(async native => (await native.webContents.capturePage()).toPNG().toString('base64'));
      await writeFile(path.resolve('artifacts/superagent-bot-development/ui/companion-call-desktop-pet-dialogue.png'), Buffer.from(bytes, 'base64'));
      await pet.getByRole('button', { name: '从头播放', exact: true }).click();
      await expect(pet.locator('.bot-call-bubble-text')).toHaveText(firstLine);
      await expect.poll(async () => {
        const pose = await renderedPose();
        return Math.min(pose?.tear ?? 0, pose?.hand ?? 0);
      }, { timeout: 2000, intervals: [40] }).toBeGreaterThan(.5);
      await pet.getByRole('button', { name: '更多会面功能', exact: true }).click();
      const closed = pet.waitForEvent('close');
      await pet.getByRole('button', { name: '返回会面场景', exact: true }).click().catch(error => { if (!pet.isClosed()) throw error; });
      await closed;
      await expect(bubble).toHaveText(firstLine);
    }
    await meeting.getByRole('button', { name: '完整对话', exact: true }).click();
    const history = meeting.locator('.bot-call-transcript');
    await expect(history).toContainText(longLine);
    await expect(history).not.toContainText(hiddenBody);
    await expect(history).not.toContainText('这段无效的表演不应发布。');
    await expect(history).not.toContainText('普通聊天基线');
    await meeting.getByRole('button', { name: '收起会面面板', exact: true }).click();
    await meeting.getByRole('button', { name: /^上下文(?:已用|待统计)/u }).click();
    await expect(meeting.getByRole('dialog', { name: 'DSH 上下文' })).toBeVisible();
    await meeting.getByRole('button', { name: '关闭上下文详情' }).click();
    await meeting.getByRole('button', { name: '压缩', exact: true }).click();
    await expect(meeting.locator('.bot-topic-notice')).toContainText(/压缩/, { timeout: 60_000 });
    await meeting.getByRole('button', { name: '新话题', exact: true }).click();
    await expect.poll(async () => (await state()).chatRuntime?.topic?.id).not.toBe(firstTopic.id);
    expect((await state()).messages).toEqual([]);
    await meeting.getByRole('button', { name: '展开会面输入', exact: true }).click();
    const field = meeting.getByRole('textbox', { name: '发送消息…', exact: true });
    await field.fill('用第二个话题测试'); await field.press('Enter');
    await expect(bubble).toHaveText(fallbackLine, { timeout: 60_000 });
    const fallback = (await state()).messages.find(item => item.parts?.some(part => part.text === fallbackLine));
    expect(fallback).toMatchObject({ status: 'sent', content: fallbackLine });
    expect(fallback?.parts?.filter(part => part.presentation)).toEqual([expect.objectContaining({ text: fallbackLine, presentation: {} })]);
    expect(model.counters).toMatchObject({ plainTurns: 1, rejectedToolChoices: 0 });
    await field.fill('没有生成正文'); await field.press('Enter');
    await expect(meeting.locator('.bot-call-bubble-status')).toHaveText('这次会面回应未能发布，请再试一次。', { timeout: 60_000 });
    await expect(bubble).toHaveCount(0);
    expect(model.counters.rejectedToolChoices).toBe(0);
    await meeting.locator('.bot-topic-current').click();
    await meeting.locator('[data-topic-id="' + firstTopic.id + '"] .bot-topic-open').click();
    await expect.poll(async () => (await state()).chatRuntime?.topic?.id).toBe(firstTopic.id);
    expect((await state()).messages.some(item => item.content === '用第二个话题测试')).toBe(false);
    await field.fill('接续已经存在的话题'); await field.press('Enter');
    await expect.poll(async () => (await state()).messages.filter(item => item.senderId !== 'user' && item.status === 'sent').length, { timeout: 60_000 }).toBe(2);
    await expect(bubble).toHaveText('已进入这个会面话题。');
    await expect(meeting.locator('.bot-call-bubble-status')).toHaveText('回应结束 · 可以继续');
    await field.fill('中途打断验收'); await field.press('Enter');
    await expect(bubble).toHaveText(interruptedLine, { timeout: 60_000 });
    const oldReply = (await state()).messages.find(item => item.parts?.some(part => part.text === discardedLine));
    expect(oldReply?.status).toBe('running');
    await field.fill('换个问题继续'); await field.press('Enter');
    await expect(meeting.locator('.bot-call-user-line')).toContainText('换个问题继续');
    await expect(meeting.locator('.bot-call-bubble-status')).toHaveText('正在回应…');
    await expect(bubble).toHaveCount(0);
    model.releaseFollowup();
    await expect(bubble).toHaveText('好，我们换个话题聊。', { timeout: 60_000 });
    const stopped = (await state()).messages.find(item => item.id === oldReply!.id);
    expect(stopped?.status).toBe('cancelled');
    expect(stopped?.parts?.filter(part => part.presentation).map(part => part.text)).toEqual([interruptedLine]);
    expect((await request({ type: 'state', conversationId: direct })).snapshot?.messages.some(item => item.content === voiceText)).toBe(false);
    await meeting.getByRole('button', { name: '挂断', exact: true }).click();
    await expect(meeting).toHaveCount(0);
    await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await meeting.getByRole('button', { name: '会面聊天记录', exact: true }).click();
    await expect(history).toContainText(finalLine);
    await expect(history).toContainText('接续已经存在的话题');
    await expect(history).not.toContainText(discardedLine);
    expect(errors).toEqual([]);
  } finally {
    model.unblock();
    await app.close();
    await model.close();
    await removeVoiceProfile(profile);
  }
});

// eslint-disable-next-line no-empty-pattern -- Explicit opt-in to the user's configured provider, using only synthetic prompts and a fresh profile.
test('real model chooses and renders scene-appropriate Live2D cues', async ({}, testInfo) => {
  test.skip(process.env.WORLDLINEBOX_CALL_REAL !== '1', 'Opt in to the configured model with WORLDLINEBOX_CALL_REAL=1.');
  test.setTimeout(420_000);
  const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT ?? path.join(process.env.APPDATA!, 'WorldlineBox');
  const manager = path.join(source, 'dsh');
  const runtimes = JSON.parse(await readFile(path.join(manager, 'runtimes.json'), 'utf8')) as DshRuntime[];
  const runtime = runtimes.find(item => item.version === '0.2.2-rc.2') ?? runtimes.find(item => item.version === '0.2.2-rc.1');
  if (!runtime) throw Error('A sealed native DSH runtime is required.');
  const catalog = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8')) as { activeProfileId: string };
  if (!/^ai_[a-f0-9]{24}$/u.test(catalog.activeProfileId)) throw Error('A configured real-model profile is required.');
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-call-voice-'));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const launch = resolveElectronLaunchOptions();
    await seedNativeRuntime(manager, runtime, profile);
    await stageCallMemory(launch.cwd);
    await mkdir(path.join(profile, 'ai-profile-keys'));
    await copyFile(path.join(source, 'ai-profiles.json'), path.join(profile, 'ai-profiles.json'));
    const keyFile = path.join('ai-profile-keys', catalog.activeProfileId + '.bin');
    await copyFile(path.join(source, keyFile), path.join(profile, keyFile));
    const local = JSON.parse(await readFile(path.join(source, 'Local State'), 'utf8')) as { os_crypt?: unknown };
    if (local.os_crypt) await writeFile(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: local.os_crypt }));
    application = await electron.launch({ ...launch, env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1',
      WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
    const page = await application.firstWindow();
    await application.evaluate(({ app, BrowserWindow }, expected) => {
      if (app.getPath('userData') !== expected) throw Error('Real meeting test requires its own profile.');
      const window = BrowserWindow.getAllWindows()[0]!;
      window.on('show', () => window.hide()); window.hide(); window.setSize(1440, 940);
      window.webContents.setAudioMuted(true); window.webContents.setBackgroundThrottling(false);
    }, profile);
    await page.locator('[data-application-module="companions"]').click();
    const setup = page.locator('[data-shared-dsh-setup]');
    await setup.getByRole('combobox', { name: '选择 DSH 版本' }).selectOption(runtime.id);
    await setup.getByRole('button', { name: '创建并共享', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => {
      const result = await (Reflect.get(window, 'worldlinebox') as Bridge).dshLauncher.request({ type: 'state' });
      return result.ok ? result.state?.executionReadiness?.status : result.error;
    }), { timeout: 150_000, intervals: [1000] }).toBe('ready');
    const request = (input: BotRequest) => page.evaluate(payload => (Reflect.get(window, 'worldlinebox') as Bridge).companionBot.request(payload), input);
    const direct = (await request({ type: 'conversation.open', companionId: 'builtin-dafeiyu' })).conversationId!;
    await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与大肥鱼会面', exact: true });
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible({ timeout: 60_000 });
    await expect(meeting.locator('.bot-call-loading')).toHaveCount(0, { timeout: 60_000 });
    await expect(meeting.locator('.bot-call-model-error')).toHaveCount(0);
    const readPose = await observeCallRenderedPose(page);
    const call = await request({ type: 'call.open', conversationId: direct });
    const conversationId = call.conversationId!;
    await meeting.getByRole('button', { name: '展开会面输入' }).click();
    const field = meeting.getByRole('textbox', { name: '发送消息…', exact: true });
    const speech = meeting.locator('.bot-call-visual-novel');
    const evidence = path.resolve('artifacts/superagent-bot-development/ui');
    await mkdir(evidence, { recursive: true });
    const prompts = [
      { name: 'emotion', text: '我们来演一段重逢吧。我把你以为丢了的那封信递给你，你看到每个字都还在，红着眼睛落下泪来。看着我，说说这时候你心里在想什么。', cue: { expression: '流泪' }, channel: 'tear' as const },
      { name: 'gesture', text: '好啦，擦擦眼泪。把手放在胸前，认认真真答应我，下回我们把信收在同一个盒子里。', cue: { motion: 'Interaction:6' }, channel: 'hand' as const },
    ];
    const report = [];
    for (const turn of prompts) {
      await field.fill(turn.text); await field.press('Enter');
      await expect(speech).toContainText(turn.text);
      let cuePart: BotReplyPart | undefined;
      await expect.poll(async () => {
        const messages = (await request({ type: 'state', conversationId })).snapshot?.messages ?? [];
        const source = messages.findLast(item => item.senderId === 'user' && item.content === turn.text);
        const reply = source && messages.find(item => item.senderId === 'builtin-dafeiyu' && item.sequence > source.sequence);
        if (reply?.status === 'failed') throw Error(reply.error ?? 'Real meeting reply failed.');
        cuePart = reply?.parts?.find(part => part.presentation && Object.entries(turn.cue).every(([key, value]) => Reflect.get(part.presentation!, key) === value));
        if (!cuePart && reply?.status === 'sent') throw Error('The model did not choose the requested performance: ' + JSON.stringify(reply.parts?.map(part => ({ text: part.text, cue: part.presentation }))));
        return cuePart?.id ?? '';
      }, { timeout: 105_000, intervals: [100, 250, 400] }).toMatch(/^call-/u);
      await expect(speech).toHaveAttribute('data-call-segment', cuePart!.id, { timeout: 25_000 });
      await expect.poll(async () => (await readPose())?.[turn.channel] ?? 0, { timeout: 1600, intervals: [25, 45] }).toBeGreaterThan(.5);
      const rendered = await readPose();
      report.push({ prompt: turn.text, text: cuePart!.text, cue: cuePart!.presentation, rendered });
      const image = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const file = path.join(evidence, 'companion-call-real-' + turn.name + '.png');
      await writeFile(file, Buffer.from(image, 'base64'));
      await testInfo.attach(turn.name, { path: file, contentType: 'image/png' });
      await expect(meeting.locator('.bot-call-bubble-status')).toHaveText('回应结束 · 可以继续', { timeout: 45_000 });
    }
    await writeFile(path.join(evidence, 'companion-call-real-performance.json'), JSON.stringify(report, null, 2));
    await meeting.getByRole('button', { name: '挂断', exact: true }).click();
    const portraitReport = [];
    for (const character of [
      { id: 'claude', text: '你正读着书，我坐到你旁边，想和你说说今天遇到的一件难事。可以先合上书，认真听我说吗？' , motion: 'close-book' },
      { id: 'gemini', text: '我发现把两张星图拼起来，星星居然会连成一只小猫。听到这个线索，你的猫耳是不是一下就竖起来了？你猜我们还能拼出什么？', motion: 'ears-perk' },
    ]) {
      const builtin = builtinBotCompanion(character.id)!;
      const direct = (await request({ type: 'conversation.open', companionId: character.id })).conversationId!;
      await page.locator('.bot-conversation').filter({ has: page.getByText(builtin.name, { exact: true }) }).first().click();
      const stage = (await request({ type: 'companion.call-performance', companionId: character.id })).callStage!;
      expect(stage.mode).toBe('portrait');
      await page.getByRole('button', { name: '角色卡', exact: true }).first().click();
      const card = page.getByRole('dialog', { name: `角色卡 · ${builtin.name}` });
      await card.getByRole('button', { name: '会面表演', exact: true }).click();
      const motion = stage.motions.find(item => item.id === character.motion)!;
      await expect(card.getByText(motion.label![0], { exact: true })).toBeVisible();
      await expect(card.getByText(motion.description![0], { exact: true })).toBeVisible();
      await card.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
      const meeting = page.getByRole('dialog', { name: `与${builtin.name}会面` });
      await meeting.getByRole('button', { name: '接通', exact: true }).click();
      const avatar = meeting.locator('.bot-call-portrait-frame img');
      await expect(avatar).toBeVisible();
      await expect(avatar).toHaveJSProperty('complete', true);
      expect(await avatar.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      expect(decodeURIComponent((await avatar.getAttribute('src'))!)).toContain(builtin.portrait.url);
      const avatarBox = (await avatar.boundingBox())!, dialogBox = (await meeting.boundingBox())!;
      expect(Math.abs(avatarBox.x + avatarBox.width / 2 - dialogBox.x - dialogBox.width / 2)).toBeLessThan(2);
      await expect(meeting.locator('.bot-call-live2d')).toHaveCount(0);
      const call = await request({ type: 'call.open', conversationId: direct });
      await meeting.getByRole('button', { name: '展开会面输入' }).click();
      const input = meeting.getByRole('textbox', { name: '发送消息…', exact: true });
      await input.fill(character.text); await input.press('Enter');
      await expect(meeting.locator('.bot-call-progress')).toBeVisible({ timeout: 15_000 });
      const readReply = async () => (await request({ type: 'state', conversationId: call.conversationId })).snapshot?.messages.find(item => item.senderId === character.id);
      let cuePart: BotReplyPart | undefined;
      await expect.poll(async () => {
        const reply = await readReply();
        cuePart = reply?.parts?.find(part => part.presentation?.motion === character.motion);
        if (!cuePart && reply?.status === 'sent') throw Error(`${builtin.name} did not select the matching cue: ` + JSON.stringify(reply.parts));
        if (reply?.status === 'failed') throw Error(reply.error ?? 'Portrait meeting failed.');
        return cuePart?.id ?? '';
      }, { timeout: 105_000, intervals: [150, 350] }).toMatch(/^call-/u);
      const cue = meeting.getByRole('group', { name: '当前表演' });
      await expect(cue).toContainText(motion.label![0], { timeout: 45_000 });
      const picture = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      await writeFile(path.join(evidence, `companion-call-portrait-${character.id}.png`), Buffer.from(picture, 'base64'));
      await expect(meeting.locator('.bot-call-bubble-status')).toHaveText('回应结束 · 可以继续', { timeout: 75_000 });
      await expect(meeting.locator('.bot-call-progress')).toHaveCount(0);
      await expect(cue).toHaveCount(0);
      const published = (await readReply())?.parts?.flatMap(part => part.presentation ? [{ text: part.text, ...part.presentation }] : []) ?? [];
      expect(published.some(part => part.expression && stage.expressions.some(item => item.name === part.expression))).toBe(true);
      expect(published.every(part => (!part.expression || stage.expressions.some(item => item.name === part.expression))
        && (!part.motion || stage.motions.some(item => item.id === part.motion)))).toBe(true);
      portraitReport.push({ companion: builtin.name, prompt: character.text, published });
      await meeting.getByRole('button', { name: '挂断', exact: true }).click();
    }
    await writeFile(path.join(evidence, 'companion-call-real-portraits.json'), JSON.stringify(portraitReport, null, 2));
  } finally {
    try { await application?.close(); } finally { await removeVoiceProfile(profile); }
  }
});
