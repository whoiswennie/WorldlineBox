import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import { LOCAL_TEXT_EMBEDDING_MODEL_ID } from '../../src/shared/embedding/global-profile';
import { removeCompanionTestDirectory, assetCard, electronLaunchEnv, resolveElectronLaunchOptions, waitForLibraryLoadingToFinish } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { library: WorldlineBoxLibraryApi } };
function cleanupSemanticFixture(root: string) {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-semantic-sqlite-e2e-')) throw new Error('Unexpected semantic fixture cleanup path.');
  removeCompanionTestDirectory(root);
}

// The actual bundled multimodal model and production Worker/SQLite index are used.
// Only the OS picker is directed to this case's own files; no embedding endpoint,
// replacement vectors, index writes or user profile are supplied by the fixture.
// eslint-disable-next-line no-empty-pattern
test('enables real bundled asset semantics through the UI and reuses SQLite vectors after full restart before releasing runtime cache', async ({}, testInfo) => {
  test.setTimeout(300_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-semantic-sqlite-e2e-'));
  const evidence = path.resolve('artifacts/vcp-validation/asset-ui-lifecycle'); mkdirSync(evidence, { recursive: true });
  const profile = path.join(root, 'profile'), libraryPath = path.join(root, '本地语义验收');
  const files = ['雨天备忘.md', '会议安排.md', '红色方块.png', '相近红色方块.png', '蓝色方块.png'].map(name => path.join(root, name));
  writeFileSync(files[0]!, '# 雨天备忘\n\n折叠雨伞放在玄关左边第二个抽屉里。天气预报有降水时，出门记得带上。', 'utf8');
  writeFileSync(files[1]!, '# 会议安排\n\n周五上午十点在公司三楼开季度预算会议，提前准备报销单。', 'utf8');
  for (const [index, color] of [[2, '#f00000'], [3, '#e71919'], [4, '#1538ed']] as const) {
    const canvas = createCanvas(256, 256), context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, 256, 256);
    context.fillStyle = color; context.fillRect(28, 28, 200, 200); writeFileSync(files[index]!, canvas.toBuffer('image/png'));
  }
  let application: ElectronApplication | undefined;
  const diagnostics: string[] = [];
  const launch = async () => {
    const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
      WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile,
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root, WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath,
      WORLDLINEBOX_E2E_IMPORT_FILES: files.join(path.delimiter),
    }) });
    app.process().stderr?.on('data', chunk => { diagnostics.push(String(chunk)); });
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) await app.evaluate(({ app, dialog }, fixture) => {
      if (!app.isPackaged || app.getPath('userData') !== fixture.profile) throw new Error('Packaged semantics must use its real ASAR and isolated profile.');
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const title = (args.at(-1) as { title?: string }).title ?? '';
        if (/Create Library|创建资源库/iu.test(title)) return { canceled: false, filePaths: [fixture.root] };
        if (/Open Library|打开资源库/iu.test(title)) return { canceled: false, filePaths: [fixture.libraryPath] };
        if (/Import|导入/iu.test(title)) return { canceled: false, filePaths: fixture.files };
        throw new Error('Unexpected native dialog in semantic fixture: ' + title);
      };
    }, { root, profile, libraryPath, files });
    const page = await app.firstWindow(), native = await app.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setSize(1440, 960); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    await page.locator('[data-application-module="assets"]').click();
    return { application: app, page };
  };
  try {
    let started = await launch(); application = started.application; let page = started.page;
    await page.getByRole('button', { name: '创建资源库', exact: true }).click();
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('本地语义验收');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await waitForLibraryLoadingToFinish(page);
    await page.getByRole('button', { name: '导入文件', exact: true }).first().click();
    for (const file of files) await expect(assetCard(page, path.basename(file))).toBeVisible({ timeout: 30_000 });
    const opened = await page.evaluate(() => (window as unknown as Bridge).worldlinebox.library.listOpen());
    expect(opened.ok).toBe(true); if (!opened.ok) throw new Error(opened.error.message);
    const libraryId = opened.value[0]!.libraryId;
    const resources = await page.evaluate(async () => {
      const api = (window as unknown as Bridge).worldlinebox.library;
      return { global: await api.embeddingGetGlobalSettings(), bundled: await api.embeddingLocalTextStatus(), toolbar: await api.embeddingInstallStatus() };
    });
    console.log('ASSET_UI_BUNDLED_RESOURCES', JSON.stringify(resources));
    expect(resources.bundled).toMatchObject({ ok: true, value: { phase: 'ready', installed: true, runtimeInstalled: true } });
    expect(resources.toolbar).toMatchObject({ ok: true, value: { runtimeInstalled: true, models: expect.arrayContaining([{ modelId: LOCAL_TEXT_EMBEDDING_MODEL_ID, installed: true }]) } });
    await openSettings(page, '语义搜索');
    const enabled = page.getByRole('switch', { name: '开启语义搜索', exact: true });
    await expect(enabled).toHaveAttribute('aria-checked', 'false'); await enabled.click();
    await expect(enabled).toHaveAttribute('aria-checked', 'true'); await page.keyboard.press('Escape');
    // run:false only observes: the renderer UI must actually start the encoder.
    let lastStatus = '';
    await expect.poll(async () => {
      const state = await indexStatus(page, libraryId), signature = JSON.stringify(state);
      if (signature !== lastStatus) { lastStatus = signature; console.log('ASSET_UI_INDEX_STATUS', signature); }
      return state;
    }, { timeout: 120_000 }).toMatchObject({ phase: 'ready', done: 5, total: 5, failedCount: 0 });
    const before = await persistedVectors(application, libraryPath);
    expect(before).toHaveLength(5); expect(before.every(row => row.dimensions === 768)).toBe(true);
    const activatedPids = await runtimeChildren(application);
    if (process.platform === 'win32') expect(activatedPids.length).toBeGreaterThan(0);
    await searchFromUi(page, '下雨出门带的东西放在哪里');
    await expect(page.locator('.asset-card').first()).toHaveAttribute('data-asset-name', '雨天备忘.md', { timeout: 60_000 });
    await page.getByRole('combobox', { name: '搜索资源库', exact: true }).fill('');
    await expect(assetCard(page, '红色方块.png')).toBeVisible();
    await assetCard(page, '红色方块.png').click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: '找相似', exact: true }).click();
    await expect(page.locator('.find-similar-banner')).toContainText('红色方块.png');
    await expect(page.locator('.asset-card').first()).toHaveAttribute('data-asset-name', '相近红色方块.png', { timeout: 60_000 });
    await page.screenshot({ path: path.join(evidence, 'bundled-assets-similar.png') });
    await expect.poll(() => persistedVectors(application!, libraryPath)).toEqual(before);

    await application.close(); application = undefined;
    started = await launch(); application = started.application; page = started.page;
    // Asset libraries intentionally reopen through the normal picker. Wait for
    // its first-entry dialog instead of sampling a still-rendering button count.
    await page.getByRole('button', { name: '打开资源库', exact: true }).click();
    await waitForLibraryLoadingToFinish(page);
    await expect(assetCard(page, '雨天备忘.md')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => indexStatus(page, libraryId), { timeout: 120_000 }).toMatchObject({ phase: 'ready', done: 5, total: 5, failedCount: 0 });
    expect(await persistedVectors(application, libraryPath)).toEqual(before);
    await searchFromUi(page, '有降雨预报时应该去哪里取伞');
    await expect(page.locator('.asset-card').first()).toHaveAttribute('data-asset-name', '雨天备忘.md', { timeout: 60_000 });
    expect(await persistedVectors(application, libraryPath)).toEqual(before);
    await openSettings(page, '语义搜索');
    await expect(page.getByRole('switch', { name: '开启语义搜索', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('switch', { name: '开启语义搜索', exact: true }).click();
    await expect.poll(() => indexStatus(page, libraryId), { timeout: 15_000 }).toMatchObject({ phase: 'unavailable' });
    await page.getByRole('tab', { name: '全局模型', exact: true }).click();
    const model = page.getByRole('listitem', { name: '内置多模态向量服务', exact: true });
    await expect(model.getByRole('status')).toHaveText('已就绪');
    await model.getByRole('button', { name: '清理运行缓存', exact: true }).click();
    await expect(model).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
    await expect(model.getByRole('status')).toHaveText('已就绪');
    expect(await persistedVectors(application, libraryPath)).toEqual(before);
    await expect.poll(() => runtimeChildren(application!), { timeout: 15_000 }).toEqual([]);
    const status = await page.evaluate(() => (window as unknown as Bridge).worldlinebox.library.embeddingLocalTextStatus());
    expect(status).toMatchObject({ ok: true, value: { installed: true, runtimeInstalled: true, phase: 'ready' } });
    await page.screenshot({ path: path.join(evidence, 'bundled-assets-cache-released.png') });
    const proof = { model: LOCAL_TEXT_EMBEDDING_MODEL_ID, actualTextAndImages: 5, uiEnabled: true, uiSemanticSearch: true, uiImageSimilar: true, fullAppRestart: true, unchangedVectorBlobsAndTimestamps: before, activatedRuntimePids: activatedPids, runtimeChildrenAfterClear: [], runtimeCleared: true, bundledFilesPreserved: true };
    writeFileSync(path.join(evidence, 'sqlite-reuse-proof.json'), JSON.stringify(proof, null, 2));
    await testInfo.attach('sqlite-reuse-proof', { body: JSON.stringify(proof), contentType: 'application/json' });
  } finally {
    await testInfo.attach('electron-stderr', { body: diagnostics.join('').slice(-120_000), contentType: 'text/plain' });
    await application?.close();
    cleanupSemanticFixture(root);
  }
});

async function openSettings(page: Page, tab: string) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('dialog', { name: '通用设置', exact: true }).getByRole('tab', { name: new RegExp(tab, 'u') }).click();
}
async function indexStatus(page: Page, libraryId: string) {
  const result = await page.evaluate(input => (window as unknown as Bridge).worldlinebox.library.embeddingIndexStatus(input), { libraryId, modelId: LOCAL_TEXT_EMBEDDING_MODEL_ID, run: false, restart: false });
  if (!result.ok) throw new Error(result.error.message); return result.value;
}
async function searchFromUi(page: Page, query: string) {
  const toggle = page.locator('.search-semantic-toggle');
  await expect(toggle).toHaveAttribute('aria-disabled', 'false');
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('combobox', { name: '搜索资源库', exact: true }).fill(query);
  await page.keyboard.press('Enter');
}
async function persistedVectors(application: ElectronApplication, libraryPath: string) {
  return application.evaluate(({ app }, libraryPath) => {
    // Read through Electron's matching native ABI, never open the database in the
    // Node Playwright runner. This read-only probe doesn't own runtime/index writes.
    const require = process.getBuiltinModule('node:module').createRequire(app.getAppPath() + '/package.json');
    const Database = require('better-sqlite3') as new (file: string, options: { readonly: boolean; fileMustExist: boolean }) => {
      prepare(sql: string): { all(): unknown[] }; close(): void;
    };
    const crypto = process.getBuiltinModule('node:crypto');
    const db = new Database(libraryPath + '/.worldlinebox/semantic/index.sqlite', { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT profile_id,asset_id,source_revision,dimensions,vector,updated_at FROM asset_embeddings ORDER BY profile_id,asset_id').all() as Array<{ profile_id: string; asset_id: string; source_revision: string; dimensions: number; vector: Buffer; updated_at: string }>;
      return rows.map(row => ({ profile: row.profile_id, asset: row.asset_id, revision: row.source_revision, dimensions: row.dimensions, hash: crypto.createHash('sha256').update(row.vector).digest('hex'), updatedAt: row.updated_at }));
    } finally { db.close(); }
  }, libraryPath);
}

async function runtimeChildren(application: ElectronApplication): Promise<number[]> {
  return application.evaluate(() => {
    if (process.platform !== 'win32') return [];
    // The runtime has a small owner process, so it is Main's grandchild. Walk
    // the actual process tree instead of assuming the server is a direct child.
    const script = `$allProcesses = @(Get-CimInstance Win32_Process); $descendantIds = [System.Collections.Generic.HashSet[uint32]]::new(); [void]$descendantIds.Add(${process.pid}); do { $added = $false; foreach ($entry in $allProcesses) { if ($descendantIds.Contains([uint32]$entry.ParentProcessId) -and $descendantIds.Add([uint32]$entry.ProcessId)) { $added = $true } } } while ($added); $allProcesses | Where-Object { $_.Name -eq 'llama-server.exe' -and $descendantIds.Contains([uint32]$_.ProcessId) } | Select-Object -ExpandProperty ProcessId`;
    const output = process.getBuiltinModule('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
    return output.trim().split(/\s+/u).filter(Boolean).map(Number);
  });
}
