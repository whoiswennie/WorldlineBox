import { createHash } from 'node:crypto';
import type { AiApiFormat } from '../../shared/ai-endpoints';
import type { NativeHostClient, NativeHostEvent } from '../dsh/native-host-client';
import { DshHostUnavailableError, isDshHostUnavailableError } from '../dsh/host-errors';

export interface BotDshModel {
  apiFormat: AiApiFormat; model: string; baseUrl: string; apiKey: string;
  contextWindow?: number; maxTokens?: number; maxOutputTokens?: number;
  /** Verified/explicit capability. Unknown compatible routes may attempt native
   * images and surface the actual provider rejection without inventing support. */
  imageSupport?: 'supported' | 'unsupported' | 'unknown';
  inputModalities?: readonly ('text' | 'image')[];
  /** Capacity origin retained when resolved limits are passed into the App loop. */
  contextWindowSource?: 'explicit' | 'metadata' | 'official-default' | 'unknown';
}
export interface BotDshTool { name: string; description: string; parameters: object }
export interface BotDshCallback { url: string; token: string }
export interface BotDshAudience { conversationId: string; kind: 'direct' | 'group' | 'peer' | 'world'; allowedConversationIds: string[] }
export interface BotDshRun {
  audience?: BotDshAudience;
  laneId: string; eventId: string; cwd: string; system: string; prompt: string;
  model: BotDshModel; tools: readonly BotDshTool[]; callback: BotDshCallback;
  role?: 'brain' | 'worker'; instanceId?: string; signal?: AbortSignal;
  /** A user explicitly resumed this task after stopping its execution Host. */
  resumeHost?: boolean;
  /** Trusted launcher display metadata. Each worker retains its own cwd. */
  workspaceTitle?: string;
  workspaceParent?: { path: string; title: string };
  sessionTitle?: string;
  /** Explicit user continuation of this exact durable output checkpoint. */
  continueAfterSeq?: number;
  /** Host-bound follow-up opens a new execution segment of the same task.
   * Its stable ID makes a retry distinct from replaying the original prompt. */
  taskContinuation?: { id: string; text: string };
  workerAccess?: 'scoped' | 'full';
  /** Extra controlled host tools augment the native worker catalog. */
  workerTools?: readonly BotDshTool[];
  onEvent?(event: NativeHostEvent): void;
}
export interface BotDshResult { artifacts?: Array<{ path: string; description?: string }>; text: string; sessionId: string; eventId: string; status: 'succeeded' | 'cancelled' | 'failed'; error?: string; inputContextCommitted?: boolean; outputCheckpoint?: number; quarantined?: true }
export interface BotDshCancelAck { accepted: boolean; result?: BotDshResult; absent?: boolean; paused?: boolean; sessionId?: string; eventId?: string; requiresAttachment?: boolean }
export class BotDshPauseAcknowledgedError extends Error {
  readonly code = 'BOT_PAUSE_ACKNOWLEDGED';
  constructor() { super('Native worker pause is durably confirmed; its original event and Session are retained.'); }
}
export class BotDshAbortAcknowledgedError extends Error {
  readonly code = 'BOT_ABORT_ACKNOWLEDGED';
  constructor(readonly result: BotDshResult) { super('Native event cancellation reconciled with a durable terminal receipt.'); }
}
export interface BotDshHost { client: NativeHostClient; instance?: { id: string }; runtime?: { id: string; version: string } }
export interface BotDshBrainOptions {
  getHost(instanceId?: string, signal?: AbortSignal, nativeLaneId?: string, options?: { explicit?: boolean }): Promise<BotDshHost>;
  acquireLease?(host: BotDshHost): () => void;
}
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
  constructor(readonly eventId: string, message: string, readonly partialText?: string, readonly inputContextCommitted?: boolean, readonly quarantined?: true) { super(message); }
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

type CancelInput = Omit<BotDshRun, 'prompt' | 'onEvent' | 'signal' | 'resumeHost'>;
interface PendingStop { promise: Promise<BotDshCancelAck>; input: CancelInput; suspend: boolean }
const cancellationInput = (input: Omit<BotDshRun, 'prompt' | 'onEvent'>): CancelInput => ({
  laneId: input.laneId, eventId: input.eventId, cwd: input.cwd, system: input.system, model: input.model, audience: input.audience,
  tools: input.tools, callback: input.callback, role: input.role, instanceId: input.instanceId,
  workerAccess: input.workerAccess, workerTools: input.workerTools, workspaceTitle: input.workspaceTitle,
  workspaceParent: input.workspaceParent, sessionTitle: input.sessionTitle,
});

/** DSH owns inference, tool dispatch, native history and compaction. This
 * adapter only submits durable, idempotent lane events and observes output. */
export class BotDshBrain {
  private readonly active = new Map<string, { client: NativeHostClient; eventId: string; finished: Promise<void>; acquireUse(): () => void; stopStream(reason: Error): void }>();
  private readonly pendingStops = new Map<string, PendingStop>();
  private readonly openingLanes = new Set<string>();
  constructor(private readonly options: BotDshBrainOptions) {}
  private async getHost(instanceId: string | undefined, signal: AbortSignal | undefined, laneId: string, options?: { explicit?: boolean }): Promise<BotDshHost> {
    try { return await this.options.getHost(instanceId, signal, laneId, options); }
    catch (error) {
      if (signal?.aborted || isDshHostUnavailableError(error) || error && typeof error === 'object' && 'code' in error && error.code === 'BOT_HOST_MIGRATION_BLOCKED') throw error;
      throw new DshHostUnavailableError('startup', 'DSH 执行器暂时无法连接，请检查实例后继续原任务。', instanceId, error);
    }
  }
  private stopReceipt(ack: BotDshCancelAck, sessionId: string, eventId: string, suspend: boolean): BotDshCancelAck {
    if (ack.result) {
      if (ack.result.eventId !== eventId || ack.result.sessionId !== sessionId || !['succeeded', 'failed', 'cancelled'].includes(ack.result.status))
        throw new BotDshDeliveryUnknownError('Native cancellation receipt identity or terminal status changed.', 'cancel');
      return ack;
    }
    if (ack.absent === true) {
      // Older /lanes/:id/cancel responses omit duplicate identity fields. The
      // authenticated route and request still bind this absence to the event.
      if (ack.sessionId !== undefined && ack.sessionId !== sessionId || ack.eventId !== undefined && ack.eventId !== eventId)
        throw new BotDshDeliveryUnknownError('Native absence receipt identity changed.', 'cancel');
      return ack;
    }
    if (suspend && ack.accepted === true && ack.paused === true && ack.sessionId === sessionId && ack.eventId === eventId) return ack;
    throw new BotDshDeliveryUnknownError('Native control did not prove a terminal, absent or durably paused event.', 'cancel');
  }
  private async withHost<T>(instanceId: string | undefined, signal: AbortSignal | undefined, laneId: string,
    work: (host: BotDshHost) => Promise<T>): Promise<T> {
    const host = await this.getHost(instanceId, signal, laneId), release = this.options.acquireLease?.(host);
    try { return await work(host); } finally { release?.(); }
  }
  static sessionId(laneId: string): string { return 'wlb-bot-' + createHash('sha256').update(laneId).digest('hex'); }

  async run(input: BotDshRun): Promise<BotDshResult> {
    input.signal?.throwIfAborted();
    if (input.model.apiFormat !== 'openai_chat') throw new Error('伙伴主脑目前需要 OpenAI Chat Completions 协议，请在模型设置中选择兼容端点。');
    const sessionId = BotDshBrain.sessionId(input.laneId);
    const stopping = this.pendingStops.get(sessionId);
    if (stopping) {
      try { await stopping.promise; }
      catch {
        input.signal?.throwIfAborted();
        // Only a new explicit user resume may reopen a manually stopped Host.
        // Inspect the previous event before any current-event admission. A
        // rejected promise alone must neither poison this lane forever nor
        // become permission to forget uncertain native work and resend it.
        if (input.resumeHost) await this.getHost(stopping.input.instanceId, input.signal, stopping.input.laneId, { explicit: true });
        await this.cancelDurable({ ...stopping.input, signal: input.signal }, stopping.suspend);
      }
      await this.active.get(sessionId)?.finished;
    }
    input.signal?.throwIfAborted();
    if (this.active.has(sessionId) || this.openingLanes.has(sessionId)) throw new BotDshLaneBusyError();
    this.openingLanes.add(sessionId);
    let client: NativeHostClient, release: (() => void) | undefined,
      created: { sessionId: string; cursor: number }, attachmentStage: 'host' | 'attach' = 'host';
    let acquireUse!: () => () => void;
    try {
      const host = await this.getHost(input.instanceId, input.signal, input.laneId, { explicit: input.resumeHost === true });
      release = this.options.acquireLease?.(host); client = host.client;
      acquireUse = () => this.options.acquireLease?.(host) ?? (() => undefined);
      attachmentStage = 'attach';
      created = await client.request('/bot/lanes', {
        sessionId, laneId: input.laneId, eventId: input.eventId, cwd: input.cwd, system: input.system, audience: input.audience,
        model: input.model, tools: input.tools, callback: input.callback, role: input.role ?? 'brain', workerAccess: input.workerAccess ?? 'scoped',
        workerTools: input.workerTools,
        workspaceTitle: input.workspaceTitle, workspaceParent: input.workspaceParent, sessionTitle: input.sessionTitle,
      }, input.signal);
    } catch (error) {
      release?.();
      if (isDshHostUnavailableError(error) || error && typeof error === 'object' && 'code' in error && error.code === 'BOT_HOST_MIGRATION_BLOCKED') throw error;
      if (input.signal?.aborted) throw error;
      if (attachmentStage === 'host') throw new DshHostUnavailableError('startup', 'DSH 执行器暂时无法连接，请检查实例后继续原任务。', input.instanceId, error);
      if (/active turn|active maintenance admission|capacity is occupied|lane is busy/.test(error instanceof Error ? error.message : '')) throw new BotDshLaneBusyError(error instanceof Error ? error.message : undefined);
      // Attaching may resume a previously admitted native inbox. Losing this
      // response does not prove that the original event failed or stayed idle.
      throw new BotDshDeliveryUnknownError(error, attachmentStage);
    } finally { this.openingLanes.delete(sessionId); }
    if (created.sessionId !== sessionId) { release?.(); throw new Error('Native DSH lane identity changed.'); }
    let finished!: () => void;
    const streamAbort = new AbortController();
    this.active.set(sessionId, { client, eventId: input.eventId, acquireUse, finished: new Promise<void>(resolve => { finished = resolve; }), stopStream: reason => streamAbort.abort(reason) });
    let stopRequested: Promise<BotDshCancelAck> | undefined;
    const abort = () => {
      const reason = input.signal?.reason;
      const suspend = !!reason && typeof reason === 'object' && 'code' in reason && reason.code === 'BOT_SUSPEND';
      const stopping = client.request<BotDshCancelAck>(`/bot/lanes/${sessionId}/cancel`, { eventId: input.eventId, suspend })
        .then(ack => this.stopReceipt(ack, sessionId, input.eventId, suspend));
      stopRequested = stopping;
      const pending: PendingStop = { promise: stopping, input: cancellationInput(input), suspend };
      this.pendingStops.set(sessionId, pending);
      void stopping.then(() => { if (this.pendingStops.get(sessionId) === pending) this.pendingStops.delete(sessionId); }, () => undefined);
      streamAbort.abort(reason);
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    let terminal = false, deliveryStage: 'turn' | 'stream' = 'turn';
    try {
      const admitted = await client.request<{ accepted: boolean; result?: BotDshResult }>(`/bot/lanes/${sessionId}/turn`, {
        eventId: input.eventId, prompt: input.prompt, continueAfterSeq: input.continueAfterSeq, taskContinuation: input.taskContinuation,
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
          const result = { text: event.text ?? '', sessionId, eventId: input.eventId, status, artifacts: event.artifacts,
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
      input.signal?.removeEventListener('abort', abort); streamAbort.abort(); this.active.delete(sessionId); finished(); release?.();
    }
  }

  async cancel(laneId: string): Promise<void> {
    const sessionId = BotDshBrain.sessionId(laneId), active = this.active.get(sessionId);
    if (active) { const release = active.acquireUse(); try { await active.client.request(`/bot/lanes/${sessionId}/cancel`, { eventId: active.eventId }); } finally { release(); } }
  }
  async cancelDurable(input: Omit<BotDshRun, 'prompt' | 'onEvent'>, suspend = false): Promise<BotDshCancelAck> {
    const sessionId = BotDshBrain.sessionId(input.laneId);
    let client: NativeHostClient, release: (() => void) | undefined;
    try { const host = await this.getHost(input.instanceId, input.signal, input.laneId); release = this.options.acquireLease?.(host); client = host.client; }
    catch (error) {
      if (input.signal?.aborted || isDshHostUnavailableError(error) || error && typeof error === 'object' && 'code' in error && error.code === 'BOT_HOST_MIGRATION_BLOCKED') throw error;
      // This operation has not inspected or admitted native work yet. Earlier
      // uncertain effects remain gated independently of Host availability.
      throw new DshHostUnavailableError('startup', 'DSH 执行器暂时无法连接，请检查实例后继续原任务。', input.instanceId, error);
    }
    try {
    const previous = this.pendingStops.get(sessionId); if (previous) await previous.promise.catch(() => undefined);
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
    try { await client.request('/bot/lanes', { sessionId, laneId: input.laneId, eventId: input.eventId, cwd: input.cwd, system: input.system, audience: input.audience,
      model: input.model, tools: input.tools, callback: input.callback, role: input.role ?? 'brain',
      workerAccess: input.workerAccess ?? 'scoped', workerTools: input.workerTools, workspaceTitle: input.workspaceTitle,
      workspaceParent: input.workspaceParent, sessionTitle: input.sessionTitle, cancelIntent: true, suspendIntent: suspend }, input.signal); }
    catch (error) { if (input.signal?.aborted) throw error; throw new BotDshDeliveryUnknownError(error, 'attach'); }
    const stopping = client.request<BotDshCancelAck>(`/bot/lanes/${sessionId}/cancel`, { eventId: input.eventId, ...(suspend ? { suspend: true } : {}) }, input.signal)
      .then(ack => this.stopReceipt(ack, sessionId, input.eventId, suspend));
    const pending: PendingStop = { promise: stopping, input: cancellationInput(input), suspend };
    this.pendingStops.set(sessionId, pending);
    let confirmed = false;
    try {
      const ack = await stopping;
      confirmed = true;
      return ack;
    } catch (error) {
      if (input.signal?.aborted || error instanceof BotDshDeliveryUnknownError) throw error;
      throw new BotDshDeliveryUnknownError(error, 'cancel');
    } finally { if (confirmed && this.pendingStops.get(sessionId) === pending) this.pendingStops.delete(sessionId); }
    } finally { release?.(); }
  }
  async send(laneId: string, input: { messageId: string; text: string; mode: 'steer' | 'queue' }): Promise<void> {
    const sessionId = BotDshBrain.sessionId(laneId), active = this.active.get(sessionId);
    if (!active) throw new Error('The native task is not attached or running.');
    const release = active.acquireUse();
    try { await active.client.request(`/bot/lanes/${sessionId}/input`, { ...input, eventId: active.eventId }); } finally { release(); }
  }
  /** Release a completed encoder/worker from RAM while retaining its native
   * log and durable receipts. Never cancels an active task. */
  async archive(laneId: string, instanceId?: string): Promise<void> {
    const sessionId = BotDshBrain.sessionId(laneId);
    if (this.active.has(sessionId) || this.openingLanes.has(sessionId)) throw new Error('Archive requires a completed native lane.');
    await this.withHost(instanceId, undefined, laneId, async ({ client }) => { await client.request(`/bot/lanes/${sessionId}/archive`, {}); });
  }
  async close(): Promise<void> {
    // Shutdown preserves Inbox/cancel intents for reconciliation. A failed
    // transport stop cannot prevent memory/store/Host cleanup from running.
    await Promise.allSettled([...this.active.entries()].map(async ([sessionId, active]) => {
      let release: (() => void) | undefined;
      try { release = active.acquireUse(); await active.client.request(`/bot/lanes/${sessionId}/cancel`, { eventId: active.eventId, suspend: true }); }
      finally { release?.(); active.stopStream(Object.assign(new Error('The native companion adapter stopped; the durable event remains resumable.'), { code: 'BOT_SUSPEND' })); }
    }));
    await Promise.allSettled([...this.pendingStops.values()].map(stop => stop.promise));
  }
}
