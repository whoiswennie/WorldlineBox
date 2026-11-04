import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BotService } from '../../src/main/companion-bot/service';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class Memory extends BotMemoryService {
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> { return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'local-peer-http', metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 }; }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async appendHistory() { return { archived: true }; }
  override async finishTurn() { return { recorded: true }; }
  override async close() {}
}
type Envelope = { envelope?: { companionId: string; conversationId: string }; trigger?: { senderId: string; content: string; senderType: string }; room?: { kind: string; members: Array<{ id: string }> }; peerContact?: unknown };
type Body = { messages: Array<{ role: string; content?: string }>; tools?: unknown[] };
async function until(check: () => boolean) { const deadline = Date.now() + 15000; while (!check()) { if (Date.now() > deadline) throw Error('Peer HTTP delivery did not settle.'); await new Promise(resolve => setTimeout(resolve, 10)); } }

it('uses real App HTTP tool callbacks to deliver a greeting into the target user direct and a separate two-partner private transcript', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-peer-http-')), requests: Array<{ body: Body; envelope?: Envelope; kind: string }> = [], errors: string[] = [];
  const server = createServer((request, response) => { void (async () => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Body, system = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    let envelope: Envelope | undefined, envelopeIndex = -1;
    for (let index = body.messages.length - 1; index >= 0; index--) { const message = body.messages[index]!; if (message.role === 'user') { try { const value = JSON.parse(message.content ?? '') as Envelope; if (value.envelope && value.trigger) { envelope = value; envelopeIndex = index; break; } } catch { /* Ordinary history is plain text. */ } } }
    const kind = system.includes('群聊的轻量参与判断器') ? 'judge' : system.includes('对话记忆编码器') ? 'memory' : body.tools?.length ? 'reply' : 'other';
    requests.push({ body, envelope, kind });
    const destination = envelope?.trigger?.content.includes('HTTP_REQUEST_USER_GREETING') ? 'user' : envelope?.trigger?.content.includes('HTTP_REQUEST_PEER_CHAT') ? 'peer' : undefined;
    const completedTool = body.messages.slice(envelopeIndex + 1).findLast(message => message.role === 'tool');
    const call = kind === 'reply' && envelope?.envelope?.companionId === 'alice' && destination && !completedTool;
    const content = kind === 'judge' ? '{"recipients":[],"reason":"本地协议夹具不触发额外自动回复"}' : kind === 'memory' ? '{"notes":[]}'
      : completedTool ? '已按指定目的投递。' : envelope?.envelope?.companionId === 'bob' ? envelope.room?.kind === 'peer' ? '你好 Alice，这是伙伴私聊。' : '下午好，用户。' : '本地协议响应。';
    const message = call ? { content: '', tool_calls: [{ id: `contact-${destination}`, type: 'function', function: { name: 'companion_contact', arguments: JSON.stringify({ companionId: 'bob', destination, message: destination === 'user' ? '请向用户说下午好。' : '你好 GPT，聊聊今天的创作。' }) } }] } : { content };
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message }] }));
  })().catch(error => { errors.push(String(error)); response.writeHead(500).end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No local HTTP address.');
  const host = vi.fn(async () => { throw Error('Peer contact must not start DSH.'); });
  const service = new BotService({ root, brainRuntime: 'worldlinebox', brain: new BotBrainRouter({ app: new BotAppBrain({ root: path.join(root, 'router') }), worker: new BotDshBrain({ getHost: host }) }),
    memory: new Memory({ root: path.join(root, 'memory'), runtime: async () => { throw Error('No VCP quality inference in HTTP routing fixture.'); }, embedding: async () => { throw Error('No embedding.'); } }),
    model: () => ({ apiFormat: 'openai_chat', model: 'local-peer-delivery', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-fixture-no-billing', contextWindow: 65536, maxTokens: 1024 }), onEvent: () => undefined });
  cleanup.push(async () => { await service.shutdown(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-peer-http-')) throw Error('Invalid owned HTTP test profile.'); await rm(root, { recursive: true, force: true }); });
  await service.handle({ type: 'state' });
  service.store.createCompanion({ id: 'alice', name: 'Alice', persona: '真实伙伴 Alice' }); service.store.createCompanion({ id: 'bob', name: 'GPT', persona: '真实伙伴 GPT' });
  const origin = service.store.openDirect('alice'), target = service.store.openDirect('bob');
  service.store.enqueue({ conversationId: origin.id, senderId: 'user', recipientIds: [], sourceMessageId: 'origin-private', content: 'ALICE_PRIVATE_SECRET_NOT_FOR_BOB' });
  service.store.enqueue({ conversationId: target.id, senderId: 'user', recipientIds: [], sourceMessageId: 'target-private', content: 'BOB_PRIVATE_SECRET_NOT_FOR_ALICE' });
  const dispatch = async (content: string, requestId: string) => {
    const sent = await service.handle({ type: 'message.send', conversationId: origin.id, content, requestId }); expect(sent.ok).toBe(true);
    const events = service.store.taskTransaction(sql => sql.prepare('SELECT id FROM bot_inbox WHERE source_record_id=?').all(sent.messageId).map(row => String((row as { id: string }).id)));
    events.forEach(id => service.store.setMetadata(`skipCapture:${id}`, 'true'));
    await until(() => events.every(id => service.store.getEvent(id)!.status === 'done'));
  };
  await dispatch('HTTP_REQUEST_USER_GREETING 请让 GPT 私聊我说下午好。', 'greeting');
  await until(() => service.store.messagesPage(target.id).items.some(message => message.senderId === 'bob' && message.content === '下午好，用户。'));
  const directRows = service.store.messagesPage(target.id).items;
  const relayed = directRows.find(message => message.senderId === 'alice')!;
  expect(relayed.content).toContain('下午好'); expect(relayed.content).not.toContain('ALICE_PRIVATE_SECRET');
  expect(service.store.getConversation(target.id)!.memberIds.sort()).toEqual(['bob', 'user']);
  expect(service.store.conversations().filter(room => room.kind === 'group' || room.kind === 'peer')).toHaveLength(0);
  const directHttp = requests.find(item => item.kind === 'reply' && item.envelope?.envelope?.conversationId === target.id)!;
  expect(directHttp.envelope?.trigger).toMatchObject({ senderId: 'alice', senderType: 'companion' });
  expect(JSON.stringify(directHttp.body)).not.toContain('ALICE_PRIVATE_SECRET_NOT_FOR_BOB');
  await dispatch('HTTP_REQUEST_PEER_CHAT 你和 GPT 私下聊聊。', 'private-chat');
  await until(() => service.store.conversations().some(room => room.kind === 'peer'));
  const peer = service.store.conversations().find(room => room.kind === 'peer')!;
  await until(() => service.store.messagesPage(peer.id).items.some(message => message.senderId === 'bob' && message.content === '你好 Alice，这是伙伴私聊。'));
  expect(peer.memberIds.sort()).toEqual(['alice', 'bob']); expect(peer.userRole).toBe('observer');
  const peerRequests = requests.filter(item => item.kind === 'reply' && item.envelope?.envelope?.conversationId === peer.id);
  expect(peerRequests.length).toBeGreaterThan(0);
  for (const captured of peerRequests) { expect(JSON.stringify(captured.body)).not.toMatch(/ALICE_PRIVATE_SECRET_NOT_FOR_BOB|BOB_PRIVATE_SECRET_NOT_FOR_ALICE/u); expect(captured.envelope?.room?.members.map(member => member.id).sort()).toEqual(['alice', 'bob']); }
  expect((await service.handle({ type: 'state', conversationId: peer.id })).snapshot?.messages.some(message => message.content === '你好 Alice，这是伙伴私聊。')).toBe(true);
  await expect(service.handle({ type: 'message.send', conversationId: peer.id, content: '不能冒充私聊成员', requestId: 'observer-post' })).rejects.toThrow('只能旁观');
  expect(errors).toEqual([]); expect(host).not.toHaveBeenCalled();
  const output = path.resolve('artifacts/superagent-bot-development/peer-delivery-http-proof.json'); await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ passed: true, actualLocalHttp: true, scriptedModel: true, realProviderQualityMeasured: false, paidCalls: 0,
    direct: { conversationId: target.id, members: service.store.getConversation(target.id)!.memberIds, relaySender: relayed.senderId, replySender: 'bob', context: directHttp.envelope },
    peer: { conversationId: peer.id, members: peer.memberIds, userRole: peer.userRole, requestCount: peerRequests.length }, sourceSecretsExcluded: true, dshCalls: host.mock.calls.length, requestCount: requests.length }, null, 2));
});
