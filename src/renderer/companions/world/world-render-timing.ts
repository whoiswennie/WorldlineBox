type Point = { x: number; y: number };

/** An obsolete asynchronous compile cannot release a newer scene. */
export function worldScenePreparationGate() {
  let epoch = 0, ready = false;
  return {
    begin() { ready = false; return ++epoch; },
    complete(token: number) { if (token !== epoch) return false; ready = true; return true; },
    get ready() { return ready; },
  };
}

/** All visible observers retain an animation budget, irrespective of focus. */
export function worldTargetFrameRate(visibleWindowCount: number) {
  const count = Number.isFinite(visibleWindowCount) ? Math.max(1, visibleWindowCount) : 1;
  return count <= 3 ? 30 : count <= 6 ? 24 : 20;
}
/** Keep the remainder at a 60/144 Hz display instead of rounding 24 fps down to 20. */
export function worldAdvanceFrameClock(previous: number, now: number, visibleWindowCount: number) {
  const interval = 1000 / worldTargetFrameRate(visibleWindowCount);
  return Number.isFinite(previous) ? previous + Math.floor((now - previous + .5) / interval) * interval : now;
}
export function worldNextRenderDelay(input: { active: boolean; continuous: boolean; dirty: boolean; visibleWindowCount: number; sinceLastDrawMs: number; nextAnimationMs: number }) {
  if (!input.active) return undefined;
  const budgetDelay = Math.max(0, 1000 / worldTargetFrameRate(input.visibleWindowCount) - input.sinceLastDrawMs);
  if (input.continuous || input.dirty) return budgetDelay;
  return Number.isFinite(input.nextAnimationMs) ? Math.max(budgetDelay, input.nextAnimationMs) : undefined;
}
export function worldAnimationWakeDelay(startedAt: string, duration: number, playback: 'loop' | 'transition', now: number, backlog: boolean) {
  if (backlog) return Infinity;
  const elapsed = Math.max(0, now - Date.parse(startedAt)), validDuration = Math.max(1, duration);
  if (!Number.isFinite(elapsed) || playback === 'transition' && elapsed >= validDuration * 2 / 3) return Infinity;
  const frameDuration = validDuration / 3, inCycle = playback === 'loop' ? elapsed % validDuration : elapsed;
  return Math.max(1, Math.ceil((Math.floor(inCycle / frameDuration) + 1) * frameDuration - inCycle));
}
export function worldSnapshotInterpolationDuration(previousAt: string | undefined, nextAt: string) {
  const elapsed = previousAt ? Date.parse(nextAt) - Date.parse(previousAt) : 1000;
  return Number.isFinite(elapsed) && elapsed > 0 ? Math.max(50, Math.min(1250, elapsed)) : 1000;
}
/** Briefly finish only a received route; settled work/sleep poses use their host furniture immediately. */
export function worldArrivalPresentationDuration(activity: string, points: Point[], speed: number) {
  if (!['idle', 'seating', 'lyingDown', 'standingUp', 'waking', 'turning'].includes(activity) || points.length < 2) return 0;
  const distance = points.slice(1).reduce((total, point, index) => total + Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y), 0);
  return distance > .001 ? Math.min(220, distance / Math.max(.1, speed) * 1000) : 0;
}
/** Retain unshown corners when a new received position arrives during interpolation. */
export function worldRemainingPath(points: Point[], elapsed: number, duration: number): Point[] {
  if (points.length < 2) return points;
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y));
  let distance = lengths.reduce((sum, length) => sum + length, 0) * Math.max(0, Math.min(1, elapsed / Math.max(1, duration)));
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!;
    if (length > 0 && distance < length) {
      const start = points[i]!, end = points[i + 1]!, fraction = distance / length;
      return [{ x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction }, ...points.slice(i + 1)];
    }
    distance -= length;
  }
  return [points.at(-1)!];
}
export function worldContinuePath(previousPath: Point[], elapsed: number, duration: number, receivedPath: Point[]) {
  const remaining = worldRemainingPath(previousPath, elapsed, duration);
  if (!remaining.length || !receivedPath.length || Math.hypot(remaining.at(-1)!.x - receivedPath[0]!.x, remaining.at(-1)!.y - receivedPath[0]!.y) > .001) return receivedPath;
  return [...remaining, ...receivedPath.slice(1)];
}
