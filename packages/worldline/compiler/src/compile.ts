import { createHash } from 'node:crypto'
import type { ProjectSourceFile, ProjectSourceSnapshot } from '@deepseek-ai/dsh-worldline-project'
import {
  type ActionDefinition,
  type CanonLink,
  type CanonObject,
  type CanonObjectKind,
  type CertificateCategory,
  type CertificateResult,
  type CharacterMemory,
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
  applyWorldlineEffects,
  contentFingerprint,
  evaluateScopedExpression,
  evaluateWorldlineInvariants,
  expressionPaths,
  inferCanonObjectKind,
  materializeInitialWorldState,
  readPath,
  stableStringify,
  validateWorldMap,
  worldlinePathScope,
  worldlineId,
} from '@deepseek-ai/dsh-worldline-standard'
import type {
  BuildDiagnostic,
  CompilerProposal,
  CreativeQuestion,
} from './types.ts'

/** Describes the compilation product value exchanged across the package boundary.
 */
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

function kindOf(file: ProjectSourceFile): { readonly kind: CanonObjectKind; readonly customKind?: string } {
  return inferCanonObjectKind(file.path, file.objectKind)
}

function facetsOf(file: ProjectSourceFile): Readonly<Record<string, JsonValue>> {
  const match = /<!--\s*worldline-facets\s+([\s\S]*?)-->/u.exec(file.content)
  if (match?.[1] === undefined) return { sourcePath: file.path }
  try { return { sourcePath: file.path, ...jsonObject(JSON.parse(match[1])) } } catch { return { sourcePath: file.path } }
}

function entityIdOf(file: ProjectSourceFile): EntityId {
  return worldlineId<'entity'>(`entity:${contentFingerprint(file.id)}`)
}

function memoryBase(actorId: EntityId, category: string, index: number) {
  return {
    id: worldlineId<'memory'>(`memory:${contentFingerprint(`${actorId}:${category}:${String(index)}`)}`),
    actorId,
    logicalTime: 0,
    sourceEventIds: [],
    importance: 0.7,
  }
}

/** Normalize concise author facets into the runtime's structured memory authority. */
function authoredMemory(object: CanonObject): CharacterMemory {
  const source = isRecord(object.facets.memory) ? object.facets.memory : {}
  const episodicSource = Array.isArray(source.episodic) ? source.episodic : []
  const beliefSource = Array.isArray(source.beliefs)
    ? source.beliefs.map((value, index) => [String(index), value] as const)
    : isRecord(source.beliefs) ? Object.entries(source.beliefs) : []
  const goalSource = Array.isArray(source.goals) ? source.goals : []
  const relationshipSource = Array.isArray(source.relationships)
    ? source.relationships.map((value, index) => [String(index), value] as const)
    : isRecord(source.relationships) ? Object.entries(source.relationships) : []
  const experienceSource = Array.isArray(source.experience) ? source.experience : []
  const skillSource = Array.isArray(source.skills) ? source.skills : []
  const reflectionSource = Array.isArray(source.reflections) ? source.reflections : []
  return {
    episodic: episodicSource.map((value, index) => {
      const detail = isRecord(value) ? value : {}
      const participants = Array.isArray(detail.participants)
        ? detail.participants.filter((item): item is string => typeof item === 'string')
        : [object.id]
      return {
        ...memoryBase(object.id, 'episodic', index),
        summary: typeof value === 'string' ? value : stringValue(detail.summary, `经历 ${String(index + 1)}`),
        participants: participants.map(item => worldlineId<'entity'>(item)),
        ...(typeof detail.placeId === 'string'
          ? { placeId: worldlineId<'map-node'>(detail.placeId) }
          : {}),
      }
    }),
    beliefs: beliefSource.map(([subject, value], index) => {
      const detail = isRecord(value) ? value : undefined
      return {
        ...memoryBase(object.id, 'belief', index),
        subject: detail === undefined ? subject : stringValue(detail.subject, subject),
        value: detail?.value as JsonValue ?? value as JsonValue,
        confidence: Math.min(1, Math.max(0, numberValue(detail?.confidence, 1))),
        contradictedBy: [],
      }
    }),
    goals: goalSource.map((value, index) => {
      const detail = isRecord(value) ? value : {}
      const status = detail.status === 'met' || detail.status === 'failed' || detail.status === 'abandoned'
        ? detail.status
        : 'active'
      return {
        ...memoryBase(object.id, 'goal', index),
        goal: typeof value === 'string' ? value : stringValue(detail.goal, `目标 ${String(index + 1)}`),
        status,
        ...(typeof detail.deadline === 'number' ? { deadline: detail.deadline } : {}),
        ...(typeof detail.promisedTo === 'string'
          ? { promisedTo: worldlineId<'entity'>(detail.promisedTo) }
          : {}),
      }
    }),
    relationships: relationshipSource.map(([other, value], index) => {
      const detail = isRecord(value) ? value : {}
      const dimensions = isRecord(detail.dimensions)
        ? Object.fromEntries(Object.entries(detail.dimensions)
          .filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
        : typeof value === 'number' ? { affinity: value } : {}
      return {
        ...memoryBase(object.id, 'relationship', index),
        otherId: worldlineId<'entity'>(stringValue(detail.otherId, other)),
        dimensions,
      }
    }),
    experience: experienceSource.map((value, index) => {
      const detail = isRecord(value) ? value : {}
      const outcome = detail.outcome === 'failed' || detail.outcome === 'cancelled'
        ? detail.outcome
        : 'completed'
      return {
        ...memoryBase(object.id, 'experience', index),
        actionType: typeof value === 'string' ? value : stringValue(detail.actionType, 'authored.experience'),
        outcome,
        conditions: jsonObject(detail.conditions),
      }
    }),
    skills: skillSource.map((value, index) => {
      const detail = isRecord(value) ? value : {}
      return {
        ...memoryBase(object.id, 'skill', index),
        skill: typeof value === 'string' ? value : stringValue(detail.skill, `技能 ${String(index + 1)}`),
        level: numberValue(detail.level, 1),
        evidence: [],
      }
    }),
    reflections: reflectionSource.map((value, index) => {
      const detail = isRecord(value) ? value : {}
      return {
        ...memoryBase(object.id, 'reflection', index),
        text: typeof value === 'string' ? value : stringValue(detail.text, `反思 ${String(index + 1)}`),
      }
    }),
  }
}

function canonObject(file: ProjectSourceFile, snapshot: ProjectSourceSnapshot): CanonObject {
  const kind = kindOf(file)
  return {
    id: entityIdOf(file),
    ...kind,
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
    ...(value.operator === 'move' || value.operator === 'teleport' || value.operator === 'generic'
      ? { operator: value.operator }
      : {}),
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
    name: stringValue(value.name, '世界地图'),
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
    summary: runtimeTemplate ? '验证这个项目能否作为自治世界持续运行。' : '编译具有完整来源覆盖的世界资料。',
    scope: runtimeTemplate ? ['world', 'characters', 'space', 'actions'] : ['world-reference'],
    duration: runtimeTemplate ? 86_400 : 0,
    resolution: 60,
    detail: runtimeTemplate ? 'L2' : 'L0',
    hardExpectations: [],
    statisticalExpectations: [],
    antiPatterns: ['无来源语义', '普通移动瞬间完成', '无限重试'],
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
  readonly audit: ExecutabilityAudit
}

interface UnreachableExecutable {
  readonly id: string
  readonly reason: string
}

interface ExecutabilityAudit {
  readonly reachableActions: readonly string[]
  readonly unreachableActions: readonly UnreachableExecutable[]
  readonly progressingSystems: readonly string[]
  readonly stalledSystems: readonly UnreachableExecutable[]
  readonly initialInvariantFailures: readonly string[]
  readonly committedSteps: number
  readonly mapReachable: boolean
}

function mapHasReachableDestination(maps: readonly WorldMap[], origin: string): boolean {
  const edges = maps.flatMap(map => map.edges)
  const visited = new Set([origin])
  const queue = [origin]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    for (const edge of edges) {
      const next = edge.from === current
        ? edge.to
        : edge.bidirectional && edge.to === current ? edge.from : undefined
      if (next === undefined || edge.baseDuration <= 0 || visited.has(next)) continue
      return true
    }
  }
  return false
}

function executableScopeCandidates(
  action: ActionDefinition,
  entities: readonly RuntimeEntitySeed[],
): readonly { readonly actorId: EntityId; readonly targetId?: EntityId }[] {
  const needsTarget = [
    ...action.preconditions.flatMap(expressionPaths),
    ...action.effects.flatMap(effect => 'path' in effect ? [effect.path] : []),
  ].some(path => worldlinePathScope(path) === 'target')
  return entities.filter(entity => action.actorTypes.includes(entity.type)).flatMap((actor) => {
    if (!needsTarget) return [{ actorId: actor.id }]
    return entities.filter(target => target.id !== actor.id)
      .map(target => ({ actorId: actor.id, targetId: target.id }))
  })
}

/** Bounded deterministic smoke execution used by the freeze certificate. */
function auditExecutability(input: {
  readonly canon: readonly CanonObject[]
  readonly entities: readonly RuntimeEntitySeed[]
  readonly maps: readonly WorldMap[]
  readonly actions: readonly ActionDefinition[]
  readonly systems: readonly SystemDefinition[]
  readonly invariants: readonly InvariantDefinition[]
}): ExecutabilityAudit {
  const initial = materializeInitialWorldState(input.canon, input.entities)
  const initialInvariantFailures = evaluateWorldlineInvariants(
    input.invariants,
    input.entities,
    initial,
  ).map(item => `${item.invariantId}${item.actorId === undefined ? '' : `@${item.actorId}`}: ${item.reason}`)
  const reachableActions: string[] = []
  const unreachableActions: UnreachableExecutable[] = []
  let mapReachable = !input.actions.some(action => action.operator === 'move')
  for (const action of input.actions) {
    const candidates = executableScopeCandidates(action, input.entities)
    let failure = candidates.length === 0 ? '没有匹配 actorTypes 的运行角色' : '初始状态不满足前置条件'
    let reachable = false
    for (const scope of candidates) {
      if (!action.preconditions.every(expression => evaluateScopedExpression(expression, initial, scope))) continue
      if (action.operator === 'move') {
        const origin = readPath(initial, `entities.${scope.actorId}.state.locationId`)
        if (typeof origin !== 'string' || !mapHasReachableDestination(input.maps, origin)) {
          failure = '角色初始位置没有正耗时的可达路径'
          continue
        }
        mapReachable = true
      }
      try {
        const applied = applyWorldlineEffects(initial, action.effects, scope)
        const invariantFailures = evaluateWorldlineInvariants(
          input.invariants,
          input.entities,
          applied.state,
        )
        if (invariantFailures.length > 0) {
          failure = `动作效果违反不变量 ${invariantFailures.map(item => item.invariantId).join('、')}`
          continue
        }
        reachable = true
        break
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
    }
    if (reachable) reachableActions.push(action.id)
    else unreachableActions.push({ id: action.id, reason: failure })
  }

  const progressingSystems: string[] = []
  const stalledSystems: UnreachableExecutable[] = []
  for (const system of input.systems) {
    const scopedPaths = [
      ...system.preconditions.flatMap(expressionPaths),
      ...system.effects.flatMap(effect => 'path' in effect ? [effect.path] : []),
    ].filter(path => worldlinePathScope(path) !== 'world')
    if (scopedPaths.length > 0) {
      stalledSystems.push({ id: system.id, reason: '周期系统不能使用 actor/target 作用域' })
      continue
    }
    if (!system.preconditions.every(expression => evaluateScopedExpression(expression, initial, {}))) {
      stalledSystems.push({ id: system.id, reason: '初始状态不满足系统前置条件' })
      continue
    }
    try {
      const applied = applyWorldlineEffects(initial, system.effects, {})
      const failures = evaluateWorldlineInvariants(input.invariants, input.entities, applied.state)
      if (failures.length > 0) {
        stalledSystems.push({
          id: system.id,
          reason: `系统效果违反不变量 ${failures.map(item => item.invariantId).join('、')}`,
        })
      } else if (applied.deltas.length === 0 && applied.cognitionChanges.length === 0) {
        stalledSystems.push({ id: system.id, reason: '系统唤醒后没有产生状态、事实或认知变化' })
      } else {
        progressingSystems.push(system.id)
      }
    } catch (error) {
      stalledSystems.push({ id: system.id, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    reachableActions,
    unreachableActions,
    progressingSystems,
    stalledSystems,
    initialInvariantFailures,
    committedSteps: reachableActions.length + progressingSystems.length,
    mapReachable,
  }
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
    result('state', input.canon.length > 0 ? 'pass' : 'blocking', '正典状态可以完整实例化。', [`${input.canon.length} 个正典对象`]),
    result('time', !input.runtimeRequested || input.purpose.duration > 0 ? 'pass' : 'blocking', '演算时间范围有限且明确。', [`持续时间=${String(input.purpose.duration)}`]),
    result('space', !input.runtimeRequested || (input.maps.length > 0 && mapErrors.length === 0) ? 'pass' : 'blocking', '运行地图拓扑连通且有效。', mapErrors.length === 0 ? [`${input.maps.length} 张地图`] : mapErrors.map(item => item.message)),
    result('actions', !input.runtimeRequested || (input.actions.length > 0 && input.audit.unreachableActions.length === 0) ? 'pass' : 'blocking', '动作必须从角色初始状态真实可达并能通过不变量。', input.audit.unreachableActions.length === 0 ? input.audit.reachableActions : input.audit.unreachableActions.map(item => `${item.id}: ${item.reason}`)),
    result('cognition', !input.runtimeRequested || input.entities.length > 0 ? 'pass' : 'blocking', '每个运行角色拥有隔离且保留作者设定的记忆。', [`${input.entities.length} 个运行实体`]),
    result('causality', !input.runtimeRequested || input.actions.some(action => action.effects.length > 0) || input.systems.some(system => system.effects.length > 0) ? 'pass' : 'blocking', '每次状态变化都有明确原因。', [`${input.actions.length + input.systems.length} 个效果来源`]),
    result('safety', !input.runtimeRequested || (input.invariants.length > 0 && input.audit.initialInvariantFailures.length === 0) ? 'pass' : 'blocking', '初始状态及有界预演必须满足所有不变量。', input.audit.initialInvariantFailures.length === 0 ? [`${input.invariants.length} 条不变量`] : input.audit.initialInvariantFailures),
    result('liveness', !input.runtimeRequested || (input.audit.committedSteps > 0 && input.audit.stalledSystems.length === 0) ? 'pass' : 'blocking', '有界预演必须产生有效进展，周期系统不得空转。', [...input.audit.reachableActions, ...input.audit.progressingSystems, ...input.audit.stalledSystems.map(item => `${item.id}: ${item.reason}`)]),
    result('fairness', !input.runtimeRequested || input.actions.every(action => action.retryBudget >= 0) ? 'pass' : 'blocking', '所有动作的重试预算都是有限值。', input.actions.map(action => `${action.id}: 重试=${String(action.retryBudget)}`)),
    result('event-validity', !input.runtimeRequested || input.audit.committedSteps > 0 ? 'pass' : 'blocking', '只有通过作用域和不变量检查的效果才可形成权威事件。', [`有界预演提交了 ${String(input.audit.committedSteps)} 步`]),
    result('behavioral-validity', input.purpose.hardExpectations.length > 0 ? 'pass' : 'warning', '已经声明需要验证的行为预期。', input.purpose.hardExpectations),
    result('replay', 'pass', '蓝图输入不可变，有界预演使用同一套确定性表达式与效果语义。', [input.digest]),
    result('provenance', noOrphans ? 'pass' : 'blocking', '每个可执行节点都保留来源。', [`${provenanceNodes.length} 个可执行节点`]),
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
    knownLimits: input.runtimeRequested ? [] : ['当前构建没有声明自治演算时间范围。'],
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

/** Compile one immutable source snapshot without IO or model calls.
 * @param snapshot - The snapshot supplied by the caller.
 * @param requestedPurpose - The requested purpose supplied by the caller.
 * @param previousQuestions - The previous questions supplied by the caller.
 * @param proposals - The proposals supplied by the caller.
 * @returns The result produced by the operation.
 */
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
      title: '已批准的世界宪章补充',
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
        diagnostics.push({ code: 'broken-link', severity: 'blocking', message: `无法解析稳定引用：${targetText}`, path: file.path })
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
          remediation: `修正 worldline-${kind} JSON 代码块。`,
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
        const proposedKind = inferCanonObjectKind(
          'proposal',
          stringValue(proposal.payload.kind, 'proposal'),
        )
        canon.push({
          id: worldlineId<'entity'>(stringValue(
            proposal.payload.id,
            `entity:${contentFingerprint(proposal.id)}`,
          )),
          ...proposedKind,
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
    generatedQuestions.push(question('missing-charter', '这个世界有哪些永远不能被违背的事实？', '世界宪章会为后续所有规则建立权威边界。', 'high'))
  }
  if (runtimeRequested && maps.length === 0) {
    generatedQuestions.push(question('missing-map', '角色可以出现在哪里，又如何在地点之间移动？', '运行时移动需要明确的地图连接和耗时。', 'high'))
  }
  if (runtimeRequested && actions.length === 0) {
    generatedQuestions.push(question('missing-actions', '角色至少需要能够尝试哪些行动？', '自治世界至少需要一条可执行的动作契约。', 'high'))
  }
  if (runtimeRequested && invariants.length === 0) {
    generatedQuestions.push(question('missing-invariants', '每个世界状态都必须遵守哪些安全条件？', '缺少可执行不变量时，构建闭包无法证明世界安全。', 'high'))
  }

  const entities: RuntimeEntitySeed[] = canon.filter(object => (
    object.kind === 'character' || object.facets.runtimeEntity === true
  )).map(object => ({
    id: object.id,
    type: object.kind,
    facets: object.facets,
    state: isRecord(object.facets.initialState) ? object.facets.initialState : {},
    lod: object.kind === 'character' ? 'L2' : 'L0',
    policyIds: [],
    memory: authoredMemory(object),
  }))
  const audit = auditExecutability({ canon, entities, maps, actions, systems, invariants })
  if (runtimeRequested) {
    diagnostics.push(...audit.initialInvariantFailures.map(message => ({
      code: 'initial-invariant-failed',
      severity: 'blocking' as const,
      message,
      remediation: '修正角色初始状态或不变量作用域，使冻结前的初始世界满足安全条件。',
    })))
    diagnostics.push(...audit.unreachableActions.map(item => ({
      code: 'action-unreachable',
      severity: 'blocking' as const,
      message: `${item.id}：${item.reason}`,
      objectId: item.id,
      remediation: '统一 actor/target/world 作用域，并保证至少一个匹配角色可完成该动作。',
    })))
    diagnostics.push(...audit.stalledSystems.map(item => ({
      code: 'system-no-progress',
      severity: 'blocking' as const,
      message: `${item.id}：${item.reason}`,
      objectId: item.id,
      remediation: '让周期系统产生可验证的状态、事实或认知变化，并保持不变量成立。',
    })))
    if (!audit.mapReachable) {
      diagnostics.push({
        code: 'map-route-unreachable',
        severity: 'blocking',
        message: '角色初始位置之间没有可执行的正耗时移动路径。',
        remediation: '检查角色 locationId、地图节点和边的 baseDuration。',
      })
    }
  }
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
    digest, runtimeRequested, canon, maps, entities, actions, systems, invariants,
    diagnostics, purpose, audit,
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
