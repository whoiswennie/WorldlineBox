/**
 * host domain zod schemas (names derived from map keys).
 */

import { z } from 'zod'
import type { DirectoryEntry } from './host.ts'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** host.describe request payload (empty object literal). */
export const hostDescribeRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'host.describe'>>>

/** host.describe response value. */
export const hostDescribeValueSchema = z.object({
  version: z.string(),
  cwd: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  attachedSessions: z.number().int().nonnegative(),
  home: z.string(),
  canOpenPath: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.describe'>>>

/** host.pickDirectory request payload (empty object literal). */
export const hostPickDirectoryRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'host.pickDirectory'>>>

/** host.pickDirectory response value; null means the user cancelled. */
export const hostPickDirectoryValueSchema = z.object({
  path: z.string().nullable(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.pickDirectory'>>>

/** Directory row shared by listing entries and breadcrumb crumbs. */
export const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  hidden: z.boolean(),
  kind: z.enum(['directory', 'file']).optional(),
}) satisfies z.ZodType<Wire<DirectoryEntry>>

/** host.listDirectory request payload; an absent path lists the home directory. */
export const hostListDirectoryRequestSchema = z.object({
  path: z.string().optional(),
  includeFiles: z.boolean().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.listDirectory'>>>

/** host.listDirectory response value. */
export const hostListDirectoryValueSchema = z.object({
  path: z.string(),
  home: z.string(),
  crumbs: z.array(directoryEntrySchema),
  entries: z.array(directoryEntrySchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.listDirectory'>>>

/** host.createDirectory request payload: name must be one plain path segment. */
export const hostCreateDirectoryRequestSchema = z.object({
  path: z.string(),
  name: z.string(),
}).refine(
  payload => payload.name.trim() !== '' && payload.name !== '.' && payload.name !== '..'
    && !/[/\\]/.test(payload.name),
  { message: 'host.createDirectory requires a single non-blank path segment name' },
) satisfies z.ZodType<Wire<RequestPayload<'host.createDirectory'>>>

/** host.createDirectory response value: the created directory's absolute path. */
export const hostCreateDirectoryValueSchema = z.object({
  path: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.createDirectory'>>>
/** host.openPath request payload. */
export const hostOpenPathRequestSchema = z.object({
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'host.openPath'>>>

/** host.openPath response value. */
export const hostOpenPathValueSchema = z.object({
  opened: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'host.openPath'>>>

/** host.previewWorkspaceFile request payload. */
export const hostPreviewWorkspaceFileRequestSchema = z.object({
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'host.previewWorkspaceFile'>>>

/** Bounded in-app preview response. */
export const hostPreviewWorkspaceFileValueSchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.number().nonnegative(),
  kind: z.enum(['text', 'image', 'audio', 'video', 'binary']),
  mimeType: z.string(),
  encoding: z.enum(['utf8', 'base64']).optional(),
  content: z.string().optional(),
  streamUrl: z.string().optional(),
  tooLarge: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.previewWorkspaceFile'>>>

/** Registered Workspace root and bounded non-blank filename query. */
export const hostSearchWorkspaceFilesRequestSchema = z.object({
  path: z.string().min(1),
  query: z.string().trim().min(1).max(256),
}) satisfies z.ZodType<Wire<RequestPayload<'host.searchWorkspaceFiles'>>>

/** Ranked bounded Workspace filename matches. */
export const hostSearchWorkspaceFilesValueSchema = z.object({
  query: z.string(),
  results: z.array(z.object({
    name: z.string(),
    path: z.string(),
    relativePath: z.string(),
    size: z.number().int().nonnegative(),
    modifiedAt: z.number().nonnegative(),
  })),
  scanned: z.number().int().nonnegative(),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.searchWorkspaceFiles'>>>

const workspaceEntryNameSchema = z.string().refine(
  value => value.trim() !== '' && value !== '.' && value !== '..' && !/[/\\]/.test(value),
  { message: 'workspace entry name must be one non-blank path segment' },
)

/** All filesystem mutations supported by the replaceable Workspace-tree capability. */
export const hostMutateWorkspaceTreeRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create-file'), parent: z.string(), name: workspaceEntryNameSchema,
    content: z.string().optional(), contentEncoding: z.enum(['utf8', 'base64']).optional() }),
  z.object({ operation: z.literal('create-directory'), parent: z.string(), name: workspaceEntryNameSchema }),
  z.object({ operation: z.literal('rename'), path: z.string(), name: workspaceEntryNameSchema }),
  z.object({ operation: z.literal('copy'), path: z.string(), targetDirectory: z.string() }),
  z.object({ operation: z.literal('move'), path: z.string(), targetDirectory: z.string() }),
  z.object({ operation: z.literal('delete'), path: z.string() }),
  z.object({ operation: z.literal('clear-workspace'), path: z.string() }),
  z.object({ operation: z.literal('write'), path: z.string(), content: z.string() }),
]) satisfies z.ZodType<Wire<RequestPayload<'host.mutateWorkspaceTree'>>>

/** Path affected by a Workspace-tree mutation. */
export const hostMutateWorkspaceTreeValueSchema = z.object({
  path: z.string().optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.mutateWorkspaceTree'>>>

const terminalOwnerSchema = z.object({ sessionId: z.string().min(1) })
const terminalTargetSchema = terminalOwnerSchema.extend({ terminalId: z.string().min(1) })
const terminalStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('running') }),
  z.object({ kind: z.literal('exited'), exitCode: z.number().int().nullable(), signal: z.string().nullable() }),
])
const terminalSessionSchema = z.object({
  sessionId: z.string(),
  name: z.string().optional(),
  type: z.string(),
  pid: z.number().int().positive().optional(),
  status: terminalStatusSchema,
})

/** Exact conversation whose terminal catalog is requested. */
export const hostListTerminalsRequestSchema = terminalOwnerSchema satisfies z.ZodType<Wire<RequestPayload<'host.listTerminals'>>>
/** Browser-safe backends and live terminal summaries owned by that conversation. */
export const hostListTerminalsValueSchema = z.object({
  backends: z.array(z.string()),
  sessions: z.array(terminalSessionSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'host.listTerminals'>>>

/** Persistent terminal creation request. */
export const hostSpawnTerminalRequestSchema = terminalOwnerSchema.extend({
  type: z.string().min(1),
  cwd: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.spawnTerminal'>>>
/** Created terminal metadata plus its initial message-of-the-day output. */
export const hostSpawnTerminalValueSchema = terminalSessionSchema.extend({
  motd: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.spawnTerminal'>>>

/** One line-oriented terminal interaction. */
export const hostSendTerminalRequestSchema = terminalTargetSchema.extend({
  text: z.string().max(1_000_000),
}) satisfies z.ZodType<Wire<RequestPayload<'host.sendTerminal'>>>
/** Settled line interaction with bounded output and the observed terminal status. */
export const hostSendTerminalValueSchema = z.object({
  viewport: z.string(),
  waitReason: z.enum(['stdin_read', 'inferred_idle', 'timeout', 'session_exit']),
  sessionStatus: terminalStatusSchema,
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.sendTerminal'>>>

/** Bounded scrollback request and response. */
export const hostReadTerminalRequestSchema = terminalTargetSchema.extend({
  offset: z.number().int().nonnegative().optional(),
  count: z.number().int().min(1).max(10_000).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.readTerminal'>>>
/** Bounded normalized scrollback page and its retained line coordinates. */
export const hostReadTerminalValueSchema = z.object({
  text: z.string(),
  totalLines: z.number().int().nonnegative(),
  lineBegin: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.readTerminal'>>>

/** Cursor-based raw PTY output request and response. */
export const hostReadTerminalRawRequestSchema = terminalTargetSchema.extend({
  cursor: z.number().int().nonnegative(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.readTerminalRaw'>>>
/** Raw PTY delta and next cursor, including reset and retention-loss signals. */
export const hostReadTerminalRawValueSchema = z.object({
  data: z.string(),
  cursor: z.number().int().nonnegative(),
  reset: z.boolean(),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.readTerminalRaw'>>>

/** Raw terminal input without implicit Enter. */
export const hostWriteTerminalRequestSchema = terminalTargetSchema.extend({
  data: z.string().max(1_000_000),
}) satisfies z.ZodType<Wire<RequestPayload<'host.writeTerminal'>>>
/** Acknowledgement that the raw input was accepted by the terminal backend. */
export const hostWriteTerminalValueSchema = z.object({
  accepted: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'host.writeTerminal'>>>

/** Browser terminal dimensions. */
export const hostResizeTerminalRequestSchema = terminalTargetSchema.extend({
  cols: z.number().int().min(2).max(1_000),
  rows: z.number().int().min(1).max(1_000),
}) satisfies z.ZodType<Wire<RequestPayload<'host.resizeTerminal'>>>
/** Acknowledgement that the PTY dimensions were updated. */
export const hostResizeTerminalValueSchema = z.object({
  resized: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'host.resizeTerminal'>>>

/** Foreground Ctrl+C request. */
export const hostInterruptTerminalRequestSchema = terminalTargetSchema satisfies z.ZodType<Wire<RequestPayload<'host.interruptTerminal'>>>
/** Verified foreground process group that received the interrupt. */
export const hostInterruptTerminalValueSchema = z.object({
  delivered: z.literal(true),
  targetPgid: z.number().int().positive(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.interruptTerminal'>>>

/** Persistent terminal close request. */
export const hostKillTerminalRequestSchema = terminalTargetSchema satisfies z.ZodType<Wire<RequestPayload<'host.killTerminal'>>>
/** Whether the owned terminal existed and was closed. */
export const hostKillTerminalValueSchema = z.object({
  closed: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.killTerminal'>>>

/** Bounded runtime-log polling page. */
export const hostReadRuntimeLogsRequestSchema = z.object({
  cursor: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(1_000).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.readRuntimeLogs'>>>
const runtimeLogEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  timestamp: z.number().nonnegative(),
  level: z.enum(['error', 'warn', 'info', 'debug']),
  source: z.string(),
  message: z.string(),
})
/** Runtime-log page, next sequence cursor, retention signal, and recording state. */
export const hostReadRuntimeLogsValueSchema = z.object({
  entries: z.array(runtimeLogEntrySchema),
  nextCursor: z.number().int().nonnegative(),
  dropped: z.boolean(),
  recording: z.object({ active: z.boolean(), path: z.string().optional() }),
}) satisfies z.ZodType<Wire<ResponseValue<'host.readRuntimeLogs'>>>

/** Empty request that starts one process-wide JSONL log recording. */
export const hostStartRuntimeLogRecordingRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'host.startRuntimeLogRecording'>>>
/** Active recording and its host path. */
export const hostStartRuntimeLogRecordingValueSchema = z.object({
  active: z.literal(true),
  path: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.startRuntimeLogRecording'>>>

/** Empty request that flushes and stops the active JSONL recording, if any. */
export const hostStopRuntimeLogRecordingRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'host.stopRuntimeLogRecording'>>>
/** Inactive recording state and the path flushed by this request, when present. */
export const hostStopRuntimeLogRecordingValueSchema = z.object({
  active: z.literal(false),
  path: z.string().optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.stopRuntimeLogRecording'>>>
