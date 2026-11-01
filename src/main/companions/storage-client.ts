import { randomUUID } from 'node:crypto';

import { utilityProcess, type UtilityProcess } from 'electron';
import { companionRecoveryResultSchema, type CompanionRecoveryResult } from '../../shared/companion-recovery';
import { CompanionValidationUnavailableError } from './validation-unavailable';
import type { CompanionStorageTiming } from '../../shared/companion-storage-timing';
import { companionStorageSchedulingContext, currentCompanionStorageOperationHash, type CompanionStorageOperationPriority } from './storage-operation-context';
import { CompanionStorageDispatchQueue, companionStorageDispatchPolicy, companionStorageSettlement } from './storage-dispatch-queue';

import {
  companionStorageCommandSchema, companionStorageReplySchema,
  type CompanionStorageCommand, type CompanionStorageResponse,
} from '../../shared/companion-storage';

interface Pending {
  resolve(value: CompanionStorageResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  commandType: CompanionStorageCommand['type'];
  startedAt: number;
  posted: boolean;
  queuedAt: number;
  priority: CompanionStorageOperationPriority;
  storageOperationHash?: string;
}
const REQUEST_TIMEOUT_MS = 30_000;
export class CompanionStorageNotDispatchedError extends CompanionValidationUnavailableError {
  readonly notDispatched = true;
}
export interface CompanionStorageChange {
  memoryInvalidatedCompanionIds?: string[];
  memoryInvalidatedScopeIds?: string[];
  memoryChangedCompanionIds?: string[];
  memorySourceChangedCompanionIds?: string[];
  memorySourcePublicationQueuedCompanionIds?: string[];
}
export interface CompanionStorageTimingEvent {
  commandType: CompanionStorageCommand['type'];
  roundTripMs: number;
  timing: CompanionStorageTiming;
  queueMs: number;
  priority: CompanionStorageOperationPriority;
  storageOperationHash?: string;
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
  #queue = new CompanionStorageDispatchQueue<CompanionStorageCommand>();
  #dispatchScheduled: ReturnType<typeof setImmediate> | undefined;
  #flightWaiters = new Set<() => void>();
  #closingPromise: Promise<void> | undefined;
  #retiringChild: UtilityProcess | undefined;
  #exitedChildren = new WeakSet<UtilityProcess>();
  #closedAck: (() => void) | undefined;
  #preparationScopes = new Set<symbol>();
  #preparationEpochMs = 0;
  #backgroundCreditMs = 0;
  #budgetUpdatedAt = 0;
  #budgetWake: ReturnType<typeof setTimeout> | undefined;
  #backgroundFlights = new Set<string>();

  constructor(private readonly workerPath: string, private readonly databasePath: string,
    private readonly onIndexChanged: (event?: CompanionStorageChange) => void = () => undefined, private readonly onIndexError: (error: Error) => void = () => undefined,
    private readonly initializationOptions?: { hostRetention?: { libraryPath: string; libraryId: string } },
    private readonly onTiming?: (event: CompanionStorageTimingEvent) => void) {}

  /** Product QoS only. Each recipient owns its own idempotent release; this
   * supplies no execution authority and never changes a command or timer. */
  acquireForegroundPreparation(): () => void {
    if (this.#closing) return () => undefined;
    if (!this.#preparationScopes.size) {
      this.#budgetUpdatedAt = performance.now();
      this.#preparationEpochMs = performance.timeOrigin + this.#budgetUpdatedAt;
      this.#backgroundCreditMs = 10;
    }
    const scope = Symbol(); this.#preparationScopes.add(scope);
    return () => {
      if (!this.#preparationScopes.delete(scope)) return;
      if (!this.#preparationScopes.size) {
        this.#backgroundCreditMs = 0;
        this.#clearBudgetWake(); this.#scheduleDispatch();
      }
    };
  }
  #refillBackgroundCredit(): void {
    const now = performance.now();
    if (this.#preparationScopes.size) this.#backgroundCreditMs = Math.min(25,
      this.#backgroundCreditMs + Math.max(0, now - this.#budgetUpdatedAt) * 0.1);
    this.#budgetUpdatedAt = now;
  }
  #chargeBackground(timing?: CompanionStorageTiming): void {
    if (!this.#preparationScopes.size) return;
    this.#refillBackgroundCredit();
    // Only the current preparation period matters; an idle interval never
    // carries old debt into a later recipient's independent preparation.
    const elapsed = timing ? Math.max(0, Math.min(timing.respondedEpochMs, performance.timeOrigin + this.#budgetUpdatedAt)
      - Math.max(timing.receivedEpochMs, this.#preparationEpochMs)) : 25;
    // Legacy replies have no measured cost: conservatively consume one bounded
    // quantum rather than charging their queued transport round trip as work.
    this.#backgroundCreditMs -= elapsed;
    this.#clearBudgetWake();
  }
  #clearBudgetWake(): void {
    if (this.#budgetWake) { clearTimeout(this.#budgetWake); this.#budgetWake = undefined; }
  }
  #wakeForBackgroundCredit(): void {
    if (this.#budgetWake || this.#closing || !this.#preparationScopes.size) return;
    this.#refillBackgroundCredit();
    const delay = Math.max(1, Math.ceil(-this.#backgroundCreditMs / 0.1));
    this.#budgetWake = setTimeout(() => { this.#budgetWake = undefined; this.#scheduleDispatch(); }, delay);
    this.#budgetWake.unref();
  }

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
    if (this.#closing) throw new CompanionValidationUnavailableError('伙伴存储正在关闭。');
    if (this.#retiringChild) throw new CompanionValidationUnavailableError('旧伙伴存储进程尚未确认退出，不能启动另一写入进程。');
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
        if (this.#child !== child || this.#exitedChildren.has(child)) return;
        error = new CompanionValidationUnavailableError(error.message, { cause: error });
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
        this.#ready = false;
        this.#rejectPending(error);
        this.#retiringChild = child;
        child.kill();
      };
      child.on('error', () => fail(new Error('伙伴存储进程异常。')));
      child.on('exit', (code) => {
        this.#exitedChildren.add(child);
        if (this.#retiringChild === child) this.#retiringChild = undefined;
        clearTimeout(timer);
        const error = new CompanionValidationUnavailableError(`伙伴存储进程已退出（${code}）。请重试。`);
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
              memorySourcePublicationQueuedCompanionIds: invalidatedIds('memorySourcePublicationQueuedCompanionIds' in message ? message.memorySourcePublicationQueuedCompanionIds : undefined),
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
        if (this.#backgroundFlights.delete(reply.data.requestId)) this.#chargeBackground(reply.data.timing);
        if (pending) {
          this.#pending.delete(reply.data.requestId); clearTimeout(pending.timer);
          if (reply.data.storageFailure?.kind === 'unavailable')
            pending.reject(new CompanionValidationUnavailableError(reply.data.response.error ?? '伙伴存储暂时无法核验。'));
          else pending.resolve(reply.data.response);
          if (reply.data.timing) {
            try { this.onTiming?.({ commandType: pending.commandType, roundTripMs: performance.now() - pending.startedAt,
              queueMs: pending.startedAt - pending.queuedAt, priority: pending.priority, timing: reply.data.timing,
              ...(pending.storageOperationHash ? { storageOperationHash: pending.storageOperationHash } : {}) }); }
            catch { /* Observation must not alter a settled storage result. */ }
          }
        }
        if (this.#queue.settle(reply.data.requestId)) {
          if (!this.#queue.inFlightCount) this.#notifyFlightSettled(); this.#scheduleDispatch();
        }
      });
    });
  }

  async request(input: CompanionStorageCommand): Promise<CompanionStorageResponse> {
    const command = companionStorageCommandSchema.parse(input);
    try { await this.start(); }
    catch (error) { throw new CompanionValidationUnavailableError('伙伴存储连接暂不可用。', { cause: error }); }
    if (!this.#child || !this.#ready || this.#closing) throw new CompanionValidationUnavailableError('伙伴存储不可用。');
    return new Promise<CompanionStorageResponse>((resolve, reject) => {
      const requestId = randomUUID();
      const context = companionStorageSchedulingContext();
      const timeoutMs=command.type.startsWith('recovery.')?30*60*1000:REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        const error = pending.posted
          ? new CompanionValidationUnavailableError(`伙伴存储请求 ${command.type} 等待超过 ${timeoutMs / 1000} 秒，执行状态尚未确认，请勿重复提交。`)
          : new CompanionStorageNotDispatchedError(`伙伴存储请求 ${command.type} 排队超过 ${timeoutMs / 1000} 秒，尚未派发、未执行。`);
        if (!pending.posted) { this.#queue.remove(requestId); this.#scheduleDispatch(); }
        reject(error);
        try { this.onIndexError(error); } catch { /* Diagnostics cannot prevent request settlement. */ }
      }, timeoutMs);
      timer.unref();
      const queuedAt = performance.now();
      const storageOperationHash = currentCompanionStorageOperationHash();
      this.#pending.set(requestId, { resolve, reject, timer, commandType: command.type, startedAt: queuedAt, queuedAt, priority: context.priority, posted: false,
        ...(storageOperationHash ? { storageOperationHash } : {}) });
      if (!this.#queue.enqueue({ id: requestId, lane: context.lane, priority: context.priority,
        policy: companionStorageDispatchPolicy(command, context), settlement: companionStorageSettlement(command), value: command })) {
        this.#pending.delete(requestId); clearTimeout(timer);
        reject(new CompanionStorageNotDispatchedError(`伙伴存储请求 ${command.type} 队列已满，尚未派发、未执行。`)); return;
      }
      this.#scheduleDispatch();
    });
  }

  #scheduleDispatch(): void {
    if (this.#dispatchScheduled || this.#closing || !this.#ready || !this.#queue.queuedCount || this.#queue.inFlightCount >= 2) return;
    this.#dispatchScheduled = setImmediate(() => {
      this.#dispatchScheduled = undefined;
      if (this.#closing || !this.#ready || !this.#child) return;
      this.#refillBackgroundCredit();
      const allowBackground = !this.#preparationScopes.size || this.#backgroundCreditMs >= 0;
      const next = this.#queue.take(allowBackground);
      if (!next) { if (!allowBackground) this.#wakeForBackgroundCredit(); return; }
      const pending = this.#pending.get(next.id);
      if (!pending) { this.#queue.settle(next.id); this.#scheduleDispatch(); return; }
      pending.posted = true; pending.startedAt = performance.now();
      if (pending.priority === 'background') this.#backgroundFlights.add(next.id);
      try { this.#child.postMessage({ requestId: next.id, command: next.value }); }
      catch (error) {
        this.#pending.delete(next.id); clearTimeout(pending.timer);
        pending.reject(new CompanionValidationUnavailableError('伙伴存储请求派发状态无法确认，请勿重复提交。', { cause: error }));
        // A throwing transport may already have handed the message to the
        // child. Keep the unknown flight until its real reply/exit/close.
      }
      this.#scheduleDispatch();
    });
  }
  #notifyFlightSettled(): void { for (const finish of this.#flightWaiters) finish(); this.#flightWaiters.clear(); }
  #waitForExit(child: UtilityProcess): Promise<void> {
    if (this.#exitedChildren.has(child)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const exited = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        child.removeListener('exit', exited);
        reject(new CompanionValidationUnavailableError('伙伴存储进程尚未确认退出，执行状态未知，不能重新打开或恢复资产库。'));
      }, 5_000);
      child.once('exit', exited);
    });
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(pending.posted ? error
      : new CompanionStorageNotDispatchedError('伙伴存储连接已关闭，请求尚未派发、未执行。', { cause: error })); }
    this.#pending.clear();
    this.#backgroundFlights.clear(); this.#clearBudgetWake();
    this.#queue.reset(); this.#notifyFlightSettled();
  }

  async close(): Promise<void> {
    if (this.#closingPromise) return this.#closingPromise;
    this.#closingPromise = this.#close(); return this.#closingPromise;
  }
  async #close(): Promise<void> {
    this.#closing = true;
    this.#clearBudgetWake(); this.#preparationScopes.clear(); this.#backgroundCreditMs = 0;
    if (this.#dispatchScheduled) { clearImmediate(this.#dispatchScheduled); this.#dispatchScheduled = undefined; }
    for (const queued of this.#queue.rejectQueued()) {
      const pending = this.#pending.get(queued.id); if (!pending) continue;
      this.#pending.delete(queued.id); clearTimeout(pending.timer);
      pending.reject(new CompanionStorageNotDispatchedError('伙伴存储正在关闭，请求尚未派发、未执行。'));
    }
    if (this.#starting) { try { await this.#starting; } catch { /* failed startup already closed the child */ } }
    const child = this.#child;
    if (!child) return;
    if (this.#retiringChild === child) { await this.#waitForExit(child); return; }
    let forced = false;
    if (this.#queue.inFlightCount) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.#flightWaiters.delete(finish); resolve(); };
      const timer = setTimeout(() => {
        // Shutdown cannot report an unknown SQL operation as safely committed.
        // Retire this worker after the bounded drain; normal recovery owns its
        // durable outcome, and the caller retains an unavailable/unknown error.
        forced = true; this.#retiringChild = child;
        this.#rejectPending(new CompanionValidationUnavailableError('伙伴存储关闭时已派发请求尚未确认，请保留原操作核对，不能重复提交。'));
        child.kill(); finish();
      }, REQUEST_TIMEOUT_MS);
      this.#flightWaiters.add(finish);
    });
    if (forced) { await this.#waitForExit(child); return; }
    this.#ready = false;
    if (this.#child !== child) return;
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true; clearTimeout(timer); this.#closedAck = undefined; resolve();
      };
      const timer = setTimeout(() => {
        this.#retiringChild = child; child.kill();
        void this.#waitForExit(child).then(finish, error => { this.#closedAck = undefined; reject(error); });
      }, 2_000);
      this.#closedAck = finish;
      try { child.postMessage({ type: 'storage.close' }); } catch {
        this.#retiringChild = child; child.kill();
        void this.#waitForExit(child).then(finish, error => { clearTimeout(timer); this.#closedAck = undefined; reject(error); });
      }
    });
    // The close ACK confirms the Store close request, not process retirement.
    // A replacement client/recovery worker may only start after actual exit.
    if (!this.#exitedChildren.has(child)) this.#retiringChild = child;
    await this.#waitForExit(child);
    if (this.#child === child) this.#child = undefined;
  }
}
