import { z } from 'zod';
import { companionUserStopSchema } from './companion-task-stop';
import { companionExecutionReadsetSchema } from './companion-execution-evidence';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const scope = z.object({ companionId: id, conversationId: id });
export const companionWorkOrderStatusSchema = z.enum(['offered', 'accepted', 'running', 'paused', 'completed', 'failed', 'cancelled']);
export const companionWorkOrderSchema = z.strictObject({
  id, companionId: id, publisherId: id, conversationId: id, sourceMessageId: id,
  authorizationSourceMessageIds: z.array(id).min(1).max(100),
  title: z.string().min(1).max(200), instruction: z.string().min(1).max(65536),
  execution: z.enum(['external', 'internal']), status: companionWorkOrderStatusSchema,
  revision: z.number().int().positive(), actionId: id.optional(), actionIds: z.array(id).optional(), completionMessageId: id.optional(),
  result: z.string().max(32000).optional(), error: z.string().max(2000).optional(), stop: companionUserStopSchema.optional(),
  createdAt: z.iso.datetime(), worldCreatedAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type CompanionWorkOrder = z.infer<typeof companionWorkOrderSchema>;
export const companionWorkOrderPageSchema = z.strictObject({ items: z.array(companionWorkOrderSchema), hasMore: z.boolean(), nextBefore: z.number().int().positive().optional() });
export const companionWorkOrderClaimSchema = z.strictObject({ order: companionWorkOrderSchema, leaseToken: id, leaseUntil: z.iso.datetime() });
export const companionWorkOrderPatchSchema = z.strictObject({ title: z.string().trim().min(1).max(200).optional(), instruction: z.string().trim().min(1).max(16000).optional() });
const mutable = scope.extend({ id, expectedRevision: z.number().int().positive() });
export const companionWorkOrderPublicCommands = [
  scope.extend({ type: z.literal('work-order.list'), includeHistory: z.boolean().default(false), before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(40) }).strict(),
  scope.extend({ type: z.literal('work-order.create'), title: z.string().trim().min(1).max(200), instruction: z.string().trim().min(1).max(16000), sourceMessageId: id.optional(), clientId: id.optional() }).strict(),
  mutable.extend({ type: z.literal('work-order.update'), patch: companionWorkOrderPatchSchema, sourceMessageId: id.optional() }).strict(),
  mutable.extend({ type: z.literal('work-order.accept') }).strict(),
  mutable.extend({ type: z.literal('work-order.pause'), paused: z.boolean() }).strict(),
  mutable.extend({ type: z.literal('work-order.cancel') }).strict(),
] as const;
export const companionWorkOrderStorageCommands = [
  ...companionWorkOrderPublicCommands,
  z.strictObject({ type: z.literal('work-order.claim'), companionId: id.optional(), leaseMs: z.number().int().min(1000).max(3600000).default(120000) }),
  z.strictObject({ type: z.literal('work-order.heartbeat'), id, leaseToken: id, leaseMs: z.number().int().min(1000).max(3600000).default(120000) }),
  z.strictObject({ type: z.literal('work-order.complete'), id, leaseToken: id, result: z.string().trim().min(1).max(16000).optional(),
    executionReadset: companionExecutionReadsetSchema.optional(),
    goalInvocationId: id.optional(), goalSlot: id.optional(), actionIds: z.array(id).optional() }),
  z.strictObject({ type: z.literal('work-order.fail'), id, leaseToken: id, error: z.string().max(2000) }),
  z.strictObject({ type: z.literal('work-order.interrupt-pending') }),
] as const;
