/** Guarded model tools over the authoritative Worldline services. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  CompilerProposal,
  ProposalTarget,
} from '@deepseek-ai/dsh-worldline-compiler'
import type {
  AiBudget,
  JsonObject,
  ProjectTemplate,
  Revision,
  SourceAnchor,
  WorldMap,
} from '@deepseek-ai/dsh-worldline-standard'
import { validateWorldMap, worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-worldline-compiler'
import type {
  WorldlineConversationBinding,
} from '@deepseek-ai/dsh-worldline-conversation-context'
import type { ImportProjectRequest } from '@deepseek-ai/dsh-worldline-project'
import type {} from '@deepseek-ai/dsh-worldline-runtime'

const OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/** Identifies the package-owned worldline tool names value.
 */
export const WORLDLINE_TOOL_NAMES = [
  'worldline_project',
  'worldline_query',
  'worldline_edit',
  'worldline_link',
  'worldline_map',
  'worldline_build',
  'worldline_run',
  'worldline_explain',
  'worldline_transfer',
] as const

type JsonRecord = Record<string, unknown>

const encode = (value: unknown): string => JSON.stringify(value)
const string = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  return value.trim()
}
const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
function optionalField<Key extends string>(key: Key, value: unknown): {} | Record<Key, string> {
  const resolved = optionalString(value)
  return resolved === undefined ? {} : { [key]: resolved }
}
const integer = (value: unknown, fallback: number): number => Number.isSafeInteger(value) ? Number(value) : fallback
const positiveDuration = (value: unknown, fallback: number, name: string): number => {
  const resolved = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`${name} must be positive`)
  return Math.min(3_600, resolved)
}
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').slice(0, 128)
  : []
const projectId = (value: unknown) => worldlineId<'project'>(string(value, 'project_id'))
const runId = (value: unknown) => worldlineId<'run'>(string(value, 'run_id'))
const entityId = (value: unknown) => worldlineId<'entity'>(string(value, 'actor_id'))
const revision = (value: unknown, name = 'expected_revision') => string(value, name) as Revision
const MAP_FENCE = /```worldline-map\s*\r?\n([\s\S]*?)\r?\n```/iu

interface BoundExecution {
  readonly agent?: { readonly session: Pick<Session, 'id' | 'events'> }
}

async function selectProjectScope(
  ctx: Context,
  exec: BoundExecution,
  id: ReturnType<typeof projectId>,
  selectedRunId?: ReturnType<typeof runId>,
): Promise<WorldlineConversationBinding> {
  if (exec.agent === undefined) throw new Error('Worldline tools require an Agent execution')
  const current = ctx.worldlineConversationContexts.binding(exec.agent.session)
  if (current?.projectId === id
    && (selectedRunId === undefined || current.runId === selectedRunId)) return current
  return await ctx.worldlineConversationContexts.bind({
    sessionId: exec.agent.session.id,
    projectId: id,
    ...(selectedRunId === undefined ? {} : { runId: selectedRunId }),
  })
}

async function assertRunScope(ctx: Context, exec: BoundExecution, id: ReturnType<typeof runId>): Promise<void> {
  const run = await ctx.worldlineRuns.view({ runId: id })
  await selectProjectScope(ctx, exec, run.summary.projectId, id)
}

function objectJson(value: unknown, name: string): JsonObject {
  const source = string(value, name)
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { throw new Error(`${name} must be valid JSON`) }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${name} must contain one JSON object`)
  }
  return parsed as JsonObject
}

function anchorsJson(value: unknown): SourceAnchor[] {
  const parsed = objectJson(value, 'anchors_json')
  const entries = parsed['anchors']
  if (!Array.isArray(entries)) throw new Error('anchors_json must contain an anchors array')
  return entries.map((entry, index) => {
    if (entry === null || Array.isArray(entry) || typeof entry !== 'object') {
      throw new Error(`anchors_json.anchors[${String(index)}] must be an object`)
    }
    const anchor = entry as JsonRecord
    return {
      id: worldlineId<'source-anchor'>(string(anchor['id'], 'id')),
      documentId: worldlineId<'document'>(string(anchor['documentId'], 'documentId')),
      revision: revision(anchor['revision'], 'revision'),
      ...optionalField('heading', anchor['heading']),
      startOffset: Math.max(0, integer(anchor['startOffset'], 0)),
      endOffset: Math.max(0, integer(anchor['endOffset'], 0)),
      excerptHash: string(anchor['excerptHash'], 'excerptHash'),
      ...optionalField('contextBefore', anchor['contextBefore']),
      ...optionalField('contextAfter', anchor['contextAfter']),
    }
  })
}

function worldMapJson(value: unknown): WorldMap {
  const parsed = objectJson(value, 'map_json') as JsonRecord
  if (parsed['version'] !== 1) throw new Error('map_json.version 必须是当前格式 1')
  if (!Array.isArray(parsed['layers']) || !Array.isArray(parsed['nodes']) || !Array.isArray(parsed['edges'])) {
    throw new Error('map_json 必须包含 layers、nodes 和 edges 数组')
  }
  const map = { ...parsed, provenance: [] } as unknown as WorldMap
  worldlineId<'map'>(string(map.id, 'map_json.id'))
  worldlineId<'map-node'>(string(map.rootNodeId, 'map_json.rootNodeId'))
  if (typeof map.name !== 'string' || map.name.trim() === '') throw new Error('map_json.name 不能为空')
  for (const [index, layer] of map.layers.entries()) {
    if (typeof layer.id !== 'string' || layer.id === '' || typeof layer.name !== 'string'
      || typeof layer.visible !== 'boolean' || typeof layer.locked !== 'boolean'
      || !Number.isFinite(layer.order)) throw new Error(`map_json.layers[${String(index)}] 缺少当前格式字段`)
  }
  for (const [index, node] of map.nodes.entries()) {
    worldlineId<'map-node'>(string(node.id, `map_json.nodes[${String(index)}].id`))
    if (node.parentId !== undefined) worldlineId<'map-node'>(node.parentId)
    if (typeof node.name !== 'string' || node.name.trim() === '' || typeof node.layerId !== 'string'
      || !['world', 'plane', 'region', 'city', 'building', 'room', 'slot'].includes(node.kind)
      || !Array.isArray(node.permissions) || !Array.isArray(node.hazards)
      || !Array.isArray(node.entryNodeIds)) {
      throw new Error(`map_json.nodes[${String(index)}] 缺少当前格式字段`)
    }
  }
  for (const [index, edge] of map.edges.entries()) {
    worldlineId<'map-edge'>(string(edge.id, `map_json.edges[${String(index)}].id`))
    worldlineId<'map-node'>(string(edge.from, `map_json.edges[${String(index)}].from`))
    worldlineId<'map-node'>(string(edge.to, `map_json.edges[${String(index)}].to`))
    if (typeof edge.bidirectional !== 'boolean' || !Number.isFinite(edge.distance)
      || !Number.isFinite(edge.baseDuration) || !Array.isArray(edge.modes)
      || !Array.isArray(edge.permissions) || !Array.isArray(edge.hazards)) {
      throw new Error(`map_json.edges[${String(index)}] 缺少当前格式字段`)
    }
  }
  const issues = validateWorldMap(map)
  if (issues.length > 0) {
    throw new Error(`地图校验失败：${issues.map(issue => issue.message).join('；')}`)
  }
  const geometryCells = new Map<string, typeof map.nodes[number][]>()
  for (const node of map.nodes) {
    const cellX = Math.floor(node.position.x / 124)
    const cellY = Math.floor(node.position.y / 64)
    for (let x = cellX - 1; x <= cellX + 1; x += 1) {
      for (let y = cellY - 1; y <= cellY + 1; y += 1) {
        const overlapping = (geometryCells.get(`${node.layerId}:${String(x)}:${String(y)}`) ?? [])
          .find(other => Math.abs(other.position.x - node.position.x) < 124
            && Math.abs(other.position.y - node.position.y) < 64)
        if (overlapping !== undefined) {
          throw new Error(`地图校验失败：节点 ${overlapping.name} 与 ${node.name} 在同一图层重叠，请重新排布坐标`)
        }
      }
    }
    const key = `${node.layerId}:${String(cellX)}:${String(cellY)}`
    const bucket = geometryCells.get(key) ?? []
    bucket.push(node)
    geometryCells.set(key, bucket)
  }
  return map
}

function replaceMapFence(content: string, map: WorldMap): string {
  const { provenance: _provenance, ...sourceMap } = map
  const block = `\`\`\`worldline-map\n${JSON.stringify(sourceMap, null, 2)}\n\`\`\``
  if (MAP_FENCE.test(content)) return content.replace(MAP_FENCE, block)
  const source = content.trimEnd()
  return `${source === '' ? `# ${map.name}` : source}\n\n${block}\n`
}

export async function simulateAutonomousCycles(
  ctx: Context,
  id: ReturnType<typeof runId>,
  cycles: number,
  stepDuration: number,
  preferredAction?: string,
) {
  let view = await ctx.worldlineRuns.view({ runId: id })
  if (view.summary.status === 'paused') view = await ctx.worldlineRuns.resume({ runId: id })
  const simulated = await ctx.worldlineRuns.simulate({
    runId: id,
    cycles,
    stepDuration,
    ...(preferredAction === undefined ? {} : { preferredAction }),
  })
  return {
    view: simulated.view,
    actors: simulated.actorIds.map(actorId => ({ id: actorId })),
    actions: simulated.sampledActions,
    actionsPerformed: simulated.actionsPerformed,
    actionCounts: simulated.actionCounts,
    actorActionCounts: simulated.actorActionCounts,
  }
}

/** Perform require confirmation through the package's public contract.
 * @param confirmed - The confirmed supplied by the caller.
 * @param operation - The operation supplied by the caller.
 */
export function requireConfirmation(confirmed: unknown, operation: string): void {
  if (confirmed !== true) throw new Error(`${operation} requires explicit confirm=true`)
}

/** Perform apply unique replacement through the package's public contract.
 * @param content - The content supplied by the caller.
 * @param before - The before supplied by the caller.
 * @param after - The after supplied by the caller.
 * @returns The result produced by the operation.
 */
export function applyUniqueReplacement(content: string, before: string, after: string): string {
  if (before === '') throw new Error('before must not be empty')
  const first = content.indexOf(before)
  if (first < 0) throw new Error('before text was not found')
  if (content.indexOf(before, first + before.length) >= 0) {
    throw new Error('before text is not unique; use a larger exact fragment')
  }
  return `${content.slice(0, first)}${after}${content.slice(first + before.length)}`
}

function proposalRisk(value: unknown): CompilerProposal['risk'] {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'medium'
}

function proposalTarget(value: unknown): ProposalTarget {
  if (value === 'canon' || value === 'action' || value === 'system'
    || value === 'invariant' || value === 'map') return value
  throw new Error('target must be canon, action, system, invariant, or map')
}

function template(value: unknown): ProjectTemplate {
  if (value === 'blank' || value === 'world-encyclopedia' || value === 'character-story'
    || value === 'social-simulation' || value === 'civilization-sandbox'
    || value === 'playable-scenario') return value
  throw new Error('unknown project template')
}

export const name = 'tool-worldline'
export const inject = [
  'tools',
  'systemPrompt',
  'worldlineProjects',
  'worldlineCompiler',
  'worldlineRuns',
  'worldlineConversationContexts',
]

/** Register the latest-only project, compiler, and Run business-tool surface. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:worldline',
    order: 1900,
    text: 'Worldline tools are the only authority for Worldline project writes and Run changes. Every mutation must name one project or Run and carry the required revision, stable identity, dry-run, provenance, or explicit confirmation. Never edit project storage, immutable Blueprint files, or Run databases through generic filesystem/shell tools. Project Canon overrides inference; narration never mutates state. Only the current WWS and map formats exist—reject incompatible data instead of adding compatibility logic.',
  })

  ctx.tools.register(defineTool({
    name: 'worldline_project',
    description: 'List, create, copy, trash, or restore Worldline projects. Creating or explicitly using a project automatically makes it the current project for this OC author Session; no manual binding is required.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['list', 'create', 'copy', 'trash', 'trashed', 'restore'] },
      project_id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
      template: { type: 'string', enum: ['blank', 'world-encyclopedia', 'character-story', 'social-simulation', 'civilization-sandbox', 'playable-scenario'] },
      tags: { type: 'array', items: { type: 'string' } }, search: { type: 'string' },
      trash_id: { type: 'string' }, reason: { type: 'string' }, confirm: { type: 'boolean' },
    }, output: OUTPUT,
    isConcurrencySafe: args => args.operation === 'list' || args.operation === 'trashed',
    async execute(args, exec) {
      switch (args.operation) {
        case 'list': {
          const page = await ctx.worldlineProjects.library({
            ...optionalField('search', args.search), limit: 100,
          })
          const activeProjectId = exec.agent === undefined
            ? undefined
            : ctx.worldlineConversationContexts.binding(exec.agent.session)?.projectId
          return encode({ ...page, ...(activeProjectId === undefined ? {} : { activeProjectId }) })
        }
        case 'create': {
          const created = await ctx.worldlineProjects.create({
            name: string(args.name, 'name'),
            ...optionalField('description', args.description),
            template: template(args.template ?? 'blank'),
            tags: strings(args.tags),
          })
          if (exec.agent !== undefined) {
            await selectProjectScope(ctx, exec, created.manifest.id)
          }
          return encode(created)
        }
        case 'copy': {
          requireConfirmation(args.confirm, 'copy project')
          const sourceProjectId = projectId(args.project_id)
          await selectProjectScope(ctx, exec, sourceProjectId)
          const copied = await ctx.worldlineProjects.copyProject({
            projectId: sourceProjectId, name: string(args.name, 'name'),
          })
          await selectProjectScope(ctx, exec, copied.manifest.id)
          return encode(copied)
        }
        case 'trash':
          requireConfirmation(args.confirm, 'trash project')
          await selectProjectScope(ctx, exec, projectId(args.project_id))
          return encode(await ctx.worldlineProjects.trashProject({
            projectId: projectId(args.project_id),
            ...optionalField('reason', args.reason),
          }))
        case 'trashed': {
          return encode(await ctx.worldlineProjects.listTrashedProjects())
        }
        case 'restore': {
          requireConfirmation(args.confirm, 'restore project')
          const trashId = string(args.trash_id, 'trash_id')
          const item = (await ctx.worldlineProjects.listTrashedProjects())
            .find(candidate => candidate.trashId === trashId)
          if (item === undefined) throw new Error(`trashed project not found: ${trashId}`)
          const restored = await ctx.worldlineProjects.restoreProject({
            trashId,
            ...optionalField('name', args.name),
          })
          await selectProjectScope(ctx, exec, restored.manifest.id)
          return encode(restored)
        }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worldline_query',
    description: 'Read a bounded project tree, one document, document history, project search results, or project trash. This tool never writes.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['tree', 'read', 'history', 'search', 'trash'] },
      project_id: { type: 'string', required: true }, path: { type: 'string' }, query: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer' },
    }, output: OUTPUT,
    async execute(args, exec) {
      const id = projectId(args.project_id)
      await selectProjectScope(ctx, exec, id)
      const limit = Math.min(200, Math.max(1, integer(args.limit, 50)))
      switch (args.operation) {
        case 'tree': return encode(await ctx.worldlineProjects.tree({
          projectId: id,
          ...optionalField('path', args.path),
        }))
        case 'read': return encode(await ctx.worldlineProjects.read({ projectId: id, path: string(args.path, 'path') }))
        case 'history': return encode(await ctx.worldlineProjects.history({ projectId: id, path: string(args.path, 'path'), limit }))
        case 'search': return encode(await ctx.worldlineProjects.search({
          projectId: id, query: string(args.query, 'query'),
          ...optionalField('path', args.path),
          tags: strings(args.tags), limit,
        }))
        case 'trash': return encode(await ctx.worldlineProjects.listTrashedEntries(id))
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worldline_edit',
    description: 'Dry-run or apply one project-scoped document/directory mutation. Existing documents use an exact expected revision; text edits replace one unique fragment.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['create', 'replace', 'mkdir', 'move', 'copy', 'trash', 'restore'] },
      project_id: { type: 'string', required: true }, path: { type: 'string' }, destination: { type: 'string' },
      document_id: { type: 'string' }, expected_revision: { type: 'string' }, before: { type: 'string' },
      after: { type: 'string' }, content: { type: 'string' }, trash_id: { type: 'string' },
      dry_run: { type: 'boolean' }, confirm: { type: 'boolean' },
    }, output: OUTPUT,
    async execute(args, exec) {
      const id = projectId(args.project_id)
      await selectProjectScope(ctx, exec, id)
      const path = optionalString(args.path)
      const dryRun = args.dry_run !== false
      if (args.operation === 'create') {
        const documentId = worldlineId<'document'>(string(args.document_id, 'document_id'))
        const request = {
          projectId: id,
          path: string(path, 'path'),
          content: args.content ?? '',
          documentId,
          createParents: true,
        }
        return dryRun ? encode({ dryRun: true, operation: args.operation, request })
          : encode(await ctx.worldlineProjects.write(request))
      }
      if (args.operation === 'replace') {
        const expectedRevision = revision(args.expected_revision)
        const current = await ctx.worldlineProjects.read({ projectId: id, path: string(path, 'path') })
        if (current.revision !== expectedRevision) throw new Error('expected_revision does not match the current document')
        const content = applyUniqueReplacement(current.content, args.before ?? '', args.after ?? '')
        const request = { projectId: id, path: current.path, content, expectedRevision, documentId: current.id }
        return dryRun ? encode({ dryRun: true, operation: args.operation, path: current.path, revision: current.revision })
          : encode(await ctx.worldlineProjects.write(request))
      }
      if (args.operation === 'mkdir') {
        const request = { projectId: id, path: string(path, 'path') }
        return dryRun ? encode({ dryRun: true, operation: args.operation, request })
          : encode(await ctx.worldlineProjects.createDirectory(request))
      }
      if (args.operation === 'move') {
        const request = { projectId: id, source: string(path, 'path'), destination: string(args.destination, 'destination'), expectedRevision: revision(args.expected_revision) }
        return dryRun ? encode({ dryRun: true, operation: args.operation, request })
          : encode(await ctx.worldlineProjects.move(request))
      }
      if (args.operation === 'copy') {
        const source = string(path, 'path')
        const current = await ctx.worldlineProjects.read({ projectId: id, path: source })
        if (current.revision !== revision(args.expected_revision)) throw new Error('expected_revision does not match the source document')
        const request = { projectId: id, source, destination: string(args.destination, 'destination') }
        return dryRun ? encode({ dryRun: true, operation: args.operation, request, revision: current.revision })
          : encode(await ctx.worldlineProjects.copyEntry(request))
      }
      if (args.operation === 'trash') {
        requireConfirmation(args.confirm, 'trash entry')
        const request = { projectId: id, path: string(path, 'path'), expectedRevision: revision(args.expected_revision) }
        return dryRun ? encode({ dryRun: true, operation: args.operation, request })
          : encode(await ctx.worldlineProjects.trashEntry(request))
      }
      requireConfirmation(args.confirm, 'restore entry')
      const request = {
        projectId: id,
        trashId: string(args.trash_id, 'trash_id'),
        ...optionalField('destination', args.destination),
      }
      return dryRun ? encode({ dryRun: true, operation: args.operation, request })
        : encode(await ctx.worldlineProjects.restoreEntry(request))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worldline_link',
    description: 'Inspect incoming links for one project document or search stable IDs/paths before editing references.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['backlinks', 'search'] },
      project_id: { type: 'string', required: true }, path: { type: 'string' }, query: { type: 'string' },
    }, output: OUTPUT,
    async execute(args, exec) {
      const id = projectId(args.project_id)
      await selectProjectScope(ctx, exec, id)
      return args.operation === 'backlinks'
        ? encode(await ctx.worldlineProjects.backlinks({ projectId: id, path: string(args.path, 'path') }))
        : encode(await ctx.worldlineProjects.search({ projectId: id, query: string(args.query, 'query'), limit: 100 }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worldline_map',
    description: 'Read, validate, or write the one current worldline-map JSON block in a project document. Writing uses project revision checks and computes provenance during compilation; never provide source anchors.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['read', 'validate', 'write'] },
      project_id: { type: 'string', required: true },
      path: { type: 'string', description: 'Map Markdown document path; defaults to maps/world.md.' },
      map_json: { type: 'string', description: 'One complete current WorldMap JSON object. Required for validate and write.' },
      expected_revision: { type: 'string' }, dry_run: { type: 'boolean' },
    }, output: OUTPUT,
    async execute(args, exec) {
      const id = projectId(args.project_id)
      await selectProjectScope(ctx, exec, id)
      const path = optionalString(args.path) ?? 'maps/world.md'
      if (args.operation === 'read') {
        const document = await ctx.worldlineProjects.read({ projectId: id, path })
        const match = MAP_FENCE.exec(document.content)
        if (match?.[1] === undefined) throw new Error(`地图文档 ${path} 中没有 worldline-map JSON 代码块`)
        return encode({ document: { id: document.id, path, revision: document.revision }, map: worldMapJson(match[1]) })
      }
      const map = worldMapJson(args.map_json)
      if (args.operation === 'validate') return encode({ valid: true, map, diagnostics: [] })
      let current: Awaited<ReturnType<typeof ctx.worldlineProjects.read>> | undefined
      try {
        current = await ctx.worldlineProjects.read({ projectId: id, path })
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'entry-not-found') throw error
      }
      const suppliedRevision = optionalString(args.expected_revision) as Revision | undefined
      if (suppliedRevision !== undefined && current?.revision !== suppliedRevision) {
        throw new Error('expected_revision 与当前地图文档不一致，请重新读取后再写入')
      }
      const request = {
        projectId: id,
        path,
        content: replaceMapFence(current?.content ?? '', map),
        ...(current === undefined ? { createParents: true, objectKind: 'place' as const } : {
          expectedRevision: current.revision,
          documentId: current.id,
          objectKind: current.objectKind ?? 'place' as const,
          tags: current.tags,
        }),
      }
      return args.dry_run !== false
        ? encode({ dryRun: true, valid: true, request: { ...request, content: undefined }, map })
        : encode({ map, document: await ctx.worldlineProjects.write(request) })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worldline_build',
    description: 'Inspect or compile source, review author Proposals, freeze, or prove a complete playable OC loop. prove compiles, freezes, creates a Run, executes autonomous legal actions, advances time, verifies the map/event ledger, and checkpoints; it is the only completion gate.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['state', 'compile', 'answer', 'propose', 'review', 'freeze', 'prove'] },
      project_id: { type: 'string', required: true }, question_id: { type: 'string' }, answer: { type: 'string' },
      target: { type: 'string', enum: ['canon', 'action', 'system', 'invariant', 'map'] },
      title: { type: 'string' }, rationale: { type: 'string' }, risk: { type: 'string', enum: ['low', 'medium', 'high'] },
      payload_json: { type: 'string' }, anchors_json: { type: 'string' }, proposal_id: { type: 'string' },
      decision: { type: 'string', enum: ['approved', 'rejected'] }, reviewed_by: { type: 'string' },
      expected_state_revision: { type: 'string' }, expected_source_digest: { type: 'string' }, confirm: { type: 'boolean' },
      seed: { type: 'string' }, action_type: { type: 'string' }, advance_duration: { type: 'number' },
    }, output: OUTPUT,
    async execute(args, exec) {
      const id = projectId(args.project_id)
      await selectProjectScope(ctx, exec, id)
      const stateRevision = optionalString(args.expected_state_revision) as Revision | undefined
      switch (args.operation) {
        case 'state': return encode(await ctx.worldlineCompiler.state(id))
        case 'compile': return encode(await ctx.worldlineCompiler.compile({ projectId: id }))
        case 'answer': return encode(await ctx.worldlineCompiler.answerQuestion({
          projectId: id, questionId: string(args.question_id, 'question_id'), answer: string(args.answer, 'answer'),
          ...(stateRevision === undefined ? {} : { expectedStateRevision: stateRevision }),
        }))
        case 'propose': return encode(await ctx.worldlineCompiler.submitProposal({
          projectId: id, target: proposalTarget(args.target), title: string(args.title, 'title'),
          rationale: string(args.rationale, 'rationale'), risk: proposalRisk(args.risk),
          payload: objectJson(args.payload_json, 'payload_json'), anchors: anchorsJson(args.anchors_json),
          ...(stateRevision === undefined ? {} : { expectedStateRevision: stateRevision }),
        }))
        case 'review':
          requireConfirmation(args.confirm, 'review proposal')
          return encode(await ctx.worldlineCompiler.reviewProposal({
            projectId: id, proposalId: string(args.proposal_id, 'proposal_id'),
            decision: args.decision === 'approved' ? 'approved' : 'rejected',
            reviewedBy: string(args.reviewed_by, 'reviewed_by'),
            ...(stateRevision === undefined ? {} : { expectedStateRevision: stateRevision }),
          }))
        case 'freeze':
          requireConfirmation(args.confirm, 'freeze build')
          return encode(await ctx.worldlineCompiler.freeze({
            projectId: id, expectedSourceDigest: string(args.expected_source_digest, 'expected_source_digest'),
          }))
        case 'prove': {
          requireConfirmation(args.confirm, 'prove complete Worldline loop')
          const duration = positiveDuration(args.advance_duration, 60, 'advance_duration')
          const preview = await ctx.worldlineCompiler.compile({ projectId: id })
          if (!preview.canFreeze) {
            return encode({
              complete: false,
              stage: 'compile',
              message: '世界线尚未形成可运行闭环，请修复所有阻断项后再次证明。',
              executableCounts: preview.executableCounts,
              diagnostics: preview.diagnostics,
              questions: preview.questions.filter(item => item.status === 'open'),
              certificate: preview.certificate.results.filter(item => item.status === 'blocking'),
            })
          }
          const frozen = await ctx.worldlineCompiler.freeze({
            projectId: id,
            expectedSourceDigest: preview.sourceDigest,
          })
          const run = await ctx.worldlineRuns.create({
            projectId: id,
            seed: optionalString(args.seed) ?? 'worldline-oc-proof',
            startPaused: false,
          })
          await selectProjectScope(ctx, exec, id, run.summary.runId)
          const simulated = await simulateAutonomousCycles(
            ctx,
            run.summary.runId,
            1,
            duration,
            optionalString(args.action_type),
          )
          const spatial = await ctx.worldlineRuns.spatial({ runId: run.summary.runId, maxNodes: 10_000 })
          const records = await ctx.worldlineRuns.records({ runId: run.summary.runId, limit: 500 })
          const checkpoint = await ctx.worldlineRuns.checkpoint({
            runId: run.summary.runId,
            label: 'OC 闭环验收',
          })
          const mapNodeCount = spatial.map?.totalNodes ?? 0
          const worldEvents = records.records.filter(record => record.stream === 'world-event')
          const complete = mapNodeCount > 0
            && simulated.actions.length > 0
            && simulated.view.snapshot.logicalTime >= duration
            && worldEvents.length > 0
          return encode({
            complete,
            stage: complete ? 'verified' : 'runtime',
            message: complete
              ? '世界线已通过结构化地图、合法动作、逻辑时间、因果事件与检查点闭环验收。'
              : '蓝图已冻结，但运行证据不完整；不得宣称项目完成。',
            projectId: id,
            sourceDigest: preview.sourceDigest,
            blueprintDigest: frozen.blueprint.digest,
            executableCounts: preview.executableCounts,
            runId: run.summary.runId,
            actorCount: simulated.actors.length,
            actions: simulated.actions,
            logicalTime: simulated.view.snapshot.logicalTime,
            sequence: simulated.view.snapshot.sequence,
            map: spatial.map === undefined ? undefined : {
              id: spatial.map.id,
              name: spatial.map.name,
              nodes: spatial.map.totalNodes,
              edges: spatial.map.totalEdges,
            },
            worldEventCount: worldEvents.length,
            checkpointId: checkpoint.checkpoint.id,
          })
        }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worldline_run',
    description: 'Inspect or control deterministic Runs. Explicit project and Run IDs automatically select their owning project. Mutating operations use confirmation for actions, large advances, branches, control changes, AI changes, and stop.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['list', 'create', 'view', 'choices', 'advance', 'simulate', 'action', 'pause', 'resume', 'stop', 'checkpoint', 'checkpoints', 'branch', 'set-control', 'set-ai', 'set-budget'] },
      project_id: { type: 'string' }, run_id: { type: 'string' }, actor_id: { type: 'string' }, seed: { type: 'string' },
      duration: { type: 'number' }, max_events: { type: 'integer' }, action_type: { type: 'string' },
      parameters_json: { type: 'string' }, expected_sequence: { type: 'integer' }, label: { type: 'string' },
      checkpoint_id: { type: 'string' }, mode: { type: 'string', enum: ['autonomous', 'suggestions', 'player'] },
      enabled: { type: 'boolean' }, budget_json: { type: 'string' }, confirm: { type: 'boolean' },
      cycles: { type: 'integer' }, step_duration: { type: 'number' },
    }, output: OUTPUT,
    async execute(args, exec) {
      if (args.operation === 'list') {
        const requestedProjectId = optionalString(args.project_id)
        if (requestedProjectId !== undefined) {
          const id = projectId(requestedProjectId)
          await selectProjectScope(ctx, exec, id)
          return encode((await ctx.worldlineRuns.list()).filter(item => item.projectId === id))
        }
        const active = exec.agent === undefined
          ? undefined
          : ctx.worldlineConversationContexts.binding(exec.agent.session)
        const runs = await ctx.worldlineRuns.list()
        return encode(active === undefined ? runs : runs.filter(item => item.projectId === active.projectId))
      }
      if (args.operation === 'create') {
        const id = projectId(args.project_id)
        await selectProjectScope(ctx, exec, id)
        const created = await ctx.worldlineRuns.create({
          projectId: id, seed: string(args.seed, 'seed'), startPaused: true,
        })
        await selectProjectScope(ctx, exec, id, created.summary.runId)
        return encode(created)
      }
      const id = runId(args.run_id)
      await assertRunScope(ctx, exec, id)
      switch (args.operation) {
        case 'view': return encode(await ctx.worldlineRuns.view({ runId: id }))
        case 'choices': return encode(await ctx.worldlineRuns.choices({ runId: id, actorId: entityId(args.actor_id) }))
        case 'advance': {
          const duration = args.duration ?? 0
          if (!Number.isFinite(duration) || duration <= 0) throw new Error('duration must be positive')
          if (duration > 3_600) requireConfirmation(args.confirm, 'advance Run by more than 3600 logical seconds')
          return encode(await ctx.worldlineRuns.advance({
            runId: id, duration, maxEvents: Math.min(100_000, Math.max(1, integer(args.max_events, 10_000))),
          }))
        }
        case 'simulate': {
          requireConfirmation(args.confirm, 'run autonomous simulation')
          const cycles = Math.min(1_000, Math.max(1, integer(args.cycles, 1)))
          const stepDuration = positiveDuration(args.step_duration, 60, 'step_duration')
          const simulated = await simulateAutonomousCycles(
            ctx,
            id,
            cycles,
            stepDuration,
            optionalString(args.action_type),
          )
          const spatial = await ctx.worldlineRuns.spatial({ runId: id, maxNodes: 10_000 })
          const records = await ctx.worldlineRuns.records({ runId: id, limit: 500 })
          return encode({
            autonomous: true,
            cycles,
            actors: simulated.actors.map(item => item.id),
            actions: simulated.actions,
            actionsPerformed: simulated.actionsPerformed,
            actionCounts: simulated.actionCounts,
            actorActionCounts: simulated.actorActionCounts,
            view: simulated.view,
            map: spatial.map,
            worldEvents: records.records.filter(record => record.stream === 'world-event'),
          })
        }
        case 'action':
          requireConfirmation(args.confirm, 'submit Run action')
          return encode(await ctx.worldlineRuns.submitAction({
            runId: id, actorId: entityId(args.actor_id), type: string(args.action_type, 'action_type'),
            parameters: optionalString(args.parameters_json) === undefined ? {} : objectJson(args.parameters_json, 'parameters_json'),
            expectedSequence: integer(args.expected_sequence, -1), controller: 'agent',
          }))
        case 'pause': return encode(await ctx.worldlineRuns.pause({ runId: id }))
        case 'resume': return encode(await ctx.worldlineRuns.resume({ runId: id }))
        case 'stop':
          requireConfirmation(args.confirm, 'stop Run')
          return encode(await ctx.worldlineRuns.stop({ runId: id }))
        case 'checkpoint': return encode(await ctx.worldlineRuns.checkpoint({ runId: id, label: string(args.label, 'label') }))
        case 'checkpoints': return encode(await ctx.worldlineRuns.checkpoints({ runId: id }))
        case 'branch':
          requireConfirmation(args.confirm, 'branch Run')
          return encode(await ctx.worldlineRuns.branch({
            runId: id, checkpointId: worldlineId<'checkpoint'>(string(args.checkpoint_id, 'checkpoint_id')),
            ...optionalField('seed', args.seed),
          }))
        case 'set-control':
          requireConfirmation(args.confirm, 'change actor control')
          if (args.mode !== 'autonomous' && args.mode !== 'suggestions' && args.mode !== 'player') throw new Error('mode is required')
          return encode(await ctx.worldlineRuns.setControl({ runId: id, actorId: entityId(args.actor_id), mode: args.mode }))
        case 'set-ai':
          requireConfirmation(args.confirm, 'change Run AI state')
          if (typeof args.enabled !== 'boolean') throw new Error('enabled is required')
          return encode(await ctx.worldlineRuns.setAiEnabled({ runId: id, enabled: args.enabled }))
        case 'set-budget':
          requireConfirmation(args.confirm, 'change Run AI budget')
          return encode(await ctx.worldlineRuns.setAiBudget({
            runId: id,
            budget: objectJson(args.budget_json, 'budget_json') as unknown as AiBudget,
            expectedSequence: integer(args.expected_sequence, -1),
          }))
      }
      throw new Error('create requires project_id and seed')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worldline_explain',
    description: 'Explain one compiled semantic object or one retained Run event with authoritative provenance and causality records.',
    parameters: {
      target: { type: 'string', required: true, enum: ['semantic', 'event'] },
      project_id: { type: 'string' }, object_id: { type: 'string' }, run_id: { type: 'string' }, event_id: { type: 'string' },
    }, output: OUTPUT,
    async execute(args, exec) {
      if (args.target === 'semantic') {
        const id = projectId(args.project_id)
        await selectProjectScope(ctx, exec, id)
        return encode(await ctx.worldlineCompiler.explain({ projectId: id, objectId: string(args.object_id, 'object_id') }))
      }
      const id = runId(args.run_id)
      await assertRunScope(ctx, exec, id)
      return encode(await ctx.worldlineRuns.explain({ runId: id, eventId: string(args.event_id, 'event_id') }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worldline_transfer',
    description: 'Dry-run or start current-format project, frozen Blueprint, or logical Run archive transfer. Paths remain inside the Host project service; transfer never touches a remote repository.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['import', 'export', 'status', 'cancel'] },
      artifact: { type: 'string', enum: ['project', 'blueprint', 'run'] },
      project_id: { type: 'string' }, source: { type: 'string' }, destination: { type: 'string' },
      run_id: { type: 'string' }, name: { type: 'string' }, include_runs: { type: 'boolean' }, transfer_id: { type: 'string' },
      conflict: { type: 'string', enum: ['copy', 'replace', 'cancel'] },
      dry_run: { type: 'boolean' }, confirm: { type: 'boolean' },
    }, output: OUTPUT,
    async execute(args, exec) {
      if (args.operation === 'status') return encode(await ctx.worldlineProjects.transfer(string(args.transfer_id, 'transfer_id')))
      if (args.operation === 'cancel') {
        requireConfirmation(args.confirm, 'cancel transfer')
        return encode(await ctx.worldlineProjects.cancelTransfer(string(args.transfer_id, 'transfer_id')))
      }
      const artifact = string(args.artifact, 'artifact')
      if (artifact !== 'project' && artifact !== 'blueprint' && artifact !== 'run') {
        throw new Error('artifact must be project, blueprint, or run')
      }
      if (args.operation === 'import') {
        const source = string(args.source, 'source')
        if (artifact === 'project') {
          const conflict = string(args.conflict, 'conflict')
          if (conflict !== 'copy' && conflict !== 'replace' && conflict !== 'cancel') {
            throw new Error('conflict must be copy, replace, or cancel')
          }
          const request: ImportProjectRequest = {
            source,
            conflict,
            ...optionalField('name', args.name),
          }
          if (args.dry_run !== false) return encode({ dryRun: true, operation: args.operation, artifact, request })
          requireConfirmation(args.confirm, 'import project')
          return encode(await ctx.worldlineProjects.importProject(request))
        }
        const id = projectId(args.project_id)
        await selectProjectScope(ctx, exec, id)
        const request = { projectId: id, source }
        if (args.dry_run !== false) return encode({ dryRun: true, operation: args.operation, artifact, request })
        requireConfirmation(args.confirm, `import ${artifact}`)
        return encode(artifact === 'blueprint'
          ? await ctx.worldlineProjects.importBlueprint(request)
          : await ctx.worldlineProjects.importRun(request))
      }
      const id = projectId(args.project_id)
      await selectProjectScope(ctx, exec, id)
      const destination = string(args.destination, 'destination')
      if (artifact === 'blueprint') {
        const request = { projectId: id, destination }
        if (args.dry_run !== false) return encode({ dryRun: true, operation: args.operation, artifact, request })
        requireConfirmation(args.confirm, 'export Blueprint')
        return encode(await ctx.worldlineProjects.exportBlueprint(request))
      }
      if (artifact === 'run') {
        const request = { projectId: id, runId: runId(args.run_id), destination }
        if (args.dry_run !== false) return encode({ dryRun: true, operation: args.operation, artifact, request })
        requireConfirmation(args.confirm, 'export Run')
        return encode(await ctx.worldlineProjects.exportRun(request))
      }
      const request = {
        projectId: id,
        destination,
        includeRuns: args.include_runs === true,
      }
      if (args.dry_run !== false) return encode({ dryRun: true, operation: args.operation, artifact, request })
      requireConfirmation(args.confirm, 'export project')
      return encode(await ctx.worldlineProjects.exportProject(request))
    },
  }))
}
