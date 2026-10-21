import { createHash } from 'node:crypto';
import path from 'node:path';
import { VcpMemoryClient } from '../vcp-memory/client';
import type { VcpMemoryEmbeddingConfig } from '../vcp-memory/contracts';
import type { VcpMemoryPluginConfiguration } from '../vcp-memory/contracts';

export interface CompanionMemoryRuntime {
  get(): Promise<{ client: VcpMemoryClient; profileKey: string }>;
  close(): Promise<void>;
}

/** A new semantic space gets a new physical root; source notes are replayed into it. */
export class CompanionVcpRuntime implements CompanionMemoryRuntime {
  private current?: { client: VcpMemoryClient; profileKey: string };
  private currentSpace?: string;
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
      const profileKey = embedding.modelSignature ?? `${embedding.model}:${embedding.dimension}`;
      const space = JSON.stringify([embedding.model, embedding.dimension, embedding.modelSignature ?? null]);
      if (this.current?.profileKey === profileKey) {
        if (this.currentSpace !== space) throw new Error('向量模型或维度已变化，语义空间签名必须同步更新。');
        return this.current;
      }
      const plugins = await this.options.resolvePlugins?.();
      if (this.closed) throw new Error('记忆服务已关闭。');
      await this.current?.client.close();
      this.current = undefined; this.currentSpace = undefined;
      if (this.closed) throw new Error('记忆服务已关闭。');
      const root = createHash('sha256').update(profileKey).digest('hex');
      const client = new VcpMemoryClient({ ...this.options, dataRoot: path.join(this.options.dataRoot, root), embedding,
        plugins, maxOpenScopes: 4 });
      this.current = { client, profileKey };
      this.currentSpace = space;
      return this.current;
    });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    await this.current?.client.close();
    this.current = undefined; this.currentSpace = undefined;
  }
}
