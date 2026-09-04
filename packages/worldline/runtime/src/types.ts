import type {
  ActionId,
  ActionDeck,
  ActionPlan,
  AiIntent,
  AiInvocation,
  AiUsage,
  ActionDefinition,
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
  PresentationCursor,
  PlotPointDefinition,
  Process,
  ProjectId,
  Reservation,
  SimulationPurpose,
  SystemDefinition,
  InvariantDefinition,
  RunId,
  RunSnapshot,
  StoryProgressEvidence,
  StoryStateCommit,
  StoryStateShard,
  Telemetry,
  WorldEvent,
} from '@deepseek-ai/dsh-worldline-standard/types'
import type { RunStream, RunStreamRecord } from '@deepseek-ai/dsh-worldline-run-sqlite'

/** Describes the run status value exchanged across the package boundary.
 */
export type RunStatus = 'starting' | 'paused' | 'running' | 'degraded' | 'stopped' | 'failed'
/** Describes the actor control mode value exchanged across the package boundary.
 */
export type ActorControlMode = 'autonomous' | 'suggestions' | 'player'

/** Describes the run summary value exchanged across the package boundary.
 */
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

/** Describes the run health value exchanged across the package boundary.
 */
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

/** Describes the run view value exchanged across the package boundary.
 */
export interface RunView {
  readonly summary: RunSummary
  readonly snapshot: RunSnapshot
  readonly health: RunHealth
  readonly aiUsage: AiUsage
  readonly controls: Readonly<Record<string, ActorControlMode>>
}

/** Describes the run entity definition value exchanged across the package boundary.
 */
export interface RunEntityDefinition {
  readonly id: EntityId
  readonly type: string
  readonly lod: 'L0' | 'L1' | 'L2' | 'L3'
  readonly policyIds: readonly string[]
}

/** Stable read-only projection of the frozen Blueprint retained by one Run. */
export interface RunDefinitionView {
  readonly runId: RunId
  readonly blueprintDigest: string
  readonly purpose: SimulationPurpose
  readonly entities: readonly RunEntityDefinition[]
  readonly actions: readonly ActionDefinition[]
  readonly systems: readonly SystemDefinition[]
  readonly invariants: readonly InvariantDefinition[]
  readonly plotPoints: readonly PlotPointDefinition[]
}

/** Describes the run spatial viewport value exchanged across the package boundary.
 */
export interface RunSpatialViewport {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** Describes the run spatial request value exchanged across the package boundary.
 */
export interface RunSpatialRequest extends RunRef {
  readonly mapId?: MapId
  readonly viewport?: RunSpatialViewport
  readonly visibleLayerIds?: readonly string[]
  readonly maxNodes?: number
}

/** Describes the run spatial map value exchanged across the package boundary.
 */
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

/** Describes the run actor position value exchanged across the package boundary.
 */
export interface RunActorPosition {
  readonly actorId: EntityId
  readonly nodeId: MapNodeId
}

/** Describes the run movement projection value exchanged across the package boundary.
 */
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

/** Describes the create run request value exchanged across the package boundary.
 */
export interface CreateRunRequest {
  readonly projectId: ProjectId
  readonly seed: string
  readonly modelPolicy?: ModelPolicy
  readonly startPaused?: boolean
}

/** Describes the run ref value exchanged across the package boundary.
 */
export interface RunRef { readonly runId: RunId }
/** Describes the run choices request value exchanged across the package boundary.
 */
export interface RunChoicesRequest extends RunRef { readonly actorId: EntityId }
/** Describes the advance run request value exchanged across the package boundary.
 */
export interface AdvanceRunRequest extends RunRef {
  readonly duration: number
  readonly maxEvents?: number
}
/** Run many deterministic actor/day cycles inside the owning worker without model calls. */
export interface SimulateRunRequest extends RunRef {
  readonly cycles: number
  readonly stepDuration: number
  readonly preferredAction?: string
}
/** Bounded summary of one headless autonomous simulation. */
export interface SimulateRunResult {
  readonly view: RunView
  readonly actorIds: readonly EntityId[]
  readonly actionsPerformed: number
  readonly actionCounts: Readonly<Record<string, number>>
  readonly actorActionCounts: Readonly<Record<string, number>>
  readonly sampledActions: readonly {
    readonly actorId: EntityId
    readonly actionType: string
    readonly actionId: ActionId
  }[]
}
/** Describes the submit run action request value exchanged across the package boundary.
 */
export interface SubmitRunActionRequest extends RunRef {
  readonly actorId: EntityId
  readonly type: string
  readonly parameters?: JsonObject
  readonly expectedSequence: number
  readonly controller: 'agent' | 'player' | 'system'
}
/** Describes the submit run action result value exchanged across the package boundary.
 */
export interface SubmitRunActionResult {
  readonly actionId: ActionId
  readonly process: Process
  readonly decision: DecisionTrace
  readonly view: RunView
}
/** Describes the run choices view value exchanged across the package boundary.
 */
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
/** Describes the record ai intent result value exchanged across the package boundary.
 */
export interface RecordAiIntentResult {
  readonly intent: AiIntent
  readonly view: RunView
}
/** Describes the record ai invocation request value exchanged across the package boundary.
 */
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
/** Describes the record ai invocation result value exchanged across the package boundary.
 */
export interface RecordAiInvocationResult {
  readonly invocation: AiInvocation
  readonly view: RunView
}
/** Describes the record narrative beat request value exchanged across the package boundary.
 */
export interface RecordNarrativeBeatRequest extends RunRef {
  readonly invocationId: AiInvocation['id']
  readonly perspectiveActorId: EntityId
  readonly eventIds: NarrativeBeat['eventIds']
  readonly observationIds: NarrativeBeat['observationIds']
  readonly camera: string
  readonly speakerId?: EntityId
  /** Exact raw provider output used only to bind this validated presentation to its invocation. */
  readonly modelOutput: string
  /** Reader-facing novel text projected from the validated ordered blocks. */
  readonly text: string
  readonly blocks: NarrativeBeat['blocks']
  readonly media: NarrativeBeat['media']
  readonly modelRoute: ModelRoute
}
/** Describes the record narrative beat result value exchanged across the package boundary.
 */
export interface RecordNarrativeBeatResult {
  readonly beat: NarrativeBeat
  readonly view: RunView
}

/** Persist one stable player-facing playback boundary. */
export interface CompletePresentationRequest extends RunRef {
  readonly actorId: EntityId
  readonly beatId: NarrativeBeat['id']
}

/** The authoritative presentation cursor after completing a beat. */
export interface CompletePresentationResult {
  readonly cursor: PresentationCursor
  readonly view: RunView
}

/** One model-authored concrete decision before Runtime attaches executable fields. */
export interface ActionPlanDraft {
  readonly opportunityId: string
  readonly label: string
  readonly intent: string
  readonly storyRole: ActionPlan['storyRole']
}

/** Host-only request to validate and retain the final step of a story turn. */
export interface RecordActionDeckRequest extends RunRef {
  readonly actorId: EntityId
  readonly expectedSequence: number
  readonly afterBeatId: NarrativeBeat['id']
  readonly invocationId: AiInvocation['id']
  readonly plans: readonly ActionPlanDraft[]
}

/** Validated action deck retained in the Run snapshot and stream. */
export interface RecordActionDeckResult {
  readonly deck: ActionDeck
  readonly view: RunView
}

/** Plot assessment committed atomically with the rest of the state-director turn. */
export interface StoryProgressDraft {
  readonly pointId: PlotPointDefinition['id']
  readonly status: StoryProgressEvidence['status']
  readonly rationale: string
  readonly evidence: readonly string[]
  readonly eventIds: NarrativeBeat['eventIds']
  readonly observationIds: NarrativeBeat['observationIds']
}

/** Runtime-validated state and memory proposal derived from one retained story beat. */
export interface RecordStoryStateRequest extends RunRef {
  readonly beatId: NarrativeBeat['id']
  /** Independently inferred world/character slices, atomically validated and committed together. */
  readonly shards: readonly StoryStateShard[]
  readonly progress?: StoryProgressDraft & { readonly invocationId: AiInvocation['id'] }
}

/** Atomic committed story state. */
export interface RecordStoryStateResult {
  readonly commit: StoryStateCommit
  readonly progress?: StoryProgressEvidence
  readonly view: RunView
}

/** Describes the run records request value exchanged across the package boundary.
 */
export interface RunRecordsRequest extends RunRef {
  readonly afterSequence?: number
  readonly afterOrdinal?: number
  readonly limit?: number
  readonly stream?: RunStream
  /** Return the newest matching records while preserving chronological order. */
  readonly tail?: boolean
}
/** Describes the run records page value exchanged across the package boundary.
 */
export interface RunRecordsPage {
  readonly records: readonly RunStreamRecord[]
  readonly nextSequence: number
  readonly nextOrdinal: number
  readonly hasMore: boolean
}

/** Describes the create checkpoint request value exchanged across the package boundary.
 */
export interface CreateCheckpointRequest extends RunRef { readonly label: string }
/** Describes the checkpoint view value exchanged across the package boundary.
 */
export interface CheckpointView {
  readonly checkpoint: Checkpoint
  readonly label: string
  readonly createdAt: string
}
/** Describes the branch run request value exchanged across the package boundary.
 */
export interface BranchRunRequest {
  readonly runId: RunId
  readonly checkpointId: CheckpointId
  readonly seed?: string
}
/** Describes the set actor control request value exchanged across the package boundary.
 */
export interface SetActorControlRequest extends RunRef {
  readonly actorId: EntityId
  readonly mode: ActorControlMode
}
/** Describes the set ai enabled request value exchanged across the package boundary.
 */
export interface SetAiEnabledRequest extends RunRef { readonly enabled: boolean }
/** Describes the switch model policy request value exchanged across the package boundary.
 */
export interface SwitchModelPolicyRequest extends RunRef {
  readonly modelPolicy: ModelPolicy
  readonly expectedSequence: number
}
/** Describes the explain run event request value exchanged across the package boundary.
 */
export interface ExplainRunEventRequest extends RunRef { readonly eventId: string }
/** Describes the run event explanation value exchanged across the package boundary.
 */
export interface RunEventExplanation {
  readonly event?: WorldEvent
  readonly decisions: readonly DecisionTrace[]
  readonly processes: readonly Process[]
  readonly reservations: readonly Reservation[]
  readonly telemetry: readonly Telemetry[]
  readonly summary: string
}

/** Describes the worldline runtime error code value exchanged across the package boundary.
 */
export type WorldlineRuntimeErrorCode =
  | 'run-not-found'
  | 'run-not-live'
  | 'run-conflict'
  | 'action-invalid'
  | 'action-forbidden'
  | 'checkpoint-not-found'
  | 'blueprint-not-frozen'
  | 'worker-failed'

/** Owns the worldline runtime error capability and its lifecycle.
 */
export class WorldlineRuntimeError extends Error {
  constructor(readonly code: WorldlineRuntimeErrorCode, message: string) {
    super(message)
    this.name = 'WorldlineRuntimeError'
  }
}
