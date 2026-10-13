import path from 'node:path';
import { parseDocument } from 'yaml';
import { lstat, readFile, realpath } from './disk';
import { safeRelative } from './files';
import { readRuntimeSdkFile, runtimeSdkRoot } from './runtime-sdk';

type Row = Record<string, unknown>;
export interface PrivateSkillRoutingPatch extends Record<string, unknown> { id: string; name?: string; config: Record<string, unknown> }
const npmName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const SKILL_PACKAGE = '@deepseek-ai/dsh-skill-filesystem';
const PRESET_PACKAGE = '@deepseek-ai/dsh-agent-preset';
function mapping(value: unknown): Row | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined; }
/** Preserve the SDK's inert expression representation; this parser never evaluates !!js. */
function parsePatches(source: string): Row[] {
  const document = parseDocument(source, { uniqueKeys: true, customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }] });
  if (document.errors.length) throw new Error('The skill adapter could not parse the private Cordis composition.');
  const result: unknown = document.toJS({ maxAliasCount: 0 });
  if (!Array.isArray(result) || result.length > 20_000 || result.some(value => !mapping(value))) throw new Error('The skill adapter requires an ordinary Cordis patch list.');
  return result as Row[];
}
/** Follow the inspected native loader's replacement semantics while retaining every unaffected row. */
export function composeSkillRoutingEntries(layers: readonly Row[][]): Row[] {
  const result: Row[] = [];
  const find = (rows: Row[], id: string): Row | undefined => {
    let selected: Row | undefined;
    for (const row of rows) { if (row.id === id) selected = row;
      if (row.group === true && Array.isArray(row.config)) { const match = find(row.config as Row[], id); if (match) selected = match; } }
    return selected;
  };
  for (const layer of layers) for (const source of layer) {
    const patch = structuredClone(source); const id = typeof patch.id === 'string' ? patch.id : undefined;
    if (Array.isArray(patch.insert)) {
      if (patch.insert.some(row => !mapping(row))) throw new Error('The composition contains an invalid inserted entry.');
      if (!id) result.push(...patch.insert as Row[]);
      else { const target = find(result, id); if (target?.group === true) { if (!Array.isArray(target.config)) target.config = []; (target.config as Row[]).push(...patch.insert as Row[]); } }
      continue;
    }
    if (!id) continue; const target = find(result, id); if (!target || (patch.name !== undefined && patch.name !== target.name)) continue;
    for (const [key, value] of Object.entries(patch)) if (key !== 'id' && key !== 'name') target[key] = value;
  }
  return result;
}
export function privateSkillPatchesFromEntries(entries: readonly Row[], directories: readonly string[], bundledRoot?: string): PrivateSkillRoutingPatch[] {
  const patches: PrivateSkillRoutingPatch[] = [];
  const replaceProvider = (row: Row): boolean => {
    let changed = false;
    if (row.name === SKILL_PACKAGE) {
      const previous = mapping(row.config) ?? {}; const priorCustom = Array.isArray(previous.customSkillDirs) ? previous.customSkillDirs : [];
      const custom = [...directories, ...priorCustom.filter(value => typeof value === 'string' || !!mapping(value)?.__jsExpr)];
      row.config = { ...previous, includeDefaultRoots: false, customSkillDirs: [...new Map(custom.map(value => [JSON.stringify(value), value])).values()], watchFollowSymlinks: false,
        ...(previous.bundledSkillDir !== undefined ? {} : bundledRoot ? { bundledSkillDir: bundledRoot } : {}) };
      changed = true;
    }
    if (row.group === true && Array.isArray(row.config)) for (const child of row.config) if (mapping(child)) changed = replaceProvider(child) || changed;
    return changed;
  };
  const visit = (rows: readonly Row[]) => {
    for (const source of rows) {
      if (source.name === SKILL_PACKAGE && typeof source.id === 'string') { const row = structuredClone(source); replaceProvider(row);
        patches.push({ id: source.id, name: SKILL_PACKAGE, config: mapping(row.config)! }); }
      if (source.name === PRESET_PACKAGE && typeof source.id === 'string') {
        const row = structuredClone(source); const config = mapping(row.config);
        if (config && Array.isArray(config.plugins)) {
          let changed = false; for (const child of config.plugins) if (mapping(child)) changed = replaceProvider(child) || changed;
          if (changed) patches.push({ id: source.id, name: PRESET_PACKAGE, config });
        }
      }
      if (source.group === true && Array.isArray(source.config)) visit(source.config as Row[]);
    }
  };
  visit(entries);
  if (!patches.length) throw new Error('This DSH composition has no verified filesystem skill provider.');
  return patches;
}
async function privateFile(file: string, allowedRoots: string[]): Promise<Buffer | undefined> {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 ** 2) throw new Error('Invalid private skill composition resource.');
  const actual = await realpath(file);
  if (!allowedRoots.some(root => { const relative = path.relative(root, actual); return !relative.startsWith('..') && !path.isAbsolute(relative); })) throw new Error('A skill composition resource resolves outside the private instance and pinned runtime.');
  return readFile(actual);
}
export async function buildPrivateSkillRouting(instanceRoot: string, programDirectory: string, runtimeVersion: string, signal?: AbortSignal): Promise<PrivateSkillRoutingPatch[]> {
  signal?.throwIfAborted(); const root = await realpath(instanceRoot); const program = await realpath(programDirectory);
  const manifest = JSON.parse((await readRuntimeSdkFile(program, `${SKILL_PACKAGE}/package.json`)).toString('utf8')) as { version?: string };
  const implementation = (await readRuntimeSdkFile(program, `${SKILL_PACKAGE}/lib/index.js`)).toString('utf8');
  if (manifest.version !== runtimeVersion || !implementation.includes('includeDefaultRoots') || !implementation.includes('customSkillDirs') || !implementation.includes('watchFollowSymlinks')) throw new Error('This DSH runtime has no verified private skill routing adapter.');
  const profileRoot = path.join(root, 'home', 'profiles', 'web'); const profileBytes = await privateFile(path.join(profileRoot, 'package.json'), [root, program]);
  const profile = profileBytes ? JSON.parse(profileBytes.toString('utf8')) as { dsh?: { profile?: { bundles?: unknown } } } : undefined;
  const bundles = profile?.dsh?.profile?.bundles ?? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
  if (!Array.isArray(bundles) || bundles.length > 1000 || bundles.some(bundle => typeof bundle !== 'string' || !npmName.test(bundle))) throw new Error('The private profile has an unsupported bundle list.');
  const layers: Row[][] = [];
  for (const bundle of bundles as string[]) {
    signal?.throwIfAborted(); const localRoot = path.join(profileRoot, 'node_modules', bundle);
    const localManifest = await privateFile(path.join(localRoot, 'package.json'), [root, program]);
    const metadata = JSON.parse((localManifest ?? await readRuntimeSdkFile(program, `${bundle}/package.json`)).toString('utf8')) as { dsh?: { bundle?: { patch?: unknown } } };
    const patchValue = metadata.dsh?.bundle?.patch; const files = typeof patchValue === 'string' ? [patchValue] : patchValue;
    if (!Array.isArray(files) || files.length > 100 || files.some(file => typeof file !== 'string')) throw new Error('A private profile bundle has an unsupported patch declaration.');
    for (const value of files as string[]) {
      const relative = safeRelative(value.replace(/^\.\//, ''));
      const contents = localManifest ? await privateFile(path.join(localRoot, relative), [root, program]) : await readRuntimeSdkFile(program, `${bundle}/${relative}`);
      if (!contents) throw new Error('A private profile bundle patch is missing.'); layers.push(parsePatches(contents.toString('utf8')));
    }
  }
  for (const file of [path.join(profileRoot, 'cordis.patch.yml'), path.join(root, 'home', 'cordis.patch.yml')]) {
    const bytes = await privateFile(file, [root, program]); if (bytes) layers.push(parsePatches(bytes.toString('utf8')));
  }
  let bundledRoot: string | undefined;
  try { const preset = JSON.parse((await readRuntimeSdkFile(program, `${PRESET_PACKAGE}/package.json`)).toString('utf8')) as { version?: string; files?: unknown };
    if (preset.version === runtimeVersion && Array.isArray(preset.files) && preset.files.includes('skills')) {
      await readRuntimeSdkFile(program, `${PRESET_PACKAGE}/skills/cordis-plugin-development/SKILL.md`);
      bundledRoot = path.join(await runtimeSdkRoot(program), PRESET_PACKAGE, 'skills');
    }
  } catch { /* An older SDK without published builtin skills does not gain guessed paths. */ }
  return privateSkillPatchesFromEntries(composeSkillRoutingEntries(layers), [path.join(root, 'home', 'skills'), path.join(root, 'agents', 'skills')], bundledRoot);
}
