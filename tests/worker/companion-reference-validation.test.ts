import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionSourceAccess } from '../../src/companions/source-access';
import { CompanionMemoryProcedureStore } from '../../src/companions/memory-procedure-store';
import { companionsRequestSchema } from '../../src/shared/companions';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import type { CompanionReferenceValidationGroup } from '../../src/shared/companion-reference-validation';

const roots: string[] = [], stores: CompanionsStore[] = [], connections: CompanionConnection[] = [];
afterEach(() => {
  vi.restoreAllMocks(); for (const db of connections.splice(0)) db.close(); for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) { if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('reference-validation-')) throw Error('Unexpected fixture root.'); rmSync(root, { recursive: true, force: true }); }
});
function fixture(procedure = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'reference-validation-')); roots.push(root);
  const filename = path.join(root, 'messages.sqlite'), store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '核对实际资料。', model: '', avatar: 'sister' as const, active: true, proactive: false }))); stores.push(store);
  const db = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(filename); connections.push(db);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, bob = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '核对输入资料并交付经过检查的文件。', replyDirective: 'none' });
  // Coherent same-byte imported revision. The checker must use the real row
  // revision for its header, without inventing revision one for SHA-only input.
  db.prepare('UPDATE messages SET revision=2 WHERE id=?').run(source.id);
  const note = store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: procedure ? 'procedure' : 'episode_memory',
    content: 'PRIVATE_NOTE_PROSE_739：按实际资料完成核对与交付。', tags: [], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }],
    ...(procedure ? { procedure: { applicability: '需要核对输入并交付文件时。', steps: ['核对输入。', '核验交付文件。'], limitations: [],
      verification: { kind: 'artifact_delivery' as const, artifactRequirements: [{ path: 'result.txt', minBytes: 1 }] } } } : {}) } }).memories![0]!;
  const reference = { id: source.id, conversationId: source.conversationId, checksum: createHash('sha256').update(source.content).digest('hex') };
  const group: CompanionReferenceValidationGroup = { ...scope, beforeSequence: source.sequence, sources: [reference], memories: [{ id: note.id, version: note.version }] };
  const validate = (groups: CompanionReferenceValidationGroup[] = [group]) => store.request({ type: 'memory.references.validate', groups });
  return { store, db, scope, bob, source, note, reference, group, validate };
}

it('deduplicates physical rows across exact groups while returning actual metadata rather than message or note bodies', () => {
  const f = fixture(), sql = 'SELECT * FROM messages WHERE id IN(SELECT value FROM json_each(?))'; let reads = 0, rows = 0;
  const prototype = Object.getPrototypeOf(f.db), prepare = prototype.prepare;
  vi.spyOn(prototype, 'prepare').mockImplementation(function(this: CompanionConnection, ...args: unknown[]) {
    const statement = Reflect.apply(prepare, this, args) as ReturnType<CompanionConnection['prepare']>;
    if (args[0] === sql) {
      const all = statement.all; vi.spyOn(statement, 'all').mockImplementation((...bindings: unknown[]) => { const found = Reflect.apply(all, statement, bindings) as unknown[]; reads++; rows += found.length; return found; });
    }
    return statement;
  });
  const get = vi.spyOn(f.store, 'getMessage'), parse = vi.spyOn(JSON, 'parse');
  const response = f.validate([f.group, { ...f.group, sources: [], memories: [{ id: f.note.id, version: f.note.version }] }]);
  expect(companionStorageResponseSchema.safeParse(response).success).toBe(true);
  expect(response.memoryReferenceValidation?.groups.every(group => group.valid)).toBe(true);
  for (const group of response.memoryReferenceValidation!.groups) {
    expect(group.sourceHeaders).toEqual([{ ...f.reference, authorId: 'user', revision: 2 }]);
    expect(group.memoryHeaders[0]).toMatchObject({ id: f.note.id, companionId: 'alice', version: f.note.version, contentRevision: f.note.contentRevision, sources: f.note.sources });
  }
  expect(get).not.toHaveBeenCalled(); expect(reads).toBe(1); expect(rows).toBe(1);
  expect(parse.mock.calls.every(([input]) => typeof input !== 'string' || !input.includes('PRIVATE_NOTE_PROSE_739'))).toBe(true);
  expect(JSON.stringify(response)).not.toMatch(/PRIVATE_NOTE_PROSE_739|核对输入资料并交付经过检查的文件|attachments|segments|procedure/u);
  f.validate(); expect(reads).toBe(2); expect(rows).toBe(2);
  expect(companionsRequestSchema.safeParse({ type: 'memory.references.validate', groups: [f.group] }).success).toBe(false);
});

it.each(['checksum', 'revision', 'room', 'cursor', 'owner', 'version', 'artifact'] as const)('does not merge distinct denied %s expectations into an authorized group', change => {
  const f = fixture(), group = structuredClone(f.group);
  if (change === 'checksum') group.sources.push({ ...f.reference, checksum: '0'.repeat(64) });
  if (change === 'revision') group.sources.push({ ...f.reference, revision: 1 });
  if (change === 'room') group.sources.push({ ...f.reference, conversationId: f.bob.conversationId });
  if (change === 'cursor') group.beforeSequence = f.source.sequence - 1;
  if (change === 'owner') { group.companionId = 'bob'; group.conversationId = f.bob.conversationId; }
  if (change === 'version') group.memories.push({ id: f.note.id, version: f.note.version + 1 });
  if (change === 'artifact') group.memories[0]!.artifactKinds = ['knowledge'];
  const result = f.validate([f.group, group]).memoryReferenceValidation!.groups;
  expect(result[0]!.valid).toBe(true); expect(result[1]).toMatchObject({ valid: false, sourceHeaders: [], memoryHeaders: [] });
});

it('rereads current withdrawal and body authority independently on the next command', () => {
  const f = fixture(); expect(f.validate().memoryReferenceValidation?.groups[0]?.valid).toBe(true);
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  expect(f.validate().memoryReferenceValidation?.groups[0]).toMatchObject({ valid: false, sourceHeaders: [], memoryHeaders: [] });
  expect(f.store.getMessage(f.source.id).content).toBe(f.source.content);
});

it('removes the discarded procedure projection only from descriptors and keeps real memory reads unchanged', () => {
  const f = fixture(true), validation = vi.spyOn(CompanionMemoryProcedureStore.prototype, 'validation');
  const described = f.store.request({ type: 'memory.records.describe', ...f.scope, ids: [f.note.id] }).memoryDescriptors!;
  expect(described[0]).toMatchObject({ id: f.note.id, version: f.note.version, artifactKind: 'procedure' }); expect(validation).not.toHaveBeenCalled();
  expect(f.validate().memoryReferenceValidation?.groups[0]?.valid).toBe(true); expect(validation).not.toHaveBeenCalled();
  expect(f.store.request({ type: 'memory.read', ...f.scope, id: f.note.id }).memoryRead?.memory.procedure).toBeDefined();
  expect(validation).toHaveBeenCalled();
});

it('propagates infrastructure failures and does not leave a physical row window available to later reads', () => {
  const f = fixture(), prototype = Object.getPrototypeOf(f.db), prepare = prototype.prepare;
  const fault = vi.spyOn(prototype, 'prepare').mockImplementation(function(this: CompanionConnection, ...args: unknown[]) {
    if (typeof args[0] === 'string' && args[0].includes("'artifactKind',json_extract(data,'$.artifactKind')")) throw Object.assign(new Error('controlled metadata I/O unavailable'), { code: 'SQLITE_IOERR' });
    return Reflect.apply(prepare, this, args);
  });
  expect(() => f.validate()).toThrow('controlled metadata I/O unavailable'); fault.mockRestore();
  expect(f.validate().memoryReferenceValidation?.groups[0]?.valid).toBe(true);
  const access = new CompanionSourceAccess(f.db, id => f.store.getMessage(id));
  access.withCurrentReferenceRows([f.source.id], () => {
    const source = access.currentSourceRow(f.source.id)!; source.content = 'tampered caller copy';
    expect(access.currentSourceRow(f.source.id)?.content).toBe(f.source.content);
    f.db.prepare('UPDATE messages SET revision=3 WHERE id=?').run(f.source.id);
    expect(access.currentReferenceHeaders(f.scope, [{ ...f.reference, revision: 2 }])).toBeUndefined();
  });
  expect(access.currentReferenceHeaders(f.scope, [{ ...f.reference, revision: 3 }])?.[0]?.revision).toBe(3);
});
