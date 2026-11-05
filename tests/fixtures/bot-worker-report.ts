import { createHash, randomUUID } from 'node:crypto';
import { BotDshBrain, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import type { BotWorkerReport } from '../../src/main/companion-bot/task-report';

/** A scripted worker must explicitly report its business result just like the
 * native tool. This fixture does not infer readiness from final prose. */
export async function reportWorkerOutcome(input: BotDshRun, report: BotWorkerReport, callId = 'report-' + randomUUID()) {
  const nativeSessionId = BotDshBrain.sessionId(input.laneId), nativeCallId = callId;
  const request = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(input.callback.url, { method: 'POST', headers: { authorization: 'Bearer ' + input.callback.token, 'content-type': 'application/json' },
      body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId, name, args }) });
    const value = await response.json() as { ok: boolean; result: unknown; error?: string };
    if (!response.ok || !value.ok) throw Error(value.error ?? 'Worker report fixture callback failed.');
    return value.result;
  };
  const argsHash = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  await request('worker_effect_start', { callId, toolName: 'worker_report', argsHash, argumentsPreview: report.summary.slice(0, 4000), nativeSessionId, nativeCallId });
  const value = await request('worker_report', { ...report, nativeSessionId, nativeCallId });
  await request('worker_effect_commit', { callId, toolName: 'worker_report', argsHash, isError: false, nativeSessionId, nativeCallId });
  return value;
}
