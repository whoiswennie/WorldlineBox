import type { AiBudget, ModelPolicy, ProjectId, RunId, RunSnapshot } from '@deepseek-ai/dsh-worldline-standard'
import type {
  ActorControlMode,
  AdvanceRunRequest,
  CreateCheckpointRequest,
  ExplainRunEventRequest,
  RunRecordsRequest,
  SetActorControlRequest,
  SetAiEnabledRequest,
  SubmitRunActionRequest,
  SwitchModelPolicyRequest,
} from '@deepseek-ai/dsh-worldline-runtime'

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

export type WorkerCommand =
  | { readonly type: 'view' }
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
  | { readonly type: 'switch-model'; readonly payload: SwitchModelPolicyRequest }
  | { readonly type: 'explain'; readonly payload: ExplainRunEventRequest }

export interface WorkerRequest {
  readonly type: 'request'
  readonly id: number
  readonly command: WorkerCommand
}

export type WorkerToHost =
  | { readonly type: 'ready'; readonly value: unknown }
  | { readonly type: 'response'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: 'response'; readonly id: number; readonly ok: false; readonly error: string; readonly code?: string }
