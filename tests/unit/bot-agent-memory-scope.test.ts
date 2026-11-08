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

it('lists only the same companion owner-observable direct, group and two-companion peer scopes in stable pages without VCP', () => {
  const f = fixture(), first = f.scopes.list(f.source, { limit: 1 }); expect(first.scopes).toHaveLength(1); expect(first.hasMore).toBe(true);
  const next = f.scopes.list(f.source, { limit: 1, cursor: first.nextCursor });
  expect(next.hasMore).toBe(true);
  const last = f.scopes.list(f.source, { limit: 1, cursor: next.nextCursor });
  expect([...first.scopes, ...next.scopes, ...last.scopes].map(item => item.conversationId).sort()).toEqual([f.direct.id, f.group.id, f.peer.id].sort());
  expect(last.hasMore).toBe(false); expect(f.memory.readScoped).not.toHaveBeenCalled(); expect(f.memory.tool).not.toHaveBeenCalled();
  expect(f.scopes.list(f.targetSource).scopes.map(item => item.conversationId)).toEqual([f.group.id]);
});

it('rejects forged homes, another companion, and cross-domain reads from group, peer or world views', () => {
  const f = fixture();
  const otherPeer = f.store.openPeer('bob', 'carol');
  for (const id of [f.otherDirect.id, f.otherGroup.id, otherPeer.id, f.world.id, 'C:/private/home']) expect(() => f.scopes.resolve(f.source, id)).toThrow();
  expect(f.scopes.resolve(f.source, f.peer.id)).toMatchObject({ crossConversation: true, sourceConversation: { kind: 'peer' }, scope: { companionId: 'alice' } });
  expect(() => f.scopes.resolve(f.targetSource, f.direct.id)).toThrow();
  const peerEvent = f.store.enqueue({ conversationId: f.peer.id, senderId: 'bob', source: 'companion', recipientIds: ['alice'], content: '私聊' }).events[0]!;
  const worldEvent = f.store.enqueue({ conversationId: f.world.id, senderId: 'world', source: 'world', recipientIds: ['alice'], content: '世界观察' }).events[0]!;
  expect(() => f.scopes.resolve(peerEvent, f.direct.id)).toThrow(); expect(() => f.scopes.resolve(worldEvent, f.direct.id)).toThrow();
  for (const source of [f.targetSource, peerEvent, worldEvent]) {
    expect(f.scopes.list(source).scopes.map(item => item.conversationId)).toEqual([source.conversationId]);
    expect(f.scopes.resolve(source).scope.conversationId).toBe(source.conversationId);
  }
});

it('excludes malformed, orphaned, retired, unrelated and dissolved rooms before SQL pagination', () => {
  const f = fixture();
  const malformed = (id: string, members: string[]) => f.store.taskTransaction(sql => {
    sql.prepare('INSERT INTO bot_conversations VALUES(?,?,?,?,?,?,?,?)').run(id, id, 'peer', `scope-${id}`, `domain-${id}`, 1, new Date().toISOString(), null);
    for (const member of members) sql.prepare('INSERT INTO bot_members VALUES(?,?)').run(id, member);
  });
  malformed('000-peer-single', ['alice']); malformed('001-peer-three', ['alice', 'bob', 'carol']);
  malformed('002-peer-user', ['alice', 'user']); malformed('003-peer-orphan', ['alice', 'missing']);
  f.store.createCompanion({ id: 'default-companion', name: 'Retired fixture', persona: 'Retired' });
  malformed('004-peer-retired', ['alice', 'default-companion']); f.store.setMetadata('development-default-cleanup', '{}');
  const dissolved = f.store.createGroup({ title: 'Dissolved room', memberIds: ['alice', 'bob', 'carol'] });
  f.store.dissolveConversation(dissolved.id);
  const allowed: string[] = []; let cursor: string | undefined;
  do {
    const page = f.scopes.list(f.source, { limit: 1, cursor });
    expect(page.scopes).toHaveLength(1); allowed.push(page.scopes[0]!.conversationId); cursor = page.nextCursor;
  } while (cursor);
  expect(allowed.sort()).toEqual([f.direct.id, f.group.id, f.peer.id].sort());
  for (const id of ['000-peer-single', '001-peer-three', '002-peer-user', '003-peer-orphan', '004-peer-retired', dissolved.id])
    expect(() => f.scopes.resolve(f.source, id)).toThrow('获准');
  expect(() => f.scopes.readableConversationPredicate(f.source, 'c; DROP TABLE bot_messages')).toThrow('别名');
});

it('lets an owner direct view recover both actual received and sent peer messages through all read tools without changing memory owner', async () => {
  const f = fixture();
  const received = f.store.enqueue({ conversationId: f.peer.id, senderId: 'bob', source: 'companion', recipientIds: ['alice'], content: 'PEER_RECEIVED：查到了，结果在这里。' });
  const sent = f.store.enqueue({ conversationId: f.peer.id, senderId: 'alice', source: 'companion', recipientIds: ['bob'], content: 'PEER_SENT：收到，谢谢，我会告诉用户。' });
  const checked = { available: true, records: [received.message, sent.message].map(message => ({ content: message.content, sourceMessageIds: [message.id] })),
    provenance: { revision: '0', sourceEventIds: [received.events[0]!.id], sourceMessageIds: [received.message.id, sent.message.id] } };
  f.memory.readScoped.mockImplementation(async (scope, name, args) => { f.calls.push({ scope, name, args }); return checked as typeof f.checked; });
  for (const [name, args] of [
    ['memory_search', { query: 'PEER' }], ['memory_history', { keyword: 'PEER' }], ['memory_read', { topicId: 'peer-topic' }],
    ['memory_note', { id: 'peer-note' }], ['memory_list', { query: 'PEER', limit: 10 }],
  ] as const) {
    const value = await f.invoke(f.source, name, { ...args, conversationId: f.peer.id });
    expect(value).toEqual({ sourceConversation: { id: f.peer.id, title: f.peer.title, kind: 'peer' }, result: checked });
  }
  expect(f.calls).toHaveLength(5);
  expect(f.calls.every(call => call.scope.companionId === 'alice' && call.scope.conversationId === f.peer.id && call.scope.securityDomainId === f.peer.securityDomainId)).toBe(true);
  expect(f.scopes.dependentReplies(f.peer.id)).toEqual([{ conversationId: f.direct.id, messageId: f.source.replyMessageId }]);
  f.store.withdrawSources('alice', f.peer.securityDomainId, [received.message.id]);
  expect(f.store.peerWithdrawalTargets('alice', f.peer.securityDomainId)).toEqual([{ conversationId: f.direct.id, messageId: f.source.replyMessageId }]);
  await expect(f.invoke(f.source, 'memory_search', { query: 'PEER', conversationId: f.peer.id })).rejects.toThrow('撤回');
});

it('rechecks strict peer observation eligibility after asynchronous memory reads before exposing text or retaining dependencies', async () => {
  for (const change of ['orphan', 'third-member', 'domain', 'origin-revision'] as const) {
    const f = fixture(); let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    f.memory.readScoped.mockImplementationOnce(async () => { await waiting; return f.checked; });
    const pending = f.invoke(f.source, 'memory_search', { query: 'peer', conversationId: f.peer.id });
    await vi.waitFor(() => expect(f.memory.readScoped).toHaveBeenCalledOnce());
    f.store.taskTransaction(sql => {
      if (change === 'orphan') sql.prepare("UPDATE bot_members SET member_id='missing' WHERE conversation_id=? AND member_id='bob'").run(f.peer.id);
      if (change === 'third-member') sql.prepare('INSERT INTO bot_members VALUES(?,?)').run(f.peer.id, 'carol');
      if (change === 'domain') sql.prepare("UPDATE bot_conversations SET domain_id='changed-domain' WHERE id=?").run(f.peer.id);
      if (change === 'origin-revision') sql.prepare('UPDATE bot_conversations SET revision=revision+1 WHERE id=?').run(f.direct.id);
    });
    release(); await expect(pending).rejects.toThrow('授权');
    expect(f.scopes.dependentReplies(f.peer.id)).toHaveLength(0);
  }
});

it('discovers only readable recent public scopes by actual publication order without leaking text or private task activity', () => {
  const f = fixture(), first = f.store.claim({ workerId: 'first-direct' })!;
  expect(first.event.id).toBe(f.source.id);
  const group = f.store.enqueue({ conversationId: f.group.id, senderId: 'bob', source: 'companion', recipientIds: [], content: 'GROUP_PUBLIC_BODY' });
  const peer = f.store.enqueue({ conversationId: f.peer.id, senderId: 'bob', source: 'companion', recipientIds: ['alice'], content: 'PEER_PUBLIC_BODY' });
  f.store.enqueue({ conversationId: f.group.id, senderId: 'bob', source: 'companion', kind: 'attention', recipientIds: [], content: 'PRIVATE_ATTENTION_BODY' });
  f.store.enqueue({ conversationId: f.peer.id, senderId: 'task-service', source: 'task', kind: 'task_done', recipientIds: ['alice'], content: 'PRIVATE_TASK_DONE_BODY' });
  f.store.enqueue({ conversationId: f.peer.id, senderId: 'task-service', source: 'task', kind: 'task_progress', recipientIds: ['alice'], content: 'PRIVATE_TASK_PROGRESS_BODY' });
  f.store.enqueue({ conversationId: f.peer.id, senderId: 'legacy-task-source', source: 'task', kind: 'message', recipientIds: ['alice'], content: 'PRIVATE_LEGACY_TASK_BODY' });
  f.store.enqueue({ conversationId: f.otherDirect.id, senderId: 'user', content: 'OTHER_COMPANION_DIRECT_BODY' });
  // A UI placeholder exists before later messages but is published last.
  f.store.settle({ eventId: first.event.id, leaseToken: first.leaseToken, status: 'done', content: 'LATE_PUBLIC_REPLY_BODY' });
  expect(f.store.getMessage(first.event.replyMessageId)!.sequence).toBeLessThan(peer.message.sequence);
  const recent = f.scopes.recentScopes(f.source);
  expect(recent.map(item => [item.conversationId, item.lastMessageId])).toEqual([
    [f.direct.id, first.event.replyMessageId], [f.peer.id, peer.message.id], [f.group.id, group.message.id],
  ]);
  expect(recent[0]).toMatchObject({ kind: 'direct', current: true, senderId: 'alice', senderName: 'alice' });
  expect(recent[1]).toMatchObject({ kind: 'peer', current: false, senderId: 'bob', senderName: 'bob' });
  expect(recent.every((item, index) => !index || item.projectionSequence < recent[index - 1]!.projectionSequence)).toBe(true);
  expect(JSON.stringify(recent)).not.toMatch(/BODY|content|preview|attachments/);
  expect(f.scopes.recentScopes(f.source, { limit: 1 })).toEqual([recent[0]]);
  expect(f.scopes.recentScopes(f.targetSource).map(item => item.conversationId)).toEqual([f.group.id]);
  expect(f.scopes.recentScopes(peer.events[0]!).map(item => item.conversationId)).toEqual([f.peer.id]);
  expect(f.memory.readScoped).not.toHaveBeenCalled(); expect(f.memory.tool).not.toHaveBeenCalled();
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
