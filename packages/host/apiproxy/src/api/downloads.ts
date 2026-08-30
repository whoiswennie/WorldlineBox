/**
 * raw-transfer domain contract: Host-only download and upload surfaces, the
 * mirror of the SSE-stream `events` domain. No wire envelope: carrier routes
 * answer these directly, and the browser `IApiClient` never exposes them.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Host-only raw-transfer surfaces (no wire envelope; absent from IApiClient). */
export interface DownloadsApi {
  /**
   * Stream one session-log ZIP — the root artifact verbatim plus each subagent
   * descendant's — as an attachment response. The carrier's GET route answers
   * this directly; the browser never calls it.
   * @param request - the root session id and whether to include descendants.
   * @param signal - cancellation for the underlying reads.
   * @returns the ZIP attachment response; missing services answer 500 and a
   * missing root session 404 before any byte is produced.
   */
  sessionLog(
    request: { sessionId: SessionId; includeDescendants?: boolean },
    signal: AbortSignal,
  ): Promise<Response>
  /**
   * Stream a media file through an opaque preview grant. Single HTTP byte
   * ranges are supported so native audio/video controls can seek efficiently.
   * @param request - opaque grant plus optional Range/If-Range headers.
   * @param signal - cancellation propagated from the client connection.
   * @returns a full, partial, or range-error media response.
   */
  workspaceFile(
    request: { token: string; range?: string; ifRange?: string },
    signal: AbortSignal,
  ): Promise<Response>
  /**
   * Stream an external file into one registered Workspace directory.
   * @param request - target directory, leaf name, and optional declared length.
   * @param source - raw request bytes; never materialized as Base64 or JSON.
   * @param signal - cancellation propagated from the client connection.
   * @returns JSON containing the created path and persisted byte count.
   */
  workspaceFileUpload(
    request: { parent: string; name: string; expectedBytes?: number },
    source: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<Response>
}
