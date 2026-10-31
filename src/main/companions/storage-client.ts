import { randomUUID } from 'node:crypto';

import { utilityProcess, type UtilityProcess } from 'electron';
import { companionRecoveryResultSchema, type CompanionRecoveryResult } from '../../shared/companion-recovery';

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
    private readonly onIndexChanged: (event?: CompanionStorageChange) => void = () => undefined, private readonly onIndexError: (error: Error) => void = () => undefined,
    private readonly initializationOptions?: { hostRetention?: { libraryPath: string; libraryId: string } }) {}

  /** Main must stop all companion execution and close its normal worker first.
   * This child never constructs a Store or dispatches a model request. */
  static recoverDatabase(workerPath: string, selection: {libraryPath:string;libraryId:string}, input: {operationId:string;packagePath:string;expectedManifestHash:string}): Promise<CompanionRecoveryResult> {
    return CompanionStorageClient.offlineRecovery(workerPath,selection,input,false);
  }
  static inspectRecoveryPackage(workerPath:string,selection:{libraryPath:string;libraryId:string},packagePath:string):Promise<CompanionRecoveryResult>{
    return CompanionStorageClient.offlineRecovery(workerPath,selection,{packagePath},true);
  }
  private static offlineRecovery(workerPath:string,selection:{libraryPath:string;libraryId:string},input:{packagePath:string;operationId?:string;expectedManifestHash?:string},inspect:boolean):Promise<CompanionRecoveryResult>{
    const child = utilityProcess.fork(workerPath, [], {serviceName:'WorldlineBox Companion Recovery',stdio:'pipe'});
    child.stdout?.resume(); child.stderr?.resume();
    return new Promise((resolve,reject)=>{
      let settled=false;
      const end=(error?:Error,result?:CompanionRecoveryResult)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();if(error)reject(error);else resolve(result!);};
      const timer=setTimeout(()=>end(new Error('恢复执行状态尚未确认，请保留同一操作标识核对或继续，不能更换操作重试。')),30*60*1000);
      child.on('error',()=>end(new Error('恢复子进程异常。')));
      child.on('exit',()=>end(new Error('恢复子进程在确认结果前退出，请以同一操作核对。')));
      child.on('message',(value:unknown)=>{
        if(!value||typeof value!=='object'||!('type' in value))return;
        if(value.type==='storage.booted')child.postMessage(inspect?{type:'storage.recovery.inspect',selection,packagePath:input.packagePath}
          :{type:'storage.recover.initialize',selection,operationId:input.operationId,packagePath:input.packagePath,expectedManifestHash:input.expectedManifestHash});
        else if(value.type===(inspect?'storage.recovery-inspected':'storage.recovered')){
          const result=companionRecoveryResultSchema.safeParse('recovery' in value?value.recovery:undefined);
          if(!result.success||input.operationId&&result.data.operationId!==input.operationId||input.expectedManifestHash&&result.data.manifestHash!==input.expectedManifestHash||result.success&&(result.data.libraryId!==selection.libraryId||result.data.mode!==(inspect?'backup':'database')))end(new Error('恢复结果身份与审核的操作不一致。'));
          else end(undefined,result.data);
        }else if(value.type==='storage.recovery-failed')end(new Error('error' in value&&typeof value.error==='string'?value.error:'恢复失败。'));
      });
    });
  }

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
            child.postMessage({ type: 'storage.initialize', databasePath: this.databasePath, ...this.initializationOptions });
          } else if (message.type === 'storage.ready' && !settled) {
            settled = true; clearTimeout(timer); this.#ready = true; resolve();
          } else if (message.type === 'storage.failed') {
            fail(new Error('error' in message && typeof message.error === 'string' ? message.error : '伙伴存储无法启动。'));
          } else if (message.type === 'storage.closed') {
            this.#closedAck?.();
          } else if (message.type === 'storage.retire-changed') {
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
      const timeoutMs=command.type.startsWith('recovery.')?30*60*1000:REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        if (!this.#pending.delete(requestId)) return;
        const error = new Error(`伙伴存储请求 ${command.type} 等待超过 ${timeoutMs / 1000} 秒，执行状态尚未确认，请勿重复提交。`);
        reject(error);
        try { this.onIndexError(error); } catch { /* Diagnostics cannot prevent request settlement. */ }
      }, timeoutMs);
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
