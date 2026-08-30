/** Local file-native Agent Vault provider. @module @deepseek-ai/dsh-agent-vault-local */

import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, watch, type FSWatcher } from 'node:fs'
import {
  access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { resolveWorldlineHome } from '@deepseek-ai/dsh-home-paths'
import AgentVaultService, { AgentVaultError } from '@deepseek-ai/dsh-agent-vault'
import type {
  AgentVaultDomain, AgentVaultManifest, CaptureMemoryInput, ConsolidationJob, MemoryStage,
  RecallQuery, RecallResult, ResourcePage, ResourceSearchInput, SelfModule, SelfSnapshot,
  VaultDocument, VaultEntry, VaultPackageReport, VaultPolicy, VaultResource, VaultUri,
  VaultResourceDraft, VaultWriteContext,
} from '@deepseek-ai/dsh-agent-vault'
import { pack, unpack } from './archive.ts'
import { VaultIndex } from './database.ts'
import { memoryMarkdown, parseMarkdown, readView, revisionOf } from './markdown.ts'
import {
  asVaultUri, domainFromRelative, rejectSymlinkAncestors, resolveInside, validateAgentId,
  vaultRelative,
} from './path.ts'
import { queryTerms, scoreCandidate } from './search.ts'

/** Filesystem provider configuration. */
export interface Config {
  /** Override the Worldline home whose durable Agent Vault is used. */
  readonly worldlineHome?: string
}

const DEFAULT_POLICY: VaultPolicy = Object.freeze({
  aiWriteMode: 'autonomous',
  domains: Object.freeze({ self: 'autonomous', memory: 'autonomous', procedure: 'proposal', resource: 'autonomous' }),
  userEditable: true,
  fullyFrozen: false,
})

const SELF_MODULES: readonly Omit<SelfModule, 'updatedAt' | 'revision'>[] = [
  { id: 'identity', title: '核心身份', enabled: true, autonomous: false, locked: true, stability: 'core', summary: '', details: [] },
  { id: 'appearance', title: '形象', enabled: true, autonomous: false, locked: true, stability: 'core', summary: '尚未提供形象资料。', details: [] },
  { id: 'persona', title: '人格与价值观', enabled: true, autonomous: false, locked: false, stability: 'stable', summary: '', details: [] },
  { id: 'voice', title: '语气与表达', enabled: true, autonomous: false, locked: false, stability: 'stable', summary: '', details: [] },
  { id: 'worldview', title: '世界观与认知', enabled: true, autonomous: false, locked: false, stability: 'stable', summary: '', details: [] },
  { id: 'interests', title: '兴趣与偏好', enabled: true, autonomous: true, locked: false, stability: 'stable', summary: '', details: [] },
  { id: 'emotion', title: '近期情绪', enabled: true, autonomous: true, locked: false, stability: 'dynamic', summary: '平静', details: [] },
  { id: 'state', title: '当前状态', enabled: true, autonomous: true, locked: false, stability: 'dynamic', summary: '', details: [] },
  { id: 'relationships', title: '人际关系', enabled: true, autonomous: false, locked: false, stability: 'stable', summary: '', details: [] },
  { id: 'common-memory', title: '常用认知', enabled: true, autonomous: true, locked: false, stability: 'stable', summary: '', details: [] },
  { id: 'capabilities', title: '能力边界', enabled: true, autonomous: false, locked: false, stability: 'stable', summary: '', details: [] },
]

const semanticDirectories = [
  'self', 'memory/short', 'memory/medium', 'memory/long', 'procedures/cards',
  'procedures/methods', 'procedures/experiences', 'procedures/tests', 'resources/by-date',
  'resources/objects/sha256', 'resources/records', 'resources/collections', 'maps', 'skills',
  'queue', 'tests', 'history', '.system/indexes', '.system/cache', '.system/dirty',
  '.system/locks', '.system/runtime',
] as const

const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false)
const stableId = (agentId: string, path: string): string => sha256(`${agentId}\0${path}`).slice(0, 32)

function serializeSelf(module: Omit<SelfModule, 'updatedAt' | 'revision'>): string {
  return [
    '---', `id: ${JSON.stringify(module.id)}`, `title: ${JSON.stringify(module.title)}`,
    `enabled: ${String(module.enabled)}`, `autonomous: ${String(module.autonomous)}`,
    `locked: ${String(module.locked)}`, `stability: ${module.stability}`,
    `summary: ${JSON.stringify(module.summary)}`, `details: ${JSON.stringify(module.details)}`,
    '---', '', `# ${module.title}`, '', module.summary, '', ...module.details.map(value => `- ${value}`), '',
  ].join('\n')
}

function bool(content: string, key: string, fallback: boolean): boolean {
  const value = new RegExp(`^${key}:\\s*(true|false)$`, 'imu').exec(content)?.[1]
  return value === undefined ? fallback : value.toLocaleLowerCase() === 'true'
}

function stringField(content: string, key: string, fallback = ''): string {
  const raw = new RegExp(`^${key}:\\s*(.+)$`, 'mu').exec(content)?.[1]?.trim()
  if (raw === undefined) return fallback
  try { return raw.startsWith('"') ? String(JSON.parse(raw)) : raw } catch { return raw }
}

function stringList(content: string, key: string): string[] {
  const raw = stringField(content, key, '[]')
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

function parseSelf(content: string, fallbackId: string, updatedAt: number): SelfModule {
  const id = stringField(content, 'id', fallbackId)
  const stability = stringField(content, 'stability', 'stable')
  return {
    id, title: stringField(content, 'title', id), enabled: bool(content, 'enabled', true),
    autonomous: bool(content, 'autonomous', false), locked: bool(content, 'locked', false),
    stability: stability === 'core' || stability === 'dynamic' ? stability : 'stable',
    summary: stringField(content, 'summary'), details: stringList(content, 'details'), updatedAt,
    revision: revisionOf(content),
  }
}

function stageOf(path: string): MemoryStage | undefined {
  const value = /^memory\/(short|medium|long)\//u.exec(path)?.[1]
  return value === 'short' || value === 'medium' || value === 'long' ? value : undefined
}

interface RecallUsageEntry {
  readonly path: string
  readonly title: string
  readonly summary: string
  readonly count: number
  readonly lastUsedAt: number
  readonly bestScore: number
}

/** Local filesystem source-of-truth with a rebuildable SQLite projection. */
export class LocalAgentVaultService extends AgentVaultService {
  static Config: z<Config> = z.object({ worldlineHome: z.string() })
  /** Absolute Host root; never exposed through model-facing APIs. */
  readonly root: string
  private readonly indexes = new Map<string, VaultIndex>()
  private readonly mutations = new Map<string, Promise<void>>()
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly watchTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly suppressWatchUntil = new Map<string, number>()
  private readonly leases = new Map<string, { agentId: string; uri: VaultUri; path: string; before: string }>()
  private readonly runtimeBindings = new Map<string, string>()
  private readonly recallUsage = new Map<string, Map<string, RecallUsageEntry>>()
  private readonly logger: Context['logger']

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.logger = ctx.logger
    this.root = resolve(resolveWorldlineHome(config.worldlineHome), 'agents', 'v1')
    ctx.effect(() => () =>{  this.close() }, 'agent-vault-local: close indexes and watchers')
  }

  /** Release file watchers and derived index handles before a data root is moved or removed. */
  close(): void {
    for (const watcher of this.watchers.values()) watcher.close()
    for (const timer of this.watchTimers.values()) clearTimeout(timer)
    for (const index of this.indexes.values()) index.close()
    this.watchers.clear(); this.watchTimers.clear(); this.indexes.clear(); this.runtimeBindings.clear()
    this.leases.clear()
    this.recallUsage.clear()
    this.suppressWatchUntil.clear(); this.mutations.clear()
  }

  /**
   * Bind a runtime Agent to a validated private Vault.
   * @param runtimeAgentId - Runtime identity.
   * @param agentIdValue - Requested Vault identity.
   * @returns Binding disposer.
   */
  bindRuntimeAgent(runtimeAgentId: string, agentIdValue: string): () => void {
    const agentId = validateAgentId(agentIdValue)
    const current = this.runtimeBindings.get(runtimeAgentId)
    if (current !== undefined && current !== agentId) {
      throw new AgentVaultError('Runtime Agent is already bound to another Vault.', 'DOMAIN_VIOLATION')
    }
    this.runtimeBindings.set(runtimeAgentId, agentId)
    return () => {
      if (this.runtimeBindings.get(runtimeAgentId) === agentId) this.runtimeBindings.delete(runtimeAgentId)
    }
  }

  resolveRuntimeAgent(runtimeAgentId: string): string | undefined {
    return this.runtimeBindings.get(runtimeAgentId)
  }

  private agentRoot(value: string): string {
    const id = validateAgentId(value)
    return join(this.root, id.slice(0, 2), id)
  }

  private async requireRoot(agentId: string): Promise<string> {
    const root = this.agentRoot(agentId)
    if (!await exists(join(root, 'manifest.yml'))) throw new AgentVaultError('Agent Vault does not exist.', 'VAULT_NOT_FOUND')
    this.watchAgent(agentId, root)
    return root
  }

  private index(agentId: string, root: string): VaultIndex {
    let value = this.indexes.get(agentId)
    if (value === undefined) {
      value = new VaultIndex(join(root, '.system', 'indexes', 'vault.sqlite'))
      this.indexes.set(agentId, value)
    }
    return value
  }

  private watchAgent(agentId: string, root: string): void {
    if (this.watchers.has(agentId)) return
    try {
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        const path = (filename ?? '').replaceAll('\\', '/')
        if (path.startsWith('.system/') || path.startsWith('history/')) return
        if ((this.suppressWatchUntil.get(agentId) ?? 0) >= Date.now()) return
        const current = this.watchTimers.get(agentId)
        if (current !== undefined) clearTimeout(current)
        this.watchTimers.set(agentId, setTimeout(() => {
          this.watchTimers.delete(agentId)
          void this.rebuildIndex(agentId).catch((error: unknown) => { this.logger.warn(error) })
        }, 80))
      })
      watcher.on('error', (error) => { this.logger.warn(error) })
      this.watchers.set(agentId, watcher)
    } catch (error) { this.logger.warn(error) }
  }

  private async exclusive<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(agentId) ?? Promise.resolve()
    let release: () => void = () => {}
    const barrier = new Promise<void>((resolveBarrier) => { release = resolveBarrier })
    const gate = previous.then(() => barrier, () => barrier)
    this.mutations.set(agentId, gate)
    await previous
    this.suppressWatchUntil.set(agentId, Number.POSITIVE_INFINITY)
    try { return await operation() } finally {
      this.suppressWatchUntil.set(agentId, Date.now() + 250)
      release()
      if (this.mutations.get(agentId) === gate) this.mutations.delete(agentId)
    }
  }

  private async readPolicyFile(root: string): Promise<VaultPolicy> {
    try { return JSON.parse(await readFile(join(root, 'policy.yml'), 'utf8')) as VaultPolicy }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_POLICY
      throw error
    }
  }

  private async authorize(root: string, domain: AgentVaultDomain, context: VaultWriteContext,
    selfLocked = false): Promise<void> {
    const policy = await this.readPolicyFile(root)
    if (context.actor.type === 'system') return
    if (policy.fullyFrozen) throw new AgentVaultError('Agent Vault is fully frozen.', 'VAULT_READONLY')
    if (context.actor.type === 'user') {
      if (!policy.userEditable) throw new AgentVaultError('User editing is disabled.', 'VAULT_READONLY')
      return
    }
    if (selfLocked) throw new AgentVaultError('This self module is locked by the user.', 'USER_LOCKED')
    const mode = policy.domains[domain]
    if (mode !== 'autonomous') {
      throw new AgentVaultError(mode === 'proposal' ? 'This change requires user confirmation.' : 'This Vault domain is read-only.', 'DOMAIN_READONLY')
    }
  }

  async listAgents(): Promise<readonly AgentVaultManifest[]> {
    if (!await exists(this.root)) return []
    const manifests: AgentVaultManifest[] = []
    for (const bucket of await readdir(this.root, { withFileTypes: true })) {
      if (!bucket.isDirectory() || bucket.name.startsWith('.')) continue
      for (const entry of await readdir(join(this.root, bucket.name), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        try { manifests.push(await this.manifest(entry.name)) } catch { /* skip incomplete staging */ }
      }
    }
    return manifests.sort((a, b) => a.agent.name.localeCompare(b.agent.name))
  }

  /**
   * Create a complete portable Vault skeleton.
   * @param agentIdValue - Requested identity.
   * @param nameValue - Display name.
   * @returns Created manifest.
   */
  async createAgent(agentIdValue: string, nameValue: string): Promise<AgentVaultManifest> {
    const agentId = validateAgentId(agentIdValue)
    const name = nameValue.trim()
    if (name === '') throw new AgentVaultError('Agent name is required.', 'INVALID_AGENT_ID')
    const root = this.agentRoot(agentId)
    if (await exists(root)) throw new AgentVaultError('Agent Vault already exists.', 'REVISION_CONFLICT')
    const now = Date.now()
    const manifest: AgentVaultManifest = { format: 'worldline-agent-vault', formatVersion: 1,
      agent: { id: agentId, name }, createdAt: now, updatedAt: now }
    await this.exclusive(agentId, async () => {
      for (const directory of semanticDirectories) await mkdir(join(root, ...directory.split('/')), { recursive: true, mode: 0o700 })
      await writeFileAtomic(join(root, 'manifest.yml'), json(manifest), { mode: 0o600, dirMode: 0o700 })
      await writeFileAtomic(join(root, 'policy.yml'), json(DEFAULT_POLICY), { mode: 0o600, dirMode: 0o700 })
      await writeFileAtomic(join(root, 'AGENTS.md'), '# Agent Vault\n\nUse dedicated Agent Vault tools and preserve provenance.\n', { mode: 0o600, dirMode: 0o700 })
      for (const module of SELF_MODULES) {
        const value = module.id === 'identity' ? { ...module, summary: `我是${name}。` } : module
        await writeFileAtomic(join(root, 'self', `${module.id}.md`), serializeSelf(value), { mode: 0o600, dirMode: 0o700 })
      }
      await writeFileAtomic(join(root, 'maps', 'index.md'), `# ${name} 的 Agent Vault\n\n- [[memory/long/index|长期记忆]]\n- [[procedures/cards/index|能力]]\n`, { mode: 0o600, dirMode: 0o700 })
    })
    await this.rebuildIndex(agentId)
    this.watchAgent(agentId, root)
    return manifest
  }

  async removeAgent(agentId: string, context: VaultWriteContext): Promise<void> {
    const root = await this.requireRoot(agentId)
    await this.authorize(root, 'self', context)
    const trash = join(this.root, '.trash', `${validateAgentId(agentId)}-${Date.now()}`)
    await mkdir(dirname(trash), { recursive: true, mode: 0o700 })
    this.watchers.get(agentId)?.close(); this.watchers.delete(agentId)
    const timer = this.watchTimers.get(agentId)
    if (timer !== undefined) clearTimeout(timer)
    this.watchTimers.delete(agentId); this.suppressWatchUntil.delete(agentId)
    this.indexes.get(agentId)?.close(); this.indexes.delete(agentId)
    for (let attempt = 0; ; attempt++) {
      try { await rename(root, trash); break } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= 7 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
        await new Promise(resolveDelay => setTimeout(resolveDelay, 25 * (attempt + 1)))
      }
    }
  }

  async manifest(agentId: string): Promise<AgentVaultManifest> {
    return JSON.parse(await readFile(join(await this.requireRoot(agentId), 'manifest.yml'), 'utf8')) as AgentVaultManifest
  }

  async policy(agentId: string): Promise<VaultPolicy> { return this.readPolicyFile(await this.requireRoot(agentId)) }

  async setPolicy(agentId: string, policy: VaultPolicy, context: VaultWriteContext): Promise<VaultPolicy> {
    const root = await this.requireRoot(agentId)
    if (context.actor.type === 'agent') throw new AgentVaultError('Agents cannot change Vault policy.', 'DOMAIN_READONLY')
    await writeFileAtomic(join(root, 'policy.yml'), json(policy), { mode: 0o600, dirMode: 0o700 })
    return policy
  }

  async list(agentId: string, uri: VaultUri, cursor = 0, limit = 200): Promise<readonly VaultEntry[]> {
    const root = await this.requireRoot(agentId)
    const target = resolveInside(root, uri)
    await rejectSymlinkAncestors(root, target)
    const entries = await readdir(target, { withFileTypes: true })
    const values = await Promise.all(entries.filter(entry => !entry.name.startsWith('.'))
      .map(async (entry): Promise<VaultEntry> => {
        const path = join(target, entry.name)
        const info = await stat(path)
        const rel = relative(root, path).replaceAll('\\', '/')
        const domain = domainFromRelative(rel)
        const revision = entry.isFile() ? revisionOf(await readFile(path, 'utf8').catch(() => '')) : ''
        return { uri: asVaultUri(rel), id: stableId(agentId, rel), domain,
          kind: entry.isDirectory() ? 'directory' : rel.startsWith('resources/records/') ? 'resource' : 'document',
          name: entry.name, bytes: info.size, revision, updatedAt: info.mtimeMs }
      }))
    return values.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
      .slice(Math.max(0, cursor), Math.max(0, cursor) + Math.max(1, Math.min(500, limit)))
  }

  private async document(agentId: string, root: string, uri: VaultUri,
    view: VaultDocument['view'] = 'full', selector = ''): Promise<VaultDocument> {
    const rel = vaultRelative(uri)
    if (extname(rel).toLocaleLowerCase() !== '.md') throw new AgentVaultError('Vault document must be Markdown.', 'INVALID_URI')
    const path = resolveInside(root, uri)
    await rejectSymlinkAncestors(root, path)
    let content: string
    try { content = await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AgentVaultError('Vault entry was not found.', 'ENTRY_NOT_FOUND')
      throw error
    }
    const info = await stat(path)
    const card = parseMarkdown(content, basename(rel, '.md'))
    return { uri, id: stableId(agentId, rel), domain: domainFromRelative(rel), kind: 'document',
      name: basename(rel), bytes: info.size, revision: revisionOf(content), updatedAt: info.mtimeMs,
      ...card, content: readView(content, view, selector), totalLines: content.split('\n').length, view }
  }

  async read(agentId: string, uri: VaultUri, view: VaultDocument['view'] = 'full', selector = ''): Promise<VaultDocument> {
    return this.document(agentId, await this.requireRoot(agentId), uri, view, selector)
  }

  private async indexDocument(agentId: string, root: string, uri: VaultUri): Promise<VaultDocument> {
    const value = await this.document(agentId, root, uri)
    const rel = vaultRelative(uri)
    const stage = stageOf(rel)
    this.index(agentId, root).putDocument({ id: value.id, path: rel, domain: value.domain,
      ...(stage === undefined ? {} : { stage }), title: value.title,
      summary: value.summary, tags: value.tags, aliases: value.aliases, content: value.content,
      revision: value.revision, updatedAt: value.updatedAt })
    return value
  }

  async write(agentId: string, uri: VaultUri, content: string, context: VaultWriteContext): Promise<VaultDocument> {
    const root = await this.requireRoot(agentId)
    const rel = vaultRelative(uri)
    const domain = domainFromRelative(rel)
    await this.authorize(root, domain, context)
    if (extname(rel).toLocaleLowerCase() !== '.md') throw new AgentVaultError('Vault documents must be Markdown.', 'INVALID_URI')
    return this.exclusive(agentId, async () => {
      const target = resolveInside(root, uri)
      await rejectSymlinkAncestors(root, target)
      if (await exists(target)) {
        const current = await readFile(target, 'utf8')
        const currentRevision = revisionOf(current)
        if (context.expectedRevision !== undefined && context.expectedRevision !== currentRevision) {
          throw new AgentVaultError('Vault document changed before this write.', 'REVISION_CONFLICT', { currentRevision })
        }
        const history = join(root, 'history', rel, `${Date.now()}-${currentRevision}.md`)
        await writeFileAtomic(history, current, { mode: 0o600, dirMode: 0o700 })
      } else if (context.expectedRevision !== undefined) {
        throw new AgentVaultError('Expected revision was supplied for a new document.', 'REVISION_CONFLICT')
      }
      await writeFileAtomic(target, content, { mode: 0o600, dirMode: 0o700 })
      return this.indexDocument(agentId, root, uri)
    })
  }

  async move(agentId: string, source: VaultUri, target: VaultUri, context: VaultWriteContext): Promise<VaultEntry> {
    const root = await this.requireRoot(agentId)
    const sourceRel = vaultRelative(source); const targetRel = vaultRelative(target)
    const sourceDomain = domainFromRelative(sourceRel); const targetDomain = domainFromRelative(targetRel)
    if (sourceDomain !== targetDomain) throw new AgentVaultError('Moves cannot cross Vault domains.', 'DOMAIN_VIOLATION')
    await this.authorize(root, sourceDomain, context)
    return this.exclusive(agentId, async () => {
      const current = await this.document(agentId, root, source)
      if (context.expectedRevision !== undefined && context.expectedRevision !== current.revision) {
        throw new AgentVaultError('Vault document changed before this move.', 'REVISION_CONFLICT')
      }
      const sourcePath = resolveInside(root, source); const targetPath = resolveInside(root, target)
      if (await exists(targetPath)) throw new AgentVaultError('Move target already exists.', 'REVISION_CONFLICT')
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
      await rename(sourcePath, targetPath)
      this.index(agentId, root).removeDocument(sourceRel)
      return this.indexDocument(agentId, root, target)
    })
  }

  async history(agentId: string, uri: VaultUri, limit = 30): Promise<readonly VaultEntry[]> {
    const root = await this.requireRoot(agentId); const rel = vaultRelative(uri)
    const historyRoot = join(root, 'history', rel)
    if (!await exists(historyRoot)) return []
    const entries = await readdir(historyRoot, { withFileTypes: true })
    return Promise.all(entries.filter(entry => entry.isFile()).sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, Math.max(1, Math.min(100, limit))).map(async (entry) => {
        const path = join(historyRoot, entry.name); const info = await stat(path); const content = await readFile(path, 'utf8')
        return { uri, id: stableId(agentId, `${rel}:${entry.name}`), domain: domainFromRelative(rel),
          kind: 'document', name: entry.name, bytes: info.size, revision: revisionOf(content), updatedAt: info.mtimeMs }
      }))
  }

  async recall(input: RecallQuery): Promise<RecallResult> {
    const started = performance.now(); const root = await this.requireRoot(input.agentId)
    const maxResults = Math.max(1, Math.min(20, input.budget?.maxResults ?? 5))
    const maxChars = Math.max(200, Math.min(20_000, input.budget?.maxChars ?? 4_000))
    const maxMillis = Math.max(5, Math.min(2_000, input.budget?.maxMillis ?? 50))
    const terms = queryTerms(input.query, input.tags)
    const candidates = this.index(input.agentId, root).searchDocuments(input.domain, input.query, terms,
      input.stage, Math.max(30, maxResults * 10))
    const cards = candidates.map((candidate) => {
      const scored = scoreCandidate({ query: input.query, terms, path: candidate.path,
        title: candidate.title, summary: candidate.summary, tags: candidate.tags,
        aliases: candidate.aliases, rank: candidate.rank })
      return { uri: asVaultUri(candidate.path), id: candidate.id, domain: input.domain,
        title: candidate.title, summary: candidate.summary.slice(0, Math.min(700, maxChars)),
        tags: candidate.tags.slice(0, 16), score: scored.score,
        confidence: scored.score >= 70 ? 'high' as const : scored.score >= 35 ? 'medium' as const : 'low' as const,
        reasons: scored.reasons, matchedTerms: scored.matched, revision: candidate.revision,
        updatedAt: candidate.updatedAt }
    }).filter(card => card.score > 0).sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
    let used = 0
    const bounded = cards.filter((card) => {
      const size = card.title.length + card.summary.length + card.tags.join('').length
      if (used + size > maxChars || (used > 0 && performance.now() - started > maxMillis)) return false
      used += size; return true
    }).slice(0, maxResults)
    if (input.domain === 'memory' && bounded.length > 0) {
      // Usage telemetry feeds the phase-based common-memory cache, but it is not part of
      // the answer itself. Keep it in memory until consolidation checkpoints the phase.
      this.noteRecallUsage(input.agentId, bounded)
    }
    return { cards: bounded, ...(cards.length > bounded.length ? { continuation: String(bounded.length) } : {}),
      elapsedMs: performance.now() - started, indexRevision: this.index(input.agentId, root).revision() }
  }

  private noteRecallUsage(agentId: string, cards: RecallResult['cards']): void {
    const entries = this.recallUsage.get(agentId) ?? new Map<string, RecallUsageEntry>()
    const now = Date.now()
    for (const card of cards) {
      const key = card.uri.slice('vault://'.length)
      const previous = entries.get(key)
      entries.set(key, { path: key, title: card.title, summary: card.summary,
        count: (previous?.count ?? 0) + 1, lastUsedAt: now,
        bestScore: Math.max(previous?.bestScore ?? 0, card.score) })
    }
    if (entries.size > 2_000) {
      const retained = [...entries.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, 2_000)
      entries.clear()
      for (const entry of retained) entries.set(entry.path, entry)
    }
    this.recallUsage.set(agentId, entries)
  }

  private async flushRecallUsage(agentId: string, root: string): Promise<void> {
    const pending = this.recallUsage.get(agentId)
    if (pending === undefined || pending.size === 0) return
    this.recallUsage.delete(agentId)
    try {
      await this.exclusive(agentId, async () => {
        const path = join(root, '.system', 'cache', 'recall-usage.json')
        const current = await readFile(path, 'utf8').then(value => JSON.parse(value) as RecallUsageEntry[], () => [])
        const entries = new Map(current.map(value => [value.path, value]))
        for (const update of pending.values()) {
          const previous = entries.get(update.path)
          entries.set(update.path, { ...update, count: (previous?.count ?? 0) + update.count,
            bestScore: Math.max(previous?.bestScore ?? 0, update.bestScore) })
        }
        const retained = [...entries.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, 2_000)
        await writeFileAtomic(path, json(retained), { mode: 0o600, dirMode: 0o700 })
      })
    } catch (error) {
      const current = this.recallUsage.get(agentId) ?? new Map<string, RecallUsageEntry>()
      for (const [key, value] of pending) if (!current.has(key)) current.set(key, value)
      this.recallUsage.set(agentId, current)
      throw error
    }
  }

  private async refreshCommonMemory(agentId: string, root: string): Promise<void> {
    const usagePath = join(root, '.system', 'cache', 'recall-usage.json')
    const usage = await readFile(usagePath, 'utf8').then(value => JSON.parse(value) as RecallUsageEntry[], () => [])
    const now = Date.now()
    const normalized = await Promise.all(usage.map(async (entry) => {
      if (await exists(join(root, ...entry.path.split('/')))) return entry
      const match = /^memory\/(?:short|medium|long)\/(.+)$/u.exec(entry.path)
      if (match === null) return entry
      for (const stage of ['long', 'medium', 'short']) {
        const path = `memory/${stage}/${match[1]}`
        if (await exists(join(root, ...path.split('/')))) return { ...entry, path }
      }
      return entry
    }))
    const selected = normalized.map(entry => ({ entry,
      score: Math.log2(entry.count + 1) * 24 + entry.bestScore * 0.35
        + Math.max(0, 30 - (now - entry.lastUsedAt) / 86_400_000) }))
      .filter(value => value.entry.count >= 2 || value.entry.bestScore >= 70)
      .sort((a, b) => b.score - a.score || b.entry.lastUsedAt - a.entry.lastUsedAt).slice(0, 12)
    if (selected.length === 0) return
    const current = (await this.inspectSelf(agentId)).modules.find(module => module.id === 'common-memory')
    if (current === undefined) return
    const details = selected.map(({ entry }) => `[[${entry.path}]]（使用 ${entry.count} 次）— ${entry.summary.slice(0, 160)}`)
    if (current.details.join('\n') === details.join('\n')) return
    await this.updateSelf(agentId, { ...current, summary: `阶段性整理的 ${details.length} 条高频认知；不会随单次对话即时漂移。`, details },
      { actor: { type: 'system', id: 'cognitive-cache' }, reason: 'Refresh stable common memory after a completed consolidation stage.',
        expectedRevision: current.revision })
  }

  async explore(agentId: string, origins: readonly VaultUri[], maxPages = 8, maxChars = 24_000): Promise<readonly VaultDocument[]> {
    const root = await this.requireRoot(agentId); const queue = [...origins]; const seen = new Set<string>()
    const result: VaultDocument[] = []; let chars = 0
    while (queue.length > 0 && result.length < Math.max(1, Math.min(50, maxPages))) {
      const uri = queue.shift(); if (uri === undefined || seen.has(uri)) continue
      seen.add(uri)
      const doc = await this.document(agentId, root, uri, 'top').catch(() => undefined)
      if (doc === undefined || chars + doc.content.length > maxChars) continue
      result.push(doc); chars += doc.content.length
      for (const link of doc.links) {
        const target = link.endsWith('.md') ? link : `${link}.md`
        const base = target.startsWith('memory/') || target.startsWith('procedures/') ? target
          : join(dirname(vaultRelative(uri)), target).replaceAll('\\', '/')
        queue.push(asVaultUri(base))
      }
    }
    return result
  }

  async inspectSelf(agentId: string): Promise<SelfSnapshot> {
    const root = await this.requireRoot(agentId); const modules: SelfModule[] = []
    for (const entry of await readdir(join(root, 'self'), { withFileTypes: true })) {
      if (!entry.isFile() || extname(entry.name) !== '.md') continue
      const path = join(root, 'self', entry.name); const content = await readFile(path, 'utf8'); const info = await stat(path)
      modules.push(parseSelf(content, basename(entry.name, '.md'), info.mtimeMs))
    }
    modules.sort((a, b) => SELF_MODULES.findIndex(value => value.id === a.id) - SELF_MODULES.findIndex(value => value.id === b.id))
    const compiled = modules.filter(module => module.enabled).map(module => `## ${module.title}\n${module.summary}\n${module.details.map(value => `- ${value}`).join('\n')}`)
      .join('\n\n').slice(0, 12_000)
    return { agentId, modules, compiled, revision: revisionOf(modules.map(module => module.revision).join(':')) }
  }

  async updateSelf(agentId: string, module: SelfModule, context: VaultWriteContext): Promise<SelfModule> {
    const root = await this.requireRoot(agentId); const id = module.id.trim().toLocaleLowerCase('en-US')
    if (!/^[a-z][a-z\d-]{0,79}$/u.test(id)) throw new AgentVaultError('Self module id is invalid.', 'INVALID_URI')
    const uri = asVaultUri(`self/${id}.md`); let current: SelfModule | undefined
    try { const path = resolveInside(root, uri); const content = await readFile(path, 'utf8'); current = parseSelf(content, id, (await stat(path)).mtimeMs) } catch { current = undefined }
    if (context.actor.type === 'agent' && current?.autonomous !== true) {
      throw new AgentVaultError('This self module requires an explicit user-directed change.', 'DOMAIN_READONLY')
    }
    if (context.actor.type === 'agent' && current?.stability === 'stable'
      && Date.now() - current.updatedAt < 6 * 60 * 60_000) {
      throw new AgentVaultError('This stable self module can change only at a later maintenance checkpoint.', 'DOMAIN_READONLY')
    }
    await this.authorize(root, 'self', context, current?.locked === true)
    if (current !== undefined && context.expectedRevision !== undefined && current.revision !== context.expectedRevision) {
      throw new AgentVaultError('Self module changed before this update.', 'REVISION_CONFLICT')
    }
    await this.write(agentId, uri, serializeSelf({ ...module, id }), { ...context,
      ...(current === undefined ? {} : { expectedRevision: current.revision }) })
    const path = resolveInside(root, uri); const content = await readFile(path, 'utf8')
    return parseSelf(content, id, (await stat(path)).mtimeMs)
  }

  async captureMemory(input: CaptureMemoryInput, context: VaultWriteContext): Promise<VaultDocument> {
    const root = await this.requireRoot(input.agentId); await this.authorize(root, 'memory', context)
    const now = Date.now(); const date = new Date(now); const segment = [date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join('/')
    const uri = asVaultUri(`memory/short/${segment}/${now}-${randomUUID()}.md`)
    return this.write(input.agentId, uri, memoryMarkdown({ title: input.title.trim() || '未命名记忆',
      content: input.content, tags: [...new Set(input.tags ?? [])], aliases: [...new Set(input.aliases ?? [])],
      sources: [...new Set(input.sources ?? [])], importance: input.importance ?? 3,
      occurredAt: input.occurredAt ?? now }), context)
  }

  private jobPath(root: string, id: string): string { return join(root, 'queue', `${id}.json`) }

  /**
   * Queue an adjacent memory-stage transition.
   * @param agentId - Vault identity.
   * @param sourceStage - Source stage.
   * @param targetStage - Target stage.
   * @param context - Authorized mutation context.
   * @returns Queued job.
   */
  async queueConsolidation(agentId: string, sourceStage: MemoryStage, targetStage: MemoryStage,
    context: VaultWriteContext): Promise<ConsolidationJob> {
    const root = await this.requireRoot(agentId); await this.authorize(root, 'memory', context)
    const order: MemoryStage[] = ['short', 'medium', 'long']
    if (order.indexOf(targetStage) !== order.indexOf(sourceStage) + 1) throw new AgentVaultError('Memory consolidation advances exactly one stage.', 'DOMAIN_VIOLATION')
    const sourceRoot = join(root, 'memory', sourceStage); const documents = await this.markdownFiles(sourceRoot)
    const now = Date.now(); const job: ConsolidationJob = { id: randomUUID(), agentId, status: 'queued',
      sourceStage, targetStage, total: documents.length, processed: 0, createdAt: now, updatedAt: now }
    await writeFileAtomic(this.jobPath(root, job.id), json(job), { mode: 0o600, dirMode: 0o700 })
    return job
  }

  async runConsolidation(jobId: string, maxItems = 100): Promise<ConsolidationJob> {
    for (const manifest of await this.listAgents()) {
      const root = await this.requireRoot(manifest.agent.id); const path = this.jobPath(root, jobId)
      if (!await exists(path)) continue
      return withFileLock(path, async () => {
        let job = JSON.parse(await readFile(path, 'utf8')) as ConsolidationJob
        if (job.status === 'completed') return job
        job = { ...job, status: 'running', updatedAt: Date.now() }
        await writeFileAtomic(path, json(job), { mode: 0o600, dirMode: 0o700 })
        const files = await this.markdownFiles(join(root, 'memory', job.sourceStage))
        const batch = files.sort().filter(value => job.checkpoint === undefined || value > job.checkpoint)
          .slice(0, Math.max(1, Math.min(1_000, maxItems)))
        try {
          for (const file of batch) {
            const rel = relative(join(root, 'memory', job.sourceStage), file).replaceAll('\\', '/')
            const targetRel = `memory/${job.targetStage}/${rel}`; const target = join(root, ...targetRel.split('/'))
            await mkdir(dirname(target), { recursive: true, mode: 0o700 })
            if (await exists(target)) {
              const [left, right] = await Promise.all([readFile(file), readFile(target)])
              if (sha256(left) !== sha256(right)) throw new AgentVaultError('Consolidation target conflicts with existing memory.', 'REVISION_CONFLICT')
              await rm(file)
            } else await rename(file, target)
            this.index(job.agentId, root).removeDocument(relative(root, file).replaceAll('\\', '/'))
            await this.indexDocument(job.agentId, root, asVaultUri(targetRel))
            job = { ...job, processed: job.processed + 1, checkpoint: file, updatedAt: Date.now() }
            await writeFileAtomic(path, json(job), { mode: 0o600, dirMode: 0o700 })
          }
          const remaining = await this.markdownFiles(join(root, 'memory', job.sourceStage))
          job = { ...job, status: remaining.length === 0 ? 'completed' : 'paused', updatedAt: Date.now() }
        } catch (error) {
          job = { ...job, status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() }
        }
        await writeFileAtomic(path, json(job), { mode: 0o600, dirMode: 0o700 })
        if (job.status === 'completed') {
          await this.flushRecallUsage(job.agentId, root)
          await this.refreshCommonMemory(job.agentId, root)
        }
        return job
      }, { waitMs: 30_000 })
    }
    throw new AgentVaultError('Consolidation job was not found.', 'ENTRY_NOT_FOUND')
  }

  async consolidationJobs(agentId: string): Promise<readonly ConsolidationJob[]> {
    const root = await this.requireRoot(agentId); const values: ConsolidationJob[] = []
    for (const entry of await readdir(join(root, 'queue'), { withFileTypes: true })) {
      if (entry.isFile() && extname(entry.name) === '.json') values.push(JSON.parse(await readFile(join(root, 'queue', entry.name), 'utf8')) as ConsolidationJob)
    }
    return values.sort((a, b) => b.createdAt - a.createdAt)
  }

  async importResource(agentId: string, draft: VaultResourceDraft,
    data: Uint8Array | undefined, context: VaultWriteContext): Promise<VaultResource> {
    const root = await this.requireRoot(agentId); await this.authorize(root, 'resource', context)
    if (data === undefined && draft.externalUrl === undefined) throw new AgentVaultError('Resource needs bytes or an external URL.', 'INVALID_RESOURCE')
    let digest: string | undefined
    if (data !== undefined) {
      digest = sha256(data); const object = join(root, 'resources', 'objects', 'sha256', digest.slice(0, 2), digest)
      if (!await exists(object)) {
        await mkdir(dirname(object), { recursive: true, mode: 0o700 })
        await writeFile(object, data, { flag: 'wx', mode: 0o600 }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        })
      }
    }
    return await this.persistResourceRecord(agentId, root, draft, digest, data?.byteLength ?? draft.bytes)
  }

  private async persistResourceRecord(agentId: string, root: string, draft: VaultResourceDraft,
    digest: string | undefined, bytes: number): Promise<VaultResource> {
    const id = draft.preferredId ?? randomUUID()
    if (!/^[a-z\d][a-z\d._-]{0,199}$/iu.test(id)) throw new AgentVaultError('Resource id is invalid.', 'INVALID_RESOURCE')
    const now = Date.now(); const createdAt = draft.createdAt ?? now
    const base = { id, agentId, uri: asVaultUri(`resources/records/${id}.yml`), enabled: draft.enabled,
      roles: [...new Set(draft.roles)], title: draft.title.trim(), description: draft.description.trim(),
      tags: [...new Set(draft.tags.map(value => value.trim()).filter(Boolean))],
      originalTags: [...new Set(draft.originalTags)], transcript: draft.transcript,
      mimeType: draft.mimeType.toLocaleLowerCase(), bytes,
      ...(draft.durationMs === undefined ? {} : { durationMs: draft.durationMs }),
      usageCount: Math.max(0, Math.trunc(draft.usageCount ?? 0)),
      ...(draft.lastUsedAt === undefined ? {} : { lastUsedAt: draft.lastUsedAt }),
      ...(digest === undefined ? {} : { sha256: digest }), ...(draft.externalUrl === undefined ? {} : { externalUrl: draft.externalUrl }),
      builtIn: draft.builtIn, createdAt, updatedAt: now }
    if (base.title === '' || !base.mimeType.includes('/')) throw new AgentVaultError('Resource metadata is invalid.', 'INVALID_RESOURCE')
    const value: VaultResource = { ...base, revision: revisionOf(json(base)) }
    const record = resolveInside(root, value.uri)
    await writeFileAtomic(record, json(value), { mode: 0o600, dirMode: 0o700 })
    const date = new Date(now); const eventPath = join(root, 'resources', 'by-date', String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0'), `${now}-${id}.yml`)
    await writeFileAtomic(eventPath, json({ id, title: value.title, sha256: digest, importedAt: now }), { mode: 0o600, dirMode: 0o700 })
    this.index(agentId, root).putResource(value); return value
  }

  async importResourceFromFile(agentId: string, draft: VaultResourceDraft, sourceFile: string,
    context: VaultWriteContext): Promise<VaultResource> {
    const root = await this.requireRoot(agentId); await this.authorize(root, 'resource', context)
    const info = await stat(sourceFile)
    if (!info.isFile()) throw new AgentVaultError('Resource source is not a file.', 'INVALID_RESOURCE')
    const hash = createHash('sha256')
    for await (const value of createReadStream(sourceFile)) {
      const chunk: unknown = value
      if (!(chunk instanceof Uint8Array)) throw new AgentVaultError('Resource stream is invalid.', 'INVALID_RESOURCE')
      hash.update(chunk)
    }
    const digest = hash.digest('hex')
    const object = join(root, 'resources', 'objects', 'sha256', digest.slice(0, 2), digest)
    await mkdir(dirname(object), { recursive: true, mode: 0o700 })
    await copyFile(sourceFile, object, constants.COPYFILE_EXCL).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    return await this.persistResourceRecord(agentId, root, { ...draft, bytes: info.size }, digest, info.size)
  }

  async searchResources(input: ResourceSearchInput): Promise<ResourcePage> {
    const root = await this.requireRoot(input.agentId); const cursor = Math.max(0, input.cursor ?? 0)
    const limit = Math.max(1, Math.min(100, input.limit ?? 30))
    const items = this.index(input.agentId, root).searchResources(input.query, input.tags ?? [],
      input.roles ?? [], input.includeDisabled === true, cursor, limit)
    return { items, nextCursor: items.length < limit ? -1 : cursor + items.length }
  }

  async resource(agentId: string, id: string): Promise<VaultResource> {
    const root = await this.requireRoot(agentId)
    try { return JSON.parse(await readFile(join(root, 'resources', 'records', `${id}.yml`), 'utf8')) as VaultResource }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AgentVaultError('Resource was not found.', 'ENTRY_NOT_FOUND'); throw error }
  }

  async resourceContent(agentId: string, id: string): Promise<import('@deepseek-ai/dsh-agent-vault').VaultResourceContent> {
    const root = await this.requireRoot(agentId)
    const resource = await this.resource(agentId, id)
    if (resource.sha256 !== undefined) {
      const path = join(root, 'resources', 'objects', 'sha256', resource.sha256.slice(0, 2), resource.sha256)
      if (!await exists(path)) throw new AgentVaultError('Resource content is missing.', 'ENTRY_NOT_FOUND')
      return { type: 'file', path, mimeType: resource.mimeType, bytes: resource.bytes }
    }
    if (resource.externalUrl !== undefined) {
      return { type: 'external', url: resource.externalUrl, mimeType: resource.mimeType }
    }
    throw new AgentVaultError('Resource has no deliverable content.', 'INVALID_RESOURCE')
  }

  async updateResource(agentId: string, id: string, patch: Partial<Pick<VaultResource,
    'title' | 'description' | 'tags' | 'originalTags' | 'transcript' | 'roles' | 'durationMs'>>,
  context: VaultWriteContext): Promise<VaultResource> {
    const root = await this.requireRoot(agentId); await this.authorize(root, 'resource', context)
    const current = await this.resource(agentId, id)
    if (context.expectedRevision !== undefined && context.expectedRevision !== current.revision) {
      throw new AgentVaultError('Resource changed before this update.', 'REVISION_CONFLICT')
    }
    const base = { ...current, ...patch,
      ...(patch.tags === undefined ? {} : { tags: [...new Set(patch.tags.map(value => value.trim()).filter(Boolean))] }),
      ...(patch.originalTags === undefined ? {} : { originalTags: [...new Set(patch.originalTags)] }),
      ...(patch.roles === undefined ? {} : { roles: [...new Set(patch.roles)] }),
      updatedAt: Date.now(), revision: '' }
    if (base.title.trim() === '') throw new AgentVaultError('Resource title is required.', 'INVALID_RESOURCE')
    const value: VaultResource = { ...base, title: base.title.trim(), revision: revisionOf(json(base)) }
    await writeFileAtomic(join(root, 'resources', 'records', `${id}.yml`), json(value), { mode: 0o600, dirMode: 0o700 })
    this.index(agentId, root).putResource(value); return value
  }

  async removeResource(agentId: string, id: string, context: VaultWriteContext): Promise<void> {
    const root = await this.requireRoot(agentId); await this.authorize(root, 'resource', context)
    const current = await this.resource(agentId, id)
    if (context.expectedRevision !== undefined && context.expectedRevision !== current.revision) {
      throw new AgentVaultError('Resource changed before this update.', 'REVISION_CONFLICT')
    }
    const target = join(root, 'history', 'resources', `${Date.now()}-${id}.yml`)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await rename(join(root, 'resources', 'records', `${id}.yml`), target)
    this.index(agentId, root).removeResource(id)
  }

  async setResourceEnabled(agentId: string, id: string, enabled: boolean, context: VaultWriteContext): Promise<VaultResource> {
    const root = await this.requireRoot(agentId); await this.authorize(root, 'resource', context)
    const current = await this.resource(agentId, id)
    if (context.expectedRevision !== undefined && context.expectedRevision !== current.revision) throw new AgentVaultError('Resource changed before this update.', 'REVISION_CONFLICT')
    const base = { ...current, enabled, updatedAt: Date.now(), revision: '' }; const value = { ...base, revision: revisionOf(json(base)) }
    await writeFileAtomic(join(root, 'resources', 'records', `${id}.yml`), json(value), { mode: 0o600, dirMode: 0o700 })
    this.index(agentId, root).putResource(value); return value
  }

  async exportAgent(agentId: string, targetFile: string, shareable: boolean): Promise<VaultPackageReport> {
    const root = await this.requireRoot(agentId); const result = await pack(root, agentId, targetFile, shareable)
    const resources = (await readdir(join(root, 'resources', 'records'))).length
    return { agentId, files: result.files, resources, bytes: result.bytes, sha256: result.sha256, warnings: [] }
  }

  async importAgent(packageFile: string, targetAgentId?: string): Promise<VaultPackageReport> {
    const staging = join(this.root, '.staging', randomUUID()); await mkdir(staging, { recursive: true, mode: 0o700 })
    try {
      const report = await unpack(packageFile, staging); const id = validateAgentId(targetAgentId ?? report.agentId)
      const manifestPath = join(staging, 'manifest.yml')
      const candidate: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new AgentVaultError('Package has no valid Agent Vault manifest.', 'IMPORT_REJECTED')
      }
      const manifest = candidate as Partial<AgentVaultManifest>
      if (manifest.format !== 'worldline-agent-vault' || manifest.formatVersion !== 1
        || manifest.agent === undefined || typeof manifest.agent.id !== 'string') {
        throw new AgentVaultError('Package has no valid Agent Vault manifest.', 'IMPORT_REJECTED')
      }
      const target = this.agentRoot(id); if (await exists(target)) throw new AgentVaultError('Import target already exists.', 'REVISION_CONFLICT')
      if (id !== manifest.agent.id) {
        await writeFileAtomic(manifestPath, json({ ...manifest, agent: { ...manifest.agent, id },
          updatedAt: Date.now() }), { mode: 0o600, dirMode: 0o700 })
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await rename(staging, target)
      await this.rewriteImportedResourceAgents(target, id); await this.rebuildIndex(id)
      const resources = (await readdir(join(target, 'resources', 'records')).catch(() => [])).length
      return { agentId: id, files: report.files, resources, bytes: report.bytes, sha256: report.sha256, warnings: [] }
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
  }

  private async rewriteImportedResourceAgents(root: string, agentId: string): Promise<void> {
    const directory = join(root, 'resources', 'records'); if (!await exists(directory)) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(directory, entry.name); const current = JSON.parse(await readFile(path, 'utf8')) as VaultResource
      if (current.agentId === agentId) continue
      const base = { ...current, agentId, revision: '', updatedAt: Date.now() }
      await writeFileAtomic(path, json({ ...base, revision: revisionOf(json(base)) }), { mode: 0o600, dirMode: 0o700 })
    }
  }

  async rebuildIndex(agentId: string): Promise<number> {
    const root = await this.requireRoot(agentId); const index = this.index(agentId, root)
    const documents: import('./database.ts').IndexedDocument[] = []
    for (const directory of ['self', 'memory', 'procedures', 'maps', 'skills']) {
      const base = join(root, directory); if (!await exists(base)) continue
      for (const path of await this.markdownFiles(base)) {
        const rel = relative(root, path).replaceAll('\\', '/'); const content = await readFile(path, 'utf8'); const info = await stat(path)
        const card = parseMarkdown(content, basename(path, '.md')); const domain = rel.startsWith('self/') ? 'self'
          : rel.startsWith('procedures/') ? 'procedure' : 'memory'
        const stage = stageOf(rel)
        documents.push({ id: stableId(agentId, rel), path: rel, domain,
          ...(stage === undefined ? {} : { stage }),
          title: card.title, summary: card.summary, tags: card.tags, aliases: card.aliases, content,
          revision: revisionOf(content), updatedAt: info.mtimeMs })
      }
    }
    const resources: VaultResource[] = []; const records = join(root, 'resources', 'records')
    if (await exists(records)) for (const entry of await readdir(records, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      try { resources.push(JSON.parse(await readFile(join(records, entry.name), 'utf8')) as VaultResource) } catch (error) { this.logger.warn(error) }
    }
    return index.replaceProjection(documents, resources)
  }

  async resolvePath(agentId: string, uri: VaultUri, mode: 'read' | 'write', context?: VaultWriteContext): Promise<{ path: string; leaseId?: string }> {
    const root = await this.requireRoot(agentId); const path = resolveInside(root, uri); await rejectSymlinkAncestors(root, path)
    if (mode === 'read') return { path }
    if (context === undefined) throw new AgentVaultError('A write lease requires write context.', 'DOMAIN_READONLY')
    await this.authorize(root, domainFromRelative(vaultRelative(uri)), context)
    const before = await readFile(path).then(data => sha256(data), () => '')
    const leaseId = randomUUID(); this.leases.set(leaseId, { agentId, uri, path, before }); return { path, leaseId }
  }

  async reconcile(agentId: string, leaseId: string): Promise<VaultEntry> {
    const lease = this.leases.get(leaseId)
    if (lease === undefined || lease.agentId !== agentId) throw new AgentVaultError('Write lease is invalid.', 'INVALID_URI')
    this.leases.delete(leaseId); const data = await readFile(lease.path); const after = sha256(data)
    if (after !== lease.before && extname(lease.path).toLocaleLowerCase() === '.md') await this.indexDocument(agentId, await this.requireRoot(agentId), lease.uri)
    const info = await stat(lease.path); const rel = vaultRelative(lease.uri)
    return { uri: lease.uri, id: stableId(agentId, rel), domain: domainFromRelative(rel), kind: 'document',
      name: basename(rel), bytes: info.size, revision: revisionOf(data.toString('utf8')), updatedAt: info.mtimeMs }
  }

  private async markdownFiles(root: string): Promise<string[]> {
    if (!await exists(root)) return []
    const values: string[] = []
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) await walk(path)
        else if (entry.isFile() && extname(entry.name).toLocaleLowerCase() === '.md') values.push(path)
      }
    }
    await walk(root); return values
  }
}

export default LocalAgentVaultService
