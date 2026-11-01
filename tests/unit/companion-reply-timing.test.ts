import { expect, it } from 'vitest';
import { advanceCompanionReplyTiming, companionReplyElapsedMs, type CompanionReplyProgress } from '../../src/shared/companion-reply-progress';

const start = Date.parse('2026-10-27T08:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
it('accumulates execution across repeated stops without charging queueing or paused hours', () => {
  let progress: CompanionReplyProgress | undefined;
  const change = (phase: CompanionReplyProgress['phase'], seconds: number) => progress = advanceCompanionReplyTiming(progress, {
    revision: (progress?.revision ?? 0) + 1, phase, detail: phase, startedAt: at(0), updatedAt: at(seconds),
    ...(['cancelled', 'interrupted', 'failed', 'completed'].includes(phase) ? { finishedAt: at(seconds) } : {}) });
  change('queued', 0); expect(companionReplyElapsedMs(progress!, start + 60000)).toBe(0);
  change('context', 60); change('tools', 65); change('cancelled', 75);
  expect(companionReplyElapsedMs(progress!, start + 3600000)).toBe(15000);
  change('cancelled', 3600); expect(progress!.timing!.elapsedMs).toBe(15000);
  change('queued', 3660); expect(companionReplyElapsedMs(progress!, start + 3670000)).toBe(15000);
  change('context', 3680); change('tools', 3685); change('failed', 3690);
  expect(progress!.timing!.elapsedMs).toBe(25000);
  change('queued', 7200); change('context', 7210); change('completed', 7215);
  expect(companionReplyElapsedMs(progress!, start + 86400000)).toBe(30000);
});

it('uses the last observed execution boundary after a crash and tolerates a backwards clock', () => {
  const active = advanceCompanionReplyTiming(undefined, { revision: 1, phase: 'tools', detail: '', startedAt: at(0), updatedAt: at(5) });
  expect(companionReplyElapsedMs(active, start)).toBe(0);
  const interrupted = advanceCompanionReplyTiming(active, { ...active, phase: 'interrupted', finishedAt: at(15), updatedAt: at(3600) });
  expect(companionReplyElapsedMs(interrupted, start + 7200000)).toBe(10000);
  const resumed = advanceCompanionReplyTiming(interrupted, { ...interrupted, phase: 'context', finishedAt: undefined, updatedAt: at(7200) });
  expect(companionReplyElapsedMs(resumed, start + 7205000)).toBe(15000);
});

it.each([NaN, Infinity, -Infinity, -1])('rejects a corrupt accumulated duration %s', elapsedMs => {
  const progress: CompanionReplyProgress = { revision: 1, phase: 'tools', detail: '', startedAt: at(0), updatedAt: at(5), timing: { elapsedMs, activeSince: at(5) } };
  expect(companionReplyElapsedMs(progress, start + 10000)).toBeUndefined();
});

it('keeps a terminal interval fixed and never propagates invalid live clocks', () => {
  const progress: CompanionReplyProgress = { revision: 1, phase: 'completed', detail: '', startedAt: at(0), updatedAt: at(50), finishedAt: at(12), timing: { elapsedMs: 3000, activeSince: at(5) } };
  expect(companionReplyElapsedMs(progress, start + 100000)).toBe(10000);
  expect(companionReplyElapsedMs(progress, start + 864000000)).toBe(10000);
  expect(companionReplyElapsedMs({ ...progress, phase: 'tools' }, NaN)).toBe(3000);
  expect(companionReplyElapsedMs({ ...progress, phase: 'tools', timing: { elapsedMs: Number.MAX_VALUE, activeSince: at(5) } }, Number.MAX_VALUE)).toBeUndefined();
});


it('freezes an unknown prior-process stop at recorded elapsed only, without inventing a finish time', async () => {
  const { finishCompanionReplyProgress } = await import('../../src/shared/companion-reply-progress');
  const old: CompanionReplyProgress = { revision: 5, phase: 'streaming', detail: '', startedAt: at(0), updatedAt: at(30),
    timing: { elapsedMs: 12000, activeSince: at(30) } };
  const recovered = finishCompanionReplyProgress(old, { phase: 'interrupted', detail: '先前进程已结束', updatedAt: at(86400) });
  expect(recovered.finishedAt).toBeUndefined(); expect(recovered.timingIncomplete).toBe(true);
  expect(recovered.timing).toEqual({ elapsedMs: 12000 });
  expect(companionReplyElapsedMs(recovered, start + 365 * 86400000)).toBe(12000);
  const resumed = advanceCompanionReplyTiming(recovered, { ...recovered, revision: 7, phase: 'tools', updatedAt: at(86410), finishedAt: undefined });
  const stopped = finishCompanionReplyProgress(resumed, { phase: 'completed', detail: '完成', updatedAt: at(86415), at: at(86415) });
  expect(stopped.timingIncomplete).toBe(true); expect(stopped.timing).toEqual({ elapsedMs: 17000 });
});

it('records a real host stop rather than a certificate or boot timestamp, and leaves unknown timings unknown', async () => {
  const { finishCompanionReplyProgress } = await import('../../src/shared/companion-reply-progress');
  const old: CompanionReplyProgress = { revision: 1, phase: 'context', detail: '', startedAt: at(0), updatedAt: at(5),
    timing: { elapsedMs: 3000, activeSince: at(5) } };
  const stopped = finishCompanionReplyProgress(old, { phase: 'completed', detail: '完成', updatedAt: at(17), at: at(15) });
  expect(stopped.finishedAt).toBe(at(15)); expect(stopped.timing).toEqual({ elapsedMs: 13000 });
  expect(stopped.timingIncomplete).toBeUndefined();
  const unknown = finishCompanionReplyProgress({ ...old, timing: undefined }, { phase: 'interrupted', detail: '结束', updatedAt: at(3600) });
  expect(unknown.timing).toBeUndefined(); expect(unknown.finishedAt).toBeUndefined(); expect(unknown.timingIncomplete).toBe(true);
});
