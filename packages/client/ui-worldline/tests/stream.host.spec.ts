import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { WorldlineNarrative } from '@deepseek-ai/dsh-worldline-narrative'
import type { WorldlineConversationContexts } from '@deepseek-ai/dsh-worldline-conversation-context'
import type { WorldlineProjects } from '@deepseek-ai/dsh-worldline-project'
import { describe, expect, it } from 'vitest'
import { apply, BIND_PATH, inject, PROJECT_UPLOAD_PATH, STREAM_PATH } from '../src/index.ts'

function request(body: unknown, origin = 'http://127.0.0.1:3080'): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage
  stream.method = 'POST'
  stream.headers = {
    host: '127.0.0.1:3080',
    origin,
    'content-type': 'application/json',
  }
  return stream
}

interface CapturedResponse {
  response: ServerResponse
  readonly chunks: string[]
  status?: number
  ended: boolean
}

function response(): CapturedResponse {
  const captured: CapturedResponse = {
    chunks: [],
    ended: false,
    response: undefined as unknown as ServerResponse,
  }
  captured.response = {
    destroyed: false,
    headersSent: false,
    writeHead(status: number) {
      captured.status = status
      Object.defineProperty(this, 'headersSent', { value: true, configurable: true })
      return this
    },
    write(chunk: string) { captured.chunks.push(chunk); return true },
    end(chunk?: string) {
      if (chunk !== undefined) captured.chunks.push(chunk)
      captured.ended = true
      return this
    },
    destroy() { captured.ended = true; return this },
  } as unknown as ServerResponse
  return captured
}

async function route(): Promise<{
  streamRoute: WebRoute
  bindRoute: WebRoute
  uploadRoute: WebRoute
  uploaded: Uint8Array[]
  dispose: () => Promise<void>
}> {
  const routes: WebRoute[] = []
  const uploaded: Uint8Array[] = []
  const server = {
    register(value: WebRoute) { routes.push(value); return () => { routes.splice(routes.indexOf(value), 1) } },
  } as unknown as WebServer
  const narrative = {
    async *narrateStream() {
      yield { type: 'text-delta', text: 'The gate opens.' } as const
      yield {
        type: 'beat',
        beat: {
          id: 'narrative-beat:test', eventIds: [], observationIds: [], camera: 'limited-third-person',
          text: 'The gate opens.', media: [], style: 'template',
        },
      } as const
    },
  } as unknown as WorldlineNarrative
  const ctx = new Context()
  ctx.provide('webServer', server)
  ctx.provide('worldlineNarrative', narrative)
  ctx.provide('worldlineConversationContexts', {
    bind: async (value: { sessionId: string; projectId: string; runId?: string }) => ({
      ...value,
      worldlineId: 'worldline:test',
      sourceRevision: 'digest-current',
      boundAt: '2026-09-01T00:00:00.000Z',
    }),
  } as unknown as WorldlineConversationContexts)
  ctx.provide('worldlineProjects', {
    importEntry: async (value: { projectId: string; path: string; expectedBytes: number }, source: AsyncIterable<Uint8Array>) => {
      for await (const chunk of source) uploaded.push(chunk)
      return { projectId: value.projectId, path: value.path }
    },
  } as unknown as WorldlineProjects)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const streamRoute = routes.find(value => value.path === STREAM_PATH)
  const bindRoute = routes.find(value => value.path === BIND_PATH)
  const uploadRoute = routes.find(value => value.path === PROJECT_UPLOAD_PATH)
  if (streamRoute === undefined || bindRoute === undefined || uploadRoute === undefined) throw new Error('routes did not register')
  return { streamRoute, bindRoute, uploadRoute, uploaded, dispose: () => fiber.dispose() }
}

describe('Worldline narrative stream bridge', () => {
  it('emits real NDJSON chunks and a retained beat', async () => {
    const mounted = await route()
    const output = response()
    await mounted.streamRoute.handler(request({ runId: 'run:test', actorId: 'entity:actor' }), output.response)

    expect(mounted.streamRoute).toMatchObject({ kind: 'exact', path: STREAM_PATH })
    expect(output.status).toBe(200)
    expect(output.ended).toBe(true)
    expect(output.chunks.join('')).toContain('"type":"text-delta"')
    expect(output.chunks.join('')).toContain('"type":"beat"')
    await mounted.dispose()
  })

  it('rejects cross-origin requests before narration starts', async () => {
    const mounted = await route()
    const output = response()
    await mounted.streamRoute.handler(
      request({ runId: 'run:test', actorId: 'entity:actor' }, 'https://example.invalid'),
      output.response,
    )

    expect(output.status).toBe(403)
    await mounted.dispose()
  })

  it('persists a same-origin project and optional Run binding before chat starts', async () => {
    const mounted = await route()
    const output = response()
    await mounted.bindRoute.handler(request({
      sessionId: 'session:test', projectId: 'project:test', runId: 'run:test',
    }), output.response)

    expect(output.status).toBe(200)
    expect(output.chunks.join('')).toContain('"sourceRevision":"digest-current"')
    expect(output.chunks.join('')).toContain('"runId":"run:test"')
    await mounted.dispose()
  })

  it('passes a same-origin project upload through as a byte stream', async () => {
    const mounted = await route()
    const input = Readable.from([Buffer.from([0, 1]), Buffer.from([2, 3])]) as IncomingMessage
    input.method = 'PUT'
    input.url = `${PROJECT_UPLOAD_PATH}?projectId=project%3Atest&path=assets%2Fpixel.bin&expectedBytes=4`
    input.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'content-length': '4' }
    const output = response()

    await mounted.uploadRoute.handler(input, output.response)

    expect(output.status).toBe(201)
    expect(Buffer.concat(mounted.uploaded.map(chunk => Buffer.from(chunk)))).toEqual(Buffer.from([0, 1, 2, 3]))
    await mounted.dispose()
  })
})
