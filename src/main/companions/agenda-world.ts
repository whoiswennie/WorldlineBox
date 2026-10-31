import type { CompanionAgendaClaim } from '../../shared/companion-agenda';
import type { CompanionAgendaExecutionContext, CompanionAgendaExecutionResult } from './agenda-service';
import type { CompanionAgendaWorldLane, CompanionWorldService } from './world-service';

/** The physical heartbeat never owns semantic admission. One visible agenda
 * run consumes one real native event and preserves its original source gates. */
export async function executeAgendaWorld(claim: CompanionAgendaClaim, context: CompanionAgendaExecutionContext, signal: AbortSignal,
  options: { world: Pick<CompanionWorldService, 'runAgendaQuantum'>; lane?: CompanionAgendaWorldLane }): Promise<CompanionAgendaExecutionResult> {
  let saved: { nativeJob?: { kind?: string; id?: string; inputVersion?: string; revision?: number; lane?: CompanionAgendaWorldLane } } | undefined;
  try { saved = claim.run.checkpoint ? JSON.parse(claim.run.checkpoint) as typeof saved : undefined; } catch { throw new Error('原始世界行为检查点无效，未认领其他事件。'); }
  const previous = saved?.nativeJob;
  const resume = previous && ['world', 'social', 'notification'].includes(previous.kind ?? '') && typeof previous.id === 'string'
    && /^[a-zA-Z0-9_-]{1,100}$/u.test(previous.id) && typeof previous.inputVersion === 'string' && /^[a-f0-9]{64}$/u.test(previous.inputVersion) ? previous : undefined;
  const lane = resume ? resume.kind === 'social' ? 'social' : resume.kind === 'notification' ? 'notification' : resume.lane === 'dream' ? 'dream' : 'decision' : options.lane;
  const result = await options.world.runAgendaQuantum({ companionId: claim.rule.companionId, agendaRunId: claim.run.id, agendaLeaseToken: claim.leaseToken,
    ...(lane ? { lane } : {}), ...(resume ? { referenceId: resume.id, nativeInputVersion: resume.inputVersion }
      : claim.rule.referenceVersion === 'world-native-v1' && claim.rule.referenceId ? { referenceId: claim.rule.referenceId } : {}) }, signal,
  (stage, nativeJob) => context.checkpoint(stage, { ...(nativeJob || resume ? { nativeJob: nativeJob ?? resume } : {}), lane: nativeJob?.lane ?? lane ?? 'world', agendaRunId: claim.run.id }));
  const retryAt = result.outcome === 'waiting' && result.reason === '等待该伙伴正在进行的世界行为完成。' && result.retryAt
    ? new Date(Math.max(Date.parse(result.retryAt), Date.parse(claim.run.notBefore))).toISOString() : result.retryAt;
  return { outcome: result.outcome === 'complete' ? 'completed' : result.outcome === 'no_change' ? 'silent' : result.outcome,
    stage: result.reason.slice(0, 1000), result: JSON.stringify({ nativeJob: result.nativeJob, messageId: result.messageId, reason: result.reason }),
    ...(result.outcome === 'waiting' ? { nextCondition: result.reason.slice(0, 1000), ...(retryAt ? { notBefore: retryAt } : {}) } : {}),
    ...(result.outcome === 'failed' ? { error: result.reason } : {}) };
}
