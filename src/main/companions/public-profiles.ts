import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Companion, CompanionConversation } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse, StoredCompanionAttachment } from '../../shared/companion-storage';
import type { CompanionProfileInput, CompanionPublicImage, CompanionPublicProfile, CompanionVisualInput } from '../../shared/companion-public-profile';
import { COMPANION_APPEARANCE_FILES, COMPANION_PORTRAIT_FILES } from '../../shared/companion-portrait-files';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VISUAL_BYTES = 1024 * 1024;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Resolve only host-owned portrait IDs, and keep pixels out of durable chat checkpoints. */
export class CompanionPublicProfiles {
  private readonly portraits = new Map<string, Promise<string | undefined>>();
  private readonly portraitStats = new Map<string, string>();
  private readonly imageChecks = new Map<string, Promise<boolean>>();
  private readonly visuals = new Map<string, Promise<{ base64: string; sha256: string; originalHash: string } | undefined>>();
  constructor(private readonly options: { root: string; appPath: string;
    request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> }) {}

  async validateImage(id?: string): Promise<void> {
    if (!id) return;
    try {
      const stored = (await this.options.request({ type: 'attachment.get', id })).storedAttachment;
      if (!stored || !/^image\/(?:png|jpeg|webp|gif)$/u.test(stored.attachment.mime)) throw new Error();
      const file = await this.managedFile(stored);
      const info = await sharp(file, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
      if (!info.width || !info.height || !['png', 'jpeg', 'webp', 'gif'].includes(info.format)) throw new Error();
    } catch { throw new Error('形象资料需要使用已导入且可读取的 PNG、JPEG、WebP 或 GIF 图片。'); }
  }

  async prepare(input: { companionId: string; conversation: Pick<CompanionConversation, 'id' | 'memberIds'>;
    sourceAuthorId?: string; audience?: 'player' | 'peers'; directory?: boolean }): Promise<CompanionProfileInput> {
    const state = (await this.options.request({ type: 'state', includeHidden: true })).state;
    if (!state) return { publicProfiles: [], visualInputs: [] };
    const room = state.conversations.find(item => item.id === input.conversation.id);
    const memberIds = room?.memberIds ?? input.conversation.memberIds;
    if (!memberIds.includes(input.companionId)) return { publicProfiles: [], visualInputs: [] };
    const members = state.companions.filter(item => input.directory || memberIds.includes(item.id));
    const publicProfiles: CompanionPublicProfile[] = [];
    if (input.audience !== 'peers') {
      const player = state.playerProfile ?? (await this.options.request({ type: 'player.profile.get' })).playerProfile;
      if (player) publicProfiles.push({ id: 'user', kind: 'human_player', name: player.name, description: player.description,
        revision: player.revision, avatar: await this.attachment(player.avatarAttachmentId), orthographic: await this.attachment(player.appearanceAttachmentId) });
    }
    for (const member of members) publicProfiles.push({ id: member.id, kind: 'companion', name: member.name,
      description: member.description, revision: member.revision,
      avatar: member.avatarAttachmentId ? await this.attachment(member.avatarAttachmentId) : await this.builtinImage(member),
      orthographic: member.appearanceAttachmentId ? await this.attachment(member.appearanceAttachmentId) : await this.builtinImage(member, 'orthographic') });
    // Every actual member's public setting is known. Pixels concentrate on the
    // two current speakers, with the standard three-view board taking priority.
    const currentIds = new Set([input.companionId, input.sourceAuthorId].filter(Boolean));
    const visualInputs: CompanionVisualInput[] = [];
    for (const role of ['orthographic', 'avatar'] as const) for (const profile of publicProfiles) {
      const image = profile[role];
      if (!currentIds.has(profile.id) || !image?.available || visualInputs.length >= 4) continue;
      const pixels = await this.visual(image, role);
      if (pixels) visualInputs.push({ personId: profile.id, role, mime: 'image/jpeg', ...pixels });
      else image.available = false;
    }
    return { publicProfiles, visualInputs };
  }

  private async attachment(id?: string): Promise<CompanionPublicImage | undefined> {
    if (!id) return undefined;
    const stored = (await this.options.request({ type: 'attachment.get', id })).storedAttachment;
    if (!stored || !/^image\/(?:png|jpeg|webp|gif)$/u.test(stored.attachment.mime)) return undefined;
    const candidate = path.resolve(this.options.root, stored.relativePath);
    try { const absolutePath = await this.managedFile(stored); return { absolutePath, mime: stored.attachment.mime, available: await this.readableImage(absolutePath) }; }
    catch { return { absolutePath: candidate, mime: stored.attachment.mime, available: false }; }
  }
  private async managedFile(stored: StoredCompanionAttachment): Promise<string> {
    // Profile picks are immutable managed copies, including picks made before
    // this feature. A message's linked source is never a public profile file.
    if (stored.sourcePath) throw new Error('Public portraits must be managed copies.');
    const root = await realpath(this.options.root), absolute = await realpath(path.resolve(root, stored.relativePath));
    const relative = path.relative(root, absolute);
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('Invalid portrait location.');
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('Invalid portrait file.');
    return absolute;
  }
  private async builtinImage(companion: Companion, role: 'avatar' | 'orthographic' = 'avatar'): Promise<CompanionPublicImage | undefined> {
    const file = role === 'orthographic' ? companion.builtin ? COMPANION_APPEARANCE_FILES[companion.id] : undefined
      : companion.avatar !== 'custom' ? COMPANION_PORTRAIT_FILES[companion.avatar] : undefined;
    if (!file) return undefined;
    let pending = this.portraits.get(file);
    if (!pending) { pending = this.materializePortrait(file).catch(() => undefined); this.portraits.set(file, pending); }
    let absolutePath = await pending;
    if (!absolutePath) this.portraits.delete(file);
    if (absolutePath) {
      const signature = await this.fileSignature(absolutePath);
      const previous = this.portraitStats.get(file);
      if (!signature || previous && previous !== signature) {
        const replacement = this.materializePortrait(file).catch(() => undefined); this.portraits.set(file, replacement);
        absolutePath = await replacement;
      }
      if (absolutePath) this.portraitStats.set(file, await this.fileSignature(absolutePath));
    }
    return absolutePath ? { absolutePath, mime: file.endsWith('.jpg') ? 'image/jpeg' : 'image/png', available: await this.readableImage(absolutePath) } : undefined;
  }
  private async fileSignature(file: string): Promise<string> {
    try { const info = await lstat(file); return info.isFile() ? [info.size, info.mtimeMs, info.ctimeMs].join(':') : ''; }
    catch { return ''; }
  }
  private async readableImage(file: string): Promise<boolean> {
    const signature = await this.fileSignature(file); if (!signature) return false;
    const key = file + '\0' + signature;
    let checked = this.imageChecks.get(key);
    if (!checked) {
      checked = sharp(file, { limitInputPixels: 64 * 1024 * 1024 }).metadata()
        .then(info => !!info.width && !!info.height && ['png', 'jpeg', 'webp', 'gif'].includes(info.format)).catch(() => false);
      this.imageChecks.set(key, checked);
      while (this.imageChecks.size > 64) this.imageChecks.delete(this.imageChecks.keys().next().value!);
    }
    return checked;
  }
  private async materializePortrait(file: string): Promise<string | undefined> {
    let source = path.join(this.options.appPath, file);
    try { await lstat(source); }
    catch {
      const assets = path.join(this.options.appPath, '.vite', 'renderer', 'main_window', 'assets');
      const extension = path.extname(file), base = path.basename(file, extension);
      const publicFiles = [...Object.values(COMPANION_PORTRAIT_FILES), ...Object.values(COMPANION_APPEARANCE_FILES)].filter((candidate): candidate is string => !!candidate);
      const longerStems = publicFiles.filter(candidate => path.extname(candidate) === extension)
        .map(candidate => path.basename(candidate, extension)).filter(candidate => candidate.startsWith(base + '-'));
      const emitted = (await readdir(assets).catch(() => [] as string[])).filter(name => name.startsWith(base + '-') && name.endsWith(extension)
        && !longerStems.some(stem => name.startsWith(stem + '-')));
      if (emitted.length !== 1) return undefined;
      source = path.join(assets, emitted[0]!);
    }
    const info = await lstat(source); if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return undefined;
    const bytes = await readFile(source), root = path.join(this.options.root, 'portraits');
    await mkdir(root, { recursive: true });
    const destination = path.join(root, sha(bytes) + path.extname(file));
    // External tools cannot read app.asar members. Always expose a materialized
    // operating-system file, rather than an Electron-only virtual archive path.
    try { const present = await readFile(destination); if (sha(present) === sha(bytes)) return await realpath(destination); } catch { /* First materialization. */ }
    const temporary = destination + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, bytes); await rename(temporary, destination); }
    finally { await unlink(temporary).catch(() => undefined); }
    return realpath(destination);
  }
  private async visual(image: CompanionPublicImage, role: CompanionVisualInput['role']) {
    try {
      const info = await lstat(image.absolutePath);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return undefined;
      const key = [image.absolutePath, info.size, info.mtimeMs, info.ctimeMs, role].join('\0');
      let pending = this.visuals.get(key);
      if (!pending) {
        pending = (async () => {
          const original = await readFile(image.absolutePath), originalHash = sha(original);
          image.sha256 = originalHash;
          const pixels = sharp(original, { limitInputPixels: 64 * 1024 * 1024, animated: false }).rotate().flatten({ background: '#ffffff' });
          let output = await pixels.resize({ width: role === 'orthographic' ? 1536 : 512, height: role === 'orthographic' ? 1536 : 512, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
          if (output.length > MAX_VISUAL_BYTES) output = await sharp(output).resize({ width: 1280, height: 1280, fit: 'inside' }).jpeg({ quality: 74 }).toBuffer();
          if (output.length > MAX_VISUAL_BYTES) return undefined;
          return { base64: output.toString('base64'), sha256: sha(output), originalHash };
        })().catch(() => undefined);
        this.visuals.set(key, pending);
        while (this.visuals.size > 32) this.visuals.delete(this.visuals.keys().next().value!);
      }
      const result = await pending;
      if (result) { image.sha256 = result.originalHash; return { base64: result.base64, sha256: result.sha256 }; }
    } catch { image.available = false; }
    return undefined;
  }
}
