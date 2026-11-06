import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import type { DshLauncherRequest, DshLauncherState } from '../../src/shared/dsh-launcher';
import { electronLaunchEnv, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Electron owns the page.
test('presents a read-only character capability archive with native provenance and bounded discovery', async ({}, testInfo) => {
  test.setTimeout(180000);
  testInfo.annotations.push({ type: 'controlled-native-catalog-ui', description: 'Real Electron/React character card; Main IPC supplies controlled native capability records. This is UI acceptance, not a native plugin-installation test. No model calls.' });
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-capability-archive-ui-'));
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
  const evidence = path.resolve('artifacts/companion-capability-archive'); await mkdir(evidence, { recursive: true });
  try {
    const page = await application.firstWindow();
    await expect(page.locator('[data-application-module="companions"]')).toBeVisible();
    const native = await application.browserWindow(page);
    await native.evaluate(win => { win.on('show', () => win.hide()); win.hide(); win.setMinimumSize(640, 480); win.setSize(1440, 960); win.webContents.setBackgroundThrottling(false); const frames = { paints: 0 }; Reflect.set(globalThis, '__archiveFrames', frames); win.webContents.on('paint', () => { frames.paints++; }); });
    const fixture: DshLauncherState = { supported: true, rootPath: 'C:/isolated/archive', runtimes: [{ id: 'native-rc1', version: '0.2.2-rc.1', adapter: 'node-cli-web-v1', nodeVersion: '24.15.0', platform: 'win32-x64', source: 'controlled-ui-fixture', sourceSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), fileCount: 1, byteLength: 1, installedAt: '' }], snapshots: [], operations: [], packs: [], instances: [{ id: 'fish-private', name: '大肥鱼 · 专属执行环境', companionId: 'builtin-dafeiyu', companionName: '大肥鱼', runtimeId: 'native-rc1', profile: 'web', status: 'stopped', createdAt: '', updatedAt: '', isDefault: false, homePath: 'C:/isolated/fish/home', agentsPath: 'C:/isolated/fish/agents', workspacePath: 'C:/isolated/fish/work', browserPartition: 'persist:archive-fish' }] };
    await application.evaluate(({ ipcMain, BrowserWindow }, state) => {
      const fixture = { state, calls: [] as DshLauncherRequest[] }; Reflect.set(globalThis, '__archiveFixture', fixture);
      const contents = BrowserWindow.getAllWindows()[0]!.webContents, send = contents.send.bind(contents);
      contents.send = (channel, ...args) => send(channel, ...(channel === 'worldlinebox:dsh-launcher:changed' ? [fixture.state] : args));
      ipcMain.removeHandler('worldlinebox:dsh-launcher');
      ipcMain.handle('worldlinebox:dsh-launcher', async (_event, input: DshLauncherRequest) => {
        fixture.calls.push(input);
        if (input.type === 'state') return { ok: true, state: fixture.state };
        if (input.type === 'companion.environment.open') return { ok: true, state: fixture.state };
        if (input.type === 'instance.plugins') return { ok: true, installedPlugins: [{ name: '@native/research-notebook', version: '1.2.0', spec: '@native/research-notebook', description: '研究笔记与资料归档扩展', enabled: true, bundle: true, core: false, scope: 'instance' }, { name: '@native/moonlight-skin', version: '2.0.0', spec: '@native/moonlight-skin', description: '月光主题皮肤，只改变界面外观', enabled: true, bundle: true, core: false, scope: 'instance' }] };
        if (input.type === 'skill.list') return { ok: true, installedSkills: [{ name: 'research-review', description: '研究资料与论文精读', enabled: true, path: 'C:/isolated/fish/skills/research-review/SKILL.md', managed: true, repository: 'sample/research-skills' }] };
        if (input.type !== 'companion.environment.capabilities') throw Error('Archive must not mutate native configuration: ' + input.type);
        const epoch = fixture.state.companionCapabilityRevisions?.['fish-private'] ?? 0;
        if (epoch) await new Promise(resolve => setTimeout(resolve, 500));
        const base = { instanceId: 'fish-private', runtimeId: 'native-rc1', runtimeVersion: '0.2.2-rc.1', capturedAt: '2026-11-07T00:00:00+08:00', modes: ['native'], preset: 'companion-worker', workspacePath: 'C:/isolated/fish/work', toolRestrictions: true, skillSelection: true, tools: [], skills: [], toolsTotal: 64 + epoch, skillsTotal: 1 };
        if (input.query?.kind === 'skill') return { ok: true, taskCapabilities: { ...base, detail: { kind: 'skill', name: input.query.name, available: true, source: 'native-agent-scope', trust: 'capability_reference_data', skill: { name: input.query.name, description: '研究资料与论文精读', provider: 'native-skills', source: 'sample/research-skills', path: 'C:/isolated/fish/skills/research-review/SKILL.md', content: input.query.textOffset ? '第二段：逐项核对结论与依据，保留原始引用。' : '第一段：阅读原始资料，区分证据、推测与未验证的信息。', textOffset: input.query.textOffset ?? 0, totalChars: 8000, truncated: true, nextTextOffset: input.query.textOffset ? undefined : 4000 } } } };
        if (input.query?.kind === 'tool') return { ok: true, taskCapabilities: { ...base, detail: { kind: 'tool', name: input.query.name, available: true, source: 'native-agent-scope', trust: 'capability_reference_data', tool: { name: input.query.name, description: '原生注册的工具定义', parameters: { type: 'object' } } } } };
        const samples = [{ name: 'research.search', description: '检索研究资料，保留可追溯的来源与引用。' }, { name: 'notebook.write', description: '将经过核对的信息整理进研究笔记。' }, { name: 'files.organize', description: '依据任务目标整理文件，保留原始资料。' }, { name: 'data.inspect', description: '查看结构化数据并检查字段与质量。' }];
        const all = [...(epoch ? [{ kind: 'tool', name: 'native.newly_registered', description: '原生插件更新后登记的新能力。' }] : []), { kind: 'skill', name: 'research-review', description: '研究资料与论文精读' }, ...Array.from({ length: 64 }, (_, index) => ({ kind: 'tool', name: index < samples.length ? samples[index]!.name : `native.tool_${index}`, description: index < samples.length ? samples[index]!.description : '执行环境实际登记的扩展工具。' }))];
        const query = input.query?.query?.toLowerCase() ?? '', offset = input.query?.offset ?? 0;
        const filtered = all.filter(entry => (input.query?.category === 'all' || !input.query?.category || entry.kind === input.query.category) && `${entry.name} ${entry.description}`.toLowerCase().includes(query));
        return { ok: true, taskCapabilities: { ...base, catalog: { kind: 'catalog', category: input.query?.category ?? 'all', query, offset, limit: 30, total: filtered.length, items: filtered.slice(offset, offset + 30), nextOffset: offset + 30 < filtered.length ? offset + 30 : undefined, source: 'native-agent-scope', trust: 'capability_reference_data' } } };
      });
    }, fixture);
    const show = async () => { await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '角色卡', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '角色卡 · 大肥鱼', exact: true }); await dialog.getByRole('button', { name: '能力档案', exact: true }).click(); return dialog; };
    const capture = async (filename: string) => {
      await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
      const before = await native.evaluate(win => { const count = (Reflect.get(globalThis, '__archiveFrames') as { paints: number }).paints; win.webContents.invalidate(); return count; });
      await expect.poll(() => native.evaluate(() => (Reflect.get(globalThis, '__archiveFrames') as { paints: number }).paints)).toBeGreaterThan(before);
      const png = await native.evaluate(async win => (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const file = testInfo.outputPath(filename); await writeFile(file, Buffer.from(png, 'base64')); await copyFile(file, path.join(evidence, filename)); await testInfo.attach(filename, { path: file, contentType: 'image/png' });
    };
    const layouts: unknown[] = [];
    for (const [theme, width, height] of [['light', 1440, 960], ['dark', 1440, 960], ['dark', 850, 720]] as const) {
      await native.evaluate((win, size) => win.setSize(size.width, size.height), { width, height });
      await page.evaluate(theme => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme })), theme);
      await page.reload(); const dialog = await show();
      for (const status of ['stopped', 'running'] as const) {
        await application.evaluate(({ BrowserWindow }, status) => { const fixture = Reflect.get(globalThis, '__archiveFixture') as { state: DshLauncherState }; fixture.state.instances[0]!.status = status; BrowserWindow.getAllWindows()[0]!.webContents.send('worldlinebox:dsh-launcher:changed', fixture.state); }, status);
        if (status === 'running') await expect(dialog.locator('[data-callable-capability]')).toHaveCount(30); else await expect(dialog.locator('.capability-archive-empty')).toBeVisible();
        await expect(dialog.getByRole('button', { name: /安装插件|卸载|插件市场|技能市场|关闭伙伴|启用伙伴|应用待更新/ })).toHaveCount(0);
        const layout = await dialog.locator('.capability-archive').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, records: element.querySelectorAll('[data-callable-capability]').length }));
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1); layouts.push({ theme, viewportWidth: width, status, ...layout });
        await capture(`capability-archive-${status}-${theme}-${width}.png`);
      }
      if (width === 1440 && theme === 'light') {
        await dialog.getByRole('button', { name: '下一页', exact: true }).click(); await expect(dialog.locator('[data-callable-capability="native.tool_30"]')).toBeVisible();
        await dialog.getByRole('textbox', { name: '搜索可调用能力', exact: true }).fill('research-review'); await expect(dialog.locator('[data-callable-capability]')).toHaveCount(1);
        await dialog.locator('[data-callable-capability="research-review"]').click(); await expect(dialog.getByRole('article', { name: '能力详情', exact: true })).toContainText('sample/research-skills');
        await dialog.getByRole('article', { name: '能力详情', exact: true }).scrollIntoViewIfNeeded();
        await capture('capability-archive-skill-detail-light.png'); await dialog.getByRole('button', { name: '继续读取技能', exact: true }).click(); await expect(dialog.getByRole('article', { name: '能力详情', exact: true })).toContainText('第二段');
        await dialog.getByRole('button', { name: '装载来源', exact: true }).click(); await expect(dialog.locator('[data-capability-source="@native/moonlight-skin"]')).toBeVisible();
        await dialog.locator('[data-capability-source="@native/moonlight-skin"]').scrollIntoViewIfNeeded();
        await expect(dialog.locator('[data-callable-capability="@native/moonlight-skin"]')).toHaveCount(0); await capture('capability-archive-sources-light.png');
        await dialog.getByRole('button', { name: '前往专属 DSH', exact: true }).click();
        await application.evaluate(({ BrowserWindow }) => { const fixture = Reflect.get(globalThis, '__archiveFixture') as { state: DshLauncherState }; fixture.state.companionCapabilityRevisions = { 'fish-private': 1 }; BrowserWindow.getAllWindows()[0]!.webContents.send('worldlinebox:dsh-launcher:changed', fixture.state); });
        await expect(dialog.locator('.capability-archive-metrics')).toContainText('—');
        await expect(dialog.locator('[data-callable-capability="native.newly_registered"]')).toBeVisible();
        await expect(dialog.locator('.capability-archive-metrics')).not.toContainText('—');
      }
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    }
    const calls = await application.evaluate(() => (Reflect.get(globalThis, '__archiveFixture') as { calls: DshLauncherRequest[] }).calls);
    expect(calls.every(input => ['state', 'companion.environment.capabilities', 'instance.plugins', 'skill.list', 'companion.environment.open'].includes(input.type))).toBe(true);
    expect(calls.filter(input => input.type === 'companion.environment.open')).toEqual([{ type: 'companion.environment.open', companionId: 'builtin-dafeiyu', name: '大肥鱼' }]);
    await writeFile(path.join(evidence, 'capability-archive-evidence.json'), JSON.stringify({ actualElectron: true, controlledCatalogIpc: true, nativeInstallationTest: false, modelCalls: 0, noConfigurationMutations: true, layouts, calls }, null, 2));
  } finally { await application.close(); removeCompanionTestDirectory(profile); }
});
