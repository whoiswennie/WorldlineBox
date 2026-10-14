import { z } from 'zod';
import { companionRoutinePatchSchema } from './companion-routine';

export const companionRoutineArgumentsSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('inspect') }),
  z.strictObject({ action: z.literal('configure'), expectedRevision: z.number().int().positive(), patch: companionRoutinePatchSchema }),
]);
export type CompanionRoutineArguments = z.output<typeof companionRoutineArgumentsSchema>;
const parameters = z.toJSONSchema(companionRoutineArgumentsSchema, { io: 'input' }) as Record<string, unknown>;
delete parameters.$schema;
export const COMPANION_ROUTINE_TOOL = {
  name: 'routine',
  description: '查看和培养你自己的虚拟生活作息。inspect读取实际睡眠、吃饭、休息、习惯与养成进度；configure依据本次用户明确的作息或习惯培养要求修改，带读取到的expectedRevision与patch。timeZone用IANA或system，sleepAt/wakeAt/活动at用HH:mm。meals与habits是完整替换数组，修改前先inspect，保留用户没有要求移除的条目。habits含id,title,at,durationMinutes,kind(rest/exercise/study/leisure/custom)，可weekDays(0周日到6周六)。习惯和活动应符合稳定人格与当前约定，不能随机捏造经历；不接受模型填写strength/streak/completedCount/energy。离线期间虚拟作息依时钟推进，不能声称关闭应用时执行了现实电脑任务、吃过现实食物或发出通知。固定日程仍履行，只有实际紧急对话和已授权固定任务可临时唤醒，不能凭历史任务擅自打断休息。',
  parameters: { type: 'object', ...parameters },
} as const;
