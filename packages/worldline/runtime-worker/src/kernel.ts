import { createHash } from 'node:crypto'
import type {
  ActionDefinition,
  ActionRequest,
  AiIntent,
  AiInvocation,
  AiBudget,
  Blueprint,
  CharacterMemory,
  Checkpoint,
  ChoiceProjection,
  DecisionTrace,
  Effect,
  EntityId,
  FutureEvent,
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
  StateDelta,
  Telemetry,
  WorldEvent,
} from '@deepseek-ai/dsh-worldline-standard'
import {
  contentFingerprint,
  evaluateExpression,
  isValidWorldEvent,
  stableStringify,
  validateBlueprint,
  worldlineId,
} from '@deepseek-ai/dsh-worldline-standard'
import { WorldlineRunDatabase, type RunStreamRecord } from '@deepseek-ai/dsh-worldline-run-sqlite'
import type {
  ActorControlMode,
  AdvanceRunRequest,
  CheckpointView,
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
  RecordAiIntentRequest,
  RecordAiIntentResult,
  RecordAiInvocationRequest,
  RecordAiInvocationResult,
  RecordNarrativeBeatRequest,
  RecordNarrativeBeatResult,
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

export interface KernelInit {
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly blueprint: Blueprint
  readonly databasePath: string
  readonly seed: string
  readonly startPaused?: boolean
  readonly modelPolicy?: RunSnapshot['modelPolicy']
  readonly aiBudget?: AiBudget
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

const DEFAULT_AI_BUDGET: AiBudget = {
  maxCalls: 0,
  maxInputTokens: 0,
  maxOutputTokens: 0,
  maxConcurrent: 0,
  maxCallsPerLogicalDay: 0,
  maxCallsPerRealHour: 0,
  maxEstimatedCost: 0,
  currency: 'USD',
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

const MEMORY_CATEGORY_LIMIT = 500

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
  const result = structuredClone(root)
  const parts = pathSegments(path)
  if (parts.length === 0) throw new Error('an effect cannot replace the Run state root')
  let cursor: Record<string, JsonValue> = result
  for (const segment of parts.slice(0, -1)) {
    const existing = cursor[segment]
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) cursor[segment] = {}
    cursor = cursor[segment] as Record<string, JsonValue>
  }
  const leaf = parts.at(-1)
  if (leaf === undefined) throw new Error('an effect path must identify a state field')
  cursor[leaf] = value
  return result
}

function actorPath(path: string, actorId: EntityId | undefined): string {
  if (actorId === undefined || !path.startsWith('state.')) return path
  return `entities.${escapePathSegment(actorId)}.state.${path.slice('state.'.length)}`
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

  close(): void {
    if (this.stopped) return
    this.statusValue = 'stopped'
    this.commit([])
    this.stopped = true
    this.database.close()
  }

  view(): RunView {
    return {
      summary: this.summary(),
      snapshot: structuredClone(this.snapshotValue),
      health: this.health(),
      aiUsage: this.snapshotValue.aiUsage,
      controls: Object.fromEntries(this.controls),
    }
  }

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
    }
  }

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
        && definition.actorTypes.includes(actor['type'])
        && definition.preconditions.every(expression => evaluateExpression(expression, this.snapshotValue.state)))
      .flatMap(definition => this.projectActionChoices(request.actorId, definition))
    return {
      runId: request.runId,
      actorId: request.actorId,
      sequence: this.snapshotValue.sequence,
      choices,
    }
  }

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

  pause(): RunView {
    this.assertLive()
    this.statusValue = 'paused'
    this.commit([])
    return this.view()
  }

  resume(): RunView {
    this.assertLive()
    this.statusValue = 'running'
    this.commit([])
    return this.view()
  }

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
      this.snapshotValue = { ...this.snapshotValue, logicalTime: next.due }
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
    else this.snapshotValue = { ...this.snapshotValue, logicalTime: target }
    records.push(this.telemetryRecord())
    this.commit(records)
    return this.view()
  }

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
    if (!definition.preconditions.every(expression => evaluateExpression(expression, this.snapshotValue.state))) {
      throw new WorldlineRuntimeError('action-forbidden', 'action preconditions are not satisfied')
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
      targetIds: [],
      parameters: request.parameters ?? {},
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
      retryBudget: definition.retryBudget,
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
    return { actionId, process, decision, view: this.view() }
  }

  records(request: RunRecordsRequest): RunRecordsPage {
    this.assertRun(request.runId)
    const limit = Math.min(5000, Math.max(1, request.limit ?? 500))
    const records = this.database.records(
      request.afterSequence ?? -1,
      limit + 1,
      request.stream,
      request.afterOrdinal ?? -1,
    )
    const page = records.slice(0, limit)
    return {
      records: page,
      nextSequence: page.at(-1)?.sequence ?? request.afterSequence ?? -1,
      nextOrdinal: page.at(-1)?.ordinal ?? request.afterOrdinal ?? -1,
      hasMore: records.length > limit,
    }
  }

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

  checkpoints(): readonly CheckpointView[] { return this.database.checkpoints() }

  setControl(request: SetActorControlRequest): RunView {
    this.assertRun(request.runId)
    if (this.entity(request.actorId) === undefined) {
      throw new WorldlineRuntimeError('action-invalid', `unknown actor: ${request.actorId}`)
    }
    this.controls.set(request.actorId, request.mode)
    this.commit([])
    return this.view()
  }

  setAiEnabled(request: SetAiEnabledRequest): RunView {
    this.assertRun(request.runId)
    this.snapshotValue = {
      ...this.snapshotValue,
      modelPolicy: { ...this.snapshotValue.modelPolicy, aiEnabled: request.enabled },
    }
    this.commit([])
    return this.view()
  }

  switchModel(request: SwitchModelPolicyRequest): RunView {
    this.assertRun(request.runId)
    if (request.expectedSequence !== this.snapshotValue.sequence) {
      throw new WorldlineRuntimeError('run-conflict', 'Run advanced before the model policy switch')
    }
    this.snapshotValue = { ...this.snapshotValue, modelPolicy: request.modelPolicy }
    this.commit([])
    return this.view()
  }

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
    const budgetExceeded = this.aiBudgetExceeded(usage)
    this.snapshotValue = {
      ...this.snapshotValue,
      aiUsage: budgetExceeded ? { ...usage, degradedReason: 'AI budget exhausted' } : usage,
      modelPolicy: budgetExceeded
        ? { ...this.snapshotValue.modelPolicy, aiEnabled: false }
        : this.snapshotValue.modelPolicy,
    }
    this.commit([this.record('ai-invocation', invocation.id, invocation, this.snapshotValue.sequence)])
    return { invocation, budgetExceeded, view: this.view() }
  }

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
    if (request.style === 'llm') {
      if (request.invocationId === undefined || request.modelRoute === undefined) {
        throw new WorldlineRuntimeError('action-invalid', 'LLM narrative requires its recorded invocation and route')
      }
      const invocationPayload = this.database.record('ai-invocation', request.invocationId)?.payload
      const invocation = invocationPayload as unknown as AiInvocation | undefined
      if (invocation === undefined || invocation.purpose !== 'narrator'
        || stableStringify(invocation.modelRoute) !== stableStringify(request.modelRoute)
        || invocation.outputDigest !== createHash('sha256').update(request.text).digest('hex')) {
        throw new WorldlineRuntimeError('action-invalid', 'narrative does not match its recorded narrator call')
      }
      const cited = [...request.eventIds, ...request.observationIds]
      if (cited.some(id => !invocation.contextSourceIds.includes(id))) {
        throw new WorldlineRuntimeError('action-invalid', 'narrative cites facts absent from its Context Pack')
      }
    }
    const beat: NarrativeBeat = {
      id: worldlineId<'narrative-beat'>(this.nextId('narrative-beat')),
      ...(request.invocationId === undefined ? {} : { invocationId: request.invocationId }),
      eventIds: request.eventIds,
      observationIds: request.observationIds,
      camera: request.camera,
      ...(request.speakerId === undefined ? {} : { speakerId: request.speakerId }),
      text: request.text,
      media: request.media,
      style: request.style,
      ...(request.modelRoute === undefined ? {} : { modelRoute: request.modelRoute }),
    }
    this.commit([this.record('narrative-beat', beat.id, beat, this.snapshotValue.sequence)])
    return { beat, view: this.view() }
  }

  private initialSnapshot(): RunSnapshot {
    const entities: Record<string, JsonValue> = {}
    for (const seed of this.init.blueprint.entities) {
      entities[seed.id] = {
        type: seed.type,
        facets: seed.facets,
        state: seed.state,
        lod: seed.lod,
        memory: jsonObject(seed.memory),
      }
    }
    const futureEvents: FutureEvent[] = this.init.blueprint.systems.map((system, index) => ({
      id: `future:${contentFingerprint(`${this.init.runId}:${system.id}:initial`)}`,
      due: Math.max(0, system.nextWake),
      order: index,
      kind: 'system-wake',
      payload: { systemId: system.id },
      dedupeKey: `system:${system.id}`,
    }))
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
      state: { world: { time: 0 }, entities, resources: {} },
      processes: [],
      reservations: [],
      futureEvents,
      randomState: createHash('sha256').update(this.init.seed).digest('hex'),
      modelPolicy: this.init.modelPolicy ?? this.init.blueprint.modelPolicy,
      aiBudget: this.init.aiBudget ?? DEFAULT_AI_BUDGET,
      aiUsage: {
        calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        estimatedCost: 0, cacheHits: 0,
      },
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
    if (process.retryCount >= process.retryBudget) {
      return this.failProcess(process, definition, 'resource retry budget exhausted', records)
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
  }

  private runSystem(id: string, records: RunStreamRecord[]): void {
    const system = this.init.blueprint.systems.find(item => item.id === id)
    if (system === undefined) return
    if (system.preconditions.every(expression => evaluateExpression(expression, this.snapshotValue.state))) {
      const applied = this.applyEffects(system.effects)
      if (this.invariantsHold(applied.state)) {
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
    const applied = this.applyEffects(definition.effects, process.action.actorId)
    if (!this.invariantsHold(applied.state)) {
      this.failProcess(process, definition, 'action effects violate a world invariant', records)
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

  private applyEffects(effects: readonly Effect[], actorId?: EntityId): EffectResult {
    let state = structuredClone(this.snapshotValue.state)
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
        const beforeFrom = Number(getPath(state, fromPath) ?? 0)
        const beforeTo = Number(getPath(state, toPath) ?? 0)
        if (beforeFrom < effect.amount) throw new WorldlineRuntimeError('action-forbidden', 'resource transfer exceeds holdings')
        state = setPath(state, fromPath, beforeFrom - effect.amount)
        state = setPath(state, toPath, beforeTo + effect.amount)
        deltas.push({ path: fromPath, before: beforeFrom, after: beforeFrom - effect.amount })
        deltas.push({ path: toPath, before: beforeTo, after: beforeTo + effect.amount })
        continue
      }
      const path = actorPath(effect.path, actorId)
      const before = getPath(state, path)
      if (effect.op === 'set') state = setPath(state, path, effect.value)
      if (effect.op === 'increment') {
        let next = Number(before ?? 0) + effect.amount
        if (effect.min !== undefined) next = Math.max(effect.min, next)
        if (effect.max !== undefined) next = Math.min(effect.max, next)
        state = setPath(state, path, next)
      }
      const after = getPath(state, path)
      if (stableStringify(before) !== stableStringify(after)) {
        deltas.push(stateDelta(path, before, after))
      }
    }
    return { state, deltas, cognitionChanges }
  }

  private invariantsHold(state: JsonObject): boolean {
    return this.init.blueprint.invariants.every(invariant => evaluateExpression(invariant.expression, state))
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
      participantIds: [process.action.actorId],
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

  private worldEvent(input: Omit<WorldEvent, 'id' | 'sequence' | 'logicalTime' | 'causedBy' | 'persistentFacts' | 'visibleTo'>): WorldEvent {
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
      && (event.processMilestone === 'completed' || event.processMilestone === 'failed'
        || event.processMilestone === 'cancelled')
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
    this.setCharacterMemory(actorId, { ...memory, episodic, experience })
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
      state: setPath(this.snapshotValue.state, path, jsonObject(memory)),
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
      this.failProcess(victim, this.definition(victim.action.type), 'no-progress budget exhausted', records)
    }
    this.healthValue.noProgressSteps = 0
    this.statusValue = 'degraded'
  }

  private planMovement(origin: MapNodeId, destination: MapNodeId): PlannedMovement | undefined {
    if (origin === destination) return { route: [origin], edges: [], duration: 0 }
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
    if (!previous.has(destination)) return undefined
    const route: MapNodeId[] = [destination]
    const routeEdges: MapEdge[] = []
    let cursor = destination
    while (cursor !== origin) {
      const step = previous.get(cursor)
      if (step === undefined) return undefined
      route.unshift(step.node)
      routeEdges.unshift(step.edge)
      cursor = step.node
    }
    return { route, edges: routeEdges, duration: routeEdges.reduce((sum, edge) => sum + edge.baseDuration, 0) }
  }

  private projectActionChoices(
    actorId: EntityId,
    definition: ActionDefinition,
  ): ChoiceProjection[] {
    if (definition.operator !== 'move' && definition.operator !== 'teleport') {
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

  private health(): RunHealth {
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
      wal: this.database.integrity().journalMode.toLowerCase() === 'wal',
    }
  }

  private aiBudgetExceeded(usage: RunSnapshot['aiUsage']): boolean {
    const budget = this.snapshotValue.aiBudget
    const invocations = this.database.records(-1, 5000, 'ai-invocation')
      .map(record => record.payload as unknown as AiInvocation)
    const logicalDay = Math.floor(this.snapshotValue.logicalTime / 86_400)
    const callsThisLogicalDay = invocations
      .filter(item => Math.floor(item.logicalTime / 86_400) === logicalDay).length + 1
    const hourAgo = Date.now() - 3_600_000
    const callsThisRealHour = invocations.filter(item => Date.parse(item.recordedAt) >= hourAgo).length + 1
    return usage.calls > budget.maxCalls
      || usage.inputTokens > budget.maxInputTokens
      || usage.outputTokens > budget.maxOutputTokens
      || usage.estimatedCost > budget.maxEstimatedCost
      || callsThisLogicalDay > budget.maxCallsPerLogicalDay
      || callsThisRealHour > budget.maxCallsPerRealHour
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
    this.snapshotValue = {
      ...this.snapshotValue,
      processes: existing
        ? this.snapshotValue.processes.map(item => item.id === process.id ? process : item)
        : [...this.snapshotValue.processes, process],
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
