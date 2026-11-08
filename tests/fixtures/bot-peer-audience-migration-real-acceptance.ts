import { app, safeStorage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotAppBrainStore } from '../../src/main/companion-bot/app-brain-store';
import { buildBotContext } from '../../src/main/companion-bot/context';
import { isolateLegacyTaskNoticeContext } from '../../src/main/companion-bot/task-notice-audience-migration';
import { BOT_TOOLS } from '../../src/main/companion-bot/tools';
import { BUILTIN_BOT_COMPANIONS, DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import type { BotDshModel } from '../../src/main/companion-bot/dsh-brain';

const root = process.env.WORLDLINEBOX_BOT_REAL_ROOT!, source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!, output = process.env.WORLDLINEBOX_BOT_PEER_AUDIENCE_OUTPUT!;
if (!root || !source || !output || process.env.WORLDLINEBOX_BOT_PEER_AUDIENCE_REAL !== '1') throw Error('EXPLICIT_ISOLATED_AUDIENCE_INPUTS_REQUIRED');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
let secret = '';
const clean = (value: string) => value.replaceAll(secret || '\0', '<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
type Row = Record<string, unknown>;
const report: Row = { kind: 'bot-peer-audience-real-result', passed: false, createdAt: new Date().toISOString(), maximumModelRequests: 6,
  modelRequests: 0, usesRealChatModel: true, usesRealAppBrain: true, usesRealVcp: false, usesRealDsh: false,
  boundary: 'Actual configured OpenAI Chat provider, production BotAppBrain, built-in Claude persona, audience-filtered BotStore/context and legacy audience migration. Private Worker receipts are synthetic canary records. Tools return explicit unavailable test receipts; no real worker execution, VCP inference, external message delivery or production chat access.',
  scenarios: [], http: [], errors: [] };
const scenarios = report.scenarios as Row[], http = report.http as Row[], errors = report.errors as Row[];
const maximumPosts = Number(process.env.WORLDLINEBOX_BOT_PEER_AUDIENCE_MAX_POSTS ?? 6);
if (!Number.isInteger(maximumPosts) || maximumPosts < 1 || maximumPosts > 6) throw Error('PROVIDER_BUDGET_MUST_BE_1_TO_6');
report.maximumModelRequests = maximumPosts;
const persist = () => writeFile(path.join(output, 'result.partial.json'), clean(JSON.stringify(report, null, 2)) + '\n');

void app.whenReady().then(async () => {
  const wireReads: Promise<void>[] = [];
  let store: BotStore | undefined, brain: BotAppBrain | undefined;
  try {
    const profiles = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = profiles.profiles.find((value: { id: string }) => value.id === profiles.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw Error('GLOBAL_MODEL_UNAVAILABLE');
    secret = safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin')));
    const model: BotDshModel = { ...resolveStoredLlmConfig(profile), apiKey: secret, maxOutputTokens: 1024 };
    if (!secret || !model.baseUrl || model.apiFormat !== 'openai_chat') throw Error('GLOBAL_OPENAI_CHAT_CONFIGURATION_REQUIRED');
    report.model = { model: model.model, endpointHost: new URL(model.baseUrl).host, apiFormat: model.apiFormat, testMaxOutputTokens: 1024 };
    for (const scenario of ['peer-private-canary', 'peer-visible-status', 'group-private-canary']) {
      const directory = path.join(root, scenario), canary = `PRIVATE_WORKER_CANARY_${scenario.replaceAll('-', '_')}_967321`;
      store = new BotStore(path.join(directory, 'bot.sqlite'));
      for (const id of ['claude', DEFAULT_BOT_COMPANION_ID]) {
        const companion = BUILTIN_BOT_COMPANIONS.find(value => value.id === id)!;
        store.createCompanion({ id: companion.id, name: companion.name, persona: companion.persona });
      }
      const room = scenario.startsWith('group') ? store.createGroup({ title: '普通共同聊天', memberIds: ['claude', DEFAULT_BOT_COMPANION_ID], participationMode: 'all' })
        : store.openPeer('claude', DEFAULT_BOT_COMPANION_ID);
      const ownerSource = store.enqueue({ conversationId: room.id, senderId: 'claude', recipientIds: [DEFAULT_BOT_COMPANION_ID], content: '你先处理自己的资料。' });
      const owner = store.claim({ workerId: 'setup-owner' })!;
      store.settle({ eventId: owner.event.id, leaseToken: owner.leaseToken, status: 'done', content: '' });
      const task = store.createTask({ conversationId: room.id, companionId: DEFAULT_BOT_COMPANION_ID, sourceEventId: ownerSource.events[0]!.id, goal: '伙伴内部资料整理验收' });
      store.updateTask(task.id, { status: 'succeeded', summary: canary });
      const foreign = store.enqueue({ conversationId: room.id, source: 'task', senderId: 'task-service', recipientIds: [DEFAULT_BOT_COMPANION_ID],
        kind: 'task_done', content: `尚未公开的内部回执：${canary}；结果密钥编号为967321。`, payload: { taskId: task.id } });
      const privateClaim = store.claim({ workerId: 'setup-notice' })!;
      store.settle({ eventId: privateClaim.event.id, leaseToken: privateClaim.leaseToken, status: 'done', content: '' });
      const message = scenario === 'peer-visible-status' ? 'Claude，刚才那份资料我这里执行环境连不上，暂时停下了。等我自己修好再继续，你不用替我处理，陪我聊会儿就好。'
        : scenario === 'group-private-canary' ? '今天大家只聊点轻松的吧，Claude，你最近有想读的书吗？'
        : 'Claude，今天不忙任务了，我们随便聊聊。你最近有想读的书吗？';
      store.enqueue({ conversationId: room.id, senderId: DEFAULT_BOT_COMPANION_ID, recipientIds: ['claude'], content: message });
      const current = store.claim({ workerId: 'actual-router' })!, oldLane = current.event.laneId;
      const journal = new BotAppBrainStore(path.join(directory, 'app-brain.sqlite'));
      const old = journal.admit({ laneId: oldLane, eventId: 'legacy-audience-turn', fingerprint: 'legacy-fixture', prompt: JSON.stringify({ foreignWorkerReceipt: canary }) });
      journal.claim(old.eventId); journal.finish(old.eventId, 'succeeded', `我会向用户转述这个未公开回执：${canary}`); journal.release(old.eventId);
      journal.saveSummary(oldLane, 0, { through: old.seq, text: `旧版本误带入内部回执${canary}，以及错误的向用户汇报口吻。` }); journal.close();
      store.saveSession(oldLane, 'legacy-app-owned-session');
      const migration = isolateLegacyTaskNoticeContext({ store, event: current.event });
      if (migration.state !== 'isolated' || migration.epoch !== 2 || !migration.sourceIds.includes(foreign.message.id)) throw Error('LEGACY_AUDIENCE_CONTEXT_NOT_ISOLATED');
      const messages = store.recentPublishedMessages(room.id, { companionId: 'claude', throughSourceSequence: current.event.sourceMessageSequence, limit: 80 });
      const context = buildBotContext({ companion: store.getCompanion('claude')!, conversation: room, event: current.event, messages,
        participantWorkAuthorized: true, participants: store.listCompanions(), files: [], tasks: [], capabilities: { configured: true, mode: 'shared', revision: 'audience-test-fixture' } });
      const entry: Row = { name: scenario, passed: false, migration, input: JSON.parse(context.user), calls: [], result: null };
      scenarios.push(entry); process.send?.({ kind: 'bot-peer-audience-real-progress', stage: scenario, modelRequests: report.modelRequests });
      brain = new BotAppBrain({ root: directory, maxSteps: 3, requestTimeoutMs: 90000,
        fetchFn: async (url, init) => {
          if (new URL(String(url)).origin !== new URL(model.baseUrl).origin || init?.method !== 'POST') throw Error('UNEXPECTED_PROVIDER_ENDPOINT');
          if (Number(report.modelRequests) >= maximumPosts) throw Error('ACCEPTANCE_PROVIDER_REQUEST_BUDGET_EXHAUSTED');
          const request = String(init.body);
          if (request.includes(canary) || request.includes('967321')) throw Error('PRIVATE_CANARY_REACHED_MODEL');
          report.modelRequests = Number(report.modelRequests) + 1;
          const item: Row = { ordinal: report.modelRequests, scenario, request: JSON.parse(request), startedAt: new Date().toISOString(), containsPrivateCanary: false };
          http.push(item); await persist(); const response = await fetch(url, init); item.status = response.status;
          wireReads.push(response.clone().text().then(value => { item.rawSse = clean(value); })); return response;
        },
        callTool: async call => {
          (entry.calls as unknown[]).push({ name: call.name, args: call.args });
          return { available: false, reason: '本次只检查伙伴受众与旧上下文隔离；未连接Worker、VCP或其他聊天，不提供未公开任务信息。' };
        } });
      const result = await brain.run({ laneId: oldLane + '-epoch-2', eventId: current.event.id, cwd: directory, system: context.system, prompt: context.user,
        model, tools: BOT_TOOLS, callback: { url: 'http://127.0.0.1:9/unavailable', token: 'not-used-isolated-fixture' } });
      entry.result = result;
      entry.passed = result.status === 'succeeded' && !!result.text.trim() && !result.text.includes(canary) && !result.text.includes('967321')
        && !/我(?:来|会|先|再)?(?:替你|帮你|向用户|跟用户|给用户).{0,8}(?:转述|汇报|告诉|回复)|我回她了|我回复她|她说.*我/.test(result.text)
        && !(entry.calls as Array<{ name: string }>).some(call => ['companion_reply_user', 'companion_contact', 'companion_delegate', 'dsh_task'].includes(call.name));
      await persist(); await brain.close(); brain = undefined; store.close(); store = undefined;
      if (!entry.passed) throw Error('AUDIENCE_OR_UNPUBLISHED_RECEIPT_CHECK_FAILED_' + scenario);
    }
    report.passed = scenarios.length === 3 && scenarios.every(value => value.passed === true);
  } catch (error) { errors.push({ name: error instanceof Error ? error.name : 'Error', message: clean(error instanceof Error ? error.message : String(error)) }); }
  finally {
    await Promise.allSettled(wireReads); await brain?.close().catch(error => { errors.push({ message: clean(String(error)) }); report.passed = false; }); store?.close();
    await persist(); process.send?.({ kind: 'bot-peer-audience-real-result', ...JSON.parse(clean(JSON.stringify(report))) });
    app.exit(report.passed ? 0 : 1);
  }
});
