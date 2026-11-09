/** Native DSH acceptance, isolated from user chats and instance configuration. */
import { app, safeStorage } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService } from '../../src/main/companion-bot/memory-service';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import { GLOBAL_EMBEDDING_SELECTION_ID } from '../../src/shared/embedding/global-profile';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import { createBotNativeHost } from './bot-native-host';
import { startBotProtocolModel } from './bot-protocol-model';
import type { NativeHostEvent } from '../../src/main/dsh/native-host-client';

const root = process.env.WORLDLINEBOX_BOT_REAL_ROOT!, project = process.env.WORLDLINEBOX_BOT_REAL_PROJECT!, source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!;
const protocolMode = process.env.WORLDLINEBOX_BOT_PROTOCOL_ACCEPTANCE === '1';
if (!root || !source || !project || !protocolMode && process.env.WORLDLINEBOX_BOT_REAL_ACCEPTANCE !== '1') throw new Error('Explicit isolated acceptance inputs required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const phases: Array<{ stage: string; durationMs: number }> = [], errors: Array<{ stage: string; name: string; message: string }> = [];
let secret = '', stage = 'start';
const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replaceAll(secret || '\0', '<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').slice(0, 3000);
async function measured<T>(name: string, work: () => Promise<T>): Promise<T> {
  stage = name; process.send?.({ kind: 'bot-real-progress', stage }); const started = performance.now();
  try { return await work(); } finally { phases.push({ stage: name, durationMs: performance.now() - started }); }
}
void app.whenReady().then(async () => {
  let service: BotService | undefined, native: Awaited<ReturnType<typeof createBotNativeHost>> | undefined, memory: BotMemoryService | undefined;
  let protocolModel: Awaited<ReturnType<typeof startBotProtocolModel>> | undefined;
  const embedding = new GlobalEmbeddingService({ userDataPath: path.join(root, 'embedding-state'), bundleDirectory: path.join(project, 'resources/embedding-models'),
    koffiPath: createRequire(path.join(project, 'package.json')).resolve('koffi'), devicePreference: () => ({ backend: 'cpu' }) });
  const gateway = new VcpEmbeddingGateway(embedding);
  const report: Record<string, unknown> = { kind: 'bot-real-result', passed: false, architecture: 'native-session-per-message', usesRealModel: !protocolMode, usesRealEmbedding: true, phases, errors };
  const runs = new Map<string, { cwd: string; laneId: string; sessionId: string; tools: string[]; prompt: string; events: NativeHostEvent[] }>();
  try {
    stage = 'global-model'; let model;
    if (protocolMode) { protocolModel = await startBotProtocolModel(); model = { apiFormat: 'openai_chat' as const, model: 'protocol-fixture', baseUrl: protocolModel.baseUrl, apiKey: 'protocol-fixture-no-secret' }; }
    else {
      const catalog = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
      const profile = catalog.profiles.find((entry: { id: string }) => entry.id === catalog.activeProfileId);
      if (!profile || !/^ai_[a-f0-9]{24}$/.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw new Error('GLOBAL_MODEL_UNAVAILABLE');
      model = { ...resolveStoredLlmConfig(profile), apiKey: safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin'))) };
    }
    secret = model.apiKey;
    if (model.apiFormat !== 'openai_chat' || !model.baseUrl || !model.apiKey) throw new Error('GLOBAL_MODEL_REQUIRES_OPENAI_CHAT');
    report.model = { model: model.model, endpointHost: new URL(model.baseUrl).host };
    const encoded = await measured('embedding-warmup', () => embedding.embed(['原生 DSH 伙伴验收'], { purpose: 'query' }));
    if (encoded.vectors[0]?.length !== 768 || encoded.vectors[0].some(value => !Number.isFinite(value))) throw new Error('BUILTIN_EMBEDDING_INVALID');
    report.embedding = { dimension: encoded.profile.dimension, model: encoded.profile.modelName };
    native = await measured('native-host', () => createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!));
    process.send?.({ kind: 'bot-real-owned-root', root: native.root });
    const client = await native.instances.ensureHost(native.instance.id); report.dsh = { version: native.runtimeVersion };
    const botRoot = path.join(root, 'bot'); await mkdir(botRoot, { recursive: true });
    const media = new BotMediaService({ root: path.join(botRoot, 'media'), builtinRoot: path.join(project, 'resources/bot-stickers') });
    memory = new BotMemoryService({ root: path.join(botRoot, 'memory'),
      runtime: async () => ({ nodePath: path.join(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!, 'bin/node.exe'), packageRoot: path.join(project, '.tools/bot-memory-release/vcp-memory') }),
      embedding: async () => gateway.configuration(GLOBAL_EMBEDDING_SELECTION_ID, await embedding.resolveProfile()),
      chat: async () => ({ baseUrl: model.baseUrl!, model: model.model, apiKey: model.apiKey, apiType: 'openai-completions' }) });
    const brain = new BotDshBrain({ getHost: async () => ({ client, instance: native!.instance }) });
    const nativeRun = brain.run.bind(brain);
    brain.run = async (input: BotDshRun) => {
      const run = { cwd: input.cwd, laneId: input.laneId, sessionId: BotDshBrain.sessionId(input.laneId), tools: (input.workerTools ?? input.tools).map(tool => tool.name), prompt: input.prompt, events: [] as NativeHostEvent[] };
      runs.set(input.eventId, run);
      return nativeRun({ ...input, onEvent: event => { run.events.push(event); input.onEvent?.(event); } });
    };
    service = new BotService({ root: botRoot, brain, memory, media, model: () => ({ ...model, baseUrl: model.baseUrl! }),
      report: error => errors.push({ stage, name: error instanceof Error ? error.name : 'Error', message: safeError(error) }), onEvent: () => undefined });
    let snapshot = (await service.handle({ type: 'state' })).snapshot!;
    const companionId = DEFAULT_BOT_COMPANION_ID, conversationId = service.store.openDirect(companionId).id;
    async function send(content: string, attachmentIds?: string[], room = conversationId, responding = companionId) {
      const accepted = await service!.handle({ type: 'message.send', conversationId: room, content, requestId: randomUUID(), ...(attachmentIds?.length ? { attachmentIds } : {}) });
      if (!accepted.ok || !accepted.messageId) throw new Error('MESSAGE_NOT_ACCEPTED');
      const sourceMessageId = accepted.messageId, sourceMessage = service!.store.getMessage(sourceMessageId)!; const started = performance.now();
      while (performance.now() - started < 240000) {
        snapshot = (await service!.handle({ type: 'state', conversationId: room })).snapshot!;
        const reply = snapshot.messages.find(message => message.sequence > sourceMessage.sequence && message.senderId === responding
          && service!.store.getEvent(message.eventId)?.sourceMessageRecordId === sourceMessageId && ['sent', 'failed', 'cancelled'].includes(message.status));
        if (reply && !['queued', 'running'].includes(service!.store.getEvent(reply.eventId)?.status ?? 'queued')) {
          if (reply.status !== 'sent') throw new Error('REPLY_' + reply.status.toUpperCase() + ': ' + service!.store.getEvent(reply.eventId)?.error);
          const published = [...new Map([reply, ...service!.store.publicationsForEvent(reply.eventId)].map(item => [item.id, item])).values()];
          return { eventId: reply.eventId, sourceMessageId, replyId: reply.id, text: published.map(message => message.content).filter(Boolean).join('\n'),
            attachments: published.flatMap(message => message.attachments ?? []), elapsedMs: performance.now() - started, execution: reply.execution };
        }
        await pause(150);
      }
      throw new Error('REPLY_TIMEOUT');
    }
    const toolsFor = (eventId: string) => runs.get(eventId)!.events.filter(event => event.type === 'tool_call').map(event => event.toolName ?? '');
    const ordinary = await measured('ordinary-chat', () => send('你好，这是原生 DSH 伙伴验收。只用一句简短中文问候。'));
    const second = await measured('fresh-session', () => send('这是下一条独立消息，只回答“收到第二条”。'));
    const firstRun = runs.get(ordinary.eventId)!, secondRun = runs.get(second.eventId)!;
    if (firstRun.sessionId === secondRun.sessionId || firstRun.cwd !== secondRun.cwd || firstRun.laneId === secondRun.laneId) throw new Error('NATIVE_SESSION_ISOLATION_FAILED');
    if ([...runs.values()].some(run => run.tools.includes('dsh_task') || run.tools.includes('chat_send_file'))) throw new Error('LEGACY_TASK_OR_FILE_TOOL_EXPOSED');
    if (secondRun.prompt.includes('你好，这是原生')) throw new Error('ROUTER_TRANSCRIPT_REPLAYED');
    report.sessions = { distinctSessionIds: true, sameCompanionWorkspace: true, noRouterTranscript: true, legacyToolsAbsent: true, streamedEvents: firstRun.events.length + secondRun.events.length };
    async function verifyInteractionDiary(reply: Awaited<ReturnType<typeof send>>, expectedContent: string[]) {
      const room = service!.store.getConversation(conversationId)!;
      const scope = { companionId, conversationId, securityDomainId: room.securityDomainId };
      const id = createHash('sha256').update(reply.eventId + ':interaction:v3').digest('hex'), deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const diary = (await memory!.list(scope)).find(note => note.id === id);
        if (diary?.indexState === 'indexed') {
          if (!diary.sourceMessageIds.includes(reply.sourceMessageId) || !diary.sourceMessageIds.includes(reply.replyId)
            || !expectedContent.every(fragment => diary.content.includes(fragment))) throw new Error('INTERACTION_DIARY_PROVENANCE_INVALID');
          return { indexed: true, sourceMessagesVerified: true, contentVerified: true };
        }
        await pause(300);
      }
      throw new Error('COMPLETED_INTERACTION_DIARY_NOT_INDEXED');
    }
    report.interactionDiary = await measured('completed-interaction-diary', () => verifyInteractionDiary(ordinary,
      [ordinary.sourceMessageId, ordinary.replyId, ordinary.text, service!.store.getMessage(ordinary.sourceMessageId)!.senderName]));
    await measured('memory-write', async () => { const saved = await service!.handle({ type: 'memory.remember', conversationId, companionId,
      content: '开发验收事实：测试项目代号为青榆舟。只用于本次验收。' }); if (!saved.ok) throw new Error('MEMORY_WRITE_FAILED'); });
    await measured('memory-search', async () => {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) { const found = await service!.handle({ type: 'memory.search', conversationId, companionId, query: '测试项目代号' });
        if (found.ok && JSON.stringify(found.memory).includes('青榆舟')) return; await pause(300); }
      throw new Error('MEMORY_FACT_NOT_RECALLED');
    });
    const recalled = await measured('native-memory-tool', () => send('请先调用 memory_search 查询测试项目代号，再依据真实检索结果告诉我代号。'));
    if (!recalled.text.includes('青榆舟') || !toolsFor(recalled.eventId).some(name => name.endsWith('memory_search'))) throw new Error('NATIVE_MEMORY_TOOL_NOT_USED');
    report.memory = { semanticRecall: true, nativeToolRecall: true, passiveEvidenceIncluded: JSON.parse(runs.get(recalled.eventId)!.prompt).memoryEvidence.length > 0 };
    if (!protocolMode) {
      const sticker = await measured('native-sticker', () => send('请查询真实表情列表，选一张开心的动图，用 chat_send_sticker 实际发给我。不要用文字冒充发图。'));
      if (!sticker.attachments.some(item => item.kind === 'sticker' && item.animated)) throw new Error('ACTUAL_ANIMATED_STICKER_MISSING');
      report.sticker = { published: true, animated: true, tools: toolsFor(sticker.eventId) };
      const inputFile = path.join(root, 'numbers.txt'); await writeFile(inputFile, '3,5,8\n');
      const ids = (await media.importFiles({ conversationId, paths: [inputFile] })).map(ref => ref.id);
      const files = await measured('native-file-task', () => send('直接使用原生文件工具完成：读取本消息 numbers.txt 附件，把其中数字之和写入当前工作区 sum-proof.txt，只写数字。另建 cedar-proof.txt，内容严格为 WLB_SUPER_AGENT_OK。实际读取两个输出核验后，用原生 present_files 一次交付两个文件。', ids));
      const workspace = runs.get(files.eventId)!.cwd;
      if ((await readFile(path.join(workspace, 'sum-proof.txt'), 'utf8')).trim() !== '16' || (await readFile(path.join(workspace, 'cedar-proof.txt'), 'utf8')).trim() !== 'WLB_SUPER_AGENT_OK') throw new Error('REAL_FILE_CONTENT_INVALID');
      if (!toolsFor(files.eventId).some(name => name === 'present' || name.endsWith('present_files'))) throw new Error('NATIVE_PRESENT_FILES_NOT_CALLED');
      if (!files.attachments.some(ref => ref.name === 'cedar-proof.txt') || !files.attachments.some(ref => ref.name === 'sum-proof.txt')) throw new Error('NATIVE_FILE_NOT_PUBLISHED_TO_CHAT');
      for (const ref of files.attachments) {
        const local = await media.getForAgent(conversationId, ref.id), bytes = await readFile(local.path);
        if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error('DELIVERED_FILE_HASH_INVALID');
      }
      report.files = { inputRead: true, outputBytesVerified: true, presentFiles: true, delivered: files.attachments.map(ref => ref.name), tools: toolsFor(files.eventId) };
      report.fileInteractionDiary = await measured('native-delivery-diary', () => verifyInteractionDiary(files, ['sum-proof.txt', 'cedar-proof.txt', files.sourceMessageId]));
      const complex = await measured('native-subagent-task', () => send('请使用当前可用的 sessions_spawn 工具创建原生子会话，子会话用真实代码计算1到12的平方和并写入 child-audit.json，结构为 {"sumSquares":650}。等候子会话完成，再由你读取该文件核验，最后只回复数值650。不创建旧版任务中心任务。'));
      if (!toolsFor(complex.eventId).some(name => name.endsWith('sessions_spawn')) || JSON.parse(await readFile(path.join(workspace, 'child-audit.json'), 'utf8')).sumSquares !== 650) throw new Error('REAL_NATIVE_SUBAGENT_NOT_VERIFIED');
      report.subagent = { nativeSpawn: true, artifactVerified: true, tools: toolsFor(complex.eventId) };
      const fileSessionId = runs.get(files.eventId)!.sessionId;
      const history = await measured('cross-session-recall', () => send('请先用 sessions_list 根据标题和消息预览，找到本次读取 numbers.txt 并交付 sum-proof.txt、cedar-proof.txt 的历史原生会话，再仅用 sessions_read 读取它的消息，核实 cedar-proof.txt 的内容。沿分页继续，最后只告诉我已核实的文件内容。本次只测试自然查找历史会话，不调用 shell、read 或其他文件工具。'));
      const historyRun = runs.get(history.eventId)!;
      const listCalls = new Set(historyRun.events.filter(event => event.type === 'tool_call' && event.toolName?.endsWith('sessions_list')).map(event => event.callId));
      const successfulLists = historyRun.events.filter(event => event.type === 'tool_result' && listCalls.has(event.callId) && event.summary === '工具执行完成');
      const readCalls = new Set(historyRun.events.filter(event => event.type === 'tool_call' && event.toolName?.endsWith('sessions_read')).map(event => event.callId));
      const successfulReads = historyRun.events.filter(event => event.type === 'tool_result' && readCalls.has(event.callId) && event.summary === '工具执行完成');
      if (!successfulLists.some(event => event.text?.includes(fileSessionId)) || !history.text.includes('WLB_SUPER_AGENT_OK')
        || !successfulReads.some(event => event.text?.includes('WLB_SUPER_AGENT_OK'))) throw new Error('CROSS_SESSION_READ_NOT_VERIFIED');
      report.crossSession = { explicitNativeRead: true, textVerified: true, tools: toolsFor(history.eventId) };
      const group = await service.handle({ type: 'conversation.create', title: '原生伙伴群验收', kind: 'group', memberIds: [companionId, 'gpt'], participationMode: 'mentions' });
      if (!group.ok || !group.conversationId) throw new Error('GROUP_CREATION_FAILED');
      const groupReply = await measured('group-chat', () => send('@大肥鱼 请只回答“群聊已连接”，不要联系其他伙伴。', undefined, group.conversationId));
      if (!groupReply.text.includes('群聊已连接')) throw new Error('GROUP_REPLY_MISSING');
      const peer = await measured('companion-private-chat', () => send('请用 companion_contact 联系 GPT，destination 选 peer，消息内容为“这是一条原生DSH伙伴私聊验收，请只回复：伙伴私聊已连接。不要继续发起联系。”只做这一次发送。'));
      if (!toolsFor(peer.eventId).some(name => name.endsWith('companion_contact'))) throw new Error('COMPANION_CONTACT_NOT_CALLED');
      const deadline = Date.now() + 180000; let peerVerified = false;
      while (Date.now() < deadline) {
        const state = (await service.handle({ type: 'state' })).snapshot!;
        for (const room of state.conversations.filter(room => room.kind === 'peer')) {
          const state = (await service.handle({ type: 'state', conversationId: room.id })).snapshot!;
          if (state.messages.some(message => message.senderId === 'gpt' && message.status === 'sent' && message.content.includes('伙伴私聊已连接'))) peerVerified = true;
          if (state.messages.some(message => message.content.includes('青榆舟'))) throw new Error('PRIVATE_MEMORY_LEAKED_TO_PEER');
        }
        if (peerVerified) break; await pause(250);
      }
      if (!peerVerified) throw new Error('COMPANION_PRIVATE_REPLY_NOT_OBSERVED');
      report.social = { groupReplyVerified: true, peerReplyVerified: true, privateMemoryAbsent: true };
    }
    report.nativeTools = [...new Set([...runs.values()].flatMap(run => run.events.filter(event => event.toolName).map(event => event.toolName)))];
    report.nativeRuns = [...runs].map(([eventId, run]) => ({ eventId, sessionId: run.sessionId, workspace: path.basename(run.cwd), tools: toolsFor(eventId), events: run.events.length }));
    report.passed = true;
  } catch (error) { report.failedStage = stage; report.failure = { name: error instanceof Error ? error.name : 'Error', message: safeError(error) };
    report.lastNative = [...runs].filter(([eventId]) => eventId.startsWith('event-')).slice(-2).map(([eventId, run]) => ({ eventId,
      tools: run.events.filter(event => event.toolName || event.type === 'tool_result').map(event => ({ type: event.type, name: event.toolName,
        callId: event.callId, summary: safeError(event.summary ?? ''), text: safeError(event.text ?? '').slice(0, 2000) })), events: run.events.length }));
  } finally {
    await service?.shutdown().catch(error => errors.push({ stage: 'shutdown', name: 'Error', message: safeError(error) }));
    await memory?.close().catch(() => undefined); await native?.close().catch(() => undefined); await gateway.close(); await embedding.close(); await protocolModel?.close();
    if (protocolModel) report.protocolFixture = protocolModel.counters;
    await writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2)); process.send?.(report); app.exit(report.passed ? 0 : 1);
  }
}).catch(error => { process.send?.({ kind: 'bot-real-result', passed: false, failedStage: 'electron-ready', error: safeError(error) }); app.exit(1); });
