import { afterEach, expect, it } from 'vitest';
import { nativeServiceFixture, nativeCallback, waitNative } from '../fixtures/bot-native-service';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
it('runs peer contact and recipient-authored user delivery through the native callback gateway', async () => {
  let peerId = '';
  const f = await nativeServiceFixture(async input => {
    const body = JSON.parse(input.prompt);
    if (body.identity.id === 'alice') {
      const result = await nativeCallback(input, 'companion_contact', { companionId: 'bob', destination: 'user', message: '请你亲自跟用户说下午好' });
      expect(result.status, result.error).toBe(200); peerId = String(result.result!.conversationId); return '已联系Bob';
    }
    expect(body.room.kind).toBe('peer'); expect(input.prompt).not.toContain('PRIVATE_SENTINEL');
    expect((await nativeCallback(input, 'companion_reply_user', { message: '下午好，我是Bob。' })).status).toBe(200);
    return '';
  }); closes.push(f.close);
  for (const id of ['alice', 'bob']) f.service.store.createCompanion({ id, name: id, persona: id });
  const direct = f.service.store.openDirect('alice'), target = f.service.store.openDirect('bob');
  f.service.store.enqueue({ conversationId: direct.id, senderId: 'user', content: 'PRIVATE_SENTINEL', recipientIds: [] });
  await f.service.handle({ type: 'message.send', conversationId: direct.id, content: '联系Bob问好', requestId: 'native-contact' });
  await waitNative(() => !!peerId && f.service.store.messagesPage(target.id).items.some(message => message.content === '下午好，我是Bob。'));
  expect(f.service.store.getConversation(peerId)).toMatchObject({ kind: 'peer', memberIds: ['alice', 'bob'] });
  expect(f.service.store.messagesPage(target.id).items.filter(message => message.senderId === 'bob')).toHaveLength(1);
});
