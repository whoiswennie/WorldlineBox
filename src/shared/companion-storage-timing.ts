import { z } from 'zod';

export const companionStorageTimingSegments = ['captureExpected', 'dispatch', 'capture', 'experienceProjection', 'experienceArchive',
  'invalidations', 'recoveryReconcile', 'recoveryBegin', 'recoveryPrepare', 'recoveryCommit', 'recoveryFinish'] as const;
export type CompanionStorageTimingSegment = typeof companionStorageTimingSegments[number];
const duration = z.number().finite().nonnegative();
/** Synchronous wall-clock spans. run/dispatch include their nested segments;
 * these fields overlap and must never be added to obtain request latency. */
export const companionStorageTimingSchema = z.strictObject({
  receivedEpochMs: duration, respondedEpochMs: duration, parseMs: duration, runMs: duration,
  segments: z.record(z.enum(companionStorageTimingSegments), duration),
});
export type CompanionStorageTiming = z.infer<typeof companionStorageTimingSchema>;
export type CompanionStorageTimingObserver = (segment: CompanionStorageTimingSegment, durationMs: number) => void;

let observer: CompanionStorageTimingObserver | undefined;
/** Worker dispatch is synchronous; no context survives a call, even on error. */
export function withCompanionStorageTiming<T>(onTiming: CompanionStorageTimingObserver, operation: () => T): T {
  const previous = observer; observer = onTiming;
  try { return operation(); } finally { observer = previous; }
}
export function companionStorageTimingNow(): number | undefined { return observer ? performance.now() : undefined; }
export function recordCompanionStorageTiming(segment: CompanionStorageTimingSegment, started: number | undefined): void {
  if (started === undefined || !observer) return;
  try { const elapsed = performance.now() - started; if (Number.isFinite(elapsed)) observer(segment, Math.max(0, elapsed)); }
  catch { /* Telemetry cannot change a transaction or its original exception. */ }
}
export function measureCompanionStorageTiming<T>(segment: CompanionStorageTimingSegment, operation: () => T): T {
  const started = companionStorageTimingNow();
  try { return operation(); } finally { recordCompanionStorageTiming(segment, started); }
}
export function emptyCompanionStorageTimingSegments(): CompanionStorageTiming['segments'] {
  return Object.fromEntries(companionStorageTimingSegments.map(segment => [segment, 0])) as CompanionStorageTiming['segments'];
}
