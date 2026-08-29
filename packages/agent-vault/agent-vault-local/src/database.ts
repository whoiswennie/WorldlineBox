/** Rebuildable SQLite projection for one Agent Vault. */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentVaultDomain, MemoryStage, VaultResource } from '@deepseek-ai/dsh-agent-vault'

/** Normalized document row stored in the disposable projection. */
export interface IndexedDocument {
  readonly id: string
  readonly path: string
  readonly domain: AgentVaultDomain
  readonly stage?: MemoryStage
  readonly title: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly aliases: readonly string[]
  readonly content: string
  readonly revision: string
  readonly updatedAt: number
}

/** Indexed document decorated with its FTS rank. */
export interface RankedDocument extends IndexedDocument { readonly rank: number }

const arrays = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value)) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

const memoryStage = (value: unknown): MemoryStage | undefined =>
  value === 'short' || value === 'medium' || value === 'long' ? value : undefined

/** SQLite FTS5 projection that can always be rebuilt from Vault files. */
export class VaultIndex {
  /** Open SQLite handle owned by this projection. */
  readonly database: DatabaseSync

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.database = new DatabaseSync(file)
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents(
        id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,domain TEXT NOT NULL,stage TEXT,
        title TEXT NOT NULL,summary TEXT NOT NULL,tags TEXT NOT NULL,aliases TEXT NOT NULL,
        content TEXT NOT NULL,revision TEXT NOT NULL,updated_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
        id UNINDEXED,title,summary,tags,aliases,path,content,tokenize='trigram case_sensitive 0'
      );
      CREATE TABLE IF NOT EXISTS resources(
        id TEXT PRIMARY KEY,record TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,
        tags TEXT NOT NULL,transcript TEXT NOT NULL,roles TEXT NOT NULL,enabled INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS resource_fts USING fts5(
        id UNINDEXED,title,description,tags,transcript,roles,tokenize='trigram case_sensitive 0'
      );
      CREATE INDEX IF NOT EXISTS documents_domain_stage ON documents(domain,stage,updated_at DESC);
      CREATE INDEX IF NOT EXISTS resources_enabled ON resources(enabled,updated_at DESC);
    `)
  }

  /** Close the projection handle. @returns Nothing. */
  close(): void { this.database.close() }

  /**
   * Read the monotonic projection revision.
   * @returns Current revision.
   */
  revision(): number {
    return Number(this.database.prepare("SELECT value FROM metadata WHERE key='revision'").get()?.['value'] ?? 0)
  }

  /**
   * Increment the projection revision.
   * @returns New revision.
   */
  bump(): number {
    const next = this.revision() + 1
    this.database.prepare("INSERT INTO metadata(key,value) VALUES('revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(next))
    return next
  }

  /** Remove all derived rows. @returns Nothing. */
  clear(): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.exec('DELETE FROM document_fts;DELETE FROM documents;DELETE FROM resource_fts;DELETE FROM resources;')
      this.bump()
      this.database.exec('COMMIT')
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  /**
   * Atomically replace every derived row.
   * @param documents - Document rows.
   * @param resources - Resource rows.
   * @returns New revision.
   */
  replaceProjection(documents: readonly IndexedDocument[], resources: readonly VaultResource[]): number {
    const putDocument = this.database.prepare(`
      INSERT INTO documents(id,path,domain,stage,title,summary,tags,aliases,content,revision,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    const putDocumentFts = this.database.prepare(
      'INSERT INTO document_fts(id,title,summary,tags,aliases,path,content) VALUES(?,?,?,?,?,?,?)')
    const putResource = this.database.prepare(`INSERT INTO resources(id,record,title,description,tags,transcript,roles,enabled,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
    const putResourceFts = this.database.prepare(
      'INSERT INTO resource_fts(id,title,description,tags,transcript,roles) VALUES(?,?,?,?,?,?)')
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.exec('DELETE FROM document_fts;DELETE FROM documents;DELETE FROM resource_fts;DELETE FROM resources;')
      for (const value of documents) {
        putDocument.run(value.id, value.path, value.domain, value.stage ?? null, value.title, value.summary,
          JSON.stringify(value.tags), JSON.stringify(value.aliases), value.content, value.revision, value.updatedAt)
        putDocumentFts.run(value.id, value.title, value.summary, value.tags.join(' '), value.aliases.join(' '), value.path, value.content)
      }
      for (const value of resources) {
        putResource.run(value.id, JSON.stringify(value), value.title, value.description, value.tags.join(' '),
          value.transcript, value.roles.join(' '), value.enabled ? 1 : 0, value.updatedAt)
        putResourceFts.run(value.id, value.title, value.description, value.tags.join(' '), value.transcript, value.roles.join(' '))
      }
      const revision = this.bump(); this.database.exec('COMMIT'); return revision
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  /**
   * Upsert one document.
   * @param value - Normalized document.
   */
  putDocument(value: IndexedDocument): void {
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare('DELETE FROM document_fts WHERE id=?').run(value.id)
      database.prepare(`
        INSERT INTO documents(id,path,domain,stage,title,summary,tags,aliases,content,revision,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        path=excluded.path,domain=excluded.domain,stage=excluded.stage,title=excluded.title,
        summary=excluded.summary,tags=excluded.tags,aliases=excluded.aliases,content=excluded.content,
        revision=excluded.revision,updated_at=excluded.updated_at
      `).run(value.id, value.path, value.domain, value.stage ?? null, value.title, value.summary,
        JSON.stringify(value.tags), JSON.stringify(value.aliases), value.content, value.revision, value.updatedAt)
      database.prepare('INSERT INTO document_fts(id,title,summary,tags,aliases,path,content) VALUES(?,?,?,?,?,?,?)')
        .run(value.id, value.title, value.summary, value.tags.join(' '), value.aliases.join(' '), value.path, value.content)
      this.bump()
      database.exec('COMMIT')
    } catch (error) { database.exec('ROLLBACK'); throw error }
  }

  /**
   * Remove one document by relative path.
   * @param path - Vault-relative path.
   */
  removeDocument(path: string): void {
    const row = this.database.prepare('SELECT id FROM documents WHERE path=?').get(path)
    if (row === undefined) return
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare('DELETE FROM document_fts WHERE id=?').run(String(row['id']))
      this.database.prepare('DELETE FROM documents WHERE id=?').run(String(row['id']))
      this.bump()
      this.database.exec('COMMIT')
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  /**
   * Search documents with bounded lexical fallback.
   * @param domain - Semantic domain.
   * @param query - Natural-language query.
   * @param terms - Normalized terms.
   * @param stage - Optional memory stage.
   * @param limit - Candidate bound.
   * @returns Ranked documents.
   */
  searchDocuments(domain: Exclude<AgentVaultDomain, 'self'>, query: string,
    terms: readonly string[], stage: MemoryStage | undefined, limit: number): RankedDocument[] {
    const match = terms.filter(term => term.length >= 3).map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
    let rows: Record<string, unknown>[] = []
    if (match !== '') {
      try {
        rows = this.database.prepare(`
          SELECT d.*,bm25(document_fts,0,7,3,5,6,2,1) AS rank
          FROM document_fts JOIN documents d ON d.id=document_fts.id
          WHERE document_fts MATCH ? AND d.domain=? AND (? IS NULL OR d.stage=?)
          ORDER BY rank LIMIT ?
        `).all(match, domain, stage ?? null, stage ?? null, limit)
      } catch { rows = [] }
    }
    if (rows.length < limit) {
      const lexicalTerms = [...new Set([query.trim(), ...terms]
        .map(term => term.trim()).filter(Boolean))].slice(0, 16)
      const escaped = lexicalTerms.map(term => `%${term.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`)
      const fields = ['d.title', 'd.tags', 'd.aliases', 'd.summary', 'd.path']
      const lexical = escaped.length === 0 ? '1=0' : escaped
        .map(() => `(${fields.map(field => `${field} LIKE ? ESCAPE '\\'`).join(' OR ')})`).join(' OR ')
      const fallback = this.database.prepare(`
        SELECT d.*,1000 AS rank FROM documents d WHERE d.domain=? AND (? IS NULL OR d.stage=?)
        AND (${lexical}) ORDER BY d.updated_at DESC LIMIT ?
      `).all(domain, stage ?? null, stage ?? null,
        ...escaped.flatMap(pattern => fields.map(() => pattern)), limit) as Record<string, unknown>[]
      const seen = new Set(rows.map(row => String(row['id'])))
      rows.push(...fallback.filter(row => !seen.has(String(row['id']))).slice(0, limit - rows.length))
    }
    return rows.map((row) => {
      const stageValue = memoryStage(row['stage'])
      return {
        id: String(row['id']), path: String(row['path']), domain: String(row['domain']) as AgentVaultDomain,
        ...(stageValue === undefined ? {} : { stage: stageValue }),
        title: String(row['title']), summary: String(row['summary']), tags: arrays(row['tags']),
        aliases: arrays(row['aliases']), content: String(row['content']), revision: String(row['revision']),
        updatedAt: Number(row['updated_at']), rank: Number(row['rank']),
      }
    })
  }

  /**
   * Upsert one resource record.
   * @param value - Resource metadata.
   */
  putResource(value: VaultResource): void {
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare('DELETE FROM resource_fts WHERE id=?').run(value.id)
      database.prepare(`INSERT INTO resources(id,record,title,description,tags,transcript,roles,enabled,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record,title=excluded.title,
        description=excluded.description,tags=excluded.tags,transcript=excluded.transcript,
        roles=excluded.roles,enabled=excluded.enabled,updated_at=excluded.updated_at`)
        .run(value.id, JSON.stringify(value), value.title, value.description, value.tags.join(' '),
          value.transcript, value.roles.join(' '), value.enabled ? 1 : 0, value.updatedAt)
      database.prepare('INSERT INTO resource_fts(id,title,description,tags,transcript,roles) VALUES(?,?,?,?,?,?)')
        .run(value.id, value.title, value.description, value.tags.join(' '), value.transcript, value.roles.join(' '))
      this.bump()
      database.exec('COMMIT')
    } catch (error) { database.exec('ROLLBACK'); throw error }
  }

  /**
   * Remove one resource record.
   * @param id - Resource identity.
   */
  removeResource(id: string): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare('DELETE FROM resource_fts WHERE id=?').run(id)
      this.database.prepare('DELETE FROM resources WHERE id=?').run(id)
      this.bump(); this.database.exec('COMMIT')
    } catch (error) { this.database.exec('ROLLBACK'); throw error }
  }

  /**
   * Search resources with exact role filtering.
   * @param query - Natural-language query.
   * @param tags - Exact tag filters.
   * @param roles - Exact role filters.
   * @param includeDisabled - Include disabled records.
   * @param cursor - Result offset.
   * @param limit - Page bound.
   * @returns Matching resources.
   */
  searchResources(query: string, tags: readonly string[], roles: readonly string[], includeDisabled: boolean,
    cursor: number, limit: number): VaultResource[] {
    const terms = [...new Set([query, ...tags].map(value => value.trim()).filter(Boolean))]
    const match = terms.filter(term => term.length >= 3).map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
    const enabled = includeDisabled ? null : 1
    const roleFilter = roles.map(() => "instr(' ' || r.roles || ' ', ' ' || ? || ' ') > 0").join(' AND ') || '1=1'
    const scanLimit = Math.min(2_000, Math.max(limit, (cursor + limit) * 10))
    let rows: Record<string, unknown>[] = []
    if (match !== '') {
      try {
        rows = this.database.prepare(`SELECT r.record FROM resource_fts JOIN resources r ON r.id=resource_fts.id
          WHERE resource_fts MATCH ? AND (? IS NULL OR r.enabled=?) AND ${roleFilter}
          ORDER BY bm25(resource_fts,0,7,3,5,2,0),r.updated_at DESC LIMIT ?`)
          .all(match, enabled, enabled, ...roles, scanLimit)
      } catch { rows = [] }
    }
    if (rows.length === 0) {
      const pattern = `%${query.trim().replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
      rows = this.database.prepare(`SELECT r.record FROM resources r WHERE (? IS NULL OR r.enabled=?)
        AND (?='' OR r.title LIKE ? ESCAPE '\\' OR r.tags LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\')
        AND ${roleFilter} ORDER BY r.updated_at DESC LIMIT ?`)
        .all(enabled, enabled, query.trim(), pattern, pattern, pattern,
          ...roles, scanLimit)
    }
    return rows.map(row => JSON.parse(String(row['record'])) as VaultResource)
      .filter(item => tags.every(tag => item.tags.includes(tag))
        && roles.every(role => item.roles.includes(role as never)))
      .slice(cursor, cursor + limit)
  }
}
