import { createServer } from 'node:http';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBrowserApi, BrowserRequest } from '../../src/shared/browser';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

test('native browser agent completes a real page workflow, keeps multi-turn context, resizes/collapses, and independently mutes tabs', async () => {
  test.setTimeout(120000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-browser-ai-e2e-'));
  const requests: Array<Record<string, unknown>> = []; let round = 0; let origin = ''; let targetId = ''; let inputRef = ''; let buttonRef = '';
  const server = createServer((request, response) => {
    if (request.url?.includes('/chat/completions')) {
      let data = ''; request.on('data', chunk => { data += String(chunk); }); request.on('end', () => {
        const body = JSON.parse(data); requests.push(body); round++;
        const messages = body.messages as Array<{ role: string; content: string }>; const last = messages.at(-1)!;
        let name = '', args: unknown = {}, content = '';
        if (round === 1) { name = 'browser_navigate'; args = { url: origin + '/page', newTab: true }; }
        if (round === 2) { targetId = JSON.parse(last.content).tabId; name = 'browser_observe'; args = { tabId: targetId }; }
        if (round === 3) {
          const observed = JSON.parse(last.content); inputRef = observed.elements.find((item: { label: string }) => item.label === 'Search phrase').ref;
          buttonRef = observed.elements.find((item: { label: string }) => item.label === '运行查询').ref;
          name = 'browser_fill'; args = { tabId: targetId, ref: inputRef, text: 'Electron native AI' };
        }
        if (round === 4) { name = 'browser_click'; args = { tabId: targetId, ref: buttonRef }; }
        if (round === 5) { name = 'browser_read'; args = { tabId: targetId, offset: 0, length: 8000 }; }
        if (round === 6) {
          if (!last.content.includes('Result for Electron native AI')) { response.writeHead(500); response.end(); return; }
          name = 'browser_tab'; args = { tabId: targetId, action: 'mute' };
        }
        if (round === 7) content = '已运行查询，页面实际显示 Result for Electron native AI；该标签页也已静音。';
        if (round === 8) { name = 'browser_read'; args = { tabId: targetId, offset: 0, length: 8000 }; }
        if (round >= 9) content = '## 页面核实\n\n再次读取确认：Result for Electron native AI。 [1](' + origin + '/page)\n\n- [x] 实际读取页面\n- [x] 保留上下文\n\n| 检查 | 结果 |\n| --- | --- |\n| 页面内容 | 一致 |\n| 标签声音 | 已静音 |\n\n```typescript\nconst verified = true;\n```\n\n公式：$E=mc^2$\n\n```mermaid\nflowchart LR\n A[读取页面] --> B[核实结果] --> C[形成回复]\n```';
        const delta = name ? { tool_calls: [{ index: 0, id: 'native_' + round, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content };
        response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: '
          + JSON.stringify({ choices: [{ delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      }); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Native browser agent fixture</title><style>body{font:18px system-ui;padding:45px;background:#f6faf8}input,button{padding:12px;margin:8px}#result{margin:30px 8px}</style><h1>Native browser workspace</h1><form method="post"><label>Search phrase <input aria-label="Search phrase" id="query"></label><button id="run">运行查询</button></form><p id="result">No query yet</p><input type="password" value="NEVER_EXPOSE_THIS_PASSWORD"><script>document.querySelector("#run").onclick=(event)=>{event.preventDefault();document.querySelector("#result").textContent="Result for "+document.querySelector("#query").value};</script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing fixture port'); origin = 'http://127.0.0.1:' + address.port;
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') }) });
    const shell = await application.firstWindow(); const native = await application.browserWindow(shell);
    await native.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    await shell.locator('[data-application-module="browser"]').click();
    await expect(shell.locator('.browser-start h1')).toContainText('探索网络');
    await expect(shell.locator('.browser-start .browser-site-mark')).toHaveCount(0);
    const output = path.resolve('.tools/test-output/browser-ai'); await mkdir(output, { recursive: true });
    await shell.screenshot({ path: path.join(output, 'start-page-light.png') });
    type Bridge = { worldlinebox: { browser: WorldlineBoxBrowserApi; llm: WorldlineBoxLlmApi } };
    const config = await shell.evaluate(async baseUrl => (globalThis as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', model: 'native-browser-test-model', baseUrl,
      apiKey: 'local-fixture-only', autoAnalyzeEnabled: false, disclaimerAccepted: true }), origin);
    expect(config.ok).toBe(true);
    const state = async () => shell.evaluate(() => (globalThis as unknown as Bridge).worldlinebox.browser.request({ type: 'state' }));
    const run = async (request: BrowserRequest) => shell.evaluate(request => (globalThis as unknown as Bridge).worldlinebox.browser.request(request), request);
    await shell.getByRole('button', { name: '浏览器 AI', exact: true }).click();
    const field = shell.getByRole('textbox', { name: '与浏览器 AI 对话' });
    // Refresh config after saving it, then let the real model/tool request loop run.
    await run({ type: 'data.info' }); await expect(shell.locator('.browser-ai-chat-toolbar')).toContainText('native-browser-test-model');
    await field.fill('打开测试网页，填写查询并运行，然后静音这个标签页。'); await field.press('Enter');
    await expect(shell.locator('.browser-ai-approval')).toBeVisible();
    expect(round).toBe(4); await run({ type: 'tab.zoom', factor: 1.25 });
    await shell.getByRole('button', { name: '允许这次操作' }).click();
    await expect(shell.locator('.browser-ai-message.is-assistant').last()).toContainText('页面实际显示 Result for Electron native AI');
    await expect.poll(async () => { const result = await state(); return result.ok ? result.state?.ai?.task?.status : ''; }).toBe('completed');
    const page = application.context().pages().find(page => page.url() === origin + '/page')!;
    await expect(page.locator('#result')).toHaveText('Result for Electron native AI');
    expect(await application.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL() === url)?.isAudioMuted(), origin + '/page')).toBe(true);
    expect(JSON.stringify(requests)).not.toContain('NEVER_EXPOSE_THIS_PASSWORD');
    await field.fill('再读取一次页面，确认结果没有变。'); await field.press('Enter');
    await expect(shell.locator('.browser-ai-message.is-assistant').last()).toContainText('再次读取确认');
    await expect(shell.locator('.browser-ai-message .companions-diagram-svg svg')).toBeVisible();
    await expect(shell.locator('.browser-ai-message .browser-markdown-table')).toContainText('已静音');
    await expect(shell.locator('.browser-ai-message .hljs-keyword')).toContainText('const');
    await expect(shell.locator('.browser-ai-message .katex')).toBeVisible();
    await expect(shell.locator('.browser-citation')).toHaveAttribute('title', /Native browser agent fixture/);
    await expect(shell.locator('.browser-ai-sources .browser-source-card')).toContainText('浏览器实读');
    await expect(shell.locator('.browser-source-card-content')).toHaveCount(0);
    await shell.getByRole('button', { name: '阅读正文', exact: true }).click();
    await expect(shell.getByRole('region', { name: '来源正文' })).toContainText('Result for Electron native AI');
    await shell.screenshot({ path: path.join(output, 'native-sources-light.png') });
    await shell.getByRole('button', { name: '收起正文', exact: true }).click();
    await expect(shell.locator('.browser-source-card-content')).toHaveCount(0);
    expect(JSON.stringify(requests.at(-1))).toContain('打开测试网页'); expect(round).toBe(9);

    const before = await shell.locator('[data-browser-viewport]').boundingBox();
    const separator = shell.getByRole('separator', { name: '调整 AI 侧栏宽度' }); await separator.focus(); await separator.press('ArrowLeft');
    await expect.poll(async () => (await shell.locator('[data-browser-viewport]').boundingBox())!.width).toBeLessThan(before!.width);
    const handle = await separator.boundingBox(); const widthBeforeDrag = (await shell.locator('[data-browser-viewport]').boundingBox())!.width;
    await shell.mouse.move(handle!.x + 2, handle!.y + 80); await shell.mouse.down();
    await shell.mouse.move(handle!.x - 70, handle!.y + 80, { steps: 8 }); await shell.mouse.up();
    await expect.poll(async () => (await shell.locator('[data-browser-viewport]').boundingBox())!.width).toBeLessThan(widthBeforeDrag - 30);
    await shell.getByRole('button', { name: '浏览器 AI', exact: true }).click(); await expect(shell.locator('.browser-panel-ai')).toHaveCount(0);
    await shell.getByRole('button', { name: '新建标签页', exact: true }).click();
    await shell.getByRole('button', { name: '恢复页面声音 · Native browser agent fixture', exact: true }).click();
    await expect(shell.locator('.browser-tabs [role="tab"][aria-selected="true"]')).toHaveText('新标签页');
    expect(await application.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL() === url)?.isAudioMuted(), origin + '/page')).toBe(false);
    await shell.getByRole('button', { name: '浏览器 AI', exact: true }).click();
    await shell.screenshot({ path: path.join(output, 'native-chat-light.png') });
    await native.evaluate(window => window.setContentSize(1040, 700));
    await expect.poll(async () => shell.locator('.browser-start').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(shell.locator('.browser-start h1')).toBeVisible();
    await shell.screenshot({ path: path.join(output, 'native-chat-compact.png') });
    await test.info().attach('native-agent-model-requests', { body: JSON.stringify(requests.map(({ messages, model }) => ({ model, messageCount: (messages as unknown[]).length }))), contentType: 'application/json' });
  } finally { await application?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
