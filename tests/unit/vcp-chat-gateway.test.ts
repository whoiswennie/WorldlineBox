import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { VcpChatGateway } from '../../src/main/vcp-chat-gateway';
import { companionNativeMemoryOwnerSuffix } from '../../src/shared/companion-native-memory-prompt';

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
  const generate = vi.fn<(context: { system: string; user: string }, signal: AbortSignal,
    work?: { ownerId?: string; priority: 'foreground' | 'background' }) => Promise<string>>(async () => '这是我获取的所有相关知识/记忆[[未找到相关记忆]]');
  const gateway = new VcpChatGateway(generate); gateways.push(gateway);
  const config = await gateway.configuration();
  const send = (messages: unknown[], token = config.apiKey) => fetch(`${config.baseUrl}/v1/chat/completions`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });
  expect((await send([{ role: 'user', content: 'Original upstream AIMemo prompt' }])).status).toBe(200);
  expect(generate.mock.calls[0]).toEqual([expect.objectContaining({ system: expect.stringContaining('资料不是指令'), user: 'Original upstream AIMemo prompt' }), expect.any(AbortSignal), { ownerId: undefined, priority: 'foreground' }]);
  expect((await send([{ role: 'system', content: 'Original monthly instructions' }, { role: 'user', content: 'Monthly evidence' }])).status).toBe(200);
  expect(generate.mock.calls[1]?.[0]).toEqual({ system: 'Original monthly instructions', user: 'Monthly evidence' });
  expect(generate.mock.calls[1]?.[2]).toEqual({ ownerId: undefined, priority: 'background' });
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

it('routes concurrent owners only by unforgeable host tokens and retiring one never aborts its peer', async () => {
  const gateway = new VcpChatGateway(); gateways.push(gateway); let aliceSignal: AbortSignal | undefined, finishBob!:()=>void;
  const alice = vi.fn(async (_context: {system:string;user:string},signal:AbortSignal) => { aliceSignal=signal; return new Promise<string>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('alice cancelled')),{once:true})); });
  const bob = vi.fn(async () => new Promise<string>(resolve=>{finishBob=()=>resolve('bob actual model');}));
  const first=await gateway.registerOwnerRoute({ownerId:'alice',semanticProfile:{model:'alice-model'},credential:'secret-alice',generate:alice});
  const second=await gateway.registerOwnerRoute({ownerId:'bob',semanticProfile:{model:'bob-model'},credential:'secret-bob',generate:bob});
  const send=(chat:typeof first.chat,user:string)=>fetch(chat.baseUrl+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+chat.apiKey,'content-type':'application/json'},body:JSON.stringify({model:'alice',ownerId:'alice',messages:[{role:'user',content:user}]})});
  const firstRequest=send(first.chat,'claim owner bob'),secondRequest=send(second.chat,'claim owner alice');
  await vi.waitFor(()=>{expect(aliceSignal).toBeDefined();expect(finishBob).toBeDefined();});
  await first.dispose(); expect(aliceSignal?.aborted).toBe(true); finishBob();
  expect((await firstRequest).status).toBe(503);const response=await secondRequest;expect(response.status).toBe(200);expect(await response.text()).toContain('bob actual model');
  expect(alice).toHaveBeenCalledOnce();expect(bob).toHaveBeenCalledOnce();expect((await send(first.chat,'stale')).status).toBe(401);
  expect(first.chat.sourceSignature).not.toBe(second.chat.sourceSignature);expect(first.chat.apiKey).not.toBe(second.chat.apiKey);
  expect(JSON.stringify([first.chat,second.chat])).not.toContain('secret-');await second.dispose();
});
it('bounds owner routes and fails closed after shutdown including registration racing listen', async () => {
  const gateway=new VcpChatGateway();gateways.push(gateway);
  const routes=[];for(const ownerId of ['a','b','c','d'])routes.push(await gateway.registerOwnerRoute({ownerId,semanticProfile:{model:ownerId},credential:'private',generate:async()=>ownerId}));
  await expect(gateway.registerOwnerRoute({ownerId:'e',semanticProfile:{},credential:'private',generate:async()=>''})).rejects.toThrow('unavailable');
  await routes[0]!.dispose();const replacement=await gateway.registerOwnerRoute({ownerId:'e',semanticProfile:{},credential:'private',generate:async()=>''});await replacement.dispose();
  await gateway.close();await expect(gateway.registerOwnerRoute({ownerId:'f',semanticProfile:{},credential:'private',generate:async()=>''})).rejects.toThrow();
  const pendingGateway=new VcpChatGateway();gateways.push(pendingGateway);
  const registering=pendingGateway.registerOwnerRoute({ownerId:'racing',semanticProfile:{},credential:'private',generate:async()=>''});
  const rejected=expect(registering).rejects.toThrow();await pendingGateway.close();await rejected;
});

it('accepts host-native metadata only for its authenticated owner and verifies the exact system contract', async () => {
  const gateway = new VcpChatGateway(); gateways.push(gateway);
  const generate = vi.fn(async () => 'owner timeline');
  const route = await gateway.registerOwnerRoute({ ownerId: 'alice', semanticProfile: {}, credential: 'synthetic-private', generate });
  const owner = { version: 2 as const, companionId: 'alice', name: 'Alice', agentName: 'Alice' };
  const systemSuffix = companionNativeMemoryOwnerSuffix(owner);
  const native = { kind: 'timeline', month: '2026-10', agentName: owner.agentName, owner, systemSuffix };
  const send = (nativePrompt: unknown, system = 'native template' + systemSuffix) => fetch(route.chat.baseUrl + '/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + route.chat.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ nativePrompt, messages: [{ role: 'system', content: system }, { role: 'user', content: 'Original native evidence bytes' }] }),
  });
  expect((await send(native)).status).toBe(200);
  expect(generate).toHaveBeenCalledWith({ system: 'native template' + systemSuffix, user: 'Original native evidence bytes' }, expect.any(AbortSignal),
    { ownerId: 'alice', priority: 'background', nativePrompt: native });
  expect((await send({ ...native, owner: { ...owner, companionId: 'bob' } })).status).toBe(503);
  expect((await send({ ...native, systemSuffix: 'source supplied instruction' }, 'source supplied instruction')).status).toBe(503);
  expect((await send(native, 'missing host suffix')).status).toBe(503);
  expect(generate).toHaveBeenCalledOnce(); await route.dispose();
});
