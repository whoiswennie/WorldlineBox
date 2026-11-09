import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryScope, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class Memory extends BotMemoryService {
  evidence: unknown;
  tombstones = new Map<string, { sourceEventIds: string[]; sourceMessageIds: string[] }>();
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> { return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'scope-acl', metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 }; }
  override async withdrawnSources(scope: BotMemoryScope) { return { revision: this.tombstones.has(scope.conversationId) ? '1' : '0', sourceEventIds: [], sourceMessageIds: [], ...this.tombstones.get(scope.conversationId) }; }
  override async withdrawSources(scope: BotMemoryScope, input: Parameters<BotMemoryService['withdrawSources']>[1]) { this.tombstones.set(scope.conversationId, input); return { withdrawn: true as const, revision: '1', ...input }; }
  override async readScoped() { return this.evidence; }
  override async forget(scope: BotMemoryScope, input: { id: string }) {
    const sources = (this.evidence as { provenance: { sourceEventIds: string[]; sourceMessageIds: string[] } }).provenance;
    this.tombstones.set(scope.conversationId, sources);
    return { forgotten: true as const, id: input.id, revision: '1', relatedIds: [input.id], physicalSourceErasure: false as const, sourceEventIds: sources.sourceEventIds, sourceMessageIds: sources.sourceMessageIds };
  }
  override async appendHistory() { return { archived: true }; }
  override async finishTurn() { return { recorded: true }; }
  override async close() {}
}
async function until(check: () => boolean | Promise<boolean>, timeout = 10000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw Error('Memory ACL fixture timed out'); await new Promise(resolve => setTimeout(resolve, 15)); } }

it.each(['members', 'dissolve', 'forget'] as const)('invalidates imported tool context and capture sources after source group %s changes, before the next fresh native DSH turn', async operation => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-memory-acl-'));
  let groupId = '', nextRequest = '';
  const memory = new Memory({ root: path.join(root, 'memory'), runtime: async () => { throw Error('No native VCP in protocol ACL test'); }, embedding: async () => { throw Error('No embedding in protocol ACL test'); } });
  const brain = new BotDshBrain({ getHost: async () => { throw Error('No DSH process in native protocol fixture'); } });
  vi.spyOn(brain, 'run').mockImplementation(async input => {
    const query = input.prompt;
    if (query.includes('READ_APPROVED_GROUP')) {
      const response = await fetch(input.callback!.url, { method: 'POST', headers: { authorization: `Bearer ${input.callback!.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId: 'scope-read', name: 'memory_search', args: { query: 'GROUP_SCOPE_SECRET', conversationId: groupId } }) });
      expect(response.ok).toBe(true); expect(JSON.stringify(await response.json())).toContain('GROUP_SCOPE_SECRET_FROM_MEMORY');
    }
    if (query.includes('NEXT_AFTER_ACL')) nextRequest = JSON.stringify({ system: input.system, prompt: input.prompt });
    return { status: 'succeeded', text: query.includes('READ_APPROVED_GROUP') ? 'GROUP_SCOPE_SECRET_FROM_MEMORY' : 'AFTER_ACL_OK', eventId: input.eventId, sessionId: input.laneId };
  });
  const service: BotService = new BotService({ root, brain, memory,
    model: () => ({ apiFormat: 'openai_chat', model: 'local-protocol', baseUrl: 'http://127.0.0.1:9', apiKey: 'no-billing', contextWindow: 65536, maxTokens: 512 }), onEvent: () => undefined });
  cleanup.push(async () => { await service.shutdown(); if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-memory-acl-')) throw Error('Invalid ACL fixture cleanup'); await rm(root, { recursive: true, force: true }); });
  await service.handle({ type: 'state' }); service.store.createCompanion({ id: 'memory-other', name: 'Other', persona: 'other' });
  const direct = service.store.openDirect(DEFAULT_BOT_COMPANION_ID), group = service.store.createGroup({ title: 'Approved source group', memberIds: [DEFAULT_BOT_COMPANION_ID, 'memory-other'], participationMode: 'mentions' }); groupId = group.id;
  const source = service.store.enqueue({ conversationId: group.id, senderId: 'user', recipientIds: [], content: 'GROUP_SCOPE_SECRET_FROM_MEMORY' }).message;
  memory.evidence = { available: true, records: [{ content: source.content, sourceMessageIds: [source.id] }], provenance: { revision: '0', sourceEventIds: [], sourceMessageIds: [source.id] } };
  const sent = await service.handle({ type: 'message.send', conversationId: direct.id, requestId: 'read-group', content: 'READ_APPROVED_GROUP' });
  await until(async () => (await service.handle({ type: 'state', conversationId: direct.id })).snapshot!.messages.some(message => message.content === 'GROUP_SCOPE_SECRET_FROM_MEMORY' && message.status === 'sent'));
  const event = service.store.taskTransaction(sql => sql.prepare('SELECT id FROM bot_inbox WHERE source_record_id=?').get(sent.messageId)) as { id: string };
  const original = service.store.getEvent(event.id)!, epoch = service.store.getLane(original.laneId)!.epoch;
  if (operation === 'members') await service.handle({ type: 'conversation.members', conversationId: group.id, memberIds: ['memory-other'] });
  else if (operation === 'dissolve') await service.handle({ type: 'conversation.dissolve', conversationId: group.id });
  else await service.handle({ type: 'memory.forget', conversationId: group.id, companionId: DEFAULT_BOT_COMPANION_ID, id: 'managed-group-note' });
  expect(service.store.withdrawnIn(DEFAULT_BOT_COMPANION_ID, direct.securityDomainId, [original.replyMessageId]).size).toBe(1);
  expect(service.store.getLane(original.laneId)!.epoch).toBeGreaterThan(epoch);
  await service.handle({ type: 'message.send', conversationId: direct.id, requestId: 'after-group-acl', content: 'NEXT_AFTER_ACL' });
  await until(() => nextRequest.length > 0);
  expect(nextRequest).not.toContain('GROUP_SCOPE_SECRET');
  expect(nextRequest).not.toContain(source.id);
});
