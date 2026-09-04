import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AdvanceRunRequest,
  BranchRunRequest,
  CheckpointView,
  CompletePresentationRequest,
  CompletePresentationResult,
  CreateCheckpointRequest,
  CreateRunRequest,
  ExplainRunEventRequest,
  RunEventExplanation,
  RunDefinitionView,
  RunChoicesRequest,
  RunChoicesView,
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

  /** Create a Run from a validated compiled blueprint.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract create(request: CreateRunRequest): Promise<RunView>
  /** List Runs from the authoritative Host registry.
   * @returns The result produced by the operation.
   */
  abstract list(): Promise<readonly RunSummary[]>
  /** Return the current authoritative view of a Run.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract view(request: RunRef): Promise<RunView>
  /** Return the immutable definition used to create a Run.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract definition(request: RunRef): Promise<RunDefinitionView>
  /** Return the current spatial state of a Run.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract spatial(request: RunSpatialRequest): Promise<RunSpatialView>
  /** Return the actions currently available to the controlled actor.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract choices(request: RunChoicesRequest): Promise<RunChoicesView>
  /** Advance deterministic simulation time for a Run.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract advance(request: AdvanceRunRequest): Promise<RunView>
  /** Run bounded deterministic actor cycles inside the owning Runtime worker.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract simulate(request: SimulateRunRequest): Promise<SimulateRunResult>
  /** Apply submit action through the package's validated ownership boundary.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract submitAction(request: SubmitRunActionRequest): Promise<SubmitRunActionResult>
  /** Pause a running Run.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract pause(request: RunRef): Promise<RunView>
  /** Resume a paused Run.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract resume(request: RunRef): Promise<RunView>
  /** Stop a Run and release its worker resources.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract stop(request: RunRef): Promise<RunSummary>
  /** Read a filtered page from the append-only Run record stream.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract records(request: RunRecordsRequest): Promise<RunRecordsPage>
  /** Create a named checkpoint for the current Run state.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract checkpoint(request: CreateCheckpointRequest): Promise<CheckpointView>
  /** List checkpoints stored for a Run.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract checkpoints(request: RunRef): Promise<readonly CheckpointView[]>
  /** Branch a new Run from an existing checkpoint.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract branch(request: BranchRunRequest): Promise<RunView>
  /** Change an actor's control mode through the Run supervisor.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract setControl(request: SetActorControlRequest): Promise<RunView>
  /** Enable or disable AI participation for a Run.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract setAiEnabled(request: SetAiEnabledRequest): Promise<RunView>
  /** Perform switch model through the package's public contract.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract switchModel(request: SwitchModelPolicyRequest): Promise<RunView>
  /** Explain a recorded Run event from authoritative inputs.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract explain(request: ExplainRunEventRequest): Promise<RunEventExplanation>
  /** Host-only: persist a model intent and its actual usage before attempting its Action.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract recordAiIntent(request: RecordAiIntentRequest): Promise<RecordAiIntentResult>
  /** Host-only: account every routed call, regardless of whether it yields an intent.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract recordAiInvocation(request: RecordAiInvocationRequest): Promise<RecordAiInvocationResult>
  /** Host-only: persist prose derived from retained events/observations without changing world state.
   * @param request - The request supplied by the caller.
   * @returns The result produced by the operation.
   */
  abstract recordNarrativeBeat(request: RecordNarrativeBeatRequest): Promise<RecordNarrativeBeatResult>
  /** Persist that a player has fully presented one retained narrative beat.
   * @param request - The completed beat and perspective actor.
   * @returns The durable presentation cursor and resulting Run sequence.
   */
  abstract completePresentation(
    request: CompletePresentationRequest,
  ): Promise<CompletePresentationResult>
  /** Validate and retain a model-authored action deck for the current story pause.
   * @param request - Three creative plans bound to current legal opportunities.
   * @returns The retained action deck and resulting Run sequence.
   */
  abstract recordActionDeck(request: RecordActionDeckRequest): Promise<RecordActionDeckResult>
  /** Validate and atomically retain schema-constrained soft state and memories.
   * @param request - Mutations, memory writes, and optional plot evidence for one retained beat.
   * @returns The committed story state and resulting Run sequence.
   */
  abstract recordStoryState(request: RecordStoryStateRequest): Promise<RecordStoryStateResult>

  /** Perform remote create through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('create') remoteCreate(value: CreateRunRequest): Promise<RunView> { return this.create(value) }
  /** Perform remote list through the package's public contract.
   * @returns The result produced by the operation.
   */
  @Remote('list') remoteList(): Promise<readonly RunSummary[]> { return this.list() }
  /** Perform remote view through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('view') remoteView(value: RunRef): Promise<RunView> { return this.view(value) }
  /** Perform remote definition through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('definition') remoteDefinition(value: RunRef): Promise<RunDefinitionView> { return this.definition(value) }
  /** Perform remote spatial through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('spatial') remoteSpatial(value: RunSpatialRequest): Promise<RunSpatialView> { return this.spatial(value) }
  /** Perform remote choices through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('choices') remoteChoices(value: RunChoicesRequest): Promise<RunChoicesView> { return this.choices(value) }
  /** Perform remote advance through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('advance') remoteAdvance(value: AdvanceRunRequest): Promise<RunView> { return this.advance(value) }
  /** Run bounded autonomous cycles without routing through an Agent or model.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('simulate') remoteSimulate(value: SimulateRunRequest): Promise<SimulateRunResult> {
    return this.simulate(value)
  }
  /** Perform remote submit action through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('submitAction') remoteSubmitAction(value: SubmitRunActionRequest): Promise<SubmitRunActionResult> { return this.submitAction(value) }
  /** Perform remote pause through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('pause') remotePause(value: RunRef): Promise<RunView> { return this.pause(value) }
  /** Perform remote resume through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('resume') remoteResume(value: RunRef): Promise<RunView> { return this.resume(value) }
  /** Perform remote stop through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('stop') remoteStop(value: RunRef): Promise<RunSummary> { return this.stop(value) }
  /** Perform remote records through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('records') remoteRecords(value: RunRecordsRequest): Promise<RunRecordsPage> { return this.records(value) }
  /** Perform remote checkpoint through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('checkpoint') remoteCheckpoint(value: CreateCheckpointRequest): Promise<CheckpointView> { return this.checkpoint(value) }
  /** Perform remote checkpoints through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('checkpoints') remoteCheckpoints(value: RunRef): Promise<readonly CheckpointView[]> { return this.checkpoints(value) }
  /** Perform remote branch through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('branch') remoteBranch(value: BranchRunRequest): Promise<RunView> { return this.branch(value) }
  /** Perform remote set control through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('setControl') remoteSetControl(value: SetActorControlRequest): Promise<RunView> { return this.setControl(value) }
  /** Perform remote set ai enabled through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('setAiEnabled') remoteSetAiEnabled(value: SetAiEnabledRequest): Promise<RunView> { return this.setAiEnabled(value) }
  /** Perform remote switch model through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('switchModel') remoteSwitchModel(value: SwitchModelPolicyRequest): Promise<RunView> { return this.switchModel(value) }
  /** Perform remote explain through the package's public contract.
   * @param value - The value supplied by the caller.
   * @returns The result produced by the operation.
   */
  @Remote('explain') remoteExplain(value: ExplainRunEventRequest): Promise<RunEventExplanation> { return this.explain(value) }
  /** Persist a stable presentation boundary through the generated Remote face.
   * @param value - The completed beat and perspective actor.
   * @returns The durable presentation cursor and resulting Run sequence.
   */
  @Remote('completePresentation') remoteCompletePresentation(
    value: CompletePresentationRequest,
  ): Promise<CompletePresentationResult> { return this.completePresentation(value) }
}

export default WorldlineRuns
