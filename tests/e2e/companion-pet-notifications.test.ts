import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test } from '@playwright/test';
import type { BotRequest, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { CallPetApi } from '../../src/shared/companion-call-window';
import { electronLaunchEnv, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';
import { enableCallVisualFixture } from './fixtures/call-visual-binding';

test('a background desktop pet presents committed chat replies without system popups until it closes', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop notifications');
  test.setTimeout(90_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-bot-pet-notes-'));
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }) });
  let db: DatabaseSync | undefined;
  try {
    const page = await app.firstWindow();
    const owner = await app.browserWindow(page);
    const calls = await app.evaluateHandle(({ Notification }) => {
      const received: string[] = [];
      Notification.prototype.show = function () { received.push(this.body); };
      return received;
    });
    const api = (request: BotRequest) => page.evaluate(input => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request(input), request);
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    const state = (await api({ type: 'state' })).snapshot!;
    const actor = state.companions.find(person => person.name === '大肥鱼')!;
    const room = (await api({ type: 'conversation.open', companionId: actor.id })).conversationId!;
    await enableCallVisualFixture(app, page);
    await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与大肥鱼会面' });
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    const meetingMode = meeting.getByRole('button', { name: '简洁模式', exact: true });
    await meeting.getByRole('button', { name: '会面菜单', exact: true }).click();
    await meetingMode.click();
    await expect(meeting.locator('.bot-call-portrait-frame')).toBeVisible();
    await expect(meeting.locator('.bot-call-live2d')).toBeHidden();
    const directOpening = app.waitForEvent('window');
    await meeting.getByRole('button', { name: '切换为简洁桌宠', exact: true }).click();
    const directCompact = await directOpening;
    await expect(directCompact.locator('.bot-call-compact-anchor img')).toBeVisible();
    await expect(directCompact.locator('.bot-call-live2d')).toBeHidden();
    await directCompact.getByRole('button', { name: '展开会面输入', exact: true }).click();
    await directCompact.getByRole('textbox', { name: '发送消息…' }).fill('切换时保留这个草稿');
    await directCompact.getByRole('button', { name: '更多会面功能', exact: true }).click();
    const returned = directCompact.waitForEvent('close');
    await directCompact.getByRole('button', { name: '返回会面场景', exact: true }).click().catch(error => {
      if (!directCompact.isClosed()) throw error;
    });
    await returned;
    await expect(meeting.getByRole('textbox', { name: '发送消息…' })).toHaveValue('切换时保留这个草稿');
    await expect(meeting.locator('.bot-call-portrait-frame')).toBeVisible();
    await meeting.getByRole('button', { name: '会面菜单', exact: true }).click();
    await expect(meetingMode).toHaveAttribute('aria-pressed', 'true');
    await meetingMode.click();
    await expect(meeting.locator('.bot-call-live2d canvas')).toBeVisible({ timeout: 35_000 });
    const opening = app.waitForEvent('window');
    await meeting.getByRole('button', { name: '切换为桌宠', exact: true }).click();
    const pet = await opening;
    const nativePet = await app.browserWindow(pet);
    await expect.poll(() => nativePet.evaluate(win => win.isVisible())).toBe(true);
    const model = pet.locator('.bot-call-live2d canvas');
    await expect(model).toBeVisible({ timeout: 35_000 });
    const draft = pet.getByRole('textbox', { name: '发送消息…' });
    await expect(draft).toHaveValue('切换时保留这个草稿');
    const more = pet.getByRole('button', { name: '更多会面功能', exact: true });
    const compactMode = pet.getByRole('button', { name: '简洁模式', exact: true });
    await more.click();
    await expect(compactMode).toHaveAttribute('aria-pressed', 'false');
    await compactMode.click();
    await expect(model).toBeHidden();
    const avatar = pet.locator('.bot-call-compact-anchor');
    await expect(avatar).toBeVisible();
    await expect.poll(async () => {
      const picture = await avatar.boundingBox();
      const dock = await pet.locator('.bot-call-dock').boundingBox();
      return !!picture && !!dock && dock.x + dock.width < picture.x && picture.y + picture.height === dock.y + dock.height;
    }).toBe(true);
    await expect(draft).toHaveValue('切换时保留这个草稿');
    await owner.evaluate(win => win.hide());
    const avatarPosition = await avatar.boundingBox();
    db = new DatabaseSync(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
    const publish = async (body: string) => {
      const id = randomUUID();
      db!.exec('BEGIN IMMEDIATE');
      try {
        // The placeholder predates the call. Only its publication is new.
        db!.prepare("INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at) VALUES(?,?,?,?,?,'companion',?,'sent','message',?,?)")
          .run(id, id, room, actor.id, actor.name, body, id, '2000-01-01T00:00:00.000Z');
        db!.prepare('INSERT INTO bot_history_projection(message_id,conversation_id,timestamp) VALUES(?,?,?)').run(id, room, Date.now());
        db!.exec('COMMIT');
      } catch (error) { db!.exec('ROLLBACK'); throw error; }
      expect((await api({ type: 'conversation.pin', conversationId: room, pinned: false })).ok).toBe(true);
    };
    const unread = () => page.evaluate(async id => (await (Reflect.get(window, 'worldlinebox') as {companionBot: WorldlineBoxBotApi}).companionBot.inbox!())[id], room);
    await publish('桌宠收到第一条普通正文。');
    await expect(pet.locator('.bot-call-bubble-text')).toHaveText('桌宠收到第一条普通正文。');
    await expect.poll(async () => {
      const bubble = await pet.locator('.bot-call-bubble').boundingBox();
      const picture = await avatar.boundingBox();
      return !!bubble && !!picture && bubble.y + bubble.height < picture.y;
    }).toBe(true);
    await expect.poll(() => avatar.boundingBox()).toEqual(avatarPosition);
    const drag = await app.evaluate(({ BrowserWindow, screen }, { id, x, y }) => {
      const bounds = BrowserWindow.fromId(id)!.getContentBounds();
      const { workArea } = screen.getDisplayMatching(bounds);
      return { start: { x: bounds.x + x, y: bounds.y + y }, end: { x: bounds.x + x, y: workArea.y + 2 } };
    }, { id: await nativePet.evaluate(win => win.id), x: avatarPosition!.x + 21, y: avatarPosition!.y + 21 });
    await page.evaluate(({ start, end }) => {
      const { companionCallPet } = Reflect.get(window, 'worldlinebox') as { companionCallPet: CallPetApi };
      companionCallPet.command({ type: 'drag-start', ...start });
      companionCallPet.command({ type: 'drag-move', ...end });
      companionCallPet.command('drag-end');
    }, drag);
    await expect(pet.locator('html')).toHaveAttribute('data-call-pet-edge', 'top');
    await expect(pet.locator('.bot-call-visual-novel')).toHaveAttribute('data-bubble-tail', 'up');
    const topAvatar = await avatar.boundingBox();
    await publish('连续第二条也应出现在桌宠。');
    await expect(pet.locator('.bot-call-bubble-text')).toHaveText('连续第二条也应出现在桌宠。');
    await expect.poll(async () => {
      const bubble = await pet.locator('.bot-call-bubble').boundingBox();
      return !!bubble && bubble.y > topAvatar!.y + topAvatar!.height;
    }).toBe(true);
    await expect.poll(() => avatar.boundingBox()).toEqual(topAvatar);
    await expect.poll(unread).toBe(2);
    expect(await calls.jsonValue()).toEqual([]);
    await more.click();
    await expect(compactMode).toHaveAttribute('aria-pressed', 'true');
    await compactMode.click();
    await expect(model).toBeVisible();
    await expect(draft).toHaveValue('切换时保留这个草稿');
    const closed = pet.waitForEvent('close');
    await nativePet.evaluate(win => win.close());
    await closed;
    await owner.evaluate(win => win.hide());
    await publish('桌宠关闭后恢复系统通知。');
    await expect.poll(() => calls.jsonValue()).toEqual(['大肥鱼：桌宠关闭后恢复系统通知。']);
    await owner.evaluate(win => { win.show(); win.focus(); });
    await expect.poll(() => owner.evaluate(win => win.isFocused())).toBe(true);
    const hangup = meeting.getByRole('button', { name: '挂断', exact: true });
    if (await hangup.isVisible()) await hangup.click();
    const conversation = page.locator('.bot-conversation').filter({ has: page.getByText('大肥鱼', { exact: true }) });
    await conversation.click();
    await expect(page.getByRole('log').getByText('桌宠关闭后恢复系统通知。')).toBeVisible();
    await expect(conversation.locator('.bot-room-unread-count')).toHaveCount(0);
    await expect(page.locator('[data-application-module="companions"] .application-unread-count')).toHaveCount(0);
    await publish('当前会话可见时的新消息。');
    await expect(page.getByRole('log').getByText('当前会话可见时的新消息。')).toBeVisible();
    await expect.poll(unread).toBeUndefined();
  } finally {
    db?.close();
    await app.close();
    removeCompanionTestDirectory(profile);
  }
});
