import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CaptureToolsRequest, WorldlineBoxCaptureToolsApi } from '../../src/shared/capture-tools';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = { worldlinebox: { captureTools: WorldlineBoxCaptureToolsApi; llm?: WorldlineBoxLlmApi } };
type Part = { type: string; text?: string; image_url?: { url: string; detail?: string } };
type Wire = { model: string; messages: Array<{ role: string; content: string | Part[] }>; previous_response_id?: string; conversation?: string };
const KEY = 'screenshot-conversation-fixture-encrypted-key';
const FIRST = '请描述当前已打码截图。SCQA-FIRST-67291';
const SECOND = '新加的遮盖在哪？结合前面的回答说明。SCQA-SECOND-67291';
const CANCEL = '等待直到取消。SCQA-CANCEL-67291';
const ANSWER_ONE = '临时图答一：画面有蓝绿色背景和一处黑色遮盖。SCQA-ANSWER-67291';
const ANSWER_TWO = '临时图答二：新增遮盖在右下区域，之前的遮盖仍在。SCQA-FOLLOWUP-67291';
const LATE = '取消后的迟到回答不应显示。SCQA-LATE-67291';

async function request(page: Page, input: CaptureToolsRequest) {
  const result = await page.evaluate(input => (globalThis as unknown as Bridge).worldlinebox.captureTools.request(input), input);
  if (!result.ok) throw Error(result.error); return result;
}
async function toolPage(application: ElectronApplication): Promise<Page> {
  await expect.poll(() => application.windows().some(page => page.url().includes('window=capture-tools')), { timeout: 15000 }).toBe(true);
  const tool = application.windows().find(page => page.url().includes('window=capture-tools'))!;
  await expect(tool.locator('.desktop-screenshot-overlay')).toBeVisible();
  await expect(tool.locator('.screenshot-studio')).toHaveCount(0);
  await expect(tool.getByText('截图工作台', { exact: true })).toHaveCount(0);
  return tool;
}
async function redact(tool: Page, from: number, to: number) {
  const redact = tool.getByRole('button', { name: '遮盖', exact: true });
  if (await redact.getAttribute('aria-pressed') !== 'true') await redact.click();
  const bounds = await tool.getByLabel('截图编辑画布', { exact: true }).boundingBox(); if (!bounds) throw Error('Missing real screenshot canvas');
  await tool.mouse.move(bounds.x + bounds.width * from, bounds.y + bounds.height * from); await tool.mouse.down();
  await tool.mouse.move(bounds.x + bounds.width * to, bounds.y + bounds.height * to, { steps: 6 }); await tool.mouse.up();
}
function imageOf(wire: Wire): string {
  const content = wire.messages.at(-1)?.content;
  if (!Array.isArray(content)) throw Error('Expected image-bearing final user message');
  const image = content.find(part => part.type === 'image_url')?.image_url;
  expect(image?.detail).toBe('high'); expect(image?.url).toMatch(/^data:image\/jpeg;base64,/); return image!.url;
}
async function pixel(dataUrl: string, fraction: number): Promise<number[]> {
  const bytes = Buffer.from(dataUrl.split(',')[1]!, 'base64'); const meta = await sharp(bytes).metadata();
  expect(meta.format).toBe('jpeg'); expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1600);
  return [...await sharp(bytes).extract({ left: Math.floor(meta.width! * fraction), top: Math.floor(meta.height! * fraction), width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
}
async function storage(page: Page): Promise<string> { return page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })); }
function cleanup(root: string) {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('worldlinebox-screenshot-qa-')) throw Error('Unexpected screenshot fixture cleanup path');
  rmSync(target, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
}

// Real packaged app, native desktop capture, edited Canvas pixels and
// Main HTTP inference. Only the external provider is replaced by a local server.
// eslint-disable-next-line no-empty-pattern
test('desktop screenshot conversation sends edited pixels and temporary two-turn history, cancels and clears safely', async ({}, testInfo) => {
  test.setTimeout(150000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-screenshot-qa-')); const profile = path.join(root, 'profile');
  const received: Wire[] = []; let slowAborted = 0; let lateAttempt = 0; let authenticated = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/screenshot') {
      outgoing.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      outgoing.end('<!doctype html><html><head><title>Screenshot conversation fixture</title></head><body style="margin:0;background:#36bad3;font:32px Segoe UI;color:#102e48"><h1 style="padding:30px">Real browser screenshot fixture</h1><p style="padding:30px">Current pixels, not a generated screenshot.</p></body></html>'); return;
    }
    if (incoming.url === '/model/models') { outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }] })); return; }
    if (incoming.method === 'POST' && incoming.url === '/model/chat/completions') {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of incoming) { bytes += chunk.length; if (bytes > 6_000_000) { outgoing.writeHead(413); outgoing.end(); return; } chunks.push(Buffer.from(chunk)); }
      const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire;
      if (!wire.messages.some(item => Array.isArray(item.content) && item.content.some(part => part.type === 'image_url'))) { outgoing.writeHead(400); outgoing.end(); return; }
      received.push(wire); if (incoming.headers.authorization === 'Bearer ' + KEY) authenticated++;
      const answer = wire.messages.filter(item => item.role === 'user').length > 1 ? ANSWER_TWO : ANSWER_ONE;
      const reply = (content: string) => { outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] })); };
      if (JSON.stringify(wire.messages.at(-1)?.content).includes(CANCEL)) {
        outgoing.once('close', () => { if (!outgoing.writableEnded) slowAborted++; });
        const timer = setTimeout(() => { timers.delete(timer); lateAttempt++; if (!outgoing.destroyed) reply(LATE); }, 900); timers.add(timer); return;
      }
      reply(answer); return;
    }
    outgoing.writeHead(404); outgoing.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing screenshot fixture address');
  const origin = `http://127.0.0.1:${address.port}`; let application: ElectronApplication | undefined; let failed = false; let cleanupError: unknown;
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
    const main = await application.firstWindow(); await expect(main.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page', { timeout: 30000 });
    const native = await application.browserWindow(main); await native.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    const configured = await main.evaluate(({ baseUrl, apiKey }) => (globalThis as unknown as Bridge).worldlinebox.llm!.setConfig({ apiFormat: 'openai_chat', model: 'deepseek-flash', baseUrl, apiKey }), { baseUrl: origin + '/model', apiKey: KEY }); expect(configured.ok).toBe(true);
    expect(JSON.stringify(await main.evaluate(() => (globalThis as unknown as Bridge).worldlinebox.llm!.getConfig()))).not.toContain(KEY);
    await main.locator('[data-application-module="browser"]').click(); const location = main.getByRole('textbox', { name: '搜索或输入网址' }); await location.fill(origin + '/screenshot'); await location.press('Enter');
    await expect.poll(() => application!.context().pages().some(page => page.url() === origin + '/screenshot')).toBe(true);
    const web = application.context().pages().find(page => page.url() === origin + '/screenshot')!; await expect(web.getByRole('heading')).toHaveText('Real browser screenshot fixture');
    expect(await web.evaluate(() => typeof Reflect.get(globalThis, 'worldlinebox'))).toBe('undefined');
    // Both the current toolbar and a retained source:'browser' caller must open
    // the same native desktop overlay, never the removed container editor.
    const openScreenshot = async (legacyBrowserSource = false) => {
      if (legacyBrowserSource) await request(main, { type: 'open', task: 'screenshot', source: 'browser' });
      else await main.locator('.browser-toolbar').getByRole('button', { name: '截图', exact: true }).click();
    };
    const selectAll = async (page: Page) => page.getByRole('button', { name: '使用整个屏幕', exact: true }).click();
    await openScreenshot(); let tool = await toolPage(application);
    const context = await request(tool, { type: 'context' });
    expect(context.source?.url).toBe(''); expect(context.source?.desktop).toBeTruthy();
    expect(context.state!.ai).toMatchObject({ configured: true, model: 'deepseek-flash' }); expect(context.state!.ai.visionSupported).not.toBe(false);
    expect(await tool.evaluate(() => ({ keys: Object.keys((globalThis as unknown as Bridge).worldlinebox), process: typeof Reflect.get(globalThis, 'process'), require: typeof Reflect.get(globalThis, 'require') }))).toEqual({ keys: ['captureTools'], process: 'undefined', require: 'undefined' });
    expect(JSON.stringify(context)).not.toContain(KEY); expect(received).toHaveLength(0);
    await selectAll(tool);
    // A real desktop may already be black at the later redaction probe.
    // Draw a visible mark through the actual tool instead of assuming the
    // user's wallpaper/window color or substituting a generated source.
    await tool.getByRole('button', { name: '画笔', exact: true }).click();
    await tool.getByRole('button', { name: '标注颜色 #ffffff', exact: true }).click();
    await tool.getByRole('slider', { name: '笔画粗细', exact: true }).press('End');
    const bounds = await tool.getByLabel('截图编辑画布', { exact: true }).boundingBox();
    if (!bounds) throw Error('Missing real desktop edit canvas');
    await tool.mouse.move(bounds.x + bounds.width * .58, bounds.y + bounds.height * .6); await tool.mouse.down();
    await tool.mouse.move(bounds.x + bounds.width * .62, bounds.y + bounds.height * .6, { steps: 8 }); await tool.mouse.up();
    await redact(tool, .15, .35);
    await tool.getByRole('button', { name: '图片问答', exact: true }).click();
    const prompt = () => tool.getByRole('textbox', { name: '关于这张截图，想问什么？', exact: true });
    await tool.getByRole('button', { name: '提取文字', exact: true }).click(); expect(received).toHaveLength(0);
    await prompt().fill(FIRST); await tool.getByRole('button', { name: '发送', exact: true }).click();
    await expect(tool.locator('.screenshot-chat-messages article.is-assistant p')).toHaveText(ANSWER_ONE);
    expect(received).toHaveLength(1); expect(received[0]!.model).toBe('deepseek-flash'); expect(received[0]!.messages.map(item => item.role)).toEqual(['system', 'user']);
    const imageOne = imageOf(received[0]!); expect((await pixel(imageOne, .25)).every(value => value <= 5)).toBe(true); expect((await pixel(imageOne, .6)).some(value => value > 30)).toBe(true);
    await redact(tool, .52, .72); await prompt().fill(SECOND); await tool.getByRole('button', { name: '发送', exact: true }).click();
    await expect(tool.locator('.screenshot-chat-messages article.is-assistant')).toHaveCount(2);
    expect(received).toHaveLength(2); expect(received[1]!.messages.map(item => item.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(received[1]!.messages[1]!.content).toBe(FIRST); expect(received[1]!.messages[2]!.content).toBe(ANSWER_ONE);
    expect(received[1]).not.toHaveProperty('previous_response_id'); expect(received[1]).not.toHaveProperty('conversation');
    const imageTwo = imageOf(received[1]!); expect(imageTwo === imageOne, 'The second request must include the newly edited pixels').toBe(false); expect((await pixel(imageTwo, .6)).every(value => value <= 5)).toBe(true);
    for (const page of [main, web, tool]) for (const secret of [FIRST, SECOND, ANSWER_ONE, ANSWER_TWO, KEY]) expect(await storage(page)).not.toContain(secret);
    mkdirSync('.tools/test-output', { recursive: true }); await tool.screenshot({ path: '.tools/test-output/screenshot-conversation-two-turn.png' });
    await prompt().fill(CANCEL); await tool.getByRole('button', { name: '发送', exact: true }).click(); await expect.poll(() => received.length).toBe(3);
    await tool.getByRole('button', { name: '停止回答', exact: true }).click(); await expect.poll(() => slowAborted).toBe(1); await expect.poll(() => lateAttempt).toBe(1);
    expect(received).toHaveLength(3); await expect(tool.locator('.screenshot-chat-messages article')).toHaveCount(4); await expect(prompt()).toHaveValue(CANCEL); await expect(tool.locator('.screenshot-chat-messages')).not.toContainText(LATE);
    await tool.getByRole('button', { name: '清空对话', exact: true }).click(); await expect(tool.locator('.screenshot-chat-messages article')).toHaveCount(0);
    await prompt().fill('清空后的新问题。SCQA-FRESH-67291'); await tool.getByRole('button', { name: '发送', exact: true }).click(); await expect(tool.locator('.screenshot-chat-messages article.is-assistant')).toHaveCount(1);
    expect(received).toHaveLength(4); expect(received[3]!.messages.map(item => item.role)).toEqual(['system', 'user']); expect(JSON.stringify(received[3])).not.toContain(FIRST); expect(JSON.stringify(received[3])).not.toContain(CANCEL);
    await tool.getByRole('button', { name: '关闭截图', exact: true }).click(); await expect.poll(() => tool.isClosed()).toBe(true);
    await openScreenshot(true); tool = await toolPage(application);
    const legacyContext = await request(tool, { type: 'context' });
    expect(legacyContext.source?.desktop).toBeTruthy(); expect(legacyContext.source?.url).toBe('');
    await selectAll(tool); await tool.getByRole('button', { name: '图片问答', exact: true }).click(); await expect(tool.locator('.screenshot-chat-messages article')).toHaveCount(0); await expect(prompt()).toHaveValue(''); expect(received).toHaveLength(4);
    expect(JSON.stringify(await request(tool, { type: 'context' }))).not.toContain(FIRST);
    for (const secret of [FIRST, SECOND, CANCEL, ANSWER_ONE, ANSWER_TWO, KEY]) expect(await storage(tool)).not.toContain(secret);
    await tool.getByRole('button', { name: '关闭截图', exact: true }).click(); await expect.poll(() => tool.isClosed()).toBe(true);
    expect(authenticated).toBe(4); await application.close(); application = undefined;
    const logs = path.join(profile, 'logs'); if (existsSync(logs)) for (const name of readdirSync(logs)) if (name.endsWith('.log')) { const text = readFileSync(path.join(logs, name), 'utf8'); for (const secret of [FIRST, SECOND, CANCEL, ANSWER_ONE, ANSWER_TWO, KEY]) expect(text).not.toContain(secret); }
    const evidence = { mode: 'desktop', packaged: Boolean(process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE), desktopOverlayFromBrowserToolbar: true, legacyBrowserSourceUsesDesktop: true, removedContainerEditorAbsent: true, currentEditedPixels: true, genuineMainHttpRequests: received.length, selectedModel: 'deepseek-flash', twoTurnHistory: true, cancelledConnection: slowAborted, noAutomaticRetry: true, clearStartsFreshHistory: true, closeStartsEmptySession: true, noChatInStorageOrAppLogs: true, keyOnlyInMainHttpHeader: true };
    console.log('SCREENSHOT_CONVERSATION_E2E_RESULT', JSON.stringify(evidence)); await testInfo.attach('screenshot-conversation-evidence', { body: JSON.stringify(evidence), contentType: 'application/json' });
  } catch (cause) { failed = true; throw cause; }
  finally {
    await application?.close().catch(cause => { if (!failed) cleanupError = cause; }); for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    try { cleanup(root); } catch (cause) { if (!failed && !cleanupError) cleanupError = cause; }
  }
  if (cleanupError) throw cleanupError;
});
