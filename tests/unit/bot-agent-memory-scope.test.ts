import { afterEach, expect, it, vi } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotAgentMemoryScopes } from '../../src/main/companion-bot/agent-memory-scope';
import { BotService } from '../../src/main/companion-bot/service';
import type { BotMemoryScope } from '../../src/main/companion-bot/memory-service';
import type { BotEvent } from '../../src/main/companion-bot/types';
import type { BotToolCall } from '../../src/main/companion-bot/tool-server';

const stores: BotStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new BotStore(':memory:'); stores.push(store);
  for (const id of ['alice', 'bob', 'carol']) store.createCompanion({ id, name: id, persona: id });
  const direct = store.openDirect('alice'), otherDirect = store.openDirect('bob');
  const group = store.createGroup({ title: 'User and Alice group', memberIds: ['alice', 'bob'] });
  const otherGroup = store.createGroup({ title: 'Other companion secret group', memberIds: ['bob', 'carol'] });
  const peer = store.openPeer('alice', 'bob'), world = store.createGroup({ title: 'Private world', kind: 'world', memberIds: ['alice'], includeUser: false });
  const event = (conversationId = direct.id) => store.enqueue({ conversationId, senderId: 'user', content: '查询本人获准记忆' }).events.find(item => item.companionId === 'alice')!;
  const source = event(), targetSource = event(group.id), scopes = new BotAgentMemoryScopes(store);
  const calls: Array<{ scope: BotMemoryScope; name: string; args: Record<string, unknown> }> = [];
  const checked = { available: true, records: [{ content: 'GROUP_FACT', sourceEventId: targetSource.id, sourceMessageIds: [targetSource.sourceMessageRecordId] }],
    provenance: { revision: '0', sourceEventIds: [targetSource.id], sourceMessageIds: [targetSource.sourceMessageRecordId] } };
  const memory = { readScoped: vi.fn(async (scope: BotMemoryScope, name: string, args: Record<string, unknown>) => { calls.push({ scope, name, args }); return checked; }),
    tool: vi.fn(async (scope: BotMemoryScope, name: string, args: Record<string, unknown>) => { calls.push({ scope, name, args }); return { local: true }; }),
    readNote: vi.fn(async (scope: BotMemoryScope, args: Record<string, unknown>) => { calls.push({ scope, name: 'memory_note', args }); return { local: true }; }) };
  const service = Object.create(BotService.prototype) as BotService;
  Object.assign(service, { store, options: { memory }, loadTombstones: vi.fn(async () => undefined), historyProjector: { project: vi.fn(async () => undefined) } });
  const invoke = (event: BotEvent, name: string, args: Record<string, unknown>) => (service as unknown as { executeTool(event: BotEvent, call: BotToolCall, signal: AbortSignal): Promise<unknown> })
    .executeTool(event, { eventId: event.id, laneId: event.laneId, callId: 'scope-read', name, args }, new AbortController().signal);
  return { store, direct, otherDirect, group, otherGroup, peer, world, source, targetSource, scopes, calls, checked, memory, service, invoke, event };
}

it('lists only the same companion user-involved scopes in pages without starting VCP', () => {
  const f = fixture(), first = f.scopes.list(f.source, { limit: 1 }); expect(first.scopes).toHaveLength(1); expect(first.hasMore).toBe(true);
  const next = f.scopes.list(f.source, { limit: 1, cursor: first.nextCursor });
  expect([...first.scopes, ...next.scopes].map(item => item.conversationId).sort()).toEqual([f.direct.id, f.group.id].sort());
  expect(next.hasMore).toBe(false); expect(f.memory.readScoped).not.toHaveBeenCalled(); expect(f.memory.tool).not.toHaveBeenCalled();
  expect(f.scopes.list(f.targetSource).scopes.map(item => item.conversationId)).toEqual([f.group.id]);
});

it('rejects forged homes, another companion, and cross-domain reads from group, peer or world views', () => {
  const f = fixture();
  for (const id of [f.otherDirect.id, f.otherGroup.id, f.peer.id, f.world.id, 'C:/private/home']) expect(() => f.scopes.resolve(f.source, id)).toThrow();
  expect(() => f.scopes.resolve(f.targetSource, f.direct.id)).toThrow();
  const peerEvent = f.store.enqueue({ conversationId: f.peer.id, senderId: 'bob', source: 'companion', recipientIds: ['alice'], content: '私聊' }).events[0]!;
  const worldEvent = f.store.enqueue({ conversationId: f.world.id, senderId: 'world', source: 'world', recipientIds: ['alice'], content: '世界观察' }).events[0]!;
  expect(() => f.scopes.resolve(peerEvent, f.direct.id)).toThrow(); expect(() => f.scopes.resolve(worldEvent, f.direct.id)).toThrow();
});

it('passes host-derived target scope for all five read tools and preserves default local reads', async () => {
  const f = fixture(), requested = [
    ['memory_search', { query: 'fact' }], ['memory_history', { keyword: 'fact' }], ['memory_read', { topicId: 'topic' }], ['memory_note', { id: 'note' }], ['memory_list', { query: 'fact', limit: 10 }],
  ] as const;
  for (const [name, args] of requested) {
    const value = await f.invoke(f.source, name, { ...args, conversationId: f.group.id });
    expect(value).toEqual({ sourceConversation: { id: f.group.id, title: f.group.title, kind: 'group' }, result: f.checked });
  }
  expect(f.calls.map(call => call.name)).toEqual(['memory_search', 'DeepMemo', 'TopicMemo', 'memory_note', 'memory_list']);
  expect(f.calls.every(call => call.scope.companionId === 'alice' && call.scope.conversationId === f.group.id && call.scope.securityDomainId === f.group.securityDomainId)).toBe(true);
  expect(await f.invoke(f.source, 'memory_search', { query: 'local' })).toEqual({ local: true });
  expect(f.calls.at(-1)?.scope).toEqual({ companionId: 'alice', conversationId: f.direct.id, securityDomainId: f.direct.securityDomainId });
  await expect(f.invoke(f.source, 'memory_search', { query: 'forge', conversationId: f.group.id, home: 'C:/private' })).rejects.toThrow();
});

it('checks both target and origin ACL again after asynchronous VCP reads and withholds late results', async () => {
  const f = fixture(); let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  f.memory.readScoped.mockImplementationOnce(async () => { await waiting; return f.checked; });
  const pending = f.invoke(f.source, 'memory_search', { query: 'fact', conversationId: f.group.id });
  await vi.waitFor(() => expect(f.memory.readScoped).toHaveBeenCalledOnce());
  f.store.updateMembers(f.group.id, ['bob']); release();
  await expect(pending).rejects.toThrow('授权');
  expect(f.scopes.dependentReplies(f.group.id)).toHaveLength(0);
  const second = fixture(); second.memory.readScoped.mockImplementationOnce(async () => {
    second.store.taskTransaction(sql => sql.prepare('UPDATE bot_conversations SET revision=revision+1 WHERE id=?').run(second.direct.id)); return second.checked;
  });
  await expect(second.invoke(second.source, 'memory_search', { query: 'fact', conversationId: second.group.id })).rejects.toThrow('授权');
});

it('retains exact cross-domain source dependencies so existing withdrawal propagation can invalidate imported replies', async () => {
  const f = fixture(); await f.invoke(f.source, 'memory_note', { id: 'note', conversationId: f.group.id });
  expect(f.scopes.dependentReplies(f.group.id)).toEqual([{ conversationId: f.direct.id, messageId: f.source.replyMessageId }]);
  f.store.withdrawSources('alice', f.group.securityDomainId, [f.targetSource.id]);
  expect(f.store.peerWithdrawalTargets('alice', f.group.securityDomainId)).toEqual([{ conversationId: f.direct.id, messageId: f.source.replyMessageId }]);
  const selected = f.scopes.resolve(f.source, f.group.id);
  expect(() => f.scopes.retainSources(f.source, selected, f.checked)).toThrow('撤回');
});
