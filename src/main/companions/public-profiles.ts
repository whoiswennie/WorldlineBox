import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Companion, CompanionConversation } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse, StoredCompanionAttachment } from '../../shared/companion-storage';
import type { CompanionProfileInput, CompanionPublicImage, CompanionPublicProfile, CompanionVisualInput } from '../../shared/companion-public-profile';
import { CompanionAssetProfileStore } from './asset-profile';
import { COMPANION_APPEARANCE_FILES, COMPANION_PORTRAIT_FILES } from '../../shared/companion-portrait-files';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VISUAL_BYTES = 1024 * 1024;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Resolve only host-owned portrait IDs, and keep pixels out of durable chat checkpoints. */
export class CompanionPublicProfiles {
  private readonly portraits = new Map<string, Promise<string | undefined>>();
  private readonly assetProfiles?: CompanionAssetProfileStore;
  private readonly imageChecks = new Map<string, Promise<boolean>>();
  private readonly visuals = new Map<string, Promise<{ base64: string; sha256: string; originalHash: string } | undefined>>();
  constructor(private readonly options: { root: string; appPath: string; libraryDirectory?: string; profileStore?: CompanionAssetProfileStore;
    portraitInitialized?(ownerId: string, role: 'avatar' | 'orthographic'): Promise<boolean>;
    markPortraitInitialized?(ownerId: string, role: 'avatar' | 'orthographic'): Promise<void>;
    request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> }) {
    this.assetProfiles = options.profileStore ?? (options.libraryDirectory ? new CompanionAssetProfileStore(options.libraryDirectory) : undefined);
  }

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

  /** Explicit human profile edits may choose a new image or restore a template.
   * This factory is never called merely because a runtime file disappeared. */
  async applyImageSelection(previous: Companion | undefined, current: Companion): Promise<void> {
    if (!this.assetProfiles) return;
    for (const role of ['avatar', 'orthographic'] as const) {
      const selected = role === 'avatar' ? current.avatarAttachmentId : current.appearanceAttachmentId;
      const old = role === 'avatar' ? previous?.avatarAttachmentId : previous?.appearanceAttachmentId;
      if (selected && selected !== old) {
        const image = await this.attachment(selected, current, role, true);
        if (!image?.available) throw new Error('所选形象尚未成功写入此伙伴目录，请核对原始受管图片。');
      } else if (!selected && (role === 'avatar' ? current.avatar !== 'custom' && (current.avatar !== previous?.avatar || !!old) : current.builtin && !!old)) {
        const file = role === 'avatar' && current.avatar !== 'custom' ? COMPANION_PORTRAIT_FILES[current.avatar] : COMPANION_APPEARANCE_FILES[current.id];
        if (!file) continue;
        this.portraits.delete(current.id + '/' + role);
        await this.materializePortrait(current, role, file, true);
      }
    }
  }

  async prepare(input: { companionId: string; conversation: Pick<CompanionConversation, 'id' | 'memberIds'>;
    sourceAuthorId?: string; audience?: 'player' | 'peers'; directory?: boolean }): Promise<CompanionProfileInput> {
    const state = (await this.options.request({ type: 'state', includeHidden: true })).state;
    if (!state) return { publicProfiles: [], visualInputs: [] };
    const room = state.conversations.find(item => item.id === input.conversation.id);
    const memberIds = room?.memberIds ?? input.conversation.memberIds;
    if (!memberIds.includes(input.companionId)) return { publicProfiles: [], visualInputs: [] };
    const members = (await Promise.all(state.companions.filter(item => input.directory || memberIds.includes(item.id)).map(async member => {
      if (!this.assetProfiles) return member;
      try { return this.assetProfiles.hydrateProfileFromSnapshot(member, await this.assetProfiles.bootstrapProfile(member)); }
      catch (error) {
        if (member.id === input.companionId) throw error;
        // A damaged peer asset namespace must not stop a healthy resident.
        // Omit the unavailable public card instead of reviving its DB copy.
        return undefined;
      }
    }))).filter((member): member is Companion => member !== undefined);
    const publicProfiles: CompanionPublicProfile[] = [];
    if (input.audience !== 'peers') {
      const player = state.playerProfile ?? (await this.options.request({ type: 'player.profile.get' })).playerProfile;
      if (player) publicProfiles.push({ id: 'user', kind: 'human_player', name: player.name, description: player.description,
        revision: player.revision, avatar: await this.attachment(player.avatarAttachmentId), orthographic: await this.attachment(player.appearanceAttachmentId) });
    }
    for (const member of members) publicProfiles.push({ id: member.id, kind: 'companion', name: member.name,
      description: member.description, revision: member.revision,
      avatar: member.avatarAttachmentId ? await this.attachment(member.avatarAttachmentId, member, 'avatar') : await this.builtinImage(member),
      orthographic: member.appearanceAttachmentId ? await this.attachment(member.appearanceAttachmentId, member, 'orthographic') : await this.builtinImage(member, 'orthographic') });
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

  private async attachment(id?: string, owner?: Companion, role: 'avatar' | 'orthographic' = 'avatar', explicitSelection = false): Promise<CompanionPublicImage | undefined> {
    if (!id) return undefined;
    const stored = (await this.options.request({ type: 'attachment.get', id })).storedAttachment;
    if (!stored || !/^image\/(?:png|jpeg|webp|gif)$/u.test(stored.attachment.mime)) return undefined;
    const candidate = owner && this.assetProfiles ? path.resolve(this.assetProfiles.libraryDirectory, owner.id, '形象', role + '.png')
      : path.resolve(this.options.root, stored.relativePath);
    try { const absolutePath = owner && this.assetProfiles ? await this.materializeAttachment(owner, role, stored, explicitSelection) : await this.managedFile(stored);
      return { absolutePath, mime: stored.attachment.mime, available: await this.readableImage(absolutePath) }; }
    catch { return { absolutePath: candidate, mime: stored.attachment.mime, available: false }; }
  }
  private async materializeAttachment(owner: Companion, role: 'avatar' | 'orthographic', stored: StoredCompanionAttachment, explicitSelection: boolean): Promise<string> {
    if (stored.sourcePath) throw new Error('Public portraits must be managed copies.');
    const snapshot = await this.assetProfiles!.bootstrapProfile(owner), selected = role === 'avatar' ? snapshot.profile.avatarAttachmentId : snapshot.profile.appearanceAttachmentId;
    if (selected !== stored.attachment.id) throw new Error('The selected owner portrait changed.');
    const initialized = !explicitSelection && await this.options.portraitInitialized?.(owner.id, role) === true;
    this.portraits.delete(owner.id + '/' + role);
    const directory = path.join(snapshot.root, '形象'); if (!initialized) await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(await realpath(directory)) !== await realpath(snapshot.root)) throw new Error('Invalid portrait directory.');
    const receipt = path.join(directory, '.' + role + '-initialized.json');
    if (!explicitSelection) try {
      const stat = await lstat(receipt);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 4096) throw new Error('Invalid portrait receipt.');
      const proof = JSON.parse(await readFile(receipt, 'utf8')) as { companionId?: string; role?: string; attachmentId?: string; path?: string };
      if (proof.companionId !== owner.id || proof.role !== role) throw new Error('Invalid portrait owner.');
      if (proof.attachmentId === stored.attachment.id) {
        if (!proof.path || !new RegExp('^' + role + '\\.(?:png|jpg|webp|gif)$', 'u').test(proof.path)) throw new Error('Invalid portrait path.');
        if (!initialized) await this.options.markPortraitInitialized?.(owner.id, role);
        return path.join(directory, proof.path);
      }
      throw new Error('A different portrait was already initialized; an explicit image selection is required.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (initialized) throw new Error('The initialized owner portrait receipt is missing; no source copy will be restored.');
    const source = await this.managedFile(stored), bytes = await readFile(source);
    const metadata = await sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
    if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format)) throw new Error('Invalid selected portrait.');
    const name = role + '.' + (metadata.format === 'jpeg' ? 'jpg' : metadata.format), destination = path.join(directory, name), temporary = destination + '.' + randomUUID() + '.tmp';
    const manifestTemporary = receipt + '.' + randomUUID() + '.tmp';
    try {
      try { const current = await lstat(destination); if (!current.isFile() || current.isSymbolicLink() || current.nlink > 1) throw new Error('Invalid portrait destination.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { const current = await lstat(receipt); if (!current.isFile() || current.isSymbolicLink() || current.nlink > 1) throw new Error('Invalid portrait receipt.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await writeFile(temporary, bytes, { flag: 'wx' });
      await writeFile(manifestTemporary, JSON.stringify({ companionId: owner.id, role, path: name, attachmentId: stored.attachment.id,
        initialChecksum: sha(bytes), initializedAt: new Date().toISOString() }), { flag: 'wx' });
      // A newer explicit file selection wins over this older read.
      const current = await this.assetProfiles!.loadProfile(owner.id);
      if ((role === 'avatar' ? current.profile.avatarAttachmentId : current.profile.appearanceAttachmentId) !== stored.attachment.id) throw new Error('Portrait selection changed during publication.');
      await rename(temporary, destination); await rename(manifestTemporary, receipt);
      await this.options.markPortraitInitialized?.(owner.id, role); return destination;
    } finally { await Promise.all([temporary, manifestTemporary].map(file => unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }))); }
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
    if (!this.assetProfiles) return undefined;
    const key = companion.id + '/' + role;
    let pending = this.portraits.get(key);
    if (!pending) { pending = this.materializePortrait(companion, role, file).catch(() => undefined); this.portraits.set(key, pending); }
    const absolutePath = await pending;
    if (!absolutePath) this.portraits.delete(key);
    return absolutePath ? { absolutePath, mime: 'image/png', available: await this.readableImage(absolutePath) } : undefined;
  }
  private async fileSignature(file: string): Promise<string> {
    try { const info = await lstat(file); return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= MAX_IMAGE_BYTES ? [info.size, info.mtimeMs, info.ctimeMs].join(':') : ''; }
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
  private async materializePortrait(companion: Companion, role: 'avatar' | 'orthographic', file: string, explicitSelection = false): Promise<string | undefined> {
    const profile = await this.assetProfiles!.bootstrapProfile(companion), owner = profile.root;
    const initialized = !explicitSelection && await this.options.portraitInitialized?.(companion.id, role) === true;
    const root = path.join(owner, '形象');
    if (!initialized) try { await mkdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const directory = await lstat(root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || path.dirname(await realpath(root)) !== await realpath(owner)) throw new Error('Invalid owner portrait directory.');
    const destination = path.join(root, role + '.png'), receipt = path.join(root, '.' + role + '-initialized.json');
    if (!explicitSelection) try {
      const marker = await lstat(receipt);
      if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink > 1 || marker.size > 4096) throw new Error('Invalid portrait initialization receipt.');
      const proof = JSON.parse(await readFile(receipt, 'utf8')) as { companionId?: string; role?: string; attachmentId?: string };
      if (proof.companionId !== companion.id || proof.role !== role) throw new Error('Invalid portrait owner receipt.');
      if (!initialized) await this.options.markPortraitInitialized?.(companion.id, role);
      if (proof.attachmentId) return undefined;
      // Initialization is final: deletion or edits are never repaired from a
      // compiled portrait, including after an application restart.
      return destination;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (initialized) throw new Error('The initialized owner portrait receipt is missing; no built-in image will be restored.');
    if (!explicitSelection) try {
      const present = await lstat(destination);
      if (!present.isFile() || present.isSymbolicLink() || present.nlink > 1 || present.size > MAX_IMAGE_BYTES) throw new Error('Invalid authored portrait.');
      await writeFile(receipt, JSON.stringify({ companionId: companion.id, role, source: 'existing_owner_asset', initializedAt: new Date().toISOString() }), { flag: 'wx' });
      await this.options.markPortraitInitialized?.(companion.id, role);
      return destination;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
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
    const bytes = await readFile(source);
    await sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
    // A new owner receives a physical file once; runtime pixels thereafter
    // always come from this exact, user-editable owner-local asset.
    if (explicitSelection) {
      try { const existing = await lstat(destination); if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1) throw new Error('Invalid portrait destination.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { const existing = await lstat(receipt); if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1) throw new Error('Invalid portrait receipt.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const temporary = destination + '.' + randomUUID() + '.tmp', receiptTemporary = receipt + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, bytes, { flag: 'wx' });
        await writeFile(receiptTemporary, JSON.stringify({ companionId: companion.id, role, source: file, initializedAt: new Date().toISOString() }), { flag: 'wx' });
        await rename(temporary, destination); await rename(receiptTemporary, receipt);
      } finally { await Promise.all([temporary, receiptTemporary].map(file => unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }))); }
    } else {
      await writeFile(destination, bytes, { flag: 'wx' });
      await writeFile(receipt, JSON.stringify({ companionId: companion.id, role, source: file, initializedAt: new Date().toISOString() }), { flag: 'wx' });
    }
    await this.options.markPortraitInitialized?.(companion.id, role);
    return destination;
  }
  private async visual(image: CompanionPublicImage, role: CompanionVisualInput['role']) {
    try {
      const info = await lstat(image.absolutePath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > MAX_IMAGE_BYTES) return undefined;
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
