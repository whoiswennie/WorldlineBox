import { afterEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { DshInstance } from '../../src/shared/dsh-launcher';
import { MarketplaceService, parsePluginCatalog, parseSkillSearch, type DshMarketplaceNetwork } from '../../src/main/dsh/marketplace';
import { SkillInstaller } from '../../src/main/dsh/skill-installer';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixtureRoot(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-market-test-')); roots.push(root); return root; }
function fixtureInstance(root: string, id: string): DshInstance {
  const directory = path.join(root, 'instances', id);
  return { id, name: id, runtimeId: 'runtime-test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    profile: 'web', status: 'stopped', homePath: path.join(directory, 'home'), agentsPath: path.join(directory, 'agents'),
    workspacePath: path.join(directory, 'workspace'), browserPartition: `persist:${id}`, isDefault: false };
}
const commit = 'a'.repeat(40);
const document = '---\nname: fixture-skill\ndescription: A local fixture skill\n---\nUse the support file.\n';
function repositoryZip(extra?: (zip: AdmZip) => void): Buffer {
  const zip = new AdmZip(); zip.addFile('repo-commit/skills/fixture/SKILL.md', Buffer.from(document));
  zip.addFile('repo-commit/skills/fixture/scripts/support.py', Buffer.from('print("fixture")\n'));
  zip.addFile('repo-commit/unselected/README.md', Buffer.from('Not installed.')); extra?.(zip); return zip.toBuffer();
}
function fixtureNetwork(bytes = repositoryZip()): DshMarketplaceNetwork {
  return { fetch: vi.fn(async () => new Response(new Uint8Array(bytes))), githubCandidates: url => [url],
    json: vi.fn(async url => url.includes('/commits/') ? { sha: commit } : { default_branch: 'main' }) };
}
describe('DSH catalogs', () => {
  it('parses current catalog metadata without interpreting installation text as commands', () => {
    const entries = parsePluginCatalog({ plugins: [
      { name: 'fixture', url: 'https://github.com/acme/fixture', npm: '@acme/dsh-fixture', description: { zh: '描述' }, install: 'curl | bash', risk_labels: ['filesystem'], stars: 9 },
      { name: 'unsafe', url: 'https://example.invalid/repo', npm: 'bad;calc' },
    ] });
    expect(entries).toHaveLength(1); expect(entries[0]).toMatchObject({ description: '描述', npmName: '@acme/dsh-fixture', riskLabels: ['filesystem'] });
    expect(parseSkillSearch({ skills: [{ id: 'test', name: 'Test', skillId: 'fixture-skill', source: 'acme/fixture', installs: 10 }] })[0]).toMatchObject({ name: 'fixture-skill', repository: 'acme/fixture', downloads: 10 });
  });
  it('keeps a paginated catalog across restarts, revalidates ETags and falls back to stale entries', async () => {
    const rootPath = await fixtureRoot(); let now = Date.now(); let requests = 0;
    const network = fixtureNetwork(); network.fetch = vi.fn(async (_url, input) => {
      requests++; if (requests === 1) return new Response(JSON.stringify({ plugins: Array.from({ length: 32 }, (_, index) => ({ name: `fixture-${index}`, url: `https://github.com/acme/plugin-${index}`, stars: index })) }), { headers: { etag: '"v1"' } });
      expect(input.headers?.['if-none-match']).toBe('"v1"'); if (requests === 2) return new Response(null, { status: 304 }); throw new Error('offline');
    });
    const market = new MarketplaceService({ rootPath, network, now: () => now });
    expect(await market.search({ kind: 'plugin', query: 'fixture', page: 2, pageSize: 10 })).toMatchObject({ total: 32, page: 2, stale: false });
    expect((await market.search({ kind: 'plugin', query: 'fixture', page: 1 })).entries[0]?.name).toBe('fixture-31'); expect(requests).toBe(1);
    now += 31 * 60_000; const restarted = new MarketplaceService({ rootPath, network, now: () => now });
    expect((await restarted.search({ kind: 'plugin', query: '' })).stale).toBe(false);
    now += 31 * 60_000; expect(await restarted.search({ kind: 'plugin', query: '' })).toMatchObject({ stale: true, total: 32 });
  });
  it('pins plugin install specs to verified exact registry versions and rejects core packages', async () => {
    const rootPath = await fixtureRoot(); const network = fixtureNetwork();
    network.fetch = vi.fn(async () => new Response(JSON.stringify({ plugins: [
      { name: 'fixture', url: 'https://github.com/acme/fixture', npm: '@acme/fixture' },
      { name: 'core', url: 'https://github.com/deepseek-ai/deepseek-harness', npm: '@deepseek-ai/dsh-base' },
    ] })));
    network.json = vi.fn(async () => ({ 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': { name: '@acme/fixture', version: '1.2.3' } } }));
    const market = new MarketplaceService({ rootPath, network }); const page = await market.search({ kind: 'plugin', query: '' });
    expect((await market.search({ kind: 'plugin', query: '@acme/fixture' })).entries.map(entry => entry.npmName)).toEqual(['@acme/fixture']);
    expect(await market.pluginInstallSpec(page.entries.find(entry => entry.name === 'fixture')!.id)).toBe('@acme/fixture@1.2.3');
    await expect(market.pluginInstallSpec(page.entries.find(entry => entry.name === 'core')!.id)).rejects.toThrow('installable npm');
    network.json = vi.fn(async () => ({ 'dist-tags': { latest: 'latest;calc.exe' }, versions: {} }));
    await expect(market.pluginInstallSpec(page.entries.find(entry => entry.name === 'fixture')!.id)).rejects.toThrow('exact plugin version');
  });
});
describe('Private pinned skill installation', () => {
  it('moves from an unresponsive direct GitHub source to a configured mirror while preserving the pinned archive digest', async () => {
    const rootPath = await fixtureRoot(); const bytes = repositoryZip(); const network = fixtureNetwork(bytes); let started!: () => void;
    const firstRequest = new Promise<void>(resolve => { started = resolve; });
    network.githubCandidates = url => [url, `https://mirror.invalid/${url}`];
    network.fetch = vi.fn(async (url, input) => {
      if (url.startsWith('https://codeload.github.com')) { started(); return await new Promise<Response>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('stalled')), { once: true })); }
      return new Response(new Uint8Array(bytes));
    });
    const installer = new SkillInstaller({ rootPath, network, sourceResponseTimeoutMs: 20 }); const inspection = installer.inspectSkill('acme/fixture'); void inspection.catch(() => undefined);
    await firstRequest; expect((await inspection).targets[0]?.name).toBe('fixture-skill'); expect(network.fetch).toHaveBeenCalledTimes(2);
  });
  it('installs only the selected component, records origin, and toggles/removes without touching another instance', async () => {
    const rootPath = await fixtureRoot(); const network = fixtureNetwork(); const installer = new SkillInstaller({ rootPath, network });
    const a = fixtureInstance(rootPath, 'instance-a'); const b = fixtureInstance(rootPath, 'instance-b');
    const inspection = await installer.inspectSkill('acme/fixture'); expect(inspection.commit).toBe(commit); expect(inspection.targets).toHaveLength(1);
    const installed = await installer.installSkill(a, inspection.targets[0]!);
    expect(await readFile(path.join(installed.path, 'scripts', 'support.py'), 'utf8')).toContain('fixture');
    await expect(readFile(path.join(installed.path, 'unselected', 'README.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await installer.listSkills(b)).toEqual([]); expect(await installer.listSkills(a)).toEqual([expect.objectContaining({ enabled: true, managed: true, commit })]);
    await installer.setSkillEnabled(a, installed.name, false); expect(await installer.listSkills(a)).toEqual([expect.objectContaining({ enabled: false })]);
    await expect(readFile(path.join(installed.path, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await installer.setSkillEnabled(a, installed.name, true); await installer.removeSkill(a, installed.name); expect(await installer.listSkills(a)).toEqual([]);
  });
  it('refuses overwrite and validates inspection metadata before committing', async () => {
    const rootPath = await fixtureRoot(); const installer = new SkillInstaller({ rootPath, network: fixtureNetwork() }); const instance = fixtureInstance(rootPath, 'instance-a');
    const target = (await installer.inspectSkill('acme/fixture')).targets[0]!;
    await expect(installer.installSkill(instance, { ...target, description: 'Tampered metadata' })).rejects.toThrow('inspected document');
    expect(await installer.listSkills(instance)).toEqual([]); await installer.installSkill(instance, target);
    await expect(installer.installSkill(instance, target)).rejects.toThrow('already exists');
  });
  it('recovers a portable pinned origin after a pack or clone copies the skill without local receipts', async () => {
    const rootPath = await fixtureRoot(); const installer = new SkillInstaller({ rootPath, network: fixtureNetwork() });
    const a = fixtureInstance(rootPath, 'instance-a'); const b = fixtureInstance(rootPath, 'instance-b');
    const target = (await installer.inspectSkill('acme/fixture')).targets[0]!; await installer.installSkill(a, target); await installer.setSkillEnabled(a, target.name, false);
    const copied = path.join(b.homePath, 'skills-disabled', target.name); await mkdir(path.dirname(copied), { recursive: true });
    await cp(path.join(a.homePath, 'skills-disabled', target.name), copied, { recursive: true });
    expect(await installer.listSkills(b)).toEqual([expect.objectContaining({ enabled: false, managed: true, commit, archiveSha256: target.archiveSha256 })]);
    await installer.setSkillEnabled(b, target.name, true); await installer.removeSkill(b, target.name);
    expect(await installer.listSkills(a)).toEqual([expect.objectContaining({ enabled: false, managed: true })]);
  });
  it('rejects unsafe entries even outside the selected component and refuses linked private skill roots', async () => {
    const rootPath = await fixtureRoot(); const zip = repositoryZip(archive => { archive.addFile('repo-commit/unselected/link', Buffer.from('target')); const entry = archive.getEntry('repo-commit/unselected/link')!; entry.header.attr = (0o120777 << 16) >>> 0; });
    const installer = new SkillInstaller({ rootPath, network: fixtureNetwork(zip) });
    await expect(installer.inspectSkill('acme/fixture')).rejects.toThrow('linked or unsupported');
    const clean = new SkillInstaller({ rootPath, network: fixtureNetwork() }); const target = (await clean.inspectSkill('acme/fixture')).targets[0]!;
    const instance = fixtureInstance(rootPath, 'instance-b'); await mkdir(instance.agentsPath, { recursive: true }); await writeFile(path.join(instance.agentsPath, 'skills'), 'not a directory');
    await expect(clean.installSkill(instance, target)).rejects.toThrow();
  });
  it('manages valid local skills only inside the selected private instance and records their local origin', async () => {
    const rootPath = await fixtureRoot(); const installer = new SkillInstaller({ rootPath, network: fixtureNetwork() }); const instance = fixtureInstance(rootPath, 'instance-a');
    await mkdir(path.join(instance.agentsPath, 'skills', 'fixture-skill'), { recursive: true }); await writeFile(path.join(instance.agentsPath, 'skills', 'fixture-skill', 'SKILL.md'), document);
    expect(await installer.listSkills(instance)).toEqual([expect.objectContaining({ managed: false })]);
    await installer.setSkillEnabled(instance, 'fixture-skill', false);
    expect(await installer.listSkills(instance)).toEqual([expect.objectContaining({ managed: true, enabled: false })]);
    await installer.removeSkill(instance, 'fixture-skill'); expect(await installer.listSkills(instance)).toEqual([]);
    await expect(installer.listSkills({ ...instance, agentsPath: path.join(rootPath, 'foreign') })).rejects.toThrow('private agents directory');
  });
  it('uses physical skill activation after an external move rather than an outdated installation receipt', async () => {
    const rootPath = await fixtureRoot(); const installer = new SkillInstaller({ rootPath, network: fixtureNetwork() }); const instance = fixtureInstance(rootPath, 'instance-a');
    const target = (await installer.inspectSkill('acme/fixture')).targets[0]!; const installed = await installer.installSkill(instance, target);
    const disabled = path.join(instance.homePath, 'skills-disabled', target.name); await rename(installed.path, disabled);
    await installer.setSkillEnabled(instance, target.name, true);
    expect(await installer.listSkills(instance)).toEqual([expect.objectContaining({ enabled: true, path: installed.path })]);
    await rename(installed.path, disabled); await installer.removeSkill(instance, target.name); expect(await installer.listSkills(instance)).toEqual([]);
  });
  it('rejects ambiguous duplicate local skills instead of choosing a directory to change', async () => {
    const rootPath = await fixtureRoot(); const installer = new SkillInstaller({ rootPath, network: fixtureNetwork() }); const instance = fixtureInstance(rootPath, 'instance-a');
    for (const directory of [path.join(instance.agentsPath, 'skills', 'fixture-skill'), path.join(instance.homePath, 'skills-disabled', 'fixture-skill')]) {
      await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'SKILL.md'), document);
    }
    await expect(installer.setSkillEnabled(instance, 'fixture-skill', false)).rejects.toThrow('both active and disabled');
    await expect(installer.removeSkill(instance, 'fixture-skill')).rejects.toThrow('both active and disabled');
    expect(await installer.listSkills(instance)).toHaveLength(2);
  });
});
