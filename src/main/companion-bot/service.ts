import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { BotEvent as UiEvent, BotRequest, BotResponse, BotSnapshot, BotReplyProgress, BotExecution } from '../../shared/companion-bot';
import { appendBotExecutionStep } from '../../shared/companion-bot-execution';
import type { BotMediaRef } from '../../shared/companion-bot-media';
import { DEFAULT_MODEL_CONTEXT_CHARS } from '../../shared/model-budget';
import { BotDshBrain, type BotDshModel, type BotDshResult } from './dsh-brain';
import type { BotBrain } from './brain-router';
import type { BotMemoryService, BotMemoryPrepared, BotMemoryScope, BotMemoryMessage, BotMemoryForget, BotMemoryUpdate, BotMemoryOrganize, BotMemoryWrite } from './memory-service';
import { BotScheduler } from './scheduler';
import { BotStore } from './store';
import { botLocalTimestamp, buildNativeBotContext } from './context';
import { BotToolServer, type BotToolCall } from './tool-server';
import { BOT_TOOLS, botToolsForApps } from './tools';
import { BOT_MEMORY_CAPTURE_POLICY, captureBotMemory } from './memory-capture';
import { BotMaintenanceRuntime } from './memory-maintenance-runtime';
import type { BotMemoryMaintenanceRequest } from '../../shared/companion-bot-maintenance';
import { BotWorld } from './world';
import { botWorldCommandSchema } from '../../shared/companion-bot-world';
import { BotHistoryProjector } from './history-projection';
import { BotAgentMemoryScopes } from './agent-memory-scope';
import { BotConversationContinuity, botConversationReadSchema } from './conversation-continuity';
import { BotContactStatus } from './contact-status';
import type { BotActivityBudgetPolicy } from './activity-budget';
import { BUILTIN_BOT_COMPANIONS, DEFAULT_BOT_COMPANION_ID } from '../../shared/builtin-bot-companions';
import type { BotMediaService } from './media-service';
import { botMessageEvidence } from '../../shared/bot-message-content';
import type { BotClaim, BotEvent, BotMemoryJobInput, BotAttachmentGrant } from './types';
import { botHandoffFile } from './task-handoff';
import { isGroupStop } from './group-attention';
import { BotTopics, type BotGuidance,type BotTopicTitleSync } from './topics';
import {botReplyDisplayParts} from '../../shared/companion-bot-reply';
import {botNativeContextSchema} from '../../shared/companion-native-context';
import { browserPageContextSchema, type BrowserPageContext } from '../../shared/browser-page-context';
import { companionBrowserArgumentsSchema, type CompanionBrowserArguments, type CompanionBrowserScope } from '../../shared/companion-browser';
import type { CompanionBrowserResult } from '../browser/service';
import { botAppIdSchema, companionAssetArgumentsSchema, type BotAppId } from '../../shared/companion-apps';
import type { BotAssetManagerApp } from './asset-manager-app';

export interface BotServiceOptions {
  assetManagerApp?: Pick<BotAssetManagerApp, 'connect' | 'execute'>;
  resolveBrowserContext?(referenceId: string): BrowserPageContext;
  browserTool?(scope: CompanionBrowserScope, input: CompanionBrowserArguments, signal: AbortSignal): Promise<CompanionBrowserResult>;
  root: string; brain: BotBrain; memory: BotMemoryService; model(): BotDshModel;
  prewarmMemory?: boolean;
  onEvent(event: UiEvent): void; report?(error: unknown): void;
  activityBudget?: Partial<BotActivityBudgetPolicy>;
  media?: BotMediaService;
  transcribeAttachments?(conversationId: string, attachments: BotMediaRef[], requestId: string): Promise<BotMediaRef[]>;
  /** Compatibility hook name: validates the one shared execution selection,
   * never allocates, starts or requires a separate DSH binding per companion. */
  ensureCompanionBindings?(companionIds: string[]): Promise<void>;
  companionRuntime?(companionId: string, name: string, operation: 'start' | 'stop', signal: AbortSignal): Promise<void>;
  restoreCompanionEnvironments?(companions: ReadonlyArray<{ id: string; name: string; enabled?: boolean }>, signal: AbortSignal): Promise<void>;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const nonempty = z.string().trim().min(1).max(24000);
const maxCausalHop = 6;
const causalHop = (event: BotEvent): number => event.source === 'user' || event.payload.hop === undefined ? 0
  : Number.isSafeInteger(event.payload.hop) && Number(event.payload.hop) >= 0 ? Number(event.payload.hop) : maxCausalHop;
const derivedCause = (event: BotEvent) => ({ correlationId: event.correlationId, causationId: event.id, hop: causalHop(event) + 1 });
const causalLimit = () => ({ accepted: false, sent: false, status: 'blocked', reason: '本次事件的自动衍生轮次已达上限，等待新的用户输入。' });
const scopeFor = (event: Pick<BotEvent, 'companionId' | 'conversationId' | 'securityDomainId'>): BotMemoryScope => ({ companionId: event.companionId, conversationId: event.conversationId, securityDomainId: event.securityDomainId });

/** Durable message routing and UI projection only. All model/tool execution belongs to native DSH Sessions. */
export class BotService {
  readonly store: BotStore;
  private readonly scheduler: BotScheduler;
  private readonly toolServer: BotToolServer;
  private readonly world: BotWorld;
  private readonly historyProjector: BotHistoryProjector;
  private readonly memoryMaintenance: BotMaintenanceRuntime;
  private readonly starting: Promise<void>;
  private readonly replyProgress = new Map<string, BotReplyProgress>();
  private readonly toolRuns = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  private readonly questions = new Map<string, { eventId: string; resolve(value: unknown): void }>();
  private readonly nativeStops = new Map<string, Promise<void>>();
  private readonly topics: BotTopics;
  private readonly guidanceRuns = new Map<string, Promise<void>>();
  private readonly titleRuns=new Map<string,Promise<void>>();
  private readonly contextReads=new Map<string,Promise<BotResponse>>();
  private readonly contextWatches=new Map<string,{controller:AbortController;timer:ReturnType<typeof setTimeout>}>();
  private readonly loadedTombstones = new Map<string, true>();
  private readonly sourceWithdrawalRuns = new Map<string, Promise<void>>();
  private readonly memoryWarmRuns = new Map<string, Promise<void>>();
  private readonly memoryWarmPhases = new Map<string, 'memory-starting' | 'memory-verifying' | 'memory-indexing' | 'recalling-memory'>();
  private readonly companionControls = new Map<string, Promise<void>>();
  private readonly companionControlRevisions = new Map<string, number>();
  private readonly companionStartWaiters = new Map<string, Set<AbortController>>();
  private readonly maintenanceAbort = new AbortController();
  private maintenance?: ReturnType<typeof setInterval>;
  private restoringCompanions?: Promise<void>;
  private memoryWorking = false;
  private memoryRun?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private ready = false;
  private detail?: string;
  constructor(private readonly options: BotServiceOptions) {
    this.store = new BotStore(path.join(options.root, 'bot.sqlite'), { activityBudget: options.activityBudget });
    this.topics = new BotTopics(this.store);
    this.world = new BotWorld(this.store);
    this.toolServer = new BotToolServer((call, signal) => this.tool(call, signal));
    this.memoryMaintenance = new BotMaintenanceRuntime({ store: this.store, root: options.root, brain: options.brain, memory: options.memory,
      model: options.model, callback: () => this.toolServer.start(), changed: id => this.changed(id), report: options.report });
    this.historyProjector = new BotHistoryProjector({ store: this.store, memory: options.memory });
    this.scheduler = new BotScheduler(this.store, { handle: (claim, signal) => this.respond(claim, signal), concurrency: 3,
      turnTimeoutMs: 24 * 60 * 60 * 1000,
      onChange: () => this.changed(), onError: error => { this.detail = errorText(error); options.report?.(error); this.changed(); } });
    this.starting = this.start();
  }
  private async start(): Promise<void> {
    await mkdir(this.options.root, { recursive: true }); await this.toolServer.start();
    if (this.closed) return;
    for (const builtin of BUILTIN_BOT_COMPANIONS) if (!this.store.getCompanion(builtin.id)) this.store.createCompanion({ id: builtin.id, name: builtin.name, persona: builtin.persona });
    this.store.openDirect(DEFAULT_BOT_COMPANION_ID);
    // Retire the old task engine without deleting user conversations or artifacts.
    this.store.taskTransaction(sql => {
      sql.prepare("UPDATE bot_inbox SET status='cancelled' WHERE source='task' AND status IN ('queued','running')").run();
    });
    this.scheduler.start();
    this.maintenance = setInterval(() => this.maintainSafely(), 1000); this.maintenance.unref?.();
    if (this.options.restoreCompanionEnvironments) this.restoringCompanions = this.options.restoreCompanionEnvironments(this.store.listCompanions(), this.maintenanceAbort.signal).catch(error => this.options.report?.(error));
  }
  configurationChanged(): void { this.ready = false; this.detail = undefined; this.changed(); }
  runtimePreparationChanged(): void { this.changed(); }
  embeddingChanged(): void { this.changed(); }
  executionCapabilitiesChanged(): void { this.changed(); }
  workerInstanceStopped(instanceId: string): void {
    for (const event of this.store.taskTransaction(sql => sql.prepare("SELECT id FROM bot_inbox WHERE status IN ('running','queued')").all() as Array<{id:string}>)) {
      const current = this.store.getEvent(event.id)!;
      if (this.store.getMetadata('native-host:' + this.topics.lane(current)) === instanceId) this.scheduler.cancel(event.id);
    }
  }
  private workspace(companionId: string): string { return path.join(this.options.root, 'workspaces', digest(companionId)); }
  /** A disconnected native turn can outlive its UI lease. Persist cancellation
   * independently of that lease and reconcile it across application restarts. */
  private queueNativeStop(event: BotEvent): void {
    if (!this.store.getMetadata('native-input:' + event.id)) return;
    this.store.setMetadata('native-stop:' + event.id, JSON.stringify({ eventId: event.id, retryAt: 0 }));
    void this.flushNativeStop(event.id);
  }
  private flushNativeStop(eventId: string): Promise<void> {
    const previous = this.nativeStops.get(eventId); if (previous) return previous;
    const operation = (async () => {
      const event = this.store.getEvent(eventId), saved = this.store.getMetadata('native-input:' + eventId);
      if (!event || !saved) { this.store.setMetadata('native-stop:' + eventId, ''); return; }
      try {
        const rawIntent = this.store.getMetadata('native-stop:' + eventId);
        const intent = JSON.parse(rawIntent || '{}') as { suspend?: boolean };
        const context = JSON.parse(saved) as { system: string };
        const room = this.store.getConversation(event.conversationId)!;
        await this.options.brain.cancelDurable({ laneId: this.topics.lane(event), eventId: event.id,
          cwd: this.workspace(event.companionId), system: context.system, model: this.options.model(),
          audience: { conversationId: room.id, kind: room.kind, allowedConversationIds: [room.id] },
          callback: await this.toolServer.start(), tools: [], workerTools: BOT_TOOLS, role: 'worker', workerAccess: 'full',
          signal: this.maintenanceAbort.signal }, intent.suspend === true);
        if (!this.closed && this.store.getMetadata('native-stop:' + eventId) === rawIntent) {
          if (intent.suspend) this.store.confirmNativeInterruption(eventId);
          else this.store.setMetadata('native-stop:' + eventId, '');
          this.changed(event.conversationId);
        }
      } catch (error) {
        if (!this.closed) {
          const intent = JSON.parse(this.store.getMetadata('native-stop:' + eventId) || '{}');
          this.store.setMetadata('native-stop:' + eventId, JSON.stringify({ ...intent, eventId, retryAt: Date.now() + 5000 }));
          this.options.report?.(error);
        }
      }
    })().finally(() => this.nativeStops.delete(eventId));
    this.nativeStops.set(eventId, operation); return operation;
  }
  private updateExecution(event: BotEvent, patch: Partial<BotExecution>): void {
    const key = 'execution:' + event.replyMessageId;
    const previous = this.store.getMetadata(key);
    const execution: BotExecution = { status: 'running', steps: [], ...(previous ? JSON.parse(previous) : {}), ...patch };
    this.store.setMetadata(key, JSON.stringify(execution));
  }
  private async topicContext(input:Extract<BotRequest,{type:'topic.context'}>):Promise<BotResponse>{
    const {conversationId,topicId,companionId}=input,binding=this.topics.contextBinding(topicId,conversationId,companionId);
    if(!binding)return{ok:true,topicContext:{topicId,companionId}};
    this.watchContext(conversationId,topicId,companionId,binding.laneId);
    const key=conversationId+':'+topicId+':'+companionId,prior=this.contextReads.get(key);if(prior)return prior;
    const operation=(async():Promise<BotResponse>=>{
      try{
        if(!this.options.brain.topicContext)throw Error('当前 DSH 连接暂不支持原生上下文统计。');
        const sample=await this.options.brain.topicContext(binding.laneId);
        if(this.closed)return{ok:false,error:'伙伴服务已关闭。'};
        const current=this.topics.contextBinding(topicId,conversationId,companionId);
        if(current?.laneId!==binding.laneId||sample.sessionId!==BotDshBrain.sessionId(binding.laneId))throw Error('上下文统计的原生会话身份已变化。');
        if(sample.state==='unsupported'||sample.state==='empty'&&current.sample)return{ok:true,topicContext:{topicId,companionId,sample:current.sample??sample,stale:!!current.sample,error:sample.state==='unsupported'?'此 DSH 版本尚未提供原生上下文统计。':'DSH 暂未返回此会话的统计。'}};
        if(this.topics.rememberContext(conversationId,binding.laneId,sample))this.changed(conversationId);
        return{ok:true,topicContext:{topicId,companionId,sample,stale:sample.state==='migration-required'}};
      }catch(error){
        if(this.closed)return{ok:false,error:'伙伴服务已关闭。'};
        const current=this.topics.contextBinding(topicId,conversationId,companionId);
        return{ok:true,topicContext:{topicId,companionId,sample:current?.sample,stale:!!current?.sample,error:errorText(error)}};
      }
    })();
    this.contextReads.set(key,operation);try{return await operation;}finally{if(this.contextReads.get(key)===operation)this.contextReads.delete(key);}
  }
  private watchContext(conversationId:string,topicId:string,companionId:string,laneId:string):void{
    if(!this.options.brain.watchTopicContext||this.closed)return;
    const key=conversationId+':'+topicId+':'+companionId,previous=this.contextWatches.get(key);
    if(previous){clearTimeout(previous.timer);previous.timer=setTimeout(()=>previous.controller.abort(),12000);previous.timer.unref();return;}
    if(this.contextWatches.size>=8)this.contextWatches.values().next().value?.controller.abort();
    // Only viewed topics are watched. UI reads renew this short subscription;
    // topic switching, unmounting and shutdown release the Host lease.
    const controller=new AbortController(),watch={controller,timer:setTimeout(()=>controller.abort(),12000)};watch.timer.unref();this.contextWatches.set(key,watch);
    controller.signal.addEventListener('abort',()=>{clearTimeout(watch.timer);if(this.contextWatches.get(key)===watch)this.contextWatches.delete(key);},{once:true});
    void(async()=>{while(!controller.signal.aborted&&!this.closed){
      try{await this.options.brain.watchTopicContext!(laneId,sample=>{
        if(this.closed||controller.signal.aborted)return;
        const binding=this.topics.contextBinding(topicId,conversationId,companionId);if(binding?.laneId!==laneId){controller.abort();return;}
        if(this.topics.rememberContext(conversationId,laneId,sample))this.changed(conversationId);
      },controller.signal);}catch{if(controller.signal.aborted||this.closed)return;}
      await new Promise<void>(resolve=>{const timer=setTimeout(done,1000);function done(){clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();}controller.signal.addEventListener('abort',done,{once:true});});
    }})().catch(error=>this.options.report?.(error));
  }
  private snapshot(conversationId?: string, before?: number): BotSnapshot {
    if (conversationId) this.prewarmSelectedMemory(conversationId);
    const page = conversationId ? this.store.messagesPage(conversationId, { limit: 80, before }) : { items: [], hasMore: false };
    const companions = this.store.listCompanions();
    return { companions, presence: this.store.companionPresence(companions, true), conversations: this.store.conversations(), conversationActivity: this.store.conversationActivity(),
      messages: page.items.map(message => {
        const rawExecution = this.store.getMetadata('execution:' + message.id);
        const execution = rawExecution ? JSON.parse(rawExecution) as BotExecution : undefined;
        if (execution?.interruption) {
          const event = this.store.eventForReply(message.id);
          if (event && this.store.nativeReplySuperseded(event)) execution.interruption = undefined;
        }
        const browserRaw = this.store.getMetadata('browser-context:' + message.id);
        const browserContext = browserRaw ? browserPageContextSchema.safeParse(JSON.parse(browserRaw)) : undefined;
        const apps = botAppIdSchema.array().safeParse(JSON.parse(this.store.getMetadata('message-apps:' + message.id) || '[]'));
        return { ...message, ...(apps.success && apps.data.length ? { apps: apps.data } : {}), ...(browserContext?.success ? { browserContext: browserContext.data } : {}), ...(execution ? { execution } : {}),topic:message.senderId!=='user'?this.topics.reference(message.eventId):undefined,
          ...(['queued','running'].includes(message.status) ? { progress: this.replyProgress.get(message.id) ?? { phase: 'queued' as const } } : {}) };
      }), tasks: [], hasMore: page.hasMore,
      ...(conversationId && this.store.getConversation(conversationId)?.memberIds.includes('user') ? {chatRuntime:this.chatRuntime(conversationId)} : {}),
      runtime: { engine: 'dsh-native', memory: 'vcp-memory', embedding: 'EmbeddingGemma 2 · 内置 768 维', activeLanes: this.scheduler.runningCount,
        ready: this.ready, detail: this.detail, dataRoot: this.options.root } };
  }
  private async controlCompanion(companionId: string, operation: 'start' | 'stop', signal: AbortSignal): Promise<void> {
    const companion = this.store.getCompanion(companionId); if (!companion) throw new Error('伙伴不存在。');
    if (operation === 'start') await this.ensureCompanionBindings([companionId]);
    this.store.setCompanionEnabled(companionId, operation === 'start'); this.changed();
    if (operation === 'stop') for (const row of this.store.taskTransaction(sql => sql.prepare("SELECT id FROM bot_inbox WHERE companion_id=? AND status IN ('queued','running')").all(companionId) as Array<{id:string}>)) {
      const event = this.store.getEvent(row.id); if (event) this.queueNativeStop(event);
      this.scheduler.cancel(row.id);
    }
    try { await this.options.companionRuntime?.(companionId, companion.name, operation, signal); } finally { this.scheduler.wake(); this.changed(); }
  }

  private emit(event: UiEvent): void { try { this.options.onEvent(event); } catch (error) { this.options.report?.(error); } }
  private async ensureCompanionBindings(companionIds: readonly string[]): Promise<void> {
    const ids = [...new Set(companionIds.filter(id => id !== 'user' && !!this.store.getCompanion(id)))];
    if (ids.length) await this.options.ensureCompanionBindings?.(ids);
  }
  private async ensureConversationBindings(conversationId: string, additionalIds: readonly string[] = []): Promise<void> {
    const room = this.store.getConversation(conversationId);
    if (!room) throw new Error('会话不存在。');
    await this.ensureCompanionBindings([...room.memberIds, ...additionalIds]);
  }
  private topicApps(topicId?: string): BotAppId[] {
    if (!topicId) return [];
    const parsed = botAppIdSchema.array().safeParse(JSON.parse(this.store.getMetadata('topic-apps:' + topicId) || '[]'));
    return parsed.success ? parsed.data : [];
  }
  private chatRuntime(conversationId: string) {
    const runtime = this.topics.runtime(conversationId);
    const apps = this.topicApps(runtime.topic?.id);
    const browser = runtime.topic && apps.includes('browser') ? browserPageContextSchema.safeParse(JSON.parse(this.store.getMetadata('topic-browser:' + runtime.topic.id) || 'null')) : undefined;
    return { ...runtime, apps, ...(browser?.success ? { browserContext: browser.data } : {}) };
  }
  private changed(conversationId?: string): void {
    if (this.closed) return;
    this.emit({ type: 'changed', conversationId });
    for (const item of this.store.pendingOutbox()) { this.emit({ type: 'changed', conversationId: item.conversationId }); this.store.acknowledgeOutbox(item.id); }
  }
  private prewarmSelectedMemory(conversationId: string): void {
    if (!this.options.prewarmMemory || this.closed) return;
    const room = this.store.getConversation(conversationId);
    if (!room || room.kind !== 'direct') return;
    const companionId = room.memberIds.find(id => id !== 'user'); if (!companionId) return;
    const scope = { companionId, conversationId, securityDomainId: room.securityDomainId }, key = digest(JSON.stringify([companionId, room.securityDomainId]));
    if (this.memoryWarmRuns.has(key) || this.options.memory.isWarm(scope)) return;
    const run = this.ensureConversationBindings(conversationId).then(() => this.options.memory.warm(scope, phase => {
      if (this.closed) return;
      this.memoryWarmPhases.set(key, phase);
      for (const event of this.store.activeDomainEvents(companionId, room.securityDomainId)) this.replyProgress.set(event.replyMessageId, { phase });
      this.changed(room.id);
    })).catch(error => { if (!this.closed && !['BOT_COMPANION_INSTANCE_REQUIRED', 'BOT_EXECUTION_INSTANCE_REQUIRED'].includes((error as { code?: string })?.code ?? '')) this.options.report?.(error); })
      .finally(() => { this.memoryWarmRuns.delete(key); this.memoryWarmPhases.delete(key); });
    this.memoryWarmRuns.set(key, run);
  }
  isCompanionStopping(companionId: string): boolean {
    return this.store.getCompanion(companionId)?.enabled === false && this.companionControls.has(companionId);
  }
  async handle(input: BotRequest): Promise<BotResponse> {
    await this.starting; if (this.closed) return { ok: false, error: '伙伴正在关闭。' };
    const archivedRoom = 'conversationId' in input && typeof input.conversationId === 'string' ? this.store.getConversation(input.conversationId) : undefined;
    if (archivedRoom?.dissolvedAt) throw new Error('群聊已解散。');
    if (archivedRoom?.kind === 'peer' && !['state','history.search','conversation.peer.join'].includes(input.type)) throw new Error('伙伴私聊仅供旁观。');
    if (input.type.startsWith('memory.maintenance.')) {
      const request = input as BotMemoryMaintenanceRequest, room = this.store.getConversation(request.conversationId);
      if (!room?.memberIds.includes(request.companionId)) throw new Error('当前会话没有这位伙伴。');
      const memory = await this.memoryMaintenance.handle(request, { conversationId: room.id, companionId: request.companionId, securityDomainId: room.securityDomainId });
      this.maintainSafely(); return { ok: true, memory };
    }
    if (input.type === 'execution.answer') {
      const pending = this.questions.get(input.questionId), event = this.store.eventForReply(input.messageId);
      if (!pending || !event || pending.eventId !== event.id || event.status !== 'running') throw new Error('这个问题已结束。');
      this.questions.delete(input.questionId); pending.resolve({ text: input.text }); return { ok: true };
    }
    if (input.type === 'execution.continue') {
      const event = this.store.eventForReply(input.messageId);
      if (event && ['cancelled', 'failed'].includes(event.status)) await this.scheduler.drainEvent(event.id);
      const conversationId=this.store.continueNativeReply(input.messageId,input.requestId);
      this.changed(conversationId);this.scheduler.wake();return {ok:true,conversationId};
    }
    switch (input.type) {
      case 'app.connect': {
        const room = this.store.getConversation(input.conversationId);
        if (!room?.memberIds.includes('user')) throw new Error('不能为这个聊天连接应用。');
        if (!this.options.assetManagerApp) throw new Error('资产管理器应用尚未就绪。');
        let connection;
        for (const actor of room.memberIds.filter(id => id !== 'user').map(id => this.store.getCompanion(id)).filter(actor => actor && actor.enabled !== false)) {
          connection = await this.options.assetManagerApp.connect({ companionId: actor!.id, companionName: actor!.name, conversationId: room.id }, this.maintenanceAbort.signal);
        }
        if (!connection) throw new Error('请先选择一个启用的伙伴。');
        return { ok: true, app: connection };
      }
      case 'app.detach': {
        this.topics.get(input.topicId, input.conversationId);
        if (!this.store.getConversation(input.conversationId)?.memberIds.includes('user')) throw Error('不能修改这个话题的应用。');
        this.store.setMetadata('topic-apps:' + input.topicId, JSON.stringify(this.topicApps(input.topicId).filter(id => id !== input.appId)));
        if (input.appId === 'browser') this.store.setMetadata('topic-browser:' + input.topicId, '');
        const active = this.topics.runtime(input.conversationId).running.filter(item => item.topicId === input.topicId);
        await Promise.all(active.map(async item => {
          const event = this.store.eventForReply(item.messageId), actor = this.store.getCompanion(item.companionId);
          if (!event || !actor || !this.options.brain.revokeApplications) return;
          const system = buildNativeBotContext({ companion: actor, event, apps: this.topicApps(input.topicId), memories: '', files: [], conversation: this.store.getConversation(input.conversationId)!, companions: this.store.listCompanions() }).system;
          try { await this.options.brain.revokeApplications(this.topics.lane(event), [input.appId === 'browser' ? 'browser' : 'asset_manager'], system); }
          catch (error) { this.options.report?.(error); } // Local authorization was already revoked; the next admission reconciles native declarations.
        })); this.changed(input.conversationId);
        return { ok: true };
      }
      case 'topic.list': { const result=this.topics.list(input.conversationId,input.query,input.before,input.mode);return {ok:true,topics:result.items,nextTopicCursor:result.next}; }
      case 'topic.flags':{const topic=this.topics.flags(input.conversationId,input.topicId,input);this.changed(input.conversationId);return{ok:true,topic};}
      case 'topic.rename':{const topic=this.topics.rename(input.conversationId,input.topicId,input.title,input.requestId);this.maintainSafely();this.changed(input.conversationId);return{ok:true,topic};}
      case 'topic.new': { const topic=this.topics.create(input.conversationId,input.requestId);this.changed(input.conversationId);return {ok:true,topic}; }
      case 'topic.select': { const topic=this.topics.select(input.conversationId,input.topicId);this.changed(input.conversationId);return {ok:true,topic}; }
      case 'topic.context': return this.topicContext(input);
      case 'topic.compact': {
        const event=this.topics.topicEvent(input.topicId,input.conversationId,input.companionId);
        if(this.topics.runtime(input.conversationId).running.length)throw Error('请等待当前任务完成后压缩话题；执行中的补充可使用引导。');
        if(!this.options.brain.compact)throw Error('当前 DSH 连接不支持原生压缩。');
        const saved=this.store.getMetadata('native-input:'+event.id);if(!saved)throw Error('话题的原生绑定资料不存在。');
        const context=JSON.parse(saved) as {system:string},room=this.store.getConversation(event.conversationId)!;
        let compacted:boolean;
        try{compacted=await this.options.brain.compact({laneId:this.topics.lane(event),eventId:event.id,cwd:this.workspace(event.companionId),system:context.system,
          model:this.options.model(),callback:await this.toolServer.start(),tools:[],workerTools:BOT_TOOLS,role:'worker',workerAccess:'full',
          audience:{conversationId:room.id,kind:room.kind,allowedConversationIds:[room.id]}},input.requestId);}
        catch(error){if((error as {code?:string})?.code==='BOT_COMPACTION_FAILED')return{ok:false,error:errorText(error),compactionSettled:true};throw error;}
        await this.topicContext({type:'topic.context',conversationId:input.conversationId,topicId:input.topicId,companionId:input.companionId});
        this.changed(input.conversationId);return {ok:true,compacted};
      }
      case 'message.guide': { await this.guideQueued(input.conversationId,input.messageId);return {ok:true}; }
      case 'message.dequeue': this.topics.cancelQueued(input.conversationId,input.messageId);this.changed(input.conversationId);return {ok:true};
      case 'state': return { ok: true, snapshot: this.snapshot(input.conversationId, input.before) };
      case 'history.search': return { ok: true, history: this.store.searchMessages(input.conversationId, input) };
      case 'companion.create': {
        const companion = this.store.createCompanion({ name: input.name, persona: input.persona.trim() || '作为真诚可靠的长期伙伴与用户相处。', workerConcurrency: input.workerConcurrency });
        const conversation = this.store.openDirect(companion.id); this.changed(); return { ok: true, conversationId: conversation.id };
      }
      case 'companion.update': this.store.updateCompanion(input.companionId, { name: input.name, persona: input.persona === undefined ? undefined : input.persona.trim() || '作为真诚可靠的长期伙伴与用户相处。', workerConcurrency: input.workerConcurrency }); this.changed(); if (input.workerConcurrency !== undefined) this.maintainSafely(); return { ok: true };
      case 'companion.runtime': {
        const revision = (this.companionControlRevisions.get(input.companionId) ?? 0) + 1;
        this.companionControlRevisions.set(input.companionId, revision);
        const controller = new AbortController(), waiters = this.companionStartWaiters.get(input.companionId) ?? new Set<AbortController>();
        if (input.operation === 'stop') {
          this.store.setCompanionEnabled(input.companionId, false); this.changed();
          for (const waiting of waiters) waiting.abort(new Error('用户已关闭伙伴，停止等待启动。'));
        } else { waiters.add(controller); this.companionStartWaiters.set(input.companionId, waiters); }
        const prior = this.companionControls.get(input.companionId);
        const operation = (prior ?? Promise.resolve()).catch(() => undefined).then(() => {
          if (input.operation === 'start' && this.companionControlRevisions.get(input.companionId) !== revision) return;
          return this.controlCompanion(input.companionId, input.operation, AbortSignal.any([this.maintenanceAbort.signal, controller.signal]));
        });
        this.companionControls.set(input.companionId, operation);
        try { await operation; } finally {
          waiters.delete(controller); if (!waiters.size) this.companionStartWaiters.delete(input.companionId);
          if (this.companionControls.get(input.companionId) === operation) this.companionControls.delete(input.companionId);
        }
        return { ok: true, snapshot: this.snapshot() };
      }
      case 'companion.personas.list': return { ok: true, personas: this.store.listPersonaTemplates(input.companionId) };
      case 'companion.personas.get': return { ok: true, persona: this.store.getPersonaTemplate(input.companionId, input.id) };
      case 'companion.personas.save': {
        const persona = this.store.savePersonaTemplate(input.companionId, input); this.changed();
        return { ok: true, persona, personas: this.store.listPersonaTemplates(input.companionId) };
      }
      case 'companion.personas.activate': {
        const persona = this.store.activatePersonaTemplate(input.companionId, input.id); this.changed();
        return { ok: true, persona, personas: this.store.listPersonaTemplates(input.companionId) };
      }
      case 'companion.personas.delete': this.store.deletePersonaTemplate(input.companionId, input.id); this.changed(); return { ok: true, personas: this.store.listPersonaTemplates(input.companionId) };
      case 'companion.personas.restore': {
        const persona = this.store.restorePersonaTemplates(input.companionId, input.id); this.changed();
        return { ok: true, persona, personas: this.store.listPersonaTemplates(input.companionId) };
      }
      case 'conversation.open': { const conversation = this.store.openDirect(input.companionId); this.prewarmSelectedMemory(conversation.id); this.changed(conversation.id); return { ok: true, conversationId: conversation.id }; }
      case 'conversation.peer.open': { const conversation = this.store.openPeer(...input.memberIds); this.changed(conversation.id); return { ok: true, conversationId: conversation.id }; }
      case 'conversation.peer.join': {
        if (archivedRoom?.kind !== 'peer' || archivedRoom.userRole !== 'observer' || archivedRoom.memberIds.length !== 2) throw new Error('请选择有效的双方伙伴私聊。');
        const conversation = this.store.createGroup({ title: input.title ?? `${archivedRoom.title} · 群聊`, memberIds: archivedRoom.memberIds, participationMode: 'automatic' });
        this.changed(conversation.id); return { ok: true, conversationId: conversation.id };
      }
      case 'conversation.create': { const conversation = this.store.createGroup({ title: input.title, kind: input.kind, memberIds: input.memberIds, participationMode: input.participationMode, reuseMembers: false }); this.changed(conversation.id); return { ok: true, conversationId: conversation.id }; }
      case 'conversation.policy': this.store.setConversationPolicy(input.conversationId, input.participationMode); this.changed(input.conversationId); return { ok: true };
      case 'conversation.announcement': {
        this.store.setGroupAnnouncement({ ...input, actorId: 'user' }); this.changed(input.conversationId);
        return { ok: true, conversationId: input.conversationId };
      }
      case 'conversation.members':case 'conversation.dissolve':{
        const previous=this.store.getConversation(input.conversationId);
        const change=input.type==='conversation.members'?this.store.updateMembers(input.conversationId,input.memberIds):this.store.dissolveConversation(input.conversationId);
        for(const eventId of change.eventIds) { const event = this.store.getEvent(eventId); if (event) this.queueNativeStop(event); this.scheduler.cancel(eventId); }
        if(change.conversation.revision!==previous?.revision||change.conversation.dissolvedAt!==previous?.dissolvedAt)this.invalidateConversationDerived(input.conversationId);
        this.maintainSafely();this.changed(input.conversationId);return{ok:true,conversationId:input.conversationId};
      }
      case 'message.send': case 'world.event': {
        const conversation = this.store.getConversation(input.conversationId);
        if (!conversation?.memberIds.includes('user')) throw new Error('当前用户不能向这个会话发送消息。');
        if (!conversation.memberIds.some(id => id !== 'user' && this.store.getCompanion(id)?.enabled !== false)) throw new Error('伙伴已关闭，请先启用伙伴；消息草稿已保留。');
        await this.ensureConversationBindings(input.conversationId);
        let attachments = input.type === 'message.send' && input.attachmentIds?.length ? await this.requireMedia().resolveForConversation(input.conversationId, input.attachmentIds) : undefined;
        if (attachments && this.options.transcribeAttachments) attachments = await this.options.transcribeAttachments(input.conversationId, attachments, input.requestId);
        if (!this.store.getConversation(input.conversationId)?.memberIds.includes('user')) throw Error('聊天权限已变化，已停止发送。');
        if (attachments) await this.ensureConversationBindings(input.conversationId); // File I/O may outlive a group membership or binding change.
        if (input.type === 'message.send' && !this.store.ingressExists(input.conversationId, input.requestId)) for (const id of this.store.interruptGroup(input.conversationId, isGroupStop(input.content))) this.scheduler.cancel(id);
        const running=input.type==='message.send'&&this.topics.runtime(input.conversationId).running.length>0;
        const browserKey = 'browser-context-ingress:' + input.conversationId + ':' + input.requestId;
        const previousBrowser = input.type === 'message.send' && this.store.ingressExists(input.conversationId, input.requestId) ? this.store.getMetadata(browserKey) : undefined;
        const browserContext = input.type === 'message.send' && input.browserContextId ? previousBrowser ? browserPageContextSchema.parse(JSON.parse(previousBrowser)) : this.options.resolveBrowserContext?.(input.browserContextId) : undefined;
        if (input.type === 'message.send' && input.browserContextId && !browserContext) throw Error('内置浏览器连接不可用，请重新附加网页。');
        if (browserContext && input.type === 'message.send' && browserContext.referenceId !== input.browserContextId) throw Error('同一发送请求不能更换网页上下文。');
        const appIngressKey = 'app-ingress:' + input.conversationId + ':' + input.requestId;
        const selectedApps = input.type === 'message.send' ? [...new Set([...(input.apps ?? []), ...(browserContext ? ['browser' as const] : [])])].sort() : [];
        const previousApps = this.store.getMetadata(appIngressKey);
        if (previousApps && previousApps !== JSON.stringify(selectedApps)) throw Error('同一发送请求不能更换已附加的应用，请重新发送。');
        const result = this.store.taskTransaction(()=>{
        const result = this.store.enqueue({ conversationId: input.conversationId, senderId: input.type === 'world.event' ? 'world' : 'user',
          source: input.type === 'world.event' ? 'world' : 'user', sourceMessageId: input.requestId, content: input.content,
          payload:input.type==='message.send'?{topicId:input.topicId??null,newTopic:input.newTopic??false,delivery:input.delivery??'queue',userQueued:true,...(browserContext ? { browserContext } : {}), ...(input.apps?.length ? { apps: input.apps } : {})}:undefined,
          attachments, kind: input.type === 'world.event' ? 'world_observation' : 'message' });
        if (input.type === 'message.send') { this.store.setMetadata(appIngressKey, JSON.stringify(selectedApps)); if (selectedApps.length) this.store.setMetadata('message-apps:' + result.message.id, JSON.stringify(selectedApps)); }
        if (browserContext) { this.store.setMetadata('browser-context:' + result.message.id, JSON.stringify(browserContext)); this.store.setMetadata(browserKey, JSON.stringify(browserContext)); }
        if(input.type==='message.send'&&!this.store.getMetadata('native-topic-ingress:'+input.conversationId+':'+input.requestId)){
          const topic=input.topicId?this.topics.get(input.topicId,input.conversationId):(!input.newTopic&&!running?this.topics.current(input.conversationId):undefined)
            ??this.topics.create(input.conversationId,input.requestId,input.content,!running);
          this.topics.bind(result.events,topic);
          const apps = selectedApps;
          this.store.setMetadata('topic-apps:' + topic.id, JSON.stringify(apps));
          this.store.setMetadata('topic-browser:' + topic.id, browserContext ? JSON.stringify(browserContext) : '');
          this.store.setMetadata('native-topic-ingress:'+input.conversationId+':'+input.requestId,topic.id);
        }
        return result;});
        if (input.type === 'message.send') for (const event of result.events) this.memoryMaintenance.userMessage(scopeFor(event), !/^(你好|谢谢|好的|嗯|hi|hello|thanks)[!！。 .]*$/iu.test(input.content.trim()));
        if(input.type==='message.send'&&input.delivery==='steer'&&running)await this.guideQueued(input.conversationId,result.message.id);
        this.scheduler.wake(); this.changed(input.conversationId); return { ok: true, messageId: result.message.id, replyMessageIds: result.events.map(event => event.replyMessageId) };
      }
      case 'world.observe': { const world = this.world.observe(input); this.deliverWorldEvents(); return { ok: true, world }; }
      case 'world.act': {
        await this.ensureConversationBindings(input.conversationId);
        this.deliverWorldEvents();
        const result = this.world.execute(input, input.command, input.effectId);
        this.store.setMetadata(`world:causal-effect:${digest(input.effectId)}`, '');
        this.deliverWorldEvents();
        this.store.setMetadata(`world:causal-actor:${input.companionId}`, '');
        this.changed(input.conversationId); return { ok: true, world: result.snapshot };
      }
      case 'reply.cancel': {
        const event = this.store.eventForReply(input.messageId); if (!event) throw new Error('没有可停止的回复。');
        if (this.store.getConversation(event.conversationId)?.kind === 'peer') throw new Error('用户不能停止旁观私聊中伙伴的回复。');
        if (this.scheduler.interrupt(event.id) && this.store.getMetadata('native-stop:' + event.id)) void this.flushNativeStop(event.id);
        this.changed(event.conversationId); return { ok: true };
      }
      case 'memory.search': case 'memory.remember': case 'memory.inspect': case 'memory.list': case 'memory.forget':
      case 'memory.catalog': case 'memory.note': case 'memory.update': case 'memory.organize': case 'memory.recall': case 'memory.recall.records': {
        const conversation = this.store.getConversation(input.conversationId);
        if (!conversation?.memberIds.includes(input.companionId)) throw new Error('当前会话没有这位伙伴。');
        const scope = { companionId: input.companionId, conversationId: input.conversationId, securityDomainId: conversation.securityDomainId };
        await this.loadTombstones(scope);
        if (input.type === 'memory.catalog') {
          const catalog = await this.options.memory.catalog(scope, { query: input.query, tag: input.tag, cursor: input.cursor, limit: input.limit }) as { total?: number; [key: string]: unknown };
          if (catalog.total === 0 && !input.query?.trim() && !input.tag?.trim() && !input.cursor) {
            if (this.store.enqueueLegacyCaptureBackfill(scope, 2).queued) this.maintainSafely();
          }
          return { ok: true, memory: { ...catalog, activity: this.store.memoryActivity(scope) } };
        }
        if (input.type === 'memory.note') return { ok: true, memory: await this.options.memory.readNote(scope, { id: input.id }) };
        if (input.type === 'memory.recall.records') return { ok: true, memory: { reports: this.store.memoryInspections(scope.companionId, scope.securityDomainId, input.limit) } };
        if (input.type === 'memory.recall') {
          const revision = this.store.memoryInspectionRevision(scope.companionId, scope.securityDomainId);
          if (input.mode === 'history') await this.historyProjector.project(scope);
          const report = await this.options.memory.recall(scope, { query: input.query, mode: input.mode });
          if (revision !== this.store.memoryInspectionRevision(scope.companionId, scope.securityDomainId)) throw new Error('记忆已发生更新或撤回，请重新试查。');
          this.store.recordMemoryInspection(scope.companionId, scope.securityDomainId, report);
          return { ok: true, memory: report };
        }
        if (input.type === 'memory.update' || input.type === 'memory.organize') {
          // Stable across a lost renderer response or a partial organize. A
          // retry of the exact same source versions resumes the original plan.
          const operationId = `manual-${digest(JSON.stringify([scope.companionId, scope.securityDomainId, input.type, input]))}`,
            sourceEventId = `user-memory-${operationId}`;
          const common = { operationId, content: input.content, tags: input.tags?.join(','), sourceEventId };
          const memory = input.type === 'memory.update'
            ? await this.mutateMemory(scope, 'update', { ...common, id: input.id, expectedChecksum: input.expectedChecksum })
            : await this.mutateMemory(scope, 'organize', { ...common, sources: input.sources });
          return { ok: true, memory };
        }
        const write:BotMemoryWrite|undefined=input.type==='memory.remember'?{content:input.content,tags:input.tags?.join(','),sourceEventId:`user-memory-${input.requestId??randomUUID()}`}:undefined;
        const memory = input.type === 'memory.forget' ? await this.forget(scope, input.id)
          : input.type === 'memory.list' ? await this.options.memory.list(scope)
          : input.type === 'memory.search' ? await this.options.memory.tool(scope, 'memory_search', { query: input.query })
          : input.type === 'memory.inspect' ? await this.options.memory.status(scope)
          : await this.options.memory.remember(scope, write!);
        if (write) {
          if ((memory as {state?:string}).state==='pending') this.store.enqueueMemoryJob({key:`index:${write.sourceEventId}`,kind:'mutation',payload:{scope,operation:'remember',input:write}});
          this.memoryMaintenance.activity(scope, `manual:${write.sourceEventId}`); this.maintainSafely();
        }
        return { ok: true, memory };
      }




    }
    throw new Error('未识别的伙伴请求。');
  }
  private async mutateMemory(scope: BotMemoryScope, operation: 'update' | 'organize', input: BotMemoryUpdate | BotMemoryOrganize, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.store.setMetadata(`memory-capture-backfill-v2-suppressed:${digest(JSON.stringify([scope.companionId, scope.securityDomainId]))}`, input.operationId);
    const recover = async (): Promise<Record<string, unknown> | undefined> => {
      const proof = await this.options.memory.operationReceipt(scope, operation, input, signal);
      if (proof.found === false) return;
      const receipt = proof.receipt;
      if (proof.found !== true || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)
        || !['indexed', 'pending', 'partial', 'conflict'].includes(String((receipt as Record<string, unknown>).state))) {
        throw Object.assign(new Error('原记忆操作的结果尚未确认，不能重复写入。'), { code: 'MEMORY_OPERATION_UNKNOWN' });
      }
      return receipt as Record<string, unknown>;
    };
    let result = await recover();
    if (!result) {
      try { result = operation === 'update' ? await this.options.memory.update(scope, input as BotMemoryUpdate, signal)
        : await this.options.memory.organize(scope, input as BotMemoryOrganize, signal); }
      catch (error) { result = await recover(); if (!result) throw error; }
    }
    if (result.state !== 'conflict') this.store.clearMemoryInspections(scope.companionId, scope.securityDomainId);
    if (result.state === 'indexed') this.memoryMaintenance.activity(scope, input.operationId);
    if (result.state === 'pending' || result.state === 'partial') {
      this.store.enqueueMemoryJob({ key: input.operationId, kind: 'mutation', payload: { scope, operation, input } });
      this.maintainSafely();
    }
    return result;
  }
  private memoryMutationInput(event: BotEvent, call: BotToolCall): BotMemoryUpdate | BotMemoryOrganize {
    const args = call.args, common = { operationId: `${event.id}:${call.callId}`, content: nonempty.parse(args.content),
      tags: z.array(z.string().trim().min(1).max(64)).max(12).optional().parse(args.tags)?.join(','),
      sourceEventId: `${event.id}:${call.callId}`, sourceRootEventId: event.id, sourceMessageIds: [event.sourceMessageRecordId, event.replyMessageId] };
    return call.name === 'memory_update' ? { ...common, id: z.string().regex(/^[a-f0-9]{64}$/).parse(args.id),
      expectedChecksum: z.string().regex(/^[a-f0-9]{32}$/).parse(args.expectedChecksum) }
      : { ...common, sources: z.array(z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/), expectedChecksum: z.string().regex(/^[a-f0-9]{32}$/) })).min(2).max(16).parse(args.sources) };
  }
  private contactReceipt(conversationId: string, recipientId: string, destination?: 'user' | 'peer') {
    const room = this.store.getConversation(conversationId);
    // Old receipts describe the old real room even if a caller now supplies a
    // new destination. Recovery must never relabel or redeliver a prior effect.
    const actual = room?.kind === 'peer' ? destination === 'user' ? 'user' : 'peer'
      : destination === 'user' && room?.kind === 'direct' ? 'legacy-user-direct' : 'legacy-group';
    return { sent: true, conversationId, recipientId, destination: actual, conversationKind: room?.kind,
      meaning: actual === 'user' ? '已在双方伙伴私聊中真实转达；目标可用一次宿主授权以本人身份向用户发消息，尚未代表目标回复。'
        : actual === 'peer' ? '已转达到仅双方伙伴参加的私聊；用户可以旁观。真实结果会自动回到你发起委托的原话题，你仍须向原受众交付，当前回执不是完成结果。'
          : actual === 'legacy-user-direct' ? '历史回执确认过去已投递到目标与用户的私聊；本次未重新投递。'
          : '历史回执确认已投递到原伙伴群聊；未重新投递，也未转换原会话。' };
  }
  private memoryMessages(event: BotEvent, through = event.sourceMessageSequence): BotMemoryMessage[] {
    const history = this.store.recentPublishedMessages(event.conversationId, { throughSourceSequence: through, limit: 80, maxChars: DEFAULT_MODEL_CONTEXT_CHARS, companionId: event.companionId });
    const source = this.store.getMessage(event.sourceMessageRecordId);
    if (source && this.store.isMessageVisibleToCompanion(source.id, event.companionId) && !history.some(message => message.id === source.id)) history.push(source);
    const withdrawn = this.store.withdrawnIn(event.companionId, event.securityDomainId, history.map(message => message.id));
    return history.filter(message => !withdrawn.has(message.id)).map(message => ({
      id: message.id, role: message.senderId === event.companionId ? 'assistant' : 'user', content: event.sourceInstanceId === 'peer-return-v1' && message.id === event.sourceMessageRecordId ? event.content : botMessageEvidence(message),
      timestamp: Date.parse(message.createdAt), senderId: message.senderId, senderName: message.senderName,
    }));
  }
  private async loadTombstones(scope: BotMemoryScope, currentEventId?: string, onPhase?: (phase: 'memory-starting' | 'memory-verifying' | 'memory-indexing' | 'recalling-memory') => void): Promise<void> {
    const key = digest(JSON.stringify([scope.companionId, scope.securityDomainId]));
    if (this.loadedTombstones.has(key)) return;
    const sources = await this.options.memory.withdrawnSources(scope, onPhase);
    this.maintenanceAbort.signal.throwIfAborted();
    this.applyWithdrawal(scope, sources, currentEventId);
    await this.syncSourceWithdrawals(scope, currentEventId);
    if (this.loadedTombstones.size >= 128) this.loadedTombstones.delete(this.loadedTombstones.keys().next().value!);
    this.loadedTombstones.set(key, true);
  }
  private async syncSourceWithdrawals(scope: BotMemoryScope, currentEventId?: string): Promise<void> {
    const key = digest(JSON.stringify([scope.companionId, scope.securityDomainId])), previous = this.sourceWithdrawalRuns.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.flushSourceWithdrawals(scope, currentEventId));
    this.sourceWithdrawalRuns.set(key, operation);
    try { await operation; } finally { if (this.sourceWithdrawalRuns.get(key) === operation) this.sourceWithdrawalRuns.delete(key); }
  }
  private async flushSourceWithdrawals(scope: BotMemoryScope, currentEventId?: string): Promise<void> {
    const cursorKey = `native-withdrawal-cursor:${digest(JSON.stringify([scope.companionId, scope.securityDomainId]))}`;
    let after = Number(this.store.getMetadata(cursorKey) ?? 0);
    while (true) {
      const page = this.store.withdrawnMessagesPage(scope, { after, limit: 80 });
      if (page.items.length) {
        let revision = '0';
        // Targeted legacy task-notice corrections must not recursively revoke
        // public messages which happened to share one VCP note. A page may
        // also contain ordinary user withdrawals; keep their full semantics.
        for (const exactPrivateNotice of [true, false]) {
          const items = page.items.filter(item => (item.exactPrivateNotice === true) === exactPrivateNotice);
          if (!items.length) continue;
          const receipt = await this.options.memory.withdrawSources(scope, {
            sourceEventIds: [...new Set(items.flatMap(item => item.eventIds))], sourceMessageIds: items.map(item => item.messageId),
            ...(exactPrivateNotice ? { mode: 'isolated-task-notices' as const } : {}),
          }, this.maintenanceAbort.signal);
          this.applyWithdrawal(scope, receipt, currentEventId); revision = receipt.revision;
        }
        after = page.items.at(-1)!.sequence;
        this.store.setMetadataBatch([{ key: `withdrawal-revision:${digest(JSON.stringify([scope.companionId, scope.securityDomainId]))}`, value: revision }, { key: cursorKey, value: String(after) }]);
      }
      if (!page.items.length) return;
    }
  }
  private applyWithdrawal(scope: BotMemoryScope, sources: { revision?: string; sourceEventIds: string[]; sourceMessageIds: string[] }, currentEventId?: string): void {
    const key = `withdrawal-revision:${digest(JSON.stringify([scope.companionId, scope.securityDomainId]))}`;
    const previousEvents = this.store.activeDomainEvents(scope.companionId, scope.securityDomainId);
    const revisionChanged = sources.revision !== undefined && sources.revision !== '0' && this.store.getMetadata(key) !== sources.revision;
    const changed = this.store.withdrawSources(scope.companionId, scope.securityDomainId, [...sources.sourceEventIds, ...sources.sourceMessageIds]);
    if (!changed && revisionChanged) this.store.rotateDomain(scope.companionId, scope.securityDomainId);
    if (sources.revision !== undefined) this.store.setMetadata(key, sources.revision);
    if (changed || revisionChanged) {
      this.loadedTombstones.delete(digest(JSON.stringify([scope.companionId, scope.securityDomainId])));
      this.memoryMaintenance.invalidate(scope);
      this.store.clearMemoryInspections(scope.companionId, scope.securityDomainId);
      for (const active of previousEvents) if (active.id !== currentEventId || active.dshEventId) {
        this.queueNativeStop(active);
        this.store.cancelEvent(active.id, true); this.scheduler.cancel(active.id);
      }
      for (const target of this.store.peerWithdrawalTargets(scope.companionId, scope.securityDomainId)) {
        const room = this.store.getConversation(target.conversationId); if (!room) continue;
        for (const companionId of room.memberIds.filter(id => id !== 'user')) {
          const targetScope = { conversationId: room.id, companionId, securityDomainId: room.securityDomainId };
          this.applyWithdrawal(targetScope, { sourceEventIds: [], sourceMessageIds: [target.messageId] });
          void this.syncSourceWithdrawals(targetScope).catch(error => this.options.report?.(error));
        }
      }
    }
  }
  private async forget(scope: BotMemoryScope, id: string, currentEventId?: string): Promise<BotMemoryForget> {
    await this.memoryMaintenance.abortScope(scope);
    this.store.setMetadata(`memory-capture-backfill-v2-suppressed:${digest(JSON.stringify([scope.companionId, scope.securityDomainId]))}`, `forget:${id}`);
    this.store.clearMemoryInspections(scope.companionId, scope.securityDomainId);
    this.loadedTombstones.delete(digest(JSON.stringify([scope.companionId, scope.securityDomainId])));
    try {
      const result = await this.options.memory.forget(scope, { id });
      this.applyWithdrawal(scope, result, currentEventId); await this.syncSourceWithdrawals(scope, currentEventId); return result;
    } catch (error) {
      // VCP may have committed its tombstone before cleanup failed. Never let
      // an old cached revision make that unknown outcome look like no change.
      try { this.applyWithdrawal(scope, await this.options.memory.withdrawnSources(scope), currentEventId); await this.syncSourceWithdrawals(scope, currentEventId); }
      catch (recoveryError) {
        this.options.report?.(recoveryError); this.store.rotateDomain(scope.companionId, scope.securityDomainId);
        for (const active of this.store.activeDomainEvents(scope.companionId, scope.securityDomainId)) { this.store.cancelEvent(active.id, true); this.scheduler.cancel(active.id); }
      }
      throw error;
    } finally {
      this.loadedTombstones.delete(digest(JSON.stringify([scope.companionId, scope.securityDomainId])));
      this.changed(scope.conversationId); this.maintainSafely();
    }
  }
  private responseJob(event: BotEvent, prepared: BotMemoryPrepared, text: string, completed: boolean): BotMemoryJobInput {
    return { key: `response:${event.id}`, kind: 'response', payload: { scope: scopeFor(event), prepared, text, completed } };
  }
  private async guideQueued(conversationId:string,messageId:string):Promise<void>{
    const rows=this.store.taskTransaction(sql=>sql.prepare('SELECT id FROM bot_inbox WHERE conversation_id=? AND source_record_id=?').all(conversationId,messageId)) as Array<{id:string}>;
    const texts=new Map<string,string>();
    for(const row of rows){const event=this.store.getEvent(row.id)!;texts.set(event.id,JSON.stringify({message:{id:messageId,senderId:'user',content:event.content},browserContext:event.payload.browserContext,files:await this.verifiedAttachmentFiles(event)}));}
    const commands=this.topics.reserveGuidance(conversationId,messageId,texts);
    this.changed(conversationId);await Promise.all(commands.filter(command=>command.status!=='accepted').map(command=>this.flushGuidance(command)));
  }
  private flushGuidance(command:BotGuidance):Promise<void>{
    const key=command.message_id+':'+command.event_id,prior=this.guidanceRuns.get(key);if(prior)return prior;
    const operation=(async()=>{
      const event=this.store.getEvent(command.event_id);if(!event)return;
      try{
        await this.options.brain.send(this.topics.lane(event),{eventId:event.id,cwd:this.workspace(event.companionId),messageId:command.message_id,text:command.text,mode:'steer'});
        if(!this.closed)this.topics.guidanceResult(command);
      }catch(error){if(!this.closed){if((error as {code?:string})?.code==='BOT_GUIDANCE_NOT_ACCEPTED'){this.topics.guidanceNotAccepted(command);this.scheduler.wake();}else this.topics.guidanceResult(command,errorText(error));}}
      if(!this.closed)this.changed(command.conversation_id);
    })().finally(()=>this.guidanceRuns.delete(key));this.guidanceRuns.set(key,operation);return operation;
  }
  private flushTitle(job:BotTopicTitleSync):Promise<void>{
    const prior=this.titleRuns.get(job.native_lane_id);if(prior)return prior;
    const operation=(async()=>{try{
      if(!this.options.brain.renameTopic)throw Error('当前 DSH 桥接器不支持话题名称同步。');
      await this.options.brain.renameTopic(job.native_lane_id,{title:job.title,revision:job.revision,cwd:this.workspace(job.companion_id)});
      if(!this.closed)this.topics.titleResult(job);
    }catch(error){if(!this.closed)this.topics.titleResult(job,errorText(error));}
    if(!this.closed)this.changed(job.conversation_id);
    })().finally(()=>this.titleRuns.delete(job.native_lane_id));this.titleRuns.set(job.native_lane_id,operation);return operation;
  }
  private async respond(claim: BotClaim, signal: AbortSignal): Promise<void> {
    const event = claim.event, companion = this.store.getCompanion(event.companionId);
    if (!companion || companion.enabled === false) { this.scheduler.cancel(event.id); return; }
    let nativeLaneId = this.topics.lane(event);
    const cwd = this.workspace(companion.id);
    let prepared: BotMemoryPrepared | undefined, text = '';
    let lastDraftAt = 0, firstTextRecorded = false;
    let artifactProjection = Promise.resolve();
    const delivered = new Set<string>(),deliveredPaths=new Set<string>();
    const projectArtifacts = (files: readonly {path:string}[],part?:{id:string;sequence:number}) => {
      const pending = files.filter(file => part?!delivered.has(part.id+':'+file.path):!deliveredPaths.has(file.path));
      for (const file of pending){delivered.add((part?.id??'fallback')+':'+file.path);deliveredPaths.add(file.path);}
      if (!pending.length) return;
      artifactProjection = artifactProjection.then(async () => {
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        const attachments = await this.requireMedia().importFiles({ conversationId: event.conversationId, paths: pending.map(file => file.path) });
        signal.throwIfAborted();
        if (!this.closed) { this.store.appendNativeArtifacts(event.id, claim.leaseToken, attachments);this.store.appendReplyPart(event.id,{id:part?.id??'fallback-files',sequence:part?.sequence,kind:'media',attachments}); this.changed(event.conversationId); }
      });
      void artifactProjection.catch(() => undefined);
    };
    const progress = (value: BotReplyProgress) => { if (!this.closed) { this.replyProgress.set(event.replyMessageId, value); this.changed(event.conversationId); } };
    const persistKey = 'native-input:' + event.id;
    try {
      this.topics.started(event);nativeLaneId=this.topics.lane(event);
      await this.ensureConversationBindings(event.conversationId); signal.throwIfAborted();
      if (event.payload.groupAttention === true) this.store.promoteGroupReply(event.id, claim.leaseToken);
      await mkdir(cwd, { recursive: true });
      progress({ phase: 'recalling-memory' });
      await this.loadTombstones(scopeFor(event), event.id);
      this.topics.refreshBeforeDispatch(event);nativeLaneId=this.topics.lane(event);
      this.store.bindEventNativeEpoch(event.id, this.store.getLane(event.laneId)!.epoch);
      this.topics.assertCurrent(event);
      if (this.store.getMetadata('native-interrupted:' + event.id) === '1' && this.store.nativeReplySuperseded(event)) throw Error('这个话题已有后续进展，请接着最新的回复继续。');
      // Freeze VCP's source input independently of the chat's later publications.
      // A crash between VCP preparation and the marker can safely re-prepare the
      // exact original input; once marked, resume the authoritative VCP record.
      const memoryInputKey = 'native-memory-input:' + event.id, preparedKey = 'native-memory-prepared:' + event.id;
      const frozenMessages = this.store.getMetadata(memoryInputKey);
      const messages: BotMemoryMessage[] = frozenMessages ? JSON.parse(frozenMessages) : this.memoryMessages(event);
      if (!frozenMessages) this.store.setMetadata(memoryInputKey, JSON.stringify(messages));
      await this.historyProjector.project(scopeFor(event), signal);
      prepared = this.store.getMetadata(preparedKey)
        ? await this.options.memory.resumePrepared({ scope: scopeFor(event), requestId: event.id, signal })
        : await this.options.memory.prepareTurn({ scope: scopeFor(event), requestId: event.id, messages, query: event.content, signal,
          onPhase: phase => progress({ phase }) });
      this.store.setMetadata(preparedKey, '1');
      signal.throwIfAborted();
      const frozen = this.store.getMetadata(persistKey);
      const context = frozen ? JSON.parse(frozen) as {system:string;prompt:string} : buildNativeBotContext({ companion, event,
        memories: prepared.evidence, files: await this.verifiedAttachmentFiles(event, this.topics.inputAttachmentIds(event), undefined, signal),
        apps: this.topicApps(this.topics.reference(event.id)?.id), conversation: this.store.getConversation(event.conversationId)!, companions: this.store.listCompanions() });
      if (frozen) {
        const apps = this.topicApps(this.topics.reference(event.id)?.id);
        const refreshed = buildNativeBotContext({ companion, event, apps, memories: prepared.evidence, files: [], conversation: this.store.getConversation(event.conversationId)!, companions: this.store.listCompanions() });
        context.system = refreshed.system;
        const envelope = JSON.parse(context.prompt) as Record<string, unknown>;
        const identities = JSON.parse(refreshed.prompt) as Record<string, unknown>;
        for (const key of ['identity','delivery','room','message','peerContact']) if (identities[key] !== undefined) envelope[key] = identities[key];
        if (!apps.includes('browser')) delete envelope.browserContext;
        if (apps.length) envelope.apps = apps; else delete envelope.apps;
        context.prompt = JSON.stringify(envelope);
      }
      if (!frozen) this.store.setMetadata(persistKey, JSON.stringify(context));
      this.updateExecution(event, { status: 'running', sessionId: BotDshBrain.sessionId(nativeLaneId), interruption: undefined });
      progress({ phase: 'waiting-model' });
      const callback = await this.toolServer.forWorker(nativeLaneId, event.id);
      const room = this.store.getConversation(event.conversationId)!;
      const allowedConversationIds = room.kind === 'direct' && room.memberIds.includes('user')
        ? this.store.conversations().filter(candidate => !candidate.dissolvedAt && candidate.memberIds.includes(event.companionId)
          && (candidate.memberIds.includes('user') || candidate.kind === 'peer' && candidate.userRole === 'observer')).map(candidate => candidate.id)
        : [room.id];
      const result = await this.options.brain.run({ laneId: nativeLaneId, eventId: event.id, cwd, system: context.system, prompt: context.prompt,
        resumeHost: this.store.getMetadata('native-interrupted:' + event.id) === '1',
        continueAfterSeq: (()=>{const saved=this.store.getMetadata('native-output-continuation:'+event.id);return saved?(JSON.parse(saved) as {checkpoint:number}).checkpoint:undefined;})(),
        model: this.options.model(), tools: [], workerTools: botToolsForApps(this.topicApps(this.topics.reference(event.id)?.id)), callback, signal, role: 'worker', workerAccess: 'full',
        audience: { conversationId: room.id, kind: room.kind, allowedConversationIds },
        workspaceTitle: companion.name, sessionTitle:this.topics.reference(event.id)?.title??Array.from(event.content).slice(0, 60).join(''),
        onEvent: update => {
          if (this.closed || signal.aborted) return;
          if(update.type==='context'){
            const parsed=botNativeContextSchema.safeParse(update.context);
            if(parsed.success&&parsed.data.sessionId===BotDshBrain.sessionId(nativeLaneId)&&this.topics.rememberContext(event.conversationId,nativeLaneId,parsed.data))this.changed(event.conversationId);
            return;
          }
          this.store.markDispatched(event.id, claim.leaseToken, event.id);
          if (update.type === 'artifacts' && update.artifacts?.length) projectArtifacts(update.artifacts,Number.isSafeInteger(update.nativeSequence)?{id:update.nativeSessionId===BotDshBrain.sessionId(nativeLaneId)?'native-files-'+update.nativeSequence:'child-files-'+update.nativeSessionId+'-'+update.nativeSequence,sequence:update.rootSequence??update.nativeSequence!}:undefined);
          if (['text_stream','text'].includes(update.type) && typeof update.text === 'string') {
            text = update.text;
            if(update.type==='text'&&text.trim()&&Number.isSafeInteger(update.nativeSequence))this.store.appendReplyPart(event.id,{id:'native-text-'+update.nativeSequence,sequence:update.nativeSequence,kind:'text',text});
            if (text && !firstTextRecorded) { firstTextRecorded = true; this.store.recordTurnTiming(event.id, claim.leaseToken, { firstTextAt: Date.now() }); }
            const phaseChanged = this.replyProgress.get(event.replyMessageId)?.phase !== 'generating';
            if (phaseChanged || Date.now() - lastDraftAt >= 700) { lastDraftAt = Date.now(); this.store.updateDraft(event.id, claim.leaseToken, text); }
            if (phaseChanged) progress({ phase: 'generating' });
            this.emit({ type: 'text', conversationId: event.conversationId, messageId: event.replyMessageId, text });
          } else if (update.type !== 'complete') {
            if (text) this.store.updateDraft(event.id, claim.leaseToken, text);
            const key = 'execution:' + event.replyMessageId;
            const execution: BotExecution = JSON.parse(this.store.getMetadata(key)!);
            const step = { id: (update.streamGeneration ? update.streamGeneration + ':' : '') + String(update.sequence ?? execution.steps.length), type: update.type, at: new Date().toISOString(),
              text: update.type === 'reasoning' ? update.text : update.text?.slice(0, 16000), summary: update.summary?.slice(0, 2000), toolName: update.toolName, status: update.status,
              sequence: update.sequence, stage: update.stage, streamId: update.streamId, callId: update.callId, textMode: update.textMode,
              outputState: update.outputState, nativeSessionId: update.nativeSessionId, nativeTurn: update.nativeTurn, nativeStep: update.nativeStep };
            Object.assign(step,{streamGeneration:update.streamGeneration,updatedAt:update.receivedAt});
            execution.steps = appendBotExecutionStep(execution.steps, step);
            this.updateExecution(event, execution);
            const phase = update.type === 'context_compacting' || update.stage === 'compaction_start' ? 'compacting-context'
              : update.type === 'tool_call' || update.type === 'tool_reconciling' ? 'using-tool'
              : update.type === 'tool_result' ? 'preparing-context' : 'waiting-model';
            progress({ phase, toolName: update.toolName });
          }
        } });
      if(typeof result.inputContextCommitted==='boolean'||result.status==='succeeded')this.topics.recordInputFiles(event,context.prompt,result.inputContextCommitted??true);
      text = result.text;
      for(const output of result.outputs??[]){if(output.text?.trim())this.store.appendReplyPart(event.id,{id:output.id,sequence:output.sequence,kind:'text',text:output.text});if(output.files?.length)projectArtifacts(output.files,output);}
      await Promise.allSettled([...this.guidanceRuns].filter(([key])=>key.endsWith(':'+event.id)).map(([,operation])=>operation));
      if (result.artifacts?.length) projectArtifacts(result.artifacts);
      await artifactProjection; signal.throwIfAborted();
      if(text.trim()&&!result.outputs&&!this.store.replyParts(event.replyMessageId).some(part=>part.kind==='text'))this.store.appendReplyPart(event.id,{id:'legacy-final-text',kind:'text',text});
      const visibleParts=botReplyDisplayParts(this.store.replyParts(event.replyMessageId));if(visibleParts.length)text=visibleParts.flatMap(part=>part.text?[part.text]:[]).join('\n\n');
      this.topics.touch(event);
      this.updateExecution(event, { status: result.status, question: undefined, continuation: undefined, interruption: undefined });
      // The searchable/history summary stays bounded; immutable native parts
      // retain the complete visible answer, including very long multi-step work.
      this.store.settle({ eventId: event.id, leaseToken: claim.leaseToken, status: result.status === 'succeeded' ? 'done' : result.status === 'cancelled' ? 'cancelled' : 'failed', content: text.slice(0,512000), dshEventId: event.id,
        memoryJobs: [this.responseJob(event, prepared, text, result.status === 'succeeded'),
          { key: 'history-completed:' + event.id, kind: 'projection', payload: { scope: scopeFor(event) } },
          ...(result.status === 'succeeded' && ['user', 'companion', 'group', 'gateway'].includes(event.source) && this.store.getMetadata('skipCapture:' + event.id) !== 'true'
          ? [{ key: `capture:v${BOT_MEMORY_CAPTURE_POLICY}:` + event.id, kind: 'capture' as const, payload: { scope: scopeFor(event), sourceEventId: event.id, policyVersion: BOT_MEMORY_CAPTURE_POLICY,
              messages: [...messages.filter(message => message.id === event.sourceMessageRecordId),...this.topics.guidanceMessages(event.id).flatMap(id=>{const message=this.store.getMessage(id);return message?[{id:message.id,role:'user' as const,content:botMessageEvidence(message),timestamp:Date.parse(message.createdAt),senderId:message.senderId,senderName:message.senderName}]:[];})], answer: text, answerMessageId: event.replyMessageId,
              completed: true, capturedAt: new Date().toISOString(), nativeDeliveries: result.artifacts ?? [] } }] : [])] });
      if (result.status === 'succeeded') { this.store.observeGroupReply(event.id); this.scheduler.wake(); }
      this.ready = true; this.detail = undefined;
    } catch (error) {
      if (this.closed) return;
      const code = (error as {code?:string})?.code;
      const committed=(error as {inputContextCommitted?:boolean;result?:BotDshResult})?.inputContextCommitted??(error as {result?:BotDshResult})?.result?.inputContextCommitted;
      if(typeof committed==='boolean'){const saved=this.store.getMetadata(persistKey);if(saved)this.topics.recordInputFiles(event,(JSON.parse(saved) as {prompt:string}).prompt,committed);}
      // A user interruption retains the prepared VCP turn and its native
      // receipts. Only successful continuation commits the response/diary.
      if (signal.aborted && (signal.reason as { code?: string })?.code === 'BOT_SUSPEND') return;
      // Reattach to this exact event/session after transport loss; never create a replacement turn.
      if (!signal.aborted && ['BOT_DELIVERY_UNKNOWN','BOT_LANE_BUSY','MEMORY_CAPACITY'].includes(code ?? '')) {
        if (code === 'BOT_DELIVERY_UNKNOWN') this.store.markDispatched(event.id, claim.leaseToken, event.id);
        this.store.requeue(event.id, claim.leaseToken, event.attempts * 1000); return;
      }
      // A terminal failure can still contain an answer or files delivered
      // before the failing step. Reconcile cached receipts after reconnect too.
      const partial=(error as {result?:BotDshResult})?.result;
      if(!signal.aborted){
        for(const output of partial?.outputs??[]){if(output.text?.trim())this.store.appendReplyPart(event.id,{id:output.id,sequence:output.sequence,kind:'text',text:output.text});if(output.files?.length)projectArtifacts(output.files,output);}
        if(partial?.artifacts?.length)projectArtifacts(partial.artifacts);
        try{await artifactProjection;}catch(projectionError){this.options.report?.(projectionError);}
        const parts=botReplyDisplayParts(this.store.replyParts(event.replyMessageId));if(parts.length)text=parts.flatMap(part=>part.text?[part.text]:[]).join('\n\n');
      }
      const checkpoint=code==='BOT_OUTPUT_LIMIT'?(error as {checkpoint:number}).checkpoint:undefined;
      if(checkpoint!==undefined&&!this.store.replyParts(event.replyMessageId).length)text=(error as {partialText?:string}).partialText||text;
      this.updateExecution(event, { status: signal.aborted ? 'cancelled' : 'failed', question: undefined,
        continuation: !signal.aborted&&Number.isSafeInteger(checkpoint)?{checkpoint:checkpoint!}:undefined });
      this.store.settle({ eventId: event.id, leaseToken: claim.leaseToken, status: signal.aborted ? 'cancelled' : 'failed', content: text.slice(0,512000), error: signal.aborted ? undefined : code === 'MEMORY_SESSION_CLOSED' ? '记忆服务异常退出，本条消息已保留；可重试。' : errorText(error) });
      // A resumable turn still owns its prepared VCP context. Finish it once,
      // with the final answer, instead of closing and then reusing a failed job.
      if (prepared && checkpoint === undefined) this.store.enqueueMemoryJob(this.responseJob(event, prepared, text, false));
      if (!signal.aborted) { this.detail = errorText(error); this.options.report?.(error); }
    } finally {
      this.toolServer.releaseWorker(nativeLaneId);
      if (!this.closed) { this.replyProgress.delete(event.replyMessageId); this.changed(event.conversationId); this.maintainSafely(); }
    }
  }
  private async tool(call: BotToolCall, signal: AbortSignal): Promise<unknown> {
    const event = this.store.getEvent(call.eventId);
    if (!event || this.topics.lane(event) !== call.laneId || event.status !== 'running') throw new Error('工具调用没有有效的运行事件。');
    if(call.rootSessionId&&call.rootSessionId!==BotDshBrain.sessionId(call.laneId))throw Error('原生回复片段来自其他话题。');
    const conversation = this.store.getConversation(event.conversationId);
    if (!conversation || conversation.revision !== event.aclRevision || !conversation.memberIds.includes(event.companionId)) throw new Error('会话权限已变化。');
    signal.throwIfAborted(); this.assertCurrentEvent(event);
    if (!BOT_TOOLS.some(tool => tool.name === call.name)) throw new Error('主脑没有这项工具。');
    const key = `effect:${event.id}:${call.callId}`, fingerprint = digest(JSON.stringify([call.name, call.args]));
    const previous = this.store.getMetadata(key);
    if (previous) {
      const saved = JSON.parse(previous) as { fingerprint: string; result: unknown };
      const legacy=call.nativeSessionId&&call.nativeCallId?digest(JSON.stringify([call.name,{...call.args,nativeSessionId:call.nativeSessionId,nativeCallId:call.nativeCallId}])):undefined;
      if (saved.fingerprint !== fingerprint&&saved.fingerprint!==legacy) throw new Error('工具调用标识已用于其他参数。'); return saved.result;
    }
    const running = this.toolRuns.get(key); if (running) { if (running.fingerprint !== fingerprint) throw new Error('运行中的工具调用标识对应其他参数。'); return running.promise; }
    const operation = this.executeTool(event, call, signal).then(result => { this.store.setMetadata(key, JSON.stringify({ fingerprint, result })); return result; });
    this.toolRuns.set(key, { fingerprint, promise: operation }); try { return await operation; } finally { this.toolRuns.delete(key); }
  }
  private requireMedia(): BotMediaService {
    if (!this.options.media) throw new Error('聊天媒体服务尚未就绪。'); return this.options.media;
  }
  private assertCurrentEvent(event: BotEvent): void {
    const live = this.store.getEvent(event.id), lane = this.store.getLane(event.laneId);
    if (this.store.getCompanion(event.companionId)?.enabled === false || live?.status !== 'running' || !lane || this.store.getEventNativeEpoch(event.id) !== lane.epoch
      || this.store.withdrawnIn(event.companionId, event.securityDomainId, this.store.eventSourceIds(event.id)).size) throw new Error('原主脑事件已经停止或来源已撤回。');
  }
  private authorizedAttachmentGrants(event: BotEvent, requested: string[]): BotAttachmentGrant[] {
    const ids = [...new Set(requested)];
    const selected = ids.flatMap((_, index) => index % 16 ? [] : this.store.modelAttachmentGrants(event, { ownPublicationsFromEventId:event.id, ids: ids.slice(index, index + 16), throughSourceSequence: this.attachmentThrough(event) }));
    if (selected.length !== ids.length) throw new Error('附件尚未在当前聊天分享，或其来源已经撤回。');
    return selected.map(entry => ({ mediaId: entry.ref.id, grantId: entry.grantId }));
  }
  private attachmentThrough(event: BotEvent): number { return event.sourceMessageSequence; }
  private async verifiedAttachmentFiles(event: BotEvent, ids = this.store.getMessage(event.sourceMessageRecordId)?.attachments?.map(ref => ref.id) ?? [], throughSourceSequence = this.attachmentThrough(event), signal?: AbortSignal) {
    signal?.throwIfAborted(); this.maintenanceAbort.signal.throwIfAborted();
    // A turn or steering message carries only its own attachments. The native
    // Session already retains earlier inputs; chat_list_files provides explicit
    // paginated access to other authorized files without replaying the catalog.
    const grants = ids.flatMap((_, index) => index % 16 ? [] : this.store.modelAttachmentGrants(event, { ownPublicationsFromEventId:event.id, ids: ids.slice(index, index + 16), throughSourceSequence }));
    const result = [];
    for (const { ref } of grants) {
      signal?.throwIfAborted(); this.maintenanceAbort.signal.throwIfAborted();
      const file = await this.requireMedia().verifiedLocalFile(event.conversationId, ref.id, signal ?? this.maintenanceAbort.signal);
      signal?.throwIfAborted(); this.maintenanceAbort.signal.throwIfAborted(); result.push(botHandoffFile(file));
    }
    return result;
  }
  private async readAgentMemory(event: BotEvent, operation: 'memory_search' | 'DeepMemo' | 'TopicMemo' | 'memory_note' | 'memory_list', args: Record<string, unknown>, conversationId: string | undefined, signal: AbortSignal): Promise<unknown> {
    const selected = new BotAgentMemoryScopes(this.store).resolve(event, conversationId);
    selected.assertCurrent(); signal.throwIfAborted();
    if (selected.crossConversation) { await this.loadTombstones(selected.scope); selected.assertCurrent(); }
    if (operation === 'DeepMemo' || operation === 'TopicMemo') await this.historyProjector.project(selected.scope, signal);
    selected.assertCurrent();
    const result = selected.crossConversation ? await this.options.memory.readScoped(selected.scope, operation, args, signal)
      : operation === 'memory_note' ? await this.options.memory.readNote(selected.scope, { id: String(args.id) })
        : operation === 'memory_list' ? Object.keys(args).length ? await this.options.memory.catalog(selected.scope, args) : await this.options.memory.list(selected.scope)
        : await this.options.memory.tool(selected.scope, operation, args, signal);
    signal.throwIfAborted(); selected.assertCurrent();
    new BotAgentMemoryScopes(this.store).retainSources(event, selected, result);
    return selected.crossConversation ? { sourceConversation: selected.sourceConversation, result } : result;
  }
  private invalidateConversationDerived(conversationId: string): void {
    for (const target of new BotAgentMemoryScopes(this.store).dependentReplies(conversationId)) {
      const room = this.store.getConversation(target.conversationId); if (!room) continue;
      for (const companionId of room.memberIds.filter(id => id !== 'user')) {
        const scope = { companionId, conversationId: room.id, securityDomainId: room.securityDomainId };
        this.applyWithdrawal(scope, { sourceEventIds: [], sourceMessageIds: [target.messageId] });
        void this.syncSourceWithdrawals(scope).catch(error => this.options.report?.(error));
      }
    }
  }
  private async executeTool(event: BotEvent, call: BotToolCall, signal: AbortSignal): Promise<unknown> {
    const scope = scopeFor(event), args = call.args;
    if (['companion_contact', 'companion_reply_user', 'message_peer', 'chat_send_sticker'].includes(call.name)

      || call.name === 'world' && args.operation !== 'observe') {
      await this.ensureConversationBindings(event.conversationId);
      signal.throwIfAborted(); this.assertCurrentEvent(event);
    }
    if (['memory_write', 'memory_update', 'memory_organize', 'memory_forget', 'memory_maintenance'].includes(call.name)
      && args.conversationId !== undefined && args.conversationId !== event.conversationId) throw new Error('记忆写入和整理仅限当前受众，跨会话查询不授予修改权限。');
    if (['memory_write', 'memory_update', 'memory_organize', 'memory_forget', 'message_peer', 'companion_contact', 'companion_reply_user', 'chat_send_sticker'].includes(call.name)
      || call.name === 'world' && args.operation !== 'observe'
      || call.name === 'memory_maintenance' && args.operation === 'plan') this.store.reserveAutomaticAction(event.id, call.callId, call.name);
    switch (call.name) {
      case 'asset_manager': {
        this.assertCurrentEvent(event);
        const topicId = this.topics.reference(event.id)?.id;
        if (!this.topicApps(topicId).includes('asset-manager')) throw Error('请先在当前话题的“应用”中附加资产管理器。');
        if (!this.options.assetManagerApp) throw Error('资产管理器应用尚未就绪。');
        const actor = this.store.getCompanion(event.companionId)!;
        const result = await this.options.assetManagerApp.execute({ companionId: actor.id, companionName: actor.name, conversationId: event.conversationId, topicId }, companionAssetArgumentsSchema.parse(args), signal);
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        return result;
      }
      case 'browser': {
        this.assertCurrentEvent(event);
        if (!this.topicApps(this.topics.reference(event.id)?.id).includes('browser')) throw Error('请先在当前话题的“应用”中附加内置浏览器。');
        if (!this.options.browserTool) throw Error('内置浏览器连接暂不可用。');
        const input = companionBrowserArgumentsSchema.parse(args), actor = this.store.getCompanion(event.companionId)!;
        const result = await this.options.browserTool({ companionId: actor.id, companionName: actor.name, conversationId: event.conversationId }, input, signal);
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        if (!result.screenshot) return result.value;
        const directory = path.join(this.workspace(actor.id), '.worldlinebox', 'browser-captures');
        await mkdir(directory, { recursive: true });
        const filename = path.join(directory, digest(event.id + ':' + call.callId) + '.png');
        await writeFile(filename, result.screenshot); signal.throwIfAborted(); this.assertCurrentEvent(event);
        return { page: result.value, screenshotPath: filename, note: '用原生 read_image 查看这个实际 PNG 后，才可依据画面作答。' };
      }
      case 'companion_directory': {
        const query = z.string().max(200).parse(args.query ?? '').toLocaleLowerCase();
        const offset = z.number().int().min(0).parse(args.offset ?? 0), limit = z.number().int().min(1).max(64).parse(args.limit ?? 32);
        const companions = this.store.listCompanions().filter(actor => !query || actor.name.toLocaleLowerCase().includes(query) || actor.id.toLocaleLowerCase().includes(query));
        return { items: companions.slice(offset, offset + limit).map(({ id, name }) => ({ id, name })), total: companions.length,
          nextOffset: offset + limit < companions.length ? offset + limit : undefined };
      }
      case 'chat_ask_user': {
        this.assertCurrentEvent(event);
        const question = { id: digest(event.id + ':' + call.callId), text: nonempty.parse(args.question) };
        this.updateExecution(event, { question }); this.changed(event.conversationId);
        try { return await new Promise((resolve, reject) => {
          const abort = () => { this.questions.delete(question.id); reject(signal.reason ?? new Error('本轮已停止。')); };
          if (signal.aborted) { abort(); return; }
          this.questions.set(question.id, { eventId: event.id, resolve: value => { signal.removeEventListener('abort', abort); resolve(value); } });
          signal.addEventListener('abort', abort, { once: true });
        }); } finally { this.questions.delete(question.id); this.updateExecution(event, { question: undefined }); this.changed(event.conversationId); }
      }
      case 'agent_conversations': {
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        if (args.operation === 'contacts') {
          const input = z.strictObject({ operation: z.literal('contacts'), companionId: z.string().min(1).max(160).optional(),
            limit: z.number().int().min(1).max(30).optional(), before: z.number().int().min(1).optional() }).parse(args);
          return new BotContactStatus(this.store).list(event, { companionId: input.companionId, limit: input.limit, before: input.before });
        }
        return new BotConversationContinuity(this.store).read(event, botConversationReadSchema.parse(args));
      }


      case 'memory_maintenance': {
        const operation = z.enum(['plan', 'status']).parse(args.operation);
        if (operation === 'plan' && !['user','companion','gateway'].includes(event.source)) throw new Error('维护计划需要有效的用户或伙伴请求；后台通知不能自行创建。');
        const result = this.memoryMaintenance.tool(scope, { operation, kind: z.enum(['organize', 'dream']).optional().parse(args.kind), jobId: z.string().min(1).max(160).optional().parse(args.jobId) }, `${event.id}:${call.callId}`);
        this.maintainSafely(); return result;
      }

      case 'chat_read_message': {
        const id = z.string().min(1).max(160).parse(args.messageId), message = this.store.getMessage(id);
        const returned = this.store.peerReturns.canReadResult(event,id);
        if (!message || !returned && (message.conversationId !== event.conversationId || message.sequence > event.sourceMessageSequence)
          || message.status !== 'sent' || !this.store.isMessageVisibleToCompanion(id, event.companionId)
          || this.store.withdrawnIn(event.companionId, event.securityDomainId, [id]).size) throw new Error('原消息不属于当前主脑获准的会话范围。');
        const chars = Array.from(botMessageEvidence(message)), offset = z.number().int().min(0).max(1000000).parse(args.offset ?? 0);
        const limit = z.number().int().min(1).max(1200).parse(args.limit ?? 800), end = Math.min(chars.length, offset + limit);
        const files = returned && message.conversationId!==event.conversationId
          ? await Promise.all((message.attachments??[]).map(async ref=>botHandoffFile(await this.requireMedia().verifiedLocalFile(message.conversationId,ref.id,signal))))
          : await this.verifiedAttachmentFiles(event, message.attachments?.map(ref => ref.id) ?? [], undefined, signal);
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        if(returned&&!this.store.peerReturns.canReadResult(event,id))throw Error('伙伴回信的来源授权已经变化。');
        return { messageId: id, senderId: message.senderId, senderName: message.senderName, occurredAt: botLocalTimestamp(message.createdAt), files,
          offset, totalChars: chars.length, text: chars.slice(offset, end).join(''), nextOffset: end < chars.length ? end : undefined, complete: end >= chars.length };
      }
      case 'chat_list_stickers': {
        const media = this.requireMedia(), query = typeof args.query === 'string' ? args.query.trim().slice(0, 200).toLocaleLowerCase() : '';
        const packs = await media.listPacks({ conversationId: event.conversationId });
        const selected = typeof args.packId === 'string' ? packs.filter(pack => pack.id === args.packId) : packs.slice(0, 16);
        const lists = await Promise.all(selected.map(pack => media.listStickers({ conversationId: event.conversationId, packId: pack.id })));
        const found = lists.flat().filter(ref => !query || [ref.name, ref.originalName, ref.description, ...(ref.tags ?? [])].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
        return { packs: packs.slice(0, 80), stickers: found.slice(0, 80).map(ref => ({ id: ref.id, name: ref.name, originalName: ref.originalName, description: ref.description, tags: ref.tags, mimeType: ref.mimeType, kind: ref.kind, packId: ref.packId, animated: ref.animated })), hasMore: found.length > 80 };
      }
      case 'chat_list_files': {
        const query = typeof args.query === 'string' ? args.query.trim().slice(0, 200).toLocaleLowerCase() : '';
        const refs = this.store.modelAttachmentGrants(event, { ownPublicationsFromEventId:event.id, query, throughSourceSequence: this.attachmentThrough(event), all: true }).map(entry => entry.ref).filter(ref => ref.kind === 'file');
        const offset = z.number().int().min(0).default(0).parse(args.offset), limit = z.number().int().min(1).max(80).default(40).parse(args.limit);
        const files = await this.verifiedAttachmentFiles(event, refs.slice(offset, offset + limit).map(ref => ref.id), undefined, signal);
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        return { files, total: refs.length, hasMore: offset + files.length < refs.length, nextOffset: offset + files.length < refs.length ? offset + files.length : undefined };
      }
      case 'chat_send_sticker': {
        const [sticker] = await this.requireMedia().resolveForConversation(event.conversationId, [nonempty.parse(args.stickerId)]);
        if (!sticker || sticker.kind !== 'sticker') throw new Error('只能发送已列出的真实表情。');
        signal.throwIfAborted();
        const message = this.store.taskTransaction(()=>{
          const message=this.store.publishForEvent(event.id, call.callId, { content: typeof args.caption === 'string' ? args.caption.slice(0, 24000) : '', attachments: [sticker] });
          this.store.appendReplyPart(event.id,{id:'media-'+digest(call.callId),kind:'media',sequence:call.rootSequence,text:message.content||undefined,attachments:[sticker],publicationId:message.id});return message;
        });
        this.changed(event.conversationId); return { sent: true, messageId: message.id, attachmentIds: [sticker.id] };
      }

      case 'agent_memory_scopes': return new BotAgentMemoryScopes(this.store).list(event, z.strictObject({ cursor: z.string().min(1).max(160).optional(), limit: z.number().int().min(1).max(30).optional() }).parse(args));
      case 'memory_search': {
        const input = z.strictObject({ query: z.string().trim().min(1).max(4000), conversationId: z.string().min(1).max(160).optional() }).parse(args);
        return this.readAgentMemory(event, 'memory_search', { query: input.query }, input.conversationId, signal);
      }
      case 'memory_recall_details': return this.options.memory.recallDetails({ scope, requestId: event.id,
        citationId: args.citationId === undefined ? undefined : z.string().min(1).max(160).parse(args.citationId),
        offset: z.number().int().min(0).max(10000000).parse(args.offset ?? 0), signal });
      case 'memory_history': {
        const input = z.strictObject({ keyword: z.string().trim().min(1).max(4000), conversationId: z.string().min(1).max(160).optional() }).parse(args);
        return this.readAgentMemory(event, 'DeepMemo', { keyword: input.keyword }, input.conversationId, signal);
      }
      case 'memory_read': {
        const input = z.strictObject({ topicId: z.string().max(200).optional(), conversationId: z.string().min(1).max(160).optional() }).parse(args);
        return this.readAgentMemory(event, 'TopicMemo', { topic_id: input.topicId }, input.conversationId, signal);
      }
      case 'memory_write': {
        const input = { content: nonempty.parse(args.content), sourceEventId: `${event.id}:${call.callId}`,
          sourceRootEventId: event.id, sourceMessageIds: [event.sourceMessageRecordId, event.replyMessageId] };
        const recover = async (): Promise<Record<string, unknown> | undefined> => {
          const proof = await this.options.memory.rememberReceipt(scope, input, signal);
          if (proof.found === false) return;
          const receipt = proof.receipt;
          if (proof.found !== true || !receipt || typeof receipt !== 'object' || Array.isArray(receipt)
            || (!['indexed', 'pending'].includes(String((receipt as Record<string, unknown>).state)) && (receipt as Record<string, unknown>).withdrawn !== true)) {
            throw Object.assign(new Error('原记忆写入的结果尚未确认，不能重复写入。'), { code: 'MEMORY_OPERATION_UNKNOWN' });
          }
          return receipt as Record<string, unknown>;
        };
        let result: unknown = await recover();
        if (!result) {
          try { result = await this.options.memory.remember(scope, input, signal); }
          catch (error) { result = await recover(); if (!result) throw error; }
        }
        if ((result as { state?: string }).state === 'pending') this.store.enqueueMemoryJob({ key: `index:${input.sourceEventId}`, kind: 'mutation', payload: { scope, operation: 'remember', input } });
        this.memoryMaintenance.activity(scope, `${event.id}:${call.callId}`); return result;
      }
      case 'memory_list': {
        const input = z.strictObject({ query: z.string().max(4000).optional(), tag: z.string().max(64).optional(), cursor: z.string().max(1000).optional(),
          limit: z.number().int().min(1).max(60).optional(), conversationId: z.string().min(1).max(160).optional() }).parse(args);
        const { conversationId, ...query } = input;
        return this.readAgentMemory(event, 'memory_list', query, conversationId, signal);
      }
      case 'memory_note': {
        const input = z.strictObject({ id: z.string().min(1).max(200), conversationId: z.string().min(1).max(160).optional() }).parse(args);
        return this.readAgentMemory(event, 'memory_note', { id: input.id }, input.conversationId, signal);
      }
      case 'memory_update': return this.mutateMemory(scope, 'update', this.memoryMutationInput(event, call), signal);
      case 'memory_organize': return this.mutateMemory(scope, 'organize', this.memoryMutationInput(event, call), signal);
      case 'memory_forget': {
        this.store.setMetadata(`skipCapture:${event.id}`, 'true');
        const receipt = await this.forget(scope, nonempty.parse(args.id), event.id);
        this.store.confirmMemoryForget(event.id, call.callId, receipt);
        this.scheduler.cancel(event.id); this.changed(event.conversationId); this.maintainSafely();
        return receipt;
      }
      case 'world': {
        const scope = { companionId: event.companionId, conversationId: event.conversationId };
        if (args.operation === 'observe') { const snapshot = this.world.observe(scope); this.deliverWorldEvents(); return snapshot; }
        if (causalHop(event) >= maxCausalHop) return causalLimit();
        this.deliverWorldEvents();
        const effectId = `${event.id}:${call.callId}`;
        // Prepare the source identity before the physical transaction. Its
        // durable start event, not a failed attempt, advances actor causation.
        this.store.setMetadata(`world:causal-effect:${digest(effectId)}`, event.id);
        const result = this.world.execute(scope, botWorldCommandSchema.parse(args), effectId);
        this.deliverWorldEvents(); return result;
      }


      case 'companion_contact': {
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        if (causalHop(event) >= maxCausalHop) return causalLimit();
        const targetId = z.string().min(1).max(160).parse(args.companionId);
        await this.ensureConversationBindings(event.conversationId, [targetId]);
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        const destination = z.enum(['user', 'peer']).parse(args.destination), message = z.string().trim().min(1).max(4000).parse(args.message);
        const result = this.store.contactPeer(event, targetId, call.callId, message, destination);
        if (!result.accepted) return { sent: false, reason: result.reason };
        this.scheduler.wake(); this.changed(result.conversationId); this.changed(event.conversationId);
        return this.contactReceipt(result.conversationId, targetId, destination);
      }
      case 'companion_reply_user': {
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        if (causalHop(event) >= maxCausalHop) return causalLimit();
        const result = this.store.replyPeerToUser(event, call.callId, z.string().trim().min(1).max(24000).parse(args.message));
        this.changed(result.conversationId); this.changed(event.conversationId); return result;
      }
      case 'message_peer': {
        const target = nonempty.parse(args.companionId), content = z.string().trim().max(8000).parse(args.content ?? ''), cause = derivedCause(event);
        await this.ensureConversationBindings(event.conversationId, [target]);
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        if (causalHop(event) >= maxCausalHop) return causalLimit();
        const ids = z.array(z.string().min(1).max(160)).max(16).parse(args.attachmentIds ?? []);
        if (!content && !ids.length) throw new Error('伙伴消息需要文字或真实附件。');
        const attachments = ids.length ? await this.requireMedia().resolveForConversation(event.conversationId, ids) : undefined;
        const attachmentGrants = attachments ? this.authorizedAttachmentGrants(event, attachments.filter(ref => ref.kind !== 'sticker').map(ref => ref.id)) : [];
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        const result = this.store.tryEnqueueAutomatic({ conversationId: event.conversationId, senderId: event.companionId, source: 'companion', content,
          attachments, attachmentGrants, sourceIds: this.store.eventSourceIds(event.id), sourceMessageId: `${event.id}:${call.callId}`, recipientIds: [target], correlationId: cause.correlationId, causationId: cause.causationId, peerReturnSourceEventId: event.id,
          payload: { hop: cause.hop, directedPeer: true, peerAssignment: { requesterId: event.companionId, requesterName: this.store.getCompanion(event.companionId)!.name,
            originalSenderId: event.senderId, originalSenderType: event.senderType, originalSenderName: event.senderType === 'user' ? '用户' : event.senderName } } });
        if (!result.accepted) return { sent: false, reason: result.reason };
        this.scheduler.wake(); this.changed(event.conversationId); return { sent: true, eventIds: result.events.map(item => item.id) };
      }




      default: throw new Error('未知主脑工具。');
    }
  }
  private maintainSafely(): void { void this.maintain().catch(error => this.options.report?.(error)); }
  private async maintain(): Promise<void> {
    if (this.closed) return;
    for(const job of this.topics.titleJobs()){if(this.titleRuns.size>=2)break;void this.flushTitle(job);}
    for(const command of this.topics.pendingGuidance())void this.flushGuidance(command);
    const stops = this.store.taskTransaction(sql => sql.prepare("SELECT value FROM bot_metadata WHERE key LIKE 'native-stop:%' AND value<>''").all() as Array<{ value: string }>);
    for (const row of stops) {
      if (this.nativeStops.size >= 2) break;
      const stop = JSON.parse(row.value) as { eventId: string; retryAt: number };
      if (stop.retryAt <= Date.now()) void this.flushNativeStop(stop.eventId);
    }
    this.memoryMaintenance.poll();
    this.world.tick(); this.deliverWorldEvents();
    if (this.memoryWorking) return;
    const claim = this.store.claimMemoryJob({ workerId: 'bot-memory', leaseMs: 120000 }); if (!claim) return;
    this.memoryWorking = true;
    const heartbeat = setInterval(() => { if (!this.closed) this.store.heartbeatMemoryJob(claim.job.id, claim.leaseToken, 120000); }, 30000); heartbeat.unref?.();
    this.memoryRun = (async () => { try {
      const payload = claim.job.payload;
      let resultMetadata: Array<{ key: string; value: string }> | undefined;
      if (claim.job.kind === 'response') await this.options.memory.finishTurn(payload.prepared as BotMemoryPrepared, String(payload.text ?? ''), payload.completed === true);
      else if (claim.job.kind === 'maintenance') {
        const result = await this.memoryMaintenance.run(claim, this.maintenanceAbort.signal);
        this.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, ...result }); return;
      }
      else if (claim.job.kind === 'projection') await this.historyProjector.project(payload.scope as BotMemoryScope, this.maintenanceAbort.signal);
      else if (claim.job.kind === 'mutation') {
        const scope = payload.scope as BotMemoryScope, operation = z.enum(['update', 'organize', 'remember']).parse(payload.operation);
        const result = operation === 'remember' ? await this.options.memory.remember(scope, { ...payload.input as BotMemoryWrite, waitForIndex: true, indexTimeoutMs: 1000 }, this.maintenanceAbort.signal) as Record<string, unknown>
          : operation === 'update' ? await this.options.memory.update(scope, payload.input as BotMemoryUpdate, this.maintenanceAbort.signal)
          : await this.options.memory.organize(scope, payload.input as BotMemoryOrganize, this.maintenanceAbort.signal);
        if (operation !== 'remember' && result.state !== 'indexed' && result.withdrawn !== true) throw new Error(String(result.error || '记忆整理尚未完成；保留相同操作回执继续恢复。'));
      }
      else if (claim.job.kind === 'capture') {
        const scope = payload.scope as BotMemoryScope;
        const withdrawn = this.store.withdrawnIn(scope.companionId, scope.securityDomainId, [String(payload.sourceEventId)]);
        if (withdrawn.has(String(payload.sourceEventId))) { this.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, status: 'done' }); return; }
        const sourceEvent = this.store.getEvent(String(payload.sourceEventId));
        const cwd = path.join(this.options.root, 'memory-encoder'); await mkdir(cwd, { recursive: true });
        const result = await captureBotMemory({ brain: this.options.brain, memory: this.options.memory, scope,
          onRemember: input => { if (input.waitForIndex === true) return; this.store.enqueueMemoryJob({ key: `index:${input.sourceEventId}`, kind: 'mutation', payload: { scope, operation: 'remember', input } }); },
          jobId: claim.job.id, sourceEventId: String(payload.sourceEventId), cwd, callback: await this.toolServer.start(), model: this.options.model(),
          messages: payload.messages as BotMemoryMessage[], answer: String(payload.answer ?? ''), answerMessageId: typeof payload.answerMessageId === 'string' ? payload.answerMessageId : undefined,
          policyVersion: payload.policyVersion === 3 ? 3 : payload.policyVersion === 2 ? 2 : undefined,
          completed: payload.completed === true, capturedAt: typeof payload.capturedAt === 'string' ? payload.capturedAt : undefined,
          nativeDeliveries: Array.isArray(payload.nativeDeliveries) ? payload.nativeDeliveries as Array<{path:string;description?:string}> : undefined,
          contextEpoch: sourceEvent ? this.store.getEventNativeEpoch(sourceEvent.id) : undefined, signal: this.maintenanceAbort.signal });
        resultMetadata = [{ key: `memory-capture-result:${claim.job.id}`, value: JSON.stringify({ policyVersion: payload.policyVersion === 3 ? 3 : payload.policyVersion === 2 ? 2 : 1, notes: result.notes, completedAt: new Date().toISOString() }) }];
        if (result.notes > 0) this.memoryMaintenance.activity(scope, claim.job.id);
      }
      else throw new Error('尚未接入该记忆作业类型。');
      this.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, status: 'done', metadata: resultMetadata });
    } catch (error) {
      if (claim.job.kind === 'capture' && error && typeof error === 'object' && 'code' in error && error.code === 'MEMORY_SOURCE_WITHDRAWN') {
        // A withdrawn source cannot become a successful memory on retry. Ack
        // this queue item as handled, retaining the reason rather than looping.
        this.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, status: 'done', error: '来源已撤回，未继续编码或保存记忆。' });
        return;
      }
      const pendingIndex = claim.job.kind === 'mutation' && claim.job.payload.operation === 'remember' && (error as { code?: string })?.code === 'MEMORY_SYNC_TIMEOUT';
      this.store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, status: !this.closed && !pendingIndex && claim.job.attempts >= 5 ? 'failed' : 'retry',
        error: this.closed ? undefined : errorText(error), retryDelayMs: this.closed ? 0 : Math.min(60000, claim.job.attempts * 5000) });
      if (!this.closed && (!pendingIndex || claim.job.attempts === 1)) this.options.report?.(error);
    } finally { clearInterval(heartbeat); this.memoryWorking = false; this.changed(); } })();
    await this.memoryRun;
  }
  private deliverWorldEvents(): void {
    // Drain the durable queue in order before applying a newer physical
    // action, so an older pending start cannot overwrite its actor cause.
    for (let pending = this.world.pendingEvents(); pending.length; pending = this.world.pendingEvents()) for (const event of pending) {
      const sourceId = this.store.getMetadata(event.kind === 'arrival' ? `world:causal-actor:${event.companionId}` : `world:causal-effect:${digest(event.effectId)}`);
      const source = sourceId ? this.store.getEvent(sourceId) : undefined;
      if (event.kind !== 'arrival') this.store.setMetadata(`world:causal-actor:${event.companionId}`, source?.id ?? '');
      const cause = source ? derivedCause(source) : { correlationId: `world:${event.id}`, causationId: event.id, hop: 0 };
      for (const companionId of event.recipientIds) {
        const companion = this.store.getCompanion(companionId); if (!companion) continue;
        const key = `world:private-lane:${companionId}`;
        let conversation = this.store.getConversation(this.store.getMetadata(key) ?? '');
        if (!conversation) { conversation = this.store.createGroup({ title: `${companion.name} · 世界`, kind: 'world', memberIds: [companionId] }); this.store.setMetadata(key, conversation.id); }
        // The source transcript is private to this observer. recipientIds alone
        // would not hide its text from non-witness group history readers.
        this.store.tryEnqueueAutomatic({ conversationId: conversation.id, senderId: 'world', source: 'world', sourceInstanceId: 'world-physics-v2',
          sourceMessageId: `${event.id}:${companionId}`, recipientIds: [companionId], content: event.text, kind: 'world_observation',
          correlationId: cause.correlationId, causationId: cause.causationId, payload: { worldEventId: event.id, hop: cause.hop } });
      }
      this.world.ackEvents([event.id]);
    }
    this.scheduler.wake();
  }
  shutdown(): Promise<void> { return this.closing ??= this.stop(); }
  private async stop(): Promise<void> {
    if (this.closed) return; this.closed = true; clearInterval(this.maintenance);
    for(const watch of this.contextWatches.values())watch.controller.abort();
    await this.starting.catch(() => undefined);
    this.maintenanceAbort.abort(Object.assign(new Error('应用关闭，保留原会话。'), { code: 'BOT_SUSPEND' }));
    // Close VCP promptly: it owns the native memory file handles. No slow DSH
    // transport or maintenance request may postpone releasing those handles.
    const memoryClosing = this.options.memory.close(), brainClosing = this.options.brain.close();
    await this.scheduler.close(); await this.memoryMaintenance.close();
    await Promise.allSettled([...this.nativeStops.values()]);
    await Promise.allSettled([...this.companionControls.values(), ...this.memoryWarmRuns.values(), ...this.sourceWithdrawalRuns.values()]);
    await this.restoringCompanions; await this.toolServer.close();
    await Promise.allSettled([brainClosing, memoryClosing, this.memoryRun]); this.store.close();
  }
  }
