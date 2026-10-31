import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { CompanionAssetIo } from '../../src/main/companions/asset-io';
import { generateCompanionReply, type CompanionModelConfig } from '../../src/main/companions/model';
import { readCompanionTaskAssets, type CompanionTaskAssetBinding } from '../../src/main/companions/task-asset-snapshot';
import type { Companion, CompanionMessage } from '../../src/shared/companions';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionGrowthGoal, CompanionContextFrame } from '../../src/shared/companion-cognition';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import { registryStorageFixture } from '../fixtures/companion-registry-storage';
import { companionArtifactHash } from '../../src/main/companions/artifact-registry';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import BetterSqlite3 from 'better-sqlite3';
import type { CompanionConnection } from '../../src/companions/store';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true } }));
const owner: Companion = { id: 'alice', name: 'Alice', description: '独立角色', persona: '完整初始人格。\n\n保留兴趣、限制与独立判断。',
  model: '', avatar: 'sister', builtin: false, proactive: false, active: true, createdAt: '2026-10-30T00:00:00Z' };
const fixtures: Array<{ root: string; db: { close(): void }; io: CompanionAssetIo }> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.io.close(); f.db.close(); await removeOwnedDirectory(f.root); } });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'task-assets-freeze-')), db = registryStorageFixture(root), io = new CompanionAssetIo(); fixtures.push({ root, db, io });
  const profiles = new CompanionAssetProfileStore(path.join(root, 'owners'), { registryStorage: db.storage }), initial = await profiles.bootstrap(owner), registry = await profiles.artifacts(owner.id);
  let epoch = 0, member = true, goals: CompanionGrowthGoal[] = [];
  const sources = new Map<string, CompanionMessage>(), saved = new Map<string, string>();
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'loop.save') { if (command.checkpoint.taskAssets) saved.set(command.checkpoint.sourceMessageId, command.checkpoint.taskAssets); return { ok: true }; }
    if (command.type === 'state') return { ok: true, state: { companions: [owner], activities: [], configured: true,
      conversations: [{ id: 'room', kind: 'private', title: owner.name, memberIds: member ? [owner.id] : [], pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: owner.createdAt }] } };
    if (command.type === 'memory.lifecycle.state') return { ok: true, memoryLifecycleState: { companionId: owner.id, revocationEpoch: epoch, ledgerSequence: 0 } };
    if (command.type === 'growth.goals.list') return { ok: true, growthGoals: goals };
    if (command.type === 'memory.sources.filter') return { ok: true, memorySources: command.ids.flatMap(id => sources.has(id) ? [sources.get(id)!] : []) };
    if (command.type === 'message.get') return { ok: true, message: sources.get(command.id) };
    if (command.type === 'loop.get') return { ok: true, loop: { companionId: owner.id, conversationId: 'room', sourceMessageId: command.sourceMessageId,
      invocationKey: command.invocationKey, status: 'running', turns: [], supplements: [], taskAssets: saved.get(command.sourceMessageId) } };
    throw new Error(`Unexpected task asset command ${command.type}`);
  });
  let connection = 'first-model';
  const service = Object.assign(Object.create(CompanionService.prototype), { assetProfiles: profiles, assetIo: io, storage: { request }, call: request,
    requireCurrentAssets: vi.fn(async () => undefined), contextSnapshots: {}, resettingCompanions: new Set(), dormantCompanions: new Set(),
    options: { getConfig: () => ({ apiFormat: 'openai_chat', model: connection, baseUrl: 'https://never-network.invalid', apiKey: 'local-fixture' }) },
    bindModelTransport: (_owner: string, config: CompanionModelConfig) => config }) as {
    prepareModelAssetContext(owner: string, context: { system: string; user: string }, kind: 'reply', native?: undefined, purpose?: undefined, task?: CompanionTaskAssetBinding): Promise<{ system: string; user: string; frame: CompanionContextFrame }>;
    validateTaskAssetFrame(frame: CompanionContextFrame): Promise<void>;
    configFor(owner: Companion, priority: 'foreground' | 'background', checkpoint: CompanionLoopCheckpoint,
      saveTaskAssets?: () => Promise<void>, socialJobId?: string): Promise<CompanionModelConfig>;
    captureExecutionEvidence(checkpoint: CompanionLoopCheckpoint, scope: { companionId: string; conversationId: string; beforeSequence: number },
      requiredSource?: Pick<CompanionMessage, 'id' | 'conversationId' | 'content'>): Promise<CompanionExecutionReadset> };
  const task = (sourceMessageId: string, blob?: string) => {
    const checkpoint: CompanionLoopCheckpoint = { companionId: owner.id, conversationId: 'room', sourceMessageId, status: 'running', turns: [], supplements: [], taskAssets: blob };
    const save = vi.fn(async () => { saved.set(sourceMessageId, checkpoint.taskAssets!); });
    return { checkpoint, save };
  };
  const context = { system: '本次宿主合同', user: JSON.stringify({ purpose: 'companion_reply', invocation: { conversationId: 'room' } }) };
  const prepare = (task?: CompanionTaskAssetBinding) => service.prepareModelAssetContext(owner.id, context, 'reply', undefined, undefined, task);
  const publishRole = async () => {
    const module = initial.modules.find(module => module.purposes.includes('companion_reply'))!, artifact = (await registry.findByPath(module.path))!;
    await registry.publish({ artifactId: artifact.artifactId, kind: artifact.kind, relativePath: artifact.relativePath,
      producer: { kind: 'system', id: 'fixture:role' }, expectedRevision: artifact.contentRevision, content: module.content + '\nNEW_REGISTERED_ROLE_GUIDANCE\n',
      sourceRefs: artifact.sourceRefs, dependencyRefs: artifact.dependencyRefs, visibility: artifact.visibility, allowedConsumers: artifact.allowedConsumers,
      retentionClass: artifact.retentionClass, operationId: 'fixture:role:r2' }, async () => undefined); return artifact;
  };
  return { profiles, registry, initial, service, request, sources, saved, task, prepare, publishRole,
    connection: (model: string) => { connection = model; },
    epoch: (value: number) => { epoch = value; }, member: (value: boolean) => { member = value; }, goals: (value: CompanionGrowthGoal[]) => { goals = value; } };
}

it('freezes complete guidance and identity for tool continuations and restart, while new tasks and stateless calls see new publication', async () => {
  const f = await fixture(), task = f.task('first'), load = vi.spyOn(f.profiles, 'load');
  const first = await f.prepare(task), blob = task.checkpoint.taskAssets!;
  expect(first.frame.identity).toBe(f.initial.profile.persona); expect(first.frame.taskAssets?.kind).toBe('task_initial');
  await f.publishRole();
  const continuation = await f.prepare(task), restored = await f.prepare(f.task('first', JSON.parse(JSON.stringify(blob))));
  expect(continuation.system).toBe(first.system); expect(restored.system).toBe(first.system); expect(task.save).toHaveBeenCalledOnce();
  expect(load).toHaveBeenCalledOnce(); expect(task.checkpoint.taskAssets).toBe(blob);
  await expect(f.service.validateTaskAssetFrame(restored.frame)).resolves.toBeUndefined();
  const next = await f.prepare(f.task('next')), stateless = await f.prepare();
  expect(next.system).toContain('NEW_REGISTERED_ROLE_GUIDANCE'); expect(stateless.system).toContain('NEW_REGISTERED_ROLE_GUIDANCE');
  expect(next.frame.identity).toBe(first.frame.identity); expect(next.frame.taskAssets?.digest).not.toBe(first.frame.taskAssets?.digest);
});

it('retains the original role after unrelated withdrawal epochs but rejects an actual consumed role withdrawal or lost membership', async () => {
  const f = await fixture(), task = f.task('first'), first = await f.prepare(task);
  f.epoch(8); expect((await f.prepare(task)).system).toBe(first.system); expect((await f.prepare(task)).frame.revocationEpoch).toBe(8);
  f.member(false); await expect(f.prepare(task)).rejects.toThrow('入口'); f.member(true);
  const module = f.initial.modules.find(module => module.purposes.includes('companion_reply'))!, artifact = (await f.registry.findByPath(module.path))!;
  await f.registry.revoke(artifact.artifactId); await expect(f.prepare(task)).rejects.toThrow('撤回');
  expect(task.checkpoint.taskAssets).toBeDefined();
});

it('freezes cultivation goals as future directions and rechecks their original source bytes before each use', async () => {
  const f = await fixture(), source: CompanionMessage = { id: 'goal-source', conversationId: 'room', authorId: 'user', kind: 'text', status: 'sent',
    sequence: 1, content: '希望给建议前保留条件。', createdAt: owner.createdAt, attachments: [], revision: 1 };
  f.sources.set(source.id, source);
  const goal: CompanionGrowthGoal = { id: 'goal', companionId: owner.id, conversationId: 'room', authorId: 'user', revision: 1,
    statement: '先保留适用条件', context: '提出建议时', examples: [], counterexamples: [], practice: [], status: 'proposed',
    createdAt: owner.createdAt, updatedAt: owner.createdAt, sources: [{ messageId: source.id, revision: 1, contentHash: companionArtifactHash(source.content) }] };
  f.goals([goal]); const task = f.task('first'), first = await f.prepare(task);
  f.goals([{ ...goal, revision: 2, statement: '下个任务的新方向' }]);
  expect(JSON.parse((await f.prepare(task)).user).cultivationGoals.items[0].statement).toBe(goal.statement);
  expect(JSON.parse((await f.prepare(f.task('next'))).user).cultivationGoals.items[0].statement).toBe('下个任务的新方向');
  const scope = { companionId: owner.id, conversationId: 'room', beforeSequence: 2 };
  const evidence = await f.service.captureExecutionEvidence(task.checkpoint, scope, source);
  expect(evidence.complete).toBe(true);
  expect(evidence.sources).toEqual([{ id: source.id, conversationId: source.conversationId, checksum: companionArtifactHash(source.content) }]);
  expect(readCompanionTaskAssets(task.checkpoint.taskAssets!, task.checkpoint).rawSources).toEqual([
    { ...evidence.sources[0]!, revision: 1 },
  ]);
  // General execution references are byte-and-ACL proofs; the task's sealed
  // goal witness must still enforce its stronger original source revision.
  f.sources.set(source.id, { ...source, revision: 2 });
  await expect(f.service.captureExecutionEvidence(task.checkpoint, scope, source)).rejects.toThrow('原始来源已撤回');
  f.sources.set(source.id, source); f.member(false);
  await expect(f.service.captureExecutionEvidence(task.checkpoint, scope, source)).rejects.toThrow('入口');
  f.member(true);
  f.sources.set(source.id, { ...source, content: '外部SQLite已改写原始来源。' });
  await expect(f.prepare(task)).rejects.toThrow('原始来源已撤回');
  await expect(f.service.validateTaskAssetFrame(first.frame)).rejects.toThrow('原始来源已撤回');
});

it.each(['revision', 'withdrawal', 'membership'] as const)('captures a real stored cultivation goal into execution evidence and rejects later %s changes', async change => {
  const f = managedMemoryFiles(), io = new CompanionAssetIo();
  try {
    const actualOwner = f.store.request({ type: 'state' }).state!.companions.find(role => role.id === owner.id)!;
    const room = f.store.request({ type: 'conversation.create-group', title: '真实培养来源范围', memberIds: ['alice', 'bob'] }).conversation!;
    const source = f.store.appendMessage({ conversationId: room.id, authorId: 'user', content: '希望建议先核对条件。', replyDirective: 'none' });
    const goal = f.store.request({ type: 'growth.goal.propose', companionId: owner.id, conversationId: room.id,
      operationId: 'capture_actual_goal', sourceMessageIds: [source.id], goal: { statement: '先保留条件', context: '提出建议时', practice: ['核对一个条件'] } }).growthGoal!;
    const profiles = new CompanionAssetProfileStore(f.directory, { registryStorage: { request: f.request } });
    await profiles.bootstrap(actualOwner);
    const checkpoint: CompanionLoopCheckpoint = { companionId: owner.id, conversationId: room.id, sourceMessageId: source.id,
      status: 'running', turns: [], supplements: [] };
    const service = Object.assign(Object.create(CompanionService.prototype), { assetProfiles: profiles, assetIo: io,
      storage: { request: f.request }, call: f.request, requireCurrentAssets: vi.fn(async () => undefined),
    }) as Pick<Awaited<ReturnType<typeof fixture>>['service'], 'prepareModelAssetContext' | 'captureExecutionEvidence' | 'validateTaskAssetFrame'>;
    const context = await service.prepareModelAssetContext(owner.id, { system: '本轮真实培养合同',
      user: JSON.stringify({ purpose: 'companion_reply', invocation: { conversationId: room.id } }) }, 'reply', undefined, undefined,
      { checkpoint, save: async () => { await f.request({ type: 'loop.save', checkpoint }); } });
    expect(JSON.parse(context.user).cultivationGoals.items.map((item: { id: string }) => item.id)).toEqual([goal.id]);
    const persisted = f.store.request({ type: 'loop.get', companionId: owner.id, sourceMessageId: source.id }).loop!;
    expect(persisted.taskAssets).toBe(checkpoint.taskAssets);
    expect(readCompanionTaskAssets(persisted.taskAssets!, persisted).rawSources[0]!.revision).toBe(1);
    const scope = { companionId: owner.id, conversationId: room.id, beforeSequence: source.sequence + 1 };
    const evidence = await service.captureExecutionEvidence(persisted, scope, source);
    expect(evidence.complete).toBe(true);
    expect(evidence.sources).toEqual([{ id: source.id, conversationId: room.id, checksum: companionArtifactHash(source.content) }]);
    if (change === 'revision') {
      const Database = BetterSqlite3 as { new(filename: string): CompanionConnection }, external = new Database(path.join(f.root, 'state.sqlite'));
      try { external.prepare('UPDATE messages SET revision=revision+1 WHERE id=?').run(source.id); } finally { external.close(); }
    } else if (change === 'withdrawal') f.store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [source.id] });
    else f.store.request({ type: 'conversation.update', id: room.id, memberIds: ['bob'] });
    await expect(service.captureExecutionEvidence(persisted, scope, source)).rejects.toThrow(change === 'membership' ? '入口' : '原始来源已撤回');
    await expect(service.validateTaskAssetFrame(context.frame)).rejects.toThrow(change === 'membership' ? '入口' : '原始来源已撤回');
  } finally { await io.close(); await f.close(); }
});

it('persists one complete initial capture for concurrent admissions and rejects another task claiming its blob', async () => {
  const f = await fixture(), task = f.task('first'), load = vi.spyOn(f.profiles, 'load');
  const results = await Promise.all(Array.from({ length: 4 }, () => f.prepare(task)));
  expect(load).toHaveBeenCalledOnce(); expect(task.save).toHaveBeenCalledOnce();
  expect(new Set(results.map(result => result.frame.taskAssets!.digest)).size).toBe(1);
  expect(readCompanionTaskAssets(task.checkpoint.taskAssets!, task.checkpoint).snapshot.modules).toEqual(f.initial.modules);
  await expect(f.prepare(f.task('foreign', task.checkpoint.taskAssets))).rejects.toThrow('不属于');
});

it('seals goal and social roles before initial preparation and uses the social lease save port only once', async () => {
  const f = await fixture(), goal = f.task('goal_source'), social = f.task('social_source');
  goal.checkpoint.invocationKey = 'goal_slot'; social.checkpoint.invocationKey = 'social_job';
  const load = vi.spyOn(f.profiles, 'load');
  const goalConfig = await f.service.configFor(owner, 'foreground', goal.checkpoint);
  const socialConfig = await f.service.configFor(owner, 'background', social.checkpoint, social.save, 'social_job');
  expect(readCompanionTaskAssets(goal.checkpoint.taskAssets!, goal.checkpoint).invocationKey).toBe('goal_slot');
  expect(readCompanionTaskAssets(social.checkpoint.taskAssets!, social.checkpoint).invocationKey).toBe('social_job');
  expect(social.save).toHaveBeenCalledOnce(); expect(load).toHaveBeenCalledTimes(2);
  await f.publishRole();
  const context = { system: '领域合同', user: JSON.stringify({ purpose: 'world_social', conversationId: 'room' }) };
  const preparedGoal = await goalConfig.resolveAssetContext!(context, 'structured');
  const preparedSocial = await socialConfig.resolveAssetContext!(context, 'structured');
  expect(preparedGoal.system).not.toContain('NEW_REGISTERED_ROLE_GUIDANCE');
  expect(preparedSocial.system).not.toContain('NEW_REGISTERED_ROLE_GUIDANCE');
  expect(preparedSocial.frame?.taskAssets?.socialJobId).toBe('social_job');
  await f.service.configFor(owner, 'background', social.checkpoint, social.save, 'social_job');
  expect(social.save).toHaveBeenCalledOnce(); expect(load).toHaveBeenCalledTimes(2);
});

it('binds actual provider requests and repair to the task role across tool continuations while refreshing connection configuration', async () => {
  // Service/owner initialization precedes the task preparation gate.
  const f = await fixture();
  await withCompanionExecutionValidation(async () => {
  const task = f.task('first'), load = vi.spyOn(f.profiles, 'load'), config = await f.service.configFor(owner, 'foreground', task.checkpoint);
  const initialBlob = task.checkpoint.taskAssets;
  expect(initialBlob).toBeDefined(); expect(f.saved.get('first')).toBe(initialBlob);
  // A real role publication while initial passive recall is still pending
  // must not change even the first provider request for this admitted task.
  await f.publishRole();
  const source: CompanionMessage = { id: 'first', conversationId: 'room', authorId: 'user', sequence: 1, kind: 'text', status: 'sent',
    content: '核对实际安排。', createdAt: owner.createdAt, attachments: [] };
  const conversation = { id: 'room', kind: 'private' as const, title: owner.name, memberIds: [owner.id], pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: owner.createdAt };
  const input = { companion: owner, conversation, messages: [source], sourceMessage: source, memories: [] };
  const bodies: Array<{ model: string; messages: Array<{ role: string; content?: string; tool_call_id?: string }> }> = [];
  const fetchFn: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ choices: [{ message: { content: '已经核对。' } }] }), { headers: { 'content-type': 'application/json' } }); };
  await generateCompanionReply(input, config, undefined, { fetchFn, loop: true });
  expect(bodies[0]!.messages[0]!.content).not.toContain('NEW_REGISTERED_ROLE_GUIDANCE');
  f.connection('changed-model');
  const resumedConfig = await f.service.configFor(owner, 'foreground', task.checkpoint);
  await generateCompanionReply(input, resumedConfig, undefined, { fetchFn, loop: true, turns: [{ text: '', rawText: '',
    calls: [{ id: 'read', name: 'world', arguments: '{"action":"observe"}' }], results: [{ callId: 'read', content: '{"ok":true}' }] }] });
  expect(bodies[0]!.messages[0]!.content).toBe(bodies[1]!.messages[0]!.content);
  expect(bodies[1]!.messages.some(message => message.role === 'tool' && message.tool_call_id === 'read')).toBe(true);
  expect(bodies.map(body => body.model)).toEqual(['first-model', 'changed-model']);
  expect(task.checkpoint.taskAssets).toBe(initialBlob); expect(load).toHaveBeenCalledOnce();
  const repair = await resumedConfig.resolveStructuredRepairConfig!(), repaired = await repair.resolveAssetContext!({ system: '修复合同', user: JSON.stringify({ purpose: 'companion_structured_repair', conversationId: 'room' }) }, 'structured');
  expect(repaired.frame?.taskAssets?.digest).toBe((await f.prepare(task)).frame.taskAssets?.digest);
  expect(repaired.frame?.profileRevision).toBe(f.initial.profileRevision);
  expect(repaired.system).not.toContain('NEW_REGISTERED_ROLE_GUIDANCE');
  const next = f.task('next'), nextConfig = await f.service.configFor(owner, 'foreground', next.checkpoint);
  await generateCompanionReply({ ...input, sourceMessage: { ...source, id: 'next' }, messages: [{ ...source, id: 'next' }] }, nextConfig, undefined, { fetchFn, loop: true });
  expect(bodies[2]!.messages[0]!.content).toContain('NEW_REGISTERED_ROLE_GUIDANCE');
  });
});
