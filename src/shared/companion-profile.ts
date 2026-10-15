import { z } from 'zod';

const attachmentId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
/** Public, explicitly authored identity. Attachment paths are resolved only by Main. */
export const playerProfileDraftSchema = z.strictObject({
  name: z.string().trim().min(1).max(60), description: z.string().max(4000),
  avatarAttachmentId: attachmentId.optional(), appearanceAttachmentId: attachmentId.optional(),
});
export const playerProfileSchema = playerProfileDraftSchema.extend({
  id: z.literal('user'), revision: z.number().int().positive(), updatedAt: z.iso.datetime(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const playerProfileCommands = [
  z.strictObject({ type: z.literal('player.profile.get') }),
  z.strictObject({ type: z.literal('player.profile.update'), expectedRevision: z.number().int().positive(), profile: playerProfileDraftSchema }),
] as const;
export type PlayerProfileDraft = z.infer<typeof playerProfileDraftSchema>;
export type PlayerProfile = z.infer<typeof playerProfileSchema>;
