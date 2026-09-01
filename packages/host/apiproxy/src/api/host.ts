/**
 * host domain contract. No protocol version: client and host ship
 * together; introduce protocolVersion only when an independently released client appears.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { PathPickerRequest } from '@deepseek-ai/dsh-host-directory-picker'
export type { PathPickerRequest } from '@deepseek-ai/dsh-host-directory-picker'
import type {
  WorkspaceTreeMutation, WorkspaceTreePreview, WorkspaceTreeSearchListing,
} from '@deepseek-ai/dsh-host-workspace-tree'
export type {
  WorkspaceTreeMutation, WorkspaceTreePreview, WorkspaceTreeSearchListing,
  WorkspaceTreeSearchResult,
} from '@deepseek-ai/dsh-host-workspace-tree'

/** One directory row of a listing: a child entry or a breadcrumb ancestor. */
export interface DirectoryEntry {
  /** Base name shown in a browser row (a root crumb carries its full path). */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  hidden: boolean
  /** Entry kind; absent values from older providers are directories. */
  kind?: 'directory' | 'file'
}

/** host.listDirectory response value: one directory level plus its ancestry. */
export interface DirectoryListing {
  /** Absolute path of the listed directory. */
  path: string
  /** The host account's home directory (breadcrumb "Home" rooting). */
  home: string
  /**
   * Ancestor chain from the filesystem root to the listed directory
   * inclusive; every crumb is a jump target (crumb `hidden` is always false).
   */
  crumbs: DirectoryEntry[]
  /** Direct children, name-sorted. Files are returned only when requested. */
  entries: DirectoryEntry[]
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  truncated: boolean
}

/** Browser-safe top-level state of one session-owned terminal. */
export type TerminalStatusView =
  | { kind: 'running' }
  | { kind: 'exited'; exitCode: number | null; signal: string | null }

/** One terminal visible to the exact conversation that owns it. */
export interface TerminalSessionView {
  sessionId: string
  name?: string
  type: string
  pid?: number
  status: TerminalStatusView
}

/** Bounded retained terminal output. */
export interface TerminalReadView {
  text: string
  totalLines: number
  lineBegin: number
  lineEnd: number
  truncated: boolean
}

/** Cursor-based raw PTY data for a browser terminal emulator. */
export interface TerminalRawReadView {
  data: string
  cursor: number
  reset: boolean
  truncated: boolean
}

/** Browser-safe Cordis log severity. */
export type RuntimeLogLevel = 'error' | 'warn' | 'info' | 'debug'

/** One formatted structured runtime log record. */
export interface RuntimeLogEntry {
  sequence: number
  timestamp: number
  level: RuntimeLogLevel
  source: string
  message: string
}

/** Bounded runtime-log page plus explicit recording state. */
export interface RuntimeLogSnapshot {
  entries: RuntimeLogEntry[]
  nextCursor: number
  dropped: boolean
  recording: { active: boolean; path?: string }
}

/** Settled outcome of one line-oriented terminal interaction. */
export interface TerminalSendView {
  viewport: string
  waitReason: 'stdin_read' | 'inferred_idle' | 'timeout' | 'session_exit'
  sessionStatus: TerminalStatusView
  truncated: boolean
}

/** Host-level unary methods. */
export interface HostApi {
  /**
   * One-shot host snapshot. Empty payload uses the literal `{}` (extend in place when fields arrive).
   * version = the host app's (apps/cli) package.json version; cwd = the host process working
   * directory (root for session persistence and tool execution); provider/model = the defaults
   * applied when a new agent doesn't specify them explicitly, absent when the host configures
   * no explicit default (the adapter falls back internally);
   * attachedSessions = count of currently attached sessions (those with a live agent);
   * home = the host account home directory (Web display abbreviation on POSIX);
   * canOpenPath = whether this deployment can hand a path to a user-visible native desktop.
   */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<{
    version: string
    cwd: string
    provider?: string
    model?: string
    attachedSessions: number
    home: string
    canOpenPath: boolean
  }>>

  /**
   * Open the operating system's directory/open/save picker; cancellation
   * returns null. Only served under the `native` capability.
   */
  pickPath(
    request: RpcRequest<PathPickerRequest>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ path: string | null }>>

  /**
   * List one directory level for the in-app browser; an absent path lists the
   * host account's home directory. Only served under the `browse` capability;
   * unreadable or missing targets fail with `directory-unreadable`. The
   * carrier's request signal follows the caller, stopping the backend's scan
   * on disconnect or timeout.
   */
  listDirectory(
    request: RpcRequest<{ path?: string; includeFiles?: boolean; hostFilesystem?: boolean }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<DirectoryListing>>

  /**
   * Create one child directory under an existing parent (the browser's
   * "New folder"). Only served under the `browse` capability; an existing
   * child fails with `directory-exists`, every other filesystem failure with
   * `directory-create-failed`.
   */
  createDirectory(
    request: RpcRequest<{ path: string; name: string }>,
  ): Promise<RpcResponse<{ path: string }>>

  /** Resolve a user-entered file name inside a browsed host directory. */
  resolveDirectoryFile(
    request: RpcRequest<{ path: string; name: string }>,
  ): Promise<RpcResponse<{ path: string }>>

  /**
   * Open a filesystem path with the operating system's default application
   * (Finder / Explorer / xdg-open hand-off). The browser carrier's
   * prefix-wide trust fence covers this privileged method like every other
   * `/api` request.
   */
  openPath(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ opened: true }>>

  /** Read a bounded preview from a registered Workspace. */
  previewWorkspaceFile(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<WorkspaceTreePreview>>

  /** Search file names and relative paths below a registered Workspace root. */
  searchWorkspaceFiles(
    request: RpcRequest<{ path: string; query: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<WorkspaceTreeSearchListing>>

  /** Mutate one entry through the replaceable Workspace-tree capability. */
  mutateWorkspaceTree(
    request: RpcRequest<WorkspaceTreeMutation>,
  ): Promise<RpcResponse<{ path?: string }>>

  /** List backends and terminals owned by one exact conversation Agent. */
  listTerminals(
    request: RpcRequest<{ sessionId: string }>,
  ): Promise<RpcResponse<{ backends: string[]; sessions: TerminalSessionView[] }>>

  /** Create one persistent terminal owned by one exact conversation Agent. */
  spawnTerminal(
    request: RpcRequest<{ sessionId: string; type: string; cwd?: string; name?: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<TerminalSessionView & { motd: string }>>

  /** Send one line and wait until the PTY yields control. */
  sendTerminal(
    request: RpcRequest<{ sessionId: string; terminalId: string; text: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<TerminalSendView>>

  /** Read a bounded page from one persistent terminal's retained output. */
  readTerminal(
    request: RpcRequest<{ sessionId: string; terminalId: string; offset?: number; count?: number }>,
  ): Promise<RpcResponse<TerminalReadView>>

  /** Read raw control/data bytes after a monotonic emulator cursor. */
  readTerminalRaw(
    request: RpcRequest<{ sessionId: string; terminalId: string; cursor: number }>,
  ): Promise<RpcResponse<TerminalRawReadView>>

  /** Write raw keyboard or paste input without newline conversion. */
  writeTerminal(
    request: RpcRequest<{ sessionId: string; terminalId: string; data: string }>,
  ): Promise<RpcResponse<{ accepted: true }>>

  /** Resize the real PTY to the browser emulator viewport. */
  resizeTerminal(
    request: RpcRequest<{ sessionId: string; terminalId: string; cols: number; rows: number }>,
  ): Promise<RpcResponse<{ resized: true }>>

  /** Deliver Ctrl+C semantics to one terminal's verified foreground process group. */
  interruptTerminal(
    request: RpcRequest<{ sessionId: string; terminalId: string }>,
  ): Promise<RpcResponse<{ delivered: true; targetPgid: number }>>

  /** Close one persistent terminal and its owned process tree. */
  killTerminal(
    request: RpcRequest<{ sessionId: string; terminalId: string }>,
  ): Promise<RpcResponse<{ closed: boolean }>>

  /** Read the bounded process-wide Cordis runtime log after a sequence cursor. */
  readRuntimeLogs(
    request: RpcRequest<{ cursor?: number; limit?: number }>,
  ): Promise<RpcResponse<RuntimeLogSnapshot>>

  /** Begin explicit UTF-8 JSONL runtime-log recording under the Worldline data directory. */
  startRuntimeLogRecording(
    request: RpcRequest<{}>,
  ): Promise<RpcResponse<{ active: true; path: string }>>

  /** Stop and flush the current runtime-log recording. */
  stopRuntimeLogRecording(
    request: RpcRequest<{}>,
  ): Promise<RpcResponse<{ active: false; path?: string }>>
}
