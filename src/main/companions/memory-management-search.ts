import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CompanionMemory } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { VcpMemoryClient } from '../vcp-memory/client';
import type { VcpMemoryNote, VcpMemoryOwnerIdentity } from '../vcp-memory/contracts';
import type { CompanionMemoryRuntime } from './vcp-runtime';
import { companionMemoryIdentity, companionMemoryIdentitySignature } from './memory-identity';

export interface CompanionMemoryManagementSearchResult {
  hits: Array<{ noteId: string; version: number }>;
  state: 'building' | 'ready' | 'error'; indexed: number; total: number;
  error?: string; nextCursor?: string;
}
export interface CompanionMemoryManagementSearchOptions {
  runtime?: CompanionMemoryRuntime;
  requestStorage(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  cacheRoot?: string;
  report?(error: unknown): void;
  changed?(): void;
  batchSize?: number;
}
type IndexState = NonNullable<CompanionStorageResponse['memoryLibraryIndexState']>;
type Manifest = { schema: 1; owner: string; profileKey: string; scopeId: string; resetRevision: number; throughOrdinal: number;
  baseThrough: number; afterId?: string; bootstrapped: boolean; indexed: number; identitySignature?: string };
type Owner = { owner: string; generation: number; manifest?: Manifest; loaded: boolean; warmed: boolean; total: number; state: CompanionMemoryManagementSearchResult['state']; error?: string;
  runtime?: { client: VcpMemoryClient; profileKey: string }; work?: Promise<void>; retryAt: number };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const validOwner = /^[a-zA-Z0-9_-]{1,100}$/u;
const runtimeNote = (note: CompanionMemory, identity: VcpMemoryOwnerIdentity): VcpMemoryNote => ({ id: note.id, content: note.content, tags: note.tags, diaryName: note.diaryName,
  author: identity.agentName, occurredAt: note.occurredAt ?? note.sources.at(-1)?.worldCreatedAt ?? note.sources.at(-1)?.createdAt ?? note.createdAt,
  metadata: { ...note.metadata, hostMemoryOwner: identity, worldlineboxManagementVersion: note.version } });

/** Human-only owner corpus. Agent recall continues to use physically scoped conversation views. */
export class CompanionMemoryManagementSearch {
  private readonly owners = new Map<string, Owner>();
  private readonly queued = new Set<string>();
  private readonly searches = new Set<Promise<unknown>>();
  private runner?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private readonly options: CompanionMemoryManagementSearchOptions) {
    if (options.cacheRoot && !path.isAbsolute(options.cacheRoot)) throw new Error('管理检索缓存必须使用绝对路径。');
  }
  private async request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> {
    const response = await this.options.requestStorage(command);
    if (!response.ok) throw new Error(response.error ?? '伙伴记忆存储不可用。');
    return response;
  }
  private async state(owner: string): Promise<IndexState> {
    const state = (await this.request({ type: 'memory.library.index-state', companionId: owner })).memoryLibraryIndexState;
    if (!state) throw new Error('伙伴管理索引状态不可用。'); return state;
  }
  private async identity(owner: string): Promise<VcpMemoryOwnerIdentity> {
    const companion = (await this.request({ type: 'state', includeHidden: true, includeConversations: false })).state?.companions.find(item => item.id === owner);
    if (!companion) throw new Error('记忆所属伙伴不存在。');
    return companionMemoryIdentity(companion);
  }
  private file(owner: string): string { return path.join(this.options.cacheRoot!, `${digest(owner)}.json`); }
  private scopePrefix(owner: string): string { return `management_${digest(owner).slice(0, 16)}_`; }
  private async load(local: Owner): Promise<void> {
    if (local.loaded) return; local.loaded = true;
    if (!this.options.cacheRoot) return;
    try {
      const value: Manifest = JSON.parse(await readFile(this.file(local.owner), 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value) && value.schema === 1 && value.owner === local.owner && typeof value.profileKey === 'string' && typeof value.scopeId === 'string'
        && value.scopeId.startsWith(this.scopePrefix(local.owner)) && /^[a-f0-9]{32}$/u.test(value.scopeId.slice(this.scopePrefix(local.owner).length))
        && [value.resetRevision, value.throughOrdinal, value.baseThrough, value.indexed].every(value => Number.isSafeInteger(value) && value >= 0)
        && (value.identitySignature === undefined || /^[a-f0-9]{64}$/u.test(value.identitySignature))
        && typeof value.bootstrapped === 'boolean' && (value.afterId === undefined || typeof value.afterId === 'string' && validOwner.test(value.afterId))) local.manifest = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
  private async save(local: Owner): Promise<void> {
    if (!this.options.cacheRoot || !local.manifest) return;
    await mkdir(this.options.cacheRoot, { recursive: true });
    const file = this.file(local.owner), temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(local.manifest), { encoding: 'utf8', mode: 0o600 }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  }
  private local(owner: string): Owner {
    if (!validOwner.test(owner)) throw new Error('伙伴标识无效。');
    let local = this.owners.get(owner);
    if (!local) { local = { owner, generation: 0, loaded: false, warmed: false, total: 0, state: 'building', retryAt: 0 }; this.owners.set(owner, local); }
    return local;
  }
  private result(local: Owner): CompanionMemoryManagementSearchResult {
    return { hits: [], state: local.state, indexed: local.manifest?.indexed ?? 0, total: local.state === 'ready' ? local.manifest?.indexed ?? 0 : local.total,
      ...(local.error ? { error: local.error } : {}) };
  }
  private schedule(local: Owner): void {
    if (this.closed || local.retryAt > Date.now()) return;
    this.queued.add(local.owner);
    if (this.runner || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.runner = this.run().finally(() => { this.runner = undefined; if (!this.closed && this.queued.size) this.schedule(this.local([...this.queued][0]!)); });
      void this.runner.catch(this.options.report);
    }, 0); this.timer.unref();
  }
  private async run(): Promise<void> {
    while (!this.closed && this.queued.size) {
      const owner = [...this.queued][0]!; this.queued.delete(owner);
      const local = this.local(owner), generation = local.generation;
      const work = this.advance(local, generation); local.work = work;
      try { await work; }
      catch (error) {
        if (this.closed || local.generation !== generation) continue;
        let current: IndexState | undefined;
        try { current = await this.state(owner); } catch { /* Preserve the actual storage/runtime failure. */ }
        if (current && local.manifest && current.resetRevision !== local.manifest.resetRevision) {
          await this.discard(local); local.state = 'building'; this.queued.add(owner);
        } else {
          local.state = 'error'; local.error = error instanceof Error ? error.message : '原生管理索引构建失败。'; local.retryAt = Date.now() + 30000; this.options.report?.(error);
        }
      } finally { if (local.work === work) local.work = undefined; this.options.changed?.(); }
      if (!this.closed && local.generation === generation && local.state === 'building') this.queued.add(owner);
      if (this.queued.size) await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  private assertCurrent(local: Owner, generation: number): void {
    if (this.closed || local.generation !== generation) throw new Error('管理检索已取消，正在重新核验来源。');
  }
  private async discard(local: Owner): Promise<void> {
    const previous = local.manifest; local.manifest = undefined; local.warmed = false;
    if (previous && local.runtime) { await local.runtime.client.interruptScope(previous); await local.runtime.client.purgeScope(previous); }
    if (this.options.cacheRoot) await rm(this.file(local.owner), { force: true });
  }
  private async advance(local: Owner, generation: number): Promise<void> {
    if (!this.options.runtime) throw new Error('内置向量服务尚未就绪。');
    await this.load(local);
    const runtime = await this.options.runtime.get(); this.assertCurrent(local, generation);
    if (local.runtime && local.runtime.profileKey !== runtime.profileKey) await this.discard(local);
    local.runtime = runtime;
    const state = await this.state(local.owner); local.total = state.total;
    const identity = await this.identity(local.owner), identitySignature = companionMemoryIdentitySignature(identity); this.assertCurrent(local, generation);
    if (local.manifest && (local.manifest.identitySignature !== identitySignature || local.manifest.profileKey !== local.runtime.profileKey || local.manifest.resetRevision !== state.resetRevision || local.manifest.throughOrdinal > state.throughOrdinal)) await this.discard(local);
    if (!local.manifest) {
      local.manifest = { schema: 1, owner: local.owner, profileKey: local.runtime.profileKey, scopeId: this.scopePrefix(local.owner) + randomUUID().replaceAll('-', ''),
        resetRevision: state.resetRevision, throughOrdinal: 0, baseThrough: state.throughOrdinal, bootstrapped: false, indexed: 0, identitySignature };
      await this.save(local);
    }
    const manifest = local.manifest, client = local.runtime.client, batch = Math.max(1, Math.min(256, this.options.batchSize ?? 32));
    local.state = 'building'; local.error = undefined;
    if (!manifest.bootstrapped) {
      const page = (await this.request({ type: 'memory.library.index-page', companionId: local.owner, resetRevision: manifest.resetRevision,
        throughOrdinal: manifest.baseThrough, afterId: manifest.afterId, limit: batch })).memoryLibraryIndexPage;
      if (!page) throw new Error('管理索引初始分页不可用。');
      for (const note of page.notes) { this.assertCurrent(local, generation); await client.remember(manifest, runtimeNote(note, identity)); }
      this.assertCurrent(local, generation);
      if ((await this.state(local.owner)).resetRevision !== manifest.resetRevision) throw new Error('管理索引来源已变化。');
      manifest.indexed += page.notes.length;
      manifest.afterId = page.nextId;
      if (!page.hasMore) { manifest.bootstrapped = true; manifest.throughOrdinal = manifest.baseThrough; delete manifest.afterId; }
      await this.save(local); return;
    }
    if (manifest.throughOrdinal < state.throughOrdinal) {
      const page = (await this.request({ type: 'memory.library.changes', companionId: local.owner, resetRevision: manifest.resetRevision,
        throughOrdinal: state.throughOrdinal, afterOrdinal: manifest.throughOrdinal, limit: batch })).memoryLibraryChanges;
      if (!page) throw new Error('管理索引增量记录不可用。');
      if (page.changes.some(change => change.operation !== 'remember' || !change.note || change.version !== 1)) {
        await this.discard(local); return;
      }
      for (const change of page.changes) { this.assertCurrent(local, generation); await client.remember(manifest, runtimeNote(change.note!, identity)); }
      this.assertCurrent(local, generation);
      if ((await this.state(local.owner)).resetRevision !== manifest.resetRevision) throw new Error('管理索引来源已变化。');
      manifest.indexed += page.changes.length; manifest.throughOrdinal = page.nextOrdinal;
      await this.save(local); return;
    }
    if (manifest.indexed && !client.hasOpenScope(manifest)) await client.read(manifest, 'management-warmup');
    this.assertCurrent(local, generation); local.warmed = true; local.state = 'ready'; local.retryAt = 0;
  }
  search(owner: string, query: string, limit = 30, cursor?: string): Promise<CompanionMemoryManagementSearchResult> {
    const pending = this.query(owner, query, limit, cursor); this.searches.add(pending);
    void pending.finally(() => this.searches.delete(pending)).catch(() => undefined); return pending;
  }
  private async query(owner: string, query: string, limit: number, cursor?: string): Promise<CompanionMemoryManagementSearchResult> {
    const local = this.local(owner);
    if (this.closed) return { ...this.result(local), state: 'error', error: '管理检索已经关闭。' };
    if (typeof query !== 'string' || !query.trim() || query.length > 16000 || !Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error('管理检索条件无效。');
    limit = Math.min(100, limit);
    await this.load(local);
    const state = await this.state(owner); local.total = state.total;
    const identitySignature = companionMemoryIdentitySignature(await this.identity(owner));
    if (local.manifest && local.runtime && local.manifest.identitySignature !== identitySignature) await this.invalidate(owner);
    const manifest = local.manifest;
    if (!manifest || !local.runtime || !local.warmed || local.state !== 'ready' || manifest.resetRevision !== state.resetRevision || manifest.throughOrdinal !== state.throughOrdinal
      || manifest.indexed > 0 && !local.runtime.client.hasOpenScope(manifest)) {
      if (local.state !== 'error' || local.retryAt <= Date.now()) { local.state = 'building'; this.schedule(local); }
      return this.result(local);
    }
    if (!manifest.indexed) return this.result(local);
    const fingerprint = digest(JSON.stringify([owner, query, manifest.scopeId, manifest.resetRevision, manifest.throughOrdinal]));
    let offset = 0;
    if (cursor) {
      try { const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { fingerprint: string; offset: number };
        if (value.fingerprint !== fingerprint || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 100) throw new Error(); offset = value.offset;
      } catch { throw new Error('搜索来源或条件已经变化，请从第一页重新搜索。'); }
    }
    const generation = local.generation, found = await local.runtime.client.search(manifest, { text: query, topK: 100 });
    this.assertCurrent(local, generation);
    const hits: CompanionMemoryManagementSearchResult['hits'] = [], seen = new Set<string>();
    for (const hit of found.results) {
      if (seen.has(hit.id)) continue; seen.add(hit.id);
      const current = (await this.request({ type: 'memory.library.read', companionId: owner, id: hit.id, sourceLimit: 1 })).memoryRead?.memory;
      if (current && current.version === hit.metadata?.worldlineboxManagementVersion && current.content === hit.content
        && current.diaryName === hit.diaryName && JSON.stringify(current.tags) === JSON.stringify(hit.tags)) hits.push({ noteId: current.id, version: current.version });
    }
    const verified = await this.state(owner); this.assertCurrent(local, generation);
    if (verified.resetRevision !== state.resetRevision || verified.throughOrdinal !== state.throughOrdinal || companionMemoryIdentitySignature(await this.identity(owner)) !== identitySignature) {
      local.state = 'building'; this.schedule(local); return this.result(local);
    }
    const end = offset + limit;
    return { ...this.result(local), hits: hits.slice(offset, end), ...(end < hits.length ? { nextCursor: Buffer.from(JSON.stringify({ fingerprint, offset: end })).toString('base64url') } : {}) };
  }
  async invalidate(owner: string): Promise<void> {
    const local = this.owners.get(owner); if (!local) return;
    local.generation++; this.queued.delete(owner); local.state = 'building'; local.warmed = false; local.retryAt = 0; local.error = undefined;
    if (local.manifest && local.runtime) await local.runtime.client.interruptScope(local.manifest);
    await local.work?.catch(() => undefined);
    await this.discard(local);
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearTimeout(this.timer); this.queued.clear();
    for (const local of this.owners.values()) local.generation++;
    await Promise.allSettled([...this.owners.values()].filter(local => local.manifest && local.runtime).map(local => local.runtime!.client.interruptScope(local.manifest!)));
    await this.runner?.catch(() => undefined); await Promise.allSettled(this.searches);
  }
}
