import { createServer } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { COMPANION_WEATHER_LABELS } from '../../src/shared/companion-weather';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi } };
const owner = 'deepseek-flash';
function cleanup(root: string) {
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-weather-feedback-')) throw Error('Invalid test cleanup');
  rmSync(absolute, { recursive: true, force: true });
}
async function request(page: Page, input: CompanionsRequest) {
  const result = await page.evaluate(input => (globalThis as unknown as Bridge).worldlinebox.companions.request(input), input);
  expect(result.ok, result.error).toBe(true); return result;
}

test('a native weather check finishes and reports fresh world evidence after leaving the chat, with one retained movement', async () => {
  test.setTimeout(100000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-weather-feedback-'));
  let chatCalls = 0, observationCalls = 0, observedWeather = ''; const failures: string[] = [];
  const server = createServer((incoming, response) => {
    let data = ''; incoming.on('data', chunk => { data += String(chunk); }); incoming.on('end', () => {
      try {
        const body = JSON.parse(data), raw = body.messages?.[1]?.content;
        const text = typeof raw === 'string' ? raw : raw?.find((part: { type: string; text?: string }) => part.type === 'text')?.text;
        const context = JSON.parse(text); let content: unknown = { candidates: [] }; let calls: unknown;
        if (context.purpose === 'world_attention') content = { urgency: 'ordinary', confidence: .99, evidence: [], reason: '普通问题。' };
        else if (context.purpose === 'world_decision') content = { action: null, reason: '没有新的自主安排。', appraisals: [] };
        else if (context.purpose === 'activity_task_step') {
          observationCalls++;
          expect(context.world.actors[0].position).toEqual({ x: 10, y: 15 });
          expect(context.world.environment.weatherStatus).toBe('current');
          expect(context.world.environment.weatherObservedAtVirtual).toBe(context.world.perception.observedAtVirtual);
          observedWeather = context.world.environment.weather;
          content = { status: 'complete', action: null, wait: null, summary: '我到门口看过了，现在是' + context.world.environment.weatherLabel + '。' };
        } else if (context.taskRequest?.prompt === '现在天气怎样？去门口看一眼再告诉我。') {
          chatCalls++;
          if (chatCalls <= 2) calls = [{ id: 'weather_move_' + chatCalls, type: 'function', function: { name: 'world', arguments: JSON.stringify({ action: 'move', destinationId: owner + '_door' }) } }];
          else content = '我到门口核实后告诉你。';
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: calls ? { content: null, tool_calls: calls } : { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }));
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
    const configured = await page.evaluate(baseUrl => (globalThis as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', model: 'deepseek-flash', baseUrl, apiKey: 'local-weather-fixture', autoAnalyzeEnabled: false, disclaimerAccepted: true }), 'http://127.0.0.1:' + address.port);
    expect(configured.ok).toBe(true);
    await page.locator('[data-application-module="companions"]').click();
    const room = (await request(page, { type: 'conversation.open', companionId: owner })).conversation!;
    const scope = { companionId: owner, conversationId: room.id };
    const world = (await request(page, { type: 'world.snapshot' })).world!;
    await request(page, { type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
    const routine = (await request(page, { type: 'routine.get', ...scope })).routine!;
    await request(page, { type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:59', wakeAt: '00:00', meals: [], habits: [] } });
    await request(page, { type: 'world.tool', ...scope, arguments: { action: 'move', destinationId: owner + '_computer' } });
    await expect.poll(async () => (await request(page, { type: 'world.snapshot' })).world!.actors.find(actor => actor.companionId === owner)?.position, { timeout: 20000 }).toEqual({ x: 4, y: 4 });
    const source = (await request(page, { type: 'message.send', conversationId: room.id, content: '现在天气怎样？去门口看一眼再告诉我。', clientId: 'weather-original' })).message!;
    await expect.poll(() => chatCalls, { timeout: 15000 }).toBe(3);
    await page.locator('[data-application-module="browser"]').click();
    await expect.poll(async () => (await request(page, { type: 'activity.list', ...scope, limit: 20 })).activityTasks?.find(task => task.sourceMessageId === source.id)?.status, { timeout: 40000 }).toBe('succeeded');
    expect(failures).toEqual([]); expect(observationCalls).toBe(1);
    const tasks = (await request(page, { type: 'activity.list', ...scope, limit: 20 })).activityTasks!.filter(task => task.sourceMessageId === source.id);
    expect(tasks).toHaveLength(1); expect(tasks[0]!.history.filter(step => step.action === 'move')).toHaveLength(1);
    const report = (await request(page, { type: 'messages', conversationId: room.id })).messages!.filter(message => message.replyToId === source.id && message.content.includes('我到门口看过了'));
    expect(report).toHaveLength(1);
    const actual = (await request(page, { type: 'world.snapshot' })).world!;
    expect(observedWeather).toBe(actual.environment.weather);
    expect(report[0]!.content).toContain(COMPANION_WEATHER_LABELS[actual.environment.weather!]);
    await page.locator('[data-application-module="companions"]').click(); await request(page, { type: 'conversation.open', companionId: owner });
    await expect(page.locator('[data-companion-messages]')).toContainText(report[0]!.content);
    const output = path.resolve('.tools/test-output/companions'); mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'verified-weather-feedback.png') });
    const evidence = { packaged: await app.evaluate(({ app }) => app.isPackaged), chatCalls, observationCalls,
      movementCount: 1, reportCount: report.length, questionCount: 1, observedWeather, authoritativeWeather: actual.environment.weather, completedWithChatHidden: true };
    writeFileSync(path.join(output, 'verified-weather-feedback.json'), JSON.stringify(evidence, null, 2));
    console.log('COMPANION_WEATHER_FEEDBACK_RESULT', JSON.stringify(evidence));
  } finally {
    await app?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    cleanup(root);
  }
});
