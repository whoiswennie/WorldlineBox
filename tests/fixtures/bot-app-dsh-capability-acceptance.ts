/** Paid, controlled App-router/native-worker boundary. No production data writes,
 * embedding, memory service, borrowed Host token or production DSH instance. */
import { app, safeStorage } from 'electron';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import { BUILTIN_BOT_COMPANIONS } from '../../src/shared/builtin-bot-companions';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotToolServer, type BotToolCall } from '../../src/main/companion-bot/tool-server';
import { buildBotContext } from '../../src/main/companion-bot/context';
import { BOT_TOOLS } from '../../src/main/companion-bot/tools';
import { resolveBotModelLimits } from '../../src/main/companion-bot/model-limits';
import type { BotCompanion, BotConversation, BotEvent } from '../../src/main/companion-bot/types';
import { createBotNativeHost } from './bot-native-host';
import { preserveBotNativeJournals } from './bot-native-journal-evidence';
import { createOwnedNativeEffectHost } from './bot-native-effect-host';

const root = process.env.WORLDLINEBOX_BOT_REAL_ROOT!, project = process.env.WORLDLINEBOX_BOT_REAL_PROJECT!;
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!, output = process.env.WORLDLINEBOX_BOT_DSH_CAPABILITY_OUTPUT!;
if (!root || !project || !source || !output || process.env.WORLDLINEBOX_BOT_DSH_CAPABILITY_REAL !== '1') throw new Error('Explicit isolated capability acceptance inputs required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
let secret = '';
const clean = (value: string) => value.replaceAll(secret || '\0', '<redacted>').replace(/Bearer\s+\S+/giu, 'Bearer <redacted>').replace(/\bsk-[a-z0-9_-]{8,}\b/giu, '<redacted>');
type Row = Record<string, unknown>;
const safe = <T>(value: T): T => JSON.parse(clean(JSON.stringify(value))) as T;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

void app.whenReady().then(async () => {
  const cases: Row[] = [], errors: Row[] = [], startup: Row[] = [];
  const report: Row = { kind: 'bot-dsh-capability-result', runId: path.basename(root), passed: false, date: new Date().toISOString(),
    testBoundary: 'Controlled real App Agent + installed DSH native worker boundary, not UI/full Service acceptance or an OS security sandbox.',
    expectedRouterTurns: 2, expectedWorkerTasks: 2, usesRealModel: true, usesRealDsh: true, embeddingStarted: false, memoryStarted: false,
    productionProfileReadOnly: true, productionHostBorrowed: false, cases, errors, startup,
    appHttpRequests: 0, hostStarts: 0, hostGetCalls: 0,
    costs: { nativeProviderRequests: null, currency: null, note: 'App HTTP requests and native tool events are measured; native provider billing is not exposed or guessed.' } };
  const persist = () => writeFile(path.join(output, 'result.partial.json'), clean(JSON.stringify(report, null, 2)) + '\n');
  const phase = (stage: string) => process.send?.({ kind: 'bot-dsh-capability-progress', stage, completed: cases.filter(value => value.passed).length });
  let native: Awaited<ReturnType<typeof createBotNativeHost>> | undefined;
  let router: BotAppBrain | undefined, worker: BotDshBrain | undefined, tools: BotToolServer | undefined;
  const effects = createOwnedNativeEffectHost(path.join(root, 'effect-host.sqlite'));
  try {
    const catalog = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = catalog.profiles.find((entry: { id: string }) => entry.id === catalog.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/u.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw new Error('GLOBAL_MODEL_UNAVAILABLE');
    const configured = resolveStoredLlmConfig(profile);
    const apiKey = safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin'))); secret = apiKey;
    if (!apiKey || !configured.baseUrl || configured.apiFormat !== 'openai_chat') throw new Error('GLOBAL_MODEL_REQUIRES_OPENAI_CHAT');
    const limits = resolveBotModelLimits({ ...configured, baseUrl: configured.baseUrl });
    const model = { ...configured, apiKey, baseUrl: configured.baseUrl, contextWindow: limits.window, maxTokens: Math.min(limits.maxTokens, 2048) };
    report.model = { model: model.model, endpointHost: new URL(model.baseUrl).host, apiFormat: model.apiFormat, limits };
    const records = JSON.parse(await readFile(path.join(source, 'dsh/runtimes.json'), 'utf8')) as Array<{ id: string; adapter: string; version: string }>;
    const installed = records.filter(value => value.adapter === 'node-cli-web-v1').sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
    if (!installed) throw new Error('INSTALLED_DSH_REQUIRED');
    const program = path.join(source, 'dsh/runtimes', installed.id, 'program');
    const desktop = path.join(root, 'Desktop'); await mkdir(desktop);
    const originals = new Map<string, string>();
    for (const suffix of ['.txt', '.json', '.bin']) {
      const name = `owned-${randomBytes(9).toString('hex')}${suffix}`, bytes = randomBytes(16);
      await writeFile(path.join(desktop, name), bytes); originals.set(name, digest(bytes));
    }
    report.expectedNames = [...originals.keys()].sort();
    const bindings = new Map<string, { laneId: string; item: Row; queued?: BotToolCall; taskId?: string }>();
    tools = new BotToolServer(async call => {
      if (effects.owns(call.laneId)) return effects.handle(call);
      const binding = bindings.get(call.eventId);
      if (!binding || binding.laneId !== call.laneId || call.name !== 'dsh_task') throw new Error('CAPABILITY_SCOPE_OR_TOOL_REJECTED');
      if (binding.queued) throw new Error('ONLY_ONE_TASK_PER_ROUTER_TURN_ALLOWED');
      if (typeof call.args.goal !== 'string' || !call.args.goal.trim()) throw new Error('TASK_GOAL_REQUIRED');
      const started = performance.now(); binding.queued = call; binding.taskId = randomUUID();
      const receipt = { taskId: binding.taskId, status: 'queued', submitted: true, completed: false };
      Object.assign(binding.item, safe({ routerTool: { callId: call.callId, name: call.name, args: call.args, receipt, callbackElapsedMs: performance.now() - started } }));
      return receipt;
    });
    router = new BotAppBrain({ root: path.join(root, 'app-brain'), maxSteps: 3, requestTimeoutMs: 90000, fetchFn: async (url, init) => {
      report.appHttpRequests = Number(report.appHttpRequests) + 1; return fetch(url, init);
    } });
    worker = new BotDshBrain({ getHost: async () => {
      report.hostGetCalls = Number(report.hostGetCalls) + 1;
      if (!native) {
        phase('owned-native-host-create');
        native = await createBotNativeHost(program, { onStartup: value => {
          if (value.phase === 'starting-host') report.hostStarts = Number(report.hostStarts) + 1;
          startup.push({ ...value }); phase('native-' + value.phase);
        } });
        process.send?.({ kind: 'bot-real-owned-root', root: native.root });
      }
      const client = await native.instances.ensureHost(native.instance.id);
      report.hostPid = client.pid; report.runtimeVersion = native.runtimeVersion;
      return { client, instance: { id: native.instance.id } };
    } });
    const builtin = BUILTIN_BOT_COMPANIONS.find(value => value.id === 'dafeiyu') ?? BUILTIN_BOT_COMPANIONS[0]!;
    const exposedTools = BOT_TOOLS.filter(value => value.name === 'dsh_task');
    if (exposedTools.length !== 1) throw new Error('CURRENT_DSH_TASK_SCHEMA_REQUIRED');
    for (let index = 0; index < 2; index++) {
      const started = performance.now(), stamp = new Date().toISOString(), eventId = randomUUID(), laneId = `capability-router-${randomUUID()}`;
      const conversationId = randomUUID(), cwd = path.join(root, `task-${index + 1}`); await mkdir(cwd);
      const question = `我桌面有什么文件？本次测试桌面路径 ${desktop}，只列名称，不要读取文件内容，不要修改文件。`;
      const companion: BotCompanion = { id: builtin.id, name: builtin.name, persona: builtin.persona, createdAt: stamp, updatedAt: stamp };
      const conversation: BotConversation = { id: conversationId, title: '桌面只读能力验收', kind: 'direct', memberIds: ['user', companion.id], audienceScopeId: conversationId, securityDomainId: randomUUID(), revision: 1, createdAt: stamp };
      const event: BotEvent = { id: eventId, eventId, laneId, conversationId, companionId: companion.id, source: 'user', sourceInstanceId: 'controlled-capability-acceptance',
        sourceMessageId: eventId, senderId: 'user', senderType: 'user', senderName: '验收用户', audienceScopeId: conversationId, securityDomainId: conversation.securityDomainId,
        aclRevision: 1, sequence: 1, kind: 'message', content: question, payload: {}, correlationId: eventId, sourceMessageRecordId: eventId, sourceMessageSequence: 1,
        replyMessageId: randomUUID(), status: 'running', attempts: 1, occurredAt: stamp, receivedAt: stamp };
      const context = buildBotContext({ companion, conversation, event, participants: [companion], messages: [] });
      if ([...originals.keys()].some(name => (context.system + context.user).includes(name))) throw new Error('EXPECTED_FILENAMES_LEAKED_INTO_ROUTER_PROMPT');
      const item: Row = { index: index + 1, passed: false, input: question, routerEventId: eventId, state: 'router-running', beforeHostStarts: report.hostStarts };
      cases.push(item); const binding = { laneId, item } as { laneId: string; item: Row; queued?: BotToolCall; taskId?: string }; bindings.set(eventId, binding);
      const callback = await tools.forWorker(laneId, eventId); const routerEvents: Row[] = [];
      phase(`router-${index + 1}`); await persist(); const routerStarted = performance.now();
      try {
        const result = await router.run({ laneId, eventId, cwd: root, model, system: context.system, prompt: context.user, tools: exposedTools, callback,
          signal: AbortSignal.timeout(180000), onEvent: value => { if (value.type === 'tool_call') routerEvents.push({ type: value.type, name: value.toolName, callId: value.callId }); } });
        Object.assign(item, { routerReply: clean(result.text), routerStatus: result.status, routerElapsedMs: performance.now() - routerStarted, routerToolEvents: routerEvents });
        if (result.status !== 'succeeded' || !binding.queued || !binding.taskId || !routerEvents.some(value => value.name === 'dsh_task')) throw new Error('ROUTER_DID_NOT_ACTUALLY_DELEGATE_DESKTOP_TASK');
      } finally { tools.releaseWorker(laneId); bindings.delete(eventId); }
      // The callback only queues. This fixture drains the queue after the router
      // has replied, proving the conversational turn does not await native work.
      item.routerCompletedBeforeWorkerStarted = true; item.state = 'worker-running'; await persist(); phase(`worker-${index + 1}`);
      const registered = effects.register(binding.taskId!, String(binding.queued!.args.goal));
      const workerLane = registered.laneId, workerEvent = registered.eventId, workerCallback = await tools.forWorker(workerLane, workerEvent);
      const nativeEvents: Row[] = [], workerStarted = performance.now();
      try {
        const result = await worker.run({ laneId: workerLane, eventId: workerEvent, cwd, role: 'worker', workerAccess: 'full', model, tools: [], callback: workerCallback,
          system: `你是执行器，仅处理当前获准任务。访问范围仅 ${desktop}（只列名称，禁止读内容、写入或删除）与 ${cwd}（仅用于验收报告）。不要访问其他目录或网络。使用真实原生工具完成，禁止猜测。`,
          prompt: `用户原始请求：${question}\n主脑委派：${String(binding.queued!.args.goal)}\n完成只读列目录后，使用真实文件工具在当前工作目录写 report.json，格式为 {"names":["实际名称"]}，只含该目录直接子文件名称。不要仅在回复里声称写好了。`,
          signal: AbortSignal.timeout(300000), onEvent: value => { if (value.type.startsWith('tool_') || ['complete', 'error', 'started'].includes(value.type))
            nativeEvents.push(safe({ type: value.type, toolName: value.toolName, callId: value.callId, summary: value.summary, status: value.status, error: value.error })); } });
        Object.assign(item, { workerLane, workerSessionId: result.sessionId, taskId: binding.taskId, workerReply: clean(result.text), workerStatus: result.status,
          workerElapsedMs: performance.now() - workerStarted, nativeEvents });
        const bytes = await readFile(path.join(cwd, 'report.json')), artifact = JSON.parse(bytes.toString('utf8')) as { names?: unknown };
        const actual = Array.isArray(artifact.names) && artifact.names.every(name => typeof name === 'string') ? [...artifact.names].sort() : [];
        const namesMatch = JSON.stringify(actual) === JSON.stringify([...originals.keys()].sort());
        const untouched = (await readdir(desktop)).length === originals.size && (await Promise.all([...originals].map(async ([name, hash]) => digest(await readFile(path.join(desktop, name))) === hash))).every(Boolean);
        const actualCalls = nativeEvents.filter(value => value.type === 'tool_call');
        await writeFile(path.join(output, `task-${index + 1}-report.json`), bytes);
        Object.assign(item, { workerLane, workerSessionId: result.sessionId, taskId: binding.taskId, workerReply: clean(result.text), workerStatus: result.status,
          workerElapsedMs: performance.now() - workerStarted, totalElapsedMs: performance.now() - started, nativeEvents, actualNativeToolCalls: actualCalls.length,
          afterHostStarts: report.hostStarts, hostStartDelta: Number(report.hostStarts) - Number(item.beforeHostStarts), hostPid: report.hostPid,
          artifact: { name: `task-${index + 1}-report.json`, bytes: bytes.length, sha256: digest(bytes), actualNames: actual, namesMatch, sourceFilesUnchanged: untouched },
          state: 'complete', passed: result.status === 'succeeded' && namesMatch && untouched && actualCalls.length > 0 });
      } catch (error) { Object.assign(item, { state: 'worker-failed', nativeEvents, workerElapsedMs: performance.now() - workerStarted }); throw error; }
      finally {
        tools.releaseWorker(workerLane);
        if (native) item.nativeJournal = await preserveBotNativeJournals(native.root, path.join(output, `task-${index + 1}-native-journals.json`), clean);
      }
      await persist();
      if (item.passed !== true) throw new Error('DESKTOP_TASK_ARTIFACT_OR_NATIVE_TOOL_PROOF_FAILED');
    }
    report.passed = cases.length === 2 && cases.every(value => value.passed) && Number(report.hostStarts) === 1 && cases[1]?.hostStartDelta === 0
      && cases[0]?.hostPid === cases[1]?.hostPid;
  } catch (error) { errors.push({ name: error instanceof Error ? error.name : 'Error', message: clean(error instanceof Error ? error.message : String(error)) }); }
  finally {
    await router?.close().catch(error => errors.push({ stage: 'router-close', message: clean(String(error)) }));
    await worker?.close().catch(error => errors.push({ stage: 'worker-close', message: clean(String(error)) }));
    await tools?.close().catch(error => errors.push({ stage: 'tools-close', message: clean(String(error)) }));
    await native?.close().catch(error => errors.push({ stage: 'native-close', message: clean(String(error)) }));
    report.effects = effects.rows(); effects.close();
    if (errors.length) report.passed = false;
    await persist(); process.send?.(safe(report)); app.exit(report.passed ? 0 : 1);
  }
}).catch(() => { process.send?.({ kind: 'bot-dsh-capability-result', passed: false, failedStage: 'electron-ready' }); app.exit(1); });
