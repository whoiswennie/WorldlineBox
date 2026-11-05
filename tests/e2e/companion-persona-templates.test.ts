import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Electron owns the application page.
test('manages saved personas through actual packaged IPC without changing another companion', async ({}, testInfo) => {
  test.setTimeout(120000);
  testInfo.annotations.push({ type: 'isolated-persona-management', description: 'Actual renderer, Main IPC and SQLite persistence; no DSH or paid model. Model prompt injection is covered by the App service local-SSE integration test.' });
  const prefix = 'wlb-persona-ui-', profile = await mkdtemp(path.join(tmpdir(), prefix));
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith(prefix) || (await lstat(profile)).isSymbolicLink() || path.resolve(await realpath(profile)) !== path.resolve(profile)) throw new Error('Unexpected persona test profile');
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  try {
    const page = await application.firstWindow();
    const identity = await application.evaluate(({ app, BrowserWindow }, expectedProfile) => {
      if (app.getPath('userData') !== expectedProfile) throw new Error('Persona acceptance must not use a production profile');
      const frames = { paints: 0 }; Reflect.set(globalThis, '__personaUiFrames', frames);
      for (const window of BrowserWindow.getAllWindows()) { window.on('show', () => window.hide()); window.webContents.setBackgroundThrottling(false); window.webContents.on('paint', () => { frames.paints++; }); window.setMinimumSize(0, 0); window.setSize(1440, 960); window.hide(); }
      return { packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData'), offscreen: BrowserWindow.getAllWindows()[0]!.webContents.isOffscreen() };
    }, profile);
    expect(identity.offscreen).toBe(true);
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) { expect(identity.packaged).toBe(true); expect(identity.appPath).toMatch(/app\.asar$/u); }
    await writeFile(testInfo.outputPath('persona-identity.json'), JSON.stringify(identity, null, 2));
    await page.evaluate(() => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'light' })));
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    const otherBefore = await page.evaluate(() => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'companion.personas.get', companionId: 'gpt', id: 'default' }));
    expect(otherBefore.ok).toBe(true);
    await page.getByRole('button', { name: '编辑伙伴', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '编辑伙伴 · 大肥鱼', exact: true });
    await expect(dialog).toBeVisible();
    const templates = dialog.locator('.bot-personas');
    await expect(templates.locator('.bot-personas__row')).toHaveCount(5);
    await expect(templates.getByRole('textbox', { name: '人格与相处方式', exact: true })).not.toHaveValue('');
    await templates.getByRole('button', { name: '小女儿大肥鱼 v2', exact: true }).click();
    await expect(templates.getByRole('textbox', { name: '人格与相处方式', exact: true })).toHaveValue(/冰糖/u);
    await expect(templates.getByRole('button', { name: '小女儿大肥鱼 v2 · 使用中', exact: true })).toBeVisible();
    await templates.getByRole('textbox', { name: '模板名称', exact: true }).fill('小女儿 · 日常');
    await templates.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(templates.getByRole('button', { name: '小女儿 · 日常 · 使用中', exact: true })).toBeVisible();
    await templates.getByRole('button', { name: /恢复此内置模板|恢复原始设定/u }).click();
    await expect(templates.getByRole('textbox', { name: '模板名称', exact: true })).toHaveValue('小女儿大肥鱼 v2');
    const evidence = path.resolve('artifacts/superagent-bot-development/ui'); await mkdir(evidence, { recursive: true });
    const capture = async (name: string) => {
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const before = await application.evaluate(({ BrowserWindow }) => { const previous = (Reflect.get(globalThis, '__personaUiFrames') as { paints: number }).paints; BrowserWindow.getAllWindows()[0]!.webContents.invalidate(); return previous; });
      await expect.poll(() => application.evaluate(() => (Reflect.get(globalThis, '__personaUiFrames') as { paints: number }).paints)).toBeGreaterThan(before);
      const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const file = testInfo.outputPath(name); await writeFile(file, Buffer.from(png, 'base64')); await copyFile(file, path.join(evidence, name)); await testInfo.attach(name, { path: file, contentType: 'image/png' });
    };
    await capture('persona-templates-light.png');
    await templates.getByRole('button', { name: '新建模板', exact: true }).click();
    await templates.getByRole('textbox', { name: '模板名称', exact: true }).fill('星海朋友');
    await templates.getByRole('textbox', { name: '人格与相处方式', exact: true }).fill('你是简洁温和的星海朋友。保持伙伴身份，依据真实工具回执交流。');
    const saveNew = templates.getByRole('button', { name: '保存并启用', exact: true });
    await expect(saveNew).toBeEnabled();
    const contrast = await saveNew.evaluate(element => {
      const style = getComputedStyle(element);
      const luminance = (rgb: string) => (rgb.match(/[\d.]+/gu) ?? []).slice(0, 3).map(value => Number(value) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
      const a = luminance(style.color), b = luminance(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await capture('persona-template-new-light.png');
    await templates.getByRole('button', { name: '保存并启用', exact: true }).click();
    await expect(templates.getByRole('button', { name: '星海朋友 · 使用中', exact: true })).toBeVisible();
    await templates.getByRole('textbox', { name: '模板名称', exact: true }).fill('星海老友');
    await templates.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(templates.getByRole('button', { name: '星海老友 · 使用中', exact: true })).toBeVisible();
    await page.reload(); await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '编辑伙伴', exact: true }).click();
    await expect(templates.getByRole('textbox', { name: '模板名称', exact: true })).toHaveValue('星海老友');
    await expect(templates.locator('.bot-personas__row')).toHaveCount(6);
    await templates.getByRole('button', { name: '删除模板', exact: true }).click(); await templates.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(templates.getByRole('button', { name: '默认人格 · 使用中', exact: true })).toBeVisible();
    await expect(templates.locator('.bot-personas__row')).toHaveCount(5);
    await templates.getByRole('button', { name: '魔丸大肥鱼', exact: true }).click();
    await templates.getByRole('button', { name: '删除模板', exact: true }).click(); await templates.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(templates.locator('.bot-personas__row')).toHaveCount(4);
    await templates.getByRole('button', { name: '恢复全部内置模板', exact: true }).click(); await templates.getByRole('button', { name: '确认恢复', exact: true }).click();
    await expect(templates.locator('.bot-personas__row')).toHaveCount(5);
    await expect(templates.getByRole('button', { name: '默认人格 · 使用中', exact: true })).toBeVisible();
    for (const size of [{ width: 1440, height: 960 }, { width: 850, height: 720 }]) {
      await application.evaluate(({ BrowserWindow }, nextSize) => { const window = BrowserWindow.getAllWindows()[0]!; window.setMinimumSize(0, 0); window.setSize(nextSize.width, nextSize.height); }, size);
      await page.evaluate(() => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'dark' })));
      await page.reload(); await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '编辑伙伴', exact: true }).click();
      await expect(templates.locator('.bot-personas__row')).toHaveCount(5);
      const geometry = await dialog.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, panel: element.getBoundingClientRect().toJSON(), footer: element.querySelector('.bot-personas__editor-footer')!.getBoundingClientRect().toJSON() }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width); expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.panel.bottom + 1);
      await capture(size.width > 1000 ? 'persona-templates-dark.png' : 'persona-templates-narrow-dark.png');
    }
    await templates.getByRole('button', { name: '新建模板', exact: true }).click();
    await templates.getByRole('textbox', { name: '模板名称', exact: true }).fill('长文本验收');
    const prompt = templates.getByRole('textbox', { name: '人格与相处方式', exact: true }), longPrompt = '设'.repeat(23998) + '😀';
    await prompt.fill(longPrompt); await expect(prompt).toHaveValue(longPrompt);
    await prompt.dispatchEvent('compositionstart'); await templates.getByRole('button', { name: '保存并启用', exact: true }).click();
    await expect(templates.getByRole('button', { name: '长文本验收 · 使用中', exact: true })).toHaveCount(0);
    await prompt.dispatchEvent('compositionend'); await templates.getByRole('button', { name: '保存并启用', exact: true }).click();
    await expect(templates.getByRole('button', { name: '长文本验收 · 使用中', exact: true })).toBeVisible();
    await expect(prompt).toHaveValue(longPrompt);
    await templates.getByRole('button', { name: '删除模板', exact: true }).click(); await templates.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(templates.getByRole('button', { name: '默认人格 · 使用中', exact: true })).toBeVisible();
    const otherAfter = await page.evaluate(() => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'companion.personas.get', companionId: 'gpt', id: 'default' }));
    expect(otherAfter).toEqual(otherBefore);
  } finally { await application.close(); await rm(profile, { recursive: true, force: true }); }
});
