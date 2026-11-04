import { app, safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain, type BotDshModel } from '../../src/main/companion-bot/dsh-brain';
import { BotService } from '../../src/main/companion-bot/service';
import { BotMemoryService } from '../../src/main/companion-bot/memory-service';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import { GLOBAL_EMBEDDING_SELECTION_ID } from '../../src/shared/embedding/global-profile';
import { BUILTIN_BOT_COMPANIONS, DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import { resolvePortableTools } from '../../src/main/portable-tools';
import type { BotDshRun } from '../../src/main/companion-bot/dsh-brain';

const root = process.env.WORLDLINEBOX_BOT_REAL_ROOT!, project = process.env.WORLDLINEBOX_BOT_REAL_PROJECT!, source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!, output = process.env.WORLDLINEBOX_BOT_PEER_OUTPUT!;
if (!root || !project || !source || !output || process.env.WORLDLINEBOX_BOT_PEER_REAL !== '1') throw Error('Explicit isolated peer acceptance inputs required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
let secret = '';
const clean = (value: string) => value.replaceAll(secret || '\0', '<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').replace(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g, '<redacted>');
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const safe = <T>(value: T): T => JSON.parse(clean(JSON.stringify(value))) as T;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

void app.whenReady().then(async () => {
  const protocolMemory = process.env.WORLDLINEBOX_BOT_PEER_MEMORY_PROTOCOL === '1';
  const requestBudget = process.env.WORLDLINEBOX_BOT_PEER_MAX_POSTS === '8' ? 8 : 3;
  const http: Row[] = [], tools: Row[] = [], errors: Row[] = [], stages: Row[] = [], invocations: Row[] = [], wireReads: Promise<void>[] = [];
  const report: Row = { kind: 'bot-peer-real-result', runId: path.basename(root), passed: false, createdAt: new Date().toISOString(),
    boundary: protocolMemory ? 'Fresh isolated BotService + actual AppBrain/provider + actual original VCP + local 768-dimensional vector protocol fixture. No EmbeddingGemma inference, memory-quality/latency claim, production chat history, DSH, or automatic diary-encoding model calls.'
      : 'Fresh isolated BotService + actual AppBrain/provider + actual original VCP + one owned CPU EmbeddingGemma 768. No production chat history, no DSH, no automatic diary-encoding model calls.',
    userInput: '你能让大肥鱼给我发晚安吗', sourceCompanion: 'GPT', destinationCompanion: '大肥鱼', maximumModelRequests: requestBudget,
    usesRealChatModel: true, usesRealVcp: true, modelRequests: 0, dshHostAttempts: 0, backgroundEncodingBlocked: 0, http, tools, errors, stages, invocations };
  let stage = 'initialization', service: BotService | undefined, memory: BotMemoryService | undefined, appBrain: BotAppBrain | undefined;
  const persist = () => writeFile(path.join(output, 'result.partial.json'), clean(JSON.stringify(report, null, 2)) + '\n');
  const phase = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    stage = name; process.send?.({ kind: 'bot-peer-real-progress', stage: name, modelRequests: report.modelRequests });
    const started = performance.now(); try { return await work(); } finally { stages.push({ name, elapsedMs: performance.now() - started }); await persist(); }
  };
  const embedding = new GlobalEmbeddingService({ userDataPath: path.join(root, 'embedding-state'), bundleDirectory: path.join(project, 'resources/embedding-models'),
    koffiPath: createRequire(path.join(project, 'package.json')).resolve('koffi'), devicePreference: () => ({ backend: 'cpu' }) });
  const gateway = new VcpEmbeddingGateway(embedding);
  let protocolServer: ReturnType<typeof createServer> | undefined, protocolBase: string | undefined;
  try {
    if (!protocolMemory && os.freemem() < 7 * 1024 ** 3) throw Error('INSUFFICIENT_FREE_MEMORY_FOR_ONE_OWNED_768_ENCODER');
    report.freeMemoryBeforeGiB = os.freemem() / 1024 ** 3;
    const profiles = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = profiles.profiles.find((value: { id: string }) => value.id === profiles.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw Error('GLOBAL_MODEL_UNAVAILABLE');
    secret = safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin')));
    const model: BotDshModel = { ...resolveStoredLlmConfig(profile), apiKey: secret };
    if (!secret || !model.baseUrl || model.apiFormat !== 'openai_chat') throw Error('GLOBAL_OPENAI_CHAT_CONFIGURATION_REQUIRED');
    report.model = { model: model.model, endpointHost: new URL(model.baseUrl).host, apiFormat: model.apiFormat };
    if (protocolMemory) await phase('owned-768-vector-protocol-fixture', async () => {
      protocolServer = createServer(async (request, response) => {
        let bytes = ''; for await (const chunk of request) bytes += chunk;
        if (!request.url?.endsWith('/v1/embeddings')) { response.writeHead(404).end(); return; }
        const payload = JSON.parse(bytes), inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', model: 'explicit-protocol-fixture-768',
          data: inputs.map((_: string, index: number) => ({ object: 'embedding', index, embedding: Array.from({ length: 768 }, (_, coordinate) => coordinate === 0 ? 1 : 0.01) })),
          usage: { prompt_tokens: 0, total_tokens: 0 } }));
      });
      await new Promise<void>(resolve => protocolServer!.listen(0, '127.0.0.1', resolve));
      const address = protocolServer.address(); if (!address || typeof address === 'string') throw Error('VECTOR_PROTOCOL_SERVER_UNAVAILABLE');
      protocolBase = `http://127.0.0.1:${address.port}`;
      report.embedding = { dimensions: 768, source: 'protocol-fixture', actualModelInference: false, ownedEncoderCount: 0 };
    });
    else await phase('one-owned-cpu-768-encoder', async () => {
      const vectors = await embedding.embed(['伙伴联系真实验收'], { purpose: 'query' });
      if (vectors.vectors[0]?.length !== 768 || vectors.profile.source !== 'local') throw Error('ACTUAL_BUNDLED_768_REQUIRED');
      report.embedding = { dimensions: 768, source: vectors.profile.source, model: vectors.profile.modelName, backend: 'cpu', ownedEncoderCount: 1 };
    });
    const nodePath = (await resolvePortableTools({ appPath: project })).nodeExecutable;
    const packageRoot = path.join(project, '.tools/bot-memory-release/vcp-memory');
    memory = new BotMemoryService({ root: path.join(root, 'memory'), maxActiveDomains: 3,
      runtime: async () => ({ nodePath, packageRoot }), embedding: async () => protocolMemory
        ? { baseUrl: `${protocolBase}/document`, queryBaseUrl: `${protocolBase}/query`, apiKey: 'explicit-local-protocol-fixture', model: 'explicit-protocol-fixture-768', dimension: 768, modelSignature: 'explicit-protocol-fixture-768-v1' }
        : gateway.configuration(GLOBAL_EMBEDDING_SELECTION_ID, await embedding.resolveProfile()),
      chat: async () => ({ baseUrl: 'http://127.0.0.1:9', model: 'disabled-hidden-vcp-chat', apiKey: 'unavailable', apiType: 'openai-completions' }),
      onDiagnostic: diagnostic => errors.push({ stage: 'memory-process', diagnostic: safe(diagnostic) }) });
    appBrain = new BotAppBrain({ root: path.join(root, 'app-brain'), maxSteps: requestBudget, requestTimeoutMs: 90000,
      reconcileTool: (call, signal) => service!.reconcileToolReceipt(call, signal), fetchFn: async (url, init) => {
        const endpoint = new URL(String(url)), payload = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        if (endpoint.hostname === '127.0.0.1' && endpoint.pathname === '/bot/tool') {
          const item: Row = { name: payload?.name, args: payload?.args, laneId: payload?.laneId, eventId: payload?.eventId, callId: payload?.callId, startedAt: new Date().toISOString() }; tools.push(item);
          const started = performance.now(), response = await fetch(url, init); item.status = response.status;
          wireReads.push(response.clone().json().then(value => { item.response = safe(value); item.elapsedMs = performance.now() - started; })); return response;
        }
        if (endpoint.origin !== new URL(model.baseUrl).origin || init?.method !== 'POST') throw Error('UNEXPECTED_PROVIDER_ENDPOINT');
        if (Number(report.modelRequests) >= requestBudget) throw Error(`ACCEPTANCE_${requestBudget}_PROVIDER_REQUEST_BUDGET_EXHAUSTED`);
        report.modelRequests = Number(report.modelRequests) + 1;
        const item: Row = { ordinal: report.modelRequests, startedAt: new Date().toISOString(), request: payload }; http.push(item);
        const started = performance.now(), response = await fetch(url, init); item.status = response.status; item.headersMs = performance.now() - started;
        wireReads.push(response.clone().text().then(text => {
          item.rawSse = clean(text); item.elapsedMs = performance.now() - started;
          const usages = text.split('\n').flatMap(line => { try { return line.startsWith('data: ') ? [row(JSON.parse(line.slice(6))).usage].filter(Boolean) : []; } catch { return []; } });
          if (usages.length) item.usage = usages.at(-1);
        })); return response;
      } });
    const appRuntime = appBrain;
    const guardedApp = { run: async (input: BotDshRun) => {
      if (input.laneId.startsWith('memory-encoder-') || input.laneId.startsWith('memory-maintenance-')) {
        report.backgroundEncodingBlocked = Number(report.backgroundEncodingBlocked) + 1;
        throw Object.assign(Error('Acceptance limits paid requests to the contact conversation; automatic diary encoding is not under test.'), { code: 'ACCEPTANCE_BACKGROUND_ENCODING_DISABLED' });
      }
      const item: Row = { eventId: input.eventId, laneId: input.laneId, system: input.system, prompt: input.prompt, startedAt: new Date().toISOString() }; invocations.push(item);
      const started = performance.now();
      try { const result = await appRuntime.run(input); item.result = safe(result); return result; }
      finally { item.elapsedMs = performance.now() - started; }
    }, cancel: appRuntime.cancel.bind(appRuntime), cancelDurable: appRuntime.cancelDurable.bind(appRuntime), handoff: appRuntime.handoff.bind(appRuntime), archive: appRuntime.archive.bind(appRuntime), close: appRuntime.close.bind(appRuntime) };
    const worker = new BotDshBrain({ getHost: async () => { report.dshHostAttempts = Number(report.dshHostAttempts) + 1; throw Error('DSH_FORBIDDEN_IN_PEER_ACCEPTANCE'); } });
    service = new BotService({ root: path.join(root, 'bot-service'), brain: new BotBrainRouter({ app: guardedApp, worker }), brainRuntime: 'worldlinebox', memory,
      model: () => model, onEvent: () => undefined, report: error => errors.push({ stage, name: error instanceof Error ? error.name : 'Error', message: clean(error instanceof Error ? error.message : String(error)) }) });
    await phase('natural-private-request', async () => {
      const state = (await service!.handle({ type: 'state' })).snapshot!;
      if (state.messages.length || state.tasks.length) throw Error('FRESH_ISOLATED_PROFILE_REQUIRED');
      const gpt = BUILTIN_BOT_COMPANIONS.find(value => value.name === 'GPT'); if (!gpt) throw Error('BUILTIN_GPT_REQUIRED');
      const direct = await service!.handle({ type: 'conversation.open', companionId: gpt.id });
      const started = performance.now();
      const sent = await service!.handle({ type: 'message.send', conversationId: direct.conversationId!, requestId: 'natural-contact-once', content: String(report.userInput) });
      if (!sent.ok || !sent.messageId) throw Error(sent.error ?? 'USER_MESSAGE_REJECTED');
      report.source = { companionId: gpt.id, conversationId: direct.conversationId, userMessageId: sent.messageId };
      const deadline = Date.now() + 180000;
      let idleSince: number | undefined;
      while (Date.now() < deadline) {
        const current = (await service!.handle({ type: 'state', conversationId: direct.conversationId })).snapshot!;
        const inbox = service!.store.taskTransaction(sql => sql.prepare('SELECT id,lane_id,conversation_id,companion_id,source,sender_id,sender_name,status,payload_json,causation_id,error FROM bot_inbox ORDER BY sequence').all() as Row[]);
        const pendingInbox = inbox.filter(event => event.status === 'queued' || event.status === 'running');
        const idle = pendingInbox.length === 0 && current.runtime.activeLanes === 0;
        if (idle) idleSince ??= Date.now(); else idleSince = undefined;
        report.inbox = safe(inbox);
        report.idle = { pendingInbox: pendingInbox.length, activeLanes: current.runtime.activeLanes, stableMs: idleSince === undefined ? 0 : Date.now() - idleSince };
        report.maximumCausalHopObserved = Math.max(0, ...inbox.map(event => Number(row(JSON.parse(String(event.payload_json))).hop ?? 0)));
        const peers = current.conversations.filter(room => room.peerConversation && room.memberIds.includes(gpt.id) && room.memberIds.includes(DEFAULT_BOT_COMPANION_ID));
        const originDone = current.messages.some(message => message.senderId === gpt.id && ['sent', 'failed', 'cancelled'].includes(message.status));
        if (originDone && !peers.length) { report.sourceSnapshot = safe(current); throw Error('REAL_MODEL_DID_NOT_CREATE_PEER_CONTACT'); }
        if (peers.length) {
          const peer = (await service!.handle({ type: 'state', conversationId: peers[0]!.id })).snapshot!;
          report.sourceSnapshot = safe(current); report.peerSnapshot = safe(peer);
          const replies = peer.messages.filter(message => message.senderId === DEFAULT_BOT_COMPANION_ID && ['sent', 'failed', 'cancelled'].includes(message.status));
          if (originDone && replies.length && idleSince !== undefined && Date.now() - idleSince >= 500) {
            report.totalContactMs = performance.now() - started; report.sourceSnapshot = safe(current); report.peerSnapshot = safe(peer);
            const target = replies.find(message => message.status === 'sent' && /晚安/.test(message.content));
            const actualContact = tools.some(tool => tool.name === 'companion_contact' && row(tool.args).companionId === DEFAULT_BOT_COMPANION_ID);
            report.checks = { naturalInputUnchanged: true, actualContactTool: actualContact, separateVisibleRoom: peers[0]!.id !== direct.conversationId,
              userCanWatch: peers[0]!.memberIds.includes('user'), targetOwnResponse: target?.senderName === '大肥鱼',
              targetTurnComplete: peer.messages.some(message => message.senderId === DEFAULT_BOT_COMPANION_ID && message.id.startsWith('reply-') && message.status === 'sent'),
              targetTurnHasNoFailedPlaceholder: !peer.messages.some(message => message.senderId === DEFAULT_BOT_COMPANION_ID && message.id.startsWith('reply-') && message.status === 'failed'),
              allConversationEventsComplete: inbox.every(event => event.status === 'done'), allVisibleRepliesSuccessful: [...current.messages, ...peer.messages].every(message => message.senderId === 'user' || message.status === 'sent'),
              fullyIdle: true, noDsh: Number(report.dshHostAttempts) === 0, providerBudget: Number(report.modelRequests) <= requestBudget };
            if (!Object.values(row(report.checks)).every(value => value === true)) throw Error('REVIEW_ACTUAL_PEER_RESPONSE_AND_RECEIPTS');
            report.passed = true; return;
          }
        }
        await pause(100);
      }
      throw Error('PEER_CONVERSATION_DID_NOT_SETTLE_WITHIN_ACCEPTANCE_WINDOW');
    });
  } catch (error) { report.failedStage = stage; errors.push({ stage, name: error instanceof Error ? error.name : 'Error', message: clean(error instanceof Error ? error.message : String(error)) }); }
  finally {
    if (service) {
      report.contactReceipts = service.store.taskTransaction(sql => sql.prepare("SELECT key,value FROM bot_metadata WHERE key LIKE 'peer-contact-receipt:%'").all());
      await service.shutdown().catch(error => { errors.push({ stage: 'service-shutdown', message: clean(String(error)) }); report.passed = false; });
    } else { await appBrain?.close().catch(() => undefined); await memory?.close().catch(() => undefined); }
    await Promise.allSettled(wireReads); await gateway.close(); await embedding.close();
    if (protocolServer) await new Promise<void>((resolve, reject) => protocolServer!.close(error => error ? reject(error) : resolve()));
    report.rawEvidenceSha256 = createHash('sha256').update(clean(JSON.stringify({ http, tools, invocations }))).digest('hex');
    report.actualProviderUsage = http.reduce<Row>((total, request) => {
      const usage = row(request.usage);
      for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']) {
        if (typeof usage[field] === 'number') total[field] = Number(total[field] ?? 0) + Number(usage[field]);
      }
      return total;
    }, {});
    report.outcome = report.passed ? 'passed' : tools.some(tool => tool.name === 'companion_contact') ? 'partial' : 'failed';
    await persist(); await new Promise<void>(resolve => { if (process.send) process.send(safe(report), () => resolve()); else resolve(); }); app.exit(report.passed ? 0 : 1);
  }
}).catch(() => { process.send?.({ kind: 'bot-peer-real-result', passed: false, failedStage: 'electron-ready' }); app.exit(1); });
