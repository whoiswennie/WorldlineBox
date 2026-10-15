import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';

/** Serve only a host-resolved registered file. Media seeking never buffers the whole file. */
export async function companionAttachmentResponse(file: string, mime: string, request: Request): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const handle = await open(file, 'r');
  let streaming = false;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return new Response(null, { status: 404 });
    const headers = new Headers({ 'Content-Type': mime, 'Accept-Ranges': 'bytes',
      'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' });
    let start = 0, end = info.size - 1, status = 200;
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range.trim());
      const invalid = () => new Response(null, { status: 416, headers: { ...Object.fromEntries(headers), 'Content-Range': `bytes */${info.size}` } });
      if (!match || !match[1] && !match[2] || !info.size) return invalid();
      if (!match[1]) { const count = Number(match[2]); if (!Number.isSafeInteger(count) || count <= 0) return invalid(); start = Math.max(0, info.size - count); }
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= info.size || end < start) return invalid();
      status = 206; headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
    }
    headers.set('Content-Length', String(Math.max(0, end - start + 1)));
    if (request.method === 'HEAD' || !info.size) return new Response(null, { status, headers });
    if (request.signal.aborted) throw new Error('Attachment request aborted.');
    const stream = handle.createReadStream({ start, end, autoClose: true });
    const abort = () => stream.destroy();
    request.signal.addEventListener('abort', abort, { once: true });
    stream.once('close', () => request.signal.removeEventListener('abort', abort));
    streaming = true;
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
  } finally { if (!streaming) await handle.close(); }
}
