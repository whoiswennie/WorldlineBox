import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { removeCompanionTestDirectory, ensureCompanionTestWorkspace, electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';
type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi } };
type Record = { purpose: string; self?: string; sourceId?: string; speaker?: string; participants?: string[]; tools: boolean; at: number };
const sender = 'deepseek-sister', receiver = 'deepseek-flash';
const opening = '手机话题：想听听你今天自己的音乐与读书计划，不需要操作玩家的任何文件。';
async function request(page: Page, value: CompanionsRequest) { const result = await page.evaluate(value => (window as unknown as Bridge).worldlinebox.companions.request(value), value); expect(result.ok, result.error).toBe(true); return result; }
async function world(page: Page) { return (await request(page, { type: 'world.snapshot' })).world!; }
const clock = (hour: number) => String((Math.floor(hour) + 24) % 24).padStart(2, '0') + ':00';
function cleanup(root: string) { const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-social-e2e-')) throw new Error('Unexpected social fixture cleanup.'); removeCompanionTestDirectory(resolved); }
async function provider() {
  const logs: Record[] = [], held = new Set<() => void>(); let recipients: string[] = [], armed = false, keepReplying = true, hold = true;
  const server = createServer((incoming, outgoing) => {
    let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { raw += chunk; }); incoming.on('end', () => {
      try {
        const body = JSON.parse(raw), data = JSON.parse(body.messages[1].content), purpose = data.purpose ?? 'primary_reply';
        logs.push({ purpose, self: data.identity?.self.id ?? data.companion?.id, sourceId: data.source?.id, speaker: data.identity?.currentReply?.speaker?.id,
          participants: data.identity?.participants?.map((member: { id: string }) => member.id), tools: !!body.tools, at: Date.now() });
        let output: unknown;
        if (purpose === 'world_decision') {
          if (armed && data.companion.id === sender) { armed = false; output = { action: { action: 'message', recipientIds: recipients, text: opening }, reason: '根据当前空闲与人格主动发起手机话题，不代玩家授权。', appraisals: [] }; }
          else output = { action: null, reason: '当前没有新的生活行为需要执行。', appraisals: [] };
        } else if (purpose === 'world_social') {
          const index = logs.filter(log => log.purpose === purpose).length;
          const members: string[] = data.identity.participants.map((member: { id: string }) => member.id), self: string = data.identity.self.id;
          const nextRecipientId = members[(members.indexOf(self) + 1) % members.length]!;
          output = { text: keepReplying ? `手机回应${index}：我是${self}，在回应${data.source.authorId}的实际来信。` : null,
            ...(keepReplying ? { nextRecipientId } : {}), reason: '只延续本伙伴话题，不执行DSH，不替玩家发话。' };
          const reply = () => { held.delete(reply); json(outgoing, output); };
          if (hold) { held.add(reply); return; }
        } else if (purpose === 'world_attention') output = { urgency: 'ordinary', confidence: .99, evidence: [data.source.content], reason: '伙伴社交不授予用户紧急授权。' };
        else if (purpose === 'vcp_memory_prohibition_check') output = { allowed: true, matchedPolicyIds: [] };
        else if (purpose === 'vcp_sleep_reflection') output = { notes: [], dream: null };
        else if (purpose === 'vcp_experience_journal') output = { notes: [] };
        else output = { text: '不应从伙伴话题启动玩家聊天。', memories: [] };
        json(outgoing, output);
      } catch { outgoing.writeHead(400); outgoing.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No social provider port.');
  return { logs, baseUrl: 'http://127.0.0.1:' + address.port, arm(ids: string[]) { recipients = ids; armed = true; },
    finishReplies() { hold = false; for (const finish of [...held]) finish(); }, stopReplies() { keepReplying = false; },
    async close() { for (const finish of [...held]) finish(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); } };
}
function json(response: ServerResponse, output: unknown) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] })); }
async function launch(root: string, baseUrl: string) {
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') }, { gpu: 'software' }) });
  const page = await application.firstWindow(), native = await application.browserWindow(page);
  await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 900); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.hide(); });
  await ensureCompanionTestWorkspace(page);
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
  await page.evaluate(async baseUrl => (window as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', baseUrl, model: 'social-fixture', apiKey: 'fixture-only-social-key' }), baseUrl);
  await page.locator('[data-application-module="companions"]').click();
  const state = (await request(page, { type: 'state' })).state!, extra = state.companions.filter(member => ![sender, receiver].includes(member.id)).slice(0, 2).map(member => member.id);
  const ids = [sender, receiver, ...extra]; expect(ids).toHaveLength(4);
  const snapshot = await world(page); await request(page, { type: 'world.configure', expectedRevision: snapshot.settings.revision, patch: { mode: 'realtime' } });
  for (const companionId of ids) { const conversationId = (await request(page, { type: 'conversation.open', companionId })).conversation!.id;
    const routine = (await request(page, { type: 'routine.get', companionId, conversationId })).routine!, current = await world(page);
    await request(page, { type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision,
      patch: { timeZone: current.settings.timeZone, wakeAt: clock(current.clock.hour - 8), sleepAt: clock(current.clock.hour + 8), meals: [], habits: [] } }); }
  return { application, page, ids };
}
async function startTopic(page: Page, fixture: Awaited<ReturnType<typeof provider>>, recipients: string[], triggerId: string) {
  fixture.arm(recipients);
  await request(page, { type: 'world.tool', companionId: triggerId, conversationId: 'private-' + triggerId,
    arguments: { action: 'visit', targetCompanionId: sender, reason: '路过想聊聊，房主可真实选择现在做什么。' } });
  await expect.poll(async () => (await request(page, { type: 'social.conversations', limit: 20 })).socialConversationPage?.items.some(room => new Set([sender, ...recipients]).size === room.memberIds.length && room.memberIds.every(id => [sender, ...recipients].includes(id))), { timeout: 30000 }).toBe(true);
  return (await request(page, { type: 'social.conversations', limit: 20 })).socialConversationPage!.items.find(room => room.memberIds.length === recipients.length + 1 && room.memberIds.every(id => [sender, ...recipients].includes(id)))!;
}
async function verifyQuietPlayerQueues(page: Page, logs: Record[]) {
  const state = (await request(page, { type: 'state' })).state!; expect(state.queue ?? []).toEqual([]); expect(state.activities).toEqual([]);
  const peers = (await request(page, { type: 'social.conversations', limit: 20 })).socialConversationPage!.items;
  for (const conversationId of new Set([...state.conversations.map(room => room.id), ...peers.map(room => room.id)])) expect((await request(page, { type: 'actions', conversationId })).actions).toEqual([]);
  expect(logs.some(log => log.purpose === 'primary_reply')).toBe(false); expect(logs.filter(log => log.purpose === 'world_social').every(log => !log.tools && !log.participants!.includes('user'))).toBe(true);
}
for (const group of [false, true]) {
  // eslint-disable-next-line no-empty-pattern
  test(group ? 'autonomous phone group keeps real identities, one reusable room and a four-message chain' : 'autonomous private phone waits for the sleeping recipient and uses actual source identity', async ({}, testInfo) => {
    test.setTimeout(150000); const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-social-e2e-')), fixture = await provider(); let application: ElectronApplication | undefined;
    try {
      const started = await launch(root, fixture.baseUrl); application = started.application; const { page, ids } = started;
      if (!group) { const scope = { companionId: receiver, conversationId: 'private-' + receiver }, routine = (await request(page, { type: 'routine.get', ...scope })).routine!, current = await world(page);
        await request(page, { type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { wakeAt: clock(current.clock.hour + 3), sleepAt: clock(current.clock.hour - 3) } });
        await expect.poll(async () => (await request(page, { type: 'state.get', ...scope })).runtimeState?.routine?.phase, { timeout: 20000 }).toBe('sleeping'); }
      const room = await startTopic(page, fixture, group ? [receiver, ids[2]!] : [receiver], ids[3]!);
      await expect.poll(async () => (await request(page, { type: 'social.messages', conversationId: room.id, limit: 50 })).socialMessagePage?.items.length, { timeout: 15000 }).toBe(1);
      const initial = (await request(page, { type: 'social.messages', conversationId: room.id, limit: 50 })).socialMessagePage!.items[0]!;
      expect(initial.message.authorId).toBe(sender); expect(initial.message.content).toBe(opening); expect(new Set(initial.recipientIds)).toEqual(new Set(group ? [receiver, ids[2]!] : [receiver]));
      if (!group) { await page.waitForTimeout(1600); expect(fixture.logs.filter(log => log.purpose === 'world_social')).toHaveLength(0);
        const scope = { companionId: receiver, conversationId: 'private-' + receiver }; expect((await request(page, { type: 'state.get', ...scope })).runtimeState!.routine!.phase).toBe('sleeping');
        const routine = (await request(page, { type: 'routine.get', ...scope })).routine!, current = await world(page);
        await request(page, { type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { wakeAt: clock(current.clock.hour - 8), sleepAt: clock(current.clock.hour + 8) } }); }
      await expect.poll(() => fixture.logs.filter(log => log.purpose === 'world_social').length, { timeout: 25000 }).toBe(1);
      const typing = await world(page), typingOwner = fixture.logs.find(log => log.purpose === 'world_social')!.self!;
      expect(typing.actors.find(actor => actor.companionId === typingOwner)!.artAction).toMatch(/^phoneTyping(?:Standing|Seated)$/u);
      expect(fixture.logs.find(log => log.purpose === 'world_social')).toMatchObject({ sourceId: initial.message.id, speaker: sender });
      fixture.finishReplies();
      await expect.poll(async () => (await request(page, { type: 'social.messages', conversationId: room.id, limit: 50 })).socialMessagePage?.total, { timeout: 30000 }).toBe(4);
      await page.waitForTimeout(1800); expect(fixture.logs.filter(log => log.purpose === 'world_social')).toHaveLength(3);
      const messages = (await request(page, { type: 'social.messages', conversationId: room.id, limit: 50 })).socialMessagePage!.items;
      expect(messages.every(item => item.message.authorId !== 'user' && item.recipientIds.every(id => id !== item.message.authorId && room.memberIds.includes(id)))).toBe(true);
      if (group) expect(new Set(messages.map(item => item.message.authorId))).toEqual(new Set(room.memberIds));
      await verifyQuietPlayerQueues(page, fixture.logs);
      fixture.stopReplies();
      await request(page, { type: 'world.tool', companionId: receiver, conversationId: 'private-' + receiver,
        arguments: { action: 'message', recipientIds: room.memberIds.filter(id => id !== receiver).reverse(), text: '第二次仍使用这个成员集合的同一个伙伴会话。' } });
      await expect.poll(async () => (await request(page, { type: 'social.messages', conversationId: room.id, limit: 50 })).socialMessagePage?.total, { timeout: 20000 }).toBe(5);
      const rooms = (await request(page, { type: 'social.conversations', limit: 20 })).socialConversationPage!.items.filter(item => item.memberIds.length === room.memberIds.length && item.memberIds.every(id => room.memberIds.includes(id)));
      expect(rooms).toHaveLength(1); expect(rooms[0]!.id).toBe(room.id);
      await page.getByRole('button', { name: '打开伙伴社交观察' }).click(); await expect(page.getByRole('dialog', { name: '伙伴社交观察' })).toBeVisible();
      await page.locator(`[data-social-conversation="${room.id}"]`).click(); await expect(page.locator(`[data-social-message="${initial.message.id}"]`)).toBeVisible();
      const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true }); await page.screenshot({ path: path.join(artifacts, group ? 'verified-social-phone-group.png' : 'verified-social-phone-private.png') });
      await testInfo.attach('real-peer-phone-chain', { body: JSON.stringify({ room, messages, logs: fixture.logs, typing: typing.actors.find(actor => actor.companionId === typingOwner) }), contentType: 'application/json' });
    } catch (error) {
      await testInfo.attach('social-failure', { body: JSON.stringify({ error: error instanceof Error ? error.message : String(error), logs: fixture.logs }), contentType: 'application/json' });
      throw error;
    } finally { await application?.close().catch(() => undefined); await fixture.close(); cleanup(root); }
  });
}
