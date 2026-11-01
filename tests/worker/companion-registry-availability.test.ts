import { mkdtemp, mkdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { registryStorageFixture } from '../fixtures/companion-registry-storage';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionArtifactRegistry, companionArtifactHash, type CompanionArtifactPublish, type CompanionRegistryStorage } from '../../src/main/companions/artifact-registry';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { CompanionModelAdmissionError } from '../../src/main/companions/model-quota';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionStorageNotDispatchedError } from '../../src/main/companions/storage-client';
import { CompanionValidationUnavailableError, companionValidationUnavailable } from '../../src/main/companions/validation-unavailable';
import { guardCompanionExecutionSources, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import type { Companion } from '../../src/shared/companions';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import type { CompanionConnection } from '../../src/companions/store';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const roots: string[] = [], databases: Array<{ close(): void }> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-registry-availability-')) throw new Error('Unexpected cleanup target.');
    await rm(root, { recursive: true, force: true });
  }
});
const owner: Companion = { id: 'alice', name: 'Alice', description: '', persona: '有来源的伙伴。', model: '', avatar: 'sister',
  builtin: true, proactive: false, active: true, createdAt: '2026-10-28T10:00:00Z' };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-registry-availability-')); roots.push(root);
  const database = registryStorageFixture(root); databases.push(database);
  let failure: unknown, hits = 0;
  const storage: CompanionRegistryStorage = { request: command => {
    if (failure && command.type === 'cognition.registry.refs.validate') { hits++; return Promise.reject(failure); }
    return database.storage.request(command);
  } };
  const profiles = new CompanionAssetProfileStore(path.join(root, 'owners'), { registryStorage: storage });
  const initial = await profiles.bootstrap(owner);
  const state = () => ({ artifacts: database.sqlite.prepare('SELECT * FROM companion_artifacts ORDER BY owner_id,artifact_id').all(),
    publications: database.sqlite.prepare('SELECT * FROM companion_artifact_publications ORDER BY owner_id,operation_id').all() });
  return { root, database, profiles, initial, state, get hits() { return hits; }, fail: (value?: unknown) => { failure = value; hits = 0; } };
}

it.each([
  ['not-dispatched', () => new CompanionStorageNotDispatchedError('Request remained in the host queue; it was not executed.')],
  ['posted-unknown', () => new CompanionValidationUnavailableError('The posted transaction has not yet acknowledged its execution state.')],
  ['wrapped-unavailable', () => new Error('The host reader is unavailable.', { cause: new CompanionValidationUnavailableError('Transport stopped.') })],
  ['files-pending', () => new CompanionModelAdmissionError('files_pending', 'Canonical files are not ready.')],
  ['sqlite-busy', () => Object.assign(new Error('The SQL reader is busy.'), { code: 'SQLITE_BUSY' })],
] as const)('preserves the original %s through real Registry/profile validation, with no failure state or automatic retry', async (kind, create) => {
  const f = await fixture(), error = create(), before = f.state(), profileBytes = await readFile(path.join(f.initial.root, 'profile.md'));
  f.fail(error);
  await expect(f.profiles.loadProfile(owner.id)).rejects.toBe(error);
  expect(f.hits).toBe(1); expect(companionValidationUnavailable(error)).toBe(true);
  if (kind === 'not-dispatched') expect(error).toHaveProperty('notDispatched', true);
  if (kind === 'posted-unknown') expect(error).not.toHaveProperty('notDispatched');
  expect(f.state()).toEqual(before); expect(await readFile(path.join(f.initial.root, 'profile.md'))).toEqual(profileBytes);
  f.fail(); expect((await f.profiles.loadProfile(owner.id)).profile).toEqual(f.initial.profile);
  expect(f.state()).toEqual(before);
});

it('does not permanently invalidate a real derived message when its current profile reference reader is unavailable', async () => {
  const f = managedMemoryFiles();
  const profiles = new CompanionAssetProfileStore(f.directory, { registryStorage: { request: f.request } });
  await profiles.bootstrap(owner);
  const source = f.source('仍然存在且有读取权的原始事件。');
  const readset: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, ...f.scope,
    sources: [{ id: source.id, conversationId: source.conversationId, checksum: companionArtifactHash(source.content) }], memories: [], topics: [], knowledgeReads: [], contexts: [] };
  const derived = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: owner.id, content: '由该真实事件形成的正式发言。', executionReadset: readset });
  const error = new CompanionStorageNotDispatchedError('The profile reference request was not dispatched.');
  const command = { type: 'message.get', id: derived.id } as const;
  const guarded = () => withCompanionExecutionValidation(async () => guardCompanionExecutionSources(command, await f.request(command), {
    identity: profiles, revision: () => 0, storage: f.request,
    valid: async (proof, sqliteSourcesValidated) => {
      await profiles.loadProfile(owner.id);
      return verifyCompanionExecutionReadset(proof.executionReadset, proof, { sqliteSourcesValidated, request: f.request });
    },
  }));
  try {
    f.intercept(request => { if (request.type === 'cognition.registry.refs.validate') throw error; });
    await expect(guarded()).rejects.toBe(error);
    expect(f.commands.some(request => request.type === 'execution.invalidate')).toBe(false);
    f.intercept();
    expect(f.store.request({ type: 'execution.sources', sourceMessageIds: [derived.id], memoryIds: [] }).executionSources?.find(proof => proof.id === derived.id)?.invalidated).not.toBe(true);
    expect((await guarded()).message?.content).toBe(derived.content);
    f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id], persistent: true });
    expect((await guarded()).message?.content).toBe('');
    expect(f.commands.some(request => request.type === 'execution.invalidate')).toBe(true);
  } finally { f.intercept(); await f.close(); }
});

it('keeps a posted commit acknowledgement loss unknown without conflict mutation or automatic publication replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-registry-availability-')); roots.push(root);
  const directory = path.join(root, owner.id); await mkdir(directory);
  const database = registryStorageFixture(root); databases.push(database);
  const error = new CompanionValidationUnavailableError('The posted commit acknowledgement was lost; do not replay it.');
  let commits = 0;
  const storage: CompanionRegistryStorage = { request: async command => {
    const response = await database.storage.request(command);
    if (command.type === 'cognition.registry.publication.commit') { commits++; throw error; }
    return response;
  } };
  const registry = new CompanionArtifactRegistry(directory, owner.id, { registryStorage: storage });
  const item: CompanionArtifactPublish = { artifactId: 'memory:available', kind: 'episode_memory', relativePath: '记忆/经历/available.md',
    producer: { kind: 'system', id: 'fixture:publication' }, expectedRevision: null, content: '由真实宿主事务发布的正文。',
    sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['episode_recall', 'audit'], retentionClass: 'current' };
  await expect(registry.publish({ ...item, operationId: 'fixture:posted-commit' })).rejects.toBe(error);
  expect(commits).toBe(1); expect(error).not.toHaveProperty('notDispatched');
  expect((await registry.publication('fixture:posted-commit'))?.state).toBe('committed');
  expect((await registry.read({ artifactId: item.artifactId, consumer: 'audit' })).text).toBe(item.content);
  expect(commits).toBe(1);
  expect(database.commands.filter(command => command.type === 'cognition.registry.publication.transition' && command.nextState === 'conflict')).toHaveLength(0);
});

it('keeps a real leased capture pending without quality debt when its canonical profile validation was not dispatched', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const now = Date.now(); vi.setSystemTime(now - 30 * 60000);
  const f = managedMemoryFiles(), source = f.source('仍有权处理的旧来源。');
  const profiles = new CompanionAssetProfileStore(f.directory, { registryStorage: { request: f.request } });
  const initial = await profiles.bootstrap(owner); vi.setSystemTime(now);
  const db = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
  const rows = () => db.prepare('SELECT id,message_id,source_checksum,source_revision,status,attempts,failure_count,cycle_failure_count,admission_deferred FROM vcp_capture_jobs WHERE message_id=?').all(source.id) as Array<{
    id: string; message_id: string; source_checksum: string; source_revision: number; status: string; attempts: number; failure_count: number; cycle_failure_count: number; admission_deferred: number }>;
  const before = rows(), error = new CompanionStorageNotDispatchedError('The canonical profile reference request was not dispatched.');
  const fetchFn = vi.fn<typeof fetch>(async () => { throw new Error('An unavailable validation must never dispatch a model.'); });
  const service = new CompanionMemoryService({ request: async command => {
    if (command.type === 'memory.sources.filter') await profiles.loadProfile(owner.id);
    return f.request(command);
  }, configFor: async () => ({ model: 'controlled-model', apiKey: 'fixture', apiFormat: 'openai_chat' }), fetchFn,
    busy: () => false, changed: vi.fn(), report: vi.fn() });
  service.setAgendaDriven(vi.fn());
  try {
    expect(before).toHaveLength(1);
    f.intercept(command => { if (command.type === 'cognition.registry.refs.validate') throw error; });
    expect((await service.runAgendaQuantum(owner.id, new AbortController().signal)).outcome).toBe('waiting');
    const after = rows(); expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before[0]!.id, message_id: source.id, source_checksum: before[0]!.source_checksum,
      source_revision: before[0]!.source_revision, status: 'pending', admission_deferred: 1,
      failure_count: before[0]!.failure_count, cycle_failure_count: before[0]!.cycle_failure_count });
    expect(after[0]!.attempts).toBe(before[0]!.attempts + 1);
    expect(f.commands.some(command => command.type === 'memory.jobs.fail' && command.failureKind === 'waiting' && command.preserveProposal)).toBe(true);
    expect(f.commands.some(command => command.type === 'memory.jobs.fail' && command.failureKind === 'cancelled')).toBe(false);
    expect(f.commands.some(command => command.type === 'execution.invalidate')).toBe(false); expect(fetchFn).not.toHaveBeenCalled();
    f.intercept(); expect((await profiles.loadProfile(owner.id)).profile).toEqual(initial.profile);
  } finally { f.intercept(); await service.close(); db.close(); await f.close(); }
});

it.each(['CONFLICT', 'DENIED', 'SQLITE_CONSTRAINT', 'ENOENT', 'UNKNOWN'] as const)('retains the original hard Registry failure for %s without classifying it as retryable', async code => {
  const f = await fixture(), before = f.state();
  f.fail(Object.assign(new Error('A real domain or unknown port failure.'), { code }));
  await expect(f.profiles.loadProfile(owner.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(f.hits).toBe(1); expect(f.state()).toEqual(before);
  expect(companionValidationUnavailable(Object.assign(new Error('Domain failure.'), { code }))).toBe(false);
});

it('still rejects withdrawn permissions and missing canonical profile bytes after an available reference read', async () => {
  const f = await fixture(), registry = await f.profiles.artifacts(owner.id);
  const artifact = (await registry.findByPath('profile.md'))!;
  await expect(registry.read({ artifactId: artifact.artifactId, consumer: 'episode_recall' })).rejects.toMatchObject({ code: 'DENIED' });
  await unlink(path.join(f.initial.root, 'profile.md'));
  await expect(f.profiles.loadProfile(owner.id)).rejects.toMatchObject({ code: 'MISSING' });
});
