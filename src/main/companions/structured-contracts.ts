import { z } from 'zod';

const identifier = z.string().min(1).max(100);
/** Shape contracts for processors that previously checked fields by hand.
 * Exact owner/source IDs and authority remain separate host domain checks. */
export const companionInternalWorkResponseSchema = z.strictObject({ orderId: identifier, result: z.string().trim().min(1).max(16000) });
export const companionLifeSpeechResponseSchema = z.strictObject({ eventId: identifier, speakerId: identifier, targetId: identifier.optional(),
  decision: z.enum(['speak', 'silence']), text: z.string().max(2000).nullable(), reason: z.string().trim().min(1).max(500) });
export const companionCollaborationAuthorizationResponseSchema = z.strictObject({ sourceMessageId: identifier, allowed: z.boolean(),
  confidence: z.number().min(0).max(1), evidence: z.array(z.string().min(1).max(16000)).max(5), reason: z.string().trim().min(1).max(1000) });
export const companionCollaborationOfferResponseSchema = z.strictObject({ decision: z.enum(['accept', 'decline']), reason: z.string().trim().min(1).max(2000) });
export const companionResponseJsonSchema = (schema: z.ZodType): Record<string, unknown> => z.toJSONSchema(schema, { io: 'input' });
