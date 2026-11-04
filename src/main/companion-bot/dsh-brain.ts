import { createHash } from 'node:crypto';
import type { AiApiFormat } from '../../shared/ai-endpoints';
import type { NativeHostClient, NativeHostEvent } from '../dsh/native-host-client';
import type { BotAnsweredQuestion, BotWorkerEffectInspection, BotQuestionAnswerInspection, BotNativeCallRef } from '../../shared/companion-bot-task';

export interface BotDshModel {
  apiFormat: AiApiFormat; model: string; baseUrl: string; apiKey: string;
  contextWindow?: number; maxTokens?: number; maxOutputTokens?: number;
  /** Capacity origin retained when resolved limits are passed into the App loop. */
  contextWindowSource?: 'explicit' | 'metadata' | 'official-default' | 'unknown';
}
export interface BotDshTool { name: string; description: string; parameters: object }
export interface BotDshCallback { url: string; token: string }
export interface BotDshRun {
  laneId: string; eventId: string; cwd: string; system: string; prompt: string;
  model: BotDshModel; tools: readonly BotDshTool[]; callback: BotDshCallback;
  role?: 'brain' | 'worker'; instanceId?: string; signal?: AbortSignal;
  /** Trusted launcher display metadata. Each worker retains its own cwd. */
  workspaceTitle?: string;
  workspaceParent?: { path: string; title: string };
  sessionTitle?: string;
  /** Explicit user continuation of this exact durable output checkpoint. */
  continueAfterSeq?: number;
  workerAccess?: 'scoped' | 'full';
  /** Extra controlled host tools augment the native worker catalog. */
  workerTools?: readonly BotDshTool[];
  answeredQuestions?: BotAnsweredQuestion[];
  onEvent?(event: NativeHostEvent): void;
}
export interface BotDshResult { text: string; sessionId: string; eventId: string; status: 'succeeded' | 'cancelled' | 'failed'; error?: string; inputContextCommitted?: boolean; outputCheckpoint?: number }
export interface BotDshCancelAck { accepted: boolean; result?: BotDshResult; absent?: boolean; paused?: boolean; sessionId?: string; eventId?: string; requiresAttachment?: boolean }
export interface BotDshAccessInput { laneId: string; eventId: string; cwd: string; system: string; instanceId?: string; signal?: AbortSignal }
export interface BotDshAccessAck { absent?: true; previousAccess?: 'scoped' | 'full'; workerAccess?: 'full'; sessionId: string; sameSessionId?: string; eventId: string }
export class BotDshPauseAcknowledgedError extends Error {
  readonly code = 'BOT_PAUSE_ACKNOWLEDGED';
  constructor() { super('Native worker pause is durably confirmed; its original event and Session are retained.'); }
}
export class BotDshAbortAcknowledgedError extends Error {
  readonly code = 'BOT_ABORT_ACKNOWLEDGED';
  constructor(readonly result: BotDshResult) { super('Native event cancellation reconciled with a durable terminal receipt.'); }
}
export interface BotDshHost { client: NativeHostClient; instance?: { id: string }; runtime?: { id: string; version: string } }
export interface BotDshBrainOptions { getHost(instanceId?: string, signal?: AbortSignal, nativeLaneId?: string): Promise<BotDshHost> }
export interface BotDshHandoff {
  format: 'worldlinebox-bot-handoff-v1'; laneId: string; sessionId: string; throughEventId: string; nativeCursor: number;
  summaryText: string; summarySeq: number; compactionId: string; coveredEventSeqs: number[];
  tail: Array<{ id: string; role: string; content: unknown[]; source: Record<string, unknown> }>;
}
export class BotDshDeliveryUnknownError extends Error {
  readonly code = 'BOT_DELIVERY_UNKNOWN';
  constructor(error: unknown, readonly stage: 'host' | 'attach' | 'turn' | 'stream' | 'cancel' | 'unknown' = 'unknown') {
    super(`Native event delivery or stream outcome is unknown (${stage}): ` + (error instanceof Error ? error.message : String(error)), { cause: error });
  }
}
export class BotDshTurnFailedError extends Error {
  readonly code = 'BOT_TERMINAL_FAILED';
  constructor(readonly eventId: string, message: string, readonly partialText?: string, readonly inputContextCommitted?: boolean) { super(message); }
}
export class BotDshOutputLimitError extends Error {
  readonly code = 'BOT_OUTPUT_LIMIT';
  constructor(readonly eventId: string, readonly sessionId: string, readonly checkpoint: number, readonly partialText: string, readonly inputContextCommitted?: boolean) {
    super('执行器连续输出尚未完成，进展已保存；可以在原任务上继续。');
  }
}
export class BotDshLaneBusyError extends Error {
  readonly code = 'BOT_LANE_BUSY';
  constructor(message = 'This companion lane already has an active turn or maintenance operation.') { super(message); }
}
export class BotDshEffectUnknownError extends Error {
  readonly code = 'BOT_EFFECT_UNKNOWN';
  constructor(readonly callId?: string, message = 'A worker effect requires explicit reconciliation before continuing.') { super(message); }
}

/** DSH owns inference, tool dispatch, native history and compaction. This
 * adapter only submits durable, idempotent lane events and observes output. */
export class BotDshBrain {
  private readonly active = new Map<string, { client: NativeHostClient; eventId: string; finished: Promise<void>; stopStream(reason: Error): void }>();
  private readonly pendingStops = new Map<string, Promise<BotDshCancelAck>>();
  private readonly openingLanes = new Set<string>();
  constructor(private readonly options: BotDshBrainOptions) {}
  static sessionId(laneId: string): string { return 'wlb-bot-' + createHash('sha256').update(laneId).digest('hex'); }

  async run(input: BotDshRun): Promise<BotDshResult> {
    input.signal?.throwIfAborted();
    if (input.model.apiFormat !== 'openai_chat') throw new Error('伙伴主脑目前需要 OpenAI Chat Completions 协议，请在模型设置中选择兼容端点。');
    const sessionId = BotDshBrain.sessionId(input.laneId);
    const stopping = this.pendingStops.get(sessionId);
    if (stopping) {
      try { await stopping; } catch (error) { throw new BotDshDeliveryUnknownError(error, 'cancel'); }
      await this.active.get(sessionId)?.finished;
    }
    input.signal?.throwIfAborted();
    if (this.active.has(sessionId) || this.openingLanes.has(sessionId)) throw new BotDshLaneBusyError();
    this.openingLanes.add(sessionId);
    let client: NativeHostClient, created: { sessionId: string; cursor: number }, attachmentStage: 'host' | 'attach' = 'host';
    try {
      client = (await this.options.getHost(input.instanceId, input.signal, input.laneId)).client;
      attachmentStage = 'attach';
      created = await client.request('/bot/lanes', {
        sessionId, laneId: input.laneId, eventId: input.eventId, cwd: input.cwd, system: input.system,
        model: input.model, tools: input.tools, callback: input.callback, role: input.role ?? 'brain', workerAccess: input.workerAccess ?? 'scoped',
        workerTools: input.workerTools,
        workspaceTitle: input.workspaceTitle, workspaceParent: input.workspaceParent, sessionTitle: input.sessionTitle,
        answeredQuestions: input.answeredQuestions,
      }, input.signal);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'BOT_HOST_MIGRATION_BLOCKED') throw error;
      if (/active turn|active maintenance admission|capacity is occupied|lane is busy/.test(error instanceof Error ? error.message : '')) throw new BotDshLaneBusyError(error instanceof Error ? error.message : undefined);
      if (input.signal?.aborted) throw error;
      // Attaching may resume a previously admitted native inbox. Losing this
      // response does not prove that the original event failed or stayed idle.
      throw new BotDshDeliveryUnknownError(error, attachmentStage);
    } finally { this.openingLanes.delete(sessionId); }
    if (created.sessionId !== sessionId) throw new Error('Native DSH lane identity changed.');
    let finished!: () => void;
    const streamAbort = new AbortController();
    this.active.set(sessionId, { client, eventId: input.eventId, finished: new Promise<void>(resolve => { finished = resolve; }), stopStream: reason => streamAbort.abort(reason) });
    let stopRequested: Promise<BotDshCancelAck> | undefined;
    const abort = () => {
      const reason = input.signal?.reason;
      const suspend = !!reason && typeof reason === 'object' && 'code' in reason && reason.code === 'BOT_SUSPEND';
      const stopping = client.request<BotDshCancelAck>(`/bot/lanes/${sessionId}/cancel`, { eventId: input.eventId, suspend });
      stopRequested = stopping;
      this.pendingStops.set(sessionId, stopping);
      void stopping.then(() => { if (this.pendingStops.get(sessionId) === stopping) this.pendingStops.delete(sessionId); }, () => undefined);
      streamAbort.abort(reason);
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    let terminal = false, deliveryStage: 'turn' | 'stream' = 'turn';
    try {
      const admitted = await client.request<{ accepted: boolean; result?: BotDshResult }>(`/bot/lanes/${sessionId}/turn`, {
        eventId: input.eventId, prompt: input.prompt, continueAfterSeq: input.continueAfterSeq,
      }, input.signal);
      if (admitted.result) {
        terminal = true;
        if (input.signal?.aborted) throw new BotDshAbortAcknowledgedError(admitted.result);
        if (admitted.result.status === 'failed') {
          if (Number.isSafeInteger(admitted.result.outputCheckpoint) && admitted.result.outputCheckpoint! >= 0) throw new BotDshOutputLimitError(input.eventId, sessionId, admitted.result.outputCheckpoint!, admitted.result.text, admitted.result.inputContextCommitted);
          throw new BotDshTurnFailedError(input.eventId, admitted.result.error || 'Native companion turn previously failed.', admitted.result.text, admitted.result.inputContextCommitted);
        }
        return admitted.result;
      }
      if (!admitted.accepted) throw new Error('Native DSH did not accept the companion event.');
      deliveryStage = 'stream';
      let lastError = '';
      for await (const event of client.events(sessionId, created.cursor, streamAbort.signal)) {
        // Each record is tied to one admitted event; delayed output from the
        // previous turn must never settle a new reply.
        const binding = event as NativeHostEvent & { eventId?: string };
        if (binding.eventId !== input.eventId) continue;
        if (event.type === 'error') lastError = event.error || event.text || 'Native companion request failed.';
        input.onEvent?.(event);
        if (event.type === 'delivery_unknown') throw new BotDshDeliveryUnknownError(event.error || event.summary);
        if (event.type === 'effect_unknown') throw new BotDshEffectUnknownError(event.callId, event.summary);
        if (event.type === 'complete') {
          terminal = true;
          const status = event.status ?? 'failed';
          const committed = (event as NativeHostEvent & { inputContextCommitted?: boolean }).inputContextCommitted;
          const result = { text: event.text ?? '', sessionId, eventId: input.eventId, status,
            ...(typeof committed === 'boolean' ? { inputContextCommitted: committed } : {}) };
          if (input.signal?.aborted) throw new BotDshAbortAcknowledgedError(result);
          if (status === 'failed') {
            const checkpoint = (event as NativeHostEvent & { outputCheckpoint?: number }).outputCheckpoint;
            if (Number.isSafeInteger(checkpoint) && checkpoint! >= 0) throw new BotDshOutputLimitError(input.eventId, sessionId, checkpoint!, event.text ?? '', committed);
            throw new BotDshTurnFailedError(input.eventId, event.error || lastError || event.text || JSON.stringify(event.reason) || 'Native companion turn failed.', event.text, committed);
          }
          return result;
        }
      }
      throw new Error('Native companion event stream closed before completion.');
    } catch (error) {
      if (input.signal?.aborted) {
        const stop = stopRequested;
        if (stop) {
          let ack: BotDshCancelAck;
          try { ack = await stop; } catch (failure) { throw new BotDshDeliveryUnknownError(failure, 'cancel'); }
          if (ack.result) throw new BotDshAbortAcknowledgedError(ack.result);
          if (ack.accepted === true && ack.paused === true && ack.sessionId === sessionId && ack.eventId === input.eventId) throw new BotDshPauseAcknowledgedError();
        }
        throw error;
      }
      if (terminal || error instanceof BotDshEffectUnknownError || error instanceof BotDshDeliveryUnknownError) throw error;
      if (error && typeof error === 'object' && 'code' in error && error.code === 'BOT_SUSPEND') throw error;
      if (/active turn|active maintenance admission|capacity is occupied|lane is busy/.test(error instanceof Error ? error.message : '')) throw new BotDshLaneBusyError(error instanceof Error ? error.message : undefined);
      throw new BotDshDeliveryUnknownError(error, deliveryStage);
    } finally {
      input.signal?.removeEventListener('abort', abort); streamAbort.abort(); this.active.delete(sessionId); finished();
    }
  }

  async cancel(laneId: string): Promise<void> {
    const sessionId = BotDshBrain.sessionId(laneId), active = this.active.get(sessionId);
    if (active) await active.client.request(`/bot/lanes/${sessionId}/cancel`, { eventId: active.eventId });
  }
  async cancelDurable(input: Omit<BotDshRun, 'prompt' | 'onEvent'>, suspend = false): Promise<BotDshCancelAck> {
    const sessionId = BotDshBrain.sessionId(input.laneId);
    let client: NativeHostClient;
    try { ({ client } = await this.options.getHost(input.instanceId, input.signal, input.laneId)); }
    catch (error) {
      if (input.signal?.aborted || error && typeof error === 'object' && 'code' in error && error.code === 'BOT_HOST_MIGRATION_BLOCKED') throw error;
      // Host unavailability is not proof that the admitted worker stopped.
      throw new BotDshDeliveryUnknownError(error, 'host');
    }
    const previous = this.pendingStops.get(sessionId); if (previous) await previous.catch(() => undefined);
    if (!suspend) try {
      const proof = await client.request<BotDshCancelAck>('/bot/cancel', { sessionId, laneId: input.laneId, eventId: input.eventId, cwd: input.cwd, role: input.role ?? 'brain' }, input.signal);
      if (proof.absent === true) {
        if (proof.sessionId !== sessionId || proof.eventId !== input.eventId) throw new Error('Native absence proof identity changed.');
        if (this.pendingStops.get(sessionId) === previous) this.pendingStops.delete(sessionId);
        return proof;
      }
      if (proof.requiresAttachment !== true) throw new Error('Native cancellation inspection did not prove absence or request reconciliation.');
    } catch (error) {
      if (input.signal?.aborted) throw error;
      // Only an older bridge's explicit missing route uses the compatibility
      // path. Network/inspection errors never become an absence assertion.
      if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw new BotDshDeliveryUnknownError(error, 'cancel');
    }
    try { await client.request('/bot/lanes', { sessionId, laneId: input.laneId, eventId: input.eventId, cwd: input.cwd, system: input.system,
      model: input.model, tools: input.tools, callback: input.callback, role: input.role ?? 'brain',
      workerAccess: input.workerAccess ?? 'scoped', workerTools: input.workerTools, workspaceTitle: input.workspaceTitle,
      workspaceParent: input.workspaceParent, sessionTitle: input.sessionTitle, cancelIntent: true, suspendIntent: suspend }, input.signal); }
    catch (error) { if (input.signal?.aborted) throw error; throw new BotDshDeliveryUnknownError(error, 'attach'); }
    const stopping = client.request<BotDshCancelAck>(`/bot/lanes/${sessionId}/cancel`, { eventId: input.eventId, ...(suspend ? { suspend: true } : {}) }, input.signal);
    this.pendingStops.set(sessionId, stopping);
    try {
      const ack = await stopping;
      if (ack.result && (ack.result.eventId !== input.eventId || ack.result.sessionId !== sessionId)) throw new Error('Native cancellation receipt identity changed.');
      if (suspend && ack.paused === true && (ack.accepted !== true || ack.sessionId !== sessionId || ack.eventId !== input.eventId)) throw new BotDshDeliveryUnknownError('Native pause receipt identity changed.');
      if (!ack.result && ack.absent !== true && !(suspend && ack.accepted === true && ack.paused === true)) throw new BotDshDeliveryUnknownError('Native control did not prove a terminal, absent or durably paused event.');
      return ack;
    } catch (error) {
      if (input.signal?.aborted || error instanceof BotDshDeliveryUnknownError) throw error;
      throw new BotDshDeliveryUnknownError(error, 'cancel');
    } finally { if (this.pendingStops.get(sessionId) === stopping) this.pendingStops.delete(sessionId); }
  }
  async send(laneId: string, input: { messageId: string; text: string; mode: 'steer' | 'queue' }): Promise<void> {
    const sessionId = BotDshBrain.sessionId(laneId), active = this.active.get(sessionId);
    if (!active) throw new Error('The native task is not attached or running.');
    await active.client.request(`/bot/lanes/${sessionId}/input`, { ...input, eventId: active.eventId });
  }
  /** Monotonic permission change only: no Agent restore, inbox delivery or turn. */
  async upgradeWorkerAccess(input: BotDshAccessInput): Promise<BotDshAccessAck> {
    const sessionId = BotDshBrain.sessionId(input.laneId);
    try {
      const { client } = await this.options.getHost(input.instanceId, input.signal, input.laneId);
      const result = await client.request<BotDshAccessAck>(`/bot/lanes/${sessionId}/access`,
        { laneId: input.laneId, eventId: input.eventId, cwd: input.cwd, system: input.system, role: 'worker', workerAccess: 'full' }, input.signal);
      if (result.sessionId !== sessionId || result.eventId !== input.eventId || result.absent !== true && (result.workerAccess !== 'full' || result.sameSessionId !== sessionId)) throw new BotDshDeliveryUnknownError('Native worker access upgrade was not confirmed.', 'attach');
      return result;
    } catch (error) {
      if (input.signal?.aborted || error instanceof BotDshDeliveryUnknownError || error && typeof error === 'object' && 'code' in error && error.code === 'BOT_HOST_MIGRATION_BLOCKED') throw error;
      throw new BotDshDeliveryUnknownError(error, 'attach');
    }
  }
  /** Native read-only persistence handle: no Agent restore and no synthetic
   * interrupted-turn closers from the balanced SessionQuery projection. */
  async inspectEffects(input: { laneId: string; eventId: string; callIds?: string[]; effects?: Array<BotNativeCallRef & { callId: string }>; instanceId?: string; signal?: AbortSignal }): Promise<BotWorkerEffectInspection[]> {
    const { client } = await this.options.getHost(input.instanceId, input.signal, input.laneId);
    return client.request('/bot/effects/inspect', { sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, callIds: input.callIds, effects: input.effects }, input.signal);
  }
  async inspectQuestionAnswers(input: { laneId: string; eventId: string; questions: Array<BotNativeCallRef & { questionId: string; callId: string; answersHash: string }>; afterOffset?: number; afterOffsets?: Record<string, number>; instanceId?: string; signal?: AbortSignal }): Promise<BotQuestionAnswerInspection[]> {
    const { client } = await this.options.getHost(input.instanceId, input.signal, input.laneId);
    return client.request('/bot/questions/inspect', { sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, questions: input.questions, afterOffset: input.afterOffset, afterOffsets: input.afterOffsets }, input.signal);
  }
  async handoff(input: Omit<BotDshRun, 'prompt' | 'onEvent'>): Promise<BotDshHandoff> {
    const sessionId = BotDshBrain.sessionId(input.laneId);
    if (this.active.has(sessionId) || this.openingLanes.has(sessionId)) throw new Error('Handoff requires a completed native lane.');
    const { client } = await this.options.getHost(input.instanceId, input.signal, input.laneId);
    await client.request('/bot/lanes', { ...input, sessionId, role: input.role ?? 'brain', workerAccess: input.workerAccess ?? 'scoped' }, input.signal);
    return client.request<BotDshHandoff>(`/bot/lanes/${sessionId}/handoff`, { eventId: input.eventId }, input.signal, 120000);
  }
  /** Release a completed encoder/worker from RAM while retaining its native
   * log and durable receipts. Never cancels an active task. */
  async archive(laneId: string, instanceId?: string): Promise<void> {
    const sessionId = BotDshBrain.sessionId(laneId);
    if (this.active.has(sessionId) || this.openingLanes.has(sessionId)) throw new Error('Archive requires a completed native lane.');
    const { client } = await this.options.getHost(instanceId, undefined, laneId);
    await client.request(`/bot/lanes/${sessionId}/archive`, {});
  }
  async close(): Promise<void> {
    // Shutdown preserves Inbox/cancel intents for reconciliation. A failed
    // transport stop cannot prevent memory/store/Host cleanup from running.
    await Promise.allSettled([...this.active.entries()].map(async ([sessionId, active]) => {
      try { await active.client.request(`/bot/lanes/${sessionId}/cancel`, { eventId: active.eventId, suspend: true }); }
      finally { active.stopStream(Object.assign(new Error('The native companion adapter stopped; the durable event remains resumable.'), { code: 'BOT_SUSPEND' })); }
    }));
    await Promise.allSettled([...this.pendingStops.values()]);
  }
}
