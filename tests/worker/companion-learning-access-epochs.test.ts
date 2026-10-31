import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import { holdRestoredCompanionWork } from '../../src/companions/recovery-hold';
import type { CompanionJobDisposition, CompanionJobPage } from '../../src/shared/companion-job-control';

const seeds = ['alice', 'bob'].map(id => ({ id, name: id, persona: '保留准确来源。', description: '', model: '', avatar: 'sister' as const, active: true, proactive: false }));
let root: string, filename: string, store: CompanionsStore, db: CompanionConnection;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-29T10:00:00Z'); root = mkdtempSync(path.join(tmpdir(), 'learning-access-epochs-'));
  filename = path.join(root, 'state.sqlite'); store = new CompanionsStore(filename, seeds); db = new (Database as { new(filename: string): CompanionConnection })(filename); });
afterEach(() => { db.close(); store.close(); vi.useRealTimers(); if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('learning-access-epochs-')) throw new Error('Unexpected fixture root.'); removeOwnedDirectorySync(root); });
const inspect = (id: string) => store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'learning', id }).jobDisposition!;
const control = (job: CompanionJobDisposition, action: 'park' | 'resume' | 'abandon') => store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'learning', id: job.id,
  inputVersion: job.inputVersion, expectedRevision: job.revision, action, operationId: randomUUID() }).jobDisposition!;
const grant = (owner = 'alice') => store.request({ type: 'learning.grant', companionId: owner, libraryId: 'actual-authorized-host-library', libraryName: '准确资料范围', libraryPath: root, autonomous: true, intervalMinutes: 30 }).learning!.grants[0]!;
function begin(grantId: string, owner = 'alice') {
  const current = store.request({ type: 'learning.status', companionId: owner }).learning!.grants.find(item => item.id === grantId)!;
  store.request({ type: 'learning.run', companionId: owner, id: current.id, expectedRevision: current.revision });
  const lease = store.request({ type: 'learning.claim', excludedOwners: [owner === 'alice' ? 'bob' : 'alice'] }).learningJob!;
  const disposition = store.request({ type: 'learning.begin', id: lease.id, leaseToken: lease.leaseToken, assetId: 'same-actual-file', assetRevisionId: 'unchanged-byte-revision', offset: 0 }).jobDisposition!;
  return { lease, disposition };
}
function commit(job: ReturnType<typeof begin>) {
  return store.request({ type: 'learning.commit', id: job.lease.id, leaseToken: job.lease.leaseToken, assetId: 'same-actual-file', assetRevisionId: 'unchanged-byte-revision',
    assetName: '完整资料.txt', offset: 0, content: '原文件始终是相同字节，授权窗口发生了变化。', more: false }).learning!.reads.find(item => item.status === 'read')!;
}
function withdraw(owner = 'alice') {
  const page = store.request({ type: 'learning.assets.snapshot', companionId: owner, limit: 128 }).learningAssetSnapshot!;
  store.request({ type: 'learning.assets.validate', token: page.token, checks: page.entries.map((entry, index) => ({ index, state: entry.asset ? 'revoked' : 'valid' })) });
}

it('creates a fresh host access generation for the same file bytes while keeping the old job stale and its old sources withdrawn', () => {
  const g = grant(), first = begin(g.id), oldRead = commit(first); withdraw(); const old = inspect(first.disposition.id);
  expect(old.state).toBe('stale'); const fresh = begin(g.id); expect(fresh.disposition.id).not.toBe(old.id); expect(fresh.disposition.inputVersion).not.toBe(old.inputVersion);
  const nextRead = commit(fresh); expect(nextRead.sourceMessageId).not.toBe(oldRead.sourceMessageId);
  const reads = store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads;
  expect(reads.find(item => item.id === oldRead.id)?.status).toBe('withdrawn'); expect(reads.find(item => item.id === nextRead.id)?.status).toBe('read');
  expect(inspect(old.id)).toEqual(old); expect(() => control(old, 'resume')).toThrow('终结');
  expect(store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: 'world_alice', ids: [oldRead.sourceMessageId] }).memorySources).toEqual([]);
  const columns = (db.prepare('PRAGMA table_info(companion_learning_asset_job_history)').all() as { name: string }[]).map(item => item.name);
  expect(columns.some(name => /content|body|source|error|data/u.test(name))).toBe(false);
});

it.each(['park', 'abandon'] as const)('preserves explicit %s and lifetime failures across withdrawal and renewed host authorization', action => {
  const g = grant(), first = begin(g.id);
  store.request({ type: 'learning.defer', id: first.lease.id, leaseToken: first.lease.leaseToken, error: 'Actual material processing failure.', failureKind: 'processing', retryAfterMs: 1000 });
  vi.setSystemTime(Date.now() + 1001); begin(g.id);
  store.request({ type: 'learning.assets.observe', grantId: g.id, expectedRevision: g.revision, assetId: 'same-actual-file', assetRevisionId: 'unchanged-byte-revision' });
  const held = control(inspect(first.disposition.id), action); expect(held.failureCount).toBe(1); withdraw(); const afterWithdrawal = inspect(held.id);
  expect(afterWithdrawal.state).toBe(action === 'park' ? 'parked' : 'abandoned'); expect(afterWithdrawal.failureCount).toBe(held.failureCount);
  const checked = begin(g.id); expect(checked.disposition).toMatchObject({ id: held.id, state: held.state, failureCount: held.failureCount });
  expect(db.prepare('SELECT active_job_id FROM companion_learning_grants WHERE id=?').get(g.id)).toEqual({ active_job_id: null });
  expect(() => commit(checked)).toThrow('固定处理作业');
  store.request({ type: 'learning.advance', id: checked.lease.id, leaseToken: checked.lease.leaseToken, afterAssetId: 'same-actual-file', more: false });
  if (action === 'abandon') expect(() => control(inspect(held.id), 'resume')).toThrow('终结');
  else { control(inspect(held.id), 'resume'); const resumed = begin(g.id); expect(resumed.disposition.state).toBe('running'); expect(commit(resumed).status).toBe('read'); }
});

it('pages more than 130 stale access generations by indexed metadata, preserves them through restore hold and removes only the retired owner history', async () => {
  const g = grant(), ids: string[] = [];
  for (let index = 0; index < 131; index++) { const job = begin(g.id); ids.push(job.disposition.id); commit(job); withdraw(); }
  // The final withdrawn generation remains the current observed row, so a
  // page merges two bounded indexed metadata streams without body scans.
  let afterId: string | undefined; const all: string[] = [];
  for (;;) { const page: CompanionJobPage = store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'learning', states: ['stale'], afterId, limit: 50 }).jobPage!;
    all.push(...page.items.map(item => item.id)); if (!page.hasMore) break; afterId = page.nextId; }
  expect(all.sort()).toEqual(ids.sort()); expect(new Set(all).size).toBe(131);
  const bob = grant('bob'); commit(begin(bob.id, 'bob')); withdraw('bob'); commit(begin(bob.id, 'bob'));
  const bobHistory = db.prepare("SELECT * FROM companion_learning_asset_job_history WHERE companion_id='bob'").all(); expect(bobHistory).toHaveLength(1);
  const before = db.prepare('SELECT * FROM companion_learning_asset_job_history ORDER BY job_id').all();
  holdRestoredCompanionWork(db); expect(db.prepare('SELECT * FROM companion_learning_asset_job_history ORDER BY job_id').all()).toEqual(before);
  store.close(); store = new CompanionsStore(filename, seeds); expect(inspect(ids[0]!).state).toBe('stale');
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT job_id FROM companion_learning_asset_job_history INDEXED BY companion_learning_asset_history_state_page WHERE companion_id=? AND job_status=? AND job_id>? ORDER BY job_id LIMIT 51").all('alice', 'stale', '') as { detail: string }[];
  expect(plan.every(item => !/SCAN|TEMP B-TREE/u.test(item.detail))).toBe(true);
  const retiring = store.request({ type: 'companion.retire', id: 'alice', scope: 'all' }).reset!;
  store.request({ type: 'companion.retire.cleanup', id: 'alice', jobId: retiring.id });
  for (let index = 0; index < 1000 && store.request({ type: 'companion.retire.status', id: 'alice' }).reset!.status !== 'completed'; index++) await store.advanceReset();
  expect(store.request({ type: 'companion.retire.status', id: 'alice' }).reset!.status).toBe('completed');
  expect(db.prepare("SELECT * FROM companion_learning_asset_job_history WHERE companion_id='alice'").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM companion_learning_asset_job_history WHERE companion_id='bob'").all()).toEqual(bobHistory);
}, 60_000);
