import { mkdtemp, readFile, writeFile, rm, unlink, mkdir, link, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionAssetProfileStore, renderCompanionAssetProfile } from '../../src/main/companions/asset-profile';
import type { Companion } from '../../src/shared/companions';

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

it('initializes owner-local assets once, then hydrates live files without overwriting authored profile or prompt edits', async () => {
  const f = await fixture(), profileFile = path.join(f.initial.root, 'profile.md');
  expect(f.initial.profile.persona).toBe(owner.persona);
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

it.each(['profile.md', '提示词/对话.md', '.伙伴配置.json'])('fails visibly when initialized %s is removed and never silently restores seeds', async relative => {
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
