import { z } from 'zod';
import { companionStateProposalSchema } from './companion-state';

export const companionStateToolProposalSchema = companionStateProposalSchema.superRefine((proposal, context) => {
  if (!proposal.experience && !proposal.relationshipUpdates.length && proposal.expression === undefined && proposal.focus === undefined) context.addIssue({ code: 'custom', message: '请提供有来源的当前体验、具体关系经历或表达关注变化。' });
  if (new Set(proposal.sourceMessageIds).size !== proposal.sourceMessageIds.length) context.addIssue({ code: 'custom', path: ['sourceMessageIds'], message: '状态来源不能重复。' });
  if (proposal.sourceMessageIds.some(id => !proposal.evidence.some(evidence => evidence.sourceMessageId === id))) context.addIssue({ code: 'custom', path: ['evidence'], message: '每个状态来源需要原文证据。' });
  if (proposal.evidence.some(evidence => !proposal.sourceMessageIds.includes(evidence.sourceMessageId))) context.addIssue({ code: 'custom', path: ['evidence'], message: '状态引用须属于来源消息。' });
});
export const companionStateArgumentsSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('inspect') }),
  z.strictObject({ action: z.literal('update'), expectedRevision: z.number().int().positive(), proposal: companionStateToolProposalSchema }),
]);
export type CompanionStateArguments = z.output<typeof companionStateArgumentsSchema>;
const parameters = z.toJSONSchema(companionStateArgumentsSchema, { io: 'input' }) as Record<string, unknown>;
delete parameters.$schema;
export const COMPANION_STATE_TOOL = {
  name: 'state',
  description: '查看或维护你自己的有来源定性状态。action inspect读取实际精力、本人当前体验experience、具体关系经历relationshipRecords、表达方式与当前关注；action update携带expectedRevision和proposal。proposal允许experience、relationshipUpdates、expression、focus，并提供reason、当前入口正式sourceMessageIds与逐字evidence。experience描述当下处境、触及目标、本人表达、关注、不确定性、回应偏好及reassessWhen复核条件，不是测量心理。relationshipUpdates逐条说明targetId、topic、context、kind、statement及reassessWhen，只表达特定对象事项场景下的约定、经历、分歧、修复、边界或期待；修订时replacesRecordIds只能引用同范围的已有记录。普通指令、礼貌、消息次数、任务成败不自动成为关系或成熟度；他人观点与教材不自动成为本人信念。禁止提交心理评分或熟悉阶段。expression gentle/direct/playful/reserved；focus=null清除。当前体验不直接改永久人格，本人认识需独立整合验证并发布后才生效；不改变权限及固定承诺，群内不暴露私人原因。',
  parameters: { type: 'object', ...parameters },
} as const;
