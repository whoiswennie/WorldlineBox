import { createHash } from 'node:crypto'
import type {
  ActionDefinition,
  ActionRequest,
  AiIntent,
  AiInvocation,
  Blueprint,
  CharacterMemory,
  Checkpoint,
  ChoiceProjection,
  DecisionTrace,
  Effect,
  EntityId,
  FutureEvent,
  InvariantEvaluationFailure,
  JsonObject,
  JsonValue,
  MapEdge,
  MapNodeId,
  MovementProgress,
  Observation,
  NarrativeBeat,
  Process,
  ProcessId,
  ProjectId,
  Reservation,
  ResourceClaim,
  RunId,
  RunSnapshot,
  StoryProgressEvidence,
  StoryStateCommit,
  StateDelta,
  Telemetry,
  WorldEvent,
} from '@deepseek-ai/dsh-worldline-standard'
import {
  applyWorldlineEffects,
  contentFingerprint,
  evaluateScopedExpression,
  evaluateWorldlineInvariants,
  expressionPaths,
  isValidWorldEvent,
  materializeInitialWorldState,
  projectAuthoredCalendar,
  stableStringify,
  validateBlueprint,
  worldlineId,
} from '@deepseek-ai/dsh-worldline-standard'
import { WorldlineRunDatabase, type RunStreamRecord } from '@deepseek-ai/dsh-worldline-run-sqlite'
import type {
  ActorControlMode,
  AdvanceRunRequest,
  CheckpointView,
  CompletePresentationRequest,
  CompletePresentationResult,
  CreateCheckpointRequest,
  ExplainRunEventRequest,
  RunEventExplanation,
  RunChoicesRequest,
  RunChoicesView,
  RunDefinitionView,
  RunHealth,
  RunRecordsPage,
  RunRecordsRequest,
  RunSpatialRequest,
  RunSpatialView,
  SimulateRunRequest,
  SimulateRunResult,
  RecordAiIntentRequest,
  RecordAiIntentResult,
  RecordAiInvocationRequest,
  RecordAiInvocationResult,
  RecordActionDeckRequest,
  RecordActionDeckResult,
  RecordNarrativeBeatRequest,
  RecordNarrativeBeatResult,
  RecordStoryStateRequest,
  RecordStoryStateResult,
  RunStatus,
  RunSummary,
  RunView,
  SetActorControlRequest,
  SetAiEnabledRequest,
  SubmitRunActionRequest,
  SubmitRunActionResult,
  SwitchModelPolicyRequest,
} from '@deepseek-ai/dsh-worldline-runtime'
import { WorldlineRuntimeError } from '@deepseek-ai/dsh-worldline-runtime'

/** Describes the kernel init value exchanged across the package boundary.
 */
export interface KernelInit {
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly blueprint: Blueprint
  readonly databasePath: string
  readonly seed: string
  readonly startPaused?: boolean
  readonly modelPolicy?: RunSnapshot['modelPolicy']
  readonly resumeSnapshot?: RunSnapshot
  readonly parentRunId?: RunId
  readonly forkSequence?: number
  readonly controls?: Readonly<Record<string, ActorControlMode>>
}

interface MutableHealth {
  noProgressSteps: number
  deadlocksResolved: number
  livelocksResolved: number
  fairnessInterventions: number
}

interface PersistedRuntimeState {
  readonly createdAt: string
  readonly updatedAt: string
  readonly controls: Readonly<Record<string, ActorControlMode>>
  readonly health: MutableHealth
  readonly idCounter: number
}

interface EffectResult {
  readonly state: JsonObject
  readonly deltas: readonly StateDelta[]
  readonly cognitionChanges: readonly JsonObject[]
}

interface PlannedMovement {
  readonly route: readonly MapNodeId[]
  readonly edges: readonly MapEdge[]
  readonly duration: number
}

const EMPTY_MEMORY: CharacterMemory = {
  episodic: [],
  beliefs: [],
  goals: [],
  relationships: [],
  experience: [],
  skills: [],
  reflections: [],
}

const MEMORY_CATEGORY_LIMIT = 100
const RELATIONSHIP_EVIDENCE_LIMIT = 20
const RETAINED_TERMINAL_PROCESS_LIMIT = 64

function actionNeedsTarget(definition: ActionDefinition): boolean {
  return definition.preconditions.some(expression => (
    expressionPaths(expression).some(path => path.startsWith('target.state.'))
  )) || definition.effects.some(effect => (
    (effect.op === 'set' || effect.op === 'increment') && effect.path.startsWith('target.state.')
  ))
}

function syncConfiguredCalendar(state: JsonObject, logicalTime: number): JsonObject {
  const projection = projectAuthoredCalendar(state, logicalTime)
  if (projection === undefined) return state
  const world = state['world'] as JsonObject
  const calendar = world['calendar'] as JsonObject
  const time = `${String(projection.hour).padStart(2, '0')}:${String(projection.minute).padStart(2, '0')}`
  return setPath(state, 'world', {
    ...world,
    calendar: {
      ...calendar,
      startYear: projection.startYear,
      startSeason: projection.startSeason,
      startDayOfSeason: projection.startDayOfSeason,
      absoluteDay: projection.absoluteDay,
      year: projection.year,
      season: projection.season,
      dayOfSeason: projection.dayOfSeason,
      timeOfDaySeconds: projection.timeOfDaySeconds,
    },
    ...(typeof world['year'] === 'number' ? { year: projection.year } : {}),
    ...(typeof world['season'] === 'string' ? { season: projection.season } : {}),
    ...(typeof world['day'] === 'number' ? { day: projection.dayOfSeason } : {}),
    ...(typeof world['time'] === 'string' ? { time } : {}),
  })
}

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

function stateRecord(state: JsonObject): Record<string, JsonValue> { return state }

function stateDelta(path: string, before: JsonValue | undefined, after: JsonValue | undefined): StateDelta {
  return {
    path,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  }
}

function pathSegments(path: string): string[] {
  const result: string[] = []
  let current = ''
  let escaped = false
  for (const character of path.replace(/^\$\.?/u, '')) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === '.') {
      if (current !== '') result.push(current)
      current = ''
    } else {
      current += character
    }
  }
  if (escaped) current += '\\'
  if (current !== '') result.push(current)
  return result
}

function escapePathSegment(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('.', '\\.')
}

function getPath(root: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue = root
  for (const segment of pathSegments(path)) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = current[segment] as JsonValue
  }
  return current
}

function setPath(root: JsonObject, path: string, value: JsonValue): JsonObject {
  const parts = pathSegments(path)
  if (parts.length === 0) throw new Error('an effect cannot replace the Run state root')
  const result: JsonObject = { ...root }
  let cursor: Record<string, JsonValue> = result
  let source: Record<string, JsonValue> | undefined = root
  for (const segment of parts.slice(0, -1)) {
    const existing: JsonValue | undefined = source?.[segment]
    const next: Record<string, JsonValue> = typeof existing === 'object'
      && existing !== null && !Array.isArray(existing)
      ? { ...existing }
      : {}
    cursor[segment] = next
    cursor = next
    source = typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? existing
      : undefined
  }
  const leaf = parts.at(-1)
  if (leaf === undefined) throw new Error('an effect path must identify a state field')
  cursor[leaf] = value
  return result
}

function targetEntityId(parameters: JsonObject): EntityId | undefined {
  const value = parameters['targetId']
  return typeof value === 'string' ? worldlineId<'entity'>(value) : undefined
}

function processTerminal(state: Process['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}

function nonNegative(value: number, integer = false): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return integer ? Math.floor(value) : value
}

/** Deterministic discrete-event kernel. The containing Worker is its only caller and DB writer. */
export class WorldlineKernel {
  private snapshotValue: RunSnapshot
  private statusValue: RunStatus
  private readonly createdAt: string
  private updatedAt: string
  private readonly database: WorldlineRunDatabase
  private readonly controls = new Map<string, ActorControlMode>()
  private readonly healthValue: MutableHealth = {
    noProgressSteps: 0,
    deadlocksResolved: 0,
    livelocksResolved: 0,
    fairnessInterventions: 0,
  }
  private idCounter = 0
  private stopped = false
  private deferDatabaseCommit = false
  private deferredRecords: RunStreamRecord[] = []
  private readonly plannedMovementCache = new Map<string, PlannedMovement | null>()

  constructor(private readonly init: KernelInit) {
    const blueprintErrors = validateBlueprint(init.blueprint)
    if (blueprintErrors.length > 0) {
      throw new WorldlineRuntimeError(
        'blueprint-not-frozen',
        `Blueprint cannot start a Run: ${blueprintErrors.join(' ')}`,
      )
    }
    this.database = new WorldlineRunDatabase(init.databasePath)
    const persisted = this.persistedRuntimeState()
    const startedAt = new Date().toISOString()
    this.createdAt = persisted?.createdAt ?? startedAt
    this.updatedAt = persisted?.updatedAt ?? this.createdAt
    if (persisted !== undefined) {
      Object.assign(this.healthValue, persisted.health)
      this.idCounter = persisted.idCounter
      for (const [actorId, mode] of Object.entries(persisted.controls)) {
        this.controls.set(actorId, mode)
      }
    }
    for (const [actorId, mode] of Object.entries(init.controls ?? {})) {
      this.controls.set(actorId, mode)
    }
    const stored = this.database.snapshot()
    this.snapshotValue = init.resumeSnapshot ?? stored ?? this.initialSnapshot()
    if (this.snapshotValue.blueprintDigest !== init.blueprint.digest) {
      this.database.close()
      throw new WorldlineRuntimeError(
        'blueprint-not-frozen',
        'Run snapshot does not belong to the retained immutable Blueprint',
      )
    }
    this.database.initialize(this.snapshotValue)
    const storedStatus = this.database.meta('status')
    this.statusValue = storedStatus === 'stopped' || storedStatus === 'failed'
      ? storedStatus
      : init.startPaused === false ? 'running' : 'paused'
    this.database.setMeta('status', this.statusValue)
    this.database.setMeta('runtimeState', JSON.stringify(this.runtimeState()))
  }

  /** Perform close through the package's public contract.
   */
  close(): void {
    if (this.stopped) return
    this.statusValue = 'stopped'
    this.releaseStorage()
  }

  /** Flush the current state and close storage without changing the Run's status. */
  releaseStorage(): void {
    if (this.stopped) return
    this.commit([])
    this.stopped = true
    this.database.close()
  }

  /** Read view from the package-owned authoritative state.
   * @returns The result produced by the operation.
   */
  view(): RunView {
    return {
      summary: this.summary(),
      snapshot: structuredClone(this.snapshotValue),
      health: this.health(),
      aiUsage: this.snapshotValue.aiUsage,
      controls: Object.fromEntries(this.controls),
    }
  }

  /** Internal batch result; the worker never publishes this reference outside the current command. */
  private resultView(): RunView {
    if (!this.deferDatabaseCommit) return this.view()
    return {
      summary: this.summary(),
      snapshot: this.snapshotValue,
      health: this.health(false),
      aiUsage: this.snapshotValue.aiUsage,
      controls: Object.fromEntries(this.controls),
    }
  }

  /** Perform definition view through the package's public contract.
   * @returns The result produced by the operation.
   */
  definitionView(): RunDefinitionView {
    return {
      runId: this.snapshotValue.runId,
      blueprintDigest: this.init.blueprint.digest,
      purpose: structuredClone(this.init.blueprint.purpose),
      entities: this.init.blueprint.entities.map(entity => ({
        id: entity.id,
        type: entity.type,
        lod: entity.lod,
        policyIds: [...entity.policyIds],
      })),
      actions: structuredClone(this.init.blueprint.actions),
      systems: structuredClone(this.init.blueprint.systems),
      invariants: structuredClone(this.init.blueprint.invariants),
      plotPoints: structuredClone(this.init.blueprint.plotPoints ?? []),
    }
  }

  /** Perform spatial through the package's public contract.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  spatial(request: RunSpatialRequest): RunSpatialView {
    this.assertRun(request.runId)
    const availableMaps = this.init.blueprint.maps.map(map => ({
      id: map.id,
      name: map.name,
      nodeCount: map.nodes.length,
    }))
    const map = request.mapId === undefined
      ? this.init.blueprint.maps[0]
      : this.init.blueprint.maps.find(item => item.id === request.mapId)
    if (request.mapId !== undefined && map === undefined) {
      throw new WorldlineRuntimeError('action-invalid', `unknown Run map: ${request.mapId}`)
    }
    const base = {
      runId: this.snapshotValue.runId,
      sequence: this.snapshotValue.sequence,
      logicalTime: this.snapshotValue.logicalTime,
      availableMaps,
    }
    if (map === undefined) return { ...base, actors: [], movements: [] }

    const viewport = request.viewport
    if (viewport !== undefined && (
      ![viewport.left, viewport.top, viewport.right, viewport.bottom].every(Number.isFinite)
      || viewport.right < viewport.left
      || viewport.bottom < viewport.top
    )) {
      throw new WorldlineRuntimeError('action-invalid', 'Run map viewport must be finite and ordered')
    }
    const limit = Math.min(5_000, Math.max(50, Math.trunc(request.maxNodes ?? 1_500)))
    const visibleLayers = new Set(request.visibleLayerIds
      ?? map.layers.filter(layer => layer.visible).map(layer => layer.id))
    const candidates = map.nodes.filter(node => visibleLayers.has(node.layerId) && (viewport === undefined || (
      node.position.x >= viewport.left
      && node.position.x <= viewport.right
      && node.position.y >= viewport.top
      && node.position.y <= viewport.bottom
    )))
    const nodes = candidates.slice(0, limit)
    const nodeIds = new Set(nodes.map(node => node.id))
    const edges = map.edges.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    const allMapNodeIds = new Set(map.nodes.map(node => node.id))
    const entities = this.snapshotValue.state['entities']
    const actors = typeof entities !== 'object' || entities === null || Array.isArray(entities)
      ? []
      : Object.entries(entities).flatMap(([actorId, value]) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
        const state = value['state']
        const nodeId = typeof state === 'object' && state !== null && !Array.isArray(state)
          && typeof state['locationId'] === 'string'
          ? state['locationId'] as MapNodeId
          : undefined
        return nodeId !== undefined && nodeIds.has(nodeId)
          ? [{ actorId: worldlineId<'entity'>(actorId), nodeId }]
          : []
      })
    const movements = this.snapshotValue.processes.flatMap((process) => {
      const movement = process.movement
      if (movement === undefined || !movement.route.some(nodeId => allMapNodeIds.has(nodeId))) return []
      return [{
        processId: process.id,
        actorId: process.action.actorId,
        state: process.state,
        origin: movement.origin,
        destination: movement.destination,
        route: movement.route,
        edgeIndex: movement.edgeIndex,
        edgeFraction: movement.edgeFraction,
        remainingDuration: movement.remainingDuration,
        estimatedArrival: movement.estimatedArrival,
        mode: movement.mode,
      }]
    })
    const projection: RunSpatialView = {
      ...base,
      map: {
        id: map.id,
        name: map.name,
        rootNodeId: map.rootNodeId,
        ...(map.backgroundAssetId === undefined ? {} : { backgroundAssetId: map.backgroundAssetId }),
        layers: map.layers,
        nodes,
        edges,
        totalNodes: map.nodes.length,
        totalEdges: map.edges.length,
        truncated: candidates.length > nodes.length,
      },
      actors,
      movements,
    }
    return projection
  }

  /** Perform choices through the package's public contract.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  choices(request: RunChoicesRequest): RunChoicesView {
    this.assertRun(request.runId)
    const actor = this.entity(request.actorId)
    if (actor === undefined) {
      throw new WorldlineRuntimeError('action-invalid', `unknown actor: ${request.actorId}`)
    }
    const active = this.snapshotValue.processes.some(process => (
      process.action.actorId === request.actorId && !processTerminal(process.state)
    ))
    const choices = active ? [] : this.init.blueprint.actions
      .filter(definition => typeof actor['type'] === 'string'
        && definition.actorTypes.includes(actor['type']))
      .flatMap(definition => this.projectActionChoices(request.actorId, definition))
      .filter((choice) => {
        const definition = this.definition(choice.actionType)
        const targetId = targetEntityId(choice.parameters)
        return definition.preconditions.every(expression => evaluateScopedExpression(
          expression,
          this.snapshotValue.state,
          { actorId: request.actorId, ...(targetId === undefined ? {} : { targetId }) },
        ))
      })
    return {
      runId: request.runId,
      actorId: request.actorId,
      sequence: this.snapshotValue.sequence,
      choices,
    }
  }

  /** Perform summary through the package's public contract.
   * @returns The result produced by the operation.
   */
  summary(): RunSummary {
    return {
      runId: this.snapshotValue.runId,
      projectId: this.init.projectId,
      branchId: this.snapshotValue.branchId,
      blueprintDigest: this.snapshotValue.blueprintDigest,
      status: this.statusValue,
      logicalTime: this.snapshotValue.logicalTime,
      sequence: this.snapshotValue.sequence,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      ...(this.snapshotValue.parentRunId === undefined ? {} : { parentRunId: this.snapshotValue.parentRunId }),
      ...(this.snapshotValue.forkSequence === undefined ? {} : { forkSequence: this.snapshotValue.forkSequence }),
    }
  }

  /** Apply pause through the package's validated ownership boundary.
   * @returns The result produced by the operation.
   */
  pause(): RunView {
    this.assertLive()
    this.statusValue = 'paused'
    this.commit([])
    return this.resultView()
  }

  /** Apply resume through the package's validated ownership boundary.
   * @returns The result produced by the operation.
   */
  resume(): RunView {
    this.assertLive()
    this.statusValue = 'running'
    this.commit([])
    return this.view()
  }

  /** Apply advance through the package's validated ownership boundary.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  advance(request: AdvanceRunRequest): RunView {
    this.assertRun(request.runId)
    this.assertLive()
    if (this.statusValue === 'paused') throw new WorldlineRuntimeError('run-not-live', 'resume the Run before advancing time')
    if (!Number.isFinite(request.duration) || request.duration < 0) {
      throw new WorldlineRuntimeError('action-invalid', 'advance duration must be finite and non-negative')
    }
    const target = this.snapshotValue.logicalTime + request.duration
    const maximum = Math.min(100_000, Math.max(1, request.maxEvents ?? 10_000))
    const records: RunStreamRecord[] = []
    let processed = 0
    while (processed < maximum) {
      const next = this.sortedQueue()[0]
      if (next === undefined || next.due > target) break
      this.removeFuture(next.id)
      this.snapshotValue = this.withLogicalTime(next.due)
      const before = this.snapshotValue.sequence
      this.handleFuture(next, records)
      this.healthValue.noProgressSteps = this.snapshotValue.sequence === before
        ? this.healthValue.noProgressSteps + 1
        : 0
      processed += 1
      if (this.healthValue.noProgressSteps >= 1000) this.recoverLivelock(records)
    }
    const nextAfterAdvance = this.sortedQueue()[0]
    if (processed >= maximum && nextAfterAdvance !== undefined
      && nextAfterAdvance.due <= target) this.statusValue = 'degraded'
    else this.snapshotValue = this.withLogicalTime(target)
    records.push(this.telemetryRecord())
    this.commit(records)
    return this.resultView()
  }

  /** Run actor choices and time as one transaction per cycle; no model is consulted. */
  simulate(request: SimulateRunRequest): SimulateRunResult {
    this.assertRun(request.runId)
    this.assertLive()
    if (this.statusValue === 'paused') throw new WorldlineRuntimeError('run-not-live', 'resume the Run before simulating')
    const cycles = Math.trunc(request.cycles)
    if (!Number.isFinite(cycles) || cycles < 1 || cycles > 1_000) {
      throw new WorldlineRuntimeError('action-invalid', 'simulation cycles must be between 1 and 1000')
    }
    if (!Number.isFinite(request.stepDuration) || request.stepDuration <= 0) {
      throw new WorldlineRuntimeError('action-invalid', 'simulation step duration must be positive')
    }
    const actors = this.init.blueprint.entities.filter(entity => entity.type === 'character'
      && (this.controls.get(entity.id) ?? 'autonomous') === 'autonomous')
    const sampledActions: SimulateRunResult['sampledActions'][number][] = []
    const actionCounts: Record<string, number> = {}
    const actorActionCounts: Record<string, number> = Object.fromEntries(actors.map(item => [item.id, 0]))
    const transactionCycles = 25
    let before = this.snapshotValue
    let beforeHealth = structuredClone(this.healthValue)
    let beforeCounter = this.idCounter
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      if (cycle % transactionCycles === 0) {
        before = this.snapshotValue
        beforeHealth = structuredClone(this.healthValue)
        beforeCounter = this.idCounter
        this.deferDatabaseCommit = true
        this.deferredRecords = []
      }
      try {
        for (const [actorIndex, actor] of actors.entries()) {
          const projected = this.choices({ runId: request.runId, actorId: actor.id })
          const actionTypes = [...new Set(projected.choices.map(item => item.actionType))]
          const selectedType = request.preferredAction !== undefined
            && actionTypes.includes(request.preferredAction)
            ? request.preferredAction
            : actionTypes[(cycle + actorIndex) % Math.max(1, actionTypes.length)]
          const candidates = projected.choices.filter(item => item.actionType === selectedType)
          const choice = candidates[(cycle * Math.max(1, actors.length) + actorIndex)
            % Math.max(1, candidates.length)] ?? projected.choices[0]
          if (choice === undefined) continue
          const submitted = this.submitAction({
            runId: request.runId,
            actorId: actor.id,
            type: choice.actionType,
            parameters: choice.parameters,
            expectedSequence: projected.sequence,
            controller: 'agent',
          })
          actionCounts[choice.actionType] = (actionCounts[choice.actionType] ?? 0) + 1
          actorActionCounts[actor.id] = (actorActionCounts[actor.id] ?? 0) + 1
          if (sampledActions.length < 500) sampledActions.push({
            actorId: actor.id,
            actionType: choice.actionType,
            actionId: submitted.actionId,
          })
        }
        this.advance({ runId: request.runId, duration: request.stepDuration, maxEvents: 100_000 })
        if ((cycle + 1) % transactionCycles === 0 || cycle === cycles - 1) {
          const records = this.deferredRecords
          this.deferredRecords = []
          this.deferDatabaseCommit = false
          this.commit(records)
        }
      } catch (error) {
        this.snapshotValue = before
        Object.assign(this.healthValue, beforeHealth)
        this.idCounter = beforeCounter
        this.deferredRecords = []
        this.deferDatabaseCommit = false
        throw error
      }
    }
    return {
      view: this.view(),
      actorIds: actors.map(item => item.id),
      actionsPerformed: Object.values(actionCounts).reduce((sum, count) => sum + count, 0),
      actionCounts,
      actorActionCounts,
      sampledActions,
    }
  }

  /** Apply submit action through the package's validated ownership boundary.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  submitAction(request: SubmitRunActionRequest): SubmitRunActionResult {
    this.assertRun(request.runId)
    this.assertLive()
    if (request.expectedSequence !== this.snapshotValue.sequence) {
      throw new WorldlineRuntimeError('run-conflict', 'Run advanced after the action choices were projected')
    }
    const definition = this.init.blueprint.actions.find(action => action.id === request.type)
    if (definition === undefined) throw new WorldlineRuntimeError('action-invalid', `unknown action: ${request.type}`)
    const actor = this.entity(request.actorId)
    if (actor === undefined) throw new WorldlineRuntimeError('action-invalid', `unknown actor: ${request.actorId}`)
    const actorType = actor['type']
    if (typeof actorType !== 'string' || !definition.actorTypes.includes(actorType)) {
      throw new WorldlineRuntimeError('action-forbidden', 'the actor type cannot perform this action')
    }
    const control = this.controls.get(request.actorId) ?? 'autonomous'
    if (request.controller === 'player' && control !== 'player') {
      throw new WorldlineRuntimeError('action-forbidden', 'take control of the actor before submitting player actions')
    }
    if (request.controller === 'agent' && control === 'player') {
      throw new WorldlineRuntimeError('action-forbidden', 'autonomous actions are paused while the player has control')
    }
    const parameters = request.parameters ?? {}
    const targetId = targetEntityId(parameters)
    if (!definition.preconditions.every(expression => evaluateScopedExpression(
      expression,
      this.snapshotValue.state,
      { actorId: request.actorId, ...(targetId === undefined ? {} : { targetId }) },
    ))) {
      throw new WorldlineRuntimeError('action-forbidden', 'action preconditions are not satisfied')
    }
    if (definition.location?.mode === 'at') {
      const actorState = actor['state']
      const actorLocation = typeof actorState === 'object' && actorState !== null
        && !Array.isArray(actorState) && typeof actorState['locationId'] === 'string'
        ? worldlineId<'map-node'>(actorState['locationId'])
        : undefined
      if (actorLocation === undefined || !definition.location.nodeIds.includes(actorLocation)) {
        throw new WorldlineRuntimeError('action-forbidden', 'the action is not available at the actor location')
      }
    }
    if (this.snapshotValue.processes.some(process => (
      process.action.actorId === request.actorId && !processTerminal(process.state)
    ))) {
      throw new WorldlineRuntimeError('action-forbidden', 'actor already has an active process')
    }
    const actionId = worldlineId<'action'>(this.nextId('action'))
    const action: ActionRequest = {
      id: actionId,
      type: definition.id,
      actorId: request.actorId,
      targetIds: targetId === undefined ? [] : [targetId],
      parameters,
      requestedAt: this.snapshotValue.logicalTime,
      control: request.controller === 'player' ? 'player' : request.controller === 'system' ? 'director' : 'policy',
      idempotencyKey: `${this.snapshotValue.runId}:${String(this.snapshotValue.sequence + 1)}`,
    }
    let process: Process = {
      id: worldlineId<'process'>(this.nextId('process')),
      action,
      state: 'proposed',
      progress: 0,
      progressMeasure: Math.max(0, definition.duration),
      reservationIds: [],
      maxRetries: definition.maxRetries,
      retryCount: 0,
      wakeConditions: [],
      fallbacks: definition.fallbacks,
      deadline: this.snapshotValue.logicalTime + definition.maxWait,
    }
    this.putProcess(process)
    const records: RunStreamRecord[] = []
    const proposed = this.lifecycleEvent(process, definition, 'proposed')
    this.emitEvent(proposed, records)
    const decision: DecisionTrace = {
      id: worldlineId<'decision-trace'>(this.nextId('decision-trace')),
      logicalTime: this.snapshotValue.logicalTime,
      actorId: request.actorId,
      actionId,
      type: 'proposed',
      reason: `${request.controller} submitted a valid action intent`,
      details: { actionType: definition.id },
    }
    records.push(this.record('decision-trace', decision.id, decision, this.snapshotValue.sequence))
    process = this.admitOrWait(process, definition, records)
    this.resolveWaitCycles(records)
    this.commit(records)
    return { actionId, process, decision, view: this.resultView() }
  }

  /** Apply records through the package's validated ownership boundary.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  records(request: RunRecordsRequest): RunRecordsPage {
    this.assertRun(request.runId)
    const limit = Math.min(5000, Math.max(1, request.limit ?? 500))
    const records = this.database.records(
      request.afterSequence ?? -1,
      limit + 1,
      request.stream,
      request.afterOrdinal ?? -1,
      request.tail === true,
    )
    // Tail queries ask the database for one extra row as well. Keep the newest `limit`
    // rows instead of dropping the newest row from the reversed chronological window.
    const page = request.tail === true
      ? records.slice(Math.max(0, records.length - limit))
      : records.slice(0, limit)
    return {
      records: page,
      nextSequence: page.at(-1)?.sequence ?? request.afterSequence ?? -1,
      nextOrdinal: page.at(-1)?.ordinal ?? request.afterOrdinal ?? -1,
      hasMore: request.tail === true ? false : records.length > limit,
    }
  }

  /** Perform checkpoint through the package's public contract.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  checkpoint(request: CreateCheckpointRequest): CheckpointView {
    this.assertRun(request.runId)
    const checkpoint: Checkpoint = {
      id: worldlineId<'checkpoint'>(this.nextId('checkpoint')),
      runId: this.snapshotValue.runId,
      sequence: this.snapshotValue.sequence,
      createdAt: new Date().toISOString(),
      snapshot: structuredClone(this.snapshotValue),
      digest: createHash('sha256').update(stableStringify(this.snapshotValue)).digest('hex'),
    }
    this.database.saveCheckpoint(checkpoint, request.label)
    return { checkpoint, label: request.label, createdAt: checkpoint.createdAt }
  }

  /** Read checkpoints from the package-owned authoritative state.
   * @returns The result produced by the operation.
   */
  checkpoints(): readonly CheckpointView[] { return this.database.checkpoints() }

  /** Change an actor's control mode within the isolated Run kernel.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  setControl(request: SetActorControlRequest): RunView {
    this.assertRun(request.runId)
    if (this.entity(request.actorId) === undefined) {
      throw new WorldlineRuntimeError('action-invalid', `unknown actor: ${request.actorId}`)
    }
    this.controls.set(request.actorId, request.mode)
    this.commit([])
    return this.view()
  }

  /** Enable or disable AI participation inside the isolated Run kernel.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  setAiEnabled(request: SetAiEnabledRequest): RunView {
    this.assertRun(request.runId)
    this.snapshotValue = {
      ...this.snapshotValue,
      modelPolicy: { ...this.snapshotValue.modelPolicy, aiEnabled: request.enabled },
    }
    this.commit([])
    return this.view()
  }

  /** Perform switch model through the package's public contract.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  switchModel(request: SwitchModelPolicyRequest): RunView {
    this.assertRun(request.runId)
    if (request.expectedSequence !== this.snapshotValue.sequence) {
      throw new WorldlineRuntimeError('run-conflict', 'Run advanced before the model policy switch')
    }
    this.snapshotValue = { ...this.snapshotValue, modelPolicy: request.modelPolicy }
    this.commit([])
    return this.view()
  }

  /** Perform explain through the package's public contract.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  explain(request: ExplainRunEventRequest): RunEventExplanation {
    this.assertRun(request.runId)
    const all = this.database.records(-1, 5000)
    const row = all.find(item => item.stream === 'world-event' && item.id === request.eventId)
    const event = row?.payload as unknown as WorldEvent | undefined
    const actionId = event?.actionId
    return {
      ...(event === undefined ? {} : { event }),
      decisions: all.filter(item => item.stream === 'decision-trace')
        .map(item => item.payload as unknown as DecisionTrace)
        .filter(item => actionId !== undefined && item.actionId === actionId),
      processes: event?.processId === undefined
        ? []
        : this.snapshotValue.processes.filter(item => item.id === event.processId),
      reservations: event?.processId === undefined
        ? []
        : this.snapshotValue.reservations.filter(item => item.processId === event.processId),
      telemetry: all.filter(item => item.stream === 'telemetry')
        .map(item => item.payload as unknown as Telemetry).slice(-20),
      summary: event === undefined
        ? 'The requested event is not present in the retained ledger window.'
        : `${event.type} was committed by ${event.ruleId ?? event.actionId ?? 'the Runtime'} with ${String(event.deltas.length)} state deltas.`,
    }
  }

  /** Apply record ai intent through the package's validated ownership boundary.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  recordAiIntent(request: RecordAiIntentRequest): RecordAiIntentResult {
    this.assertRun(request.runId)
    this.assertLive()
    if (this.entity(request.actorId) === undefined) {
      throw new WorldlineRuntimeError('action-invalid', `unknown actor: ${request.actorId}`)
    }
    const invocationRow = this.database.record('ai-invocation', request.invocationId)
    const invocation = invocationRow?.payload as unknown as AiInvocation | undefined
    if (invocation === undefined || invocation.actorId !== request.actorId
      || stableStringify(invocation.modelRoute) !== stableStringify(request.modelRoute)) {
      throw new WorldlineRuntimeError('action-invalid', 'AI intent has no matching recorded invocation')
    }
    if (stableStringify(invocation.contextSourceIds) !== stableStringify(request.contextSourceIds)) {
      throw new WorldlineRuntimeError('action-invalid', 'AI intent does not match its invocation Context Pack')
    }
    const choice = this.choices(request).choices.find(item => item.id === request.choiceId)
    if (choice === undefined || choice.actionType !== request.actionType
      || stableStringify(choice.parameters) !== stableStringify(request.parameters)
      || !invocation.contextSourceIds.includes(choice.id)) {
      throw new WorldlineRuntimeError('action-invalid', 'AI intent is not a current projected legal choice')
    }
    const intent: AiIntent = {
      id: worldlineId<'intent'>(this.nextId('intent')),
      invocationId: request.invocationId,
      actorId: request.actorId,
      logicalTime: this.snapshotValue.logicalTime,
      choiceId: request.choiceId,
      actionType: request.actionType,
      parameters: request.parameters,
      rationale: request.rationale,
      confidence: Math.min(1, nonNegative(request.confidence)),
      modelRoute: request.modelRoute,
      contextSourceIds: request.contextSourceIds,
      recordedAt: new Date().toISOString(),
    }
    this.commit([this.record('ai-intent', intent.id, intent, this.snapshotValue.sequence)])
    return { intent, view: this.view() }
  }

  /** Apply record ai invocation through the package's validated ownership boundary.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  recordAiInvocation(request: RecordAiInvocationRequest): RecordAiInvocationResult {
    this.assertRun(request.runId)
    this.assertLive()
    if (request.actorId !== undefined && this.entity(request.actorId) === undefined) {
      throw new WorldlineRuntimeError('action-invalid', `unknown actor: ${request.actorId}`)
    }
    if (!/^[a-f0-9]{64}$/u.test(request.outputDigest)) {
      throw new WorldlineRuntimeError('action-invalid', 'AI invocation output digest must be lowercase SHA-256')
    }
    const invocation: AiInvocation = {
      id: worldlineId<'ai-invocation'>(this.nextId('ai-invocation')),
      purpose: request.purpose,
      ...(request.actorId === undefined ? {} : { actorId: request.actorId }),
      logicalTime: this.snapshotValue.logicalTime,
      modelRoute: request.modelRoute,
      contextSourceIds: request.contextSourceIds,
      inputTokens: nonNegative(request.inputTokens, true),
      outputTokens: nonNegative(request.outputTokens, true),
      cacheReadTokens: nonNegative(request.cacheReadTokens ?? 0, true),
      estimatedCost: nonNegative(request.estimatedCost),
      outputDigest: request.outputDigest,
      outcome: request.outcome,
      recordedAt: new Date().toISOString(),
    }
    const usage = {
      ...this.snapshotValue.aiUsage,
      calls: this.snapshotValue.aiUsage.calls + 1,
      inputTokens: this.snapshotValue.aiUsage.inputTokens + invocation.inputTokens,
      outputTokens: this.snapshotValue.aiUsage.outputTokens + invocation.outputTokens,
      cacheReadTokens: this.snapshotValue.aiUsage.cacheReadTokens + invocation.cacheReadTokens,
      estimatedCost: this.snapshotValue.aiUsage.estimatedCost + invocation.estimatedCost,
      cacheHits: this.snapshotValue.aiUsage.cacheHits + (invocation.cacheReadTokens > 0 ? 1 : 0),
    }
    this.snapshotValue = {
      ...this.snapshotValue,
      aiUsage: usage,
    }
    this.commit([this.record('ai-invocation', invocation.id, invocation, this.snapshotValue.sequence)])
    return { invocation, view: this.view() }
  }

  /** Apply record narrative beat through the package's validated ownership boundary.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  recordNarrativeBeat(request: RecordNarrativeBeatRequest): RecordNarrativeBeatResult {
    this.assertRun(request.runId)
    this.assertLive()
    if (request.text.trim() === '' || request.text.length > 100_000) {
      throw new WorldlineRuntimeError('action-invalid', 'narrative text must contain 1 to 100,000 characters')
    }
    const events = request.eventIds.map(id => this.database.record('world-event', id))
    const observations = request.observationIds.map(id => this.database.record('observation', id))
    if (events.some(item => item === undefined) || observations.some(item => item === undefined)) {
      throw new WorldlineRuntimeError('action-invalid', 'narrative references records outside this Run')
    }
    const invocationPayload = this.database.record('ai-invocation', request.invocationId)?.payload
    const invocation = invocationPayload as unknown as AiInvocation | undefined
    if (invocation === undefined || invocation.purpose !== 'narrator'
      || stableStringify(invocation.modelRoute) !== stableStringify(request.modelRoute)
      || invocation.outputDigest !== createHash('sha256').update(request.modelOutput).digest('hex')) {
      throw new WorldlineRuntimeError('action-invalid', 'narrative does not match its recorded narrator call')
    }
    const cited = [...request.eventIds, ...request.observationIds]
    if (cited.some(id => !invocation.contextSourceIds.includes(id))) {
      throw new WorldlineRuntimeError('action-invalid', 'narrative cites facts absent from its Context Pack')
    }
    const beat: NarrativeBeat = {
      id: worldlineId<'narrative-beat'>(this.nextId('narrative-beat')),
      invocationId: request.invocationId,
      perspectiveActorId: request.perspectiveActorId,
      eventIds: request.eventIds,
      observationIds: request.observationIds,
      camera: request.camera,
      ...(request.speakerId === undefined ? {} : { speakerId: request.speakerId }),
      text: request.text,
      blocks: request.blocks,
      media: request.media,
      modelRoute: request.modelRoute,
    }
    this.commit([this.record('narrative-beat', beat.id, beat, this.snapshotValue.sequence)])
    return { beat, view: this.view() }
  }

  /** Persist a monotonic, player-facing playback boundary without advancing world time. */
  completePresentation(request: CompletePresentationRequest): CompletePresentationResult {
    this.assertRun(request.runId)
    this.assertLive()
    const beatRecord = this.database.record('narrative-beat', request.beatId)
    if (beatRecord === undefined) {
      throw new WorldlineRuntimeError('action-invalid', 'presentation beat is not retained by this Run')
    }
    const previous = this.snapshotValue.presentationCursors[request.actorId]
    if (previous !== undefined) {
      const previousRecord = this.database.record('narrative-beat', previous.completedBeatId)
      if (previousRecord === undefined) {
        throw new WorldlineRuntimeError('worker-failed', 'presentation cursor references a missing beat')
      }
      const previousOrdinal = previousRecord.ordinal ?? -1
      const nextOrdinal = beatRecord.ordinal ?? -1
      if (beatRecord.sequence < previousRecord.sequence
        || (beatRecord.sequence === previousRecord.sequence && nextOrdinal < previousOrdinal)) {
        throw new WorldlineRuntimeError('action-invalid', 'presentation cursor cannot move backwards')
      }
    }
    const cursor = { actorId: request.actorId, completedBeatId: request.beatId } as const
    this.snapshotValue = {
      ...this.snapshotValue,
      presentationCursors: {
        ...this.snapshotValue.presentationCursors,
        [request.actorId]: cursor,
      },
    }
    this.commit([this.record(
      'presentation-progress',
      this.nextId('presentation-progress'),
      cursor,
      this.snapshotValue.sequence,
    )])
    return { cursor, view: this.view() }
  }

  /** Validate and persist the choice director's concrete action plans as the final story-turn step. */
  recordActionDeck(request: RecordActionDeckRequest): RecordActionDeckResult {
    this.assertRun(request.runId)
    this.assertLive()
    if (request.expectedSequence !== this.snapshotValue.sequence) {
      throw new WorldlineRuntimeError('run-conflict', 'Run advanced before the action deck was committed')
    }
    const beatRecord = this.database.record('narrative-beat', request.afterBeatId)
    if (beatRecord?.sequence !== this.snapshotValue.sequence) {
      throw new WorldlineRuntimeError(
        'action-forbidden',
        'action choices require a story beat committed at the current world sequence',
      )
    }
    if (this.snapshotValue.storyStateCommits[request.afterBeatId] === undefined) {
      throw new WorldlineRuntimeError(
        'action-forbidden',
        'action choices require the state-director turn to commit after the story beat',
      )
    }
    const invocationRecord = this.database.record('ai-invocation', request.invocationId)
    const invocation = invocationRecord?.payload as unknown as AiInvocation | undefined
    if (invocation === undefined || invocation.purpose !== 'creative'
      || invocation.actorId !== request.actorId
      || !invocation.contextSourceIds.includes(request.afterBeatId)) {
      throw new WorldlineRuntimeError(
        'action-invalid',
        'action deck does not match its retained choice-director invocation',
      )
    }
    const opportunities = this.choices(request).choices
    if (opportunities.length === 0) {
      throw new WorldlineRuntimeError('action-forbidden', 'the current scene exposes no legal capabilities')
    }
    if (request.plans.length !== 3) {
      throw new WorldlineRuntimeError('action-invalid', 'the choice director must produce exactly three plans')
    }
    const opportunityById = new Map(opportunities.map(item => [item.id, item]))
    const labels = new Set<string>()
    const intents = new Set<string>()
    const storyRoles = new Set<string>()
    const deckId = worldlineId<'action-deck'>(this.nextId('action-deck'))
    const plans = request.plans.map((draft) => {
      const opportunity = opportunityById.get(draft.opportunityId)
      if (opportunity === undefined) {
        throw new WorldlineRuntimeError('action-invalid', 'action plan references a stale capability opportunity')
      }
      const label = draft.label.trim()
      const intent = draft.intent.trim()
      const labelKey = label.normalize('NFKC').toLocaleLowerCase()
      const intentKey = intent.normalize('NFKC').toLocaleLowerCase()
      if (label.length < 4 || label.length > 64 || intent.length < 4 || intent.length > 240) {
        throw new WorldlineRuntimeError('action-invalid', 'action plan label or intent is outside its bound')
      }
      if (labels.has(labelKey) || intents.has(intentKey)) {
        throw new WorldlineRuntimeError('action-invalid', 'action plans must be semantically distinct')
      }
      labels.add(labelKey)
      intents.add(intentKey)
      if (storyRoles.has(draft.storyRole)) {
        throw new WorldlineRuntimeError('action-invalid', 'each action plan must serve a distinct story role')
      }
      storyRoles.add(draft.storyRole)
      return {
        id: worldlineId<'action-plan'>(this.nextId('action-plan')),
        actorId: request.actorId,
        opportunityId: opportunity.id,
        capabilityId: opportunity.actionType,
        parameters: { ...opportunity.parameters, storyIntent: intent },
        targetIds: opportunity.targetIds,
        label,
        intent,
        storyRole: draft.storyRole,
        estimatedDuration: opportunity.estimatedDuration,
        costs: opportunity.costs,
        risks: opportunity.risks,
      }
    })
    if (!['advance', 'character', 'deviate'].every(role => storyRoles.has(role))) {
      throw new WorldlineRuntimeError('action-invalid', 'action deck must cover advance, character, and deviate')
    }
    const deck = {
      id: deckId,
      actorId: request.actorId,
      sequence: this.snapshotValue.sequence,
      afterBeatId: request.afterBeatId,
      invocationId: request.invocationId,
      plans,
    } as const
    this.snapshotValue = {
      ...this.snapshotValue,
      actionDecks: { ...this.snapshotValue.actionDecks, [request.actorId]: deck },
    }
    this.commit([this.record('action-deck', deck.id, deck, this.snapshotValue.sequence)])
    return { deck, view: this.view() }
  }

  /** Apply schema-constrained soft state and perceived memories at the same stable story frontier. */
  recordStoryState(request: RecordStoryStateRequest): RecordStoryStateResult {
    this.assertRun(request.runId)
    this.assertLive()
    const retained = this.snapshotValue.storyStateCommits[request.beatId]
    if (retained !== undefined) {
      const progress = Object.values(this.snapshotValue.storyProgress)
        .find(item => item.beatId === request.beatId)
      return { commit: retained, ...(progress === undefined ? {} : { progress }), view: this.view() }
    }
    const beatRecord = this.database.record('narrative-beat', request.beatId)
    const beat = beatRecord?.payload as unknown as NarrativeBeat | undefined
    if (beat === undefined || beatRecord?.sequence !== this.snapshotValue.sequence) {
      throw new WorldlineRuntimeError(
        'action-invalid',
        'story state must be derived from a narrative beat at the current world frontier',
      )
    }
    const validateInvocation = (invocationId: AiInvocation['id'], subjectId?: string): AiInvocation => {
      const record = this.database.record('ai-invocation', invocationId)
      const invocation = record?.payload as unknown as AiInvocation | undefined
      if (invocation === undefined || invocation.purpose !== 'creative'
        || invocation.actorId !== beat.perspectiveActorId
        || !invocation.contextSourceIds.includes(request.beatId)
        || (subjectId !== undefined && !invocation.contextSourceIds.includes(subjectId))) {
        throw new WorldlineRuntimeError(
          'action-invalid',
          'story state does not match its retained state-director invocation',
        )
      }
      return invocation
    }
    const characterIds = this.init.blueprint.entities
      .filter(entity => entity.type === 'character')
      .map(entity => entity.id)
    if (request.shards.length !== 2) {
      throw new WorldlineRuntimeError(
        'action-invalid',
        'story state must include one world shard and one complete character-roster shard',
      )
    }
    const worldShards = request.shards.filter(shard => shard.domain === 'world')
    const characterShards = request.shards.filter(shard => shard.domain === 'characters')
    const characterShardIds = characterShards[0]?.subjectIds ?? []
    if (worldShards.length !== 1 || worldShards[0]?.subjectIds.length !== 0
      || characterShards.length !== 1 || characterShardIds.length !== characterIds.length
      || new Set(characterShardIds).size !== characterIds.length
      || characterIds.some(actorId => !characterShardIds.includes(actorId))) {
      throw new WorldlineRuntimeError(
        'action-invalid',
        'story state shards do not cover the complete world roster exactly once',
      )
    }
    for (const shard of request.shards) {
      validateInvocation(
        shard.invocationId,
        shard.domain === 'world' ? 'runtime:world-state-shard' : 'runtime:character-state-shard',
      )
      if (shard.mutations.some(mutation => shard.domain === 'world'
        ? mutation.scope !== 'world' || mutation.actorId !== undefined
        : mutation.scope !== 'character' || mutation.actorId === undefined
          || !shard.subjectIds.includes(mutation.actorId))
        || shard.memoryWrites.some(write => shard.domain !== 'characters'
          || !shard.subjectIds.includes(write.actorId))) {
        throw new WorldlineRuntimeError('action-invalid', 'story state shard crossed its subject boundary')
      }
    }
    const mutations = request.shards.flatMap(shard => shard.mutations)
    const memoryWriteDrafts = request.shards.flatMap(shard => shard.memoryWrites)
    const mutationKeys = mutations.map(mutation => (
      mutation.scope === 'world'
        ? `world:${mutation.path}`
        : `character:${mutation.actorId ?? ''}:${mutation.path}`
    ))
    if (new Set(mutationKeys).size !== mutationKeys.length) {
      throw new WorldlineRuntimeError('action-invalid', 'story state proposed the same path more than once')
    }
    let progress: StoryProgressEvidence | undefined
    if (request.progress !== undefined) {
      const points = [...(this.init.blueprint.plotPoints ?? [])]
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      const current = points.find(point => this.snapshotValue.storyProgress[point.id]?.status !== 'completed')
      if (current === undefined || current.id !== request.progress.pointId) {
        throw new WorldlineRuntimeError('action-forbidden', 'state director may only assess the current plot point')
      }
      const progressInvocation = validateInvocation(request.progress.invocationId, current.id)
      if (!progressInvocation.contextSourceIds.includes(current.id)) {
        throw new WorldlineRuntimeError(
          'action-invalid',
          'story progress point was absent from the state-director context',
        )
      }
      const rationale = request.progress.rationale.trim()
      const evidence = request.progress.evidence.map(item => item.trim()).filter(Boolean)
      const eventIds = [...new Set(request.progress.eventIds)]
      const observationIds = [...new Set(request.progress.observationIds)]
      if (!['active', 'completed', 'failed'].includes(request.progress.status)
        || rationale.length < 8 || rationale.length > 2_000
        || evidence.length < 1 || evidence.length > 8
        || evidence.some(item => item.length < 3 || item.length > 800)
        || eventIds.some(id => !beat.eventIds.includes(id))
        || observationIds.some(id => !beat.observationIds.includes(id))) {
        throw new WorldlineRuntimeError('action-invalid', 'story progress evidence is invalid')
      }
      progress = {
        id: worldlineId<'story-progress'>(this.nextId('story-progress')),
        pointId: current.id,
        sequence: this.snapshotValue.sequence,
        beatId: request.beatId,
        invocationId: request.progress.invocationId,
        status: request.progress.status,
        rationale,
        evidence,
        eventIds,
        observationIds,
      }
    } else if ((this.init.blueprint.plotPoints ?? []).some(point => (
      this.snapshotValue.storyProgress[point.id]?.status !== 'completed'
    ))) {
      throw new WorldlineRuntimeError('action-invalid', 'state director omitted the current plot assessment')
    }
    if (mutations.length > 64 || memoryWriteDrafts.length > 32) {
      throw new WorldlineRuntimeError('action-invalid', 'story state proposal exceeds its bounded size')
    }
    const observations = beat.observationIds.map(id => (
      this.database.record('observation', id)?.payload as unknown as Observation | undefined
    ))
    const perspectiveLocation = this.entity(beat.perspectiveActorId)?.['state']
    const perspectiveLocationId = typeof perspectiveLocation === 'object'
      && perspectiveLocation !== null && !Array.isArray(perspectiveLocation)
      && typeof perspectiveLocation['locationId'] === 'string'
      ? perspectiveLocation['locationId'] : undefined
    const perceivedActors = new Set<EntityId>([
      beat.perspectiveActorId,
      ...observations.flatMap(item => item === undefined ? [] : [item.observerId]),
      ...beat.blocks.flatMap(block => block.type === 'character' ? [block.actorId] : []),
      ...this.init.blueprint.entities.flatMap(entity => entity.type === 'character'
        && perspectiveLocationId !== undefined
        && entity.state['locationId'] === perspectiveLocationId ? [entity.id] : []),
    ])
    let state = this.snapshotValue.state
    const deltas: StateDelta[] = []
    for (const mutation of mutations) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*){0,5}$/u.test(mutation.path)) {
        throw new WorldlineRuntimeError('action-invalid', 'story state path is malformed')
      }
      let schema: JsonValue | undefined
      let absolutePath: string
      if (mutation.scope === 'character') {
        if (mutation.actorId === undefined) {
          throw new WorldlineRuntimeError('action-invalid', 'character story state requires actorId')
        }
        const actor = this.init.blueprint.entities.find(item => item.id === mutation.actorId)
        if (actor === undefined || actor.type !== 'character') {
          throw new WorldlineRuntimeError('action-forbidden', 'story state may only update characters')
        }
        schema = actor.facets['stateSchema']
        absolutePath = `entities.${escapePathSegment(mutation.actorId)}.state.${mutation.path}`
      } else {
        if (mutation.actorId !== undefined) {
          throw new WorldlineRuntimeError('action-invalid', 'world story state must not contain actorId')
        }
        if (mutation.path === 'time' || mutation.path.startsWith('time.')
          || mutation.path === 'calendar' || mutation.path.startsWith('calendar.')) {
          throw new WorldlineRuntimeError('action-forbidden', 'story state cannot modify Runtime time')
        }
        schema = this.snapshotValue.state['worldStateSchema']
        absolutePath = `world.${mutation.path}`
      }
      const field = typeof schema === 'object' && schema !== null && !Array.isArray(schema)
        ? schema[mutation.path]
        : undefined
      if (typeof field !== 'object' || field === null || Array.isArray(field)
        || field['mutable'] !== true || typeof field['type'] !== 'string') {
        throw new WorldlineRuntimeError(
          'action-forbidden',
          `story state path is not declared mutable: ${mutation.path}`,
        )
      }
      const reason = mutation.reason.trim()
      if (reason.length < 4 || reason.length > 240) {
        throw new WorldlineRuntimeError('action-invalid', 'story state mutation reason is outside its bound')
      }
      const before = getPath(state, absolutePath)
      let after: JsonValue
      if (mutation.operation === 'increment') {
        if (field['type'] !== 'number' || typeof before !== 'number'
          || typeof mutation.value !== 'number' || !Number.isFinite(mutation.value)) {
          throw new WorldlineRuntimeError('action-invalid', 'increment requires a declared numeric field')
        }
        const minimum = typeof field['minimum'] === 'number' ? field['minimum'] : -Number.MAX_SAFE_INTEGER
        const maximum = typeof field['maximum'] === 'number' ? field['maximum'] : Number.MAX_SAFE_INTEGER
        after = Math.min(maximum, Math.max(minimum, before + mutation.value))
      } else if (mutation.operation === 'append' || mutation.operation === 'remove') {
        if (field['type'] !== 'array' || !Array.isArray(before)) {
          throw new WorldlineRuntimeError('action-invalid', 'append/remove requires a declared array field')
        }
        after = mutation.operation === 'append'
          ? [...before, mutation.value].slice(-100)
          : before.filter(item => stableStringify(item) !== stableStringify(mutation.value))
      } else {
        const typeMatches = field['type'] === 'string' ? typeof mutation.value === 'string'
          : field['type'] === 'number' ? typeof mutation.value === 'number' && Number.isFinite(mutation.value)
            : field['type'] === 'boolean' ? typeof mutation.value === 'boolean'
              : field['type'] === 'array' ? Array.isArray(mutation.value)
                : field['type'] === 'object' ? typeof mutation.value === 'object'
                  && mutation.value !== null && !Array.isArray(mutation.value)
                  : false
        if (!typeMatches) {
          throw new WorldlineRuntimeError('action-invalid', 'story state value does not match its schema')
        }
        after = mutation.value
      }
      if (stableStringify(before) === stableStringify(after)) continue
      state = setPath(state, absolutePath, after)
      deltas.push(stateDelta(absolutePath, before, after))
    }
    const invariantFailures = this.invariantFailures(state)
    if (invariantFailures.length > 0) {
      throw new WorldlineRuntimeError(
        'action-forbidden',
        `story state violates world invariants: ${invariantFailures.map(item => item.invariantId).join(', ')}`,
      )
    }
    const memoryWrites = memoryWriteDrafts.map((write) => {
      const actor = this.init.blueprint.entities.find(item => item.id === write.actorId)
      if (!perceivedActors.has(write.actorId) || actor?.type !== 'character') {
        throw new WorldlineRuntimeError('action-forbidden', 'story memory may only update perceived characters')
      }
      const summary = write.summary.trim()
      if (summary.length < 4 || summary.length > 500
        || !Number.isFinite(write.importance) || write.importance < 0 || write.importance > 1) {
        throw new WorldlineRuntimeError('action-invalid', 'story memory write is outside its bound')
      }
      return { actorId: write.actorId, summary, importance: write.importance }
    })
    this.snapshotValue = { ...this.snapshotValue, state }
    for (const write of memoryWrites) {
      const memory = this.characterMemory(write.actorId)
      const actorState = this.entity(write.actorId)?.['state']
      const placeId = typeof actorState === 'object' && actorState !== null && !Array.isArray(actorState)
        && typeof actorState['locationId'] === 'string'
        ? worldlineId<'map-node'>(actorState['locationId'])
        : undefined
      this.setCharacterMemory(write.actorId, {
        ...memory,
        episodic: [...memory.episodic, {
          id: worldlineId<'memory'>(this.nextId('memory')),
          actorId: write.actorId,
          logicalTime: this.snapshotValue.logicalTime,
          sourceEventIds: beat.eventIds,
          importance: write.importance,
          summary: write.summary,
          participants: [...perceivedActors],
          ...(placeId === undefined ? {} : { placeId }),
        }].slice(-MEMORY_CATEGORY_LIMIT),
      })
    }
    const commit: StoryStateCommit = {
      id: worldlineId<'story-state'>(this.nextId('story-state')),
      sequence: this.snapshotValue.sequence,
      beatId: request.beatId,
      shards: request.shards,
      ...(request.progress === undefined ? {} : {
        progressInvocationId: request.progress.invocationId,
      }),
      mutations,
      memoryWrites,
      deltas,
    }
    this.snapshotValue = {
      ...this.snapshotValue,
      storyStateCommits: {
        ...this.snapshotValue.storyStateCommits,
        [request.beatId]: commit,
      },
      ...(progress === undefined ? {} : {
        storyProgress: { ...this.snapshotValue.storyProgress, [progress.pointId]: progress },
      }),
    }
    this.commit([
      this.record('story-state', commit.id, commit, this.snapshotValue.sequence),
      ...(progress === undefined ? [] : [this.record(
        'story-progress',
        progress.id,
        progress,
        this.snapshotValue.sequence,
      )]),
    ])
    return { commit, ...(progress === undefined ? {} : { progress }), view: this.view() }
  }

  private initialSnapshot(): RunSnapshot {
    const systemEvents: FutureEvent[] = this.init.blueprint.systems.map((system, index) => ({
      id: `future:${contentFingerprint(`${this.init.runId}:${system.id}:initial`)}`,
      due: Math.max(0, system.nextWake),
      order: index,
      kind: 'system-wake',
      payload: { systemId: system.id },
      dedupeKey: `system:${system.id}`,
    }))
    const plotEvents: FutureEvent[] = (this.init.blueprint.plotPoints ?? []).flatMap((point, pointIndex) => ([{
      id: `future:${contentFingerprint(`${this.init.runId}:${point.id}:activate`)}`,
      due: point.timing.activateAt,
      order: systemEvents.length + pointIndex * 100,
      kind: 'plot-time-control',
      payload: { pointId: point.id, phase: 'activate', priority: 20 },
      dedupeKey: `plot:${point.id}:activate`,
    }, ...point.timing.interventions.map((intervention, interventionIndex) => ({
      id: `future:${contentFingerprint(`${this.init.runId}:${intervention.id}`)}`,
      due: intervention.at,
      order: systemEvents.length + pointIndex * 100 + interventionIndex + 1,
      kind: 'plot-time-control',
      payload: {
        pointId: point.id,
        phase: 'intervention',
        interventionId: intervention.id,
        priority: 30,
      },
      dedupeKey: `plot:${intervention.id}`,
    })), {
      id: `future:${contentFingerprint(`${this.init.runId}:${point.id}:deadline`)}`,
      due: point.timing.deadlineAt,
      order: systemEvents.length + pointIndex * 100 + point.timing.interventions.length + 1,
      kind: 'plot-time-control',
      payload: { pointId: point.id, phase: 'deadline', priority: 40 },
      dedupeKey: `plot:${point.id}:deadline`,
    }]))
    const futureEvents = [...systemEvents, ...plotEvents]
    return {
      runId: this.init.runId,
      blueprintId: this.init.blueprint.id,
      blueprintDigest: this.init.blueprint.digest,
      branchId: this.init.blueprint.worldlineId,
      ...(this.init.parentRunId === undefined ? {} : { parentRunId: this.init.parentRunId }),
      ...(this.init.forkSequence === undefined ? {} : { forkSequence: this.init.forkSequence }),
      seed: this.init.seed,
      logicalTime: 0,
      sequence: 0,
      state: materializeInitialWorldState(
        this.init.blueprint.canon,
        this.init.blueprint.entities,
      ),
      processes: [],
      reservations: [],
      futureEvents,
      randomState: createHash('sha256').update(this.init.seed).digest('hex'),
      modelPolicy: this.init.modelPolicy ?? this.init.blueprint.modelPolicy,
      aiUsage: {
        calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        estimatedCost: 0, cacheHits: 0,
      },
      presentationCursors: {},
      actionDecks: {},
      storyProgress: {},
      storyStateCommits: {},
    }
  }

  private admitOrWait(
    process: Process,
    definition: ActionDefinition,
    records: RunStreamRecord[],
  ): Process {
    if (definition.operator === 'move') return this.startMovement(process, definition, records)
    if (definition.operator === 'teleport') return this.teleport(process, definition, records)
    const claims = this.claimsFor(process, definition)
    const blockers = this.blockers(claims)
    if (blockers.length > 0) return this.wait(process, definition, blockers, records)
    const reservation = this.reserve(process, claims)
    const { blockedReason: _blockedReason, ...unblocked } = process
    const started: Process = {
      ...unblocked,
      state: 'started',
      startedAt: this.snapshotValue.logicalTime,
      nextWakeAt: this.snapshotValue.logicalTime + definition.duration,
      progressMeasure: definition.duration,
      reservationIds: reservation === undefined ? [] : [reservation.id],
      wakeConditions: [],
    }
    this.putProcess(started)
    this.emitEvent(this.lifecycleEvent(started, definition, 'started'), records)
    if (started.nextWakeAt === undefined) throw new Error('started action has no completion time')
    this.schedule('action-complete', started.nextWakeAt, { processId: started.id })
    return started
  }

  private wait(
    process: Process,
    definition: ActionDefinition,
    blockers: readonly ProcessId[],
    records: RunStreamRecord[],
  ): Process {
    const now = this.snapshotValue.logicalTime
    if (process.deadline !== undefined && now >= process.deadline) {
      return this.failProcess(process, definition, 'resource wait deadline exceeded', records)
    }
    if (process.retryCount >= process.maxRetries) {
      return this.failProcess(process, definition, 'maximum resource retries reached', records)
    }
    const delay = Math.min(300, 5 * (2 ** process.retryCount))
    const waiting: Process = {
      ...process,
      state: 'admitted',
      nextWakeAt: now + delay,
      retryCount: process.retryCount + 1,
      blockedReason: `waiting for ${blockers.join(', ')}`,
      wakeConditions: blockers,
    }
    this.putProcess(waiting)
    this.schedule('reservation-retry', now + delay, {
      processId: waiting.id,
      priority: Math.floor(now - waiting.action.requestedAt),
    }, `retry:${waiting.id}`)
    const trace: DecisionTrace = {
      id: worldlineId<'decision-trace'>(this.nextId('decision-trace')),
      logicalTime: now,
      actorId: process.action.actorId,
      actionId: process.action.id,
      type: 'waiting',
      reason: waiting.blockedReason ?? 'waiting for resources',
      details: { blockers: [...blockers] },
    }
    records.push(this.record('decision-trace', trace.id, trace, this.snapshotValue.sequence))
    return waiting
  }

  private startMovement(
    process: Process,
    definition: ActionDefinition,
    records: RunStreamRecord[],
  ): Process {
    const destination = process.action.parameters['destination']
    if (typeof destination !== 'string') {
      return this.failProcess(process, definition, 'movement requires a destination node', records)
    }
    const actor = this.entity(process.action.actorId)
    const state = actor?.['state']
    const origin = typeof state === 'object' && state !== null && !Array.isArray(state)
      ? state['locationId']
      : undefined
    if (typeof origin !== 'string') {
      return this.failProcess(process, definition, 'actor has no map location', records)
    }
    const planned = this.planMovement(origin as MapNodeId, destination as MapNodeId)
    if (planned === undefined || planned.route.length < 2 || planned.edges.some(edge => edge.baseDuration <= 0)) {
      return this.failProcess(process, definition, 'no positive-duration route connects origin and destination', records)
    }
    const claims = this.movementClaims(process, definition, planned)
    const blockers = this.blockers(claims, process.action.actorId)
    if (blockers.length > 0) return this.wait(process, definition, blockers, records)
    const reservation = this.reserve(process, claims)
    const movement: MovementProgress = {
      origin: origin as MapNodeId,
      destination: destination as MapNodeId,
      route: planned.route,
      edgeIndex: 0,
      edgeFraction: 0,
      departedAt: this.snapshotValue.logicalTime,
      estimatedArrival: this.snapshotValue.logicalTime + planned.duration,
      remainingDuration: planned.duration,
      mode: typeof process.action.parameters['mode'] === 'string'
        ? process.action.parameters['mode']
        : 'walk',
    }
    const firstEdge = planned.edges[0]
    if (firstEdge === undefined) throw new Error('movement route has no traversable edge')
    const started: Process = {
      ...process,
      state: 'started',
      startedAt: this.snapshotValue.logicalTime,
      nextWakeAt: this.snapshotValue.logicalTime + firstEdge.baseDuration,
      progressMeasure: planned.duration,
      reservationIds: reservation === undefined ? [] : [reservation.id],
      wakeConditions: [],
      movement,
    }
    this.putProcess(started)
    this.emitEvent(this.lifecycleEvent(started, definition, 'started'), records)
    let due = this.snapshotValue.logicalTime
    planned.edges.forEach((edge, edgeIndex) => {
      due += edge.baseDuration
      this.schedule('movement-edge', due, { processId: started.id, edgeIndex })
    })
    return started
  }

  private teleport(
    process: Process,
    definition: ActionDefinition,
    records: RunStreamRecord[],
  ): Process {
    const destination = process.action.parameters['destination']
    if (typeof destination !== 'string' || !this.init.blueprint.maps.some(map => map.nodes.some(node => node.id === destination))) {
      return this.failProcess(process, definition, 'teleport destination does not exist', records)
    }
    const path = `entities.${escapePathSegment(process.action.actorId)}.state.locationId`
    const before = getPath(this.snapshotValue.state, path)
    const state = setPath(this.snapshotValue.state, path, destination)
    const completed: Process = { ...process, state: 'completed', startedAt: this.snapshotValue.logicalTime, progress: 1 }
    this.snapshotValue = { ...this.snapshotValue, state }
    this.putProcess(completed)
    this.emitEvent(this.lifecycleEvent(
      completed,
      definition,
      'completed',
      [stateDelta(path, before, destination)],
    ), records)
    return completed
  }

  private handleFuture(future: FutureEvent, records: RunStreamRecord[]): void {
    const systemId = future.payload['systemId']
    const processId = future.payload['processId']
    if (future.kind === 'system-wake' && typeof systemId === 'string') {
      this.runSystem(systemId, records)
    }
    if (future.kind === 'action-complete' && typeof processId === 'string') {
      this.completeAction(processId, records)
    }
    if (future.kind === 'reservation-retry' && typeof processId === 'string') {
      this.retryProcess(processId, records)
    }
    if (future.kind === 'movement-edge') {
      if (typeof processId !== 'string') throw new Error('movement event has no process ID')
      this.advanceMovement(processId, Number(future.payload['edgeIndex']), records)
    }
    if (future.kind === 'plot-time-control') this.runPlotTimeControl(future, records)
  }

  private runPlotTimeControl(future: FutureEvent, records: RunStreamRecord[]): void {
    const pointId = future.payload['pointId']
    const phase = future.payload['phase']
    if (typeof pointId !== 'string' || typeof phase !== 'string'
      || !['activate', 'intervention', 'deadline'].includes(phase)) return
    const point = this.init.blueprint.plotPoints?.find(candidate => candidate.id === pointId)
    if (point === undefined || this.snapshotValue.storyProgress[point.id]?.status === 'completed') return
    const interventionId = future.payload['interventionId']
    const intervention = typeof interventionId === 'string'
      ? point.timing.interventions.find(candidate => candidate.id === interventionId)
      : undefined
    const title = phase === 'activate' ? `剧情阶段已激活：${point.name}`
      : phase === 'deadline' ? `剧情截止已到：${point.name}`
        : intervention?.title ?? `剧情时间干预：${point.name}`
    const description = phase === 'activate' ? point.entryCondition
      : phase === 'deadline' ? point.failureOutcome
        : intervention?.description ?? point.dramaticPressure
    const participants = this.init.blueprint.entities
      .filter(entity => entity.type === 'character').map(entity => entity.id)
    this.emitEvent(this.worldEvent({
      type: phase === 'deadline' ? 'story.deadline' : 'story.intervention',
      participantIds: participants,
      ruleId: point.id,
      deltas: [],
      persistentFacts: [{
        subject: point.id,
        predicate: phase === 'deadline' ? 'deadline-reached' : 'time-intervention-reached',
        object: intervention?.id ?? phase,
        title,
        description,
        at: this.snapshotValue.logicalTime,
      }],
      cognitionChanges: [],
      provenance: point.provenance,
      data: {
        pointId: point.id,
        phase,
        title,
        description,
        deadlineAt: point.timing.deadlineAt,
      },
    }), records)
  }

  private runSystem(id: string, records: RunStreamRecord[]): void {
    const system = this.init.blueprint.systems.find(item => item.id === id)
    if (system === undefined) return
    if (system.preconditions.every(expression => evaluateScopedExpression(
      expression,
      this.snapshotValue.state,
      {},
    ))) {
      const applied = this.applyEffects(system.effects)
      const invariantFailures = this.invariantFailures(applied.state)
      if (invariantFailures.length === 0) {
        this.snapshotValue = { ...this.snapshotValue, state: applied.state }
        if (applied.deltas.length > 0 || applied.cognitionChanges.length > 0) {
          const event = this.worldEvent({
            type: 'system.effects-committed',
            participantIds: [],
            ruleId: system.id,
            deltas: applied.deltas,
            cognitionChanges: applied.cognitionChanges,
            provenance: system.provenance,
            data: {},
          })
          this.emitEvent(event, records)
        }
      } else {
        this.statusValue = 'degraded'
        records.push(this.record('runtime-diagnostic', this.nextId('runtime-diagnostic'), {
          type: 'system.effects-rejected',
          systemId: system.id,
          failures: invariantFailures,
        }, this.snapshotValue.sequence))
      }
    }
    if (system.interval !== undefined && system.interval > 0) {
      this.schedule('system-wake', this.snapshotValue.logicalTime + system.interval, { systemId: system.id }, `system:${system.id}`)
    }
  }

  private completeAction(processId: string, records: RunStreamRecord[]): void {
    const process = this.process(processId)
    if (process === undefined || processTerminal(process.state)) return
    const definition = this.definition(process.action.type)
    const targetId = targetEntityId(process.action.parameters)
    const applied = this.applyEffects(definition.effects, process.action.actorId, targetId)
    const invariantFailures = this.invariantFailures(applied.state)
    if (invariantFailures.length > 0) {
      records.push(this.record('runtime-diagnostic', this.nextId('runtime-diagnostic'), {
        type: 'action.effects-rejected',
        actionId: process.action.id,
        actorId: process.action.actorId,
        failures: invariantFailures,
      }, this.snapshotValue.sequence))
      this.failProcess(
        process,
        definition,
        `动作效果违反不变量：${invariantFailures.map(item => item.invariantId).join('、')}`,
        records,
      )
      return
    }
    this.snapshotValue = { ...this.snapshotValue, state: applied.state }
    const completed: Process = { ...process, state: 'completed', progress: 1 }
    this.release(process.id)
    this.putProcess(completed)
    this.emitEvent(this.lifecycleEvent(completed, definition, 'completed', applied.deltas, applied.cognitionChanges), records)
  }

  private retryProcess(processId: string, records: RunStreamRecord[]): void {
    const process = this.process(processId)
    if (process === undefined || process.state !== 'admitted') return
    this.healthValue.fairnessInterventions += 1
    this.admitOrWait(process, this.definition(process.action.type), records)
  }

  private advanceMovement(processId: string, edgeIndex: number, records: RunStreamRecord[]): void {
    const process = this.process(processId)
    if (process?.movement === undefined || processTerminal(process.state)) return
    if (edgeIndex !== process.movement.edgeIndex) return
    const node = process.movement.route[edgeIndex + 1]
    if (node === undefined) return
    const path = `entities.${escapePathSegment(process.action.actorId)}.state.locationId`
    const before = getPath(this.snapshotValue.state, path)
    const state = setPath(this.snapshotValue.state, path, node)
    const completed = edgeIndex === process.movement.route.length - 2
    const elapsed = this.snapshotValue.logicalTime - process.movement.departedAt
    const next: Process = {
      ...process,
      state: completed ? 'completed' : 'progressing',
      progress: Math.min(1, elapsed / Math.max(1, process.progressMeasure)),
      ...(completed ? {} : {
        nextWakeAt: this.sortedQueue()
          .find(item => item.kind === 'movement-edge' && item.payload['processId'] === process.id)?.due
          ?? process.movement.estimatedArrival,
      }),
      movement: {
        ...process.movement,
        edgeIndex: completed ? edgeIndex : edgeIndex + 1,
        edgeFraction: completed ? 1 : 0,
        remainingDuration: Math.max(0, process.movement.estimatedArrival - this.snapshotValue.logicalTime),
      },
    }
    this.snapshotValue = { ...this.snapshotValue, state }
    if (completed) this.release(process.id)
    this.wakeWaitingProcesses()
    this.putProcess(next)
    const definition = this.definition(process.action.type)
    this.emitEvent(this.lifecycleEvent(
      next,
      definition,
      completed ? 'completed' : 'progressing',
      [stateDelta(path, before, node)],
    ), records)
  }

  private applyEffects(
    effects: readonly Effect[],
    actorId?: EntityId,
    targetId?: EntityId,
  ): EffectResult {
    return applyWorldlineEffects(this.snapshotValue.state, effects, {
      ...(actorId === undefined ? {} : { actorId }),
      ...(targetId === undefined ? {} : { targetId }),
    })
  }

  private invariantFailures(state: JsonObject): readonly InvariantEvaluationFailure[] {
    return evaluateWorldlineInvariants(
      this.init.blueprint.invariants,
      this.init.blueprint.entities,
      state,
    )
  }

  private lifecycleEvent(
    process: Process,
    definition: ActionDefinition,
    milestone: Process['state'],
    deltas: readonly StateDelta[] = [],
    cognitionChanges: readonly JsonObject[] = [],
  ): WorldEvent {
    return this.worldEvent({
      type: `action.${milestone}`,
      actorId: process.action.actorId,
      participantIds: [process.action.actorId, ...process.action.targetIds]
        .filter((id, index, values) => values.indexOf(id) === index),
      actionId: process.action.id,
      processId: process.id,
      ruleId: definition.id,
      deltas,
      cognitionChanges,
      processMilestone: milestone,
      provenance: definition.provenance,
      data: { actionType: definition.id },
    })
  }

  private worldEvent(input: Omit<WorldEvent, 'id' | 'sequence' | 'logicalTime' | 'causedBy' | 'persistentFacts' | 'visibleTo'> & {
    readonly persistentFacts?: WorldEvent['persistentFacts']
  }): WorldEvent {
    return {
      id: worldlineId<'event'>(this.nextId('event')),
      sequence: this.snapshotValue.sequence + 1,
      logicalTime: this.snapshotValue.logicalTime,
      causedBy: [],
      persistentFacts: [],
      visibleTo: input.participantIds,
      ...input,
    }
  }

  private emitEvent(event: WorldEvent, records: RunStreamRecord[]): void {
    if (!isValidWorldEvent(event)) throw new Error(`invalid authoritative WorldEvent: ${event.type}`)
    this.snapshotValue = { ...this.snapshotValue, sequence: event.sequence }
    records.push(this.record('world-event', event.id, event, event.sequence))
    for (const participant of event.participantIds) {
      if (this.entity(participant as EntityId) === undefined) continue
      const observation: Observation = {
        id: worldlineId<'observation'>(this.nextId('observation')),
        observerId: participant as EntityId,
        eventId: event.id,
        logicalTime: event.logicalTime,
        channel: 'direct',
        confidence: 1,
        perceived: { type: event.type, data: event.data },
      }
      records.push(this.record('observation', observation.id, observation, event.sequence))
      this.rememberObservation(participant as EntityId, event, observation)
    }
    this.rememberCognition(event)
  }

  private rememberObservation(actorId: EntityId, event: WorldEvent, observation: Observation): void {
    if (event.processMilestone !== 'completed' && event.processMilestone !== 'failed'
      && event.processMilestone !== 'cancelled') return
    const memory = this.characterMemory(actorId)
    const actor = this.entity(actorId)
    const state = actor?.['state']
    const locationId = typeof state === 'object' && state !== null && !Array.isArray(state)
      && typeof state['locationId'] === 'string'
      ? worldlineId<'map-node'>(state['locationId'])
      : undefined
    const participants = event.participantIds
      .filter(id => this.entity(worldlineId<'entity'>(id)) !== undefined)
      .map(id => worldlineId<'entity'>(id))
    const perceivedType = observation.perceived['type']
    const actionType = event.data['actionType']
    const episodic = [...memory.episodic, {
      id: worldlineId<'memory'>(this.nextId('memory')),
      actorId,
      logicalTime: event.logicalTime,
      sourceEventIds: [event.id],
      importance: event.processMilestone === 'completed' || event.processMilestone === 'failed' ? 0.8 : 0.4,
      summary: typeof perceivedType === 'string' ? perceivedType : event.type,
      participants,
      ...(locationId === undefined ? {} : { placeId: locationId }),
    }].slice(-MEMORY_CATEGORY_LIMIT)
    const experience = event.actionId !== undefined
      ? [...memory.experience, {
        id: worldlineId<'memory'>(this.nextId('memory')),
        actorId,
        logicalTime: event.logicalTime,
        sourceEventIds: [event.id],
        importance: 0.7,
        actionType: typeof actionType === 'string' ? actionType : event.type,
        outcome: event.processMilestone,
        conditions: event.data,
      }].slice(-MEMORY_CATEGORY_LIMIT)
      : memory.experience
    const relationships = event.participantIds
      .filter(id => id !== actorId && this.entity(worldlineId<'entity'>(id)) !== undefined)
      .reduce<CharacterMemory['relationships']>((items, other) => {
        const otherId = worldlineId<'entity'>(other)
        const current = items.find(item => item.otherId === otherId)
        const next = current === undefined ? {
          id: worldlineId<'memory'>(this.nextId('memory')),
          actorId,
          logicalTime: event.logicalTime,
          sourceEventIds: [event.id],
          importance: 0.6,
          otherId,
          dimensions: { affinity: 0.1, interactions: 1 },
        } : {
          ...current,
          logicalTime: event.logicalTime,
          sourceEventIds: [...current.sourceEventIds, event.id].slice(-RELATIONSHIP_EVIDENCE_LIMIT),
          dimensions: {
            ...current.dimensions,
            affinity: Math.min(100, (current.dimensions['affinity'] ?? 0) + 0.1),
            interactions: (current.dimensions['interactions'] ?? 0) + 1,
          },
        }
        return [...items.filter(item => item.otherId !== otherId), next]
      }, memory.relationships)
    this.setCharacterMemory(actorId, { ...memory, episodic, experience, relationships })
  }

  private rememberCognition(event: WorldEvent): void {
    for (const change of event.cognitionChanges) {
      const observer = change['observer']
      const fact = change['fact']
      if (typeof observer !== 'string' || this.entity(worldlineId<'entity'>(observer)) === undefined
        || typeof fact !== 'object' || fact === null || Array.isArray(fact)) continue
      const actorId = worldlineId<'entity'>(observer)
      const memory = this.characterMemory(actorId)
      const factRecord = fact
      const belief = {
        id: worldlineId<'memory'>(this.nextId('memory')),
        actorId,
        logicalTime: event.logicalTime,
        sourceEventIds: [event.id],
        importance: typeof factRecord['importance'] === 'number' ? factRecord['importance'] : 0.6,
        subject: typeof factRecord['subject'] === 'string' ? factRecord['subject'] : event.type,
        value: factRecord['value'] ?? factRecord,
        confidence: typeof factRecord['confidence'] === 'number' ? factRecord['confidence'] : 1,
        contradictedBy: [],
      }
      this.setCharacterMemory(actorId, {
        ...memory,
        beliefs: [...memory.beliefs, belief].slice(-MEMORY_CATEGORY_LIMIT),
      })
    }
  }

  private characterMemory(actorId: EntityId): CharacterMemory {
    const memory = this.entity(actorId)?.['memory']
    if (typeof memory !== 'object' || memory === null || Array.isArray(memory)) return EMPTY_MEMORY
    return memory as unknown as CharacterMemory
  }

  private setCharacterMemory(actorId: EntityId, memory: CharacterMemory): void {
    const path = `entities.${escapePathSegment(actorId)}.memory`
    this.snapshotValue = {
      ...this.snapshotValue,
      state: setPath(this.snapshotValue.state, path, memory as unknown as JsonValue),
    }
  }

  private record(
    stream: RunStreamRecord['stream'],
    id: string,
    payload: unknown,
    sequence: number,
  ): RunStreamRecord {
    return { sequence, logicalTime: this.snapshotValue.logicalTime, stream, id, payload: jsonObject(payload) }
  }

  private telemetryRecord(): RunStreamRecord {
    const telemetry: Telemetry = {
      logicalTime: this.snapshotValue.logicalTime,
      queueDepth: this.snapshotValue.futureEvents.length,
      activeProcesses: this.snapshotValue.processes.filter(item => !processTerminal(item.state)).length,
      longestWait: this.health().longestWait,
      eventRate: 0,
      ai: this.snapshotValue.aiUsage,
    }
    return this.record('telemetry', this.nextId('telemetry'), telemetry, this.snapshotValue.sequence)
  }

  private claimsFor(
    process: Process,
    definition: ActionDefinition,
    duration = definition.duration,
  ): ResourceClaim[] {
    return definition.claims.map(claim => ({
      resourceId: claim.resource.replaceAll('{actor}', process.action.actorId),
      quantity: claim.quantity,
      mode: claim.mode,
      start: this.snapshotValue.logicalTime,
      end: this.snapshotValue.logicalTime + Math.max(duration, claim.duration),
    })).sort((left, right) => left.resourceId.localeCompare(right.resourceId))
  }

  private movementClaims(
    process: Process,
    definition: ActionDefinition,
    planned: PlannedMovement,
  ): ResourceClaim[] {
    const now = this.snapshotValue.logicalTime
    const claims = this.claimsFor(process, definition, planned.duration)
    let edgeStart = now
    for (const edge of planned.edges) {
      const edgeEnd = edgeStart + edge.baseDuration
      if (edge.capacity !== undefined) claims.push({
        resourceId: edge.id,
        quantity: 1,
        mode: 'capacity',
        start: edgeStart,
        end: edgeEnd,
      })
      edgeStart = edgeEnd
    }
    const destination = this.init.blueprint.maps.flatMap(map => map.nodes)
      .find(node => node.id === planned.route.at(-1))
    if (destination?.capacity !== undefined) claims.push({
      resourceId: destination.id,
      quantity: 1,
      mode: 'capacity',
      start: now + planned.duration,
      end: now + planned.duration + Math.max(1, this.init.blueprint.purpose.resolution),
    })
    return claims.sort((left, right) => left.resourceId.localeCompare(right.resourceId)
      || left.start - right.start)
  }

  private blockers(claims: readonly ResourceClaim[], actorId?: EntityId): ProcessId[] {
    const blockers = new Set<ProcessId>()
    for (const claim of claims) {
      const reservations = this.snapshotValue.reservations.filter(reservation => reservation.claims.some(value => (
        value.resourceId === claim.resourceId && this.claimsOverlap(value, claim)
      )))
      const existing = reservations.filter(reservation => reservation.claims.some(value => (
        value.resourceId === claim.resourceId && this.claimsOverlap(value, claim)
        && (value.mode === 'exclusive' || claim.mode === 'exclusive')
      )))
      for (const reservation of existing) blockers.add(reservation.processId)
      if (claim.mode === 'capacity') {
        const used = reservations.flatMap(item => item.claims)
          .filter(item => item.resourceId === claim.resourceId && this.claimsOverlap(item, claim))
          .reduce((sum, item) => sum + item.quantity, 0)
        const occupants = this.locationOccupants(claim.resourceId, actorId)
        const capacity = this.resourceCapacity(claim.resourceId)
        if (used + occupants.length + claim.quantity > capacity) {
          for (const reservation of reservations) blockers.add(reservation.processId)
          for (const occupant of occupants) {
            blockers.add(worldlineId<'process'>(`process:${contentFingerprint(`occupant:${occupant}`)}`))
          }
        }
      }
    }
    return [...blockers].sort()
  }

  private reserve(process: Process, claims: readonly ResourceClaim[]): Reservation | undefined {
    if (claims.length === 0) return undefined
    const reservation: Reservation = {
      id: worldlineId<'reservation'>(this.nextId('reservation')),
      processId: process.id,
      claims,
      acquiredAt: this.snapshotValue.logicalTime,
      expiresAt: Math.max(...claims.map(claim => claim.end)),
      queuePosition: 0,
    }
    this.snapshotValue = {
      ...this.snapshotValue,
      reservations: [...this.snapshotValue.reservations, reservation],
    }
    return reservation
  }

  private release(processId: ProcessId): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      reservations: this.snapshotValue.reservations.filter(item => item.processId !== processId),
    }
    this.wakeWaitingProcesses(processId)
  }

  private claimsOverlap(left: ResourceClaim, right: ResourceClaim): boolean {
    return left.start < right.end && right.start < left.end
  }

  private resourceCapacity(resourceId: string): number {
    const mapCapacity = this.init.blueprint.maps.flatMap(map => [
      ...map.nodes.map(node => [node.id, node.capacity] as const),
      ...map.edges.map(edge => [edge.id, edge.capacity] as const),
    ]).find(([id]) => id === resourceId)?.[1]
    const stateCapacity = getPath(
      this.snapshotValue.state,
      `resources.${escapePathSegment(resourceId)}.capacity`,
    )
    const value = mapCapacity ?? (typeof stateCapacity === 'number' ? stateCapacity : 1)
    return Number.isFinite(value) && value >= 0 ? value : 0
  }

  private locationOccupants(resourceId: string, excludedActor?: EntityId): EntityId[] {
    if (!resourceId.startsWith('map-node:')) return []
    const entities = this.snapshotValue.state['entities']
    if (typeof entities !== 'object' || entities === null || Array.isArray(entities)) return []
    return Object.entries(entities).flatMap(([id, value]) => {
      if (id === excludedActor || typeof value !== 'object' || value === null || Array.isArray(value)) return []
      const state = value['state']
      return typeof state === 'object' && state !== null && !Array.isArray(state)
        && state['locationId'] === resourceId
        ? [worldlineId<'entity'>(id)]
        : []
    })
  }

  private wakeWaitingProcesses(releasedBy?: ProcessId): void {
    for (const process of this.snapshotValue.processes) {
      if (process.state !== 'admitted') continue
      if (releasedBy !== undefined && !process.wakeConditions.includes(releasedBy)) continue
      this.schedule('reservation-retry', this.snapshotValue.logicalTime, {
        processId: process.id,
        priority: Math.floor(this.snapshotValue.logicalTime - process.action.requestedAt),
      }, `retry:${process.id}`)
    }
  }

  private failProcess(
    process: Process,
    definition: ActionDefinition,
    reason: string,
    records: RunStreamRecord[],
  ): Process {
    const failed: Process = { ...process, state: 'failed', failure: reason }
    this.release(process.id)
    this.putProcess(failed)
    this.emitEvent(this.lifecycleEvent(failed, definition, 'failed'), records)
    return failed
  }

  private resolveWaitCycles(records: RunStreamRecord[]): void {
    const waiting = this.snapshotValue.processes.filter(item => item.state === 'admitted')
    const graph = new Map(waiting.map(item => [item.id, item.wakeConditions.filter(value => value.startsWith('process:')) as ProcessId[]]))
    const visited = new Set<ProcessId>()
    const active = new Set<ProcessId>()
    const visit = (id: ProcessId): ProcessId[] | undefined => {
      if (active.has(id)) return [id]
      if (visited.has(id)) return undefined
      visited.add(id); active.add(id)
      for (const target of graph.get(id) ?? []) {
        const cycle = visit(target)
        if (cycle !== undefined) return [...cycle, id]
      }
      active.delete(id)
      return undefined
    }
    for (const id of graph.keys()) {
      const cycle = visit(id)
      if (cycle === undefined) continue
      const victimId = [...new Set(cycle)].sort().at(-1)
      const victim = victimId === undefined ? undefined : this.process(victimId)
      if (victim !== undefined) {
        this.healthValue.deadlocksResolved += 1
        this.failProcess(victim, this.definition(victim.action.type), 'deadlock victim selected deterministically', records)
      }
      return
    }
  }

  private recoverLivelock(records: RunStreamRecord[]): void {
    const victim = this.snapshotValue.processes.filter(item => !processTerminal(item.state))
      .sort((left, right) => left.action.requestedAt - right.action.requestedAt || left.id.localeCompare(right.id))[0]
    if (victim !== undefined) {
      this.healthValue.livelocksResolved += 1
      this.failProcess(victim, this.definition(victim.action.type), 'maximum no-progress attempts reached', records)
    }
    this.healthValue.noProgressSteps = 0
    this.statusValue = 'degraded'
  }

  private planMovement(origin: MapNodeId, destination: MapNodeId): PlannedMovement | undefined {
    if (origin === destination) return { route: [origin], edges: [], duration: 0 }
    const cacheKey = `${origin}\u0000${destination}`
    const cached = this.plannedMovementCache.get(cacheKey)
    if (cached !== undefined) return cached ?? undefined
    const edges = this.init.blueprint.maps.flatMap(map => map.edges)
    const distances = new Map<MapNodeId, number>([[origin, 0]])
    const previous = new Map<MapNodeId, { node: MapNodeId; edge: MapEdge }>()
    const pending = new Set<MapNodeId>(this.init.blueprint.maps.flatMap(map => map.nodes.map(node => node.id)))
    while (pending.size > 0) {
      const current = [...pending].sort((left, right) => (
        (distances.get(left) ?? Number.POSITIVE_INFINITY) - (distances.get(right) ?? Number.POSITIVE_INFINITY)
        || left.localeCompare(right)
      ))[0]
      if (current === undefined || !Number.isFinite(distances.get(current) ?? Number.POSITIVE_INFINITY)) break
      pending.delete(current)
      if (current === destination) break
      for (const edge of edges) {
        let next: MapNodeId | undefined
        if (edge.from === current) next = edge.to
        else if (edge.bidirectional && edge.to === current) next = edge.from
        if (next === undefined || !pending.has(next)) continue
        const candidate = (distances.get(current) ?? 0) + edge.baseDuration
        if (candidate < (distances.get(next) ?? Number.POSITIVE_INFINITY)) {
          distances.set(next, candidate)
          previous.set(next, { node: current, edge })
        }
      }
    }
    if (!previous.has(destination)) {
      this.plannedMovementCache.set(cacheKey, null)
      return undefined
    }
    const route: MapNodeId[] = [destination]
    const routeEdges: MapEdge[] = []
    let cursor = destination
    while (cursor !== origin) {
      const step = previous.get(cursor)
      if (step === undefined) {
        this.plannedMovementCache.set(cacheKey, null)
        return undefined
      }
      route.unshift(step.node)
      routeEdges.unshift(step.edge)
      cursor = step.node
    }
    const planned = {
      route,
      edges: routeEdges,
      duration: routeEdges.reduce((sum, edge) => sum + edge.baseDuration, 0),
    }
    this.plannedMovementCache.set(cacheKey, planned)
    return planned
  }

  private projectActionChoices(
    actorId: EntityId,
    definition: ActionDefinition,
  ): ChoiceProjection[] {
    if (definition.operator !== 'move' && definition.operator !== 'teleport') {
      const actorState = this.entity(actorId)?.['state']
      const actorLocation = typeof actorState === 'object' && actorState !== null
        && !Array.isArray(actorState) && typeof actorState['locationId'] === 'string'
        ? worldlineId<'map-node'>(actorState['locationId'])
        : undefined
      if (definition.location?.mode === 'at'
        && (actorLocation === undefined || !definition.location.nodeIds.includes(actorLocation))) {
        return []
      }
      if (actionNeedsTarget(definition)) {
        return this.init.blueprint.entities
          .filter(entity => entity.type === 'character' && entity.id !== actorId)
          .filter((target) => {
            const targetState = this.entity(target.id)?.['state']
            const targetLocation = typeof targetState === 'object' && targetState !== null
              && !Array.isArray(targetState) && typeof targetState['locationId'] === 'string'
              ? targetState['locationId']
              : undefined
            return actorLocation === undefined || targetLocation === undefined
              || actorLocation === targetLocation
          })
          .map((target) => {
            const targetName = this.init.blueprint.canon.find(object => object.id === target.id)?.title
              ?? target.id
            return {
              id: `choice:${contentFingerprint(`${actorId}:${definition.id}:${target.id}:${String(this.snapshotValue.sequence)}`)}`,
              actionType: definition.id,
              parameters: { targetId: target.id },
              label: `${definition.description}：${targetName}`,
              description: `${definition.description}：${targetName}`,
              targetIds: [target.id],
              estimatedDuration: definition.duration,
              costs: definition.claims.map(claim => `${claim.quantity} ${claim.resource}`),
              risks: [],
            }
          })
      }
      return [{
        id: `choice:${contentFingerprint(`${actorId}:${definition.id}:${String(this.snapshotValue.sequence)}`)}`,
        actionType: definition.id,
        parameters: {},
        label: definition.description,
        description: definition.description,
        targetIds: [],
        estimatedDuration: definition.duration,
        costs: definition.claims.map(claim => `${claim.quantity} ${claim.resource}`),
        risks: [],
      }]
    }
    const actor = this.entity(actorId)
    const state = actor?.['state']
    const origin = typeof state === 'object' && state !== null && !Array.isArray(state)
      && typeof state['locationId'] === 'string'
      ? worldlineId<'map-node'>(state['locationId'])
      : undefined
    if (origin === undefined) return []
    return this.init.blueprint.maps.flatMap(map => map.nodes).flatMap((node): ChoiceProjection[] => {
      if (node.id === origin) return []
      const planned = definition.operator === 'teleport'
        ? { duration: 0 }
        : this.planMovement(origin, node.id)
      if (planned === undefined) return []
      return [{
        id: `choice:${contentFingerprint(`${actorId}:${definition.id}:${node.id}:${String(this.snapshotValue.sequence)}`)}`,
        actionType: definition.id,
        parameters: { destination: node.id },
        label: `${definition.description}: ${node.name}`,
        description: `${definition.operator === 'teleport' ? 'Teleport' : 'Travel'} to ${node.name}.`,
        targetIds: [node.id],
        estimatedDuration: planned.duration,
        costs: definition.claims.map(claim => `${claim.quantity} ${claim.resource}`),
        risks: [...node.hazards],
      }]
    })
  }

  private health(verifyStore = true): RunHealth {
    const active = this.snapshotValue.processes.filter(item => !processTerminal(item.state))
    const longestWait = active.reduce((max, item) => (
      Math.max(max, this.snapshotValue.logicalTime - item.action.requestedAt)
    ), 0)
    return {
      futureQueueDepth: this.snapshotValue.futureEvents.length,
      activeProcesses: active.length,
      waitingProcesses: active.filter(item => item.state === 'admitted').length,
      reservations: this.snapshotValue.reservations.length,
      longestWait,
      noProgressSteps: this.healthValue.noProgressSteps,
      deadlocksResolved: this.healthValue.deadlocksResolved,
      livelocksResolved: this.healthValue.livelocksResolved,
      fairnessInterventions: this.healthValue.fairnessInterventions,
      writerThread: true,
      wal: !verifyStore || this.database.integrity().journalMode.toLowerCase() === 'wal',
    }
  }

  private schedule(kind: string, due: number, payload: JsonObject, dedupeKey?: string): void {
    if (dedupeKey !== undefined) this.snapshotValue = {
      ...this.snapshotValue,
      futureEvents: this.snapshotValue.futureEvents.filter(item => item.dedupeKey !== dedupeKey),
    }
    const future: FutureEvent = {
      id: `future:${contentFingerprint(`${this.snapshotValue.seed}:${kind}:${String(due)}:${String(this.idCounter)}`)}`,
      due,
      order: this.idCounter,
      kind,
      payload,
      ...(dedupeKey === undefined ? {} : { dedupeKey }),
    }
    this.idCounter += 1
    this.snapshotValue = { ...this.snapshotValue, futureEvents: [...this.snapshotValue.futureEvents, future] }
  }

  private sortedQueue(): readonly FutureEvent[] {
    return [...this.snapshotValue.futureEvents].sort((left, right) => {
      const priority = Number(right.payload['priority'] ?? 0) - Number(left.payload['priority'] ?? 0)
      return left.due - right.due || priority || left.order - right.order || left.id.localeCompare(right.id)
    })
  }

  private removeFuture(id: string): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      futureEvents: this.snapshotValue.futureEvents.filter(item => item.id !== id),
    }
  }

  private putProcess(process: Process): void {
    const existing = this.snapshotValue.processes.some(item => item.id === process.id)
    const updated = existing
      ? this.snapshotValue.processes.map(item => item.id === process.id ? process : item)
      : [...this.snapshotValue.processes, process]
    const active = updated.filter(item => !processTerminal(item.state))
    const terminal = updated.filter(item => processTerminal(item.state))
      .sort((left, right) => right.action.requestedAt - left.action.requestedAt
        || right.id.localeCompare(left.id))
      .slice(0, RETAINED_TERMINAL_PROCESS_LIMIT)
    this.snapshotValue = {
      ...this.snapshotValue,
      processes: [...active, ...terminal],
    }
  }

  private withLogicalTime(logicalTime: number): RunSnapshot {
    return {
      ...this.snapshotValue,
      logicalTime,
      state: syncConfiguredCalendar(this.snapshotValue.state, logicalTime),
    }
  }

  private process(id: string): Process | undefined { return this.snapshotValue.processes.find(item => item.id === id) }
  private definition(id: string): ActionDefinition {
    const value = this.init.blueprint.actions.find(item => item.id === id)
    if (value === undefined) throw new Error(`Blueprint action disappeared: ${id}`)
    return value
  }

  private entity(id: EntityId): Record<string, JsonValue> | undefined {
    const entities = stateRecord(this.snapshotValue.state)['entities']
    if (typeof entities !== 'object' || entities === null || Array.isArray(entities)) return undefined
    const entity = entities[id]
    return typeof entity === 'object' && entity !== null && !Array.isArray(entity)
      ? entity
      : undefined
  }

  private commit(records: readonly RunStreamRecord[]): void {
    if (this.deferDatabaseCommit) {
      this.deferredRecords.push(...records)
      return
    }
    this.updatedAt = new Date().toISOString()
    this.database.commit({
      snapshot: this.snapshotValue,
      records,
      metadata: {
        status: this.statusValue,
        runtimeState: JSON.stringify(this.runtimeState()),
      },
    })
  }

  private nextId(namespace: string): string {
    const value = `${this.snapshotValue.seed}:${this.snapshotValue.sequence}:${this.idCounter}:${namespace}`
    this.idCounter += 1
    return `${namespace}:${contentFingerprint(value)}`
  }

  private runtimeState(): PersistedRuntimeState {
    return {
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      controls: Object.fromEntries(this.controls),
      health: { ...this.healthValue },
      idCounter: this.idCounter,
    }
  }

  private persistedRuntimeState(): PersistedRuntimeState | undefined {
    const raw = this.database.meta('runtimeState')
    if (raw === undefined) return undefined
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      const value = parsed as Record<string, unknown>
      const controls = value['controls']
      const health = value['health']
      if (typeof value['createdAt'] !== 'string' || typeof value['updatedAt'] !== 'string'
        || typeof value['idCounter'] !== 'number' || typeof controls !== 'object'
        || controls === null || Array.isArray(controls) || typeof health !== 'object'
        || health === null || Array.isArray(health)) {
        return undefined
      }
      const healthRecord = health as Record<string, unknown>
      const number = (key: keyof MutableHealth): number => {
        const item = healthRecord[key]
        return typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : 0
      }
      return {
        createdAt: value['createdAt'],
        updatedAt: value['updatedAt'],
        idCounter: Math.max(0, Math.floor(value['idCounter'])),
        controls: Object.fromEntries(Object.entries(controls).filter((entry): entry is [string, ActorControlMode] => (
          entry[1] === 'autonomous' || entry[1] === 'suggestions' || entry[1] === 'player'
        ))),
        health: {
          noProgressSteps: number('noProgressSteps'),
          deadlocksResolved: number('deadlocksResolved'),
          livelocksResolved: number('livelocksResolved'),
          fairnessInterventions: number('fairnessInterventions'),
        },
      }
    } catch {
      return undefined
    }
  }

  private assertRun(runId: RunId): void {
    if (runId !== this.snapshotValue.runId) throw new WorldlineRuntimeError('run-not-found', `wrong Run: ${runId}`)
  }

  private assertLive(): void {
    if (this.stopped || this.statusValue === 'stopped' || this.statusValue === 'failed') {
      throw new WorldlineRuntimeError('run-not-live', 'Run is not live')
    }
  }
}

export default WorldlineKernel
