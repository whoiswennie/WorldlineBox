/** Host half for the Worldline browser studio and its bounded NDJSON narrative bridge. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-worldline-conversation-context'
import type { BindWorldlineConversationRequest } from '@deepseek-ai/dsh-worldline-conversation-context'
import type {} from '@deepseek-ai/dsh-worldline-narrative'
import type { NarrateRequest } from '@deepseek-ai/dsh-worldline-narrative/types'

export const inject = ['webServer', 'worldlineNarrative', 'worldlineConversationContexts']
export const STREAM_PATH = '/api/worldline/narrative/stream'
export const BIND_PATH = '/api/worldline/conversation/bind'
const MAX_BODY_BYTES = 64 * 1024

async function jsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Uint8Array[] = []
  for await (const chunk of req as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) throw new RangeError('request body exceeds 64 KiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function narrativeRequest(value: unknown): NarrateRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('request must be an object')
  const item = value as Record<string, unknown>
  if (typeof item['runId'] !== 'string' || typeof item['actorId'] !== 'string') {
    throw new TypeError('runId and actorId are required')
  }
  if (item['camera'] !== undefined && typeof item['camera'] !== 'string') throw new TypeError('camera must be a string')
  if (item['templateOnly'] !== undefined && typeof item['templateOnly'] !== 'boolean') throw new TypeError('templateOnly must be boolean')
  const strings = (key: 'eventIds' | 'observationIds'): readonly string[] | undefined => {
    const candidate = item[key]
    if (candidate === undefined) return undefined
    if (!Array.isArray(candidate) || !candidate.every(entry => typeof entry === 'string')) throw new TypeError(`${key} must be a string array`)
    return candidate
  }
  const eventIds = strings('eventIds')
  const observationIds = strings('observationIds')
  return {
    runId: item['runId'] as NarrateRequest['runId'],
    actorId: item['actorId'] as NarrateRequest['actorId'],
    ...(item['camera'] === undefined ? {} : { camera: item['camera'] }),
    ...(item['templateOnly'] === undefined ? {} : { templateOnly: item['templateOnly'] }),
    ...(eventIds === undefined ? {} : { eventIds }),
    ...(observationIds === undefined ? {} : { observationIds }),
  }
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return false
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

async function stream(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
  if (!sameOrigin(req)) { res.writeHead(403).end(); return }
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) { res.writeHead(415).end(); return }
  try {
    const value = narrativeRequest(await jsonBody(req))
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    for await (const chunk of ctx.worldlineNarrative.narrateStream(value)) {
      if (res.destroyed) break
      res.write(`${JSON.stringify(chunk)}\n`)
    }
    if (!res.destroyed) res.end()
  } catch (error) {
    if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return }
    const status = error instanceof RangeError ? 413 : error instanceof TypeError || error instanceof SyntaxError ? 400 : 500
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  }
}

function bindRequest(value: unknown): BindWorldlineConversationRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('request must be an object')
  }
  const item = value as Record<string, unknown>
  if (typeof item['sessionId'] !== 'string' || typeof item['projectId'] !== 'string') {
    throw new TypeError('sessionId and projectId are required')
  }
  if (item['runId'] !== undefined && typeof item['runId'] !== 'string') {
    throw new TypeError('runId must be a string')
  }
  return {
    sessionId: item['sessionId'] as BindWorldlineConversationRequest['sessionId'],
    projectId: item['projectId'] as BindWorldlineConversationRequest['projectId'],
    ...(item['runId'] === undefined ? {} : {
      runId: item['runId'] as NonNullable<BindWorldlineConversationRequest['runId']>,
    }),
  }
}

async function bind(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
  if (!sameOrigin(req)) { res.writeHead(403).end(); return }
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    res.writeHead(415).end(); return
  }
  try {
    const binding = await ctx.worldlineConversationContexts.bind(bindRequest(await jsonBody(req)))
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(JSON.stringify(binding))
  } catch (error) {
    const status = error instanceof RangeError ? 413 : error instanceof TypeError || error instanceof SyntaxError ? 400 : 409
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: STREAM_PATH, handler: (req, res) => stream(ctx, req, res),
  }), 'ui-worldline: narrative stream')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: BIND_PATH, handler: (req, res) => bind(ctx, req, res),
  }), 'ui-worldline: conversation binding')
}
