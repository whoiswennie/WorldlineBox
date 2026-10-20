import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionPublicProfiles } from '../../src/main/companions/public-profiles';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionPublicProfile } from '../../src/shared/companion-public-profile';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import { COMPANION_APPEARANCE_FILES } from '../../src/shared/companion-portrait-files';

const roots: string[] = [], stores = new Set<CompanionsStore>();
const seeds: CompanionSeed[] = ['alice', 'bob', 'carol'].map(id => ({ id, name: id, description: '公开的伙伴介绍 ' + id, persona: '独立且尊重边界。', model: '', avatar: id === 'alice' ? 'sister' : 'custom', proactive: false }));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it('every built-in companion has a packaged default reference and receives its own real readable orthographic path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-public-profiles-')); roots.push(root);
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), BUILTIN_COMPANIONS); stores.add(store);
  const loader = new CompanionPublicProfiles({ root, appPath: process.cwd(), request: async command => store.request(command) });
  expect(Object.keys(COMPANION_APPEARANCE_FILES).sort()).toEqual(BUILTIN_COMPANIONS.map(item => item.id).sort());
  for (const companion of BUILTIN_COMPANIONS) {
    const original = await readFile(path.resolve(COMPANION_APPEARANCE_FILES[companion.id]!));
    const prepared = await loader.prepare({ companionId: companion.id, conversation: store.openPrivate(companion.id), sourceAuthorId: 'user' });
    const image = person(prepared.publicProfiles, companion.id).orthographic!;
    expect(image.available).toBe(true); expect(path.isAbsolute(image.absolutePath)).toBe(true);
    expect(image.sha256).toBe(sha(original)); expect(await readFile(image.absolutePath)).toEqual(original);
    const metadata = await sharp(original).metadata(); expect(metadata.width).toBeGreaterThan(metadata.height!);
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
  const loader = new CompanionPublicProfiles({ root: managed, appPath, request });
  return { root, managed, appPath, store, request, loader, conversation: store.openPrivate('alice') };
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
function person(profiles: readonly CompanionPublicProfile[], id: string) { const profile = profiles.find(item => item.id === id); expect(profile).toBeDefined(); return profile!; }

it('materializes a dev built-in portrait into a real absolute OS file, with pixels bound to the actual companion ID', async () => {
  const f = await fixture(), original = await picture(path.join(f.appPath, 'assets', 'companions', 'portraits', 'deepseek-sister.png'));
  const prepared = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation, sourceAuthorId: 'user' });
  const alice = person(prepared.publicProfiles, 'alice'), file = alice.avatar!.absolutePath;
  expect(path.isAbsolute(file)).toBe(true); expect(path.relative(f.managed, file)).toMatch(/^portraits[/\\]/u); expect(file).not.toContain('app.asar');
  expect(await readFile(file)).toEqual(original); expect(alice.avatar).toMatchObject({ available: true, mime: 'image/png', sha256: sha(original) });
  expect(prepared.visualInputs.map(image => [image.personId, image.role])).toEqual([['alice', 'avatar']]);
  const pixels = Buffer.from(prepared.visualInputs[0]!.base64, 'base64'); expect((await sharp(pixels).metadata()).format).toBe('jpeg'); expect(prepared.visualInputs[0]!.sha256).toBe(sha(pixels));
  expect(await readFile(path.join(f.appPath, 'assets', 'companions', 'portraits', 'deepseek-sister.png'))).toEqual(original);
  await unlink(file); const restored = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation });
  expect(person(restored.publicProfiles, 'alice').avatar!.available).toBe(true); expect(await readFile(file)).toEqual(original);
  await writeFile(file, 'corrupt materialized copy'); const repaired = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation });
  expect(person(repaired.publicProfiles, 'alice').avatar!.available).toBe(true); expect(await readFile(file)).toEqual(original);
});
it('finds emitted hashed portraits in the packaged renderer layout and materializes an absolute path outside app.asar', async () => {
  const f = await fixture(), appPath = path.join(f.root, 'program', 'resources', 'app.asar');
  // The unit fixture uses a directory with the packaged layout. Actual ASAR I/O
  // is covered by the separate Electron process fixture, which can close its archive handle before cleanup.
  const runtime = process as NodeJS.Process & { noAsar?: boolean }, previous = runtime.noAsar; runtime.noAsar = true;
  try {
    const source = path.join(appPath, '.vite', 'renderer', 'main_window', 'assets', 'deepseek-sister-syntheticHash.png'), original = await picture(source, '#4050c0');
    const loader = new CompanionPublicProfiles({ root: f.managed, appPath, request: f.request });
    const prepared = await loader.prepare({ companionId: 'alice', conversation: f.conversation, sourceAuthorId: 'user' });
    const avatar = person(prepared.publicProfiles, 'alice').avatar!;
    expect(avatar.available).toBe(true); expect(avatar.absolutePath).not.toContain('app.asar'); expect(await realpath(avatar.absolutePath)).toBe(avatar.absolutePath);
    expect(await readFile(avatar.absolutePath)).toEqual(original); expect(await readFile(source)).toEqual(original); expect(path.basename(avatar.absolutePath)).toBe(sha(original) + '.png');
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
  f.store.updateCompanion('alice', { ...seeds[0]!, avatar: 'custom', avatarAttachmentId: old.id, appearanceAttachmentId: board.id });
  const first = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation, sourceAuthorId: 'user' }); expect(first.visualInputs).toHaveLength(4);
  f.store.updatePlayerProfile({ name: '新姓名', description: '新的公开介绍', avatarAttachmentId: next.id }, player.revision);
  f.store.updateCompanion('alice', { ...seeds[0]!, name: '当前Alice', avatar: 'custom', avatarAttachmentId: next.id });
  const second = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation, sourceAuthorId: 'user' });
  expect(person(second.publicProfiles, 'user')).toMatchObject({ name: '新姓名', description: '新的公开介绍', revision: player.revision + 1 });
  expect(person(second.publicProfiles, 'alice').name).toBe('当前Alice'); expect(second.visualInputs).toHaveLength(2); expect(second.publicProfiles.every(profile => !profile.orthographic)).toBe(true);
  expect(JSON.stringify(second)).not.toContain(old.file); expect(second.publicProfiles.every(profile => profile.avatar?.sha256 === sha(next.bytes))).toBe(true);
  await unlink(next.file); const deleted = await f.loader.prepare({ companionId: 'alice', conversation: f.conversation, sourceAuthorId: 'user' }); expect(deleted.visualInputs).toEqual([]); expect(deleted.publicProfiles.every(profile => profile.avatar?.available === false)).toBe(true);
  f.store.updatePlayerProfile({ name: '新姓名', description: '' }, f.store.getPlayerProfile().revision); f.store.updateCompanion('alice', { ...seeds[0]!, avatar: 'custom' });
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
  const loader = new CompanionPublicProfiles({ root: f.managed, appPath: f.appPath, request: async command => {
    const result = await f.request(command); if (command.type !== 'state' || !result.state) return result;
    return { ...result, state: { ...result.state, companions: result.state.companions.map(companion => ({ ...companion, avatar: 'custom' as const, avatarAttachmentId: companion.id === 'alice' ? 'linked' : companion.id === 'bob' ? 'missing' : 'corrupt', appearanceAttachmentId: companion.id === 'alice' ? 'corrupt' : undefined })) } };
  } });
  const prepared = await loader.prepare({ companionId: 'alice', conversation: room, sourceAuthorId: 'bob' });
  expect(prepared.visualInputs).toEqual([]); expect(person(prepared.publicProfiles, 'alice').avatar!.available).toBe(false); expect(person(prepared.publicProfiles, 'alice').orthographic!.available).toBe(false); expect(person(prepared.publicProfiles, 'bob').avatar!.available).toBe(false);
  expect(person(prepared.publicProfiles, 'carol').avatar!.available).toBe(false);
});
