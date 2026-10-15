import { z } from 'zod';

export const companionAvatarCropSchema = z.strictObject({
  centerX: z.number().min(0).max(1), centerY: z.number().min(0).max(1),
  zoom: z.number().min(1).max(8), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
});
export const companionAvatarCropRequestSchema = z.strictObject({ type: z.literal('avatar.crop'),
  attachmentId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), crop: companionAvatarCropSchema });
export type CompanionAvatarCrop = z.infer<typeof companionAvatarCropSchema>;
export type CompanionAvatarCropRequest = z.infer<typeof companionAvatarCropRequestSchema>;
