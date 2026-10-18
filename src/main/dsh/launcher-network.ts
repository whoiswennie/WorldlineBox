import path from 'node:path';
import { session, type Session } from 'electron';
import { dshNetworkSettingsSchema, dshNetworkPatchSchema, type DshNetworkSettings, type DshNetworkPatch, type DshNetworkState } from '../../shared/dsh-launcher';
import { LOCAL_HTTP_PROXY_PORTS } from '../../shared/network-presets';
import { atomicJson, readJson } from './files';
import { createElectronHttpsDownload, createElectronPublicationRequest } from './electron-https-download';
import type { PackPublishRequest } from './pack-distribution';
import type { HttpsDownloadFetch } from './https-download';
import type { NodeInstallNetwork } from './node-runtime-service';
import { AUTOMATIC_NPM_MIRROR, OFFICIAL_NPM_REGISTRY, selectNpmMetadataRoute, type NpmMetadataRoute } from './npm-registry-route';
import { checkNetworkSource } from './network-diagnostics';

export const DEFAULT_LAUNCHER_NETWORK: DshNetworkSettings = {
  proxyMode: 'system', proxyUrl: 'http://127.0.0.1:7897',
  proxyPresetsVersion: 1,
  proxyProfiles: LOCAL_HTTP_PROXY_PORTS.map(port => ({ id: 'clash-' + port, name: 'localhost · ' + port, url: 'http://127.0.0.1:' + port })),
  npmRegistry: 'https://registry.npmjs.org', pythonIndex: 'https://pypi.org/simple', githubMirror: 'auto', githubMirrorUrl: '',
  npmDownloadRoute: 'auto',
};
const MIRRORS = { 'gh-proxy': 'https://gh-proxy.com/', ghfast: 'https://ghfast.top/', ghproxy: 'https://ghproxy.net/' } as const;
function endpoint(value: string, protocols: string[]): string {
  let url: URL; try { url = new URL(value); } catch { throw new Error('地址不是有效 URL。'); }
  if (!protocols.includes(url.protocol) || url.username || url.password || !url.hostname || url.hash || url.search) throw new Error('地址协议或格式不受支持，请使用不含账号密码的服务地址。');
  return url.href.replace(/\/$/, '');
}
export function validateLauncherNetwork(value: unknown): DshNetworkSettings {
  const settings = dshNetworkSettingsSchema.parse(value);
  settings.npmRegistry = endpoint(settings.npmRegistry, ['https:']); settings.pythonIndex = endpoint(settings.pythonIndex, ['https:']);
  if (settings.proxyUrl) settings.proxyUrl = endpoint(settings.proxyUrl, ['http:', 'https:', 'socks5:']);
  if (settings.proxyMode === 'custom' && !settings.proxyUrl) throw new Error('请填写代理地址。');
  if (settings.proxyMode === 'custom' && !['http:', 'https:'].includes(new URL(settings.proxyUrl).protocol))
    throw new Error('全局代理请使用 HTTP/HTTPS 地址，例如 Clash 的 HTTP 或混合端口；SOCKS 专用端口不能用于整个项目。');
  settings.proxyProfiles = settings.proxyProfiles.map(profile => ({ ...profile, url: endpoint(profile.url, ['http:', 'https:', 'socks5:']) }));
  if (settings.sourceProfiles) settings.sourceProfiles = settings.sourceProfiles.map(profile => ({ ...profile,
    url: `${endpoint(profile.url, ['https:'])}${profile.kind === 'github' ? '/' : ''}` }));
  for (const profiles of [settings.proxyProfiles, settings.sourceProfiles ?? []]) {
    if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw Error('配置方案 ID 不可重复。');
  }
  if (settings.githubMirror === 'custom') settings.githubMirrorUrl = `${endpoint(settings.githubMirrorUrl, ['https:'])}/`;
  return settings;
}

/** Application sessions share one live policy; the operating system proxy settings are unchanged. */
export class LauncherNetwork {
  private settings = structuredClone(DEFAULT_LAUNCHER_NETWORK);
  private revision = 0;
  private issue?: string;
  private queue = Promise.resolve();
  private transport?: HttpsDownloadFetch;
  private scope?: Session;
  private lifetime = new AbortController();
  private metadataRoute?: { revision:number; expiresAt:number; result:Promise<NpmMetadataRoute> };
  private inspection?: DshNetworkState['inspection'];
  private checks?: DshNetworkState['checks'];
  private npmSelection?: NonNullable<DshNetworkState['inspection']>['npmSelection'];
  private githubSelection?: NonNullable<DshNetworkState['inspection']>['githubSelection'];
  private readonly sessions = new Set<Session>();
  private readonly listeners = new Set<() => void>();
  private applyEnvironment?: (environment: NodeJS.ProcessEnv) => void | Promise<void>;
  private childEnvironment?: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  constructor(private readonly rootPath: string, private readonly onChanged: () => void,
    private readonly createSession = () => session.fromPartition('persist:worldlinebox-dsh-network')) {}
  state(): DshNetworkState { return structuredClone({ settings: this.settings, revision: this.revision,
    ...(this.issue ? { error: this.issue } : {}), inspection: this.inspection, checks: this.checks }); }
  async init(): Promise<void> {
    try {
      const stored = await readJson<unknown>(path.join(this.rootPath, 'network.json'));
      if (stored) {
        const parsed = dshNetworkSettingsSchema.parse(stored);
        if (parsed.proxyMode === 'custom' && /^socks5:/i.test(parsed.proxyUrl)) {
          this.settings = validateLauncherNetwork({ ...parsed, proxyMode: 'direct', proxyResumeMode: 'system' });
          this.issue = '旧配置使用 SOCKS 专用端口，已暂时改为直连。请在全局网络中选择 HTTP/混合端口；原配置文件保留。';
        } else this.settings = validateLauncherNetwork(parsed);
      }
    }
    catch { this.issue = '网络配置读取失败，已采用默认设置；原文件保留。'; }
    if (!this.settings.proxyPresetsVersion) {
      // Older installations already had 7897/7890. Seed only the new suggestions once;
      // a user's own names/addresses and later removals remain authoritative.
      for (const profile of DEFAULT_LAUNCHER_NETWORK.proxyProfiles.slice(2)) {
        if (this.settings.proxyProfiles.length < 30 && !this.settings.proxyProfiles.some(item => item.id === profile.id || item.url === profile.url))
          this.settings.proxyProfiles.push(structuredClone(profile));
      }
      this.settings.proxyPresetsVersion = 1;
    }
    this.scope = this.createSession(); this.sessions.add(this.scope); this.transport = createElectronHttpsDownload(this.scope); await this.apply();
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { this.onChanged(); for (const listener of this.listeners) listener(); }
  attachSession(scope: Session): Promise<void> {
    const work = this.queue.then(async () => { await this.applySession(scope); this.sessions.add(scope); });
    this.queue = work.catch(() => undefined); return work;
  }
  async setEnvironmentHandler(handler: (environment: NodeJS.ProcessEnv) => void | Promise<void>): Promise<void> {
    this.applyEnvironment = handler; await this.queue;
    await handler(await this.commandEnvironment(process.env, this.settings.npmRegistry));
  }
  setChildEnvironmentHandler(handler: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>): void { this.childEnvironment = handler; }
  async resolveProxy(destination: string): Promise<string> { await this.queue; return this.proxyFor(destination); }
  private async applySession(scope: Session): Promise<void> {
    const settings = this.settings;
    await scope.setProxy(settings.proxyMode === 'custom'
      ? { mode: 'fixed_servers', proxyRules: settings.proxyUrl, proxyBypassRules: '<local>;localhost;127.0.0.1;[::1]' }
      : { mode: settings.proxyMode });
    await scope.forceReloadProxyConfig();
  }
  private async apply(): Promise<void> {
    await Promise.all([...this.sessions].map(scope => this.applySession(scope)));
    if (this.applyEnvironment) await this.applyEnvironment(await this.commandEnvironment(process.env, this.settings.npmRegistry));
  }
  save(value: DshNetworkSettings): Promise<void> {
    const settings = validateLauncherNetwork(value);
    return this.update(() => settings);
  }
  patch(value: DshNetworkPatch): Promise<void> {
    const patch = dshNetworkPatchSchema.parse(value);
    return this.update(previous => ({ ...previous, ...patch }));
  }
  setProxyEnabled(enabled: boolean): Promise<void> {
    return this.update(previous => ({ ...previous, proxyMode: enabled
      ? previous.proxyMode === 'direct' ? previous.proxyResumeMode ?? 'system' : previous.proxyMode
      : 'direct' }));
  }
  private update(next: (previous: DshNetworkSettings) => DshNetworkSettings): Promise<void> {
    const work = this.queue.then(async () => {
      const previous = this.settings;
      const candidate = next(previous);
      const settings = validateLauncherNetwork({ ...candidate, proxyResumeMode: candidate.proxyMode !== 'direct' ? candidate.proxyMode
        : previous.proxyMode !== 'direct' ? previous.proxyMode : candidate.proxyResumeMode ?? previous.proxyResumeMode ?? 'system' });
      this.settings = settings;
      try { await this.apply(); await Promise.all([...this.sessions].map(scope => scope.closeAllConnections())); await atomicJson(path.join(this.rootPath, 'network.json'), settings); }
      catch (error) { this.settings = previous; await this.apply(); await Promise.all([...this.sessions].map(scope => scope.closeAllConnections())); throw error; }
      this.issue = undefined; this.revision++; this.lifetime.abort(new Error('Network settings changed.')); this.lifetime = new AbortController();
      this.inspection = undefined; this.checks = undefined; this.npmSelection = undefined; this.githubSelection = undefined;
      this.metadataRoute = undefined; this.changed();
    });
    this.queue = work.catch(() => undefined); return work;
  }
  githubCandidates(value: string): string[] {
    const url = new URL(value);
    if (!['github.com', 'api.github.com', 'raw.githubusercontent.com', 'codeload.github.com', 'objects.githubusercontent.com'].includes(url.hostname)) return [value];
    const mode = this.settings.githubMirror;
    if (mode === 'direct') return [value];
    if (mode === 'custom') return [`${this.settings.githubMirrorUrl}${value}`, value];
    if (mode !== 'auto') return [`${MIRRORS[mode]}${value}`, value];
    return [value, ...Object.values(MIRRORS).map(base => `${base}${value}`)];
  }
  readonly fetch: HttpsDownloadFetch = async (url, options) => {
    await this.queue; if (!this.transport) throw new Error('Network service is not ready.');
    const signal = AbortSignal.any([options.signal, this.lifetime.signal]); const requested = new URL(url);
    const candidates = [url];
    if (requested.hostname === 'registry.npmjs.org' && requested.pathname.endsWith('.tgz') && this.settings.npmRegistry !== 'https://registry.npmjs.org') {
      candidates.unshift(new URL(requested.pathname.replace(/^\//, ''), `${this.settings.npmRegistry}/`).href);
    }
    let rejected: Response | undefined;
    for (const candidate of candidates) {
      signal.throwIfAborted();
      try {
        const response = await this.transport(candidate, { ...options, signal });
        if (response.ok || candidate === candidates.at(-1)) {
          const githubHosts = ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'codeload.github.com', 'objects.githubusercontent.com'];
          const routedGithub = githubHosts.includes(requested.hostname) || githubHosts.some(host => candidate.includes(`https://${host}/`));
          if (response.ok && routedGithub) {
            const previous = this.githubSelection?.url;
            this.githubSelection = { url: candidate, checkedAt: new Date().toISOString() };
            if (this.inspection) this.inspection.githubSelection = this.githubSelection;
            if (!previous || new URL(previous).origin !== new URL(candidate).origin) { await this.inspect(); this.changed(); }
          }
          return response;
        }
        await response.body?.cancel(); rejected = response;
      } catch (error) { signal.throwIfAborted(); if (candidate === candidates.at(-1)) throw error; }
    }
    if (rejected) return rejected;
    throw new Error('The resource request could not connect.');
  };
  async json(url: string, signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<unknown> {
    let status = 0;
    for (const candidate of this.githubCandidates(url)) {
      signal.throwIfAborted();
      try {
        const response = await this.fetch(candidate, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]), headers: { Accept: 'application/json', 'User-Agent': 'WorldlineBox-DSH-Launcher' } });
        status = response.status; if (!response.ok) { await response.body?.cancel(); continue; }
        const reader = response.body?.getReader(); if (!reader) throw new Error('Empty network response.');
        let size = 0; const chunks: Uint8Array[] = [];
        try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 20 * 1024 * 1024) throw new Error('Metadata response exceeds size limit.'); chunks.push(item.value); } }
        finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { if (signal.aborted) signal.throwIfAborted(); }
    }
    throw new Error(status === 403 || status === 429 ? '远端服务限流，请稍后重试或调整代理与镜像。' : `获取资源目录失败${status ? `（HTTP ${status}）` : ''}。`);
  }
  async request(url: string, input: PackPublishRequest): Promise<Response> {
    await this.queue;
    if (!this.scope) throw new Error('Network service is not ready.');
    return createElectronPublicationRequest(this.scope)(url, { ...input, signal: AbortSignal.any([input.signal, this.lifetime.signal]) });
  }
  async environment(base: NodeJS.ProcessEnv = process.env, destination = this.settings.npmRegistry): Promise<NodeJS.ProcessEnv> {
    await this.queue;
    const environment = await this.commandEnvironment(base, destination);
    return this.childEnvironment ? this.childEnvironment(environment) : environment;
  }
  private async commandEnvironment(base: NodeJS.ProcessEnv, destination: string): Promise<NodeJS.ProcessEnv> {
    const env = { ...base };
    for (const key of Object.keys(env)) if (/^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|PROXY|NO_PROXY|npm_config_(?:registry|proxy|https_proxy|noproxy)|PIP_INDEX_URL)$/i.test(key)) delete env[key];
    const resolved = await this.proxyFor(destination);
    const proxy = resolved === 'DIRECT' ? '' : resolved;
    if (proxy) Object.assign(env, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, npm_config_proxy: proxy, npm_config_https_proxy: proxy });
    Object.assign(env, { NO_PROXY: 'localhost,127.0.0.1,::1', npm_config_registry: this.settings.npmRegistry,
      npm_config_fetch_timeout: '120000', npm_config_fetch_retries: '2', PIP_INDEX_URL: this.settings.pythonIndex });
    return env;
  }
  private async proxyFor(destination: string): Promise<string> {
    let proxy = this.settings.proxyMode === 'custom' ? this.settings.proxyUrl : '';
    if (this.settings.proxyMode === 'system') {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const rule = await Promise.race([this.scope!.resolveProxy(destination), new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(Error('系统代理解析超过 5 秒。')), 5_000);
      })]).finally(() => clearTimeout(timeout));
      // Respect the first PAC route, including DIRECT; do not pick a later fallback proxy.
      const match = /^(PROXY|HTTPS|SOCKS5?)\s+([^;]+)/.exec(rule.trim());
      if (match) proxy = `${match[1] === 'HTTPS' ? 'https' : match[1]!.startsWith('SOCKS') ? 'socks5' : 'http'}://${match[2]}`;
    }
    return proxy || 'DIRECT';
  }
  async inspect(): Promise<void> {
    await this.queue;
    const revision = this.revision;
    const destinations = [
      { kind: 'npm' as const, url: this.npmSelection?.registry ?? this.settings.npmRegistry },
      { kind: 'python' as const, url: this.settings.pythonIndex },
      { kind: 'github' as const, url: this.githubSelection?.url ?? this.githubCandidates('https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=1')[0]! },
    ];
    const routes = await Promise.all(destinations.map(async route => {
      try { return { ...route, proxy: await this.proxyFor(route.url) }; }
      catch { return { ...route, proxy: 'UNKNOWN', error: '无法解析此目标的系统代理' }; }
    }));
    if (revision === this.revision) this.inspection = { revision, inspectedAt: new Date().toISOString(), routes,
      npmSelection: this.npmSelection, githubSelection: this.githubSelection };
  }
  async nodeInstallNetwork(signal: AbortSignal = new AbortController().signal): Promise<NodeInstallNetwork> {
    await this.queue; signal.throwIfAborted();
    const automatic = this.settings.npmDownloadRoute === 'auto' && this.settings.npmRegistry === OFFICIAL_NPM_REGISTRY;
    if (!automatic) return { env:await this.environment(),registry:this.settings.npmRegistry };
    const currentSignal = AbortSignal.any([signal,this.lifetime.signal]);
    // Concurrent installs share one short probe; cancelling one install must not cancel another.
    if(!this.metadataRoute||this.metadataRoute.revision!==this.revision||this.metadataRoute.expiresAt<Date.now()) {
      this.metadataRoute = {revision:this.revision,expiresAt:Date.now()+5*60_000,result:selectNpmMetadataRoute(this.fetch,this.lifetime.signal)};
    }
    let removeAbort = () => {};
    let route: NpmMetadataRoute;
    try {
      route = await Promise.race([this.metadataRoute.result, new Promise<never>((_resolve, reject) => {
        const abort = () => reject(currentSignal.reason);
        currentSignal.addEventListener('abort', abort, { once: true });
        removeAbort = () => currentSignal.removeEventListener('abort', abort);
        if (currentSignal.aborted) abort();
      })]);
    } finally { removeAbort(); }
    currentSignal.throwIfAborted();
    const env = await this.environment(process.env, route.registry);
    const fallback = route.registry !== OFFICIAL_NPM_REGISTRY ? { registry: OFFICIAL_NPM_REGISTRY, env: await this.environment(process.env, OFFICIAL_NPM_REGISTRY) } : undefined;
    currentSignal.throwIfAborted();
    const previous = this.npmSelection?.registry;
    this.npmSelection = { registry: route.registry, elapsedMs: route.elapsedMs, probed: route.probed, checkedAt: new Date().toISOString() };
    if (this.inspection) this.inspection.npmSelection = this.npmSelection;
    if (previous !== route.registry) { await this.inspect(); this.changed(); }
    return { env, registry: route.registry, tarballMirror: AUTOMATIC_NPM_MIRROR, metadataRoute: route, ...(fallback ? { fallback } : {}) };
  }
  async test(signal?: AbortSignal): Promise<string> {
    await this.queue;
    const revision = this.revision;
    const currentSignal = AbortSignal.any([signal ?? new AbortController().signal, this.lifetime.signal, AbortSignal.timeout(45_000)]);
    const install = await this.nodeInstallNetwork(currentSignal);
    const github = this.githubCandidates('https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=1');
    const results = await Promise.all([
      checkNetworkSource('npm', [`${install.registry}/zod/latest`], this.fetch, url => this.proxyFor(url), currentSignal),
      checkNetworkSource('python', [`${this.settings.pythonIndex}/`], this.fetch, url => this.proxyFor(url), currentSignal),
      checkNetworkSource('github', github, this.fetch, url => this.proxyFor(url), currentSignal),
    ]);
    currentSignal.throwIfAborted();
    if (revision !== this.revision) throw Error('网络设置已变化，请重新检查。');
    this.checks = { revision, checkedAt: new Date().toISOString(), results };
    await this.inspect(); this.changed();
    return results.map(result => `${result.kind}: ${result.ok ? 'OK' : 'FAILED'}\n${result.attempts.map(attempt => `${attempt.url}\n${attempt.proxy} · ${attempt.elapsedMs} ms${attempt.error ? ` · ${attempt.error}` : ''}`).join('\n')}`).join('\n\n');
  }
}
