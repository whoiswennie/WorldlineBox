import { builtinModules, createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'vite';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorkOrder } from '../../src/shared/companion-work-order';
import { THEME_PREF_KEY } from '../../src/renderer/theme/theme-preferences';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

async function request(page: Page, input: CompanionsRequest) { const result = await page.evaluate(value => (window as unknown as { worldlinebox: { companions: WorldlineBoxCompanionsApi } }).worldlinebox.companions.request(value), input); expect(result.ok, result.error).toBe(true); return result; }
function cleanup(root: string) { const absolute = path.resolve(root); if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-social-observer-')) throw new Error('Unexpected work-life fixture cleanup.'); rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }

// Uses real SQLite records and UI commands; fixture work is paused and is not execution evidence.
// eslint-disable-next-line no-empty-pattern
test('manages real work orders separately from daily life windows in light and dark themes', async ({}, testInfo) => {
  test.setTimeout(120000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-social-observer-')), profile = path.join(root, 'profile');
  let application: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    const nativeSqlite = createRequire(path.resolve('package.json')).resolve('better-sqlite3').replaceAll('\\', '/');
    await build({ configFile: false, logLevel: 'silent', resolve: { alias: { 'better-sqlite3': nativeSqlite } }, build: { outDir: path.join(root, 'seed'), emptyOutDir: true, lib: { entry: path.resolve('tests/e2e/fixtures/companion-observation-fixture.ts'), formats: ['cjs'], fileName: () => 'seed.cjs' }, rollupOptions: { external: id => id === nativeSqlite || id.startsWith('node:') || builtinModules.includes(id) } } });
    const output = path.join(root, 'fixture.json'), seeded = spawnSync(resolveElectronExecutablePath(), [path.join(root, 'seed/seed.cjs'), profile, 'work-life', output], { cwd: process.cwd(), env: { ...electronLaunchEnv(), ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    expect(seeded.status, seeded.stderr).toBe(0);
    const data = JSON.parse(readFileSync(output, 'utf8')) as { fixtureKind: string; companionId: string; conversationId: string; order: CompanionWorkOrder };
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'software' }) });
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 960); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.hide(); });
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('[data-application-module="companions"]').click(); await page.locator('[data-companion-conversation="' + data.conversationId + '"]').click();
    await page.getByRole('button', { name: '我们之间', exact: true }).click();
    const planner = page.getByRole('complementary', { name: '伙伴手帐', exact: true });
    await expect(planner.locator('[data-work-preview]')).toHaveCount(1); await expect(planner.getByLabel('工作数量')).toContainText('1已暂停');
    await planner.getByRole('button', { name: '查看全部伙伴工作', exact: true }).click();
    const work = page.getByRole('dialog', { name: '伙伴工作台', exact: true }); await expect(work).toBeVisible(); await expect(work).toContainText(data.order.instruction);
    await work.getByRole('button', { name: '修改要求', exact: true }).click(); await work.getByLabel('工作标题', { exact: true }).fill('整理海边旅行手记与照片'); await work.getByLabel('工作要求', { exact: true }).fill(data.order.instruction + '\n补充：输出一份清楚的目录。'); await work.getByRole('button', { name: '保存工作修改', exact: true }).click();
    await expect(work.locator('.companions-work-order-detail h3')).toHaveText('整理海边旅行手记与照片');
    const saved = (await request(page, { type: 'work-order.list', companionId: data.companionId, conversationId: data.conversationId, includeHistory: true, limit: 100 })).workOrderPage!.items.find(order => order.id === data.order.id)!;
    expect(saved).toMatchObject({ publisherId: 'user', execution: 'external', status: 'paused', revision: data.order.revision + 1 }); expect(saved.instruction).toContain('补充：输出一份清楚的目录。');
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true });
    const dimensions = await work.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight, background: getComputedStyle(element).backgroundColor })); expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1); expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 1);
    await page.screenshot({ path: path.join(artifacts, 'verified-companion-workbench-light.png') });
    await work.getByRole('button', { name: '取消工作', exact: true }).click(); await expect(work).toContainText('已产生的文件和成果保留'); await work.getByRole('button', { name: '确认取消工作', exact: true }).click();
    await work.getByRole('button', { name: '全部记录', exact: true }).click(); await expect(work.locator('.companions-work-order-detail > .companions-work-status')).toHaveText('已取消');
    await work.getByRole('button', { name: '关闭伙伴工作台', exact: true }).click(); await planner.getByRole('button', { name: '管理伙伴日程', exact: true }).click();
    const schedule = page.getByRole('dialog', { name: '伙伴日程', exact: true }); await schedule.getByRole('button', { name: '日常事件', exact: true }).click(); await schedule.getByRole('button', { name: '添加日常事件', exact: true }).click();
    await schedule.getByLabel('日常事件名称', { exact: true }).fill('夜间找朋友读书'); await schedule.getByLabel('日常事件开始时间', { exact: true }).fill('23:00'); await schedule.getByLabel('日常事件结束时间', { exact: true }).fill('01:00'); await schedule.getByLabel('日常事件机会百分比', { exact: true }).fill('42'); await schedule.getByLabel('日常事件动作', { exact: true }).selectOption('visit'); await schedule.getByLabel('日常事件对象', { exact: true }).selectOption('phoebe'); await schedule.getByRole('button', { name: '保存日常事件', exact: true }).click();
    const rule = (await request(page, { type: 'life-rule.list', companionId: data.companionId })).lifeRules!.find(rule => rule.title === '夜间找朋友读书')!;
    expect(rule).toMatchObject({ startMinute: 1380, endMinute: 60, probability: .42, action: 'visit', targetId: 'phoebe', enabled: true });
    const card = schedule.locator('[data-life-rule="' + rule.id + '"]'); await expect(card).toContainText('23:00—次日 01:00'); await card.getByRole('button', { name: '编辑事件', exact: true }).click();
    await page.screenshot({ path: path.join(artifacts, 'verified-companion-life-events-light.png') });
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 1, theme: 'dark' })), THEME_PREF_KEY); await page.reload(); await page.locator('[data-application-module="companions"]').click();
    if (await page.getByRole('button', { name: '我们之间', exact: true }).getAttribute('aria-expanded') !== 'true') await page.getByRole('button', { name: '我们之间', exact: true }).click();
    await planner.getByRole('button', { name: '查看全部伙伴工作', exact: true }).click(); await work.getByRole('button', { name: '全部记录', exact: true }).click(); await expect(work).toContainText(saved.title); expect(await work.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(dimensions.background); await page.screenshot({ path: path.join(artifacts, 'verified-companion-workbench-dark.png') });
    await work.getByRole('button', { name: '关闭伙伴工作台', exact: true }).click(); await planner.getByRole('button', { name: '管理伙伴日程', exact: true }).click(); await schedule.getByRole('button', { name: '日常事件', exact: true }).click(); await card.getByRole('button', { name: '编辑事件', exact: true }).click(); await page.screenshot({ path: path.join(artifacts, 'verified-companion-life-events-dark.png') });
    await schedule.getByRole('button', { name: '关闭日常事件编辑', exact: true }).click(); await card.getByRole('button', { name: '移除事件', exact: true }).click(); await card.getByRole('button', { name: '确认移除事件', exact: true }).click(); await expect(card).toHaveCount(0);
    expect((await request(page, { type: 'life-rule.list', companionId: data.companionId })).lifeRules!.some(item => item.id === rule.id)).toBe(false); expect(errors).toEqual([]);
    const report = { fixtureKind: data.fixtureKind, orderId: saved.id, sourceCount: saved.authorizationSourceMessageIds.length, savedRevision: saved.revision, ruleId: rule.id, ruleProbability: rule.probability, errors }; writeFileSync(path.join(artifacts, 'verified-companion-work-life.json'), JSON.stringify(report, null, 2)); await testInfo.attach('work-life-ui', { body: JSON.stringify(report), contentType: 'application/json' });
  } finally { await application?.close().catch(() => undefined); cleanup(root); }
});
