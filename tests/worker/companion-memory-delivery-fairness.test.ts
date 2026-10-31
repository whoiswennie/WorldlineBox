import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import type { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import { canonicalMemoryFiles } from '../fixtures/canonical-memory-files';
import { recordSourceBackedMemory } from '../fixtures/source-backed-memory';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const seeds: CompanionSeed[] = ['alice', 'bob', 'cara', 'dora', 'erin'].map(id => ({ id, name: id,
  description: '', persona: '独立的合成验收伙伴。', model: '', avatar: 'sister', active: true, proactive: false }));
async function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-delivery-fairness-')), file = path.join(root, 'state.sqlite');
  const store = new CompanionsStore(file, seeds);
  const rooms = new Map(seeds.map(owner => [owner.id, store.openPrivate(owner.id).id]));
  const files = await canonicalMemoryFiles(root, store, { apiFormat: 'openai_chat', model: '', apiKey: '' });
  const write = (owner: string, count: number) => Array.from({ length: count }, (_, index) => recordSourceBackedMemory(store, {
    companionId: owner, conversationId: rooms.get(owner)!, content: `${owner}的有来源合成记录${index}。`, tags: ['手工标签'], autoTags: false }));
  const cleanup = async () => {
    await files.close();
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-delivery-fairness-')) throw Error('Unexpected fixture directory.');
    removeOwnedDirectorySync(root);
  };
  return { store, file, rooms, write, cleanup, request: files.request };
}
it('continues a new ordinary invocation with explicit pending recall while an unavailable index leaves active searches blocked', async () => {
  const f = await makeFixture(), [queued] = f.write('alice', 1), scope = { companionId: 'alice', conversationId: f.rooms.get('alice')! };
  const source = f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '先回应这次当前来信。', replyDirective: 'none' });
  const state = f.store.state(true), companion = state.companions.find(owner => owner.id === 'alice')!, conversation = state.conversations.find(room => room.id === scope.conversationId)!;
  const fetchFn = vi.fn<typeof fetch>(), onPrepared = vi.fn(async () => undefined), report = vi.fn();
  const config = { apiFormat: 'openai_chat' as const, model: 'synthetic', apiKey: 'fixture' };
  const service = new CompanionMemoryService({ request: f.request, configFor: async () => config,
    fetchFn, busy: () => true, changed: () => undefined, report });
  try {
    const result = await service.recall({ companion, conversation, currentMessage: source, messages: [source], config,
      recovery: { taskKey: 'a'.repeat(64), isCurrent: async () => true, onPrepared } });
    expect(result).toEqual({ memories: [], sources: [], reasons: [], pending: true, degraded: true });
    expect(result.context).toBeUndefined(); expect(onPrepared).not.toHaveBeenCalled(); expect(fetchFn).not.toHaveBeenCalled();
    expect(f.store.request({ type: 'memory.outbox.pending', companionId: 'alice' }).memoryOutboxPending).toBe(true);
    expect(f.store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.pendingIndex).toBe(1);
    expect(f.store.listMemory('alice')[0]!.id).toBe(queued!.id);
    await expect(service.search({ ...scope, query: '需要查询记忆', limit: 12 })).rejects.toMatchObject({ code: 'MEMORY_INDEX_PENDING' });
    expect(report).not.toHaveBeenCalled();
  } finally { await service.close(); f.store.close(); await f.cleanup(); }
});
it('readies only the queried owner while a peer index is blocked and a concurrent fair pump shares its lease registry', async () => {
  const f = await makeFixture(); f.write('alice', 1); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), starts: string[] = [], errors: unknown[] = [];
  const client = (owner: string) => ({ remember: async () => { starts.push(owner); if (owner === 'alice') await held; return { id: 'fixture', indexed: true }; },
    interruptScope: async () => undefined }) as unknown as VcpMemoryClient;
  const clients = new Map(seeds.map(owner => [owner.id, client(owner.id)])), request = vi.fn((command: CompanionStorageCommand) => f.request(command));
  const service = new CompanionMemoryService({ request, runtime: { get: async ({ ownerId }) => ({ client: clients.get(ownerId!)!, profileKey: 'fixture' }), close: async () => undefined },
    configFor: async () => ({ apiFormat: 'openai_chat', model: '', apiKey: '' }), fetchFn: async () => { throw Error('No model calls.'); }, busy: () => true, changed: () => undefined, report: error => errors.push(error) });
  try {
    await (service as unknown as { deliver(): Promise<void> }).deliver(); await vi.waitFor(() => expect(starts).toEqual(['alice']));
    f.write('bob', 1);
    await Promise.all([service.drainOwnerDeliveries('bob'), (service as unknown as { deliver(): Promise<void> }).deliver()]);
    expect(starts.filter(owner => owner === 'bob')).toHaveLength(1);
    expect(f.store.request({ type: 'memory.status', companionId: 'bob' }).memoryStatus?.indexed).toBe(1);
    expect(f.store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.indexed).toBe(0);
    expect(request.mock.calls.some(([command]) => command.type === 'memory.snapshot' || command.type === 'memory.status')).toBe(false);
    expect(errors).toEqual([]);
  } finally { release(); await service.close(); f.store.close(); await f.cleanup(); }
});

it('keeps bounded foreground waits explicit while durable indexing and the four-owner limit continue in the background', async () => {
  const f = await makeFixture(); for (const owner of seeds) f.write(owner.id, 1);
  const releases = new Map<string, () => void>(), held = new Map(seeds.slice(0, 4).map(owner => [owner.id, new Promise<void>(resolve => releases.set(owner.id, resolve))]));
  let active = 0, peak = 0;
  const clients = new Map(seeds.map(owner => [owner.id, { remember: async () => { active++; peak = Math.max(peak, active); try { await held.get(owner.id); return { id: 'fixture', indexed: true }; } finally { active--; } },
    interruptScope: async () => undefined } as unknown as VcpMemoryClient]));
  const service = new CompanionMemoryService({ request: f.request, runtime: { get: async ({ ownerId }) => ({ client: clients.get(ownerId!)!, profileKey: 'fixture' }), close: async () => undefined },
    configFor: async () => ({ apiFormat: 'openai_chat', model: '', apiKey: '' }), fetchFn: async () => { throw Error('No model calls.'); }, busy: () => true, changed: () => undefined, report: () => undefined });
  try {
    await (service as unknown as { deliver(): Promise<void> }).deliver(); await vi.waitFor(() => expect(active).toBe(4));
    await expect(service.drainOwnerDeliveries('erin', { budgetMs: 20 })).rejects.toMatchObject({ code: 'MEMORY_INDEX_PENDING' });
    expect(f.store.request({ type: 'memory.outbox.pending', companionId: 'erin' }).memoryOutboxPending).toBe(true);
    expect(active).toBe(4); releases.get('alice')!();
    await vi.waitFor(() => expect(f.store.request({ type: 'memory.status', companionId: 'erin' }).memoryStatus?.indexed).toBe(1));
    expect(peak).toBeLessThanOrEqual(4);
  } finally { for (const release of releases.values()) release(); await service.close(); f.store.close(); await f.cleanup(); }
});

it('continues other owners and capture admission while one native indexing request stays unresolved', async () => {
  const f = await makeFixture(), errors: unknown[] = [], starts: string[] = [];
  // Alice has the oldest and largest queue. Global FIFO cannot service Erin
  // until Alice releases; the actual service must not await Alice here.
  f.write('alice', 12); for (const owner of seeds.slice(1)) f.write(owner.id, 3);
  let releaseAlice!: () => void;
  const blocked = new Promise<void>(resolve => { releaseAlice = resolve; });
  let active = 0, peak = 0;
  const activeOwners = new Set<string>();
  const client = (owner: string) => ({
    remember: vi.fn(async () => {
      expect(activeOwners.has(owner)).toBe(false); activeOwners.add(owner);
      active++; peak = Math.max(peak, active); starts.push(owner);
      try { if (owner === 'alice') await blocked; else await new Promise(resolve => setTimeout(resolve, 2)); }
      finally { active--; activeOwners.delete(owner); }
      return { id: 'fixture', indexed: true };
    }),
    interruptScope: async () => undefined,
  }) as unknown as VcpMemoryClient;
  const clients = new Map(seeds.map(owner => [owner.id, client(owner.id)]));
  const request = vi.fn((command: CompanionStorageCommand) => f.request(command));
  const service = new CompanionMemoryService({ request, runtime: {
    get: async ({ ownerId }) => ({ client: clients.get(ownerId!)!, profileKey: 'controlled-native-indexing' }), close: async () => undefined },
    configFor: async () => ({ apiFormat: 'openai_chat', model: '', apiKey: '' }),
    fetchFn: async () => { throw Error('This mechanism fixture must not request a model.'); },
    busy: () => true, changed: () => undefined, report: error => errors.push(error) });
  try {
    await (service as unknown as { deliver(): Promise<void> }).deliver();
    await vi.waitFor(() => expect(f.store.request({ type: 'memory.status', companionId: 'erin' }).memoryStatus!.indexed).toBe(3));
    expect(f.store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus!.indexed).toBe(0);
    expect(starts.filter(owner => owner === 'alice')).toHaveLength(1);
    expect(peak).toBeLessThanOrEqual(4);
    // The capture/continuity coordinator can complete an ordinary check even
    // while native delivery remains held. No empty model config is invoked.
    await (service as unknown as { process(): Promise<void> }).process();
    expect(request.mock.calls.some(([command]) => command.type === 'state' && command.activeOnly)).toBe(true);
    releaseAlice(); await service.drainDeliveries();
    for (const owner of seeds) expect(f.store.request({ type: 'memory.status', companionId: owner.id }).memoryStatus!.pendingIndex).toBe(0);
    // This delivery-only transport deliberately supplies no model/timeline
    // route. An ordinary coordinator pass may report that exact unavailable
    // optional route; indexing and queue admission must still have progressed.
    expect(errors.every(error => error instanceof Error && error.message === '原生时间线未连接此伙伴的模型路由。')).toBe(true);
  } finally { releaseAlice(); await service.close(); f.store.close(); await f.cleanup(); }
});

it('keeps least-served owner order across SQLite restart and respects exclusions and live scope leases', async () => {
  const f = await makeFixture(); let store = f.store;
  try {
    f.write('alice', 12); f.write('bob', 2); f.write('cara', 2);
    const alice = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
    expect(alice.companionId).toBe('alice');
    const bob = store.request({ type: 'memory.outbox.claim', excludedOwners: ['alice'] }).memoryOutbox!;
    expect(bob.companionId).toBe('bob');
    store.request({ type: 'memory.outbox.complete', id: alice.id, leaseToken: alice.leaseToken, indexed: true });
    store.request({ type: 'memory.outbox.complete', id: bob.id, leaseToken: bob.leaseToken, indexed: true });
    store.close(); store = new CompanionsStore(f.file, seeds);
    const cara = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
    expect(cara.companionId).toBe('cara');
    const next = store.request({ type: 'memory.outbox.claim', excludedOwners: ['alice', 'bob'] }).memoryOutbox;
    expect(next).toBeUndefined(); // Cara's exact graph already has a lease.
    store.request({ type: 'memory.outbox.complete', id: cara.id, leaseToken: cara.leaseToken, indexed: true });
    expect(store.request({ type: 'memory.outbox.claim' }).memoryOutbox!.companionId).toBe('alice');
  } finally { store.close(); await f.cleanup(); }
});
