import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { companionAgendaRoutineRuleDrafts } from '../../src/shared/companion-agenda-routine';
import { companionRoutineConfigSchema } from '../../src/shared/companion-routine';
import { companionAgendaRuleDraftSchema } from '../../src/shared/companion-agenda';

let store: CompanionsStore, root: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-29T12:00:00.000Z');
  root = mkdtempSync(path.join(tmpdir(), 'agenda-routine-'));
  store = new CompanionsStore(path.join(root, 'messages.sqlite'), [{ id: 'alice', name: 'alice', description: '', persona: '只根据真实经历表达。', model: '', avatar: 'sister', active: true, proactive: false }]);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { timeZone: 'UTC' } });
});
afterEach(() => {
  store.close(); vi.useRealTimers();
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('agenda-routine-')) throw new Error('Unexpected fixture');
  rmSync(root, { recursive: true, force: true });
});
function adopt() {
  const config = companionRoutineConfigSchema.parse({ timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] });
  const rules = companionAgendaRoutineRuleDrafts(config).map((rule, index) => store.request({ type: 'agenda.rule.create', companionId: 'alice',
    operationId: 'body_seed_' + index, authority: { kind: 'system' }, rule }).agendaRule!);
  store.request({ type: 'routine.agenda.adopt', companionId: 'alice', ruleIds: rules.map(rule => rule.id) });
  return rules;
}
function advance(ms = 30000) { vi.setSystemTime(Date.now() + ms); store.request({ type: 'world.tick' }); return store.request({ type: 'world.snapshot' }).world!; }

it('takes physical sleep directly from a self-adjusted agenda window and does not restore old sleep after pause', () => {
  const [sleep] = adopt(), scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const current = store.request({ type: 'routine.get', ...scope }).routine!;
  expect(current).toMatchObject({ configurationSource: 'agenda', sourceRules: [{ id: sleep!.id, revision: 1 }], config: { meals: [], habits: [] } });
  expect(() => store.request({ type: 'routine.configure', ...scope, expectedRevision: current.revision, patch: { sleepAt: '22:00' } })).toThrow('统一日程');
  const rule = companionAgendaRuleDraftSchema.parse({ title: sleep!.title, intent: sleep!.intent, kind: sleep!.kind, executor: 'routine',
    clock: 'world', routine: { kind: 'sleep' }, trigger: { kind: 'window', startMinute: 690, endMinute: 780, timeZone: 'UTC', probability: 1 }, reason: '调整今日虚拟作息' });
  const revised = store.request({ type: 'agenda.rule.update', companionId: 'alice', id: sleep!.id, expectedRevision: sleep!.revision,
    operationId: 'self_adjust_sleep', authority: { kind: 'self' }, rule }).agendaRule!;
  expect(store.request({ type: 'routine.get', ...scope }).routine!.runtime.plannedPhase).toBe('sleeping');
  expect(advance().actors.find(actor => actor.companionId === 'alice')!.activity).toBe('sleeping');
  store.request({ type: 'agenda.rule.control', companionId: 'alice', id: revised.id, expectedRevision: revised.revision,
    operationId: 'pause_sleep_window', authority: { kind: 'self' }, action: 'pause' });
  advance();
  const awake = store.request({ type: 'routine.get', ...scope }).routine!;
  expect(awake.config.sleepEnabled).toBe(false); expect(awake.runtime.plannedPhase).toBe('awake'); expect(awake.runtime.phase).toBe('awake');
  store.request({ type: 'routine.agenda.adopt', companionId: 'alice', ruleIds: [revised.id] });
  expect(store.request({ type: 'routine.get', ...scope }).routine!.config.sleepEnabled).toBe(false);
});

it('replaces template meals with live self-authored agenda meals without issuing semantic claims', () => {
  adopt(); const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  expect(store.request({ type: 'routine.get', ...scope }).routine!.config.meals).toEqual([]);
  const meal = store.request({ type: 'agenda.rule.create', companionId: 'alice', operationId: 'new_meal', authority: { kind: 'self' },
    rule: { title: '安静吃午餐', intent: '在日程窗口用餐', kind: 'rest', executor: 'routine', clock: 'world', routine: { kind: 'meal', name: '安静吃午餐' },
      trigger: { kind: 'window', startMinute: 720, endMinute: 750, timeZone: 'UTC', probability: 1 }, reason: '根据当前安排加入用餐' } }).agendaRule!;
  expect(advance().actors.find(actor => actor.companionId === 'alice')!.activity).toBe('eating');
  const routine = store.request({ type: 'routine.get', ...scope }).routine!;
  expect(routine.config.meals).toEqual([{ name: '安静吃午餐', at: '12:00', durationMinutes: 30 }]);
  expect(routine.sourceRules).toContainEqual({ id: meal.id, revision: 1 });
  store.request({ type: 'agenda.tick', companionId: 'alice', now: new Date().toISOString(), facts: { active: true } });
  expect(store.request({ type: 'agenda.claim', companionId: 'alice', now: new Date().toISOString(), leaseMs: 30000, limit: 1, excludedOwners: [] }).agendaClaims).toEqual([]);
  const view = store.request({ type: 'agenda.read', companionId: 'alice', limit: 50 }).agenda!;
  expect(view.runs).toEqual([]); expect(view.rules.every(rule => rule.nextAt === undefined)).toBe(true);
});
