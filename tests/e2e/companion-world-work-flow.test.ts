import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionReplyStreamEvent, CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorldActor, CompanionWorldSnapshot } from '../../src/shared/companion-world';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import type { DshLauncherRequest, DshLauncherResponse, DshLauncherState } from '../../src/shared/dsh-launcher';
import type { DshTaskRecord } from '../../src/shared/dsh-tasks';
import { removeCompanionTestDirectory, ensureCompanionTestWorkspace, electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';
import { openCompanionWorldWindow } from './companion-world-window-helpers';
import { shareWorldHomeAddress, walkIntoWorldHome } from './companion-world-address-helpers';

const guestId = 'deepseek-sister', hostId = 'deepseek-flash';
const phoneText = '坐在朋友家休息时，帮我核对这句普通文字就好；不使用电脑或执行工具。';
const urgent = '两分钟后就截止了，请立即使用任务执行器算出2+2并核对结果。仅做隔离计算，不运行命令或读写外部文件。';
const cancelledUrgent = '两分钟后又要截止了，请立即使用任务执行器算出3+3并核对结果。仅做隔离计算，不运行命令或读写外部文件。';
const executorMarker = 'world-flow-isolated-computation';
type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi }; worldFlowStreams?: Array<{ at: number; event: CompanionReplyStreamEvent }> };
type LoggedRequest = { at: number; purpose: string; sourceText: string; sourceId?: string; world?: CompanionWorldSnapshot };
type ExecutorCall = { at: number; type: string; prompt?: string; world?: CompanionWorldSnapshot };
type ExecutorFixture = { calls: ExecutorCall[]; records: DshTaskRecord[] };
type FixtureGlobal = typeof globalThis & { worldFlowExecutor?: ExecutorFixture };

/** Only the external execution backend is scripted. The actual companion
 * native dsh dispatch, action records, world path and computer gate stay live. */
async function installExecutorFixture(application: ElectronApplication) {
  await application.evaluate(({ BrowserWindow }, input) => {
    const { createRequire } = process.getBuiltinModule('node:module'), require = createRequire(input.packageJson);
    type Prototype = { state(): DshLauncherState; requestTask(request: DshLauncherRequest, options?: unknown): Promise<DshLauncherResponse> };
    const module = Object.values(require.cache).map(value => value?.exports as { DshLauncher?: { prototype: Prototype } } | undefined).find(value => value?.DshLauncher);
    if (!module?.DshLauncher) throw new Error('Actual loaded DSH launcher was not found.');
    const prototype = module.DshLauncher.prototype, originalState = prototype.state, originalRequest = prototype.requestTask;
    const fixture: ExecutorFixture = { calls: [], records: [] }; (globalThis as FixtureGlobal).worldFlowExecutor = fixture;
    prototype.state = function () { const state = originalState.call(this); return { ...state, tasks: [...(state.tasks ?? []), ...fixture.records] }; };
    prototype.requestTask = async function (request, options) {
      if (request.type === 'task.run' && request.prompt.includes(input.marker)) {
        const main = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('companion-world'));
        if (!main) throw new Error('Fixture main window missing.');
        const observed = await main.webContents.executeJavaScript('window.worldlinebox.companions.request({type:"world.snapshot"})');
        fixture.calls.push({ at: Date.now(), type: request.type, prompt: request.prompt, world: observed.world });
        const id = 'world-flow-task-' + fixture.records.length;
        fixture.records.push({ id, operationId: id, instanceId: 'world-flow-instance', runtimeId: 'world-flow-runtime', runtimeVersion: 'fixture-executor', title: request.title ?? '隔离计算', status: 'running', accessMode: 'danger-full-access', startedAt: new Date().toISOString() });
        return { ok: true, operationId: id };
      }
      const record = 'taskId' in request ? fixture.records.find(value => value.id === request.taskId) : undefined;
      if (record) {
        if (request.type === 'task.cancel' || request.type === 'task.terminate') { fixture.calls.push({ at: Date.now(), type: request.type }); record.status = 'cancelled'; return { ok: true }; }
        if (request.type === 'task.events') return { ok: true, taskEvents: [] };
        if (request.type === 'task.result') return { ok: true, taskResult: { taskId: record.id, instanceId: record.instanceId, runtimeId: record.runtimeId, runtimeVersion: record.runtimeVersion, text: '[fixture execution] 2+2=4；未运行OS命令或访问外部文件。', code: 0 } };
      }
      return originalRequest.call(this, request, options);
    };
  }, { packageJson: path.resolve('package.json'), marker: executorMarker });
}
async function executorState(application: ElectronApplication) { return application.evaluate(() => (globalThis as FixtureGlobal).worldFlowExecutor!); }
async function request(page: Page, input: CompanionsRequest) {
  const value = await page.evaluate(value => (window as unknown as Bridge).worldlinebox.companions.request(value), input);
  expect(value.ok, value.error).toBe(true); return value;
}
async function snapshot(page: Page) { return (await request(page, { type: 'world.snapshot' })).world!; }
function actor(world: CompanionWorldSnapshot, id = guestId) { return world.actors.find(actor => actor.companionId === id)!; }
function clock(hour: number) { return String((Math.floor(hour) + 24) % 24).padStart(2, '0') + ':00'; }
function cleanup(root: string) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-world-flow-')) throw new Error('Unexpected isolated world flow cleanup target.');
  removeCompanionTestDirectory(resolved);
}
async function launch(profile: string) {
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'software' }) });
  const page = await application.firstWindow(), nativeWindow = await application.browserWindow(page);
  await nativeWindow.evaluate(win => { win.unmaximize(); win.setSize(1440, 900); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); });
  await ensureCompanionTestWorkspace(page);
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 60_000 });
  await page.locator('[data-application-module="companions"]').click(); return { application, page };
}
async function providerFixture() {
  const requests: LoggedRequest[] = [], streams = new Map<string, ServerResponse>(), errors: string[] = [], socialReviews: string[] = [];
  const firstText = '我正用手机看你这句话。', finalText = '文字核对已经完成。这是隔离验收，没有执行文件操作。';
  const taskFirstText = '我去有空的电脑前处理你这项计算。', taskFinalText = '执行器返回了隔离计算结果：2+2=4，没有访问外部文件。';
  const chunk = (response: ServerResponse, text: string, finish: string | null = null) => response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] }) + '\n\n');
  const server = createServer((incoming, response) => {
    let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', value => { raw += value; });
    incoming.on('end', () => {
      try {
        const body = JSON.parse(raw), data = JSON.parse(body.messages[1].content), purpose = data.purpose ?? 'task_reply', sourceText = data.source?.content ?? data.taskRequest?.prompt ?? '', sourceId = data.source?.id ?? data.taskRequest?.sourceMessageId;
        if (purpose === 'companion_social_progress_review') {
          expect(typeof data.proposedText).toBe('string'); socialReviews.push(data.proposedText);
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ supported: true, correction: '' }) }, finish_reason: 'stop' }] })); return;
        }
        requests.push({ at: Date.now(), purpose, sourceText, sourceId, ...(data.world ? { world: data.world } : {}) });
        let output: unknown;
        if (purpose === 'world_attention') output = { urgency: [urgent, cancelledUrgent].includes(sourceText) ? 'urgent' : 'ordinary', confidence: .98, evidence: [sourceText], reason: '脚本中这条实际用户消息临近截止并请求立即协助。' };
        else if (purpose === 'world_decision') output = { action: null, reason: '本例的初始许可和占用由宿主预设。', appraisals: [] };
        else if (purpose === 'world_social') output = { text: null, reason: '本例不继续自主话题。' };
        else if (purpose === 'vcp_sleep_reflection') output = { notes: [], dream: null };
        else if (purpose === 'vcp_memory_prohibition_check') output = { allowed: true, matchedPolicyIds: [] };
        else if (purpose === 'vcp_experience_journal') output = { notes: [] };
        else {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); response.flushHeaders();
          if ([urgent, cancelledUrgent].includes(sourceText)) {
            if (body.messages.some((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'flow_dsh_' + sourceId)) {
              chunk(response, taskFinalText); chunk(response, '', 'stop'); response.end('data: [DONE]\n\n'); return;
            }
            chunk(response, taskFirstText);
            response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'flow_dsh_' + sourceId, type: 'function', function: { name: 'dsh', arguments: JSON.stringify({ operation: 'run', tasks: [{ title: '隔离计算', prompt: executorMarker + '。只计算用户本轮请求的算式；不运行命令，不访问文件。' }] }) } }] }, finish_reason: null }] }) + '\n\n');
            response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n'); response.end('data: [DONE]\n\n'); return;
          }
          chunk(response, firstText);
          streams.set(sourceText, response); response.on('close', () => { if (streams.get(sourceText) === response) streams.delete(sourceText); }); return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }));
      } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); if (!response.headersSent) response.writeHead(400); response.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No provider fixture port.');
  return { requests, errors, socialReviews, baseUrl: 'http://127.0.0.1:' + address.port, firstText, finalText, taskFirstText, taskFinalText,
    finish(text: string) { const response = streams.get(text); if (!response) throw new Error('No actual pending stream.'); chunk(response, '\n' + finalText); chunk(response, '', 'stop'); response.end('data: [DONE]\n\n'); },
    async close() { for (const response of streams.values()) response.destroy(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); },
  };
}

// Real preload/Main/UtilityProcess/SQLite/renderer physics and SSE. Only the
// external provider and initial host consent are scripted, never actor motion.
// eslint-disable-next-line no-empty-pattern
test('phone chat streams from a friends sofa while only native DSH execution requires the computer and cancellation stops the journey', async ({}, testInfo) => {
  test.setTimeout(180000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-flow-')), provider = await providerFixture();
  const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true });
  let application: ElectronApplication | undefined;
  const samples: Array<{ at: number; label: string; actor: CompanionWorldActor; works: CompanionWorldSnapshot['works'] }> = [];
  try {
    const started = await launch(path.join(root, 'profile')); application = started.application; const page = started.page;
    await installExecutorFixture(application);
    const configured = await page.evaluate(value => (window as unknown as Bridge).worldlinebox.llm.setConfig(value), { apiFormat: 'openai_chat' as const, model: 'fixture-world-flow', baseUrl: provider.baseUrl, apiKey: 'fixture-world-flow-key' }); expect(configured.ok).toBe(true);
    const guestRoom = (await request(page, { type: 'conversation.open', companionId: guestId })).conversation!, hostRoom = (await request(page, { type: 'conversation.open', companionId: hostId })).conversation!;
    const initial = await snapshot(page); await request(page, { type: 'world.configure', expectedRevision: initial.settings.revision, patch: { mode: 'realtime' } });
    for (const [companionId, conversationId] of [[guestId, guestRoom.id], [hostId, hostRoom.id]] as const) {
      await request(page, { type: 'companion.set-active', id: companionId, active: true });
      const routine = (await request(page, { type: 'routine.get', companionId, conversationId })).routine!, hour = (await snapshot(page)).clock.hour;
      await request(page, { type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision, patch: { wakeAt: clock(hour - 8), sleepAt: clock(hour + 8), meals: [], habits: [] } });
    }
    const guestScope = { companionId: guestId, conversationId: guestRoom.id }, hostScope = { companionId: hostId, conversationId: hostRoom.id };
    const visit = (await request(page, { type: 'world.tool', ...guestScope, arguments: { action: 'visit', targetCompanionId: hostId, reason: '空闲时来分享读书感受。' } })).world!.visits.find(visit => visit.guestId === guestId)!;
    await request(page, { type: 'world.tool', ...hostScope, arguments: { action: 'respond', requestId: visit.id, decision: 'allow', reason: '欢迎，有空时来坐坐。' } });
    await walkIntoWorldHome(page, guestScope, hostId);
    await expect.poll(async () => { const value = actor(await snapshot(page)); return value.sceneId === 'home_' + hostId && !value.route.length; }, { timeout: 40000 }).toBe(true);
    async function sitAtFriendsSofa() {
      const home = (await snapshot(page)).scenes.find(scene => scene.ownerId === hostId)!, anchor = home.objects.find(object => object.kind === 'sofa')!.anchor;
      // Walk along the visible entrance aisle and actually perceive the room;
      // a visit grant does not teach the guest unobserved furniture identifiers.
      const vantage = { x: home.door.x, y: home.door.y - 7 };
      await request(page, { type: 'world.tool', ...guestScope, arguments: { action: 'move', position: vantage } });
      await expect.poll(async () => { const value = actor(await snapshot(page)); return Math.hypot(value.position.x - vantage.x, value.position.y - vantage.y) < .01 && !value.route.length; }, { timeout: 20000 }).toBe(true);
      await expect.poll(async () => (await request(page, { type: 'world.observe', ...guestScope })).world?.perception?.visibleObjectIds.includes(hostId + '_sofa'), { timeout: 6000 }).toBe(true);
      await request(page, { type: 'world.tool', ...guestScope, arguments: { action: 'move', destinationId: hostId + '_sofa' } });
      await expect.poll(async () => { const value = actor(await snapshot(page)); return Math.hypot(value.position.x - anchor.x, value.position.y - anchor.y) < .01 && !value.route.length && value.activity === 'idle'; }, { timeout: 20000 }).toBe(true);
      await request(page, { type: 'world.tool', ...guestScope, arguments: { action: 'interact', furnitureId: hostId + '_sofa', interaction: 'sit' } });
      await expect.poll(async () => actor(await snapshot(page)).activity, { timeout: 10000 }).toBe('sitting');
    }
    await sitAtFriendsSofa();
    await request(page, { type: 'world.tool', ...hostScope, arguments: { action: 'move', destinationId: hostId + '_computer' } });
    const computerAnchor = (await snapshot(page)).scenes.find(scene => scene.ownerId === hostId)!.objects.find(object => object.kind === 'computer')!.anchor;
    await expect.poll(async () => { const value = actor(await snapshot(page), hostId); return Math.hypot(value.position.x - computerAnchor.x, value.position.y - computerAnchor.y) < .01 && !value.route.length && value.activity === 'idle'; }, { timeout: 15000 }).toBe(true);
    await request(page, { type: 'world.tool', ...hostScope, arguments: { action: 'interact', furnitureId: hostId + '_computer', interaction: 'use' } });
    await expect.poll(async () => actor(await snapshot(page), hostId).activity, { timeout: 10000 }).toBe('sitting');
    const occupied = await snapshot(page);
    expect(occupied.scenes.find(scene => scene.ownerId === hostId)!.objects.find(object => object.kind === 'computer')!.occupantId).toBe(hostId);
    expect(actor(occupied).furnitureId).toBe(hostId + '_sofa');
    await page.evaluate(() => { const bridge = window as unknown as Bridge; bridge.worldFlowStreams = []; bridge.worldlinebox.companions.onReplyStream(event => bridge.worldFlowStreams!.push({ at: Date.now(), event })); });
    await page.locator('[data-companion-conversation="' + guestRoom.id + '"]').click();
    const worldPage = await openCompanionWorldWindow(application, page);
    const modal = worldPage.getByRole('region', { name: '伙伴世界', exact: true });
    await modal.getByRole('combobox', { name: '观测地点', exact: true }).selectOption('home_' + hostId);
    const phoneSource = (await request(page, { type: 'message.send', conversationId: guestRoom.id, content: phoneText, clientId: randomUUID() })).message!;
    await expect.poll(() => provider.requests.filter(value => value.purpose === 'task_reply' && value.sourceId === phoneSource.id).length, { timeout: 15000 }).toBe(1);
    const phoneRequest = provider.requests.find(value => value.purpose === 'task_reply' && value.sourceId === phoneSource.id)!;
    expect(actor(phoneRequest.world!).sceneId).toBe('home_' + hostId);
    expect(actor(phoneRequest.world!).furnitureId).toBe(hostId + '_sofa');
    expect(actor(phoneRequest.world!).artAction).toBe('phoneTypingSeated');
    expect(phoneRequest.world!.works.some(work => work.companionId === guestId && work.kind !== 'chat')).toBe(false);
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as Bridge).worldFlowStreams))!.some(value => value.event.sourceMessageId === phoneSource.id && value.event.text.includes(provider.firstText))).toBe(true);
    expect((await executorState(application)).calls).toHaveLength(0);
    expect((await request(page, { type: 'actions', conversationId: guestRoom.id })).actions).toHaveLength(0);
    await worldPage.screenshot({ path: path.join(artifacts, 'verified-world-sofa-phone-stream.png') });
    provider.finish(phoneText);
    await expect(page.locator('[data-companion-messages]')).toContainText(provider.finalText);
    await expect.poll(async () => (await snapshot(page)).works.filter(work => work.companionId === guestId).length).toBe(0);
    expect(actor(await snapshot(page)).sceneId).toBe('home_' + hostId);
    await modal.getByRole('combobox', { name: '观测地点', exact: true }).selectOption('home_' + hostId);
    const source = (await request(page, { type: 'message.send', conversationId: guestRoom.id, content: urgent, priority: 'urgent', clientId: randomUUID() })).message!;
    let journeyCaptured = false, sawStand = false, sawRun = false;
    await expect.poll(async () => {
      const world = await snapshot(page), current = actor(world); samples.push({ at: Date.now(), label: 'urgent_journey', actor: current, works: world.works });
      sawStand ||= current.activity === 'standingUp'; sawRun ||= current.activity === 'walking' && current.locomotion === 'run';
      const execution = await executorState(application!);
      if (!world.works.some(work => work.companionId === guestId && work.kind === 'action' && work.status === 'ready')) expect(execution.calls.filter(call => call.type === 'task.run')).toHaveLength(0);
      if (current.sceneId === 'home_' + hostId && current.travel?.targetSceneId === 'home_' + guestId && current.route.length && current.activity === 'walking' && !journeyCaptured) {
        await expect(modal.locator('[data-world-actor="' + guestId + '"]')).toBeVisible();
        await worldPage.screenshot({ path: path.join(artifacts, 'verified-world-urgent-running-home.png') }); journeyCaptured = true;
      }
      return execution.calls.some(call => call.type === 'task.run');
    }, { timeout: 40000, intervals: [150, 250] }).toBe(true);
    expect(sawStand).toBe(true); expect(journeyCaptured).toBe(true);
    expect(samples.some(sample => sample.actor.travel?.targetSceneId === 'home_' + guestId && sample.actor.locomotion === 'run' && sample.actor.route.length > 0)).toBe(true);
    const first = (await executorState(application)).calls.find(call => call.type === 'task.run')!;
    expect(actor(first.world!).sceneId).toBe('home_' + guestId); expect(actor(first.world!).furnitureId).toBe(guestId + '_computer'); expect(actor(first.world!).activity).toBe('working');
    expect(first.world!.works.find(work => work.companionId === guestId && work.kind === 'action')?.status).toBe('ready');
    const initialTaskInference = provider.requests.find(value => value.sourceId === source.id && value.purpose === 'task_reply')!;
    expect(actor(initialTaskInference.world!).sceneId).toBe('home_' + hostId);
    expect(initialTaskInference.at).toBeLessThan(first.at);
    await modal.getByRole('combobox', { name: '观测地点', exact: true }).selectOption('home_' + guestId);
    await expect(modal.locator('[data-world-actor="' + guestId + '"]')).toHaveAttribute('data-world-activity', 'working');
    await worldPage.screenshot({ path: path.join(artifacts, 'verified-world-urgent-work-ready.png') });
    await application.evaluate(() => { const record = (globalThis as FixtureGlobal).worldFlowExecutor!.records[0]!; record.status = 'succeeded'; record.finishedAt = new Date().toISOString(); });
    await expect(page.locator('[data-companion-messages]')).toContainText(provider.taskFinalText, { timeout: 15000 });
    expect((await request(page, { type: 'actions', conversationId: guestRoom.id })).actions?.find(action => action.sourceMessageId === source.id)).toMatchObject({ status: 'succeeded', result: expect.stringContaining('[fixture execution]') });
    await page.screenshot({ path: path.join(artifacts, 'verified-world-urgent-feedback.png') });
    await expect.poll(async () => (await snapshot(page)).works.filter(work => work.companionId === guestId).length).toBe(0);
    await walkIntoWorldHome(page, guestScope, hostId);
    await expect.poll(async () => { const value = actor(await snapshot(page)); return value.sceneId === 'home_' + hostId && !value.route.length && value.activity === 'idle'; }, { timeout: 40000 }).toBe(true);
    await sitAtFriendsSofa();
    const cancelled = (await request(page, { type: 'message.send', conversationId: guestRoom.id, content: cancelledUrgent, priority: 'urgent', clientId: randomUUID() })).message!;
    await expect.poll(async () => { const world = await snapshot(page), value = actor(world); samples.push({ at: Date.now(), label: 'cancelled_journey', actor: value, works: world.works }); return value.sceneId === 'home_' + hostId && value.travel?.targetSceneId === 'home_' + guestId && value.activity === 'walking' && value.route.length > 0; }, { timeout: 25000, intervals: [200] }).toBe(true);
    expect(provider.requests.filter(request => request.purpose === 'task_reply' && request.sourceId === cancelled.id)).toHaveLength(1);
    expect((await executorState(application)).calls.filter(call => call.type === 'task.run')).toHaveLength(1);
    await request(page, { type: 'reply.cancel', conversationId: guestRoom.id });
    await expect.poll(async () => (await snapshot(page)).works.filter(work => work.companionId === guestId).length).toBe(0);
    await page.waitForTimeout(2500);
    expect(provider.requests.filter(request => request.purpose === 'task_reply' && request.sourceId === cancelled.id)).toHaveLength(1);
    expect((await executorState(application)).calls.filter(call => call.type === 'task.run')).toHaveLength(1);
    expect((await request(page, { type: 'actions', conversationId: guestRoom.id })).actions?.find(action => action.sourceMessageId === cancelled.id)?.status).toBe('cancelled');
    expect((await snapshot(page)).scenes.flatMap(scene => scene.objects).filter(object => object.kind === 'computer' && object.reservedBy === guestId)).toHaveLength(0);
    const events = (await page.evaluate(() => (window as unknown as Bridge).worldFlowStreams))!;
    expect(events.some(value => value.event.sourceMessageId === cancelled.id && value.event.text.includes(provider.taskFinalText))).toBe(false);
    const execution = await executorState(application);
    expect(provider.errors).toEqual([]);
    expect(provider.socialReviews.length).toBeGreaterThan(0);
    writeFileSync(path.join(artifacts, 'verified-world-work-flow.json'), JSON.stringify({ executorKind: 'scripted external backend; actual Main/native dispatch and world gate', phoneSourceId: phoneSource.id, sourceId: source.id, cancelledSourceId: cancelled.id, samples, requests: provider.requests, socialReviewCount: provider.socialReviews.length, socialReviews: provider.socialReviews, execution, streamEvents: events }, null, 2));
    await testInfo.attach('world-work-flow-evidence', { body: JSON.stringify({ samples, requests: provider.requests, socialReviewCount: provider.socialReviews.length, socialReviews: provider.socialReviews, execution, streamEvents: events }, null, 2), contentType: 'application/json' });
    expect(sawRun, 'A host-verified urgent computer task must run along its actual route.').toBe(true);
  } catch (error) {
    const execution = application ? await executorState(application).catch(() => undefined) : undefined;
    writeFileSync(path.join(artifacts, 'verified-world-work-flow-failure.json'), JSON.stringify({ samples, requests: provider.requests, socialReviewCount: provider.socialReviews.length, socialReviews: provider.socialReviews, execution, fixtureErrors: provider.errors }, null, 2));
    if (application) await application.firstWindow().then(page => page.screenshot({ path: testInfo.outputPath('world-flow-failure.png') })).catch(() => undefined);
    throw error;
  } finally {
    await application?.close().catch(() => undefined); await provider.close();
    cleanup(root);
  }
});

// eslint-disable-next-line no-empty-pattern
test('world save resumes an actual route, peer relationship and visit after process restart without replaying completed work', async ({}, testInfo) => {
  test.setTimeout(210000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-flow-')), profile = path.join(root, 'profile'), provider = await providerFixture();
  let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile); application = started.application; let page = started.page;
    const configured = await page.evaluate(value => (window as unknown as Bridge).worldlinebox.llm.setConfig(value), { apiFormat: 'openai_chat' as const, model: 'fixture-world-save', baseUrl: provider.baseUrl, apiKey: 'fixture-world-save-key' }); expect(configured.ok).toBe(true);
    const guestRoom = (await request(page, { type: 'conversation.open', companionId: guestId })).conversation!, hostRoom = (await request(page, { type: 'conversation.open', companionId: hostId })).conversation!;
    const guestScope = { companionId: guestId, conversationId: guestRoom.id }, hostScope = { companionId: hostId, conversationId: hostRoom.id };
    const initial = await snapshot(page); await request(page, { type: 'world.configure', expectedRevision: initial.settings.revision, patch: { mode: 'realtime' } });
    for (const scope of [guestScope, hostScope]) {
      const routine = (await request(page, { type: 'routine.get', ...scope })).routine!, hour = (await snapshot(page)).clock.hour;
      await request(page, { type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { wakeAt: clock(hour - 8), sleepAt: clock(hour + 8), meals: [], habits: [] } });
    }
    const text = '永久存档验收：只核对这句话，不操作文件。';
    const source = (await request(page, { type: 'message.send', conversationId: guestRoom.id, content: text, clientId: randomUUID() })).message!;
    await expect.poll(() => provider.requests.filter(request => request.purpose === 'task_reply' && request.sourceId === source.id).length, { timeout: 25000 }).toBe(1);
    provider.finish(text);
    await expect.poll(async () => (await request(page, { type: 'messages', conversationId: guestRoom.id, limit: 100 })).messages!.filter(message => message.replyToId === source.id && message.authorId === guestId && message.content.includes(provider.finalText)).length).toBe(1);
    await expect.poll(async () => (await snapshot(page)).works.length).toBe(0);
    // Meet at a real nearby street doorway, not the arbitrary centre of a
    // large expanding map. This leaves a real route back to the host's home.
    await shareWorldHomeAddress(page, 'huan-white', [guestId, hostId]);
    for (const scope of [guestScope, hostScope]) await request(page, { type: 'world.tool', ...scope, arguments: { action: 'move', destinationId: 'huan-white_entrance' } });
    await expect.poll(async () => { const world = await snapshot(page); return [guestId, hostId].every(id => actor(world, id).sceneId === 'park' && !actor(world, id).route.length); }, { timeout: 30000 }).toBe(true);
    const social = (await request(page, { type: 'world.tool', ...guestScope, arguments: { action: 'social', targetCompanionId: hostId, kind: 'greet', text: '这是存档验收中真实发生的伙伴问候。' } })).world!;
    const peerEvent = social.events.find(event => event.actorId === guestId && event.kind === 'social_talk')!;
    const speech = (await request(page, { type: 'message.get', id: peerEvent.sourceMessageId! })).message!;
    expect(speech.authorId).toBe(guestId); expect(speech.authorId).not.toBe('user');
    const visit = (await request(page, { type: 'world.tool', ...guestScope, arguments: { action: 'visit', targetCompanionId: hostId, reason: '问候后得到许可再去做客。' } })).world!.visits.find(visit => visit.guestId === guestId)!;
    await request(page, { type: 'world.tool', ...hostScope, arguments: { action: 'respond', requestId: visit.id, decision: 'allow', reason: '欢迎有空时来。' } });
    await shareWorldHomeAddress(page, hostId, [guestId]);
    await request(page, { type: 'world.tool', ...guestScope, arguments: { action: 'travel', targetSceneId: 'home_' + hostId } });
    await expect.poll(async () => actor(await snapshot(page)).route.length, { timeout: 10000 }).toBeGreaterThan(10);
    const saved = await snapshot(page), savedActor = actor(saved), savedRelation = saved.relationships.find(relation => relation.companionId === guestId && relation.targetCompanionId === hostId)!;
    // One actual greeting and the owner's separately delivered address share.
    expect(savedRelation.interactions).toBe(2); expect(savedRelation.affinity).toBe(50);
    expect(saved.visits.find(value => value.id === visit.id)?.status).toBe('allowed');
    const savedAt = Date.now();
    expect(Math.abs(Date.parse(saved.clock.virtualNow) - savedAt)).toBeLessThan(2000);
    await application.close(); application = undefined;
    // Actual process absence is intentional; do not fake the host's persistence clock.
    await new Promise(resolve => setTimeout(resolve, 1200));
    started = await launch(profile); application = started.application; page = started.page;
    const restored = await snapshot(page), restoredActor = actor(restored);
    expect(restored.settings).toEqual(saved.settings);
    expect(Date.parse(restored.clock.virtualNow)).toBeGreaterThan(Date.parse(saved.clock.virtualNow));
    expect(Math.abs(Date.parse(restored.clock.virtualNow) - Date.now())).toBeLessThan(2000);
    expect(restored.visits.find(value => value.id === visit.id)?.status).toBe('allowed');
    expect(restored.relationships.find(relation => relation.companionId === guestId && relation.targetCompanionId === hostId)).toMatchObject({ affinity: savedRelation.affinity, trust: savedRelation.trust, interactions: savedRelation.interactions });
    expect(restoredActor.sceneId === savedActor.sceneId && restoredActor.position.x === savedActor.position.x && restoredActor.position.y === savedActor.position.y).toBe(false);
    expect(restoredActor.sceneId === 'home_' + guestId && restoredActor.position.x === 10 && restoredActor.position.y === 13).toBe(false);
    // Restoring a street route and an entry permit still cannot imply entering.
    if (restoredActor.destinationId) expect(restoredActor.destinationId).toBe(hostId + '_entrance');
    else expect(restoredActor.sceneId).toBe('park');
    expect(restoredActor.sceneId).not.toBe('home_' + hostId);
    expect(restoredActor.route.every(point => point.sceneId === 'park')).toBe(true);
    expect(restoredActor.activity).not.toBe('working');
    expect(restored.works).toHaveLength(0);
    await page.waitForTimeout(1500);
    expect(provider.requests.filter(request => request.purpose === 'task_reply' && request.sourceId === source.id)).toHaveLength(1);
    expect((await request(page, { type: 'messages', conversationId: guestRoom.id, limit: 100 })).messages!.filter(message => message.replyToId === source.id && message.authorId === guestId && message.content.includes(provider.finalText))).toHaveLength(1);
    const evidence = { sourceId: source.id, savedAt, restoredAt: Date.now(), saved, restored, providerRequests: provider.requests, socialReviewCount: provider.socialReviews.length, socialReviews: provider.socialReviews };
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true }); writeFileSync(path.join(artifacts, 'verified-world-save-restart.json'), JSON.stringify(evidence, null, 2));
    const worldPage = await openCompanionWorldWindow(application, page);
    const modal = worldPage.getByRole('region', { name: '伙伴世界', exact: true });
    await modal.getByRole('combobox', { name: '观测地点', exact: true }).selectOption(restoredActor.sceneId);
    if (restoredActor.sceneId === 'park') await expect(modal.locator('[data-world-map-ready]')).toHaveAttribute('data-world-map-ready', 'true');
    else await expect(modal.locator('canvas')).toHaveAttribute('data-world-ready', 'true');
    await worldPage.screenshot({ path: path.join(artifacts, 'verified-world-save-restart.png') });
    await modal.getByRole('button', { name: '关闭伙伴世界', exact: true }).click();
    // A different, real in-flight reply must survive as a draft, never acquire a
    // successful result merely because the world clock advances while offline.
    const partialText = '存档中断验收：请核对这句文字，等待我确认后再继续。';
    const partialSource = (await request(page, { type: 'message.send', conversationId: guestRoom.id, content: partialText, clientId: randomUUID() })).message!;
    await expect.poll(() => provider.requests.filter(request => request.purpose === 'task_reply' && request.sourceId === partialSource.id).length, { timeout: 40000 }).toBe(1);
    await expect.poll(async () => (await request(page, { type: 'messages', conversationId: guestRoom.id, limit: 100 })).messages!.some(message => message.replyToId === partialSource.id && message.replyDraft?.text === provider.firstText), { timeout: 10000 }).toBe(true);
    const partialBefore = await snapshot(page);
    expect(partialBefore.works.find(work => work.companionId === guestId)?.status).toBe('ready');
    await application.close(); application = undefined;
    await new Promise(resolve => setTimeout(resolve, 1200));
    started = await launch(profile); application = started.application; page = started.page;
    await page.locator('[data-companion-conversation="' + guestRoom.id + '"]').click();
    const partialAfter = await snapshot(page);
    expect(partialAfter.works).toHaveLength(0);
    expect(actor(partialAfter).activity).not.toBe('working');
    await page.waitForTimeout(1500);
    expect(provider.requests.filter(request => request.purpose === 'task_reply' && request.sourceId === partialSource.id)).toHaveLength(1);
    const partialReplies = (await request(page, { type: 'messages', conversationId: guestRoom.id, limit: 100 })).messages!.filter(message => message.replyToId === partialSource.id && message.authorId === guestId);
    expect(partialReplies).toHaveLength(1); const partialReply = partialReplies[0]!; expect(partialReply.isReplyDraft).toBe(true);
    expect(partialReply.replyDraft?.text).toBe(provider.firstText); expect(partialReply.content).not.toContain(provider.finalText);
    await expect(page.locator('[data-companion-message="' + partialReply.id + '"]')).toContainText('回复已中断');
    await page.screenshot({ path: path.join(artifacts, 'verified-world-save-interrupted.png') });
    const completeEvidence = { ...evidence, partialSourceId: partialSource.id, partialBefore, partialAfter, partialReplies };
    expect(provider.errors).toEqual([]);
    expect(provider.socialReviews.length).toBeGreaterThan(0);
    writeFileSync(path.join(artifacts, 'verified-world-save-restart.json'), JSON.stringify(completeEvidence, null, 2));
    await testInfo.attach('world-save-restart-evidence', { body: JSON.stringify(completeEvidence, null, 2), contentType: 'application/json' });
  } catch (error) {
    if (application) await application.firstWindow().then(page => page.screenshot({ path: testInfo.outputPath('world-save-failure.png') })).catch(() => undefined);
    throw error;
  } finally { await application?.close().catch(() => undefined); await provider.close(); cleanup(root); }
});
