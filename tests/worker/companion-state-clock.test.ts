import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { applyCompanionAppraisal, decayCompanionAffect } from '../../src/shared/companion-affect';
import type { CompanionMessage } from '../../src/shared/companions';

const folders: string[] = [], stores = new Set<CompanionsStore>();
const seeds: CompanionSeed[] = [{ id: 'alice', name: 'Alice', persona: '尊重真实互动', description: '', model: '', avatar: 'sister', proactive: false }];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); vi.useRealTimers(); });
function configure(store: CompanionsStore, mode: 'compressed' | 'realtime', timeZone = 'UTC') {
  const revision = store.request({ type: 'world.snapshot' }).world!.settings.revision;
  store.request({ type: 'world.configure', expectedRevision: revision, patch: { mode, timeZone } });
}
function fixture(timeZone = 'UTC') {
  const folder = mkdtempSync(path.join(tmpdir(), 'companion-state-clock-')); folders.push(folder);
  const filename = path.join(folder, 'messages.sqlite'), store = new CompanionsStore(filename, seeds); stores.add(store);
  configure(store, 'compressed', timeZone);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  return { store, scope, filename };
}
function source(f: ReturnType<typeof fixture>) { return f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: '我支持你，也尊重你，谢谢你。', replyDirective: 'none' }); }
function evaluate(f: ReturnType<typeof fixture>, message: CompanionMessage) {
  return f.store.request({ type: 'state.update', ...f.scope, proposal: { reason: '用户表达实际的支持。', sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }], appraisals: [{ type: 'support', target: 'user', intensity: 1, confidence: 1 }] } }).runtimeState!;
}
function state(f: ReturnType<typeof fixture>) { return f.store.request({ type: 'state.get', ...f.scope }).runtimeState!; }

it('decays PAD by experienced world time across an absolute realtime rollback without changing authored revision', () => {
  const f = fixture(), initial = evaluate(f, source(f));
  vi.setSystemTime(Date.now() + 60000);
  const compressed = state(f), expected = decayCompanionAffect(initial.affect, 72 * 60000);
  expect(compressed.affect.pleasure).toBeCloseTo(expected.pleasure, 10);
  expect(compressed.affect.arousal).toBeCloseTo(expected.arousal, 10);
  expect(compressed.affect.dominance).toBeCloseTo(expected.dominance, 10);
  expect(compressed.relationship).toEqual(initial.relationship); expect(compressed.revision).toBe(initial.revision);
  configure(f.store, 'realtime'); vi.setSystemTime(Date.now() + 60000);
  const real = state(f), continued = decayCompanionAffect(expected, 60000);
  expect(real.affect.pleasure).toBeCloseTo(continued.pleasure, 10);
  expect(real.affect.arousal).toBeCloseTo(continued.arousal, 10);
  expect(real.affect.dominance).toBeCloseTo(continued.dominance, 10);
  expect(real.relationship).toEqual(initial.relationship); expect(real.revision).toBe(initial.revision);
});

it('ages a delayed appraisal by world experience even when the displayed date was moved backwards', () => {
  const f = fixture(), message = source(f);
  vi.setSystemTime(Date.now() + 60000); configure(f.store, 'realtime');
  const before = state(f), expected = applyCompanionAppraisal(before, { type: 'support', target: 'user', intensity: 1, confidence: 1 }, 72 * 60000, 6);
  const actual = evaluate(f, message);
  expect(actual.affect).toEqual(expected.affect); expect(actual.relationship).toEqual(expected.relationship);
});

it('withdraws only the remaining world-decayed impulse and its relationship contribution when evidence is forgotten', () => {
  const f = fixture(), message = source(f); evaluate(f, message);
  vi.setSystemTime(Date.now() + 60000); state(f); configure(f.store, 'realtime');
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [message.id] });
  const forgotten = state(f);
  for (const value of Object.values(forgotten.affect)) expect(value).toBeCloseTo(0, 10);
  expect(forgotten.relationship).toEqual({ affinity: 50, trust: 50, respect: 50 });
});

it('uses the world-zone source day for daily budgets, retains real audit timestamps and cannot refill a revisited day', () => {
  vi.setSystemTime('2026-10-14T18:00:00Z');
  const f = fixture('Asia/Tokyo'), original = source(f); evaluate(f, original);
  for (let index = 0; index < 8; index++) evaluate(f, source(f));
  const first = state(f), gain = (value: typeof first) => Object.values(value.relationship).reduce((sum, number) => sum + number, -150);
  expect(gain(first)).toBeCloseTo(6, 10);
  vi.setSystemTime(Date.now() + 20 * 60000); evaluate(f, source(f));
  expect(gain(state(f))).toBeGreaterThan(6);
  configure(f.store, 'realtime', 'Asia/Tokyo');
  const before = state(f); evaluate(f, source(f));
  expect(state(f).relationship).toEqual(before.relationship);
  f.store.close(); stores.delete(f.store);
  const Database = BetterSqlite3 as { new(filename: string): CompanionConnection }, db = new Database(f.filename);
  try {
    const records = db.prepare('SELECT source_date,data FROM companion_state_appraisals WHERE positive_change>0 ORDER BY rowid').all() as Array<{ source_date: string; data: string }>;
    expect(records[0]!.source_date).toBe('2026-10-15'); expect(records.at(-1)!.source_date).toBe('2026-10-16');
    expect(JSON.parse(records[0]!.data)).toMatchObject({ occurredAt: original.createdAt, occurredWorldAt: original.worldCreatedAt, appliedAt: original.createdAt });
  } finally { db.close(); }
});

it('keeps a leased state proposal and extraction watermark pending while its source is still in the unmaterialized future', () => {
  const f = fixture(); vi.setSystemTime(Date.now() + 1000 * 86400000);
  const message = source(f), job = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  const complete = () => f.store.request({ type: 'memory.jobs.complete' as const, id: job.id, leaseToken: job.leaseToken, candidates: [], stateProposal: { reason: '用户表达实际的支持。', sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }], appraisals: [{ type: 'support' as const, target: 'user' as const, intensity: 1, confidence: 1 }] } });
  expect(() => complete()).toThrow('补算');
  expect(f.store.request({ type: 'memory.status', ...f.scope }).memoryStatus).toMatchObject({ running: 1, completed: 0, extractionWatermark: 0 });
  expect(f.store.request({ type: 'world.clock' }).worldClock!.backlog).toBe(true);
  // The same durable claim remains available for retry; rejection did not
  // consume the source, mark it completed, or partially apply the proposal.
  expect(f.store.request({ type: 'memory.status', ...f.scope }).memoryStatus?.running).toBe(1);
});
