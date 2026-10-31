import { z } from 'zod';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionMemory, CompanionMessage } from '../../shared/companions';
import type { CompanionGrowthGoal } from '../../shared/companion-cognition';
import { COMPANION_JOB_FAILURES_PER_CYCLE, companionJobControlCommandSchema, companionJobDispositionSchema, companionJobPageCommandSchema,
  type CompanionJobControlCommand, type CompanionJobDisposition, type CompanionJobPageCommand, type CompanionJobPage } from '../../shared/companion-job-control';
import { companionCharacterDevelopmentDraftSchema } from '../../shared/companion-character-development';
import { companionHostBehaviorMatches, companionSourceSupportsOwnBehavior } from '../../shared/companion-host-behavior';
import type { CompanionArtifact, CompanionArtifactReference } from '../../shared/companion-artifact';
import { CompanionArtifactError, companionArtifactHash, type CompanionArtifactRegistry, type CompanionArtifactPublish } from './artifact-registry';
import { renderCompanionAssetProfile, type CompanionAssetProfileStore, type CompanionAssetProfileSnapshot, type CompanionPersonaPublication } from './asset-profile';
import { companionPersonaFragmentSchema, companionPersonaFragmentVisible, type CompanionPersonaFragment } from './persona-fragments';
import { generateCompanionStructured, companionModelAdmissionRetryAfter, CompanionModelError, type CompanionModelConfig } from './model';
import { readCompanionAgendaPersonaDirections, validateCompanionAgendaPersonaDirections } from './agenda-persona-goals';

type RequestStorage = (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>;
const hash = companionArtifactHash;
const ownBehavior = (owner: string, source: CompanionMessage) => companionSourceSupportsOwnBehavior(owner, { ...source, checksum: hash(source.content) });
const intersectAudiences = (sets: readonly string[][]): string[] => sets.length ? [...new Set(sets[0])].filter(id => sets.every(set => set.includes(id))).sort() : [];
const sourceAudiences = (owner: string, source: CompanionMessage) => companionHostBehaviorMatches(owner, { ...source, checksum: hash(source.content) })?.audienceIds ?? [source.conversationId];
const noteSourceAudiences = (owner: string, source: CompanionMemory['sources'][number]) => companionHostBehaviorMatches(owner,
  { ...source, id: source.messageId })?.audienceIds ?? [source.conversationId];
const ref = (artifact: CompanionArtifact): CompanionArtifactReference => ({ artifactId: artifact.artifactId, contentRevision: artifact.contentRevision, contentHash: artifact.contentHash });
export const companionGrowthSourceArtifactId = (messageId: string, revision: number): string => `source:${messageId}:r${revision}`;
const sourceIdentity = (artifactId: string): { id: string; revision: number } => {
  const match = /^source:([a-zA-Z0-9_-]{1,100}):r([1-9][0-9]*)$/u.exec(artifactId);
  if (!match) throw new Error('人格来源必须是宿主登记的准确原始消息版本。');
  return { id: match[1]!, revision: Number(match[2]) };
};
const uniqueRefs = (references: CompanionArtifactReference[]) => [...new Map(references.map(value => [`${value.artifactId}:${value.contentRevision}:${value.contentHash}`, value])).values()];
export const companionGrowthGoalRevision = (goals: CompanionGrowthGoal[]): string => hash(JSON.stringify(goals.map(goal => [goal.id, goal.revision, goal.status, goal.sources]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))));
export const companionPersonaPolicyRevision = (snapshot: CompanionAssetProfileSnapshot): string => hash(JSON.stringify([snapshot.promptRevision, snapshot.memoryPolicyRevision]));

/** Mechanism validation only; it cannot certify that generated beliefs are
 * human beliefs or that a qualitative change is semantically well founded. */
export async function validateCompanionPersonaPublication(proposal: CompanionPersonaPublication, options: {
  requestStorage: RequestStorage; profiles: CompanionAssetProfileStore; isStopped?(ownerId: string): boolean;
}): Promise<void> {
  if (options.isStopped?.(proposal.companionId)) throw new Error('人格发布已被停止。');
  const registry = await options.profiles.artifacts(proposal.companionId), artifacts = await registry.getMany(['persona:current', 'host:prompts', 'host:policy',
    ...proposal.sourceReadset.map(reference => reference.artifactId), ...proposal.dependencyVersions.map(reference => reference.artifactId),
    ...proposal.fragments.flatMap(fragment => fragment.sourceRefs.map(reference => reference.artifactId))]);
  const current = artifacts.find(artifact => artifact.artifactId === 'persona:current');
  if (!current || current.contentHash !== proposal.expectedRevision) throw new Error('人格基线已变化，旧提议需要重新评估。');
  const lifecycle = await options.requestStorage({ type: 'memory.lifecycle.state', companionId: proposal.companionId });
  if (!lifecycle.ok || lifecycle.memoryLifecycleState?.revocationEpoch !== proposal.revocationEpoch) throw new Error('来源撤销版本已变化。');
  const goalConversationId = proposal.goalConversationId ?? proposal.conversationId;
  if (goalConversationId !== proposal.conversationId && proposal.conversationId !== `world_${proposal.companionId}`) throw new Error('只有伙伴内部反思可使用其实际来源域的培养方向。');
  const goals = proposal.agendaGoalReadset !== undefined ? { ok: true, growthGoals: [] as CompanionGrowthGoal[] }
    : await options.requestStorage({ type: 'growth.goals.list', companionId: proposal.companionId, conversationId: goalConversationId, limit: 40 });
  if (proposal.agendaGoalReadset !== undefined) await validateCompanionAgendaPersonaDirections(proposal.companionId, goalConversationId, proposal.agendaGoalReadset, proposal.goalRevision, options.requestStorage);
  else if (!goals.ok || companionGrowthGoalRevision(goals.growthGoals ?? []) !== proposal.goalRevision) throw new Error('培养目标已修改、暂停或撤回。');
  const manifest = artifacts.find(artifact => artifact.relativePath === '提示词/manifest.json'), policy = artifacts.find(artifact => artifact.relativePath === '认知策略.json');
  if (!manifest || !policy) throw new Error('当前提示或认知策略缺失。');
  const plan = JSON.parse((await registry.read({ artifactId: manifest.artifactId, consumer: 'host' })).text) as { common: string[]; purposes: Record<string, string[]> };
  const files = [...new Set([...plan.common, ...Object.values(plan.purposes).flat()])];
  const moduleVersions = [];
  for (const file of files) { const found = await registry.findByPath(file); if (!found) throw new Error('提示模块未登记。'); moduleVersions.push([file, found.contentHash]); }
  const promptRevision = hash(JSON.stringify([manifest.contentHash, moduleVersions]));
  if (hash(JSON.stringify([promptRevision, policy.contentHash])) !== proposal.promptPolicyRevision) throw new Error('提示用途或认知策略已变化。');
  const sourceIds = proposal.sourceReadset.map(value => sourceIdentity(value.artifactId));
  if (!sourceIds.length || sourceIds.length > 24) throw new Error('人格来源读集大小无效。');
  const sources = await options.requestStorage({ type: 'memory.sources.filter', companionId: proposal.companionId, conversationId: proposal.conversationId, ids: sourceIds.map(value => value.id) });
  if (!sources.ok) throw new Error(sources.error ?? '人格来源核验失败。');
  for (const reference of proposal.sourceReadset) {
    const identity = sourceIdentity(reference.artifactId), message = sources.memorySources?.find(value => value.id === identity.id);
    const artifact = artifacts.find(value => value.artifactId === reference.artifactId);
    if (!message || message.revision !== identity.revision || hash(message.content) !== reference.contentHash
      || artifact?.kind !== 'source_evidence' || artifact.contentRevision !== reference.contentRevision || artifact.contentHash !== reference.contentHash)
      throw new Error('人格依据的作者、来源权限或准确版本已失效。');
    await registry.read({ artifactId: artifact.artifactId, consumer: 'source_verification', audienceIds: [message.conversationId] });
  }
  if (proposal.noteReadset.length) {
    const notes = await options.requestStorage({ type: 'memory.records.filter', companionId: proposal.companionId, conversationId: proposal.conversationId, ids: proposal.noteReadset.map(value => value.id) });
    if (!notes.ok) throw new Error(notes.error ?? '本人认识核验失败。');
    if (goalConversationId !== proposal.conversationId && (!notes.memories?.length
      || notes.memories.some(note => !note.sources.length || note.sources.some(source => !noteSourceAudiences(proposal.companionId, source).includes(goalConversationId)))))
      throw new Error('背景培养方向必须来自本批本人认识的同一真实来源域。');
    for (const read of proposal.noteReadset) {
      const note = notes.memories?.find(value => value.id === read.id);
      if (!note || note.version !== read.version || (note.contentRevision ?? note.version) !== read.contentRevision || hash(note.content) !== read.contentHash
        || note.status === 'forgotten' || note.status === 'invalid' || note.archivedAt) throw new Error('本人认识正文版本已变化或退出当前。');
    }
    if (proposal.semanticChanges.length) {
      const goalSources = new Set((goals.growthGoals ?? []).filter(goal => ['proposed', 'practicing', 'reconsidering'].includes(goal.status))
        .flatMap(goal => goal.sources.map(source => source.messageId)));
      if (!notes.memories?.some(note => note.artifactKind === 'self_understanding'
        && companionCharacterDevelopmentDraftSchema.safeParse(note.metadata?.characterDevelopment).success
        && companionCharacterDevelopmentDraftSchema.parse(note.metadata?.characterDevelopment).kind !== 'goal' && note.sources.some(reference => !goalSources.has(reference.messageId)
        && sources.memorySources?.some(source => source.id === reference.messageId && ownBehavior(proposal.companionId, source)))))
        throw new Error('培养目标或其复述不能独立证明人格变化。');
    }
  }
  else if (proposal.semanticChanges.length) throw new Error('人格变化需要目标之外的本人认识与实际依据。');
  for (const dependency of proposal.dependencyVersions) {
    const artifact = artifacts.find(value => value.artifactId === dependency.artifactId);
    if (!artifact || artifact.contentHash !== dependency.contentHash || artifact.contentRevision !== dependency.contentRevision) throw new Error('人格依赖版本已变化。');
  }
  if (!proposal.fragments.length) throw new Error('人格片段来源闭包无效。');
  for (const source of uniqueRefs(proposal.fragments.flatMap(value => value.sourceRefs))) {
    const artifact = artifacts.find(value => value.artifactId === source.artifactId);
    if (!artifact || artifact.kind !== 'source_evidence' || artifact.contentHash !== source.contentHash || artifact.contentRevision !== source.contentRevision)
      throw new Error('保留的人格片段来源已经撤回或变化。');
  }
  if (options.isStopped?.(proposal.companionId)) throw new Error('人格发布已被停止。');
}

const decisionSchema = z.strictObject({ action: z.enum(['keep', 'qualify', 'revise', 'retire', 'defer']),
  fragmentId: z.string().max(160).nullable(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  text: z.string().max(2000), supportingNoteIds: z.array(z.string().min(1).max(100)).max(6),
  reason: z.string().trim().min(1).max(800), applicableBehavior: z.string().max(500), reevaluateWhen: z.string().max(500) });
const outputSchema = z.strictObject({ decisions: z.array(decisionSchema).max(4), noChangeReason: z.string().max(1200) });
type GrowthOutput = z.infer<typeof outputSchema>;
type Candidate = { note: CompanionMemory; artifact: CompanionArtifact; sourceRefs: CompanionArtifactReference[] };
const checkpointSchema = z.strictObject({ schema: z.literal('worldlinebox.companion-growth-checkpoint-v2'), companionId: z.string(), conversationId: z.string(),
  key: z.string().regex(/^[a-f0-9]{64}$/u), attempt: z.number().int().positive(), state: z.enum(['fixed', 'generating', 'generated', 'published', 'no_change', 'deferred', 'stale', 'interrupted', 'failed']),
  profileRevision: z.string(), policyRevision: z.string(), goalRevision: z.string(), revocationEpoch: z.number().int().nonnegative(),
  agendaGoalReadset: z.array(z.strictObject({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), definitionHash: z.string().regex(/^[a-f0-9]{64}$/u) })).optional(),
  sourceReadset: z.array(z.object({ artifactId: z.string(), contentRevision: z.number().int().positive(), contentHash: z.string() })).max(24),
  sourceAudiences: z.array(z.string().min(1)).max(24),
  noteReadset: z.array(z.object({ id: z.string(), version: z.number().int().positive(), contentRevision: z.number().int().positive(), contentHash: z.string() })).max(6),
  coverage: z.array(z.string()).max(24), output: outputSchema.optional(), proposal: z.unknown().optional(),
  disposition: companionJobDispositionSchema,
  input: z.strictObject({ system: z.string().max(56000), user: z.string().max(56000) }).optional(),
  inputGeneration: z.number().int().positive().optional(), inputNextCursor: z.string().optional(), retryAt: z.iso.datetime().optional(), goalConversationId: z.string().optional(),
  createdAt: z.string(), updatedAt: z.string(), reason: z.string().max(2000) });
type Checkpoint = z.infer<typeof checkpointSchema>;
export type CompanionGrowthResult = { status: 'no_input' | Checkpoint['state']; companionId: string; conversationId: string; jobId?: string; reason: string; retryAt?: string };
export type CompanionGrowthNativeJob = { kind: 'growth'; id: string; inputVersion: string; revision: number };
type GrowthAgendaProgress = (stage: string, nativeJob?: CompanionGrowthNativeJob) => void | Promise<void>;
export interface CompanionAgendaGrowthQuantumResult {
  outcome: 'published' | 'no_change' | 'waiting' | 'parked' | 'abandoned' | 'unknown' | 'failed' | 'cancelled';
  companionId: string; conversationId?: string; jobId?: string; reason: string; retryAt?: string; hasMore: boolean;
  nativeJob?: CompanionGrowthNativeJob;
}
export interface CompanionGrowthServiceOptions {
  requestStorage: RequestStorage; getConfig(ownerId: string): Promise<CompanionModelConfig> | CompanionModelConfig;
  profiles: CompanionAssetProfileStore; report(error: unknown): void;
  generateStructured?: typeof generateCompanionStructured;
}

/** Independent source batches keep their fixed input and cumulative failures.
 * Paid generated results resume without generating again; unknown sends and
 * exhausted failure cycles require an exact explicit user control. */
export class CompanionGrowthService {
  private readonly active = new Map<string, { conversationId: string; jobId?: string; controller: AbortController; promise: Promise<CompanionGrowthResult> }>();
  private readonly pending = new Map<string, { companionId: string; conversationId: string; retryAt?: string }>();
  private agendaWakeOwner?: (scope: { companionId: string; conversationId?: string }) => void;
  private readonly agendaCursors = new Map<string, { companionId: string; conversationId: string }>();
  private readonly agendaRunning = new Set<string>();
  private readonly reviewed = new Map<string, { generation: number; nextCursor?: string }>();
  private readonly recoveries = new Map<string, Promise<{ queued: number; interrupted: number }>>();
  private readonly hostJobs = new Map<string, Set<Promise<unknown>>>();
  private readonly retryPreparations = new Map<string, { jobId: string; promise: Promise<void> }>();
  private timer?: ReturnType<typeof setTimeout>; private scanPromise?: Promise<void>; private started = false;
  private scanCursor?: { companionId: string; conversationId: string };
  private readonly stopped = new Set<string>(); private readonly retiring = new Set<string>(); private disposed = false;
  constructor(private readonly options: CompanionGrowthServiceOptions) {}
  isStopped(ownerId: string): boolean { return this.disposed || this.stopped.has(ownerId) || this.retiring.has(ownerId); }
  start(): void { if (this.disposed || this.started || this.agendaWakeOwner) return; this.started = true; this.pump(); this.scheduleScan(0); }
  /** Switch semantic scheduling to the agenda while retaining exact dirty
   * conversation scopes and the original publication/checkpoint processor. */
  setAgendaDriven(wakeOwner: (scope: { companionId: string; conversationId?: string }) => void): void {
    this.agendaWakeOwner = wakeOwner;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    for (const scope of this.pending.values()) this.notifyAgenda(scope);
  }
  private notifyAgenda(scope: { companionId: string; conversationId?: string }): void {
    try { this.agendaWakeOwner?.(scope); } catch (error) { this.options.report(error); }
  }
  private scheduleScan(delay = 60000): void {
    if (!this.started || this.disposed || this.timer || this.agendaWakeOwner) return;
    this.timer = setTimeout(() => { this.timer = undefined;
      const task = this.scan().catch(this.options.report).finally(() => { this.scanPromise = undefined; this.scheduleScan(); });
      this.scanPromise = task;
    }, delay); this.timer.unref();
  }
  private async scan(): Promise<void> {
    if (this.agendaWakeOwner || this.disposed) return;
    const page = (await this.request({ type: 'character.development.scopes.page', limit: 16,
      ...(this.scanCursor ? { afterCompanionId: this.scanCursor.companionId, afterConversationId: this.scanCursor.conversationId } : {}) })).characterDevelopmentScopes;
    if (this.disposed) return;
    this.scanCursor = page?.hasMore ? page.nextCursor : undefined;
    for (const scope of page?.items ?? []) if (!this.isStopped(scope.companionId)) this.wake(scope);
  }
  recoverOwner(ownerId: string): Promise<{ queued: number; interrupted: number }> {
    const existing = this.recoveries.get(ownerId); if (existing) return existing;
    const operation = this.recover(ownerId).finally(() => { this.recoveries.delete(ownerId); }); this.recoveries.set(ownerId, operation); return operation;
  }
  /** Startup fence: only replay a saved, already paid exact persona proposal.
   * This path never fixes a new input batch or calls a model. */
  resumePreparedPublications(ownerId: string): Promise<{ resumed: number }> {
    return this.trackHost(ownerId, async () => {
      if (this.isStopped(ownerId)) return { resumed: 0 };
      const registry = await this.options.profiles.artifacts(ownerId); let resumed = 0;
      await this.recoverControls(registry);
      // Find the exact current-persona writer before its checkpoint. A state
      // page can be displaced by unrelated fixed inputs becoming stale while
      // this pending writer correctly keeps their profile reads fenced.
      const current = await registry.get('persona:current', true);
      if (!current) return { resumed };
      const pending = await registry.pendingPublications({ artifactId: current.artifactId, baseRevision: current.contentRevision, previousTarget: true, limit: 2 });
      if (pending.length > 1) throw new Error('当前人格存在多个冲突待提交写入，未猜测恢复对象。');
      for (const publication of pending) {
        if (this.isStopped(ownerId)) throw new Error('启动恢复时伙伴已停止。');
        const target = publication.items.find(item => item.next.artifactId === current.artifactId && item.next.kind === 'persona_current');
        if (publication.ownerId !== ownerId || target?.previous?.artifactId !== current.artifactId
          || target.previous.contentRevision !== current.contentRevision || target.previous.contentHash !== current.contentHash)
          throw new Error('启动恢复写入不匹配当前人格的准确基线。');
        const job = target.next.producer.kind === 'system' && /^growth:([a-f0-9]{48})$/u.exec(target.next.producer.id);
        if (!job) continue; // Privacy retraction is recovered by its own host path.
        const page = await registry.page({ consumer: 'host', kind: 'runtime_index', prefix: `growth-checkpoint:${job[1]}`, limit: 2 });
        if (page.hasMore || page.items.length !== 1) throw new Error('待提交人格缺少唯一准确作业检查点，未猜测恢复对象。');
        const artifact = page.items[0]!;
        const checkpoint = checkpointSchema.parse(JSON.parse((await registry.read({ artifactId: artifact.artifactId, consumer: 'host' })).text));
        if (artifact.artifactId !== `growth-checkpoint:${checkpoint.key}` || checkpoint.companionId !== ownerId
          || checkpoint.disposition.ownerId !== ownerId || checkpoint.disposition.id !== checkpoint.key || checkpoint.disposition.kind !== 'growth')
          throw new Error('启动恢复作业归属或检查点身份不一致。');
        if (!['generated', 'stale'].includes(checkpoint.state) || ['parked', 'abandoned'].includes(checkpoint.disposition.state) || !checkpoint.output || !checkpoint.proposal) continue;
        const proposal = checkpoint.proposal as CompanionPersonaPublication;
        if (proposal.operationId !== publication.operationId || proposal.companionId !== ownerId || proposal.conversationId !== checkpoint.conversationId
          || proposal.jobId !== `growth:${checkpoint.key.slice(0, 48)}` || proposal.expectedRevision !== checkpoint.profileRevision
          || proposal.expectedRevision !== current.contentHash || target.next.contentHash !== hash(renderCompanionAssetProfile(ownerId, proposal.profile))
          || target.next.producer.id !== proposal.jobId)
          throw new Error('启动恢复提议与准确作业或发布凭证不一致。');
        await this.finish(registry, checkpoint, new AbortController().signal);
        if ((await registry.publication(proposal.operationId))?.state !== 'committed') throw new Error('已付费人格提议仍未通过启动复核，当前伙伴保持阻塞。');
        resumed++;
      }
      return { resumed };
    }).catch(error => {
      // Startup isolates typed artifact failures per owner. A malformed
      // checkpoint or failed exact validation must not reject the whole library.
      if (error instanceof CompanionArtifactError) throw error;
      throw new CompanionArtifactError('CONFLICT', error instanceof Error ? error.message : '启动人格发布核验失败，当前伙伴保持阻塞。');
    });
  }
  private async recover(ownerId: string): Promise<{ queued: number; interrupted: number }> {
    if (this.isStopped(ownerId) || this.active.has(ownerId)) return { queued: 0, interrupted: 0 };
    const registry = await this.options.profiles.artifacts(ownerId); let queued = 0, interrupted = 0;
    await this.recoverControls(registry);
    for (const state of ['fixed', 'generated', 'generating', 'failed', 'waiting_model']) for (const artifact of await registry.list('host', { kind: 'runtime_index', producerId: `growth:checkpoint:${state}`, newestFirst: true, limit: 8 })) {
      if (this.isStopped(ownerId)) return { queued, interrupted };
      const checkpoint = checkpointSchema.parse(JSON.parse((await registry.read({ artifactId: artifact.artifactId, consumer: 'host' })).text));
      if (checkpoint.state === 'generating') {
        checkpoint.state = 'interrupted'; checkpoint.reason = '重启时模型结果不明，保留输入等待显式重试；没有自动重复付费。'; await this.save(registry, checkpoint);
        interrupted++; this.options.report(new Error(checkpoint.reason + ` 作业：${checkpoint.key}`));
      }
      this.wake({ companionId: ownerId, conversationId: checkpoint.conversationId }); queued++;
    }
    return { queued, interrupted };
  }
  async listJobs(ownerId: string, limit = 20): Promise<Array<{ id: string; companionId: string; conversationId: string;
    status: Checkpoint['state']; disposition: CompanionJobDisposition; reason: string; createdAt: string; updatedAt: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('人格作业最多读取20条。');
    const registry = await this.options.profiles.artifacts(ownerId), page = await registry.page({ kind: 'runtime_index', prefix: 'growth-checkpoint:', newestFirst: true, limit });
    const descriptions: Record<Checkpoint['state'], string> = {
      fixed: '输入已固定，尚未发送模型请求。', generating: '本次生成已经发送；进程中断时结果可能不明。',
      generated: '生成结果已保存，等待准确来源与当前版本复核。', published: '有据局部人格已发布。',
      no_change: '本批已核验，没有形成新的人格差异。', deferred: '依据暂不足，保留重新评估条件。',
      stale: '已保存结果暂未通过当前版本核验；不会自动重复付费。', interrupted: '先前生成结果不明；明确重试可能再次调用模型。',
      failed: '先前请求或输出合同失败；明确重试可能再次调用模型。',
    };
    const results = [];
    for (const artifact of page.items) {
      const checkpoint = checkpointSchema.parse(JSON.parse((await registry.read({ artifactId: artifact.artifactId, consumer: 'host' })).text));
      if (checkpoint.companionId !== ownerId || artifact.artifactId !== `growth-checkpoint:${checkpoint.key}`) throw new Error('人格作业归属不一致。');
      results.push({ id: checkpoint.key, companionId: ownerId, conversationId: checkpoint.conversationId, status: checkpoint.state,
        disposition: checkpoint.disposition, reason: descriptions[checkpoint.state], createdAt: checkpoint.createdAt, updatedAt: checkpoint.updatedAt });
    }
    return results;
  }
  wake(scope: { companionId: string; conversationId: string }): void {
    if (this.isStopped(scope.companionId)) return;
    const key = `${scope.companionId}:${scope.conversationId}`;
    this.pending.set(key, { ...scope });
    if (this.agendaWakeOwner) this.notifyAgenda(scope); else this.pump();
  }
  private pump(): void {
    if (this.disposed || !this.started || this.agendaWakeOwner) return;
    for (const [key, scope] of this.pending) {
      if (this.active.size >= 2) break;
      if (this.isStopped(scope.companionId)) { this.pending.delete(key); continue; }
      if (this.active.has(scope.companionId) || this.retryPreparations.has(scope.companionId)) continue;
      this.pending.delete(key);
      void this.runOnce(scope).then(result => { if (result.status === 'interrupted') this.options.report(new Error(result.reason + ` 作业：${result.jobId}`)); }).catch(this.options.report);
    }
  }
  stop(ownerId: string): void {
    this.stopped.add(ownerId); this.active.get(ownerId)?.controller.abort();
    for (const [key, scope] of this.pending) if (scope.companionId === ownerId) this.pending.delete(key);
  }
  resume(ownerId: string): void {
    if (this.retiring.has(ownerId)) return; this.stopped.delete(ownerId);
    if (this.agendaWakeOwner) this.notifyAgenda({ companionId: ownerId }); else { this.pump(); this.scheduleScan(0); }
  }
  dispose(): void { this.disposed = true; this.pending.clear(); if (this.timer) clearTimeout(this.timer); this.timer = undefined; for (const entry of this.active.values()) entry.controller.abort(); }
  async close(): Promise<void> {
    this.dispose(); const pending: Promise<unknown>[] = [...this.active.values()].map(entry => entry.promise);
    pending.push(...this.recoveries.values(), ...[...this.hostJobs.values()].flatMap(jobs => [...jobs])); if (this.scanPromise) pending.push(this.scanPromise);
    await Promise.allSettled(pending);
  }
  async stopAndWait(ownerId: string): Promise<void> { this.retiring.add(ownerId); this.stop(ownerId);
    await Promise.allSettled([this.active.get(ownerId)?.promise, this.recoveries.get(ownerId), ...this.hostJobs.get(ownerId) ?? []]); }
  /** A definition-change fence is reversible; retirement is deliberately not.
   * The caller commits the new direction only after current publishers drain. */
  async pauseAndWait(ownerId: string): Promise<void> {
    const pending = [...this.pending.entries()].filter(([, scope]) => scope.companionId === ownerId);
    const active = this.active.get(ownerId);
    this.stop(ownerId);
    await Promise.allSettled([this.active.get(ownerId)?.promise, this.recoveries.get(ownerId), ...this.hostJobs.get(ownerId) ?? []]);
    if (this.disposed || this.retiring.has(ownerId)) return;
    // A temporary fence must preserve UI-direction wakes too: unlike source
    // debt, those exact ports need not appear in the dirty SQL catalog. Merely
    // restoring the scope never resumes an unknown paid native checkpoint.
    if (active) this.pending.set(`${ownerId}:${active.conversationId}`, { companionId: ownerId, conversationId: active.conversationId });
    for (const [key, scope] of pending) if (!this.pending.has(key)) this.pending.set(key, scope);
  }
  private trackHost<T>(ownerId: string, operation: () => Promise<T>): Promise<T> {
    const jobs = this.hostJobs.get(ownerId) ?? new Set<Promise<unknown>>(); this.hostJobs.set(ownerId, jobs);
    const job = operation().finally(() => { jobs.delete(job); if (!jobs.size) this.hostJobs.delete(ownerId); }); jobs.add(job); return job;
  }
  runOnce(scope: { companionId: string; conversationId: string; signal?: AbortSignal; onFixed?: (job: CompanionGrowthNativeJob) => Promise<void> }): Promise<CompanionGrowthResult> {
    if (this.retryPreparations.has(scope.companionId)) return Promise.resolve(this.result(scope, 'deferred', '正在耐久准备明确重试，等待同一伙伴串行处理。'));
    const active = this.active.get(scope.companionId);
    if (active) return active.conversationId === scope.conversationId ? active.promise
      : Promise.resolve(this.result(scope, 'deferred', '该伙伴正在处理另一个固定会话批次。'));
    if (this.active.size >= 2) return Promise.resolve(this.result(scope, 'deferred', '后台人格作业已达到并发上限，等待下一次调度。'));
    const controller = new AbortController(); const abort = () => controller.abort(); scope.signal?.addEventListener('abort', abort, { once: true });
    if (scope.signal?.aborted) controller.abort();
    const promise = this.run({ companionId: scope.companionId, conversationId: scope.conversationId }, controller.signal, scope.onFixed)
      .then(async result => {
        const key = `${scope.companionId}:${scope.conversationId}`, page = this.reviewed.get(key);
        if (page && !result.retryAt && !controller.signal.aborted && !this.isStopped(scope.companionId)) {
          const ack = await this.request({ type: 'character.development.scopes.ack', companionId: scope.companionId, conversationId: scope.conversationId,
            expectedGeneration: page.generation, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
          if (page.nextCursor || !ack.characterDevelopmentScopeAcknowledged) this.wake(scope);
        }
        return result;
      }).finally(() => { this.reviewed.delete(`${scope.companionId}:${scope.conversationId}`); this.active.delete(scope.companionId); scope.signal?.removeEventListener('abort', abort); this.pump(); });
    this.active.set(scope.companionId, { conversationId: scope.conversationId, controller, promise }); return promise;
  }
  /** One agenda-owned quantum. Native input batching and audience boundaries
   * remain unchanged; unrelated source conversations never become world input. */
  async runAgendaQuantum(ownerId: string, signal: AbortSignal, onProgress?: GrowthAgendaProgress): Promise<CompanionAgendaGrowthQuantumResult> {
    if (!this.agendaWakeOwner) throw new Error('人格维护尚未切换到统一日程调度。');
    if (this.agendaRunning.has(ownerId)) return { outcome: 'waiting', companionId: ownerId, hasMore: true, reason: '该伙伴的有据人格回顾正在处理，保留其他来源等待后续日程。' };
    this.agendaRunning.add(ownerId);
    try { return await this.agendaQuantum(ownerId, signal, onProgress); } finally { this.agendaRunning.delete(ownerId); }
  }
  private async agendaQuantum(ownerId: string, signal: AbortSignal, onProgress?: GrowthAgendaProgress): Promise<CompanionAgendaGrowthQuantumResult> {
    const more = () => [...this.pending.values()].some(scope => scope.companionId === ownerId) || this.agendaCursors.has(ownerId);
    const basic = (outcome: CompanionAgendaGrowthQuantumResult['outcome'], reason: string): CompanionAgendaGrowthQuantumResult => ({ outcome, companionId: ownerId, reason, hasMore: more() });
    if (signal.aborted) return basic('cancelled', '本次人格回顾已经停止，来源和成功阶段保留。');
    if (this.isStopped(ownerId)) return basic('waiting', '伙伴尚未恢复，当前人格没有改写。');
    if (this.active.has(ownerId) || this.retryPreparations.has(ownerId) || this.active.size >= 2) return basic('waiting', '等待人格处理资源；没有启动第二份同源生成。');
    let selected = [...this.pending.entries()].find(([, scope]) => scope.companionId === ownerId && (!scope.retryAt || Date.parse(scope.retryAt) <= Date.now()));
    if (!selected) {
      const cursor = this.agendaCursors.get(ownerId);
      const page = (await this.request({ type: 'character.development.scopes.page', companionId: ownerId, limit: 16,
        ...(cursor ? { afterCompanionId: cursor.companionId, afterConversationId: cursor.conversationId } : {}) })).characterDevelopmentScopes;
      if (signal.aborted || this.isStopped(ownerId)) return basic(signal.aborted ? 'cancelled' : 'waiting', '读取来源范围后本次回顾已经停止。');
      if (page?.items.some(scope => scope.companionId !== ownerId) || page?.nextCursor && page.nextCursor.companionId !== ownerId)
        throw new Error('人格来源范围不属于本次日程的伙伴，未合并或处理。');
      if (page?.hasMore && page.nextCursor) this.agendaCursors.set(ownerId, page.nextCursor); else this.agendaCursors.delete(ownerId);
      for (const scope of page?.items ?? []) {
        const key = `${scope.companionId}:${scope.conversationId}`;
        if (!this.pending.has(key)) this.pending.set(key, { companionId: scope.companionId, conversationId: scope.conversationId });
      }
      selected = [...this.pending.entries()].find(([, scope]) => scope.companionId === ownerId && (!scope.retryAt || Date.parse(scope.retryAt) <= Date.now()));
    }
    if (!selected) {
      const retryAt = [...this.pending.values()].filter(scope => scope.companionId === ownerId && scope.retryAt).map(scope => scope.retryAt!).sort()[0];
      return { ...basic(retryAt || more() ? 'waiting' : 'no_change', retryAt ? '保留原始固定输入，等待已登记的下一次检查。' : '当前没有新的有据人格输入。'), ...(retryAt ? { retryAt } : {}) };
    }
    const [key, scope] = selected;
    // Persist the parent checkpoint before dispatch. A rejected checkpoint keeps
    // the exact dirty scope queued, so no semantic work escapes its agenda run.
    await onProgress?.('正在回顾当前来源域的本人认识');
    if (signal.aborted || this.isStopped(ownerId)) return basic(signal.aborted ? 'cancelled' : 'waiting', '本次人格回顾在派发前已经停止，原始来源仍然保留。');
    this.pending.delete(key);
    let result: CompanionGrowthResult | undefined, error: unknown;
    const processing = this.runOnce({ companionId: ownerId, conversationId: scope.conversationId, signal,
      onFixed: async nativeJob => { await onProgress?.('当前人格回顾输入已经固定', nativeJob); signal.throwIfAborted(); } });
    const current = this.active.get(ownerId);
    try { result = await processing; } catch (failure) { error = failure; }
    const jobId = result?.jobId ?? current?.jobId;
    let disposition: CompanionJobDisposition | undefined;
    if (jobId) disposition = await this.inspectJob(ownerId, jobId);
    const nativeJob = disposition ? { kind: 'growth' as const, id: disposition.id, inputVersion: disposition.inputVersion, revision: disposition.revision } : undefined;
    let outcome: CompanionAgendaGrowthQuantumResult['outcome'];
    const reason = result?.reason ?? (error instanceof Error ? error.message : '人格回顾尚未完成。');
    if (disposition?.state === 'abandoned') outcome = 'abandoned';
    else if (disposition?.state === 'parked') outcome = result?.status === 'interrupted' ? 'unknown' : 'parked';
    else if (result?.status === 'interrupted' || result?.status === 'generating') outcome = 'unknown';
    else if (result?.status === 'published') outcome = 'published';
    else if (signal.aborted || this.isStopped(ownerId)) outcome = 'cancelled';
    else if (error) outcome = 'failed';
    else if (result?.retryAt || result?.status === 'fixed' || result?.status === 'generated' || result?.status === 'deferred' && !jobId) outcome = 'waiting';
    else outcome = 'no_change';
    if (outcome === 'waiting' || outcome === 'failed' && disposition?.state === 'failed') {
      const retryAt = result?.retryAt ?? new Date(Date.now() + 1000).toISOString();
      if (!this.pending.has(key)) this.pending.set(key, { companionId: ownerId, conversationId: scope.conversationId, retryAt });
    }
    // A notification failure after an actual publication must not conceal its
    // durable receipt or suggest that the model/publication should be replayed.
    try { await onProgress?.(outcome === 'published' ? '有据局部人格已经发布' : reason.slice(0, 1000), nativeJob); } catch (failure) { this.options.report(failure); }
    return { outcome, companionId: ownerId, conversationId: scope.conversationId, reason, hasMore: more(),
      ...(jobId ? { jobId } : {}), ...(nativeJob ? { nativeJob } : {}), ...(result?.retryAt ? { retryAt: result.retryAt } : {}) };
  }
  private async validateFixedInput(registry: CompanionArtifactRegistry, checkpoint: Checkpoint): Promise<void> {
    const scope = { companionId: checkpoint.companionId, conversationId: checkpoint.conversationId };
    if (this.isStopped(scope.companionId)) throw new Error('伙伴已停止，不能重试人格作业。');
    const [sources, notes, goals] = await Promise.all([
      this.request({ type: 'memory.sources.filter', companionId: scope.companionId, conversationId: scope.conversationId,
        ids: checkpoint.sourceReadset.map(reference => sourceIdentity(reference.artifactId).id) }),
      this.request({ type: 'memory.records.filter', companionId: scope.companionId, conversationId: scope.conversationId, ids: checkpoint.noteReadset.map(note => note.id) }),
      checkpoint.agendaGoalReadset !== undefined ? Promise.resolve({ ok: true, growthGoals: [] as CompanionGrowthGoal[] })
        : this.request({ type: 'growth.goals.list', companionId: scope.companionId, conversationId: checkpoint.goalConversationId ?? scope.conversationId, limit: 40 }),
    ]);
    if (checkpoint.agendaGoalReadset !== undefined) await validateCompanionAgendaPersonaDirections(scope.companionId, checkpoint.goalConversationId ?? scope.conversationId,
      checkpoint.agendaGoalReadset, checkpoint.goalRevision, this.options.requestStorage);
    else if (companionGrowthGoalRevision(goals.growthGoals ?? []) !== checkpoint.goalRevision) throw new Error('原培养目标版本已经变化，不能重放该作业。');
    const snapshot = await this.options.profiles.load(scope.companionId);
    if (snapshot.profileRevision !== checkpoint.profileRevision || companionPersonaPolicyRevision(snapshot) !== checkpoint.policyRevision)
      throw new Error('原人格或认知策略版本已经变化，不能重放该作业。');
    const lifecycle = await this.request({ type: 'memory.lifecycle.state', companionId: scope.companionId });
    if (lifecycle.memoryLifecycleState?.revocationEpoch !== checkpoint.revocationEpoch) throw new Error('来源撤销版本已经变化，不能重放该作业。');
    for (const reference of checkpoint.sourceReadset) {
      const identity = sourceIdentity(reference.artifactId), source = sources.memorySources?.find(message => message.id === identity.id);
      if (!source || source.revision !== identity.revision || hash(source.content) !== reference.contentHash) throw new Error('原始来源的权限或准确版本已失效，不能重试。');
      const sourceArtifact = (await registry.read({ artifactId: reference.artifactId, consumer: 'source_verification', audienceIds: [source.conversationId] })).artifact;
      if (sourceArtifact.contentRevision !== reference.contentRevision || sourceArtifact.contentHash !== reference.contentHash) throw new Error('原始来源登记已变化，不能重试。');
    }
    for (const expected of checkpoint.noteReadset) {
      const note = notes.memories?.find(value => value.id === expected.id);
      if (!note || note.artifactKind !== 'self_understanding' || !['queued', 'indexed'].includes(note.status) || note.archivedAt
        || note.version !== expected.version || (note.contentRevision ?? note.version) !== expected.contentRevision || hash(note.content) !== expected.contentHash)
        throw new Error('本人认识版本已经变化或撤回，不能重放旧作业。');
      const registered = await registry.read({ artifactId: `memory:${expected.id}`, consumer: 'audit' });
      if (registered.artifact.kind !== 'self_understanding' || registered.artifact.contentHash !== expected.contentHash) throw new Error('本人认识的受管正文版本已变化。');
    }
    if (this.isStopped(scope.companionId)) throw new Error('伙伴已停止，不能重试人格作业。');
  }
  private async checkpoint(registry: CompanionArtifactRegistry, id: string): Promise<Checkpoint | undefined> {
    if (!/^[a-f0-9]{64}$/u.test(id)) return;
    const artifact = await registry.get(`growth-checkpoint:${id}`); if (!artifact) return;
    const checkpoint = checkpointSchema.parse(JSON.parse((await registry.read({ artifactId: artifact.artifactId, consumer: 'host' })).text));
    if (checkpoint.key !== id || checkpoint.companionId !== registry.ownerId || checkpoint.disposition.ownerId !== registry.ownerId
      || checkpoint.disposition.id !== id || checkpoint.disposition.kind !== 'growth') throw new Error('人格作业归属或身份不一致。');
    return checkpoint;
  }
  async inspectJob(ownerId: string, id: string): Promise<CompanionJobDisposition | undefined> {
    return (await this.checkpoint(await this.options.profiles.artifacts(ownerId), id))?.disposition;
  }
  async pageJobs(input: CompanionJobPageCommand): Promise<CompanionJobPage> {
    const command = companionJobPageCommandSchema.parse(input); if (command.kind !== 'growth') throw new Error('人格作业页不能读取其他处理职能。');
    const registry = await this.options.profiles.artifacts(command.ownerId);
    const producers: Record<CompanionJobDisposition['state'], string[]> = { pending: ['fixed'], running: ['generating', 'generated'],
      completed: ['published', 'no_change', 'deferred'], failed: ['failed'], parked: ['parked'], abandoned: ['abandoned'],
      cancelled: [], stale: ['stale'], waiting_model: ['waiting_model'] };
    const states = command.states ?? Object.keys(producers) as CompanionJobDisposition['state'][];
    // Current producer metadata is the indexed projection of the original checkpoint,
    // not a second job queue. Each indexed branch reads at most limit+1 rows.
    const pages = await Promise.all([...new Set(states.flatMap(state => producers[state]))].map(stage => registry.page({ kind: 'runtime_index',
      prefix: 'growth-checkpoint:', producerId: `growth:checkpoint:${stage}`, limit: command.limit + 1,
      ...(command.afterId ? { afterId: `growth-checkpoint:${command.afterId}` } : {}) })));
    const artifacts = pages.flatMap(page => page.items).sort((a, b) => a.artifactId.localeCompare(b.artifactId));
    const hasMore = artifacts.length > command.limit || pages.some(page => page.hasMore), items: CompanionJobDisposition[] = [];
    for (const artifact of artifacts.slice(0, command.limit)) {
      const checkpoint = await this.checkpoint(registry, artifact.artifactId.slice('growth-checkpoint:'.length));
      if (!checkpoint || !states.includes(checkpoint.disposition.state)) throw new Error('人格作业索引与当前处置不一致。');
      items.push(checkpoint.disposition);
    }
    return { items, hasMore, ...(hasMore && items.length ? { nextId: items.at(-1)!.id } : {}) };
  }
  controlJob(input: CompanionJobControlCommand): Promise<CompanionJobDisposition> {
    const command = companionJobControlCommandSchema.parse(input);
    if (command.kind !== 'growth') return Promise.reject(new Error('人格处理不能处置其他职能的作业。'));
    if (this.retryPreparations.has(command.ownerId)) return Promise.reject(new Error('该伙伴正在准备另一项明确处置，请重新读取后重试。'));
    const operation = this.trackHost(command.ownerId, () => Promise.resolve().then(() => this.control(command)));
    const completed = operation.finally(() => { this.retryPreparations.delete(command.ownerId); this.pump(); });
    this.retryPreparations.set(command.ownerId, { jobId: command.id, promise: completed.then(() => undefined, () => undefined) }); return completed;
  }
  private async control(command: CompanionJobControlCommand): Promise<CompanionJobDisposition> {
    if (this.isStopped(command.ownerId)) throw new Error('伙伴已停止，不能处置人格作业。');
    const registry = await this.options.profiles.artifacts(command.ownerId), receiptId = `growth-control:${command.operationId}`;
    const commandHash = hash(JSON.stringify([command.ownerId, command.kind, command.id, command.inputVersion, command.expectedRevision, command.action]));
    const pending = await registry.publication(receiptId);
    if (pending && ['prepared', 'validated', 'file_published'].includes(pending.state)) await this.recoverControl(registry, receiptId);
    if (await registry.get(receiptId)) {
      const previous = JSON.parse((await registry.read({ artifactId: receiptId, consumer: 'host' })).text) as { commandHash: string; disposition: unknown };
      if (previous.commandHash !== commandHash) throw new Error('处理操作标识已用于另一个范围或动作。');
      return companionJobDispositionSchema.parse(previous.disposition);
    }
    let checkpoint = await this.checkpoint(registry, command.id);
    if (!checkpoint) throw new Error('处理作业不存在或不属于当前伙伴。');
    const original = checkpoint.disposition;
    if (original.inputVersion !== command.inputVersion || original.revision !== command.expectedRevision) throw new Error('作业输入或状态已经变化，请重新读取后操作。');
    if (['completed', 'cancelled', 'stale', 'abandoned'].includes(original.state)) throw new Error('这个作业已经终结，不能恢复旧处理。');
    if (command.action === 'resume' && original.state !== 'parked') throw new Error('只有已搁置的处理可以明确恢复。');
    const active = this.active.get(command.ownerId);
    if (active?.jobId === command.id) {
      active.controller.abort(); await active.promise.catch(() => undefined);
      checkpoint = await this.checkpoint(registry, command.id);
      if (!checkpoint || checkpoint.disposition.inputVersion !== original.inputVersion || ['completed', 'stale'].includes(checkpoint.disposition.state))
        throw new Error('停止期间作业输入或结果已经变化，请重新读取。');
    }
    if (command.action === 'resume') {
      await this.validateFixedInput(registry, checkpoint);
      // A saved paid result resumes validation/publication. Only a missing or
      // unknown result receives an explicitly authorized new invocation.
      if (!checkpoint.output && !checkpoint.proposal) checkpoint.attempt++;
      checkpoint.state = 'fixed'; checkpoint.retryAt = undefined;
      checkpoint.reason = '用户已针对准确输入明确恢复处理；保留累计失败，开始新的重试周期。';
    }
    const next = companionJobDispositionSchema.parse({ ...checkpoint.disposition, revision: checkpoint.disposition.revision + 1,
      state: command.action === 'resume' ? 'pending' : command.action === 'park' ? 'parked' : 'abandoned',
      cycleFailureCount: command.action === 'resume' ? 0 : checkpoint.disposition.cycleFailureCount });
    checkpoint.disposition = next; checkpoint.updatedAt = new Date().toISOString();
    const previousArtifact = await registry.get(`growth-checkpoint:${checkpoint.key}`); if (!previousArtifact) throw new Error('人格作业已撤回。');
    const receiptDisposition = { ...next }; delete receiptDisposition.lastError;
    await registry.publishBatch({ operationId: `growth-control:${command.operationId}`, items: [this.checkpointItem(checkpoint, previousArtifact.contentRevision),
      { artifactId: receiptId, kind: 'runtime_index', relativePath: `.运行/索引/人格处置/${command.operationId}.json`, expectedRevision: null,
        content: JSON.stringify({ schema: 'worldlinebox.growth-control-receipt-v2', commandHash, disposition: receiptDisposition }) + '\n',
        producer: { kind: 'host', id: 'growth:control' }, sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['host'], retentionClass: 'runtime' }] });
    if (command.action === 'resume') this.wake({ companionId: command.ownerId, conversationId: checkpoint.conversationId });
    return next;
  }
  /** Trusted restore fence, called while the restored SQL owner is inactive.
   * It preserves original events, exact inputs and already paid result bytes. */
  parkRestoredOwner(ownerId: string): Promise<{ parked: number }> {
    return this.trackHost(ownerId, async () => {
      if (this.active.has(ownerId) || this.retryPreparations.has(ownerId)) throw new Error('恢复冻结不能与人格执行或管理操作并发。');
      const owner = (await this.request({ type: 'state', companionId: ownerId, includeConversations: false, includeHidden: true })).state?.companions.find(value => value.id === ownerId);
      if (!owner || owner.active !== false) throw new Error('恢复后必须先保持伙伴暂停，再冻结其人格后台作业。');
      const registry = await this.options.profiles.artifacts(ownerId); let parked = 0;
      // Fence already parked/abandoned jobs first too: a pre-restore UI token
      // must not resume a restored job merely because it was already parked.
      for (const state of ['parked', 'abandoned', 'fixed', 'generating', 'generated', 'failed', 'waiting_model']) {
        let afterId: string | undefined;
        for (;;) {
          const page = await registry.page({ kind: 'runtime_index', producerId: `growth:checkpoint:${state}`, prefix: 'growth-checkpoint:', afterId, limit: 32 });
          for (const artifact of page.items) {
            const checkpoint = await this.checkpoint(registry, artifact.artifactId.slice('growth-checkpoint:'.length)); if (!checkpoint) continue;
            if (['completed', 'stale', 'cancelled'].includes(checkpoint.disposition.state)) continue;
            const wasFrozen = ['parked', 'abandoned'].includes(checkpoint.disposition.state);
            if (checkpoint.disposition.state !== 'abandoned') checkpoint.disposition.state = 'parked';
            checkpoint.reason = '从一致恢复包恢复后，原后台工作保持搁置；等待逐项明确处理，不自动发送或发布。';
            // save advances the original checkpoint disposition revision.
            await this.save(registry, checkpoint); if (!wasFrozen) parked++;
          }
          if (!page.hasMore) break; afterId = page.nextId;
        }
      }
      return { parked };
    });
  }
  private async recoverControls(registry: CompanionArtifactRegistry): Promise<void> {
    for (const publication of await registry.pendingPublications({ operationPrefix: 'growth-control:', limit: 16 })) {
      if (this.isStopped(registry.ownerId)) return;
      await this.recoverControl(registry, publication.operationId);
    }
  }
  private async recoverControl(registry: CompanionArtifactRegistry, operationId: string): Promise<void> {
    const publication = await registry.publication(operationId);
    if (!publication || !['prepared', 'validated', 'file_published'].includes(publication.state)) return;
    const item = publication.items.find(value => value.next.artifactId.startsWith('growth-checkpoint:'));
    if (publication.items.length !== 2 || !item || publication.items.some(value => value.next.kind !== 'runtime_index')
      || !publication.items.some(value => value.next.artifactId === operationId && value.next.producer.id === 'growth:control'))
      throw new Error('人格处置恢复包不符合固定合同。');
    let checkpoint: Checkpoint;
    try {
      checkpoint = checkpointSchema.parse(JSON.parse((await registry.readPublicationItem(operationId, item.next.artifactId)).text));
      const receipt = JSON.parse((await registry.readPublicationItem(operationId, operationId)).text) as { disposition: unknown };
      const disposition = companionJobDispositionSchema.parse(receipt.disposition);
      if (checkpoint.companionId !== registry.ownerId || checkpoint.key !== disposition.id || checkpoint.disposition.revision !== disposition.revision
        || checkpoint.disposition.inputVersion !== disposition.inputVersion || checkpoint.disposition.state !== disposition.state)
        throw new Error('人格处置凭证与当前固定包不一致。');
    } catch (error) {
      // A prepare can survive before its authenticated private stage exists.
      // Roll back only those exact unpublished bytes; do not invent a body.
      if (!['ENOENT', 'MISSING'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await registry.cancelPublication(operationId); await registry.discardPublishedFiles(operationId); await registry.purgePublicationStages(operationId); return;
    }
    await registry.recover(operationId, async () => {
      if (this.isStopped(registry.ownerId)) throw new Error('人格处置恢复时伙伴已停止。');
      if (checkpoint.disposition.state === 'pending') await this.validateFixedInput(registry, checkpoint);
    });
  }
  private result(scope: { companionId: string; conversationId: string }, status: CompanionGrowthResult['status'], reason: string, jobId?: string): CompanionGrowthResult {
    return { ...scope, status, reason, ...(jobId ? { jobId } : {}) };
  }
  private async request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> {
    const response = await this.options.requestStorage(command); if (!response.ok) throw new Error(response.error ?? '成长作业存储核验失败。'); return response;
  }
  private checkpointItem(checkpoint: Checkpoint, expectedRevision: number | null): CompanionArtifactPublish {
    const state = ['parked', 'abandoned', 'waiting_model'].includes(checkpoint.disposition.state) ? checkpoint.disposition.state : checkpoint.state;
    return { artifactId: `growth-checkpoint:${checkpoint.key}`, kind: 'runtime_index', relativePath: `.运行/视图/人格学习/${checkpoint.key}.json`,
      content: JSON.stringify(checkpointSchema.parse(checkpoint)) + '\n', expectedRevision, producer: { kind: 'host', id: `growth:checkpoint:${state}` },
      sourceRefs: checkpoint.sourceReadset, dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['host'], retentionClass: 'runtime' };
  }
  private async save(registry: CompanionArtifactRegistry, checkpoint: Checkpoint): Promise<void> {
    const states: Record<Checkpoint['state'], CompanionJobDisposition['state']> = { fixed: checkpoint.retryAt ? 'waiting_model' : 'pending', generating: 'running', generated: 'running',
      published: 'completed', no_change: 'completed', deferred: 'completed', stale: 'stale', interrupted: 'parked', failed: 'failed' };
    checkpoint.disposition = { ...checkpoint.disposition, revision: checkpoint.disposition.revision + 1,
      state: ['parked', 'abandoned'].includes(checkpoint.disposition.state) ? checkpoint.disposition.state : states[checkpoint.state] };
    checkpoint.updatedAt = new Date().toISOString();
    const current = await registry.get(`growth-checkpoint:${checkpoint.key}`), item = this.checkpointItem(checkpoint, current?.contentRevision ?? null);
    await registry.publish({ ...item, operationId: `checkpoint:${checkpoint.key.slice(0, 40)}:${hash(item.content).slice(0, 32)}`, reason: checkpoint.reason });
    if (['published', 'no_change', 'deferred', 'stale'].includes(checkpoint.state)) {
      const existing = new Set((await registry.getMany(checkpoint.coverage.map(value => `growth-coverage:${hash(value)}`), true)).map(value => value.artifactId));
      const items = checkpoint.coverage.filter(value => !existing.has(`growth-coverage:${hash(value)}`)).map(value => ({
        artifactId: `growth-coverage:${hash(value)}`, kind: 'runtime_index' as const, relativePath: `.运行/视图/人格覆盖/${hash(value)}.json`,
        content: JSON.stringify({ schema: 'worldlinebox.companion-growth-coverage-v2', sourceKeyHash: hash(value), jobId: checkpoint.key, status: checkpoint.state }) + '\n',
        expectedRevision: null, producer: { kind: 'host' as const, id: 'growth:coverage' }, sourceRefs: [], dependencyRefs: [],
        visibility: { scope: 'owner' as const }, allowedConsumers: ['host' as const], retentionClass: 'runtime' as const,
      }));
      if (items.length) await registry.publishBatch({ operationId: `growth-covered:${checkpoint.key.slice(0, 48)}`, items });
    }
  }
  /** Indexed, bounded privacy debt. No directory scan or source body is needed. */
  purgeOwner(ownerId: string): Promise<{ removed: number; pending: boolean }> { return this.trackHost(ownerId, () => this.purge(ownerId)); }
  private async purge(ownerId: string): Promise<{ removed: number; pending: boolean }> {
    const cleanupStopped = () => this.disposed || this.retiring.has(ownerId);
    if (cleanupStopped()) return { removed: 0, pending: false };
    // Repair current fragments before deleting checkpoints required by an interrupted publication.
    await this.options.profiles.load(ownerId);
    const registry = await this.options.profiles.artifacts(ownerId); let removed = 0, pending = false;
    for (const operationPrefix of ['checkpoint:', 'persona:']) {
      const transactions = await registry.pendingPublications({ operationPrefix, includeRevoked: true, uncleanedOnly: true, limit: 16 });
      pending ||= transactions.length === 16;
      for (const transaction of transactions) {
        if (cleanupStopped()) return { removed, pending: true };
        if (['revoked', 'cancelled'].includes(transaction.state)
          && transaction.items.every(item => ['runtime_index', 'growth_publish'].includes(item.next.kind)))
          await registry.discardPublishedFiles(transaction.operationId);
        if (['committed', 'revoked', 'cancelled'].includes(transaction.state)) await registry.purgePublicationStages(transaction.operationId);
      }
    }
    for (const kind of ['runtime_index', 'growth_publish'] as const) {
      const page = await registry.page({ kind, ...(kind === 'runtime_index' ? { prefix: 'growth-checkpoint:' } : {}),
        publicationState: 'revoked', bodyCleanupRequired: true, limit: 16 });
      pending ||= page.hasMore;
      for (const artifact of page.items) {
        if (cleanupStopped()) return { removed, pending: true };
        if ((await registry.purgeRevokedBody(artifact.artifactId)).removed) removed++;
      }
    }
    return { removed, pending };
  }
  private async saved(registry: CompanionArtifactRegistry, conversationId: string): Promise<Checkpoint[]> {
    const candidates = (await Promise.all(['fixed', 'generating', 'generated', 'stale', 'interrupted', 'failed', 'parked', 'abandoned', 'waiting_model'].map(state => registry.list('host',
      { kind: 'runtime_index', producerId: `growth:checkpoint:${state}`, newestFirst: true, limit: state === 'stale' ? 16 : 8 })))).flat();
    // At most 88 receipt bodies enter this operation. Separate source-key
    // coverage records prevent an old candidate from becoming new input.
    const result: Checkpoint[] = [];
    for (const candidate of candidates.filter(value => value.relativePath.startsWith('.运行/视图/人格学习/')).slice(-88)) {
      const parsed = checkpointSchema.parse(JSON.parse((await registry.read({ artifactId: candidate.artifactId, consumer: 'host' })).text));
      if (parsed.conversationId === conversationId) result.push(parsed);
    }
    return result;
  }
  private async source(registry: CompanionArtifactRegistry, message: CompanionMessage, conversationId: string): Promise<CompanionArtifact> {
    if (!message.revision || message.status !== 'sent') throw new Error('成长来源不是准确版本的正式会话消息。');
    void conversationId; // The storage filter already checked the processing entrance; disclosure follows the original source domain.
    const artifactId = companionGrowthSourceArtifactId(message.id, message.revision), contentHash = hash(message.content);
    const existing = await registry.get(artifactId, true);
    if (existing?.publicationState === 'revoked') throw new Error('原始来源已经撤回，不能重新登记复活。');
    if (existing) {
      if (existing.kind !== 'source_evidence' || existing.contentHash !== contentHash) throw new Error('原始来源登记冲突。');
      await registry.read({ artifactId, consumer: 'source_verification', audienceIds: [message.conversationId] }); return existing;
    }
    return registry.publish({ artifactId, kind: 'source_evidence', producer: { kind: 'host', id: `message:${message.id}` },
      relativePath: `证据/来源/${message.id}-r${message.revision}-${contentHash}.md`, content: message.content, expectedRevision: null,
      sourceRefs: [], dependencyRefs: [], visibility: { scope: 'audience', audienceIds: sourceAudiences(registry.ownerId, message) },
      allowedConsumers: ['source_verification', 'audit'], retentionClass: 'evidence', operationId: `source:${message.id}:r${message.revision}:${contentHash.slice(0, 16)}` });
  }
  private async run(scope: { companionId: string; conversationId: string }, signal: AbortSignal, onFixed?: (job: CompanionGrowthNativeJob) => Promise<void>): Promise<CompanionGrowthResult> {
    if (signal.aborted || this.isStopped(scope.companionId)) return this.result(scope, 'deferred', '成长作业已停止。');
    const registry = await this.options.profiles.artifacts(scope.companionId), previous = await this.saved(registry, scope.conversationId);
    for (const checkpoint of previous.filter(value => !['parked', 'abandoned'].includes(value.disposition.state) && ['fixed', 'generating', 'generated', 'failed'].includes(value.state)
      && (!this.agendaWakeOwner || value.agendaGoalReadset !== undefined))) {
      if (checkpoint.retryAt && Date.parse(checkpoint.retryAt) > Date.now()) return { ...this.result(scope, 'deferred', checkpoint.reason, checkpoint.key), retryAt: checkpoint.retryAt };
      if (checkpoint.state === 'generating') {
        checkpoint.state = 'interrupted'; checkpoint.reason = '模型调用在重启前结果不明；保留输入，等待用户或宿主显式重试许可，不自动重复付费。';
        await this.save(registry, checkpoint); return this.result(scope, 'interrupted', checkpoint.reason, checkpoint.key);
      }
      if (checkpoint.state === 'generated' || checkpoint.state === 'fixed' && (checkpoint.output || checkpoint.proposal)) {
        await this.fixedJob(checkpoint, signal, onFixed); return this.finish(registry, checkpoint, signal);
      }
      if (checkpoint.state === 'failed') {
        checkpoint.attempt++; checkpoint.state = 'fixed'; checkpoint.output = undefined; checkpoint.proposal = undefined; checkpoint.retryAt = undefined;
      }
      // Continue the exact durable input, rather than replacing it with the
      // newest profile or a rewritten candidate under the same identity.
      return this.executeFixed(registry, checkpoint, signal, onFixed);
    }
    const snapshot = await this.options.profiles.load(scope.companionId);
    const work = (await this.request({ type: 'character.development.scopes.page', ...scope, limit: 1 })).characterDevelopmentScopes?.items[0];
    const initialGoalConversationId = previous.find(value => value.state === 'stale' && (!this.agendaWakeOwner || value.agendaGoalReadset !== undefined))?.goalConversationId ?? scope.conversationId;
    let agendaDirections = this.agendaWakeOwner ? await readCompanionAgendaPersonaDirections(scope.companionId, initialGoalConversationId, this.options.requestStorage) : undefined;
    const [development, goalResult, lifecycle] = await Promise.all([
      this.request({ type: 'character.development', ...scope, limit: 3, ...(work?.cursor ? { cursor: work.cursor } : {}) }),
      agendaDirections ? Promise.resolve({ ok: true, growthGoals: [] as CompanionGrowthGoal[] })
        : this.request({ type: 'growth.goals.list', ...scope, conversationId: initialGoalConversationId, limit: 40 }),
      this.request({ type: 'memory.lifecycle.state', companionId: scope.companionId }),
    ]);
    if (work) this.reviewed.set(`${scope.companionId}:${scope.conversationId}`, { generation: work.generation,
      ...(development.characterDevelopment?.nextCursor ? { nextCursor: development.characterDevelopment.nextCursor } : {}) });
    let goalConversationId = initialGoalConversationId, goals = goalResult.growthGoals ?? [];
    let usableGoals = goals.filter(goal => ['proposed', 'practicing', 'reconsidering'].includes(goal.status));
    const stale = previous.find(checkpoint => checkpoint.state === 'stale' && checkpoint.output && (!this.agendaWakeOwner || checkpoint.agendaGoalReadset !== undefined));
    if (stale && stale.goalRevision === (agendaDirections?.revision ?? companionGrowthGoalRevision(goals)) && stale.policyRevision === companionPersonaPolicyRevision(snapshot)) {
      // Rebase only exact unchanged target ranges. finish rechecks every SQL
      // source/note and action; incompatible ranges defer without a new call.
      stale.profileRevision = snapshot.profileRevision; stale.revocationEpoch = lifecycle.memoryLifecycleState?.revocationEpoch ?? -1;
      stale.proposal = undefined; stale.state = 'generated'; stale.reason = '在新版本上重新核验已保存的局部差异，不重新调用模型。';
      await this.save(registry, stale); await this.fixedJob(stale, signal, onFixed); return this.finish(registry, stale, signal);
    }
    const descriptions = development.characterDevelopment?.items ?? [];
    if (!descriptions.length) return this.result(scope, 'no_input', '没有新的有据本人认识；培养目标本身不构成已形成人格。');
    const records = await this.request({ type: 'memory.records.filter', ...scope, ids: descriptions.map(value => value.memoryId) });
    const registered = await registry.getMany((records.memories ?? []).map(note => `memory:${note.id}`)), candidates: Candidate[] = [];
    const registeredSources = await registry.getMany(registered.flatMap(artifact => artifact.sourceRefs.map(reference => reference.artifactId)));
    for (const note of records.memories ?? []) {
      const description = descriptions.find(value => value.memoryId === note.id), artifact = registered.find(value => value.artifactId === `memory:${note.id}`);
      if (!description || description.kind === 'goal' || description.memoryVersion !== note.version || !artifact || artifact.kind !== 'self_understanding'
        || note.status === 'forgotten' || note.status === 'invalid' || note.archivedAt
        || note.sourceConversationId !== scope.conversationId && !note.sources.every(source => source.conversationId === scope.conversationId)
        || !note.sources.length || note.sources.length > 12 || note.content.length > 8000) continue;
      const read = await registry.read({ artifactId: artifact.artifactId, consumer: 'audit' });
      if (hash(note.content) !== artifact.contentHash || read.text !== note.content) throw new Error('本人认识的SQL与正文版本不一致。');
      if (artifact.sourceRefs.some(reference => registeredSources.find(value => value.artifactId === reference.artifactId)?.kind !== 'source_evidence')) continue;
      candidates.push({ note, artifact, sourceRefs: artifact.sourceRefs }); if (candidates.length === 3) break;
    }
    if (!candidates.length) return this.result(scope, 'no_input', '没有已登记、版本一致且来源完整的本人认识候选。');
    const sourceDomains = intersectAudiences(candidates.flatMap(candidate => candidate.note.sources.map(source => noteSourceAudiences(scope.companionId, source))));
    const externalGoalDomains = sourceDomains.filter(domain => domain !== `world_${scope.companionId}`);
    if (scope.conversationId === `world_${scope.companionId}` && (externalGoalDomains.length === 1 || sourceDomains.length === 1)) {
      goalConversationId = externalGoalDomains[0] ?? sourceDomains[0]!;
      if (agendaDirections) agendaDirections = await readCompanionAgendaPersonaDirections(scope.companionId, goalConversationId, this.options.requestStorage);
      else goals = (await this.request({ type: 'growth.goals.list', ...scope, conversationId: goalConversationId, limit: 40 })).growthGoals ?? [];
      usableGoals = goals.filter(goal => ['proposed', 'practicing', 'reconsidering'].includes(goal.status));
    }
    const ids = [...new Set([...candidates.flatMap(value => value.note.sources.map(source => source.messageId)), ...usableGoals.flatMap(goal => goal.sources.map(source => source.messageId))])];
    if (ids.length > 24) return this.result(scope, 'deferred', '本批来源超过预算，等待较小的有效认识批次。');
    const sourceResult = await this.request({ type: 'memory.sources.filter', ...scope, ids }), sources = sourceResult.memorySources ?? [];
    if (sources.length !== ids.length || sources.reduce((total, source) => total + source.content.length, 0) > 24000)
      return this.result(scope, 'deferred', '原始来源未能完整获权读取或超过本批预算，未截断后继续推理。');
    const sourceArtifacts: CompanionArtifact[] = [];
    for (const source of sources) sourceArtifacts.push(await this.source(registry, source, scope.conversationId));
    for (const candidate of candidates) for (const reference of candidate.note.sources) {
      const source = sources.find(value => value.id === reference.messageId);
      if (!source || source.revision !== reference.revision || hash(source.content) !== reference.checksum) throw new Error('本人认识的准确原始来源已变化。');
    }
    for (const goal of usableGoals) for (const reference of goal.sources) {
      const source = sources.find(value => value.id === reference.messageId);
      if (!source || source.revision !== reference.revision || hash(source.content) !== reference.contentHash) throw new Error('培养目标来源已变化。');
    }
    const goalSourceIds = new Set(usableGoals.flatMap(goal => goal.sources.map(source => source.messageId)));
    const groundedCandidates = candidates.filter(candidate => candidate.note.sources.some(reference => !goalSourceIds.has(reference.messageId)
      && sources.some(source => source.id === reference.messageId && ownBehavior(scope.companionId, source))));
    if (!groundedCandidates.length) return this.result(scope, 'no_input', '培养目标及其复述不能独立证明已形成的人格；需要目标之外的本人实际言行或实践依据。');
    const goalRevision = agendaDirections?.revision ?? companionGrowthGoalRevision(goals);
    const coverageKey = (reference: CompanionArtifactReference) => `${reference.artifactId}:${reference.contentHash}${agendaDirections ? ':direction:' + goalRevision : ''}`;
    const coverage = sourceArtifacts.map(coverageKey).sort();
    const settled = new Set(previous.filter(value => ['parked', 'abandoned'].includes(value.disposition.state)
      || ['published', 'no_change', 'deferred', 'stale', 'interrupted', 'failed'].includes(value.state)).flatMap(value => value.coverage));
    const coveredArtifacts = new Set((await registry.getMany(candidates.flatMap(candidate => candidate.sourceRefs.map(reference =>
      `growth-coverage:${hash(coverageKey(reference))}`)), true)).map(value => value.artifactId));
    const freshCandidates = groundedCandidates.filter(candidate => candidate.sourceRefs.some(reference => {
      const sourceKey = coverageKey(reference);
      return !settled.has(sourceKey) && !coveredArtifacts.has(`growth-coverage:${hash(sourceKey)}`);
    }));
    if (!freshCandidates.length) return this.result(scope, 'no_input', '原始来源已经结算；候选重写不会制造新成长输入。');
    const key = hash(JSON.stringify([scope, coverage, ...(agendaDirections ? [agendaDirections.readset] : [])])), now = new Date().toISOString();
    const savedKey = await registry.get(`growth-checkpoint:${key}`)
      ? checkpointSchema.parse(JSON.parse((await registry.read({ artifactId: `growth-checkpoint:${key}`, consumer: 'host' })).text)) : undefined;
    if (savedKey && (['parked', 'abandoned'].includes(savedKey.disposition.state) || !['fixed', 'generated'].includes(savedKey.state))) return this.result(scope, savedKey.state, savedKey.reason, key);
    const fixed: Omit<Checkpoint, 'disposition'> = { schema: 'worldlinebox.companion-growth-checkpoint-v2', ...scope, key, attempt: savedKey?.attempt ?? 1, state: 'fixed', profileRevision: snapshot.profileRevision,
      policyRevision: companionPersonaPolicyRevision(snapshot), goalRevision, ...(agendaDirections ? { agendaGoalReadset: agendaDirections.readset } : {}), revocationEpoch: lifecycle.memoryLifecycleState?.revocationEpoch ?? -1,
      sourceReadset: sourceArtifacts.map(ref), sourceAudiences: intersectAudiences(sources.map(source => sourceAudiences(scope.companionId, source))),
      noteReadset: freshCandidates.map(value => ({ id: value.note.id, version: value.note.version,
        contentRevision: value.note.contentRevision ?? value.note.version, contentHash: hash(value.note.content) })), coverage, createdAt: now, updatedAt: now, reason: '固定独立来源与本人认识读集。' };
    const checkpoint: Checkpoint = { ...fixed, disposition: { ownerId: scope.companionId, kind: 'growth', id: key,
      inputVersion: hash(JSON.stringify([scope, key, fixed.profileRevision, fixed.policyRevision, fixed.goalRevision, fixed.revocationEpoch, fixed.sourceReadset, fixed.noteReadset])),
      revision: 0, state: 'pending', failureCount: 0, cycleFailureCount: 0, conversationId: scope.conversationId } };
    if (goalConversationId !== scope.conversationId) checkpoint.goalConversationId = goalConversationId;
    if (work) { checkpoint.inputGeneration = work.generation; checkpoint.inputNextCursor = development.characterDevelopment?.nextCursor; }
    const context = { system: '你是伙伴人格整合职能。只根据真实本人认识、原始言行、实践与反馈提出局部有条件修订。认识可以涉及偏好、反感、价值、语气、自我理解、世界观、关系理解、习惯或目标，不强求每类都有结论。培养目标与goal类自述只是面向未来的培养提议与练习条件，不等于已形成习惯，也不要求服从或强制改变人格。可以根据当前人格和实际依据拒绝、保留意见、提出替代方向或维持不变；评价条件不是必须达到的人格特征。资料观点、梦、日志、旧起点与自测宣称不是独立经历。人格没有数值、等级、好感或成熟分数。保留无变化、反例、未知及重新评估条件。不能增加权限。只返回下述JSON合同，不输出隐藏推理。',
      user: JSON.stringify({ purpose: 'companion_persona_integration', companionId: scope.companionId, conversationId: scope.conversationId,
        invocation: { id: `growth:${key.slice(0, 48)}:attempt:${checkpoint.attempt}`, conversationId: scope.conversationId },
        profileRevision: snapshot.profileRevision, current: snapshot.personaFragments.fragments.filter(fragment => companionPersonaFragmentVisible(fragment.visibility,
          scope.conversationId === `world_${scope.companionId}` ? [] : [scope.conversationId])).map(fragment => ({ fragmentId: fragment.fragmentId,
          contentHash: fragment.contentHash, text: snapshot.profile.persona.slice(fragment.start, fragment.end), visibility: fragment.visibility })),
        goals: usableGoals, cultivationDirections: agendaDirections?.directions ?? [], candidates: freshCandidates.map(value => ({ id: value.note.id, version: value.note.version, content: value.note.content, sources: value.note.sources,
          understanding: descriptions.find(description => description.memoryId === value.note.id) })), sources,
        output: { decisions: [{ action: 'keep|qualify|revise|retire|defer', fragmentId: '原片段ID；新认识追加用null', expectedHash: '原片段hash；追加用null',
          text: 'qualify/revise的新片段准确正文；其他操作留空', supportingNoteIds: ['实际支持该变化的本人认识id'], reason: '可见简要理由',
          applicableBehavior: '在哪种实际机会采取什么行为', reevaluateWhen: '什么反例或变化后重新评估' }], noChangeReason: '没有实质变化时说明原因' } }) };
    if (context.user.length + context.system.length > 56000) { checkpoint.state = 'deferred'; checkpoint.reason = '本批完整输入超过上下文预算。'; await this.save(registry, checkpoint); return this.result(scope, checkpoint.state, checkpoint.reason, key); }
    checkpoint.input = context; await this.save(registry, checkpoint);
    return this.executeFixed(registry, checkpoint, signal, onFixed);
  }
  private async fixedJob(checkpoint: Checkpoint, signal: AbortSignal, onFixed?: (job: CompanionGrowthNativeJob) => Promise<void>): Promise<void> {
    const active = this.active.get(checkpoint.companionId); if (active) active.jobId = checkpoint.key;
    signal.throwIfAborted();
    await onFixed?.({ kind: 'growth', id: checkpoint.key, inputVersion: checkpoint.disposition.inputVersion, revision: checkpoint.disposition.revision });
    signal.throwIfAborted();
    if (this.isStopped(checkpoint.companionId)) throw new Error('当前人格回顾已经停止，固定输入保留。');
  }
  private async executeFixed(registry: CompanionArtifactRegistry, checkpoint: Checkpoint, signal: AbortSignal, onFixed?: (job: CompanionGrowthNativeJob) => Promise<void>): Promise<CompanionGrowthResult> {
    const scope = { companionId: checkpoint.companionId, conversationId: checkpoint.conversationId }, key = checkpoint.key;
    if (signal.aborted || this.isStopped(scope.companionId)) return this.result(scope, 'deferred', '模型发送前已停止。', key);
    if (['parked', 'abandoned'].includes(checkpoint.disposition.state)) return this.result(scope, checkpoint.state, '作业已经搁置或放弃，普通唤醒不会恢复。', key);
    if (!checkpoint.input) throw new Error('人格固定输入缺失，不能重新拼装后冒充同一作业。');
    try { await this.validateFixedInput(registry, checkpoint); }
    catch (error) { checkpoint.state = 'stale'; checkpoint.reason = `固定输入已失效，未再次调用模型：${error instanceof Error ? error.message : String(error)}`.slice(0, 1800);
      await this.save(registry, checkpoint); return this.result(scope, 'stale', checkpoint.reason, key); }
    const user = JSON.parse(checkpoint.input.user) as { invocation: { id: string; conversationId: string } };
    user.invocation = { id: `growth:${key.slice(0, 48)}:attempt:${checkpoint.attempt}`, conversationId: scope.conversationId };
    const context = { system: checkpoint.input.system, user: JSON.stringify(user) }; checkpoint.input = context;
    await this.fixedJob(checkpoint, signal, onFixed);
    checkpoint.retryAt = undefined;
    checkpoint.state = 'generating'; checkpoint.reason = '已进入一次有界模型生成；结果未知时不自动重放。'; await this.save(registry, checkpoint);
    try {
      const config = await this.options.getConfig(scope.companionId);
      const output = outputSchema.parse(await (this.options.generateStructured ?? generateCompanionStructured)(context,
        { ...config, ownerId: scope.companionId, workPriority: 'background' }, signal, { timeoutMs: 90000, responseSchema: outputSchema,
          repairPreserveCollections: [{ path: ['decisions'], fields: ['action', 'fragmentId', 'expectedHash', 'text', 'supportingNoteIds', 'reason', 'applicableBehavior', 'reevaluateWhen'] }] }));
      if (signal.aborted || this.isStopped(scope.companionId)) {
        checkpoint.state = 'interrupted'; checkpoint.reason = '处理已停止；结果不再发布，固定输入保留等待明确处置。';
        await this.save(registry, checkpoint); return this.result(scope, 'interrupted', checkpoint.reason, key);
      }
      checkpoint.output = output; checkpoint.state = 'generated'; checkpoint.reason = '模型可见结果已耐久保存，提交前重核验。';
      await this.save(registry, checkpoint); return this.finish(registry, checkpoint, signal);
    } catch (error) {
      if ((await registry.get(`growth-checkpoint:${checkpoint.key}`, true))?.publicationState === 'revoked') {
        await this.purgeOwner(scope.companionId);
        return this.result(scope, 'stale', '原始来源已撤回；生成字节已屏蔽并进入精确物理清理。', key);
      }
      const retryMs = companionModelAdmissionRetryAfter(error) ?? (error instanceof CompanionModelError && error.code === 'CONFIG' ? 60000 : undefined);
      if (checkpoint.state === 'generating' && retryMs !== undefined) {
        checkpoint.state = 'fixed'; checkpoint.retryAt = new Date(Date.now() + retryMs).toISOString(); checkpoint.reason = '模型发送前暂不可用；保留固定输入，等待模型配置或工程队列恢复，没有结算为人格变化。';
        await this.save(registry, checkpoint); return { ...this.result(scope, 'deferred', checkpoint.reason, key), retryAt: checkpoint.retryAt };
      }
      if (checkpoint.state === 'generating') {
        checkpoint.reason = `生成失败或输出合同无效：${error instanceof Error ? error.message : String(error)}`.slice(0, 1800);
        if (signal.aborted || this.isStopped(scope.companionId) || error instanceof CompanionModelError && ['CANCELLED', 'CONTEXT_RECORD_FAILED'].includes(error.code)) {
          checkpoint.state = 'interrupted'; checkpoint.reason = '处理已停止或发送结果未确认；保留固定输入等待明确处置，不自动重发，也不计处理失败。';
        }
        else {
          checkpoint.state = 'failed'; checkpoint.disposition.failureCount++; checkpoint.disposition.cycleFailureCount++;
          checkpoint.disposition.lastError = checkpoint.reason.slice(0, 1000); checkpoint.disposition.lastErrorAt = new Date().toISOString();
          if (checkpoint.disposition.cycleFailureCount >= COMPANION_JOB_FAILURES_PER_CYCLE) checkpoint.disposition.state = 'parked';
          else checkpoint.retryAt = new Date(Date.now() + 1000).toISOString();
        }
        await this.save(registry, checkpoint);
        if (checkpoint.state === 'interrupted') return this.result(scope, 'interrupted', checkpoint.reason, key);
      }
      throw error;
    }
  }
  private proposal(snapshot: CompanionAssetProfileSnapshot, checkpoint: Checkpoint, output: GrowthOutput, candidates: Candidate[]): CompanionPersonaPublication | undefined {
    const pieces = snapshot.personaFragments.fragments.map(fragment => ({ fragment, text: snapshot.profile.persona.slice(fragment.start, fragment.end) }));
    const touched = new Set<string>(), semanticChanges: CompanionPersonaPublication['semanticChanges'] = [];
    for (const decision of output.decisions) {
      if (decision.action === 'keep' || decision.action === 'defer') continue;
      const index = decision.fragmentId === null ? -1 : pieces.findIndex(piece => piece.fragment.fragmentId === decision.fragmentId), previous = index < 0 ? undefined : pieces[index];
      if (decision.fragmentId && (!previous || previous.fragment.contentHash !== decision.expectedHash) || !decision.fragmentId && decision.expectedHash !== null)
        throw new Error('人格局部差异不匹配准确旧范围。');
      if (previous && !companionPersonaFragmentVisible(previous.fragment.visibility,
        checkpoint.conversationId === `world_${checkpoint.companionId}` ? [] : [checkpoint.conversationId])) throw new Error('当前会话没有读取或改写该私有人格片段的权限。');
      if (decision.fragmentId && touched.has(decision.fragmentId)) throw new Error('同一人格片段不能在一批重复修订。');
      if (decision.fragmentId) touched.add(decision.fragmentId);
      const supporting = candidates.filter(candidate => decision.supportingNoteIds.includes(candidate.note.id));
      if (!supporting.length || supporting.length !== new Set(decision.supportingNoteIds).size || !decision.applicableBehavior.trim() || !decision.reevaluateWhen.trim())
        throw new Error('人格变化缺少本人认识、适用行为或重新评估条件。');
      if (decision.action === 'retire') {
        if (!previous || decision.text.trim()) throw new Error('退出操作需要准确旧片段并且不能夹带新正文。');
        pieces.splice(index, 1); semanticChanges.push({ fragmentId: previous.fragment.fragmentId, beforeHash: previous.fragment.contentHash, afterHash: null, reason: decision.reason }); continue;
      }
      const text = decision.text.trim(); if (!text) throw new Error('人格新片段不能为空。');
      const fragmentId = previous?.fragment.fragmentId ?? `learned:${checkpoint.key.slice(0, 24)}:${semanticChanges.length + 1}`;
      const sourceRefs = uniqueRefs([...(previous?.fragment.sourceRefs ?? []), ...checkpoint.sourceReadset, ...supporting.flatMap(candidate => candidate.sourceRefs)]);
      // All visible inputs may influence an attempt, including cultivation
      // feedback, so their source and audience stay in the exact closure.
      const sourceDomains = checkpoint.sourceAudiences;
      const previousVisibility = previous?.fragment.visibility;
      const visibleDomains = previousVisibility?.scope === 'owner' ? [] : previousVisibility?.scope === 'audience'
        ? sourceDomains.filter(domain => previousVisibility.audienceIds.includes(domain)) : sourceDomains;
      const visibility: CompanionPersonaFragment['visibility'] = visibleDomains.length ? { scope: 'audience', audienceIds: visibleDomains } : { scope: 'owner' };
      const fragment: CompanionPersonaFragment = { fragmentId, start: 0, end: text.length, contentHash: hash(text), sourceRefs,
        dependencyRefs: uniqueRefs([...(previous?.fragment.dependencyRefs ?? []), ...supporting.map(candidate => ref(candidate.artifact))]),
        // No automatic publicity follows from generalized private evidence.
        visibility, disclosure: 'identity_content' };
      const piece = { text, fragment: companionPersonaFragmentSchema.parse(fragment) };
      if (previous) pieces[index] = piece; else pieces.push(piece);
      semanticChanges.push({ fragmentId, beforeHash: previous?.fragment.contentHash ?? null, afterHash: fragment.contentHash, reason: decision.reason });
    }
    if (!semanticChanges.length) return undefined;
    let persona = '';
    const fragments = pieces.map(piece => { if (persona) persona += '\n\n'; const start = persona.length; persona += piece.text;
      return { ...piece.fragment, start, end: persona.length }; });
    if (!persona.trim() || persona.length > 12000 || fragments.length > 64) throw new Error('人格差异超出完整正文预算，不能截断发布。');
    const profile = { ...snapshot.profile, persona };
    if (hash(renderCompanionAssetProfile(checkpoint.companionId, profile)) === snapshot.profileRevision) return undefined;
    return { companionId: checkpoint.companionId, conversationId: checkpoint.conversationId,
      ...(checkpoint.goalConversationId ? { goalConversationId: checkpoint.goalConversationId } : {}),
      operationId: `persona:${checkpoint.key.slice(0, 32)}:${checkpoint.profileRevision.slice(0, 16)}:e${checkpoint.revocationEpoch}`,
      jobId: `growth:${checkpoint.key.slice(0, 48)}`, expectedRevision: checkpoint.profileRevision, profile, goalRevision: checkpoint.goalRevision,
      ...(checkpoint.agendaGoalReadset !== undefined ? { agendaGoalReadset: checkpoint.agendaGoalReadset } : {}),
      promptPolicyRevision: checkpoint.policyRevision, sourceReadset: checkpoint.sourceReadset, dependencyVersions: candidates.map(candidate => ref(candidate.artifact)),
      revocationEpoch: checkpoint.revocationEpoch, semanticChanges, reason: semanticChanges.map(change => change.reason).join('\n').slice(0, 1600),
      coverage: checkpoint.coverage, visibility: { scope: 'owner' }, fragments, noteReadset: checkpoint.noteReadset };
  }
  private async finish(registry: CompanionArtifactRegistry, checkpoint: Checkpoint, signal: AbortSignal): Promise<CompanionGrowthResult> {
    const scope = { companionId: checkpoint.companionId, conversationId: checkpoint.conversationId };
    if (checkpoint.inputGeneration) this.reviewed.set(`${scope.companionId}:${scope.conversationId}`, { generation: checkpoint.inputGeneration,
      ...(checkpoint.inputNextCursor ? { nextCursor: checkpoint.inputNextCursor } : {}) });
    if (signal.aborted || this.isStopped(scope.companionId)) return this.result(scope, 'deferred', '人格提交前已停止，已生成结果保留。', checkpoint.key);
    try {
      if (!checkpoint.proposal && checkpoint.output?.decisions.some(decision => !['keep', 'defer'].includes(decision.action))) {
        const snapshot = await this.options.profiles.load(checkpoint.companionId);
        if (snapshot.profileRevision !== checkpoint.profileRevision) throw new Error('固定人格版本已变化，需要以新独立依据重新评估已保存的差异。');
        const notes = await this.request({ type: 'memory.records.filter', ...scope, ids: checkpoint.noteReadset.map(value => value.id) });
        const artifacts = await registry.getMany(checkpoint.noteReadset.map(note => `memory:${note.id}`)), candidates: Candidate[] = [];
        for (const note of notes.memories ?? []) {
          const read = checkpoint.noteReadset.find(value => value.id === note.id), artifact = artifacts.find(value => value.artifactId === `memory:${note.id}`);
          if (!read || !artifact || artifact.kind !== 'self_understanding' || note.version !== read.version || hash(note.content) !== read.contentHash
            || artifact.contentHash !== read.contentHash) throw new Error('待整合本人认识的版本已变化。');
          candidates.push({ note, artifact, sourceRefs: artifact.sourceRefs });
        }
        if (candidates.length !== checkpoint.noteReadset.length) throw new Error('待整合本人认识已撤回。');
        checkpoint.proposal = this.proposal(snapshot, checkpoint, checkpoint.output, candidates);
        await this.save(registry, checkpoint);
      }
      if (!checkpoint.proposal) {
        const snapshot = await this.options.profiles.load(checkpoint.companionId);
        const validation: CompanionPersonaPublication = { ...scope, ...(checkpoint.goalConversationId ? { goalConversationId: checkpoint.goalConversationId } : {}),
          operationId: `persona:${checkpoint.key.slice(0, 48)}`, jobId: `growth:${checkpoint.key.slice(0, 48)}`,
          expectedRevision: checkpoint.profileRevision, profile: snapshot.profile, goalRevision: checkpoint.goalRevision, promptPolicyRevision: checkpoint.policyRevision,
          ...(checkpoint.agendaGoalReadset !== undefined ? { agendaGoalReadset: checkpoint.agendaGoalReadset } : {}),
          sourceReadset: checkpoint.sourceReadset, dependencyVersions: [], revocationEpoch: checkpoint.revocationEpoch, semanticChanges: [],
          reason: '无变化结算前复核准确读集。', coverage: checkpoint.coverage, visibility: { scope: 'owner' }, fragments: snapshot.personaFragments.fragments, noteReadset: checkpoint.noteReadset };
        await validateCompanionPersonaPublication(validation, { requestStorage: this.options.requestStorage, profiles: this.options.profiles, isStopped: owner => this.isStopped(owner) });
        const deferred = checkpoint.output?.decisions.filter(decision => decision.action === 'defer') ?? [];
        checkpoint.state = deferred.length ? 'deferred' : 'no_change'; checkpoint.reason = checkpoint.output?.noChangeReason
          || deferred.map(decision => `${decision.reason} 重新评估条件：${decision.reevaluateWhen}`).join('\n').slice(0, 1800)
          || '本批证据没有产生需要发布的局部人格差异。';
        await this.save(registry, checkpoint); return this.result(scope, checkpoint.state, checkpoint.reason, checkpoint.key);
      }
      const proposal = checkpoint.proposal as CompanionPersonaPublication;
      const publication = await registry.publication(proposal.operationId);
      const effectiveProposal = publication?.state === 'committed'
        ? { ...proposal, expectedRevision: hash(renderCompanionAssetProfile(proposal.companionId, proposal.profile)) } : proposal;
      await validateCompanionPersonaPublication(effectiveProposal, { requestStorage: this.options.requestStorage, profiles: this.options.profiles, isStopped: owner => this.isStopped(owner) });
      if (!publication || publication.state === 'prepared') await this.options.profiles.publishPersona(proposal);
      else if (publication.state !== 'committed') await registry.recover(proposal.operationId,
        () => validateCompanionPersonaPublication(proposal, { requestStorage: this.options.requestStorage, profiles: this.options.profiles, isStopped: owner => this.isStopped(owner) }));
      checkpoint.state = 'published'; checkpoint.reason = '有据局部人格与同版角色指导已正式提交，后续请求采用该版本。';
      await this.save(registry, checkpoint); return this.result(scope, checkpoint.state, checkpoint.reason, checkpoint.key);
    } catch (error) {
      checkpoint.state = 'stale'; checkpoint.reason = `已生成提议未能通过当前版本复核，保留结果并等待新依据；不重复付费：${error instanceof Error ? error.message : String(error)}`.slice(0, 1800);
      if ((await registry.get(`growth-checkpoint:${checkpoint.key}`, true))?.publicationState === 'revoked') {
        await this.purgeOwner(checkpoint.companionId);
        return this.result(scope, checkpoint.state, '原始来源已撤回；结果已屏蔽并进入精确物理清理，不再次调用模型。', checkpoint.key);
      }
      await this.save(registry, checkpoint); return this.result(scope, checkpoint.state, checkpoint.reason, checkpoint.key);
    }
  }
}
