import { _electron as electron, expect, test } from '@playwright/test';
import { build } from 'vite';
import { builtinModules } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveElectronExecutablePath } from './electron-test-helpers';

test('the real sandboxed Electron window supports alpha.3 preopened sign-in tabs and scoped clipboard writes', async () => {
  test.setTimeout(60000);
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-browser-contract-'));
  await build({ configFile: false, logLevel: 'error', build: { target: 'node24', minify: false,
    lib: { entry: path.resolve('tests/e2e/fixtures/dsh-workbench-browser-app.ts'), formats: ['cjs'], fileName: () => 'fixture.cjs' },
    outDir: root, emptyOutDir: false, rollupOptions: { external: ['electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`)] } } });
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [path.join(root, 'fixture.cjs')], env: { ...process.env, WORLDLINEBOX_BROWSER_FIXTURE_PROFILE: path.join(root, 'profile') } });
  try {
    const page = await application.firstWindow(); await page.getByRole('button', { name: '模拟网页登录' }).click();
    const fixture = () => application.evaluate(() => {
      const value = (globalThis as unknown as { fixture: { opened: string[]; issues: string[]; canRestoreClipboard: boolean; clipboardMatches(): boolean } }).fixture;
      return { opened: value.opened, issues: value.issues, canRestoreClipboard: value.canRestoreClipboard, clipboardMatches: value.clipboardMatches() };
    });
    await expect.poll(async () => (await fixture()).opened).toEqual(['https://platform.deepseek.com/dsh/authorize?fixture=1']);
    expect((await fixture()).issues).toEqual([]);
    expect(await page.evaluate(async () => (await navigator.permissions.query({ name: 'clipboard-write' as PermissionName })).state)).toBe('granted');
    if ((await fixture()).canRestoreClipboard) {
      await page.bringToFront(); await page.getByRole('button', { name: '复制', exact: true }).click();
      await expect(page.locator('#result')).toHaveText('copied'); expect((await fixture()).clipboardMatches).toBe(true);
    }
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
    await expect.poll(() => application.windows().length).toBe(1);
  } finally {
    await application.evaluate(() => (globalThis as unknown as { fixture: { restoreClipboard(): void } }).fixture.restoreClipboard());
    await application.close(); if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('worldlinebox-browser-contract-')) await rm(root, { recursive: true, force: true });
  }
});
