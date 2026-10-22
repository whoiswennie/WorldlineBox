import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { WorldlineBoxCompanionsApi, CompanionsRequest } from '../../src/shared/companions';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import type { CompanionLearningWorkspaceCommand } from '../../src/shared/companion-learning';
import { electronLaunchEnv, ensureCompanionTestWorkspace, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; library: WorldlineBoxLibraryApi; llm: WorldlineBoxLlmApi } };
const cleanup = (root: string) => { if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-learning-ui-')) throw new Error('Unexpected learning UI fixture path.'); removeCompanionTestDirectory(root); };

// Real asset I/O and source authorization. The chat fixture deliberately keeps
// no journal notes: a reading receipt is not evidence of learning or skill.
// eslint-disable-next-line no-empty-pattern
test('manages explicit library learning permissions and real reading receipts without claiming the material was learned', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-learning-ui-')), profile = path.join(root, 'profile');
  const files = ['海岸观察.md', '潮汐说明.txt'].map(name => path.join(root, name));
  writeFileSync(files[0]!, '# 海岸观察\n\n海风改变云层的形状。这段资料只是阅读材料，不是伙伴已经亲身经历的事情。');
  writeFileSync(files[1]!, '潮汐资料介绍月球引力与海岸水位的变化。读过资料并不代表已经掌握海洋学。');
  const server = createServer((request, response) => {
    let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      let text = JSON.stringify({ notes: [], dream: null });
      try { const payload = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
        const context = JSON.parse(payload.messages.findLast(message => message.role === 'user')?.content ?? '{}') as { purpose?: string };
        if (context.purpose === 'world_attention') text = JSON.stringify({ urgency: 'ordinary', confidence: .99, evidence: [], reason: '无须打断。' });
        if (context.purpose === 'world_decision') text = JSON.stringify({ action: null, appraisals: [], reason: '本例只验证实际阅读。' });
        if (context.purpose === 'world_social') text = JSON.stringify({ text: null, reason: '不延伸本例。' });
      } catch { text = '[[Tag: 资料]]'; }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Learning provider did not bind.');
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_IMPORT_FILES: files.join(path.delimiter) }) });
  try {
    await preparePackagedCompanionLaunch(application, profile);
    // Only native pickers are replaced in the actual packaged acceptance path.
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) await application.evaluate(({ dialog }, fixture) => {
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const title = (args.at(-1) as { title?: string }).title ?? '';
        if (/Create Library|创建资源库/iu.test(title)) return { canceled: false, filePaths: [fixture.root] };
        if (/Import|导入/iu.test(title)) return { canceled: false, filePaths: fixture.files };
        throw new Error('Unexpected learning fixture dialog: ' + title);
      };
    }, { root, files });
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setSize(1440, 960); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    await ensureCompanionTestWorkspace(page);
    const companionId = 'deepseek-sister'; await prepareReader(page, companionId);
    // Freeze reading while checking the explicit default and editing its schedule.
    await request(page, { type: 'companion.set-active', id: companionId, active: false });
    const source = await page.evaluate(async () => {
      const api = (window as unknown as Bridge).worldlinebox.library;
      const library = await api.create({ displayName: '海岸学习资料库' }); if (!library.ok) throw new Error(library.error.message);
      const folder = await api.createFolder({ libraryId: library.value.libraryId, name: '海岸课程' }); if (!folder.ok) throw new Error(folder.error.message);
      const imported = await api.importFiles({ libraryId: library.value.libraryId, targetFolderId: folder.value.folderId }); if (!imported.ok) throw new Error(imported.error.message);
      return { libraryId: library.value.libraryId, folderId: folder.value.folderId };
    });
    const configured = await page.evaluate(input => (window as unknown as Bridge).worldlinebox.llm.setConfig(input), { apiFormat: 'openai_chat' as const, baseUrl: `http://127.0.0.1:${address.port}`, model: 'reading-receipt-only-fixture', apiKey: 'isolated-reading-fixture' }); expect(configured.ok).toBe(true);
    await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '打开伙伴记忆库', exact: true }).click();
    const manager = page.getByRole('region', { name: '共同记忆管理', exact: true, includeHidden: true });
    await manager.getByRole('combobox', { name: '记忆所属伙伴', exact: true }).selectOption(companionId);
    await manager.getByRole('button', { name: '学习来源', exact: true }).click();
    const learning = page.getByRole('region', { name: '学习来源管理', exact: true });
    await learning.getByRole('button', { name: '添加来源', exact: true }).click();
    await learning.getByRole('combobox', { name: '学习资料资产库', exact: true }).selectOption(source.libraryId);
    await learning.getByRole('combobox', { name: '学习资料目录', exact: true }).selectOption(source.folderId);
    await learning.getByRole('button', { name: '添加为学习来源', exact: true }).click();
    const grant = learning.getByRole('article', { name: '海岸学习资料库 / 海岸课程', exact: true });
    await expect(grant).toBeVisible(); await expect(grant.getByRole('checkbox', { name: '空闲时自主阅读', exact: true })).not.toBeChecked();
    let status = (await workspace(page, { type: 'memory.learning.status', companionId })).learning!;
    expect(status.grants).toHaveLength(1); expect(status.grants[0]).toMatchObject({ ...source, autonomous: false }); expect(status.reads).toEqual([]);
    await grant.getByRole('checkbox', { name: '空闲时自主阅读', exact: true }).check();
    await grant.getByRole('combobox', { name: '海岸学习资料库核对间隔', exact: true }).selectOption('60');
    await grant.getByRole('button', { name: '保存安排', exact: true }).click();
    await expect.poll(async () => (await workspace(page, { type: 'memory.learning.status', companionId })).learning!.grants[0]?.autonomous).toBe(true);
    expect((await workspace(page, { type: 'memory.learning.status', companionId })).learning!.reads).toHaveLength(0);
    await request(page, { type: 'companion.set-active', id: companionId, active: true });
    console.log('LEARNING_UI_READINESS', JSON.stringify({ actor: (await request(page, { type: 'world.snapshot' })).world!.actors.find(actor => actor.companionId === companionId),
      routine: (await request(page, { type: 'routine.get', companionId, conversationId: 'private-' + companionId })).routine?.runtime,
      config: await page.evaluate(() => (window as unknown as Bridge).worldlinebox.llm.getConfig()) }));
    await grant.getByRole('button', { name: '读一轮', exact: true }).click();
    let previous = '';
    await expect.poll(async () => {
      const current = (await workspace(page, { type: 'memory.learning.status', companionId })).learning!;
      const signature = JSON.stringify(current); if (signature !== previous) { previous = signature; console.log('LEARNING_UI_STATUS', signature); }
      return current.reads.length;
    }, { timeout: 60_000 }).toBe(2);
    status = (await workspace(page, { type: 'memory.learning.status', companionId })).learning!;
    expect(status.reads.map(read => read.assetName).sort()).toEqual(['海岸观察.md', '潮汐说明.txt'].sort());
    expect(status.reads.every(read => read.characters > 0 && read.status === 'read' && read.contentHash.length === 64)).toBe(true);
    await expect(learning.locator('.learning-history')).toContainText('已读取原文'); await expect(learning).not.toContainText('已经学会');
    const evidence = path.resolve('artifacts/vcp-validation/learning-sources-ui'); mkdirSync(evidence, { recursive: true });
    const screenshots: Array<{ file: string; requestedWidth: number; innerWidth: number; innerHeight: number; devicePixelRatio: number }> = [];
    for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 800]] as const) {
      await native.evaluate((win, width) => win.setSize(width, 960), width); await setTheme(page, theme);
      await expect(learning).toBeVisible();
      const geometry = await learning.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth })); expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      const viewport = await page.evaluate(() => ({ innerWidth, innerHeight, devicePixelRatio }));
      const file = `learning-sources-${theme}-${viewport.innerWidth}.png`;
      await page.screenshot({ path: path.join(evidence, file) });
      screenshots.push({ file, requestedWidth: width, ...viewport });
    }
    await grant.getByRole('button', { name: '移除来源', exact: true }).click(); await grant.getByRole('button', { name: '移除并撤回记忆', exact: true }).click();
    await expect(grant).toHaveCount(0); await expect(learning.locator('.learning-history')).toContainText('来源已移除');
    const revoked = (await workspace(page, { type: 'memory.learning.status', companionId })).learning!;
    expect(revoked.grants).toEqual([]); expect(revoked.reads.every(read => read.status === 'withdrawn')).toBe(true);
    const filtered = await request(page, { type: 'memory.sources.filter', companionId, conversationId: 'world_' + companionId, ids: revoked.reads.map(read => read.sourceMessageId) }); expect(filtered.memorySources).toEqual([]);
    const stoppedAt = Date.now(); await expect.poll(async () => { const current = (await workspace(page, { type: 'memory.learning.status', companionId })).learning!;
      expect(current.reads).toHaveLength(2); expect(current.grants).toEqual([]); return Date.now() - stoppedAt >= 5500; }, { timeout: 10_000, intervals: [500, 1000] }).toBe(true);
    writeFileSync(path.join(evidence, 'reading-permission-proof.json'), JSON.stringify({ source, grantedManually: true, initiallyAutonomous: false, scheduleSaved: true, reads: status.reads, revoked: revoked.reads, noMasteryClaim: true, screenshots }, null, 2));
    await testInfo.attach('actual-reading-receipts', { body: JSON.stringify(status.reads), contentType: 'application/json' });
  } finally { await application.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); cleanup(root); }
});

async function request(page: Page, input: CompanionsRequest) { const result = await page.evaluate(input => (window as unknown as Bridge).worldlinebox.companions.request(input), input); expect(result.ok, result.error).toBe(true); return result; }
async function workspace(page: Page, input: CompanionLearningWorkspaceCommand) { const result = await page.evaluate(input => (window as unknown as Bridge).worldlinebox.companions.workspace!(input), input); expect(result.ok, result.error).toBe(true); return result; }
async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.getByRole('button', { name: '设置', exact: true }).click(); const settings = page.getByRole('dialog', { name: '通用设置', exact: true });
  await settings.getByRole('tab', { name: '外观', exact: true }).click(); await settings.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
  await settings.getByRole('radio', { name: theme === 'light' ? '亮色' : '暗色', exact: true }).click(); await page.keyboard.press('Escape'); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}
async function prepareReader(page: Page, companionId: string) {
  await request(page, { type: 'companion.set-active', id: companionId, active: true }); const room = (await request(page, { type: 'conversation.open', companionId })).conversation!;
  const world = (await request(page, { type: 'world.snapshot' })).world!, routine = (await request(page, { type: 'routine.get', companionId, conversationId: room.id })).routine!;
  const clock = (offset: number) => String((Math.floor(world.clock.hour) + offset + 24) % 24).padStart(2, '0') + ':00';
  await request(page, { type: 'routine.configure', companionId, conversationId: room.id, expectedRevision: routine.revision, patch: { timeZone: world.settings.timeZone, wakeAt: clock(-8), sleepAt: clock(8), meals: [], habits: [] } });
  const home = world.scenes.find(scene => scene.ownerId === companionId)!, computer = home.objects.find(object => object.kind === 'computer')!;
  await request(page, { type: 'world.tool', companionId, conversationId: room.id, arguments: { action: 'move', destinationId: computer.id } });
  await expect.poll(async () => { const actor = (await request(page, { type: 'world.snapshot' })).world!.actors.find(actor => actor.companionId === companionId)!;
    return actor.sceneId === home.id && !actor.route.length && Math.hypot(actor.position.x - computer.anchor.x, actor.position.y - computer.anchor.y) < .01; }, { timeout: 30_000 }).toBe(true);
}
