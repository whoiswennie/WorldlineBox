import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Companion, CompanionMemory } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { companionArtifactPathSchema, COMPANION_ARTIFACT_CONSUMERS, type CompanionArtifact, type CompanionArtifactReference } from '../../shared/companion-artifact';
import type { CompanionArtifactKind } from '../../shared/companion-artifact';
import type { VcpMemoryTimelineArtifacts } from '../vcp-memory/contracts';
import type { CompanionAssetProfileStore } from './asset-profile';
import { type CompanionArtifactRegistry, companionMemoryArtifactPath } from './artifact-registry';
import { removeOwnedDirectory } from './owned-directory-cleanup';
import { companionMemoryIdentity, sameCompanionMemoryIdentity } from './memory-identity';
import type { CompanionMemoryHistoryDescriptor } from '../../shared/companion-memory-history';
import { memoryFilePublicationOperation, prepareMemoryFilePublication } from './memory-publication-jobs';
import type { CompanionFilePublicationGuard } from '../../shared/companion-registry-storage';
import { CompanionMemoryFilesPending } from './memory-files-pending';

export const companionMemoryLibraryCategories = ['记忆/经历', '记忆/知识', '记忆/自我认识', '记忆/导航'] as const;
const memoryKinds = new Set(['episode_memory', 'knowledge', 'procedure', 'self_understanding', 'navigation', 'dream_fiction']);
export type MemoryLibraryEntry = {
  artifact: CompanionArtifact; noteId?: string; conversationId?: string; version?: number; hash: string; state: 'tracked' | 'forgotten';
};
/** Ephemeral registry projection for existing document consumers; never read from or saved to a file. */
export type MemoryLibraryManifest = { schema: 'worldlinebox.companion-document-view-v2'; files: Record<string, MemoryLibraryEntry> };
export interface MemoryLibraryTimelineScope { companionId: string; conversationId: string; beforeSequence?: number }
export interface MemoryLibrarySyncReport { exported: number; imported: number; forgotten: number; conflicts: Array<{ companionId: string; file: string; message: string }> }
export interface MemoryBodyCleanupCursor { kindIndex: number; afterId?: string }
export interface MemoryBodyCleanupResult { removed: number; checked: number; pending: boolean; nextCursor?: MemoryBodyCleanupCursor; conflicts: Array<{ file: string; message: string }> }
type MemoryBodyPublication = Pick<CompanionMemoryHistoryDescriptor, 'dependencies'> & { jobId?: string; retryCycle?: number; check?(): Promise<void>; fileJobGuard?: CompanionFilePublicationGuard };
export interface CompanionMemoryLibraryOptions {
  libraryDirectory: string; profileStore?: CompanionAssetProfileStore;
  artifacts?(owner: string): Promise<CompanionArtifactRegistry>;
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  /** Trusted owner index only; canonical-file gates do not consume persona. */
  resolveOwnerMetadata?(ownerId: string): Promise<Companion | undefined>;
  report?(error: unknown): void; maxOwnersPerSync?: number; maxFilesPerOwner?: number;
  onPublished?(note: CompanionMemory): void;
}
export interface MemoryLibraryDocumentSession {
  owner: Companion; root: string; registry: CompanionArtifactRegistry; manifest: MemoryLibraryManifest; readOnly?: boolean;
  file(relative: string): string;
  text(relative: string, optional?: boolean): Promise<string | undefined>;
  current(entry: MemoryLibraryEntry): Promise<CompanionMemory | undefined>;
  currentEntry(relative: string): Promise<MemoryLibraryEntry | undefined>;
  readVersion(relative: string): number;
  project(relative: string, note: CompanionMemory, publication?: MemoryBodyPublication): Promise<void>;
  reconcile(relative: string): Promise<void>;
  timelineValid(relative: string, contentHash?: string): Promise<boolean>;
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const memoryArtifactReference = (artifact: CompanionArtifact): CompanionArtifactReference => ({ artifactId: artifact.artifactId, contentRevision: artifact.contentRevision, contentHash: artifact.contentHash });
export function memoryLibraryPathParts(relative: string): string[] { return companionArtifactPathSchema.parse(relative).split('/'); }
export function companionMemoryRegisteredPath(note: CompanionMemory): string {
  if (!memoryKinds.has(note.artifactKind)) throw new Error('记忆缺少显式合法认知类型；不会根据目录或笔记本名称推断。');
  if (note.artifactKind === 'dream_fiction') return `演化/联想/${note.id}.md`;
  return companionMemoryArtifactPath(note.artifactKind, note.diaryName || '默认', note.id);
}

/** No directory discovery, file import, editable manifest, or SQL reconstruction.
 * Only explicit, authorized system publication can create an owner cognition file. */
export class CompanionMemoryLibrary {
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<MemoryLibrarySyncReport>;
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly readers = new Set<Promise<unknown>>();
  private readonly preparing = new Set<string>();
  private readonly resetting = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly verificationCursors = new Map<string, string | undefined>();
  private readonly cleanupCursors = new Map<string, MemoryBodyCleanupCursor | undefined>();
  private ownerCursor = 0;
  constructor(private readonly options: CompanionMemoryLibraryOptions) {
    if (!path.isAbsolute(options.libraryDirectory)) throw new Error('伙伴记忆目录必须是绝对路径。');
    if (!options.artifacts && !options.profileStore) throw new Error('记忆文件必须连接宿主锚定的类型注册表。');
  }
  private async call(command: CompanionStorageCommand): Promise<CompanionStorageResponse> {
    const result = await this.options.request(command); if (!result.ok) throw new Error(result.error || '伙伴存储不可用。'); return result;
  }
  private async registry(owner: string) { return this.options.artifacts ? this.options.artifacts(owner) : this.options.profileStore!.artifacts(owner); }
  private serial<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const pending = (this.tails.get(owner) ?? Promise.resolve()).catch(() => undefined).then(work); this.tails.set(owner, pending);
    void pending.finally(() => { if (this.tails.get(owner) === pending) this.tails.delete(owner); }).catch(() => undefined); return pending;
  }
  private entry(artifact: CompanionArtifact): MemoryLibraryEntry {
    return { artifact, hash: artifact.contentHash, state: 'tracked', ...(memoryKinds.has(artifact.kind) && artifact.artifactId.startsWith('memory:') ? { noteId: artifact.artifactId.slice('memory:'.length) } : {}) };
  }
  private async view(registry: CompanionArtifactRegistry, inventory = false): Promise<MemoryLibraryManifest> {
    const files: MemoryLibraryManifest['files'] = {};
    if (inventory) {
      let afterId: string | undefined;
      do { const page = await registry.page({ consumer: 'audit', afterId, limit: 256 }); for (const artifact of page.items) files[artifact.relativePath] = this.entry(artifact); afterId = page.hasMore ? page.nextId : undefined; } while (afterId);
    }
    return { schema: 'worldlinebox.companion-document-view-v2', files };
  }
  withDocuments<T>(ownerId: string, work: (session: MemoryLibraryDocumentSession) => Promise<T>, options?: { synchronize?: boolean; readOnly?: boolean; sourceDelivery?: boolean; catalogInventory?: boolean; ifIdle?: boolean }): Promise<T> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(ownerId)) return Promise.reject(new Error('伙伴标识无效。'));
    const open = async () => {
      if (this.closed || this.resetting.has(ownerId)) throw new Error('伙伴文件正在关闭或清理。');
      const owner = this.options.resolveOwnerMetadata ? await this.options.resolveOwnerMetadata(ownerId)
        : (await this.call({ type: 'state', companionId: ownerId, includeConversations: false, includeHidden: true })).state?.companions.find(item => item.id === ownerId);
      if (!owner || owner.id !== ownerId) throw new Error('伙伴不存在或已移除。');
      const registry = await this.registry(ownerId), manifest = await this.view(registry, options?.catalogInventory);
      const find = (relative: string) => registry.findByPath(companionArtifactPathSchema.parse(relative));
      const current = async (entry: MemoryLibraryEntry) => entry.noteId ? (await this.call({ type: 'memory.library.read', companionId: ownerId, id: entry.noteId })).memoryRead?.memory : undefined;
      const session: MemoryLibraryDocumentSession = {
        owner, root: registry.root, registry, manifest, readOnly: options?.readOnly,
        file: relative => path.join(registry.root, ...memoryLibraryPathParts(relative)),
        text: async (relative, optional) => { const artifact = await find(relative); if (!artifact) { if (optional) return undefined; throw new Error('文档未登记或已撤回。'); } return (await registry.read({ artifactId: artifact.artifactId, consumer: 'audit' })).text; },
        current,
        currentEntry: async relative => { const artifact = await find(relative); if (!artifact) return undefined; const entry = this.entry(artifact); manifest.files[relative] = entry; return entry; },
        readVersion: relative => manifest.files[relative]?.artifact.contentRevision ?? 0,
        project: async (relative, note, publication) => { if (session.readOnly) throw new Error('只读会话不能发布正文。'); await this.publish(session, relative, note, publication); },
        reconcile: async relative => {
          const entry = manifest.files[relative]; if (!entry) throw new Error('未登记文档不能导入认知。');
          await registry.read({ artifactId: entry.artifact.artifactId, consumer: 'audit' });
          if (entry.noteId && !await current(entry)) throw new Error('记忆来源已撤回；不会从文件复活记忆。');
        },
        timelineValid: async (relative, contentHash) => {
          const artifact = await find(relative); if (!artifact || artifact.kind !== 'navigation') return false;
          const body = (await registry.read({ artifactId: artifact.artifactId, consumer: 'navigation' })).text;
          if (contentHash && hash(body) !== contentHash) return false;
          try { const match = /^---\n([^]*?)\n---\n/u.exec(body); if (!match) return false;
            const metadata = JSON.parse(match[1]!) as { schema: string; scope: MemoryLibraryTimelineScope; sourceRevision: string };
            if (metadata.schema !== 'worldlinebox.companion-navigation-v2' || metadata.scope.companionId !== ownerId) return false;
            const snapshot = (await this.call({ type: 'memory.snapshot', ...metadata.scope, contentKinds: ['episode_memory'] })).memorySnapshot;
            return !!snapshot && (snapshot.semanticRevision ?? snapshot.revision) === metadata.sourceRevision;
          } catch { return false; }
        },
        request: command => this.call(command),
      };
      return work(session);
    };
    if (!options?.readOnly) {
      // Do not enqueue an optional foreground publisher behind an unrelated
      // owner quantum. The durable job remains for the background pump.
      if (options?.ifIdle && this.tails.has(ownerId)) return Promise.reject(new CompanionMemoryFilesPending('伙伴正在发布另一项资料，本次准确修订继续在后台等待。'));
      return this.serial(ownerId, open);
    }
    const pending = open(); this.readers.add(pending); void pending.finally(() => this.readers.delete(pending)).catch(() => undefined); return pending;
  }
  private async publish(session: MemoryLibraryDocumentSession, relative: string, note: CompanionMemory, publication?: MemoryBodyPublication): Promise<void> {
    if (note.companionId !== session.owner.id || !note.contentRevision || relative !== companionMemoryRegisteredPath(note)) throw new Error('正文类型、归属或受管位置无效。');
    if ((publication?.jobId === undefined) !== (publication?.retryCycle === undefined) || publication?.jobId !== undefined
      && (!publication.check || publication.fileJobGuard?.kind !== 'history_files' || publication.fileJobGuard.id !== publication.jobId || publication.fileJobGuard.retryCycle !== publication.retryCycle))
      throw new Error('正文发布的恢复周期必须绑定准确原始作业及当前租约检查。');
    const operationId = publication?.jobId === undefined ? `memory:${note.id}:r${note.contentRevision}:${hash(note.content).slice(0, 16)}`
      : memoryFilePublicationOperation('memory', publication.jobId, publication.retryCycle!);
    const current = async () => {
      await publication?.check?.();
      const actual = (await session.request({ type: 'memory.library.read', companionId: note.companionId, id: note.id })).memoryRead?.memory;
      if (!actual || actual.version !== note.version || actual.contentRevision !== note.contentRevision || actual.artifactKind !== note.artifactKind || hash(actual.content) !== hash(note.content)) throw new Error('正文已变化、撤回或没有正式系统提交凭证。');
      return actual;
    };
    await current();
    const previous = await session.registry.get(`memory:${note.id}`, true);
    if (previous?.publicationState === 'committed') {
      try { await session.registry.read({ artifactId: previous.artifactId, consumer: 'audit' }); }
      catch (cause) {
        const pending = await session.registry.publication(operationId), item = pending?.items.length === 1 ? pending.items[0] : undefined;
        if (!pending || !['prepared', 'validated', 'file_published'].includes(pending.state) || item?.previous?.artifactId !== previous.artifactId
          || item.previous.contentRevision !== previous.contentRevision || item.previous.contentHash !== previous.contentHash || item.next.contentHash !== hash(note.content)
          || item.next.kind !== note.artifactKind || item.next.relativePath !== relative) throw cause;
        // Same operation only: Registry rechecks exact checkpoint bytes and
        // the host lease before resuming; unknown external bytes still fail.
      }
    }
    const sources = await session.registry.getMany(note.sources.map(source => `source:${source.messageId}:r${source.revision}`));
    const sourceRefs = note.sources.map(source => {
      const artifact = sources.find(item => item.artifactId === `source:${source.messageId}:r${source.revision}`);
      if (!artifact || artifact.kind !== 'source_evidence' || artifact.contentHash !== source.checksum) throw new Error('真实来源版本尚未正式登记，不能发布记忆。');
      return memoryArtifactReference(artifact);
    });
    const scope = (await session.request({ type: 'memory.library.scope.read', companionId: note.companionId })).conversation;
    if (!scope) throw new Error('正文发布缺少真实来源范围。');
    const descriptor = publication ?? (await session.request({ type: 'memory.revision.describe', companionId: note.companionId, conversationId: scope.id, id: note.id, contentRevision: note.contentRevision })).memoryHistoryDescriptor;
    if (!descriptor) throw new Error('正文修订历史尚未正式发布。');
    const dependencies = await session.registry.getMany(descriptor.dependencies.map(dependency => `history:${dependency.id}:r${dependency.contentRevision}`));
    const dependencyRefs = descriptor.dependencies.map(dependency => {
      const artifact = dependencies.find(item => item.artifactId === `history:${dependency.id}:r${dependency.contentRevision}`);
      if (!artifact || artifact.kind !== 'revision_history') throw new Error('派生记忆的准确历史依赖未登记。'); return memoryArtifactReference(artifact);
    });
    if (previous?.publicationState === 'committed' && previous.kind === note.artifactKind && previous.relativePath === relative && previous.contentHash === hash(note.content)
      && JSON.stringify(previous.sourceRefs) === JSON.stringify(sourceRefs) && JSON.stringify(previous.dependencyRefs) === JSON.stringify(dependencyRefs)) {
      await current();
      session.manifest.files[relative] = { artifact: previous, noteId: note.id, conversationId: note.sourceConversationId, version: note.version, hash: previous.contentHash, state: 'tracked' }; return;
    }
    await prepareMemoryFilePublication(session, operationId, this.options.report);
    const input = { artifactId: `memory:${note.id}`, kind: note.artifactKind, producer: { kind: 'system' as const, id: 'memory-commit' },
      relativePath: relative, expectedRevision: previous?.contentRevision ?? null, content: note.content, sourceRefs, dependencyRefs,
      visibility: { scope: 'owner' as const }, allowedConsumers: [...COMPANION_ARTIFACT_CONSUMERS[note.artifactKind]], retentionClass: 'current' as const,
      operationId };
    const validate = async () => { await current();
      for (const reference of sourceRefs) await session.registry.read({ artifactId: reference.artifactId, consumer: 'source_verification', audienceIds: [note.sourceConversationId] }); };
    const artifact = previous?.publicationState === 'revoked' ? await session.registry.publishRevalidatedMemory(input, validate, publication?.fileJobGuard)
      : await session.registry.publish(input, validate, publication?.fileJobGuard);
    session.manifest.files[relative] = { artifact, noteId: note.id, conversationId: note.sourceConversationId, version: note.version, hash: artifact.contentHash, state: 'tracked' };
    try { this.options.onPublished?.(note); } catch (cause) { this.options.report?.(cause); }
  }
  documentsWriting(owner: string): boolean { return this.tails.has(owner); }
  isPreparingOwnerFiles(owner: string): boolean { return this.preparing.has(owner); }
  ownerFilePreparationStatus(owner: string) { return { running: this.preparing.has(owner), global: { active: this.preparing.size, queued: 0, limit: 4 }, recent: [] }; }
  async prepareOwnerFiles(owner: string): Promise<void> {
    this.preparing.add(owner);
    try { await this.withDocuments(owner, session => session.registry.initialize(), { readOnly: true }); }
    finally { this.preparing.delete(owner); }
  }
  start(intervalMs = 5000): void {
    if (this.timer || this.closed) return;
    const tick = () => { this.timer = undefined; void this.sync().catch(this.options.report).finally(() => { if (!this.closed) { this.timer = setTimeout(tick, intervalMs); this.timer.unref(); } }); };
    this.timer = setTimeout(tick, intervalMs); this.timer.unref();
  }
  sync(): Promise<MemoryLibrarySyncReport> {
    if (this.running) return this.running;
    const pending = this.verifyRegistered(); this.running = pending; void pending.finally(() => { if (this.running === pending) this.running = undefined; }).catch(() => undefined); return pending;
  }
  private async verifyRegistered(): Promise<MemoryLibrarySyncReport> {
    const report: MemoryLibrarySyncReport = { exported: 0, imported: 0, forgotten: 0, conflicts: [] };
    if (this.closed) return report;
    const owners = (await this.call({ type: 'state', includeConversations: false })).state?.companions ?? [];
    for (let index = 0; index < Math.min(owners.length, this.options.maxOwnersPerSync ?? 4); index++) {
      const owner = owners[this.ownerCursor++ % owners.length]!;
      if (this.resetting.has(owner.id)) continue;
      try { await this.withDocuments(owner.id, async session => {
        const cleanup = await this.purgeSession(session, { limit: this.options.maxFilesPerOwner ?? 64, cursor: this.cleanupCursors.get(owner.id) });
        this.cleanupCursors.set(owner.id, cleanup.nextCursor); report.forgotten += cleanup.removed;
        report.conflicts.push(...cleanup.conflicts.map(conflict => ({ companionId: owner.id, ...conflict })));
        const page = await session.registry.page({ consumer: 'audit', afterId: this.verificationCursors.get(owner.id), limit: Math.max(1, Math.min(256, this.options.maxFilesPerOwner ?? 64)) });
        this.verificationCursors.set(owner.id, page.hasMore ? page.nextId : undefined);
        for (const artifact of page.items) {
          const entry = this.entry(artifact);
          try {
            await session.registry.read({ artifactId: entry.artifact.artifactId, consumer: 'audit' });
            if (entry.noteId && !await session.current(entry)) { await session.registry.revoke(entry.artifact.artifactId); report.forgotten++; }
          } catch (cause) { report.conflicts.push({ companionId: owner.id, file: entry.artifact.relativePath, message: cause instanceof Error ? cause.message : '已登记对象不可核实。' }); }
        }
      }); } catch (cause) { report.conflicts.push({ companionId: owner.id, file: owner.id, message: cause instanceof Error ? cause.message : '注册表不可核实。' }); }
    }
    return report;
  }
  /** Indexed, resumable privacy cleanup. Only formal revoked memory bodies
   * participate; current persona and role guidance use the retraction repair. */
  purgeRevoked(owner: string, input: { limit?: number; cursor?: MemoryBodyCleanupCursor } = {}): Promise<MemoryBodyCleanupResult> {
    return this.withDocuments(owner, session => this.purgeSession(session, input));
  }
  private async purgeSession(session: MemoryLibraryDocumentSession, input: { limit?: number; cursor?: MemoryBodyCleanupCursor }): Promise<MemoryBodyCleanupResult> {
    const kinds: CompanionArtifactKind[] = ['episode_memory', 'knowledge', 'procedure', 'self_understanding', 'navigation', 'dream_fiction'];
    const limit = Math.max(1, Math.min(256, input.limit ?? 64)), result: MemoryBodyCleanupResult = { removed: 0, checked: 0, pending: false, conflicts: [] };
    let kindIndex = input.cursor?.kindIndex ?? -1, afterId = input.cursor?.afterId;
    if (!Number.isSafeInteger(kindIndex) || kindIndex < -1 || kindIndex > kinds.length) throw new Error('记忆撤回清理游标无效。');
    if (kindIndex === -1) {
      for (;;) {
        const batchLimit = Math.min(16, limit - result.checked), publications = await session.registry.pendingPublications({ producerId: 'memory-commit', uncleanedOnly: true, afterOperationId: afterId, limit: batchLimit });
        for (const publication of publications) {
          result.checked++; afterId = publication.operationId;
          try {
            if (publication.ownerId !== session.owner.id || publication.items.length !== 1 || !kinds.includes(publication.items[0]!.next.kind) || !publication.operationId.startsWith('memory:')) throw new Error('记忆撤回事务归属不一致。');
            if (publication.state === 'revoked' || publication.state === 'cancelled') {
              const item = publication.items[0]!, registered = await session.registry.get(item.next.artifactId);
              if (registered && item.next.artifactId.startsWith('memory:')) {
                const current = (await session.request({ type: 'memory.library.read', companionId: session.owner.id, id: item.next.artifactId.slice('memory:'.length) })).memoryRead;
                if (!current) await session.registry.revoke(item.next.artifactId);
              }
              await session.registry.cancelPublication(publication.operationId); await session.registry.discardPublishedFiles(publication.operationId);
            }
            await session.registry.purgePublicationStages(publication.operationId);
          } catch (cause) { result.conflicts.push({ file: publication.items[0]?.next.relativePath ?? publication.operationId, message: cause instanceof Error ? cause.message : '撤回发布不可核实。' }); }
        }
        if (result.checked >= limit) return { ...result, pending: true, nextCursor: { kindIndex: -1, afterId } };
        if (publications.length < batchLimit) break;
      }
      kindIndex = 0; afterId = undefined;
    }
    for (; kindIndex < kinds.length; kindIndex++, afterId = undefined) {
      for (;;) {
        const page = await session.registry.page({ kind: kinds[kindIndex], publicationState: 'revoked', bodyCleanupRequired: true, afterId, limit: Math.min(256, limit - result.checked) });
        for (const artifact of page.items) {
          result.checked++; afterId = artifact.artifactId;
          try { const cleanup = await session.registry.purgeRevokedBody(artifact.artifactId); if (cleanup.removed) result.removed++; await session.registry.purgePublicationStages(artifact.operationId); }
          catch (cause) { result.conflicts.push({ file: artifact.relativePath, message: cause instanceof Error ? cause.message : '撤回文件不可核实。' }); }
        }
        if (result.checked >= limit) { const cursor = page.hasMore ? { kindIndex, afterId } : { kindIndex: kindIndex + 1 }; return { ...result, pending: cursor.kindIndex < kinds.length, ...(cursor.kindIndex < kinds.length ? { nextCursor: cursor } : {}) }; }
        if (!page.hasMore) break;
        afterId = page.nextId;
      }
    }
    return result;
  }
  async publishTimelines(scope: MemoryLibraryTimelineScope, artifacts: VcpMemoryTimelineArtifacts, stillValid: () => Promise<boolean>): Promise<void> {
    if (this.closed || artifacts.schema !== 'worldlinebox.vcp-timeline-artifacts' || !artifacts.sourceRevision || !await stillValid()) return;
    const generation = this.generations.get(scope.companionId) ?? 0;
    await this.withDocuments(scope.companionId, async session => {
      if (!sameCompanionMemoryIdentity(artifacts.owner, companionMemoryIdentity(session.owner))) throw new Error('导航来源身份无效。');
      for (const agent of artifacts.agents) {
        if (agent.agentName !== artifacts.owner?.agentName) throw new Error('导航不能混入其他伙伴。');
        for (const month of agent.months) {
          if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month.month)) throw new Error('导航月份无效。');
          for (const [suffix, body] of [['timeline', month.content], ['summary', month.summary]] as const) {
            if (body === undefined) continue;
            const content = '---\n' + JSON.stringify({ schema: 'worldlinebox.companion-navigation-v2', scope, sourceRevision: artifacts.sourceRevision }) + '\n---\n' + body;
            const version = hash(content).slice(0, 16), artifactId = `navigation:${scope.conversationId}:${month.month}:${suffix}:${version}`, previous = await session.registry.get(artifactId);
            if (previous) await session.registry.read({ artifactId, consumer: 'navigation' });
            await session.registry.publish({ artifactId, kind: 'navigation', producer: { kind: 'system', id: 'vcp-navigation' },
              relativePath: `记忆/导航/${scope.conversationId}/${month.month}-${suffix}-${version}.md`, expectedRevision: previous?.contentRevision ?? null,
              content, sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['navigation', 'audit'], retentionClass: 'current',
              operationId: `nav:${scope.conversationId}:${month.month}:${suffix}:${hash(content).slice(0, 16)}` }, async () => {
                if (this.closed || generation !== (this.generations.get(scope.companionId) ?? 0) || !await stillValid()) throw new Error('导航来源已变化，发布取消。');
              });
          }
        }
      }
    });
  }
  async invalidate(owner: string): Promise<void> {
    this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1);
    if (this.closed || this.resetting.has(owner)) return;
    await this.withDocuments(owner, async session => { let afterId: string | undefined; do { const page = await session.registry.page({ kind: 'navigation', afterId, limit: 256 }); for (const artifact of page.items) await session.registry.revoke(artifact.artifactId); afterId = page.hasMore ? page.nextId : undefined; } while (afterId); });
  }
  async reset(owner: string, jobId: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(owner)) throw new Error('伙伴归属无效。');
    this.resetting.add(owner); this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1);
    try { await this.running?.catch(() => undefined); await Promise.allSettled([this.tails.get(owner), ...this.readers]); await removeOwnedDirectory(this.options.libraryDirectory, owner, jobId); }
    finally { this.resetting.delete(owner); }
  }
  async close(): Promise<void> { this.closed = true; if (this.timer) clearTimeout(this.timer); await this.running?.catch(() => undefined); await Promise.allSettled([...this.tails.values(), ...this.readers]); }
}
