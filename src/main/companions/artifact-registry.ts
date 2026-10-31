import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { companionArtifactIdSchema, companionArtifactPathMatchesKind, companionArtifactPathSchema, companionArtifactSchema,
  type CompanionArtifact, type CompanionArtifactConsumer, type CompanionArtifactKind, type CompanionArtifactReference } from '../../shared/companion-artifact';
import { companionRegistryPublicationSchema, type CompanionRegistryPublication, type CompanionRegistryStorageCommand, type CompanionFilePublicationGuard, type CompanionPublicationBusy } from '../../shared/companion-registry-storage';
import type { CompanionStorageResponse } from '../../shared/companion-storage';
import { CompanionModelAdmissionError } from './model-quota';
import { assertCompanionExecutionWitnessActive, memoCompanionExecutionWitnesses, withCompanionExecutionValidation } from './source-execution-evidence';

export interface CompanionRegistryStorage { request(command: CompanionRegistryStorageCommand): Promise<CompanionStorageResponse> }
export class CompanionArtifactError extends Error {
  constructor(readonly code: 'UNREGISTERED' | 'DENIED' | 'CONFLICT' | 'CHANGED' | 'MISSING' | 'INVALID' | 'UNSAFE' | 'BACKEND_REQUIRED', message: string) {
    super(message); this.name = 'CompanionArtifactError';
  }
}
/** Only a typed worker reservation conflict is retryable admission. Integrity,
 * payload/CAS conflicts and arbitrary port failures retain their hard errors. */
export class CompanionPublicationBusyError extends CompanionModelAdmissionError {
  constructor(readonly publicationBusy: CompanionPublicationBusy) {
    super('files_pending', '该对象或其准确依赖正在发布，稍后可重试；其它独立任务可以继续。'); this.name = 'CompanionPublicationBusyError';
  }
}
export const companionArtifactHash = (content: string | Uint8Array): string => createHash('sha256').update(content).digest('hex');
export function companionMemoryArtifactPath(kind: 'episode_memory' | 'knowledge' | 'procedure' | 'self_understanding' | 'navigation', notebook: string, noteId: string): string {
  const roots = { episode_memory: '经历', knowledge: '知识', procedure: '知识', self_understanding: '自我认识', navigation: '导航' };
  if (!notebook.trim() || notebook.length > 160) throw new CompanionArtifactError('INVALID', '记忆笔记本名称无效。');
  companionArtifactIdSchema.parse(noteId);
  // Logical notebook names are display data. A later classification change
  // must not move the registered identity or retain private names in paths.
  return companionArtifactPathSchema.parse(`记忆/${roots[kind]}/${encodeURIComponent(noteId)}.md`);
}
export type CompanionArtifactPublish = Omit<CompanionArtifact, 'schema' | 'ownerId' | 'contentRevision' | 'contentHash' | 'publicationState' | 'operationId' | 'committedAt'>
  & { expectedRevision: number | null; content: string | Uint8Array };
type PageOptions = { consumer?: CompanionArtifactConsumer; kind?: CompanionArtifactKind; prefix?: string; producerId?: string; newestFirst?: boolean;
  publicationState?: 'committed' | 'revoked'; bodyCleanupRequired?: boolean; includeRevoked?: boolean; afterId?: string; limit?: number };
const serial = new Map<string, Promise<unknown>>();
type RegistryWitness = { kind: 'artifact'; artifactId: string; artifact?: CompanionArtifact }
  | { kind: 'reference'; reference: CompanionArtifactReference } | { kind: 'file'; artifact: CompanionArtifact };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Indexed SQLite metadata is the sole registry authority. Files remain the
 * sole body authority. No full-owner JSON snapshot or template fallback exists. */
export class CompanionArtifactRegistry {
  constructor(readonly root: string, readonly ownerId: string, private readonly options: { registryStorage?: CompanionRegistryStorage } = {}) {
    if (!path.isAbsolute(root) || !/^[a-zA-Z0-9_-]{1,100}$/u.test(ownerId)) throw new CompanionArtifactError('UNSAFE', '实例路径或归属无效。');
  }
  private async request(command: CompanionRegistryStorageCommand): Promise<CompanionStorageResponse> {
    if (!this.options.registryStorage) throw new CompanionArtifactError('BACKEND_REQUIRED', '认知登记需要宿主SQLite元数据端口。');
    let response: CompanionStorageResponse;
    try { response = await this.options.registryStorage.request(command); }
    catch (error) { throw new CompanionArtifactError('CONFLICT', error instanceof Error ? error.message : String(error)); }
    if (!response.ok) throw new CompanionArtifactError('CONFLICT', response.error ?? '认知登记事务失败。');
    if (response.registryPublicationBusy) throw new CompanionPublicationBusyError(response.registryPublicationBusy);
    return response;
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.root), pending = (serial.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    serial.set(key, pending); void pending.finally(() => { if (serial.get(key) === pending) serial.delete(key); }).catch(() => undefined); return pending;
  }
  private async target(relative: string, createParents = false): Promise<string> {
    companionArtifactPathSchema.parse(relative); const base = await lstat(this.root);
    if (!base.isDirectory() || base.isSymbolicLink() || path.resolve(await realpath(this.root)) !== path.resolve(this.root)) throw new CompanionArtifactError('UNSAFE', '伙伴目录被替换或链接。');
    let directory = this.root;
    for (const segment of relative.split('/').slice(0, -1)) {
      directory = path.join(directory, segment);
      if (createParents) try { await mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || path.resolve(await realpath(directory)) !== path.resolve(directory)) throw new CompanionArtifactError('UNSAFE', '受管路径包含链接。');
    }
    return path.join(this.root, ...relative.split('/'));
  }
  private async bytes(relative: string, admitted?: (fileStamp: string) => void): Promise<Buffer> {
    const target = await this.target(relative), before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > 16 * 1024 * 1024) throw new CompanionArtifactError('UNSAFE', '受管对象不是合法单一文件或超过大小上限。');
    const bytes = await readFile(target), after = await lstat(target);
    if ([before.ino, before.size, before.mtimeMs, before.ctimeMs].join(':') !== [after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':')) throw new CompanionArtifactError('CHANGED', '读取期间正文变化。');
    admitted?.([after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':'));
    return bytes;
  }
  private async immutable(relative: string, content: string | Uint8Array): Promise<void> {
    const target = await this.target(relative, true); let handle;
    try { handle = await open(target, 'wx'); await handle.writeFile(content); await handle.sync(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (companionArtifactHash(await this.bytes(relative)) !== companionArtifactHash(content)) throw new CompanionArtifactError('CHANGED', '发布暂存文件已经变化。'); }
    finally { await handle?.close(); }
  }
  async initialize(): Promise<void> { await this.get('registry:initialization-probe'); }
  async get(artifactId: string, includeRevoked = false): Promise<CompanionArtifact | undefined> {
    return (await this.request({ type: 'cognition.registry.read', ownerId: this.ownerId, artifactId, includeRevoked })).registryArtifact;
  }
  async getMany(artifactIds: string[], includeRevoked = false): Promise<CompanionArtifact[]> {
    const found: CompanionArtifact[] = [], ids = [...new Set(artifactIds)];
    for (let offset = 0; offset < ids.length; offset += 256) found.push(...(await this.request({ type: 'cognition.registry.read', ownerId: this.ownerId,
      artifactIds: ids.slice(offset, offset + 256), includeRevoked })).registryArtifacts ?? []);
    return found;
  }
  async findByPath(relativePath: string, includeRevoked = false): Promise<CompanionArtifact | undefined> {
    return (await this.request({ type: 'cognition.registry.read', ownerId: this.ownerId, relativePath, includeRevoked })).registryArtifact;
  }
  async getManyByPaths(relativePaths: readonly string[], includeRevoked = false): Promise<CompanionArtifact[]> {
    const found: CompanionArtifact[] = [], paths = [...new Set(relativePaths)];
    for (let offset = 0; offset < paths.length; offset += 256) found.push(...(await this.request({ type: 'cognition.registry.read', ownerId: this.ownerId,
      relativePaths: paths.slice(offset, offset + 256), includeRevoked })).registryArtifacts ?? []);
    return found;
  }
  async validateReferences(references: readonly CompanionArtifactReference[]): Promise<boolean> {
    const unique = [...new Map(references.map(reference => [JSON.stringify(reference), reference])).values()];
    for (let offset = 0; offset < unique.length; offset += 512) if (!(await this.request({ type: 'cognition.registry.refs.validate', ownerId: this.ownerId,
      references: unique.slice(offset, offset + 512) })).registryReferencesValid) return false;
    return true;
  }
  private witnesses(keys: readonly string[], read: (keys: readonly string[]) => Promise<ReadonlyMap<string, RegistryWitness>>) {
    const storage = this.options.registryStorage;
    if (!storage) throw new CompanionArtifactError('BACKEND_REQUIRED', '认知登记需要宿主SQLite元数据端口。');
    // A finite gate owns its first admitted metadata. Unrelated publication
    // cannot change that input; every consumed object is rechecked fresh at
    // the final fence, and a change to that very object rejects the gate.
    return memoCompanionExecutionWitnesses(keys, { identity: storage.request,
      scope: JSON.stringify(['registry', this.ownerId, path.resolve(this.root)]), revision: () => 0, read,
      verify: entries => this.verifyWitnesses(entries.map(entry => entry.value)),
    });
  }
  private async admittedArtifacts(artifactIds: readonly string[], initial?: ReadonlyMap<string, CompanionArtifact>): Promise<CompanionArtifact[]> {
    const ids = [...new Set(artifactIds)], keys = ids.map(id => 'artifact:' + id);
    const values = await this.witnesses(keys, async missing => {
      const requested = missing.map(key => key.slice('artifact:'.length));
      const uncaptured = requested.filter(id => !initial?.has(id));
      const artifacts = new Map([...(initial ?? []), ...(await this.getMany(uncaptured, true)).map(artifact => [artifact.artifactId, artifact] as const)]);
      return new Map(missing.map(key => { const artifactId = key.slice('artifact:'.length); return [key, { kind: 'artifact' as const, artifactId, artifact: artifacts.get(artifactId) }]; }));
    });
    return keys.flatMap(key => { const witness = values.get(key)!; return witness.kind === 'artifact' && witness.artifact ? [witness.artifact] : []; });
  }
  private async admittedReferences(references: readonly CompanionArtifactReference[]): Promise<void> {
    const unique = new Map(references.map(reference => ['reference:' + JSON.stringify(reference), reference]));
    if (!unique.size) return;
    await this.witnesses([...unique.keys()], async missing => {
      const selected = missing.map(key => unique.get(key)!);
      if (!await this.validateReferences(selected)) throw new CompanionArtifactError('DENIED', '内容的来源闭包已撤回或失效。');
      return new Map(missing.map(key => [key, { kind: 'reference' as const, reference: unique.get(key)! }]));
    });
  }
  private async consumedFiles(artifacts: readonly CompanionArtifact[]): Promise<void> {
    const files = new Map(artifacts.map(artifact => ['file:' + JSON.stringify([artifact.artifactId, artifact.contentRevision, artifact.contentHash, artifact.relativePath]), artifact]));
    if (!files.size) return;
    await this.witnesses([...files.keys()], async keys => new Map(keys.map(key => [key, { kind: 'file' as const, artifact: files.get(key)! }])));
  }
  private async verifyWitnesses(witnesses: readonly RegistryWitness[]): Promise<void> {
    const metadata = witnesses.flatMap(witness => witness.kind === 'artifact' ? [witness] : witness.kind === 'file'
      ? [{ kind: 'artifact' as const, artifactId: witness.artifact.artifactId, artifact: witness.artifact }] : []);
    const ids = [...new Set(metadata.map(witness => witness.artifactId))];
    const references = [...new Map(witnesses.flatMap(witness => witness.kind === 'reference' ? [witness.reference] : [])
      .map(reference => [JSON.stringify(reference), reference])).values()];
    const verifyMetadata = async () => {
      assertCompanionExecutionWitnessActive();
      const current = new Map((await this.getMany(ids, true)).map(artifact => [artifact.artifactId, artifact]));
      assertCompanionExecutionWitnessActive();
      if (metadata.some(witness => !isDeepStrictEqual(current.get(witness.artifactId), witness.artifact)))
        throw new CompanionArtifactError('CHANGED', '读取期间认知登记的完整版本或权限已经变化。');
      if (!await this.validateReferences(references)) throw new CompanionArtifactError('DENIED', '读取期间内容的来源闭包已撤回或失效。');
    };
    await verifyMetadata();
    const files = [...new Map(witnesses.flatMap(witness => witness.kind === 'file' ? [witness.artifact] : [])
      .map(artifact => [JSON.stringify([artifact.relativePath, artifact.contentHash]), artifact])).values()];
    for (let offset = 0; offset < files.length; offset += 4) await Promise.all(files.slice(offset, offset + 4).map(async artifact => {
      assertCompanionExecutionWitnessActive();
      const bytes = await this.bytes(artifact.relativePath);
      assertCompanionExecutionWitnessActive();
      if (companionArtifactHash(bytes) !== artifact.contentHash)
        throw new CompanionArtifactError('CHANGED', '核验窗口结束前正式正文已经变化。');
    }));
    await verifyMetadata();
  }
  async page(options: PageOptions = {}): Promise<{ items: CompanionArtifact[]; hasMore: boolean; nextId?: string }> {
    return (await this.request({ type: 'cognition.registry.page', ownerId: this.ownerId, ...options })).registryPage ?? { items: [], hasMore: false };
  }
  async markBodyRemoved(input: Pick<CompanionArtifact, 'artifactId' | 'contentRevision' | 'contentHash'>): Promise<void> {
    await this.request({ type: 'cognition.registry.body-removed', ownerId: this.ownerId,
      artifactId: input.artifactId, contentRevision: input.contentRevision, contentHash: input.contentHash });
  }
  purgeRevokedBody(artifactId: string): Promise<{ removed: boolean }> {
    return this.serialized(async () => {
      const artifact = await this.get(artifactId, true);
      if (!artifact || artifact.publicationState !== 'revoked' || ['persona_current', 'role_guidance', 'origin_snapshot', 'host_metadata'].includes(artifact.kind))
        throw new CompanionArtifactError('DENIED', '只可精确清除已撤回的非人格正文；当前人格必须先修复。');
      let actual: Buffer | undefined;
      try { actual = await this.bytes(artifact.relativePath); } catch (error) { if (!missing(error)) throw error; }
      if (actual && companionArtifactHash(actual) !== artifact.contentHash) throw new CompanionArtifactError('CHANGED', '正文包含未知外改，保留冲突，未标记清理完成。');
      const current = await this.get(artifactId, true);
      if (!current || current.publicationState !== 'revoked' || current.contentRevision !== artifact.contentRevision || current.contentHash !== artifact.contentHash)
        throw new CompanionArtifactError('CONFLICT', '清理前正式版本已变化。');
      if (actual) await unlink(await this.target(artifact.relativePath)); await this.markBodyRemoved(artifact);
      return { removed: !!actual };
    });
  }
  /** A bounded first page. Large management scans must explicitly follow page cursors. */
  async list(consumer?: CompanionArtifactConsumer, options: Omit<PageOptions, 'consumer'> = {}): Promise<CompanionArtifact[]> { return (await this.page({ ...options, consumer })).items; }
  async versionToken(): Promise<string> {
    return companionArtifactHash(JSON.stringify((await this.getMany(['persona:current', 'host:fragments', 'host:prompts', 'host:policy', 'host:creation', 'host:instance'], true))
      .map(artifact => [artifact.artifactId, artifact.contentRevision, artifact.contentHash, artifact.publicationState]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))));
  }
  async retractionMetadata(): Promise<CompanionArtifact[]> {
    const primary = [...await this.getMany(['persona:current', 'host:fragments'], true), ...await this.list(undefined, { kind: 'role_guidance', includeRevoked: true, limit: 128 })];
    const refs = primary.flatMap(artifact => [...artifact.sourceRefs, ...artifact.dependencyRefs].map(reference => reference.artifactId));
    return [...new Map([...primary, ...await this.getMany(refs, true)].map(artifact => [artifact.artifactId, artifact])).values()];
  }
  private async pending(includeRevoked = false, artifactId?: string, baseRevision?: number): Promise<CompanionRegistryPublication[]> {
    return this.pendingPublications({ includeRevoked, artifactId, baseRevision, previousTarget: !!artifactId, limit: 16 });
  }
  async pendingPublications(options: { producerId?: string; operationPrefix?: string; includeRevoked?: boolean; uncleanedOnly?: boolean;
    artifactId?: string; baseRevision?: number; previousTarget?: boolean; afterOperationId?: string; limit?: number } = {}): Promise<CompanionRegistryPublication[]> {
    return (await this.request({ type: 'cognition.registry.publication.pending', ownerId: this.ownerId, ...options })).registryPending ?? [];
  }
  async hasInterruptedPersonaRetraction(): Promise<boolean> {
    const current = await this.get('persona:current', true);
    return !!current && (await this.pending(true, current.artifactId, current.contentRevision)).some(publication => publication.state === 'revoked'
      && publication.items.some(item => item.previous?.artifactId === current.artifactId && item.previous.contentRevision === current.contentRevision && item.previous.contentHash === current.contentHash));
  }
  async readForRetraction(artifactId: string): Promise<{ artifact: CompanionArtifact; text: string }> {
    const artifact = await this.get(artifactId, true);
    if (!artifact || !(artifact.kind === 'persona_current' || artifact.kind === 'role_guidance' || artifact.kind === 'host_metadata' && artifact.relativePath === 'profile.fragments.json'))
      throw new CompanionArtifactError('DENIED', '撤回修复只可核验当前人格及其片段/指导，不读取撤回的原始来源。');
    let bytes = await this.bytes(artifact.relativePath), actual = companionArtifactHash(bytes);
    if (actual !== artifact.contentHash) {
      const interrupted = (await this.pending(true, artifactId, artifact.contentRevision)).flatMap(publication => publication.items).find(item => item.previous?.artifactId === artifactId
        && item.previous.contentHash === artifact.contentHash && item.next.contentHash === actual && item.previousStage);
      if (!interrupted?.previousStage) throw new CompanionArtifactError('CHANGED', '当前正文不是合法提交或可核验的未完成发布字节。');
      bytes = await this.bytes(interrupted.previousStage); actual = companionArtifactHash(bytes);
      if (actual !== artifact.contentHash) throw new CompanionArtifactError('CHANGED', '准确当前版本的发布检查点已损坏。');
    }
    return { artifact, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  }
  async read(input: { artifactId: string; consumer: CompanionArtifactConsumer; audienceIds?: string[] }): Promise<{ artifact: CompanionArtifact; bytes: Buffer; text: string; fileStamp: string }> {
    return (await this.readMany([input]))[0]!;
  }
  /** One finite multi-file gate. Metadata and reference admission are batched;
   * every distinct body's canonical bytes are opened and hashed on every call. */
  async readMany(inputs: readonly { artifactId: string; consumer: CompanionArtifactConsumer; audienceIds?: string[] }[]): Promise<Array<{ artifact: CompanionArtifact; bytes: Buffer; text: string; fileStamp: string }>> {
    if (!inputs.length) return [];
    return withCompanionExecutionValidation(async () => this.readRegisteredMany(inputs,
      new Map((await this.admittedArtifacts(inputs.map(input => input.artifactId))).map(artifact => [artifact.artifactId, artifact]))));
  }
  /** Exact path lookup is metadata only; the same finite body/consumer gate as
   * readMany still opens every canonical file and brackets it with fresh SQL. */
  async readManyByPaths(relativePaths: readonly string[], consumerFor: (artifact: CompanionArtifact) => CompanionArtifactConsumer): Promise<Array<{ artifact: CompanionArtifact; bytes: Buffer; text: string; fileStamp: string }>> {
    if (!relativePaths.length) return [];
    return withCompanionExecutionValidation(async () => {
    const metadata = await this.getManyByPaths(relativePaths, true), byPath = new Map(metadata.map(artifact => [artifact.relativePath.toLocaleLowerCase('en-US'), artifact]));
    const inputs = relativePaths.map(relative => {
      const artifact = byPath.get(relative.toLocaleLowerCase('en-US'));
      if (!artifact) throw new CompanionArtifactError('UNREGISTERED', '内容未登记或已撤回。');
      return { artifactId: artifact.artifactId, consumer: consumerFor(artifact) };
    });
    return this.readRegisteredMany(inputs, new Map((await this.admittedArtifacts(inputs.map(input => input.artifactId),
      new Map(metadata.map(artifact => [artifact.artifactId, artifact])))).map(artifact => [artifact.artifactId, artifact])));
    });
  }
  private async readRegisteredMany(inputs: readonly { artifactId: string; consumer: CompanionArtifactConsumer; audienceIds?: string[] }[], artifacts: ReadonlyMap<string, CompanionArtifact>): Promise<Array<{ artifact: CompanionArtifact; bytes: Buffer; text: string; fileStamp: string }>> {
    const ids = [...new Set(inputs.map(input => input.artifactId))];
    for (const input of inputs) {
      const artifact = artifacts.get(input.artifactId);
      if (!artifact) throw new CompanionArtifactError('UNREGISTERED', '内容未登记或已撤回。');
      if (artifact.publicationState !== 'committed') throw new CompanionArtifactError('DENIED', '该内容已经撤回。');
      if (!artifact.allowedConsumers.includes(input.consumer)) throw new CompanionArtifactError('DENIED', '该消费者无权使用此类型。');
      const visibility = artifact.visibility;
      if (!['host', 'audit'].includes(input.consumer) && visibility.scope === 'audience'
        && (!input.audienceIds?.length || input.audienceIds.some(id => !visibility.audienceIds.includes(id)))) throw new CompanionArtifactError('DENIED', '内容对当前入口不可见。');
      if (!companionArtifactPathMatchesKind(artifact.kind, artifact.relativePath)) throw new CompanionArtifactError('INVALID', '登记类型与受管位置不符。');
    }
    const references = [...new Map([...artifacts.values()].flatMap(artifact => [...artifact.sourceRefs, ...artifact.dependencyRefs])
      .map(reference => [JSON.stringify(reference), reference])).values()];
    await this.admittedReferences(references);
    const roles = [...artifacts.values()].filter(artifact => artifact.kind === 'role_guidance');
    if (roles.length) {
      const profile = (await this.admittedArtifacts(['persona:current']))[0];
      if (!profile || roles.some(artifact => !artifact.dependencyRefs.some(reference => reference.artifactId === profile.artifactId
        && reference.contentRevision === profile.contentRevision && reference.contentHash === profile.contentHash)))
        throw new CompanionArtifactError('CONFLICT', '角色指导不是当前同版人格。');
    }
    const bodies = new Map<string, { bytes: Buffer; fileStamp: string }>();
    for (let offset = 0; offset < ids.length; offset += 4) await Promise.all(ids.slice(offset, offset + 4).map(async id => {
      assertCompanionExecutionWitnessActive();
      const artifact = artifacts.get(id)!; let fileStamp = '';
      const bytes = await this.bytes(artifact.relativePath, stamp => { fileStamp = stamp; });
      assertCompanionExecutionWitnessActive();
      if (companionArtifactHash(bytes) !== artifact.contentHash) throw new CompanionArtifactError('CHANGED', '正文不是合法提交字节，拒绝外部改写。');
      bodies.set(id, { bytes, fileStamp });
    }));
    await this.consumedFiles([...artifacts.values()]);
    const after = new Map((await this.admittedArtifacts(ids)).map(artifact => [artifact.artifactId, artifact]));
    for (const artifact of artifacts.values()) {
      const current = after.get(artifact.artifactId);
      if (!current || current.contentRevision !== artifact.contentRevision || current.contentHash !== artifact.contentHash)
        throw new CompanionArtifactError('CHANGED', '读取期间受管版本变化。');
    }
    await this.admittedReferences(references);
    return inputs.map(input => { const artifact = artifacts.get(input.artifactId)!, { bytes, fileStamp } = bodies.get(input.artifactId)!;
      return { artifact, bytes, fileStamp, text: artifact.kind === 'appearance' ? '' : new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; });
  }
  publish(input: CompanionArtifactPublish & { operationId: string; reason?: string }, validate?: () => Promise<void>, fileJobGuard?: CompanionFilePublicationGuard): Promise<CompanionArtifact> {
    const { operationId, reason, ...item } = input; return this.publishBatch({ operationId, reason, items: [item] }, validate, fileJobGuard).then(items => items[0]!);
  }
  publishBatch(input: { operationId: string; reason?: string; items: CompanionArtifactPublish[] }, validate?: () => Promise<void>, fileJobGuard?: CompanionFilePublicationGuard): Promise<CompanionArtifact[]> {
    return this.publishBatchAuthorized(input, validate, false, false, fileJobGuard);
  }
  publishRetractionBatch(input: { operationId: string; reason: string; items: CompanionArtifactPublish[] }, validate: () => Promise<void>): Promise<CompanionArtifact[]> {
    if (!validate) return Promise.reject(new CompanionArtifactError('DENIED', '撤回修复需要宿主核验。')); return this.publishBatchAuthorized(input, validate, true);
  }
  publishRevalidatedMemory(input: CompanionArtifactPublish & { operationId: string }, validate: () => Promise<void>, fileJobGuard?: CompanionFilePublicationGuard): Promise<CompanionArtifact> {
    if (!validate) return Promise.reject(new CompanionArtifactError('DENIED', '记忆重新收录需要正式宿主复核。'));
    const { operationId, ...item } = input;
    return this.publishBatchAuthorized({ operationId, items: [item] }, validate, false, true, fileJobGuard).then(items => items[0]!);
  }
  private publishBatchAuthorized(input: { operationId: string; reason?: string; items: CompanionArtifactPublish[] }, validate: (() => Promise<void>) | undefined, retraction: boolean, memoryRevalidation = false, fileJobGuard?: CompanionFilePublicationGuard): Promise<CompanionArtifact[]> {
    return this.serialized(async () => {
      companionArtifactIdSchema.parse(input.operationId);
      if (!input.items.length || input.items.length > 128) throw new CompanionArtifactError('INVALID', '发布包超过对象数量限制。');
      if (!retraction && !validate && input.items.some(item => ['persona_current', 'role_guidance'].includes(item.kind) && item.producer.kind !== 'creation')) throw new CompanionArtifactError('DENIED', '人格系统发布必须经过宿主核验。');
      const requestHash = companionArtifactHash(JSON.stringify(input.items.map(({ content, ...metadata }) => ({ ...metadata, contentHash: companionArtifactHash(content) }))));
      const previousOperation = await this.publication(input.operationId);
      if (previousOperation) {
        if (previousOperation.requestHash !== requestHash) throw new CompanionArtifactError('CONFLICT', '幂等操作已绑定不同内容。');
        if (previousOperation.state === 'committed') {
          const actual = await this.getMany(previousOperation.items.map(item => item.next.artifactId));
          if (previousOperation.items.some(item => !actual.some(artifact => artifact.artifactId === item.next.artifactId && artifact.contentRevision === item.next.contentRevision && artifact.contentHash === item.next.contentHash)))
            throw new CompanionArtifactError('CONFLICT', '该操作已经被新版取代或撤回。');
          return previousOperation.items.map(item => item.next);
        }
        await this.ensureStages(previousOperation, input.items, validate); return this.resume(previousOperation, validate, fileJobGuard);
      }
      // Check known in-flight writes before reading the previous canonical
      // bytes: a validated replacement is busy, not an external modification.
      await this.request({ type: 'cognition.registry.publication.check', ownerId: this.ownerId, operationId: input.operationId,
        creation: input.items.every(item => item.producer.kind === 'creation'), targets: input.items.map(item => ({ artifactId: item.artifactId,
          relativePath: item.relativePath, sourceRefs: item.sourceRefs, dependencyRefs: item.dependencyRefs })) });
      const items: CompanionRegistryPublication['items'] = [], now = new Date().toISOString(); let batchBytes = 0;
      for (const inputItem of input.items) {
        if (!companionArtifactPathMatchesKind(inputItem.kind, inputItem.relativePath)) throw new CompanionArtifactError('INVALID', '对象类型与受管位置不符。');
        if (inputItem.kind === 'source_evidence' && inputItem.producer.kind !== 'host') throw new CompanionArtifactError('DENIED', '原始来源只能由宿主登记。');
        const previous = await this.get(inputItem.artifactId, true);
        if ((previous?.contentRevision ?? null) !== inputItem.expectedRevision || !retraction && !memoryRevalidation && previous?.publicationState === 'revoked') throw new CompanionArtifactError('CONFLICT', '对象CAS版本已变化或撤回。');
        if (Buffer.byteLength(inputItem.content) > 16 * 1024 * 1024) throw new CompanionArtifactError('INVALID', '正文超过大小上限。');
        batchBytes += Buffer.byteLength(inputItem.content);
        const { content, expectedRevision: _expected, ...metadata } = inputItem; void _expected;
        const next = companionArtifactSchema.parse({ ...metadata, schema: 'worldlinebox.companion-artifact-v2', ownerId: this.ownerId,
          contentRevision: (previous?.contentRevision ?? 0) + 1, contentHash: companionArtifactHash(content), publicationState: 'committed', operationId: input.operationId, committedAt: now });
        const stage = `.运行/发布/暂存/${randomUUID()}.bin`;
        let previousStage: string | undefined, expectedDiskHash: string | undefined, expectedAbsent: true | undefined;
        if (memoryRevalidation) {
          if (!previous || previous.publicationState !== 'revoked' || input.items.length !== 1) throw new CompanionArtifactError('DENIED', '重新收录只接受已经退役的准确记忆身份。');
          try { expectedDiskHash = companionArtifactHash(await this.bytes(previous.relativePath)); }
          catch (error) { if (!missing(error)) throw error; expectedAbsent = true; }
          if (expectedDiskHash !== undefined && expectedDiskHash !== previous.contentHash) throw new CompanionArtifactError('CHANGED', '旧受管路径存在未知字节，不能覆盖后重新收录。');
          // Retired private bytes are not copied into a rollback stage. The
          // new formal revision has its own current SQL/source authorization.
        } else if (previous) {
          const actual = await this.bytes(previous.relativePath); expectedDiskHash = companionArtifactHash(actual);
          const previousBytes = expectedDiskHash === previous.contentHash ? actual
            : retraction ? Buffer.from((await this.readForRetraction(previous.artifactId)).text, 'utf8') : undefined;
          if (!previousBytes || companionArtifactHash(previousBytes) !== previous.contentHash) throw new CompanionArtifactError('CHANGED', '当前正文不是合法CAS基线，不能从SQL重建正文。');
          batchBytes += previousBytes.byteLength; previousStage = `.运行/发布/暂存/${randomUUID()}.previous`;
        }
        if (batchBytes > 32 * 1024 * 1024) throw new CompanionArtifactError('INVALID', '发布包超过本轮正文及准确旧范围的32MiB资源预算。');
        items.push({ next, ...(previous ? { previous, previousStage, expectedDiskHash, expectedAbsent } : {}), stage });
      }
      const publication = companionRegistryPublicationSchema.parse({ ownerId: this.ownerId, operationId: input.operationId, state: 'prepared', requestHash, items,
        authorization: memoryRevalidation ? 'memory_revalidation' : retraction ? 'retraction' : input.items.every(item => item.producer.kind === 'creation') ? 'creation' : 'system',
        reason: input.reason ? `形成理由正文哈希sha256:${companionArtifactHash(input.reason)}` : '', createdAt: now });
      await validate?.();
      const prepared = (await this.request({ type: 'cognition.registry.publication.prepare', ownerId: this.ownerId, publication, ...(fileJobGuard ? { fileJobGuard } : {}) })).registryPublication;
      if (!prepared) throw new CompanionArtifactError('INVALID', '未获得耐久发布凭证。');
      await this.ensureStages(prepared, input.items, validate); return this.resume(prepared, validate, fileJobGuard);
    });
  }
  /** Intent is durable before private stage bytes are created. Missing stages
   * can only be filled from this same fixed call, never from a SQL body copy. */
  private async ensureStages(publication: CompanionRegistryPublication, inputs: CompanionArtifactPublish[], validate?: () => Promise<void>): Promise<void> {
    if (!['prepared', 'validated', 'file_published'].includes(publication.state)) throw new CompanionArtifactError('CONFLICT', '发布已经终止，不能重新写入暂存正文。');
    const gate = async () => {
      const current = await this.publication(publication.operationId);
      if (!current || !['prepared', 'validated', 'file_published'].includes(current.state)) {
        if (current && ['revoked', 'cancelled'].includes(current.state)) await this.cleanStages(current);
        throw new CompanionArtifactError('CONFLICT', '发布来源已撤回或操作已停止，不再写入结果正文。');
      }
    };
    for (const item of publication.items) {
      const input = inputs.find(value => value.artifactId === item.next.artifactId);
      if (!input || companionArtifactHash(input.content) !== item.next.contentHash) throw new CompanionArtifactError('CONFLICT', '重试内容与原固定提议不符。');
      await gate(); await validate?.();
      // Preserve the still-current body first, before any canonical replacement.
      if (item.previous && item.previousStage) {
        let previous: Buffer | undefined;
        try { previous = await this.bytes(item.previousStage); } catch (error) { if (!missing(error)) throw error; }
        if (!previous) {
          const actual = await this.bytes(item.previous.relativePath);
          previous = companionArtifactHash(actual) === item.previous.contentHash ? actual
            : publication.authorization === 'retraction' ? Buffer.from((await this.readForRetraction(item.previous.artifactId)).text, 'utf8') : undefined;
          if (!previous || companionArtifactHash(previous) !== item.previous.contentHash) throw new CompanionArtifactError('CHANGED', '准确当前旧范围缺失，不能从SQL或模板补造。');
          await this.immutable(item.previousStage, previous);
        } else if (companionArtifactHash(previous) !== item.previous.contentHash) throw new CompanionArtifactError('CHANGED', '固定旧范围检查点被外部改写。');
      }
      await this.immutable(item.stage, input.content); await gate();
    }
  }
  private async transition(publication: CompanionRegistryPublication, nextState: 'validated' | 'file_published' | 'conflict', fileJobGuard?: CompanionFilePublicationGuard): Promise<CompanionRegistryPublication> {
    return (await this.request({ type: 'cognition.registry.publication.transition', ownerId: this.ownerId, operationId: publication.operationId,
      expectedState: publication.state, nextState, ...(fileJobGuard ? { fileJobGuard } : {}) })).registryPublication!;
  }
  private async resume(initial: CompanionRegistryPublication, validate?: () => Promise<void>, fileJobGuard?: CompanionFilePublicationGuard): Promise<CompanionArtifact[]> {
    let publication = initial;
    if (!['prepared', 'validated', 'file_published'].includes(publication.state)) throw new CompanionArtifactError('CONFLICT', '已终结发布不能重放。');
    if (!validate && publication.items.some(item => ['persona_current', 'role_guidance'].includes(item.next.kind) && item.next.producer.kind !== 'creation')) throw new CompanionArtifactError('DENIED', '人格恢复必须重新核验。');
    await validate?.(); if (publication.state === 'prepared') publication = await this.transition(publication, 'validated', fileJobGuard);
    for (const item of publication.items) {
      let actualHash: string | undefined;
      try { actualHash = companionArtifactHash(await this.bytes(item.next.relativePath)); } catch (error) { if (!missing(error)) throw error; }
      if (actualHash === item.next.contentHash) continue;
      if (actualHash !== (item.expectedAbsent ? undefined : item.expectedDiskHash ?? item.previous?.contentHash)) { await this.transition(publication, 'conflict', fileJobGuard); throw new CompanionArtifactError('CONFLICT', '发布目标出现未知字节，没有覆盖外部修改。'); }
      const bytes = await this.bytes(item.stage); if (companionArtifactHash(bytes) !== item.next.contentHash) throw new CompanionArtifactError('CHANGED', '暂存正文hash不符。');
      await validate?.(); const target = await this.target(item.next.relativePath, true), temporaryRelative = `.运行/发布/暂存/${randomUUID()}.replace`;
      await this.immutable(temporaryRelative, bytes); const temporary = await this.target(temporaryRelative);
      try {
        let before: string | undefined; try { before = companionArtifactHash(await this.bytes(item.next.relativePath)); } catch (error) { if (!missing(error)) throw error; }
        if (before !== (item.expectedAbsent ? undefined : item.expectedDiskHash ?? item.previous?.contentHash)) throw new CompanionArtifactError('CONFLICT', '发布前CAS失败。');
        await rename(temporary, target);
      } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
    }
    if (publication.state !== 'file_published') publication = await this.transition(publication, 'file_published', fileJobGuard);
    await validate?.();
    for (const item of publication.items) if (companionArtifactHash(await this.bytes(item.next.relativePath)) !== item.next.contentHash) throw new CompanionArtifactError('CHANGED', '提交前正文变化。');
    const committed = (await this.request({ type: 'cognition.registry.publication.commit', ownerId: this.ownerId, operationId: publication.operationId, ...(fileJobGuard ? { fileJobGuard } : {}) })).registryPublication;
    if (!committed || committed.state !== 'committed') throw new CompanionArtifactError('CONFLICT', '未获得完成发布凭证。');
    await this.cleanStages(committed); return committed.items.map(item => item.next);
  }
  private async cleanStages(publication: CompanionRegistryPublication): Promise<void> {
    for (const item of publication.items) for (const [stage, expectedHash] of [[item.stage, item.next.contentHash], [item.previousStage, item.previous?.contentHash]]) {
      if (!stage || !expectedHash) continue;
      let bytes: Buffer; try { bytes = await this.bytes(stage); } catch (error) { if (missing(error)) continue; throw error; }
      if (companionArtifactHash(bytes) !== expectedHash) throw new CompanionArtifactError('CHANGED', '暂存文件出现未知字节，保留冲突而不删除。');
      await unlink(await this.target(stage));
    }
    await this.request({ type: 'cognition.registry.publication.stages-cleaned', ownerId: this.ownerId, operationId: publication.operationId });
  }
  recover(operationId: string, validate?: () => Promise<void>, fileJobGuard?: CompanionFilePublicationGuard): Promise<CompanionArtifact[]> {
    return this.serialized(async () => { const publication = await this.publication(operationId); if (!publication) throw new CompanionArtifactError('UNREGISTERED', '发布凭证不存在。');
      if (publication.state === 'committed') { await this.cleanStages(publication); return publication.items.map(item => item.next); }
      return this.resume(publication, validate, fileJobGuard); });
  }
  async publication(operationId: string): Promise<CompanionRegistryPublication | undefined> {
    return (await this.request({ type: 'cognition.registry.publication.read', ownerId: this.ownerId, operationId })).registryPublication;
  }
  /** Host recovery reads only an exact durable package's authenticated bytes.
   * This is not a content consumer and never authorizes a model projection. */
  async readPublicationItem(operationId: string, artifactId: string): Promise<{ artifact: CompanionArtifact; text: string }> {
    const publication = await this.publication(operationId), item = publication?.items.find(value => value.next.artifactId === artifactId);
    if (!publication || !item || !['prepared', 'validated', 'file_published'].includes(publication.state))
      throw new CompanionArtifactError('DENIED', '只能读取尚未终结的准确发布包。');
    let bytes: Buffer, usedCanonical = false;
    try { bytes = await this.bytes(item.stage); }
    catch (error) { if (!missing(error)) throw error; bytes = await this.bytes(item.next.relativePath); usedCanonical = true; }
    if (companionArtifactHash(bytes) !== item.next.contentHash) {
      if (usedCanonical && companionArtifactHash(bytes) === item.previous?.contentHash) throw new CompanionArtifactError('MISSING', '发布尚未写入固定的新正文。');
      throw new CompanionArtifactError('CHANGED', '恢复发布字节不匹配固定hash。');
    }
    const current = await this.publication(operationId);
    if (!current || !['prepared', 'validated', 'file_published'].includes(current.state)) throw new CompanionArtifactError('DENIED', '发布已撤回或终止。');
    return { artifact: item.next, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  }
  async cancelPublication(operationId: string): Promise<void> {
    const publication = await this.publication(operationId); if (!publication) return;
    if (publication.items.some(item => ['persona_current', 'role_guidance'].includes(item.next.kind))) throw new CompanionArtifactError('DENIED', '人格提议终止需要专用撤回修复。');
    if (['prepared', 'validated', 'file_published'].includes(publication.state)) await this.request({ type: 'cognition.registry.publication.transition', ownerId: this.ownerId,
      operationId, expectedState: publication.state, nextState: 'cancelled' });
    else if (!['revoked', 'cancelled'].includes(publication.state)) throw new CompanionArtifactError('DENIED', '已提交正文须先走正式撤回。');
  }
  async purgePublicationStages(operationId: string): Promise<void> {
    return this.serialized(async () => { const publication = await this.publication(operationId); if (!publication) return;
      if (publication.state === 'conflict') {
        // Same-state CAS is a worker authorization check against the real
        // file job's durable hold/newer cycle, before any stage is removed.
        await this.request({ type: 'cognition.registry.publication.transition', ownerId: this.ownerId, operationId, expectedState: 'conflict', nextState: 'conflict' });
      } else if (!['committed', 'revoked', 'cancelled'].includes(publication.state)) throw new CompanionArtifactError('DENIED', '发布尚在运行，不能清理检查点。');
      await this.cleanStages(publication); });
  }
  async discardPublishedFiles(operationId: string, options?: { validateMemoryRestore?(previous: CompanionArtifact): Promise<void> }): Promise<void> {
    return this.serialized(() => this.discardFiles(operationId, options));
  }
  private async discardFiles(operationId: string, options?: { validateMemoryRestore?(previous: CompanionArtifact): Promise<void> }): Promise<void> {
    const publication = await this.publication(operationId); if (!publication || !['revoked', 'cancelled'].includes(publication.state)) throw new CompanionArtifactError('DENIED', '只可丢弃已终止发布的非人格产物。');
    for (const item of publication.items) {
      if (!['context_snapshot', 'runtime_index', 'source_evidence', 'revision_history', 'episode_memory', 'knowledge', 'procedure',
        'self_understanding', 'navigation', 'dream_fiction', 'growth_publish'].includes(item.next.kind)) throw new CompanionArtifactError('DENIED', '该类型不能通过运行产物清理通道删除。');
      const current = await this.get(item.next.artifactId, true);
      let bytes: Buffer; try { bytes = await this.bytes(item.next.relativePath); } catch (error) { if (missing(error)) continue; throw error; }
      const actualHash = companionArtifactHash(bytes);
      if (current && actualHash === current.contentHash) continue;
      if (actualHash !== item.next.contentHash) throw new CompanionArtifactError('CHANGED', '非预期发布字节不会被清除。');
      if (current?.publicationState === 'committed') {
        const memoryRestore = item.next.producer.kind === 'system' && item.next.producer.id === 'memory-commit'
          && ['episode_memory', 'knowledge', 'procedure', 'self_understanding', 'navigation', 'dream_fiction'].includes(item.next.kind);
        if ((item.next.kind !== 'runtime_index' && !(memoryRestore && options?.validateMemoryRestore)) || !item.previous || !item.previousStage
          || current.contentHash !== item.previous.contentHash || current.contentRevision !== item.previous.contentRevision)
          throw new CompanionArtifactError('DENIED', '文件仍有正式当前版本引用，请先撤回对象。');
        const valid = async () => {
          const latest = await this.get(current.artifactId, true);
          if (!latest || latest.publicationState !== 'committed' || latest.contentRevision !== current.contentRevision || latest.contentHash !== current.contentHash)
            throw new CompanionArtifactError('DENIED', '准确当前版本已撤回或变化，不能恢复旧正文。');
          if (memoryRestore) {
            const references = [...current.sourceRefs, ...current.dependencyRefs];
            for (let offset = 0; offset < references.length; offset += 512) if (!(await this.request({ type: 'cognition.registry.refs.validate', ownerId: this.ownerId, references: references.slice(offset, offset + 512) })).registryReferencesValid)
              throw new CompanionArtifactError('DENIED', '旧正文来源闭包已撤回，不允许恢复。');
            await options!.validateMemoryRestore!(current);
          }
        };
        await valid();
        const previous = await this.bytes(item.previousStage);
        if (companionArtifactHash(previous) !== current.contentHash) throw new CompanionArtifactError('CHANGED', '准确当前索引的耐久检查点已变化，拒绝从SQL重建。');
        const temporaryPath = `.运行/发布/暂存/${randomUUID()}.restore`; await this.immutable(temporaryPath, previous);
        const temporary = await this.target(temporaryPath);
        try {
          if (companionArtifactHash(await this.bytes(item.next.relativePath)) !== item.next.contentHash) throw new CompanionArtifactError('CHANGED', '索引恢复前CAS失败。');
          await valid();
          await rename(temporary, await this.target(item.next.relativePath));
          try { await valid(); } catch (cause) {
            // A revocation during I/O cannot leave a restored private body.
            // Unknown concurrent external edits remain untouched.
            if (companionArtifactHash(await this.bytes(item.next.relativePath)) === current.contentHash) await unlink(await this.target(item.next.relativePath));
            throw cause;
          }
        } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
        continue;
      }
      await unlink(await this.target(item.next.relativePath));
    }
  }
  async purgeRetractedPublicationStages(): Promise<void> {
    for (let batch = 0; batch < 4; batch++) {
      const publications = (await this.request({ type: 'cognition.registry.publication.pending', ownerId: this.ownerId, uncleanedOnly: true, limit: 16 })).registryPending ?? [];
      if (!publications.length) return; for (const publication of publications) await this.cleanStages(publication);
    }
  }
  async revoke(artifactId: string): Promise<string[]> {
    return (await this.request({ type: 'cognition.registry.revoke', ownerId: this.ownerId, artifactId })).registryRevocation?.artifactIds ?? [];
  }
}
