import { createHash } from 'node:crypto';
import { access, link, mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionPublicProfiles } from '../../src/main/companions/public-profiles';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionPublicProfile } from '../../src/shared/companion-public-profile';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import { COMPANION_APPEARANCE_FILES, COMPANION_PORTRAIT_FILES } from '../../src/shared/companion-portrait-files';
import { CompanionAssetProfileStore, renderCompanionAssetProfile } from '../../src/main/companions/asset-profile';
import { companionPortraitResponse } from '../../src/main/companions/portrait-response';

const roots: string[] = [], stores = new Set<CompanionsStore>();
const seeds: CompanionSeed[] = ['alice', 'bob', 'carol'].map(id => ({ id, name: id, description: '公开的伙伴介绍 ' + id, persona: '独立且尊重边界。', model: '', avatar: id === 'alice' ? 'sister' : 'custom', proactive: false }));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it.each([false, true])('every built-in companion receives readable owner images for fresh and already initialized instances (%s)', async previousExport => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-public-profiles-')); roots.push(root);
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), BUILTIN_COMPANIONS); stores.add(store);
  const loader = new CompanionPublicProfiles({ root, libraryDirectory: path.join(root, '伙伴记忆'), appPath: process.cwd(), request: async command => store.request(command) });
  expect(Object.keys(COMPANION_APPEARANCE_FILES).sort()).toEqual(BUILTIN_COMPANIONS.map(item => item.id).sort());
  for (const companion of BUILTIN_COMPANIONS) {
    if (previousExport) {
      const current = store.state().companions.find(owner => owner.id === companion.id)!;
      await new CompanionAssetProfileStore(path.join(root, '伙伴记忆')).bootstrap(current);
    }
    const original = await readFile(path.resolve(COMPANION_APPEARANCE_FILES[companion.id]!));
    const prepared = await loader.prepare({ companionId: companion.id, conversation: store.openPrivate(companion.id), sourceAuthorId: 'user' });
    const image = person(prepared.publicProfiles, companion.id).orthographic!;
    expect(image.available).toBe(true); expect(path.isAbsolute(image.absolutePath)).toBe(true);
    expect(image.sha256).toBe(sha(original)); expect(await readFile(image.absolutePath)).toEqual(original);
    const metadata = await sharp(original).metadata(); expect(metadata.width).toBeGreaterThan(metadata.height!);
    const runtime = await loader.runtimeImages(store.request({ type: 'state' }).state!.companions.find(owner => owner.id === companion.id)!);
    expect(runtime.avatar?.url).toContain(`/portrait/${companion.id}/avatar?`);
    expect(runtime.orthographic?.sha256).toBe(sha(original));
  }
});
afterEach(async () => {
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) { if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('companion-public-profiles-')) throw new Error('Unexpected public profile fixture root.'); await rm(root, { recursive: true, force: true }); }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-public-profiles-')); roots.push(root);
  const managed = path.join(root, 'profile'), appPath = path.join(root, 'app'); await mkdir(managed); await mkdir(appPath);
  const store = new CompanionsStore(path.join(managed, 'messages.sqlite'), seeds.map(seed => ({ ...seed, active: true }))); stores.add(store);
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => store.request(command);
  const libraryDirectory = path.join(managed, '伙伴记忆');
  const loader = new CompanionPublicProfiles({ root: managed, libraryDirectory, appPath, request });
  return { root, managed, libraryDirectory, appPath, store, request, loader, conversation: store.openPrivate('alice') };
}
async function picture(file: string, color = '#b05030', width = 64, height = 96): Promise<Buffer> {
  await mkdir(path.dirname(file), { recursive: true });
  const bytes = await sharp({ create: { width, height, channels: 4, background: color } }).toFormat(path.extname(file) === '.jpg' ? 'jpeg' : 'png').toBuffer();
  await writeFile(file, bytes); return bytes;
}
async function managedImage(f: Awaited<ReturnType<typeof fixture>>, id: string, color: string, width?: number, height?: number) {
  const relativePath = 'attachments/' + id + '.png', file = path.join(f.managed, relativePath), bytes = await picture(file, color, width, height);
  f.store.registerAttachment({ attachment: { id, name: id + '.png', mime: 'image/png', size: bytes.length }, relativePath }); return { id, file, bytes };
}
it('serves live owner pixels to saved UI URLs, refreshes hashes on external edits, and never restores deleted images after restart', async () => {
  const f = await fixture(), initialized = new Set<string>(), profiles = new CompanionAssetProfileStore(f.libraryDirectory);
  const options = { root: f.managed, appPath: f.appPath, profileStore: profiles, request: f.request,
    portraitInitialized: async (id: string, role: string) => initialized.has(id + '/' + role),
    markPortraitInitialized: async (id: string, role: string) => { initialized.add(id + '/' + role); } };
  const original = await picture(path.join(f.appPath, 'assets', 'companions', 'portraits', 'deepseek-sister.png'));
  const owner = f.store.request({ type: 'state' }).state!.companions.find(owner => owner.id === 'alice')!;
  const loader = new CompanionPublicProfiles(options);
  // The protocol is a read-only endpoint: it cannot bootstrap a new owner.
  const unknown = await companionPortraitResponse(new Request('worldlinebox-companion://portrait/bob/avatar?v=' + sha(original)), (id, role) => loader.readOwnerImage(id, role));
  expect(unknown.status).toBe(404); await expect(access(path.join(f.libraryDirectory, 'bob'))).rejects.toMatchObject({ code: 'ENOENT' });
  const first = (await loader.runtimeImages(owner)).avatar!;
  expect(first.sha256).toBe(sha(original)); expect(first.url).toContain('/portrait/alice/avatar?v=' + sha(original));
  const serve = (url: string, method = 'GET') => companionPortraitResponse(new Request(url, { method }), (id, role) => loader.readOwnerImage(id, role));
  const response = await serve(first.url);
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(original);
  const directory = path.join(f.libraryDirectory, 'alice', '形象'), file = path.join(directory, 'avatar.png');
  const changed = await picture(file, '#174ed0');
  const second = (await loader.runtimeImages(owner)).avatar!;
  expect(second.sha256).toBe(sha(changed)); expect(second.url).not.toBe(first.url); expect((await serve(first.url)).status).toBe(404);
  expect(Buffer.from(await (await serve(second.url)).arrayBuffer())).toEqual(changed);
  const head = await serve(second.url, 'HEAD'); expect(head.headers.get('content-length')).toBe(String(changed.length)); expect(await head.text()).toBe('');
  expect((await serve(second.url + '&path=../../bob/avatar.png')).status).toBe(404);
  expect((await serve(second.url.replace('/alice/', '/bob/'))).status).toBe(404);
  const alias = path.join(f.managed, 'forbidden-image-link.png'); await link(file, alias);
  expect((await serve(second.url)).status).toBe(404); expect((await loader.runtimeImages(owner)).avatar).toBeUndefined(); await unlink(alias);
  await unlink(file); expect((await loader.runtimeImages(owner)).avatar).toBeUndefined();
  await writeFile(file, changed);
  const restored = (await loader.runtimeImages(owner)).avatar!;
  expect(restored.sha256).toBe(second.sha256); expect(restored.url).not.toBe(second.url);
  expect((await serve(second.url)).status).toBe(404); expect((await serve(restored.url)).status).toBe(200);
  await rm(directory, { recursive: true });
  const restarted = new CompanionPublicProfiles(options);
  expect((await restarted.runtimeImages(owner)).avatar).toBeUndefined();
  expect((await companionPortraitResponse(new Request(second.url), (id, role) => restarted.readOwnerImage(id, role))).status).toBe(404);
  await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('renders the owner custom copy even when its original attachment disappears, with a fresh physical-image hash', async () => {
  const f = await fixture(), profiles = new CompanionAssetProfileStore(f.libraryDirectory), image = await managedImage(f, 'chosen-avatar', '#32a050');
  const seed = f.store.request({ type: 'state' }).state!.companions.find(owner => owner.id === 'alice')!, initial = await profiles.bootstrap(seed);
  const next = await profiles.writeProfile({ companionId: seed.id, expectedRevision: initial.profileRevision, profile: { ...initial.profile, avatar: 'custom', avatarAttachmentId: image.id } });
  const owner = profiles.hydrateFromSnapshot(seed, next), loader = new CompanionPublicProfiles({ root: f.managed, appPath: f.appPath, profileStore: profiles, request: f.request });
  await loader.applyImageSelection(seed, owner); await unlink(image.file);
  const own = (await loader.runtimeImages(owner)).avatar!; expect(own.sha256).toBe(sha(image.bytes));
  expect((await loader.readOwnerImage(owner.id, 'avatar'))!.bytes).toEqual(image.bytes);
});
function person(profiles: readonly CompanionPublicProfile[], id: string) { const profile = profiles.find(item => item.id === id); expect(profile).toBeDefined(); return profile!; }

it('keeps only current owner/role metadata for 72 real two-image residents, without warm pixel reads or a sequential 64-entry cache thrash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-public-profiles-')); roots.push(root);
  const libraryDirectory = path.join(root, '伙伴记忆'), store = new CompanionsStore(path.join(root, 'state.sqlite'), Array.from({ length: 72 }, (_, n) => ({
    id: 'resident-' + n, name: '伙伴' + n, persona: '根据本人文件生活。', description: '', model: '', avatar: 'custom' as const, proactive: false,
  }))); stores.add(store);
  const owners = store.request({ type: 'state' }).state!.companions.map(owner => ({ ...owner, avatarAttachmentId: 'initial-selection', appearanceAttachmentId: 'initial-selection' }));
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#3178a0' } }).png().toBuffer();
  for (const owner of owners) {
    const directory = path.join(libraryDirectory, owner.id); await mkdir(path.join(directory, '形象'), { recursive: true });
    await writeFile(path.join(directory, 'profile.md'), renderCompanionAssetProfile(owner.id, { name: owner.name, description: owner.description, persona: owner.persona,
      avatar: owner.avatar, proactive: owner.proactive, inputMode: 'steer', avatarAttachmentId: owner.avatarAttachmentId, appearanceAttachmentId: owner.appearanceAttachmentId }));
    await writeFile(path.join(directory, '.伙伴配置.json'), JSON.stringify({ schema: 'worldlinebox.companion-assets-v1', companionId: owner.id, initializedAt: new Date().toISOString() }));
    for (const role of ['avatar', 'orthographic']) {
      await writeFile(path.join(directory, '形象', role + '.png'), bytes);
      await writeFile(path.join(directory, '形象', '.' + role + '-initialized.json'), JSON.stringify({ companionId: owner.id, role, path: role + '.png', attachmentId: 'initial-selection' }));
    }
  }
  const request = vi.fn(async () => { throw new Error('Warm metadata must not fetch or copy the original attachment.'); });
  const loader = new CompanionPublicProfiles({ root, appPath: root, profileStore: new CompanionAssetProfileStore(libraryDirectory), request, portraitInitialized: async () => true });
  // This spy calls the real bounded fd read, real pixel decoder and real hash.
  const bodyReads = vi.spyOn(loader, 'readOwnerImage');
  const state = () => Promise.all(owners.map(owner => loader.runtimeImages(owner)));
  const cold = await state(); expect(cold.every(images => images.avatar && images.orthographic)).toBe(true); expect(bodyReads).toHaveBeenCalledTimes(144);
  bodyReads.mockClear(); const warm = await state(); expect(warm).toEqual(cold); expect(bodyReads).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  const changedFile = path.join(libraryDirectory, owners[3]!.id, '形象', 'avatar.png'), deletedFile = path.join(libraryDirectory, owners[5]!.id, '形象', 'orthographic.png');
  const changed = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#d05030' } }).png().toBuffer();
  await writeFile(changedFile, changed); await unlink(deletedFile);
  bodyReads.mockClear(); const refreshed = await state();
  expect(bodyReads.mock.calls).toEqual([[owners[3]!.id, 'avatar']]); expect(refreshed[3]!.avatar!.sha256).toBe(sha(changed)); expect(refreshed[3]!.orthographic).toEqual(cold[3]!.orthographic);
  expect(refreshed[5]!.orthographic).toBeUndefined(); await expect(access(deletedFile)).rejects.toMatchObject({ code: 'ENOENT' }); expect(request).not.toHaveBeenCalled();
  for (let n = 0; n < owners.length; n++) if (n !== 3 && n !== 5) expect(refreshed[n]).toEqual(cold[n]);
  bodyReads.mockClear(); expect(await state()).toEqual(refreshed); expect(bodyReads).not.toHaveBeenCalled();
});

it('keeps a healthy owner available when another group member has damaged files, while its own files remain mandatory', async () => {
  const f = await fixture(), profiles = new CompanionAssetProfileStore(f.libraryDirectory);
  const owners = f.store.request({ type: 'state' }).state!.companions;
  for (const owner of owners) await profiles.bootstrap(owner);
  const group = f.store.request({ type: 'conversation.create-group', title: 'isolated profiles', memberIds: ['alice', 'bob'] }).conversation!;
  await writeFile(path.join(f.libraryDirectory, 'bob', 'profile.md'), 'damaged owner profile', 'utf8');
  const actual = await f.loader.prepare({ companionId: 'alice', conversation: group, sourceAuthorId: 'bob' });
  expect(actual.publicProfiles.map(profile => profile.id)).toContain('alice');
  expect(actual.publicProfiles.map(profile => profile.id)).not.toContain('bob');
  await expect(f.loader.prepare({ companionId: 'bob', conversation: group, sourceAuthorId: 'alice' })).rejects.toMatchObject({ code: 'INVALID' });
  expect(await readFile(path.join(f.libraryDirectory, 'bob', 'profile.md'), 'utf8')).toBe('damaged owner profile');
});

it('does not reseed a deleted portrait directory after restart, but an explicit built-in image selection can recreate it', async () => {
  const f = await fixture(), initialized = new Set<string>(), profiles = new CompanionAssetProfileStore(f.libraryDirectory);
  const options = { root: f.managed, libraryDirectory: f.libraryDirectory, profileStore: profiles, appPath: f.appPath, request: f.request,
    portraitInitialized: async (id: string, role: string) => initialized.has(id + '/' + role),
    markPortraitInitialized: async (id: string, role: string) => { initialized.add(id + '/' + role); } };
  const bytes = await picture(path.join(f.appPath, 'assets', 'companions', 'portraits', 'deepseek-sister.png'));
  const loader = new CompanionPublicProfiles(options), initial = await loader.prepare({ companionId: 'alice', conversation: f.conversation });
  const directory = path.dirname(person(initial.publicProfiles, 'alice').avatar!.absolutePath);
  expect(initialized.has('alice/avatar')).toBe(true);
  await rm(directory, { recursive: true });
  const restarted = new CompanionPublicProfiles(options), unavailable = await restarted.prepare({ companionId: 'alice', conversation: f.conversation });
  expect(person(unavailable.publicProfiles, 'alice').avatar).toBeUndefined();
  await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  const owner = f.store.request({ type: 'state' }).state!.companions.find(owner => owner.id === 'alice')!;
  await restarted.applyImageSelection({ ...owner, avatar: 'custom' }, owner);
  const explicit = await restarted.prepare({ companionId: 'alice', conversation: f.conversation });
  expect(await readFile(person(explicit.publicProfiles, 'alice').avatar!.absolutePath)).toEqual(bytes);
});

it('keeps an initialized custom portrait unavailable after its directory is removed until an explicit new selection is saved', async () => {
  const f = await fixture(), initialized = new Set<string>(), profiles = new CompanionAssetProfileStore(f.libraryDirectory);
  const options = { root: f.managed, libraryDirectory: f.libraryDirectory, profileStore: profiles, appPath: f.appPath, request: f.request,
    portraitInitialized: async (id: string, role: string) => initialized.has(id + '/' + role),
    markPortraitInitialized: async (id: string, role: string) => { initialized.add(id + '/' + role); } };
  const oldImage = await managedImage(f, 'avatar-first', '#c03020'), newImage = await managedImage(f, 'avatar-second', '#2040c0');
  const seed = f.store.request({ type: 'state' }).state!.companions.find(owner => owner.id === 'alice')!, first = await profiles.bootstrap(seed);
  let snapshot = await profiles.writeProfile({ companionId: 'alice', expectedRevision: first.profileRevision,
    profile: { ...first.profile, avatar: 'custom', avatarAttachmentId: oldImage.id } });
  const oldOwner = profiles.hydrateFromSnapshot(seed, snapshot), loader = new CompanionPublicProfiles(options);
  await loader.applyImageSelection(seed, oldOwner);
  const prepared = await loader.prepare({ companionId: 'alice', conversation: f.conversation }), directory = path.dirname(person(prepared.publicProfiles, 'alice').avatar!.absolutePath);
  await rm(directory, { recursive: true });
  const restarted = new CompanionPublicProfiles(options);
  expect(person((await restarted.prepare({ companionId: 'alice', conversation: f.conversation })).publicProfiles, 'alice').avatar?.available).toBe(false);
  await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  snapshot = await profiles.writeProfile({ companionId: 'alice', expectedRevision: snapshot.profileRevision,
    profile: { ...snapshot.profile, avatarAttachmentId: newImage.id } });
  const newOwner = profiles.hydrateFromSnapshot(seed, snapshot);
  expect(person((await restarted.prepare({ companionId: 'alice', conversation: f.conversation })).publicProfiles, 'alice').avatar?.available).toBe(false);
  await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  await restarted.applyImageSelection(oldOwner, newOwner);
  expect(await readFile(person((await restarted.prepare({ companionId: 'alice', conversation: f.conversation })).publicProfiles, 'alice').avatar!.absolutePath)).toEqual(newImage.bytes);
});

it('materializes a dev built-in portrait into a real absolute OS file, with pixels bound to the actual companion ID', async () => {
  const f = await fixture(), original = await picture(path.join(f.appPath, 'assets', 'companions', 'portraits', 'deepseek-sister.png'));
  const prepared = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation, sourceAuthorId: 'user' });
  const alice = person(prepared.publicProfiles, 'alice'), file = alice.avatar!.absolutePath;
  expect(path.isAbsolute(file)).toBe(true); expect(path.relative(f.libraryDirectory, file)).toMatch(/^alice[/\\]形象[/\\]/u); expect(file).not.toContain('app.asar');
  expect(await readFile(file)).toEqual(original); expect(alice.avatar).toMatchObject({ available: true, mime: 'image/png', sha256: sha(original) });
  expect(prepared.visualInputs.map(image => [image.personId, image.role])).toEqual([['alice', 'avatar']]);
  const pixels = Buffer.from(prepared.visualInputs[0]!.base64, 'base64'); expect((await sharp(pixels).metadata()).format).toBe('jpeg'); expect(prepared.visualInputs[0]!.sha256).toBe(sha(pixels));
  expect(await readFile(path.join(f.appPath, 'assets', 'companions', 'portraits', 'deepseek-sister.png'))).toEqual(original);
  await unlink(file); const restored = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation });
  expect(person(restored.publicProfiles, 'alice').avatar!.available).toBe(false); await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(file, 'corrupt materialized copy'); const repaired = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation });
  expect(person(repaired.publicProfiles, 'alice').avatar!.available).toBe(false); expect(await readFile(file, 'utf8')).toBe('corrupt materialized copy');
  const edited = await picture(file, '#104080'); const live = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation });
  expect(person(live.publicProfiles, 'alice').avatar).toMatchObject({ available: true, sha256: sha(edited) });
});
it('finds emitted hashed portraits in the packaged renderer layout and materializes an absolute path outside app.asar', async () => {
  const f = await fixture(), appPath = path.join(f.root, 'program', 'resources', 'app.asar');
  // The unit fixture uses a directory with the packaged layout. Actual ASAR I/O
  // is covered by the separate Electron process fixture, which can close its archive handle before cleanup.
  const runtime = process as NodeJS.Process & { noAsar?: boolean }, previous = runtime.noAsar; runtime.noAsar = true;
  try {
    const source = path.join(appPath, '.vite', 'renderer', 'main_window', 'assets', 'deepseek-sister-syntheticHash.png'), original = await picture(source, '#4050c0');
    const loader = new CompanionPublicProfiles({ root: f.managed, libraryDirectory: f.libraryDirectory, appPath, request: f.request });
    const prepared = await loader.prepare({ companionId: 'alice', conversation: f.conversation, sourceAuthorId: 'user' });
    const avatar = person(prepared.publicProfiles, 'alice').avatar!;
    expect(avatar.available).toBe(true); expect(avatar.absolutePath).not.toContain('app.asar'); expect(await realpath(avatar.absolutePath)).toBe(avatar.absolutePath);
    expect(await readFile(avatar.absolutePath)).toEqual(original); expect(await readFile(source)).toEqual(original); expect(path.basename(avatar.absolutePath)).toBe('avatar.png');
  } finally { await rm(path.join(f.root, 'program'), { recursive: true, force: true }); runtime.noAsar = previous; }
});
it('binds real managed player/companion avatar and board pixels to their owners, selecting at most four bounded current-speaker images', async () => {
  const f = await fixture(), imageMap = new Map<string, Buffer>();
  for (const [id, color] of [['user-avatar', '#c03030'], ['user-board', '#30c030'], ['alice-avatar', '#3030c0'], ['alice-board', '#c0c030'], ['bob-avatar', '#c030c0'], ['bob-board', '#30c0c0']] as const) imageMap.set(id, (await managedImage(f, id, color, id.endsWith('board') ? 2400 : 640, id.endsWith('board') ? 1000 : 720)).bytes);
  f.store.updatePlayerProfile({ name: '真实玩家', description: '公开身份介绍', avatarAttachmentId: 'user-avatar', appearanceAttachmentId: 'user-board' }, f.store.getPlayerProfile().revision);
  for (const id of ['alice', 'bob']) f.store.updateCompanion(id, { ...seeds.find(seed => seed.id === id)!, avatarAttachmentId: id + '-avatar', appearanceAttachmentId: id + '-board' });
  const room = f.store.createConversation('实际三伙伴群聊', ['alice', 'bob', 'carol']);
  const prepared = await f.loader.prepare({ companionId: 'alice', conversation: room, sourceAuthorId: 'user' });
  expect(prepared.publicProfiles.map(profile => profile.id)).toEqual(['user', 'alice', 'bob', 'carol']); expect(prepared.visualInputs).toHaveLength(4);
  expect(prepared.visualInputs.map(image => [image.personId, image.role])).toEqual([['user', 'orthographic'], ['alice', 'orthographic'], ['user', 'avatar'], ['alice', 'avatar']]);
  for (const image of prepared.visualInputs) {
    const bytes = Buffer.from(image.base64, 'base64'), profile = person(prepared.publicProfiles, image.personId), publicImage = image.role === 'avatar' ? profile.avatar! : profile.orthographic!;
    expect(path.isAbsolute(publicImage.absolutePath)).toBe(true); expect(publicImage.sha256).toBe(sha(imageMap.get((image.personId === 'user' ? 'user' : image.personId) + (image.role === 'avatar' ? '-avatar' : '-board'))!));
    expect(bytes.length).toBeLessThanOrEqual(1024 * 1024); expect(sha(bytes)).toBe(image.sha256); expect((await sharp(bytes).metadata()).format).toBe('jpeg');
  }
  expect(person(prepared.publicProfiles, 'bob').avatar!.available).toBe(true); expect(prepared.visualInputs.some(image => image.personId === 'bob')).toBe(false);
});
it('keeps the public player identity and images out of peer-only conversations, even with directory context', async () => {
  const f = await fixture(); await managedImage(f, 'user-avatar', '#f07050'); await managedImage(f, 'alice-avatar', '#40a040'); await managedImage(f, 'bob-avatar', '#5060f0');
  f.store.updatePlayerProfile({ name: 'PLAYER_NAME_PRIVATE_TO_PLAYER_AUDIENCE', description: 'PLAYER_PUBLIC_DESCRIPTION_EXCLUDED_FROM_PEERS', avatarAttachmentId: 'user-avatar' }, f.store.getPlayerProfile().revision);
  for (const id of ['alice', 'bob']) f.store.updateCompanion(id, { ...seeds.find(seed => seed.id === id)!, avatarAttachmentId: id + '-avatar' });
  const room = f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
  const prepared = await f.loader.prepare({ companionId: 'alice', conversation: room, sourceAuthorId: 'bob', audience: 'peers', directory: true });
  expect(prepared.publicProfiles.every(profile => profile.id !== 'user' && profile.kind === 'companion')).toBe(true); expect(prepared.visualInputs.every(image => image.personId !== 'user')).toBe(true);
  expect(JSON.stringify(prepared)).not.toMatch(/PLAYER_NAME|PLAYER_PUBLIC_DESCRIPTION|user-avatar/u); expect(new Set(prepared.visualInputs.map(image => image.personId))).toEqual(new Set(['alice', 'bob']));
  expect(await f.loader.prepare({ companionId: 'carol', conversation: room, sourceAuthorId: 'bob', audience: 'peers' })).toEqual({ publicProfiles: [], visualInputs: [] });
});
it('refreshes names, revisions and replacement/removal files on every prepare instead of retaining an earlier public profile', async () => {
  const f = await fixture(), old = await managedImage(f, 'old-avatar', '#d04040'), next = await managedImage(f, 'new-avatar', '#40b0d0'), board = await managedImage(f, 'board', '#60d060');
  const player = f.store.updatePlayerProfile({ name: '旧姓名', description: '旧公开介绍', avatarAttachmentId: old.id, appearanceAttachmentId: board.id }, f.store.getPlayerProfile().revision);
  const oldCompanion = f.store.updateCompanion('alice', { ...seeds[0]!, avatar: 'custom', avatarAttachmentId: old.id, appearanceAttachmentId: board.id });
  const first = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation, sourceAuthorId: 'user' }); expect(first.visualInputs).toHaveLength(4);
  f.store.updatePlayerProfile({ name: '新姓名', description: '新的公开介绍', avatarAttachmentId: next.id }, player.revision);
  const nextCompanion = f.store.updateCompanion('alice', { ...seeds[0]!, name: '当前Alice', avatar: 'custom', avatarAttachmentId: next.id });
  const files = new CompanionAssetProfileStore(f.libraryDirectory), current = await files.load('alice');
  await files.writeProfile({ companionId: 'alice', expectedRevision: current.profileRevision,
    profile: { name: '当前Alice', description: current.profile.description, persona: current.profile.persona, avatar: 'custom',
      avatarAttachmentId: next.id, appearanceAttachmentId: undefined } });
  await f.loader.applyImageSelection(oldCompanion, nextCompanion);
  const second = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation, sourceAuthorId: 'user' });
  expect(person(second.publicProfiles, 'user')).toMatchObject({ name: '新姓名', description: '新的公开介绍', revision: player.revision + 1 });
  expect(person(second.publicProfiles, 'alice').name).toBe('当前Alice'); expect(second.visualInputs).toHaveLength(2); expect(second.publicProfiles.every(profile => !profile.orthographic)).toBe(true);
  expect(JSON.stringify(second)).not.toContain(old.file); expect(second.publicProfiles.every(profile => profile.avatar?.sha256 === sha(next.bytes))).toBe(true);
  const ownerImage = person(second.publicProfiles, 'alice').avatar!.absolutePath;
  expect(path.relative(f.libraryDirectory, ownerImage)).toMatch(/^alice[/\\]形象[/\\]/u);
  expect(ownerImage).not.toBe(next.file); expect(await readFile(ownerImage)).toEqual(next.bytes);
  await unlink(ownerImage); const missingOwner = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation, sourceAuthorId: 'user' });
  expect(person(missingOwner.publicProfiles, 'alice').avatar?.available).toBe(false); expect(await readFile(next.file)).toEqual(next.bytes);
  await unlink(next.file); const deleted = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation, sourceAuthorId: 'user' }); expect(deleted.visualInputs).toEqual([]); expect(deleted.publicProfiles.every(profile => profile.avatar?.available === false)).toBe(true);
  f.store.updatePlayerProfile({ name: '新姓名', description: '' }, f.store.getPlayerProfile().revision); f.store.updateCompanion('alice', { ...seeds[0]!, avatar: 'custom' });
  const latest = await files.load('alice'); await files.writeProfile({ companionId: 'alice', expectedRevision: latest.profileRevision,
    profile: { name: latest.profile.name, description: latest.profile.description, persona: latest.profile.persona, avatarAttachmentId: undefined, appearanceAttachmentId: undefined } });
  const cleared = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation, sourceAuthorId: 'user' }); expect(cleared.publicProfiles.every(profile => !profile.avatar && !profile.orthographic)).toBe(true); expect(cleared.visualInputs).toEqual([]);
});
it('rejects invalid, linked, missing and corrupt images, including corrupt non-speaker directory entries', async () => {
  const f = await fixture(), linked = await picture(path.join(f.root, 'linked-source.png'));
  f.store.registerAttachment({ attachment: { id: 'linked', name: 'linked.png', mime: 'image/png', size: linked.length }, relativePath: 'attachments/linked.png', sourcePath: path.join(f.root, 'linked-source.png') });
  await mkdir(path.join(f.managed, 'attachments'), { recursive: true }); await writeFile(path.join(f.managed, 'attachments', 'corrupt.png'), 'This is not an image.');
  for (const id of ['corrupt', 'missing']) f.store.registerAttachment({ attachment: { id, name: id + '.png', mime: 'image/png', size: 21 }, relativePath: 'attachments/' + id + '.png' });
  f.store.registerAttachment({ attachment: { id: 'pdf', name: 'pdf.pdf', mime: 'application/pdf', size: 21 }, relativePath: 'attachments/pdf.pdf' });
  for (const id of ['linked', 'corrupt', 'missing', 'pdf', 'not-registered']) await expect(f.loader.validateImage(id)).rejects.toThrow('可读取');
  const valid = await managedImage(f, 'valid', '#70a060'); await expect(f.loader.validateImage(valid.id)).resolves.toBeUndefined();
  const room = f.store.createConversation('损坏资料的隔离验收', ['alice', 'bob', 'carol']);
  const loader = new CompanionPublicProfiles({ root: f.managed, libraryDirectory: f.libraryDirectory, appPath: f.appPath, request: async command => {
    const result = await f.request(command); if (command.type !== 'state' || !result.state) return result;
    return { ...result, state: { ...result.state, companions: result.state.companions.map(companion => ({ ...companion, avatar: 'custom' as const, avatarAttachmentId: companion.id === 'alice' ? 'linked' : companion.id === 'bob' ? 'missing' : 'corrupt', appearanceAttachmentId: companion.id === 'alice' ? 'corrupt' : undefined })) } };
  } });
  const prepared = await loader.prepare({ companionId: 'alice', conversation: room, sourceAuthorId: 'bob' });
  expect(prepared.visualInputs).toEqual([]); expect(person(prepared.publicProfiles, 'alice').avatar!.available).toBe(false); expect(person(prepared.publicProfiles, 'alice').orthographic!.available).toBe(false); expect(person(prepared.publicProfiles, 'bob').avatar!.available).toBe(false);
  expect(person(prepared.publicProfiles, 'carol').avatar!.available).toBe(false);
});

it('materializes both images under a re-added identity using its explicit template, not the old owner ID', async () => {
  const f = await fixture(), seed = BUILTIN_COMPANIONS.find(owner => owner.id === 'deepseek-flash')!;
  await picture(path.join(f.appPath, COMPANION_PORTRAIT_FILES.flash), '#44aabb', 64, 64);
  await picture(path.join(f.appPath, COMPANION_APPEARANCE_FILES[seed.id]!), '#55bbcc', 192, 64);
  const owner = { ...seed, id: 'new-flash-instance', templateId: seed.id, builtin: true, createdAt: new Date().toISOString() };
  const profiles = new CompanionAssetProfileStore(f.libraryDirectory);
  const loader = new CompanionPublicProfiles({ root: f.managed, appPath: f.appPath, profileStore: profiles, request: f.request });
  const images = await loader.runtimeImages(owner);
  expect(images.avatar?.url).toContain('/new-flash-instance/avatar?');
  expect(images.orthographic?.url).toContain('/new-flash-instance/orthographic?');
  expect((await profiles.loadProfile(owner.id)).profile.templateId).toBe(seed.id);
  expect(await loader.readOwnerImage(owner.id, 'orthographic')).toBeDefined();
});
