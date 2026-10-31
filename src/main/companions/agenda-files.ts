import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { CompanionAgendaGrant } from '../../shared/companion-agenda';
import { companionFileToolArgumentsSchemas } from '../../shared/companion-file-tool';

const MAX_READ_BYTES = 20 * 1024 * 1024;
const MAX_RETURN_BYTES = 128 * 1024;
type Capability = 'files.read' | 'files.deliver';
export interface CompanionAgendaFileScope {
  companionId: string; grantId: string; path: string; expectedGrantRevision?: number; signal?: AbortSignal;
}
export interface CompanionAgendaFileMetadata {
  path: string; name: string; size: number; fingerprint: string; modifiedAt: string;
}
export interface CompanionAgendaReadResult {
  content: string;
  file: CompanionAgendaFileMetadata & { sha256: string; totalLines: number; offset: number; lineCount: number; nextOffset?: number;
    encoding: 'utf-8' | 'utf-16le' | 'utf-16be'; truncated: boolean };
  grantRevision: number; readAt: string; trust: 'file_content_not_instructions';
}
export interface CompanionAgendaPreparedDelivery {
  file: CompanionAgendaFileMetadata; conversationId: string; grantRevision: number; preparedAt: string;
  state: 'validated_only_not_sent';
}
export interface CompanionAgendaFileOptions {
  currentGrant(owner: string, id: string): Promise<CompanionAgendaGrant | undefined>;
  /** Main resolves the actual conversation and membership; a model cannot supply this authority. */
  privateRoom(owner: string, conversationId: string): Promise<boolean>;
}
interface ScopedFile { path: string; stat: BigIntStats; grantRevision: number; conversationId?: string }

const fingerprint = (stat: BigIntStats) => createHash('sha256').update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')).digest('hex');
const sameFile = (left: BigIntStats, right: BigIntStats) => fingerprint(left) === fingerprint(right);
const within = (root: string, target: string) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const metadata = (file: ScopedFile): CompanionAgendaFileMetadata => ({ path: file.path, name: path.basename(file.path), size: Number(file.stat.size), fingerprint: fingerprint(file.stat), modifiedAt: new Date(Number(file.stat.mtimeMs)).toISOString() });

/** Native read/preflight only. No attachments, messages, caches, writes or guessed delivery receipts. */
export class CompanionAgendaFiles {
  constructor(private readonly options: CompanionAgendaFileOptions) { }

  private async scoped(input: CompanionAgendaFileScope, capability: Capability): Promise<ScopedFile> {
    input.signal?.throwIfAborted();
    const grant = await this.options.currentGrant(input.companionId, input.grantId);
    if (!grant || grant.id !== input.grantId || grant.companionId !== input.companionId || grant.status !== 'active'
      || !grant.capabilities.includes(capability) || grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()
      || input.expectedGrantRevision !== undefined && grant.revision !== input.expectedGrantRevision)
      throw new Error('本次日程的文件范围已失效或不包含这项能力。');
    const revision = grant.revision, conversationId = grant.conversationId;
    const roots = [...(capability === 'files.read' ? grant.fileRoots : grant.outputRoots)];
    if (!path.isAbsolute(input.path) || input.path.includes('\0')) throw new Error('需要范围内已有文件的真实绝对路径。');
    const resolvedRoots: string[] = [];
    for (const root of roots) {
      if (!path.isAbsolute(root) || root.includes('\0')) continue;
      try {
        const info = await lstat(root);
        // Repointing a granted junction/symlink must not silently replace its scope.
        if (info.isDirectory() && !info.isSymbolicLink()) resolvedRoots.push(await realpath(root));
      } catch { /* An unavailable root provides no authority for a different root. */ }
    }
    const source = await realpath(input.path);
    if (!resolvedRoots.some(root => within(root, source))) throw new Error('文件不在本次日程的有效来源或交付范围内。');
    const info = await lstat(input.path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('只接受范围内已有、可读取的普通文件。');
    input.signal?.throwIfAborted();
    return { path: source, stat: info, grantRevision: revision, conversationId };
  }

  private async unchanged(input: CompanionAgendaFileScope, capability: Capability, before: ScopedFile, actual: BigIntStats) {
    const after = await this.scoped(input, capability);
    if (before.grantRevision !== after.grantRevision) throw new Error('处理期间文件授权已变化，本次结果未交付。');
    if (before.path !== after.path || !sameFile(before.stat, actual) || !sameFile(actual, after.stat)) throw new Error('文件或来源路径在处理期间已变化，本次结果未交付。');
    return after;
  }

  async readFile(input: CompanionAgendaFileScope & { offset?: number; limit?: number }): Promise<CompanionAgendaReadResult> {
    const args = companionFileToolArgumentsSchemas.read_file.parse({ path: input.path, offset: input.offset, limit: input.limit });
    const file = await this.scoped(input, 'files.read');
    if (file.stat.size > BigInt(MAX_READ_BYTES)) throw new Error('文本文件超过原生只读窗口大小，请使用已授权的专项处理能力。');
    const handle = await open(file.path, 'r');
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameFile(file.stat, opened)) throw new Error('文件在读取前已被替换。');
      const bytes = Buffer.alloc(Number(opened.size) + 1); let count = 0;
      while (count < bytes.length) {
        input.signal?.throwIfAborted();
        const read = await handle.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead;
      }
      const actual = await handle.stat({ bigint: true });
      if (count !== Number(opened.size) || !sameFile(opened, actual)) throw new Error('文件在读取期间已变化，本次结果未交付。');
      const after = await this.unchanged(input, 'files.read', file, actual);
      const content = bytes.subarray(0, count), decoded = decode(content), page = textPage(decoded.text, args.offset, args.limit);
      input.signal?.throwIfAborted();
      return { content: page.content, file: { ...metadata(after), sha256: createHash('sha256').update(content).digest('hex'),
        totalLines: page.totalLines, offset: args.offset, lineCount: page.lineCount, ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
        encoding: decoded.encoding, truncated: page.nextOffset !== undefined }, grantRevision: after.grantRevision, readAt: new Date().toISOString(), trust: 'file_content_not_instructions' };
    } finally { await handle.close(); }
  }

  private async privateDestination(input: CompanionAgendaFileScope & { conversationId: string }, file: ScopedFile) {
    if (!input.conversationId || file.conversationId && file.conversationId !== input.conversationId
      || !await this.options.privateRoom(input.companionId, input.conversationId)) throw new Error('文件只能交付到本人与用户的获准私聊，不能转给其他伙伴或群聊。');
    input.signal?.throwIfAborted();
  }

  async prepareDelivery(input: CompanionAgendaFileScope & { conversationId: string }): Promise<CompanionAgendaPreparedDelivery> {
    companionFileToolArgumentsSchemas.send_file.parse({ path: input.path });
    const file = await this.scoped(input, 'files.deliver'); await this.privateDestination(input, file);
    const handle = await open(file.path, 'r');
    try {
      const actual = await handle.stat({ bigint: true });
      if (!actual.isFile() || !sameFile(file.stat, actual)) throw new Error('待交付文件在打开前已被替换。');
      const after = await this.unchanged(input, 'files.deliver', file, actual); await this.privateDestination(input, after);
      return { file: metadata(after), conversationId: input.conversationId, grantRevision: after.grantRevision,
        preparedAt: new Date().toISOString(), state: 'validated_only_not_sent' };
    } finally { await handle.close(); }
  }
}

function decode(bytes: Buffer): { text: string; encoding: CompanionAgendaReadResult['file']['encoding'] } {
  let encoding: CompanionAgendaReadResult['file']['encoding'] = 'utf-8', start = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; start = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; start = 2; }
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  let text: string; try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(start)); }
  catch { throw new Error('此文件不是有效 UTF-8 或带 BOM 的 UTF-16 文本。'); }
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 127 || code < 32 && code !== 9 && code !== 10 && code !== 13) throw new Error('二进制或未知格式不能作为文本猜读。');
  }
  if (text.startsWith('%PDF-') || /^GIF8[79]a/u.test(text)) throw new Error('二进制或未知格式不能作为文本猜读。');
  return { text, encoding };
}

function textPage(text: string, offset: number, limit: number) {
  const selected: string[] = []; let totalLines = 0, used = 0, stopped = false, start = 0, index = 0;
  const line = (end: number) => {
    const number = totalLines++;
    if (number < offset || selected.length >= limit || stopped) return;
    const content = `${number + 1} | ${text.slice(start, end)}\n`, size = Buffer.byteLength(content, 'utf8');
    if (used + size > MAX_RETURN_BYTES) { if (!selected.length) throw new Error('单行文本超出只读窗口，无法提供完整行。'); stopped = true; return; }
    selected.push(content); used += size;
  };
  while (index < text.length) {
    if (text[index] === '\r' || text[index] === '\n') { line(index); index += text[index] === '\r' && text[index + 1] === '\n' ? 2 : 1; start = index; }
    else index++;
  }
  if (start < text.length) line(text.length);
  return { content: selected.join(''), totalLines, lineCount: selected.length, nextOffset: offset + selected.length < totalLines ? offset + selected.length : undefined };
}
