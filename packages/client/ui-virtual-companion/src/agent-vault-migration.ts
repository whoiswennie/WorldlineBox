/** One-time, restart-safe migration from the pre-v1 companion stores into Agent Vaults. */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import type { AgentVaultService, SelfModule, VaultResourceDraft } from '@deepseek-ai/dsh-agent-vault'
import type { VirtualCompanion } from './contracts.ts'
import type { ReferenceAsset } from './contracts.ts'
import { ReferenceVault } from './reference-vault.ts'

const context = { actor: { type: 'system' as const, id: 'legacy-v1-migration' },
  reason: 'One-time verified migration from the legacy companion stores.' }

/** Audit record proving that one legacy companion tree was backed up and migrated. */
export interface LegacyMigrationReport {
  readonly version: 1
  readonly startedAt: number
  readonly completedAt: number
  readonly backup: string
  readonly agents: readonly { id: string; documents: number; resources: number }[]
  readonly sourceFiles: number
  readonly sourceBytes: number
  readonly sourceSha256: string
}

const digest = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
const asUri = (path: string) => `vault://${path}` as const

async function files(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) found.push(path)
    }
  }
  await walk(root)
  return found.sort()
}

async function inventory(root: string): Promise<{ count: number; bytes: number; sha256: string }> {
  const hash = createHash('sha256'); let bytes = 0
  const paths = await files(root)
  for (const path of paths) {
    const data = await readFile(path); const rel = relative(root, path).replaceAll('\\', '/')
    bytes += data.byteLength; hash.update(rel).update('\0').update(digest(data)).update('\n')
  }
  return { count: paths.length, bytes, sha256: hash.digest('hex') }
}

function scopeRoot(legacyRoot: string, id: string): string {
  return id === 'public' ? join(legacyRoot, 'knowledge-vaults', 'public')
    : join(legacyRoot, 'knowledge-vaults', 'companions', id.slice(0, 2), id)
}

async function legacyMarkdown(legacyRoot: string, id: string): Promise<string[]> {
  return (await files(scopeRoot(legacyRoot, id))).filter(path => extname(path).toLocaleLowerCase() === '.md'
    && basename(path).toLocaleLowerCase() !== 'agents.md' && !path.includes(`${join('', '.trash')}\\`))
}

function module(current: SelfModule, summary: string, details: readonly string[]): SelfModule {
  return { ...current, summary, details, updatedAt: Date.now() }
}

async function migrateSelf(vaults: AgentVaultService, profile: VirtualCompanion): Promise<void> {
  const snapshot = await vaults.inspectSelf(profile.id)
  const byId = new Map(snapshot.modules.map(item => [item.id, item]))
  const updates: Array<[string, string, string[]]> = [
    ['identity', `${profile.name}（${profile.handle}）`, [profile.description, profile.persona]],
    ['appearance', profile.avatar === '' ? '尚未提供形象资料。' : '已登记角色形象。',
      profile.avatar === '' ? [] : [`形象资源：${profile.avatar}`, `立绘资源：${profile.portrait || profile.avatar}`]],
    ['persona', profile.style, [profile.persona, profile.behaviorLogic]],
    ['voice', profile.speakingStyle, []],
    ['state', profile.status, []],
  ]
  for (const [id, summary, details] of updates) {
    const current = byId.get(id); if (current === undefined) continue
    await vaults.updateSelf(profile.id, module(current, summary, details.filter(Boolean)),
      { ...context, expectedRevision: current.revision })
  }
}

function parseSource(asset: ReferenceAsset): { data?: Uint8Array; externalUrl?: string } {
  if (asset.source.type === 'builtin' || asset.source.type === 'link') return { externalUrl: asset.source.url }
  return {}
}

async function migrateResources(vaults: AgentVaultService, references: ReferenceVault,
  id: string): Promise<number> {
  let cursor = 0; let count = 0
  for (;;) {
    const page = references.query({ scopes: [id], query: '', includeDisabled: true, cursor, limit: 100 })
    for (const asset of page.items) {
      try { await vaults.resource(id, asset.id); continue } catch { /* incomplete retry */ }
      const source = parseSource(asset)
      const draft: VaultResourceDraft = {
        preferredId: asset.id, enabled: asset.enabled, roles: ['expression'], title: asset.title,
        description: asset.description, tags: asset.tags, originalTags: asset.tags,
        transcript: asset.transcript, mimeType: asset.mimeType, bytes: asset.bytes,
        ...(asset.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
        ...(source.externalUrl === undefined ? {} : { externalUrl: source.externalUrl }),
        builtIn: asset.builtIn, usageCount: asset.usageCount,
        ...(asset.lastUsedAt === undefined ? {} : { lastUsedAt: asset.lastUsedAt }),
        createdAt: asset.createdAt,
      }
      if (asset.source.type === 'blob') {
        const blob = references.blobInfo(asset.id)
        if (blob === undefined) throw new Error(`Legacy resource blob is missing: ${asset.id}`)
        await vaults.importResourceFromFile(id, draft, blob.path, context)
      } else await vaults.importResource(id, draft, undefined, context)
      count++
    }
    if (page.nextCursor < 0) break
    cursor = page.nextCursor
  }
  return count
}

async function migrateDocuments(vaults: AgentVaultService, legacyRoot: string, id: string): Promise<number> {
  const root = scopeRoot(legacyRoot, id); let count = 0
  for (const source of await legacyMarkdown(legacyRoot, id)) {
    const rel = relative(root, source).replaceAll('\\', '/')
    await vaults.write(id, asUri(`memory/long/legacy/${rel}`), await readFile(source, 'utf8'), context)
    count++
  }
  return count
}

/**
 * Back up exact legacy bytes, then migrate each scope idempotently and write a final marker last.
 * @param input - Legacy roots, companion profiles, and the destination Agent Vault service.
 * @returns The completed migration audit, or `undefined` when every scope was already migrated.
 */
export async function migrateLegacyCompanions(input: {
  readonly legacyRoot: string
  readonly backupRoot: string
  readonly profiles: readonly VirtualCompanion[]
  readonly vaults: AgentVaultService
}): Promise<LegacyMigrationReport | undefined> {
  const ids = ['public', ...input.profiles.map(item => item.id)]
  const existing = new Set((await input.vaults.listAgents()).map(item => item.agent.id))
  const incomplete = await Promise.all(ids.map(async (id) => {
    if (!existing.has(id)) return true
    return await input.vaults.read(id, asUri('memory/long/migrations/legacy-v1.md')).then(() => false, () => true)
  }))
  if (!incomplete.some(Boolean)) return undefined

  const startedAt = Date.now(); const stamp = new Date(startedAt).toISOString().replaceAll(':', '-')
  const backup = join(input.backupRoot, `legacy-v1-${stamp}`)
  await mkdir(backup, { recursive: true })
  for (const name of ['directory.json', 'knowledge-vaults', 'reference-vault']) {
    const source = join(input.legacyRoot, name)
    await stat(source).then(() => cp(source, join(backup, name), { recursive: true, errorOnExist: true }), () => undefined)
  }
  const sourceInventory = await inventory(input.legacyRoot)
  const agents: Array<{ id: string; documents: number; resources: number }> = []
  const references = new ReferenceVault(join(input.legacyRoot, 'reference-vault'))
  await references.initialize()
  try {
    for (const id of ids) {
      const profile = input.profiles.find(item => item.id === id)
      if (!existing.has(id)) await input.vaults.createAgent(id, profile?.name ?? '公共认知')
      if (profile !== undefined) await migrateSelf(input.vaults, profile)
      const documents = await migrateDocuments(input.vaults, input.legacyRoot, id)
      const resources = await migrateResources(input.vaults, references, id)
      await input.vaults.write(id, asUri('memory/long/migrations/legacy-v1.md'), [
        '---', 'title: "旧版知识库迁移记录"', 'tags: [migration, legacy-v1]',
        `summary: "已迁移 ${String(documents)} 个文档和 ${String(resources)} 个资源。"`,
        `sources: ["legacy-backup://${basename(backup)}"]`, '---', '',
        '# 旧版知识库迁移记录', '', `迁移完成时间：${new Date().toISOString()}`, '',
      ].join('\n'), context)
      agents.push({ id, documents, resources })
    }
  } finally {
    references.close()
  }
  const report: LegacyMigrationReport = { version: 1, startedAt, completedAt: Date.now(), backup,
    agents, sourceFiles: sourceInventory.count, sourceBytes: sourceInventory.bytes,
    sourceSha256: sourceInventory.sha256 }
  await writeFile(join(backup, 'migration-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return report
}
