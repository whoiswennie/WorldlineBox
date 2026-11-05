import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotMemoryService, type BotMemoryOptions } from '../../src/main/companion-bot/memory-service';
import { BotService } from '../../src/main/companion-bot/service';
import type { BotEvent } from '../../src/main/companion-bot/types';
import type { BotToolCall } from '../../src/main/companion-bot/tool-server';

const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
const nodePath = path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
it.skipIf(!existsSync(nodePath) || !existsSync(path.join(packageRoot, 'lib/client.cjs')))('reads a real VCP managed group diary through its owner direct view and refuses it after native withdrawal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-agent-memory-native-'));
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-agent-memory-native-')) throw Error('Invalid owned memory fixture cleanup');
  const store = new BotStore(path.join(root, 'store.sqlite')), nativeCalls: string[] = []; let embeddings = 0, sessions = 0, unexpected = 0;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    if (!request.url?.endsWith('/v1/embeddings')) { unexpected++; response.writeHead(404).end(); return; }
    embeddings++; const payload = JSON.parse(raw), inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: inputs.map((_: unknown, index: number) => ({ index, embedding: Array.from({ length: 64 }, (_, axis) => axis === 0 ? 1 : 0.01) })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw Error('No embedding fixture port');
  const base = `http://127.0.0.1:${address.port}`, client = createRequire(path.join(packageRoot, 'package.json'))('./lib/client.cjs') as { createSession: NonNullable<BotMemoryOptions['createSession']> };
  const memory = new BotMemoryService({ root: path.join(root, 'memory'), runtime: async () => ({ nodePath, packageRoot }), requestTimeoutMs: 60000,
    embedding: async () => ({ baseUrl: base + '/document', queryBaseUrl: base + '/query', apiKey: 'local-no-billing', model: 'agent-scope64', dimension: 64, modelSignature: 'agent-scope64-v1' }),
    createSession: options => { sessions++; const actual = client.createSession(options); return { closed: actual.closed, close: () => actual.close(),
      request: (operation, payload, requestOptions) => { nativeCalls.push(operation); return actual.request(operation, payload, requestOptions); } }; } });
  try {
    store.createCompanion({ id: 'alice', name: 'Alice', persona: 'native memory fixture' });
    const direct = store.openDirect('alice'), group = store.createGroup({ title: 'Approved group', memberIds: ['alice'] });
    const target = store.enqueue({ conversationId: group.id, senderId: 'user', content: 'SCOPE_NATIVE_DIARY_2026：我们决定保持夜间喝麦茶。' }).events[0]!;
    const source = store.enqueue({ conversationId: direct.id, senderId: 'user', content: '回忆我们群里的决定' }).events[0]!;
    const scope = { companionId: 'alice', conversationId: group.id, securityDomainId: group.securityDomainId };
    expect(await memory.remember(scope, { sourceEventId: target.id, sourceMessageIds: [target.sourceMessageRecordId], content: target.content })).toMatchObject({ indexed: 1, pending: 0 });
    const service = Object.create(BotService.prototype) as BotService;
    Object.assign(service, { store, options: { memory }, loadTombstones: async () => undefined });
    const invoke = (name: string, args: Record<string, unknown>) => (service as unknown as { executeTool(event: BotEvent, call: BotToolCall, signal: AbortSignal): Promise<unknown> }).executeTool(source,
      { eventId: source.id, laneId: source.laneId, callId: 'native-scope-read', name, args }, new AbortController().signal);
    const scopes = await invoke('agent_memory_scopes', {}) as { scopes: Array<{ conversationId: string }> };
    expect(scopes.scopes.some(item => item.conversationId === group.id)).toBe(true);
    const catalog = await invoke('memory_list', { query: 'SCOPE_NATIVE_DIARY_2026', conversationId: group.id, limit: 10 }) as { result: { available: boolean; records: Array<{ id: string }> } };
    expect(catalog.result.available).toBe(true); const note = catalog.result.records[0]; expect(note?.id).toBeTruthy();
    const read = () => invoke('memory_note', { id: note!.id, conversationId: group.id });
    const result = await read(); expect(result).toMatchObject({ sourceConversation: { id: group.id }, result: { available: true } }); expect(JSON.stringify(result)).toContain('SCOPE_NATIVE_DIARY_2026');
    expect(nativeCalls).toContain('bot.source.filter'); expect(sessions).toBe(1);
    const receipt = await memory.forget(scope, { id: note!.id }); store.withdrawSources('alice', group.securityDomainId, [...receipt.sourceEventIds, ...receipt.sourceMessageIds]);
    expect(store.peerWithdrawalTargets('alice', group.securityDomainId)).toEqual([{ conversationId: direct.id, messageId: source.replyMessageId }]);
    const after = await read().then(value => JSON.stringify(value), () => 'controlled-unavailable'); expect(after).not.toContain('SCOPE_NATIVE_DIARY_2026');
    expect(embeddings).toBeGreaterThan(0); expect(unexpected).toBe(0);
  } finally {
    await memory.close(); store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
