/** Explicit paid-model acceptance: historical native brain or App brain with lazy native workers. */
import { app, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILTIN_BOT_COMPANIONS } from '../../src/shared/builtin-bot-companions';
import type { BotMediaRef } from '../../src/shared/companion-bot-media';
import type { BotReplyTiming } from '../../src/shared/companion-bot';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import { GLOBAL_EMBEDDING_SELECTION_ID } from '../../src/shared/embedding/global-profile';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshHost } from '../../src/main/companion-bot/dsh-brain';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter, type BotBrain } from '../../src/main/companion-bot/brain-router';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { BotMemoryService } from '../../src/main/companion-bot/memory-service';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import { RuntimeIntegrity } from '../../src/main/dsh/runtime-integrity';
import { inventoryTree } from '../../src/main/dsh/files';
import type { TreeInventory, TreeHashCacheEntry, TreeInventoryProgress } from '../../src/main/dsh/files';
import { validateOfficialNodeProgram } from '../../src/main/dsh/node-runtime-service';
import { resolvePortableTools } from '../../src/main/portable-tools';
import { createBotNativeHost } from './bot-native-host';

const root = process.env.WORLDLINEBOX_BOT_REAL_ROOT!, project = process.env.WORLDLINEBOX_BOT_REAL_PROJECT!;
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!, appRouter = process.env.WORLDLINEBOX_BOT_APP_ROUTER === '1';
const conversationOnly = process.env.WORLDLINEBOX_BOT_CONVERSATION_ONLY === '1';
const companionIds = process.env.WORLDLINEBOX_BOT_COMPANION_IDS?.split(',').map(value => value.trim());
if ((conversationOnly || companionIds) && !appRouter) throw new Error('Conversation subset acceptance requires the App router.');
if (companionIds && (!conversationOnly || !companionIds.length || new Set(companionIds).size !== companionIds.length))
  throw new Error('Distinct companion IDs require conversation-only acceptance.');
const selected = companionIds ? companionIds.map(id => {
  const companion = BUILTIN_BOT_COMPANIONS.find(value => value.id === id);
  if (!companion) throw new Error('Unknown builtin companion ID: ' + id);
  return companion;
}) : BUILTIN_BOT_COMPANIONS;
const defaultLabels = conversationOnly ? ['conversation', 'conversation-warm'] : ['conversation', 'history-and-sticker', 'task-and-file'];
const caseLabels = process.env.WORLDLINEBOX_BOT_CASE_LABELS?.split(',').map(value => value.trim()) ?? defaultLabels;
if (caseLabels.length !== defaultLabels.length || caseLabels.some((value, index) => value !== defaultLabels[index]))
  throw new Error('Case labels must match the selected acceptance mode, in order.');
const output = process.env.WORLDLINEBOX_BOT_BATCH_OUTPUT!;
if (!root || !project || !source || !output || (!appRouter && (!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM || !process.env.WORLDLINEBOX_BOT_RUNTIME_ID))
  || process.env.WORLDLINEBOX_BOT_COMPANIONS_REAL !== '1') throw new Error('Explicit isolated batch inputs required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
let secret = '';
const redact = (value: string) => value.replaceAll(secret || '\0', '<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '<redacted>');
const failure = (error: unknown) => redact(error instanceof Error ? error.message : String(error));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const progress = (stage: string, detail: Record<string, unknown> = {}) => process.send?.({ kind: 'bot-companions-progress', stage, ...detail });
type Row = Record<string, unknown>;
interface ToolCall { eventId: string; callId: string; name: string; summary?: string; role: string }
interface Turn { input: string; text: string; durationMs: number; firstTextMs: number | null; timing?: BotReplyTiming;
  beforeHostStarts: number; afterHostStarts: number; beforeGetHostCalls: number; afterGetHostCalls: number;
  toolEventCounts: Record<string, number>; eventId: string; sourceMessageId: string; replyMessageId: string; attachments: BotMediaRef[]; tools: ToolCall[] }

void app.whenReady().then(async () => {
  let service: BotService | undefined, memory: BotMemoryService | undefined, native: Awaited<ReturnType<typeof createBotNativeHost>> | undefined;
  const integrity = new RuntimeIntegrity();
  const embedding = new GlobalEmbeddingService({ userDataPath: path.join(root, 'embedding-state'), bundleDirectory: path.join(project, 'resources/embedding-models'),
    koffiPath: createRequire(path.join(project, 'package.json')).resolve('koffi'), devicePreference: () => ({ backend: 'cpu' }) });
  const gateway = new VcpEmbeddingGateway(embedding), results: Row[] = [], errors: Row[] = [], phases: Row[] = [];
  const host = { instances: 0, getHostCalls: 0, hostStarts: 0, startAttempts: 0, startup: [] as Row[], sharedForAllCompanions: true, version: '' };
  const toolEventCounts: Record<string, number> = {}, perEventToolCounts = new Map<string, Record<string, number>>();
  const brainRuns = { brain: 0, encoder: 0, worker: 0 };
  let active = '', stage = 'configuration', userMessageRequestsSubmitted = 0;
  const report: Row = { kind: 'bot-companions-result', passed: false, date: new Date().toISOString(), expectedCompanions: selected.length,
    ...(conversationOnly ? { acceptanceMode: 'conversation-only', fullChainAcceptance: false, selectedCompanionIds: selected.map(value => value.id), caseLabels } : {}),
    brainRuntime: appRouter ? 'worldlinebox' : 'dsh', usesRealModel: true, usesRealEmbedding: true, usesRealDsh: false, usesRealVcp: true, results, errors, phases, host, toolEventCounts, brainRuns,
    qualityPolicy: 'Raw model responses require human review; transport/tool/byte checks do not establish personality or general answer quality.',
    costs: { providerUsageAndCurrencyAmount: null, note: 'Native transport does not expose exact provider request/token/billing totals. No fee numbers are invented.' } };
  const persist = async () => { await writeFile(path.join(output, 'result.partial.json'), JSON.stringify(report, null, 2) + '\n'); };
  const measured = async <T>(label: string, fn: () => Promise<T>) => {
    stage = label; progress(label, { companionId: active, completed: results.filter(item => item.complete).length });
    const started = performance.now(); try { return await fn(); } finally { phases.push({ companionId: active || undefined, stage: label, durationMs: performance.now() - started }); await persist(); }
  };
  try {
    await mkdir(output, { recursive: true });
    const catalog = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = catalog.profiles.find((entry: { id: string }) => entry.id === catalog.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw new Error('GLOBAL_MODEL_UNAVAILABLE');
    const model = { ...resolveStoredLlmConfig(profile), apiKey: safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin'))) };
    secret = model.apiKey;
    if (model.apiFormat !== 'openai_chat' || !model.apiKey || !model.baseUrl) throw new Error('GLOBAL_MODEL_REQUIRES_OPENAI_CHAT');
    report.model = { model: model.model, endpointHost: new URL(model.baseUrl).host, apiFormat: model.apiFormat };
    const encoded = await measured('embedding-warmup', () => embedding.embed(['伙伴完整效果验收'], { purpose: 'query' }));
    if (encoded.vectors[0]?.length !== 768) throw new Error('BUILTIN_EMBEDDING_INVALID');
    report.embedding = { dimension: 768, model: encoded.profile.modelName, source: encoded.profile.source };
    let nativeHost: Promise<BotDshHost> | undefined;
    const openNativeHost = async (): Promise<BotDshHost> => {
      if (conversationOnly) throw new Error('DSH_DISABLED_FOR_CONVERSATION_ONLY_ACCEPTANCE');
      // App mode reaches this block only through the worker's first getHost.
      // Ordinary chat, capture and VCP do not read the DSH catalog or full tree.
      const records = JSON.parse(await readFile(path.join(source, 'dsh/runtimes.json'), 'utf8')) as Array<{ id: string; adapter: string; version: string; sourceSha256: string; contentSha256: string }>;
      const requested = appRouter ? undefined : process.env.WORLDLINEBOX_BOT_RUNTIME_ID;
      const record = requested ? records.find(entry => entry.id === requested) : records.filter(entry => entry.adapter === 'node-cli-web-v1')
        .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
      if (!record || record.adapter !== 'node-cli-web-v1') throw new Error('INSTALLED_RUNTIME_RECORD_MISSING');
      const runtimeId = record.id, program = appRouter ? path.join(source, 'dsh/runtimes', runtimeId, 'program') : process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!;
      const seal = JSON.parse(await readFile(path.join(source, 'dsh/runtimes', runtimeId, 'seal.json'), 'utf8')) as TreeInventory;
      const cache = new Map<string, TreeHashCacheEntry>();
      const index = JSON.parse(await readFile(path.join(source, 'dsh/integrity', runtimeId + '.json'), 'utf8').catch(() => '{}')) as { digest?: string; entries?: Array<[string, TreeHashCacheEntry]> };
      if (index.digest === record.contentSha256 && Array.isArray(index.entries)) {
        const expected = new Map(seal.files.map(file => [file.path, file.sha256]));
        for (const entry of index.entries) if (expected.get(entry[0]) === entry[1]?.sha256 && typeof entry[1]?.fingerprint === 'string') cache.set(entry[0], entry[1]);
      }
      let verified: TreeInventoryProgress | undefined;
      native = await measured('native-host-create', () => createBotNativeHost(program, {
        onStartup: value => {
          if (value.phase === 'starting-host') host.hostStarts++;
          host.startup.push(value as unknown as Row); progress('native-host-' + value.phase, { elapsedMs: value.elapsedMs });
        },
        verifyRuntime: signal => integrity.verify(path.dirname(program), async () => {
          const started = performance.now(), receipt = await validateOfficialNodeProgram(program, signal);
          if (receipt.sourceSha256 !== record.sourceSha256 || receipt.version !== record.version) throw new Error('OFFICIAL_SOURCE_IDENTITY_MISMATCH');
          const inventory = await inventoryTree(program, AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(300000)]), undefined, cache, value => { verified = value; });
          if (inventory.contentSha256 !== seal.contentSha256 || inventory.contentSha256 !== record.contentSha256) throw new Error('RUNTIME_SEAL_MISMATCH');
          report.runtimeIntegrity = { originalSourceIdentityVerified: true, completeInstalledTreeVerified: true, durationMs: performance.now() - started, verified };
        }, signal),
      }));
      process.send?.({ kind: 'bot-real-owned-root', root: native.root });
      host.instances = 1; host.version = native.runtimeVersion; host.startAttempts++;
      const client = await measured('native-host-startup', () => native!.instances.ensureHost(native!.instance.id));
      report.usesRealDsh = true;
      return { client, instance: { id: native.instance.id } };
    };
    const getHost = async (_instanceId?: string, signal?: AbortSignal): Promise<BotDshHost> => {
      signal?.throwIfAborted(); host.getHostCalls++;
      const value = await (nativeHost ??= openNativeHost()); signal?.throwIfAborted(); return value;
    };
    if (!appRouter) { nativeHost = openNativeHost(); await nativeHost; }
    const botRoot = path.join(root, 'bot'); await mkdir(botRoot);
    const media = new BotMediaService({ root: path.join(botRoot, 'media'), builtinRoot: path.join(project, 'resources/bot-stickers') });
    let memoryNode: Promise<string> | undefined;
    memory = new BotMemoryService({ root: path.join(botRoot, 'memory'), maxActiveDomains: 3,
      runtime: async () => ({ nodePath: appRouter ? await (memoryNode ??= resolvePortableTools({ appPath: project }).then(tools => tools.nodeExecutable))
        : path.join(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!, 'bin/node.exe'), packageRoot: path.join(project, '.tools/bot-memory-release/vcp-memory') }),
      embedding: async () => gateway.configuration(GLOBAL_EMBEDDING_SELECTION_ID, await embedding.resolveProfile()),
      chat: async () => ({ baseUrl: model.baseUrl!, model: model.model, apiKey: model.apiKey, apiType: 'openai-completions' }) });
    const calls: ToolCall[] = [], firstText = new Map<string, number>();
    const worker = new BotDshBrain({ getHost });
    const brain: BotBrain = appRouter ? new BotBrainRouter({ worker, app: new BotAppBrain({ root: path.join(botRoot, 'router'),
      reconcileTool: async call => {
        const saved = service?.store.getMetadata(`effect:${call.eventId}:${call.callId}`);
        if (!saved) return { state: 'unknown' };
        const receipt = JSON.parse(saved) as { fingerprint: string; result: unknown };
        if (receipt.fingerprint !== createHash('sha256').update(JSON.stringify([call.name, call.args])).digest('hex')) throw new Error('APP_TOOL_RECEIPT_PARAMETER_MISMATCH');
        return { state: 'committed', result: receipt.result };
      },
    }) }) : worker;
    const run = brain.run.bind(brain);
    brain.run = input => {
      const role = input.laneId.startsWith('memory-encoder-') ? 'encoder' : input.role ?? 'brain';
      brainRuns[role]++;
      if (conversationOnly && role === 'worker') throw new Error('WORKER_DISABLED_FOR_CONVERSATION_ONLY_ACCEPTANCE');
      return run({ ...input, onEvent: event => {
      if (event.type.startsWith('tool_')) {
        const key = role + ':' + event.type + ':' + (event.toolName ?? 'unknown');
        toolEventCounts[key] = (toolEventCounts[key] ?? 0) + 1;
        const counts = perEventToolCounts.get(input.eventId) ?? {}; counts[key] = (counts[key] ?? 0) + 1; perEventToolCounts.set(input.eventId, counts);
      }
      if (event.type === 'tool_call' && event.callId && event.toolName) calls.push({ eventId: input.eventId, callId: event.callId, name: event.toolName, summary: event.summary && redact(event.summary), role });
      input.onEvent?.(event);
      } });
    };
    service = new BotService({ root: botRoot, brain, ...(appRouter ? { brainRuntime: 'worldlinebox' as const } : {}), memory, media, model: () => ({ ...model, baseUrl: model.baseUrl! }),
      report: error => errors.push({ companionId: active, stage, message: failure(error) }), onEvent: event => {
        if (event.type === 'text' && event.text && !firstText.has(event.messageId)) firstText.set(event.messageId, performance.now());
      } });
    await service.handle({ type: 'state' });
    const send = async (companionId: string, conversationId: string, input: string, attachmentIds?: string[]): Promise<Turn> => {
      userMessageRequestsSubmitted++;
      const beforeHostStarts = host.hostStarts, beforeGetHostCalls = host.getHostCalls;
      const started = performance.now(), accepted = await service!.handle({ type: 'message.send', conversationId, content: input, requestId: randomUUID(), attachmentIds });
      if (!accepted.ok || !accepted.messageId) throw new Error('MESSAGE_NOT_ACCEPTED');
      while (performance.now() - started < 180000) {
        const snapshot = (await service!.handle({ type: 'state', conversationId })).snapshot!;
        const reply = snapshot.messages.find(message => message.senderId === companionId && service!.store.getEvent(message.eventId)?.sourceMessageRecordId === accepted.messageId && ['sent', 'failed', 'cancelled'].includes(message.status));
        if (reply && !['queued', 'running'].includes(service!.store.getEvent(reply.eventId)?.status ?? 'queued')) {
          const published = [reply, ...service!.store.publicationsForEvent(reply.eventId)];
          const turn = { input, text: redact(published.map(message => message.content).filter(Boolean).join('\n')), durationMs: performance.now() - started,
            timing: reply.timing && { ...reply.timing }, beforeHostStarts, afterHostStarts: host.hostStarts, beforeGetHostCalls, afterGetHostCalls: host.getHostCalls,
            toolEventCounts: { ...perEventToolCounts.get(reply.eventId) },
            firstTextMs: firstText.has(reply.id) ? firstText.get(reply.id)! - started : null, eventId: reply.eventId, sourceMessageId: accepted.messageId,
            replyMessageId: reply.id, attachments: published.flatMap(message => message.attachments ?? []), tools: calls.filter(call => call.eventId === reply.eventId) };
          if (reply.status !== 'sent') throw Object.assign(new Error('REPLY_' + reply.status + ': ' + (reply.error ?? '')), { turn });
          return turn;
        }
        await pause(100);
      }
      throw new Error('MESSAGE_TIMEOUT');
    };
    const receipts = (turn: Turn, name: string) => turn.tools.filter(call => call.name === name).map(call => {
      const value = service!.store.getMetadata(`effect:${call.eventId}:${call.callId}`);
      return { ...call, receipt: value ? JSON.parse(redact(value)) as unknown : undefined };
    });
    for (const companion of selected) {
      active = companion.id;
      const item: Row = { id: companion.id, name: companion.name, complete: false, passed: false, cases: {}, additionalDeliveryRequests: 0 };
      results.push(item); await persist(); const cases = item.cases as Row;
      const conversation = service.store.openDirect(companion.id), conversationId = conversation.id;
      const beforeOrdinary = { hostStarts: host.hostStarts, getHostCalls: host.getHostCalls, encoderRuns: brainRuns.encoder };
      for (const label of caseLabels) {
        try {
          if (label === 'conversation' || label === 'conversation-warm') {
            const input = label === 'conversation-warm' ? '我先把废纸放进袋子，接下来呢？自然简短陪我继续，不启动任务，不假装替我动手。'
              : '今晚我只有20分钟，想和你一起整理桌面上的一个小角落。你会怎么陪我开始？请自然地说两三句话，不启动任务，也不要假装已经替我整理。';
            const turn = await measured(label, () => send(companion.id, conversationId, input));
            const nativeIsolation = { hostStarts: turn.afterHostStarts, getHostCalls: turn.afterGetHostCalls, workerRuns: brainRuns.worker,
              passed: turn.afterHostStarts === 0 && turn.afterGetHostCalls === 0 && brainRuns.worker === 0 };
            cases[label] = { passed: true, turn, humanQualityReviewRequired: true, tasksCreated: service.store.listTasks(conversationId).length,
              ...(conversationOnly ? { nativeIsolation } : {}) };
            if (service.store.listTasks(conversationId).length) throw new Error('UNREQUESTED_TASK');
            if (conversationOnly && !nativeIsolation.passed) throw new Error('CONVERSATION_NATIVE_ISOLATION_FAILED');
          } else if (label === 'history-and-sticker') {
            const turn = await measured(label, () => send(companion.id, conversationId, '请实际调用 memory_history 回查我刚才的原话，核对今晚的时间限制。再先查表情库，挑一张适合一起开工的真实表情发到聊天里，最后简短接一句；不启动任务，不用文字冒充发图。'));
            const history = receipts(turn, 'memory_history'), sticker = receipts(turn, 'chat_send_sticker'), search = receipts(turn, 'chat_list_stickers');
            const mediaResults: Row[] = [];
            for (const ref of turn.attachments.filter(ref => ref.kind === 'sticker')) {
              const response = await media.response(new Request(ref.url)), bytes = Buffer.from(await response.arrayBuffer());
              mediaResults.push({ id: ref.id, name: ref.name, originalName: ref.originalName, mimeType: ref.mimeType, animated: ref.animated,
                status: response.status, originalBytesVerified: response.status === 200 && createHash('sha256').update(bytes).digest('hex') === ref.sha256 });
            }
            cases[label] = { turn, history, sticker, search, media: mediaResults, humanQualityReviewRequired: true,
              passed: history.some(value => value.receipt) && sticker.some(value => value.receipt) && search.some(value => value.receipt)
                && mediaResults.some(value => value.originalBytesVerified) && service.store.listTasks(conversationId).length === 0 };
            if (appRouter) {
              // Include background capture before proving that the first two
              // rounds did not silently initialize a native Host after reply.
              const deadline = Date.now() + 120000;
              let jobs: Array<{ kind: string; status: string; error?: string }>;
              for (;;) {
                jobs = service.store.taskTransaction(sql => sql.prepare("SELECT kind,status,error FROM bot_memory_jobs WHERE json_extract(payload_json,'$.scope.conversationId')=? ORDER BY sequence").all(conversationId)) as typeof jobs;
                if (!jobs.some(job => ['queued', 'running'].includes(job.status))) break;
                if (Date.now() >= deadline) throw new Error('APP_BACKGROUND_MEMORY_TIMEOUT');
                await pause(100);
              }
              const proof = { beforeHostStarts: beforeOrdinary.hostStarts, afterHostStarts: host.hostStarts,
                beforeGetHostCalls: beforeOrdinary.getHostCalls, afterGetHostCalls: host.getHostCalls,
                encoderRuns: brainRuns.encoder - beforeOrdinary.encoderRuns, backgroundMemoryJobs: jobs.map(job => ({ ...job, error: job.error && redact(job.error) })),
                passed: host.hostStarts === beforeOrdinary.hostStarts && host.getHostCalls === beforeOrdinary.getHostCalls
                  && brainRuns.encoder > beforeOrdinary.encoderRuns && jobs.some(job => job.kind === 'capture' && job.status === 'done') && jobs.every(job => job.status === 'done') };
              item.ordinaryAndMemoryNativeIsolation = proof;
              if (!proof.passed) throw new Error('APP_ORDINARY_MEMORY_NATIVE_ISOLATION_FAILED');
            }
          } else {
            const filename = path.join(root, 'numbers.txt'); await writeFile(filename, '3,5,8\n');
            const [ref] = await media.importFiles({ conversationId, paths: [filename] });
            const taskStarted = performance.now();
            const submit = await measured(label + '-submit-reply', () => send(companion.id, conversationId,
              '请只创建一个独立 dsh_task。目标：读取本条真实文本附件，提取文件内数字并求和，把结果写入任务工作区 sum-proof.txt（只写最终数字），实际再读取核验，最后使用 worker_chat_send_file 把文件发送回当前聊天。不要在任务目标里猜答案，不要重复创建任务。', [ref!.id]));
            let task = service.store.listTasks(conversationId)[0]; const deadline = Date.now() + 240000;
            while ((!task || !['succeeded', 'failed', 'cancelled', 'waiting', 'unknown'].includes(task.status)) && Date.now() < deadline) { await pause(150); task = service.store.listTasks(conversationId)[0]; }
            if (!task) throw new Error('NO_TASK_CREATED');
            const taskDurationMs = performance.now() - taskStarted;
            const artifact = path.join(botRoot, 'workspaces', createHash('sha256').update(conversation.securityDomainId).digest('hex'), task.id, 'sum-proof.txt');
            const actualBytes = await readFile(artifact).catch(() => undefined);
            let outputs = service.store.publicationsForTask(task.id);
            if (task.status === 'succeeded' && !outputs.length) {
              item.additionalDeliveryRequests = 1;
              item.additionalDelivery = await measured('task-file-one-followup', () => send(companion.id, conversationId, `请把刚才任务 ${task.id} 的 sum-proof.txt 作为真实附件发回；如果已有发送回执就核对即可，不要创建新任务。`));
              outputs = service.store.publicationsForTask(task.id);
            }
            const published: Row[] = [];
            for (const output of outputs) for (const attachmentId of output.attachmentIds) {
              const file = await media.getForAgent(conversationId, attachmentId);
              if (file.ref.name === 'sum-proof.txt') published.push({ messageId: output.messageId, attachmentId, name: file.ref.name,
                bytes: (await readFile(file.path)).toString('utf8'), sha256: file.ref.sha256 });
            }
            const effects = service.store.taskTransaction(sql => sql.prepare('SELECT call_id,tool_name,preview,state,is_error FROM bot_task_effects WHERE task_id=? ORDER BY created_at').all(task!.id)) as Row[];
            const taskCalls = calls.filter(call => call.eventId === `work-${task.id}`);
            cases[label] = { submit, taskId: task.id, status: task.status, summary: task.summary && redact(task.summary), error: task.error,
              taskCount: service.store.listTasks(conversationId).length, taskDurationMs, submittedThroughActualTool: receipts(submit, 'dsh_task'),
              input: { originalBytes: '3,5,8\n', name: ref!.name, staged: task.extra.inputFiles }, outputBytes: actualBytes?.toString('utf8'),
              workerTools: taskCalls, effects: effects.map(value => ({ ...value, preview: redact(String(value.preview)) })), publications: published,
              passed: task.status === 'succeeded' && service.store.listTasks(conversationId).length === 1 && actualBytes?.toString('utf8').trim() === '16'
                && published.some(value => String(value.bytes).trim() === '16') && taskCalls.some(call => ['read', 'pwsh', 'shell'].includes(call.name)) };
          }
        } catch (error) { cases[label] = { ...(cases[label] as Row ?? {}), passed: false, error: failure(error), ...((error as { turn?: Turn }).turn ? { turn: (error as { turn: Turn }).turn } : {}) }; }
        await persist();
      }
      if (conversationOnly) {
        try {
          // Wait for actual App capture, not only the visible reply, before
          // asserting that this ordinary two-turn run never reached DSH.
          const deadline = Date.now() + 120000;
          let jobs: Array<{ kind: string; status: string; error?: string }>;
          for (;;) {
            jobs = service.store.taskTransaction(sql => sql.prepare("SELECT kind,status,error FROM bot_memory_jobs WHERE json_extract(payload_json,'$.scope.conversationId')=? ORDER BY sequence").all(conversationId)) as typeof jobs;
            if (!jobs.some(job => ['queued', 'running'].includes(job.status))) break;
            if (Date.now() >= deadline) throw new Error('APP_BACKGROUND_MEMORY_TIMEOUT');
            await pause(100);
          }
          const proof = { beforeHostStarts: beforeOrdinary.hostStarts, afterHostStarts: host.hostStarts,
            beforeGetHostCalls: beforeOrdinary.getHostCalls, afterGetHostCalls: host.getHostCalls,
            encoderRuns: brainRuns.encoder - beforeOrdinary.encoderRuns, workerRuns: brainRuns.worker,
            backgroundMemoryJobs: jobs.map(job => ({ ...job, error: job.error && redact(job.error) })),
            passed: host.hostStarts === 0 && host.getHostCalls === 0 && brainRuns.worker === 0
              && service.store.listTasks(conversationId).length === 0 && brainRuns.encoder > beforeOrdinary.encoderRuns
              && jobs.some(job => job.kind === 'capture' && job.status === 'done') && jobs.every(job => job.status === 'done') };
          item.ordinaryAndMemoryNativeIsolation = proof;
          if (!proof.passed) throw new Error('APP_ORDINARY_MEMORY_NATIVE_ISOLATION_FAILED');
        } catch (error) { cases['conversation-warm'] = { ...(cases['conversation-warm'] as Row ?? {}), passed: false, error: failure(error) }; }
        await persist();
      }
      // Let the actual task notice settle before LRU eviction or the next partner.
      const quietDeadline = Date.now() + 60000;
      while (Date.now() < quietDeadline) {
        const pending = service.store.taskTransaction(sql => sql.prepare("SELECT COUNT(*) AS n FROM bot_inbox WHERE conversation_id=? AND status IN ('queued','running')").get(conversationId)) as { n: number };
        if (!pending.n) break; await pause(150);
      }
      item.noticeReplies = (await service.handle({ type: 'state', conversationId })).snapshot!.messages.filter(message => service!.store.getEvent(message.eventId)?.source === 'task' && message.senderId === companion.id && message.status === 'sent')
        .map(message => ({ text: redact(message.content), createdAt: message.createdAt, timing: message.timing }));
      item.passed = Object.values(cases).every(value => (value as Row).passed === true); item.complete = true;
      progress('companion-complete', { companionId: companion.id, name: companion.name, passed: item.passed, completed: results.length, total: selected.length }); await persist();
    }
    report.passed = results.length === selected.length && results.every(item => item.passed === true);
    report.completedCompanions = results.length;
  } catch (error) { report.failedStage = stage; report.failure = failure(error); }
  finally {
    await service?.shutdown().catch(error => errors.push({ stage: 'shutdown', message: failure(error) })); await memory?.close().catch(() => undefined);
    await native?.close().catch(error => errors.push({ stage: 'native-close', message: failure(error) })); integrity.close(); await gateway.close(); await embedding.close();
    report.userMessageRequestsSubmitted = userMessageRequestsSubmitted;
    await persist(); process.send?.(report); app.exit(report.passed ? 0 : 1);
  }
}).catch(() => { process.send?.({ kind: 'bot-companions-result', passed: false, failedStage: 'electron-ready' }); app.exit(1); });
