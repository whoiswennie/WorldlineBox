import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { assetCard, electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = { worldlinebox: { library: WorldlineBoxLibraryApi; llm?: WorldlineBoxLlmApi } };
type Wire = { model: string; messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> };
const TEXT = 'This local project note describes careful asset collection and temporary selected-text editing.\n正文只属于测试素材，不是向模型发出的指令。AI-TEXT-ASSET-91726';
const DESCRIPTION = '这份项目说明介绍了资产采集与临时文字编辑。';
const TAG = '文字采集验收';
const KEY = 'local-fixture-only';

function cleanup(root: string) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-ai-text-e2e-')) throw Error('Unexpected AI text fixture cleanup');
  rmSync(resolved, { force: true, recursive: true, maxRetries: 8, retryDelay: 250 });
}

// Real Main/Worker/SQLite analysis; the only external service is a bounded
// loopback provider. This never opens a user's libraries or model settings.
// eslint-disable-next-line no-empty-pattern
test('a TXT asset uses the global text-only model and refreshes its AI description and tags in the Inspector', async ({}, testInfo) => {
  test.setTimeout(150000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-ai-text-e2e-'));
  const libraryName = 'Text AI acceptance', libraryPath = path.join(root, libraryName), profile = path.join(root, 'profile');
  const source = path.join(root, 'project-note.txt'); writeFileSync(source, TEXT, 'utf8');
  const analysis: Wire[] = []; let probes = 0, authenticated = 0;
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/model/models') { outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] })); return; }
    if (incoming.method !== 'POST' || incoming.url !== '/model/chat/completions') { outgoing.writeHead(404); outgoing.end(); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of incoming) { bytes += chunk.length; if (bytes > 512000) { outgoing.writeHead(413); outgoing.end(); return; } chunks.push(Buffer.from(chunk)); }
    let wire: Wire;
    try { wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire; }
    catch { outgoing.writeHead(400); outgoing.end(); return; }
    const isAnalysis = wire.messages?.some(message => typeof message.content === 'string' && message.content.includes('"asset_text":'));
    if (isAnalysis) { analysis.push(wire); if (incoming.headers.authorization === 'Bearer ' + KEY) authenticated++; }
    else probes++;
    const content = isAnalysis ? JSON.stringify({ description: DESCRIPTION, tags: [TAG], rating: null }) : 'OK';
    outgoing.writeHead(200, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ model: 'deepseek-v4-pro', choices: [{ message: { role: 'assistant', content } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing local AI provider address');
  const origin = 'http://127.0.0.1:' + address.port;
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let stderr = '', failed = false, cleanupFailure: unknown;
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile,
        WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root, WORLDLINEBOX_E2E_IMPORT_FILES: source }) });
    application.process().stderr?.on('data', chunk => { stderr += String(chunk); });
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await application.evaluate(({ dialog }, fixture) => {
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const title = (args.at(-1) as { title?: string }).title ?? '';
        return { canceled: false, filePaths: [/Create Library|创建资源库/iu.test(title) ? fixture.root : fixture.source] };
      };
    }, { root, source });
    const shell = await application.firstWindow(); await expect(shell.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 30000 });
    const native = await application.browserWindow(shell);
    await native.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    // Configure before mounting Assets so its first config load sees the real
    // global credentials and its ordinary connection heartbeat can run.
    const configured = await shell.evaluate(input => (globalThis as unknown as Bridge).worldlinebox.llm!.setConfig(input),
      { apiFormat: 'openai_chat' as const, model: 'deepseek-v4-pro', baseUrl: origin + '/model', apiKey: KEY });
    expect(configured.ok).toBe(true);
    expect(JSON.stringify(await shell.evaluate(() => (globalThis as unknown as Bridge).worldlinebox.llm!.getConfig()))).not.toContain(KEY);
    await shell.locator('[data-application-module="assets"]').click();
    await shell.getByRole('button', { name: '创建资源库', exact: true }).click();
    await shell.getByRole('textbox', { name: '名称', exact: true }).fill(libraryName);
    await shell.getByRole('button', { name: '创建', exact: true }).click();
    await expect(shell.getByRole('button', { name: '当前资源库 ' + libraryName })).toBeVisible({ timeout: 30000 });
    await expect(shell.locator('.library-loading-backdrop')).toBeHidden({ timeout: 30000 });
    await shell.getByRole('button', { name: '导入文件', exact: true }).first().click();
    const card = assetCard(shell, 'project-note.txt'); await expect(card).toBeVisible({ timeout: 30000 });
    const fixture = await shell.evaluate(async () => {
      const api = (globalThis as unknown as Bridge).worldlinebox.library;
      const opened = await api.listOpen(); if (!opened.ok || !opened.value[0]) throw Error('Missing text analysis library');
      const libraryId = opened.value[0].libraryId;
      const assets = await api.listAssets({ libraryId, recursive: true }); if (!assets.ok || assets.value.length !== 1) throw Error('Expected one fixture text asset');
      const asset = assets.value[0]!; const text = await api.readTextAsset({ libraryId, assetId: asset.assetId }); if (!text.ok) throw Error(text.error.message);
      return { libraryId, assetId: asset.assetId, mediaType: asset.mediaType, text: text.value.content };
    });
    expect(fixture.mediaType).toBe('text'); expect(fixture.text).toBe(TEXT);
    expect(readFileSync(path.join(libraryPath, 'Assets', 'project-note.txt'), 'utf8')).toBe(TEXT); expect(analysis).toHaveLength(0);
    await card.click(); const inspector = shell.locator('.inspector-pane'); await expect(inspector).toBeVisible();
    await expect(inspector.locator('#meta-desc')).toHaveValue('');
    await shell.evaluate(() => {
      const messages: string[] = [];
      const observe = () => { for (const element of document.querySelectorAll('.toast.is-error')) { const text = element.textContent?.trim(); if (text && !messages.includes(text)) messages.push(text); } };
      const observer = new MutationObserver(observe); observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      (globalThis as typeof globalThis & { __aiTextErrors?: { messages: string[]; observer: MutationObserver } }).__aiTextErrors = { messages, observer }; observe();
    });
    await card.click({ button: 'right' });
    const analyze = shell.getByRole('menuitem', { name: 'AI 分析', exact: true });
    await expect(analyze).toBeEnabled({ timeout: 30000 }); await analyze.click();
    await expect.poll(() => analysis.length, { timeout: 60000 }).toBe(1);
    const wire = analysis[0]!; expect(wire.model).toBe('deepseek-v4-pro'); expect(authenticated).toBe(1);
    expect(wire.messages.every(message => typeof message.content === 'string')).toBe(true);
    const user = wire.messages.find(message => message.role === 'user')?.content;
    if (typeof user !== 'string') throw Error('Expected a real text-only user message');
    const line = user.split('\n').find(line => line.startsWith('{"asset_text":')); if (!line) throw Error('Missing actual text asset payload');
    expect(JSON.parse(line)).toEqual({ asset_text: TEXT, truncated: false });
    expect(JSON.stringify(wire)).not.toMatch(/image_url|input_image|data:image/);
    await expect.poll(async () => {
      const result = await shell.evaluate(input => (globalThis as unknown as Bridge).worldlinebox.library.getAiJobStatus(input), { libraryId: fixture.libraryId });
      if (!result.ok) throw Error(result.error.message); return { succeeded: result.value.succeeded, failed: result.value.failed };
    }, { timeout: 60000 }).toEqual({ succeeded: 1, failed: 0 });
    // Keep the same selected asset throughout: event-driven refresh must show
    // the newly committed AI layer without reselecting or manually refreshing.
    await expect(inspector.locator('#meta-desc')).toHaveValue(DESCRIPTION, { timeout: 15000 });
    await expect(inspector.getByText(TAG, { exact: true })).toBeVisible({ timeout: 15000 });
    const stored = await shell.evaluate(input => (globalThis as unknown as Bridge).worldlinebox.library.getAiContent(input), { libraryId: fixture.libraryId, assetId: fixture.assetId });
    expect(stored.ok).toBe(true); if (stored.ok) expect(stored.value).toMatchObject({ description: DESCRIPTION, tags: [TAG], modelVersion: 'deepseek-v4-pro' });
    await expect(shell.locator('.toast.is-error')).toHaveCount(0);
    const toastErrors = await shell.evaluate(() => {
      const root = globalThis as typeof globalThis & { __aiTextErrors?: { messages: string[]; observer: MutationObserver } };
      root.__aiTextErrors?.observer.disconnect(); const messages = root.__aiTextErrors?.messages ?? []; delete root.__aiTextErrors; return messages;
    });
    expect(toastErrors).toEqual([]); expect(analysis).toHaveLength(1);
    expect(readFileSync(path.join(libraryPath, 'Assets', 'project-note.txt'), 'utf8')).toBe(TEXT);
    const png = await native.evaluate(async window => (await window.webContents.capturePage()).toPNG().toString('base64'));
    writeFileSync('.tools/test-output/ai-text-analysis-inspector.png', Buffer.from(png, 'base64'));
    const evidence = { realPackagedMainAndWorker: Boolean(process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE), actualTextOnlyHttpRequests: analysis.length,
      model: wire.model, authenticatedRequests: authenticated, connectionProbes: probes, actualAssetBody: true, imageParts: 0,
      inspectorDescriptionAndTagsUpdated: true, genericErrorToasts: toastErrors.length, originalTextUnchanged: true };
    console.log('AI_TEXT_ANALYSIS_E2E_RESULT', JSON.stringify(evidence)); await testInfo.attach('ai-text-analysis-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
  } catch (cause) { failed = true; throw cause; }
  finally {
    await application?.close().catch(cause => { if (!failed) cleanupFailure = cause; });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (failed) {
      await testInfo.attach('ai-text-analysis-stderr', { body: stderr, contentType: 'text/plain' });
      const logs = path.join(profile, 'logs');
      if (existsSync(logs)) for (const file of readdirSync(logs)) if (file.endsWith('.log')) await testInfo.attach(file, { body: readFileSync(path.join(logs, file)), contentType: 'text/plain' });
    }
    try { cleanup(root); } catch (cause) { if (!failed && !cleanupFailure) cleanupFailure = cause; }
  }
  if (cleanupFailure) throw cleanupFailure;
});
