/** Wall-clock duration including queue and preparation. Missing timestamps do
 * not become a fictional zero-length task, and terminal records never tick. */
export function companionTaskDuration(startedAt: string | undefined, endedAt: string | undefined, now?: number): string | undefined {
  const start = Date.parse(startedAt ?? ''), end = endedAt ? Date.parse(endedAt) : now;
  if (!Number.isFinite(start) || end === undefined || !Number.isFinite(end) || end < start) return undefined;
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
}
