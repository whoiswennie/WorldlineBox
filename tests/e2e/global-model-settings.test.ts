import { _electron as electron, expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

test('edits, tests and saves connections separately from analysis, preserves drafts, and fits global-model themes', async ({ browserName: _browserName }, testInfo) => {
  void _browserName;
  test.setTimeout(180000);
  const requests: Array<{ model: string; authorization?: string }> = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'ui-model-a' }, { id: 'ui-model-b' }] })); return; }
    let body = ''; req.on('data', chunk => { body += String(chunk); }); req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { model?: string };
      requests.push({ model: parsed.model ?? '', authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const parent = await realpath(tmpdir()), root = await mkdtemp(path.join(parent, 'worldlinebox-model-ui-'));
  const userData = path.join(root, 'user-data'); await mkdir(userData);
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()],
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: userData, WORLDLINEBOX_USER_DATA_PATH: userData }) });
  try {
    const page = await application.firstWindow();
    const native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setMinimumSize(640, 480); win.setSize(1440, 960); win.hide(); win.webContents.setBackgroundThrottling(false);
      const frames = { paints: 0 }; Reflect.set(globalThis, '__globalModelFrames', frames); win.webContents.on('paint', () => { frames.paints++; }); });
    await page.evaluate(async value => {
      const api = (window as unknown as { worldlinebox: { llm: WorldlineBoxLlmApi } }).worldlinebox.llm;
      const result = await api.setConfig({ apiFormat: 'openai_chat', baseUrl: value.baseUrl, model: 'ui-model-a', apiKey: 'local-ui-model-key-never-send-upstream' });
      if (!result.ok) throw new Error('Cannot seed local connection');
    }, { baseUrl });
    const open = async (model = 'ui-model-a') => {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const panel = page.getByRole('dialog', { name: '通用设置', exact: true });
      await panel.getByRole('tab', { name: '全局模型', exact: true }).click();
      await expect(panel.getByRole('tab', { name: '全局模型', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(panel.locator('#ai-config-model')).toHaveValue(model); return panel;
    };
    let settings = await open();
    await expect(settings.locator('.ai-config-draft-status')).toHaveText('配置已保存');
    await expect(settings.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
    const originalProfileId = await settings.locator('#ai-config-profile').getAttribute('data-value');
    await settings.getByRole('button', { name: '新建', exact: true }).click();
    await expect(settings.locator('#ai-config-api-format')).toHaveAttribute('data-value', 'openai_chat');
    await expect(settings.locator('#ai-config-base-url')).toHaveValue('https://api.deepseek.com');
    await expect(settings.locator('#ai-config-model')).toHaveValue('deepseek-flash');
    await expect(settings.locator('#ai-config-api-key')).toHaveValue('');
    await settings.locator('#ai-config-profile').click();
    await page.getByRole('listbox').locator(`[role="option"][data-value="${originalProfileId}"]`).click();
    await expect(settings.locator('#ai-config-model')).toHaveValue('ui-model-a');
    await settings.locator('#ai-config-model').fill('ui-model-b');
    await expect(settings.locator('.ai-config-draft-status')).toHaveText('有未保存的修改');
    await settings.getByRole('button', { name: '新建', exact: true }).click();
    await expect(settings.getByRole('alert')).toContainText('未保存');
    await settings.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(settings.locator('#ai-config-model')).toHaveValue('ui-model-b');
    await settings.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect.poll(() => requests.some(value => value.model === 'ui-model-b' && value.authorization === 'Bearer local-ui-model-key-never-send-upstream')).toBe(true);
    const current = await page.evaluate(() => (window as unknown as { worldlinebox: { llm: WorldlineBoxLlmApi } }).worldlinebox.llm.getConfig());
    expect(current).toMatchObject({ ok: true, value: { model: 'ui-model-a' } });
    await settings.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(settings.locator('.ai-config-draft-status')).toHaveText('配置已保存');
    await expect(settings.locator('.ai-config-current-profile')).toContainText('ui-model-b');
    await settings.locator('.ai-config-asset-options > summary').click();
    // Consent is a deliberate separate choice for asset uploads.
    await settings.locator('.ai-config-consent input').first().check(); await settings.getByLabel('新增资产自动进行AI分析', { exact: true }).check();
    await settings.getByRole('button', { name: '保存分析选项', exact: true }).click();
    await expect(settings.locator('.ai-config-analysis-actions')).toContainText('分析选项已保存');
    const saved = await page.evaluate(() => (window as unknown as { worldlinebox: { llm: WorldlineBoxLlmApi } }).worldlinebox.llm.getConfig());
    expect(saved).toMatchObject({ ok: true, value: { model: 'ui-model-b', autoAnalyzeEnabled: true } });
    const json = await readFile(path.join(userData, 'ai-profiles.json'), 'utf8'); expect(json).not.toContain('local-ui-model-key-never-send-upstream');
    await settings.locator('.ai-config-asset-options > summary').click();
    const evidence = path.resolve('artifacts/global-model-settings'); await mkdir(evidence, { recursive: true });
    for (const [theme, preset, width, height, fontScale] of [['light', 'worldlinebox', 1440, 960, 1], ['dark', 'worldlinebox', 850, 720, 1], ['light', 'worldlinebox', 1200, 950, 1.3], ['dark', 'worldlinebox', 850, 720, 1.3], ['light', 'shuimo-danqing', 1440, 960, 1]] as const) {
      await native.evaluate((win, size) => { win.setSize(size.width, size.height); }, { width, height });
      await page.evaluate(value => {
        localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: value.theme }));
        localStorage.setItem('worldlinebox.theme-profile.v3', JSON.stringify({ version: 3, preset: value.preset, overrides: {} }));
      }, { theme, preset });
      await page.reload(); settings = await open('ui-model-b');
      await page.evaluate(scale => { document.documentElement.style.setProperty('--ui-font-scale', String(scale)); }, fontScale);
      await expect(settings.locator('#ai-config-model')).toHaveValue('ui-model-b');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(settings.locator('.global-model-local-section')).toContainText('本地模型与设备');
      const overflow = await settings.evaluate(element => [...element.querySelectorAll<HTMLElement>('.ai-config-connection-section, .ai-config-profile-row, .ai-config-connection-fields, .ai-config-connection-actions')].filter(value => value.scrollWidth > value.clientWidth + 2).map(value => value.className));
      expect(overflow).toEqual([]);
      await settings.locator('.app-settings-content').evaluate(element => { element.scrollTop = 0; });
      await expect(settings.getByRole('button', { name: '保存配置', exact: true })).toBeInViewport({ ratio: 1 });
      const intersections = await settings.locator('.ai-config-connection-section').evaluate(element => {
        const actions = element.querySelector<HTMLElement>('.ai-config-connection-actions')!.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>('.ai-config-connection-fields input, .ai-config-connection-fields button')].filter(field => {
          const bounds = field.getBoundingClientRect(); return Math.min(actions.right, bounds.right) - Math.max(actions.left, bounds.left) > 1
            && Math.min(actions.bottom, bounds.bottom) - Math.max(actions.top, bounds.top) > 1;
        }).map(field => field.id || field.className);
      }); expect(intersections).toEqual([]);
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      const before = await native.evaluate(win => { const count = (Reflect.get(globalThis, '__globalModelFrames') as { paints: number }).paints; win.webContents.invalidate(); return count; });
      await expect.poll(() => native.evaluate(() => (Reflect.get(globalThis, '__globalModelFrames') as { paints: number }).paints)).toBeGreaterThan(before);
      const screenshot = await native.evaluate(async win => (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const filename = `global-model-${preset}-${theme}-${width}${fontScale === 1 ? '' : '-large-type'}.png`, output = path.join(evidence, filename);
      await writeFile(output, Buffer.from(screenshot, 'base64')); await testInfo.attach(filename, { path: output, contentType: 'image/png' });
    }
  } finally {
    await application.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    const resolved = await realpath(root); expect(path.dirname(resolved)).toBe(parent); expect(path.basename(resolved)).toMatch(/^worldlinebox-model-ui-/);
    await rm(resolved, { recursive: true, force: true });
  }
});
