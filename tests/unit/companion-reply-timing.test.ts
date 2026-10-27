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
