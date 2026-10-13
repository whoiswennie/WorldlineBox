export function companionTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间不可用';
  const pad = (part: number, width = 2) => String(part).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
export function companionTimezone(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const offset = -date.getTimezoneOffset(), minutes = Math.abs(offset);
  const rawZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = /^Etc\/GMT|^UTC$/.test(rawZone) ? '本地时区' : rawZone;
  return `${zone} · UTC${offset >= 0 ? '+' : '-'}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
