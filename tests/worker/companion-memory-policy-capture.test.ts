import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { COMPANION_MEMORY_POLICY_FILE, initialCompanionMemoryPolicy } from '../../src/shared/companion-memory-policy';

const roots: string[] = [], stores = new Set<CompanionsStore>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-27T10:00:00Z'); });
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('memory-policy-capture-')) throw Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'memory-policy-capture-')); roots.push(root);
  const filename = path.join(root, 'messages.sqlite'), policyRoot = path.join(root, '伙伴记忆'), policy = initialCompanionMemoryPolicy();
  const write = (owner = 'alice') => { mkdirSync(path.join(policyRoot, owner), { recursive: true }); writeFileSync(path.join(policyRoot, owner, COMPANION_MEMORY_POLICY_FILE),
    JSON.stringify({ schema: 'worldlinebox.companion-memory-policy-v1', companionId: owner, policy })); };
  write(); write('bob');
  const store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '真实经历', model: '', avatar: 'sister' as const, active: true, proactive: false })));
  stores.add(store); store.request({ type: 'world.maintenance.bind-policy-root', root: policyRoot });
  const rooms = Object.fromEntries(['alice', 'bob'].map(id => [id, store.openPrivate(id).id]));
  const append = (content: string, owner = 'alice') => store.appendMessage({ conversationId: rooms[owner]!, authorId: 'user', content, replyDirective: 'none' });
  const claim = (owner?: string) => store.request({ type: 'memory.jobs.claim', ...(owner ? { companionId: owner } : {}) }).memoryJob;
  return { store, filename, policyRoot, policy, write, append, claim };
}
it('uses live quiet and maximum-wait values in real episode admission and pure eligibility projection', () => {
  const f = fixture(); f.policy.capture.quietMs = 120_000; f.policy.capture.maxWaitMs = 150_000; f.write();
  const first = f.append('真实普通事件第一段。'); vi.setSystemTime(Date.now() + 60_000);
  expect(f.claim('alice')).toBeUndefined(); const second = f.append('同一事件仍在继续。');
  const projection = f.store.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan!;
  expect(projection.captureQueue).toMatchObject({ eligible: 0, nextAttemptAt: new Date(Date.now() + 90_000).toISOString() });
  vi.setSystemTime(Date.now() + 89_999); expect(f.claim('alice')).toBeUndefined();
  vi.setSystemTime(Date.now() + 1); expect(f.claim('alice')?.sourceMessageIds).toEqual([first.id, second.id]);
});
it('uses an owner batch threshold and hard bound without force admission', () => {
  const f = fixture(); f.policy.capture.batchSize = 2; f.write();
  const first = f.append('事件一。'); expect(f.claim('alice')).toBeUndefined(); const second = f.append('事件二。');
  const third = f.append('下个片段。'); const job = f.claim('alice')!;
  expect(job.sourceMessageIds).toEqual([first.id, second.id]); expect(job.sourceMessageIds).not.toContain(third.id);
});
it('keeps raw intake through policy failure, spends no attempts and restores pending mappings from original source times', () => {
  const f = fixture(); unlinkSync(path.join(f.policyRoot, 'alice', COMPANION_MEMORY_POLICY_FILE));
  const first = f.append('策略缺失时的真实输入一。'), second = f.append('策略缺失时的真实输入二。');
  vi.setSystemTime(Date.now() + 65_000); const bob = f.append('另一个伙伴仍可记录。', 'bob'); vi.setSystemTime(Date.now() + 65_000);
  expect(f.claim('alice')).toBeUndefined(); expect(f.claim()?.sourceMessageIds).toEqual([bob.id]);
  const db = new (BetterSqlite3 as unknown as { new(file: string): CompanionConnection })(f.filename);
  try { expect(db.prepare("SELECT count(*) AS n,SUM(attempts) AS attempts FROM vcp_capture_jobs WHERE companion_id='alice'").get()).toEqual({ n: 2, attempts: 0 }); }
  finally { db.close(); }
  f.write(); expect(f.claim('alice')?.sourceMessageIds).toEqual([first.id, second.id]);
});
it('defers only a valid whole capture lease without exhausting debt or advancing source coverage', () => {
  const f = fixture(), first = f.append('第一段需要保留。'), second = f.append('第二段也需要保留。');
  vi.setSystemTime(Date.now() + 65_000);
  const db = new (BetterSqlite3 as unknown as { new(file: string): CompanionConnection })(f.filename);
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const job = f.claim('alice')!; expect(job.sourceMessageIds).toEqual([first.id, second.id]); expect(job.attempts).toBe(1);
      expect(() => f.store.request({ type: 'memory.jobs.defer', id: job.id, leaseToken: 'forged-token', error: '不应改动租约', retryAfterMs: 1000 })).toThrow();
      f.store.request({ type: 'memory.jobs.defer', id: job.id, leaseToken: job.leaseToken, error: '本地资源暂不可用', retryAfterMs: 1000 });
      expect(db.prepare("SELECT COUNT(*) AS n,SUM(attempts) AS attempts FROM vcp_capture_jobs WHERE companion_id='alice' AND status='pending' AND lease_token IS NULL").get()).toEqual({ n: 2, attempts: 0 });
      expect(f.claim('alice')).toBeUndefined(); vi.setSystemTime(Date.now() + 1000);
    }
    const job = f.claim('alice')!;
    f.store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [] });
    expect(f.claim('alice')).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM vcp_capture_jobs WHERE companion_id='alice' AND status='done'").get()).toEqual({ n: 2 });
  } finally { db.close(); }
});
it('lifts only typed pending admission debt and preserves genuine failures and active leases', () => {
  const f = fixture(), source = f.append('确实失败过一次，之后因资源延后。'); f.append('另一个伙伴正在运行。', 'bob');
  vi.setSystemTime(Date.now() + 65_000);
  const first = f.claim('alice')!;
  f.store.request({ type: 'memory.jobs.fail', id: first.id, leaseToken: first.leaseToken, error: '实际提供方失败', retryAfterMs: 1000 });
  vi.setSystemTime(Date.now() + 1000);
  const second = f.claim('alice')!; expect(second.attempts).toBe(2);
  f.store.request({ type: 'memory.jobs.defer', id: second.id, leaseToken: second.leaseToken, error: '本地资源延期', retryAfterMs: 86_400_000 });
  const bob = f.claim('bob')!;
  f.store.request({ type: 'memory.jobs.retry-admission', companionId: 'bob' }); expect(f.claim('alice')).toBeUndefined();
  f.store.request({ type: 'memory.jobs.retry-admission' });
  const retried = f.claim('alice')!; expect(retried).toMatchObject({ attempts: 2, sourceMessageIds: [source.id] });
  expect(f.claim('bob')).toBeUndefined();
  f.store.request({ type: 'memory.jobs.complete', id: retried.id, leaseToken: retried.leaseToken, notes: [] });
  f.store.request({ type: 'memory.jobs.complete', id: bob.id, leaseToken: bob.leaseToken, notes: [] });
});
