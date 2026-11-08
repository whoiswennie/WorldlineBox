import { app, safeStorage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain, type BotDshModel } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BUILTIN_BOT_COMPANIONS } from '../../src/shared/builtin-bot-companions';
import { resolveStoredLlmConfig } from '../../src/shared/llm';

const root = process.env.WORLDLINEBOX_PEER_CONTINUITY_ROOT!, output = process.env.WORLDLINEBOX_PEER_CONTINUITY_OUTPUT!;
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!;
if (!root || !output || !source || process.env.WORLDLINEBOX_PEER_CONTINUITY_REAL !== '1') throw Error('Isolated real-model acceptance inputs required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
let key = '';
const clean = (value: string) => value.replaceAll(key || '\0', '<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const secret = 'PEER_UNSHARED_WORKER_RECEIPT_606';
const publicMarker = '海盐曲奇';
type Row = Record<string, unknown>;
class NoMemory extends BotMemoryService {
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'continuity-memory-disabled', metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
  }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async appendHistory() { return { archived: true }; }
  override async finishTurn() { return { recorded: true }; }
  override async close() {}
}
void app.whenReady().then(async () => {
  const report: Row = { kind: 'peer-continuity-result', passed: false, maximumProviderRequests: 6,
    boundary: 'Actual isolated BotService, SQLite live conversation reads, authenticated AppBrain HTTP tool callbacks and configured official DeepSeek. Seeded past conversations are fixtures; one peer incoming event is intentionally delayed to reproduce published-before-processed timing. No actual DSH, VCP or user production history.',
    usesRealModel: true, usesDsh: false, usesMemoryInference: false, cases: [] };
  let service: BotService | undefined, brain: BotAppBrain | undefined, requests = 0, hostAttempts = 0;
  const tools: Row[] = [], wires: Row[] = [], reads: Promise<void>[] = [], errors: string[] = [];
  try {
    const profiles = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = profiles.profiles.find((value: { id: string }) => value.id === profiles.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/u.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw Error('Current model unavailable.');
    key = safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin')));
    const configured: BotDshModel = { ...resolveStoredLlmConfig(profile), apiKey: key };
    if (!key || configured.apiFormat !== 'openai_chat' || new URL(configured.baseUrl).protocol !== 'https:') throw Error('Configured HTTPS OpenAI Chat model required.');
    const model = { ...configured, maxTokens: 1024 };
    report.model = { model: model.model, endpointHost: new URL(model.baseUrl).host, apiFormat: model.apiFormat };
    brain = new BotAppBrain({ root: path.join(root, 'router'), maxSteps: 6, requestTimeoutMs: 90000,
      reconcileTool: (call, signal) => service!.reconcileToolReceipt(call, signal), fetchFn: async (url, init) => {
        const destination = new URL(String(url)), body = JSON.parse(String(init?.body));
        if (destination.hostname === '127.0.0.1' && destination.pathname === '/bot/tool') {
          const record: Row = { name: body.name, args: body.args }; tools.push(record);
          if (/^chat_send_/u.test(body.name) || !/^(?:chat_|agent_conversations$|agent_state$|agent_memory_scopes$|agent_read_tool_result$)/u.test(body.name)) throw Error('Unexpected non-chat read tool in continuity acceptance: ' + body.name);
          const response = await fetch(url, init); record.status = response.status;
          reads.push(response.clone().json().then(value => { record.response = value; })); return response;
        }
        if (destination.origin !== new URL(model.baseUrl).origin || init?.method !== 'POST') throw Error('Unexpected model route.');
        if (requests >= 6) throw Error('Six-request real provider budget exhausted.');
        if (JSON.stringify(body).includes(secret)) throw Error('Unpublished worker notice reached provider wire.');
        requests++; const wire: Row = { ordinal: requests, request: body }; wires.push(wire);
        const response = await fetch(url, { ...init, redirect: 'error' }); wire.status = response.status;
        reads.push(response.clone().text().then(text => { wire.response = clean(text); })); return response;
      } });
    const memory = new NoMemory({ root: path.join(root, 'memory'), runtime: async () => { throw Error('Memory inference disabled in continuity acceptance.'); }, embedding: async () => { throw Error('Embedding disabled.'); } });
    service = new BotService({ root: path.join(root, 'service'), brainRuntime: 'worldlinebox', prewarmMemory: false,
      brain: new BotBrainRouter({ app: brain, worker: new BotDshBrain({ getHost: async () => { hostAttempts++; throw Error('DSH not part of chat continuity acceptance.'); } }) }),
      memory, model: () => model, onEvent: () => undefined, report: error => errors.push(clean(String(error))) });
    await service.handle({ type: 'state' });
    const claude = BUILTIN_BOT_COMPANIONS.find(value => value.name === 'Claude')!;
    const fish = BUILTIN_BOT_COMPANIONS.find(value => value.name === '大肥鱼')!;
    for (const actor of service.store.listCompanions()) service.store.setCompanionEnabled(actor.id, actor.id === claude.id);
    const direct = service.store.openDirect(claude.id), peer = service.store.openPeer(claude.id, fish.id);
    service.store.enqueue({ conversationId: direct.id, senderId: claude.id, recipientIds: [], sourceMessageId: 'old-user-facing-status', content: '我去问大肥鱼了，还在等她回复，回来了我告诉你。' });
    const original = service.store.enqueue({ conversationId: peer.id, senderId: claude.id, recipientIds: [fish.id], sourceMessageId: 'old-peer-contact', content: '大肥鱼，你答应一起散步的事定了吗？我们还说好有个暗号。' }).events[0]!;
    const hidden = service.store.createTask({ id: 'hidden-peer-worker-notice', conversationId: peer.id, companionId: fish.id, sourceEventId: original.id, goal: '未公开的内部任务' });
    service.store.updateTask(hidden.id, { status: 'succeeded', summary: secret });
    service.store.enqueueTaskNotice({ conversationId: peer.id, source: 'task', senderId: 'task-service', recipientIds: [fish.id], sourceMessageId: 'hidden-peer-task-done', kind: 'task_done',
      content: secret, causationId: original.id, correlationId: original.correlationId, payload: { taskId: hidden.id } });
    const publishedReply = service.store.enqueue({ conversationId: peer.id, senderId: fish.id, recipientIds: [claude.id], sourceMessageId: 'latest-peer-reply',
      content: `我回来啦，散步的事定了，下午一起去。暗号是“${publicMarker}”，你别忘了。`, correlationId: original.correlationId, causationId: original.id });
    const delayedEvent = publishedReply.events[0]!;
    service.store.taskTransaction(sql => sql.prepare('UPDATE bot_inbox SET available_at=? WHERE id=?').run(Date.now() + 600000, delayedEvent.id));
    const userInput = '大肥鱼是不是还没回你？帮我确认一下你们私聊里她最后一条回复。你们提到的暗号是什么？先核实实时聊天记录，不要再给她发消息，也不要保存记忆。';
    const sent = await service.handle({ type: 'message.send', conversationId: direct.id, requestId: 'real-user-asks-current-peer-status', content: userInput });
    if (!sent.ok) throw Error('Current user question was not accepted.');
    const sourceEvent = service.store.getMessage(sent.replyMessageIds![0]!)!.eventId;
    service.store.setMetadata(`skipCapture:${sourceEvent}`, 'true');
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline && !['done', 'failed', 'cancelled'].includes(service.store.getEvent(sourceEvent)!.status)) await pause(100);
    await Promise.allSettled(reads);
    const event = service.store.getEvent(sourceEvent)!, answer = service.store.getMessage(event.replyMessageId)!;
    const checks = { actualMainBrainFinished: event.status === 'done' && answer.status === 'sent',
      actualReadToolReturnedPublicReply: tools.some(tool => tool.name === 'agent_conversations' && JSON.stringify(tool.response).includes(publicMarker)),
      publicMarkerCorrect: answer.content.includes(publicMarker),
      didNotRepeatStaleNoReply: !/(?:大肥鱼|她)(?:现在|这边|那边)?(?:还没|尚未|没有)(?:有)?(?:回|回复)/u.test(answer.content),
      privateWorkerNoticeExcluded: !JSON.stringify(wires).includes(secret) && !answer.content.includes(secret),
      peerReplyWasPublishedButUnprocessed: service.store.getEvent(delayedEvent.id)?.status === 'queued',
      noNewContact: !tools.some(tool => ['companion_contact', 'message_peer', 'companion_delegate'].includes(String(tool.name))), noDsh: hostAttempts === 0,
      sourcePeerMessageIntact: service.store.getMessage(publishedReply.message.id)?.content.includes(publicMarker) === true };
    report.cases = [{ label: 'same-actor-direct-checks-current-peer-reply', input: userInput, response: answer.content, checks }];
    report.roomIds = { direct: direct.id, peer: peer.id }; report.delayedPeerEventId = delayedEvent.id;
    report.passed = Object.values(checks).every(Boolean);
  } catch (error) { report.error = { name: error instanceof Error ? error.name : 'Error', message: clean(error instanceof Error ? error.message : String(error)) }; }
  finally {
    await service?.shutdown(); if (!service) await brain?.close(); await Promise.allSettled(reads);
    report.providerRequests = requests; report.hostAttempts = hostAttempts; report.tools = tools; report.requests = wires; report.errors = errors;
    await writeFile(path.join(output, 'result.partial.json'), clean(JSON.stringify(report, null, 2)));
    await new Promise<void>(resolve => { if (process.send) process.send(JSON.parse(clean(JSON.stringify(report))), () => resolve()); else resolve(); }); app.exit(report.passed ? 0 : 1);
  }
}).catch(() => { process.send?.({ kind: 'peer-continuity-result', passed: false, stage: 'electron-ready' }); app.exit(1); });
