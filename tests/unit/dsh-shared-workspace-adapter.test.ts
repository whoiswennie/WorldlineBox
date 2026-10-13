import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeSharedWorkspaceAdapter } from '../../src/main/dsh/shared-workspace-adapter';
import { sharedSessionRoutingPatches, prepareSharedSessionData } from '../../src/main/dsh/shared-session-data';
import { prepareNativeCliMode } from '../../src/main/dsh/cli-profile-mode';
import { canonicalRuntimeEntryPaths } from '../../src/main/dsh/runtime-paths';
import { instanceEnvironment, launchCli, sanitizeOutput, terminateOwnedProcess } from '../../src/main/dsh/instance-process';
import type { DshInstance } from '../../src/shared/dsh-launcher';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const absolute = path.resolve(root); if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-workspace-adapter-')) throw new Error('Unexpected Workspace fixture root.');
    await rm(absolute, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-workspace-adapter-')); roots.push(root);
  const paths = await prepareSharedSessionData(path.join(root, 'shared')); return { root, paths };
}

describe('owned shared Workspace adapter', () => {
  it('leaves identical technical code untouched and refuses linked or foreign helper files', async () => {
    const { root, paths } = await setup(); const instanceRoot = path.join(root, 'instance'); await mkdir(instanceRoot);
    const options = { instanceRoot, workspacePath: paths.workspacePath, runtimeVersion: '0.2.0-rc.2' };
    const entry = await writeSharedWorkspaceAdapter(options); const before = await stat(entry.name);
    expect(entry).toMatchObject({ id: 'worldline-shared-workspace', insert: true, config: { workspacePath: await import('node:fs/promises').then(fs => fs.realpath(paths.workspacePath)) } });
    expect((await readFile(entry.name, 'utf8')).startsWith('// WorldlineBox shared workspace adapter v1')).toBe(true);
    await writeSharedWorkspaceAdapter(options); expect((await stat(entry.name)).mtimeMs).toBe(before.mtimeMs);
    await expect(writeSharedWorkspaceAdapter({ ...options, runtimeVersion: 'future' })).rejects.toThrow('No verified');
    await writeFile(entry.name, '// user-owned source'); await expect(writeSharedWorkspaceAdapter(options)).rejects.toThrow('unmanaged file');
    const linked = path.join(root, 'linked-instance'); await symlink(instanceRoot, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(writeSharedWorkspaceAdapter({ ...options, instanceRoot: linked })).rejects.toThrow('ordinary private');
  });
});

type Reply = Record<string, unknown>;
interface NativeFixture { child: ChildProcessWithoutNullStreams; request(type: string, extra?: Record<string, unknown>): Promise<Reply> }

describe.skipIf(process.platform !== 'win32' || !process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY)('actual native cross-Host Workspace refresh', () => {
  it('hydrates foreign titles through read-only native observations, emits browser upserts, survives restart and respects deleted workspaces', async () => {
    const { root, paths } = await setup(); const program = path.resolve(process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY!);
    const script = path.join(root, 'native-workspace-driver.mjs');
    await writeFile(script, `
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';import readline from 'node:readline';
const [program,routing,cwd]=process.argv.slice(2);
const load=createRequire(path.join(program,'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json'));
const {runProfile}=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh/profile-boot')));const {loadLayeredEnv}=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-app-boot')));
const running=await runProfile({profile:'web',environment:loadLayeredEnv('dsh'),patchFiles:[routing],args:['--no-open','--port','0']});const {ctx}=running;
const added=[],activity=[];ctx.on('api-session/added',value=>added.push(value));ctx.on('api-session/activity',(id,time)=>activity.push({id,time}));
const inputs=readline.createInterface({input:process.stdin});let turn=Promise.resolve();
inputs.on('line',text=>{turn=turn.then(async()=>{const request=JSON.parse(text);let data;
try{if(request.type==='workspace'){const workspace=ctx.workspaceRegistry.list().find(value=>value.path===cwd)??await ctx.workspaceRegistry.create(cwd,'Shared default');data={workspaceId:workspace.id}}
else if(request.type==='create'){data=await ctx.sessionController.create({workspaceId:request.workspaceId});await ctx.sessionController.rename({sessionId:data.sessionId,title:request.title});await ctx.get('sessions').flush(ctx.get('sessions').get(data.sessionId))}
else if(request.type==='rename'){data=await ctx.sessionController.rename({sessionId:request.sessionId,title:request.title});await ctx.get('sessions').flush(ctx.get('sessions').get(request.sessionId))}
else if(request.type==='state'){data={workspaces:ctx.workspaceRegistry.list().map(value=>({id:value.id,path:value.path,sessionIds:value.sessionIds})),list:await ctx.sessionController.list({}),added,activity,agentAvailable:!!ctx.get('agents').get(request.sessionId),sessionAttached:!!ctx.get('sessions').get(request.sessionId),revisions:(await ctx.sessionPersistence.list()).map(value=>typeof value.revision)}}
else if(request.type==='delete-workspace'){const workspace=ctx.workspaceRegistry.list().find(value=>value.path===cwd);data={deleted:workspace?await ctx.workspaceRegistry.delete(workspace.id):false}}
else if(request.type==='close'){await running.shutdown.shutdown(0);inputs.close();data={closed:true}}
console.log('WORKSPACE_ADAPTER_RESULT '+JSON.stringify({id:request.id,data}));if(request.type==='close')process.exit(0);
}catch(error){console.log('WORKSPACE_ADAPTER_RESULT '+JSON.stringify({id:request.id,error:error.name,errorMessage:error.message,requestType:request.type}))}})});
console.log('WORKSPACE_ADAPTER_READY');
`);
    const fixtures: NativeFixture[] = [];
    const start = async (id: string): Promise<NativeFixture> => {
      const instanceRoot = path.join(root, 'instances', id); await mkdir(instanceRoot, { recursive: true });
      const instance: DshInstance = { id, name: id, runtimeId: 'official', profile: 'web', status: 'stopped', isDefault: false, createdAt: 'date', updatedAt: 'date',
        homePath: path.join(instanceRoot, 'home'), agentsPath: path.join(instanceRoot, 'agents'), workspacePath: paths.workspacePath, browserPartition: `persist:${id}` };
      const adapter = await writeSharedWorkspaceAdapter({ instanceRoot, workspacePath: paths.workspacePath, runtimeVersion: '0.2.0-rc.2' });
      const routing = path.join(instanceRoot, 'launcher', 'routing.patch.yml'); await writeFile(routing, JSON.stringify([...sharedSessionRoutingPatches(paths.rootPath), { insert: [{ id: adapter.id, name: adapter.name, config: adapter.config }] }]));
      const plan = { executable: path.join(program, 'DeepSeek Harness.exe'), cli: script, env: { ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: '1' } };
      const child = await launchCli(plan, [program, routing, paths.workspacePath], await instanceEnvironment(instanceRoot, instance, plan), paths.workspacePath);
      let seq = 0; let output = ''; let errors = ''; const pending = new Map<number, { resolve(value: Reply): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
      let readyResolve: () => void; let readyReject: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const readyTimeout = setTimeout(() => readyReject(new Error('Native Workspace adapter startup timed out.')), 25_000);
      child.stderr.on('data', chunk => { errors += chunk.toString(); });
      child.stdout.on('data', chunk => {
        output += chunk.toString(); if (output.includes('WORKSPACE_ADAPTER_READY')) { clearTimeout(readyTimeout); readyResolve(); }
        let index = output.indexOf('\n'); while (index >= 0) {
          const line = output.slice(0, index); output = output.slice(index + 1); index = output.indexOf('\n');
          if (!line.startsWith('WORKSPACE_ADAPTER_RESULT ')) continue;
          const result = JSON.parse(line.slice('WORKSPACE_ADAPTER_RESULT '.length)) as { id: number; data?: Reply; error?: string; errorMessage?: string; requestType?: string };
          const waiter = pending.get(result.id); if (!waiter) continue; clearTimeout(waiter.timer); pending.delete(result.id);
          if (result.error) waiter.reject(new Error(sanitizeOutput(`Native Workspace fixture ${result.requestType}: ${result.error} ${result.errorMessage}`))); else waiter.resolve(result.data!);
        }
      });
      child.once('exit', code => { clearTimeout(readyTimeout); const failure = new Error(sanitizeOutput(`Native Workspace fixture ${code}: ${errors}`)); readyReject(failure); for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(failure); } });
      const fixture: NativeFixture = { child, request(type, extra = {}) {
        const id = ++seq; return new Promise<Reply>((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native Workspace request timed out.')); }, 15_000); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ type, id, ...extra }) + '\n'); });
      } }; fixtures.push(fixture); await ready; return fixture;
    };
    try {
      const a = await start('host-a'); let b = await start('host-b');
      const aWorkspace = await a.request('workspace'); await b.request('workspace');
      const created = await a.request('create', { workspaceId: aWorkspace.workspaceId, title: 'Foreign shared title' }); const sessionId = created.sessionId;
      let observed: Reply = {};
      const waitVisible = async (title: string) => {
        const deadline = Date.now() + 12_000;
        do { observed = await b.request('state', { sessionId }); if (JSON.stringify(observed.list).includes(title)) return; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
        expect(JSON.stringify(observed.list)).toContain(title);
      };
      await waitVisible('Foreign shared title');
      expect(JSON.stringify(observed.workspaces)).toContain(String(sessionId)); expect(observed.agentAvailable).toBe(false); expect(observed.sessionAttached).toBe(false);
      expect(JSON.stringify(observed.added)).toContain('Foreign shared title'); expect(observed.revisions).toEqual(['string']);
      await a.request('rename', { sessionId, title: 'Foreign renamed title' }); await waitVisible('Foreign renamed title');
      expect(JSON.stringify(observed.added)).toContain('Foreign renamed title'); expect(JSON.stringify(observed.activity)).toContain(String(sessionId));
      await b.request('close'); b = await start('host-b'); await waitVisible('Foreign renamed title');
      expect(observed.agentAvailable).toBe(false); expect(observed.sessionAttached).toBe(false);
      await b.request('delete-workspace'); await a.request('rename', { sessionId, title: 'Retained after Workspace deletion' });
      await new Promise(resolve => setTimeout(resolve, 2300)); expect((await b.request('state', { sessionId })).workspaces).toEqual([]);
    } finally { for (const fixture of fixtures) await terminateOwnedProcess(fixture.child); }
  }, 90_000);

  it('retains host-free native CLI help with the same technical adapter installed', async () => {
    const { root, paths } = await setup(); const program = path.resolve(process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY!);
    const instanceRoot = path.join(root, 'instances', 'cli'); await mkdir(instanceRoot, { recursive: true });
    const instance: DshInstance = { id: 'cli', name: 'cli', runtimeId: 'official', profile: 'web', status: 'stopped', isDefault: false, createdAt: 'date', updatedAt: 'date', homePath: path.join(instanceRoot, 'home'), agentsPath: path.join(instanceRoot, 'agents'), workspacePath: paths.workspacePath, browserPartition: 'persist:cli' };
    const entry = await writeSharedWorkspaceAdapter({ instanceRoot, workspacePath: paths.workspacePath, runtimeVersion: '0.2.0-rc.2' });
    const routing = path.join(instanceRoot, 'launcher', 'routing.patch.yml'); await writeFile(routing, JSON.stringify([...sharedSessionRoutingPatches(paths.rootPath), { insert: [{ id: entry.id, name: entry.name, config: entry.config }] }]));
    const plan = { ...canonicalRuntimeEntryPaths(program), env: { ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: '1' } };
    const prefix = await prepareNativeCliMode(instanceRoot, program); const child = await launchCli(plan, [...prefix, '--patch', routing, '--help'], await instanceEnvironment(instanceRoot, instance, plan), paths.workspacePath);
    try {
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => { let output = ''; child.stdout.on('data', chunk => { output += chunk.toString(); }); child.stderr.on('data', chunk => { output += chunk.toString(); }); child.once('error', reject); child.once('exit', code => resolve({ code, output })); });
      expect(result.code, sanitizeOutput(result.output)).toBe(0); expect(result.output).toContain('Answer one task and exit'); expect(result.output).not.toMatch(/^dsh web:/m);
    } finally { await terminateOwnedProcess(child); }
  }, 45_000);
});
