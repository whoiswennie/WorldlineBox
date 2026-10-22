import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi, onTestFinished } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import { CompanionService } from '../../src/main/companions/service';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { createNativeAcceptanceBroker } from '../helpers/companion-dsh-native-broker';
import { installedDshAcceptanceProgram } from '../helpers/companion-dsh-real-route';
import { nativeAcceptanceLauncher } from '../helpers/companion-dsh-acceptance-launcher';

const transport = vi.hoisted(() => ({ request: undefined as ((command: CompanionStorageCommand) => Promise<CompanionStorageResponse>) | undefined,
  commands: [] as CompanionStorageCommand[],
  foreignCanary: '', requests: [] as Array<{ kind: string; id: string; foreignCanaryPresent: boolean; messagePort: unknown }>,
  errors: [] as Array<{ status: number; body: string }> }));
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = async () => undefined;
  request = (command: CompanionStorageCommand) => transport.request!(command);
  close = async () => undefined;
} }));
vi.mock('electron', () => ({ net: { fetch: (url: string, init?: RequestInit) => {
  try {
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: unknown }> };
    for (const message of body.messages ?? []) if (typeof message.content === 'string') {
      try {
        const context = JSON.parse(message.content) as { invocation?: { id: string; kind: string; messagePort?: unknown } };
        if (context.invocation && ['schedule', 'work'].includes(context.invocation.kind)) transport.requests.push({
          kind: context.invocation.kind, id: context.invocation.id, messagePort: context.invocation.messagePort,
          foreignCanaryPresent: JSON.stringify(body.messages).includes(transport.foreignCanary) });
      } catch { /* Normal text messages are not context frames. */ }
    }
  } catch { /* Non-chat traffic. */ }
  return fetch(url, init).then(async response => {
    if (!response.ok) {
      let body = (await response.clone().text()).slice(0, 8000);
      const headers = new Headers(init?.headers);
      for (const name of ['authorization', 'x-api-key', 'api-key']) { const value = headers.get(name); if (value) {
        body = body.replaceAll(value, '[credential]'); const token = value.replace(/^Bearer\s+/iu, ''); if (token) body = body.replaceAll(token, '[credential]');
      } }
      transport.errors.push({ status: response.status, body });
    }
    return response;
  });
} }, dialog: {}, ipcMain: { handle: () => undefined }, protocol: {}, shell: {},
safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() } }));

it.skipIf(process.env.WORLDLINEBOX_BACKGROUND_DSH_ACCEPTANCE !== '1')('runs scheduled and published work goals through real main brains, native DSH and verified files', async () => {
  const output = path.resolve(process.env.WORLDLINEBOX_BACKGROUND_DSH_RESULT ?? '.tools/test-output/companion-background-dsh-content-acceptance.json');
  const configRoot = path.resolve('.tools/test-output/background-dsh-key-profile'); await mkdir(configRoot, { recursive: true });
  const config = await realGlobalChatConfig(configRoot);
  const native = await createNativeAcceptanceBroker({ program: await installedDshAcceptanceProgram(), apiKey: config.apiKey, model: 'deepseek-flash', baseURL: 'https://api.deepseek.com/anthropic' });
  const launcher = nativeAcceptanceLauncher(native), owned: { service?: CompanionService; store?: CompanionsStore } = {};
  onTestFinished(async () => { await owned.service?.shutdown(); owned.store?.close(); await native.dispose(); });
  const startedAt = new Date().toISOString(), failures: string[] = [], evidence: Record<string, unknown> = {
    scope: 'actual-background-main-brains-schedule-and-work-native-dsh-content', model: config.model, runtimeVersion: '0.2.1-rc.2' };
  let status = 'running';
  const dataRoot = path.join(native.root, '.worldlinebox/companions'); await mkdir(dataRoot, { recursive: true });
  const store = new CompanionsStore(path.join(dataRoot, 'messages.sqlite'), [
    { id: 'lin', name: '林澄', description: '认真处理正式工作与日程', persona: '你是林澄，认真、诚实、简短。正式委托和日程中的现实文件任务由你亲自调用DSH完成并实际读回核验，不能把计划或代码当作实际结果。每项委托只使用它明确给出的输入、目标和限制，不添加其他聊天的工作。', avatar: 'sister', model: '', active: true, proactive: false },
    { id: 'zhou', name: '周岚', description: '其他聊天成员', persona: '你是周岚。', avatar: 'flash', model: '', active: false, proactive: false },
  ]);
  owned.store = store; transport.request = async command => { transport.commands.push(command); return store.request(command); };
  const room = store.openPrivate('lin'), foreignRoom = store.createConversation('与当前任务无关的群聊', ['lin', 'zhou']);
  transport.foreignCanary = 'OTHER_CHAT_NOT_A_TASK_' + randomUUID();
  store.appendMessage({ conversationId: foreignRoom.id, authorId: 'user', content: transport.foreignCanary, replyDirective: 'none' });
  const world = store.request({ type: 'world.snapshot' }).world!, now = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now - 30000);
  const routine = store.request({ type: 'routine.get', companionId: 'lin', conversationId: room.id }).routine!;
  store.request({ type: 'routine.configure', companionId: 'lin', conversationId: room.id, expectedRevision: routine.revision,
    patch: { sleepAt: '23:59', wakeAt: '00:01', meals: [], habits: [] } });
  const computer = world.scenes.find(scene => scene.ownerId === 'lin')!.objects.find(object => object.kind === 'computer')!;
  store.request({ type: 'world.tool', companionId: 'lin', conversationId: room.id, arguments: { action: 'move', destinationId: computer.id } });
  vi.setSystemTime(now); store.request({ type: 'world.tick' }); vi.useRealTimers();
  const service = new CompanionService({ userData: path.join(native.root, 'profile'), dataRoot, workerPath: 'in-process-test-port',
    window: () => undefined, hasConfig: () => true, getConfig: () => config, dsh: () => launcher.dsh,
    report: error => failures.push(error instanceof Error ? error.message : String(error)) });
  owned.service = service;
  const saveReport = async () => { const json = JSON.stringify({ status, startedAt, finishedAt: new Date().toISOString(), failures,
    evidence: { ...evidence, modelRequests: transport.requests, modelErrors: transport.errors, tasks: native.broker.state(), actions: store.listAction() } }, null, 2);
  if (json.includes(config.apiKey)) throw new Error('Credential found in acceptance report'); await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, json); };
  const wait = async <T>(label: string, read: () => T | undefined): Promise<T> => {
    const deadline = Date.now() + 300000; let nextReport = 0;
    while (Date.now() < deadline) {
      const result = read(); if (result) return result;
      if (Date.now() > nextReport) { nextReport = Date.now() + 30000; evidence.waitingFor = label; await saveReport(); }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`Actual ${label} did not finish`);
  };
  const markers = { schedule: randomUUID(), work: randomUUID() }, expected = { schedule: 29, work: 47 };
  const verify = async (kind: 'schedule' | 'work', sourceMessageId: string, invocationId: string, goalSlot: string | undefined, actionIds: string[] | undefined) => {
    expect(goalSlot).toBeTruthy(); expect(actionIds?.length).toBeGreaterThan(0);
    const loop = store.request({ type: 'loop.get', companionId: 'lin', sourceMessageId, invocationKey: goalSlot }).loop as CompanionLoopCheckpoint;
    expect(loop.status).toBe('done'); expect(loop.conversationId).toBe(room.id); expect(JSON.stringify(loop)).not.toContain(transport.foreignCanary);
    const context = JSON.parse(loop.context!.user); expect(context.invocation).toMatchObject({ id: invocationId, kind, companionId: 'lin', conversationId: room.id, messagePort: { kind: 'invocation' } });
    const calls = loop.turns.flatMap(turn => turn.calls); expect(calls.some(call => call.name === 'dsh' && JSON.parse(call.arguments).operation === 'run')).toBe(true);
    const actions = store.listAction().filter(action => actionIds!.includes(action.id));
    expect(actions.length).toBe(actionIds!.length); expect(actions.every(action => action.status === 'succeeded' && action.parentMessageId === loop.messageId && action.taskId)).toBe(true);
    const tasks = native.broker.state().filter(task => actions.some(action => action.taskId === task.id));
    let artifact: { path: string; content: string } | undefined;
    for (const task of tasks) if (task.workspacePath) {
      const filename = path.join(task.workspacePath, `${kind}-result.json`);
      try { const content = await readFile(filename, 'utf8'); if (JSON.parse(content).marker === markers[kind]) artifact = { path: filename, content }; } catch { /* Model may use more than one scoped task. */ }
    }
    expect(artifact, 'a real DSH-produced artifact is required').toBeDefined();
    expect(JSON.parse(artifact!.content)).toMatchObject({ marker: markers[kind], kind, sum: expected[kind] });
    const toolResults = loop.turns.flatMap(turn => turn.results ?? []).map(result => result.content).join('\n');
    expect(toolResults).toContain('succeeded'); expect(toolResults).toContain(artifact!.path.replaceAll('\\', '\\\\'));
    const proofRoot = output.replace(/\.json$/u, '-files'); await mkdir(proofRoot, { recursive: true });
    if (artifact!.content.includes(config.apiKey)) throw new Error('Credential found in generated proof');
    await writeFile(path.join(proofRoot, `${kind}-result.json`), artifact!.content);
    evidence[kind] = { sourceMessageId, invocationId, loop, actions, tasks, artifact, proofRoot, contentVerified: true };
  };
  try {
    const scope = { companionId: 'lin', conversationId: room.id };
    const prompt = (kind: 'schedule' | 'work') => `这是一项已授权的真实本地文件任务。请亲自使用DSH，在你本次工作目录创建 ${kind}-result.json，内容是JSON对象：marker为 ${markers[kind]}，kind为 ${kind}，sum为${kind === 'schedule' ? '13+16' : '19+28'}的实际计算结果。必须在写入后实际读回该文件，核对这些字段与计算，再交付绝对路径和核验结果。只在本次工作目录写入此产物，不访问其他资料、聊天或网络；不额外创建其他工作或日程。`;
    const schedule = (await service.handle({ type: 'schedule.create', ...scope, clientId: 'real_background_schedule', entries: [{
      title: '实际定时文件验收', kind: 'task', prompt: prompt('schedule'), runAt: new Date(Date.now() + 2000).toISOString(), timeZone: 'Asia/Shanghai', recurrence: 'once', flexible: false }] })).schedules![0]!;
    const occurrence = await wait('schedule goal', () => {
      const item = store.request({ type: 'schedule.list', ...scope, includeHistory: true }).scheduleOccurrences?.find(item => item.scheduleId === schedule.id);
      if (item && ['failed', 'cancelled'].includes(item.status)) throw new Error(`Actual scheduled goal ${item.status}: ${item.error}`);
      return item?.status === 'done' ? item : undefined;
    });
    await verify('schedule', schedule.sourceMessageId, occurrence.id, occurrence.goalSlot, occurrence.actionIds);
    const order = (await service.handle({ type: 'work-order.create', ...scope, title: '实际后台工作文件验收', instruction: prompt('work'), clientId: 'real_background_work' })).workOrder!;
    const completed = await wait('work goal', () => {
      const item = store.request({ type: 'work-order.list', ...scope, includeHistory: true }).workOrderPage?.items.find(item => item.id === order.id);
      if (item && ['failed', 'cancelled'].includes(item.status)) throw new Error(`Actual work goal ${item.status}: ${item.error}`);
      return item?.status === 'completed' ? item : undefined;
    });
    const completeCommand = transport.commands.find((command): command is Extract<CompanionStorageCommand, { type: 'work-order.complete' }> => command.type === 'work-order.complete' && command.id === completed.id);
    expect(completeCommand).toBeDefined();
    const matching = store.listAction().find(action => action.workOrderId === completed.id);
    expect(matching).toBeDefined();
    await verify('work', completed.sourceMessageId, completed.id, completeCommand!.goalSlot, completed.actionIds);
    expect(transport.requests.some(request => request.kind === 'schedule')).toBe(true); expect(transport.requests.some(request => request.kind === 'work')).toBe(true);
    expect(transport.requests.every(request => !request.foreignCanaryPresent)).toBe(true); expect(transport.errors).toEqual([]);
    evidence.parentStatuses = { scheduleOccurrence: occurrence.status, workOrder: completed.status }; evidence.waitingFor = undefined; status = 'passed';
  } catch (error) { status = 'failed'; failures.push(error instanceof Error ? error.message : String(error)); throw error; }
  finally { await service.shutdown(); await launcher.settle(); await saveReport(); }
}, 900000);
