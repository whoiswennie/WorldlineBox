import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { VcpMemoryClient, type VcpMemoryClientOptions } from '../vcp-memory/client';
import type { VcpMemoryEmbeddingConfig } from '../vcp-memory/contracts';
import type { VcpMemoryPluginConfiguration } from '../vcp-memory/contracts';
import { ColdKnowledgeService, type ColdKnowledgeServiceOptions } from '../vcp-memory/cold-service';
import { removeOwnedDirectory } from '../vcp-memory/filesystem';
import { VcpMemoryProcessBroker } from '../vcp-memory/process-broker';
import type { CompanionModelConfig } from './model';
import { companionRuntimeOwner, companionOwnerRuntimePaths, companionOwnerRuntimeStorage, type CompanionOwnerRuntimeStorage, type CompanionOwnerRuntimePaths } from './owner-runtime-storage';

export type { CompanionOwnerRuntimeStorage, CompanionOwnerRuntimePaths } from './owner-runtime-storage';
export interface CompanionMemoryOwnerScope { ownerId: string; signal?: AbortSignal }
export interface CompanionEmbeddingLease { client: VcpMemoryClient; profileKey: string; release?(): Promise<void> }
export type CompanionColdLease = ColdKnowledgeService & { release?(): Promise<void> };

export interface CompanionGenerationSelection { ownerId: string; config: Readonly<CompanionModelConfig> }
export interface CompanionGenerationDescriptor { ownerId: string; profileKey: string }
export interface CompanionGenerationLease extends CompanionGenerationDescriptor {
  client: VcpMemoryClient; connectionEpoch: number; release(): Promise<void>;
}
export interface CompanionProjectionCleanup {
  /** Maintenance of one projection does not revoke other task snapshots. */
  projectionOnly?: boolean;
  /** Retire readers after ordinary revisions without deleting clean indexes. */
  preserveIndexes?: boolean;
  canonicalScopes?: readonly string[];
  historicalViews?: readonly { scopeId: string; profileKey: string }[];
}

export interface CompanionMemoryRuntime {
  /** Production runtimes can prepare plugins/graphs without a query or model call. */
  readonly supportsPreparation?: boolean;
  get(scope: CompanionMemoryOwnerScope): Promise<CompanionEmbeddingLease>;
  describeEmbedding?(): Promise<{ profileKey: string }>;
  describeGeneration?(input: CompanionGenerationSelection): Promise<CompanionGenerationDescriptor>;
  acquireGeneration?(input: CompanionGenerationSelection & { signal?: AbortSignal }): Promise<CompanionGenerationLease>;
  interruptOwner?(ownerId: string): Promise<void>;
  purgeOwner?(ownerId: string, scopes?: CompanionProjectionCleanup): Promise<void>;
  getCold?(scope: CompanionMemoryOwnerScope, authorize: ColdKnowledgeServiceOptions['authorize']): Promise<CompanionColdLease>;
  resetCold?(owner: string): Promise<void>;
  close(): Promise<void>;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const delay = () => new Promise<void>(resolve => setTimeout(resolve, 20));
const ownerIdentity = companionRuntimeOwner;
interface CoreEntry { key: string; ownerId: string; profileKey: string; connection: string; storage: CompanionOwnerRuntimeStorage;
  client: VcpMemoryClient; references: number; used: number; retiring?: Promise<void> }
interface ColdEntry { key: string; ownerId: string; profileKey: string; space: string; connection: string; storage: CompanionOwnerRuntimeStorage;
  service: ColdKnowledgeService; references: number; used: number; authorize: ColdKnowledgeServiceOptions['authorize']; retiring?: Promise<void> }
interface GenerationEntry {
  key: string; ownerId: string; profileKey: string; connection: string; connectionEpoch: number;
  client: VcpMemoryClient; references: number; used: number; dispose(): Promise<void>; retiring?: Promise<void>;
  storage: CompanionOwnerRuntimeStorage;
}
export interface CompanionVcpRuntimeOptions {
  vendorRoot: string; workerPath: string;
  resolveOwnerStorage(ownerId: string): Promise<CompanionOwnerRuntimeStorage>;
  resolveOwnerCleanupStorage(ownerId: string): Promise<CompanionOwnerRuntimePaths>;
  resolveEmbedding(): Promise<VcpMemoryEmbeddingConfig>;
  /** Retained only for source compatibility. Core operations never acquire chat. */
  resolvePlugins?(): Promise<VcpMemoryPluginConfiguration>;
  generationProfile?: unknown;
  resolveGenerationPlugins?(input: CompanionGenerationSelection & CompanionGenerationDescriptor): Promise<{ plugins: VcpMemoryPluginConfiguration; dispose(): Promise<void> }>;
  launch?: VcpMemoryClientOptions['launch'];
}

/** Embedding operations and trusted owner-generation leases have separate
 * identities. Every hot client shares one actual child-process budget. */
export class CompanionVcpRuntime implements CompanionMemoryRuntime {
  readonly supportsPreparation = true;
  private readonly cores = new Map<string, CoreEntry>();
  private readonly spaces = new Map<string, string>();
  private readonly generations = new Map<string, GenerationEntry>();
  private readonly ownerEpochs = new Map<string, number>();
  private readonly broker = new VcpMemoryProcessBroker(4);
  private connectionEpoch = 0;
  private readonly sensitiveEndpoints = new Map<string, string>();
  private readonly colds = new Map<string, ColdEntry>();
  private tail: Promise<unknown> = Promise.resolve();
  private generationTail: Promise<unknown> = Promise.resolve();
  private readonly generationAdmissions = new Set<Promise<unknown>>();
  private readonly coreAdmissions = new Set<Promise<unknown>>();
  private readonly ownerPurges = new Map<string, Promise<void>>();
  private closed = false;
  constructor(private readonly options: CompanionVcpRuntimeOptions) {}
  private async storage(ownerId: string): Promise<CompanionOwnerRuntimeStorage> {
    return companionOwnerRuntimeStorage(ownerId, await this.options.resolveOwnerStorage(ownerId));
  }
  private async cleanupStorage(ownerId: string): Promise<CompanionOwnerRuntimePaths> {
    return companionOwnerRuntimePaths(ownerId, await this.options.resolveOwnerCleanupStorage(ownerId));
  }
  private track<T>(pending: Promise<T>, set = this.coreAdmissions): Promise<T> {
    set.add(pending); void pending.finally(() => set.delete(pending)).catch(() => undefined); return pending;
  }
  private async embedding() {
    const embedding = { ...await this.options.resolveEmbedding() };
    if (this.closed) throw new Error('记忆服务已关闭。');
    const profileKey = embedding.modelSignature ?? (embedding.model + ':' + embedding.dimension);
    const space = JSON.stringify([embedding.model, embedding.dimension, embedding.modelSignature ?? null]);
    if (this.spaces.has(profileKey) && this.spaces.get(profileKey) !== space) throw new Error('向量模型或维度已变化，语义空间签名必须同步更新。');
    this.spaces.set(profileKey, space);
    return { embedding, profileKey };
  }
  async describeEmbedding(): Promise<{ profileKey: string }> {
    if (this.closed) throw new Error('记忆服务已关闭。');
    return { profileKey: (await this.embedding()).profileKey };
  }
  private snapshot(input: CompanionGenerationSelection): CompanionGenerationSelection {
    return { ownerId: ownerIdentity(input.ownerId), config: Object.freeze({ apiFormat: input.config.apiFormat,
      model: input.config.model, baseUrl: input.config.baseUrl, apiKey: input.config.apiKey }) };
  }
  private semanticEndpoint(raw: string | undefined): string | null {
    if (!raw) return null;
    // Secret-bearing endpoint variations still invalidate semantic caches, but
    // their digest never becomes a public evidence identity. Such endpoints
    // receive a process-local opaque identity (a restart safely rebuilds them).
    let sensitive: boolean;
    try { const url = new URL(raw); sensitive = !!url.username || !!url.password || !!url.search || !!url.hash; } catch { sensitive = true; }
    if (!sensitive) return raw;
    const key = digest(raw); let identity = this.sensitiveEndpoints.get(key);
    if (!identity) { identity = 'opaque-endpoint-' + randomUUID(); this.sensitiveEndpoints.set(key, identity); }
    return identity;
  }
  private async generationDescription(input: CompanionGenerationSelection) {
    const selection = this.snapshot(input), core = await this.embedding();
    const semantic = { adapter: 'owner-generation-v1', apiFormat: selection.config.apiFormat, model: selection.config.model,
      endpoint: this.semanticEndpoint(selection.config.baseUrl), generation: this.options.generationProfile ?? null };
    const profileKey = core.profileKey + ':owner-generation-v1-' + digest(JSON.stringify(semantic)).slice(0, 20);
    return { ...core, selection, profileKey, connection: digest(JSON.stringify({ embedding: core.embedding, config: selection.config })) };
  }
  async describeGeneration(input: CompanionGenerationSelection): Promise<CompanionGenerationDescriptor> {
    if (this.closed) throw new Error('记忆服务已关闭。');
    const description = await this.generationDescription(input);
    return { ownerId: description.selection.ownerId, profileKey: description.profileKey };
  }
  private retireCore(entry: CoreEntry): Promise<void> { return entry.retiring ??= entry.client.close().then(() => {
    if (this.cores.get(entry.key) === entry) this.cores.delete(entry.key);
  }); }
  private coreLease(entry: CoreEntry): CompanionEmbeddingLease {
    entry.references++; entry.used = Date.now(); let released = false;
    return { client: entry.client, profileKey: entry.profileKey, release: async () => { if (!released) { released = true; entry.references--; entry.used = Date.now(); } } };
  }
  get(scope: CompanionMemoryOwnerScope): Promise<CompanionEmbeddingLease> {
    const ownerId = ownerIdentity(scope.ownerId), epoch = this.ownerEpochs.get(ownerId) ?? 0, deadline = Date.now() + 180_000;
    const current = () => { scope.signal?.throwIfAborted(); if (this.closed) throw new Error('记忆服务已关闭。');
      if ((this.ownerEpochs.get(ownerId) ?? 0) !== epoch) throw new Error('伙伴记忆已取消。'); if (Date.now() >= deadline) throw new Error('伙伴记忆连接池仍然繁忙。'); };
    return this.track(Promise.resolve().then(async () => {
      current(); const { embedding, profileKey } = await this.embedding(), storage = await this.storage(ownerId); current();
      const connection = digest(JSON.stringify(embedding)), key = ownerId + ':' + profileKey;
      const existing = this.cores.get(key);
      if (existing && !existing.retiring && existing.connection === connection && existing.storage.indexRoot === storage.indexRoot && !this.ownerPurges.has(ownerId)) {
        existing.client.setOwnerPrompts(storage.ownerPrompts); existing.storage = storage; return this.coreLease(existing);
      }
      const pending = this.tail.then(async () => {
        while (this.ownerPurges.has(ownerId)) { current(); await delay(); } current();
        let entry = this.cores.get(key);
        if (entry && (entry.retiring || entry.connection !== connection || entry.storage.indexRoot !== storage.indexRoot)) {
          await this.retireCore(entry); while (entry.references) { current(); await delay(); } entry = undefined;
        }
        if (!entry) {
          for (const idle of [...this.cores.values()].filter(value => value.ownerId === ownerId && value.profileKey !== profileKey && !value.references && !value.retiring))
            await this.retireCore(idle);
          while (this.cores.size >= 4) {
            current(); const idle = [...this.cores.values()].filter(value => !value.references && !value.retiring).sort((a,b) => a.used-b.used)[0];
            if (idle) { await this.retireCore(idle); continue; } await delay();
          }
          current(); const actual = await this.storage(ownerId); current();
          if (actual.indexRoot !== storage.indexRoot) throw new Error('伙伴资产目录在连接期间发生变化。');
          const client = new VcpMemoryClient({ dataRoot: path.join(storage.indexRoot, 'hot', digest(profileKey)), vendorRoot: this.options.vendorRoot,
            boundOwnerId: ownerId,
            preparedRecallBudget: { workspaceRoot: storage.workspaceRoot }, workerPath: this.options.workerPath, embedding,
            plugins: { ownerPrompts: storage.ownerPrompts }, processBroker: this.broker, launch: this.options.launch, maxOpenScopes: 4 });
          entry = { key, ownerId, profileKey, connection, storage, client, references: 0, used: Date.now() }; this.cores.set(key, entry);
        }
        current(); entry.client.setOwnerPrompts(storage.ownerPrompts); entry.storage = storage; return this.coreLease(entry);
      }); this.tail = pending.catch(() => undefined); return pending;
    }));
  }
  private retireEntry(entry: GenerationEntry): Promise<void> {
    return entry.retiring ??= (async () => {
      const results = await Promise.allSettled([entry.dispose(), entry.client.close()]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      if (this.generations.get(entry.key) === entry) this.generations.delete(entry.key);
    })();
  }
  private leaseEntry(entry: GenerationEntry): CompanionGenerationLease {
    entry.references++; entry.used = Date.now(); let released = false;
    return { ownerId: entry.ownerId, profileKey: entry.profileKey, connectionEpoch: entry.connectionEpoch, client: entry.client,
      release: async () => { if (released) return; released = true; entry.references--; entry.used = Date.now(); } };
  }
  acquireGeneration(input: CompanionGenerationSelection & { signal?: AbortSignal }): Promise<CompanionGenerationLease> {
    const selection = this.snapshot(input), epoch = this.ownerEpochs.get(selection.ownerId) ?? 0, deadline = Date.now() + 180_000;
    const current = () => { input.signal?.throwIfAborted();
      if (this.closed) throw new Error('记忆服务已关闭。');
      if ((this.ownerEpochs.get(selection.ownerId) ?? 0) !== epoch) throw new Error('伙伴生成已取消。');
      if (Date.now() >= deadline) throw new Error('伙伴生成连接池仍然繁忙。'); };
    const pending = Promise.resolve().then(async () => {
      current(); const description = await this.generationDescription(selection), storage = await this.storage(selection.ownerId); current();
      const existing = this.generations.get(selection.ownerId + ':' + description.profileKey);
      // A fifth owner waiting for a free generation slot must not stop an
      // already configured owner from reusing its route. Only new/rotated
      // routes join the exclusive admission tail; their writer exclusion is
      // unchanged, including retirement and outstanding old leases.
      if (existing && !existing.retiring && existing.connection === description.connection && existing.storage.indexRoot === storage.indexRoot && !this.ownerPurges.has(selection.ownerId)) {
        existing.client.setOwnerPrompts(storage.ownerPrompts); existing.storage = storage; return this.leaseEntry(existing);
      }
      const queued = this.generationTail.then(async () => {
        while (this.ownerPurges.has(selection.ownerId)) { current(); await delay(); }
        current(); const description = await this.generationDescription(selection), storage = await this.storage(selection.ownerId); current();
        const key = selection.ownerId + ':' + description.profileKey;
        let entry = this.generations.get(key);
        if (entry && (entry.connection !== description.connection || entry.retiring || entry.storage.indexRoot !== storage.indexRoot)) {
          await this.retireEntry(entry);
          // Old lease holders cannot use the closed client. Wait for their
          // finally/release before admitting a new writer to the same root.
          while (entry.references) { current(); await delay(); }
          entry = undefined;
        }
        if (!entry) {
          while (this.generations.size >= 4) {
            current(); const idle = [...this.generations.values()].filter(value => !value.references && !value.retiring).sort((a,b) => a.used-b.used)[0];
            if (idle) { await this.retireEntry(idle); continue; }
            await delay();
          }
          current();
          if (!this.options.resolveGenerationPlugins) throw new Error('伙伴生成路由未配置。');
          const route = await this.options.resolveGenerationPlugins({ ...selection, profileKey: description.profileKey });
          try {
            current();
            const client = new VcpMemoryClient({ dataRoot: path.join(storage.indexRoot, 'generation', digest(description.profileKey)),
              boundOwnerId: selection.ownerId,
              preparedRecallBudget: { workspaceRoot: storage.workspaceRoot },
              vendorRoot: this.options.vendorRoot, workerPath: this.options.workerPath, embedding: description.embedding,
              plugins: { ...route.plugins, ownerPrompts: storage.ownerPrompts }, processBroker: this.broker, launch: this.options.launch, maxOpenScopes: 4 });
            entry = { key, ownerId: selection.ownerId, profileKey: description.profileKey, connection: description.connection,
              connectionEpoch: ++this.connectionEpoch, client, references: 0, used: Date.now(), dispose: route.dispose, storage };
            this.generations.set(key, entry);
          } catch (error) { await route.dispose(); throw error; }
        }
        current(); entry.client.setOwnerPrompts(storage.ownerPrompts); entry.storage = storage; return this.leaseEntry(entry);
      });
      this.generationTail = queued.catch(() => undefined); return queued;
    });
    this.generationAdmissions.add(pending);
    void pending.then(() => this.generationAdmissions.delete(pending), () => this.generationAdmissions.delete(pending));
    return pending;
  }
  async interruptOwner(ownerId: string): Promise<void> {
    ownerIdentity(ownerId); this.ownerEpochs.set(ownerId, (this.ownerEpochs.get(ownerId) ?? 0) + 1);
    const results = await Promise.allSettled([
      ...[...this.generations.values()].filter(entry => entry.ownerId === ownerId).map(entry => this.retireEntry(entry)),
      ...[...this.cores.values()].filter(entry => entry.ownerId === ownerId).map(entry => this.retireCore(entry)),
      ...[...this.colds.values()].filter(entry => entry.ownerId === ownerId).map(entry => this.retireCold(entry)),
    ]);
    const failure = results.find(result => result.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
  }
  purgeOwner(ownerId: string, scopes: CompanionProjectionCleanup = {}): Promise<void> {
    ownerIdentity(ownerId);
    const interrupt = scopes.projectionOnly ? (async () => {
      for (const entry of [...this.cores.values(), ...this.generations.values()].filter(entry => entry.ownerId === ownerId)) {
        const scopeIds = new Set(scopes.canonicalScopes ?? []);
        for (const pair of scopes.historicalViews ?? []) if (pair.profileKey === entry.profileKey) scopeIds.add(pair.scopeId);
        for (const scopeId of scopeIds) { await entry.client.interruptScope({ scopeId }); await entry.client.purgeScope({ scopeId }); }
      }
    })() : this.interruptOwner(ownerId);
    const pending = this.tail.then(async () => {
      await interrupt;
      const storage = await this.cleanupStorage(ownerId);
      for (const pair of scopes.historicalViews ?? []) {
        if (!pair.profileKey || !pair.scopeId || pair.scopeId.length > 4096) throw new Error('历史记忆范围无效。');
      }
      const canonical = scopes.canonicalScopes ?? [];
      if (canonical.some(value => !value || value.length > 4096)) throw new Error('记忆范围无效。');
      for (const lane of ['hot', 'generation']) {
        const base = path.join(storage.indexRoot, lane);
        if (!await this.directory(storage, base)) continue;
        if (!scopes.preserveIndexes && !scopes.projectionOnly) { await removeOwnedDirectory(base); continue; }
        for (const profileHash of await readdir(base)) {
          if (!/^[a-f0-9]{64}$/u.test(profileHash)) continue;
          const profile = path.join(base, profileHash); if (!await this.directory(storage, profile)) continue;
          const scopeHashes = new Set(canonical.map(value => digest(value)));
          for (const pair of scopes.historicalViews ?? []) if (digest(pair.profileKey) === profileHash) scopeHashes.add(digest(pair.scopeId));
          for (const scopeHash of scopeHashes) { const target = path.join(profile, scopeHash);
            if (await this.directory(storage, target)) await removeOwnedDirectory(target); }
        }
      }
    });
    this.ownerPurges.set(ownerId, pending);
    void pending.then(() => { if (this.ownerPurges.get(ownerId) === pending) this.ownerPurges.delete(ownerId); },
      () => { if (this.ownerPurges.get(ownerId) === pending) this.ownerPurges.delete(ownerId); });
    this.tail = pending.catch(() => undefined); return pending;
  }
  private retireCold(entry: ColdEntry): Promise<void> { return entry.retiring ??= entry.service.close().then(() => {
    if (this.colds.get(entry.key) === entry) this.colds.delete(entry.key);
  }); }
  private coldLease(entry: ColdEntry): CompanionColdLease {
    entry.references++; entry.used = Date.now(); let released = false;
    const release = async () => { if (!released) { released = true; entry.references--; entry.used = Date.now(); } };
    return new Proxy(entry.service, { get(target, property) {
      if (property === 'release') return release;
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  getCold(scope: CompanionMemoryOwnerScope, authorize: ColdKnowledgeServiceOptions['authorize']): Promise<CompanionColdLease> {
    const ownerId = ownerIdentity(scope.ownerId), epoch = this.ownerEpochs.get(ownerId) ?? 0, deadline = Date.now() + 180_000;
    const current = () => { scope.signal?.throwIfAborted(); if (this.closed) throw new Error('冷知识服务已关闭。');
      if ((this.ownerEpochs.get(ownerId) ?? 0) !== epoch) throw new Error('伙伴知识已取消。'); if (Date.now() >= deadline) throw new Error('伙伴知识连接池仍然繁忙。'); };
    return this.track(Promise.resolve().then(async () => {
      current(); const { embedding, profileKey } = await this.embedding(), storage = await this.storage(ownerId); current();
      const space = JSON.stringify([embedding.model, embedding.dimension, embedding.modelSignature ?? null]), connection = digest(JSON.stringify(embedding));
      const key = ownerId + ':' + profileKey, existing = this.colds.get(key);
      if (existing && !existing.retiring && existing.connection === connection && existing.storage.indexRoot === storage.indexRoot && !this.ownerPurges.has(ownerId)) {
        existing.authorize = authorize; return this.coldLease(existing);
      }
      const pending = this.tail.then(async () => {
        while (this.ownerPurges.has(ownerId)) { current(); await delay(); } current(); let entry = this.colds.get(key);
        if (entry && (entry.retiring || entry.connection !== connection || entry.storage.indexRoot !== storage.indexRoot)) {
          await this.retireCold(entry); while (entry.references) { current(); await delay(); } entry = undefined;
        }
        if (!entry) {
          while (this.colds.size >= 4) { current(); const idle = [...this.colds.values()].filter(value => !value.references && !value.retiring).sort((a,b) => a.used-b.used)[0];
            if (idle) { await this.retireCold(idle); continue; } await delay(); }
          current(); const actual = await this.storage(ownerId); current();
          if (actual.indexRoot !== storage.indexRoot) throw new Error('伙伴知识资产目录在连接期间发生变化。');
          const local: ColdEntry = { key, ownerId, profileKey, space, connection, storage, references: 0, used: Date.now(), authorize, service: undefined! };
          local.service = new ColdKnowledgeService({ dataRoot: path.join(storage.indexRoot, 'cold', digest(space)), boundOwnerId: ownerId,
            vendorRoot: this.options.vendorRoot, workerPath: path.join(path.dirname(this.options.workerPath), 'cold-worker.cjs'), embedding, launch: this.options.launch,
            authorize: (...args) => local.authorize(...args) });
          this.colds.set(key, local); entry = local;
        }
        current(); entry.authorize = authorize; return this.coldLease(entry);
      }); this.tail = pending.catch(() => undefined); return pending;
    }));
  }
  private async directory(storage: CompanionOwnerRuntimePaths, target: string): Promise<boolean> {
    const relative = path.relative(storage.indexRoot, target);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('记忆清理路径超出伙伴目录。');
    for (const file of [storage.workspaceRoot, storage.ownerRoot, storage.indexRoot,
      ...relative.split(path.sep).filter(Boolean).map((_, index, parts) => path.join(storage.indexRoot, ...parts.slice(0, index + 1)))]) {
      try { const entry = await lstat(file); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('记忆清理目录必须为实际拥有的文件夹。'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    } return true;
  }
  /** Owner reset spans every historical embedding profile and works without a
   * configured encoder. The root and each ancestor must be owned real folders. */
  resetCold(owner: string): Promise<void> {
    ownerIdentity(owner);
    const pending = this.tail.then(async () => {
      await Promise.all([...this.colds.values()].filter(entry => entry.ownerId === owner).map(entry => this.retireCold(entry)));
      const storage = await this.cleanupStorage(owner), target = path.join(storage.indexRoot, 'cold');
      if (await this.directory(storage, target)) await removeOwnedDirectory(target);
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([this.tail, this.generationTail, ...[...this.generationAdmissions, ...this.coreAdmissions].map(pending => pending.catch(() => undefined))]);
    const results = await Promise.allSettled([
      ...[...this.cores.values()].map(entry => this.retireCore(entry)), ...[...this.colds.values()].map(entry => this.retireCold(entry)),
      ...[...this.generations.values()].map(entry => this.retireEntry(entry)),
    ]);
    await this.broker.close();
    const failure = results.find(result => result.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
  }
}
