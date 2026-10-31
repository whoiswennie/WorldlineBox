import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CompanionContextSnapshots } from '../../src/main/companions/context-snapshots';
import { CompanionArtifactRegistry } from '../../src/main/companions/artifact-registry';
import { generateCompanionText, generateCompanionReply, generateCompanionStructured, repairCompanionStructured, type CompanionModelConfig, type CompanionTransportAttemptInput } from '../../src/main/companions/model';
import { companionContextFrameSchema, companionContextSnapshotSummarySchema, type CompanionContextFrame } from '../../src/shared/companion-cognition';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import BetterSqlite3 from 'better-sqlite3';
import { CompanionArtifactRegistryStore } from '../../src/companions/artifact-registry-store';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionRegistryStorageCommand } from '../../src/shared/companion-registry-storage';
import { createCompanionExecutionValidationSession } from '../../src/main/companions/source-execution-evidence';

const roots: string[] = [];
const databases: CompanionConnection[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) { if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error('Unsafe fixture cleanup'); await rm(root, { recursive: true, force: true }); } });
const digest = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const frame = (owner = 'alice', user = '{"purpose":"test_call"}'): CompanionContextFrame => ({ schema: 'worldlinebox.companion-context-v2', companionId: owner, purpose: 'test_call', profileRevision: 'a'.repeat(64), promptRevision: 'b'.repeat(64), conversationId: 'room', invocationId: owner + ':room:message1', revocationEpoch: 0, identity: '当时的完整人格。', roleGuidance: '当时选用的角色指导。', processorContract: '当时的处理合同。', input: user });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wlbox-context-transport-')); roots.push(root); await Promise.all(['alice', 'bob'].map(owner => mkdir(path.join(root, owner))));
  const Database = BetterSqlite3 as { new(filename: string): CompanionConnection }, db = new Database(path.join(root, 'registry.sqlite')); databases.push(db);
  db.exec("CREATE TABLE companions(id TEXT PRIMARY KEY,deleted_at TEXT); INSERT INTO companions(id) VALUES('alice'),('bob');");
  const registryStore = new CompanionArtifactRegistryStore(db); registryStore.initialize();
  const epochs = new Map<string, number>([['alice', 0], ['bob', 0]]);
  const commands: CompanionRegistryStorageCommand[] = []; let failure: ((command: CompanionRegistryStorageCommand) => boolean) | undefined;
  const artifacts = async (owner: string) => new CompanionArtifactRegistry(path.join(root, owner), owner, { registryStorage: { request: async command => { commands.push(command); const result = registryStore.execute(command) ?? { ok: false, error: 'Unknown registry command' }; if (failure?.(command)) { failure = undefined; throw new Error('fixture durable publication crash'); } return result; } } });
  const options = { artifacts, currentRevocationEpoch: async (owner: string) => epochs.get(owner)!, validateRead: async () => undefined, maxSnapshotsPerOwner: 4 };
  const snapshots = new CompanionContextSnapshots(options);
  const config: CompanionModelConfig = { ownerId: 'alice', apiFormat: 'openai_chat', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com', apiKey: 'DO_NOT_STORE_THIS_CREDENTIAL',
    resolveAssetContext: async context => ({ ...context, frame: frame('alice', context.user) }), transportObserver: snapshots };
  return { root, snapshots, config, artifacts, epochs, options, commands, failOnce: (predicate: (command: CompanionRegistryStorageCommand) => boolean) => { failure = predicate; } };
}
function response(content = '完成', status = 200) { return new Response(JSON.stringify(status === 200 ? { choices: [{ message: { content, reasoning_content: 'HIDDEN_REASONING_MUST_NOT_BE_RECORDED' } }] } : { error: { code: 'unsupported_image_input', message: 'image not supported' } }), { status, headers: { 'Content-Type': 'application/json' } }); }

async function scanFixture() {
  const f = await fixture(), registry = await f.artifacts('alice');
  const source = await registry.publish({ artifactId: 'source:audit_shared', kind: 'source_evidence', producer: { kind: 'host', id: 'fixture' },
    relativePath: '证据/来源/audit-shared.md', expectedRevision: null, content: 'UNCHANGED_SHARED_AUDIT_SOURCE', sourceRefs: [], dependencyRefs: [],
    visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'evidence', operationId: 'fixture:audit-source' });
  const snapshots = new CompanionContextSnapshots({ ...f.options, artifacts: async owner => owner === 'alice' ? registry : f.artifacts(owner) });
  const input = (invocation: string): CompanionTransportAttemptInput => ({ frame: { ...frame(), invocationId: 'scan:' + invocation,
    sourceRefs: [{ artifactId: source.artifactId, contentHash: source.contentHash, contentRevision: source.contentRevision }] },
    providerBody: JSON.stringify({ input: invocation }), providerFormat: 'openai_chat', model: 'fixture', imageFallback: false });
  for (let index = 0; index < 2; index++) await (await snapshots.prepareAttempt(input('old' + index))).complete('cancelled_before_send');
  const old = (await snapshots.list('alice')).items;
  const stateIds = new Set(old.map(item => 'context-state:' + item.id));
  return { ...f, registry, snapshots, source, input, old, stateIds };
}

it('batches the readonly old-attempt scan and settlement with fresh SQL fences outside the caller semantic ledger', async () => {
  const f = await scanFixture(), originalBatch = f.registry.publishBatch.bind(f.registry), originalPublish = f.registry.publish.bind(f.registry);
  let scan: CompanionRegistryStorageCommand[] = [], settlement: CompanionRegistryStorageCommand[] = [];
  vi.spyOn(f.registry, 'publishBatch').mockImplementation((...args) => { if (args[0].operationId.startsWith('context:prepare:')) scan = [...f.commands]; return originalBatch(...args); });
  vi.spyOn(f.registry, 'publish').mockImplementation((...args) => { if (args[0].operationId.startsWith('context:cancelled_before_send:')) settlement = [...f.commands]; return originalPublish(...args); });
  const session = createCompanionExecutionValidationSession();
  try {
    await session.run(async () => {
      await f.registry.read({ artifactId: f.source.artifactId, consumer: 'audit' }); f.commands.length = 0;
      const attempt = await f.snapshots.prepareAttempt(f.input('new'));
      expect(scan.filter(command => command.type === 'cognition.registry.refs.validate')).toHaveLength(3); // One batch admission + two fresh final sides.
      expect(scan.some(command => command.type === 'cognition.registry.read' && command.artifactIds?.length === 2
        && command.artifactIds.every(id => f.stateIds.has(id)))).toBe(true);
      expect(scan.filter(command => command.type === 'cognition.registry.read' && command.artifactId === 'context-index:recent')).toHaveLength(1);
      // The admitted baseline plus publication's actual CAS lookup suffice;
      // there is no redundant prune/index read before or after that publish.
      expect(f.commands.filter(command => command.type === 'cognition.registry.read' && command.artifactId === 'context-index:recent')).toHaveLength(2);
      f.commands.length = 0; await attempt.complete('cancelled_before_send');
      expect(settlement.filter(command => command.type === 'cognition.registry.refs.validate')).toHaveLength(3);
    });
    await expect(session.validate()).resolves.toBeUndefined(); // Audit index/state writes never invalidate caller inputs.
    expect((await f.snapshots.list('alice')).items).toHaveLength(3);
  } finally { session.close(); }
});

it.each(['same_stat_bytes', 'dependency_withdrawal'] as const)('rejects %s during the private readonly scan before publishing a new attempt', async change => {
  const f = await scanFixture(), original = f.registry.readMany.bind(f.registry); let mutated = false;
  vi.spyOn(f.registry, 'readMany').mockImplementation(async inputs => {
    const result = await original(inputs);
    if (!mutated && inputs.some(input => f.stateIds.has(input.artifactId))) {
      if (change === 'same_stat_bytes') {
        const target = result.find(item => f.stateIds.has(item.artifact.artifactId))!, file = path.join(f.registry.root, target.artifact.relativePath), stamp = await stat(file);
        const bytes = Buffer.from(target.bytes); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        await writeFile(file, bytes); await utimes(file, stamp.atime, stamp.mtime);
      } else {
        const Database = BetterSqlite3 as { new(filename: string): CompanionConnection }, external = new Database(path.join(f.root, 'registry.sqlite'));
        try { external.prepare("UPDATE companion_artifacts SET state='revoked',metadata=json_set(metadata,'$.publicationState','revoked') WHERE owner_id=? AND artifact_id=?").run('alice', 'context:' + f.old[0]!.id); }
        finally { external.close(); }
      }
      mutated = true;
    }
    return result;
  });
  f.commands.length = 0;
  await expect(f.snapshots.prepareAttempt(f.input('refused'))).rejects.toMatchObject({ code: change === 'same_stat_bytes' ? 'CHANGED' : 'DENIED' });
  expect(mutated).toBe(true); expect(f.commands.some(command => command.type === 'cognition.registry.publication.prepare')).toBe(false);
});

it('keeps settlement state CAS after the readonly gate closes rather than overwriting a concurrent committed state revision', async () => {
  const f = await scanFixture(), attempt = await f.snapshots.prepareAttempt(f.input('state_cas'));
  const id = (await f.snapshots.list('alice')).items[0]!.id, original = f.registry.publish.bind(f.registry); let raced = false;
  vi.spyOn(f.registry, 'publish').mockImplementation(async (...args) => {
    if (!raced && args[0].artifactId === 'context-state:' + id) {
      raced = true;
      await original({ ...args[0], operationId: 'context:fixture-cas:' + id,
        content: await readFile(path.join(f.registry.root, '.运行', '上下文', id, 'attempt.json'), 'utf8') });
    }
    return original(...args);
  });
  await expect(attempt.dispatched()).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(raced).toBe(true); expect((await f.snapshots.read('alice', id)).status).toBe('prepared');
  const originalBatch = f.registry.publishBatch.bind(f.registry); let indexRaced = false;
  vi.spyOn(f.registry, 'publishBatch').mockImplementation(async (...args) => {
    if (!indexRaced && args[0].operationId.startsWith('context:prepare:')) {
      indexRaced = true;
      const index = args[0].items.find(item => item.artifactId === 'context-index:recent')!;
      await originalBatch({ operationId: 'context:index:fixture-race', items: [{ ...index,
        content: await readFile(path.join(f.registry.root, '.运行', '索引', '上下文.json'), 'utf8') }] });
    }
    return originalBatch(...args);
  });
  await expect(f.snapshots.prepareAttempt(f.input('index_cas'))).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(indexRaced).toBe(true); expect((await f.snapshots.list('alice')).items).toHaveLength(3);
});

it('cancels a real model blocked in the private audit scan without HTTP or an orphan receipt, then admits the next task', async () => {
  const f = await scanFixture(), controller = new AbortController(), original = f.registry.readMany.bind(f.registry);
  let release!: () => void, entered = false, resumed = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.registry, 'readMany').mockImplementation(async inputs => {
    if (!entered && inputs.some(input => f.stateIds.has(input.artifactId))) { entered = true; await blocked; resumed = true; }
    return original(inputs);
  });
  const finish = vi.fn(async () => undefined), fetchFn = vi.fn<typeof fetch>(async () => response('后继任务真实完成'));
  const config = (invocation: string): CompanionModelConfig => ({ ...f.config, transportObserver: f.snapshots,
    providerLifecycle: { beforeDispatch: async () => finish },
    resolveAssetContext: async context => ({ ...context, frame: { ...f.input(invocation).frame, input: context.user } }) });
  f.commands.length = 0;
  const pending = generateCompanionText({ system: '实际处理合同', user: '{}' }, config('aborted_scan'), controller.signal, { fetchFn });
  try {
    await vi.waitFor(() => expect(entered).toBe(true)); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith('cancelled_before_send', 0));
    expect(fetchFn).not.toHaveBeenCalled(); expect(f.commands.some(command => command.type === 'cognition.registry.publication.prepare')).toBe(false);
    expect(await generateCompanionText({ system: '实际处理合同', user: '{}' }, config('next_task'), undefined, { fetchFn })).toBe('后继任务真实完成');
    expect(fetchFn).toHaveBeenCalledOnce();
    const list = await f.snapshots.list('alice'); expect(list.items).toHaveLength(3); expect(list.items[0]?.status).toBe('response');
    const saved = await f.snapshots.read('alice', list.items[0]!.id); expect(saved).not.toHaveProperty('signal'); expect(JSON.parse(saved.providerBody)).not.toHaveProperty('signal');
  } finally { release(); await vi.waitFor(() => expect(resumed).toBe(true)); }
});

it('cancels an unstarted owner-queued prepare immediately and skips its later work without interrupting the active publication', async () => {
  const f = await scanFixture(), controller = new AbortController(), original = f.registry.readMany.bind(f.registry);
  let release!: () => void, entered = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(f.registry, 'readMany').mockImplementation(async inputs => {
    if (!entered && inputs.some(input => f.stateIds.has(input.artifactId))) { entered = true; await blocked; }
    return original(inputs);
  });
  const first = f.snapshots.prepareAttempt(f.input('active'));
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    const queued = f.snapshots.prepareAttempt({ ...f.input('never_started'), signal: controller.signal });
    const observed = queued.then(value => ({ value }), error => ({ error }));
    await new Promise<void>(resolve => setImmediate(resolve)); controller.abort();
    expect(await observed).toMatchObject({ error: { name: 'AbortError' } });
    release(); await (await first).complete('cancelled_before_send');
    expect((await f.snapshots.list('alice')).items.map(item => item.invocationId)).not.toContain('scan:never_started');
    expect((await f.snapshots.list('alice')).items).toHaveLength(3);
  } finally { release(); await first; }
});

it('keeps audit read-modify-write receipts outside the finite semantic-input ledger', async () => {
  const f = await fixture(), registry = await f.artifacts('alice');
  const source = await registry.publish({ artifactId: 'source:semantic', kind: 'source_evidence', producer: { kind: 'host', id: 'test' },
    relativePath: '证据/来源/semantic.md', expectedRevision: null, content: 'UNCHANGED_SEMANTIC_INPUT', sourceRefs: [], dependencyRefs: [],
    visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'evidence', operationId: 'semantic:initial' });
  const first = await f.snapshots.prepareAttempt({ frame: frame(), providerBody: '{"first":true}', providerFormat: 'openai_chat', model: 'test', imageFallback: false });
  await first.complete('cancelled_before_send');
  const session = createCompanionExecutionValidationSession();
  try {
    await session.run(async () => {
      expect((await registry.read({ artifactId: source.artifactId, consumer: 'audit' })).text).toBe('UNCHANGED_SEMANTIC_INPUT');
      const attempt = await f.snapshots.prepareAttempt({ frame: { ...frame(), invocationId: 'different:attempt' }, providerBody: '{"second":true}', providerFormat: 'openai_chat', model: 'test', imageFallback: false });
      await attempt.beforeDispatch(); await attempt.dispatched(); await attempt.complete('response', 200);
    });
    await expect(session.validate()).resolves.toBeUndefined();
    expect((await f.snapshots.list('alice')).items.map(item => item.status)).toEqual(['response', 'cancelled_before_send']);
  } finally { session.close(); }
});

it('still rejects an actual semantic-file edit around isolated audit publication', async () => {
  const f = await fixture(), registry = await f.artifacts('alice');
  const source = await registry.publish({ artifactId: 'source:semantic', kind: 'source_evidence', producer: { kind: 'host', id: 'test' },
    relativePath: '证据/来源/semantic.md', expectedRevision: null, content: 'ORIGINAL_SEMANTIC_INPUT', sourceRefs: [], dependencyRefs: [],
    visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'evidence', operationId: 'semantic:initial' });
  const session = createCompanionExecutionValidationSession();
  try {
    await session.run(async () => {
      await registry.read({ artifactId: source.artifactId, consumer: 'audit' });
      const attempt = await f.snapshots.prepareAttempt({ frame: frame(), providerBody: '{}', providerFormat: 'openai_chat', model: 'test', imageFallback: false });
      await attempt.complete('cancelled_before_send');
      await writeFile(path.join(registry.root, source.relativePath), 'EXTERNALLY_CHANGED_INPUT');
    });
    await expect(session.validate()).rejects.toThrow('正式正文已经变化');
  } finally { session.close(); }
});

it('settles a never-sent audit receipt after its caller has already been cancelled', async () => {
  const f = await fixture(), controller = new AbortController(), session = createCompanionExecutionValidationSession(controller.signal);
  let settlement: Promise<void> | undefined;
  await expect(session.run(async () => {
    const attempt = await f.snapshots.prepareAttempt({ frame: frame(), providerBody: '{}', providerFormat: 'openai_chat', model: 'test', imageFallback: false });
    controller.abort(); settlement = attempt.complete('cancelled_before_send'); await settlement;
  })).rejects.toThrow();
  await settlement; session.close();
  expect((await f.snapshots.list('alice')).items[0]?.status).toBe('cancelled_before_send');
});

async function structuredFixture(invocationId: string | undefined = 'journal:fixed:host-attempt1') {
  const f = await fixture(), registry = await f.artifacts('alice'), text = '三本书，十四天；预约后不能续借。';
  const source = await registry.publish({ artifactId: 'source:original:r1', kind: 'source_evidence', producer: { kind: 'host', id: 'fixture-source' }, relativePath: '证据/来源/original-r1.md', expectedRevision: null, content: text,
    sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['source_verification', 'audit'], retentionClass: 'evidence', operationId: 'fixture:original:r1' });
  const prompt = await registry.publish({ artifactId: 'prompt:journal', kind: 'processor_prompt', producer: { kind: 'host', id: 'fixture-host-prompt' }, relativePath: '提示词/处理职能/journal.md', expectedRevision: null, content: '只提取真实原文。',
    sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['processor', 'audit'], retentionClass: 'current', operationId: 'fixture:prompt:r1' });
  const sourceRefs = [{ artifactId: source.artifactId, contentRevision: source.contentRevision, contentHash: source.contentHash }], dependencyRefs = [{ artifactId: prompt.artifactId, contentRevision: prompt.contentRevision, contentHash: prompt.contentHash }];
  const versions: { profileRevision: string; promptRevision: string; invocationId: string | undefined } = { profileRevision: 'a'.repeat(64), promptRevision: 'b'.repeat(64), invocationId };
  const context = { system: '只提取实际提供的依据，不制造新经历。', user: JSON.stringify({ purpose: 'vcp_experience_journal', conversationId: 'room', messages: [{ id: 'original', authorId: 'user', content: text }], outputSchema: { type: 'object', required: ['notes'], properties: { notes: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } }) };
  const resolve: NonNullable<CompanionModelConfig['resolveAssetContext']> = async value => { const data = JSON.parse(value.user), repair = data.purpose === 'companion_structured_repair'; return { ...value, frame: { ...frame('alice', value.user), purpose: data.purpose, identity: '', processorContract: value.system,
    ...versions, revocationEpoch: f.epochs.get('alice')!, sourceRefs: repair ? [] : sourceRefs, dependencyRefs: repair ? [] : dependencyRefs } }; };
  const global: CompanionModelConfig = { ...f.config, model: 'GLOBAL_REPAIR_MODEL', baseUrl: 'https://global-fixture.invalid', apiKey: 'GLOBAL_SECRET_MUST_NOT_BE_STORED', resolveAssetContext: resolve };
  const config: CompanionModelConfig = { ...f.config, model: 'PRIVATE_ROLE_MODEL', baseUrl: 'https://private-fixture.invalid', apiKey: 'PRIVATE_SECRET_MUST_NOT_BE_STORED', resolveAssetContext: resolve, resolveStructuredRepairConfig: async () => global };
  return { ...f, registry, context, config, global, versions, sourceRefs, dependencyRefs, resolve };
}

it.each(['syntax', 'schema'] as const)('records the real private request and two global repair attempts for an initial %s failure with an unchanged source closure', async reason => {
  const f = await structuredFixture(), invalid = reason === 'syntax' ? '{"notes":' : '{"notes":4}', middle = reason === 'syntax' ? '{"notes":4}' : '{broken';
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response(middle)).mockResolvedValueOnce(response('{"notes":[]}'));
  expect(await generateCompanionStructured(f.context, f.config, undefined, { fetchFn, responseSchema: z.strictObject({ notes: z.array(z.string()) }) })).toEqual({ notes: [] });
  expect(fetchFn).toHaveBeenCalledTimes(3); expect(fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(['PRIVATE_ROLE_MODEL', 'GLOBAL_REPAIR_MODEL', 'GLOBAL_REPAIR_MODEL']);
  expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([expect.stringContaining('private-fixture.invalid'), expect.stringContaining('global-fixture.invalid'), expect.stringContaining('global-fixture.invalid')]);
  const list = await f.snapshots.list('alice'), records = await Promise.all(list.items.map(item => f.snapshots.read('alice', item.id))); records.sort((a, b) => (a.frame.structuredRepair?.attempt ?? 0) - (b.frame.structuredRepair?.attempt ?? 0)); expect(records).toHaveLength(3);
  const root = records[0]!, one = records[1]!, two = records[2]!, rootId = f.versions.invocationId!, firstId = 'structured-repair:' + digest(rootId) + ':1';
  expect(root.frame.structuredRepair).toBeUndefined(); expect(one.frame.structuredRepair).toEqual({ rootInvocationId: rootId, previousInvocationId: rootId, attempt: 1, reason, originalPurpose: 'vcp_experience_journal' });
  expect(one.frame.invocationId).toBe(firstId); expect(two.frame.invocationId).toBe('structured-repair:' + digest(rootId) + ':2'); expect(two.frame.structuredRepair?.previousInvocationId).toBe(firstId); expect(two.frame.structuredRepair?.reason).toBe(reason === 'syntax' ? 'schema' : 'syntax');
  for (const [index, record] of records.entries()) { expect(record.providerBody).toBe(fetchFn.mock.calls[index]![1]?.body); expect(record.status).toBe('response'); expect(record.frame.profileRevision).toBe(root.frame.profileRevision); expect(record.frame.revocationEpoch).toBe(0); expect(record.frame.sourceRefs).toEqual(f.sourceRefs); expect(record.frame.dependencyRefs).toEqual(f.dependencyRefs); expect(JSON.parse(record.providerBody)).not.toHaveProperty('tools'); expect(JSON.stringify(record)).not.toMatch(/PRIVATE_SECRET|GLOBAL_SECRET|HIDDEN_REASONING/u); }
  expect(JSON.parse(one.frame.input).invalidOutput).toBe(invalid); expect(JSON.parse(two.frame.input).invalidOutput).toBe(middle); expect(JSON.parse(one.frame.input).originalRequest).toEqual(f.context);
  await f.registry.revoke('source:original:r1'); f.epochs.set('alice', 1); await f.snapshots.redactStale('alice'); expect((await f.snapshots.list('alice')).items).toEqual([]);
  for (const record of records) for (const name of ['request.json', 'attempt.json']) await expect(readFile(path.join(f.root, 'alice', '.运行', '上下文', record.id, name))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await f.registry.page({ consumer: 'audit', kind: 'episode_memory', limit: 16 })).items).toEqual([]);
});

it('retains three actual response receipts and stops rather than manufacturing a third repair or a memory after exhausted shape repairs', async () => {
  const f = await structuredFixture(), fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => response('{"notes":4}'));
  await expect(generateCompanionStructured(f.context, f.config, undefined, { fetchFn, responseSchema: z.strictObject({ notes: z.array(z.string()) }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(fetchFn).toHaveBeenCalledTimes(3); const list = await f.snapshots.list('alice'); expect(list.items).toHaveLength(3); expect(list.items.every(item => item.status === 'response')).toBe(true); expect(list.items.flatMap(item => item.structuredRepair ? [item.structuredRepair.attempt] : []).sort()).toEqual([1, 2]);
  expect((await f.registry.page({ consumer: 'audit', kind: 'episode_memory', limit: 16 })).items).toEqual([]);
});

it.each(['profile', 'epoch'] as const)('refuses another HTTP repair when the actual %s changes after the original response', async changed => {
  const f = await structuredFixture(), fetchFn = vi.fn<typeof fetch>(async () => { if (changed === 'profile') f.versions.profileRevision = 'd'.repeat(64); else f.epochs.set('alice', 1); return response('{broken'); });
  await expect(generateCompanionStructured(f.context, f.config, undefined, { fetchFn, responseSchema: z.strictObject({ notes: z.array(z.string()) }) })).rejects.toMatchObject({ code: 'CANCELLED' }); expect(fetchFn).toHaveBeenCalledOnce();
  expect((await f.snapshots.list('alice')).items).toHaveLength(1);
});

it.each([true, false])('blocks a real unknown repair after restart without paying again, with original invocation present=%s', async withInvocation => {
  const f = await structuredFixture(withInvocation ? 'journal:host-attempt1' : undefined); if (!withInvocation) f.versions.invocationId = undefined;
  const resolved = await f.resolve(f.context, 'structured'); let calls = 0;
  const fetchFn = vi.fn<typeof fetch>(async () => { if (++calls === 1) return response('{broken'); f.failOnce(command => command.type === 'cognition.registry.publication.transition' && command.nextState === 'validated'); return response('{"notes":[]}'); });
  await expect(generateCompanionStructured(f.context, f.config, undefined, { fetchFn, responseSchema: z.strictObject({ notes: z.array(z.string()) }) })).rejects.toMatchObject({ code: 'CONTEXT_RECORD_FAILED' }); expect(fetchFn).toHaveBeenCalledTimes(2);
  await new CompanionContextSnapshots(f.options).recoverOwner('alice'); const unknown = (await f.snapshots.list('alice')).items.find(item => item.structuredRepair)!; expect(unknown.status).toBe('unknown'); expect(unknown.sentAt).toBeDefined();
  await expect(repairCompanionStructured({ context: f.context, raw: '{broken', resolvedContext: resolved, config: f.config, options: { fetchFn, responseSchema: z.strictObject({ notes: z.array(z.string()) }) } })).rejects.toMatchObject({ code: 'CONTEXT_RECORD_FAILED' }); expect(fetchFn).toHaveBeenCalledTimes(2);
  expect((await f.snapshots.read('alice', unknown.id)).frame.invocationId).toBe('structured-repair:' + digest(unknown.structuredRepair!.rootInvocationId) + ':1');
});

it('keeps a real foreground provider request responsive while a global background repair and its registry receipt are in flight', async () => {
  const f = await structuredFixture(); let release!: () => void, arrived!: () => void;
  const blocked = new Promise<Response>(resolve => { release = () => resolve(response('{"notes":[]}')); }), waiting = new Promise<void>(resolve => { arrived = resolve; });
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => { if (JSON.parse(String(init?.body)).model === 'GLOBAL_REPAIR_MODEL') { arrived(); return blocked; } return response('{broken'); });
  const pending = generateCompanionStructured(f.context, f.config, undefined, { fetchFn, responseSchema: z.strictObject({ notes: z.array(z.string()) }) });
  try { await waiting; const foregroundFetch = vi.fn<typeof fetch>().mockResolvedValue(response('前台已完成'));
    expect(await generateCompanionText({ system: '', user: '{"purpose":"foreground_probe"}' }, { ...f.config, ownerId: 'bob', workPriority: 'foreground', resolveAssetContext: async context => ({ ...context, frame: { ...frame('bob', context.user), purpose: 'foreground_probe' } }) }, undefined, { fetchFn: foregroundFetch })).toBe('前台已完成');
    expect(foregroundFetch).toHaveBeenCalledOnce(); expect((await f.snapshots.list('alice')).items.some(item => item.structuredRepair && item.status === 'dispatched')).toBe(true); expect((await f.snapshots.list('bob')).items[0]?.status).toBe('response');
  } finally { release(); await pending; }
});

it('stores the exact final fetch body, native tool declaration and tool-result history without credentials or hidden responses', async () => {
  const f = await fixture(), input: CompanionReplyInput = { companion: { id: 'alice', name: 'Alice', description: '', persona: '当前设定', model: '', avatar: 'custom', builtin: false, proactive: false, createdAt: '2026-10-28T00:00:00Z' }, conversation: { id: 'room', kind: 'private', title: '', memberIds: ['alice'], pinned: false, muted: false, unread: 0, updatedAt: '2026-10-28T00:00:00Z', lastMessage: '' }, messages: [], memories: [] };
  const fetchFn = vi.fn<typeof fetch>(async () => response('{"text":"知道了。"}'));
  await generateCompanionReply(input, f.config, undefined, { fetchFn, loop: true, tools: [{ name: 'world', description: '实际工具', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['query'] } } } }], turns: [{ text: '先查证。', rawText: '先查证。', calls: [{ id: 'call1', name: 'memory', arguments: '{}' }], results: [{ callId: 'call1', content: '真实工具回执，不是人格认识。' }] }] });
  const list = await f.snapshots.list('alice'), snapshot = await f.snapshots.read('alice', list.items[0]!.id), sent = String(fetchFn.mock.calls[0]![1]?.body);
  expect(snapshot.providerBody).toBe(sent); expect(snapshot.bodyHash).toBe(digest(sent)); expect(snapshot.providerBody).toContain('真实工具回执'); expect(snapshot.toolDeclarations).toContain('world'); expect(snapshot.toolDeclarations).not.toContain('memory');
  expect(snapshot.status).toBe('response'); expect(snapshot.sentAt).toBeDefined(); expect(snapshot.httpStatus).toBe(200); expect(snapshot.frame.invocationId).toBe('alice:room:message1');
  expect(JSON.stringify(snapshot)).not.toContain(f.config.apiKey); expect(JSON.stringify(snapshot)).not.toContain('HIDDEN_REASONING'); expect(JSON.stringify(snapshot)).not.toContain('Authorization');
  expect(list.items[0]).not.toHaveProperty('providerBody'); expect(list.items[0]).not.toHaveProperty('toolDeclarations');
  await expect(f.snapshots.read('bob', snapshot.id)).rejects.toThrow();
  const restarted = new CompanionContextSnapshots(f.options); expect((await restarted.read('alice', snapshot.id)).providerBody).toBe(sent);
});
it('keeps bounded repair metadata and exact independent bodies without making an unknown repair invocation retryable', async () => {
  const f = await fixture(), original = frame(), rootInvocationId = original.invocationId!, first = await f.snapshots.prepareAttempt({ frame: original, providerBody: '{"input":"ORIGINAL_REQUEST"}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false }); await first.dispatched(); await first.complete('response', 200);
  const invocationId = 'structured-repair:' + digest(rootInvocationId) + ':1', repairFrame: CompanionContextFrame = { ...original, purpose: 'companion_structured_repair', invocationId,
    structuredRepair: { rootInvocationId, previousInvocationId: rootInvocationId, attempt: 1, reason: 'syntax', originalPurpose: original.purpose }, processorContract: '只修复已有输出的结构。', input: '{"malformedOutput":"{broken"}' };
  const providerBody = JSON.stringify({ messages: [{ role: 'user', content: repairFrame.input }] }), repair = await f.snapshots.prepareAttempt({ frame: repairFrame, providerBody, providerFormat: 'openai_chat', model: 'fixture', imageFallback: false }); await repair.dispatched();
  await new CompanionContextSnapshots(f.options).recoverOwner('alice'); const list = await f.snapshots.list('alice'), metadata = list.items.find(item => item.invocationId === invocationId)!;
  expect(companionContextSnapshotSummarySchema.parse(metadata).structuredRepair).toEqual(repairFrame.structuredRepair); expect(metadata.status).toBe('unknown'); expect(metadata.sentAt).toBeDefined(); const saved = await f.snapshots.read('alice', metadata.id); expect(saved.providerBody).toBe(providerBody); expect(saved.frame).toEqual(repairFrame); expect(list.items.find(item => item.invocationId === rootInvocationId)?.status).toBe('response');
  await expect(f.snapshots.prepareAttempt({ frame: repairFrame, providerBody, providerFormat: 'openai_chat', model: 'fixture', imageFallback: false })).rejects.toMatchObject({ code: 'CONTEXT_RECORD_FAILED' });
  expect(companionContextFrameSchema.safeParse({ ...repairFrame, structuredRepair: { ...repairFrame.structuredRepair, attempt: 3 } }).success).toBe(false);
  expect(companionContextFrameSchema.safeParse({ ...repairFrame, structuredRepair: { ...repairFrame.structuredRepair, previousInvocationId: '' } }).success).toBe(false);
  f.epochs.set('alice', 1); await f.snapshots.redactStale('alice'); expect((await f.snapshots.list('alice')).items).toEqual([]); await expect(f.snapshots.read('alice', metadata.id)).rejects.toThrow();
});
it('records prepared cancellation truthfully without marking an unsent request as dispatched', async () => {
  const f = await fixture(), controller = new AbortController(), fetchFn = vi.fn<typeof fetch>(); let finish!: () => void;
  const settled = new Promise<void>(resolve => { finish = resolve; });
  const config = { ...f.config, transportObserver: { prepareAttempt: async (input: Parameters<CompanionContextSnapshots['prepareAttempt']>[0]) => { const attempt = await f.snapshots.prepareAttempt(input); controller.abort(); return { ...attempt, complete: async (...args: Parameters<typeof attempt.complete>) => { try { await attempt.complete(...args); } finally { finish(); } } }; } } };
  await expect(generateCompanionText({ system: '合同', user: '{"purpose":"test_call"}' }, config, controller.signal, { fetchFn })).rejects.toMatchObject({ code: 'CANCELLED' });
  await settled; const list = await f.snapshots.list('alice'); expect(list.items[0]?.status).toBe('cancelled_before_send'); expect(list.items[0]?.sentAt).toBeUndefined(); expect(fetchFn).not.toHaveBeenCalled();
});
it.each(['reply', 'text'] as const)('awaits the final host fence before %s HTTP and records a rejected fence as unsent', async kind => {
  const f = await fixture(), fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('unused'));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const beforeNetworkDispatch = vi.fn(async () => { await blocked; throw new Error('Actual final authority fence denied'); });
  const input: CompanionReplyInput = { companion: { id: 'alice', name: 'Alice', description: '', persona: '当前设定', model: '', avatar: 'custom', builtin: false, proactive: false, createdAt: '2026-10-28T00:00:00Z' }, conversation: { id: 'room', kind: 'private', title: '', memberIds: ['alice'], pinned: false, muted: false, unread: 0, updatedAt: '2026-10-28T00:00:00Z', lastMessage: '' }, messages: [], memories: [] };
  const pending = (kind === 'reply' ? generateCompanionReply(input, f.config, undefined, { fetchFn, beforeNetworkDispatch })
    : generateCompanionText({ system: '合同', user: '{"purpose":"test_call"}' }, f.config, undefined, { fetchFn, beforeNetworkDispatch })).then(value => ({ value }), error => ({ error }));
  try {
    await vi.waitFor(() => expect(beforeNetworkDispatch).toHaveBeenCalledTimes(1));
    expect(fetchFn).not.toHaveBeenCalled();
    const prepared = (await f.snapshots.list('alice')).items;
    expect(prepared).toHaveLength(1); expect(prepared[0]!.status).toBe('prepared'); expect(prepared[0]!.sentAt).toBeUndefined();
  } finally { release(); }
  expect(await pending).toMatchObject({ error: { code: 'CANCELLED' } });
  const denied = (await f.snapshots.list('alice')).items;
  expect(denied).toHaveLength(1); expect(denied[0]!.status).toBe('cancelled_before_send'); expect(denied[0]!.sentAt).toBeUndefined();
  expect(fetchFn).not.toHaveBeenCalled();
});
it('forwards the same final network fence into a real recorded structured repair without marking the denied child sent', async () => {
  const f = await structuredFixture(), fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('{broken'));
  let fences = 0;
  await expect(generateCompanionStructured(f.context, f.config, undefined, { fetchFn,
    responseSchema: z.strictObject({ notes: z.array(z.string()) }), beforeNetworkDispatch: async () => { if (++fences === 2) throw new Error('Repair authority withdrawn'); },
  })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(fences).toBe(2); expect(fetchFn).toHaveBeenCalledTimes(1);
  const receipts = (await f.snapshots.list('alice')).items;
  expect(receipts).toHaveLength(2);
  const child = receipts.find(item => item.structuredRepair);
  expect(child?.status).toBe('cancelled_before_send'); expect(child?.sentAt).toBeUndefined();
  expect(receipts.find(item => !item.structuredRepair)?.status).toBe('response');
});
it('records each image fallback as a separate actual protocol body and only labels pixels in the first request', async () => {
  const f = await fixture(), base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', sha256 = digest(Buffer.from(base64, 'base64'));
  const context = { system: '视觉合同', user: JSON.stringify({ purpose: 'test_call', publicProfiles: [{ id: 'alice', kind: 'companion', name: 'Alice', description: '', avatar: { absolutePath: 'C:/fixture/avatar.png', mime: 'image/png', sha256, available: true } }] }) };
  let calls = 0; const fetchFn = vi.fn<typeof fetch>(async () => calls++ === 0 ? response('', 400) : response());
  await generateCompanionText(context, f.config, undefined, { fetchFn, visualInputs: [{ personId: 'alice', role: 'avatar', mime: 'image/png', base64, sha256 }] });
  expect(fetchFn).toHaveBeenCalledTimes(2);
  const list = await f.snapshots.list('alice'), records = await Promise.all(list.items.map(item => f.snapshots.read('alice', item.id))), original = records.find(item => !item.imageFallback)!, fallback = records.find(item => item.imageFallback)!;
  expect(original.providerBody).toBe(fetchFn.mock.calls[0]![1]?.body); expect(fallback.providerBody).toBe(fetchFn.mock.calls[1]![1]?.body);
  expect(original.visualManifest).toEqual([expect.objectContaining({ delivery: 'inline_bytes', sha256 })]); expect(fallback.visualManifest).toEqual([]);
  expect(original.httpStatus).toBe(400); expect(fallback.httpStatus).toBe(200); expect(fallback.providerBody).not.toContain(base64);
});
it('marks dispatched network failures separately and rejects an epoch change before a prepared body can be sent', async () => {
  const f = await fixture(), fetchFn = vi.fn<typeof fetch>(async () => { throw new Error('fixture network error'); });
  await expect(generateCompanionText({ system: '合同', user: '{}' }, f.config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'NETWORK' });
  const list = await f.snapshots.list('alice'); expect(list.items[0]?.status).toBe('network_error'); expect(list.items[0]?.sentAt).toBeDefined();
  const attempt = await f.snapshots.prepareAttempt({ frame: frame(), providerBody: '{"model":"fixture","messages":[]}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false }); f.epochs.set('alice', 1);
  await expect(attempt.beforeDispatch()).rejects.toThrow('撤销'); await expect(f.snapshots.read('alice', list.items[0]!.id)).rejects.toThrow('撤回');
  await f.snapshots.redactOwner('alice'); expect((await f.snapshots.list('alice')).items).toEqual([]);
});
it('retires old registered bodies at the declared owner limit and never silently truncates an oversized request', async () => {
  const f = await fixture(); let oldest = '';
  for (let index = 0; index < 6; index++) { const attempt = await f.snapshots.prepareAttempt({ frame: frame(), providerBody: JSON.stringify({ model: 'fixture', input: String(index) }), providerFormat: 'openai_chat', model: 'fixture', imageFallback: false }); await attempt.beforeDispatch(); await attempt.dispatched(); await attempt.complete('response', 200); if (index === 0) oldest = (await f.snapshots.list('alice')).items[0]!.id; }
  expect((await f.snapshots.list('alice')).items).toHaveLength(4); await expect(f.snapshots.read('alice', oldest)).rejects.toThrow();
  await expect(readFile(path.join(f.root, 'alice', '.运行', '上下文', oldest, 'request.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(f.snapshots.prepareAttempt({ frame: frame(), providerBody: 'x'.repeat(f.snapshots.bodyLimitBytes + 1), providerFormat: 'openai_chat', model: 'fixture', imageFallback: false })).rejects.toThrow('超过完整快照容量');
});
it('serializes concurrent owner preparations without losing index entries or pruning in-flight requests to admit another payment', async () => {
  const f = await fixture(), prepare = (index: number) => f.snapshots.prepareAttempt({ frame: { ...frame(), invocationId: 'parallel:' + index }, providerBody: JSON.stringify({ input: 'PARALLEL_BODY_' + index }), providerFormat: 'openai_chat', model: 'fixture', imageFallback: false });
  const attempts = await Promise.all(Array.from({ length: 4 }, (_, index) => prepare(index)));
  const before = await f.snapshots.list('alice'); expect(new Set(before.items.map(item => item.id)).size).toBe(4);
  expect((await Promise.all(before.items.map(item => f.snapshots.read('alice', item.id)))).map(item => JSON.parse(item.providerBody).input).sort()).toEqual(Array.from({ length: 4 }, (_, index) => 'PARALLEL_BODY_' + index));
  await expect(prepare(4)).rejects.toThrow('未结算请求占用'); expect((await f.snapshots.list('alice')).items.map(item => item.id)).toEqual(before.items.map(item => item.id));
  await attempts[0]!.complete('cancelled_before_send'); const replacement = await prepare(4); await replacement.beforeDispatch();
  const after = await f.snapshots.list('alice'); expect(after.items).toHaveLength(4); expect(after.items.filter(item => item.status === 'prepared')).toHaveLength(4);
});
it('removes every private body in a full 24-attempt owner window and an interrupted publication while preserving another owner', async () => {
  const f = await fixture(), snapshots = new CompanionContextSnapshots({ ...f.options, maxSnapshotsPerOwner: 24 });
  for (let index = 0; index < 24; index++) { const attempt = await snapshots.prepareAttempt({ frame: { ...frame(), invocationId: 'retire:' + index }, providerBody: JSON.stringify({ input: 'PRIVATE_WINDOW_' + index }), providerFormat: 'openai_chat', model: 'fixture', imageFallback: false }); await attempt.complete('cancelled_before_send'); }
  const ids = (await snapshots.list('alice', 40)).items.map(item => item.id); expect(ids).toHaveLength(24);
  const other = await snapshots.prepareAttempt({ frame: frame('bob'), providerBody: '{"input":"BOB_STILL_ALLOWED"}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false }); await other.complete('cancelled_before_send'); const bob = (await snapshots.list('bob')).items[0]!;
  f.failOnce(command => command.type === 'cognition.registry.publication.transition' && command.nextState === 'file_published');
  await expect(snapshots.prepareAttempt({ frame: { ...frame(), invocationId: 'retire:pending' }, providerBody: '{"input":"PRIVATE_PENDING_WINDOW"}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false })).rejects.toThrow();
  const registry = await f.artifacts('alice'), pending = await registry.pendingPublications({ operationPrefix: 'context:', limit: 16 }); expect(pending).toHaveLength(1); f.commands.length = 0;
  f.epochs.set('alice', 1); await snapshots.redactOwner('alice'); expect((await snapshots.list('alice', 40)).items).toEqual([]);
  for (const id of ids) for (const filename of ['request.json', 'attempt.json']) await expect(readFile(path.join(f.root, 'alice', '.运行', '上下文', id, filename))).rejects.toMatchObject({ code: 'ENOENT' });
  for (const item of pending[0]!.items) { await expect(readFile(path.join(f.root, 'alice', ...item.stage.split('/')))).rejects.toMatchObject({ code: 'ENOENT' }); if (item.next.kind === 'context_snapshot') await expect(readFile(path.join(f.root, 'alice', ...item.next.relativePath.split('/')))).rejects.toMatchObject({ code: 'ENOENT' }); }
  expect(await registry.pendingPublications({ operationPrefix: 'context:', includeRevoked: true, limit: 16 })).toEqual([]); expect((await registry.page({ consumer: 'audit', kind: 'context_snapshot', publicationState: 'revoked', bodyCleanupRequired: true, limit: 256 })).items).toEqual([]);
  expect(f.commands.some(command => command.type === 'cognition.registry.publication.prepare')).toBe(false); expect((await snapshots.read('bob', bob.id)).providerBody).toContain('BOB_STILL_ALLOWED');
});
it.each(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'] as AiApiFormat[])('preserves the final protocol-specific body for %s', async apiFormat => {
  const f = await fixture();
  const envelopes: Record<AiApiFormat, unknown> = { openai_chat: { choices: [{ message: { content: '完成' } }] }, openai_responses: { output_text: '完成' }, anthropic: { content: [{ type: 'text', text: '完成' }] }, gemini_native: { candidates: [{ content: { parts: [{ text: '完成' }] } }] }, dashscope_native: { output: { choices: [{ message: { content: [{ text: '完成' }] } }] } } };
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(envelopes[apiFormat]), { headers: { 'Content-Type': 'application/json' } }));
  await expect(generateCompanionText({ system: '精确合同', user: '{"purpose":"test_call","instruction":"本次完整输入"}' }, { ...f.config, apiFormat }, undefined, { fetchFn })).resolves.toBe('完成');
  const list = await f.snapshots.list('alice'), snapshot = await f.snapshots.read('alice', list.items[0]!.id);
  expect(snapshot.providerBody).toBe(fetchFn.mock.calls[0]![1]?.body); expect(snapshot.providerFormat).toBe(apiFormat); expect(snapshot.providerBody).toContain('本次完整输入'); expect(snapshot.providerBody).not.toContain(f.config.apiKey);
});
it('does not reclassify a post-fetch evidence failure as a retryable network or HTTP error', async () => {
  const f = await fixture(), fetchFn = vi.fn<typeof fetch>(async () => response('', 400));
  const config = { ...f.config, transportObserver: { prepareAttempt: async () => ({ beforeDispatch: async () => undefined, dispatched: async () => { throw new Error('fixture receipt disk failure'); }, complete: async () => undefined }) } };
  await expect(generateCompanionText({ system: '合同', user: '{}' }, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'CONTEXT_RECORD_FAILED' }); expect(fetchFn).toHaveBeenCalledOnce();
});
it('recovers a durable prepared publication as unknown without issuing or permitting an automatic repeat request', async () => {
  const f = await fixture(), providerBody = '{"input":"PREPARED_PRIVATE_INPUT"}', input = { frame: frame(), providerBody, providerFormat: 'openai_chat' as const, model: 'fixture', imageFallback: false };
  f.failOnce(command => command.type === 'cognition.registry.publication.transition' && command.nextState === 'validated');
  await expect(f.snapshots.prepareAttempt(input)).rejects.toThrow('fixture durable');
  expect((await f.snapshots.list('alice')).items).toEqual([]);
  const restarted = new CompanionContextSnapshots(f.options), recovered = await restarted.recoverOwner('alice'); expect(recovered).toMatchObject({ recovered: 1, unknown: 1 });
  const list = await restarted.list('alice'), actual = await restarted.read('alice', list.items[0]!.id); expect(actual.status).toBe('unknown'); expect(actual.sentAt).toBeUndefined(); expect(actual.providerBody).toBe(providerBody);
  await expect(restarted.prepareAttempt(input)).rejects.toMatchObject({ code: 'CONTEXT_RECORD_FAILED' });
});
it('discards private pending stages on revocation even before a recent-index object was committed', async () => {
  const f = await fixture(); f.failOnce(command => command.type === 'cognition.registry.publication.prepare');
  await expect(f.snapshots.prepareAttempt({ frame: frame(), providerBody: '{"input":"UNCOMMITTED_PRIVATE_INPUT"}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false })).rejects.toThrow();
  const registry = await f.artifacts('alice'), pending = await registry.pendingPublications({ operationPrefix: 'context:', limit: 16 }); expect(pending).toHaveLength(1);
  f.epochs.set('alice', 1); await f.snapshots.redactOwner('alice'); expect((await f.snapshots.list('alice')).items).toEqual([]);
  for (const item of pending[0]!.items) await expect(readFile(path.join(f.root, 'alice', ...item.stage.split('/')))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await registry.pendingPublications({ operationPrefix: 'context:', uncleanedOnly: true, limit: 16 }))).toEqual([]);
});
it('restores the exact previous recent index while discarding an uncommitted canonical replacement on revocation', async () => {
  const f = await fixture(), first = await f.snapshots.prepareAttempt({ frame: frame(), providerBody: '{"input":"FIRST_PRIVATE_INPUT"}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false }); await first.beforeDispatch(); await first.dispatched(); await first.complete('response', 200);
  const old = (await f.snapshots.list('alice')).items[0]!;
  f.failOnce(command => command.type === 'cognition.registry.publication.transition' && command.nextState === 'file_published');
  await expect(f.snapshots.prepareAttempt({ frame: { ...frame(), invocationId: 'second_call' }, providerBody: '{"input":"SECOND_PRIVATE_INPUT"}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false })).rejects.toThrow();
  const registry = await f.artifacts('alice'), pending = await registry.pendingPublications({ operationPrefix: 'context:', limit: 16 }); expect(pending[0]?.state).toBe('file_published');
  f.epochs.set('alice', 1); await new CompanionContextSnapshots(f.options).redactOwner('alice'); expect((await f.snapshots.list('alice')).items).toEqual([]);
  await expect(readFile(path.join(f.root, 'alice', '.运行', '上下文', old.id, 'request.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  for (const item of pending[0]!.items.filter(value => value.next.kind === 'context_snapshot')) await expect(readFile(path.join(f.root, 'alice', ...item.next.relativePath.split('/')))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('retains a recorded dispatch after crash as unknown instead of converting it into an unsent or successful request', async () => {
  const f = await fixture(), attempt = await f.snapshots.prepareAttempt({ frame: frame(), providerBody: '{}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false });
  f.failOnce(command => command.type === 'cognition.registry.publication.transition' && command.nextState === 'validated'); await expect(attempt.dispatched()).rejects.toThrow();
  await new CompanionContextSnapshots(f.options).recoverOwner('alice'); const list = await f.snapshots.list('alice'); expect(list.items[0]?.status).toBe('unknown'); expect(list.items[0]?.sentAt).toBeDefined();
});
it('cancels a metadata-only interrupted prepare without reconstructing or claiming an unavailable request body', async () => {
  const f = await fixture(); f.failOnce(command => command.type === 'cognition.registry.publication.prepare');
  await expect(f.snapshots.prepareAttempt({ frame: frame(), providerBody: '{"input":"NOT_STAGED_YET"}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false })).rejects.toThrow();
  expect(await new CompanionContextSnapshots(f.options).recoverOwner('alice')).toMatchObject({ recovered: 0, cancelled: 1, unknown: 0 }); expect((await f.snapshots.list('alice')).items).toEqual([]);
});
it('keeps the exact historical identity and body after an ordinary persona revision, but removes both after formal source withdrawal', async () => {
  const f = await fixture(), registry = await f.artifacts('alice');
  const profile = (content: string, expectedRevision: number | null, operationId: string) => registry.publish({ artifactId: 'persona:current', kind: 'persona_current', producer: { kind: 'system', id: 'fixture-persona-publisher' }, relativePath: 'profile.md', expectedRevision, content, sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['identity', 'audit'], retentionClass: 'current', operationId }, async () => undefined);
  const old = await profile('EXACT_OLD_PERSONA', null, 'fixture:persona:r1'), historicalFrame = { ...frame(), identity: 'EXACT_OLD_PERSONA', profileRevision: old.contentHash, dependencyRefs: [{ artifactId: old.artifactId, contentRevision: old.contentRevision, contentHash: old.contentHash }] };
  const attempt = await f.snapshots.prepareAttempt({ frame: historicalFrame, providerBody: '{"input":"EXACT_HISTORICAL_REQUEST"}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false }); await attempt.dispatched(); await attempt.complete('response', 200);
  const id = (await f.snapshots.list('alice')).items[0]!.id; await profile('NEW_PERSONA_DOES_NOT_REWRITE_HISTORY', 1, 'fixture:persona:r2');
  expect((await f.snapshots.read('alice', id)).frame.identity).toBe('EXACT_OLD_PERSONA'); expect((await f.snapshots.read('alice', id)).providerBody).toBe('{"input":"EXACT_HISTORICAL_REQUEST"}');
  await registry.revoke('persona:current'); f.epochs.set('alice', 1); await f.snapshots.redactOwner('alice');
  await expect(readFile(path.join(f.root, 'alice', '.运行', '上下文', id, 'request.json'))).rejects.toMatchObject({ code: 'ENOENT' }); expect((await f.snapshots.list('alice')).items).toEqual([]);
});
it('revokes a tampered snapshot without deleting unknown external bytes or recreating them from SQL', async () => {
  const f = await fixture(), attempt = await f.snapshots.prepareAttempt({ frame: frame(), providerBody: '{}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false }); await attempt.complete('cancelled_before_send');
  const id = (await f.snapshots.list('alice')).items[0]!.id, target = path.join(f.root, 'alice', '.运行', '上下文', id, 'request.json'); await writeFile(target, 'EXTERNALLY_REPLACED_UNKNOWN_BYTES');
  await expect(f.snapshots.revoke('alice', id)).rejects.toThrow(/未知|非预期/u); expect(await readFile(target, 'utf8')).toBe('EXTERNALLY_REPLACED_UNKNOWN_BYTES'); await expect(f.snapshots.read('alice', id)).rejects.toThrow();
});
it('redacts only stale epochs while preserving the real current-epoch in-flight attempt and its state', async () => {
  const f = await fixture(), old = await f.snapshots.prepareAttempt({ frame: frame(), providerBody: '{"input":"STALE_PRIVATE"}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false }); await old.dispatched(); await old.complete('response', 200); const oldId = (await f.snapshots.list('alice')).items[0]!.id;
  f.epochs.set('alice', 1); const current = await f.snapshots.prepareAttempt({ frame: { ...frame(), revocationEpoch: 1, invocationId: 'current_call' }, providerBody: '{"input":"CURRENT_IN_FLIGHT"}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false }), currentId = (await f.snapshots.list('alice')).items[0]!.id;
  await current.dispatched(); await f.snapshots.redactStale('alice'); const list = await f.snapshots.list('alice'); expect(list.items).toHaveLength(1); expect(list.items[0]).toMatchObject({ id: currentId, status: 'dispatched' }); expect((await f.snapshots.read('alice', currentId)).providerBody).toContain('CURRENT_IN_FLIGHT');
  await expect(readFile(path.join(f.root, 'alice', '.运行', '上下文', oldId, 'request.json'))).rejects.toMatchObject({ code: 'ENOENT' }); await current.complete('response', 200); expect((await f.snapshots.list('alice')).items[0]?.status).toBe('response');
});
it('preserves a current-epoch pending dispatch receipt without turning it unknown while removing stale private bodies', async () => {
  const f = await fixture(), old = await f.snapshots.prepareAttempt({ frame: frame(), providerBody: '{"input":"STALE"}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false }); await old.complete('cancelled_before_send'); const oldId = (await f.snapshots.list('alice')).items[0]!.id;
  f.epochs.set('alice', 1); const current = await f.snapshots.prepareAttempt({ frame: { ...frame(), revocationEpoch: 1, invocationId: 'current' }, providerBody: '{"input":"CURRENT"}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false });
  f.failOnce(command => command.type === 'cognition.registry.publication.transition' && command.nextState === 'validated'); await expect(current.dispatched()).rejects.toThrow();
  const registry = await f.artifacts('alice'), pending = (await registry.pendingPublications({ operationPrefix: 'context:', limit: 16 }))[0]!; await f.snapshots.redactStale('alice');
  expect((await registry.publication(pending.operationId))?.state).toBe('validated'); expect((await f.snapshots.list('alice')).items[0]?.status).toBe('prepared'); await expect(readFile(path.join(f.root, 'alice', '.运行', '上下文', oldId, 'request.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('retires a dispatched pending state replacement without publishing another index or weakening the CAS fence', async () => {
  const f = await fixture(), attempt = await f.snapshots.prepareAttempt({ frame: frame(), providerBody: '{"input":"PRIVATE_IN_FLIGHT"}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false });
  const id = (await f.snapshots.list('alice')).items[0]!.id; f.failOnce(command => command.type === 'cognition.registry.publication.transition' && command.nextState === 'file_published'); await expect(attempt.dispatched()).rejects.toThrow();
  f.commands.length = 0; await f.snapshots.redactOwner('alice'); expect(f.commands.some(command => command.type === 'cognition.registry.publication.prepare')).toBe(false);
  expect((await f.snapshots.list('alice')).items).toEqual([]); for (const file of ['request.json', 'attempt.json']) await expect(readFile(path.join(f.root, 'alice', '.运行', '上下文', id, file))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('treats only an exact already-removed owner namespace as completed retirement cleanup without recreating it', async () => {
  const f = await fixture(), attempt = await f.snapshots.prepareAttempt({ frame: frame(), providerBody: '{}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false }); await attempt.complete('cancelled_before_send');
  const id = (await f.snapshots.list('alice')).items[0]!.id, ownerDirectory = path.join(f.root, 'alice'); if (path.dirname(ownerDirectory) !== f.root) throw new Error('Unsafe owner fixture removal'); await rm(ownerDirectory, { recursive: true });
  const retired = new CompanionContextSnapshots({ ...f.options, ownerDirectory: owner => path.join(f.root, owner) }); f.commands.length = 0; await retired.redactOwner('alice'); expect(f.commands).toEqual([]);
  await expect(retired.read('alice', id)).rejects.toThrow(); await expect(retired.prepareAttempt({ frame: frame(), providerBody: '{}', providerFormat: 'openai_chat', model: 'fixture', imageFallback: false })).rejects.toThrow(); await expect(readFile(ownerDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('blocks a real unknown paid attempt and permits only a new explicit host attempt identity to dispatch again', async () => {
  const f = await fixture(), fetchFn = vi.fn<typeof fetch>(async () => response()), context = (attempt: number) => ({ system: '固定处理合同', user: JSON.stringify({ purpose: 'test_call', invocation: { id: 'growth:fixed-job:' + attempt, conversationId: 'room' } }) });
  const config = (attempt: number): CompanionModelConfig => ({ ...f.config, resolveAssetContext: async current => ({ ...current, frame: { ...frame('alice', current.user), invocationId: 'growth:fixed-job:' + attempt } }) });
  const firstConfig = config(1), firstObserver = { prepareAttempt: async (input: Parameters<CompanionContextSnapshots['prepareAttempt']>[0]) => { const attempt = await f.snapshots.prepareAttempt(input); return { ...attempt, dispatched: async () => { await attempt.dispatched(); throw new Error('CRASH_AFTER_REAL_DISPATCH_RECEIPT'); } }; } };
  await expect(generateCompanionText(context(1), { ...firstConfig, transportObserver: firstObserver }, undefined, { fetchFn })).rejects.toMatchObject({ code: 'CONTEXT_RECORD_FAILED' }); expect(fetchFn).toHaveBeenCalledTimes(1);
  await new CompanionContextSnapshots(f.options).recoverOwner('alice'); const old = (await f.snapshots.list('alice')).items[0]!; expect(old.status).toBe('unknown');
  await expect(generateCompanionText(context(1), config(1), undefined, { fetchFn })).rejects.toMatchObject({ code: 'CONTEXT_RECORD_FAILED' }); expect(fetchFn).toHaveBeenCalledTimes(1);
  await expect(generateCompanionText(context(2), config(2), undefined, { fetchFn })).resolves.toBe('完成'); expect(fetchFn).toHaveBeenCalledTimes(2);
  const list = await f.snapshots.list('alice'); expect(list.items.find(item => item.id === old.id)?.status).toBe('unknown'); expect(list.items[0]).toMatchObject({ status: 'response', invocationId: 'growth:fixed-job:2' });
});
it('finishes an intentionally privacy-discarded response without rewriting the revoked snapshot or reporting a receipt disk failure', async () => {
  const f = await fixture(); let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; }), fetchFn = vi.fn<typeof fetch>(async () => pending);
  const generating = generateCompanionText({ system: '固定合同', user: '{}' }, f.config, undefined, { fetchFn });
  await vi.waitFor(async () => expect((await f.snapshots.list('alice')).items[0]?.status).toBe('dispatched')); const id = (await f.snapshots.list('alice')).items[0]!.id;
  f.epochs.set('alice', 1); await f.snapshots.redactStale('alice'); f.commands.length = 0; resolve(response('响应已到达，业务来源门仍需丢弃旧结果。'));
  await expect(generating).resolves.toBe('响应已到达，业务来源门仍需丢弃旧结果。'); expect(f.commands.some(command => command.type === 'cognition.registry.publication.prepare')).toBe(false); expect((await f.snapshots.list('alice')).items).toEqual([]);
  await expect(readFile(path.join(f.root, 'alice', '.运行', '上下文', id, 'request.json'))).rejects.toMatchObject({ code: 'ENOENT' }); expect(fetchFn).toHaveBeenCalledOnce();
});
it('settles cancellation after formal privacy discard without resurrecting the old attempt or retrying its network request', async () => {
  const f = await fixture(), controller = new AbortController(); let reject!: (cause: unknown) => void; const pending = new Promise<Response>((_, fail) => { reject = fail; }), fetchFn = vi.fn<typeof fetch>(async () => pending);
  const generating = generateCompanionText({ system: '固定合同', user: '{}' }, f.config, controller.signal, { fetchFn });
  await vi.waitFor(async () => expect((await f.snapshots.list('alice')).items[0]?.status).toBe('dispatched')); f.epochs.set('alice', 1); await f.snapshots.redactStale('alice'); f.commands.length = 0;
  controller.abort(); reject(new DOMException('Cancelled after privacy withdrawal', 'AbortError')); await expect(generating).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(f.commands.some(command => command.type === 'cognition.registry.publication.prepare')).toBe(false); expect((await f.snapshots.list('alice')).items).toEqual([]); expect(fetchFn).toHaveBeenCalledOnce();
});
it('still rejects an unknown external body edit as a nonretryable receipt failure when no formal privacy withdrawal occurred', async () => {
  const f = await fixture(); let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; }), fetchFn = vi.fn<typeof fetch>(async () => pending);
  const generating = generateCompanionText({ system: '固定合同', user: '{}' }, f.config, undefined, { fetchFn });
  await vi.waitFor(async () => expect((await f.snapshots.list('alice')).items[0]?.status).toBe('dispatched')); const id = (await f.snapshots.list('alice')).items[0]!.id;
  await writeFile(path.join(f.root, 'alice', '.运行', '上下文', id, 'request.json'), 'UNREGISTERED_EXTERNAL_BYTES'); resolve(response());
  await expect(generating).rejects.toMatchObject({ code: 'CONTEXT_RECORD_FAILED' }); expect(fetchFn).toHaveBeenCalledOnce();
});
