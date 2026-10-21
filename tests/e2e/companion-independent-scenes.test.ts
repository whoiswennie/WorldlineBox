import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorldWindowApi } from '../../src/shared/companion-world-window';
import { removeCompanionTestDirectory, ensureCompanionTestWorkspace, electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; companionWorld: CompanionWorldWindowApi } };
test('explicit activation, simulation time, peer observation and independent scene resource release', async () => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(path.join(tmpdir(), 'worldlinebox-independent-scenes-'));
  const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true });
if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('worldlinebox-independent-scenes-')) throw new Error('Unexpected fixture cleanup path');
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'software' }) });
    const main = await application.firstWindow(), native = await application.browserWindow(main);
    await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 900); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    await ensureCompanionTestWorkspace(main);
    await expect(main.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 60_000 });
    const initial = await main.evaluate(() => (window as unknown as Bridge).worldlinebox.companions.request({ type: 'state' }));
    expect(initial.state!.companions.filter(role => role.active).map(role => role.id)).toEqual(['deepseek-flash']);
    await main.locator('[data-application-module="companions"]').click();
    await main.getByRole('button', { name: '联系人', exact: true }).click();
    await main.locator('[data-companion-contact="deepseek-sister"]').click();
    await expect(main.getByRole('button', { name: '激活伙伴', exact: true })).toBeVisible();
    await expect.poll(() => main.locator('.companions-activation').evaluate(section => {
      const title = section.querySelector('h3')!.getBoundingClientRect();
      const status = section.querySelector('.companions-activation-status')!.getBoundingClientRect();
      const description = section.querySelector('p')!.getBoundingClientRect();
      const buttons = [...section.querySelectorAll('button')].map(button => button.getBoundingClientRect());
      return Math.abs(title.y + title.height / 2 - status.y - status.height / 2) < .5
        && Math.abs(title.x - description.x) < .5 && Math.abs(buttons[0]!.x - title.x) < .5
        && Math.abs(buttons[0]!.y - buttons[1]!.y) < .5 && Math.abs(buttons[0]!.height - buttons[1]!.height) < .5
        && Math.abs(buttons[0]!.width - buttons[1]!.width) < .5;
    })).toBe(true);
    await main.screenshot({ path: path.join(artifacts, 'verified-independent-contact-dormant.png') });
    await main.locator('.companions-activation').screenshot({ path: path.join(artifacts, 'verified-contact-life-aligned.png') });
    const opening = application.waitForEvent('window');
    expect((await main.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.open({ companionId: 'deepseek-sister' }))).ok).toBe(true);
    const observer = await opening, nativeObserver = await application.browserWindow(observer);
    await nativeObserver.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    await expect(observer.getByText('虚拟世界未加载，也不会进行后台活动。', { exact: true })).toBeVisible();
    expect(await observer.locator('canvas').count()).toBe(0);
    await main.getByRole('button', { name: '激活伙伴', exact: true }).click();
    await expect(observer.locator('canvas')).toHaveAttribute('data-world-ready', 'true', { timeout: 30_000 });
    await main.evaluate(async () => {
      const api = (window as unknown as Bridge).worldlinebox.companions;
      const world = (await api.request({ type: 'world.snapshot' })).world!;
      await api.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'compressed', dayDurationMinutes: 20 } });
      const hh = Math.floor(world.clock.hour), at = (delta: number) => String((hh + delta + 24) % 24).padStart(2, '0') + ':00';
      for (const companionId of ['deepseek-flash', 'deepseek-sister']) {
        const conversationId = (await api.request({ type: 'conversation.open', companionId })).conversation!.id;
        const routine = (await api.request({ type: 'routine.get', companionId, conversationId })).routine!;
        await api.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision, patch: { wakeAt: at(-8), sleepAt: at(10), meals: [], habits: [] } });
      }
    });
    await main.getByRole('button', { name: '让伙伴休眠', exact: true }).click();
    await expect(observer.locator('canvas')).toHaveCount(0);
    await main.locator('[data-companion-contact="deepseek-flash"]').click();
    await main.getByRole('button', { name: '发消息', exact: true }).click();
    await expect(main.getByLabel('虚拟世界时间', { exact: true })).toBeVisible();
    await expect(main.getByLabel('虚拟世界时间', { exact: true })).toHaveAttribute('datetime', /T/);
    await expect(main.getByLabel('虚拟世界天气', { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const status = await main.evaluate(() => (window as unknown as Bridge).worldlinebox.companions.request({ type: 'world.status', companionIds: ['deepseek-flash'] }));
      const weather = status.worldStatus?.environment?.weather;
      return !!weather && (await main.getByLabel('虚拟世界天气', { exact: true }).innerText()).includes({ clear: '晴朗', cloudy: '多云', rain: '下雨', snow: '下雪' }[weather]);
    }).toBe(true);
    await expect(main.locator('.companions-chat > .companions-world-activity')).toHaveCount(0);
    await expect(main.locator('.companions-header-actions .companions-world-activity')).toHaveCount(1);
    await expect(main.locator('.companions-world-activity > span')).toHaveCount(0);
    const clockBefore = await main.getByLabel('虚拟世界时间', { exact: true }).getAttribute('datetime');
    await expect.poll(async () => Date.parse((await main.getByLabel('虚拟世界时间', { exact: true }).getAttribute('datetime'))!) - Date.parse(clockBefore!)).toBeGreaterThan(30_000);
    await main.evaluate(async () => {
      const api = (window as unknown as Bridge).worldlinebox.companions;
      await api.request({ type: 'world.tool', companionId: 'deepseek-flash', conversationId: 'private-deepseek-flash', arguments: { action: 'message', recipientIds: ['deepseek-sister'], text: '想找你玩，方便时回我就好。' } });
    });
    await expect(main.getByLabel('查看此伙伴的交互', { exact: true })).toContainText('大肥鱼', { timeout: 15_000 });
    await main.screenshot({ path: path.join(artifacts, 'verified-independent-world-clock-and-interaction.png') });
    await main.locator('.companions-chat-header').screenshot({ path: path.join(artifacts, 'verified-chat-header-compact.png') });
    await main.getByLabel('查看此伙伴的交互', { exact: true }).click();
    await expect(main.getByRole('dialog', { name: '伙伴社交观察', exact: true })).toBeVisible();
    await expect(main.getByRole('combobox', { name: '社交图谱中心伙伴', exact: true })).toHaveValue('deepseek-flash');
    await main.screenshot({ path: path.join(artifacts, 'verified-independent-peer-observation.png') });
    await observer.screenshot({ path: path.join(artifacts, 'verified-independent-world-unloaded.png') });
    await main.getByRole('button', { name: '关闭社交观察', exact: true }).click();
    await native.evaluate(window => window.setSize(1080, 840));
    await main.screenshot({ path: path.join(artifacts, 'verified-world-header-narrow.png') });
    await expect.poll(() => main.evaluate(() => {
      const clock = document.querySelector('.companions-world-clock')!.getBoundingClientRect();
      const name = document.querySelector('.companions-chat-name')!.getBoundingClientRect();
      const header = document.querySelector('.companions-chat-header')!.getBoundingClientRect();
      const activityElement = document.querySelector('.companions-world-activity')!;
      const activity = activityElement.getBoundingClientRect();
      const actions = document.querySelector('.companions-header-actions')!.getBoundingClientRect();
      const weather = document.querySelector('.companions-world-weather')!.getBoundingClientRect();
      return !!activityElement.closest('.companions-header-actions') && clock.bottom <= header.bottom
        && clock.right <= actions.left && weather.right <= actions.left && activity.bottom <= header.bottom && Math.abs(clock.left - name.left) < .5;
    })).toBe(true);
    await main.screenshot({ path: path.join(artifacts, 'verified-world-header-narrow.png') });
    await main.getByRole('button', { name: '我们之间', exact: true }).click();
    await expect(main.locator('.companions-chat-layout')).toHaveClass(/has-panel/);
    await main.screenshot({ path: path.join(artifacts, 'verified-world-header-with-journal.png') });
    await main.getByRole('button', { name: '我们之间', exact: true }).click();
    await native.evaluate(window => window.setSize(1440, 900));
    await main.getByRole('button', { name: '设置', exact: true }).click();
    const settings = main.getByRole('dialog', { name: '通用设置', exact: true });
    await settings.getByRole('tab', { name: '外观', exact: true }).click();
    await settings.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
    await settings.getByRole('radio', { name: '暗色', exact: true }).click();
    await main.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    await native.evaluate(window => window.setSize(1080, 840));
    await main.screenshot({ path: path.join(artifacts, 'verified-world-header-narrow-dark.png') });
  } finally {
    await application?.close();
    removeCompanionTestDirectory(profile);
  }
});
