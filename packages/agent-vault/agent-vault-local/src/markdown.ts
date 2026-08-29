/** Markdown card parsing without model or embedding dependencies. */

import { createHash } from 'node:crypto'

/** Frontmatter and Wiki-link metadata extracted without a model. */
export interface MarkdownCard {
  readonly title: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly aliases: readonly string[]
  readonly sources: readonly string[]
  readonly headings: readonly string[]
  readonly links: readonly string[]
}

/**
 * Derive a compact optimistic revision.
 * @param content - Source content.
 * @returns Revision digest.
 */
export const revisionOf = (content: string): string =>
  createHash('sha256').update(content).digest('hex').slice(0, 24)

function scalar(content: string, key: string): string | undefined {
  const raw = new RegExp(`^${key}:\\s*(.+)$`, 'mu').exec(content)?.[1]?.trim()
  if (raw === undefined) return undefined
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return String(JSON.parse(raw)) } catch { return raw.slice(1, -1) }
  }
  return raw
}

function list(content: string, key: string): string[] {
  const raw = scalar(content, key)
  if (raw === undefined) return []
  if (raw.startsWith('[')) {
    try {
      const value = JSON.parse(raw) as unknown
      if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
    } catch { /* accept a human-authored comma list below */ }
  }
  return raw.replace(/^\[|\]$/gu, '').split(/[,，]/u).map(value => value.trim()).filter(Boolean)
}

/**
 * Parse one Markdown knowledge card.
 * @param content - Markdown source.
 * @param fallbackTitle - Filename-derived title.
 * @returns Parsed metadata.
 */
export function parseMarkdown(content: string, fallbackTitle: string): MarkdownCard {
  const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gmu)].map(match => match[1]?.trim() ?? '')
  const links = [...content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu)]
    .map(match => match[1]?.trim() ?? '').filter(Boolean)
  const title = scalar(content, 'title') ?? headings[0] ?? fallbackTitle
  const body = content.replace(/^---[\s\S]*?---\s*/u, '').replace(/^#{1,6}\s+.+$/gmu, '').trim()
  return {
    title,
    summary: scalar(content, 'summary') ?? body.slice(0, 320).replace(/\s+/gu, ' '),
    tags: list(content, 'tags'),
    aliases: list(content, 'aliases'),
    sources: list(content, 'sources'),
    headings,
    links,
  }
}

/**
 * Serialize a short-term memory card.
 * @param input - Normalized memory facts.
 * @returns Markdown source.
 */
export function memoryMarkdown(input: {
  readonly title: string
  readonly content: string
  readonly tags: readonly string[]
  readonly aliases: readonly string[]
  readonly sources: readonly string[]
  readonly importance: number
  readonly occurredAt: number
}): string {
  return [
    '---',
    `title: ${JSON.stringify(input.title)}`,
    `tags: ${JSON.stringify(input.tags)}`,
    `aliases: ${JSON.stringify(input.aliases)}`,
    `sources: ${JSON.stringify(input.sources)}`,
    `importance: ${String(input.importance)}`,
    `occurred_at: ${new Date(input.occurredAt).toISOString()}`,
    `summary: ${JSON.stringify(input.content.trim().slice(0, 320).replace(/\s+/gu, ' '))}`,
    '---', '', `# ${input.title}`, '', input.content.trim(), '',
  ].join('\n')
}

/**
 * Project a bounded document view.
 * @param content - Markdown source.
 * @param view - Projection mode.
 * @param selector - Section or grep selector.
 * @returns Selected text.
 */
export function readView(content: string, view: 'top' | 'section' | 'grep' | 'full', selector = ''): string {
  if (view === 'full') return content
  const lines = content.split('\n')
  if (view === 'top') return lines.slice(0, 80).join('\n')
  if (view === 'grep') {
    const query = selector.trim().toLocaleLowerCase()
    if (query === '') return lines.slice(0, 80).join('\n')
    const matches = new Set<number>()
    lines.forEach((line, index) => {
      if (line.toLocaleLowerCase().includes(query)) {
        for (let cursor = Math.max(0, index - 3); cursor <= Math.min(lines.length - 1, index + 3); cursor++) {
          matches.add(cursor)
        }
      }
    })
    return [...matches].sort((a, b) => a - b).slice(0, 120).map(index => lines[index]).join('\n')
  }
  const heading = selector.trim().replace(/^#+\s*/u, '')
  const start = lines.findIndex(line => line.replace(/^#+\s*/u, '').trim() === heading)
  if (start < 0) return ''
  const level = /^#+/u.exec(lines[start] ?? '')?.[0].length ?? 1
  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) {
    const next = /^#+/u.exec(lines[index] ?? '')?.[0].length
    if (next !== undefined && next <= level) { end = index; break }
  }
  return lines.slice(start, Math.min(end, start + 160)).join('\n')
}
