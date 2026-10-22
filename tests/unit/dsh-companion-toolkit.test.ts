import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { removeManaged } from '../../src/main/dsh/files';
import { DSH_NATIVE_CLI_DISABLED_IDS, prepareNativeCliMode } from '../../src/main/dsh/cli-profile-mode';
import { dshCompanionTaskToolPatch } from '../../src/main/dsh/task-execution';
import { launchCli, terminateOwnedProcess } from '../../src/main/dsh/instance-process';

const nativeRoot = path.resolve('.tools/dsh-native-node/manager/runtimes');
const versions = [
  ['0.2.0-rc.2', 'runtime-d68184ecfbf37e4f192feb31'],
  ['0.2.1-alpha.2', 'runtime-18047fd53ed24738561310c2'],
] as const;
const available = process.platform === 'win32' && versions.every(([, id]) => existsSync(path.join(nativeRoot, id, 'program', 'bin', 'node.exe')));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });

// Probe code initializes a temporary profile, then launches the official CLI
// and observes an idle Agent's actual catalog inside its mounted plugin tree.
// There is no model followup, external account, credential read or paid request.
const probe = String.raw`
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import {writeFile,readFile} from 'node:fs/promises';import {spawn} from 'node:child_process';
const [program,root,toolkitFile]=process.argv.slice(2);
const anchor=path.join(program,'dsh/node_modules/@deepseek-ai/dsh/package.json'),load=createRequire(anchor);
const native=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-app-boot')));
process.stdout.write('__PROBE_STAGE__ imported SDK\n');
const home=path.join(root,'home'),profileDir=path.join(home,'profiles/web');native.initProfile(profileDir,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']);
process.stdout.write('__PROBE_STAGE__ profile initialized\n');
const carrierDisabled=JSON.parse(process.env.PROBE_DISABLED_IDS).map(id=>({id,disabled:true}));
const plugin=path.join(root,'catalog-runtime.mjs'),patch=path.join(root,'catalog.patch.json');
await writeFile(plugin, "let requests=0;globalThis.fetch=async()=>{requests++;throw Error('Model calls are forbidden by this capability probe')};export const name='catalog-probe';export const inject=['agents','tools'];export function apply(ctx){const exit=ctx.get('appExit');void Promise.resolve().then(async()=>{await ctx.get('loader').await();const created=await ctx.get('agents').create({sessionId:'probe-session',meta:{cwd:process.cwd()},agentOptions:{provider:'deepseek-official',model:'deepseek-flash'},setup:async scope=>{if(process.env.PROBE_STANDARD==='1')await ctx.get('agentPresets').mount(scope,'standard')}});await created.agent.whenIdle();const catalog=ctx.get('tools').schemas(created.agent).map(schema=>schema.name);process.stdout.write('__NATIVE_TOOL_CATALOG__'+JSON.stringify({catalog,modelRequests:requests})+'\\n');await created.dispose();exit(0)}).catch(error=>{console.error(error);exit(1)})}");
await writeFile(patch,JSON.stringify([...carrierDisabled,{id:'headless-startup',disabled:true},{id:'headless-runner',disabled:true},...JSON.parse(await readFile(toolkitFile,'utf8')),{insert:[{id:'catalog-probe',name:plugin}]}]));
process.stdout.write('__PROBE_STAGE__ patches written\n');
const cli=path.join(program,'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js');
const child=spawn(process.execPath,['--expose-internals',cli,...JSON.parse(process.env.PROBE_CLI_PREFIX),'--patch',patch],{env:process.env,cwd:process.cwd(),windowsHide:true,stdio:['ignore','inherit','inherit']});
process.stdout.write('__PROBE_STAGE__ official CLI spawned '+child.pid+'\n');
process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
`;

async function nativeCatalog(versionId: string, toolkit: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-native-toolkit-'));
  roots.push(root);
  const program = path.join(nativeRoot, versionId, 'program');
  const source = path.join(root, 'catalog-probe.mjs');
  const toolkitFile = path.join(root, 'toolkit.patch.json');
  const prefix = await prepareNativeCliMode(root, program, versions.find(([,id])=>id===versionId)![0]);
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
    DSH_TELEMETRY_DISABLED: '1', PROBE_CLI_PREFIX: JSON.stringify(prefix), PROBE_DISABLED_IDS: JSON.stringify(DSH_NATIVE_CLI_DISABLED_IDS), PROBE_STANDARD: toolkit ? '1' : '0', NO_COLOR: '1', FORCE_COLOR: '0' });
  const child = await launchCli({ executable: path.join(program, 'bin/node.exe'), cli: source, env: {} }, [program, root, toolkitFile], env, path.join(root, 'workspace'));
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = ''; let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void terminateOwnedProcess(child); }, 30_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Native tool catalog probe timed out.\n${stdout.slice(-2500)}\n${stderr.slice(-2500)}`));
      else resolve({ code, stdout, stderr });
    });
  }).finally(() => terminateOwnedProcess(child));
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
      expect(enabled.catalog).toEqual(expect.arrayContaining(['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'pwsh', 'web_search', 'web_fetch']));
      expect(baseline.modelRequests).toBe(0);
      expect(enabled.modelRequests).toBe(0);
    }, 90_000);
  }
});
