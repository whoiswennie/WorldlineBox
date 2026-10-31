import { z } from 'zod';
import { companionProviderToolParameters } from './companion-tool-json-schema';
import { companionAgendaCategorySchema, companionAgendaRuleDraftSchema, companionAgendaGoalDraftSchema, companionAgendaPublicCommandSchema, companionAgendaTaskResponseSchema,
  type CompanionAgendaPublicCommand } from './companion-agenda';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const target = { id, expectedRevision: z.number().int().positive().safe() };
/** A model can arrange its own life; only the host binds identity, provenance,
 * and an operation receipt. Grant issuance is deliberately not a model tool. */
export const companionAgendaToolArgumentsSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read'), from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
    afterId: id.optional(), limit: z.number().int().min(1).max(100).default(30), category: companionAgendaCategorySchema.optional(), compactRecurring: z.boolean().optional() }),
  z.strictObject({ action: z.literal('tasks.read'), afterId: id.optional(), limit: z.number().int().min(1).max(100).default(30),
    executionStatus: z.enum(['active', 'ended', 'all']).default('active') }),
  z.strictObject({ action: z.literal('event.read'), id }),
  z.strictObject({ action: z.literal('rule.create'), rule: companionAgendaRuleDraftSchema }),
  z.strictObject({ action: z.literal('rule.update'), ...target, rule: companionAgendaRuleDraftSchema }),
  z.strictObject({ action: z.literal('rule.control'), ...target, transition: z.enum(['pause', 'resume', 'retire']), taskResponse: companionAgendaTaskResponseSchema.optional() }),
  z.strictObject({ action: z.literal('goals.read'), afterId: id.optional(), limit: z.number().int().min(1).max(100).default(30) }),
  z.strictObject({ action: z.literal('goal.create'), goal: companionAgendaGoalDraftSchema }),
  z.strictObject({ action: z.literal('goal.update'), ...target, goal: companionAgendaGoalDraftSchema, progress: z.string().max(6000).optional() }),
  z.strictObject({ action: z.literal('goal.control'), ...target, transition: z.enum(['pause', 'resume', 'retire', 'complete']), evidence: z.string().trim().min(1).max(6000).optional(),
    taskResponse: companionAgendaTaskResponseSchema.optional() }),
  z.strictObject({ action: z.literal('grants.read') }),
]);
export type CompanionAgendaToolArguments = z.output<typeof companionAgendaToolArgumentsSchema>;
const parameters = companionProviderToolParameters(z.toJSONSchema(companionAgendaToolArgumentsSchema, { io: 'input' }));
export const COMPANION_AGENDA_TOOL = { name: 'agenda', parameters,
  description: '管理自己的任务、持续目标和日程。tasks.read读取本人的真实任务：scheduled是安排规则，longterm是持续方向，execution是已经实际登记的DSH执行（沿用原actionId/status，不是第二项任务）。executionStatus默认active显示待执行、进行中、可处理的失败或中断；ended查询完成或取消的执行，all查询全部，按agendaNextId翻页，不把当前页当作全部任务。execution.waitingApproval=true表示等待真人确认执行权限，不是假装仍在处理；读取回执并说明具体阻碍。DSH工作创建和状态变化直接反映在这里，无需再创建一条重复日程；read读取日程执行投影，可用category=daily/task/event筛选：daily是普通交流、作息与基础回看，task是明确安排的具体任务，event是宿主维护，compactRecurring=true收起重复例行记录；event.read按规则id展开实际过程。系统EVENT是宿主职责，主脑不能关闭或改写。TASK可按实际人格和意愿接受、协商或拒绝：rule.control提交taskResponse:{decision:accept/negotiate/decline,message:具体理由或替代方案}，分别配transition=resume/pause/retire；不能改写他人委托的原始正文与期限。goals.read读取知识、方法、人格培养和持续项目，goal.create/update/control维护方向及真实进展。rule.create/update安排本人未来行为，kind与executor按实际能力选择，trigger支持at/interval/window/event；用户要求一分钟后提醒应创建executor=reminder、trigger.kind=at的真实规则，收到ok和id前不能声称已设闹钟。at/interval的probability默认1；概率每个机会只抽一次，不能通过刷新或重复改规则重新抽签。修改带已读取的expectedRevision。自主安排必须flexible=true，可以依据自己的实际兴趣和已有方向调整；用户固定约定不擅改。权限由宿主绑定，grants.read只查看实际持续范围，不能给自己签发观察、文件、网络或电脑权限。goal的successCriteria是待验证标准，不是已经达到；完成申请需实际evidence，不把计划、模拟动作或模型自测说成掌握。origin、category、classification、身份、来源、执行次数和完成时间均由宿主管理，不能通过正文冒充。每次只读本目标需要的页面，不全量展开历史。' } as const;

export function companionAgendaToolCommand(input: CompanionAgendaToolArguments, companionId: string, operationId: string): CompanionAgendaPublicCommand {
  const { action, ...parameters } = input;
  const read = ['read', 'tasks.read', 'event.read', 'goals.read', 'grants.read'].includes(action);
  const transition = 'transition' in parameters ? parameters.transition : undefined;
  const remaining = { ...parameters } as Record<string, unknown>;
  delete remaining.transition;
  return companionAgendaPublicCommandSchema.parse({ type: 'agenda.' + action, companionId, ...remaining,
    ...(!read ? { operationId } : {}), ...(transition ? { action: transition } : {}) });
}
