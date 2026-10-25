import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
/** Host-owned origin of the receiver's explicit acceptance, never user authority. */
export const companionPeerResponsibilitySchema = z.strictObject({ jobId: id, publisherId: id });
export type CompanionPeerResponsibility = z.infer<typeof companionPeerResponsibilitySchema>;
/** Written only when the actual social completion transaction creates its task. */
export const companionAcceptedPeerActivitySchema = z.strictObject({ taskId: id, sourceMessageId: id, publisherId: id,
  title: z.string().min(1).max(120), instruction: z.string().min(1).max(16000), sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/u) });
export type CompanionAcceptedPeerActivity = z.infer<typeof companionAcceptedPeerActivitySchema>;
export interface CompanionPeerActivityAcceptanceInput {
  companionId: string; conversationId: string; sourceMessageId: string; title: string; instruction: string; clientId: string;
  jobId: string; publisherId: string; leaseToken: string;
}
