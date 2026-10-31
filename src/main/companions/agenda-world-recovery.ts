import { createHash } from 'node:crypto';
import type { CompanionAgendaRun } from '../../shared/companion-agenda';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionAgendaWorldNativeJob } from './world-service';

type Request = (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>;
export interface CompanionAgendaWorldRecovery { handled: boolean; canResume: boolean; reason: string; nativeJob?: CompanionAgendaWorldNativeJob }
type Actual = { status: string; uncertain: boolean; nativeJob: Required<Pick<CompanionAgendaWorldNativeJob, 'kind' | 'id' | 'inputVersion' | 'revision'>> };
function checkpoint(run: CompanionAgendaRun): CompanionAgendaWorldNativeJob | undefined {
  let saved: { nativeJob?: unknown } | undefined;
  try { saved = run.checkpoint ? JSON.parse(run.checkpoint) as { nativeJob?: unknown } : undefined; } catch { throw new Error('世界行为检查点格式无效，未猜测处置对象。'); }
  const value = saved?.nativeJob;
  if (!value || typeof value !== 'object') return;
  const native = value as CompanionAgendaWorldNativeJob;
  if (!['world', 'social', 'notification'].includes(native.kind)) return;
  if (typeof native.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(native.id) || typeof native.inputVersion !== 'string' || !/^[a-f0-9]{64}$/u.test(native.inputVersion)
    || !Number.isSafeInteger(native.revision) || native.revision! < 0) throw new Error('世界行为检查点缺少准确输入版本，未猜测处置对象。');
  return native;
}
async function read(run: CompanionAgendaRun, native: CompanionAgendaWorldNativeJob, request: Request): Promise<Actual> {
  const scope = { companionId: run.companionId, id: native.id };
  const response = await request(native.kind === 'world' ? { type: 'world.job.read', ...scope } : native.kind === 'social'
    ? { type: 'social.job.read', ...scope } : { type: 'social.notification.read', ...scope });
  if (!response.ok) throw new Error(response.error ?? '真实世界行为尚未核验，未处置。');
  const item = native.kind === 'world' ? response.worldJob : native.kind === 'social' ? response.socialJob : response.socialNotification;
  if (!item || item.id !== native.id || item.companionId !== run.companionId || item.agendaParentRunId !== run.id) throw new Error('真实世界行为已不可访问或已经属于另一项日程，不能恢复其他事件。');
  const version = 'agendaInputVersion' in item ? item.agendaInputVersion : response.worldJob?.disposition?.inputVersion;
  const revision = 'agendaRevision' in item ? item.agendaRevision : response.worldJob?.disposition?.revision;
  if (typeof version !== 'string' || version !== native.inputVersion || revision === undefined || !Number.isSafeInteger(revision)) throw new Error('世界行为原始输入已变化，旧日程不能改写或恢复。');
  return { status: item.status, uncertain: item.agendaUncertain === true, nativeJob: { kind: native.kind, id: native.id, inputVersion: version, revision } };
}
async function control(run: CompanionAgendaRun, actual: Actual, action: 'park' | 'resume' | 'abandon', request: Request): Promise<void> {
  const native = actual.nativeJob;
  const digest = createHash('sha256').update(JSON.stringify([run.id, run.revision, native, action])).digest('hex');
  const operationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const fields = { id: native.id, inputVersion: native.inputVersion, expectedRevision: native.revision, operationId, action };
  const result = await request(native.kind === 'world' ? { type: 'jobs.control', ownerId: run.companionId, kind: 'world', ...fields }
    : native.kind === 'social' ? { type: 'social.job.control', companionId: run.companionId, ...fields } : { type: 'social.notification.control', companionId: run.companionId, ...fields });
  if (!result.ok) throw new Error(result.error ?? '准确世界行为的处置尚未完成。');
}

export async function controlCompanionAgendaWorld(run: CompanionAgendaRun, action: 'park' | 'abandon', options: { request: Request }): Promise<CompanionAgendaWorldRecovery> {
  const native = checkpoint(run); if (!native) return { handled: false, canResume: true, reason: '本次日程没有世界子行为。' };
  const actual = await read(run, native, options.request);
  if (['done', 'cancelled', 'stale', 'abandoned'].includes(actual.status)) return { handled: true, canResume: false, reason: '原世界行为已经终结，保留实际结果与记录。', nativeJob: actual.nativeJob };
  if (actual.status !== 'parked' || action === 'abandon') await control(run, actual, action, options.request);
  return { handled: true, canResume: !actual.uncertain && action === 'park', reason: action === 'abandon' ? '原始世界事件与处置依据保留，已经放弃继续处理。' : '原始世界事件已经搁置，等待明确恢复。', nativeJob: actual.nativeJob };
}
export async function restoreCompanionAgendaWorld(run: CompanionAgendaRun, options: { request: Request }): Promise<CompanionAgendaWorldRecovery> {
  const native = checkpoint(run); if (!native) return { handled: false, canResume: true, reason: '本次日程没有世界子行为。' };
  const actual = await read(run, native, options.request);
  if (actual.uncertain || !['parked', 'pending', 'failed'].includes(actual.status)) return { handled: true, canResume: false,
    reason: actual.uncertain ? '原世界行为的实际结果尚未确认，需要先明确核验，不能自动重复。' : '原世界行为已经终结或仍在处理，不能重放。', nativeJob: actual.nativeJob };
  if (actual.status === 'parked') await control(run, actual, 'resume', options.request);
  return { handled: true, canResume: true, reason: '已经恢复相同输入的原世界行为，没有创建第二份事件。', nativeJob: actual.nativeJob };
}
