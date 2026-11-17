import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BOT_PRESENCE_ARCHIVE_LIMIT, BOT_PRESENCE_MAX_CLIP_BYTES, type BotPresenceRecording } from '../../shared/companion-bot-media';

export interface PresenceRecording extends BotPresenceRecording {
  conversationId: string; bytes: Uint8Array; original?: Promise<string>; archivedAt?: number;
}
const byteLimit = 64 * 1024 * 1024;
const maxAge = 30 * 60_000;

export class PresenceArchive {
  private records: PresenceRecording[] = [];
  private cleanup?: ReturnType<typeof setTimeout>;
  private directoryReady?: Promise<void>;
  private readonly retired = new Map<string, { record: PresenceRecording; removing?: Promise<void> }>();
  constructor(private readonly directory?: string) {}

  async original(record: PresenceRecording, signal: AbortSignal) {
    const directory = this.directory;
    if (!directory || !this.records.includes(record)) throw Error('该陪伴素材已清理。');
    this.directoryReady ??= (async () => {
      await mkdir(directory, { recursive: true });
      const entries = await readdir(directory, { withFileTypes: true });
      await Promise.all(entries.filter(entry => entry.isFile() && /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.\d{3}Z_[\da-f-]{36}\.(?:webm|jpg)$/u.test(entry.name))
        .map(entry => rm(path.join(directory, entry.name), { force: true })));
    })().catch(error => { this.directoryReady = undefined; throw error; });
    record.original ??= this.directoryReady.then(async () => {
      const originalPath = path.join(directory, record.name);
      try { await writeFile(originalPath, record.bytes, { flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await rm(originalPath, { force: true });
        throw error;
      }
      return originalPath;
    }).catch(error => { record.original = undefined; throw error; });
    const originalPath = await record.original;
    signal.throwIfAborted();
    if (!this.records.includes(record)) throw Error('该陪伴录像已清理。');
    return originalPath;
  }

  private remove(id: string): Promise<void> {
    const task = this.retired.get(id);
    if (!task) return Promise.resolve();
    return task.removing ??= (async () => {
      const file = await task.record.original?.catch(() => undefined);
      if (file) await rm(file, { force: true });
      this.retired.delete(id);
    })().finally(() => { task.removing = undefined; });
  }

  private retire(records: PresenceRecording[]) {
    const ids = new Set(records.map(record => record.id));
    this.records = this.records.filter(record => !ids.has(record.id));
    for (const record of records) if (record.original) this.retired.set(record.id, { record });
  }

  canCapture() {
    const queue = this.records.filter(record => record.status !== 'archived');
    return queue.length < 118 && queue.reduce((size, record) => size + record.size, BOT_PRESENCE_MAX_CLIP_BYTES * 2) <= byteLimit;
  }

  add(conversationId: string, kind: PresenceRecording['kind'], bytes: Uint8Array, startedAt = Date.now(), at = startedAt) {
    const queue = this.records.filter(record => record.status !== 'archived');
    if (queue.length >= 120 || queue.reduce((size, record) => size + record.size, bytes.byteLength) > byteLimit)
      throw Error('待处理采集队列已满，已保留队列中的素材。');
    const id = randomUUID();
    const timestamp = new Date(at).toISOString().replace('T', '_').replaceAll(':', '-').slice(0, -1);
    const name = timestamp + 'Z_' + id + (kind === 'screen' ? '.jpg' : '.webm');
    const record: PresenceRecording = { id, conversationId, kind, bytes, size: bytes.byteLength, name, at, startedAt, status: 'pending' };
    this.records.push(record);
    return record;
  }

  claim(conversationId: string) {
    const batch = this.records.filter(record => record.conversationId === conversationId && record.status === 'pending')
      .sort((left, right) => left.startedAt - right.startedAt);
    for (const record of batch) record.status = 'processing';
    return batch;
  }

  finish(batch: readonly PresenceRecording[], success: boolean) {
    const now = Date.now();
    for (const record of batch) {
      if (record.status !== 'processing') continue;
      record.status = success ? 'archived' : 'pending';
      record.archivedAt = success ? now : undefined;
    }
    this.prune();
  }

  list(conversationId: string): BotPresenceRecording[] {
    this.prune();
    return this.records.filter(record => record.conversationId === conversationId).reverse().sort((left, right) => right.at - left.at)
      .map(({ id, name, at, startedAt, kind, size, status }) => ({ id, name, at, startedAt, kind, size, status }));
  }

  read(conversationId: string, id: string): Uint8Array {
    const record = this.records.find(item => item.conversationId === conversationId && item.id === id);
    if (!record) throw Error('这条观察记录已清理。');
    return record.bytes;
  }

  async clear(conversationId: string) {
    this.retire(this.records.filter(record => record.conversationId === conversationId && record.status === 'archived'));
    try {
      await Promise.all([...this.retired.values()].filter(task => task.record.conversationId === conversationId).map(task => this.remove(task.record.id)));
    } finally { this.prune(); }
  }

  close() {
    this.retire([...this.records]);
    this.prune();
  }

  private prune() {
    clearTimeout(this.cleanup);
    const now = Date.now(), archived = this.records.filter(record => record.status === 'archived')
      .sort((left, right) => left.archivedAt! - right.archivedAt!);
    let size = archived.reduce((total, record) => total + record.size, 0);
    const expired: PresenceRecording[] = [];
    while (archived.length && (archived.length > BOT_PRESENCE_ARCHIVE_LIMIT || size > byteLimit || archived[0]!.archivedAt! + maxAge <= now)) {
      const record = archived.shift()!;
      size -= record.size;
      expired.push(record);
    }
    this.retire(expired);
    for (const id of this.retired.keys()) void this.remove(id).catch(() => undefined);
    const expiresIn = archived.length ? Math.max(1, archived[0]!.archivedAt! + maxAge - now) : Infinity;
    const delay = this.retired.size ? Math.min(expiresIn, 30_000) : expiresIn;
    this.cleanup = Number.isFinite(delay) ? setTimeout(() => this.prune(), delay) : undefined;
    this.cleanup?.unref();
  }
}
