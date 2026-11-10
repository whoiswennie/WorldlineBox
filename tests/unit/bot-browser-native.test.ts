import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { nativeServiceFixture, nativeCallback, waitNative } from '../fixtures/bot-native-service';

it('binds an authenticated native browser reference to the original DSH request and forwards operations with the real companion identity', async () => {
  const context = { referenceId: randomUUID(), tabId: 'existing-tab', url: 'https://example.com/workspace', title: 'Existing page', selection: 'Selected material', capturedAt: new Date().toISOString() };
  const operations: object[] = []; let resolves = 0;
  const f = await nativeServiceFixture(async input => {
    expect(JSON.parse(input.prompt).browserContext).toEqual(context);
    const result = await nativeCallback(input, 'browser', { action: 'read', tabId: context.tabId });
    expect(result.result).toEqual({ title: 'Existing page', text: 'Signed-in fixture' });
    const image = await nativeCallback(input, 'browser', { action: 'screenshot', tabId: context.tabId }, 'actual-image');
    expect(await readFile(String(image.result!.screenshotPath))).toEqual(Buffer.from('actual-fixture-image'));
    return '网页任务完成';
  }, { resolveBrowserContext: id => { resolves++; expect(id).toBe(context.referenceId); return context; }, browserTool: async (scope, input) => {
    operations.push({ scope, input }); return input.action === 'screenshot' ? { value: { tabId: context.tabId }, screenshot: Buffer.from('actual-fixture-image') } : { value: { title: 'Existing page', text: 'Signed-in fixture' } };
  } });
  try {
    const room = (await f.service.handle({ type: 'state' })).snapshot!.conversations[0]!, command = { type: 'message.send' as const, conversationId: room.id, content: '使用附加网页', requestId: 'browser-once', browserContextId: context.referenceId };
    const sent = await f.service.handle(command); await waitNative(() => f.service.store.getMessage(sent.replyMessageIds![0]!)?.status === 'sent');
    await f.service.handle(command); expect(resolves).toBe(1); expect(f.calls).toHaveLength(1);
    expect(operations).toHaveLength(2); expect(operations[0]).toMatchObject({ scope: { companionId: 'builtin-dafeiyu', conversationId: room.id }, input: { action: 'read', tabId: context.tabId } });
    const message = (await f.service.handle({ type: 'state', conversationId: room.id })).snapshot!.messages.find(message => message.id === sent.messageId)!;
    expect(message.browserContext).toEqual(context);
  } finally { await f.close(); }
});

it('refuses stale browser references before creating a new message', async () => {
  const f = await nativeServiceFixture(async () => 'must not execute', { resolveBrowserContext: () => { throw Error('所附网页已跳转'); } });
  try {
    const room = (await f.service.handle({ type: 'state' })).snapshot!.conversations[0]!;
    await expect(f.service.handle({ type: 'message.send', conversationId: room.id, content: '过期引用', requestId: 'stale-browser', browserContextId: randomUUID() })).rejects.toThrow('已跳转');
    expect(f.calls).toHaveLength(0); expect(f.service.store.messagesPage(room.id, {}).items).toHaveLength(0);
  } finally { await f.close(); }
});
