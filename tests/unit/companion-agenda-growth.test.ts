import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionConnection } from '../../src/companions/store';
import { CompanionArtifactRegistryStore } from '../../src/companions/artifact-registry-store';
import { CompanionGrowthService, companionGrowthSourceArtifactId, validateCompanionPersonaPublication, type CompanionGrowthNativeJob, type CompanionGrowthResult } from '../../src/main/companions/growth-service';
import { CompanionAssetProfileStore, projectCompanionAssetProfile } from '../../src/main/companions/asset-profile';
import { companionArtifactHash } from '../../src/main/companions/artifact-registry';
import type { generateCompanionStructured } from '../../src/main/companions/model';
import type { Companion, CompanionMessage, CompanionMemory } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionJobDisposition } from '../../src/shared/companion-job-control';
import { companionAgendaGoalSchema } from '../../src/shared/companion-agenda';

const services: CompanionGrowthService[] = [], databases: DatabaseSync[] = [], roots: string[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); vi.useRealTimers(); for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) { if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('agenda-growth-')) throw new Error('Unexpected growth fixture path'); await rm(root, { recursive: true, force: true }); } });
function simple() {
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'character.development.scopes.page') return { ok: true, characterDevelopmentScopes: { items: [], hasMore: false } };
    throw new Error('Unexpected source read');
  });
  const profiles = {} as CompanionAssetProfileStore;
  const service = new CompanionGrowthService({ requestStorage: request, profiles, getConfig: () => ({ apiFormat: 'openai_chat', model: 'unused', apiKey: 'unused' }), report: vi.fn() }); services.push(service);
  const wake = vi.fn(); service.setAgendaDriven(wake);
  const run = vi.spyOn(service, 'runOnce').mockImplementation(async scope => ({ status: 'no_input', companionId: scope.companionId, conversationId: scope.conversationId, reason: '没有新的有据输入' }));
  return { service, wake, run, request };
}

it('turns wakes and startup into agenda notifications without starting the old scanner or model pump', async () => {
  vi.useFakeTimers(); const f = simple();
  f.service.start(); f.service.wake({ companionId: 'alice', conversationId: 'private_one' });
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.wake).toHaveBeenCalledWith({ companionId: 'alice', conversationId: 'private_one' });
  expect(f.run).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  const result = await f.service.runAgendaQuantum('alice', new AbortController().signal);
  expect(result).toMatchObject({ outcome: 'no_change', companionId: 'alice', conversationId: 'private_one' });
  expect(f.run).toHaveBeenCalledTimes(1);
});

it('resumes a temporary definition-change fence while keeping actual retirement irreversible', async () => {
  const f = simple();
  f.service.wake({ companionId: 'alice', conversationId: 'before_pause' });
  await f.service.pauseAndWait('alice'); expect(f.service.isStopped('alice')).toBe(true);
  f.service.resume('alice'); expect(f.service.isStopped('alice')).toBe(false);
  expect((await f.service.runAgendaQuantum('alice', new AbortController().signal)).conversationId).toBe('before_pause');
  f.service.wake({ companionId: 'alice', conversationId: 'actual_private' });
  expect((await f.service.runAgendaQuantum('alice', new AbortController().signal)).conversationId).toBe('actual_private');
  await f.service.stopAndWait('bob'); f.service.resume('bob'); expect(f.service.isStopped('bob')).toBe(true);
  f.service.wake({ companionId: 'bob', conversationId: 'retired_private' });
  expect(f.run.mock.calls.some(([scope]) => scope.companionId === 'bob')).toBe(false);
});

it('retains an aborted exact source scope across a temporary fence without synthesizing another conversation', async () => {
  const f = simple(); f.run.mockRestore();
  const processor = vi.spyOn(f.service as unknown as { run(scope: { companionId: string; conversationId: string }, signal: AbortSignal): Promise<CompanionGrowthResult> }, 'run');
  processor.mockImplementationOnce((scope, signal) => new Promise(resolve => { signal.addEventListener('abort', () => resolve({ ...scope, status: 'deferred', reason: '原处理已停止，来源保留。' }), { once: true }); }));
  const original = f.service.runOnce({ companionId: 'alice', conversationId: 'active_actual_port' });
  await f.service.pauseAndWait('alice'); await original;
  processor.mockImplementation(async scope => ({ ...scope, status: 'no_input', reason: '复核原始范围，没有新输入。' }));
  f.service.resume('alice');
  const next = await f.service.runAgendaQuantum('alice', new AbortController().signal);
  expect(next.conversationId).toBe('active_actual_port'); expect(processor).toHaveBeenCalledTimes(2);
  expect(processor.mock.calls.every(([scope]) => scope.conversationId === 'active_actual_port')).toBe(true);
});

it('processes one actual source conversation per quantum without merging private/group scopes or dropping queued events', async () => {
  const f = simple(); for (const conversationId of ['private_a', 'group_a', 'private_b']) f.service.wake({ companionId: 'alice', conversationId });
  f.service.wake({ companionId: 'bob', conversationId: 'bob_private' });
  const first = await f.service.runAgendaQuantum('alice', new AbortController().signal), second = await f.service.runAgendaQuantum('alice', new AbortController().signal);
  expect([first.conversationId, second.conversationId]).toEqual(['private_a', 'group_a']);
  expect(f.run.mock.calls.map(([scope]) => [scope.companionId, scope.conversationId])).toEqual([['alice', 'private_a'], ['alice', 'group_a']]);
  expect(first.hasMore).toBe(true); expect(second.hasMore).toBe(true);
  for (let index = 0; index < 140; index++) f.service.wake({ companionId: 'alice', conversationId: 'room_' + index });
  for (let index = 0; index < 141; index++) await f.service.runAgendaQuantum('alice', new AbortController().signal);
  expect(f.run).toHaveBeenCalledTimes(143); expect(f.run.mock.calls.some(([scope]) => scope.conversationId === 'room_139')).toBe(true);
});

it('discovers restart debt using an owner-filtered bounded page and refuses a foreign scope', async () => {
  const f = simple();
  f.request.mockImplementation(async command => command.type === 'character.development.scopes.page'
    ? { ok: true, characterDevelopmentScopes: { items: [{ companionId: 'alice', conversationId: 'actual_private', generation: 3 }], hasMore: false } }
    : { ok: false });
  const result = await f.service.runAgendaQuantum('alice', new AbortController().signal);
  expect(result.conversationId).toBe('actual_private');
  expect(f.request).toHaveBeenCalledWith({ type: 'character.development.scopes.page', companionId: 'alice', limit: 16 });
  f.request.mockResolvedValue({ ok: true, characterDevelopmentScopes: { items: [{ companionId: 'bob', conversationId: 'secret', generation: 1 }], hasMore: false } });
  await expect(f.service.runAgendaQuantum('alice', new AbortController().signal)).rejects.toThrow('不属于'); expect(f.run).toHaveBeenCalledTimes(1);
});

it('keeps a deferred exact scope for later and does not let it starve another ready conversation', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-29T10:00:00Z'); const f = simple();
  f.run.mockImplementationOnce(async scope => ({ ...scope, status: 'deferred', reason: '等待模型连接', retryAt: '2026-10-29T10:01:00Z' }));
  f.service.wake({ companionId: 'alice', conversationId: 'private_a' }); f.service.wake({ companionId: 'alice', conversationId: 'private_b' });
  const first = await f.service.runAgendaQuantum('alice', new AbortController().signal), second = await f.service.runAgendaQuantum('alice', new AbortController().signal);
  expect(first.outcome).toBe('waiting'); expect(first.retryAt).toBe('2026-10-29T10:01:00Z'); expect(second.conversationId).toBe('private_b');
  const waiting = await f.service.runAgendaQuantum('alice', new AbortController().signal); expect(waiting.outcome).toBe('waiting'); expect(f.run).toHaveBeenCalledTimes(2);
  vi.setSystemTime('2026-10-29T10:01:00Z'); expect((await f.service.runAgendaQuantum('alice', new AbortController().signal)).conversationId).toBe('private_a');
});

it.each(['parked', 'abandoned', 'interrupted'] as const)('returns the exact native %s disposition without automatically restarting it', async state => {
  const f = simple(), key = 'a'.repeat(64);
  f.run.mockResolvedValue({ companionId: 'alice', conversationId: 'private', status: state === 'interrupted' ? 'interrupted' : 'failed', jobId: key, reason: '原始作业仍保留' });
  const disposition: CompanionJobDisposition = { ownerId: 'alice', kind: 'growth', id: key, inputVersion: 'b'.repeat(64), revision: 7,
    state: state === 'interrupted' ? 'parked' : state, failureCount: 3, cycleFailureCount: 3 };
  vi.spyOn(f.service, 'inspectJob').mockResolvedValue(disposition);
  f.service.wake({ companionId: 'alice', conversationId: 'private' });
  const result = await f.service.runAgendaQuantum('alice', new AbortController().signal);
  expect(result.outcome).toBe(state === 'interrupted' ? 'unknown' : state);
  expect(result.nativeJob).toEqual({ kind: 'growth', id: key, inputVersion: disposition.inputVersion, revision: 7 }); expect(result.hasMore).toBe(false);
});

it('preserves a source wake arriving during the current quantum for a later independent pass', async () => {
  const f = simple(); f.service.wake({ companionId: 'alice', conversationId: 'private' });
  f.run.mockImplementationOnce(async scope => { f.service.wake({ companionId: 'alice', conversationId: 'private' }); return { ...scope, status: 'no_change', reason: '本批维持现状' }; });
  expect((await f.service.runAgendaQuantum('alice', new AbortController().signal)).hasMore).toBe(true);
  await f.service.runAgendaQuantum('alice', new AbortController().signal); expect(f.run).toHaveBeenCalledTimes(2);
});

it('does not dispatch before the parent checkpoint and keeps the exact scope when checkpoint persistence fails', async () => {
  const f = simple(); f.service.wake({ companionId: 'alice', conversationId: 'private' });
  await expect(f.service.runAgendaQuantum('alice', new AbortController().signal, async () => { throw new Error('parent lease revoked'); })).rejects.toThrow('parent lease revoked');
  expect(f.run).not.toHaveBeenCalled();
  const stages: string[] = [];
  const result = await f.service.runAgendaQuantum('alice', new AbortController().signal, async stage => { stages.push(stage); if (stages.length === 2) throw new Error('notification unavailable'); });
  expect(result.outcome).toBe('no_change'); expect(result.conversationId).toBe('private'); expect(f.run).toHaveBeenCalledTimes(1);
});

it('serializes same-owner quanta while a parent checkpoint is awaiting storage', async () => {
  const f = simple(); f.service.wake({ companionId: 'alice', conversationId: 'private' });
  let release!: () => void; const checkpoint = new Promise<void>(resolve => { release = resolve; });
  const first = f.service.runAgendaQuantum('alice', new AbortController().signal, () => checkpoint);
  const second = await f.service.runAgendaQuantum('alice', new AbortController().signal);
  expect(second.outcome).toBe('waiting'); expect(f.run).not.toHaveBeenCalled();
  release(); await first; expect(f.run).toHaveBeenCalledTimes(1);
});

it.each(['publish', 'stop', 'goal_progress', 'goal_pause', 'goal_update', 'goal_decline', 'goal_only'] as const)('retains the real publisher and authoritative future directions (%s)', async mode => {
  const stopBeforeGeneration = mode === 'stop';
  const root = await mkdtemp(path.join(os.tmpdir(), 'agenda-growth-')); roots.push(root);
  const database = new DatabaseSync(':memory:'); databases.push(database); database.exec("CREATE TABLE companions(id TEXT PRIMARY KEY,deleted_at TEXT); INSERT INTO companions VALUES('alice',NULL)");
  let depth = 0;
  const db: CompanionConnection = { prepare(sql) { const s = database.prepare(sql); return { all: (...args) => s.all(...args as SQLInputValue[]), get: (...args) => s.get(...args as SQLInputValue[]), run: (...args) => { const r = s.run(...args as SQLInputValue[]); return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }; } }; },
    exec: sql => { database.exec(sql); }, close: () => database.close(), pragma: sql => database.prepare('PRAGMA ' + sql).get(), function: (name, options, fn) => { database.function(name, options, value => fn(String(value))); },
    transaction<T>(fn: () => T) { const run = () => { const key = 't' + ++depth; database.exec('SAVEPOINT ' + key); try { const value = fn(); database.exec('RELEASE ' + key); return value; } catch (error) { database.exec('ROLLBACK TO ' + key); database.exec('RELEASE ' + key); throw error; } finally { depth--; } }; return Object.assign(run, { immediate: run }); } };
  const registryStore = new CompanionArtifactRegistryStore(db); registryStore.initialize();
  const owner: Companion = { id: 'alice', name: 'Alice', description: '起点', persona: '我愿意认真对待交流。\n\n我仍在了解自己的表达习惯。', model: '', avatar: 'sister', builtin: true, proactive: false, active: true, createdAt: '2026-10-29T10:00:00Z' };
  const source: CompanionMessage = { id: 'source_one', sequence: 1, conversationId: 'private_one', authorId: 'alice', kind: 'text', content: '我发现先确认不确定的部分，更能让我把事情解释清楚。', createdAt: owner.createdAt, status: 'sent', attachments: [], revision: 1 };
  const note: CompanionMemory = { id: 'understanding_one', companionId: 'alice', scopeId: 'scope_one', artifactKind: 'self_understanding', content: source.content + '\n这是这次实际交流中的有条件认识。',
    metadata: { characterDevelopment: { kind: 'voice', topic: '有条件表达', statement: source.content, basis: 'self_expression', supersedesMemoryIds: [] } }, tags: ['表达'], diaryName: '自我认识', sourceMessageId: source.id,
    sourceConversationId: source.conversationId, sources: [{ messageId: source.id, conversationId: source.conversationId, sequence: 1, authorId: 'alice', revision: 1, checksum: companionArtifactHash(source.content), createdAt: owner.createdAt }],
    sourceSequence: 1, createdAt: owner.createdAt, updatedAt: owner.createdAt, origin: 'companion', status: 'indexed', version: 1, contentRevision: 1, captureMethod: 'automatic' };
  let debt = true;
  let direction = companionAgendaGoalSchema.parse({ id: 'voice_direction', companionId: 'alice', domain: 'persona', title: '更清楚地表达未知', intent: '希望在交流中练习先说明未知和适用条件。',
    successCriteria: ['在实际机会中试着说明未知，不宣称已经形成固定性格。'], nextQuestions: ['怎样表达才符合自己的判断？'], conversationId: 'private_one', revision: 1, origin: 'user', status: 'active', createdAt: owner.createdAt, updatedAt: owner.createdAt });
  const requestStorage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    switch (command.type) {
      case 'state': return { ok: true, state: { companions: [owner], conversations: [], resetJobs: [], activities: [], configured: true } };
      case 'character.development.scopes.page': return { ok: true, characterDevelopmentScopes: { items: debt ? [{ companionId: 'alice', conversationId: 'private_one', generation: 1 }] : [], hasMore: false } };
      case 'character.development.scopes.ack': debt = false; return { ok: true, characterDevelopmentScopeAcknowledged: true };
      case 'character.development': return { ok: true, characterDevelopment: { companionId: 'alice', conversationId: 'private_one', observedAt: new Date().toISOString(), truncated: false,
        items: mode === 'goal_only' ? [] : [{ memoryId: note.id, memoryVersion: 1, kind: 'voice', topic: '有条件表达', statement: source.content, basis: 'self_expression', sourceMessageIds: [source.id], updatedAt: owner.createdAt }] } };
      case 'agenda.goals.read': return { ok: true, agendaGoals: mode.startsWith('goal_') ? [direction] : [], agendaHasMore: false };
      case 'memory.lifecycle.state': return { ok: true, memoryLifecycleState: { companionId: 'alice', ledgerSequence: 1, revocationEpoch: 0 } };
      case 'memory.records.filter': return { ok: true, memories: command.ids.includes(note.id) ? [note] : [] };
      case 'memory.sources.filter': return { ok: true, memorySources: command.ids.includes(source.id) ? [source] : [] };
      default: throw new Error('Unexpected growth processor request ' + command.type);
    }
  });
  const profiles: CompanionAssetProfileStore = new CompanionAssetProfileStore(root, { registryStorage: { request: async command => { const response = registryStore.execute(command); if (!response) throw new Error('Unexpected registry operation'); return response; } },
    validatePersonaPublication: proposal => validateCompanionPersonaPublication(proposal, { requestStorage, profiles }) });
  const initial = await profiles.bootstrap(owner), registry = await profiles.artifacts('alice');
  const registered = await registry.publish({ artifactId: companionGrowthSourceArtifactId(source.id, 1), kind: 'source_evidence', producer: { kind: 'host', id: 'source:one' }, relativePath: '证据/来源/source_one-r1.md',
    content: source.content, expectedRevision: null, sourceRefs: [], dependencyRefs: [], visibility: { scope: 'audience', audienceIds: ['private_one'] }, allowedConsumers: ['source_verification', 'audit'], retentionClass: 'evidence', operationId: 'source:one' });
  await registry.publish({ artifactId: 'memory:' + note.id, kind: 'self_understanding', producer: { kind: 'system', id: 'reflection:one' }, relativePath: '记忆/自我认识/main/one.md', content: note.content, expectedRevision: null,
    sourceRefs: [{ artifactId: registered.artifactId, contentRevision: registered.contentRevision, contentHash: registered.contentHash }], dependencyRefs: [], visibility: { scope: 'audience', audienceIds: ['private_one'] }, allowedConsumers: ['self_integration', 'self_recall', 'audit'], retentionClass: 'current', operationId: 'understanding:one' });
  let fixedNativeJob: CompanionGrowthNativeJob | undefined;
  const generate = vi.fn<typeof generateCompanionStructured>().mockImplementation(async context => {
    expect(fixedNativeJob).toMatchObject({ kind: 'growth', revision: 1 });
    if (mode.startsWith('goal_')) {
      expect(JSON.parse(context.user).cultivationDirections).toEqual([expect.objectContaining({ id: direction.id, intent: direction.intent, meaning: 'proposed_future_direction_not_established_personality' })]);
      expect(context.system).toContain('拒绝'); expect(context.system).toContain('不要求服从');
    }
    if (mode === 'goal_pause') direction = { ...direction, status: 'paused', revision: 2 };
    if (mode === 'goal_update') direction = { ...direction, intent: '调整后的新培养方向，旧提议不能继续。', revision: 2 };
    if (mode === 'goal_progress') direction = { ...direction, progress: '记录一次尝试，仍然保留自己的判断。', revision: 2 };
    if (mode === 'goal_decline') return { decisions: [], noChangeReason: '我暂时维持自己的表达方式，培养方向不等于必须改变人格。' };
    return { decisions: [{ action: 'qualify', fragmentId: initial.personaFragments.fragments[0]!.fragmentId, expectedHash: initial.personaFragments.fragments[0]!.contentHash,
    text: 'PRIVATE_FORMATION：我愿意认真交流；给建议时会先说明未知和适用条件。', supportingNoteIds: [note.id], reason: '一次真实表达提供了有条件的具体练习方向。', applicableBehavior: '解释前说明未知。', reevaluateWhen: '遇到反例时重新审视。' }], noChangeReason: '' }; });
  const service = new CompanionGrowthService({ profiles, requestStorage, getConfig: () => ({ apiFormat: 'openai_chat', model: 'controlled-fixture', apiKey: 'unused' }), generateStructured: generate, report: vi.fn() }); services.push(service);
  service.setAgendaDriven(vi.fn()); service.wake({ companionId: 'alice', conversationId: 'private_one' });
  const controller = new AbortController();
  const result = await service.runAgendaQuantum('alice', controller.signal, async (stage, nativeJob) => {
    if (nativeJob && stage === '当前人格回顾输入已经固定') {
      fixedNativeJob = nativeJob; expect(await service.inspectJob('alice', nativeJob.id)).toMatchObject({ inputVersion: nativeJob.inputVersion, revision: nativeJob.revision, state: 'pending' });
      if (stopBeforeGeneration) controller.abort();
    }
  });
  if (stopBeforeGeneration) {
    expect(result.outcome).toBe('cancelled'); expect(result.nativeJob?.id).toBe(fixedNativeJob?.id); expect(fixedNativeJob).toBeDefined(); expect(generate).not.toHaveBeenCalled();
    expect(debt).toBe(true); expect((await profiles.load('alice')).profileRevision).toBe(initial.profileRevision); return;
  }
  expect(requestStorage.mock.calls.some(([command]) => command.type === 'growth.goals.list')).toBe(false);
  if (['goal_pause', 'goal_update', 'goal_decline', 'goal_only'].includes(mode)) {
    expect(result.outcome).toBe('no_change'); expect((await profiles.load('alice')).profileRevision).toBe(initial.profileRevision);
    expect(generate).toHaveBeenCalledTimes(mode === 'goal_only' ? 0 : 1);
    if (mode === 'goal_pause' || mode === 'goal_update') expect(result.reason).toContain('培养方向');
    return;
  }
  expect(result.outcome).toBe('published'); expect(result.nativeJob?.kind).toBe('growth'); expect(debt).toBe(false);
  const current = await profiles.load('alice'); expect(current.profileRevision).not.toBe(initial.profileRevision);
  expect(projectCompanionAssetProfile(current, ['private_one']).persona).toContain('PRIVATE_FORMATION');
  expect(projectCompanionAssetProfile(current, ['unrelated_group']).persona).not.toContain('PRIVATE_FORMATION');
  expect((await service.runAgendaQuantum('alice', new AbortController().signal)).outcome).toBe('no_change'); expect(generate).toHaveBeenCalledTimes(1);
});
