import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { companionRuntimeSource } from '../../src/main/dsh/companion-runtime-source';
import { dshCompanionTaskToolPatch } from '../../src/main/dsh/task-connection';
import { DSH_NATIVE_CLI_DISABLED_IDS } from '../../src/main/dsh/cli-profile-mode';
import { removeManaged } from '../../src/main/dsh/files';
const roots: string[] = [];
const program = path.resolve('.tools/dsh-native-node/manager/runtimes/runtime-18047fd53ed24738561310c2/program');
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });
const boot = String.raw`
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {writeFile} from 'node:fs/promises';
const [program,root,patch]=process.argv.slice(2),anchor=path.join(program,'dsh/node_modules/@deepseek-ai/dsh/package.json'),load=createRequire(anchor);
const native=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-app-boot')));
const {provideCmdline}=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-cmdline')));
let requests=0;globalThis.fetch=async()=>{requests++;throw Error('No model calls allowed in startup probe')};
const home=path.join(root,'home'),dir=path.join(home,'profiles/web');native.initProfile(dir,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']);
const profile=native.loadProfileDirectory('probe',dir,anchor,{userLayer:true});
const overlays=[...native.loadOverlayPatches('probe',path.join(program,'dsh/node_modules/@deepseek-ai/dsh-headless/cordis.patch.yml')),...JSON.parse(process.env.PROBE_DISABLED_IDS).map(id=>({id,disabled:true})),...native.loadOverlayPatches('probe',patch)];
const context={name:'web',dir:profile.dir,patchPath:profile.patchPath,installAnchor:anchor,home,cwd:process.cwd(),startedBundles:profile.layers.map(layer=>layer.packageName),overlays,telemetryDisabledEnv:'1'};
const config=path.join(dir,'cordis.yml');await writeFile(config,'[]\n');
const resolution=await native.createRuntimeResolution({installAnchor:anchor,profile,home});let ctx,exitCode=0;
ctx=await native.boot('probe',config,native.readProfilePatches('probe',context,profile),async host=>{
 host.provide('profileContext',context);host.provide('launchEnvironment',native.loadLayeredEnv('probe',process.cwd()));
 await host.plugin(native.PluginPackages,{resolution});provideCmdline(host,{args:[],exit:code=>{exitCode=code;process.stdin.emit('end')}});
});
await new Promise(resolve=>{process.stdin.once('end',resolve);if(exitCode)resolve()});
await ctx.fiber.dispose();process.stdout.write('__MODEL_REQUESTS__'+requests+'\n');process.exitCode=exitCode;
`;
describe.skipIf(process.platform !== 'win32' || !existsSync(path.join(program,'bin/node.exe')))('Native persistent companion CLI adapter', () => {
  it('creates a real idle native Agent and bidirectional input before any model request', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(),'worldlinebox-companion-runtime-')); roots.push(root);
    for (const directory of ['home','user','temp','workspace']) await mkdir(path.join(root,directory),{recursive:true});
    const plugin=path.join(root,'agent.mjs'),patch=path.join(root,'agent.patch.json'),source=path.join(root,'boot.mjs');
    await writeFile(plugin,companionRuntimeSource(path.join(program,'dsh/node_modules/@deepseek-ai/dsh/package.json')));
    await writeFile(patch,JSON.stringify([...dshCompanionTaskToolPatch(),{id:'headless-startup',disabled:true},{id:'headless-runner',disabled:true},{insert:[{id:'worldlinebox-companion-runtime',name:plugin}]}]));
    await writeFile(source,boot);
    const env: NodeJS.ProcessEnv={};
    for (const [name,value] of Object.entries(process.env)) if (/^(PATH|PATHEXT|SystemRoot|windir|ComSpec|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432)$/i.test(name)) env[name]=value;
    Object.assign(env,{DSH_HOME:path.join(root,'home'),DSH_AGENTS_HOME:path.join(root,'agents'),HOME:path.join(root,'user'),USERPROFILE:path.join(root,'user'),
      APPDATA:path.join(root,'user/AppData/Roaming'),LOCALAPPDATA:path.join(root,'user/AppData/Local'),TEMP:path.join(root,'temp'),TMP:path.join(root,'temp'),
      PROBE_DISABLED_IDS:JSON.stringify(DSH_NATIVE_CLI_DISABLED_IDS),DSH_TELEMETRY_DISABLED:'1'});
    const run = () => new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
      const child=spawn(path.join(program,'bin/node.exe'),['--expose-internals',source,program,root,patch],{env,cwd:path.join(root,'workspace'),windowsHide:true,stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='';
      const timer=setTimeout(()=>{child.kill();reject(Error('Native adapter startup timeout: '+stdout.slice(-3000)+' '+stderr.slice(-2000)))},30000);
      child.stdout.on('data',chunk=>{stdout+=chunk; if(stdout.includes('"type":"ready"')||stdout.includes('"type":"error"'))child.stdin.end();});
      child.stderr.on('data',chunk=>{stderr+=chunk;});
      child.once('error',error=>{clearTimeout(timer);reject(error)});
      child.once('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})});
    });
    const result = await run();
    expect(result.code,result.stdout+'\n'+result.stderr).toBe(0);
    expect(result.stdout).toContain('"type":"ready"');
    expect(result.stdout).toContain('__MODEL_REQUESTS__0');
    const session = result.stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(value => value.type === 'session') as { sessionId: string };
    expect(session.sessionId).toMatch(/^session-/);
    await writeFile(plugin,companionRuntimeSource(path.join(program,'dsh/node_modules/@deepseek-ai/dsh/package.json'),session.sessionId));
    const resumed = await run();
    expect(resumed.code,resumed.stdout+'\n'+resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain(JSON.stringify({type:'session',sessionId:session.sessionId,resumed:true}));
    expect(resumed.stdout).toContain('__MODEL_REQUESTS__0');
  },70000);
});
