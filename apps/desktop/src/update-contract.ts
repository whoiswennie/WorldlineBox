/** IPC channel names kept private to the trusted desktop preload. */
export const UPDATE_GET_STATE_CHANNEL = 'worldline:update:get-state'
export const UPDATE_CHECK_CHANNEL = 'worldline:update:check'
export const UPDATE_DOWNLOAD_CHANNEL = 'worldline:update:download'
export const UPDATE_INSTALL_CHANNEL = 'worldline:update:install'
export const UPDATE_STATE_CHANGED_CHANNEL = 'worldline:update:state-changed'

export type DesktopUpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

/** Serializable state exposed to the sandboxed Worldline renderer. */
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

/** Narrow preload API; the browser page receives no Node or Electron object. */
export interface DesktopUpdateBridge {
  getState(): Promise<DesktopUpdateSnapshot>
  check(): Promise<DesktopUpdateSnapshot>
  download(): Promise<DesktopUpdateSnapshot>
  install(): Promise<void>
  onStateChanged(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void
}
