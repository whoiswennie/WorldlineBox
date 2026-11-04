import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { BotRequest, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { BotMemoryCatalog, BotMemoryFullNote, BotMemoryRecallReport } from '../../src/shared/companion-bot-memory';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

async function request(page: Page, input: BotRequest) {
  return page.evaluate(input => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request(input), input);
}
async function memory<T>(page: Page, input: BotRequest): Promise<T> {
  const result = await request(page, input);
  expect(result.ok, `${input.type}: ${result.error ?? 'missing successful receipt'}`).toBe(true);
  return result.memory as T;
}

// eslint-disable-next-line no-empty-pattern -- Electron supplies its own real window.
test('memory workspace manages real local VCP notes and inspects original recall without a chat model', async ({}, testInfo) => {
  test.setTimeout(180000);
  testInfo.annotations.push({ type: 'local-memory', description: 'Human-authored test facts through real Main IPC and bundled 768-dimensional embedding; no chat/DSH request or recall stub.' });
  const prefix = 'wlb-bot-memory-app-', profile = await mkdtemp(path.join(tmpdir(), prefix));
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw Error('Unexpected owned memory test profile');
  const evidenceSuffix = process.env.WORLDLINEBOX_E2E_MEMORY_EVIDENCE_SUFFIX;
  if (evidenceSuffix && !/^[a-zA-Z0-9_-]+$/u.test(evidenceSuffix)) throw Error('Invalid memory evidence suffix');
  const evidence = path.resolve('artifacts/superagent-bot-development/ui', ...(evidenceSuffix ? [`memory-${evidenceSuffix}`] : []));
  await mkdir(evidence, { recursive: true });
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: resolved, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }) });
  let failurePage: Page | undefined;
  try {
    const page = await application.firstWindow();
    failurePage = page;
    const identity = await application.evaluate(({ app, BrowserWindow }, expected) => {
      const path = process.getBuiltinModule('node:path');
      if (path.resolve(app.getPath('userData')) !== expected) throw Error('Memory test must never use the real user profile');
      // A hidden normal native window can stop producing animation frames after
      // long IPC work, stranding Playwright's ordinary stability check. Use the
      // same real offscreen surface as the task/peer UI tests, without forcing
      // clicks or bypassing the renderer's actionability checks.
      const frames = { paints: 0 }; Reflect.set(globalThis, '__memoryUiFrames', frames);
      const isolate = (window: Electron.BrowserWindow) => {
        window.on('show', () => window.hide());
        window.webContents.setBackgroundThrottling(false);
        window.webContents.on('paint', () => { frames.paints++; });
        window.webContents.on('did-finish-load', () => { window.webContents.setBackgroundThrottling(false); window.hide(); });
        window.setMinimumSize(0, 0); window.setSize(1440, 960);
        window.hide();
      };
      for (const window of BrowserWindow.getAllWindows()) isolate(window);
      app.on('browser-window-created', (_event, window) => isolate(window));
      return { pid: process.pid, packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData'), offscreen: BrowserWindow.getAllWindows()[0]!.webContents.isOffscreen() };
    }, resolved);
    expect(identity.offscreen).toBe(true);
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) { expect(identity.packaged).toBe(true); expect(identity.appPath).toMatch(/app\.asar$/u); }
    const waitForPaint = async () => {
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const previous = await application.evaluate(({ BrowserWindow }) => {
        const previous = (Reflect.get(globalThis, '__memoryUiFrames') as { paints: number }).paints;
        BrowserWindow.getAllWindows()[0]!.webContents.invalidate(); return previous;
      });
      await expect.poll(() => application.evaluate(() => (Reflect.get(globalThis, '__memoryUiFrames') as { paints: number }).paints)).toBeGreaterThan(previous);
    };
    // Select appearance without navigating away during the initial bootstrap.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const initial = await request(page, { type: 'state' });
    expect(initial.ok).toBe(true); expect(initial.snapshot?.runtime.ready).toBe(false);
    expect(initial.snapshot?.tasks).toEqual([]);
    const conversation = initial.snapshot!.conversations.find(item => item.kind === 'direct' && item.memberIds.includes(DEFAULT_BOT_COMPANION_ID))!;
    expect(conversation).toBeTruthy();
    const scope = { conversationId: conversation.id, companionId: DEFAULT_BOT_COMPANION_ID };
    const longText = '本地测试：雨天的看展安排\n这是一组隔离测试事实，不是用户真实生活记录。周六预报下雨，所以把湖边散步改成市美术馆看展，下午两点在南门见。\n\n' +
      '路线已经讨论：乘地铁二号线，从广场东侧走到南门。看完展之后，可以在附近喝茶；午饭先各自安排，不把一下午排得太满。\n\n' +
      '尚未完成的事项是预约门票。只记录已经确认的安排，不把待办写成完成。若展馆临时闭馆，需要重新讨论目的地。\n\n' +
      '原来的湖边散步只是被雨天方案替代，等天气合适可以再去。测试中特别保留这段变化经过，全文读取应当能看到最后这句话：全文结尾校验雨伞。';
    const shortText = '本地测试：傍晚的饮品偏好\n隔离测试事实：傍晚以后喝无咖啡因的麦茶，白天喝咖啡的安排没有改变。';
    await memory(page, { type: 'memory.remember', ...scope, content: longText });
    await memory(page, { type: 'memory.remember', ...scope, content: shortText });
    const catalog = await memory<BotMemoryCatalog>(page, { type: 'memory.catalog', ...scope, limit: 24 });
    expect(catalog.total).toBe(2); expect(catalog.items.every(item => item.indexState === 'indexed')).toBe(true);
    const long = catalog.items.find(item => item.content?.startsWith('本地测试：雨天'))!, short = catalog.items.find(item => item.id !== long.id)!;
    expect(long.checksum).toMatch(/^[a-f0-9]{32}$/);
    // Two records are enough to prove real server cursors without seeding an entire UI page.
    const first = await memory<BotMemoryCatalog>(page, { type: 'memory.catalog', ...scope, limit: 1 });
    expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
    const next = await memory<BotMemoryCatalog>(page, { type: 'memory.catalog', ...scope, limit: 1, cursor: first.nextCursor });
    expect(next.items).toHaveLength(1); expect(next.items[0]!.id).not.toBe(first.items[0]!.id); expect(next.nextCursor).toBeUndefined();
    const note = await memory<BotMemoryFullNote>(page, { type: 'memory.note', ...scope, id: long.id });
    expect(note.content).toBe(longText); expect(note.content.length).toBeGreaterThan(long.content!.length);
    const memoryRoot = path.join(resolved, 'companion-bot-v2', 'memory');
    const homes = (await readdir(memoryRoot, { withFileTypes: true })).filter(item => item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name));
    expect(homes).toHaveLength(1);
    const config = JSON.parse(await readFile(path.join(memoryRoot, homes[0]!.name, 'config.json'), 'utf8')) as { VECTORDB_DIMENSION: number };
    expect(config.VECTORDB_DIMENSION).toBe(768);
    const open = async () => {
      await page.getByRole('button', { name: '记忆', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '记忆工作台', exact: true })).toBeVisible();
    };
    const row = (id: string) => page.locator(`[data-memory-note="${id}"]`);
    await open(); await row(long.id).locator('.bot-memory-row-open').click();
    const dialog = page.getByRole('dialog', { name: '记忆工作台', exact: true });
    await expect(dialog.locator('.bot-memory-fulltext')).toContainText('全文结尾校验雨伞');
    await expect.poll(() => dialog.locator('.bot-memory-identity img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    const panel = await dialog.boundingBox(); expect(panel!.width).toBeGreaterThanOrEqual(1000); expect(panel!.height).toBeGreaterThanOrEqual(700);
    await expect.poll(() => page.locator('html').getAttribute('data-ui-effects')).toMatch(/^(full|reduced)$/);
    const uiEffects = await page.locator('html').getAttribute('data-ui-effects');
    const surface = await page.locator('.bot-memory-backdrop').evaluate(element => ({ background: getComputedStyle(element).backgroundColor,
      blur: getComputedStyle(element).backdropFilter, underlayBlur: getComputedStyle(document.querySelector('.bot-main')!).filter }));
    expect(surface.background).toBe('rgba(20, 23, 40, 0.12)');
    if (uiEffects === 'reduced') { expect(surface.blur).toBe('none'); expect(surface.underlayBlur).toBe('none'); }
    else expect([surface.blur, surface.underlayBlur].some(value => value.includes('blur('))).toBe(true);
    const captureImage = async (name: string) => {
      await waitForPaint(); const image = testInfo.outputPath(name);
      const png = await application.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.webContents.setBackgroundThrottling(false); window.hide();
        return (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64');
      });
      await writeFile(image, Buffer.from(png, 'base64')); await copyFile(image, path.join(evidence, name));
      await testInfo.attach(name, { path: image, contentType: 'image/png' });
    };
    const capture = (theme: 'light' | 'dark') => captureImage(`memory-workspace-app-${theme}.png`);
    await capture('light');
    await row(short.id).locator('.bot-memory-row-open').click(); await expect(dialog.locator('.bot-memory-fulltext')).toContainText('麦茶');
    expect(await dialog.boundingBox()).toEqual(panel);
    await dialog.getByRole('button', { name: '召回试查', exact: true }).click(); expect(await dialog.boundingBox()).toEqual(panel);
    await dialog.getByRole('button', { name: '日记', exact: true }).click();
    await dialog.getByRole('button', { name: '关闭记忆工作台', exact: true }).click();
    await page.evaluate(() => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'dark' })));
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await open(); await row(long.id).locator('.bot-memory-row-open').click(); await expect(dialog.locator('.bot-memory-fulltext')).toContainText('全文结尾校验雨伞');
    await page.evaluate(() => document.fonts.ready); await capture('dark');
    await dialog.getByRole('button', { name: '编辑日记', exact: true }).click();
    const edited = longText.replace('下午两点', '下午三点');
    await dialog.getByRole('textbox', { name: '日记正文', exact: true }).fill(edited);
    await dialog.getByRole('textbox', { name: '标签，用逗号分隔', exact: true }).fill('本地测试,雨天安排');
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('索引已确认', { timeout: 45000 });
    const updated = await memory<BotMemoryFullNote>(page, { type: 'memory.note', ...scope, id: long.id });
    expect(updated.content).toBe(edited); expect(updated.checksum).not.toBe(long.checksum);
    const stale = await memory<{ state: string }>(page, { type: 'memory.update', ...scope, id: long.id, expectedChecksum: long.checksum, content: '这段过期修改不能覆盖已保存内容。' });
    expect(stale.state).toBe('conflict');
    expect((await memory<BotMemoryFullNote>(page, { type: 'memory.note', ...scope, id: long.id })).content).toBe(edited);
    await row(long.id).locator('input[type="checkbox"]').check(); await row(short.id).locator('input[type="checkbox"]').check();
    await dialog.getByRole('button', { name: '整理选中日记', exact: true }).click();
    const mergedText = '本地测试整理：雨天看展与麦茶\n隔离测试事实：周六下雨，原来的湖边散步改为市美术馆看展，下午三点南门见。预约门票仍未完成。傍晚以后喝麦茶，白天咖啡的习惯保持不变。';
    await dialog.getByRole('textbox', { name: '日记正文', exact: true }).fill(mergedText);
    await dialog.getByRole('textbox', { name: '标签，用逗号分隔', exact: true }).fill('本地测试');
    await dialog.getByRole('button', { name: '保存并归档原记录', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('原记录已归档', { timeout: 45000 });
    const organized = await memory<BotMemoryCatalog>(page, { type: 'memory.catalog', ...scope });
    expect(organized.items.filter(item => item.indexState === 'archived')).toHaveLength(2);
    const merged = organized.items.find(item => ![long.id, short.id].includes(item.id))!; expect(merged.indexState).toBe('indexed');
    await row(long.id).locator('.bot-memory-row-open').click(); await expect(dialog.locator('.bot-memory-note-meta')).toContainText('已归档');
    await expect(dialog.getByRole('button', { name: '编辑日记', exact: true })).toBeDisabled();
    await expect(row(long.id).locator('input[type="checkbox"]')).toBeDisabled();
    await expect(dialog.locator('.bot-memory-fulltext')).toContainText('全文结尾校验雨伞');
    const beforeRecall = await memory<{ historyMessages: number }>(page, { type: 'memory.inspect', ...scope });
    const reports: BotMemoryRecallReport[] = [];
    await dialog.getByRole('button', { name: '召回试查', exact: true }).click();
    for (const mode of ['passive', 'semantic'] as const) {
      await dialog.getByRole('button', { name: mode === 'passive' ? '被动召回' : '语义查找', exact: true }).click();
      await dialog.getByRole('textbox', { name: '想回想什么？', exact: true }).fill('这次本地测试周六下雨，最后约在哪里看展，几点见面？');
      await dialog.getByRole('button', { name: '开始试查', exact: true }).click();
      await expect(dialog.locator('.bot-memory-hit').first()).toBeVisible({ timeout: 45000 });
      const records = await memory<{ reports: BotMemoryRecallReport[] }>(page, { type: 'memory.recall.records', ...scope, limit: 5 });
      const report = records.reports[0]!; reports.push(report);
      expect(report.mode).toBe(mode); expect(report.hits.some(hit => hit.text.includes('市美术馆'))).toBe(true);
      expect(report.stages.some(stage => stage.name !== 'host.context.prepare')).toBe(true); expect(report.totalMs).toBeGreaterThan(0);
      expect(await dialog.locator('.bot-memory-hit p').allTextContents()).toEqual(report.hits.map(hit => hit.text));
      expect(await dialog.locator('.bot-memory-rank').allTextContents()).toEqual(report.hits.map(hit => String(hit.rank)));
      await expect(dialog.locator('.bot-memory-diagnostics')).not.toHaveAttribute('open');
      await dialog.locator('.bot-memory-diagnostics>summary').click();
      await expect(dialog.locator('.bot-memory-stage')).toHaveCount(report.stages.length);
      expect(await dialog.locator('.bot-memory-stage-name').allTextContents()).not.toEqual(report.stages.map(stage => stage.name));
      expect(await dialog.locator('.bot-memory-stage-status').allTextContents()).not.toContain('completed');
      const original = await dialog.locator('.bot-memory-stage-raw>pre').textContent();
      expect(JSON.parse(original!)).toEqual(report.stages);
      await expect(dialog.locator('.bot-memory-diagnostics')).toContainText('不能相加为总耗时');
    }
    // Actual stage names and measurements, rendered by the production renderer.
    // Resizing only this verified test window exercises all layout breakpoints.
    const recallLayout: unknown[] = [];
    const originalBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
    for (const width of [1440, 900, 620]) {
      await application.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setMinimumSize(560, 560); window.setSize(width, 900); window.hide();
      }, width);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width); await waitForPaint();
      await dialog.locator('.bot-memory-diagnostics>summary').scrollIntoViewIfNeeded();
      const geometry = await dialog.locator('.bot-memory-stages').evaluate(element => {
        const stages = element.getBoundingClientRect(), rows = [...element.children].map(item => {
          const bounds = item.getBoundingClientRect();
          return { width: bounds.width, outside: bounds.left < stages.left - 1 || bounds.right > stages.right + 1,
            overflow: item.scrollWidth > item.clientWidth + 1 };
        });
        return { viewport: innerWidth, columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
          width: stages.width, rows, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      expect(geometry.columns).toBe(geometry.viewport > 1000 ? 3 : geometry.viewport > 620 ? 2 : 1);
      expect(geometry.rows.every(row => !row.outside && !row.overflow)).toBe(true);
      expect(geometry.horizontalOverflow).toBe(false);
      recallLayout.push(geometry);
      await captureImage(`memory-recall-stages-${width}-dark.png`);
    }
    await application.evaluate(({ BrowserWindow }, bounds) => { const window = BrowserWindow.getAllWindows()[0]!; window.setBounds(bounds); window.hide(); }, originalBounds);
    await dialog.getByRole('button', { name: '最近5次试查', exact: true }).click();
    await expect(dialog.locator('.bot-memory-recall-records>div>button')).toHaveCount(2);
    const afterRecall = await memory<{ historyMessages: number }>(page, { type: 'memory.inspect', ...scope });
    expect(afterRecall.historyMessages).toBe(beforeRecall.historyMessages);
    const after = await request(page, { type: 'state', conversationId: scope.conversationId });
    expect(after.snapshot?.messages).toHaveLength(0); expect(after.snapshot?.tasks).toEqual([]); expect(after.snapshot?.runtime.activeLanes).toBe(0);
    await dialog.getByRole('button', { name: '日记', exact: true }).click(); await row(merged.id).locator('.bot-memory-row-open').click();
    await dialog.locator('summary[aria-label="更多操作"]').click(); await dialog.getByRole('menuitem', { name: '忘记这条记忆', exact: true }).click();
    await dialog.getByRole('button', { name: '确认忘记', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('这条记忆已撤回', { timeout: 45000 });
    expect((await memory<BotMemoryCatalog>(page, { type: 'memory.catalog', ...scope })).items.some(item => item.id === merged.id)).toBe(false);
    expect((await memory<{ reports: BotMemoryRecallReport[] }>(page, { type: 'memory.recall.records', ...scope })).reports).toEqual([]);
    const nativeVisible = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()));
    expect(nativeVisible).toBe(false);
    await writeFile(path.join(evidence, 'memory-workspace-app-evidence.json'), JSON.stringify({
      identity,
      route: 'actual Electron Main IPC / bundled VCP / local EmbeddingGemma 768', authoredTestFacts: true, configuredChatModel: false,
      testRendering: { hardwareGpuRequested: process.env.WORLDLINEBOX_E2E_ENABLE_HARDWARE_GPU === '1', claim: 'Functional coverage only; production GPU performance is not measured' },
      pagination: { first: first.items[0]!.id, next: next.items[0]!.id }, panel, surface, uiEffects, nativeVisible, dimension: config.VECTORDB_DIMENSION,
      recall: reports.map(report => ({ requestId: report.requestId, mode: report.mode, totalMs: report.totalMs, stages: report.stages, hits: report.hits })), recallLayout,
      historyMessagesBefore: beforeRecall.historyMessages, historyMessagesAfter: afterRecall.historyMessages,
      staleChecksumRejected: true, archivedOriginals: 2, mergedMemoryWithdrawn: true,
    }, null, 2) + '\n');
  } catch (error) {
    const diagnostic: Record<string, unknown> = { error: error instanceof Error ? error.message : String(error), profile: resolved };
    const within = async <T>(work: Promise<T>): Promise<T | { timedOut: true }> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([work, new Promise<{ timedOut: true }>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), 4000); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    diagnostic.native = await within(application.evaluate(({ app, BrowserWindow }) => ({ pid: process.pid, profile: app.getPath('userData'),
      frames: Reflect.get(globalThis, '__memoryUiFrames'), windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), offscreen: window.webContents.isOffscreen(), bounds: window.getBounds(), loading: window.webContents.isLoading() })) }))).catch(value => ({ error: String(value) }));
    if (failurePage) diagnostic.renderer = await within(failurePage.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('button[aria-label="记忆"]'), bounds = button?.getBoundingClientRect(), style = button ? getComputedStyle(button) : undefined;
      return { visibilityState: document.visibilityState, readyState: document.readyState, viewport: { width: innerWidth, height: innerHeight },
        button: button && bounds && style ? { bounds: bounds.toJSON(), clientRects: [...button.getClientRects()].map(rect => rect.toJSON()), disabled: button.disabled,
          display: style.display, visibility: style.visibility, opacity: style.opacity, pointerEvents: style.pointerEvents,
          pointStack: document.elementsFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2).slice(0, 6).map(element => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 120) })) } : null };
    })).catch(value => ({ error: String(value) }));
    const screenshot = await within(application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; return window ? (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64') : undefined;
    })).catch(() => undefined);
    if (typeof screenshot === 'string') { const file = testInfo.outputPath('memory-failure.png'); await writeFile(file, Buffer.from(screenshot, 'base64')); await testInfo.attach('memory-failure', { path: file, contentType: 'image/png' }); }
    await writeFile(testInfo.outputPath('memory-failure-diagnostic.json'), JSON.stringify(diagnostic, null, 2));
    throw error;
  } finally {
    await application.close();
    // The only recursively removed path is this test's validated mkdtemp child.
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
