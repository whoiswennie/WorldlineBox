import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionMessage, CompanionReplyStreamEvent, CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, ensureCompanionTestWorkspace, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

type Evidence = { atMs: number; event: CompanionReplyStreamEvent };
type PendingLayout = { messageId: string; stage: string; width: number; height: number; details: boolean };
type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi }; liveProgressEvidence?: Evidence[]; pendingLayoutEvidence?: PendingLayout[] };
const owner = 'deepseek-flash', prompt = '即时进度屏障验收：请等本地服务确认后回复。', finalText = '屏障已经释放，这是本次真实完成的回复。';

// The HTTP fixture controls response timing, never UI, IPC, SQLite, task state
// or progress. There is no external provider or model download in this test.
// eslint-disable-next-line no-empty-pattern
test('shows durable live progress and an advancing clock while the actual model response is held, then completes the same bubble', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-live-progress-')), profile = path.join(root, 'profile');
  const failures: string[] = [], purposes: string[] = [];
  let application: ElectronApplication | undefined, held: ServerResponse | undefined, primaryRequests = 0, released = false;
  const server = createServer((incoming, response) => {
    let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { raw += chunk; });
    incoming.on('end', () => {
      try {
        const payload = JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> };
        const serialized = payload.messages?.findLast(message => message.role === 'user')?.content ?? '';
        let context: { purpose?: string; taskRequest?: { prompt?: string }; conversation?: { replyingAs?: string } };
        try { context = JSON.parse(serialized); } catch { json(response, '[[Tag: 验收]]'); return; }
        if (!context.purpose && context.taskRequest?.prompt === prompt && context.conversation?.replyingAs === owner) {
          ++primaryRequests; held = response;
          // Intentionally send no headers or tokens. The renderer must show the
          // host's durable execution milestone while the provider stays silent.
          if (released) json(response, finalText);
          return;
        }
        purposes.push(context.purpose ?? 'other');
        const output = context.purpose === 'world_attention' ? { urgency: 'ordinary', confidence: .99, evidence: [], reason: '普通请求，无需紧急打断。' }
          : context.purpose === 'world_decision' ? { action: null, reason: '本次无需自主世界行动。', appraisals: [] }
            : context.purpose === 'world_social' ? { text: null, reason: '不增加后台社交。' }
              : context.purpose === 'companion_social_progress_review' ? { supported: true, correction: '' }
                : context.purpose === 'vcp_memory_prohibition_check' ? { allowed: true, matchedPolicyIds: [] }
                  : { notes: [], dream: null };
        json(response, JSON.stringify(output));
      } catch (cause) { failures.push(String(cause)); response.writeHead(500); response.end('Local fixture rejected the request.'); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Local model fixture did not bind.');
  try {
    application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
    await preparePackagedCompanionLaunch(application, profile);
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setContentSize(1440, 960); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    await ensureCompanionTestWorkspace(page);
    for (const id of ['deepseek-sister', owner]) await request(page, { type: 'companion.set-active', id, active: false });
    const configured = await page.evaluate(baseUrl => (window as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', baseUrl, model: 'local-response-barrier', apiKey: 'disposable-local-fixture', autoAnalyzeEnabled: false, disclaimerAccepted: true }), `http://127.0.0.1:${address.port}`);
    expect(configured.ok).toBe(true);
    const companion = (await request(page, { type: 'state' })).state!.companions.find(item => item.id === owner)!;
    await request(page, { type: 'companion.update', id: owner, expectedRevision: companion.revision, companion: { name: companion.name, description: companion.description, persona: companion.persona, model: '', avatar: companion.avatar, proactive: false, inputMode: 'steer' } });
    const room = (await request(page, { type: 'conversation.open', companionId: owner })).conversation!;
    await readyAtDesk(page, room.id);
    await page.evaluate(input => {
      const bridge = window as unknown as Bridge; bridge.liveProgressEvidence = []; bridge.pendingLayoutEvidence = [];
      bridge.worldlinebox.companions.onReplyStream(event => {
        if (event.conversationId === input.room && event.companionId === input.owner && bridge.liveProgressEvidence!.length < 256) bridge.liveProgressEvidence!.push({ atMs: performance.now(), event });
      });
      // Observe actual mounted DOM after React commits; no synthetic IPC or UI
      // state is injected. Changing stage text must not resize the empty shell.
      const observer = new MutationObserver(() => {
        const article = document.querySelector<HTMLElement>('article[data-companion-message]:has(.is-reply-pending)'), bubble = article?.querySelector<HTMLElement>('.is-reply-pending');
        if (!article || !bubble) return;
        const stage = bubble.querySelector('[data-reply-stage]')?.getAttribute('data-reply-stage') ?? '', bounds = bubble.getBoundingClientRect();
        const entry = { messageId: article.dataset.companionMessage!, stage, width: bounds.width, height: bounds.height, details: !!bubble.querySelector('details[open]') };
        const prior = bridge.pendingLayoutEvidence!.at(-1);
        if ((!prior || prior.stage !== stage || prior.width !== entry.width || prior.height !== entry.height || prior.details !== entry.details) && bridge.pendingLayoutEvidence!.length < 256) bridge.pendingLayoutEvidence!.push(entry);
      });
      observer.observe(document.body, { attributes: true, childList: true, characterData: true, subtree: true });
    }, { room: room.id, owner });
    await page.locator('[data-application-module="companions"]').click();
    await page.locator(`[data-companion-conversation="${room.id}"]`).click();
    const input = page.getByRole('textbox', { name: '输入消息', exact: true }); await input.fill(prompt);
    const started = performance.now(); await input.press('Enter');
    const reply = page.locator('article[data-companion-message]').filter({ has: page.locator('[data-reply-stage]') });
    await expect(reply).toHaveCount(1, { timeout: 2000 }); await expect(reply).toBeVisible();
    const firstVisibleMs = performance.now() - started, messageId = await reply.getAttribute('data-companion-message');
    const firstPendingWidth = (await reply.locator('.is-reply-pending').boundingBox())!.width;
    expect(messageId).toBeTruthy(); expect(firstVisibleMs).toBeLessThan(2000);
    const firstStage = await reply.locator('[data-reply-stage]').getAttribute('data-reply-stage');
    expect(['queued', 'waiting', 'context', 'memory', 'thinking']).toContain(firstStage);
    await expect(reply.getByRole('button', { name: '取消这条回复', exact: true })).toBeVisible();
    await expect(reply).not.toContainText(finalText);
    await expect.poll(() => primaryRequests, { timeout: 60_000 }).toBe(1);
    await expect(reply.locator('[data-reply-stage="thinking"]')).toBeVisible();
    const clock = reply.locator('[aria-label="本条回复进度"] time'), initialClock = await clock.innerText();
    await expect.poll(() => clock.innerText(), { timeout: 4000 }).not.toBe(initialClock);
    const advancedClock = await clock.innerText();
    expect((await reply.locator('.is-reply-pending').boundingBox())!.width).toBeCloseTo(firstPendingWidth, 1);
    expect(released).toBe(false); expect(held?.writableEnded).toBe(false);
    await expect(reply.locator('[data-reply-stage="completed"], [data-reply-stage="failed"]')).toHaveCount(0);
    await expect(reply).not.toContainText(finalText);
    // This read uses the real source guard and SQLite reader; no test state is
    // injected. The already-visible identity must also exist durably in the host.
    const pending = (await request(page, { type: 'messages', conversationId: room.id, limit: 50 })).messages!.find(message => message.id === messageId)!;
    expect(pending).toMatchObject({ id: messageId, authorId: owner, content: '', isReplyDraft: true, replyProgress: { phase: 'thinking' } });
    const screenshotDirectory = path.resolve('artifacts/vcp-validation'); mkdirSync(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDirectory, 'companion-live-progress-pending.png') });
    const beforeRelease = performance.now(); released = true; json(held!, finalText);
    await expect(reply).toContainText(finalText, { timeout: 30_000 });
    await expect(reply.locator('[data-reply-stage="completed"]')).toBeVisible({ timeout: 15_000 });
    const completedAfterReleaseMs = performance.now() - beforeRelease;
    let saved: CompanionMessage | undefined;
    await expect.poll(async () => { saved = (await request(page, { type: 'messages', conversationId: room.id, limit: 50 })).messages!.find(message => message.id === messageId); return saved?.replyProgress?.phase; }).toBe('completed');
    expect(saved?.content).toBe(finalText); expect(saved?.isReplyDraft).not.toBe(true);
    const completedDuration = await reply.locator('[aria-label="本条回复总用时"]').innerText();
    expect(completedDuration).toContain('总用时');
    await page.waitForTimeout(1200);
    expect(await reply.locator('[aria-label="本条回复总用时"]').innerText()).toBe(completedDuration);
    await expect(page.locator(`[data-companion-message="${messageId}"]`)).toHaveCount(1);
    expect(primaryRequests).toBe(1); expect(failures).toEqual([]);
    const events = await page.evaluate(() => (window as unknown as Bridge).liveProgressEvidence!);
    const pendingLayouts = (await page.evaluate(() => (window as unknown as Bridge).pendingLayoutEvidence!)).filter(entry => entry.messageId === messageId);
    writeFileSync(path.resolve('artifacts/vcp-validation/companion-live-progress-layout.json'), JSON.stringify({ firstPendingWidth, pendingLayouts }, null, 2));
    expect(pendingLayouts.length).toBeGreaterThan(0);
    expect(pendingLayouts.some(entry => entry.stage === 'thinking')).toBe(true);
    expect(pendingLayouts.every(entry => Math.abs(entry.width - firstPendingWidth) < .5)).toBe(true);
    expect(Math.max(...pendingLayouts.map(entry => entry.height)) - Math.min(...pendingLayouts.map(entry => entry.height))).toBeLessThan(2);
    expect(events.some(({ event }) => event.messageId === messageId && event.messageIdentity && event.progress?.phase === 'queued')).toBe(true);
    expect(events.some(({ event }) => event.messageId === messageId && event.progress?.phase === 'context')).toBe(true);
    expect(events.some(({ event }) => event.messageId === messageId && event.progress?.phase === 'thinking')).toBe(true);
    const report = { fixtureKind: 'real_electron_local_provider_barrier', firstVisibleMs, firstStage, initialClock, advancedClock, completedAfterReleaseMs, messageId,
      primaryRequests, heldWithoutHeadersOrTokens: true, durableDraftBeforeRelease: true, stableMessageId: saved?.id === messageId, firstPendingWidth, pendingLayouts, purposes, events,
      boundary: 'Actual Electron, SQLite, source guards, IPC and renderer; provider timing only is controlled locally. Browser/tool execution is not exercised by this test.' };
    const directory = path.resolve('artifacts/vcp-validation'); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'companion-live-progress.json'), JSON.stringify(report, null, 2));
    await testInfo.attach('live-progress-real-provider-barrier', { body: JSON.stringify(report), contentType: 'application/json' });
  } finally {
    held?.destroy(); await application?.close().catch(() => undefined);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    cleanup(root);
  }
});

function cleanup(root: string) {
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-live-progress-')) throw new Error('Unexpected live progress fixture cleanup path.');
  removeCompanionTestDirectory(absolute);
}

function json(response: ServerResponse, content: string) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
}
async function request(page: Page, command: CompanionsRequest) { const result = await page.evaluate(input => (window as unknown as Bridge).worldlinebox.companions.request(input), command); expect(result.ok, result.error).toBe(true); return result; }
async function readyAtDesk(page: Page, conversationId: string) {
  await request(page, { type: 'companion.set-active', id: owner, active: true });
  const world = (await request(page, { type: 'world.snapshot' })).world!, routine = (await request(page, { type: 'routine.get', companionId: owner, conversationId })).routine!;
  const clock = (offset: number) => String((Math.floor(world.clock.hour) + offset + 24) % 24).padStart(2, '0') + ':00';
  await request(page, { type: 'routine.configure', companionId: owner, conversationId, expectedRevision: routine.revision, patch: { timeZone: world.settings.timeZone, wakeAt: clock(-8), sleepAt: clock(8), meals: [], habits: [] } });
  const home = world.scenes.find(scene => scene.ownerId === owner)!, computer = home.objects.find(object => object.kind === 'computer')!;
  await request(page, { type: 'world.tool', companionId: owner, conversationId, arguments: { action: 'move', destinationId: computer.id } });
  await expect.poll(async () => { const actor = (await request(page, { type: 'world.snapshot' })).world!.actors.find(item => item.companionId === owner)!; return actor.sceneId === home.id && !actor.route.length && Math.hypot(actor.position.x - computer.anchor.x, actor.position.y - computer.anchor.y) < .01; }, { timeout: 30_000 }).toBe(true);
}
