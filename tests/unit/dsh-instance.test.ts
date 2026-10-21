import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DshRuntime, DshLauncherRequest } from '../../src/shared/dsh-launcher';
import { InstanceService, type RuntimeServiceLike } from '../../src/main/dsh/instance-service';
import { OperationStore } from '../../src/main/dsh/operations';
import { extractSealedArchive, writeSealedArchive } from '../../src/main/dsh/archive';
import { auditInstanceConfiguration, rebaseInstanceConfiguration } from '../../src/main/dsh/instance-configuration';
import { instanceEnvironment, parseReadyUrl, sanitizeOutput } from '../../src/main/dsh/instance-process';
import { inspectProcess, launchCli, terminateOwnedProcess } from '../../src/main/dsh/instance-process';

const directories: string[] = [];
const services: InstanceService[] = [];
const fixture = `
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const home = process.env.DSH_HOME;
fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive:true });
if (process.argv.includes('plugin')) {
  fs.writeFileSync(path.join(home,'profiles','web','plugins.json'), JSON.stringify(process.argv.slice(2)));
  console.log('fixture-plugin: '+process.argv.slice(2).join(' '));
} else if(fs.existsSync(path.join(home,'hang-start'))) {
  setInterval(()=>{},1000);
} else {
  fs.writeFileSync(path.join(home,'environment.json'), JSON.stringify({home,agents:process.env.DSH_AGENTS_HOME,user:process.env.USERPROFILE,appdata:process.env.APPDATA,store:process.env.npm_config_store_dir,cwd:process.cwd()}));
  const token='private-fixture-token';
  const server = http.createServer((request,response) => {
    if(request.url === '/?'+token){ response.writeHead(303, {Location:'./','Set-Cookie':'fixture-session=private; HttpOnly; SameSite=Strict'}); response.end(); }
    else { response.writeHead(401); response.end(); }
  });
  server.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+server.address().port+'/?'+token));
}
`;

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-dsh-instance-')); directories.push(root);
  const runtimeDirectory = path.join(root, 'program'); await mkdir(runtimeDirectory);
  const cli = path.join(runtimeDirectory, 'fixture.cjs'); await writeFile(cli, fixture);
  const records: DshRuntime[] = ['first', 'second'].map((id, index) => ({
    id, version: `0.${index}.0`, nodeVersion: process.version, electronVersion: 'test', platform: 'win32-x64', adapter: 'desktop-cli-web-v1',
    source: 'test', sourceSha256: 'a'.repeat(64), contentSha256: String(index + 1).repeat(64), installedAt: new Date().toISOString(), fileCount: 1, byteLength: fixture.length,
  }));
  const runtimes: RuntimeServiceLike = {
    list: () => records, get: id => { const record = records.find(value => value.id === id); if (!record) throw new Error('Missing runtime'); return record; },
    directory: () => runtimeDirectory, plan: () => ({ executable: process.execPath, cli, env: {} }), verify: async () => undefined,
  };
  const operationRoot = path.join(root, 'operations'); await mkdir(operationRoot);
  const operations = new OperationStore(operationRoot, () => undefined); await operations.init();
  const openWorkbench = vi.fn(async () => undefined); const closeWorkbench = vi.fn(async () => undefined);
  const clearBrowserData = vi.fn(async () => undefined);
  const service = new InstanceService({ rootPath: root, runtimes, operations, onChanged: () => undefined, openWorkbench, closeWorkbench, clearBrowserData });
  await service.init(); services.push(service);
  const request = async (input: DshLauncherRequest) => {
    const response = await service.handle(input);
    expect(response.ok).toBe(true); await operations.settle();
    const operation = operations.list()[0];
    if ('operationId' in response && response.operationId) expect(operation?.error, JSON.stringify(operation)).toBeUndefined();
    return response;
  };
  return { root, service, runtimes, operations, openWorkbench, closeWorkbench, clearBrowserData, request };
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('DSH isolated instance management', () => {
  it('releases the starting state when cancelled during the last journal write before native spawn', async () => {
    const { service, operations, request } = await setup();
    const instance = await service.create('Cancel adapter preparation', 'first');
    const run = operations.run.bind(operations);
    const intercepted = vi.spyOn(operations, 'run').mockImplementation((kind, label, id, work, retry) => run(kind, label, id, op => work({ ...op,
      update: async (phase, progress) => { await op.update(phase, progress); if (phase === 'Preparing native Host adapters') operations.cancel(op.id); },
    }), retry));
    const response = await service.handle({ type: 'instance.start', instanceId: instance.id });
    expect(response.ok).toBe(true); await operations.settle(); intercepted.mockRestore();
    expect(operations.list()[0]?.status).toBe('cancelled');
    expect(service.get(instance.id).status).toBe('failed');
    expect(service.get(instance.id).pid).toBeUndefined();
    await request({ type: 'instance.start', instanceId: instance.id });
    expect(service.get(instance.id).status).toBe('running');
    await request({ type: 'instance.stop', instanceId: instance.id });
  });

  it('reports elapsed integrity admission time and cancels before spawning a Host, then permits retry', async () => {
    const { service, runtimes, operations, root, request } = await setup();
    const instance = await service.create('Slow verification', 'first');
    const original = runtimes.verify;
    runtimes.verify = async (_id, signal) => new Promise<void>((_resolve, reject) => {
      if (!signal) throw Error('Verification must receive the caller signal');
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (signal.aborted) reject(signal.reason);
    });
    const response = await service.handle({ type: 'instance.start', instanceId: instance.id });
    if (!response.ok || !response.operationId) throw Error('Missing start operation');
    await vi.waitFor(() => expect(operations.list()[0]?.phase).toMatch(/^Verifying fixed runtime · \d+s$/u), { timeout: 8000, interval: 50 });
    expect(operations.list()[0]?.progress).toBe(5);
    expect(service.get(instance.id).pid).toBeUndefined();
    operations.cancel(response.operationId); await operations.settle();
    expect(operations.list()[0]?.status).toBe('cancelled');
    const log = await readFile(path.join(root, 'operations', response.operationId + '.log'), 'utf8');
    expect(log).not.toContain('Starting isolated Harness Host');
    runtimes.verify = original;
    await request({ type: 'instance.start', instanceId: instance.id });
    expect(service.get(instance.id).status).toBe('running');
    await request({ type: 'instance.stop', instanceId: instance.id });
    expect(operations.list().every(operation => operation.status !== 'running')).toBe(true);
  }, 20000);

  it('keeps isolated instances, refuses a second WebUI, and explicitly switches without leaving the old Host alive', async () => {
    const { service, request, openWorkbench, operations } = await setup();
    const a = await service.create('A', 'first'); const b = await service.create('B', 'first');
    await request({ type: 'instance.start', instanceId: a.id });
    const oldPid = service.get(a.id).pid!;
    const oldUrl = service.getUrl(a.id);
    await request({ type: 'instance.open', instanceId: a.id });
    expect(service.get(a.id).pid).toBe(oldPid); expect(service.getUrl(a.id)).toBe(oldUrl);
    expect(openWorkbench).toHaveBeenLastCalledWith(expect.objectContaining({ id: a.id, pid: oldPid }), oldUrl);
    const blocked = await service.handle({ type: 'instance.start', instanceId: b.id });
    expect(blocked.ok).toBe(true); await operations.settle();
    expect(operations.list()[0]?.error).toContain('Only one DSH WebUI');
    expect(service.get(a.id).status).toBe('running'); expect(service.get(b.id).status).toBe('stopped');
    await request({ type: 'instance.switch-start', instanceId: b.id });
    expect(service.get(a.id).status).toBe('stopped'); expect(service.get(b.id).status).toBe('running');
    expect(await inspectProcess(oldPid)).toBeUndefined();
    expect(a.browserPartition).not.toBe(b.browserPartition); expect(openWorkbench).toHaveBeenCalledTimes(3);
    const envA = JSON.parse(await readFile(path.join(a.homePath, 'environment.json'), 'utf8')) as Record<string, string>;
    const envB = JSON.parse(await readFile(path.join(b.homePath, 'environment.json'), 'utf8')) as Record<string, string>;
    for (const key of Object.keys(envA)) expect(envA[key]).not.toBe(envB[key]);
    await writeFile(path.join(a.homePath, 'private-session.json'), '{"owner":"A"}');
    await expect(readFile(path.join(b.homePath, 'private-session.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const logs = await service.handle({ type: 'instance.logs', instanceId: a.id });
    expect(logs.ok && logs.text).toContain('[redacted]'); expect(logs.ok && logs.text).not.toContain('private-fixture-token');
    await request({ type: 'instance.stop', instanceId: b.id });
    expect(service.get(b.id).status).toBe('stopped');
  }, 40_000);

  it('clones and changes runtime only in a stopped copy, preserving data and rebasing explicit configuration paths', async () => {
    const { service, request } = await setup();
    const source = await service.create('Original', 'first');
    await writeFile(path.join(source.homePath, 'config.json'), JSON.stringify({ agentsHome: source.agentsPath, storageRoot: path.join(source.homePath, 'storages') }));
    await writeFile(path.join(source.workspacePath, 'work.txt'), 'user workspace');
    await mkdir(path.join(source.homePath, 'sessions')); await writeFile(path.join(source.homePath, 'sessions', 'one.jsonl'), 'session');
    await mkdir(path.join(source.homePath, 'logs')); await writeFile(path.join(source.homePath, 'logs', 'raw.log'), 'secret logs');
    await request({ type: 'instance.clone', instanceId: source.id, name: 'Upgrade copy', runtimeId: 'second' });
    const cloned = service.list().find(value => value.id !== source.id)!;
    expect(cloned.runtimeId).toBe('second'); expect(service.get(source.id).runtimeId).toBe('first'); expect(cloned.parentInstanceId).toBe(source.id);
    expect(await readFile(path.join(cloned.workspacePath, 'work.txt'), 'utf8')).toBe('user workspace');
    expect(await readFile(path.join(cloned.homePath, 'sessions', 'one.jsonl'), 'utf8')).toBe('session');
    expect(await readFile(path.join(cloned.homePath, 'config.json'), 'utf8')).toContain(cloned.agentsPath.replaceAll('\\', '\\\\'));
    await expect(readFile(path.join(cloned.homePath, 'logs', 'raw.log'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path.join(cloned.workspacePath, 'work.txt'), 'new copy');
    expect(await readFile(path.join(source.workspacePath, 'work.txt'), 'utf8')).toBe('user workspace');
  });

  it('seals snapshot contents, restores a new identity, and refuses tampered backups without altering the original', async () => {
    const { service, root, request } = await setup(); const source = await service.create('Original', 'first');
    await writeFile(path.join(source.homePath, 'settings.json'), '{"theme":"original"}');
    await writeFile(path.join(source.agentsPath, 'skill.md'), 'private skill');
    await writeFile(path.join(service.getRoot(source.id), 'user', 'tool-state.json'), '{"tool":"private"}');
    await request({ type: 'snapshot.create', instanceId: source.id, name: 'Before update' });
    const snapshot = service.snapshots()[0]!;
    await writeFile(path.join(source.homePath, 'settings.json'), '{"theme":"changed"}');
    await request({ type: 'snapshot.restore', snapshotId: snapshot.id, name: 'Restored' });
    const restored = service.list().find(value => value.id !== source.id)!;
    expect(await readFile(path.join(restored.homePath, 'settings.json'), 'utf8')).toBe('{"theme":"original"}');
    expect(await readFile(path.join(service.getRoot(restored.id), 'user', 'tool-state.json'), 'utf8')).toBe('{"tool":"private"}');
    expect(await readFile(path.join(source.homePath, 'settings.json'), 'utf8')).toBe('{"theme":"changed"}');
    const backupRoot = path.join(root, 'snapshots', snapshot.id);
    await writeFile(path.join(backupRoot, 'data', 'agents', 'skill.md'), 'tampered');
    await expect(service.restoreFrom(backupRoot, 'Rejected')).rejects.toThrow('sealed file inventory');
    expect(service.list()).toHaveLength(2);
  });

  it('serializes mutation operations and rejects running-data copies or unmanaged links', async () => {
    const { service, request, root } = await setup(); const source = await service.create('Original', 'first');
    await request({ type: 'instance.start', instanceId: source.id });
    expect(await service.handle({ type: 'instance.clone', instanceId: source.id, name: 'Unsafe' })).toMatchObject({ ok: false });
    await request({ type: 'instance.stop', instanceId: source.id });
    let release!: () => void;
    const holding = service.withStoppedInstance(source.id, async () => { await new Promise<void>(resolve => { release = resolve; }); });
    expect(await service.handle({ type: 'instance.plugin', instanceId: source.id, action: 'add', spec: 'example@1.0.0' })).toMatchObject({ ok: false });
    release(); await holding;
    const external = path.join(root, 'external'); await mkdir(external); await writeFile(path.join(external, 'secret'), 'external');
    await symlink(external, path.join(source.workspacePath, 'external'), 'junction');
    await expect(service.exportTo(source.id, path.join(root, 'backup'))).rejects.toThrow('external path');
  }, 30_000);

  it('round trips a completely empty new instance through the archive format, recreating omitted empty directories', async () => {
    const { service, root } = await setup(); const source = await service.create('Empty', 'first');
    const exportRoot = path.join(root, 'backup-export'); await service.exportTo(source.id, exportRoot);
    const archive = path.join(root, 'empty.dshbackup'); await writeSealedArchive(exportRoot, archive, { kind: 'worldlinebox-dshbackup-v1' });
    const extracted = path.join(root, 'backup-extracted'); await extractSealedArchive(archive, extracted);
    const restored = await service.restoreFrom(extracted, 'Empty restored');
    expect(restored.id).not.toBe(source.id); expect(restored.runtimeId).toBe(source.runtimeId);
    await service.withStoppedInstance(restored.id, async () => undefined);
    await writeFile(path.join(restored.agentsPath, 'new-skill.md'), 'new');
    await expect(readFile(path.join(source.agentsPath, 'new-skill.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the fixed CLI for per-instance plugin operations and keeps profile changes in their own Home', async () => {
    const { service, request } = await setup(); const a = await service.create('A', 'first'); const b = await service.create('B', 'first');
    await request({ type: 'instance.plugin', instanceId: a.id, action: 'add', spec: '@test/plugin@1.2.3' });
    const args = JSON.parse(await readFile(path.join(a.homePath, 'profiles', 'web', 'plugins.json'), 'utf8'));
    expect(args).toEqual(['plugin', '--profile', 'web', 'add', '@test/plugin@1.2.3', '--save-exact']);
    await expect(readFile(path.join(b.homePath, 'profiles', 'web', 'plugins.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await request({ type: 'instance.plugin', instanceId: a.id, action: 'list' });
    expect(JSON.parse(await readFile(path.join(a.homePath, 'profiles', 'web', 'plugins.json'), 'utf8'))).toEqual(['plugin', '--profile', 'web', 'list', '--depth', '0']);
  }, 30_000);

  it('cancels a Host which never becomes ready and releases the instance for another operation', async () => {
    const { service, operations } = await setup(); const instance = await service.create('No readiness', 'first');
    await writeFile(path.join(instance.homePath, 'hang-start'), 'test');
    const response = await service.handle({ type: 'instance.start', instanceId: instance.id });
    if (!response.ok || !response.operationId) throw new Error('Missing start operation.');
    await vi.waitFor(() => expect(service.get(instance.id).pid).toBeGreaterThan(0), { timeout: 10_000 });
    await vi.waitFor(() => expect(operations.list()[0]?.phase).toMatch(/Loading native plugins/u));
    await vi.waitFor(() => expect(operations.list()[0]?.phase).toMatch(/· \d+s/u), { timeout: 8000 });
    operations.cancel(response.operationId); await operations.settle();
    expect(operations.list()[0]?.status).toBe('cancelled');
    expect(service.get(instance.id).status).toBe('failed'); expect(service.getUrl(instance.id)).toBeUndefined();
    const log = await readFile(path.join(service.getRoot(instance.id), '../../operations', response.operationId + '.log'), 'utf8');
    expect(log).toContain('Host startup timing:'); expect(log).not.toContain('private-fixture-token');
    await service.withStoppedInstance(instance.id, async () => undefined);
  }, 30_000);

  it('recovers only an interrupted process whose executable, command line and creation identity match its journal', async () => {
    if (process.platform !== 'win32') return;
    const { service, root, runtimes, operations, openWorkbench, closeWorkbench, clearBrowserData } = await setup();
    const instance = await service.create('Interrupted', 'first');
    const plan = runtimes.plan(instance.runtimeId); const env = await instanceEnvironment(service.getRoot(instance.id), instance, plan);
    const orphan = await launchCli(plan, ['web', '--no-open', '--port', '0'], env, instance.workspacePath);
    try {
      if (!orphan.pid) throw new Error('Missing fixture PID.');
      const identity = await inspectProcess(orphan.pid); expect(identity).toBeDefined();
      await writeFile(path.join(service.getRoot(instance.id), 'process.json'), JSON.stringify({ pid: orphan.pid, executable: plan.executable, cli: plan.cli, createdAt: identity!.createdAt }));
      await writeFile(path.join(root, 'instances.json'), JSON.stringify([{ ...instance, status: 'running', pid: orphan.pid }]));
      const restored = new InstanceService({ rootPath: root, runtimes, operations, onChanged: () => undefined, openWorkbench, closeWorkbench, clearBrowserData });
      await restored.init(); services.push(restored);
      expect(await inspectProcess(orphan.pid)).toBeUndefined();
      expect(restored.get(instance.id).status).toBe('failed');
      await restored.withStoppedInstance(instance.id, async () => undefined);
      await expect(readFile(path.join(service.getRoot(instance.id), 'process.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await terminateOwnedProcess(orphan); }
  }, 30_000);
});

describe('DSH isolation guards', () => {
  it('rejects explicit shared data roots while allowing its own roots and immutable bundled skill references', () => {
    const root = path.resolve('isolated-instance'); const runtime = path.resolve('fixed-runtime'); const external = path.resolve('shared-data');
    expect(() => auditInstanceConfiguration(JSON.stringify({ plugin: { agentsHome: external } }), 'config.json', root, runtime)).toThrow('outside');
    expect(() => auditInstanceConfiguration(`storage-json:\n  root: '${external}'`, 'cordis.patch.yml', root, runtime)).toThrow('outside');
    expect(() => auditInstanceConfiguration(`storage-json:\n  root: '${runtime}'`, 'cordis.patch.yml', root, runtime)).toThrow('outside');
    expect(() => auditInstanceConfiguration('customRoots:\n  - ../../other-instance', 'cordis.patch.yml', root, runtime)).toThrow('escapes');
    expect(() => auditInstanceConfiguration(`storage-json: { root: '${external}' }`, 'cordis.patch.yml', root, runtime)).toThrow('outside');
    expect(() => auditInstanceConfiguration(`agentsHome: >-\n  ${external}`, 'cordis.patch.yml', root, runtime)).toThrow('outside');
    expect(() => auditInstanceConfiguration(`shared: &shared '${external}'\nstorage-json: { root: *shared }`, 'cordis.patch.yml', root, runtime)).toThrow('outside');
    expect(() => auditInstanceConfiguration('config: &self\n  nested: *self', 'cordis.patch.yml', root, runtime)).toThrow('recursive aliases');
    expect(() => auditInstanceConfiguration('agentsHome: !!js/function "function () { throw new Error(\'Executed\') }"', 'cordis.patch.yml', root, runtime)).not.toThrow();
    expect(() => auditInstanceConfiguration(JSON.stringify({ agentsHome: path.join(root, 'agents'), bundledSkillDir: path.join(runtime, 'skills') }), 'config.json', root, runtime)).not.toThrow();
    expect(() => auditInstanceConfiguration('agentsHome: ${HOME}/../another-instance', 'config.yml', root, runtime)).not.toThrow();
    const json = JSON.stringify({ agentsHome: 'C:\\old\\instance\\agents' });
    expect(JSON.parse(rebaseInstanceConfiguration(json, 'C:\\old\\instance', 'C:\\new\\instance')).agentsHome).toBe('C:\\new\\instance\\agents');
  });

  it('removes inherited boot controls and assigns private package-manager stores', async () => {
    const { service } = await setup(); const instance = await service.create('A', 'first');
    const env = await instanceEnvironment(service.getRoot(instance.id), instance, service.launchPlan(instance.id));
    expect(env.DSH_HOME).toBe(instance.homePath); expect(env.DSH_AGENTS_HOME).toBe(instance.agentsPath);
    expect(env.USERPROFILE).toBe(path.join(service.getRoot(instance.id), 'user'));
    expect(env.APPDATA).not.toBe(process.env.APPDATA); expect(env.LOCALAPPDATA).not.toBe(process.env.LOCALAPPDATA);
    expect(env.npm_config_store_dir).toBe(path.join(service.getRoot(instance.id), 'cache', 'pnpm-store'));
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(parseReadyUrl('dsh web: http://127.0.0.1:2345/?secret')).toBe('http://127.0.0.1:2345/?secret');
    expect(parseReadyUrl('dsh web: https://external.example/?secret')).toBeUndefined();
    expect(sanitizeOutput('dsh web: http://127.0.0.1:2345/?secret\napiKey=private')).not.toContain('secret');
    expect(sanitizeOutput('apiKey=private')).not.toContain('private');
  });
});
