import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorkspaceRequest } from '../../src/shared/companion-workspace';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import type { CompanionJobDisposition } from '../../src/shared/companion-job-control';
import { electronLaunchEnv, ensureCompanionTestWorkspace, removeCompanionTestDirectory, preparePackagedCompanionLaunch, resolveElectronLaunchOptions } from './electron-test-helpers';
import {companionEvidenceEnvironment,companionEvidenceName} from './companion-evidence-environment';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi } };
const screenshots = path.resolve('artifacts/cognition-validation/ui');
function cleanup(root:string){if(path.dirname(path.resolve(root))!==path.resolve(tmpdir())||!path.basename(root).startsWith('worldlinebox-job-failure-'))throw new Error('Unexpected fault fixture cleanup root.');removeCompanionTestDirectory(root);}
async function appearance(page: Page, mode: '亮色' | '暗色') {
  await page.getByRole('button', { name: '设置', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '通用设置', exact: true });
  await dialog.getByRole('tab', { name: '外观', exact: true }).click(); await dialog.getByRole('radio', { name: 'WorldlineBox', exact: true }).click(); await dialog.getByRole('radio', { name: mode, exact: true }).click(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
}
test('manages actual parked capture rows through versioned UI controls and paginated wide, compact and dark views', async () => {
  test.setTimeout(240000); mkdirSync(screenshots, { recursive: true });
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-job-failure-')), originalEvents: string[] = [];
  let application: ElectronApplication | undefined;
  let diagnosticsPage: Page | undefined, failed = false, logsDirectory = path.join(root, 'profile', 'logs');
  const steps: Array<{ step: string; epochMs: number; expectedKind?: string; selectedKinds?: string[] }> = [];
  const preservationErrors: string[] = [], preservedLogs: string[] = [];
  const recordStep = (step: string, expectedKind?: string, selectedKinds?: string[]) => { steps.push({ step, epochMs: Date.now(), ...(expectedKind ? { expectedKind } : {}), ...(selectedKinds ? { selectedKinds: [...selectedKinds] } : {}) }); };
  const preserveMainLogs = (phase: string) => {
    try {
      if (path.resolve(logsDirectory) !== path.join(root, 'profile', 'logs')) { preservationErrors.push(`${phase}: logs directory is outside the isolated test profile.`); return; }
      if (!existsSync(logsDirectory)) { preservationErrors.push(`${phase}: isolated Main logs directory is absent.`); return; }
      const destination = test.info().outputPath('failure-main-logs', phase); mkdirSync(destination, { recursive: true });
      for (const entry of readdirSync(logsDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^worldlinebox(?:-[a-zA-Z0-9-]+)?\.log$/u.test(entry.name)) continue;
        const target = path.join(destination, entry.name); copyFileSync(path.join(logsDirectory, entry.name), target); preservedLogs.push(target);
      }
    } catch (cause) { preservationErrors.push(`${phase}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };
  let failureSnapshot: unknown;
  const writeFailureReceipt = () => {
    try { mkdirSync(test.info().outputDir, { recursive: true }); writeFileSync(test.info().outputPath('failure-kind-steps.json'), JSON.stringify({ schema: 'worldlinebox.job-failure-ui-diagnostics-v1',
      steps, failureSnapshot, preservedLogs, preservationErrors,
      observationLimit: 'A generic empty-state assertion does not prove that the newly selected kind request completed. No per-kind response identity is exposed by this UI.' }, null, 2)); }
    catch (cause) { console.error('Could not preserve job-failure UI diagnostics:', cause); }
  };
  try {
    application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') }, { gpu: 'software' }) });
    await preparePackagedCompanionLaunch(application,path.join(root,'profile'));
    logsDirectory = await application.evaluate(({ app }) => app.getPath('logs'));
    const build=await companionEvidenceEnvironment(application,path.join(root,'profile'));
    const page = await application.firstWindow(), native = await application.browserWindow(page); await native.evaluate(window => { window.hide(); window.setSize(1600, 1050); window.webContents.setBackgroundThrottling(false); }); await ensureCompanionTestWorkspace(page);
    diagnosticsPage = page;
    const request = async (command: CompanionsRequest) => { const response = await page.evaluate(command => (window as unknown as Bridge).worldlinebox.companions.request(command), command); expect(response.ok, response.error).toBe(true); return response; };
    const workspace = async (command: CompanionWorkspaceRequest) => { const response = await page.evaluate(command => (window as unknown as Bridge).worldlinebox.companions.workspace!(command), command); expect(response.ok, response.error).toBe(true); return response; };
    const config = await page.evaluate(() => (window as unknown as Bridge).worldlinebox.llm.getConfig()); expect(config.ok).toBe(true); if (config.ok) expect(config.value.hasKey).toBe(false);
    const owner = (await request({ type: 'companion.create', operationId: randomUUID(), companionId: randomUUID(), companion: { name: '故障核对伙伴', description: '隔离故障管理界面验收', persona: '依据不足时保留未知。', avatar: 'custom', model: '', proactive: false } })).companion!;
    const room = (await request({ type: 'conversation.open', companionId: owner.id })).conversation!;
    for (let n = 0; n < 63; n++) originalEvents.push((await request({ type: 'message.send', conversationId: room.id, clientId: randomUUID(), delivery: 'chat', content: `隔离故障管理原始事件 ${String(n).padStart(3, '0')}：本次只核对处理状态，不声称已经学会。` })).message!.id);
    const rows: CompanionJobDisposition[] = []; let afterId: string | undefined;
    for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
      const report = (await workspace({ type: 'jobs.page', ownerId: owner.id, kind: 'capture', limit: 20, ...(afterId ? { afterId } : {}) })).jobPage!; rows.push(...report.items);
      if (!report.hasMore) break; expect(report.nextId).toBeTruthy(); expect(report.nextId).not.toBe(afterId); afterId = report.nextId;
    }
    expect(rows.length).toBeGreaterThanOrEqual(63);
    for (const row of rows) await workspace({ type: 'jobs.control', ownerId: owner.id, kind: 'capture', id: row.id, inputVersion: row.inputVersion, expectedRevision: row.revision, operationId: randomUUID(), action: 'park' });
    await page.locator('[data-application-module="companions"]').click();
    await page.locator(`[data-companion-conversation="${room.id}"]`).click();
    await expect(page.locator('.companions-chat-name')).toHaveText(owner.name);
    const between = page.getByRole('button', { name: '我们之间', exact: true });
    if (await between.getAttribute('aria-expanded') !== 'true') await between.click();
    await page.getByRole('button', { name: '查看伙伴日程', exact: true }).click();
    const agenda = page.getByRole('region', { name: '伙伴日程', exact: true }); await expect(agenda).toBeVisible();
    await agenda.getByRole('tab', { name: '系统事件', exact: true }).click();
    await agenda.getByRole('button', { name: '管理故障作业', exact: true }).click();
    const browser = page.getByRole('region', { name: '故障作业管理', exact: true }); await expect(browser.locator('[aria-label="分页故障作业"] > li')).toHaveCount(20);
    await browser.getByRole('button', { name: '加载更多故障记录', exact: true }).click(); await expect(browser.locator('[aria-label="分页故障作业"] > li')).toHaveCount(40);
    await browser.getByRole('button', { name: '加载更多故障记录', exact: true }).click(); await expect(browser.locator('[aria-label="分页故障作业"] > li')).toHaveCount(60);
    await browser.getByRole('button', { name: '核对处理状态与依据', exact: true }).click(); await expect(browser).toContainText('已停止自动重试');
    await page.screenshot({ path: path.join(screenshots, companionEvidenceName('fault-manager-wide-light.png')) });
    expect(await browser.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(2);
    const actual = (await workspace({ type: 'jobs.inspect', ownerId: owner.id, kind: 'capture', id: rows[0]!.id })).jobDisposition!;
    await browser.getByRole('button', { name: '放弃这次处理…', exact: true }).click(); await expect(browser.getByRole('group', { name: '确认放弃这次处理', exact: true })).toContainText('不删除原始事件');
    await browser.getByRole('button', { name: '确认放弃这次处理', exact: true }).click();
    expect((await request({ type: 'message.get', id: actual.sourceMessageId! })).message?.content).toContain('隔离故障管理原始事件');
    await browser.getByRole('combobox', { name: '故障状态筛选', exact: true }).selectOption('abandoned'); await expect(browser.locator('[aria-label="分页故障作业"] > li')).toHaveCount(1); await expect(browser).toContainText('已明确放弃');
    await native.evaluate(window => window.setSize(1120, 900)); await page.screenshot({ path: path.join(screenshots, companionEvidenceName('fault-manager-compact-light.png')) }); expect(await browser.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(2);
    await appearance(page, '暗色'); await page.screenshot({ path: path.join(screenshots, companionEvidenceName('fault-manager-compact-dark.png')) }); expect(await browser.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(2);
    recordStep('kind.select.begin', 'index');
    const selectedIndexKind = await browser.getByRole('combobox', { name: '故障作业类型', exact: true }).selectOption('index'); recordStep('kind.select.completed', 'index', selectedIndexKind);
    recordStep('kind.empty.assert.begin', 'index'); await expect(browser).toContainText('暂无已登记作业'); recordStep('kind.empty.assert.completed', 'index');
    for (const kind of ['source_files', 'history_files', 'topic_compaction']) {
      await test.step(`Check the selected ${kind} empty-state view`, async () => {
        recordStep('kind.select.begin', kind);
        const selectedKinds = await browser.getByRole('combobox', { name: '故障作业类型', exact: true }).selectOption(kind); recordStep('kind.select.completed', kind, selectedKinds);
        recordStep('kind.empty.assert.begin', kind); await expect(browser).toContainText('暂无已登记作业'); recordStep('kind.empty.assert.completed', kind);
        expect(await browser.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(2);
      });
    }
    writeFileSync(path.resolve('artifacts/cognition-validation',companionEvidenceName('fault-manager-electron-proof.json')), JSON.stringify({ actualElectron: true, build,isolatedTemporaryLibrary: true, originalEvents: originalEvents.length, actualCaptureRows: rows.length, actualParkedRows: rows.length, pagedVisibleRows: 60, explicitAbandonPreservedOriginalEvent: true, actualSupportedKinds: ['capture', 'index'], modelsCalled: 0,
      emptyBackgroundKindsChecked:['source_files','history_files','topic_compaction'],limitation: 'No model connection was configured. Rows were formally parked through jobs.control; this is not an automatic three-failure or all-kind backend proof.' }, null, 2));
  } catch (cause) {
    failed = true; recordStep('test.failed'); preserveMainLogs('before-shutdown'); writeFailureReceipt();
    // Preserve logs before asking a possibly unresponsive renderer for one
    // read-only snapshot. This records selection/loading, not an RPC receipt.
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (diagnosticsPage && !diagnosticsPage.isClosed()) failureSnapshot = await Promise.race([
        diagnosticsPage.evaluate(() => {
          const region = document.querySelector('[aria-label="故障作业管理"]');
          return { observedAtEpochMs: Date.now(), regionPresent: !!region,
            selectedKind: region?.querySelector<HTMLSelectElement>('[aria-label="故障作业类型"]')?.value,
            selectedFilter: region?.querySelector<HTMLSelectElement>('[aria-label="故障状态筛选"]')?.value,
            loading: !!region?.textContent?.includes('正在核对所选类型…'), empty: !!region?.textContent?.includes('暂无已登记作业'),
            displayedRowCount: region?.querySelectorAll('[aria-label="分页故障作业"] > li').length };
        }),
        new Promise<never>((_, reject) => { snapshotTimer = setTimeout(() => reject(new Error('Failure-only renderer snapshot did not finish within 1 second.')), 1000); }),
      ]);
    } catch (diagnosticCause) { preservationErrors.push(diagnosticCause instanceof Error ? diagnosticCause.message : String(diagnosticCause)); }
    finally { if (snapshotTimer !== undefined) clearTimeout(snapshotTimer); }
    writeFailureReceipt();
    throw cause;
  } finally {
    const diagnostic = process.env.WORLDLINEBOX_LAG_LOG === '1';
    if (diagnostic && !failed) preserveMainLogs('before-shutdown');
    await application?.close();
    if (failed || diagnostic) { preserveMainLogs('after-shutdown'); writeFailureReceipt(); }
    cleanup(root);
  }
});
