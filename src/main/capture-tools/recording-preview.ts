import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants, type ReadStream, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { CaptureRecordingPreview, CaptureRecordingState } from '../../shared/capture-tools';
import { parseByteRange } from '../artifact-response';

export const CAPTURE_RECORDING_SCHEME = 'worldlinebox-capture';
interface PreviewFile { id: string; file: string; info: Stats; preview: CaptureRecordingPreview }
const unchanged = (first: Stats, second: Stats) => first.dev === second.dev && first.ino === second.ino
  && first.size === second.size && first.mtimeMs === second.mtimeMs && first.birthtimeMs === second.birthtimeMs;
const readFlags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

/** A capability for one completed recording, held only by its ephemeral tool session. */
export class RecordingPreview {
  private current?: PreviewFile;
  private streams = new Set<ReadStream>();
  private generation = 0;
  private revoke(): void { this.current = undefined; for (const stream of this.streams) stream.destroy(); this.streams.clear(); }
  clear(): void { this.generation++; this.revoke(); }
  async prepare(recording: CaptureRecordingState): Promise<CaptureRecordingPreview> {
    const generation = this.generation;
    const file = recording.path;
    const recoverable = recording.status === 'failed' && !!file?.endsWith('.webm.part');
    if (!file || recording.status !== 'saved' && !recoverable) throw Error('此录屏尚未生成可预览的文件。');
    const mimeType = recoverable || recording.format === 'webm' ? 'video/webm' : recording.format === 'gif' ? 'image/gif' : 'video/mp4';
    const handle = await open(file, readFlags);
    let info: Stats;
    try { info = await handle.stat(); if (!info.isFile() || !info.size) throw Error('录屏文件为空或已被移走。'); }
    finally { await handle.close(); }
    if (generation !== this.generation) throw Error('录屏预览已关闭。');
    if (this.current?.id === recording.id && this.current.file === file && unchanged(this.current.info, info)) return { ...this.current.preview };
    this.revoke();
    const preview: CaptureRecordingPreview = { url: `${CAPTURE_RECORDING_SCHEME}://recording/${randomUUID()}`, mimeType, name: path.basename(file), bytes: info.size };
    this.current = { id: recording.id, file, info, preview }; return { ...preview };
  }
  async respond(request: Request): Promise<Response> {
    const current = this.current;
    // Matching the entire generated URL also rejects traversal, query strings,
    // credentials and arbitrary filesystem paths. No renderer supplies a path.
    if (!current || request.url !== current.preview.url) return new Response(null, { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    try {
      const handle = await open(current.file, readFlags); let streaming = false;
      try {
        const info = await handle.stat();
        if (current !== this.current || !info.isFile() || !unchanged(current.info, info)) return new Response(null, { status: 404 });
        const headers = new Headers({ 'Content-Type': current.preview.mimeType, 'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
        const rangeHeader = request.headers.get('range');
        const range = rangeHeader ? parseByteRange(rangeHeader, info.size) : { start: 0, end: info.size - 1 };
        if (!range) { headers.set('Content-Range', `bytes */${info.size}`); return new Response(null, { status: 416, headers }); }
        const status = rangeHeader ? 206 : 200;
        headers.set('Content-Length', String(range.end - range.start + 1));
        if (rangeHeader) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
        if (request.method === 'HEAD') return new Response(null, { status, headers });
        if (request.signal.aborted) return new Response(null, { status: 499 });
        const stream = handle.createReadStream({ ...range, autoClose: true });
        const abort = () => { stream.destroy(); };
        this.streams.add(stream); request.signal.addEventListener('abort', abort, { once: true });
        stream.once('close', () => { this.streams.delete(stream); request.signal.removeEventListener('abort', abort); });
        streaming = true;
        return new Response(Readable.toWeb(stream) as unknown as BodyInit, { status, headers });
      } finally { if (!streaming) await handle.close(); }
    } catch { return new Response(null, { status: 404 }); }
  }
}
