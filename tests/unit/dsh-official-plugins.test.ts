import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DshRuntime } from '../../src/shared/dsh-launcher';
import { inventoryTree, removeManaged } from '../../src/main/dsh/files';
import { InstanceService, type RuntimeServiceLike } from '../../src/main/dsh/instance-service';
import { instanceEnvironment } from '../../src/main/dsh/instance-process';
import { OperationStore } from '../../src/main/dsh/operations';
import { PackService } from '../../src/main/dsh/packs';

const roots: string[] = [];
const services: InstanceService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root);
});

describe.skipIf(process.platform !== 'win32' || process.env.WORLDLINEBOX_DSH_REAL_PLUGINS !== '1' || !process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY)('official isolated native plugin management', () => {
  it('adds and removes a pinned package through the bundled DSH CLI and pnpm without changing another instance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-dsh-official-plugins-')); roots.push(root);
    const program = path.resolve(process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY!);
    const runtime: DshRuntime = {
      id: 'official-cli-test', version: '0.2.0-rc.2', platform: 'win32-x64', adapter: 'desktop-cli-web-v1',
      nodeVersion: '24.18.1', electronVersion: '44.0.0', source: program, sourceSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64),
      installedAt: new Date().toISOString(), fileCount: 1, byteLength: 1,
    };
    const plan = { executable: path.join(program, 'DeepSeek Harness.exe'),
      cli: path.join(program, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), env: { ELECTRON_RUN_AS_NODE: '1' } };
    const runtimes: RuntimeServiceLike = { list: () => [runtime], get: () => runtime, directory: () => program, plan: () => plan, verify: async () => undefined };
    const operationRoot = path.join(root, 'operations'); await mkdir(operationRoot);
    const operations = new OperationStore(operationRoot, () => undefined); await operations.init();
    const service = new InstanceService({ rootPath: root, runtimes, operations, onChanged: () => undefined,
      openWorkbench: async () => undefined, closeWorkbench: async () => undefined, clearBrowserData: async () => undefined });
    services.push(service); await service.init();
    const first = await service.create('Plugin installer', runtime.id);
    const other = await service.create('Unchanged neighbour', runtime.id);
    const untouched = await inventoryTree(service.getRoot(other.id));
    const core = await inventoryTree(program);
    const environment = await instanceEnvironment(service.getRoot(first.id), first, plan);
    expect(environment.DSH_HOME).toBe(first.homePath);
    expect(environment.DSH_AGENTS_HOME).toBe(first.agentsPath);
    expect(environment.npm_config_store_dir).toBe(path.join(service.getRoot(first.id), 'cache/pnpm-store'));
    expect(environment.pnpm_config_store_dir).toBe(environment.npm_config_store_dir);
    expect(environment.DSH_DESKTOP_NODE_EXECUTABLE).toBe(plan.executable);
    expect(plan.executable).not.toContain('AppData\\Local\\Programs');

    let packageName = '@deepseek-ai/dsh-skill-filesystem'; let version = '0.2.0-rc.2';
    const add = async () => {
      const response = await service.handle({ type: 'instance.plugin', instanceId: first.id, action: 'add', spec: `${packageName}@${version}` });
      expect(response.ok).toBe(true); await operations.settle();
      return operations.list()[0]!;
    };
    let result = await add();
    if (result.status === 'failed' && /ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_FETCH_404|No matching version/i.test(result.error ?? '')) {
      console.info('The pinned official plugin is unavailable on npm; validating the same native package pipeline with is-number@7.0.0.');
      packageName = 'is-number'; version = '7.0.0'; result = await add();
    }
    expect(result.status, result.error).toBe('succeeded');
    const profile = path.join(first.homePath, 'profiles/web');
    const manifest = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies?.[packageName]).toBe(version);
    expect(await readFile(path.join(profile, 'pnpm-lock.yaml'), 'utf8')).toContain(packageName);
    expect(await readdir(path.join(profile, 'node_modules'))).not.toHaveLength(0);
    expect(await readdir(environment.npm_config_store_dir!)).not.toHaveLength(0);
    const moduleMetadata = JSON.parse(await readFile(path.join(profile, 'node_modules/.modules.yaml'), 'utf8')) as { storeDir: string };
    const storeRelative = path.relative(environment.pnpm_config_store_dir!, moduleMetadata.storeDir);
    expect(path.isAbsolute(storeRelative) || storeRelative.startsWith('..')).toBe(false);
    expect((await inventoryTree(service.getRoot(other.id))).contentSha256).toBe(untouched.contentSha256);
    console.info(`Installed ${packageName}@${version} into an isolated profile; manifest, lockfile and private pnpm store verified.`);

    const sourceBeforePack = await inventoryTree(first.homePath);
    const packs = new PackService({ rootPath: root, runtimes, instances: service, operations, onChanged: () => undefined }); await packs.init();
    await packs.handle({ type: 'pack.create', instanceId: first.id, name: 'Native plugin pack', version: '1' }); await operations.settle();
    expect(operations.list()[0]?.status, operations.list()[0]?.error).toBe('succeeded');
    const pack = packs.list()[0]!;
    const portableMetadata = await readFile(path.join(root, 'packs', pack.id, 'data/home/profiles/web/node_modules/.modules.yaml'), 'utf8');
    expect(portableMetadata).not.toContain(first.id);
    await packs.handle({ type: 'pack.install', packId: pack.id, name: 'Installed native pack' }); await operations.settle();
    expect(operations.list()[0]?.status, operations.list()[0]?.error).toBe('succeeded');
    const copy = service.list().find(instance => instance.name === 'Installed native pack')!;
    for (const action of ['add', 'remove'] as const) {
      await service.handle({ type: 'instance.plugin', instanceId: copy.id, action, spec: action === 'add' ? 'is-number@7.0.0' : 'is-number' }); await operations.settle();
      expect(operations.list()[0]?.status, operations.list()[0]?.error).toBe('succeeded');
    }
    expect((await inventoryTree(first.homePath)).contentSha256).toBe(sourceBeforePack.contentSha256);
    const copyModules = JSON.parse(await readFile(path.join(copy.homePath, 'profiles/web/node_modules/.modules.yaml'), 'utf8')) as { storeDir: string };
    expect(path.relative(path.join(service.getRoot(copy.id), 'cache/pnpm-store'), copyModules.storeDir).startsWith('..')).toBe(false);
    console.info('Installed the offline pack into a third instance, then added/removed a dependency there without changing the source profile.');

    const removed = await service.handle({ type: 'instance.plugin', instanceId: first.id, action: 'remove', spec: packageName });
    expect(removed.ok).toBe(true); await operations.settle();
    expect(operations.list()[0]?.status, operations.list()[0]?.error).toBe('succeeded');
    const after = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    expect(after.dependencies?.[packageName]).toBeUndefined();
    expect((await inventoryTree(service.getRoot(other.id))).contentSha256).toBe(untouched.contentSha256);
    expect((await inventoryTree(program)).contentSha256).toBe(core.contentSha256);
    console.info(`Removed ${packageName}; the neighbour instance and official runtime remained byte-for-byte unchanged.`);
  }, 180_000);
});
