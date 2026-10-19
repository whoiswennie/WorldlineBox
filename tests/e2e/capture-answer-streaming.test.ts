import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CaptureToolsRequest, WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = { worldlinebox: { captureTools: WorldlineBoxCaptureToolsApi; llm: WorldlineBoxLlmApi } };
type Wire = { stream?: boolean; store?: boolean; messages: Array<{ role: string; content: unknown }> };
const PASSAGE = 'Selected passage for the temporary streaming assistant.';
const REASONING = '**公开分析摘要**\n\n- 先检查当前内容。STREAM-REASONING-3461';
const PARTIAL = '## 实时回复\n\n这是**逐步显示**的正文。';
const FINAL = PARTIAL + '\n\n| 项目 | 结果 |\n| --- | --- |\n| 流式 | 支持 |\n\n```ts\nconst ready = true;\n```\n\n![禁止自动加载](https://example.invalid/never-fetch.png)';
async function request(page: Page, input: CaptureToolsRequest) {
  const result = await page.evaluate(input => (globalThis as unknown as Bridge).worldlinebox.captureTools.request(input), input);
  if (!result.ok) throw Error(result.error); return result;
}
function cleanup(root: string) {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('worldlinebox-stream-qa-')) throw Error('Unexpected streaming fixture cleanup path');
  rmSync(target, { force: true, recursive: true, maxRetries: 8, retryDelay: 400 });
}

// A genuine HTTP SSE response is deliberately held open until the renderer has
// displayed its first reasoning and answer deltas. The application does not
// receive synthetic renderer events, substituted pixels or provider credentials.
// eslint-disable-next-line no-empty-pattern
for (const mode of ['selection', 'desktop'] as const) test(`${mode} temporary Q&A streams Markdown and provider reasoning before HTTP completion`, async ({}, testInfo) => {
  test.setTimeout(150000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-stream-qa-')); const profile = path.join(root, 'profile');
  const received: Wire[] = []; let finish: (() => void) | undefined; let aborted = 0;
  let ended = false; let networkImageRequests = 0;
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/page') {
      outgoing.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      outgoing.end(`<!doctype html><html><head><title>Streaming answer test</title></head><body style="padding:30px;background:#dbecf8;font:24px Segoe UI"><h1>Actual browser page</h1><p id="passage">${PASSAGE}</p></body></html>`); return;
    }
    if (incoming.url === '/model/models') { outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end('{"data":[{"id":"deepseek-flash"}]}'); return; }
    if (incoming.method === 'POST' && incoming.url === '/model/chat/completions') {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of incoming) { bytes += chunk.length; if (bytes > 6_000_000) { outgoing.writeHead(413); outgoing.end(); return; } chunks.push(Buffer.from(chunk)); }
      const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire; received.push(wire);
      outgoing.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); outgoing.flushHeaders();
      const delta = (value: object) => outgoing.write('data: ' + JSON.stringify({ choices: [{ delta: value, finish_reason: null }] }) + '\n\n');
      const done = () => { outgoing.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); outgoing.end(); };
      if (received.length === 1) {
        delta({ reasoning_content: REASONING }); delta({ content: PARTIAL });
        finish = () => { delta({ content: FINAL.slice(PARTIAL.length) }); ended = true; done(); }; return;
      }
      if (received.length === 2) { delta({ content: '第二轮：已保留前文。' }); done(); return; }
      outgoing.once('close', () => { if (!outgoing.writableEnded) aborted++; });
      delta({ reasoning_content: '这一轮应能停止。' }); delta({ content: '待停止的部分回复。' }); return;
    }
    outgoing.writeHead(404); outgoing.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture address');
  const origin = `http://127.0.0.1:${address.port}`; let application: ElectronApplication | undefined; let failed = false; let cleanupError: unknown;
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
    const main = await application.firstWindow(); await expect(main.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 30000 });
    const native = await application.browserWindow(main); await native.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    const configured = await main.evaluate(baseUrl => (globalThis as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', model: 'deepseek-flash', baseUrl, apiKey: 'stream-fixture-key' }), origin + '/model'); expect(configured.ok).toBe(true);
    await main.locator('[data-application-module="browser"]').click(); const location = main.getByRole('textbox', { name: '搜索或输入网址' }); await location.fill(origin + '/page'); await location.press('Enter');
    await expect.poll(() => application!.context().pages().some(page => page.url() === origin + '/page')).toBe(true);
    const web = application.context().pages().find(page => page.url() === origin + '/page')!; await expect(web.locator('#passage')).toHaveText(PASSAGE);
    if (mode === 'selection') await web.locator('#passage').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); });
    if (mode === 'desktop') await main.locator('.browser-toolbar').getByRole('button', { name: '截图', exact: true }).click();
    else await request(main, { type: 'open', task: 'selection', source: 'browser' });
    await expect.poll(() => application!.windows().some(page => page.url().includes('window=capture-tools')), { timeout: 15000 }).toBe(true);
    const tool = application.windows().find(page => page.url().includes('window=capture-tools'))!;
    if (mode === 'desktop') await tool.emulateMedia({ colorScheme: 'dark' });
    tool.on('request', outgoing => { if (outgoing.url().includes('never-fetch.png')) networkImageRequests++; });
    if (mode !== 'selection') {
      await expect(tool.locator('.desktop-screenshot-overlay')).toBeVisible();
      await expect(tool.locator('.screenshot-studio')).toHaveCount(0);
      await expect(tool.getByText('截图工作台', { exact: true })).toHaveCount(0);
      await tool.getByRole('button', { name: '使用整个屏幕', exact: true }).click();
      await tool.getByRole('button', { name: '图片问答', exact: true }).click();
      expect((await request(tool, { type: 'context' })).source?.desktop).toBeTruthy();
    }
    const chat = tool.locator(mode === 'selection' ? '.selection-messages' : '.screenshot-chat-messages');
    const prompt = tool.getByRole('textbox', { name: mode === 'selection' ? '关于这段文字，想问什么？' : '关于这张截图，想问什么？', exact: true });
    expect(await prompt.evaluate(element => getComputedStyle(element).resize)).toBe('none');
    await prompt.fill('请解释当前内容。'); await tool.getByRole('button', { name: '发送', exact: true }).click();
    await expect(chat.locator('h2')).toHaveText('实时回复'); await expect(chat.locator('.capture-answer-content > .capture-answer-markdown > p strong')).toHaveText('逐步显示');
    if (mode === 'desktop') expect(await chat.locator('.capture-answer-content').evaluate(element => getComputedStyle(element).color)).toBe('rgb(34, 48, 71)');
    expect(ended).toBe(false); expect(received[0]!.stream).toBe(true); expect(received[0]!.store).toBe(false);
    const reasoning = chat.locator('.capture-answer-reasoning'); await expect(reasoning).toHaveCount(1); expect(await reasoning.getAttribute('open')).toBeNull();
    await reasoning.locator('summary').click(); await expect(reasoning.locator('strong')).toHaveText('公开分析摘要'); await expect(reasoning.locator('li')).toContainText('先检查');
    expect(ended).toBe(false); finish!();
    await expect(chat.locator('table tbody tr')).toHaveCount(1); await expect(chat.locator('pre code')).toHaveText('const ready = true;\n');
    await expect(tool.getByRole('button', { name: '停止回答', exact: true })).toHaveCount(0); expect(networkImageRequests).toBe(0);
    expect(await chat.locator('img').count()).toBe(0);
    mkdirSync('artifacts', { recursive: true }); await tool.screenshot({ path: `artifacts/${mode}-streaming-answer.png` });
    if (mode === 'desktop') await tool.locator('.desktop-screenshot-chat').screenshot({ path: 'artifacts/capture-answer-panel-final.png' });
    await prompt.fill('继续说明。'); await tool.getByRole('button', { name: '发送', exact: true }).click();
    await expect(chat.locator('article.is-assistant')).toHaveCount(2); await expect(chat).toContainText('第二轮：已保留前文。');
    expect(received[1]!.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(received[1]!.messages[2]!.content).toBe(FINAL); expect(JSON.stringify(received[1])).not.toContain('STREAM-REASONING-3461');
    await prompt.fill('停止测试'); await tool.getByRole('button', { name: '发送', exact: true }).click(); await expect(chat).toContainText('待停止的部分回复。');
    await tool.getByRole('button', { name: '停止回答', exact: true }).click(); await expect.poll(() => aborted).toBe(1);
    await expect(chat.locator('article.is-assistant')).toHaveCount(2); await expect(chat).not.toContainText('待停止的部分回复。'); await expect(prompt).toHaveValue('停止测试');
    await tool.getByRole('button', { name: mode === 'selection' ? '清空临时对话' : '清空对话', exact: true }).click(); await expect(chat.locator('article')).toHaveCount(0);
    for (const page of [main, web, tool]) expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('STREAM-REASONING-3461');
    await tool.getByRole('button', { name: mode === 'selection' ? '关闭' : '关闭截图', exact: true }).click(); await expect.poll(() => tool.isClosed()).toBe(true);
    await application.close(); application = undefined;
    const logs = path.join(profile, 'logs'); if (existsSync(logs)) for (const file of readdirSync(logs)) if (file.endsWith('.log')) expect(readFileSync(path.join(logs, file), 'utf8')).not.toContain('STREAM-REASONING-3461');
    const evidence = { mode, packaged: Boolean(process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE), actualHttpSse: true, reasoningAndAnswerVisibleBeforeEof: true, markdown: ['heading', 'bold', 'list', 'table', 'code'], blockedRemoteImageRequests: networkImageRequests === 0, finalOnlyMultiTurnHistory: true, cancellationAbortedConnection: aborted, textareaResizeGrip: false, noReasoningInStorageOrLogs: true };
    console.log('CAPTURE_ANSWER_STREAMING_E2E_RESULT', JSON.stringify(evidence)); await testInfo.attach('streaming-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
  } catch (cause) { failed = true; throw cause; }
  finally {
    await application?.close().catch(cause => { if (!failed) cleanupError = cause; }); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    try { cleanup(root); } catch (cause) { if (!failed && !cleanupError) cleanupError = cause; }
  }
  if (cleanupError) throw cleanupError;
});
