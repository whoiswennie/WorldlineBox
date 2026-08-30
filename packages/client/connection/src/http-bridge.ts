/**
 * node:http ↔ WHATWG fetch bridge for the /api transport (host side of the
 * web carrier; the fetch-shaped handler itself is transport-agnostic).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

/** Default carrier cap for ordinary JSON HTTP RPC bodies: sized for the default
 * aggregate image limit (200 MiB) after base64 expansion plus envelope
 * headroom (~267.7 MiB required), rounded up for slack. The bridge buffers
 * each such body in memory, so this cap is also its per-request resident bound.
 * The dedicated Workspace upload route remains a raw byte stream. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024

/** Transport-independent request handler consumed by the Host HTTP bridge. */
export interface FetchHandler {
  /**
   * Handle one standard Fetch request.
   * @param request - request produced by the active transport bridge.
   * @returns complete or streaming Fetch response.
   */
  fetch(request: Request): Promise<Response>
}

/**
 * Bridge one node:http request to the fetch-shaped handler (client close
 * aborts; SSE bodies stream out chunk by chunk).
 * @param req - incoming node:http request; JSON is bounded and buffered, while
 * the dedicated Workspace upload route is passed through as a byte stream.
 * @param res - node:http response the bridge writes and owns to completion.
 * @param apiHandler - fetch-shaped API carrier the request is dispatched to.
 * @param maxRequestBodyBytes - maximum body bytes buffered before dispatch.
 */
export async function bridge(
  req: IncomingMessage,
  res: ServerResponse,
  apiHandler: FetchHandler,
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<void> {
  const abort = new AbortController()
  // Client-disconnect detection MUST hang off the response, not the request:
  // since Node 16, IncomingMessage 'close' fires as soon as the request body is
  // fully consumed (immediately for a bodyless GET), which would abort every SSE
  // stream right after open. ServerResponse 'close' fires on connection teardown;
  // writableEnded distinguishes a normal end() from the client going away.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  const requestUrl = new URL(req.url ?? '/', 'http://worldline.internal')
  const method = req.method ?? 'GET'
  const streamWorkspaceUpload = method === 'PUT' && requestUrl.pathname === '/api/workspace.upload'
  let request: Request
  if (streamWorkspaceUpload) {
    request = new Request(requestUrl, {
      method,
      headers: Object.fromEntries(Object.entries(req.headers)
        .filter(([, value]) => typeof value === 'string') as [string, string][]),
      body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
      duplex: 'half',
      signal: abort.signal,
    } as RequestInit & { duplex: 'half' })
  } else {
    const declaredLength = req.headers['content-length']
    if (declaredLength !== undefined && Number(declaredLength) > maxRequestBodyBytes) {
      res.writeHead(413, { connection: 'close' })
      res.end()
      req.destroy()
      return
    }
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      received += buffer.byteLength
      if (received > maxRequestBodyBytes) {
        res.writeHead(413, { connection: 'close' })
        res.end()
        req.destroy()
        return
      }
      chunks.push(buffer)
    }
    request = new Request(requestUrl, {
      method,
      headers: Object.fromEntries(Object.entries(req.headers)
        .filter(([, value]) => typeof value === 'string') as [string, string][]),
      ...chunks.length > 0 ? { body: Buffer.concat(chunks) } : {},
      signal: abort.signal,
    })
  }
  const response = await apiHandler.fetch(request)
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (response.body === null) {
    res.end()
    return
  }
  for await (const chunk of response.body) {
    // Backpressure: a false return means the socket buffer is full — wait for drain
    // instead of buffering unboundedly (slow/suspended SSE consumers). 'close' also
    // resolves so a mid-wait disconnect can't park this loop forever; the close
    // handler above aborts the handler stream, which then ends the iteration.
    if (!res.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  res.end()
}
