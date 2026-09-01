import type {
  ActionId,
  AiBudget,
  AiUsage,
  CanonWorldlineId,
  Checkpoint,
  CheckpointId,
  DecisionTrace,
  EntityId,
  JsonObject,
  ModelPolicy,
  Process,
  ProjectId,
  Reservation,
  RunId,
  RunSnapshot,
  Telemetry,
  WorldEvent,
} from '@deepseek-ai/dsh-worldline-standard'
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

export interface CreateRunRequest {
  readonly projectId: ProjectId
  readonly seed: string
  readonly modelPolicy?: ModelPolicy
  readonly aiBudget?: AiBudget
  readonly startPaused?: boolean
}

export interface RunRef { readonly runId: RunId }
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
