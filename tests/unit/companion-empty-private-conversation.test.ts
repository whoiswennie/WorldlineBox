import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const seeds: CompanionSeed[] = [{ id: 'alice', name: 'Alice', description: 'Current owner', persona: 'Current persona',
  model: '', avatar: 'sister', proactive: false }];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'wlb-empty-private-'));
  const file = path.join(root, 'messages.sqlite'), store = new CompanionsStore(file, seeds), db = new (Database as { new(filename: string): CompanionConnection })(file);
  cleanups.push(() => { db.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  const room = store.openPrivate('alice'), owner = store.state().companions.find(item => item.id === 'alice')!;
  const updatedAt = '2026-01-01T00:00:00.000Z';
  db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(updatedAt, room.id);
  return { db, store, room, owner, updatedAt };
}

it('reads an empty private conversation after owner retirement without restoring owner access', () => {
  const f = fixture();
  f.db.prepare('UPDATE companions SET deleted_at=? WHERE id=?').run('2026-02-01T00:00:00.000Z', 'alice');
  const state = f.store.state();
  expect(state.companions.some(owner => owner.id === 'alice')).toBe(false);
  expect(state.conversations.find(room => room.id === f.room.id)).toMatchObject({ id: f.room.id, title: f.room.title,
    updatedAt: f.updatedAt, lastMessage: '' });
  expect(() => f.store.openPrivate('alice')).toThrow(/不存在|移除/u);
});

it('keeps the strict live owner timestamp for an empty private conversation and rejects corrupt owner data', () => {
  const f = fixture();
  expect(f.store.state().conversations.find(room => room.id === f.room.id)?.updatedAt).toBe(f.owner.createdAt);
  // Exclude the owner-list projection so the private-room read itself must
  // still reach the original strict owner decoder rather than hide its error.
  f.db.prepare('UPDATE companions SET data=? WHERE id=?').run('{invalid-json', 'alice');
  expect(() => f.store.state(false, { companionId: 'other_owner' })).toThrow(SyntaxError);
});
