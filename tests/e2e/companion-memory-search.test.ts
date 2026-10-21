import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionMemoryDocumentCommand } from '../../src/shared/companion-memory-documents';
import { removeCompanionTestDirectory, electronLaunchEnv, ensureCompanionTestWorkspace, preparePackagedCompanionLaunch, resolveElectronLaunchOptions } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi } };
// Actual source receipts, text files, keyword catalog and the bundled VCP embedding model.
// eslint-disable-next-line no-empty-pattern
test('searches full text beyond the first document page and isolates semantic and tag searches by companion', async ({}, testInfo) => {
  test.setTimeout(480_000);
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-memory-search-')), profile = path.join(fixtureRoot, 'profile');
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
  try {
    await preparePackagedCompanionLaunch(application, profile);
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setSize(1440, 960); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    await ensureCompanionTestWorkspace(page);
    const companionId = 'deepseek-sister', otherOwner = 'deepseek-flash';
    const ownerList = (await page.evaluate(() => (window as unknown as Bridge).worldlinebox.companions.request({ type: 'state' }))).state!.companions;
    expect(ownerList.some(owner => owner.id === otherOwner)).toBe(true);
    for (let index = 0; index < 70; index++) await documents(page, { type: 'memory.documents.create', companionId,
      path: '资料/' + String(index).padStart(3, '0') + '-日常索引.md', content: `这是第${index}份资料，用于整理不同日期的阅读清单与工作目录。此夹具文本不代表实际发生过新的生活事件。`, tags: ['日常索引'], diaryName: '学习资料' });
    const targetPath = '资料/zz-黄昏书店.md';
    const target = (await documents(page, { type: 'memory.documents.create', companionId, path: targetPath,
      content: '# 黄昏书店\n\n' + '这份资料用于整理阅读清单和日程索引。'.repeat(48) + '\n\n蓝灯书屋位于旧灯塔的北侧，只有等到日落之后才开门。想找旧书的人，可以在海边散步后再过去。', tags: ['旅行', '书店'], diaryName: '旅行资料' })).document!;
    await documents(page, { type: 'memory.documents.create', companionId, path: '资料/zy-海岸步道.md', content: '海岸步道适合清晨散步，从车站经过码头到旧灯塔。', tags: ['旅行', '散步'], diaryName: '旅行资料' });
    await documents(page, { type: 'memory.documents.create', companionId: otherOwner, path: '资料/另一位伙伴的档案.md', content: '铁杉档案属于另一位伙伴，记录了一份植物标本的名称。', tags: ['植物'], diaryName: '学习资料' });
    await expect.poll(async () => (await documents(page, { type: 'memory.documents.list', companionId, directory: '', limit: 64 })).documents?.index?.state, { timeout: 60_000 }).toBe('ready');
    const first = (await documents(page, { type: 'memory.documents.list', companionId, directory: '', limit: 64 })).documents!;
    expect(first.items).toHaveLength(64); expect(first.hasMore).toBe(true); expect(first.items.some(item => item.path === targetPath)).toBe(false);
    const keyword = (await documents(page, { type: 'memory.documents.list', companionId, directory: '', query: '蓝灯书屋', mode: 'keyword', limit: 64 })).documents!;
    expect(keyword.items.some(item => item.noteId === target.document.noteId)).toBe(true);
    const tagged = (await documents(page, { type: 'memory.documents.list', companionId, directory: '', tags: ['旅行', '书店'], limit: 64 })).documents!;
    expect(tagged.items.map(item => item.path)).toEqual([targetPath]);
    await expect.poll(async () => (await page.evaluate(owner => (window as unknown as Bridge).worldlinebox.companions.request({ type: 'memory.status', companionId: owner }), companionId)).memoryStatus?.pendingIndex, { timeout: 240_000 }).toBe(0);
    const semanticQuery = '哪一家旧书店要等傍晚太阳落山后才能进去？';
    const semanticPage = () => documents(page, { type: 'memory.documents.list', companionId, directory: '', query: semanticQuery, mode: 'semantic', limit: 64 });
    // Human-owner VCP views build independently of the agent recall outbox.
    // A building page is deliberately incomplete and must be queried again.
    await expect.poll(async () => (await semanticPage()).documents?.index?.state, { timeout: 180_000 }).toBe('ready');
    const semantic = (await semanticPage()).documents!;
    expect(semantic.items.some(item => item.noteId === target.document.noteId)).toBe(true);
    expect((await documents(page, { type: 'memory.documents.list', companionId: otherOwner, directory: '', query: '蓝灯书屋', mode: 'keyword', limit: 64 })).documents!.items).toHaveLength(0);
    await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '打开伙伴记忆库', exact: true }).click();
    const manager = page.getByRole('dialog', { name: '共同记忆管理', exact: true });
    await manager.getByRole('combobox', { name: '记忆所属伙伴', exact: true }).selectOption(companionId);
    await expect(manager.locator('.memory-library-file')).toHaveCount(64);
    await manager.getByRole('button', { name: '下一页文档', exact: true }).click();
    await expect(manager.locator(`[data-memory-document="${targetPath}"]`)).toBeVisible();
    expect(await manager.locator('.memory-library-file').count()).toBeLessThanOrEqual(64);
    await manager.getByRole('searchbox', { name: '搜索全部记忆文档', exact: true }).fill('蓝灯书屋');
    await expect(manager.locator(`[data-memory-document="${targetPath}"]`)).toBeVisible();
    await manager.getByRole('combobox', { name: '记忆文档搜索方式', exact: true }).selectOption('semantic');
    await manager.getByRole('searchbox', { name: '搜索全部记忆文档', exact: true }).fill(semanticQuery);
    await expect(manager.locator(`[data-memory-document="${targetPath}"]`)).toBeVisible({ timeout: 60_000 });
    await manager.getByRole('combobox', { name: '记忆所属伙伴', exact: true }).selectOption(otherOwner);
    await expect(manager.locator(`[data-memory-document="${targetPath}"]`)).toHaveCount(0);
    await manager.getByRole('combobox', { name: '记忆文档搜索方式', exact: true }).selectOption('keyword');
    await manager.getByRole('searchbox', { name: '搜索全部记忆文档', exact: true }).fill('蓝灯书屋');
    await expect(manager.locator('.memory-library-file')).toHaveCount(0);
    await manager.getByRole('searchbox', { name: '搜索全部记忆文档', exact: true }).fill('铁杉档案');
    await expect(manager.locator('.memory-library-file')).toHaveCount(1);
    await testInfo.attach('full-library-search-proof', { body: JSON.stringify({ actualNotes: 73, keywordBeyondFirst64: true, searchedBodyBeyondExcerpt600: true, combinedTags: ['旅行', '书店'], semanticQuery, bundledModel: true, ownerIsolation: true, maxFileDom: 64 }), contentType: 'application/json' });
  } finally { await application.close(); cleanup(fixtureRoot); }
});
async function documents(page: Page, command: CompanionMemoryDocumentCommand) { const result = await page.evaluate(input => (window as unknown as Bridge).worldlinebox.companions.workspace!(input), command); expect(result.ok, result.error).toBe(true); return result; }
function cleanup(fixtureRoot: string) { if (path.dirname(fixtureRoot) !== tmpdir() || !path.basename(fixtureRoot).startsWith('worldlinebox-memory-search-')) throw new Error('Unexpected search fixture cleanup target.'); removeCompanionTestDirectory(fixtureRoot); }
