import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBrowserApi, BrowserRequest } from '../../src/shared/browser';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { electronLaunchEnv, resolveElectronExecutablePath } from './electron-test-helpers';
import { BUILTIN_BOT_COMPANIONS } from '../../src/shared/builtin-bot-companions';

async function removeProfile(profile: string) {
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-browser-apps-')) throw Error('Unexpected browser-apps cleanup path');
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
// eslint-disable-next-line no-empty-pattern -- This test owns a real Electron browser and actual UI.
test('compact apps choose one background tab, replace it, and route the original authenticated native page to the companion', async ({}, testInfo) => {
  test.skip(Boolean(process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE), 'Source integration fixture'); test.setTimeout(120000);
  testInfo.annotations.push({ type: 'boundary', description: 'Real BotWorkspace, BrowserService, native Chromium, SQLite and authenticated Agent callbacks. The Agent response is deterministic; this does not measure model quality.' });
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-browser-apps-'));
  const output = path.resolve('.tools/browser-apps-acceptance'); await mkdir(output, { recursive: true });
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true }, build: { ssr: path.resolve('tests/fixtures/browser-apps/main.ts'), outDir: output, emptyOutDir: false, target: 'node24', rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
  await build({ configFile: false, logLevel: 'error', build: { lib: { entry: path.resolve('tests/fixtures/browser-apps/preload.ts'), formats: ['cjs'], fileName: () => 'preload.cjs' }, outDir: output, emptyOutDir: false, rollupOptions: { external: ['electron'] } } });
  await build({ configFile: false, logLevel: 'error', root: path.resolve('tests/fixtures/browser-apps'), base: './', publicDir: false, plugins: [react()], build: { outDir: path.join(output, 'renderer'), emptyOutDir: false } });
  for (const actor of BUILTIN_BOT_COMPANIONS) {
    const portrait = path.join(output, 'renderer', actor.portrait.url); await mkdir(path.dirname(portrait), { recursive: true }); await copyFile(path.resolve('public', actor.portrait.url), portrait);
  }
  const server = createServer((request, response) => {
    if (request.url === '/login') { response.writeHead(302, { 'set-cookie': 'chosen_page=authenticated; HttpOnly; Path=/', location: '/alpha' }); response.end(); return; }
    const alpha = request.url === '/alpha'; response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<title>${alpha ? 'Alpha 工作台' : 'Beta 文档'}</title><h1>${alpha ? 'ALPHA_ONLY' : 'BETA_ONLY'}</h1><p>${request.headers.cookie?.includes('chosen_page=authenticated') ? 'SIGNED_IN' : 'GUEST'}</p>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw Error('No fixture port');
  const origin = `http://127.0.0.1:${address.port}`;
  const app = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [path.join(output, 'main.cjs')], env: electronLaunchEnv({ WORLDLINEBOX_BROWSER_APPS_PROFILE: profile }) });
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    type Bridge = { browser: WorldlineBoxBrowserApi; bot: WorldlineBoxBotApi; proof(): Promise<{ calls: Array<{ tabId: string; result: unknown }> }> };
    const browser = (input: BrowserRequest) => page.evaluate(input => (Reflect.get(window, 'browserAppsFixture') as Bridge).browser.request(input), input);
    await browser({ type: 'tab.new', url: origin + '/login' });
    await expect.poll(async () => { const value = await browser({ type: 'state' }); return value.ok && value.state?.tabs.some(tab => tab.title === 'Alpha 工作台' && !tab.loading); }).toBe(true);
    await browser({ type: 'tab.new', url: origin + '/beta' });
    await expect.poll(async () => { const value = await browser({ type: 'state' }); return value.ok && value.state?.tabs.some(tab => tab.title === 'Beta 文档' && !tab.loading); }).toBe(true);
    const state = await browser({ type: 'state' }); if (!state.ok) throw Error(state.error);
    const active = state.state!.activeTabId, alpha = state.state!.tabs.find(tab => tab.title === 'Alpha 工作台')!.id;
    await page.getByRole('button', { name: '应用', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '连接应用' });
    const size = await picker.boundingBox(); expect(size!.height).toBeLessThan(65);
    expect(await picker.locator('.bot-app-choice>.bot-icon').evaluateAll(items => items.every(item => item.getBoundingClientRect().width <= 18))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('compact-apps.png') });
    await picker.getByRole('button', { name: '内置浏览器', exact: true }).click();
    await expect(picker.getByRole('option')).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath('tab-picker.png') });
    await picker.getByRole('option', { name: /Alpha 工作台/ }).click();
    await expect(page.locator('.bot-composer-dock [data-browser-context-tab]')).toHaveAttribute('data-browser-context-tab', alpha);
    const after = await browser({ type: 'state' }); expect(after.ok && after.state?.activeTabId).toBe(active);
    const send = async (text: string) => { await page.locator('.bot-composer textarea').fill(text); await page.locator('.bot-send').click(); await expect(page.locator('.bot-message-text').last()).toContainText(text === '读取 Alpha' ? 'ALPHA_ONLY' : 'BETA_ONLY', { timeout: 20000 }); };
    await send('读取 Alpha');
    await page.getByRole('button', { name: '应用', exact: true }).click(); await picker.getByRole('button', { name: '内置浏览器', exact: true }).click();
    await picker.getByRole('option', { name: /Beta 文档/ }).click();
    await expect(picker).toHaveCount(0);
    await expect(page.locator('.bot-composer-dock [data-browser-context-tab]')).toHaveCount(1);
    await expect(page.locator('.bot-composer-dock [data-browser-context-tab]')).toHaveAttribute('data-browser-context-tab', active!);
    await send('读取 Beta');
    const proof = await page.evaluate(() => (Reflect.get(window, 'browserAppsFixture') as Bridge).proof());
    expect(proof.calls).toHaveLength(2); expect(proof.calls[0]!.tabId).toBe(alpha); expect(proof.calls[1]!.tabId).toBe(active);
    expect(JSON.stringify(proof.calls[0]!.result)).toContain('SIGNED_IN'); expect(errors).toEqual([]);
    const evidence = path.resolve('artifacts/browser-apps'); await mkdir(evidence, { recursive: true });
    for (const name of ['compact-apps.png', 'tab-picker.png']) await writeFile(path.join(evidence, name), await readFile(testInfo.outputPath(name)));
    await page.screenshot({ path: path.join(evidence, 'selected-page-replies.png') });
    for (const width of [1024, 900]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 900), width);
      await page.getByRole('button', { name: '应用', exact: true }).click(); await picker.getByRole('button', { name: '内置浏览器', exact: true }).click();
      const bounds = await picker.boundingBox(), viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      await page.keyboard.press('Escape');
    }
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, singlePageAtATime: true, activeTabPreserved: true, authenticatedPageRead: true, viewportWidths: [1400, 1024, 900], ...proof, errors }, null, 2));
  } finally { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await removeProfile(profile); }
});
