import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import type { CompanionWorkspaceRequest } from '../../src/shared/companion-workspace';
import { localTextEmbeddingProfileKey, LOCAL_TEXT_EMBEDDING_MODEL_ID } from '../../src/shared/embedding/global-profile';
import { removeCompanionTestDirectory, electronLaunchEnv, preparePackagedCompanionLaunch, resolveElectronLaunchOptions } from './electron-test-helpers';

type BridgeWindow = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; library: WorldlineBoxLibraryApi; llm: WorldlineBoxLlmApi } };

// Every inference in this case uses the application's real immutable bundled model.
// No paid chat model, fake embedding endpoint or direct database writes are used.
// eslint-disable-next-line no-empty-pattern
test('binds the first companion entry to a real asset library and keeps readable notes, native recall and linked assets in sync across restart', async ({}, testInfo) => {
  test.setTimeout(420_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companion-library-e2e-'));
  const profile = path.join(root, 'profile');
  let application: ElectronApplication | undefined;
  let succeeded = false;
  const diagnostics: string[] = [];
  try {
    let started = await launch(profile); application = started.application; let page = started.page;
    application.process().stderr?.on('data', chunk => diagnostics.push(String(chunk)));
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.getByRole('region', { name: '伙伴资产库', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '创建伙伴资产库', exact: true })).toBeVisible({ timeout: 30_000 });
    expect((await workspace(page, { type: 'status' })).selected).toBeUndefined();
    const refused = await page.evaluate(() => (window as unknown as BridgeWindow).worldlinebox.companions.request({ type: 'state' }));
    expect(refused.ok).toBe(false); expect(refused.error).toBeTruthy();
    expect(existsSync(path.join(profile, 'companions'))).toBe(false);
    expect(existsSync(path.join(profile, 'companion-library.json'))).toBe(false);

    const created = await page.evaluate(() => (window as unknown as BridgeWindow).worldlinebox.library.create({ displayName: '伙伴自然记忆验收' }));
    expect(created.ok).toBe(true); if (!created.ok) throw new Error(created.error.message);
    const libraryId = created.value.libraryId;
    const selected = (await workspace(page, { type: 'select', libraryId })).selected!;
    expect(selected.memoryRoot).toBe(path.join(selected.libraryPath, '伙伴记忆'));
    expect(selected.dataRoot).toBe(path.join(selected.libraryPath, '.worldlinebox', 'companions'));
    expect(path.dirname(selected.libraryPath)).toBe(root);
    // The API-driven selection above does not submit the renderer's first-entry form.
    await page.getByRole('dialog', { name: '创建伙伴资产库', exact: true }).getByRole('button', { name: '关闭伙伴资产库设置', exact: true }).click();
    // Remount the first-entry boundary after selecting through the real preload API.
    await page.locator('[data-application-module="dsh"]').click();
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.getByRole('button', { name: '打开记忆目录', exact: true })).toBeVisible();
    const config = await page.evaluate(() => (window as unknown as BridgeWindow).worldlinebox.llm.getConfig());
    expect(config.ok).toBe(true); if (config.ok) expect(config.value.hasKey).toBe(false);
    const state = (await request(page, { type: 'state' })).state!;
    const companionId = 'deepseek-sister';
    expect(state.companions.some(companion => companion.id === companionId && companion.builtin)).toBe(true);
    expect(state.companions.find(companion => companion.id === companionId)?.active).toBe(false);
    await page.getByRole('button', { name: '发起聊天', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: '发起聊天', exact: true });
    await chooser.locator('.companions-start-chat-list button').filter({ has: page.getByText('大肥鱼', { exact: true }) }).click();
    await expect(chooser).toHaveCount(0);
    const conversationId = 'private-' + companionId, scope = { companionId, conversationId };
    await expect.poll(() => existsSync(path.join(selected.dataRoot, 'messages.sqlite'))).toBe(true);
    const owner = path.join(selected.memoryRoot, companionId), folder = path.join(owner, '资料');
    await expect.poll(() => existsSync(folder), { timeout: 30_000 }).toBe(true);
    for (const category of ['日记', '资料', '自我认识', '时间线']) expect(existsSync(path.join(owner, category))).toBe(true);
    expect(readFileSync(path.join(owner, 'profile.md'), 'utf8')).toContain('稳定人格');

    const originalText = '这份真实学习资料记录：海獭会把最喜欢的石头藏在腋下的皮褶里，用来敲开贝壳。';
    const revisedText = originalText + '\n用户补充：海獭在海藻间休息时会牵住同伴，避免被海流冲散。';
    const file = path.join(folder, '真实资料.md'); writeFileSync(file, originalText, 'utf8');
    const browse = () => request(page, { type: 'memory.browse', ...scope, query: '', tags: [], limit: 100 });
    const noteWith = async (content: string) => (await browse()).memoryPage?.items.find(hit => hit.memory.content === content)?.memory;
    await expect.poll(async () => (await noteWith(originalText))?.status, { timeout: 120_000 }).toBe('indexed');
    const imported = (await noteWith(originalText))!;
    expect(imported).toMatchObject({ companionId, diaryName: '资料', captureMethod: 'manual', version: 1, sources: [{ sourceType: 'manual_input' }] });
    const source = (await request(page, { type: 'memory.read', ...scope, id: imported.id, sourceLimit: 100 })).memoryRead!.sources[0]!;
    expect(source).toMatchObject({ authorId: 'user', kind: 'notice', memoryEvidenceOnly: true, content: originalText });
    expect(JSON.parse(readFileSync(file + '.meta.json', 'utf8'))).toMatchObject({ id: imported.id, version: imported.version, sources: [{ sourceType: 'manual_input' }] });
    const recall = await request(page, { type: 'memory.search', ...scope, query: '海獭怎样保存敲贝壳的工具？', tags: [], limit: 20 });
    expect(recall.memoryPage?.items.find(hit => hit.memory.id === imported.id)).toMatchObject({ score: expect.any(Number), reasons: expect.arrayContaining(['VCP river']) });
    const memoryProfile = recall.memoryContext?.profileKey;
    expect(memoryProfile).toBe(localTextEmbeddingProfileKey());
    const dormantCold = (await request(page, { type: 'memory.knowledge', ...scope, operation: 'ingest', sourceType: 'memory', sourceId: imported.id })).memoryKnowledge!;
    expect(dormantCold).toMatchObject({ engine: 'original-TDBKnowledge', available: false });
    await request(page, { type: 'companion.set-active', id: companionId, active: true });
    expect((await request(page, { type: 'state' })).state?.companions.find(companion => companion.id === companionId)?.active).toBe(true);
    const cold = (await request(page, { type: 'memory.knowledge', ...scope, operation: 'ingest', sourceType: 'memory', sourceId: imported.id })).memoryKnowledge!;
    expect(cold).toMatchObject({ engine: 'original-TDBKnowledge', available: true, indexed: true,
      result: { sourceId: imported.id, sourceType: 'memory', sourceVersion: String(imported.version), chunks: expect.any(Number) } });
    const coldDocument = cold.result!;
    expect((await request(page, { type: 'memory.knowledge', ...scope, operation: 'read', id: coldDocument.id, version: coldDocument.version }))
      .memoryKnowledge?.result?.text).toBe(originalText);
    const coldRecall = (await request(page, { type: 'memory.knowledge', ...scope, operation: 'search', query: '海獭的石头放在哪里？', sourceIds: [imported.id], limit: 10 })).memoryKnowledge!;
    expect(coldRecall.items).toContainEqual(expect.objectContaining({ id: coldDocument.id, version: coldDocument.version, sourceId: imported.id,
      text: expect.stringContaining('腋下') }));
    expect((await request(page, { type: 'memory.knowledge', ...scope, operation: 'search', query: '海獭', sourceIds: [], limit: 10 })).memoryKnowledge?.items).toEqual([]);

    const linked = await page.evaluate(id => (window as unknown as BridgeWindow).worldlinebox.library.listLinkedFolders({ libraryId: id }), libraryId);
    expect(linked.ok).toBe(true);
    if (!linked.ok) throw new Error(linked.error.message);
    const memoryFolder = linked.value.find(item => pathLike(item.absoluteRootPath) === pathLike(selected.memoryRoot));
    expect(memoryFolder).toBeDefined();
    await expect.poll(async () => (await assets(page, libraryId)).find(asset => asset.displayName === '真实资料.md')?.availability, { timeout: 60_000 }).toBe('available');
    const asset = (await assets(page, libraryId)).find(item => item.displayName === '真实资料.md')!;
    expect(asset.locationKind).toBe('linked'); expect(asset.linkedFolderId).toBe(memoryFolder!.linkedFolderId ?? memoryFolder!.folderId);

    const settings = await page.evaluate(() => (window as unknown as BridgeWindow).worldlinebox.library.embeddingGetGlobalSettings());
    expect(settings.ok && settings.value.selectionId).toBe(LOCAL_TEXT_EMBEDDING_MODEL_ID);
    let assetSemanticRecall = false;
    if (process.env.WORLDLINEBOX_E2E_MEMORY_ASSET_EMBEDDING !== '0') {
      const indexing = await page.evaluate(input => (window as unknown as BridgeWindow).worldlinebox.library.embeddingIndexStatus(input), { libraryId, modelId: LOCAL_TEXT_EMBEDDING_MODEL_ID, run: true, restart: false });
      console.log('MEMORY_LIBRARY_ASSET_TARGET', JSON.stringify(asset));
      console.log('MEMORY_LIBRARY_ASSET_INITIAL_STATUS', JSON.stringify(indexing));
      expect(indexing.ok).toBe(true);
      let latest = '';
      await expect.poll(async () => {
        const result = await page.evaluate(input => (window as unknown as BridgeWindow).worldlinebox.library.embeddingSearch(input), { libraryId, modelId: LOCAL_TEXT_EMBEDDING_MODEL_ID, query: '海獭藏在腋下的石头有什么用途？' });
        const signature = JSON.stringify(result); if (signature !== latest) { latest = signature; console.log('MEMORY_LIBRARY_ASSET_INDEX', signature); }
        return result.ok && result.value.assetIds.includes(asset.assetId);
      }, { timeout: 90_000 }).toBe(true);
      assetSemanticRecall = true;
    }

    writeFileSync(file, revisedText, 'utf8');
    await expect.poll(async () => (await noteWith(revisedText))?.status, { timeout: 90_000 }).toBe('indexed');
    const revised = (await noteWith(revisedText))!;
    expect(revised.id).toBe(imported.id); expect(revised.version).toBe(imported.version + 1);
    expect(revised.sources.some(item => item.sourceType === 'manual_input' && item.messageId !== source.id)).toBe(true);
    const staleCold = await page.evaluate(input => (window as unknown as BridgeWindow).worldlinebox.companions.request(input),
      { type: 'memory.knowledge', ...scope, operation: 'read', id: coldDocument.id, version: coldDocument.version } as CompanionsRequest);
    expect(staleCold.ok).toBe(false);
    const revisedCold = (await request(page, { type: 'memory.knowledge', ...scope, operation: 'ingest', sourceType: 'memory', sourceId: revised.id })).memoryKnowledge!;
    expect(revisedCold.indexed).toBe(true); expect(revisedCold.result?.version).not.toBe(coldDocument.version);
    expect((await request(page, { type: 'memory.knowledge', ...scope, operation: 'read', id: revisedCold.result!.id, version: revisedCold.result!.version }))
      .memoryKnowledge?.result?.text).toBe(revisedText);
    const renamed = path.join(folder, '海獭学习笔记.md'); renameSync(file, renamed);
    await expect.poll(() => existsSync(renamed + '.meta.json'), { timeout: 45_000 }).toBe(true);
    const afterRename = (await request(page, { type: 'memory.read', ...scope, id: imported.id, sourceLimit: 100 })).memoryRead!.memory;
    expect(afterRename.version).toBe(revised.version); expect(afterRename.sources).toEqual(revised.sources);
    expect(JSON.parse(readFileSync(renamed + '.meta.json', 'utf8'))).toMatchObject({ id: imported.id, version: revised.version });
    await expect.poll(async () => (await assets(page, libraryId)).find(item => item.displayName === '海獭学习笔记.md')?.availability, { timeout: 60_000 }).toBe('available');
    expect(readFileSync(path.join(owner, '同步状态.md'), 'utf8')).toContain('已同步');

    unlinkSync(renamed);
    await expect.poll(async () => (await browse()).memoryPage?.items.some(hit => hit.memory.id === imported.id), { timeout: 90_000 }).toBe(false);
    expect((await request(page, { type: 'memory.search', ...scope, query: '海獭收藏的石头和牵手休息', tags: [], limit: 20 })).memoryPage?.items).toEqual([]);
    expect((await request(page, { type: 'memory.sources.filter', ...scope, ids: [source.id, ...revised.sources.map(item => item.messageId)] })).memorySources).toEqual([]);
    expect((await request(page, { type: 'memory.knowledge', ...scope, operation: 'search', query: '海獭收藏的石头', sourceIds: [imported.id] })).memoryKnowledge?.items).toEqual([]);
    // Restoring an old managed export is not new user authorization to remember it.
    writeFileSync(renamed, revisedText, 'utf8');
    await application.close(); application = undefined;
    started = await launch(profile); application = started.application; page = started.page;
    application.process().stderr?.on('data', chunk => diagnostics.push(String(chunk)));
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.getByRole('button', { name: '打开记忆目录', exact: true })).toBeVisible();
    const restored = (await workspace(page, { type: 'status' })).selected!;
    expect(restored).toEqual(selected);
    await expect.poll(() => existsSync(renamed), { timeout: 45_000 }).toBe(false);
    expect((await request(page, { type: 'memory.browse', ...scope, query: '', tags: [], limit: 100 })).memoryPage?.items).toEqual([]);
    expect((await request(page, { type: 'memory.search', ...scope, query: '海獭收藏石头', tags: [], limit: 20 })).memoryPage?.items).toEqual([]);
    expect((await request(page, { type: 'memory.knowledge', ...scope, operation: 'status' })).memoryKnowledge?.total).toBe(0);
    await expect.poll(async () => {
      const opened = await page.evaluate(() => (window as unknown as BridgeWindow).worldlinebox.library.listOpen());
      return opened.ok && opened.value.some(item => item.libraryId === libraryId);
    }, { timeout: 45_000 }).toBe(true);
    const afterRestart = path.join(folder, '重启后的新资料.md');
    const restartText = '这是应用重启后由用户提供的一份新资料，用来核查目录监听已经恢复。';
    writeFileSync(afterRestart, restartText, 'utf8');
    await expect.poll(async () => (await noteWith(restartText))?.status, { timeout: 90_000 }).toBe('indexed');
    const restartRecall = await request(page, { type: 'memory.search', ...scope, query: '应用重启后目录监听恢复的新资料', tags: [], limit: 20 });
    expect(restartRecall.memoryContext?.profileKey).toBe(memoryProfile);
    expect(restartRecall.memoryPage?.items.some(hit => hit.memory.content === restartText)).toBe(true);
    await expect.poll(async () => (await assets(page, libraryId)).find(item => item.displayName === '重启后的新资料.md')?.availability, { timeout: 60_000 }).toBe('available');
    expect(existsSync(path.join(profile, 'companions'))).toBe(false);
    const locator = JSON.parse(readFileSync(path.join(profile, 'companion-library.json'), 'utf8'));
    expect(Object.keys(locator).sort()).toEqual(['displayName', 'libraryId', 'libraryPath']);
    expect(locator.libraryPath).toBe(selected.libraryPath);
    const copiedWeights = filesUnder(profile).filter(file => /\.(?:gguf|onnx|safetensors)$/i.test(file));
    expect(copiedWeights).toEqual([]);
    const report = { selectedLibraryId: libraryId, companionId, noteId: imported.id, sourceType: imported.sources[0]?.sourceType,
      nativeIndexed: true, originalVcpRecall: true, assetSemanticRecall, profileKey: recall.memoryContext?.profileKey,
      editedVersion: revised.version, renamePreservedVersion: true, forgottenAcrossRestart: true, linkedWatcherRestored: true, profileHasCompanionData: false,
      profileModelWeightCopies: copiedWeights.length, realBundledEmbedding: true, configuredPaidChat: false,
      originalColdTdbKnowledge: true, coldVersionReadAndNativeSearch: true, coldSourceFilterBeforeQuery: true, coldInvalidatedAfterEditAndWithdrawal: true };
    const output = path.resolve('artifacts/vcp-validation'); mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, 'verified-memory-library.json'), JSON.stringify(report, null, 2));
    await testInfo.attach('real-library-memory-proof', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    succeeded = true;
  } catch (error) {
    await application?.windows()[0]?.screenshot({ path: testInfo.outputPath('memory-library-failure.png') }).catch(() => undefined);
    const logs = path.join(profile, 'logs');
    if (existsSync(logs)) for (const file of readdirSync(logs).filter(file => file.endsWith('.log'))) diagnostics.push(readFileSync(path.join(logs, file), 'utf8'));
    await testInfo.attach('memory-library-diagnostics', { body: diagnostics.join('\n'), contentType: 'text/plain' });
    throw error;
  } finally {
    await application?.close().catch(() => undefined);
    if (!succeeded && process.env.WORLDLINEBOX_E2E_RETAIN_FAILED_LIBRARY === '1') console.log('MEMORY_LIBRARY_FAILED_FIXTURE', root);
    else cleanup(root);
  }
});

function pathLike(file: string): string { return file.replaceAll('\\', '/').toLowerCase(); }
function cleanup(root: string): void {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-companion-library-e2e-')) throw new Error('Unexpected E2E fixture cleanup target.');
  removeCompanionTestDirectory(root);
}
function filesUnder(root: string): string[] {
  const files: string[] = [], pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || lstatSync(file).isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(file); else files.push(file);
    }
  }
  return files;
}
async function launch(profile: string): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({ ...resolveElectronLaunchOptions(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_CREATE_PARENT_PATH: path.dirname(profile) }) });
  await preparePackagedCompanionLaunch(application, profile);
  const page = await application.firstWindow(), nativeWindow = await application.browserWindow(page);
  await nativeWindow.evaluate(win => { win.unmaximize(); win.setSize(1440, 900); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
  return { application, page };
}
async function request(page: Page, input: CompanionsRequest) {
  const response = await page.evaluate(value => (window as unknown as BridgeWindow).worldlinebox.companions.request(value), input);
  expect(response.ok, response.error).toBe(true); return response;
}
async function workspace(page: Page, input: CompanionWorkspaceRequest) {
  const response = await page.evaluate(value => (window as unknown as BridgeWindow).worldlinebox.companions.workspace!(value), input);
  expect(response.ok, response.error).toBe(true); return response;
}
async function assets(page: Page, libraryId: string) {
  const response = await page.evaluate(id => (window as unknown as BridgeWindow).worldlinebox.library.listAssets({ libraryId: id, recursive: true }), libraryId);
  expect(response.ok).toBe(true); if (!response.ok) throw new Error(response.error.message); return response.value;
}
