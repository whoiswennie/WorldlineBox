import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { Companion, CompanionMemory, CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionContextFrame, CompanionGrowthGoal } from '../../src/shared/companion-cognition';
import { CompanionAssetProfileStore, projectCompanionAssetProfile } from '../../src/main/companions/asset-profile';
import { CompanionGrowthService, companionGrowthSourceArtifactId, validateCompanionPersonaPublication } from '../../src/main/companions/growth-service';
import { CompanionArtifactError, companionArtifactHash } from '../../src/main/companions/artifact-registry';
import { CompanionModelError, type generateCompanionStructured } from '../../src/main/companions/model';
import { registryStorageFixture } from '../fixtures/companion-registry-storage';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionAssetIo } from '../../src/main/companions/asset-io';
import { prepareCompanionTaskAssets, readCompanionTaskAssets, validateCompanionTaskAssets, type CompanionTaskAssetBinding } from '../../src/main/companions/task-asset-snapshot';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true } }));

const roots: string[] = [];
const databases: Array<{ close(): void }> = [];
afterEach(async () => { vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-growth-')) throw new Error('Unexpected test cleanup');
  await rm(root, { recursive: true, force: true });
} });
const owner: Companion = { id: 'alice', name: 'Alice', description: '测试角色', persona: '我愿意认真对待交流。\n\n我仍在了解自己的表达习惯。',
  model: '', avatar: 'sister', builtin: true, proactive: false, active: true, createdAt: '2026-10-28T10:00:00Z' };
const scope = { companionId: owner.id, conversationId: 'private_room' };
async function control(service: CompanionGrowthService, id: string, action: 'park' | 'resume' | 'abandon') {
  const current = await service.inspectJob(owner.id, id); if (!current) throw new Error('Expected exact current growth job');
  return service.controlJob({ type: 'jobs.control', ownerId: owner.id, kind: 'growth', id, inputVersion: current.inputVersion,
    expectedRevision: current.revision, operationId: randomUUID(), action });
}
async function fixture(background = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-growth-')); roots.push(root);
  const database = registryStorageFixture(root, ['alice', 'bob']); databases.push(database);
  const now = '2026-10-28T10:00:00Z'; let epoch = 0, failValidation = false, failPersonaCommit = false, failControlCommit = false, failControlPrepare = false, sourceVisible = true, active = true;
  let goals: CompanionGrowthGoal[] = [];
  const extraSources: CompanionMessage[] = [];
  let debt: { generation: number; cursor?: string } | undefined; const acknowledgements: number[] = [];
  const source: CompanionMessage = { id: 'message_one', sequence: 1, conversationId: scope.conversationId, authorId: owner.id, kind: 'text',
    content: '我发现先确认不确定的部分，更能让我把事情解释清楚。', createdAt: now, status: 'sent', attachments: [], revision: 1 };
  const note: CompanionMemory = { id: 'understanding_one', companionId: owner.id, scopeId: 'scope_one', artifactKind: 'self_understanding',
    content: source.content + '\n\n适用认识：我倾向先说明未知，再提供有条件的建议。依据是这次实际交流。',
    metadata: { characterDevelopment: { kind: 'voice', topic: '有条件表达', statement: source.content, basis: 'self_expression', supersedesMemoryIds: [] } },
    tags: ['表达'], diaryName: '自我认识', sourceMessageId: source.id, sourceConversationId: background ? `world_${owner.id}` : scope.conversationId,
    sources: [{ messageId: source.id, conversationId: scope.conversationId, sequence: source.sequence, authorId: source.authorId, revision: 1,
      checksum: companionArtifactHash(source.content), createdAt: now }], sourceSequence: 1, createdAt: now, updatedAt: now, origin: 'companion', status: 'indexed', version: 1, contentRevision: 1, captureMethod: 'automatic' };
  const requestStorage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    switch (command.type) {
      case 'state': return { ok: true, state: { companions: [{ ...owner, active }], conversations: [], resetJobs: [], activities: [], configured: true } };
      case 'character.development.scopes.page': return { ok: true, characterDevelopmentScopes: {
        items: debt && !command.afterCompanionId ? [{ ...scope, ...debt }] : [], hasMore: false } };
      case 'character.development.scopes.ack': {
        acknowledgements.push(command.expectedGeneration); const accepted = debt?.generation === command.expectedGeneration;
        if (accepted) debt = command.nextCursor ? { generation: debt!.generation, cursor: command.nextCursor } : undefined;
        return { ok: true, characterDevelopmentScopeAcknowledged: accepted };
      }
      case 'character.development': return { ok: true, characterDevelopment: { companionId: owner.id, conversationId: command.conversationId,
        observedAt: now, truncated: false, items: [{ memoryId: note.id, memoryVersion: note.version, kind: 'voice', topic: '有条件表达', statement: source.content,
          basis: 'self_expression', sourceMessageIds: [source.id], updatedAt: now }] } };
      case 'growth.goals.list': return { ok: true, growthGoals: goals.filter(goal => goal.conversationId === command.conversationId) };
      case 'memory.lifecycle.state': return { ok: true, memoryLifecycleState: { companionId: owner.id, ledgerSequence: 1, revocationEpoch: epoch } };
      case 'memory.records.filter': return { ok: true, memories: command.ids.includes(note.id) ? [note] : [] };
      case 'memory.sources.filter': return { ok: true, memorySources: sourceVisible ? [source, ...extraSources].filter(item => command.ids.includes(item.id)) : [] };
      default: throw new Error(`Unexpected fixture storage command ${command.type}`);
    }
  });
  const profiles = new CompanionAssetProfileStore(root, {
    registryStorage: { request: async command => {
      if (failControlCommit && command.type === 'cognition.registry.publication.commit' && command.operationId.startsWith('growth-control:')) {
        failControlCommit = false; throw new Error('fixture crash after control files before commit');
      }
      if (failControlPrepare && command.type === 'cognition.registry.publication.prepare' && command.publication.operationId.startsWith('growth-control:')) {
        failControlPrepare = false; await database.storage.request(command); throw new Error('fixture crash after control prepare before stages');
      }
      if (failPersonaCommit && command.type === 'cognition.registry.publication.commit' && command.operationId.startsWith('persona:')) {
        failPersonaCommit = false; throw new Error('fixture crash before persona metadata commit');
      }
      return database.storage.request(command);
    } },
    validatePersonaPublication: async proposal => { if (failValidation) { failValidation = false; throw new Error('injected restart before validation'); }
      await validateCompanionPersonaPublication(proposal, { requestStorage, profiles }); },
  });
  const initial = await profiles.bootstrap(owner), registry = await profiles.artifacts(owner.id);
  const sourceArtifact = await registry.publish({ artifactId: companionGrowthSourceArtifactId(source.id, 1), kind: 'source_evidence', producer: { kind: 'host', id: 'message:one' },
    relativePath: '证据/来源/message_one-r1.md', content: source.content, expectedRevision: null, sourceRefs: [], dependencyRefs: [],
    visibility: { scope: 'audience', audienceIds: [scope.conversationId] }, allowedConsumers: ['source_verification', 'audit'], retentionClass: 'evidence', operationId: 'source:one' });
  const sourceRef = { artifactId: sourceArtifact.artifactId, contentRevision: sourceArtifact.contentRevision, contentHash: sourceArtifact.contentHash };
  await registry.publish({ artifactId: `memory:${note.id}`, kind: 'self_understanding', producer: { kind: 'system', id: 'reflection:one' },
    relativePath: '记忆/自我认识/main/understanding_one.md', content: note.content, expectedRevision: null, sourceRefs: [sourceRef], dependencyRefs: [],
    visibility: { scope: 'audience', audienceIds: [scope.conversationId] }, allowedConsumers: ['self_integration', 'self_recall', 'audit'], retentionClass: 'current', operationId: 'understanding:one' });
  const validOutput = { decisions: [{ action: 'qualify', fragmentId: initial.personaFragments.fragments[0]!.fragmentId,
    expectedHash: initial.personaFragments.fragments[0]!.contentHash, text: 'PRIVATE_CANARY：我愿意认真交流；给建议时会先说明未知和适用条件。',
    supportingNoteIds: [note.id], reason: '一次真实表达给出了值得练习的具体方向，先保留条件。', applicableBehavior: '给出建议前先说明未知。', reevaluateWhen: '遇到反例或后续交流不适用时重新审视。' }], noChangeReason: '' };
  const make = (generate: typeof generateCompanionStructured) => new CompanionGrowthService({ profiles, requestStorage, getConfig: async () => ({ apiFormat: 'openai_chat', model: 'deterministic-fixture', apiKey: 'fixture-not-a-secret' }),
    generateStructured: generate, report: vi.fn() });
  return { root, registry, profiles, initial, source, note, requestStorage, validOutput, make, registryCommands: database.commands,
    setDebt: (generation: number) => { debt = { generation }; }, debt: () => debt, acknowledgements,
    addSource: (message: CompanionMessage) => { extraSources.push(message); },
    setGoals: (value: CompanionGrowthGoal[]) => { goals = value; },
    revokeEpoch: () => { epoch++; }, withdrawSource: () => { epoch++; sourceVisible = false; }, failNextValidation: () => { failValidation = true; },
    failNextPersonaCommit: () => { failPersonaCommit = true; }, failNextControlCommit: () => { failControlCommit = true; },
    failNextControlPrepare: () => { failControlPrepare = true; }, setActive: (value: boolean) => { active = value; } };
}

it('T-018/T-024/T-044 submits a grounded local change that changes later identity and keeps private formation scoped', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockResolvedValue(f.validOutput), service = f.make(generate);
  expect((await service.runOnce(scope)).status).toBe('published');
  const current = await f.profiles.load(owner.id);
  expect(current.profileRevision).not.toBe(f.initial.profileRevision);
  expect(projectCompanionAssetProfile(current, [scope.conversationId]).persona).toContain('PRIVATE_CANARY');
  expect(projectCompanionAssetProfile(current, ['another_room']).persona).not.toContain('PRIVATE_CANARY');
  expect(projectCompanionAssetProfile(current, ['another_room']).persona).toContain('我仍在了解自己的表达习惯');
  expect((await f.registry.read({ artifactId: 'origin:creation', consumer: 'audit' })).text).toContain(owner.persona);
  expect((await service.runOnce(scope)).status).toBe('no_input'); expect(generate).toHaveBeenCalledTimes(1);
});

it('keeps an admitted task initial identity across a real grounded growth publication while new tasks see the scoped trait and actual withdrawal stops its users', async () => {
  const f = await fixture(), io = new CompanionAssetIo(), saved = new Map<string, CompanionLoopCheckpoint>();
  const goalSource: CompanionMessage = { ...f.source, id: 'cultivation_source', authorId: 'user', sequence: 2,
    content: '请在给建议时练习先说明未知，再保留适用条件。' };
  f.addSource(goalSource);
  const rooms = [
    { id: scope.conversationId, kind: 'private' as const, title: owner.name, memberIds: [owner.id], pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: owner.createdAt },
    { id: 'unrelated_group', kind: 'group' as const, title: '另一个真实入口', memberIds: [owner.id, 'bob'], pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: owner.createdAt },
  ];
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'state') { const current = await f.requestStorage(command); return { ...current, state: { ...current.state!, conversations: rooms } }; }
    if (command.type === 'message.get') return { ok: true, message: [f.source, goalSource].find(source => source.id === command.id) };
    if (command.type === 'loop.get') return { ok: true, loop: saved.get(command.sourceMessageId) };
    return f.requestStorage(command);
  };
  const host = Object.assign(Object.create(CompanionService.prototype), { assetProfiles: f.profiles, assetIo: io, storage: { request }, call: request,
    options: {} }) as {
    prepareModelAssetContext(ownerId: string, context: { system: string; user: string }, kind: 'reply', native?: undefined, purpose?: undefined, task?: CompanionTaskAssetBinding): Promise<{ system: string; user: string; frame: CompanionContextFrame }>;
    validateTaskAssetFrame(frame: CompanionContextFrame): Promise<void>;
  };
  const task = (id: string, conversationId = scope.conversationId, assets?: string): CompanionTaskAssetBinding => {
    const checkpoint: CompanionLoopCheckpoint = { companionId: owner.id, conversationId, sourceMessageId: id, status: 'running', turns: [], supplements: [], taskAssets: assets };
    return { checkpoint, save: vi.fn(async () => { saved.set(id, structuredClone(checkpoint)); }) };
  };
  const prepare = (binding: CompanionTaskAssetBinding) => host.prepareModelAssetContext(owner.id, { system: '只按本轮真实来源和已确认工具回执交流。',
    user: JSON.stringify({ purpose: 'companion_reply', invocation: { conversationId: binding.checkpoint.conversationId } }) }, 'reply', undefined, undefined, binding);
  const ports = { load: () => f.profiles.load(owner.id), registry: () => f.profiles.artifacts(owner.id), request };
  try {
    const oldTask = task('before_growth'), original = await prepareCompanionTaskAssets(oldTask, ports), before = await prepare(oldTask), oldBlob = oldTask.checkpoint.taskAssets!;
    expect(original.snapshot.profile.persona).toBe(f.initial.profile.persona);
    expect(original.snapshot.modules).toEqual(f.initial.modules);
    expect(original.externalRefs).toEqual([]); expect(original.rawSources).toEqual([]);
    const goal: CompanionGrowthGoal = { id: 'practice_direction', companionId: owner.id, conversationId: scope.conversationId, authorId: 'user', revision: 1,
      statement: goalSource.content, context: '在当前交流中练习，不自动成为稳定人格。', examples: [], counterexamples: [], practice: [], status: 'practicing',
      createdAt: owner.createdAt, updatedAt: owner.createdAt, sources: [{ messageId: goalSource.id, revision: 1, contentHash: companionArtifactHash(goalSource.content) }] };
    f.setGoals([goal]);
    const generate = vi.fn<typeof generateCompanionStructured>().mockResolvedValue(f.validOutput);
    expect((await f.make(generate).runOnce(scope)).status).toBe('published');
    const current = await f.profiles.load(owner.id); expect(current.profile.persona).toContain('PRIVATE_CANARY');
    const continuation = await prepare(oldTask), restartedTask = task('before_growth', scope.conversationId, oldBlob), restarted = await prepare(restartedTask);
    expect(continuation.system).toBe(before.system); expect(restarted.system).toBe(before.system);
    expect(JSON.parse(continuation.user).cultivationGoals.items).toEqual([]);
    expect(oldTask.checkpoint.taskAssets).toBe(oldBlob);
    const newTask = task('after_growth'), next = await prepare(newTask), nextPackage = readCompanionTaskAssets(newTask.checkpoint.taskAssets!, newTask.checkpoint);
    expect(next.system).toContain('PRIVATE_CANARY'); expect(next.frame.identity).toBe(current.profile.persona);
    expect(nextPackage.snapshot.personaFragments).toEqual(current.personaFragments);
    expect(nextPackage.snapshot.modules).toEqual(current.modules);
    expect(JSON.parse(next.user).cultivationGoals.items).toEqual([goal]);
    const role = current.modules.find(module => module.purposes.includes('companion_reply'))!, registeredRole = (await f.registry.findByPath(role.path))!;
    expect(nextPackage.internalArtifacts.find(reference => reference.artifactId === registeredRole.artifactId)?.contentRevision)
      .toBeGreaterThan(original.internalArtifacts.find(reference => reference.artifactId === registeredRole.artifactId)!.contentRevision);
    const groupTask = task('group_after_growth', 'unrelated_group'), group = await prepare(groupTask), groupPackage = readCompanionTaskAssets(groupTask.checkpoint.taskAssets!, groupTask.checkpoint);
    expect(group.system).not.toContain('PRIVATE_CANARY'); expect(group.frame.identity).not.toContain('PRIVATE_CANARY');
    expect(group.system).toContain('我仍在了解自己的表达习惯'); expect(group.user).not.toContain(goalSource.content);
    expect(groupPackage.externalRefs.map(reference => reference.artifactId)).not.toContain(companionGrowthSourceArtifactId(f.source.id, 1));
    expect(groupPackage.externalRefs.map(reference => reference.artifactId)).not.toContain(companionGrowthSourceArtifactId(goalSource.id, 1));
    expect(groupPackage.rawSources.map(source => source.id)).not.toContain(f.source.id);
    expect(groupPackage.rawSources.map(source => source.id)).not.toContain(goalSource.id);
    await expect(host.validateTaskAssetFrame(next.frame)).resolves.toBeUndefined();
    await f.registry.revoke(companionGrowthSourceArtifactId(f.source.id, 1)); f.withdrawSource();
    await expect(validateCompanionTaskAssets(nextPackage, f.registry, request)).rejects.toThrow('撤回');
    await expect(host.validateTaskAssetFrame(next.frame)).rejects.toThrow('撤回');
    await expect(prepare(newTask)).rejects.toMatchObject({ code: 'CANCELLED' });
    const repaired = await f.profiles.load(owner.id); expect(repaired.profile.persona).not.toContain('PRIVATE_CANARY');
    await expect(validateCompanionTaskAssets(original, f.registry, request)).resolves.toBeTypeOf('number');
    expect((await prepare(restartedTask)).system).toBe(before.system);
    await expect(host.validateTaskAssetFrame(before.frame)).resolves.toBeUndefined();
    await expect(host.validateTaskAssetFrame(group.frame)).resolves.toBeUndefined();
    expect((await prepare(groupTask)).system).toBe(group.system);
  } finally { await io.close(); }
});

it('T-014/T-044 publishes background reflection for its real private source audience and owner internal scope', async () => {
  const f = await fixture(true), generate = vi.fn<typeof generateCompanionStructured>().mockResolvedValue(f.validOutput);
  expect((await f.make(generate).runOnce({ companionId: owner.id, conversationId: `world_${owner.id}` })).status).toBe('published');
  const current = await f.profiles.load(owner.id);
  expect(projectCompanionAssetProfile(current, [scope.conversationId]).persona).toContain('PRIVATE_CANARY');
  expect(projectCompanionAssetProfile(current, []).persona).toContain('PRIVATE_CANARY');
  expect(projectCompanionAssetProfile(current, ['unrelated_group']).persona).not.toContain('PRIVATE_CANARY');
  expect(current.personaFragments.fragments.find(fragment => fragment.contentHash === companionArtifactHash(f.validOutput.decisions[0]!.text))?.visibility)
    .toEqual({ scope: 'audience', audienceIds: [scope.conversationId] });
});

it('T-031/T-032 retracts only affected current fragments and keeps the companion available without reviving an old trait', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockResolvedValue(f.validOutput);
  expect((await f.make(generate).runOnce(scope)).status).toBe('published');
  await f.registry.revoke(companionGrowthSourceArtifactId(f.source.id, 1));
  const repaired = await f.profiles.load(owner.id);
  expect(repaired.profile.persona).not.toContain('PRIVATE_CANARY');
  expect(repaired.profile.persona).not.toContain('我愿意认真对待交流。');
  expect(repaired.profile.persona).toContain('我仍在了解自己的表达习惯。');
  expect(projectCompanionAssetProfile(repaired, ['unrelated_group']).persona).toContain('我仍在了解自己的表达习惯。');
  expect((await f.profiles.load(owner.id)).profileRevision).toBe(repaired.profileRevision);
  for (const artifact of (await f.registry.list()).filter(value => value.kind === 'role_guidance'))
    expect((await f.registry.read({ artifactId: artifact.artifactId, consumer: 'role' })).artifact.dependencyRefs.some(reference => reference.contentHash === repaired.profileRevision)).toBe(true);
});

it('T-014/T-018 keeps background cultivation goals in their real source domain and in the published dependency closure', async () => {
  const f = await fixture(true);
  const goalSource: CompanionMessage = { ...f.source, id: 'goal_direction', authorId: 'user', sequence: 2, content: '请练习先说明未知，再有条件地建议。' };
  f.addSource(goalSource); f.setGoals([{ id: 'goal_private', companionId: owner.id, conversationId: scope.conversationId, revision: 1,
    authorId: 'user', status: 'practicing', statement: goalSource.content, context: '只在当前真实交流练习', examples: [], counterexamples: [], practice: [],
    createdAt: owner.createdAt, updatedAt: owner.createdAt, sources: [{ messageId: goalSource.id, revision: 1, contentHash: companionArtifactHash(goalSource.content) }] }]);
  const generate = vi.fn<typeof generateCompanionStructured>().mockResolvedValue(f.validOutput), service = f.make(generate);
  expect((await service.runOnce({ companionId: owner.id, conversationId: `world_${owner.id}` })).status).toBe('published');
  expect(JSON.parse(generate.mock.calls[0]![0].user).goals[0].id).toBe('goal_private');
  const current = await f.profiles.load(owner.id), learned = current.personaFragments.fragments.find(fragment => current.profile.persona.slice(fragment.start, fragment.end).includes('PRIVATE_CANARY'))!;
  expect(learned.sourceRefs.map(reference => reference.artifactId)).toContain(companionGrowthSourceArtifactId(goalSource.id, 1));
  expect(learned.visibility).toEqual({ scope: 'audience', audienceIds: [scope.conversationId] });
  await f.registry.revoke(companionGrowthSourceArtifactId(goalSource.id, 1));
  expect((await f.profiles.load(owner.id)).profile.persona).not.toContain('PRIVATE_CANARY');
});

it('T-031/T-036 physically removes withdrawn growth output and release bodies through indexed cleanup debt', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockResolvedValue(f.validOutput), service = f.make(generate);
  expect((await service.runOnce(scope)).status).toBe('published');
  const checkpoint = (await f.registry.list('host', { kind: 'runtime_index', prefix: 'growth-checkpoint:' }))[0]!;
  const release = (await f.registry.list('audit', { kind: 'growth_publish' }))[0]!;
  const beforeRead = f.registryCommands.length, jobs = await service.listJobs(owner.id, 5);
  expect(jobs[0]?.status).toBe('published'); expect(JSON.stringify(jobs)).not.toContain('PRIVATE_CANARY');
  expect(f.registryCommands.slice(beforeRead).some(command => !['cognition.registry.read', 'cognition.registry.page', 'cognition.registry.refs.validate'].includes(command.type))).toBe(false);
  expect(checkpoint.sourceRefs.map(reference => reference.artifactId)).toContain(companionGrowthSourceArtifactId(f.source.id, 1));
  expect(await readFile(path.join((await f.profiles.load(owner.id)).root, checkpoint.relativePath), 'utf8')).toContain('PRIVATE_CANARY');
  await f.registry.revoke(companionGrowthSourceArtifactId(f.source.id, 1)); f.withdrawSource();
  const purged = await service.purgeOwner(owner.id); expect(purged.removed).toBe(2);
  for (const artifact of [checkpoint, release]) await expect(readFile(path.join((await f.profiles.load(owner.id)).root, artifact.relativePath))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await f.registry.page({ kind: 'runtime_index', prefix: 'growth-checkpoint:', publicationState: 'revoked', bodyCleanupRequired: true })).items).toEqual([]);
  expect((await service.purgeOwner(owner.id)).removed).toBe(0);
  expect((await f.profiles.load(owner.id)).profile.persona).not.toContain('PRIVATE_CANARY');
  expect((await f.make(generate).runOnce(scope)).status).toBe('no_input'); expect(generate).toHaveBeenCalledTimes(1);
});

it('T-019/T-020/T-039 settles no-change once and does not treat a rewritten self note as new raw experience', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockResolvedValue({ decisions: [], noChangeReason: '目前依据不足，保持原有认识。' }), service = f.make(generate);
  expect((await service.runOnce(scope)).status).toBe('no_change');
  const original = (await f.registry.list()).find(value => value.artifactId === `memory:${f.note.id}`)!;
  f.note.content += '这里只是同源重新措辞。'; f.note.version++; f.note.contentRevision = 2;
  const { schema, ownerId, contentRevision, contentHash, publicationState, operationId, committedAt, ...metadata } = original;
  void schema; void ownerId; void contentHash; void publicationState; void operationId; void committedAt;
  await f.registry.publish({ ...metadata, content: f.note.content, expectedRevision: contentRevision, operationId: 'understanding:reworded' });
  expect((await f.make(generate).runOnce(scope)).status).toBe('no_input'); expect(generate).toHaveBeenCalledTimes(1);
  expect((await f.profiles.load(owner.id)).profileRevision).toBe(f.initial.profileRevision);
});

it('T-027/T-029 acknowledges only the reviewed generation and revisits newer durable debt without another model call', async () => {
  const f = await fixture(); f.setDebt(1);
  const generate = vi.fn<typeof generateCompanionStructured>().mockImplementation(async () => {
    f.setDebt(2); return { decisions: [], noChangeReason: '真实依据没有支持新的稳定变化。' };
  });
  const service = f.make(generate);
  expect((await service.runOnce(scope)).status).toBe('no_change'); expect(f.debt()?.generation).toBe(2);
  expect((await service.runOnce(scope)).status).toBe('no_input'); expect(f.debt()).toBeUndefined();
  expect(f.acknowledgements).toEqual([1, 2]); expect(generate).toHaveBeenCalledTimes(1); await service.close();
});

it('T-027 starts the bounded periodic debt scanner only after readiness and revisits debt without a fresh note event', async () => {
  const f = await fixture(); f.setDebt(1);
  const generate = vi.fn<typeof generateCompanionStructured>().mockResolvedValue({ decisions: [], noChangeReason: '暂时保持原有认识。' });
  const service = f.make(generate); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    service.wake(scope); expect(generate).not.toHaveBeenCalled();
    service.start(); await vi.waitFor(() => expect(f.acknowledgements).toEqual([1]), { timeout: 10000 });
    f.setDebt(2); await vi.advanceTimersByTimeAsync(60000);
    await vi.waitFor(() => expect(f.acknowledgements).toEqual([1, 2]), { timeout: 10000 });
    expect(generate).toHaveBeenCalledTimes(1);
  } finally { await service.close(); vi.useRealTimers(); }
});

it('T-015/T-018 rejects goal-only self descriptions as proof of an acquired personality', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockResolvedValue(f.validOutput);
  f.setGoals([{ id: 'goal_one', companionId: owner.id, conversationId: scope.conversationId, revision: 1, status: 'proposed', authorId: owner.id,
    statement: '希望学会更清楚地表达', context: '这是练习方向', examples: [], counterexamples: [], practice: ['先说明未知'],
    createdAt: owner.createdAt, updatedAt: owner.createdAt, sources: [{ messageId: f.source.id, revision: 1, contentHash: companionArtifactHash(f.source.content) }] }]);
  expect((await f.make(generate).runOnce(scope)).status).toBe('no_input'); expect(generate).not.toHaveBeenCalled();
  expect((await f.profiles.load(owner.id)).profileRevision).toBe(f.initial.profileRevision);
});

it('T-030 reevaluates saved exact ranges after an unrelated epoch change without paying for another generation', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockImplementation(async () => { f.revokeEpoch(); return f.validOutput; });
  const service = f.make(generate), result = await service.runOnce(scope);
  expect(result.status).toBe('stale'); expect((await f.profiles.load(owner.id)).profileRevision).toBe(f.initial.profileRevision);
  expect((await f.make(generate).runOnce(scope)).status).toBe('published'); expect(generate).toHaveBeenCalledTimes(1);
});

it('T-031 blocks a paid result after real source withdrawal during generation', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockImplementation(async () => { f.withdrawSource(); return f.validOutput; });
  expect((await f.make(generate).runOnce(scope)).status).toBe('stale');
  expect((await f.make(generate).runOnce(scope)).status).toBe('stale');
  expect((await f.profiles.load(owner.id)).profileRevision).toBe(f.initial.profileRevision); expect(generate).toHaveBeenCalledTimes(1);
});

it('T-028/T-029 resumes a generated checkpoint and pending publication across restart without another model call', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockImplementation(async () => { f.failNextValidation(); return f.validOutput; });
  expect((await f.make(generate).runOnce(scope)).status).toBe('stale');
  expect(generate).toHaveBeenCalledTimes(1);
  const recovered = await f.make(generate).runOnce(scope);
  expect(recovered.status).toBe('published'); expect(generate).toHaveBeenCalledTimes(1);
  expect((await f.profiles.load(owner.id)).profile.persona).toContain('PRIVATE_CANARY');
});

it('T-028 resumes only the exact saved paid persona publication before opening the startup model fence', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockImplementation(async () => { f.failNextPersonaCommit(); return f.validOutput; });
  const result = await f.make(generate).runOnce(scope);
  const checkpoint: { state: string; output: unknown; proposal: { operationId: string } } = JSON.parse(
    (await f.registry.read({ artifactId: `growth-checkpoint:${result.jobId}`, consumer: 'host' })).text);
  const operationId = checkpoint.proposal.operationId;
  const publication = await f.registry.publication(operationId);
  expect(result.status).toBe('stale');
  expect(result.reason).toContain('fixture crash before persona metadata commit');
  expect(publication?.state).toBe('file_published');
  expect(checkpoint).toMatchObject({ state: 'stale', output: f.validOutput, proposal: { operationId } });
  await expect(f.profiles.load(owner.id)).rejects.toBeDefined();
  const restarted = f.make(generate);
  expect(await restarted.resumePreparedPublications(owner.id)).toEqual({ resumed: 1 });
  expect((await f.profiles.load(owner.id)).profile.persona).toContain('PRIVATE_CANARY'); expect(generate).toHaveBeenCalledTimes(1);
  expect(await restarted.resumePreparedPublications(owner.id)).toEqual({ resumed: 0 }); await restarted.close();
});

it('does not restart a stale paid checkpoint without an exact pending persona publication', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockImplementation(async () => { f.failNextValidation(); return f.validOutput; });
  const result = await f.make(generate).runOnce(scope);
  expect(result.status).toBe('stale');
  const artifactId = `growth-checkpoint:${result.jobId}`, before = await f.registry.read({ artifactId, consumer: 'host' });
  const checkpoint: { proposal: { operationId: string } } = JSON.parse(before.text);
  expect(await f.registry.publication(checkpoint.proposal.operationId)).toBeUndefined();
  const restarted = f.make(generate);
  expect(await restarted.resumePreparedPublications(owner.id)).toEqual({ resumed: 0 });
  expect(await f.registry.read({ artifactId, consumer: 'host' })).toEqual(before);
  expect((await f.profiles.load(owner.id)).profileRevision).toBe(f.initial.profileRevision);
  expect(generate).toHaveBeenCalledTimes(1); await restarted.close();
});

it('resumes the exact paid persona writer even when eight newer unrelated stale checkpoints hide its state-list page', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockImplementation(async () => { f.failNextPersonaCommit(); return f.validOutput; });
  const result = await f.make(generate).runOnce(scope);
  expect(result.status).toBe('stale');
  const saved = await f.registry.read({ artifactId: `growth-checkpoint:${result.jobId}`, consumer: 'host' }), body = JSON.parse(saved.text);
  expect((await f.registry.publication(body.proposal.operationId))?.state).toBe('file_published');
  // Other scopes can have fixed inputs waiting for model admission. The
  // pending persona fence makes their next validation stale without another
  // generation; their updated receipts must not hide the paid writer.
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 1000);
  const items = Array.from({ length: 8 }, (_, index) => {
    const key = companionArtifactHash('newer-unrelated-stale-' + index), checkpoint = { ...body, key, conversationId: `other_room_${index}`,
      output: undefined, proposal: undefined, disposition: { ...body.disposition, id: key } };
    return { artifactId: `growth-checkpoint:${key}`, kind: 'runtime_index' as const, relativePath: `.运行/视图/人格学习/${key}.json`,
      content: JSON.stringify(checkpoint) + '\n', expectedRevision: null, producer: { kind: 'host' as const, id: 'growth:checkpoint:stale' },
      sourceRefs: saved.artifact.sourceRefs, dependencyRefs: [], visibility: { scope: 'owner' as const }, allowedConsumers: ['host' as const], retentionClass: 'runtime' as const };
  });
  const shadows = await f.registry.publishBatch({ operationId: 'fixture:newer-unrelated-stale', items });
  expect((await f.registry.list('host', { kind: 'runtime_index', producerId: 'growth:checkpoint:stale', newestFirst: true, limit: 8 }))
    .some(artifact => artifact.artifactId === saved.artifact.artifactId)).toBe(false);
  const mark = f.registryCommands.length, restarted = f.make(generate);
  expect(await restarted.resumePreparedPublications(owner.id)).toEqual({ resumed: 1 });
  expect((await f.registry.publication(body.proposal.operationId))?.state).toBe('committed');
  expect((await f.profiles.load(owner.id)).profile.persona).toContain('PRIVATE_CANARY');
  expect((await f.registry.getMany(shadows.map(artifact => artifact.artifactId))).toSorted((a, b) => a.artifactId.localeCompare(b.artifactId)))
    .toEqual(shadows.toSorted((a, b) => a.artifactId.localeCompare(b.artifactId)));
  expect(generate).toHaveBeenCalledTimes(1);
  const reads = f.registryCommands.slice(mark);
  expect(reads.some(command => command.type === 'cognition.registry.publication.pending' && command.artifactId === 'persona:current'
    && command.previousTarget === true && command.baseRevision === 1 && command.limit === 2)).toBe(true);
  expect(reads.some(command => command.type === 'cognition.registry.page' && command.prefix === `growth-checkpoint:${body.key.slice(0, 48)}`
    && command.limit === 2)).toBe(true);
  await restarted.close();
});

it.each(['withdrawn', 'changed'] as const)('keeps a saved persona publication fenced when its exact source is %s before startup', async failure => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockImplementation(async () => { f.failNextPersonaCommit(); return f.validOutput; });
  const result = await f.make(generate).runOnce(scope);
  expect(result.status).toBe('stale');
  const checkpoint: { proposal: { operationId: string } } = JSON.parse(
    (await f.registry.read({ artifactId: `growth-checkpoint:${result.jobId}`, consumer: 'host' })).text);
  const before = await f.registry.publication(checkpoint.proposal.operationId);
  expect(before?.state).toBe('file_published');
  if (failure === 'withdrawn') f.withdrawSource();
  else { expect(f.source.revision).toBe(1); f.source.revision = 2; f.source.content += ' 后续改写不属于原固定读集。'; }
  const restarted = f.make(generate);
  const recovering = restarted.resumePreparedPublications(owner.id);
  await expect(recovering).rejects.toBeInstanceOf(CompanionArtifactError);
  await expect(recovering).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(recovering).rejects.toThrow('仍未通过启动复核');
  expect(await f.registry.publication(checkpoint.proposal.operationId)).toEqual(before);
  await expect(f.profiles.load(owner.id)).rejects.toBeDefined();
  expect(await restarted.inspectJob(owner.id, result.jobId!)).toMatchObject({ state: 'stale', failureCount: 0, cycleFailureCount: 0 });
  expect(generate).toHaveBeenCalledTimes(1); await restarted.close();
});

it.each(['park', 'abandon'] as const)('does not reopen an explicitly %s growth checkpoint or wash its failure counts during startup', async action => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockRejectedValue(new Error('known startup processing failure'));
  const service = f.make(generate);
  await expect(service.runOnce(scope)).rejects.toThrow('known startup processing failure');
  const id = (await service.listJobs(owner.id))[0]!.id;
  const held = await control(service, id, action);
  expect(held).toMatchObject({ state: action === 'park' ? 'parked' : 'abandoned', failureCount: 1, cycleFailureCount: 1 });
  const restarted = f.make(generate);
  expect(await restarted.resumePreparedPublications(owner.id)).toEqual({ resumed: 0 });
  expect(await restarted.inspectJob(owner.id, id)).toEqual(held);
  expect((await f.profiles.load(owner.id)).profileRevision).toBe(f.initial.profileRevision);
  expect(generate).toHaveBeenCalledTimes(1); await restarted.close(); await service.close();
});

it('T-020/T-030 reports uncertain in-flight generation and requires explicit retry before paying again', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockRejectedValueOnce(new Error('fixture network uncertainty')).mockResolvedValue(f.validOutput);
  await expect(f.make(generate).runOnce(scope)).rejects.toThrow('fixture network');
  const artifact = (await f.registry.list('host')).find(value => value.artifactId.startsWith('growth-checkpoint:'))!;
  const checkpoint = JSON.parse((await f.registry.read({ artifactId: artifact.artifactId, consumer: 'host' })).text);
  checkpoint.state = 'generating'; checkpoint.reason = '模拟进程在已发送后退出。';
  const { schema, ownerId, contentRevision, contentHash, publicationState, operationId, committedAt, ...metadata } = artifact;
  void schema; void ownerId; void contentHash; void publicationState; void operationId; void committedAt;
  await f.registry.publish({ ...metadata, producer: { kind: 'host', id: 'growth:checkpoint:generating' },
    expectedRevision: contentRevision, content: JSON.stringify(checkpoint) + '\n', operationId: 'fixture:simulate-crash' });
  const resumed = f.make(generate), recovered = await resumed.recoverOwner(owner.id);
  expect(recovered.interrupted).toBe(1); expect(generate).toHaveBeenCalledTimes(1);
  expect((await resumed.runOnce(scope)).status).toBe('no_input'); expect(generate).toHaveBeenCalledTimes(1);
  expect(await resumed.inspectJob(owner.id, checkpoint.key)).toMatchObject({ state: 'parked' });
  await control(resumed, checkpoint.key, 'resume');
  expect((await resumed.runOnce(scope)).status).toBe('published'); expect(generate).toHaveBeenCalledTimes(2);
  const invocations = generate.mock.calls.map(([context]) => JSON.parse(context.user).invocation.id);
  expect(invocations[0]).toMatch(/:attempt:1$/u); expect(invocations[1]).toMatch(/:attempt:2$/u);
  expect(invocations[0]).not.toBe(invocations[1]);
});

it('T-029 durably accepts an explicit retry without holding the management request until its model completes', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockRejectedValueOnce(new Error('fixture failed request'));
  await expect(f.make(generate).runOnce(scope)).rejects.toThrow('fixture failed');
  const checkpoint = (await f.registry.list('host', { kind: 'runtime_index', prefix: 'growth-checkpoint:' }))[0]!;
  const key = checkpoint.artifactId.slice('growth-checkpoint:'.length);
  let resolve!: (value: typeof f.validOutput) => void; const pending = new Promise<typeof f.validOutput>(done => { resolve = done; });
  generate.mockImplementation(() => pending); const service = f.make(generate);
  try {
    await control(service, key, 'park'); await control(service, key, 'resume');
    expect(generate).toHaveBeenCalledTimes(1); expect((await service.listJobs(owner.id))[0]?.status).toBe('fixed');
    service.start(); await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect((await service.listJobs(owner.id))[0]?.status).toBe('generating');
    resolve(f.validOutput); await vi.waitFor(async () => expect((await service.listJobs(owner.id))[0]?.status).toBe('published'), { timeout: 10000 });
  } finally { resolve(f.validOutput); await service.close(); }
});

it('parks after three real failures, keeps lifetime failures across exact-CAS resume, and only abandons explicitly', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockRejectedValue(new Error('PRIVATE_JOB_FAILURE: invalid generated structure'));
  const service = f.make(generate); let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    let id = '';
    for (let failure = 1; failure <= 3; failure++) {
      await expect(service.runOnce(scope)).rejects.toThrow('PRIVATE_JOB_FAILURE');
      id = (await service.listJobs(owner.id))[0]!.id;
      expect(await service.inspectJob(owner.id, id)).toMatchObject({ failureCount: failure, cycleFailureCount: failure, state: failure === 3 ? 'parked' : 'failed' }); now += 2000;
    }
    const restarted = f.make(generate), before = await restarted.inspectJob(owner.id, id);
    expect((await restarted.runOnce(scope)).status).toBe('no_input'); expect(generate).toHaveBeenCalledTimes(3);
    expect(await restarted.pageJobs({ type: 'jobs.page', ownerId: owner.id, kind: 'growth', states: ['parked'], limit: 1 })).toMatchObject({ items: [before], hasMore: false });
    await control(restarted, id, 'resume');
    expect(await restarted.inspectJob(owner.id, id)).toMatchObject({ inputVersion: before!.inputVersion, failureCount: 3, cycleFailureCount: 0, state: 'pending' });
    await expect(restarted.runOnce(scope)).rejects.toThrow('PRIVATE_JOB_FAILURE');
    const failed = (await restarted.inspectJob(owner.id, id))!;
    expect(failed).toMatchObject({ failureCount: 4, cycleFailureCount: 1, state: 'failed' });
    const command = { type: 'jobs.control' as const, ownerId: owner.id, kind: 'growth' as const, id, inputVersion: failed.inputVersion,
      expectedRevision: failed.revision, operationId: randomUUID(), action: 'abandon' as const };
    const abandoned = await restarted.controlJob(command); expect(abandoned).toMatchObject({ state: 'abandoned', failureCount: 4 });
    expect(await restarted.controlJob(command)).toMatchObject({ state: 'abandoned', failureCount: 4 });
    await expect(restarted.controlJob({ ...command, action: 'park' })).rejects.toThrow('操作标识');
    await expect(control(restarted, id, 'resume')).rejects.toThrow('终结');
    now += 100000; expect((await f.make(generate).runOnce(scope)).status).toBe('no_input'); expect(generate).toHaveBeenCalledTimes(4);
    expect((await f.registry.read({ artifactId: companionGrowthSourceArtifactId(f.source.id, 1), consumer: 'audit' })).text).toBe(f.source.content);
    const receipt = await f.registry.read({ artifactId: `growth-control:${command.operationId}`, consumer: 'host' });
    expect(receipt.text).not.toContain('PRIVATE_JOB_FAILURE');
  } finally { clock.mockRestore(); await service.close(); }
});

it('rejects stale controls and source revisions, and cannot resume an abandoned or foreign-owner job', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockRejectedValue(new Error('known processing failure'));
  const service = f.make(generate); await expect(service.runOnce(scope)).rejects.toThrow();
  const id = (await service.listJobs(owner.id))[0]!.id, initial = (await service.inspectJob(owner.id, id))!;
  await control(service, id, 'park');
  await expect(service.controlJob({ type: 'jobs.control', ownerId: owner.id, kind: 'growth', id, inputVersion: initial.inputVersion,
    expectedRevision: initial.revision, operationId: randomUUID(), action: 'abandon' })).rejects.toThrow('状态已经变化');
  await f.profiles.bootstrap({ ...owner, id: 'bob' }); expect(await service.inspectJob('bob', id)).toBeUndefined();
  f.source.revision = 2; await expect(control(service, id, 'resume')).rejects.toThrow('准确版本');
  expect(await service.inspectJob(owner.id, id)).toMatchObject({ state: 'parked', failureCount: 1 }); expect(generate).toHaveBeenCalledTimes(1);
});

it('parks an active exact job without treating user cancellation as failure or publishing a late result', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockImplementation((_context, _config, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new CompanionModelError('CANCELLED', 'host stopped')), { once: true });
  }));
  const service = f.make(generate), running = service.runOnce(scope);
  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1)); const id = (await service.listJobs(owner.id))[0]!.id;
  const parked = await control(service, id, 'park'); await running;
  expect(parked).toMatchObject({ state: 'parked', failureCount: 0, cycleFailureCount: 0 });
  expect((await f.profiles.load(owner.id)).profile.persona).toBe(f.initial.profile.persona);
  expect((await service.runOnce(scope)).status).toBe('no_input'); expect(generate).toHaveBeenCalledTimes(1); await service.close();
});

it('keeps configuration waiting and unknown transport receipts outside real failure counts', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockRejectedValueOnce(new CompanionModelError('CONFIG', 'missing model configuration'))
    .mockRejectedValue(new CompanionModelError('CONTEXT_RECORD_FAILED', 'sent receipt result unknown'));
  const service = f.make(generate); let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    expect((await service.runOnce(scope)).status).toBe('deferred'); const id = (await service.listJobs(owner.id))[0]!.id;
    expect(await service.inspectJob(owner.id, id)).toMatchObject({ state: 'waiting_model', failureCount: 0 });
    expect((await service.runOnce(scope)).status).toBe('deferred'); expect(generate).toHaveBeenCalledTimes(1);
    now += 61000; expect((await service.runOnce(scope)).status).toBe('interrupted');
    expect(await service.inspectJob(owner.id, id)).toMatchObject({ state: 'parked', failureCount: 0 });
    now += 61000; await service.runOnce(scope); expect(generate).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); await service.close(); }
});

it.each(['file_published', 'prepared'] as const)('recovers an exact growth control after %s without resending a model or fabricating missing stage bytes', async window => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockRejectedValue(new Error('known failure'));
  const service = f.make(generate); await expect(service.runOnce(scope)).rejects.toThrow();
  const id = (await service.listJobs(owner.id))[0]!.id, before = (await service.inspectJob(owner.id, id))!;
  if (window === 'file_published') f.failNextControlCommit(); else f.failNextControlPrepare();
  const command = { type: 'jobs.control' as const, ownerId: owner.id, kind: 'growth' as const, id, inputVersion: before.inputVersion,
    expectedRevision: before.revision, operationId: randomUUID(), action: 'park' as const };
  await expect(service.controlJob(command)).rejects.toThrow('fixture crash');
  const restarted = f.make(generate); await restarted.resumePreparedPublications(owner.id);
  expect(generate).toHaveBeenCalledTimes(1);
  const publication = await f.registry.publication(`growth-control:${command.operationId}`);
  expect(publication?.state).toBe(window === 'file_published' ? 'committed' : 'cancelled');
  expect(await restarted.inspectJob(owner.id, id)).toMatchObject({ state: window === 'file_published' ? 'parked' : 'failed', failureCount: 1, inputVersion: before.inputVersion });
  if (window === 'file_published') expect(await restarted.controlJob(command)).toMatchObject({ state: 'parked', failureCount: 1 });
});

it('pages more than fifty parked original checkpoints by indexed state and exact id cursor without reading unrelated jobs', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockRejectedValue(new Error('known failure'));
  const service = f.make(generate); await expect(service.runOnce(scope)).rejects.toThrow();
  const current = (await f.registry.list('host', { kind: 'runtime_index', prefix: 'growth-checkpoint:' }))[0]!;
  const body = JSON.parse((await f.registry.read({ artifactId: current.artifactId, consumer: 'host' })).text);
  const items = Array.from({ length: 57 }, (_, index) => {
    const key = companionArtifactHash('parked-job-page-' + index), checkpoint = { ...body, key,
      disposition: { ...body.disposition, id: key, state: 'parked', failureCount: 3, cycleFailureCount: 3 } };
    return { artifactId: `growth-checkpoint:${key}`, kind: 'runtime_index' as const, relativePath: `.运行/视图/人格学习/${key}.json`,
      content: JSON.stringify(checkpoint) + '\n', expectedRevision: null, producer: { kind: 'host' as const, id: 'growth:checkpoint:parked' },
      sourceRefs: current.sourceRefs, dependencyRefs: [], visibility: { scope: 'owner' as const }, allowedConsumers: ['host' as const], retentionClass: 'runtime' as const };
  });
  await f.registry.publishBatch({ operationId: 'fixture:parked-page', items }); const mark = f.registryCommands.length;
  const first = await service.pageJobs({ type: 'jobs.page', ownerId: owner.id, kind: 'growth', states: ['parked'], limit: 50 });
  const second = await service.pageJobs({ type: 'jobs.page', ownerId: owner.id, kind: 'growth', states: ['parked'], limit: 50, afterId: first.nextId });
  expect(first.items).toHaveLength(50); expect(first.hasMore).toBe(true); expect(second.items).toHaveLength(7); expect(second.hasMore).toBe(false);
  expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(57);
  const pages = f.registryCommands.slice(mark).filter(command => command.type === 'cognition.registry.page');
  expect(pages).toHaveLength(2); expect(pages.every(command => command.producerId === 'growth:checkpoint:parked' && command.limit === 51)).toBe(true);
  expect(generate).toHaveBeenCalledTimes(1); await service.close();
}, 30000);

it('parks restored paid checkpoints before activation and resumes their saved result without purchasing another generation', async () => {
  const f = await fixture(), generate = vi.fn<typeof generateCompanionStructured>().mockResolvedValue(f.validOutput), service = f.make(generate);
  f.failNextValidation(); expect((await service.runOnce(scope)).status).toBe('stale');
  const artifact = (await f.registry.list('host', { kind: 'runtime_index', prefix: 'growth-checkpoint:' }))[0]!;
  const checkpoint = JSON.parse((await f.registry.read({ artifactId: artifact.artifactId, consumer: 'host' })).text);
  // Same authenticated package, at the actual boundary after saving a paid
  // response and before entering publication validation.
  checkpoint.state = 'generated'; checkpoint.disposition.state = 'running';
  await f.registry.publish({ artifactId: artifact.artifactId, kind: artifact.kind, relativePath: artifact.relativePath,
    producer: { kind: 'host', id: 'growth:checkpoint:generated' }, expectedRevision: artifact.contentRevision, content: JSON.stringify(checkpoint) + '\n',
    sourceRefs: artifact.sourceRefs, dependencyRefs: artifact.dependencyRefs, visibility: artifact.visibility, allowedConsumers: artifact.allowedConsumers,
    retentionClass: artifact.retentionClass, operationId: 'fixture:paid-before-restore' });
  await expect(service.parkRestoredOwner(owner.id)).rejects.toThrow('保持伙伴暂停');
  const beforeRestore = (await service.inspectJob(owner.id, checkpoint.key))!;
  f.setActive(false); expect(await service.parkRestoredOwner(owner.id)).toEqual({ parked: 1 });
  const firstFreeze = (await service.inspectJob(owner.id, checkpoint.key))!;
  expect(firstFreeze.revision).toBeGreaterThan(beforeRestore.revision);
  await expect(service.controlJob({ type: 'jobs.control', ownerId: owner.id, kind: 'growth', id: checkpoint.key,
    inputVersion: beforeRestore.inputVersion, expectedRevision: beforeRestore.revision, operationId: randomUUID(), action: 'resume' })).rejects.toThrow('已经变化');
  expect(await service.parkRestoredOwner(owner.id)).toEqual({ parked: 0 });
  const parked = (await service.inspectJob(owner.id, checkpoint.key))!; expect(parked).toMatchObject({ state: 'parked', failureCount: 0 });
  expect(parked.revision).toBeGreaterThan(firstFreeze.revision);
  await expect(service.controlJob({ type: 'jobs.control', ownerId: owner.id, kind: 'growth', id: checkpoint.key,
    inputVersion: firstFreeze.inputVersion, expectedRevision: firstFreeze.revision, operationId: randomUUID(), action: 'resume' })).rejects.toThrow('已经变化');
  const saved = JSON.parse((await f.registry.read({ artifactId: artifact.artifactId, consumer: 'host' })).text);
  expect(saved.output).toEqual(f.validOutput); expect(saved.attempt).toBe(1);
  await service.recoverOwner(owner.id); expect(generate).toHaveBeenCalledTimes(1);
  expect((await service.runOnce(scope)).status).toBe('no_input'); expect(await service.inspectJob(owner.id, checkpoint.key)).toMatchObject({ state: 'parked' });
  f.setActive(true); await control(service, checkpoint.key, 'resume');
  expect((await service.runOnce(scope)).status).toBe('published'); expect(generate).toHaveBeenCalledTimes(1); await service.close();
});
