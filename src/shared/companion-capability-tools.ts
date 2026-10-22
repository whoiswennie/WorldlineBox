import { z } from 'zod';
import { companionMemoryToolArgumentsSchemas } from './companion-memory-tool';
import { companionWorldArgumentsSchema, COMPANION_WORLD_TOOL } from './companion-world-tool';
import { activityArgumentsSchema } from './companion-activity-task';
import { companionScheduleArgumentsSchema } from './companion-schedule-tool';
import { companionStateArgumentsSchema } from './companion-state-tool';
import { companionRoutineArgumentsSchema } from './companion-routine-tool';
import { companionWorkArgumentsSchema } from './companion-work-tool';
import { companionLifeArgumentsSchema } from './companion-life-tool';
import type { CompanionLoopCall } from './companion-loop';
import { companionDshArgumentsSchema, COMPANION_DSH_TOOL } from './companion-dsh-tool';
import { dshRecordQuerySchema } from './dsh-task-record';
import { companionFileToolArgumentsSchemas } from './companion-file-tool';
import { dshTaskCapabilityQuerySchema } from './dsh-task-spec';
import { companionTopicArgumentsSchema } from './companion-topic';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionHistoryArgumentsSchema = z.strictObject({ action: z.literal('history'),
  before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(50) });
export const companionCollaborationArgumentsSchema = z.strictObject({ action: z.literal('collaborate'),
  title: z.string().trim().min(1).max(120), goal: z.string().trim().min(1).max(12000),
  participantIds: z.array(id).min(1).max(19), sourceMessageId: id,
  assignments: z.array(z.strictObject({ companionId: id, goal: z.string().trim().min(1).max(16000) })).max(19).optional(),
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(5) })
  .describe('把当前真人明确授权的多人实际任务登记为有限协作：各受邀者先自主接受，再用自己的独立主脑与实际执行能力完成assignments，等待真实完成结果后返回。普通message只发送聊天，不会授予对方执行权限，也不会等待现实子目标完成。');
const worldDelegates = {
  activity: activityArgumentsSchema, schedule: companionScheduleArgumentsSchema, state: companionStateArgumentsSchema,
  routine: companionRoutineArgumentsSchema, work: companionWorkArgumentsSchema, life_rule: companionLifeArgumentsSchema,
  topic: companionTopicArgumentsSchema,
};
export const companionWorldCapabilitySchema = z.union([companionWorldArgumentsSchema, companionHistoryArgumentsSchema,
  companionCollaborationArgumentsSchema, ...Object.entries(worldDelegates).map(([action, parameters]) => z.strictObject({ action: z.literal(action), parameters }))]);
const memoryDelegates = Object.entries(companionMemoryToolArgumentsSchemas).map(([name, parameters]) => parameters.extend({ action: z.literal(name.slice('memory.'.length)) }));
export const companionMemoryCapabilitySchema = z.union(memoryDelegates as [typeof memoryDelegates[number], typeof memoryDelegates[number], ...typeof memoryDelegates]);
export const companionDshCapabilitySchema = z.union([
  companionDshArgumentsSchema.extend({ operation: z.literal('run') }),
  z.strictObject({ operation: z.literal('record'), query: dshRecordQuerySchema }),
  z.strictObject({ operation: z.literal('capabilities'), query: dshTaskCapabilityQuerySchema }),
  ...Object.entries(companionFileToolArgumentsSchemas).map(([operation, input]) => z.strictObject({ operation: z.literal(operation), parameters: input })),
]);
function parameters(schema: z.ZodType) { const value = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>; delete value.$schema; return { type: 'object', ...value }; }
export const COMPANION_MEMORY_CAPABILITY_TOOL = { name: 'memory',
  description: '同一个伙伴跨入口共享的VCP长期记忆。action=world_query/search/read/record/revise/organize/forget，字段沿用相应操作。world_query category=topics可按query/tags查询本人参加或受邀的话题索引、实际活动语境，topicId可展开本人私态，不能读取别人的角色秘密；话题设定不能当现实知识。search主动回忆原版VCP合法日记，read展开来源；record/revise保存有真实来源和逐字evidence的事实或自己的主观认识。被动高相关召回仍由宿主每次准备；自己的私聊、伙伴交流与独立任务近期消息始终隔离。旧任务不因回忆而恢复授权，忘记只依据本次用户要求。',
  parameters: parameters(companionMemoryCapabilitySchema) } as const;
export const COMPANION_WORLD_CAPABILITY_TOOL = { name: 'world',
  description: COMPANION_WORLD_TOOL.description + '\n统一世界入口还接受action=activity/schedule/state/routine/work/life_rule/topic，parameters填写该领域完整操作对象（含其action）；topic的create/list/read/update/activate/pause/resume/close管理可卸载的话题、游戏与小说，update保存shared公共阶段或本人workingState并附真实sourceMessageIds，主持人可privateRecipientId分发私密设定，读取始终只返回本人私态，不能把角色虚构当现实记忆。history只读取本次调用消息入口的更早原文，以before/limit续读，不读取别的会话或独立任务。collaborate将本次真实用户目标与逐字evidence登记为持久有限协作授权，participantIds为已激活伙伴，assignments可指定各自独立goal；每位受邀者先由自己的主脑自主接受或拒绝，接受后进入自己独立Agent Loop，按原用户限制自行选DSH/记忆/世界能力。返回每人实际结果、拒绝理由和actionIds后你继续核验汇总，不重复再运行伙伴已完成的部分。伙伴来信本身不授电脑权限；仅这份经宿主核验的原用户协作grant授予原目标内权限，不唤醒休眠者，不递归扩张邀请。',
  parameters: parameters(companionWorldCapabilitySchema) } as const;
export const COMPANION_DSH_CAPABILITY_TOOL = { name: 'dsh',
  description: COMPANION_DSH_TOOL.description + '\noperation=run以tasks提交执行目标；operation=record以query渐进核查任务存档；operation=capabilities以query.kind=overview/tool/skill/commands读取当前选中实例的真实能力资料，tool/skill需name，skill正文可textOffset/maxChars续读；operation=read_file/read_image/send_file以parameters只读查看当前允许的资料或交付已有本机文件。这些只读感知和附件交付不是执行session，也不运行或修改文件。所有实际生成、修改、网络或终端行动仍用run。',
  parameters: parameters(companionDshCapabilitySchema) } as const;

/** Dispatch only the three public capability roots to their private domain implementations. */
export function normalizeCompanionCapabilityCall(call: CompanionLoopCall): CompanionLoopCall {
  if (!['world', 'memory', 'dsh'].includes(call.name)) throw new Error('伙伴能力只接受world、memory和dsh三个统一入口。');
  const value: unknown = JSON.parse(call.arguments);
  if (call.name === 'dsh') {
    const parsed = companionDshCapabilitySchema.parse(value);
    if ('tasks' in parsed) return { ...call, arguments: JSON.stringify({ tasks: parsed.tasks }) };
    if ('query' in parsed) return { ...call, name: parsed.operation === 'capabilities' ? 'dsh_capabilities' : 'dsh_record', arguments: JSON.stringify(parsed.query) };
    return { ...call, name: parsed.operation, arguments: JSON.stringify(parsed.parameters) };
  }
  if (call.name === 'memory') {
    const parsed = companionMemoryCapabilitySchema.parse(value), { action, ...args } = parsed;
    return { ...call, name: `memory.${action}`, arguments: JSON.stringify(args) };
  }
  const parsed = companionWorldCapabilitySchema.parse(value);
  if (parsed.action in worldDelegates && 'parameters' in parsed) return { ...call, name: parsed.action, arguments: JSON.stringify(parsed.parameters) };
  if (parsed.action === 'history' || parsed.action === 'collaborate') return { ...call, name: parsed.action, arguments: JSON.stringify(parsed) };
  return call;
}
