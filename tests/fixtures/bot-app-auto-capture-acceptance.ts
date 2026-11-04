/** Opt-in controlled AppAgent + policy-2 capture + original VCP acceptance.
 * No manual diary seed, synthetic embedding, desktop access, DSH or UI app. */
import { app, safeStorage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotMemoryService, type BotMemoryMessage, type BotMemoryScope, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { captureBotMemory, BOT_MEMORY_CAPTURE_POLICY } from '../../src/main/companion-bot/memory-capture';
import { buildBotContext } from '../../src/main/companion-bot/context';
import type { BotCompanion, BotConversation, BotEvent } from '../../src/main/companion-bot/types';
import type { BotDshModel } from '../../src/main/companion-bot/dsh-brain';
import type { BotMemoryCatalog, BotMemoryRecallReport } from '../../src/shared/companion-bot-memory';
import { BUILTIN_BOT_COMPANIONS } from '../../src/shared/builtin-bot-companions';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import { GLOBAL_EMBEDDING_SELECTION_ID } from '../../src/shared/embedding/global-profile';
import { resolvePortableTools } from '../../src/main/portable-tools';

const root = process.env.WORLDLINEBOX_BOT_REAL_ROOT!, project = process.env.WORLDLINEBOX_BOT_REAL_PROJECT!;
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!, output = process.env.WORLDLINEBOX_BOT_AUTO_CAPTURE_OUTPUT!;
if (!root || !project || !source || !output || process.env.WORLDLINEBOX_BOT_AUTO_CAPTURE_REAL !== '1') throw new Error('Explicit isolated automatic capture inputs required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
let secret = '';
const clean = (value: string) => value.replaceAll(secret || '\0', '<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
  .replace(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g, '<redacted>');
const safe = <T>(value: T): T => JSON.parse(clean(JSON.stringify(value))) as T;
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const callback = { url: 'http://127.0.0.1:9', token: 'no-tools-installed-in-this-acceptance' };
const naturalInputs = [
  '这阵子我想把晚上的咖啡换成麦茶，上午那杯咖啡照旧。我不想全天戒咖啡，先这样试一周。',
  '我周六打算去湖边散步，下午两点在入口见朋友。希望行程别太赶，结束后再找个地方坐坐。',
  '天气预报周六有雨，刚才那份安排改一下：我和朋友改去市美术馆，下午三点在南门见。门票还没预约，也还没出发，现在只是确定了计划。',
  '顺便帮我看看桌面上都有哪些文件，这能交给执行器吗？我还没上传截图或提供测试目录，这一轮先只讨论，别实际操作文件。',
];

void app.whenReady().then(async () => {
  const turns: Row[] = [], cold: Row[] = [], encoders: Row[] = [], stages: Row[] = [], errors: Row[] = [], http: Row[] = [], diagnostics: Row[] = [];
  const report: Row = { kind: 'bot-auto-capture-result', runId: path.basename(root), passed: false, date: new Date().toISOString(),
    boundary: 'Controlled real AppAgent + captureBotMemory(policy 2) + original VCP/768; not a Service queue, UI, DSH or real desktop acceptance.',
    authoredTestConversation: true, usesRealModel: true, usesRealVcp: true, usesRealEmbedding: true, manualDiarySeeds: 0, productionWrites: false,
    policyVersion: BOT_MEMORY_CAPTURE_POLICY, acceptanceChecksVersion: 2, modelRequests: 0, maximumModelRequests: 10, dshHostsStarted: 0,
    turns, cold, encoders, stages, errors, http, diagnostics, humanReviewRequired: true,
    scoreMeaning: 'Original VCP ranking fields, not correctness percentages. Semantic checks below are explicit content signals for human review.' };
  let stage = 'initialization';
  const persist = () => writeFile(path.join(output, 'result.partial.json'), clean(JSON.stringify(report, null, 2)) + '\n');
  const phase = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    stage = name; process.send?.({ kind: 'bot-auto-capture-progress', stage: name, modelRequests: report.modelRequests, capturedTurns: turns.length });
    const start = performance.now();
    try { const value = await operation(); stages.push({ name, elapsedMs: performance.now() - start, passed: true }); return value; }
    catch (error) { stages.push({ name, elapsedMs: performance.now() - start, passed: false, error: clean(error instanceof Error ? error.message : String(error)) }); throw error; }
    finally { await persist(); }
  };
  const embedding = new GlobalEmbeddingService({ userDataPath: path.join(root, 'embedding-state'), bundleDirectory: path.join(project, 'resources/embedding-models'),
    koffiPath: createRequire(path.join(project, 'package.json')).resolve('koffi'), devicePreference: () => ({ backend: 'cpu' }) });
  const gateway = new VcpEmbeddingGateway(embedding);
  let memory: BotMemoryService | undefined, brain: BotAppBrain | undefined;
  try {
    if (BOT_MEMORY_CAPTURE_POLICY !== 2) throw new Error('CAPTURE_POLICY_2_REQUIRED');
    if (os.freemem() < 7 * 1024 ** 3) throw new Error('INSUFFICIENT_FREE_MEMORY_FOR_ONE_OWNED_768_ENCODER');
    report.freeMemoryBeforeGiB = os.freemem() / 1024 ** 3;
    const catalog = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = catalog.profiles.find((entry: { id: string }) => entry.id === catalog.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw new Error('GLOBAL_MODEL_UNAVAILABLE');
    const stored = resolveStoredLlmConfig(profile);
    secret = safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin')));
    const model: BotDshModel = { ...stored, apiKey: secret, maxTokens: 2048 };
    if (!model.baseUrl || !secret || model.apiFormat !== 'openai_chat') throw new Error('GLOBAL_OPENAI_CHAT_CONFIGURATION_REQUIRED');
    report.model = { model: model.model, endpointHost: new URL(model.baseUrl).host, apiFormat: model.apiFormat };
    const vectors = await phase('one-owned-768-embedding-warmup', () => embedding.embed(['自然交流自动记忆验收'], { purpose: 'query' }));
    if (vectors.vectors[0]?.length !== 768 || vectors.profile.source !== 'local') throw new Error('ACTUAL_BUNDLED_768_REQUIRED');
    report.embedding = { dimension: 768, source: vectors.profile.source, model: vectors.profile.modelName, backend: 'cpu', ownedEncoderCount: 1 };
    const nodePath = (await resolvePortableTools({ appPath: project })).nodeExecutable;
    const packageRoot = path.join(project, '.tools/bot-memory-release/vcp-memory');
    const client = createRequire(path.join(packageRoot, 'package.json'))(path.join(packageRoot, 'lib/client.cjs')) as {
      createSession(options: object): { pid: number; closed: Promise<void>; close(): Promise<void>; request(operation: string, payload?: object, options?: object): Promise<unknown> };
    };
    const sessions: number[] = [];
    const makeMemory = () => new BotMemoryService({ root: path.join(root, 'memory'), maxActiveDomains: 1,
      runtime: async () => ({ nodePath, packageRoot }), embedding: async () => gateway.configuration(GLOBAL_EMBEDDING_SELECTION_ID, await embedding.resolveProfile()),
      // All paid calls go through the counted AppAgent path. VCP summarizers
      // are not needed for record-only OneRing and cannot make hidden calls.
      chat: async () => ({ baseUrl: 'http://127.0.0.1:9', model: 'disabled-memory-chat', apiKey: 'unavailable', apiType: 'openai-completions' }),
      onDiagnostic: value => { diagnostics.push(safe(value)); }, createSession: options => { const session = client.createSession(options); sessions.push(session.pid); return session; } });
    const makeBrain = (directory: string) => new BotAppBrain({ root: path.join(root, directory), maxSteps: 1, fetchFn: async (url, init) => {
      if (new URL(String(url)).origin !== new URL(model.baseUrl).origin) throw new Error('UNEXPECTED_PAID_MODEL_ENDPOINT');
      if (Number(report.modelRequests) >= 10) throw new Error('TEN_MODEL_REQUEST_BUDGET_EXHAUSTED');
      report.modelRequests = Number(report.modelRequests) + 1;
      const observation: Row = { ordinal: report.modelRequests, stage, startedAt: new Date().toISOString() }, start = performance.now(); http.push(observation);
      try { const response = await fetch(url, init); observation.status = response.status; return response; }
      finally { observation.headersMs = performance.now() - start; }
    } });
    memory = makeMemory(); brain = makeBrain('app-brain-natural');
    const builtin = BUILTIN_BOT_COMPANIONS[0]!, createdAt = new Date().toISOString();
    const companion: BotCompanion = { id: builtin.id, name: builtin.name, persona: builtin.persona, createdAt, updatedAt: createdAt };
    const scope: BotMemoryScope = { companionId: companion.id, conversationId: randomUUID(), securityDomainId: randomUUID() };
    const conversation: BotConversation = { id: scope.conversationId, title: '隔离自然对话验收', kind: 'direct', memberIds: ['user', companion.id],
      audienceScopeId: scope.conversationId, securityDomainId: scope.securityDomainId, revision: 1, createdAt };
    report.scope = scope;
    const history: BotMemoryMessage[] = [];
    const context = (input: string, eventId: string, laneId: string, sourceMessageId: string, sequence: number, evidence: string) => {
      const stamp = new Date().toISOString();
      const event: BotEvent = { id: eventId, eventId, laneId, conversationId: scope.conversationId, companionId: companion.id,
        source: 'user', sourceInstanceId: 'isolated-auto-capture-acceptance', sourceMessageId, senderId: 'user', senderType: 'user', senderName: '验收用户',
        audienceScopeId: scope.conversationId, securityDomainId: scope.securityDomainId, aclRevision: 1, sequence, kind: 'message', content: input,
        payload: {}, correlationId: eventId, sourceMessageRecordId: sourceMessageId, sourceMessageSequence: sequence, replyMessageId: randomUUID(), status: 'running',
        attempts: 1, occurredAt: stamp, receivedAt: stamp };
      const built = buildBotContext({ companion, conversation, event, messages: [], participants: [companion], memories: evidence });
      return { ...built, system: `${built.system}\n本次控制环境只连接真实对话与记忆，没有安装桌面或任务执行工具；不能访问或假称已经读取桌面。` };
    };
    const laneId = `natural-${randomUUID()}`;
    for (const [index, input] of naturalInputs.entries()) await phase(`natural-turn-${index + 1}-and-policy2-capture`, async () => {
      if (/请记住|帮我记住|记忆测试|memory_write/.test(input)) throw new Error('MANUAL_MEMORY_INSTRUCTION_NOT_ALLOWED');
      const eventId = randomUUID(), sourceMessageId = randomUUID(), answerMessageId = randomUUID(), start = performance.now();
      const user: BotMemoryMessage = { id: sourceMessageId, role: 'user', content: input, timestamp: Date.now(), senderId: 'user', senderName: '验收用户' };
      const prepared = await memory!.prepareTurn({ scope, requestId: eventId, messages: [...history, user] });
      const preparedMs = performance.now() - start, built = context(input, eventId, laneId, sourceMessageId, index * 2 + 1, prepared.evidence);
      const modelStart = performance.now(), reply = await brain!.run({ laneId, eventId, cwd: root, system: built.system, prompt: built.user, model, tools: [], callback });
      const item: Row = { index: index + 1, input, eventId, sourceMessageId, answerMessageId, reply: reply.text, modelStatus: reply.status,
        timing: { prepareMs: preparedMs, chatMs: performance.now() - modelStart }, capture: null };
      turns.push(item); await persist();
      if (reply.status !== 'succeeded') throw new Error('NATURAL_TURN_FAILED');
      const answer: BotMemoryMessage = { id: answerMessageId, role: 'assistant', content: reply.text, timestamp: Date.now(), senderId: companion.id, senderName: companion.name };
      await memory!.finishTurn(prepared, reply.text, true); await memory!.appendHistory(scope, [user, answer]); history.push(user, answer);
      const writes: Row[] = [], captureStart = performance.now();
      item.capture = { state: 'encoding', writes }; await persist();
      const captured = await captureBotMemory({ brain: { run: async run => {
        const started = performance.now(), encoded = await brain!.run(run);
        encoders.push(safe({ sourceEventId: eventId, encoderEventId: run.eventId, policyVersion: 2, output: encoded.text, status: encoded.status, elapsedMs: performance.now() - started }));
        await persist();
        return encoded;
      }, archive: lane => brain!.archive(lane) }, memory: { remember: async (writeScope, payload, signal) => {
        // This is the unmodified automatic policy's internal write, never a seed.
        const started = performance.now(), write: Row = { sourceEventId: payload.sourceEventId, sourceRootEventId: payload.sourceRootEventId,
          sourceMessageIds: payload.sourceMessageIds, content: payload.content, tags: payload.tags, state: 'awaiting-real-receipt' };
        writes.push(write); await persist();
        try { const receipt = await memory!.remember(writeScope, payload, signal); Object.assign(write, safe({ receipt, state: 'receipt-received', elapsedMs: performance.now() - started })); return receipt; }
        catch (error) { Object.assign(write, { state: 'unconfirmed', error: clean(error instanceof Error ? error.message : String(error)), elapsedMs: performance.now() - started }); throw error; }
        finally { await persist(); }
      } }, scope, jobId: `capture:v2:${eventId}`, sourceEventId: eventId, cwd: path.join(root, 'memory-encoder'), callback, model,
      messages: [user], answer: reply.text, answerMessageId, policyVersion: 2, contextEpoch: 1 });
      item.capture = { ...captured, elapsedMs: performance.now() - captureStart, writes };
      item.timing = { ...row(item.timing), elapsedMs: performance.now() - start }; await persist();
    });
    const notes = await memory.list(scope), catalogBefore = await memory.catalog(scope, { limit: 60 }) as BotMemoryCatalog;
    report.automaticNotes = safe({ count: notes.length, notes, catalog: catalogBefore });
    if (notes.length < 3 || notes.some(note => note.indexState !== 'indexed')) throw new Error('AT_LEAST_THREE_REAL_AUTOMATIC_INDEXED_NOTES_REQUIRED');
    if (turns.some(turn => !row(turn.capture).notes)) throw new Error('A_SUBSTANTIVE_TURN_RETURNED_ZERO_CAPTURED_NOTES');
    const sourceProof = notes.every(note => turns.some(turn => note.sourceEventId === turn.eventId && note.sourceMessageIds.includes(String(turn.sourceMessageId))
      && note.sourceMessageIds.includes(String(turn.answerMessageId)) && note.content.includes(`来源事件：${turn.eventId}`)));
    if (!sourceProof) throw new Error('AUTOMATIC_NOTE_PROVENANCE_MISMATCH');
    await phase('cold-restart-appagent-and-vcp', async () => { await brain!.close(); await memory!.close(); brain = makeBrain('app-brain-cold'); memory = makeMemory(); });
    report.coldRestart = { vcpPidsBefore: sessions.slice(), appAgentRootChanged: true, rawUiHistoryProvidedAfterRestart: 0,
      encoderRemainsOneOwnedProcess: true, meaning: 'VCP resident and AppAgent restarted; embedding weights intentionally stay in the one shared test encoder.' };
    for (const mode of ['passive', 'semantic'] as const) await phase(`cold-${mode}-recall-and-fresh-answer`, async () => {
      const query = mode === 'passive' ? '晚上喝什么、上午咖啡怎么办？周六我最后约了哪里、几点、票和出发进度呢？'
        : '我之前问过桌面文件和执行器，那件事到底做到哪一步了？现在你能说已经看过或整理过了吗？';
      const recalled: BotMemoryRecallReport = await memory!.recall(scope, { query, mode });
      if (!recalled.hits.length) throw new Error(`COLD_${mode.toUpperCase()}_RECALL_EMPTY`);
      const eventId = randomUUID(), lane = `cold-${mode}-${randomUUID()}`;
      let preparedForReply: BotMemoryPrepared | undefined;
      if (mode === 'passive') preparedForReply = await memory!.prepareTurn({ scope, requestId: eventId,
        messages: [{ id: eventId, role: 'user', content: query, timestamp: Date.now(), senderId: 'user', senderName: '验收用户' }] });
      // Use the production passive card (including original temporal/source
      // metadata), or original LightMemo text; diagnostic projections are evidence
      // for the reviewer and must not silently strip material before the model.
      const memoryText = preparedForReply?.evidence ?? JSON.stringify({ kind: 'original-lightmemo-evidence', evidence: recalled.evidence,
        hits: recalled.hits.map(hit => ({ rank: hit.rank, date: hit.date, source: hit.source, text: hit.text, score: hit.score, scores: hit.scores })) });
      const built = context(query, eventId, lane, eventId, 1, memoryText);
      const start = performance.now(), reply = await brain!.run({ laneId: lane, eventId, cwd: root, system: built.system, prompt: built.user, model, tools: [], callback });
      const combined = recalled.hits.map(hit => hit.text).join('\n');
      const proof = mode === 'passive' ? { preferencePresent: /麦茶/.test(combined) && /上午|早上/.test(combined) && /咖啡/.test(combined),
        correctionPresent: /美术馆/.test(combined) && /(?:三点|3点|15[:：]00|15时)/.test(combined),
        notBookedPresent: /(?:尚未|还没|未|没有).{0,8}(?:预约|订票|预订)|(?:门票|预约).{0,8}(?:还没|尚未|未|没有)/u.test(combined), answerUsesCorrection: /美术馆/.test(reply.text) && /(?:三点|3点|15[:：]00|15时)/.test(reply.text),
        supersededPlanNotReopened: !/对不上|最后(?:约|定|是|安排).{0,12}哪(?:个|一)|确认(?:完|一下)?(?:最后的)?版本/u.test(reply.text),
        noUnsupportedLastWeek: !/上周|上个星期/u.test(reply.text) }
        : { desktopInteractionPresent: /桌面/.test(combined), unexecutedPresent: /未|没|尚未|仅|只讨论/.test(combined),
          answerDoesNotClaimExecution: /没|未|不能|无法/.test(reply.text) };
      const item = safe({ mode, query, reply: reply.text, status: reply.status, elapsedMs: performance.now() - start, report: recalled, proof,
        rawHistoryProvided: 0, modelMemoryMaterial: memoryText,
        materialBasis: mode === 'passive' ? 'production prepareTurn.evidence' : 'original LightMemo text and original rank fields',
        note: 'Semantic inspection is invoked by the harness; this does not claim autonomous model tool selection.' });
      cold.push(item); await persist();
      if (reply.status !== 'succeeded' || Object.values(proof).some(value => value !== true)) throw new Error(`COLD_${mode.toUpperCase()}_SEMANTIC_CHECK_FAILED_REVIEW_RAW_OUTPUT`);
      if (preparedForReply) await memory!.finishTurn(preparedForReply, reply.text, true);
    });
    if (sessions.length < 2 || sessions.at(-1) === sessions[0]) throw new Error('COLD_VCP_RESIDENT_PID_DID_NOT_CHANGE');
    report.checks = { automaticPolicy2: true, atLeastThreeIndexed: notes.length >= 3, sourceAttribution: sourceProof,
      bothColdRecallModes: cold.length === 2, noManualSeeds: true, noDsh: true, noDesktopReadOrFileMutation: true, modelBudget: Number(report.modelRequests) <= 10 };
    report.residentPids = sessions; report.passed = true;
  } catch (error) {
    report.failedStage = stage; errors.push({ stage, name: error instanceof Error ? error.name : 'Error', message: clean(error instanceof Error ? error.message : String(error)), code: row(error).code });
    if (!report.automaticNotes && memory) { const partial = await memory.list(report.scope as BotMemoryScope).catch(() => undefined);
      if (partial) report.automaticNotes = safe({ count: partial.length, notes: partial, snapshottedAfterFailure: true }); }
  }
  finally {
    await brain?.close().catch(error => errors.push({ stage: 'brain-close', message: clean(String(error)) }));
    await memory?.close().catch(error => errors.push({ stage: 'memory-close', message: clean(String(error)) }));
    await gateway.close(); await embedding.close();
    report.freeMemoryAfterGiB = os.freemem() / 1024 ** 3; await persist(); process.send?.(safe(report)); app.exit(report.passed ? 0 : 1);
  }
}).catch(() => { process.send?.({ kind: 'bot-auto-capture-result', passed: false, failedStage: 'electron-ready' }); app.exit(1); });
