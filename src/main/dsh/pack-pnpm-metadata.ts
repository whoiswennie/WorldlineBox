import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { lstat, readFile, readdir, writeFile } from './disk';

const STORE = '__WORLDLINEBOX_DSH_PNPM_STORE__';
const VIRTUAL = '__WORLDLINEBOX_DSH_NODE_MODULES__';
type Metadata = Record<string, unknown> & { storeDir: string; virtualStoreDir: string };

async function readMetadata(file: string): Promise<Metadata> {
  if ((await lstat(file)).size > 4 * 1024 ** 2) throw new Error('pnpm layout metadata is too large.');
  const value: unknown = parseYaml(await readFile(file, 'utf8'), { maxAliasCount: 32, uniqueKeys: true });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid pnpm layout metadata.');
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.storeDir !== 'string' || typeof metadata.virtualStoreDir !== 'string') throw new Error('pnpm layout metadata is missing its store paths.');
  return metadata as Metadata;
}
async function metadataFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Linked pnpm metadata is not portable.');
      if (entry.isDirectory()) await visit(target);
      else if (entry.name === '.modules.yaml' && path.basename(directory) === 'node_modules') result.push(target);
    }
  };
  await visit(path.join(root, 'home', 'profiles'));
  return result;
}

/** Preserve pnpm's layout and version fields while removing source-instance paths. */
export async function sealPackPnpmMetadata(dataRoot: string): Promise<void> {
  for (const file of await metadataFiles(dataRoot)) {
    const metadata = await readMetadata(file);
    const suffix = /(?:^|[\\/])(v[0-9]+)[\\/]?$/.exec(metadata.storeDir)?.[1];
    if (!suffix) throw new Error('This pnpm store layout cannot be exported portably.');
    const virtual = metadata.virtualStoreDir.replaceAll('\\', '/');
    if (virtual !== '.pnpm' && !virtual.endsWith('/node_modules/.pnpm')) throw new Error('A custom external virtual pnpm store cannot be exported portably.');
    metadata.storeDir = `${STORE}/${suffix}`;
    metadata.virtualStoreDir = `${VIRTUAL}/.pnpm`;
    await writeFile(file, JSON.stringify(metadata, null, 2));
  }
}

export async function validatePackPnpmMetadata(dataRoot: string): Promise<void> {
  for (const file of await metadataFiles(dataRoot)) {
    const metadata = await readMetadata(file);
    if (!new RegExp(`^${STORE}/v[0-9]+$`).test(metadata.storeDir) || metadata.virtualStoreDir !== `${VIRTUAL}/.pnpm`) throw new Error('A pack contains source-instance pnpm store paths. Re-export it with portable layout metadata.');
  }
}

/** Installed profiles share only their new instance's private content store. */
export async function installPackPnpmMetadata(instanceRoot: string): Promise<void> {
  for (const file of await metadataFiles(instanceRoot)) {
    const metadata = await readMetadata(file);
    const suffix = new RegExp(`^${STORE}/(v[0-9]+)$`).exec(metadata.storeDir)?.[1];
    if (!suffix || metadata.virtualStoreDir !== `${VIRTUAL}/.pnpm`) throw new Error('Invalid portable pnpm store metadata.');
    metadata.storeDir = path.join(instanceRoot, 'cache', 'pnpm-store', suffix);
    metadata.virtualStoreDir = path.join(path.dirname(file), '.pnpm');
    await writeFile(file, JSON.stringify(metadata, null, 2));
  }
}

/** Clones and backups keep the layout but never retain the source instance's mutable stores. */
export async function rebaseInstancePnpmMetadata(instanceRoot: string, oldRoot: string): Promise<void> {
  const inside = (value: string) => { const relative = path.relative(oldRoot, value); return !relative.startsWith('..') && !path.isAbsolute(relative); };
  for (const file of await metadataFiles(instanceRoot)) {
    const metadata = await readMetadata(file);
    const suffix = /(?:^|[\\/])(v[0-9]+)[\\/]?$/.exec(metadata.storeDir)?.[1];
    if (!suffix || !path.isAbsolute(metadata.storeDir) || !inside(metadata.storeDir)) throw new Error('A copied profile uses a pnpm store outside its source instance.');
    const oldModules = path.join(oldRoot, path.relative(instanceRoot, path.dirname(file)));
    if (metadata.virtualStoreDir !== '.pnpm' && path.resolve(metadata.virtualStoreDir).toLowerCase() !== path.join(oldModules, '.pnpm').toLowerCase()) throw new Error('A copied profile uses a shared virtual pnpm store.');
    metadata.storeDir = path.join(instanceRoot, 'cache', 'pnpm-store', suffix);
    metadata.virtualStoreDir = path.join(path.dirname(file), '.pnpm');
    await writeFile(file, JSON.stringify(metadata, null, 2));
  }
}
