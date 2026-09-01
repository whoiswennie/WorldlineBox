import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AdvanceRunRequest,
  BranchRunRequest,
  CheckpointView,
  CreateCheckpointRequest,
  CreateRunRequest,
  ExplainRunEventRequest,
  RunEventExplanation,
  RunChoicesRequest,
  RunChoicesView,
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
  RunRef,
  RunSummary,
  RunView,
  SetActorControlRequest,
  SetAiEnabledRequest,
  SubmitRunActionRequest,
  SubmitRunActionResult,
  SwitchModelPolicyRequest,
} from './types.ts'

export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { worldlineRuns: WorldlineRuns }
}

/** Replaceable Host Run supervisor; the generated Remote face never exposes paths or Worker handles. */
export abstract class WorldlineRuns extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'worldlineRuns') }

  abstract create(request: CreateRunRequest): Promise<RunView>
  abstract list(): Promise<readonly RunSummary[]>
  abstract view(request: RunRef): Promise<RunView>
  abstract spatial(request: RunSpatialRequest): Promise<RunSpatialView>
  abstract choices(request: RunChoicesRequest): Promise<RunChoicesView>
  abstract advance(request: AdvanceRunRequest): Promise<RunView>
  abstract submitAction(request: SubmitRunActionRequest): Promise<SubmitRunActionResult>
  abstract pause(request: RunRef): Promise<RunView>
  abstract resume(request: RunRef): Promise<RunView>
  abstract stop(request: RunRef): Promise<RunSummary>
  abstract records(request: RunRecordsRequest): Promise<RunRecordsPage>
  abstract checkpoint(request: CreateCheckpointRequest): Promise<CheckpointView>
  abstract checkpoints(request: RunRef): Promise<readonly CheckpointView[]>
  abstract branch(request: BranchRunRequest): Promise<RunView>
  abstract setControl(request: SetActorControlRequest): Promise<RunView>
  abstract setAiEnabled(request: SetAiEnabledRequest): Promise<RunView>
  abstract switchModel(request: SwitchModelPolicyRequest): Promise<RunView>
  abstract explain(request: ExplainRunEventRequest): Promise<RunEventExplanation>
  /** Host-only: persist a model intent and its actual usage before attempting its Action. */
  abstract recordAiIntent(request: RecordAiIntentRequest): Promise<RecordAiIntentResult>
  /** Host-only: account every routed call, regardless of whether it yields an intent. */
  abstract recordAiInvocation(request: RecordAiInvocationRequest): Promise<RecordAiInvocationResult>
  /** Host-only: persist prose derived from retained events/observations without changing world state. */
  abstract recordNarrativeBeat(request: RecordNarrativeBeatRequest): Promise<RecordNarrativeBeatResult>

  @Remote('create') remoteCreate(value: CreateRunRequest): Promise<RunView> { return this.create(value) }
  @Remote('list') remoteList(): Promise<readonly RunSummary[]> { return this.list() }
  @Remote('view') remoteView(value: RunRef): Promise<RunView> { return this.view(value) }
  @Remote('spatial') remoteSpatial(value: RunSpatialRequest): Promise<RunSpatialView> { return this.spatial(value) }
  @Remote('choices') remoteChoices(value: RunChoicesRequest): Promise<RunChoicesView> { return this.choices(value) }
  @Remote('advance') remoteAdvance(value: AdvanceRunRequest): Promise<RunView> { return this.advance(value) }
  @Remote('submitAction') remoteSubmitAction(value: SubmitRunActionRequest): Promise<SubmitRunActionResult> { return this.submitAction(value) }
  @Remote('pause') remotePause(value: RunRef): Promise<RunView> { return this.pause(value) }
  @Remote('resume') remoteResume(value: RunRef): Promise<RunView> { return this.resume(value) }
  @Remote('stop') remoteStop(value: RunRef): Promise<RunSummary> { return this.stop(value) }
  @Remote('records') remoteRecords(value: RunRecordsRequest): Promise<RunRecordsPage> { return this.records(value) }
  @Remote('checkpoint') remoteCheckpoint(value: CreateCheckpointRequest): Promise<CheckpointView> { return this.checkpoint(value) }
  @Remote('checkpoints') remoteCheckpoints(value: RunRef): Promise<readonly CheckpointView[]> { return this.checkpoints(value) }
  @Remote('branch') remoteBranch(value: BranchRunRequest): Promise<RunView> { return this.branch(value) }
  @Remote('setControl') remoteSetControl(value: SetActorControlRequest): Promise<RunView> { return this.setControl(value) }
  @Remote('setAiEnabled') remoteSetAiEnabled(value: SetAiEnabledRequest): Promise<RunView> { return this.setAiEnabled(value) }
  @Remote('switchModel') remoteSwitchModel(value: SwitchModelPolicyRequest): Promise<RunView> { return this.switchModel(value) }
  @Remote('explain') remoteExplain(value: ExplainRunEventRequest): Promise<RunEventExplanation> { return this.explain(value) }
}

export default WorldlineRuns
