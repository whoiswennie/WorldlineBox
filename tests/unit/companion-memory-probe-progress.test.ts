import { expect, it } from 'vitest';
import { CompanionMemoryProbeProgressRecorder } from '../../src/main/companions/memory-probe-progress';
import { companionMemoryProbeProgressEventSchema, type CompanionMemoryProbeProgressEvent } from '../../src/shared/companion-memory-probe-progress';

it('accumulates revisited stages, ignores unknown labels, and never invents unobserved phase durations', () => {
  let now = 0;
  const events: CompanionMemoryProbeProgressEvent[] = [];
  const recorder = new CompanionMemoryProbeProgressRecorder({ requestId: 'phase-revisit', companionId: 'alice', mode: 'passive', now: () => now, onProgress: event => events.push(event) });
  recorder.stage('preparation'); now = 100; recorder.stage('queue');
  now = 350; recorder.stage('sources'); now = 500; recorder.stage('queue');
  const beforeUnknown = structuredClone(events); now = 650;
  for (const label of ['上游将来可能新增但目前未识别的环节', 'constructor', 'toString', '__proto__']) recorder.progress(label);
  expect(events).toEqual(beforeUnknown);
  now = 800; const receipt = recorder.complete();
  expect(receipt.totalMs).toBe(800);
  expect(receipt.stages.map(stage => [stage.id, stage.elapsedMs])).toEqual([['preparation', 100], ['queue', 550], ['sources', 150]]);
  expect(receipt.stages.some(stage => stage.id === 'retrieval' || stage.id === 'focus')).toBe(false);
  expect(events.every(event => companionMemoryProbeProgressEventSchema.safeParse(event).success)).toBe(true);
  expect(events.every((event, index) => !index || event.sequence! > events[index - 1]!.sequence!)).toBe(true);
});

it.each(['complete', 'fail'] as const)('freezes the first %s terminal receipt and ignores subsequent stages or terminal calls', terminal => {
  let now = 0;
  const events: CompanionMemoryProbeProgressEvent[] = [];
  const recorder = new CompanionMemoryProbeProgressRecorder({ requestId: 'terminal-freeze', companionId: 'alice', mode: 'active', now: () => now, onProgress: event => events.push(event) });
  recorder.stage('focus'); now = 1500; const receipt = recorder[terminal]();
  const frozen = structuredClone(receipt), count = events.length;
  expect(events.at(-1)?.state).toBe(terminal === 'complete' ? 'completed' : 'failed');
  now = 99_000; recorder.progress('核验本轮回忆'); recorder.stage('verification');
  expect(recorder.complete()).toEqual(frozen); expect(recorder.fail()).toEqual(frozen); expect(receipt).toEqual(frozen); expect(events).toHaveLength(count);
});

it('records legacy requests without requiring an event request id and isolates throwing observers', () => {
  let now = 0, calls = 0;
  const legacy = new CompanionMemoryProbeProgressRecorder({ companionId: 'alice', mode: 'active', now: () => now, onProgress: () => { calls++; } });
  legacy.stage('queue'); now = 42; const result = legacy.complete();
  expect(result.totalMs).toBe(42); expect(calls).toBe(0);
  const recorder = new CompanionMemoryProbeProgressRecorder({ requestId: 'observer-failure', companionId: 'alice', mode: 'passive', now: () => now,
    onProgress: () => { throw new Error('Observer is not the query engine'); } });
  expect(() => recorder.stage('focus')).not.toThrow(); now = 100;
  expect(() => recorder.complete()).not.toThrow();
});
