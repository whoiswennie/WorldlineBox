import { z } from 'zod';

const id = z.string().min(1).max(160);
export const scheduleRecurrence = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('daily'), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }),
  z.strictObject({ kind: z.literal('interval'), minutes: z.number().int().min(1).max(10080) }),
]);
export const scheduleDraft = z.strictObject({ title: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(8000), recurrence: scheduleRecurrence, enabled: z.boolean(), cabinWorld: z.boolean().optional() });
export const scheduleCommand = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list') }),
  z.strictObject({ operation: z.literal('settings'), enabled: z.boolean() }),
  z.strictObject({ operation: z.literal('save'), id: id.optional(), draft: scheduleDraft }),
  z.strictObject({ operation: z.literal('toggle'), id, enabled: z.boolean() }),
  z.strictObject({ operation: z.literal('delete'), id }),
]);
export type ScheduleCommand = z.infer<typeof scheduleCommand>;
export type ScheduleDraft = z.infer<typeof scheduleDraft>;
export type ScheduleRunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped' | 'unknown';
export interface CompanionSchedule extends ScheduleDraft {
  id: string;
  nextAt: number;
  lastRun?: { at: number; topicId?: string; status: ScheduleRunStatus; reason?: 'cabin-offline' };
}
export interface CompanionScheduleState { enabled: boolean; items: CompanionSchedule[] }

export function scheduleUsesCabin(draft: ScheduleDraft): boolean {
  return draft.cabinWorld === true || /小屋世界|cabin[ _-]world|\bcabin_(?:status|look|go|use|buy|eat|stop|task_status)\b/i.test(draft.prompt);
}

export const cabinSchedulePresets = [
  { title: '早上去公园', prompt: '用小屋世界工具看一下小鲸鱼的状态，去公园走走。等游戏确认到达后，简短记录结果。', recurrence: { kind: 'daily', time: '09:00' }, enabled: true, cabinWorld: true },
  { title: '下午荡秋千', prompt: '用小屋世界工具让小鲸鱼去荡秋千。等游戏确认动作完成后，简短记录结果。', recurrence: { kind: 'daily', time: '16:00' }, enabled: true, cabinWorld: true },
  { title: '定时照顾小鱼', prompt: '用小屋世界工具让小鲸鱼回家喂鱼。等游戏确认动作完成后，简短记录结果。', recurrence: { kind: 'interval', minutes: 180 }, enabled: true, cabinWorld: true },
] satisfies ScheduleDraft[];
