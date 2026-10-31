import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { CompanionConnection } from '../../src/companions/store';
import { afterEach, expect, it, vi } from 'vitest';
import { finalizeCognitionFixture } from '../fixtures/cognition-fixture-finalization';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

type FixtureDatabase = CompanionConnection & { readonly open: boolean };
const Database = BetterSqlite3 as { new(filename: string): FixtureDatabase };
const fixtures: Array<{ root: string; evidence: string; db: FixtureDatabase }> = [];
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldline-cognition-multi-soak-'));
  const evidence = mkdtempSync(path.join(tmpdir(), 'worldline-cognition-finalization-evidence-'));
  const file = path.join(root, 'messages.sqlite'), db = new Database(file);
  db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0');
  db.exec('CREATE TABLE originals(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,content TEXT NOT NULL)');
  db.prepare('INSERT INTO originals VALUES(?,?,?)').run('original-event', 1, 'ORIGINAL_EVENT_MUST_SURVIVE_FAILED_QA');
  const line = JSON.stringify({ id: 'original-event', revision: 1, contentHash: digest('ORIGINAL_EVENT_MUST_SURVIVE_FAILED_QA') }) + '\n';
  const ledger = path.join(root, 'append-receipts.jsonl'); writeFileSync(ledger, line);
  const peer = path.join(evidence, 'unrelated-peer.txt'); writeFileSync(peer, 'UNRELATED_PEER_BYTES');
  const cleanup = vi.fn(async (target: string) => {
    if (target !== root || path.dirname(target) !== tmpdir() || !path.basename(target).startsWith('worldline-cognition-multi-soak-')) throw new Error('Unexpected cleanup target');
    await removeOwnedDirectory(target);
  });
  const item = { root, evidence, db }; fixtures.push(item);
  expect(existsSync(file + '-wal')).toBe(true);
  return { ...item, file, ledger, line, peer, cleanup, receiptFile: path.join(evidence, 'run.retained-fixture.json') };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    if (f.db.open) f.db.close();
    for (const target of [f.root, f.evidence]) {
      if (path.dirname(target) !== tmpdir() || !/^worldline-cognition-(?:multi-soak-|finalization-evidence-)/u.test(path.basename(target))) throw new Error('Unexpected test cleanup scope');
      await removeOwnedDirectory(target);
    }
  }
});

it('retains actual committed SQLite/WAL and raw receipts when the original observation gate fails', async () => {
  const f = fixture(), original = new Error('Original predeclared observation interval expired.');
  const result = await finalizeCognitionFixture({ root: f.root, receiptFile: f.receiptFile, verifiedSuccess: false, primaryFailure: original,
    knownExit: { code: null, signal: 'SIGTERM', childPid: 42 }, cleanup: f.cleanup,
    preserveLedger: () => copyFile(f.ledger, path.join(f.evidence, 'saved-append-receipts.jsonl')) });
  expect(result).toMatchObject({ retained: true, reason: 'unverified_or_failed', root: f.root }); expect(f.cleanup).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT * FROM originals').get()).toEqual({ id: 'original-event', revision: 1, content: 'ORIGINAL_EVENT_MUST_SURVIVE_FAILED_QA' });
  expect(existsSync(f.file + '-wal')).toBe(true); expect(readFileSync(f.ledger, 'utf8')).toBe(f.line);
  expect(await readFile(path.join(f.evidence, 'saved-append-receipts.jsonl'), 'utf8')).toBe(f.line);
  expect(JSON.parse(await readFile(f.receiptFile, 'utf8'))).toMatchObject({ root: f.root, verifiedSuccess: false, cleanupSkipped: true,
    primaryFailure: { message: original.message }, knownExit: { signal: 'SIGTERM', childPid: 42 } });
  expect(readFileSync(f.peer, 'utf8')).toBe('UNRELATED_PEER_BYTES');
});

it('does not replace the primary failure or delete raw SQLite/WAL when receipt preservation itself throws', async () => {
  const f = fixture(), original = new Error('Original gate remains authoritative.'), preserve = vi.fn(async () => { throw new Error('Injected receipt sink failure.'); });
  const run = async () => { try { throw original; } finally { await finalizeCognitionFixture({ root: f.root, receiptFile: f.receiptFile,
    verifiedSuccess: false, primaryFailure: original, cleanup: f.cleanup, preserveLedger: preserve }); } };
  await expect(run()).rejects.toBe(original); expect(preserve).toHaveBeenCalledTimes(1); expect(f.cleanup).not.toHaveBeenCalled();
  const receipt = JSON.parse(await readFile(f.receiptFile, 'utf8'));
  expect(receipt).toMatchObject({ root: f.root, reason: 'ledger_preservation_failed', cleanupSkipped: true,
    primaryFailure: { message: original.message }, ledgerPreservationError: { message: 'Injected receipt sink failure.' } });
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM originals').get()).toEqual({ count: 1 });
  expect(existsSync(f.file + '-wal')).toBe(true); expect(readFileSync(f.ledger, 'utf8')).toBe(f.line); expect(readFileSync(f.peer, 'utf8')).toBe('UNRELATED_PEER_BYTES');
});

it('cleans only the verified successful fixture after authentic ledger preservation and leaves its external peer intact', async () => {
  const f = fixture();
  // Real validation is completed before the caller grants cleanup permission.
  expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(f.db.prepare('SELECT revision,content FROM originals WHERE id=?').get('original-event')).toEqual({ revision: 1, content: 'ORIGINAL_EVENT_MUST_SURVIVE_FAILED_QA' });
  expect(digest(readFileSync(f.ledger, 'utf8'))).toBe(digest(f.line)); f.db.close();
  const preserved = path.join(f.evidence, 'verified-append-receipts.jsonl');
  const result = await finalizeCognitionFixture({ root: f.root, receiptFile: f.receiptFile, verifiedSuccess: true, knownExit: { code: 0 }, cleanup: f.cleanup,
    preserveLedger: async () => { await copyFile(f.ledger, preserved); expect(await readFile(preserved, 'utf8')).toBe(f.line); } });
  expect(result).toEqual({ retained: false, reason: 'verified_success', root: f.root }); expect(f.cleanup).toHaveBeenCalledExactlyOnceWith(f.root);
  expect(existsSync(f.root)).toBe(false); expect(existsSync(f.receiptFile)).toBe(false);
  expect(await readFile(preserved, 'utf8')).toBe(f.line); expect(readFileSync(f.peer, 'utf8')).toBe('UNRELATED_PEER_BYTES');
});
