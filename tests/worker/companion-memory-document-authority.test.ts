import BetterSqlite3 from 'better-sqlite3';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMemoryStore } from '../../src/companions/memory-store';
import { CompanionSourceAccess } from '../../src/companions/source-access';
import type { CompanionConnection } from '../../src/companions/store';
import { companionMemoryDescriptorSchema } from '../../src/shared/companion-memory';
import { companionMemoryDocumentAuthorityCommandSchema, type CompanionMemoryDocumentAuthorityCommand } from '../../src/shared/companion-memory-document-authority';
import { companionMemorySnapshotRevisionsCommandSchema, companionMemorySnapshotRevisionScopeKey, normalizeCompanionMemorySnapshotRevisionScope } from '../../src/shared/companion-memory-snapshot-revisions';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { companionsRequestSchema } from '../../src/shared/companions';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [], connections: CompanionConnection[] = [];
const fixture = () => { const f = managedMemoryFiles(); fixtures.push(f); return f; };
afterEach(async () => { vi.restoreAllMocks(); for (const db of connections.splice(0)) db.close(); for (const f of fixtures.splice(0)) await f.close(); });

async function inputs() {
  const f = fixture(), first = f.source('First actual source.'), second = f.source('Second actual source.');
  const a = f.record('First canonical experience.', [first.id]), b = f.record('Second canonical experience.', [second.id]);
  await f.publish();
  const scope = { ...f.scope, contentKinds: ['episode_memory' as const] };
  const snapshot = f.store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!;
  const command: CompanionMemoryDocumentAuthorityCommand = { type: 'memory.documents.authority', companionId: f.scope.companionId,
    noteIds: [a.id, b.id], navigation: [{ scope, expectedRevision: snapshot.semanticRevision ?? snapshot.revision }],
    history: { conversationId: f.scope.conversationId, roots: [{ id: a.id, contentRevision: a.contentRevision! }, { id: b.id, contentRevision: b.contentRevision! }] },
    sources: { conversationId: f.scope.conversationId, ids: [first.id, second.id] } };
  return { f, first, second, a, b, scope, snapshot, command };
}

it('preserves the four original current, complete-history, source and exact navigation results in one real SQL read', async () => {
  const { f, command, scope, snapshot } = await inputs();
  const notes = f.store.request({ type: 'memory.library.read-many', companionId: command.companionId, ids: command.noteIds }).memories!;
  const history = f.store.request({ type: 'memory.revisions.describe', companionId: command.companionId, ...command.history! }).memoryHistoryDescriptors!;
  const sources = f.store.request({ type: 'memory.sources.headers', companionId: command.companionId, ...command.sources! }).memorySourceHeaders!;
  const packet = f.store.request(command);
  expect(packet.ok).toBe(true); expect(packet.memories).toEqual(notes); expect(packet.memoryHistoryDescriptors).toEqual(history);
  expect(packet.memorySourceHeaders).toEqual(sources); expect(packet.memorySources).toBeUndefined();
  expect(packet.memoryDocumentAuthority?.navigation).toEqual([{ scope: normalizeCompanionMemorySnapshotRevisionScope(scope),
    expectedRevision: snapshot.semanticRevision, valid: true, matches: true, revision: snapshot.revision, semanticRevision: snapshot.semanticRevision }]);
  expect(packet.memorySnapshotRevisions?.groups).toEqual([{ scope: normalizeCompanionMemorySnapshotRevisionScope(scope), valid: true,
    revision: snapshot.revision, semanticRevision: snapshot.semanticRevision, memories: snapshot.notes.map(note => companionMemoryDescriptorSchema.parse(note)) }]);
});

it('keeps different room and cursor qualifications independent and exposes no unmatched-navigation source descriptors', async () => {
  const { f, second, scope, snapshot } = await inputs();
  const early = { ...scope, beforeSequence: second.sequence - 1 }, late = { ...scope, beforeSequence: second.sequence };
  const earlySnapshot = f.store.request({ type: 'memory.snapshot', ...early }).memorySnapshot!, lateSnapshot = f.store.request({ type: 'memory.snapshot', ...late }).memorySnapshot!;
  const denied = { ...scope, conversationId: f.store.openPrivate('bob').id };
  const command: CompanionMemoryDocumentAuthorityCommand = { type: 'memory.documents.authority', companionId: 'alice', noteIds: [], navigation: [
    { scope: early, expectedRevision: earlySnapshot.semanticRevision! }, { scope: late, expectedRevision: lateSnapshot.semanticRevision! },
    { scope, expectedRevision: 'outdated-navigation-revision' }, { scope: denied, expectedRevision: snapshot.semanticRevision! }] };
  const result = f.store.request(command);
  expect(result.memoryDocumentAuthority!.navigation.map(item => item.matches)).toEqual([true, true, false, false]);
  const groups = new Map(result.memorySnapshotRevisions!.groups.map(group => [companionMemorySnapshotRevisionScopeKey(group.scope), group]));
  expect(groups.get(companionMemorySnapshotRevisionScopeKey(early))?.memories).toHaveLength(1);
  expect(groups.get(companionMemorySnapshotRevisionScopeKey(late))?.memories).toHaveLength(2);
  expect(groups.get(companionMemorySnapshotRevisionScopeKey(scope))).toMatchObject({ valid: false, memories: [] });
  expect(groups.get(companionMemorySnapshotRevisionScopeKey(denied))).toMatchObject({ valid: false, memories: [] });
  expect(result.memories).toEqual([]);
});

it('preserves the existing 256-entry page capability while calculating one normalized scope only once', async () => {
  const { f, a, scope, snapshot } = await inputs(), actual = CompanionMemoryStore.prototype.snapshot;
  const read = vi.spyOn(CompanionMemoryStore.prototype, 'snapshot').mockImplementation(function(this: CompanionMemoryStore, value) { return actual.call(this, value); });
  const command: CompanionMemoryDocumentAuthorityCommand = { type: 'memory.documents.authority', companionId: 'alice',
    noteIds: [a.id, ...Array.from({ length: 255 }, (_, n) => `missing_${n}`)],
    navigation: Array.from({ length: 256 }, (_, n) => ({ scope, expectedRevision: n ? `old_revision_${n}` : snapshot.semanticRevision! })) };
  const result = f.store.request(command);
  expect(result.memories?.map(note => note.id)).toEqual([a.id]); expect(result.memoryDocumentAuthority?.navigation).toHaveLength(256);
  expect(result.memoryDocumentAuthority!.navigation.filter(item => item.matches)).toHaveLength(1);
  expect(result.memorySnapshotRevisions?.groups).toHaveLength(1); expect(read).toHaveBeenCalledOnce();
  expect(companionMemoryDocumentAuthorityCommandSchema.safeParse({ ...command, noteIds: [...command.noteIds, 'too_many'] }).success).toBe(false);
});

it('keeps a page with more than one hundred unique exact scopes valid on the private wire without enlarging the original command', async () => {
  const { f, scope, snapshot } = await inputs();
  const navigation: CompanionMemoryDocumentAuthorityCommand['navigation'] = [{ scope, expectedRevision: snapshot.semanticRevision! },
    ...Array.from({ length: 105 }, (_, n) => ({ scope: { ...scope, beforeSequence: n + 10 }, expectedRevision: 'outdated-navigation' }))];
  const result = f.store.request({ type: 'memory.documents.authority', companionId: 'alice', noteIds: [], navigation });
  expect(result.memoryDocumentAuthority?.navigation).toHaveLength(106);
  expect(result.memorySnapshotRevisions?.groups).toHaveLength(106);
  expect(result.memorySnapshotRevisions!.groups.filter(group => group.valid)).toHaveLength(1);
  expect(companionStorageResponseSchema.safeParse(result).success).toBe(true);
  expect(companionMemorySnapshotRevisionsCommandSchema.safeParse({ type: 'memory.snapshot.revisions', scopes: navigation.slice(0, 101).map(item => item.scope) }).success).toBe(false);
});

it('shares exact current message rows physically across all page components, then starts fresh on the next command', async () => {
  const { f, first, second, command } = await inputs();
  const db = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite')); connections.push(db);
  const statement = db.prepare('SELECT 1'), prototype = Object.getPrototypeOf(statement) as { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown };
  const get = prototype.get, all = prototype.all, direct: string[] = [], batches: string[][] = [];
  vi.spyOn(prototype, 'get').mockImplementation(function(this: object, ...args: unknown[]) {
    if (Reflect.get(this, 'source') === 'SELECT * FROM messages WHERE id=?' && [first.id, second.id].includes(String(args[0]))) direct.push(String(args[0]));
    return Reflect.apply(get, this, args);
  });
  vi.spyOn(prototype, 'all').mockImplementation(function(this: object, ...args: unknown[]) {
    if (Reflect.get(this, 'source') === 'SELECT * FROM messages WHERE id IN(SELECT value FROM json_each(?))') batches.push(JSON.parse(String(args[0])));
    return Reflect.apply(all, this, args);
  });
  expect(f.store.request(command).memoryDocumentAuthority?.navigation[0]?.matches).toBe(true);
  expect(direct).toEqual([]); expect(batches).toEqual([[first.id, second.id]]);
  const fresh = f.store.request(command);
  expect(fresh.memoryDocumentAuthority?.navigation[0]?.matches).toBe(true);
  expect(direct).toEqual([]); expect(batches).toEqual([[first.id, second.id], [first.id, second.id]]);
});

it('does not let a mutable returned packet alter a later page, or reuse authority after a real forget', async () => {
  const { f, first, a, command } = await inputs();
  const packet = f.store.request(command); packet.memories![0]!.content = 'Caller-only mutation.';
  packet.memorySourceHeaders!.headers[0]!.checksum = '0'.repeat(64);
  expect(f.store.request(command).memories?.find(note => note.id === a.id)?.content).toBe(a.content);
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [first.id] });
  const after = f.store.request({ ...command, history: undefined });
  expect(after.memories?.some(note => note.id === a.id)).toBe(false);
  expect(after.memorySourceHeaders?.headers.some(header => header.id === first.id)).toBe(false);
  expect(after.memoryDocumentAuthority?.navigation[0]?.matches).toBe(false);
  expect(() => f.store.request(command)).toThrow(/历史|撤回|读取/u);
});

it.each(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR_READ'] as const)('propagates %s from the current-note visibility gate without claiming a missing note', async code => {
  const { f, a } = await inputs(), error = Object.assign(new Error('Controlled page storage availability.'), { code });
  vi.spyOn(CompanionSourceAccess.prototype, 'visible').mockImplementation(() => { throw error; });
  expect(() => f.store.request({ type: 'memory.documents.authority', companionId: 'alice', noteIds: [a.id], navigation: [] })).toThrow(error);
});

it('keeps ordinary missing or denied notes filtered and rejects foreign-owner or public command claims', async () => {
  const { f, a, command } = await inputs();
  expect(f.store.request({ type: 'memory.documents.authority', companionId: 'alice', noteIds: ['missing'], navigation: [] }).memories).toEqual([]);
  vi.spyOn(CompanionSourceAccess.prototype, 'visible').mockImplementation(() => false);
  expect(f.store.request({ type: 'memory.documents.authority', companionId: 'alice', noteIds: [a.id], navigation: [] }).memories).toEqual([]);
  expect(companionMemoryDocumentAuthorityCommandSchema.safeParse({ ...command, companionId: 'bob' }).success).toBe(false);
  expect(companionsRequestSchema.safeParse(command).success).toBe(false);
});
