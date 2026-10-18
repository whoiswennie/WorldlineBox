import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Session } from 'electron';
import { removeManaged } from '../../src/main/dsh/files';

const transport = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }));
vi.mock('../../src/main/dsh/electron-https-download', () => ({
  createElectronHttpsDownload: () => (url: string, input: unknown) => transport(url, input),
  createElectronPublicationRequest: () => (url: string, input: unknown) => transport(url, input),
}));
import { DEFAULT_LAUNCHER_NETWORK, LauncherNetwork, validateLauncherNetwork } from '../../src/main/dsh/launcher-network';
import { DSH_NPM_METADATA, OfficialVersionCatalogue, parseOfficialNpmVersions } from '../../src/main/dsh/official-versions';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(tmpdir(), root); });
beforeEach(() => { transport.mockReset(); });
async function temporary() { const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-dsh-network-')); roots.push(root); return root; }
function scope() { return { setProxy: vi.fn(async () => undefined), forceReloadProxyConfig: vi.fn(async () => undefined), closeAllConnections: vi.fn(async () => undefined), resolveProxy: vi.fn(async () => 'PROXY 127.0.0.1:7897') }; }
const sri = `sha512-${Buffer.alloc(64, 4).toString('base64')}`;
function release(version: string) { return { name: '@deepseek-ai/dsh', version, engines: { node: '^22.19.0 || >=24.0.0' }, dist: { integrity: sri, tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz` } }; }
const npm = { name: '@deepseek-ai/dsh', 'dist-tags': { latest: '0.2.0-rc.2' }, versions: Object.fromEntries(['0.2.0-rc.2', '0.2.1-alpha.2', '0.2.1-alpha.10'].map(version => [version, release(version)])) };

describe('hot launcher networking', () => {
  it('disables to direct even when the OS has a proxy, and restores the same custom address after restart', async () => {
    const root = await temporary(); const current = scope();
    const service = new LauncherNetwork(root, () => undefined, () => current as unknown as Session); await service.init();
    await service.patch({ proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7896' });
    await service.setProxyEnabled(false);
    expect(current.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' });
    expect(service.state().settings).toMatchObject({ proxyMode: 'direct', proxyUrl: 'http://127.0.0.1:7896', proxyResumeMode: 'custom' });
    const environment = await service.environment({ HTTP_PROXY: 'http://stale.example:9', https_proxy: 'http://stale.example:9', ALL_PROXY: 'http://stale.example:9' });
    expect(environment.HTTP_PROXY).toBeUndefined(); expect(environment.https_proxy).toBeUndefined(); expect(environment.ALL_PROXY).toBeUndefined();
    const reopened = new LauncherNetwork(root, () => undefined, () => scope() as unknown as Session); await reopened.init();
    await reopened.setProxyEnabled(true);
    expect(reopened.state().settings).toMatchObject({ proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7896' });
    expect((await reopened.environment()).HTTPS_PROXY).toBe('http://127.0.0.1:7896');
  });
  it('merges immediate policy changes inside its queue and rolls back a failed switch without losing the previous route', async () => {
    const current = scope(); const service = new LauncherNetwork(await temporary(), () => undefined, () => current as unknown as Session); await service.init();
    await Promise.all([service.patch({ npmRegistry: 'https://mirrors.huaweicloud.com/npm', npmDownloadRoute: 'registry' }), service.patch({ proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7896' })]);
    expect(service.state().settings).toMatchObject({ npmRegistry: 'https://mirrors.huaweicloud.com/npm', npmDownloadRoute: 'registry', proxyUrl: 'http://127.0.0.1:7896' });
    current.setProxy.mockRejectedValueOnce(Error('cannot change route'));
    await expect(service.setProxyEnabled(false)).rejects.toThrow('cannot change route');
    expect(service.state().settings).toMatchObject({ proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7896' });
    expect(current.closeAllConnections).toHaveBeenCalled();
    await service.patch({ proxyMode: 'system' }); await service.setProxyEnabled(false); await service.setProxyEnabled(true);
    expect(service.state().settings.proxyMode).toBe('system');
  });
  it('adds newly offered proxy ports to an old configuration once and keeps user names and later removals', async () => {
    const root = await temporary();
    const settings = { ...DEFAULT_LAUNCHER_NETWORK, proxyPresetsVersion: undefined, proxyProfiles: [
      { id: 'personal', name: 'My personal proxy', url: 'http://127.0.0.1:7896' },
      { id: 'clash-7897', name: 'Existing custom name', url: 'http://127.0.0.1:7897' },
    ] };
    await writeFile(path.join(root, 'network.json'), JSON.stringify(settings));
    const service = new LauncherNetwork(root, () => undefined, () => scope() as unknown as Session); await service.init();
    const migrated = service.state().settings;
    expect(migrated.proxyProfiles.find(profile => profile.id === 'personal')?.name).toBe('My personal proxy');
    expect(migrated.proxyProfiles.find(profile => profile.id === 'clash-7897')?.name).toBe('Existing custom name');
    expect(migrated.proxyProfiles.filter(profile => profile.url === 'http://127.0.0.1:7896')).toHaveLength(1);
    expect(migrated.proxyProfiles.some(profile => profile.url === 'http://127.0.0.1:7898')).toBe(true);
    await service.save({ ...migrated, proxyProfiles: migrated.proxyProfiles.filter(profile => profile.url !== 'http://127.0.0.1:7898') });
    const reopened = new LauncherNetwork(root, () => undefined, () => scope() as unknown as Session); await reopened.init();
    expect(reopened.state().settings.proxyProfiles.some(profile => profile.url === 'http://127.0.0.1:7898')).toBe(false);
  });
  it('updates existing and newly attached sessions and rolls every consumer back if application fails', async () => {
    const first = scope(); const second = scope(); const third = scope();
    const root = await temporary();
    const service = new LauncherNetwork(root, () => undefined, () => first as unknown as Session);
    await service.init(); await service.attachSession(second as unknown as Session);
    const environment = vi.fn<(env: NodeJS.ProcessEnv) => Promise<void>>(async () => undefined);
    await service.setEnvironmentHandler(environment);
    const direct = { ...DEFAULT_LAUNCHER_NETWORK, proxyMode: 'direct' as const };
    await Promise.all([service.save(direct), service.attachSession(third as unknown as Session)]);
    for (const session of [first, second, third]) expect(session.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' });
    expect(environment).toHaveBeenLastCalledWith(expect.not.objectContaining({ HTTP_PROXY: expect.any(String) }));
    second.setProxy.mockRejectedValueOnce(Error('cannot apply proxy'));
    await expect(service.save({ ...direct, proxyMode: 'custom' })).rejects.toThrow('cannot apply proxy');
    expect(service.state().settings.proxyMode).toBe('direct');
    for (const session of [first, second, third]) expect(session.setProxy).toHaveBeenLastCalledWith({ mode: 'direct' });
    expect(JSON.parse(await readFile(path.join(root, 'network.json'), 'utf8')).proxyMode).toBe('direct');
  });
  it('shares a metadata probe, keeps other installs alive on cancellation, and resolves PAC for the selected destination', async () => {
    const proxySession=scope();
    proxySession.resolveProxy.mockImplementation(async (url?:string)=>url?.includes('npmmirror')?'DIRECT':'PROXY 127.0.0.1:7897');
    const service=new LauncherNetwork(await temporary(),()=>undefined,()=>proxySession as unknown as Session);await service.init();
    let finish!:()=>void;
    transport.mockImplementation(async (url:string,input:{signal:AbortSignal})=>{
      if(url.includes('npmmirror'))return new Promise<Response>(resolve=>{finish=()=>resolve(new Response('{"name":"zod","versions":{"4.0.0":{}}}'));});
      return new Promise<Response>((_resolve,reject)=>input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}));
    });
    const controller=new AbortController();const first=service.nodeInstallNetwork(controller.signal);const second=service.nodeInstallNetwork();
    await vi.waitFor(()=>expect(transport).toHaveBeenCalledTimes(2));
    controller.abort(Error('one install cancelled'));await expect(first).rejects.toThrow('one install cancelled');finish();
    const selected=await second;
    expect(selected.registry).toBe('https://registry.npmmirror.com');expect(selected.env.HTTPS_PROXY).toBeUndefined();
    expect(selected.fallback?.env.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
    await service.nodeInstallNetwork();expect(transport).toHaveBeenCalledTimes(2);
    await service.save({...DEFAULT_LAUNCHER_NETWORK,npmDownloadRoute:'registry'});
    expect((await service.nodeInstallNetwork()).registry).toBe('https://registry.npmjs.org');expect(transport).toHaveBeenCalledTimes(2);
    await service.save({...DEFAULT_LAUNCHER_NETWORK,npmRegistry:'https://custom.example'});
    expect((await service.nodeInstallNetwork()).registry).toBe('https://custom.example');expect(transport).toHaveBeenCalledTimes(2);
  });
  it('honors DIRECT as the first PAC choice and removes stale proxy variables from children', async () => {
    const proxySession = scope(); proxySession.resolveProxy.mockResolvedValue('DIRECT; PROXY 127.0.0.1:7897');
    const service = new LauncherNetwork(await temporary(), () => undefined, () => proxySession as unknown as Session); await service.init();
    const env = await service.environment({ proxy:'http://stale:8', npm_config_noproxy:'*', HTTPS_PROXY:'http://stale:8' });
    expect(env.HTTPS_PROXY).toBeUndefined(); expect(env.proxy).toBeUndefined(); expect(env.npm_config_noproxy).toBeUndefined();
    transport.mockResolvedValue(new Response('{}'));
    expect(await service.test()).toContain('DIRECT');
  });
  it('applies and persists changes, aborts old requests, reloads after restart, and derives private command environments', async () => {
    const root = await temporary(); const session = scope(); const changed = vi.fn();
    const service = new LauncherNetwork(root, changed, () => session as unknown as Session); await service.init();
    let requestSignal: AbortSignal | undefined;
    transport.mockImplementation(async (_url, input: { signal: AbortSignal }) => { requestSignal = input.signal; return new Response('{}'); });
    await service.fetch('https://registry.npmjs.org/-/ping', { redirect: 'manual', signal: new AbortController().signal });
    await service.save({ ...DEFAULT_LAUNCHER_NETWORK, proxyMode: 'custom', npmRegistry: 'https://registry.npmmirror.com', pythonIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple' });
    expect(requestSignal?.aborted).toBe(true); expect(service.state().revision).toBe(1); expect(changed).toHaveBeenCalledOnce();
    expect(session.setProxy).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7897' }));
    const env = await service.environment({ DSH_HOME: 'private-home', HTTP_PROXY: 'http://old:8', npm_config_registry: 'old', Path: 'tool-path' });
    expect(env).toMatchObject({ DSH_HOME: 'private-home', HTTP_PROXY: 'http://127.0.0.1:7897', npm_config_registry: 'https://registry.npmmirror.com', NO_PROXY: 'localhost,127.0.0.1,::1' });
    const reopened = new LauncherNetwork(root, () => undefined, () => scope() as unknown as Session); await reopened.init();
    expect(reopened.state().settings).toEqual(service.state().settings);
    await reopened.save({ ...reopened.state().settings, proxyMode: 'direct' });
    expect((await reopened.environment(env)).HTTP_PROXY).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(root, 'network.json'), 'utf8')).proxyMode).toBe('direct');
  });
  it('preserves corrupt configuration and refuses credential-bearing or downgrade endpoints', async () => {
    const root = await temporary(); await writeFile(path.join(root, 'network.json'), '{broken');
    const service = new LauncherNetwork(root, () => undefined, () => scope() as unknown as Session); await service.init();
    expect(service.state().error).toBeTruthy(); expect(await readFile(path.join(root, 'network.json'), 'utf8')).toBe('{broken');
    for (const patch of [{ npmRegistry: 'http://registry.npmjs.org' }, { proxyUrl: 'http://name:secret@127.0.0.1:7897' }, { githubMirror: 'custom', githubMirrorUrl: 'javascript:alert(1)' }])
      expect(() => validateLauncherNetwork({ ...DEFAULT_LAUNCHER_NETWORK, ...patch })).toThrow();
  });
  it('falls back only for GitHub resources, cancels rejected bodies and keeps primary npm metadata primary', async () => {
    const service = new LauncherNetwork(await temporary(), () => undefined, () => scope() as unknown as Session); await service.init();
    const cancel = vi.fn(); transport.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 403 })).mockResolvedValueOnce(new Response('{"ok":true}'));
    expect(await service.json('https://api.github.com/repos/deepseek-ai/deepseek-harness/releases')).toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledOnce(); expect(transport.mock.calls[1]?.[0]).toContain('https://gh-proxy.com/https://api.github.com');
    expect(service.githubCandidates(DSH_NPM_METADATA)).toEqual([DSH_NPM_METADATA]);
    expect((await service.environment()).HTTP_PROXY).toBe('http://127.0.0.1:7897');
  });
  it('uses the selected npm mirror for tarball bytes, falls back on transport failure, and leaves official integrity metadata canonical', async () => {
    const service = new LauncherNetwork(await temporary(), () => undefined, () => scope() as unknown as Session); await service.init();
    await service.save({ ...DEFAULT_LAUNCHER_NETWORK, npmRegistry: 'https://registry.npmmirror.com' });
    transport.mockRejectedValueOnce(new Error('mirror unavailable')).mockResolvedValueOnce(new Response('package-bytes'));
    const canonical = release('0.2.0-rc.2').dist.tarball;
    expect(await (await service.fetch(canonical, { redirect: 'manual', signal: new AbortController().signal })).text()).toBe('package-bytes');
    expect(transport.mock.calls.map(call => call[0])).toEqual(['https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.2.0-rc.2.tgz', canonical]);
    expect(parseOfficialNpmVersions(npm).packages['0.2.0-rc.2']?.tarball).toBe(canonical);
  });
});
describe('official executable release catalogue', () => {
  it('sorts actual prerelease versions numerically and rejects substituted tarballs without treating source archives as runtimes', () => {
    const result = parseOfficialNpmVersions(npm);
    expect(result.rows.map(row => row.version)).toEqual(['0.2.1-alpha.10', '0.2.1-alpha.2', '0.2.0-rc.2']);
    expect(result.rows.find(row => row.recommended)?.version).toBe('0.2.0-rc.2');
    const invalid = { ...release('0.2.0-rc.2'), dist: { integrity: sri, tarball: 'https://registry.npmjs.org/another/-/bad.tgz' } };
    expect(() => parseOfficialNpmVersions({ ...npm, versions: { '0.2.0-rc.2': invalid } })).toThrow();
  });
  it('merges official release notes, survives restart and provides cached versions during an outage', async () => {
    const root = await temporary(); const changed = vi.fn();
    const json = vi.fn(async (url: string) => url === DSH_NPM_METADATA ? npm : [{ tag_name: 'dsh-v0.2.1-alpha.2', body: 'Official alpha notes', html_url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.2' }]);
    const service = new OfficialVersionCatalogue({ rootPath: root, json, onChanged: changed }); await service.init(); await service.refresh();
    expect(service.state().source).toBe('github-npm'); expect(service.state().entries.find(row => row.version === '0.2.1-alpha.2')?.notes).toBe('Official alpha notes');
    const reopened = new OfficialVersionCatalogue({ rootPath: root, json: async () => { throw Error('offline'); }, onChanged: changed }); await reopened.init(); await reopened.refresh();
    expect(reopened.state()).toMatchObject({ source: 'cache', stale: true }); expect(reopened.state().entries).toHaveLength(3);
  });
});
