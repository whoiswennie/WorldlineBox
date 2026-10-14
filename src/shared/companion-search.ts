/** Encoded Unicode characters preserve substring positions, including 1–2 Han
 * characters. FTS5's stock trigram tokenizer cannot index these short queries.
 * Both writes and queries use this same normalization; no LIKE fallback scans. */
export function normalizeCompanionSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}
export function companionSearchTokens(text: string): string {
  return Array.from(normalizeCompanionSearch(text), char => 'u' + char.codePointAt(0)!.toString(16)).join(' ');
}
export function companionSearchFacet(text: string): string {
  return Array.from(text, char => char.codePointAt(0)!.toString(16)).join('x');
}
export function companionSearchMatch(query: string): string {
  return query.trim().split(/\s+/u).filter(Boolean).map(term => '"' + companionSearchTokens(term) + '"').join(' AND ');
}
export function companionSearchExcerpt(text: string, query: string): string {
  const terms = query.trim().split(/\s+/u).filter(Boolean);
  const normalized = normalizeCompanionSearch(text);
  const matches = terms.map(term => normalized.indexOf(normalizeCompanionSearch(term))).filter(index => index >= 0);
  const start = Math.max(0, (matches.length ? Math.min(...matches) : 0) - 70);
  return (start ? '…' : '') + text.slice(start, start + 480) + (text.length > start + 480 ? '…' : '');
}
