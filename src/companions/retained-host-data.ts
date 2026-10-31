import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { playerProfileSchema, type PlayerProfile } from '../shared/companion-profile';
import type { CompanionConnection } from './store';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), digest = z.string().regex(/^[a-f0-9]{64}$/u);
const publicAttachment = z.strictObject({ id, name: z.string().max(240), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), size: z.number().int().positive().max(20 * 1024 * 1024) });
const fileProof = z.strictObject({ path: z.string(), root: z.string(), size: z.number().int().nonnegative(), sha256: digest, device: z.number(), inode: z.number(), modified: z.number(), changed: z.number() });
const retainedAttachmentSchema = z.strictObject({ id, relativePath: z.string().regex(/^attachments\/[a-zA-Z0-9_-]{1,100}\.(?:png|jpe?g|webp)$/iu), attachment: publicAttachment, file: fileProof });
const manifestSchema = z.strictObject({ schema: z.literal('worldlinebox.retained-host-data-v3'), cleanupPlanHash: digest,
  libraryId: z.string().min(1), libraryPath: z.string(), dataRoot: z.string(), playerProfile: playerProfileSchema.nullable(),
  attachments: z.array(retainedAttachmentSchema).max(2) });
const checksum = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Validate the current store fingerprint before old data can be removed and
 * again before importing the exact retained human image references. */
export function validateRetainedPlayerProfile(input: unknown, images: unknown): PlayerProfile | null {
  const profile = playerProfileSchema.nullable().parse(input), attachments = z.array(retainedAttachmentSchema).max(2).parse(images);
  const wanted = new Set([profile?.avatarAttachmentId, profile?.appearanceAttachmentId].filter((value): value is string => !!value));
  if (attachments.length !== wanted.size || attachments.some(item => !wanted.has(item.id) || item.attachment.id !== item.id)) throw new Error('Retained attachments must belong only to the actual human profile.');
  if (!profile) return null;
  const image = (attachmentId?: string) => {
    if (!attachmentId) return undefined;
    const retained = attachments.filter(item => item.id === attachmentId);
    if (retained.length !== 1) throw new Error('Retained human profile image is missing or duplicated.');
    const item = retained[0]!;
    return { id: attachmentId, mime: item.attachment.mime, size: item.attachment.size, relativePath: item.relativePath };
  };
  if (checksum(JSON.stringify({ id: 'user', name: profile.name, description: profile.description,
    avatar: image(profile.avatarAttachmentId), appearance: image(profile.appearanceAttachmentId) })) !== profile.contentHash)
    throw new Error('Human profile content hash is invalid.');
  return profile;
}
function fileAt(root: string, relative: string): { bytes: Buffer; file: string } {
  if (!path.isAbsolute(root) || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/u).some(part => part === '..' || part === '.')) throw new Error('Human preference path is outside the fixed host scope.');
  let current = root;
  for (const part of relative.split(/[\\/]/u).slice(0, -1)) { current = path.join(current, part); const info = lstatSync(current); if (!info.isDirectory() || info.isSymbolicLink() || path.relative(current, realpathSync(current))) throw new Error('Human preference directory was replaced by a link.'); }
  const file = path.join(root, relative), before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 20 * 1024 * 1024 || path.relative(file, realpathSync(file))) throw new Error('Human preference file is linked, unavailable or oversized.');
  const bytes = readFileSync(file), after = lstatSync(file);
  if ([before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join(':') !== [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':')) throw new Error('Human preference file changed during import.');
  return { bytes, file };
}

/** One-time, new-protocol import of human public preferences. No SQL/schema,
 * model allowance, role content, permissions or keys are imported. */
export function importCompanionRetainedHostData(db: CompanionConnection, options: { dataRoot: string; libraryPath: string; libraryId: string }): { imported: boolean } {
  const receiptKey = 'host-retained-data-import/v3';
  if (db.prepare('SELECT 1 FROM metadata WHERE key=?').get(receiptKey)) return { imported: false };
  const root = realpathSync(options.dataRoot);
  if (path.relative(root, options.dataRoot) || path.relative(path.join(options.libraryPath, '.worldlinebox', 'companions'), root)) throw new Error('Human preference import is outside the selected companion storage.');
  const source = 'development-cleanup/retained-host-data.json'; let bytes: Buffer;
  try { bytes = fileAt(root, source).bytes; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { imported: false }; throw error; }
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (manifest.libraryId !== options.libraryId || path.relative(manifest.libraryPath, options.libraryPath) || path.relative(manifest.dataRoot, root)) throw new Error('Human preference manifest belongs to another selected library.');
  const protocol = db.prepare('SELECT protocol FROM companion_cognition_protocol WHERE singleton=1').get() as { protocol: string } | undefined;
  if (protocol?.protocol !== 'worldlinebox.companion-cognition-v2' || (db.prepare('SELECT COUNT(*) n FROM companions').get() as { n: number }).n) throw new Error('Human preferences may only initialize a fresh new-protocol database without companion identities.');
  const cleanup = JSON.parse(fileAt(root, 'development-cleanup/' + manifest.cleanupPlanHash + '.json').bytes.toString('utf8')) as { planHash?: string; phase?: string };
  if (cleanup.planHash !== manifest.cleanupPlanHash || cleanup.phase !== 'completed') throw new Error('The reviewed development cleanup has not completed.');
  const profile = validateRetainedPlayerProfile(manifest.playerProfile, manifest.attachments);
  if (profile) {
    const existing = db.prepare("SELECT data FROM player_profile WHERE id='user'").get() as { data: string } | undefined;
    if (existing) { const current = playerProfileSchema.parse(JSON.parse(existing.data)); if (current.revision !== 1 || current.name !== '我' || current.description || current.avatarAttachmentId || current.appearanceAttachmentId) throw new Error('Fresh human preferences were already edited; import will not overwrite them.'); }
  }
  for (const item of manifest.attachments) {
    const actual = fileAt(root, item.relativePath);
    if (item.file.path !== actual.file || item.file.root !== root || actual.bytes.length !== item.attachment.size || actual.bytes.length !== item.file.size || checksum(actual.bytes) !== item.file.sha256) throw new Error('Retained human image path, size or bytes changed.');
    const png = actual.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), jpeg = actual.bytes[0] === 255 && actual.bytes[1] === 216 && actual.bytes[2] === 255,
      webp = actual.bytes.toString('ascii', 0, 4) === 'RIFF' && actual.bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!(item.attachment.mime === 'image/png' && png || item.attachment.mime === 'image/jpeg' && jpeg || item.attachment.mime === 'image/webp' && webp)) throw new Error('Retained attachment is not the declared human image format.');
  }
  db.exec('SAVEPOINT import_retained_human_preferences');
  try {
    for (const item of manifest.attachments) db.prepare('INSERT INTO attachments(id,data,relative_path) VALUES(?,?,?)').run(item.id, JSON.stringify(item.attachment), item.relativePath);
    if (profile) db.prepare("INSERT OR REPLACE INTO player_profile(id,revision,data) VALUES('user',?,?)").run(profile.revision, JSON.stringify(profile));
    db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(receiptKey, JSON.stringify({ manifestHash: checksum(bytes), cleanupPlanHash: manifest.cleanupPlanHash }));
    db.exec('RELEASE import_retained_human_preferences'); return { imported: true };
  } catch (error) { db.exec('ROLLBACK TO import_retained_human_preferences; RELEASE import_retained_human_preferences'); throw error; }
}
