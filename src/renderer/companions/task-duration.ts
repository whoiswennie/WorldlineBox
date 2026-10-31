/** Wall-clock duration including queue and preparation. Missing timestamps do
 * not become a fictional zero-length task, and terminal records never tick. */
export function companionTaskDuration(startedAt: string | undefined, endedAt: string | undefined, now?: number): string | undefined {
  const start = Date.parse(startedAt ?? ''), end = endedAt ? Date.parse(endedAt) : now;
  if (!Number.isFinite(start) || end === undefined || !Number.isFinite(end) || end < start) return undefined;
  return companionDurationMilliseconds(end - start);
}

export function companionDurationMilliseconds(milliseconds: number): string | undefined {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
  const seconds = Math.floor(milliseconds / 1000);
  if (!Number.isSafeInteger(seconds)) return;
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
  // These are elapsed-time units, not calendar arithmetic: a month is thirty
  // days and a year is 365 days. Never format a long task as thousands of hours.
  let remaining = seconds;
  const parts: string[] = [];
  for (const [size, label] of [[365 * 86400, '年'], [30 * 86400, '个月'], [86400, '天'], [3600, '小时'], [60, '分']] as const) {
    const count = Math.floor(remaining / size);
    if (count) { parts.push(`${count} ${label}`); remaining %= size; }
  }
  parts.push(`${String(remaining).padStart(2, '0')} 秒`);
  return parts.join(' ');
}
