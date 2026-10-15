import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionReplyStreamEvent, CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorldActor, CompanionWorldSnapshot } from '../../src/shared/companion-world';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';
import { openCompanionWorldWindow } from './companion-world-window-helpers';

const guestId = 'deepseek-sister', hostId = 'deepseek-flash';
const urgent = '两分钟后就截止了，快救我核对这句消息；只检查文字，不执行文件操作。';
const cancelledUrgent = '两分钟后又要截止了，请现在帮我核对这句话；先别动文件。';
type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi }; worldFlowStreams?: Array<{ at: number; event: CompanionReplyStreamEvent }> };
type LoggedRequest = { at: number; purpose: string; sourceText: string; sourceId?: string; world?: CompanionWorldSnapshot };
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
  rmSync(resolved, { recursive: true, force: true });
}
async function launch(profile: string) {
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'software' }) });
  const page = await application.firstWindow(), nativeWindow = await application.browserWindow(page);
  await nativeWindow.evaluate(win => { win.unmaximize(); win.setSize(1440, 900); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); });
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
  await page.locator('[data-application-module="companions"]').click(); return { application, page };
}
async function providerFixture() {
  const requests: LoggedRequest[] = [], streams = new Map<string, ServerResponse>();
  const firstText = '我已在自己的电脑前坐稳，开始核对你这条消息。', finalText = '文字核对已经完成。这是隔离验收，没有执行文件操作。';
  const chunk = (response: ServerResponse, text: string, finish: string | null = null) => response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] }) + '\n\n');
  const server = createServer((incoming, response) => {
    let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', value => { raw += value; });
    incoming.on('end', () => {
      try {
        const body = JSON.parse(raw), data = JSON.parse(body.messages[1].content), purpose = data.purpose ?? 'task_reply', sourceText = data.source?.content ?? data.taskRequest?.prompt ?? '';
        requests.push({ at: Date.now(), purpose, sourceText, sourceId: data.source?.id ?? data.taskRequest?.sourceMessageId, ...(data.world ? { world: data.world } : {}) });
        let output: unknown;
        if (purpose === 'world_attention') output = { urgency: [urgent, cancelledUrgent].includes(sourceText) ? 'urgent' : 'ordinary', confidence: .98, evidence: [sourceText], reason: '脚本中这条实际用户消息临近截止并请求立即协助。' };
        else if (purpose === 'world_decision') output = { action: null, reason: '本例的初始许可和占用由宿主预设。', appraisals: [] };
        else if (purpose === 'memory_dream') output = { candidates: [], dream: null };
        else if (purpose === 'memory_query') output = {};
        else if (purpose.startsWith('memory_')) output = { candidates: [] };
        else {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); response.flushHeaders(); chunk(response, firstText);
          streams.set(sourceText, response); response.on('close', () => { if (streams.get(sourceText) === response) streams.delete(sourceText); }); return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }));
      } catch { response.writeHead(400); response.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No provider fixture port.');
  return { requests, baseUrl: 'http://127.0.0.1:' + address.port, firstText, finalText,
    finish(text: string) { const response = streams.get(text); if (!response) throw new Error('No actual pending stream.'); chunk(response, '\n' + finalText); chunk(response, '', 'stop'); response.end('data: [DONE]\n\n'); },
    async close() { for (const response of streams.values()) response.destroy(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); },
  };
}

// Real preload/Main/UtilityProcess/SQLite/renderer physics and SSE. Only the
// external provider and initial host consent are scripted, never actor motion.
// eslint-disable-next-line no-empty-pattern
test('urgent notification runs home from an occupied borrowed computer and cancellation never starts a ghost task', async ({}, testInfo) => {
  test.setTimeout(180000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-world-flow-')), provider = await providerFixture();
  const artifacts = path.resolve('artifacts/companions'); mkdirSync(artifacts, { recursive: true });
  let application: ElectronApplication | undefined;
  const samples: Array<{ at: number; label: string; actor: CompanionWorldActor; works: CompanionWorldSnapshot['works'] }> = [];
  try {
    const started = await launch(path.join(root, 'profile')); application = started.application; const page = started.page;
    const configured = await page.evaluate(value => (window as unknown as Bridge).worldlinebox.llm.setConfig(value), { apiFormat: 'openai_chat' as const, model: 'fixture-world-flow', baseUrl: provider.baseUrl, apiKey: 'fixture-world-flow-key' }); expect(configured.ok).toBe(true);
    const guestRoom = (await request(page, { type: 'conversation.open', companionId: guestId })).conversation!, hostRoom = (await request(page, { type: 'conversation.open', companionId: hostId })).conversation!;
    const initial = await snapshot(page); await request(page, { type: 'world.configure', expectedRevision: initial.settings.revision, patch: { mode: 'realtime' } });
    for (const [companionId, conversationId] of [[guestId, guestRoom.id], [hostId, hostRoom.id]] as const) {
      const routine = (await request(page, { type: 'routine.get', companionId, conversationId })).routine!, hour = (await snapshot(page)).clock.hour;
      await request(page, { type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision, patch: { wakeAt: clock(hour - 8), sleepAt: clock(hour + 8), meals: [], habits: [] } });
    }
    const guestScope = { companionId: guestId, conversationId: guestRoom.id }, hostScope = { companionId: hostId, conversationId: hostRoom.id };
    const visit = (await request(page, { type: 'world.tool', ...guestScope, arguments: { action: 'visit', targetCompanionId: hostId, reason: '空闲时来分享读书感受。' } })).world!.visits.find(visit => visit.guestId === guestId)!;
    await request(page, { type: 'world.tool', ...hostScope, arguments: { action: 'respond', requestId: visit.id, decision: 'allow', reason: '欢迎，有空时来坐坐。' } });
    await expect.poll(async () => { const value = actor(await snapshot(page)); return value.sceneId === 'home_' + hostId && !value.route.length; }, { timeout: 40000 }).toBe(true);
    async function sitAtFriendsSofa() {
      const anchor = (await snapshot(page)).scenes.find(scene => scene.ownerId === hostId)!.objects.find(object => object.kind === 'sofa')!.anchor;
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
    const modal = worldPage.getByRole('region', { name: '伙伴世界', exact: true }); await modal.getByRole('combobox', { name: '观测地点', exact: true }).selectOption('commons');
    const source = (await request(page, { type: 'message.send', conversationId: guestRoom.id, content: urgent, clientId: randomUUID() })).message!;
    let streetCaptured = false, sawStand = false, sawRun = false;
    await expect.poll(async () => {
      const world = await snapshot(page), current = actor(world); samples.push({ at: Date.now(), label: 'urgent_journey', actor: current, works: world.works });
      sawStand ||= current.activity === 'standingUp'; sawRun ||= current.activity === 'walking' && current.locomotion === 'run';
      const replies = provider.requests.filter(request => request.purpose === 'task_reply' && request.sourceId === source.id);
      if (!world.works.some(work => work.companionId === guestId && work.status === 'ready')) expect(replies).toHaveLength(0);
      if (current.sceneId === 'commons' && current.activity === 'walking' && !streetCaptured) {
        await expect(modal.locator('[data-world-actor="' + guestId + '"]')).toBeVisible();
        await worldPage.screenshot({ path: path.join(artifacts, 'verified-world-urgent-running-home.png') }); streetCaptured = true;
      }
      return replies.length > 0;
    }, { timeout: 40000, intervals: [150, 250] }).toBe(true);
    expect(sawStand).toBe(true); expect(sawRun).toBe(true); expect(streetCaptured).toBe(true);
    expect(provider.requests.some(request => request.purpose === 'world_attention' && request.sourceText === urgent)).toBe(true);
    const first = provider.requests.find(request => request.purpose === 'task_reply' && request.sourceId === source.id)!;
    expect(actor(first.world!).sceneId).toBe('home_' + guestId); expect(actor(first.world!).furnitureId).toBe(guestId + '_computer'); expect(actor(first.world!).activity).toBe('working');
    expect(first.world!.works.find(work => work.companionId === guestId)?.status).toBe('ready');
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as Bridge).worldFlowStreams))!.some(value => value.event.sourceMessageId === source.id && value.event.text.includes(provider.firstText))).toBe(true);
    await modal.getByRole('combobox', { name: '观测地点', exact: true }).selectOption('home_' + guestId);
    await expect(modal.locator('[data-world-actor="' + guestId + '"]')).toHaveAttribute('data-world-activity', 'working');
    await worldPage.screenshot({ path: path.join(artifacts, 'verified-world-urgent-work-ready.png') });
    provider.finish(urgent); await modal.getByRole('button', { name: '关闭伙伴世界', exact: true }).click();
    await expect(page.locator('[data-companion-messages]')).toContainText(provider.finalText);
    await page.screenshot({ path: path.join(artifacts, 'verified-world-urgent-feedback.png') });
    await expect.poll(async () => (await snapshot(page)).works.filter(work => work.companionId === guestId).length).toBe(0);
    await request(page, { type: 'world.tool', ...guestScope, arguments: { action: 'move', destinationId: 'home_' + hostId } });
    await expect.poll(async () => { const value = actor(await snapshot(page)); return value.sceneId === 'home_' + hostId && !value.route.length && value.activity === 'idle'; }, { timeout: 40000 }).toBe(true);
    await sitAtFriendsSofa();
    const cancelled = (await request(page, { type: 'message.send', conversationId: guestRoom.id, content: cancelledUrgent, clientId: randomUUID() })).message!;
    await expect.poll(async () => { const world = await snapshot(page), value = actor(world); samples.push({ at: Date.now(), label: 'cancelled_journey', actor: value, works: world.works }); return value.sceneId === 'commons' && value.activity === 'walking'; }, { timeout: 25000, intervals: [200] }).toBe(true);
    expect(provider.requests.filter(request => request.purpose === 'task_reply' && request.sourceId === cancelled.id)).toHaveLength(0);
    await request(page, { type: 'reply.cancel', conversationId: guestRoom.id });
    await expect.poll(async () => (await snapshot(page)).works.filter(work => work.companionId === guestId).length).toBe(0);
    await page.waitForTimeout(2500);
    expect(provider.requests.filter(request => request.purpose === 'task_reply' && request.sourceId === cancelled.id)).toHaveLength(0);
    expect((await request(page, { type: 'actions', conversationId: guestRoom.id })).actions).toHaveLength(0);
    const events = (await page.evaluate(() => (window as unknown as Bridge).worldFlowStreams))!;
    expect(events.filter(value => value.event.sourceMessageId === cancelled.id && value.event.text)).toHaveLength(0);
    writeFileSync(path.join(artifacts, 'verified-world-work-flow.json'), JSON.stringify({ sourceId: source.id, cancelledSourceId: cancelled.id, samples, requests: provider.requests, streamEvents: events }, null, 2));
    await testInfo.attach('world-work-flow-evidence', { body: JSON.stringify({ samples, requests: provider.requests, streamEvents: events }, null, 2), contentType: 'application/json' });
  } catch (error) {
    writeFileSync(path.join(artifacts, 'verified-world-work-flow-failure.json'), JSON.stringify({ samples, requests: provider.requests }, null, 2));
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
    for (const scope of [guestScope, hostScope]) await request(page, { type: 'world.tool', ...scope, arguments: { action: 'move', destinationId: 'commons' } });
    await expect.poll(async () => { const world = await snapshot(page); return [guestId, hostId].every(id => actor(world, id).sceneId === 'commons' && !actor(world, id).route.length); }, { timeout: 30000 }).toBe(true);
    const social = (await request(page, { type: 'world.tool', ...guestScope, arguments: { action: 'social', targetCompanionId: hostId, kind: 'greet', text: '这是存档验收中真实发生的伙伴问候。' } })).world!;
    const peerEvent = social.events.find(event => event.actorId === guestId && event.kind === 'social_greet')!;
    const speech = (await request(page, { type: 'message.get', id: peerEvent.sourceMessageId! })).message!;
    expect(speech.authorId).toBe(guestId); expect(speech.authorId).not.toBe('user');
    const visit = (await request(page, { type: 'world.tool', ...guestScope, arguments: { action: 'visit', targetCompanionId: hostId, reason: '问候后得到许可再去做客。' } })).world!.visits.find(visit => visit.guestId === guestId)!;
    await request(page, { type: 'world.tool', ...hostScope, arguments: { action: 'respond', requestId: visit.id, decision: 'allow', reason: '欢迎有空时来。' } });
    await expect.poll(async () => actor(await snapshot(page)).route.length, { timeout: 10000 }).toBeGreaterThan(10);
    const saved = await snapshot(page), savedActor = actor(saved), savedRelation = saved.relationships.find(relation => relation.companionId === guestId && relation.targetCompanionId === hostId)!;
    expect(savedRelation.interactions).toBe(1); expect(savedRelation.affinity).toBe(50);
    expect(saved.visits.find(value => value.id === visit.id)?.status).toBe('allowed');
    const savedAt = Date.now();
    await application.close(); application = undefined;
    // Actual process absence is intentional; do not fake the host's persistence clock.
    await new Promise(resolve => setTimeout(resolve, 1200));
    started = await launch(profile); application = started.application; page = started.page;
    const restored = await snapshot(page), restoredActor = actor(restored);
    expect(restored.settings).toEqual(saved.settings);
    expect(Date.parse(restored.clock.virtualNow)).toBeGreaterThan(Date.parse(saved.clock.virtualNow));
    expect(restored.visits.find(value => value.id === visit.id)?.status).toBe('allowed');
    expect(restored.relationships.find(relation => relation.companionId === guestId && relation.targetCompanionId === hostId)).toMatchObject({ affinity: savedRelation.affinity, trust: savedRelation.trust, interactions: savedRelation.interactions });
    expect(restoredActor.sceneId === savedActor.sceneId && restoredActor.position.x === savedActor.position.x && restoredActor.position.y === savedActor.position.y).toBe(false);
    expect(restoredActor.sceneId === 'home_' + guestId && restoredActor.position.x === 10 && restoredActor.position.y === 13).toBe(false);
    // A route is persisted in scene segments: entering the host's doorway may
    // legitimately replace the saved street segment with its indoor segment.
    expect(restoredActor.destinationId ?? restoredActor.sceneId).toBe('home_' + hostId);
    expect(restoredActor.route.every(point => [savedActor.sceneId, 'home_' + hostId].includes(point.sceneId))).toBe(true);
    expect(restoredActor.activity).not.toBe('working');
    expect(restored.works).toHaveLength(0);
    await page.waitForTimeout(1500);
    expect(provider.requests.filter(request => request.purpose === 'task_reply' && request.sourceId === source.id)).toHaveLength(1);
    expect((await request(page, { type: 'messages', conversationId: guestRoom.id, limit: 100 })).messages!.filter(message => message.replyToId === source.id && message.authorId === guestId && message.content.includes(provider.finalText))).toHaveLength(1);
    const evidence = { sourceId: source.id, savedAt, restoredAt: Date.now(), saved, restored, providerRequests: provider.requests };
    const artifacts = path.resolve('artifacts/companions'); mkdirSync(artifacts, { recursive: true }); writeFileSync(path.join(artifacts, 'verified-world-save-restart.json'), JSON.stringify(evidence, null, 2));
    const worldPage = await openCompanionWorldWindow(application, page);
    const modal = worldPage.getByRole('region', { name: '伙伴世界', exact: true });
    await modal.getByRole('combobox', { name: '观测地点', exact: true }).selectOption(restoredActor.sceneId);
    await expect(modal.locator('canvas')).toHaveAttribute('data-world-ready', 'true');
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
    writeFileSync(path.join(artifacts, 'verified-world-save-restart.json'), JSON.stringify(completeEvidence, null, 2));
    await testInfo.attach('world-save-restart-evidence', { body: JSON.stringify(completeEvidence, null, 2), contentType: 'application/json' });
  } catch (error) {
    if (application) await application.firstWindow().then(page => page.screenshot({ path: testInfo.outputPath('world-save-failure.png') })).catch(() => undefined);
    throw error;
  } finally { await application?.close().catch(() => undefined); await provider.close(); cleanup(root); }
});
