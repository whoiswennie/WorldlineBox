import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorldWindowApi } from '../../src/shared/companion-world-window';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; companionWorld: CompanionWorldWindowApi; llm: WorldlineBoxLlmApi } };
const residents = ['deepseek-sister', 'deepseek-flash', 'gemini', 'gpt'];
function cleanup(directory: string) { const absolute = path.resolve(directory); if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-world-perf-')) throw new Error('Unexpected profile cleanup target.'); rmSync(absolute, { recursive: true, force: true }); }
async function request(page: Page, input: CompanionsRequest) { const result = await page.evaluate(input => (window as unknown as Bridge).worldlinebox.companions.request(input), input); expect(result.ok, result.error).toBe(true); return result; }
async function open(application: ElectronApplication, main: Page, id: string, index: number) {
  const opened = application.waitForEvent('window');
  const opening = main.evaluate(id => (window as unknown as Bridge).worldlinebox.companionWorld.open({ companionId: id }), id);
  const page = await opened, native = await application.browserWindow(page); expect((await opening).ok).toBe(true);
  await native.evaluate((window, slot) => { window.unmaximize(); window.setSize(1040, 740); window.setPosition(slot % 2 * 820, Math.floor(slot / 2) * 580); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); }, index);
  await expect(page.locator('canvas')).toHaveAttribute('data-world-ready', 'true');
  await expect.poll(async () => Number(await page.locator('canvas').getAttribute('data-world-loaded-actors'))).toBeGreaterThan(0);
  return page;
}
async function capture(page: Page, duration: number) {
  return page.evaluate(duration => new Promise<{ frames: number; warmFrames: number; medianMs: number; p95Ms: number; longFrames: number; metrics: Record<string, string | undefined>; behavior: string | undefined; visibility: string }>(resolve => {
    const canvas = document.querySelector('canvas')!, start = performance.now(), times: number[] = [];
    const observer = new MutationObserver(records => { if (records.some(record => record.attributeName === 'data-world-frames')) times.push(performance.now() - start); });
    observer.observe(canvas, { attributes: true, attributeFilter: ['data-world-frames'] });
    setTimeout(() => {
      observer.disconnect(); const warm = times.filter(at => at >= 600), intervals = warm.slice(1).map((at, index) => at - warm[index]!).sort((a, b) => a - b);
      resolve({ frames: times.length, warmFrames: warm.length, medianMs: intervals[Math.floor(intervals.length / 2)] ?? 0, p95Ms: intervals[Math.floor(intervals.length * .95)] ?? 0,
        longFrames: intervals.filter(value => value > 100).length, metrics: { ...(canvas as HTMLCanvasElement).dataset }, behavior: (document.querySelector('[data-world-behavior]') as HTMLElement | null)?.dataset.worldBehavior, visibility: document.visibilityState });
    }, duration);
  }), duration);
}

// Hardware fixture keeps every observer natively visible (including unfocused
// windows), but transparent to avoid stealing the user's desktop. Counts below
// measure actual Three draw submissions, not RAFs or static-scene target FPS.
// eslint-disable-next-line no-empty-pattern
test('profiles two and four visible independent homes during actual movement while chat remains usable', async ({}, testInfo) => {
  test.setTimeout(210_000);
  const directory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-perf-'));
  let application: ElectronApplication | undefined;
  const server = createServer((incoming, response) => {
    let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', value => { raw += value; }); incoming.on('end', () => {
      try {
        const body = JSON.parse(raw), data = JSON.parse(body.messages[1].content); let output: unknown;
        if (data.purpose === 'world_attention') output = { urgency: 'ordinary', confidence: .98, evidence: [data.source.content], reason: '这是普通聊天。' };
        else if (data.purpose === 'world_decision') output = { action: null, reason: '保持真实生活安排。', appraisals: [] };
        else if (data.purpose === 'memory_query') output = {};
        else if (data.purpose === 'memory_dream') output = { candidates: [], dream: null };
        else if (data.purpose?.startsWith('memory_')) output = { candidates: [] };
        else output = { text: '四处小屋开着时，这条聊天也已完整回复。', memories: [] };
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }));
      } catch { response.writeHead(400); response.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(directory, 'profile') }, { gpu: 'hardware' }) });
    const main = await application.firstWindow(), nativeMain = await application.browserWindow(main);
    await nativeMain.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    await expect(main.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
    await main.evaluate(async baseUrl => { await (window as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', model: 'world-perf-fixture', baseUrl, apiKey: 'fixture-perf-key' }); }, 'http://127.0.0.1:' + address.port);
    const initial = (await request(main, { type: 'world.snapshot' })).world!;
    await request(main, { type: 'world.configure', expectedRevision: initial.settings.revision, patch: { mode: 'realtime' } });
    const scopes = await Promise.all(residents.map(async companionId => {
      const conversation = (await request(main, { type: 'conversation.open', companionId })).conversation!, scope = { companionId, conversationId: conversation.id };
      const routine = (await request(main, { type: 'routine.get', ...scope })).routine!, hour = Math.floor(initial.clock.hour), clock = (delta: number) => String((hour + delta + 24) % 24).padStart(2, '0') + ':00';
      await request(main, { type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: initial.settings.timeZone, wakeAt: clock(-8), sleepAt: clock(8), meals: [], habits: [] } }); return scope;
    }));
    await main.locator('[data-application-module="companions"]').click();
    await main.locator('[data-companion-conversation="' + scopes[0]!.conversationId + '"]').click();
    async function move(ids: string[], suffix: string) { await Promise.all(scopes.filter(scope => ids.includes(scope.companionId)).map(scope => request(main, { type: 'world.tool', ...scope, arguments: { action: 'move', destinationId: scope.companionId + suffix } }))); }
    async function awaitIdle(ids: string[]) { await expect.poll(async () => { const snapshot = (await request(main, { type: 'world.snapshot' })).world!; return ids.every(id => { const actor = snapshot.actors.find(actor => actor.companionId === id)!; return !actor.route.length && actor.activity === 'idle'; }); }, { timeout: 25_000 }).toBe(true); }
    const windows: Page[] = [], phases: unknown[] = [];
    for (const count of [2, 4]) {
      await move(residents.slice(0, count), '_computer'); await awaitIdle(residents.slice(0, count));
      while (windows.length < count) windows.push(await open(application, main, residents[windows.length]!, windows.length));
      const idle = await Promise.all(windows.map(page => capture(page, 2000)));
      for (const item of idle) { expect(item.visibility).toBe('visible'); expect(item.frames).toBeLessThan(24); }
      await move(residents.slice(0, count), '_kitchen');
      await expect.poll(async () => { const snapshot = (await request(main, { type: 'world.snapshot' })).world!; return residents.slice(0, count).every(id => snapshot.actors.find(actor => actor.companionId === id)!.activity === 'walking'); }).toBe(true);
      const moving = await Promise.all(windows.map(page => capture(page, 3600)));
      await testInfo.attach('world-visible-' + count, { body: JSON.stringify({ idle, moving }, null, 2), contentType: 'application/json' });
      for (const item of moving) { expect(item.warmFrames).toBeGreaterThan(45); expect(item.medianMs).toBeLessThan(55); expect(item.p95Ms).toBeLessThan(100); expect(item.visibility).toBe('visible'); }
      phases.push({ count, idle, moving }); await awaitIdle(residents.slice(0, count));
    }
    await main.getByRole('textbox', { name: '输入消息', exact: true }).fill('四个独立小屋都在观察时，主聊天仍可操作。');
    await main.getByRole('button', { name: '发送', exact: true }).click();
    await expect(main.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue('');
    await expect(main.locator('[data-companion-messages]')).toContainText('四处小屋开着时，这条聊天也已完整回复。', { timeout: 30_000 });
    const native = await application.browserWindow(windows[0]!); await native.evaluate(window => window.minimize());
    await expect.poll(async () => (await windows[0]!.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context())).context!.visible).toBe(false);
    const before = Number(await windows[0]!.locator('canvas').getAttribute('data-world-frames'));
    const [hidden, stillVisible] = await Promise.all([capture(windows[0]!, 1600), capture(windows[1]!, 1600)]);
    expect(hidden.frames).toBe(0); expect(Number(await windows[0]!.locator('canvas').getAttribute('data-world-frames'))).toBe(before); expect(stillVisible.frames).toBeGreaterThan(0);
    await native.evaluate(window => { window.restore(); window.showInactive(); });
    await expect.poll(async () => (await windows[0]!.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context())).context!.visible).toBe(true);
    await expect.poll(async () => Number(await windows[0]!.locator('canvas').getAttribute('data-world-frames'))).toBeGreaterThan(before);
    const gpu = await windows[0]!.locator('canvas').evaluate(canvas => { const gl = (canvas as HTMLCanvasElement).getContext('webgl2')!, extension = gl.getExtension('WEBGL_debug_renderer_info'); return extension ? { renderer: gl.getParameter(extension.UNMASKED_RENDERER_WEBGL), vendor: gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) } : {}; });
    const result = { features: await application.evaluate(({ app }) => app.getGPUFeatureStatus()), gpu, opacity: 0, phases, minimized: { hidden, stillVisible } };
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true }); writeFileSync(path.join(artifacts, 'verified-world-multiwindow-performance.json'), JSON.stringify(result, null, 2));
    await testInfo.attach('world-multiwindow-performance', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  } finally {
    await application?.close().catch(() => undefined); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    cleanup(directory);
  }
});
