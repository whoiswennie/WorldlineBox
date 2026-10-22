import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { DshTaskBroker } from '../../src/main/dsh/task-broker';
import { prepareNativeCliMode } from '../../src/main/dsh/cli-profile-mode';
import { canonicalRuntimeEntryPaths } from '../../src/main/dsh/runtime-paths';
import { instanceEnvironment, launchCli, terminateOwnedProcess } from '../../src/main/dsh/instance-process';
import type { DshCliSelection } from '../../src/main/dsh/cli-terminal';
import type { DshTaskExecutionOptions } from '../../src/main/dsh/task-execution';
import { dshWorkerGeneration } from '../../src/main/dsh/warm-cli-pool';

/** A temporary profile and real native Agent behind the production broker. No installed account/profile is changed. */
export async function createNativeAcceptanceBroker(options: { program: string; apiKey: string; model: string; baseURL?: string; onWorkerReadyChanged?: (instanceId: string, ready: boolean) => void }) {
  const program = path.resolve(options.program);
  const sdk = path.join(program, 'dsh/node_modules');
  const anchor = path.join(sdk, '@deepseek-ai/dsh/package.json');
  const manifest = JSON.parse(await readFile(anchor, 'utf8')) as { version: string };
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-native-acceptance-'));
  let broker: DshTaskBroker | undefined;
  try {
    const runtimeId = 'runtime-acceptance';
    await mkdir(path.join(root, 'runtimes', runtimeId), { recursive: true });
    // The test resolves the real installed SDK through a directory link. Runtime sealing is covered separately.
    await symlink(program, path.join(root, 'runtimes', runtimeId, 'program'), process.platform === 'win32' ? 'junction' : 'dir');
    const instanceRoot = path.join(root, 'instances', 'acceptance');
    const workspace = path.join(root, 'workspace'); await mkdir(workspace);
    const instance: DshCliSelection['instance'] = { id: 'acceptance', name: 'Acceptance', runtimeId, profile: 'web', status: 'stopped',
      homePath: path.join(instanceRoot, 'home'), agentsPath: path.join(instanceRoot, 'agents'), workspacePath: workspace,
      browserPartition: 'temporary:acceptance', isDefault: true, createdAt: '', updatedAt: '' };
    const plan = { ...canonicalRuntimeEntryPaths(program, 'node-cli-web-v1'), env: {} };
    const env = await instanceEnvironment(instanceRoot, instance, plan); env.DSH_TELEMETRY_DISABLED = '1';
    const initialize = path.join(root, 'initialize.mjs');
    await writeFile(initialize, `import{createRequire}from'node:module';import{pathToFileURL}from'node:url';const load=createRequire(${JSON.stringify(anchor)});const native=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-app-boot')));native.initProfile(${JSON.stringify(path.join(instance.homePath, 'profiles/web'))},['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']);`);
    const child = await launchCli({ ...plan, cli: initialize }, [], env, workspace); child.stdout.resume(); child.stderr.resume();
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      if (code !== 0) throw new Error('The temporary native acceptance profile could not be initialized.');
    } finally { await terminateOwnedProcess(child); }
    const profile = [{ id: 'agent-default-model', config: { provider: 'deepseek-official', model: options.model } },
      { id: 'llm-deepseek', config: { ...(options.baseURL ? { baseURL: options.baseURL } : {}), apiKeyEnv: 'WORLDLINEBOX_ACCEPTANCE_API_KEY', thinking: 'disabled' } }];
    await writeFile(path.join(instance.homePath, 'profiles/web/cordis.patch.yml'), JSON.stringify(profile));
    // Native credentials resolve this explicit reference from the launch environment; no plaintext key enters the temporary profile.
    env.WORLDLINEBOX_ACCEPTANCE_API_KEY = options.apiKey;
    const nativeArgs = await prepareNativeCliMode(instanceRoot, program, manifest.version);
    const selected: DshCliSelection = { instance, plan, env, nativeCli: plan.cli, nativeArgs, workspacePath: workspace, routingPatch: '',
      runtimeVersion: manifest.version, runtime: { id: runtimeId, version: manifest.version } as DshCliSelection['runtime'] };
    await mkdir(path.join(root, 'cli'));
    // This carrier only routes stdio to the real CLI. The broker, generated runtime, Agent, model, tools and sessions are production code.
    await writeFile(path.join(root, 'cli/shim.cjs'), String.raw`
const fs=require('node:fs'),{spawn}=require('node:child_process');
const context=JSON.parse(fs.readFileSync(process.env.WORLDLINEBOX_DSH_CLI_CONTEXT,'utf8'));
const child=spawn(context.executable,['--expose-internals',context.nativeCli,...context.nativeArgs,...process.argv.slice(2)],{cwd:context.workspacePath,env:process.env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.once('error',()=>{process.exitCode=1;process.stdin.destroy()});
child.once('close',code=>{process.exitCode=code??1;process.stdin.destroy()});
`);
    broker = new DshTaskBroker({ rootPath: root, getSelection: async () => selected, onWorkerReadyChanged: options.onWorkerReadyChanged, pin: async selection => {
      const directory = path.join(root, 'cli', randomUUID()); await mkdir(directory);
      const contextFile = path.join(directory, 'context.json');
      await writeFile(contextFile, JSON.stringify({ executable: plan.executable, nativeCli: plan.cli, nativeArgs, workspacePath: selection.workspacePath }));
      return { contextFile, dispose: async () => { await rm(directory, { recursive: true, force: true }); } };
    } });
    const owner = { actionId: randomUUID(), companionId: 'native-acceptance', conversationId: 'acceptance-conversation', sourceMessageId: 'acceptance-input' };
    const execution: DshTaskExecutionOptions = { toolkit: true, interactive: true, recordScope: owner, workspaceRootPath: path.join(root, '.worldlinebox', 'companions', 'dsh-tasks'),
      access: { mode: 'workspace-write' } };
    const configurationSnapshot = async () => {
      const result: Record<string, string> = {}, excluded = new Set(['node_modules', '.git', 'storages', 'logs', 'cache', 'llm-deepseek', 'skills-disabled']);
      const walk = async (directory: string) => { for (const name of (await readdir(directory)).sort()) {
        if (excluded.has(name)) continue; const filename = path.join(directory, name), info = await lstat(filename);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) await walk(filename);
        else if (info.isFile()) result[path.relative(instanceRoot, filename)] = createHash('sha256').update(await readFile(filename)).digest('hex').slice(0, 12);
      } };
      await walk(instance.homePath); await walk(instance.agentsPath); return result;
    };
    return { root, broker, execution, generation: () => dshWorkerGeneration(root, selected, execution.access), configurationSnapshot,
      operation: () => ({ id: randomUUID(), signal: new AbortController().signal, log: async () => undefined, update: async () => undefined }),
      dispose: async () => { await broker!.shutdown(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } };
  } catch (error) { await broker?.shutdown(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); throw error; }
}
