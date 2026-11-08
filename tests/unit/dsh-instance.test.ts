import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { InstanceService } from '../../src/main/dsh/instance-service';
import { OperationStore } from '../../src/main/dsh/operations';
import { dshRuntimeSchema } from '../../src/shared/dsh-launcher';
import { TEST_NODE_EXECUTABLE, TEST_NODE_VERSION } from '../helpers/node-executable';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(holdTokenExchange = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-native-instances-'));
  const program = path.join(root, 'program'); await mkdir(program); const cli = path.join(program, 'fixture.cjs');
  await writeFile(cli, `const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const args=process.argv.slice(2),profile=path.join(process.env.DSH_HOME,'profiles/web');
fs.appendFileSync(path.join(process.env.DSH_HOME,'commands.log'),JSON.stringify(args)+'\\n');
if(args.includes('--dump-default-config')){fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'package.json'),'{}');}
else if(args.includes('plugin')){ const spec=args[args.indexOf('add')+1];if(spec&&spec.startsWith('file:')){const source=path.resolve(process.cwd(),spec.slice(5));const target=path.join(profile,'node_modules/@worldlinebox/dsh-bridge');fs.mkdirSync(target,{recursive:true});fs.copyFileSync(path.join(source,'index.js'),path.join(target,'index.js'));}}
else {const token=process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN;const server=http.createServer((req,res)=>{
if(req.url==='/?fixture'){const reply=()=>{res.writeHead(303,{location:'./','set-cookie':'native=fixture; HttpOnly'});res.end();};
if(process.env.FIXTURE_READY_GATE){fs.writeFileSync(process.env.FIXTURE_READY_GATE+'.waiting','1');const timer=setInterval(()=>{if(fs.existsSync(process.env.FIXTURE_READY_GATE)){clearInterval(timer);reply();}},10);req.on('close',()=>clearInterval(timer));}else reply();return;}
if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return;}
if(req.url==='/idle'){res.setHeader('content-type','application/json');const state=path.join(process.env.DSH_HOME,'idle-state.json');res.end(fs.existsSync(state)?fs.readFileSync(state):JSON.stringify({known:true,idle:true,activeTurns:0,backgroundJobs:0,pendingQuestions:0,pendingInbox:0,settling:0,activeSubagents:0}));return;}
if(req.url==='/shutdown'){res.end('{}');setTimeout(()=>process.emit('SIGTERM'),5);return;}
res.setHeader('content-type','application/json');res.end(JSON.stringify({protocol:'worldlinebox-native-web-host-v1',pid:process.pid,userProfile:process.env.USERPROFILE,home:process.env.DSH_HOME,version:process.env.FIXTURE_VERSION}));});
server.listen(0,'127.0.0.1',()=>{console.log('dsh web: http://127.0.0.1:'+server.address().port+'/?fixture');console.log('WORLDLINEBOX_DSH_BRIDGE_READY '+server.address().port);});
if(fs.existsSync(path.join(process.env.DSH_HOME,'fail-version'))&&fs.readFileSync(path.join(process.env.DSH_HOME,'fail-version'),'utf8')===process.env.FIXTURE_VERSION){fs.writeFileSync(path.join(process.env.DSH_HOME,'migration-data.txt'),'damaged by failed migration');process.exit(9);}
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));}
`);
  const runtimes = ['runtime-a', 'runtime-b'].map((id, index) => dshRuntimeSchema.parse({ id, version: `0.2.${index}`, nodeVersion: TEST_NODE_VERSION,
    platform: 'win32-x64', adapter: 'node-cli-web-v1', source: 'fixture', sourceSha256: String(index).repeat(64), contentSha256: String(index).repeat(64), installedAt: '', fileCount: 0, byteLength: 0 }));
  const verify = vi.fn(async () => undefined), openWorkbench = vi.fn(async () => undefined), startup = vi.fn(), manualStop = vi.fn();
  const readyGate = path.join(root, 'token-exchange-released');
  const operations = new OperationStore(path.join(root, 'operations'), () => undefined); await operations.init();
  const serviceOptions: ConstructorParameters<typeof InstanceService>[0] = { rootPath: root, bridgePackagePath: path.resolve('resources/dsh-bridge'), operations,
    runtimes: { list: () => runtimes, get: id => runtimes.find(value => value.id === id)!, directory: () => program,
      plan: id => ({ executable: TEST_NODE_EXECUTABLE, cli, env: { FIXTURE_VERSION: runtimes.find(value => value.id === id)!.version, ...(holdTokenExchange ? { FIXTURE_READY_GATE: readyGate } : {}) } }), verify },
    onChanged: () => undefined, onStartup: startup, onManualStop: manualStop, openWorkbench, closeWorkbench: async () => undefined, clearBrowserData: async () => undefined };
  serviceOptions.isExternallyInUse = (id, operationId) => operations.isInstanceInUse(id, operationId);
  const service = new InstanceService(serviceOptions);
  await service.init(); cleanup.push(async () => { await service.shutdown(); await operations.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { service, serviceOptions, operations, root, verify, openWorkbench, startup, manualStop, readyGate };
}

it('creates, selects, uses, stops and deletes through journaled operations without counting deletion as its own holder', async () => {
  const f = await fixture(), sibling = await f.service.create('Keep this shared environment', 'runtime-a');
  const siblingHost = await f.service.ensureHost(sibling.id);
  const created = await f.service.handle({ type: 'instance.create', name: 'Disposable shared environment', runtimeId: 'runtime-a' });
  expect(created.ok).toBe(true); await f.operations.settle();
  const instance = f.service.list().find(value => value.id !== sibling.id)!;
  await f.service.selectExecutionInstance(instance.id);
  expect((await f.service.ensureCompanion('fish', 'Fish', sibling)).id).toBe(instance.id);
  const host = await f.service.ensureHost(instance.id);
  await host.health(); expect((await host.request<{ home: string }>('/health')).home).toBe(instance.homePath);
  const stopped = await f.service.handle({ type: 'instance.stop', instanceId: instance.id });
  expect(stopped.ok).toBe(true); await f.operations.settle();
  expect(f.service.get(instance.id).status).toBe('stopped');
  const deleted = await f.service.handle({ type: 'instance.delete', instanceId: instance.id });
  if (!deleted.ok) throw Error(deleted.error); await f.operations.settle();
  expect(f.operations.list().find(value => value.id === deleted.operationId)).toMatchObject({ status: 'succeeded' });
  expect(f.service.list().map(value => value.id)).toEqual([sibling.id]);
  await expect(readdir(f.service.getRoot(instance.id))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(path.join(f.root, 'native-instances.json'), 'utf8'))).toEqual([expect.objectContaining({ id: sibling.id, isDefault: true })]);
  await siblingHost.health();
});

it('still refuses deletion while a real task lease, terminal or another operation holds the instance', async () => {
  const f = await fixture(), instance = await f.service.create('Protected', 'runtime-a');
  const attempt = async (message: string) => {
    const response = await f.service.handle({ type: 'instance.delete', instanceId: instance.id });
    if (!response.ok) throw Error(response.error); await f.operations.settle();
    expect(f.operations.list().find(value => value.id === response.operationId)).toMatchObject({ status: 'failed', error: expect.stringContaining(message) });
    expect(f.service.get(instance.id).id).toBe(instance.id);
  };
  const release = f.service.acquireCompanionLease(instance.id, 'task'); await attempt('任务'); release();
  f.serviceOptions.isCliInUse = () => true; await attempt('终端'); f.serviceOptions.isCliInUse = () => false;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const holding = await f.operations.run('snapshot.create', 'Other operation', instance.id, () => gate);
  const deletion = await f.service.handle({ type: 'instance.delete', instanceId: instance.id });
  if (!deletion.ok) throw Error(deletion.error);
  await vi.waitFor(() => expect(f.operations.list().find(value => value.id === deletion.operationId)).toMatchObject({ status: 'failed', error: expect.stringContaining('其他操作') }));
  expect(f.operations.isInstanceInUse(instance.id, deletion.operationId)).toBe(true);
  expect(f.operations.isInstanceInUse(instance.id, holding)).toBe(false);
  finish(); await f.operations.settle();
  await f.service.remove(instance.id);
});

it('can snapshot, clone and export a stopped instance from its own journaled operation', async () => {
  const f = await fixture(), instance = await f.service.create('Snapshot source', 'runtime-a');
  await writeFile(path.join(instance.workspacePath, 'proof.txt'), 'retained original content');
  for (const request of [
    { type: 'snapshot.create' as const, instanceId: instance.id, name: 'Snapshot' },
    { type: 'instance.clone' as const, instanceId: instance.id, name: 'Clone' },
  ]) {
    const response = await f.service.handle(request); if (!response.ok) throw Error(response.error); await f.operations.settle();
    expect(f.operations.list().find(value => value.id === response.operationId)).toMatchObject({ status: 'succeeded' });
  }
  const exportId = await f.operations.run('instance.export', 'Export', instance.id, op => f.service.exportTo(instance.id, path.join(f.root, 'export-proof'), op));
  await f.operations.settle(); expect(f.operations.list().find(value => value.id === exportId)).toMatchObject({ status: 'succeeded' });
  expect(await readFile(path.join(f.root, 'export-proof/data/workspace/proof.txt'), 'utf8')).toBe('retained original content');
});
it('deduplicates concurrent starts and opens the same native Host for the user', async () => {
  const f = await fixture(), instance = await f.service.create('Fish', 'runtime-a');
  const clients = await Promise.all(Array.from({ length: 8 }, () => f.service.ensureHost(instance.id)));
  expect(new Set(clients.map(value => value.pid)).size).toBe(1); expect(f.verify).toHaveBeenCalledTimes(1);
  expect((await f.service.handle({ type: 'instance.open', instanceId: instance.id })).ok).toBe(true); await f.operations.settle();
  expect(f.openWorkbench).toHaveBeenCalledWith(expect.objectContaining({ pid: clients[0]!.pid }), f.service.getUrl(instance.id));
  expect(f.verify).toHaveBeenCalledTimes(1);
});
it('does not publish an early bridge client before the shared Web token exchange completes', async () => {
  const f = await fixture(true), instance = await f.service.create('Gated host', 'runtime-a');
  const first = f.service.ensureHost(instance.id);
  await vi.waitFor(async () => expect(await readFile(f.readyGate + '.waiting', 'utf8')).toBe('1'));
  let secondReady = false;
  const second = f.service.ensureHost(instance.id).then(client => { secondReady = true; return client; });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(secondReady).toBe(false);
  expect(f.service.get(instance.id).status).toBe('starting');
  await writeFile(f.readyGate, 'release');
  const clients = await Promise.all([first, second]);
  expect(clients[0].pid).toBe(clients[1].pid);
  expect(f.verify).toHaveBeenCalledTimes(1);
  expect(f.startup.mock.calls.map(([value]) => value.phase)).toEqual(['verifying-runtime', 'preparing-profile', 'starting-host', 'ready']);
});
it('runs multiple pinned versions concurrently with distinct native Homes', async () => {
  const f = await fixture(), first = await f.service.create('A', 'runtime-a'), second = await f.service.create('B', 'runtime-b');
  const a = await f.service.ensureHost(first.id), b = await f.service.ensureHost(second.id);
  expect(a.pid).not.toBe(b.pid); expect(f.service.get(first.id).status).toBe('running');
  expect(await a.request('/health')).toMatchObject({ version: '0.2.0', home: first.homePath });
  expect(await b.request('/health')).toMatchObject({ version: '0.2.1', home: second.homePath });
  await f.service.stop(first.id); await b.health(); expect(f.service.get(first.id).status).toBe('stopped');
});
it('does not cancel a shared startup when one waiting partner cancels', async () => {
  const f = await fixture(), instance = await f.service.create('Fish', 'runtime-a'), abort = new AbortController();
  const waiting = f.service.ensureHost(instance.id, abort.signal); const rejected = expect(waiting).rejects.toThrow('partner cancelled');
  const other = f.service.ensureHost(instance.id); abort.abort(new Error('partner cancelled')); await rejected;
  await (await other).health(); expect(f.service.get(instance.id).status).toBe('running');
});
it('restarts the same stopped user instance without creating another companion profile', async () => {
  const f = await fixture(), instance = await f.service.create('我的 DSH', 'runtime-a');
  const first = await f.service.ensureHost(instance.id); await f.service.stop(instance.id);
  const second = await f.service.ensureHost(instance.id);
  expect(second.pid).not.toBe(first.pid); expect(f.service.list()).toHaveLength(1);
  expect(f.service.get(instance.id)).toMatchObject({ name: '我的 DSH', homePath: instance.homePath, status: 'running' });
  expect((await second.request<{ home: string }>('/health')).home).toBe(instance.homePath);
});

it.each([false, true])('fences automatic starts after an explicit stop of an ordinary/private instance (%s)', async privateEnvironment => {
  const f = await fixture(), base = await f.service.create('我的 DSH', 'runtime-a');
  const instance = privateEnvironment ? await f.service.ensureCompanion('stopped-partner', '暂停伙伴', base) : base;
  await f.service.ensureHost(instance.id); const stop = f.service.stop(instance.id);
  expect(f.manualStop).toHaveBeenCalledExactlyOnceWith(instance.id);
  await expect(f.service.ensureHost(instance.id, undefined, { automatic: true })).rejects.toMatchObject({ code: 'DSH_HOST_UNAVAILABLE', reason: 'stopped', instanceId: instance.id });
  await stop;
  await expect(f.service.ensureHost(instance.id, undefined, { automatic: true })).rejects.toMatchObject({ reason: 'stopped' });
  expect(f.verify).toHaveBeenCalledTimes(1); expect(f.service.get(instance.id).status).toBe('stopped');
  await f.service.ensureHost(instance.id);
  expect(f.service.get(instance.id).status).toBe('running'); expect(f.verify).toHaveBeenCalledTimes(2);
});

it('lets an explicit resume wait for the same instance shutdown and starts exactly one replacement', async () => {
  const f = await fixture(), instance = await f.service.create('Resume after stop', 'runtime-a');
  const old = await f.service.ensureHost(instance.id), stopping = f.service.stop(instance.id);
  const resumes = [f.service.ensureHost(instance.id), f.service.ensureHost(instance.id)];
  await stopping; const clients = await Promise.all(resumes);
  expect(clients[0]!.pid).toBe(clients[1]!.pid); expect(clients[0]!.pid).not.toBe(old.pid);
  expect(f.verify).toHaveBeenCalledTimes(2); expect(f.service.list()).toHaveLength(1);
});

it('does not let a failing stop observer prevent the actual stop or clear its fence', async () => {
  const f = await fixture(), instance = await f.service.create('Stop observer', 'runtime-a');
  await f.service.ensureHost(instance.id); f.manualStop.mockImplementation(() => { throw new Error('observer failed'); });
  await f.service.stop(instance.id); expect(f.service.get(instance.id).status).toBe('stopped');
  await expect(f.service.ensureHost(instance.id, undefined, { automatic: true })).rejects.toMatchObject({ reason: 'stopped' });
});

it('keeps a newer explicit stop authoritative over a resume already waiting for shutdown', async () => {
  const f = await fixture(), instance = await f.service.create('Stop wins', 'runtime-a');
  await f.service.ensureHost(instance.id); const firstStop = f.service.stop(instance.id);
  const resume = f.service.ensureHost(instance.id), rejected = expect(resume).rejects.toMatchObject({ code: 'DSH_HOST_UNAVAILABLE', reason: 'stopped' });
  const lastStop = f.service.stop(instance.id);
  await Promise.all([firstStop, lastStop, rejected]);
  expect(f.service.get(instance.id).status).toBe('stopped'); expect(f.verify).toHaveBeenCalledTimes(1);
});

it('stops a shared startup before readiness and leaves no automatic revival or false failed state', async () => {
  const f = await fixture(true), instance = await f.service.create('Stop startup', 'runtime-a');
  const starting = f.service.ensureHost(instance.id, undefined, { automatic: true });
  const rejected = expect(starting).rejects.toMatchObject({ code: 'DSH_HOST_UNAVAILABLE', reason: 'stopped', instanceId: instance.id });
  await vi.waitFor(async () => expect(await readFile(f.readyGate + '.waiting', 'utf8')).toBe('1'));
  await f.service.stop(instance.id); await rejected;
  expect(f.service.get(instance.id).status).toBe('stopped');
  await expect(f.service.ensureHost(instance.id, undefined, { automatic: true })).rejects.toMatchObject({ reason: 'stopped' });
  expect(f.verify).toHaveBeenCalledTimes(1);
});

it('recovers a crashed Host on demand without confusing it with a user stop', async () => {
  const f = await fixture(), instance = await f.service.create('Crash recovery', 'runtime-a');
  const previous = await f.service.ensureHost(instance.id);
  await previous.request('/shutdown'); await vi.waitFor(() => expect(f.service.get(instance.id).status).toBe('failed'));
  const recovered = await f.service.ensureHost(instance.id, undefined, { automatic: true });
  expect(recovered.pid).not.toBe(previous.pid); expect(f.manualStop).not.toHaveBeenCalled();
  expect(f.service.get(instance.id).status).toBe('running'); expect(f.verify).toHaveBeenCalledTimes(2);
});

it('classifies a definite startup failure separately from missing configuration and shutdown', async () => {
  const f = await fixture(), instance = await f.service.create('Bad startup', 'runtime-a');
  f.verify.mockRejectedValueOnce(new Error('runtime bytes changed'));
  await expect(f.service.ensureHost(instance.id, undefined, { automatic: true })).rejects.toMatchObject({ code: 'DSH_HOST_UNAVAILABLE', reason: 'startup', instanceId: instance.id });
  expect(f.service.get(instance.id).status).toBe('failed');
  await expect(f.service.ensureHost('missing', undefined, { automatic: true })).rejects.toMatchObject({ reason: 'configuration', instanceId: 'missing' });
  await f.service.shutdown();
  await expect(f.service.ensureHost(instance.id)).rejects.toMatchObject({ reason: 'closing' });
  expect(f.manualStop).not.toHaveBeenCalled();
});
it('retains the real user environment and selects the native web profile in its user terminal', async () => {
  const f = await fixture(), instance = await f.service.create('Fish', 'runtime-a'); const selection = await f.service.prepareCli(instance.id);
  expect(selection.env.USERPROFILE).toBe(process.env.USERPROFILE); expect(selection.env.APPDATA).toBe(process.env.APPDATA);
  expect(selection.env.DSH_HOME).toBe(instance.homePath); expect(selection.nativeArgs).toEqual(['--profile', 'web']); expect(f.verify).not.toHaveBeenCalled();
});
it('backs up native data without dropping ordinary workspace directories and restores through native dependencies', async () => {
  const f = await fixture(), instance = await f.service.create('Fish', 'runtime-a');
  await f.service.ensureHost(instance.id); await f.service.stop(instance.id);
  await mkdir(path.join(instance.workspacePath, 'logs'), { recursive: true }); await writeFile(path.join(instance.workspacePath, 'logs/source.txt'), 'user data');
  const backup = path.join(f.root, 'backup'); await f.service.exportTo(instance.id, backup);
  const copy = await f.service.restoreFrom(backup, 'Restored');
  expect(await readFile(path.join(copy.workspacePath, 'logs/source.txt'), 'utf8')).toBe('user data');
  const commands = await readFile(path.join(copy.homePath, 'commands.log'), 'utf8'); expect(commands).toContain('plugin');
  await f.service.ensureHost(copy.id); await f.service.stop(copy.id);
  expect(JSON.parse(await readFile(path.join(f.root, 'native-instances.json'), 'utf8')).find((value: { id: string }) => value.id === copy.id).status).toBe('stopped');
});

const upgradeOperation = () => ({ id: 'fixture-upgrade', signal: new AbortController().signal, update: vi.fn(async () => undefined), log: vi.fn(async () => undefined) });
it('shares one user-configured Host, login and plugin data across all companions without allocating profiles', async () => {
  const f = await fixture(), base = await f.service.create('Default', 'runtime-a');
  const first = await Promise.all(Array.from({ length: 6 }, (_, index) => f.service.ensureCompanion(`partner-${index}`, '伙伴', base)));
  expect(new Set(first.map(value => value.id))).toEqual(new Set([base.id]));
  expect(f.service.list()).toHaveLength(1); expect(f.verify).not.toHaveBeenCalled();
  await writeFile(path.join(base.homePath, 'credentials.json'), 'existing login');
  const clients = await Promise.all(first.map(instance => f.service.ensureHost(instance.id)));
  expect(new Set(clients.map(value => value.pid)).size).toBe(1);
  expect(await readFile(path.join(f.service.companion('partner-new')!.homePath, 'credentials.json'), 'utf8')).toBe('existing login');
  expect(f.service.list()[0]!.companionId).toBeUndefined();
});
it('provisions a single shared instance from the explicitly selected version even for concurrent characters', async () => {
  const f = await fixture();
  const [fish, gpt] = await Promise.all([f.service.createCompanion('fish', '大肥鱼', 'runtime-b'), f.service.createCompanion('gpt', 'GPT', 'runtime-b')]);
  expect(fish.id).toBe(gpt.id); expect(f.service.list()).toHaveLength(1);
  expect(fish).toMatchObject({ name: '共享 DSH', runtimeId: 'runtime-b', isDefault: true, status: 'stopped' });
  expect(fish.companionId).toBeUndefined(); expect(f.verify).not.toHaveBeenCalled();
  await expect(f.service.createCompanion('fish', '大肥鱼', 'runtime-a')).rejects.toThrow('共享执行实例已经配置');
  await expect(f.service.createCompanion('gpt', 'GPT', 'missing-runtime')).rejects.toThrow('请选择');
  const restored = new InstanceService(f.serviceOptions); cleanup.unshift(() => restored.shutdown()); await restored.init();
  for (const id of ['fish', 'gpt', 'new-character']) expect(restored.companion(id)).toMatchObject({ id: fish.id, homePath: fish.homePath });
});
it('can select a legacy owned running instance as the shared default without claiming, copying or stopping its data', async () => {
  const f = await fixture(), previous = await f.service.create('我的 DSH', 'runtime-a');
  const legacy = await f.service.create('原大肥鱼环境', 'runtime-b', undefined, { companionId: 'fish', companionName: '大肥鱼', keepAlive: true });
  await writeFile(path.join(legacy.homePath, 'native-plugin.json'), 'custom native plugin configuration');
  await writeFile(path.join(legacy.homePath, 'credentials.json'), 'existing native API and login');
  const host = await f.service.ensureHost(legacy.id), release = f.service.acquireCompanionLease(legacy.id, 'task');
  const selected = await f.service.bindCompanion('gpt', 'GPT', legacy.id);
  expect(selected).toMatchObject({ id: legacy.id, companionId: 'fish', isDefault: true, browserPartition: legacy.browserPartition });
  expect(f.service.get(previous.id).isDefault).toBe(false);
  for (const id of ['gpt', 'fish', 'claude']) expect(f.service.companion(id)?.id).toBe(legacy.id);
  expect(await readFile(path.join(selected.homePath, 'credentials.json'), 'utf8')).toBe('existing native API and login');
  expect(await readFile(path.join(selected.homePath, 'native-plugin.json'), 'utf8')).toBe('custom native plugin configuration');
  expect(await f.service.recycleCompanionIfIdle(selected.id)).toBe(false); await host.health(); release();
  expect(f.service.list()).toHaveLength(2);
});
it('publishes a shared selection only after its durable commit and leaves the old selection on write failure', async () => {
  const f = await fixture(), before = await f.service.create('Default', 'runtime-a'), next = await f.service.create('Other', 'runtime-b');
  let release!: () => void; Reflect.set(f.service, 'writes', new Promise<void>(resolve => { release = resolve; }));
  const pending = f.service.bindCompanion('fish', '大肥鱼', next.id);
  await new Promise(resolve => setTimeout(resolve, 25)); expect(f.service.companion('fish')?.id).toBe(before.id);
  release(); await pending; expect(f.service.companion('fish')?.id).toBe(next.id);
  const registry = path.join(f.root, 'native-instances.json'), backup = path.join(f.root, 'registry-before.json');
  await rename(registry, backup); await mkdir(registry);
  await expect(f.service.selectExecutionInstance(before.id)).rejects.toThrow();
  expect(f.service.companion('fish')?.id).toBe(next.id); expect(f.service.list()).toHaveLength(2);
  await rm(registry, { recursive: true }); await rename(backup, registry);
  expect((await f.service.selectExecutionInstance(before.id)).id).toBe(before.id);
});
it('rechecks a queued shared selection after its target was removed before the registry commit', async () => {
  const f = await fixture(), before = await f.service.create('Default', 'runtime-a'), removed = await f.service.create('Remove concurrently', 'runtime-b');
  let release!: () => void; Reflect.set(f.service, 'writes', new Promise<void>(resolve => { release = resolve; }));
  const selection = f.service.selectExecutionInstance(removed.id), rejected = expect(selection).rejects.toThrow('not found');
  const removing = f.service.remove(removed.id);
  await vi.waitFor(() => expect(f.service.list().some(value => value.id === removed.id)).toBe(false));
  release(); await Promise.all([rejected, removing]);
  expect(f.service.executionInstance()?.id).toBe(before.id);
  const registry = JSON.parse(await readFile(path.join(f.root, 'native-instances.json'), 'utf8'));
  expect(registry).toHaveLength(1); expect(registry[0]).toMatchObject({ id: before.id, isDefault: true });
});
it('rejects a queued selection when its target entered an upgrade lock before commit', async () => {
  const f = await fixture(), before = await f.service.create('Default', 'runtime-a'), changing = await f.service.create('Upgrade concurrently', 'runtime-b');
  let release!: () => void; Reflect.set(f.service, 'writes', new Promise<void>(resolve => { release = resolve; }));
  const selection = f.service.selectExecutionInstance(changing.id), rejected = expect(selection).rejects.toThrow('busy');
  const busy = Reflect.get(f.service, 'busy') as Set<string>; busy.add(changing.id); release();
  await rejected; busy.delete(changing.id);
  expect(f.service.executionInstance()?.id).toBe(before.id);
  expect((await f.service.selectExecutionInstance(changing.id)).id).toBe(changing.id);
});
it('migrates private-only registries to one deterministic default without editing any legacy home', async () => {
  const f = await fixture();
  const legacy = await f.service.create('旧大肥鱼', 'runtime-a', undefined, { companionId: 'fish', companionName: '大肥鱼' });
  const other = await f.service.create('旧Claude', 'runtime-b', undefined, { companionId: 'claude', companionName: 'Claude' });
  await writeFile(path.join(legacy.homePath, 'credentials.json'), 'KEEP_AUTH');
  await writeFile(path.join(other.homePath, 'plugin.json'), 'KEEP_OTHER_PLUGIN');
  const restored = new InstanceService(f.serviceOptions); cleanup.unshift(() => restored.shutdown()); await restored.init();
  expect(restored.list().filter(value => value.isDefault)).toHaveLength(1);
  const chosen = [...restored.list()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0]!;
  expect(restored.companion('any')?.id).toBe(chosen.id);
  expect(restored.get(legacy.id).homePath).toBe(legacy.homePath); expect(restored.get(other.id).homePath).toBe(other.homePath);
  expect(await readFile(path.join(legacy.homePath, 'credentials.json'), 'utf8')).toBe('KEEP_AUTH');
  expect(await readFile(path.join(other.homePath, 'plugin.json'), 'utf8')).toBe('KEEP_OTHER_PLUGIN');
  expect(f.verify).not.toHaveBeenCalled();
});
it('preserves an existing default over all legacy owner and keep-alive metadata after restart', async () => {
  const f = await fixture(), shared = await f.service.create('Configured', 'runtime-a');
  await f.service.create('Old role', 'runtime-b', undefined, { companionId: 'fish', keepAlive: true });
  const restored = new InstanceService(f.serviceOptions); cleanup.unshift(() => restored.shutdown()); await restored.init();
  expect(restored.companion('fish')?.id).toBe(shared.id); expect(restored.companion('new')?.id).toBe(shared.id);
  expect(restored.list()).toHaveLength(2); expect(restored.list().filter(value => value.isDefault)).toHaveLength(1);
});
it('does not persist a new role environment when shutdown interrupts its uncommitted creation', async () => {
  const f = await fixture();
  let release!: () => void;
  Reflect.set(f.service, 'writes', new Promise<void>(resolve => { release = resolve; }));
  const creating = f.service.createCompanion('fish', '大肥鱼', 'runtime-a');
  const rejected = expect(creating).rejects.toThrow('closing');
  const closing = f.service.shutdown(); release(); await Promise.all([closing, rejected]);
  expect(f.service.list()).toHaveLength(0); expect(await readdir(path.join(f.root, 'instances'))).toHaveLength(0);
});
it('recycles only private environments with no leases and a complete native idle proof', async () => {
  const f = await fixture(), base = await f.service.create('Default', 'runtime-a'), own = await f.service.create('Legacy role', base.runtimeId, undefined, { companionId: 'partner-a', keepAlive: false });
  const client = await f.service.ensureHost(own.id), release = f.service.acquireCompanionLease(own.id, 'task');
  expect(await f.service.recycleCompanionIfIdle(own.id)).toBe(false); release(); release();
  const proof = { known: true, idle: true, activeTurns: 0, backgroundJobs: 0, pendingQuestions: 0, pendingInbox: 0, settling: 0, activeSubagents: 0 };
  for (const key of ['activeTurns', 'backgroundJobs', 'pendingQuestions', 'pendingInbox', 'settling', 'activeSubagents']) {
    await writeFile(path.join(own.homePath, 'idle-state.json'), JSON.stringify({ ...proof, [key]: 1 }));
    expect(await f.service.recycleCompanionIfIdle(own.id)).toBe(false); await client.health();
  }
  await writeFile(path.join(own.homePath, 'idle-state.json'), JSON.stringify({ idle: true }));
  expect(await f.service.recycleCompanionIfIdle(own.id)).toBe(false);
  await rm(path.join(own.homePath, 'idle-state.json')); expect(await f.service.recycleCompanionIfIdle(own.id)).toBe(true);
  expect(f.service.get(own.id).status).toBe('stopped');
  const shared = await f.service.ensureHost(base.id); expect(await f.service.recycleCompanionIfIdle(base.id)).toBe(false); await shared.health();
  await f.service.configureCompanion(own.id, true); expect(await f.service.recycleCompanionIfIdle(own.id)).toBe(false);
  await f.service.stop(own.id); expect(f.service.get(own.id)).toMatchObject({ status: 'stopped', keepAlive: true });
});
it('rejects an idle proof if another use arrived while the native check was in flight', async () => {
  const f = await fixture(), base = await f.service.create('Default', 'runtime-a'), own = await f.service.create('Legacy role', base.runtimeId, undefined, { companionId: 'partner-a', keepAlive: false });
  const client = await f.service.ensureHost(own.id), original = client.request.bind(client);
  let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
  vi.spyOn(client, 'request').mockImplementation(async <T>(endpoint: string, input?: unknown, signal?: AbortSignal, timeout?: number): Promise<T> => {
    if (endpoint === '/idle') await gate;
    return original<T>(endpoint, input, signal, timeout);
  });
  const recycling = f.service.recycleCompanionIfIdle(own.id);
  const release = f.service.acquireCompanionLease(own.id, 'question'); resume();
  expect(await recycling).toBe(false); await client.health(); release();
});
it('does not revive an explicitly stopped companion when an automatic plugin restart was already shutting down', async () => {
  const f = await fixture(), base = await f.service.create('Default', 'runtime-a'), own = await f.service.create('Legacy role', base.runtimeId, undefined, { companionId: 'partner-a', keepAlive: false });
  await f.service.ensureHost(own.id); await f.service.recordPluginChange(own.id, { application: 'restart-required' });
  const stop = f.service.stop.bind(f.service); let released!: () => void, waiting!: () => void;
  const gate = new Promise<void>(resolve => { released = resolve; }), reached = new Promise<void>(resolve => { waiting = resolve; });
  let intercepted = false;
  vi.spyOn(f.service, 'stop').mockImplementation(async (id, options) => {
    await stop(id, options);
    if (options?.automatic && !intercepted) { intercepted = true; waiting(); await gate; }
  });
  const restart = f.service.recycleCompanionIfIdle(own.id); await reached;
  await f.service.stop(own.id); released(); expect(await restart).toBe(true);
  expect(f.service.get(own.id).status).toBe('stopped'); expect(f.verify).toHaveBeenCalledTimes(1);
  await f.service.ensureHost(own.id); expect(f.service.get(own.id).status).toBe('running');
});
it('reclaims the least recently used idle private Host before warming a fourth environment', async () => {
  const f = await fixture(), base = await f.service.create('Default', 'runtime-a'), own = [];
  for (let index = 0; index < 4; index++) own.push(await f.service.create(`Legacy ${index}`, base.runtimeId, undefined, { companionId: `partner-${index}`, keepAlive: false }));
  await f.service.ensureHost(own[0]!.id); await f.service.ensureHost(own[1]!.id); await f.service.ensureHost(own[2]!.id);
  // The old first Host was used again; the second is now the oldest cache entry.
  await f.service.ensureHost(own[0]!.id); await f.service.ensureHost(own[3]!.id);
  expect(f.service.get(own[1]!.id).status).toBe('stopped');
  for (const index of [0, 2, 3]) expect(f.service.get(own[index]!.id).status).toBe('running');
});
it('treats the private Host cache size as a soft target and never kills held work to admit another authorized request', async () => {
  const f = await fixture(), base = await f.service.create('Default', 'runtime-a'), own = [], releases = [];
  for (let index = 0; index < 4; index++) own.push(await f.service.create(`Legacy ${index}`, base.runtimeId, undefined, { companionId: `partner-${index}`, keepAlive: false }));
  for (const instance of own.slice(0, 3)) { await f.service.ensureHost(instance.id); releases.push(f.service.acquireCompanionLease(instance.id, 'task')); }
  await f.service.ensureHost(own[3]!.id);
  expect(own.map(instance => f.service.get(instance.id).status)).toEqual(['running', 'running', 'running', 'running']);
  for (const release of releases) release();
});
it('upgrades the selected shared instance through launcher IPC while preserving login, plugins, Sessions and workspace', async () => {
  const f = await fixture(), base = await f.service.create('Default', 'runtime-a');
  const selected = await f.service.create('用户预先配置的环境', 'runtime-a');
  const own = await f.service.bindCompanion('partner-a', '甲', selected.id);
  await f.service.ensureHost(own.id);
  const data = ['profiles/web/credentials.json', 'profiles/web/private-plugin.json', 'profiles/web/pnpm-lock.yaml', 'sessions/session-1.json', 'attachments/picture.png', 'storages/qq/message.json'];
  for (const relative of data) { const target = path.join(own.homePath, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, relative); }
  await writeFile(path.join(own.agentsPath, 'agent.json'), 'agent-settings'); await writeFile(path.join(own.workspacePath, 'result.txt'), 'work');
  const skill = path.join(own.agentsPath, 'skills', 'private-research', 'SKILL.md'); await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, '# Only this companion\nNative skill configuration.');
  const upgrade = await f.service.handle({ type: 'instance.upgrade', instanceId: own.id, runtimeId: 'runtime-b' });
  expect(upgrade.ok).toBe(true); await f.operations.settle();
  expect(f.operations.list().find(operation => operation.id === (upgrade.ok ? upgrade.operationId : undefined))?.status).toBe('succeeded');
  expect(f.service.get(own.id)).toMatchObject({ id: own.id, isDefault: true, runtimeId: 'runtime-b', homePath: own.homePath, browserPartition: own.browserPartition });
  for (const relative of data) expect(await readFile(path.join(own.homePath, relative), 'utf8')).toBe(relative);
  expect(await readFile(path.join(own.agentsPath, 'agent.json'), 'utf8')).toBe('agent-settings');
  expect(await readFile(path.join(own.workspacePath, 'result.txt'), 'utf8')).toBe('work');
  expect(await readFile(skill, 'utf8')).toBe('# Only this companion\nNative skill configuration.');
  expect(await (await f.service.ensureHost(own.id)).request('/health')).toMatchObject({ version: '0.2.1', home: own.homePath });
  expect(f.service.snapshots()).toHaveLength(1); expect(f.service.snapshots()[0]!.runtimeId).toBe('runtime-a');
  expect(f.service.get(base.id).runtimeId).toBe('runtime-a');
});
it('blocks upgrades during active use and rolls a failed native migration back to original bytes and runtime', async () => {
  const f = await fixture(), base = await f.service.create('Default', 'runtime-a'), own = await f.service.ensureCompanion('partner-a', '甲', base);
  await f.service.ensureHost(own.id);
  const release = f.service.acquireCompanionLease(own.id, 'background');
  await expect(f.service.upgradeCompanion(own.id, 'runtime-b', upgradeOperation())).rejects.toThrow('仍在使用'); release();
  await writeFile(path.join(own.homePath, 'migration-data.txt'), 'original plugin state'); await writeFile(path.join(own.homePath, 'fail-version'), '0.2.1');
  await expect(f.service.upgradeCompanion(own.id, 'runtime-b', upgradeOperation())).rejects.toThrow();
  expect(f.service.get(own.id)).toMatchObject({ runtimeId: 'runtime-a', status: 'stopped', homePath: own.homePath });
  expect(await readFile(path.join(own.homePath, 'migration-data.txt'), 'utf8')).toBe('original plugin state');
  expect(await (await f.service.ensureHost(own.id)).request('/health')).toMatchObject({ version: '0.2.0' });
});
it('recovers an interrupted upgrade from its verified snapshot while retaining the durable companion identity', async () => {
  const f = await fixture(), base = await f.service.create('Default', 'runtime-a'), own = await f.service.ensureCompanion('partner-a', '甲', base);
  await writeFile(path.join(own.homePath, 'plugin-state.json'), 'before upgrade');
  await f.service.upgradeCompanion(own.id, 'runtime-b', upgradeOperation()); await f.service.shutdown();
  await writeFile(path.join(own.homePath, 'plugin-state.json'), 'interrupted migration');
  await writeFile(path.join(f.service.getRoot(own.id), 'upgrade.json'), JSON.stringify({ format: 'worldlinebox-dsh-upgrade-v1', previousRuntimeId: 'runtime-a', snapshotId: f.service.snapshots()[0]!.id }));
  const restored = new InstanceService(f.serviceOptions); cleanup.unshift(() => restored.shutdown()); await restored.init();
  expect(restored.companion('partner-a')).toMatchObject({ id: own.id, runtimeId: 'runtime-a', status: 'stopped', homePath: own.homePath });
  expect(await readFile(path.join(own.homePath, 'plugin-state.json'), 'utf8')).toBe('before upgrade');
  expect((await restored.ensureCompanion('partner-a', '甲', base)).id).toBe(own.id);
  expect(restored.list()).toHaveLength(1);
});
