import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { CompanionMessage, CompanionReplyStreamEvent, CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, ensureCompanionTestWorkspace, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi }; progressEvidence?: CompanionReplyStreamEvent[] };

// The network fixture controls model response timing only. Durable work, world
// readiness, passive recall, native read_file, streaming, cancellation and retry
// all run through the actual application and its own selected library.
// eslint-disable-next-line no-empty-pattern
test('keeps three group reply bubbles independent through actual tools, streaming, waiting, targeted cancellation and retry', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-parallel-progress-')), profile = path.join(root, 'profile');
  const sourceFile = path.join(root, '可读验收资料.txt'); writeFileSync(sourceFile, '真实工具结果：这是一份由本次夹具创建的文本资料。', 'utf8');
  const roles = new Map<string, 'tool' | 'stream' | 'waiting'>(), held = new Map<string, () => void>(), counts = new Map<string, number>();
  const released = new Set<string>();
  const toolReceipts: string[] = [], socialReviews: string[] = [];
  const server = createServer((request, response) => {
    let raw = ''; request.setEncoding('utf8'); request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      try {
        const payload = JSON.parse(raw) as { messages: Array<{ role: string; content: string; tool_call_id?: string }> };
        const user = payload.messages.findLast(message => message.role === 'user')?.content ?? '{}';
        let context: { purpose?: string; proposedText?: string; source?: { id?: string }; conversation?: { replyingAs: string } };
        try { context = JSON.parse(user); } catch { json(response, '[[Tag: 验收]]'); return; }
        if (context.purpose === 'companion_social_progress_review') {
          expect(typeof context.proposedText).toBe('string'); socialReviews.push(context.proposedText!);
          json(response, JSON.stringify({ supported: true, correction: '' })); return;
        }
        if (context.purpose) {
          const text = context.purpose === 'world_attention' ? JSON.stringify({ urgency: 'ordinary', confidence: .99, evidence: [], reason: '无紧急打断。' })
            : context.purpose === 'world_social' ? JSON.stringify({ text: null, reason: '不扩展本例话题。' })
              : context.purpose === 'world_decision' ? JSON.stringify({ action: null, reason: '当前无新的世界行动。', appraisals: [] })
                : JSON.stringify({ notes: [], dream: null });
          json(response, text); return;
        }
        const owner = context.conversation?.replyingAs ?? '', role = roles.get(owner);
        const tool = payload.messages.find(message => message.role === 'tool');
        if (tool) { toolReceipts.push(tool.content); json(response, '甲已读取真实资料，内容核对完毕。'); return; }
        const round = (counts.get(owner) ?? 0) + 1; counts.set(owner, round);
        console.log('PARALLEL_MODEL_REQUEST', JSON.stringify({ owner, role, round }));
        if (role === 'waiting' && round > 1) { json(response, '丙重试后完成了自己的回复。'); return; }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); response.flushHeaders();
        const chunk = (delta: Record<string, unknown>, finish: string | null = null) => { if (!response.destroyed && !response.writableEnded) response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'); };
        if (role !== 'waiting') chunk({ role: 'assistant', content: role === 'tool' ? '甲准备读取资料。' : '乙的第一段已经到达。' });
        const finish = () => {
          released.add(owner);
          if (role === 'tool') { chunk({ tool_calls: [{ index: 0, id: 'actual_read_file', type: 'function', function: { name: 'dsh', arguments: JSON.stringify({ operation: 'read_file', parameters: { path: sourceFile } }) } }] }); chunk({}, 'tool_calls'); }
          else { chunk({ content: role === 'stream' ? '乙的第二段也完成了。' : '丙取消后不应出现的旧正文。' }); chunk({}, 'stop'); }
          if (!response.destroyed && !response.writableEnded) response.end('data: [DONE]\n\n');
        };
        held.set(owner, finish); if (released.has(owner)) finish();
      } catch (error) { response.writeHead(500); response.end(String(error)); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not bind.');
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
  try {
    await preparePackagedCompanionLaunch(application, profile);
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setSize(1440, 960); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    await ensureCompanionTestWorkspace(page);
    const configured = await page.evaluate(input => (window as unknown as Bridge).worldlinebox.llm.setConfig(input), { apiFormat: 'openai_chat' as const, baseUrl: `http://127.0.0.1:${address.port}`, model: 'timing-only-fixture', apiKey: 'isolated-ui-fixture' }); expect(configured.ok).toBe(true);
    const owners: string[] = [];
    for (const [index, role] of ['tool', 'stream', 'waiting'].entries()) {
      const owner = (await call(page, { type: 'companion.create', companion: { name: ['甲', '乙', '丙'][index]!, description: '实际并行回复验收', persona: '按当前请求自然回复。', model: '', avatar: 'custom', proactive: false } })).companion!;
      roles.set(owner.id, role as 'tool' | 'stream' | 'waiting'); owners.push(owner.id);
      const room = (await call(page, { type: 'conversation.open', companionId: owner.id })).conversation!;
      await readyAtDesk(page, owner.id, room.id);
    }
    await call(page, { type: 'companion.set-active', id: owners[2]!, active: false });
    const room = (await call(page, { type: 'conversation.create-group', title: '三位伙伴并行验收', memberIds: owners })).conversation!;
    await page.evaluate(() => { const current = window as unknown as Bridge; current.progressEvidence = []; current.worldlinebox.companions.onReplyStream(event => { if (current.progressEvidence!.length < 1000) current.progressEvidence!.push(event); }); });
    await page.locator('[data-application-module="companions"]').click();
    await page.getByRole('button', { name: /三位伙伴并行验收/ }).first().click();
    const text = `请甲读取本次资料 ${sourceFile} 并说明结果，乙说两句话，丙也独立回复。`;
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(text); await page.getByRole('textbox', { name: '输入消息', exact: true }).press('Enter');
    let replies: CompanionMessage[] = [];
    await expect.poll(async () => { replies = (await call(page, { type: 'messages', conversationId: room.id, limit: 100 })).messages!.filter(message => owners.includes(message.authorId)); return replies.length; }).toBe(3);
    const byOwner = new Map(replies.map(message => [message.authorId, message]));
    const bubble = (owner: string) => page.locator(`[data-companion-message="${byOwner.get(owner)!.id}"]`);
    await expect(bubble(owners[0]!)).toContainText('甲准备读取资料。', { timeout: 60_000 });
    await expect(bubble(owners[1]!)).toContainText('乙的第一段已经到达。', { timeout: 60_000 });
    await expect(bubble(owners[2]!).locator('[data-reply-stage="queued"]')).toBeVisible();
    await expect(page.locator('.companions-reply-progress')).toHaveCount(0);
    await expect(page.locator('.companions-queue-dock')).toHaveCount(0);
    // This is the same user source that A/B already execute. Guiding it again
    // would repeat the current request; a later distinct source has its own UI test.
    await expect(bubble(owners[2]!).getByRole('button', { name: '立即引导', exact: true })).toHaveCount(0);
    const evidence = path.resolve('artifacts/vcp-validation/parallel-reply-progress'); mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, 'three-independent-reply-bubbles.png') });
    held.get(owners[0]!)!();
    await expect.poll(() => toolReceipts.some(receipt => receipt.includes('真实工具结果'))).toBe(true);
    await expect(bubble(owners[0]!)).toContainText('甲已读取真实资料，内容核对完毕。');
    await expect.poll(() => page.evaluate(owner => (window as unknown as Bridge).progressEvidence!.some(event => event.companionId === owner && event.progress?.phase === 'tools'), owners[0]!)).toBe(true);
    await expect(bubble(owners[1]!).locator('[data-reply-stage="streaming"]')).toBeVisible();
    await call(page, { type: 'companion.set-active', id: owners[2]!, active: true });
    await expect.poll(() => counts.get(owners[2]!)).toBe(1);
    await expect(bubble(owners[2]!).locator('[data-reply-stage="thinking"]')).toBeVisible();
    await bubble(owners[2]!).getByRole('button', { name: '取消这条回复', exact: true }).click();
    await expect(bubble(owners[2]!).locator('[data-reply-stage="cancelled"]')).toBeVisible();
    held.get(owners[2]!)?.();
    await expect(bubble(owners[2]!)).not.toContainText('取消后不应出现的旧正文');
    await expect(bubble(owners[1]!).locator('[data-reply-stage="streaming"]')).toBeVisible();
    held.get(owners[1]!)!(); await expect(bubble(owners[1]!)).toContainText('乙的第二段也完成了。', { timeout: 30_000 });
    await bubble(owners[2]!).getByRole('button', { name: '重试这条回复', exact: true }).click();
    await expect(bubble(owners[2]!)).toContainText('丙重试后完成了自己的回复。', { timeout: 60_000 });
    let final: CompanionMessage[] = [];
    // The last visible token precedes the durable loop commit.
    await expect.poll(async () => { final = (await call(page, { type: 'messages', conversationId: room.id, limit: 100 })).messages!.filter(message => owners.includes(message.authorId)); return final.every(message => message.replyProgress?.phase === 'completed'); }, { timeout: 15_000 }).toBe(true);
    expect(final.map(message => message.id)).toEqual(replies.map(message => message.id));
    expect(socialReviews.length).toBeGreaterThan(0);
    const events = await page.evaluate(() => (window as unknown as Bridge).progressEvidence!);
    for (const owner of owners) expect(events.some(event => event.companionId === owner && event.progress?.phase === 'memory')).toBe(true);
    writeFileSync(path.join(evidence, 'actual-loop-progress-proof.json'), JSON.stringify({ owners, stableMessageIds: final.map(message => message.id), targetedCancellation: true, nativeToolReceipts: toolReceipts, socialReviewCount: socialReviews.length, socialReviews, events }, null, 2));
    await testInfo.attach('actual-loop-progress', { body: JSON.stringify({ owners, stableMessageIds: final.map(message => message.id), socialReviewCount: socialReviews.length, socialReviews, events }), contentType: 'application/json' });
  } finally {
    await application.close(); for (const finish of held.values()) finish(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    cleanup(root);
  }
});

function json(response: ServerResponse, content: string) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] })); }
async function call(page: Page, request: CompanionsRequest) { const result = await page.evaluate(value => (window as unknown as Bridge).worldlinebox.companions.request(value), request); expect(result.ok, result.error).toBe(true); return result; }
async function readyAtDesk(page: Page, companionId: string, conversationId: string) {
  await call(page, { type: 'companion.set-active', id: companionId, active: true });
  const world = (await call(page, { type: 'world.snapshot' })).world!, routine = (await call(page, { type: 'routine.get', companionId, conversationId })).routine!;
  const clock = (offset: number) => String((Math.floor(world.clock.hour) + offset + 24) % 24).padStart(2, '0') + ':00';
  await call(page, { type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision, patch: { timeZone: world.settings.timeZone, wakeAt: clock(-8), sleepAt: clock(8), meals: [], habits: [] } });
  const home = world.scenes.find(scene => scene.ownerId === companionId)!, computer = home.objects.find(object => object.kind === 'computer')!;
  await call(page, { type: 'world.tool', companionId, conversationId, arguments: { action: 'move', destinationId: computer.id } });
  await expect.poll(async () => { const actor = (await call(page, { type: 'world.snapshot' })).world!.actors.find(actor => actor.companionId === companionId)!;
    return actor.sceneId === home.id && !actor.route.length && Math.hypot(actor.position.x - computer.anchor.x, actor.position.y - computer.anchor.y) < .01; }, { timeout: 30_000 }).toBe(true);
}

function cleanup(root: string) {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-parallel-progress-')) throw new Error('Unexpected parallel fixture path.');
  removeCompanionTestDirectory(root);
}
