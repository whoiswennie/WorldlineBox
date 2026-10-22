import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { companionLifeOverviewContextSchema } from '../../src/shared/companion-life-overview';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

const fixtures: Array<{ root: string; store: CompanionsStore; db: CompanionConnection }> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-22T10:00:00.000Z'); });
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.db.close(); f.store.close();
    if (path.dirname(f.root) !== tmpdir() || !path.basename(f.root).startsWith('worldlinebox-life-overview-')) throw new Error('Unexpected fixture.');
    removeOwnedDirectorySync(f.root);
  }
  vi.useRealTimers();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-life-overview-')), file = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(file, ['alice', 'bob'].map(id => ({ id, name: id === 'alice' ? '小肥鱼' : '大肥鱼', description: '', persona: '认真生活。', model: '', avatar: 'sister' as const, proactive: false, active: true })));
  const db = new (Database as { new(file: string): CompanionConnection })(file); fixtures.push({ root, store, db });
  return { root, store, db, alice: { companionId: 'alice', conversationId: store.openPrivate('alice').id }, bob: { companionId: 'bob', conversationId: store.openPrivate('bob').id } };
}
const page = (store: CompanionsStore, input: { companionId?: string; filter?: 'all' | 'current' | 'upcoming' | 'attention' | 'events'; cursor?: string; limit?: number } = {}) =>
  store.request({ type: 'life.overview.read', companionId: 'alice', ...input }).lifeOverviewContext!;

describe('bounded unified life overview', () => {
  it('projects ongoing learning goal metadata into the same owner feed without loading source bodies', () => {
    const { store } = fixture();
    const created = store.request({ type: 'learning.goals.create', companionId: 'alice', text: '持续学习植物知识，每轮核对证据并自测', materials: [], allowWeb: false,
      schedule: { intervalMinutes: 60, windows: [], timeZone: 'Asia/Shanghai' } }).learningGoal!;
    const upcoming = page(store, { filter: 'upcoming' }).items.find(item => item.kind === 'learning_goal')!;
    expect(upcoming).toMatchObject({ title: '学习 · 持续学习植物知识，每轮核对证据并自测', section: 'upcoming', destination: { kind: 'learning', id: created.id }, timing: { clock: 'real', kind: 'eligibility' } });
    expect(page(store, { companionId: 'bob' }).items.some(item => item.kind === 'learning_goal')).toBe(false);
    const claimed = store.request({ type: 'learning.goals.claim' }).learningGoalJob!;
    store.request({ type: 'learning.goals.checkpoint', id: created.id, leaseToken: claimed.leaseToken,
      round: { ...claimed.round, phase: 'reading', reads: [{ id: 'large_source', kind: 'web', title: '不应传入总览', uri: 'https://example.org', revision: 'one', readAt: new Date().toISOString(), characters: 12000,
        contentHash: 'a'.repeat(64), excerpt: '只留在学习页的原文'.repeat(1000).slice(0, 12000), truncated: true }] } });
    const current = page(store, { filter: 'current' });
    expect(current.items.find(item => item.kind === 'learning_goal')).toMatchObject({ status: 'running', section: 'current', condition: expect.stringContaining('读取并核实材料') });
    expect(JSON.stringify(current)).not.toContain('只留在学习页的原文');
  });
  it('observes the shared clock/weather snapshot without advancing time, inventing activity or writing defaults', () => {
    const { store, db } = fixture(), initial = page(store), before = db.prepare('PRAGMA data_version').get();
    expect(companionLifeOverviewContextSchema.parse(initial)).toEqual(initial);
    const peer = page(store, { companionId: 'bob' });
    expect(peer.clock).toEqual(initial.clock); expect(peer.environment).toEqual(initial.environment);
    vi.setSystemTime('2026-10-22T11:00:00.000Z');
    const later = page(store);
    expect(later.clock.virtualNow).toBe(initial.clock.virtualNow); expect(later.clock.backlog).toBe(true);
    expect(later.environment).toEqual(initial.environment);
    expect(db.prepare('PRAGMA data_version').get()).toEqual(before);
    expect(() => page(store, { companionId: 'missing' })).toThrow('伙伴不存在');
    expect(() => page(store, { limit: 41 })).toThrow();
  });
  it('paginates owner task metadata at SQL before materialization and rejects cross-owner/filter cursors', () => {
    const { store, db, alice, bob } = fixture(), source = store.appendMessage({ conversationId: alice.conversationId, authorId: 'user', content: '请整理阅读笔记。' });
    const insert = db.prepare('INSERT INTO actions(id,conversation_id,companion_id,status,data) VALUES(?,?,?,?,?)');
    db.transaction(() => {
      for (let index = 0; index < 10000; index++) {
        const id = 'historical_' + index, data = { id, ...alice, sourceMessageId: source.id, title: '过去已经完成的工作', status: 'succeeded', createdAt: source.createdAt, updatedAt: source.createdAt, result: '不应该整段传入总览的历史结果'.repeat(100) };
        insert.run(id, alice.conversationId, 'alice', data.status, JSON.stringify(data));
      }
      for (let index = 0; index < 70; index++) {
        const id = 'active_' + String(index).padStart(3, '0'), data = { id, ...alice, sourceMessageId: source.id, title: '阅读笔记 ' + index, status: 'queued', createdAt: source.createdAt, updatedAt: source.createdAt,
          events: [{ content: '不应该传入总览的过程正文'.repeat(100) }] };
        insert.run(id, alice.conversationId, 'alice', data.status, JSON.stringify(data));
      }
      insert.run('peer_task', bob.conversationId, 'bob', 'queued', JSON.stringify({ id: 'peer_task', ...bob, title: '大肥鱼的私人书签', status: 'queued', createdAt: source.createdAt, updatedAt: source.createdAt }));
    }).immediate();
    const seen: string[] = []; let cursor: string | undefined;
    for (let index = 0; index < 10; index++) {
      const result = page(store, { filter: 'current', limit: 12, cursor });
      expect(result.items.length).toBeLessThanOrEqual(12);
      expect(result.items.every(item => item.destination.conversationId === alice.conversationId)).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/过程正文|历史结果|私人书签/u);
      seen.push(...result.items.map(item => item.id));
      if (!result.hasMore) break;
      cursor = result.nextCursor!;
      expect(() => page(store, { companionId: 'bob', filter: 'current', cursor })).toThrow('不属于当前伙伴');
      expect(() => page(store, { filter: 'all', cursor })).toThrow('不属于当前伙伴');
    }
    expect(seen).toHaveLength(70); expect(new Set(seen).size).toBe(70);
    expect(db.prepare("EXPLAIN QUERY PLAN SELECT id FROM actions WHERE companion_id=? AND status=? ORDER BY json_extract(data,'$.updatedAt'),id LIMIT 13").all('alice', 'queued')).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining('companion_overview_actions') })]));
  });
  it('keeps actual world schedule times distinct from real deferral eligibility and supports attention links', () => {
    const { store, db, alice } = fixture();
    const schedules = store.request({ type: 'schedule.create', ...alice, entries: [
      { title: '明天的阅读提醒', prompt: '提醒我阅读', kind: 'reminder', runAt: '2026-10-23T09:00:00Z' },
      { title: '等休息后整理书架', prompt: '整理书架', kind: 'task', flexible: true, runAt: '2026-10-23T10:00:00Z' },
    ] }).schedules!;
    db.prepare("UPDATE companion_schedules SET deferred_until=?,data=json_set(data,'$.deferredUntil',?,'$.blockedReason','resting') WHERE id=?")
      .run('2026-10-22T10:30:00.000Z', '2026-10-22T10:30:00.000Z', schedules[1]!.id);
    const future = page(store, { filter: 'upcoming' });
    expect(future.items.find(item => item.kind === 'schedule')).toMatchObject({ title: '明天的阅读提醒', timing: { kind: 'scheduled', clock: 'world', at: '2026-10-23T09:00:00.000Z' }, destination: { kind: 'schedules', id: schedules[0]!.id, conversationId: alice.conversationId } });
    const blocked = page(store, { filter: 'attention' }).items.find(item => item.kind === 'schedule');
    expect(blocked).toMatchObject({ title: '等休息后整理书架', timing: { kind: 'eligibility', clock: 'real', at: '2026-10-22T10:30:00.000Z' } });
    expect(blocked?.condition).toContain('现实时间');
  });
  it('shows enabled probability windows as opportunities and never creates a life occurrence by viewing them', () => {
    const { store, db } = fixture();
    const rule = store.request({ type: 'life-rule.create', companionId: 'alice', rule: { title: '傍晚慢慢散步', action: 'park_walk', startMinute: 1020, endMinute: 1140, probability: .35, checkIntervalMinutes: 12, durationMinutes: 20 } }).lifeRule!;
    const before = db.prepare('SELECT COUNT(*) AS n FROM companion_life_occurrences').get(), report = page(store, { filter: 'events' });
    const item = report.items.find(item => item.destination.id === rule.id)!;
    expect(item).toMatchObject({ kind: 'life_rule', probability: .35, timing: { kind: 'window', clock: 'world' }, destination: { kind: 'life_rules', id: rule.id } });
    expect(item.timing.windowStart).toBeTruthy(); expect(item.condition).toContain('不保证发生'); expect(item.condition).toContain('12世界分钟');
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_life_occurrences').get()).toEqual(before);
    expect(page(store, { companionId: 'bob', filter: 'events' }).items.some(item => item.destination.id === rule.id)).toBe(false);
  });
});
