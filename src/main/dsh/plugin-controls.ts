import path from 'node:path';
import type { DshInstance } from '../../shared/dsh-launcher';
import { dshInstalledPluginSchema, dshPluginPackageNameSchema, type DshInstalledPlugin } from '../../shared/dsh-plugins';
import { lstat, readFile, realpath } from './disk';
import { atomicJson, safeRelative } from './files';
import { readRuntimeSdkFile } from './runtime-sdk';

const CORE = new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless']);
type Mapping = Record<string, unknown>;
function mapping(value: unknown): Mapping | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Mapping : undefined; }
function packageSource(metadata: Mapping): string | undefined {
  const repository = typeof metadata.repository === 'string' ? metadata.repository : mapping(metadata.repository)?.url;
  if (typeof repository !== 'string') return undefined;
  try { const url = new URL(repository.replace(/^git\+/, '').replace(/\.git$/, ''));
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) return undefined;
    return url.href;
  } catch { return undefined; }
}
/** Bundle activation is the official private profile manifest's ordered list, rather than an invented CLI switch. */
export class PluginControls {
  constructor(private readonly options: { rootPath: string; runtimeDirectory: (runtimeId: string) => string }) {}
  private async locations(instance: DshInstance): Promise<{ root: string; program: string; profile: string; file: string }> {
    if (!/^[a-z0-9-]{1,80}$/.test(instance.id)) throw new Error('Invalid private instance identity.');
    const expected = path.join(this.options.rootPath, 'instances', instance.id);
    if (path.resolve(instance.homePath).toLowerCase() !== path.resolve(expected, 'home').toLowerCase()) throw new Error('Plugin controls require the selected instance’s private profile.');
    const manager = await realpath(this.options.rootPath); const root = await realpath(expected); const program = await realpath(this.options.runtimeDirectory(instance.runtimeId));
    for (const target of [root, program]) {
      const relative = path.relative(manager, target); if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Plugin controls cannot follow storage outside the launcher data directory.');
    }
    for (const directory of [path.join(manager, 'instances'), expected, path.join(root, 'home'), path.join(root, 'home', 'profiles'), path.join(root, 'home', 'profiles', 'web')]) {
      const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error('The private profile cannot be linked or replaced by a file.');
    }
    const profile = path.join(root, 'home', 'profiles', 'web'); const file = path.join(profile, 'package.json');
    return { root, program, profile, file };
  }
  private async readOwned(file: string, roots: readonly string[]): Promise<Buffer | undefined> {
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) return undefined;
    if (info.isSymbolicLink() || !info.isFile() || info.size > 4 * 1024 ** 2) throw new Error('Invalid private plugin metadata resource.');
    const actual = await realpath(file);
    if (!roots.some(root => { const relative = path.relative(root, actual); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); })) throw new Error('A plugin metadata path resolves outside the selected instance and pinned runtime.');
    return readFile(actual);
  }
  private async profile(instance: DshInstance): Promise<{ locations: Awaited<ReturnType<PluginControls['locations']>>; manifest: Mapping; dependencies: Mapping; bundles: string[] }> {
    const locations = await this.locations(instance); const bytes = await this.readOwned(locations.file, [locations.root]);
    const manifest = bytes ? mapping(JSON.parse(bytes.toString('utf8'))) : { private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } };
    const dependencies = mapping(manifest?.dependencies) ?? {};
    const bundleValue = mapping(mapping(manifest?.dsh)?.profile)?.bundles;
    if (!manifest || !Array.isArray(bundleValue) || bundleValue.length > 1000 || Object.keys(dependencies).length > 1000
      || bundleValue.some(name => !dshPluginPackageNameSchema.safeParse(name).success) || Object.entries(dependencies).some(([name, value]) => !dshPluginPackageNameSchema.safeParse(name).success || typeof value !== 'string' || value.length > 2048)) throw new Error('The private profile has unsupported plugin metadata.');
    return { locations, manifest, dependencies, bundles: bundleValue as string[] };
  }
  private async metadata(name: string, locations: Awaited<ReturnType<PluginControls['locations']>>): Promise<Mapping | undefined> {
    const local = await this.readOwned(path.join(locations.profile, 'node_modules', name, 'package.json'), [locations.root, locations.program]);
    try {
      const bytes = local ?? await readRuntimeSdkFile(locations.program, `${name}/package.json`);
      return mapping(JSON.parse(bytes.toString('utf8')));
    } catch { return undefined; }
  }
  async listPlugins(instance: DshInstance): Promise<DshInstalledPlugin[]> {
    const data = await this.profile(instance); const names = [...new Set([...Object.keys(data.dependencies), ...data.bundles])]; const results: DshInstalledPlugin[] = [];
    for (const name of names) {
      const metadata = await this.metadata(name, data.locations); const patch = mapping(mapping(metadata?.dsh)?.bundle)?.patch;
      const bundle = typeof patch === 'string' || Array.isArray(patch) && patch.every(value => typeof value === 'string');
      results.push(dshInstalledPluginSchema.parse({ name, spec: data.dependencies[name] ?? 'runtime-bundle',
        version: typeof metadata?.version === 'string' ? metadata.version.slice(0, 128) : undefined,
        description: typeof metadata?.description === 'string' ? metadata.description.slice(0, 4000) : '',
        enabled: data.bundles.includes(name), bundle: bundle || data.bundles.includes(name), core: CORE.has(name), sourceUrl: metadata ? packageSource(metadata) : undefined,
        ...(!metadata ? { error: 'Installed package metadata is unavailable. Remove or repair this dependency.' } : {}) }));
    }
    return results.sort((a, b) => Number(b.core) - Number(a.core) || a.name.localeCompare(b.name));
  }
  async setPluginEnabled(instance: DshInstance, nameValue: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
    if (['running', 'starting', 'stopping'].includes(instance.status)) throw new Error('Stop this DSH instance before changing plugin activation.');
    const name = dshPluginPackageNameSchema.parse(nameValue); if (CORE.has(name)) throw new Error('The required official DSH bundles cannot be disabled.');
    signal?.throwIfAborted(); const data = await this.profile(instance);
    if (!Object.hasOwn(data.dependencies, name)) throw new Error('This plugin is not installed in the selected private profile.');
    if (data.bundles.includes(name) === enabled) return;
    if (enabled) {
      const metadata = await this.metadata(name, data.locations); const patchValue = mapping(mapping(metadata?.dsh)?.bundle)?.patch;
      const files = typeof patchValue === 'string' ? [patchValue] : patchValue;
      if (!Array.isArray(files) || !files.length || files.length > 100 || files.some(value => typeof value !== 'string')) throw new Error('This installed package does not declare a DSH bundle.');
      for (const value of files as string[]) {
        const relative = safeRelative(value.replace(/^\.\//, ''));
        const local = await this.readOwned(path.join(data.locations.profile, 'node_modules', name, relative), [data.locations.root, data.locations.program]);
        if (!local) await readRuntimeSdkFile(data.locations.program, `${name}/${relative}`);
      }
    }
    const dsh = mapping(data.manifest.dsh)!; const profile = mapping(dsh.profile)!;
    data.manifest.dsh = { ...dsh, profile: { ...profile, bundles: enabled ? [...data.bundles, name] : data.bundles.filter(value => value !== name) } };
    signal?.throwIfAborted(); await atomicJson(data.locations.file, data.manifest);
  }
}
