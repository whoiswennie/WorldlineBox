import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

it('commits text, a real sticker, and a native file to the delegated user audience only', async () => {
  let stickerId = '', output = '', peerId = '', targetId = '', summary: unknown;
  const f = await nativeServiceFixture(async input => {
    const body = JSON.parse(input.prompt);
    if (body.delivery.kind === 'peer-results') {
      summary = body.delivery.peerReturn.results[0].userDelivery;
      return 'Delivery verified.';
    }
    if (body.identity.id === 'alice') {
      const contact = await nativeCallback(input, 'companion_contact', { companionId: 'bob', destination: 'user', message: 'Prepare a reply with an illustration and the report.' });
      expect(contact.ok).toBe(true);
      peerId = String(contact.result?.conversationId);
      return 'Assigned.';
    }
    expect(body.delivery.output).toMatchObject({ conversationRecipientIds: ['alice'],
      mediaDestination: 'user-direct', userDirect: { senderId: 'bob', recipientId: 'user' } });
    const text = await nativeCallback(input, 'companion_reply_user', { message: 'Here are the materials.' });
    expect(text.result).toMatchObject({ status: 'staged', conversationId: targetId, recipientId: 'user' });
    expect(f.service.store.messagesPage(targetId).items).toEqual([]);
    const sticker = await nativeCallback(input, 'chat_send_sticker', { stickerId });
    expect(sticker.result).toMatchObject({ status: 'staged', conversationId: targetId, attachmentIds: [stickerId] });
    expect(await nativeCallback(input, 'chat_send_sticker', { stickerId })).toEqual(sticker);
    return { text: 'Coordinator update.', artifacts: [{ path: output }] };
  });
  closes.push(f.close);
  for (const id of ['alice', 'bob']) f.service.store.createCompanion({ id, name: id, persona: id });
  const direct = f.service.store.openDirect('alice');
  targetId = f.service.store.openDirect('bob').id;
  const pack = (await f.media.listPacks({ conversationId: targetId })).find(item => item.builtin)!;
  stickerId = (await f.media.listStickers({ conversationId: targetId, packId: pack.id }))[0]!.id;
  output = path.join(f.root, 'report.csv');
  await writeFile(output, 'total\n42\n');
  await f.service.handle({ type: 'message.send', conversationId: direct.id, content: 'Please ask Bob for the materials.', requestId: 'deliver-assets' });
  await waitNative(() => summary !== undefined);
  const [message, ...duplicates] = f.service.store.messagesPage(targetId).items;
  expect(duplicates).toEqual([]);
  expect(message).toMatchObject({ conversationId: targetId, senderId: 'bob', content: 'Here are the materials.',
    attachments: [expect.objectContaining({ id: stickerId, kind: 'sticker' }), expect.objectContaining({ name: 'report.csv', kind: 'file' })] });
  expect(await readFile((await f.media.getForAgent(targetId, message!.attachments![1]!.id)).path, 'utf8')).toBe('total\n42\n');
  expect(f.service.store.messagesPage(peerId).items.every(item => !item.attachments?.length)).toBe(true);
  expect(summary).toMatchObject({ conversationId: targetId, messageId: message!.id, hasText: true, attachmentCount: 2 });
  expect(summary).not.toHaveProperty('content');
});

it('retains the original requester across same-name peers and delivers an attachment-only response after a nested return', async () => {
  let sourceFile = '', targetRoom = '', thirdPeer = '', continued = false;
  const f = await nativeServiceFixture(async input => {
    const body = JSON.parse(input.prompt);
    const self = body.delivery.self.id;
    if (self === 'alice') {
      if (body.delivery.kind === 'peer-results') return 'The task returned.';
      const relay = await nativeCallback(input, 'companion_contact',
        { companionId: 'bob', destination: 'user', message: 'Check the shared document and deliver it.', attachmentIds: [sourceFile] });
      expect(relay.ok, relay.error).toBe(true);
      return 'Delegated.';
    }
    if (self === 'bob' && body.delivery.kind === 'peer-request') {
      expect(body.delivery.assignment).toMatchObject({ requester: { id: 'alice' }, delegate: { id: 'bob' }, originalSender: { id: 'user' } });
      const file = body.files[0];
      expect(file.name).toBe('notes.txt');
      const prepared = await nativeCallback(input, 'companion_reply_user', { attachmentIds: [file.id] });
      expect(prepared.result).toMatchObject({ status: 'staged', recipientId: 'user' });
      const relay = await nativeCallback(input, 'companion_contact', { companionId: 'carol', destination: 'peer', message: 'Check the format.' });
      expect(relay.ok, relay.error).toBe(true);
      thirdPeer = String(relay.result?.conversationId);
      return 'Awaiting format check.';
    }
    if (self === 'carol') {
      expect(body.delivery).toMatchObject({ speaker: { id: 'bob' }, originalRequester: { id: 'user' },
        assignment: { requester: { id: 'bob' }, delegate: { id: 'carol' }, originalSender: { id: 'user' } },
        output: { mediaDestination: 'current-conversation', conversationRecipientIds: ['bob'] } });
      expect((await nativeCallback(input, 'companion_reply_user', { message: 'Forbidden cross-room publication.' })).ok).toBe(false);
      expect(f.service.store.messagesPage(targetRoom).items).toEqual([]);
      return 'Format confirmed.';
    }
    expect(body.delivery).toMatchObject({ kind: 'peer-results', self: { id: 'bob' }, speaker: { id: 'carol' },
      originalRequester: { id: 'user' }, output: { conversationRecipientIds: ['alice'], userDirect: { senderId: 'bob', recipientId: 'user' } } });
    continued = true;
    return 'Check complete.';
  });
  closes.push(f.close);
  for (const id of ['alice', 'bob', 'carol']) f.service.store.createCompanion({ id, name: '同名伙伴', persona: id });
  const direct = f.service.store.openDirect('alice');
  targetRoom = f.service.store.openDirect('bob').id;
  const file = path.join(f.root, 'notes.txt');
  await writeFile(file, 'Verified original content');
  sourceFile = (await f.media.importFiles({ conversationId: direct.id, paths: [file] }))[0]!.id;
  await f.service.handle({ type: 'message.send', conversationId: direct.id, content: 'Please ask the next partner to check and return the file.', attachmentIds: [sourceFile], requestId: 'nested-delivery' });
  await waitNative(() => continued && f.service.store.messagesPage(targetRoom).items.length === 1);
  expect(f.service.store.getConversation(thirdPeer)?.memberIds).toEqual(['bob', 'carol']);
  const [message] = f.service.store.messagesPage(targetRoom).items;
  expect(message).toMatchObject({ senderId: 'bob', content: '', attachments: [expect.objectContaining({ name: 'notes.txt' })] });
  expect(await readFile((await f.media.getForAgent(targetRoom, message!.attachments![0]!.id)).path, 'utf8')).toBe('Verified original content');
});
