import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { removeManaged } from '../../src/main/dsh/files';
import { DSH_NATIVE_CLI_DISABLED_IDS } from '../../src/main/dsh/cli-profile-mode';
import { dshCompanionTaskToolPatch } from '../../src/main/dsh/task-connection';

const nativeRoot = path.resolve('.tools/dsh-native-node/manager/runtimes');
const versions = [
  ['0.2.0-rc.2', 'runtime-d68184ecfbf37e4f192feb31'],
  ['0.2.1-alpha.2', 'runtime-18047fd53ed24738561310c2'],
] as const;
const available = process.platform === 'win32' && versions.every(([, id]) => existsSync(path.join(nativeRoot, id, 'program', 'bin', 'node.exe')));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });

// Probe code imports the installed sealed SDK. It creates only a temporary
// native profile, mounts its actual DSL, then observes an idle Agent's catalog.
// There is no model followup, external account, credential read or paid request.
const probe = String.raw`
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {writeFile} from 'node:fs/promises';
const [program,root,toolkitFile]=process.argv.slice(2);
const anchor=path.join(program,'dsh/node_modules/@deepseek-ai/dsh/package.json'),load=createRequire(anchor);
const native=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-app-boot')));
process.stdout.write('__PROBE_STAGE__ imported SDK\n');
const {provideCmdline}=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-cmdline')));
const {scopeOf}=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-scope')));
let requests=0;globalThis.fetch=async()=>{requests++;throw Error('Model calls are forbidden by this capability probe')};
const home=path.join(root,'home'),profileDir=path.join(home,'profiles/web');native.initProfile(profileDir,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']);
const profile=native.loadProfileDirectory('probe',profileDir,anchor,{userLayer:true});
const nativeHeadless=native.loadOverlayPatches('probe',path.join(program,'dsh/node_modules/@deepseek-ai/dsh-headless/cordis.patch.yml'));
const carrierDisabled=JSON.parse(process.env.PROBE_DISABLED_IDS).map(id=>({id,disabled:true}));
const overrides=[...nativeHeadless,...carrierDisabled,{id:'headless-startup',disabled:true},{id:'headless-runner',disabled:true},...native.loadOverlayPatches('probe',toolkitFile)];
const context={name:'web',dir:profile.dir,patchPath:profile.patchPath,installAnchor:anchor,home,cwd:process.cwd(),startedBundles:profile.layers.map(layer=>layer.packageName),overlays:overrides,telemetryDisabledEnv:'1'};
const rootConfig=path.join(profileDir,'cordis.yml');await writeFile(rootConfig,'[]\n');
const resolution=await native.createRuntimeResolution({installAnchor:anchor,profile,home});
let ctx;
try{
 process.stdout.write('__PROBE_STAGE__ booting profile\n');
 ctx=await native.boot('probe',rootConfig,native.readProfilePatches('probe',context,profile),async host=>{
  process.stdout.write('__PROBE_STAGE__ preparing host\n');
  host.provide('profileContext',context);host.provide('launchEnvironment',native.loadLayeredEnv('probe',process.cwd()));
  await host.plugin(native.PluginPackages,{resolution});process.stdout.write('__PROBE_STAGE__ packages mounted\n');provideCmdline(host,{args:[],exit:()=>{}});
  process.stdout.write('__PROBE_STAGE__ host prepared\n');
 });
 process.stdout.write('__PROBE_STAGE__ profile booted\n');
 const created=await ctx.get('agents').create({sessionId:'probe-session',meta:{cwd:process.cwd()},agentOptions:{provider:'deepseek-official',model:'deepseek-flash'},setup:()=>{}});
 await created.agent.whenIdle();
 process.stdout.write('__PROBE_STAGE__ agent idle\n');
 const catalog=ctx.get('tools').schemas(scopeOf(created.agent.ctx)).map(schema=>schema.name);
 process.stdout.write('__NATIVE_TOOL_CATALOG__'+JSON.stringify({catalog,modelRequests:requests})+'\n');
}finally{process.stdout.write('__PROBE_STAGE__ disposing\n');await ctx?.fiber.dispose();process.stdout.write('__PROBE_STAGE__ disposed\n')}
`;

async function nativeCatalog(versionId: string, toolkit: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-native-toolkit-'));
  roots.push(root);
  const program = path.join(nativeRoot, versionId, 'program');
  const source = path.join(root, 'catalog-probe.mjs');
  const toolkitFile = path.join(root, 'toolkit.patch.json');
  await writeFile(source, probe);
  await writeFile(toolkitFile, JSON.stringify(toolkit ? dshCompanionTaskToolPatch() : []));
  for (const directory of ['home', 'agents', 'user', 'workspace', 'temp']) await mkdir(path.join(root, directory), { recursive: true });
  // Use the native CLI's package resolver alone and a deterministic Windows
  // environment. Vitest/Electron worker boot flags and inherited Cordis state
  // do not belong to an independently booted SDK process.
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(PATH|PATHEXT|SystemRoot|windir|ComSpec|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432)$/i.test(name)) env[name] = value;
  }
  Object.assign(env, { DSH_HOME: path.join(root, 'home'), DSH_AGENTS_HOME: path.join(root, 'agents'),
    HOME: path.join(root, 'user'), USERPROFILE: path.join(root, 'user'), APPDATA: path.join(root, 'user/AppData/Roaming'),
    LOCALAPPDATA: path.join(root, 'user/AppData/Local'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
    DSH_TELEMETRY_DISABLED: '1', PROBE_DISABLED_IDS: JSON.stringify(DSH_NATIVE_CLI_DISABLED_IDS), NO_COLOR: '1', FORCE_COLOR: '0' });
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(path.join(program, 'bin/node.exe'), ['--expose-internals', source, program, root, toolkitFile], {
      env, cwd: path.join(root, 'workspace'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Native tool catalog probe timed out.\n${stdout.slice(-2500)}\n${stderr.slice(-2500)}`));
      else resolve({ code, stdout, stderr });
    });
  });
  expect(output.code, output.stderr.slice(-4000)).toBe(0);
  const line = output.stdout.split(/\r?\n/).find(value => value.startsWith('__NATIVE_TOOL_CATALOG__'));
  if (!line) throw new Error('Native SDK did not publish a real Agent tool catalog.');
  return JSON.parse(line.slice('__NATIVE_TOOL_CATALOG__'.length)) as { catalog: string[]; modelRequests: number };
}

describe.skipIf(!available)('Actual official SDK companion tool scope (no model requests)', () => {
  for (const [version, id] of versions) {
    it(`${version} restores filesystem, image and native Windows shell tools only for the companion task`, async () => {
      const baseline = await nativeCatalog(id, false);
      if (version === '0.2.1-alpha.2') expect(baseline.catalog).toContain('working_directory');
      expect(baseline.catalog).not.toContain('read_image');
      expect(baseline.catalog).not.toContain('pwsh');
      const enabled = await nativeCatalog(id, true);
      expect(enabled.catalog).toEqual(expect.arrayContaining(['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'pwsh']));
      expect(baseline.modelRequests).toBe(0);
      expect(enabled.modelRequests).toBe(0);
    }, 90_000);
  }
});
