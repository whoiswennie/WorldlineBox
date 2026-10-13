import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { dshMarketEntrySchema, dshMarketPageSchema, dshRepositorySchema, type DshMarketEntry, type DshMarketPage, type DshMarketplaceState } from '../../shared/dsh-marketplace';
import { lstat, mkdir } from './disk';
import { atomicJson, readJson } from './files';
import { httpsDownloadUrl, type HttpsDownloadFetch } from './https-download';

export const DSH_PLUGIN_CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json';
export const DSH_SKILL_SEARCH_URL = 'https://www.skills.sh/api/search';
const CACHE_TTL = 30 * 60_000;
const MAX_JSON_BYTES = 16 * 1024 ** 2;
const npmNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
const corePackages = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless', '@deepseek-ai/deepseek-harness']);
export interface DshMarketplaceNetwork {
  fetch: HttpsDownloadFetch;
  json(url: string, signal: AbortSignal): Promise<unknown>;
  githubCandidates(url: string): string[];
  environment?(base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv>;
}
const cacheSchema = z.object({ version: z.literal(1), kind: z.enum(['plugin', 'skill']), query: z.string(),
  fetchedAt: z.string(), etag: z.string().max(1024).optional(), entries: z.array(dshMarketEntrySchema).max(20_000) });
type Cache = z.infer<typeof cacheSchema>;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, limit: number): string => typeof value === 'string' ? value.slice(0, limit) : '';
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const stableId = (kind: string, value: string): string => `${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
function githubRepository(source: string): string | undefined {
  try { const url = new URL(source); if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) return undefined;
    return dshRepositorySchema.safeParse(url.pathname.replace(/^\//, '').split('/').slice(0, 2).join('/')).data;
  } catch { return undefined; }
}
function localizedDescription(raw: unknown): string {
  if (typeof raw === 'string') return raw.slice(0, 4000);
  const translations = record(raw);
  return text(translations.zh ?? translations['zh-CN'] ?? translations.en ?? Object.values(translations)[0], 4000);
}
export function parsePluginCatalog(payload: unknown): DshMarketEntry[] {
  const source = record(payload).plugins;
  if (!Array.isArray(source) || source.length > 20_000) throw new Error('The plugin catalog has an unsupported structure or size.');
  const entries = new Map<string, DshMarketEntry>();
  for (const candidate of source) {
    const item = record(candidate); const name = text(item.name, 200); const sourceUrl = text(item.url, 2048);
    const repository = githubRepository(sourceUrl); if (!name || !repository) continue;
    const npmName = typeof item.npm === 'string' && npmNamePattern.test(item.npm) && item.npm.length <= 214 ? item.npm : undefined;
    const version = typeof item.version === 'string' && exactVersionPattern.test(item.version) ? item.version : undefined;
    const labelsValue = item.riskLabels ?? item.risk_labels ?? item.capabilityRedLines;
    const labels = Array.isArray(labelsValue) ? labelsValue as unknown[] : [];
    const capabilities = Array.isArray(item.capabilities) ? item.capabilities.filter(value => typeof value === 'string').map(value => String(value).slice(0, 100)).slice(0, 50) : [];
    const entry: DshMarketEntry = { id: stableId('plugin', `${sourceUrl}\0${name}`), kind: 'plugin', name, sourceUrl,
      repository, npmName, version, description: localizedDescription(item.description), category: text(item.category, 100) || 'other',
      stars: count(item.stars), downloads: count(item.downloads), capabilities, riskLabels: labels.filter(value => typeof value === 'string').map(value => String(value).slice(0, 100)).slice(0, 30) };
    entries.set(entry.id, entry);
  }
  return [...entries.values()].sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name));
}
export function parseSkillSearch(payload: unknown): DshMarketEntry[] {
  const source = record(payload).skills;
  if (!Array.isArray(source) || source.length > 5000) throw new Error('The skill catalog has an unsupported structure or size.');
  const entries = new Map<string, DshMarketEntry>();
  for (const candidate of source) {
    const item = record(candidate); const repository = dshRepositorySchema.safeParse(item.source).data;
    const name = text(item.skillId ?? item.name, 200); if (!repository || !name) continue;
    const entry: DshMarketEntry = { id: stableId('skill', `${repository}\0${name}`), kind: 'skill', name, repository,
      sourceUrl: `https://github.com/${repository}`, description: text(item.description, 4000), category: 'skill', stars: 0,
      downloads: count(item.installs), riskLabels: [] };
    entries.set(entry.id, entry);
  }
  return [...entries.values()].sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name));
}

/** Catalog values are metadata only. Installation commands are derived from validated npm metadata. */
export class MarketplaceService {
  private readonly cachePath: string;
  private readonly caches = new Map<string, Cache>();
  private pages: DshMarketplaceState = {};
  private readonly pending = new Map<string, Promise<Cache>>();
  constructor(private readonly options: { rootPath: string; network: DshMarketplaceNetwork; onChanged?: () => void; now?: () => number }) {
    this.cachePath = path.join(options.rootPath, 'marketplace', 'catalogs');
  }
  async init(): Promise<void> {
    let current = path.resolve(this.options.rootPath); await mkdir(current, { recursive: true });
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Catalog storage cannot be linked.');
    for (const segment of ['marketplace', 'catalogs']) { current = path.join(current, segment); await mkdir(current, { recursive: true });
      const info = await lstat(current); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Catalog storage cannot be linked or replaced by a file.'); }
  }
  state(): DshMarketplaceState { return structuredClone(this.pages); }
  private key(kind: 'plugin' | 'skill', query: string): string { return kind === 'plugin' ? 'plugin' : stableId('skill', query.toLowerCase()); }
  private async load(kind: 'plugin' | 'skill', query: string): Promise<Cache | undefined> {
    const key = this.key(kind, query); if (this.caches.has(key)) return this.caches.get(key);
    try { const file = path.join(this.cachePath, `${key}.json`); const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_JSON_BYTES) return undefined;
      const parsed = cacheSchema.safeParse(await readJson(file));
      if (parsed.success && parsed.data.kind === kind && (kind === 'plugin' || parsed.data.query === query)) {
        this.caches.set(key, parsed.data); return parsed.data;
      }
    } catch { /* A damaged optional catalog cache is a miss. */ }
    return undefined;
  }
  async search(input: { kind: 'plugin' | 'skill'; query: string; page?: number; pageSize?: number; refresh?: boolean }, signal?: AbortSignal): Promise<DshMarketPage> {
    await this.init();
    const query = input.query.trim().slice(0, 200); const page = Math.max(1, Math.floor(input.page ?? 1)); const pageSize = Math.max(1, Math.min(100, Math.floor(input.pageSize ?? 24)));
    let cache = await this.load(input.kind, query); let error: string | undefined;
    const now = this.options.now?.() ?? Date.now();
    if (input.refresh || !cache || now - Date.parse(cache.fetchedAt) > CACHE_TTL) {
      try { cache = await this.refresh(input.kind, query, cache, signal); }
      catch (reason) { if (signal?.aborted) throw reason; error = 'Catalog refresh failed. Saved catalog entries remain available; check the launcher network settings.'; }
    }
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const entries = (cache?.entries ?? []).filter(entry => input.kind === 'skill' || terms.every(term => `${entry.name} ${entry.description} ${entry.repository ?? ''} ${entry.category}`.toLowerCase().includes(term)));
    const result = dshMarketPageSchema.parse({ kind: input.kind, query, page, pageSize, total: entries.length,
      entries: entries.slice((page - 1) * pageSize, page * pageSize), fetchedAt: cache?.fetchedAt, stale: !!error || !cache,
      error });
    if (input.kind === 'plugin') this.pages.plugins = result; else this.pages.skills = result;
    this.options.onChanged?.(); return result;
  }
  private refresh(kind: 'plugin' | 'skill', query: string, previous: Cache | undefined, outerSignal?: AbortSignal): Promise<Cache> {
    const key = this.key(kind, query); const existing = this.pending.get(key); if (existing) return existing;
    const work = (async () => {
      const signal = outerSignal ? AbortSignal.any([outerSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
      const url = kind === 'plugin' ? DSH_PLUGIN_CATALOG_URL : `${DSH_SKILL_SEARCH_URL}?q=${encodeURIComponent(query || 'skill')}&limit=100`;
      const response = await this.fetchCatalog(url, previous?.etag, signal);
      let entries: DshMarketEntry[];
      if (response.status === 304 && previous) entries = previous.entries;
      else {
        if (!response.ok || !response.body) throw new Error('Catalog request failed.');
        const chunks: Uint8Array[] = []; let length = 0;
        const reader = response.body.getReader();
        try { for (;;) { signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
          length += next.value.byteLength; if (length > MAX_JSON_BYTES) throw new Error('Catalog exceeds the download limit.'); chunks.push(next.value); } }
        finally { await reader.cancel().catch(() => undefined); }
        const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        entries = kind === 'plugin' ? parsePluginCatalog(payload) : parseSkillSearch(payload);
      }
      const updated: Cache = { version: 1, kind, query: kind === 'plugin' ? '' : query,
        entries, fetchedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(), etag: response.headers.get('etag') ?? previous?.etag };
      await atomicJson(path.join(this.cachePath, `${key}.json`), updated); this.caches.set(key, updated); return updated;
    })();
    this.pending.set(key, work); void work.finally(() => this.pending.delete(key)).catch(() => undefined); return work;
  }
  private async fetchCatalog(url: string, etag: string | undefined, signal: AbortSignal): Promise<Response> {
    let current = httpsDownloadUrl(url).href;
    for (let redirects = 0; ; redirects++) {
      const response = await this.options.network.fetch(current, { redirect: 'manual', signal,
        headers: { accept: 'application/json', ...(etag ? { 'if-none-match': etag } : {}) } });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      await response.body?.cancel(); const location = response.headers.get('location');
      if (!location || redirects >= 5) throw new Error('Catalog redirect is invalid.'); current = httpsDownloadUrl(location, current).href;
    }
  }
  async pluginInstallSpec(entryId: string, signal = AbortSignal.timeout(30_000)): Promise<string> {
    const cache = await this.load('plugin', ''); const entry = cache?.entries.find(item => item.id === entryId);
    if (!entry?.npmName || corePackages.has(entry.npmName)) throw new Error('This entry does not provide an installable npm plugin. Open its source to review its installation instructions.');
    const env = await this.options.network.environment?.({});
    const registry = env?.npm_config_registry ?? env?.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org';
    const metadata = record(await this.options.network.json(`${httpsDownloadUrl(registry).href.replace(/\/$/, '')}/${encodeURIComponent(entry.npmName)}`, signal));
    const version = entry.version ?? text(record(metadata['dist-tags']).latest, 128);
    const published = record(record(metadata.versions)[version]);
    if (!exactVersionPattern.test(version) || published.name !== entry.npmName || published.version !== version) throw new Error('The registry did not return a valid exact plugin version.');
    return `${entry.npmName}@${version}`;
  }
}
