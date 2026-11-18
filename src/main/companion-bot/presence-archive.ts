import { randomUUID } from 'node:crypto';
import { mkdir, opendir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactCompanionDiagnostic } from '../../shared/companion-diagnostic';
import { BOT_PRESENCE_ARCHIVE_LIMIT, BOT_PRESENCE_MAX_CLIP_BYTES, BOT_PRESENCE_ROUND_DAYS, BOT_PRESENCE_ROUND_LIMIT, BOT_PRESENCE_ROUND_PAGE, type BotHeartbeatRound, type BotHeartbeatState, type BotPresenceRecording } from '../../shared/companion-bot-media';

export interface PresenceRecording extends BotPresenceRecording {
  conversationId: string; bytes: Uint8Array; original?: Promise<string>; archivedAt?: number;
}
const byteLimit = 64 * 1024 * 1024;
const maxAge = 30 * 60_000;
const pendingAge = 5 * 60_000;
const pendingLimit = 60;
const pendingVideoMs = 96_000;
const roundAge = BOT_PRESENCE_ROUND_DAYS * 24 * 60 * 60_000;

export class PresenceArchive {
  private roundSequence = 0;
  private readonly rounds = new Map<number, { conversationId: string; round: BotHeartbeatRound }>();
  private records: PresenceRecording[] = [];
  private cleanup?: ReturnType<typeof setTimeout>;
  private directoryReady?: Promise<void>;
  private readonly retired = new Map<string, { conversationId: string; size: number; file: Promise<string>; removing?: Promise<void> }>();
  constructor(private readonly directory?: string) {
    if (directory) void this.prepareDirectory(directory).catch(() => undefined);
  }

  beginRound(conversationId: string, at: number, waitMs: number) {
    const id = ++this.roundSequence;
    this.rounds.set(id, { conversationId, round: { id, at, waitMs, state: 'sealing', inputs: [] } });
    this.prune();
    return id;
  }

  updateRound(id: number, state: BotHeartbeatState, records?: readonly PresenceRecording[], error?: string) {
    const round = this.rounds.get(id)?.round;
    if (!round || round.finishedAt !== undefined) return;
    if (records) round.inputs = records.map(({ id, kind, name, startedAt, at }) => ({ id, kind, name, startedAt, at }));
    round.state = state;
    if (error) round.error = redactCompanionDiagnostic(error).slice(0, 2048);
    if (state !== 'preparing' && state !== 'observing' && state !== 'sealing') round.finishedAt = Date.now();
  }

  timeline(conversationId: string, before = Infinity) {
    const recordings = this.list(conversationId), rounds: BotHeartbeatRound[] = [];
    // Numeric cursors keep older pages stable as new heartbeats arrive.
    for (let id = Math.min(before - 1, this.roundSequence); id > 0 && this.roundSequence - id < BOT_PRESENCE_ROUND_LIMIT; id--) {
      const entry = this.rounds.get(id);
      if (entry?.conversationId === conversationId) {
        rounds.push(entry.round);
        if (rounds.length > BOT_PRESENCE_ROUND_PAGE) break;
      }
    }
    return { recordings, rounds: rounds.slice(0, BOT_PRESENCE_ROUND_PAGE), olderRounds: rounds.length > BOT_PRESENCE_ROUND_PAGE };
  }

  private prepareDirectory(directory: string) {
    return this.directoryReady ??= (async () => {
      await mkdir(directory, { recursive: true });
      for await (const entry of await opendir(directory)) {
        if (entry.isFile() && /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.\d{3}Z_[\da-f-]{36}\.(?:webm|jpg)$/u.test(entry.name))
          await rm(path.join(directory, entry.name), { force: true });
      }
    })().catch(error => { this.directoryReady = undefined; throw error; });
  }

  async original(record: PresenceRecording, signal: AbortSignal) {
    const directory = this.directory;
    if (!directory || !this.records.includes(record)) throw Error('该陪伴素材已清理。');
    record.original ??= this.prepareDirectory(directory).then(async () => {
      // Count in-flight writes and locked Windows files until unlink succeeds.
      signal.throwIfAborted();
      if (!this.records.includes(record)) throw Error('该陪伴素材已清理。');
      const allocated = this.records.reduce((n, item) => n + (item.original ? item.size : 0), this.retiredBytes());
      if (allocated > byteLimit) throw Error('旧观察文件正在释放，稍后重试。');
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
      const file = await task.file.catch(() => undefined);
      if (file) await rm(file, { force: true });
      this.retired.delete(id);
    })().finally(() => { task.removing = undefined; });
  }

  private retire(records: PresenceRecording[]) {
    const ids = new Set(records.map(record => record.id));
    this.records = this.records.filter(record => !ids.has(record.id));
    for (const record of records) if (record.original && !this.retired.has(record.id))
      this.retired.set(record.id, { conversationId: record.conversationId, size: record.size, file: record.original });
  }

  private retiredBytes() { return [...this.retired.values()].reduce((size, item) => size + item.size, 0); }

  canCapture() {
    return this.records.reduce((size, record) => size + (record.status === 'processing' ? record.size : 0), this.retiredBytes() + BOT_PRESENCE_MAX_CLIP_BYTES) <= byteLimit;
  }

  add(conversationId: string, kind: PresenceRecording['kind'], bytes: Uint8Array, startedAt = Date.now(), at = startedAt) {
    if (bytes.byteLength > BOT_PRESENCE_MAX_CLIP_BYTES || !this.canCapture()) throw Error('当前采集超过缓存上限。');
    const id = randomUUID();
    const timestamp = new Date(at).toISOString().replace('T', '_').replaceAll(':', '-').slice(0, -1);
    const name = timestamp + 'Z_' + id + (kind === 'screen' ? '.jpg' : '.webm');
    const record: PresenceRecording = { id, conversationId, kind, bytes, size: bytes.byteLength, name, at, startedAt, status: 'pending' };
    this.records.push(record);
    this.prune();
    return record;
  }

  claim(conversationId: string) {
    this.prune();
    const batch = this.records.filter(record => record.conversationId === conversationId && record.status === 'pending')
      .sort((left, right) => left.startedAt - right.startedAt);
    for (const record of batch) record.status = 'processing';
    return batch;
  }

  discardPending(conversationId: string) {
    this.retire(this.records.filter(record => record.conversationId === conversationId && record.status === 'pending'));
    this.prune();
  }

  finish(batch: readonly PresenceRecording[], success: boolean, obsolete = false) {
    if (obsolete) this.retire(batch.filter(record => record.status === 'processing'));
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
    for (const [id, entry] of this.rounds)
      if (entry.conversationId === conversationId && entry.round.finishedAt !== undefined) this.rounds.delete(id);
    this.retire(this.records.filter(record => record.conversationId === conversationId && record.status === 'archived'));
    try {
      await Promise.all([...this.retired].filter(([, task]) => task.conversationId === conversationId).map(([id]) => this.remove(id)));
    } finally { this.prune(); }
  }

  close() {
    this.rounds.clear();
    this.retire([...this.records]);
    this.prune();
  }

  private prune() {
    clearTimeout(this.cleanup);
    const now = Date.now(), archived = this.records.filter(record => record.status === 'archived')
      .sort((left, right) => left.archivedAt! - right.archivedAt!);
    let nextRoundExpiry = Infinity;
    for (const [id, { round }] of this.rounds) {
      if (round.at + roundAge > now && this.roundSequence - id < BOT_PRESENCE_ROUND_LIMIT) {
        nextRoundExpiry = round.at + roundAge;
        break;
      }
      this.rounds.delete(id);
    }
    const pending = this.records.filter(record => record.status === 'pending').sort((a, b) => a.at - b.at);
    let size = this.records.reduce((total, record) => total + record.size, 0);
    let videoMs = pending.reduce((total, record) => total + record.at - record.startedAt, 0);
    const expired: PresenceRecording[] = [];
    while (archived.length && (archived.length > BOT_PRESENCE_ARCHIVE_LIMIT || size > byteLimit || archived[0]!.archivedAt! + maxAge <= now)) {
      const record = archived.shift()!;
      size -= record.size;
      expired.push(record);
    }
    while (pending.length && (pending.length > pendingLimit || size > byteLimit || videoMs > pendingVideoMs || pending[0]!.at + pendingAge <= now)) {
      const record = pending.shift()!;
      size -= record.size;
      videoMs -= record.at - record.startedAt;
      expired.push(record);
    }
    this.retire(expired);
    for (const id of this.retired.keys()) void this.remove(id).catch(() => undefined);
    const expiresIn = Math.max(1, Math.min(nextRoundExpiry, (archived[0]?.archivedAt ?? Infinity) + maxAge, (pending[0]?.at ?? Infinity) + pendingAge) - now);
    const delay = this.retired.size ? Math.min(expiresIn, 30_000) : expiresIn;
    this.cleanup = Number.isFinite(delay) ? setTimeout(() => this.prune(), delay) : undefined;
    this.cleanup?.unref();
  }
}
