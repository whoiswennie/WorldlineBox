import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionMemoryManagementSearch } from '../../src/main/companions/memory-management-search';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { VcpMemoryNote, VcpMemoryScope } from '../../src/main/vcp-memory/contracts';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { nativeManagementHarness } from '../fixtures/vcp-management-native';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const roots: string[] = [], stores: CompanionsStore[] = [], managers: CompanionMemoryManagementSearch[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('vcp-management-search-')) throw new Error('Unsafe cleanup.');
    await removeOwnedDirectory(root);
  }
});
class OrchestrationClient extends VcpMemoryClient {
  readonly indices = new Map<string, Map<string, VcpMemoryNote>>();
  readonly residents = new Set<string>();
  hold?: { started: () => void; reject: (error: Error) => void };
  constructor() { super({ dataRoot: 'unused', vendorRoot: 'unused', workerPath: 'unused', embedding: { baseUrl: 'http://127.0.0.1/unused', model: 'fixture', dimension: 4, apiKey: '' } }); }
  override hasOpenScope = (scope: VcpMemoryScope) => this.residents.has(scope.scopeId);
  override remember = vi.fn(async (scope: VcpMemoryScope, note: VcpMemoryNote) => {
    this.residents.add(scope.scopeId);
    if (this.hold) {
      const hold = this.hold; hold.started();
      await new Promise<void>((_resolve, reject) => { hold.reject = reject; });
    }
    const index = this.indices.get(scope.scopeId) ?? new Map<string, VcpMemoryNote>();
    index.set(note.id, structuredClone(note)); this.indices.set(scope.scopeId, index);
    return { id: note.id, indexed: true as const };
  });
  override read = vi.fn(async (scope: VcpMemoryScope, id: string) => { this.residents.add(scope.scopeId); return this.indices.get(scope.scopeId)?.get(id) ?? null; });
  override search = vi.fn(async (scope: VcpMemoryScope, query: { text: string; topK?: number }) => ({ results: [...(this.indices.get(scope.scopeId)?.values() ?? [])]
    .filter(note => note.content.includes(query.text)).slice(0, query.topK).map(note => ({ ...structuredClone(note), score: .9, engine: 'river' as const, sourceFile: 'native-fixture/' + note.id + '.md' })), diagnostics: {}, degraded: false }));
  override interruptScope = vi.fn(async (scope: VcpMemoryScope) => { this.residents.delete(scope.scopeId); this.hold?.reject(new Error('Interrupted')); this.hold = undefined; });
  override purgeScope = vi.fn(async (scope: VcpMemoryScope) => { this.residents.delete(scope.scopeId); this.indices.delete(scope.scopeId); });
  override close = vi.fn(async () => undefined);
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'vcp-management-search-')); roots.push(root);
  const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '合成测试人格。', description: '', avatar: 'sister', model: '', proactive: false, active: true }));
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds); stores.push(store);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, client = new OrchestrationClient(), report = vi.fn();
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => store.request(command));
  const make = (requestStorage = request) => {
    const manager = new CompanionMemoryManagementSearch({ requestStorage, runtime: { get: async () => ({ client, profileKey: 'global-fixture' }), close: client.close },
      cacheRoot: path.join(root, 'management'), batchSize: 8, report });
    managers.push(manager); return manager;
  };
  const ready = async (manager: CompanionMemoryManagementSearch, query = '记录') => {
    let result = await manager.search('alice', query, 100);
    await vi.waitFor(async () => { result = await manager.search('alice', query, 100); expect(result.state, report.mock.calls.map(([error]) => String(error)).join('\n')).toBe('ready'); }, { timeout: 15000, interval: 20 });
    return result;
  };
  return { root, store, scope, client, request, make, ready, report };
}

it('builds fenced pages once, queries every indexed note beyond the UI page, and consumes only added notes afterward', async () => {
  const f = fixture();
  for (let n = 0; n < 40; n++) f.store.saveMemory({ ...f.scope, content: `完整记录${n}。`, diaryName: n % 2 ? '资料' : '日记' });
  const manager = f.make(); expect((await manager.search('alice', '记录', 10)).state).toBe('building');
  expect((await f.ready(manager)).hits).toHaveLength(40); expect(f.client.remember).toHaveBeenCalledTimes(40);
  const pageCalls = f.request.mock.calls.filter(([command]) => command.type === 'memory.library.index-page').length;
  for (const query of ['记录39', '记录1', '记录20']) expect((await manager.search('alice', query, 10)).hits.length).toBeGreaterThan(0);
  expect(f.client.remember).toHaveBeenCalledTimes(40);
  expect(f.request.mock.calls.filter(([command]) => command.type === 'memory.library.index-page')).toHaveLength(pageCalls);
  const scopes = new Set(f.client.remember.mock.calls.map(([scope]) => scope.scopeId));
  f.store.saveMemory({ ...f.scope, content: '新增记录40。', diaryName: '新日记本' });
  expect((await f.ready(manager)).hits).toHaveLength(41); expect(f.client.remember).toHaveBeenCalledTimes(41);
  expect(new Set(f.client.remember.mock.calls.map(([scope]) => scope.scopeId))).toEqual(scopes);
});

it('reuses a completed index across restart and warms an evicted worker without re-embedding the corpus', async () => {
  const f = fixture(); f.store.saveMemory({ ...f.scope, content: '重启保留的记录。' });
  const first = f.make(); await f.ready(first); await first.close();
  const count = f.client.remember.mock.calls.length, next = f.make();
  expect((await f.ready(next)).hits).toHaveLength(1); expect(f.client.remember).toHaveBeenCalledTimes(count);
  f.client.residents.clear(); expect((await next.search('alice', '记录', 10)).state).toBe('building');
  expect((await f.ready(next)).hits).toHaveLength(1); expect(f.client.remember).toHaveBeenCalledTimes(count);
  expect(f.client.close).not.toHaveBeenCalled();
});

it('indexes the actual owner name and rebuilds a renamed owner instead of reusing the application identity', async () => {
  const f = fixture(); f.store.saveMemory({ ...f.scope, content: '只属于小肥鱼的记录。' });
  const before = f.store.state().companions.find(owner => owner.id === 'alice')!;
  f.store.updateCompanion(before.id, { ...before, name: '小肥鱼' });
  const manager = f.make(); await f.ready(manager);
  expect(f.client.remember.mock.calls[0]![1]).toMatchObject({ author: '小肥鱼', metadata: { hostMemoryOwner: { companionId: 'alice', name: '小肥鱼' } } });
  const oldScope = f.client.remember.mock.calls[0]![0].scopeId;
  const current = f.store.state().companions.find(owner => owner.id === 'alice')!;
  f.store.updateCompanion(current.id, { ...current, name: '小肥鱼改名' });
  await f.ready(manager);
  expect(f.client.purgeScope).toHaveBeenCalledWith(expect.objectContaining({ scopeId: oldScope }));
  expect(f.client.remember.mock.calls.at(-1)![1]).toMatchObject({ author: '小肥鱼改名', metadata: { hostMemoryOwner: { companionId: 'alice', name: '小肥鱼改名' } } });
  expect(f.client.remember.mock.calls.every(([, note]) => note.author !== 'WorldlineBox')).toBe(true);
});

it('rebuilds physical scopes after revision or source retraction and never returns old owner-wide hits', async () => {
  const f = fixture(), initial = f.store.saveMemory({ ...f.scope, content: '旧秘密记录。' }), manager = f.make();
  await f.ready(manager); const old = f.client.remember.mock.calls[0]![0].scopeId;
  const revised = f.store.saveMemory({ ...f.scope, id: initial.id, expectedVersion: initial.version, content: '新的记录。' });
  expect((await f.ready(manager, '新的')).hits).toEqual([{ noteId: revised.id, version: revised.version }]);
  expect(f.client.purgeScope).toHaveBeenCalledWith(expect.objectContaining({ scopeId: old }));
  expect((await manager.search('alice', '旧秘密', 10)).hits).toEqual([]);
  f.store.request({ type: 'memory.library.delete', companionId: 'alice', id: revised.id, expectedVersion: revised.version });
  expect((await f.ready(manager, '记录')).hits).toEqual([]);
});

it('keeps witnessed group history in owner management after leaving while separating other owners', async () => {
  const f = fixture(), group = f.store.createConversation('真实群范围', ['alice', 'bob']);
  const groupNote = f.store.saveMemory({ companionId: 'alice', conversationId: group.id, content: '群里的记录。' });
  const bob = f.store.saveMemory({ companionId: 'bob', conversationId: f.store.openPrivate('bob').id, content: 'Bob的私密记录。' });
  const manager = f.make(); const first = await f.ready(manager);
  expect(first.hits).toEqual([{ noteId: groupNote.id, version: 1 }]); expect(first.hits.some(hit => hit.noteId === bob.id)).toBe(false);
  const epoch = f.store.request({ type: 'memory.library.index-state', companionId: 'alice' }).memoryLibraryIndexState!.resetRevision;
  f.store.updateConversation(group.id, { memberIds: ['bob'] });
  expect(f.store.request({ type: 'memory.library.index-state', companionId: 'alice' }).memoryLibraryIndexState!.resetRevision).toBeGreaterThan(epoch);
  expect((await f.ready(manager)).hits).toEqual([{ noteId: groupNote.id, version: 1 }]);
  expect(f.store.request({ type: 'memory.library.read', companionId: 'alice', id: groupNote.id }).memoryRead?.memory.id).toBe(groupNote.id);
});

it('does not release a stale native hit when forgetting happens during the query', async () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: 'FORGOTTEN_NATIVE_RECORD记录。' }), manager = f.make(); await f.ready(manager);
  const original = f.client.search.getMockImplementation()!;
  f.client.search.mockImplementationOnce(async (...args) => { const response = await original(...args); f.store.request({ type: 'memory.library.delete', companionId: 'alice', id: note.id, expectedVersion: note.version }); return response; });
  const result = await manager.search('alice', '记录', 10);
  expect(result.hits).toEqual([]); expect(JSON.stringify(result)).not.toContain('FORGOTTEN_NATIVE_RECORD');
});

it('rejects stale source epochs during bootstrap and immediately interrupts an in-flight write on close', async () => {
  const f = fixture(), note = f.store.saveMemory({ ...f.scope, content: '待建立的记录。' });
  const state = f.store.request({ type: 'memory.library.index-state', companionId: 'alice' }).memoryLibraryIndexState!;
  f.store.saveMemory({ ...f.scope, id: note.id, expectedVersion: 1, content: '变更后的记录。' });
  expect(() => f.store.request({ type: 'memory.library.index-page', companionId: 'alice', resetRevision: state.resetRevision, throughOrdinal: state.throughOrdinal, limit: 8 })).toThrow(/来源或权限/u);
  let started = false;
  f.client.hold = { started: () => { started = true; }, reject: () => undefined };
  const manager = f.make(); await manager.search('alice', '记录', 10);
  await vi.waitFor(() => expect(started).toBe(true));
  await manager.close(); expect(f.client.interruptScope).toHaveBeenCalled(); expect(f.client.close).not.toHaveBeenCalled();
});

it('runs the original native owner-management corpus across real notebook and source domains without rereading journals on every query', async () => {
  const f = fixture(), group = f.store.createConversation('真实合成群', ['alice', 'bob']);
  const privateNote = f.store.saveMemory({ ...f.scope, content: 'group0 私聊里借给我的蓝色雨伞。', diaryName: '日记', tags: ['group0'] });
  const groupNote = f.store.saveMemory({ companionId: 'alice', conversationId: group.id, content: 'group1 群里讨论阳台植物的浇水。', diaryName: '植物资料', tags: ['group1'] });
  f.store.saveMemory({ companionId: 'bob', conversationId: f.store.openPrivate('bob').id, content: 'group0 Bob的私密内容不能进Alice索引。' });
  const native = await nativeManagementHarness(f.root, f.request), manager = native.makeManager(); managers.push(manager);
  try {
    let result = await manager.search('alice', 'group0', 20);
    await vi.waitFor(async () => { result = await manager.search('alice', 'group0', 20); expect(result.state, native.errors.map(String).join('\n')).toBe('ready'); }, { timeout: 30000, interval: 50 });
    expect(result.hits).toContainEqual({ noteId: privateNote.id, version: privateNote.version });
    expect(result.indexed).toBe(2);
    expect((await manager.search('alice', 'group1', 20)).hits).toContainEqual({ noteId: groupNote.id, version: groupNote.version });
    const before = native.audit(), documentInputs = native.embeddingRequests.filter(request => request.path.startsWith('/document/')).flatMap(request => request.input).length;
    const pages = f.request.mock.calls.filter(([command]) => command.type === 'memory.library.index-page').length;
    for (let n = 0; n < 4; n++) await manager.search('alice', `group${n % 2}`, 20);
    expect(native.audit()).toEqual(before);
    expect(native.embeddingRequests.filter(request => request.path.startsWith('/document/')).flatMap(request => request.input)).toHaveLength(documentInputs);
    expect(f.request.mock.calls.filter(([command]) => command.type === 'memory.library.index-page')).toHaveLength(pages);
    await manager.close();
  } finally { await manager.close(); await native.close(); }
});
