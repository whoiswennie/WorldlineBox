import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from './desktop-services.ts'
import {
  startRuntimeProcess,
  type RuntimeExit,
  type RuntimeProcess,
  type RuntimeProcessOptions,
} from './runtime-process.ts'
import { TENANT_RESTART_EXIT_CODE } from './tenant-runtime.ts'
import type { HostGeneration } from './host-supervisor.ts'

const DEFAULT_HEALTHY_RUNTIME_MS = 30_000
const DEFAULT_MAX_RESTART_DELAY_MS = 30_000

export interface RuntimeLaunchRecipe {
  options: () => RuntimeProcessOptions | Promise<RuntimeProcessOptions>
  onRestarted: (url: string) => void | Promise<void>
}

export interface DesktopRuntimeSupervisorConfig {
  spawn?: (options: RuntimeProcessOptions) => RuntimeProcess
  healthyRuntimeMs?: number
  baseRestartDelayMs?: number
  maxRestartDelayMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cordis-owned lifecycle and recovery for the external Agent runtime. */
    desktopRuntimeSupervisor: DesktopRuntimeSupervisor
  }
}

/** Exponential crash-loop backoff; an intentional account handoff is immediate. */
export function runtimeRestartDelayMs(
  code: number | null,
  attempt: number,
  baseDelayMs = 1_000,
  maxDelayMs = DEFAULT_MAX_RESTART_DELAY_MS,
): number {
  if (code === TENANT_RESTART_EXIT_CODE) return 0
  return Math.min(baseDelayMs * 2 ** Math.min(Math.max(attempt, 0), 5), maxDelayMs)
}

/**
 * Desktop host-plane plugin for the process shared by every Agent session.
 * It owns spawn, diagnostics, restart backoff, page reconnection, and cleanup;
 * the Electron entry point only supplies deployment-specific launch options.
 */
export class DesktopRuntimeSupervisor extends Service {
  static inject = ['timer', 'desktopRuntimeBridge']

  private readonly spawnRuntime: (options: RuntimeProcessOptions) => RuntimeProcess
  private readonly healthyRuntimeMs: number
  private readonly baseRestartDelayMs: number
  private readonly maxRestartDelayMs: number
  private currentRuntime: RuntimeProcess | undefined
  private readyGeneration: HostGeneration | undefined
  private generationSequence = 0
  private transactionRestart: Promise<HostGeneration> | undefined
  private recipe: RuntimeLaunchRecipe | undefined
  private recovering: Promise<void> | undefined
  private stopping = false

  private isStopping(): boolean {
    return this.stopping
  }
  private restartAttempt = 0
  private lastExitCode: number | null = null

  /** Current ready generation exposed to Desktop lifecycle consumers. */
  get current(): HostGeneration | undefined {
    return this.readyGeneration
  }

  constructor(ctx: Context, config: DesktopRuntimeSupervisorConfig = {}) {
    super(ctx, 'desktopRuntimeSupervisor')
    this.spawnRuntime = config.spawn ?? startRuntimeProcess
    this.healthyRuntimeMs = config.healthyRuntimeMs ?? DEFAULT_HEALTHY_RUNTIME_MS
    this.baseRestartDelayMs = config.baseRestartDelayMs ?? 1_000
    this.maxRestartDelayMs = config.maxRestartDelayMs ?? DEFAULT_MAX_RESTART_DELAY_MS
    ctx.effect(() => async () => { await this.stop() }, 'desktop-runtime-supervisor: stop runtime')
  }

  /** Configure launch authority before startup recovery may need a Host. */
  configure(recipe: RuntimeLaunchRecipe): void {
    if (this.recipe !== undefined) throw new Error('desktop Agent runtime launch recipe is already configured')
    this.recipe = recipe
  }

  /** Start the first runtime and arm plugin-owned recovery for later exits. */
  async start(recipe?: RuntimeLaunchRecipe): Promise<string> {
    if (recipe !== undefined) this.configure(recipe)
    if (this.recipe === undefined) throw new Error('desktop Agent runtime launch recipe is unavailable')
    if (this.currentRuntime !== undefined) throw new Error('desktop Agent runtime is already supervised')
    this.stopping = false
    this.ctx.desktopRuntimeBridge.publish({ stage: 'serving' })
    const { url } = await this.launchOne()
    this.ctx.desktopRuntimeBridge.publish({ stage: 'ready' })
    return url
  }

  /** Stop recovery and the current child; idempotent and owned by Fiber disposal. */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.ctx.desktopRuntimeBridge.publish({ stage: 'stopping' })
    const active = this.currentRuntime
    this.currentRuntime = undefined
    this.readyGeneration = undefined
    if (active !== undefined) await active.stop()
  }

  /** HostSupervisor-compatible shutdown alias used by recovery and application updates. */
  async shutdown(): Promise<void> {
    await this.stop()
  }

  /**
   * Serialize a trusted stop/mutate/start boundary. The mutation callback runs
   * only after the old child has terminated and before any replacement starts.
   */
  async restart(reason: string, beforeStart?: () => Promise<void>): Promise<HostGeneration> {
    if (this.stopping) throw new Error('desktop Agent runtime is stopping')
    if (this.transactionRestart !== undefined) throw new Error('desktop Agent runtime restart is already active')
    if (this.recovering !== undefined) throw new Error('desktop Agent runtime is recovering from a crash')
    const operation = this.restartTransaction(reason, beforeStart)
    this.transactionRestart = operation
    try {
      return await operation
    } finally {
      if (this.transactionRestart === operation) this.transactionRestart = undefined
    }
  }

  private async restartTransaction(
    reason: string,
    beforeStart?: () => Promise<void>,
  ): Promise<HostGeneration> {
    this.ctx.desktopRuntimeBridge.publish({ stage: 'starting', detail: reason })
    const active = this.currentRuntime
    this.currentRuntime = undefined
    this.readyGeneration = undefined
    if (active !== undefined) await active.stop()
    await beforeStart?.()
    const launched = await this.launchOne()
    this.restartAttempt = 0
    this.lastExitCode = null
    this.ctx.desktopRuntimeBridge.publish({ stage: 'ready' })
    return launched.generation
  }

  /** Spawn one runtime, await readiness, then subscribe to its terminal state. */
  private async launchOne(): Promise<{ runtime: RuntimeProcess; url: string; generation: HostGeneration }> {
    const recipe = this.recipe
    if (recipe === undefined) throw new Error('desktop Agent runtime launch recipe is unavailable')
    const launched = this.spawnRuntime(await recipe.options())
    this.currentRuntime = launched
    try {
      const url = await launched.ready
      const generation = { id: ++this.generationSequence, origin: new URL(url).origin }
      this.readyGeneration = generation
      void launched.exited.then((exit) => { this.onExit(launched, exit) })
      return { runtime: launched, url, generation }
    } catch (error) {
      if (this.currentRuntime === launched) this.currentRuntime = undefined
      this.readyGeneration = undefined
      await launched.stop()
      throw error
    }
  }

  /** Publish the failure and ensure exactly one recovery loop owns the restart. */
  private onExit(launched: RuntimeProcess, exit: RuntimeExit): void {
    if (this.stopping || this.currentRuntime !== launched) return
    this.currentRuntime = undefined
    this.readyGeneration = undefined
    if (Date.now() - launched.startedAt >= this.healthyRuntimeMs) this.restartAttempt = 0
    this.lastExitCode = exit.code
    const detail = `Agent runtime exited (code=${String(exit.code)}, signal=${String(exit.signal)}).`
    this.ctx.logger.error(`worldline-desktop: ${detail}\n${exit.output}`)
    this.ctx.desktopRuntimeBridge.publish({ stage: 'failed', detail })
    this.ensureRecovery()
  }

  /** Keep recovery armed even when a replacement exits as the prior loop settles. */
  private ensureRecovery(): void {
    const active = this.recovering
    if (active !== undefined) {
      const rearm = () => {
        if (!this.stopping && this.currentRuntime === undefined) this.ensureRecovery()
      }
      void active.then(rearm, rearm)
      return
    }
    const recovery = this.recover()
    this.recovering = recovery
    void recovery.finally(() => {
      if (this.recovering === recovery) this.recovering = undefined
    })
  }

  /** Retry until one runtime remains live or the owning plugin is disposed. */
  private async recover(): Promise<void> {
    while (!this.stopping) {
      const delay = runtimeRestartDelayMs(
        this.lastExitCode,
        this.restartAttempt,
        this.baseRestartDelayMs,
        this.maxRestartDelayMs,
      )
      this.restartAttempt += 1
      this.ctx.desktopRuntimeBridge.publish({
        stage: 'starting',
        detail: delay === 0 ? 'Switching account runtime…' : `Restarting Agent runtime in ${delay}ms…`,
      })
      try {
        if (delay > 0) await this.ctx.timeout(delay)
        if (this.isStopping()) return
        const launched = await this.launchOne()
        await this.recipe?.onRestarted(launched.url)
        // A runtime can exit while the BrowserWindow is loading its new URL.
        // In that case onExit recorded the next code; remain in this loop.
        if (this.currentRuntime !== launched.runtime) continue
        this.ctx.desktopRuntimeBridge.publish({ stage: 'ready' })
        return
      } catch (error: unknown) {
        if (this.isStopping()) return
        const detail = error instanceof Error ? error.message : String(error)
        this.ctx.logger.error('worldline-desktop: Agent runtime restart failed: %o', error)
        this.ctx.desktopRuntimeBridge.publish({ stage: 'failed', detail })
        this.lastExitCode = null
      }
    }
  }
}

export default DesktopRuntimeSupervisor
