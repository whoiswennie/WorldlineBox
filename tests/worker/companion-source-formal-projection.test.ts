import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionConnection } from '../../src/companions/store';
import { currentPublishedSourceCutValid } from '../../src/companions/published-dependency-index';
import { captureCompanionExecutionReadset, verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { guardCompanionExecutionSources, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import type { CompanionMessagePublicationCandidate, CompanionMessagePublicationMode } from '../../src/shared/companion-message-publication';

const fixtures: Array<{ close(): Promise<void>; db: CompanionConnection }> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const value of fixtures.splice(0)) { value.db.close(); await value.close(); } });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Row = Record<string, string | number | null>;

async function fixture(certify = true) {
  const f = managedMemoryFiles(), db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  fixtures.push({ close: f.close, db });
  const source = f.source('这是一条仍有读取权限的真实原始消息。'), topicId = source.topicId!;
  const current = f.store.request({ type: 'topic.read', conversationId: f.scope.conversationId, topicId, readerId: 'alice' });
  const updated = f.store.request({ type: 'topic.update', conversationId: f.scope.conversationId, topicId, readerId: 'alice',
    expectedRevision: current.topic!.revision, patch: { workingState: { summary: '通过正式入口发布的当前讨论检查点。', sourceMessageIds: [source.id] } } });
  const readset = captureCompanionExecutionReadset(f.scope, { context: { user: JSON.stringify({ topic: updated.topic, topicState: updated.topicState }) },
    sources: [{ id: source.id, conversationId: source.conversationId, checksum: hash(source.content) }] });
  expect(readset.complete).toBe(true); expect(readset.topics).toHaveLength(1);
  const message = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '根据这条消息及正式讨论状态作出的回答。', executionReadset: readset });
  const key = 'message-execution-readset/' + message.id;
  const read = () => f.store.request({ type: 'memory.sources.headers', ...f.scope, ids: [message.id] }).memorySourceHeaders!;
  const actual = () => db.prepare('SELECT * FROM messages WHERE id=?').get(message.id) as Row;
  const candidate = () => f.store.request({ type: 'execution.sources', sourceMessageIds: [message.id] }).executionSources!.find(value => value.id === message.id)!;
  if (certify) {
    const minted = vi.fn(async (messages: readonly (CompanionMessagePublicationCandidate & { mode: CompanionMessagePublicationMode })[]) => {
      expect(f.store.request({ type: 'execution.message.certify', messages: [...messages] }).ok).toBe(true);
    });
    const result = await withCompanionExecutionValidation(() => guardCompanionExecutionSources({ type: 'message.get', id: message.id },
      f.store.request({ type: 'message.get', id: message.id }), { identity: f.store, storage: f.request, revision: () => 0,
        valid: (proof, sqliteSourcesValidated, publishedFileContexts) => verifyCompanionExecutionReadset(proof.executionReadset, proof,
          { request: f.request, sqliteSourcesValidated, publishedFileContexts }), certifyPublications: minted }));
    expect(result.message?.content).toBe(message.content); expect(minted).toHaveBeenCalledOnce();
    expect(candidate().publicationCertificate).toBeDefined();
  }
  return { f, db, source, message, topicId, readset, key, read, actual, candidate };
}

function observeRootReads(db: CompanionConnection, key: string) {
  const prototype = Object.getPrototypeOf(db.prepare('SELECT 1')), original = prototype.get;
  let reads = 0;
  const spy = vi.spyOn(prototype, 'get').mockImplementation(function (this: object, ...args: unknown[]) {
    if (Reflect.get(this, 'source') === 'SELECT value FROM metadata WHERE key=?' && args[0] === key) reads++;
    return Reflect.apply(original, this, args);
  });
  return { count: () => reads, restore: () => spy.mockRestore() };
}

it('uses the fresh SQL projection in the actual Store source-header path after all-final Main certification of a primary discussion checkpoint', async () => {
  const h = await fixture(), stored = (h.db.prepare('SELECT value FROM metadata WHERE key=?').get(h.key) as { value: string }).value;
  expect(currentPublishedSourceCutValid(h.db, h.actual())).toBe(true);
  const old = observeRootReads(h.db, h.key), parsed = vi.spyOn(JSON, 'parse');
  expect(h.read().headers.map(value => value.id)).toEqual([h.message.id]);
  expect(old.count()).toBe(0); expect(parsed.mock.calls.some(([value]) => value === stored)).toBe(false);
  parsed.mockRestore(); old.restore();
  // Formal admission is a boolean projection only; the separate Main proof
  // protocol still returns the complete typed input and exact root binding.
  expect(h.candidate().executionReadset).toEqual(h.readset);
});

it('retains the complete historical validator when no Main certificate exists', async () => {
  const h = await fixture(false), old = observeRootReads(h.db, h.key);
  expect(currentPublishedSourceCutValid(h.db, h.actual())).toBe(false);
  expect(h.read().headers.map(value => value.id)).toEqual([h.message.id]); expect(old.count()).toBeGreaterThan(0);
});

it.each(['incomplete', 'cycle', 'removed-certificate'] as const)('falls back to the original readset gate after a current %s change', async change => {
  const h = await fixture(), proof = structuredClone(h.readset);
  if (change === 'removed-certificate') h.db.prepare('DELETE FROM companion_message_publication_certificates WHERE message_id=?').run(h.message.id);
  else {
    if (change === 'incomplete') proof.complete = false;
    else proof.sources.push({ id: h.message.id, conversationId: h.message.conversationId, checksum: hash(h.message.content) });
    h.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(proof), h.key);
  }
  expect(currentPublishedSourceCutValid(h.db, h.actual())).toBe(false);
  const old = observeRootReads(h.db, h.key), result = h.read(); expect(old.count()).toBeGreaterThan(0);
  expect(result.headers.map(value => value.id)).toEqual(change === 'removed-certificate' ? [h.message.id] : []);
});

it('keeps reader, cursor, withdrawal and loop-status admission after formal projection succeeds', async () => {
  const h = await fixture(); expect(h.read().headers).toHaveLength(1);
  expect(h.f.store.request({ type: 'memory.sources.headers', ...h.f.scope, beforeSequence: h.source.sequence, ids: [h.message.id] }).memorySourceHeaders!.headers).toEqual([]);
  h.db.prepare('DELETE FROM vcp_source_observers WHERE message_id=? AND companion_id=?').run(h.message.id, 'alice');
  expect(h.read().headers).toEqual([]);
  h.db.prepare('INSERT INTO vcp_source_observers(message_id,companion_id) VALUES(?,?)').run(h.message.id, 'alice');
  expect(h.read().headers).toHaveLength(1);
  h.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('message-loop/' + h.message.id, JSON.stringify({ status: 'thinking', sourceMessageId: h.source.id }));
  expect(h.read().headers).toEqual([]);
  h.db.prepare('DELETE FROM metadata WHERE key=?').run('message-loop/' + h.message.id);
  expect(h.read().headers).toHaveLength(1);
  h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [h.source.id], persistent: true });
  expect(h.read().headers).toEqual([]);
});

it('propagates SQL unavailability from the projection without withdrawing the still-valid source', async () => {
  const h = await fixture(), prototype = Object.getPrototypeOf(h.db.prepare('SELECT 1')), original = prototype.get;
  const failure = Object.assign(new Error('controlled SQL availability failure'), { code: 'SQLITE_IOERR' });
  const spy = vi.spyOn(prototype, 'get').mockImplementation(function (this: object, ...args: unknown[]) {
    if (Reflect.get(this, 'source') === 'SELECT generation FROM companion_published_authority_generation WHERE id=1') throw failure;
    return Reflect.apply(original, this, args);
  });
  expect(() => h.read()).toThrow(failure); spy.mockRestore();
  expect(h.db.prepare('SELECT value FROM metadata WHERE key=?').get('execution-source-invalid/message/' + h.message.id)).toBeUndefined();
  expect(h.read().headers).toHaveLength(1);
});
