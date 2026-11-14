import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DshLauncher } from '../../src/main/dsh/launcher';
import type { InstanceService } from '../../src/main/dsh/instance-service';
import type { RuntimeService } from '../../src/main/dsh/runtime-service';
import type { OperationStore } from '../../src/main/dsh/operations';
import type { LauncherNetwork } from '../../src/main/dsh/launcher-network';
import { canonicalRuntimeEntryPaths } from '../../src/main/dsh/runtime-paths';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { dshRuntimeSchema, type DshInstance, type DshLauncherRequest, type DshLauncherResponse } from '../../src/shared/dsh-launcher';
import { removeAcceptanceRoot } from '../../scripts/bot-acceptance-cleanup-lib.mjs';

const environment = vi.hoisted(() => ({ userData: '', clearedPartitions: [] as string[] }));
vi.mock('electron', () => ({
  app: { getPath: () => environment.userData, getAppPath: () => process.cwd(), isPackaged: false },
  BrowserWindow: class {}, dialog: {}, ipcMain: {}, shell: {}, net: {}, nativeImage: {},
  session: { fromPartition: (partition: string) => ({ clearStorageData: async () => { environment.clearedPartitions.push(partition); } }) },
}));
afterEach(() => { vi.restoreAllMocks(); });

/** Preserve the real DshLauncher -> InstanceService -> OperationStore wiring.
 * Only Electron chrome, unrelated network/catalogue initialization, the source
 * runtime catalogue and the model completion transport are fixture adapters.
 * Native Hosts, Sessions, write tools, stop and delete operations are genuine. */
it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('creates a shared instance, uses it from a companion, stops and deletes it through launcher operations while retaining the running sibling', async () => {
  const program = path.resolve(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!), manifest = JSON.parse(await readFile(path.join(program, 'dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
  const runtime = dshRuntimeSchema.parse({ id: 'runtime-native-delete-acceptance', version: manifest.version, nodeVersion: '24', platform: 'win32-x64',
    adapter: 'node-cli-web-v1', source: program, sourceSha256: '0'.repeat(64), contentSha256: '0'.repeat(64), installedAt: new Date().toISOString(), fileCount: 0, byteLength: 0 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-real-'));
  environment.userData = path.join(root, 'electron-profile'); environment.clearedPartitions = [];
  await mkdir(environment.userData); await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'native-delete-fixture', ownerPid: process.pid }));
  vi.spyOn(DshLauncher.prototype as unknown as { init(): Promise<void> }, 'init').mockResolvedValue();
  const launcher = new DshLauncher(() => undefined), service = Reflect.get(launcher, 'instances') as InstanceService,
    operations = Reflect.get(launcher, 'operations') as OperationStore, runtimes = Reflect.get(launcher, 'runtimes') as RuntimeService;
  vi.spyOn(Reflect.get(launcher, 'network') as LauncherNetwork, 'environment').mockImplementation(async base => ({ ...base }));
  // Keep the production constructor's external-operation callback. Replacing
  // InstanceService or this callback would miss the self-occupancy regression.
  vi.spyOn(runtimes, 'list').mockReturnValue([runtime]); vi.spyOn(runtimes, 'get').mockImplementation(id => { if (id !== runtime.id) throw Error('Unknown fixture runtime'); return runtime; });
  vi.spyOn(runtimes, 'directory').mockReturnValue(program); vi.spyOn(runtimes, 'plan').mockReturnValue({ ...canonicalRuntimeEntryPaths(program), env: {} });
  vi.spyOn(runtimes, 'verify').mockResolvedValue();
  await operations.init(); await service.init();
  const usage = vi.spyOn(operations, 'isInstanceInUse');
  const route = (request: DshLauncherRequest) => (Reflect.get(launcher, 'handle') as (request: DshLauncherRequest) => Promise<DshLauncherResponse>).call(launcher, request);
  const operationSettled = async (request: DshLauncherRequest) => {
    const receipt = await route(request); expect(receipt, request.type).toMatchObject({ ok: true, operationId: expect.any(String) });
    if (!receipt.ok || !receipt.operationId) throw Error('No durable launcher operation');
    await operations.settle();
    const result = operations.list().find(value => value.id === receipt.operationId);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'succeeded', kind: request.type }); return result!;
  };
  const create = async (name: string) => {
    await operationSettled({ type: 'instance.create', name, runtimeId: runtime.id });
    const instance = service.list().find(value => value.name === name); expect(instance).toBeDefined(); return instance!;
  };
  const wireRequests: unknown[] = [], effects: string[] = [], errors: unknown[] = [], token = '7'.repeat(64);
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
      if (request.url === '/bot/tool') {
        expect(request.headers.authorization).toBe('Bearer ' + token); effects.push(body.name);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true,
          result: body.name === 'worker_effect_start' ? { state: 'admitted', callId: body.callId } : { recorded: true } })); return;
      }
      wireRequests.push(body);
      const used = body.messages.some((message: { role: string }) => message.role === 'tool');
      const delta = used ? { content: 'INSTANCE_DELETE_LIFECYCLE_DELIVERABLE' } : { tool_calls: [{ index: 0, id: 'delete-write-' + randomUUID(), type: 'function',
        function: { name: 'write', arguments: JSON.stringify({ file_path: 'deliverable.txt', content: 'Native companion task completed before the instance was deleted.' }) } }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: used ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
  if (!address || typeof address === 'string') throw Error('No lifecycle provider fixture');
  const brain = new BotDshBrain({ getHost: (id, signal, _laneId, options) => launcher.botHost(id, signal, options),
    acquireLease: host => launcher.acquireCompanionLease(host.instance!.id, 'task') });
  let sibling: DshInstance | undefined, target: DshInstance | undefined;
  try {
    sibling = await create('Preserved native sibling');
    target = await create('Shared instance deletion lifecycle');
    expect(await route({ type: 'companion.environment.bind', companionId: 'fish', name: '大肥鱼', instanceId: target.id })).toMatchObject({ ok: true });
    expect((await launcher.resolveCompanionInstance('fish', '大肥鱼')).id).toBe(target.id);
    expect((await launcher.resolveCompanionInstance('claude', 'Claude')).id).toBe(target.id);
    const siblingSentinel = path.join(sibling.homePath, 'preserve-me.txt'); await writeFile(siblingSentinel, 'Do not delete or stop the sibling.');
    const other = await launcher.botHost(sibling.id, undefined, { explicit: true }), siblingPid = other.client.pid;
    const cwd = path.join(target.workspacePath, 'companion-lifecycle-worker');
    const result = await brain.run({ role: 'worker', workerAccess: 'scoped', instanceId: target.id, laneId: 'worker-delete-lifecycle', eventId: 'delete-lifecycle-original-input',
      cwd, workspaceParent: { path: target.workspacePath, title: '大肥鱼' }, workspaceTitle: '大肥鱼', sessionTitle: '删除前验证', tools: [],
      system: 'Write only this isolated lifecycle deliverable and return its result.', prompt: 'Create the isolated deliverable before the operator stops and deletes this instance.',
      model: { apiFormat: 'openai_chat', model: 'local-native-delete-fixture', apiKey: 'local-no-billing', baseUrl: `http://127.0.0.1:${address.port}` },
      callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token } });
    expect(result).toMatchObject({ status: 'succeeded', text: 'INSTANCE_DELETE_LIFECYCLE_DELIVERABLE' });
    expect(await readFile(path.join(cwd, 'deliverable.txt'), 'utf8')).toBe('Native companion task completed before the instance was deleted.');
    expect(service.get(target.id).status).toBe('running');
    const targetRoot = service.getRoot(target.id), targetPid = service.get(target.id).pid;
    expect((await lstat(targetRoot)).isDirectory()).toBe(true);
    await operationSettled({ type: 'instance.stop', instanceId: target.id });
    expect(service.get(target.id)).toMatchObject({ status: 'stopped' }); expect(service.get(target.id).pid).toBeUndefined();
    const archive = await operationSettled({ type: 'instance.delete', instanceId: target.id });
    expect(service.archivedInstances()[0]?.id).toBe(target.id);
    expect((await lstat(targetRoot)).isDirectory()).toBe(true);
    expect(environment.clearedPartitions).toEqual([]);
    const deletion = await operationSettled({ type: 'instance.purge-archive', instanceId: target.id });
    // The actual constructor calls the real occupancy check with this deletion's
    // exact durable id; unrelated operations must still block deletion.
    expect(usage).toHaveBeenCalledWith(target.id, archive.id);
    expect(service.list().map(value => value.id)).toEqual([sibling.id]);
    const registry = JSON.parse(await readFile(path.join(environment.userData, 'dsh/native-instances.json'), 'utf8')) as DshInstance[];
    expect(registry.map(value => value.id)).toEqual([sibling.id]); expect(registry[0]!.isDefault).toBe(true);
    await expect(lstat(targetRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(environment.clearedPartitions).toEqual([target.browserPartition]);
    expect(await readFile(siblingSentinel, 'utf8')).toBe('Do not delete or stop the sibling.');
    expect(service.get(sibling.id)).toMatchObject({ status: 'running', pid: siblingPid }); await other.client.health();
    expect((await launcher.resolveCompanionInstance('claude', 'Claude')).id).toBe(sibling.id);
    expect(wireRequests).toHaveLength(2); expect(effects.filter(value => value === 'worker_effect_start')).toHaveLength(1); expect(errors).toEqual([]);
    const output = path.resolve('artifacts/superagent-bot-development/instance-delete-native'); await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'evidence.json'), JSON.stringify({ at: new Date().toISOString(), runtimeVersion: runtime.version,
      actualNativeHost: true, actualModelInference: false, productionProfileReadOrWritten: false, paidProviderRequests: 0,
      realLauncherConstructorWiring: true, createdThroughOperation: true, selectedSharedForTwoCompanions: true, companionWorkerProducedRealFile: true,
      stoppedThroughOperation: true, deletedThroughOperation: deletion.id, deletionExcludedOnlyItsOwnOperation: true,
      instanceDirectoryRemoved: true, registryRemoved: true, browserPartitionCleared: true, runningSiblingPidPreserved: true,
      siblingDataPreserved: true, fallbackSharedSelection: sibling.id, stoppedPid: targetPid, providerRequests: wireRequests.length }, null, 2) + '\n');
  } finally {
    await brain.close().catch(() => undefined); await launcher.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await removeAcceptanceRoot(root, process.pid);
  }
}, 180000);
