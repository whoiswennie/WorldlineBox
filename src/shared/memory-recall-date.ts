export function memoryRecallDate(candidate: Record<string, unknown>): string | undefined {
  for (const value of [candidate.date, candidate.createdAt, candidate.created_at, candidate.timestamp]) {
    if (typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value))) return value;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) { const date = new Date(value < 1e12 ? value * 1000 : value); if (Number.isFinite(date.getTime())) return date.toISOString(); }
  }
  // VCP's formatted RAG rows carry their diary timestamp in the heading even
  // when the retrieval event omits a separate date field. Never infer it from
  // an arbitrary event mentioned inside the diary body.
  const heading = typeof candidate.text === 'string' ? /^\s*\[(\d{4}-\d{2}-\d{2})\][^\n]*(?:\r?\n\s*\[([0-2]\d:[0-5]\d(?::[0-5]\d)?)\])?/.exec(candidate.text) : null;
  if (!heading) return;
  const date = new Date(heading[1] + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== heading[1]) return;
  return heading[1] + (heading[2] && Number(heading[2].slice(0, 2)) < 24 ? ' ' + heading[2] : '');
}
