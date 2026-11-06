import { createHash } from 'node:crypto';
import path from 'node:path';
import { BotDshBrain, BotDshDeliveryUnknownError, type BotDshCallback, type BotDshHandoff, type BotDshModel, type BotDshResult } from './dsh-brain';
import { botLaneRetentionKey, type BotStore, type BotNativeAdmission } from './store';
import type { BotEvent } from './types';
import { BOT_ROUTER_TOOLS as BOT_TOOLS } from './tools';
import type { BotBrain } from './brain-router';
import { DEFAULT_MODEL_CONTEXT_CHARS } from '../../shared/model-budget';

export interface BotRetentionOptions {
  store: BotStore; brain: Pick<BotBrain, 'handoff'> & Partial<Pick<BotBrain, 'cancelDurable'>>; root: string;
  model(): BotDshModel; callback(): Promise<BotDshCallback>;
  maxTurns?: number; maxBytes?: number;
  beforeHandoff?(event: BotEvent, signal: AbortSignal): Promise<void>;
}
export interface BotRetainedTurn { epoch: number; nativeLaneId: string; handoff?: BotDshHandoff }
export interface BotTurnCompletion {
  event: BotEvent; system: string; cwd: string; inputBytes: number; outputBytes: number; nativeLaneId: string;
  inputContextCommitted?: boolean;
}
const nativeId = (laneId: string, epoch: number) => epoch === 1 ? laneId : `${laneId}-epoch-${epoch}`;
const stale = () => Object.assign(new Error('主脑通道在准备交接时已变化，拒绝把旧事件投递到新通道。'), { code: 'BOT_RETENTION_STALE' });
const positive = (input: number | undefined, fallback: number) => {
  const value = input ?? fallback; if (!Number.isSafeInteger(value) || value < 1) throw new Error('主脑保留上限必须是正整数。'); return value;
};

/** SQLite retains a bounded current handoff supplied by the active router runtime. */
export class BotRetention {
  private readonly maxTurns: number;
  private readonly maxBytes: number;
  private readonly reconciling = new Map<string, Promise<void>>();
  constructor(private readonly options: BotRetentionOptions) {
    this.maxTurns = positive(options.maxTurns, 128); this.maxBytes = positive(options.maxBytes, 512 * 1024);
  }
  async beforeTurn(event: BotEvent, signal: AbortSignal): Promise<BotRetainedTurn> {
    signal.throwIfAborted();
    const { store } = this.options;
    const current = store.getEvent(event.id);
    if (!current || current.status !== 'running' || current.laneId !== event.laneId) throw stale();
    // A process may die after the UI cancel fence but before the native stop.
    // Resolve those durable intents before this lane can admit another event.
    await this.reconcileCancelled(event.laneId, signal);
    let lane = store.getLane(event.laneId); if (!lane) throw new Error('主脑通道不存在。');
    const binding = store.getEventNativeEpoch(event.id);
    if (binding !== undefined && binding !== lane.epoch) throw stale();
    const state = store.getLaneRetention(event.laneId);
    // An admitted event, including an uncertain native delivery, must resume its original epoch.
    // The dshEventId branch conservatively supports pre-binding development events in epoch 1.
    if (binding === undefined && event.dshEventId && lane.epoch !== 1) throw stale();
    if (binding === undefined && !event.dshEventId && !state.handoff && (state.turns >= this.maxTurns || state.bytes >= this.maxBytes)) {
      if (!state.last || state.last.nativeLaneId !== nativeId(event.laneId, lane.epoch)) throw new Error('主脑交接缺少已完成原生事件。');
      await this.options.beforeHandoff?.(event, signal); signal.throwIfAborted();
      const handoff = await this.options.brain.handoff({ laneId: state.last.nativeLaneId, eventId: state.last.eventId,
        cwd: state.last.cwd, system: state.last.system, model: this.options.model(), tools: BOT_TOOLS,
        callback: await this.options.callback(), signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
      signal.throwIfAborted(); const checked = this.validateHandoff(handoff, state.last.nativeLaneId, state.last.eventId);
      if (!store.commitLaneHandoff(event.laneId, lane.epoch, checked)) throw stale();
      lane = store.getLane(event.laneId)!;
    }
    signal.throwIfAborted();
    store.bindEventNativeEpoch(event.id, lane.epoch);
    const bound = store.getLaneRetention(event.laneId);
    return { epoch: lane.epoch, nativeLaneId: nativeId(event.laneId, lane.epoch), handoff: bound.handoffEventId === event.id ? bound.handoff : undefined };
  }
  /** Background retirement and a new turn share one native proof operation.
   * Retry time is durable, so a quick unknown cannot form a hot request loop. */
  async reconcileCancelled(laneId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const { store } = this.options;
    let operation = this.reconciling.get(laneId);
    if (!operation) {
      if (!store.pendingCancelledNativeAdmissions(laneId).length) return;
      if (this.reconciling.size >= 2) throw new BotDshDeliveryUnknownError('原生退休核实并发已满。');
      if (!store.beginNativeRetirement(laneId)) throw new BotDshDeliveryUnknownError('主脑退休回执正在退避核实。');
      operation = (async () => {
        for (const admission of store.pendingCancelledNativeAdmissions(laneId)) {
          try {
            if (!this.options.brain.cancelDurable) throw new Error('主脑取消恢复接口不可用，当前通道等待核实。');
            const ack = await this.options.brain.cancelDurable({ laneId: admission.nativeLaneId, eventId: admission.eventId,
              cwd: admission.cwd, system: admission.system, model: this.options.model(), tools: BOT_TOOLS, callback: await this.options.callback(),
              signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
            if (ack.result) this.recordCancelledTerminal(admission, ack.result);
            else if (ack.absent === true) store.resolveCancelledNativeAdmission({ eventId: admission.eventId, epoch: admission.epoch, absent: true });
            else throw new Error('主脑取消结果未知，当前通道等待核实。');
          } catch (error) { throw new BotDshDeliveryUnknownError(error); }
        }
        if (store.pendingCancelledNativeAdmissions(laneId).length) throw new BotDshDeliveryUnknownError('主脑取消回执尚未提交，当前通道等待核实。');
      })();
      this.reconciling.set(laneId, operation);
      const clear = () => { if (this.reconciling.get(laneId) === operation) this.reconciling.delete(laneId); };
      void operation.then(clear, clear);
    }
    let abort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
    try { await Promise.race([operation, interrupted]); } finally { signal.removeEventListener('abort', abort); }
  }
  /** Pass directly into settle(). A rejected/duplicate lease never commits these counters. */
  trackAdmission(input: Omit<BotTurnCompletion, 'outputBytes'>): void {
    const epoch = this.options.store.getEventNativeEpoch(input.event.id);
    if (epoch === undefined || input.nativeLaneId !== nativeId(input.event.laneId, epoch)) throw stale();
    this.options.store.trackNativeAdmission({ eventId: input.event.id, epoch, nativeLaneId: input.nativeLaneId,
      system: input.system, cwd: input.cwd, inputBytes: input.inputBytes });
  }
  recordCancelledTerminal(input: BotNativeAdmission | Omit<BotTurnCompletion, 'outputBytes'>, result: BotDshResult): boolean {
    const { store } = this.options;
    const event = 'event' in input ? input.event : store.getEvent(input.eventId), epoch = 'epoch' in input ? input.epoch : store.getEventNativeEpoch(input.event.id);
    if (!event || epoch === undefined || result.eventId !== event.id || result.sessionId !== BotDshBrain.sessionId(input.nativeLaneId)) throw stale();
    // An App turn may be detached while its effects remain explicitly unknown.
    // Clear the admission barrier without counting a cancelled/committed turn
    // or choosing that unresolved turn as the next handoff boundary.
    if (result.quarantined === true) {
      if (result.status !== 'failed' || result.inputContextCommitted === true) throw stale();
      return store.resolveCancelledNativeAdmission({ eventId: event.id, epoch });
    }
    const lane = store.getLane(event.laneId);
    const metadata = lane?.epoch === epoch ? this.completionMetadata({ event, system: input.system, cwd: input.cwd,
      inputBytes: input.inputBytes, outputBytes: Buffer.byteLength(result.text), nativeLaneId: input.nativeLaneId,
      inputContextCommitted: result.inputContextCommitted === true })[0] : undefined;
    return store.resolveCancelledNativeAdmission({ eventId: event.id, epoch, metadata });
  }
  completionMetadata(input: BotTurnCompletion): Array<{ key: string; value: string }> {
    const { store } = this.options, epoch = store.getEventNativeEpoch(input.event.id), lane = store.getLane(input.event.laneId);
    if (!lane || epoch === undefined || epoch !== lane.epoch || input.nativeLaneId !== nativeId(lane.id, epoch)) throw stale();
    const state = store.getLaneRetention(lane.id);
    if (![input.inputBytes, input.outputBytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('主脑输入输出字节数无效。');
    const bytes = state.bytes + input.inputBytes + input.outputBytes;
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(state.turns + 1)) throw new Error('主脑保留计数超出范围。');
    if (!input.system || input.system.length > DEFAULT_MODEL_CONTEXT_CHARS || !path.isAbsolute(input.cwd)) throw new Error('主脑交接上下文无效。');
    const pendingHandoff = state.handoff && state.handoffEventId === input.event.id && input.inputContextCommitted === false ? state.handoff : undefined;
    return [{ key: botLaneRetentionKey(lane.id), value: JSON.stringify({ epoch, turns: state.turns + 1, bytes,
      last: { eventId: input.event.id, system: input.system, cwd: input.cwd, nativeLaneId: input.nativeLaneId },
      ...(pendingHandoff ? { handoff: pendingHandoff } : {}) }) },
    { key: `native-terminal-counted:${input.event.id}`, value: '1' }, { key: `native-admission:${input.event.id}`, value: '' }];
  }
  /** Retire admission only: an unknown effect cannot count or anchor handoff. */
  quarantineMetadata(input: Pick<BotTurnCompletion,'event'|'nativeLaneId'>): Array<{key:string;value:string}> {
    const {store}=this.options,epoch=store.getEventNativeEpoch(input.event.id),lane=store.getLane(input.event.laneId);
    if(!lane||epoch===undefined||epoch!==lane.epoch||input.nativeLaneId!==nativeId(lane.id,epoch))throw stale();
    return[{key:`native-terminal-counted:${input.event.id}`,value:'quarantined'},{key:`native-admission:${input.event.id}`,value:''}];
  }
  private validateHandoff(value: BotDshHandoff, laneId: string, eventId: string): BotDshHandoff {
    if (!value || value.format !== 'worldlinebox-bot-handoff-v1' || value.laneId !== laneId || value.throughEventId !== eventId
      || value.sessionId !== BotDshBrain.sessionId(laneId) || typeof value.summaryText !== 'string' || value.summaryText.length > 12 * 1024
      || !Array.isArray(value.tail) || JSON.stringify(value.tail).length > 8 * 1024 || !value.summaryText.trim() && !value.tail.length
      || !Number.isSafeInteger(value.nativeCursor) || value.nativeCursor < 0 || !Number.isSafeInteger(value.summarySeq) || value.summarySeq < 0
      || typeof value.compactionId !== 'string' || !Array.isArray(value.coveredEventSeqs)
      || !value.coveredEventSeqs.every(sequence => Number.isSafeInteger(sequence) && sequence >= 0)) throw new Error('DSH没有返回有效、有界且属于本通道的原生交接。');
    const checked: BotDshHandoff = { format: value.format, laneId, sessionId: value.sessionId, throughEventId: eventId,
      nativeCursor: value.nativeCursor, summaryText: value.summaryText, summarySeq: value.summarySeq, compactionId: value.compactionId,
      coveredEventSeqs: value.coveredEventSeqs, tail: value.tail };
    // Only this identity plus summary/tail is persisted. Extra native response fields cannot persist credentials.
    if (Buffer.byteLength(JSON.stringify(checked)) > DEFAULT_MODEL_CONTEXT_CHARS) throw new Error('DSH原生交接材料过大。');
    return checked;
  }
}

/** Stable event workdir is intentionally independent of active epoch/session identity. */
export function botLaneWorkdir(root: string, laneId: string): string {
  return path.join(root, 'lanes', createHash('sha256').update(laneId).digest('hex'));
}
