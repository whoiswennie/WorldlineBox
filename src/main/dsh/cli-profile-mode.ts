import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, writeFile } from './disk';
import { readRuntimeSdkFile, runtimeSdkRoot } from './runtime-sdk';
import { retryFileOperation } from './runtime-commit';
import { SHARED_DATA_RUNTIME_VERSION } from './shared-credentials';
import { supportsSharedDataRuntime } from './validated-runtime';

export const DSH_NATIVE_CLI_DISABLED_IDS = ['web-startup', 'webserver', 'web-runtime', 'connection', 'modules'] as const;

/**
 * Boot the same private web profile and installed plugin tree through the
 * shipped one-shot CLI driver. Only the Web carrier is disabled; no profile,
 * dependency, model configuration or skill tree is copied or changed.
 * Append the technical storage --patch and then the user's task/CLI options.
 */
export async function prepareNativeCliMode(instanceRoot: string, programDirectory: string,
  runtimeVersion: string = SHARED_DATA_RUNTIME_VERSION, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const program = await realpath(programDirectory);
  const headlessPackage = '@deepseek-ai/dsh-headless';
  const manifest = JSON.parse((await readRuntimeSdkFile(program, `${headlessPackage}/package.json`)).toString('utf8')) as { version?: string; dsh?: { bundle?: { patch?: string|string[] } } };
  const declared=(value:unknown):string[]=>{const values=typeof value==='string'?[value]:value;if(!Array.isArray(values)||values.length>32||!values.includes('./cordis.patch.yml')||values.some(item=>typeof item!=='string'||!item.startsWith('./')))throw new Error('This version does not supply an inspected CLI bundle patch declaration.');return values;};
  if (manifest.version !== runtimeVersion) throw new Error('The pinned DSH runtime is missing the inspected native headless bundle.');
  const headlessPatches=declared(manifest.dsh?.bundle?.patch);
  for(const patch of headlessPatches)await readRuntimeSdkFile(program,`${headlessPackage}/${patch.slice(2)}`);
  if(!supportsSharedDataRuntime(runtimeVersion)){
    // Older releases may use private saves, but are admitted only when the
    // shipped metadata still supplies this exact web/headless composition.
    const webManifest=JSON.parse((await readRuntimeSdkFile(program,'@deepseek-ai/dsh-web-app/package.json')).toString('utf8')) as {version?:string;dsh?:{bundle?:{patch?:string|string[]}}};
    if(webManifest.version!==runtimeVersion)throw new Error('This version does not supply the supported private web CLI composition.');
    const webPatch=(await Promise.all(declared(webManifest.dsh?.bundle?.patch).map(async patch=>(await readRuntimeSdkFile(program,`@deepseek-ai/dsh-web-app/${patch.slice(2)}`)).toString('utf8')))).join('\n');
    for(const id of DSH_NATIVE_CLI_DISABLED_IDS)if(!new RegExp(`(?:^|\\n)\\s*-?\\s*id:\\s*['"]?${id}['"]?\\s*(?:\\r?\\n|$)`).test(webPatch))throw new Error('This version does not supply the supported private headless transport rows.');
  }
  const root = await realpath(instanceRoot);
  const directory = path.join(root, 'launcher'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const actual = await realpath(directory); const relative = path.relative(root, actual);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The CLI adapter directory resolves outside its private instance.');
  const modePath = path.join(actual, 'cli-mode.patch.yml'); const temporary = `${modePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(DSH_NATIVE_CLI_DISABLED_IDS.map(id => ({ id, disabled: true })), null, 2)}\n`, { flag: 'wx', mode: 0o600, signal });
  await retryFileOperation(() => rename(temporary, modePath), { signal });
  const sdk=await runtimeSdkRoot(program);
  return ['web',...headlessPatches.flatMap(patch=>['--patch',path.join(sdk,headlessPackage,patch.slice(2))]),'--patch',modePath];
}
