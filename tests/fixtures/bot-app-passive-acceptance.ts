/** Controlled App+VCP integration, deliberately independent of UI chat history.
 * No DSH imports, Host, worker, or asset-library memory backend is involved. */
import { app, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUILTIN_BOT_COMPANIONS } from '../../src/shared/builtin-bot-companions';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import { GLOBAL_EMBEDDING_SELECTION_ID } from '../../src/shared/embedding/global-profile';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { resolveBotModelLimits } from '../../src/main/companion-bot/model-limits';
import { BotMemoryService, type BotMemoryScope, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotToolServer, type BotToolCall } from '../../src/main/companion-bot/tool-server';
import { buildBotContext } from '../../src/main/companion-bot/context';
import { BOT_TOOLS } from '../../src/main/companion-bot/tools';
import type { BotCompanion, BotEvent, BotConversation } from '../../src/main/companion-bot/types';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import { resolvePortableTools } from '../../src/main/portable-tools';

const root = process.env.WORLDLINEBOX_BOT_REAL_ROOT!, project = process.env.WORLDLINEBOX_BOT_REAL_PROJECT!;
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!, output = process.env.WORLDLINEBOX_BOT_PASSIVE_OUTPUT!;
if (!root || !project || !source || !output || process.env.WORLDLINEBOX_BOT_PASSIVE_REAL !== '1') throw new Error('Explicit isolated passive acceptance inputs required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
let secret = '';
const clean = (value: string) => value.replaceAll(secret || '\0', '<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
  .replace(/(?<![A-Za-z0-9_-])sk-[a-f0-9]{32,}(?![A-Za-z0-9_-])/gi, '<redacted>');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const safe = <T>(value: T): T => JSON.parse(clean(JSON.stringify(value))) as T;
const factMarkers = ['蓝色收纳盒', '西北角', '20分钟'];
const naturalQuestion = '晨汐项目今晚怎么开始比较合适？简单陪我说两句就好。';

void app.whenReady().then(async () => {
  const stages: Row[] = [], observations: Row[] = [], errors: Row[] = [];
  const report: Row = { kind: 'bot-passive-result', runId: path.basename(root), passed: false, date: new Date().toISOString(),
    testBoundary: 'Controlled real App Agent + VCP integration; not a UI/Service acceptance. All model lanes and input histories are fresh. Only VCP evidence may carry stored facts.',
    usesRealModel: true, usesRealEmbedding: true, usesRealVcp: true, dshHostsStarted: 0,
    responseWriteback: false, responseWritebackReason: 'Read-only measurement must not turn previous model answers into a second seed or mask forget results.',
    stages, observations, errors, appModelRequests: 0, humanQualityReviewRequired: true,
    cost: { exactTokenUsage: null, currency: null, note: 'Observed App HTTP requests are recorded; provider billing is not guessed.' } };
  const persist = () => writeFile(path.join(output, 'result.partial.json'), clean(JSON.stringify(report, null, 2)) + '\n');
  const phase = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    process.send?.({ kind: 'bot-passive-progress', stage: name, observations: observations.length });
    const started = performance.now();
    try { const value = await operation(); stages.push({ name, elapsedMs: performance.now() - started, passed: true }); return value; }
    catch (error) { stages.push({ name, elapsedMs: performance.now() - started, passed: false, error: clean(error instanceof Error ? error.message : String(error)) }); throw error; }
    finally { await persist(); }
  };
  const embedding = new GlobalEmbeddingService({ userDataPath: path.join(root, 'embedding-state'), bundleDirectory: path.join(project, 'resources/embedding-models'),
    koffiPath: createRequire(path.join(project, 'package.json')).resolve('koffi'), devicePreference: () => ({ backend: 'cpu' }) });
  const gateway = new VcpEmbeddingGateway(embedding);
  let memory: BotMemoryService | undefined, brain: BotAppBrain | undefined, tools: BotToolServer | undefined;
  try {
    await mkdir(output, { recursive: true });
    const catalog = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = catalog.profiles.find((entry: { id: string }) => entry.id === catalog.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw new Error('GLOBAL_MODEL_UNAVAILABLE');
    const model = { ...resolveStoredLlmConfig(profile), apiKey: safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin'))) };
    secret = model.apiKey;
    if (!model.baseUrl || !model.apiKey || model.apiFormat !== 'openai_chat') throw new Error('GLOBAL_MODEL_REQUIRES_OPENAI_CHAT');
    report.model = { model: model.model, endpointHost: new URL(model.baseUrl).host, apiFormat: model.apiFormat,
      limits: resolveBotModelLimits({ ...model, baseUrl: model.baseUrl }) };
    const vectors = await phase('embedding-warmup', () => embedding.embed(['晨汐项目长期偏好受控验收'], { purpose: 'query' }));
    if (vectors.vectors[0]?.length !== 768 || vectors.profile.source !== 'local') throw new Error('BUILTIN_768_EMBEDDING_REQUIRED');
    report.embedding = { dimensions: 768, source: vectors.profile.source, model: vectors.profile.modelName, devicePreference: 'cpu' };
    let node: Promise<string> | undefined;
    memory = new BotMemoryService({ root: path.join(root, 'memory'), maxActiveDomains: 3,
      runtime: async () => ({ nodePath: await (node ??= resolvePortableTools({ appPath: project }).then(value => value.nodeExecutable)),
        packageRoot: path.join(project, '.tools/bot-memory-release/vcp-memory') }),
      embedding: async () => gateway.configuration(GLOBAL_EMBEDDING_SELECTION_ID, await embedding.resolveProfile()),
      chat: async () => ({ baseUrl: model.baseUrl!, model: model.model, apiKey: model.apiKey, apiType: 'openai-completions' }) });
    const primary = BUILTIN_BOT_COMPANIONS[0]!, other = BUILTIN_BOT_COMPANIONS.find(value => value.id !== primary.id)!;
    const primaryScope: BotMemoryScope = { companionId: primary.id, conversationId: randomUUID(), securityDomainId: randomUUID() };
    const otherScope: BotMemoryScope = { ...primaryScope, companionId: other.id };
    const groupScope: BotMemoryScope = { companionId: primary.id, conversationId: randomUUID(), securityDomainId: randomUUID() };
    report.scopes = { primary: primaryScope, otherCompanionSameAudience: otherScope, independentGroup: groupScope };
    const bindings = new Map<string, { laneId: string; prepared: BotMemoryPrepared; calls: Row[] }>();
    tools = new BotToolServer(async (call: BotToolCall, signal: AbortSignal) => {
      const binding = bindings.get(call.eventId);
      if (!binding || binding.laneId !== call.laneId) throw new Error('PASSIVE_TOOL_SCOPE_MISMATCH');
      const started = performance.now(), scope = binding.prepared.scope;
      let result: unknown;
      if (call.name === 'memory_recall_details') result = await memory!.recallDetails({ scope, requestId: binding.prepared.requestId,
        citationId: typeof call.args.citationId === 'string' ? call.args.citationId : undefined,
        offset: typeof call.args.offset === 'number' ? call.args.offset : undefined, signal });
      else if (call.name === 'memory_search') result = await memory!.tool(scope, 'memory_search', call.args, signal);
      else if (call.name === 'memory_history') result = await memory!.tool(scope, 'DeepMemo', call.args, signal);
      else if (call.name === 'memory_read') result = await memory!.tool(scope, 'TopicMemo', { topic_id: call.args.topicId }, signal);
      else if (call.name === 'memory_list') result = await memory!.list(scope);
      else throw new Error('This controlled acceptance permits only scoped read-only memory tools; no worker or write can be started.');
      binding.calls.push(safe({ callId: call.callId, name: call.name, args: call.args, receipt: result, elapsedMs: performance.now() - started }));
      return result;
    });
    brain = new BotAppBrain({ root: path.join(root, 'app-brain'), fetchFn: async (url, init) => {
      if (new URL(String(url)).host === new URL(model.baseUrl!).host) report.appModelRequests = Number(report.appModelRequests) + 1;
      return fetch(url, init);
    } });
    const readTools = BOT_TOOLS.filter(tool => ['memory_recall_details', 'memory_search', 'memory_history', 'memory_read', 'memory_list'].includes(tool.name));
    if (!readTools.some(tool => tool.name === 'memory_recall_details')) throw new Error('RECALL_DETAILS_TOOL_MISSING');
    const run = async (label: string, scope: BotMemoryScope, question: string, expected: 'seed' | 'corrected' | 'empty', active = false) => phase(label, async () => {
      const eventId = randomUUID(), laneId = `passive-${label}-${randomUUID()}`, stamp = new Date().toISOString();
      const started = performance.now(), prepareStart = performance.now();
      const userMessage = { id: eventId, role: 'user' as const, content: question, timestamp: Date.now(), senderId: 'user', senderName: '验收用户' };
      const prepared = await memory!.prepareTurn({ scope, requestId: eventId, messages: [userMessage], query: question });
      const prepareMs = performance.now() - prepareStart;
      const builtin = BUILTIN_BOT_COMPANIONS.find(value => value.id === scope.companionId)!;
      const companion: BotCompanion = { id: builtin.id, name: builtin.name, persona: builtin.persona, createdAt: stamp, updatedAt: stamp };
      const conversation: BotConversation = { id: scope.conversationId, title: label, kind: scope === groupScope ? 'group' : 'direct',
        memberIds: ['user', scope.companionId], audienceScopeId: scope.conversationId, securityDomainId: scope.securityDomainId, revision: 1, createdAt: stamp };
      const event: BotEvent = { id: eventId, eventId, laneId, conversationId: scope.conversationId, companionId: scope.companionId,
        source: 'user', sourceInstanceId: 'controlled-acceptance', sourceMessageId: eventId, senderId: 'user', senderType: 'user', senderName: '验收用户',
        audienceScopeId: scope.conversationId, securityDomainId: scope.securityDomainId, aclRevision: 1, sequence: 1, kind: 'message', content: question,
        payload: {}, correlationId: eventId, sourceMessageRecordId: eventId, sourceMessageSequence: 1, replyMessageId: randomUUID(), status: 'running', attempts: 1, occurredAt: stamp, receivedAt: stamp };
      const context = buildBotContext({ companion, conversation, event, messages: [], participants: [companion], memories: prepared.evidence });
      const nonMemoryInput = JSON.stringify({ system: context.system, userMessage, history: [] });
      if (factMarkers.some(marker => nonMemoryInput.includes(marker)) || nonMemoryInput.includes('12分钟')) throw new Error('FACTS_LEAKED_OUTSIDE_VCP_EVIDENCE');
      const snapshot = safe({ status: prepared.status, evidence: prepared.evidence, citations: prepared.citations, coverage: prepared.evidenceCoverage,
        events: prepared.events, metadata: prepared.metadata, omittedChars: prepared.omittedChars });
      const item: Row = { label, expected, input: question, scope, requestId: eventId, passed: false, prepared: snapshot, state: 'prepared' };
      observations.push(item); await persist();
      const binding = { laneId, prepared, calls: [] as Row[] }; bindings.set(eventId, binding);
      const callback = await tools!.forWorker(laneId, eventId), modelStart = performance.now(); let firstTextMs: number | null = null;
      const rejected = await fetch(callback.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${callback.token}` },
        body: JSON.stringify({ laneId: 'foreign-lane', eventId, callId: 'scope-probe', name: 'memory_recall_details', args: {} }) });
      await rejected.body?.cancel();
      if (rejected.status !== 403) throw new Error('SCOPED_TOOL_CAPABILITY_DID_NOT_REJECT_FOREIGN_LANE');
      const toolEvents: Row[] = [];
      let result;
      try { result = await brain!.run({ laneId, eventId, cwd: root, system: context.system, prompt: context.user, model: { ...model, baseUrl: model.baseUrl! }, tools: readTools, callback,
        onEvent: value => { if (value.type === 'text_stream' && value.text && firstTextMs === null) firstTextMs = performance.now() - started;
          if (value.type === 'tool_call') toolEvents.push({ name: value.toolName, callId: value.callId }); } }); }
      catch (error) { Object.assign(item, { state: 'model-failed', error: clean(error instanceof Error ? error.message : String(error)), tools: safe(binding.calls), toolEvents,
        timing: { prepareMs, modelMs: performance.now() - modelStart, firstTextMs, elapsedMs: performance.now() - started } }); throw error; }
      finally { tools!.releaseWorker(laneId); bindings.delete(eventId); }
      const evidence = JSON.stringify(prepared.citations ?? []), sourcePresent = factMarkers.every(marker => evidence.includes(marker));
      const correctedPresent = evidence.includes('12分钟'), forbiddenSourceAbsent = !evidence.includes('蓝色收纳盒') && !evidence.includes('西北角');
      const details = binding.calls.filter(call => call.name === 'memory_recall_details');
      Object.assign(item, safe({ label, expected, input: question, freshLane: true, inputHistoryCount: 1, recentUiHistoryCount: 0, state: 'complete',
        evidenceOnlySourceOfFacts: true, scope, requestId: eventId, reply: result.text, modelStatus: result.status,
        timing: { prepareMs, modelMs: performance.now() - modelStart, firstTextMs, elapsedMs: performance.now() - started },
        prepared: snapshot, tools: binding.calls, toolEvents,
        structuralProof: { sourcePresent, correctedPresent, forbiddenSourceAbsent, automaticEvidenceWithoutModelSearch: !binding.calls.length,
          actualReadDetails: details.length > 0, scopedCapabilityRejectedForeignLane: rejected.status === 403, noDsh: true },
        passed: result.status === 'succeeded' && (expected === 'seed' ? sourcePresent : expected === 'corrected' ? correctedPresent : forbiddenSourceAbsent)
          && (!active || details.length > 0),
        semanticSignalsForReview: { replyMentionsBlueBox: result.text.includes('蓝色收纳盒'), replyMentionsCorner: result.text.includes('西北角'),
          replyMentions20: /20\s*分钟|二十分钟/u.test(result.text), replyMentions12: /12\s*分钟|十二分钟/u.test(result.text) },
        semanticReviewRequired: true }));
      await persist(); return { prepared, item };
    });
    const seedEvent = 'seed-' + randomUUID(), seedMessage = 'original-' + randomUUID();
    const seed = '晨汐项目的固定偏好：用蓝色收纳盒，晚间只整理桌面的西北角，当前单次上限20分钟。这是用户的明确安排，不能假称已经替用户操作。';
    const write = async (sourceEventId: string, messageId: string, content: string) => {
      await memory!.appendHistory(primaryScope, [{ id: messageId, role: 'user', content, timestamp: Date.now(), senderId: 'user', senderName: '验收用户' }]);
      const receipt = await memory!.remember(primaryScope, { content, sourceEventId, sourceMessageIds: [messageId] });
      const id = hash(sourceEventId), deadline = Date.now() + 90000; let note;
      do { note = (await memory!.list(primaryScope)).find(value => value.id === id); if (note?.indexState === 'indexed') break; await pause(100); } while (Date.now() < deadline);
      if (note?.indexState !== 'indexed') throw new Error('REAL_VCP_NOTE_NOT_INDEXED');
      return safe({ id, content, sourceEventId, sourceMessageIds: [messageId], receipt, note, status: await memory!.status(primaryScope) });
    };
    report.seed = await phase('write-and-prove-indexed', () => write(seedEvent, seedMessage, seed));
    await run('passive-cold', primaryScope, naturalQuestion, 'seed');
    await run('passive-warm', primaryScope, '晨汐项目今天的收纳安排，你建议我从哪儿动手？', 'seed');
    await run('active-original-citation', primaryScope, '请实际使用 memory_recall_details 核查晨汐项目安排的来源引用和原文；需要原始发言时再用 memory_history。请区分明确安排与尚未执行的动作。', 'seed', true);
    await run('other-companion-isolation', otherScope, naturalQuestion, 'empty');
    await run('group-isolation', groupScope, naturalQuestion, 'empty');
    const correctionEvent = 'correction-' + randomUUID(), correctionMessage = 'original-' + randomUUID();
    const correction = '晨汐项目安排更正（本条晚于此前安排，以此为准）：当前单次上限从20分钟改为12分钟，其他固定偏好仍为蓝色收纳盒、只整理桌面西北角。尚未替用户实际整理。';
    report.correction = await phase('correct-and-prove-indexed', () => write(correctionEvent, correctionMessage, correction));
    await run('passive-after-correction', primaryScope, '晨汐项目今晚的最新安排是什么？请简单陪我开始。', 'corrected');
    report.forget = await phase('forget-confirmed-notes', async () => ({ receipts: [await memory!.forget(primaryScope, { id: hash(seedEvent) }),
      await memory!.forget(primaryScope, { id: hash(correctionEvent) })], tombstones: await memory!.withdrawnSources(primaryScope), list: await memory!.list(primaryScope) }));
    report.replayWithdrawnSource = await phase('prove-withdrawn-source-cannot-reflow', async () => {
      const receipt = await memory!.remember(primaryScope, { content: seed, sourceEventId: seedEvent, sourceMessageIds: [seedMessage] });
      if (object(receipt).withdrawn !== true || object(receipt).indexed !== 0) throw new Error('WITHDRAWN_SOURCE_REENTERED_MEMORY');
      return safe(receipt);
    });
    await run('passive-after-forget', primaryScope, naturalQuestion, 'empty');
    report.passed = observations.length === 7 && observations.every(value => value.passed === true);
  } catch (error) { errors.push({ message: clean(error instanceof Error ? error.message : String(error)), name: error instanceof Error ? error.name : 'Error' }); }
  finally {
    await brain?.close().catch(error => errors.push({ stage: 'brain-close', name: error.name }));
    await tools?.close().catch(error => errors.push({ stage: 'tools-close', name: error.name }));
    await memory?.close().catch(error => errors.push({ stage: 'memory-close', name: error.name }));
    await gateway.close(); await embedding.close();
    await persist(); process.send?.(safe(report)); app.exit(report.passed ? 0 : 1);
  }
}).catch(() => { process.send?.({ kind: 'bot-passive-result', passed: false, failedStage: 'electron-ready' }); app.exit(1); });
