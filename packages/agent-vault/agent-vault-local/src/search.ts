/** Deterministic lexical recall scoring for bounded SQLite candidates. */

const clean = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().trim()

/**
 * Expand Chinese and Latin input into bounded lexical terms.
 * @param query - Natural-language query.
 * @param tags - Optional tags.
 * @returns Normalized terms.
 */
export function queryTerms(query: string, tags: readonly string[] = []): string[] {
  const base = clean(`${query} ${tags.join(' ')}`)
  const words = base.match(/[\p{L}\p{N}_-]+/gu) ?? []
  const terms = new Set(words)
  for (const word of words) {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(word)) {
      for (let size = 2; size <= Math.min(4, word.length); size++) {
        for (let index = 0; index + size <= word.length; index++) terms.add(word.slice(index, index + size))
      }
    }
  }
  return [...terms].filter(Boolean).slice(0, 32)
}

function grams(value: string): Set<string> {
  const normalized = clean(value).replace(/\s+/gu, '')
  if (normalized.length <= 2) return new Set(normalized === '' ? [] : [normalized])
  return new Set(Array.from({ length: normalized.length - 2 }, (_, index) => normalized.slice(index, index + 3)))
}

/**
 * Compute trigram Dice similarity.
 * @param left - First string.
 * @param right - Second string.
 * @returns Similarity from zero to one.
 */
export function dice(left: string, right: string): number {
  const a = grams(left)
  const b = grams(right)
  if (a.size === 0 || b.size === 0) return 0
  let overlap = 0
  for (const item of a) if (b.has(item)) overlap++
  return (2 * overlap) / (a.size + b.size)
}

/**
 * Score one bounded FTS candidate with deterministic signals.
 * @param input - Candidate signals.
 * @returns Score and explanations.
 */
export function scoreCandidate(input: {
  readonly query: string
  readonly terms: readonly string[]
  readonly path: string
  readonly title: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly aliases: readonly string[]
  readonly rank: number
}): { score: number; reasons: string[]; matched: string[] } {
  const query = clean(input.query)
  const title = clean(input.title)
  const aliases = input.aliases.map(clean)
  const tags = input.tags.map(clean)
  const search = clean(`${input.path} ${input.title} ${input.summary} ${input.tags.join(' ')} ${input.aliases.join(' ')}`)
  const matched = input.terms.filter(term => search.includes(clean(term)))
  const reasons: string[] = []
  let score = Math.max(0, 24 - Math.max(0, input.rank))
  if (title === query) { score += 80; reasons.push('exact-title') }
  else if (title.includes(query) || query.includes(title)) { score += 42; reasons.push('title-substring') }
  if (aliases.includes(query)) { score += 72; reasons.push('exact-alias') }
  if (tags.includes(query)) { score += 64; reasons.push('exact-tag') }
  const similarity = Math.max(dice(query, title), ...aliases.map(alias => dice(query, alias)), 0)
  if (similarity >= 0.35) { score += similarity * 36; reasons.push('character-ngram') }
  score += Math.min(30, matched.length * 6)
  if (matched.length > 0) reasons.push('term-overlap')
  return { score, reasons, matched }
}
