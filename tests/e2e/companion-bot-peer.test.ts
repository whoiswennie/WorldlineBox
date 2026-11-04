import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { _electron as electron, expect, test, type Locator } from '@playwright/test';
import type { BotMessage, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { BotPeerWorkspaceFixture } from '../fixtures/bot-peer-workspace-fixture';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

async function hashFile(filename: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }

// eslint-disable-next-line no-empty-pattern -- The real Electron app owns its page.
test('groups and observed peer private conversations remain distinct in the regular packaged chat UI', async ({}, testInfo) => {
  test.setTimeout(120000);
  testInfo.annotations.push({ type: 'isolated-store-fixture', description: 'Human-authored ordinary group, observed peer private conversation and user-directed contact through real BotStore/enqueue/settle, followed by Main IPC and renderer. No model credentials or paid requests; not an AI quality evaluation.' });
  const prefix = 'wlb-peer-workspace-', profile = await mkdtemp(path.join(tmpdir(), prefix));
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith(prefix) || (await lstat(profile)).isSymbolicLink()
    || path.resolve(await realpath(profile)) !== path.resolve(profile)) throw Error('Unexpected owned peer workspace test profile.');
  const fixtureDirectory = testInfo.outputPath('fixture'); await mkdir(fixtureDirectory, { recursive: true });
  await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'warn', build: { ssr: 'tests/fixtures/bot-peer-workspace-fixture.ts', target: 'node24', outDir: fixtureDirectory, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'seed.cjs' } } } });
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }) });
  try {
    const page = await application.firstWindow();
    const identity = await application.evaluate(({ app, BrowserWindow }, expected) => {
      if (app.getPath('userData') !== expected) throw Error('Peer fixtures must not access the production profile.');
      const frames = { paints: 0 }; Reflect.set(globalThis, '__peerUiFrames', frames);
      for (const owned of BrowserWindow.getAllWindows()) {
        owned.on('show', () => owned.hide()); owned.webContents.setBackgroundThrottling(false);
        owned.webContents.on('paint', () => { frames.paints++; }); owned.setMinimumSize(0, 0); owned.setSize(1440, 960); owned.hide();
      }
      return { packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData'), offscreen: BrowserWindow.getAllWindows()[0]!.webContents.isOffscreen() };
    }, profile);
    const initialHash = identity.packaged ? await hashFile(identity.appPath) : undefined;
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) { expect(identity.packaged).toBe(true); expect(identity.appPath).toMatch(/app\.asar$/u); }
    expect(identity.offscreen).toBe(true);
    await page.locator('[data-application-module="companions"]').click(); await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    await expect(page.locator('.application-navigation')).toBeVisible();
    expect(await page.locator('.application-navigation [data-application-module]').count()).toBeGreaterThanOrEqual(5);
    const seeded = await application.evaluate(({ app }, input) => {
      if (app.getPath('userData') !== input.profile) throw Error('Unexpected peer fixture profile.');
      const { createRequire } = process.getBuiltinModule('node:module');
      const require = createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      const fs = require('node:fs'), paths = process.getBuiltinModule('node:path'), catalogPath = paths.join(input.profile, 'ai-profiles.json');
      const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : { activeProfileId: null, profiles: [] };
      const credentials = paths.join(input.profile, 'ai-profile-keys');
      if (catalog.activeProfileId || catalog.profiles.length || (fs.existsSync(credentials) && fs.readdirSync(credentials).length) || fs.existsSync(paths.join(input.profile, 'ai-key.enc'))) throw Error('Peer presentation must not have model credentials.');
      return (require(input.fixture) as { seedPeerWorkspace(profile: string): BotPeerWorkspaceFixture }).seedPeerWorkspace(input.profile);
    }, { profile, fixture: path.join(fixtureDirectory, 'seed.cjs') });
    expect(seeded.pendingEvents).toBe(0); expect(seeded.storeContactPeerUsed).toBe(true);
    await page.evaluate(() => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'light' })));
    await page.reload(); await page.locator('[data-application-module="companions"]').click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const sidebar = page.locator('.bot-sidebar'), transcript = page.getByRole('log');
    const bubblePalettes: unknown[] = [];
    const messageTimes: unknown[] = [], paginationPositions: unknown[] = [];
    let paginationBaseline: { bottom: number; gap: number } | undefined;
    const expectedTimes = (messages: readonly BotMessage[]) => page.evaluate(values => values.map(createdAt => ({ createdAt,
      text: new Date(createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) })), messages.map(message => message.createdAt));
    const assertTranscriptTimes = async (messages: readonly BotMessage[], context: string) => {
      const expected = await expectedTimes(messages);
      for (const [index, message] of messages.entries()) {
        const time = transcript.locator(`[data-bot-message="${message.id}"] .bot-message-author>time`);
        await expect(time).toHaveAttribute('datetime', message.createdAt); await expect(time).toHaveText(expected[index]!.text);
      }
      messageTimes.push({ context, expected });
    };
    const assertPinnedMemberFooter = async (label: string) => {
      const aside = page.getByRole('complementary', { name: '聊天信息', exact: true }), footer = aside.locator('.bot-group-members-pages');
      await expect(footer).toBeVisible();
      const bounds = await footer.evaluate(element => {
        const aside = element.closest('.bot-chat-context')!, frame = aside.getBoundingClientRect(), footer = element.getBoundingClientRect(), style = getComputedStyle(aside);
        return { viewport: { width: innerWidth, height: innerHeight }, aside: frame.toJSON(), footer: footer.toJSON(),
          gap: frame.bottom - footer.bottom, expectedInset: parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth) };
      });
      expect(bounds.viewport.width).toBe(1800); expect(Math.abs(bounds.gap - bounds.expectedInset)).toBeLessThanOrEqual(1);
      if (paginationBaseline) { expect(Math.abs(bounds.footer.bottom - paginationBaseline.bottom)).toBeLessThanOrEqual(1); expect(Math.abs(bounds.gap - paginationBaseline.gap)).toBeLessThanOrEqual(1); }
      else paginationBaseline = { bottom: bounds.footer.bottom, gap: bounds.gap };
      paginationPositions.push({ label, ...bounds });
    };
    const assertMatchingBubbles = async (user: Locator, partner: Locator, context: string) => {
      const palette = (element: Element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, image: style.backgroundImage, border: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
          widths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], shadow: style.boxShadow };
      };
      await expect(user).toBeVisible(); await expect(partner).toBeVisible();
      const userPalette = await user.evaluate(palette), partnerPalette = await partner.evaluate(palette);
      expect(userPalette).toEqual(partnerPalette); bubblePalettes.push({ context, user: userPalette, partner: partnerPalette });
    };
    const openPeer = async () => {
      await sidebar.getByRole('tab', { name: '聊天', exact: true }).click();
      await expect(sidebar.getByRole('tab', { name: '伙伴交流', exact: true })).toHaveCount(0);
      await expect(sidebar.getByRole('button', { name: /GPT × 大肥鱼/u })).toHaveCount(1);
      await sidebar.getByRole('button', { name: /GPT × 大肥鱼/u }).click();
      await expect(page.locator('.bot-chat-header h2')).toHaveText(seeded.peerTitle);
      await expect(page.locator('.bot-group-members-trigger')).toContainText('你在群中');
      await expect(transcript.locator('[data-bot-message]')).toHaveCount(seeded.peerMessageIds.length);
      expect(await transcript.locator('[data-bot-message]').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.botMessage))).toEqual(seeded.peerMessageIds);
    };
    await openPeer();
    const peer = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId }), seeded.peerId);
    expect(peer.ok).toBe(true); expect(peer.snapshot!.runtime.ready).toBe(false);
    expect(peer.snapshot!.conversations.find(room => room.id === seeded.peerId)).toMatchObject({ kind: 'group' });
    expect(new Set(peer.snapshot!.conversations.find(room => room.id === seeded.peerId)!.memberIds)).toEqual(new Set([seeded.targetCompanionId, seeded.sourceCompanionId, 'user']));
    expect(peer.snapshot!.messages.map(message => message.id)).toEqual(seeded.peerMessageIds);
    expect(peer.snapshot!.messages.every(message => message.conversationId === seeded.peerId && message.status === 'sent')).toBe(true);
    await assertTranscriptTimes(peer.snapshot!.messages, 'peer-group-light');
    const targetMessage = transcript.locator(`[data-bot-message="${seeded.targetReplyId}"]`), originMessage = transcript.locator(`[data-bot-message="${seeded.originReplyId}"]`);
    await assertMatchingBubbles(transcript.locator(`[data-bot-message="${seeded.userReplyId}"] .bot-message-bubble`), targetMessage.locator('.bot-message-bubble'), 'peer-group-light');
    await expect(targetMessage.locator('.bot-message-author')).toContainText('大肥鱼'); await expect(originMessage.locator('.bot-message-author')).toContainText('GPT');
    await expect(targetMessage.locator('.bot-message-text')).toContainText('晚安呀，今天也辛苦了。');
    await expect(originMessage.locator('.bot-message-text')).toHaveText('那我也收工啦，把这句晚安好好收下。');
    await expect(transcript.locator('.bot-task-notice')).toHaveCount(0); await expect(transcript).not.toContainText('任务回执');
    await expect(transcript).not.toContainText(seeded.secrets.origin); await expect(transcript).not.toContainText(seeded.secrets.target);
    await expect(page.getByRole('textbox', { name: '发送消息…', exact: true })).toBeEnabled();
    await page.getByRole('textbox', { name: '发送消息…', exact: true }).fill('@');
    const mentionList = page.getByRole('listbox', { name: '聊天成员', exact: true });
    await expect(mentionList.getByRole('option')).toHaveCount(3);
    await expect(mentionList).toContainText('所有人'); await expect(mentionList).toContainText('GPT'); await expect(mentionList).toContainText('大肥鱼');
    await mentionList.getByRole('option').filter({ hasText: 'GPT' }).click();
    await expect(page.getByRole('textbox', { name: '发送消息…', exact: true })).toHaveValue('@GPT ');
    await page.getByRole('textbox', { name: '发送消息…', exact: true }).fill('谢谢你们，明天见。');
    await expect(page.getByRole('button', { name: '发送 ↑', exact: true })).toBeEnabled();
    await page.locator('.bot-composer textarea').fill('');
    const portrait = async (scope: Locator) => {
      const image = scope.locator('.bot-avatar img'); await expect(image).toHaveCount(1);
      await expect.poll(() => image.evaluate((item: HTMLImageElement) => item.complete && item.naturalWidth > 0)).toBe(true);
      return scope.locator('.bot-avatar').evaluate(element => {
        const bounds = element.getBoundingClientRect(), style = getComputedStyle(element), img = element.querySelector('img')!;
        const radius = style.borderTopLeftRadius, round = radius.endsWith('%') ? parseFloat(radius) >= 50 : parseFloat(radius) >= Math.min(bounds.width, bounds.height) / 2 - 0.5;
        return { round, width: bounds.width, height: bounds.height, radius, src: img.currentSrc, loaded: img.complete && img.naturalWidth > 0 };
      });
    };
    const sourcePortrait = await portrait(originMessage.locator('.bot-message-avatar')), targetPortrait = await portrait(targetMessage.locator('.bot-message-avatar'));
    expect(sourcePortrait.round).toBe(true); expect(targetPortrait.round).toBe(true); expect(sourcePortrait.src).not.toBe(targetPortrait.src);
    await expect(originMessage).toBeInViewport({ ratio: 0.99 }); await expect(targetMessage).toBeInViewport({ ratio: 0.99 });
    await expect(page.locator('.bot-chat-identity .bot-peer-avatar .bot-group-portrait img')).toHaveCount(2);
    await expect(sidebar.locator('.bot-conversation').filter({ has: page.getByText(seeded.peerTitle, { exact: true }) }).locator('.bot-peer-avatar .bot-group-portrait img')).toHaveCount(2);
    await expect(page.locator('.bot-chat-identity .bot-peer-avatar')).toHaveClass(/bot-group-collage/);
    await expect(page.locator('.bot-chat-identity .bot-peer-avatar .bot-avatar')).toHaveCount(0);
    await expect.poll(() => page.locator('.bot-peer-avatar .bot-group-portrait img').evaluateAll(elements => elements.every(item => (item as HTMLImageElement).complete && (item as HTMLImageElement).naturalWidth > 0))).toBe(true);
    const geometry = await transcript.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth,
      rows: [...element.querySelectorAll<HTMLElement>('[data-bot-message]')].map(item => ({ id: item.dataset.botMessage, bounds: item.getBoundingClientRect().toJSON(), textWidth: item.querySelector('.bot-message-text')!.clientWidth,
        textScrollWidth: item.querySelector('.bot-message-text')!.scrollWidth })) }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    for (const message of geometry.rows) { expect(message.textScrollWidth).toBeLessThanOrEqual(message.textWidth + 1); expect(message.bounds.width).toBeGreaterThan(100); }
    const suffix = process.env.WORLDLINEBOX_E2E_PEER_EVIDENCE_SUFFIX;
    if (suffix && !/^[a-z0-9-]{1,40}$/u.test(suffix)) throw Error('Peer evidence suffix must be a short directory label.');
    const evidence = path.resolve('artifacts/superagent-bot-development/ui', suffix ? `peer-${suffix}` : '.'); await mkdir(evidence, { recursive: true });
    const captures: unknown[] = [];
    const capture = async (theme: 'light' | 'dark', label = `peer-conversation-${theme}.png`) => {
      await expect(page.locator('.application-navigation')).toBeVisible();
      expect(await page.locator('.application-navigation [data-application-module]').count()).toBeGreaterThanOrEqual(5);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const beforePaint = await application.evaluate(({ BrowserWindow }) => {
        const previous = (Reflect.get(globalThis, '__peerUiFrames') as { paints: number }).paints;
        BrowserWindow.getAllWindows()[0]!.webContents.invalidate(); return previous;
      });
      await expect.poll(() => application.evaluate(() => (Reflect.get(globalThis, '__peerUiFrames') as { paints: number }).paints)).toBeGreaterThan(beforePaint);
      const frame = await application.evaluate(async ({ BrowserWindow }) => {
        const owned = BrowserWindow.getAllWindows()[0]!, image = await owned.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        return { png: image.toPNG().toString('base64'), size: image.getSize(), content: owned.getContentBounds(), paints: (Reflect.get(globalThis, '__peerUiFrames') as { paints: number }).paints };
      });
      expect(frame.paints).toBeGreaterThan(beforePaint); expect(frame.size.width).toBe(frame.content.width); expect(Math.abs(frame.size.height - frame.content.height)).toBeLessThanOrEqual(1);
      const name = label, file = testInfo.outputPath(name);
      captures.push({ theme, name, size: frame.size, content: frame.content, paints: frame.paints });
      await writeFile(file, Buffer.from(frame.png, 'base64')); await copyFile(file, path.join(evidence, name)); await testInfo.attach(name, { path: file, contentType: 'image/png' });
    };
    await capture('light');
    await page.getByRole('button', { name: '聊天记录', exact: true }).click();
    const history = page.getByRole('dialog', { name: '聊天记录', exact: true });
    const historyExpected = await expectedTimes([...peer.snapshot!.messages].sort((a, b) => b.sequence - a.sequence));
    await expect(history.locator('.bot-history-record')).toHaveCount(historyExpected.length);
    expect(await history.locator('.bot-history-meta time').evaluateAll(times => times.map(time => ({ createdAt: time.getAttribute('datetime'), text: time.textContent })))).toEqual(historyExpected);
    messageTimes.push({ context: 'history-light', expected: historyExpected });
    await capture('light', 'peer-history-seconds-packaged-light.png');
    await history.getByRole('button', { name: '关闭', exact: true }).click();
    await sidebar.getByRole('tab', { name: '聊天', exact: true }).click();
    await expect(sidebar.getByRole('button', { name: /GPT × 大肥鱼/u })).toHaveCount(1);
    for (const [name, privateId, secret] of [['GPT', seeded.sourcePrivateId, seeded.secrets.origin], ['大肥鱼', seeded.targetPrivateId, seeded.secrets.target]] as const) {
      await sidebar.locator('button.bot-contact').filter({ has: page.getByText(name, { exact: true }) }).click(); await expect(page.locator('.bot-chat-header h2')).toHaveText(name);
      await expect(transcript).toContainText(secret); await expect(transcript).not.toContainText('那我也收工啦'); await expect(transcript).not.toContainText('把屏幕暗下来');
      const state = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId }), privateId);
      expect(state.snapshot!.messages.some(message => seeded.peerMessageIds.includes(message.id))).toBe(false);
      expect(state.snapshot!.messages.every(message => message.conversationId === privateId)).toBe(true);
      await assertTranscriptTimes(state.snapshot!.messages, `direct-${name}-light`);
      if (name === 'GPT') await assertMatchingBubbles(transcript.locator('.bot-message.from-user .bot-message-bubble').first(), transcript.locator('.bot-message:not(.from-user) .bot-message-bubble').first(), 'direct-light');
    }
    await page.evaluate(() => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'dark' })));
    await page.reload(); await page.locator('[data-application-module="companions"]').click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await openPeer();
    await expect(transcript).not.toContainText(seeded.secrets.origin); await expect(transcript).not.toContainText(seeded.secrets.target);
    expect((await portrait(originMessage.locator('.bot-message-avatar'))).round).toBe(true); expect((await portrait(targetMessage.locator('.bot-message-avatar'))).round).toBe(true);
    await assertMatchingBubbles(transcript.locator(`[data-bot-message="${seeded.userReplyId}"] .bot-message-bubble`), targetMessage.locator('.bot-message-bubble'), 'peer-group-dark');
    await assertTranscriptTimes(peer.snapshot!.messages, 'peer-group-dark');
    await capture('dark');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1800, 1000));
    await page.reload(); await page.locator('[data-application-module="companions"]').click(); await openPeer();
    await assertPinnedMemberFooter('3-members-dark');
    const smallGroupOverview = page.getByRole('region', { name: '群成员速览', exact: true });
    await expect(smallGroupOverview.getByRole('listitem')).toHaveCount(3);
    await expect(smallGroupOverview.getByRole('button', { name: '上一页群成员', exact: true })).toBeDisabled();
    await expect(smallGroupOverview.getByRole('button', { name: '下一页群成员', exact: true })).toBeDisabled();
    await capture('dark', 'group-3-members-pagination-packaged-dark.png');
    await page.getByRole('button', { name: '管理群聊成员', exact: true }).click();
    const members = page.getByRole('dialog', { name: '群聊成员', exact: true });
    await expect(members).toContainText('群主 · 始终在群内');
    await capture('dark', 'group-members-packaged-dark.png');
    await members.getByRole('button', { name: '移除 GPT', exact: true }).click();
    await members.getByRole('button', { name: '保存成员', exact: true }).click();
    await expect(members).toHaveCount(0);
    const afterRemove = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId }), seeded.peerId);
    expect(new Set(afterRemove.snapshot!.conversations.find(room => room.id === seeded.peerId)!.memberIds)).toEqual(new Set(['user', seeded.targetCompanionId]));
    await expect(page.locator('.bot-group-members-trigger')).toContainText('2 位成员');
    await page.getByRole('textbox', { name: '发送消息…', exact: true }).fill('@');
    await expect(mentionList.getByRole('option')).toHaveCount(2); await expect(mentionList).not.toContainText('GPT');
    await page.locator('.bot-composer textarea').fill('');
    await page.getByRole('button', { name: '查看群聊成员', exact: true }).click();
    await members.getByRole('button', { name: '添加伙伴', exact: true }).click();
    await members.getByRole('button', { name: '添加 GPT', exact: true }).click();
    await members.getByRole('button', { name: '保存成员', exact: true }).click();
    await expect(members).toHaveCount(0);
    await expect(page.locator('.bot-group-members-trigger')).toContainText('3 位成员');
    await page.getByRole('button', { name: '管理群聊成员', exact: true }).click();
    await members.getByRole('button', { name: '解散群聊', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '保留群聊', exact: true }).click();
    await expect(members).toBeVisible();
    await members.getByRole('button', { name: '解散群聊', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '确认解散', exact: true }).click();
    await expect(members).toHaveCount(0);
    await expect(sidebar.getByRole('button', { name: /GPT × 大肥鱼/u })).toHaveCount(0);
    const afterDissolve = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId }), seeded.peerId);
    expect(afterDissolve.ok).toBe(false);
    const largeGroup = await page.evaluate(async () => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      const state = await api.request({ type: 'state' }), companions = state.snapshot!.companions;
      const created = await api.request({ type: 'conversation.create', kind: 'group', title: '全部内置伙伴', memberIds: companions.map(person => person.id), participationMode: 'mentions' });
      const stored = await api.request({ type: 'state', conversationId: created.conversationId });
      return { ok: created.ok, conversationId: created.conversationId, memberIds: stored.snapshot!.conversations.find(room => room.id === created.conversationId)!.memberIds,
        companions: companions.map(person => ({ id: person.id, name: person.name })) };
    });
    expect(largeGroup.ok).toBe(true); expect(largeGroup.companions).toHaveLength(14); expect(largeGroup.conversationId).toBeTruthy();
    const expectedTiles = largeGroup.memberIds.filter(id => id !== 'user').slice(0, 9);
    const largeGroupGeometry: unknown[] = [];
    let groupInfoVerified = false;
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1800, 1000));
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(theme => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme })), theme);
      await page.reload(); await page.locator('[data-application-module="companions"]').click();
      await sidebar.locator('.bot-conversation').filter({ hasText: '全部内置伙伴' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('.bot-group-members-trigger')).toContainText('15 位成员');
      const collage = page.locator('.bot-chat-identity .bot-group-collage');
      await expect(collage.locator('.bot-group-portrait[data-companion-id]')).toHaveCount(9);
      await expect(collage.locator('.bot-presence-dot,.bot-group-portrait-overflow')).toHaveCount(0);
      expect(await collage.locator('[data-companion-id]').evaluateAll(tiles => tiles.map(tile => (tile as HTMLElement).dataset.companionId))).toEqual(expectedTiles);
      const groupListPortrait = sidebar.locator('.bot-conversation').filter({ hasText: '全部内置伙伴' }).locator('.bot-group-collage');
      const groupDetailsPortrait = page.getByRole('complementary', { name: '聊天信息', exact: true }).locator('.bot-context-group .bot-group-collage');
      for (const placement of [groupListPortrait, groupDetailsPortrait]) {
        expect(await placement.locator('[data-companion-id]').evaluateAll(tiles => tiles.map(tile => (tile as HTMLElement).dataset.companionId))).toEqual(expectedTiles);
        await expect(placement.locator('.bot-presence-dot,.bot-group-portrait-overflow')).toHaveCount(0);
        await expect.poll(() => placement.locator('img').evaluateAll(images => images.length === 9 && images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
      }
      await expect(collage.locator('img')).toHaveCount(9);
      await expect.poll(() => collage.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
      const geometry = await collage.evaluate(element => {
        const frame = element.getBoundingClientRect();
        const tiles = [...element.querySelectorAll<HTMLElement>('[data-companion-id]')].map(tile => ({ id: tile.dataset.companionId, ...tile.getBoundingClientRect().toJSON() }));
        const overlaps = tiles.flatMap((tile, index) => tiles.slice(index + 1).map(other => ({ width: Math.min(tile.right, other.right) - Math.max(tile.left, other.left), height: Math.min(tile.bottom, other.bottom) - Math.max(tile.top, other.top) }))).filter(overlap => overlap.width > .5 && overlap.height > .5);
        return { frame: frame.toJSON(), tiles, overlaps };
      });
      expect(geometry.overlaps).toHaveLength(0);
      for (const tile of geometry.tiles) { expect(tile.width).toBeGreaterThan(5); expect(tile.height).toBeGreaterThan(5); expect(tile.left).toBeGreaterThanOrEqual(geometry.frame.left - .5); expect(tile.right).toBeLessThanOrEqual(geometry.frame.right + .5); expect(tile.bottom).toBeLessThanOrEqual(geometry.frame.bottom + .5); }
      largeGroupGeometry.push({ theme, ...geometry });
      const field = page.locator('.bot-composer textarea'); await field.fill('@');
      await expect(page.getByRole('listbox', { name: '聊天成员', exact: true }).getByRole('option')).toHaveCount(15);
      for (const person of largeGroup.companions) await expect(page.getByRole('listbox').getByText(person.name, { exact: true })).toBeVisible();
      await field.press('Escape'); await field.fill('');
      const information = page.getByRole('complementary', { name: '聊天信息', exact: true });
      await expect(information.getByRole('tab', { name: '群资料', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(information.getByRole('tab', { name: '主脑与任务', exact: true })).toHaveAttribute('aria-selected', 'false');
      const announcement = information.getByRole('region', { name: '群公告', exact: true });
      const memberOverview = information.getByRole('region', { name: '群成员速览', exact: true });
      await assertPinnedMemberFooter(`15-members-${theme}`);
      if (theme === 'light') {
        await expect(announcement).toContainText('还没有群公告');
        await announcement.getByRole('button', { name: '编辑群公告', exact: true }).click();
        const noticeField = announcement.getByRole('textbox', { name: '公告内容', exact: true });
        await noticeField.fill('欢迎来到我们的共同聊天。任务进展在右侧查看，重要约定请写清楚。');
        await announcement.getByRole('button', { name: '保存公告', exact: true }).click();
        await expect(noticeField).toHaveCount(0);
        const readAnnouncement = () => page.evaluate(async conversationId => {
          const state = await (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId });
          return state.snapshot!.conversations.find(room => room.id === conversationId)?.announcement;
        }, largeGroup.conversationId!);
        const firstNotice = await readAnnouncement();
        expect(firstNotice?.text).toContain('共同聊天'); expect(Number.isFinite(Date.parse(firstNotice!.updatedAt))).toBe(true);
        await announcement.getByRole('button', { name: '编辑群公告', exact: true }).click();
        await noticeField.fill('这个旧草稿不能覆盖已经更新的公告。');
        const concurrentUpdate = await page.evaluate(async input => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({
          type: 'conversation.announcement', conversationId: input.conversationId, content: '其他窗口已经保存了新公告，请先重新读取。', expectedUpdatedAt: input.expectedUpdatedAt,
        }), { conversationId: largeGroup.conversationId!, expectedUpdatedAt: firstNotice!.updatedAt });
        expect(concurrentUpdate.ok).toBe(true);
        await announcement.getByRole('button', { name: '保存公告', exact: true }).click();
        await expect(announcement.getByRole('alert')).toContainText('群公告已经更新');
        await expect(page.locator('.bot-error')).toHaveCount(0);
        await expect(noticeField).toHaveValue('这个旧草稿不能覆盖已经更新的公告。');
        expect((await readAnnouncement())?.text).toBe('其他窗口已经保存了新公告，请先重新读取。');
        await capture(theme, 'group-announcement-conflict-packaged-light.png');
        await announcement.getByRole('button', { name: '取消', exact: true }).click();
        await expect(announcement.getByRole('alert')).toHaveCount(0);
        const updatedNotice = await readAnnouncement();
        await announcement.getByRole('button', { name: '编辑群公告', exact: true }).click();
        await expect(noticeField).toHaveValue(updatedNotice!.text); await noticeField.fill('');
        const concurrentClear = await page.evaluate(async input => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({
          type: 'conversation.announcement', conversationId: input.conversationId, content: '清空前另一个窗口再次更新，保留这一版。', expectedUpdatedAt: input.expectedUpdatedAt,
        }), { conversationId: largeGroup.conversationId!, expectedUpdatedAt: updatedNotice!.updatedAt });
        expect(concurrentClear.ok).toBe(true);
        await announcement.getByRole('button', { name: '保存公告', exact: true }).click();
        await expect(announcement.getByRole('alert')).toContainText('群公告已经更新');
        await expect(page.locator('.bot-error')).toHaveCount(0);
        expect((await readAnnouncement())?.text).toContain('保留这一版');
        await announcement.getByRole('button', { name: '取消', exact: true }).click();
        await announcement.getByRole('button', { name: '编辑群公告', exact: true }).click();
        await noticeField.fill(''); await announcement.getByRole('button', { name: '保存公告', exact: true }).click();
        await expect(announcement).toContainText('还没有群公告'); expect(await readAnnouncement()).toBeUndefined();
        await announcement.getByRole('button', { name: '编辑群公告', exact: true }).click();
        await noticeField.fill('欢迎来到我们的共同聊天。这里可以交流想法，也可以一起完成真正的任务。');
        await announcement.getByRole('button', { name: '保存公告', exact: true }).click();
        await expect(announcement).toContainText('一起完成真正的任务');
        await expect(memberOverview.getByRole('listitem')).toHaveCount(7);
        await assertPinnedMemberFooter('15-members-page-1-light');
        await memberOverview.getByRole('button', { name: '下一页群成员', exact: true }).click();
        await expect(memberOverview.getByRole('listitem')).toHaveCount(7);
        await assertPinnedMemberFooter('15-members-page-2-light');
        await memberOverview.getByRole('button', { name: '下一页群成员', exact: true }).click();
        await expect(memberOverview.getByRole('listitem')).toHaveCount(1);
        await assertPinnedMemberFooter('15-members-page-3-light');
        await expect(memberOverview.getByRole('button', { name: '下一页群成员', exact: true })).toBeDisabled();
        const lastCompanion = largeGroup.companions.at(-1)!;
        const memberSearch = memberOverview.getByRole('searchbox', { name: '搜索群成员', exact: true });
        await memberSearch.fill(lastCompanion.name); await expect(memberOverview.getByRole('listitem')).toHaveCount(1);
        await assertPinnedMemberFooter('15-members-search-1-light');
        await expect(memberOverview.getByRole('button', { name: '上一页群成员', exact: true })).toBeDisabled();
        await expect(memberOverview.getByRole('button', { name: '下一页群成员', exact: true })).toBeDisabled();
        await memberSearch.fill('不存在的群成员检索'); await expect(memberOverview.getByRole('listitem')).toHaveCount(0);
        await assertPinnedMemberFooter('15-members-search-0-light');
        await expect(memberOverview.getByRole('button', { name: '上一页群成员', exact: true })).toBeDisabled();
        await expect(memberOverview.getByRole('button', { name: '下一页群成员', exact: true })).toBeDisabled();
        await capture(theme, 'group-members-search-empty-packaged-light.png');
        await memberSearch.fill(lastCompanion.name); await expect(memberOverview.getByRole('listitem')).toHaveCount(1);
        await memberOverview.getByRole('listitem').getByRole('button').click();
        await expect(page.locator('.bot-chat-header h2')).toHaveText(lastCompanion.name);
        await sidebar.locator('.bot-conversation').filter({ hasText: '全部内置伙伴' }).click();
        await expect(information.getByRole('tab', { name: '群资料', exact: true })).toHaveAttribute('aria-selected', 'true');
        await memberOverview.getByRole('button', { name: '管理', exact: true }).click();
        await expect(members).toBeVisible(); await expect(members).toContainText('群主 · 始终在群内');
        await members.getByRole('button', { name: '关闭成员管理', exact: true }).click();
        await expect(members).toHaveCount(0);
        await information.getByRole('tab', { name: '主脑与任务', exact: true }).click();
        await expect(information.getByRole('region', { name: '主脑上下文摘要', exact: true })).toBeVisible();
        await expect(information.getByRole('region', { name: '任务速览', exact: true })).toContainText('暂无待办任务');
        await information.getByRole('tab', { name: '群资料', exact: true }).click();
        groupInfoVerified = true;
      }
      await expect(announcement).toContainText('一起完成真正的任务');
      await capture(theme, `group-14-companions-packaged-${theme}.png`);
    }
    // These are genuine two-companion private rooms, not the ordinary group
    // verified above. The user observes records but never becomes a member.
    const privateChecks: unknown[] = [];
    const openObserved = async () => {
      await sidebar.getByRole('tab', { name: '聊天', exact: true }).click();
      await sidebar.locator('.bot-conversation').filter({ has: page.getByText(seeded.observedTitle, { exact: true }) }).click();
      await expect(page.locator('.bot-chat-header h2')).toHaveText(seeded.observedTitle);
      await expect(page.locator('.bot-peer-observer-dock')).toContainText('正在旁观伙伴私聊');
      await expect(page.locator('.bot-chat-header')).toContainText('伙伴私聊 · 旁观');
      await expect(page.locator('.bot-composer,.bot-chat-tasks,.bot-group-policy,.bot-stop')).toHaveCount(0);
      await expect(transcript.locator('[data-bot-message]')).toHaveCount(seeded.observedMessageIds.length);
      expect(await transcript.locator('[data-bot-message]').evaluateAll(elements => elements.map(item => (item as HTMLElement).dataset.botMessage))).toEqual(seeded.observedMessageIds);
      await expect(transcript).not.toContainText(seeded.secrets.origin); await expect(transcript).not.toContainText(seeded.secrets.target);
      await expect(transcript).not.toContainText('收到，晚安。明天见');
    };
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(theme => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme })), theme);
      await page.reload(); await page.locator('[data-application-module="companions"]').click(); await openObserved();
      const state = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId }), seeded.observedId);
      const room = state.snapshot!.conversations.find(item => item.id === seeded.observedId)!;
      expect(room).toMatchObject({ kind: 'peer', userRole: 'observer' }); expect(new Set(room.memberIds)).toEqual(new Set([seeded.sourceCompanionId, seeded.targetCompanionId]));
      expect(room.memberIds).not.toContain('user'); expect(state.snapshot!.tasks).toEqual([]);
      await assertTranscriptTimes(state.snapshot!.messages, `observed-peer-${theme}`);
      const peerPortraits = await Promise.all(state.snapshot!.messages.slice(0, 2).map(message => portrait(transcript.locator(`[data-bot-message="${message.id}"] .bot-message-avatar`))));
      expect(peerPortraits.every(item => item.round && item.loaded)).toBe(true); expect(peerPortraits[0]!.src).not.toBe(peerPortraits[1]!.src);
      await capture(theme, `peer-private-observer-packaged-${theme}.png`);
      privateChecks.push({ theme, room, messageIds: state.snapshot!.messages.map(item => item.id), portraits: peerPortraits });
    }
    await page.locator('.bot-peer-observer-dock').getByRole('button', { name: '聊天记录', exact: true }).click();
    const observedHistory = page.getByRole('dialog', { name: '聊天记录', exact: true });
    await expect(observedHistory.locator('.bot-history-record')).toHaveCount(seeded.observedMessageIds.length);
    await expect(observedHistory).not.toContainText(seeded.secrets.origin); await expect(observedHistory).not.toContainText(seeded.secrets.target);
    await capture('dark', 'peer-private-history-packaged-dark.png'); await observedHistory.getByRole('button', { name: '关闭', exact: true }).click();
    const joinButton = page.locator('.bot-peer-observer-dock').getByRole('button', { name: '创建群聊，一起参与', exact: true });
    await joinButton.click(); await expect(page.locator('.bot-composer textarea')).toBeVisible();
    const joined = await page.evaluate(async () => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      const state = await api.request({ type: 'state' });
      return state.snapshot!.conversations.filter(item => item.kind === 'group' && item.memberIds.length === 3);
    });
    expect(joined).toHaveLength(1); expect(joined[0]!.id).not.toBe(seeded.observedId);
    expect(new Set(joined[0]!.memberIds)).toEqual(new Set(['user', seeded.sourceCompanionId, seeded.targetCompanionId]));
    const joinedState = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId }), joined[0]!.id);
    expect(joinedState.snapshot!.messages).toEqual([]); // Joining never copies private history.
    const reused = await page.evaluate(async conversationId => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'conversation.peer.join', conversationId }), seeded.observedId);
    expect(reused.conversationId).toBe(joined[0]!.id);
    privateChecks.push({ joinedGroupId: joined[0]!.id, joinedMembers: joined[0]!.memberIds, copiedPrivateMessages: 0, reusedGroupId: reused.conversationId });
    await page.getByRole('button', { name: '伙伴私聊', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '查看伙伴私聊', exact: true });
    await expect(picker.getByRole('button', { name: '查看私聊', exact: true })).toBeDisabled();
    await picker.getByRole('button', { name: 'GPT', exact: true }).click(); await picker.getByRole('button', { name: '白幻', exact: true }).click();
    await expect(picker.locator('[aria-pressed=true]')).toHaveCount(2); await capture('dark', 'peer-private-selector-packaged-dark.png');
    await picker.getByRole('button', { name: '查看私聊', exact: true }).click(); await expect(picker).toHaveCount(0);
    await expect(page.locator('.bot-peer-observer-dock')).toBeVisible(); await expect(transcript).toContainText('这两位伙伴还没有私聊记录');
    const emptyPair = await page.evaluate(async () => {
      const state = await (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state' });
      return state.snapshot!.conversations.filter(item => item.kind === 'peer');
    });
    expect(emptyPair).toHaveLength(2);
    privateChecks.push({ emptyPairRooms: emptyPair.map(item => ({ id: item.id, memberIds: item.memberIds })) });
    // A request to contact the user is delivered in the target's ordinary user
    // direct room with the source companion's actual identity, not a group.
    await sidebar.locator('.bot-conversation').filter({ has: page.getByText('大肥鱼', { exact: true }) }).click();
    await expect(page.locator('.bot-composer textarea')).toBeVisible(); await expect(page.locator('.bot-peer-observer-dock')).toHaveCount(0);
    await expect(transcript.locator(`[data-bot-message="${seeded.userDirectIntroductionId}"] .bot-message-author`)).toContainText('GPT');
    await expect(transcript.locator(`[data-bot-message="${seeded.userDirectReplyId}"] .bot-message-author`)).toContainText('大肥鱼');
    await expect(transcript).toContainText('晚安呀，我们在自己的私聊里继续聊。');
    await expect(transcript).not.toContainText('我们先核对交付顺序');
    await capture('dark', 'peer-contact-user-direct-packaged-dark.png');
    privateChecks.push({ userDirectRoomId: seeded.targetPrivateId, introductionId: seeded.userDirectIntroductionId, replyId: seeded.userDirectReplyId, userInputEnabled: true });
    const finalRuntime = await application.evaluate(({ app }) => {
      const { createRequire } = process.getBuiltinModule('node:module'), path = process.getBuiltinModule('node:path'), require = createRequire(path.join(app.getAppPath(), 'package.json'));
      const fs = require('node:fs'), root = app.getPath('userData'), filename = path.join(root, 'ai-profiles.json'), keys = path.join(root, 'ai-profile-keys');
      const catalog = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : { activeProfileId: null, profiles: [] };
      return { activeModelProfile: catalog.activeProfileId, configuredProfiles: catalog.profiles.length,
        credentialFiles: fs.existsSync(keys) ? fs.readdirSync(keys).length : 0, legacyCredentialExists: fs.existsSync(path.join(root, 'ai-key.enc')) };
    });
    expect(finalRuntime).toEqual({ activeModelProfile: null, configuredProfiles: 0, credentialFiles: 0, legacyCredentialExists: false });
    const finalHash = identity.packaged ? await hashFile(identity.appPath) : undefined; expect(finalHash).toBe(initialHash);
    const result = { identity, initialHash, finalHash, seeded, actualIpc: true, humanAuthoredMessages: true, sourcePortrait, targetPortrait, geometry, largeGroup, expectedTiles, largeGroupGeometry, captures, bubblePalettes, messageTimes, paginationPositions, privateChecks, groupInfoVerified, announcementSavedClearedAndVersionConflictsLocal: groupInfoVerified, memberSearchTraversesAllPagesAndOpensDirect: groupInfoVerified, privateHistoriesIsolated: true, memberRemovalAndAddition: true, userAlwaysOwner: true, dissolveConfirmedAndAccessRevoked: true, finalRuntime };
    await writeFile(testInfo.outputPath('peer-workspace-evidence.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(evidence, 'peer-workspace-evidence.json'), JSON.stringify(result, null, 2));
  } finally { await application.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
