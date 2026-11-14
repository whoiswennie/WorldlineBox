import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { enableCallVisualFixture } from './fixtures/call-visual-binding';
import { electronLaunchEnv, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

test('plays the packaged ringtone from a fresh profile and stops it when ringing ends', async () => {
  test.setTimeout(90000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-call-ringtone-'));
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }) });
  try {
    const page = await app.firstWindow();
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.getByRole('button', { name: '拨打伙伴电话', exact: true })).toBeDisabled();
    await enableCallVisualFixture(app, page);
    await page.evaluate(() => {
      const AudioElement = window.Audio;
      window.Audio = class extends AudioElement {
        constructor(src?: string) {
          super(src);
          Reflect.set(window, '__ringtone', this);
        }
      };
    });
    await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与大肥鱼会面', exact: true });
    const audio = () => page.evaluate(() => {
      const sound = Reflect.get(window, '__ringtone') as HTMLAudioElement | undefined;
      return sound && { src: sound.getAttribute('src'), paused: sound.paused, error: sound.error?.message,
        time: sound.currentTime, duration: sound.duration, muted: sound.muted };
    });
    await expect(meeting).toContainText('等待你接通');
    await expect.poll(audio).toMatchObject({ paused: false, error: undefined, muted: false });
    await expect.poll(async () => (await audio())?.time ?? 0).toBeGreaterThan(0);
    expect((await audio())?.src).toMatch(/\/companion-call\/ringtones\/dafeiyu\.wav$/);
    if (process.env.WORLDLINEBOX_INCLUDE_PRIVATE_CALL_ASSETS === '1') {
      expect((await audio())?.duration).toBeCloseTo(60);
      await meeting.getByRole('button', { name: '接通', exact: true }).click();
      await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible({ timeout: 30000 });
      await expect(meeting.getByText('正在准备形象…', { exact: true })).toBeHidden({ timeout: 30000 });
      await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible();
      await expect.poll(audio).toMatchObject({ paused: true, src: null });
      await meeting.getByRole('button', { name: '挂断', exact: true }).click();
      await page.locator('.bot-sidebar-tabs').getByRole('tab', { name: /联系人/u }).click();
      await page.locator('.bot-contact').filter({ has: page.getByText('GPT', { exact: true }) }).click();
      await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
      await expect.poll(audio).toMatchObject({ paused: false, error: undefined, muted: false });
      await expect.poll(async () => (await audio())?.time ?? 0).toBeGreaterThan(0);
      expect((await audio())?.src).toMatch(/\/companion-call\/ringtone\.wav$/);
      expect((await audio())?.duration).toBeCloseTo(26);
      return;
    }
    await meeting.getByRole('button', { name: '取消', exact: true }).click();
    await expect.poll(audio).toMatchObject({ paused: true, src: null });
  } finally {
    await app.close();
    removeCompanionTestDirectory(profile);
  }
});

test('imports the creator ZIP and renders Live2D in the packaged call', async () => {
  const archive = process.env.WORLDLINEBOX_TEST_DAFEIYU_ZIP;
  test.skip(!archive, 'Requires a local copy of the creator’s model ZIP.');
  test.setTimeout(120000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-call-import-'));
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }) });
  try {
    const page = await app.firstWindow();
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.getByRole('button', { name: '拨打伙伴电话', exact: true })).toBeDisabled();
    await enableCallVisualFixture(app, page);
    await app.evaluate(({ dialog }, file) => {
      Object.assign(dialog, { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) });
    }, archive!);
    await page.getByRole('button', { name: '角色卡', exact: true }).click();
    await page.getByRole('button', { name: '形象与表演', exact: true }).click();
    const importButton = page.getByRole('button', { name: '导入 Live2D 模型', exact: true });
    await importButton.click();
    await expect(page.getByText('从当前 Live2D 模型读取。伙伴会根据语境选择并播放。', { exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('dialog', { name: '角色卡 · 大肥鱼', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与大肥鱼会面', exact: true });
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible({ timeout: 30000 });
    await expect(meeting.getByText('正在准备形象…', { exact: true })).toBeHidden({ timeout: 30000 });
    await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible();
  } finally {
    await app.close();
    removeCompanionTestDirectory(profile);
  }
});
