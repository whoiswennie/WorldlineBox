import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'vite';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { CompanionAction, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorkOrder } from '../../src/shared/companion-work-order';
import { THEME_PREF_KEY } from '../../src/renderer/theme/theme-preferences';
import { removeCompanionTestDirectory, ensureCompanionTestWorkspace, electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

interface SocialFixture { fixtureKind: string; virtualDay: string; previousDay: string; privateId: string; groupId: string; firstId: string; latestId: string; privateFact: string }
interface WorkFixture { fixtureKind: string; conversationId: string; actions: CompanionAction[]; orders: CompanionWorkOrder[]; other: CompanionAction }
interface ScaleFixture { fixtureKind: string; relationshipCount: number }
function cleanup(root: string) { const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-social-observer-')) throw new Error('Unexpected social observation fixture cleanup.'); removeCompanionTestDirectory(resolved); }
async function fixture(root: string) {
  const nativeSqlite = createRequire(path.resolve('package.json')).resolve('better-sqlite3').replaceAll('\\', '/');
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { 'better-sqlite3': nativeSqlite } }, build: {
    outDir: path.join(root, 'seed'), emptyOutDir: true, lib: { entry: path.resolve('tests/e2e/fixtures/companion-observation-fixture.ts'), formats: ['cjs'], fileName: () => 'seed.cjs' },
    rollupOptions: { external: id => id === nativeSqlite || id.startsWith('node:') || builtinModules.includes(id) },
  } });
  return <T,>(mode: 'social' | 'actions' | 'social-scale') => {
    const output = path.join(root, mode + '.json');
    const seeded = spawnSync(resolveElectronExecutablePath(), [path.join(root, 'seed/seed.cjs'), path.join(root, 'profile'), mode, output], {
      cwd: process.cwd(), env: { ...electronLaunchEnv(), ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 30000,
    });
    expect(seeded.status, seeded.stderr).toBe(0); return JSON.parse(readFileSync(output, 'utf8')) as T;
  };
}

// This case validates the real read-only UI over synthetic durable records. It
// does not claim that fixture task states were executed, or that NPCs generated the seeded dialogue.
// eslint-disable-next-line no-empty-pattern
test('observes durable peer conversations by virtual date and keeps concurrent owner work compact and independently selectable', async ({}, testInfo) => {
  test.setTimeout(120000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-social-observer-'));
  let application: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    const seed = await fixture(root), social = seed<SocialFixture>('social');
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') }, { gpu: 'software' }) });
    const page = await application.firstWindow();
    await page.addInitScript(() => { Object.defineProperty(document, 'hidden', { get: () => false }); }); const native = await application.browserWindow(page);
    await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 900); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.hide(); });
    await ensureCompanionTestWorkspace(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('[data-application-module="companions"]').click();
    await page.getByRole('button', { name: '打开伙伴社交观察', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '伙伴社交观察', exact: true }); await expect(dialog).toBeVisible();
    // Hidden native window is a fixture detail; the observer is visible in the app under test.
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(dialog.locator('[data-social-center="deepseek-flash"]')).toBeVisible();
    await dialog.getByRole('combobox', { name: '社交图谱中心伙伴' }).selectOption('deepseek-sister');
    await expect(dialog.locator('[data-social-node="user"]')).toBeVisible();
    await expect(dialog.getByText('实时同步', { exact: true })).toBeVisible();
    await expect(dialog.locator('[data-social-event]').first()).toBeVisible();
    const letter = dialog.locator('[data-social-node="user"] .companion-avatar-letter');
    await expect(letter).toHaveText('我');
    const avatarCenter = await letter.evaluate(element => { const a = element.parentElement!.getBoundingClientRect(), b = element.getBoundingClientRect(); return { x: Math.abs(a.x + a.width / 2 - b.x - b.width / 2), y: Math.abs(a.y + a.height / 2 - b.y - b.height / 2) }; });
    expect(avatarCenter.x).toBeLessThanOrEqual(1); expect(avatarCenter.y).toBeLessThanOrEqual(1);
    await dialog.getByRole('button', { name: '放大社交图谱', exact: true }).click(); await expect(dialog.locator('.social-map-controls')).toContainText('110%');
    await dialog.getByRole('button', { name: '复位社交图谱', exact: true }).click(); await expect(dialog.locator('.social-map-controls')).toContainText('100%');
    const clockBefore = await dialog.locator('.social-live-clock').innerText();
    await expect.poll(async () => dialog.locator('.social-live-clock').innerText(), { timeout: 7000 }).not.toBe(clockBefore);
    const graphArtifacts = path.resolve('.tools/test-output/companions'); mkdirSync(graphArtifacts, { recursive: true });
    await page.screenshot({ path: path.join(graphArtifacts, 'verified-social-graph-live-light.png') });
    await native.evaluate(window => window.setSize(1000, 800));
    await page.screenshot({ path: path.join(graphArtifacts, 'verified-social-graph-live-compact.png') });
    const cardOverlap = await dialog.locator('.social-graph-person .companion-avatar, .social-ego').evaluateAll(elements => {
      const boxes = elements.map(element => element.getBoundingClientRect());
      return boxes.some((a, i) => boxes.some((b, j) => i !== j && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1));
    }); expect(cardOverlap).toBe(false);
    const graphBounds = await dialog.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight }));
    expect(graphBounds.scroll).toBeLessThanOrEqual(graphBounds.width + 1); expect(graphBounds.scrollHeight).toBeLessThanOrEqual(graphBounds.height + 1);
    await native.evaluate(window => window.setSize(1440, 900));
    await dialog.getByRole('tab', { name: '往来记录', exact: true }).click();
    await expect(dialog.getByLabel('社交记录日期', { exact: true })).toHaveValue(social.virtualDay);
    await expect(dialog.locator('[data-social-conversation]')).toHaveCount(20);
    await dialog.locator('[data-social-conversation="' + social.privateId + '"]').click();
    const messages = dialog.getByLabel('伙伴对话记录', { exact: true });
    await expect(messages.locator('[data-social-message]')).toHaveCount(50);
    await dialog.getByRole('combobox', { name: '社交聊天观察视角' }).selectOption('deepseek-sister');
    await expect(messages.locator('[data-social-author="deepseek-sister"]').first()).toHaveClass(/is-own/);
    await expect(messages.locator('[data-social-author="deepseek-flash"]').first()).not.toHaveClass(/is-own/);
    const portraitStyle = () => messages.locator('[data-social-author="deepseek-sister"] .companion-avatar').first().evaluate(element => {
      const style = getComputedStyle(element); return { size: style.backgroundSize, position: style.backgroundPosition, repeat: style.backgroundRepeat };
    });
    const ownPortrait = await portraitStyle(); expect(ownPortrait).toEqual({ size: 'cover', position: '50% 50%', repeat: 'no-repeat' });
    await dialog.getByRole('combobox', { name: '社交聊天观察视角' }).selectOption('deepseek-flash');
    await expect(messages.locator('[data-social-author="deepseek-flash"]').first()).toHaveClass(/is-own/);
    await expect(messages.locator('[data-social-author="deepseek-sister"]').first()).not.toHaveClass(/is-own/);
    expect(await portraitStyle()).toEqual(ownPortrait);
    await expect(dialog).not.toContainText(social.privateFact);
    await expect(dialog.getByRole('textbox', { name: '输入消息', exact: true })).toHaveCount(0);
    const firstPageIds = await messages.locator('[data-social-message]').evaluateAll(elements => elements.map(element => element.getAttribute('data-social-message')));
    await dialog.getByRole('button', { name: '更早的消息', exact: true }).click();
    await expect(messages.locator('[data-social-message="' + social.firstId + '"]')).toBeAttached();
    const olderIds = await messages.locator('[data-social-message]').evaluateAll(elements => elements.map(element => element.getAttribute('data-social-message')));
    expect(olderIds.some(id => firstPageIds.includes(id))).toBe(false);
    await dialog.getByRole('button', { name: '较新的消息', exact: true }).click();
    await expect(messages.locator('[data-social-message]')).toHaveCount(50);
    await dialog.getByRole('button', { name: '查看引用消息 ' + social.firstId, exact: true }).click();
    await expect(messages.locator('[data-social-message="' + social.firstId + '"]')).toBeAttached();
    await expect(dialog.getByLabel('社交记录日期', { exact: true })).toHaveValue(social.virtualDay);
    await dialog.locator('[data-social-conversation="' + social.groupId + '"]').click();
    await dialog.locator('[data-social-conversation="' + social.privateId + '"]').click();
    await expect(messages.locator('[data-social-message]')).toHaveCount(50);
    await dialog.getByRole('searchbox', { name: '在伙伴对话中查找', exact: true }).fill('风铃');
    await expect(messages.locator('[data-social-message]')).toHaveCount(1); await expect(messages).toContainText('风铃主题');
    await dialog.getByRole('searchbox', { name: '在伙伴对话中查找', exact: true }).clear();
    await expect(messages.locator('[data-social-message]')).toHaveCount(50);
    const conversationPage = dialog.locator('.companions-social-pagination');
    await conversationPage.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(dialog.locator('[data-social-conversation]')).toHaveCount(4);
    await conversationPage.getByRole('button', { name: '上一页', exact: true }).click();
    await expect(dialog.locator('[data-social-conversation]')).toHaveCount(20);
    await dialog.getByLabel('社交记录日期', { exact: true }).fill(social.previousDay);
    await expect(dialog.locator('[data-social-conversation]')).toHaveCount(1); await expect(dialog).toContainText('昨天的读书话题');
    await dialog.getByRole('button', { name: '今天', exact: true }).click();
    await expect(dialog.locator('[data-social-conversation]')).toHaveCount(20);
    await dialog.getByRole('searchbox', { name: '搜索伙伴社交记录', exact: true }).fill('风铃');
    await expect(dialog.locator('[data-social-conversation]')).toHaveCount(1); await expect(dialog).toContainText('海边散步与音乐');
    await dialog.getByRole('searchbox', { name: '搜索伙伴社交记录', exact: true }).clear();
    await expect(dialog.locator('[data-social-conversation]')).toHaveCount(20);
    await dialog.locator('[data-social-conversation="' + social.groupId + '"]').click();
    await expect(messages.locator('[data-social-message]')).toHaveCount(4);
    await expect(dialog.getByRole('combobox', { name: '社交聊天观察视角' }).locator('option')).toHaveCount(3);
    await dialog.getByRole('combobox', { name: '社交聊天观察视角' }).selectOption('gemini');
    await expect(messages.locator('[data-social-author="gemini"]')).toHaveClass(/is-own/);
    expect(await messages.locator('[data-social-author="gemini"] .companion-avatar').evaluate(element => {
      const style = getComputedStyle(element); return { size: style.backgroundSize, position: style.backgroundPosition };
    })).toEqual({ size: 'cover', position: '50% 50%' });
    const dimensions = await dialog.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1); expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 1);
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true });
    const lightBackground = await dialog.evaluate(element => getComputedStyle(element).backgroundColor);
    await page.screenshot({ path: path.join(artifacts, 'verified-companion-social-light.png') });
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 1, theme: 'dark' })), THEME_PREF_KEY);
    await page.reload(); await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '打开伙伴社交观察', exact: true }).click();
    await dialog.getByRole('tab', { name: '往来记录', exact: true }).click(); await dialog.locator('[data-social-conversation="' + social.groupId + '"]').click(); await dialog.getByRole('combobox', { name: '社交聊天观察视角' }).selectOption('gemini');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await dialog.getByRole('tab', { name: '实时图谱', exact: true }).click(); await dialog.getByRole('combobox', { name: '社交图谱中心伙伴' }).selectOption('deepseek-sister'); await expect(dialog.locator('[data-social-node="user"]')).toBeVisible(); await page.screenshot({ path: path.join(artifacts, 'verified-social-graph-live-dark.png') }); await dialog.getByRole('tab', { name: '往来记录', exact: true }).click();
    expect(await dialog.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(lightBackground);
    await page.screenshot({ path: path.join(artifacts, 'verified-companion-social-dark.png') });
    await dialog.getByRole('button', { name: '关闭社交观察', exact: true }).click();
    // The extra SQLite connection exists only for this disposable UI fixture;
    // the transaction is closed before the production UI queries these records.
    const work = seed<WorkFixture>('actions'); expect(work.fixtureKind).toBe('synthetic_action_fixture');
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 1, theme: 'light' })), THEME_PREF_KEY);
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    await page.locator('[data-companion-conversation="' + work.conversationId + '"]').click();
    if (await page.getByRole('button', { name: '我们之间', exact: true }).getAttribute('aria-expanded') !== 'true') await page.getByRole('button', { name: '我们之间', exact: true }).click();
    const planner = page.getByRole('complementary', { name: '伙伴手帐', exact: true });
    await planner.getByRole('combobox', { name: '待办所属伙伴' }).selectOption('deepseek-sister');
    const overview = planner.getByRole('region', { name: '伙伴工作概览', exact: true });
    await expect(overview.locator('[data-work-preview]')).toHaveCount(2);
    await expect(overview.locator('[data-work-phase="running"] strong')).toHaveText('5');
    await expect(overview.locator('[data-work-phase="waiting"] strong')).toHaveText('0');
    await expect(overview.locator('[data-work-phase="paused"] strong')).toHaveText('1');
    await expect(overview).toContainText('另有 4 件');
    await expect(overview).not.toContainText(work.other.title); await expect(overview).not.toContainText('已经完成的小安排');
    expect((await overview.boundingBox())!.height).toBeLessThan(240);
    await page.screenshot({ path: path.join(artifacts, 'verified-companion-work-overview.png') });
    const selectedOrder = work.orders.find(order => order.actionId === work.actions[4]!.id)!;
    await overview.locator('[data-work-preview="' + selectedOrder.id + '"]').click();
    const workbench = page.getByRole('dialog', { name: '伙伴工作台', exact: true });
    await expect(workbench).toContainText('确认导出的位置');
    await workbench.getByRole('button', { name: '查看执行过程', exact: true }).click();
    const monitor = page.getByRole('dialog', { name: '伙伴实时任务', exact: true });
    await expect(monitor.getByRole('combobox', { name: '按伙伴查看', exact: true })).toHaveValue('deepseek-sister');
    await expect(monitor.getByRole('navigation', { name: '选择伙伴任务' }).getByRole('button')).toHaveCount(6);
    await expect(monitor).toContainText('确认导出的位置');
    await monitor.getByRole('combobox', { name: '按伙伴查看', exact: true }).selectOption('deepseek-flash');
    await expect(monitor.getByRole('navigation', { name: '选择伙伴任务' }).getByRole('button')).toHaveCount(1);
    await monitor.getByRole('navigation', { name: '选择伙伴任务' }).getByRole('button').click(); await expect(monitor).toContainText(work.other.title);
    const state = await page.evaluate(() => (window as unknown as { worldlinebox: { companions: WorldlineBoxCompanionsApi } }).worldlinebox.companions.request({ type: 'state' }));
    expect(state.state!.queue ?? []).toEqual([]); expect(errors).toEqual([]);
    const report = { fixtureKind: work.fixtureKind, peerRecordFixture: social.fixtureKind, virtualDay: social.virtualDay, privatePages: [firstPageIds.length, olderIds.length], actions: work.actions.map(action => ({ id: action.id, owner: action.companionId, status: action.status })), errors };
    writeFileSync(path.join(artifacts, 'verified-companion-social-observation.json'), JSON.stringify(report, null, 2));
    await testInfo.attach('read-only-observation-fixture', { body: JSON.stringify(report), contentType: 'application/json' });
  } finally { await application?.close().catch(() => undefined); cleanup(root); }
});
// eslint-disable-next-line no-empty-pattern
test('explores 20,000 real stored relationships through aggregates, bounded pages and exact search', async ({}) => {
  test.setTimeout(120000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-social-observer-'));
  let application: ElectronApplication | undefined;
  try {
    const seed = await fixture(root), data = seed<ScaleFixture>('social-scale');
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') }, { gpu: 'software' }) });
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 900); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.hide(); });
    await ensureCompanionTestWorkspace(page);
    await page.locator('[data-application-module="companions"]').click();
    await page.getByRole('button', { name: '打开伙伴社交观察', exact: true }).click();
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    const dialog = page.getByRole('dialog', { name: '伙伴社交观察', exact: true });
    await dialog.getByRole('combobox', { name: '社交图谱中心伙伴' }).selectOption('deepseek-flash');
    const diagnostic = await page.evaluate(async () => { const start = performance.now(), result = await (window as unknown as { worldlinebox: { companions: WorldlineBoxCompanionsApi } }).worldlinebox.companions.request({ type: 'social.graph', companionId: 'deepseek-flash' }); return { ok: result.ok, error: result.error, total: result.socialGraph?.total, elapsedMs: Math.round(performance.now() - start) }; });
    writeFileSync(path.resolve('.tools/social-large-diagnostic.json'), JSON.stringify(diagnostic));
    expect(diagnostic.error).toBeUndefined();
    await expect(dialog.locator('.social-map-metrics').first()).toContainText(data.relationshipCount.toLocaleString(), { timeout: 15000 });
    await expect(dialog.locator('[data-social-cluster="dormant"]')).toBeVisible();
    await expect(dialog.locator('[data-social-node]')).toHaveCount(0);
    await expect(dialog.getByText('这条实际来信来自当前画布之外的关系对象。', { exact: true })).toBeVisible();
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'verified-social-graph-large-overview.png') });
    await dialog.locator('[data-social-cluster="dormant"]').click();
    await expect.poll(() => dialog.locator('[data-social-node]').count(), { timeout: 15000 }).toBeGreaterThan(0);
    expect(await dialog.locator('[data-social-node]').count()).toBeLessThanOrEqual(40);
    const firstIds = await dialog.locator('[data-social-node]').evaluateAll(elements => elements.map(element => element.getAttribute('data-social-node')));
    await dialog.locator('.social-explorer-pagination').getByRole('button', { name: '下一批', exact: true }).click();
    await expect.poll(async () => dialog.locator('[data-social-node]').first().getAttribute('data-social-node'), { timeout: 15000 }).not.toBe(firstIds[0]);
    const nextIds = await dialog.locator('[data-social-node]').evaluateAll(elements => elements.map(element => element.getAttribute('data-social-node')));
    expect(nextIds.length).toBe(firstIds.length); expect(nextIds.some(id => firstIds.includes(id))).toBe(false);
    await page.screenshot({ path: path.join(artifacts, 'verified-social-graph-large-neighborhood.png') });
    await dialog.getByRole('searchbox', { name: '搜索全部社交关系', exact: true }).fill('scale_19999');
    await expect(dialog.locator('[data-social-node]')).toHaveCount(1, { timeout: 15000 });
    await expect(dialog.locator('[data-social-result="scale_19999"]')).toBeVisible();
    await dialog.getByRole('button', { name: '收起关系目录', exact: true }).click();
    await dialog.locator('[data-social-node="scale_19999"]').click();
    await dialog.getByRole('button', { name: '以她为中心', exact: true }).click();
    await expect(dialog.locator('[data-social-center="scale_19999"]')).toBeVisible();
    await expect(dialog.locator('[data-social-node="deepseek-flash"]')).toBeVisible();
    await dialog.getByRole('button', { name: '返回上一中心', exact: true }).click();
    await expect(dialog.locator('[data-social-cluster="dormant"]')).toBeVisible();
    const before = await dialog.locator('.social-live-clock').innerText();
    await expect.poll(async () => dialog.locator('.social-live-clock').innerText(), { timeout: 10000 }).not.toBe(before);
    const steady = await page.evaluate(async () => { const start = performance.now(); const result = await (window as unknown as { worldlinebox: { companions: WorldlineBoxCompanionsApi } }).worldlinebox.companions.request({ type: 'social.graph', companionId: 'deepseek-flash' }); return { ok: result.ok, total: result.socialGraph?.total, elapsedMs: Math.round(performance.now() - start) }; });
    writeFileSync(path.resolve('.tools/social-large-diagnostic.json'), JSON.stringify({ initial: diagnostic, steady }));
    expect(steady.ok).toBe(true);
    expect(await dialog.locator('option').count()).toBeLessThan(100);
  } finally { await application?.close(); cleanup(root); }
});
