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
import { installedDshAcceptanceProgram } from '../helpers/companion-dsh-real-route';

const transport = vi.hoisted(() => ({ request: undefined as ((command: CompanionStorageCommand) => Promise<CompanionStorageResponse>) | undefined,
  modelRequests: [] as Array<{ model?: string; roles: string[]; toolCallNames: string[]; toolResults: number; hasPriorSuccessfulAnalysis: boolean }>,
  modelErrors: [] as Array<{ status: number; body: string }> }));
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = async () => undefined;
  request = (command: CompanionStorageCommand) => transport.request!(command);
  close = async () => undefined;
} }));
vi.mock('electron', () => ({ net: { fetch: (url: string, init?: RequestInit) => {
  try {
    const body = JSON.parse(String(init?.body)) as { model?: string; messages?: Array<{ role: string; tool_calls?: Array<{ function: { name: string } }> }> };
    if (body.messages) { const text = JSON.stringify(body.messages); transport.modelRequests.push({ model: body.model,
      roles: body.messages.map(message => message.role), toolCallNames: body.messages.flatMap(message => message.tool_calls?.map(call => call.function.name) ?? []),
      toolResults: body.messages.filter(message => message.role === 'tool').length, hasPriorSuccessfulAnalysis: text.includes('analysis.json') && text.includes('succeeded') }); }
  } catch { /* Non-chat traffic is outside this acceptance trace. */ }
  return fetch(url, init).then(async response => {
    if (!response.ok) {
      let body = (await response.clone().text()).slice(0, 8000);
      const headers = new Headers(init?.headers);
      for (const name of ['authorization', 'x-api-key', 'api-key']) { const value = headers.get(name); if (value) { body = body.replaceAll(value, '[credential]'); const token = value.replace(/^Bearer\s+/iu, ''); if (token) body = body.replaceAll(token, '[credential]'); } }
      transport.modelErrors.push({ status: response.status, body });
    }
    return response;
  });
} },
  dialog: {}, ipcMain: { handle: () => undefined }, protocol: {}, shell: {},
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() } }));

it.skipIf(process.env.WORLDLINEBOX_AUTONOMOUS_COLLAB_ACCEPTANCE !== '1')('lets one real user request lead to a brain-chosen invitation, independent DSH verification and owner handoff', async () => {
  const output = path.resolve(process.env.WORLDLINEBOX_AUTONOMOUS_COLLAB_RESULT ?? '.tools/test-output/companion-autonomous-collaboration-content-acceptance.json');
  const configRoot = path.resolve('.tools/test-output/autonomous-collaboration-key-profile'); await mkdir(configRoot, { recursive: true });
  const config = await realGlobalChatConfig(configRoot);
  const native = await createNativeAcceptanceBroker({ program: await installedDshAcceptanceProgram(), apiKey: config.apiKey, model: 'deepseek-flash', baseURL: 'https://api.deepseek.com/anthropic' });
  const owned: { store?: CompanionsStore; service?: CompanionService } = {};
  onTestFinished(async () => { await owned.service?.shutdown(); owned.store?.close(); await native.dispose(); });
  const startedAt = new Date().toISOString(), failures: string[] = [], commands: CompanionStorageCommand[] = [];
  const operations = new Map<string, { id: string; status: string; error?: string }>();
  const jobs = new Set<Promise<void>>();
  const dsh = { state: () => ({ tasks: native.broker.state(), operations: [...operations.values()],
    cli: { selectedInstanceId: 'acceptance' }, instances: [{ id: 'acceptance', runtimeId: 'runtime-acceptance', updatedAt: startedAt }],
    runtimes: [{ id: 'runtime-acceptance', version: '0.2.1-rc.2' }], taskAccess: { mode: 'workspace-write' } }),
  taskCapabilities: (instanceId?: string, _execution?: unknown, query?: Parameters<DshLauncher['taskCapabilities']>[2]) => native.broker.discover(instanceId, { ...native.execution, capabilityQuery: query }),
  taskRecordScope: async (recordId: string) => (await native.broker.recordMetadata(recordId)).scope,
  readTaskRecord: (query: Parameters<DshLauncher['readTaskRecord']>[0]) => native.broker.readRecord(query), removeCompanionTaskRecords: async () => undefined,
  requestTask: async (request: Parameters<DshLauncher['requestTask']>[0], execution?: Parameters<DshLauncher['requestTask']>[1]) => {
    if (request.type === 'task.run') {
      const operation = native.operation(); operations.set(operation.id, { id: operation.id, status: 'running' });
      const job = native.broker.execute({ prompt: request.prompt, title: request.title, instanceId: request.instanceId,
        sessionId: request.sessionId, timeoutMs: 240000 }, operation, { ...native.execution, ...execution,
        access: execution?.resume ? execution.access : native.execution.access }).then(() => { operations.get(operation.id)!.status = 'succeeded'; }, error => {
        operations.get(operation.id)!.status = 'failed'; operations.get(operation.id)!.error = error instanceof Error ? error.message : 'DSH failed';
      }).finally(() => { jobs.delete(job); }); jobs.add(job);
      return { ok: true, operationId: operation.id };
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
    { id: 'lin', name: '林澄', description: '数据整理与交付', persona: '你是林澄，认真简短，先做实际检查再报告。周岚(zhou)是同事，user是独立真人。现实任务使用DSH并核查实际文件。用户授权协作时由你主动邀请同事，自己的分析与同事独立核验分开，拿到同事真实结果后自己继续汇总；不要让用户逐步指挥，不替同事接受或冒充结果。', avatar: 'sister', model: '', active: true, proactive: false },
    { id: 'zhou', name: '周岚', description: '独立复核', persona: '你是周岚，沉稳，独立核查实际数据。林澄(lin)是同事，user是独立真人。对协作邀请自己判断是否接受；范围明确且已获用户授权、能力足够时愿意合作。接受后亲自用DSH读取原始文件并重新计算，写实际核验产物，不只复述同事结论。遵守原始用户限制，不泄露任何其他入口私聊。', avatar: 'flash', model: '', active: true, proactive: false },
  ]);
  owned.store = store; transport.request = async command => { commands.push(command); return store.request(command); };
  const origin = store.openPrivate('lin');
  const privateCanary = 'UNRELATED_PRIVATE_BACKGROUND_' + randomUUID();
  store.appendMessage({ conversationId: origin.id, authorId: 'user', content: `私密背景备忘，不属于下一项任务：${privateCanary}。不要向同事转发。`, replyDirective: 'none' });
  const world = store.request({ type: 'world.snapshot' }).world!;
  const now = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now - 30000);
  for (const id of ['lin', 'zhou']) {
    const privateRoom = store.openPrivate(id);
    const routine = store.request({ type: 'routine.get', companionId: id, conversationId: privateRoom.id }).routine!;
    store.request({ type: 'routine.configure', companionId: id, conversationId: privateRoom.id, expectedRevision: routine.revision,
      patch: { sleepAt: '23:59', wakeAt: '00:01', meals: [], habits: [] } });
    const computer = world.scenes.find(scene => scene.ownerId === id)!.objects.find(object => object.kind === 'computer')!;
    store.request({ type: 'world.tool', companionId: id, conversationId: privateRoom.id, arguments: { action: 'move', destinationId: computer.id } });
  }
  vi.setSystemTime(now); store.request({ type: 'world.tick' }); vi.useRealTimers();
  const service = new CompanionService({ userData: path.join(native.root, 'profile'), dataRoot, workerPath: 'in-process-test-port',
    window: () => undefined, hasConfig: () => true, getConfig: () => config, dsh: () => dsh, report: error => failures.push(error instanceof Error ? error.message : String(error)) });
  owned.service = service;
  const marker = randomUUID(), csvPath = path.join(native.root, 'orders.csv');
  const rows = [{ item: 'A', quantity: 7, unitCents: 1325 }, { item: 'B', quantity: 3, unitCents: 840 }, { item: 'C', quantity: 5, unitCents: 615 }, { item: 'D', quantity: 2, unitCents: 1780 }];
  const expectedTotal = rows.reduce((total, row) => total + row.quantity * row.unitCents, 0);
  await writeFile(csvPath, 'item,qty,unit_price\n' + rows.map(row => `${row.item},${row.quantity},${(row.unitCents / 100).toFixed(2)}`).join('\n') + '\n');
  let status = 'running', sourceId = '';
  const evidence: Record<string, unknown> = { scope: 'actual-main-brains-autonomous-invitation-independent-native-dsh-and-owner-handoff', userTaskMessages: 1,
    model: config.model, runtimeVersion: '0.2.1-rc.2', configuredProtocol: config.apiFormat, nativeProtocol: 'anthropic-messages' };
  const saveReport = async (json: string) => { if (json.includes(config.apiKey)) throw new Error('Credential found in acceptance report'); await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, json); };
  try {
    const source = (await service.handle({ type: 'message.send', conversationId: origin.id, clientId: 'autonomous_collaboration_user_request',
      content: `请你统筹完成一次真实数据分析与独立复核。输入CSV在 ${csvPath}；本次标记 ${marker}。你先亲自通过DSH读CSV，按qty*unit_price计算总额（使用整数分），生成analysis.json，至少含marker、lineCount、totalCents。然后你主动邀请联系人周岚（zhou）独立复核，明确让她亲自通过DSH读取同一原始CSV和你的真实analysis.json，重新计算并在她自己的工作目录生成review.json，至少含marker、independent:true、matched、totalCents、lineCount、actor:"zhou"。我明确授权这次分工及必要的本地文件读写，可以向她共享本条任务的CSV路径、标记、分析产物路径与核验目标；不能共享其他私聊内容或扩大任务。两人只读取输入，在各自本次工作目录写产物，不访问别的资料。你收到她的真实核验结果后，再自己核对并生成handoff.json（marker、totalCents、reviewedBy:"zhou"、reviewed:true、analysisPath、reviewPath）和summary.md（包含本次标记），向我交付全部绝对路径。不要让我再给周岚发第二条指令，也不要替她声称已经接受或完成。` })).message!;
    sourceId = source.id;
    const deadline = Date.now() + 540000;
    let nextProgressAt = 0;
    while (Date.now() < deadline) {
      const checkpoint = store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'lin' }).loop;
      if (checkpoint?.status === 'done') {
        evidence.ownerCalls = checkpoint.turns.flatMap(turn => turn.calls.map(call => ({ name: call.name, arguments: JSON.parse(call.arguments) })));
        evidence.ownerFinal = checkpoint.turns.at(-1)?.text;
        break;
      }
      const failure = store.messages({ conversationId: origin.id, limit: 20 }).messages.find(message => message.sequence > source.sequence && message.kind === 'notice' && message.authorId === 'system' && message.status === 'failed');
      if (failure) throw new Error('The actual main brain stopped: ' + failure.content);
      if (Date.now() >= nextProgressAt) {
        nextProgressAt = Date.now() + 30000;
        await saveReport(JSON.stringify({ status: 'running', startedAt, observedAt: new Date().toISOString(), progress: {
          sourceId, ownerSteps: checkpoint?.turns.length ?? 0, latestCalls: checkpoint?.turns.at(-1)?.calls.map(call => call.name),
          actions: store.listAction().filter(action => action.sourceMessageId === sourceId).map(action => ({ companionId: action.companionId, status: action.status, title: action.title, stage: action.stage })),
          collaborations: store.request({ type: 'collaboration.list', companionId: 'lin', conversationId: origin.id }).collaborations?.map(grant => ({ id: grant.id, status: grant.status, participants: grant.participants.map(participant => ({ companionId: participant.companionId, status: participant.status })) })),
        } }, null, 2));
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const ownerLoop = store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'lin' }).loop;
    expect(ownerLoop?.status, 'the original owner brain must continue through final handoff').toBe('done');
    const collaborationCalls = ownerLoop!.turns.flatMap(turn => turn.calls).filter(call => call.name === 'world' && JSON.parse(call.arguments).action === 'collaborate');
    const ownerContactCalls = ownerLoop!.turns.flatMap(turn => turn.calls).filter(call => {
      if (call.name !== 'world') return false;
      const args = JSON.parse(call.arguments);
      return args.action === 'collaborate' && args.participantIds?.includes('zhou')
        || args.action === 'message' && args.recipientIds?.includes('zhou');
    });
    const grants = store.request({ type: 'collaboration.list', companionId: 'lin', conversationId: origin.id }).collaborations!;
    const grant = grants.find(grant => grant.sourceMessageId === source.id && grant.participants.some(participant => participant.companionId === 'zhou'))!;
    expect(grant, 'real independent execution must have a current human grant, regardless of the chosen contact path').toBeDefined();
    expect(ownerContactCalls.length, 'the actual owner model must choose its contact or delegation step').toBeGreaterThan(0);
    expect(grant.status).toBe('completed');
    const verifier = grant.participants.find(participant => participant.companionId === 'zhou')!;
    expect(verifier.status).toBe('succeeded'); expect(verifier.reason).toBeTruthy(); expect(verifier.actionIds.length).toBeGreaterThan(0);
    expect(grant.ownerId).toBe('lin'); expect(verifier.conversationId).not.toBe(origin.id);
    expect(store.request({ type: 'state', conversationId: origin.id }).state!.conversations.find(room => room.id === origin.id)!.memberIds).not.toContain('zhou');
    const verifierLoop = store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'zhou', invocationKey: verifier.goalSlot }).loop!;
    expect(verifierLoop.status).toBe('done'); expect(verifierLoop.authorizationGrantId).toBe(grant.id);
    expect(JSON.stringify(verifierLoop)).not.toContain(privateCanary); expect(JSON.stringify(grant)).not.toContain(privateCanary);
    const actions = store.listAction().filter(action => action.sourceMessageId === source.id);
    const verifierActions = actions.filter(action => action.companionId === 'zhou');
    expect(verifierActions.length).toBeGreaterThan(0); expect(verifierActions.every(action => action.authorizationGrantId === grant.id && action.status === 'succeeded')).toBe(true);
    const ownerActions = actions.filter(action => action.companionId === 'lin'); expect(ownerActions.length).toBeGreaterThanOrEqual(2);
    const tasks = native.broker.state().filter(task => actions.some(action => action.taskId === task.id));
    const ownerTaskIds = new Set(ownerActions.map(action => action.taskId)), verifierTaskIds = new Set(verifierActions.map(action => action.taskId));
    const ownerWorkspaces = [...new Set(tasks.flatMap(task => ownerTaskIds.has(task.id) && task.workspacePath ? [task.workspacePath] : []))];
    const verifierWorkspaces = [...new Set(tasks.flatMap(task => verifierTaskIds.has(task.id) && task.workspacePath ? [task.workspacePath] : []))];
    const findFile = async (name: string, workspaces: string[]) => { for (const directory of workspaces) { const filename = path.join(directory, name); try { const content = await readFile(filename, 'utf8'); if (content.includes(marker)) return { filename, content }; } catch { /* Continue across independently chosen sessions. */ } } throw new Error(`No actual ${name} artifact was produced`); };
    const handoff = await findFile('handoff.json', ownerWorkspaces), summary = await findFile('summary.md', ownerWorkspaces);
    const handoffData = JSON.parse(handoff.content);
    const within = (filename: string, roots: string[]) => path.isAbsolute(filename) && roots.some(root => { const relative = path.relative(root, filename); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); });
    expect(within(handoffData.analysisPath, ownerWorkspaces)).toBe(true); expect(within(handoffData.reviewPath, verifierWorkspaces)).toBe(true);
    const analysis = { filename: path.resolve(handoffData.analysisPath), content: await readFile(handoffData.analysisPath, 'utf8') };
    const review = { filename: path.resolve(handoffData.reviewPath), content: await readFile(handoffData.reviewPath, 'utf8') };
    expect(JSON.parse(analysis.content)).toMatchObject({ marker, lineCount: rows.length, totalCents: expectedTotal });
    expect(JSON.parse(review.content)).toMatchObject({ marker, lineCount: rows.length, totalCents: expectedTotal, matched: true, independent: true, actor: 'zhou' });
    expect(handoffData).toMatchObject({ marker, totalCents: expectedTotal, reviewedBy: 'zhou', reviewed: true });
    expect(path.isAbsolute(handoffData.analysisPath)).toBe(true); expect(path.resolve(handoffData.analysisPath)).toBe(path.resolve(analysis.filename));
    expect(path.isAbsolute(handoffData.reviewPath)).toBe(true); expect(path.resolve(handoffData.reviewPath)).toBe(path.resolve(review.filename));
    expect(tasks.filter(task => verifierTaskIds.has(task.id)).every(task => !tasks.some(other => ownerTaskIds.has(other.id) && other.workspacePath === task.workspacePath))).toBe(true);
    const proofRoot = output.replace(/\.json$/u, '-files'); await mkdir(proofRoot, { recursive: true });
    for (const file of [analysis, review, handoff, summary]) { if (file.content.includes(config.apiKey)) throw new Error('Credential found in generated proof'); await writeFile(path.join(proofRoot, path.basename(file.filename)), file.content); }
    evidence.grant = grant; evidence.actions = actions; evidence.tasks = tasks; evidence.proofRoot = proofRoot;
    evidence.verifierCalls = verifierLoop.turns.flatMap(turn => turn.calls.map(call => ({ name: call.name, arguments: JSON.parse(call.arguments) })));
    evidence.allTaskResultsVerified = true; evidence.independentWorkspacesVerified = true; evidence.privateBackgroundIsolated = true;
    evidence.invitationWasModelChosen = ownerContactCalls.length > 0; evidence.explicitCollaborationToolCalls = collaborationCalls.length;
    evidence.peerAcceptanceWasRealModelDecision = commands.some(command => command.type === 'collaboration.respond' && command.decision === 'accept');
    status = 'passed';
  } catch (error) { status = 'failed'; failures.push(error instanceof Error ? error.message : String(error)); throw error; }
  finally {
    await service.shutdown(); await Promise.allSettled([...jobs]);
    evidence.sourceId = sourceId; evidence.modelRequests = transport.modelRequests; evidence.modelErrors = transport.modelErrors;
    evidence.grants = store.request({ type: 'collaboration.list', companionId: 'lin', conversationId: origin.id }).collaborations;
    evidence.actionSummary = store.listAction().filter(action => action.sourceMessageId === sourceId); evidence.tasks = native.broker.state();
    const json = JSON.stringify({ status, startedAt, finishedAt: new Date().toISOString(), failures, evidence }, null, 2);
    await saveReport(json);
  }
}, 900000);
