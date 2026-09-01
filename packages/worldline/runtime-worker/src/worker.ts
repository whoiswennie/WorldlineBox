import { copyFile, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import type { Blueprint } from '@deepseek-ai/dsh-worldline-standard'
import { WorldlineKernel } from './kernel.ts'
import type { WorkerCommand, WorkerInit, WorkerRequest, WorkerToHost } from './protocol.ts'

function execute(kernel: WorldlineKernel, command: WorkerCommand): unknown {
  if (command.type === 'view') return kernel.view()
  if (command.type === 'definition') return kernel.definitionView()
  if (command.type === 'spatial') return kernel.spatial(command.payload)
  if (command.type === 'choices') return kernel.choices(command.payload)
  if (command.type === 'advance') return kernel.advance(command.payload)
  if (command.type === 'submit-action') return kernel.submitAction(command.payload)
  if (command.type === 'pause') return kernel.pause()
  if (command.type === 'resume') return kernel.resume()
  if (command.type === 'records') return kernel.records(command.payload)
  if (command.type === 'checkpoint') return kernel.checkpoint(command.payload)
  if (command.type === 'checkpoints') return kernel.checkpoints()
  if (command.type === 'set-control') return kernel.setControl(command.payload)
  if (command.type === 'set-ai') return kernel.setAiEnabled(command.payload)
  if (command.type === 'set-ai-budget') return kernel.setAiBudget(command.payload)
  if (command.type === 'switch-model') return kernel.switchModel(command.payload)
  if (command.type === 'explain') return kernel.explain(command.payload)
  if (command.type === 'record-ai-intent') return kernel.recordAiIntent(command.payload)
  if (command.type === 'record-ai-invocation') return kernel.recordAiInvocation(command.payload)
  if (command.type === 'record-narrative-beat') return kernel.recordNarrativeBeat(command.payload)
  const summary = kernel.summary()
  kernel.close()
  return { ...summary, status: 'stopped' }
}

async function runWorker(): Promise<void> {
  if (parentPort === null) throw new Error('Worldline Runtime Worker requires a parent port')
  const port = parentPort
  const init = workerData as WorkerInit
  const source = init.blueprintPath
  const retained = resolve(dirname(init.databasePath), 'blueprint.json')
  if (source !== retained) await copyFile(source, retained)
  const blueprint = JSON.parse(await readFile(retained, 'utf8')) as Blueprint
  if (blueprint.digest !== init.resumeSnapshot?.blueprintDigest && init.resumeSnapshot !== undefined) {
    throw new Error('retained Blueprint does not match the resumed Run snapshot')
  }
  const kernel = new WorldlineKernel({
    projectId: init.projectId,
    runId: init.runId,
    blueprint,
    databasePath: init.databasePath,
    seed: init.seed,
    startPaused: init.startPaused,
    ...(init.modelPolicy === undefined ? {} : { modelPolicy: init.modelPolicy }),
    ...(init.aiBudget === undefined ? {} : { aiBudget: init.aiBudget }),
    ...(init.resumeSnapshot === undefined ? {} : { resumeSnapshot: init.resumeSnapshot }),
    ...(init.parentRunId === undefined ? {} : { parentRunId: init.parentRunId }),
    ...(init.forkSequence === undefined ? {} : { forkSequence: init.forkSequence }),
    ...(init.controls === undefined ? {} : { controls: init.controls }),
  })
  port.on('message', (message: WorkerRequest) => {
    try {
      const response: WorkerToHost = {
        type: 'response',
        id: message.id,
        ok: true,
        value: execute(kernel, message.command),
      }
      port.postMessage(response)
    } catch (error) {
      const response: WorkerToHost = {
        type: 'response',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...typeof (error as { code?: unknown } | null)?.code === 'string'
          ? { code: (error as { code: string }).code }
          : {},
      }
      port.postMessage(response)
    }
  })
  port.postMessage({ type: 'ready', value: kernel.view() } satisfies WorkerToHost)
}

void runWorker().catch((error: unknown) => {
  setImmediate(() => { throw error })
})
