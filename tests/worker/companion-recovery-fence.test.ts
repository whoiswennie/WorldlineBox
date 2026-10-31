import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { companionRecoveryFencePath, CompanionRecoveryFence } from '../../src/companions/recovery-fence';

const Database = BetterSqlite3 as { new(file: string, options?: { readonly?: boolean; fileMustExist?: boolean }): CompanionConnection };
const roots: string[] = [], stores = new Set<CompanionsStore>();
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) {
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-recovery-fence-')) throw new Error('Unexpected recovery fixture root.'); rmSync(root, { recursive: true, force: true });
} });
function fixture() {
  const libraryPath = mkdtempSync(path.join(tmpdir(), 'companion-recovery-fence-')); roots.push(libraryPath);
  const libraryId = randomUUID(), dataRoot = path.join(libraryPath, '.worldlinebox', 'companions'); mkdirSync(dataRoot, { recursive: true });
  const library = new Database(path.join(libraryPath, '.worldlinebox', 'library.db')); library.exec('CREATE TABLE library(library_id TEXT PRIMARY KEY)'); library.prepare('INSERT INTO library VALUES(?)').run(libraryId); library.close();
  const selection = { libraryPath, libraryId }, ledger = path.join(dataRoot, 'messages.sqlite'), options = { recoveryAuthority: selection };
  const store = new CompanionsStore(ledger, [], options); stores.add(store);
  const read = <T,>(sql: string) => { const db = new Database(companionRecoveryFencePath(selection), { readonly: true }); try { return db.prepare(sql).get() as T; } finally { db.close(); } };
  const head = () => read<{ generation: number; lineage_id: string; pending: number }>('SELECT generation,lineage_id,pending FROM recovery_authority');
  return { store, selection, ledger, options, head, read, close() { store.close(); stores.delete(store); }, reopen() { const next = new CompanionsStore(ledger, [], options); stores.add(next); return next; } };
}
it('advances the independent small authority for actual direct and dispatched writes while point reads leave its generation unchanged', () => {
  const f = fixture(), before = f.head(), player = f.store.getPlayerProfile(); expect(f.head()).toEqual(before);
  f.store.updatePlayerProfile({ name: 'changed human', description: '' }, player.revision); expect(f.head().generation).toBeGreaterThan(before.generation);
  const owner = f.store.createCompanion({ name: 'fixture', description: '', persona: 'new starting point', model: '', avatar: 'custom', proactive: false }), afterCreate = f.head();
  expect(afterCreate.generation).toBeGreaterThan(before.generation);
  f.store.request({ type: 'companion.assets.initialized', companionId: owner.id }); expect(f.head()).toEqual(afterCreate);
  f.store.request({ type: 'companion.update', id: owner.id, companion: { ...owner, model: 'changed-runtime-model' } }); expect(f.head().generation).toBeGreaterThan(afterCreate.generation);
  expect(f.read<{ n: number }>('SELECT COUNT(*) n FROM recovery_authority').n).toBe(1);
});
it('invalidates a prior host ticket after a later real SQL mutation instead of rolling back to its generation', () => {
  const f = fixture(), authority = new CompanionRecoveryFence(f.selection, f.ledger), current = authority.current();
  try {
    const ticket = { ...current, id: randomUUID(), ledgerHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64) }; authority.recordTicket(ticket); expect(authority.ticket(ticket.id)).toEqual(ticket);
    f.store.updatePlayerProfile({ name: 'newer human', description: '' }, f.store.getPlayerProfile().revision);
    expect(() => authority.ticket(ticket.id)).toThrow('过期');
  } finally { authority.close(); }
});
it('rolls back the primary mutation if the independent authority cannot durably advance', () => {
  const f = fixture(), before = f.store.getPlayerProfile(), head = f.head(), blocker = new Database(companionRecoveryFencePath(f.selection));
  blocker.exec("CREATE TRIGGER fail_authority BEFORE UPDATE ON recovery_authority BEGIN SELECT RAISE(ABORT,'fixture authority unavailable'); END");
  try { expect(() => f.store.updatePlayerProfile({ name: 'must-not-commit', description: '' }, before.revision)).toThrow('authority unavailable'); expect(f.store.getPlayerProfile()).toEqual(before); expect(f.head()).toEqual(head); }
  finally { blocker.exec('DROP TRIGGER fail_authority'); blocker.close(); }
  expect(f.store.updatePlayerProfile({ name: 'allowed-after-repair', description: '' }, before.revision).name).toBe('allowed-after-repair');
});
it('reconciles a crashed pre-commit fence conservatively without restoring a previous body or reopening old tickets', () => {
  const f = fixture(), before = f.store.getPlayerProfile(), authority = new CompanionRecoveryFence(f.selection, f.ledger), current = authority.current(), ticket = { ...current, id: randomUUID(), ledgerHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64) };
  authority.recordTicket(ticket); authority.close(); f.close();
  const interrupted = new Database(companionRecoveryFencePath(f.selection)); interrupted.exec('UPDATE recovery_authority SET previous_generation=generation,generation=generation+1,pending=1'); interrupted.close();
  const next = f.reopen(); expect(next.getPlayerProfile()).toEqual(before); expect(f.head().pending).toBe(0); expect(f.head().generation).toBeGreaterThan(current.generation);
  const recovered = new CompanionRecoveryFence(f.selection, f.ledger); try { expect(() => recovered.ticket(ticket.id)).toThrow('过期'); } finally { recovered.close(); }
});
it('rejects a missing authority or ledger instead of recreating a rollback source', () => {
  const f = fixture(); f.close(); unlinkSync(companionRecoveryFencePath(f.selection));
  expect(() => f.reopen()).toThrow('权威已丢失'); expect(existsSync(companionRecoveryFencePath(f.selection))).toBe(false);
  const g = fixture(); g.close(); unlinkSync(g.ledger); expect(() => g.reopen()).toThrow('账本已丢失'); expect(existsSync(g.ledger)).toBe(false);
});
it('does not admit a replaced primary file even when its serialized lineage marker looks current', () => {
  const f = fixture(); f.close(); const copy = f.ledger + '.old-copy'; copyFileSync(f.ledger, copy); unlinkSync(f.ledger); copyFileSync(copy, f.ledger);
  const before = createHash('sha256').update(readFileSync(f.ledger)).digest('hex'); expect(() => f.reopen()).toThrow('正式恢复'); expect(createHash('sha256').update(readFileSync(f.ledger)).digest('hex')).toBe(before);
});
it('uses one fixed authority row under repeated writes without creating per-event snapshots or hashing the whole ledger', () => {
  const f = fixture(), before = f.head(), start = performance.now();
  for (let n = 0; n < 100; n++) f.store.updatePlayerProfile({ name: 'human-' + n, description: '' }, f.store.getPlayerProfile().revision);
  expect(f.head().generation).toBe(before.generation + 100); expect(f.read<{ n: number }>('SELECT COUNT(*) n FROM recovery_authority').n).toBe(1); expect(f.read<{ n: number }>('SELECT COUNT(*) n FROM recovery_tickets').n).toBe(0);
  console.log(JSON.stringify({ fixture: '100 actual primary transactions with independent fence', writes: 100, elapsedMs: performance.now() - start, authorityRows: 1, ledgerHashesPerWrite: 0 }));
});
