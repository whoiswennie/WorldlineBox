import type {
  Blueprint,
  CanonObject,
  CertificateCategory,
  ClosureCertificate,
  ContextPack,
  Effect,
  EntityId,
  Expression,
  InvariantDefinition,
  JsonObject,
  JsonValue,
  Process,
  RuntimeEntitySeed,
  StateDelta,
  WorldEvent,
  WorldMap,
} from './model.ts'

/** Actor/target identities used to resolve the scoped expression vocabulary. */
export interface ExpressionScope {
  readonly actorId?: EntityId
  readonly targetId?: EntityId
}

/** The explicit scope carried by one expression/effect path. */
export type WorldlinePathScope = 'actor' | 'target' | 'world'

/** Classify a path without reading state. `state.*` is the concise actor alias. */
export function worldlinePathScope(path: string): WorldlinePathScope {
  if (path.startsWith('state.') || path.startsWith('actor.state.')) return 'actor'
  if (path.startsWith('target.state.')) return 'target'
  return 'world'
}

function escapePathSegment(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('.', '\\.')
}

/** Resolve one scoped DSL path to the single authoritative Run-state tree. */
export function resolveWorldlinePath(path: string, scope: ExpressionScope): string | undefined {
  if (path.startsWith('state.')) {
    return scope.actorId === undefined
      ? undefined
      : `entities.${escapePathSegment(scope.actorId)}.state.${path.slice('state.'.length)}`
  }
  if (path.startsWith('actor.state.')) {
    return scope.actorId === undefined
      ? undefined
      : `entities.${escapePathSegment(scope.actorId)}.state.${path.slice('actor.state.'.length)}`
  }
  if (path.startsWith('target.state.')) {
    return scope.targetId === undefined
      ? undefined
      : `entities.${escapePathSegment(scope.targetId)}.state.${path.slice('target.state.'.length)}`
  }
  return path
}

/** Enumerate every leaf path in an expression for scope and closure auditing. */
export function expressionPaths(expression: Expression): readonly string[] {
  switch (expression.op) {
    case 'and':
    case 'or': return expression.items.flatMap(expressionPaths)
    case 'not': return expressionPaths(expression.item)
    default: return [expression.path]
  }
}

/** Result of applying one deterministic, scoped effect batch. */
export interface WorldlineEffectResult {
  readonly state: JsonObject
  readonly deltas: readonly StateDelta[]
  readonly cognitionChanges: readonly JsonObject[]
}

function mergeJsonObjects(left: JsonObject, right: JsonObject): JsonObject {
  const result = structuredClone(left)
  for (const [key, value] of Object.entries(right)) {
    const current = result[key]
    result[key] = current !== null && !Array.isArray(current) && typeof current === 'object'
      && value !== null && !Array.isArray(value) && typeof value === 'object'
      ? mergeJsonObjects(current, value)
      : structuredClone(value)
  }
  return result
}

/** Materialize the one initial Run-state shape used by freeze auditing and Run creation. */
export function materializeInitialWorldState(
  canon: readonly CanonObject[],
  entities: readonly RuntimeEntitySeed[],
): JsonObject {
  const authored = canon.reduce<JsonObject>((state, object) => {
    const value = object.facets.initialWorldState
    return value !== null && !Array.isArray(value) && typeof value === 'object'
      ? mergeJsonObjects(state, value)
      : state
  }, {})
  return mergeJsonObjects({
    world: { time: 0 },
    entities: Object.fromEntries(entities.map(entity => [entity.id, {
      type: entity.type,
      facets: entity.facets,
      state: entity.state,
      lod: entity.lod,
      memory: entity.memory as unknown as JsonValue,
    }])),
    resources: {},
  }, authored)
}

function writePath(root: JsonObject, path: string, value: JsonValue): JsonObject {
  const result = structuredClone(root)
  const segments = pathSegments(path)
  if (segments.length === 0) throw new Error('an effect cannot replace the Run state root')
  let cursor: Record<string, JsonValue> = result
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment]
    if (existing === null || Array.isArray(existing) || typeof existing !== 'object') {
      cursor[segment] = {}
    }
    cursor = cursor[segment] as Record<string, JsonValue>
  }
  const leaf = segments.at(-1)
  if (leaf === undefined) throw new Error('an effect path must identify a state field')
  cursor[leaf] = value
  return result
}

/** Apply the one shared effect semantics used by compiler dry-runs and the live kernel. */
export function applyWorldlineEffects(
  initial: JsonObject,
  effects: readonly Effect[],
  scope: ExpressionScope,
): WorldlineEffectResult {
  let state = structuredClone(initial)
  const deltas: StateDelta[] = []
  const cognitionChanges: JsonObject[] = []
  for (const effect of effects) {
    if (effect.op === 'observe') {
      cognitionChanges.push({ observer: effect.observer, fact: effect.fact })
      continue
    }
    if (effect.op === 'transfer') {
      const resource = escapePathSegment(effect.resource)
      const fromPath = `resources.${resource}.holders.${escapePathSegment(effect.from)}`
      const toPath = `resources.${resource}.holders.${escapePathSegment(effect.to)}`
      const beforeFrom = Number(readPath(state, fromPath) ?? 0)
      const beforeTo = Number(readPath(state, toPath) ?? 0)
      if (beforeFrom < effect.amount) throw new Error('resource transfer exceeds holdings')
      state = writePath(state, fromPath, beforeFrom - effect.amount)
      state = writePath(state, toPath, beforeTo + effect.amount)
      deltas.push({ path: fromPath, before: beforeFrom, after: beforeFrom - effect.amount })
      deltas.push({ path: toPath, before: beforeTo, after: beforeTo + effect.amount })
      continue
    }
    const path = resolveWorldlinePath(effect.path, scope)
    if (path === undefined) {
      throw new Error(`effect path ${effect.path} requires a bound ${worldlinePathScope(effect.path)}`)
    }
    const before = readPath(state, path)
    if (effect.op === 'set') state = writePath(state, path, effect.value)
    if (effect.op === 'increment') {
      let next = Number(before ?? 0) + effect.amount
      if (effect.min !== undefined) next = Math.max(effect.min, next)
      if (effect.max !== undefined) next = Math.min(effect.max, next)
      state = writePath(state, path, next)
    }
    const after = readPath(state, path)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      deltas.push({
        path,
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      })
    }
  }
  return { state, deltas, cognitionChanges }
}

/** Structured invariant failure shared by freeze auditing and live execution diagnostics. */
export interface InvariantEvaluationFailure {
  readonly invariantId: string
  readonly actorId?: EntityId
  readonly reason: string
  readonly paths: readonly string[]
}

/** Evaluate world invariants with actor-scoped expressions applied to matching characters. */
export function evaluateWorldlineInvariants(
  invariants: readonly InvariantDefinition[],
  entities: readonly RuntimeEntitySeed[],
  state: JsonObject,
): readonly InvariantEvaluationFailure[] {
  const failures: InvariantEvaluationFailure[] = []
  for (const invariant of invariants) {
    const paths = expressionPaths(invariant.expression)
    const actorPaths = paths.filter(path => worldlinePathScope(path) === 'actor')
    const targetPaths = paths.filter(path => worldlinePathScope(path) === 'target')
    if (targetPaths.length > 0) {
      failures.push({
        invariantId: invariant.id,
        reason: 'target-scoped invariant has no stable target binding',
        paths: targetPaths,
      })
      continue
    }
    if (actorPaths.length === 0) {
      if (!evaluateScopedExpression(invariant.expression, state, {})) {
        failures.push({ invariantId: invariant.id, reason: 'world expression is false', paths })
      }
      continue
    }
    const applicable = entities.filter(entity => (
      entity.type === 'character'
      && actorPaths.every((path) => {
        const resolved = resolveWorldlinePath(path, { actorId: entity.id })
        return resolved !== undefined && readPath(state, resolved) !== undefined
      })
    ))
    if (applicable.length === 0) {
      failures.push({
        invariantId: invariant.id,
        reason: 'actor-scoped invariant matches no runtime character state',
        paths: actorPaths,
      })
      continue
    }
    for (const entity of applicable) {
      if (evaluateScopedExpression(invariant.expression, state, { actorId: entity.id })) continue
      failures.push({
        invariantId: invariant.id,
        actorId: entity.id,
        reason: 'actor expression is false',
        paths: actorPaths,
      })
    }
  }
  return failures
}

function pathSegments(path: string): string[] {
  const segments: string[] = []
  let current = ''
  let escaped = false
  for (const character of path.replace(/^\$\.?/u, '')) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === '.') {
      if (current !== '') segments.push(current)
      current = ''
    } else {
      current += character
    }
  }
  if (escaped) current += '\\'
  if (current !== '') segments.push(current)
  return segments
}

/** WorldEvent is reserved for an authoritative difference or meaningful process boundary.
 * @param event - The event supplied by the caller.
 * @returns The result produced by the operation.
 */
export function isValidWorldEvent(event: WorldEvent): boolean {
  return event.deltas.some(delta => JSON.stringify(delta.before) !== JSON.stringify(delta.after))
    || event.persistentFacts.length > 0
    || event.cognitionChanges.length > 0
    || event.processMilestone !== undefined
}

/** All blocking certificate categories that a frozen autonomous Blueprint must report. */
export const REQUIRED_CERTIFICATE_CATEGORIES: readonly CertificateCategory[] = [
  'state', 'time', 'space', 'actions', 'cognition', 'causality', 'safety', 'liveness',
  'fairness', 'event-validity', 'behavioral-validity', 'replay', 'provenance',
]

/** Perform certificate is autonomous through the package's public contract.
 * @param certificate - The certificate supplied by the caller.
 * @returns The result produced by the operation.
 */
export function certificateIsAutonomous(certificate: ClosureCertificate): boolean {
  const byCategory = new Map(certificate.results.map(result => [result.category, result]))
  return certificate.deterministicWithoutAi
    && REQUIRED_CERTIFICATE_CATEGORIES.every(category => byCategory.get(category)?.status !== 'blocking')
}

/** Describes the map diagnostic value exchanged across the package boundary.
 */
export interface MapDiagnostic { readonly code: string; readonly message: string; readonly objectId?: string }

/** Validate hierarchy, endpoints, capacities, geometry, and reachability of one map.
 * @param map - The map supplied by the caller.
 * @returns The result produced by the operation.
 */
export function validateWorldMap(map: WorldMap): readonly MapDiagnostic[] {
  const diagnostics: MapDiagnostic[] = []
  const nodes = new Map(map.nodes.map(node => [node.id, node]))
  if (!nodes.has(map.rootNodeId)) diagnostics.push({ code: 'missing-root', message: 'Map root does not exist.' })
  for (const node of map.nodes) {
    if (node.parentId !== undefined && !nodes.has(node.parentId)) {
      diagnostics.push({ code: 'missing-parent', message: `Parent ${node.parentId} does not exist.`, objectId: node.id })
    }
    if (node.capacity !== undefined && (!Number.isFinite(node.capacity) || node.capacity < 0)) {
      diagnostics.push({ code: 'invalid-capacity', message: 'Capacity must be finite and non-negative.', objectId: node.id })
    }
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) {
      diagnostics.push({ code: 'invalid-coordinate', message: 'Coordinates must be finite.', objectId: node.id })
    }
  }
  for (const edge of map.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      diagnostics.push({ code: 'dangling-edge', message: 'Edge endpoint does not exist.', objectId: edge.id })
    }
    if (!Number.isFinite(edge.distance) || edge.distance < 0 || !Number.isFinite(edge.baseDuration) || edge.baseDuration < 0) {
      diagnostics.push({ code: 'invalid-edge-cost', message: 'Distance and duration must be finite and non-negative.', objectId: edge.id })
    }
  }
  const parents = new Map(map.nodes.map(node => [node.id, node.parentId]))
  for (const node of map.nodes) {
    const seen = new Set<string>()
    let cursor: typeof node.id | undefined = node.id
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        diagnostics.push({ code: 'hierarchy-cycle', message: 'Map hierarchy contains a cycle.', objectId: node.id })
        break
      }
      seen.add(cursor)
      cursor = parents.get(cursor)
    }
  }
  return diagnostics
}

/** Verify an ordinary movement never changes position without a route-covering process.
 * @param process - The process supplied by the caller.
 * @returns The result produced by the operation.
 */
export function movementIsContinuous(process: Process): boolean {
  const movement = process.movement
  if (movement === undefined) return true
  return movement.route.length >= 2
    && movement.route[0] === movement.origin
    && movement.route[movement.route.length - 1] === movement.destination
    && movement.edgeIndex >= 0
    && movement.edgeIndex < movement.route.length - 1
    && movement.edgeFraction >= 0
    && movement.edgeFraction <= 1
    && movement.estimatedArrival >= movement.departedAt
    && movement.remainingDuration >= 0
}

/** Refuse Context Packs that would knowingly exceed their exact model budget.
 * @param pack - The pack supplied by the caller.
 */
export function validateContextPack(pack: ContextPack): void {
  if (pack.contextWindow < 1 || pack.inputLimit < 1) throw new TypeError('Context capacity must be positive.')
  if (pack.inputLimit > Math.floor(pack.contextWindow * 0.8)) {
    throw new RangeError('Context input limit exceeds the 80% safety ceiling.')
  }
  const measured = pack.sections.reduce((total, section) => total + section.tokens, 0)
  if (measured !== pack.totalTokens) throw new Error('Context Pack token total does not match its sections.')
  if (pack.totalTokens > pack.inputLimit) throw new RangeError('Context Pack exceeds its input limit.')
  if (pack.totalTokens + pack.reservedOutputTokens + pack.reservedToolTokens > pack.contextWindow) {
    throw new RangeError('Context Pack exceeds the model context window after reserves.')
  }
}

/** Evaluate the deliberately small, deterministic Blueprint expression language.
 * @param expression - The expression supplied by the caller.
 * @param state - The state supplied by the caller.
 * @returns The result produced by the operation.
 */
export function evaluateExpression(expression: Expression, state: JsonObject): boolean {
  switch (expression.op) {
    case 'and': return expression.items.every(item => evaluateExpression(item, state))
    case 'or': return expression.items.some(item => evaluateExpression(item, state))
    case 'not': return !evaluateExpression(expression.item, state)
    case 'exists': return readPath(state, expression.path) !== undefined
    case 'eq': return JSON.stringify(readPath(state, expression.path)) === JSON.stringify(expression.value)
    case 'neq': return JSON.stringify(readPath(state, expression.path)) !== JSON.stringify(expression.value)
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const value = readPath(state, expression.path)
      if (typeof value !== 'number' || typeof expression.value !== 'number') return false
      if (expression.op === 'gt') return value > expression.value
      if (expression.op === 'gte') return value >= expression.value
      if (expression.op === 'lt') return value < expression.value
      return value <= expression.value
    }
  }
}

/** Evaluate the expression language after resolving actor/target paths consistently. */
export function evaluateScopedExpression(
  expression: Expression,
  state: JsonObject,
  scope: ExpressionScope,
): boolean {
  switch (expression.op) {
    case 'and': return expression.items.every(item => evaluateScopedExpression(item, state, scope))
    case 'or': return expression.items.some(item => evaluateScopedExpression(item, state, scope))
    case 'not': return !evaluateScopedExpression(expression.item, state, scope)
    default: {
      const path = resolveWorldlinePath(expression.path, scope)
      if (path === undefined) return false
      return evaluateExpression({ ...expression, path } as Expression, state)
    }
  }
}

/** Read a nested value from an unknown structure by path.
 * @param root - The root supplied by the caller.
 * @param path - The path supplied by the caller.
 * @returns The result produced by the operation.
 */
export function readPath(root: JsonObject, path: string): JsonValue | undefined {
  const segments = pathSegments(path)
  let cursor: JsonValue | undefined = root
  for (const segment of segments) {
    if (cursor === null || Array.isArray(cursor) || typeof cursor !== 'object') return undefined
    cursor = cursor[segment]
  }
  return cursor
}

/** Check a Blueprint is frozen, source-covered, and safe to start.
 * @param blueprint - The blueprint supplied by the caller.
 * @returns The result produced by the operation.
 */
export function validateBlueprint(blueprint: Blueprint): readonly string[] {
  const errors: string[] = []
  if (blueprint.digest.length < 16) errors.push('Blueprint digest is missing or too short.')
  if (blueprint.certificate.blueprintDigest !== blueprint.digest) errors.push('Certificate digest does not match Blueprint.')
  if (!certificateIsAutonomous(blueprint.certificate)) errors.push('Blueprint certificate has blocking categories or requires AI.')
  if (blueprint.actions.some(action => action.provenance.length === 0)) errors.push('Action contains orphan semantics.')
  if (blueprint.systems.some(system => system.provenance.length === 0)) errors.push('System contains orphan semantics.')
  if (blueprint.invariants.some(invariant => invariant.provenance.length === 0)) errors.push('Invariant contains orphan semantics.')
  for (const map of blueprint.maps) errors.push(...validateWorldMap(map).map(item => item.message))
  return errors
}
