import { COMPANION_MEDIA_PREVIEW_MAX_BYTES } from '../../shared/companion-media';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { companionFileToolArgumentsSchemas, companionToolImageReferenceSchema, type CompanionToolImageReference, type ToolVisualInput } from '../../shared/companion-file-tool';
import type { CompanionAttachment } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse, StoredCompanionAttachment } from '../../shared/companion-storage';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_SEND_BYTES = COMPANION_MEDIA_PREVIEW_MAX_BYTES;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type StableFile = { path: string; bytes: Buffer };
export interface CompanionReadFileResult {
  content: string;
  attachments: CompanionAttachment[];
  file: { path: string; size: number; totalLines: number; offset: number; lineCount: number; nextOffset?: number;
    encoding: 'utf-8' | 'utf-16le' | 'utf-16be'; truncated: boolean; attachmentId: string; sha256: string };
}
export interface CompanionReadImageResult { content: string; images: CompanionToolImageReference[]; attachments: CompanionAttachment[] }
export interface CompanionSendFileResult { content: string; attachments: CompanionAttachment[]; file: { path: string; size: number; mime: string; attachmentId: string; sha256?: string; linked?: boolean } }
export interface CompanionHydratedImages { images: Array<Omit<ToolVisualInput, 'callId'>>; unavailable: Array<{ attachmentId: string; error: string }> }

/** Read-only source access, with immutable managed copies for durable UI/provenance. No command execution. */
export class CompanionFileReader {
  constructor(private readonly options: { root: string; request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> }) {}

  private async cached<Result>(key?: string): Promise<Result | undefined> {
    if (key === undefined) return undefined;
    const response = await this.options.request({ type: 'file.result.get', key });
    if (!response.ok) throw new Error('无法读取已保存的文件工具结果。');
    return response.fileToolResult === undefined ? undefined : JSON.parse(response.fileToolResult) as Result;
  }

  private async commit<Result>(result: Result, attachments: StoredCompanionAttachment[], key?: string): Promise<Result> {
    const response = await this.options.request({ type: 'file.result.commit', key: key ?? sha(Buffer.from(randomUUID())), result: JSON.stringify(result), attachments });
    if (!response.ok || response.fileToolResult === undefined) throw new Error('无法保存文件工具结果。');
    // Another attempt may have committed this call while its source was being read.
    return JSON.parse(response.fileToolResult) as Result;
  }

  private async stableFile(input: string, maximum = MAX_FILE_BYTES): Promise<StableFile> {
    if (!path.isAbsolute(input) || input.includes('\0')) throw new Error('只读文件工具需要真实绝对路径。');
    const source = await realpath(input), first = await lstat(input, { bigint: true });
    if (!first.isFile() || first.isSymbolicLink()) throw new Error('只读文件工具仅接受普通文件，不能读取目录或符号链接。');
    if (first.size > BigInt(maximum)) throw new Error(`文件超过 ${maximum === MAX_FILE_BYTES ? '20 MiB' : '1 MiB'} 读取上限。`);
    const handle = await open(source, 'r');
    try {
      const before = await handle.stat({ bigint: true });
      const same = (left: typeof before, right: typeof before) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
      if (!before.isFile() || !same(first, before) || before.size > BigInt(maximum)) throw new Error('文件在读取前已被替换，请重新读取。');
      const buffer = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < buffer.length) { const read = await handle.read(buffer, count, buffer.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
      const after = await handle.stat({ bigint: true }), current = await lstat(source, { bigint: true });
      if (count !== Number(before.size) || !same(before, after) || !same(before, current) || current.isSymbolicLink()) throw new Error('文件在读取期间已更改或替换，本次结果已丢弃。');
      return { path: source, bytes: buffer.subarray(0, count) };
    } finally { await handle.close(); }
  }

  private decode(bytes: Buffer): { text: string; encoding: CompanionReadFileResult['file']['encoding'] } {
    let encoding: CompanionReadFileResult['file']['encoding'] = 'utf-8', start = 0;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; start = 2; }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; start = 2; }
    else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
    let text: string;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(start)); }
    catch { throw new Error('文件不是有效 UTF-8 或带 BOM 的 UTF-16 文本，请使用合适的任务工具读取该格式。'); }
    for (let index = 0; index < text.length; index++) { const code = text.charCodeAt(index); if (code === 127 || code < 32 && code !== 9 && code !== 10 && code !== 13) throw new Error('文件包含二进制控制字符，不能作为纯文本读取。'); }
    if (text.startsWith('%PDF-') || text.startsWith('GIF87a') || text.startsWith('GIF89a')) throw new Error('文件包含二进制或不支持的格式，不能作为纯文本读取。');
    return { text, encoding };
  }

  private async managedDirectory(): Promise<{ root: string; directory: string }> {
    if (!path.isAbsolute(this.options.root)) throw new Error('附件存储根目录必须是绝对路径。');
    const root = await realpath(this.options.root), candidate = path.join(root, 'attachments');
    await mkdir(candidate, { recursive: true });
    const directory = await realpath(candidate), info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isDirectory() || path.relative(root, directory) !== 'attachments') throw new Error('附件目录不是受管目录，已停止保存快照。');
    return { root, directory };
  }

  private async snapshot(bytes: Buffer, source: string, mime: string, extension: 'txt' | 'jpg'): Promise<{ attachment: CompanionAttachment; path: string; stored: StoredCompanionAttachment }> {
    const { directory } = await this.managedDirectory(), id = randomUUID(), relativePath = `attachments/${id}.${extension}`, file = path.join(directory, `${id}.${extension}`), temporary = file + '.tmp';
    try { const target = await open(temporary, 'wx'); try { await target.writeFile(bytes); await target.sync(); } finally { await target.close(); } await rename(temporary, file); }
    finally { await unlink(temporary).catch(() => undefined); }
    if (path.dirname(await realpath(file)) !== directory) throw new Error('受管快照路径已经改变。');
    const name = extension === 'jpg' ? path.parse(source).name.slice(0, 220) + '.jpg' : path.basename(source).slice(0, 240);
    const attachment: CompanionAttachment = { id, name, mime, size: bytes.length };
    return { attachment: { ...attachment, path: file, url: 'worldlinebox-companion://attachment/' + id }, path: file, stored: { attachment, relativePath } };
  }

  async readFile(input: { path: string; offset?: number; limit?: number }, key?: string): Promise<CompanionReadFileResult> {
    const previous = await this.cached<CompanionReadFileResult>(key); if (previous !== undefined) return previous;
    const args = companionFileToolArgumentsSchemas.read_file.parse(input), source = await this.stableFile(args.path), decoded = this.decode(source.bytes);
    const base = { path: source.path, size: source.bytes.length, totalLines: 0, offset: args.offset, encoding: decoded.encoding };
    const selected: string[] = [], available = MAX_TEXT_BYTES - Buffer.byteLength(JSON.stringify(base), 'utf8') - 1024; let used = 0, stopped = false;
    const line = (start: number, end: number) => {
      const index = base.totalLines++;
      if (index < args.offset || selected.length >= args.limit || stopped) return;
      const displayed = `${index + 1} | ${decoded.text.slice(start, end)}\n`, bytes = Buffer.byteLength(displayed, 'utf8');
      if (used + bytes > available) { if (!selected.length) throw new Error('单行文本超过 128 KiB 返回上限，请使用任务工具进一步处理该文件。'); stopped = true; return; }
      selected.push(displayed); used += bytes;
    };
    // Count the entire text without allocating an array for millions of lines.
    let start = 0, index = 0;
    while (index < decoded.text.length) {
      const code = decoded.text.charCodeAt(index);
      if (code === 10 || code === 13) { line(start, index); index += code === 13 && decoded.text.charCodeAt(index + 1) === 10 ? 2 : 1; start = index; }
      else index++;
    }
    if (start < decoded.text.length) line(start, decoded.text.length);
    const nextOffset = args.offset + selected.length < base.totalLines ? args.offset + selected.length : undefined;
    const saved = await this.snapshot(source.bytes, source.path, 'text/plain', 'txt');
    const file = { ...base, lineCount: selected.length, ...(nextOffset !== undefined ? { nextOffset } : {}), truncated: nextOffset !== undefined, attachmentId: saved.attachment.id, sha256: sha(source.bytes) };
    const content = JSON.stringify(file) + '\n' + selected.join('');
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) throw new Error('文本分页超出返回上限。');
    return this.commit({ content, attachments: [saved.attachment], file }, [saved.stored], key);
  }

  async readImage(input: { path: string }, key?: string): Promise<CompanionReadImageResult> {
    const previous = await this.cached<CompanionReadImageResult>(key); if (previous !== undefined) return previous;
    const args = companionFileToolArgumentsSchemas.read_image.parse(input), source = await this.stableFile(args.path);
    return this.captureImage(source.bytes, source.path, key);
  }

  /** Pixels captured by the native browser, without accepting a model-supplied path. */
  async captureImage(input: Uint8Array, name = 'browser-page.png', key?: string): Promise<CompanionReadImageResult> {
    const source = { bytes: Buffer.from(input), path: name };
    let bytes: Buffer, width: number, height: number, frames: number;
    try {
      const pixels = sharp(source.bytes, { limitInputPixels: MAX_PIXELS, failOn: 'warning', animated: false }), metadata = await pixels.metadata();
      if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format) || metadata.width * metadata.height > MAX_PIXELS) throw new Error('Unsupported image');
      frames = metadata.pages ?? 1;
      let normalized = await pixels.rotate().flatten({ background: '#ffffff' }).resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true });
      if (normalized.data.length > MAX_IMAGE_BYTES) normalized = await sharp(normalized.data).resize({ width: 1280, height: 1280, fit: 'inside' }).jpeg({ quality: 74 }).toBuffer({ resolveWithObject: true });
      if (normalized.data.length > MAX_IMAGE_BYTES) normalized = await sharp(normalized.data).resize({ width: 1024, height: 1024, fit: 'inside' }).jpeg({ quality: 60 }).toBuffer({ resolveWithObject: true });
      if (normalized.data.length > MAX_IMAGE_BYTES) throw new Error('Image still too large');
      bytes = normalized.data; width = normalized.info.width; height = normalized.info.height;
    } catch { throw new Error('图片无法完整解码，或超过 64M 像素/1 MiB 输出限制；仅支持 PNG、JPEG、WebP、GIF。'); }
    const saved = await this.snapshot(bytes, source.path, 'image/jpeg', 'jpg');
    const image: CompanionToolImageReference = { attachmentId: saved.attachment.id, sha256: sha(bytes), mime: 'image/jpeg', width, height, path: saved.path };
    return this.commit({ content: JSON.stringify({ sourcePath: source.path, sourceSize: source.bytes.length, image, ...(frames > 1 ? { animation: '仅第一帧静态快照' } : {}),
      notice: '宿主已实际解码并保存只读图像快照。是否向模型提供像素由本轮 toolVisionManifest 确认。' }), images: [image], attachments: [saved.attachment] }, [saved.stored], key);
  }

  async sendFile(input: { path: string }, key?: string): Promise<CompanionSendFileResult> {
    const previous = await this.cached<CompanionSendFileResult>(key); if (previous !== undefined) return previous;
    const args = companionFileToolArgumentsSchemas.send_file.parse(input);
    if (!path.isAbsolute(args.path)) throw new Error('发送文件需要真实绝对路径。');
    const source = await realpath(args.path), first = await lstat(args.path, { bigint: true });
    if (!first.isFile() || first.isSymbolicLink()) throw new Error('只能发送已有普通文件，不能发送目录或符号链接。');

    const { directory } = await this.managedDirectory(), id = randomUUID(), rawExtension = path.extname(source).slice(1).toLowerCase();
    const extension = /^[a-z0-9]{1,16}$/u.test(rawExtension) ? '.' + rawExtension : '.bin', relativePath = `attachments/${id}${extension}`;
    const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
      pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml', html: 'text/html', zip: 'application/zip' } as Record<string, string>)[rawExtension] ?? 'application/octet-stream';
    if (first.size > BigInt(MAX_SEND_BYTES)) {
      if (first.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('文件大小超出可登记范围。');
      const attachment: CompanionAttachment = { id, name: path.basename(source).slice(0, 240), mime, size: Number(first.size) };
      const file = { path: source, size: attachment.size, mime, attachmentId: id, linked: true };
      return this.commit({ content: JSON.stringify({ ...file, notice: '已附上本机原文件引用。大文件不复制、不载入内存，在聊天卡片中使用系统应用打开；源文件移动或删除后将不可用。' }),
        file, attachments: [{ ...attachment, path: source, url: 'worldlinebox-companion://attachment/' + id }] }, [{ attachment, relativePath, sourcePath: source }], key);
    }
    const destination = path.join(directory, id + extension), temporary = destination + '.tmp', original = await open(source, 'r');
    let count = 0; const digest = createHash('sha256');
    try {
      const before = await original.stat({ bigint: true });
      const same = (left: typeof before, right: typeof before) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
      if (!before.isFile() || !same(first, before)) throw new Error('文件在发送前已经替换，请重新选择。');
      const copy = await open(temporary, 'wx');
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        while (true) {
          const read = await original.read(buffer, 0, buffer.length, count); if (!read.bytesRead) break;
          if (count + read.bytesRead > MAX_SEND_BYTES) throw new Error('文件在复制期间超过 256 MiB 快照上限，请重新发送原文件引用。');
          let written = 0; while (written < read.bytesRead) { const part = await copy.write(buffer, written, read.bytesRead - written, count + written); if (!part.bytesWritten) throw new Error('无法完整保存附件快照。'); written += part.bytesWritten; }
          digest.update(buffer.subarray(0, read.bytesRead)); count += read.bytesRead;
        }
        const after = await original.stat({ bigint: true }), current = await lstat(source, { bigint: true });
        if (count !== Number(before.size) || !same(before, after) || !same(before, current) || current.isSymbolicLink()) throw new Error('文件在发送期间发生更改，本次附件已丢弃。');
        await copy.sync();
      } finally { await copy.close(); }
      await rename(temporary, destination);
    } finally { await original.close(); await unlink(temporary).catch(() => undefined); }
    if (path.dirname(await realpath(destination)) !== directory) throw new Error('附件快照不属于受管目录。');

    const attachment: CompanionAttachment = { id, name: path.basename(source).slice(0, 240), mime, size: count };
    const file = { path: source, size: count, mime, attachmentId: id, sha256: digest.digest('hex') };
    return this.commit({ content: JSON.stringify({ ...file, notice: '仅将已有文件附在当前回复中；未分析音频、视频或文档内容，也未执行或更改源文件。' }),
      file, attachments: [{ ...attachment, path: destination, url: 'worldlinebox-companion://attachment/' + id }] }, [{ attachment, relativePath }], key);
  }

  async hydrate(references: readonly CompanionToolImageReference[]): Promise<CompanionHydratedImages> {
    const result: CompanionHydratedImages = { images: [], unavailable: [] }, seen = new Set<string>();
    for (const candidate of references) {
      const id = candidate.attachmentId;
      try {
        const reference = companionToolImageReferenceSchema.parse(candidate);
        if (result.images.length >= 4) throw new Error('本轮最多提供四张工具图像。');
        if (seen.has(id)) continue;
        if (!path.isAbsolute(reference.path)) throw new Error('快照不是绝对路径。');
        const stored = (await this.options.request({ type: 'attachment.get', id })).storedAttachment;
        if (!stored || stored.attachment.id !== id || stored.sourcePath || stored.attachment.path || stored.attachment.mime !== reference.mime) throw new Error('快照登记已失效。');
        const root = await realpath(this.options.root), expected = await realpath(path.resolve(root, stored.relativePath)), actual = await realpath(reference.path);
        if (path.dirname(expected) !== path.join(root, 'attachments') || path.relative(expected, actual) !== '') throw new Error('快照路径不属于登记的受管附件。');
        const source = await this.stableFile(expected, MAX_IMAGE_BYTES);
        if (sha(source.bytes) !== reference.sha256 || source.bytes.length !== stored.attachment.size) throw new Error('快照内容已替换或损坏。');
        const metadata = await sharp(source.bytes, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).metadata();
        const mime = metadata.format === 'jpeg' ? 'image/jpeg' : metadata.format === 'png' ? 'image/png' : metadata.format === 'webp' ? 'image/webp' : undefined;
        if (mime !== reference.mime || metadata.width !== reference.width || metadata.height !== reference.height || reference.width > 1536 || reference.height > 1536) throw new Error('快照尺寸或类型已改变。');
        await sharp(source.bytes, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).raw().toBuffer();
        seen.add(id); result.images.push({ attachmentId: id, mime: reference.mime, base64: source.bytes.toString('base64'), sha256: reference.sha256 });
      } catch (error) { result.unavailable.push({ attachmentId: id, error: 'unavailable: ' + (error instanceof Error ? error.message : '快照不可读取。') }); }
    }
    return result;
  }
}
