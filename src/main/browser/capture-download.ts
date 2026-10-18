import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { alignFilenameWithContentType, sniffContentType } from '../../../extension/save-client';
import { HOTLINK_SITES } from '../../../extension/hotlink-sites';
import { BROWSER_CAPTURE_LOCAL_MAX_BYTES, BROWSER_CAPTURE_MAX_BYTES } from '../../shared/browser-capture';

export const MAX_BROWSER_CAPTURE_BYTES = BROWSER_CAPTURE_MAX_BYTES;
export interface StagedBrowserCapture {
  stagedFilePath: string;
  stagingDirectory: string;
  filename: string;
  contentType: string;
  byteLength: number;
}
export function captureHttpUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 8192) throw Error('仅支持不含密码的 HTTP/HTTPS 媒体地址。');
  return url.href;
}
export function captureReferer(mediaUrl: string, pageUrl: string): string {
  const host = new URL(mediaUrl).hostname.toLowerCase();
  return HOTLINK_SITES.find(site => site.hosts.some(suffix => host === suffix || host.endsWith('.' + suffix)))?.referer ?? pageUrl;
}
function captureFilename(mediaUrl: string, contentType: string): string {
  let name = contentType.startsWith('video/') ? 'video.bin' : 'image.bin';
  try { const candidate = new URL(mediaUrl).pathname.split('/').filter(Boolean).pop(); if (candidate?.includes('.')) name = decodeURIComponent(candidate); } catch { /* MIME supplies the extension below. */ }
  // eslint-disable-next-line no-control-regex -- strip filesystem control characters from remote filenames
  return alignFilenameWithContentType(name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 240), contentType);
}
/** Only called with a genuine native file-picker result, never a page-provided path. */
export async function readPickedCaptureImage(filename: string): Promise<{ bodyBase64: string; contentType: string; filename: string }> {
  const handle = await open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > BROWSER_CAPTURE_LOCAL_MAX_BYTES) throw Error('请选择不超过 32 MiB 的图片文件。');
    const chunks: Buffer[] = []; let received = 0;
    while (received <= BROWSER_CAPTURE_LOCAL_MAX_BYTES) {
      const buffer = Buffer.alloc(Math.min(1024 * 1024, BROWSER_CAPTURE_LOCAL_MAX_BYTES + 1 - received));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead)); received += bytesRead;
    }
    if (received > BROWSER_CAPTURE_LOCAL_MAX_BYTES) throw Error('图片超过 32 MiB 上限。');
    const bytes = Buffer.concat(chunks);
    const contentType = sniffContentType(Uint8Array.from(bytes.subarray(0, 32)).buffer);
    if (!contentType?.startsWith('image/')) throw Error('请选择 PNG、JPEG、GIF、WebP 或 BMP 图片。');
    return { bodyBase64: bytes.toString('base64'), contentType, filename: path.basename(filename) };
  } finally { await handle.close(); }
}
/** Cookies remain in the browser's own Session; bytes never cross renderer IPC. */
export async function stageBrowserCapture(options: {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  tempRoot: string;
  mediaUrl: string;
  sourcePageUrl: string;
  kind: 'image' | 'video';
  signal: AbortSignal;
  onProgress?: (received: number, total?: number) => void;
}): Promise<StagedBrowserCapture> {
  const mediaUrl = captureHttpUrl(options.mediaUrl);
  const sourcePageUrl = captureHttpUrl(options.sourcePageUrl);
  const stagingDirectory = path.join(options.tempRoot, 'worldlinebox-browser-capture-' + randomUUID());
  const stagedFilePath = path.join(stagingDirectory, 'media');
  let complete = false;
  try {
    options.signal.throwIfAborted();
    const referer = captureReferer(mediaUrl, sourcePageUrl);
    const response = await options.fetch(mediaUrl, { method: 'GET', credentials: 'include', cache: 'no-store',
      referrer: referer, referrerPolicy: 'unsafe-url', headers: { Referer: referer }, signal: options.signal });
    if (response.url) { try { captureHttpUrl(response.url); } catch (error) { await response.body?.cancel(); throw error; } }
    if (!response.ok) { await response.body?.cancel(); throw Error('下载失败：HTTP ' + response.status); }
    if (!response.body) throw Error('下载没有返回媒体内容。');
    const declared = Number(response.headers.get('content-length'));
    const total = Number.isFinite(declared) && declared > 0 ? declared : undefined;
    if (total && total > MAX_BROWSER_CAPTURE_BYTES) { await response.body.cancel(); throw Error('媒体超过 500 MiB 上限。'); }
    await mkdir(stagingDirectory, { recursive: true });
    let byteLength = 0;
    let head = Buffer.alloc(0);
    const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      byteLength += chunk.length;
      if (byteLength > MAX_BROWSER_CAPTURE_BYTES) { callback(Error('媒体超过 500 MiB 上限。')); return; }
      if (head.length < 32) head = Buffer.concat([head, chunk.subarray(0, 32 - head.length)]);
      options.onProgress?.(byteLength, total);
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), limit,
      createWriteStream(stagedFilePath, { flags: 'wx', mode: 0o600 }), { signal: options.signal });
    if (!byteLength) throw Error('媒体内容为空。');
    const declaredType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const probe = Uint8Array.from(head).buffer;
    const contentType = !declaredType || declaredType === 'application/octet-stream'
      ? sniffContentType(probe) ?? declaredType : declaredType;
    if (!contentType || !/^(image|video)\//.test(contentType)) throw Error('服务器未返回支持的图片或视频内容。');
    const filename = captureFilename(mediaUrl, contentType);
    options.signal.throwIfAborted();
    complete = true;
    return { stagedFilePath, stagingDirectory, filename, contentType, byteLength };
  } finally {
    if (!complete) await rm(stagingDirectory, { recursive: true, force: true });
  }
}
