import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CaptureToolsRequest, WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = { worldlinebox: { captureTools: WorldlineBoxCaptureToolsApi; llm: WorldlineBoxLlmApi } };
type Wire = { model: string; store?: boolean; messages: Array<{ role: string; content: string }>; previous_response_id?: string; conversation?: string };
const PASSAGE = 'A temporary selected passage about asynchronous tasks and cancellation.';
const CLIPBOARD_TEXT = 'Manual clipboard text for the temporary selection assistant.';
async function request(page: Page, input: CaptureToolsRequest) {
  const result = await page.evaluate(input => (globalThis as unknown as Bridge).worldlinebox.captureTools.request(input), input);
  if (!result.ok) throw Error(result.error); return result;
}
async function toolPage(application: ElectronApplication): Promise<Page> {
  await expect.poll(() => application.windows().some(page => page.url().includes('window=capture-tools')), { timeout: 15000 }).toBe(true);
  const tool = application.windows().find(page => page.url().includes('window=capture-tools'))!;
  await expect(tool.locator('[data-selection-assistant]')).toBeVisible(); return tool;
}
function cleanup(root: string) {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('worldlinebox-selection-e2e-')) throw Error('Unexpected selection fixture cleanup path');
  rmSync(target, { force: true, recursive: true, maxRetries: 8, retryDelay: 400 });
}
async function selectPassage(page: Page) {
  await page.locator('#passage').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selected = window.getSelection(); selected?.removeAllRanges(); selected?.addRange(range); });
}

// No real provider or personal credentials are used. The production global
// encrypted model settings, browser WebContentsView, IPC and Main HTTP client
// send requests to this bounded local test provider.
// eslint-disable-next-line no-empty-pattern
test('selected browser text opens an isolated temporary assistant with two-turn global LLM context and explicit manual fallback', async ({}, testInfo) => {
  test.setTimeout(150000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-selection-e2e-')); const profile = path.join(root, 'profile');
  const received: Wire[] = []; let slowStarted = 0; let slowAborted = 0;
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/selection') {
      outgoing.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      outgoing.end(`<!doctype html><html><head><title>Selection assistant fixture</title></head><body style="padding:25px;font:20px/1.7 Segoe UI"><p id="passage" style="max-width:600px">${PASSAGE}</p><textarea id="editable">Prefix selected input text suffix</textarea><input id="secret" type="password" value="private-password-must-not-be-read"></body></html>`); return;
    }
    if (incoming.method === 'POST' && incoming.url === '/model/chat/completions') {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of incoming) { bytes += chunk.length; if (bytes > 150000) { outgoing.writeHead(413); outgoing.end(); return; } chunks.push(Buffer.from(chunk)); }
      const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire;
      if (wire.messages.some(item => typeof item.content === 'string' && item.content.includes('selected_text'))) {
        received.push(wire);
        if (wire.messages.at(-1)?.content.includes('等待直到取消')) { slowStarted++; outgoing.once('close', () => { if (!outgoing.writableEnded) slowAborted++; }); return; }
      }
      const answer = wire.messages.filter(item => item.role === 'user').length > 1 ? '答复二：可以把它理解为可以取消的异步工作。' : '答复一：这段文字介绍了异步任务和取消。';
      outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] })); return;
    }
    if (incoming.url === '/model/models') { outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] })); return; }
    outgoing.writeHead(404); outgoing.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing local selection fixture address');
  const origin = `http://127.0.0.1:${address.port}`;
  let application: ElectronApplication | undefined;
  let clipboardBefore: { text: string; html: string; rtf: string; image: string } | undefined;
  let failed = false; let cleanupError: unknown;
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
    const main = await application.firstWindow(); await expect(main.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 30000 });
    const native = await application.browserWindow(main); await native.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    const configured = await main.evaluate(baseUrl => (globalThis as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', model: 'deepseek-v4-pro', baseUrl, apiKey: 'selection-fixture-encrypted-key' }), origin + '/model');
    expect(configured.ok).toBe(true);
    const publicConfig = await main.evaluate(() => (globalThis as unknown as Bridge).worldlinebox.llm.getConfig()); expect(JSON.stringify(publicConfig)).not.toContain('selection-fixture-encrypted-key');
    await main.locator('[data-application-module="browser"]').click();
    const location = main.getByRole('textbox', { name: '搜索或输入网址' }); await location.fill(origin + '/selection'); await location.press('Enter');
    await expect.poll(() => application!.context().pages().some(page => page.url() === origin + '/selection')).toBe(true);
    const web = application.context().pages().find(page => page.url() === origin + '/selection')!;
    await expect(web.locator('#passage')).toHaveText(PASSAGE); await selectPassage(web);
    expect(await web.evaluate(() => typeof Reflect.get(globalThis, 'worldlinebox'))).toBe('undefined');
    await main.getByRole('button', { name: '划词助手', exact: true }).click(); let tool = await toolPage(application);
    expect((await request(tool, { type: 'context' })).text).toBe(PASSAGE);
    await expect(tool.locator('.selection-source-summary')).toHaveText(PASSAGE);
    expect((await request(tool, { type: 'state' })).state!.ai).toMatchObject({ configured: true, model: 'deepseek-v4-pro', visionSupported: false });
    expect(received).toHaveLength(0);
    expect(await tool.evaluate(() => Object.keys((globalThis as unknown as Bridge).worldlinebox))).toEqual(['captureTools']);
    const firstQuestion = '请解释这段文字。'; await tool.getByRole('textbox', { name: '关于这段文字，想问什么？', exact: true }).fill(firstQuestion); await tool.getByRole('button', { name: '发送', exact: true }).click();
    await expect(tool.locator('.selection-messages article.is-assistant')).toHaveCount(1); await expect(tool.locator('.selection-messages article.is-assistant p')).toHaveText('答复一：这段文字介绍了异步任务和取消。');
    await tool.getByRole('textbox', { name: '关于这段文字，想问什么？', exact: true }).fill('能再举一个例子吗？'); await tool.getByRole('button', { name: '发送', exact: true }).click();
    await expect(tool.locator('.selection-messages article.is-assistant')).toHaveCount(2);
    expect(received).toHaveLength(2); expect(received[1]!.model).toBe('deepseek-v4-pro'); expect(received[1]!.store).toBe(false);
    expect(received[1]!.messages.map(item => item.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(JSON.parse(received[1]!.messages[1]!.content)).toEqual({ selected_text: PASSAGE, question: firstQuestion });
    expect(received[1]!.messages[2]!.content).toContain('答复一'); expect(received[1]).not.toHaveProperty('previous_response_id'); expect(received[1]).not.toHaveProperty('conversation');
    expect(JSON.stringify(received)).not.toContain('image_url');
    expect(await tool.evaluate(() => Object.values(localStorage).join('\n') + Object.values(sessionStorage).join('\n'))).not.toContain(PASSAGE);
    await tool.screenshot({ path: '.tools/test-output/selection-assistant-two-turn.png' });
    await tool.getByRole('textbox', { name: '关于这段文字，想问什么？', exact: true }).fill('等待直到取消'); await tool.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => slowStarted).toBe(1); await tool.getByRole('button', { name: '停止回答', exact: true }).click();
    await expect.poll(() => slowAborted).toBe(1); await expect(tool.locator('.selection-messages article')).toHaveCount(4);
    await expect(tool.getByRole('textbox', { name: '关于这段文字，想问什么？', exact: true })).toHaveValue('等待直到取消');
    await tool.getByRole('button', { name: '关闭', exact: true }).click(); await expect.poll(() => tool.isClosed()).toBe(true);

    // The actual native context menu obtains Chromium's selected text and opens
    // a fresh assistant. Only clicking the native menu item is automated here.
    await selectPassage(web);
    await application.evaluate(({ Menu }) => {
      const prototype = Menu.prototype; const popup = prototype.popup;
      prototype.popup = function(options) {
        const action = this.items.find(item => item.label === 'AI 划词助手');
        if (action) { prototype.popup = popup; action.click(action, undefined, undefined); } else popup.call(this, options);
      };
    });
    const passageBounds = await web.locator('#passage').boundingBox(); if (!passageBounds) throw Error('Missing selected passage bounds');
    await web.mouse.click(passageBounds.x + 12, passageBounds.y + 12, { button: 'right' }); tool = await toolPage(application);
    await expect(tool.locator('.selection-messages article')).toHaveCount(0); await expect(tool.locator('.selection-source-summary')).toHaveText(PASSAGE);
    expect(received).toHaveLength(3); // two answered requests plus the cancelled request
    await tool.getByRole('button', { name: '关闭', exact: true }).click(); await expect.poll(() => tool.isClosed()).toBe(true);

    clipboardBefore = await application.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage().toDataURL() }));
    await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), CLIPBOARD_TEXT);
    await web.locator('#secret').focus(); await web.locator('#secret').evaluate((input: HTMLInputElement) => input.setSelectionRange(0, input.value.length));
    await request(main, { type: 'open', task: 'selection', source: 'browser' }); tool = await toolPage(application);
    await expect(tool.getByRole('textbox', { name: '选中的文字', exact: true })).toHaveValue('');
    expect((await request(tool, { type: 'context' })).text).toBe('');
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(CLIPBOARD_TEXT);
    await tool.getByRole('button', { name: '粘贴剪贴板', exact: true }).click(); await expect(tool.getByRole('textbox', { name: '选中的文字', exact: true })).toHaveValue(CLIPBOARD_TEXT);
    expect(received).toHaveLength(3); // explicit paste still does not send a question
    await tool.getByRole('textbox', { name: '关于这段文字，想问什么？', exact: true }).fill('请概括。'); await tool.getByRole('button', { name: '发送', exact: true }).click(); await expect(tool.locator('.selection-messages article.is-assistant')).toHaveCount(1);
    await tool.getByRole('button', { name: '清空临时对话', exact: true }).click(); await expect(tool.locator('.selection-messages article')).toHaveCount(0);
    await tool.getByRole('button', { name: '关闭', exact: true }).click(); await expect.poll(() => tool.isClosed()).toBe(true);
    const denied = await main.evaluate(() => (globalThis as unknown as Bridge).worldlinebox.captureTools.request({ type: 'selection.ask', id: 'main-denied', selection: 'private', messages: [{ role: 'user', content: 'ask' }] })); expect(denied.ok).toBe(false);
    const logs = path.join(profile, 'logs');
    if (existsSync(logs)) for (const name of readdirSync(logs)) if (name.endsWith('.log')) { const text = readFileSync(path.join(logs, name), 'utf8'); expect(text).not.toContain(PASSAGE); expect(text).not.toContain('答复一：'); expect(text).not.toContain('selection-fixture-encrypted-key'); }
    const evidence = { realBrowserDomSelection: true, nativeContextMenu: true, temporaryTwoTurnTextOnly: true, chosenModel: 'deepseek-v4-pro', cancelledHttpRequest: slowAborted,
      passwordSelectionRejected: true, clipboardReadOnlyOnExplicitPaste: true, noAutomaticAsk: true, stateAndAppLogsContainNoConversation: true, providerRequests: received.length };
    console.log('SELECTION_ASSISTANT_E2E_RESULT', JSON.stringify(evidence)); await testInfo.attach('selection-assistant-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
  } catch (cause) { failed = true; throw cause; }
  finally {
    if (application && clipboardBefore) await application.evaluate(({ clipboard, nativeImage }, previous) => clipboard.write({ text: previous.text, html: previous.html, rtf: previous.rtf, image: nativeImage.createFromDataURL(previous.image) }), clipboardBefore).catch(() => undefined);
    await application?.close().catch(cause => { if (!failed) cleanupError = cause; }); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    try { cleanup(root); } catch (cause) { if (!failed && !cleanupError) cleanupError = cause; }
  }
  if (cleanupError) throw cleanupError;
});
