import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi } };
const owner = 'deepseek-flash', prompt = '空步骤排版验收', first = '我先核对一下当前状态。', last = '状态已经核对，现在可以继续聊天。';
function cleanup(root: string) {
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-reply-spacing-')) throw Error('Invalid test cleanup');
  rmSync(absolute, { recursive: true, force: true });
}
async function request(page: Page, input: CompanionsRequest) {
  const result = await page.evaluate(input => (globalThis as unknown as Bridge).worldlinebox.companions.request(input), input);
  expect(result.ok, result.error).toBe(true); return result;
}

test('empty native tool turns add no blank space while streaming, after commit or after reopening saved replies', async () => {
  test.setTimeout(90000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-reply-spacing-'));
  const failures: string[] = []; let chatCalls = 0, beginText: (() => void) | undefined, finish: (() => void) | undefined;
  const server = createServer((incoming, response) => {
    let data = ''; incoming.on('data', chunk => { data += String(chunk); }); incoming.on('end', () => {
      try {
        const body = JSON.parse(data), raw = body.messages?.[1]?.content;
        const context = JSON.parse(typeof raw === 'string' ? raw : raw?.find((part: { type: string; text?: string }) => part.type === 'text')?.text);
        let content: unknown = { candidates: [] }; let calls: unknown;
        if (context.purpose === 'world_attention') content = { urgency: 'ordinary', confidence: .99, evidence: [], reason: '普通问题。' };
        else if (context.purpose === 'world_decision') content = { action: null, reason: '没有新的自主安排。', appraisals: [] };
        else if (context.taskRequest?.prompt === prompt) {
          const step = chatCalls++;
          if (step < 9) {
            content = step === 6 ? first : null;
            calls = [{ id: 'spacing_inspect_' + step, type: 'function', function: { name: 'world', arguments: '{"action":"inspect"}' } }];
          } else {
            response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); response.flushHeaders();
            const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] }) + '\n\n');
            beginText = () => chunk({ role: 'assistant', content: last.slice(0, 8) });
            finish = () => { chunk({ content: last.slice(8) }); chunk({}, 'stop'); response.end('data: [DONE]\n\n'); };
            return;
          }
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' || content === null ? content : JSON.stringify(content), ...(calls ? { tool_calls: calls } : {}) } }] }));
      } catch (error) { failures.push(String(error)); response.writeHead(500); response.end('Fixture assertion failed'); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture port unavailable');
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') }) });
    const page = await app.firstWindow(), native = await app.browserWindow(page);
    await native.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    expect((await page.evaluate(baseUrl => (globalThis as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', model: 'spacing-fixture', baseUrl, apiKey: 'local-spacing-fixture', autoAnalyzeEnabled: false, disclaimerAccepted: true }), 'http://127.0.0.1:' + address.port)).ok).toBe(true);
    await page.locator('[data-application-module="companions"]').click();
    const room = (await request(page, { type: 'conversation.open', companionId: owner })).conversation!;
    const scope = { companionId: owner, conversationId: room.id }, routine = (await request(page, { type: 'routine.get', ...scope })).routine!;
    await request(page, { type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { sleepAt: '23:59', wakeAt: '00:00', meals: [], habits: [] } });
    const source = (await request(page, { type: 'message.send', conversationId: room.id, content: prompt, clientId: 'spacing-original' })).message!;
    await expect.poll(() => !!finish, { timeout: 30000 }).toBe(true);
    const reply = (await request(page, { type: 'messages', conversationId: room.id })).messages!.find(message => message.replyToId === source.id && message.authorId === owner)!;
    const bubble = page.locator(`[data-companion-message="${reply.id}"] .companions-message-bubble`);
    await expect(bubble.locator('[data-loop-step]')).toHaveCount(2);
    expect(await bubble.locator('[data-loop-step]').evaluateAll(elements => elements.map(element => element.getAttribute('data-loop-step')))).toEqual(['6', '9']);
    await expect(bubble.getByLabel('伙伴正在输出')).toHaveCount(1);
    expect(await bubble.locator('.companions-loop-pending').count()).toBe(0);
    beginText!(); await expect(bubble).toContainText(last.slice(0, 8));
    async function geometry() {
      return bubble.evaluate(element => {
        const rect = element.getBoundingClientRect(), contents = [...element.querySelectorAll('.companions-message-content')].map(item => item.getBoundingClientRect());
        return { height: rect.height, top: contents[0]!.top - rect.top, gap: contents[1]!.top - contents[0]!.bottom, segments: element.querySelectorAll('[data-loop-step]').length };
      });
    }
    const streaming = await geometry(); expect(streaming.top).toBeLessThan(20); expect(streaming.gap).toBeLessThan(20);
    const output = path.resolve('.tools/test-output/companions'); mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'verified-reply-spacing-streaming.png') });
    finish!();
    await expect.poll(async () => (await request(page, { type: 'messages', conversationId: room.id })).messages!.find(message => message.id === reply.id)?.isReplyDraft).not.toBe(true);
    await expect(bubble).toContainText(last); await expect(bubble.getByLabel('伙伴正在输出')).toHaveCount(0);
    const completed = await geometry(); expect(completed.top).toBeLessThan(20); expect(completed.gap).toBeLessThan(20);
    // Reopen from SQLite after the renderer and its in-memory stream overlay have gone away.
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    await request(page, { type: 'conversation.open', companionId: owner });
    await expect(bubble).toContainText(last); const reopened = await geometry();
    expect(reopened.top).toBeLessThan(20); expect(reopened.gap).toBeLessThan(20); expect(reopened.segments).toBe(2);
    expect(failures).toEqual([]); expect(chatCalls).toBe(10);
    const saved = (await request(page, { type: 'messages', conversationId: room.id })).messages!.find(message => message.id === reply.id)!;
    expect(saved.segments).toHaveLength(10); expect(saved.content).toBe(first + '\n\n' + last);
    await page.screenshot({ path: path.join(output, 'verified-reply-spacing.png') });
    const evidence = { packaged: await app.evaluate(({ app }) => app.isPackaged), chatCalls, persistedSteps: saved.segments!.length, streaming, completed, reopened };
    writeFileSync(path.join(output, 'verified-reply-spacing.json'), JSON.stringify(evidence, null, 2));
    console.log('COMPANION_REPLY_SPACING_RESULT', JSON.stringify(evidence));
  } finally { await app?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); cleanup(root); }
});
