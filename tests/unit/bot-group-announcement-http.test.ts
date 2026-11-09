import { afterEach, expect, it } from 'vitest';
import { nativeServiceFixture, waitNative } from '../fixtures/bot-native-service';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
it('sends the latest saved group announcement to each fresh native Session without private or old history', async () => {
  const f = await nativeServiceFixture(async () => '已收到最新公告'); closes.push(f.close);
  for (const id of ['alice', 'bob']) f.service.store.createCompanion({ id, name: id, persona: '独立角色' });
  const room = f.service.store.createGroup({ title: '公开群', memberIds: ['alice', 'bob'], participationMode: 'all' });
  const direct = f.service.store.openDirect('alice'); f.service.store.enqueue({ conversationId: direct.id, senderId: 'user', content: 'PRIVATE_SENTINEL', recipientIds: [] });
  await f.service.handle({ type: 'conversation.announcement', conversationId: room.id, content: 'OLD_ANNOUNCEMENT' });
  await f.service.handle({ type: 'conversation.announcement', conversationId: room.id, content: 'CURRENT_ANNOUNCEMENT' });
  await f.service.handle({ type: 'message.send', conversationId: room.id, content: '大家看公告', requestId: 'announcement-native' });
  await waitNative(() => f.calls.length === 2 && f.calls.every(input => f.service.store.getEvent(input.eventId)?.status === 'done'));
  for (const input of f.calls) {
    expect(JSON.parse(input.prompt).room.announcement.text).toBe('CURRENT_ANNOUNCEMENT');
    expect(input.prompt).not.toMatch(/PRIVATE_SENTINEL|OLD_ANNOUNCEMENT/); expect(input.system).not.toContain('CURRENT_ANNOUNCEMENT');
  }
  expect(new Set(f.calls.map(input => input.laneId)).size).toBe(2);
});
