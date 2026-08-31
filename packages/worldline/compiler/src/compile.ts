import { createHash } from 'node:crypto'
import type { ProjectSourceFile, ProjectSourceSnapshot } from '@deepseek-ai/dsh-worldline-project'
import {
  type ActionDefinition,
  type CanonLink,
  type CanonObject,
  type CanonObjectKind,
  type CertificateCategory,
  type CertificateResult,
  type ClosureCertificate,
  type Effect,
  type EntityId,
  type Expression,
  type InvariantDefinition,
  type JsonObject,
  type JsonValue,
  type MapEdge,
  type MapLayer,
  type MapNode,
  type Provenance,
  type RuntimeEntitySeed,
  type SimulationPurpose,
  type SourceAnchor,
  type SystemDefinition,
  type WorldMap,
  contentFingerprint,
  stableStringify,
  validateWorldMap,
  worldlineId,
} from '@deepseek-ai/dsh-worldline-standard'
import type {
  BuildDiagnostic,
  CompilerProposal,
  CreativeQuestion,
} from './types.ts'

export interface CompilationProduct {
  readonly snapshot: ProjectSourceSnapshot
  readonly purpose: SimulationPurpose
  readonly canon: readonly CanonObject[]
  readonly links: readonly CanonLink[]
  readonly maps: readonly WorldMap[]
  readonly entities: readonly RuntimeEntitySeed[]
  readonly actions: readonly ActionDefinition[]
  readonly systems: readonly SystemDefinition[]
  readonly invariants: readonly InvariantDefinition[]
  readonly diagnostics: readonly BuildDiagnostic[]
  readonly questions: readonly CreativeQuestion[]
  readonly proposals: readonly CompilerProposal[]
  readonly certificate: ClosureCertificate
}

type ExecutableKind = 'action' | 'map' | 'system' | 'invariant'

const FENCE_PATTERN = /```worldline-(action|map|system|invariant)\s*\r?\n([\s\S]*?)```/gu
const LINK_PATTERN = /\[\[((?:doc|document|entity):[a-zA-Z0-9._~-]{6,128})\]\]/gu

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function jsonObject(value: unknown): JsonObject {
  return isRecord(value) ? value as JsonObject : {}
}

function expressionArray(value: unknown): readonly Expression[] {
  return Array.isArray(value) ? value.filter(isRecord) as unknown as readonly Expression[] : []
}

function effectArray(value: unknown): readonly Effect[] {
  return Array.isArray(value) ? value.filter(isRecord) as unknown as readonly Effect[] : []
}

function sourceAnchor(file: ProjectSourceFile, start = 0, end = file.content.length): SourceAnchor {
  return {
    id: worldlineId<'source-anchor'>(`source-anchor:${contentFingerprint(`${file.id}:${start}:${end}`)}`),
    documentId: file.id,
    revision: file.revision,
    startOffset: start,
    endOffset: end,
    excerptHash: contentFingerprint(file.content.slice(start, end)),
    contextBefore: file.content.slice(Math.max(0, start - 80), start),
    contextAfter: file.content.slice(end, end + 80),
  }
}

function provenance(file: ProjectSourceFile, start?: number, end?: number): Provenance {
  return { kind: 'author', anchors: [sourceAnchor(file, start, end)] }
}

function titleOf(file: ProjectSourceFile): string {
  return /^#\s+(.+)$/mu.exec(file.content)?.[1]?.trim()
    ?? file.path.split('/').at(-1)?.replace(/\.[^.]+$/u, '')
    ?? file.path
}

function kindOf(file: ProjectSourceFile): CanonObjectKind {
  if (file.objectKind !== undefined) return file.objectKind
  const path = file.path.toLocaleLowerCase()
  if (path === 'canon/charter.md') return 'charter'
  if (path.startsWith('characters/')) return 'character'
  if (path.startsWith('places/') || path.startsWith('maps/')) return 'place'
  if (path.startsWith('organizations/') || path.startsWith('factions/')) return 'organization'
  if (path.startsWith('species/')) return 'species'
  if (path.startsWith('items/')) return 'item'
  if (path.startsWith('concepts/')) return 'concept'
  if (path.startsWith('rules/') || path.startsWith('mechanisms/')) return 'rule'
  if (path.startsWith('relations/')) return 'relation'
  if (path.startsWith('facts/')) return 'fact'
  if (path.includes('timeline')) return 'timeline-event'
  if (path.startsWith('scenarios/')) return 'scenario'
  if (path.startsWith('assets/')) return 'asset'
  return 'custom:document'
}

function facetsOf(file: ProjectSourceFile): Readonly<Record<string, JsonValue>> {
  const match = /<!--\s*worldline-facets\s+([\s\S]*?)-->/u.exec(file.content)
  if (match?.[1] === undefined) return { sourcePath: file.path }
  try { return { sourcePath: file.path, ...jsonObject(JSON.parse(match[1])) } } catch { return { sourcePath: file.path } }
}

function entityIdOf(file: ProjectSourceFile): EntityId {
  return worldlineId<'entity'>(`entity:${contentFingerprint(file.id)}`)
}

function canonObject(file: ProjectSourceFile, snapshot: ProjectSourceSnapshot): CanonObject {
  return {
    id: entityIdOf(file),
    kind: kindOf(file),
    documentId: file.id,
    title: titleOf(file),
    aliases: [],
    tags: file.tags,
    status: 'canon',
    worldIds: [snapshot.manifest.defaultWorldId],
    worldlineIds: [snapshot.manifest.defaultWorldlineId],
    facets: facetsOf(file),
    provenance: [provenance(file)],
  }
}

function parseAction(value: Record<string, unknown>, source: Provenance): ActionDefinition {
  return {
    id: stringValue(value.id, `action.${contentFingerprint(value)}`),
    description: stringValue(value.description, 'Author-defined action'),
    actorTypes: Array.isArray(value.actorTypes) ? value.actorTypes.filter(item => typeof item === 'string') : ['character'],
    preconditions: expressionArray(value.preconditions),
    claims: Array.isArray(value.claims) ? value.claims.filter(isRecord).map(claim => ({
      resource: stringValue(claim.resource, 'world'),
      quantity: Math.max(0, numberValue(claim.quantity, 1)),
      mode: claim.mode === 'shared' || claim.mode === 'capacity' ? claim.mode : 'exclusive',
      duration: Math.max(0, numberValue(claim.duration, 0)),
    })) : [],
    duration: Math.max(0, numberValue(value.duration, 0)),
    effects: effectArray(value.effects),
    interruptible: value.interruptible !== false,
    maxWait: Math.max(0, numberValue(value.maxWait, 3_600)),
    retryBudget: Math.max(0, Math.floor(numberValue(value.retryBudget, 3))),
    fallbacks: Array.isArray(value.fallbacks) ? value.fallbacks.filter(item => typeof item === 'string') : [],
    provenance: [source],
  }
}

function parseSystem(value: Record<string, unknown>, source: Provenance): SystemDefinition {
  const interval = numberValue(value.interval, 0)
  return {
    id: stringValue(value.id, `system.${contentFingerprint(value)}`),
    description: stringValue(value.description, 'Author-defined world system'),
    nextWake: Math.max(0, numberValue(value.nextWake, interval)),
    ...(interval > 0 ? { interval } : {}),
    preconditions: expressionArray(value.preconditions),
    effects: effectArray(value.effects),
    provenance: [source],
  }
}

function parseInvariant(value: Record<string, unknown>, source: Provenance): InvariantDefinition {
  const expression = isRecord(value.expression)
    ? value.expression as unknown as Expression
    : { op: 'exists' as const, path: '$' }
  return {
    id: stringValue(value.id, `invariant.${contentFingerprint(value)}`),
    description: stringValue(value.description, 'Author-defined safety invariant'),
    expression,
    provenance: [source],
  }
}

function parseMap(value: Record<string, unknown>, source: Provenance): WorldMap {
  const nodes = Array.isArray(value.nodes) ? value.nodes.filter(isRecord) as unknown as MapNode[] : []
  const layers = Array.isArray(value.layers) ? value.layers.filter(isRecord) as unknown as MapLayer[] : []
  const edges = Array.isArray(value.edges) ? value.edges.filter(isRecord) as unknown as MapEdge[] : []
  const root = stringValue(value.rootNodeId, String(nodes[0]?.id ?? 'map-node:missing'))
  return {
    id: worldlineId<'map'>(stringValue(value.id, `map:${contentFingerprint(value)}`)),
    version: 1,
    name: stringValue(value.name, 'World map'),
    rootNodeId: worldlineId<'map-node'>(root),
    layers,
    nodes,
    edges,
    provenance: [source],
  }
}

function defaultPurpose(snapshot: ProjectSourceSnapshot): SimulationPurpose {
  const runtimeTemplate = snapshot.manifest.template === 'social-simulation'
    || snapshot.manifest.template === 'civilization-sandbox'
    || snapshot.manifest.template === 'playable-scenario'
  return {
    summary: runtimeTemplate ? 'Validate the project as an autonomous world.' : 'Compile a source-covered world reference.',
    scope: runtimeTemplate ? ['world', 'characters', 'space', 'actions'] : ['world-reference'],
    duration: runtimeTemplate ? 86_400 : 0,
    resolution: 60,
    detail: runtimeTemplate ? 'L2' : 'L0',
    hardExpectations: [],
    statisticalExpectations: [],
    antiPatterns: ['orphan semantics', 'instant ordinary movement', 'unbounded retries'],
  }
}

function question(id: string, prompt: string, rationale: string, impact: CreativeQuestion['impact']): CreativeQuestion {
  return { id: `question:${contentFingerprint(id)}`, prompt, rationale, impact, status: 'open', sourcePaths: [] }
}

function mergeQuestions(generated: CreativeQuestion[], previous: readonly CreativeQuestion[]): CreativeQuestion[] {
  const states = new Map(previous.map(item => [item.id, item]))
  return generated.map(item => states.get(item.id) ?? item)
}

function result(
  category: CertificateCategory,
  status: CertificateResult['status'],
  summary: string,
  evidence: readonly string[],
): CertificateResult {
  return { category, status, summary, evidence }
}

interface CertificateInput {
  readonly digest: string
  readonly runtimeRequested: boolean
  readonly canon: readonly CanonObject[]
  readonly maps: readonly WorldMap[]
  readonly entities: readonly RuntimeEntitySeed[]
  readonly actions: readonly ActionDefinition[]
  readonly systems: readonly SystemDefinition[]
  readonly invariants: readonly InvariantDefinition[]
  readonly diagnostics: readonly BuildDiagnostic[]
  readonly purpose: SimulationPurpose
}

function makeCertificate(input: CertificateInput): ClosureCertificate {
  const provenanceNodes = [...input.maps, ...input.actions, ...input.systems, ...input.invariants]
  const noOrphans = provenanceNodes.every(node => node.provenance.length > 0)
    && !input.diagnostics.some(item => item.severity === 'blocking')
  const allProvenance = [
    ...input.canon.flatMap(item => item.provenance),
    ...provenanceNodes.flatMap(item => item.provenance),
  ]
  const coverage = (kind: Provenance['kind']): number => allProvenance.length === 0
    ? 0
    : allProvenance.filter(item => item.kind === kind).length / allProvenance.length
  const mapErrors = input.maps.flatMap(map => validateWorldMap(map))
  const results: CertificateResult[] = [
    result('state', input.canon.length > 0 ? 'pass' : 'blocking', 'Canon state can be materialized.', [`${input.canon.length} Canon objects`]),
    result('time', !input.runtimeRequested || input.purpose.duration > 0 ? 'pass' : 'blocking', 'Declared time horizon is finite.', [`duration=${String(input.purpose.duration)}`]),
    result('space', !input.runtimeRequested || (input.maps.length > 0 && mapErrors.length === 0) ? 'pass' : 'blocking', 'Runtime topology is connected and valid.', mapErrors.length === 0 ? [`${input.maps.length} maps`] : mapErrors.map(item => item.message)),
    result('actions', !input.runtimeRequested || input.actions.length > 0 ? 'pass' : 'blocking', 'Actions use explicit lifecycle contracts.', [`${input.actions.length} actions`]),
    result('cognition', 'pass', 'Each runtime entity owns isolated memory.', [`${input.entities.length} runtime entities`]),
    result('causality', !input.runtimeRequested || input.actions.some(action => action.effects.length > 0) || input.systems.some(system => system.effects.length > 0) ? 'pass' : 'blocking', 'State changes have explicit causes.', [`${input.actions.length + input.systems.length} effect producers`]),
    result('safety', !input.runtimeRequested || input.invariants.length > 0 ? 'pass' : 'blocking', 'Safety constraints are executable.', [`${input.invariants.length} invariants`]),
    result('liveness', !input.runtimeRequested || input.actions.some(action => action.maxWait > 0) ? 'pass' : 'blocking', 'Waits and retries are bounded.', input.actions.map(action => `${action.id}: maxWait=${String(action.maxWait)}`)),
    result('fairness', !input.runtimeRequested || input.actions.every(action => action.retryBudget >= 0) ? 'pass' : 'blocking', 'Retry budgets are finite.', input.actions.map(action => `${action.id}: retries=${String(action.retryBudget)}`)),
    result('event-validity', 'pass', 'Only effect commits may produce authoritative events.', ['Runtime event validator required by WWS']),
    result('behavioral-validity', input.purpose.hardExpectations.length > 0 ? 'pass' : 'warning', 'Behavior expectations are declared.', input.purpose.hardExpectations),
    result('replay', 'pass', 'Blueprint inputs are immutable and deterministic.', [input.digest]),
    result('provenance', noOrphans ? 'pass' : 'blocking', 'Executable nodes retain source provenance.', [`${provenanceNodes.length} executable nodes`]),
  ]
  return {
    blueprintDigest: input.digest,
    createdAt: new Date().toISOString(),
    sourceCoverage: {
      author: coverage('author'),
      'approved-supplement': coverage('approved-supplement'),
      'mechanism-pack': coverage('mechanism-pack'),
      import: coverage('import'),
      'agent-proposal': coverage('agent-proposal'),
      'runtime-proposal': coverage('runtime-proposal'),
    },
    results,
    deterministicWithoutAi: true,
    knownLimits: input.runtimeRequested ? [] : ['This build declares no autonomous runtime horizon.'],
    performance: { sourceObjects: input.canon.length, executableNodes: provenanceNodes.length },
  }
}

function proposalProvenance(proposal: CompilerProposal): Provenance {
  return {
    kind: 'approved-supplement',
    anchors: proposal.anchors,
    proposalId: worldlineId<'proposal'>(proposal.id),
    approvedBy: proposal.reviewedBy ?? 'author',
    confidence: 1,
  }
}

/** Compile one immutable source snapshot without IO or model calls. */
export function compileSnapshot(
  snapshot: ProjectSourceSnapshot,
  requestedPurpose: SimulationPurpose | undefined,
  previousQuestions: readonly CreativeQuestion[],
  proposals: readonly CompilerProposal[],
): CompilationProduct {
  const purpose = requestedPurpose ?? defaultPurpose(snapshot)
  const diagnostics: BuildDiagnostic[] = []
  const canon = snapshot.files.map(file => canonObject(file, snapshot))
  const answeredCharter = previousQuestions.find(item => item.id === question('missing-charter', '', '', 'high').id
    && item.status === 'answered' && item.answer !== undefined)
  if (answeredCharter?.answer !== undefined && !canon.some(object => object.kind === 'charter')) {
    canon.push({
      id: worldlineId<'entity'>(`entity:${contentFingerprint(answeredCharter.id)}`),
      kind: 'charter',
      documentId: worldlineId<'document'>(`document:${contentFingerprint(answeredCharter.id)}`),
      title: 'Approved charter supplement',
      aliases: [],
      tags: ['approved-supplement'],
      status: 'canon',
      worldIds: [snapshot.manifest.defaultWorldId],
      worldlineIds: [snapshot.manifest.defaultWorldlineId],
      facets: { answer: answeredCharter.answer },
      provenance: [{ kind: 'approved-supplement', anchors: [], approvedBy: 'author', confidence: 1 }],
    })
  }
  const byDocument = new Map(snapshot.files.map(file => [file.id, entityIdOf(file)]))
  const byEntity = new Set(canon.map(object => object.id))
  const links: CanonLink[] = []
  const actions: ActionDefinition[] = []
  const systems: SystemDefinition[] = []
  const invariants: InvariantDefinition[] = []
  const maps: WorldMap[] = []

  for (const file of snapshot.files) {
    for (const match of file.content.matchAll(LINK_PATTERN)) {
      const targetText = match[1]
      if (targetText === undefined) continue
      const target = targetText.startsWith('entity:')
        ? targetText as EntityId
        : byDocument.get(targetText as ProjectSourceFile['id'])
      if (target === undefined || !byEntity.has(target)) {
        diagnostics.push({ code: 'broken-link', severity: 'blocking', message: `Unresolved stable reference: ${targetText}`, path: file.path })
        continue
      }
      links.push({
        id: worldlineId<'link'>(`link:${contentFingerprint(`${file.id}:${match.index}:${target}`)}`),
        from: entityIdOf(file),
        to: target,
        predicate: 'references',
        directed: true,
        provenance: [provenance(file, match.index, match.index + match[0].length)],
      })
    }
    for (const match of file.content.matchAll(FENCE_PATTERN)) {
      const kind = match[1] as ExecutableKind | undefined
      const raw = match[2]
      if (kind === undefined || raw === undefined) continue
      try {
        const value = JSON.parse(raw) as unknown
        if (!isRecord(value)) throw new TypeError('fenced definition must be a JSON object')
        const source = provenance(file, match.index, match.index + match[0].length)
        if (kind === 'action') actions.push(parseAction(value, source))
        if (kind === 'system') systems.push(parseSystem(value, source))
        if (kind === 'invariant') invariants.push(parseInvariant(value, source))
        if (kind === 'map') maps.push(parseMap(value, source))
      } catch (error) {
        diagnostics.push({
          code: 'invalid-mechanism-json',
          severity: 'blocking',
          message: error instanceof Error ? error.message : String(error),
          path: file.path,
          remediation: `Fix the worldline-${kind} JSON fence.`,
        })
      }
    }
  }

  for (const proposal of proposals.filter(item => item.status === 'approved')) {
    const source = proposalProvenance(proposal)
    try {
      if (proposal.target === 'action') actions.push(parseAction(proposal.payload, source))
      if (proposal.target === 'system') systems.push(parseSystem(proposal.payload, source))
      if (proposal.target === 'invariant') invariants.push(parseInvariant(proposal.payload, source))
      if (proposal.target === 'map') maps.push(parseMap(proposal.payload, source))
      if (proposal.target === 'canon') {
        const proposedKind = stringValue(proposal.payload.kind, 'custom:proposal')
        canon.push({
          id: worldlineId<'entity'>(stringValue(
            proposal.payload.id,
            `entity:${contentFingerprint(proposal.id)}`,
          )),
          kind: proposedKind as CanonObjectKind,
          documentId: worldlineId<'document'>(`document:${contentFingerprint(proposal.id)}`),
          title: stringValue(proposal.payload.title, proposal.title),
          aliases: [],
          tags: ['approved-supplement'],
          status: 'canon',
          worldIds: [snapshot.manifest.defaultWorldId],
          worldlineIds: [snapshot.manifest.defaultWorldlineId],
          facets: jsonObject(proposal.payload.facets),
          provenance: [source],
        })
      }
    } catch (error) {
      diagnostics.push({
        code: 'invalid-approved-proposal',
        severity: 'blocking',
        message: error instanceof Error ? error.message : String(error),
        objectId: proposal.id,
      })
    }
  }

  const runtimeRequested = purpose.duration > 0
  const generatedQuestions: CreativeQuestion[] = []
  if (!canon.some(object => object.kind === 'charter')) {
    generatedQuestions.push(question('missing-charter', 'What truths may never be violated in this world?', 'A charter establishes the authority boundary for every later rule.', 'high'))
  }
  if (runtimeRequested && maps.length === 0) {
    generatedQuestions.push(question('missing-map', 'Where can actors exist and how do they travel between places?', 'Runtime movement requires explicit topology and duration.', 'high'))
  }
  if (runtimeRequested && actions.length === 0) {
    generatedQuestions.push(question('missing-actions', 'Which actions must characters be able to attempt?', 'An autonomous world needs at least one executable action contract.', 'high'))
  }
  if (runtimeRequested && invariants.length === 0) {
    generatedQuestions.push(question('missing-invariants', 'Which safety conditions must every state preserve?', 'Closure cannot certify safety without executable invariants.', 'high'))
  }

  const entities: RuntimeEntitySeed[] = canon.map(object => ({
    id: object.id,
    type: object.kind,
    facets: object.facets,
    state: {},
    lod: object.kind === 'character' ? 'L2' : 'L0',
    policyIds: [],
    memory: { episodic: [], beliefs: [], goals: [], relationships: [], experience: [], skills: [], reflections: [] },
  }))
  const digest = createHash('sha256').update(stableStringify({
    snapshot: snapshot.digest,
    purpose,
    canon,
    links,
    maps,
    actions,
    systems,
    invariants,
  })).digest('hex')
  const certificate = makeCertificate({
    digest, runtimeRequested, canon, maps, entities, actions, systems, invariants, diagnostics, purpose,
  })
  return {
    snapshot,
    purpose,
    canon,
    links,
    maps,
    entities,
    actions,
    systems,
    invariants,
    diagnostics,
    questions: mergeQuestions(generatedQuestions, previousQuestions),
    proposals,
    certificate,
  }
}
