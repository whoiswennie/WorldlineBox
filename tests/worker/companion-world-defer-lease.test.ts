import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

let root: string, store: CompanionsStore, db: CompanionConnection;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-29T10:00:00Z');
  root = mkdtempSync(path.join(tmpdir(), 'companion-world-defer-'));
  const filename = path.join(root, 'state.sqlite');
  store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, persona: '有来源的伙伴。', description: '', model: '', avatar: 'sister', active: true, proactive: false })));
  db = new (Database as { new(filename: string): CompanionConnection })(filename);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { timeZone: 'UTC' } });
  for (const companionId of ['alice', 'bob']) {
    const conversationId = store.openPrivate(companionId).id, routine = store.request({ type: 'routine.get', companionId, conversationId }).routine!;
    store.request({ type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  }
});
afterEach(() => {
  db.close(); store.close(); vi.useRealTimers();
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('companion-world-defer-')) throw new Error('Unexpected fixture root.');
  removeOwnedDirectorySync(root);
});
const row = (id: string) => db.prepare('SELECT * FROM companion_world_jobs WHERE id=?').get(id) as { data: string; status: string; lease_until: string; failure_count: number; cycle_failure_count: number };
const inspect = (id: string) => store.request({ type: 'jobs.inspect', ownerId: 'bob', kind: 'world', id }).jobDisposition!;
const control = (id: string, action: 'park' | 'resume' | 'abandon') => { const current = inspect(id);
  return store.request({ type: 'jobs.control', ownerId: 'bob', kind: 'world', id, inputVersion: current.inputVersion, expectedRevision: current.revision, operationId: randomUUID(), action }); };
function claimed() {
  const conversationId = store.openPrivate('alice').id, source = store.appendMessage({ conversationId, authorId: 'user', content: '请向Bob申请一次真实拜访。', replyDirective: 'none' });
  store.request({ type: 'world.tool', companionId: 'alice', conversationId, sourceMessageId: source.id, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '有一项真实问题想讨论。' } });
  const job = store.request({ type: 'world.job.claim', kind: 'decision' }).worldJob!;
  expect(job.companionId).toBe('bob'); return { job, source };
}
const defer = (id: string, leaseToken: string) => store.request({ type: 'world.job.defer', id, leaseToken, error: '等待工程并发调度。', retryAfterMs: 30_000 });

it('ignores expired and replaced world tokens without altering the new lease, then defers only the exact active claim', () => {
  const { job } = claimed(), initial = row(job.id);
  expect(defer(job.id, 'wrong_token').ok).toBe(true); expect(row(job.id)).toEqual(initial);
  vi.setSystemTime(Date.parse(initial.lease_until) + 1); expect(defer(job.id, job.leaseToken!).ok).toBe(true); expect(row(job.id)).toEqual(initial);
  const fresh = store.request({ type: 'world.job.claim', kind: 'decision' }).worldJob!;
  expect(fresh.id).toBe(job.id); expect(fresh.leaseToken).not.toBe(job.leaseToken);
  const before = row(job.id); expect(defer(job.id, job.leaseToken!).ok).toBe(true); expect(row(job.id)).toEqual(before);
  expect(defer(fresh.id, fresh.leaseToken!).ok).toBe(true);
  expect(row(job.id)).toMatchObject({ status: 'pending', failure_count: 0, cycle_failure_count: 0 });
  expect(JSON.parse(row(job.id).data)).toMatchObject({ admissionDeferred: true, attempts: 2 });
});

it('does not revive parked or abandoned world jobs through late callbacks and preserves the original event', () => {
  const { job, source } = claimed(); control(job.id, 'park'); const held = row(job.id);
  expect(defer(job.id, job.leaseToken!).ok).toBe(true); expect(row(job.id)).toEqual(held);
  control(job.id, 'resume'); const fresh = store.request({ type: 'world.job.claim', kind: 'decision' }).worldJob!;
  const running = row(job.id); expect(defer(job.id, job.leaseToken!).ok).toBe(true); expect(row(job.id)).toEqual(running);
  control(job.id, 'abandon'); const abandoned = row(job.id);
  expect(defer(job.id, fresh.leaseToken!).ok).toBe(true); expect(row(job.id)).toEqual(abandoned);
  expect(inspect(job.id)).toMatchObject({ state: 'abandoned', failureCount: 0, cycleFailureCount: 0 });
  expect(store.getMessage(source.id).content).toBe(source.content);
});

it('ignores a delayed callback whose real lease expires across deactivate and reactivate', () => {
  const { job, source } = claimed(); store.request({ type: 'companion.set-active', id: 'bob', active: false }); store.request({ type: 'companion.set-active', id: 'bob', active: true });
  const afterSwitch = row(job.id);
  // Activation flags alone do not revoke a worker lease. The real scale run
  // exceeded that lease's deadline before the queued admission callback ran.
  vi.setSystemTime(Date.parse(afterSwitch.lease_until) + 1);
  expect(defer(job.id, job.leaseToken!).ok).toBe(true); expect(row(job.id)).toEqual(afterSwitch);
  expect(store.getMessage(source.id).content).toBe(source.content);
});

it('propagates an actual durable defer-write failure and rolls back the exact active row', () => {
  const { job } = claimed(), before = row(job.id);
  db.exec("CREATE TRIGGER reject_world_defer BEFORE UPDATE ON companion_world_jobs BEGIN SELECT RAISE(ABORT,'real durable defer failure'); END");
  expect(() => defer(job.id, job.leaseToken!)).toThrow('real durable defer failure'); expect(row(job.id)).toEqual(before);
  db.exec('DROP TRIGGER reject_world_defer'); expect(defer(job.id, job.leaseToken!).ok).toBe(true); expect(row(job.id).status).toBe('pending');
});
