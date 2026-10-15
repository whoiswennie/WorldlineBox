import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';

const roots: string[] = [], stores = new Set<CompanionsStore>();
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '友善', description: '', model: '', avatar: 'sister', proactive: false }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function open(file: string) { const store = new CompanionsStore(file, seeds); stores.add(store); return store; }
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-world-clock-')); roots.push(root);
  const file = path.join(root, 'messages.sqlite'), store = open(file), settings = store.request({ type: 'world.clock' }).worldClock!;
  expect(settings).toMatchObject({ mode: 'realtime', speed: 1, virtualNow: new Date().toISOString() });
  const revision = store.request({ type: 'world.snapshot' }).world!.settings.revision;
  store.request({ type: 'world.configure', expectedRevision: revision, patch: { timeZone: 'UTC' } });
  return { store, file, scope: { companionId: 'alice', conversationId: store.openPrivate('alice').id } };
}
function configure(store: CompanionsStore, mode: 'compressed' | 'realtime') {
  const revision = store.request({ type: 'world.snapshot' }).world!.settings.revision;
  return store.request({ type: 'world.configure', expectedRevision: revision, patch: { mode } }).world!;
}
it('measures experienced world time across mode rollback and preserves message/source dates through reopening', () => {
  const f = fixture(), start = new Date().toISOString(); configure(f.store, 'compressed');
  vi.setSystemTime(Date.now() + 60000);
  const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '我今天买了一盆兰花。', replyDirective: 'none' });
  expect(source.worldCreatedAt).toBe('2026-10-14T11:12:00.000Z'); expect(source.createdAt).toBe('2026-10-14T10:01:00.000Z');
  f.store.request({ type: 'memory.record', ...f.scope, candidate: { kind: 'event', subject: 'user', content: source.content, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
  configure(f.store, 'realtime'); vi.setSystemTime(Date.now() + 120000);
  const response = companionStorageResponseSchema.parse(f.store.request({ type: 'world.clock', since: [start] }));
  expect(response.worldClock).toMatchObject({ mode: 'realtime', virtualNow: new Date().toISOString(), elapsed: [{ realAt: start, milliseconds: 74 * 60000 }] });
  f.store.close(); stores.delete(f.store); const store = open(f.file);
  expect(store.getMessage(source.id)).toMatchObject({ createdAt: source.createdAt, worldCreatedAt: source.worldCreatedAt });
  const query = { ...f.scope, query: '兰花', from: '2026-10-14T11:00:00Z', to: '2026-10-14T11:30:00Z' };
  expect(store.request({ type: 'memory.search', ...query }).memoryPage!.items).toHaveLength(1);
  expect(store.request({ type: 'memory.sources.search', ...query }).memorySources!.map(message => message.id)).toEqual([source.id]);
  expect(store.request({ type: 'memory.sources.search', ...query, from: '2026-10-14T10:00:00Z', to: '2026-10-14T10:30:00Z' }).memorySources).toEqual([]);
});
it('keeps remaining visit permission duration when compressed time realigns and all residents adopt the selected world zone', () => {
  const f = fixture(); configure(f.store, 'compressed');
  const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '请去 Bob 家分享植物近况。', replyDirective: 'none' });
  const visit = f.store.request({ type: 'world.tool', ...f.scope, sourceMessageId: source.id, arguments: { action: 'visit', targetCompanionId: 'bob', reason: '分享植物近况' } }).world!.visits[0]!;
  vi.setSystemTime(Date.now() + 60000);
  const before = f.store.request({ type: 'world.snapshot' }).world!, remaining = Date.parse(visit.expiresAt) - Date.parse(before.clock.virtualNow);
  const real = configure(f.store, 'realtime');
  expect(Date.parse(real.visits[0]!.expiresAt) - Date.parse(real.clock.virtualNow)).toBe(remaining);
  const changed = f.store.request({ type: 'world.configure', expectedRevision: real.settings.revision, patch: { timeZone: 'America/Los_Angeles' } }).world!;
  expect(changed.settings.timeZone).toBe('America/Los_Angeles');
  for (const companionId of ['alice', 'bob']) {
    const scope = { companionId, conversationId: f.store.openPrivate(companionId).id };
    const routine = f.store.request({ type: 'routine.get', ...scope }).routine!;
    expect(routine.config.timeZone).toBe('America/Los_Angeles'); expect(routine.runtime.plannedPhase).toBe('sleeping');
  }
});
it('does not insert a present-day task into the offline past and refuses clock edits until catch-up completes', () => {
  const f = fixture(); vi.setSystemTime(Date.now() + 1000 * 86400000);
  const source = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '现在处理这个新任务', replyDirective: 'none' });
  const work = f.store.request({ type: 'world.work.begin', ...f.scope, kind: 'action', workId: 'present_request', sourceMessageId: source.id, fixed: true }).worldWork!;
  expect(work.status).toBe('waiting'); expect(work.reason).toContain('补算');
  expect(f.store.request({ type: 'world.work.ready', companionId: 'alice', workId: work.workId }).worldWork!.status).toBe('waiting');
  const world = f.store.request({ type: 'world.snapshot' }).world!; expect(world.backlog).toBe(true);
  expect(world.events.some(event => event.kind === 'work_ready' || event.kind === 'work_start')).toBe(false);
  expect(() => f.store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'compressed' } })).toThrow('补算');
});
