import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test } from '@playwright/test';
import type { BotRequest, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
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
    const opening = app.waitForEvent('window');
    await meeting.getByRole('button', { name: '切换为桌宠' }).click();
    const pet = await opening;
    const nativePet = await app.browserWindow(pet);
    await expect.poll(() => nativePet.evaluate(win => win.isVisible())).toBe(true);
    await owner.evaluate(win => win.hide());
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
    await publish('连续第二条也应出现在桌宠。');
    await expect(pet.locator('.bot-call-bubble-text')).toHaveText('连续第二条也应出现在桌宠。');
    await expect.poll(unread).toBe(2);
    expect(await calls.jsonValue()).toEqual([]);
    const closed = pet.waitForEvent('close');
    await nativePet.evaluate(win => win.close());
    await closed;
    await owner.evaluate(win => win.hide());
    await publish('桌宠关闭后恢复系统通知。');
    await expect.poll(() => calls.jsonValue()).toEqual(['大肥鱼：桌宠关闭后恢复系统通知。']);
  } finally {
    db?.close();
    await app.close();
    removeCompanionTestDirectory(profile);
  }
});
