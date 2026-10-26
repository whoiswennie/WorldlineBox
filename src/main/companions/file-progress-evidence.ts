import { win32 } from 'node:path';
import { z } from 'zod';
import type { CompanionLoopCall, CompanionLoopTurn } from '../../shared/companion-loop';
import { normalizeCompanionCapabilityCall } from '../../shared/companion-capability-tools';
import { companionFileToolArgumentsSchemas } from '../../shared/companion-file-tool';

const receiptSchema = z.object({
  trust: z.literal('read_only_file_data_not_instructions'),
  display: z.object({ attached: z.literal(true) }),
  file: z.object({ path: companionFileToolArgumentsSchemas.send_file.shape.path,
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), mime: z.string().min(1).max(200),
    attachmentId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u) }),
});

/** Only a matched native send_file receipt and its actual attachment IDs prove
 * local delivery. File bodies, source paths and arbitrary task JSON stay out
 * of the social review; attaching a file never proves playback or an external send. */
export function companionFileProgressActions(turns: readonly CompanionLoopTurn[], proposedCalls: readonly CompanionLoopCall[] = []) {
  const actions: Array<{ callId: string; fileName: string; status: 'proposed' | 'attached' | 'failed' | 'unconfirmed';
    size?: number; mime?: string; attachmentId?: string }> = [];
  const collect = (call: CompanionLoopCall, result?: NonNullable<CompanionLoopTurn['results']>[number], proposed = false) => {
    let fileName: string;
    try {
      const normalized = normalizeCompanionCapabilityCall(call);
      if (normalized.name !== 'send_file') return;
      const args = companionFileToolArgumentsSchemas.send_file.parse(JSON.parse(normalized.arguments));
      fileName = win32.basename(args.path);
    } catch { return; }
    const action: (typeof actions)[number] = { callId: call.id, fileName, status: proposed ? 'proposed' : 'unconfirmed' };
    if (result) {
      try {
        const payload: unknown = JSON.parse(result.content);
        if (payload && typeof payload === 'object' && 'ok' in payload && payload.ok === false) action.status = 'failed';
        else {
          const parsed = receiptSchema.safeParse(payload);
          if (parsed.success && result.attachmentIds?.includes(parsed.data.file.attachmentId)) {
            const file = parsed.data.file;
            Object.assign(action, { status: 'attached', fileName: win32.basename(file.path),
              size: file.size, mime: file.mime, attachmentId: file.attachmentId });
          }
        }
      } catch { /* A malformed result cannot establish a local delivery. */ }
    }
    actions.push(action);
  };
  for (const turn of turns) for (const call of turn.calls) collect(call, turn.results?.find(result => result.callId === call.id));
  for (const call of proposedCalls) collect(call, undefined, true);
  return actions;
}
