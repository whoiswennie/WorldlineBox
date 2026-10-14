import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import type { CompanionMessage, CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import type { WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type CompanionBridgeWindow = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi } };
interface ProviderRequest {
  path: string; headers: IncomingHttpHeaders; model: string; companionId: string; latestUser: string;
  memories: unknown[]; reply: string;
}
interface ProviderFixture { baseUrl: string; requests: ProviderRequest[]; release(): void; close(): Promise<void> }

test('starts empty, bounds long history, searches with filters and context, and deletes or dissolves chats', async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-paging-'));
  const profile = path.join(root, 'profile'); let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile, false); application = started.application; let page = started.page;
    await page.locator('[data-application-module="companions"]').click();
    expect((await request(page, { type: 'state' })).state!.conversations).toHaveLength(0);
    await expect(page.locator('[data-companion-conversation]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '添加联系人', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '发起聊天', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: '发起聊天' });
    await chooser.locator('.companions-start-chat-list button').filter({ has: page.getByText('GPT', { exact: true }) }).click();
    await expect(chooser).toHaveCount(0); await expect(page.locator('[data-companion-conversation="private-gpt"]')).toBeVisible();
    expect(await messages(page, 'private-gpt')).toHaveLength(0);
    await expect(page.locator('[data-presence-trigger] .companion-avatar-presence')).toHaveAttribute('data-status', 'offline');
    await expect(page.locator('.companions-config-hint')).toHaveCount(0);
    await page.getByRole('button', { name: '查看伙伴状态', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '伙伴状态' })).toContainText('离线');
    await page.getByRole('button', { name: '关闭伙伴状态', exact: true }).click();
    await setGlobal(page, { apiFormat: 'openai_chat', baseUrl: 'https://example.invalid', model: 'presence-fixture', apiKey: 'fixture-presence-key' });
    await expect(page.locator('[data-presence-trigger] .companion-avatar-presence')).toHaveAttribute('data-status', 'ready');
    await application.close(); application = undefined;
    const script = `const db=new (require('better-sqlite3'))(process.argv[1]);
      db.function('companion_search_tokens',{deterministic:true},s=>Array.from(s.normalize('NFKC').toLowerCase(),c=>'u'+c.codePointAt(0).toString(16)).join(' '));
      db.function('companion_search_facet',{deterministic:true},s=>Array.from(s,c=>c.codePointAt(0).toString(16)).join('x'));
      const insert=db.prepare("INSERT INTO messages(id,conversation_id,author_id,kind,content,created_at,status) VALUES(?,'private-gpt',?,'text',?,?,'sent')");
      db.transaction(()=>{for(let i=1;i<=1800;i++)insert.run('history_'+i,i%2?'user':'gpt','历史编号 '+i+'：一起讨论小说、图片和生活。'+(i%10===0?' 星海合同':'')+' 这是一段足够长的聊天内容，验证连续滚动的阅读位置。',new Date(Date.UTC(2026,0,1)+Math.floor(i/50)*86400000).toISOString());})();db.close();`;
    const seeded = spawnSync(resolveElectronExecutablePath(), ['-e', script, path.join(profile, 'companions/messages.sqlite')], { cwd: process.cwd(), env: { ...electronLaunchEnv(), ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
    expect(seeded.status, seeded.stderr).toBe(0);
    started = await launch(profile, false); application = started.application; page = started.page;
    await page.locator('[data-application-module="companions"]').click(); await page.locator('[data-companion-conversation="private-gpt"]').click();
    const pane = page.locator('[data-companion-messages]'); await expect(pane).toHaveAttribute('data-window-count', '50');
    for (let turn = 0; turn < 18; turn++) {
      const first = await pane.locator('[data-companion-message]').first().getAttribute('data-companion-message');
      await pane.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
      await expect.poll(() => pane.locator('[data-companion-message]').first().getAttribute('data-companion-message')).not.toBe(first);
      expect(Number(await pane.getAttribute('data-window-count'))).toBeLessThanOrEqual(200);
    }
    await expect(page.getByRole('button', { name: '回到最新消息', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
    await expect(pane).toHaveAttribute('data-window-count', '50'); await expect(pane.locator('[data-companion-message="history_1800"]')).toBeVisible();
    await page.getByRole('button', { name: '搜索聊天记录', exact: true }).click();
    const search = page.getByRole('dialog', { name: '查找聊天记录' });
    await search.getByRole('textbox', { name: '搜索聊天内容' }).fill('合同');
    await expect(search.locator('[data-search-message]')).toHaveCount(30);
    await search.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(search.locator('footer')).toContainText('第 2 页'); await expect(search.locator('[data-search-message]')).toHaveCount(30);
    await search.getByLabel('搜索发送者', { exact: true }).selectOption('gpt');
    await search.getByLabel('开始日期', { exact: true }).fill('2026-01-02'); await search.getByLabel('结束日期', { exact: true }).fill('2026-01-03');
    await expect(search.locator('[data-search-message]')).toHaveCount(10);
    await expect(search.locator('mark').first()).toHaveText('合同');
    await expect(search.locator('time').first()).toHaveText(/2026-01-03 08:00:00\.000/);
    mkdirSync(path.resolve('artifacts/companions'), { recursive: true }); await page.screenshot({ path: path.resolve('artifacts/companions/verified-history-search.png') });
    const hit = await search.locator('[data-search-message]').first().getAttribute('data-search-message');
    await search.locator('[data-search-message]').first().click(); await expect(search).toHaveCount(0);
    await expect(pane.locator('[data-companion-message="' + hit + '"]')).toBeVisible();
    await expect(pane.locator('[data-companion-message="' + hit + '"]')).toHaveClass(/is-highlighted/);
    await expect(page.locator('.companions-history-banner')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '正在查看历史消息', exact: true })).toBeVisible();
    await expect(pane.locator('[data-companion-message="history_1800"]')).toHaveCount(0);
    const bubbleGeometry = await pane.locator('[data-companion-message="' + hit + '"]').evaluate(element => {
      const bubble = element.querySelector('.companions-message-bubble')!;
      return { rowBackground: getComputedStyle(element).backgroundColor, bubbleBackground: getComputedStyle(bubble).backgroundColor,
        bubbleWidth: bubble.getBoundingClientRect().width, rowWidth: element.getBoundingClientRect().width };
    });
    expect(bubbleGeometry.rowBackground).toBe('rgba(0, 0, 0, 0)'); expect(bubbleGeometry.bubbleBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(bubbleGeometry.bubbleWidth).toBeLessThan(bubbleGeometry.rowWidth * .8);
    await page.screenshot({ path: path.resolve('artifacts/companions/verified-history-context.png') });
    await page.getByRole('button', { name: '回到最新消息', exact: true }).click(); await expect(pane.locator('[data-companion-message="history_1800"]')).toBeVisible();
    await page.getByRole('button', { name: '删除聊天', exact: true }).click(); await page.getByRole('dialog', { name: '删除聊天' }).getByRole('button', { name: '删除聊天', exact: true }).click();
    await expect(page.locator('[data-companion-conversation]')).toHaveCount(0);
    await request(page, { type: 'conversation.open', companionId: 'gpt' }); await expect(page.locator('[data-companion-conversation="private-gpt"]')).toBeVisible();
    expect((await messages(page, 'private-gpt')).at(-1)?.id).toBe('history_1800');
    const group = (await request(page, { type: 'conversation.create-group', title: '', memberIds: ['gpt', 'kimi'] })).conversation!;
    await page.locator('[data-companion-conversation="' + group.id + '"]').click(); await page.getByRole('button', { name: '管理群聊', exact: true }).click();
    await page.getByRole('dialog', { name: '管理群聊' }).getByRole('button', { name: '解散群聊', exact: true }).click();
    await page.getByRole('dialog', { name: '管理群聊' }).getByRole('button', { name: '确认解散群聊', exact: true }).click();
    await expect(page.locator('[data-companion-conversation="' + group.id + '"]')).toHaveCount(0);
    const recreated = (await request(page, { type: 'conversation.create-group', title: '', memberIds: ['kimi', 'gpt'] })).conversation!;
    expect(recreated.id).not.toBe(group.id);
    await application.close(); application = undefined;
    started = await launch(profile, false); application = started.application;
    const final = (await request(started.page, { type: 'state' })).state!;
    expect(final.conversations.map(room => room.id)).not.toContain(group.id); expect(final.conversations.map(room => room.id)).toContain(recreated.id);
  } finally { if (application) await application.close(); cleanup(root); }
});

test('loads all migrated portraits, restores an edited contact and chats privately and in a mixed-role group', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-catalogue-'));
  const profile = path.join(root, 'profile'); const provider = await providerFixture();
  let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile); application = started.application; let page = started.page;
    await setGlobal(page, { apiFormat: 'openai_chat', baseUrl: provider.baseUrl, model: 'one-shared-fixture-model', apiKey: 'fixture-catalogue-key' });
    await page.locator('[data-application-module="companions"]').click();
    const state = (await request(page, { type: 'state' })).state!;
    expect(state.companions).toHaveLength(15);
    const additions = state.companions.filter(item => !item.id.startsWith('deepseek-'));
    expect(additions).toHaveLength(13);
    await page.getByRole('button', { name: '联系人', exact: true }).click();
    await expect(page.locator('[data-companion-contact]')).toHaveCount(15);
    await page.getByRole('button', { name: '添加联系人', exact: true }).click();
    const catalogue = page.getByRole('dialog', { name: '添加联系人', exact: true });
    await expect(catalogue.locator('[data-builtin-template]')).toHaveCount(15);
    const decoded = await catalogue.locator('.has-square-image').evaluateAll(async elements => Promise.all(elements.map(async element => {
      const url = getComputedStyle(element).backgroundImage.slice(5, -2);
      const image = new Image(); image.src = url; await image.decode();
      return image.naturalWidth > 0 && image.naturalHeight === image.naturalWidth;
    })));
    expect(decoded).toHaveLength(13); expect(decoded.every(Boolean)).toBe(true);
    await catalogue.getByRole('button', { name: '原创角色', exact: true }).click();
    await expect(catalogue.locator('[data-builtin-template]')).toHaveCount(2);
    mkdirSync(path.resolve('artifacts/companions'), { recursive: true });
    await page.screenshot({ path: path.resolve('artifacts/companions/verified-catalogue-originals.png') });
    await catalogue.getByRole('button', { name: '社区伙伴', exact: true }).click();
    await expect(catalogue.locator('[data-builtin-template]')).toHaveCount(5);
    await page.screenshot({ path: path.resolve('artifacts/companions/verified-catalogue-community.png') });
    await catalogue.getByRole('button', { name: '全部', exact: true }).click();
    await catalogue.getByRole('textbox', { name: '搜索内置角色', exact: true }).fill('白龙');
    await expect(catalogue.locator('[data-builtin-template]')).toHaveCount(1);
    await catalogue.locator('[data-builtin-template="gpt"]').getByRole('button').click();
    await expect(page.locator('.companions-chat-header h2')).toHaveText('GPT');
    for (const role of additions) {
      const source = await sendBridge(page, 'private-' + role.id, '迁移私聊验收：请回应这条消息。', [role.id]);
      const replies = (await messages(page, 'private-' + role.id)).filter(item => item.replyToId === source.id);
      expect(replies).toHaveLength(1); expect(replies[0]!.authorId).toBe(role.id); expect(replies[0]!.segments).toHaveLength(1);
    }
    const group = (await request(page, { type: 'conversation.create-group', title: '', memberIds: ['huan-white', 'gpt', 'doro'] })).conversation!;
    const groupSource = await sendBridge(page, group.id, '迁移群聊验收：每位伙伴各说一句。', group.memberIds);
    expect((await messages(page, group.id)).filter(item => item.replyToId === groupSource.id)).toHaveLength(3);
    expect(provider.requests.every(item => item.model === 'one-shared-fixture-model' && item.headers.authorization === 'Bearer fixture-catalogue-key')).toBe(true);
    const gpt = state.companions.find(item => item.id === 'gpt')!;
    await request(page, { type: 'companion.update', id: gpt.id, companion: { name: '小白龙', description: '我的白龙签名', persona: '用户编辑的白龙人设', avatar: gpt.avatar, model: '', proactive: false } });
    await request(page, { type: 'companion.delete', id: gpt.id });
    await application.close(); application = undefined;
    started = await launch(profile); application = started.application; page = started.page;
    expect((await request(page, { type: 'state' })).state!.companions.some(item => item.id === 'gpt')).toBe(false);
    const restored = (await request(page, { type: 'companion.add-builtin', templateId: 'gpt' })).companion!;
    expect(restored).toMatchObject({ id: 'gpt', name: '小白龙', description: '我的白龙签名', persona: '用户编辑的白龙人设' });
    expect((await messages(page, 'private-gpt')).filter(item => item.kind === 'notice')).toHaveLength(0);
    await page.locator('[data-application-module="companions"]').click();
    await page.getByRole('button', { name: '联系人', exact: true }).click();
    await page.locator('[data-companion-contact="gpt"]').click();
    await expect(page.locator('.companions-character-art img')).toBeVisible();
    await page.screenshot({ path: path.resolve('artifacts/companions/verified-catalogue-profile.png') });
  } finally { if (application) await application.close(); await provider.close(); cleanup(root); }
});
test('shows a durable FIFO inbox after the fifth private reply and resumes unstarted messages automatically', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-queue-'));
  const profile = path.join(root, 'profile');
  const provider = await providerFixture({ roleId: 'deepseek-flash', userText: '队列验收' });
  let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile); application = started.application;
    await started.page.evaluate(config => (window as unknown as CompanionBridgeWindow).worldlinebox.llm.setConfig(config),
      { apiFormat: 'openai_chat' as const, baseUrl: provider.baseUrl, model: 'fixture-queue', apiKey: 'fixture-queue-key' });
    await started.page.locator('[data-application-module="companions"]').click();
    await started.page.locator('[data-companion-conversation="private-deepseek-flash"]').click();
    const sources: string[] = [];
    for (let index = 0; index < 6; index++) sources.push((await request(started.page, { type: 'message.send', conversationId: 'private-deepseek-flash', content: '队列验收', clientId: randomUUID() })).message!.id);
    await expect.poll(() => provider.requests.length).toBe(5);
    await expect(started.page.getByRole('complementary', { name: '待发消息队列' })).toBeVisible();
    await expect(started.page.getByRole('button', { name: '消息模式' })).toHaveCount(0);
    await started.page.getByRole('button', { name: '立即引导', exact: true }).click();
    const chooser = started.page.getByRole('dialog', { name: '选择要引导的回复' });
    await expect(chooser).toBeVisible();
    await expect(chooser.locator('.companions-guide-target')).toHaveCount(5);
    await chooser.getByRole('button', { name: '关闭引导选择' }).click();
    await application.close(); application = undefined; provider.release();
    started = await launch(profile); application = started.application;
    await expect.poll(() => provider.requests.length).toBe(6);
    await expect.poll(async () => (await request(started.page, { type: 'messages', conversationId: 'private-deepseek-flash' })).messages
      ?.filter(message => message.authorId === 'deepseek-flash' && message.replyToId === sources[5] && message.content)).toHaveLength(1);
    const state = (await request(started.page, { type: 'state' })).state!;
    expect(state.queue?.filter(work => work.status === 'queued')).toHaveLength(0);
    expect(state.queue?.filter(work => work.status === 'interrupted')).toHaveLength(5);
  } finally { if (application) await application.close(); await provider.close(); cleanup(root); }
});
const richReply = ['## 格式示例', '', '**重点**与~~删除线~~，行内公式 $E=mc^2$。', '', '- [x] 已完成', '- [ ] 待办', '',
  '| 类型 | 状态 |', '| --- | :---: |', '| 代码 | 可复制 |', '', '~~~ts', 'const answer: number = 42;', '~~~', '',
  '$$', '\\int_0^1 x^2\\,dx = \\frac{1}{3}', '$$', '', '~~~mermaid', 'flowchart LR', ' A[需求] --> B[执行]', ' B --> C[结果]', '~~~',
  '', '[参考链接](https://example.test/reference)'].join('\n');

test('renders rich messages and diagrams, has no composer delivery-mode menu, and reuses a group with the same members', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-rich-'));
  const provider = await providerFixture(); let application: ElectronApplication | undefined;
  try {
    const started = await launch(path.join(root, 'profile')); application = started.application; const page = started.page;
    await setGlobal(page, { apiFormat: 'openai_chat', baseUrl: provider.baseUrl, model: 'fixture-global', apiKey: 'fixture-rich-test-key' });
    await page.locator('[data-application-module="companions"]').click();
    await sendUi(page, 'private-deepseek-sister', '格式验收', ['deepseek-sister']);
    await expect(page.locator('.companions-message-content .hljs-keyword')).toHaveCount(1);
    await expect(page.locator('.companions-message-content .katex-display')).toHaveCount(1);
    await expect(page.locator('.companions-diagram-svg svg')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.companions-diagram-svg')).toContainText('需求');
    await expect(page.locator('.companions-diagram-svg script, .companions-diagram-svg foreignObject')).toHaveCount(0);
    await expect(page.locator('.companions-delivery')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '消息模式' })).toHaveCount(0);
    const first = await request(page, { type: 'conversation.create-group', title: '', memberIds: ['deepseek-sister', 'deepseek-flash'] });
    expect(first.conversation?.title).toBe('我、大肥鱼和小肥鱼的群聊');
    const again = await request(page, { type: 'conversation.create-group', title: '另一个名字', memberIds: ['deepseek-flash', 'deepseek-sister'] });
    expect(again.conversation?.id).toBe(first.conversation?.id);
    expect((await request(page, { type: 'state' })).state?.conversations.filter(conversation => conversation.kind === 'group')).toHaveLength(1);
    await page.screenshot({ path: path.resolve('artifacts/companions/verified-rich-messages.png') });
  } finally { if (application) await application.close(); await provider.close(); cleanup(root); }
});

test('reopening recovers an unfinished group reply without repeating the speaker already committed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-recovery-')), profile = path.join(root, 'profile');
  const provider = await providerFixture({ roleId: 'deepseek-flash', userText: '恢复聊天验证' });
  let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile); application = started.application;
    await setGlobal(started.page, { apiFormat: 'openai_chat', baseUrl: provider.baseUrl, model: 'fixture-recovery', apiKey: 'fixture-recovery-key' });
    const group = (await request(started.page, { type: 'conversation.create-group', title: '', memberIds: ['deepseek-sister', 'deepseek-flash'] })).conversation!;
    await request(started.page, { type: 'message.send', conversationId: group.id, content: '恢复聊天验证', clientId: randomUUID(), delivery: 'chat' });
    await expect.poll(() => provider.requests.filter(item => item.latestUser === '恢复聊天验证').length).toBe(2);
    expect((await request(started.page, { type: 'messages', conversationId: group.id })).messages?.filter(message => message.authorId === 'deepseek-sister')).toHaveLength(1);
    await application.close(); application = undefined; provider.release();
    started = await launch(profile); application = started.application;
    await started.page.locator('[data-application-module="companions"]').click();
    await started.page.locator('[data-companion-conversation="' + group.id + '"]').click();
    await expect(started.page.getByRole('button', { name: '继续上次回复', exact: true })).toBeVisible();
    await started.page.getByRole('button', { name: '继续上次回复', exact: true }).click();
    await expect.poll(async () => (await request(started.page, { type: 'messages', conversationId: group.id })).messages?.filter(message => message.authorId === 'deepseek-flash').length).toBe(1);
    const messages = (await request(started.page, { type: 'messages', conversationId: group.id })).messages!;
    expect(messages.filter(message => message.authorId === 'deepseek-sister')).toHaveLength(1);
    expect(messages.filter(message => message.authorId === 'user')).toHaveLength(1);
    await expect(started.page.getByRole('button', { name: '继续上次回复', exact: true })).toHaveCount(0);
  } finally { if (application) await application.close(); await provider.close(); cleanup(root); }
});

test('task monitor pages durable role history and shows complete local timestamps', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-history-'));
  const profile = path.join(root, 'profile');
  let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile); application = started.application;
    const group = (await request(started.page, { type: 'conversation.create-group', memberIds: ['deepseek-sister', 'deepseek-flash'], title: '' })).conversation!;
    const source = (await request(started.page, { type: 'message.send', conversationId: group.id, content: '任务历史来源', clientId: randomUUID() })).message!;
    await application.close(); application = undefined;
    // Offline fixture: the app and its database owner are closed during seeding.
    const data = Array.from({ length: 45 }, (_, index) => {
      const created = Date.UTC(2026, 9, 13, 2, index, 5, 123);
      return { id: 'history-' + String(index).padStart(3, '0'), conversationId: group.id, companionId: index % 2 ? 'deepseek-flash' : 'deepseek-sister', sourceMessageId: source.id, title: '历史任务 ' + index, status: 'succeeded',
        createdAt: new Date(created).toISOString(), startedAt: new Date(created + 333).toISOString(), finishedAt: new Date(created + 2345).toISOString(), updatedAt: new Date(created + 2345).toISOString(),
        result: '已核验任务 ' + index, events: [{ sequence: 1, type: 'tool_end', summary: '工具实际返回结果', contentKind: 'output', content: '原始工具输出 ' + index, receivedAt: new Date(created + 1234).toISOString() }] };
    });
    const sourceCode = `const Database=require('better-sqlite3');const db=new Database(process.argv[1]);const data=JSON.parse(process.argv[2]);db.transaction(()=>{for(const row of data)db.prepare('INSERT INTO actions(id,conversation_id,companion_id,status,data) VALUES(?,?,?,?,?)').run(row.id,row.conversationId,row.companionId,row.status,JSON.stringify(row))})();db.close();`;
    const seeded = spawnSync(resolveElectronExecutablePath(), ['-e', sourceCode, path.join(profile, 'companions/messages.sqlite'), JSON.stringify(data)], { cwd: process.cwd(), env: { ...electronLaunchEnv(), ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
    expect(seeded.status, seeded.stderr).toBe(0);
    started = await launch(profile); application = started.application; const page = started.page;
    await page.locator('[data-application-module="companions"]').click();
    await page.locator('[data-companion-conversation="' + group.id + '"]').click();
    await page.getByRole('button', { name: '查看伙伴任务', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '伙伴实时任务' });
    const history = modal.getByRole('navigation', { name: '选择伙伴任务' });
    await expect(history.getByRole('button')).toHaveCount(20);
    await expect(history.getByRole('button').first()).toContainText('历史任务 44');
    await expect(history.locator('time').first()).toHaveAttribute('datetime', data[44]!.createdAt);
    await expect(history.locator('time').first()).toHaveText(/2026-10-13 \d{2}:44:05\.123/);
    await expect(modal.locator('.companions-task-times')).toContainText('结束时间');
    await expect(modal.locator('.companions-task-times')).toContainText('UTC+');
    await expect(modal.locator('.companions-live-output')).toContainText('原始工具输出 44');
    await modal.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(modal).toContainText('第 2 页');
    await expect(history.getByRole('button').first()).toContainText('历史任务 24');
    await modal.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(history.getByRole('button')).toHaveCount(5);
    await expect(modal).toContainText('共 45 条');
    await modal.getByLabel('按伙伴查看').selectOption('deepseek-flash');
    await expect(modal).toContainText('共 22 条');
    await expect(modal).toContainText('第 1 页');
    await expect(history).not.toContainText('大肥鱼');
    await modal.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(history.getByRole('button')).toHaveCount(2);
    await expect(modal.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
    await modal.getByLabel('按伙伴查看').selectOption('');
    await expect(history.getByRole('button')).toHaveCount(20);
    await page.screenshot({ path: path.resolve('artifacts/companions/verified-task-monitor.png') });
  } finally { if (application) await application.close(); cleanup(root); }
});

test('launcher persists the shared DSH access policy, defaulting every companion to full access', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-'));
  const profile = path.join(root, 'profile');
  let application: ElectronApplication | undefined;
  const access = (page: Page) => page.evaluate(async () => {
    const bridge = window as unknown as Window & { worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi } };
    const response = await bridge.worldlinebox.dshLauncher.request({ type: 'state' });
    return response.ok ? response.state?.taskAccess?.mode : undefined;
  });
  try {
    let started = await launch(profile); application = started.application;
    await started.page.getByRole('button', { name: '执行权限', exact: true }).click();
    await expect(started.page.getByRole('heading', { name: '执行权限', exact: true })).toBeVisible();
    expect(await access(started.page)).toBe('danger-full-access');
    await started.page.getByRole('radio', { name: /^工作区可写/ }).click();
    await expect.poll(() => access(started.page)).toBe('workspace-write');
    await application.close(); application = undefined;
    started = await launch(profile); application = started.application;
    expect(await access(started.page)).toBe('workspace-write');
    await started.page.getByRole('button', { name: '执行权限', exact: true }).click();
    await expect(started.page.getByRole('radio', { name: /^工作区可写/ })).toBeChecked();
    await started.page.getByRole('radio', { name: /^完全访问/ }).click();
    await expect.poll(() => access(started.page)).toBe('danger-full-access');
    await expect(started.page.getByRole('radio', { name: /^完全访问/ })).toBeChecked();
    await started.page.screenshot({ path: path.resolve('artifacts/companions/verified-execution-access.png') });
  } finally { if (application) await application.close(); cleanup(root); }
});

// This fixture replaces only the external provider. Every application call below
// uses the actual preload, Main IPC, storage UtilityProcess and SQLite database.
async function providerFixture(hold?: { roleId: string; userText: string }): Promise<ProviderFixture> {
  const requests: ProviderRequest[] = [];
  let released = false;
  const server: Server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      try {
        const payload = JSON.parse(body) as { model: string; messages: Array<{ role: string; content: string }> };
        const userContext = payload.messages.filter(message => message.role === 'user').at(-1)?.content;
        if (!userContext) throw new Error('Missing actual companion context.');
        const context = JSON.parse(userContext) as {
          conversation: { replyingAs: string }; messages: Array<{ speaker: string; content: string }>; memories: unknown[];
        };
        const latestUser = context.messages.filter(message => message.speaker === 'user').at(-1)?.content ?? '';
        const reply = latestUser === '格式验收' ? richReply : latestUser.includes('喜欢看海') ? '好呀，我记住你喜欢看海了。周末可以留些时间慢慢逛。'
          : `我收到了「${latestUser}」，我们接着聊。`;
        requests.push({ path: request.url ?? '', headers: request.headers, model: payload.model,
          companionId: context.conversation.replyingAs, latestUser, memories: context.memories, reply });
        if (!released && hold?.roleId === context.conversation.replyingAs && hold.userText === latestUser) return;
        const text = JSON.stringify({ text: reply, memories: latestUser.includes('喜欢看海') ? ['用户喜欢看海。'] : [], topic: '一起看海' });
        response.setHeader('Content-Type', 'application/json');
        if (request.url?.endsWith('/chat/completions')) {
          response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
        } else if (request.url?.endsWith('/messages')) {
          response.end(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }));
        } else {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'Unsupported fixture endpoint' }));
        }
      } catch {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: 'Invalid companion fixture request' }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider fixture has no local port.');
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests, release: () => { released = true; },
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}

async function launch(profilePath: string, openDefaultChats = true): Promise<{ application: ElectronApplication; page: Page }> {
  const appPath = resolveElectronAppPath();
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [appPath], cwd: appPath,
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profilePath }) });
  const page = await application.firstWindow();
  const nativeWindow = await application.browserWindow(page);
  await nativeWindow.evaluate(win => { win.unmaximize(); win.setSize(1440, 900); win.setFocusable(false); win.setOpacity(0); win.hide(); });
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
  if (openDefaultChats) for (const companionId of ['deepseek-sister', 'deepseek-flash']) await request(page, { type: 'conversation.open', companionId });
  return { application, page };
}

async function request(page: Page, input: CompanionsRequest) {
  const response = await page.evaluate(value => (window as unknown as CompanionBridgeWindow).worldlinebox.companions.request(value), input);
  expect(response.ok, response.error).toBe(true);
  return response;
}

async function setGlobal(page: Page, input: Parameters<WorldlineBoxLlmApi['setConfig']>[0]) {
  const result = await page.evaluate(value => (window as unknown as CompanionBridgeWindow).worldlinebox.llm.setConfig(value), input);
  expect(result.ok).toBe(true);
}

async function messages(page: Page, conversationId: string): Promise<CompanionMessage[]> {
  return (await request(page, { type: 'messages', conversationId, limit: 100 })).messages ?? [];
}

async function waitForReplies(page: Page, conversationId: string, authorIds: string[], afterSequence: number) {
  await expect.poll(async () => {
    const [response, state] = await Promise.all([
      request(page, { type: 'messages', conversationId, limit: 100 }), request(page, { type: 'state' }),
    ]);
    const replies = response.messages?.filter(message => message.sequence > afterSequence && message.kind === 'text' && message.status === 'sent') ?? [];
    return authorIds.every(id => replies.some(message => message.authorId === id))
      && !state.state?.activities.some(activity => activity.conversationId === conversationId);
  }, { timeout: 20_000 }).toBe(true);
}

async function sendUi(page: Page, conversationId: string, content: string, authors: string[]) {
  await page.locator(`[data-companion-conversation="${conversationId}"]`).click();
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible();
  const previousSequence = (await messages(page, conversationId)).at(-1)?.sequence ?? 0;
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(content);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await waitForReplies(page, conversationId, authors, previousSequence);
}

async function sendBridge(page: Page, conversationId: string, content: string, authors: string[]) {
  if (conversationId.startsWith('private-')) await request(page, { type: 'conversation.open', companionId: conversationId.slice(8) });
  const result = await request(page, { type: 'message.send', conversationId, content, clientId: randomUUID() });
  if (!result.message) throw new Error('Actual message send did not return a persisted message.');
  await waitForReplies(page, conversationId, authors, result.message.sequence);
  return result.message;
}

async function decodeLocalImage(page: Page, id: string) {
  const decoded = await page.evaluate(async attachmentId => {
    const image = new Image();
    image.src = `worldlinebox-companion://attachment/${attachmentId}`;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight, url: image.src };
  }, id);
  expect(decoded.width).toBeGreaterThan(0);
  expect(decoded.height).toBeGreaterThan(0);
  expect(decoded.url).toBe(`worldlinebox-companion://attachment/${id}`);
}

async function theme(page: Page, mode: '亮色' | '暗色') {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '通用设置', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: '外观', exact: true }).click();
  await dialog.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
  await dialog.getByRole('radio', { name: mode, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

function cleanup(root: string) {
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-companions-e2e-')) {
    throw new Error('Refusing cleanup outside this temporary companion profile.');
  }
  rmSync(absolute, { recursive: true, force: true });
}

test.describe.configure({ timeout: 120_000 });

test('real companion UI supports persistent contacts, private chats and multi-role group chat', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-ui-'));
  const profile = path.join(root, 'profile');
  const provider = await providerFixture();
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(profile);
    application = launched.application;
    let page = launched.page;
    expect(await page.locator('[data-application-module]').evaluateAll(elements => elements.map(element => element.getAttribute('data-application-module')))).toEqual(['dsh', 'companions', 'assets']);
    await setGlobal(page, { apiFormat: 'openai_chat', baseUrl: `${provider.baseUrl}/global/v1`, model: 'fixture-global', apiKey: 'fixture-global-ui-key' });
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('[data-companions]')).toBeVisible();
    await expect(page.getByRole('heading', { name: '消息', exact: true })).toBeVisible();
    await expect(page.locator('[data-companion-conversation]')).toHaveCount(2);
    const state = (await request(page, { type: 'state' })).state!;
    expect(state.configured).toBe(true);
    expect(state.companions.every(companion => !companion.llm && companion.model === '')).toBe(true);
    expect(await application.evaluate(({ app }) => app.getAppMetrics().some(metric => metric.type === 'Utility'
      && (metric.name === 'WorldlineBox Companion Storage' || metric.serviceName === 'WorldlineBox Companion Storage')))).toBe(true);

    const sisterChat = 'private-deepseek-sister';
    await sendUi(page, sisterChat, '我喜欢看海，周末想慢慢逛。', ['deepseek-sister']);
    await expect(page.locator('[data-companion-messages]').getByText('好呀，我记住你喜欢看海了。周末可以留些时间慢慢逛。', { exact: true })).toBeVisible();
    const learned = (await request(page, { type: 'memory.list', companionId: 'deepseek-sister' })).memories!;
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({ content: '我喜欢看海，周末想慢慢逛。', origin: 'user' });
    expect((await request(page, { type: 'memory.list', companionId: 'deepseek-flash' })).memories).toEqual([]);

    // Remove and re-add a built-in through the actual contact management flow.
    const flashBefore = (await messages(page, 'private-deepseek-flash')).map(message => message.id);
    await page.getByRole('button', { name: '联系人', exact: true }).click();
    await page.locator('[data-companion-contact="deepseek-flash"]').click();
    await page.getByRole('button', { name: '移除联系人', exact: true }).click();
    const remove = page.getByRole('dialog', { name: '移除联系人', exact: true });
    await remove.getByRole('button', { name: '移除联系人', exact: true }).click();
    await expect(remove).toHaveCount(0);
    await expect(page.locator('[data-companion-contact="deepseek-flash"]')).toHaveCount(0);
    await page.getByRole('button', { name: '添加联系人', exact: true }).click();
    const add = page.getByRole('dialog', { name: '添加联系人', exact: true });
    await add.locator('.companions-builtin-card').filter({ has: page.getByRole('heading', { name: '小肥鱼', exact: true }) }).getByRole('button', { name: '添加', exact: true }).click();
    await expect(add).toHaveCount(0);
    await expect(page.locator('[data-companion-contact="deepseek-flash"]')).toHaveCount(1);
    expect((await messages(page, 'private-deepseek-flash')).map(message => message.id)).toEqual(flashBefore);

    await page.getByRole('button', { name: '添加联系人', exact: true }).click();
    await add.getByRole('tab', { name: '自定义角色', exact: true }).click();
    await add.getByLabel('名字', { exact: true }).fill('海盐');
    await add.getByLabel('个性签名', { exact: true }).fill('一起把生活中的小事记下来');
    await add.getByLabel('人设', { exact: true }).fill('你是海盐，一位喜欢海边散步的伙伴。说话简短自然，尊重用户，记得共同经历。');
    const selectedImagePath = path.resolve('assets', 'companions', 'deepseek.jpg');
    expect(existsSync(selectedImagePath)).toBe(true);
    // Only the native file chooser is replaced. This temporary app still copies
    // the real image, registers it in SQLite and serves it through its protocol.
    await application.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
    }, selectedImagePath);
    await add.getByRole('button', { name: '选择本地头像', exact: true }).click();
    await expect(add.locator('.companions-avatar-editor .has-local-image')).toHaveCount(1);
    await expect(add.getByRole('combobox', { name: '伙伴 LLM 服务' })).toHaveValue('global');
    await add.getByRole('button', { name: '添加伙伴', exact: true }).click();
    await expect(add).toHaveCount(0);
    const afterCreate = (await request(page, { type: 'state' })).state!;
    const custom = afterCreate.companions.find(companion => companion.name === '海盐')!;
    expect(custom.builtin).toBe(false);
    expect(custom.llm).toBeUndefined();
    expect(custom.avatarAttachmentId).toBeTruthy();
    const avatarId = custom.avatarAttachmentId!;
    await decodeLocalImage(page, avatarId);
    expect(readFileSync(path.join(profile, 'companions', 'attachments', `${avatarId}.jpg`))).toEqual(readFileSync(selectedImagePath));
    await page.locator(`[data-companion-contact="${custom.id}"]`).click();
    await expect(page.locator('.companions-contact-profile .has-local-image')).toHaveCount(1);
    await page.getByRole('button', { name: '发消息', exact: true }).click();
    const customChat = `private-${custom.id}`;
    await sendUi(page, customChat, '海盐，今天认识你很开心。', [custom.id]);
    await page.getByRole('button', { name: '发送文件或图片', exact: true }).click();
    await expect(page.locator('.companions-draft-attachments')).toContainText('deepseek.jpg');
    await sendUi(page, customChat, '这张图片也发给你。', [custom.id]);
    const attachmentMessage = (await messages(page, customChat)).find(message => message.content === '这张图片也发给你。')!;
    expect(attachmentMessage.attachments).toHaveLength(1);
    const attachment = attachmentMessage.attachments[0]!;
    expect(attachment).toMatchObject({ name: 'deepseek.jpg', mime: 'image/jpeg', size: readFileSync(selectedImagePath).length,
      url: `worldlinebox-companion://attachment/${attachment.id}`, path: selectedImagePath });
    await expect(page.locator('.companions-attachment img')).toHaveAttribute('src', attachment.url!);
    await expect(page.locator('.companions-attachment img')).toBeVisible();
    await decodeLocalImage(page, attachment.id);
    const customHistory = await messages(page, customChat);

    await page.getByRole('button', { name: '创建群聊', exact: true }).click();
    const groupDialog = page.getByRole('dialog', { name: '创建群聊', exact: true });
    await groupDialog.getByLabel('群聊名称', { exact: true }).fill('蓝色海边');
    await expect(groupDialog.locator('.companions-member-picker input:checked')).toHaveCount(0);
    for (const name of ['大肥鱼', '小肥鱼', custom.name]) await groupDialog.getByLabel(name, { exact: true }).check();
    await expect(groupDialog.locator('.companions-member-picker input:checked')).toHaveCount(3);
    await groupDialog.getByRole('button', { name: '创建群聊', exact: true }).click();
    await expect(groupDialog).toHaveCount(0);
    const group = (await request(page, { type: 'state' })).state!.conversations.find(conversation => conversation.title === '蓝色海边')!;
    expect(group.memberIds).toEqual(expect.arrayContaining(['deepseek-sister', 'deepseek-flash', custom.id]));
    await sendUi(page, group.id, '大家好，我们周末一起聊聊海边的故事吧。', group.memberIds);
    const groupHistory = await messages(page, group.id);
    expect(groupHistory.filter(message => message.authorId !== 'user').map(message => message.authorId)).toEqual(group.memberIds);
    expect(provider.requests.filter(item => item.latestUser === '大家好，我们周末一起聊聊海边的故事吧。').every(item => item.memories.length === 0)).toBe(true);
    await expect(page.locator('.companions-chat-header h2')).toContainText('蓝色海边');
    await expect(page.locator('[data-companion-messages] .companions-message')).toHaveCount(4);

    const artifacts = path.resolve('artifacts', 'companions');
    mkdirSync(artifacts, { recursive: true });
    await theme(page, '亮色');
    await expect(page.locator('[data-application-module="companions"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'verified-messages-light.png') });
    await theme(page, '暗色');
    await expect(page.locator('.companions-chat-header h2')).toContainText('蓝色海边');
    await page.screenshot({ path: path.join(artifacts, 'verified-messages-dark.png') });
    await theme(page, '亮色');
    await page.getByRole('button', { name: '联系人', exact: true }).click();
    await page.locator('[data-companion-contact="deepseek-sister"]').click();
    await expect(page.getByRole('heading', { name: '联系人', exact: true })).toBeVisible();
    await expect(page.locator('.companions-contact-profile h2')).toHaveText('大肥鱼');
    await expect(page.locator('[data-companion-contact]')).toHaveCount(16);
    await page.screenshot({ path: path.join(artifacts, 'verified-contacts-light.png') });

    const requestCount = provider.requests.length;
    const sisterHistory = await messages(page, sisterChat);
    await application.close(); application = undefined;
    const databaseBytes = readFileSync(path.join(profile, 'companions', 'messages.sqlite'));
    expect(databaseBytes.subarray(0, 16).toString()).toBe('SQLite format 3\u0000');
    expect(databaseBytes.includes(Buffer.from(avatarId))).toBe(true);
    expect(databaseBytes.includes(Buffer.from(attachment.id))).toBe(true);
    const restarted = await launch(profile);
    application = restarted.application; page = restarted.page;
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('[data-companions]')).toBeVisible();
    const persisted = (await request(page, { type: 'state' })).state!;
    expect(persisted.companions.map(companion => companion.id)).toEqual(afterCreate.companions.map(companion => companion.id));
    expect(persisted.companions.find(companion => companion.id === custom.id)?.avatarAttachmentId).toBe(avatarId);
    expect(persisted.conversations.find(conversation => conversation.id === group.id)?.memberIds).toEqual(group.memberIds);
    expect(await messages(page, sisterChat)).toEqual(sisterHistory);
    expect(await messages(page, group.id)).toEqual(groupHistory);
    expect(await messages(page, customChat)).toEqual(customHistory);
    await decodeLocalImage(page, avatarId);
    await decodeLocalImage(page, attachment.id);
    await page.locator(`[data-companion-conversation="${customChat}"]`).click();
    await expect(page.locator('.companions-attachment img')).toHaveAttribute('src', attachment.url!);
    expect((await request(page, { type: 'memory.list', companionId: 'deepseek-sister' })).memories).toEqual(learned);
    // An observation interval verifies launch does not replay inference or sends.
    await page.waitForTimeout(750);
    expect(provider.requests).toHaveLength(requestCount);
  } finally {
    if (application) await application.close();
    await provider.close();
    cleanup(root);
  }
});

test('global routing updates immediately while an independent encrypted role connection stays unchanged', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-routing-'));
  const profile = path.join(root, 'profile');
  const provider = await providerFixture();
  const globalOne = 'fixture-global-one-secret';
  const globalTwo = 'fixture-global-two-secret';
  const roleKey = 'fixture-independent-role-secret';
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(profile);
    application = launched.application;
    const page = launched.page;
    await setGlobal(page, { apiFormat: 'openai_chat', baseUrl: `${provider.baseUrl}/global-a/v1`, model: 'global-one', apiKey: globalOne });
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('[data-companion-conversation]')).toHaveCount(2);
    await sendBridge(page, 'private-deepseek-sister', '第一组全局连接', ['deepseek-sister']);
    expect(provider.requests.at(-1)).toMatchObject({ path: '/global-a/v1/chat/completions', model: 'global-one', companionId: 'deepseek-sister' });
    expect(provider.requests.at(-1)?.headers.authorization).toBe(`Bearer ${globalOne}`);

    await page.getByRole('button', { name: '联系人', exact: true }).click();
    await page.getByRole('button', { name: '添加联系人', exact: true }).click();
    const add = page.getByRole('dialog', { name: '添加联系人', exact: true });
    await add.getByRole('tab', { name: '自定义角色', exact: true }).click();
    await add.getByLabel('名字', { exact: true }).fill('巡游者');
    await add.getByLabel('人设', { exact: true }).fill('你是巡游者，喜欢慢慢观察世界。自然聊天，尊重用户。');
    await add.getByRole('combobox', { name: '伙伴 LLM 服务' }).selectOption('independent');
    await add.getByRole('combobox', { name: '连接方式', exact: true }).selectOption('anthropic');
    await add.getByRole('textbox', { name: 'API URL', exact: true }).fill(`${provider.baseUrl}/independent/v1`);
    await add.getByLabel('API Key', { exact: true }).fill(roleKey);
    await add.getByRole('textbox', { name: '模型', exact: true }).fill('private-anthropic-model');
    await add.getByRole('button', { name: '添加伙伴', exact: true }).click();
    await expect(add).toHaveCount(0);
    const role = (await request(page, { type: 'state' })).state!.companions.find(companion => companion.name === '巡游者')!;
    expect(role.llm).toEqual({ apiFormat: 'anthropic', baseUrl: `${provider.baseUrl}/independent/v1`, model: 'private-anthropic-model', hasKey: true });
    const privateConversation = (await request(page, { type: 'conversation.open', companionId: role.id })).conversation!;
    await sendBridge(page, privateConversation.id, '独立连接第一条', [role.id]);
    expect(provider.requests.at(-1)).toMatchObject({ path: '/independent/v1/messages', model: 'private-anthropic-model', companionId: role.id });
    expect(provider.requests.at(-1)?.headers['x-api-key']).toBe(roleKey);
    expect(provider.requests.at(-1)?.headers.authorization).toBeUndefined();

    await setGlobal(page, { apiFormat: 'anthropic', baseUrl: `${provider.baseUrl}/global-b/v1`, model: 'global-two', apiKey: globalTwo });
    await sendBridge(page, 'private-deepseek-sister', '全局连接已更新', ['deepseek-sister']);
    expect(provider.requests.at(-1)).toMatchObject({ path: '/global-b/v1/messages', model: 'global-two', companionId: 'deepseek-sister' });
    expect(provider.requests.at(-1)?.headers['x-api-key']).toBe(globalTwo);
    await sendBridge(page, privateConversation.id, '独立连接保持原样', [role.id]);
    expect(provider.requests.at(-1)).toMatchObject({ path: '/independent/v1/messages', model: 'private-anthropic-model', companionId: role.id });
    expect(provider.requests.at(-1)?.headers['x-api-key']).toBe(roleKey);

    const publicState = await request(page, { type: 'state' });
    const history = await messages(page, privateConversation.id);
    const globalConfig = await page.evaluate(() => (window as unknown as CompanionBridgeWindow).worldlinebox.llm.getConfig());
    for (const key of [globalOne, globalTwo, roleKey]) {
      expect(JSON.stringify({ publicState, history, globalConfig })).not.toContain(key);
      const ciphertext = readFileSync(path.join(profile, 'companions', 'llm-keys.enc.json'), 'utf8');
      expect(ciphertext).not.toContain(key);
    }
    const encrypted = JSON.parse(readFileSync(path.join(profile, 'companions', 'llm-keys.enc.json'), 'utf8')) as Record<string, string>;
    expect(Object.keys(encrypted)).toEqual([role.id]);
    expect(Buffer.from(encrypted[role.id]!, 'base64').equals(Buffer.from(roleKey))).toBe(false);
    expect(await application.evaluate(({ safeStorage }, encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64')), encrypted[role.id]!)).toBe(roleKey);

    // The edit UI exposes the configured route but never fills the saved key.
    await page.locator(`[data-companion-contact="${role.id}"]`).click();
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑伙伴资料', exact: true });
    await expect(edit.getByLabel('API Key', { exact: true })).toHaveValue('');
    await edit.getByRole('button', { name: '取消', exact: true }).click();
    await application.close(); application = undefined;
    const files = ['companions/messages.sqlite', 'companions/messages.sqlite-wal', 'companions/llm-keys.enc.json', 'ai-config.json', 'ai-key.enc'];
    for (const relative of files) {
      const filename = path.join(profile, relative);
      if (!existsSync(filename)) continue;
      const bytes = readFileSync(filename);
      for (const key of [globalOne, globalTwo, roleKey]) expect(bytes.includes(Buffer.from(key))).toBe(false);
    }
  } finally {
    if (application) await application.close();
    await provider.close();
    cleanup(root);
  }
});
