import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';
import type { DshInstance, DshRuntime } from '../../src/shared/dsh-launcher';
import { extractSealedArchive, writeSealedArchive } from '../../src/main/dsh/archive';
import { inventoryTree } from '../../src/main/dsh/files';
import { OperationStore } from '../../src/main/dsh/operations';
import { writeNativeRuntimeFixture } from '../helpers/dsh-runtime-fixture';
import { auditPortableConfiguration, PackService, type PackInstanceService } from '../../src/main/dsh/packs';
import type { RuntimeServiceLike } from '../../src/main/dsh/runtime-service';
import { dependencyLockSha256 } from '../../src/main/dsh/node-runtime-service';

const temporaryRoots: string[] = [];
async function temporary(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-dsh-pack-test-')); temporaryRoots.push(root); return root; }
afterEach(async () => { for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function put(root: string, relative: string, text: string): Promise<void> { const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }

async function fixture() {
  const root = await temporary(); const records: DshInstance[] = [];
  const runtime: DshRuntime = { id: 'runtime-one', version: '0.2.0-rc.2', nodeVersion: '24.18.1', platform: 'win32-x64', adapter: 'node-cli-web-v1',
    source: 'test', sourceSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), installedAt: new Date().toISOString(), fileCount: 1, byteLength: 1 };
  const program = path.join(root, 'program'); const receipt = await writeNativeRuntimeFixture(program, runtime.version);
  Object.assign(runtime, { nodeVersion: receipt.nodeVersion, npmVersion: receipt.npmVersion, sourceSha256: receipt.sourceSha256, npmIntegrity: receipt.npmIntegrity, dependencyLockSha256: receipt.dependencyLockSha256 });
  let installed = [runtime];
  const runtimes: RuntimeServiceLike = { list: () => installed, get: id => { const record = installed.find(item => item.id === id); if (!record) throw new Error('Runtime unavailable'); return record; }, directory: () => program, plan: () => ({
    executable: path.join(program, 'bin/node.exe'), cli: path.join(program, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'), env: {},
  }), verify: async () => undefined };
  const instances: PackInstanceService = {
    list: () => records.map(record => ({ ...record })), getRoot: id => path.join(root, 'instances', id),
    async create(name, runtimeId) {
      const id = randomUUID(); const directory = this.getRoot(id);
      for (const component of ['home', 'agents', 'workspace']) await mkdir(path.join(directory, component), { recursive: true });
      const instance: DshInstance = { id, name, runtimeId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), profile: 'web', status: 'stopped',
        homePath: path.join(directory, 'home'), agentsPath: path.join(directory, 'agents'), workspacePath: path.join(directory, 'workspace'), browserPartition: `persist:worldlinebox-dsh-${id}`, isDefault: records.length === 0 };
      records.push(instance); return instance;
    },
    async withStoppedInstance(id, work) { if (records.find(record => record.id === id)?.status !== 'stopped') throw new Error('Stop instance'); return work(); },
    async installDependencies() {},
    async remove(id) { const index = records.findIndex(record => record.id === id); if (index >= 0) records.splice(index, 1); await rm(this.getRoot(id), { recursive: true, force: true }); },
  };
  const operations = new OperationStore(path.join(root, 'operations'), () => undefined); await operations.init();
  const packs = new PackService({ rootPath: root, runtimes, instances, operations, onChanged: () => undefined }); await packs.init();
  const source = await instances.create('Source', runtime.id);
  await put(source.homePath, 'profiles/web/package.json', JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  await put(source.homePath, 'profiles/web/pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  await put(source.homePath, 'profiles/web/node_modules/example-plugin/index.js', 'export const name="example";');
  await put(source.homePath, 'profiles/web/cordis.patch.yml', '- id: harmless\n  config:\n    label: Example\n');
  await put(source.homePath, 'cordis.patch.yml', '[]\n');
  await put(source.homePath, 'skills/example/SKILL.md', '# Example skill\n');
  await put(source.agentsPath, 'skills/agent/SKILL.md', '# Agent skill\n');
  await put(source.homePath, '.credentials.yaml', 'apiKey: sk-never-publish-this\n');
  await put(source.homePath, 'sessions/private.jsonl', '{"private":true}\n');
  await put(source.homePath, '.env', 'SECRET=private\n');
  await put(source.homePath, 'profiles/web/.env', 'SECRET=private\n');
  return { root, program, packs, operations, source, instances, runtime, runtimes, dropRuntime: () => { installed = []; }, replaceRuntimes: (records: DshRuntime[]) => { installed = records; } };
}

describe('sealed DSH archives', () => {
  it('streams a verified archive round trip with its precise file inventory', async () => {
    const root = await temporary(); const data = path.join(root, 'data');
    await put(data, 'home/profiles/web/package.json', '{"version":"pinned"}');
    const archive = path.join(root, 'test.dshpack');
    const manifest = await writeSealedArchive(data, archive, { format: 'test' });
    const recovered = path.join(root, 'recovered');
    expect(await extractSealedArchive(archive, recovered)).toEqual(manifest);
    expect(await readFile(path.join(recovered, 'home/profiles/web/package.json'), 'utf8')).toBe('{"version":"pinned"}');
  });
  it('rejects changed payload bytes, unexpected files, links and case collisions', async () => {
    const root = await temporary(); const data = path.join(root, 'data'); await put(data, 'file.txt', 'original');
    const original = path.join(root, 'original.zip'); await writeSealedArchive(data, original, {});
    for (const mode of ['tamper', 'unexpected', 'link', 'case']) {
      const zip = new AdmZip(original);
      if (mode === 'tamper') zip.updateFile('data/file.txt', Buffer.from('changed'));
      if (mode === 'unexpected') zip.addFile('data/extra.txt', Buffer.from('unexpected'));
      if (mode === 'case') zip.addFile('data/FILE.txt', Buffer.from('original'));
      if (mode === 'link') zip.getEntry('data/file.txt')!.header.attr = (0o120777 << 16) >>> 0;
      const candidate = path.join(root, `${mode}.zip`); zip.writeZip(candidate);
      await expect(extractSealedArchive(candidate, path.join(root, `unpack-${mode}`))).rejects.toThrow();
    }
  });
  it('rejects Windows device names and alternate data streams in inventory paths', async () => {
    const root = await temporary();
    for (const relative of ['home/CON.txt', 'home/file:stream', 'home/../escape']) {
      const zip = new AdmZip();
      // The inventory parser receives these names even if a ZIP writer normalizes its own path.
      zip.addFile('manifest.json', Buffer.from(JSON.stringify({ files: [{ path: relative, sha256: 'a'.repeat(64), size: 0 }], contentSha256: 'b'.repeat(64), fileCount: 1, byteLength: 0 })));
      const archive = path.join(root, `${randomUUID()}.zip`); zip.writeZip(archive);
      await expect(extractSealedArchive(archive, path.join(root, randomUUID()))).rejects.toThrow();
    }
  });
});

describe('portable DSH packs', () => {
  it('reuses a v2 Node runtime with different generated artifact bytes only when its source, interpreter and entire dependency graph match', async () => {
    const test = await fixture(); const version = test.runtime.version; const sri = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
    Object.assign(test.runtime, { adapter: 'node-cli-web-v1', nodeVersion: '22.19.0', npmVersion: '10.9.3', npmIntegrity: sri });
    await put(test.program, 'bin/node.exe', 'fixture-node');
    await put(test.program, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', '// Fixture CLI, never executed');
    await put(test.program, 'dsh/node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' },
      repository: { url: 'git+https://github.com/deepseek-ai/deepseek-harness.git' }, dependencies: { '@deepseek-ai/dsh-base': version, '@deepseek-ai/dsh-web-app': version, '@deepseek-ai/dsh-headless': version } }));
    for (const name of ['dsh-base', 'dsh-web-app', 'dsh-headless']) await put(test.program, `dsh/node_modules/@deepseek-ai/${name}/package.json`, JSON.stringify({ name: `@deepseek-ai/${name}`, version }));
    const rawLock = { lockfileVersion: 3, packages: {
      '': { version: '1.0.0', dependencies: { '@deepseek-ai/dsh': version } },
      'node_modules/@deepseek-ai/dsh': { version, integrity: sri, resolved: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz` },
      'node_modules/example': { version: '1.2.3', integrity: sri, resolved: 'https://registry.npmjs.org/example/-/example-1.2.3.tgz' },
    } };
    await put(test.program, 'dsh/package-lock.json', JSON.stringify(rawLock)); const graph = await dependencyLockSha256(path.join(test.program, 'dsh'));
    const receipt = { format: 'worldlinebox-dsh-node-runtime-v1', version, nodeVersion: test.runtime.nodeVersion, npmVersion: test.runtime.npmVersion,
      package: '@deepseek-ai/dsh', repository: 'https://github.com/deepseek-ai/deepseek-harness', tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`, integrity: sri, npmIntegrity: sri,
      dependencyLockSha256: graph, nodeExecutableSha256: createHash('sha256').update('fixture-node').digest('hex'), sourceSha256: test.runtime.sourceSha256,
      executable: 'bin/node.exe', cli: 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' };
    await put(test.program, 'node-runtime.json', JSON.stringify(receipt));
    await put(test.source.homePath, 'skills-disabled/inactive/SKILL.md', '# Inactive skill\n');
    await test.packs.handle({ type: 'pack.create', instanceId: test.source.id, name: 'Portable Node', version: '1' }); await test.operations.settle();
    expect(test.operations.list()[0]?.status, test.operations.list()[0]?.error).toBe('succeeded'); const pack = test.packs.list()[0]!;
    const archive = path.join(test.root, 'node-v2.dshpack'); const manifest = await test.packs.exportArchive(pack.id, archive, AbortSignal.timeout(10_000));
    expect(manifest.format).toBe('worldlinebox-dshpack-v2'); expect(manifest.files.map(file => file.path)).toContain('runtime-lock/package-lock.json');
    const compatible = { ...test.runtime, id: 'runtime-compatible', contentSha256: 'c'.repeat(64) }; test.replaceRuntimes([compatible]);
    await test.packs.handle({ type: 'pack.import' }, archive); await test.operations.settle(); expect(test.operations.list()[0]?.status, test.operations.list()[0]?.error).toBe('succeeded');
    expect(test.packs.list()[0]?.runtimeId).toBe(compatible.id); await test.packs.handle({ type: 'pack.install', packId: test.packs.list()[0]!.id, name: 'Portable copy' }); await test.operations.settle();
    expect(test.operations.list()[0]?.status, test.operations.list()[0]?.error).toBe('succeeded'); const copy = test.instances.list().find(item => item.name === 'Portable copy')!;
    expect(await readFile(path.join(copy.homePath, 'skills-disabled/inactive/SKILL.md'), 'utf8')).toContain('Inactive');
    expect(await readdir(test.instances.getRoot(copy.id))).not.toContain('runtime-lock');
    // A locally imported runtime cannot forge official source/graph metadata while modifying actual SDK code.
    await put(test.program, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', '// Different SDK code, same claimed receipt and graph');
    await test.packs.handle({ type: 'pack.import' }, archive); await test.operations.settle(); expect(test.operations.list()[0]?.status).toBe('failed');
    expect(test.operations.list()[0]?.error).toContain('exact DSH runtime'); await put(test.program, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', '// Fixture CLI, never executed');
    // Same DSH source/version with a different transitive version must never qualify.
    rawLock.packages['node_modules/example'].version = '1.2.4'; rawLock.packages['node_modules/example'].resolved = 'https://registry.npmjs.org/example/-/example-1.2.4.tgz';
    await put(test.program, 'dsh/package-lock.json', JSON.stringify(rawLock)); receipt.dependencyLockSha256 = await dependencyLockSha256(path.join(test.program, 'dsh'));
    await put(test.program, 'node-runtime.json', JSON.stringify(receipt));
    await test.packs.handle({ type: 'pack.import' }, archive); await test.operations.settle(); expect(test.operations.list()[0]?.status).toBe('failed');
    expect(test.operations.list()[0]?.error).toContain('exact DSH runtime');
  });
  it('restores native model configuration together with plugin options', async () => {
    const { root, packs, operations, instances, source } = await fixture();
    await put(source.homePath, 'profiles/web/cordis.patch.yml', '- id: agent-default-model\n  config:\n    provider: native-provider\n    model: native-model\n- id: harmless\n  config:\n    label: private-plugin-setting\n');
    await packs.handle({ type: 'pack.create', instanceId: source.id, name: 'Native', version: '1' }); await operations.settle();
    const archive = path.join(root, 'native.dshpack'); await packs.exportArchive(packs.list()[0]!.id, archive, AbortSignal.timeout(10000));
    await packs.handle({ type: 'pack.import' }, archive); await operations.settle();
    expect(operations.list()[0]?.status, operations.list()[0]?.error).toBe('succeeded');
    await packs.handle({ type: 'pack.install', packId: packs.list()[0]!.id, name: 'Native copy' }); await operations.settle();
    expect(operations.list()[0]?.status, operations.list()[0]?.error).toBe('succeeded');
    const copy = instances.list().find(record => record.name === 'Native copy')!;
    const patch = await readFile(path.join(copy.homePath, 'profiles/web/cordis.patch.yml'), 'utf8');
    expect(patch).toMatch(/native-provider|native-model/);
    expect(patch).toContain('private-plugin-setting');
  });
  it('preserves native plugin declarations and skills while excluding installed dependencies and credentials', async () => {
    const { root, packs, operations, source, instances } = await fixture();
    await packs.handle({ type: 'pack.create', instanceId: source.id, name: 'Development', version: '1.0' }); await operations.settle();
    expect(operations.list()[0]?.status).toBe('succeeded');
    const pack = packs.list()[0]!; expect(pack.runtimeVersion).toBe('0.2.0-rc.2');
    const inventory = await inventoryTree(path.join(root, 'packs', pack.id, 'data'));
    expect(inventory.files.map(file => file.path)).not.toContain('home/profiles/web/node_modules/example-plugin/index.js');
    expect(inventory.files.some(file => /credentials|sessions|\.env/.test(file.path))).toBe(false);
    const archive = path.join(root, 'development.dshpack'); await packs.handle({ type: 'pack.export', packId: pack.id }, archive); await operations.settle();
    await packs.handle({ type: 'pack.import' }, archive); await operations.settle(); expect(packs.list()).toHaveLength(2);
    await packs.handle({ type: 'pack.install', packId: packs.list()[0]!.id, name: 'Isolated copy' }); await operations.settle();
    expect(operations.list()[0]?.status).toBe('succeeded');
    const installed = instances.list().find(instance => instance.name === 'Isolated copy')!;
    expect(installed.homePath).not.toBe(source.homePath);
    expect(await readFile(path.join(installed.homePath, 'skills/example/SKILL.md'), 'utf8')).toBe('# Example skill\n');
    expect(await readdir(installed.workspacePath)).toEqual([]);
    expect(await readdir(installed.homePath)).not.toContain('.credentials.yaml');
  });
  it('excludes the launcher-owned local bridge while preserving native third-party dependency locks', async () => {
    const f = await fixture();
    const original = JSON.stringify({ dependencies: { '@worldlinebox/dsh-bridge': 'file:C:/private/home/.worldlinebox/bridge/hash', 'dsh-example': '1.2.3' },
      dsh: { profile: { bundles: ['@worldlinebox/dsh-bridge', 'dsh-example'] } } });
    await put(f.source.homePath, 'profiles/web/package.json', original);
    await put(f.source.homePath, 'profiles/web/pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@worldlinebox/dsh-bridge':\n        specifier: file:C:/private/home/.worldlinebox/bridge/hash\n        version: file:../../.worldlinebox/bridge/hash\n      dsh-example:\n        specifier: 1.2.3\n        version: 1.2.3\npackages:\n  '@worldlinebox/dsh-bridge@file:../../.worldlinebox/bridge/hash': {}\n  dsh-example@1.2.3: {}\nsnapshots:\n  '@worldlinebox/dsh-bridge@file:../../.worldlinebox/bridge/hash': {}\n");
    await f.packs.handle({ type: 'pack.create', instanceId: f.source.id, name: 'Native pack', version: '1' }); await f.operations.settle();
    expect(f.operations.list()[0]?.status, f.operations.list()[0]?.error).toBe('succeeded');
    const profile = path.join(f.root, 'packs', f.packs.list()[0]!.id, 'data/home/profiles/web');
    expect(await readFile(path.join(profile, 'package.json'), 'utf8')).not.toContain('worldlinebox');
    const lock = await readFile(path.join(profile, 'pnpm-lock.yaml'), 'utf8');
    expect(lock).toContain('dsh-example@1.2.3'); expect(lock).not.toContain('worldlinebox'); expect(lock).not.toContain('C:/private');
    expect(await readFile(path.join(f.source.homePath, 'profiles/web/package.json'), 'utf8')).toBe(original);
  });
  it('requires the exact runtime content and retains the existing pack when importing fails', async () => {
    const { root, packs, operations, source, dropRuntime } = await fixture();
    await packs.handle({ type: 'pack.create', instanceId: source.id, name: 'Pinned', version: '1' }); await operations.settle();
    const archive = path.join(root, 'pinned.dshpack'); await packs.handle({ type: 'pack.export', packId: packs.list()[0]!.id }, archive); await operations.settle();
    dropRuntime(); await packs.handle({ type: 'pack.import' }, archive); await operations.settle();
    expect(operations.list()[0]?.status).toBe('failed'); expect(operations.list()[0]?.error).toContain('exact DSH runtime'); expect(packs.list()).toHaveLength(1);
    expect((await readdir(path.join(root, 'packs'))).some(name => name.startsWith('.staging-'))).toBe(false);
  });
  it('recovers a verified committed pack after a crash before registry persistence', async () => {
    const { root, packs, operations, source, runtimes, instances } = await fixture();
    await packs.handle({ type: 'pack.create', instanceId: source.id, name: 'Recoverable', version: '1' }); await operations.settle();
    const expected = packs.list();
    await rm(path.join(root, 'packs.json'));
    const recovered = new PackService({ rootPath: root, runtimes, instances, operations, onChanged: () => undefined });
    await recovered.init(); expect(recovered.list()).toEqual(expected);
  });
  it('rejects portable packs that attempt to restore private session data', async () => {
    const { root, packs, operations, source } = await fixture();
    await packs.handle({ type: 'pack.create', instanceId: source.id, name: 'Valid', version: '1' }); await operations.settle();
    const manifest = JSON.parse(await readFile(path.join(root, 'packs', packs.list()[0]!.id, 'manifest.json'), 'utf8'));
    const data = path.join(root, 'malicious'); await put(data, 'home/sessions/private.jsonl', '{}');
    const archive = path.join(root, 'private.zip'); await writeSealedArchive(data, archive, manifest);
    await packs.handle({ type: 'pack.import' }, archive); await operations.settle();
    expect(operations.list()[0]?.status).toBe('failed'); expect(operations.list()[0]?.error).toContain('private instance data'); expect(packs.list()).toHaveLength(1);
  });
  it('rejects external configuration paths, explicit credentials and links leaving the profile', async () => {
    expect(() => auditPortableConfiguration('path: C:\\shared\\sessions', 'patch.yml')).toThrow('absolute filesystem');
    expect(() => auditPortableConfiguration('apiKey: "private-secret"', 'patch.yml')).toThrow('credential value');
    expect(() => auditPortableConfiguration('agentsHome: /home/shared/agents', 'patch.yml')).toThrow('external filesystem');
    expect(() => auditPortableConfiguration('apiKey: !!js process.env.DSH_API_KEY', 'patch.yml')).not.toThrow();
    const { packs, source, operations } = await fixture();
    await symlink(source.workspacePath, path.join(source.homePath, 'profiles/web/external'), process.platform === 'win32' ? 'junction' : 'dir');
    await packs.handle({ type: 'pack.create', instanceId: source.id, name: 'Unsafe', version: '1' }); await operations.settle();
    expect(operations.list()[0]?.status).toBe('failed'); expect(operations.list()[0]?.error).toContain('outside managed data'); expect(packs.list()).toHaveLength(0);
  });
});
