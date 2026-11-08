/** Opt-in actual Router -> installed DSH -> configured provider -> Router
 * acceptance. Only memory is disabled; results and tool calls are genuine. */
import { app, safeStorage } from 'electron';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain, type BotDshResult } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import { createBotNativeHost } from './bot-native-host';
import { preserveBotNativeJournals } from './bot-native-journal-evidence';

const root = process.env.WORLDLINEBOX_WORKER_DELIVERY_ROOT!, output = process.env.WORLDLINEBOX_WORKER_DELIVERY_OUTPUT!;
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!;
if (process.env.WORLDLINEBOX_WORKER_DELIVERY_REAL !== '1' || !root || !output || !source) throw Error('Explicit isolated real acceptance inputs required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
class NoMemory extends BotMemoryService {
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'delivery-test-memory-disabled', metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
  }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { archived: true }; }
  override async close() {}
}

void app.whenReady().then(async () => {
  let service: BotService | undefined, native: Awaited<ReturnType<typeof createBotNativeHost>> | undefined, secret = '', stage = 'configuration';
  const report: Record<string, unknown> = { kind: 'worker-delivery-result', passed: false, actualRouter: false, actualNativeWorker: false,
    usesRealProvider: true, memoryDisabled: true, maximumProviderRequests: 18, providerRequests: 0, nativeDispatches: 0,
    boundary: 'Isolated production BotService/App Router, installed native DSH and actual configured provider through a bounded transparent local HTTP relay. Fixture source files only; no real weather claim or production conversations/instances modified.' };
  const errors: string[] = [], outcomes: BotDshResult[] = [];
  const clean = (text: string) => text.replaceAll(secret || '\0', '<redacted>').replace(/Bearer\s+\S+/giu, 'Bearer <redacted>');
  const progress = (value: string) => { stage = value; process.send?.({ kind: 'worker-delivery-progress', stage, providerRequests: report.providerRequests }); };
  let providerBase = '';
  const relay = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url || !/^\/(?:v1\/)?chat\/completions$/u.test(request.url)) throw Error('Unexpected relay route.');
      if (!secret || request.headers.authorization !== `Bearer ${secret}`) throw Error('Unauthenticated acceptance request.');
      if (Number(report.providerRequests) >= 18) throw Error('Acceptance provider budget exhausted.');
      report.providerRequests = Number(report.providerRequests) + 1;
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const target = new URL(providerBase); target.pathname = target.pathname.replace(/\/$/u, '') + '/chat/completions';
      const upstream = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: Buffer.concat(chunks), signal: AbortSignal.timeout(90000), redirect: 'error' });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
      response.end();
    } catch (error) { errors.push(clean(String(error))); if (!response.headersSent) response.writeHead(502); response.end('{"error":{"message":"Acceptance relay unavailable"}}'); }
  });
  try {
    const catalog = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = catalog.profiles.find((entry: { id: string }) => entry.id === catalog.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/u.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw Error('No decryptable configured model.');
    const configured = resolveStoredLlmConfig(profile);
    secret = safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin')));
    if (configured.apiFormat !== 'openai_chat' || !configured.baseUrl || !secret) throw Error('An OpenAI Chat compatible model is required.');
    providerBase = configured.baseUrl;
    report.model = { model: configured.model, endpointHost: new URL(providerBase).host, apiFormat: configured.apiFormat };
    relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
    const address = relay.address(); if (!address || typeof address === 'string') throw Error('No relay port.');
    const model = { ...configured, apiKey: secret, baseUrl: `http://127.0.0.1:${address.port}/v1`, maxTokens: 4096, maxOutputTokens: 4096 };
    progress('native-host');
    native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
    process.send?.({ kind: 'worker-delivery-owned-root', root: native.root });
    const client = await native.instances.ensureHost(native.instance.id); report.dshVersion = native.runtimeVersion;
    const botRoot = path.join(root, 'bot'), inputs = path.join(root, 'inputs'); await mkdir(inputs);
    const media = new BotMediaService({ root: path.join(botRoot, 'media'), builtinRoot: path.resolve('resources/bot-stickers') });
    const worker = new BotDshBrain({ getHost: async () => ({ client }) });
    const brain = new BotBrainRouter({ worker, app: new BotAppBrain({ root: path.join(botRoot, 'router'),
      fetchFn: fetch, reconcileTool: (call, signal) => service!.reconcileToolReceipt(call, signal) }) });
    const run = brain.run.bind(brain);
    brain.run = async input => {
      if (input.role === 'worker') { report.nativeDispatches = Number(report.nativeDispatches) + 1; await writeFile(path.join(output, 'worker-prompt.txt'), input.prompt); }
      const result = await run(input);
      if (input.role === 'worker') { outcomes.push(result); report.actualNativeWorker = true; }
      else report.actualRouter = true;
      return result;
    };
    service = new BotService({ root: botRoot, brainRuntime: 'worldlinebox', brain, media, prewarmMemory: false,
      memory: new NoMemory({ root: path.join(botRoot, 'memory'), runtime: async () => { throw Error('Memory disabled.'); }, embedding: async () => { throw Error('No embedding in this acceptance.'); } }),
      model: () => model, onEvent() {}, report: error => errors.push(clean(String(error))) });
    await service.handle({ type: 'state' });
    const conversationId = service.store.openDirect('claude').id;
    const files: Record<string, string> = {
      'receipt.csv': 'id,gross_cents,shipping_cents,refund_cents\nL701,10000,500,200\nL702,11435,750,200\n',
      'correction.md': '本次只读验收：净额=毛额-运费-退款。L702退款改为550分，替换原值，不相加。所有金额原单位为分。核对标记：CEDAR-4829。\n',
    };
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(inputs, name), text);
    const refs = await media.importFiles({ conversationId, paths: Object.keys(files).map(name => path.join(inputs, name)) });
    progress('router-dispatch');
    const sent = await service.handle({ type: 'message.send', conversationId, attachmentIds: refs.map(ref => ref.id), requestId: randomUUID(),
      content: '请派一个DSH执行器读取这两份文件，只读汇总两笔收据的毛额、运费、实际退款和净额，按更正规则处理，统一换算成人民币元，附核对标记和两份来源文件名。不得访问网络、不得修改或生成文件。把完整可转述答案放在worker_report的ready.summary，verification说明核对依据。为验证交付链路，执行器最终回复可以只写“已完成”，不能要求我自己去看上面的回答。你在收到完成事件后必须直接告诉我具体金额、核对标记和来源，不要另派任务，不要保存记忆。' });
    if (!sent.ok) throw Error('Request not accepted.');
    const sourceEventId = service.store.getMessage(sent.replyMessageIds![0]!)!.eventId;
    service.store.setMetadata(`skipCapture:${sourceEventId}`, 'true');
    const deadline = Date.now() + 240000;
    let task = service.store.listTasks()[0];
    while (Date.now() < deadline) {
      await service.handle({ type: 'state', conversationId }); task = service.store.listTasks()[0];
      const messages = service.store.recentMessages(conversationId, { limit: 30 });
      const answer = messages.find(message => message.senderId === 'claude' && message.status === 'sent' && message.content.includes('194.35') && message.content.includes('CEDAR-4829'));
      if (task?.status === 'succeeded' && answer) { report.routerAnswer = answer.content; break; }
      if (task && ['failed', 'paused', 'cancelled', 'unknown'].includes(task.status)) throw Error('Worker did not succeed: ' + task.status + ' ' + (task.error ?? ''));
      await pause(250);
    }
    progress('assert-delivery');
    if (!task || task.status !== 'succeeded' || !report.routerAnswer) throw Error('Router did not publish the actual complete result.');
    if (service.store.listTasks().length !== 1 || Number(report.nativeDispatches) !== 1) throw Error('Delivery caused an extra task or native execution.');
    const business = task.extra.workerReport as { state?: string; summary?: string; verification?: string[] } | undefined;
    if (business?.state !== 'ready' || !business.summary?.includes('194.35') || !business.summary.includes('CEDAR-4829') || !business.verification?.length) throw Error('The actual Worker did not return the required self-contained ready report.');
    if (!task.summary?.includes('194.35') || !task.summary.includes('CEDAR-4829')) throw Error('The task persisted a closing line without the business result.');
    const notice = service.store.taskTransaction(sql => sql.prepare("SELECT content FROM bot_inbox WHERE source='task' AND kind='task_done' AND json_extract(payload_json,'$.taskId')=?").get(task!.id)) as { content: string } | undefined;
    if (!notice?.content.includes('194.35') || !notice.content.includes('CEDAR-4829')) throw Error('Router completion event omitted the answer.');
    for (const [name, bytes] of Object.entries(files)) if (digest(await readFile(path.join(inputs, name))) !== digest(bytes)) throw Error('Original source changed.');
    report.task = { id: task.id, status: task.status, summary: task.summary, businessReport: business };
    report.workerOutcomes = outcomes; report.completionNotice = notice.content; report.oneNativeExecution = true; report.sourceFilesUnchanged = true;
    report.journals = await preserveBotNativeJournals(native.root, path.join(output, 'native-journals.json'), clean);
    report.passed = true;
  } catch (error) { report.error = clean(error instanceof Error ? error.message : String(error)); report.failedStage = stage; }
  finally {
    report.errors = errors;
    if (service) try { await writeFile(path.join(output, 'chat-evidence.json'), clean(JSON.stringify({ tasks: service.store.listTasks(),
      messages: service.store.conversations().flatMap(room => service!.store.recentMessages(room.id, { limit: 30 })) }, null, 2))); }
    catch (error) { report.diagnosticError = clean(String(error)); }
    try { await service?.shutdown(); await native?.close(); } catch (error) { report.passed = false; report.cleanupError = clean(String(error)); }
    relay.closeAllConnections(); await new Promise<void>(resolve => relay.close(() => resolve()));
    await writeFile(path.join(output, 'result.partial.json'), clean(JSON.stringify(report, null, 2)) + '\n');
    process.send?.(report); app.exit(report.passed ? 0 : 1);
  }
});
