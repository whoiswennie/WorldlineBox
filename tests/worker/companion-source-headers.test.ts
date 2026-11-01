import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionSourceAccess } from '../../src/companions/source-access';
import { companionsRequestSchema, type CompanionMessage } from '../../src/shared/companions';
import { companionStorageCommandSchema, companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';

const roots: string[] = [], stores: CompanionsStore[] = [], connections: CompanionConnection[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('source-headers-')) throw Error('Unexpected fixture root.');
    rmSync(root, { recursive: true, force: true });
  }
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'source-headers-')); roots.push(root);
  const filename = path.join(root, 'state.sqlite'), store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({
    id, name: id, description: '', persona: '按准确来源作答。', avatar: 'sister' as const, model: '', active: true, proactive: false,
  }))); stores.push(store);
  const db = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(filename); connections.push(db);
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: 'PRIVATE_SOURCE_BODY_724：核验原始资料。', replyDirective: 'none' });
  const headers = (ids = [source.id], extra: { beforeSequence?: number } = {}) => store.request({ type: 'memory.sources.headers', ...scope, ...extra, ids }).memorySourceHeaders!;
  return { store, db, scope, source, headers };
}
function expected(message: CompanionMessage) {
  return { id: message.id, authorId: message.authorId, conversationId: message.conversationId, revision: message.revision,
    checksum: hash(message.content), sequence: message.sequence, kind: message.kind, status: message.status, createdAt: message.createdAt,
    ...(message.worldCreatedAt === undefined ? {} : { worldCreatedAt: message.worldCreatedAt, worldTimeZone: message.worldTimeZone }),
    ...(message.replyToId ? { replyToId: message.replyToId } : {}), ...(message.topicId ? { topicId: message.topicId } : {}),
    memoryEvidenceOnly: !!message.memoryEvidenceOnly, hasWorldObservation: !!message.worldObservation,
    hasAttachments: !!message.attachments.length, hasAction: !!message.actionId };
}

it('returns the exact consumed DTO fields in one bounded physical window without hydrating message bodies', () => {
  const f = fixture(), before = f.store.getMessage(f.source.id), sql = 'SELECT * FROM messages WHERE id IN(SELECT value FROM json_each(?))';
  const prototype = Object.getPrototypeOf(f.db), prepare = prototype.prepare; let batches = 0, rows = 0;
  vi.spyOn(prototype, 'prepare').mockImplementation(function(this: CompanionConnection, ...args: unknown[]) {
    const statement = Reflect.apply(prepare, this, args) as ReturnType<CompanionConnection['prepare']>;
    if (args[0] === sql) {
      const all = statement.all;
      vi.spyOn(statement, 'all').mockImplementation((...bindings: unknown[]) => {
        const found = Reflect.apply(all, statement, bindings) as unknown[]; batches++; rows += found.length; return found;
      });
    }
    return statement;
  });
  const hydrate = vi.spyOn(f.store, 'getMessage');
  expect(f.headers(Array(168).fill(f.source.id))).toEqual({ headers: [expected(before)], unsupportedIds: [] });
  expect(hydrate).not.toHaveBeenCalled(); expect(batches).toBe(1); expect(rows).toBe(1);
  const response = f.store.request({ type: 'memory.sources.headers', ...f.scope, ids: [f.source.id] });
  expect(companionStorageResponseSchema.safeParse(response).success).toBe(true);
  expect(JSON.stringify(response)).not.toContain('PRIVATE_SOURCE_BODY_724'); expect(batches).toBe(2);
  expect(companionStorageCommandSchema.safeParse({ type: 'memory.sources.headers', ...f.scope, ids: Array(1001).fill(f.source.id) }).success).toBe(false);
  expect(companionsRequestSchema.safeParse({ type: 'memory.sources.headers', ...f.scope, ids: [f.source.id] }).success).toBe(false);
});

it('preserves actual revisions, byte changes and separately authorized partial results without a DTO fallback for denied IDs', () => {
  const f = fixture(), foreign = f.store.appendMessage({ conversationId: f.store.openPrivate('bob').id, authorId: 'user', content: '另一私聊。', replyDirective: 'none' });
  f.db.prepare('UPDATE messages SET revision=2 WHERE id=?').run(f.source.id);
  expect(f.headers([f.source.id, foreign.id, 'missing']).headers).toEqual([expected(f.store.getMessage(f.source.id))]);
  expect(f.headers([f.source.id, foreign.id, 'missing']).unsupportedIds).toEqual([]);
  expect(f.headers([f.source.id], { beforeSequence: f.source.sequence - 1 })).toEqual({ headers: [], unsupportedIds: [] });
  f.db.prepare('UPDATE messages SET revision=3,content=? WHERE id=?').run('已经正式改写的来源。', f.source.id);
  expect(f.headers().headers[0]).toMatchObject({ revision: 3, checksum: hash('已经正式改写的来源。') });
  f.db.prepare('UPDATE messages SET revision=0 WHERE id=?').run(f.source.id);
  expect(f.headers()).toEqual({ headers: [], unsupportedIds: [f.source.id] });
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  expect(f.headers()).toEqual({ headers: [], unsupportedIds: [] });
});

it('keeps live membership and transitive formal source withdrawal checks on every later request', () => {
  const f = fixture(), readset = captureCompanionExecutionReadset(f.scope, { sources: [{ id: f.source.id, conversationId: f.source.conversationId, checksum: hash(f.source.content) }] });
  const derived = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '根据准确来源形成的正式答复。', replyToId: f.source.id, executionReadset: readset });
  expect(f.headers([derived.id]).headers[0]).toEqual(expected(f.store.getMessage(derived.id)));
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  expect(f.headers([derived.id, f.source.id])).toEqual({ headers: [], unsupportedIds: [] });
  f.db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(f.scope.conversationId, f.scope.companionId);
  expect(() => f.headers()).toThrow();
});

it('marks actual attachments for the original DTO path while binding current topic, reply and timestamps', () => {
  const f = fixture();
  f.store.registerAttachment({ attachment: { id: 'document_file', name: '核对.txt', mime: 'text/plain', size: 7 }, relativePath: 'attachments/document_file.txt' });
  const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '包含附件的请求。',
    attachmentIds: ['document_file'], replyToId: f.source.id, replyDirective: 'none' });
  expect(f.headers([source.id]).headers[0]).toEqual(expected(f.store.getMessage(source.id)));
  expect(f.headers([source.id]).headers[0]).toMatchObject({ hasAttachments: true, replyToId: f.source.id });
  f.db.prepare('UPDATE companion_message_times SET world_at=?,time_zone=? WHERE message_id=?').run('2026-11-01T00:00:00.000Z', 'UTC', source.id);
  expect(f.headers([source.id]).headers[0]).toEqual(expected(f.store.getMessage(source.id)));
});

it.each([undefined, null, false, 0, '', {}, []])('keeps unsupported observation projections on the old typed DTO/error path (%j)', observation => {
  const f = fixture(), message = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'system', kind: 'notice', content: '实际观察。', replyDirective: 'none' });
  f.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('memory-world-observation/' + message.id, JSON.stringify({
    companionId: f.scope.companionId, forConversationId: f.scope.conversationId, throughSequence: message.sequence,
    checksum: hash(message.content), sources: [], ...(observation === undefined ? {} : { observation }),
  }));
  f.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('message-memory-evidence/' + message.id, '{}');
  new CompanionSourceAccess(f.db, id => f.store.getMessage(id)).observe(message.id, f.scope.companionId);
  if (observation === undefined) expect(f.headers([message.id]).headers[0]).toEqual(expected(f.store.getMessage(message.id)));
  else expect(f.headers([message.id])).toEqual({ headers: [], unsupportedIds: [message.id] });
});

it('returns an actual typed observation flag and does not disguise damaged observation metadata as absent', () => {
  const f = fixture(), message = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'system', kind: 'notice', content: '真实宿主观察。', replyDirective: 'none' });
  const metadata = { companionId: f.scope.companionId, forConversationId: f.scope.conversationId, throughSequence: message.sequence,
    checksum: hash(message.content), sources: [], observation: { category: 'contacts', observedAt: message.createdAt, observedAtVirtual: message.createdAt, internalized: false } };
  f.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('memory-world-observation/' + message.id, JSON.stringify(metadata));
  new CompanionSourceAccess(f.db, id => f.store.getMessage(id)).observe(message.id, f.scope.companionId);
  expect(f.headers([message.id]).headers[0]).toEqual(expected(f.store.getMessage(message.id)));
  f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run('damaged JSON', 'memory-world-observation/' + message.id);
  expect(() => f.store.request({ type: 'memory.sources.filter', ...f.scope, ids: [message.id] })).toThrow();
  expect(() => f.headers([message.id])).toThrow();
});

it('propagates a deep SQLite availability failure and releases the strict read window afterward', () => {
  const f = fixture(), access = new CompanionSourceAccess(f.db, id => f.store.getMessage(id));
  const prototype = Object.getPrototypeOf(f.db), prepare = prototype.prepare;
  const failure = vi.spyOn(prototype, 'prepare').mockImplementation(function(this: CompanionConnection, ...args: unknown[]) {
    if (typeof args[0] === 'string' && args[0].includes('SELECT 1 FROM vcp_source_observers'))
      throw Object.assign(new Error('controlled deep observer read unavailable'), { code: 'SQLITE_IOERR' });
    return Reflect.apply(prepare, this, args);
  });
  expect(() => f.db.transaction(() => access.sourceHeaders(f.scope, [f.source.id]))()).toThrow('deep observer read unavailable');
  failure.mockRestore();
  expect(f.headers().headers[0]).toEqual(expected(f.store.getMessage(f.source.id)));
});
