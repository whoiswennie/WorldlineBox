import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { dependencyLockSha256, nodeInstallEnvironment, supportsDshNode, validateNodeRuntimeInventory, validateOfficialNodeRelease, type OfficialNodeRelease } from '../../src/main/dsh/node-runtime-service';
import { RuntimeService } from '../../src/main/dsh/runtime-service';
import { OperationStore } from '../../src/main/dsh/operations';
import { copyTree, inventoryTree, removeManaged } from '../../src/main/dsh/files';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(tmpdir(), root); });
const run = promisify(execFile);
async function temporary() { const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-node-runtime-')); roots.push(root); return root; }
const tarball = (version: string) => Buffer.from(JSON.stringify({ version }));
const release = (version: string): OfficialNodeRelease => ({ version,
  tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`,
  integrity: `sha512-${createHash('sha512').update(tarball(version)).digest('base64')}` });

/** Owned package-manager fixture; no npm lifecycle or third-party package is executed. */
async function fixture(root: string) {
  const npmCli = path.join(root, 'fixture-npm.cjs');
  await writeFile(npmCli, `
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const args=process.argv.slice(2), archive=args[0]==='ci'?JSON.parse(fs.readFileSync('package.json','utf8')).dependencies['@deepseek-ai/dsh'].slice(5):args.at(-1), bytes=fs.readFileSync(archive);
const version=JSON.parse(bytes).version, integrity='sha512-'+crypto.createHash('sha512').update(bytes).digest('base64');
fs.writeFileSync(path.join(process.cwd(),'installer-env.json'),JSON.stringify({
  cache:process.env.npm_config_cache, registry:process.env.npm_config_registry,
  auth:process.env.OPENAI_API_KEY, inherited:process.env.NPM_CONFIG_CACHE,
  cacheKeyCount:Object.keys(process.env).filter(key=>/^npm_config_cache$/i.test(key)).length,
  proxy:process.env.HTTPS_PROXY, args
}));
for(const name of ['dsh','dsh-base','dsh-web-app','dsh-headless']) {
 const dir=path.join(process.cwd(),'node_modules','@deepseek-ai',name); fs.mkdirSync(path.join(dir,'lib'),{recursive:true});
 const manifest={name:'@deepseek-ai/'+name,version};
 if(name==='dsh') Object.assign(manifest,{type:'module',bin:{dsh:'lib/bin.js'},repository:{url:'git+https://github.com/deepseek-ai/deepseek-harness.git'},dependencies:Object.fromEntries(['dsh-base','dsh-web-app','dsh-headless'].map(x=>['@deepseek-ai/'+x,version]))});
 fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify(manifest));
 fs.writeFileSync(path.join(dir,'lib','bin.js'),'console.log('+JSON.stringify('native fixture '+version)+')');
}
const manifest=JSON.parse(fs.readFileSync('package.json','utf8'));manifest.dependencies={'@deepseek-ai/dsh':'file:'+archive};
fs.writeFileSync('package.json',JSON.stringify(manifest));
fs.writeFileSync('package-lock.json',JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:manifest.dependencies},'node_modules/@deepseek-ai/dsh':{version,resolved:'file:'+archive,integrity}}}));
console.log('fixture dependency closure installed');
`);
  return { nodeExecutable: process.execPath, npmCli, nodeVersion: process.versions.node, npmVersion: '11.0.0-fixture' };
}

describe('official Node DSH runtime adapter', () => {
  it.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('registers two concurrent releases without losing either index record', async () => {
    const root = await temporary(); const tools = await fixture(root);
    const manager = path.join(root, 'manager');
    const service = new RuntimeService({ rootPath: manager, sevenZipPath: 'unused', onChanged: () => undefined,
      nodeTools: async () => tools, nodeInstallNetwork: async () => ({registry:'https://registry.npmjs.org/',env:process.env}),
      fetch: async url => new Response(tarball(/dsh-([^/]+)\.tgz$/.exec(String(url))![1]!),{status:200}),
    }); await service.init();
    const operations = new OperationStore(path.join(manager,'operations'),()=>undefined); await operations.init();
    await Promise.all(['0.2.0-rc.2','0.2.1-alpha.2'].map(version => operations.run('runtime.install',version,undefined,
      async operation => { await service.installNode(release(version),operation); }, {type:'runtime.install',version})));
    await operations.settle();
    for (const operation of operations.list()) expect(operation.error).toBeUndefined();
    expect(operations.list().map(value=>value.status)).toEqual(['succeeded','succeeded']);
    expect(service.list().map(value=>value.version).sort()).toEqual(['0.2.0-rc.2','0.2.1-alpha.2']);
    const indexed = JSON.parse(await readFile(path.join(manager,'runtimes.json'),'utf8'));
    expect(indexed.length).toBe(2);
    for (const runtime of service.list()) await service.verify(runtime.id);
  });
  it('admits exact official package coordinates and the supported Node engine range', () => {
    expect(validateOfficialNodeRelease(release('0.2.1-alpha.2'))).toEqual(release('0.2.1-alpha.2'));
    for (const version of ['24.15.0','22.19.0','26.0.0']) expect(supportsDshNode(version)).toBe(true);
    for (const version of ['20.19.0','22.18.0','23.0.0','24.15.0-rc.1','unknown']) expect(supportsDshNode(version)).toBe(false);
    for (const change of [{version:'latest'}, {tarball:'https://example.org/dsh.tgz'},
      {tarball:release('0.2.0-rc.2').tarball}, {integrity:'sha256-not-sha512'}]) {
      expect(() => validateOfficialNodeRelease({...release('0.2.1-alpha.2'),...change})).toThrow();
    }
  });

  it('scopes npm caches/config and uses the current network snapshot without inherited model keys', async () => {
    const root = await temporary(); const tools = await fixture(root);
    const env = await nodeInstallEnvironment(root, tools, {registry:'https://registry.npmjs.org/', env:{
      ...process.env, NPM_CONFIG_CACHE:'foreign-cache', PNPM_CONFIG_STORE_DIR:'foreign-store',
      OPENAI_API_KEY:'fixture-key-never-inherit', NODE_OPTIONS:'--bad-loader', ELECTRON_RUN_AS_NODE:'1',
      PYTHONUSERBASE:'foreign-python',PYTHONHOME:'foreign-python-home',PYTHONPATH:'foreign-python-path',PYTHONNOUSERSITE:'1',PIP_USER:'0',
      HTTPS_PROXY:'http://127.0.0.1:18080',
    }});
    expect(env.npm_config_cache).toBe(path.join(root,'cache'));
    expect(env.npm_config_registry).toBe('https://registry.npmjs.org/');
    expect(Object.keys(env).filter(key=>/^npm_config_cache$/i.test(key))).toEqual(['npm_config_cache']);
    for (const key of ['OPENAI_API_KEY','NODE_OPTIONS','PNPM_CONFIG_STORE_DIR','ELECTRON_RUN_AS_NODE']) expect(env[key]).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:18080');
    expect(env.npm_config_https_proxy).toBe(env.HTTPS_PROXY);
    expect(env.npm_config_fetch_timeout).toBe('120000');
    expect(env.PYTHONUSERBASE).toBe(path.join(root,'user','python-userbase'));expect(env.PIP_USER).toBe('1');
    for(const key of ['PYTHONHOME','PYTHONPATH','PYTHONNOUSERSITE'])expect(env[key]).toBeUndefined();
    expect(await readFile(env.npm_config_userconfig!,'utf8')).toBe('');
  });
  it('refuses a mixed first-party package graph even when the selected CLI version is correct', async () => {
    const root=await temporary();
    const packageDirectory=path.join(root,'dsh','node_modules','@deepseek-ai','dsh-session');
    await mkdir(packageDirectory,{recursive:true});
    await writeFile(path.join(packageDirectory,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-session',version:'0.2.0-rc.2'}));
    await expect(validateNodeRuntimeInventory(root,'0.2.0-rc.2',await inventoryTree(root))).resolves.toBeUndefined();
    await writeFile(path.join(packageDirectory,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-session',version:'0.1.7-rc.2'}));
    await expect(validateNodeRuntimeInventory(root,'0.2.0-rc.2',await inventoryTree(root))).rejects.toThrow('mixed release versions');
  });

  it.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('seals two real Node executable plans with separate exact package closures, reloads and detects drift', async () => {
    const root=await temporary(); const manager=path.join(root,'manager'); const tools=await fixture(root);
    let selectedProxy='http://127.0.0.1:18081'; let networkCalls=0;
    const options={rootPath:manager,sevenZipPath:'unused',onChanged:()=>undefined,
      nodeTools:async()=>tools,
      nodeInstallNetwork:async()=>{networkCalls++;return {registry:'https://registry.npmjs.org/',env:{...process.env,HTTPS_PROXY:selectedProxy,NPM_CONFIG_CACHE:'bad-cache',OPENAI_API_KEY:'fixture-inherit-refused'}};},
      fetch:async(url: string|URL|Request)=>new Response(tarball(/dsh-([^/]+)\.tgz$/.exec(String(url))![1]!),{status:200}),
    };
    const service=new RuntimeService(options); await service.init();
    const ops=new OperationStore(path.join(manager,'operations'),()=>undefined); await ops.init();
    for (const version of ['0.2.0-rc.2','0.2.1-alpha.2']) {
      await ops.run('node-install',version,undefined,op=>service.installNode(release(version),op).then(()=>undefined));
      await ops.settle(); expect(ops.list()[0]?.error).toBeUndefined(); expect(ops.list()[0]?.status).toBe('succeeded');
      selectedProxy='http://127.0.0.1:18082';
    }
    expect(networkCalls).toBe(2); expect(service.list().map(item=>item.version)).toEqual(['0.2.0-rc.2','0.2.1-alpha.2']);
    for (const [index,runtime] of service.list().entries()) {
      const plan=service.plan(runtime.id); expect(runtime.adapter).toBe('node-cli-web-v1'); expect(runtime.electronVersion).toBeUndefined();
      expect(plan.executable).toBe(path.join(service.directory(runtime.id),'bin','node.exe'));
      expect(plan.cli).toBe(path.join(service.directory(runtime.id),'dsh','node_modules','@deepseek-ai','dsh','lib','bin.js'));
      expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      const actual=await run(plan.executable,[plan.cli,'--version'],{windowsHide:true}); expect(actual.stdout.trim()).toBe(`native fixture ${runtime.version}`);
      await service.verify(runtime.id);
      const saved=JSON.parse(await readFile(path.join(service.directory(runtime.id),'dsh','installer-env.json'),'utf8'));
      expect(saved.auth).toBeUndefined(); expect(saved.inherited).toBe(saved.cache);
      expect(saved.cacheKeyCount).toBe(1);expect(saved.cache).not.toBe('bad-cache');
      expect(saved.cache).toBe(path.join(manager,'npm-cache'));
      expect(saved.proxy).toBe(index===0?'http://127.0.0.1:18081':'http://127.0.0.1:18082');
      const manifest=JSON.parse(await readFile(path.join(service.directory(runtime.id),'dsh','package.json'),'utf8'));
      expect(manifest.dependencies['@deepseek-ai/dsh']).toBe(runtime.version);
      const lock=JSON.parse(await readFile(path.join(service.directory(runtime.id),'dsh','package-lock.json'),'utf8'));
      expect(lock.packages['node_modules/@deepseek-ai/dsh'].resolved).toBe(release(runtime.version).tarball);
    }
    const again=new RuntimeService(options); await again.init(); expect(again.list()).toEqual(service.list());
    const firstProgram=service.directory(service.list()[0]!.id);const beforeImport=await inventoryTree(firstProgram);
    const restored=new RuntimeService({...options,rootPath:path.join(root,'restored')});await restored.init();
    let restoredRuntime:string|undefined;
    await ops.run('node-import','offlinebackup',undefined,async op=>{restoredRuntime=(await restored.import(firstProgram,'directory','owned-backup-fixture',op)).id;});await ops.settle();
    expect(ops.list()[0]?.error).toBeUndefined();expect(restoredRuntime).toBe(service.list()[0]!.id);
    await restored.verify(restoredRuntime!);expect((await inventoryTree(firstProgram)).contentSha256).toBe(beforeImport.contentSha256);
    expect(restored.plan(restoredRuntime!).executable).toContain(path.join(root,'restored'));
    const changed=path.join(root,'changed-node-program');await copyTree(firstProgram,changed);
    const nodeReceipt=JSON.parse(await readFile(path.join(changed,'node-runtime.json'),'utf8')) as Record<string,unknown>;
    expect(nodeReceipt.npmIntegrity).toBe(release('0.2.0-rc.2').integrity);expect(nodeReceipt.dependencyLockSha256).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(path.join(changed,'bin','node.exe'),'changed imported executable');
    await ops.run('node-import','tamperedbackup',undefined,op=>restored.import(changed,'directory','owned-tampered-backup',op).then(()=>undefined));await ops.settle();
    expect(ops.list()[0]?.error).toContain('Node executable');expect(restored.list()).toHaveLength(1);
    const sourceRecord=service.list()[0]!;const identity=await service.nodeSourceIdentity(sourceRecord.id);
    const expectedLock={version:sourceRecord.version,platform:sourceRecord.platform,adapter:'node-cli-web-v1' as const,contentSha256:sourceRecord.contentSha256,sourceSha256:sourceRecord.sourceSha256,npmIntegrity:identity.npmIntegrity,dependencyLockSha256:identity.dependencyLockSha256,nodeVersion:identity.nodeVersion,npmVersion:identity.npmVersion,nodeExecutableSha256:identity.nodeExecutableSha256,payloadSha256:'f'.repeat(64)};
    await ops.run('node-replay-payload','changedpayload',undefined,op=>service.installNode(release(sourceRecord.version),op,undefined,expectedLock).then(()=>undefined));await ops.settle();
    expect(ops.list()[0]?.error).toContain('SDK and binary payload');expect(service.list()).toHaveLength(2);
    const first=service.list()[0]!; await writeFile(service.plan(first.id).cli,'changed');
    await expect(service.verify(first.id)).rejects.toThrow('changed');
    await service.verify(service.list()[1]!.id);
    await expect(service.delete(first.id,true)).rejects.toThrow('引用');
  },45_000);
  it('identifies the same normalized lock graph across mirror URLs and refuses changed package integrities',async()=>{
    const root=await temporary();const location='node_modules/@deepseek-ai/dsh';
    const lock={lockfileVersion:3,packages:{'':{name:'worldlinebox-dsh-runtime',dependencies:{'@deepseek-ai/dsh':'0.2.0-rc.2'}},[location]:{version:'0.2.0-rc.2',integrity:release('0.2.0-rc.2').integrity,resolved:release('0.2.0-rc.2').tarball}}};
    await writeFile(path.join(root,'package-lock.json'),JSON.stringify(lock));const first=await dependencyLockSha256(root);
    lock.packages[location]!.resolved='https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.2.0-rc.2.tgz';
    await writeFile(path.join(root,'package-lock.json'),JSON.stringify(lock));expect(await dependencyLockSha256(root)).toBe(first);
    lock.packages[location]!.integrity=release('0.2.1-alpha.2').integrity;
    await writeFile(path.join(root,'package-lock.json'),JSON.stringify(lock));expect(await dependencyLockSha256(root)).not.toBe(first);
  });

  it.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('rejects a changed upstream archive before executing the package manager or registering a runtime', async () => {
    const root=await temporary(); const manager=path.join(root,'manager'); const tools=await fixture(root);
    let networkCalls=0;
    const service=new RuntimeService({rootPath:manager,sevenZipPath:'unused',onChanged:()=>undefined,
      nodeTools:async()=>tools,nodeInstallNetwork:async()=>{networkCalls++;return {registry:'https://registry.npmjs.org/',env:process.env};},
      fetch:async()=>new Response('different-package-bytes',{status:200}),
    }); await service.init();
    const ops=new OperationStore(path.join(manager,'operations'),()=>undefined);await ops.init();
    await ops.run('node-install','changed',undefined,op=>service.installNode(release('0.2.0-rc.2'),op).then(()=>undefined));await ops.settle();
    expect(ops.list()[0]?.error).toContain('SHA-512');expect(service.list()).toEqual([]);expect(networkCalls).toBe(0);
    await mkdir(path.join(manager,'marker')); // Storage remains usable after the failed install.
  },20_000);
});
