import type { DshTaskEvent } from './dsh-tasks';
import type { CompanionActionEvent } from './companions';

/** Same bounded, non-reasoning projection for live IPC and durable task history. */
export function companionProgressEvent(event: DshTaskEvent): CompanionActionEvent | undefined {
  if (/(?:^|[._-])(reasoning|thinking|analysis)(?:$|[._-])/i.test(event.type) || !event.summary) return;
  if (event.type === 'approval_required' || event.type === 'approval_decided') return {
    sequence: event.sequence, type: event.type, summary: event.summary, receivedAt: event.receivedAt,
    toolName: event.toolName, callId: event.callId, content: event.text?.slice(0, 16000), contentKind: 'message',
  };
  if (event.type === 'parent_report' && event.text) {
    try {
      const report = JSON.parse(event.text) as { text?: unknown; kind?: unknown };
      if (typeof report.text === 'string') return { sequence: event.sequence, type: 'message',
        summary: report.kind === 'question' ? '执行器请求决定' : '执行器阶段汇报', receivedAt: event.receivedAt,
        callId: event.callId, content: report.text.slice(0, 16000), contentKind: 'message', outputState: 'committed' };
    } catch { /* An invalid report retains its ordinary diagnostic projection. */ }
  }
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
