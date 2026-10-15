import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'vite';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { CompanionAction, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorkOrder } from '../../src/shared/companion-work-order';
import { THEME_PREF_KEY } from '../../src/renderer/theme/theme-preferences';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

interface SocialFixture { fixtureKind: string; virtualDay: string; previousDay: string; privateId: string; groupId: string; firstId: string; latestId: string; privateFact: string }
interface WorkFixture { fixtureKind: string; conversationId: string; actions: CompanionAction[]; orders: CompanionWorkOrder[]; other: CompanionAction }
function cleanup(root: string) { const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-social-observer-')) throw new Error('Unexpected social observation fixture cleanup.'); rmSync(resolved, { recursive: true, force: true }); }
async function fixture(root: string) {
  const nativeSqlite = createRequire(path.resolve('package.json')).resolve('better-sqlite3').replaceAll('\\', '/');
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { 'better-sqlite3': nativeSqlite } }, build: {
    outDir: path.join(root, 'seed'), emptyOutDir: true, lib: { entry: path.resolve('tests/e2e/fixtures/companion-observation-fixture.ts'), formats: ['cjs'], fileName: () => 'seed.cjs' },
    rollupOptions: { external: id => id === nativeSqlite || id.startsWith('node:') || builtinModules.includes(id) },
  } });
  return <T,>(mode: 'social' | 'actions') => {
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
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 900); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.hide(); });
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('[data-application-module="companions"]').click();
    await page.getByRole('button', { name: '打开伙伴社交观察', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '伙伴社交观察', exact: true }); await expect(dialog).toBeVisible();
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
    await dialog.locator('[data-social-conversation="' + social.groupId + '"]').click(); await dialog.getByRole('combobox', { name: '社交聊天观察视角' }).selectOption('gemini');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
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
