import { randomUUID } from 'node:crypto';

import { utilityProcess, type UtilityProcess } from 'electron';

import {
  companionStorageCommandSchema, companionStorageReplySchema,
  type CompanionStorageCommand, type CompanionStorageResponse,
} from '../../shared/companion-storage';

interface Pending {
  resolve(value: CompanionStorageResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
const REQUEST_TIMEOUT_MS = 30_000;
export interface CompanionStorageChange {
  memoryInvalidatedCompanionIds?: string[];
  memoryInvalidatedScopeIds?: string[];
  memoryChangedCompanionIds?: string[];
  memorySourceChangedCompanionIds?: string[];
}
function invalidatedIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id)))];
}

/** Transport only. Main never imports better-sqlite3 or opens the message DB. */
export class CompanionStorageClient {
  #child: UtilityProcess | undefined;
  #starting: Promise<void> | undefined;
  #ready = false;
  #closing = false;
  #pending = new Map<string, Pending>();
  #closedAck: (() => void) | undefined;

  constructor(private readonly workerPath: string, private readonly databasePath: string,
    private readonly onIndexChanged: (event?: CompanionStorageChange) => void = () => undefined, private readonly onIndexError: (error: Error) => void = () => undefined) {}

  async start(): Promise<void> {
    if (this.#closing) throw new Error('伙伴存储正在关闭。');
    if (this.#ready) return;
    if (this.#starting) return this.#starting;
    const starting = this.#spawn();
    this.#starting = starting;
    try { await starting; } finally { if (this.#starting === starting) this.#starting = undefined; }
  }

  #spawn(): Promise<void> {
    const child = utilityProcess.fork(this.workerPath, [], { serviceName: 'WorldlineBox Companion Storage', stdio: 'pipe' });
    this.#child = child;
    child.stdout?.resume();
    child.stderr?.resume();
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail(new Error('伙伴存储启动超时。')), 15_000);
      const fail = (error: Error) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
        this.#ready = false;
        this.#rejectPending(error);
        if (this.#child === child) this.#child = undefined;
        child.kill();
      };
      child.on('error', () => fail(new Error('伙伴存储进程异常。')));
      child.on('exit', (code) => {
        clearTimeout(timer);
        const error = new Error(`伙伴存储进程已退出（${code}）。请重试。`);
        if (!settled) { settled = true; reject(error); }
        if (this.#child === child) {
          this.#child = undefined; this.#ready = false;
          this.#rejectPending(error);
          this.#closedAck?.();
        }
      });
      child.on('message', (message: unknown) => {
        if (typeof message !== 'object' || !message) return;
        if ('type' in message) {
          if (message.type === 'storage.booted') {
            child.postMessage({ type: 'storage.initialize', databasePath: this.databasePath });
          } else if (message.type === 'storage.ready' && !settled) {
            settled = true; clearTimeout(timer); this.#ready = true; resolve();
          } else if (message.type === 'storage.failed') {
            fail(new Error('error' in message && typeof message.error === 'string' ? message.error : '伙伴存储无法启动。'));
          } else if (message.type === 'storage.closed') {
            this.#closedAck?.();
          } else if (message.type === 'storage.reset-changed') {
            this.onIndexChanged({
              memoryInvalidatedCompanionIds: invalidatedIds('memoryInvalidatedCompanionIds' in message ? message.memoryInvalidatedCompanionIds : undefined),
              memoryInvalidatedScopeIds: invalidatedIds('memoryInvalidatedScopeIds' in message ? message.memoryInvalidatedScopeIds : undefined),
              memoryChangedCompanionIds: invalidatedIds('memoryChangedCompanionIds' in message ? message.memoryChangedCompanionIds : undefined),
              memorySourceChangedCompanionIds: invalidatedIds('memorySourceChangedCompanionIds' in message ? message.memorySourceChangedCompanionIds : undefined),
            });
          } else if (message.type === 'storage.index-changed') {
            this.onIndexChanged();
          } else if (message.type === 'storage.index-failed') {
            this.onIndexError(new Error('error' in message ? String(message.error) : '消息搜索索引更新失败。'));
          }
          return;
        }
        const reply = companionStorageReplySchema.safeParse(message);
        if (!reply.success) {
          fail(new Error('伙伴存储返回了无效响应。'));
          return;
        }
        const pending = this.#pending.get(reply.data.requestId);
        if (pending) { this.#pending.delete(reply.data.requestId); clearTimeout(pending.timer); pending.resolve(reply.data.response); }
      });
    });
  }

  async request(input: CompanionStorageCommand): Promise<CompanionStorageResponse> {
    const command = companionStorageCommandSchema.parse(input);
    await this.start();
    if (!this.#child || !this.#ready || this.#closing) throw new Error('伙伴存储不可用。');
    const child = this.#child;
    return new Promise<CompanionStorageResponse>((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        if (!this.#pending.delete(requestId)) return;
        const error = new Error(`伙伴存储请求 ${command.type} 等待超过 30 秒，执行状态尚未确认，请勿重复提交。`);
        reject(error);
        try { this.onIndexError(error); } catch { /* Diagnostics cannot prevent request settlement. */ }
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.#pending.set(requestId, { resolve, reject, timer });
      try { child.postMessage({ requestId, command }); } catch (error) {
        this.#pending.delete(requestId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('伙伴存储请求失败。'));
      }
    });
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }

  async close(): Promise<void> {
    this.#closing = true;
    if (this.#starting) { try { await this.#starting; } catch { /* failed startup already closed the child */ } }
    const child = this.#child;
    this.#ready = false;
    this.#rejectPending(new Error('伙伴存储已关闭。'));
    if (!child) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true; clearTimeout(timer); this.#closedAck = undefined; resolve();
      };
      const timer = setTimeout(() => { child.kill(); finish(); }, 2_000);
      this.#closedAck = finish;
      try { child.postMessage({ type: 'storage.close' }); } catch { child.kill(); finish(); }
    });
    if (this.#child === child) this.#child = undefined;
  }
}
