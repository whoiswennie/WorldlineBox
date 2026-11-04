import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
if(req.url==='/shutdown'){res.end('{}');setTimeout(()=>process.emit('SIGTERM'),5);return;}
res.setHeader('content-type','application/json');res.end(JSON.stringify({protocol:'worldlinebox-native-web-host-v1',pid:process.pid,userProfile:process.env.USERPROFILE,home:process.env.DSH_HOME,version:process.env.FIXTURE_VERSION}));});
server.listen(0,'127.0.0.1',()=>{console.log('dsh web: http://127.0.0.1:'+server.address().port+'/?fixture');console.log('WORLDLINEBOX_DSH_BRIDGE_READY '+server.address().port);});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));}
`);
  const runtimes = ['runtime-a', 'runtime-b'].map((id, index) => dshRuntimeSchema.parse({ id, version: `0.2.${index}`, nodeVersion: TEST_NODE_VERSION,
    platform: 'win32-x64', adapter: 'node-cli-web-v1', source: 'fixture', sourceSha256: String(index).repeat(64), contentSha256: String(index).repeat(64), installedAt: '', fileCount: 0, byteLength: 0 }));
  const verify = vi.fn(async () => undefined), openWorkbench = vi.fn(async () => undefined), startup = vi.fn();
  const readyGate = path.join(root, 'token-exchange-released');
  const operations = new OperationStore(path.join(root, 'operations'), () => undefined); await operations.init();
  const service = new InstanceService({ rootPath: root, bridgePackagePath: path.resolve('resources/dsh-bridge'), operations,
    runtimes: { list: () => runtimes, get: id => runtimes.find(value => value.id === id)!, directory: () => program,
      plan: id => ({ executable: TEST_NODE_EXECUTABLE, cli, env: { FIXTURE_VERSION: runtimes.find(value => value.id === id)!.version, ...(holdTokenExchange ? { FIXTURE_READY_GATE: readyGate } : {}) } }), verify },
    onChanged: () => undefined, onStartup: startup, openWorkbench, closeWorkbench: async () => undefined, clearBrowserData: async () => undefined });
  await service.init(); cleanup.push(async () => { await service.shutdown(); await operations.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { service, operations, root, verify, openWorkbench, startup, readyGate };
}
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
