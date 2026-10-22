import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionMessage, CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMemoryCandidate } from '../../src/shared/companion-memory';
import type { CompanionWorkspaceRequest } from '../../src/shared/companion-workspace';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, ensureCompanionTestWorkspace, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi } };
type FixtureHost = { stateUiStorage?: { request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>; close(): Promise<void> } };
const small = 'deepseek-flash', big = 'deepseek-sister';
const oldPreference = '我现在更喜欢清淡的热茶，晚上就不喝浓咖啡了。';
const newPreference = '我现在更喜欢淡麦茶，清茶喝多了也会睡不着。';
const otherPreference = '我喜欢不加糖的温牛奶，这只是大肥鱼自己的偏好。';
const sharedVoice = '我愿意在读书会里先听完别人的解释，再说自己的想法。';
const support = '谢谢你在读书会里先核实资料，我相信你，也会支持你。';
const reason = '读书会里的真实支持让我更安心，也愿意温柔地继续讨论。';

// No state/projection response is replaced. The deterministic fixture enters
// formal messages, source-checked VCP diaries and proposals through the actual
// Companion UtilityProcess; the live application reads and projects them itself.
// eslint-disable-next-line no-empty-pattern
test('shows source-backed current state and self-understanding, opens exact documents and cross-room causes, and clears replaced or withdrawn preferences', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-state-ui-')), profile = path.join(root, 'profile');
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root }) });
  const provider = createQuietProvider();
  try {
    await preparePackagedCompanionLaunch(application, profile);
    const applicationIdentity = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), version: app.getVersion() }));
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const providerAddress = provider.address(); if (!providerAddress || typeof providerAddress === 'string') throw new Error('Acceptance model provider did not bind.');
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setMinimumSize(480, 500); win.setContentSize(1440, 960); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    await ensureCompanionTestWorkspace(page);
    // Selection replaces the previous workspace service; wait for the actual
    // public service to accept reads before seeding this isolated fixture.
    await expect.poll(() => page.evaluate(async () => (await (window as unknown as Bridge).worldlinebox.companions.request({ type: 'state' })).ok), { timeout: 15_000 }).toBe(true);
    for (const companion of (await request(page, { type: 'state' })).state!.companions) await request(page, { type: 'companion.set-active', id: companion.id, active: false });
    const smallRoom = (await request(page, { type: 'conversation.open', companionId: small })).conversation!;
    const bigRoom = (await request(page, { type: 'conversation.open', companionId: big })).conversation!;
    const group = (await request(page, { type: 'conversation.create-group', title: '海岸读书会', memberIds: [small, big] })).conversation!;
    const workspaceState = await workspace(page, { type: 'status' });
    const configured = await page.evaluate(config => (window as unknown as Bridge).worldlinebox.llm.setConfig(config), {
      apiFormat: 'openai_chat' as const, baseUrl: `http://127.0.0.1:${providerAddress.port}`, apiKey: 'isolated-state-ui-fixture', model: 'state-ui-transport-fixture',
    }); expect(configured.ok).toBe(true);
    await startFixtureWorker(application, path.join(workspaceState.selected!.dataRoot, 'messages.sqlite'));
    const expression = await append(application, smallRoom.id, small, oldPreference);
    const note = (await storage(application, { type: 'memory.record', companionId: small, conversationId: smallRoom.id, candidate: draft(expression, 'preference', '饮品') })).memories![0]!;
    // Independent early speech is intentionally not attached to the note that
    // will be revised/forgotten; that note's entire source history is revoked.
    const lateExpression = await append(application, smallRoom.id, small, oldPreference);
    const other = await append(application, bigRoom.id, big, otherPreference);
    await storage(application, { type: 'memory.record', companionId: big, conversationId: bigRoom.id, candidate: draft(other, 'preference', '饮品') });
    const shared = await append(application, group.id, small, sharedVoice);
    const sharedNote = (await storage(application, { type: 'memory.record', companionId: small, conversationId: group.id, candidate: draft(shared, 'voice', '读书会交流') })).memories![0]!;
    const cause = await append(application, group.id, 'user', support);
    const applied = (await storage(application, { type: 'state.update', companionId: small, conversationId: group.id, proposal: {
      expression: 'gentle', focus: '认真核对读书会的资料', reason, sourceMessageIds: [cause.id], evidence: [{ sourceMessageId: cause.id, quote: support }],
      appraisals: [{ type: 'support', target: 'user', intensity: .7, confidence: .95 }],
    } })).runtimeState!;
    const receipt = applied.recentChanges!.find(change => change.sourceMessageIds.includes(cause.id))!;
    expect(receipt.kind).toBe('appraisal'); expect(receipt.relationshipDelta.affinity).toBeGreaterThan(0);

    for (const id of [small, big]) await request(page, { type: 'companion.set-active', id, active: true });
    const clock = (await request(page, { type: 'world.status', companionIds: [small] })).worldStatus!.clock;
    const routine = (await request(page, { type: 'routine.get', companionId: small, conversationId: smallRoom.id })).routine!;
    const worldHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: clock.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(clock.virtualNow)));
    const hourAt = (offset: number) => String((worldHour + offset + 24) % 24).padStart(2, '0') + ':00';
    await request(page, { type: 'routine.configure', companionId: small, conversationId: smallRoom.id, expectedRevision: routine.revision,
      patch: { timeZone: clock.timeZone, sleepAt: hourAt(-2), wakeAt: hourAt(6), meals: [], habits: [] } });
    // Changing the schedule does not teleport the body into bed: wait for the
    // actual world route/occupancy transition before checking sleeping copy.
    await expect.poll(async () => (await request(page, { type: 'routine.get', companionId: small, conversationId: smallRoom.id })).routine!.runtime.phase,
      { timeout: 45_000, intervals: [500, 1000] }).toBe('sleeping');

    await page.locator('[data-application-module="companions"]').click();
    await openConversation(page, smallRoom.id);
    await openDetails(page);
    await expect(page.locator('.companions-planner-routine-current')).toContainText('可以交流');
    await expect(page.locator('.companions-planner-routine-current')).not.toContainText('休息后回复');
    const detail = page.getByRole('dialog', { name: '伙伴当前状态', exact: true });
    await detail.locator('.companions-state-changes > summary').click();
    const change = detail.locator(`[data-state-change="${receipt.id}"]`);
    await expect(change).toContainText(reason); await expect(change.getByLabel('当时生效的属性变化')).toContainText('好感');
    expect(await change.locator('time').first().getAttribute('dateTime')).toBe(receipt.appliedAt);
    await capture(page, 'state-causes-light-1440.png');
    await detail.locator('.companions-character-development > summary').click();
    await expect(detail.getByRole('list', { name: '当前有效的自我认识' })).toContainText(oldPreference);
    await expect(detail).toContainText(sharedVoice); await expect(detail).not.toContainText(otherPreference);
    await detail.locator(`[data-development-note="${note.id}"]`).scrollIntoViewIfNeeded();
    await capture(page, 'current-preferences-light-1440.png');
    await detail.locator('.companions-state-changes > summary').click();
    const layouts = [];
    for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 1040], ['light', 800]] as const) {
      await native.evaluate((win, width) => win.setContentSize(width, 960), width); await setTheme(page, theme);
      await expect(detail).toBeVisible();
      const geometry = await detail.evaluate(node => { node.scrollTop = 0; const box = node.getBoundingClientRect(); return { innerWidth, innerHeight, devicePixelRatio,
        width: box.width, withinViewport: box.left >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1,
        horizontalOverflow: node.scrollWidth > node.clientWidth + 1, renderedChanges: node.querySelectorAll('[data-state-change]').length, renderedDevelopment: node.querySelectorAll('[data-development-note]').length }; });
      expect(geometry.innerWidth).toBe(width); expect(geometry.withinViewport).toBe(true); expect(geometry.horizontalOverflow).toBe(false);
      expect(geometry.renderedChanges).toBe(0); expect(geometry.renderedDevelopment).toBeLessThanOrEqual(12);
      const file = `state-current-${theme}-${width}.png`; await capture(page, file); layouts.push({ theme, file, ...geometry });
    }
    await native.evaluate(win => win.setContentSize(1440, 960)); await setTheme(page, 'light');
    await detail.locator(`[data-development-note="${note.id}"]`).getByRole('button', { name: '查看认识原文', exact: true }).click();
    const manager = page.getByRole('region', { name: '共同记忆管理', exact: true, includeHidden: true });
    await expect(manager).toBeVisible();
    await expect(manager.getByRole('combobox', { name: '记忆所属伙伴', exact: true })).toHaveValue(small);
    await expect(manager.locator('.memory-library-paper')).toContainText(oldPreference);
    expect((await workspace(page, { type: 'memory.documents.locate', companionId: small, noteId: note.id })).document?.memory?.id).toBe(note.id);
    await capture(page, 'exact-self-understanding-document.png');
    await page.getByRole('navigation', { name: '伙伴导航', exact: true }).getByRole('button', { name: '消息', exact: true }).click();
    await openDetails(page);
    if (await detail.locator('.companions-state-changes').getAttribute('open') === null) await detail.locator('.companions-state-changes > summary').click();
    await change.locator('.companions-state-change-sources > summary').click();
    await change.getByRole('button', { name: '查看来源消息 1', exact: true }).click();
    await expect(page.locator('.companions-chat-name')).toContainText(group.title);
    await expect(page.locator(`[data-companion-conversation="${group.id}"]`)).toHaveClass(/is-selected/u);
    await expect(page.locator(`[data-companion-message="${cause.id}"]`)).toContainText(support);
    await capture(page, 'cross-room-state-source.png');

    // The group sees its own authored statement, never the private preference.
    await openDetails(page);
    const selector = page.getByRole('combobox', { name: '待办所属伙伴', exact: true });
    await selector.selectOption(small); await openDetails(page);
    await openDevelopment(page);
    await expect(detail).toContainText(sharedVoice); await expect(detail).not.toContainText(oldPreference); await expect(detail).not.toContainText(otherPreference);
    const groupDevelopment = (await request(page, { type: 'character.development', companionId: small, conversationId: group.id, limit: 12 })).characterDevelopment!;
    expect(groupDevelopment.items.map(item => item.memoryId)).toEqual([sharedNote.id]);
    await selector.selectOption(big); await openDetails(page); await openDevelopment(page);
    await expect(detail).not.toContainText(sharedVoice); await expect(detail).not.toContainText(oldPreference); await expect(detail).not.toContainText(otherPreference);
    await openConversation(page, bigRoom.id); await openDetails(page); await openDevelopment(page);
    await expect(detail).toContainText(otherPreference); await expect(detail).not.toContainText(oldPreference);

    // A real versioned rewrite updates the live projection, without reviving the
    // prior self-understanding or keeping an old rendering cache visible.
    await openConversation(page, smallRoom.id); await openDetails(page); await openDevelopment(page);
    await expect(detail).toContainText(oldPreference);
    await request(page, { type: 'companion.set-active', id: small, active: false });
    await expect(page.locator('.companions-planner-routine-current')).toContainText('激活后可交流');
    await capture(page, 'manual-dormancy-retains-own-scope.png');
    await request(page, { type: 'companion.set-active', id: small, active: true });
    await expect(page.locator('.companions-planner-routine-current')).toContainText('可以交流');
    const fresh = await append(application, smallRoom.id, small, newPreference);
    const revised = (await storage(application, { type: 'memory.revise', companionId: small, conversationId: smallRoom.id, id: note.id, expectedVersion: note.version, candidate: draft(fresh, 'preference', '饮品') })).memories![0]!;
    await request(page, { type: 'conversation.read', id: smallRoom.id });
    await expect(detail).toContainText(newPreference); await expect(detail).not.toContainText(oldPreference);
    await expect(detail.locator(`[data-development-note="${note.id}"]`)).toContainText('版本 ' + revised.version);
    const afterRevision = (await request(page, { type: 'character.development', companionId: small, conversationId: smallRoom.id, limit: 12 })).characterDevelopment!;
    expect(afterRevision.items.find(item => item.memoryId === note.id)).toMatchObject({ memoryVersion: revised.version, statement: newPreference });
    await detail.locator(`[data-development-note="${note.id}"]`).scrollIntoViewIfNeeded(); await capture(page, 'revised-current-preference.png');
    await storage(application, { type: 'memory.forget', companionId: small, conversationId: smallRoom.id, id: note.id });
    await request(page, { type: 'conversation.read', id: smallRoom.id });
    await expect(detail.locator(`[data-development-note="${note.id}"]`)).toHaveCount(0);
    await expect(detail).not.toContainText(newPreference); await expect(detail).not.toContainText(oldPreference);
    const afterWithdrawal = (await request(page, { type: 'character.development', companionId: small, conversationId: smallRoom.id, limit: 12 })).characterDevelopment!;
    expect(afterWithdrawal.items.every(item => item.memoryId !== note.id)).toBe(true);
    await capture(page, 'withdrawn-preference-cleared.png');
    // A delayed capture uses separate, still-visible early speech unchanged.
    // Its later insertion time must not revive an older position after the
    // newer drink preference has already been withdrawn; forgotten historical
    // sources of the revised note remain correctly inaccessible.
    const lateCloneA = (await storage(application, { type: 'memory.record', companionId: small, conversationId: smallRoom.id,
      candidate: { ...draft(lateExpression, 'preference', '饮品'), content: lateExpression.content + '\n\n补记这次早期表达，形成时间仍以原始发言为准。' } })).memories![0]!;
    expect(lateCloneA.id).not.toBe(note.id); expect(lateCloneA.sourceSequence).toBe(lateExpression.sequence); expect(lateCloneA.sourceSequence).toBeLessThan(fresh.sequence);
    await request(page, { type: 'conversation.read', id: smallRoom.id });
    const afterLateCapture = (await request(page, { type: 'character.development', companionId: small, conversationId: smallRoom.id, limit: 12 })).characterDevelopment!;
    expect(afterLateCapture.items.filter(item => item.topic === '饮品')).toEqual([]);
    expect(afterLateCapture.items.some(item => item.memoryId === lateCloneA.id)).toBe(false);
    await expect(detail.locator(`[data-development-note="${lateCloneA.id}"]`)).toHaveCount(0);
    await expect(detail).not.toContainText(oldPreference); await expect(detail).not.toContainText(newPreference);
    // Make the real chat independently scrollable, then use actual wheel input
    // over the existing detail popover. No CSS or response is replaced here.
    for (let index = 0; index < 12; index++) await append(application, smallRoom.id, small,
      `阅读札记 ${index + 1}：先把这页资料中可核对的内容读完整，留下暂时没有答案的问题。等以后找到新的来源，再回来比较自己的理解，不急着把猜想当成已经确认的结论。`);
    await request(page, { type: 'conversation.read', id: smallRoom.id });
    const chat = page.locator('[data-companion-messages]');
    await expect.poll(() => chat.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(300);
    if (await detail.locator('.companions-state-changes').getAttribute('open') === null) await detail.locator('.companions-state-changes > summary').click();
    const chatMiddle = await chat.evaluate(node => { node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2); return node.scrollTop; });
    await expect.poll(() => chat.evaluate(node => node.scrollTop)).toBe(chatMiddle);
    const scrollingBefore = await detail.evaluate(node => { node.scrollTop = 0; const style = getComputedStyle(node); return {
      scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflowY: style.overflowY, maxHeight: style.maxHeight,
      chatScrollTop: document.querySelector('[data-companion-messages]')!.scrollTop }; });
    expect(scrollingBefore.overflowY).toBe('auto'); expect(scrollingBefore.maxHeight).toBe('450px');
    expect(scrollingBefore.scrollHeight - scrollingBefore.clientHeight).toBeGreaterThan(180);
    expect(scrollingBefore.chatScrollTop).toBeGreaterThan(0);
    await detail.hover(); await page.mouse.wheel(0, 180);
    await expect.poll(() => detail.evaluate(node => node.scrollTop)).toBeGreaterThan(scrollingBefore.scrollTop + 50);
    const scrollingDown = await detail.evaluate(node => ({ scrollTop: node.scrollTop, chatScrollTop: document.querySelector('[data-companion-messages]')!.scrollTop }));
    expect(scrollingDown.chatScrollTop).toBe(scrollingBefore.chatScrollTop);
    await page.mouse.wheel(0, -180);
    await expect.poll(() => detail.evaluate(node => node.scrollTop)).toBeLessThanOrEqual(scrollingBefore.scrollTop + 1);
    const scrollingUp = await detail.evaluate(node => ({ scrollTop: node.scrollTop, chatScrollTop: document.querySelector('[data-companion-messages]')!.scrollTop }));
    expect(scrollingUp.chatScrollTop).toBe(scrollingBefore.chatScrollTop);
    const proof = { applicationIdentity, actualUtilityProcess: true, noProjectionMock: true, owner: small, room: smallRoom.id, sourceRoom: group.id, actualAppliedReceipt: receipt,
      exactNoteId: note.id, sourceMessageId: cause.id, groupDevelopment, afterRevision, afterWithdrawal,
      lateCaptureAfterWithdrawal: { noteId: lateCloneA.id, sourceMessageId: lateExpression.id, originalSourceSequence: lateExpression.sequence,
        withdrawnNewerSourceSequence: fresh.sequence, afterLateCapture },
      originalDocumentLink: true, crossRoomSourceNavigation: true, privateScopeAndOwnerIsolation: true, liveRevisionAndWithdrawalClearOldContent: true,
      dormantNeedsActivation: true, activeSleepingBodyCanCommunicate: true, configuredLocalTestTransport: true,
      independentDetailScrolling: { before: scrollingBefore, down: scrollingDown, up: scrollingUp, input: 'real mouse wheel, +180 then -180' }, layouts };
    writeFileSync(evidencePath('state-and-current-self-proof.json'), JSON.stringify(proof, null, 2));
    await testInfo.attach('actual-state-and-self-understanding-proof', { body: JSON.stringify(proof), contentType: 'application/json' });
  } finally {
    await application.evaluate(async () => (globalThis as FixtureHost).stateUiStorage?.close()).catch(() => undefined);
    await application.close();
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    cleanup(root);
  }
});

function draft(message: CompanionMessage, kind: 'preference' | 'voice', topic: string): CompanionMemoryCandidate {
  return { content: message.content, diaryName: '自我认识', tags: ['自我认识', topic], metadata: { autoTags: false }, sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }], selfDevelopment: { kind, topic, statement: message.content, basis: 'self_expression' } };
}
async function append(application: ElectronApplication, conversationId: string, authorId: string, content: string) {
  return (await storage(application, { type: 'message.append', message: { conversationId, authorId, content } })).message!;
}
async function request(page: Page, command: CompanionsRequest) { const result = await page.evaluate(command => (window as unknown as Bridge).worldlinebox.companions.request(command), command); expect(result.ok, result.error).toBe(true); return result; }
async function workspace(page: Page, command: CompanionWorkspaceRequest) { const result = await page.evaluate(command => (window as unknown as Bridge).worldlinebox.companions.workspace!(command), command); expect(result.ok, result.error).toBe(true); return result; }
async function storage(application: ElectronApplication, command: CompanionStorageCommand) {
  const result = await application.evaluate(async (_, command) => { const storage = (globalThis as FixtureHost).stateUiStorage; if (!storage) throw new Error('Actual fixture worker is unavailable.'); return storage.request(command); }, command);
  expect(result.ok, result.error).toBe(true); return result;
}
async function startFixtureWorker(application: ElectronApplication, databasePath: string) {
  await application.evaluate(async ({ app, utilityProcess }, databasePath) => {
    if (!databasePath.includes('worldlinebox-state-ui-') || !databasePath.endsWith('messages.sqlite')) throw new Error('Unexpected fixture worker database.');
    const child = utilityProcess.fork(app.getAppPath() + '/.vite/build/companion_worker.js', [], { serviceName: 'WorldlineBox State UI Acceptance', stdio: 'pipe' });
    child.stdout?.resume(); child.stderr?.resume();
    let sequence = 0, finishClose: (() => void) | undefined;
    const pending = new Map<string, { resolve(value: CompanionStorageResponse): void; reject(error: Error): void }>();
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Actual fixture worker initialization timed out.')), 15_000);
      child.on('error', reject); child.on('exit', code => { clearTimeout(timeout); for (const task of pending.values()) task.reject(new Error('Actual fixture worker exited: ' + code)); pending.clear(); finishClose?.(); });
      child.on('message', (input: unknown) => {
        const message = input as { type?: string; requestId?: string; response?: CompanionStorageResponse; error?: string };
        if (message.type === 'storage.booted') child.postMessage({ type: 'storage.initialize', databasePath });
        else if (message.type === 'storage.ready') { clearTimeout(timeout); resolve(); }
        else if (message.type === 'storage.failed') { clearTimeout(timeout); reject(new Error(message.error)); }
        else if (message.type === 'storage.closed') finishClose?.();
        else if (message.requestId && message.response) { pending.get(message.requestId)?.resolve(message.response); pending.delete(message.requestId); }
      });
    });
    (globalThis as FixtureHost).stateUiStorage = {
      request: async command => { await ready; const requestId = 'state_ui_' + ++sequence; return new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject }); child.postMessage({ requestId, command }); }); },
      close: async () => { await ready; await new Promise<void>(resolve => { const timeout = setTimeout(() => { child.kill(); resolve(); }, 2000); finishClose = () => { clearTimeout(timeout); resolve(); }; child.postMessage({ type: 'storage.close' }); }); },
    };
    await ready;
  }, databasePath);
}
async function openConversation(page: Page, conversationId: string) {
  const dialog = page.getByRole('dialog', { name: '伙伴当前状态', exact: true });
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: '关闭当前状态详情', exact: true }).click();
  await expect.poll(() => page.locator(`[data-companion-conversation="${conversationId}"]`).count()).toBe(1);
  await page.locator(`[data-companion-conversation="${conversationId}"]`).click();
  await expect(page.locator(`[data-companion-conversation="${conversationId}"]`)).toHaveClass(/is-selected/u);
}
async function openDetails(page: Page) {
  const toggle = page.getByRole('button', { name: '我们之间', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  if (!await page.getByRole('dialog', { name: '伙伴当前状态', exact: true }).isVisible()) await page.getByRole('button', { name: '查看当前伙伴状态详情', exact: true }).click();
}
async function openDevelopment(page: Page) {
  const panel = page.locator('.companions-character-development'); await expect(panel).toBeVisible();
  if (await panel.getAttribute('open') === null) await panel.locator(':scope > summary').click();
  await expect(panel).not.toContainText('正在核对当前有效的认识…');
}
function evidencePath(file: string) { const root = path.resolve('artifacts/vcp-validation', process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? 'state-current-ui-packaged' : 'state-current-ui'); mkdirSync(root, { recursive: true }); return path.join(root, file); }
async function capture(page: Page, file: string) {
  const notices = page.locator('.workspace-notice-item:not(.is-closing)').filter({ hasText: /^已自动同步 \d+ 项磁盘变化/u });
  const ids = await notices.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-toast-id')));
  for (const id of ids) { const notice = page.locator(`.workspace-notice-item:not(.is-closing)[data-toast-id="${id}"]`); await notice.getByRole('button').click({ timeout: 1000 }).catch(async error => { if (await notice.isVisible()) throw error; }); }
  await page.screenshot({ path: evidencePath(file), animations: 'disabled' });
}
async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.getByRole('button', { name: '设置', exact: true }).click(); const settings = page.getByRole('dialog', { name: '通用设置', exact: true });
  await settings.getByRole('tab', { name: '外观', exact: true }).click(); await settings.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
  await settings.getByRole('radio', { name: theme === 'light' ? '亮色' : '暗色', exact: true }).click(); await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}
function cleanup(root: string) { if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-state-ui-')) throw new Error('Unexpected state UI fixture cleanup target.'); removeCompanionTestDirectory(root); }
function createQuietProvider() {
  // Deterministic HTTP transport keeps the real configured/active UI available.
  // It generates no self-understanding or state: all evaluated projections must
  // still pass the real worker's formal-source validation above.
  return createServer((request, response) => {
    let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      let text = '这是我获取的所有相关知识/记忆[[未找到相关记忆]]';
      try {
        const payload = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
        const context = JSON.parse(payload.messages.findLast(message => message.role === 'user')?.content ?? '{}') as { purpose?: string };
        text = JSON.stringify(context.purpose === 'world_decision' ? { action: null, appraisals: [], reason: '本次界面验收没有新的自主行动。' }
          : context.purpose === 'world_social' ? { text: null, reason: '本次界面验收不延伸社交。' }
            : context.purpose === 'world_attention' ? { urgency: 'ordinary', confidence: .99, evidence: [], reason: '本次没有需要打断的请求。' }
              : context.purpose === 'world_message_authorization' ? { allowed: false, confidence: .99, evidence: [], reason: '本次没有新的转发授权。' }
                : context.purpose === 'vcp_sleep_reflection' ? { notes: [], dream: null } : { notes: [] });
      } catch { /* Native memory focusing sends plain text, not the reply JSON. */ }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
    });
  });
}
