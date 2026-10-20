import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionContactStateSchema = z.enum(['available', 'dormant', 'sleeping', 'eating', 'working', 'busy']);
export type CompanionContactState = z.infer<typeof companionContactStateSchema>;
export const COMPANION_CONTACT_LABELS: Record<CompanionContactState, string> = {
  available: '可以联系', dormant: '已休眠，等待玩家激活', sleeping: '正在睡觉，醒来后回复',
  eating: '正在吃饭，结束后回复', working: '正在工作，空闲后回复', busy: '暂时忙碌，稍后回复',
};
export const companionContactReceiptSchema = z.object({ companionId: id, state: companionContactStateSchema });
export const companionInteractionSchema = z.object({
  companionId: id, conversationId: id, recipientIds: z.array(id).max(20),
  phase: z.enum(['typing', 'responding', 'notification', 'speaking', 'listening', 'queued', 'waiting']),
  channel: z.enum(['phone', 'face_to_face']),
  recipients: z.array(companionContactReceiptSchema).max(20),
});
export type CompanionInteraction = z.infer<typeof companionInteractionSchema>;
