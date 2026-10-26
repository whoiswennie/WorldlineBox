import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import type { CompanionMemory } from '../../shared/companions';
import type { VcpMemoryTimelineArtifacts } from '../vcp-memory/contracts';

type View = { scopeId: string; identity: string; profileKey: string; dirty: boolean; notes: Record<string, string>; projectionSignature?: string; needsSync?: boolean; sourceToken?: string };
export interface CompanionMemoryViewCacheLimits { maxViews?: number; maxViewBytes?: number; maxArtifacts?: number; maxArtifactBytes?: number }
export interface CompanionMemoryViewCacheDirectory { directoryForOwner(owner: string): Promise<string> }
const boundedLimit = (value: number | undefined, fallback: number, minimum: number) => {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < minimum) throw new RangeError('Invalid memory view cache limit.');
  return limit;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function validView(value: unknown): value is View {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const view = value as Partial<View>;
  return typeof view.scopeId === 'string' && /^view_[a-f0-9]{32}$/u.test(view.scopeId)
    && typeof view.identity === 'string' && /^[a-zA-Z0-9_-]{1,100}:[^\r\n]+$/u.test(view.identity) && typeof view.profileKey === 'string' && typeof view.dirty === 'boolean'
    && !!view.notes && typeof view.notes === 'object' && !Array.isArray(view.notes)
    && Object.values(view.notes).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))
    && (view.projectionSignature === undefined || typeof view.projectionSignature === 'string')
    && (view.needsSync === undefined || typeof view.needsSync === 'boolean')
    && (view.sourceToken === undefined || typeof view.sourceToken === 'string' && /^[a-f0-9]{64}$/u.test(view.sourceToken));
}
function fingerprints(notes: readonly CompanionMemory[]) {
  return Object.fromEntries(notes.map(note => [note.id, hash(JSON.stringify([note.version, note.content, note.tags, note.occurredAt,
    note.diaryName, note.metadata, note.sourceConversationId, note.sources, note.captureMethod]))]));
}

/** Complete owner views can opt into native differential replacement. Other
 * lanes retain conservative rebuilds; interrupted writes always rebuild. */
export class CompanionMemoryViewCache {
  private readonly memory = new Map<string, View>();
  private readonly viewSizes = new Map<string, number>();
  private readonly saving = new Map<string, number>();
  private viewBytes = 0;
  private readonly artifacts = new Map<string, { value: VcpMemoryTimelineArtifacts; bytes: number }>();
  private artifactBytes = 0;
  private readonly maxViews: number;
  private readonly maxViewBytes: number;
  private readonly maxArtifacts: number;
  private readonly maxArtifactBytes: number;
  private readonly directory?: string;
  private readonly directoryForOwner?: CompanionMemoryViewCacheDirectory['directoryForOwner'];
  constructor(location?: string | CompanionMemoryViewCacheDirectory, limits: CompanionMemoryViewCacheLimits = {}) {
    if (typeof location === 'string') this.directory = location;
    else this.directoryForOwner = location?.directoryForOwner;
    this.maxViews = boundedLimit(limits.maxViews, 16, 1);
    this.maxViewBytes = boundedLimit(limits.maxViewBytes, 16 * 1024 * 1024, 0);
    this.maxArtifacts = boundedLimit(limits.maxArtifacts, 8, 0);
    this.maxArtifactBytes = boundedLimit(limits.maxArtifactBytes, 8 * 1024 * 1024, 0);
  }
  private get persistent(): boolean { return !!this.directory || !!this.directoryForOwner; }
  private owner(identity: string): string {
    const parsed = /^([a-zA-Z0-9_-]{1,100}):[^\r\n]+$/u.exec(identity);
    if (!parsed) throw new Error('记忆视图缺少宿主伙伴身份。'); return parsed[1]!;
  }
  private async ownerDirectory(owner: string, create = false): Promise<string | undefined> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(owner)) throw new Error('记忆视图伙伴标识无效。');
    const directory = this.directoryForOwner ? await this.directoryForOwner(owner) : this.directory;
    if (!directory) return;
    if (!path.isAbsolute(directory)) throw new Error('记忆视图目录必须是伙伴资产中的绝对目录。');
    if (create) await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || path.relative(path.resolve(directory), await realpath(directory)) !== '') throw new Error('记忆视图目录不能是链接或目录联接。');
    return directory;
  }
  /** Serialized residency estimates only, not total process RSS. Atomic saves
   * stay pinned briefly; persisted dirty manifests can safely leave the LRU. */
  snapshot() {
    return { views: this.memory.size, dirtyViews: [...this.memory.values()].filter(view => view.dirty).length,
      viewBytes: this.viewBytes, activeSaves: this.saving.size, maxViewBytes: this.maxViewBytes,
      artifacts: this.artifacts.size, artifactBytes: this.artifactBytes, persistent: this.persistent,
      maxViews: this.maxViews, maxArtifacts: this.maxArtifacts, maxArtifactBytes: this.maxArtifactBytes };
  }
  private removeView(key: string): void {
    this.viewBytes -= this.viewSizes.get(key) ?? 0; this.viewSizes.delete(key); this.memory.delete(key);
  }
  private trimViews(): void {
    // A memory-only fixture has no disk authority from which to restore a
    // dropped view. Its retention semantics deliberately remain unchanged.
    if (!this.persistent) return;
    while (this.memory.size > this.maxViews || this.viewBytes > this.maxViewBytes) {
      const victim = [...this.memory.keys()].find(key => !this.saving.has(key));
      if (!victim) break;
      this.removeView(victim);
    }
  }
  private cacheView(key: string, view: View, bytes = Buffer.byteLength(JSON.stringify(view), 'utf8') + Buffer.byteLength(key, 'utf8') + 128): void {
    this.removeView(key);
    if (this.persistent && bytes > this.maxViewBytes && !this.saving.has(key)) return;
    this.memory.set(key, view); this.viewSizes.set(key, bytes); this.viewBytes += bytes; this.trimViews();
  }
  private removeArtifact(key: string): void {
    const previous = this.artifacts.get(key);
    if (previous) this.artifactBytes -= previous.bytes;
    this.artifacts.delete(key);
  }
  private cacheArtifact(key: string, value: VcpMemoryTimelineArtifacts, bytes: number): boolean {
    this.removeArtifact(key);
    if (this.persistent && (!this.maxArtifacts || bytes > this.maxArtifactBytes)) return false;
    if (this.persistent) while (this.artifacts.size >= this.maxArtifacts || this.artifactBytes + bytes > this.maxArtifactBytes) {
      const oldest = this.artifacts.keys().next().value;
      if (oldest === undefined) break;
      this.removeArtifact(oldest);
    }
    this.artifacts.set(key, { value, bytes }); this.artifactBytes += bytes;
    return true;
  }
  private async file(key: string, create = false) { return path.join((await this.ownerDirectory(this.owner(key.split('\n')[0]!), create))!, `${hash(key)}.json`); }
  private async save(key: string, view: View): Promise<void> {
    if (!this.persistent) { this.cacheView(key, view); return; }
    const serialized = JSON.stringify(view), bytes = Buffer.byteLength(serialized, 'utf8') + Buffer.byteLength(key, 'utf8') + 128;
    // Only an unfinished atomic save needs a pin. After prepare resolves, disk
    // already records dirty=true; restoring that entry must create a fresh
    // scope even if its failed caller never commits or releases anything.
    this.saving.set(key, (this.saving.get(key) ?? 0) + 1);
    if (view.dirty) this.cacheView(key, view, bytes);
    try {
      const file = await this.file(key, true), temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, file); this.cacheView(key, view, bytes);
    } finally {
      const remaining = (this.saving.get(key) ?? 1) - 1;
      if (remaining) this.saving.set(key, remaining); else this.saving.delete(key);
      if (!this.saving.has(key) && (this.viewSizes.get(key) ?? 0) > this.maxViewBytes) this.removeView(key);
      this.trimViews();
    }
  }
  async prepare(identity: string, profileKey: string, notes: readonly CompanionMemory[], projectionSignature?: string, options: { incremental?: boolean } = {}) {
    return this.prepareTarget(identity, profileKey, () => fingerprints(notes), projectionSignature, options);
  }
  async prepareMetadata(identity: string, profileKey: string, target: Readonly<Record<string, string>>, sourceToken: string, projectionSignature?: string) {
    return this.prepareTarget(identity, profileKey, () => target, projectionSignature, { incremental: true, sourceToken });
  }
  private async prepareTarget(identity: string, profileKey: string, createTarget: () => Readonly<Record<string, string>>, projectionSignature?: string,
    options: { incremental?: boolean; sourceToken?: string } = {}) {
    this.owner(identity);
    const key = `${identity}\n${profileKey}`;
    let previous = this.memory.get(key);
    if (previous) { this.memory.delete(key); this.memory.set(key, previous); }
    if (!previous && this.persistent) {
      try {
        const parsed: unknown = JSON.parse(await readFile(await this.file(key), 'utf8'));
        if (validView(parsed) && parsed.profileKey === profileKey && parsed.identity === identity) {
          previous = parsed; this.cacheView(key, parsed);
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }
    if (previous && !previous.dirty && !previous.needsSync && previous.projectionSignature === projectionSignature
      && options.sourceToken && previous.sourceToken === options.sourceToken)
      return { scopeId: previous.scopeId, unchanged: true, upsertIds: [] as string[], removedIds: [] as string[], commit: async () => undefined };
    const target = createTarget();
    const reusable = previous && !previous.dirty && previous.profileKey === profileKey && previous.projectionSignature === projectionSignature
      && (options.incremental || Object.entries(previous.notes).every(([id, fingerprint]) => target[id] === fingerprint));
    const unchanged = !!reusable && !previous!.needsSync && Object.keys(previous!.notes).length === Object.keys(target).length
      && Object.entries(previous!.notes).every(([id, fingerprint]) => target[id] === fingerprint);
    const scopeId = reusable && previous ? previous.scopeId : `view_${randomUUID().replaceAll('-', '')}`;
    const view: View = { scopeId, identity, profileKey, dirty: true, notes: target, projectionSignature, ...(options.sourceToken ? { sourceToken: options.sourceToken } : {}) };
    if (!unchanged) await this.save(key, view);
    return { scopeId, unchanged, upsertIds: Object.keys(target).filter(id => !reusable || previous!.notes[id] !== target[id]),
      removedIds: reusable ? Object.keys(previous!.notes).filter(id => !(id in target)) : [],
      replacedScopeId: previous && previous.scopeId !== scopeId ? previous.scopeId : undefined,
      commit: async () => { if (!unchanged) await this.save(key, { ...view, dirty: false }); } };
  }
  async loadArtifacts(identity: string, profileKey: string): Promise<VcpMemoryTimelineArtifacts | undefined> {
    this.owner(identity);
    const key = `${identity}\n${profileKey}`;
    const cached = this.artifacts.get(key);
    if (cached) { this.artifacts.delete(key); this.artifacts.set(key, cached); return structuredClone(cached.value); }
    if (!this.persistent) return undefined;
    try {
      const stored = JSON.parse(await readFile(`${await this.file(key)}.timeline`, 'utf8'));
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
      const artifacts = ('artifacts' in stored ? stored.identity === identity && stored.profileKey === profileKey && stored.artifacts : stored) as VcpMemoryTimelineArtifacts;
      if (!artifacts) return undefined;
      if (artifacts.schema !== 'worldlinebox.vcp-timeline-artifacts' || typeof artifacts.sourceRevision !== 'string' || !Array.isArray(artifacts.agents)) return undefined;
      const bytes = Buffer.byteLength(JSON.stringify(artifacts), 'utf8') + Buffer.byteLength(key, 'utf8') + 128;
      return this.cacheArtifact(key, artifacts, bytes) ? structuredClone(artifacts) : artifacts;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined; throw error; }
  }
  async saveArtifacts(identity: string, profileKey: string, artifacts: VcpMemoryTimelineArtifacts): Promise<void> {
    this.owner(identity);
    const key = `${identity}\n${profileKey}`, serialized = JSON.stringify({ identity, profileKey, artifacts });
    const bytes = Buffer.byteLength(serialized, 'utf8') + Buffer.byteLength(key, 'utf8') + 128;
    if (this.persistent) {
      const file = `${await this.file(key, true)}.timeline`, temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 }); await rename(temporary, file);
    }
    if (this.persistent && (!this.maxArtifacts || bytes > this.maxArtifactBytes)) { this.removeArtifact(key); return; }
    this.cacheArtifact(key, (JSON.parse(serialized) as { artifacts: VcpMemoryTimelineArtifacts }).artifacts, bytes);
  }
  async clearArtifacts(identity: string, profileKey: string): Promise<void> {
    this.owner(identity);
    const key = `${identity}\n${profileKey}`;
    this.removeArtifact(key);
    if (this.persistent) { try { await rm(`${await this.file(key)}.timeline`, { force: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  }
  async invalidateOwner(owner: string, options: { preserveIndexes?: boolean } = {}): Promise<Array<{ scopeId: string; profileKey: string }>> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(owner)) throw new Error('记忆视图伙伴标识无效。');
    const invalidated = new Map<string, View>();
    const handled = new Map<string, { scopeId: string; dirty: boolean }>();
    for (const [key, view] of [...this.memory]) if (view.identity.startsWith(`${owner}:`)) {
      handled.set(key, { scopeId: view.scopeId, dirty: view.dirty });
      if (options.preserveIndexes && !view.dirty) await this.save(key, { ...view, needsSync: true });
      else { invalidated.set(view.scopeId, view); this.removeView(key); }
    }
    for (const key of this.artifacts.keys()) if (key.startsWith(`${owner}:`)) {
      this.removeArtifact(key);
      if (this.persistent) { try { await rm(`${await this.file(key)}.timeline`, { force: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    }
    if (this.persistent) {
      let files: string[] = [];
      let directory: string | undefined;
      try { directory = await this.ownerDirectory(owner); files = await readdir(directory!); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/u.test(file))) {
        const target = path.join(directory!, file);
        let view: View;
        try { view = JSON.parse(await readFile(target, 'utf8')) as View; } catch { continue; }
        if (!view || typeof view.identity !== 'string' || !view.identity.startsWith(`${owner}:`)) continue;
        const key = `${view.identity}\n${view.profileKey}`;
        // Do not resurrect an older clean on-disk receipt if this process has
        // already observed a dirty write for the same projection identity.
        if (options.preserveIndexes && validView(view) && !view.dirty && target === await this.file(key)
          && (!handled.has(key) || !handled.get(key)!.dirty && handled.get(key)!.scopeId === view.scopeId)) {
          if (!handled.has(key)) await this.save(key, { ...view, needsSync: true });
          await rm(`${target}.timeline`, { force: true }); continue;
        }
        if (/^view_[a-f0-9]{32}$/u.test(view.scopeId)) invalidated.set(view.scopeId, view);
        await rm(target, { force: true }); await rm(`${target}.timeline`, { force: true });
      }
      for (const file of files.filter(file => /^[a-f0-9]{64}\.json\.timeline$/u.test(file))) {
        const target = path.join(directory!, file);
        let artifactOwner: unknown;
        try { artifactOwner = JSON.parse(await readFile(target, 'utf8')).identity; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) continue; throw error; }
        if (typeof artifactOwner === 'string' && artifactOwner.startsWith(`${owner}:`)) await rm(target, { force: true });
      }
    }
    return [...invalidated.values()].map(({ scopeId, profileKey }) => ({ scopeId, profileKey }));
  }
}
