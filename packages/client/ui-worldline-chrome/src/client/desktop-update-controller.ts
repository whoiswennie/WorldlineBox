import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

export type DesktopUpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

/** Browser-side mirror of the serializable preload contract. */
export interface DesktopUpdateSnapshot {
  readonly revision: number
  readonly phase: DesktopUpdatePhase
  readonly currentVersion: string
  readonly latestVersion?: string
  readonly releaseDate?: string
  readonly releaseNotes?: string
  readonly downloadedBytes?: number
  readonly totalBytes?: number
  readonly percent?: number
  readonly bytesPerSecond?: number
  readonly message?: string
}

interface DesktopUpdateBridge {
  getState(): Promise<DesktopUpdateSnapshot>
  check(): Promise<DesktopUpdateSnapshot>
  download(): Promise<DesktopUpdateSnapshot>
  install(): Promise<void>
  onStateChanged(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void
}

interface DesktopGlobal {
  readonly worldlineDesktop?: { readonly updates?: DesktopUpdateBridge }
}

const INITIAL: DesktopUpdateSnapshot = {
  revision: 0,
  phase: 'unsupported',
  currentVersion: '0.1.0',
}

function updateBridge(): DesktopUpdateBridge | undefined {
  return (globalThis as typeof globalThis & DesktopGlobal).worldlineDesktop?.updates
}

/** Converts preload events into the renderer's standard observable currency. */
export class DesktopUpdateController {
  readonly store: SnapshotStore<DesktopUpdateSnapshot> = createSnapshotStore(INITIAL)
  private readonly bridge = updateBridge()

  private accept(snapshot: DesktopUpdateSnapshot): void {
    if (snapshot.revision < this.store.getSnapshot().revision) return
    this.store.set(snapshot)
  }

  private fail(error: unknown): void {
    const current = this.store.getSnapshot()
    this.store.set({
      revision: current.revision + 1,
      phase: 'error',
      currentVersion: current.currentVersion,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  start(): () => void {
    if (this.bridge === undefined) return () => {}
    let active = true
    const accept = (snapshot: DesktopUpdateSnapshot): void => { if (active) this.accept(snapshot) }
    const off = this.bridge.onStateChanged(accept)
    void this.bridge.getState().then(accept, (error: unknown) => { if (active) this.fail(error) })
    void this.bridge.check().then(accept, (error: unknown) => { if (active) this.fail(error) })
    return () => { active = false; off() }
  }

  async check(): Promise<void> {
    if (this.bridge === undefined) return
    try { this.accept(await this.bridge.check()) } catch (error) { this.fail(error) }
  }

  async download(): Promise<void> {
    if (this.bridge === undefined) return
    try { this.accept(await this.bridge.download()) } catch (error) { this.fail(error) }
  }

  async install(): Promise<void> {
    if (this.bridge === undefined) return
    try { await this.bridge.install() } catch (error) { this.fail(error) }
  }
}
