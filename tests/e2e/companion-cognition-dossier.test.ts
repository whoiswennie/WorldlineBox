import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionsRequest } from '../../src/shared/companions';
import type { CompanionWorkspaceRequest } from '../../src/shared/companion-workspace';
import type { CompanionContextSnapshot } from '../../src/shared/companion-cognition';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, ensureCompanionTestWorkspace, removeCompanionTestDirectory, preparePackagedCompanionLaunch, resolveElectronLaunchOptions } from './electron-test-helpers';
import {companionEvidenceEnvironment,companionEvidenceName} from './companion-evidence-environment';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi } };
const screenshots = path.resolve('artifacts/cognition-validation/ui');
function cleanup(root: string) {
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-cognition-dossier-')) throw new Error('Unexpected visual acceptance cleanup target.');
  removeCompanionTestDirectory(root);
}
async function appearance(page: Page, mode: '亮色' | '暗色') {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '通用设置', exact: true });
  await dialog.getByRole('tab', { name: '外观', exact: true }).click();
  await dialog.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
  await dialog.getByRole('radio', { name: mode, exact: true }).click();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
}

test('creates a new identity through the UI and presents its actual read-only cognition in wide, compact and dark views', async () => {
  test.setTimeout(180000); mkdirSync(screenshots, { recursive: true });
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-cognition-dossier-'));
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ ...resolveElectronLaunchOptions(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') }, { gpu: 'software' }) });
    await preparePackagedCompanionLaunch(application,path.join(root,'profile'));
    const build=await companionEvidenceEnvironment(application,path.join(root,'profile'));
    writeFileSync(path.join(screenshots,companionEvidenceName('cognition-creation-build-proof.json')),JSON.stringify(build,null,2));
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(window => { window.hide(); window.setSize(1600, 1080); window.webContents.setBackgroundThrottling(false); });
    await ensureCompanionTestWorkspace(page);
    const state = await page.evaluate(() => (window as unknown as Bridge).worldlinebox.companions.request({ type: 'state' }));
    expect(state.ok, state.error).toBe(true); expect(state.state!.companions).toHaveLength(0);
    await page.locator('[data-application-module="companions"]').click();
    await page.getByRole('button', { name: '联系人', exact: true }).click();
    await page.getByRole('button', { name: '添加联系人', exact: true }).first().click();
    const create = page.getByRole('dialog', { name: '添加联系人', exact: true });
    await expect(create).toContainText('角色的起点');
    await page.screenshot({ path: path.join(screenshots, companionEvidenceName('creation-light.png')) });
    await create.locator('[data-builtin-template="flash"]').getByRole('button', { name: '添加', exact: true }).click();
    await expect(create).toHaveCount(0, { timeout: 30000 });
    const created = await page.evaluate(() => (window as unknown as Bridge).worldlinebox.companions.request({ type: 'state' }));
    const owner = created.state!.companions[0]!; expect(owner.id).toMatch(/^[a-f0-9-]{36}$/u); expect(owner.templateId).toBe('flash');
    await page.getByRole('button', { name: '联系人', exact: true }).click();
    await page.locator(`[data-companion-contact="${owner.id}"]`).click();
    const dossier = page.getByRole('region', { name: '伙伴认知档案', exact: true });
    await expect(dossier).toContainText('创建原稿已封存', { timeout: 30000 });
    await expect(dossier).toContainText('只读档案'); await expect(dossier.getByRole('tab')).toHaveCount(4); await expect(dossier.locator('.cognition-nav-group')).toHaveCount(0);
    await expect(dossier.locator('textarea, [contenteditable="true"]')).toHaveCount(0);
    expect(await dossier.locator('.cognition-reading').evaluate(node => node.clientWidth / node.closest('.companion-cognition-dossier')!.clientWidth)).toBeGreaterThan(.9);
    expect((await page.locator('.companions-profile-heading').boundingBox())!.height).toBeLessThan(100);
    await page.screenshot({ path: path.join(screenshots, companionEvidenceName('dossier-wide-light.png')) });
    await dossier.getByRole('button', { name: '表达与相处', exact: true }).click();
    await expect(dossier.getByRole('button', { name: '表达与相处', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.screenshot({ path: path.join(screenshots, companionEvidenceName('expression-wide-light.png')) });
    await dossier.getByRole('tab', { name: '运行核对', exact: true }).click(); await dossier.getByRole('button', { name: '本次实际上下文', exact: true }).click();
    await expect(dossier).toContainText('尚无', { timeout: 10000 });
    await page.screenshot({ path: path.join(screenshots, companionEvidenceName('actual-context-empty.png')) });
    await dossier.getByRole('tab', { name: '经历档案', exact: true }).click(); await dossier.getByRole('button', { name: '起点档案', exact: true }).click();
    await native.evaluate(window => window.setSize(1120, 900));
    await page.screenshot({ path: path.join(screenshots, companionEvidenceName('dossier-compact-light.png')) });
    await appearance(page, '暗色');
    await page.screenshot({ path: path.join(screenshots, companionEvidenceName('dossier-compact-dark.png')) });
    const overflow = await dossier.evaluate(node => node.scrollWidth - node.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    await dossier.getByRole('button', { name: '成长历程', exact: true }).click();
    await expect(dossier).toContainText('尚无正式发布');
    expect(await dossier.innerText()).not.toMatch(/好感\s*\d|愉悦\s*\d|信任\s*\d|尊重\s*\d/u);
  } finally {
    await application?.close();
    cleanup(root);
  }
});

test('shows the exact locally dispatched chat body and identity version, excluding paused goals and credentials', async ({ browserName }, testInfo) => {
  void browserName;
  test.setTimeout(180000); mkdirSync(screenshots, { recursive: true });
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-cognition-dossier-')), key = 'local-context-fixture-key-do-not-record', marker = '上下文验收：请先核对条件，再清楚回答。';
  const requests: Array<{ body: string; purpose?: string }> = [], diagnostics: string[] = [];
  const provider = createServer((request, response) => { let raw = ''; request.setEncoding('utf8'); request.on('data', chunk => { raw += chunk; }); request.on('end', () => {
    try {
      if (request.headers.authorization !== 'Bearer ' + key) throw new Error('Local fixture did not receive its configured credential.');
      const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }> }, input = body.messages?.findLast(message => message.role === 'user')?.content;
      let data: Record<string, unknown> = {}; if (typeof input === 'string') try { data = JSON.parse(input) as Record<string, unknown>; } catch { /* Native templates stay opaque. */ }
      const purpose = typeof data.purpose === 'string' ? data.purpose : undefined; requests.push({ body: raw, purpose }); if (requests.length > 128) throw new Error('Unexpected unbounded model requests in isolated fixture.');
      let content = JSON.stringify({ text: '我会先核对条件，再清楚回应这次问题。', memories: [] });
      if (purpose === 'companion_social_progress_review') content = JSON.stringify({ supported: true, correction: '' });
      else if (purpose === 'world_decision') content = JSON.stringify({ action: null, reason: '本次没有需要执行的新世界行动。' });
      else if (purpose === 'world_attention') content = JSON.stringify({ urgency: 'ordinary', confidence: .99, evidence: [], reason: '没有紧急打断请求。' });
      else if (purpose === 'world_social') content = JSON.stringify({ text: null, reason: '本次不扩展世界话题。' });
      else if (purpose === 'world_message_authorization') content = JSON.stringify({ allowed: false, confidence: .99, evidence: [], reason: '没有转发请求。' });
      else if (purpose === 'vcp_experience_journal' || purpose === 'vcp_sleep_reflection') content = JSON.stringify({ notes: [], dream: null });
      else if (purpose === 'companion_persona_integration') content = JSON.stringify({ decisions: [], noChangeReason: '没有新的有据人格变化。' });
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    } catch (cause) { diagnostics.push(cause instanceof Error ? cause.message : String(cause)); response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'Isolated fixture request failed.' })); }
  }); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Local provider failed to bind.');
  let application: ElectronApplication | undefined;
  let failed = false;
  let failureScope: { companionId: string; conversationId: string } | undefined;
  try {
    application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') }, { gpu: 'software' }) });
    await preparePackagedCompanionLaunch(application,path.join(root,'profile'));
    const build=await companionEvidenceEnvironment(application,path.join(root,'profile'));
    application.process().stderr?.on('data', chunk => { if (diagnostics.length < 200) diagnostics.push(String(chunk)); });
    const page = await application.firstWindow(), native = await application.browserWindow(page); await native.evaluate(window => { window.hide(); window.setSize(1600, 1080); window.webContents.setBackgroundThrottling(false); }); await ensureCompanionTestWorkspace(page);
    const request = async (command: CompanionsRequest) => { const result = await page.evaluate(command => (window as unknown as Bridge).worldlinebox.companions.request(command), command); expect(result.ok, result.error).toBe(true); return result; };
    const workspace = async (command: CompanionWorkspaceRequest) => { const result = await page.evaluate(command => (window as unknown as Bridge).worldlinebox.companions.workspace!(command), command); expect(result.ok, result.error).toBe(true); return result; };
    const configured = await page.evaluate(config => (window as unknown as Bridge).worldlinebox.llm.setConfig(config), { apiFormat: 'openai_chat' as const, baseUrl: `http://127.0.0.1:${address.port}`, model: 'local-context-fixture', apiKey: key }); expect(configured.ok).toBe(true);
    const owner = (await request({ type: 'companion.create', operationId: randomUUID(), companionId: randomUUID(), companion: { name: '澄澄', description: '上下文与培养方向验收伙伴', persona: '【表达】\n语气：先核对依据，再清楚回应。\n\n【价值】\n依据不足时保留未知。', avatar: 'custom', model: '', proactive: false } })).companion!;
    const room = (await request({ type: 'conversation.open', companionId: owner.id })).conversation!, initial = (await workspace({ type: 'companion.assets.read', companionId: owner.id })).companionAssets!;
    failureScope = { companionId: owner.id, conversationId: room.id };
    const goal = async (statement: string) => (await workspace({ type: 'growth.goals.propose', operationId: randomUUID(), companionId: owner.id, conversationId: room.id, feedback: '培养方向验收反馈：' + statement, goal: { statement, context: '资料不完整时', practice: ['先核对一个条件'], examples: ['我还需要确认'], counterexamples: ['没有依据就下结论'] } })).growthGoal!;
    const active = await goal('练习说明未知条件'), paused = await goal('暂停方向不应进入未来练习'), retired = await goal('结束方向不应继续要求培养');
    await workspace({ type: 'growth.goal.status', operationId: randomUUID(), companionId: owner.id, conversationId: room.id, goalId: paused.id, expectedRevision: paused.revision, status: 'paused', feedback: '暂时暂停这项方向。' });
    await workspace({ type: 'growth.goal.status', operationId: randomUUID(), companionId: owner.id, conversationId: room.id, goalId: retired.id, expectedRevision: retired.revision, status: 'retired', feedback: '明确结束这项未来培养。' });
    await request({ type: 'companion.set-active', id: owner.id, active: true });
    // Virtual routines are maintained through the same public unified agenda
    // as the UI. Pause the isolated owner's actual routine windows rather than
    // invoking the retired independent routine writer or overriding its body.
    const agenda = (await request({ type: 'agenda.read', companionId: owner.id, limit: 100 })).agenda!;
    expect(agenda.companionId).toBe(owner.id);
    for (const rule of agenda.rules.filter(rule => rule.executor === 'routine' && rule.status === 'active'))
      await request({ type: 'agenda.rule.control', companionId: owner.id, id: rule.id, expectedRevision: rule.revision, operationId: randomUUID(), action: 'pause' });
    await expect.poll(async () => (await request({ type: 'routine.get', companionId: owner.id, conversationId: room.id })).routine?.runtime.phase,
      { timeout: 30000 }).toBe('awake');
    const world = (await request({ type: 'world.snapshot' })).world!;
    const home = world.scenes.find(scene => scene.ownerId === owner.id)!, computer = home.objects.find(object => object.kind === 'computer')!; await request({ type: 'world.tool', companionId: owner.id, conversationId: room.id, arguments: { action: 'move', destinationId: computer.id } });
    await expect.poll(async () => { const actor = (await request({ type: 'world.snapshot' })).world!.actors.find(actor => actor.companionId === owner.id)!; return !actor.route.length && Math.hypot(actor.position.x - computer.anchor.x, actor.position.y - computer.anchor.y) < .01; }, { timeout: 30000 }).toBe(true);
    await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click(); await page.locator(`[data-companion-contact="${owner.id}"]`).click(); await page.locator('.companions-profile-actions').getByRole('button', { name: '发消息', exact: true }).click();
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(marker); await page.getByRole('textbox', { name: '输入消息', exact: true }).press('Enter');
    let actual: CompanionContextSnapshot | undefined;
    await expect.poll(async () => {
      const items = (await workspace({ type: 'cognition.context.list', companionId: owner.id, limit: 40 })).contextSnapshots ?? [];
      for (const item of items.filter(item => item.purpose === 'companion_reply' && item.status === 'response')) { const snapshot = (await workspace({ type: 'cognition.context.read', companionId: owner.id, id: item.id })).contextSnapshot!; if (snapshot.providerBody.includes(marker)) { actual = snapshot; return true; } }
      return false;
    }, { timeout: 60000, intervals: [500] }).toBe(true);
    const snapshot = actual!; expect(requests.some(request => request.body === snapshot.providerBody)).toBe(true); expect(snapshot.frame.profileRevision).toBe(initial.profileRevision); expect(snapshot.frame.identity).toBe(initial.profile!.persona); const protocolBody = JSON.parse(snapshot.providerBody) as { messages: Array<{ role: string; content: unknown }> }; expect(protocolBody.messages.some(message => typeof message.content === 'string' && message.content.includes(initial.profile!.persona))).toBe(true); expect(JSON.stringify(snapshot)).not.toContain(key);
    const input = JSON.parse(snapshot.frame.input) as { cultivationGoals?: { items: Array<{ id: string }> } }; expect(input.cultivationGoals?.items.map(goal => goal.id)).toEqual([active.id]); expect((await workspace({ type: 'companion.assets.read', companionId: owner.id })).companionAssets!.profile!.persona).toBe(initial.profile!.persona);
    await page.getByRole('button', { name: '联系人', exact: true }).click(); await page.locator(`[data-companion-contact="${owner.id}"]`).click(); const dossier = page.getByRole('region', { name: '伙伴认知档案', exact: true }); await dossier.getByRole('tab', { name: '运行核对', exact: true }).click(); await dossier.getByRole('button', { name: '本次实际上下文', exact: true }).click(); await dossier.locator(`[data-context-snapshot="${snapshot.id}"] button`).click();
    const record = dossier.getByRole('article', { name: '选中的实际请求正文', exact: true }); await expect(record).toContainText(snapshot.frame.profileRevision); await expect(record.locator('textarea,[contenteditable="true"]')).toHaveCount(0); expect(await record.innerText()).not.toContain(key);
    await record.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(screenshots, companionEvidenceName('actual-context-overview-light.png')) });
    const identity = record.locator('details').filter({ hasText: '本次身份正文' }).first(); await identity.locator('summary').click(); await expect(identity.locator('pre')).toHaveText(snapshot.frame.identity);
    const protocol = record.locator('details[open]').last(); let rendered = ''; for (let index = 0; index < 20; index++) { rendered += await protocol.locator('pre').innerText(); const next = protocol.getByRole('button', { name: '下一部分', exact: true }); if (!await next.count() || !await next.isEnabled()) break; await next.click(); }
    expect(rendered).toBe(snapshot.providerBody); await protocol.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(screenshots, companionEvidenceName('actual-context-sent-light.png')) });
    const proof = { environment: 'isolated Electron app and local HTTP fixture; no external model', build,companionId: owner.id, conversationId: room.id, snapshotId: snapshot.id, providerBody: snapshot.providerBody, frame: snapshot.frame, exactProviderBody: true, credentialsExcluded: true, activeGoalId: active.id, excludedGoalIds: [paused.id, retired.id], unchangedPublishedPersona: true };
    writeFileSync(path.join(screenshots, companionEvidenceName('actual-context-transport-proof.json')), JSON.stringify(proof, null, 2)); await testInfo.attach('actual-provider-context-proof', { body: JSON.stringify(proof), contentType: 'application/json' });
    await dossier.getByRole('tab', { name: '学习成长', exact: true }).click(); await dossier.getByRole('button', { name: '正在成长', exact: true }).click(); const pausedRow = dossier.locator(`[data-growth-goal="${paused.id}"]`); await expect(pausedRow).toContainText('已暂停'); await expect(dossier.locator(`[data-growth-goal="${retired.id}"]`)).toContainText('已结束'); await expect(dossier.locator(`[data-growth-goal="${active.id}"]`)).toContainText(active.statement);
    await expect(dossier.locator('form')).toHaveCount(0); expect(await dossier.locator('.cognition-goals').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(2); await dossier.locator('.cognition-group-tabs').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(screenshots, companionEvidenceName('growth-directions-overview-light.png')) });
    await pausedRow.getByRole('button', { name: '调整方向', exact: true }).click(); await expect(dossier.getByRole('form', { name: '培养方向反馈', exact: true })).toContainText('调整定义不会自动恢复练习'); await page.screenshot({ path: path.join(screenshots, companionEvidenceName('growth-directions-management-light.png')) });
    await dossier.getByRole('button', { name: '取消本次调整', exact: true }).click(); await native.evaluate(window => window.setSize(1120, 900)); await appearance(page, '暗色'); await dossier.locator('.cognition-group-tabs').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(screenshots, companionEvidenceName('growth-directions-compact-dark.png')) }); expect(await dossier.locator('.cognition-goals').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(1); expect(await dossier.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(2);
  } catch (cause) {
    failed = true;
    const page = application?.windows()[0];
    await page?.screenshot({ path: path.join(screenshots, companionEvidenceName('actual-context-failure.png')) }).catch(() => undefined);
    const observations = page && failureScope ? await page.evaluate(async scope => {
      const api = (window as unknown as Bridge).worldlinebox;
      const commands: CompanionsRequest[] = [
        { type: 'state.progress' }, { type: 'state' },
        { type: 'messages', conversationId: scope.conversationId, limit: 30 },
        { type: 'actions', conversationId: scope.conversationId },
        { type: 'tasks.list', companionId: scope.companionId, view: 'all', limit: 50 },
        { type: 'agenda.read', companionId: scope.companionId, limit: 100 },
        { type: 'routine.get', ...scope },
      ];
      const responses = [];
      for (const command of commands) {
        try { responses.push({ type: command.type, response: await api.companions.request(command) }); }
        catch (error) { responses.push({ type: command.type, error: String(error) }); }
      }
      return { responses, config: await api.llm.getConfig() };
    }, failureScope).catch(error => ({ error: String(error) })) : undefined;
    const report = { retainedTemporaryRoot: root, requests: requests.map(request => ({ purpose: request.purpose ?? 'chat', containsMarker: request.body.includes(marker), body: request.body })), diagnostics, observations };
    const serialized = JSON.stringify(report, null, 2);
    expect(serialized).not.toContain(key);
    writeFileSync(path.join(screenshots, companionEvidenceName('actual-context-local-diagnostics.txt')), serialized);
    await testInfo.attach('actual-context-failure-diagnostics', { body: serialized, contentType: 'application/json' });
    throw cause;
  }
  finally { await application?.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); if (!failed) cleanup(root); }
});
