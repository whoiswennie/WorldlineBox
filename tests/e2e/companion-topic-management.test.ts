import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import { electronLaunchEnv, ensureCompanionTestWorkspace, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';
import { closeTopicFixtureStorage, startTopicFixtureStorage, topicFixtureStorage } from './fixtures/companion-storage';

async function request(page: Page, input: CompanionsRequest) {
  const result = await page.evaluate(input => (window as unknown as { worldlinebox: { companions: WorldlineBoxCompanionsApi } }).worldlinebox.companions.request(input), input);
  if (!result.ok) throw Error(result.error); return result;
}
async function openRoom(page: Page, id: string) {
  const row = page.locator(`[data-companion-conversation="${id}"]`); await expect(row).toBeVisible(); await row.click(); await expect(row).toHaveClass(/is-selected/u);
}
async function createTopic(page: Page, title: string, kind: string, tags: string) {
  await library(page);
  await page.getByRole('button', { name: '新建话题', exact: true }).click(); const form = page.getByRole('form', { name: '新建聊天话题', exact: true });
  await form.getByRole('textbox', { name: '话题名称', exact: true }).fill(title);
  await form.getByRole('combobox', { name: '话题类型', exact: true }).selectOption(kind);
  await form.getByRole('textbox', { name: '话题标签', exact: true }).fill(tags);
  await form.getByRole('button', { name: '创建并进入', exact: true }).click();
  await expect(page.getByLabel('当前发送话题', { exact: true })).toContainText(title);
}
async function library(page: Page) {
  const section = page.getByRole('region', { name: '话题列表', exact: true }); if (!await section.isVisible()) await page.getByRole('button', { name: '话题管理', exact: true }).click();
  await expect(section).toBeVisible(); return section;
}
function topicRow(page: Page, title: string) { return page.locator('.companions-topic-library-list article').filter({ has: page.locator('strong', { hasText: new RegExp('^' + title + '$') }) }); }
async function topicAction(page: Page, title: string, name: string) {
  await library(page); const row = topicRow(page, title), action = row.getByRole('button', { name, exact: true });
  if (!await action.isVisible()) await row.locator('summary').click();
  await action.click();
}

test('keeps a compact header and accessible topic manager with distinct message and composer labels', async () => {
  test.setTimeout(150000);
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-topic-header-')), profile = path.join(root, 'profile');
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root }) });
  try {
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setContentSize(1440, 900); win.hide(); });
    await ensureCompanionTestWorkspace(page);
    const role = (await request(page, { type: 'state' })).state!.companions[0]!;
    await request(page, { type: 'companion.set-active', id: role.id, active: false });
    const room = (await request(page, { type: 'conversation.open', companionId: role.id })).conversation!;
    const topic = (await request(page, { type: 'topic.create', conversationId: room.id, title: '狼人杀：第一晚的线索与接下来的讨论', kind: 'game', participantIds: [], tags: ['游戏'] })).topic!;
    await request(page, { type: 'topic.activate', conversationId: room.id, topicId: topic.id });
    await request(page, { type: 'message.send', conversationId: room.id, topicId: topic.id, content: '先把已经公开的线索整理好。', clientId: 'header-visual-message' });
    await page.locator('[data-application-module="companions"]').click(); await openRoom(page, room.id);
    const entry = page.locator('.companions-chat-header').getByRole('button', { name: '话题管理', exact: true });
    await expect(entry).toBeVisible(); await expect(entry).toHaveClass('companion-icon-button');
    await expect(entry).toHaveText(''); await expect(entry).toHaveAttribute('title', '话题管理');
    await expect(entry.locator('svg')).toHaveAttribute('stroke-width', '1.6');
    await expect(entry.locator('i, span')).toHaveCount(0);
    await expect(page.locator('.companions-topic-bar')).toHaveCount(0);
    await expect(page.locator('.companions-dormant-note')).toHaveCount(0);
    const dormant = page.locator('section[aria-label="消息输入区"] .companions-composer-dormant');
    await expect(dormant).toContainText('伙伴休眠中');
    await expect(dormant.getByRole('button', { name: `激活${role.name}`, exact: true })).toBeVisible();
    await expect(page.locator('.companions-composer-destination')).toHaveCSS('font-size', '10px');
    await expect(page.locator('.companions-message-topic')).toHaveCSS('font-size', '10px');
    await library(page);
    const dialog = page.getByRole('dialog', { name: '话题管理', exact: true });
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('combobox', { name: '话题历史筛选', exact: true })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: '关闭话题管理', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: '话题管理', exact: true })).toBeFocused();
    const screenshots: string[] = [];
    for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [1040, 'light'], [1040, 'dark']] as const) {
      await native.evaluate((win, width) => win.setContentSize(width, 900), width);
      await page.getByRole('button', { name: '设置', exact: true }).click(); const settings = page.getByRole('dialog', { name: '通用设置', exact: true });
      await settings.getByRole('tab', { name: '外观', exact: true }).click(); await settings.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
      await settings.getByRole('radio', { name: theme === 'light' ? '亮色' : '暗色', exact: true }).click(); await page.keyboard.press('Escape');
      await expect(settings).toHaveCount(0);
      await page.mouse.move(0, 0);
      const style = await entry.evaluate(element => {
        const adjacent = element.parentElement!.querySelector('button[title="消息免打扰"]')!;
        const own = getComputedStyle(element), other = getComputedStyle(adjacent);
        return { own: { width: own.width, height: own.height, padding: own.padding, radius: own.borderRadius, color: own.color, background: own.backgroundColor },
          adjacent: { width: other.width, height: other.height, padding: other.padding, radius: other.borderRadius, color: other.color, background: other.backgroundColor } };
      });
      expect(style.own).toEqual(style.adjacent);
      const dormantLayout = await dormant.evaluate(element => {
        const label = element.querySelector('span')!.getBoundingClientRect(), button = element.querySelector('button')!.getBoundingClientRect();
        const composer = element.closest('section[aria-label="消息输入区"]')!.getBoundingClientRect(), bounds = element.getBoundingClientRect();
        return { gap: button.left - label.right, inside: bounds.top >= composer.top && bounds.bottom <= composer.bottom, width: bounds.width, contents: button.right - label.left };
      });
      expect(dormantLayout.inside).toBe(true); expect(dormantLayout.gap).toBeLessThanOrEqual(8);
      expect(dormantLayout.width).toBeLessThanOrEqual(dormantLayout.contents + 2);
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      const chatFile = `composer-dormant-${theme}-${width}.png`;
      await page.screenshot({ path: path.resolve('.tools/test-output', chatFile) }); screenshots.push(chatFile);
      await library(page); await expect(dialog.getByRole('button', { name: '新建话题', exact: true })).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const geometry = await dialog.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth })); expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
      const managerFile = `topic-manager-final-${theme}-${width}.png`;
      await page.screenshot({ path: path.resolve('.tools/test-output', managerFile) }); screenshots.push(managerFile);
      await page.keyboard.press('Escape');
    }
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('休眠时先留一条消息。');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await request(page, { type: 'messages', conversationId: room.id, topicId: topic.id })).messages?.some(message => message.content === '休眠时先留一条消息。')).toBe(true);
    expect((await request(page, { type: 'state' })).state?.companions.find(item => item.id === role.id)?.active).toBe(false);
    await dormant.getByRole('button', { name: `激活${role.name}`, exact: true }).click();
    await expect(dormant).toHaveCount(0);
    expect((await request(page, { type: 'state' })).state?.companions.find(item => item.id === role.id)?.active).toBe(true);
    await writeFile(path.resolve('.tools/test-output/companion-topic-header-visual.json'), JSON.stringify({ status: 'passed', actualMainAndRenderer: true, keyboardFocusTrapAndRestore: true, destinationAndMessageLabels: true, headerOnlyEntry: true, pureIconMatchesAdjacentHeaderButtons: true, dormantStatusInsideComposer: true, dormantCanSendWithoutActivation: true, explicitActivationWorks: true, screenshots }, null, 2));
  } finally { await application.close(); removeCompanionTestDirectory(root); }
});

test('real topic Main and renderer manage private/group invitations, separate reader destinations, history, paging and deletion', async () => {
  test.setTimeout(240000);
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-topic-ui-')), profile = path.join(root, 'profile');
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root }) });
  const renamed = '第一局推理复盘：线索核对与下一局安排', layouts: Array<Record<string, unknown>> = [];
  try {
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setSize(1440, 1060); win.hide(); });
    await ensureCompanionTestWorkspace(page);
    await expect.poll(async () => (await request(page, { type: 'state' })).state?.companions.length).toBeGreaterThan(0);
    const roles = (await request(page, { type: 'state' })).state!.companions;
    for (const role of roles) await request(page, { type: 'companion.set-active', id: role.id, active: false });
    const [a, b] = roles; const privateRoom = (await request(page, { type: 'conversation.open', companionId: a!.id })).conversation!;
    const group = (await request(page, { type: 'conversation.create-group', title: '真实话题接线验收', memberIds: [a!.id, b!.id] })).conversation!;
    const workspace = await page.evaluate(() => (window as unknown as { worldlinebox: { companions: WorldlineBoxCompanionsApi } }).worldlinebox.companions.workspace!({ type: 'status' }));
    await startTopicFixtureStorage(application, path.join(workspace.selected!.dataRoot, 'messages.sqlite'));
    const persisted = await topicFixtureStorage(application, { type: 'state' });
    expect(persisted.state?.conversations.map(room => room.id), 'Actual selected SQLite must contain the Main-created group').toContain(group.id);
    await page.locator('[data-application-module="companions"]').click();
    await openRoom(page, privateRoom.id); await createTopic(page, '私聊阅读计划', 'discussion', '阅读,私聊');
    const privateTopic = (await request(page, { type: 'topic.list', conversationId: privateRoom.id })).topics![0]!;
    expect(privateTopic.participantIds).toEqual(['user']); expect(privateTopic.invitedIds).toEqual([a!.id]);
    await openRoom(page, group.id); await createTopic(page, '第一局推理', 'game', '推理,验收');
    const game = (await request(page, { type: 'topic.list', conversationId: group.id })).topics![0]!;
    expect(game.invitedIds.sort()).toEqual([a!.id, b!.id].sort()); expect(game.participantIds).toEqual(['user']);
    await createTopic(page, '周末旅行', 'discussion', '旅行');
    const travel = (await request(page, { type: 'topic.list', conversationId: group.id })).topics!.find(topic => topic.title === '周末旅行')!;
    await topicFixtureStorage(application, { type: 'topic.join', conversationId: group.id, topicId: travel.id, readerId: a!.id });
    await topicAction(page, game.title, '进入话题');
    await expect(page.getByLabel('当前发送话题', { exact: true })).toContainText(game.title);
    expect((await request(page, { type: 'state' })).state!.conversations.find(room => room.id === group.id)?.activeTopicId).toBe(game.id);
    await topicFixtureStorage(application, { type: 'topic.update', conversationId: group.id, topicId: travel.id, readerId: a!.id, expectedRevision: (await request(page, { type: 'topic.read', conversationId: group.id, topicId: travel.id })).topic!.revision, patch: { workingState: { summary: 'PRIVATE_READER_STATE', sourceMessageIds: [] } } });
    expect((await request(page, { type: 'topic.read', conversationId: group.id, topicId: travel.id })).topicState?.workingState).toBeUndefined();
    await topicAction(page, travel.title, '查看记录');
    await expect(page.getByLabel('当前发送话题', { exact: true })).toContainText(game.title);
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('这句仍然属于推理局。'); await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await request(page, { type: 'messages', conversationId: group.id, topicId: game.id })).messages?.some(message => message.content === '这句仍然属于推理局。')).toBe(true);
    await library(page); await page.getByRole('button', { name: '暂停话题', exact: true }).click(); await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '恢复话题', exact: true }).click(); await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeEnabled();
    await topicAction(page, game.title, '编辑话题');
    const edit = page.getByRole('form', { name: '重命名话题', exact: true }); await edit.getByRole('textbox', { name: '新的话题名称', exact: true }).fill(renamed);
    await edit.getByRole('textbox', { name: '编辑话题标签', exact: true }).fill('推理,复盘'); await edit.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByLabel('当前发送话题', { exact: true })).toContainText(renamed);
    await topicAction(page, travel.title, '查看记录');
    await mkdir(path.resolve('.tools/test-output'), { recursive: true });
    for (const width of [1440, 1040]) for (const theme of ['light', 'dark'] as const) {
      if (await page.getByRole('dialog', { name: '话题管理', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭话题管理', exact: true }).click();
      await native.evaluate((win, width) => win.setContentSize(width, 1060), width);
      await page.getByRole('button', { name: '设置', exact: true }).click(); const settings = page.getByRole('dialog', { name: '通用设置', exact: true });
      await settings.getByRole('tab', { name: '外观', exact: true }).click(); await settings.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
      await settings.getByRole('radio', { name: theme === 'light' ? '亮色' : '暗色', exact: true }).click(); await page.keyboard.press('Escape');
      await expect(settings).toHaveCount(0); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('.companions-chat-header').getByRole('button', { name: '话题管理', exact: true })).toBeVisible();
      await expect(page.locator('.companions-topic-bar')).toHaveCount(0);
      await page.screenshot({ path: path.resolve('.tools/test-output', `topic-chat-${theme}-${width}.png`) });
      await library(page);
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      const geometry = await page.evaluate(() => ({ width: innerWidth, documentClientWidth: document.documentElement.clientWidth, documentScrollWidth: document.documentElement.scrollWidth,
        regions: ['.companions-topic-manager', '.companions-topic-library', '.companions-composer'].map(selector => { const node = document.querySelector<HTMLElement>(selector); return { selector, exists: !!node, clientWidth: node?.clientWidth, scrollWidth: node?.scrollWidth }; }),
        destination: document.querySelector('[aria-label="当前发送话题"]')?.textContent, history: document.querySelector<HTMLSelectElement>('[aria-label="话题历史筛选"]')?.selectedOptions[0]?.textContent }));
      expect(geometry.width).toBe(width); expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.documentClientWidth);
      for (const region of geometry.regions) { expect(region.exists).toBe(true); expect(region.scrollWidth!).toBeLessThanOrEqual(region.clientWidth!); }
      expect(geometry.destination).toContain(renamed); expect(geometry.history).toBe(travel.title);
      const file = `topic-ui-${theme}-${width}.png`; await page.screenshot({ path: path.resolve('.tools/test-output', file) }); layouts.push({ theme, file, ...geometry });
    }
    const ordinarySent = await request(page, { type: 'message.send', conversationId: group.id, topicId: null, content: '日常聊天：明天再核对出行时间。', clientId: 'topic-ui-ordinary-body' });
    expect(ordinarySent.message?.topicId ?? null).toBeNull();
    await page.getByRole('combobox', { name: '话题历史筛选', exact: true }).selectOption('all');
    await page.getByRole('button', { name: '关闭话题管理', exact: true }).click();
    const gameBody = page.locator('.companions-message').filter({ hasText: '这句仍然属于推理局。' });
    const ordinaryBody = page.locator('.companions-message').filter({ hasText: '日常聊天：明天再核对出行时间。' });
    await expect(gameBody).toBeVisible(); await expect(ordinaryBody).toBeVisible();
    await expect(gameBody.locator('.companions-message-topic')).toHaveText(renamed);
    await expect(ordinaryBody.locator('.companions-message-topic')).toHaveText('日常');
    await expect(page.getByLabel('当前发送话题', { exact: true })).toContainText(renamed);
    await page.screenshot({ path: path.resolve('.tools/test-output/topic-ui-message-badges-dark-1040.png') });
    const list = await library(page); await list.getByRole('textbox', { name: '按标签搜索话题', exact: true }).fill('复盘');
    await expect(topicRow(page, renamed)).toBeVisible(); await expect(topicRow(page, travel.title)).toHaveCount(0);
    await list.getByRole('textbox', { name: '按标签搜索话题', exact: true }).fill('');
    for (let i = 0; i < 52; i++) await topicFixtureStorage(application, { type: 'topic.create', conversationId: group.id, readerId: 'user', title: '分页档案 ' + String(i).padStart(2, '0'), kind: 'discussion', participantIds: [], tags: ['分页'] });
    await list.getByRole('textbox', { name: '按标签搜索话题', exact: true }).fill('分页');
    await expect(list.locator('article')).toHaveCount(50); await list.getByRole('button', { name: '读取更早的话题', exact: true }).click(); await expect(list.locator('article')).toHaveCount(52);
    await list.getByRole('textbox', { name: '搜索话题', exact: true }).fill('档案 00'); await expect(list.locator('article')).toHaveCount(1);
    await list.getByRole('textbox', { name: '搜索话题', exact: true }).fill(''); await list.getByRole('textbox', { name: '按标签搜索话题', exact: true }).fill('复盘');
    const row = topicRow(page, renamed); await expect(row).toBeVisible(); await topicAction(page, renamed, '删除'); await row.getByRole('button', { name: '确认删除话题', exact: true }).click(); await expect(row).toHaveCount(0);
    const ordinary = (await request(page, { type: 'messages', conversationId: group.id, topicId: null })).messages!;
    expect(ordinary.some(message => message.content === '这句仍然属于推理局。')).toBe(false);
    await expect(request(page, { type: 'messages', conversationId: group.id, topicId: game.id })).rejects.toThrow('话题已删除');
    await mkdir(path.resolve('.tools/test-output'), { recursive: true });
    await writeFile(path.resolve('.tools/test-output/companion-topic-ui-native.json'), JSON.stringify({ status: 'passed', mainOrRendererStorageMocked: false, modelRequestsConfigured: false,
      privateAndGroupCreate: true, hostSeededCompanionParticipation: true, distinctUserAndCompanionDestination: true, otherPrivateStateExcluded: true, historyDoesNotRetargetSend: true, pauseResume: true,
      renameAndTagSearch: true, headerOnlyTopicEntry: true, modalTopicManagement: true, actualPagedTopicCount: 52, deleteHidesOriginalBodyWithoutOrdinaryReclassification: true, actualMessageTopicBadges: true,
      messageBadgeScreenshot: 'topic-ui-message-badges-dark-1040.png', layouts }, null, 2));
  } finally { await closeTopicFixtureStorage(application); await application.close(); removeCompanionTestDirectory(root); }
});
