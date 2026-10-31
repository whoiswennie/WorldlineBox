import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CompanionAgendaRun } from '../../shared/companion-agenda';
import type { CompanionJobDisposition } from '../../shared/companion-job-control';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const referenceSchema = z.strictObject({ kind: z.enum(['capture', 'timeline', 'tags', 'growth']), id, stage: z.string().max(1000).optional(),
  inputVersion: z.string().min(1).max(256).optional(), revision: z.number().int().nonnegative().safe().optional() });
type NativeReference = z.output<typeof referenceSchema>;
export interface CompanionAgendaNativeChildResolution {
  kind: NativeReference['kind']; id: string;
  state: CompanionJobDisposition['state'] | 'missing';
  action: 'retained' | 'resumed' | 'parked' | 'abandoned';
  inputVersion?: string; revision?: number;
}
export interface CompanionAgendaNativeRecoveryResult { children: CompanionAgendaNativeChildResolution[]; canResume: boolean }
interface Options { request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> }
const terminal = new Set<CompanionJobDisposition['state']>(['completed', 'cancelled', 'stale', 'abandoned']);

function references(run: CompanionAgendaRun): NativeReference[] {
  if (run.checkpoint === undefined) return [];
  let raw: unknown;
  try { raw = JSON.parse(run.checkpoint); }
  catch { throw new Error('原日程的子阶段凭据不可读取，未猜测或重新创建处理作业。'); }
  const checkpoint = z.object({ nativeJobs: z.array(referenceSchema).max(1024).optional() }).safeParse(raw);
  if (!checkpoint.success) throw new Error('原日程的子阶段凭据无效，未从标题或摘要推断作业身份。');
  return [...new Map((checkpoint.data.nativeJobs ?? []).map(child => [child.kind + ':' + child.id, child])).values()];
}
/** A UUID accepted by the native job ledger, deterministically scoped to the
 * actual parent operation, owner, run, action and immutable native input. */
function operationIdentity(run: CompanionAgendaRun, operationId: string, action: string, child: CompanionJobDisposition): string {
  if (!operationId || operationId.length > 200) throw new Error('日程恢复需要有效的原始操作标识。');
  const bytes = createHash('sha256').update(JSON.stringify(['agenda-native-control-v1', run.companionId, run.id, operationId,
    action, child.kind, child.id, child.inputVersion])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
async function inspect(run: CompanionAgendaRun, options: Options): Promise<Array<{ ref: NativeReference; disposition?: CompanionJobDisposition }>> {
  const results: Array<{ ref: NativeReference; disposition?: CompanionJobDisposition }> = [];
  for (const ref of references(run)) {
    const response = await options.request({ type: 'jobs.inspect', ownerId: run.companionId, kind: ref.kind, id: ref.id });
    if (!response.ok) throw new Error(response.error ?? '原子阶段尚不可核实，未提交恢复。');
    const disposition = response.jobDisposition;
    if (disposition && (disposition.ownerId !== run.companionId || disposition.kind !== ref.kind || disposition.id !== ref.id))
      throw new Error('子阶段回执不属于当前伙伴与原始作业，未继续处置。');
    if (disposition && ref.inputVersion && disposition.inputVersion !== ref.inputVersion)
      throw new Error('原子阶段的准确输入版本已经变化，不能用旧日程控制另一份资料。');
    results.push({ ref, disposition });
  }
  return results;
}
function retained(ref: NativeReference, disposition?: CompanionJobDisposition): CompanionAgendaNativeChildResolution {
  return { kind: ref.kind, id: ref.id, state: disposition?.state ?? 'missing', action: 'retained',
    ...(disposition ? { inputVersion: disposition.inputVersion, revision: disposition.revision } : {}) };
}
async function control(run: CompanionAgendaRun, operationId: string, child: CompanionJobDisposition,
  action: 'resume' | 'park' | 'abandon', options: Options): Promise<CompanionAgendaNativeChildResolution> {
  const response = await options.request({ type: 'jobs.control', ownerId: run.companionId, kind: child.kind, id: child.id,
    inputVersion: child.inputVersion, expectedRevision: child.revision, action, operationId: operationIdentity(run, operationId, action, child) });
  const next = response.jobDisposition, state = action === 'resume' ? 'pending' : action === 'park' ? 'parked' : 'abandoned';
  if (!response.ok || !next || next.ownerId !== child.ownerId || next.kind !== child.kind || next.id !== child.id
    || next.inputVersion !== child.inputVersion || next.revision <= child.revision || next.state !== state
    || next.failureCount !== child.failureCount || next.cycleFailureCount !== (action === 'resume' ? 0 : child.cycleFailureCount))
    throw new Error(response.error ?? '子阶段处置未返回匹配的版本与状态；原始记录没有被替换。');
  return { kind: child.kind as NativeReference['kind'], id: child.id, state: next.state,
    action: action === 'resume' ? 'resumed' : action === 'park' ? 'parked' : 'abandoned', inputVersion: next.inputVersion, revision: next.revision };
}

/** Call before the parent CAS resume. Inspect every exact recorded child first;
 * terminal or withdrawn children block restoration without restarting earlier
 * children. An abandoned native input is never recreated from a goal summary. */
export async function restoreNativeAgendaChildren(run: CompanionAgendaRun, operationId: string, options: Options): Promise<CompanionAgendaNativeRecoveryResult> {
  if (!['parked', 'waiting'].includes(run.status)) throw new Error('只有已暂停或等待中的原执行可以恢复子阶段。');
  const children = await inspect(run, options);
  const canResume = children.every(child => child.disposition && !['cancelled', 'stale', 'abandoned'].includes(child.disposition.state));
  if (!canResume) return { canResume: false, children: children.map(child => retained(child.ref, child.disposition)) };
  const results: CompanionAgendaNativeChildResolution[] = [];
  for (const child of children) results.push(child.disposition!.state === 'parked'
    ? await control(run, operationId, child.disposition!, 'resume', options) : retained(child.ref, child.disposition));
  return { canResume: true, children: results };
}

/** After the parent lease has been fenced, hold/abandon its recorded semantic
 * children before aborting their in-process adapters. A late adapter result
 * cannot overwrite the native held disposition because its token is revoked. */
export async function pauseNativeAgendaChildren(run: CompanionAgendaRun, operationId: string,
  options: Options & { action: 'park' | 'abandon' }): Promise<CompanionAgendaNativeRecoveryResult> {
  const children = await inspect(run, options), results: CompanionAgendaNativeChildResolution[] = [];
  for (const child of children) {
    // Holding a capture leader releases the same lease's other source rows.
    // Read their real new revision rather than rebinding a failed CAS. The
    // immutable input must still be exactly the one preflighted above.
    const latest = await options.request({ type: 'jobs.inspect', ownerId: run.companionId, kind: child.ref.kind, id: child.ref.id });
    if (!latest.ok) throw new Error(latest.error ?? '子阶段的当前版本尚不可读取。');
    const current = latest.jobDisposition;
    if (current && (current.ownerId !== run.companionId || current.kind !== child.ref.kind || current.id !== child.ref.id
      || !child.disposition || current.inputVersion !== child.disposition.inputVersion))
      throw new Error('子阶段的固定输入已经变化，未以新版本替换原来的处理范围。');
    results.push(!current || terminal.has(current.state) || options.action === 'park' && current.state === 'parked'
      ? retained(child.ref, current) : await control(run, operationId, current, options.action, options));
  }
  return { children: results, canResume: results.every(child => child.state !== 'missing' && !['cancelled', 'stale', 'abandoned'].includes(child.state)) };
}
