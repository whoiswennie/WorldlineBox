import type { DshTaskEvent } from './dsh-tasks';
import type { CompanionActionEvent } from './companions';

/** Same bounded, non-reasoning projection for live IPC and durable task history. */
export function companionProgressEvent(event: DshTaskEvent): CompanionActionEvent | undefined {
  if (/(?:^|[._-])(reasoning|thinking|analysis)(?:$|[._-])/i.test(event.type) || !event.summary) return;
  return { sequence: event.sequence, type: event.stage ?? event.type, summary: event.summary,
    toolName: event.toolName, receivedAt: event.receivedAt, callId: event.callId, streamId: event.streamId, outputState: event.outputState,
    ...(event.text && event.type !== 'final' ? { content: event.text.slice(0, 16000), contentKind: event.contentKind ?? 'message' } : {}) };
}
export function mergeCompanionProgress(current: readonly CompanionActionEvent[], incoming: readonly CompanionActionEvent[]): CompanionActionEvent[] {
  const merged = new Map(current.map(event => [event.streamId ?? event.sequence, event]));
  for (const event of incoming) {
    const key = event.streamId ?? event.sequence;
    if (event.sequence >= (merged.get(key)?.sequence ?? -1)) merged.set(key, event);
  }
  return [...merged.values()].sort((a, b) => a.sequence - b.sequence).slice(-150);
}
