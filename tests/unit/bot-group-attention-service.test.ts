import { afterEach, expect, it } from 'vitest';
import { nativeServiceFixture, waitNative } from '../fixtures/bot-native-service';
import { parseGroupAttention, routeGroupAttention } from '../../src/main/companion-bot/group-attention';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
it('validates explicit natural calls and complete member identities without prefix collisions', () => {
  const actors = [{ id: 'alpha', name: '大肥鱼' }, { id: 'beta', name: '大肥鱼姐姐' }, { id: 'gamma', name: 'GPT' }];
  expect(routeGroupAttention(actors, '大肥鱼在吗', 'automatic')).toEqual({ targets: ['alpha'], candidate: false });
  expect(routeGroupAttention(actors, '大肥鱼姐姐，你怎么看', 'automatic').targets).toEqual(['beta']);
  expect(() => parseGroupAttention('{"recipients":["other"]}', ['alpha'])).toThrow('非成员');
});
it('routes an explicit group message directly to native DSH without an App judge model', async () => {
  const f = await nativeServiceFixture(async () => '原生伙伴回答'); closes.push(f.close);
  for (const [id, name] of [['alpha', 'Alice'], ['beta', 'Bob']]) f.service.store.createCompanion({ id: id!, name: name!, persona: name! });
  const room = f.service.store.createGroup({ title: '群', memberIds: ['alpha', 'beta'], participationMode: 'mentions' });
  await f.service.handle({ type: 'message.send', conversationId: room.id, content: '@Alice 请回应', requestId: 'native-group' });
  await waitNative(() => f.calls.length === 1 && f.service.store.getEvent(f.calls[0]!.eventId)?.status === 'done');
  expect(f.calls[0]!.laneId).toBe('turn-' + f.calls[0]!.eventId);
  expect(JSON.parse(f.calls[0]!.prompt).identity.id).toBe('alpha'); expect(f.calls[0]!.role).toBe('worker');
});
