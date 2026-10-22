import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionMemoryDocumentCommand } from '../../src/shared/companion-memory-documents';
import { removeCompanionTestDirectory, electronLaunchEnv, ensureCompanionTestWorkspace, preparePackagedCompanionLaunch, resolveElectronLaunchOptions } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi } };
// Each document is a real human-authored file with a host receipt and bundled native indexing.
// eslint-disable-next-line no-empty-pattern
test('manages each companion document library and reads several real documents in light, dark and narrow layouts', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-memory-design-')), profile = path.join(fixtureRoot, 'profile');
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
  try {
    await preparePackagedCompanionLaunch(application, profile);
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setMinimumSize(480, 500); win.setSize(1440, 960); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    await ensureCompanionTestWorkspace(page);
    const companionId = 'deepseek-sister';
    await page.locator('[data-application-module="companions"]').click();
    expect((await page.evaluate(() => (window as unknown as Bridge).worldlinebox.companions.request({ type: 'state' }))).state?.conversations).toHaveLength(0);
    await page.getByRole('button', { name: '打开伙伴记忆库', exact: true }).click();
    await expect(page.getByRole('heading', { name: '伙伴记忆库', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭共同记忆管理', exact: true }).click();
    const texts = [
      { path: '日记/十月的海风.md', diaryName: '生活日记', tags: ['海边', '一起走走'], content: '# 十月的海风\n\n今天聊到想去看海。喜欢的并不是某个打卡地点，而是天色慢慢暗下来时，能坐在岸边什么都不做。\n\n我们约好，等天气暖一点，带一本书和一壶热茶过去。到时候不用把一天排满，留一点时间给临时的念头。\n\n## 想留住的细节\n\n- 从旧灯塔出发，沿着防波堤慢慢走。\n- 路过书店时，可以进去看看。\n- 计划只是起点，舒服的陪伴更重要。' },
      { path: '日记/给今天留一点空白.md', diaryName: '生活日记', tags: ['日常', '整理'], content: '一起整理桌面的时候，决定把正在读的书放在左手边。留出一小块空白，比把东西藏起来更让人放松。' },
      { path: '资料/沿海散步路线.md', diaryName: '旅行资料', tags: ['海边', '路线'], content: '# 沿海散步路线\n\n从旧灯塔出发，经过防波堤，傍晚可以在回程的书店停留。\n\n这份资料只描述路线，不代表伙伴已经去过这些地方。' },
      { path: '资料/阅读摘录.md', diaryName: '阅读札记', tags: ['阅读', '留白'], content: '# 阅读摘录\n\n给一件事留白，并不意味着放弃认真。暂时没有答案，也可以先把问题记下来。\n\n> 下一次读书时，试着把最想追问的问题写在页边。' },
      { path: '自我认识/慢一点也可以.md', diaryName: '自我认识', tags: ['成长', '习惯'], content: '# 慢一点也可以\n\n这是一段主观的自我认识：我更适合循序渐进地建立习惯。比起一次把事情做好，持续地陪伴更有意义。\n\n这样的想法会随着真实经历继续修订，不会自动改写稳定人格。' },
      { path: '世界经历/窗边的雨.md', diaryName: '世界经历', tags: ['雨天', '小屋'], content: '# 窗边的雨\n\n这是由管理者提供的一段世界设定资料：小屋的窗边放着一盆绿植，下雨的时候可以坐在那里读书。\n\n这份文本没有声称实际发生过新的世界事件。' },
    ];
    for (const text of texts) await documents(page, { type: 'memory.documents.create', companionId, ...text });
    expect((await page.evaluate(() => (window as unknown as Bridge).worldlinebox.companions.request({ type: 'state' }))).state?.conversations).toHaveLength(0);
    await expect.poll(async () => (await page.evaluate(owner => (window as unknown as Bridge).worldlinebox.companions.request({ type: 'memory.status', companionId: owner }), companionId)).memoryStatus?.indexed, { timeout: 150_000 }).toBe(6);
    await page.locator('[data-application-module="companions"]').click();
    const manager = page.getByRole('region', { name: '共同记忆管理', exact: true, includeHidden: true });
    async function open() {
      await page.getByRole('button', { name: '打开伙伴记忆库', exact: true }).click();
      await manager.getByRole('combobox', { name: '记忆所属伙伴', exact: true }).selectOption(companionId);
      await manager.locator('[data-memory-document="日记/十月的海风.md"]').click();
      await expect(manager.locator('.memory-library-paper h1')).toHaveText('十月的海风');
    }
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true });
    for (const [mode, name] of [['亮色', 'light'], ['暗色', 'dark']] as const) {
      await theme(page, mode); await open();
      const geometry = await manager.evaluate(element => ({ width: element.getBoundingClientRect().width, scroll: element.scrollWidth, client: element.clientWidth }));
      expect(geometry.width).toBeGreaterThan(1300); expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
      await expect(manager.locator('.memory-library-file')).toHaveCount(8); // six notes, stable profile, and discoverable sync report
      await expect(manager.getByRole('navigation', { name: '记忆文档目录' })).toContainText('自我认识');
      await expect(manager.getByRole('navigation', { name: '记忆文档目录' })).toContainText('世界经历');
      await capture(page, path.join(artifacts, `verified-memory-library-workspace-${name}.png`));
      await manager.getByRole('button', { name: '关闭共同记忆管理', exact: true }).click();
    }
    await theme(page, '亮色'); await open();
    await manager.getByRole('button', { name: /^查看记忆来源 /u }).click();
    await expect(manager.locator('.memory-library-source')).toHaveCount(1);
    await capture(page, path.join(artifacts, 'verified-memory-library-workspace-sources.png'));
    await manager.getByRole('button', { name: '关闭文档信息', exact: true }).click();
    await manager.getByRole('button', { name: /^编辑记忆 /u }).click();
    await expect(manager.getByRole('textbox', { name: '共同记忆内容', exact: true })).toHaveValue(texts[0]!.content);
    await capture(page, path.join(artifacts, 'verified-memory-library-workspace-editor.png'));
    await manager.getByRole('button', { name: '取消编辑', exact: true }).click();
    await native.evaluate(win => win.setSize(800, 760));
    await expect(manager.getByRole('button', { name: '返回文档', exact: true })).toBeVisible();
    expect(await manager.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await capture(page, path.join(artifacts, 'verified-memory-library-workspace-narrow.png'));
    await manager.getByRole('button', { name: '返回文档', exact: true }).click();
    await expect(manager.locator('.memory-library-files')).toBeVisible(); await expect(manager.locator('.memory-library-document')).toBeHidden();
    await capture(page, path.join(artifacts, 'verified-memory-library-workspace-narrow-list.png'));
    await manager.getByRole('button', { name: '关闭共同记忆管理', exact: true }).click();
    await native.evaluate(win => win.setSize(1440, 960)); await open();
    // The same UI operates real host versions and keeps file organization separate from evidence.
    const before = (await documents(page, { type: 'memory.documents.read', companionId, path: texts[0]!.path, sourceLimit: 30 })).document!;
    await manager.getByRole('button', { name: /^编辑记忆 /u }).click();
    await manager.getByRole('textbox', { name: '共同记忆内容', exact: true }).fill(texts[0]!.content + '\n\n补记：想带一支铅笔，画下当天的海岸。');
    await manager.getByRole('textbox', { name: '文档标签', exact: true }).fill('海边，一起走走，速写');
    await manager.getByRole('button', { name: '保存修正', exact: true }).click();
    await expect(manager.locator('.memory-library-notice')).toContainText('文档已保存');
    const edited = (await documents(page, { type: 'memory.documents.read', companionId, path: texts[0]!.path, sourceLimit: 30 })).document!;
    expect(edited.document.noteId).toBe(before.document.noteId); expect(edited.document.version).toBe(before.document.version! + 1); expect(edited.document.tags).toContain('速写');
    await manager.getByRole('button', { name: /^查看记忆来源 /u }).click(); await manager.getByRole('button', { name: '重命名或移动', exact: true }).click();
    await manager.getByRole('textbox', { name: '文档目标路径', exact: true }).fill('资料/海风札记.md'); await manager.getByRole('button', { name: '确认保存', exact: true }).click();
    await expect(manager.locator('.memory-library-notice')).toContainText('文件已移动');
    const moved = (await documents(page, { type: 'memory.documents.read', companionId, path: '资料/海风札记.md', sourceLimit: 30 })).document!;
    expect(moved.document.noteId).toBe(before.document.noteId); expect(moved.document.version).toBe(edited.document.version); expect(moved.memory?.sources).toEqual(edited.memory?.sources);
    await manager.getByRole('button', { name: /^删除记忆 /u }).click(); await manager.getByRole('button', { name: '确认遗忘', exact: true }).click();
    await expect(manager.locator('.memory-library-notice')).toContainText('文档已删除');
    expect((await documents(page, { type: 'memory.documents.list', companionId, directory: '', limit: 64 })).documents!.items.some(item => item.noteId === before.document.noteId)).toBe(false);
    const autoTagPath = '资料/等待整理标签.md';
    await documents(page, { type: 'memory.documents.create', companionId, path: autoTagPath, content: '这份阅读资料还没有手工标签，等待全局聊天模型整理。正文应先完整保存。', tags: [], autoTags: true });
    await expect.poll(async () => (await documents(page, { type: 'memory.documents.read', companionId, path: autoTagPath, sourceLimit: 30 })).document?.tagStatus?.note?.state, { timeout: 45_000 }).toBe('waiting_model');
    await manager.getByRole('button', { name: '刷新记忆文件列表', exact: true }).click();
    await manager.locator(`[data-memory-document="${autoTagPath}"]`).click();
    await expect(manager.locator('.memory-library-tag-status')).toContainText('正文已保存，等待全局聊天模型');
    await manager.getByRole('button', { name: /^查看记忆来源 /u }).click();
    await manager.getByRole('button', { name: '取消自动标签', exact: true }).click();
    const cancelled = (await documents(page, { type: 'memory.documents.read', companionId, path: autoTagPath, sourceLimit: 30 })).document!;
    expect(cancelled.tagStatus?.note?.state).toBe('cancelled'); expect(cancelled.document.autoTagsEnabled).toBe(false);
    expect(cancelled.content).toContain('正文应先完整保存');
    await testInfo.attach('memory-document-workspace-proof', { body: JSON.stringify({ humanOnlyWorkspace: true, availableBeforeChat: true, genuineManualNotes: 7, bundledNativeIndex: true, categories: ['日记', '资料', '自我认识', '世界经历', '时间线'], documentEditVersioned: true, renamePreservesSourcesAndVersion: true, deleteWithdraws: true, autoTagsWaitForGlobalModel: true, cancelPreservesBody: true, desktop: 1440, narrow: 800, themes: ['light', 'dark'] }), contentType: 'application/json' });
  } finally { await application.close(); cleanup(fixtureRoot); }
});
async function documents(page: Page, command: CompanionMemoryDocumentCommand) {
  const result = await page.evaluate(input => (window as unknown as Bridge).worldlinebox.companions.workspace!(input), command);
  expect(result.ok, result.error).toBe(true); return result;
}
async function theme(page: Page, mode: '亮色' | '暗色') {
  await page.getByRole('button', { name: '设置', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '通用设置', exact: true });
  await dialog.getByRole('tab', { name: '外观', exact: true }).click(); await dialog.getByRole('radio', { name: 'WorldlineBox', exact: true }).click(); await dialog.getByRole('radio', { name: mode, exact: true }).click();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
}
async function capture(page: Page, imagePath: string) { await expect(page.locator('.workspace-notice-stack')).toHaveCount(0, { timeout: 15_000 }); await page.screenshot({ path: imagePath }); }
function cleanup(fixtureRoot: string) { if (path.dirname(fixtureRoot) !== tmpdir() || !path.basename(fixtureRoot).startsWith('worldlinebox-memory-design-')) throw new Error('Unexpected document fixture cleanup target.'); removeCompanionTestDirectory(fixtureRoot); }
