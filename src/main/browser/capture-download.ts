import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { alignFilenameWithContentType, sniffContentType } from '../../../extension/save-client';
import { HOTLINK_SITES } from '../../../extension/hotlink-sites';
import { BROWSER_CAPTURE_LOCAL_MAX_BYTES, BROWSER_CAPTURE_MAX_BYTES, BROWSER_CAPTURE_TEXT_MAX_BYTES,
  type BrowserCaptureRemoteKind } from '../../shared/browser-capture';

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
const extensions: Record<string, readonly string[]> = {
  'image/avif': ['.avif'], 'image/heic': ['.heic', '.heif'],
  'audio/mpeg': ['.mp3'], 'audio/wav': ['.wav'], 'audio/ogg': ['.ogg', '.oga', '.opus'],
  'audio/flac': ['.flac'], 'audio/aac': ['.aac'], 'audio/mp4': ['.m4a'], 'audio/webm': ['.webm'],
  'audio/aiff': ['.aif', '.aiff'], 'application/pdf': ['.pdf'], 'application/zip': ['.zip'],
  'application/x-7z-compressed': ['.7z'], 'application/vnd.rar': ['.rar'],
  'application/epub+zip': ['.epub'], 'text/plain': ['.txt', '.md', '.log'], 'text/markdown': ['.md'],
  'text/csv': ['.csv'], 'application/json': ['.json'], 'application/yaml': ['.yaml', '.yml'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
};
const aliases: Record<string, string> = { 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg', 'audio/x-flac': 'audio/flac', 'audio/x-aiff': 'audio/aiff',
  'application/x-zip-compressed': 'application/zip', 'application/x-rar-compressed': 'application/vnd.rar', 'image/heif': 'image/heic',
  'text/yaml': 'application/yaml' };
function normalizeType(value: string): string { const type = value.split(';')[0]!.trim().toLowerCase(); return aliases[type] ?? type; }
export function safeCaptureFilename(name: string): string {
  // eslint-disable-next-line no-control-regex -- filesystem names cannot include control characters
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 240);
  return !safe || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? 'capture-' + safe : safe;
}
function captureFilename(mediaUrl: string, contentType: string): string {
  let name = contentType.startsWith('video/') ? 'video.bin' : contentType.startsWith('audio/') ? 'audio.bin' : 'capture.bin';
  try { const candidate = new URL(mediaUrl).pathname.split('/').filter(Boolean).pop(); if (candidate?.includes('.')) name = decodeURIComponent(candidate); } catch { /* MIME supplies the extension below. */ }
  return alignCaptureFilename(safeCaptureFilename(name), contentType);
}
function alignCaptureFilename(name: string, contentType: string): string {
  const allowed = extensions[contentType];
  if (!allowed) return alignFilenameWithContentType(name, contentType);
  const extension = path.extname(name).toLowerCase();
  return allowed.includes(extension) ? name : name.slice(0, name.length - extension.length) + allowed[0];
}
function sniffCaptureType(head: Buffer): string | undefined {
  const ascii = (offset: number, text: string) => head.subarray(offset, offset + text.length).toString('ascii') === text;
  if (ascii(0, 'ID3') || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0 && (head[1]! & 0x16) !== 0x10)) return 'audio/mpeg';
  if (head[0] === 0xff && (head[1]! & 0xf6) === 0xf0) return 'audio/aac';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'audio/wav';
  if (ascii(0, 'FORM') && (ascii(8, 'AIFF') || ascii(8, 'AIFC'))) return 'audio/aiff';
  if (ascii(0, 'fLaC')) return 'audio/flac';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (ascii(0, 'RIFF') && ascii(8, 'AVI ')) return 'video/x-msvideo';
  if (head.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || head.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) return 'image/tiff';
  if (head.subarray(0, 8).equals(Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]))) return 'video/x-ms-wmv';
  if (ascii(4, 'ftyp') && /avif|avis/.test(head.subarray(8, 32).toString('ascii'))) return 'image/avif';
  if (ascii(4, 'ftyp') && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(head.subarray(8, 12).toString('ascii'))) return 'image/heic';
  if (ascii(4, 'ftyp') && ascii(8, 'qt  ')) return 'video/quicktime';
  if (ascii(4, 'ftyp') && /^M4A|^M4B/.test(head.subarray(8, 12).toString('ascii'))) return 'audio/mp4';
  if (ascii(0, '%PDF-')) return 'application/pdf';
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))) return 'application/zip';
  if (head.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return 'application/x-7z-compressed';
  if (ascii(0, 'Rar!')) return 'application/vnd.rar';
  return sniffContentType(Uint8Array.from(head).buffer);
}
const textTypes = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/yaml']);
async function validateCaptureFile(filename: string, head: Buffer, declared: string, kind: BrowserCaptureRemoteKind): Promise<string> {
  const declaredType = normalizeType(declared);
  const detected = sniffCaptureType(head);
  const contentType = !declaredType || declaredType === 'application/octet-stream' ? detected ?? declaredType : declaredType;
  if (head.subarray(0, 2).toString() === 'MZ' || head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw Error('不支持采集可执行文件。');
  const media = /^(image|video)\//.test(contentType) && contentType !== 'image/svg+xml';
  const audio = contentType.startsWith('audio/') && !!extensions[contentType];
  if (kind === 'image' && !contentType.startsWith('image/') || kind === 'video' && !contentType.startsWith('video/')
    || kind === 'audio' && !audio || (!media && !audio && (kind !== 'file' || !extensions[contentType]))) throw Error('服务器未返回所选类型的受支持内容。');
  if (contentType === 'image/svg+xml') throw Error('不支持采集可执行的 SVG 内容。');
  if (detected && detected !== contentType) {
    const zipContainer = detected === 'application/zip' && (contentType === 'application/epub+zip' || contentType.startsWith('application/vnd.openxmlformats-officedocument.'));
    const mp4Container = detected === 'video/mp4' && contentType === 'audio/mp4';
    const webmContainer = detected === 'video/webm' && contentType === 'audio/webm';
    const quickTimeContainer = detected === 'video/mp4' && contentType === 'video/quicktime';
    if (!zipContainer && !mp4Container && !webmContainer && !quickTimeContainer) throw Error('文件内容与声明的类型不匹配。');
  } else if (!detected && !textTypes.has(contentType)) throw Error('无法验证文件内容的类型。');
  if (textTypes.has(contentType)) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let prefix = ''; let length = 0;
    for await (const chunk of createReadStream(filename)) {
      length += chunk.length; if (length > BROWSER_CAPTURE_TEXT_MAX_BYTES) throw Error('文本文件超过 4 MiB 上限。');
      const text = decoder.decode(chunk, { stream: true });
      if (text.includes('\0')) throw Error('文件不是可读的 UTF-8 文本。');
      if (prefix.length < 512) prefix += text.slice(0, 512 - prefix.length);
    }
    decoder.decode();
    if (/^\s*(?:<!doctype\s+html|<html\b|<script\b|<svg\b|#!)/i.test(prefix)) throw Error('此内容应保存为网页快照，不支持按普通文件采集。');
  }
  return contentType;
}
/** Local snapshots never contain executable HTML or a page-supplied file path. */
export async function stageCaptureBytes(options: { tempRoot: string; bytes: Uint8Array; filename: string; contentType: string;
  kind: BrowserCaptureRemoteKind; signal: AbortSignal }): Promise<StagedBrowserCapture> {
  if (!options.bytes.length || options.bytes.length > BROWSER_CAPTURE_LOCAL_MAX_BYTES) throw Error('本地内容超过 32 MiB 上限或为空。');
  const stagingDirectory = path.join(options.tempRoot, 'worldlinebox-browser-capture-' + randomUUID());
  const stagedFilePath = path.join(stagingDirectory, 'media'); let complete = false;
  try {
    options.signal.throwIfAborted(); await mkdir(stagingDirectory, { recursive: true });
    await writeFile(stagedFilePath, options.bytes, { flag: 'wx', mode: 0o600 });
    const contentType = await validateCaptureFile(stagedFilePath, Buffer.from(options.bytes.subarray(0, 32)), options.contentType, options.kind);
    options.signal.throwIfAborted(); complete = true;
    return { stagingDirectory, stagedFilePath, filename: alignCaptureFilename(safeCaptureFilename(options.filename), contentType), contentType, byteLength: options.bytes.length };
  } finally { if (!complete) await rm(stagingDirectory, { recursive: true, force: true }); }
}
/** Native picker paths are never accepted from untrusted documents. */
export async function stagePickedCaptureFile(options: { filename: string; tempRoot: string; signal: AbortSignal }): Promise<StagedBrowserCapture> {
  const handle = await open(options.filename, 'r');
  const stagingDirectory = path.join(options.tempRoot, 'worldlinebox-browser-capture-' + randomUUID());
  const stagedFilePath = path.join(stagingDirectory, 'media'); let complete = false;
  try {
    const stat = await handle.stat(); if (!stat.isFile() || !stat.size || stat.size > MAX_BROWSER_CAPTURE_BYTES) throw Error('请选择不超过 500 MiB 的文件。');
    const head = Buffer.alloc(32); const probe = await handle.read(head, 0, 32, 0);
    const suffix = path.extname(options.filename).toLowerCase();
    const declared = Object.entries(extensions).find(([, suffixes]) => suffixes.includes(suffix))?.[0] ?? sniffCaptureType(head.subarray(0, probe.bytesRead)) ?? '';
    await mkdir(stagingDirectory, { recursive: true }); let byteLength = 0;
    await pipeline(handle.createReadStream({ autoClose: false, start: 0 }), new Transform({ transform(chunk: Buffer, _encoding, callback) {
      byteLength += chunk.length; callback(byteLength > MAX_BROWSER_CAPTURE_BYTES ? Error('文件超过 500 MiB 上限。') : null, chunk);
    } }), createWriteStream(stagedFilePath, { flags: 'wx', mode: 0o600 }), { signal: options.signal });
    const contentType = await validateCaptureFile(stagedFilePath, head.subarray(0, probe.bytesRead), declared, 'file');
    options.signal.throwIfAborted(); complete = true;
    return { stagingDirectory, stagedFilePath, filename: alignCaptureFilename(safeCaptureFilename(path.basename(options.filename)), contentType), contentType, byteLength };
  } finally { await handle.close(); if (!complete) await rm(stagingDirectory, { recursive: true, force: true }); }
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
  kind: BrowserCaptureRemoteKind;
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
    const contentType = await validateCaptureFile(stagedFilePath, head, response.headers.get('content-type') ?? '', options.kind);
    const filename = captureFilename(mediaUrl, contentType);
    options.signal.throwIfAborted();
    complete = true;
    return { stagedFilePath, stagingDirectory, filename, contentType, byteLength };
  } finally {
    if (!complete) await rm(stagingDirectory, { recursive: true, force: true });
  }
}
