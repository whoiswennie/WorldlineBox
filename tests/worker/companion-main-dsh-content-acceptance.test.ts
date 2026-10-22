import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi, onTestFinished } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { DshLauncher } from '../../src/main/dsh/launcher';
import { CompanionService } from '../../src/main/companions/service';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { createNativeAcceptanceBroker } from '../helpers/companion-dsh-native-broker';

const transport = vi.hoisted(() => ({ request: undefined as ((command: CompanionStorageCommand) => Promise<CompanionStorageResponse>) | undefined }));
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = async () => undefined;
  request = (command: CompanionStorageCommand) => transport.request!(command);
  close = async () => undefined;
} }));
vi.mock('electron', () => ({ net: { fetch: (url: string, init?: RequestInit) => fetch(url, init) },
  dialog: {}, ipcMain: { handle: () => undefined }, protocol: {}, shell: {},
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() } }));

it.skipIf(process.env.WORLDLINEBOX_MAIN_DSH_ACCEPTANCE !== '1')('lets actual companion brains choose DSH tools, produce real files, and review another group member result', async () => {
  const configRoot = path.resolve('.tools/test-output/main-dsh-key-profile'); await mkdir(configRoot, { recursive: true });
  const config = await realGlobalChatConfig(configRoot);
  const program = process.env.WORLDLINEBOX_DSH_NATIVE_PROGRAM ?? path.join(process.env.APPDATA!, 'WorldlineBox/dsh-launcher/runtimes/runtime-7166bc2240b170bff29c0dfe/program');
  const native = await createNativeAcceptanceBroker({ program, apiKey: config.apiKey, model: 'deepseek-flash' });
  const owned: { store?: CompanionsStore; service?: CompanionService } = {};
  onTestFinished(async () => { await owned.service?.shutdown(); owned.store?.close(); await native.dispose(); });
  const startedAt = new Date().toISOString(), failures: string[] = [], observations: unknown[] = [];
  const operations = new Map<string, { id: string; status: string; error?: string }>();
  const jobs = new Set<Promise<void>>();
  const dsh = { state: () => ({ tasks: native.broker.state(), operations: [...operations.values()],
    cli: { selectedInstanceId: 'acceptance' }, instances: [{ id: 'acceptance', runtimeId: 'runtime-acceptance', updatedAt: startedAt }],
    runtimes: [{ id: 'runtime-acceptance', version: '0.2.1-rc.2' }], taskAccess: { mode: 'workspace-write' } }),
  taskCapabilities: (instanceId?: string) => native.broker.discover(instanceId, native.execution),
  readTaskRecord: (query: Parameters<DshLauncher['readTaskRecord']>[0]) => native.broker.readRecord(query),
  removeCompanionTaskRecords: async () => undefined,
  requestTask: async (request: Parameters<DshLauncher['requestTask']>[0], execution?: Parameters<DshLauncher['requestTask']>[1]) => {
    if (request.type === 'task.run') {
      const op = native.operation(); operations.set(op.id, { id: op.id, status: 'running' });
      const job = native.broker.execute({ prompt: request.prompt, title: request.title, instanceId: request.instanceId,
        sessionId: request.sessionId, timeoutMs: 240000 }, op, { ...native.execution, ...execution,
        access: execution?.resume ? execution.access : native.execution.access }).then(() => { operations.get(op.id)!.status = 'succeeded'; }, error => {
        operations.get(op.id)!.status = 'failed'; operations.get(op.id)!.error = error instanceof Error ? error.message : 'DSH failed';
      }).finally(() => { jobs.delete(job); }); jobs.add(job);
      return { ok: true, operationId: op.id };
    }
    if (request.type === 'task.result') return { ok: true, taskResult: native.broker.result(request.taskId) };
    if (request.type === 'task.events') return { ok: true, taskEvents: native.broker.events(request.taskId, request.after) };
    if (request.type === 'task.record') return { ok: true, taskRecord: await native.broker.readRecord(request.query) };
    if (request.type === 'task.message') await native.broker.sendInput(request.taskId, request.content, request.mode, request.messageId);
    if (request.type === 'task.cancel') native.broker.cancel(request.taskId);
    if (request.type === 'task.terminate') await native.broker.terminate(request.taskId);
    return { ok: true };
  } } as unknown as DshLauncher;
  const dataRoot = path.join(native.root, '.worldlinebox', 'companions'); await mkdir(dataRoot, { recursive: true });
  const store = new CompanionsStore(path.join(dataRoot, 'messages.sqlite'), [
    { id: 'lin', name: '林澄', description: '数据整理', persona: '你是林澄，认真简短，先做实际检查再报告。周岚是同事，user是独立真人。需要真实计算/写文件必须调用dsh，不能口头冒充执行。', avatar: 'sister', model: '', active: true, proactive: false },
    { id: 'zhou', name: '周岚', description: '审核', persona: '你是周岚，沉稳，喜欢核查实际数据。林澄是同事，user是独立真人。需要文件读取和产物必须调用dsh，用实际证据审核，不能冒充别人的工作。', avatar: 'flash', model: '', active: true, proactive: false },
  ]);
  owned.store = store;
  transport.request = async command => store.request(command);
  // Finish the real walking transition before testing cognition; no virtual state is forged.
  const group = store.createConversation('现实任务合作验收', ['lin', 'zhou']);
  const world = store.request({ type: 'world.snapshot' }).world!;
  const now = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now - 30000);
  for (const id of ['lin', 'zhou']) {
    const privateRoom = store.openPrivate(id);
    const routine = store.request({ type: 'routine.get', companionId: id, conversationId: privateRoom.id }).routine!;
    store.request({ type: 'routine.configure', companionId: id, conversationId: privateRoom.id, expectedRevision: routine.revision,
      patch: { sleepAt: '23:59', wakeAt: '00:01', meals: [], habits: [] } });
    const computer = world.scenes.find(scene => scene.ownerId === id)!.objects.find(object => object.kind === 'computer')!;
    store.request({ type: 'world.tool', companionId: id, conversationId: group.id, arguments: { action: 'move', destinationId: computer.id } });
  }
  vi.setSystemTime(now); store.request({ type: 'world.tick' }); vi.useRealTimers();
  const service = new CompanionService({ userData: path.join(native.root, 'profile'), dataRoot, workerPath: 'in-process-test-port',
    window: () => undefined, hasConfig: () => true, getConfig: () => config, dsh: () => dsh, report: error => failures.push(error instanceof Error ? error.message : String(error)) });
  owned.service = service;
  const wait = async (sourceId: string, actor: string) => {
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const loop = store.request({ type: 'loop.get', sourceMessageId: sourceId, companionId: actor }).loop;
      if (loop?.status === 'done') { observations.push({ actor, loop }); return; }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`Actual ${actor} main loop did not finish; actions=${JSON.stringify(store.listAction(group.id))}`);
  };
  let status = 'running';
  try {
    const marker = randomUUID(), input = path.join(native.root, 'orders.csv');
    await writeFile(input, 'item,qty,price\nA,3,12.5\nB,4,7.25\nC,2,19\n');
    const first = (await service.handle({ type: 'message.send', conversationId: group.id, clientId: 'real_main_csv',
      content: `@林澄 请独立完成真实任务：读取这个测试CSV ${input}，计算qty*price及总金额，在你的工作目录生成 result.json，内容为 {"total":104.5,"marker":"${marker}"}。必须实际读取和计算并核对文件，最后交付文件的绝对路径。不得只在聊天中给代码。周岚这轮先等待。` })).message!;
    await wait(first.id, 'lin');
    const actions = store.listAction(group.id).filter(action => action.sourceMessageId === first.id && action.companionId === 'lin');
    expect(actions.length).toBeGreaterThan(0); expect(actions.every(action => action.status === 'succeeded')).toBe(true);
    const firstTask = native.broker.state().find(task => task.id === actions.at(-1)!.taskId)!;
    expect(JSON.parse(await readFile(path.join(firstTask.workspacePath!, 'result.json'), 'utf8'))).toEqual({ total: 104.5, marker });
    const resultPath = path.join(firstTask.workspacePath!, 'result.json');
    const second = (await service.handle({ type: 'message.send', conversationId: group.id, clientId: 'real_main_review',
      content: `@周岚 请审核林澄刚才的真实产物 ${resultPath} 与原输入 ${input}。独立重新计算，再在你自己的工作目录生成 review.json，内容 {"correct":true,"total":104.5,"marker":"${marker}"}。必须实际读文件并交付绝对路径，不能只相信林澄的话。林澄这轮先等待。` })).message!;
    await wait(second.id, 'zhou');
    const reviewActions = store.listAction(group.id).filter(action => action.sourceMessageId === second.id && action.companionId === 'zhou');
    expect(reviewActions.length).toBeGreaterThan(0); expect(reviewActions.every(action => action.status === 'succeeded')).toBe(true);
    const reviewTask = native.broker.state().find(task => task.id === reviewActions.at(-1)!.taskId)!;
    expect(reviewTask.workspacePath).not.toBe(firstTask.workspacePath);
    expect(JSON.parse(await readFile(path.join(reviewTask.workspacePath!, 'review.json'), 'utf8'))).toEqual({ correct: true, total: 104.5, marker });
    expect(store.listAction(group.id).filter(action => action.sourceMessageId === second.id).every(action => action.companionId === 'zhou')).toBe(true);
    observations.push({ tasks: native.broker.state(), messages: store.messages({ conversationId: group.id, limit: 100 }).messages });
    status = 'passed';
  } catch (error) {
    status = 'failed'; failures.push(error instanceof Error ? error.message : String(error)); throw error;
  } finally {
    await service.shutdown(); await Promise.allSettled([...jobs]);
    const output = path.resolve('artifacts/companion-agent-acceptance/main-dsh-content.json'); await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ status, startedAt, finishedAt: new Date().toISOString(), model: config.model, failures, observations }, null, 2));
  }
}, 900000);
