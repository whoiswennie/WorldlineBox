import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';

export interface ObservationArtifactScope { owner: string; runId: string; grantId: string; grantRevision: number }
export interface ObservationArtifactSource { id: string; title: string; displayId?: string }
export interface ObservationArtifactValidation extends ObservationArtifactScope {
  observationId?: string; source?: ObservationArtifactSource;
  phase: 'save.prepare' | 'save.clip' | 'save.frame' | 'save.storyboard' | 'save.commit' | 'read.prepare' | 'read.material' | 'read.complete';
  signal?: AbortSignal;
}
export interface ObservationArtifactOptions {
  /** Main supplies an existing, canonical owner-specific directory. No model path is accepted. */
  directory(owner: string): string | Promise<string>;
  /** Recheck the current owner/run and exact active grant revision, including source identity/lock state. */
  validate(input: ObservationArtifactValidation): void | Promise<void>;
}
export interface SaveObservationArtifacts extends ObservationArtifactScope {
  source: ObservationArtifactSource; startedAt: string; endedAt: string;
  clip: { bytes: Uint8Array; mime: 'video/webm'; durationMs: number; width: number; height: number };
  frames: readonly { bytes: Uint8Array; offsetMs: number; observedAt?: string }[];
  storyboard: { bytes: Uint8Array; mime: 'image/png' }; signal?: AbortSignal;
}
export interface ObservationArtifactFile { path: string; sha256: string; size: number; mime: string }
export interface ObservationArtifactReceipt extends ObservationArtifactScope {
  observationId: string; source: ObservationArtifactSource; startedAt: string; endedAt: string;
  manifest: { path: string; sha256: string };
  clip: ObservationArtifactFile & { durationMs: number; width: number; height: number };
  frames: (ObservationArtifactFile & { offsetMs: number; observedAt: string; width: number; height: number })[];
  storyboard: ObservationArtifactFile & { width: number; height: number };
}
export interface ReadObservationArtifacts extends ObservationArtifactScope {
  observationId: string;
  /** Main may pin the hash from the durable run receipt; never obtain this authority from model arguments. */
  expectedManifestSha256?: string; signal?: AbortSignal;
}

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), digest = z.string().regex(/^[a-f0-9]{64}$/u);
const instant = z.iso.datetime({ offset: true });
const file = z.strictObject({ file: z.string(), sha256: digest, size: z.number().int().positive().safe(), mime: z.string() });
const picture = file.extend({ width: z.number().int().positive(), height: z.number().int().positive() });
const manifestSchema = z.strictObject({ schema: z.literal('companion-observation-artifacts-v1'), observationId: z.uuid(),
  owner: id, runId: id, grantId: id, grantRevision: z.number().int().positive().safe(),
  source: z.strictObject({ id: z.string().min(1).max(300), title: z.string().max(1000), displayId: z.string().max(100).optional() }),
  startedAt: instant, endedAt: instant,
  clip: picture.extend({ durationMs: z.number().positive().finite() }),
  frames: z.array(picture.extend({ offsetMs: z.number().nonnegative().finite(), observedAt: instant })).min(2).max(12),
  storyboard: picture });
type Manifest = z.output<typeof manifestSchema>;
type Directory = { root: string; rootStat: BigIntStats; path: string; stat: BigIntStats };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const samePath = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const identity = (s: BigIntStats) => `${s.dev}:${s.ino}`;
const fingerprint = (s: BigIntStats) => `${identity(s)}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;

/** Write-once native observations, separate from memory and the user's asset
 * library. The manifest is a commit record, not a model-editable path index.
 * Readback rechecks every byte and exact authority. No previous observation is
 * silently substituted when a recording is missing or no longer authorized. */
export class CompanionObservationArtifacts {
  private readonly roots = new Map<string, { path: string; identity: string }>();
  private readonly seals = new Map<string, string>();
  constructor(private readonly options: ObservationArtifactOptions) { }

  private scope(input: ObservationArtifactScope): ObservationArtifactScope {
    const parsed = z.strictObject({ owner: id, runId: id, grantId: id, grantRevision: z.number().int().positive().safe() }).safeParse({ owner: input.owner, runId: input.runId, grantId: input.grantId, grantRevision: input.grantRevision });
    if (!parsed.success) throw new Error('观察素材的执行与授权归属无效。');
    return parsed.data;
  }
  private async gate(input: ObservationArtifactValidation) {
    input.signal?.throwIfAborted(); await this.options.validate(input); input.signal?.throwIfAborted();
  }
  private async root(owner: string) {
    const supplied = await this.options.directory(owner);
    if (!path.isAbsolute(supplied) || supplied.includes('\0')) throw new Error('观察素材目录不是宿主提供的真实绝对目录。');
    const absolute = path.resolve(supplied), stat = await lstat(absolute, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(absolute), absolute)) throw new Error('观察素材根目录包含链接或已被替换。');
    const previous = this.roots.get(owner);
    if (previous && (!samePath(previous.path, absolute) || previous.identity !== identity(stat))) throw new Error('观察素材根目录身份已变化。');
    this.roots.set(owner, { path: absolute, identity: identity(stat) });
    return { path: absolute, stat };
  }
  private async directory(owner: string, observationId: string, create = false): Promise<Directory> {
    if (!z.uuid().safeParse(observationId).success) throw new Error('观察素材标识无效，不能使用文件路径代替。');
    const root = await this.root(owner), target = path.join(root.path, observationId);
    if (create) await mkdir(target, { mode: 0o700 });
    const stat = await lstat(target, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(target), target) || !samePath(path.dirname(target), root.path)) throw new Error('观察素材目录不是原生受管目录。');
    return { root: root.path, rootStat: root.stat, path: target, stat };
  }
  private async unchanged(owner: string, directory: Directory) {
    const root = await this.root(owner), stat = await lstat(directory.path, { bigint: true });
    if (!samePath(root.path, directory.root) || identity(root.stat) !== identity(directory.rootStat) || !stat.isDirectory() || stat.isSymbolicLink()
      || identity(stat) !== identity(directory.stat) || !samePath(await realpath(directory.path), directory.path)) throw new Error('观察素材目录在处理期间被替换。');
  }
  private target(directory: Directory, name: string) {
    if (!/^(?:clip\.webm|storyboard\.png|frame-\d{3}\.png|manifest\.json|manifest\.sha256)$/u.test(name)) throw new Error('观察素材清单包含非法文件引用。');
    return path.join(directory.path, name);
  }
  private async write(owner: string, directory: Directory, name: string, bytes: Uint8Array, created?: (stat: BigIntStats) => void) {
    await this.unchanged(owner, directory);
    const target = this.target(directory, name), handle = await open(target, 'wx', 0o400);
    try { created?.(await handle.stat({ bigint: true })); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await this.unchanged(owner, directory);
    const stat = await lstat(target, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('观察素材写入目标已变化。');
    return { target, stat };
  }
  private async read(owner: string, directory: Directory, name: string, expected?: { size: number; sha256: string }, collect = true, audit?: { signal?: AbortSignal; fingerprints: Map<string, string> }): Promise<Buffer> {
    audit?.signal?.throwIfAborted();
    await this.unchanged(owner, directory);
    const target = this.target(directory, name), before = await lstat(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !samePath(await realpath(target), target)
      || before.size > BigInt(Number.MAX_SAFE_INTEGER) || expected && before.size !== BigInt(expected.size)) throw new Error('观察素材文件身份或长度已变化。');
    // Metadata is small. Material sizes are sealed by the native save receipt.
    if (!expected && before.size > 128n * 1024n) throw new Error('观察素材清单不是有效的受管记录。');
    const handle = await open(target, 'r'), chunks: Buffer[] = [], digest = createHash('sha256');
    try {
      if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(before)) throw new Error('观察素材在打开时被替换。');
      const buffer = Buffer.alloc(64 * 1024); let offset = 0;
      while (offset < Number(before.size)) {
        audit?.signal?.throwIfAborted();
        const read = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
        if (!read.bytesRead) throw new Error('观察素材读取不完整。');
        const chunk = buffer.subarray(0, read.bytesRead); digest.update(chunk); if (collect) chunks.push(Buffer.from(chunk)); offset += read.bytesRead;
      }
      const actualHash = digest.digest('hex');
      if (expected && actualHash !== expected.sha256 || fingerprint(await handle.stat({ bigint: true })) !== fingerprint(before)
        || fingerprint(await lstat(target, { bigint: true })) !== fingerprint(before)) throw new Error('观察素材内容或哈希已变化。');
      await this.unchanged(owner, directory); audit?.fingerprints.set(name, fingerprint(before)); return Buffer.concat(chunks);
    } finally { await handle.close(); }
  }
  private async picture(bytes: Buffer) {
    const info = await sharp(bytes).metadata();
    if (info.format !== 'png' || !info.width || !info.height) throw new Error('观察图像不是有效的 PNG 素材。');
    return { width: info.width, height: info.height };
  }
  private receipt(manifest: Manifest, directory: Directory, manifestHash: string): ObservationArtifactReceipt {
    const material = <T extends { file: string }>(value: T) => { const { file, ...rest } = value; return { ...rest, path: this.target(directory, file) }; };
    return { owner: manifest.owner, runId: manifest.runId, grantId: manifest.grantId, grantRevision: manifest.grantRevision, observationId: manifest.observationId,
      source: { ...manifest.source }, startedAt: manifest.startedAt, endedAt: manifest.endedAt,
      manifest: { path: this.target(directory, 'manifest.json'), sha256: manifestHash }, clip: material(manifest.clip),
      frames: manifest.frames.map(material), storyboard: material(manifest.storyboard) };
  }
  async save(input: SaveObservationArtifacts): Promise<ObservationArtifactReceipt> {
    const scope = this.scope(input), source = { ...input.source }, observationId = randomUUID();
    const clip = Buffer.from(input.clip.bytes), storyboard = Buffer.from(input.storyboard.bytes), frames = input.frames.map(frame => ({ ...frame, bytes: Buffer.from(frame.bytes) }));
    const started = Date.parse(input.startedAt), ended = Date.parse(input.endedAt);
    if (input.clip.mime !== 'video/webm' || clip.length < 4 || !clip.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) || input.storyboard.mime !== 'image/png'
      || !Number.isFinite(started) || !Number.isFinite(ended) || ended <= started || !Number.isFinite(input.clip.durationMs) || input.clip.durationMs <= 0
      || Math.abs(ended - started - input.clip.durationMs) > 1000 || frames.length < 2 || frames.length > 12
      || frames.some((frame, index) => !Number.isFinite(frame.offsetMs) || frame.offsetMs < 0 || frame.offsetMs > input.clip.durationMs || index > 0 && frame.offsetMs <= frames[index - 1]!.offsetMs
        || frame.observedAt !== undefined && Date.parse(frame.observedAt) !== started + frame.offsetMs)) throw new Error('观察录像、实际时序或序列帧无效。');
    const context = { ...scope, observationId, source, signal: input.signal };
    await this.gate({ ...context, phase: 'save.prepare' });
    const directory = await this.directory(scope.owner, observationId, true), created = new Map<string, string>();
    const write = async (name: string, bytes: Buffer) => { await this.write(scope.owner, directory, name, bytes, stat => created.set(name, identity(stat))); return { file: name, sha256: hash(bytes), size: bytes.length }; };
    try {
      const clipFile = await write('clip.webm', clip); await this.gate({ ...context, phase: 'save.clip' });
      const pictureFiles = [];
      for (const [index, frame] of frames.entries()) {
        const dimensions = await this.picture(frame.bytes), file = await write(`frame-${String(index).padStart(3, '0')}.png`, frame.bytes);
        pictureFiles.push({ ...file, ...dimensions, mime: 'image/png', offsetMs: frame.offsetMs, observedAt: new Date(started + frame.offsetMs).toISOString() });
        await this.gate({ ...context, phase: 'save.frame' });
      }
      const dimensions = await this.picture(storyboard), storyboardFile = await write('storyboard.png', storyboard); await this.gate({ ...context, phase: 'save.storyboard' });
      const manifest = manifestSchema.parse({ schema: 'companion-observation-artifacts-v1', ...scope, observationId, source,
        startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(),
        clip: { ...clipFile, mime: 'video/webm', durationMs: input.clip.durationMs, width: input.clip.width, height: input.clip.height },
        frames: pictureFiles, storyboard: { ...storyboardFile, ...dimensions, mime: 'image/png' } });
      const bytes = Buffer.from(JSON.stringify(manifest) + '\n'), manifestHash = hash(bytes);
      await write('manifest.sha256', Buffer.from(manifestHash + '\n')); await write('manifest.json', bytes);
      await this.gate({ ...context, phase: 'save.commit' }); await this.unchanged(scope.owner, directory);
      this.seals.set(`${scope.owner}/${observationId}`, manifestHash);
      return this.receipt(manifest, directory, manifestHash);
    } catch (error) {
      // Only unlink the exact newly-created regular files in this still-owned
      // directory. A replaced/link directory is left untouched for inspection.
      try {
        await this.unchanged(scope.owner, directory);
        for (const [name, expected] of created) {
          const target = this.target(directory, name), stat = await lstat(target, { bigint: true });
          if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && identity(stat) === expected) { await chmod(target, 0o600); await unlink(target); }
        }
        await this.unchanged(scope.owner, directory); await rmdir(directory.path);
      } catch { /* No recursive deletion, no external path cleanup. */ }
      throw error;
    }
  }
  async readForThought(input: ReadObservationArtifacts): Promise<ObservationArtifactReceipt & { storyboard: ObservationArtifactReceipt['storyboard'] & { bytes: Uint8Array } }> {
    const scope = this.scope(input), context = { ...scope, observationId: input.observationId, signal: input.signal };
    const audit = { signal: input.signal, fingerprints: new Map<string, string>() };
    await this.gate({ ...context, phase: 'read.prepare' });
    const directory = await this.directory(scope.owner, input.observationId), bytes = await this.read(scope.owner, directory, 'manifest.json', undefined, true, audit);
    const manifestHash = hash(bytes), seal = (await this.read(scope.owner, directory, 'manifest.sha256', undefined, true, audit)).toString('utf8');
    if (seal !== manifestHash + '\n' || input.expectedManifestSha256 !== undefined && input.expectedManifestSha256 !== manifestHash
      || this.seals.has(`${scope.owner}/${input.observationId}`) && this.seals.get(`${scope.owner}/${input.observationId}`) !== manifestHash) throw new Error('观察素材清单哈希与原始回执不一致。');
    const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (manifest.owner !== scope.owner || manifest.runId !== scope.runId || manifest.grantId !== scope.grantId || manifest.grantRevision !== scope.grantRevision || manifest.observationId !== input.observationId
      || manifest.clip.file !== 'clip.webm' || manifest.clip.mime !== 'video/webm' || manifest.storyboard.file !== 'storyboard.png' || manifest.storyboard.mime !== 'image/png'
      || manifest.frames.some((frame, index) => frame.file !== `frame-${String(index).padStart(3, '0')}.png` || frame.mime !== 'image/png')) throw new Error('观察素材不属于当前执行和准确授权版本。');
    const verified = { ...context, source: manifest.source };
    await this.gate({ ...verified, phase: 'read.material' });
    await this.read(scope.owner, directory, manifest.clip.file, manifest.clip, false, audit);
    for (const frame of manifest.frames) { await this.read(scope.owner, directory, frame.file, frame, false, audit); await this.gate({ ...verified, phase: 'read.material' }); }
    const storyboard = await this.read(scope.owner, directory, manifest.storyboard.file, manifest.storyboard, true, audit);
    await this.gate({ ...verified, phase: 'read.complete' }); await this.unchanged(scope.owner, directory);
    for (const [name, expected] of audit.fingerprints) {
      const current = await lstat(this.target(directory, name), { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || fingerprint(current) !== expected) throw new Error('观察素材在交给思考能力前已变化。');
    }
    const finalManifest = await this.read(scope.owner, directory, 'manifest.json', undefined, true, audit);
    if (hash(finalManifest) !== manifestHash) throw new Error('观察素材清单在读取期间已变化。');
    await this.gate({ ...verified, phase: 'read.complete' });
    input.signal?.throwIfAborted();
    const receipt = this.receipt(manifest, directory, manifestHash);
    return { ...receipt, storyboard: { ...receipt.storyboard, bytes: storyboard } };
  }
}
