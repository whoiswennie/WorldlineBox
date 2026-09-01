import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { Worker, type WorkerOptions } from 'node:worker_threads'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-worldline-project'
import {
  type RunId,
  allocateWorldlineId,
} from '@deepseek-ai/dsh-worldline-standard'
import {
  type AdvanceRunRequest,
  type BranchRunRequest,
  type CheckpointView,
  type CreateCheckpointRequest,
  type CreateRunRequest,
  type ExplainRunEventRequest,
  type RunEventExplanation,
  type RunChoicesRequest,
  type RunChoicesView,
  type RunDefinitionView,
  type RunRecordsPage,
  type RunRecordsRequest,
  type RunSpatialRequest,
  type RunSpatialView,
  type RecordAiIntentRequest,
  type RecordAiIntentResult,
  type RecordAiInvocationRequest,
  type RecordAiInvocationResult,
  type RecordNarrativeBeatRequest,
  type RecordNarrativeBeatResult,
  type RunRef,
  type RunSummary,
  type RunView,
  type SetActorControlRequest,
  type SetAiEnabledRequest,
  type SubmitRunActionRequest,
  type SubmitRunActionResult,
  type SwitchModelPolicyRequest,
  WorldlineRuntimeError,
  WorldlineRuns,
} from '@deepseek-ai/dsh-worldline-runtime'
import type { WorkerCommand, WorkerInit, WorkerRequest, WorkerToHost } from './protocol.ts'

const nodeRequire = createRequire(import.meta.url)

/** Describes the config value exchanged across the package boundary.
 */
export interface Config {
  /** V8 old-generation heap ceiling applied independently to each Run worker. */
  readonly maxOldGenerationSizeMb: number
  /** Maximum milliseconds allowed for one Host-to-worker request. */
  readonly requestTimeoutMs: number
}

/** Perform worker spawn env through the package's public contract.
 * @param platform - The platform supplied by the caller.
 * @param tsconfigPath - The tsconfig path supplied by the caller.
 * @returns The result produced by the operation.
 */
export function workerSpawnEnv(
  platform: NodeJS.Platform = process.platform,
  tsconfigPath?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (platform === 'win32') { env.TMP = tmpdir(); env.TEMP = tmpdir() }
  if (tsconfigPath !== undefined) env.TSX_TSCONFIG_PATH = tsconfigPath
  return env
}

function resolveWorkerSpawn(init: WorkerInit, maxOldGenerationSizeMb: number): {
  readonly entry: string | URL
  readonly options: WorkerOptions
} {
  const limits = { maxOldGenerationSizeMb }
  /* v8 ignore next 3 -- built output is covered by the built-worker integration gate. */
  if (!import.meta.url.endsWith('.ts')) {
    return {
      entry: fileURLToPath(new URL('./worker.cjs', import.meta.url)),
      options: { workerData: init, env: workerSpawnEnv(), execArgv: [], resourceLimits: limits },
    }
  }
  const workerEntry = new URL('./worker.ts', import.meta.url)
  const esm = pathToFileURL(nodeRequire.resolve('tsx/esm/api')).href
  const cjs = pathToFileURL(nodeRequire.resolve('tsx/cjs/api')).href
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(esm)}`,
    `import { register as registerCjs } from ${JSON.stringify(cjs)}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(workerEntry.href)})`,
  ].join('\n')
  return {
    entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),
    options: {
      workerData: init,
      env: workerSpawnEnv(undefined, process.env.TSX_TSCONFIG_PATH),
      execArgv: [],
      resourceLimits: limits,
    },
  }
}

class WorkerRunHandle {
  readonly ready: Promise<RunView>
  private readyResolve!: (view: RunView) => void
  private readyReject!: (error: Error) => void
  private readonly worker: Worker
  private requestId = 0
  private closed = false
  private shutdown?: Promise<void>
  private readonly pending = new Map<number, {
    readonly resolve: (value: unknown) => void
    readonly reject: (error: Error) => void
    readonly timer: ReturnType<typeof setTimeout>
  }>()

  constructor(
    readonly init: WorkerInit,
    maxOldGenerationSizeMb: number,
    private readonly timeoutMs: number,
    private readonly onFailure: (handle: WorkerRunHandle) => void,
  ) {
    this.ready = new Promise<RunView>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    const spawn = resolveWorkerSpawn(init, maxOldGenerationSizeMb)
    this.worker = new Worker(spawn.entry, spawn.options)
    this.worker.on('message', (message: WorkerToHost) => { this.onMessage(message) })
    this.worker.on('error', (error) => { this.fail(error) })
    this.worker.on('messageerror', (error) => { this.fail(new Error(String(error))) })
    this.worker.on('exit', (code) => {
      if (!this.closed) this.fail(new Error(`Worldline Runtime Worker exited unexpectedly with code ${String(code)}`))
    })
  }

  call<T>(command: WorkerCommand): Promise<T> {
    if (this.closed) return Promise.reject(new WorldlineRuntimeError('run-not-live', 'Run Worker is closed'))
    const id = this.requestId
    this.requestId += 1
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new WorldlineRuntimeError('worker-failed', `Runtime Worker request timed out: ${command.type}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      try {
        this.worker.postMessage({ type: 'request', id, command } satisfies WorkerRequest)
      } catch (reason) {
        this.fail(reason instanceof Error ? reason : new Error(String(reason)))
      }
    })
  }

  async terminate(): Promise<void> {
    if (this.shutdown === undefined) {
      this.closed = true
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new WorldlineRuntimeError('run-not-live', 'Run Worker terminated'))
      }
      this.pending.clear()
      this.shutdown = this.worker.terminate().then(() => undefined)
    }
    await this.shutdown
  }

  private onMessage(message: WorkerToHost): void {
    if (message.type === 'ready') { this.readyResolve(message.value as RunView); return }
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.value)
    else pending.reject(new WorldlineRuntimeError(
      (message.code ?? 'worker-failed') as ConstructorParameters<typeof WorldlineRuntimeError>[0],
      message.error,
    ))
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    const failure = error instanceof WorldlineRuntimeError
      ? error
      : new WorldlineRuntimeError('worker-failed', error.message)
    this.readyReject(failure)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure) }
    this.pending.clear()
    this.onFailure(this)
    this.shutdown = this.worker.terminate().then(() => undefined).catch(() => {})
  }
}

/** Host supervisor that owns Worker lifecycles while every Run Worker exclusively owns its SQLite handle. */
export default class WorkerWorldlineRuns extends WorldlineRuns {
  static inject = ['worldlineProjects']
  static Config: z<Config> = z.object({
    maxOldGenerationSizeMb: z.natural().min(64).default(512),
    requestTimeoutMs: z.natural().min(1000).default(30_000),
  })

  private readonly handles = new Map<RunId, WorkerRunHandle>()

  constructor(private readonly context: Context, private readonly config: Config) {
    super(context)
    context.effect(() => async () => {
      const handles = [...this.handles.values()]
      this.handles.clear()
      await Promise.allSettled(handles.map(handle => handle.terminate()))
    }, 'worldline Runtime Workers')
  }

  override async create(request: CreateRunRequest): Promise<RunView> {
    const build = await this.context.worldlineProjects.activeBuild(request.projectId)
    if (build === undefined) {
      throw new WorldlineRuntimeError('blueprint-not-frozen', 'freeze a Blueprint before creating a Run')
    }
    const runId = allocateWorldlineId<'run'>('run')
    const storage = await this.context.worldlineProjects.runStorage(request.projectId, runId)
    const handle = this.spawn({
      projectId: request.projectId,
      runId,
      blueprintPath: build.blueprintPath,
      databasePath: storage.databasePath,
      seed: request.seed,
      startPaused: request.startPaused !== false,
      ...(request.modelPolicy === undefined ? {} : { modelPolicy: request.modelPolicy }),
      ...(request.aiBudget === undefined ? {} : { aiBudget: request.aiBudget }),
    })
    return handle.ready
  }

  override async list(): Promise<readonly RunSummary[]> {
    await this.recoverAll()
    const views = await Promise.all([...this.handles.values()].map(handle => handle.call<RunView>({ type: 'view' })))
    return views.map(view => view.summary).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  override async view(request: RunRef): Promise<RunView> {
    return (await this.handle(request.runId)).call({ type: 'view' })
  }

  override async definition(request: RunRef): Promise<RunDefinitionView> {
    return (await this.handle(request.runId)).call({ type: 'definition' })
  }

  override async spatial(request: RunSpatialRequest): Promise<RunSpatialView> {
    return (await this.handle(request.runId)).call({ type: 'spatial', payload: request })
  }

  override async choices(request: RunChoicesRequest): Promise<RunChoicesView> {
    return (await this.handle(request.runId)).call({ type: 'choices', payload: request })
  }

  override async advance(request: AdvanceRunRequest): Promise<RunView> {
    return (await this.handle(request.runId)).call({ type: 'advance', payload: request })
  }

  override async submitAction(request: SubmitRunActionRequest): Promise<SubmitRunActionResult> {
    return (await this.handle(request.runId)).call({ type: 'submit-action', payload: request })
  }

  override async pause(request: RunRef): Promise<RunView> {
    return (await this.handle(request.runId)).call({ type: 'pause' })
  }

  override async resume(request: RunRef): Promise<RunView> {
    return (await this.handle(request.runId)).call({ type: 'resume' })
  }

  override async stop(request: RunRef): Promise<RunSummary> {
    const handle = await this.handle(request.runId)
    const summary = await handle.call<RunSummary>({ type: 'stop' })
    await handle.terminate()
    this.handles.delete(request.runId)
    return summary
  }

  override async records(request: RunRecordsRequest): Promise<RunRecordsPage> {
    return (await this.handle(request.runId)).call({ type: 'records', payload: request })
  }

  override async checkpoint(request: CreateCheckpointRequest): Promise<CheckpointView> {
    return (await this.handle(request.runId)).call({ type: 'checkpoint', payload: request })
  }

  override async checkpoints(request: RunRef): Promise<readonly CheckpointView[]> {
    return (await this.handle(request.runId)).call({ type: 'checkpoints' })
  }

  override async branch(request: BranchRunRequest): Promise<RunView> {
    const source = await this.handle(request.runId)
    const checkpoints = await source.call<readonly CheckpointView[]>({ type: 'checkpoints' })
    const checkpoint = checkpoints.find(item => item.checkpoint.id === request.checkpointId)
    if (checkpoint === undefined) {
      throw new WorldlineRuntimeError('checkpoint-not-found', `checkpoint not found: ${request.checkpointId}`)
    }
    const runId = allocateWorldlineId<'run'>('run')
    const branchId = allocateWorldlineId<'worldline'>('worldline')
    const sourceView = await source.call<RunView>({ type: 'view' })
    const storage = await this.context.worldlineProjects.runStorage(sourceView.summary.projectId, runId)
    const snapshot = {
      ...checkpoint.checkpoint.snapshot,
      runId,
      branchId,
      parentRunId: request.runId,
      forkSequence: checkpoint.checkpoint.sequence,
      seed: request.seed ?? checkpoint.checkpoint.snapshot.seed,
    }
    const handle = this.spawn({
      projectId: sourceView.summary.projectId,
      runId,
      blueprintPath: source.init.blueprintPath,
      databasePath: storage.databasePath,
      seed: snapshot.seed,
      startPaused: true,
      resumeSnapshot: snapshot,
      parentRunId: request.runId,
      forkSequence: checkpoint.checkpoint.sequence,
      controls: sourceView.controls,
    })
    return handle.ready
  }

  override async setControl(request: SetActorControlRequest): Promise<RunView> {
    return (await this.handle(request.runId)).call({ type: 'set-control', payload: request })
  }

  override async setAiEnabled(request: SetAiEnabledRequest): Promise<RunView> {
    return (await this.handle(request.runId)).call({ type: 'set-ai', payload: request })
  }

  override async switchModel(request: SwitchModelPolicyRequest): Promise<RunView> {
    return (await this.handle(request.runId)).call({ type: 'switch-model', payload: request })
  }

  override async explain(request: ExplainRunEventRequest): Promise<RunEventExplanation> {
    return (await this.handle(request.runId)).call({ type: 'explain', payload: request })
  }

  override async recordAiIntent(request: RecordAiIntentRequest): Promise<RecordAiIntentResult> {
    return (await this.handle(request.runId)).call({ type: 'record-ai-intent', payload: request })
  }

  override async recordAiInvocation(request: RecordAiInvocationRequest): Promise<RecordAiInvocationResult> {
    return (await this.handle(request.runId)).call({ type: 'record-ai-invocation', payload: request })
  }

  override async recordNarrativeBeat(request: RecordNarrativeBeatRequest): Promise<RecordNarrativeBeatResult> {
    return (await this.handle(request.runId)).call({ type: 'record-narrative-beat', payload: request })
  }

  private spawn(init: WorkerInit): WorkerRunHandle {
    if (this.handles.has(init.runId)) throw new WorldlineRuntimeError('run-conflict', `Run is already open: ${init.runId}`)
    const handle = new WorkerRunHandle(
      init,
      this.config.maxOldGenerationSizeMb,
      this.config.requestTimeoutMs,
      (failed) => {
        if (this.handles.get(init.runId) === failed) this.handles.delete(init.runId)
      },
    )
    this.handles.set(init.runId, handle)
    void handle.ready.catch(() => {})
    return handle
  }

  private async handle(runId: RunId): Promise<WorkerRunHandle> {
    const existing = this.handles.get(runId)
    if (existing !== undefined) return existing
    const storage = (await this.context.worldlineProjects.runStorages()).find(item => item.runId === runId)
    if (storage === undefined) throw new WorldlineRuntimeError('run-not-found', `Run not found: ${runId}`)
    const retainedBlueprint = `${dirname(storage.databasePath)}/blueprint.json`
    const handle = this.spawn({
      projectId: storage.projectId,
      runId: storage.runId,
      blueprintPath: retainedBlueprint,
      databasePath: storage.databasePath,
      seed: 'resume-from-snapshot',
      startPaused: true,
    })
    await handle.ready
    return handle
  }

  private async recoverAll(): Promise<void> {
    for (const storage of await this.context.worldlineProjects.runStorages()) {
      if (!this.handles.has(storage.runId)) await this.handle(storage.runId)
    }
  }
}

export { WorkerWorldlineRuns }
export type { WorkerInit, WorkerCommand } from './protocol.ts'
