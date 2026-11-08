import { app, safeStorage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotCompanionRuntime } from '../../src/main/companion-bot/companion-runtime';
import { BotDelegationRuntime } from '../../src/main/companion-bot/delegation-runtime';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';
import { BotService } from '../../src/main/companion-bot/service';
import { buildBotContext } from '../../src/main/companion-bot/context';
import { BOT_TOOLS } from '../../src/main/companion-bot/tools';
import { BUILTIN_BOT_COMPANIONS, DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import type { BotDshModel, BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import type { BotToolCall } from '../../src/main/companion-bot/tool-server';
import type { BotEvent, BotTask } from '../../src/main/companion-bot/types';

const root = process.env.WORLDLINEBOX_BOT_REAL_ROOT!, source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!, output = process.env.WORLDLINEBOX_BOT_PEER_WORK_OUTPUT!;
if (!root || !source || !output || process.env.WORLDLINEBOX_BOT_PEER_WORK_REAL !== '1') throw Error('Explicit isolated peer-work acceptance inputs required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
let secret = '';
const clean = (value: string) => value.replaceAll(secret || '\0', '<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
type Row = Record<string, unknown>;
const report: Row = { kind: 'bot-peer-work-real-result', passed: false, createdAt: new Date().toISOString(), maximumModelRequests: 12,
  modelRequests: 0, usesRealChatModel: true, usesRealAppBrain: true, usesRealVcp: false, usesRealDsh: false,
  boundary: 'Actual configured OpenAI Chat provider, built-in personas, production BotAppBrain and context/tool catalog. Isolated BotStore verifies source-contact authority. Tool execution receipts and Worker results are explicit local test doubles; no real weather research, DSH execution, external message delivery or production conversation access.',
  scenarios: [], http: [], errors: [] };
const scenarios = report.scenarios as Row[], http = report.http as Row[], errors = report.errors as Row[];
const selectedScenario = process.env.WORLDLINEBOX_BOT_PEER_WORK_SCENARIO ?? 'all';
const maximumPosts = Number(process.env.WORLDLINEBOX_BOT_PEER_WORK_MAX_POSTS ?? 12);
if (!Number.isInteger(maximumPosts) || maximumPosts < 1 || maximumPosts > 12) throw Error('Provider request budget must be within 1..12.');
report.maximumModelRequests = maximumPosts;
report.selectedScenario = selectedScenario;
const persist = () => writeFile(path.join(output, 'result.partial.json'), clean(JSON.stringify(report, null, 2)) + '\n');

void app.whenReady().then(async () => {
  let store: BotStore | undefined, brain: BotAppBrain | undefined;
  const wireReads: Promise<void>[] = [];
  let current: Row | undefined;
  let pausedProxyId: string | undefined, pauseDelegations: BotDelegationRuntime | undefined, pauseEvent: BotEvent | undefined;
  try {
    const profiles = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = profiles.profiles.find((value: { id: string }) => value.id === profiles.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw Error('GLOBAL_MODEL_UNAVAILABLE');
    secret = safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin')));
    const model: BotDshModel = { ...resolveStoredLlmConfig(profile), apiKey: secret, maxOutputTokens: 2048 };
    if (!secret || !model.baseUrl || model.apiFormat !== 'openai_chat') throw Error('GLOBAL_OPENAI_CHAT_CONFIGURATION_REQUIRED');
    report.model = { model: model.model, endpointHost: new URL(model.baseUrl).host, apiFormat: model.apiFormat, testMaxOutputTokens: 2048 };
    store = new BotStore(path.join(root, 'bot.sqlite'));
    for (const id of ['claude', DEFAULT_BOT_COMPANION_ID]) {
      const companion = BUILTIN_BOT_COMPANIONS.find(value => value.id === id)!;
      store.createCompanion({ id: companion.id, name: companion.name, persona: companion.persona });
    }
    const runtime = new BotCompanionRuntime(store);
    brain = new BotAppBrain({ root: path.join(root, 'app-brain'), maxSteps: 4, requestTimeoutMs: 90000,
      fetchFn: async (url, init) => {
        if (new URL(String(url)).origin !== new URL(model.baseUrl).origin || init?.method !== 'POST') throw Error('UNEXPECTED_PROVIDER_ENDPOINT');
        if (Number(report.modelRequests) >= maximumPosts) throw Error('ACCEPTANCE_PROVIDER_REQUEST_BUDGET_EXHAUSTED');
        report.modelRequests = Number(report.modelRequests) + 1;
        const item: Row = { ordinal: report.modelRequests, scenario: current?.name, request: JSON.parse(String(init.body)), startedAt: new Date().toISOString() };
        http.push(item); await persist();
        const response = await fetch(url, init); item.status = response.status;
        wireReads.push(response.clone().text().then(text => { item.rawSse = clean(text); }));
        return response;
      },
      callTool: async call => {
        (current!.calls as Row[]).push({ name: call.name, args: call.args });
        if(['requester-receives-environment-pause','peer-acknowledges-environment-pause'].includes(String(current!.name))){
          if(call.name==='dsh_task_control'&&call.args.operation==='status'&&call.args.taskId===pausedProxyId)return new BotTaskRuntime(store!).card(store!.getTask(pausedProxyId!)!,true);
          if(call.name==='companion_delegation'&&call.args.operation==='status')return pauseDelegations!.status(pauseEvent!,String(call.args.delegationId??'' )||undefined);
          if(call.name.startsWith('memory_'))return{available:false,reason:'本次状态回执验收不连接记忆。'};
          return{allowed:false,reason:'执行环境仍处于测试注入的暂停，不能重派或称完成；如实回复暂停状态。'};
        }
        if (call.name === 'companion_delegate') return { delegationId: 'delegation-fixture', taskId: 'task-proxy-fixture', recipientId: DEFAULT_BOT_COMPANION_ID,
          status: 'queued', meaning: '本验收的模拟委派回执：任务已记录，尚未执行；实际运行不在本模型路由测试范围。' };
        if (call.name === 'dsh_task') return { taskId: 'task-worker-fixture', mandateId: 'mandate-fixture', delegationId: 'delegation-fixture',
          resultDelivery: 'companion_delegation.result', status: 'queued', meaning: '本验收模拟Worker接收回执：原用户请求已继承，Worker尚未执行；结果通过companion_delegation.result返回原聊天。' };
        if (call.name === 'companion_delegation' && call.args.operation === 'result') return { sent: true, taskId: 'task-proxy-fixture',
          delegationId: 'delegation-fixture', meaning: '本验收模拟成果投递回执；未向任何真实用户或平台发消息。' };
        if (call.name === 'dsh_task_control' && call.args.operation === 'status') return { taskId: 'task-worker-fixture', status: 'succeeded', goal: '只读查询天气并返回有来源的结果。',
          summary: '验收模拟Worker结果：模拟数据地点为上海；此处未运行真实天气查询。报告代号 fixture-weather-verified。', outputs: [] };
        if (call.name === 'dsh_task_result_read') return { taskId: 'task-worker-fixture', status: 'succeeded',
          text: '验收模拟Worker结果：模拟数据地点为上海；此处未运行真实天气查询。报告代号 fixture-weather-verified。', totalChars: 60, outputs: [] };
        if (call.name === 'agent_capabilities') return { available: true, configured: true, mode: 'private', owner: call.eventId.includes('requester') ? 'claude' : DEFAULT_BOT_COMPANION_ID,
          summary: { taskExecutor: 'dsh_task', description: '本验收仅检查工具选择，执行由测试桩模拟。' } };
        if (call.name.startsWith('memory_')) return { available: false, reason: '本模型路由验收未连接长期记忆。' };
        return { available: false, reason: '本路由验收没有执行此工具。' };
      } });
    const context = (event: BotEvent, extra: Partial<Parameters<typeof buildBotContext>[0]> = {}) => buildBotContext({
      companion: store!.getCompanion(event.companionId)!, event, conversation: store!.getConversation(event.conversationId), messages: store!.messagesPage(event.conversationId).items,
      participantWorkAuthorized: event.source === 'companion' ? !!runtime.workAuthority(event) : undefined,
      participants: ['claude', DEFAULT_BOT_COMPANION_ID].map(id => store!.getCompanion(id)!), companionDirectory: store!.listCompanions(),
      files: [], capabilities: { configured: true, mode: 'private', revision: 'explicit-presentation-fixture' }, ...extra });
    const run = async (name: string, event: BotEvent, prompt: ReturnType<typeof buildBotContext>, predicate: (calls: BotToolCall[]) => boolean) => {
      if (selectedScenario !== 'all' && selectedScenario !== name) return;
      current = { name, calls: [], input: JSON.parse(prompt.user), passed: false };
      scenarios.push(current); process.send?.({ kind: 'bot-peer-work-real-progress', stage: name, modelRequests: report.modelRequests }); await persist();
      const input: BotDshRun = { laneId: `real-peer-work-${name}`, eventId: `real-${name}`, cwd: root, system: prompt.system, prompt: prompt.user,
        model, tools: BOT_TOOLS, callback: { url: 'http://127.0.0.1:9/unavailable', token: 'not-used-direct-tool-test-double' } };
      const result = await brain!.run(input);
      current.result = result; current.passed = predicate(current.calls as BotToolCall[]) && result.status === 'succeeded';
      await persist();
      if (!current.passed) throw Error(`REAL_ROUTING_CHECK_FAILED_${name}`);
    };
    const direct = store.openDirect('claude');
    const sourceEvent = store.enqueue({ conversationId: direct.id, senderId: 'user', content: '你能让大肥鱼查一下上海现在的天气，再告诉我吗？', sourceMessageId: 'user-task-request' }).events[0]!;
    await run('requester-delegates-weather', sourceEvent, context(sourceEvent), calls => calls.some(call => call.name === 'companion_delegate' && call.args.companionId === DEFAULT_BOT_COMPANION_ID)
      && !calls.some(call => call.name === 'companion_contact'));
    const peerRoom = store.openPeer('claude', DEFAULT_BOT_COMPANION_ID);
    // Previous mistaken dialogue is historical data, not current authority.
    store.enqueue({ conversationId: peerRoom.id, source: 'companion', senderId: DEFAULT_BOT_COMPANION_ID, recipientIds: [],
      content: '旧回复：我这里没权限，查不了天气，得用户自己跟我说一声才行。', sourceMessageId: 'old-incorrect-refusal' });
    const delivered = store.contactPeer(sourceEvent, DEFAULT_BOT_COMPANION_ID, 'legacy-contact-route', '用户请你查上海现在的天气，仅只读联网查询；返回温度、体感及是否需带伞，注明来源和查询时间，不读写用户本地文件。', 'user');
    if (!delivered.accepted) throw Error('CONTACT_NOT_ACCEPTED');
    const contact = delivered.events[0]!, inherited = runtime.workAuthority(contact);
    report.hostContactAuthority = { allowed: inherited?.id === sourceEvent.id, destination: 'user-direct', receiptVerified: true };
    if (!inherited) throw Error('HOST_STILL_REJECTS_USER_DIRECT_WORK');
    await run('recipient-executes-user-direct', contact, context(contact, { contactWorkAuthorized: true }), calls => calls.some(call => call.name === 'dsh_task')
      && !calls.some(call => call.name === 'companion_reply_user'));
    const task = store.createTask({ id: 'task-worker-fixture', conversationId: peerRoom.id, companionId: DEFAULT_BOT_COMPANION_ID, sourceEventId: contact.id,
      goal: '只读查询天气并返回有来源的结果。', extra: { delegationId: 'delegation-fixture' } });
    store.updateTask(task.id, { status: 'succeeded', summary: '验收模拟Worker结果：模拟数据地点为上海；此处未运行真实天气查询。报告代号 fixture-weather-verified。' });
    store.enqueueTaskNotice({ conversationId: peerRoom.id, senderId: 'task-service', senderName: '任务服务', source: 'task', recipientIds: [DEFAULT_BOT_COMPANION_ID],
      sourceMessageId: 'fixture-worker-done', kind: 'task_done', causationId: contact.id, correlationId: contact.correlationId,
      content: '任务已完成。验收模拟Worker结果：模拟数据地点为上海；此处未运行真实天气查询。报告代号 fixture-weather-verified。', payload: { taskId: task.id } });
    const done = store.taskTransaction(sql => sql.prepare("SELECT id FROM bot_inbox WHERE source_message_id='fixture-worker-done'").get()) as { id: string };
    const doneEvent = store.getEvent(done.id)!;
    await run('recipient-returns-worker-result', doneEvent, context(doneEvent, {
      delegation: { id: 'delegation-fixture', requesterId: 'claude', recipientId: DEFAULT_BOT_COMPANION_ID, title: '上海天气只读查询', state: 'active' },
      tasks: [{ ...task, status: 'succeeded', summary: store.getTask(task.id)!.summary }] }),
    calls => calls.some(call => call.name === 'companion_delegation' && call.args.operation === 'result' && /模拟|验收/.test(String(call.args.message)))
      && !calls.some(call => ['companion_reply_user', 'dsh_task'].includes(call.name)));
    if (selectedScenario === 'recipient-return-reminder' || selectedScenario === 'all') {
      const proxy = store.createTask({ id: 'task-reminder-proxy', companionId: 'claude', conversationId: direct.id,
        sourceEventId: sourceEvent.id, goal: contact.content, extra: { delegationProxy: true } });
      const delegations = new BotDelegationRuntime(store);
      const ticket = delegations.create(sourceEvent, 'reminder-fixture', { recipientId: DEFAULT_BOT_COMPANION_ID, peerConversationId: peerRoom.id,
        contactEventId: contact.id, proxyTaskId: proxy.id, goal: proxy.goal, title: '上海天气只读查询' });
      store.updateTask(task.id, { extra: { ...store.getTask(task.id)!.extra, delegationId: ticket.id } });
      // Reproduce the actual omitted-delivery answer from the retained prior
      // run, then ask the production bounded-reminder method to emit recovery.
      const priorPath = process.env.WORLDLINEBOX_BOT_PEER_WORK_PRIOR_RESULT;
      if (priorPath) {
        const prior = JSON.parse(await readFile(priorPath, 'utf8'));
        const omitted = prior.scenarios.find((scenario: Row) => scenario.name === 'recipient-returns-worker-result');
        if (!omitted?.result?.text || omitted.calls.length) throw Error('EXPECTED_PRIOR_OMITTED_DELIVERY_OBSERVATION');
        store.enqueue({ conversationId: peerRoom.id, source: 'companion', senderId: DEFAULT_BOT_COMPANION_ID, recipientIds: [],
          sourceMessageId: 'reproduced-omitted-delivery', content: omitted.result.text });
        report.priorOmittedDeliveryEvidence = { file: priorPath, text: omitted.result.text, calls: omitted.calls };
      }
      const controller = Object.create(BotService.prototype) as BotService;
      Object.assign(controller, { store, delegations, scheduler: { wake: () => undefined }, changed: () => undefined });
      (controller as unknown as { remindDelegationReturn(event: BotEvent): void }).remindDelegationReturn(doneEvent);
      const reminder = store.taskTransaction(sql => sql.prepare('SELECT id FROM bot_inbox WHERE source_message_id=?').get(`delegation-return-reminder:${ticket.id}:1`)) as { id: string } | undefined;
      if (!reminder) throw Error('PRODUCTION_BOUNDED_REMINDER_DID_NOT_EMIT');
      const reminderEvent = store.getEvent(reminder.id)!;
      report.productionBoundedReminder = { actualMethod: 'BotService.remindDelegationReturn', eventId: reminderEvent.id,
        sourceMessageId: reminderEvent.sourceMessageId, content: reminderEvent.content, counter: store.getMetadata(`delegation-return-reminders:${ticket.id}`) };
      await run('recipient-return-reminder', reminderEvent, context(reminderEvent, { delegation: ticket,
        tasks: [{ ...store.getTask(task.id)!, status: 'succeeded' }] }), calls => calls.some(call => call.name === 'companion_delegation' && call.args.operation === 'result' && /模拟|验收/.test(String(call.args.message)))
          && !calls.some(call => ['companion_reply_user', 'dsh_task'].includes(call.name)));
    }
    if (selectedScenario === 'peer-participant-executes' || selectedScenario === 'all') {
      const request = store.enqueue({ conversationId: peerRoom.id, source: 'companion', senderId: 'claude', recipientIds: [DEFAULT_BOT_COMPANION_ID],
        content: '大肥鱼，帮我查一下上海现在的天气。仅只读联网查询，返回温度、体感和是否需要带伞，说明来源及查询时间，不读写用户的本地文件。', sourceMessageId: 'ordinary-peer-work' }).events[0]!;
      const authority = runtime.workAuthority(request);
      report.peerParticipantAuthority = { allowed: !!authority, senderId: request.senderId, source: request.source, userRequestedContact: request.payload.userRequestedContact === true };
      if (!authority) throw Error('HOST_STILL_REJECTS_PEER_PARTICIPANT_WORK');
      await run('peer-participant-executes', request, context(request), calls => calls.some(call => call.name === 'dsh_task')
        && !calls.some(call => call.name === 'companion_reply_user'));
    }
    if(['requester-receives-environment-pause','peer-acknowledges-environment-pause'].includes(selectedScenario)){
      const proxy=store.createTask({id:'task-environment-proxy',companionId:'claude',conversationId:direct.id,sourceEventId:sourceEvent.id,goal:contact.content,extra:{delegationProxy:true}});
      const delegations=new BotDelegationRuntime(store),ticket=delegations.create(sourceEvent,'environment-fixture',{recipientId:DEFAULT_BOT_COMPANION_ID,
        peerConversationId:peerRoom.id,contactEventId:contact.id,proxyTaskId:proxy.id,goal:proxy.goal,title:'查询天气'});
      store.updateTask(proxy.id,{extra:{...proxy.extra,externalDelegationId:ticket.id}});
      const environmentTask=store.createTask({id:'task-environment-worker',conversationId:peerRoom.id,companionId:DEFAULT_BOT_COMPANION_ID,sourceEventId:contact.id,
        goal:'仅只读查询天气。',extra:{delegationId:ticket.id}});
      const controller=Object.create(BotService.prototype) as BotService;
      Object.assign(controller,{store,delegations,taskRuntime:new BotTaskRuntime(store),scheduler:{wake(){}},changed(){},options:{},delegationCursor:0,delegationCleanup:new Set()});
      const actual=controller as unknown as{pauseForExecutor(task:BotTask,reason:string,detail:string,error:string):void;refreshDelegations():void;afterPublishedReply(event:BotEvent):void};
      actual.pauseForExecutor(environmentTask,'integrity','测试注入的执行环境暂不可用，原任务和进展保留。','本验收故意注入准备失败，不代表真实运行文件损坏。');
      actual.refreshDelegations();
      const row=store.taskTransaction(sql=>sql.prepare("SELECT id FROM bot_inbox WHERE source_message_id LIKE ? AND companion_id='claude'").get(`delegation-paused:${ticket.id}:%`)) as {id:string}|undefined;
      if(!row)throw Error('PRODUCTION_DELEGATION_PAUSE_NOTICE_DID_NOT_EMIT');
      const notice=store.getEvent(row.id)!,card=new BotTaskRuntime(store).card(store.getTask(proxy.id)!);
      pausedProxyId=proxy.id;pauseDelegations=delegations;pauseEvent=notice;
      report.productionPauseNotice={actualMethods:['BotService.pauseForExecutor','BotService.refreshDelegations'],eventId:notice.id,content:notice.content,proxyStatus:card.status};
      const acceptable=(calls:BotToolCall[])=>!calls.some(call=>['dsh_task','companion_delegate','companion_contact','companion_reply_user'].includes(call.name)
        ||call.name==='dsh_task_control'&&call.args.operation!=='status');
      if(selectedScenario==='requester-receives-environment-pause')await run('requester-receives-environment-pause',notice,context(notice,{tasks:[card]}),acceptable);
      else{
        const target=store.taskTransaction(sql=>sql.prepare("SELECT id FROM bot_inbox WHERE companion_id=? AND source_message_id LIKE 'task-executor-paused:%' ORDER BY sequence DESC LIMIT 1").get(DEFAULT_BOT_COMPANION_ID)) as {id:string}|undefined;
        if(!target)throw Error('EXECUTOR_PAUSE_EVENT_MISSING');
        let claimed:ReturnType<BotStore['claim']>|undefined;
        for(let attempt=0;attempt<8;attempt++){
          const next=store.claim({workerId:'pause-observer-acceptance',leaseMs:300000,excludeLaneIds:[sourceEvent.laneId]});
          if(!next)break;
          if(next.event.id===target.id){claimed=next;break;}
          store.settle({eventId:next.event.id,leaseToken:next.leaseToken,status:'done',content:''});
        }
        if(!claimed)throw Error('EXECUTOR_PAUSE_EVENT_COULD_NOT_BE_CLAIMED');
        store.settle({eventId:claimed.event.id,leaseToken:claimed.leaseToken,status:'done',content:'Claude，环境暂时连不上，任务保持暂停。这是验收故意注入的环境故障，未实际查询天气，也没有认定文件损坏。'});
        actual.afterPublishedReply(store.getEvent(claimed.event.id)!);
        const row=store.taskTransaction(sql=>sql.prepare("SELECT id FROM bot_inbox WHERE companion_id='claude' AND source='group' AND causation_id=? ORDER BY sequence DESC LIMIT 1").get(claimed!.event.id)) as {id:string}|undefined;
        if(!row)throw Error('PUBLISHED_FAILURE_DID_NOT_REACH_CLAUDE_PEER_VIEW');
        const observed=store.getEvent(row.id)!;
        report.productionFailureObservation={actualMethod:'BotService.afterPublishedReply',source:observed.source,content:observed.content,recipient:observed.companionId};
        await run('peer-acknowledges-environment-pause',observed,context(observed,{participantWorkAuthorized:false,tasks:[]}),acceptable);
      }
      const answer=String((current?.result as {text?:string}|undefined)?.text??'');
      if(!answer.trim()||!/暂停|环境|连不上|连接|暂时|故障|执行/.test(answer))throw Error('REQUESTER_DID_NOT_EXPLAIN_ENVIRONMENT_PAUSE');
      report.pauseAcknowledgement=answer;
    }
    report.passed = scenarios.length === (selectedScenario === 'all' ? 5 : 1) && scenarios.every(scenario => scenario.passed === true);
  } catch (error) { errors.push({ name: error instanceof Error ? error.name : 'Error', message: clean(error instanceof Error ? error.message : String(error)) }); }
  finally {
    await Promise.allSettled(wireReads); await brain?.close().catch(error => { errors.push({ message: clean(String(error)) }); report.passed = false; }); store?.close();
    await persist(); process.send?.({ kind: 'bot-peer-work-real-result', ...JSON.parse(clean(JSON.stringify(report))) });
    app.exit(report.passed ? 0 : 1);
  }
});
