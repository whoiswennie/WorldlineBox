import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, ensureCompanionTestWorkspace, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

const owner = 'deepseek-flash', prefix = '任务中心并发验收/';
type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi } };

// Only provider response timing is controlled; claims, limits, cancellation,
// recovery, persistence, source validation and the task UI are real.
// eslint-disable-next-line no-empty-pattern
test('controls three cross-room tasks, records user stop, changes the shared limit and explicitly resumes the same progress', async ({}) => {
  test.setTimeout(240_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-task-control-')), profile = path.join(root, 'profile');
  const held = new Map<number, ServerResponse[]>(), calls = new Map<number, number>(), payloads = new Map<number, Record<string, unknown>>(), purposes: string[] = [];
  let application: ElectronApplication | undefined;
  const server = createServer((incoming, response) => {
    let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', part => { raw += part; });
    incoming.on('end', () => {
      try {
        const body = JSON.parse(raw), messages = body.messages as Array<{ role: string; content: string }>;
        const text = messages?.findLast(message => message.role === 'user')?.content ?? '';
        let context: Record<string, unknown>; try { context = JSON.parse(text); } catch { answer(response, '[[Tag: 验收]]'); return; }
        purposes.push(String(context.purpose ?? 'main'));
        const prompt = (context.taskRequest as { prompt?: string } | undefined)?.prompt;
        if (!context.purpose && prompt?.startsWith(prefix)) {
          const id = Number(prompt.slice(prefix.length)); calls.set(id, (calls.get(id) ?? 0) + 1); payloads.set(id, context);
          const pending = held.get(id) ?? []; pending.push(response); held.set(id, pending); return;
        }
        const value = context.purpose === 'world_attention' ? { urgency: 'ordinary', confidence: .99, evidence: [], reason: '常规验收' }
          : context.purpose === 'world_decision' ? { action: null, reason: '无需额外行动', appraisals: [] }
            : context.purpose === 'world_social' ? { text: null, reason: '本次无额外交流' }
              : context.purpose === 'companion_social_progress_review' ? { supported: true, correction: '' }
              : context.purpose === 'vcp_memory_prohibition_check' ? { allowed: true, matchedPolicyIds: [] } : { notes: [], dream: null };
        answer(response, JSON.stringify(value));
      } catch { response.writeHead(500); response.end('Invalid local fixture request.'); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No local fixture port');
  const launch = async () => {
    application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
    await preparePackagedCompanionLaunch(application, profile);
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setContentSize(1440, 960); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
    return page;
  };
  const release = (id: number) => { for (const response of held.get(id) ?? []) answer(response, `任务 ${id} 已完成。`); };
  try {
    let page = await launch(); await ensureCompanionTestWorkspace(page);
    for (const id of ['deepseek-sister', owner]) await request(page, { type: 'companion.set-active', id, active: false });
    expect((await page.evaluate(baseUrl => (window as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', baseUrl, model: 'task-control-local-barrier', apiKey: 'local-fixture', autoAnalyzeEnabled: false, disclaimerAccepted: true }), `http://127.0.0.1:${address.port}`)).ok).toBe(true);
    const role = (await request(page, { type: 'state' })).state!.companions.find(item => item.id === owner)!;
    await request(page, { type: 'companion.update', id: owner, expectedRevision: role.revision, companion: { name: role.name, description: role.description, persona: role.persona, model: '', avatar: role.avatar, proactive: false, inputMode: 'queue' } });
    const room = (await request(page, { type: 'conversation.open', companionId: owner })).conversation!;
    const rooms = [room.id];
    for (let index = 0; index < 3; index++) rooms.push((await request(page, { type: 'conversation.create-group', title: '任务验收群' + index, memberIds: [owner] })).conversation!.id);
    await readyAtDesk(page, room.id);
    expect((await request(page, { type: 'tasks.concurrency.get', companionId: owner })).taskConcurrency?.policies[0]?.limit).toBe(3);
    const sources: string[] = [];
    for (let id = 1; id <= 4; id++) sources.push((await request(page, { type: 'message.send', conversationId: rooms[id - 1]!, content: prefix + id, clientId: 'task-control-' + id, delivery: 'queue' })).message!.id);
    await expect.poll(() => [1, 2, 3].filter(id => calls.has(id)).length, { timeout: 60_000 }).toBe(3);
    expect(calls.has(4)).toBe(false);
    const tasks = (await request(page, { type: 'tasks.list', companionId: owner, view: 'current', limit: 50 })).taskPage!;
    const third = tasks.items.find(item => item.kind === 'reply' && item.sourceMessageId === sources[2])!;
    expect(third).toBeTruthy(); expect(tasks.items.filter(item => item.kind === 'reply' && item.status === 'running')).toHaveLength(3);
    expect(third.startedAt).toBeTruthy();
    expect(tasks.items.find(item => item.kind === 'reply' && item.sourceMessageId === sources[3])?.startedAt).toBeUndefined();
    await page.locator('[data-application-module="companions"]').click(); await page.locator(`[data-companion-conversation="${room.id}"]`).click();
    await page.getByRole('button', { name: '查看伙伴任务', exact: true }).click();
    const dashboard = page.getByRole('dialog', { name: '伙伴任务总览', exact: true }); await expect(dashboard).toBeVisible();
    await dashboard.locator(`#companion-task-dashboard-owner`).selectOption(owner);
    await dashboard.locator(`[data-companion-task="reply:${third.id}"]`).click();
    await dashboard.getByRole('button', { name: `停止任务 ${third.title}`, exact: true }).click();
    await expect.poll(async () => (await request(page, { type: 'tasks.list', companionId: owner, view: 'history', limit: 50 })).taskPage?.items.find(item => item.id === third.id)?.stoppedByUser).toBe(true);
    await expect.poll(() => calls.get(4), { timeout: 30_000 }).toBe(1);
    const siblings = (await request(page, { type: 'tasks.list', companionId: owner, view: 'current', limit: 50 })).taskPage!;
    expect(siblings.items.filter(item => item.kind === 'reply' && [sources[0], sources[1]].includes(item.sourceMessageId)).every(item => item.status === 'running')).toBe(true);
    await dashboard.locator('summary[aria-label="并发设置"]').click();
    const settings = dashboard.locator('.task-concurrency-popover');
    await expect(settings).toBeVisible();
    const settingsBox = await settings.boundingBox(), settingsLimit = await dashboard.getByRole('combobox', { name: `${role.name} 并发任务上限` }).boundingBox();
    expect(settingsBox?.width).toBeGreaterThanOrEqual(320); expect(settingsLimit?.width).toBeGreaterThanOrEqual(40);
    expect(settingsBox!.x + settingsBox!.width).toBeLessThanOrEqual((await page.viewportSize())?.width ?? 1440);
    mkdirSync(path.resolve('artifacts/vcp-validation'), { recursive: true });
    await page.screenshot({ path: path.resolve('artifacts/vcp-validation/companion-task-center-settings.png') });
    await dashboard.getByRole('combobox', { name: `${role.name} 并发任务上限` }).selectOption('1');
    await dashboard.getByRole('button', { name: `保存 ${role.name} 并发设置` }).click();
    await expect.poll(async () => (await request(page, { type: 'tasks.concurrency.get', companionId: owner })).taskConcurrency?.policies[0]?.limit).toBe(1);
    await request(page, { type: 'message.send', conversationId: rooms[2]!, content: prefix + '5', clientId: 'task-control-5', delivery: 'queue' });
    expect(calls.has(5)).toBe(false);
    release(1); release(2);
    await expect.poll(async () => (await request(page, { type: 'tasks.list', companionId: owner, view: 'current', limit: 50 })).taskPage?.items.filter(item => item.kind === 'reply' && item.status === 'running').length, { timeout: 30_000 }).toBe(1);
    expect(calls.get(1)).toBe(1); expect(calls.get(2)).toBe(1);
    expect(calls.has(5)).toBe(false); release(4);
    await expect.poll(() => calls.get(5), { timeout: 30_000 }).toBe(1);
    expect((payloads.get(5)?.userTaskStops as Array<{ taskId: string; stop: { actor: string; reason: string } }> | undefined)?.some(item => item.taskId === third.id && item.stop.actor === 'user' && item.stop.reason === 'user_requested')).toBe(true);
    await dashboard.getByRole('tab', { name: '已结束记录', exact: true }).click();
    await dashboard.locator(`[data-companion-task="reply:${third.id}"]`).click(); await expect(dashboard.locator('[data-selected-task]')).toContainText('用户已停止');
    mkdirSync(path.resolve('artifacts/vcp-validation'), { recursive: true });
    const rowAvatars = await dashboard.locator('.task-center-list .companion-avatar').evaluateAll(elements => elements.map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
    expect(rowAvatars.length).toBeGreaterThan(0); expect(rowAvatars.every(avatar => avatar.width >= 16 && avatar.width <= 22 && Math.abs(avatar.width - avatar.height) < 1)).toBe(true);
    await page.screenshot({ path: path.resolve('artifacts/vcp-validation/companion-task-center.png') });
    await dashboard.getByRole('button', { name: `恢复任务 ${third.title}`, exact: true }).click();
    expect(calls.get(3)).toBe(1); release(5);
    await expect.poll(() => calls.get(3), { timeout: 30_000 }).toBe(2); release(3);
    await expect.poll(async () => (await request(page, { type: 'tasks.list', companionId: owner, view: 'history', limit: 50 })).taskPage?.items.find(item => item.id === third.id)?.status).toBe('completed');
    const resumed = (await request(page, { type: 'tasks.list', companionId: owner, view: 'history', limit: 50 })).taskPage!.items.find(item => item.id === third.id)!;
    expect(resumed.messageId).toBe(third.messageId); expect(resumed.sourceMessageId).toBe(third.sourceMessageId); expect(resumed.stoppedByUser).toBe(false);
    await application!.close(); application = undefined; page = await launch();
    expect((await request(page, { type: 'tasks.concurrency.get', companionId: owner })).taskConcurrency?.policies[0]?.limit).toBe(1);
    expect((await request(page, { type: 'tasks.list', companionId: owner, view: 'history', limit: 50 })).taskPage?.items.find(item => item.id === third.id)?.status).toBe('completed');
    const observedInput = (await request(page, { type: 'task.inspect', companionId: owner, kind: 'reply', id: third.id, section: 'input', offset: 0, limit: 12 })).taskDetail!;
    expect(observedInput.items.some(item => item.text === prefix + '3')).toBe(true);
    const observedOutput = (await request(page, { type: 'task.inspect', companionId: owner, kind: 'reply', id: third.id, section: 'output', offset: 0, limit: 12 })).taskDetail!;
    expect(observedOutput.items.some(item => item.text.includes('任务 3 已完成'))).toBe(true);
    await page.locator('[data-application-module="companions"]').click(); await page.locator(`[data-companion-conversation="${rooms[2]}"]`).click();
    await page.getByRole('button', { name: '查看伙伴任务', exact: true }).click();
    const observedDashboard = page.getByRole('dialog', { name: '伙伴任务总览', exact: true });
    await observedDashboard.getByRole('tab', { name: '已结束记录', exact: true }).click();
    await observedDashboard.locator(`[data-companion-task="reply:${third.id}"]`).click();
    await observedDashboard.getByRole('tab', { name: '任务结果', exact: true }).click();
    await expect(observedDashboard.locator('.task-inspector-records')).toContainText('任务 3 已完成');
    await page.screenshot({ path: path.resolve('artifacts/vcp-validation/companion-task-observation.png') });
    writeFileSync(path.resolve('artifacts/vcp-validation/companion-task-control.json'), JSON.stringify({ defaultLimit: 3, persistedLimit: 1,
      threeCrossRoomTasksHeld: true, fourthWaited: true, selectiveUserStop: true, stopReceiptInNextModelContext: true,
      resumedSameMessageId: resumed.messageId === third.messageId, inspectInputAndOutputAfterRestart: true, counts: Object.fromEntries(calls), realUserDataModified: false }, null, 2));
  } finally {
    mkdirSync(path.resolve('artifacts/vcp-validation'), { recursive: true });
    writeFileSync(path.resolve('artifacts/vcp-validation/companion-task-control-observations.json'), JSON.stringify({ calls: Object.fromEntries(calls), purposes }, null, 2));
    for (const responses of held.values()) for (const response of responses) response.destroy();
    await application?.close().catch(() => undefined); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    cleanup(root);
  }
});

function cleanup(root: string) {
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-task-control-')) throw Error('Invalid owned task fixture cleanup');
  removeCompanionTestDirectory(root);
}

function answer(response: ServerResponse, content: string) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
}
async function request(page: Page, command: CompanionsRequest) {
  const response = await page.evaluate(input => (window as unknown as Bridge).worldlinebox.companions.request(input), command);
  expect(response.ok, response.error).toBe(true); return response;
}
async function readyAtDesk(page: Page, conversationId: string) {
  await request(page, { type: 'companion.set-active', id: owner, active: true });
  const world = (await request(page, { type: 'world.snapshot' })).world!, routine = (await request(page, { type: 'routine.get', companionId: owner, conversationId })).routine!;
  const clock = (offset: number) => String((Math.floor(world.clock.hour) + offset + 24) % 24).padStart(2, '0') + ':00';
  await request(page, { type: 'routine.configure', companionId: owner, conversationId, expectedRevision: routine.revision, patch: { timeZone: world.settings.timeZone, wakeAt: clock(-8), sleepAt: clock(8), meals: [], habits: [] } });
  const home = world.scenes.find(scene => scene.ownerId === owner)!, computer = home.objects.find(object => object.kind === 'computer')!;
  await request(page, { type: 'world.tool', companionId: owner, conversationId, arguments: { action: 'move', destinationId: computer.id } });
  await expect.poll(async () => { const actor = (await request(page, { type: 'world.snapshot' })).world!.actors.find(item => item.companionId === owner)!; return actor.sceneId === home.id && !actor.route.length && Math.hypot(actor.position.x - computer.anchor.x, actor.position.y - computer.anchor.y) < .01; }, { timeout: 30_000 }).toBe(true);
}
