import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import type { CompanionPublicProfile } from '../../src/shared/companion-public-profile';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import { removeCompanionTestDirectory, ensureCompanionTestWorkspace, electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi } };
type ImageProof = { personId: string; role: string; sha256: string; mime: string; width: number; height: number; bytes: number; detail: string };
type Capture = { context: { publicProfiles: CompanionPublicProfile[]; identity: { currentReply: { speaker: { id: string; name: string } } }; visionManifest: Array<{ personId: string; role: string; delivery: string }> }; images: ImageProof[] };
async function request(page: Page, input: CompanionsRequest) { const result = await page.evaluate(value => (window as unknown as Bridge).worldlinebox.companions.request(value), input); expect(result.ok, result.error).toBe(true); return result; }
function cleanup(root: string) { const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-profile-e2e-')) throw new Error('Unexpected profile fixture cleanup path.'); removeCompanionTestDirectory(resolved); }
async function launch(profile: string) {
  const packaged = process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE;
  const application = await electron.launch({ executablePath: packaged ?? resolveElectronExecutablePath(), args: packaged ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'software' }) });
  const page = await application.firstWindow(), native = await application.browserWindow(page);
  await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 1000); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.hide(); });
  await ensureCompanionTestWorkspace(page);
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page'); return { application, page };
}
async function choose(application: ElectronApplication, filename?: string) { await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: !file, filePaths: file ? [file] : [] }); }, filename); }

test('all built-in contacts show their complete default orthographic reference', async () => {
  test.setTimeout(90000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-profile-e2e-')); const { application, page } = await launch(path.join(root, 'profile'));
  try {
    await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click();
    for (const companion of BUILTIN_COMPANIONS) {
      await page.locator(`[data-companion-contact="${companion.id}"]`).click();
      const image = page.locator('.companions-contact-profile .public-appearance-thumbnail img');
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > node.naturalHeight)).toBe(true);
      await expect(page.locator('.companions-contact-profile')).not.toContainText('还没有添加三视图');
    }
    await page.locator('[data-companion-contact="huan-black"]').click();
    await page.screenshot({ path: path.resolve('.tools/test-output/verified-builtin-orthographic-contact.png') });
  } finally { await application.close(); cleanup(root); }
});
async function openSettings(page: Page) { await page.getByRole('button', { name: '设置', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '通用设置', exact: true }); await expect(dialog.getByRole('tab', { name: '用户信息', exact: true })).toHaveAttribute('aria-selected', 'true'); return dialog; }
async function awake(page: Page, companionId: string, conversationId: string) {
  const world = (await request(page, { type: 'world.snapshot' })).world!; await request(page, { type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime' } });
  const routine = (await request(page, { type: 'routine.get', companionId, conversationId })).routine!, clock = (delta: number) => String((Math.floor(world.clock.hour) + delta + 24) % 24).padStart(2, '0') + ':00';
  await request(page, { type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision, patch: { timeZone: world.settings.timeZone, wakeAt: clock(-8), sleepAt: clock(8), meals: [], habits: [] } });
}

// Only the OS chooser is replaced. Main still copies/validates real files,
// persists references, serves them through its protocol and sends actual JPEG pixels.
// eslint-disable-next-line no-empty-pattern
test('persists public player and companion references, displays the real user identity and sends current labelled image pixels', async ({}, testInfo) => {
  test.setTimeout(180000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-profile-e2e-')), profilePath = path.join(root, 'profile'), uploads = path.join(root, 'uploads'); mkdirSync(uploads);
  const avatarFile = path.join(uploads, 'avatar.png'), boardFile = path.join(uploads, 'orthographic.png');
  const board = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="480"><rect width="960" height="480" fill="#f4f2eb"/><text x="30" y="40" font-family="Arial" font-size="18" fill="#49656c">PUBLIC CHARACTER REFERENCE</text>${['FRONT', 'SIDE', 'BACK'].map((label, i) => `<g transform="translate(${160 + i * 320},135)"><circle cy="0" r="35" fill="#e8c9b1"/><path d="M-33 50Q0 25 33 50L45 180H-45Z" fill="${i === 1 ? '#7d9da3' : '#95b4b6'}"/><path d="M-25 180V250M25 180V250" stroke="#50656c" stroke-width="22"/><text y="300" text-anchor="middle" font-family="Arial" font-size="17" fill="#49656c">${label}</text></g>`).join('')}</svg>`;
  await sharp(Buffer.from(board)).png().toFile(boardFile);
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" rx="90" fill="#8faeb3"/><circle cx="90" cy="66" r="31" fill="#f2e8da"/><path d="M35 155Q42 100 90 100Q138 100 145 155" fill="#f2e8da"/></svg>')).png().toFile(avatarFile);
  const captures: Capture[] = [], providerErrors: string[] = [], auxiliaryPurposes: string[] = []; let application: ElectronApplication | undefined;
  const server = createServer((incoming, outgoing) => { let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { raw += chunk; }); incoming.on('end', () => { void (async () => {
    try {
      const payload = JSON.parse(raw);
      if (payload.messages?.length === 1 && payload.messages[0]?.role === 'user' && payload.messages[0]?.content === 'Reply with the single word OK.') { auxiliaryPurposes.push('connection_probe'); outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })); return; }
      const context = JSON.parse(payload.messages[1]?.content ?? payload.messages[0]?.content); let output: unknown;
      if (payload.messages.length === 1) { if (typeof context.purpose !== 'string') throw new Error('A primary reply must retain the base JSON in messages[1].'); auxiliaryPurposes.push(context.purpose); }
      if (context.purpose === 'world_decision') output = { action: null, reason: '保持当前生活安排。', appraisals: [] };
      else if (context.purpose === 'world_attention') output = { urgency: 'ordinary', confidence: .99, evidence: [context.source.content], reason: '正常交流。' };
      else if (context.purpose === 'vcp_memory_prohibition_check') output = { allowed: true, matchedPolicyIds: [] };
      else if (context.purpose === 'vcp_sleep_reflection') output = { notes: [], dream: null };
      else if (context.purpose === 'vcp_experience_journal') output = { notes: [] };
      else {
        const images: ImageProof[] = [];
        for (const message of payload.messages.filter((message: { role: string; content: unknown }) => message.role === 'user' && Array.isArray(message.content))) {
          let label: { personId: string; role: string; sha256: string } | undefined;
          for (const part of message.content) {
            if (part.type === 'text') label = JSON.parse(part.text).publicImage;
            if (part.type === 'image_url') { if (!label) throw new Error('Image has no identity label.'); const match = part.image_url.url.match(/^data:(image\/jpeg);base64,(.+)$/); if (!match) throw new Error('Expected actual JPEG data.'); const bytes = Buffer.from(match[2], 'base64'), metadata = await sharp(bytes).metadata(); const hash = createHash('sha256').update(bytes).digest('hex'); if (hash !== label.sha256) throw new Error('Image label checksum mismatch.'); images.push({ ...label, sha256: hash, mime: match[1], width: metadata.width!, height: metadata.height!, bytes: bytes.length, detail: part.image_url.detail }); label = undefined; }
          }
        }
        captures.push({ context, images }); output = '公开资料已经提供，我们接着聊吧。';
      }
      outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ choices: [{ message: { content: typeof output === 'string' ? output : JSON.stringify(output) }, finish_reason: 'stop' }] }));
    } catch (cause) { providerErrors.push(cause instanceof Error ? cause.message + ' ' + cause.stack?.split('\n')[1]?.trim() : 'Provider fixture failed.'); outgoing.writeHead(400); outgoing.end(); }
  })(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    let started = await launch(profilePath); application = started.application; let page = started.page;
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local provider.');
    await page.evaluate(baseUrl => (window as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', baseUrl, model: 'gpt-4o', apiKey: 'fixture-public-profile-key' }), 'http://127.0.0.1:' + address.port);
    await request(page, { type: 'player.profile.get' });
    let settings = await openSettings(page); expect(await settings.locator('.app-settings-nav-list [role="tab"]').first().textContent()).toBe('用户信息');
    const form = settings.getByRole('form', { name: '用户信息', exact: true });
    await form.getByRole('textbox', { name: '姓名', exact: true }).fill('林澈'); await form.getByRole('textbox', { name: '公开自述', exact: true }).fill('喜欢看海、画画和安静的音乐。');
    await choose(application, avatarFile); await form.getByRole('button', { name: '选择头像', exact: true }).click();
    await page.getByRole('dialog', { name: '调整头像', exact: true }).getByRole('button', { name: '使用此头像', exact: true }).click(); await expect(page.getByRole('dialog', { name: '调整头像', exact: true })).toHaveCount(0);
    await choose(application, boardFile); await form.getByRole('button', { name: '上传三视图', exact: true }).click();
    await expect.poll(() => form.locator('.public-appearance-thumbnail img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(960);
    const selectedBoard = await form.locator('.public-appearance-thumbnail img').getAttribute('src'); await choose(application); await form.getByRole('button', { name: '更换三视图', exact: true }).click(); expect(await form.locator('.public-appearance-thumbnail img').getAttribute('src')).toBe(selectedBoard);
    expect((await request(page, { type: 'player.profile.get' })).playerProfile!.name).toBe('我');
    await form.getByRole('button', { name: '保存用户信息', exact: true }).click(); await expect(form).toContainText('用户信息已保存');
    const saved = (await request(page, { type: 'player.profile.get' })).playerProfile!; expect(saved).toMatchObject({ id: 'user', name: '林澈', description: '喜欢看海、画画和安静的音乐。' }); expect(saved.avatarAttachmentId).toBeTruthy(); expect(saved.appearanceAttachmentId).toBeTruthy();
    await form.getByRole('button', { name: '预览公开三视图', exact: true }).click(); await expect(page.getByRole('dialog', { name: '预览公开三视图', exact: true }).locator('img')).toBeVisible(); await page.keyboard.press('Escape'); await expect(settings).toBeVisible(); await expect(form.getByRole('button', { name: '预览公开三视图', exact: true })).toBeFocused();
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true });
    await settings.getByRole('tab', { name: '外观', exact: true }).click(); await settings.getByRole('radio', { name: 'WorldlineBox', exact: true }).click(); await settings.getByRole('radio', { name: '亮色', exact: true }).click(); await settings.getByRole('tab', { name: '用户信息', exact: true }).click(); await settings.locator('.app-settings-content').evaluate(element => { element.scrollTop = 0; }); await page.screenshot({ path: path.join(artifacts, 'verified-player-profile-light.png') });
    await form.getByRole('button', { name: '预览公开三视图', exact: true }).click(); await expect(page.getByRole('dialog', { name: '预览公开三视图', exact: true }).locator('img')).toBeVisible(); await page.screenshot({ path: path.join(artifacts, 'verified-player-orthographic-preview.png') }); await page.keyboard.press('Escape');
    await settings.getByRole('tab', { name: '外观', exact: true }).click(); await settings.getByRole('radio', { name: '暗色', exact: true }).click(); await settings.getByRole('tab', { name: '用户信息', exact: true }).click(); await settings.locator('.app-settings-content').evaluate(element => { element.scrollTop = 0; }); await page.screenshot({ path: path.join(artifacts, 'verified-player-profile-dark.png') }); await page.keyboard.press('Escape');
    await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click(); await page.locator('[data-companion-contact="deepseek-sister"]').click(); await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    let edit = page.getByRole('dialog', { name: '编辑伙伴资料', exact: true }); await choose(application, boardFile); await edit.getByRole('button', { name: '上传三视图', exact: true }).click(); await edit.getByRole('button', { name: '保存资料', exact: true }).click(); await expect(edit).toHaveCount(0);
    await expect(page.locator('.companions-contact-profile .public-appearance-thumbnail img')).toBeVisible();
    await page.getByRole('button', { name: '发消息', exact: true }).click(); const companionId = 'deepseek-sister', conversationId = 'private-deepseek-sister'; await awake(page, companionId, conversationId);
    async function send(text: string, expected: number) { await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(text); await page.getByRole('button', { name: '发送', exact: true }).click(); await expect.poll(() => captures.length, { timeout: 35000 }).toBe(expected); await expect.poll(async () => (await request(page, { type: 'messages', conversationId, limit: 50 })).messages?.filter(message => message.authorId === companionId && !message.isReplyDraft && message.content.includes('公开资料已经提供')).length ?? 0, { timeout: 20000 }).toBe(expected); }
    await send('我们先从公开资料认识一下彼此吧。', 1);
    expect(captures[0]!.images.map(image => image.personId + '/' + image.role).sort()).toEqual(['deepseek-sister/avatar', 'deepseek-sister/orthographic', 'user/avatar', 'user/orthographic']);
    for (const image of captures[0]!.images) { expect(image.bytes).toBeGreaterThan(100); expect(image.bytes).toBeLessThanOrEqual(1024 * 1024); expect(image.width).toBeGreaterThan(0); expect(image.height).toBeGreaterThan(0); expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(image.role === 'orthographic' ? 1536 : 512); expect(image.detail).toBe(image.role === 'orthographic' ? 'high' : 'low'); }
    const user = captures[0]!.context.publicProfiles.find(person => person.id === 'user')!, self = captures[0]!.context.publicProfiles.find(person => person.id === companionId)!;
    expect(user).toMatchObject({ name: saved.name, description: saved.description });
    for (const image of [user.avatar, user.orthographic, self.avatar, self.orthographic]) { expect(image?.available).toBe(true); expect(path.isAbsolute(image!.absolutePath!)).toBe(true); expect(existsSync(image!.absolutePath!)).toBe(true); }
    expect(captures[0]!.context.identity.currentReply.speaker).toMatchObject({ id: 'user', name: saved.name });
    const own = page.locator('.companions-message.is-own').first(); await expect(own.locator('.companions-message-author')).toContainText(saved.name); expect(await own.locator('.companion-avatar').evaluate(element => getComputedStyle(element).backgroundSize)).toBe('cover');
    await page.screenshot({ path: path.join(artifacts, 'verified-player-chat-identity.png') });
    expect((await request(page, { type: 'messages', conversationId, limit: 50 })).messages!.find(message => message.content === '我们先从公开资料认识一下彼此吧。')!.authorId).toBe('user');
    rmSync(avatarFile); rmSync(boardFile); await application.close(); application = undefined;
    started = await launch(profilePath); application = started.application; page = started.page;
    settings = await openSettings(page); expect((await request(page, { type: 'player.profile.get' })).playerProfile).toMatchObject({ avatarAttachmentId: saved.avatarAttachmentId, appearanceAttachmentId: saved.appearanceAttachmentId });
    await expect.poll(() => settings.locator('.public-appearance-thumbnail img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(960);
    await page.keyboard.press('Escape'); await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click(); await page.locator('[data-companion-contact="deepseek-sister"]').click(); await page.getByRole('button', { name: '发消息', exact: true }).click();
    await send('原始上传文件已经删除，我们继续聊吧。', 2);
    expect(captures[1]!.images.map(image => image.personId + '/' + image.role).sort()).toEqual(captures[0]!.images.map(image => image.personId + '/' + image.role).sort());
    settings = await openSettings(page);
    await settings.getByRole('button', { name: '移除三视图', exact: true }).click(); await settings.getByRole('button', { name: '保存用户信息', exact: true }).click(); await expect(settings).toContainText('用户信息已保存'); await page.keyboard.press('Escape');
    await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click(); await page.locator('[data-companion-contact="deepseek-sister"]').click(); await page.getByRole('button', { name: '编辑资料', exact: true }).click(); edit = page.getByRole('dialog', { name: '编辑伙伴资料', exact: true }); await edit.getByRole('button', { name: '恢复内置三视图', exact: true }).click(); await edit.getByRole('button', { name: '保存资料', exact: true }).click(); await page.getByRole('button', { name: '发消息', exact: true }).click();
    await send('我们继续聊，公开设定板现在已经移除了。', 3);
    expect(captures[2]!.images.map(image => image.personId + '/' + image.role).sort()).toEqual(['deepseek-sister/avatar', 'deepseek-sister/orthographic', 'user/avatar']);
    expect(JSON.stringify(captures[2]!.context)).not.toContain(user.orthographic!.absolutePath!); expect(JSON.stringify(captures[2]!.context)).not.toContain(self.orthographic!.absolutePath!);
    settings = await openSettings(page); await settings.getByRole('button', { name: '移除头像', exact: true }).click(); await settings.getByRole('button', { name: '保存用户信息', exact: true }).click(); await expect(settings).toContainText('用户信息已保存'); expect((await request(page, { type: 'player.profile.get' })).playerProfile!.avatarAttachmentId).toBeUndefined();
    expect(providerErrors).toEqual([]);
    const report = { fixtureKind: 'synthetic_public_profile', authorId: 'user', imageProofs: captures.map(capture => capture.images), originalUploadsDeleted: true, restartPreservedManagedImages: true, removedCustomBoardsAbsentFromNextRequest: true, builtInBoardRestored: true, auxiliaryPurposes, providerErrors };
    writeFileSync(path.join(artifacts, 'verified-companion-public-profile.json'), JSON.stringify(report, null, 2)); await testInfo.attach('public-profile-image-proof', { body: JSON.stringify(report), contentType: 'application/json' });
  } catch (cause) {
    const logs = application && await application.evaluate(({ app }) => app.getPath('logs')).catch(() => undefined);
    if (logs && existsSync(logs)) {
      const diagnostics = readdirSync(logs).filter(file => file.endsWith('.log')).flatMap(file => readFileSync(path.join(logs, file), 'utf8').split('\n').filter(line => line.includes('companions.initialization') || line.includes('companions.service'))).join('\n').replaceAll(root, '<isolated-profile>').replaceAll('fixture-public-profile-key', '<fixture-key>');
      await testInfo.attach('profile-diagnostics', { body: diagnostics, contentType: 'text/plain' });
      if (diagnostics) console.log(diagnostics);
    }
    throw cause;
  } finally { await application?.close().catch(() => undefined); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); cleanup(root); }
});
