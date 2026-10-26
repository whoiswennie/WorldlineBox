import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import type { CompanionPublicProfile } from '../../src/shared/companion-public-profile';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import { companionMemoryPolicyFileSchema } from '../../src/shared/companion-memory-policy';
import { companionModelResourcePolicySchema } from '../../src/shared/companion-model-resources';
import { removeCompanionTestDirectory, ensureCompanionTestWorkspace, electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi } };
type ImageProof = { personId: string; role: string; sha256: string; mime: string; width: number; height: number; bytes: number; detail: string };
type Capture = { context: { publicProfiles: CompanionPublicProfile[]; identity: { currentReply: { speaker: { id: string; name: string } } }; visionManifest: Array<{ personId: string; role: string; delivery: string }> }; images: ImageProof[] };
async function request(page: Page, input: CompanionsRequest) { const result = await page.evaluate(value => (window as unknown as Bridge).worldlinebox.companions.request(value), input); expect(result.ok, result.error).toBe(true); return result; }
function cleanup(root: string) { const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-profile-e2e-')) throw new Error('Unexpected profile fixture cleanup path.'); removeCompanionTestDirectory(resolved); }
function compiledProfileFixtureHashes() {
  const directory = path.join(resolveElectronAppPath(), '.vite'), hashes: Record<string, string> = {};
  const visit = (parent: string) => { for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const file = path.join(parent, entry.name); if (entry.isDirectory()) visit(file);
    else if (/\.(?:js|cjs|css|html)$/u.test(entry.name)) hashes[path.relative(directory, file).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(file)).digest('hex');
  } }; visit(directory); return hashes;
}
async function launch(profile: string) {
  const packaged = process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE;
  const application = await electron.launch({ executablePath: packaged ?? resolveElectronExecutablePath(), args: packaged ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'software' }) });
  const page = await application.firstWindow(), native = await application.browserWindow(page);
  await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 1000); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.hide(); });
  await ensureCompanionTestWorkspace(page);
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page'); return { application, page };
}
async function choose(application: ElectronApplication, filename?: string) { await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: !file, filePaths: file ? [file] : [] }); }, filename); }

test('all built-in contacts show their complete default orthographic reference', async () => {
  test.setTimeout(90000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-profile-e2e-')); const { application, page } = await launch(path.join(root, 'profile'));
  try {
    await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click();
    for (const companion of BUILTIN_COMPANIONS) {
      await page.locator(`[data-companion-contact="${companion.id}"]`).click();
      const image = page.locator('.companions-contact-profile .public-appearance-thumbnail img');
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > node.naturalHeight)).toBe(true);
      await expect(page.locator('.companions-contact-profile')).not.toContainText('还没有添加三视图');
    }
    await page.locator('[data-companion-contact="huan-black"]').click();
    await page.screenshot({ path: path.resolve('.tools/test-output/verified-builtin-orthographic-contact.png') });
  } finally { await application.close(); cleanup(root); }
});
async function openSettings(page: Page) { await page.getByRole('button', { name: '设置', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '通用设置', exact: true }); await expect(dialog.getByRole('tab', { name: '用户信息', exact: true })).toHaveAttribute('aria-selected', 'true'); return dialog; }
async function awake(page: Page, companionId: string, conversationId: string) {
  await request(page, { type: 'companion.set-active', id: companionId, active: true });
  const world = (await request(page, { type: 'world.snapshot' })).world!; await request(page, { type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime' } });
  const routine = (await request(page, { type: 'routine.get', companionId, conversationId })).routine!, clock = (delta: number) => String((Math.floor(world.clock.hour) + delta + 24) % 24).padStart(2, '0') + ':00';
  await request(page, { type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision, patch: { timeZone: world.settings.timeZone, wakeAt: clock(-8), sleepAt: clock(8), meals: [], habits: [] } });
}

test('uses editable owner image files in saved contacts and preserves missing-image empty states across restart', async ({ browserName: _browserName }, testInfo) => {
  void _browserName;
  test.setTimeout(120000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-profile-e2e-')), profile = path.join(root, 'profile'), owner = 'deepseek-sister';
  const compiledHashes = compiledProfileFixtureHashes(), artifact = path.resolve('.tools/test-output/companions'); mkdirSync(artifact, { recursive: true });
  let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile); application = started.application; let page = started.page;
    const selectContact = async () => { await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click(); await page.locator(`[data-companion-contact="${owner}"]`).click(); };
    await selectContact();
    const status = await page.evaluate(() => (window as unknown as Bridge).worldlinebox.companions.workspace!({ type: 'status' }));
    const relative = path.relative(root, status.selected!.memoryRoot);
    expect(path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)).toBe(false);
    const images = path.join(status.selected!.memoryRoot, owner, '形象'), avatarFile = path.join(images, 'avatar.png'), boardFile = path.join(images, 'orthographic.png');
    const avatar = () => page.locator('.companions-profile-heading .companion-avatar > img'), board = () => page.locator('.companions-contact-profile .public-appearance-thumbnail img');
    await expect(avatar()).toHaveAttribute('src', new RegExp(`^worldlinebox-companion://portrait/${owner}/avatar\\?v=`));
    await expect(board()).toHaveAttribute('src', new RegExp(`^worldlinebox-companion://portrait/${owner}/orthographic\\?v=`));
    await expect.poll(() => avatar().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const firstURL = (await avatar().getAttribute('src'))!;
    // WebGL's TextureLoader uses anonymous CORS; ordinary <img> success alone
    // cannot establish this separate renderer integration boundary.
    const cors = await page.evaluate(async url => { const document = { origin: location.origin, documentURL: location.href, referrer: globalThis.document.referrer };
      try { const response = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout(5000) }); return { ...document, ok: response.ok, status: response.status, bytes: (await response.arrayBuffer()).byteLength }; }
      catch (error) { return { ...document, ok: false, error: error instanceof Error ? error.message : String(error) }; } }, firstURL);
    const avatarBytes = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#3878c7' } }).png().toBuffer();
    const boardBytes = await sharp({ create: { width: 960, height: 320, channels: 4, background: '#75ad8e' } }).png().toBuffer();
    writeFileSync(avatarFile, avatarBytes); writeFileSync(boardFile, boardBytes);
    const avatarHash = createHash('sha256').update(avatarBytes).digest('hex'), boardHash = createHash('sha256').update(boardBytes).digest('hex');
    // No state request, navigation or manual refresh drives this update.
    await expect(avatar()).toHaveAttribute('src', new RegExp(`\\?v=${avatarHash}&r=`), { timeout: 20000 });
    await expect(board()).toHaveAttribute('src', new RegExp(`\\?v=${boardHash}&r=`), { timeout: 20000 });
    await expect.poll(() => avatar().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(64);
    await expect.poll(() => board().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(960);
    const editedScreenshot = path.join(artifact, 'verified-owner-image-file-edit.png'); await page.screenshot({ path: editedScreenshot });
    rmSync(images, { recursive: true });
    await expect(avatar()).toHaveCount(0, { timeout: 20000 }); await expect(board()).toHaveCount(0, { timeout: 20000 });
    await expect(page.locator('.companions-profile-heading .companion-avatar-letter')).toHaveText('大');
    await expect(page.locator('.companions-contact-profile .public-appearance-empty')).toContainText('还没有添加三视图'); expect(existsSync(images)).toBe(false);
    await application.close(); application = undefined;
    started = await launch(profile); application = started.application; page = started.page; await selectContact();
    await expect(avatar()).toHaveCount(0); await expect(board()).toHaveCount(0); expect(existsSync(images)).toBe(false);
    const missingScreenshot = path.join(artifact, 'verified-owner-image-missing-after-restart.png'); await page.screenshot({ path: missingScreenshot });
    const report = { actualElectron: true, realOwnerFiles: true, originalURL: firstURL, avatarHash, boardHash,
      externalChangesUpdatedUIWithoutManualRefresh: true, deletedDirectoryNotReseededAfterRestart: true, rendererAnonymousCORS: cors,
      screenshots: { edited: editedScreenshot, missing: missingScreenshot }, compiledHashes };
    writeFileSync(path.join(artifact, 'verified-owner-image-file-authority.json'), JSON.stringify(report, null, 2));
    await testInfo.attach('owner-image-file-authority', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    expect(compiledProfileFixtureHashes()).toEqual(compiledHashes); expect(cors.ok, JSON.stringify(cors)).toBe(true);
  } finally { await application?.close().catch(() => undefined); cleanup(root); }
});

test('keeps owner profile and prompt files authoritative through UI saves, external edits and real provider requests', async ({ browserName: _browserName }, testInfo) => {
  void _browserName;
  test.setTimeout(240000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-profile-e2e-')), captures: string[] = [], failures: string[] = [];
  const compiledHashes = compiledProfileFixtureHashes();
  let application: ElectronApplication | undefined;
  const server = createServer((incoming, outgoing) => {
    let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { raw += chunk; }); incoming.on('end', () => {
      try {
        const payload = JSON.parse(raw), base = payload.messages?.[1]?.content;
        if (payload.messages?.length === 1 && payload.messages[0]?.content === 'Reply with the single word OK.') {
          outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); return;
        }
        const context = typeof base === 'string' ? JSON.parse(base) : {};
        let result: unknown;
        if (context.purpose === 'companion_social_progress_review') result = { supported: true, correction: '' };
        else if (context.purpose === 'vcp_experience_journal') result = { notes: [] };
        else if (context.purpose === 'vcp_sleep_reflection') result = { notes: [], dream: null };
        else if (context.purpose === 'vcp_sleep_memory_maintenance') result = { decision: 'defer', reason: '本轮保留原始资料。', consolidations: [] };
        else if (context.purpose === 'world_decision') result = { action: null, reason: '保持当前生活状态。', appraisals: [] };
        else if (context.purpose === 'world_attention') result = { urgency: 'ordinary', confidence: .99, evidence: [context.source.content], reason: '普通交流。' };
        else if (context.purpose === 'vcp_memory_prohibition_check') result = { allowed: true, matchedPolicyIds: [] };
        else if (context.purpose) result = { text: null, reason: '没有其他任务需要处理。' };
        else { captures.push(JSON.stringify(payload.messages)); result = '文件设定验证完成。'; }
        outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ choices: [{ message: { content: typeof result === 'string' ? result : JSON.stringify(result) }, finish_reason: 'stop' }] }));
      } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); outgoing.writeHead(400); outgoing.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const started = await launch(path.join(root, 'profile')); application = started.application; const page = started.page;
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing isolated provider.');
    await page.evaluate(baseUrl => (window as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', baseUrl, model: 'gpt-4o', apiKey: 'fixture-asset-file-key' }), 'http://127.0.0.1:' + address.port);
    const location = await page.evaluate(() => (window as unknown as Bridge).worldlinebox.companions.workspace!({ type: 'status' }));
    const memoryRoot = location.selected!.memoryRoot, dataRoot = location.selected!.dataRoot;
    for (const directory of [memoryRoot, dataRoot]) { const relative = path.relative(root, directory);
      expect(path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)).toBe(false); }
    const owner = 'deepseek-sister', conversationId = 'private-' + owner, profileFile = path.join(memoryRoot, owner, 'profile.md');
    const savedPersona = 'PERSONA_UI_FILE_AUTHORITY：我是保持独立判断、喜欢核验资料的伙伴。';
    const filePersona = 'PERSONA_EXTERNAL_FILE_AUTHORITY：我当前的人格必须从此文件实时读取。';
    const promptSaved = 'PROMPT_UI_FILE_AUTHORITY：根据本伙伴当前文件中的交流指导，保持自然与简洁。';
    const promptExternal = 'PROMPT_EXTERNAL_FILE_AUTHORITY：现在的交流指导来自后续直接文件编辑。';
    await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click();
    await page.locator(`[data-companion-contact="${owner}"]`).click(); await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    let editor = page.getByRole('dialog', { name: '编辑伙伴资料', exact: true });
    await editor.getByRole('textbox', { name: '人设', exact: true }).fill(savedPersona);
    await editor.getByRole('checkbox', { name: '允许空闲时主动联系我和其他伙伴' }).uncheck();
    await editor.getByRole('button', { name: '保存资料', exact: true }).click(); await expect(editor).toHaveCount(0);
    expect(readFileSync(profileFile, 'utf8')).toContain(savedPersona);
    await page.getByRole('button', { name: '编辑资料', exact: true }).click(); editor = page.getByRole('dialog', { name: '编辑伙伴资料', exact: true });
    await editor.getByRole('textbox', { name: '人设', exact: true }).fill('UNSAVED_CONFLICT_DRAFT：不能覆盖外部文件。');
    writeFileSync(profileFile, readFileSync(profileFile, 'utf8').replace(savedPersona, filePersona), 'utf8');
    await editor.getByRole('button', { name: '保存资料', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText(/修改|变化|重新读取/u);
    await expect(editor.getByRole('textbox', { name: '人设', exact: true })).toHaveValue('UNSAVED_CONFLICT_DRAFT：不能覆盖外部文件。');
    expect(readFileSync(profileFile, 'utf8')).toContain(filePersona);
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '发消息', exact: true }).click(); await awake(page, owner, conversationId);
    const send = async (text: string, count: number) => {
      await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(text); await page.getByRole('button', { name: '发送', exact: true }).click();
      await expect.poll(() => captures.length, { timeout: 35000 }).toBe(count);
      await expect.poll(async () => (await request(page, { type: 'messages', conversationId, limit: 50 })).messages?.filter(message => message.authorId === owner
        && !message.isReplyDraft && message.content.includes('文件设定验证完成')).length ?? 0, { timeout: 20000 }).toBe(count);
    };
    await send('ASSET_FILE_FIRST：按当前设定自然回应。', 1); expect(captures[0]).toContain(filePersona); expect(captures[0]).not.toContain(savedPersona);
    await page.getByRole('button', { name: '联系人', exact: true }).click(); await page.locator(`[data-companion-contact="${owner}"]`).click();
    await page.getByText('本伙伴的提示词与记忆策略文件', { exact: true }).click();
    await page.getByRole('combobox', { name: '提示词文件', exact: true }).selectOption('提示词/对话.md');
    await page.getByRole('textbox', { name: '提示词正文', exact: true }).fill(promptSaved);
    await page.getByRole('button', { name: '保存到伙伴文件', exact: true }).click();
    await expect(page.locator('.companion-prompt-assets [role="status"]')).toContainText('已保存到此伙伴');
    const promptFile = path.join(memoryRoot, owner, '提示词', '对话.md'); expect(readFileSync(promptFile, 'utf8')).toBe(promptSaved);
    await page.getByRole('button', { name: '发消息', exact: true }).click(); await send('ASSET_FILE_SECOND：继续正常交流。', 2);
    expect(captures[1]).toContain(filePersona); expect(captures[1]).toContain(promptSaved);
    writeFileSync(promptFile, promptExternal, 'utf8'); await send('ASSET_FILE_THIRD：再按照最新指导回应。', 3);
    expect(captures[2]).toContain(promptExternal); expect(captures[2]).not.toContain(promptSaved); expect(failures).toEqual([]);
    const artifact = path.resolve('.tools/test-output/companions'); mkdirSync(artifact, { recursive: true });
    const openOwnerFiles = async () => {
      await page.getByRole('button', { name: '联系人', exact: true }).click(); await page.locator(`[data-companion-contact="${owner}"]`).click();
      const section = page.locator('.companion-prompt-assets').filter({ has: page.getByText('本伙伴的提示词与记忆策略文件', { exact: true }) });
      if (!await section.locator('details').evaluate((details: HTMLDetailsElement) => details.open))
        await section.getByText('本伙伴的提示词与记忆策略文件', { exact: true }).click();
      return section;
    };
    let ownerFiles = await openOwnerFiles();
    await ownerFiles.getByRole('combobox', { name: '提示词文件', exact: true }).selectOption('记忆策略.json');
    const policyField = ownerFiles.getByRole('textbox', { name: '提示词正文', exact: true });
    const policy = companionMemoryPolicyFileSchema.parse(JSON.parse(await policyField.inputValue()));
    policy.policy.mode = 'quiet'; policy.policy.capture.quietMs = 90_000; policy.policy.capture.maxWaitMs = 180_000; policy.policy.capture.batchSize = 6;
    const policyContent = JSON.stringify(policy, null, 2), policyFile = path.join(memoryRoot, owner, '记忆策略.json');
    await policyField.fill(policyContent); await ownerFiles.getByRole('button', { name: '保存到伙伴文件', exact: true }).click();
    await expect(ownerFiles.getByRole('status')).toContainText('已保存到此伙伴'); expect(JSON.parse(readFileSync(policyFile, 'utf8'))).toEqual(policy);
    const brokenPolicy = '{BROKEN_POLICY_JSON_UI_REPAIR'; writeFileSync(policyFile, brokenPolicy, 'utf8');
    await ownerFiles.getByRole('button', { name: '重读文件', exact: true }).click();
    await expect(ownerFiles.getByRole('alert').first()).toContainText('记忆策略JSON或约束无效');
    const replacePolicyDraft = ownerFiles.getByRole('button', { name: '使用最新文件替换草稿', exact: true });
    if (await replacePolicyDraft.isVisible()) await replacePolicyDraft.click();
    await expect(policyField).toHaveValue(brokenPolicy);
    await page.getByRole('button', { name: '发消息', exact: true }).click(); await send('ASSET_FILE_BAD_POLICY：日常交流仍应正常。', 4);
    expect(captures[3]).toContain(filePersona); expect(captures[3]).toContain(promptExternal); expect(captures[3]).not.toContain('BROKEN_POLICY_JSON_UI_REPAIR');
    ownerFiles = await openOwnerFiles();
    await ownerFiles.getByRole('combobox', { name: '提示词文件', exact: true }).selectOption('记忆策略.json');
    await ownerFiles.getByRole('textbox', { name: '提示词正文', exact: true }).fill(policyContent);
    await ownerFiles.getByRole('button', { name: '保存到伙伴文件', exact: true }).click();
    await expect(ownerFiles.getByRole('status')).toContainText('已保存到此伙伴'); await expect(ownerFiles.getByRole('alert')).toHaveCount(0);
    expect(JSON.parse(readFileSync(policyFile, 'utf8'))).toEqual(policy);
    await ownerFiles.scrollIntoViewIfNeeded(); const policyScreenshot = path.join(artifact, 'verified-owner-memory-policy-ui.png');
    await page.screenshot({ path: policyScreenshot });

    await page.getByRole('button', { name: '打开伙伴记忆库', exact: true }).click();
    const memoryLibrary = page.getByRole('region', { name: '伙伴记忆库', exact: true });
    await memoryLibrary.getByRole('combobox', { name: '记忆所属伙伴', exact: true }).selectOption(owner);
    await memoryLibrary.getByRole('button', { name: '查看记忆处理进度', exact: true }).click();
    const processing = page.getByRole('region', { name: '记忆处理进度', exact: true }), budget = processing.locator('.companion-model-resources');
    await expect(processing).toBeVisible(); await expect(budget.getByRole('textbox', { name: '资源预算文件内容', exact: true })).toHaveCount(0);
    await budget.getByText('模型资源与预算', { exact: true }).click();
    const budgetField = budget.getByRole('textbox', { name: '资源预算文件内容', exact: true }); await expect(budgetField).toBeVisible();
    const budgetPolicy = companionModelResourcePolicySchema.parse(JSON.parse(await budgetField.inputValue()));
    budgetPolicy.defaultConnection.concurrency = 2; budgetPolicy.defaultConnection.requestsPerMinute = 240;
    const sharedBudgetFile = path.join(dataRoot, '模型资源预算.json'), budgetContent = JSON.stringify(budgetPolicy, null, 2);
    await budgetField.fill(budgetContent); await budget.getByRole('button', { name: '保存预算文件', exact: true }).click();
    await expect(budget.getByRole('status')).toContainText('已写入 模型资源预算.json'); expect(JSON.parse(readFileSync(sharedBudgetFile, 'utf8'))).toEqual(budgetPolicy);
    const unsavedBudget = { ...budgetPolicy, defaultConnection: { ...budgetPolicy.defaultConnection, requestsPerMinute: 241 } };
    const externalBudget = { ...budgetPolicy, defaultConnection: { ...budgetPolicy.defaultConnection, requestsPerMinute: 242 } };
    const unsavedBudgetContent = JSON.stringify(unsavedBudget, null, 2), externalBudgetContent = JSON.stringify(externalBudget, null, 2);
    await budgetField.fill(unsavedBudgetContent); writeFileSync(sharedBudgetFile, externalBudgetContent, 'utf8');
    await budget.getByRole('button', { name: '保存预算文件', exact: true }).click();
    await expect(budget.getByRole('alert')).toContainText('外部修改'); await expect(budgetField).toHaveValue(unsavedBudgetContent);
    expect(readFileSync(sharedBudgetFile, 'utf8')).toBe(externalBudgetContent);
    await budget.scrollIntoViewIfNeeded(); const budgetScreenshot = path.join(artifact, 'verified-model-resource-budget-ui.png');
    await page.screenshot({ path: budgetScreenshot });
    await budget.getByRole('button', { name: '重读预算与统计', exact: true }).click(); await expect(budgetField).toHaveValue(unsavedBudgetContent);
    await budget.getByRole('button', { name: '用最新文件替换草稿', exact: true }).click(); await expect(budgetField).toHaveValue(externalBudgetContent);
    await expect(budget.getByLabel('当前伙伴当日模型请求统计')).toBeVisible(); expect(failures).toEqual([]);
    const evidence = { actualElectron: true, isolatedLibrary: true, providerBoundary: 'Local deterministic provider; real UI, file authority, CAS and app scheduling.',
      softwarePersonaSavedToOwnerFile: true, externalPersonaWonCAS: true, conflictDraftPreserved: true, promptUISavedToOwnerFile: true,
      externalProfileUsedInNextProviderRequest: true, externalPromptUsedInNextProviderRequest: true, providerRequests: captures.length,
      policyUISavedToRealOwnerJSON: true, brokenPolicyReadAndRepairedInUI: true, ordinaryReplyWithBrokenPolicy: true,
      sharedResourceBudgetUISavedToRealJSON: true, budgetConflictPreservedDraftAndExternalFile: true,
      screenshots: { policy: policyScreenshot, budget: budgetScreenshot }, compiledHashes,
      compiledBoundary: 'API/UI baseline before the final projection-delta search integration; dynamic native host is not exercised by this deterministic UI case.' };
    expect(compiledProfileFixtureHashes()).toEqual(compiledHashes);
    await testInfo.attach('owner-asset-file-authority', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    writeFileSync(path.join(artifact, 'verified-owner-asset-file-authority.json'), JSON.stringify(evidence, null, 2));
  } finally { await application?.close().catch(() => undefined); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); cleanup(root); }
});

// Only the OS chooser is replaced. Main still copies/validates real files,
// persists references, serves them through its protocol and sends actual JPEG pixels.
// eslint-disable-next-line no-empty-pattern
test('persists public player and companion references, displays the real user identity and sends current labelled image pixels', async ({}, testInfo) => {
  test.setTimeout(180000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-profile-e2e-')), profilePath = path.join(root, 'profile'), uploads = path.join(root, 'uploads'); mkdirSync(uploads);
  const avatarFile = path.join(uploads, 'avatar.png'), boardFile = path.join(uploads, 'orthographic.png');
  const board = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="480"><rect width="960" height="480" fill="#f4f2eb"/><text x="30" y="40" font-family="Arial" font-size="18" fill="#49656c">PUBLIC CHARACTER REFERENCE</text>${['FRONT', 'SIDE', 'BACK'].map((label, i) => `<g transform="translate(${160 + i * 320},135)"><circle cy="0" r="35" fill="#e8c9b1"/><path d="M-33 50Q0 25 33 50L45 180H-45Z" fill="${i === 1 ? '#7d9da3' : '#95b4b6'}"/><path d="M-25 180V250M25 180V250" stroke="#50656c" stroke-width="22"/><text y="300" text-anchor="middle" font-family="Arial" font-size="17" fill="#49656c">${label}</text></g>`).join('')}</svg>`;
  await sharp(Buffer.from(board)).png().toFile(boardFile);
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" rx="90" fill="#8faeb3"/><circle cx="90" cy="66" r="31" fill="#f2e8da"/><path d="M35 155Q42 100 90 100Q138 100 145 155" fill="#f2e8da"/></svg>')).png().toFile(avatarFile);
  const socialReviews: string[] = [];
  const captures: Capture[] = [], providerErrors: string[] = [], auxiliaryPurposes: string[] = []; let application: ElectronApplication | undefined;
  const server = createServer((incoming, outgoing) => { let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { raw += chunk; }); incoming.on('end', () => { void (async () => {
    try {
      const payload = JSON.parse(raw);
      if (payload.messages?.length === 1 && payload.messages[0]?.role === 'user' && payload.messages[0]?.content === 'Reply with the single word OK.') { auxiliaryPurposes.push('connection_probe'); outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })); return; }
      const context = JSON.parse(payload.messages[1]?.content ?? payload.messages[0]?.content); let output: unknown;
      if (payload.messages.length === 1) { if (typeof context.purpose !== 'string') throw new Error('A primary reply must retain the base JSON in messages[1].'); auxiliaryPurposes.push(context.purpose); }
      if (context.purpose === 'companion_social_progress_review') {
        expect(typeof context.proposedText).toBe('string'); socialReviews.push(context.proposedText);
        output = { supported: true, correction: '' };
      } else if (context.purpose === 'world_decision') output = { action: null, reason: '保持当前生活安排。', appraisals: [] };
      else if (context.purpose === 'world_attention') output = { urgency: 'ordinary', confidence: .99, evidence: [context.source.content], reason: '正常交流。' };
      else if (context.purpose === 'vcp_memory_prohibition_check') output = { allowed: true, matchedPolicyIds: [] };
      else if (context.purpose === 'vcp_sleep_reflection') output = { notes: [], dream: null };
      else if (context.purpose === 'vcp_experience_journal') output = { notes: [] };
      else {
        const images: ImageProof[] = [];
        for (const message of payload.messages.filter((message: { role: string; content: unknown }) => message.role === 'user' && Array.isArray(message.content))) {
          let label: { personId: string; role: string; sha256: string } | undefined;
          for (const part of message.content) {
            if (part.type === 'text') label = JSON.parse(part.text).publicImage;
            if (part.type === 'image_url') { if (!label) throw new Error('Image has no identity label.'); const match = part.image_url.url.match(/^data:(image\/jpeg);base64,(.+)$/); if (!match) throw new Error('Expected actual JPEG data.'); const bytes = Buffer.from(match[2], 'base64'), metadata = await sharp(bytes).metadata(); const hash = createHash('sha256').update(bytes).digest('hex'); if (hash !== label.sha256) throw new Error('Image label checksum mismatch.'); images.push({ ...label, sha256: hash, mime: match[1], width: metadata.width!, height: metadata.height!, bytes: bytes.length, detail: part.image_url.detail }); label = undefined; }
          }
        }
        captures.push({ context, images }); output = '公开资料已经提供，我们接着聊吧。';
      }
      outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ choices: [{ message: { content: typeof output === 'string' ? output : JSON.stringify(output) }, finish_reason: 'stop' }] }));
    } catch (cause) { providerErrors.push(cause instanceof Error ? cause.message + ' ' + cause.stack?.split('\n')[1]?.trim() : 'Provider fixture failed.'); outgoing.writeHead(400); outgoing.end(); }
  })(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    let started = await launch(profilePath); application = started.application; let page = started.page;
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local provider.');
    await page.evaluate(baseUrl => (window as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', baseUrl, model: 'gpt-4o', apiKey: 'fixture-public-profile-key' }), 'http://127.0.0.1:' + address.port);
    await request(page, { type: 'player.profile.get' });
    let settings = await openSettings(page); expect(await settings.locator('.app-settings-nav-list [role="tab"]').first().textContent()).toBe('用户信息');
    const form = settings.getByRole('form', { name: '用户信息', exact: true });
    await form.getByRole('textbox', { name: '姓名', exact: true }).fill('林澈'); await form.getByRole('textbox', { name: '公开自述', exact: true }).fill('喜欢看海、画画和安静的音乐。');
    await choose(application, avatarFile); await form.getByRole('button', { name: '选择头像', exact: true }).click();
    await page.getByRole('dialog', { name: '调整头像', exact: true }).getByRole('button', { name: '使用此头像', exact: true }).click(); await expect(page.getByRole('dialog', { name: '调整头像', exact: true })).toHaveCount(0);
    await choose(application, boardFile); await form.getByRole('button', { name: '上传三视图', exact: true }).click();
    await expect.poll(() => form.locator('.public-appearance-thumbnail img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(960);
    const selectedBoard = await form.locator('.public-appearance-thumbnail img').getAttribute('src'); await choose(application); await form.getByRole('button', { name: '更换三视图', exact: true }).click(); expect(await form.locator('.public-appearance-thumbnail img').getAttribute('src')).toBe(selectedBoard);
    expect((await request(page, { type: 'player.profile.get' })).playerProfile!.name).toBe('我');
    await form.getByRole('button', { name: '保存用户信息', exact: true }).click(); await expect(form).toContainText('用户信息已保存');
    const saved = (await request(page, { type: 'player.profile.get' })).playerProfile!; expect(saved).toMatchObject({ id: 'user', name: '林澈', description: '喜欢看海、画画和安静的音乐。' }); expect(saved.avatarAttachmentId).toBeTruthy(); expect(saved.appearanceAttachmentId).toBeTruthy();
    await form.getByRole('button', { name: '预览公开三视图', exact: true }).click(); await expect(page.getByRole('dialog', { name: '预览公开三视图', exact: true }).locator('img')).toBeVisible(); await page.keyboard.press('Escape'); await expect(settings).toBeVisible(); await expect(form.getByRole('button', { name: '预览公开三视图', exact: true })).toBeFocused();
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true });
    await settings.getByRole('tab', { name: '外观', exact: true }).click(); await settings.getByRole('radio', { name: 'WorldlineBox', exact: true }).click(); await settings.getByRole('radio', { name: '亮色', exact: true }).click(); await settings.getByRole('tab', { name: '用户信息', exact: true }).click(); await settings.locator('.app-settings-content').evaluate(element => { element.scrollTop = 0; }); await page.screenshot({ path: path.join(artifacts, 'verified-player-profile-light.png') });
    await form.getByRole('button', { name: '预览公开三视图', exact: true }).click(); await expect(page.getByRole('dialog', { name: '预览公开三视图', exact: true }).locator('img')).toBeVisible(); await page.screenshot({ path: path.join(artifacts, 'verified-player-orthographic-preview.png') }); await page.keyboard.press('Escape');
    await settings.getByRole('tab', { name: '外观', exact: true }).click(); await settings.getByRole('radio', { name: '暗色', exact: true }).click(); await settings.getByRole('tab', { name: '用户信息', exact: true }).click(); await settings.locator('.app-settings-content').evaluate(element => { element.scrollTop = 0; }); await page.screenshot({ path: path.join(artifacts, 'verified-player-profile-dark.png') }); await page.keyboard.press('Escape');
    await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click(); await page.locator('[data-companion-contact="deepseek-sister"]').click(); await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    let edit = page.getByRole('dialog', { name: '编辑伙伴资料', exact: true }); await choose(application, boardFile); await edit.getByRole('button', { name: '上传三视图', exact: true }).click(); await edit.getByRole('button', { name: '保存资料', exact: true }).click(); await expect(edit).toHaveCount(0);
    await expect(page.locator('.companions-contact-profile .public-appearance-thumbnail img')).toBeVisible();
    await page.getByRole('button', { name: '发消息', exact: true }).click(); const companionId = 'deepseek-sister', conversationId = 'private-deepseek-sister'; await awake(page, companionId, conversationId);
    async function send(text: string, expected: number) { await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(text); await page.getByRole('button', { name: '发送', exact: true }).click(); await expect.poll(() => captures.length, { timeout: 35000 }).toBe(expected); await expect.poll(async () => (await request(page, { type: 'messages', conversationId, limit: 50 })).messages?.filter(message => message.authorId === companionId && !message.isReplyDraft && message.content.includes('公开资料已经提供')).length ?? 0, { timeout: 20000 }).toBe(expected); }
    await send('我们先从公开资料认识一下彼此吧。', 1);
    expect(captures[0]!.images.map(image => image.personId + '/' + image.role).sort()).toEqual(['deepseek-sister/avatar', 'deepseek-sister/orthographic', 'user/avatar', 'user/orthographic']);
    for (const image of captures[0]!.images) { expect(image.bytes).toBeGreaterThan(100); expect(image.bytes).toBeLessThanOrEqual(1024 * 1024); expect(image.width).toBeGreaterThan(0); expect(image.height).toBeGreaterThan(0); expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(image.role === 'orthographic' ? 1536 : 512); expect(image.detail).toBe(image.role === 'orthographic' ? 'high' : 'low'); }
    const user = captures[0]!.context.publicProfiles.find(person => person.id === 'user')!, self = captures[0]!.context.publicProfiles.find(person => person.id === companionId)!;
    expect(user).toMatchObject({ name: saved.name, description: saved.description });
    for (const image of [user.avatar, user.orthographic, self.avatar, self.orthographic]) { expect(image?.available).toBe(true); expect(path.isAbsolute(image!.absolutePath!)).toBe(true); expect(existsSync(image!.absolutePath!)).toBe(true); }
    expect(captures[0]!.context.identity.currentReply.speaker).toMatchObject({ id: 'user', name: saved.name });
    const own = page.locator('.companions-message.is-own').first(); await expect(own.locator('.companions-message-author')).toContainText(saved.name); expect(await own.locator('.companion-avatar').evaluate(element => getComputedStyle(element).backgroundSize)).toBe('cover');
    await page.screenshot({ path: path.join(artifacts, 'verified-player-chat-identity.png') });
    expect((await request(page, { type: 'messages', conversationId, limit: 50 })).messages!.find(message => message.content === '我们先从公开资料认识一下彼此吧。')!.authorId).toBe('user');
    rmSync(avatarFile); rmSync(boardFile); await application.close(); application = undefined;
    started = await launch(profilePath); application = started.application; page = started.page;
    settings = await openSettings(page); expect((await request(page, { type: 'player.profile.get' })).playerProfile).toMatchObject({ avatarAttachmentId: saved.avatarAttachmentId, appearanceAttachmentId: saved.appearanceAttachmentId });
    await expect.poll(() => settings.locator('.public-appearance-thumbnail img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(960);
    await page.keyboard.press('Escape'); await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click(); await page.locator('[data-companion-contact="deepseek-sister"]').click(); await page.getByRole('button', { name: '发消息', exact: true }).click();
    await send('原始上传文件已经删除，我们继续聊吧。', 2);
    expect(captures[1]!.images.map(image => image.personId + '/' + image.role).sort()).toEqual(captures[0]!.images.map(image => image.personId + '/' + image.role).sort());
    settings = await openSettings(page);
    await settings.getByRole('button', { name: '移除三视图', exact: true }).click(); await settings.getByRole('button', { name: '保存用户信息', exact: true }).click(); await expect(settings).toContainText('用户信息已保存'); await page.keyboard.press('Escape');
    await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click(); await page.locator('[data-companion-contact="deepseek-sister"]').click(); await page.getByRole('button', { name: '编辑资料', exact: true }).click(); edit = page.getByRole('dialog', { name: '编辑伙伴资料', exact: true }); await edit.getByRole('button', { name: '恢复内置三视图', exact: true }).click(); await edit.getByRole('button', { name: '保存资料', exact: true }).click(); await page.getByRole('button', { name: '发消息', exact: true }).click();
    await send('我们继续聊，公开设定板现在已经移除了。', 3);
    expect(captures[2]!.images.map(image => image.personId + '/' + image.role).sort()).toEqual(['deepseek-sister/avatar', 'deepseek-sister/orthographic', 'user/avatar']);
    expect(JSON.stringify(captures[2]!.context)).not.toContain(user.orthographic!.absolutePath!);
    const restoredBoard = captures[2]!.context.publicProfiles.find(profile => profile.id === companionId)?.orthographic;
    expect(restoredBoard?.absolutePath).toBe(self.orthographic!.absolutePath);
    expect(restoredBoard?.sha256).toBeTruthy(); expect(restoredBoard?.sha256).not.toBe(self.orthographic!.sha256);
    settings = await openSettings(page); await settings.getByRole('button', { name: '移除头像', exact: true }).click(); await settings.getByRole('button', { name: '保存用户信息', exact: true }).click(); await expect(settings).toContainText('用户信息已保存'); expect((await request(page, { type: 'player.profile.get' })).playerProfile!.avatarAttachmentId).toBeUndefined();
    expect(providerErrors).toEqual([]);
    expect(socialReviews.length).toBeGreaterThan(0);
    const report = { fixtureKind: 'synthetic_public_profile', authorId: 'user', imageProofs: captures.map(capture => capture.images), originalUploadsDeleted: true, restartPreservedManagedImages: true, removedCustomBoardsAbsentFromNextRequest: true, builtInBoardRestored: true, auxiliaryPurposes, providerErrors, socialReviewCount: socialReviews.length, socialReviews };
    writeFileSync(path.join(artifacts, 'verified-companion-public-profile.json'), JSON.stringify(report, null, 2)); await testInfo.attach('public-profile-image-proof', { body: JSON.stringify(report), contentType: 'application/json' });
  } catch (cause) {
    const logs = application && await application.evaluate(({ app }) => app.getPath('logs')).catch(() => undefined);
    if (logs && existsSync(logs)) {
      const diagnostics = readdirSync(logs).filter(file => file.endsWith('.log')).flatMap(file => readFileSync(path.join(logs, file), 'utf8').split('\n').filter(line => line.includes('companions.initialization') || line.includes('companions.service'))).join('\n').replaceAll(root, '<isolated-profile>').replaceAll('fixture-public-profile-key', '<fixture-key>');
      await testInfo.attach('profile-diagnostics', { body: diagnostics, contentType: 'text/plain' });
      if (diagnostics) console.log(diagnostics);
    }
    throw cause;
  } finally { await application?.close().catch(() => undefined); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); cleanup(root); }
});
