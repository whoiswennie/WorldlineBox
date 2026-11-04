import { createServer } from 'node:http';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import type { BotRequest, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import type { BotMemoryCatalog, BotMemoryFullNote } from '../../src/shared/companion-bot-memory';
import type { BotMaintenanceCandidateDetail, BotMaintenanceCandidates, BotMaintenanceDiagnostics, BotMaintenanceJob, BotMaintenanceList, BotMaintenanceSettings } from '../../src/shared/companion-bot-maintenance';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

type Scope = { conversationId: string; companionId: string };
type Source = { id: string; content: string; checksum: string };
type Candidate = { type: 'organize' | 'update' | 'insight' | 'archive'; sourceIds: string[]; content: string; tags: string[]; reason: string; uncertainties: string[]; quotes: Array<{ sourceId: string; text: string }> };
async function memory<T>(page: Page, input: BotRequest): Promise<T> {
  const result = await page.evaluate(input => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request(input), input);
  expect(result.ok, `${input.type}: ${result.error ?? 'no successful receipt'}`).toBe(true); return result.memory as T;
}
const publicFacts = [
  '维护隔离测试A：周六的最新决定是下午三点在市美术馆南门见朋友，门票尚未预约。',
  '维护隔离测试B：周六还没有出发，早先湖边两点的计划已经被美术馆安排替代。',
  '维护隔离测试C：晚上喝麦茶、上午咖啡照旧；这是测试偏好，不是用户实际生活记录。',
  '维护隔离测试D：看展后是否喝茶还没有决定，不把待定安排写成已完成。\n' + Array.from({ length: 30 }, (_value, index) => `人编测试附注${index + 1}：这只是公开的界面长文样本，待定的参观后安排仍需本人确认。`).join('\n'),
];

/** Only model output is scripted. Native VCP reads, indexing and mutations are
 * performed by the real packaged Main/service; this server never writes notes. */
async function localPlanner(mode: 'actions' | 'fences') {
  const requests: Array<{ ordinal: number; kind: string; sourceIds: string[]; prompt: unknown; status: number }> = [];
  const errors: string[] = []; let reject = mode === 'fences';
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/models')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'maintenance-protocol-fixture', context_length: 65536 }] })); return; }
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }>; stream?: boolean };
      const prompt = body.messages.filter(value => value.role === 'user').at(-1)?.content;
      const snapshot = JSON.parse(prompt ?? '{}') as { kind: string; sources: Source[] };
      if (!Array.isArray(snapshot.sources) || snapshot.sources.length < 4) throw new Error('Real maintenance snapshot must provide four complete source notes.');
      if (requests.length >= 6) throw new Error('Bounded local protocol request budget exceeded.');
      const observation = { ordinal: requests.length + 1, kind: snapshot.kind, sourceIds: snapshot.sources.map(value => value.id), prompt: snapshot, status: reject ? 503 : 200 }; requests.push(observation);
      if (reject) { response.statusCode = 503; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: { message: 'Owned local fixture intentionally unavailable before explicit UI retry.', type: 'fixture_unavailable' } })); return; }
      const sources = publicFacts.map((_value, index) => snapshot.sources.find(source => source.content.includes(`维护隔离测试${'ABCD'[index]}`))!);
      if (sources.some(value => !value)) throw new Error('The real native snapshot did not preserve the authored test sources.');
      const [a, b, c, d] = sources as [Source, Source, Source, Source];
      const proposal = (type: Candidate['type'], selected: Source[], content: string): Candidate => ({ type, sourceIds: selected.map(value => value.id), content,
        tags: type === 'insight' ? ['梦境感悟', '非用户事实'] : ['维护隔离测试'], reason: type === 'archive' ? '仅归档测试冗余日记，保留可恢复原件，不撤回其他来源事实。' : '仅依据所列真实来源提出待审阅方案。', uncertainties: type === 'insight' ? ['这只是梦境联想，并非用户事实。'] : [],
        quotes: selected.map(value => ({ sourceId: value.id, text: value.content.slice(0, 80) })) });
      const candidates = mode === 'actions' ? [proposal('organize', [a, b], `${a.content}\n\n${b.content}`),
        proposal('insight', [c], '梦境感悟（非用户事实）：可以把麦茶联想为放慢节奏的意象，这不是用户做过的事。'), proposal('archive', [c], ''), proposal('update', [d], d.content)]
        : [proposal('update', [a], a.content), proposal('insight', [b], '梦境感悟（非用户事实）：雨天可以成为改变路线的意象，不能当成用户真实经历。')];
      const content = JSON.stringify({ narrative: '协议测试梦境：这些意象只供审阅，不是用户事实，也不会直接写入记忆。', candidates });
      if (body.stream) {
        response.setHeader('content-type', 'text/event-stream');
        const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: `local-maintenance-${requests.length}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        response.end(chunk({ role: 'assistant', content }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
      } else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id: `local-maintenance-${requests.length}`, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] })); }
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); response.statusCode = 500; response.end(JSON.stringify({ error: { message: errors.at(-1) } })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned local planner failed to bind.');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, errors, allow: () => { reject = false; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function launch(planner: Awaited<ReturnType<typeof localPlanner>>) {
  const prefix = 'wlb-bot-maintenance-app-', profile = await mkdtemp(path.join(tmpdir(), prefix));
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith(prefix) || (await lstat(profile)).isSymbolicLink() || path.resolve(await realpath(profile)) !== path.resolve(profile)) throw new Error('Unexpected owned maintenance profile.');
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) }).catch(async error => { await rm(profile, { recursive: true, force: true }); throw error; });
  try {
  const page = await application.firstWindow();
  const identity = await application.evaluate(({ app, BrowserWindow }, expected) => {
    const path = process.getBuiltinModule('node:path'); if (path.resolve(app.getPath('userData')) !== expected) throw new Error('Never use a production profile for maintenance tests.');
    const frames = { paints: 0 }; Reflect.set(globalThis, '__maintenanceFrames', frames);
    for (const owned of BrowserWindow.getAllWindows()) { owned.on('show', () => owned.hide()); owned.webContents.setBackgroundThrottling(false); owned.webContents.on('paint', () => { frames.paints++; }); owned.hide(); }
    return { packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData'), offscreen: BrowserWindow.getAllWindows()[0]!.webContents.isOffscreen() };
  }, profile);
  if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) { expect(identity.packaged).toBe(true); expect(identity.appPath).toMatch(/app\.asar$/u); }
  expect(identity.offscreen).toBe(true);
  await page.locator('[data-application-module="companions"]').click(); await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
  const configured = await page.evaluate(async baseUrl => { const api = (Reflect.get(window, 'worldlinebox') as { library: WorldlineBoxLibraryApi }).library;
    const saved = await api.saveAiProfile({ name: '仅本机维护协议测试', apiFormat: 'openai_chat', baseUrl, model: 'maintenance-protocol-fixture', apiKey: 'local-protocol-not-a-production-key' });
    if (!saved.ok) throw new Error('Could not save the owned local model profile.'); const activated = await api.activateAiProfile({ id: saved.value.id }); if (!activated.ok) throw new Error('Could not activate the owned local profile.'); return { saved: saved.ok, activated: activated.ok };
  }, planner.baseUrl);
  expect(configured).toEqual({ saved: true, activated: true });
  const initial = await page.evaluate(() => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state' }));
  expect(initial.ok).toBe(true); expect(initial.snapshot?.tasks).toEqual([]);
  const conversation = initial.snapshot!.conversations.find(value => value.kind === 'direct' && value.memberIds.includes(DEFAULT_BOT_COMPANION_ID))!;
  const scope = { conversationId: conversation.id, companionId: DEFAULT_BOT_COMPANION_ID };
  for (let index = 0; index < publicFacts.length; index++) await memory(page, { type: 'memory.remember', ...scope, content: publicFacts[index]!, requestId: `maintenance-seed-${index}`, tags: ['维护隔离测试'] });
  const catalog = await memory<BotMemoryCatalog>(page, { type: 'memory.catalog', ...scope, limit: 24 }); expect(catalog.total).toBe(4); expect(catalog.items.every(value => value.indexState === 'indexed')).toBe(true);
  const memoryRoot = path.join(profile, 'companion-bot-v2', 'memory'), homes = (await readdir(memoryRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name));
  expect(homes).toHaveLength(1); const config = JSON.parse(await readFile(path.join(memoryRoot, homes[0]!.name, 'config.json'), 'utf8')) as { VECTORDB_DIMENSION: number };
  expect(config.VECTORDB_DIMENSION).toBe(768);
  const notes = await Promise.all(catalog.items.map(value => memory<BotMemoryFullNote>(page, { type: 'memory.note', ...scope, id: value.id })));
  await page.getByRole('button', { name: '记忆', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '记忆工作台', exact: true }); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '整理与梦境', exact: true }).click();
  return { application, page, profile, scope, notes, identity: { ...identity, embeddingDimensions: config.VECTORDB_DIMENSION }, dialog, close: async () => { await application.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } };
  } catch (error) { await application.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); throw error; }
}
async function waitJob(page: Page, scope: Scope, status: string, evidencePath?: string) {
  let found: BotMaintenanceJob | undefined;
  await expect.poll(async () => { const list = await memory<BotMaintenanceList>(page, { type: 'memory.maintenance.list', ...scope, limit: 20 }); found = list.items[0];
    if (found?.status === 'blocked' && status !== 'blocked') {
      const diagnostics = await memory<BotMaintenanceDiagnostics>(page, { type: 'memory.maintenance.diagnostics', ...scope, jobId: found.id, limit: 20 });
      const entries = await Promise.all(diagnostics.items.map(entry => memory<BotMaintenanceDiagnostics>(page, { type: 'memory.maintenance.diagnostics', ...scope, jobId: found!.id, entryId: entry.id, limit: 20 })));
      if (evidencePath) await writeFile(evidencePath, JSON.stringify({ job: found, diagnostics, entries }, null, 2) + '\n');
      throw new Error(`Unexpected blocked maintenance: ${found.error ?? found.phase}`);
    }
    return found?.status; }, { timeout: 60000, intervals: [300, 700, 1500] }).toBe(status);
  return found!;
}
async function candidates(page: Page, scope: Scope, jobId: string) { return (await memory<BotMaintenanceCandidates>(page, { type: 'memory.maintenance.candidates', ...scope, jobId, limit: 12 })).items; }
async function approve(context: Awaited<ReturnType<typeof launch>>, jobId: string, candidateId: string) {
  const card = context.dialog.locator(`[data-maintenance-candidate="${candidateId}"]`); await card.locator('.bot-maintenance-candidate-open').click();
  await card.getByRole('button', { name: '审阅并批准', exact: true }).click(); await expect(card.locator('.bot-maintenance-review-confirm')).toBeVisible();
  await expect(card.getByRole('button', { name: '继续检查', exact: true })).toBeFocused(); await context.page.keyboard.press('Escape');
  await expect(context.dialog).toBeVisible(); await expect(card.locator('.bot-maintenance-review-confirm')).toHaveCount(0); await expect(card.getByRole('button', { name: '审阅并批准', exact: true })).toBeFocused();
  await card.getByRole('button', { name: '审阅并批准', exact: true }).click();
  await card.getByRole('button', { name: '确认批准此项', exact: true }).click();
  let detail: BotMaintenanceCandidateDetail | undefined;
  await expect.poll(async () => { detail = await memory<BotMaintenanceCandidateDetail>(context.page, { type: 'memory.maintenance.candidate', ...context.scope, jobId, candidateId }); return detail.status; }, { timeout: 45000, intervals: [250, 500, 1000] }).toBe('applied');
  await expect(card.locator('.bot-maintenance-candidate-detail')).toContainText('已应用'); return detail!;
}
async function capture(application: ElectronApplication, destination: string) {
  const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(destination, Buffer.from(png, 'base64'));
}
async function renderingEvidence(application: ElectronApplication) {
  const evidence = await application.evaluate(({ BrowserWindow }) => ({ nativeVisible: BrowserWindow.getAllWindows().some(window => window.isVisible()), paints: (Reflect.get(globalThis, '__maintenanceFrames') as { paints: number }).paints }));
  expect(evidence.nativeVisible).toBe(false); expect(evidence.paints).toBeGreaterThan(0); return evidence;
}
async function layoutEvidence(page: Page) {
  const value = await page.evaluate(() => {
    const rect = (selector: string) => { const value = document.querySelector(selector)!.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height, bottom: value.bottom }; };
    const toast = document.querySelector<HTMLElement>('.bot-maintenance-toast'), bounds = toast?.getBoundingClientRect();
    const actions = [...document.querySelectorAll('.bot-memory-maintenance button')].filter(node => !node.closest('.bot-maintenance-toast')).map(node => node.getBoundingClientRect()).filter(value => value.width && value.height);
    const pane = document.querySelector<HTMLElement>('.bot-memory-maintenance')!;
    return { heading: rect('.bot-memory-heading'), body: rect('.bot-maintenance-body'), left: rect('.bot-maintenance-jobs'), right: rect('.bot-maintenance-detail'),
      horizontalOverflow: pane.scrollWidth > pane.clientWidth, toast: toast && bounds ? { position: getComputedStyle(toast).position, width: bounds.width, overlapsActions: actions.some(action => bounds.left < action.right && bounds.right > action.left && bounds.top < action.bottom && bounds.bottom > action.top) } : undefined,
      leftScroll: getComputedStyle(document.querySelector('.bot-maintenance-left-scroll')!).overflowY, rightScroll: getComputedStyle(document.querySelector('.bot-maintenance-detail')!).overflowY };
  });
  expect(value.body.y).toBeCloseTo(value.heading.bottom, 0); expect(value.left.y).toBe(value.body.y); expect(value.right.y).toBe(value.body.y);
  expect(value.left.width).toBeGreaterThanOrEqual(190); expect(value.left.width).toBeLessThanOrEqual(250); expect(value.horizontalOverflow).toBe(false);
  expect(value.leftScroll).toBe('auto'); expect(value.rightScroll).toBe('auto');
  if (value.toast) { expect(value.toast.position).toBe('absolute'); expect(value.toast.overlapsActions).toBe(false); }
  return value;
}

// eslint-disable-next-line no-empty-pattern -- real Electron window, not Playwright's browser fixture
test('maintenance UI applies individually reviewed native organization, insight and archival without withdrawing related facts', async ({}, testInfo) => {
  test.setTimeout(180000); const planner = await localPlanner('actions'); let context: Awaited<ReturnType<typeof launch>> | undefined;
  const evidence = path.resolve('artifacts/superagent-bot-development/ui'); await mkdir(evidence, { recursive: true });
  try {
    context = await launch(planner); const { page, scope, dialog, notes } = context;
    const setting = await memory<BotMaintenanceSettings>(page, { type: 'memory.maintenance.settings.get', ...scope }); expect(setting.enabled).toBe(true); expect(setting.autoApply).toBe('never'); expect(setting.intervalHours).toBe(24); expect(setting.idleMinutes).toBe(15); expect(setting.minNotes).toBe(12);
    const beforeRun = await layoutEvidence(page);
    await dialog.getByRole('button', { name: '生成梦境候选', exact: true }).click(); await expect(dialog.locator('.bot-maintenance-toast[role=status]')).toBeVisible();
    const withNotice = await layoutEvidence(page); expect(withNotice.body).toEqual(beforeRun.body); expect(withNotice.right).toEqual(beforeRun.right); expect(withNotice.left).toEqual(beforeRun.left);
    await expect(dialog.locator('.bot-maintenance-toast')).toHaveCount(0, { timeout: 5000 }); const withoutNotice = await layoutEvidence(page); expect(withoutNotice.body).toEqual(beforeRun.body); expect(withoutNotice.right).toEqual(beforeRun.right);
    const job = await waitJob(page, scope, 'review', testInfo.outputPath('unexpected-blocked.json'));
    const items = await candidates(page, scope, job.id); expect(items).toHaveLength(4); expect(items.every(value => value.status === 'pending')).toBe(true);
    const first = await memory<BotMaintenanceCandidates>(page, { type: 'memory.maintenance.candidates', ...scope, jobId: job.id, limit: 1 });
    const next = await memory<BotMaintenanceCandidates>(page, { type: 'memory.maintenance.candidates', ...scope, jobId: job.id, limit: 1, cursor: first.nextCursor }); expect(first.nextCursor).toBeTruthy(); expect(first.items[0]!.id).not.toBe(next.items[0]!.id);
    const insight = items.find(value => value.type === 'insight')!, archive = items.find(value => value.type === 'archive')!, organize = items.find(value => value.type === 'organize')!, rejected = items.find(value => value.type === 'update')!;
    const insightCard = dialog.locator(`[data-maintenance-candidate="${insight.id}"]`); await insightCard.locator('.bot-maintenance-candidate-open').click();
    await expect(insightCard).toContainText('非用户事实'); await insightCard.getByRole('button', { name: '查看原日记', exact: true }).click(); await expect(insightCard.locator('.bot-maintenance-source-body')).toContainText('晚上喝麦茶');
    await insightCard.locator('.bot-maintenance-candidate-open').click(); const insightReceipt = await approve(context, job.id, insight.id);
    const insightId = String((insightReceipt.receipt?.receipt as Record<string, unknown>)?.id); expect(insightId).toMatch(/^[a-f0-9]{64}$/);
    const dreamNote = await memory<BotMemoryFullNote>(page, { type: 'memory.note', ...scope, id: insightId }); expect(dreamNote.tags).toContain('非用户事实'); expect(dreamNote.content).toContain('梦境');
    const archived = await approve(context, job.id, archive.id); expect(archived.receipt?.status).toBe('archived');
    const originalC = notes.find(value => value.content.includes('维护隔离测试C'))!;
    expect(archived.receipt?.receipt).toMatchObject({ id: originalC.id, state: 'archived', checksum: originalC.checksum, indexed: false, retained: true });
    const retained = await memory<BotMemoryFullNote>(page, { type: 'memory.note', ...scope, id: originalC.id }); expect(retained.content).toBe(originalC.content); expect(retained.indexState).toBe('archived');
    expect((await memory<BotMemoryFullNote>(page, { type: 'memory.note', ...scope, id: insightId })).content).toBe(dreamNote.content);
    const merged = await approve(context, job.id, organize.id); expect(merged.receipt?.status).toBe('indexed');
    const rejectedCard = dialog.locator(`[data-maintenance-candidate="${rejected.id}"]`); await rejectedCard.locator('.bot-maintenance-candidate-open').click(); await rejectedCard.getByRole('button', { name: '驳回候选', exact: true }).click();
    await expect.poll(async () => (await memory<BotMaintenanceCandidateDetail>(page, { type: 'memory.maintenance.candidate', ...scope, jobId: job.id, candidateId: rejected.id })).status).toBe('rejected');
    const current = await memory<BotMemoryCatalog>(page, { type: 'memory.catalog', ...scope, limit: 24 }); expect(current.items.find(value => value.id === originalC.id)?.indexState).toBe('archived'); expect(current.items.find(value => value.id === insightId)?.indexState).toBe('indexed');
    const diagnosticFirst = await memory<BotMaintenanceDiagnostics>(page, { type: 'memory.maintenance.diagnostics', ...scope, jobId: job.id, limit: 1 });
    const diagnosticNext = await memory<BotMaintenanceDiagnostics>(page, { type: 'memory.maintenance.diagnostics', ...scope, jobId: job.id, limit: 1, after: diagnosticFirst.nextAfter }); expect(diagnosticFirst.nextAfter).toBeDefined(); expect(diagnosticFirst.items[0]!.id).not.toBe(diagnosticNext.items[0]!.id);
    await dialog.getByRole('button', { name: '梦境与诊断', exact: true }).click(); await dialog.getByRole('button', { name: '阅读这段', exact: true }).first().click(); await expect(dialog.locator('.bot-maintenance-diagnostic pre')).not.toBeEmpty();
    await dialog.getByRole('button', { name: '候选方案', exact: true }).click(); await insightCard.locator('.bot-maintenance-candidate-open').click(); await expect(insightCard).toContainText('非用户事实');
    const beforeSettings = await layoutEvidence(page); await dialog.locator('.bot-maintenance-settings>summary').click(); const settingsOpen = await layoutEvidence(page); expect(settingsOpen.right).toEqual(beforeSettings.right);
    await dialog.getByRole('spinbutton', { name: '最短间隔（小时）', exact: true }).fill('48');
    await dialog.getByRole('checkbox', { name: '启用周期后台维护', exact: true }).uncheck(); await dialog.getByRole('button', { name: '保存后台设置', exact: true }).click();
    const disabledSchedule = await memory<BotMaintenanceSettings>(page, { type: 'memory.maintenance.settings.get', ...scope }); expect(disabledSchedule.intervalHours).toBe(48); expect(disabledSchedule.enabled).toBe(false); expect(disabledSchedule.autoApply).toBe('never');
    await dialog.getByRole('checkbox', { name: '启用周期后台维护', exact: true }).check(); await dialog.getByRole('button', { name: '保存后台设置', exact: true }).click();
    expect((await memory<BotMaintenanceSettings>(page, { type: 'memory.maintenance.settings.get', ...scope })).enabled).toBe(true);
    const settingsNotice = await layoutEvidence(page); expect(settingsNotice.right).toEqual(beforeSettings.right); await dialog.locator('.bot-maintenance-settings>summary').click(); const settingsClosed = await layoutEvidence(page); expect(settingsClosed.right).toEqual(beforeSettings.right);
    await page.evaluate(() => document.fonts.ready); const light = testInfo.outputPath('memory-maintenance-light.png'); await capture(context.application, light); await copyFile(light, path.join(evidence, 'memory-maintenance-light.png'));
    await page.evaluate(() => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'dark' }))); await page.reload(); await page.locator('[data-application-module="companions"]').click();
    await page.getByRole('button', { name: '记忆', exact: true }).click(); await page.getByRole('button', { name: '整理与梦境', exact: true }).click(); await page.locator(`[data-maintenance-job="${job.id}"]`).click();
    await page.locator(`[data-maintenance-candidate="${insight.id}"] .bot-maintenance-candidate-open`).click(); await expect(page.locator('.bot-maintenance-candidate-detail')).toContainText('非用户事实');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await page.evaluate(() => document.fonts.ready); const dark = testInfo.outputPath('memory-maintenance-dark.png'); await capture(context.application, dark); await copyFile(dark, path.join(evidence, 'memory-maintenance-dark.png'));
    await page.locator(`[data-maintenance-candidate="${rejected.id}"] .bot-maintenance-candidate-open`).click();
    await expect(page.locator('.bot-maintenance-proposed')).toContainText('人编测试附注30');
    await context.application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setMinimumSize(0, 0); window.setContentSize(850, 800); });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(850); const narrow = await layoutEvidence(page);
    const longBody = await page.locator('.bot-maintenance-proposed').evaluate(node => ({ scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflow: getComputedStyle(node).overflowY })); expect(longBody.scrollHeight).toBeGreaterThan(longBody.clientHeight); expect(longBody.overflow).toBe('auto');
    await page.locator('.bot-maintenance-proposed').evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await expect(page.locator('.bot-maintenance-proposed')).toBeInViewport({ ratio: 1 });
    const beforePaint = await context.application.evaluate(({ BrowserWindow }) => { const frames = Reflect.get(globalThis, '__maintenanceFrames') as { paints: number }; BrowserWindow.getAllWindows()[0]!.webContents.invalidate(); return frames.paints; });
    await expect.poll(() => context!.application.evaluate(() => (Reflect.get(globalThis, '__maintenanceFrames') as { paints: number }).paints)).toBeGreaterThan(beforePaint);
    const narrowImage = testInfo.outputPath('memory-maintenance-narrow-dark.png'); await capture(context.application, narrowImage); await copyFile(narrowImage, path.join(evidence, 'memory-maintenance-narrow-dark.png'));
    expect(planner.errors).toEqual([]); expect(planner.requests).toHaveLength(1);
    const rendering = await renderingEvidence(context.application);
    await writeFile(path.join(evidence, 'memory-maintenance-native-evidence.json'), JSON.stringify({ identity: context.identity, rendering, boundary: 'Real Main IPC/VCP/Rust/bundled 768, authored isolated notes, only model output uses local deterministic HTTP; not language quality acceptance', paidRequests: 0,
      layout: { beforeRun, withNotice, withoutNotice, beforeSettings, settingsOpen, settingsNotice, settingsClosed, narrow, longBody }, originalNotes: notes.map(value => ({ id: value.id, checksum: value.checksum })), job, candidates: items, actualReceipts: [insightReceipt, archived, merged], rejected: rejected.id, relatedInsightSurvivedArchive: true, currentCatalog: current, diagnosticsPagination: { first: diagnosticFirst.items[0]?.id, next: diagnosticNext.items[0]?.id }, providerRequests: planner.requests }, null, 2) + '\n');
  } finally { await writeFile(testInfo.outputPath('local-planner-records.json'), JSON.stringify({ requests: planner.requests, errors: planner.errors }, null, 2) + '\n'); if (context) await capture(context.application, testInfo.outputPath('final-native-window.png')); await context?.close(); await planner.close(); }
});

// eslint-disable-next-line no-empty-pattern -- real Electron window, not Playwright's browser fixture
test('maintenance UI recovers a failed local model plan and fences checksum changes, withdrawn sources and foreign scopes', async ({}, testInfo) => {
  test.setTimeout(180000); const planner = await localPlanner('fences'); let context: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    context = await launch(planner); const { page, dialog, scope, notes } = context;
    await dialog.getByRole('button', { name: '生成梦境候选', exact: true }).click(); const blocked = await waitJob(page, scope, 'blocked');
    expect(planner.requests[0]?.status).toBe(503); planner.allow(); await dialog.getByRole('button', { name: '重试未完成部分', exact: true }).click(); await waitJob(page, scope, 'review', testInfo.outputPath('unexpected-blocked.json'));
    const items = await candidates(page, scope, blocked.id); expect(items).toHaveLength(2); const update = items.find(value => value.type === 'update')!;
    const firstPage = await memory<BotMaintenanceList>(page, { type: 'memory.maintenance.list', ...scope, limit: 1 }); expect(firstPage.items[0]?.id).toBe(blocked.id);
    const target = notes.find(value => value.content.includes('维护隔离测试A'))!, updatedText = target.content + '\n本地测试更正：当前门票状态改为已预约，这是新的人编测试输入。';
    const card = dialog.locator(`[data-maintenance-candidate="${update.id}"]`); await card.locator('.bot-maintenance-candidate-open').click();
    await memory(page, { type: 'memory.update', ...scope, id: target.id, expectedChecksum: target.checksum, content: updatedText, tags: target.tags });
    await card.getByRole('button', { name: '审阅并批准', exact: true }).click(); await card.getByRole('button', { name: '确认批准此项', exact: true }).click();
    await expect.poll(async () => (await memory<BotMaintenanceCandidateDetail>(page, { type: 'memory.maintenance.candidate', ...scope, jobId: blocked.id, candidateId: update.id })).status, { timeout: 45000 }).toBe('conflict');
    expect((await memory<BotMemoryFullNote>(page, { type: 'memory.note', ...scope, id: target.id })).content).toBe(updatedText);
    await expect(card.locator('.bot-maintenance-candidate-detail')).toContainText('来源已变化');
    const other = await page.evaluate(companionId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'conversation.create', title: '维护隔离的其他受众', kind: 'group', memberIds: [companionId], participationMode: 'mentions' }), scope.companionId);
    expect(other.ok).toBe(true); expect(other.conversationId).toBeTruthy();
    const foreign = await page.evaluate(input => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request(input), { type: 'memory.maintenance.get', companionId: scope.companionId, conversationId: other.conversationId!, jobId: blocked.id } satisfies BotRequest);
    expect(foreign.ok).toBe(false);
    const toForget = notes.find(value => value.content.includes('维护隔离测试B'))!;
    await memory(page, { type: 'memory.forget', ...scope, id: toForget.id });
    await expect(dialog).toContainText('旧候选和诊断正文已停止显示'); await expect(dialog.locator('.bot-maintenance-candidate-detail')).toHaveCount(0);
    const diagnostics = await memory<{ items: Array<{ id: number; preview: string }> }>(page, { type: 'memory.maintenance.diagnostics', ...scope, jobId: blocked.id, limit: 20 });
    expect(diagnostics.items.every(value => !value.preview.includes('维护隔离测试A') && !value.preview.includes('维护隔离测试B'))).toBe(true);
    const oldApproval = await page.evaluate(input => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request(input), { type: 'memory.maintenance.review', ...scope, jobId: blocked.id, candidateId: update.id, revision: update.revision, decision: 'approve', requestId: 'withdrawn-approval-must-fail' } satisfies BotRequest);
    expect(oldApproval.ok).toBe(false); expect(planner.errors).toEqual([]); expect(planner.requests.length).toBeLessThanOrEqual(4);
    const rendering = await renderingEvidence(context.application);
    await writeFile(testInfo.outputPath('maintenance-fences-evidence.json'), JSON.stringify({ identity: context.identity, rendering, boundary: 'Native maintenance recovery/withdrawal fences with local HTTP model protocol, no paid model or DSH', blocked, cases: { explicitUiRetry: true, checksumConflictDidNotOverwrite: true, foreignScopeRejected: true, withdrawnApprovalRejected: true, cachedOldBodyRetired: true }, diagnostics, providerRequests: planner.requests }, null, 2) + '\n');
  } finally { await writeFile(testInfo.outputPath('local-planner-records.json'), JSON.stringify({ requests: planner.requests, errors: planner.errors }, null, 2) + '\n'); if (context) await capture(context.application, testInfo.outputPath('final-native-window.png')); await context?.close(); await planner.close(); }
});
