import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { CompanionPublicProfiles } from '../../src/main/companions/public-profiles';
import { COMPANION_APPEARANCE_FILES, COMPANION_PORTRAIT_FILES } from '../../src/shared/companion-portrait-files';
import type { Companion, CompanionConversation, CompanionState } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse, StoredCompanionAttachment } from '../../src/shared/companion-storage';

const roots: string[] = [];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { for (const root of roots.splice(0)) {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('companion-builtin-appearance-')) throw new Error('Unexpected fixture root.');
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
} });
async function fixture(packaged = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-builtin-appearance-')); roots.push(root);
  // Exercise the hashed production layout here. A real archive is covered by
  // the separate ASAR Electron test; a directory named .asar is not an archive.
  const managed = path.join(root, 'managed'), appPath = path.join(root, packaged ? 'packaged-app' : 'app'); await mkdir(managed); await mkdir(appPath);
  const companions: Companion[] = (['sister', 'flash'] as const).map(avatar => ({ id: 'deepseek-' + avatar, name: avatar, description: '', persona: 'Isolated fixture.',
    avatar, model: '', proactive: false, builtin: true, createdAt: '2026-10-15T00:00:00.000Z', revision: 1 }));
  const conversation: CompanionConversation = { id: 'peer-fixture', kind: 'group', title: 'Fixture', memberIds: companions.map(item => item.id), pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: '2026-10-15T00:00:00.000Z' };
  const state: CompanionState = { companions, conversations: [conversation], configured: false, activities: [] }, attachments = new Map<string, StoredCompanionAttachment>();
  const commands: CompanionStorageCommand[] = [];
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    commands.push(command);
    if (command.type === 'state') return { ok: true, state };
    if (command.type === 'attachment.get') return { ok: true, storedAttachment: attachments.get(command.id) };
    throw new Error('Unexpected storage mutation: ' + command.type);
  };
  const loader = new CompanionPublicProfiles({ root: managed, appPath, request });
  const prepare = () => loader.prepare({ companionId: companions[0]!.id, sourceAuthorId: companions[1]!.id, conversation, audience: 'peers' });
  return { root, managed, appPath, companions, attachments, commands, loader, prepare };
}
async function image(file: string, color: string, board = false) {
  await mkdir(path.dirname(file), { recursive: true });
  const bytes = await sharp({ create: { width: board ? 192 : 64, height: 64, channels: 4, background: color } }).png().toBuffer(); await writeFile(file, bytes); return bytes;
}
async function builtins(f: Awaited<ReturnType<typeof fixture>>, packaged = false) {
  const originals = new Map<string, Buffer>();
  for (const [index, avatar] of (['sister', 'flash'] as const).entries()) for (const role of ['avatar', 'orthographic'] as const) {
    const relative = role === 'avatar' ? COMPANION_PORTRAIT_FILES[avatar] : COMPANION_APPEARANCE_FILES['deepseek-' + avatar]!;
    // The board sorts before the avatar. A naive basename prefix lookup would select the wrong pixels.
    const file = packaged ? path.join(f.appPath, '.vite/renderer/main_window/assets', path.basename(relative, '.png') + (role === 'avatar' ? '-zzzz9999.png' : '-aaaa0000.png')) : path.join(f.appPath, relative);
    originals.set(avatar + '/' + role, await image(file, ['#aa2233', '#228844', '#3344bb', '#bb8822'][index * 2 + Number(role === 'orthographic')]!, role === 'orthographic'));
  }
  return originals;
}

it.each([false, true])('materializes distinct sister/Flash portraits and boards with actual bound pixels (packaged=%s)', async packaged => {
  const f = await fixture(packaged), originals = await builtins(f, packaged), result = await f.prepare();
  expect(result.visualInputs).toHaveLength(4);
  for (const profile of result.publicProfiles) for (const role of ['avatar', 'orthographic'] as const) {
    const saved = profile[role]!, bytes = originals.get(profile.id.replace('deepseek-', '') + '/' + role)!;
    expect(saved).toMatchObject({ available: true, mime: 'image/png', sha256: sha(bytes) });
    expect(path.isAbsolute(saved.absolutePath)).toBe(true); expect(saved.absolutePath).not.toContain('app.asar'); expect(await realpath(saved.absolutePath)).toBe(saved.absolutePath);
    expect(await readFile(saved.absolutePath)).toEqual(bytes);
    const pixels = result.visualInputs.find(item => item.personId === profile.id && item.role === role)!;
    const normalized = Buffer.from(pixels.base64, 'base64'); expect(normalized.length).toBeLessThanOrEqual(1024 * 1024); expect(pixels.sha256).toBe(sha(normalized));
    expect(await sharp(normalized).metadata()).toMatchObject({ format: 'jpeg', width: role === 'orthographic' ? 192 : 64, height: 64 });
  }
  expect(f.commands.every(command => command.type === 'state')).toBe(true);
});
it('binds the default board to the stable built-in identity independently of its chosen avatar', async () => {
  const f = await fixture(), originals = await builtins(f), owner = f.companions[0]!;
  owner.avatar = 'custom';
  const customAvatar = await f.prepare(), profile = customAvatar.publicProfiles.find(person => person.id === owner.id)!;
  expect(profile.avatar).toBeUndefined(); expect(profile.orthographic?.sha256).toBe(sha(originals.get('sister/orthographic')!));
  owner.builtin = false; owner.avatar = 'sister';
  expect((await f.prepare()).publicProfiles.find(person => person.id === owner.id)?.orthographic).toBeUndefined();
});
it('keeps both imported overrides authoritative and restores built-ins only after explicit removal', async () => {
  const f = await fixture(), originals = await builtins(f), owner = f.companions[0]!;
  for (const [id, color] of [['personal-avatar', '#ee11cc'], ['personal-board', '#11ccee']] as const) {
    const relativePath = 'attachments/' + id + '.png', bytes = await image(path.join(f.managed, relativePath), color, id.endsWith('board'));
    f.attachments.set(id, { attachment: { id, name: id + '.png', mime: 'image/png', size: bytes.length }, relativePath });
  }
  owner.avatarAttachmentId = 'personal-avatar'; owner.appearanceAttachmentId = 'personal-board';
  const first = (await f.prepare()).publicProfiles[0]!;
  expect(first.avatar!.absolutePath).toContain('personal-avatar.png'); expect(first.orthographic!.absolutePath).toContain('personal-board.png');
  await unlink(first.orthographic!.absolutePath);
  const missing = (await f.prepare()).publicProfiles[0]!; expect(missing.orthographic).toMatchObject({ absolutePath: first.orthographic!.absolutePath, available: false });
  expect(owner.appearanceAttachmentId).toBe('personal-board');
  delete owner.avatarAttachmentId; delete owner.appearanceAttachmentId;
  const restored = (await f.prepare()).publicProfiles[0]!;
  expect(restored.avatar!.sha256).toBe(sha(originals.get('sister/avatar')!)); expect(restored.orthographic!.sha256).toBe(sha(originals.get('sister/orthographic')!));
  await unlink(restored.orthographic!.absolutePath);
  expect((await f.prepare()).publicProfiles[0]!.orthographic!.sha256).toBe(restored.orthographic!.sha256);
});
it('does not substitute an obsolete sheet when a new built-in portrait or board is unavailable', async () => {
  const f = await fixture(); await image(path.join(f.appPath, 'assets/companions/deepseek-sister.jpg'), '#ccaa44');
  const result = await f.prepare(); expect(result.visualInputs).toEqual([]);
  expect(result.publicProfiles.every(profile => !profile.avatar && !profile.orthographic)).toBe(true);
});
