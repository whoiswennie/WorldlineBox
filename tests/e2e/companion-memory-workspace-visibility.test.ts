import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorkspaceRequest } from '../../src/shared/companion-workspace';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import { electronLaunchEnv, ensureCompanionTestWorkspace, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';
import { openCompanionWorldWindow } from './companion-world-window-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; library: WorldlineBoxLibraryApi } };
const small = 'deepseek-flash', big = 'deepseek-sister';
const manager = (page: Page) => page.getByRole('region', { name: '共同记忆管理', exact: true, includeHidden: true });
const navigation = (page: Page) => page.getByRole('navigation', { name: '伙伴导航', exact: true });
const rows = (page: Page) => manager(page).locator('[data-memory-document]');
const reading = (page: Page) => manager(page).locator('[data-reading-characters]');

test.describe.configure({ timeout: 240_000 });

// These cases use real isolated Electron, library files and memory/outbox jobs.
// There is no fake embedding/chat transport and no direct database mutation.
// A local encoder may index admitted notes; no cloud model is configured.
// eslint-disable-next-line no-empty-pattern
test('shows real creation and modification times, bounded long-document pages and indexed date controls without mixing owners', async ({}, testInfo) => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-memory-visibility-'));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(root); application = launched.application; const page = launched.page;
    await ensureCompanionTestWorkspace(page);
    for (const id of [small, big]) await request(page, { type: 'companion.set-active', id, active: false });
    const first = await createNote(page, small, '日记/先写下的海边约定.md', '小肥鱼的海边约定：星期六先一起看天气，再决定要不要出门。');
    const second = await createNote(page, small, '日记/后来记下的阅读想法.md', '小肥鱼的阅读想法：先核实资料，再写下自己的理解。');
    const privateOther = await createNote(page, big, '日记/姐姐单独保存的想法.md', '姐姐把蓝色丝带夹在书页之间，准备下次接着读。');
    const selected = (await workspace(page, { type: 'status' })).selected!;
    const longPath = '资料/海边行走观察与阅读笔记——沿着旧灯塔、防波堤与书店慢慢走.md';
    const observations = ['潮水退下后，石阶上留下细细的水痕。先记下观察，再查阅潮汐资料，可以把眼前所见和自己的猜想分开。',
      '如果天气合适，想从旧灯塔出发，沿着防波堤慢慢走。不必急着走完全程，也可以在途中找个地方坐下来。',
      '书里提到，留白并不等于放弃认真。暂时没有答案的时候，可以把问题写在页边，等新的线索出现。',
      '带上一本书和一壶温水，是为这次尚未出发的散步做的小小准备。计划需要和真正发生过的经历分别记录。'];
    const longContent = '# 海边行走观察与阅读笔记\n\n这份笔记从旧灯塔旁的第一缕海风开始。\n\n这里收集沿海路线、阅读摘录与尚未出发的想法，作为之后讨论和核对的资料。\n\n'
      + Array.from({ length: 700 }, (_, index) => `### 第${index + 1}则札记\n\n${observations[index % observations.length]}\n\n`).join('')
      + '天色渐暗，我们把还没确定的问题留给下一次散步。';
    expect(longContent.length).toBeGreaterThan(16_384); expect(longContent.length).toBeLessThan(65_536);
    mkdirSync(path.dirname(path.join(selected.memoryRoot, small, longPath)), { recursive: true });
    writeFileSync(path.join(selected.memoryRoot, small, longPath), longContent, 'utf8');
    // A genuine filesystem modification establishes an unambiguous later date.
    const later = new Date(Date.now() + 2 * 86400_000);
    utimesSync(path.join(selected.memoryRoot, small, first.document.path), later, later);

    await enterMemory(page, small);
    await expect(manager(page)).not.toHaveAttribute('aria-modal', 'true');
    await expect(page.getByRole('dialog', { name: '共同记忆管理', exact: true })).toHaveCount(0);
    await manager(page).getByRole('navigation', { name: '记忆文档目录', exact: true }).getByRole('button', { name: /^日记/u }).click();
    await expect.poll(() => rows(page).count()).toBe(2);
    await rows(page).filter({ has: page.getByText('先写下的海边约定', { exact: true }) }).click();
    const times = manager(page).locator('[aria-label="文档时间信息"]');
    await expect(times).toContainText('创建'); await expect(times).toContainText('修改');
    expect(await times.locator('time').first().getAttribute('datetime')).toBe(first.document.createdAt);
    expect(await times.locator('time').nth(1).getAttribute('datetime')).toBe(later.toISOString());
    expect(first.document.createdAt).toBe(first.memory!.createdAt);
    await expect(manager(page).getByRole('region', { name: '本文档处理状态', exact: true })).toContainText('正文已保存');
    await expect(manager(page)).not.toContainText('姐姐把蓝色丝带夹在书页之间');
    await expect(manager(page).locator(`[data-memory-document="${privateOther.document.path}"]`)).toHaveCount(0);

    for (const sort of ['created_asc', 'created_desc', 'updated_desc'] as const) {
      await manager(page).getByRole('combobox', { name: '记忆文档排序', exact: true }).selectOption(sort);
      const expected = (await workspace(page, { type: 'memory.documents.list', companionId: small, directory: '日记', sort, limit: 64 })).documents!.items.map(item => item.path);
      await expect.poll(() => rows(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-memory-document')))).toEqual(expected);
    }
    await manager(page).getByRole('button', { name: '高级筛选记忆文档', exact: true }).click();
    const day = await page.evaluate(value => { const date = new Date(value); return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'); }, later.toISOString());
    await manager(page).getByLabel('记忆开始日期', { exact: true }).fill(day);
    await manager(page).getByLabel('记忆结束日期', { exact: true }).fill(day);
    await expect.poll(() => rows(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-memory-document')))).toEqual([first.document.path]);
    await manager(page).getByRole('combobox', { name: '记忆筛选时间类型', exact: true }).selectOption('createdAt');
    await expect.poll(() => rows(page).count()).toBe(0);
    await manager(page).getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect.poll(() => rows(page).count()).toBe(2);
    await manager(page).getByRole('button', { name: '高级筛选记忆文档', exact: true }).click();
    await manager(page).getByRole('navigation', { name: '记忆文档目录', exact: true }).getByRole('button', { name: /^学习资料/u }).click();
    await expect.poll(async () => (await workspace(page, { type: 'memory.documents.list', companionId: small, directory: '资料', limit: 64 })).documents!.items.some(item => item.path === longPath)).toBe(true);
    await manager(page).getByRole('button', { name: '刷新记忆文件列表', exact: true }).click();
    await manager(page).locator('[data-memory-document]').filter({ has: page.getByText(longPath.split('/').at(-1)!.replace(/\.md$/u, ''), { exact: true }) }).click();
    await expect(reading(page)).toContainText('这份笔记从旧灯塔旁的第一缕海风开始');
    const segment = await reading(page).textContent();
    expect(Number(await reading(page).getAttribute('data-reading-characters'))).toBeLessThanOrEqual(16_384);
    await manager(page).getByRole('navigation', { name: '长文阅读分页', exact: true }).getByRole('button', { name: '下一段', exact: true }).click();
    await expect.poll(() => reading(page).textContent()).not.toBe(segment);
    expect(Number(await reading(page).getAttribute('data-reading-characters'))).toBeLessThanOrEqual(16_384);
    await expect(reading(page)).toHaveCount(1);
    await manager(page).getByRole('navigation', { name: '长文阅读分页', exact: true }).getByRole('button', { name: '上一段', exact: true }).click();
    await expect(reading(page)).toHaveText(segment!);
    const shots = await captureWorkspace(page, launched.native, 'documents', manager(page));
    expect(await rows(page).count()).toBeLessThanOrEqual(64);
    // Memory is an ordinary companion subpage: navigation stays reachable and
    // returning to it preserves the selected file and the existing editor.
    await navigation(page).getByRole('button', { name: '联系人', exact: true }).click();
    await expectNavigation(page, 'contacts'); await expect(manager(page)).toBeHidden(); await expect(manager(page)).toHaveCount(1);
    await navigation(page).getByRole('button', { name: '消息', exact: true }).click();
    await expectNavigation(page, 'messages'); await expect(manager(page)).toBeHidden();
    await navigation(page).getByRole('button', { name: '打开伙伴记忆库', exact: true }).click();
    await expectNavigation(page, 'memory'); await expect(manager(page)).toBeVisible();
    await expect(manager(page).locator('[data-memory-document]').filter({ has: page.getByText(longPath.split('/').at(-1)!.replace(/\.md$/u, ''), { exact: true }) })).toHaveAttribute('aria-pressed', 'true');
    await expect(reading(page)).toHaveText(segment!);
    const observer = await openCompanionWorldWindow(application, page);
    await expectNavigation(page, 'memory');
    await observer.getByRole('button', { name: '关闭伙伴世界', exact: true }).click();
    await expect.poll(() => observer.isClosed()).toBe(true);
    await expect(manager(page)).toBeVisible();
    await navigation(page).getByRole('button', { name: '打开伙伴社交观察', exact: true }).click();
    const social = page.getByRole('dialog', { name: '伙伴社交观察', exact: true }); await expect(social).toBeVisible();
    await expectNavigation(page, 'memory'); await social.getByRole('button', { name: '关闭社交观察', exact: true }).click();
    await expect(social).toHaveCount(0); await expect(manager(page)).toBeVisible();
    await manager(page).getByRole('button', { name: /^编辑记忆 /u }).click();
    const editor = manager(page).getByRole('textbox', { name: '共同记忆内容', exact: true });
    const draft = await editor.inputValue() + '\n\n补记：下次出发前，再一起核对天气与路线。'; await editor.fill(draft);
    await navigation(page).getByRole('button', { name: '联系人', exact: true }).click();
    await expectNavigation(page, 'contacts'); await expect(manager(page)).toBeHidden();
    await navigation(page).getByRole('button', { name: '打开伙伴记忆库', exact: true }).click();
    await expectNavigation(page, 'memory'); await expect(editor).toHaveValue(draft);
    await expect(manager(page).locator('.memory-library-breadcrumb')).toHaveAttribute('title', longPath);
    const evidence = { realFile: longPath, sourceCharacters: longContent.length, singleRenderedSegment: true, maximumRenderedCharacters: 16_384,
      firstCreatedAt: first.document.createdAt, firstModifiedAt: later.toISOString(), secondCreatedAt: second.document.createdAt, timestampFilters: true, ownerIsolation: true,
      memoryIsNavigableSubpage: true, worldAndSocialEntrancesRemainReachable: true, selectedFileAndUnsavedDraftPreserved: true, screenshots: shots };
    writeEvidence('documents-proof.json', evidence); await testInfo.attach('memory-document-visibility-proof', { body: JSON.stringify(evidence), contentType: 'application/json' });
  } finally { await application?.close().catch(() => undefined); cleanup(root); }
});

// eslint-disable-next-line no-empty-pattern
test('opens an existing asset library and exposes actual owner-specific processing in both memory management and the chat side panel', async ({}, testInfo) => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-memory-visibility-'));
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(root); application = launched.application; const page = launched.page;
    const created = await page.evaluate(() => (window as unknown as Bridge).worldlinebox.library.create({ displayName: '真实已有伙伴资产库' }));
    expect(created.ok).toBe(true); if (!created.ok) throw new Error(created.error.message);
    const closed = await page.evaluate(libraryId => (window as unknown as Bridge).worldlinebox.library.close({ libraryId }), created.value.libraryId); expect(closed.ok).toBe(true);
    await application.evaluate(({ dialog }, libraryPath) => {
      process.env.WORLDLINEBOX_E2E_COMPANION_LIBRARY_PATH = '';
      dialog.showOpenDialog = async (...args: unknown[]) => {
        if (!/伙伴.*资产库/u.test((args.at(-1) as { title?: string }).title ?? '')) throw new Error('Unexpected memory-visibility native picker.');
        return { canceled: false, filePaths: [libraryPath] };
      };
    }, created.value.displayPath);
    await page.locator('[data-application-module="companions"]').click();
    await page.getByRole('dialog', { name: '创建伙伴资产库', exact: true }).getByRole('button', { name: /使用已有资产库/u }).click();
    await page.getByRole('dialog', { name: '使用已有资产库', exact: true }).getByRole('button', { name: '打开其他资产库…', exact: true }).click();
    await expect(page.locator('.companion-workspace-name')).toHaveText(created.value.displayName);
    for (const id of [small, big]) await request(page, { type: 'companion.set-active', id, active: false });
    const smallNote = await createNote(page, small, '日记/海边的约定.md', '小肥鱼把海边的约定收进今天的日记。等天气暖一点，带上一本书和一壶温水，再一起去旧灯塔走走。');
    const bigNote = await createNote(page, big, '日记/书页里的银杏.md', '大肥鱼给旧书添了一枚银杏书签。下次读到有意思的段落，想先写下自己的理解，再和大家慢慢讨论。');
    await enterMemory(page, small);
    await manager(page).getByRole('button', { name: '查看记忆处理进度', exact: true }).click();
    let progress = manager(page).getByRole('region', { name: '记忆处理进度', exact: true });
    await expect(progress).toContainText('小肥鱼的来源整理');
    await expect.poll(() => progress.locator('[data-processing-kind="index"]').count()).toBeGreaterThan(0);
    await expect(progress).toContainText('小肥鱼把海边的约定收进今天的日记'); await expect(progress).not.toContainText('大肥鱼给旧书添了一枚银杏书签');
    const smallSnapshot = (await request(page, { type: 'memory.processing.status', companionId: small, limit: 30 })).memoryProcessing!;
    expect(smallSnapshot.jobs.some(job => job.noteId === smallNote.memory!.id)).toBe(true); expect(smallSnapshot.jobs.some(job => job.noteId === bigNote.memory!.id)).toBe(false);
    await progress.getByRole('button', { name: '关闭记忆处理进度', exact: true }).click();
    await expect(progress).toHaveCount(0);
    await manager(page).getByRole('combobox', { name: '记忆所属伙伴', exact: true }).selectOption(big);
    await manager(page).getByRole('button', { name: '查看记忆处理进度', exact: true }).click();
    progress = manager(page).getByRole('region', { name: '记忆处理进度', exact: true });
    await expect(progress).toContainText('大肥鱼的来源整理'); await expect(progress).toContainText('大肥鱼给旧书添了一枚银杏书签'); await expect(progress).not.toContainText('小肥鱼把海边的约定收进今天的日记');
    const processingShots = await captureWorkspace(page, launched.native, 'processing', progress);
    await progress.getByRole('button', { name: '关闭记忆处理进度', exact: true }).click();
    await navigation(page).getByRole('button', { name: '消息', exact: true }).click();
    await expectNavigation(page, 'messages'); await expect(manager(page)).toBeHidden();
    await page.getByRole('button', { name: '发起聊天', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: '发起聊天', exact: true });
    await chooser.locator('.companions-start-chat-list button').filter({ has: page.getByText('小肥鱼', { exact: true }) }).click();
    await expect(chooser).toHaveCount(0);
    const toggle = page.getByRole('button', { name: '我们之间', exact: true });
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    const planner = page.getByRole('complementary', { name: '伙伴手帐', exact: true }); await expect(planner).toContainText('小肥鱼的日常');
    await planner.getByRole('button', { name: '查看记忆处理进度', exact: true }).click();
    await expectNavigation(page, 'memory'); await expect(manager(page)).toBeVisible();
    await expect(manager(page).getByRole('combobox', { name: '记忆所属伙伴', exact: true })).toHaveValue(small);
    const chatProgress = manager(page).getByRole('region', { name: '记忆处理进度', exact: true });
    await expect(chatProgress).toBeVisible();
    await expect(page.getByRole('dialog', { name: '小肥鱼的记忆处理进度', exact: true })).toHaveCount(0);
    await expect(chatProgress).toContainText('小肥鱼把海边的约定收进今天的日记'); await expect(chatProgress).not.toContainText('大肥鱼给旧书添了一枚银杏书签');
    await navigation(page).getByRole('button', { name: '联系人', exact: true }).click();
    await expectNavigation(page, 'contacts'); await expect(manager(page)).toBeHidden();
    await expect(chatProgress).toHaveCount(0);
    await navigation(page).getByRole('button', { name: '打开伙伴记忆库', exact: true }).click();
    await expectNavigation(page, 'memory'); await expect(chatProgress).toBeVisible();
    await expect(chatProgress).toContainText('小肥鱼把海边的约定收进今天的日记');
    await chatProgress.getByRole('button', { name: '关闭记忆处理进度', exact: true }).click();
    await expect(chatProgress).toHaveCount(0);
    await navigation(page).getByRole('button', { name: '消息', exact: true }).click();
    await expectNavigation(page, 'messages'); await expect(manager(page)).toBeHidden();
    await expect(planner).toBeVisible();
    const chatShots = await captureWorkspace(page, launched.native, 'chat-side-panel', planner);
    const proof = { existingLibraryOpenedThroughNativeBoundary: true, libraryId: created.value.libraryId, ownerScopedProcessing: true, chatAndMemoryEntrances: true,
      smallOwnerJobNoteIds: smallSnapshot.jobs.map(job => job.noteId).filter(Boolean), smallNote: smallNote.memory!.id, bigNote: bigNote.memory!.id,
      chatProcessingRoutesToMemoryOwner: true, processingViewRestoresAfterTabSwitch: true,
      processingScreenshots: processingShots, chatScreenshots: chatShots };
    writeEvidence('processing-proof.json', proof); await testInfo.attach('memory-processing-visibility-proof', { body: JSON.stringify(proof), contentType: 'application/json' });
  } finally { await application?.close().catch(() => undefined); cleanup(root); }
});

async function launch(root: string) {
  const profile = path.join(root, 'profile');
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root }) });
  await preparePackagedCompanionLaunch(application, profile);
  const page = await application.firstWindow(), native = await application.browserWindow(page);
  await native.evaluate(win => { win.unmaximize(); win.setMinimumSize(480, 500); win.setContentSize(1440, 960); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page'); return { application, page, native };
}
async function workspace(page: Page, command: CompanionWorkspaceRequest) {
  const result = await page.evaluate(command => (window as unknown as Bridge).worldlinebox.companions.workspace!(command), command);
  expect(result.ok, result.error).toBe(true); return result;
}
async function request(page: Page, command: CompanionsRequest) {
  const result = await page.evaluate(command => (window as unknown as Bridge).worldlinebox.companions.request(command), command);
  expect(result.ok, result.error).toBe(true); return result;
}
async function createNote(page: Page, companionId: string, file: string, content: string) {
  const response = await workspace(page, { type: 'memory.documents.create', companionId, path: file, content, tags: [companionId], autoTags: false });
  expect(response.document?.memory).toBeDefined(); return response.document!;
}
async function enterMemory(page: Page, owner: string) {
  await page.locator('[data-application-module="companions"]').click();
  await page.getByRole('button', { name: '打开伙伴记忆库', exact: true }).click();
  await expectNavigation(page, 'memory'); await expect(manager(page)).toBeVisible(); await manager(page).getByRole('combobox', { name: '记忆所属伙伴', exact: true }).selectOption(owner);
}
async function expectNavigation(page: Page, current: 'messages' | 'contacts' | 'memory') {
  await expect(navigation(page)).toBeVisible();
  for (const [name, key] of [['消息', 'messages'], ['联系人', 'contacts'], ['打开伙伴记忆库', 'memory']] as const) {
    const button = navigation(page).getByRole('button', { name, exact: true });
    await expect(button).toBeVisible(); await expect(button).toHaveAttribute('aria-pressed', String(current === key));
    if (current === key) await expect(button).toHaveClass(/\bis-active\b/u); else await expect(button).not.toHaveClass(/\bis-active\b/u);
  }
  await expect(navigation(page).getByRole('button', { name: '打开伙伴世界', exact: true })).toBeVisible();
  await expect(navigation(page).getByRole('button', { name: '打开伙伴社交观察', exact: true })).toBeVisible();
}
async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.getByRole('button', { name: '设置', exact: true }).click(); const settings = page.getByRole('dialog', { name: '通用设置', exact: true });
  await settings.getByRole('tab', { name: '外观', exact: true }).click(); await settings.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
  await settings.getByRole('radio', { name: theme === 'light' ? '亮色' : '暗色', exact: true }).click(); await page.keyboard.press('Escape'); await expect(settings).toHaveCount(0); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}
async function captureWorkspace(page: Page, native: Awaited<ReturnType<ElectronApplication['browserWindow']>>, prefix: string, subject: Locator) {
  const screenshots: Array<{ theme: string; requestedWidth: number; innerWidth: number; devicePixelRatio: number; surface: string; horizontalOverflow: boolean; headingOverflow: boolean; headerButtonOverflow: boolean }> = [];
  const conditions = [['light', 1440], ['dark', 1440], ['light', 1040], ...(prefix === 'processing' ? [['light', 680]] : [])] as Array<['light' | 'dark', number]>;
  for (const [theme, width] of conditions) {
    await native.evaluate((win, width) => win.setContentSize(width, 960), width); await setTheme(page, theme); await expect(subject).toBeVisible();
    const processing = prefix === 'processing';
    const tasks = subject.getByRole('list', { name: '处理任务', exact: true }), detail = subject.getByRole('article', { name: '处理任务详情', exact: true });
    const panelWidth = await subject.evaluate(node => node.clientWidth);
    if (processing) {
      // The redesign uses compact filter rows and a selected task, never four
      // statistic cards. A narrow observer starts from the usable task list.
      await expect(subject.locator('.memory-processing-overview,[data-processing-count]')).toHaveCount(0);
      await expect(subject.getByRole('tablist', { name: '记忆处理状态筛选', exact: true }).getByRole('tab')).toHaveCount(4);
      const rules = subject.locator('details.memory-processing-rules');
      await expect(rules).toBeVisible(); expect(await rules.getAttribute('open')).toBeNull(); await expect(rules.locator('p')).toBeHidden();
      await rules.locator('summary').click(); await expect(rules.locator('p')).toBeVisible(); await expect(rules).toContainText('无需写日记');
      await expect(rules).not.toContainText('已经学会'); await rules.locator('summary').click(); await expect(rules.locator('p')).toBeHidden();
      if (panelWidth <= 1100 && await detail.isVisible()) await detail.getByRole('button', { name: '返回任务列表', exact: true }).click();
      await expect(tasks).toBeVisible();
      if (panelWidth > 1100) {
        await tasks.locator('button').first().click(); await expect(detail).toBeVisible();
        await expect(detail.getByRole('heading', { name: '处理时间', exact: true })).toBeVisible();
      } else await expect(detail).toBeHidden();
      if (panelWidth <= 700) {
        expect(await subject.locator('.memory-processing-navigation [role="tablist"]').evaluate(node => getComputedStyle(node).display)).toBe('flex');
        await expect(subject.locator('.memory-processing-section-label')).toBeHidden();
      }
    }
    const geometry = await subject.evaluate(node => {
      const boundary = node.getBoundingClientRect();
      const headings = [...node.querySelectorAll<HTMLElement>('.memory-library-paper h1')];
      const buttons = [...node.querySelectorAll<HTMLElement>('.memory-library-header button,.memory-library-document-toolbar button,.memory-processing-header button,.companions-planner > header button,.companion-memory-processing-summary,.companions-planner-current-actions button')].filter(button => button.getClientRects().length);
      // Include the subject's own planner controls while excluding scrollable
      // calendar/history content, where overflow is intentionally clipped.
      if (node.matches('.companions-planner')) buttons.push(...node.querySelectorAll<HTMLElement>(':scope > header button'));
      return { innerWidth, devicePixelRatio, surface: getComputedStyle(node).background,
        horizontalOverflow: node.scrollWidth > node.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1,
        headingOverflow: headings.some(heading => heading.scrollWidth > heading.clientWidth + 1),
        headerButtonOverflow: buttons.some(button => { const box = button.getBoundingClientRect(); return box.left < boundary.left - 1 || box.right > boundary.right + 1; }) };
    });
    expect(geometry.innerWidth).toBe(width); expect(geometry.horizontalOverflow).toBe(false); expect(geometry.headingOverflow).toBe(false); expect(geometry.headerButtonOverflow).toBe(false);
    await page.screenshot({ path: evidencePath(`${prefix}-${theme}-${geometry.innerWidth}.png`), animations: 'disabled' });
    screenshots.push({ theme, requestedWidth: width, ...geometry });
    if (processing && panelWidth <= 1100) {
      await tasks.locator('button').first().click(); await expect(detail).toBeVisible(); await expect(tasks).toBeHidden();
      await expect(detail.getByRole('heading', { name: '处理时间', exact: true })).toBeVisible();
      if (await detail.locator('.memory-processing-evidence').getAttribute('open') === null) await detail.locator('summary').filter({ hasText: '处理凭证' }).click();
      await expect(detail.getByText('任务编号', { exact: true })).toBeVisible();
      expect(await detail.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: evidencePath(`${prefix}-detail-${theme}-${geometry.innerWidth}.png`), animations: 'disabled' });
      await detail.getByRole('button', { name: '返回任务列表', exact: true }).click();
      await expect(tasks).toBeVisible(); await expect(detail).toBeHidden();
    }
  }
  expect(screenshots[0]!.surface).not.toBe(screenshots[1]!.surface);
  await native.evaluate(win => win.setContentSize(1440, 960)); await setTheme(page, 'light'); return screenshots;
}
function evidencePath(file: string) { const root = path.resolve('artifacts/vcp-validation/memory-ui-refresh'); mkdirSync(root, { recursive: true }); return path.join(root, file); }
function writeEvidence(file: string, value: unknown) { writeFileSync(evidencePath(file), JSON.stringify(value, null, 2), 'utf8'); }
function cleanup(root: string) { if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-memory-visibility-')) throw new Error('Unexpected visibility fixture cleanup target.'); removeCompanionTestDirectory(root); }
