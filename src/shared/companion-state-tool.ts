import { z } from 'zod';
import { companionStateProposalSchema } from './companion-state';

export const companionStateToolProposalSchema = companionStateProposalSchema.superRefine((proposal, context) => {
  if (!proposal.appraisals.length && proposal.expression === undefined && proposal.focus === undefined) context.addIssue({ code: 'custom', message: '请提供实际互动评价或状态变化。' });
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
  description: '查看或维护你自己的动态状态。action inspect读取宿主PAD情绪、精力、心情、多维关系、表达倾向、当前关注与真实互动阶段；action update带expectedRevision和proposal。proposal只允许有证据的appraisals、expression、focus，加reason、真实sourceMessageIds与逐字evidence。appraisals每项type为support/respect/boundary_violation/hostility/shared_success/repair/disappointment，target为self/user/task/other，intensity与confidence在0..1。只有实际用户互动才可归因user；普通指令不当支持尊重、真实失败反馈不当敌意、任务失败不扣用户信任、引用虚构或他人言语不算对用户。模型不能设mood、PAD、energy或好感/信任/尊重数值，宿主按事实及限速算法更新。expression gentle/direct/playful/reserved；focus=null清除。稳定人格、权限与固定承诺不变，群内不暴露私人原因。',
  parameters: { type: 'object', ...parameters },
} as const;
