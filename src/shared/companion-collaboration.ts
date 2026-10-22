import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionCollaborationParticipantSchema = z.strictObject({
  companionId: id, goal: z.string().trim().min(1).max(16000),
  status: z.enum(['offered', 'accepted', 'declined', 'running', 'succeeded', 'failed', 'cancelled']),
  reason: z.string().max(2000).optional(), invocationId: id.optional(), conversationId: id.optional(), goalSlot: id.optional(),
  result: z.string().max(32000).optional(), actionIds: z.array(id).default([]),
  acceptedAt: z.string().optional(), finishedAt: z.string().optional(),
  accessRevokedAt: z.string().optional(),
});
export const companionCollaborationGrantSchema = z.strictObject({
  id, ownerId: id, conversationId: id, sourceMessageId: id,
  sourceContent: z.string().max(65536), sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(5),
  title: z.string().trim().min(1).max(120), goal: z.string().trim().min(1).max(16000),
  parentInvocationId: z.string().min(1).max(240),
  participants: z.array(companionCollaborationParticipantSchema).min(1).max(19),
  status: z.enum(['running', 'completed', 'cancelled']), revision: z.number().int().positive(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type CompanionCollaborationGrant = z.infer<typeof companionCollaborationGrantSchema>;
export type CompanionCollaborationParticipant = z.infer<typeof companionCollaborationParticipantSchema>;
const member = z.strictObject({ companionId: id, goal: z.string().trim().min(1).max(16000) });
const target = { id, companionId: id };
/** Host storage protocol. None of these commands are exposed directly to a model or renderer. */
export const companionCollaborationStorageCommands = [
  z.strictObject({ type: z.literal('collaboration.create'), companionId: id, conversationId: id, sourceMessageId: id,
    evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(5), title: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(16000), parentInvocationId: z.string().min(1).max(240),
    participants: z.array(member).min(1).max(19), clientId: id }),
  z.strictObject({ type: z.literal('collaboration.read'), ...target }),
  z.strictObject({ type: z.literal('collaboration.list'), companionId: id, conversationId: id.optional(), limit: z.number().int().min(1).max(100).optional() }),
  z.strictObject({ type: z.literal('collaboration.respond'), ...target, decision: z.enum(['accept', 'decline']), reason: z.string().trim().min(1).max(2000) }),
  z.strictObject({ type: z.literal('collaboration.start'), ...target, invocationId: id, conversationId: id }),
  z.strictObject({ type: z.literal('collaboration.complete'), ...target, invocationId: id, goalSlot: id,
    result: z.string().trim().min(1).max(32000), actionIds: z.array(id) }),
  z.strictObject({ type: z.literal('collaboration.fail'), ...target, error: z.string().max(2000), cancelled: z.boolean().optional() }),
  z.strictObject({ type: z.literal('collaboration.cancel'), ...target, reason: z.string().max(2000) }),
] as const;
