import { mkdtemp, readFile, writeFile, rm, unlink, mkdir, link, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionAssetProfileStore, renderCompanionAssetProfile } from '../../src/main/companions/asset-profile';
import type { Companion } from '../../src/shared/companions';
import { COMPANION_MEMORY_POLICY_FILE, initialCompanionMemoryPolicy } from '../../src/shared/companion-memory-policy';
import { assembleCompanionAssetContext } from '../../src/main/companions/asset-context';
import { generateCompanionStructured, generateCompanionText } from '../../src/main/companions/model';
import { companionModelConnection, companionModelQuota } from '../../src/main/companions/model-quota';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-asset-profile-')) throw Error('Unexpected cleanup');
  await rm(root, { recursive: true, force: true });
} });
const owner: Companion = { id: 'alice', name: 'Alice', description: '初始简介', persona: '初始人格，只用于首次初始化。',
  model: '', avatar: 'sister', builtin: true, proactive: false, active: true, createdAt: '2026-10-26T10:00:00Z' };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-asset-profile-')); roots.push(root);
  const library = path.join(root, '伙伴记忆'), profiles = new CompanionAssetProfileStore(library);
  return { root, library, profiles, initial: await profiles.bootstrap(owner) };
}

it('allows explicit reset initialization after a durable owner was removed without weakening normal missing-file guards', async () => {
  const f = await fixture(), initialized = new Set([owner.id]);
  const store = new CompanionAssetProfileStore(f.library, { initialized: async id => initialized.has(id) });
  const directory = path.resolve(f.initial.root);
  if (path.dirname(directory) !== path.resolve(f.library)) throw new Error('Unexpected fixture owner path.');
  await rm(directory, { recursive: true });
  await expect(store.bootstrap(owner)).rejects.toMatchObject({ code: 'MISSING' });
  const fresh = await store.initializeAfterReset({ ...owner, persona: '明确重置后的初始人格。' });
  expect(fresh.profile.persona).toBe('明确重置后的初始人格。'); expect(fresh.memoryPolicy).toBeDefined();
  await unlink(path.join(directory, 'profile.md'));
  await expect(store.bootstrap(owner)).rejects.toMatchObject({ code: 'MISSING' });
});

it('initializes a previous exported role from its actual file, preserves the source and leaves diary documents untouched', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-asset-profile-')); roots.push(root);
  const library = path.join(root, '伙伴记忆'), directory = path.join(library, owner.id);
  await mkdir(path.join(directory, '日记'), { recursive: true });
  const source = `# 文件中的名字\n\n伙伴标识：${owner.id}\n\n## 稳定人格\n\n用户修改的人格。\n包含独立段落，不采用过时数据库或新内置模板。\n\n此文件供查阅；日记、学习资料和自我认识不会自动改写稳定人格。请在伙伴资料管理中修改人格。\n`;
  await writeFile(path.join(directory, 'profile.md'), source);
  await writeFile(path.join(directory, '日记', 'existing.md'), '已有日记保持原样。');
  const initialized = new Set<string>(), options = { initialized: async (id: string) => initialized.has(id), markInitialized: async (id: string) => { initialized.add(id); } };
  const profiles = new CompanionAssetProfileStore(library, options), current = await profiles.bootstrap(owner);
  expect(current.profile).toMatchObject({ name: '文件中的名字', persona: '用户修改的人格。\n包含独立段落，不采用过时数据库或新内置模板。', avatar: owner.avatar });
  expect(current.modules.length).toBeGreaterThan(10); expect(current.memoryPolicy).toBeDefined();
  expect(await readFile(path.join(directory, 'profile.initialization-source.md'), 'utf8')).toBe(source);
  expect(await readFile(path.join(directory, '日记', 'existing.md'), 'utf8')).toBe('已有日记保持原样。');
  expect((await profiles.bootstrap({ ...owner, persona: '升级后的种子' })).profile).toEqual(current.profile);
  await unlink(path.join(directory, '.伙伴配置.json'));
  await expect(new CompanionAssetProfileStore(library, options).bootstrap(owner)).rejects.toMatchObject({ code: 'MISSING' });
});

it('refuses a previous role export belonging to another owner without writing initialization files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-asset-profile-')); roots.push(root);
  const library = path.join(root, '伙伴记忆'), directory = path.join(library, owner.id); await mkdir(directory, { recursive: true });
  const source = '# Bob\n\n伙伴标识：bob\n\n## 稳定人格\n\n其他伙伴的人格。\n\n此文件供查阅；日记、学习资料和自我认识不会自动改写稳定人格。请在伙伴资料管理中修改人格。\n';
  await writeFile(path.join(directory, 'profile.md'), source);
  await expect(new CompanionAssetProfileStore(library).bootstrap(owner)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await readFile(path.join(directory, 'profile.md'), 'utf8')).toBe(source);
  await expect(access(path.join(directory, '提示词'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('initializes owner-local assets once, then hydrates live files without overwriting authored profile or prompt edits', async () => {
  const f = await fixture(), profileFile = path.join(f.initial.root, 'profile.md');
  expect(f.initial.profile.persona).toBe(owner.persona);
  expect(f.initial.prompts.companion_reply).toContain('摘要没有提到某事，不证明全库不存在');
  expect(f.initial.prompts.vcp_experience_journal).toContain('原文引用只证明来源，不等于其中事实已经在正文表达');
  const edited = { ...f.initial.profile, name: '海岚', description: '外部文件中的当前简介', persona: '我现在的完整设定来自这个文件。' };
  await writeFile(profileFile, renderCompanionAssetProfile(owner.id, edited), 'utf8');
  await writeFile(path.join(f.initial.root, '提示词', '对话.md'), '按此文件中的新交流习惯回应。', 'utf8');
  const current = await f.profiles.bootstrap({ ...owner, name: '过时数据库名', persona: '不能覆盖人工文件的旧数据库内容' });
  expect(current.profile).toEqual(edited); expect(current.profileRevision).not.toBe(f.initial.profileRevision);
  expect(current.prompts.chat).toContain('新交流习惯'); expect(current.promptRevision).not.toBe(f.initial.promptRevision);
  expect(await f.profiles.hydrate(owner)).toMatchObject({ name: edited.name, description: edited.description, persona: edited.persona,
    assetProfileRevision: current.profileRevision, avatar: owner.avatar });
  expect(await readFile(profileFile, 'utf8')).toBe(renderCompanionAssetProfile(owner.id, edited));
});

it('initializes editable focus guidance and reads its actual current file for every provider admission', async () => {
  const f = await fixture(), module = f.initial.modules.find(item => item.purposes.includes('vcp_focus_guidance'))!;
  expect(module.path).toBe('提示词/记忆聚焦指导.md');
  expect(module.content).toContain('当前明确换话题');
  const file = path.join(f.initial.root, ...module.path.split('/'));
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'focused result' } }] })));
  const native = { system: '', user: 'PREPARED_NATIVE_TEMPLATE_WITH_FIXED_SOURCES' };
  const config = { apiFormat: 'openai_chat' as const, model: 'fixture-model', apiKey: 'fixture', baseUrl: 'https://provider.invalid', ownerId: owner.id,
    resolveAssetContext: async (context: typeof native, kind: 'reply' | 'structured' | 'text') => assembleCompanionAssetContext(context, await f.profiles.load(owner.id), kind) };
  await writeFile(file, 'OWNER_FILE_FOCUS_V1', 'utf8');
  await generateCompanionText(native, config, undefined, { fetchFn });
  await writeFile(file, 'OWNER_FILE_FOCUS_V2', 'utf8');
  await generateCompanionText(native, config, undefined, { fetchFn });
  const wires = fetchFn.mock.calls.map(call => JSON.parse(String(call[1]?.body)) as { messages: Array<{ role: string; content: string }> });
  expect(wires[0]!.messages[0]!.content).toContain('OWNER_FILE_FOCUS_V1');
  expect(wires[1]!.messages[0]!.content).toContain('OWNER_FILE_FOCUS_V2');
  expect(wires[1]!.messages[0]!.content).not.toContain('OWNER_FILE_FOCUS_V1');
  expect(wires.every(wire => wire.messages.at(-1)!.content === native.user)).toBe(true);
  expect(wires.every(wire => !wire.messages[0]!.content.includes('当前明确换话题'))).toBe(true);
  await unlink(file);
  await expect(generateCompanionText(native, config, undefined, { fetchFn })).rejects.toThrow();
  expect(fetchFn).toHaveBeenCalledTimes(2);
  await expect(f.profiles.bootstrap(owner)).rejects.toMatchObject({ code: 'MISSING' });
  await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('honors an authored manifest default for focus without adding an undeclared initialization module', async () => {
  const f = await fixture(), manifestFile = path.join(f.initial.root, '提示词', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { purposes: Record<string, string[]> };
  delete manifest.purposes.vcp_focus_guidance;
  await writeFile(manifestFile, JSON.stringify(manifest), 'utf8');
  await writeFile(path.join(f.initial.root, '提示词', '默认.md'), 'AUTHORED_OWNER_DEFAULT_FOR_UNMAPPED_PURPOSES', 'utf8');
  const guide = path.join(f.initial.root, '提示词', '记忆聚焦指导.md'); await unlink(guide);
  const current = await f.profiles.bootstrap(owner);
  const assembled = assembleCompanionAssetContext({ system: '', user: 'immutable prepared input' }, current, 'text');
  expect(assembled.system).toContain('AUTHORED_OWNER_DEFAULT_FOR_UNMAPPED_PURPOSES');
  expect(assembled.system).not.toContain('当前明确换话题');
  expect(assembled.user).toBe('immutable prepared input');
  await expect(access(guide)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(manifestFile, 'utf8'))).toEqual(manifest);
});

it('reads a queued native focus guidance edit after its connection slot is granted', async () => {
  const f = await fixture(), file = path.join(f.initial.root, '提示词', '记忆聚焦指导.md');
  await writeFile(file, 'BEFORE_QUEUE_GUIDANCE', 'utf8');
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'focused result' } }] })));
  const config = { apiFormat: 'openai_chat' as const, model: randomUUID(), apiKey: 'fixture', baseUrl: 'https://provider.invalid', ownerId: owner.id,
    resolveAssetContext: async (context: { system: string; user: string }, kind: 'reply' | 'structured' | 'text') => assembleCompanionAssetContext(context, await f.profiles.load(owner.id), kind) };
  const connection = companionModelConnection(config), policy = randomUUID();
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  companionModelQuota.configureConnection(connection, 1, policy);
  const blocker = companionModelQuota.run({ ownerId: 'different-owner', connectionId: connection, priority: 'foreground' }, () => hold);
  let pending: Promise<string> | undefined;
  try {
    pending = generateCompanionText({ system: '', user: 'FIXED_PREPARED_NATIVE_INPUT' }, config, undefined, { fetchFn });
    await vi.waitFor(() => expect(companionModelQuota.snapshot().queued).toBe(1));
    expect(fetchFn).not.toHaveBeenCalled();
    await writeFile(file, 'EDITED_WHILE_WAITING_GUIDANCE', 'utf8');
    release(); await blocker; await pending;
    const wire = JSON.parse(String(fetchFn.mock.calls[0]![1]?.body)) as { messages: Array<{ content: string }> };
    expect(wire.messages[0]!.content).toContain('EDITED_WHILE_WAITING_GUIDANCE');
    expect(wire.messages[0]!.content).not.toContain('BEFORE_QUEUE_GUIDANCE');
    expect(wire.messages.at(-1)!.content).toBe('FIXED_PREPARED_NATIVE_INPUT');
  } finally { release(); await blocker; await pending?.catch(() => undefined); companionModelQuota.releaseConnectionPolicy(connection, policy); }
});

it.each(['profile.md', '提示词/对话.md', '.伙伴配置.json', COMPANION_MEMORY_POLICY_FILE])('fails visibly when initialized %s is removed and never silently restores seeds', async relative => {
  const f = await fixture(), file = path.join(f.initial.root, ...relative.split('/')); await unlink(file);
  await expect(f.profiles.load(owner.id)).rejects.toMatchObject({ code: 'MISSING' });
  await expect(f.profiles.bootstrap(owner)).rejects.toMatchObject({ code: relative === '.伙伴配置.json' ? 'CONFLICT' : 'MISSING' });
  await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('uses a durable host receipt to refuse reseeding a deleted owner namespace after restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-asset-profile-')); roots.push(root);
  const initialized = new Set<string>(), library = path.join(root, '伙伴记忆');
  const options = { initialized: async (id: string) => initialized.has(id), markInitialized: async (id: string) => { initialized.add(id); } };
  const initial = await new CompanionAssetProfileStore(library, options).bootstrap(owner);
  expect(initialized.has(owner.id)).toBe(true);
  // The receipt belongs to host lifecycle metadata, not the owner directory.
  await rm(initial.root, { recursive: true });
  const restarted = new CompanionAssetProfileStore(library, options);
  await expect(restarted.bootstrap({ ...owner, persona: '旧缓存不应重新成为初始化素材。' })).rejects.toMatchObject({ code: 'MISSING' });
  await expect(access(initial.root)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('recovers a missing host receipt from a valid completed marker without copying templates again', async () => {
  const f = await fixture(), markInitialized = vi.fn(async () => undefined), loader = vi.fn(async () => '不能重新读取初始模板。');
  const current = { ...f.initial.profile, persona: '初始化后由用户编辑的设定。' };
  await writeFile(path.join(f.initial.root, 'profile.md'), renderCompanionAssetProfile(owner.id, current), 'utf8');
  const restarted = new CompanionAssetProfileStore(f.library, { initialized: async () => false, markInitialized, loadInitialFocusPrompt: loader });
  expect((await restarted.bootstrap(owner)).profile.persona).toBe(current.persona);
  expect(markInitialized).toHaveBeenCalledWith(owner.id); expect(loader).not.toHaveBeenCalled();
});

it('hydrates fresh profile fields without reading prompt modules after durable initialization, while full admission stays strict', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-asset-profile-')); roots.push(root);
  const initialized = new Set<string>(), profiles = new CompanionAssetProfileStore(path.join(root, '伙伴记忆'), {
    initialized: async id => initialized.has(id), markInitialized: async id => { initialized.add(id); },
  });
  const first = await profiles.bootstrapProfile(owner), current = { ...first.profile, name: '状态读取的当前名字', persona: '状态仍实时读人格正文。' };
  await writeFile(path.join(first.root, 'profile.md'), renderCompanionAssetProfile(owner.id, current), 'utf8');
  await unlink(path.join(first.root, '提示词', '对话.md'));
  const fields = await profiles.bootstrapProfile(owner), hydrated = profiles.hydrateProfileFromSnapshot(owner, fields);
  expect(hydrated).toMatchObject({ name: current.name, persona: current.persona, assetProfileRevision: fields.profileRevision });
  expect(hydrated).not.toHaveProperty('assetPromptRevision');
  await expect(profiles.load(owner.id)).rejects.toMatchObject({ code: 'MISSING' });
  await unlink(path.join(first.root, '.伙伴配置.json'));
  await expect(profiles.bootstrapProfile(owner)).rejects.toMatchObject({ code: 'MISSING' });
  await expect(access(path.join(first.root, '.伙伴配置.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('writes software profile and prompt edits to their canonical files with conflict checks against external edits', async () => {
  const f = await fixture();
  const updated = await f.profiles.writeProfile({ companionId: owner.id, expectedRevision: f.initial.profileRevision,
    profile: { ...f.initial.profile, name: '软件保存的名字', persona: '软件保存的完整人格。' } });
  expect(await readFile(path.join(updated.root, 'profile.md'), 'utf8')).toContain('软件保存的完整人格');
  await expect(f.profiles.writeProfile({ companionId: owner.id, expectedRevision: f.initial.profileRevision, profile: f.initial.profile })).rejects.toMatchObject({ code: 'CONFLICT' });
  const prompt = '提示词/对话.md';
  const changed = await f.profiles.writePrompt({ companionId: owner.id, relativePath: prompt, expectedRevision: updated.fileRevisions[prompt]!, content: '新的对话指导。' });
  expect(changed.prompts.chat).toContain('新的对话指导');
  await writeFile(path.join(updated.root, '提示词', '对话.md'), '随后外部编辑的对话指导。', 'utf8');
  await expect(f.profiles.writePrompt({ companionId: owner.id, relativePath: prompt, expectedRevision: changed.fileRevisions[prompt]!, content: '旧编辑器内容' })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await f.profiles.load(owner.id)).prompts.chat).toContain('随后外部编辑');
});

it('stores owner maintenance policy as editable JSON with live validation and file CAS, outside model prompts', async () => {
  const f = await fixture(), module = f.initial.modules.find(item => item.path === COMPANION_MEMORY_POLICY_FILE)!;
  expect(module.purposes).toEqual(['host_policy']); expect(f.initial.memoryPolicy).toEqual(initialCompanionMemoryPolicy());
  const policy = { schema: 'worldlinebox.companion-memory-policy-v1', companionId: 'alice', policy: initialCompanionMemoryPolicy('quiet') };
  const changed = await f.profiles.writePrompt({ companionId: 'alice', relativePath: module.path, expectedRevision: module.revision, content: JSON.stringify(policy) });
  expect(changed.memoryPolicy?.mode).toBe('quiet'); expect(changed.memoryPolicyRevision).not.toBe(module.revision);
  expect(JSON.parse(await readFile(path.join(changed.root, module.path), 'utf8'))).toEqual(policy);
  expect(Object.values(changed.prompts).join('\n')).not.toContain('worldlinebox.companion-memory-policy-v1');
  await expect(f.profiles.writePrompt({ companionId: 'alice', relativePath: module.path, expectedRevision: module.revision, content: JSON.stringify(policy) })).rejects.toMatchObject({ code: 'CONFLICT' });
  policy.policy.capture.batchSize = 13;
  await expect(f.profiles.writePrompt({ companionId: 'alice', relativePath: module.path, expectedRevision: changed.memoryPolicyRevision, content: JSON.stringify(policy) })).rejects.toBeDefined();
  await writeFile(path.join(changed.root, module.path), '{invalid', 'utf8');
  const invalid = await f.profiles.load('alice'); expect(invalid.memoryPolicy).toBeUndefined(); expect(invalid.memoryPolicyError).toContain('暂停');
  expect(invalid.modules.find(module => module.path === COMPANION_MEMORY_POLICY_FILE)?.content).toBe('{invalid');
  expect(invalid.profile.persona).toBe(owner.persona); expect(invalid.prompts.chat).toContain('自然交流');
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ordinaryTaskStillWorks":true}' } }] })));
  expect(await generateCompanionStructured({ system: 'HOST_TECHNICAL_CONTRACT', user: JSON.stringify({ purpose: 'companion_reply', companion: owner }) }, {
    apiFormat: 'openai_chat', model: 'policy-isolation-fixture', baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-only',
    resolveAssetContext: async (context, kind) => assembleCompanionAssetContext(context, await f.profiles.load('alice'), kind),
  }, undefined, { fetchFn })).toEqual({ ordinaryTaskStillWorks: true });
  expect(JSON.parse(String(fetchFn.mock.calls[0]![1]!.body)).messages[0].content).not.toContain('{invalid');
  policy.policy.capture.batchSize = 2;
  const repaired = await f.profiles.writePrompt({ companionId: 'alice', relativePath: module.path, expectedRevision: invalid.memoryPolicyRevision, content: JSON.stringify(policy) });
  expect(repaired.memoryPolicy?.capture.batchSize).toBe(2); expect(repaired.memoryPolicyError).toBeUndefined();
});

it('isolates owners and serializes stale writes even across two adapters for the same directory', async () => {
  const f = await fixture(); await f.profiles.bootstrap({ ...owner, id: 'bob', name: 'Bob', persona: '另一伙伴独立人格。' });
  const otherAdapter = new CompanionAssetProfileStore(f.library), expectedRevision = f.initial.profileRevision;
  const results = await Promise.allSettled([f.profiles.writeProfile({ companionId: owner.id, expectedRevision, profile: { ...f.initial.profile, name: '第一位编辑者' } }),
    otherAdapter.writeProfile({ companionId: owner.id, expectedRevision, profile: { ...f.initial.profile, name: '过时的第二位编辑者' } })]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect((await f.profiles.load('bob')).profile).toMatchObject({ name: 'Bob', persona: '另一伙伴独立人格。' });
  const text = renderCompanionAssetProfile('bob', { ...f.initial.profile, name: '不能改owner' });
  await writeFile(path.join(f.initial.root, 'profile.md'), text, 'utf8');
  await expect(f.profiles.load('alice')).rejects.toMatchObject({ code: 'INVALID' });
});

it('keeps public settings in the same canonical profile transaction and preserves them during a partial persona edit', async () => {
  const f = await fixture();
  const changed = await f.profiles.writeProfile({ companionId: 'alice', expectedRevision: f.initial.profileRevision,
    profile: { name: 'Alice', description: '当前简介', persona: '当前人格。', avatar: 'custom', proactive: true, inputMode: 'queue', avatarAttachmentId: 'approved_avatar' } });
  expect(await f.profiles.hydrate({ ...owner, avatar: 'flash', proactive: false, inputMode: 'steer' })).toMatchObject({ avatar: 'custom', proactive: true,
    inputMode: 'queue', avatarAttachmentId: 'approved_avatar' });
  const partial = await f.profiles.writeProfile({ companionId: 'alice', expectedRevision: changed.profileRevision,
    profile: { name: 'Alice', description: '当前简介', persona: '只修改人格。' } });
  expect(partial.profile).toMatchObject({ avatar: 'custom', proactive: true, inputMode: 'queue', avatarAttachmentId: 'approved_avatar' });
  const cleared = await f.profiles.writeProfile({ companionId: 'alice', expectedRevision: partial.profileRevision,
    profile: { name: 'Alice', description: '当前简介', persona: '只修改人格。', avatarAttachmentId: undefined } });
  expect(cleared.profile.avatarAttachmentId).toBeNull(); expect((await f.profiles.hydrate(owner)).avatarAttachmentId).toBeUndefined();
});

it('rejects malformed and out-of-owner prompt manifests instead of reading arbitrary files', async () => {
  const f = await fixture(), manifestFile = path.join(f.initial.root, '提示词', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.common = ['提示词/../../bob/profile.md']; await writeFile(manifestFile, JSON.stringify(manifest), 'utf8');
  await expect(f.profiles.load('alice')).rejects.toMatchObject({ code: 'INVALID' });
});

it('copies the native focus template only at initialization and preserves exact owner-edited text afterwards', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-asset-profile-')); roots.push(root);
  const original = '\uFEFF  NATIVE {{query}}\n{{memories}}\n\n';
  const loader = vi.fn(async () => original), tags = '\uFEFFNATIVE_TAG {{content}}\n\n', tagLoader = vi.fn(async () => tags);
  const timeline = '\uFEFFORIGINAL_TIMELINE {{agentName}} {{month}}\n\n', summary = 'ORIGINAL_SUMMARY {{agentName}} {{month}}\n';
  const timelineLoader = vi.fn(async () => ({ timeline, summary }));
  const profiles = new CompanionAssetProfileStore(path.join(root, '伙伴记忆'), { loadInitialFocusPrompt: loader, loadInitialTagPrompt: tagLoader, loadInitialTimelinePrompts: timelineLoader });
  const first = await profiles.bootstrap(owner); expect(first.nativeFocusTemplate).toBe(original); expect(loader).toHaveBeenCalledOnce();
  expect(first.tagMasterTemplate).toBe(tags);
  expect(first.nativeTimelineTemplate).toBe(timeline); expect(first.nativeSummaryTemplate).toBe(summary);
  const native = first.modules.find(module => module.purposes.includes('vcp_aimemo'))!;
  expect(native.path).toBe('提示词/记忆聚焦.md'); expect(native.content).toBe(original);
  await profiles.writePrompt({ companionId: owner.id, relativePath: native.path, expectedRevision: native.revision, content: '\nMY EDITED {{query}}\n' });
  expect((await profiles.bootstrap({ ...owner, persona: '软件升级后的种子' })).nativeFocusTemplate).toBe('\nMY EDITED {{query}}\n');
  expect(loader).toHaveBeenCalledOnce();
  const tag = first.modules.find(module => module.purposes.includes('vcp_tagmaster'))!;
  await profiles.writePrompt({ companionId: owner.id, relativePath: tag.path, expectedRevision: tag.revision, content: 'MY_TAG {{content}}\n' });
  expect((await profiles.bootstrap(owner)).tagMasterTemplate).toBe('MY_TAG {{content}}\n'); expect(tagLoader).toHaveBeenCalledOnce();
  const month = first.modules.find(module => module.purposes.includes('native_timeline'))!;
  await profiles.writePrompt({ companionId: owner.id, relativePath: month.path, expectedRevision: month.revision, content: 'MY_MONTH {{agentName}} {{month}}\n' });
  expect((await profiles.bootstrap(owner)).nativeTimelineTemplate).toBe('MY_MONTH {{agentName}} {{month}}\n'); expect(timelineLoader).toHaveBeenCalledOnce();
});

it('rejects a linked canonical file and an incomplete prior initialization without modifying either', async () => {
  const f = await fixture(), file = path.join(f.initial.root, '提示词', '对话.md'), second = path.join(f.root, 'shared-authority.md');
  await link(file, second); await expect(f.profiles.load('alice')).rejects.toMatchObject({ code: 'UNSAFE' });
  const incomplete = path.join(f.library, 'unfinished'); await mkdir(incomplete);
  const authored = '这是尚未登记的人工资料，不能被初始化覆盖。'; await writeFile(path.join(incomplete, 'profile.md'), authored, 'utf8');
  await expect(f.profiles.bootstrap({ ...owner, id: 'unfinished' })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await readFile(path.join(incomplete, 'profile.md'), 'utf8')).toBe(authored);
});
