import { createHash } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { captureCompanionExecutionReadset, verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { createCompanionExecutionValidationSession, guardCompanionExecutionSources } from '../../src/main/companions/source-execution-evidence';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const f = managedMemoryFiles(); fixtures.push(f);
  const sql = (operation: (db: CompanionConnection) => void) => {
    const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
    db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens); db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
    try { operation(db); } finally { db.close(); }
  };
  const valid = vi.fn(async () => true), identity = {}, storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => f.store.request(command));
  const request = async (command: CompanionStorageCommand) => guardCompanionExecutionSources(command, await storage(command), { storage, valid, identity, revision: () => 0 });
  return { f, sql, valid, storage, request };
}

it('admits predicate-only source and memory roots in one batch without reading their bodies through the old DTO ports', async () => {
  const h = fixture(), source = h.f.source('准确来源。'), note = h.f.record('准确记忆。', [source.id]), session = createCompanionExecutionValidationSession();
  try {
    const readset = captureCompanionExecutionReadset(h.f.scope, { sources: [{ id: source.id, conversationId: source.conversationId, checksum: hash(source.content) }], memories: [{ id: note.id, version: note.version }] });
    expect(await session.run(() => verifyCompanionExecutionReadset(readset, h.f.scope, { request: h.request }))).toBe(true);
    const calls = h.storage.mock.calls.map(([command]) => command);
    expect(calls.filter(command => command.type === 'memory.references.validate')).toHaveLength(1);
    expect(calls.some(command => command.type === 'memory.records.describe' || command.type === 'memory.sources.filter')).toBe(false);
    expect(calls.find(command => command.type === 'execution.sources')).toMatchObject({ sourceMessageIds: [source.id], memoryIds: [note.id] });
    await session.validate();
    expect(h.storage.mock.calls.filter(([command]) => command.type === 'memory.references.validate')).toHaveLength(2);
  } finally { session.close(); }
});

it.each(['bytes', 'revision', 'member', 'forget'] as const)('keeps fresh final SQL authority after a predicate read when %s changes', async kind => {
  const h = fixture(), source = h.f.source('最终仍需准确的来源。'), session = createCompanionExecutionValidationSession();
  const readset = captureCompanionExecutionReadset(h.f.scope, { sources: [{ id: source.id, conversationId: source.conversationId, checksum: hash(source.content) }] });
  try {
    expect(await session.run(() => verifyCompanionExecutionReadset(readset, h.f.scope, { request: h.request }))).toBe(true);
    if (kind === 'forget') h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [source.id] });
    else h.sql(db => {
      if (kind === 'member') db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(source.conversationId, 'alice');
      else db.prepare(`UPDATE messages SET ${kind === 'bytes' ? 'content=?,revision=revision+1' : 'revision=revision+1'} WHERE id=?`).run(...(kind === 'bytes' ? ['篡改正文。', source.id] : [source.id]));
    });
    await expect(session.validate()).rejects.toThrow();
  } finally { session.close(); }
});

it.each([
  { mode: 'source-only', mutation: 'revision' }, { mode: 'note-only', mutation: 'revision' },
  { mode: 'source-only', mutation: 'body' }, { mode: 'note-only', mutation: 'body' },
] as const)('binds $mode headers to the exact formal candidate before accepting a same-ID $mutation race', async ({ mode, mutation }) => {
  const h = fixture(), raw = h.f.source('原始事实。'), readset = captureCompanionExecutionReadset(h.f.scope, { sources: [{ id: raw.id, conversationId: raw.conversationId, checksum: hash(raw.content) }] });
  const formal = h.f.store.appendMessage({ conversationId: h.f.scope.conversationId, authorId: 'alice', content: '已经正式发生的答复。', executionReadset: readset });
  const note = mode === 'note-only' ? h.f.record('记下这条正式答复。', [formal.id]) : undefined;
  const command: CompanionStorageCommand = { type: 'memory.references.validate', groups: [{ ...h.f.scope, sources: mode === 'source-only' ? [{ id: formal.id, conversationId: formal.conversationId, checksum: hash(formal.content) }] : [], memories: note ? [{ id: note.id, version: note.version }] : [] }] };
  const response = await h.storage(command), session = createCompanionExecutionValidationSession();
  h.sql(db => {
    if (mutation === 'body') db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('同ID已改写的正式正文。', formal.id);
    else db.prepare('UPDATE messages SET revision=revision+1 WHERE id=?').run(formal.id);
  });
  try {
    await expect(session.run(() => guardCompanionExecutionSources(command, response, { storage: h.storage, valid: h.valid, identity: {}, revision: () => 0 }))).rejects.toThrow('准确版本');
    expect(h.valid).not.toHaveBeenCalled();
  } finally { session.close(); }
});

it('still executes the full Main verifier for a formal header and rejects missing header substitutions', async () => {
  const h = fixture(), readset = captureCompanionExecutionReadset(h.f.scope), formal = h.f.store.appendMessage({ conversationId: h.f.scope.conversationId,
    authorId: 'alice', content: '正式正文。', executionReadset: readset });
  const command: CompanionStorageCommand = { type: 'memory.references.validate', groups: [{ ...h.f.scope, sources: [{ id: formal.id, conversationId: formal.conversationId, checksum: hash(formal.content) }], memories: [] }] };
  const raw = h.f.store.request(command), session = createCompanionExecutionValidationSession();
  h.valid.mockResolvedValue(false);
  try {
    const response = await session.run(() => h.request(command));
    expect(h.valid).toHaveBeenCalled(); expect(response.memoryReferenceValidation?.groups[0]?.valid).toBe(false);
    expect(response.memoryReferenceValidation?.groups[0]?.sourceHeaders).toEqual([]);
  } finally { session.close(); }
  raw.memoryReferenceValidation!.groups[0]!.sourceHeaders = [];
  await expect(guardCompanionExecutionSources(command, raw, { storage: h.storage, valid: h.valid })).rejects.toThrow('完整凭证');
});
