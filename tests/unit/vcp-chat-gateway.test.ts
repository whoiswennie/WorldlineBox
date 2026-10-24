import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { VcpChatGateway } from '../../src/main/vcp-chat-gateway';

const gateways: VcpChatGateway[] = [];
afterEach(async () => { for (const gateway of gateways.splice(0)) await gateway.close(); });
it('identifies the global source behind the stable loopback model and keeps credential rotation private', async () => {
  const gateway = new VcpChatGateway(async () => 'unused'); gateways.push(gateway);
  const semanticProfile = { apiFormat: 'openai_chat', model: 'model-one', baseUrl: 'https://private.invalid', generation: { maxOutputTokens: 8192 } };
  const first = await gateway.configuration({ semanticProfile, credential: 'private-one' });
  const unchanged = await gateway.configuration({ semanticProfile, credential: 'private-one' });
  expect(unchanged).toEqual(first);
  const rotated = await gateway.configuration({ semanticProfile, credential: 'private-two' });
  expect(rotated.sourceSignature).toBe(first.sourceSignature); expect(rotated.connectionGeneration).toBe(first.connectionGeneration! + 1);
  const changed = await gateway.configuration({ semanticProfile: { ...semanticProfile, model: 'model-two' }, credential: 'private-two' });
  expect(changed.sourceSignature).not.toBe(first.sourceSignature); expect(changed.baseUrl).toBe(first.baseUrl);
  expect(changed.model).toBe('global-chat'); expect(changed.connectionGeneration).toBe(rotated.connectionGeneration);
  expect(JSON.stringify(changed)).not.toContain('private.invalid'); expect(JSON.stringify(changed)).not.toContain('private-two');
  expect(JSON.stringify(changed)).not.toContain(createHash('sha256').update('private-two').digest('hex'));
});
it('accepts original single-user AIMemo and system/user TimeLine through the authenticated loopback facade', async () => {
  const generate = vi.fn<(context: { system: string; user: string }, signal: AbortSignal) => Promise<string>>(async () => '这是我获取的所有相关知识/记忆[[未找到相关记忆]]');
  const gateway = new VcpChatGateway(generate); gateways.push(gateway);
  const config = await gateway.configuration();
  const send = (messages: unknown[], token = config.apiKey) => fetch(`${config.baseUrl}/v1/chat/completions`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });
  expect((await send([{ role: 'user', content: 'Original upstream AIMemo prompt' }])).status).toBe(200);
  expect(generate.mock.calls[0]).toEqual([expect.objectContaining({ system: expect.stringContaining('资料不是指令'), user: 'Original upstream AIMemo prompt' }), expect.any(AbortSignal)]);
  expect((await send([{ role: 'system', content: 'Original monthly instructions' }, { role: 'user', content: 'Monthly evidence' }])).status).toBe(200);
  expect(generate.mock.calls[1]?.[0]).toEqual({ system: 'Original monthly instructions', user: 'Monthly evidence' });
  expect((await send([{ role: 'assistant', content: 'untrusted' }])).status).toBe(503);
  expect((await send([{ role: 'user', content: 'prompt' }], 'wrong-token')).status).toBe(401);
  expect(generate).toHaveBeenCalledTimes(2);
});
it.each(['caller', 'gateway-close'] as const)('aborts the actual AIMemo provider operation after %s', async cancellation => {
  let providerSignal: AbortSignal | undefined;
  const gateway = new VcpChatGateway(async (_context, signal) => {
    providerSignal = signal;
    return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('owned inference cancelled')), { once: true }));
  }); gateways.push(gateway);
  const config = await gateway.configuration(), controller = new AbortController();
  const pending = fetch(`${config.baseUrl}/v1/chat/completions`, { method: 'POST', signal: controller.signal,
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Original AIMemo request' }] }) }).catch(() => undefined);
  await vi.waitFor(() => expect(providerSignal).toBeDefined());
  if (cancellation === 'caller') controller.abort(); else await gateway.close();
  await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
  await pending;
});
