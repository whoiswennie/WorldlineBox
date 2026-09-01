import type { AiBudget, ModelPolicy, ProjectId, RunId, RunSnapshot } from '@deepseek-ai/dsh-worldline-standard'
import type {
  ActorControlMode,
  AdvanceRunRequest,
  CreateCheckpointRequest,
  ExplainRunEventRequest,
  RunRecordsRequest,
  RunSpatialRequest,
  RecordAiIntentRequest,
  RecordAiInvocationRequest,
  RecordNarrativeBeatRequest,
  RunChoicesRequest,
  SetActorControlRequest,
  SetAiBudgetRequest,
  SetAiEnabledRequest,
  SubmitRunActionRequest,
  SwitchModelPolicyRequest,
} from '@deepseek-ai/dsh-worldline-runtime'

/** Describes the worker init value exchanged across the package boundary.
 */
export interface WorkerInit {
  readonly projectId: ProjectId
  readonly runId: RunId
  readonly blueprintPath: string
  readonly databasePath: string
  readonly seed: string
  readonly startPaused: boolean
  readonly modelPolicy?: ModelPolicy
  readonly aiBudget?: AiBudget
  readonly resumeSnapshot?: RunSnapshot
  readonly parentRunId?: RunId
  readonly forkSequence?: number
  readonly controls?: Readonly<Record<string, ActorControlMode>>
}

/** Describes the worker command value exchanged across the package boundary.
 */
export type WorkerCommand =
  | { readonly type: 'view' }
  | { readonly type: 'definition' }
  | { readonly type: 'spatial'; readonly payload: RunSpatialRequest }
  | { readonly type: 'choices'; readonly payload: RunChoicesRequest }
  | { readonly type: 'advance'; readonly payload: AdvanceRunRequest }
  | { readonly type: 'submit-action'; readonly payload: SubmitRunActionRequest }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'stop' }
  | { readonly type: 'records'; readonly payload: RunRecordsRequest }
  | { readonly type: 'checkpoint'; readonly payload: CreateCheckpointRequest }
  | { readonly type: 'checkpoints' }
  | { readonly type: 'set-control'; readonly payload: SetActorControlRequest }
  | { readonly type: 'set-ai'; readonly payload: SetAiEnabledRequest }
  | { readonly type: 'set-ai-budget'; readonly payload: SetAiBudgetRequest }
  | { readonly type: 'switch-model'; readonly payload: SwitchModelPolicyRequest }
  | { readonly type: 'explain'; readonly payload: ExplainRunEventRequest }
  | { readonly type: 'record-ai-intent'; readonly payload: RecordAiIntentRequest }
  | { readonly type: 'record-ai-invocation'; readonly payload: RecordAiInvocationRequest }
  | { readonly type: 'record-narrative-beat'; readonly payload: RecordNarrativeBeatRequest }

/** Describes the worker request value exchanged across the package boundary.
 */
export interface WorkerRequest {
  readonly type: 'request'
  readonly id: number
  readonly command: WorkerCommand
}

/** Describes the worker to host value exchanged across the package boundary.
 */
export type WorkerToHost =
  | { readonly type: 'ready'; readonly value: unknown }
  | { readonly type: 'response'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: 'response'; readonly id: number; readonly ok: false; readonly error: string; readonly code?: string }
