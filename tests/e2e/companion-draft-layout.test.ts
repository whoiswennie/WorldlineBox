import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Locator } from '@playwright/test';
import { enableCallVisualFixture } from './fixtures/call-visual-binding';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';

// eslint-disable-next-line no-empty-pattern -- Electron owns its page and window fixtures.
test('keeps attachment cards compact and browsable in chat, calls and the desktop pet', async ({}, info) => {
  test.setTimeout(90_000);
  test.skip(process.platform !== 'win32');
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-draft-layout-'));
  const files = [path.resolve('tests/fixtures/media/sensevoice-zh.wav'), path.resolve('public/companion-call/scenes/evening.png')];
  for (let index = 1; index <= 14; index++) {
    const file = path.join(profile, `会议资料与后续安排-${index}.txt`);
    await writeFile(file, String(index)); files.push(file);
  }
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }) });
  const select = (files: string[]) => app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, files);
  const inspect = async (scope: Locator, surface: string) => {
    const tray = scope.getByRole('region', { name: '待发送附件' });
    const expand = tray.getByRole('button', { name: '查看全部 16 个附件' });
    await expect(expand).toBeVisible();
    const count = await tray.getByRole('listitem').count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(3);
    const geometry = await tray.locator('ul').evaluate(list => ({
      width: list.clientWidth, content: list.scrollWidth, height: list.clientHeight,
      first: list.children[0]!.getBoundingClientRect().width,
    }));
    expect(geometry.first).toBeLessThanOrEqual(193);
    expect(geometry.content).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.height).toBeLessThan(180);
    await tray.screenshot({ path: info.outputPath(surface + '-draft.png') });
    await expand.click();
    await expect(tray.getByRole('listitem')).toHaveCount(count);
    const list = scope.page().getByRole('dialog', { name: '待发送附件', exact: true });
    await list.screenshot({ path: info.outputPath(surface + '-attachment-list.png') });
    await list.getByRole('button', { name: '下一页' }).click();
    await list.getByRole('button', { name: '预览 会议资料与后续安排-14.txt' }).click();
  };
  try {
    const page = await app.firstWindow();
    await page.locator('[data-application-module="companions"]').click();
    await expect(async () => {
      await enableCallVisualFixture(app, page);
      await expect(page.getByRole('button', { name: '添加文件', exact: true })).toBeEnabled({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await select([files[0]!]);
    await page.getByRole('button', { name: '添加文件', exact: true }).click();
    const single = page.locator('.bot-draft-file');
    await expect(single).toBeVisible();
    expect((await single.boundingBox())!.width).toBeLessThanOrEqual(193);
    const selectedChat = page.locator('.bot-sidebar .bot-contact.selected');
    await expect(selectedChat).toBeVisible();
    await expect(selectedChat).toHaveCSS('box-shadow', 'none');
    await expect(page.locator('.bot-thread-column .bot-send')).toHaveCSS('background-color', 'rgb(52, 52, 50)');
    const chatSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize());
    for (const width of [1440, 1040]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 720), width);
      const composer = page.locator('.bot-thread-column .bot-composer');
      await expect(composer).toBeVisible();
      const bounds = await composer.boundingBox();
      expect(bounds!.width).toBeLessThanOrEqual(821);
      expect(await composer.evaluate(form => form.scrollWidth <= form.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath('chat-' + width + '.png') });
    }
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size[0]!, size[1]!), chatSize);
    await select(files);
    await page.getByRole('button', { name: '添加文件', exact: true }).click();
    await expect(page.getByRole('button', { name: '查看全部 16 个附件' })).toBeVisible();
    await inspect(page.locator('body'), 'chat');
    await page.getByRole('button', { name: '关闭预览' }).click();
    await page.getByRole('button', { name: '关闭附件列表' }).click();
    const chatMute = page.locator('.bot-thread-column').getByRole('button', { name: '伙伴语音静音' });
    await expect(chatMute).toHaveAttribute('aria-pressed', 'false');
    await chatMute.click();
    await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与大肥鱼会面', exact: true });
    const contender = crypto.randomUUID();
    const claim = (type: 'call.reserve' | 'call.release', sessionId = contender) => page.evaluate(({ type, sessionId }) =>
      (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type, sessionId, conversationId: 'other-room' }),
    { type, sessionId });
    expect((await claim('call.reserve')).ok).toBe(false);
    await claim('call.release');
    expect((await claim('call.reserve')).ok).toBe(false);
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await meeting.getByRole('button', { name: '展开会面输入', exact: true }).click();
    await expect(meeting.getByRole('button', { name: '伙伴语音静音' })).toHaveAttribute('aria-pressed', 'true');
    await meeting.getByRole('button', { name: '添加文件', exact: true }).click();
    await expect(meeting.getByRole('button', { name: '查看全部 16 个附件' })).toBeVisible();
    await inspect(meeting, 'call');
    await page.getByRole('button', { name: '关闭预览' }).click();
    await page.getByRole('button', { name: '关闭附件列表' }).click();
    const opened = app.waitForEvent('window');
    await meeting.getByRole('button', { name: '切换为桌宠', exact: true }).click();
    const pet = await opened;
    if (await pet.getByRole('button', { name: '展开会面输入' }).isVisible()) await pet.getByRole('button', { name: '展开会面输入' }).click();
    await expect(pet.getByRole('region', { name: '待发送附件' })).toBeVisible();
    const petMute = pet.getByRole('button', { name: '伙伴语音静音' });
    await expect(petMute).toHaveAttribute('aria-pressed', 'true');
    await petMute.click();
    await expect(chatMute).toHaveAttribute('aria-pressed', 'false');
    await inspect(pet.locator('body'), 'pet');
    await pet.getByRole('button', { name: '关闭预览' }).click();
    await pet.getByRole('button', { name: '移除 会议资料与后续安排-14.txt' }).click();
    await expect(pet.getByRole('dialog', { name: '待发送附件', exact: true })).toContainText('共 15 个附件');
    await pet.getByRole('button', { name: '关闭附件列表' }).click();
    await expect(pet.getByRole('button', { name: '查看全部 15 个附件' })).toBeVisible();
    expect((await claim('call.reserve')).ok).toBe(false);
    const closed = pet.waitForEvent('close');
    await pet.getByRole('button', { name: '挂断', exact: true }).evaluate((button: HTMLButtonElement) => { setTimeout(() => button.click(), 0); });
    await closed;
    await expect(meeting).toHaveCount(0);
    const claims = await Promise.all([claim('call.reserve'), claim('call.reserve', crypto.randomUUID())]);
    expect(claims.filter(result => result.ok)).toHaveLength(1);
    await page.reload();
    expect((await claim('call.reserve', crypto.randomUUID())).ok).toBe(true);
  } finally {
    await app.close();
    if (path.dirname(profile) === path.resolve(tmpdir()) && path.basename(profile).startsWith('wlb-draft-layout-'))
      await rm(profile, { recursive: true, force: true, maxRetries: 4 });
  }
});
