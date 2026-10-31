import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { recordSourceBackedMemory } from '../fixtures/source-backed-memory';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'wlb-recall-authority-'));
  const filename = path.join(root, 'state.sqlite');
  const store = new CompanionsStore(filename, [{ id: 'alice', name: 'Alice', description: '', persona: 'Read real sources.', avatar: 'sister', proactive: false, model: '' }]);
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const authority = () => store.request({ type: 'memory.recall.authority', companionId: 'alice' }).memoryRecallAuthorityStamp;
  const corpus = () => store.request({ type: 'memory.corpus.stamp', companionId: 'alice' }).memoryCorpusStamp;
  return { store, filename, scope, authority, corpus };
}

it('does not withdraw a captured result for same-host memory additions and index publication', () => {
  const f = fixture(), authority = f.authority(), corpus = f.corpus();
  expect(authority).toBeTruthy();
  recordSourceBackedMemory(f.store, { ...f.scope, content: '约定周三归还雨伞。' });
  expect(f.corpus()).not.toBe(corpus);
  expect(f.authority()).toBe(authority);
  const delivery = f.store.request({ type: 'memory.outbox.claim', companionId: 'alice', leaseMs: 120000 }).memoryOutbox;
  expect(delivery).toBeTruthy();
  f.store.request({ type: 'memory.outbox.complete', id: delivery!.id, leaseToken: delivery!.leaseToken!, indexed: true });
  expect(f.authority()).toBe(authority);
});

it('withdraws authority for a hard source revocation and rejects a deleted owner', () => {
  const f = fixture();
  const note = recordSourceBackedMemory(f.store, { ...f.scope, content: '约定周三归还雨伞。' });
  const authority = f.authority();
  f.store.request({ type: 'memory.forget', ...f.scope, id: note.id });
  expect(f.authority()).not.toBe(authority);
  f.store.deleteCompanion('alice');
  expect(() => f.authority()).toThrow();
});

it('fails closed after an external database writer changes state without host provenance', () => {
  const f = fixture(), authority = f.authority();
  const external = new (Database as unknown as new (filename: string) => CompanionConnection)(f.filename);
  try { external.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('external-test', 'changed'); }
  finally { external.close(); }
  expect(f.authority()).not.toBe(authority);
});
