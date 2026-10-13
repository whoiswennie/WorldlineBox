import path from 'node:path';
import { session, type Session } from 'electron';
import { dshNetworkSettingsSchema, type DshNetworkSettings } from '../../shared/dsh-launcher';
import { atomicJson, readJson } from './files';
import { createElectronHttpsDownload, createElectronPublicationRequest } from './electron-https-download';
import type { PackPublishRequest } from './pack-distribution';
import type { HttpsDownloadFetch } from './https-download';

export const DEFAULT_LAUNCHER_NETWORK: DshNetworkSettings = {
  proxyMode: 'system', proxyUrl: 'http://127.0.0.1:7897',
  proxyProfiles: [{ id: 'clash-7897', name: 'Clash Verge · 7897', url: 'http://127.0.0.1:7897' }, { id: 'clash-7890', name: 'Clash · 7890', url: 'http://127.0.0.1:7890' }],
  npmRegistry: 'https://registry.npmjs.org', pythonIndex: 'https://pypi.org/simple', githubMirror: 'auto', githubMirrorUrl: '',
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
  settings.proxyProfiles = settings.proxyProfiles.map(profile => ({ ...profile, url: endpoint(profile.url, ['http:', 'https:', 'socks5:']) }));
  if (settings.githubMirror === 'custom') settings.githubMirrorUrl = `${endpoint(settings.githubMirrorUrl, ['https:'])}/`;
  return settings;
}

/** One application-owned Chromium session handles downloads; no system proxy settings are changed. */
export class LauncherNetwork {
  private settings = structuredClone(DEFAULT_LAUNCHER_NETWORK);
  private revision = 0;
  private issue?: string;
  private queue = Promise.resolve();
  private transport?: HttpsDownloadFetch;
  private scope?: Session;
  private lifetime = new AbortController();
  constructor(private readonly rootPath: string, private readonly onChanged: () => void,
    private readonly createSession = () => session.fromPartition('persist:worldlinebox-dsh-network')) {}
  state() { return { settings: structuredClone(this.settings), revision: this.revision, ...(this.issue ? { error: this.issue } : {}) }; }
  async init(): Promise<void> {
    try { const stored = await readJson<unknown>(path.join(this.rootPath, 'network.json')); if (stored) this.settings = validateLauncherNetwork(stored); }
    catch { this.issue = '网络配置读取失败，已采用默认设置；原文件保留。'; }
    this.scope = this.createSession(); this.transport = createElectronHttpsDownload(this.scope); await this.apply();
  }
  private async apply(): Promise<void> {
    const settings = this.settings;
    await this.scope!.setProxy(settings.proxyMode === 'custom'
      ? { mode: 'fixed_servers', proxyRules: settings.proxyUrl, proxyBypassRules: '<local>;localhost;127.0.0.1;[::1]' }
      : { mode: settings.proxyMode });
    await this.scope!.forceReloadProxyConfig();
  }
  save(value: DshNetworkSettings): Promise<void> {
    const settings = validateLauncherNetwork(value);
    const work = this.queue.then(async () => {
      const previous = this.settings; this.settings = settings;
      try { await this.apply(); await atomicJson(path.join(this.rootPath, 'network.json'), settings); }
      catch (error) { this.settings = previous; await this.apply(); throw error; }
      this.issue = undefined; this.revision++; this.lifetime.abort(new Error('Network settings changed.')); this.lifetime = new AbortController();
      await this.scope!.closeAllConnections(); this.onChanged();
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
        if (response.ok || candidate === candidates.at(-1)) return response;
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
  async environment(base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
    await this.queue;
    const env = { ...base };
    for (const key of Object.keys(env)) if (/^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|npm_config_(?:registry|proxy|https_proxy)|PIP_INDEX_URL)$/i.test(key)) delete env[key];
    let proxy = this.settings.proxyMode === 'custom' ? this.settings.proxyUrl : '';
    if (this.settings.proxyMode === 'system') {
      const rule = await this.scope!.resolveProxy(this.settings.npmRegistry);
      const match = /(?:^|;\s*)(PROXY|HTTPS|SOCKS5?)\s+([^;]+)/.exec(rule);
      if (match) proxy = `${match[1] === 'HTTPS' ? 'https' : match[1]!.startsWith('SOCKS') ? 'socks5' : 'http'}://${match[2]}`;
    }
    if (proxy) Object.assign(env, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, npm_config_proxy: proxy, npm_config_https_proxy: proxy });
    Object.assign(env, { NO_PROXY: 'localhost,127.0.0.1,::1', npm_config_registry: this.settings.npmRegistry,
      npm_config_fetch_timeout: '600000', npm_config_fetch_retries: '3', PIP_INDEX_URL: this.settings.pythonIndex });
    return env;
  }
  async nodeInstallNetwork(signal?: AbortSignal) { signal?.throwIfAborted(); return { env: await this.environment(), registry: this.settings.npmRegistry }; }
  async test(signal?: AbortSignal): Promise<string> {
    await this.json(`${this.settings.npmRegistry}/-/ping`, signal);
    return 'npm 网络连通，当前代理与镜像设置已应用。';
  }
}
