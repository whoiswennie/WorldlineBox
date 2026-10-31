import { z } from 'zod';
import type { CompanionAgendaClaim } from '../../shared/companion-agenda';
import type { CompanionAgendaExecutionContext, CompanionAgendaExecutionResult } from './agenda-service';
import type { CompanionGrowthService } from './growth-service';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { companionAgendaPersonaGoalDefinitionHash } from './agenda-persona-goals';
import { companionAgendaGoalSchema } from '../../shared/companion-agenda';

const nativeGrowth = z.strictObject({ kind: z.literal('growth'), id: z.string().regex(/^[a-f0-9]{64}$/u), stage: z.string().max(1000),
  inputVersion: z.string().regex(/^[a-f0-9]{64}$/u), revision: z.number().int().nonnegative().safe() });
export const companionAgendaPersonaDirectionInputSchema = z.strictObject({ kind: z.literal('persona-direction-changed-v1'),
  companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), conversationId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u),
  goalId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), definitionHash: z.string().regex(/^[a-f0-9]{64}$/u) });

function directionInput(input: string | undefined) {
  if (!input) return;
  let value: unknown;
  try { value = JSON.parse(input) as unknown; }
  catch { if (input.includes('persona-direction-changed-v1')) throw new Error('人格方向事件的来源端口记录无效，未猜测需要回顾的会话。'); return; }
  if (value && typeof value === 'object' && 'kind' in value && value.kind === 'persona-direction-changed-v1')
    return companionAgendaPersonaDirectionInputSchema.parse(value);
}

export async function executeAgendaGrowth(claim: CompanionAgendaClaim, context: CompanionAgendaExecutionContext, signal: AbortSignal,
  options: { growth?: CompanionGrowthService; request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> }): Promise<CompanionAgendaExecutionResult> {
  if (!options.growth) return { outcome: 'waiting', stage: '等待当前伙伴的正式人格目录可用。', nextCondition: 'persona.available' };
  const direction = directionInput(claim.occurrence.input);
  if (direction) {
    if (direction.companionId !== claim.rule.companionId || direction.companionId !== claim.run.companionId) throw new Error('人格方向事件不属于本次伙伴，未恢复其他主体的来源端口。');
    signal.throwIfAborted();
    const response = await options.request({ type: 'agenda.goal.read', companionId: direction.companionId, id: direction.goalId });
    signal.throwIfAborted();
    if (response.ok && response.agendaGoal) {
      const goal = companionAgendaGoalSchema.parse(response.agendaGoal);
      if (goal.companionId !== direction.companionId || goal.id !== direction.goalId) throw new Error('人格方向读取返回了不匹配的主体或目标。');
      // A stale UI-direction event does not invent a new scope. Independently
      // pending real source debt still gets its ordinary quantum below.
      if (goal.conversationId === direction.conversationId && companionAgendaPersonaGoalDefinitionHash(goal) === direction.definitionHash)
        options.growth.wake({ companionId: direction.companionId, conversationId: direction.conversationId });
    }
  }
  const previous = claim.run.checkpoint ? JSON.parse(claim.run.checkpoint) as { nativeJobs?: unknown } : undefined;
  const nativeJobs = z.array(nativeGrowth).parse(previous?.nativeJobs ?? []);
  const merge = (nativeJob: { kind: 'growth'; id: string; inputVersion: string; revision: number }, stage: string) => {
    const value = nativeGrowth.parse({ ...nativeJob, stage: stage.slice(0, 1000) }), index = nativeJobs.findIndex(item => item.id === value.id);
    if (index < 0) nativeJobs.push(value);
    else {
      if (nativeJobs[index]!.inputVersion !== value.inputVersion || nativeJobs[index]!.revision > value.revision) throw new Error('原人格子阶段的准确输入或处理版本已变化，未覆盖旧来源记录。');
      nativeJobs[index] = value;
    }
  };
  const result = await options.growth.runAgendaQuantum(claim.rule.companionId, signal, async (stage, nativeJob) => {
    if (nativeJob) merge(nativeJob, stage);
    await context.checkpoint(stage, { nativeJobs });
  });
  if (result.nativeJob) merge(result.nativeJob, result.reason);
  const outcome = result.outcome === 'published' ? 'completed' : result.outcome === 'no_change' ? 'silent' : result.outcome;
  const continueInput = result.hasMore && ['silent', 'completed'].includes(outcome);
  return { outcome: continueInput ? 'waiting' : outcome, stage: result.reason.slice(0, 1000),
    ...(outcome === 'failed' ? { error: result.reason.slice(0, 2000) } : {}),
    ...(outcome === 'waiting' || continueInput ? { notBefore: result.retryAt ?? new Date(Date.now() + 1000).toISOString(), nextCondition: 'growth.fixed_source_batch' } : {}),
    result: JSON.stringify({ jobId: result.jobId ?? result.nativeJob?.id, outcome: result.outcome, reason: result.reason, hasMore: result.hasMore, nativeJobCount: nativeJobs.length }) };
}
