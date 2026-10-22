import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import { removeCompanionTestDirectory, companionTestDataRoot, ensureCompanionTestWorkspace, electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';
import { openCompanionWorldWindow } from './companion-world-window-helpers';
import { companionWorldEnvironment } from '../../src/shared/companion-world-engine';

async function request(page: Page, input: CompanionsRequest) {
  const result = await page.evaluate(value => (window as unknown as { worldlinebox: { companions: WorldlineBoxCompanionsApi } }).worldlinebox.companions.request(value), input);
  expect(result.ok, result.error).toBe(true); return result;
}
async function launch(profile: string, gpu: 'software' | 'hardware' = 'software') {
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu }) });
  const page = await application.firstWindow(), win = await application.browserWindow(page);
  await win.evaluate((window, mode) => { window.unmaximize(); window.setSize(1440, 900); window.setFocusable(false); window.setOpacity(0); window.webContents.setBackgroundThrottling(false); if (mode === 'hardware') window.showInactive(); else window.hide(); }, gpu);
  await ensureCompanionTestWorkspace(page);
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
  await page.locator('[data-application-module="companions"]').click();
  return { application, page };
}
function clock(hour: number) { const normalized = (hour + 24) % 24; return Math.floor(normalized).toString().padStart(2, '0') + ':00'; }
function cleanup(directory: string) {
  const absolute = path.resolve(directory);
  if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-world-e2e-')) throw new Error('Refusing cleanup outside the isolated world profile.');
  removeCompanionTestDirectory(absolute);
}
// eslint-disable-next-line no-empty-pattern
test('restores observer scene, camera and follow choice after closing and restarting the app', async ({}) => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-e2e-')), profile = path.join(directory, 'profile');
  let application: ElectronApplication | undefined;
  try {
    const started = await launch(profile); application = started.application; let page = started.page;
    let worldPage = await openCompanionWorldWindow(application, page);
    let world = worldPage.getByRole('region', { name: '伙伴世界', exact: true });
    await expect(world.locator('canvas')).toHaveAttribute('data-world-ready', 'true');
    await world.getByRole('combobox', { name: '观测地点', exact: true }).selectOption('park');
    await world.getByRole('button', { name: '向右旋转世界', exact: true }).click();
    await world.getByRole('button', { name: '放大世界', exact: true }).click();
    const camera = await world.locator('canvas').getAttribute('data-world-camera'); expect(camera).toBeTruthy();
    await world.getByRole('button', { name: '关闭伙伴世界', exact: true }).click();
    worldPage = await openCompanionWorldWindow(application, page);
    world = worldPage.getByRole('region', { name: '伙伴世界', exact: true });
    await expect(world.locator('.companion-world-view')).toHaveAttribute('data-world-scene', 'park');
    await expect(world.locator('canvas')).toHaveAttribute('data-world-camera', /position/);
    const restoredCamera = JSON.parse((await world.locator('canvas').getAttribute('data-world-camera'))!), savedCamera = JSON.parse(camera!);
    expect(restoredCamera.zoom).toBeCloseTo(savedCamera.zoom, 6);
    for (const field of ['position', 'target']) for (const axis of ['x', 'y', 'z']) expect(restoredCamera[field][axis]).toBeCloseTo(savedCamera[field][axis], 6);
    const snapshot = (await request(page, { type: 'world.snapshot' })).world!, actor = snapshot.actors[0]!;
    const resident = snapshot.residents.find(item => item.companionId === actor.companionId)!;
    await world.getByRole('combobox', { name: '观测地点', exact: true }).selectOption(actor.sceneId);
    await world.locator('[data-world-actor="' + actor.companionId + '"]').getByRole('button', { name: '在场景中找到' + resident.name, exact: true }).click();
    await expect(world).toContainText('正在跟随 ' + resident.name);
    await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('companion-world-observer') ?? '{}').followId)).toBe(actor.companionId);
    await application.close(); application = undefined;
    const restarted = await launch(profile); application = restarted.application; page = restarted.page;
    worldPage = await openCompanionWorldWindow(application, page); world = worldPage.getByRole('region', { name: '伙伴世界', exact: true });
    await expect(world).toContainText('正在跟随 ' + resident.name);
    const actual = (await request(page, { type: 'world.snapshot' })).world!.actors.find(item => item.companionId === actor.companionId)!;
    await expect(world.locator('.companion-world-view')).toHaveAttribute('data-world-scene', actual.sceneId);
    await expect(world.locator('canvas')).toHaveAttribute('data-world-ready', 'true');
  } finally { await application?.close().catch(() => undefined); cleanup(directory); }
});
// Electron supplies a real WebGL canvas, UtilityProcess world authority and isolated SQLite profile.
// eslint-disable-next-line no-empty-pattern
test('observes real homes, host-driven bedtime and movement, camera controls and persistent world settings', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const directory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-e2e-')), profile = path.join(directory, 'profile');
  let application: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    const started = await launch(profile); application = started.application; let page = started.page;
    page.on('pageerror', error => errors.push(error.message));
    const contacts = (await request(page, { type: 'state' })).state!.companions;
    // These are the exact homes this fixture later observes. Other built-ins
    // remain dormant; opening a world in production must never activate them.
    const observedOwners = ['deepseek-sister', 'gemini', 'kimi'] as const;
    for (const id of observedOwners) {
      const companion = contacts.find(item => item.id === id)!;
      expect(companion, 'The observed fixture resident must exist: ' + id).toBeDefined();
      if (companion.active === false) await request(page, { type: 'companion.set-active', id, active: true, expectedRevision: companion.revision });
    }
    const sister = contacts.find(companion => companion.id === 'deepseek-sister')!;
    const initial = (await request(page, { type: 'world.snapshot' })).world!;
    expect(initial.settings).toMatchObject({ mode: 'realtime', dayDurationMinutes: 20 });
    expect(initial.scenes.some(scene => scene.kind === 'home' && scene.ownerId === sister.id)).toBe(true);
    for (const id of observedOwners) expect(initial.scenes.some(scene => scene.id === 'home_' + id)).toBe(true);
    // Exercise compressed routines explicitly; the product now defaults to real time.
    await request(page, { type: 'world.configure', expectedRevision: initial.settings.revision, patch: { mode: 'compressed', dayDurationMinutes: 20 } });
    let worldPage = await openCompanionWorldWindow(application, page);
    let world = worldPage.getByRole('region', { name: '伙伴世界', exact: true });
    await expect(world).toBeVisible();
    const scene = world.locator('.companion-world-view');
    // The global observer opens the neighborhood when no view has been saved.
    // Sprite loading is measured in a scene the authority says contains a resident.
    await world.getByRole('combobox', { name: '观测地点', exact: true }).selectOption(initial.actors[0]!.sceneId);
    await expect(scene.locator('canvas')).toHaveAttribute('data-world-ready', 'true');
    await expect.poll(async () => Number(await scene.locator('canvas').getAttribute('data-world-loaded-actors'))).toBeGreaterThan(0);
    await expect(world.getByLabel('世界环境')).toContainText('室外');
    const geometry = await world.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, height: element.clientHeight }));
    expect(geometry.width).toBeGreaterThan(1100); expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1); expect(geometry.height).toBeGreaterThan(700);
    await world.getByRole('button', { name: '放大世界', exact: true }).click(); await world.getByRole('button', { name: '向右旋转世界', exact: true }).click(); await world.getByRole('button', { name: '重置世界视角', exact: true }).click();
    const bedOwner = 'deepseek-sister';
    await world.getByRole('combobox', { name: '观测地点', exact: true }).selectOption('home_' + bedOwner);
    await expect(scene).toHaveAttribute('data-world-scene', 'home_' + bedOwner);
    // This is a real user routine form operation through the public API, not a scene/actor test override.
    const conversation = (await request(page, { type: 'conversation.open', companionId: bedOwner })).conversation!;
    const routine = (await request(page, { type: 'routine.get', companionId: bedOwner, conversationId: conversation.id })).routine!;
    const actual = (await request(page, { type: 'world.snapshot' })).world!;
    await request(page, { type: 'routine.configure', companionId: bedOwner, conversationId: conversation.id, expectedRevision: routine.revision, patch: { sleepAt: clock(actual.clock.hour - 1), wakeAt: clock(actual.clock.hour + 2), meals: [], habits: [] } });
    await expect.poll(async () => (await request(page, { type: 'world.snapshot' })).world!.actors.find(actor => actor.companionId === bedOwner)?.activity, { timeout: 20_000 }).toBe('sleeping');
    await expect(world.locator('[data-world-actor="deepseek-sister"]')).toHaveAttribute('data-world-activity', 'sleeping');
    const host = (await request(page, { type: 'world.snapshot' })).world!;
    const actor = host.actors.find(item => item.companionId === bedOwner)!;
    expect(actor.furnitureId).toBe(bedOwner + '_bed'); expect(actor.route).toEqual([]);
    await expect(world.locator('[data-world-actor="deepseek-sister"]')).toContainText(`位置 ${actor.position.x.toFixed(1)}, ${actor.position.y.toFixed(1)}`);
    await expect.poll(async () => Number(await scene.locator('canvas').getAttribute('data-world-loaded-actors'))).toBeGreaterThan(0);
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true });
    const renderMetrics = () => scene.locator('canvas').evaluate(element => Object.fromEntries(Object.entries((element as HTMLCanvasElement).dataset).filter(([key]) => ['worldFps', 'worldDrawCalls', 'worldTriangles', 'worldTextures', 'worldGeometries', 'worldFrames'].includes(key)).map(([key, value]) => [key, Number(value)])));
    const settledHomeMetrics = async () => {
      await expect(scene).toHaveAttribute('data-world-scene', 'home_' + bedOwner);
      await expect(scene.locator('canvas')).toHaveAttribute('data-world-ready', 'true');
      const firstFrame = (await renderMetrics()).worldFrames ?? 0;
      const sampleStarted = await worldPage.evaluate(() => performance.now());
      // Scene entry rebuilds the shadow map. Exercise normal camera controls
      // until a later metric publication, so both sides sample the same home's
      // ordinary subsequent draws rather than the first scene/shadow pass.
      // Frame count updates on every draw, but drawCalls/triangles publish only
      // once per second. Wait a full publication interval, independently of
      // whether the measured draw-call budget passes.
      await world.getByRole('button', { name: '向左旋转世界', exact: true }).click();
      await expect.poll(async () => {
        const frames = (await renderMetrics()).worldFrames ?? 0;
        const elapsed = await worldPage.evaluate(started => performance.now() - started, sampleStarted);
        const published = elapsed >= 1200 && frames > firstFrame + 2;
        if (!published) await world.getByRole('button', { name: '向右旋转世界', exact: true }).click();
        return published;
      }, { timeout: 15_000, intervals: [250, 250, 500] }).toBe(true);
      return renderMetrics();
    };
    await expect.poll(async () => (await renderMetrics()).worldFrames ?? 0).toBeGreaterThan(2);
    const beforeSwitch = await settledHomeMetrics();
    for (const destination of ['home_gemini', 'home_kimi', 'home_deepseek-sister', 'park', 'home_deepseek-sister']) {
      await world.getByRole('combobox', { name: '观测地点', exact: true }).selectOption(destination); await expect(scene).toHaveAttribute('data-world-scene', destination);
    }
    await expect.poll(async () => (await renderMetrics()).worldFrames ?? 0, { timeout: 15_000 }).toBeGreaterThan((beforeSwitch.worldFrames ?? 0) + 2);
    const afterSwitch = await settledHomeMetrics();
    await testInfo.attach('world-render-metrics', { body: JSON.stringify({ sampleScene: 'home_' + bedOwner, minimumPublicationWindowMs: 1200, beforeSwitch, afterSwitch }, null, 2), contentType: 'application/json' });
    expect(afterSwitch.worldTextures).toBeLessThanOrEqual(beforeSwitch.worldTextures! + 2); expect(afterSwitch.worldGeometries).toBeLessThanOrEqual(beforeSwitch.worldGeometries! + 2); expect(afterSwitch.worldDrawCalls).toBeLessThanOrEqual(26);
    await worldPage.screenshot({ path: path.join(artifacts, 'verified-companion-world-home.png') });
    await world.getByRole('button', { name: '在场景中找到大肥鱼', exact: true }).click();
    await worldPage.screenshot({ path: path.join(artifacts, 'verified-companion-world-detail.png') });
    await world.getByRole('button', { name: '重置世界视角', exact: true }).click();
    await world.getByRole('button', { name: '世界设置', exact: true }).click();
    const settings = world.getByRole('form', { name: '世界时间设置', exact: true });
    await settings.getByRole('radio').nth(1).check(); await settings.getByRole('button', { name: '保存世界设置', exact: true }).click(); await expect(settings).toHaveCount(0);
    await expect.poll(async () => (await request(page, { type: 'world.snapshot' })).world!.settings.mode).toBe('realtime');
    await expect(world).toContainText('跟随现实时间');
    await world.getByRole('combobox', { name: '观测地点', exact: true }).selectOption('park');
    await expect(scene).toHaveAttribute('data-world-scene', 'park');
    await worldPage.screenshot({ path: path.join(artifacts, 'verified-companion-world-neighborhood.png') });
    await world.getByRole('button', { name: '关闭伙伴世界', exact: true }).click(); await expect.poll(() => worldPage.isClosed()).toBe(true);
    await application.close(); application = undefined;
    const restarted = await launch(profile); application = restarted.application; page = restarted.page;
    expect((await request(page, { type: 'world.snapshot' })).world!.settings.mode).toBe('realtime');
    worldPage = await openCompanionWorldWindow(application, page); world = worldPage.getByRole('region', { name: '伙伴世界', exact: true });
    await expect(world).toContainText('跟随现实时间');
    expect(errors).toEqual([]);
  } catch (error) {
    await testInfo.attach('world-renderer-errors', { body: errors.join('\n'), contentType: 'text/plain' });
    if (application) await application.firstWindow().then(page => page.screenshot()).then(buffer => testInfo.attach('world-failure', { body: buffer, contentType: 'image/png' })).catch(() => undefined);
    throw error;
  } finally {
    await application?.close().catch(() => undefined);
    cleanup(directory);
  }
});

// eslint-disable-next-line no-empty-pattern
test('measures the normal GPU renderer with movement, orbit and bounded scene resources', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const directory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-e2e-'));
  let application: ElectronApplication | undefined;
  try {
    const started = await launch(path.join(directory, 'profile'), 'hardware'); application = started.application; const page = started.page;
    const features = await application.evaluate(({ app }) => app.getGPUFeatureStatus());
    const perfPath = path.resolve('.tools/test-output/companions/verified-companion-world-performance.json'); mkdirSync(path.dirname(perfPath), { recursive: true }); writeFileSync(perfPath, JSON.stringify({ features }, null, 2));
    const worldPage = await openCompanionWorldWindow(application, page);
    const world = worldPage.getByRole('region', { name: '伙伴世界', exact: true }), canvas = world.locator('canvas');
    const initial = (await request(page, { type: 'world.snapshot' })).world!, companionId = 'deepseek-sister';
    await world.getByRole('combobox', { name: '观测地点', exact: true }).selectOption(initial.actors.find(actor => actor.companionId === companionId)!.sceneId);
    await expect(canvas).toHaveAttribute('data-world-ready', 'true');
    await expect.poll(async () => Number(await canvas.getAttribute('data-world-loaded-actors')), { timeout: 15_000 }).toBeGreaterThan(0);
    const metrics = () => canvas.evaluate(element => Object.fromEntries(Object.entries((element as HTMLCanvasElement).dataset).filter(([key]) => /^world(Fps|DrawCalls|Triangles|Textures|Geometries|Frames|DrawMs)/.test(key)).map(([key, value]) => [key, Number(value)])));
    await expect.poll(async () => (await metrics()).worldFrames ?? 0, { timeout: 15_000 }).toBeGreaterThan(3);
    const home = await metrics();
    await world.getByRole('button', { name: '向右旋转世界', exact: true }).click(); await world.getByRole('button', { name: '放大世界', exact: true }).click();
    await expect.poll(async () => (await metrics()).worldFrames ?? 0).toBeGreaterThan(home.worldFrames! + 8);
    const orbit = await metrics();
    for (const destination of ['home_gpt', 'home_kimi', 'park', 'home_deepseek-sister']) { await world.getByRole('combobox', { name: '观测地点', exact: true }).selectOption(destination); await expect(world.locator('.companion-world-view')).toHaveAttribute('data-world-scene', destination); }
    await expect.poll(async () => (await metrics()).worldFrames ?? 0).toBeGreaterThan(orbit.worldFrames! + 2);
    const returned = await metrics();
    expect(returned.worldTextures).toBeLessThanOrEqual(8); expect(returned.worldGeometries).toBeLessThanOrEqual(26);
    // Keep one real room mounted while host tools move the same resident and
    // complete distinct poses. This catches retained action textures that a
    // scene-switch-only test would hide behind full scene disposal.
    const conversation = (await request(page, { type: 'conversation.open', companionId })).conversation!, scope = { companionId, conversationId: conversation.id };
    const current = (await request(page, { type: 'world.snapshot' })).world!;
    await request(page, { type: 'world.configure', expectedRevision: current.settings.revision, patch: { mode: 'realtime' } });
    const routine = (await request(page, { type: 'routine.get', ...scope })).routine!;
    await request(page, { type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { wakeAt: clock(current.clock.hour - 8), sleepAt: clock(current.clock.hour + 8), meals: [], habits: [] } });
    const scene = current.scenes.find(scene => scene.ownerId === companionId)!;
    const sameScene: Array<{ action: string; actor: unknown; metrics: Record<string, number> }> = [];
    const actorState = async () => (await request(page, { type: 'world.snapshot' })).world!.actors.find(actor => actor.companionId === companionId)!;
    for (const step of [
      { object: 'kitchen', interaction: 'use', action: 'cook' }, { object: 'habit', interaction: 'study', action: 'read' },
      { object: 'sofa', interaction: 'rest', action: 'rest' }, { object: 'bed', interaction: 'sleep', action: 'sleep' },
      { object: 'kitchen', interaction: 'use', action: 'cook' },
    ] as const) {
      const furniture = scene.objects.find(object => object.kind === step.object)!;
      await request(page, { type: 'world.tool', ...scope, arguments: { action: 'move', destinationId: furniture.id } });
      await expect.poll(async () => { const actor = await actorState(); return !actor.route.length && actor.activity === 'idle' && Math.hypot(actor.position.x - furniture.anchor.x, actor.position.y - furniture.anchor.y) < .01; }, { timeout: 20_000 }).toBe(true);
      await request(page, { type: 'world.tool', ...scope, arguments: { action: 'interact', furnitureId: furniture.id, interaction: step.interaction } });
      await expect.poll(async () => (await actorState()).artAction, { timeout: 10_000 }).toBe(step.action);
      const frameBefore = (await metrics()).worldFrames ?? 0;
      await expect.poll(async () => (await metrics()).worldFrames ?? 0).toBeGreaterThan(frameBefore + 2);
      await expect.poll(async () => Number(await canvas.getAttribute('data-world-loaded-actors'))).toBeGreaterThan(0);
      await expect.poll(async () => (await metrics()).worldTextures).toBeLessThanOrEqual(returned.worldTextures! + 1);
      const actor = await actorState(), measured = await metrics();
      expect(actor.sceneId).toBe(scene.id); expect(actor.artAction).toBe(step.action);
      // A sleeping initial resident hides its floor shadow; standing may upload
      // that one existing shadow geometry for the first time, without a leak.
      expect(measured.worldGeometries).toBeLessThanOrEqual(returned.worldGeometries! + 1);
      await expect(world.locator('.companion-world-view')).toHaveAttribute('data-world-scene', scene.id);
      sameScene.push({ action: step.action, actor, metrics: measured });
    }
    expect(new Set(sameScene.map(item => item.action)).size).toBe(4);
    expect(sameScene.at(-1)!.metrics.worldTextures).toBeLessThanOrEqual(sameScene[0]!.metrics.worldTextures!);
    writeFileSync(perfPath, JSON.stringify({ features, home, orbit, returned, sameScene, visibility: await page.evaluate(() => document.visibilityState) }, null, 2));
    await testInfo.attach('world-hardware-render-metrics', { body: JSON.stringify({ features, home, orbit, returned, sameScene }, null, 2), contentType: 'application/json' });
  } finally { await application?.close().catch(() => undefined); cleanup(directory); }
});

function seedWorldClock(profile: string, virtualAt: number) {
  // This fixture changes a stopped, disposable profile's clock anchor. All subsequent
  // weather, movement, lighting and routines are produced by the real host, never the renderer.
  const script = `const Database=require('better-sqlite3');const db=new Database(process.argv[1]);const row=db.prepare('SELECT data FROM companion_world WHERE id=1').get();const world=JSON.parse(row.data);const now=Date.now();world.settings={...world.settings,revision:world.settings.revision+1,mode:'realtime',timeZone:'UTC'};world.anchors=[{realAt:now,virtualAt:Number(process.argv[2]),settings:world.settings}];world.cursor=now;db.prepare('UPDATE companion_world SET data=? WHERE id=1').run(JSON.stringify(world));db.close();`;
  const result = spawnSync(resolveElectronExecutablePath(), ['-e', script, path.join(companionTestDataRoot(profile), 'messages.sqlite'), String(virtualAt)], { cwd: process.cwd(), env: { ...electronLaunchEnv(), ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
}
function environmentDate(weather: 'clear' | 'rain', hour: number) {
  for (let day = 1; day <= 31; day++) { const at = Date.UTC(2026, 9, day, hour); if (companionWorldEnvironment(at, 'UTC').environment.weather === weather) return at; }
  throw new Error('No deterministic climate fixture found.');
}
// eslint-disable-next-line no-empty-pattern
test('renders daylight, night and rain from actual persisted world clock fixtures', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const directory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-e2e-')), profile = path.join(directory, 'profile');
  let application: ElectronApplication | undefined;
  try {
    const bootstrap = await launch(profile); application = bootstrap.application; await request(bootstrap.page, { type: 'world.snapshot' }); await application.close(); application = undefined;
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true });
    const conditions = [{ weather: 'clear', hour: 12, scene: 'home_deepseek-sister', file: 'verified-companion-world-day.png' }, { weather: 'clear', hour: 0, scene: 'home_deepseek-sister', file: 'verified-companion-world-night.png' }, { weather: 'rain', hour: 12, scene: 'park', file: 'verified-companion-world-rain.png' }] as const;
    for (const condition of conditions) {
      seedWorldClock(profile, environmentDate(condition.weather, condition.hour));
      const started = await launch(profile); application = started.application; const page = started.page;
      const actual = (await request(page, { type: 'world.snapshot' })).world!;
      expect(actual.environment.weather).toBe(condition.weather); expect(actual.clock.daylight).toBe(condition.hour === 12);
      const worldPage = await openCompanionWorldWindow(application, page);
      const world = worldPage.getByRole('region', { name: '伙伴世界', exact: true }); await expect(world).toBeVisible();
      await world.getByRole('combobox', { name: '观测地点', exact: true }).selectOption(condition.scene);
      await expect(world.locator('canvas')).toHaveAttribute('data-world-ready', 'true');
      await expect(world.getByLabel('世界环境')).toContainText(condition.weather === 'rain' ? '下雨' : '晴朗');
      if (condition.scene !== 'park') await expect.poll(async () => Number(await world.locator('canvas').getAttribute('data-world-loaded-actors'))).toBeGreaterThan(0);
      // Homes redraw on pose/light changes; visible rain remains continuous.
      await expect.poll(async () => Number(await world.locator('canvas').getAttribute('data-world-frames'))).toBeGreaterThan(condition.scene === 'park' ? 12 : 2);
      await worldPage.screenshot({ path: path.join(artifacts, condition.file) });
      await application.close(); application = undefined;
    }
  } catch (error) {
    if (application) await application.firstWindow().then(page => page.screenshot()).then(buffer => testInfo.attach('world-climate-failure', { body: buffer, contentType: 'image/png' })).catch(() => undefined);
    throw error;
  } finally { await application?.close().catch(() => undefined); cleanup(directory); }
});
