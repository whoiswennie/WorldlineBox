import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { InstanceService, type RuntimeServiceLike } from '../../src/main/dsh/instance-service';
import { PackService } from '../../src/main/dsh/packs';
import { OperationStore } from '../../src/main/dsh/operations';
import { inventoryTree } from '../../src/main/dsh/files';
import type { DshInstance, DshLauncherResponse, DshRuntime } from '../../src/shared/dsh-launcher';

/** Two genuinely different fixture programs model releases; they do not claim upstream schema compatibility. */
function fixtureProgram(version: string): string {
  return `
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const version = ${JSON.stringify(version)}, home = process.env.DSH_HOME;
const profile = path.join(home,'profiles','web');
const pluginFile = path.join(profile,'node_modules','@matrix','plugin','index.json');
if(process.argv.includes('plugin')) {
  const spec = process.argv[process.argv.indexOf('add')+1];
  const plugin = JSON.parse(fs.readFileSync(pluginFile,'utf8'));
  plugin.version = spec.slice(spec.lastIndexOf('@')+1); plugin.edited = true;
  fs.writeFileSync(pluginFile,JSON.stringify(plugin));
  const manifestFile = path.join(profile,'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  manifest.dependencies['@matrix/plugin'] = plugin.version;
  fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  console.log('fixture: installed exact plugin '+spec);
} else {
  const plugin = JSON.parse(fs.readFileSync(pluginFile,'utf8'));
  if(plugin.runtimeVersion !== version) { console.error('plugin compatibility check failed'); process.exit(2); }
  const state = {
    runtimeVersion:version, plugin,
    patch:fs.readFileSync(path.join(home,'cordis.patch.yml'),'utf8'),
    homeSkill:fs.readFileSync(path.join(home,'skills','matrix','SKILL.md'),'utf8'),
    agentsSkill:fs.readFileSync(path.join(process.env.DSH_AGENTS_HOME,'skills','matrix','SKILL.md'),'utf8'),
    home,agents:process.env.DSH_AGENTS_HOME,workspace:process.cwd(),user:process.env.USERPROFILE
  };
  fs.mkdirSync(path.join(home,'storages'),{recursive:true});
  fs.writeFileSync(path.join(home,'storages','matrix.json'),JSON.stringify(state));
  const token='fixture-'+version;
  const server=http.createServer((request,response)=>{
    if(request.url==='/?'+token) { response.writeHead(303,{Location:'./','Set-Cookie':'matrix=fixture; HttpOnly'}); response.end(); }
    else if(request.url==='/state') { response.setHeader('Content-Type','application/json'); response.end(JSON.stringify(state)); }
    else { response.writeHead(401); response.end(); }
  });
  server.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+server.address().port+'/?'+token));
}
`;
}

describe('DSH runtime and pack coexistence matrix', () => {
  it('runs two distinct packs on each of two pinned runtimes concurrently, preserving every original and isolating plugin edits and process stops', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-dsh-coexistence-'));
    let instances: InstanceService | undefined; let operations: OperationStore | undefined;
    try {
      const records: DshRuntime[] = [];
      const programs = new Map<string, string>();
      for (const [id, version] of [['runtime-one', '1.0.0'], ['runtime-two', '2.0.0']] as const) {
        const directory = path.join(root, 'fixture-runtimes', id); await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, 'cli.cjs'), fixtureProgram(version));
        const seal = await inventoryTree(directory); programs.set(id, directory);
        records.push({ id, version, nodeVersion: process.version, electronVersion: 'fixture', platform: 'win32-x64', adapter: 'desktop-cli-web-v1',
          source: 'fixture', sourceSha256: seal.contentSha256, contentSha256: seal.contentSha256,
          installedAt: new Date().toISOString(), fileCount: seal.fileCount, byteLength: seal.byteLength });
      }
      expect(records[0]!.contentSha256).not.toBe(records[1]!.contentSha256);
      const runtimes: RuntimeServiceLike = {
        list: () => records, get: id => { const runtime = records.find(record => record.id === id); if (!runtime) throw new Error('Missing fixture runtime.'); return runtime; },
        directory: id => programs.get(id)!, plan: id => ({ executable: process.execPath, cli: path.join(programs.get(id)!, 'cli.cjs'), env: {} }),
        verify: async id => { const seal = await inventoryTree(programs.get(id)!); if (seal.contentSha256 !== records.find(record => record.id === id)!.contentSha256) throw new Error('Runtime changed.'); },
      };
      const operationDirectory = path.join(root, 'operations'); await mkdir(operationDirectory);
      operations = new OperationStore(operationDirectory, () => undefined); await operations.init();
      const openWorkbench = vi.fn(async () => undefined);
      instances = new InstanceService({ rootPath: root, runtimes, operations, onChanged: () => undefined, openWorkbench,
        closeWorkbench: async () => undefined, clearBrowserData: async () => undefined });
      await instances.init();
      const packs = new PackService({ rootPath: root, runtimes, instances, operations, onChanged: () => undefined }); await packs.init();
      const launcher = instances; const operationStore = operations;
      const finish = async (responses: DshLauncherResponse[]) => {
        for (const response of responses) expect(response.ok).toBe(true);
        await operationStore.settle();
        for (const response of responses) if (response.ok && response.operationId) {
          const operation = operationStore.list().find(record => record.id === response.operationId)!;
          expect(operation.error, JSON.stringify(operation)).toBeUndefined(); expect(operation.status).toBe('succeeded');
        }
      };
      const originals: Array<{ instance: DshInstance; packName: string; pluginVersion: string; runtimeVersion: string }> = [];
      for (const runtime of records) for (const variant of ['A', 'B']) {
        const packName = `${runtime.version}-${variant}`; const instance = await launcher.create(`Source ${packName}`, runtime.id);
        const pluginVersion = variant === 'A' ? '1.1.0' : '2.2.0';
        const pluginDirectory = path.join(instance.homePath, 'profiles', 'web', 'node_modules', '@matrix', 'plugin');
        await mkdir(pluginDirectory, { recursive: true });
        await writeFile(path.join(pluginDirectory, 'index.json'), JSON.stringify({ packName, version: pluginVersion, runtimeVersion: runtime.version }));
        await writeFile(path.join(instance.homePath, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'matrix-profile', private: true, dependencies: { '@matrix/plugin': pluginVersion } }));
        await writeFile(path.join(instance.homePath, 'profiles', 'web', 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\npluginVersion: '${pluginVersion}'\n`);
        await writeFile(path.join(instance.homePath, 'cordis.patch.yml'), `matrix:\n  packName: '${packName}'\n`);
        await mkdir(path.join(instance.homePath, 'skills', 'matrix'), { recursive: true });
        await writeFile(path.join(instance.homePath, 'skills', 'matrix', 'SKILL.md'), `Home skill ${packName}`);
        await mkdir(path.join(instance.agentsPath, 'skills', 'matrix'), { recursive: true });
        await writeFile(path.join(instance.agentsPath, 'skills', 'matrix', 'SKILL.md'), `Agents skill ${packName}`);
        await mkdir(path.join(instance.homePath, 'sessions')); await writeFile(path.join(instance.homePath, 'sessions', 'private.jsonl'), `Private session ${packName}`);
        await writeFile(path.join(instance.workspacePath, 'private.txt'), `Private workspace ${packName}`);
        originals.push({ instance, packName, pluginVersion, runtimeVersion: runtime.version });
      }
      const originalSeals = await Promise.all(originals.map(value => inventoryTree(launcher.getRoot(value.instance.id))));
      await finish(await Promise.all(originals.map(value => packs.handle({ type: 'pack.create', instanceId: value.instance.id, name: value.packName, version: '1.0.0' }))));
      expect(packs.list()).toHaveLength(4);
      for (const original of originals) {
        const pack = packs.list().find(record => record.name === original.packName)!;
        expect(pack.runtimeId).toBe(original.instance.runtimeId); expect(pack.runtimeVersion).toBe(original.runtimeVersion);
      }
      const packSeals = await Promise.all(packs.list().map(pack => inventoryTree(path.join(root, 'packs', pack.id))));
      await finish(await Promise.all(packs.list().map(pack => packs.handle({ type: 'pack.install', packId: pack.id, name: `Installed ${pack.name}` }))));
      const installed = launcher.list().filter(instance => instance.name.startsWith('Installed ')); expect(installed).toHaveLength(4);
      for (const instance of installed) {
        const source = originals.find(original => instance.name === `Installed ${original.packName}`)!;
        expect(instance.runtimeId).toBe(source.instance.runtimeId);
        await expect(readFile(path.join(instance.homePath, 'sessions', 'private.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(path.join(instance.workspacePath, 'private.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await finish(await Promise.all(installed.map(instance => launcher.handle({ type: 'instance.start', instanceId: instance.id }))));
      const running = installed.map(instance => launcher.get(instance.id));
      expect(running.every(instance => instance.status === 'running')).toBe(true);
      expect(new Set(running.map(instance => instance.pid)).size).toBe(4);
      expect(new Set(running.map(instance => instance.port)).size).toBe(4);
      expect(new Set(running.map(instance => instance.browserPartition)).size).toBe(4);
      expect(openWorkbench).toHaveBeenCalledTimes(4);
      for (const instance of running) {
        const source = originals.find(original => instance.name === `Installed ${original.packName}`)!;
        const state = JSON.parse(await readFile(path.join(instance.homePath, 'storages', 'matrix.json'), 'utf8'));
        expect(state.runtimeVersion).toBe(source.runtimeVersion); expect(state.plugin.version).toBe(source.pluginVersion);
        expect(state.plugin.packName).toBe(source.packName); expect(state.patch).toContain(source.packName);
        expect(state.homeSkill).toBe(`Home skill ${source.packName}`); expect(state.agentsSkill).toBe(`Agents skill ${source.packName}`);
        expect(state.home).toBe(instance.homePath); expect(state.agents).toBe(instance.agentsPath); expect(state.workspace).toBe(instance.workspacePath);
      }
      // Stopping and editing one pack leaves the other pack on this runtime and both packs on the other runtime live.
      const edited = running.find(instance => instance.runtimeId === records[0]!.id)!;
      await finish([await launcher.handle({ type: 'instance.stop', instanceId: edited.id })]);
      await finish([await launcher.handle({ type: 'instance.plugin', instanceId: edited.id, action: 'add', spec: '@matrix/plugin@3.0.0' })]);
      await writeFile(path.join(edited.agentsPath, 'skills', 'matrix', 'SKILL.md'), 'Edited private skill');
      for (const instance of running.filter(value => value.id !== edited.id)) {
        expect(launcher.get(instance.id).status).toBe('running');
        const state = await (await fetch(`http://127.0.0.1:${instance.port}/state`)).json() as { plugin: { version: string; edited?: boolean } };
        expect(state.plugin.version).not.toBe('3.0.0'); expect(state.plugin.edited).toBeUndefined();
        expect(await readFile(path.join(instance.agentsPath, 'skills', 'matrix', 'SKILL.md'), 'utf8')).not.toBe('Edited private skill');
        expect(JSON.parse(await readFile(path.join(instance.homePath, 'profiles', 'web', 'node_modules', '@matrix', 'plugin', 'index.json'), 'utf8')).edited).toBeUndefined();
      }
      expect(launcher.get(edited.id).status).toBe('stopped');
      expect(JSON.parse(await readFile(path.join(edited.homePath, 'profiles', 'web', 'node_modules', '@matrix', 'plugin', 'index.json'), 'utf8')).version).toBe('3.0.0');
      for (const [index, original] of originals.entries()) {
        expect(await inventoryTree(launcher.getRoot(original.instance.id))).toEqual(originalSeals[index]);
        expect(launcher.get(original.instance.id).status).toBe('stopped');
      }
      for (const [index, pack] of packs.list().entries()) expect(await inventoryTree(path.join(root, 'packs', pack.id))).toEqual(packSeals[index]);
      await Promise.all(records.map(runtime => runtimes.verify(runtime.id)));
    } finally {
      await operations?.shutdown(); await instances?.shutdown();
      if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('worldlinebox-dsh-coexistence-')) await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
