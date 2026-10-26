import { z } from 'zod';
import { companionUserStopSchema } from './companion-task-stop';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionBackgroundTaskKindSchema = z.enum(['world', 'social', 'social_notification', 'schedule_occurrence']);
export const companionTaskControlStopCommand = z.strictObject({ type: z.literal('task-control.stop'), companionId: id,
  kind: companionBackgroundTaskKindSchema, id, stop: companionUserStopSchema });
export const companionTaskControlResultSchema = z.strictObject({ companionId: id, kind: companionBackgroundTaskKindSchema,
  id, conversationId: id, title: z.string().max(200), sourceMessageId: id.optional(), stopped: z.boolean(),
  actionIds: z.array(id), activityTaskIds: z.array(id), runtimeTaskIds: z.array(id).optional() });
export type CompanionTaskControlResult = z.infer<typeof companionTaskControlResultSchema>;
