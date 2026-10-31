import { createHash } from 'node:crypto';
import { z } from 'zod';
import { COMPANION_AVATAR_IDS } from '../../shared/companion-template-ids';
import { companionArtifactReferenceSchema } from '../../shared/companion-artifact';
import { companionGrowthGoalSchema } from '../../shared/companion-cognition';
import { companionMemoryPolicySchema } from '../../shared/companion-memory-policy';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionLoopCheckpoint } from '../../shared/companion-loop';
import type { CompanionAssetProfileSnapshot } from './asset-profile';
import type { CompanionArtifactRegistry } from './artifact-registry';
import { companionPersonaFragmentsSchema, companionPersonaFragmentVisible, validateCompanionPersonaFragments } from './persona-fragments';
import { createCompanionExecutionValidationSession } from './source-execution-evidence';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotSchema = z.strictObject({ companionId: id, root: z.string(), profile: z.strictObject({
  templateId: id.optional(), name: z.string().min(1).max(60), description: z.string().max(500), persona: z.string().min(1).max(12000),
  avatar: z.enum(COMPANION_AVATAR_IDS), proactive: z.boolean(), inputMode: z.enum(['steer', 'queue']), avatarAttachmentId: id.nullable(), appearanceAttachmentId: id.nullable() }),
  profileRevision: hash, manifestRevision: hash, promptRevision: hash, revision: hash,
  fileRevisions: z.record(z.string(), hash), prompts: z.record(z.string(), z.string()),
  modules: z.array(z.strictObject({ path: z.string(), revision: hash, content: z.string(), purposes: z.array(z.string()) })).max(128),
  nativeFocusTemplate: z.string(), tagMasterTemplate: z.string(), nativeTimelineTemplate: z.string(), nativeSummaryTemplate: z.string(),
  personaFragments: companionPersonaFragmentsSchema, memoryPolicy: companionMemoryPolicySchema.optional(), memoryPolicyError: z.string().optional(), memoryPolicyRevision: hash,
});
const rawSourceSchema = z.strictObject({ id, conversationId: id, checksum: hash, revision: z.number().int().positive().optional() });
export const companionTaskAssetsSchema = z.strictObject({ schema: z.literal('worldlinebox.task-assets-v1'), ownerId: id,
  conversationId: id, sourceMessageId: id, invocationKey: id.optional(), capturedAt: z.iso.datetime(),
  captureMode: z.enum(['task_initial', 'legacy_first_admission']), revocationEpoch: z.number().int().nonnegative(),
  snapshot: snapshotSchema, cultivationGoals: z.array(companionGrowthGoalSchema).max(40),
  internalArtifacts: z.array(companionArtifactReferenceSchema).max(256), externalRefs: z.array(companionArtifactReferenceSchema), rawSources: z.array(rawSourceSchema),
}).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024 * 1024, '完整任务角色快照超过16MiB，未截断或发送。');
export type CompanionTaskAssets = z.infer<typeof companionTaskAssetsSchema>;
export type CompanionTaskAssetBinding = { checkpoint: Pick<CompanionLoopCheckpoint, 'companionId' | 'conversationId' | 'sourceMessageId' | 'invocationKey' | 'taskAssets'>;
  socialJobId?: string; legacy?: boolean; save(): Promise<void> };
type Request = (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const preparations = new WeakMap<object, Promise<CompanionTaskAssets>>();

export function readCompanionTaskAssets(text: string, scope: CompanionTaskAssetBinding['checkpoint']): CompanionTaskAssets {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('任务角色快照超出完整保存容量。');
  const value = companionTaskAssetsSchema.parse(JSON.parse(text));
  if (value.ownerId !== scope.companionId || value.snapshot.companionId !== scope.companionId || value.conversationId !== scope.conversationId
    || value.sourceMessageId !== scope.sourceMessageId || value.invocationKey !== scope.invocationKey) throw new Error('任务角色快照不属于本次伙伴、来源或任务。');
  if (value.cultivationGoals.some(goal => goal.companionId !== value.ownerId || goal.conversationId !== value.conversationId))
    throw new Error('任务初始培养方向不属于本次伙伴或真实入口。');
  validateCompanionPersonaFragments(value.snapshot.profile.persona, value.snapshot.personaFragments,
    { companionId: value.ownerId, profileHash: value.snapshot.profileRevision });
  for (const module of value.snapshot.modules) if (digest(module.content) !== module.revision || value.snapshot.fileRevisions[module.path] !== module.revision)
    throw new Error('任务角色快照的完整模块与原始版本不匹配。');
  return value;
}

async function epoch(owner: string, request: Request): Promise<number> {
  const response = await request({ type: 'memory.lifecycle.state', companionId: owner });
  if (!response.ok || response.memoryLifecycleState?.revocationEpoch === undefined) throw new Error('任务角色快照的撤回状态暂不可核验。');
  return response.memoryLifecycleState.revocationEpoch;
}

async function validateSources(owner: string, sources: readonly z.infer<typeof rawSourceSchema>[], request: Request): Promise<void> {
  for (const room of new Set(sources.map(source => source.conversationId))) {
    const scoped = sources.filter(source => source.conversationId === room);
    for (let offset = 0; offset < scoped.length; offset += 100) {
      const expected = scoped.slice(offset, offset + 100), response = await request({ type: 'memory.sources.filter', companionId: owner,
        conversationId: room, ids: [...new Set(expected.map(source => source.id))] });
      if (!response.ok) throw new Error('任务角色快照的原始来源暂不可核验。');
      if (expected.some(source => !response.memorySources?.some(actual => actual.id === source.id && actual.conversationId === room
        && digest(actual.content) === source.checksum && (source.revision === undefined || (actual.revision ?? 1) === source.revision))))
        throw new Error('任务初始人格或培养目标的原始来源已撤回，旧快照不能继续使用。');
    }
  }
}

/** Ordinary current-role revisions do not rewrite this task. Actual owner,
 * artifact withdrawal and original source ACL/bytes remain live authority. */
export async function validateCompanionTaskAssets(value: CompanionTaskAssets, registry: CompanionArtifactRegistry, request: Request,
  repairPersona?: () => Promise<unknown>): Promise<number> {
  const state = await request({ type: 'state', companionId: value.ownerId, conversationId: value.conversationId, includeHidden: true });
  if (!state.ok || !state.state?.companions.some(owner => owner.id === value.ownerId && owner.active !== false)
    || !state.state.conversations.some(room => room.id === value.conversationId && room.memberIds.includes(value.ownerId)))
    throw new Error('任务角色快照的伙伴或真实入口已经不可用。');
  const before = await epoch(value.ownerId, request);
  const validate = async () => {
    let current = await registry.getMany(value.internalArtifacts.map(artifact => artifact.artifactId), true);
    if (repairPersona && current.some(artifact => artifact.artifactId === 'persona:current' && artifact.publicationState === 'revoked')) {
      await repairPersona();
      current = await registry.getMany(value.internalArtifacts.map(artifact => artifact.artifactId), true);
    }
    if (value.internalArtifacts.some(reference => {
      const artifact = current.find(artifact => artifact.artifactId === reference.artifactId);
      // A later persona can acquire and then lose unrelated private traits.
      // Its withdrawal must not erase an older task's independent origin role.
      return !artifact || artifact.publicationState === 'revoked' && artifact.contentRevision === reference.contentRevision && artifact.contentHash === reference.contentHash;
    })
      || !await registry.validateReferences(value.externalRefs)) throw new Error('任务初始人格、用途指导或其真实来源已经撤回，旧快照不能继续使用。');
    await validateSources(value.ownerId, value.rawSources, request);
  };
  await validate();
  const after = await epoch(value.ownerId, request);
  if (after !== before && (value.externalRefs.length || value.rawSources.length)) await validate();
  return after;
}

/** The first complete admission is durable before any provider sees it. The
 * promise only coalesces simultaneous preparation; later gates recheck ACLs. */
export async function prepareCompanionTaskAssets(binding: CompanionTaskAssetBinding, ports: {
  load(): Promise<CompanionAssetProfileSnapshot>; registry(): Promise<CompanionArtifactRegistry>; request: Request;
}): Promise<CompanionTaskAssets> {
  const checkpoint = binding.checkpoint;
  if (checkpoint.taskAssets) return readCompanionTaskAssets(checkpoint.taskAssets, checkpoint);
  const pending = preparations.get(checkpoint); if (pending) return pending;
  // Role publication can advance while the task recalls other information.
  // Its complete initial package therefore owns a separate finite admission;
  // the mutable current-role files are no longer live outer-frame witnesses
  // after the exact package has passed its fence and been durably sealed.
  const admission = createCompanionExecutionValidationSession();
  const capture = async () => {
    const snapshot = await ports.load(), registry = await ports.registry(), paths = Object.keys(snapshot.fileRevisions);
    const artifacts = await registry.getManyByPaths(paths);
    if (paths.some(file => !artifacts.some(artifact => artifact.relativePath === file && artifact.contentHash === snapshot.fileRevisions[file])))
      throw new Error('完整角色版本在任务封存期间改变，请重新准备。');
    const internalArtifacts = artifacts.map(artifact => ({ artifactId: artifact.artifactId, contentRevision: artifact.contentRevision, contentHash: artifact.contentHash })),
      internal = new Set(internalArtifacts.map(artifact => artifact.artifactId));
    // Persona/fragment metadata aggregates all audiences. Only the projected
    // fragments actually used by this task may become its source witnesses.
    const visibleFragments = snapshot.personaFragments.fragments.filter(fragment => companionPersonaFragmentVisible(fragment.visibility, [checkpoint.conversationId]));
    const externalRefs = [...new Map([...artifacts.filter(artifact => artifact.kind !== 'persona_current' && artifact.artifactId !== 'host:fragments')
      .flatMap(artifact => [...artifact.sourceRefs, ...artifact.dependencyRefs]),
      ...visibleFragments.flatMap(fragment => [...fragment.sourceRefs, ...fragment.dependencyRefs])]
      .filter(reference => !internal.has(reference.artifactId)).map(reference => [JSON.stringify(reference), reference])).values()];
    const goals = await ports.request({ type: 'growth.goals.list', companionId: checkpoint.companionId, conversationId: checkpoint.conversationId, limit: 20 });
    if (!goals.ok) throw new Error('任务初始培养方向暂不可核验。');
    const cultivationGoals = (goals.growthGoals ?? []).filter(goal => goal.companionId === checkpoint.companionId
      && goal.conversationId === checkpoint.conversationId && !['paused', 'retired'].includes(goal.status));
    const rawSources = cultivationGoals.flatMap(goal => goal.sources.map(source => ({ id: source.messageId,
      conversationId: goal.conversationId, checksum: source.contentHash, revision: source.revision })));
    for (const reference of externalRefs) {
      const source = /^source:([a-zA-Z0-9_-]{1,100}):r([1-9][0-9]*)$/.exec(reference.artifactId); if (!source) continue;
      const message = (await ports.request({ type: 'message.get', id: source[1]! })).message;
      if (!message) throw new Error('人格快照缺少真实原始来源。');
      rawSources.push({ id: message.id, conversationId: message.conversationId, checksum: reference.contentHash, revision: Number(source[2]) });
    }
    const value = companionTaskAssetsSchema.parse({ schema: 'worldlinebox.task-assets-v1', ownerId: checkpoint.companionId,
      conversationId: checkpoint.conversationId, sourceMessageId: checkpoint.sourceMessageId, invocationKey: checkpoint.invocationKey,
      capturedAt: new Date().toISOString(), captureMode: binding.legacy ? 'legacy_first_admission' : 'task_initial',
      revocationEpoch: await epoch(checkpoint.companionId, ports.request), snapshot, cultivationGoals, internalArtifacts, externalRefs,
      rawSources: [...new Map(rawSources.map(source => [JSON.stringify(source), source])).values()] });
    await validateCompanionTaskAssets(value, registry, ports.request);
    return value;
  };
  const operation = (async () => {
    try {
      const value = await admission.run(capture);
      await admission.validate(); admission.close();
      checkpoint.taskAssets = JSON.stringify(value);
      try { await binding.save(); } catch (error) { delete checkpoint.taskAssets; throw error; }
      return value;
    } finally { admission.close(); }
  })();
  preparations.set(checkpoint, operation);
  try { return await operation; } finally { if (preparations.get(checkpoint) === operation) preparations.delete(checkpoint); }
}

export function companionTaskAssetsDigest(value: CompanionTaskAssets): string { return digest(JSON.stringify(value)); }
