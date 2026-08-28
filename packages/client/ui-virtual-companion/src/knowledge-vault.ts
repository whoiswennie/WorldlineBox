/** Disk-first, progressively disclosed Markdown knowledge vault for people and Agents. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export type KnowledgeReadView = 'top' | 'section' | 'grep' | 'full'
export interface KnowledgeTreeEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'directory' | 'document'
  readonly children?: number
  readonly updatedAt?: number
  readonly size?: number
}
export interface KnowledgeSearchResult {
  readonly scope: string
  readonly path: string
  readonly title: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly revision: string
  readonly updatedAt: number
}
/** Bounded model-free candidate metadata emitted before any progressive body read. */
export interface KnowledgeDiscoveryResult extends KnowledgeSearchResult {
  readonly confidence: 'high' | 'medium'
  readonly score: number
  readonly reasons: readonly string[]
  readonly matchedTerms: readonly string[]
}
export interface KnowledgeDocument extends KnowledgeSearchResult {
  readonly content: string
  readonly headings: readonly string[]
  readonly links: readonly string[]
  readonly sources: readonly string[]
  readonly totalLines: number
  readonly view: KnowledgeReadView
}
export interface KnowledgeAudit {
  readonly brokenLinks: readonly { readonly source: string; readonly target: string }[]
  readonly orphaned: readonly string[]
  readonly missingSources: readonly string[]
}

export class KnowledgeConflictError extends Error {
  constructor(readonly current: KnowledgeDocument) {
    super('知识页已被其他编辑者更新，请合并后重试')
  }
}

const VAULT_GUIDE = `# Worldline Knowledge Vault

This vault is durable, human-editable Markdown. Use the knowledge tool with progressive disclosure.

1. Search or inspect the manifest before reading documents.
2. Read top or a named section before requesting a full document.
3. Keep one durable subject per page and connect related subjects with [[wikilinks]].
4. Distinguish sourced facts, user statements, memories, and inferences. Never invent provenance.
5. Prefer updating an existing page over creating a duplicate.
6. Put unresolved conflicts and maintenance notes in talk/ rather than silently overwriting claims.
7. Keep raw sources immutable under raw/. Never store credentials or secrets.
`
const DEFAULT_INDEX = `---
title: Vault index
tags: [index]
summary: Progressive entry point for this knowledge vault.
sources: []
---

# Vault index

Use this page as a concise map. Link durable subjects with [[wikilinks]].
`

function safeScope(value: string): string {
  const scope = value.trim().toLocaleLowerCase('en-US')
  if (scope === 'public') return scope
  if (!/^[a-z\d][a-z\d-]{0,119}$/u.test(scope)) throw new Error('invalid knowledge scope')
  return scope
}
function safePath(value: string, directory = false): string {
  const normalized = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/gu, '')
  if (normalized === '') return ''
  if (
    normalized
      .split('/')
      .some(part => part === '' || part === '.' || part === '..' || /[\u0000-\u001f]/u.test(part))
  )
    throw new Error('invalid knowledge path')
  if (!directory && extname(normalized).toLocaleLowerCase('en-US') !== '.md')
    throw new Error('knowledge documents must be Markdown')
  return normalized
}
const revision = (content: string): string =>
  createHash('sha256').update(content).digest('hex').slice(0, 24)
function scalar(content: string, key: string): string | undefined {
  const raw = new RegExp(`^${key}:\\s*(.+)$`, 'mu').exec(content)?.[1]?.trim()
  if (raw === undefined) return undefined
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return String(JSON.parse(raw))
    } catch {
      return raw.slice(1, -1)
    }
  }
  return raw
}
function list(content: string, key: string): string[] {
  const raw = scalar(content, key)
  if (raw === undefined) return []
  if (raw.startsWith('[')) {
    try {
      const value = JSON.parse(raw) as unknown
      if (Array.isArray(value))
        return value.filter((item): item is string => typeof item === 'string')
    } catch {
      /* forgiving fallback */
    }
  }
  return raw
    .replace(/^\[|\]$/gu, '')
    .split(/[,，]/u)
    .map(value => value.trim().replace(/^['"]|['"]$/gu, ''))
    .filter(Boolean)
}
function metadata(content: string, path: string) {
  const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gmu)]
    .map(match => match[1]?.trim() ?? '')
    .filter(Boolean)
  const body = content
    .replace(/^---\s*\n[\s\S]*?\n---\s*/u, '')
    .replace(/^#\s+.*$/mu, '')
    .trim()
  return {
    title: scalar(content, 'title') ?? headings[0] ?? basename(path, '.md'),
    summary: scalar(content, 'summary') ?? body.replace(/\s+/gu, ' ').slice(0, 280),
    tags: list(content, 'tags'),
    sources: list(content, 'sources'),
    headings,
    links: [
      ...new Set(
        [...content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu)]
          .map(match => match[1]?.trim().replaceAll('\\', '/') ?? '')
          .filter(Boolean),
      ),
    ],
  }
}
const queryForFts = (query: string): string =>
  query
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map(term => `"${term.replaceAll('"', '""')}"*`)
    .join(' OR ')

const DISCOVERY_STOP_TERMS = new Set([
  'knowledge', 'builtin', 'index', 'public', 'private', '共享', '公共', '知识', '知识库',
  '资料', '页面', '内容', '信息', '关于', '这个', '那个', '我们', '你们', '他们',
])

function discoveryAliases(title: string, tags: readonly string[]): string[] {
  const values = new Set<string>([title, ...tags])
  for (const part of title.split(/[（(【[:：·|/]/u)) values.add(part)
  return [...values]
    .map(value => value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN'))
    .filter(value => value.length >= 2 && !DISCOVERY_STOP_TERMS.has(value))
    .sort((a, b) => b.length - a.length)
}

function lexicalDiscoveryQueries(text: string): string[] {
  const normalized = text.normalize('NFKC')
  const values = new Set<string>()
  for (const match of normalized.matchAll(/[\p{Letter}\p{Number}][\p{Letter}\p{Number}._+-]{2,47}/gu)) {
    values.add(match[0])
  }
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,20}/gu)) {
    const value = match[0]
    if (DISCOVERY_STOP_TERMS.has(value)) continue
    values.add(value)
    if (value.length > 8) {
      for (let index = Math.max(0, value.length - 12); index <= value.length - 3; index += 1) {
        values.add(value.slice(index, Math.min(value.length, index + 6)))
      }
    }
  }
  return [...values].slice(-16)
}
function section(content: string, heading: string): string {
  const lines = content.split('\n')
  const target = heading.trim().toLocaleLowerCase('zh-CN')
  const start = lines.findIndex(
    line =>
      /^#{1,6}\s+/u.test(line) &&
      line
        .replace(/^#{1,6}\s+/u, '')
        .trim()
        .toLocaleLowerCase('zh-CN') === target,
  )
  if (start < 0) throw new Error(`knowledge section not found: ${heading}`)
  const level = /^#+/u.exec(lines[start] ?? '')?.[0].length ?? 1
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const next = /^(#+)\s+/u.exec(lines[index] ?? '')
    if ((next?.[1]?.length ?? level + 1) <= level) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

/** Markdown is authoritative; SQLite is an incrementally synchronized, rebuildable projection. */
export class KnowledgeVault {
  private database: DatabaseSync | undefined
  private searchStatement: StatementSync | undefined
  private mutation = Promise.resolve()
  constructor(private readonly root: string) {}

  async initialize(scopes: readonly string[]): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const { DatabaseSync } = await import('node:sqlite')
    this.database = new DatabaseSync(join(this.root, 'knowledge-index.sqlite'))
    this.database.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS knowledge_documents(scope TEXT NOT NULL,path TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,tags TEXT NOT NULL,links TEXT NOT NULL,sources TEXT NOT NULL,content TEXT NOT NULL,revision TEXT NOT NULL,updated_at INTEGER NOT NULL,size INTEGER NOT NULL,disk_path TEXT NOT NULL,PRIMARY KEY(scope,path)) STRICT;
      CREATE INDEX IF NOT EXISTS knowledge_by_scope_updated ON knowledge_documents(scope,updated_at DESC,path);
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(scope UNINDEXED,path UNINDEXED,title,summary,tags,content,content='knowledge_documents',content_rowid='rowid',tokenize='unicode61',prefix='2 3');
      CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_documents BEGIN INSERT INTO knowledge_fts(rowid,scope,path,title,summary,tags,content) VALUES(new.rowid,new.scope,new.path,new.title,new.summary,new.tags,new.content); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_documents BEGIN INSERT INTO knowledge_fts(knowledge_fts,rowid,scope,path,title,summary,tags,content) VALUES('delete',old.rowid,old.scope,old.path,old.title,old.summary,old.tags,old.content); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_documents BEGIN INSERT INTO knowledge_fts(knowledge_fts,rowid,scope,path,title,summary,tags,content) VALUES('delete',old.rowid,old.scope,old.path,old.title,old.summary,old.tags,old.content); INSERT INTO knowledge_fts(rowid,scope,path,title,summary,tags,content) VALUES(new.rowid,new.scope,new.path,new.title,new.summary,new.tags,new.content); END;
    `)
    this.searchStatement = this.database.prepare(
      'SELECT d.scope,d.path,d.title,d.summary,d.tags,d.revision,d.updated_at FROM knowledge_fts JOIN knowledge_documents d ON d.rowid=knowledge_fts.rowid WHERE knowledge_fts MATCH ? AND d.scope IN (SELECT value FROM json_each(?)) ORDER BY bm25(knowledge_fts,0,0,8,5,4,1),d.updated_at DESC LIMIT ? OFFSET ?',
    )
    for (const scope of ['public', ...scopes]) await this.ensureScope(scope)
    await this.synchronize()
  }
  close(): void {
    this.database?.close()
    this.database = undefined
    this.searchStatement = undefined
  }
  async ensureScope(value: string): Promise<void> {
    const root = this.scopeRoot(safeScope(value))
    await Promise.all(
      [
        'pages',
        'pages/entities',
        'pages/concepts',
        'pages/synthesis',
        'pages/memories',
        'raw',
        'inbox',
        'talk',
        '.trash',
      ].map(folder => mkdir(join(root, folder), { recursive: true })),
    )
    await this.ensureFile(join(root, 'AGENTS.md'), VAULT_GUIDE)
    await this.ensureFile(join(root, 'pages', 'index.md'), DEFAULT_INDEX)
  }
  scopes(): readonly string[] {
    const values = (
      this.database
        ?.prepare('SELECT DISTINCT scope FROM knowledge_documents ORDER BY scope')
        .all() ?? []
    ).map(row => String((row as Record<string, unknown>)['scope']))
    return values.includes('public') ? values : ['public', ...values]
  }
  tree(scopeValue: string, directory = '', cursor = 0, limit = 200): KnowledgeTreeEntry[] {
    const scope = safeScope(scopeValue)
    const path = safePath(directory, true)
    const prefix = path === '' ? '' : `${path}/`
    const rows =
      this.database
        ?.prepare(
          'SELECT path,updated_at,size FROM knowledge_documents WHERE scope=? AND path LIKE ? ORDER BY path LIMIT 10000',
        )
        .all(scope, `${prefix}%`) ?? []
    const entries = new Map<string, KnowledgeTreeEntry>()
    for (const value of rows) {
      const row = value as Record<string, unknown>
      const full = String(row['path'])
      const rest = full.slice(prefix.length)
      if (rest === '' || rest.startsWith('.trash/')) continue
      const slash = rest.indexOf('/')
      if (slash < 0)
        entries.set(rest, {
          name: rest,
          path: full,
          kind: 'document',
          updatedAt: Number(row['updated_at']),
          size: Number(row['size']),
        })
      else {
        const name = rest.slice(0, slash)
        const old = entries.get(name)
        entries.set(name, {
          name,
          path: `${prefix}${name}`,
          kind: 'directory',
          children: (old?.children ?? 0) + 1,
        })
      }
    }
    return [...entries.values()]
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN') : a.kind === 'directory' ? -1 : 1,
      )
      .slice(Math.max(0, cursor), Math.max(0, cursor) + Math.max(1, Math.min(500, limit)))
  }
  search(
    scopes: readonly string[],
    query: string,
    cursor = 0,
    limit = 20,
  ): KnowledgeSearchResult[] {
    const allowed = [...new Set(scopes.map(safeScope))]
    if (allowed.length === 0 || query.trim() === '') return []
    return (
      this.searchStatement?.all(
        queryForFts(query),
        JSON.stringify(allowed),
        Math.max(1, Math.min(50, limit)),
        Math.max(0, cursor),
      ) ?? []
    ).map(value => this.result(value as Record<string, unknown>))
  }
  /**
   * Discover a tiny ranked manifest without loading document bodies. Exact title/tag aliases
   * are evaluated before lexical FTS so Chinese entities remain reliable without embeddings.
   * @param scopes - Public and actor-owned scopes visible to the current Agent.
   * @param signalText - Recent user, tool, and room signals for this step.
   * @param limit - Maximum candidate count; clamped to the safe manifest bound.
   * @returns Ranked metadata candidates without full document bodies.
   */
  discover(
    scopes: readonly string[],
    signalText: string,
    limit = 3,
  ): KnowledgeDiscoveryResult[] {
    const allowed = [...new Set(scopes.map(safeScope))]
    const text = signalText
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN')
      .slice(-8_000)
    if (allowed.length === 0 || text.trim() === '') return []
    const rows = this.database
      ?.prepare('SELECT scope,path,title,summary,tags,revision,updated_at FROM knowledge_documents WHERE scope IN (SELECT value FROM json_each(?)) AND path NOT LIKE ?')
      .all(JSON.stringify(allowed), '.trash/%') ?? []
    const ranked = new Map<string, KnowledgeDiscoveryResult>()
    for (const value of rows) {
      const result = this.result(value)
      const matches = discoveryAliases(result.title, result.tags).filter(alias => text.includes(alias))
      if (matches.length === 0) continue
      const titleAliases = discoveryAliases(result.title, [])
      const titleMatch = matches.some(alias => titleAliases.includes(alias))
      ranked.set(`${result.scope}:${result.path}`, {
        ...result,
        confidence: 'high',
        score: Math.min(
          1,
          (titleMatch ? 0.96 : 0.9) + Math.min(0.04, (matches[0]?.length ?? 0) / 200),
        ),
        reasons: [titleMatch ? 'exact-title-alias' : 'exact-tag-alias'],
        matchedTerms: matches.slice(0, 4),
      })
    }
    for (const query of lexicalDiscoveryQueries(text)) {
      for (const result of this.search(allowed, query, 0, Math.max(4, limit))) {
        const key = `${result.scope}:${result.path}`
        if (ranked.has(key)) continue
        ranked.set(key, {
          ...result,
          confidence: 'medium',
          score: 0.62,
          reasons: ['fts-lexical'],
          matchedTerms: [query],
        })
      }
    }
    return [...ranked.values()]
      .sort((a, b) => b.score - a.score
        || (b.matchedTerms[0]?.length ?? 0) - (a.matchedTerms[0]?.length ?? 0)
        || b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(8, limit)))
  }
  read(
    scopeValue: string,
    pathValue: string,
    view: KnowledgeReadView = 'top',
    selector = '',
  ): Promise<KnowledgeDocument> {
    const scope = safeScope(scopeValue)
    const path = safePath(pathValue)
    const row = this.database
      ?.prepare('SELECT * FROM knowledge_documents WHERE scope=? AND path=?')
      .get(scope, path) as Record<string, unknown> | undefined
    if (row === undefined)
      return Promise.reject(new Error(`knowledge document not found: ${scope}/${path}`))
    const full = String(row['content'])
    let content = full
    if (view === 'top') content = full.split('\n').slice(0, 80).join('\n')
    if (view === 'section') content = section(full, selector)
    if (view === 'grep') {
      const needle = selector.trim().toLocaleLowerCase('zh-CN')
      content = full
        .split('\n')
        .flatMap((line, index, lines) =>
          line.toLocaleLowerCase('zh-CN').includes(needle)
            ? lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2))
            : [],
        )
        .slice(0, 120)
        .join('\n')
    }
    return Promise.resolve(this.document(row, content, view))
  }
  async write(
    scopeValue: string,
    pathValue: string,
    contentValue: string,
    expectedRevision?: string,
  ): Promise<KnowledgeDocument> {
    const scope = safeScope(scopeValue)
    const path = safePath(pathValue)
    const content = contentValue.endsWith('\n') ? contentValue : `${contentValue}\n`
    if (Buffer.byteLength(content, 'utf8') > 2 * 1_024 * 1_024)
      throw new Error('knowledge document exceeds 2 MiB')
    return await this.exclusive(async () => {
      await this.ensureScope(scope)
      const old = this.database
        ?.prepare('SELECT * FROM knowledge_documents WHERE scope=? AND path=?')
        .get(scope, path) as Record<string, unknown> | undefined
      if (
        expectedRevision !== undefined &&
        old !== undefined &&
        String(old['revision']) !== expectedRevision
      )
        throw new KnowledgeConflictError(this.document(old, String(old['content']), 'full'))
      if (expectedRevision !== undefined && old === undefined && expectedRevision !== '')
        throw new Error('knowledge document was removed')
      const target = this.resolvePath(scope, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFileAtomic(target, content, { mode: 0o600, dirMode: 0o700 })
      const info = await stat(target)
      this.index(scope, path, content, info.mtimeMs, info.size, target)
      return await this.read(scope, path, 'full')
    })
  }
  async create(scope: string, folder: string, titleValue: string): Promise<KnowledgeDocument> {
    const title = titleValue.trim().slice(0, 160)
    if (title === '') throw new Error('knowledge title is required')
    const slug =
      title
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 100) || `note-${Date.now().toString(36)}`
    const base = safePath(folder, true)
    let path = `${base === '' ? '' : `${base}/`}${slug}.md`
    let suffix = 2
    while (this.has(scope, path)) {
      path = `${base === '' ? '' : `${base}/`}${slug}-${suffix}.md`
      suffix += 1
    }
    return await this.write(
      scope,
      path,
      `---\ntitle: ${JSON.stringify(title)}\ntags: []\nsummary: \nsources: []\n---\n\n# ${title}\n\n`,
      '',
    )
  }
  async remember(
    scopeValue: string,
    titleValue: string,
    body: string,
    tags: readonly string[] = [],
  ): Promise<KnowledgeDocument> {
    const scope = safeScope(scopeValue)
    const title = titleValue.trim().slice(0, 160)
    if (title === '' || body.trim() === '')
      throw new Error('knowledge title and content are required')
    const slug =
      title
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 100) || `memory-${Date.now().toString(36)}`
    const path = `pages/synthesis/${slug}.md`
    const current = await this.read(scope, path, 'full').catch(() => undefined)
    const uniqueTags = [
      ...new Set(
        tags.map(tag => tag.trim().normalize('NFKC').toLocaleLowerCase('zh-CN')).filter(Boolean),
      ),
    ]
    const content = `---\ntitle: ${JSON.stringify(title)}\ntags: ${JSON.stringify(uniqueTags)}\nsummary: ${JSON.stringify(body.trim().replace(/\s+/gu, ' ').slice(0, 280))}\nsources: []\n---\n\n# ${title}\n\n${body.trim()}\n`
    return await this.write(scope, path, content, current?.revision ?? '')
  }
  /** Install bundled starter knowledge once while preserving later human edits. */
  async seed(
    scopeValue: string,
    titleValue: string,
    body: string,
    tags: readonly string[] = [],
  ): Promise<KnowledgeDocument> {
    const scope = safeScope(scopeValue)
    const title = titleValue.trim().slice(0, 160)
    const slug =
      title
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 100) || `memory-${Date.now().toString(36)}`
    const path = `pages/synthesis/${slug}.md`
    const existing = await this.read(scope, path, 'full').catch(() => undefined)
    return existing ?? (await this.remember(scope, title, body, tags))
  }
  async move(
    scopeValue: string,
    sourceValue: string,
    targetValue: string,
    expectedRevision: string,
  ): Promise<KnowledgeDocument> {
    const scope = safeScope(scopeValue)
    const source = safePath(sourceValue)
    const target = safePath(targetValue)
    return await this.exclusive(async () => {
      const current = await this.read(scope, source, 'full')
      if (current.revision !== expectedRevision) throw new KnowledgeConflictError(current)
      if (this.has(scope, target)) throw new Error('target knowledge path already exists')
      const disk = this.resolvePath(scope, target)
      await mkdir(dirname(disk), { recursive: true })
      await rename(this.resolvePath(scope, source), disk)
      this.database
        ?.prepare('DELETE FROM knowledge_documents WHERE scope=? AND path=?')
        .run(scope, source)
      const info = await stat(disk)
      this.index(scope, target, current.content, info.mtimeMs, info.size, disk)
      return await this.read(scope, target, 'full')
    })
  }
  async trash(scopeValue: string, pathValue: string, expectedRevision: string): Promise<void> {
    const scope = safeScope(scopeValue)
    const path = safePath(pathValue)
    await this.exclusive(async () => {
      const current = await this.read(scope, path, 'full')
      if (current.revision !== expectedRevision) throw new KnowledgeConflictError(current)
      const target = this.resolvePath(scope, `.trash/${Date.now().toString(36)}-${basename(path)}`)
      await mkdir(dirname(target), { recursive: true })
      await rename(this.resolvePath(scope, path), target)
      this.database
        ?.prepare('DELETE FROM knowledge_documents WHERE scope=? AND path=?')
        .run(scope, path)
    })
  }
  async removeScope(value: string): Promise<void> {
    const scope = safeScope(value)
    if (scope === 'public') throw new Error('public knowledge vault cannot be removed')
    await rm(this.scopeRoot(scope), { recursive: true, force: true })
    this.database?.prepare('DELETE FROM knowledge_documents WHERE scope=?').run(scope)
  }
  /**
   * Remove every private page and recreate the canonical empty vault structure.
   * @param value - Private companion scope to reset.
   */
  async resetScope(value: string): Promise<void> {
    const scope = safeScope(value)
    if (scope === 'public') throw new Error('public knowledge vault cannot be reset as a companion')
    await this.removeScope(scope)
    await this.ensureScope(scope)
  }
  backlinks(scopeValue: string, pathValue: string): KnowledgeSearchResult[] {
    const scope = safeScope(scopeValue)
    const target = safePath(pathValue).replace(/\.md$/iu, '')
    const rows =
      this.database
        ?.prepare(
          'SELECT scope,path,title,summary,tags,revision,updated_at,links FROM knowledge_documents WHERE scope=?',
        )
        .all(scope) ?? []
    return rows.flatMap((value) => {
      const row = value as Record<string, unknown>
      const links = JSON.parse(String(row['links'])) as string[]
      return links.some(
        link => link.replace(/\.md$/iu, '') === target || basename(link) === basename(target),
      )
        ? [this.result(row)]
        : []
    })
  }
  audit(scopeValue: string): KnowledgeAudit {
    const scope = safeScope(scopeValue)
    const rows = (
      this.database
        ?.prepare('SELECT path,links,sources FROM knowledge_documents WHERE scope=?')
        .all(scope) ?? []
    ).map(value => value as Record<string, unknown>)
    const paths = new Set(rows.map(row => String(row['path']).replace(/\.md$/iu, '')))
    const linked = new Set<string>()
    const brokenLinks: Array<{ source: string; target: string }> = []
    const missingSources: string[] = []
    for (const row of rows) {
      const source = String(row['path'])
      for (const raw of JSON.parse(String(row['links'])) as string[]) {
        const target = raw.replace(/\.md$/iu, '')
        const found =
          paths.has(target) || [...paths].some(path => basename(path) === basename(target))
        if (found) linked.add(target)
        else brokenLinks.push({ source, target: raw })
      }
      if (
        !source.endsWith('index.md') &&
        (JSON.parse(String(row['sources'])) as string[]).length === 0
      )
        missingSources.push(source)
    }
    return {
      brokenLinks,
      orphaned: [...paths].filter(path => !path.endsWith('index') && !linked.has(path)),
      missingSources,
    }
  }

  private scopeRoot(scope: string): string {
    return scope === 'public'
      ? join(this.root, 'public')
      : join(this.root, 'companions', scope.slice(0, 2), scope)
  }
  private resolvePath(scope: string, path: string): string {
    const root = resolve(this.scopeRoot(scope))
    const target = resolve(root, ...path.split('/'))
    const distance = relative(root, target)
    if (distance.startsWith('..') || resolve(root, distance) !== target)
      throw new Error('invalid knowledge path')
    return target
  }
  private has(scopeValue: string, pathValue: string): boolean {
    return (
      this.database
        ?.prepare('SELECT 1 FROM knowledge_documents WHERE scope=? AND path=?')
        .get(safeScope(scopeValue), safePath(pathValue)) !== undefined
    )
  }
  private index(
    scope: string,
    path: string,
    content: string,
    updatedAt: number,
    size: number,
    diskPath: string,
  ): void {
    const meta = metadata(content, path)
    this.database
      ?.prepare(
        'INSERT INTO knowledge_documents(scope,path,title,summary,tags,links,sources,content,revision,updated_at,size,disk_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,path) DO UPDATE SET title=excluded.title,summary=excluded.summary,tags=excluded.tags,links=excluded.links,sources=excluded.sources,content=excluded.content,revision=excluded.revision,updated_at=excluded.updated_at,size=excluded.size,disk_path=excluded.disk_path',
      )
      .run(
        scope,
        path,
        meta.title,
        meta.summary,
        JSON.stringify(meta.tags),
        JSON.stringify(meta.links),
        JSON.stringify(meta.sources),
        content,
        revision(content),
        Math.trunc(updatedAt),
        size,
        diskPath,
      )
  }
  private result(row: Record<string, unknown>): KnowledgeSearchResult {
    return {
      scope: String(row['scope']),
      path: String(row['path']),
      title: String(row['title']),
      summary: String(row['summary']),
      tags: JSON.parse(String(row['tags'])) as string[],
      revision: String(row['revision']),
      updatedAt: Number(row['updated_at']),
    }
  }
  private document(
    row: Record<string, unknown>,
    content: string,
    view: KnowledgeReadView,
  ): KnowledgeDocument {
    const full = String(row['content'])
    const meta = metadata(full, String(row['path']))
    return {
      ...this.result(row),
      content,
      headings: meta.headings,
      links: meta.links,
      sources: meta.sources,
      totalLines: full.split('\n').length,
      view,
    }
  }
  private async synchronize(): Promise<void> {
    const seen = new Set<string>()
    for (const scope of await this.diskScopes()) {
      const root = this.scopeRoot(scope)
      for (const disk of await this.markdownFiles(root)) {
        const path = relative(root, disk).split(sep).join('/')
        const info = await stat(disk)
        seen.add(`${scope}\n${path}`)
        const old = this.database
          ?.prepare('SELECT updated_at,size FROM knowledge_documents WHERE scope=? AND path=?')
          .get(scope, path) as Record<string, unknown> | undefined
        if (
          old !== undefined &&
          Number(old['updated_at']) === Math.trunc(info.mtimeMs) &&
          Number(old['size']) === info.size
        )
          continue
        this.index(scope, path, await readFile(disk, 'utf8'), info.mtimeMs, info.size, disk)
      }
    }
    const rows = this.database?.prepare('SELECT scope,path FROM knowledge_documents').all() ?? []
    const remove = this.database?.prepare(
      'DELETE FROM knowledge_documents WHERE scope=? AND path=?',
    )
    for (const value of rows) {
      const row = value as Record<string, unknown>
      const scope = String(row['scope'])
      const path = String(row['path'])
      if (!seen.has(`${scope}\n${path}`)) remove?.run(scope, path)
    }
  }
  private async diskScopes(): Promise<string[]> {
    const result = ['public']
    for (const prefix of await readdir(join(this.root, 'companions'), {
      withFileTypes: true,
    }).catch(() => [])) {
      if (!prefix.isDirectory()) continue
      for (const entry of await readdir(join(this.root, 'companions', prefix.name), {
        withFileTypes: true,
      }).catch(() => []))
        if (entry.isDirectory()) result.push(safeScope(entry.name))
    }
    return result
  }
  private async markdownFiles(root: string): Promise<string[]> {
    const result: string[] = []
    const pending = [root]
    while (pending.length > 0) {
      const current = pending.pop()
      if (current === undefined) break
      for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '.trash') pending.push(path)
        } else if (entry.isFile() && entry.name.toLocaleLowerCase('en-US').endsWith('.md'))
          result.push(path)
      }
    }
    return result
  }
  private async ensureFile(path: string, content: string): Promise<void> {
    try {
      await stat(path)
    } catch {
      await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
    }
  }
  private exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const pending = this.mutation.then(operation, operation)
    this.mutation = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }
}
