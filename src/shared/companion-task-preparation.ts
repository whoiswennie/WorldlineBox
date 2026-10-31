import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const maxBytes = 16 * 1024 * 1024;
/** Internal task input, sealed before inference. It contains no provider keys. */
export const companionTaskPreparationBlobSchema = z.string().min(1).max(maxBytes);
const envelope = z.object({ schema: z.literal('worldlinebox.task-preparation-v1'), kind: z.enum(['goal', 'social']),
  ownerId: id, conversationId: id, sourceMessageId: id, invocationKey: id,
  capturedAt: z.iso.datetime(), revocationEpoch: z.number().int().nonnegative().safe(), payload: z.record(z.string(), z.unknown()) });
export type CompanionTaskPreparationBinding = Pick<z.output<typeof envelope>, 'kind' | 'ownerId' | 'conversationId' | 'sourceMessageId' | 'invocationKey'>;
export function parseCompanionTaskPreparation(blob: string, expected: CompanionTaskPreparationBinding) {
  if (new TextEncoder().encode(blob).length > maxBytes) throw new Error('任务初始输入超过16MiB。');
  const value = envelope.parse(JSON.parse(blob));
  if (value.kind !== expected.kind || value.ownerId !== expected.ownerId || value.conversationId !== expected.conversationId
    || value.sourceMessageId !== expected.sourceMessageId || value.invocationKey !== expected.invocationKey)
    throw new Error('任务初始输入不属于当前伙伴、会话、来源或调用。');
  return value;
}
export function companionTaskPreparation<T extends Record<string, unknown>>(binding: CompanionTaskPreparationBinding,
  payload: T, observation: { capturedAt: string; revocationEpoch: number }): string {
  const blob = JSON.stringify({ schema: 'worldlinebox.task-preparation-v1', ...binding,
    capturedAt: observation.capturedAt, revocationEpoch: observation.revocationEpoch, payload });
  parseCompanionTaskPreparation(blob, binding); return blob;
}
