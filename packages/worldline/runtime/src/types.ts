import type {
  ActionId,
  AiIntent,
  AiInvocation,
  AiBudget,
  AiUsage,
  CanonWorldlineId,
  Checkpoint,
  CheckpointId,
  ChoiceProjection,
  DecisionTrace,
  EntityId,
  JsonObject,
  MapEdge,
  MapId,
  MapLayer,
  MapNode,
  MapNodeId,
  ModelPolicy,
  ModelRoute,
  NarrativeBeat,
  Process,
  ProjectId,
  Reservation,
  RunId,
  RunSnapshot,
  Telemetry,
  WorldEvent,
} from '@deepseek-ai/dsh-worldline-standard/types'
import type { RunStream, RunStreamRecord } from '@deepseek-ai/dsh-worldline-run-sqlite'

export type RunStatus = 'starting' | 'paused' | 'running' | 'degraded' | 'stopped' | 'failed'
export type ActorControlMode = 'autonomous' | 'suggestions' | 'player'

export interface RunSummary {
  readonly runId: RunId
  readonly projectId: ProjectId
  readonly branchId: CanonWorldlineId
  readonly blueprintDigest: string
  readonly status: RunStatus
  readonly logicalTime: number
  readonly sequence: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly parentRunId?: RunId
  readonly forkSequence?: number
}

export interface RunHealth {
  readonly futureQueueDepth: number
  readonly activeProcesses: number
  readonly waitingProcesses: number
  readonly reservations: number
  readonly longestWait: number
  readonly noProgressSteps: number
  readonly deadlocksResolved: number
  readonly livelocksResolved: number
  readonly fairnessInterventions: number
  readonly writerThread: true
  readonly wal: boolean
}

export interface RunView {
  readonly summary: RunSummary
  readonly snapshot: RunSnapshot
  readonly health: RunHealth
  readonly aiUsage: AiUsage
  readonly controls: Readonly<Record<string, ActorControlMode>>
}

export interface RunSpatialViewport {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface RunSpatialRequest extends RunRef {
  readonly mapId?: MapId
  readonly viewport?: RunSpatialViewport
  readonly visibleLayerIds?: readonly string[]
  readonly maxNodes?: number
}

export interface RunSpatialMap {
  readonly id: MapId
  readonly name: string
  readonly rootNodeId: MapNodeId
  readonly backgroundAssetId?: string
  readonly layers: readonly MapLayer[]
  readonly nodes: readonly MapNode[]
  readonly edges: readonly MapEdge[]
  readonly totalNodes: number
  readonly totalEdges: number
  readonly truncated: boolean
}

export interface RunActorPosition {
  readonly actorId: EntityId
  readonly nodeId: MapNodeId
}

export interface RunMovementProjection {
  readonly processId: Process['id']
  readonly actorId: EntityId
  readonly state: Process['state']
  readonly origin: MapNodeId
  readonly destination: MapNodeId
  readonly route: readonly MapNodeId[]
  readonly edgeIndex: number
  readonly edgeFraction: number
  readonly remainingDuration: number
  readonly estimatedArrival: number
  readonly mode: string
}

/** Bounded, read-only projection of the immutable Run map and current movement state. */
export interface RunSpatialView {
  readonly runId: RunId
  readonly sequence: number
  readonly logicalTime: number
  readonly availableMaps: readonly { readonly id: MapId; readonly name: string; readonly nodeCount: number }[]
  readonly map?: RunSpatialMap
  readonly actors: readonly RunActorPosition[]
  readonly movements: readonly RunMovementProjection[]
}

export interface CreateRunRequest {
  readonly projectId: ProjectId
  readonly seed: string
  readonly modelPolicy?: ModelPolicy
  readonly aiBudget?: AiBudget
  readonly startPaused?: boolean
}

export interface RunRef { readonly runId: RunId }
export interface RunChoicesRequest extends RunRef { readonly actorId: EntityId }
export interface AdvanceRunRequest extends RunRef {
  readonly duration: number
  readonly maxEvents?: number
}
export interface SubmitRunActionRequest extends RunRef {
  readonly actorId: EntityId
  readonly type: string
  readonly parameters?: JsonObject
  readonly expectedSequence: number
  readonly controller: 'agent' | 'player' | 'system'
}
export interface SubmitRunActionResult {
  readonly actionId: ActionId
  readonly process: Process
  readonly decision: DecisionTrace
  readonly view: RunView
}
export interface RunChoicesView {
  readonly runId: RunId
  readonly actorId: EntityId
  readonly sequence: number
  readonly choices: readonly ChoiceProjection[]
}

/** Host-only handoff from the routed AI service into the authoritative Run ledger. */
export interface RecordAiIntentRequest extends RunRef {
  readonly actorId: EntityId
  readonly invocationId: AiInvocation['id']
  readonly choiceId: string
  readonly actionType: string
  readonly parameters: JsonObject
  readonly rationale: string
  readonly confidence: number
  readonly modelRoute: ModelRoute
  readonly contextSourceIds: readonly string[]
}
export interface RecordAiIntentResult {
  readonly intent: AiIntent
  readonly view: RunView
}
export interface RecordAiInvocationRequest extends RunRef {
  readonly purpose: AiInvocation['purpose']
  readonly actorId?: EntityId
  readonly modelRoute: ModelRoute
  readonly contextSourceIds: readonly string[]
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly estimatedCost: number
  readonly outputDigest: string
  readonly outcome: AiInvocation['outcome']
}
export interface RecordAiInvocationResult {
  readonly invocation: AiInvocation
  readonly budgetExceeded: boolean
  readonly view: RunView
}
export interface RecordNarrativeBeatRequest extends RunRef {
  readonly invocationId?: AiInvocation['id']
  readonly eventIds: NarrativeBeat['eventIds']
  readonly observationIds: NarrativeBeat['observationIds']
  readonly camera: string
  readonly speakerId?: EntityId
  readonly text: string
  readonly media: NarrativeBeat['media']
  readonly style: NarrativeBeat['style']
  readonly modelRoute?: ModelRoute
}
export interface RecordNarrativeBeatResult {
  readonly beat: NarrativeBeat
  readonly view: RunView
}

export interface RunRecordsRequest extends RunRef {
  readonly afterSequence?: number
  readonly afterOrdinal?: number
  readonly limit?: number
  readonly stream?: RunStream
}
export interface RunRecordsPage {
  readonly records: readonly RunStreamRecord[]
  readonly nextSequence: number
  readonly nextOrdinal: number
  readonly hasMore: boolean
}

export interface CreateCheckpointRequest extends RunRef { readonly label: string }
export interface CheckpointView {
  readonly checkpoint: Checkpoint
  readonly label: string
  readonly createdAt: string
}
export interface BranchRunRequest {
  readonly runId: RunId
  readonly checkpointId: CheckpointId
  readonly seed?: string
}
export interface SetActorControlRequest extends RunRef {
  readonly actorId: EntityId
  readonly mode: ActorControlMode
}
export interface SetAiEnabledRequest extends RunRef { readonly enabled: boolean }
export interface SwitchModelPolicyRequest extends RunRef {
  readonly modelPolicy: ModelPolicy
  readonly expectedSequence: number
}
export interface ExplainRunEventRequest extends RunRef { readonly eventId: string }
export interface RunEventExplanation {
  readonly event?: WorldEvent
  readonly decisions: readonly DecisionTrace[]
  readonly processes: readonly Process[]
  readonly reservations: readonly Reservation[]
  readonly telemetry: readonly Telemetry[]
  readonly summary: string
}

export type WorldlineRuntimeErrorCode =
  | 'run-not-found'
  | 'run-not-live'
  | 'run-conflict'
  | 'action-invalid'
  | 'action-forbidden'
  | 'checkpoint-not-found'
  | 'blueprint-not-frozen'
  | 'worker-failed'

export class WorldlineRuntimeError extends Error {
  constructor(readonly code: WorldlineRuntimeErrorCode, message: string) {
    super(message)
    this.name = 'WorldlineRuntimeError'
  }
}
