/** Opt-in real service acceptance. No synthetic model or embedding outputs. */
import { app, safeStorage } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotMemoryService } from '../../src/main/companion-bot/memory-service';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import { GLOBAL_EMBEDDING_SELECTION_ID } from '../../src/shared/embedding/global-profile';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import { createBotNativeHost } from './bot-native-host';
import { startBotProtocolModel } from './bot-protocol-model';
import { assertPreferenceCapture, captureJobId } from './bot-acceptance-evidence';
import { BotMediaService } from '../../src/main/companion-bot/media-service';

const root = process.env.WORLDLINEBOX_BOT_REAL_ROOT!, project = process.env.WORLDLINEBOX_BOT_REAL_PROJECT!;
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!;
const protocolMode = process.env.WORLDLINEBOX_BOT_PROTOCOL_ACCEPTANCE === '1';
if (!root || !source || !project || !protocolMode && process.env.WORLDLINEBOX_BOT_REAL_ACCEPTANCE !== '1') throw new Error('Bot acceptance requires explicit isolated inputs.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
const progress = (stage: string, counts: Record<string, number | string | boolean> = {}) => process.send?.({ kind: 'bot-real-progress', stage, ...counts });
const phases: Array<{ stage: string; durationMs: number }> = [];
const errors: Array<{ name: string; code?: string; phase: string; message?: string }> = [];
let secret = '';
const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replaceAll(secret || '\0', '<redacted>')
  .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').replace(/\b[a-f0-9]{64}\b/gi, '<digest>').slice(0, 2000);
const measured = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
  progress(stage); const start = performance.now();
  try { return await work(); } finally { phases.push({ stage, durationMs: performance.now() - start }); }
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

void app.whenReady().then(async () => {
  let service: BotService | undefined, native: Awaited<ReturnType<typeof createBotNativeHost>> | undefined;
  let memory: BotMemoryService | undefined;
  let protocolModel: Awaited<ReturnType<typeof startBotProtocolModel>> | undefined;
  const embedding = new GlobalEmbeddingService({ userDataPath: path.join(root, 'embedding-state'),
    bundleDirectory: path.join(project, 'resources/embedding-models'), koffiPath: createRequire(path.join(project, 'package.json')).resolve('koffi'),
    devicePreference: () => ({ backend: 'cpu' }) });
  const gateway = new VcpEmbeddingGateway(embedding);
  let stage = 'start';
  const report: Record<string, unknown> = { kind: 'bot-real-result', passed: false, phases, errors, usesRealModel: !protocolMode, usesRealEmbedding: true };
  try {
    stage = 'global-model';
    let model;
    if (protocolMode) { protocolModel = await startBotProtocolModel(); model = { apiFormat: 'openai_chat' as const, model: 'protocol-fixture', baseUrl: protocolModel.baseUrl, apiKey: 'protocol-fixture-no-secret' }; }
    else {
      const catalog = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
      const profile = catalog.profiles.find((entry: { id: string }) => entry.id === catalog.activeProfileId);
      if (!profile || !/^ai_[a-f0-9]{24}$/.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw new Error('GLOBAL_MODEL_UNAVAILABLE');
      model = { ...resolveStoredLlmConfig(profile), apiKey: safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin'))) };
    }
    secret = model.apiKey;
    if (model.apiFormat !== 'openai_chat' || !model.baseUrl || !model.apiKey) throw new Error('GLOBAL_MODEL_REQUIRES_OPENAI_CHAT');
    report.model = { apiFormat: model.apiFormat, model: model.model, endpointHost: new URL(model.baseUrl).host };
    stage = 'embedding-warmup';
    const encoded = await measured(stage, () => embedding.embed(['世界线盒子新主脑验收'], { purpose: 'query' }));
    if (encoded.vectors.length !== 1 || encoded.vectors[0]?.length !== 768 || encoded.vectors[0].some(value => !Number.isFinite(value))) throw new Error('BUILTIN_EMBEDDING_INVALID');
    report.embedding = { dimension: encoded.profile.dimension, model: encoded.profile.modelName, source: encoded.profile.source };
    stage = 'native-host';
    native = await measured(stage, () => createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!));
    process.send?.({ kind: 'bot-real-owned-root', root: native.root });
    let client = await native.instances.ensureHost(native.instance.id);
    report.dsh = { version: native.runtimeVersion };
    const botRoot = path.join(root, 'bot'); await mkdir(botRoot, { recursive: true });
    const media = new BotMediaService({ root: path.join(botRoot, 'media'), builtinRoot: path.join(project, 'resources/bot-stickers') });
    let streamCount = 0, firstText = 0;
    const nativeCalls = new Map<string, { eventId: string; callId: string; name: string }>();
    const makeService = () => {
      memory = new BotMemoryService({ root: path.join(botRoot, 'memory'),
        runtime: async () => ({ nodePath: path.join(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!, 'bin/node.exe'), packageRoot: path.join(project, '.tools/bot-memory-release/vcp-memory') }),
        embedding: async () => gateway.configuration(GLOBAL_EMBEDDING_SELECTION_ID, await embedding.resolveProfile()),
        chat: async () => ({ baseUrl: model.baseUrl!, model: model.model, apiKey: model.apiKey, apiType: 'openai-completions' }),
      });
      const worker = new BotDshBrain({ getHost: async () => ({ client }) });
      const appBrain = new BotAppBrain({ root: path.join(botRoot, 'router'),
        reconcileTool: (call, signal) => service ? service.reconcileToolReceipt(call, signal) : Promise.resolve({ state: 'unknown' as const }) });
      const brain = new BotBrainRouter({ app: appBrain, worker }), run = brain.run.bind(brain);
      brain.run = input => run({ ...input, onEvent: event => {
        if (event.type === 'tool_call' && event.callId && event.toolName) nativeCalls.set(`${input.eventId}:${event.callId}`, { eventId: input.eventId, callId: event.callId, name: event.toolName });
        input.onEvent?.(event);
      } });
      return new BotService({ root: botRoot, brain, brainRuntime: 'worldlinebox', memory, media, model: () => ({ ...model, baseUrl: model.baseUrl! }),
        retention: { maxTurns: 3 },
        report: error => errors.push({ phase: stage, name: error instanceof Error ? error.name : 'Error', code: String((error as { code?: string })?.code ?? ''), message: safeError(error) }),
        onEvent: event => { if (event.type === 'text') { streamCount++; firstText ||= performance.now(); } } });
    };
    service = makeService();
    let snapshot = (await service.handle({ type: 'state' })).snapshot!;
    const companionId = DEFAULT_BOT_COMPANION_ID;
    if (!snapshot.companions.some(companion => companion.id === companionId)) throw new Error('BUILTIN_COMPANION_MISSING');
    const conversationId = service.store.openDirect(companionId).id;
    const send = async (content: string, attachmentIds?: string[], targetConversationId = conversationId, respondingCompanionId = companionId) => {
      const input = await service!.handle({ type: 'message.send', conversationId: targetConversationId, content, requestId: randomUUID(), ...(attachmentIds?.length ? { attachmentIds } : {}) });
      if (!input.ok || !input.messageId) throw new Error('INPUT_NOT_ACCEPTED');
      const sent = service!.store.getMessage(input.messageId)!;
      const started = performance.now(); firstText = 0;
      while (performance.now() - started < 180000) {
        snapshot = (await service!.handle({ type: 'state', conversationId: targetConversationId })).snapshot!;
        const reply = snapshot.messages.find(message => message.sequence > sent.sequence && message.senderId === respondingCompanionId
          && service!.store.getEvent(message.eventId)?.sourceMessageRecordId === input.messageId && ['sent', 'failed', 'cancelled'].includes(message.status));
        if (reply && !['queued', 'running'].includes(service!.store.getEvent(reply.eventId)?.status ?? 'queued')) {
          if (reply.status !== 'sent') throw new Error('REPLY_' + reply.status.toUpperCase());
          const published = [...new Map([...snapshot.messages.filter(message => message.eventId === reply.eventId && message.senderId === respondingCompanionId && message.status === 'sent'),
            ...service!.store.publicationsForEvent(reply.eventId)].map(message => [message.id, message])).values()];
          return { text: published.map(message => message.content).filter(Boolean).join('\n'), attachments: published.flatMap(message => message.attachments ?? []), milliseconds: performance.now() - started, firstTextMs: firstText ? firstText - started : null,
            eventId: reply.eventId, sourceMessageId: input.messageId, replyMessageId: reply.id };
        }
        await pause(100);
      }
      throw new Error('REPLY_TIMEOUT');
    };
    stage = 'ordinary-chat';
    const ordinary = await measured(stage, () => send('你好，这是新伙伴系统的开发验收。请用一句简短中文问候，不调用任务工具。'));
    report.ordinary = { durationMs: ordinary.milliseconds, firstTextMs: ordinary.firstTextMs, outputChars: ordinary.text.length };
    stage = 'memory-write';
    await measured(stage, async () => { const result = await service!.handle({ type: 'memory.remember', conversationId, companionId,
      content: '开发验收事实：测试项目代号为青榆舟。该代号只属于本次验收，状态已经确认。' }); if (!result.ok) throw new Error('MEMORY_WRITE_FAILED'); });
    stage = 'memory-search';
    const recall = await measured(stage, () => service!.handle({ type: 'memory.search', conversationId, companionId, query: '测试项目的代号是什么' }));
    if (!recall.ok || !JSON.stringify(recall.memory).includes('青榆舟')) throw new Error('MEMORY_FACT_NOT_RECALLED');
    report.memory = { semanticRecallPassed: true };
    stage = 'model-memory-tool';
    const recalled = await measured(stage, () => send('请先调用 memory_search 查询测试项目代号，再依据真实检索结果告诉我代号。'));
    if (!recalled.text.includes('青榆舟')) throw new Error('MODEL_DID_NOT_USE_MEMORY_FACT');
    const searchReceipts = [...nativeCalls.values()].filter(call => call.eventId === recalled.eventId && call.name === 'memory_search')
      .map(call => service!.store.getMetadata(`effect:${call.eventId}:${call.callId}`)).filter((value): value is string => !!value)
      .map(value => JSON.parse(value) as { fingerprint?: string; result?: unknown });
    if (!searchReceipts.some(receipt => receipt.fingerprint && JSON.stringify(receipt.result).includes('青榆舟'))) throw new Error('MODEL_MEMORY_SEARCH_HAS_NO_ACTUAL_TOOL_RECEIPT');
    report.memoryModel = { answerHasFact: true, outputChars: recalled.text.length, actualMemorySearchReceipts: searchReceipts.length };
    stage = 'automatic-capture';
    const preference = await measured(stage, () => send('验收偏好更新：从今天起，晚上喝麦茶，上午仍喝咖啡；不是全天都不喝咖啡。请按这个范围理解。'));
    const captureDeadline = Date.now() + 120000;
    let job = service.store.getMemoryJob(captureJobId(preference.eventId));
    while (job && job.status !== 'done' && job.status !== 'failed' && Date.now() < captureDeadline) { await pause(200); job = service.store.getMemoryJob(captureJobId(preference.eventId)); }
    const conversationScope = service.store.getConversation(conversationId)!;
    const captureEvidence = assertPreferenceCapture({ ...preference, job,
      notes: await memory!.list({ companionId, conversationId, securityDomainId: conversationScope.securityDomainId }) });
    const captured = await service.handle({ type: 'memory.search', conversationId, companionId, query: '验收夜间饮料偏好是什么，上午是否仍喝咖啡' });
    if (!JSON.stringify(captured.memory).includes('麦茶') || !JSON.stringify(captured.memory).includes('咖啡')) throw new Error('AUTOMATIC_CAPTURE_NOT_RECALLED');
    report.capture = { recordedAndRecalled: true, ...captureEvidence };
    if (!protocolMode) {
      stage = 'companion-sticker';
      const expression = await measured(stage, () => send('大肥鱼，今天很开心。请先查一下可用的表情，再挑一张合适的“你真棒”或开心的真实表情发给我，我们来斗图。不创建任务，不用文字冒充发图。'));
      report.stickerAttempt = { text: safeError(expression.text), media: expression.attachments.map(ref => ({ id: ref.id, kind: ref.kind, animated: ref.animated, name: ref.name })),
        tools: [...nativeCalls.values()].filter(call => call.eventId === expression.eventId).map(call => call.name) };
      if (!expression.attachments.some(item => item.kind === 'sticker' && item.animated)) throw new Error('COMPANION_DID_NOT_SEND_ACTUAL_STICKER');
      const receipt = [...nativeCalls.values()].find(call => call.eventId === expression.eventId && call.name === 'chat_send_sticker');
      if (!receipt || !service.store.getMetadata(`effect:${receipt.eventId}:${receipt.callId}`)) throw new Error('STICKER_HAS_NO_DURABLE_TOOL_RECEIPT');
      const original = await media.response(new Request(expression.attachments[0]!.url));
      if (original.status !== 200 || createHash('sha256').update(Buffer.from(await original.arrayBuffer())).digest('hex') !== expression.attachments[0]!.sha256) throw new Error('STICKER_ORIGINAL_MEDIA_INVALID');
      report.sticker = { actualPublished: true, animated: true, originalMediaVerified: true };
    }
    stage = 'delegated-task';
    let inputIds: string[] | undefined;
    if (!protocolMode) {
      const inputFile = path.join(root, 'numbers.txt'); await writeFile(inputFile, '输入数字：3,5,8\n');
      inputIds = (await media.importFiles({ conversationId, paths: [inputFile] })).map(item => item.id);
    }
    await measured(stage, () => send('请实际调用 dsh_task 创建一个独立任务，标题“验收文件”。目标：在任务自己的工作区创建 cedar-proof.txt，内容严格为 WLB_SUPER_AGENT_OK，然后读取该文件验证。'
      + (protocolMode ? '' : '同时读取这条消息的 numbers.txt 真实附件，计算其中数字之和，写入 sum-proof.txt（只写数字），再读取核验。请把任务实际产出的文件发回这段聊天。')
      + '现在提交这个任务，完成后通过任务回执告诉我。', inputIds));
    const deadline = Date.now() + 180000;
    let task = service.store.listTasks(conversationId)[0];
    while ((!task || !['succeeded', 'failed', 'cancelled'].includes(task.status)) && Date.now() < deadline) {
      await pause(250); task = service.store.listTasks(conversationId)[0];
    }
    if (!task || task.status !== 'succeeded') throw new Error('DELEGATED_TASK_NOT_SUCCEEDED');
    const conversation = service.store.getConversation(conversationId)!;
    const artifact = path.join(botRoot, 'workspaces', ...(task.extra.workspaceLayout === 'companion-v1'
      ? [createHash('sha256').update(task.companionId).digest('hex')] : []), createHash('sha256').update(conversation.securityDomainId).digest('hex'), task.id, 'cedar-proof.txt');
    if ((await readFile(artifact, 'utf8')).trim() !== 'WLB_SUPER_AGENT_OK') throw new Error('DELEGATED_ARTIFACT_INVALID');
    report.task = { count: service.store.listTasks(conversationId).length, status: task.status, artifactVerified: true };
    if (!protocolMode) {
      if ((await readFile(path.join(path.dirname(artifact), 'sum-proof.txt'), 'utf8')).trim() !== '16') throw new Error('ATTACHMENT_TASK_DID_NOT_READ_REAL_INPUT');
      stage = 'companion-file-delivery';
      const beforeDelivery = (await service.handle({ type: 'state', conversationId })).snapshot!;
      const previousDeliveries = beforeDelivery.messages.filter(message => message.senderId === companionId && message.status === 'sent')
        .flatMap(message => message.attachments ?? []).filter(item => item.name === 'cedar-proof.txt').length;
      const delivery = await measured(stage, () => send(`请把刚才任务 ${task.id} 的 cedar-proof.txt 实际附件发送到当前聊天；若任务已发过同一文件，核对已有发送回执即可，不新建任务。`));
      const deliveredState = (await service.handle({ type: 'state', conversationId })).snapshot!;
      const sharedFiles = deliveredState.messages.filter(message => message.senderId === companionId && message.status === 'sent').flatMap(message => message.attachments ?? []);
      const publishedFile = sharedFiles.find(item => item.name === 'cedar-proof.txt');
      if (!publishedFile) throw new Error('COMPANION_FILE_NOT_DELIVERED');
      const finalDeliveries = sharedFiles.filter(item => item.name === 'cedar-proof.txt').length;
      report.fileDeliveryAttempt = { previousDeliveries, finalDeliveries, text: safeError(delivery.text),
        taskOutputs: deliveredState.tasks.find(item => item.id === task.id)?.outputs,
        receipts: [...nativeCalls.values()].filter(call => call.name === 'chat_send_file' || call.name === 'worker_chat_send_file')
          .map(call => ({ eventId: call.eventId, name: call.name, receipt: safeError(service!.store.getMetadata(`effect:${call.eventId}:${call.callId}`) ?? '') })) };
      if (finalDeliveries !== Math.max(1, previousDeliveries)) throw new Error('CONDITIONAL_FILE_DELIVERY_DUPLICATED');
      if (!deliveredState.tasks.find(item => item.id === task.id)?.outputs?.some(output => output.attachmentIds.includes(publishedFile.id))) throw new Error('TASK_CARD_MISSING_ACTUAL_DELIVERY_RECEIPT');
      const actual = await media.getForAgent(conversationId, publishedFile.id);
      if ((await readFile(actual.path, 'utf8')).trim() !== 'WLB_SUPER_AGENT_OK') throw new Error('COMPANION_FILE_BYTES_INVALID');
      report.fileDelivery = { inputReadAndSumVerified: true, actualPublished: true, contentVerified: true, conditionalDeliveryNotDuplicated: true,
        previousDeliveries, finalDeliveries, taskCardHasReceipt: true, followupChars: delivery.text.length };
    }
    stage = 'restart';
    await service.shutdown(); service = undefined;
    await native.instances.stop(native.instance.id); client = await native.instances.ensureHost(native.instance.id);
    service = makeService();
    stage = 'restart-continuity';
    const afterRestart = await measured(stage, () => send('继续刚才的验收：请核对记忆后告诉我测试项目代号，并简短说明刚才文件任务是否已经完成。不要再创建新任务。'));
    if (!afterRestart.text.includes('青榆舟') || service.store.listTasks(conversationId).length !== 1) throw new Error('RESTART_CONTINUITY_FAILED');
    report.restart = { factRetained: true, tasksNotDuplicated: service.store.listTasks(conversationId).length === 1, outputChars: afterRestart.text.length };
    if (!protocolMode) {
      stage = 'peer-sticker-chat';
      const group = await service.handle({ type: 'conversation.create', title: '伙伴斗图验收', kind: 'group', memberIds: [companionId, 'gpt'], participationMode: 'mentions' });
      if (!group.ok || !group.conversationId) throw new Error('PEER_GROUP_NOT_CREATED');
      await measured(stage, () => send('@大肥鱼 请先查询真实可用的表情，选一张友好的表情，通过 message_peer 工具把表情作为附件发送给本群的 GPT。给它的文字写“GPT，给你一张表情，收到后也选一张真实表情回到群里吧”。请实际发送，不用创建任务。', undefined, group.conversationId));
      const end = Date.now() + 180000; let groupState;
      while (Date.now() < end) {
        groupState = (await service.handle({ type: 'state', conversationId: group.conversationId })).snapshot!;
        if (groupState.messages.some(message => message.senderId === 'gpt' && message.status === 'sent' && message.attachments?.some(item => item.kind === 'sticker'))) break;
        await pause(200);
      }
      const peers = groupState?.messages.filter(message => message.status === 'sent' && message.attachments?.some(item => item.kind === 'sticker')) ?? [];
      if (!peers.some(message => message.senderId === companionId) || !peers.some(message => message.senderId === 'gpt')) throw new Error('PEER_DID_NOT_EXCHANGE_ACTUAL_STICKERS');
      const received = groupState!.messages.filter(message => message.senderId === 'gpt').map(message => service!.store.getEvent(message.eventId))
        .find(event => event?.source === 'companion' && event.senderId === companionId && Array.isArray(event.payload.attachments) && event.payload.attachments.length);
      if (!received) throw new Error('PEER_HAS_NO_ACTUAL_MEDIA_INBOX');
      if (groupState!.messages.some(message => message.content.includes('青榆舟'))) throw new Error('PRIVATE_FACT_LEAKED_TO_GROUP');
      report.peerChat = { realMediaExchanged: true, peerReceivedAttachmentEvent: true, privateFactAbsent: true, participantIdsFromHost: true };
    }
    if (protocolMode) {
      for (let index = 0; index < 6; index++) await send(`连续对话交接验收 ${index + 1}：保持同一聊天，只简短确认，不创建任务。`);
    }
    {
      const latest = (await service.handle({ type: 'state', conversationId })).snapshot!.messages.findLast(message => message.senderId === companionId && message.status === 'sent');
      const event = latest && service.store.getEvent(latest.eventId), lane = event && service.store.getLane(event.laneId);
      if (!lane || lane.epoch < (protocolMode ? 3 : 2) || protocolMode && !protocolModel?.counters.summaries) throw new Error('NATIVE_LANE_HANDOFF_NOT_EXERCISED');
      report.retention = { epoch: lane.epoch, ...(protocolModel ? { nativeSummaries: protocolModel.counters.summaries } : {}), sameConversationId: true, stressTurnThreshold: 3 };
    }
    report.nativeTools = Object.fromEntries([...new Set([...nativeCalls.values()].map(call => call.name))].map(name => [name, [...nativeCalls.values()].filter(call => call.name === name).length]));
    report.streamEvents = streamCount; report.passed = true;
    if (protocolModel) report.protocolFixture = protocolModel.counters;
  } catch (error) {
    report.failedStage = stage; report.failure = { name: error instanceof Error ? error.name : 'Error', code: (error as { code?: string })?.code,
      message: safeError(error) };
  } finally {
    if (protocolModel) report.protocolFixture = protocolModel.counters;
    stage = 'shutdown';
    await service?.shutdown().catch(error => errors.push({ phase: stage, name: error instanceof Error ? error.name : 'Error' }));
    await memory?.close().catch(() => undefined); await native?.close().catch(() => undefined);
    await gateway.close(); await embedding.close();
    await protocolModel?.close();
    await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
    process.send?.(report); app.exit(report.passed ? 0 : 1);
  }
}).catch(() => { process.send?.({ kind: 'bot-real-result', passed: false, failedStage: 'electron-ready' }); app.exit(1); });
