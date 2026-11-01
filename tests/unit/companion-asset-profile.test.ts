import { access, link, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionAssetProfileStore, renderCompanionAssetProfile } from '../../src/main/companions/asset-profile';
import { CompanionArtifactRegistry } from '../../src/main/companions/artifact-registry';
import { assembleCompanionAssetContext } from '../../src/main/companions/asset-context';
import type { Companion } from '../../src/shared/companions';
import { registryStorageFixture } from '../fixtures/companion-registry-storage';
import ts from 'typescript';
import { companionLearningGoalResponseSchemas } from '../../src/main/companions/learning-goal-response';

const roots: string[] = [], databases: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-asset-profile-')) throw Error('Unexpected cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
const owner: Companion = { id: 'alice', name: 'Alice', description: '创建简介', persona: '任意创建人格，只是起点。',
  model: '', avatar: 'sister', builtin: true, proactive: false, active: true, createdAt: '2026-10-26T10:00:00Z' };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-asset-profile-')); roots.push(root);
  const library = path.join(root, '伙伴资产'), database = registryStorageFixture(root); databases.push(database);
  const profiles = new CompanionAssetProfileStore(library, { registryStorage: database.storage });
  return { root, library, database, profiles, initial: await profiles.bootstrap(owner) };
}

it('loads every current template outside the initialized owner mutation queue without marking or bootstrapping again', async () => {
  const f = await fixture(), initialized = vi.fn(async () => true), markInitialized = vi.fn(async () => undefined);
  const profiles = new CompanionAssetProfileStore(f.library, { registryStorage: f.database.storage, initialized, markInitialized });
  const bootstrap = vi.spyOn(profiles, 'bootstrap');
  const serialized = Reflect.get(profiles, 'serialized') as <T>(id: string, operation: () => Promise<T>) => Promise<T>;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  const mutation = serialized.call(profiles, owner.id, async () => { enter(); await barrier; });
  try {
    await entered;
    const current = await profiles.loadOrBootstrap(owner);
    expect(current).toEqual(f.initial); expect(current.nativeFocusTemplate).toBe(f.initial.nativeFocusTemplate);
    expect(current.nativeTimelineTemplate).toBe(f.initial.nativeTimelineTemplate); expect(current.nativeSummaryTemplate).toBe(f.initial.nativeSummaryTemplate);
    expect(bootstrap).not.toHaveBeenCalled(); expect(markInitialized).not.toHaveBeenCalled(); expect(initialized).toHaveBeenCalledOnce();
  } finally { release(); await mutation; }
});

it('uses the real initialization flag on each full read and never rebuilds initialized corrupt or unavailable assets', async () => {
  const f = await fixture(); let ready = false;
  const profiles = new CompanionAssetProfileStore(f.library, { registryStorage: f.database.storage, initialized: async () => ready });
  const bootstrap = vi.spyOn(profiles, 'bootstrap');
  expect((await profiles.loadOrBootstrap(owner)).revision).toBe(f.initial.revision); expect(bootstrap).toHaveBeenCalledOnce();
  ready = true; bootstrap.mockClear();
  await writeFile(path.join(f.initial.root, f.initial.modules[0]!.path), 'external bytes');
  await expect(profiles.loadOrBootstrap(owner)).rejects.toBeInstanceOf(Error); expect(bootstrap).not.toHaveBeenCalled();
  const unavailable = Object.assign(new Error('temporarily unavailable'), { code: 'EXECUTION_VALIDATION_UNAVAILABLE', notDispatched: true });
  const unavailableProfiles = new CompanionAssetProfileStore(f.library, { registryStorage: f.database.storage, initialized: async () => { throw unavailable; } });
  const rebuild = vi.spyOn(unavailableProfiles, 'bootstrap');
  await expect(unavailableProfiles.loadOrBootstrap(owner)).rejects.toBe(unavailable); expect(rebuild).not.toHaveBeenCalled();
});

it('seals the authored creation profile once with a stable creation payload and empty typed memory directories', async () => {
  const f = await fixture(), registry = await f.profiles.artifacts(owner.id);
  expect((await f.profiles.readInstance(owner.id)).createdAt).toBe(owner.createdAt);
  expect((await registry.read({ artifactId: 'origin:creation', consumer: 'audit' })).text).toBe(renderCompanionAssetProfile(owner.id, f.initial.profile));
  const restart = new CompanionAssetProfileStore(f.library, { registryStorage: f.database.storage });
  expect((await restart.bootstrap({ ...owner, persona: '旧数据库不能重新设定角色。' })).profile.persona).toBe(owner.persona);
  expect(await readdir(path.join(f.initial.root, '记忆', '经历'))).toEqual([]);
  expect(await readdir(path.join(f.initial.root, '记忆', '自我认识'))).toEqual([]);
  expect((await registry.list('episode_recall'))).toEqual([]);
});

it('rejects all direct post-creation profile and prompt writes without modifying canonical bytes', async () => {
  const f = await fixture(), before = await readFile(path.join(f.initial.root, 'profile.md'), 'utf8');
  await expect(f.profiles.writeProfile({ companionId: owner.id, expectedRevision: f.initial.profileRevision,
    profile: { name: '手改名字', description: '', persona: '手改人格' } })).rejects.toMatchObject({ code: 'READ_ONLY' });
  await expect(f.profiles.writePrompt({ companionId: owner.id, expectedRevision: f.initial.promptRevision,
    relativePath: f.initial.modules[0]!.path, content: '手改规则' })).rejects.toMatchObject({ code: 'READ_ONLY' });
  expect(await readFile(path.join(f.initial.root, 'profile.md'), 'utf8')).toBe(before);
});

it('preserves current SQL runtime configuration while hydrating only canonical identity fields', async () => {
  const f = await fixture();
  const runtime: Companion = { ...owner, name: '旧名字', description: '旧简介', persona: '旧人格', avatar: 'sister', proactive: true,
    inputMode: 'queue', avatarAttachmentId: 'current_avatar', appearanceAttachmentId: 'current_appearance' };
  expect(await f.profiles.hydrate(runtime)).toMatchObject({ name: owner.name, description: owner.description, persona: owner.persona,
    assetProfileRevision: f.initial.profileRevision, avatar: 'sister', proactive: true, inputMode: 'queue',
    avatarAttachmentId: 'current_avatar', appearanceAttachmentId: 'current_appearance' });
  expect((await f.profiles.load(owner.id)).profileRevision).toBe(f.initial.profileRevision);
});

it('batches strict profile and prompt metadata while reopening every file at each separate admission', async () => {
  const f = await fixture(); f.database.commands.length = 0;
  const read = vi.spyOn(f.profiles as unknown as { read(root: string, file: string, max?: number): Promise<{ text: string; hash: string; stamp: string }> }, 'read');
  const bytes = vi.spyOn(CompanionArtifactRegistry.prototype as unknown as { bytes(relative: string, admitted?: (stamp: string) => void): Promise<Buffer> }, 'bytes');
  const first = await f.profiles.load(owner.id), files = Object.keys(first.fileRevisions);
  expect(read).not.toHaveBeenCalled();
  for (const file of files) expect(bytes.mock.calls.filter(([relative]) => relative === file)).toHaveLength(2);
  expect(first.modules.length).toBeGreaterThan(15);
  const commands = f.database.commands.filter(command => command.type === 'cognition.registry.read');
  expect(commands.filter(command => command.relativePaths)).toHaveLength(2);
  expect(commands.some(command => command.relativePath)).toBe(false);
  expect(commands.length).toBeLessThanOrEqual(12);
  const final = f.database.commands.at(-1)!;
  expect(final.type).toBe('cognition.registry.refs.validate');
  if (final.type === 'cognition.registry.refs.validate') expect(final.references.length).toBeGreaterThan(first.modules.length);
  expect((await f.profiles.load(owner.id)).revision).toBe(first.revision);
  expect(read).not.toHaveBeenCalled();
  for (const file of files) expect(bytes.mock.calls.filter(([relative]) => relative === file)).toHaveLength(4);
  f.database.commands.length = 0;
  await f.profiles.loadProfile(owner.id);
  const profileReads = f.database.commands.filter(command => command.type === 'cognition.registry.read');
  expect(profileReads.filter(command => command.relativePaths)).toMatchObject([{ relativePaths: ['.伙伴配置.json', 'profile.md', 'instance.json'] }]);
  expect(profileReads.length).toBeLessThanOrEqual(10);
  read.mockRestore(); bytes.mockRestore();
});

it.each(['load', 'loadProfile'] as const)('skips unrelated retraction inventory on normal %s reads while still rejecting changed canonical bytes', async method => {
  const f = await fixture(); f.database.commands.length = 0;
  const inventory = vi.spyOn(CompanionArtifactRegistry.prototype, 'retractionMetadata');
  try {
    expect((await f.profiles[method](owner.id)).profile.persona).toBe(owner.persona);
    expect(inventory).not.toHaveBeenCalled();
    expect(f.database.commands.some(command => command.type === 'cognition.registry.publication.pending'
      && command.artifactId === 'persona:current' && command.previousTarget)).toBe(true);
    expect(f.database.commands.some(command => command.type === 'cognition.registry.page' && command.kind === 'role_guidance')).toBe(false);
    await writeFile(path.join(f.initial.root, 'profile.md'), 'UNKNOWN_EXTERNAL_IDENTITY');
    await expect(f.profiles[method](owner.id)).rejects.toMatchObject({ code: 'CHANGED' });
    expect(inventory).not.toHaveBeenCalled();
  } finally { inventory.mockRestore(); }
});

it('lets two initialized strict profile readers overlap without taking the owner mutation lane', async () => {
  const f = await fixture(), profiles = new CompanionAssetProfileStore(f.library, { registryStorage: f.database.storage, initialized: async () => true });
  const target = profiles as unknown as { registeredRead(root: string, file: string, current: Awaited<ReturnType<CompanionArtifactRegistry['read']>>, max?: number): Promise<{ text: string; hash: string; stamp: string }> };
  const original = target.registeredRead.bind(profiles);
  let entered = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const read = vi.spyOn(target, 'registeredRead').mockImplementation(async (root, file, current, max) => {
    if (file === 'profile.md') { entered++; await barrier; }
    return original(root, file, current, max);
  });
  const readers = [profiles.bootstrapProfile(owner), profiles.bootstrapProfile(owner)];
  try {
    try { await vi.waitFor(() => expect(entered).toBe(2), { timeout: 2000 }); }
    finally { release(); }
    const snapshots = await Promise.all(readers);
    expect(snapshots.map(snapshot => snapshot.profileRevision)).toEqual([f.initial.profileRevision, f.initial.profileRevision]);
    expect(snapshots.every(snapshot => snapshot.profile.persona === owner.persona)).toBe(true);
  } finally { release(); await Promise.allSettled(readers); read.mockRestore(); }
});

it('repairs a revoked interrupted persona publication even when the last committed identity itself remains committed', async () => {
  const f = await fixture(), registry = await f.profiles.artifacts(owner.id), previous = (await registry.get('persona:current'))!;
  const evidence = await registry.publish({ artifactId: 'source:interrupted:r1', kind: 'source_evidence', relativePath: '证据/来源/interrupted.md',
    producer: { kind: 'host', id: 'fixture' }, content: 'PRIVATE_PENDING_FORMATION', expectedRevision: null, sourceRefs: [], dependencyRefs: [],
    visibility: { scope: 'owner' }, allowedConsumers: ['source_verification', 'audit'], retentionClass: 'evidence', operationId: 'source:interrupted' });
  const original = f.database.storage.request.bind(f.database.storage);
  const failure = vi.spyOn(f.database.storage, 'request').mockImplementation(async command => {
    if (command.type === 'cognition.registry.publication.commit' && command.operationId === 'persona:interrupted') throw new Error('fixture crash before metadata commit');
    return original(command);
  });
  try {
    await expect(registry.publish({ artifactId: previous.artifactId, kind: previous.kind, relativePath: previous.relativePath,
      producer: { kind: 'system', id: 'fixture' }, content: 'UNCOMMITTED_PRIVATE_PERSONA', expectedRevision: previous.contentRevision,
      sourceRefs: [{ artifactId: evidence.artifactId, contentRevision: evidence.contentRevision, contentHash: evidence.contentHash }], dependencyRefs: [],
      visibility: previous.visibility, allowedConsumers: previous.allowedConsumers, retentionClass: previous.retentionClass,
      operationId: 'persona:interrupted' }, async () => undefined)).rejects.toThrow('fixture crash');
  } finally { failure.mockRestore(); }
  expect((await registry.publication('persona:interrupted'))?.state).toBe('file_published');
  await registry.revoke(evidence.artifactId);
  expect((await registry.get('persona:current', true))?.publicationState).toBe('committed');
  expect(await registry.hasInterruptedPersonaRetraction()).toBe(true);
  const inventory = vi.spyOn(CompanionArtifactRegistry.prototype, 'retractionMetadata');
  try {
    const actual = await f.profiles.loadProfile(owner.id);
    expect(inventory).toHaveBeenCalled(); expect(actual.profile.persona).toBe(owner.persona);
    expect(actual.profile.persona).not.toContain('UNCOMMITTED_PRIVATE_PERSONA');
    expect((await registry.get('persona:current'))?.contentRevision).toBe(previous.contentRevision + 1);
    expect(await registry.hasInterruptedPersonaRetraction()).toBe(false);
  } finally { inventory.mockRestore(); }
});

it('does not repair a newer current identity when its exact revision changes between the repair probe and inventory', async () => {
  const f = await fixture(), registry = await f.profiles.artifacts(owner.id);
  await registry.revoke('persona:current');
  const observed = (await registry.get('persona:current', true))!, original = registry.retractionMetadata.bind(registry);
  const other = new CompanionAssetProfileStore(f.library, { registryStorage: f.database.storage });
  const resolve = vi.spyOn(f.profiles, 'artifacts').mockResolvedValue(registry);
  const inventory = vi.spyOn(registry, 'retractionMetadata').mockImplementationOnce(async () => {
    expect(await other.repairRevokedPersona(owner.id)).toBe(true); return original();
  });
  try {
    // load/loadProfile call this internal probe without holding the mutation
    // serial lane, so a real independently admitted repair can win the race.
    const reader = f.profiles as unknown as { repairRevokedPersonaInternal(id: string): Promise<boolean> };
    await expect(reader.repairRevokedPersonaInternal(owner.id)).rejects.toMatchObject({ code: 'CHANGED' });
    const current = (await registry.get('persona:current', true))!;
    expect(current.contentRevision).toBe(observed.contentRevision + 1); expect(current.publicationState).toBe('committed');
    expect((await other.loadProfile(owner.id)).profile.persona).toBe(owner.persona);
  } finally { inventory.mockRestore(); resolve.mockRestore(); }
});

it('rechecks the full selected artifact union after strict reads so a withdrawn module cannot escape a completed path batch', async () => {
  const f = await fixture(), registry = await f.profiles.artifacts(owner.id);
  const target = f.initial.modules.find(module => module.path.startsWith('提示词/处理职能/'))!, artifact = (await registry.findByPath(target.path))!;
  const targetReader = f.profiles as unknown as { registeredRead(root: string, file: string, current: Awaited<ReturnType<CompanionArtifactRegistry['read']>>, max?: number): Promise<{ text: string; hash: string; stamp: string }> };
  const original = targetReader.registeredRead.bind(f.profiles); let revoked = false;
  const read = vi.spyOn(targetReader, 'registeredRead').mockImplementation(async (root, file, current, max) => {
    const value = await original(root, file, current, max);
    if (file === target.path && !revoked) { revoked = true; await registry.revoke(artifact.artifactId); }
    return value;
  });
  try { await expect(f.profiles.load(owner.id)).rejects.toBeDefined(); expect(revoked).toBe(true); }
  finally { read.mockRestore(); }
});

it('admits a new registered role publication on the next strict snapshot without mutating the earlier identity or guidance', async () => {
  const f = await fixture(), registry = await f.profiles.artifacts(owner.id);
  const before = await f.profiles.load(owner.id), module = before.modules.find(value => value.purposes.includes('companion_reply'))!;
  const artifact = (await registry.findByPath(module.path))!, content = module.content + '\n本次正式发布的角色指导：先明确真实依据，再保留独立判断。\n';
  const context = { system: '实际宿主合同', user: JSON.stringify({ purpose: 'companion_reply', invocation: { conversationId: 'room' } }) };
  const originalFrame = assembleCompanionAssetContext(context, before, 'reply');
  await registry.publish({ artifactId: artifact.artifactId, kind: artifact.kind, relativePath: artifact.relativePath,
    producer: { kind: 'system', id: 'fixture:role-publication' }, expectedRevision: artifact.contentRevision, content,
    sourceRefs: artifact.sourceRefs, dependencyRefs: artifact.dependencyRefs, visibility: artifact.visibility,
    allowedConsumers: artifact.allowedConsumers, retentionClass: artifact.retentionClass, operationId: 'fixture:role:r2' }, async () => undefined);
  const after = await f.profiles.load(owner.id), nextFrame = assembleCompanionAssetContext(context, after, 'reply');
  expect(after.profileRevision).toBe(before.profileRevision);
  expect(after.profile.persona).toBe(before.profile.persona);
  expect(after.personaFragments).toEqual(before.personaFragments);
  expect(after.promptRevision).not.toBe(before.promptRevision);
  expect(nextFrame.frame.roleGuidance).toContain('本次正式发布的角色指导');
  expect(nextFrame.frame.identity).toBe(originalFrame.frame.identity);
  expect(assembleCompanionAssetContext(context, before, 'reply')).toEqual(originalFrame);
  expect(before.prompts.companion_reply).not.toContain('本次正式发布的角色指导');
});

it('rejects a newly withdrawn role during the next strict admission while keeping the independent current profile available', async () => {
  const f = await fixture(), before = await f.profiles.load(owner.id), registry = await f.profiles.artifacts(owner.id);
  const module = before.modules.find(value => value.purposes.includes('companion_reply'))!, artifact = (await registry.findByPath(module.path))!;
  await registry.revoke(artifact.artifactId);
  await expect(f.profiles.load(owner.id)).rejects.toBeDefined();
  const identity = await f.profiles.loadProfile(owner.id);
  expect(identity.profileRevision).toBe(before.profileRevision);
  expect(identity.profile.persona).toBe(before.profile.persona);
  expect(before.modules.find(value => value.path === module.path)?.content).toBe(module.content);
});

it('fails closed for edited or missing current files and cannot reseed a deleted initialized namespace', async () => {
  const f = await fixture(), file = path.join(f.initial.root, 'profile.md');
  await writeFile(file, renderCompanionAssetProfile(owner.id, { ...f.initial.profile, persona: 'UNREGISTERED_EXTERNAL_PERSONA' }));
  await expect(f.profiles.loadProfile(owner.id)).rejects.toMatchObject({ code: 'CHANGED' });
  await writeFile(file, renderCompanionAssetProfile(owner.id, f.initial.profile)); await unlink(file);
  await expect(f.profiles.bootstrap(owner)).rejects.toBeDefined(); await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  const directory = path.resolve(f.initial.root);
  if (path.dirname(directory) !== path.resolve(f.library)) throw new Error('Unexpected fixture owner path.');
  await rm(directory, { recursive: true });
  const restart = new CompanionAssetProfileStore(f.library, { registryStorage: f.database.storage, initialized: async () => true });
  await expect(restart.bootstrap(owner)).rejects.toBeDefined(); await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('copies native templates only at creation, registers every module purpose, and refuses unregistered model purposes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-asset-profile-')); roots.push(root);
  const database = registryStorageFixture(root); databases.push(database);
  const focus = vi.fn(async () => 'EXACT_NATIVE_FOCUS_TEMPLATE'), tags = vi.fn(async () => 'EXACT_NATIVE_TAG_TEMPLATE');
  const profiles = new CompanionAssetProfileStore(path.join(root, 'assets'), { registryStorage: database.storage,
    loadInitialFocusPrompt: focus, loadInitialTagPrompt: tags,
    loadInitialTimelinePrompts: async () => ({ timeline: 'EXACT_NATIVE_TIMELINE', summary: 'EXACT_NATIVE_SUMMARY' }) });
  const initial = await profiles.bootstrap(owner);
  for (let iteration = 0; iteration < 3; iteration++) {
    const loaded = await profiles.load(owner.id);
    expect(loaded.nativeFocusTemplate).toBe('EXACT_NATIVE_FOCUS_TEMPLATE\n'); expect(loaded.tagMasterTemplate).toBe('EXACT_NATIVE_TAG_TEMPLATE\n');
    expect(loaded.modules.every(module => module.purposes.length > 0)).toBe(true);
    expect(loaded.modules.map(module => module.path)).toEqual(initial.modules.map(module => module.path));
  }
  expect(focus).toHaveBeenCalledTimes(1); expect(tags).toHaveBeenCalledTimes(1);
  expect(() => assembleCompanionAssetContext({ system: '', user: JSON.stringify({ purpose: 'UNREGISTERED_PURPOSE' }) }, initial, 'structured')).toThrow('未显式登记');
  const assembled = assembleCompanionAssetContext({ system: '本轮职责', user: JSON.stringify({ purpose: 'companion_reply', conversationId: 'private_alice' }) }, initial, 'reply');
  expect(assembled.system).toContain(owner.persona); expect(JSON.stringify(assembled.frame)).toContain(initial.profileRevision);
  const repairModules = initial.modules.filter(module => module.purposes.includes('companion_structured_repair'));
  expect(repairModules).toHaveLength(2); expect(repairModules.every(module => module.path.startsWith('提示词/处理职能/'))).toBe(true);
  expect(assembleCompanionAssetContext({ system: '本次修复合同', user: JSON.stringify({ purpose: 'companion_structured_repair' }) }, initial, 'structured').system).toContain('不新增原材料没有的事实');
});

it('rejects linked canonical files and unauthorized owner identifiers before reading any content', async () => {
  const f = await fixture(), canonical = path.join(f.initial.root, 'profile.md'), linked = path.join(f.root, 'unregistered-copy.md');
  await link(canonical, linked);
  await expect(f.profiles.load(owner.id)).rejects.toMatchObject({ code: 'UNSAFE' });
  await unlink(linked);
  await expect(f.profiles.load('../bob')).rejects.toBeDefined();
  expect((await f.profiles.load(owner.id)).profileRevision).toBe(f.initial.profileRevision);
});

it('registers every literal production model purpose and all declared continuous-learning stages', async () => {
  const f = await fixture(), directory = path.resolve('src/main/companions'), purposes = new Map<string, string>();
  const learning = Object.keys(companionLearningGoalResponseSchemas); expect(learning.length).toBeGreaterThan(0);
  for (const filename of await readdir(directory)) {
    if (!filename.endsWith('.ts')) continue;
    const source = ts.createSourceFile(filename, await readFile(path.join(directory, filename), 'utf8'), ts.ScriptTarget.Latest, true);
    const record = (value: string) => {
      if (value === 'index' || value === 'prepare') return; // Native embedding maintenance, not model consumers.
      if (value === 'companion_learning_') for (const stage of learning) purposes.set(value + stage, filename);
      else purposes.set(value, filename);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText(source).replaceAll("'", '').replaceAll('"', '') === 'purpose') {
        const literals = (value: ts.Node): void => { if (ts.isStringLiteral(value)) record(value.text); ts.forEachChild(value, literals); };
        literals(node.initializer);
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'companionBehaviorSystem'
        && node.arguments[1] && ts.isStringLiteral(node.arguments[1])) record(node.arguments[1].text);
      ts.forEachChild(node, visit);
    }; visit(source);
  }
  for (const [purpose, file] of purposes) expect(f.initial.prompts[purpose], `${file}: ${purpose} must have an explicit declared consumer`).toBeDefined();
});
