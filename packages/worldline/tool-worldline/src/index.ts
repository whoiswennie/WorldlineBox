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
} from '@deepseek-ai/dsh-worldline-standard'
import { worldlineId } from '@deepseek-ai/dsh-worldline-standard'
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
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').slice(0, 128)
  : []
const projectId = (value: unknown) => worldlineId<'project'>(string(value, 'project_id'))
const runId = (value: unknown) => worldlineId<'run'>(string(value, 'run_id'))
const entityId = (value: unknown) => worldlineId<'entity'>(string(value, 'actor_id'))
const revision = (value: unknown, name = 'expected_revision') => string(value, name) as Revision

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
    description: 'Dry-run or submit a reviewable structured map Proposal with exact source anchors. It never bypasses review by rewriting a map document directly.',
    parameters: {
      project_id: { type: 'string', required: true }, title: { type: 'string', required: true },
      rationale: { type: 'string', required: true }, patch_json: { type: 'string', required: true },
      anchors_json: { type: 'string', required: true }, risk: { type: 'string', enum: ['low', 'medium', 'high'] },
      expected_state_revision: { type: 'string' }, dry_run: { type: 'boolean' },
    }, output: OUTPUT,
    async execute(args, exec) {
      const id = projectId(args.project_id)
      await selectProjectScope(ctx, exec, id)
      const request = {
        projectId: id, target: 'map' as const,
        title: string(args.title, 'title'), rationale: string(args.rationale, 'rationale'),
        risk: proposalRisk(args.risk), payload: objectJson(args.patch_json, 'patch_json'),
        anchors: anchorsJson(args.anchors_json),
        ...(optionalString(args.expected_state_revision) === undefined ? {} : {
          expectedStateRevision: revision(args.expected_state_revision, 'expected_state_revision'),
        }),
      }
      return args.dry_run !== false ? encode({ dryRun: true, request })
        : encode(await ctx.worldlineCompiler.submitProposal(request))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worldline_build',
    description: 'Inspect compiler state, compile, answer a question, submit/review a Proposal, or freeze the exact current source digest. Freeze and review require confirmation.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['state', 'compile', 'answer', 'propose', 'review', 'freeze'] },
      project_id: { type: 'string', required: true }, question_id: { type: 'string' }, answer: { type: 'string' },
      target: { type: 'string', enum: ['canon', 'action', 'system', 'invariant', 'map'] },
      title: { type: 'string' }, rationale: { type: 'string' }, risk: { type: 'string', enum: ['low', 'medium', 'high'] },
      payload_json: { type: 'string' }, anchors_json: { type: 'string' }, proposal_id: { type: 'string' },
      decision: { type: 'string', enum: ['approved', 'rejected'] }, reviewed_by: { type: 'string' },
      expected_state_revision: { type: 'string' }, expected_source_digest: { type: 'string' }, confirm: { type: 'boolean' },
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
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worldline_run',
    description: 'Inspect or control deterministic Runs. Explicit project and Run IDs automatically select their owning project. Mutating operations use confirmation for actions, large advances, branches, control changes, AI changes, and stop.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['list', 'create', 'view', 'choices', 'advance', 'action', 'pause', 'resume', 'stop', 'checkpoint', 'checkpoints', 'branch', 'set-control', 'set-ai', 'set-budget'] },
      project_id: { type: 'string' }, run_id: { type: 'string' }, actor_id: { type: 'string' }, seed: { type: 'string' },
      duration: { type: 'number' }, max_events: { type: 'integer' }, action_type: { type: 'string' },
      parameters_json: { type: 'string' }, expected_sequence: { type: 'integer' }, label: { type: 'string' },
      checkpoint_id: { type: 'string' }, mode: { type: 'string', enum: ['autonomous', 'suggestions', 'player'] },
      enabled: { type: 'boolean' }, budget_json: { type: 'string' }, confirm: { type: 'boolean' },
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
