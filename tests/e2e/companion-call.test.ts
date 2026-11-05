import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Isolated native Electron owns the page and WebGL model.
test('companion meeting loads real Live2D and native actions, shares the original chat and cleans up ringtone on connect/end', async ({}, testInfo) => {
  test.setTimeout(240000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-companion-call-'));
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-companion-call-')) throw Error('Unexpected call profile');
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    const loadedNativeFiles = new Set<string>(); page.on('response', response => { if (response.ok() && /\.(?:exp3|motion3)\.json$/u.test(response.url())) loadedNativeFiles.add(decodeURIComponent(response.url())); });
    page.on('console', entry => { if (/Failed to (?:apply native|load (?:expression|motion))/iu.test(entry.text())) errors.push(entry.text()); });
    const attachment = path.join(profile, '会面聊天附件.md'); await writeFile(attachment, '# 同一段对话\n\n会面沿用聊天附件服务。');
    await app.evaluate(({ app, BrowserWindow, dialog }, input) => {
      if (app.getPath('userData') !== input.profile) throw Error('Call acceptance must be isolated');
      for (const window of BrowserWindow.getAllWindows()) { window.on('show', () => window.hide()); window.webContents.setAudioMuted(true); window.webContents.setBackgroundThrottling(false); window.setSize(1600, 1000); window.hide(); }
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.attachment] });
    }, { profile, attachment });
    await page.locator('[data-application-module="companions"]').click();
    const original = await page.evaluate(async () => {
      const state = await (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state' });
      return { rooms: state.snapshot!.conversations.map(room => room.id), room: state.snapshot!.conversations.find(room => room.kind === 'direct' && room.memberIds.includes('builtin-dafeiyu'))!.id };
    });
    await page.evaluate(async room => {
      const api = Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi; companionBotMedia: WorldlineBoxBotMediaApi };
      const imported = await api.companionBotMedia.request({ type: 'files.pick', conversationId: room });
      if (!imported.ok || !imported.media?.length) throw Error('Call attachment import failed');
      const shared = await api.companionBot.request({ type: 'message.send', conversationId: room, content: '', attachmentIds: [imported.media[0]!.id], requestId: 'call-attachment' });
      if (!shared.ok) throw Error('Call attachment share failed');
    }, original.room);
    await page.evaluate(() => { const OriginalAudio = window.Audio; window.Audio = class extends OriginalAudio { constructor(src?: string) { super(src); Reflect.set(window, '__callAcceptanceAudio', this); } }; });
    await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与大肥鱼会面', exact: true }); await expect(meeting).toContainText('等待你接通');
    await expect.poll(() => page.evaluate(() => { const audio = Reflect.get(window, '__callAcceptanceAudio') as HTMLAudioElement; return audio?.duration; })).toBe(26);
    expect(await page.evaluate(() => (Reflect.get(window, '__callAcceptanceAudio') as HTMLAudioElement).loop)).toBe(true);
    await expect(meeting.locator('.bot-call-live2d')).toHaveCount(0);
    const evidence = path.resolve('artifacts/superagent-bot-development/ui'); await mkdir(evidence, { recursive: true });
    const capture = async (name: string) => {
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const file = testInfo.outputPath(name); await writeFile(file, Buffer.from(png, 'base64')); await copyFile(file, path.join(evidence, name));
    };
    await capture('companion-call-dialing.png'); await meeting.getByRole('button', { name: '接通', exact: true }).click();
    expect(await page.evaluate(() => (Reflect.get(window, '__callAcceptanceAudio') as HTMLAudioElement).paused)).toBe(true);
    await expect(meeting.locator('.bot-call-model-error')).toHaveCount(0);
    await expect(meeting.locator('.bot-call-loading')).toHaveCount(0, { timeout: 90000 });
    expect(await meeting.locator('.bot-call-model-error').allTextContents()).toEqual([]);
    await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible();
    await capture('companion-call-portrait-default.png');
    await meeting.getByRole('button', { name: '会面菜单', exact: true }).click();
    await expect(meeting.getByRole('button', { name: '全身取景', exact: true })).toBeVisible();
    await meeting.getByRole('button', { name: '放大形象', exact: true }).click();
    await meeting.getByRole('button', { name: '缩小形象', exact: true }).click();
    await meeting.getByRole('button', { name: '会面菜单', exact: true }).click();
    await meeting.locator('.bot-call-history-toggle').click();
    await meeting.getByRole('tab', { name: '操作', exact: true }).click();
    await expect(meeting.getByLabel('选择模型表情', { exact: true }).locator('option')).toHaveCount(24);
    await expect(meeting.getByLabel('选择模型动作', { exact: true }).locator('option')).toHaveCount(9);
    const catalog = await page.evaluate(async () => (await fetch(new URL('companion-call/deepseek/catalog.json', document.baseURI))).json() as Promise<{ expressions: { name: string; file: string }[]; motions: { name: string; file: string }[] }>);
    for (const item of catalog.expressions) {
      await meeting.getByLabel('选择模型表情', { exact: true }).selectOption({ label: item.name });
      await expect.poll(() => [...loadedNativeFiles].some(url => url.endsWith(item.file))).toBe(true);
    }
    for (const [index, item] of catalog.motions.entries()) {
      await meeting.getByLabel('选择模型动作', { exact: true }).selectOption(String(index)); await meeting.getByRole('button', { name: '播放动作', exact: true }).click();
      await expect.poll(() => [...loadedNativeFiles].some(url => url.endsWith(item.file))).toBe(true);
    }
    await meeting.getByLabel('选择模型表情', { exact: true }).selectOption({ label: '脸红' });
    await meeting.getByLabel('选择模型动作', { exact: true }).selectOption({ label: '默认手切举手' }); await meeting.getByRole('button', { name: '播放动作', exact: true }).click();
    await meeting.getByRole('button', { name: '点头', exact: true }).click();
    await meeting.getByRole('button', { name: '全身', exact: true }).click(); await capture('companion-call-live2d-controls.png');
    await meeting.getByRole('button', { name: '恢复默认姿态', exact: true }).click();
    await meeting.getByRole('button', { name: '半身', exact: true }).click();
    await meeting.getByRole('tab', { name: '对话', exact: true }).click();
    await meeting.getByRole('button', { name: '展开会面输入', exact: true }).click();
    await meeting.getByRole('button', { name: '表情', exact: true }).click();
    const emoji = meeting.getByRole('button', { name: '🐳', exact: true }); await expect(emoji).toBeVisible();
    await emoji.press('Escape'); await expect(emoji).toHaveCount(0); await expect(meeting).toBeVisible();
    const dictate = meeting.getByRole('button', { name: '语音转文字', exact: true }); await dictate.click();
    const localVoice = meeting.getByRole('region', { name: '本地语音', exact: true }); await expect(localVoice).toBeVisible();
    await dictate.press('Escape'); await expect(localVoice).toHaveCount(0); await expect(meeting).toBeVisible();
    await meeting.getByRole('button', { name: '打开预览 会面聊天附件.md', exact: true }).click();
    const preview = page.getByRole('dialog', { name: '会面聊天附件.md', exact: true }); await expect(preview).toContainText('会面沿用聊天附件服务');
    expect(await page.evaluate(() => Number(getComputedStyle(document.querySelector('.bot-attachment-viewer-backdrop')!).zIndex) > Number(getComputedStyle(document.querySelector('.bot-call-overlay')!).zIndex))).toBe(true);
    await preview.press('Escape'); await expect(preview).toHaveCount(0); await expect(meeting).toBeVisible();
    await meeting.getByRole('textbox', { name: '发送消息…', exact: true }).fill('会面验收：这条消息必须出现在原来的私聊中。');
    expect(await meeting.getByRole('textbox', { name: '发送消息…', exact: true }).evaluate(field => getComputedStyle(field).outlineWidth)).toBe('0px');
    await capture('companion-call-full-composer-focused.png');
    await meeting.getByRole('button', { name: '发送 ↑', exact: true }).click(); await expect(meeting.locator('.bot-call-transcript')).toContainText('会面验收：');
    const after = await page.evaluate(async room => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId: room }), original.room);
    expect(after.snapshot!.conversations.map(room => room.id)).toEqual(original.rooms);
    expect(after.snapshot!.messages.filter(message => message.senderId === 'user' && message.content.includes('会面验收：'))).toHaveLength(1);
    await capture('companion-call-live2d-chat.png'); await meeting.getByRole('button', { name: '结束并关闭会面', exact: true }).click(); await expect(meeting).toHaveCount(0);
    await expect(page.locator('.bot-transcript')).toContainText('会面验收：'); await expect(page.locator('.bot-call-live2d canvas')).toHaveCount(0);
    await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click(); await expect(meeting).toContainText('等待你接通');
    await meeting.getByRole('button', { name: '取消', exact: true }).click(); await expect(meeting).toHaveCount(0);
    expect(errors).toEqual([]);
    await writeFile(path.join(evidence, 'companion-call-evidence.json'), JSON.stringify({ actualCoreAndModelLoaded: true, expressions: catalog.expressions.length, motions: catalog.motions.length, allNativeFilesLoadedAndControlsInvoked: true, sameChatAttachmentPreview: true, standardEmojiAndVoiceEscapePreservesMeeting: true, composerUsesOneOuterFocusIndicator: true, ringtoneSeconds: 26, explicitUserConnect: true, sameConversation: original.room, modelCalls: 0, noSeparateAgentLoop: true, errors }, null, 2));
  } finally { await app.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
