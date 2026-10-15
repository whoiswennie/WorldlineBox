import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorldWindowApi, CompanionWorldWindowOpen } from '../../src/shared/companion-world-window';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import type { CompanionWorldSnapshot } from '../../src/shared/companion-world';
import { companionWorldCellWalkable, companionWorldEnvironment } from '../../src/shared/companion-world-engine';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath, resolveSessionLogPath } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; companionWorld: CompanionWorldWindowApi; llm: WorldlineBoxLlmApi } };
const output = path.resolve('.tools/test-output/companions');
const finalText = '公共花园和小屋同时观察时，这条消息仍然正常回复。';
function cleanup(directory: string) {
  const absolute = path.resolve(directory);
  if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-world-park-')) throw new Error('Unexpected park fixture cleanup target.');
  rmSync(absolute, { recursive: true, force: true });
}
async function request(page: Page, input: CompanionsRequest) {
  const result = await page.evaluate(value => (window as unknown as Bridge).worldlinebox.companions.request(value), input);
  expect(result.ok, result.error).toBe(true); return result;
}
async function launch(profile: string) {
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'hardware' }) });
  const page = await application.firstWindow(), native = await application.browserWindow(page);
  await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 900); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
  return { application, page };
}
async function observer(application: ElectronApplication, main: Page, target: CompanionWorldWindowOpen, slot = 0) {
  const opened = application.waitForEvent('window');
  const opening = main.evaluate(value => (window as unknown as Bridge).worldlinebox.companionWorld.open(value), target);
  const page = await opened, native = await application.browserWindow(page); expect((await opening).ok).toBe(true);
  await native.evaluate((window, index) => { window.unmaximize(); window.setSize(1440, 900); window.setPosition(index * 100, index * 70); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); }, slot);
  await expect(page.getByRole('region', { name: '伙伴世界', exact: true })).toBeVisible();
  return page;
}
async function frames(page: Page, duration: number) {
  return page.evaluate(duration => new Promise<{ frames: number; warmFrames: number; medianMs: number; p95Ms: number; longFrames: number; metrics: Record<string, string | undefined>; visibility: string }>(resolve => {
    const canvas = document.querySelector('canvas')!, started = performance.now(), samples: number[] = [];
    const observer = new MutationObserver(records => { if (records.some(record => record.attributeName === 'data-world-frames')) samples.push(performance.now() - started); });
    observer.observe(canvas, { attributes: true, attributeFilter: ['data-world-frames'] });
    setTimeout(() => {
      observer.disconnect(); const warm = samples.filter(at => at >= 600), intervals = warm.slice(1).map((at, index) => at - warm[index]!).sort((a, b) => a - b);
      resolve({ frames: samples.length, warmFrames: warm.length, medianMs: intervals[Math.floor(intervals.length / 2)] ?? 0, p95Ms: intervals[Math.floor(intervals.length * .95)] ?? 0,
        longFrames: intervals.filter(interval => interval > 100).length, metrics: { ...(canvas as HTMLCanvasElement).dataset }, visibility: document.visibilityState });
    }, duration);
  }), duration);
}
function climateDate(weather: 'clear' | 'rain', hour: number) {
  for (let day = 1; day <= 31; day++) { const at = Date.UTC(2026, 9, day, hour); if (companionWorldEnvironment(at, 'UTC').environment.weather === weather) return at; }
  throw new Error('No deterministic climate fixture found.');
}
function seedClock(profile: string, virtualAt: number) {
  // Only a stopped, disposable profile is seeded. Compressed mode at 1440
  // minutes/day advances at 1x from the chosen date; realtime remains absolute
  // computer time and must never be bent by an obsolete clock anchor.
  const script = `const Database=require('better-sqlite3');const db=new Database(process.argv[1]);const row=db.prepare('SELECT data FROM companion_world WHERE id=1').get();const world=JSON.parse(row.data);const now=Date.now();world.settings={...world.settings,revision:world.settings.revision+1,mode:'compressed',dayDurationMinutes:1440,timeZone:'UTC'};world.anchors=[{realAt:now,virtualAt:Number(process.argv[2]),settings:world.settings}];world.cursor=now;db.prepare('UPDATE companion_world SET data=? WHERE id=1').run(JSON.stringify(world));db.close();`;
  const result = spawnSync(resolveElectronExecutablePath(), ['-e', script, path.join(profile, 'companions/messages.sqlite'), String(virtualAt)], { cwd: resolveElectronAppPath(), env: { ...electronLaunchEnv(), ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
}
async function parkReady(page: Page) {
  const canvas = page.locator('canvas');
  await expect(canvas).toHaveAttribute('data-world-view', 'park');
  await expect(canvas).toHaveAttribute('data-world-scene', 'commons');
  await expect(canvas).toHaveAttribute('data-world-ready', 'true');
  await expect(page.getByRole('combobox', { name: '观测地点', exact: true })).toHaveValue('commons:park');
}

// Actual Electron/Three draws, host movement and SQLite; only the chat model is
// a deterministic provider. Transparent native windows remain visible to the OS.
// eslint-disable-next-line no-empty-pattern
test('observes a real public park, physical bench use and bounded multiwindow rendering while chat remains usable', async ({}, testInfo) => {
  test.setTimeout(260_000);
  const directory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-park-')), profile = path.join(directory, 'profile');
  let application: ElectronApplication | undefined;
  const errors: string[] = [];
  const server = createServer((incoming, response) => {
    let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', value => { raw += value; }); incoming.on('end', () => {
      try {
        const data = JSON.parse(JSON.parse(raw).messages[1].content); let result: unknown;
        if (data.purpose === 'world_attention') result = { urgency: 'ordinary', confidence: .98, evidence: [data.source.content], reason: '普通聊天无需中断生活。' };
        else if (data.purpose === 'world_decision') result = { action: null, reason: '保持实际公园活动。', appraisals: [] };
        else if (data.purpose === 'memory_query') result = {};
        else if (data.purpose === 'memory_dream') result = { candidates: [], dream: null };
        else if (data.purpose?.startsWith('memory_')) result = { candidates: [] };
        else result = { text: finalText, memories: [] };
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }));
      } catch { response.writeHead(400); response.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    mkdirSync(output, { recursive: true });
    const bootstrap = await launch(profile); application = bootstrap.application;
    await request(bootstrap.page, { type: 'world.snapshot' }); await application.close(); application = undefined;
    seedClock(profile, climateDate('clear', 12));
    const started = await launch(profile); application = started.application; const main = started.page;
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No park fixture port.');
    await main.evaluate(async baseUrl => { await (window as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', model: 'park-fixture', baseUrl, apiKey: 'fixture-park-key' }); }, 'http://127.0.0.1:' + address.port);
    const initial = (await request(main, { type: 'world.snapshot' })).world!, commons = initial.scenes.find(scene => scene.id === 'commons')!, bench = commons.objects.find(object => object.id === 'commons_bench')!;
    expect(initial.environment.weather).toBe('clear'); expect(initial.clock.daylight).toBe(true);
    expect(commons.objects.filter(object => object.kind === 'fountain')).toHaveLength(1); expect(commons.objects.find(object => object.kind === 'fountain')!.blocking).toBe(true);
    expect(commons.objects.filter(object => object.kind === 'lamp')).toHaveLength(6);
    const nearest = initial.scenes.filter(scene => scene.kind === 'home' && scene.ownerId).sort((a, b) => Math.hypot(a.origin.x + 10 - bench.anchor.x, a.origin.y + 16 - bench.anchor.y) - Math.hypot(b.origin.x + 10 - bench.anchor.x, b.origin.y + 16 - bench.anchor.y))[0]!;
    const companionId = nearest.ownerId!, conversation = (await request(main, { type: 'conversation.open', companionId })).conversation!, scope = { companionId, conversationId: conversation.id };
    const chatter = (await request(main, { type: 'conversation.open', companionId: 'deepseek-sister' })).conversation!;
    for (const current of [scope, { companionId: 'deepseek-sister', conversationId: chatter.id }]) {
      const routine = (await request(main, { type: 'routine.get', ...current })).routine!;
      await request(main, { type: 'routine.configure', ...current, expectedRevision: routine.revision, patch: { timeZone: 'UTC', wakeAt: '00:00', sleepAt: '23:59', meals: [], habits: [] } });
    }
    await expect.poll(async () => (await request(main, { type: 'world.observe', ...scope })).world?.perception?.objects.length ?? 0).toBeGreaterThan(0);
    const awarenessBefore = (await request(main, { type: 'world.observe', ...scope })).world!;
    expect(awarenessBefore.actors.map(actor => actor.companionId)).toEqual([companionId]);
    expect(awarenessBefore.perception!.sceneId).toBe(nearest.id);
    expect(awarenessBefore.perception!.objects.some(object => object.id === bench.id)).toBe(false);
    expect(awarenessBefore.environment).not.toHaveProperty('outdoorTemperature');
    const rememberedHomeIds = awarenessBefore.perception!.objects.filter(object => object.sceneId === nearest.id).map(object => object.id);
    expect(rememberedHomeIds.length).toBeGreaterThan(0);
    await main.locator('[data-application-module="companions"]').click();
    await main.locator('[data-companion-conversation="' + chatter.id + '"]').click();
    const a = await observer(application, main, { sceneId: 'commons' }); a.on('pageerror', error => errors.push(error.message));
    await expect(a.getByRole('img', { name: '伙伴街区地图，家庭与真实出行路线', exact: true })).toBeVisible();
    await a.getByRole('button', { name: '进入公共花园', exact: true }).click(); await parkReady(a);
    await a.getByRole('button', { name: '收起生活面板', exact: true }).click();
    await a.screenshot({ path: path.join(output, 'verified-public-park-day.png') });
    await a.getByRole('button', { name: '显示生活面板', exact: true }).click();
    const b = await observer(application, main, { sceneId: 'commons', view: 'park' }, 1); b.on('pageerror', error => errors.push(error.message)); await parkReady(b);
    const home = await observer(application, main, { companionId: 'deepseek-sister' }, 2); home.on('pageerror', error => errors.push(error.message));
    await expect(home.locator('canvas')).toHaveAttribute('data-world-ready', 'true');
    const idle = await Promise.all([a, b].map(page => frames(page, 2200)));
    // Water is an actual visible animation even without residents. It shares
    // the 30 fps budget; hidden/minimized observers must still draw nothing.
    for (const result of idle) { expect(result.visibility).toBe('visible'); expect(result.warmFrames).toBeGreaterThan(25); expect(result.frames).toBeLessThan(76); expect(result.p95Ms).toBeLessThan(100); }
    await request(main, { type: 'world.tool', ...scope, arguments: { action: 'move', destinationId: bench.id } });
    const actor = async () => (await request(main, { type: 'world.snapshot' })).world!.actors.find(actor => actor.companionId === companionId)!;
    await expect.poll(async () => (await actor()).sceneId, { timeout: 25_000 }).toBe('commons');
    await expect.poll(async () => {
      const actual = await actor(), raw = await a.locator('canvas').getAttribute('data-world-park-bounds'); if (!raw) return false;
      const bounds = JSON.parse(raw) as { x: number; y: number; width: number; height: number };
      return actual.position.x >= bounds.x + 1 && actual.position.x < bounds.x + bounds.width && actual.position.y >= bounds.y && actual.position.y < bounds.y + bounds.height;
    }, { timeout: 50_000 }).toBe(true);
    const travelling = await actor(); expect(travelling.activity).toBe('walking'); expect(travelling.route.length).toBeGreaterThan(0);
    expect(travelling.route.filter(node => node.sceneId === commons.id).every(node => companionWorldCellWalkable(commons, node))).toBe(true);
    await expect.poll(async () => Number(await a.locator('canvas').getAttribute('data-world-loaded-actors'))).toBeGreaterThan(0);
    const moving = await Promise.all([a, b].map(page => frames(page, 4000)));
    for (const result of moving) { expect(result.warmFrames).toBeGreaterThan(45); expect(result.medianMs).toBeLessThan(55); expect(result.p95Ms).toBeLessThan(100); expect(result.visibility).toBe('visible'); }
    await expect.poll(async () => { const actual = await actor(); return actual.route.length === 0 && actual.activity === 'idle' && Math.hypot(actual.position.x - bench.anchor.x, actual.position.y - bench.anchor.y) < .001; }, { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => (await request(main, { type: 'world.observe', ...scope })).world?.perception?.visibleObjectIds.includes(bench.id), { timeout: 6000 }).toBe(true);
    const awarenessAtBench = (await request(main, { type: 'world.observe', ...scope })).world!;
    expect(awarenessAtBench.actors.map(actor => actor.companionId)).toEqual([companionId]);
    expect(awarenessAtBench.environment.weather).toBe('clear'); expect(awarenessAtBench.environment.outdoorTemperature).toBeDefined();
    expect(awarenessAtBench.perception!.environment).toMatchObject({ weather: 'clear', weatherSource: 'outdoors' });
    expect(awarenessAtBench.perception!.environment.weatherObservedAtVirtual).toBeDefined();
    const rememberedHome = awarenessAtBench.perception!.objects.filter(object => rememberedHomeIds.includes(object.id));
    expect(rememberedHome.length).toBeGreaterThan(0);
    expect(rememberedHome.every(object => !object.visible && Date.parse(object.lastObservedAt) < Date.parse(awarenessAtBench.perception!.observedAtVirtual))).toBe(true);
    for (const object of awarenessAtBench.perception!.objects) { expect(object).not.toHaveProperty('occupantId'); expect(object).not.toHaveProperty('reservedBy'); }
    await request(main, { type: 'world.tool', ...scope, arguments: { action: 'interact', furnitureId: bench.id, interaction: 'rest' } });
    await expect.poll(async () => (await actor()).activity, { timeout: 10_000 }).toBe('resting');
    const seated = await actor(); expect(seated.furnitureId).toBe(bench.id); expect(seated.position).toEqual(bench.anchor);
    const label = a.locator('[data-world-actor-id="' + companionId + '"]');
    await expect(label).toHaveAttribute('data-world-host-position', `${seated.position.x},${seated.position.y}`);
    await expect.poll(async () => {
      const position = (await label.getAttribute('data-world-render-position'))?.split(',').map(Number);
      return position ? Math.hypot(position[0]! - (bench.position.x + (bench.width - 1) / 2 + .2), position[1]! - (bench.position.y + (bench.depth - 1) / 2)) : Infinity;
    }).toBeLessThan(.001);
    await expect(a.locator('[data-world-actor="' + companionId + '"]')).toHaveAttribute('data-world-activity', 'resting');
    await expect(a.locator('[data-world-actor="' + companionId + '"]')).toContainText(`位置 ${seated.position.x.toFixed(1)}, ${seated.position.y.toFixed(1)}`);
    await a.screenshot({ path: path.join(output, 'verified-public-park-resident.png') });
    const residentName = initial.residents.find(resident => resident.companionId === companionId)!.name;
    await a.getByRole('button', { name: '在场景中找到' + residentName, exact: true }).click();
    await expect.poll(async () => JSON.parse((await a.locator('canvas').getAttribute('data-world-camera'))!).zoom).toBeGreaterThanOrEqual(2.1);
    await a.screenshot({ path: path.join(output, 'verified-public-park-resident-detail.png') });
    await a.getByRole('button', { name: '重置世界视角', exact: true }).click();
    await main.getByRole('textbox', { name: '输入消息', exact: true }).fill('公共花园同时打开时，请正常回复。');
    await main.getByRole('button', { name: '发送', exact: true }).click(); await expect(main.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue('');
    await expect(main.locator('[data-companion-messages]')).toContainText(finalText, { timeout: 30_000 });
    const nativeA = await application.browserWindow(a); await nativeA.evaluate(window => window.minimize());
    await expect.poll(async () => (await a.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context())).context!.visible).toBe(false);
    const [hidden, visible] = await Promise.all([frames(a, 1800), frames(b, 1800)]); expect(hidden.frames).toBe(0); expect(visible.frames).toBeGreaterThan(0);
    await nativeA.evaluate(window => { window.restore(); window.showInactive(); });
    await expect.poll(async () => (await a.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.context())).context!.visible).toBe(true);
    const before = (await frames(a, 1600)).metrics;
    for (const destination of ['home_deepseek-sister', 'commons', 'commons:park', 'home_gpt', 'commons:park']) {
      await a.getByRole('combobox', { name: '观测地点', exact: true }).selectOption(destination);
      if (destination === 'commons:park') await parkReady(a);
      else if (destination !== 'commons') await expect(a.locator('canvas')).toHaveAttribute('data-world-ready', 'true');
    }
    await expect.poll(async () => Number(await a.locator('canvas').getAttribute('data-world-loaded-actors'))).toBeGreaterThan(0);
    const after = (await frames(a, 1800)).metrics;
    expect(Number(after.worldTextures)).toBeLessThanOrEqual(Number(before.worldTextures) + 1); expect(Number(after.worldGeometries)).toBeLessThanOrEqual(Number(before.worldGeometries) + 1);
    expect(Number(after.worldDrawCalls)).toBeLessThanOrEqual(45); expect(Number(after.worldGeometries)).toBeLessThanOrEqual(45); expect(Number(after.worldTriangles)).toBeLessThan(100000);
    const gpu = await a.locator('canvas').evaluate(canvas => { const gl = (canvas as HTMLCanvasElement).getContext('webgl2')!, extension = gl.getExtension('WEBGL_debug_renderer_info'); return extension ? { renderer: gl.getParameter(extension.UNMASKED_RENDERER_WEBGL), vendor: gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) } : {}; });
    const result = { features: await application.evaluate(({ app }) => app.getGPUFeatureStatus()), gpu, nativeVisibleOpacity: 0, companionId, bench, travelling, seated,
      finitePerception: { beforeLeavingHome: awarenessBefore, atBench: awarenessAtBench, rememberedHomeIds }, idle, moving, minimized: { hidden, visible }, resources: { before, after }, errors };
    writeFileSync(path.join(output, 'verified-public-park-performance.json'), JSON.stringify(result, null, 2));
    await testInfo.attach('public-park-performance', { body: JSON.stringify(result, null, 2), contentType: 'application/json' }); expect(errors).toEqual([]);
  } finally {
    await application?.close().catch(() => undefined); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); cleanup(directory);
  }
});

// eslint-disable-next-line no-empty-pattern
test('renders park daytime, night lighting and real world rain without leaking scene resources', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const directory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-park-')), profile = path.join(directory, 'profile');
  let application: ElectronApplication | undefined;
  const conditions = [{ weather: 'clear', hour: 12, theme: 'light', name: 'day' }, { weather: 'clear', hour: 22, theme: 'dark', name: 'night' }, { weather: 'rain', hour: 22, theme: 'dark', name: 'night-rain' }] as const;
  const evidence: unknown[] = [];
  try {
    mkdirSync(output, { recursive: true }); const bootstrap = await launch(profile); application = bootstrap.application;
    await request(bootstrap.page, { type: 'world.snapshot' }); await application.close(); application = undefined;
    for (const condition of conditions) {
      seedClock(profile, climateDate(condition.weather, condition.hour)); const started = await launch(profile); application = started.application; const main = started.page;
      const actual = (await request(main, { type: 'world.snapshot' })).world!; expect(actual.environment.weather).toBe(condition.weather); expect(actual.clock.daylight).toBe(condition.hour === 12);
      const park = await observer(application, main, { sceneId: 'commons', view: 'park' }); await parkReady(park);
      await park.evaluate(value => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: value })), condition.theme); await park.reload(); await parkReady(park);
      await expect(park.locator('html')).toHaveAttribute('data-theme', condition.theme);
      await expect(park.getByLabel('世界环境', { exact: true })).toContainText(condition.weather === 'rain' ? '下雨' : '晴朗');
      await expect(park.locator('canvas')).toHaveAttribute('data-world-lamp-count', '6'); await expect(park.locator('canvas')).toHaveAttribute('data-world-lamps-on', String(condition.hour !== 12));
      await expect(park.locator('canvas')).toHaveAttribute('data-world-lamp-radius', '9');
      await park.getByRole('button', { name: '收起生活面板', exact: true }).click();
      const duration = condition.weather === 'rain' ? 3500 : 1800, captured = await frames(park, duration);
      expect(captured.warmFrames).toBeGreaterThan(condition.weather === 'rain' ? 45 : 20); expect(captured.p95Ms).toBeLessThan(100);
      expect(captured.frames).toBeLessThan(Math.ceil(duration / 1000 * 30 * 1.2) + 3);
      await park.screenshot({ path: path.join(output, 'verified-public-park-' + condition.name + '.png') });
      evidence.push({ condition, clock: actual.clock, environment: actual.environment, captured });
      await application.close(); application = undefined;
    }
    writeFileSync(path.join(output, 'verified-public-park-climate.json'), JSON.stringify(evidence, null, 2));
    await testInfo.attach('public-park-climate', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  } finally { await application?.close().catch(() => undefined); cleanup(directory); }
});

// eslint-disable-next-line no-empty-pattern
test('every resident receives a probability rule and a triggered long walk physically visits the park, relaxes and returns home', async ({}, testInfo) => {
  test.setTimeout(210_000);
  const directory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-park-')), profile = path.join(directory, 'profile');
  let application: ElectronApplication | undefined;
  const samples: Array<{ realNow: string; backlog: boolean; actor: CompanionWorldSnapshot['actors'][number] }> = [];
  let diagnosticPage: Page | undefined, diagnosticOwner: string | undefined;
  try {
    mkdirSync(output, { recursive: true }); const bootstrap = await launch(profile); application = bootstrap.application;
    await request(bootstrap.page, { type: 'world.snapshot' }); await application.close(); application = undefined;
    seedClock(profile, climateDate('clear', 12)); const started = await launch(profile); application = started.application; const main = started.page;
    const initial = (await request(main, { type: 'world.snapshot' })).world!, commons = initial.scenes.find(scene => scene.id === 'commons')!, bench = commons.objects.find(object => object.kind === 'bench')!;
    const nearest = initial.scenes.filter(scene => scene.kind === 'home' && scene.ownerId).sort((a, b) => Math.hypot(a.origin.x + 10 - bench.anchor.x, a.origin.y + 16 - bench.anchor.y) - Math.hypot(b.origin.x + 10 - bench.anchor.x, b.origin.y + 16 - bench.anchor.y))[0]!;
    const companionId = nearest.ownerId!, defaults: Array<{ companionId: string; rules: unknown[] }> = []; diagnosticPage = main; diagnosticOwner = companionId;
    // The rule exists for every resident, but unrelated probabilistic activity
    // is disabled through the public editor contract in this isolated story.
    for (const resident of initial.residents) {
      const rules = (await request(main, { type: 'life-rule.list', companionId: resident.companionId })).lifeRules!;
      expect(rules.some(rule => rule.action === 'park_walk' && rule.enabled && rule.probability > 0 && (rule.durationMinutes ?? 0) >= 30)).toBe(true);
      defaults.push({ companionId: resident.companionId, rules });
      for (const rule of rules) await request(main, { type: 'life-rule.remove', companionId: resident.companionId, id: rule.id, expectedRevision: rule.revision });
    }
    const conversation = (await request(main, { type: 'conversation.open', companionId })).conversation!, scope = { companionId, conversationId: conversation.id };
    const routine = (await request(main, { type: 'routine.get', ...scope })).routine!;
    await request(main, { type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', wakeAt: '00:00', sleepAt: '23:59', meals: [], habits: [] } });
    const before = (await request(main, { type: 'world.snapshot' })).world!;
    await request(main, { type: 'world.configure', expectedRevision: before.settings.revision, patch: { mode: 'compressed', dayDurationMinutes: 20 } });
    const park = await observer(application, main, { sceneId: 'commons', view: 'park' }); await parkReady(park);
    const map = await observer(application, main, { sceneId: 'commons' }, 1);
    const now = (await request(main, { type: 'world.snapshot' })).world!;
    const minute = Math.floor(now.clock.hour * 60);
    const rule = (await request(main, { type: 'life-rule.create', companionId, clientId: 'park-e2e-long-walk', rule: {
      title: '测试存档中的长时间花园散步', enabled: true, startMinute: Math.max(0, minute - 1), endMinute: Math.min(1440, minute + 60), probability: 1, action: 'park_walk', durationMinutes: 35,
    } })).lifeRule!;
    const sample = async () => {
      const world = (await request(main, { type: 'world.snapshot' })).world!, actor = world.actors.find(actor => actor.companionId === companionId)!;
      samples.push({ realNow: world.clock.realNow, backlog: world.backlog, actor }); return { world, actor };
    };
    await expect.poll(async () => (await sample()).actor.parkWalk?.stage, { timeout: 30_000, intervals: [250] }).toBe('travelling');
    const departure = await sample(); expect(departure.actor.parkWalk!.participatedMinutes).toBe(0);
    await expect.poll(async () => { const { actor } = await sample(); return actor.parkWalk?.stage === 'strolling' && actor.activity === 'walking'; }, { timeout: 60_000, intervals: [250] }).toBe(true);
    const entry = await sample(); expect(entry.actor.sceneId).toBe('commons'); expect(entry.actor.activity).toBe('walking'); expect(entry.actor.route.length).toBeGreaterThan(0);
    await expect(park.locator('[data-world-actor="' + companionId + '"]')).toContainText('散步');
    await expect(park.locator('[data-world-actor-id="' + companionId + '"]')).toHaveAttribute('data-world-behavior', /散步/);
    await expect(map.locator('[data-world-map-actor="' + companionId + '"]')).toBeVisible();
    await park.screenshot({ path: path.join(output, 'verified-public-park-autonomous-walk.png') });
    await expect.poll(async () => (await sample()).actor.parkWalk?.participatedMinutes ?? 0, { timeout: 25_000, intervals: [500] }).toBeGreaterThan(12);
    const relaxing = await sample();
    expect(relaxing.world.events.some(event => event.actorId === companionId && event.kind === 'park_walk_relax')).toBe(true);
    await expect.poll(async () => (await sample()).actor.parkWalk?.stage, { timeout: 40_000, intervals: [500] }).toBe('returning');
    const returning = await sample(); expect(returning.actor.parkWalk!.participatedMinutes).toBeGreaterThanOrEqual(35 - .001);
    await expect.poll(async () => { const { actor } = await sample(); return actor.sceneId === actor.homeSceneId && !actor.parkWalk && actor.route.length === 0; }, { timeout: 60_000, intervals: [500] }).toBe(true);
    const finished = await sample();
    const occurrences = (await request(main, { type: 'life-rule.list', companionId })).lifeOccurrences!.filter(occurrence => occurrence.ruleId === rule.id);
    expect(occurrences).toHaveLength(1); expect(occurrences[0]!.status).toBe('done'); expect(occurrences[0]!.attempts).toBe(1);
    const active = samples.filter(sample => sample.actor.parkWalk?.stage === 'strolling'); expect(active.length).toBeGreaterThan(10);
    for (const sample of active) expect(sample.actor.sceneId).toBe('commons');
    let maximumDistance = 0;
    for (let index = 1; index < samples.length; index++) {
      const prior = samples[index - 1]!, next = samples[index]!; if (prior.actor.sceneId !== next.actor.sceneId) continue;
      const distance = Math.hypot(prior.actor.position.x - next.actor.position.x, prior.actor.position.y - next.actor.position.y);
      const elapsed = (Date.parse(next.realNow) - Date.parse(prior.realNow)) / 1000;
      maximumDistance = Math.max(maximumDistance, distance); expect(distance).toBeLessThanOrEqual(Math.max(prior.actor.movementSpeed, next.actor.movementSpeed) * Math.max(0, elapsed) + .5);
    }
    const result = { companionId, defaults, rule, departure, entry, relaxing, returning, finished, occurrences, maximumDistance, samples };
    writeFileSync(path.join(output, 'verified-public-park-autonomous-walk.json'), JSON.stringify(result, null, 2));
    await testInfo.attach('public-park-autonomous-walk', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  } catch (error) {
    const logs = application ? await application.evaluate(({ app }) => app.getPath('logs')).then(directory => {
      try { return readFileSync(resolveSessionLogPath(directory), 'utf8').slice(-40000); } catch { return undefined; }
    }).catch(() => undefined) : undefined;
    const result = { samples, world: diagnosticPage ? await request(diagnosticPage, { type: 'world.snapshot' }).catch(() => undefined) : undefined,
      life: diagnosticPage && diagnosticOwner ? await request(diagnosticPage, { type: 'life-rule.list', companionId: diagnosticOwner }).catch(() => undefined) : undefined, logs };
    writeFileSync(path.join(output, 'failed-public-park-autonomous-walk.json'), JSON.stringify(result, null, 2));
    await testInfo.attach('park-walk-failure', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    throw error;
  } finally { await application?.close().catch(() => undefined); cleanup(directory); }
});
