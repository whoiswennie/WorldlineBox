import path from 'node:path';
import { dshVersionsStateSchema, type DshVersionsState, type DshOfficialVersion } from '../../shared/dsh-launcher';
import { atomicJson, readJson } from './files';
import { validateOfficialNodeRelease, type OfficialNodeRelease } from './node-runtime-service';

const PACKAGE = '@deepseek-ai/dsh';
export const DSH_NPM_METADATA = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh';
export const DSH_GITHUB_RELEASES = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100';
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function compare(a: string, b: string): number {
  const [av, ap] = a.split('-'); const [bv, bp] = b.split('-');
  const x = av!.split('.').map(Number); const y = bv!.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  if (!ap || !bp) return !ap && !bp ? 0 : !ap ? 1 : -1;
  const p = ap.split('.'); const q = bp.split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1;
    const n = /^\d+$/.test(p[i]!); const m = /^\d+$/.test(q[i]!);
    if (n && m) return Number(p[i]) - Number(q[i]);
    if (n !== m) return n ? -1 : 1;
    return p[i]!.localeCompare(q[i]!);
  }
  return 0;
}
export function parseOfficialNpmVersions(value: unknown): { rows: DshOfficialVersion[]; packages: Record<string, OfficialNodeRelease> } {
  if (!record(value) || value.name !== PACKAGE || !record(value.versions)) throw new Error('官方 npm 版本目录格式不正确。');
  const latest = record(value['dist-tags']) ? value['dist-tags'].latest : undefined;
  const times = record(value.time) ? value.time : {};
  const packages: Record<string, OfficialNodeRelease> = {}; const rows: DshOfficialVersion[] = [];
  for (const [version, entry] of Object.entries(value.versions)) {
    if (!VERSION.test(version) || !record(entry) || entry.name !== PACKAGE || entry.version !== version || !record(entry.dist)) continue;
    const integrity = entry.dist.integrity; const tarball = entry.dist.tarball;
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity) || typeof tarball !== 'string') continue;
    let url: URL; try { url = new URL(tarball); } catch { continue; }
    if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password) continue;
    try { packages[version] = validateOfficialNodeRelease({ version, tarball, integrity }); } catch { continue; }
    const preview = version.split('-')[1];
    rows.push({ version, channel: !preview ? 'stable' : preview.startsWith('rc') ? 'rc' : preview.startsWith('alpha') ? 'alpha' : preview.startsWith('beta') ? 'beta' : 'preview',
      recommended: version === latest, ...(typeof times[version] === 'string' ? { publishedAt: times[version] } : {}),
      releaseUrl: `https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v${version}`, nodeRange: record(entry.engines) && typeof entry.engines.node === 'string' ? entry.engines.node.slice(0, 128) : '^22.19.0 || >=24.0.0', integrity });
  }
  if (!rows.length || rows.length > 1000) throw new Error('官方 npm 目录没有可校验的发行版。');
  rows.sort((a, b) => compare(b.version, a.version)); return { rows, packages };
}

function publishedRelease(value: unknown): { version: string; body?: string; date?: string; url: string } | undefined {
  if (!record(value) || value.draft === true || typeof value.tag_name !== 'string' || !value.tag_name.startsWith('dsh-v')) return;
  const version = value.tag_name.slice(5);
  const url = `https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v${version}`;
  if (!VERSION.test(version) || value.html_url !== url) return;
  return { version, url, ...(typeof value.body === 'string' ? { body: value.body.slice(0, 30000) } : {}),
    ...(typeof value.published_at === 'string' ? { date: value.published_at } : {}) };
}

/** GitHub Release selects the version; the matching official npm package supplies the native Web distribution. */
export class OfficialVersionCatalogue {
  private value: DshVersionsState = { entries: [], source: 'cache', stale: true };
  private refreshing?: Promise<void>;
  constructor(private readonly options: { rootPath: string; json(url: string, signal?: AbortSignal): Promise<unknown>; onChanged(): void }) {}
  state(): DshVersionsState { return structuredClone(this.value); }
  async init(): Promise<void> {
    const cache = await readJson<{ state?: unknown }>(path.join(this.options.rootPath, 'official-versions.json')).catch(() => undefined);
    const parsed = dshVersionsStateSchema.safeParse(cache?.state);
    if (parsed.success && parsed.data.source === 'github-npm') this.value = { ...parsed.data, source: 'cache', stale: true };
  }
  refresh(signal?: AbortSignal): Promise<void> {
    this.refreshing ??= this.refreshNow(signal).finally(() => { this.refreshing = undefined; }); return this.refreshing;
  }
  private async refreshNow(signal?: AbortSignal): Promise<void> {
    try {
      const results = await Promise.allSettled([this.options.json(DSH_NPM_METADATA, signal), this.options.json(DSH_GITHUB_RELEASES, signal)]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      const npm = parseOfficialNpmVersions((results[0] as PromiseFulfilledResult<unknown>).value);
      const releases = (results[1] as PromiseFulfilledResult<unknown>).value;
      if (!Array.isArray(releases)) throw new Error('GitHub Release catalogue is invalid.');
      const notes = new Map(releases.flatMap(value => { const release = publishedRelease(value); return release ? [[release.version, release] as const] : []; }));
      const entries = npm.rows.filter(row => notes.has(row.version)).map(row => {
        const info = notes.get(row.version)!;
        return { ...row, ...(info.body ? { notes: info.body } : {}), ...(info.date ? { publishedAt: info.date } : {}), releaseUrl: info.url };
      });
      if (!entries.length) throw new Error('No GitHub Release matches an official Web package.');
      const next: DshVersionsState = { entries, source: 'github-npm', stale: false, fetchedAt: new Date().toISOString() };
      await atomicJson(path.join(this.options.rootPath, 'official-versions.json'), { state: next });
      this.value = next;
    } catch {
      this.value = { ...this.value, stale: true, error: 'GitHub Release 或官方 Web 包目录暂时不可用，保留已核对的缓存。请检查代理与镜像。' };
      if (!this.value.entries.length) { this.options.onChanged(); throw new Error(this.value.error); }
    }
    this.options.onChanged();
  }
  async release(version: string, signal?: AbortSignal): Promise<OfficialNodeRelease> {
    if (!VERSION.test(version)) throw new Error('发行版本号无效。');
    const release = publishedRelease(await this.options.json(`https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v${version}`, signal));
    if (!release || release.version !== version) throw new Error('所选版本没有匹配的官方 GitHub Release。');
    const value = await this.options.json(`${DSH_NPM_METADATA}/${encodeURIComponent(version)}`, signal);
    if (!record(value) || value.name !== PACKAGE || value.version !== version) throw new Error('官方版本身份校验失败。');
    const parsed = parseOfficialNpmVersions({ name: PACKAGE, versions: { [version]: value }, 'dist-tags': {}, time: {} });
    return parsed.packages[version]!;
  }
}
