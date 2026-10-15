import path from 'node:path';
import { lstat, mkdir, readFile, rename, writeFile } from './disk';
import { randomUUID } from 'node:crypto';
import { assertOwnedDirectory } from './files';
import { readRuntimeSdkFile } from './runtime-sdk';

const PACKAGE = '@worldlinebox/dsh-auth-completion';
async function directoryInside(root: string, relative: string): Promise<string> {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    await assertOwnedDirectory(root, current);
  }
  return current;
}
async function ownedText(file: string): Promise<string | undefined> {
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('Invalid managed native UI adapter file.');
  return readFile(file, 'utf8');
}
async function update(file: string, value: string): Promise<void> {
  if (await ownedText(file) === value) return;
  const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, value, { mode: 0o600, flag: 'wx' }); await rename(temporary, file);
}
/** A private native Client plugin; sealed upstream files are never changed. */
export async function prepareWorkbenchUiAdapter(instanceRoot: string, programDirectory: string): Promise<string | undefined> {
  const source = await readRuntimeSdkFile(programDirectory, '@deepseek-ai/dsh-client-ui-settings-models/lib/client.js').then(bytes => bytes.toString(), () => '');
  // Inspect the actual capability/bug shape, rather than maintaining a release list.
  if (!source.includes('explicit = false') || !/const finishCredential = \(changed\) => \{\s*if \(!changed\) \{\s*complete\(\);\s*return;\s*\}\s*controller\.load\(\);\s*\}/.test(source)) return;
  const directory = await directoryInside(instanceRoot, `home/profiles/web/node_modules/${PACKAGE}`);
  const manifest = await ownedText(path.join(directory, 'package.json'));
  if (manifest && JSON.parse(manifest).worldlineboxManaged !== 'auth-completion') throw new Error('A private plugin occupies the native UI adapter name; it was preserved.');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: PACKAGE, version: '0.0.0', private: true, worldlineboxManaged: 'auth-completion', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' },
      dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings-models', '@deepseek-ai/dsh-client-ui-settings-account'] } } }),
    'index.js': 'export function apply() {}\n', 'client.js': WORKBENCH_AUTH_CLIENT,
  };
  for (const [name, value] of Object.entries(files)) {
    await update(path.join(directory, name), value);
  }
  const routing = path.join(await directoryInside(instanceRoot, 'launcher'), 'workbench-ui.patch.json');
  await update(routing, JSON.stringify([{ insert: [{ id: 'worldlinebox-auth-completion', name: PACKAGE }] }])); return routing;
}

export const WORKBENCH_AUTH_CLIENT = String.raw`
globalThis.__ModuleLoader__.load({id:'@worldlinebox/dsh-auth-completion',factory(require){
const module={exports:{}};const exports=module.exports;
const React=require('react');
exports.inject=['slots'];
exports.apply=ctx=>{
  let dispose;let installing=false;
  const refresh=()=>{
    if(installing||dispose)return;
    const parent=ctx.slots.entries('settings.onboarding').find(entry=>entry.options.id==='deepseek-official');
    const child=ctx.slots.entries('settings.models.sign-in')[0];if(!parent||!child)return;
    installing=true;
    try {
      const alias='worldlinebox.auth.sign-in';
      const releaseParent=ctx.slots.register({name:'settings.onboarding',...parent.options,priority:(parent.options.priority??0)-1,
        inject:parent.inject,locale:parent.locale,children:{[alias]:{kind:'single',scope:'root'}}},props=>{
        const complete=React.useRef(props.complete);complete.current=props.complete;
        const mounted=React.useRef(true);const timer=React.useRef();
        React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;clearTimeout(timer.current)}},[]);
        const operations=React.useMemo(()=>({...props.operations,storeCredential:async(...args)=>{
          const failure=await props.operations.storeCredential(...args);
          if(failure===undefined&&props.explicit){clearTimeout(timer.current);timer.current=setTimeout(()=>{if(mounted.current)complete.current()},0)}
          return failure;
        }}),[props.operations,props.explicit]);
        return React.createElement(parent.component,{...props,operations,renderSlot:(name,...args)=>props.renderSlot(name==='settings.models.sign-in'?alias:name,...args)});
      });
      const releaseChild=ctx.slots.register({name:alias,inject:child.inject,locale:child.locale},child.component);
      dispose=()=>{releaseChild();releaseParent()};
    } finally {installing=false}
  };
  ctx.effect(()=>{const releases=[ctx.slots.subscribe('settings.onboarding',refresh),ctx.slots.subscribe('settings.models.sign-in',refresh)];refresh();return()=>{for(const release of releases)release();dispose?.()}});
};return module.exports;
}});
`;
