import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { companionWorldSleepPlanSchema } from '../../src/shared/companion-life-plan';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

const fixtures: Array<{ root: string; store: CompanionsStore; db: CompanionConnection }> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-22T10:00:00.000Z'); });
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.db.close(); f.store.close();
    if (path.dirname(f.root) !== tmpdir() || !path.basename(f.root).startsWith('worldlinebox-life-plan-')) throw new Error('Unexpected fixture.');
    removeOwnedDirectorySync(f.root);
  }
  vi.useRealTimers();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-life-plan-')), file = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(file, ['alice', 'bob'].map(id => ({ id, name: id === 'alice' ? '小肥鱼' : '大肥鱼', description: '', persona: '认真记录自己的经历。', model: '', avatar: 'sister' as const, proactive: false, active: true })));
  const db = new (Database as { new(file: string): CompanionConnection })(file);
  fixtures.push({ root, store, db }); return { root, file, store, db };
}
const status = (store: CompanionsStore, companionId = 'alice') => store.request({ type: 'world.sleep-plan', companionId }).worldSleepPlan!;
const dataVersion = (db: CompanionConnection) => db.prepare('PRAGMA data_version').get();

describe('owner scheduling read projection', () => {
  it('does not create conversations, advance persisted time, queue jobs or draw sleep admission when polled', () => {
    const { store, db } = fixture();
    const before = dataVersion(db), world = db.prepare('SELECT data FROM companion_world WHERE id=1').get();
    const conversations = db.prepare('SELECT COUNT(*) AS n FROM conversations').get();
    const jobs = db.prepare('SELECT COUNT(*) AS n FROM companion_world_jobs').get();
    const episodes = db.prepare('SELECT COUNT(*) AS n FROM companion_world_sleep_episodes').get();
    const first = status(store); expect(companionWorldSleepPlanSchema.parse(first)).toEqual(first);
    vi.setSystemTime('2026-10-22T10:10:00.000Z');
    for (let n = 0; n < 4; n++) {
      const observed = status(store); expect(observed.admission).toBe(first.admission);
      expect(observed.clock.observedRealAt).toBe(first.clock.observedRealAt);
    }
    expect(db.prepare('SELECT data FROM companion_world WHERE id=1').get()).toEqual(world);
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversations').get()).toEqual(conversations);
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_world_jobs').get()).toEqual(jobs);
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_world_sleep_episodes').get()).toEqual(episodes);
    expect(dataVersion(db)).toEqual(before);
  });
  it('reports only actual enabled owner grants, real manual admission and bounded learning rows', () => {
    const { store } = fixture();
    for (const companionId of ['alice', 'bob']) for (let n = 0; n < (companionId === 'alice' ? 48 : 1); n++) store.request({ type: 'learning.grant', companionId,
      libraryId: companionId + '_library_' + n, libraryName: companionId === 'alice' ? '海边书架 ' + n : '其他伙伴的私密书架', libraryPath: 'D:/资料/' + companionId,
      autonomous: false, intervalMinutes: 30 });
    const initial = status(store); expect(initial.learning).toHaveLength(47); expect(initial.learningHasMore).toBe(true);
    expect(initial.learning.every(item => item.grant.companionId === 'alice' && item.grant.enabled && !item.manualPending)).toBe(true);
    expect(JSON.stringify(initial)).not.toContain('其他伙伴的私密书架');
    const first = initial.learning[0]!.grant;
    store.request({ type: 'learning.run', companionId: 'alice', id: first.id, expectedRevision: first.revision });
    expect(status(store).learning[0]).toMatchObject({ manualPending: true, grant: { nextAt: '1970-01-01T00:00:00.000Z' } });
    store.request({ type: 'learning.revoke', companionId: 'alice', id: first.id, expectedRevision: first.revision });
    const after = status(store); expect(after.learning).toHaveLength(47); expect(after.learningHasMore).toBe(false);
    expect(after.learning.some(item => item.grant.id === first.id)).toBe(false);
  });
  it('uses unprocessed indexed memories with actual sources instead of raw document count', () => {
    const { store } = fixture(), room = store.openPrivate('alice').id;
    for (let n = 0; n < 3; n++) store.saveMemory({ companionId: 'alice', conversationId: room, content: '没有来源的普通文档 ' + n });
    expect(status(store).hasUnconsolidated).toBe(false);
    const source = store.appendMessage({ conversationId: room, authorId: 'user', content: '今天约好了沿海边慢慢走。', replyDirective: 'none' });
    store.saveMemory({ companionId: 'alice', conversationId: room, sourceMessageId: source.id, content: '约好了沿海边慢慢走。' });
    expect(status(store).hasUnconsolidated).toBe(false);
    for (let n = 0; n < 20; n++) {
      const job = store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox;
      if (!job) break;
      store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true });
    }
    expect(status(store).hasUnconsolidated).toBe(true);
    expect(status(store, 'bob').hasUnconsolidated).toBe(false);
    expect(() => status(store, 'missing')).toThrow('伙伴不存在');
  });
  it('aggregates capture queues for this owner without a front-page limit and preserves real retry eligibility', () => {
    const { store } = fixture(), room = store.openPrivate('alice').id, peer = store.openPrivate('bob').id;
    for (let n = 0; n < 70; n++) store.appendMessage({ conversationId: room, authorId: 'user', content: '海边约定 ' + n });
    store.appendMessage({ conversationId: peer, authorId: 'user', content: '其他伙伴的阅读计划。' });
    expect(status(store).captureQueue).toMatchObject({ pending: 70, running: 0, failed: 0, eligible: 70 });
    const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
    expect(status(store).captureQueue).toMatchObject({ pending: 62, running: 8, failed: 0, liveRunning: 8, expiredLeases: 0, eligible: 62 });
    store.request({ type: 'memory.jobs.fail', id: job.id, leaseToken: job.leaseToken, error: '模型暂时不可用', retryAfterMs: 30000 });
    expect(status(store).captureQueue).toMatchObject({ pending: 62, running: 0, failed: 8, eligible: 62 });
    expect(status(store).captureQueue.nextAttemptAt).toBeUndefined();
    // Consume the genuinely due remainder; the failed batch is now the earliest next admission.
    for (let n = 0; n < 20; n++) {
      const pending = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob;
      if (!pending) break;
      store.request({ type: 'memory.jobs.complete', id: pending.id, leaseToken: pending.leaseToken, notes: [] });
    }
    expect(status(store).captureQueue).toMatchObject({ pending: 0, running: 0, failed: 8, eligible: 0, nextAttemptAt: '2026-10-22T10:00:30.000Z' });
    expect(status(store, 'bob').captureQueue.pending).toBe(1);
  });
});
