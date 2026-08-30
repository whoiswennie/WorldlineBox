/**
 * downloads domain zod schemas. The download surface has no wire
 * envelope: the request arrives as query parameters (all strings), so its
 * request schema parses the raw query-parameter object into the method's
 * exact request shape. SessionId brand cast point: sessionIdSchema, and only
 * there (hosted in sessions.schema like every other cast).
 */

import { z } from 'zod'
import type { DownloadsApi } from './downloads.ts'
import { sessionIdSchema } from './sessions.schema.ts'

/**
 * session.export query params → the sessionLog request. `includeDescendants`
 * accepts exactly `true`/`false`/absent; any other value is rejected (400) so
 * a misspelled flag cannot silently under-export.
 */
export const sessionLogQuerySchema = z
  .object({
    sessionId: sessionIdSchema,
    includeDescendants: z.union([z.literal('true'), z.literal('false')]).optional(),
  })
  .transform(query => ({
    sessionId: query.sessionId,
    ...(query.includeDescendants === 'true' ? { includeDescendants: true } : {}),
  })) satisfies z.ZodType<Parameters<DownloadsApi['sessionLog']>[0]>

/** workspace.media query params → the opaque media grant request. */
export const workspaceFileQuerySchema = z.object({
  token: z.uuid(),
}) satisfies z.ZodType<Pick<Parameters<DownloadsApi['workspaceFile']>[0], 'token'>>

/** workspace.upload query params → one streamed Workspace import request. */
export const workspaceFileUploadQuerySchema = z.object({
  parent: z.string().min(1),
  name: z.string().trim().min(1).max(255),
  expectedBytes: z.string().regex(/^\d+$/u).optional(),
}).transform(query => ({
  parent: query.parent,
  name: query.name,
  ...(query.expectedBytes === undefined ? {} : { expectedBytes: Number(query.expectedBytes) }),
})) satisfies z.ZodType<Parameters<DownloadsApi['workspaceFileUpload']>[0]>
