import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { lstat, mkdir, open, opendir, rm, rmdir, writeFile, rename } from './disk';
import { atomicJson, readJson } from './files';
import type { DshTaskEvent } from '../../shared/dsh-tasks';
import { dshTaskEventSchema } from '../../shared/dsh-tasks';
import { DSH_RECORD_LIMITS, dshRecordQuerySchema, dshRecordOverviewSchema, dshRecordScopeSchema,
  type DshRecordOverview, type DshRecordPage, type DshRecordQuery } from '../../shared/dsh-task-record';

const MAX_BYTES = 64 * 1024 ** 2, MAX_RECORDS = 100000, MAX_PENDING = 8 * 1024 ** 2, INDEX_BYTES = 12;
const metadataSchema = z.object({ format: z.literal('worldlinebox-dsh-record-v1'), overview: dshRecordOverviewSchema, scope: dshRecordScopeSchema.optional() });
type Metadata = z.infer<typeof metadataSchema>;
type Writer = { metadata: Metadata; chain: Promise<void>; pending: number; bytes: number; count: number; failure?: Error;
  started: number; finalText?: string; paused?: boolean; data: Awaited<ReturnType<typeof open>>; index: Awaited<ReturnType<typeof open>> };

/** Append-only JSONL plus fixed-width byte index. Range reads never scan a whole transcript. */
export class DshTaskRecordStore {
  private readonly writers = new Map<string, Writer>();
  constructor(private readonly root: string, private readonly onFailure?: (id: string, error: Error) => void,
    private readonly onPressure?: (id: string, paused: boolean) => void) {}
  private pressure(id: string, writer: Writer) {
    if (!writer.paused && writer.pending >= 1024 ** 2) { writer.paused = true; this.onPressure?.(id, true); }
    else if (writer.paused && writer.pending < 256 * 1024) { writer.paused = false; this.onPressure?.(id, false); }
  }
  private fail(id: string, writer: Writer, error: Error) {
    if (writer.failure) return;
    writer.failure = error;
    this.onFailure?.(id, error);
  }
  private async ownerDirectory(owner: string, create = false) {
    dshRecordScopeSchema.shape.companionId.parse(owner);
    for (const directory of [this.root, path.join(this.root, 'by-owner'), path.join(this.root, 'by-owner', owner)]) {
      if (create) await mkdir(directory, { recursive: true });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('任务记录归属目录不可链接。');
    }
    return path.join(this.root, 'by-owner', owner);
  }
  private async sessionDirectory(metadata: Metadata, create = false): Promise<string | undefined> {
    if (!metadata.scope) return;
    const owner = await this.ownerDirectory(metadata.scope.companionId, create);
    const date = new Date(metadata.overview.createdAt);
    if (!Number.isFinite(date.getTime())) throw new Error('任务记录开始日期无效。');
    const day = metadata.overview.archiveDay ?? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error('任务归档日期无效。');
    if (create) metadata.overview.archiveDay = day;
    const title = Array.from(metadata.overview.title.replace(/[\p{Cc}<>:"/\\|?*]/gu, '_').replace(/[. ]+$/u, '')).slice(0, 48).join('') || 'DSH';
    const directory = path.join(owner, day, `${title}--${z.uuid().parse(metadata.overview.recordId)}`);
    for (const part of [path.join(owner, day), directory]) {
      if (create) await mkdir(part, { recursive: true });
      const info = await lstat(part);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('任务会话归档目录不可链接。');
    }
    return directory;
  }
  private async readableArchive(metadata: Metadata, finalText = ''): Promise<void> {
    const directory = await this.sessionDirectory(metadata, true);
    if (!directory) return;
    const overview = metadata.overview, rawDirectory = await this.directory(overview.recordId);
    overview.archivePath = directory; overview.reportPath = path.join(directory, 'report.md');
    const status = { running: '执行中', succeeded: '已成功', failed: '失败', cancelled: '已取消', interrupted: '已中断' }[overview.status];
    const report = [`# ${overview.title}`, '', `状态：${status}`, `任务记录：${overview.recordId}`,
      `行动：${metadata.scope!.actionId}`, `会话：${overview.sessionId ?? '尚未建立'}`,
      `开始：${new Date(overview.createdAt).toLocaleString()}`, `结束：${overview.finishedAt ? new Date(overview.finishedAt).toLocaleString() : '尚未结束'}`,
      `执行轮次：${overview.turns}；模型步骤：${overview.steps}；工具调用：${overview.toolCalls}`,
      ...(overview.startup ? [`启动准备：${Math.round(overview.startup.preparationMs)} ms；CLI 就绪等待：${Math.round(overview.startup.bootMs)} ms；${overview.startup.reusedWorker ? '复用预热进程，独立任务会话' : '新启动进程'}`] : []),
      ...(overview.workspacePath ? [`工作目录：${overview.workspacePath}`] : []),
      ...(overview.error ? ['', '## 实际错误', '', overview.error] : []),
      '', '## 执行器实际报告', '', finalText || overview.finalReply || '尚无执行器最终正文；本记录不证明任务已交付。',
      '', '## 已记录产物', '', ...(overview.artifacts?.length ? overview.artifacts.map(item => `- ${item.path}${item.description ? `：${item.description}` : ''}`) : ['未记录产物。']),
      '', '## 原始步骤', '', `记录数：${overview.recordCount}；${overview.complete ? '记录完整' : '运行中或记录不完整'}`,
      `JSONL：${path.join(rawDirectory, 'events.jsonl')}`, `字节索引：${path.join(rawDirectory, 'events.idx')}`,
      '原始步骤来自实际执行事件，已去除隐藏推理和凭证；也可经任务记录详情按序分页读取。', ''].join('\n');
    const existingReport = await lstat(overview.reportPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return; throw error; });
    if (existingReport && (!existingReport.isFile() || existingReport.isSymbolicLink())) throw new Error('任务报告文件不可链接。');
    const temporaryReport = path.join(directory, `report.md.${randomUUID()}.tmp`);
    try { await writeFile(temporaryReport, report, { flag: 'wx', mode: 0o600 }); await rename(temporaryReport, overview.reportPath); }
    finally { await rm(temporaryReport, { force: true }); }
    const manifest = path.join(directory, 'session.json');
    const existing = await lstat(manifest).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('任务会话清单不可链接。');
    await atomicJson(manifest, { format: 'worldlinebox-dsh-session-v1', scope: metadata.scope, overview,
      rawRecord: { metadata: path.join(rawDirectory, 'metadata.json'), events: path.join(rawDirectory, 'events.jsonl'), index: path.join(rawDirectory, 'events.idx') } });
  }
  private async directory(id: string, create = false): Promise<string> {
    z.uuid().parse(id);
    if (create) await mkdir(this.root, { recursive: true });
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('任务记录目录不可链接。');
    const directory = path.join(this.root, id);
    if (create) await mkdir(directory);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('任务记录目录无效。');
    return directory;
  }
  private async file(directory: string, name: string, mode: 'r' | 'a') {
    const filename = path.join(directory, name);
    const info = await lstat(filename).catch((error: NodeJS.ErrnoException) => { if (mode === 'a' && error.code === 'ENOENT') return; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('任务记录文件不可链接。');
    return open(filename, mode, 0o600);
  }
  async begin(id: string, title: string, scope?: Metadata['scope']): Promise<void> {
    const directory = await this.directory(id, true);
    const metadata: Metadata = { format: 'worldlinebox-dsh-record-v1', scope,
      overview: { recordId: id, title, status: 'running', createdAt: new Date().toISOString(), durationMs: 0, turns: 0, steps: 0, toolCalls: 0,
        recordCount: 0, storedBytes: 0, finalReply: '', finalReplyChars: 0, finalReplyTruncated: false, complete: false, storageLimited: false } };
    if (scope) dshRecordScopeSchema.parse(scope);
    await atomicJson(path.join(directory, 'metadata.json'), metadata);
    if (scope) {
      const ownerDirectory = await this.ownerDirectory(scope.companionId, true);
      const marker = await open(path.join(ownerDirectory, id), 'wx', 0o600);
      await marker.close();
    }
    await this.readableArchive(metadata);
    await atomicJson(path.join(directory, 'metadata.json'), metadata);
    const data = await open(path.join(directory, 'events.jsonl'), 'wx', 0o600);
    try {
      const index = await open(path.join(directory, 'events.idx'), 'wx', 0o600);
      this.writers.set(id, { metadata, chain: Promise.resolve(), pending: 0, bytes: 0, count: 0, started: performance.now(), data, index });
    } catch (error) { await data.close(); throw error; }
  }
  append(id: string, event: DshTaskEvent): void {
    const writer = this.writers.get(id);
    if (!writer || writer.failure) return;
    // Reasoning and unknown protocol fields are never part of the inspectable record.
    if (/(?:^|[._-])(reasoning|thinking|analysis)(?:$|[._-])/i.test(event.type)) return;
    const line = Buffer.from(JSON.stringify(event) + '\n');
    const overview = writer.metadata.overview;
    if (event.stage === 'turn_start') overview.turns++;
    if (event.stage === 'step_start') overview.steps++;
    if (event.stage === 'tool_start') overview.toolCalls++;
    if (event.type === 'final' && event.text !== undefined) {
      writer.finalText = event.text;
      overview.finalReply = event.text.slice(0, DSH_RECORD_LIMITS.finalChars);
      overview.finalReplyChars = event.text.length; overview.finalReplyTruncated = event.text.length > DSH_RECORD_LIMITS.finalChars;
    }
    if (writer.bytes + line.length > MAX_BYTES || writer.count >= MAX_RECORDS) { overview.storageLimited = true; return; }
    if (writer.pending + line.length > MAX_PENDING) { this.fail(id, writer, new Error('任务记录写入积压超过安全上限，任务已停止。')); return; }
    const index = Buffer.alloc(INDEX_BYTES);
    index.writeBigUInt64LE(BigInt(writer.bytes)); index.writeUInt32LE(line.length, 8);
    writer.bytes += line.length; writer.count++; writer.pending += line.length;
    this.pressure(id, writer);
    const count = writer.count, bytes = writer.bytes;
    if (event.type === 'final' && event.text !== undefined) {
      overview.finalRecord = count;
    }
    writer.chain = writer.chain.then(async () => {
      const directory = await this.directory(id);
      await writer.data.writeFile(line);
      await writer.index.writeFile(index);
      overview.recordCount = count; overview.storedBytes = bytes;
      if (count % 32 === 0) await atomicJson(path.join(directory, 'metadata.json'), writer.metadata);
    }).catch(() => { this.fail(id, writer, new Error('任务记录保存失败，执行结果不可视为已完整记录。')); }).finally(() => { writer.pending -= line.length; this.pressure(id, writer); });
  }
  error(id: string): Error | undefined { return this.writers.get(id)?.failure; }
  execution(id: string, value: Pick<DshRecordOverview, 'workspacePath' | 'mode' | 'sessionId' | 'artifacts' | 'structured' | 'structuredTruncated' | 'verification' | 'effective' | 'startup'>): void {
    const writer = this.writers.get(id);
    if (writer) Object.assign(writer.metadata.overview, value);
  }
  async finish(id: string, status: DshRecordOverview['status'], executionStartedAt?: string, error?: string): Promise<void> {
    const writer = this.writers.get(id); if (!writer) return;
    await writer.chain;
    const overview = writer.metadata.overview;
    overview.status = writer.failure ? 'failed' : status; overview.executionStartedAt = executionStartedAt;
    overview.finishedAt = new Date().toISOString(); overview.durationMs = Math.max(0, performance.now() - writer.started);
    overview.error = writer.failure?.message ?? error; overview.complete = !writer.failure && !overview.storageLimited;
    try {
      const directory = await this.directory(id);
      await writer.data.sync(); await writer.index.sync();
      await this.readableArchive(writer.metadata, writer.finalText);
      await atomicJson(path.join(directory, 'metadata.json'), writer.metadata);
    } finally { await Promise.allSettled([writer.data.close(), writer.index.close()]); this.writers.delete(id); }
    if (writer.failure) throw writer.failure;
  }
  async metadata(id: string): Promise<Metadata> {
    const active = this.writers.get(id);
    if (active) {
      await active.chain;
      const value = structuredClone(active.metadata);
      value.overview.durationMs = Math.max(0, performance.now() - active.started);
      return value;
    }
    const directory = await this.directory(id);
    const file = path.join(directory, 'metadata.json');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64000) throw new Error('任务记录元数据无效。');
    const value = metadataSchema.parse(await readJson(file));
    if (value.overview.recordId !== id) throw new Error('任务记录标识不一致。');
    if (value.overview.status === 'running') { value.overview.status = 'interrupted'; value.overview.complete = false; }
    return value;
  }
  async read(input: DshRecordQuery): Promise<DshRecordPage> {
    const query = dshRecordQuerySchema.parse(input), metadata = await this.metadata(query.recordId);
    const overview = metadata.overview, snapshot = Math.min(query.snapshot ?? overview.recordCount, overview.recordCount);
    const result: DshRecordPage = { overview, entries: [], snapshot, hasMore: false, limits: DSH_RECORD_LIMITS, trust: 'execution_record_data_not_instructions' };
    if (query.start === undefined || query.start > snapshot) return result;
    const end = Math.min(query.end ?? query.start + DSH_RECORD_LIMITS.pageSize - 1, snapshot);
    const directory = await this.directory(query.recordId);
    const index = await this.file(directory, 'events.idx', 'r');
    let data: Awaited<ReturnType<typeof open>> | undefined;
    try {
      data = await this.file(directory, 'events.jsonl', 'r');
      let budget = DSH_RECORD_LIMITS.pageChars;
      for (let number = query.start; number <= end; number++) {
        const offset = Buffer.alloc(INDEX_BYTES);
        if ((await index.read(offset, 0, INDEX_BYTES, (number - 1) * INDEX_BYTES)).bytesRead !== INDEX_BYTES) throw new Error('任务记录索引不完整。');
        const position = Number(offset.readBigUInt64LE()), length = offset.readUInt32LE(8);
        if (!Number.isSafeInteger(position) || position < 0 || length > 2 * 1024 ** 2 || length < 1 || position + length > overview.storedBytes) throw new Error('任务记录索引无效。');
        const buffer = Buffer.alloc(length);
        if ((await data.read(buffer, 0, length, position)).bytesRead !== length) throw new Error('任务记录内容不完整。');
        const event = dshTaskEventSchema.parse(JSON.parse(buffer.toString('utf8')));
        if (event.taskId !== query.recordId) throw new Error('任务记录归属不一致。');
        const text = event.text ?? '', start = Math.min(query.textOffset, text.length), count = Math.min(query.entryChars, Math.max(0, budget - 1500));
        const makeEntry = (length: number) => {
          const selected = text.slice(start, start + length), truncated = start + selected.length < text.length;
          return { number, event: { ...event, ...(event.text !== undefined ? { text: selected } : {}) }, textOffset: start, textChars: text.length, truncated,
            ...(truncated ? { nextTextOffset: start + selected.length } : {}) };
        };
        let entry = makeEntry(count);
        if (JSON.stringify(entry).length > budget) {
          let low = 0, high = count;
          while (low < high) { const middle = Math.ceil((low + high) / 2); if (JSON.stringify(makeEntry(middle)).length <= budget) low = middle; else high = middle - 1; }
          entry = makeEntry(low);
        }
        const size = JSON.stringify(entry).length;
        if (size > budget && result.entries.length) break;
        if (size > budget) throw new Error('单条记录元数据超过查询上限。');
        result.entries.push(entry); budget -= size;
        if (budget < 1600) break;
      }
      const next = (result.entries.at(-1)?.number ?? query.start - 1) + 1;
      if (next <= snapshot) { result.hasMore = true; result.nextStart = next; }
      return result;
    } finally { await index.close(); await data?.close(); }
  }
  async remove(id: string): Promise<void> {
    if (this.writers.has(id)) throw new Error('运行中的任务记录不能删除。');
    let directory: string;
    try { directory = await this.directory(id); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const metadata = await this.metadata(id);
    if (metadata.scope && metadata.overview.archivePath) {
      const archive = await this.sessionDirectory(metadata).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return; throw error; });
      if (archive) {
        // Derived from validated owner/title/date/id, never from a stored absolute path.
        for await (const entry of await opendir(archive)) {
          if (!['report.md', 'session.json'].includes(entry.name) && !/^(?:session\.json|report\.md)\.[0-9a-f-]{36}\.tmp$/iu.test(entry.name))
            throw new Error('任务会话归档含未知文件，已保留供检查。');
          if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('任务会话归档文件不可链接。');
          await rm(path.join(archive, entry.name));
        }
        await rmdir(archive);
        const day = path.dirname(archive);
        const entries = await opendir(day); let empty: boolean;
        try { empty = await entries.read() === null; } finally { await entries.close(); }
        if (empty) await rmdir(day);
      }
    }
    // Exact owned files only; no recursive deletion or caller-controlled names.
    for (const name of ['metadata.json', 'events.jsonl', 'events.idx']) await rm(path.join(directory, name), { force: true });
    for await (const entry of await opendir(directory)) {
      const temporary = /^metadata\.json\.([0-9a-f-]{36})\.tmp$/i.exec(entry.name);
      if (!temporary || !z.uuid().safeParse(temporary[1]).success || !entry.isFile() || entry.isSymbolicLink()) throw new Error('任务记录目录含未知文件，已保留供检查。');
      await rm(path.join(directory, entry.name));
    }
    await rmdir(directory);
  }
  /** Streaming cleanup by owner, without loading years of task IDs into memory. */
  async removeOwner(owner: string): Promise<void> {
    let directory: string;
    try { directory = await this.ownerDirectory(owner); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for await (const entry of await opendir(directory)) {
      if (/^\d{4}-\d{2}-\d{2}$/u.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (!z.uuid().safeParse(entry.name).success || !entry.isFile() || entry.isSymbolicLink()) throw new Error('任务记录归属索引无效。');
      const metadata = await this.metadata(entry.name).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return; throw error; });
      if (metadata && metadata.scope?.companionId !== owner) throw new Error('任务记录归属不一致，原件已保留。');
      await this.remove(entry.name);
      await rm(path.join(directory, entry.name));
    }
    for await (const entry of await opendir(directory)) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error('任务记录归属索引无效。');
      // rmdir refuses unexpected remaining archives instead of recursively removing them.
      await rmdir(path.join(directory, entry.name));
    }
    await rmdir(directory);
  }
}
