import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Companion, CompanionAssetImages, CompanionConversation } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse, StoredCompanionAttachment } from '../../shared/companion-storage';
import type { CompanionProfileInput, CompanionPublicImage, CompanionPublicProfile, CompanionVisualInput } from '../../shared/companion-public-profile';
import { CompanionAssetProfileStore } from './asset-profile';
import { COMPANION_APPEARANCE_FILES, COMPANION_PORTRAIT_FILES } from '../../shared/companion-portrait-files';
import { builtinCompanionId } from '../../shared/companion-personas';
import { COMPANION_TEMPLATE_IDS } from '../../shared/companion-template-ids';
import { createCompanionExecutionValidationSession, memoCompanionExecutionAdmission } from './source-execution-evidence';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VISUAL_BYTES = 1024 * 1024;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const boardFile = (owner: Pick<Companion, 'id' | 'templateId'>) => {
  const template = owner.templateId;
  const id = template && COMPANION_TEMPLATE_IDS.includes(template as typeof COMPANION_TEMPLATE_IDS[number])
    ? builtinCompanionId(template as typeof COMPANION_TEMPLATE_IDS[number]) : template ?? owner.id;
  return COMPANION_APPEARANCE_FILES[id];
};
type PortraitRole = 'avatar' | 'orthographic';
type RuntimeImageSelection = Pick<Companion, 'id' | 'avatar' | 'templateId' | 'avatarAttachmentId' | 'appearanceAttachmentId'>;
type PresentationOwnerProfile = { companionId: string; root: string };
type PublicProfilePrepareInput = { companionId: string; conversation: Pick<CompanionConversation, 'id' | 'memberIds'>;
  sourceAuthorId?: string; audience?: 'player' | 'peers'; directory?: boolean; taskKey?: string };
interface PublicPresentation { value: CompanionProfileInput; binding: string; cacheable: boolean }
export interface CompanionOwnerImage { bytes: Buffer; mime: string; sha256: string; fileRevision: string }
const imageStamp = (info: Awaited<ReturnType<typeof lstat>>) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');

/** Resolve only host-owned portrait IDs, and keep pixels out of durable chat checkpoints. */
export class CompanionPublicProfiles {
  private materializations = 0;
  private readonly portraits = new Map<string, Promise<string | undefined>>();
  private readonly assetProfiles?: CompanionAssetProfileStore;
  private readonly imageChecks = new Map<string, Promise<boolean>>();
  // Metadata only: one current signature per owner/role. The bound covers
  // 1,000 residents with two images without retaining any decoded pixels.
  private readonly runtimeImageChecks = new Map<string, { signature: string; sha256: string; fileRevision: string; acknowledged?: boolean }>();
  private readonly visuals = new Map<string, Promise<{ base64: string; sha256: string; originalHash: string } | undefined>>();
  forgetOwner(owner: string): void {
    for (const role of ['avatar', 'orthographic']) { this.portraits.delete(owner + '/' + role); this.runtimeImageChecks.delete(owner + '/' + role); }
  }
  constructor(private readonly options: { root: string; appPath: string; libraryDirectory?: string; profileStore?: CompanionAssetProfileStore;
    portraitInitialized?(ownerId: string, role: 'avatar' | 'orthographic'): Promise<boolean>;
    markPortraitInitialized?(ownerId: string, role: 'avatar' | 'orthographic'): Promise<void>;
    /** Live SQL membership/configuration, without hydrating every owner's
     * canonical profile before prepare admits the actual room members. */
    readStateMetadata?(): Promise<CompanionStorageResponse['state']>;
    /** Current image selection only. Its SQL existence check must not hydrate
     * the canonical persona already admitted by the image/profile read. */
    readRuntimeSelection?(ownerId: string): Promise<RuntimeImageSelection>;
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
        const file = role === 'avatar' && current.avatar !== 'custom' ? COMPANION_PORTRAIT_FILES[current.avatar] : boardFile(current);
        if (!file) continue;
        this.portraits.delete(current.id + '/' + role);
        await this.materializePortrait(current, role, file, true);
      }
    }
  }

  /** Saved contacts expose only their editable owner copy. Template/source
   * materialization is a one-time factory guarded by the durable role receipt. */
  async runtimeImages(owner: Companion, options: { initialize?: boolean } = {}): Promise<CompanionAssetImages> {
    return this.runtimeImagesInPresentation(owner, options);
  }

  /** One finite display read admits the current role once. The private root
   * is used only while this gate is open; protocol image reads and the next
   * state refresh still enter independently and admit their current files. */
  async runtimePresentation(owner: Companion, options: { initialize?: boolean } = {}): Promise<Companion> {
    if (!this.assetProfiles) return { ...owner, assetImages: await this.runtimeImages(owner, options) };
    const gate = createCompanionExecutionValidationSession();
    try {
      const result = await gate.run(async () => {
        const snapshot = await (options.initialize === false ? this.assetProfiles!.loadProfile(owner.id) : this.assetProfiles!.bootstrapProfile(owner));
        const current = this.assetProfiles!.hydrateProfileFromSnapshot(owner, snapshot);
        const assetImages = await this.runtimeImagesInPresentation(current, options, { companionId: snapshot.companionId, root: snapshot.root });
        return { ...current, assetImages };
      });
      await gate.validate();
      return result;
    } finally { gate.close(); }
  }

  private async runtimeImagesInPresentation(owner: Companion, options: { initialize?: boolean }, admitted?: PresentationOwnerProfile): Promise<CompanionAssetImages> {
    if (!this.assetProfiles || owner.assetProfileError) return {};
    const images: CompanionAssetImages = {};
    for (const role of ['avatar', 'orthographic'] as const) {
      const key = owner.id + '/' + role;
      try {
        const selected = role === 'avatar' ? owner.avatarAttachmentId : owner.appearanceAttachmentId;
        if (!selected && (role === 'avatar' ? owner.avatar === 'custom' : !owner.builtin || !boardFile(owner))) { this.runtimeImageChecks.delete(key); continue; }
        let file;
        try { file = options.initialize === false ? await this.ownerImageFile(owner.id, role, admitted) : await this.runtimeOwnerImageFile(owner, role, admitted); }
        catch (error) {
          // A missing body/receipt after durable initialization is an empty
          // state. Only a genuinely new role may enter the copy factory.
          if (options.initialize === false || (error as NodeJS.ErrnoException).code !== 'ENOENT' || await this.options.portraitInitialized?.(owner.id, role)) throw error;
          const receipt = path.join(this.assetProfiles.libraryDirectory, owner.id, '形象', '.' + role + '-initialized.json');
          try { await lstat(receipt); throw new Error('The initialized owner image is missing.', { cause: error }); }
          catch (receiptError) { if ((receiptError as NodeJS.ErrnoException).code !== 'ENOENT') throw receiptError; }
          if (selected) {
            const stored = (await this.options.request({ type: 'attachment.get', id: selected })).storedAttachment;
            if (!stored || !/^image\/(?:png|jpeg|webp|gif)$/u.test(stored.attachment.mime)) throw new Error('Invalid initial owner image.', { cause: error });
            await this.materializeAttachment(owner, role, stored, false);
          } else {
            const initial = role === 'avatar' && owner.avatar !== 'custom' ? COMPANION_PORTRAIT_FILES[owner.avatar] : boardFile(owner);
            if (!initial) continue;
            await this.materializePortrait(owner, role, initial);
          }
          file = await this.ownerImageFile(owner.id, role);
        }
        if (!file) { this.runtimeImageChecks.delete(key); continue; }
        const signature = sha(Buffer.from([file.path, file.stamp, file.proof].join('\0')));
        let metadata = this.runtimeImageChecks.get(key);
        if (metadata?.signature !== signature) {
          const image = await (admitted ? this.readOwnerImageInPresentation(owner.id, role, admitted) : this.readOwnerImage(owner.id, role));
          if (!image) { this.runtimeImageChecks.delete(key); continue; }
          metadata = { signature: image.fileRevision, sha256: image.sha256, fileRevision: image.fileRevision, acknowledged: metadata?.acknowledged };
          this.runtimeImageChecks.set(key, metadata);
          while (this.runtimeImageChecks.size > 4096) this.runtimeImageChecks.delete(this.runtimeImageChecks.keys().next().value!);
        } else {
          this.runtimeImageChecks.delete(key); this.runtimeImageChecks.set(key, metadata);
        }
        // Reset reads serve current pixels without writing across the reset
        // barrier. A subsequent normal read acknowledges the new files once.
        if (options.initialize !== false && !metadata.acknowledged) {
          if (this.options.portraitInitialized && !await this.options.portraitInitialized(owner.id, role)) await this.options.markPortraitInitialized?.(owner.id, role);
          metadata.acknowledged = true;
        }
        // The filesystem revision also retries a restored identical image
        // after an earlier 404, without generating a timestamp per render.
        images[role] = { url: `worldlinebox-companion://portrait/${encodeURIComponent(owner.id)}/${role}?v=${metadata.sha256}&r=${metadata.fileRevision}`, sha256: metadata.sha256 };
      } catch { this.runtimeImageChecks.delete(key); /* Never cache an unavailable image or use its seed/source. */ }
    }
    return images;
  }

  private async runtimeOwnerImageFile(owner: Companion, role: PortraitRole, admitted?: PresentationOwnerProfile) {
    try { return await this.ownerImageFile(owner.id, role, admitted); }
    catch (error) {
      if ((error as { code?: string }).code !== 'MISSING') throw error;
      // Only the profile factory may decide whether this is a new owner.
      // A durable receipt makes missing profile/namespace strictly fail here.
      await this.assetProfiles!.bootstrapProfile(owner);
      return this.ownerImageFile(owner.id, role);
    }
  }

  private async runtimeSelection(ownerId: string): Promise<RuntimeImageSelection> {
    if (this.options.readRuntimeSelection) {
      const selected = await this.options.readRuntimeSelection(ownerId);
      if (selected.id !== ownerId) throw new Error('伙伴当前运行形象选择不可核验。');
      return selected;
    }
    const response = await this.options.request({ type: 'companion.assets.initialized', companionId: ownerId });
    if (!response.ok || !response.companion || response.companion.id !== ownerId) throw new Error('伙伴当前运行形象选择不可核验。');
    return response.companion;
  }
  private async ownerImageFile(ownerId: string, role: PortraitRole, admitted?: PresentationOwnerProfile): Promise<{ path: string; stamp: string; proof: string } | undefined> {
    if (!this.assetProfiles) return undefined;
    if (admitted && admitted.companionId !== ownerId) throw new Error('Portrait admission belongs to another owner.');
    const snapshot = admitted ?? await this.assetProfiles.loadProfile(ownerId), profile = await this.runtimeSelection(ownerId);
    const selected = role === 'avatar' ? profile.avatarAttachmentId : profile.appearanceAttachmentId;
    if (!selected && (role === 'avatar' ? profile.avatar === 'custom' : !boardFile(profile))) return undefined;
    const directory = path.join(snapshot.root, '形象'), actualOwner = await realpath(snapshot.root);
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || path.dirname(await realpath(directory)) !== actualOwner) throw new Error('Invalid owner portrait directory.');
    const receipt = path.join(directory, '.' + role + '-initialized.json'), before = await lstat(receipt);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4096) throw new Error('Invalid owner portrait receipt.');
    const text = await readFile(receipt, 'utf8'), after = await lstat(receipt);
    if (imageStamp(before) !== imageStamp(after)) throw new Error('Owner portrait receipt changed.');
    const proof = JSON.parse(text) as { companionId?: string; role?: string; attachmentId?: string; path?: string };
    if (proof.companionId !== ownerId || proof.role !== role || (proof.attachmentId ?? null) !== (selected ?? null)) throw new Error('Owner portrait selection changed.');
    const name = proof.path ?? role + '.png';
    if (!new RegExp('^' + role + '\\.(?:png|jpg|webp|gif)$', 'u').test(name)) throw new Error('Invalid owner portrait path.');
    const file = path.join(directory, name), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES
      || path.dirname(await realpath(file)) !== await realpath(directory)) throw new Error('Invalid owner portrait file.');
    // A current role must remain strictly readable, but a persona-only growth
    // publication is not a change to these selected pixels or their receipt.
    return { path: file, stamp: imageStamp(stat), proof: JSON.stringify([ownerId, role, selected ?? null,
      role === 'avatar' ? profile.avatar : profile.templateId ?? null, sha(Buffer.from(text))]) };
  }

  /** Protocol reads are fresh, bounded and never initialize or repair files. */
  async readOwnerImage(ownerId: string, role: PortraitRole): Promise<CompanionOwnerImage | undefined> {
    return this.readOwnerImageInPresentation(ownerId, role);
  }
  private async readOwnerImageInPresentation(ownerId: string, role: PortraitRole, admitted?: PresentationOwnerProfile): Promise<CompanionOwnerImage | undefined> {
    const file = await this.ownerImageFile(ownerId, role, admitted); if (!file) return undefined;
    const handle = await open(file.path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || imageStamp(stat) !== file.stamp) throw new Error('Owner portrait changed before read.');
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw new Error('Owner portrait truncated.'); offset += read.bytesRead; }
      const metadata = await sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
      if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format)) throw new Error('Invalid owner portrait pixels.');
      const current = await this.ownerImageFile(ownerId, role, admitted);
      if (!current || current.path !== file.path || current.stamp !== file.stamp || current.proof !== file.proof || imageStamp(await handle.stat()) !== file.stamp) throw new Error('Owner portrait changed during read.');
      return { bytes, mime: 'image/' + metadata.format, sha256: sha(bytes), fileRevision: sha(Buffer.from([file.path, file.stamp, file.proof].join('\0'))) };
    } finally { await handle.close(); }
  }

  async prepare(input: PublicProfilePrepareInput): Promise<CompanionProfileInput> {
    let admitted: PublicPresentation | undefined;
    const key = JSON.stringify([input.companionId, input.conversation.id, input.sourceAuthorId ?? null,
      input.audience ?? 'player', !!input.directory, input.taskKey ?? null]);
    return memoCompanionExecutionAdmission(key, { identity: this,
      read: async () => { admitted = await this.admitPresentation(input, false); return admitted.value; },
      cacheable: () => admitted?.cacheable === true,
      verify: async () => {
        const current = await this.admitPresentation(input, true);
        if (!admitted || current.binding !== admitted.binding) throw new Error('本轮公开资料、成员或所选形象已经变化，旧展示不可继续发送。');
      } });
  }
  /** Mutable current-role files belong to this finite display admission, not
   * the task's sealed persona. Its parent retains the actual public projection
   * and re-admits that exact projection, selection and pixels at its final fence. */
  private async admitPresentation(input: PublicProfilePrepareInput, readOnly: boolean): Promise<PublicPresentation> {
    const gate = createCompanionExecutionValidationSession(), before = this.materializations;
    try {
      const result = await gate.run(() => this.preparePresentation(input, readOnly));
      await gate.validate();
      return { ...result, cacheable: this.materializations === before };
    } finally { gate.close(); }
  }
  private async preparePresentation(input: PublicProfilePrepareInput, readOnly: boolean): Promise<Omit<PublicPresentation, 'cacheable'>> {
    const state = this.options.readStateMetadata ? await this.options.readStateMetadata()
      : (await this.options.request({ type: 'state', includeHidden: true })).state;
    if (!state) throw new Error('本轮公开资料的真实入口暂不可核验。');
    const room = state.conversations.find(item => item.id === input.conversation.id);
    if (!room || !room.memberIds.includes(input.companionId)
      || !state.companions.some(member => member.id === input.companionId))
      throw new Error('本轮公开资料的伙伴或真实成员入口已经不可用。');
    const memberIds = room.memberIds;
    // One strict role admission per owner in this finite presentation. The
    // independent final presentation creates its own map and reads it fresh.
    const admittedOwners = new Map<string, PresentationOwnerProfile>();
    const members = (await Promise.all(state.companions.filter(item => input.directory || memberIds.includes(item.id)).map(async member => {
      if (!this.assetProfiles) return member;
      try {
        const snapshot = await (readOnly ? this.assetProfiles.loadProfile(member.id) : this.assetProfiles.bootstrapProfile(member));
        admittedOwners.set(member.id, { companionId: snapshot.companionId, root: snapshot.root });
        return this.assetProfiles.hydrateProfileFromSnapshot(member, snapshot);
      }
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
      avatar: readOnly && this.assetProfiles ? await this.currentOwnerPublicImage(member, 'avatar', admittedOwners.get(member.id))
        : member.avatarAttachmentId ? await this.attachment(member.avatarAttachmentId, member, 'avatar', false, admittedOwners.get(member.id)) : await this.builtinImage(member),
      orthographic: readOnly && this.assetProfiles ? await this.currentOwnerPublicImage(member, 'orthographic', admittedOwners.get(member.id))
        : member.appearanceAttachmentId ? await this.attachment(member.appearanceAttachmentId, member, 'orthographic', false, admittedOwners.get(member.id)) : await this.builtinImage(member, 'orthographic') });
    const images: unknown[] = [];
    for (const profile of publicProfiles) for (const role of ['avatar', 'orthographic'] as const) {
      const image = profile[role]; if (!image?.available) continue;
      if (profile.kind === 'companion' && this.assetProfiles) {
        const admitted = admittedOwners.get(profile.id); if (!admitted) throw new Error('Public portrait lacks its current role admission.');
        const file = await this.ownerImageFile(profile.id, role, admitted), current = await this.readOwnerImageInPresentation(profile.id, role, admitted);
        if (!file || !current || file.path !== image.absolutePath || current.fileRevision !== sha(Buffer.from([file.path, file.stamp, file.proof].join('\0'))))
          throw new Error('公开形象的当前选择或像素已经变化。');
        image.sha256 = current.sha256; images.push([profile.id, role, file.path, file.proof, current.sha256]);
      } else {
        const before = await this.fileSignature(image.absolutePath), bytes = await readFile(image.absolutePath);
        if (!before || await this.fileSignature(image.absolutePath) !== before) throw new Error('玩家公开形象在读取时改变。');
        image.sha256 = sha(bytes); images.push([profile.id, role, image.absolutePath, image.sha256]);
      }
    }
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
    return { value: { publicProfiles, visualInputs }, binding: JSON.stringify({ room: [room.id, room.kind, room.memberIds],
      audience: input.audience ?? 'player', directory: !!input.directory,
      members: members.map(member => [member.id, member.active !== false, member.avatar, member.templateId ?? null,
        member.avatarAttachmentId ?? null, member.appearanceAttachmentId ?? null]),
      playerSelection: input.audience === 'peers' ? null : [state.playerProfile?.avatarAttachmentId ?? null, state.playerProfile?.appearanceAttachmentId ?? null],
      publicProfiles, images, visualInputs: visualInputs.map(({ personId, role, mime, sha256 }) => ({ personId, role, mime, sha256 })) }) };
  }
  private async currentOwnerPublicImage(owner: Companion, role: PortraitRole, admitted?: PresentationOwnerProfile): Promise<CompanionPublicImage | undefined> {
    const selected = role === 'avatar' ? owner.avatarAttachmentId : owner.appearanceAttachmentId;
    const stored = selected ? (await this.options.request({ type: 'attachment.get', id: selected })).storedAttachment : undefined;
    if (selected && (!stored || !/^image\/(?:png|jpeg|webp|gif)$/u.test(stored.attachment.mime))) return undefined;
    if (!selected && (role === 'avatar' ? owner.avatar === 'custom' : !owner.builtin || !boardFile(owner))) return undefined;
    const candidate = path.join(this.assetProfiles!.libraryDirectory, owner.id, '形象', role + '.png');
    try {
      const file = await this.ownerImageFile(owner.id, role, admitted);
      return file ? { absolutePath: file.path, mime: 'image/' + (path.extname(file.path).slice(1) === 'jpg' ? 'jpeg' : path.extname(file.path).slice(1)),
        available: await this.readableImage(file.path) } : undefined;
    } catch { return { absolutePath: candidate, mime: stored?.attachment.mime ?? 'image/png', available: false }; }
  }

  private async attachment(id?: string, owner?: Companion, role: 'avatar' | 'orthographic' = 'avatar', explicitSelection = false, admitted?: PresentationOwnerProfile): Promise<CompanionPublicImage | undefined> {
    if (!id) return undefined;
    const stored = (await this.options.request({ type: 'attachment.get', id })).storedAttachment;
    if (!stored || !/^image\/(?:png|jpeg|webp|gif)$/u.test(stored.attachment.mime)) return undefined;
    const candidate = owner && this.assetProfiles ? path.resolve(this.assetProfiles.libraryDirectory, owner.id, '形象', role + '.png')
      : path.resolve(this.options.root, stored.relativePath);
    try { const absolutePath = owner && this.assetProfiles ? await this.materializeAttachment(owner, role, stored, explicitSelection, admitted) : await this.managedFile(stored);
      return { absolutePath, mime: stored.attachment.mime, available: await this.readableImage(absolutePath) }; }
    catch { return { absolutePath: candidate, mime: stored.attachment.mime, available: false }; }
  }
  private async materializeAttachment(owner: Companion, role: 'avatar' | 'orthographic', stored: StoredCompanionAttachment, explicitSelection: boolean, admitted?: PresentationOwnerProfile): Promise<string> {
    if (stored.sourcePath) throw new Error('Public portraits must be managed copies.');
    if (admitted && admitted.companionId !== owner.id) throw new Error('Portrait admission belongs to another owner.');
    const snapshot = admitted ?? await this.assetProfiles!.bootstrapProfile(owner), current = await this.runtimeSelection(owner.id), selected = role === 'avatar' ? current.avatarAttachmentId : current.appearanceAttachmentId;
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
      this.materializations++;
      await writeFile(temporary, bytes, { flag: 'wx' });
      await writeFile(manifestTemporary, JSON.stringify({ companionId: owner.id, role, path: name, attachmentId: stored.attachment.id,
        initialChecksum: sha(bytes), initializedAt: new Date().toISOString() }), { flag: 'wx' });
      // A newer explicit file selection wins over this older read.
      await this.assetProfiles!.loadProfile(owner.id);
      const current = await this.runtimeSelection(owner.id);
      if ((role === 'avatar' ? current.avatarAttachmentId : current.appearanceAttachmentId) !== stored.attachment.id) throw new Error('Portrait selection changed during publication.');
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
    const file = role === 'orthographic' ? companion.builtin ? boardFile(companion) : undefined
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
      this.materializations++;
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
        this.materializations++;
        await writeFile(temporary, bytes, { flag: 'wx' });
        await writeFile(receiptTemporary, JSON.stringify({ companionId: companion.id, role, source: file, initializedAt: new Date().toISOString() }), { flag: 'wx' });
        await rename(temporary, destination); await rename(receiptTemporary, receipt);
      } finally { await Promise.all([temporary, receiptTemporary].map(file => unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }))); }
    } else {
      this.materializations++;
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
      const expected = image.sha256;
      const key = [image.absolutePath, info.size, info.mtimeMs, info.ctimeMs, role, expected ?? ''].join('\0');
      let pending = this.visuals.get(key);
      if (!pending) {
        pending = (async () => {
          const original = await readFile(image.absolutePath), originalHash = sha(original);
          if (expected && originalHash !== expected) throw new Error('Public portrait pixels changed before projection.');
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
