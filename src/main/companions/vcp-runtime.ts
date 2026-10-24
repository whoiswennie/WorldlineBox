import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { VcpMemoryClient } from '../vcp-memory/client';
import type { VcpMemoryEmbeddingConfig } from '../vcp-memory/contracts';
import type { VcpMemoryPluginConfiguration } from '../vcp-memory/contracts';
import { ColdKnowledgeService, type ColdKnowledgeServiceOptions } from '../vcp-memory/cold-service';
import { removeOwnedDirectory } from '../vcp-memory/filesystem';

export interface CompanionMemoryRuntime {
  get(): Promise<{ client: VcpMemoryClient; profileKey: string }>;
  getCold?(authorize: ColdKnowledgeServiceOptions['authorize']): Promise<ColdKnowledgeService>;
  resetCold?(owner: string): Promise<void>;
  close(): Promise<void>;
}

/** A new semantic space gets a new physical root; source notes are replayed into it. */
export class CompanionVcpRuntime implements CompanionMemoryRuntime {
  private current?: { client: VcpMemoryClient; profileKey: string };
  private currentSpace?: string;
  private currentEmbeddingProfile?: string;
  private currentConnectionSignature?: string;
  private cold?: { service: ColdKnowledgeService; embeddingProfile: string; space: string; connectionSignature: string };
  private coldAuthorize?: ColdKnowledgeServiceOptions['authorize'];
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly options: {
    dataRoot: string; vendorRoot: string; workerPath: string;
    resolveEmbedding(): Promise<VcpMemoryEmbeddingConfig>;
    resolvePlugins?(): Promise<VcpMemoryPluginConfiguration>;
  }) {}
  get(): Promise<{ client: VcpMemoryClient; profileKey: string }> {
    const pending = this.tail.then(async () => {
      if (this.closed) throw new Error('记忆服务已关闭。');
      const embedding = await this.options.resolveEmbedding();
      if (this.closed) throw new Error('记忆服务已关闭。');
      const embeddingProfile = embedding.modelSignature ?? `${embedding.model}:${embedding.dimension}`;
      const space = JSON.stringify([embedding.model, embedding.dimension, embedding.modelSignature ?? null]);
      if (this.currentEmbeddingProfile === embeddingProfile && this.currentSpace !== space) throw new Error('向量模型或维度已变化，语义空间签名必须同步更新。');
      const plugins = await this.options.resolvePlugins?.();
      if (this.closed) throw new Error('记忆服务已关闭。');
      // A focus model/endpoint or behavior change invalidates generated context
      // even when the embedding space is unchanged. Credentials stay private
      // and trigger a connection refresh, without entering the public profile.
      const semanticPlugins = { contextAdapter: 'world-clock-episodic-v1', behaviorProfile: plugins?.behaviorProfile ?? 'preserve-corrections', riverThinkingEnabled: !!plugins?.riverThinkingEnabled,
        // The application gateway has a new loopback port on every launch.
        // Its source signature already identifies the actual global provider;
        // transport-only changes refresh the client, not the semantic space.
        chat: plugins?.chat ? { baseUrl: plugins.chat.sourceSignature ? null : plugins.chat.baseUrl,
          model: plugins.chat.model, sourceSignature: plugins.chat.sourceSignature ?? null } : null };
      const customized = !!semanticPlugins.chat || semanticPlugins.riverThinkingEnabled || semanticPlugins.behaviorProfile !== 'preserve-corrections';
      const configuration = createHash('sha256').update(JSON.stringify(semanticPlugins)).digest('hex').slice(0, 20);
      const profileKey = customized ? `${embeddingProfile}:vcp-${configuration}` : embeddingProfile;
      const connectionSignature = createHash('sha256').update(JSON.stringify({ embedding, plugins })).digest('hex');
      if (this.current?.profileKey === profileKey && this.currentConnectionSignature === connectionSignature) return this.current;
      await this.current?.client.retire();
      this.current = undefined; this.currentSpace = undefined; this.currentEmbeddingProfile = undefined; this.currentConnectionSignature = undefined;
      if (this.closed) throw new Error('记忆服务已关闭。');
      const root = createHash('sha256').update(profileKey).digest('hex');
      const client = new VcpMemoryClient({ ...this.options, dataRoot: path.join(this.options.dataRoot, root), embedding,
        plugins, maxOpenScopes: 4 });
      this.current = { client, profileKey };
      this.currentSpace = space;
      this.currentEmbeddingProfile = embeddingProfile;
      this.currentConnectionSignature = connectionSignature;
      return this.current;
    });
    this.tail = pending.catch(() => undefined);
    return pending;
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
        workerPath: path.join(path.dirname(this.options.workerPath), 'cold-worker.cjs'), embedding,
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
    await this.tail;
    await this.current?.client.close();
    await this.cold?.service.close(); this.cold = undefined; this.coldAuthorize = undefined;
    this.current = undefined; this.currentSpace = undefined; this.currentEmbeddingProfile = undefined; this.currentConnectionSignature = undefined;
  }
}
