import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi } };
async function request(page: Page, input: CompanionsRequest) { const result = await page.evaluate(value => (window as unknown as Bridge).worldlinebox.companions.request(value), input); expect(result.ok, result.error).toBe(true); return result; }
function cleanup(root: string) { const absolute = path.resolve(root); if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-reset-e2e-')) throw new Error('Unexpected reset fixture cleanup.'); rmSync(absolute, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); }

// Real UtilityProcess/SQLite, provider stream, public forms and managed files.
// Only the provider and OS chooser are fixtures; no reset handler is replaced.
// eslint-disable-next-line no-empty-pattern
test('factory reset restores the built-in, stops an old stream, preserves other people and persists across restart', async ({}, testInfo) => {
  test.setTimeout(240000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-reset-e2e-')), profile = path.join(root, 'profile'), originalFile = path.join(root, 'shared-avatar.png');
  await sharp({ create: { width: 96, height: 96, channels: 4, background: '#6384aa' } }).png().toFile(originalFile);
  let application: ElectronApplication | undefined, held: ServerResponse | undefined, oldStreamClosed = false;
  const primaryContexts: string[] = [];
  const server = createServer((incoming, response) => {
    let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { raw += chunk; }); incoming.on('end', () => {
      try {
        const body = JSON.parse(raw), serialized = body.messages[1].content as string, context = JSON.parse(serialized); let output: unknown;
        if (context.purpose === 'world_attention') output = { urgency: 'ordinary', confidence: .98, evidence: [context.source.content], reason: '普通聊天。' };
        else if (context.purpose === 'world_decision') output = { action: null, reason: '保持当前生活。', appraisals: [] };
        else if (context.purpose === 'memory_query') output = {};
        else if (context.purpose === 'memory_dream') output = { candidates: [], dream: null };
        else if (context.purpose?.startsWith('memory_')) output = { candidates: [] };
        else {
          primaryContexts.push(serialized);
          if (context.taskRequest?.prompt === 'RESET_PENDING') {
            held = response; response.on('close', () => { oldStreamClosed = true; });
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '{"text":"重置前的旧草稿' }, finish_reason: null }] }) + '\n\n'); return;
          }
          output = { text: context.taskRequest?.prompt === '重新开始的问候' ? '已经重新开始，新的问候收到啦。' : '收到这条测试记录了。', memories: [] };
        }
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }));
      } catch { response.writeHead(400); response.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const launch = async () => {
    const app = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'software' }) });
    const page = await app.firstWindow(), window = await app.browserWindow(page); await window.evaluate(value => { value.unmaximize(); value.setSize(1360, 1000); value.setOpacity(0); value.setFocusable(false); value.webContents.setBackgroundThrottling(false); value.hide(); });
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page'); return { app, page };
  };
  try {
    let launched = await launch(); application = launched.app; let page = launched.page;
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.'); const baseUrl = 'http://127.0.0.1:' + address.port;
    await page.evaluate(baseUrl => (window as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', baseUrl, model: 'reset-fixture', apiKey: 'fixture-global' }), baseUrl);
    const world = (await request(page, { type: 'world.snapshot' })).world!;
    await request(page, { type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime' } });
    const clock = (offset: number) => String((Math.floor(world.clock.hour) + offset + 24) % 24).padStart(2, '0') + ':00';
    const rooms = new Map<string, string>();
    for (const companionId of ['deepseek-sister', 'deepseek-flash']) {
      const room = (await request(page, { type: 'conversation.open', companionId })).conversation!; rooms.set(companionId, room.id);
      const routine = (await request(page, { type: 'routine.get', companionId, conversationId: room.id })).routine!;
      await request(page, { type: 'routine.configure', companionId, conversationId: room.id, expectedRevision: routine.revision, patch: { timeZone: world.settings.timeZone, wakeAt: clock(-8), sleepAt: clock(8), meals: [], habits: [] } });
    }
    await application.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, originalFile);
    const image = (await request(page, { type: 'attachment.pick', kind: 'image', purpose: 'avatar' })).attachments![0]!;
    const player = (await request(page, { type: 'player.profile.get' })).playerProfile!;
    await request(page, { type: 'player.profile.update', expectedRevision: player.revision, profile: { name: '测试玩家', description: '用户资料必须保留', avatarAttachmentId: image.id } });
    const sister = (await request(page, { type: 'state' })).state!.companions.find(person => person.id === 'deepseek-sister')!;
    await request(page, { type: 'companion.update', id: sister.id, expectedRevision: sister.revision, companion: { name: '临时的姐姐', description: '需要恢复的自定义描述', persona: '临时人设需要彻底恢复。', model: '', avatar: 'custom', avatarAttachmentId: image.id, appearanceAttachmentId: image.id, proactive: false,
      llm: { apiFormat: 'openai_chat', baseUrl, model: 'reset-fixture' } }, apiKey: 'fixture-private-key' });
    const send = async (conversationId: string, content: string, replyCount = 1) => {
      const source = (await request(page, { type: 'message.send', conversationId, content, clientId: content.replace(/[^a-zA-Z0-9]/gu, '') + Date.now() })).message!;
      await expect.poll(async () => ((await request(page, { type: 'messages', conversationId })).messages ?? []).filter(message => message.replyToId === source.id && message.authorId !== 'user' && !message.isReplyDraft).length, { timeout: 45000 }).toBe(replyCount); return source;
    };
    const ownRoom = rooms.get(sister.id)!, otherRoom = rooms.get('deepseek-flash')!;
    const old = await send(ownRoom, '重置前我喜欢深海散步。');
    await request(page, { type: 'memory.save', companionId: sister.id, conversationId: ownRoom, sourceMessageId: old.id, content: '玩家喜欢深海散步。' });
    const other = await send(otherRoom, '妹妹私聊中必须保留的内容。');
    const group = (await request(page, { type: 'conversation.create-group', title: '重置边界测试群', memberIds: ['deepseek-sister', 'deepseek-flash'] })).conversation!;
    const shared = await send(group.id, '群里其他人的发言必须保留。', 2);
    const preservedFlash = ((await request(page, { type: 'messages', conversationId: group.id })).messages ?? []).find(message => message.authorId === 'deepseek-flash')!;
    await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click(); await page.locator('[data-companion-contact="deepseek-sister"]').click();
    await expect(page.getByRole('button', { name: '移除联系人', exact: true })).toHaveCount(0);
    await request(page, { type: 'message.send', conversationId: ownRoom, content: 'RESET_PENDING', clientId: 'held-before-reset' });
    await expect.poll(() => !!held, { timeout: 45000 }).toBe(true);
    await page.getByRole('button', { name: '重置伙伴', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '重置伙伴', exact: true });
    await expect(dialog.getByRole('button', { name: '确认重置', exact: true })).toBeDisabled(); await dialog.getByLabel('确认重置的伙伴名字', { exact: true }).fill('临时的姐姐'); await dialog.getByRole('button', { name: '确认重置', exact: true }).click();
    await expect(dialog).toContainText('重置完成', { timeout: 45000 }); await expect.poll(() => oldStreamClosed).toBe(true);
    held!.end('data: [DONE]\n\n');
    const defaults = BUILTIN_COMPANIONS.find(person => person.id === sister.id)!;
    const state = (await request(page, { type: 'state' })).state!, restored = state.companions.find(person => person.id === sister.id)!;
    expect(restored).toMatchObject({ name: defaults.name, description: defaults.description, persona: defaults.persona, avatar: defaults.avatar, builtin: true });
    expect(restored.llm).toBeUndefined(); expect(restored.avatarAttachmentId).toBeUndefined(); expect(restored.appearanceAttachmentId).toBeUndefined();
    expect((await request(page, { type: 'memory.list', companionId: sister.id })).memories).toEqual([]);
    expect((await request(page, { type: 'messages', conversationId: ownRoom })).messages).toEqual([]);
    const remainingGroup = (await request(page, { type: 'messages', conversationId: group.id })).messages!;
    expect(remainingGroup.some(message => message.id === shared.id)).toBe(true); expect(remainingGroup.some(message => message.id === preservedFlash.id)).toBe(true); expect(remainingGroup.some(message => message.authorId === sister.id)).toBe(false);
    expect(state.conversations.find(room => room.id === group.id)!.memberIds).toEqual(['deepseek-flash']);
    expect((await request(page, { type: 'messages', conversationId: otherRoom })).messages!.some(message => message.id === other.id)).toBe(true);
    expect(state.playerProfile).toMatchObject({ name: '测试玩家', avatarAttachmentId: image.id });
    expect(await page.evaluate(id => fetch('worldlinebox-companion://attachment/' + id).then(value => value.status), image.id)).toBe(200);
    expect(existsSync(originalFile)).toBe(true); expect(JSON.parse(readFileSync(path.join(profile, 'companions/llm-keys.enc.json'), 'utf8'))[sister.id]).toBeUndefined();
    const artifacts = path.resolve('artifacts/companions'); mkdirSync(artifacts, { recursive: true }); await page.screenshot({ path: path.join(artifacts, 'verified-companion-reset.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    const routine = (await request(page, { type: 'routine.get', companionId: sister.id, conversationId: ownRoom })).routine!;
    await request(page, { type: 'routine.configure', companionId: sister.id, conversationId: ownRoom, expectedRevision: routine.revision, patch: { timeZone: world.settings.timeZone, wakeAt: clock(-8), sleepAt: clock(8), meals: [], habits: [] } });
    await send(ownRoom, '重新开始的问候'); const context = primaryContexts.findLast(value => JSON.parse(value).taskRequest?.prompt === '重新开始的问候')!;
    expect(context).not.toContain('重置前我喜欢深海散步'); expect(context).not.toContain('临时人设需要彻底恢复'); expect(context).not.toContain('重置前的旧草稿');
    await application.close(); application = undefined;
    launched = await launch(); application = launched.app; page = launched.page;
    const persisted = (await request(page, { type: 'state' })).state!; expect(persisted.companions.find(person => person.id === sister.id)).toMatchObject({ name: defaults.name, persona: defaults.persona });
    const messages = (await request(page, { type: 'messages', conversationId: ownRoom })).messages!; expect(messages.some(message => message.content === '重新开始的问候')).toBe(true); expect(messages.some(message => message.id === old.id)).toBe(false);
    const report = { fixtureKind: 'real_electron_factory_reset', restoredDefaultProfile: true, stoppedInFlightStream: oldStreamClosed, oldResultNotReplayed: true, preservedOtherPrivateChat: true, preservedOtherGroupAuthors: true, leftOldGroup: true, preservedSharedPlayerAvatar: true, sourceOriginalKept: true, encryptedCompanionKeyRemoved: true, freshContextAfterReset: true, persistedAcrossRestart: true };
    writeFileSync(path.join(artifacts, 'verified-companion-reset.json'), JSON.stringify(report, null, 2)); await testInfo.attach('actual-factory-reset', { body: JSON.stringify(report), contentType: 'application/json' });
  } finally { held?.destroy(); await application?.close().catch(() => undefined); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); cleanup(root); }
});
