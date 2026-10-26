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

export interface CompanionGenerationSelection { ownerId: string; config: Readonly<CompanionModelConfig> }
export interface CompanionGenerationDescriptor { ownerId: string; profileKey: string }
export interface CompanionGenerationLease extends CompanionGenerationDescriptor {
  client: VcpMemoryClient; connectionEpoch: number; release(): Promise<void>;
}
export interface CompanionProjectionCleanup {
  /** Retire readers after ordinary revisions without deleting clean indexes. */
  preserveIndexes?: boolean;
  canonicalScopes?: readonly string[];
  historicalViews?: readonly { scopeId: string; profileKey: string }[];
}

export interface CompanionMemoryRuntime {
  /** Production runtimes can prepare plugins/graphs without a query or model call. */
  readonly supportsPreparation?: boolean;
  get(): Promise<{ client: VcpMemoryClient; profileKey: string }>;
  describeEmbedding?(): Promise<{ profileKey: string }>;
  describeGeneration?(input: CompanionGenerationSelection): Promise<CompanionGenerationDescriptor>;
  acquireGeneration?(input: CompanionGenerationSelection & { signal?: AbortSignal }): Promise<CompanionGenerationLease>;
  interruptOwner?(ownerId: string): Promise<void>;
  purgeOwner?(ownerId: string, scopes?: CompanionProjectionCleanup): Promise<void>;
  getCold?(authorize: ColdKnowledgeServiceOptions['authorize']): Promise<ColdKnowledgeService>;
  resetCold?(owner: string): Promise<void>;
  close(): Promise<void>;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const delay = () => new Promise<void>(resolve => setTimeout(resolve, 20));
function ownerIdentity(owner: string): string {
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 100) throw new Error('生成所属伙伴无效。');
  return owner;
}
interface GenerationEntry {
  key: string; ownerId: string; profileKey: string; connection: string; connectionEpoch: number;
  client: VcpMemoryClient; references: number; used: number; dispose(): Promise<void>; retiring?: Promise<void>;
}
export interface CompanionVcpRuntimeOptions {
  dataRoot: string; vendorRoot: string; workerPath: string;
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
  private current?: { client: VcpMemoryClient; profileKey: string };
  private currentConnectionSignature?: string;
  private readonly spaces = new Map<string, string>();
  private readonly generations = new Map<string, GenerationEntry>();
  private readonly ownerEpochs = new Map<string, number>();
  private readonly broker = new VcpMemoryProcessBroker(4);
  private connectionEpoch = 0;
  private readonly sensitiveEndpoints = new Map<string, string>();
  private cold?: { service: ColdKnowledgeService; embeddingProfile: string; space: string; connectionSignature: string };
  private coldAuthorize?: ColdKnowledgeServiceOptions['authorize'];
  private tail: Promise<unknown> = Promise.resolve();
  private generationTail: Promise<unknown> = Promise.resolve();
  private readonly generationAdmissions = new Set<Promise<unknown>>();
  private readonly ownerPurges = new Map<string, Promise<void>>();
  private closed = false;
  constructor(private readonly options: CompanionVcpRuntimeOptions) {}
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
  get(): Promise<{ client: VcpMemoryClient; profileKey: string }> {
    const pending = this.tail.then(async () => {
      if (this.closed) throw new Error('记忆服务已关闭。');
      const { embedding, profileKey } = await this.embedding();
      const signature = digest(JSON.stringify(embedding));
      if (this.current?.profileKey === profileKey && this.currentConnectionSignature === signature) return this.current;
      // Transport refresh drains the old writer; it never erases historical
      // projections merely because a credential or loopback port changed.
      await this.current?.client.close(); this.current = undefined;
      if (this.closed) throw new Error('记忆服务已关闭。');
      const client = new VcpMemoryClient({ dataRoot: path.join(this.options.dataRoot, digest(profileKey)), vendorRoot: this.options.vendorRoot,
        workerPath: this.options.workerPath, embedding, processBroker: this.broker, launch: this.options.launch, maxOpenScopes: 4 });
      this.currentConnectionSignature = signature; return this.current = { client, profileKey };
    });
    this.tail = pending.catch(() => undefined); return pending;
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
      current(); const description = await this.generationDescription(selection); current();
      const existing = this.generations.get(selection.ownerId + ':' + description.profileKey);
      // A fifth owner waiting for a free generation slot must not stop an
      // already configured owner from reusing its route. Only new/rotated
      // routes join the exclusive admission tail; their writer exclusion is
      // unchanged, including retirement and outstanding old leases.
      if (existing && !existing.retiring && existing.connection === description.connection && !this.ownerPurges.has(selection.ownerId))
        return this.leaseEntry(existing);
      const queued = this.generationTail.then(async () => {
        while (this.ownerPurges.has(selection.ownerId)) { current(); await delay(); }
        current(); const description = await this.generationDescription(selection); current();
        const key = selection.ownerId + ':' + description.profileKey;
        let entry = this.generations.get(key);
        if (entry && (entry.connection !== description.connection || entry.retiring)) {
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
            const client = new VcpMemoryClient({ dataRoot: path.join(this.options.dataRoot, 'generation', digest(selection.ownerId), digest(description.profileKey)),
              vendorRoot: this.options.vendorRoot, workerPath: this.options.workerPath, embedding: description.embedding,
              plugins: route.plugins, processBroker: this.broker, launch: this.options.launch, maxOpenScopes: 4 });
            entry = { key, ownerId: selection.ownerId, profileKey: description.profileKey, connection: description.connection,
              connectionEpoch: ++this.connectionEpoch, client, references: 0, used: Date.now(), dispose: route.dispose };
            this.generations.set(key, entry);
          } catch (error) { await route.dispose(); throw error; }
        }
        current(); return this.leaseEntry(entry);
      });
      this.generationTail = queued.catch(() => undefined); return queued;
    });
    this.generationAdmissions.add(pending);
    void pending.then(() => this.generationAdmissions.delete(pending), () => this.generationAdmissions.delete(pending));
    return pending;
  }
  async interruptOwner(ownerId: string): Promise<void> {
    ownerIdentity(ownerId); this.ownerEpochs.set(ownerId, (this.ownerEpochs.get(ownerId) ?? 0) + 1);
    const results = await Promise.allSettled([...this.generations.values()].filter(entry => entry.ownerId === ownerId).map(entry => this.retireEntry(entry)));
    const failure = results.find(result => result.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
  }
  purgeOwner(ownerId: string, scopes: CompanionProjectionCleanup = {}): Promise<void> {
    ownerIdentity(ownerId);
    const interrupt = this.interruptOwner(ownerId);
    const pending = this.tail.then(async () => {
      await interrupt;
      const base = path.resolve(this.options.dataRoot);
      const directory = async (file: string) => {
        try { const entry = await lstat(file); if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('记忆清理目录必须为实际拥有的文件夹。'); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      };
      if (!await directory(base)) return;
      const generations = path.join(base, 'generation');
      if (await directory(generations)) {
        const target = path.join(generations, digest(ownerId));
        if (!scopes.preserveIndexes) { if (await directory(target)) await removeOwnedDirectory(target); }
        else if (await directory(target)) for (const pair of scopes.historicalViews ?? []) {
          const profile = path.join(target, digest(pair.profileKey));
          if (await directory(profile)) { const dirty = path.join(profile, digest(pair.scopeId)); if (await directory(dirty)) await removeOwnedDirectory(dirty); }
        }
      }
      const targets = new Map<string, { profileKey: string; scopeId: string }>();
      for (const pair of scopes.historicalViews ?? []) {
        if (!pair.profileKey || !pair.scopeId || pair.scopeId.length > 4096) throw new Error('历史记忆范围无效。');
        targets.set(digest(pair.profileKey) + '/' + digest(pair.scopeId), pair);
      }
      const canonical = scopes.canonicalScopes ?? [];
      const currentScopes = new Set(canonical);
      for (const pair of scopes.historicalViews ?? []) if (pair.profileKey === this.current?.profileKey) currentScopes.add(pair.scopeId);
      for (const scopeId of currentScopes) {
        if (!scopeId || scopeId.length > 4096) throw new Error('记忆范围无效。');
        await this.current?.client.interruptScope({ scopeId });
        await this.current?.client.purgeScope({ scopeId });
      }
      for (const name of await readdir(base)) {
        if (!/^[a-f0-9]{64}$/u.test(name)) continue;
        const profile = path.join(base, name); if (!await directory(profile)) continue;
        const scopeHashes = new Set(canonical.map(value => digest(value)));
        for (const [target] of targets) if (target.startsWith(name + '/')) scopeHashes.add(target.slice(65));
        for (const scopeHash of scopeHashes) {
          const target = path.join(profile, scopeHash); if (await directory(target)) await removeOwnedDirectory(target);
        }
      }
    });
    this.ownerPurges.set(ownerId, pending);
    void pending.then(() => { if (this.ownerPurges.get(ownerId) === pending) this.ownerPurges.delete(ownerId); },
      () => { if (this.ownerPurges.get(ownerId) === pending) this.ownerPurges.delete(ownerId); });
    this.tail = pending.catch(() => undefined); return pending;
  }
  getCold(authorize: ColdKnowledgeServiceOptions['authorize']): Promise<ColdKnowledgeService> {
    const pending = this.tail.then(async () => {
      if (this.closed) throw new Error('冷知识服务已关闭。');
      const embedding = await this.options.resolveEmbedding();
      if (this.closed) throw new Error('冷知识服务已关闭。');
      const embeddingProfile = embedding.modelSignature ?? `${embedding.model}:${embedding.dimension}`;
      const space = JSON.stringify([embedding.model, embedding.dimension, embedding.modelSignature ?? null]);
      if (this.cold?.embeddingProfile === embeddingProfile && this.cold.space !== space) throw new Error('冷知识向量模型或维度已变化，语义空间签名必须同步更新。');
      this.coldAuthorize = authorize;
      const connectionSignature = createHash('sha256').update(JSON.stringify(embedding)).digest('hex');
      if (this.cold?.embeddingProfile === embeddingProfile && this.cold.connectionSignature === connectionSignature) return this.cold.service;
      await this.cold?.service.close(); this.cold = undefined;
      if (this.closed) throw new Error('冷知识服务已关闭。');
      const root = createHash('sha256').update(space).digest('hex');
      const service = new ColdKnowledgeService({ dataRoot: path.join(this.options.dataRoot, 'cold-knowledge', root), vendorRoot: this.options.vendorRoot,
        workerPath: path.join(path.dirname(this.options.workerPath), 'cold-worker.cjs'), embedding, launch: this.options.launch,
        authorize: (...args) => this.coldAuthorize!(...args) });
      this.cold = { service, embeddingProfile, space, connectionSignature };
      return service;
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  /** Owner reset spans every historical embedding profile and works without a
   * configured encoder. The root and each ancestor must be owned real folders. */
  resetCold(owner: string): Promise<void> {
    const pending = this.tail.then(async () => {
      if (typeof owner !== 'string' || !owner.trim() || owner.length > 100) throw new Error('冷知识所属伙伴无效。');
      await this.cold?.service.close(); this.cold = undefined;
      const base = path.resolve(this.options.dataRoot, 'cold-knowledge'), ownerHash = createHash('sha256').update(owner).digest('hex');
      const directory = async (file: string) => {
        try {
          const entry = await lstat(file);
          if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('冷知识清理目录必须为实际拥有的文件夹。');
          return true;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      };
      if (!await directory(base)) return;
      for (const profile of await readdir(base)) {
        if (!/^[a-f0-9]{64}$/u.test(profile)) continue;
        const profileRoot = path.resolve(base, profile), owners = path.join(profileRoot, 'owners'), target = path.resolve(owners, ownerHash);
        if (path.dirname(profileRoot) !== base || path.dirname(target) !== owners) throw new Error('冷知识清理路径超出所属范围。');
        if (!await directory(profileRoot) || !await directory(owners) || !await directory(target)) continue;
        await removeOwnedDirectory(target);
      }
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([this.tail, this.generationTail, ...[...this.generationAdmissions].map(pending => pending.catch(() => undefined))]);
    const results = await Promise.allSettled([this.current?.client.close(), this.cold?.service.close(),
      ...[...this.generations.values()].map(entry => this.retireEntry(entry))]);
    this.current = undefined; this.cold = undefined; this.coldAuthorize = undefined;
    await this.broker.close();
    const failure = results.find(result => result.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
  }
}
