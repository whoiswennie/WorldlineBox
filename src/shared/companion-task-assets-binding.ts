import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const COMPANION_TASK_ASSETS_MAX_BYTES = 16 * 1024 * 1024;
/** Host-only durable JSON. Main validates the complete asset package; storage
 * seals its exact bytes and independently checks the owning task identity. */
export const companionTaskAssetsBlobSchema = z.string().min(1).max(COMPANION_TASK_ASSETS_MAX_BYTES);
const bindingSchema = z.object({ schema: z.literal('worldlinebox.task-assets-v1'), ownerId: id, conversationId: id,
  sourceMessageId: id, invocationKey: id.optional(), capturedAt: z.iso.datetime(), revocationEpoch: z.number().int().nonnegative().safe() });
export function assertCompanionTaskAssetsBinding(blob: string, expected: { ownerId: string; conversationId: string; sourceMessageId: string; invocationKey?: string }): void {
  if (new TextEncoder().encode(blob).length > COMPANION_TASK_ASSETS_MAX_BYTES) throw new Error('任务初始角色快照超过16MiB。');
  const value = bindingSchema.parse(JSON.parse(blob));
  if (value.ownerId !== expected.ownerId || value.conversationId !== expected.conversationId || value.sourceMessageId !== expected.sourceMessageId
    || value.invocationKey !== expected.invocationKey) throw new Error('任务初始角色快照不属于当前伙伴、会话、来源或调用。');
}
