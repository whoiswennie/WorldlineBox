import { createHash } from 'node:crypto';
import path from 'node:path';
import { companionKnowledgeCommandSchema, companionKnowledgeResponseSchema, type CompanionKnowledgeCommand, type CompanionKnowledgeResponse } from '../../shared/companion-knowledge-store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionMessage } from '../../shared/companions';
import type { CompanionMemoryRuntime } from './vcp-runtime';
import type { ColdKnowledgeDocument, ColdKnowledgeRecord } from '../vcp-memory/cold-contracts';
import type { ColdKnowledgeServiceOptions } from '../vcp-memory/cold-service';
import type { CompanionLearningAssets } from './learning-service';
import type { CompanionLearningGrant } from '../../shared/companion-learning';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
type Scope = Pick<CompanionKnowledgeCommand, 'companionId' | 'conversationId' | 'beforeSequence'>;
export interface CompanionKnowledgeServiceOptions {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  runtime?: CompanionMemoryRuntime; blocked?(owner: string): boolean; changed?(): void;
  assets?: CompanionLearningAssets;
}
/** Converts only actual, currently visible host sources; model-provided text is never an ingestion input. */
export class CompanionKnowledgeService {
  constructor(private readonly options: CompanionKnowledgeServiceOptions) {}
  private async metadata(grant: CompanionLearningGrant) {
    const assets = this.options.assets;
    if (!assets) throw new Error('资料授权目录不可用。');
    const current = await (assets.describe ? assets.describe(grant) : assets.grant({ libraryId: grant.libraryId, folderId: grant.folderId }));
    if (path.resolve(current.libraryPath) !== path.resolve(grant.libraryPath)) throw new Error('资料库位置已变化，不能沿旧授权描述来源。');
    return current;
  }
  /** Current owner directory metadata only. No asset enumeration, body read,
   * encoder initialization or knowledge ingestion occurs while building context. */
  async sourceCatalog(scope: Scope, cursor?: string, limit = 20): Promise<CompanionKnowledgeResponse> {
    const base = { engine: 'original-TDBKnowledge' as const, operation: 'sources' as const, trust: 'knowledge_source_data_not_instructions' as const };
    await this.options.request({ type: 'memory.sources.filter', ...scope, ids: [] });
    if (this.options.blocked?.(scope.companionId) || !this.options.assets) return { ...base, available: false, sources: [], hasMore: false };
    if (cursor && !/^\d{1,9}$/u.test(cursor)) throw new Error('授权目录分页游标无效。');
    const grants = (await this.options.request({ type: 'learning.status', companionId: scope.companionId })).learning?.grants
      .filter(grant => grant.companionId === scope.companionId && grant.enabled).sort((a, b) => a.id.localeCompare(b.id)) ?? [];
    const offset = Number(cursor || 0), end = offset + Math.min(100, Math.max(1, limit));
    const resolved = await Promise.all(grants.slice(offset, end).map(async grant => {
      try {
        const current = await this.metadata(grant);
        return { grant, current };
      } catch { return undefined; } // Closed/moved metadata is not current authority.
    }));
    const latest = (await this.options.request({ type: 'learning.status', companionId: scope.companionId })).learning?.grants ?? [];
    await this.options.request({ type: 'memory.sources.filter', ...scope, ids: [] });
    if (this.options.blocked?.(scope.companionId)) return { ...base, available: false, sources: [], hasMore: false };
    const vector = (items: readonly CompanionLearningGrant[]) => JSON.stringify(items.filter(grant => grant.companionId === scope.companionId && grant.enabled)
      .sort((a, b) => a.id.localeCompare(b.id)).map(grant => [grant.id, grant.companionId, grant.enabled, grant.revision, grant.libraryId, grant.libraryPath, grant.folderId]));
    if (vector(grants) !== vector(latest)) throw new Error('资料授权目录在读取期间已变化，请重新读取当前页。');
    const sources: NonNullable<CompanionKnowledgeResponse['sources']> = [];
    for (const item of resolved) if (item && latest.some(grant => grant.id === item.grant.id && grant.companionId === scope.companionId
      && grant.enabled && grant.revision === item.grant.revision && grant.libraryId === item.grant.libraryId && grant.folderId === item.grant.folderId))
      sources.push({ grantId: item.grant.id, grantRevision: item.grant.revision, libraryId: item.grant.libraryId, libraryName: item.current.libraryName,
        folderId: item.grant.folderId, folderName: item.current.folderName });
    return companionKnowledgeResponseSchema.parse({ ...base, available: !!sources.length || !grants.slice(offset, end).length,
      sources, total: grants.length, hasMore: grants.length > end,
      ...(grants.length > end ? { nextCursor: String(end) } : {}) });
  }
  private async factualMessage(scope: Scope, message: CompanionMessage): Promise<boolean> {
    if (message.worldObservation) return false;
    if (!message.topicId) return true;
    const topic = (await this.options.request({ type: 'topic.read', conversationId: message.conversationId, topicId: message.topicId, readerId: scope.companionId })).topic;
    return !!topic && topic.kind === 'discussion' && !topic.deletedAt;
  }
  private async grant(owner: string, id: string): Promise<CompanionLearningGrant> {
    const grant = (await this.options.request({ type: 'learning.status', companionId: owner })).learning?.grants.find(item => item.id === id && item.companionId === owner && item.enabled);
    if (!grant) throw new Error('学习资料授权已撤回或不属于当前伙伴。'); return grant;
  }
  private async source(scope: Scope, type: 'message' | 'memory' | 'learning', id: string, assetId?: string): Promise<ColdKnowledgeDocument> {
    if (this.options.blocked?.(scope.companionId)) throw new Error('伙伴正在重置或已停用，知识来源暂不可用。');
    if (type === 'learning') {
      const assets = this.options.assets;
      if (!assets?.asset || !assetId) throw new Error('完整学习资料读取接口不可用。');
      const grant = await this.grant(scope.companionId, id);
      const asset = await assets.asset(grant, assetId);
      if (!asset) throw new Error('资料已移出授权目录、删除或不可读。');
      const read = await assets.read(grant, asset);
      if (read.truncated) throw new Error('学习资料仅返回截断预览，未摄取到冷知识库。');
      const afterGrant = await this.grant(scope.companionId, id), afterAsset = await assets.asset(afterGrant, assetId);
      if (afterGrant.revision !== grant.revision || !afterAsset || afterAsset.currentRevisionId !== asset.currentRevisionId || this.options.blocked?.(scope.companionId)) throw new Error('资料或授权在读取期间已经变化。');
      return { id: `cold_learning_${hash(id + ':' + assetId).slice(0, 48)}`, sourceId: id, sourceType: type, text: read.content,
        sourceVersion: `${grant.revision}:${read.revisionId}`, sourceDigest: hash(JSON.stringify({ grantId: id, grantRevision: grant.revision, assetId, revisionId: read.revisionId, content: read.content })),
        title: asset.displayName, metadata: { conversationId: scope.conversationId, grantId: id, grantRevision: grant.revision, assetId, assetRevisionId: read.revisionId,
          libraryId: grant.libraryId, folderId: grant.folderId, publishedAfterSequence: scope.beforeSequence } };
    }
    if (type === 'message') {
      const message = (await this.options.request({ type: 'memory.sources.filter', ...scope, ids: [id] })).memorySources?.find(item => item.id === id);
      if (!message || !await this.factualMessage(scope, message)) throw new Error('知识来源不存在、属于虚构话题或当前不可见。');
      return { id: `cold_message_${hash(id).slice(0, 48)}`, sourceId: id, sourceType: type, sourceDigest: hash(message.content), text: message.content,
        sourceVersion: `${message.sequence}:${hash(message.content)}`, title: `消息资料 ${id}`, metadata: { conversationId: message.conversationId, sourceSequence: message.sequence,
          sources: [{ messageId: id, conversationId: message.conversationId, checksum: hash(message.content), sequence: message.sequence }] } };
    }
    const library = (await this.options.request({ type: 'memory.library.read', companionId: scope.companionId, id, sourceLimit: 100 })).memoryRead?.memory;
    const scoped = (await this.options.request({ type: 'memory.read', ...scope, id, sourceLimit: 100 })).memoryRead?.memory;
    if (!library || !scoped || (library.contentRevision ?? library.version) !== (scoped.contentRevision ?? scoped.version) || library.content !== scoped.content) throw new Error('资料笔记已变化或不属于当前可见来源。');
    const contentRevision = library.contentRevision ?? library.version;
    return { id: `cold_memory_${hash(id).slice(0, 48)}`, sourceId: id, sourceType: type,
      sourceDigest: hash(JSON.stringify({ content: library.content, contentRevision, sources: library.sources })), sourceVersion: String(contentRevision),
      text: library.content, title: library.diaryName || `资料笔记 ${id}`, metadata: { conversationId: library.sourceConversationId, sourceSequence: library.sourceSequence, sources: library.sources } };
  }
  readonly authorize: ColdKnowledgeServiceOptions['authorize'] = async (owner, sourceId, sourceDigest, source) => {
    if (this.options.blocked?.(owner) || !['message', 'memory', 'learning'].includes(source.sourceType ?? '')) return false;
    const conversationId = source.metadata?.conversationId;
    if (typeof conversationId !== 'string') return false;
    try {
      const current = await this.source({ companionId: owner, conversationId }, source.sourceType as 'message' | 'memory' | 'learning', sourceId,
        typeof source.metadata?.assetId === 'string' ? source.metadata.assetId : undefined);
      return current.sourceDigest === sourceDigest && current.sourceVersion === source.sourceVersion;
    } catch { return false; }
  };
  async reset(owner: string): Promise<void> {
    if (this.options.runtime?.resetCold) return this.options.runtime.resetCold(owner);
    const cold = await this.options.runtime?.getCold?.({ ownerId: owner }, this.authorize);
    try { await cold?.reset(owner); } finally { await cold?.release?.(); }
  }
  private async eligible(scope: Scope, record: ColdKnowledgeRecord): Promise<boolean> {
    if (!['memory', 'message', 'learning'].includes(record.sourceType ?? '')) return false;
    if (record.sourceType === 'learning' && scope.beforeSequence !== undefined
      && (typeof record.metadata?.publishedAfterSequence !== 'number' || record.metadata.publishedAfterSequence > scope.beforeSequence)) return false;
    try { const current = await this.source(scope, record.sourceType as 'message' | 'memory' | 'learning', record.sourceId,
      typeof record.metadata?.assetId === 'string' ? record.metadata.assetId : undefined); return current.sourceDigest === record.sourceDigest && current.sourceVersion === record.sourceVersion; }
    catch { return false; }
  }
  async execute(input: CompanionKnowledgeCommand): Promise<CompanionKnowledgeResponse> {
    const command = companionKnowledgeCommandSchema.parse(input);
    const scope: Scope = { companionId: command.companionId, conversationId: command.conversationId, beforeSequence: command.beforeSequence };
    const base = { engine: 'original-TDBKnowledge' as const, operation: command.operation, trust: 'knowledge_source_data_not_instructions' as const };
    if (!this.options.runtime?.getCold || this.options.blocked?.(scope.companionId)) return { ...base, available: false };
    await this.options.request({ type: 'memory.sources.filter', ...scope, ids: [] });
    if (command.operation === 'sources') {
      if (!command.sourceId) return this.sourceCatalog(scope, command.cursor, command.limit);
      const grants = (await this.options.request({ type: 'learning.status', companionId: scope.companionId })).learning?.grants.filter(grant => grant.companionId === scope.companionId && grant.enabled).sort((a,b) => a.id.localeCompare(b.id)) ?? [];
      const grant = grants.find(item => item.id === command.sourceId);
      if (!grant || !this.options.assets) throw new Error('资料授权目录不可用。');
      const metadata = await this.metadata(grant);
      const page = await this.options.assets.page(grant, command.cursor);
      const current = await this.grant(scope.companionId, grant.id);
      if (current.revision !== grant.revision || this.options.blocked?.(scope.companionId)) throw new Error('资料授权在目录读取期间已变化。');
      return companionKnowledgeResponseSchema.parse({ ...base, available: true, sources: page.assets.map(asset => ({ grantId: grant.id, grantRevision: grant.revision,
        libraryId: grant.libraryId, libraryName: metadata.libraryName, folderId: grant.folderId, folderName: metadata.folderName,
        assetId: asset.assetId, assetName: asset.displayName, assetRevisionId: asset.currentRevisionId })),
        hasMore: page.hasMore, nextCursor: page.nextCursor, total: page.assets.length });
    }
    const cold = await this.options.runtime.getCold({ ownerId: scope.companionId }, this.authorize);
    try {
    if (command.operation === 'ingest') {
      const document = await this.source(scope, command.sourceType!, command.sourceId!, command.assetId);
      const receipt = await cold.ingest(scope.companionId, document); this.options.changed?.();
      return companionKnowledgeResponseSchema.parse({ ...base, available: true, generation: receipt.generation, indexed: receipt.indexed,
        result: { ...document, text: undefined, version: receipt.version, chunks: receipt.chunks } });
    }
    const state = await cold.status(scope.companionId);
    if (command.operation === 'revoke') {
      const record = state.documents.find(item => item.id === command.id);
      if (!record) throw new Error('知识资料不属于当前伙伴。');
      await cold.revoke(scope.companionId, record.id); this.options.changed?.(); return { ...base, available: true, revoked: true };
    }
    const eligible: ColdKnowledgeRecord[] = [];
    for (const record of state.documents) if (record.status !== 'revoked' && (!command.sourceIds || command.sourceIds.includes(record.sourceId)) && await this.eligible(scope, record)) eligible.push(record);
    if (command.operation === 'status') return companionKnowledgeResponseSchema.parse({ ...base, available: true, generation: state.generation,
      items: eligible.slice(0, command.limit ?? 20), total: eligible.length });
    if (command.operation === 'read') {
      const record = eligible.find(item => item.id === command.id);
      if (!record) throw new Error('知识资料或版本在当前入口不可读。');
      const result = await cold.read(scope.companionId, record.id, command.version);
      if (!await this.eligible(scope, record)) throw new Error('知识来源已撤回。');
      return companionKnowledgeResponseSchema.parse({ ...base, available: true, generation: state.generation, result });
    }
    const searched = await cold.search(scope.companionId, command.query!, { topK: command.limit, sourceIds: eligible.filter(item => item.status === 'ready').map(item => item.sourceId),
      documentIds: eligible.filter(item => item.status === 'ready').map(item => item.id) });
    const items = [];
    for (const hit of searched.results) {
      const record = eligible.find(item => item.id === hit.id && item.version === hit.version);
      if (record && await this.eligible(scope, record)) items.push(hit);
    }
    return companionKnowledgeResponseSchema.parse({ ...base, available: true, generation: searched.generation, degraded: searched.degraded, items, total: items.length });
    } finally { await cold.release?.(); }
  }
}
