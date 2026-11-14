import path from 'node:path';
import { dshVersionsStateSchema, type DshVersionsState, type DshOfficialVersion } from '../../shared/dsh-launcher';
import { compareDshVersions, dshVersionPattern as VERSION } from '../../shared/dsh-version-order';
import { atomicJson, readJson, redact } from './files';
import { validateOfficialNodeRelease, type OfficialNodeRelease } from './node-runtime-service';

const PACKAGE = '@deepseek-ai/dsh';
export const DSH_NPM_METADATA = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh';
export const DSH_GITHUB_RELEASES = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100';
const CATALOGUE_MAX_AGE = 15 * 60_000;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
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
  rows.sort((a, b) => compareDshVersions(b.version, a.version)); return { rows, packages };
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
  private verifiedPackages = new Map<string, OfficialNodeRelease>();
  private refreshing?: Promise<void>;
  constructor(private readonly options: { rootPath: string; json(url: string, signal?: AbortSignal, revalidate?: boolean): Promise<unknown>; onChanged(): void }) {}
  state(): DshVersionsState { return structuredClone(this.value); }
  isFresh(): boolean {
    const age = Date.now() - Date.parse(this.value.fetchedAt ?? '');
    return !this.value.error && this.value.entries.length > 0 && age >= 0 && age < CATALOGUE_MAX_AGE;
  }
  async init(): Promise<void> {
    const cache = await readJson<{ state?: unknown }>(path.join(this.options.rootPath, 'official-versions.json')).catch(() => undefined);
    const parsed = dshVersionsStateSchema.safeParse(cache?.state);
    if (parsed.success && parsed.data.source === 'github-npm') {
      this.value = { ...parsed.data, source: 'cache' };
      this.value.stale = !this.isFresh();
    }
  }
  refresh(signal?: AbortSignal, update?: (phase: string, progress: number) => Promise<void>): Promise<void> {
    this.refreshing ??= this.refreshNow(signal, update).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async readSource(source: string, url: string, signal?: AbortSignal, revalidate?: boolean): Promise<unknown> {
    try { return await this.options.json(url, signal, revalidate); }
    catch (error) {
      signal?.throwIfAborted();
      throw new Error(`${source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  private async refreshNow(signal?: AbortSignal, update?: (phase: string, progress: number) => Promise<void>): Promise<void> {
    try {
      await update?.('catalogue-fetching', 0);
      const controller = new AbortController();
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let received = 0;
      const read = async (url: string, source: string, waiting: string) => {
        const result = await this.readSource(source, url, requestSignal, true);
        requestSignal.throwIfAborted();
        if (++received === 1) await update?.(waiting, 50);
        return result;
      };
      const reads = [
        read(DSH_NPM_METADATA, 'npm', 'catalogue-waiting-github'),
        read(DSH_GITHUB_RELEASES, 'GitHub', 'catalogue-waiting-npm'),
      ] as const;
      let documents: [unknown, unknown];
      try { documents = await Promise.all(reads); }
      catch (error) { controller.abort(error); await Promise.allSettled(reads); throw error; }
      signal?.throwIfAborted();
      await update?.('catalogue-verifying', 85);
      const npm = parseOfficialNpmVersions(documents[0]);
      const releases = documents[1];
      if (!Array.isArray(releases)) throw new Error('GitHub Release catalogue is invalid.');
      const notes = new Map(releases.flatMap(value => { const release = publishedRelease(value); return release ? [[release.version, release] as const] : []; }));
      const entries = npm.rows.filter(row => notes.has(row.version)).map(row => {
        const info = notes.get(row.version)!;
        return { ...row, ...(info.body ? { notes: info.body } : {}), ...(info.date ? { publishedAt: info.date } : {}), releaseUrl: info.url };
      });
      if (!entries.length) throw new Error('No GitHub Release matches an official Web package.');
      const next: DshVersionsState = { entries, source: 'github-npm', stale: false, fetchedAt: new Date().toISOString() };
      signal?.throwIfAborted();
      await atomicJson(path.join(this.options.rootPath, 'official-versions.json'), { state: next });
      this.verifiedPackages = new Map(entries.map(entry => [entry.version, npm.packages[entry.version]!]));
      this.value = next;
    } catch (error) {
      signal?.throwIfAborted();
      this.value = { ...this.value, stale: true, error: redact(error instanceof Error ? error.message : String(error)) };
      throw error;
    } finally {
      this.options.onChanged();
    }
  }
  async release(version: string, signal?: AbortSignal): Promise<OfficialNodeRelease> {
    if (!VERSION.test(version)) throw new Error('发行版本号无效。');
    signal?.throwIfAborted();
    // The live catalogue already matched this exact GitHub release with its
    // canonical npm tarball and integrity. Disk-only entries are display data.
    const verified = this.isFresh() ? this.verifiedPackages.get(version) : undefined;
    if (verified) return { ...verified };
    const release = publishedRelease(await this.readSource('GitHub', `https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v${version}`, signal));
    if (!release || release.version !== version) throw new Error('所选版本没有匹配的官方 GitHub Release。');
    const value = await this.readSource('npm', `${DSH_NPM_METADATA}/${encodeURIComponent(version)}`, signal);
    if (!record(value) || value.name !== PACKAGE || value.version !== version) throw new Error('官方版本身份校验失败。');
    const parsed = parseOfficialNpmVersions({ name: PACKAGE, versions: { [version]: value }, 'dist-tags': {}, time: {} });
    return parsed.packages[version]!;
  }
}
