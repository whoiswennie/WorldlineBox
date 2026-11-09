import http from 'node:http';
import process from 'node:process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { botProjectDirectory, prepareBotWorkspace, attachBotWorkspace as registerBotWorkspace } from './workspace.js';
import { inspectNativeIdle } from './idle.js';
import { registerWorkspaceSessions } from './sessions.js';

export const name = 'worldlinebox-bridge';
export const inject = ['loader', 'sessionController', 'workspaceRegistry', 'agents', 'sessions', 'tools', 'agentPresets', 'llm'];
const protocol = 'worldlinebox-native-web-host-v1';
// This resource is distributed independently; keep the default template aligned
// with src/shared/model-budget.ts without importing application-only modules.
const defaultContextWindow = 100000, maxContextChars = 100000;
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const scopedWorkerTools = ['read', 'read_image', 'write', 'edit', 'present', 'working_directory', 'web_search', 'web_fetch', 'ask_user_question'];
/** One coherent observation per native model attempt. Frames are transport
 * fragments, not Agent Loop phases; publish cumulative snapshots at a UI rate. */
export function observeAssistantStream(record, nativeSessionId, frame, publish, now = Date.now()) {
  record.streams ??= new Map();
  if (frame.type === 'start') {
    record.streams.set(nativeSessionId, { id: randomUUID(), attemptId: frame.attemptId, nativeTurn: frame.turn, nativeStep: frame.step,
      text: '', reasoning: '', lastTextPublish: -Infinity, lastReasoningPublish: -Infinity });
    return;
  }
  const stream = record.streams.get(nativeSessionId);
  if (!stream || frame.attemptId !== undefined && stream.attemptId !== frame.attemptId) return;
  const identity = { streamId: stream.id, nativeSessionId, nativeTurn: stream.nativeTurn, nativeStep: stream.nativeStep };
  const reasoning = outputState => publish({ ...identity, type: 'reasoning', stage: 'message', text: stream.reasoning,
    textMode: 'snapshot', outputState, summary: outputState === 'draft' ? '正在思考' : '思考' });
  if (frame.type === 'chunk' && frame.chunk.type === 'reasoning-delta') {
    stream.reasoning += frame.chunk.text;
    if (now - stream.lastReasoningPublish >= 100) { stream.lastReasoningPublish = now; reasoning('draft'); }
  } else if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
    stream.text += frame.chunk.text;
    if (now - stream.lastTextPublish >= 100) {
      stream.lastTextPublish = now; publish({ ...identity, type: nativeSessionId === record.id ? 'text_stream' : 'child_text_stream',
        text: stream.text, textMode: 'snapshot', outputState: 'draft' });
    }
  } else if (frame.type === 'end' && stream.reasoning) {
    reasoning(frame.outcome?.kind === 'committed' && frame.outcome.eventType === 'assistant/message' ? 'committed' : 'abandoned');
  }
}
/** Preserve every committed user-facing message and native delivery in order.
 * Reasoning and tool payloads stay in the trace, independent of answer position. */
export function workerOutputFromEvents(events, { eventId, startMessageId, maxChars = 128000 }) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 256 || maxChars > 131072) throw new Error('Invalid worker output preview budget.');
  const messageId = startMessageId ?? 'worldlinebox-bot:' + eventId;
  const start = events.findIndex(event => event.type === 'user/message' && event.data.id === messageId);
  if (start < 0) return { text: '', totalChars: 0, truncated: false, messages: 0,outputs:[] };
  const outputs=[];let messages=0;
  for (const event of events.slice(start + 1)) {
    if (event.type === 'user/message' && (event.data.source?.kind === 'worldlinebox-bot'
      || startMessageId && ['worldlinebox-bot-task-continuation', 'worldlinebox-bot-guidance'].includes(event.data.source?.kind))) break;
    if (event.type === 'assistant/message' && event.data.interrupted !== true
      && (event.surfaceOp === undefined || event.surfaceOp === 'append')) {
      const body = textOf(event.data.message);
      if (body.trim()) { outputs.push({id:'native-text-'+event.seq,sequence:event.seq,text:body}); messages++; }
    }
    if(event.type==='deliverables/presented')outputs.push({id:'native-files-'+event.seq,sequence:event.seq,files:event.data.files});
  }
  const text=outputs.filter(part=>part.text).map(part=>part.text).join('\n\n');
  return { text, totalChars: text.length, truncated: false, messages,outputs };
}
/** Public DSH meter projections only: no prompts, tools or credentials. */
export function nativeContextSample(sessionId,result,now=new Date().toISOString()){
  const values=result?.values??{},pick=(value,keys)=>{
    if(!value||typeof value!=='object')return;
    return Object.fromEntries(keys.filter(key=>Number.isSafeInteger(value[key])&&value[key]>=0).map(key=>[key,value[key]]));
  };
  const pressure=pick(values.contextPressure,['pressureTokens','projectedTokens','contextWindow']);if(pressure?.contextWindow===0)delete pressure.contextWindow;
  const breakdown=pick(values.contextBreakdown,['systemTokens','toolsTokens','messageTokens']),usage=pick(values.tokenUsage,['uncachedInputTokens','outputTokens','cacheReadTokens','cacheWriteTokens']);
  return{source:'dsh-native-projections',sessionId,state:result?.kind==='unsupported'?'unsupported':!result?'empty':result.kind==='migration-required'?'migration-required':'ready',sampledAt:now,
    ...(Number.isSafeInteger(result?.asOfSeq)?{asOfSeq:result.asOfSeq}:{}),...(pressure?{pressure}:{}),
    ...(breakdown&&Object.keys(breakdown).length===3?{breakdown}:{}),...(usage&&Object.keys(usage).length===4?{usage}:{})};
}
/** Reference data is selected from actual native registrations, never from
 * installed-package counts. Schemas are disclosed only by the detail query. */
export function capabilityCatalogPage(tools, skills, query) {
  const category = query.category ?? 'all', offset = query.offset ?? 0, limit = query.limit ?? 20;
  if (!['tool', 'skill', 'all'].includes(category) || typeof (query.query ?? '') !== 'string' || (query.query?.length ?? 0) > 200
    || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw new Error('Invalid capability catalog page.');
  const search = (query.query ?? '').trim().toLocaleLowerCase();
  const entries = [...(category === 'skill' ? [] : tools.map(tool => ({ kind: 'tool', name: tool.name, description: String(tool.description ?? '').slice(0, 2000) }))),
    ...(category === 'tool' ? [] : skills.map(skill => ({ kind: 'skill', name: skill.name, description: String(skill.description ?? '').slice(0, 2000) })))];
  const selected = entries.filter(entry => !search || (entry.name + ' ' + entry.description).toLocaleLowerCase().includes(search))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return { kind: 'catalog', category, ...(query.query ? { query: query.query } : {}), offset, limit, total: selected.length,
    items: selected.slice(offset, offset + limit), ...(offset + limit < selected.length ? { nextOffset: offset + limit } : {}),
    source: 'native-agent-scope', trust: 'capability_reference_data' };
}
const setWorkerAccess = (agent, full) => {
  if (full) {
    // Select the official per-Session bundle (sandbox + approval), never its
    // process/user default. A sandbox event alone leaves the old ask policy.
    const presets = agent.ctx.get('permissionPresets');
    if (presets) presets.set(agent.session, 'danger-full-access');
    else {
      agent.session.append('sandbox/mode', { mode: 'danger-full-access' });
      agent.session.append('approval/policy', { policy: 'never' });
    }
  } else agent.session.append('sandbox/mode', { mode: 'workspace-write' });
};
const botTerminalError = record => record.lastError || (record.reason?.kind === 'max-tokens'
  ? '执行器已达到本任务的连续输出预算，已保留当前进展；任务尚未完成。'
  : record.reason?.kind === 'error' ? String(record.reason.error?.message || '执行器模型请求失败。')
    : 'Native companion turn failed.');

/** The maintained DSH pi-ai adapter owns wire serialization, streaming,
 * native tool history, replay metadata and cancellation. Secrets stay in the
 * profile snapshot closure, never Session events or plugin configuration. */
export async function createBotProvider(ctx) {
  const [{ PiAiAdapter }, { openAICompletionsApi }, { resolveImageAttachmentAccess }] = await Promise.all([
    import('@deepseek-ai/dsh-llm-pi-ai'), import('@earendil-works/pi-ai/api/openai-completions.lazy'), import('@deepseek-ai/dsh-llm'),
  ]);
  let profiles = new Map(), registration;
  const secrets = new WeakMap();
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async (_provider, profile) => secrets.get(profile),
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    auth: { credentials: { read: async () => undefined, list: async () => [],
      modify: async () => { throw new Error('Companion model credentials are managed by WorldlineBox.'); }, delete: async () => {} },
    authContext: { env: async () => undefined, fileExists: async () => false } },
  });
  return {
    configure(model) {
      if (!model || model.apiFormat !== 'openai_chat') throw new Error('Companion DSH model currently requires openai_chat; select an OpenAI-compatible endpoint.');
      if (typeof model.model !== 'string' || !model.model.trim() || typeof model.baseUrl !== 'string'
        || !['http:', 'https:'].includes(new URL(model.baseUrl).protocol) || typeof model.apiKey !== 'string' || !model.apiKey.trim()) throw new Error('Companion model endpoint or credential is unavailable.');
      const capacity = model.contextWindow ?? defaultContextWindow, output = model.maxTokens ?? Math.min(model.maxOutputTokens ?? 16384, 16384, Math.floor(capacity / 4));
      if (!Number.isSafeInteger(capacity) || capacity < 8192 || !Number.isSafeInteger(output) || output < 1 || output >= capacity) throw new Error('Invalid companion model budget.');
      if (model.maxOutputTokens !== undefined && (!Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < output)) throw new Error('Companion output exceeds the verified provider limit.');
      const baseUrl = model.baseUrl.replace(/\/+$/, '');
      const provider = 'worldlinebox-bot-' + createHash('sha256').update(JSON.stringify([baseUrl, model.model, capacity, output])).digest('hex').slice(0, 20);
      const api = openAICompletionsApi();
      // Unknown OpenAI-compatible routes must be allowed to attempt native
      // image input; the provider, not a model-name table, decides support.
      // An explicit negative or discovered text-only declaration stays text-only.
      const imageInput = model.imageSupport !== 'unsupported' && (!Array.isArray(model.inputModalities) || model.inputModalities.includes('image'));
      const descriptor = { id: model.model, name: model.model, provider, api: 'openai-completions', baseUrl,
        reasoning: false, input: imageInput ? ['text', 'image'] : ['text'], contextWindow: capacity, maxTokens: output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' } };
      const piProvider = { id: provider, name: 'WorldlineBox companion', baseUrl,
        auth: { apiKey: { name: 'WorldlineBox', resolve: async ({ credential }) => ({ auth: credential?.key ? { apiKey: credential.key } : {}, source: 'WorldlineBox' }) } },
        getModels: () => [descriptor], stream: (m, c, o) => api.stream(m, c, o), streamSimple: (m, c, o) => api.streamSimple(m, c, o) };
      const profile = { provider, displayName: 'WorldlineBox companion', piProvider,
        modelErrors: new Map(), configuredMaxTokens: new Map([[model.model, output]]),
        streamIdleTimeoutMs: 120000, maxRequestImageBytes: 1024 * 1024, requestImagePixelBudget: 1048576, requestImageMaxBytes: 524288,
        retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: ['NETWORK', 'TIMEOUT', 'RATE_LIMIT'], initialDelayMs: 500, maxDelayMs: 3000, jitterRatio: 0.1 } };
      secrets.set(profile, model.apiKey);
      profiles = new Map(profiles).set(provider, profile);
      if (!registration) registration = ctx.llm.registerAdapter([...profiles.keys()], adapter);
      else registration.replace([...profiles.keys()]);
      return { provider, model: model.model };
    },
    close() { registration?.(); profiles = new Map(); },
  };
}

const botReceiptPath = (record, eventId) => path.join(record.cwd, '.worldlinebox-brain', createHash('sha256').update(eventId).digest('hex') + '.json');
/** Idempotent steering shares the native inbox/log admission semantics. A
 * prepared receipt must be reconciled before a finished task can reject it. */
export async function deliverBotGuidance(record,input,{read,write,flush,freezeMessage}){
  const key=input.eventId+':guidance:'+input.messageId,prior=await read(key);
  const fingerprint=createHash('sha256').update(input.text).digest('hex');
  if(prior?.fingerprint&&prior.fingerprint!==fingerprint)throw Error('Task guidance ID has different content.');
  if(prior?.mode&&prior.mode!==input.mode)throw Error('Task guidance ID has different delivery mode.');
  if(prior?.status==='accepted')return {accepted:true};
  const id='worldlinebox-bot:'+key;
  const already=prior&&(record.agent.session.snapshotEvents().some(event=>event.type==='user/message'&&event.data.id===id)
    ||[...record.agent.inbox.nextTurn,...record.agent.inbox.nextStep].some(message=>message.id===id));
  if(!already){
    if(record.bot.eventId!==input.eventId||record.status!=='running')return {accepted:false};
    const message=freezeMessage({id,role:'user',content:[{type:'text',text:input.text}],source:{kind:'worldlinebox-bot-guidance',form:'relay',...(record.bot.audience?{worldlineboxAudience:record.bot.audience}:{})}});
    await write({eventId:key,sessionId:record.id,status:'prepared',fingerprint,mode:input.mode,messageId:id});
    if(input.mode==='steer')record.agent.steer(message);else record.agent.followup(message);
    record.revision++;
  }
  await flush(record.agent.session);await write({eventId:key,sessionId:record.id,status:'accepted',fingerprint,mode:input.mode,messageId:id});
  return {accepted:true};
}
/** The preset's /compact command owns its isolated native compaction service.
 * Pair it with a stable command id so a lost HTTP response cannot compact twice. */
export async function compactBotTopic(record,requestId,{read,write,flush,findCommand}){
  const key='manual-compact:'+requestId,prior=await read(key);
  if(prior?.status==='complete')return {compacted:prior.compacted,...(prior.error?{error:prior.error}:{})};
  const commandId='cmd-worldlinebox-'+createHash('sha256').update(requestId).digest('hex').slice(0,32);
  const events=record.agent.session.snapshotEvents(),done=events.findLast(event=>event.type==='command/done'&&event.data.commandId===commandId);
  const save=async result=>{await flush(record.agent.session);await write({eventId:key,status:'complete',...result});return result;};
  if(done)return save({compacted:done.data.kind==='success'&&done.data.sourceEventSeq!==undefined,...(done.data.kind==='error'?{error:done.data.text}:{} )});
  const ended=events.findLast(event=>event.type==='compaction/end'&&event.data.sourceCommandId===commandId);
  if(ended&&!ended.data.error){const summary=events.findLast(event=>event.type==='compaction/summary'&&event.data.sourceCommandId===commandId);
    record.agent.session.append('command/done',{commandId,kind:'success',...(summary?{sourceEventSeq:summary.seq}:{})});return save({compacted:!!summary});}
  if(record.status==='running'||record.admissions||record.agent.status!=='idle')throw Error('Compaction requires an idle Session.');
  const command=findCommand(record.agent);if(!command)throw Error('The native /compact command is not enabled in this companion preset.');
  if(events.some(event=>event.type==='compaction/start'&&event.data.sourceCommandId===commandId)&&!ended)throw Error('The previous native compaction is not settled; its durable lock is retained.');
  await write({eventId:key,status:'prepared'});
  if(!events.some(event=>event.type==='command/run'&&event.data.commandId===commandId))record.agent.session.append('command/run',{commandId,name:'compact',args:'',source:{kind:'user'}});
  let result;
  try{result=await command.handler({commandId,agent:record.agent,rawInput:'',attachments:[],signal:new AbortController().signal});}
  catch(error){result={kind:'error',text:String(error.message??error)};}
  record.agent.session.append('command/done',{commandId,kind:result.kind,...(result.text!==undefined?{text:result.text}:{}),...(result.kind==='success'&&result.sourceEventSeq!==undefined?{sourceEventSeq:result.sourceEventSeq}:{})});
  return save({compacted:result.kind==='success'&&result.sourceEventSeq!==undefined,...(result.kind==='error'?{error:result.text}:{})});
}
async function botReadReceipt(record, eventId) {
  try { return JSON.parse(await readFile(botReceiptPath(record, eventId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
}
async function botAtomicJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = target + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value)); await rename(temporary, target);
}
async function botWriteReceipt(record, value) { await botAtomicJson(botReceiptPath(record, value.eventId),
  { ...(record.bot?.continuedFrom !== undefined ? { continuedFrom:record.bot.continuedFrom } : {}), ...value }); }

/** Explicit native continuation, bound to a durable terminal checkpoint. The
 * original user input is never re-enqueued, and retrying a command is idempotent. */
export async function continueBotOutput(record,input,{read,write,flush,freezeMessage}) {
  const checkpoint=input.continueAfterSeq,receipt=await read(input.eventId);
  if(!Number.isSafeInteger(checkpoint)||checkpoint<0)throw Error('Invalid continuation checkpoint.');
  const same=receipt?.continuedFrom===checkpoint;
  if(same&&receipt.status==='complete')return {accepted:true,result:receipt.result};
  if(!same&&!(receipt?.status==='complete'&&receipt.result?.status==='failed'&&receipt.result.outputCheckpoint===checkpoint))throw Error('The native continuation checkpoint is stale or belongs to another result.');
  if(record.status==='running'&&record.bot.eventId!==input.eventId)throw Error('Companion lane is busy.');
  const id='worldlinebox-bot-output-continuation:'+input.eventId+':'+checkpoint;
  record.bot.continuedFrom=checkpoint;record.bot.eventId=input.eventId;record.bot.suspended=false;
  if(!same)await write({eventId:input.eventId,status:'continuing',continuedFrom:checkpoint});
  const events=record.agent.session.snapshotEvents(),start=events.findIndex(event=>event.type==='user/message'&&event.data.id===id);
  const queued=[...record.agent.inbox.nextTurn,...record.agent.inbox.nextStep].some(message=>message.id===id);
  record.revision++;record.status='running';record.cancelled=false;record.lastError=undefined;record.reason=undefined;record.outputCheckpoint=undefined;
  if(start<0&&!queued)record.agent.followup(freezeMessage({id,role:'user',source:{kind:'worldlinebox-bot-output-continuation',form:'notice',summary:'继续原任务',...(record.bot.audience?{worldlineboxAudience:record.bot.audience}:{})},content:[{type:'text',text:
    '用户要求从已保存进展继续原任务。不要重放原始请求或重复已完成的工具与交付，先检查真实文件和回执；上轮输出达到单次限制，请分文件、分步骤生成内容，缩短单次工具参数，继续执行并核验后交付。'}]}));
  else if(start>=0){const end=events.slice(start+1).findLast(event=>event.type==='turn/end');if(end)record.reason=end.data.reason;}
  await flush(record.agent.session);await write({eventId:input.eventId,status:'accepted',continuedFrom:checkpoint});
  return {accepted:true};
}
/** A normal profile plugin. Native Web owns Agents, presets, policy and persistence. */
export async function registerCompanionPreset(ctx) {
  const id = "worldlinebox-companion-v2";
  if ((await ctx.agentPresets.list()).some(row => row.id === id)) return { id, revision: 'externally-managed',
    refresh: async () => ({ id, revision: 'externally-managed', sourceRevision: 'externally-managed' }),
    use: action => action({ id, revision: 'externally-managed', sourceRevision: 'externally-managed' }), release: async () => {} };
    const [{ load }, { entryListSchema }] = await Promise.all([import('js-yaml'), import('@deepseek-ai/cordis-plugin-include')]);
  let release, definition, revision, sourceRevision, failure, changes = Promise.resolve();
  const refresh = () => {
    const operation = changes.then(async () => {
    const document = await ctx.agentPresets.readDocument(ctx.agentPresets.defaultId);
    sourceRevision = createHash('sha256').update(document.content).digest('hex');
    if (revision === sourceRevision) return { id, revision, sourceRevision };
    const plugins = load(document.content, { schema: entryListSchema });
    let found = false;
    const configure = rows => {
      for (const row of rows) {
        if (row.name === '@deepseek-ai/dsh-compaction-basic') {
          row.config = { ...row.config, auto: true, thresholdRatio: 0.6, retainRatio: 0.2, headroomTokens: 2048, maxTokens: 2048,
            compactionRetries: 1, maxOverflowRetries: 1 }; found = true;
        }
        if (Array.isArray(row.config)) configure(row.config);
      }
    };
    configure(plugins);
    if (!found) plugins.push({ name: '@deepseek-ai/dsh-compaction-basic', config: { auto: true, thresholdRatio: 0.6, retainRatio: 0.2,
      headroomTokens: 2048, maxTokens: 2048, compactionRetries: 1, maxOverflowRetries: 1 } });
    const next = { id, name: 'WorldlineBox Companion', plugins }, previous = definition;
    const retired = release?.();
    // Native unregister removes the definition synchronously before its first
    // await; register publishes its replacement synchronously. Keep this pair
    // contiguous so native callers never observe a missing preset identity.
    const registration = ctx.agentPresets.register(next);
    let candidate;
    try {
      candidate = await registration; await retired;
      // A startup Host row must not ask for a global activation diagnostic
      // while that same row is still activating. Later HTTP refreshes can.
      if (previous) { const actual = await ctx.agentPresets.resolve(id); if (actual.broken) throw Error(actual.broken); }
      release = candidate; definition = next; revision = sourceRevision; failure = undefined;
    } catch (error) {
      const rejected = candidate?.();
      const restored = previous ? ctx.agentPresets.register(previous) : undefined;
      await rejected; if (!restored) throw error;
      release = await restored; failure = String(error.message ?? error).slice(0, 1000);
    }
    return { id, revision, sourceRevision, ...(failure ? { reason: failure } : {}) };
    });
    changes = operation.catch(() => undefined); return operation;
  };
  const use = action => {
    const operation = changes.then(() => action({ id, revision, sourceRevision, ...(failure ? { reason: failure } : {}) }));
    changes = operation.catch(() => undefined); return operation;
  };
  await refresh();
  return { id, get revision() { return revision; }, refresh, use, release: async () => { await changes; await release?.(); } };
}

export async function apply(ctx) {
  // Register before a Web user resumes persisted sessions, including direct CLI startup.
  const registeredPreset = await registerCompanionPreset(ctx);
  ctx.effect(() => registeredPreset.release);
  const token = process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN;
  delete process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN;
  // A user may also launch this profile through the official CLI.
  if (!token) return;
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('The WorldlineBox Host capability is invalid.');
  const sessions = new Map(), clients = new Set(), workerOwners = new Map(), workerAgents = new Map(), botOpenings = new Map(), botCancelChecks = new Map(),topicTitleChanges=new Map();
  const botIdleCacheTarget = 16, botActiveLaneLimit = 64;
  let botOpeningAdmission = Promise.resolve();
  const pendingWorkerQuestions = new Set();
  let pluginMutations = 0;
  let botProvider;
  let closing = false;
  const authorized = request => {
    const value = request.headers.authorization;
    return typeof value === 'string' && /^Bearer [a-f0-9]{64}$/.test(value)
      && timingSafeEqual(Buffer.from(value), Buffer.from('Bearer ' + token));
  };
  const recordFor = agent => {
    const seen = new Set();
    while (agent && !seen.has(agent.id)) {
      const owned = sessions.get(String(agent.session.id)) ?? workerOwners.get(String(agent.session.id));
      if (owned) return owned;
      seen.add(agent.id); agent = ctx.agents.get(agent.session.header.parentSession);
    }
  };
  const nativeCallRef = (record, agent, nativeCallId) => {
    const nativeSessionId = String(agent.session.id);
    return { nativeSessionId, nativeCallId, callId: nativeSessionId === record.id ? nativeCallId
      : 'child-' + createHash('sha256').update(nativeSessionId + ':' + nativeCallId).digest('hex').slice(0, 48) };
  };
  const descendants = async id => {
    const service = ctx.get('subagents');
    return service ? (await service.listDescendants(id, AbortSignal.timeout(30000))).filter(row => row.kind === 'child' && row.mode !== 'external') : [];
  };
  const forgetWorkerOwners = record => { for (const [id, owner] of workerOwners) if (owner === record) { workerOwners.delete(id); workerAgents.delete(id); } };
  const ownedJobs = (ownerIds) => {
    const jobs = ctx.get('jobs');
    return jobs ? ownerIds.flatMap(owner => jobs.list(owner).filter(job => job.owner === owner && ['running', 'stopping'].includes(job.status))) : [];
  };
  const workerBackgroundQuiet = async record => {
    const children = [...workerOwners].filter(([, owner]) => owner === record).map(([id]) => id);
    const jobs = ownedJobs([record.id, ...children]);
    if (!jobs.length && !children.some(id => ctx.agents.get(id)?.status === 'running')) return true;
    // Observe changes without collecting the end notice: the native job end
    // must still wake its owner and reach the model's normal tool loop.
    await wait(50); return false;
  };
  const stopWorkerBackground = async (record, keepInbox = false, certifyStop = true) => {
    if (record.bot?.role !== 'worker') return;
    if (keepInbox) record.bot.suspended = true;
    for (const id of record.cooperationChildren ?? []) {
      const child = sessions.get(id); if (child?.callbackOwner === record) { child.cancelled = true; await stopWorkerBackground(child, keepInbox, certifyStop); }
    }
    const rows = await descendants(record.id), jobs = ctx.get('jobs');
    const active = ownedJobs([record.id, ...rows.map(row => String(row.id))]);
    const hadActive = active.length > 0 || rows.some(row => ctx.agents.get(row.id)?.status === 'running');
    record.agent.cancel({ kind: 'user' }, { keepInbox });
    const failures = [];
    const waits = active.map(job => jobs.wait(job.id, 10000, job.owner).catch(error => { failures.push(error); }));
    for (const job of active) try { jobs.kill(job.id, job.owner, 'WorldlineBox task stopped'); } catch (error) { failures.push(error); }
    await Promise.all(waits);
    const children = rows.filter(row => row.parentId === record.id && ctx.agents.get(row.id)).map(row => row.id);
    if (children.length) {
      let timer;
      try { await Promise.race([ctx.get('subagents').drainChildren(record.agent, children), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native worker descendants did not quiesce.')), 10000);
      })]); } finally { clearTimeout(timer); }
    }
    record.agent.cancel({ kind: 'user' }, { keepInbox });
    let idleTimer;
    try { await Promise.race([record.agent.whenIdle(), new Promise((_, reject) => {
      idleTimer = setTimeout(() => reject(new Error('Native worker did not become idle after stopping its background work.')), 10000);
    })]); } finally { clearTimeout(idleTimer); }
    if (ownedJobs([record.id, ...rows.map(row => String(row.id))]).length) failures.push(new Error('Native worker jobs are still active.'));
    if (rows.some(row => ctx.agents.get(row.id)?.status === 'running')) failures.push(new Error('Native worker descendant is still running.'));
    // A new Host's empty process registry cannot prove that an old OS process
    // exited. Only native durable settlement closes a registered job's scope.
    for (const owner of certifyStop ? [record.id, ...rows.map(row => String(row.id))] : []) {
      const agent = ctx.agents.get(owner); if (agent) await ctx.sessions.flush(agent.session);
      const handle = await ctx.get('sessionPersistence').open(owner, 'read', { signal: AbortSignal.timeout(30000) });
      try {
        const stored = await handle.read(handle.inheritedEventCount, undefined, { signal: AbortSignal.timeout(30000) }), unsettled = new Set();
        for (const event of stored.events) {
          if (event.type === 'job/registered') unsettled.add(event.data.jobId);
          if (event.type === 'job/settled') unsettled.delete(event.data.jobId);
        }
        if (unsettled.size) failures.push(new Error('A native background job has no durable settlement; its old OS execution must be verified before stop can be certified.'));
      } finally { await handle.close(); }
    }
    if (failures.length) throw new AggregateError(failures, 'Native worker background stop is not yet confirmed: ' + failures.map(error => error.message).join('; ').slice(0, 1600));
    return { hadActive };
  };
  ctx.on('agent/created', ({ agent }) => {
    const record = recordFor(agent);
    if (!record?.bot || record.bot.role !== 'worker' || agent === record.agent) return;
    workerOwners.set(String(agent.session.id), record);
    workerAgents.set(String(agent.session.id), agent);
    setWorkerAccess(agent, record.bot.workerAccess === 'full');
    registerWorkerHostTools(record, agent);
    const prompt = agent.ctx.get('systemPrompt');
    if (!prompt) throw new Error('Native child system prompt service is unavailable.');
    record.disposers.push(prompt.section({ name: 'worldlinebox-companion', order: 0, complete: true, interpolate: false, text: () => record.bot.system }));
    record.disposers.push(...registerWorkspaceSessions(ctx, record, {
      sessions, create: input => createBot(input), emit, settle: target => { if (target) void settle(target); },
    }, agent));
  });
  const emit = (record, event) => {
    if(event.type==='complete'&&record.bot?.role==='worker')publishContext(record);
    const value = { sequence: record.next++, streamGeneration: record.streamGeneration ??= randomUUID(), receivedAt: new Date().toISOString(), sessionId: record.id,
      ...(record.bot?.eventId ? { eventId: record.bot.eventId } : {}), ...event };
    const owner = record.callbackOwner;
    if (owner && owner !== record && owner.status === 'running') {
      if (event.type === 'artifacts') owner.artifacts = [...owner.artifacts, ...event.artifacts].filter((file, index, all) => all.findIndex(item => item.path === file.path) === index);
      emit(owner, { ...event, type: event.type === 'complete' ? 'child_complete' : ['text', 'text_stream'].includes(event.type) ? 'child_' + event.type : event.type, nativeSessionId: record.id });
    }
    record.events.push(value);
    record.eventBytes += Buffer.byteLength(JSON.stringify(value));
    while (record.events.length > 8000 || record.eventBytes > 8 * 1024 * 1024) {
      record.eventBytes -= Buffer.byteLength(JSON.stringify(record.events.shift()));
    }
    for (const client of record.clients) {
      if (client.writableLength > 2 * 1024 * 1024) { client.destroy(); continue; }
      client.write(JSON.stringify(value) + '\n');
    }
  };
  const service = agent => agent.ctx.get('skills');
  const publishContext=record=>{
    if(closing||sessions.get(record.id)!==record||!record.agent)return;
    clearTimeout(record.contextTimer);record.contextTimer=undefined;
    try{
      const registry=ctx.get('sessionProjections');if(!registry)return;
      const snapshot=registry.snapshot(record.agent.session,['contextPressure','contextBreakdown','tokenUsage']);
      emit(record,{type:'context',context:nativeContextSample(record.id,{kind:'sequenced',...snapshot}),nativeSessionId:record.id});
    }catch(error){ctx.logger?.warn('WorldlineBox native context read failed: '+String(error?.message??error).slice(0,500));}
  };
  const projectionRegistry=ctx.get('sessionProjections');
  if(typeof projectionRegistry?.onChanged==='function'){const dispose=projectionRegistry.onChanged((session,key)=>{
    if(!['contextPressure','contextBreakdown','tokenUsage'].includes(key))return;
    const record=sessions.get(String(session.id));if(!record?.bot||record.bot.role!=='worker'||record.contextTimer)return;
    record.contextTimer=setTimeout(()=>publishContext(record),100);record.contextTimer.unref?.();
  });ctx.effect(()=>dispose);}
  const readCapabilities = async (record, query = { kind: 'overview' }, presetState) => {
    const agent = record.agent;
    const allTools = ctx.tools.schemas(agent);
    const tools = allTools.filter(tool => !record.policy.tools || record.policy.tools.includes(tool.name));
    const provider = service(agent);
    const allSkills = provider ? await provider.list({ cwd: record.cwd, scope: agent }) : [];
    const skills = allSkills.filter(skill => !record.policy.skills || record.policy.skills.includes(skill.name));
    const effective = { digest: createHash('sha256').update(JSON.stringify({ preset: record.preset, tools, skills })).digest('hex'),
      mode: record.preset === 'ptc' ? 'ptc' : 'native', preset: record.preset, toolCount: tools.length, skillCount: skills.length };
    const stale = presetState ? [...sessions.values()].filter(entry => entry.bot?.role === 'worker' && entry.presetRevision !== presetState.revision) : [];
    const scope = presetState ? { kind: 'companion-worker', revision: record.presetRevision ?? presetState.revision,
      sourceRevision: presetState.sourceRevision, pending: stale.length > 0 || record.presetRevision !== presetState.revision || !!presetState.reason,
      deferredWorkers: stale.length, deferredActiveWorkers: stale.filter(entry => entry.status === 'running' || entry.agent.status === 'running').length,
      ...((presetState.reason || stale.length || record.presetDeferredReason) ? { reason: presetState.reason || record.presetDeferredReason || '已有任务仍绑定其原生能力作用域；新的作用域能力供新任务使用。' } : {}) } : undefined;
    if (query.kind === 'summary' || query.kind === 'catalog') {
      const result = { modes: ['native', ...((await ctx.agentPresets.list()).some(preset => preset.id === 'ptc') ? ['ptc'] : [])], preset: record.preset,
        tools: [], skills: [], toolsTotal: tools.length, skillsTotal: skills.length, truncated: tools.length > 0 || skills.length > 0,
        toolRestrictions: typeof ctx.tools.guard === 'function', skillSelection: true, effective, ...(scope ? { scope } : {}) };
      if (query.kind === 'summary') return result;
      return { ...result, catalog: capabilityCatalogPage(tools, skills, query) };
    }
    let detail;
    if (query.kind === 'tool') detail = { kind: 'tool', name: query.name, available: tools.some(tool => tool.name === query.name),
      tool: tools.find(tool => tool.name === query.name), source: 'native-agent-scope', trust: 'capability_reference_data' };
    if (query.kind === 'skill') {
      const skill = skills.some(skill => skill.name === query.name) ? await provider.get(query.name, { cwd: record.cwd, scope: agent }) : undefined;
      const content = skill?.content ?? '', offset = query.textOffset ?? 0, end = Math.min(content.length, offset + (query.maxChars ?? 16000));
      detail = { kind: 'skill', name: query.name, available: !!skill, source: 'native-agent-scope', trust: 'capability_reference_data',
        ...(skill ? { skill: { name: skill.name, description: skill.description, provider: skill.provider, source: skill.source, path: skill.path,
          resourceBase: skill.resourceBase, content: content.slice(offset, end), textOffset: offset, totalChars: content.length,
          truncated: end < content.length, ...(end < content.length ? { nextTextOffset: end } : {}) } } : {}) };
    }
    if (query.kind === 'commands') {
      const entries = ctx.get('commands')?.list(agent) ?? [];
      const selected = query.name ? entries.filter(entry => entry.name === query.name) : entries;
      detail = { kind: 'commands', available: true, source: 'native-agent-scope', trust: 'capability_reference_data',
        commands: selected.slice(0, 100), totalCommands: selected.length, truncated: selected.length > 100, commandsExecutable: false };
    }
    return { modes: ['native', ...((await ctx.agentPresets.list()).some(preset => preset.id === 'ptc') ? ['ptc'] : [])], preset: record.preset,
      tools: tools.slice(0, 500).map(tool => ({ name: tool.name, description: String(tool.description ?? '').slice(0, 2000) })),
      skills: skills.slice(0, 500).map(skill => ({ name: skill.name, description: String(skill.description ?? '').slice(0, 2000) })),
      toolsTotal: tools.length, skillsTotal: skills.length, truncated: tools.length > 500 || skills.length > 500,
      toolRestrictions: typeof ctx.tools.guard === 'function', skillSelection: true, effective, ...(scope ? { scope } : {}), ...(detail ? { detail } : {}) };
  };
  const capabilities = async (record, query) => {
    if (!record.companionCatalog && record.bot?.role !== 'worker') return readCapabilities(record, query);
    await registeredPreset.refresh();
    return registeredPreset.use(state => readCapabilities(record, query, state));
  };
  const workerOutput = async (record, eventId, startMessageId) => {
    if (record.bot?.role !== 'worker') return record.text;
    return workerOutputFromEvents(record.agent.session.snapshotEvents(), { eventId, startMessageId }).text;
  };
  const settle = async record => {
    if (record.waiting) return;
    record.waiting = true;
    try {
      while (!closing) {
        const revision = record.revision;
        await record.agent.whenIdle();
        if (await ctx.get('subagents')?.waitForChildren?.(record.agent)) continue;
        const cooperating = [...record.cooperationChildren ?? []].map(id => sessions.get(id)).filter(child => child?.callbackOwner === record && child.status === 'running');
        if (cooperating.length) { await Promise.all(cooperating.map(child => child.agent.whenIdle())); await wait(25); continue; }
        if (record.bot?.role === 'worker' && !await workerBackgroundQuiet(record)) continue;
        const sequence = record.agent.session.seq;
        await wait(25);
        if (record.admissions || record.botMutationActive || revision !== record.revision || record.agent.status !== 'idle' || sequence !== record.agent.session.seq) continue;
        await ctx.sessions.flush(record.agent.session);
        // Prompt admission and persistence both yield. A guidance message can
        // start another native turn while the old turn is being flushed.
        // Never publish its interrupted/obsolete completion to the broker.
        if (record.admissions || record.botMutationActive || revision !== record.revision || record.agent.status !== 'idle' || sequence !== record.agent.session.seq) continue;
        if (record.bot && (closing || record.bot.suspended)) { record.status = 'idle'; return; }
        if (record.bot?.eventId) {
          const terminal = await botReadReceipt(record, record.bot.eventId);
          if (record.admissions || record.botMutationActive || revision !== record.revision || record.agent.status !== 'idle' || sequence !== record.agent.session.seq) continue;
          if (terminal?.status === 'complete') {
            record.status = terminal.result.status; record.text = terminal.result.text;
            emit(record, { type: 'complete', status: record.status, text: record.text, artifacts: terminal.result.artifacts, error: terminal.result.error, inputContextCommitted: terminal.result.inputContextCommitted,
              outputCheckpoint: terminal.result.outputCheckpoint,outputs:terminal.result.outputs }); break;
          }
        }
        if (record.bot?.role === 'worker') {
          const output=workerOutputFromEvents(record.agent.session.snapshotEvents(),{eventId:record.bot.eventId}),text=output.text;
          if (record.admissions || record.botMutationActive || revision !== record.revision || record.agent.status !== 'idle' || sequence !== record.agent.session.seq) continue;
          record.text = text;
          record.outputs=output.outputs;
        }
        // The host combines this native terminal receipt with effect proofs
        // and any explicit incomplete-business report before closing its task.
        record.status = record.cancelled ? 'cancelled' : record.reason?.kind === 'completed' ? 'succeeded' : 'failed';
        if(record.status==='failed'&&record.reason?.kind==='max-tokens')record.outputCheckpoint=record.agent.session.seq;
        if (record.bot?.eventId) await botWriteReceipt(record, { eventId: record.bot.eventId, status: 'complete',
          result: { eventId: record.bot.eventId, sessionId: record.id, status: record.status, text: record.text, artifacts: record.artifacts,outputs:record.outputs,
            inputContextCommitted: record.bot.inputContextCommitted === true,
            ...(record.outputCheckpoint !== undefined ? { outputCheckpoint: record.outputCheckpoint } : {}),
            ...(record.status === 'failed' ? { error: botTerminalError(record) } : {}) } });
        emit(record, { type: 'complete', status: record.status, text: record.text, reason: record.reason, artifacts: record.artifacts,outputs:record.outputs,
          ...(record.status === 'failed' ? { error: botTerminalError(record) } : {}),
          ...(record.outputCheckpoint !== undefined ? { outputCheckpoint: record.outputCheckpoint } : {}),
          ...(record.bot ? { inputContextCommitted: record.bot.inputContextCommitted === true } : {}) });
        break;
      }
    } catch (error) {
      if (record.bot) {
        record.status = record.agent.status === 'idle' ? 'idle' : 'running';
        emit(record, { type: 'delivery_unknown', error: String(error?.message ?? error), summary: 'Native completion could not be durably acknowledged.' });
        return;
      }
      record.status = 'failed'; emit(record, { type: 'complete', status: 'failed', error: String(error), text: record.text });
    } finally { record.waiting = false; }
  };
  ctx.on('session/event', (session, event) => {
    const record = sessions.get(String(session.id)) ?? workerOwners.get(String(session.id));
    const rootSession = record?.id === String(session.id);
    if (!record) return;
    const data = event.data;
    const nativeSessionId = String(session.id);
    record.positions ??= new Map();
    const position = { ...record.positions.get(nativeSessionId),
      ...(typeof data.turn === 'number' ? { nativeTurn: data.turn } : {}),
      ...(typeof data.step === 'number' ? { nativeStep: data.step } : {}) };
    if (event.type === 'turn/start') delete position.nativeStep;
    record.positions.set(nativeSessionId, position);
    const publish = value => emit(record, { nativeSessionId, nativeSequence: event.seq,rootSequence:record.agent.session.seq, ...position, ...value });
    if (record.bot && event.type === 'user/message' && data.id === 'worldlinebox-bot:' + record.bot.eventId) record.bot.inputContextCommitted = true;
    switch (event.type) {
      case 'turn/start': publish({ type: 'status', stage: 'turn_start', summary: '开始处理任务' }); break;
      case 'step/start': publish({ type: 'status', stage: 'step_start', summary: `开始第 ${data.step} 步处理` }); break;
      case 'step/end': publish({ type: 'status', stage: 'step_end', summary: `第 ${data.step} 步处理结束` }); break;
      case 'compaction/start': publish({ type: 'status', stage: 'compaction_start', summary: '正在整理当前会话上下文' }); break;
      case 'compaction/end': record.compactions = (record.compactions ?? 0) + 1; publish({ type: 'status', stage: 'compaction_end', summary: '当前会话上下文整理完成' }); break;
      case 'turn/end': if (rootSession) record.reason = data.reason; publish({ type: 'status', stage: 'turn_end', summary: '本轮处理结束' }); break;
      case 'approval/asked':
        publish({ type: 'approval_required', stage: 'message', toolName: data.toolName, callId: data.callId,
          text: JSON.stringify({ requestId: data.id, reason: String(data.reason ?? '').slice(0, 6000) }), contentKind: 'message',
          summary: '等待你在 DSH 中确认权限' });
        break;
      case 'approval/decided':
        publish({ type: 'approval_decided', stage: 'message',
          text: JSON.stringify({ requestId: data.id, outcome: data.outcome }), contentKind: 'message',
          summary: data.outcome === 'allowed-once' ? '本次权限已确认，继续处理' : '本次权限未获准，等待执行器反馈' });
        break;
      case 'tool/call': publish({ type: 'tool_call', stage: 'tool_start', toolName: data.name, callId: data.callId,
        text: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments), contentKind: 'input', summary: '开始调用工具' }); break;
      case 'tool/result':
        if (event.surfaceOp === undefined || event.surfaceOp === 'append') publish({ type: 'tool_result', stage: 'tool_end', callId: data.message.toolCallId,
          text: textOf(data.message), contentKind: 'output', summary: data.message.isError ? '工具执行失败' : '工具执行完成' });
        break;
      case 'assistant/message': {
        if (event.data.interrupted || event.surfaceOp !== undefined && event.surfaceOp !== 'append') break;
        const text = textOf(data.message);
        const reasoning = (data.message.content ?? []).filter(block => block.type === 'reasoning' && typeof block.text === 'string').map(block => block.text).join('\n\n');
        const stream = record.streams?.get(nativeSessionId);
        if (stream && reasoning) stream.reasoning = reasoning;
        if (reasoning) publish({ type: 'reasoning', stage: 'message', text: reasoning, textMode: 'snapshot',
          streamId: stream?.id ?? `native-${event.seq}`, outputState: 'committed', summary: '思考' });
        if (rootSession) record.text = text;
        publish({ type: rootSession ? 'text' : 'child_text', stage: 'message', text, streamId: stream?.id,
          textMode: 'snapshot', contentKind: 'message', outputState: 'committed' });
        break;
      }
      case 'deliverables/presented': {
        record.artifacts = [...record.artifacts, ...data.files].filter((file, index, all) => all.findIndex(item => item.path === file.path) === index);
        publish({ type: 'artifacts', artifacts: data.files, callId: data.callId });
        break;
      }

    }
  });
  const workerCallback = async (record, name, args, callId, signal, native) => {
    const owner = record.callbackOwner ?? record;
    const callback = owner.bot.callback, endpoint = new URL(callback.url);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/bot/tool'
      || !/^[a-f0-9]{64}$/.test(callback.token)) throw new Error('Invalid worker callback.');
    const response = await fetch(callback.url, { method: 'POST', signal: name === 'chat_ask_user' ? signal : AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      headers: { authorization: 'Bearer ' + callback.token, 'content-type': 'application/json' },
      body: JSON.stringify({ laneId: owner.bot.laneId, eventId: owner.bot.eventId, name, args, callId,
        ...(native?{nativeSessionId:native.nativeSessionId,nativeCallId:native.nativeCallId,rootSessionId:owner.id,rootSequence:owner.agent.session.seq}:{}) }) });
    if (!response.ok) throw Object.assign(new Error('Worker host rejected ' + name + ' (' + response.status + ').'), { status: response.status });
    const body = await response.json(); if (body.ok !== true) throw new Error('Worker host did not accept ' + name + '.');
    return body.result;
  };
  const registerWorkerHostTools = (record, agent) => {
    record.workerToolAgents ??= new WeakSet(); if (record.workerToolAgents.has(agent)) return;
    record.workerToolAgents.add(agent);
    for (const schema of record.bot.workerTools ?? []) record.disposers.push(agent.ctx.tools.register({ ...schema,
      output: { schema: { type: 'object', properties: { result: {} }, required: ['result'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.result) }] },
      async execute(args, exec) {
        if (recordFor(exec.agent) !== record || exec.signal.aborted) throw new Error('The host tool is outside this worker task.');
        const ref = nativeCallRef(record.callbackOwner ?? record, exec.agent, exec.callId);
        return { result: await workerCallback(record, schema.name, args, ref.callId, exec.signal, ref) };
      },
    }));
  };
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const id = String(agent.session.id), record = sessions.get(id) ?? workerOwners.get(id);
    if (!record) return;
    observeAssistantStream(record, id, frame, value => emit(record, value));
  });
  ctx.on('agent/error', ({ agent, error }) => {
    const record = sessions.get(String(agent.session.id));
    if (record) { record.reason = { kind: 'error' }; record.lastError = String(error); emit(record, { type: 'error', text: String(error), stage: 'failed' }); }
  });
  // Restrict only explicitly selected/cognitive tasks and their descendants.
  // Normal Web and partner sessions retain the complete native plugin catalog.
  ctx.effect(() => ctx.tools.guard(execution => {
    const record = recordFor(execution.agent);
    if (!record) return;
    if (record.policy.tools && !record.policy.tools.includes(execution.name)) return 'This tool is outside the task selection.';
    if (execution.name === 'skill' && record.policy.skills && !record.policy.skills.includes(execution.arguments?.name)) return 'This skill is outside the task selection.';
  }));
  ctx.on('tools/execute', async (execution, next) => {
    const record = recordFor(execution.agent);
    if (!record?.bot || execution.name !== 'ask_user_question') return next();
    const questions = execution.arguments?.questions;
    if (!Array.isArray(questions) || !questions.length) throw new Error('Ask at least one question.');
    const ref = nativeCallRef(record.callbackOwner ?? record, execution.agent, execution.callId);
    const question = questions.map(item => item.question + (item.detail ? '\n' + item.detail : '') + (item.options?.length
      ? '\n' + item.options.map(option => typeof option === 'string' ? option : option.label + (option.description ? '：' + option.description : '')).join('\n') : '')).join('\n\n');
    const answer = await workerCallback(record, 'chat_ask_user', { question }, ref.callId, execution.signal, ref);
    const text = typeof answer === 'string' ? answer : answer.text;
    const answers = questions.map(item => ({ id: item.id, selected: [], custom: text }));
    return { isError: false, value: { answers }, content: [{ type: 'text', text: JSON.stringify({ answers }) }] };
  }, { prepend: true });
  const decorateBot = record => {
    const accessDisposers = record.bot.role === 'worker' ? record.accessDisposers ??= [] : record.disposers;
    if (record.bot.role === 'worker') record.disposers.push(() => { for (const dispose of record.accessDisposers.splice(0)) dispose(); });
    if (record.bot.role === 'worker') {
      registerWorkerHostTools(record, record.agent);
      record.disposers.push(...registerWorkspaceSessions(ctx, record, {
        sessions, create: input => createBot(input), emit, settle: target => { if (target) void settle(target); },
      }));
    }
      if (record.bot.role === 'brain') {
        const callback = record.bot.callback;
        const endpoint = new URL(callback.url);
        if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/bot/tool'
          || !/^[a-f0-9]{64}$/.test(callback.token)) throw new Error('Invalid companion tool callback.');
        for (const schema of record.bot.tools) record.disposers.push(record.agent.ctx.tools.register({
          ...schema,
          output: { schema: { type: 'object', properties: { result: {} }, required: ['result'], additionalProperties: false },
            render: (_args, value) => [{ type: 'text', text: typeof value.result === 'string' ? value.result : JSON.stringify(value.result) }] },
          async execute(args, execution) {
            if (execution.agent !== record.agent || !record.bot.eventId) throw new Error('Companion tool has no admitted lane event.');
            const current = record.bot.callback;
            const response = await fetch(current.url, { method: 'POST', signal: AbortSignal.any([execution.signal, AbortSignal.timeout(120000)]),
              headers: { authorization: 'Bearer ' + current.token, 'content-type': 'application/json' },
              body: JSON.stringify({ laneId: record.bot.laneId, eventId: record.bot.eventId, name: schema.name, args, callId: execution.callId }) });
            if (!response.ok) throw new Error('Companion tool gateway rejected ' + schema.name + ' (' + response.status + ').');
            return { result: await response.json() };
          },
        }));
      }
      const prompt = record.agent.ctx.get('systemPrompt');
      if (!prompt) throw new Error('DSH system prompt service is unavailable.');
      record.disposers.push(prompt.section({ name: 'worldlinebox-companion', order: 0, complete: true, interpolate: false, text: () => record.bot.system }));
      record.disposers.push(record.agent.ctx.on('agent/request', async (_payload, next) => {
        const value = await next(); return { ...value, ...record.bot.selection };
      }, { prepend: true }));
      record.disposers.push(record.agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const value = await next(); return { ...value, ...(record.bot.role === 'brain' ? { contexts: [] } : {}),
          variables: { ...value.variables, provider: record.bot.selection.provider, model: record.bot.selection.model } };
      }, { prepend: true }));
    if (record.bot.role === 'brain' || record.bot.workerAccess !== 'full') {
      const allow = record.bot.role === 'brain' ? record.bot.tools.map(tool => tool.name) : [...scopedWorkerTools, ...(record.bot.workerTools ?? []).map(tool => tool.name)];
      // restrict() addresses global/inherited tools only. Callback tools are
      // Agent-local registrations, and naming them here rejects lane creation.
      accessDisposers.push(record.agent.ctx.tools.restrict({ allow: record.bot.role === 'brain' ? [] : scopedWorkerTools }));
      accessDisposers.push(record.agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const value = await next();
        // Newer DSH presents text/contexts only in this waterfall; declarations
        // are provider-owned and already scoped by tools.restrict above.
        // Older runtimes also expose tools here, so keep that narrow projection.
        return Array.isArray(value.tools) ? { ...value, tools: value.tools.filter(tool => allow.includes(tool.name)) } : value;
      }, { prepend: true }));
    }
    if (record.bot.role === 'worker' && record.bot.workerAccess !== 'full') accessDisposers.push(record.agent.ctx.on('tools/pre-execute', async (execution, next) => {
      const args = execution.arguments ?? {}, fs = record.agent.ctx.get('fs');
      const cwd = record.agent.ctx.get('workingDirectory')?.get(record.agent.session) ?? record.cwd;
      const paths = ['read', 'read_image', 'write', 'edit'].includes(execution.name) ? [args.file_path]
        : execution.name === 'working_directory' && args.cd !== undefined ? [args.cd]
          : execution.name === 'present' ? (args.files ?? []).map(file => file.path) : [];
      for (const filename of paths) {
        if (!fs || typeof filename !== 'string') return { kind: 'deny', reason: 'The task file reference is unavailable.' };
        const root = await fs.resolve(record.cwd, { signal: execution.signal });
        const target = await fs.resolve(filename, { cwd, signal: execution.signal });
        if (!fs.contains(root, target)) return { kind: 'deny', reason: 'This task may access only files in its own authorized workspace.' };
      }
      return next();
    }, { prepend: true }));
    if (record.bot.role === 'worker') setWorkerAccess(record.agent, record.bot.workerAccess === 'full');
    else record.agent.session.append('sandbox/mode', { mode: 'workspace-write' });
  };
  const ensureBotPreset = () => registeredPreset.refresh();
  const createBot = async input => {
    const record = { id: input.sessionId, cwd: input.cwd, preset: 'companion', policy: input.role === 'brain' ? { tools: input.tools.map(tool => tool.name) }
      : input.workerAccess === 'full' ? {} : { tools: [...scopedWorkerTools, ...(input.workerTools ?? []).map(tool => tool.name)] },
      events: [], clients: new Set(), next: 0, revision: 0, admissions: 1, status: 'idle', text: '', stream: '', lastPublish: 0,
      artifacts: [], disposers: [], eventBytes: 0, bot: input, lastUsed: Date.now(), openingUntil: Date.now() + 30000 };
    const project = botProjectDirectory(input);
    await mkdir(input.cwd, { recursive: true }); await mkdir(project, { recursive: true });
    const currentPreset = await ensureBotPreset(), preset = currentPreset.id;
    record.preset = preset; record.presetRevision = currentPreset.revision;
    const setup = async (scope, agent) => {
      await registeredPreset.use(async actual => {
        await ctx.agentPresets.mount(scope, actual.id);
        record.preset = actual.id; record.presetRevision = actual.revision;
      });
      record.agent = agent; sessions.set(record.id, record); decorateBot(record);
      // A recovered cancel intent must not wake a persisted worker inbox
      // before the subsequent authenticated cancel reconciliation request.
      if (input.cancelIntent === true) {
        record.bot.cancelHadInbox = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.id === 'worldlinebox-bot:' + input.eventId);
        record.bot.suspended = input.suspendIntent === true;
        agent.cancel({ kind: 'user' }, { keepInbox: input.suspendIntent === true });
      }
      await prepareBotWorkspace(ctx, record, input);
    };
    record.setup = setup;
    try {
      try { record.handle = await ctx.agents.resume({ resumeSessionId: input.sessionId, agentOptions: input.selection, setup }); }
      catch (error) {
        if (error.name !== 'SessionPersistenceNotFoundError') throw error;
        record.handle = await ctx.agents.create({ sessionId: input.sessionId, meta: { cwd: project, agentPreset: preset }, agentOptions: input.selection, setup });
      }
      record.agent = record.handle.agent;
      record.workspace = await registerBotWorkspace(ctx, record, input);
      record.bot.inputContextCommitted = record.agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === 'worldlinebox-bot:' + input.eventId);
      const restoredEvents = record.agent.session.snapshotEvents();
      const storedAudience = restoredEvents.find(event => event.type === 'user/message' && event.data.source?.worldlineboxAudience)?.data.source.worldlineboxAudience;
      if (storedAudience && (storedAudience.conversationId !== input.audience?.conversationId || storedAudience.kind !== input.audience?.kind)) throw new Error('Native Session audience ownership differs.');
      if (!storedAudience && input.audience && !record.agent.session.header.parentSession && restoredEvents.some(event => event.type === 'user/message')) throw new Error('An unlabelled legacy Session cannot acquire a new audience.');
      const turnStart = restoredEvents.findIndex(event => event.type === 'user/message' && event.data.id === 'worldlinebox-bot:' + input.eventId);
      if (turnStart >= 0) record.artifacts = restoredEvents.slice(turnStart + 1).filter(event => event.type === 'deliverables/presented').flatMap(event => event.data.files);
      record.admissions--;
      // Native persistence owns the recovered inbox; retry reconciles the same admission.
      record.status = record.agent.status !== 'idle' ? 'running' : 'idle';
      emit(record, { type: 'ready', stage: 'session', summary: '伙伴主脑原生会话已就绪' });
      if (record.status === 'running') void settle(record);
      return record;
    } catch (error) { sessions.delete(record.id); for (const dispose of record.disposers) dispose(); throw error; }
  };
  const deferWorkerPresetRefresh = (record, target) => {
    if (record.presetRevision === target.revision || record.bot?.role !== 'worker') return;
    // runMaintenance can park a wake only while its task remains active. Native
    // handle.dispose then awaits scope/persistence teardown before unregistering
    // the Agent, and has no public atomic ingress-close/rebind transaction.
    // Retain the original scope instead of losing direct Workbench/plugin input
    // during that asynchronous gap. New tasks mount the current generation.
    record.presetDeferredReason = '已有任务保留原生能力作用域；当前运行时没有带入站隔离的会话迁移接口，新作用域能力将用于新任务。';
  };
  // Diagnostic discovery mounts a native scope but never submits a prompt.
  const createDiscovery = async input => {
    if (typeof input.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.sessionId)
      || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) throw new Error('Invalid diagnostic Session identity or workspace.');
    const existing = sessions.get(input.sessionId); if (existing) return existing;
    const preset = input.preset ?? ctx.agentPresets.defaultId;
    const { sessionId } = await ctx.sessionController.create({ sessionId: input.sessionId, cwd: input.cwd, agentPreset: preset });
    const found = await ctx.sessionController.resolveAgent(sessionId); if (found.error) throw found.error;
    const record = { id: String(sessionId), cwd: input.cwd, preset, agent: found.agent, policy: {},
      events: [], clients: new Set(), next: 0, revision: 0, admissions: 0, status: 'idle', text: '', artifacts: [], disposers: [], eventBytes: 0 };
    sessions.set(record.id, record); return record;
  };
  const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  const body = async (request, maximum = 1024 * 1024) => {
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > maximum) throw new Error('Bridge request exceeds the input limit.'); chunks.push(chunk); }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      if (!authorized(request)) { json(response, { error: 'Unauthorized' }, 401); return; }
      const url = new URL(request.url, 'http://127.0.0.1');
      if(request.method==='POST'&&url.pathname==='/bot/topic-context'){
        const input=await body(request);
        if(typeof input.laneId!=='string'||!input.laneId||input.laneId.length>300||input.sessionId!=='wlb-bot-'+createHash('sha256').update(input.laneId).digest('hex'))throw Error('Invalid native context identity.');
        const record=sessions.get(input.sessionId);if(record&&record.bot?.laneId!==input.laneId)throw Error('Native context Session ownership differs.');
        const result=typeof ctx.sessionController.projections==='function'?await ctx.sessionController.projections({sessionId:input.sessionId},AbortSignal.timeout(15000)):{kind:'unsupported'};
        json(response,nativeContextSample(input.sessionId,result));return;
      }
      if (request.method === 'GET' && url.pathname === '/health') { json(response, { protocol, pid: process.pid, profile: ctx.get('profileContext')?.name, home: process.env.DSH_HOME,
        botLanes: [...sessions.values()].filter(record => record.bot).length, botCompactions: [...sessions.values()].reduce((sum, record) => sum + (record.compactions ?? 0), 0),
        botRunningJobs: ownedJobs([...new Set([...sessions.values()].filter(record => record.bot).map(record => record.id).concat([...workerOwners.keys()]))]).length }); return; }
      if (request.method === 'POST' && url.pathname === '/idle') {
        await body(request);
        json(response, await inspectNativeIdle(ctx, { sessions, botOpenings, botCancelChecks, pendingWorkerQuestions, pluginMutations, closing })); return;
      }
      if (request.method === 'POST' && url.pathname === '/shutdown') {
        closing = true; json(response, { accepted: true }); setTimeout(() => process.emit('SIGTERM'), 20); return;
      }
      if (request.method === 'POST' && url.pathname === '/bot/cancel') {
        const input = await body(request);
        if (typeof input.laneId !== 'string' || !input.laneId.length || input.laneId.length > 600
          || input.sessionId !== 'wlb-bot-' + createHash('sha256').update(input.laneId).digest('hex')
          || typeof input.eventId !== 'string' || !input.eventId.length || input.eventId.length > 300
          || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) throw new Error('Invalid cancellation identity.');
        const previous = botCancelChecks.get(input.sessionId); let release;
        const checking = new Promise(resolve => { release = resolve; }); botCancelChecks.set(input.sessionId, checking);
        await previous;
        try {
        // Reconcile a never-admitted legacy task before mounting presets or
        // callback tools. A failed attachment is not evidence of admission.
        const opening = botOpenings.get(input.sessionId); if (opening) await opening.catch(() => undefined);
        const active = sessions.get(input.sessionId);
        if (active && (!active.bot || active.bot.laneId !== input.laneId || path.resolve(active.cwd) !== path.resolve(input.cwd))) throw new Error('Cancellation Session ownership differs.');
        if (active || ctx.agents.get(input.sessionId)) { json(response, { requiresAttachment: true }); return; }
        const prior = await botReadReceipt(input, input.eventId);
        if (prior && !['not-admitted'].includes(prior.status)) { json(response, { requiresAttachment: true }); return; }
        if (ownedJobs([input.sessionId]).length) { json(response, { requiresAttachment: true }); return; }
        const persistence = ctx.get('sessionPersistence');
        let handle, admitted = false, persisted = false;
        try {
          handle = await persistence.open(input.sessionId, 'read', { signal: AbortSignal.timeout(30000) }); persisted = true;
          const stored = await handle.read(handle.inheritedEventCount, undefined, { signal: AbortSignal.timeout(30000) });
          const messageId = 'worldlinebox-bot:' + input.eventId, inbox = { 'next-turn': [], 'next-step': [] };
          for (const event of stored.events) {
            if (event.type === 'user/message' && event.data.id === messageId || event.type === 'job/registered') admitted = true;
            if (event.type === 'agent/inbox/spliced') {
              const target = inbox[event.data.target]; if (!target) throw new Error('Unknown native inbox target.');
              target.splice(event.data.start, event.data.deleteCount, ...event.data.inserted);
            }
          }
          admitted ||= [...inbox['next-turn'], ...inbox['next-step']].some(message => message.id === messageId);
        } catch (error) { if (error.name !== 'SessionPersistenceNotFoundError') throw error; }
        finally { await handle?.close(); }
        // listDescendants requires an existing root. A missing root still must
        // be checked for orphaned child headers instead of swallowing that API
        // failure as proof that no background execution exists.
        const children = persisted ? await descendants(input.sessionId)
          : (await persistence.list({ signal: AbortSignal.timeout(30000) })).filter(value => value.header.parentSession === input.sessionId);
        if (children.length) { json(response, { requiresAttachment: true }); return; }
        if (admitted) { json(response, { requiresAttachment: true }); return; }
        // This durable fence is also checked by /turn, so a delayed original
        // submission cannot execute after an authoritative absence result.
        const pendingFile = path.join(input.cwd, '.worldlinebox-brain', input.sessionId + '-pending.json');
        let pending;
        try { pending = JSON.parse(await readFile(pendingFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (pending && pending.eventId !== input.eventId) throw new Error('Cancellation has another unresolved event.');
        await botWriteReceipt(input, { eventId: input.eventId, status: 'not-admitted', sessionId: input.sessionId });
        if (pending) await rm(pendingFile, { force: true });
        json(response, { accepted: false, absent: true, sessionId: input.sessionId, eventId: input.eventId }); return;
        } finally { release(); if (botCancelChecks.get(input.sessionId) === checking) botCancelChecks.delete(input.sessionId); }
      }
      if(request.method==='POST'&&url.pathname==='/bot/guidance/check'){
        const input=await body(request);
        if(typeof input.laneId!=='string'||input.laneId.length>600||input.sessionId!=='wlb-bot-'+createHash('sha256').update(input.laneId).digest('hex')
          ||typeof input.cwd!=='string'||!path.isAbsolute(input.cwd)||typeof input.eventId!=='string'||!input.eventId.length||input.eventId.length>300
          ||typeof input.messageId!=='string'||!input.messageId.length||input.messageId.length>300||typeof input.text!=='string'||input.text.length>maxContextChars)throw Error('Invalid guidance inspection.');
        const receipt=await botReadReceipt(input,input.eventId+':guidance:'+input.messageId);
        if(receipt?.fingerprint&&receipt.fingerprint!==createHash('sha256').update(input.text).digest('hex')||receipt?.sessionId&&receipt.sessionId!==input.sessionId)throw Error('Guidance receipt identity differs.');
        if(receipt?.status==='accepted'){json(response,{accepted:true});return;}
        const event=await botReadReceipt(input,input.eventId);
        if(!receipt&&event?.status==='complete'&&event.result?.sessionId===input.sessionId){json(response,{accepted:false});return;}
        json(response,{unknown:true});return;
      }
      if(request.method==='POST'&&url.pathname==='/bot/topic-title'){
        const input=await body(request);
        if(typeof input.laneId!=='string'||input.laneId.length>600||input.sessionId!=='wlb-bot-'+createHash('sha256').update(input.laneId).digest('hex')
          ||typeof input.cwd!=='string'||!path.isAbsolute(input.cwd)||typeof input.title!=='string'||!input.title.trim()||input.title.length>100
          ||!Number.isSafeInteger(input.revision)||input.revision<1)throw Error('Invalid topic title update.');
        const operation=(topicTitleChanges.get(input.sessionId)??Promise.resolve()).catch(()=>undefined).then(async()=>{
        const filename=path.join(input.cwd,'.worldlinebox-brain',input.sessionId+'-title.json');
        let previous;try{previous=JSON.parse(await readFile(filename,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
        if(previous?.revision>input.revision){json(response,{renamed:true,superseded:true});return;}
        if(previous?.revision===input.revision&&previous.title!==input.title)throw Error('Topic title revision has different content.');
        const record=sessions.get(input.sessionId);
        if(record&&(!record.bot||record.bot.laneId!==input.laneId||path.resolve(record.cwd)!==path.resolve(input.cwd)))throw Error('Topic title ownership differs.');
        // The controller resolves cold sessions into a live Agent. Own that
        // temporary handle ourselves so rename cannot leave a second writer
        // blocking the next normal companion attachment. Never wake old inbox
        // work without its authenticated model/tool/callback configuration.
        let temporary,acceptedTitle;
        try{
          if(!record&&!ctx.agents.get(input.sessionId))temporary=await ctx.agents.resume({resumeSessionId:input.sessionId,setup:(_scope,agent)=>{
            if(agent.inbox.nextTurn.length||agent.inbox.nextStep.length)throw Error('Cold topic has pending native work; wait for its authenticated task attachment.');
          }});
          const result=await ctx.sessionController.rename({sessionId:input.sessionId,title:input.title});
          const agent=record?.agent??temporary?.agent??ctx.agents.get(input.sessionId);if(agent)await ctx.sessions.flush(agent.session);
          await botAtomicJson(filename,{revision:input.revision,title:input.title});acceptedTitle=result.title;
        }finally{await temporary?.dispose();}
        json(response,{renamed:true,title:acceptedTitle});
        });topicTitleChanges.set(input.sessionId,operation);try{await operation;}finally{if(topicTitleChanges.get(input.sessionId)===operation)topicTitleChanges.delete(input.sessionId);}return;
      }
      if (request.method === 'POST' && url.pathname === '/bot/lanes') {
        const input = await body(request);
        input.workerTools ??= [];
        if (input.audience !== undefined && (!input.audience || typeof input.audience.conversationId !== 'string' || !input.audience.conversationId.length || input.audience.conversationId.length > 200
          || !['direct', 'group', 'peer', 'world'].includes(input.audience.kind) || !Array.isArray(input.audience.allowedConversationIds) || input.audience.allowedConversationIds.length > 5000
          || input.audience.allowedConversationIds.some(id => typeof id !== 'string' || !id.length || id.length > 200)
          || !input.audience.allowedConversationIds.includes(input.audience.conversationId))) throw new Error('Invalid native Session audience.');
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.sessionId) || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd) || typeof input.laneId !== 'string' || input.laneId.length > 600
          || !['brain', 'worker'].includes(input.role) || input.workerAccess !== undefined && !['scoped', 'full'].includes(input.workerAccess)
          || typeof input.system !== 'string' || !input.system.trim() || input.system.length > maxContextChars
          || !Array.isArray(input.tools) || input.tools.length > 24 || input.tools.some(tool => !tool || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)
            || typeof tool.description !== 'string' || !tool.parameters || typeof tool.parameters !== 'object')
          || new Set(input.tools.map(tool => tool.name)).size !== input.tools.length
          || !Array.isArray(input.workerTools) || input.workerTools.length > 64 || input.workerTools.some(tool => !tool || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)
            || typeof tool.description !== 'string' || !tool.parameters || typeof tool.parameters !== 'object')
          || new Set(input.workerTools.map(tool => tool.name)).size !== input.workerTools.length) throw new Error('Invalid companion lane configuration.');
        botProvider ??= createBotProvider(ctx);
        const selection = (await botProvider).configure(input.cancelIntent === true
          ? { apiFormat: 'openai_chat', model: 'cancel-only', baseUrl: 'http://127.0.0.1:1', apiKey: 'cancel-only' } : input.model);
        let record = sessions.get(input.sessionId);
        if (record?.cacheEvicting) throw new Error('The companion lane has an active maintenance admission.');
        const currentPreset = await ensureBotPreset();
        if (record?.bot?.role === 'worker' && record.presetRevision !== currentPreset.revision) deferWorkerPresetRefresh(record, currentPreset);
        if (record?.backgroundStop) await record.backgroundStop;
        input.workerAccess ??= 'scoped';
        if (record && (record.bot?.audience?.conversationId !== input.audience?.conversationId || record.bot?.audience?.kind !== input.audience?.kind)) throw new Error('Native Session audience ownership differs.');
        if (record && (!record.bot || record.bot.laneId !== input.laneId || record.bot.role !== input.role
          || path.resolve(record.cwd) !== path.resolve(input.cwd))) throw new Error('Companion Session ownership differs.');
        if (!record) {
          let opening = botOpenings.get(input.sessionId);
          if (!opening) {
            const owned = [...sessions.values()].filter(value => value.bot);
            const busy = owned.filter(value => value.status === 'running' || value.admissions || value.botMutationActive || value.cacheEvicting || value.agent.status !== 'idle' || value.openingUntil > Date.now());
            const pending = [...botOpenings.keys()].filter(id => !sessions.has(id)).length;
            if (busy.length + pending >= botActiveLaneLimit) throw new Error('Companion native lane capacity is occupied by active tasks.');
            // Reserve before any await, and serialize cache disposal/admission.
            // Concurrent requests cannot evict the same Agent or over-admit.
            const admission = botOpeningAdmission.then(async () => {
              let owned = [...sessions.values()].filter(value => value.bot);
              const pendingCount = () => [...botOpenings.keys()].filter(id => !sessions.has(id)).length;
              while (owned.length >= botIdleCacheTarget || owned.length + pendingCount() > botActiveLaneLimit) {
                const idle = owned.filter(value => value.status !== 'running' && !value.admissions && !value.botMutationActive && !value.cacheEvicting && !(value.openingUntil > Date.now())
                  && value.agent.status === 'idle').sort((a, b) => a.lastUsed - b.lastUsed)[0];
                if (!idle) break;
                idle.cacheEvicting = true;
                const eviction = (async () => {
                  await stopWorkerBackground(idle, true, false); await ctx.sessions.flush(idle.agent.session); await idle.handle.dispose();
                  for (const client of idle.clients) client.end(); sessions.delete(idle.id); forgetWorkerOwners(idle);
                })();
                let timer;
                try { await Promise.race([eviction, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native idle lane cache disposal timed out.')), 10000); })]); }
                catch {
                  // An unconfirmed disposal stays reserved and fenced. New
                  // independent work may use the remaining hard capacity.
                  // Retain the promise's rejection handler after the timeout.
                  void eviction.catch(() => undefined); break;
                } finally { clearTimeout(timer); }
                owned = [...sessions.values()].filter(value => value.bot);
              }
              // Pending SDK setup already owns a reservation. Count it even
              // before createBot registers a Session, including this opening.
              if (owned.length + pendingCount() > botActiveLaneLimit) throw new Error('Companion native lane capacity is occupied by active tasks.');
            });
            // Plugin setup is independent across lanes. A stuck third-party
            // setup keeps its own reservation, not every subsequent opening.
            opening = admission.then(() => createBot({ ...input, selection }));
            botOpenings.set(input.sessionId, opening);
            botOpeningAdmission = admission.then(() => undefined, () => undefined);
          }
          try { record = await opening; } finally { if (botOpenings.get(input.sessionId) === opening) botOpenings.delete(input.sessionId); }
          if (!record.bot || record.bot.laneId !== input.laneId || record.bot.role !== input.role || path.resolve(record.cwd) !== path.resolve(input.cwd))
            throw new Error('Companion Session ownership differs.');
        } else {
          if (record.status === 'running') {
            if (record.bot.eventId !== input.eventId) throw new Error('The companion lane has an active turn.');
            record.bot.callback = input.callback; record.bot.audience = input.audience;
            json(response, { sessionId: record.id, cursor: record.next - 1 }); return;
          }
          if (record.admissions || record.botMutationActive) throw new Error('The companion lane has an active maintenance admission.');
          if (JSON.stringify(record.bot.tools) !== JSON.stringify(input.tools) || JSON.stringify(record.bot.workerTools ?? []) !== JSON.stringify(input.workerTools)) throw new Error('Companion tool selection changed; create a new lane epoch.');
          record.bot.system = input.system; record.bot.callback = input.callback; record.bot.audience = input.audience; record.bot.selection = selection;
          // Newer native loops freeze model identity before agent/request.
          // A cold suspend may have attached with the inert cancel-only model;
          // select the real model before resuming that same native Session.
          record.agent.model?.select?.(selection);
          record.lastUsed = Date.now();
        }
        if (input.workspaceTitle !== undefined) { await prepareBotWorkspace(ctx, record, input); record.workspace = await registerBotWorkspace(ctx, record, input); }
        json(response, { sessionId: record.id, cursor: record.next - 1,
          ...(record.workspace ? { workspace: { id: record.workspace.id, title: record.workspace.title, path: record.workspace.path, sessionIds: record.workspace.sessionIds } } : {}) }); return;
      }
      const botMatch = /^\/bot\/lanes\/([A-Za-z0-9_-]+)\/(turn|cancel|input|archive|compact)$/.exec(url.pathname);
      if (request.method === 'POST' && botMatch) {
        if (botMatch[2] === 'turn') await botCancelChecks.get(botMatch[1]);
        const record = sessions.get(botMatch[1]), input = await body(request);
        if (!record && botMatch[2] === 'archive') { json(response, { archived: true }); return; }
        if (!record?.bot) throw new Error('Unknown companion lane event.');
        const previous = record.botMutation ?? Promise.resolve();
        let release;
        record.botMutation = new Promise(resolve => { release = resolve; });
        await previous; record.botMutationActive = true;
        try {
        if (botMatch[2] === 'archive') {
          if (!record.bot || record.status === 'running' || record.admissions || record.agent.status !== 'idle'
            || record.agent.inbox.nextTurn.length || record.agent.inbox.nextStep.length) throw new Error('Archive requires an idle completed companion lane.');
          await stopWorkerBackground(record, true, false);
          await ctx.sessions.flush(record.agent.session); await record.handle.dispose();
          for (const client of record.clients) client.end(); sessions.delete(record.id); forgetWorkerOwners(record);
          json(response, { archived: true }); return;
        }
        if (!record?.bot || typeof input.eventId !== 'string' || !input.eventId.length || input.eventId.length > 300) throw new Error('Unknown companion lane event.');
        if(botMatch[2]==='compact'){
          if(typeof input.requestId!=='string'||!input.requestId.length||input.requestId.length>160)throw Error('Invalid compaction request.');
          json(response,await compactBotTopic(record,input.requestId,{read:key=>botReadReceipt(record,key),write:value=>botWriteReceipt(record,value),flush:session=>ctx.sessions.flush(session),findCommand:agent=>agent.ctx.get('commands')?.find(agent,'compact')}));return;
        }
        if (botMatch[2] === 'input') {
          if (typeof input.messageId !== 'string'
            || !input.messageId.length || input.messageId.length > 300 || typeof input.text !== 'string' || !input.text.trim()
            || input.text.length > maxContextChars || !['queue', 'steer'].includes(input.mode)) throw new Error('Invalid task guidance.');
          const {freezeMessage}=await import('@deepseek-ai/dsh-llm');
          json(response,await deliverBotGuidance(record,input,{read:key=>botReadReceipt(record,key),write:value=>botWriteReceipt(record,value),flush:session=>ctx.sessions.flush(session),freezeMessage}));return;
        }
        if (botMatch[2] === 'cancel') {
          const prior = await botReadReceipt(record, input.eventId);
          if (prior?.status === 'complete') {
            if (record.bot.role === 'worker') await stopWorkerBackground(record, false);
            if (Number.isSafeInteger(prior.result.outputCheckpoint) && input.suspend !== true) {
              const result = { ...prior.result, status: 'cancelled', error: undefined, outputCheckpoint: undefined };
              await botWriteReceipt(record, { eventId: input.eventId, status: 'complete', result });
              record.status = 'cancelled'; record.cancelled = true; record.outputCheckpoint = undefined;
              json(response, { accepted: true, result }); return;
            }
            json(response, { accepted: true, result: prior.result }); return;
          }
          if (prior?.status === 'not-admitted') { json(response, { accepted: false, absent: true }); return; }
          // The explicit cancellation/restart path alone may scan history.
          // Warm message admission never re-loads the native log.
          const events = record.agent.session.snapshotEvents(), messageId = 'worldlinebox-bot:' + input.eventId;
          const start = events.findIndex(event => event.type === 'user/message' && event.data.id === messageId);
          const inbox = record.bot.cancelHadInbox || [...record.agent.inbox.nextTurn, ...record.agent.inbox.nextStep].some(message => message.id === messageId);
          const pendingFile = path.join(record.cwd, '.worldlinebox-brain', record.id + '-pending.json');
          let pending;
          try { pending = JSON.parse(await readFile(pendingFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (start < 0 && !inbox && !prior) {
            if (input.suspend === true) {
              await ctx.sessions.flush(record.agent.session);
              await botWriteReceipt(record, { eventId: input.eventId, status: 'paused', admitted: false });
              json(response, { accepted: true, paused: true, sessionId: record.id, eventId: input.eventId }); return;
            }
            if (pending?.eventId === input.eventId) await rm(pendingFile, { force: true });
            await botWriteReceipt(record, { eventId: input.eventId, status: 'not-admitted' });
            json(response, { accepted: false, absent: true }); return;
          }
          // An accepted receipt proves that the original inbox insertion was
          // flushed. The driver may have claimed it before user/message is
          // emitted; stopping that native activity is still authoritative.
          if (record.status === 'running' && record.bot.eventId !== input.eventId) throw new Error('The companion lane has an active turn for another event.');
          record.bot.eventId = input.eventId;
          record.cancelled = input.suspend !== true;
          record.bot.suspended = input.suspend === true;
          if (record.bot.role === 'worker') await stopWorkerBackground(record, input.suspend === true);
          else if (record.status === 'running') await ctx.sessionController.cancel({ sessionId: record.id }, new AbortController().signal);
          await record.agent.whenIdle();
          while (await ctx.get('subagents')?.waitForChildren?.(record.agent)) await record.agent.whenIdle();
          await ctx.sessions.flush(record.agent.session);
          if (record.bot.suspended) {
            record.status = 'idle'; await botWriteReceipt(record, { eventId: input.eventId, status: 'accepted', suspended: true });
            json(response, { accepted: true, paused: true, sessionId: record.id, eventId: input.eventId }); return;
          }
          let text = record.text, end;
          if (start >= 0) for (const event of record.agent.session.snapshotEvents().slice(start + 1)) {
            if (event.type === 'user/message' && event.data.source.kind === 'worldlinebox-bot') break;
            if (event.type === 'assistant/message') text = textOf(event.data.message);
            if (event.type === 'turn/end') end = event;
          }
          if (record.bot.role === 'worker') text = await workerOutput(record, input.eventId);
          const reason = end?.data.reason.kind;
          const status = record.bot.role === 'worker' && record.cancelled ? 'cancelled'
            : reason === 'completed' ? 'succeeded' : !reason || ['aborted', 'interrupted'].includes(reason) ? 'cancelled' : 'failed';
          const inputContextCommitted = record.agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === messageId);
          const result = { eventId: input.eventId, sessionId: record.id, status, text, artifacts: record.artifacts, inputContextCommitted,
            ...(status === 'failed' ? { error: record.lastError || 'Native companion turn failed.' } : {}) };
          await botWriteReceipt(record, { eventId: input.eventId, status: 'complete', result });
          if (pending?.eventId === input.eventId) await rm(pendingFile, { force: true });
          record.status = status; json(response, { accepted: true, result }); return;
        }
        if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > maxContextChars) throw new Error('Invalid companion message.');
        const receipt = await botReadReceipt(record, input.eventId);
        if(input.continueAfterSeq!==undefined){
          const {freezeMessage}=await import('@deepseek-ai/dsh-llm');record.admissions++;
          try{json(response,await continueBotOutput(record,input,{read:eventId=>botReadReceipt(record,eventId),write:value=>botWriteReceipt(record,value),flush:session=>ctx.sessions.flush(session),freezeMessage}));}
          finally{record.admissions--;void settle(record);}return;
        }
        if (receipt?.status === 'complete') { json(response, { accepted: true, result: receipt.result }); return; }
        if (receipt?.status === 'not-admitted') throw new Error('The native event was cancelled before admission.');
        if (record.status === 'running') {
          if (record.bot.eventId !== input.eventId) throw new Error('Companion lane is busy.');
          json(response, { accepted: true }); return;
        }
        if (record.admissions) throw new Error('The companion lane has an active maintenance admission.');
        const pendingFile = path.join(record.cwd, '.worldlinebox-brain', record.id + '-pending.json');
        let pending;
        try { pending = JSON.parse(await readFile(pendingFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (pending && pending.eventId !== input.eventId) throw new Error('Companion lane has an unresolved delivery.');
        if (receipt || pending) {
          // This scan happens only while reconciling the one crash-window
          // event. Warm admissions use indexed receipt files, not full history.
          const messageId = 'worldlinebox-bot:' + input.eventId;
          const events = record.agent.session.snapshotEvents();
          const start = events.findIndex(event => event.type === 'user/message' && event.data.id === messageId);
          const queued = [...record.agent.inbox.nextTurn, ...record.agent.inbox.nextStep].some(message => message.id === messageId);
          if (start >= 0) {
            let text = '', end;
            for (const event of events.slice(start + 1)) {
              if (event.type === 'user/message' && event.data.source.kind === 'worldlinebox-bot') break;
              if (event.type === 'assistant/message') text = textOf(event.data.message);
              if (event.type === 'turn/end') end = event;
            }
            if (end?.data.reason.kind === 'completed' && record.bot.role !== 'worker') {
              const result = { text, sessionId: record.id, eventId: input.eventId, status: end.data.reason.kind === 'completed' ? 'succeeded' : 'failed', artifacts: record.artifacts, inputContextCommitted: true };
              await botWriteReceipt(record, { eventId: input.eventId, status: 'complete', result });
              await rm(pendingFile, { force: true }); json(response, { accepted: true, result }); return;
            }
          }
          if (start >= 0 || queued) {
            record.bot.inputContextCommitted = start >= 0;
            const recoveries = (receipt?.recoveries ?? 0) + 1;
            const { freezeMessage } = await import('@deepseek-ai/dsh-llm');
            record.bot.eventId = input.eventId; record.bot.suspended = false; record.status = 'running'; record.text = ''; record.reason = undefined; record.cancelled = false;
            record.revision++; record.admissions++;
            try {
              // Native resume closes an interrupted turn with durable closers.
              // Continue from its recorded history, never re-enqueue the user
              // input or assume an unacknowledged external effect failed.
              record.agent.followup(freezeMessage({ id: 'worldlinebox-bot-recovery:' + input.eventId + ':' + recoveries, role: 'user',
                source: { kind: 'worldlinebox-bot-recovery', form: 'notice', summary: '恢复中断的伙伴任务', ...(record.bot.audience ? { worldlineboxAudience: record.bot.audience } : {}) }, content: [{ type: 'text', text:
                  '宿主恢复事件 ' + input.eventId + '。继续处理历史中的原始请求；不要把本恢复通知当成新的用户任务。保留已经完成的工具和交付，不重复创建已有任务。对于缺失回执的外部操作，先检查真实状态，无法确认时报告需要核实，不得盲重试或声称已完成。' }] }));
              await ctx.sessions.flush(record.agent.session);
              await botWriteReceipt(record, { eventId: input.eventId, status: 'accepted', recoveries,
                }); await rm(pendingFile, { force: true });
              json(response, { accepted: true });
            } finally { record.admissions--; void settle(record); }
            return;
          }
        }
        const { freezeMessage } = await import('@deepseek-ai/dsh-llm');
        await botAtomicJson(pendingFile, { eventId: input.eventId });
        record.bot.eventId = input.eventId; record.bot.suspended = false; record.bot.inputContextCommitted = false; record.text = ''; record.reason = undefined; record.lastError = undefined; record.artifacts = []; record.outputCheckpoint = undefined;
        record.revision++; record.status = 'running'; record.cancelled = false; record.admissions++;
        try {
          record.agent.followup(freezeMessage({ id: 'worldlinebox-bot:' + input.eventId, role: 'user',
            content: [{ type: 'text', text: input.prompt }], source: { kind: 'worldlinebox-bot', form: 'relay', ...(record.bot.audience ? { worldlineboxAudience: record.bot.audience } : {}) } }));
          await ctx.sessions.flush(record.agent.session);
          await botWriteReceipt(record, { eventId: input.eventId, status: 'accepted' });
          await rm(pendingFile, { force: true });
          json(response, { accepted: true });
        } finally { record.admissions--; void settle(record); }
        return;
        } finally { record.botMutationActive = false; release(); }
      }
      if (request.method === 'POST' && url.pathname === '/capabilities') {
        const input = await body(request);
        const selected = input.companion === true ? await ensureBotPreset() : undefined;
        const preset = selected?.id ?? input.preset ?? ctx.agentPresets.defaultId;
        // A new declaration gets its own never-prompted discovery Session.
        // This also works on native releases without turnBoundaryOf/select:
        // a previous discovery Session is never guessed blank or recomposed.
        const record = selected ? await registeredPreset.use(async actual => {
          const record = await createDiscovery({ sessionId: input.sessionId + '-' + preset + '-' + actual.revision.slice(0, 16), cwd: input.cwd, preset: actual.id });
          record.companionCatalog = true; record.presetRevision = actual.revision;
          return record;
        }) : await createDiscovery({ sessionId: input.sessionId + '-' + preset, cwd: input.cwd, preset });
        json(response, await capabilities(record, input.query)); return;
      }
      if (request.method === 'POST' && url.pathname === '/plugins') {
        const input = await body(request), manager = ctx.get('pluginManager');
        if (!manager) throw new Error('This native profile has no plugin manager.');
        const requestId = randomUUID();
        const disconnected = () => { if (!response.writableEnded && input.action === 'add') void manager.cancelInstall(requestId).catch(() => undefined); };
        response.once('close', disconnected);
        pluginMutations++;
        try {
          const value = input.action === 'add' ? await manager.installBundle(input.spec, { requestId })
            : input.action === 'remove' ? await manager.removeBundle(input.spec)
            : input.action === 'toggle' ? await manager.setBundleEnabled(input.spec, input.enabled) : await manager.listBundles();
          json(response, value); return;
        } finally { pluginMutations--; response.removeListener('close', disconnected); }
      }
      const match = /^\/sessions\/([A-Za-z0-9_-]+)\/(events)$/.exec(url.pathname);
      const record = match && sessions.get(match[1]);
      if (!record) { json(response, { error: 'Unknown native Session' }, 404); return; }
      if (request.method === 'GET' && match[2] === 'events') {
        const after = Number(url.searchParams.get('after') ?? -1);
        if (!Number.isSafeInteger(after) || after < -1 || record.events[0]?.sequence > after + 1) throw new Error('Native event stream cursor is unavailable.');
        response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
        for (const event of record.events) if (event.sequence > after) response.write(JSON.stringify(event) + '\n');
        record.openingUntil = undefined; record.clients.add(response); clients.add(response);
        response.on('close', () => { record.clients.delete(response); clients.delete(response); }); return;
      }
      json(response, { error: 'Unknown bridge operation' }, 404);
    })().catch(error => {
      if (!response.headersSent) json(response, { error: String(error?.message ?? error) }, 500);
      else response.destroy();
    });
  });
  ctx.effect(() => async () => {
    closing = true;
    await Promise.allSettled([...sessions.values()].filter(record => record.bot).map(async record => {
      await stopWorkerBackground(record, true, false); await record.handle.dispose();
    }));
    if (botProvider) (await botProvider).close();

    for (const record of sessions.values()) for (const dispose of record.disposers) dispose();
    for (const client of clients) client.end();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  // Readiness follows native Loader settlement; listening alone is insufficient.
  void ctx.loader.await().then(() => process.stdout.write(`WORLDLINEBOX_DSH_BRIDGE_READY ${address.port}\n`));
}
