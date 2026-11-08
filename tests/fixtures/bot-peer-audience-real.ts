import { app, safeStorage } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { buildBotContext } from '../../src/main/companion-bot/context';
import { BUILTIN_BOT_COMPANIONS } from '../../src/shared/builtin-bot-companions';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import type { BotDshModel } from '../../src/main/companion-bot/dsh-brain';
import type { BotEvent } from '../../src/main/companion-bot/types';

const root = process.env.WORLDLINEBOX_PEER_AUDIENCE_ROOT!, output = process.env.WORLDLINEBOX_PEER_AUDIENCE_OUTPUT!;
const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!;
if (!root || !output || !source || process.env.WORLDLINEBOX_PEER_AUDIENCE_REAL !== '1') throw Error('Isolated real-model acceptance inputs required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
let key = '';
const clean = (value: string) => value.replaceAll(key || '\0', '<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
const privateSentinel = 'PRIVATE_WORKER_WEATHER_RECEIPT_6B82';
const privateBody = `上海气温16.6°C；${privateSentinel}；内部任务回执尚未向Claude或本房间公开。`;
void app.whenReady().then(async () => {
  const report: Record<string, unknown> = { kind: 'peer-audience-result', passed: false, maximumProviderRequests: 8,
    boundary: 'Actual isolated BotStore SQL -> production buildBotContext owner/audience projection -> actual BotAppBrain -> configured official provider. Seeded task notices are fixtures, not executed weather or DSH. BotService scheduler, native Workers, memory inference and user UI are not measured by this acceptance.',
    usesRealModel: true, usesDsh: false, usesMemoryInference: false, cases: [] };
  let store: BotStore | undefined, brain: BotAppBrain | undefined, requests = 0;
  const cases = report.cases as Array<Record<string, unknown>>;
  const requestsLog: Array<Record<string, unknown>> = [], reads: Promise<void>[] = [];
  try {
    const profiles = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = profiles.profiles.find((value: { id: string }) => value.id === profiles.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/u.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw Error('Current model unavailable.');
    key = safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin')));
    const configured: BotDshModel = { ...resolveStoredLlmConfig(profile), apiKey: key };
    if (!key || configured.apiFormat !== 'openai_chat' || new URL(configured.baseUrl).protocol !== 'https:') throw Error('Configured HTTPS OpenAI Chat model required.');
    const model = { ...configured, maxTokens: 1024 };
    report.model = { model: model.model, endpointHost: new URL(model.baseUrl).host, apiFormat: model.apiFormat };
    await mkdir(path.join(root, 'router'), { recursive: true });
    store = new BotStore(path.join(root, 'bot.sqlite'));
    const claude = store.createCompanion({ id: 'claude', name: 'Claude', persona: BUILTIN_BOT_COMPANIONS.find(value => value.name === 'Claude')!.persona });
    const fish = store.createCompanion({ id: 'fish', name: '大肥鱼', persona: '像真实伙伴一样交流。' });
    const room = store.openPeer(claude.id, fish.id);
    const origin = store.enqueue({ conversationId: room.id, senderId: claude.id, recipientIds: [fish.id], sourceMessageId: 'existing-task-source', content: '你之前接手的天气记录，请照原目标核对就好。' }).events[0]!;
    const hidden = store.createTask({ id: 'fish-private-completed-task', conversationId: room.id, companionId: fish.id, sourceEventId: origin.id, goal: '核对上海天气记录' });
    store.updateTask(hidden.id, { status: 'succeeded', summary: privateBody });
    store.enqueueTaskNotice({ conversationId: room.id, source: 'task', senderId: 'task-service', recipientIds: [fish.id],
      sourceMessageId: 'fish-private-result-notice', kind: 'task_done', content: privateBody,
      causationId: origin.id, correlationId: origin.correlationId, payload: { taskId: hidden.id } });
    const running = store.createTask({ id: 'fish-private-active-task', conversationId: room.id, companionId: fish.id, sourceEventId: origin.id, goal: '另一个尚未公开的内部核对任务' });
    store.updateTask(running.id, { status: 'waiting', summary: privateBody });
    brain = new BotAppBrain({ root: path.join(root, 'router'), maxSteps: 1, requestTimeoutMs: 90000, fetchFn: async (url, init) => {
      const destination = new URL(String(url));
      if (destination.origin !== new URL(model.baseUrl).origin || init?.method !== 'POST') throw Error('Unexpected provider route.');
      if (requests >= 8) throw Error('Hard eight-request provider limit reached.');
      requests++;
      const payload = JSON.parse(String(init.body));
      if (JSON.stringify(payload).includes(privateSentinel) || /16\.6/u.test(JSON.stringify(payload))) throw Error('Unpublished private receipt reached provider wire.');
      const record = { ordinal: requests, request: payload } as Record<string, unknown>; requestsLog.push(record);
      const response = await fetch(url, { ...init, redirect: 'error' }); record.status = response.status;
      reads.push(response.clone().text().then(body => { record.response = clean(body); })); return response;
    } });
    const ask = async (label: string, event: BotEvent, expectedTemperature = false) => {
      const allMessages = store!.messagesPage(room.id, { limit: 100 }).items;
      const context = buildBotContext({ companion: claude, event, conversation: room, participants: [claude, fish],
        messages: allMessages, tasks: store!.listTasks() });
      if (context.user.includes(privateSentinel) || /16\.6/u.test(context.user)) throw Error('Private SQL receipt escaped owner projection.');
      const envelope = JSON.parse(context.user);
      if (envelope.room.replyAudience?.recipients?.[0]?.id !== fish.id || envelope.room.replyAudience.userIsObserver !== true) throw Error('Peer audience not bound to the actual receiver.');
      const answer = await brain!.run({ role: 'brain', laneId: event.laneId, eventId: event.id, cwd: root,
        system: context.system, prompt: context.user, tools: [], model,
        callback: { url: 'http://127.0.0.1:9/unavailable', token: 'no-tools-in-this-acceptance' } });
      const text = answer.text.trim();
      const checks = { succeeded: answer.status === 'succeeded', nonempty: !!text,
        privateReceiptNotDisclosed: !text.includes(privateSentinel) && !/16\.6/u.test(text),
        notRelayingToObserver: !/我(?:回|回复|转告|告诉)(?:了)?(?:她|大肥鱼)[：:，,]/u.test(text)
          && !/(?:大肥鱼(?:刚才)?(?:说|回复)|我已(?:经)?(?:给|向)大肥鱼(?:回|回复))/u.test(text),
        ...(expectedTemperature ? { publicTemperatureUsed: /(?:17|十七)\s*(?:°?\s*[CcＣ]?|度)/u.test(text) } : {}) };
      cases.push({ label, input: event.content, source: event.source, response: text, room: envelope.room, tasks: envelope.tasks,
        sqlContainsPrivateReceipt: store!.getTask(hidden.id)?.summary === privateBody, checks });
      await writeFile(path.join(output, `${label}.context.json`), clean(JSON.stringify({ system: context.system, envelope }, null, 2)));
      await writeFile(path.join(output, 'result.partial.json'), clean(JSON.stringify(report, null, 2)));
      if (!Object.values(checks).every(Boolean)) throw Error(`Actual model audience/receipt check failed: ${label}`);
      store!.enqueue({ conversationId: room.id, senderId: claude.id, recipientIds: [], sourceMessageId: `actual-reply-${label}`, content: text });
    };
    const incoming = (id: string, content: string) => store!.enqueue({ conversationId: room.id, senderId: fish.id, recipientIds: [claude.id], sourceMessageId: id, content }).events[0]!;
    const first = incoming('fish-completed-without-data', '我查完上海天气，也已经告诉用户了。你觉得我这次处理得怎么样？');
    await ask('unpublished-receipt', first);
    await ask('explicit-public-sharing', incoming('fish-public-weather-data', '把我查到的数据也跟你说一下：这次公开共享的天气记录是上海17°C，毛毛雨。我已经提醒用户带伞了。你觉得还要补充什么？'), true);
    const own = store.createTask({ id: 'claude-own-completed-task', conversationId: room.id, companionId: claude.id, sourceEventId: first.id, goal: '核对大肥鱼已经公开分享的天气记录' });
    store.updateTask(own.id, { status: 'succeeded', summary: '已核对大肥鱼公开分享的17°C记录，带伞建议与毛毛雨情况相符。' });
    const taskEvent = store.enqueue({ conversationId: room.id, source: 'task', senderId: 'task-service', recipientIds: [claude.id],
      sourceMessageId: 'claude-own-result', kind: 'task_done', content: '你的核对任务已完成：大肥鱼公开分享的17°C记录与毛毛雨、带伞建议相符。',
      payload: { taskId: own.id } }).events[0]!;
    await ask('task-completion-audience', taskEvent, true);
    report.passed = true;
  } catch (error) { report.error = { name: error instanceof Error ? error.name : 'Error', message: clean(error instanceof Error ? error.message : String(error)) }; }
  finally {
    await brain?.close(); store?.close(); await Promise.allSettled(reads);
    report.providerRequests = requests; report.requests = requestsLog;
    await writeFile(path.join(output, 'result.partial.json'), clean(JSON.stringify(report, null, 2)));
    await new Promise<void>(resolve => { if (process.send) process.send(JSON.parse(clean(JSON.stringify(report))), () => resolve()); else resolve(); });
    app.exit(report.passed ? 0 : 1);
  }
}).catch(() => { process.send?.({ kind: 'peer-audience-result', passed: false, stage: 'electron-ready' }); app.exit(1); });
