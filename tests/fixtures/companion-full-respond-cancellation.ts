import type { CompanionReplyStreamEvent, CompanionsRequest, CompanionsResponse } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

interface Host {
  handle(command: CompanionsRequest): Promise<CompanionsResponse>;
  storage: { request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> };
  replies: Map<string, { promise: Promise<unknown> }>;
}
interface Resources { worldWorksActive: number; priorityActive: number }
interface Options { host(): Host; isTarget(sourceId: string): boolean; didDispatch(sourceId: string): boolean; nowMs(): number;
  triggerPhase?: 'memory'; requirePriority?: boolean; resources?(event: CompanionReplyStreamEvent): Resources }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function bounded<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** An observer of real host progress, never a synthetic abort or progress gate.
 * Only the normal exact-work UI cancellation API can stop the measured task. */
export function createFullRespondCancellationProbe(options: Options) {
  let attempt: Promise<Record<string, unknown>> | undefined;
  let initialSource: string | undefined;
  let preRuntimeProgress = 0;
  const terminalProgress = new Map<string, string>();
  async function cancel(event: CompanionReplyStreamEvent): Promise<Record<string, unknown>> {
    const host = options.host(), workId = event.progress!.workId!, runtime = host.replies.get(workId);
    const resourcesBefore = options.resources?.(event);
    if (resourcesBefore && (resourcesBefore.worldWorksActive < 1 || options.requirePriority && resourcesBefore.priorityActive < 1))
      throw new Error('Cancellation did not observe its actual task body/priority reservation before stopping.');
    const requestedMs = options.nowMs();
    const acknowledgement = await bounded(host.handle({ type: 'reply.cancel', conversationId: event.conversationId, workId }), 15000, 'Exact cancellation acknowledgement exceeded 15 seconds.');
    const acknowledgedMs = options.nowMs();
    if (!acknowledgement.ok) throw new Error('The real reply.cancel handler did not acknowledge the selected task.');
    if (!runtime) throw new Error('The selected preparation progress had no matching live runtime task.');
    await bounded(runtime.promise.catch(() => undefined), 15000, 'The cancelled runtime did not settle within 15 seconds.');
    const until = performance.now() + 15000;
    let current: CompanionStorageResponse;
    do {
      current = await host.storage.request({ type: 'work.get', companionId: event.companionId, id: workId });
      if (!current.ok) throw new Error('The stopped work could not be read through the real storage port.');
      if (current.work?.status === 'cancelled' && !host.replies.has(workId)) break;
      await pause(25);
    } while (performance.now() < until);
    const work = current!.work;
    if (work?.status !== 'cancelled' || host.replies.has(workId) || work.sourceMessageId !== event.sourceMessageId || work.conversationId !== event.conversationId)
      throw new Error('Exact cancellation did not settle the selected durable work and runtime.');
    if (options.didDispatch(event.sourceMessageId)) throw new Error('The task reached model dispatch before its preparation cancellation settled.');
    const resourcesAfter = options.resources?.(event);
    if (resourcesAfter && (resourcesAfter.worldWorksActive || resourcesAfter.priorityActive))
      throw new Error('The stopped task retained its actual body/priority reservation.');
    return { workId, sourceMessageId: event.sourceMessageId, trigger: 'actual_reply_stream_progress', triggerPhase: event.progress!.phase,
      progressObservedMs: requestedMs, acknowledgementMs: acknowledgedMs - requestedMs,
      runtimeSettledMs: options.nowMs() - requestedMs, terminalWorkStatus: work.status,
      terminalProgressPhase: terminalProgress.get(workId), preRuntimeProgressSkipped: preRuntimeProgress, cancelledBeforeModelDispatch: true, runtimeSettled: true,
      resourcesBefore, resourcesAfter };
  }
  return {
    observe(event: CompanionReplyStreamEvent): void {
      if (event.progress?.workId && ['cancelled', 'failed', 'interrupted', 'completed'].includes(event.progress.phase))
        terminalProgress.set(event.progress.workId, event.progress.phase);
      if (attempt || !event.progress?.workId || !['context', 'memory'].includes(event.progress.phase) || !options.isTarget(event.sourceMessageId)) return;
      if (options.triggerPhase && event.progress.phase !== options.triggerPhase) return;
      // Queue admission publishes a genuine "context" milestone before the
      // runtime is registered. Measure cancellation of active preparation,
      // rather than merely removing that not-yet-started queued work.
      if (!options.host().replies.has(event.progress.workId)) { preRuntimeProgress++; return; }
      initialSource = event.sourceMessageId;
      // Leave the synchronous stream publisher before entering the UI handler.
      attempt = Promise.resolve().then(() => cancel(event));
      void attempt.catch(() => undefined);
    },
    async cancelAndRecover(send: (suffix: string) => Promise<CompanionsResponse>): Promise<{ sent: CompanionsResponse[]; result: Record<string, unknown> }> {
      const first = await send('_cancel');
      if (!first.ok || !first.message) throw new Error('Official initial message.send did not create the cancellation task.');
      const until = performance.now() + 120000;
      while (!attempt && performance.now() < until) await pause(25);
      if (!attempt) throw new Error('No actual context/memory progress arrived for the cancellation task.');
      if (initialSource !== first.message.id) throw new Error('Cancellation progress was not bound to the officially sent initial message.');
      const result = await attempt;
      const recoveryStartedMs = options.nowMs(), recovered = await send('_after_cancel');
      if (!recovered.ok || !recovered.message || recovered.message.id === first.message.id) throw new Error('Official new message.send did not create an independent task after cancellation.');
      return { sent: [first, recovered], result: { ...result, recoveryMessageAccepted: true, recoverySourceMessageId: recovered.message.id,
        recoveryStartedMs, recoveryEnqueueMs: options.nowMs() - recoveryStartedMs } };
    },
  };
}
