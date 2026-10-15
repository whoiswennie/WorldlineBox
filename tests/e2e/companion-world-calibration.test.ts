import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import type { CompanionWorldActor } from '../../src/shared/companion-world';
import { worldCharacterArt } from '../../src/shared/companion-world-art';
import { worldAnimationFrame } from '../../src/renderer/companions/world/world-presentation';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';
import { openCompanionWorldWindow } from './companion-world-window-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi } };
async function request(page: Page, input: CompanionsRequest) {
  const result = await page.evaluate(value => (window as unknown as Bridge).worldlinebox.companions.request(value), input);
  expect(result.ok, result.error).toBe(true); return result;
}
const clock = (hour: number) => Math.floor((hour + 24) % 24).toString().padStart(2, '0') + ':00';
function cleanup(root: string) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-world-calibration-')) throw new Error('Unexpected calibration fixture cleanup path.');
  rmSync(resolved, { recursive: true, force: true });
}
type VisualTrace = { frames: { at: number; x: number; y: number }[]; raf: number; stop: boolean };

// eslint-disable-next-line no-empty-pattern
test('received movement converges continuously at the real destination', async ({}, testInfo) => {
  test.setTimeout(60000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-calibration-'));
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') }, { gpu: 'hardware' }) });
    const main = await application.firstWindow(), native = await application.browserWindow(main);
    await native.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.hide(); });
    await main.locator('[data-application-module="companions"]').click();
    const companionId = 'minimax', conversation = (await request(main, { type: 'conversation.open', companionId })).conversation!, scope = { companionId, conversationId: conversation.id };
    const snapshot = (await request(main, { type: 'world.snapshot' })).world!;
    await request(main, { type: 'world.configure', expectedRevision: snapshot.settings.revision, patch: { mode: 'realtime' } });
    const routine = (await request(main, { type: 'routine.get', ...scope })).routine!;
    await request(main, { type: 'routine.configure', ...scope, expectedRevision: routine.revision,
      patch: { timeZone: snapshot.settings.timeZone, wakeAt: clock(snapshot.clock.hour - 8), sleepAt: clock(snapshot.clock.hour + 8), meals: [], habits: [] } });
    const observer = await openCompanionWorldWindow(application, main);
    await observer.getByRole('combobox', { name: '观测地点', exact: true }).selectOption('home_minimax');
    await expect(observer.locator('canvas')).toHaveAttribute('data-world-ready', 'true');
    await expect.poll(async () => Number(await observer.locator('canvas').getAttribute('data-world-loaded-actors'))).toBe(1);
    const label = observer.locator('[data-world-behavior]').first(); await expect(label).toBeVisible();
    await observer.evaluate(() => {
      const trace: VisualTrace = { frames: [], raf: 0, stop: false };
      (window as unknown as { worldMovementTrace: VisualTrace }).worldMovementTrace = trace;
      function tick(at: number) {
        const element = document.querySelector('[data-world-behavior]');
        if (element) { const box = element.getBoundingClientRect(); trace.frames.push({ at, x: box.x, y: box.y }); }
        if (!trace.stop) trace.raf = requestAnimationFrame(tick);
      }
      trace.raf = requestAnimationFrame(tick);
    });
    await request(main, { type: 'world.tool', ...scope, arguments: { action: 'move', destinationId: 'minimax_computer' } });
    await expect.poll(async () => { const value = (await request(main, { type: 'world.snapshot' })).world!.actors.find(actor => actor.companionId === companionId)!; return value.activity === 'idle' && !value.route.length; }, { timeout: 20000 }).toBe(true);
    await expect(observer.locator('[data-world-actor="minimax"]')).toHaveAttribute('data-world-activity', 'idle');
    await observer.waitForTimeout(400);
    const frames = await observer.evaluate(() => { const trace = (window as unknown as { worldMovementTrace: VisualTrace }).worldMovementTrace; trace.stop = true; cancelAnimationFrame(trace.raf); return trace.frames; });
    const moving = frames.flatMap((frame, index) => { const previous = frames[index - 1]; if (!previous) return []; const distance = Math.hypot(frame.x - previous.x, frame.y - previous.y); return distance > .5 ? [{ ...frame, elapsed: frame.at - previous.at, distance }] : []; });
    const maxJump = Math.max(...moving.map(frame => frame.distance));
    const report = { maxJump, movingFrames: moving.length, largestSteps: [...moving].sort((a, b) => b.distance - a.distance).slice(0, 5), arrival: moving.slice(-8) };
    const artifacts = path.resolve('artifacts/companions'); mkdirSync(artifacts, { recursive: true }); writeFileSync(path.join(artifacts, 'verified-world-arrival-continuity.json'), JSON.stringify(report, null, 2));
    await testInfo.attach('actual-arrival-projection', { body: JSON.stringify(report), contentType: 'application/json' });
    expect(moving.length).toBeGreaterThan(10); expect(maxJump).toBeLessThan(24);
  } finally { await application?.close().catch(() => undefined); cleanup(root); }
});

// eslint-disable-next-line no-empty-pattern
test('both corrected sisters stay grounded during real rest, sleep and pending computer replies', async ({}, testInfo) => {
  test.setTimeout(200000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-calibration-'));
  let application: ElectronApplication | undefined, reply: ServerResponse | undefined;
  const errors: string[] = [], samples: unknown[] = [];
  const server = createServer((incoming, response) => {
    let body = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { body += chunk; }); incoming.on('end', () => {
      const payload = JSON.parse(body), context = JSON.parse(payload.messages[1].content);
      let output: unknown;
      if (context.purpose === 'world_decision') output = { action: null, reason: '保持生活计划。', appraisals: [] };
      else if (context.purpose === 'world_attention') output = { urgency: 'ordinary', confidence: .98, evidence: [context.source.content], reason: '无需打断当前作息。' };
      else if (context.purpose === 'memory_query') output = {};
      else if (context.purpose === 'memory_dream') output = { candidates: [], dream: null };
      else if (context.purpose?.startsWith('memory_')) output = { candidates: [] };
      else { reply = response; return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') }, { gpu: 'hardware' }) });
    const main = await application.firstWindow(), native = await application.browserWindow(main);
    await native.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.hide(); });
    await main.locator('[data-application-module="companions"]').click();
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
    await main.evaluate(baseUrl => (window as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', baseUrl, model: 'calibration-fixture', apiKey: 'fixture-calibration-key' }), 'http://127.0.0.1:' + address.port);
    const world = (await request(main, { type: 'world.snapshot' })).world!;
    const companions = (await request(main, { type: 'state' })).state!.companions;
    await request(main, { type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime' } });
    const scopes: Array<{ companionId: string; conversationId: string }> = [];
    for (const companionId of ['deepseek-sister', 'deepseek-flash']) {
      const conversation = (await request(main, { type: 'conversation.open', companionId })).conversation!, scope = { companionId, conversationId: conversation.id };
      const routine = (await request(main, { type: 'routine.get', ...scope })).routine!;
      await request(main, { type: 'routine.configure', ...scope, expectedRevision: routine.revision,
        patch: { timeZone: world.settings.timeZone, wakeAt: clock(world.clock.hour - 8), sleepAt: clock(world.clock.hour + 8), meals: [], habits: [] } });
      scopes.push(scope);
    }
    const observer = await openCompanionWorldWindow(application, main); observer.on('pageerror', error => errors.push(error.message));
    const canvas = observer.locator('canvas'), artifacts = path.resolve('artifacts/companions/world-art-calibration'); mkdirSync(artifacts, { recursive: true });
    const actor = async (id: string) => (await request(main, { type: 'world.snapshot' })).world!.actors.find(value => value.companionId === id)!;
    async function move(scope: typeof scopes[number], furnitureId: string) {
      await request(main, { type: 'world.tool', ...scope, arguments: { action: 'move', destinationId: furnitureId } });
      await expect.poll(async () => { const value = await actor(scope.companionId); return value.route.length === 0 && value.activity === 'idle'; }, { timeout: 25000 }).toBe(true);
    }
    async function capture(value: CompanionWorldActor, action: 'rest' | 'sleep' | 'work') {
      const resident = world.residents.find(item => item.companionId === value.companionId)!;
      await observer.getByRole('combobox', { name: '观测地点', exact: true }).selectOption(value.sceneId);
      await expect.poll(async () => Number(await canvas.getAttribute('data-world-loaded-actors'))).toBe(1);
      await expect(observer.locator(`[data-world-actor="${value.companionId}"]`)).toHaveAttribute('data-world-activity', value.activity);
      await expect(canvas).toHaveAttribute('data-world-pending-textures', '0');
      await observer.getByRole('button', { name: '在场景中找到' + resident.name, exact: true }).click();
      const asset = worldCharacterArt(companions.find(companion => companion.id === value.companionId)!.avatar)!.actions[action]!;
      for (const frame of [0, 1, 2] as const) {
        await expect.poll(() => worldAnimationFrame(value.artStartedAtReal ?? value.activityStartedAtReal, asset.durationMs, asset.playback, Date.now()), { intervals: [25], timeout: 5000 }).toBe(frame);
        await observer.waitForTimeout(70);
        await observer.screenshot({ path: path.join(artifacts, value.companionId + '-' + action + '-live-' + frame + '.png') });
        const current = await actor(value.companionId);
        expect(current.artAction).toBe(action); expect(current.position).toEqual(value.position); expect(current.route).toEqual([]);
        samples.push({ companionId: value.companionId, action, frame, current, camera: await canvas.getAttribute('data-world-camera') });
      }
    }
    for (const scope of scopes) {
      const scene = world.scenes.find(value => value.ownerId === scope.companionId)!;
      for (const [kind, action] of [['sofa', 'rest'], ['bed', 'sleep']] as const) {
        const object = scene.objects.find(value => value.kind === kind)!;
        await move(scope, object.id);
        await request(main, { type: 'world.tool', ...scope, arguments: { action: 'interact', furnitureId: object.id, interaction: action } });
        await expect.poll(async () => (await actor(scope.companionId)).artAction).toBe(action);
        await capture(await actor(scope.companionId), action);
      }
      await move(scope, scope.companionId + '_computer'); reply = undefined;
      await request(main, { type: 'message.send', conversationId: scope.conversationId, content: '请等一下再回答，我想看看你在电脑前回复时的样子。', clientId: 'calibration-reply-' + scope.companionId });
      await expect.poll(() => Boolean(reply), { timeout: 25000 }).toBe(true);
      const working = await actor(scope.companionId); expect(working.activity).toBe('working'); expect(working.artAction).toBe('work');
      await capture(working, 'work');
      reply!.writeHead(200, { 'Content-Type': 'application/json' }); reply!.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: '我已经坐在电脑前啦。', memories: [] }) }, finish_reason: 'stop' }] }));
      await expect.poll(async () => (await actor(scope.companionId)).activity).not.toBe('working');
    }
    expect(errors).toEqual([]);
    writeFileSync(path.join(artifacts, 'live-frame-validation.json'), JSON.stringify({ samples, errors }, null, 2));
    await testInfo.attach('authoritative-pose-samples', { body: JSON.stringify(samples), contentType: 'application/json' });
  } finally {
    reply?.destroy(); await application?.close().catch(() => undefined);
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    cleanup(root);
  }
});
