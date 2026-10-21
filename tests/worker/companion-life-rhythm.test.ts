import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { companionLifeRhythm, type CompanionLifeRule } from '../../src/shared/companion-life-event';

const roots: string[] = [], stores = new Set<CompanionsStore>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T09:00:00Z'); });
afterEach(() => { for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
const members: CompanionSeed[] = [
  { id: 'alice', name: 'Alice', persona: '喜欢先安静读原文，有实际发现时再分享。', description: '', model: '', avatar: 'sister', proactive: true, active: true },
  { id: 'bob', name: 'Bob', persona: '作息偏晚，习惯把未解决的问题留给朋友讨论。', description: '', model: '', avatar: 'sister', proactive: true, active: true },
  { id: 'charlie', name: 'Charlie', persona: '早起散步，尊重别人忙碌和安静的时间。', description: '', model: '', avatar: 'sister', proactive: true, active: true },
];

it('keeps three individual life rhythms evaluating across two days, silence, failure and restart without sleep contact or player spam', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-life-rhythm-')); roots.push(root);
  const file = path.join(root, 'messages.sqlite'); let store = new CompanionsStore(file, members); stores.add(store);
  const initial = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: initial.settings.revision, patch: { mode: 'compressed', dayDurationMinutes: 5, timeZone: 'UTC' } });
  const rules = new Map<string, CompanionLifeRule>(), attempts = new Map<string, Array<{ at: number; outcome: string }>>();
  for (const [index, member] of members.entries()) {
    const scope = { companionId: member.id, conversationId: store.openPrivate(member.id).id };
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision,
      patch: { sleepAt: ['23:00', '01:00', '22:00'][index]!, wakeAt: ['07:00', '09:00', '06:00'][index]!, meals: [], habits: [] } });
    const defaults = store.request({ type: 'life-rule.list', companionId: member.id }).lifeRules!;
    expect(defaults.some(rule => rule.targetId === 'user')).toBe(false);
    for (const rule of defaults) store.request({ type: 'life-rule.remove', companionId: member.id, id: rule.id, expectedRevision: rule.revision });
    rules.set(member.id, store.request({ type: 'life-rule.create', companionId: member.id, rule: {
      title: member.persona, startMinute: 0, endMinute: 1440, action: 'message', targetId: members[(index + 1) % members.length]!.id,
      probability: [1, .8, .6][index]!, checkIntervalMinutes: [5, 10, 15][index]!, actionCooldownMinutes: [60, 80, 100][index]!,
      silenceCooldownMinutes: 10, failureCooldownMinutes: 20,
    } }).lifeRule!);
    attempts.set(member.id, []);
  }
  for (let step = 0; step <= 600; step++) {
    vi.setSystemTime(Date.now() + 1000); store.request({ type: 'world.tick' });
    store.request({ type: 'life-event.tick' });
    for (let slot = 0; slot < 3; slot++) {
      const occurrence = store.request({ type: 'life-event.claim' }).lifeOccurrence;
      if (!occurrence) break;
      const world = store.request({ type: 'world.snapshot' }).world!, actor = world.actors.find(actor => actor.companionId === occurrence.companionId)!;
      expect(actor.routinePhase).not.toBe('sleeping'); expect(['sleeping', 'lyingDown', 'waking', 'working']).not.toContain(actor.activity);
      const history = attempts.get(occurrence.companionId)!, at = Date.parse(world.clock.virtualNow);
      const outcome = history.length === 0 ? 'silent' : history.length === 1 ? 'failed' : 'done';
      if (outcome === 'silent') store.request({ type: 'life-event.complete', id: occurrence.id, leaseToken: occurrence.leaseToken!, silent: true, reason: '这次先继续自己的阅读。' });
      else if (outcome === 'failed') store.request({ type: 'life-event.fail', id: occurrence.id, leaseToken: occurrence.leaseToken!, error: '受控临时模型故障。' });
      else store.request({ type: 'life-event.complete', id: occurrence.id, leaseToken: occurrence.leaseToken!, text: '我刚核对了自己的问题，想听听你的不同理解。' });
      history.push({ at, outcome });
    }
    if (step === 300) { store.close(); stores.delete(store); store = new CompanionsStore(file, members); stores.add(store); }
  }
  for (const member of members) {
    const history = attempts.get(member.id)!, rhythm = companionLifeRhythm(rules.get(member.id)!);
    expect(history.length).toBeGreaterThan(5); expect(history.slice(0, 3).map(item => item.outcome)).toEqual(['silent', 'failed', 'done']);
    for (let index = 1; index < history.length; index++) {
      const previous = history[index - 1]!, cooldown = previous.outcome === 'silent' ? rhythm.silenceCooldownMinutes
        : previous.outcome === 'failed' ? rhythm.failureCooldownMinutes : rhythm.actionCooldownMinutes;
      expect(history[index]!.at - previous.at).toBeGreaterThanOrEqual(cooldown * 60000);
    }
    const room = store.openPrivate(member.id);
    expect(store.messages({ conversationId: room.id }).messages.filter(message => message.authorId === member.id)).toHaveLength(0);
    expect(new Set(history.map(item => Math.floor(item.at / 86400000))).size).toBeGreaterThan(1);
  }
  if (process.env.WORLDLINEBOX_WRITE_LIFE_VALIDATION === '1') {
    const output = path.resolve('artifacts/vcp-validation/companion-life-rhythm-validation.json');
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({ generatedAt: new Date(vi.getRealSystemTime()).toISOString(), success: true,
      evidenceKind: 'Actual SQLite and world clock, controlled silent/failure/success completions. This is scheduler verification, not real-model content quality.',
      virtualEnd: store.request({ type: 'world.clock' }).worldClock!.virtualNow, totalVirtualHours: 48.08,
      restartAtHour: 24, playerMessages: 0, sleepContacts: 0,
      owners: members.map(member => ({ id: member.id, rhythm: companionLifeRhythm(rules.get(member.id)!),
        probability: rules.get(member.id)!.probability, decisions: attempts.get(member.id),
        quietCount: attempts.get(member.id)!.filter(item => item.outcome === 'silent').length,
        failedCount: attempts.get(member.id)!.filter(item => item.outcome === 'failed').length,
        actionCount: attempts.get(member.id)!.filter(item => item.outcome === 'done').length })),
    }, null, 2), 'utf8');
  }
}, 60000);
