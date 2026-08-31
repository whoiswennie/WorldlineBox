import type {
  Blueprint,
  CertificateCategory,
  ClosureCertificate,
  ContextPack,
  Expression,
  JsonObject,
  JsonValue,
  Process,
  WorldEvent,
  WorldMap,
} from './model.ts'

/** WorldEvent is reserved for an authoritative difference or meaningful process boundary. */
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

export function certificateIsAutonomous(certificate: ClosureCertificate): boolean {
  const byCategory = new Map(certificate.results.map(result => [result.category, result]))
  return certificate.deterministicWithoutAi
    && REQUIRED_CERTIFICATE_CATEGORIES.every(category => byCategory.get(category)?.status !== 'blocking')
}

export interface MapDiagnostic { readonly code: string; readonly message: string; readonly objectId?: string }

/** Validate hierarchy, endpoints, capacities, geometry, and reachability of one map. */
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

/** Verify an ordinary movement never changes position without a route-covering process. */
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

/** Refuse Context Packs that would knowingly exceed their exact model budget. */
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

/** Evaluate the deliberately small, deterministic Blueprint expression language. */
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

export function readPath(root: JsonObject, path: string): JsonValue | undefined {
  const segments = path.split('.').filter(Boolean)
  let cursor: JsonValue | undefined = root
  for (const segment of segments) {
    if (cursor === null || Array.isArray(cursor) || typeof cursor !== 'object') return undefined
    cursor = cursor[segment]
  }
  return cursor
}

/** Check a Blueprint is frozen, source-covered, and safe to start. */
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
