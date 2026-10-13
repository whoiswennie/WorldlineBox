import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

const notes = [
  '[中文](#cn-v0.2.0-rc.2-community) | [English](#en-v0.2.0-rc.2-community)', '',
  '<h3 id="cn-v0.2.0-rc.2-community">✨ 新增功能</h3>', '',
  '- **命令行管理**：在菜单栏中管理和安装 `dsh` 命令，支持管理插件。',
  '- 在同一工作区内继续使用你的会话与工具。', '',
  '### 🐛 问题修复', '',
  '- 修复新建终端菜单重复列出同名 shell 的问题。',
  '- 修复切换会话时，部分对话无法打开的问题。',
  '- 修复 PowerShell 在完成状态后带有空格时的识别问题。',
  '- 修复从图形入口启动时缺少登录 shell 环境的问题。', '',
  '### 🎨 体验优化', '',
  '- 优化插件管理与工作区的展示体验。',
  '- 保留已有配置，更新后继续使用原来的环境。', '',
  '> 完整说明可在[官方发行页面](https://github.com/deepseek-ai/deepseek-harness/releases)查看。', '',
  '```sh', 'dsh --version', 'dsh --help', '```', '',
  '<h3 id="en-v0.2.0-rc.2-community">✨ Features</h3>', '',
  '- **CLI integration**: manage `dsh` commands and plugins.', '',
  '### 🐛 Fixes', '', '- Improved terminal and session behaviour.',
].join('\n');

async function removeTestProfile(root: string, tempRoot: string) {
  const resolved = await realpath(root);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('worldlinebox-release-notes-')) throw new Error('Unexpected test cleanup target');
  await rm(resolved, { recursive: true, force: true });
}

test('release notes render safely across themes and window sizes, with anchors confined to the reading panel', async () => {
  test.setTimeout(90_000);
  const tempRoot = await realpath(tmpdir());
  const root = await mkdtemp(path.join(tempRoot, 'worldlinebox-release-notes-'));
  const userData = path.join(root, 'user-data');
  const manager = path.join(userData, 'dsh-launcher');
  await mkdir(manager, { recursive: true });
  await writeFile(path.join(manager, 'official-versions.json'), JSON.stringify({
    state: { source: 'cache', stale: false, entries: [{ version: '0.2.0-rc.2', channel: 'rc', recommended: true,
      nodeRange: '^22.19.0 || >=24.0.0', integrity: 'sha512-fixture', publishedAt: '2026-09-29T00:00:00Z',
      releaseUrl: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2', notes }] }, packages: {},
  }));
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()],
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: userData }) });
  try {
    const page = await application.firstWindow();
    const native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setSize(1440, 960); win.hide(); });
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    await page.locator('.launcher-navigation').getByRole('button', { name: '运行版本', exact: true }).click();
    const article = page.locator('[data-dsh-version="0.2.0-rc.2"]');
    await article.locator('summary').click();
    const body = article.locator('.launcher-release-notes-body');
    await expect(body.getByRole('heading', { name: '✨ 新增功能', exact: true })).toBeVisible();
    await expect(body.locator('ul strong').first()).toHaveText('命令行管理');
    await expect(body.locator('code').first()).toHaveText('dsh');
    await expect(body).not.toContainText('<h3');
    const initialScroll = await page.locator('.launcher-main').evaluate(node => node.scrollTop);
    await article.getByRole('button', { name: 'English', exact: true }).click();
    await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
    await expect(body.getByRole('heading', { name: '✨ Features', exact: true })).toBeInViewport();
    expect(await page.locator('.launcher-main').evaluate(node => node.scrollTop)).toBe(initialScroll);
    await article.getByRole('button', { name: '中文', exact: true }).click();
    await expect.poll(() => body.evaluate(node => node.scrollTop)).toBe(0);

    for (const [theme, width, height] of [['light', 1440, 960], ['dark', 1280, 850]] as const) {
      await native.evaluate((win, size) => win.setSize(size.width, size.height), { width, height });
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const settings = page.getByRole('dialog', { name: '通用设置', exact: true });
      await settings.getByRole('tab', { name: '外观', exact: true }).click();
      await settings.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
      await settings.getByRole('radio', { name: theme === 'light' ? '亮色' : '暗色', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(settings).toHaveCount(0);
      const geometry = await article.evaluate(node => {
        const notes = node.querySelector('.launcher-release-notes')!;
        const panel = node.querySelector('.launcher-release-notes-body')!;
        return { card: node.getBoundingClientRect().width, notes: notes.getBoundingClientRect().width,
          overflow: panel.scrollWidth > panel.clientWidth, titleSize: getComputedStyle(panel.querySelector('h6')!).fontWeight };
      });
      expect(geometry.notes).toBeGreaterThan(geometry.card * 0.9);
      expect(geometry.overflow).toBe(false);
      expect(Number(geometry.titleSize)).toBeGreaterThanOrEqual(600);
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      await page.screenshot({ path: test.info().outputPath(`release-notes-${theme}.png`) });
    }
  } finally {
    await application.close();
    // Delete only this test's new profile, never a shared user profile or linked path.
    await removeTestProfile(root, tempRoot);
  }
});
