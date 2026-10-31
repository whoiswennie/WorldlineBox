import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { resolveFfmpegPath } from '../../worker/binary-resolver';
import { COMPANION_IMAGE_PREVIEW_MAX_BYTES, COMPANION_MEDIA_PREVIEW_MAX_BYTES } from '../../shared/companion-media';

const runFile = promisify(execFile);
const COVER_EDGE = 384, MAX_COVER_BYTES = 1024 * 1024, MAX_CACHE_BYTES = 12 * 1024 * 1024;
type CoverDecoder = (file: string, mime: string, signal: AbortSignal) => Promise<Buffer>;

async function boundedImageBytes(file: string, signal: AbortSignal) {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > COMPANION_IMAGE_PREVIEW_MAX_BYTES) throw new Error('Attachment exceeds image cover size.');
    const bytes = Buffer.alloc(info.size); let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('Attachment changed while reading its cover.');
      offset += read.bytesRead;
    }
    return bytes;
  } finally { await handle.close(); }
}

/** Exactly one local video frame, with no audio, network protocols or shell. */
export function companionVideoCoverArguments(file: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
    '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,ogg',
    '-max_alloc', '67108864', '-threads', '1', '-filter_threads', '1', '-i', file,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1', '-vf',
    `scale=${COVER_EDGE}:${COVER_EDGE}:force_original_aspect_ratio=decrease`,
    '-c:v', 'mjpeg', '-threads', '1', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'];
}

async function decodeCover(file: string, mime: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  // libvips keeps file loaders in its process-wide operation cache. Give it
  // bounded bytes so a thumbnail never leaves a Windows source file locked.
  let source: Buffer;
  if (mime.startsWith('video/')) {
    const result = await runFile(resolveFfmpegPath(), companionVideoCoverArguments(file),
      { windowsHide: true, timeout: 8_000, maxBuffer: MAX_COVER_BYTES, encoding: 'buffer', signal });
    source = result.stdout;
  } else source = await boundedImageBytes(file, signal);
  signal.throwIfAborted();
  // Sharp sniffs the actual bytes: an animated WebP named .gif still yields
  // one static frame. Never let a grid create a full animation decoder.
  const image = sharp(source, { animated: false, page: 0, pages: 1, limitInputPixels: 64 * 1024 * 1024, failOn: 'warning' })
    .timeout({ seconds: 6 }).rotate().resize({ width: COVER_EDGE, height: COVER_EDGE, fit: 'inside', withoutEnlargement: true }).png();
  const abort = () => image.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const metadata = await image.metadata();
    if (!metadata.format || !['png', 'jpeg', 'gif', 'webp', 'heif'].includes(metadata.format)) throw new Error('Attachment has no passive image cover decoder.');
    const bytes = await image.toBuffer(); signal.throwIfAborted(); return bytes;
  }
  finally { signal.removeEventListener('abort', abort); image.destroy(); }
}

/** Service-scoped, small LRU. Call only after the existing registered-attachment
 * authorization/path resolution; every HTTP request still passes that gate.
 * Native work runs asynchronously in an independent two-decoder lane. */
export class CompanionAttachmentCovers {
  private readonly cache = new Map<string, Buffer>();
  private readonly pending = new Map<string, Promise<Buffer>>();
  private readonly controllers = new Set<AbortController>();
  private readonly waiters: Array<() => void> = [];
  private active = 0;
  private cachedBytes = 0;
  private closed = false;
  constructor(private readonly decode: CoverDecoder = decodeCover) {}

  close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    for (const resume of this.waiters.splice(0)) resume();
    this.cache.clear(); this.cachedBytes = 0;
  }

  private async fingerprint(file: string, mime: string) {
    const info = await lstat(file, { bigint: true });
    if (!info.isFile()) throw new Error('Attachment cover source is not a regular file.');
    if (info.size > BigInt(mime.startsWith('image/') ? COMPANION_IMAGE_PREVIEW_MAX_BYTES : COMPANION_MEDIA_PREVIEW_MAX_BYTES)) throw new Error('Attachment exceeds cover source size.');
    return createHash('sha256').update(JSON.stringify([file, mime, String(info.size), String(info.mtimeNs), String(info.ctimeNs), String(info.dev), String(info.ino)])).digest('hex');
  }

  private async generate(file: string, mime: string, key: string) {
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      if (this.active >= 2) await new Promise<void>(resolve => this.waiters.push(resolve));
      else this.active++;
      controller.signal.throwIfAborted();
      if (this.closed) throw new Error('Attachment covers are closed.');
      try {
        const bytes = await this.decode(file, mime, controller.signal);
        controller.signal.throwIfAborted();
        if (!bytes.length || bytes.length > MAX_COVER_BYTES || key !== await this.fingerprint(file, mime)) throw new Error('Attachment changed while generating its cover.');
        this.cache.set(key, bytes); this.cachedBytes += bytes.length;
        while (this.cache.size > 128 || this.cachedBytes > MAX_CACHE_BYTES) {
          const oldest = this.cache.keys().next().value!;
          this.cachedBytes -= this.cache.get(oldest)!.length; this.cache.delete(oldest);
        }
        return bytes;
      } finally { const next = this.waiters.shift(); if (next) next(); else this.active--; }
    } finally { this.controllers.delete(controller); }
  }

  async response(file: string, mime: string, request: Request): Promise<Response> {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    if (!/^(?:image\/(?:png|jpeg|webp|gif|apng|avif)|video\/(?:mp4|webm|ogg|quicktime))(?:;|$)/u.test(mime)) return new Response(null, { status: 415 });
    try {
      request.signal.throwIfAborted();
      if (this.closed) return new Response(null, { status: 503 });
      const key = await this.fingerprint(file, mime);
      let bytes = this.cache.get(key);
      if (bytes) { this.cache.delete(key); this.cache.set(key, bytes); }
      else {
        let operation = this.pending.get(key);
        if (!operation) {
          operation = this.generate(file, mime, key).finally(() => this.pending.delete(key));
          this.pending.set(key, operation);
        }
        bytes = await operation;
      }
      request.signal.throwIfAborted();
      if (this.closed || key !== await this.fingerprint(file, mime)) return new Response(null, { status: 409 });
      const headers = { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-cache',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", ETag: `"${key}"` };
      if (request.headers.get('if-none-match') === headers.ETag) return new Response(null, { status: 304, headers });
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers });
    } catch { return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } }); }
  }
}
