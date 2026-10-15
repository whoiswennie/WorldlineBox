import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionWorldWindowApi } from '../../src/shared/companion-world-window';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';
type Bridge = Window & { worldlinebox: { companionWorld: CompanionWorldWindowApi; companions?: WorldlineBoxCompanionsApi; llm?: WorldlineBoxLlmApi } };
const finalText = '世界窗口开着时，我们的聊天仍可以完整回复。';
function cleanup(root: string) {
  const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-world-windows-')) throw new Error('Unexpected world observer fixture cleanup path.');
  rmSync(resolved, { recursive: true, force: true });
}
async function observer(application: ElectronApplication, main: Page, sceneId?: string) {
  const opened = application.waitForEvent('window');
  const opening = main.evaluate(target => (window as unknown as Bridge).worldlinebox.companionWorld.open(target ? { sceneId: target } : {}), sceneId);
  const page = await opened, native = await application.browserWindow(page);
  await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 900); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
  expect((await opening).ok).toBe(true); await expect(page.getByRole('region', { name: '伙伴世界', exact: true })).toBeVisible();
  await expect(page.locator('canvas')).toHaveAttribute('data-world-ready', 'true'); return page;
}
// eslint-disable-next-line no-empty-pattern
test('native observer windows share one world, preserve independent cameras and leave chat usable when another observer closes', async ({}, testInfo) => {
  test.setTimeout(120000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-windows-'));
  let primaryRequests = 0, application: ElectronApplication | undefined;
  const server = createServer((request, response) => {
    let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      const payload = JSON.parse(body), context = JSON.parse(payload.messages[1].content); let output: unknown;
      if (context.purpose === 'world_attention') output = { urgency: 'ordinary', confidence: .98, evidence: [context.source.content], reason: '普通聊天无需打断休息。' };
      else if (context.purpose === 'world_decision') output = { action: null, reason: '保持当前生活计划。', appraisals: [] };
      else if (context.purpose === 'memory_query') output = {};
      else if (context.purpose === 'memory_dream') output = { candidates: [], dream: null };
      else if (context.purpose?.startsWith('memory_')) output = { candidates: [] };
      else { primaryRequests++; output = { text: finalText, memories: [] }; }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') }, { gpu: 'software' }) });
    const main = await application.firstWindow(), nativeMain = await application.browserWindow(main);
    await nativeMain.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.hide(); });
    await expect(main.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    await main.evaluate(async baseUrl => {
      const bridge = (window as unknown as Bridge).worldlinebox;
      await bridge.llm!.setConfig({ apiFormat: 'openai_chat', baseUrl, model: 'window-fixture', apiKey: 'fixture-window-key' });
      await bridge.companions!.request({ type: 'conversation.open', companionId: 'deepseek-sister' });
      const world = (await bridge.companions!.request({ type: 'world.snapshot' })).world!;
      await bridge.companions!.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime' } });
      const routine = (await bridge.companions!.request({ type: 'routine.get', companionId: 'deepseek-sister', conversationId: 'private-deepseek-sister' })).routine!;
      const clock = (delta: number) => String((Math.floor(world.clock.hour) + delta + 24) % 24).padStart(2, '0') + ':00';
      await bridge.companions!.request({ type: 'routine.configure', companionId: 'deepseek-sister', conversationId: 'private-deepseek-sister', expectedRevision: routine.revision,
        patch: { timeZone: world.settings.timeZone, wakeAt: clock(-8), sleepAt: clock(8), meals: [], habits: [] } });
    }, 'http://127.0.0.1:' + address.port);
    await main.locator('[data-application-module="companions"]').click(); await main.locator('[data-companion-conversation="private-deepseek-sister"]').click();
    const a = await observer(application, main, 'home_deepseek-sister'), b = await observer(application, main, 'home_deepseek-flash');
    const mainPortrait = await main.locator('[data-companion-conversation="private-deepseek-sister"] .companion-avatar').evaluate(element => {
      const style = getComputedStyle(element); return { size: style.backgroundSize, position: style.backgroundPosition, repeat: style.backgroundRepeat };
    });
    await expect(a.locator('[data-world-actor="deepseek-sister"] .companion-avatar')).toBeVisible();
    expect(await a.locator('[data-world-actor="deepseek-sister"] .companion-avatar').evaluate(element => {
      const style = getComputedStyle(element); return { size: style.backgroundSize, position: style.backgroundPosition, repeat: style.backgroundRepeat };
    })).toEqual(mainPortrait);
    expect(mainPortrait).toEqual({ size: 'cover', position: '50% 50%', repeat: 'no-repeat' });
    await a.getByRole('button', { name: '世界设置', exact: true }).click();
    expect(await a.getByRole('button', { name: '关闭世界设置', exact: true }).evaluate(element => {
      const style = getComputedStyle(element); return { border: style.borderTopWidth, radius: style.borderRadius, width: style.width };
    })).toEqual({ border: '0px', radius: '8px', width: '32px' });
    for (const title of ['保存世界设置', '再想想']) expect(await a.getByRole('button', { name: title, exact: true }).evaluate(element => {
      const style = getComputedStyle(element); return { height: style.minHeight, radius: style.borderRadius, horizontalPadding: style.paddingLeft, font: style.fontFamily };
    })).toEqual({ height: '36px', radius: '8px', horizontalPadding: '20px', font: await a.locator('.companion-world').evaluate(element => getComputedStyle(element).fontFamily) });
    await a.getByRole('button', { name: '关闭世界设置', exact: true }).click();
    for (const page of [a, b]) {
      expect(await page.evaluate(() => Object.keys((window as unknown as Bridge).worldlinebox))).toEqual(['companionWorld']);
      expect(await page.evaluate(async () => { try { await (window as unknown as Bridge).worldlinebox.companionWorld.request({ type: 'message.send' } as never); return false; } catch { return true; } })).toBe(true);
    }
    const ca = await a.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context()), cb = await b.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context());
    expect(ca.context!.observerKey).not.toBe(cb.context!.observerKey); expect(cb.context!.visibleWindowCount).toBe(2);
    expect(Object.keys(ca.context!.companions[0]!)).toEqual(expect.arrayContaining(['id', 'name', 'avatar'])); expect(ca.context!.companions.every(contact => !('persona' in contact) && !('llm' in contact))).toBe(true);
    await expect(a.getByRole('combobox', { name: '观测地点', exact: true })).toHaveValue('home_deepseek-sister');
    await expect(b.getByRole('combobox', { name: '观测地点', exact: true })).toHaveValue('home_deepseek-flash');
    const first = await a.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.request({ type: 'world.snapshot' }));
    await main.waitForTimeout(1400); const second = await b.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.request({ type: 'world.snapshot' }));
    expect(Math.abs((Date.parse(second.world!.clock.virtualNow) - Date.parse(first.world!.clock.virtualNow)) - (Date.parse(second.world!.clock.realNow) - Date.parse(first.world!.clock.realNow)))).toBeLessThan(200);
    await main.getByRole('textbox', { name: '输入消息', exact: true }).fill('两个独立世界窗口打开时，聊天应该仍然正常。');
    await main.getByRole('button', { name: '发送', exact: true }).click();
    await expect(main.locator('[data-companion-messages]')).toContainText(finalText, { timeout: 30000 }); expect(primaryRequests).toBe(1);
    expect(await application.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.type === 'Utility' && (metric.name === 'WorldlineBox Companion Storage' || metric.serviceName === 'WorldlineBox Companion Storage')).length)).toBe(1);
    const nativeB = await application.browserWindow(b);
    await nativeB.evaluate(window => window.minimize());
    await expect.poll(async () => (await b.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context())).context?.visible).toBe(false);
    expect((await a.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context())).context!.visibleWindowCount).toBe(1);
    await nativeB.evaluate(window => { window.restore(); window.showInactive(); });
    await expect.poll(async () => (await a.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context())).context?.visibleWindowCount).toBe(2);
    await expect.poll(() => a.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').sceneId, ca.context!.observerKey)).toBe('home_deepseek-sister');
    await a.close(); expect(main.isClosed()).toBe(false); expect(b.isClosed()).toBe(false);
    expect((await b.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.request({ type: 'world.snapshot' }))).ok).toBe(true);
    const restored = await observer(application, main);
    expect((await restored.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context())).context!.observerKey).toBe(ca.context!.observerKey);
    await expect(restored.getByRole('combobox', { name: '观测地点', exact: true })).toHaveValue('home_deepseek-sister');
    await expect(b.getByRole('combobox', { name: '观测地点', exact: true })).toHaveValue('home_deepseek-flash');
    const artifacts = path.resolve('artifacts/companions'); mkdirSync(artifacts, { recursive: true }); await restored.screenshot({ path: path.join(artifacts, 'verified-world-native-window.png') });
    await testInfo.attach('observer-identity', { body: JSON.stringify({ a: ca.context, b: cb.context, primaryRequests }), contentType: 'application/json' });
  } finally {
    await application?.close().catch(() => undefined); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    cleanup(root);
  }
});
