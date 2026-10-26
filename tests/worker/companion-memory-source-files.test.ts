import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemorySourceFiles, companionMemorySourceFilePath } from '../../src/main/companions/memory-source-files';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

const fixtures: Array<{ root: string; store: CompanionsStore; library: CompanionMemoryLibrary }> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.library.close(); f.store.close(); removeOwnedDirectorySync(f.root); } });
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-memory-source-files-')), scope = { companionId: 'alice', conversationId: 'private_alice' };
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '只保留自己获权的真实来源。', model: '', avatar: 'sister' as const, active: true, proactive: false })));
  scope.conversationId = store.openPrivate('alice').id;
  let beforeComplete: (() => void) | undefined;
  const request = async (command: CompanionStorageCommand) => {
    if (command.type === 'memory.sources.outbox.complete' && beforeComplete) { const hook = beforeComplete; beforeComplete = undefined; hook(); }
    return store.request(command);
  };
  const directory = path.join(root, '伙伴记忆'), library = new CompanionMemoryLibrary({ libraryDirectory: directory, request }), files = new CompanionMemorySourceFiles({ library });
  fixtures.push({ root, store, library });
  // Source/history delivery never creates an owner namespace. Production Main
  // initializes the canonical role before starting these durable publishers.
  await library.withDocuments('alice', async () => undefined, { readOnly: true });
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: 'ACTUAL_RAW_SOURCE_包含摘要未保留的原始条件、否定和细节。', replyDirective: 'none' });
  const note = store.request({ type: 'memory.record', ...scope, candidate: { content: '仅是原文的短摘要。', tags: ['来源核验'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const reference = note.sources[0]!, relative = companionMemorySourceFilePath({ sourceId: source.id, sourceRevision: reference.revision, sourceChecksum: reference.checksum });
  return { root, scope, store, library, files, source, note, reference, file: path.join(directory, 'alice', ...relative.split('/')),
    beforeComplete: (hook: () => void) => { beforeComplete = hook; } };
}

it('publishes immutable owner-local actual originals and never re-learns their directory as a new diary', async () => {
  const f = await fixture(); expect(await f.files.flush('alice')).toMatchObject({ completed: 1, pending: false });
  expect(readFileSync(f.file, 'utf8')).toBe(f.source.content); expect(readFileSync(f.file + '.meta.json', 'utf8')).toContain(f.reference.checksum);
  expect(await f.files.read(f.scope, f.reference)).toBe(f.source.content);
  const before = f.store.listMemory('alice').length; await f.library.sync(); expect(f.store.listMemory('alice')).toHaveLength(before);
  expect((await f.files.flush('alice')).completed).toBe(0);
  await expect(f.files.read({ companionId: 'bob', conversationId: f.store.openPrivate('bob').id }, f.reference)).rejects.toThrow();
});

it('withdraws exact archived source files and metadata through a durable retract without scanning another owner', async () => {
  const f = await fixture(); await f.files.flush('alice');
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  expect(await f.files.flush('alice')).toMatchObject({ completed: 1 });
  expect(existsSync(f.file)).toBe(false); expect(existsSync(f.file + '.meta.json')).toBe(false);
  await expect(f.files.read(f.scope, f.reference)).rejects.toThrow('撤回');
});

it('rechecks the lease after file publication and removes bytes if authorization changed during the write', async () => {
  const f = await fixture(); f.beforeComplete(() => f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] }));
  await f.files.flush('alice'); expect(existsSync(f.file)).toBe(false); expect(existsSync(f.file + '.meta.json')).toBe(false);
});

it('rejects edited raw copies instead of falling back to authoritative SQL or admitting forged memory', async () => {
  const f = await fixture(); await f.files.flush('alice'); writeFileSync(f.file, 'FORGED_SOURCE_MUST_NOT_REPLACE_ACTUAL_BYTES');
  await expect(f.files.read(f.scope, f.reference)).rejects.toThrow('不使用SQL');
  expect(f.store.getMessage(f.source.id).content).toBe(f.source.content);
  const before = f.store.listMemory('alice').length; await f.library.sync(); expect(f.store.listMemory('alice')).toHaveLength(before);
});

it('admits inactive pending owners and retracts originals even while their prompt profile is malformed', async () => {
  const f = await fixture();
  f.store.request({ type: 'companion.set-active', id: 'alice', active: false });
  expect(f.store.request({ type: 'memory.sources.outbox.owners', limit: 4 }).memorySourcePendingOwners).toContain('alice');
  expect(await f.files.flushPending(async command => f.store.request(command))).toMatchObject({ owners: 1, completed: 1 });
  await f.library.sync();
  writeFileSync(path.join(f.root, '伙伴记忆', 'alice', 'profile.md'), 'malformed profile does not suspend source revocation');
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  expect(await f.files.flushPending(async command => f.store.request(command))).toMatchObject({ owners: 1, completed: 1 });
  expect(existsSync(f.file)).toBe(false);
});

it('recovers a durable claimed publication immediately after the owned SQLite process restarts', async () => {
  const f = await fixture(), claimed = f.store.request({ type: 'memory.sources.outbox.claim', companionId: 'alice', leaseMs: 600000 }).memorySourceOutbox!;
  expect(claimed.operation).toBe('publish'); await f.library.close(); f.store.close();
  const store = new CompanionsStore(path.join(f.root, 'state.sqlite'), []), library = new CompanionMemoryLibrary({ libraryDirectory: path.join(f.root, '伙伴记忆'), request: async command => store.request(command) });
  const owned = fixtures.find(item => item.root === f.root)!; owned.store = store; owned.library = library;
  const publisher = new CompanionMemorySourceFiles({ library });
  expect(await publisher.flushPending(async command => store.request(command))).toMatchObject({ owners: 1, completed: 1 });
  expect(readFileSync(f.file, 'utf8')).toBe(f.source.content);
  expect(() => store.request({ type: 'memory.sources.outbox.complete', id: claimed.id, leaseToken: claimed.leaseToken })).toThrow('租约');
});
