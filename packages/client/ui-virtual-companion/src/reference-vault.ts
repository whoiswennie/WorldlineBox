/** Fast, extensible reference-media index, independent from progressive knowledge traversal. */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { ReferenceAsset, ReferenceDraft, ReferencePage, ReferenceTagCount } from './contracts.ts'
import {
  expandReferenceQuery,
  inferReferenceMediaTags,
} from './reference-tags.ts'

export type { ReferenceAsset, ReferenceDraft, ReferencePage, ReferenceTagCount } from './contracts.ts'
export interface ReferenceQuery {
  readonly scopes: readonly string[]
  readonly query: string
  readonly tags?: readonly string[]
  readonly excludeIds?: readonly string[]
  /** Management-only escape hatch; Agent retrieval excludes disabled assets by default. */
  readonly includeDisabled?: boolean
  readonly enabled?: boolean
  readonly cursor?: number
  readonly limit?: number
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/gif': 'gif',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}
const cleanArray = (values: readonly string[] | undefined, limit = 64): string[] =>
  [
    ...new Set(
      (values ?? [])
        .map(value => value.trim().normalize('NFKC').toLocaleLowerCase('zh-CN'))
        .filter(Boolean),
    ),
  ].slice(0, limit)
const storedArray = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value)) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
const cleanScope = (value: string): string => {
  const scope = value.trim().toLocaleLowerCase('en-US')
  if (scope !== 'public' && !/^[a-z\d][a-z\d-]{0,119}$/u.test(scope))
    throw new Error('invalid reference scope')
  return scope
}
const fts = (value: string): string =>
  value
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map(term => `"${term.replaceAll('"', '""')}"`)
    .join(' OR ')

const enrichedTags = (draft: ReferenceDraft, mimeType: string): string[] => cleanArray([
  ...draft.tags,
  ...inferReferenceMediaTags(mimeType),
])

/** One shared SQL catalog and content-addressed blob store scale independently of role count. */
export class ReferenceVault {
  private database: DatabaseSync | undefined
  private searchStatement: StatementSync | undefined
  private fallbackStatement: StatementSync | undefined
  private mutation = Promise.resolve()
  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(join(this.root, 'objects'), { recursive: true })
    const { DatabaseSync } = await import('node:sqlite')
    this.database = new DatabaseSync(join(this.root, 'references.sqlite'))
    const columns = this.database.prepare('PRAGMA table_info(reference_assets)').all()
      .map(row => String((row as Record<string, unknown>)['name']))
    const legacyRows = columns.includes('kind')
      ? this.database.prepare('SELECT * FROM reference_assets').all()
      : []
    if (legacyRows.length > 0 || columns.includes('kind')) this.database.exec(`
      DROP TABLE IF EXISTS reference_fts;
      DROP TABLE IF EXISTS reference_tags;
      DROP TABLE IF EXISTS reference_assets;
    `)
    this.database.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS reference_assets(id TEXT PRIMARY KEY,scope TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,title TEXT NOT NULL,description TEXT NOT NULL,tags TEXT NOT NULL,transcript TEXT NOT NULL,mime_type TEXT NOT NULL,bytes INTEGER NOT NULL,duration_ms INTEGER,source TEXT NOT NULL,built_in INTEGER NOT NULL,usage_count INTEGER NOT NULL DEFAULT 0,last_used_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS reference_scope_updated ON reference_assets(scope,updated_at DESC,id);
      CREATE TABLE IF NOT EXISTS reference_tags(asset_id TEXT NOT NULL,tag TEXT NOT NULL,PRIMARY KEY(asset_id,tag),FOREIGN KEY(asset_id) REFERENCES reference_assets(id) ON DELETE CASCADE) STRICT;
      CREATE INDEX IF NOT EXISTS reference_tag_lookup ON reference_tags(tag,asset_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS reference_fts USING fts5(id UNINDEXED,title,description,tags,transcript,tokenize='trigram');
    `)
    const latestColumns = this.database.prepare('PRAGMA table_info(reference_assets)').all()
      .map(row => String((row as Record<string, unknown>)['name']))
    if (!latestColumns.includes('enabled'))
      this.database.exec('ALTER TABLE reference_assets ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')
    this.database.exec(
      'CREATE INDEX IF NOT EXISTS reference_enabled_scope ON reference_assets(enabled,scope,updated_at DESC,id)',
    )
    for (const row of legacyRows) this.putAsset(this.upgradeLegacyRow(row))
    this.searchStatement = this.database.prepare(`
      SELECT a.* FROM reference_fts f JOIN reference_assets a ON a.id=f.id
      WHERE reference_fts MATCH ? AND a.scope IN (SELECT value FROM json_each(?))
        AND (? IS NULL OR a.enabled=?)
        AND (?='[]' OR a.id NOT IN (SELECT value FROM json_each(?)))
      ORDER BY bm25(reference_fts,0,8,5,7,3),a.last_used_at IS NULL DESC,a.usage_count ASC,a.updated_at DESC LIMIT ? OFFSET ?
    `)
    this.fallbackStatement = this.database.prepare(`
      SELECT a.* FROM reference_assets a
      WHERE a.scope IN (SELECT value FROM json_each(?))
        AND (? IS NULL OR a.enabled=?)
        AND (?='[]' OR a.id NOT IN (SELECT value FROM json_each(?)))
        AND EXISTS(SELECT 1 FROM json_each(?) q WHERE instr(lower(a.title||' '||a.description||' '||a.tags||' '||a.transcript),lower(q.value))>0)
      ORDER BY a.last_used_at IS NULL DESC,a.usage_count ASC,a.updated_at DESC LIMIT ? OFFSET ?
    `)
  }
  close(): void {
    this.database?.close()
    this.database = undefined
    this.searchStatement = undefined
    this.fallbackStatement = undefined
  }

  async seed(asset: ReferenceAsset): Promise<void> {
    const current = this.get(asset.id)
    await this.exclusive(() => {
      this.putAsset(
        current === undefined
          ? asset
          : {
            ...asset,
            enabled: current.enabled,
            usageCount: current.usageCount,
            ...(current.lastUsedAt === undefined ? {} : { lastUsedAt: current.lastUsedAt }),
            createdAt: current.createdAt,
          },
      )
    })
  }
  async create(draft: ReferenceDraft, builtIn = false, fixedId?: string): Promise<ReferenceAsset> {
    const now = Date.now()
    const source = await this.sourceFrom(draft.asset, draft.mimeType)
    const asset: ReferenceAsset = {
      id: fixedId ?? randomUUID(),
      scope: cleanScope(draft.scope),
      enabled: true,
      title: draft.title.trim().slice(0, 200),
      description: draft.description.trim().slice(0, 12_000),
      tags: enrichedTags(draft, draft.mimeType),
      transcript: draft.transcript?.trim().slice(0, 80_000) ?? '',
      mimeType: draft.mimeType.trim().slice(0, 100),
      bytes: source.bytes,
      ...(draft.durationMs === undefined
        ? {}
        : { durationMs: Math.max(0, Math.trunc(draft.durationMs)) }),
      source: source.value,
      builtIn,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    if (asset.title === '') throw new Error('reference title is required')
    return await this.exclusive(() => {
      this.putAsset(asset)
      return asset
    })
  }
  async createUpload(
    draft: ReferenceDraft,
    data: Uint8Array,
    mimeType: string,
  ): Promise<ReferenceAsset> {
    const normalizedMimeType = this.validMimeType(mimeType)
    const source = await this.sourceFromBytes(data, normalizedMimeType)
    return await this.createUploadedAsset(draft, normalizedMimeType, source)
  }

  private async createUploadedAsset(
    draft: ReferenceDraft,
    mimeType: string,
    source: { value: ReferenceAsset['source']; bytes: number },
  ): Promise<ReferenceAsset> {
    const now = Date.now()
    const asset: ReferenceAsset = {
      id: randomUUID(),
      scope: cleanScope(draft.scope),
      enabled: true,
      title: draft.title.trim().slice(0, 200),
      description: draft.description.trim().slice(0, 12_000),
      tags: enrichedTags(draft, mimeType),
      transcript: draft.transcript?.trim().slice(0, 80_000) ?? '',
      mimeType: mimeType.trim().slice(0, 100),
      bytes: source.bytes,
      ...(draft.durationMs === undefined
        ? {}
        : { durationMs: Math.max(0, Math.trunc(draft.durationMs)) }),
      source: source.value,
      builtIn: false,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    if (asset.title === '') throw new Error('reference title is required')
    return await this.exclusive(() => {
      this.putAsset(asset)
      return asset
    })
  }
  /** Stream an arbitrarily large upload to CAS without retaining its bytes in process memory. */
  async createUploadStream(
    draft: ReferenceDraft,
    chunks: AsyncIterable<Uint8Array>,
    mimeType: string,
    expectedBytes?: number,
  ): Promise<ReferenceAsset> {
    const normalizedMimeType = this.validMimeType(mimeType)
    const staging = join(this.root, 'staging')
    await mkdir(staging, { recursive: true })
    const temporary = join(staging, `${randomUUID()}.part`)
    const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
    const hash = createHash('sha256')
    let bytes = 0
    try {
      for await (const chunk of chunks) {
        bytes += chunk.byteLength
        hash.update(chunk)
        if (!output.write(chunk)) await once(output, 'drain')
      }
      output.end()
      await once(output, 'close')
      if (bytes === 0) throw new Error('reference media is empty')
      if (expectedBytes !== undefined && bytes !== expectedBytes)
        throw new Error(`reference upload ended at ${String(bytes)} of ${String(expectedBytes)} bytes`)
      const digest = hash.digest('hex')
      const target = this.objectPath(digest, normalizedMimeType)
      await mkdir(join(this.root, 'objects', digest.slice(0, 2)), { recursive: true })
      try {
        await rename(temporary, target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await unlink(temporary).catch(() => undefined)
      }
      return await this.createUploadedAsset(draft, normalizedMimeType, {
        value: { type: 'blob', hash: digest },
        bytes,
      })
    } catch (error) {
      output.destroy()
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }
  async update(id: string, draft: ReferenceDraft): Promise<ReferenceAsset> {
    const current = this.get(id)
    if (current === undefined) throw new Error('reference not found')
    if (current.builtIn) throw new Error('built-in reference cannot be changed')
    const source =
      draft.asset === ''
        ? { value: current.source, bytes: current.bytes }
        : await this.sourceFrom(draft.asset, draft.mimeType)
    const next: ReferenceAsset = {
      ...current,
      scope: cleanScope(draft.scope),
      title: draft.title.trim().slice(0, 200),
      description: draft.description.trim().slice(0, 12_000),
      tags: enrichedTags(draft, draft.mimeType || current.mimeType),
      transcript: draft.transcript?.trim().slice(0, 80_000) ?? '',
      mimeType: draft.mimeType.trim().slice(0, 100),
      bytes: source.bytes,
      ...(draft.durationMs === undefined
        ? {}
        : { durationMs: Math.max(0, Math.trunc(draft.durationMs)) }),
      source: source.value,
      updatedAt: Date.now(),
    }
    return await this.exclusive(() => {
      this.putAsset(next)
      return next
    })
  }
  async remove(id: string): Promise<void> {
    await this.exclusive(() => {
      const current = this.get(id)
      if (current?.builtIn === true) throw new Error('built-in reference cannot be removed')
      this.database?.prepare('DELETE FROM reference_fts WHERE id=?').run(id)
      this.database?.prepare('DELETE FROM reference_tags WHERE asset_id=?').run(id)
      this.database?.prepare('DELETE FROM reference_assets WHERE id=?').run(id)
    })
  }
  async setEnabled(id: string, enabled: boolean): Promise<ReferenceAsset> {
    return await this.exclusive(() => {
      const current = this.get(id)
      if (current === undefined) throw new Error('reference not found')
      const updatedAt = Date.now()
      this.database
        ?.prepare('UPDATE reference_assets SET enabled=?,updated_at=? WHERE id=?')
        .run(enabled ? 1 : 0, updatedAt, id)
      return { ...current, enabled, updatedAt }
    })
  }
  get(id: string): ReferenceAsset | undefined {
    const row = this.database?.prepare('SELECT * FROM reference_assets WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined
    return row === undefined ? undefined : this.asset(row)
  }
  query(input: ReferenceQuery): ReferencePage {
    const scopes = [...new Set(input.scopes.map(cleanScope))]
    const tags = cleanArray(input.tags)
    const excluded = [...new Set(input.excludeIds ?? [])]
    const enabled = input.enabled ?? (input.includeDisabled === true ? undefined : true)
    const enabledValue = enabled === undefined ? null : enabled ? 1 : 0
    const limit = Math.max(1, Math.min(100, input.limit ?? 30))
    const cursor = Math.max(0, input.cursor ?? 0)
    const tagRows = tags.length === 0
      ? []
      : (this.database?.prepare(`
        SELECT a.*,COUNT(DISTINCT t.tag) AS tag_score
        FROM reference_assets a JOIN reference_tags t ON t.asset_id=a.id
        WHERE a.scope IN (SELECT value FROM json_each(?))
          AND (? IS NULL OR a.enabled=?)
          AND t.tag IN (SELECT value FROM json_each(?))
          AND (?='[]' OR a.id NOT IN (SELECT value FROM json_each(?)))
        GROUP BY a.id
        ORDER BY tag_score DESC,a.last_used_at IS NULL DESC,a.usage_count ASC,a.updated_at DESC
        LIMIT ? OFFSET ?
      `).all(
        JSON.stringify(scopes),
        enabledValue,
        enabledValue,
        JSON.stringify(tags),
        JSON.stringify(excluded),
        JSON.stringify(excluded),
        limit,
        cursor,
      ) ?? [])
    let rows: unknown[]
    if (input.query.trim() === '')
      rows = tags.length > 0
        ? tagRows
        : (this.database
          ?.prepare(
            "SELECT a.* FROM reference_assets a WHERE a.scope IN (SELECT value FROM json_each(?)) AND (? IS NULL OR a.enabled=?) AND (?='[]' OR a.id NOT IN (SELECT value FROM json_each(?))) ORDER BY a.updated_at DESC LIMIT ? OFFSET ?",
          )
          .all(
            JSON.stringify(scopes),
            enabledValue,
            enabledValue,
            JSON.stringify(excluded),
            JSON.stringify(excluded),
            limit,
            cursor,
          ) ?? [])
    else {
      const terms = expandReferenceQuery(input.query)
      const matchRows =
        this.searchStatement?.all(
          fts(terms.join(' ')),
          JSON.stringify(scopes),
          enabledValue,
          enabledValue,
          JSON.stringify(excluded),
          JSON.stringify(excluded),
          limit,
          cursor,
        ) ?? []
      const seen = new Set(matchRows.map(row => String((row as Record<string, unknown>)['id'])))
      const fallbackRows =
        matchRows.length >= limit
          ? []
          : (this.fallbackStatement?.all(
            JSON.stringify(scopes),
            enabledValue,
            enabledValue,
            JSON.stringify(excluded),
            JSON.stringify(excluded),
            JSON.stringify(terms),
            limit,
            cursor,
          ) ?? [])
      for (const row of tagRows)
        seen.add(String((row as Record<string, unknown>)['id']))
      rows = [
        ...tagRows,
        ...matchRows.filter(row => !tagRows.some(tagRow =>
          String((tagRow as Record<string, unknown>)['id'])
            === String((row as Record<string, unknown>)['id']))),
        ...fallbackRows.filter(row => !seen.has(String((row as Record<string, unknown>)['id']))),
      ].slice(0, limit)
    }
    const items = rows.map(value => this.asset(value as Record<string, unknown>))
    return { items, nextCursor: items.length < limit ? -1 : cursor + items.length }
  }
  react(input: ReferenceQuery): ReferenceAsset | undefined {
    return this.query({ ...input, limit: 1 }).items[0]
  }
  tagCatalog(
    scopesValue: readonly string[],
    limitValue = 48,
    includeDisabled = false,
  ): ReferenceTagCount[] {
    const scopes = [...new Set(scopesValue.map(cleanScope))]
    const limit = Math.max(1, Math.min(200, Math.trunc(limitValue)))
    const rows = this.database?.prepare(`
      SELECT t.tag,COUNT(DISTINCT t.asset_id) AS count
      FROM reference_tags t JOIN reference_assets a ON a.id=t.asset_id
      WHERE a.scope IN (SELECT value FROM json_each(?))
        AND (?=1 OR a.enabled=1)
      GROUP BY t.tag ORDER BY count DESC,t.tag ASC LIMIT ?
    `).all(JSON.stringify(scopes), includeDisabled ? 1 : 0, limit) ?? []
    return rows.map(row => ({
      tag: String((row as Record<string, unknown>)['tag']),
      count: Number((row as Record<string, unknown>)['count']),
    }))
  }
  markUsed(id: string): void {
    this.database
      ?.prepare('UPDATE reference_assets SET usage_count=usage_count+1,last_used_at=? WHERE id=?')
      .run(Date.now(), id)
  }
  async blob(id: string): Promise<{ data: Buffer; mimeType: string } | undefined> {
    const asset = this.get(id)
    if (asset === undefined || asset.source.type !== 'blob') return undefined
    return {
      data: await readFile(this.objectPath(asset.source.hash, asset.mimeType)),
      mimeType: asset.mimeType,
    }
  }
  blobInfo(id: string): { path: string; bytes: number; mimeType: string } | undefined {
    const asset = this.get(id)
    if (asset === undefined || asset.source.type !== 'blob') return undefined
    return {
      path: this.objectPath(asset.source.hash, asset.mimeType),
      bytes: asset.bytes,
      mimeType: asset.mimeType,
    }
  }
  url(asset: ReferenceAsset): string {
    return asset.source.type === 'blob'
      ? `/api/virtual-companions/reference/blob/${asset.id}`
      : asset.source.url
  }
  async removeScope(scopeValue: string): Promise<void> {
    const scope = cleanScope(scopeValue)
    if (scope === 'public') throw new Error('public reference vault cannot be removed')
    await this.exclusive(() => {
      const ids =
        this.database?.prepare('SELECT id FROM reference_assets WHERE scope=?').all(scope) ?? []
      for (const row of ids)
        this.database
          ?.prepare('DELETE FROM reference_fts WHERE id=?')
          .run(String((row as Record<string, unknown>)['id']))
      this.database
        ?.prepare(
          'DELETE FROM reference_tags WHERE asset_id IN (SELECT id FROM reference_assets WHERE scope=?)',
        )
        .run(scope)
      this.database?.prepare('DELETE FROM reference_assets WHERE scope=?').run(scope)
    })
  }

  /**
   * Remove every private asset, including bundled rows, so the caller can reseed one clean edition.
   * @param scopeValue - Private companion scope to reset.
   */
  async resetScope(scopeValue: string): Promise<void> {
    const scope = cleanScope(scopeValue)
    if (scope === 'public') throw new Error('public reference vault cannot be reset as a companion')
    await this.removeScope(scope)
  }

  /** One-time schema upgrade: preserve old metadata as tags, then store only the tag model. */
  private upgradeLegacyRow(row: Record<string, unknown>): ReferenceAsset {
    const mimeType = String(row['mime_type'])
    const kind = String(row['kind'])
    return {
      id: String(row['id']),
      scope: String(row['scope']),
      enabled: true,
      title: String(row['title']),
      description: String(row['description']),
      tags: cleanArray([
        ...storedArray(row['tags']),
        ...storedArray(row['topics']),
        ...storedArray(row['characters']),
        typeof row['mood'] === 'string' ? row['mood'] : '',
        typeof row['intent'] === 'string' ? row['intent'] : '',
        ...(kind === 'meme' ? ['表情包'] : []),
        ...inferReferenceMediaTags(mimeType),
      ]),
      transcript: String(row['transcript']),
      mimeType,
      bytes: Number(row['bytes']),
      ...(row['duration_ms'] === null || row['duration_ms'] === undefined
        ? {}
        : { durationMs: Number(row['duration_ms']) }),
      source: JSON.parse(String(row['source'])) as ReferenceAsset['source'],
      builtIn: Number(row['built_in']) === 1,
      usageCount: Number(row['usage_count']),
      ...(row['last_used_at'] === null || row['last_used_at'] === undefined
        ? {}
        : { lastUsedAt: Number(row['last_used_at']) }),
      createdAt: Number(row['created_at']),
      updatedAt: Number(row['updated_at']),
    }
  }

  private async sourceFrom(
    raw: string,
    mimeType: string,
  ): Promise<{ value: ReferenceAsset['source']; bytes: number }> {
    if (/^https?:\/\//iu.test(raw)) return { value: { type: 'link', url: raw }, bytes: 0 }
    if (raw.startsWith('/worldline-experience/'))
      return { value: { type: 'builtin', url: raw }, bytes: 0 }
    const match = /^data:([^;,]+);base64,([a-z\d+/]+=*)$/iu.exec(raw)
    if (match?.[1] === undefined || match[2] === undefined)
      throw new Error('reference media must be a data URL, product asset, or http(s) URL')
    if (
      mimeType !== '' &&
      match[1].toLocaleLowerCase('en-US') !== mimeType.toLocaleLowerCase('en-US')
    )
      throw new Error('reference MIME type does not match asset')
    return await this.sourceFromBytes(Buffer.from(match[2], 'base64'), match[1])
  }
  private async sourceFromBytes(
    value: Uint8Array,
    mimeType: string,
  ): Promise<{ value: ReferenceAsset['source']; bytes: number }> {
    const data = Buffer.from(value)
    const normalizedMimeType = this.validMimeType(mimeType)
    const hash = createHash('sha256').update(data).digest('hex')
    const target = this.objectPath(hash, normalizedMimeType)
    try {
      await stat(target)
    } catch {
      await mkdir(join(this.root, 'objects', hash.slice(0, 2)), { recursive: true })
      await writeFile(target, data, { flag: 'wx', mode: 0o600 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
    }
    return { value: { type: 'blob', hash }, bytes: data.byteLength }
  }
  private validMimeType(value: string): string {
    const mimeType = value.trim().toLocaleLowerCase('en-US')
    if (!/^[a-z][a-z\d!#$&^_.+-]*\/[a-z\d!#$&^_.+-]+$/u.test(mimeType))
      throw new Error('invalid reference media type')
    return mimeType
  }
  private objectPath(hash: string, mime: string): string {
    const extension = MIME_EXTENSIONS[mime.toLocaleLowerCase('en-US')] ?? 'bin'
    return join(this.root, 'objects', hash.slice(0, 2), `${hash}.${extension}`)
  }
  private putAsset(asset: ReferenceAsset): void {
    const database = this.database
    if (database === undefined) throw new Error('reference vault is not initialized')
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare('DELETE FROM reference_fts WHERE id=?').run(asset.id)
      database
        .prepare(
          'INSERT INTO reference_assets(id,scope,enabled,title,description,tags,transcript,mime_type,bytes,duration_ms,source,built_in,usage_count,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,enabled=excluded.enabled,title=excluded.title,description=excluded.description,tags=excluded.tags,transcript=excluded.transcript,mime_type=excluded.mime_type,bytes=excluded.bytes,duration_ms=excluded.duration_ms,source=excluded.source,built_in=excluded.built_in,updated_at=excluded.updated_at',
        )
        .run(
          asset.id,
          asset.scope,
          asset.enabled ? 1 : 0,
          asset.title,
          asset.description,
          JSON.stringify(asset.tags),
          asset.transcript,
          asset.mimeType,
          asset.bytes,
          asset.durationMs ?? null,
          JSON.stringify(asset.source),
          asset.builtIn ? 1 : 0,
          asset.usageCount,
          asset.lastUsedAt ?? null,
          asset.createdAt,
          asset.updatedAt,
        )
      database
        .prepare(
          'INSERT INTO reference_fts(id,title,description,tags,transcript) VALUES(?,?,?,?,?)',
        )
        .run(
          asset.id,
          asset.title,
          asset.description,
          asset.tags.join(' '),
          asset.transcript,
        )
      database.prepare('DELETE FROM reference_tags WHERE asset_id=?').run(asset.id)
      const insert = database.prepare('INSERT INTO reference_tags(asset_id,tag) VALUES(?,?)')
      for (const tag of asset.tags) insert.run(asset.id, tag)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
  private asset(row: Record<string, unknown>): ReferenceAsset {
    return {
      id: String(row['id']),
      scope: String(row['scope']),
      enabled: Number(row['enabled']) === 1,
      title: String(row['title']),
      description: String(row['description']),
      tags: JSON.parse(String(row['tags'])) as string[],
      transcript: String(row['transcript']),
      mimeType: String(row['mime_type']),
      bytes: Number(row['bytes']),
      ...(row['duration_ms'] === null || row['duration_ms'] === undefined
        ? {}
        : { durationMs: Number(row['duration_ms']) }),
      source: JSON.parse(String(row['source'])) as ReferenceAsset['source'],
      builtIn: Number(row['built_in']) === 1,
      usageCount: Number(row['usage_count']),
      ...(row['last_used_at'] === null || row['last_used_at'] === undefined
        ? {}
        : { lastUsedAt: Number(row['last_used_at']) }),
      createdAt: Number(row['created_at']),
      updatedAt: Number(row['updated_at']),
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
