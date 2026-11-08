import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { BotEvent as UiEvent, BotRequest, BotResponse, BotSnapshot, BotReplyProgress } from '../../shared/companion-bot';
import type { BotMediaRef } from '../../shared/companion-bot-media';
import { DEFAULT_MODEL_CONTEXT_CHARS } from '../../shared/model-budget';
import { BotDshBrain, type BotDshModel, type BotDshResult } from './dsh-brain';
import type { BotBrain } from './brain-router';
import { appBrainRequest, fitsAppBrainRequest } from './app-brain-budget';
import type { AppToolReconciliation } from './app-brain';
import type { BotMemoryService, BotMemoryPrepared, BotMemoryScope, BotMemoryMessage, BotMemoryForget, BotMemoryUpdate, BotMemoryOrganize, BotMemoryWrite } from './memory-service';
import { BotScheduler } from './scheduler';
import { BotStore } from './store';
import { botLocalTimestamp, buildBotContext } from './context';
import { taskContextPolicy } from './task-context-policy';
import { isBotParticipantRequest } from './participant-request';
import { BotWorkflowRuntime, botWorkflowStages } from './workflow-runtime';
import { BotDelegationRuntime, type BotDelegationTicket } from './delegation-runtime';
import { botHandoffFile, botTaskFileEvidence, buildBotTaskPrompt } from './task-handoff';
import { BotToolServer, type BotToolCall } from './tool-server';
import { BOT_ROUTER_TOOLS as BOT_TOOLS } from './tools';
import { BOT_MEMORY_CAPTURE_POLICY, captureBotMemory } from './memory-capture';
import { BotMaintenanceRuntime } from './memory-maintenance-runtime';
import type { BotMemoryMaintenanceRequest } from '../../shared/companion-bot-maintenance';
import { BotWorld } from './world';
import { botWorldCommandSchema } from '../../shared/companion-bot-world';
import { BotRetention, botLaneWorkdir, type BotTurnCompletion } from './retention';
import { BotHistoryProjector } from './history-projection';
import { BotTaskRuntime, type BotTaskControlInput } from './task-runtime';
import { BotTaskReports } from './task-report';
import { BotAgentMemoryScopes } from './agent-memory-scope';
import { clearBotTaskHistory, resumeBotTaskHistoryClears } from './task-history';
import { botTaskAnswerSchema } from '../../shared/companion-bot-task';
import type { BotActivityBudgetPolicy } from './activity-budget';
import { BUILTIN_BOT_COMPANIONS, DEFAULT_BOT_COMPANION_ID } from '../../shared/builtin-bot-companions';
import { eraseDevelopmentWorkspaces } from './development-cleanup';
import type { BotMediaService } from './media-service';
import { botMessageEvidence } from '../../shared/bot-message-content';
import type { BotClaim, BotEvent, BotMemoryJobInput, BotTask, BotAttachmentGrant } from './types';
import { migrateBotHost, botConversationWorkdir, botHostHistoryRebuildKey, botNativeHostBindingKey } from './host-migration';
import type { NativeHostEvent } from '../dsh/native-host-client';
import { GROUP_ATTENTION_SYSTEM, parseGroupAttention, isGroupStop, type GroupAttentionDecision } from './group-attention';
import { resolveBotModelLimits } from './model-limits';
import { BotCompanionRuntime } from './companion-runtime';
import { abortable } from './abortable';
import type { BotCapabilityState } from '../../shared/companion-capabilities';
import { dshTaskCapabilityQuerySchema, type DshTaskCapabilityQuery, type DshTaskCapabilities } from '../../shared/dsh-task-spec';

export interface BotServiceOptions {
  root: string; brain: BotBrain; memory: BotMemoryService; model(): BotDshModel;
  /** Application-owned router; DSH remains the delegated worker implementation. */
  brainRuntime?: 'worldlinebox';
  prewarmMemory?: boolean;
  modelLimits?(): { window: number; source: 'explicit' | 'metadata' | 'official-default' | 'unknown'; estimate: 'utf8-byte-upper-bound' };
  onEvent(event: UiEvent): void; report?(error: unknown): void;
  retention?: { maxTurns?: number; maxBytes?: number };
  activityBudget?: Partial<BotActivityBudgetPolicy>;
  media?: BotMediaService;
  transcribeAttachments?(conversationId: string, attachments: BotMediaRef[], requestId: string): Promise<BotMediaRef[]>;
  runtimePreparation?(): { phase: string; elapsedMs: number } | undefined;
  hostMigration?: { fromHostId: string; toHostId: string };
  onHostMigrationComplete?(instanceId: string): Promise<void>;
  capabilityState?(companionId: string): BotCapabilityState;
  /** Admission checks ownership only. It must never create or start an instance. */
  ensureCompanionBindings?(companionIds: string[]): Promise<void>;
  capabilities?(companionId: string, query: DshTaskCapabilityQuery, signal: AbortSignal): Promise<DshTaskCapabilities>;
  companionRuntime?(companionId: string, name: string, operation: 'start' | 'stop', signal: AbortSignal): Promise<void>;
  restoreCompanionEnvironments?(companions: ReadonlyArray<{ id: string; name: string; enabled?: boolean }>, signal: AbortSignal): Promise<void>;
  /** Only an explicit task resume may clear an executor's manual-stop fence. */
  resumeTaskRuntime?(taskId: string, signal: AbortSignal): Promise<void>;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const executorPauseCause = (task:BotTask):'executor'|'executor-history'|undefined => task.status!=='paused'?undefined
  :task.extra.executorPaused===true?'executor':task.extra.executorPaused!==false&&task.extra.executorInterruption&&typeof task.extra.executorInterruption==='object'?'executor-history':undefined;
const MAX_WORKER_RUNS = 64;
const workerSystem = `你是世界线盒子伙伴委派的DSH执行器。完成当前明确目标，验证实际产物。本任务会话可使用DSH完整原生工具和本机文件访问能力；这不是额外任务授权。严格遵守下面原始目标、用户明确限制和已提供事实，不擅自扩大范围；只读、不得删除、指定路径等约束始终有效。产物优先写入自己的任务工作区。遇到可依据原始目标和已知事实判断的执行细节，交由委派主脑回答；缺少用户偏好或新的操作授权时提出真实问题。不读取其他会话或伙伴记忆目录。不发送未经请求的外部消息。依据真实执行结果报告，未完成要说明。
交付给主脑的最终正文及worker_report.summary必须自包含：直接写出本任务的实际答案、关键数值和单位、适用时间、来源或核验依据，保留失败项及不确定性；文件成果提供准确的绝对路径和用途，并按需用worker_chat_send_file发布真实文件。主脑不会自动看到你的工具轨迹或“上面的回答”，不能只写“已完成”“见上文”“结果已输出”，也不能用成功宣言代替答案。不要交付推理过程、无关历史或原始工具日志。任务完成后仍可只读已有交付，不要求主脑重跑任务才取得正文。
业务状态可通过worker_report结构化回传：progress表示阶段进展，waiting表示等待后续事件，blocked表示阻碍，failed表示确实失败，dropped表示无需继续，ready表示当前目标已完成。ready须说明实际verification依据，文字答复也可核验，不强制创建文件。需要回答时提出真实问题，不用一段最终正文假装工具仍在运行。正常结束且没有未决问题或外部操作时，宿主按原生执行结果结束任务，缺少报告不会制造等待状态。完成报告之后不要再修改产物；有新工作或跟进时沿原任务继续，并重新核验。子Agent不能代替根执行器提交业务完成报告。`;
const workerTools = [{ name: 'worker_chat_send_file', description: '将自己任务工作区中的实际产物文件发送到原委派聊天。只用任务内真实相对路径，成功回执表示已发送，不要重复发送；不代表整个任务完成。',
      parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 32768 }, caption: { type: 'string', maxLength: 24000 } }, required: ['path'], additionalProperties: false } }];
const nonempty = z.string().trim().min(1).max(24000);
const maxCausalHop = 6;
const causalHop = (event: BotEvent): number => event.source === 'user' || event.payload.hop === undefined ? 0
  : Number.isSafeInteger(event.payload.hop) && Number(event.payload.hop) >= 0 ? Number(event.payload.hop) : maxCausalHop;
const derivedCause = (event: BotEvent) => ({ correlationId: event.correlationId, causationId: event.id, hop: causalHop(event) + 1 });
const causalLimit = () => ({ accepted: false, sent: false, status: 'blocked', reason: '本次事件的自动衍生轮次已达上限，等待新的用户输入。' });
const scopeFor = (event: Pick<BotEvent, 'companionId' | 'conversationId' | 'securityDomainId'>): BotMemoryScope => ({ companionId: event.companionId, conversationId: event.conversationId, securityDomainId: event.securityDomainId });
interface NativeDispatch { nativeLaneId: string; system: string; prompt: string; historyThroughSequence?: number; deliveredMessageIds?: string[]; taskFollowup?: { taskId: string; questionId?: string } }
interface ExecutorControl { kind: 'pause' | 'cancel'; requestedAt: string; state: 'pending' | 'acknowledged' | 'unavailable'; attempts: number; retryAt: number; error?: string; workspaceLayout?: unknown }

/** The application owns companion events, the router model/tool loop and its
 * durable state. DSH is a delegated task worker; VCP owns memory. */
export class BotService {
  readonly store: BotStore;
  readonly companionRuntime: BotCompanionRuntime;
  private readonly workflows: BotWorkflowRuntime;
  private readonly delegations: BotDelegationRuntime;
  private readonly world: BotWorld;
  private readonly scheduler: BotScheduler;
  private readonly toolServer: BotToolServer;
  private readonly retention: BotRetention;
  private readonly historyProjector: BotHistoryProjector;
  private readonly taskRuntime: BotTaskRuntime;
  private readonly taskReports: BotTaskReports;
  private readonly memoryMaintenance: BotMaintenanceRuntime;
  private readonly starting: Promise<void>;
  private readonly taskRuns = new Map<string, { companionId: string; controller: AbortController; promise: Promise<void> }>();
  private readonly taskPreparations = new Map<string, Promise<void>>();
  private lastTaskCompanion?: string;
  private readonly taskControlRuns = new Map<string, Promise<void>>();
  private delegationCursor = 0;
  private readonly delegationCleanup = new Set<string>();
  private readonly executorControlRuns = new Map<string, Promise<void>>();
  private readonly taskAccessUpgrades = new Map<string, Promise<void>>();
  private readonly companionControls = new Map<string, Promise<void>>();
  private readonly companionControlRevisions = new Map<string, number>();
  private readonly companionStartWaiters = new Map<string, Set<AbortController>>();
  private restoringCompanions?: Promise<void>;
  private readonly toolRuns = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  private readonly retirementRuns = new Map<string, Promise<void>>();
  private readonly sourceWithdrawalRuns = new Map<string, Promise<void>>();
  private maintenance?: ReturnType<typeof setInterval>;
  private memoryWorking = false;
  private memoryRun?: Promise<void>;
  private readonly maintenanceAbort = new AbortController();
  private readonly loadedTombstones = new Map<string, true>();
  private readonly replyProgress = new Map<string, BotReplyProgress>();
  private readonly memoryWarmRuns = new Map<string, Promise<void>>();
  private readonly groupAttentionRuns = new Map<string, Promise<GroupAttentionDecision>>();
  private readonly groupAttentionAborts = new Map<string, AbortController>();
  private readonly memoryWarmPhases = new Map<string, 'memory-starting' | 'memory-verifying' | 'memory-indexing' | 'recalling-memory'>();
  private closed = false;
  private ready = false;
  private presenceModelConfigured?: boolean;
  private presenceExpiry?: ReturnType<typeof setTimeout>;
  private presenceExpiryAt?: number;
  private historyClearRun?: Promise<void>;
  private detail?: string;
  private developmentCleanupRun?: Promise<void>;
  private developmentCleanupRetryAt = 0;
  constructor(private readonly options: BotServiceOptions) {
    this.store = new BotStore(path.join(options.root, 'bot.sqlite'), { activityBudget: options.activityBudget });
    this.delegations = new BotDelegationRuntime(this.store);
    this.workflows = new BotWorkflowRuntime(this.store, { authority: event => this.companionRuntime.workAuthority(event) });
    this.companionRuntime = new BotCompanionRuntime(this.store, { taskAuthority: task => this.workflows.taskAuthority(task), authorityGuard: event => this.delegations.allowsWork(event) });
    this.store.setTaskBudgetAuthority(taskId => {
      const task = this.store.getTask(taskId); if (!task) return false;
      try { return this.companionRuntime.validateTask(task).state === 'active'; } catch { return false; }
    });
    this.world = new BotWorld(this.store);
    this.taskRuntime = new BotTaskRuntime(this.store, { followupAvailable: task => this.companionRuntime.followupAvailable(task) });
    this.taskReports = new BotTaskReports(this.store);
    this.toolServer = new BotToolServer((call, signal) => this.tool(call, signal));
    this.memoryMaintenance = new BotMaintenanceRuntime({ store: this.store, root: options.root, brain: options.brain, memory: options.memory,
      model: options.model, callback: () => this.toolServer.start(), changed: conversationId => this.changed(conversationId), report: options.report });
    this.historyProjector = new BotHistoryProjector({ store: this.store, memory: options.memory });
    this.retention = new BotRetention({ store: this.store, brain: options.brain, root: options.root,
      model: options.model, callback: () => this.toolServer.start(), ...options.retention,
      beforeHandoff: async (event, signal) => { await this.historyProjector.project(scopeFor(event), signal); } });
    this.scheduler = new BotScheduler(this.store, { handle: (claim, signal) => this.respond(claim, signal), concurrency: 3,
      onChange: () => this.changed(), onError: error => { this.detail = errorText(error); options.report?.(error); this.changed(); } });
    this.starting = this.start();
  }
  private async start(): Promise<void> {
    await mkdir(this.options.root, { recursive: true }); await this.toolServer.start();
    if (this.closed) return;
    this.store.beginDevelopmentDefaultCleanup();
    for (const builtin of BUILTIN_BOT_COMPANIONS) if (!this.store.getCompanion(builtin.id)) this.store.createCompanion({ id: builtin.id, name: builtin.name, persona: builtin.persona });
    this.store.openDirect(DEFAULT_BOT_COMPANION_ID);
    if (this.options.brainRuntime === 'worldlinebox') {
      // Old native turns cannot be represented as absent in the new router's
      // journal. Only proven-idle lanes rotate; unresolved old effects stay fenced.
      const legacyHosts = this.store.taskTransaction(sql => (sql.prepare("SELECT DISTINCT value FROM bot_metadata WHERE key LIKE 'native-host:%' AND value<>'' AND value<>'worldlinebox'").all() as Array<{ value: string }>).map(row => row.value));
      for (const fromHostId of [...legacyHosts, 'legacy-unbound-dsh']) {
        const result = await migrateBotHost({ store: this.store, projector: this.historyProjector, fromHostId, toHostId: 'worldlinebox', signal: this.maintenanceAbort.signal });
        if (!result.complete) this.detail = '旧版本主脑仍有未核实执行，相关记录已保留；不会把它当作新主脑已取消或已完成。';
      }
    } else if (this.options.hostMigration) {
      const result = await migrateBotHost({ store: this.store, projector: this.historyProjector, ...this.options.hostMigration, signal: this.maintenanceAbort.signal });
      if (result.complete) await this.options.onHostMigrationComplete?.(this.options.hostMigration.fromHostId);
      else this.detail = '旧执行记录尚待核实，相关会话已保留；其他伙伴使用默认 DSH 实例。';
    }
    this.historyClearRun = resumeBotTaskHistoryClears(this.store).then(() => this.changed()).catch(error => this.options.report?.(error));
    this.reconcileFinishedTasks();
    this.scheduler.start();
    this.maintenance = setInterval(() => { this.maintainSafely(); }, 1000); this.maintenance.unref?.();
    this.maintainSafely();
    if (this.options.restoreCompanionEnvironments) this.restoringCompanions = this.options.restoreCompanionEnvironments(this.store.listCompanions(), this.maintenanceAbort.signal)
      .catch(error => { if (!this.closed) this.options.report?.(error); });
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
  configurationChanged(): void { this.ready = false; this.presenceModelConfigured = undefined; this.detail = undefined; this.changed(); }
  runtimePreparationChanged(): void {
    if (this.options.brainRuntime === 'worldlinebox') return;
    const state = this.options.runtimePreparation?.();
    for (const [id, value] of this.replyProgress) if (value.phase === 'waiting-runtime' || value.phase === 'waiting-model') {
      if (state?.phase === 'ready') this.replyProgress.set(id, { phase: 'waiting-model' });
      else if (state?.phase === 'failed') this.replyProgress.set(id, { phase: 'retrying', detail: '共享连接暂未就绪' });
      else if (state) this.replyProgress.set(id, { phase: 'waiting-runtime' });
    }
    this.changed();
  }
  embeddingChanged(): void { this.changed(); }
  executionCapabilitiesChanged(): void { this.ready = false; this.changed(); }
  /** Launcher stop is a user intent, not a transient network failure. Freeze
   * bound tasks before their streams detach; recovery must not revive a Host. */
  workerInstanceStopped(instanceId: string): void {
    if (this.closed) return;
    const tasks = this.store.taskTransaction(sql => sql.prepare(`SELECT t.id FROM bot_tasks t JOIN bot_metadata m ON m.key='native-host:worker-'||t.id
      WHERE m.value=? AND t.status IN ('queued','running','waiting','unknown')`).all(instanceId) as Array<{ id: string }>);
    for (const { id } of tasks) {
      const task = this.store.getTask(id); if (!task || task.extra.cancelRequested) continue;
      this.pauseForExecutor(task, 'stopped', '执行实例已关闭，任务已暂停；点击继续将启动原实例并恢复原任务。');
      this.taskRuns.get(id)?.controller.abort(Object.assign(new Error('执行实例已由用户关闭。'), { code: 'BOT_SUSPEND' }));
      this.toolServer.releaseWorker(`worker-${id}`);
    }
  }
  private changed(conversationId?: string): void {
    if (this.closed) return;
    this.emit({ type: 'changed', conversationId });
    for (const item of this.store.pendingOutbox()) { this.emit({ type: 'changed', conversationId: item.conversationId }); this.store.acknowledgeOutbox(item.id); }
  }
  private snapshot(conversationId?: string, before?: number): BotSnapshot {
    if (conversationId) this.prewarmSelectedMemory(conversationId);
    const page = conversationId ? this.store.messagesPage(conversationId, { limit: 80, before }) : { items: [], hasMore: false };
    const followups = conversationId ? this.companionRuntime.followupReceipts(conversationId, page.items.filter(message => message.senderId === 'user').map(message => message.id)) : new Map();
    const companions = this.store.listCompanions();
    if (this.presenceModelConfigured === undefined) {
      try { const model = this.options.model(); this.presenceModelConfigured = model.apiFormat === 'openai_chat' && !!model.model.trim() && !!model.apiKey.trim(); }
      catch { this.presenceModelConfigured = false; }
    }
    const presence = this.store.companionPresence(companions, this.presenceModelConfigured);
    const nextExpiry = Object.values(presence).flatMap(value => value.expiresAt ? [Date.parse(value.expiresAt)] : []).sort((a, b) => a - b)[0];
    if (nextExpiry !== this.presenceExpiryAt) {
      clearTimeout(this.presenceExpiry); this.presenceExpiryAt = nextExpiry;
      if (nextExpiry) { this.presenceExpiry = setTimeout(() => { this.presenceExpiryAt = undefined; this.changed(); }, Math.max(1, nextExpiry - Date.now())); this.presenceExpiry.unref?.(); }
    }
    return { companions, presence, conversations: this.store.conversations(), conversationActivity: this.store.conversationActivity(),
      ...(conversationId ? { brainContexts: Object.fromEntries(Object.entries(this.store.brainContextSummaries(conversationId, replyId => this.replyProgress.get(replyId)?.phase))
        .map(([id, context]) => [id, { ...context, agent: this.companionRuntime.identity(id) }])),
        taskSummary: this.taskRuntime.summary(conversationId) } : {}), messages: page.items.map(message => {
      const taskFollowup = followups.get(message.id);
      if (taskFollowup) return { ...message, taskFollowup };
      if (message.status !== 'running' && message.status !== 'queued') return message;
      const progress = this.replyProgress.get(message.id) ?? { phase: message.status === 'queued' ? 'queued' as const : 'preparing-context' as const };
      return { ...message, progress };
    }),
      tasks: this.taskRuntime.visibleTasks(conversationId).filter(task => !this.store.isRetiredDevelopmentDefault(task.companionId) && this.store.getConversation(task.conversationId)?.kind !== 'peer').map(task => {const card=this.taskRuntime.card(task,false);return this.store.getConversation(task.conversationId)?.dissolvedAt?this.archivedTaskCard(card):card;}), hasMore: page.hasMore,
      runtime: { engine: 'worldlinebox', memory: 'vcp-memory', embedding: 'EmbeddingGemma 2 · 内置 768 维', activeLanes: this.scheduler.runningCount,
        ready: this.ready, detail: this.detail, dataRoot: this.options.root, modelContext: this.options.modelLimits?.() } };
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
    })).catch(error => { if (!this.closed && (error as { code?: string })?.code !== 'BOT_COMPANION_INSTANCE_REQUIRED') this.options.report?.(error); })
      .finally(() => { this.memoryWarmRuns.delete(key); this.memoryWarmPhases.delete(key); });
    this.memoryWarmRuns.set(key, run);
  }
  private async controlCompanion(companionId: string, operation: 'start' | 'stop', signal: AbortSignal): Promise<void> {
    const companion = this.store.getCompanion(companionId); if (!companion) throw new Error('伙伴不存在。');
    if (operation === 'start') { await this.ensureCompanionBindings([companionId]); signal.throwIfAborted(); }
    // Fence admission before any asynchronous native shutdown. Starting does
    // not implicitly resume tasks the user previously paused or cancelled.
    this.store.setCompanionEnabled(companionId, operation === 'start'); this.changed();
    if (operation === 'stop') {
      const ids = this.store.taskTransaction(sql => sql.prepare("SELECT id FROM bot_inbox WHERE companion_id=? AND status IN ('queued','running')").all(companionId) as Array<{ id: string }>);
      for (const event of ids) this.scheduler.cancel(event.id);
      for (;;) {
        const tasks = this.store.taskTransaction(sql => sql.prepare("SELECT id FROM bot_tasks WHERE companion_id=? AND status IN ('queued','running','waiting','unknown') AND json_extract(extra_json,'$.removedAt') IS NULL ORDER BY id LIMIT 100").all(companionId) as Array<{ id: string }>);
        if (!tasks.length) break;
        for (const { id } of tasks) await this.controlTask(this.store.getTask(id)!, 'pause', undefined, `companion-stop:${randomUUID()}`, { caller: 'user' });
      }
      // Cleanup is separate from frozen business state; unrelated shared
      // environments and other companions are never stopped by this callback.
      await Promise.allSettled([...this.executorControlRuns.entries()].filter(([id]) => this.store.getTask(id)?.companionId === companionId).map(([, work]) => work));
      await Promise.allSettled([
        ...[...this.taskRuns.entries()].filter(([id]) => this.store.getTask(id)?.companionId === companionId).map(([, work]) => work.promise),
        ...[...this.taskControlRuns.entries(), ...this.taskAccessUpgrades.entries()].filter(([id]) => this.store.getTask(id)?.companionId === companionId).map(([, work]) => work),
        ...[...this.retirementRuns.entries()].filter(([id]) => this.store.getLane(id)?.companionId === companionId).map(([, work]) => work),
      ]);
    }
    try { await this.options.companionRuntime?.(companionId, companion.name, operation, signal); }
    finally { this.scheduler.wake(); this.changed(); }
  }
  /** Native cancellation may finish during this bounded close, not afterwards. */
  isCompanionStopping(companionId: string): boolean {
    return this.store.getCompanion(companionId)?.enabled === false && this.companionControls.has(companionId);
  }
  async handle(input: BotRequest): Promise<BotResponse> {
    await this.starting; if (this.closed) return { ok: false, error: '伙伴正在关闭。' };
    const archivedRoom='conversationId'in input&&typeof input.conversationId==='string'?this.store.getConversation(input.conversationId):undefined;
    if(archivedRoom?.dissolvedAt&&input.type!=='conversation.dissolve'&&!(archivedRoom.ownerId==='user'&&(input.type==='task.get'||input.type==='task.list'||input.type==='task.control'&&input.operation==='cancel')))throw new Error('这个群聊已经解散，访问权限已撤销。');
    if (archivedRoom?.kind === 'peer' && !['state', 'history.search', 'task.list', 'task.get', 'conversation.peer.join'].includes(input.type)) throw new Error('用户只能旁观伙伴私聊；如需参与，请另建群聊。');
    if (input.type.startsWith('memory.maintenance.')) {
      const request = input as BotMemoryMaintenanceRequest, room = this.store.getConversation(request.conversationId);
      if (!room?.memberIds.includes(request.companionId)) throw new Error('当前会话没有这位伙伴。');
      const memory = await this.memoryMaintenance.handle(request, { conversationId: room.id, companionId: request.companionId, securityDomainId: room.securityDomainId });
      this.maintainSafely(); return { ok: true, memory };
    }
    if ('conversationId' in input && input.conversationId && this.store.developmentDefaultCleanup()?.conversationIds.includes(input.conversationId)) throw new Error('旧开发伙伴会话已清理。');
    switch (input.type) {
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
      case 'conversation.create': { const conversation = this.store.createGroup({ title: input.title, kind: input.kind, memberIds: input.memberIds, participationMode: input.participationMode }); this.changed(conversation.id); return { ok: true, conversationId: conversation.id }; }
      case 'conversation.policy': this.store.setConversationPolicy(input.conversationId, input.participationMode); this.changed(input.conversationId); return { ok: true };
      case 'conversation.announcement': {
        this.store.setGroupAnnouncement({ ...input, actorId: 'user' }); this.changed(input.conversationId);
        return { ok: true, conversationId: input.conversationId };
      }
      case 'conversation.members':case 'conversation.dissolve':{
        const previous=this.store.getConversation(input.conversationId);
        const change=input.type==='conversation.members'?this.store.updateMembers(input.conversationId,input.memberIds):this.store.dissolveConversation(input.conversationId);
        for(const eventId of change.eventIds)this.scheduler.cancel(eventId);
        for(const taskId of change.taskIds)this.taskRuns.get(taskId)?.controller.abort(new Error('群聊权限已变化，停止旧任务。'));
        if(change.conversation.revision!==previous?.revision||change.conversation.dissolvedAt!==previous?.dissolvedAt)this.invalidateConversationDerived(input.conversationId);
        this.maintainSafely();this.changed(input.conversationId);return{ok:true,conversationId:input.conversationId};
      }
      case 'message.send': case 'world.event': {
        const conversation = this.store.getConversation(input.conversationId);
        if (!conversation?.memberIds.includes('user')) throw new Error('当前用户不能向这个会话发送消息。');
        if (!conversation.memberIds.some(id => id !== 'user' && this.store.getCompanion(id)?.enabled !== false)) throw new Error('伙伴已关闭，请先在能力管理中启用；消息草稿已保留。');
        await this.ensureConversationBindings(input.conversationId);
        if (input.type === 'message.send' && input.replyToTaskId && input.attachmentIds?.length) throw new Error('当前任务跟进支持文字；新附件请先作为单独消息发送并明确需要新的任务输入。');
        if (input.type === 'message.send' && input.replyToTaskId && (!input.content.trim() || input.content.length > 16000)) throw new Error('任务跟进需要1至16000字符的文字，请拆分发送；草稿已保留。');
        let attachments = input.type === 'message.send' && input.attachmentIds?.length ? await this.requireMedia().resolveForConversation(input.conversationId, input.attachmentIds) : undefined;
        if (attachments && this.options.transcribeAttachments) attachments = await this.options.transcribeAttachments(input.conversationId, attachments, input.requestId);
        if (!this.store.getConversation(input.conversationId)?.memberIds.includes('user')) throw Error('聊天权限已变化，已停止发送。');
        if (attachments) await this.ensureConversationBindings(input.conversationId); // File I/O may outlive a group membership or binding change.
        const followedTask = input.type === 'message.send' && input.replyToTaskId ? this.store.getTask(input.replyToTaskId) : undefined;
        const replayedFollowup = input.type === 'message.send' && input.replyToTaskId && this.store.taskTransaction(sql => sql.prepare(`SELECT 1 FROM bot_inbox
          WHERE conversation_id=? AND source_instance_id='worldlinebox' AND source_message_id=? AND source='user' AND json_extract(payload_json,'$.taskFollowup.taskId')=? LIMIT 1`)
          .get(input.conversationId, input.requestId, input.replyToTaskId));
        if (input.type === 'message.send' && input.replyToTaskId && (!followedTask || followedTask.conversationId !== input.conversationId
          || !replayedFollowup && !this.companionRuntime.followupAvailable(followedTask))) throw new Error('跟进需要当前会话中原授权仍有效且未被用户停止的真实任务。');
        if (input.type === 'message.send' && !this.store.ingressExists(input.conversationId, input.requestId)) for (const id of this.store.interruptGroup(input.conversationId, isGroupStop(input.content))) this.scheduler.cancel(id);
        const result = this.store.enqueue({ conversationId: input.conversationId, senderId: input.type === 'world.event' ? 'world' : 'user',
          source: input.type === 'world.event' ? 'world' : 'user', sourceMessageId: input.requestId, content: input.content,
          attachments, kind: input.type === 'world.event' ? 'world_observation' : 'message',
          ...(followedTask ? { recipientIds: [followedTask.companionId], payload: { taskFollowup: { taskId: followedTask.id } } } : {}) });
        if (input.type === 'message.send') for (const event of result.events) this.memoryMaintenance.userMessage(scopeFor(event), !/^(你好|谢谢|好的|嗯|hi|hello|thanks)[!！。 .]*$/iu.test(input.content.trim()));
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
        this.scheduler.cancel(event.id); this.changed(event.conversationId); return { ok: true };
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
            if (this.store.enqueueLegacyCaptureBackfill(scope, BOT_MEMORY_CAPTURE_POLICY).queued) this.maintainSafely();
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
      case 'task.list': {const page=this.taskRuntime.page({...input,...(archivedRoom?.dissolvedAt || archivedRoom?.kind === 'peer'?{query:undefined}:{})});return{ok:true,taskPage:archivedRoom?.kind === 'peer'?{...page,items:page.items.map(task=>this.observerTaskCard(task))}:archivedRoom?.dissolvedAt?{...page,items:page.items.map(task=>this.archivedTaskCard(task))}:page};}
      case 'task.get': {
        const limited = !!archivedRoom?.dissolvedAt || archivedRoom?.kind === 'peer';
        const task = limited?this.store.getTaskStatus(input.taskId):this.store.getTask(input.taskId); if (!task || task.conversationId !== input.conversationId) throw new Error('任务不属于当前聊天。');
        if (task.extra.removedAt) return { ok: true, taskRemoved: true };
        const card=this.taskRuntime.card(task,!limited);return { ok: true, task:archivedRoom?.kind === 'peer'?this.observerTaskCard(card):archivedRoom?.dissolvedAt?this.archivedTaskCard(card):card };
      }
      case 'task.queue.control': return { ok: true, memory: await this.controlQueue(input.conversationId, input.operation, input.requestId, input.companionId) };
      case 'task.control': {
        const task = this.store.getTask(input.taskId); if (!task || task.conversationId !== input.conversationId) throw new Error('任务不属于当前会话。');
        return { ok: true, memory: await this.controlTask(task, input.operation, input.text, input.requestId, { caller: 'user',
          questionId: input.questionId, answers: input.answers, effectResolutions: input.effectResolutions }) };
      }
    }
    throw new Error('未识别的伙伴请求。');
  }
  private archivedTaskCard(task:ReturnType<BotTaskRuntime['card']>):ReturnType<BotTaskRuntime['card']>{
    const active=!['succeeded','failed','cancelled'].includes(task.status),stopping=active&&task.cancelRequested;
    return{id:task.id,conversationId:task.conversationId,companionId:task.companionId,goal:'已解散群聊的后台任务',title:'已解散群聊的后台任务',status:task.status,
      createdAt:task.createdAt,updatedAt:task.updatedAt,cancelRequested:task.cancelRequested,stopRequestedAt:task.stopRequestedAt,continuationAvailable:false,followupAvailable:false,
      progress:{phase:stopping?(task.progress?.phase==='stop-unconfirmed'?'stop-unconfirmed':'stopping'):task.status,
        detail:active?'此群聊已解散，仅可查看停止状态或重新核实停止。':'原任务已结束，群聊资料访问权限已撤销。',updatedAt:task.progress?.updatedAt??task.updatedAt}};
  }
  private observerTaskCard(task: ReturnType<BotTaskRuntime['card']>): ReturnType<BotTaskRuntime['card']> {
    return { id: task.id, conversationId: task.conversationId, companionId: task.companionId, companionName: task.companionName,
      goal: '伙伴私聊中的任务', title: '伙伴私聊中的任务', status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt,
      continuationAvailable: false, progress: { phase: task.status, detail: '仅旁观任务状态，不能修改或停止。', updatedAt: task.updatedAt } };
  }
  private async mutateMemory(scope: BotMemoryScope, operation: 'update' | 'organize', input: BotMemoryUpdate | BotMemoryOrganize, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.store.setMetadata(`memory-capture-backfill-v2-suppressed:${digest(JSON.stringify([scope.companionId, scope.securityDomainId]))}`, input.operationId);
    const result = operation === 'update' ? await this.options.memory.update(scope, input as BotMemoryUpdate, signal)
      : await this.options.memory.organize(scope, input as BotMemoryOrganize, signal);
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
  /** Recovery reads the original VCP operation journal. It never invokes a new
   * write just to discover whether the previous call had an effect. */
  async reconcileToolReceipt(call: BotToolCall, signal?: AbortSignal): Promise<AppToolReconciliation> {
    const key = `effect:${call.eventId}:${call.callId}`, fingerprint = digest(JSON.stringify([call.name, call.args]));
    const saved = this.store.getMetadata(key);
    if (saved) { const receipt = JSON.parse(saved) as { fingerprint: string; result: unknown };
      if (receipt.fingerprint !== fingerprint) throw new Error('主脑工具回执参数不匹配。');
      return { state: 'committed', result: receipt.result };
    }
    if (!['memory_write', 'memory_update', 'memory_organize', 'memory_maintenance', 'companion_contact', 'companion_reply_user', 'companion_delegate', 'companion_delegation', 'dsh_task_control', 'dsh_plan', 'dsh_task'].includes(call.name)) return { state: 'unknown' };
    const event = this.store.getEvent(call.eventId), lane = event && this.store.getLane(event.laneId);
    const originalEpoch = event && this.store.getEventNativeEpoch(event.id);
    const originalLane = event && originalEpoch !== undefined ? originalEpoch === 1 ? event.laneId : `${event.laneId}-epoch-${originalEpoch}` : undefined;
    const recoveryFloor = lane && Number(this.store.getMetadata(`native-recovery-floor:${lane.id}`) ?? lane.epoch);
    if (!event || !lane || originalLane !== call.laneId
      || originalEpoch === undefined || !Number.isSafeInteger(recoveryFloor) || originalEpoch < recoveryFloor! || originalEpoch > lane.epoch
      || this.store.withdrawnIn(event.companionId, event.securityDomainId, [event.id, event.sourceMessageRecordId]).size) return { state: 'unknown' };
    const conversation = this.store.getConversation(event.conversationId);
    if (!conversation || conversation.revision !== event.aclRevision || !conversation.memberIds.includes(event.companionId)) return { state: 'unknown' };
    if(call.name==='companion_delegate'){
      const proxy=this.store.getTask(`task-${digest(`${event.id}:${call.callId}`).slice(0,48)}`);
      // File copies alone have no message grant and cannot execute. The proxy,
      // peer delivery, mandate and ticket commit in one SQLite transaction.
      if(!proxy)return {state:'absent'};
      if(proxy.extra.dispatchFingerprint!==digest(JSON.stringify(call.args))||typeof proxy.extra.externalDelegationId!=='string')return {state:'unknown'};
      const ticket=this.delegations.scoped(event,proxy.extra.externalDelegationId);
      const result={delegationId:ticket.id,taskId:proxy.id,recipientId:ticket.recipientId,status:proxy.status};
      this.store.setMetadata(key,JSON.stringify({fingerprint,result}));return {state:'committed',result};
    }
    if(call.name==='companion_delegation'){
      if(call.args.operation==='status')return {state:'absent'};
      const id=typeof call.args.delegationId==='string'?call.args.delegationId:this.delegations.forEvent(event)?.id;
      if(!id)return {state:'absent'};
      this.delegations.scoped(event,id);
      const command=this.store.getMetadata(`delegation-tool:${event.id}:${call.callId}`);
      if(command){const receipt=JSON.parse(command);if(receipt.fingerprint!==digest(JSON.stringify(call.args)))return {state:'unknown'};
        this.store.setMetadata(key,JSON.stringify({fingerprint,result:receipt.result}));return {state:'committed',result:receipt.result};}
      if(call.args.operation==='result'){
        const proof=this.delegations.resultReceipt(id,digest(`${event.id}:${call.callId}`));
        if(!proof)return {state:'absent'}; // Publication, receipt and finish are one atomic transaction.
        return {state:'unknown'}; // A result without its original argument binding cannot prove this call.
      }
      const saved=this.store.getMetadata(`delegation-control:${id}:${digest(`${event.id}:${call.callId}`)}`);
      if(!saved)return {state:'absent'};
      const receipt=JSON.parse(saved);if(receipt.fingerprint!==digest(JSON.stringify([call.args.operation,call.args.message??''])))return {state:'unknown'};
      this.store.setMetadata(key,JSON.stringify({fingerprint,result:receipt.result}));return {state:'committed',result:receipt.result};
    }
    if (call.name === 'dsh_plan') {
      if (call.args.operation === 'status') return { state: 'absent' };
      const proof = this.workflows.receipt(event, call.callId, call.args); if (proof.state === 'absent') return proof;
      // The durable cancellation intent closes the graph immediately. Resume
      // only its idempotent fan-out if a crash lost the outer tool receipt.
      if (call.args.operation === 'cancel') for (const taskId of this.workflows.cancel(event, proof.planId, call.callId)) {
        const task = this.store.getTask(taskId); if (task) await this.controlTask(task, 'cancel', undefined, `${event.id}:${call.callId}:${taskId}`, { caller: 'brain', source: event.source, sourceEventId: event.id });
      }
      const result = this.workflows.status(event, proof.planId); this.store.setMetadata(key, JSON.stringify({ fingerprint, result })); return { state: 'committed', result };
    }
    if (call.name === 'dsh_task') {
      const task = this.store.getTask(`task-${digest(`${event.id}:${call.callId}`).slice(0, 48)}`);
      if (!task) return { state: 'absent' };
      if (task.sourceEventId !== event.id || task.companionId !== event.companionId || task.conversationId !== event.conversationId
        || task.extra.dispatchFingerprint !== digest(JSON.stringify(call.args))) return { state: 'unknown' };
      const result = { taskId: task.id, mandateId: this.companionRuntime.mandate(task.id)?.id, status: task.status,
        ...(typeof task.extra.delegationId === 'string' ? { delegationId: task.extra.delegationId, resultDelivery: 'companion_delegation.result' } : {}),
        meaning: '原任务提交已经持久保存；读取真实状态，不重复派发。' };
      this.store.setMetadata(key, JSON.stringify({ fingerprint, result })); return { state: 'committed', result };
    }
    if (call.name === 'memory_write') {
      if (this.toolRuns.has(key)) return { state: 'unknown' };
      const input = { content: nonempty.parse(call.args.content), sourceEventId: `${event.id}:${call.callId}`,
        sourceRootEventId: event.id, sourceMessageIds: [event.sourceMessageRecordId, event.replyMessageId] };
      const proof = await this.options.memory.rememberReceipt(scopeFor(event), input, signal);
      if (proof.found === false) return { state: 'absent' };
      const receipt = proof.receipt as Record<string, unknown> | undefined;
      if (!receipt || receipt.state === 'unknown') return { state: 'unknown' };
      if (receipt.state === 'pending') this.store.enqueueMemoryJob({ key: `index:${input.sourceEventId}`, kind: 'mutation', payload: { scope: scopeFor(event), operation: 'remember', input } });
      this.store.setMetadata(key, JSON.stringify({ fingerprint, result: receipt }));
      return { state: 'committed', result: receipt };
    }
    if (call.name === 'dsh_task_control') {
      // A cancelled HTTP callback may still be applying its original operation.
      // Missing a receipt is proof of absence only after that callback quiesces.
      if (this.toolRuns.has(key)) return { state: 'unknown' };
      const proof = this.reconcileTaskControlReceipt(event, call);
      if (proof.state === 'committed') this.store.setMetadata(key, JSON.stringify({ fingerprint, result: proof.result }));
      return proof;
    }
    if (call.name === 'companion_contact') {
      const proof = this.store.getMetadata(`peer-contact-receipt:${event.id}:${call.callId}`);
      if (!proof) return { state: 'absent' };
      const receipt = JSON.parse(proof) as { recipientId: string; conversationId: string; destination?: 'user' | 'peer'; fingerprint?: string };
      if (receipt.recipientId !== call.args.companionId || receipt.destination && receipt.destination !== call.args.destination) throw new Error('联系伙伴回执参数不匹配。');
      if (receipt.fingerprint !== undefined) {
        const destination = z.enum(['user', 'peer']).parse(call.args.destination), message = z.string().trim().min(1).max(4000).parse(call.args.message);
        if (receipt.fingerprint !== digest(JSON.stringify([receipt.recipientId, destination, message]))) throw new Error('联系伙伴回执内容不匹配。');
      }
      const result = this.contactReceipt(receipt.conversationId, receipt.recipientId, receipt.destination);
      this.store.setMetadata(key, JSON.stringify({ fingerprint, result })); return { state: 'committed', result };
    }
    if (call.name === 'companion_reply_user') {
      if (this.toolRuns.has(key)) return { state: 'unknown' };
      const result = this.store.peerReplyReceipt(event.id, call.callId, z.string().trim().min(1).max(24000).parse(call.args.message));
      if (!result) return { state: 'absent' };
      this.store.setMetadata(key, JSON.stringify({ fingerprint, result })); return { state: 'committed', result };
    }
    if (call.name === 'memory_maintenance') {
      if (!this.companionRuntime.workAuthority(event) || call.args.operation !== 'plan') return { state: 'unknown' };
      const proof = this.memoryMaintenance.journal.toolReceipt(scopeFor(event), z.enum(['organize', 'dream']).parse(call.args.kind ?? 'organize'), `${event.id}:${call.callId}`);
      if (!proof.found) return { state: 'absent' };
      this.store.setMetadata(key, JSON.stringify({ fingerprint, result: proof.result })); return { state: 'committed', result: proof.result };
    }
    const operation = call.name === 'memory_update' ? 'update' : 'organize', input = this.memoryMutationInput(event, call);
    const proof = await this.options.memory.operationReceipt(scopeFor(event), operation, input, signal);
    if (proof.found === false) return { state: 'absent' };
    const receipt = proof.receipt && typeof proof.receipt === 'object' ? proof.receipt as Record<string, unknown> : undefined;
    if (!receipt || receipt.state === 'unknown') return { state: 'unknown' };
    this.store.clearMemoryInspections(event.companionId, event.securityDomainId);
    if (receipt.state === 'pending' || receipt.state === 'partial') this.store.enqueueMemoryJob({ key: input.operationId, kind: 'mutation', payload: { scope: scopeFor(event), operation, input } });
    this.store.setMetadata(key, JSON.stringify({ fingerprint, result: receipt }));
    return { state: 'committed', result: receipt };
  }
  /** Read the task controller's original durable intent/result. This method
   * neither contacts DSH nor reissues a mutation to discover its outcome. */
  private reconcileTaskControlReceipt(event: BotEvent, call: BotToolCall): AppToolReconciliation {
    const args = call.args, operation = String(args.operation), requestId = `${event.id}:${call.callId}`;
    // Unknown operations are rejected before any task control can run.
    if (!['status', 'send', 'cancel', 'answer', 'continue', 'pause', 'resume_paused', 'remove', 'list', 'cancel_queued', 'cancel_all', 'clear_finished'].includes(operation)) return { state: 'absent' };
    if (operation === 'status' || operation === 'list') return { state: 'absent' };
    if (operation === 'remove' || operation === 'clear_finished') {
      const taskId = operation === 'remove' && typeof args.taskId === 'string' ? args.taskId : undefined;
      if (operation === 'remove' && !taskId) return { state: 'absent' };
      if (taskId) { const task = this.store.getTask(taskId); if (!task || task.conversationId !== event.conversationId || task.companionId !== event.companionId) return { state: 'absent' }; }
      const saved = this.store.getMetadata(`task-history-clear:${digest(JSON.stringify([event.conversationId, requestId]))}`);
      if (!saved) return { state: 'absent' };
      const receipt = JSON.parse(saved) as { fingerprint: string; result?: unknown };
      if (receipt.fingerprint !== digest(JSON.stringify([event.conversationId, taskId ?? null, event.companionId]))) throw new Error('任务清理回执参数不匹配。');
      // An unfinished clear has an independent durable recovery queue. Preserve
      // its pending state rather than claiming all records were already removed.
      return { state: 'committed', result: receipt.result ?? { accepted: true, pending: true, recordsOnly: true, meaning: '原清理请求已保存，后台将继续清理；尚未确认全部完成。' } };
    }
    if (operation === 'cancel_queued' || operation === 'cancel_all') {
      const saved = this.store.getMetadata(`task-queue-control:${event.conversationId}:${requestId}`);
      if (!saved) return { state: 'absent' };
      const receipt = JSON.parse(saved) as { fingerprint: string; ids: string[] };
      if (receipt.fingerprint !== digest(JSON.stringify({ operation, companionId: event.companionId })) || !Array.isArray(receipt.ids)) throw new Error('任务队列回执参数不匹配。');
      const items = receipt.ids.map(taskId => {
        const task = this.store.getTask(taskId);
        if (!task || task.companionId !== event.companionId || task.conversationId !== event.conversationId) return { taskId, cancellation: 'unconfirmed' };
        const recorded = !!this.store.getMetadata(`task-cancel:${taskId}:${requestId}:${taskId}`);
        return { taskId, status: task.status, cancellation: task.status === 'cancelled' ? 'confirmed'
          : ['succeeded', 'failed'].includes(task.status) ? 'already-finished' : recorded ? 'pending' : 'not-requested' };
      });
      const count = (state: string) => items.filter(item => item.cancellation === state).length;
      const remaining = count('not-requested') + count('unconfirmed');
      return { state: 'committed', result: { accepted: remaining === 0, partial: remaining > 0, affected: items.length,
        cancelled: count('confirmed'), finished: count('already-finished'), pending: count('pending'), notRequested: count('not-requested'), unconfirmed: count('unconfirmed'), items,
        meaning: remaining ? '原队列操作中断，回执列出已停止和未处理的任务；未重新执行或扩大范围。' : '原队列停止操作已完成。' } };
    }
    const task = typeof args.taskId === 'string' ? this.store.getTask(args.taskId) : undefined;
    // Task identity/ownership never migrate and cleanup retains a minimal row.
    // A foreign/missing task was rejected before reaching any mutation.
    if (!task || task.companionId !== event.companionId) return { state: 'absent' };
    if (task.conversationId !== event.conversationId) {
      if (!['send', 'cancel'].includes(operation) || event.source !== 'user') return { state: 'absent' };
      const origin = this.store.getConversation(task.conversationId), current = this.store.getConversation(event.conversationId);
      // Reconcile the original control even after cancel withdrew its mandate.
      // A revoked audience is uncertainty, never evidence the write was absent.
      if (current?.kind !== 'direct' || !current.memberIds.includes('user') || !origin || origin.dissolvedAt
        || !['direct', 'group'].includes(origin.kind) || !origin.memberIds.includes('user') || !origin.memberIds.includes(event.companionId)) return { state: 'unknown' };
    }
    if (operation === 'answer') {
      const saved = this.store.taskTransaction(sql => sql.prepare('SELECT kind,fingerprint,result_json FROM bot_task_controls WHERE task_id=? AND request_id=?').get(task.id, requestId)) as { kind: string; fingerprint: string; result_json: string } | undefined;
      if (!saved) return { state: task.extra.removedAt ? 'unknown' : 'absent' };
      const answers = args.answers === undefined ? undefined : z.array(botTaskAnswerSchema).min(1).parse(args.answers);
      const fingerprint = digest(JSON.stringify({ kind: 'answer', text: typeof args.text === 'string' ? args.text : undefined,
        questionId: typeof args.questionId === 'string' ? args.questionId : undefined, answers, effectResolutions: undefined }));
      if (saved.kind !== 'answer' || saved.fingerprint !== fingerprint) throw new Error('任务回答回执参数不匹配。');
      const result = JSON.parse(saved.result_json) as { accepted?: boolean };
      const selected = event.payload.taskFollowup as { taskId?: string } | undefined;
      if (result.accepted === true && selected?.taskId === task.id) this.companionRuntime.deliveredFollowup(event, task.id);
      return { state: 'committed', result };
    }
    if (operation === 'send') {
      const saved = this.store.getMetadata(`task-control:${task.id}:${requestId}`);
      const pending = (Array.isArray(task.extra.pendingControls) ? task.extra.pendingControls as Array<{ id: string; text: string }> : []).find(item => item.id === requestId);
      const continuation = task.extra.taskContinuation as { id?: string; text?: string } | undefined;
      const continued = continuation?.id === requestId ? continuation : undefined;
      if (!saved && !pending && !continued) return { state: task.extra.removedAt ? 'unknown' : 'absent' };
      const content = z.string().trim().min(1).max(16000).parse(args.text);
      const receipt = saved ? JSON.parse(saved) as { fingerprint: string; state: string } : undefined;
      if (receipt && receipt.fingerprint !== digest(content) || pending && pending.text !== content || continued && continued.text !== content) throw new Error('任务指导回执参数不匹配。');
      return { state: 'committed', result: { taskId: task.id, accepted: true, delivery: receipt?.state === 'sent' ? 'sent' : 'pending',
        meaning: receipt?.state === 'sent' ? '原指导已由执行器接收；未重复发送。' : '原指导请求已持久保存，等待执行器接收；未重复发送。' } };
    }
    if (['cancel', 'pause', 'resume_paused', 'continue'].includes(operation)) {
      const saved = this.store.getMetadata(`task-${operation}:${task.id}:${requestId}`);
      if (!saved) return { state: task.extra.removedAt ? 'unknown' : 'absent' };
      if (operation === 'cancel' && task.extra.humanStopped && task.status !== 'cancelled') return { state: 'committed', result: { taskId: task.id, accepted: true,
        status: task.status, humanStopped: true, followupAvailable: false, confirmed: true, meaning: '后续接续授权已经撤回，保留此前真实业务结果。' } };
      return { state: 'committed', result: { taskId: task.id, accepted: true, status: task.status,
        ...(operation === 'cancel' ? { cancelRequested: true, confirmed: task.status === 'cancelled' }
          : operation === 'pause' ? { paused: task.status === 'paused' } : {}),
        meaning: '原任务控制请求已持久保存；当前状态来自实际任务记录，未重复执行。' } };
    }
    return { state: 'unknown' };
  }
  private contactReceipt(conversationId: string, recipientId: string, destination?: 'user' | 'peer') {
    const room = this.store.getConversation(conversationId);
    // Old receipts describe the old real room even if a caller now supplies a
    // new destination. Recovery must never relabel or redeliver a prior effect.
    const actual = room?.kind === 'peer' ? destination === 'user' ? 'user' : 'peer'
      : destination === 'user' && room?.kind === 'direct' ? 'legacy-user-direct' : 'legacy-group';
    return { sent: true, conversationId, recipientId, destination: actual, conversationKind: room?.kind,
      meaning: actual === 'user' ? '已在双方伙伴私聊中真实转达；目标可用一次宿主授权以本人身份向用户发消息，尚未代表目标回复。'
        : actual === 'peer' ? '已转达到仅双方伙伴参加的私聊；用户可以旁观，不能冒充成员发言。'
          : actual === 'legacy-user-direct' ? '历史回执确认过去已投递到目标与用户的私聊；本次未重新投递。'
          : '历史回执确认已投递到原伙伴群聊；未重新投递，也未转换原会话。' };
  }
  private memoryMessages(event: BotEvent, through = event.sourceMessageSequence): BotMemoryMessage[] {
    const history = this.store.recentPublishedMessages(event.conversationId, { throughSourceSequence: through, limit: 80, maxChars: DEFAULT_MODEL_CONTEXT_CHARS });
    const source = this.store.getMessage(event.sourceMessageRecordId);
    if (source && !history.some(message => message.id === source.id)) history.push(source);
    const withdrawn = this.store.withdrawnIn(event.companionId, event.securityDomainId, history.map(message => message.id));
    return history.filter(message => !withdrawn.has(message.id)).map(message => ({
      id: message.id, role: message.senderId === event.companionId ? 'assistant' : 'user', content: botMessageEvidence(message),
      timestamp: Date.parse(message.createdAt), senderId: message.senderId, senderName: message.senderName,
    }));
  }
  private nativeLaneId(laneId: string): string {
    const epoch = this.store.getLane(laneId)?.epoch ?? 1;
    return epoch === 1 ? laneId : `${laneId}-epoch-${epoch}`;
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
        const receipt = await this.options.memory.withdrawSources(scope, { sourceEventIds: [...new Set(page.items.flatMap(item => item.eventIds))], sourceMessageIds: page.items.map(item => item.messageId) }, this.maintenanceAbort.signal);
        this.applyWithdrawal(scope, receipt, currentEventId);
        after = page.items.at(-1)!.sequence;
        this.store.setMetadataBatch([{ key: `withdrawal-revision:${digest(JSON.stringify([scope.companionId, scope.securityDomainId]))}`, value: receipt.revision }, { key: cursorKey, value: String(after) }]);
      }
      if (!page.items.length) return;
    }
  }
  private applyWithdrawal(scope: BotMemoryScope, sources: { revision?: string; sourceEventIds: string[]; sourceMessageIds: string[] }, currentEventId?: string): void {
    const key = `withdrawal-revision:${digest(JSON.stringify([scope.companionId, scope.securityDomainId]))}`;
    const revisionChanged = sources.revision !== undefined && sources.revision !== '0' && this.store.getMetadata(key) !== sources.revision;
    const changed = this.store.withdrawSources(scope.companionId, scope.securityDomainId, [...sources.sourceEventIds, ...sources.sourceMessageIds]);
    if (!changed && revisionChanged) this.store.rotateDomain(scope.companionId, scope.securityDomainId);
    if (sources.revision !== undefined) this.store.setMetadata(key, sources.revision);
    if (changed || revisionChanged) {
      this.loadedTombstones.delete(digest(JSON.stringify([scope.companionId, scope.securityDomainId])));
      this.memoryMaintenance.invalidate(scope);
      this.store.clearMemoryInspections(scope.companionId, scope.securityDomainId);
      for (const active of this.store.activeDomainEvents(scope.companionId, scope.securityDomainId)) if (active.id !== currentEventId || this.store.getMetadata(`native-admission:${active.id}`)) {
        this.store.cancelEvent(active.id, true); this.scheduler.cancel(active.id);
      }
      for (const task of this.store.activeDomainTasks(scope.companionId, scope.securityDomainId)) if (this.store.taskSourcesWithdrawn(task.id)) {
        this.store.updateTask(task.id, { extra: { ...task.extra, cancelRequested: true, retryAt: 0 } });
        this.taskRuns.get(task.id)?.controller.abort(new Error('任务来源已撤回。'));
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
  private deliveredMessages(laneId: string, nativeLaneId: string): string[] {
    const saved = this.store.getMetadata(`delivered:${laneId}`); if (!saved) return [];
    const receipt = JSON.parse(saved) as { nativeLaneId: string; ids: string[] };
    return receipt.nativeLaneId === nativeLaneId ? receipt.ids.slice(-400) : [];
  }
  private deliveryMetadata(event: BotEvent, dispatch: NativeDispatch | undefined, committed?: boolean): Array<{ key: string; value: string }> {
    if (!dispatch || committed === false) return [];
    const history = dispatch.deliveredMessageIds ?? (JSON.parse(dispatch.prompt).history as Array<{ id: string }> | undefined)?.map(message => message.id) ?? [];
    const ids = [...new Set([...this.deliveredMessages(event.laneId, dispatch.nativeLaneId), ...history, event.sourceMessageRecordId, event.replyMessageId])].slice(-400);
    return [{ key: `delivered:${event.laneId}`, value: JSON.stringify({ nativeLaneId: dispatch.nativeLaneId, ids }) },
      { key: botHostHistoryRebuildKey(event.laneId), value: '' }];
  }
  /** Coalesce one public-message assessment across recipients. It uses an
   * isolated App lane and no tools, private memories, VCP startup or DSH. The
   * immutable input and result survive retries, so another recipient does not
   * pay for or randomize the same decision again. */
  private async acceptsGroupMessage(event: BotEvent, signal: AbortSignal): Promise<boolean> {
    const room = this.store.getConversation(event.conversationId);
    if (!room || room.dissolvedAt || room.revision !== event.aclRevision || !room.memberIds.includes(event.companionId)) return false;
    const sources = this.store.eventSourceIds(event.id);
    if (this.store.withdrawnIn(event.companionId, event.securityDomainId, sources).size) return false;
    const announcementVersion = room.announcement?.updatedAt;
    // A fresh public announcement is part of participation context. Never
    // replay a frozen judge prompt/decision from an older announcement.
    const key = `group-attention:${event.sourceMessageRecordId}:${event.aclRevision}${announcementVersion ? ':announcement:' + announcementVersion : ''}`;
    let run = this.groupAttentionRuns.get(key);
    if (!run) {
      const saved = this.store.getMetadata(key);
      if (saved) { const decision = parseGroupAttention(saved, room.memberIds); this.store.resolveGroupCandidates(event.sourceMessageRecordId, decision.recipients); return decision.recipients.includes(event.companionId); }
      const controller = new AbortController(), assessmentSignal = AbortSignal.any([this.maintenanceAbort.signal, controller.signal]);
      this.groupAttentionAborts.set(key, controller);
      run = (async () => {
        const inputKey = `${key}:input`, previous = this.store.getMetadata(inputKey);
        const actors = this.store.groupCandidates(event.sourceMessageRecordId).flatMap(id => { const actor = this.store.getCompanion(id); return actor && id !== event.senderId
          ? [{ id: actor.id, name: actor.name, role: actor.persona.slice(0, 400) }] : []; });
        const withdrawn = (ids: string[]) => actors.some(actor => this.store.withdrawnIn(actor.id, room.securityDomainId, ids).size > 0);
        if (withdrawn(sources)) return { recipients: [], reason: '消息来源已撤回。' };
        const configured = this.options.model(), limits = resolveBotModelLimits(configured);
        const model = { ...configured, maxTokens: Math.max(1, Math.min(2048, limits.maxTokens, configured.maxOutputTokens ?? Number.MAX_SAFE_INTEGER, Math.floor(limits.window / 8))) };
        const history = this.store.recentPublishedMessages(room.id, { throughSourceSequence: Number.MAX_SAFE_INTEGER, limit: 16, maxChars: 9000 })
          .filter(message => !withdrawn(this.store.messageSourceIds(message.id)));
        let prompt = previous;
        if (prompt) {
          const frozen = JSON.parse(prompt) as { history: Array<{ id: string }> };
          if (frozen.history.some(message => withdrawn(this.store.messageSourceIds(message.id)))) return { recipients: [], reason: '原判断上下文已撤回。' };
        } else for (const scale of [1, 0.5, 0.2, 0]) {
          const chars = Math.max(128, Math.floor(12000 * scale)), excerpt = event.content.length > chars;
          const announcementChars = Math.max(128, Math.floor(4000 * scale)), announcement = room.announcement;
          const noticeText = announcement ? Array.from(announcement.text) : [];
          prompt = JSON.stringify({ conversation: { id: room.id, title: room.title,
            ...(announcement ? { announcement: { text: noticeText.slice(0, announcementChars).join(''), updatedAt: announcement.updatedAt,
              ...(noticeText.length > announcementChars ? { contentIsPreview: true } : {}) } } : {}) }, members: actors.map(actor => ({ ...actor, role: actor.role.slice(0, Math.floor(400 * scale)) })),
            trigger: { id: event.sourceMessageRecordId, senderId: event.senderId, senderName: event.senderName,
              content: excerpt ? event.content.slice(0, Math.floor(chars * 0.7)) + '\n[节选]\n' + event.content.slice(-Math.floor(chars * 0.3)) : event.content, contentIsExcerpt: excerpt },
            history: history.slice(-Math.floor(16 * scale)).filter(() => scale > 0).map(message => ({ id: message.id, senderId: message.senderId, senderName: message.senderName,
              content: botMessageEvidence(message).slice(0, Math.floor(2000 * scale)) })) });
          if (fitsAppBrainRequest(appBrainRequest(model, GROUP_ATTENTION_SYSTEM, [{ role: 'user', content: prompt }], [], true), model)) break;
        }
        if (!prompt || !fitsAppBrainRequest(appBrainRequest(model, GROUP_ATTENTION_SYSTEM, [{ role: 'user', content: prompt }], [], true), model)) throw new Error('当前模型窗口不足以完成群聊参与判断。');
        if (!previous) this.store.setMetadata(inputKey, prompt);
        const laneId = `group-attention-${digest(key)}`, cwd = path.join(this.options.root, 'group-attention');
        await mkdir(cwd, { recursive: true });
        const result = await abortable(this.options.brain.run({ laneId, eventId: laneId, role: 'brain', cwd, system: GROUP_ATTENTION_SYSTEM, prompt,
          model, tools: [], callback: await this.toolServer.start(), signal: assessmentSignal }), assessmentSignal);
        assessmentSignal.throwIfAborted();
        if (result.status !== 'succeeded') throw new Error('群聊参与判断暂时未完成。');
        const decision = parseGroupAttention(result.text, actors.map(actor => actor.id));
        const current = this.store.getConversation(room.id);
        if (!current || current.dissolvedAt || current.revision !== room.revision || current.announcement?.updatedAt !== announcementVersion) return { recipients: [], reason: '群成员或公告已经变更。' };
        this.store.setMetadata(key, JSON.stringify(decision));
        this.store.resolveGroupCandidates(event.sourceMessageRecordId, decision.recipients);
        if (event.source === 'user' || event.source === 'gateway') this.store.setMetadata(`group-discussion:${room.id}:${event.correlationId}`, decision.continueDiscussion ? '1' : '0');
        return decision;
      })().finally(() => { this.groupAttentionRuns.delete(key); this.groupAttentionAborts.delete(key); });
      this.groupAttentionRuns.set(key, run);
    }
    // Cancelling one recipient must not abort the shared assessment of others.
    const decision = await new Promise<GroupAttentionDecision>((resolve, reject) => {
      const abort = () => {
        if (!this.closed && !this.store.hasPendingSource(event.sourceMessageRecordId)) this.groupAttentionAborts.get(key)?.abort(signal.reason);
        reject(signal.reason);
      }; signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      run!.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    signal.throwIfAborted(); return !this.store.withdrawnIn(event.companionId, event.securityDomainId, sources).size && decision.recipients.includes(event.companionId);
  }
  private async respond(claim: BotClaim, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const event = claim.event, companion = this.store.getCompanion(event.companionId);
    const grouped = ['group', 'peer'].includes(this.store.getConversation(event.conversationId)?.kind ?? '');
    const contextThrough = grouped ? this.store.publishedWatermark(event.conversationId) : event.sourceMessageSequence;
    if (!companion) throw new Error('伙伴不存在。');
    if (companion.enabled === false) { this.scheduler.cancel(event.id); return; }
    // Queued callbacks are historical receipts, never fresh authorization.
    // Do not wake the Router or memory encoder for obsolete task reminders.
    if (event.source === 'task' && typeof event.payload.taskId === 'string') {
      const task = this.store.getTask(event.payload.taskId);
      const stopped = !task || task.extra.removedAt || task.extra.cancelRequested || task.extra.humanStopped || task.status === 'cancelled';
      const finishedProgress = event.kind === 'task_progress' && task && ['succeeded', 'failed'].includes(task.status);
      const questionId = typeof event.payload.attention === 'string' && event.payload.attention.startsWith('question:') ? event.payload.attention.slice(9) : undefined;
      const question = questionId ? this.taskRuntime.attention(event.payload.taskId, questionId) : undefined;
      const outdatedQuestion = questionId && (question?.id !== questionId || question.state !== 'queued');
      const delegatedQuestion=typeof event.payload.delegationTaskId==='string'&&typeof event.payload.delegationQuestionId==='string'
        ?this.taskRuntime.attention(event.payload.delegationTaskId,event.payload.delegationQuestionId):undefined;
      const outdatedDelegatedQuestion=typeof event.payload.delegationQuestionId==='string'&&(delegatedQuestion?.id!==event.payload.delegationQuestionId||delegatedQuestion.state!=='queued');
      if (stopped || finishedProgress || outdatedQuestion || outdatedDelegatedQuestion) {
        this.store.settle({ eventId: event.id, leaseToken: claim.leaseToken, status: 'done', content: '' });
        this.changed(event.conversationId); return;
      }
    }
    let prepared: BotMemoryPrepared | undefined, text = '', completion: BotTurnCompletion | undefined;
    let dispatch: NativeDispatch | undefined;
    const dispatchKey = `native-input:${event.id}`;
    let phaseStarted = performance.now(), currentPhase: 'prepareMs' | 'modelMs' | 'finishMs' = 'prepareMs';
    const measurePhase = (next?: typeof currentPhase) => {
      this.store.recordTurnTiming(event.id, claim.leaseToken, { [currentPhase]: Math.max(0, performance.now() - phaseStarted) });
      phaseStarted = performance.now(); if (next) currentPhase = next;
    };
    const progress = (value: BotReplyProgress) => { if (!this.closed && !signal.aborted) { this.replyProgress.set(event.replyMessageId, value); this.changed(event.conversationId); } };
    progress({ phase: this.memoryWarmPhases.get(digest(JSON.stringify([event.companionId, event.securityDomainId]))) ?? 'recalling-memory' });
    try {
      if (this.store.withdrawnIn(event.companionId, event.securityDomainId, this.store.eventSourceIds(event.id)).size) {
        if (event.payload.groupAttention === true) this.store.settle({ eventId: event.id, leaseToken: claim.leaseToken, status: 'done', content: '' });
        else this.store.cancelEvent(event.id, true);
        return;
      }
      await this.ensureConversationBindings(event.conversationId);
      signal.throwIfAborted();
      this.companionRuntime.admit(event);
      const followed = this.companionRuntime.boundFollowup(event);
      const followedAttention = followed ? this.taskRuntime.attention(followed.id) : undefined;
      // A task selection narrows scope; it does not mean resume or steer.
      // Route the actual user intent through the Router, including pause/stop
      // and supplementation that must leave an existing pause intact.
      if (this.options.brainRuntime === 'worldlinebox') {
        const key = botNativeHostBindingKey(this.nativeLaneId(event.laneId)), owner = this.store.getMetadata(key);
        if (owner && owner !== 'worldlinebox') throw Object.assign(new Error('旧DSH主脑仍有未核实执行，不能将它重放到应用内主脑。'), { code: 'BOT_HOST_MIGRATION_BLOCKED' });
        this.store.setMetadata(key, 'worldlinebox');
      }
      const model = this.options.model(); if (!model.apiKey) throw new Error('请先在模型设置中配置主脑 API。');
      if (model.apiFormat !== 'openai_chat') throw new Error('伙伴主脑目前需要 OpenAI Chat Completions 协议，请在模型设置中选择兼容端点。');
      if (event.payload.groupAttention === true) {
        const accepted = await this.acceptsGroupMessage(event, signal); signal.throwIfAborted();
        if (!accepted) {
          this.store.settle({ eventId: event.id, leaseToken: claim.leaseToken, status: 'done', content: '' }); return;
        }
        if (!this.store.promoteGroupReply(event.id, claim.leaseToken)) return;
        this.changed(event.conversationId);
      }
      const memoryPhase = (phase: 'memory-starting' | 'memory-verifying' | 'memory-indexing' | 'recalling-memory') => progress({ phase });
      await this.loadTombstones(scopeFor(event), event.id, memoryPhase);
      signal.throwIfAborted();
      if (this.store.withdrawnIn(event.companionId, event.securityDomainId, this.store.eventSourceIds(event.id)).size) { this.store.cancelEvent(event.id, true); return; }
      const retained = await this.retention.beforeTurn(event, signal);
      signal.throwIfAborted();
      const saved = this.store.getMetadata(dispatchKey);
      const frozen = saved ? JSON.parse(saved) as NativeDispatch : undefined;
      if (frozen && frozen.nativeLaneId !== retained.nativeLaneId) throw Object.assign(new Error('事件保存的原生上下文已失效。'), { code: 'BOT_RETENTION_STALE' });
      const messages = this.memoryMessages(event, contextThrough);
      prepared = frozen ? await this.options.memory.resumePrepared({ scope: scopeFor(event), requestId: event.id, signal })
        : await this.options.memory.prepareTurn({ scope: scopeFor(event), requestId: event.id, messages, query: event.content, signal, onPhase: memoryPhase });
      signal.throwIfAborted();
      progress({ phase: 'preparing-context' });
      const { epoch, nativeLaneId } = retained;
      const cwd = this.store.getMetadata(botHostHistoryRebuildKey(event.laneId)) || !this.store.getLane(event.laneId)?.sessionId
        ? botConversationWorkdir(this.options.root, companion, event.conversationId, this.store) : this.store.getLaneRetention(event.laneId).last?.cwd ?? botLaneWorkdir(this.options.root, event.laneId);
      await mkdir(cwd, { recursive: true });
      signal.throwIfAborted();
      // Unknown delivery resumes the identical input, even if tasks/history changed while detached.
      dispatch = frozen;
      if (!dispatch) {
        const delivered = new Set(this.deliveredMessages(event.laneId, nativeLaneId));
        const history = this.store.recentPublishedMessages(event.conversationId, { throughSourceSequence: contextThrough, limit: 80, maxChars: 24000 })
          .filter(message => !delivered.has(message.id) && (message.senderId !== event.companionId || !!this.store.getMetadata(botHostHistoryRebuildKey(event.laneId))));
        const withdrawn = this.store.withdrawnIn(event.companionId, event.securityDomainId, history.map(message => message.id));
        const tasks = this.taskRuntime.visibleTasks(event.conversationId), withdrawnTasks = this.store.withdrawnIn(event.companionId, event.securityDomainId, tasks.map(task => task.sourceEventId));
        const handoffView = retained.handoff ? this.options.brainRuntime === 'worldlinebox'
          ? { kind: 'historical-context', compactionId: retained.handoff.compactionId,
            summaryText: Array.from(retained.handoff.summaryText).slice(0, 640).join(''), summaryIsExcerpt: Array.from(retained.handoff.summaryText).length > 640,
            detailedHistory: 'context_handoff_read或VCP记忆工具可回查原文；此处不复制完整尾部' }
          : { kind: 'historical-context', ...retained.handoff } : undefined;
        const handoffChars = handoffView ? JSON.stringify({ nativeHandoff: handoffView }).length : 0;
        const room = this.store.getConversation(event.conversationId);
        const participants = (room?.memberIds ?? []).flatMap(id => { const member = this.store.getCompanion(id); return member ? [{ id: member.id, name: member.name }] : []; });
        const taskFollowup = followed ? { taskId: followed.id, ...(followedAttention?.state === 'queued' ? { questionId: followedAttention.id } : {}) } : undefined;
        const files = await this.verifiedAttachmentFiles(event, undefined, contextThrough, signal);
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        const context = buildBotContext({ companion, event, taskFollowup, participantWorkAuthorized: event.senderType === 'companion' && isBotParticipantRequest(event, room) ? !!this.companionRuntime.workAuthority(event) : undefined, delegation: this.delegations.forEvent(event), contactWorkAuthorized: event.source === 'companion' && event.payload.userRequestedContact === true ? !!this.companionRuntime.workAuthority(event) : undefined, files, taskPolicy: taskContextPolicy(this.store, event), capabilities: this.options.capabilityState?.(event.companionId), historyThroughSequence: contextThrough, agent: this.companionRuntime.view(event), conversation: room, participants, companionDirectory: this.store.listCompanions(), maxEnvelopeChars: DEFAULT_MODEL_CONTEXT_CHARS - handoffChars, messages: history.filter(message => !withdrawn.has(message.id)), memories: prepared.evidence,
          referenceLongTriggers: this.options.brainRuntime === 'worldlinebox',
          fitsEnvelope: this.options.brainRuntime === 'worldlinebox' ? (system, user) => {
            const prompt = handoffView ? JSON.stringify({ ...JSON.parse(user), nativeHandoff: handoffView }) : user;
            // The initial envelope must leave room for a real tool call and
            // a readable receipt page, beyond the reserved final output.
            const window = resolveBotModelLimits(model).window, headroom = Math.min(2048, Math.floor(window / 16));
            return fitsAppBrainRequest(appBrainRequest(model, system, [{ role: 'user', content: prompt }], BOT_TOOLS, true), { ...model, contextWindow: window - headroom });
          } : undefined,
          tasks: tasks.filter(task => task.companionId === event.companionId && !withdrawnTasks.has(task.sourceEventId) && !this.store.taskSourcesWithdrawn(task.id)).slice(0, 12).map(task => ({...this.taskRuntime.card(task),pauseCause:executorPauseCause(task)})) });
        const body = JSON.parse(context.user) as { history: Array<{ id: string }> };
        dispatch = { nativeLaneId, system: context.system, taskFollowup, historyThroughSequence: contextThrough, deliveredMessageIds: body.history.map(message => message.id), prompt: handoffView
          ? JSON.stringify({ ...body, nativeHandoff: handoffView }) : context.user };
        this.store.setMetadata(dispatchKey, JSON.stringify(dispatch));
      }
      completion = { event, system: dispatch.system, cwd, nativeLaneId, inputBytes: Buffer.byteLength(dispatch.prompt), outputBytes: 0 };
      this.retention.trackAdmission(completion);
      measurePhase('modelMs');
      const preparation = this.options.brainRuntime === 'worldlinebox' ? undefined : this.options.runtimePreparation?.();
      progress({ phase: preparation && !['ready', 'failed'].includes(preparation.phase) ? 'waiting-runtime' : 'waiting-model' });
      let lastDraft = 0, firstTextRecorded = false;
      const callback = await this.toolServer.start(); signal.throwIfAborted();
      const result = await this.options.brain.run({ laneId: nativeLaneId, eventId: event.id, cwd, system: dispatch.system,
        prompt: dispatch.prompt, model, tools: BOT_TOOLS, callback, signal,
        onEvent: update => {
          if (signal.aborted || this.closed || this.store.getLane(event.laneId)?.epoch !== epoch || this.store.getEvent(event.id)?.status !== 'running') return;
          if (this.options.brainRuntime === 'worldlinebox' && update.type === 'context_metrics' && update.contextMetrics) {
            if (this.store.recordBrainContext(event.id, epoch, update.contextMetrics)) this.changed(event.conversationId);
            return;
          }
          this.store.markDispatched(event.id, claim.leaseToken, event.id);
          const stage = update.type === 'context_compacting' ? 'compacting-context'
            : update.type === 'started' || update.type === 'model_request' ? 'waiting-model'
            : update.type === 'tool_call' || update.type === 'tool_reconciling' ? 'using-tool'
            : update.type === 'tool_result' ? 'preparing-context' : undefined;
          if (stage) {
            // A phase snapshot must include the partial text already streamed.
            if (text) this.store.updateDraft(event.id, claim.leaseToken, text);
            progress({ phase: stage, ...(stage === 'using-tool' && typeof update.toolName === 'string' ? { toolName: update.toolName } : {}) });
          }
          if (typeof update.text === 'string' && ['text_stream', 'text', 'complete'].includes(update.type)) {
            text = update.text;
            if (text && !firstTextRecorded) { firstTextRecorded = true; this.store.recordTurnTiming(event.id, claim.leaseToken, { firstTextAt: Date.now() }); }
            if (text && this.replyProgress.get(event.replyMessageId)?.phase !== 'generating') {
              this.store.updateDraft(event.id, claim.leaseToken, text); progress({ phase: 'generating' });
            }
            this.emit({ type: 'text', conversationId: event.conversationId, messageId: event.replyMessageId, text });
            if (Date.now() - lastDraft > 700) { lastDraft = Date.now(); this.store.updateDraft(event.id, claim.leaseToken, text); }
          }
        } });
      signal.throwIfAborted(); text = result.text;
      if (text && !firstTextRecorded) this.store.recordTurnTiming(event.id, claim.leaseToken, { firstTextAt: Date.now() });
      measurePhase('finishMs');
      if (this.store.getLane(event.laneId)?.epoch === epoch) this.store.saveSession(event.laneId, result.sessionId);
      const status = result.status === 'succeeded' ? 'done' : result.status === 'cancelled' ? 'cancelled' : 'failed';
      measurePhase();
      const final = this.store.settle({ eventId: event.id, leaseToken: claim.leaseToken, status, content: text,
        metadata: result.quarantined === true ? this.retention.quarantineMetadata(completion) : [...this.retention.completionMetadata({ ...completion, outputBytes: Buffer.byteLength(text), inputContextCommitted: result.inputContextCommitted }),
          ...this.deliveryMetadata(event, dispatch, result.inputContextCommitted)],
        dshEventId: result.eventId, memoryJobs: [this.responseJob(event, prepared, text, status === 'done'),
          { key: `history:${event.id}`, kind: 'projection', payload: { scope: scopeFor(event), messages: [messages.at(-1),
            { id: event.replyMessageId, role: 'assistant', content: text, timestamp: Date.now(), senderId: companion.id, senderName: companion.name }].filter(Boolean) } },
          ...(status === 'done' && event.source === 'user' && this.store.getMetadata(`skipCapture:${event.id}`) !== 'true' && !/^(你好|谢谢|好的|嗯|hi|hello|thanks)[!！。 .]*$/iu.test(event.content.trim())
            ? [{ key: `capture:v${BOT_MEMORY_CAPTURE_POLICY}:${event.id}`, kind: 'capture' as const, payload: { scope: scopeFor(event), sourceEventId: event.id, policyVersion: BOT_MEMORY_CAPTURE_POLICY,
              messages: [messages.find(message => message.id === event.sourceMessageRecordId)].filter(Boolean), answer: text, answerMessageId: event.replyMessageId } }] : [])] });
      if (final) {
        this.ready = true; this.detail = undefined;
        if (status === 'done') {
          this.afterPublishedReply(event);
        }
      }
    } catch (error) {
      // A broken provider may return after the bounded shutdown drain. The
      // scheduler already requeued this event; never touch its closed store.
      if (this.closed) return;
      measurePhase();
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const acknowledgedCancellation = code === 'BOT_ABORT_ACKNOWLEDGED' && error && typeof error === 'object' && 'result' in error
        && error.result && typeof error.result === 'object' && 'status' in error.result && error.result.status === 'cancelled';
      const cancelled = signal.aborted || !!acknowledgedCancellation;
      if (!this.closed && code === 'BOT_ABORT_ACKNOWLEDGED' && completion && error && typeof error === 'object' && 'result' in error) {
        this.retention.recordCancelledTerminal(completion, error.result as BotDshResult);
      }
      if (!cancelled && event.attempts < 5 && (code === 'MEMORY_CAPACITY' || code === 'MEMORY_PREPARED_MISSING' || code === 'BOT_LANE_BUSY')) {
        progress({ phase: code === 'BOT_LANE_BUSY' ? 'reconciling' : 'retrying', detail: '等待执行状态确认' });
        this.store.requeue(event.id, claim.leaseToken, Math.min(10000, 500 * 2 ** (event.attempts - 1)));
        return;
      }
      if (!cancelled && code === 'BOT_DELIVERY_UNKNOWN' && event.attempts < 4) {
        progress({ phase: this.options.brainRuntime === 'worldlinebox' ? 'reconciling' : 'retrying', detail: this.options.brainRuntime === 'worldlinebox' ? '正在核实主脑执行回执' : '正在恢复共享连接' });
        this.store.requeue(event.id, claim.leaseToken, Math.min(30000, event.attempts * 1000));
        return;
      }
      const terminal = code === 'BOT_TERMINAL_FAILED' && completion && !cancelled
        && this.store.getEventNativeEpoch(event.id) === this.store.getLane(event.laneId)?.epoch;
      const quarantined = terminal && error && typeof error === 'object' && 'quarantined' in error && error.quarantined === true;
      if (terminal && error && typeof error === 'object' && 'partialText' in error && typeof error.partialText === 'string') text = error.partialText;
      const visibleError = code === 'MEMORY_SESSION_CLOSED' ? '记忆服务异常退出，本条消息已保留；可重试。' : errorText(error);
      this.store.settle({ eventId: event.id, leaseToken: claim.leaseToken, status: cancelled ? 'cancelled' : 'failed', content: text, error: cancelled ? undefined : visibleError,
        dshEventId: terminal ? event.id : undefined,
        metadata: quarantined ? this.retention.quarantineMetadata(completion!) : terminal ? [...this.retention.completionMetadata({ ...completion!, outputBytes: Buffer.byteLength(text),
          inputContextCommitted: error && typeof error === 'object' && 'inputContextCommitted' in error && typeof error.inputContextCommitted === 'boolean' ? error.inputContextCommitted : undefined }),
          ...this.deliveryMetadata(event, dispatch, error && typeof error === 'object' && 'inputContextCommitted' in error && typeof error.inputContextCommitted === 'boolean' ? error.inputContextCommitted : undefined)] : undefined });
      // Shutdown requeues this same event for native resumption. Finishing its
      // VCP request here would make the next preparation look already completed.
      if (prepared && !this.closed) this.store.enqueueMemoryJob(this.responseJob(event, prepared, text, false));
      if (!cancelled) { this.detail = visibleError; this.options.report?.(error); }
    } finally {
      if (!this.closed) {
        this.companionRuntime.settle(event.id);
        if (['done', 'failed', 'cancelled'].includes(this.store.getEvent(event.id)?.status ?? '')) { this.replyProgress.delete(event.replyMessageId); this.store.setMetadata(dispatchKey, ''); }
        this.changed(event.conversationId); this.maintainSafely();
      }
    }
  }
  private async tool(call: BotToolCall, signal: AbortSignal): Promise<unknown> {
    if (call.laneId.startsWith('worker-')) return this.workerTool(call, signal);
    const event = this.store.getEvent(call.eventId);
    if (!event || this.nativeLaneId(event.laneId) !== call.laneId || event.status !== 'running') throw new Error('工具调用没有有效的运行事件。');
    const conversation = this.store.getConversation(event.conversationId);
    if (!conversation || conversation.revision !== event.aclRevision || !conversation.memberIds.includes(event.companionId)) throw new Error('会话权限已变化。');
    if (!BOT_TOOLS.some(tool => tool.name === call.name)) throw new Error('主脑没有这项工具。');
    const key = `effect:${event.id}:${call.callId}`, fingerprint = digest(JSON.stringify([call.name, call.args]));
    const previous = this.store.getMetadata(key);
    if (previous) { const saved = JSON.parse(previous) as { fingerprint: string; result: unknown }; if (saved.fingerprint !== fingerprint) throw new Error('工具调用标识已用于其他参数。'); return saved.result; }
    const running = this.toolRuns.get(key); if (running) { if (running.fingerprint !== fingerprint) throw new Error('运行中的工具调用标识对应其他参数。'); return running.promise; }
    const operation = this.executeTool(event, call, signal).then(result => { this.store.setMetadata(key, JSON.stringify({ fingerprint, result })); return result; });
    this.toolRuns.set(key, { fingerprint, promise: operation }); try { return await operation; } finally { this.toolRuns.delete(key); }
  }
  private runningTasks(companionId: string, except?: string): number {
    // Queued runs are preparing/connecting and reserve a slot before their
    // first await. Native questions free execution slots while remaining attached.
    return [...this.taskRuns.entries()].filter(([id, run]) => id !== except && run.companionId === companionId
      && ['queued', 'running'].includes(this.store.taskSchedulingStatus(id) ?? '')).length;
  }
  private async workerTool(call: BotToolCall, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const taskId = call.laneId.slice('worker-'.length), task = this.store.getTask(taskId);
    const source = task && this.store.getEvent(task.sourceEventId), conversation = task && this.store.getConversation(task.conversationId);
    if (!task || call.laneId !== `worker-${task.id}` || call.eventId !== `work-${task.id}` || !source || !conversation
      || source.conversationId !== task.conversationId || source.companionId !== task.companionId || conversation.revision !== source.aclRevision
      || !conversation.memberIds.includes(task.companionId)) throw new Error('执行器回调不属于有效来源任务。');
    const commit = call.name === 'worker_effect_commit', poll = call.name === 'worker_question_result';
    const run = this.taskRuns.get(task.id);
    if (!commit && run) { signal = AbortSignal.any([signal, run.controller.signal]); signal.throwIfAborted(); }
    if (!commit && (!this.taskRuns.has(task.id) || !poll && (task.extra.cancelRequested || ['paused', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(task.status))
      || this.store.taskSourcesWithdrawn(task.id))) throw new Error('执行器任务已停止或尚未附着。');
    let result: unknown;
    switch (call.name) {
      case 'worker_report': {
        this.taskRuntime.assertAdmittedHostTool(task.id, call.callId, call.name, call.args);
        const report = this.taskReports.record(task, call.callId, call.args);
        result = { recorded: true, state: report.state, reportId: report.callId, meaning: '业务报告已保存；任务状态还需核对执行轮次与工具回执。' };
        break;
      }
      case 'worker_question': {
        if (call.args.callId !== call.callId) throw new Error('执行器问题调用标识不匹配。');
        result = this.taskRuntime.question(task, call.args); this.scheduler.wake(); break;
      }
      case 'worker_question_result': result = this.taskRuntime.questionResult(task, z.string().min(1).max(160).parse(call.args.questionId), call.callId, this.runningTasks(task.companionId, task.id) < this.store.workerConcurrency(task.companionId)); break;
      case 'worker_effect_start': {
        if (call.args.callId !== call.callId || task.status !== 'running') throw new Error('执行器尚不可执行本次操作。');
        result = this.taskRuntime.startEffect(task, call.args); this.scheduler.wake(); break;
      }
      case 'worker_effect_commit': {
        if (call.args.callId !== call.callId || task.extra.nativeAttempted !== true) throw new Error('执行器没有对应的投递记录。');
        result = this.taskRuntime.commitEffect(task, call.args); break;
      }
      case 'worker_chat_send_file': {
        const args = z.strictObject({ path: z.string().min(1).max(32768), caption: z.string().max(24000).optional(),
          nativeSessionId: z.string().max(200).optional(), nativeCallId: z.string().max(300).optional() }).parse(call.args);
        this.taskRuntime.assertAdmittedHostTool(task.id, call.callId, call.name, args);
        this.store.reserveTaskAction(task.id, call.callId, call.name);
        const output = await this.resolveOutputFile(source, { path: args.path, taskId: task.id }); signal.throwIfAborted();
        const message = this.store.publishForTask(task.id, call.callId, { content: args.caption ?? '', ...output });
        result = { sent: true, messageId: message.id, attachmentIds: output.attachments.map(ref => ref.id), relativePath: output.relativePath }; break;
      }
      default: throw new Error('执行器回调能力不在允许列表中。');
    }
    this.changed(task.conversationId); this.maintainSafely(); return result;
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
  private attachmentThrough(event: BotEvent): number {
    const saved = this.store.getMetadata(`native-input:${event.id}`);
    return saved ? (JSON.parse(saved) as NativeDispatch).historyThroughSequence ?? event.sourceMessageSequence : event.sourceMessageSequence;
  }
  private async verifiedAttachmentFiles(event: BotEvent, ids?: string[], throughSourceSequence = this.attachmentThrough(event), signal?: AbortSignal) {
    signal?.throwIfAborted(); this.maintenanceAbort.signal.throwIfAborted();
    const grants = ids ? ids.flatMap((_, index) => index % 16 ? [] : this.store.modelAttachmentGrants(event, { ownPublicationsFromEventId:event.id, ids: ids.slice(index, index + 16), throughSourceSequence }))
      : this.store.modelAttachmentGrants(event, { ownPublicationsFromEventId:event.id, throughSourceSequence, all: true });
    const result = [];
    for (const { ref } of grants) {
      signal?.throwIfAborted(); this.maintenanceAbort.signal.throwIfAborted();
      const file = await this.requireMedia().verifiedLocalFile(event.conversationId, ref.id, signal ?? this.maintenanceAbort.signal);
      signal?.throwIfAborted(); this.maintenanceAbort.signal.throwIfAborted(); result.push(botHandoffFile(file));
    }
    return result;
  }
  private async resolveOutputFile(event: BotEvent, args: Record<string, unknown>) {
    if (typeof args.attachmentId === 'string') {
      if (args.path !== undefined || args.taskId !== undefined) throw new Error('现有附件ID和工作区路径不能混用。');
      const attachmentGrants = this.authorizedAttachmentGrants(event, [args.attachmentId]);
      return { attachments: await this.requireMedia().resolveForConversation(event.conversationId, attachmentGrants.map(grant => grant.mediaId)), attachmentGrants };
    }
    const file = z.string().trim().min(1).max(32768).refine(value => !value.includes('\0')).parse(args.path);
    const companion = this.store.getCompanion(event.companionId)!;
    let base = botConversationWorkdir(this.options.root, companion, event.conversationId, this.store), outputTaskId: string | undefined;
    if (args.taskId !== undefined) {
      const task = this.store.getTask(nonempty.parse(args.taskId));
      if (!task || task.companionId !== event.companionId || task.conversationId !== event.conversationId || task.extra.cancelRequested
        || this.store.taskSourcesWithdrawn(task.id)) throw new Error('文件任务不属于本主脑当前受众或其来源已撤回。');
      base = this.taskWorkdir(task, event.securityDomainId);
      outputTaskId = task.id;
    }
    const { assertBotMediaPhysicalPath } = await import('./media-service'); await assertBotMediaPhysicalPath(base);
    const candidate = path.isAbsolute(file) ? file : path.resolve(base, file), resolvedBase = await realpath(base), resolved = await realpath(candidate), relative = path.relative(resolvedBase, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !(await lstat(resolved)).isFile()) throw new Error('只能发送本主脑或自身任务工作区中的真实文件。');
    await assertBotMediaPhysicalPath(resolved);
    return { attachments: await this.requireMedia().importFiles({ conversationId: event.conversationId, paths: [resolved] }), relativePath: relative.split(path.sep).join('/'),
      outputTaskId, sourceIds: outputTaskId ? this.store.taskSourceIds(outputTaskId) : this.store.eventSourceIds(event.id) };
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
    if (['dsh_task', 'companion_delegate', 'companion_contact', 'companion_reply_user', 'message_peer', 'chat_send_sticker', 'chat_send_file'].includes(call.name)
      || call.name === 'dsh_plan' && args.operation === 'create'
      || call.name === 'world' && args.operation !== 'observe') {
      await this.ensureConversationBindings(event.conversationId);
      signal.throwIfAborted(); this.assertCurrentEvent(event);
    }
    if (['memory_write', 'memory_update', 'memory_organize', 'memory_forget', 'memory_maintenance'].includes(call.name)
      && args.conversationId !== undefined && args.conversationId !== event.conversationId) throw new Error('记忆写入和整理仅限当前受众，跨会话查询不授予修改权限。');
    if (['memory_write', 'memory_update', 'memory_organize', 'memory_forget', 'message_peer', 'companion_contact', 'companion_reply_user', 'companion_delegate', 'dsh_task', 'chat_send_sticker', 'chat_send_file'].includes(call.name)
      || call.name === 'world' && args.operation !== 'observe'
      || call.name === 'dsh_task_control' && !['status', 'list'].includes(String(args.operation))
      || call.name === 'dsh_plan' && args.operation !== 'status'
      || call.name === 'companion_delegation' && args.operation !== 'status'
      || call.name === 'memory_maintenance' && args.operation === 'plan') this.store.reserveAutomaticAction(event.id, call.callId, call.name);
    switch (call.name) {
      case 'agent_capabilities': {
        if (this.store.getCompanion(event.companionId)?.enabled === false) throw new Error('伙伴已关闭。');
        const query = dshTaskCapabilityQuerySchema.parse(args);
        if (!this.options.capabilities) return { available: false, reason: 'DSH 能力目录尚未连接，不能据此断言某项能力存在或不存在。' };
        const before = this.options.capabilityState?.(event.companionId);
        const result = await this.options.capabilities(event.companionId, query, signal);
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        const environment = this.options.capabilityState?.(event.companionId);
        if (environment && (environment.instanceId !== result.instanceId || before?.instanceId !== environment.instanceId || before?.revision !== environment.revision))
          return { available: false, changed: true, environment, reason: '查询期间装备环境发生变化，请重新读取当前能力，不使用上一版本目录。' };
        return { available: true, authority: 'capability-reference-data', owner: event.companionId,
          environment, ...result };
      }
      case 'agent_state': {
        const room = this.store.getConversation(event.conversationId);
        return { ...this.companionRuntime.view(event, { includeEnded: true }), conversation: {
          id: room?.id, memberCount: room?.memberIds.length,
          members: room?.memberIds.slice(0, 1024).map(id => ({ id, name: id === 'user' ? '用户' : this.store.getCompanion(id)?.name })),
        }, companionDirectory: this.store.listCompanions().slice(0, 1024).map(actor => ({ id: actor.id, name: actor.name })) };
      }
      case 'memory_maintenance': {
        const operation = z.enum(['plan', 'status']).parse(args.operation);
        if (operation === 'plan' && !this.companionRuntime.workAuthority(event)) throw new Error('维护计划需要有效的用户或伙伴请求；后台通知不能自行创建。');
        const result = this.memoryMaintenance.tool(scope, { operation, kind: z.enum(['organize', 'dream']).optional().parse(args.kind), jobId: z.string().min(1).max(160).optional().parse(args.jobId) }, `${event.id}:${call.callId}`);
        this.maintainSafely(); return result;
      }
      case 'context_handoff_read': {
        const handoff = this.store.getLaneRetention(event.laneId).handoff;
        if (!handoff) return { available: false, reason: '当前主脑代际没有交接记录；原话可用VCP回查。' };
        const section = z.enum(['summary', 'tail']).parse(args.section ?? 'summary');
        const chars = Array.from(section === 'summary' ? handoff.summaryText : JSON.stringify(handoff.tail));
        const offset = z.number().int().min(0).max(1000000).parse(args.offset ?? 0), end = Math.min(chars.length, offset + 800);
        return { available: true, compactionId: handoff.compactionId, section, offset, totalChars: chars.length,
          text: chars.slice(offset, end).join(''), nextOffset: end < chars.length ? end : undefined, complete: end >= chars.length };
      }
      case 'chat_read_message': {
        const id = z.string().min(1).max(160).parse(args.messageId), message = this.store.getMessage(id);
        if (!message || message.conversationId !== event.conversationId || message.sequence > event.sourceMessageSequence
          || message.status !== 'sent' || this.store.withdrawnIn(event.companionId, event.securityDomainId, [id]).size) throw new Error('原消息不属于当前主脑获准的会话范围。');
        const chars = Array.from(botMessageEvidence(message)), offset = z.number().int().min(0).max(1000000).parse(args.offset ?? 0);
        const limit = z.number().int().min(1).max(1200).parse(args.limit ?? 800), end = Math.min(chars.length, offset + limit);
        const files = await this.verifiedAttachmentFiles(event, message.attachments?.map(ref => ref.id) ?? [], undefined, signal);
        signal.throwIfAborted(); this.assertCurrentEvent(event);
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
        const message = this.store.publishForEvent(event.id, call.callId, { content: typeof args.caption === 'string' ? args.caption.slice(0, 24000) : '', attachments: [sticker] });
        this.changed(event.conversationId); return { sent: true, messageId: message.id, attachmentIds: [sticker.id] };
      }
      case 'chat_send_file': {
        const resend = z.boolean().optional().parse(args.resend) ?? false;
        const output = await this.resolveOutputFile(event, args); signal.throwIfAborted();
        this.assertCurrentEvent(event);
        if (output.outputTaskId && output.relativePath && !resend) {
          const previous = this.store.deliveredTaskOutput(event, output.outputTaskId, output.relativePath, output.attachments[0]!);
          if (previous) return { sent: true, alreadySent: true, messageId: previous.id, attachmentIds: previous.attachments!.map(ref => ref.id), relativePath: output.relativePath };
        }
        const message = this.store.publishForEvent(event.id, call.callId, { content: typeof args.caption === 'string' ? args.caption.slice(0, 24000) : '', ...output });
        this.changed(event.conversationId); return { sent: true, messageId: message.id, attachmentIds: output.attachments.map(ref => ref.id), relativePath: output.relativePath };
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
        const result = await this.options.memory.remember(scope, input, signal);
        this.store.enqueueMemoryJob({ key: `index:${input.sourceEventId}`, kind: 'mutation', payload: { scope, operation: 'remember', input } });
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
      case 'companion_delegate': return this.delegateTask(event, call, signal);
      case 'companion_delegation': return this.delegationTool(event, call, signal);
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
        const delegation = this.delegations.forEvent(event);
        if (delegation) return { sent: false, delegationId: delegation.id, requiredNextAction: delegation.state === 'active' ? 'companion_delegation.result' : 'none',
          reason: delegation.state === 'active' ? '这次转达已进入正式任务协作；核验实际成果后用companion_delegation.result交回原用户聊天，不要求用户重复请求。' : '本次任务委派已经结束，不重复发送成果。' };
        const result = this.store.replyPeerToUser(event, call.callId, z.string().trim().min(1).max(24000).parse(args.message));
        this.changed(result.conversationId); this.changed(event.conversationId); return result;
      }
      case 'message_peer': {
        const target = nonempty.parse(args.companionId), content = z.string().trim().max(8000).parse(args.content ?? ''), cause = derivedCause(event);
        await this.ensureConversationBindings(event.conversationId, [target]);
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        const delegation=this.delegations.forEvent(event);
        if(delegation?.state==='active'&&target===delegation.requesterId){
          const tasks=this.delegations.tasks(delegation.id);
          if(tasks.length&&tasks.every(task=>['succeeded','failed'].includes(task.status)))return {sent:false,delegationId:delegation.id,
            requiredNextAction:'companion_delegation.result',reason:'这是正式任务委派；实际Worker已返回，请先核验后使用result把真实产物交回原用户聊天。普通伙伴消息不会完成委派。',
            outputs:tasks.flatMap(task=>this.store.publicationsForTask(task.id))};
        }
        if (causalHop(event) >= maxCausalHop) return causalLimit();
        const ids = z.array(z.string().min(1).max(160)).max(16).parse(args.attachmentIds ?? []);
        if (!content && !ids.length) throw new Error('伙伴消息需要文字或真实附件。');
        const attachments = ids.length ? await this.requireMedia().resolveForConversation(event.conversationId, ids) : undefined;
        const attachmentGrants = attachments ? this.authorizedAttachmentGrants(event, attachments.filter(ref => ref.kind !== 'sticker').map(ref => ref.id)) : [];
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        const result = this.store.tryEnqueueAutomatic({ conversationId: event.conversationId, senderId: event.companionId, source: 'companion', content,
          attachments, attachmentGrants, sourceIds: this.store.eventSourceIds(event.id), sourceMessageId: `${event.id}:${call.callId}`, recipientIds: [target], correlationId: cause.correlationId, causationId: cause.causationId, payload: { hop: cause.hop } });
        if (!result.accepted) return { sent: false, reason: result.reason };
        this.scheduler.wake(); this.changed(event.conversationId); return { sent: true, eventIds: result.events.map(item => item.id) };
      }
      case 'dsh_plan': {
        const operation = z.enum(['create', 'status', 'cancel']).parse(args.operation);
        if (operation === 'status') return this.workflows.status(event, z.string().min(1).max(200).optional().parse(args.planId), z.number().int().min(0).max(1000000).default(0).parse(args.offset));
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        if (operation === 'create') {
          const title = z.string().trim().min(1).max(120).parse(args.title), stages = botWorkflowStages.parse(args.stages);
          const plan = this.store.taskTransaction(() => {
            this.promoteContactWork(event, title);
            return this.workflows.create(event, call.callId, title, stages);
          });
          const ticket = this.delegations.forEvent(event); if (ticket) this.changed(ticket.sourceConversationId);
          return plan;
        }
        const taskIds = this.workflows.cancel(event, nonempty.parse(args.planId), call.callId);
        for (const taskId of taskIds) { const task = this.store.getTask(taskId); if (task) await this.controlTask(task, 'cancel', undefined, `${event.id}:${call.callId}:${taskId}`, { caller: 'brain', source: event.source, sourceEventId: event.id }); }
        return this.workflows.status(event, String(args.planId));
      }
      case 'dsh_task': {
        if (this.companionRuntime.boundFollowup(event)) return { allowed: false, reason: '当前消息已绑定原任务跟进，不能另建任务。' };
        if (causalHop(event) >= maxCausalHop) return causalLimit();
        nonempty.parse(args.goal);
        const id = `task-${digest(`${event.id}:${call.callId}`).slice(0, 48)}`;
        const workflow = args.planId === undefined && args.stageKey === undefined ? undefined
          : z.strictObject({ planId: z.string().min(1).max(200), stageKey: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u) }).parse({ planId: args.planId, stageKey: args.stageKey });
        if (workflow) { this.workflows.receivedNotice(event); this.workflows.ready(event, workflow.planId, workflow.stageKey); }
        else { const authorization = this.companionRuntime.authorize(event, call.callId); if (!authorization.allowed) return authorization; }
        const through = this.attachmentThrough(event);
        // A chat's file catalog is for router discovery, not an implicit task
        // payload. Historical attachments require an explicit selection.
        const requested = args.attachmentIds === undefined ? (this.store.getMessage(event.sourceMessageRecordId)?.attachments ?? []).filter(ref => ref.kind !== 'sticker').map(ref => ref.id)
          : z.array(z.string().min(1).max(160)).max(16).parse(args.attachmentIds);
        if(workflow)this.workflows.requireDependencyArtifacts(event,workflow.planId,workflow.stageKey,requested);
        const attachmentGrants = requested.length ? this.authorizedAttachmentGrants(event, requested) : [];
        const attachmentRefs: BotMediaRef[] = [];
        for (let index = 0; index < requested.length; index += 64) attachmentRefs.push(...await this.requireMedia().resolveForConversation(event.conversationId, requested.slice(index, index + 64)));
        const attachmentIds = attachmentRefs.map(ref => ref.id);
        signal.throwIfAborted(); this.assertCurrentEvent(event);
        const { task, mandate, contactWork } = this.store.taskTransaction(() => {
          const contactWork = this.promoteContactWork(event, typeof args.title === 'string' ? args.title.slice(0, 120) : '伙伴协作任务');
          const causalParent = contactWork ? undefined : this.delegations.causalParent(event);
          const task = this.store.createTask({ id, conversationId: event.conversationId, companionId: event.companionId,
            sourceEventId: event.id, goal: nonempty.parse(args.goal), attachmentGrants, extra: { title: typeof args.title === 'string' ? args.title : 'DSH任务', securityDomainId: event.securityDomainId,
              dispatchFingerprint: digest(JSON.stringify(call.args)),
              ...(this.delegations.forEvent(event) ? { delegationId: this.delegations.forEvent(event)!.id } : {}),
              ...(causalParent ? { causalDelegationId: causalParent.id } : {}),
              ...(workflow ? { workflowId: workflow.planId, workflowStage: workflow.stageKey } : {}),
              attachmentIds, handoffThroughSequence: through, workspaceLayout: 'companion-v1', workerAccess: 'full' } });
          if (workflow) this.workflows.bind(event, task, workflow.planId, workflow.stageKey);
          return { task, mandate: this.companionRuntime.bindTask(task), contactWork };
        });
        if (contactWork) this.changed(contactWork.sourceConversationId);
        this.launchTask(task); this.changed(event.conversationId); return { taskId: task.id, mandateId: mandate.id, status: task.status,
          ...(contactWork ? { delegationId: contactWork.id, resultDelivery: 'companion_delegation.result', meaning: '用户转交请求已确认，正式协作已建立。任务由自己的DSH执行，核验成果后通过companion_delegation.result交回原用户聊天，无需用户再请求一次。' }
            : { meaning: '任务已持久保存并交由DSH执行，完成后回报；尚未完成。' }) };
      }
      case 'dsh_task_result_read': {
        const task = this.store.getTask(nonempty.parse(args.taskId));
        if (!task || task.extra.removedAt || task.conversationId !== event.conversationId || task.companionId !== event.companionId || this.store.taskSourcesWithdrawn(task.id)) throw new Error('执行结果不属于当前伙伴和聊天，或任务记录已移除。');
        const offset = z.number().int().min(0).max(10000000).default(0).parse(args.offset);
        const limit = z.number().int().min(1).max(12000).default(6000).parse(args.limit);
        const section = z.enum(['delivery', 'verification']).default('delivery').parse(args.section);
        const verification = section === 'verification' ? this.taskRuntime.verificationText(task) : undefined;
        const result = Array.from(section === 'verification' ? verification?.text ?? '' : this.taskRuntime.resultText(task) ?? '');
        if (section === 'delivery' && (offset < result.length || this.store.publicationsForTask(task.id).length)) this.workflows.observedResult(event, task);
        return { taskId: task.id, status: task.status, section, text: result.slice(offset, offset + limit).join(''), totalChars: result.length,
          ...(section === 'verification' ? { available: !!verification, ...(verification ? { reportCallId: verification.reportCallId } : { reason: '当前没有仍有效的ready核验报告。' }) } : {}),
          ...(offset + limit < result.length ? { nextOffset: offset + limit } : {}), outputs: this.store.publicationsForTask(task.id) };
      }
      case 'dsh_task_control': {
        const operation = z.enum(['status', 'send', 'cancel', 'answer', 'continue', 'pause', 'resume_paused', 'remove', 'list', 'cancel_queued', 'cancel_all', 'clear_finished']).parse(args.operation);
        const selectedTask = this.companionRuntime.boundFollowup(event);
        if (selectedTask && ['cancel_queued', 'cancel_all', 'clear_finished'].includes(operation)) throw new Error('当前跟进仅能操作用户选中的原任务，不能批量变更其他任务。');
        if (operation === 'list') return this.taskRuntime.page({ conversationId: event.conversationId, companionId: event.companionId,
          filter: z.enum(['all', 'active', 'done', 'issues']).default('all').parse(args.filter), query: z.string().max(200).optional().parse(args.query),
          page: z.number().int().min(0).max(1000000).default(0).parse(args.page), limit: z.number().int().min(1).max(30).default(20).parse(args.limit) });
        if (operation === 'cancel_queued' || operation === 'cancel_all' || operation === 'clear_finished') {
          signal.throwIfAborted(); this.assertCurrentEvent(event);
          return this.controlQueue(event.conversationId, operation, `${event.id}:${call.callId}`, event.companionId, event.id);
        }
        let task: BotTask, stopOnly = false;
        try { task = this.companionRuntime.taskInView(event, nonempty.parse(args.taskId)); }
        catch (error) {
          if (!['status', 'cancel', 'remove'].includes(operation)) throw error;
          task = this.companionRuntime.taskInView(event, nonempty.parse(args.taskId), { stopping: operation === 'cancel' ? 'cancel' : 'status' }); stopOnly = true;
        }
        if (stopOnly && operation === 'status') {
          const confirmed = task.status === 'cancelled' || task.extra.humanStopped === true && ['succeeded', 'failed'].includes(task.status);
          return { id: task.id, taskId: task.id, status: task.status, cancelRequested: task.extra.cancelRequested === true, confirmed,
            humanStopped: task.extra.humanStopped === true, followupAvailable: false,
            progress: { phase: confirmed ? task.status : task.extra.cancelRecoveryPaused ? 'stop-unconfirmed' : 'stopping',
              detail: confirmed ? '后续接续授权已经撤回，保留此前真实业务状态。' : '停止尚未得到执行器确认；原任务正文及结果不在本次授权中。' } };
        }
        if (selectedTask && operation !== 'status' && task.id !== selectedTask.id) throw new Error('当前跟进只能操作用户选中的原任务，不能回答或变更其他任务。');
        if (selectedTask && ['answer', 'send'].includes(operation)) {
          const saved = this.store.getMetadata(`native-input:${event.id}`);
          const binding = saved ? (JSON.parse(saved) as NativeDispatch).taskFollowup : undefined;
          if (!binding || binding.taskId !== selectedTask.id) throw new Error('当前跟进缺少原始问题的宿主绑定，请重新发送。');
          if (binding.questionId && operation === 'send') throw new Error('该跟进需要回答原始结构化问题，请用answer及原questionId，不能用send替代。');
          if (operation === 'answer' && (!binding.questionId || args.questionId !== binding.questionId)) throw new Error('必须使用本次跟进绑定的原始questionId回答，不得改答其他问题。');
        }
        if (task.conversationId !== event.conversationId && !['status', 'send', 'cancel'].includes(operation))
          throw new Error('跨会话协调仅支持查看、追加原范围指导和停止；问题回答与其他控制请回到任务原会话。');
        if (task.conversationId !== event.conversationId && operation !== 'status' && event.source !== 'user') throw new Error('跨会话任务控制需要当前用户明确请求。');
        if (event.source === 'task' && ['answer', 'send'].includes(operation) && event.payload.taskId !== task.id
          && (operation !== 'send' || !this.workflows.canCoordinate(event, task)))
          throw new Error('执行器回执只能指导或回答其绑定的当前任务。');
        const result = await this.controlTask(task, operation, typeof args.text === 'string' ? args.text : undefined, `${event.id}:${call.callId}`,
          { caller: 'brain', source: event.source, sourceEventId: event.id, questionId: typeof args.questionId === 'string' ? args.questionId : undefined,
            answers: args.answers === undefined ? undefined : z.array(botTaskAnswerSchema).min(1).parse(args.answers) });
        if (operation === 'status') this.workflows.observedResult(event, this.store.getTask(task.id)!);
        if (selectedTask && ['answer', 'send'].includes(operation) && result && typeof result === 'object' && 'accepted' in result && result.accepted === true)
          this.companionRuntime.deliveredFollowup(event, task.id);
        return result;
      }
      default: throw new Error('未知主脑工具。');
    }
  }
  /** A verified contact may contain work even when its sender selected the
   * user-reply route. Promote only when the recipient actually requests work;
   * greetings stay messages. One contact owns one durable, controllable proxy. */
  private promoteContactWork(event: BotEvent, title: string) {
    const existing = this.delegations.forEvent(event);
    if (existing || event.source !== 'companion') return existing;
    const source = this.companionRuntime.workAuthority(event);
    if (!source || source.id === event.id || !event.sourceMessageId.startsWith(`peer-contact:${source.id}:`)) return;
    return this.store.taskTransaction(() => {
      const prior = this.delegations.forEvent(event); if (prior) return prior;
      const proxy = this.store.createTask({ id: `task-contact-${digest(event.id).slice(0, 40)}`, conversationId: source.conversationId,
        companionId: source.companionId, sourceEventId: source.id, goal: event.content,
        extra: { title: title.trim() || '伙伴协作任务', delegationProxy: true, attachmentIds: [], securityDomainId: source.securityDomainId,
          ...(this.delegations.forEvent(source) ? { parentDelegationId: this.delegations.forEvent(source)!.id } : {}),
          progress: { phase: 'queued', detail: `交给${this.store.getCompanion(event.companionId)!.name}处理。` } } });
      this.companionRuntime.bindTask(proxy);
      const ticket = this.delegations.create(source, `contact-work-${digest(event.id).slice(0, 40)}`, {
        recipientId: event.companionId, peerConversationId: event.conversationId, contactEventId: event.id, proxyTaskId: proxy.id,
        goal: proxy.goal, title: title.trim() || '伙伴协作任务' });
      this.store.updateTask(proxy.id, { extra: { ...proxy.extra, externalDelegationId: ticket.id } });
      return ticket;
    });
  }
  /** Cross-companion work is a durable subscription to a real participant
   * request. Its proxy stays in the original room; execution stays with B. */
  private async delegateTask(event: BotEvent, call: BotToolCall, signal: AbortSignal): Promise<unknown> {
    this.assertCurrentEvent(event); signal.throwIfAborted();
    if (!this.companionRuntime.workAuthority(event) || this.companionRuntime.boundFollowup(event)) throw new Error('跨伙伴委派需要有效的用户或伙伴请求，任务跟进不能另建委派。');
    const args = z.strictObject({ companionId: z.string().min(1).max(160), title: z.string().trim().min(1).max(120), goal: z.string().trim().min(1).max(8000),
      attachmentIds: z.array(z.string().min(1).max(160)).max(16).optional(), planId: z.string().min(1).max(200).optional(), stageKey: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u).optional() }).parse(call.args);
    if (Boolean(args.planId) !== Boolean(args.stageKey)) throw new Error('委派阶段需要同时指定计划和阶段。');
    if (args.planId) this.workflows.ready(event, args.planId, args.stageKey!);
    const target = this.store.getCompanion(args.companionId);
    if (!target || target.enabled === false || target.id === event.companionId) throw new Error('请选择另一位已启用的真实伙伴。');
    await this.ensureConversationBindings(event.conversationId, [target.id]);
    signal.throwIfAborted(); this.assertCurrentEvent(event);
    const ids = args.attachmentIds ?? (this.store.getMessage(event.sourceMessageRecordId)?.attachments ?? []).filter(ref => ref.kind !== 'sticker').map(ref => ref.id);
    const grants = ids.length ? this.authorizedAttachmentGrants(event, ids) : [];
    const peer = this.store.openPeer(event.companionId, target.id);
    const refs = ids.length ? await this.requireMedia().transferToConversation({ sourceConversationId: event.conversationId, targetConversationId: peer.id, attachmentIds: ids, signal }) : [];
    signal.throwIfAborted(); this.assertCurrentEvent(event);
    if (ids.length) this.authorizedAttachmentGrants(event, ids); // Revalidate after physical I/O.
    const receipt = this.store.taskTransaction(() => {
      const proxy = this.store.createTask({ id: `task-${digest(`${event.id}:${call.callId}`).slice(0,48)}`, conversationId: event.conversationId,
        companionId: event.companionId, sourceEventId: event.id, goal: args.goal, attachmentGrants: grants, extra: { title: args.title,
          delegationProxy: true, dispatchFingerprint: digest(JSON.stringify(call.args)), attachmentIds: ids, securityDomainId: event.securityDomainId,
          ...(this.delegations.forEvent(event) ? { parentDelegationId: this.delegations.forEvent(event)!.id } : {}),
          ...(!this.delegations.forEvent(event) && this.delegations.causalParent(event) ? { causalDelegationId: this.delegations.causalParent(event)!.id } : {}),
          ...(args.planId ? { workflowId: args.planId, workflowStage: args.stageKey } : {}), progress: { phase: 'queued', detail: `交给${target.name}处理。` } } });
      if (args.planId) this.workflows.bind(event, proxy, args.planId, args.stageKey!);
      this.companionRuntime.bindTask(proxy);
      const contact = this.store.contactPeer(event, target.id, call.callId, args.goal, 'peer', { attachments: refs,
        sourceIds: this.store.attachmentGrantSourceIds(grants.map(grant => grant.grantId)) });
      if (!contact.accepted) throw new Error(contact.reason ?? '伙伴当前无法接收委派。');
      const contactEvent = contact.events[0] ?? this.store.taskTransaction(sql => {
        const row = sql.prepare('SELECT id FROM bot_inbox WHERE source_record_id=? AND companion_id=? LIMIT 1').get(contact.message.id,target.id) as {id:string}|undefined;
        return row ? this.store.getEvent(row.id) : undefined;
      });
      if (!contactEvent) throw new Error('委派没有真实投递事件。');
      const ticket = this.delegations.create(event,call.callId,{ recipientId: target.id,peerConversationId:peer.id,contactEventId:contactEvent.id,
        proxyTaskId:proxy.id,goal:args.goal,title:args.title });
      this.store.updateTask(proxy.id,{extra:{...proxy.extra,externalDelegationId:ticket.id}});
      return {delegationId:ticket.id,taskId:proxy.id,recipientId:target.id,status:'queued',meaning:'真实委派已投递；进度与成果将回到本聊天，不表示已经完成。'};
    });
    this.scheduler.wake(); this.changed(peer.id); this.changed(event.conversationId); return receipt;
  }
  private async delegationTool(event: BotEvent, call: BotToolCall, signal: AbortSignal): Promise<unknown> {
    const args = z.strictObject({ operation:z.enum(['status','result','send','cancel']),delegationId:z.string().min(1).max(200).optional(),
      message:z.string().trim().min(1).max(16000).optional(),attachmentIds:z.array(z.string().min(1).max(160)).max(16).optional(),offset:z.number().int().min(0).optional() }).parse(call.args);
    if (args.operation==='status') return this.delegations.status(event,args.delegationId,{offset:args.offset});
    const bound = this.delegations.forEvent(event), selected = args.delegationId ?? bound?.id;
    if (!selected) throw new Error('当前没有明确的伙伴委派。');
    const ticket = this.delegations.scoped(event,selected), proxy=this.store.getTask(ticket.proxyTaskId)!;
    const commandKey=`delegation-tool:${event.id}:${call.callId}`,fingerprint=digest(JSON.stringify(call.args)),saved=this.store.getMetadata(commandKey);
    if(saved){const receipt=JSON.parse(saved);if(receipt.fingerprint!==fingerprint)throw new Error('同一委派工具调用对应不同参数。');return receipt.result;}
    if (args.operation==='cancel') {
      if(event.companionId!==ticket.requesterId||event.conversationId!==ticket.sourceConversationId) throw new Error('只能由原始委派方停止委派。');
      return this.controlTask(proxy,'cancel',undefined,`${event.id}:${call.callId}`,{caller:'brain',source:event.source,sourceEventId:event.id});
    }
    this.assertCurrentEvent(event); signal.throwIfAborted();
    if (args.operation==='send') {
      if(event.companionId!==ticket.requesterId||event.conversationId!==ticket.sourceConversationId||!args.message) throw new Error('补充指导需要原聊天中的委派方及明确文字。');
      if(args.attachmentIds?.length)throw new Error('委派跟进当前仅追加文字；不能忽略新文件或扩大原任务的附件授权，请明确发起带新附件的后续委派。');
      return this.controlTask(proxy,'send',args.message,`${event.id}:${call.callId}`,{caller:'brain',source:event.source,sourceEventId:event.id});
    }
    this.delegations.assertActive(ticket);
    if (bound?.id!==ticket.id||event.companionId!==ticket.recipientId||event.conversationId!==ticket.peerConversationId) throw new Error('只能由实际接收委派的伙伴交回成果。');
    const tasks=this.delegations.tasks(ticket.id);
    if(!tasks.length||tasks.some(task=>!['succeeded','failed'].includes(task.status)||task.extra.humanStopped||task.extra.removedAt)) throw new Error('应先完成本委派实际Worker，未完成、暂停或停止的任务不能当作交付。');
    if(this.delegations.controlledTasks(ticket.id).some(task=>!['succeeded','failed'].includes(task.status)||task.extra.humanStopped||task.extra.removedAt))throw new Error('本委派派生的伙伴任务尚未完成，不能提前交付。');
    const plans=this.workflows.status(event).plans;
    if(plans?.some(plan=>plan.state==='active' && plan.stages.some(stage=>tasks.some(task=>task.id===stage.taskId)))) throw new Error('本委派还有未完成的计划阶段。');
    const outputs=[...new Set(tasks.flatMap(task=>this.store.publicationsForTask(task.id).flatMap(output=>output.attachmentIds)))];
    const ids=args.attachmentIds??outputs.slice(-16);
    if(ids.some(id=>!outputs.includes(id)))throw new Error('交回文件必须是本委派Worker真实发布的成果，不能转交其他任务或聊天文件。');
    const grants=ids.length?this.authorizedAttachmentGrants(event,ids):[];
    const refs=ids.length?await this.requireMedia().transferToConversation({sourceConversationId:ticket.peerConversationId,targetConversationId:ticket.sourceConversationId,attachmentIds:ids,signal}):[];
    signal.throwIfAborted();this.assertCurrentEvent(event);this.delegations.assertActive(ticket);
    if(ids.length)this.authorizedAttachmentGrants(event,ids);
    const content=args.message??tasks.map(task=>task.summary??'').join('\n').slice(0,16000);
    const result=this.store.taskTransaction(()=>{
      const current=this.store.getTask(proxy.id)!;
      this.store.updateTask(proxy.id,{status:'running',extra:{...current.extra,progress:{phase:'delegation-delivery',detail:'接收已完成的伙伴成果。'}}});
      const publication=refs.length?this.store.publishForTask(proxy.id,`delegation-${digest(`${event.id}:${call.callId}`)}`,{content,attachments:refs,
        sourceIds:[...this.store.eventSourceIds(event.id),...this.store.attachmentGrantSourceIds(grants.map(grant=>grant.grantId))]}):undefined;
      const receipt=this.delegations.recordResult(ticket.id,digest(`${event.id}:${call.callId}`),{content,attachmentIds:refs.map(ref=>ref.id),...(publication?{messageId:publication.id}:{})});
      this.finishTask(this.store.getTask(proxy.id)!,tasks.some(task=>task.status==='failed')?'failed':'succeeded',content);
      this.delegations.finish(ticket.id,'completed');const result={sent:true,taskId:proxy.id,...receipt};
      this.store.setMetadata(commandKey,JSON.stringify({fingerprint,result}));return result;
    });
    this.scheduler.wake();this.changed(ticket.sourceConversationId);this.changed(ticket.peerConversationId);return result;
  }
  private async controlDelegation(ticket:BotDelegationTicket,operation:string,text:string|undefined,messageId:string,input:Omit<BotTaskControlInput,'requestId'|'text'>):Promise<unknown>{
    const proxy=this.store.getTask(ticket.proxyTaskId)!;
    if(operation==='status')return input.caller==='brain'?this.taskRuntime.routerStatus(proxy):this.taskRuntime.card(proxy);
    const event=input.sourceEventId?this.store.getEvent(input.sourceEventId):undefined;
    if(input.caller!=='user'&&(!event||event.companionId!==ticket.requesterId||event.conversationId!==ticket.sourceConversationId))throw new Error('委派控制不属于当前聊天。');
    const key=`delegation-control:${ticket.id}:${digest(messageId)}`,fingerprint=digest(JSON.stringify([operation,text??'']));
    const previous=this.store.getMetadata(key);if(previous){if(JSON.parse(previous).fingerprint!==fingerprint)throw new Error('同一委派控制对应不同操作。');return JSON.parse(previous).result;}
    if (operation === 'send' || operation === 'resume_paused') await this.ensureCompanionBindings([ticket.requesterId, ticket.recipientId]);
    if(operation==='send'){
      if(ticket.state!=='active'||this.store.taskSourcesWithdrawn(proxy.id))throw new Error('委派已关闭或来源已撤回。');
      if(proxy.status==='paused'){
        const content=z.string().trim().min(1).max(8000).parse(text);
        const pending=Array.isArray(proxy.extra.delegationPendingControls)?proxy.extra.delegationPendingControls as Array<{id:string;text:string}>:[];
        if(pending.length>=32)throw new Error('待交付指导已满，请先恢复或清理原任务。');
        const result={accepted:true,taskId:proxy.id,status:'paused',meaning:'补充已保存；委派保持暂停，明确恢复后再交给协作伙伴。'};
        this.store.taskTransaction(()=>{this.store.updateTask(proxy.id,{extra:{...proxy.extra,delegationPendingControls:[...pending,{id:messageId,text:content}]}});
          this.store.setMetadata(key,JSON.stringify({fingerprint,result}));});this.changed(proxy.conversationId);return result;
      }
      this.delegations.assertActive(ticket);
      const content=z.string().trim().min(1).max(8000).parse(text),source=this.store.getEvent(ticket.sourceEventId)!;
      const receipt=this.store.taskTransaction(()=>{
        const contact=this.store.contactPeer(source,ticket.recipientId,`update-${digest(messageId)}`,`对原委派补充指导（沿原任务处理，不另建）：\n${content}`,'peer');
        if(!contact.accepted)throw new Error(contact.reason??'补充指导未送达。');
        const entry=contact.events[0]??this.store.taskTransaction(sql=>{const row=sql.prepare('SELECT id FROM bot_inbox WHERE source_record_id=? AND companion_id=? LIMIT 1').get(contact.message.id,ticket.recipientId) as {id:string}|undefined;return row?this.store.getEvent(row.id):undefined;});
        if(!entry)throw new Error('补充指导缺少真实事件。');this.delegations.bindEvent(ticket.id,entry.id);
        return {accepted:true,taskId:proxy.id,meaning:'补充指导已投递给协作伙伴，沿原委派处理。'};
      });
      this.store.setMetadata(key,JSON.stringify({fingerprint,result:receipt}));this.scheduler.wake();this.changed(ticket.peerConversationId);return receipt;
    }
    const cancel=operation==='cancel'||operation==='remove';
    if(!cancel&&!['pause','resume_paused'].includes(operation))throw new Error('伙伴委派支持查看、补充、暂停、恢复、停止和移除；实际问题由接收方主脑处理。');
    const childIds=this.delegations.controlledTasks(ticket.id).map(task=>task.id);
    if(cancel){if(ticket.state==='active')this.delegations.finish(ticket.id,'cancelled');this.companionRuntime.withdraw(proxy.id);
      this.store.updateTask(proxy.id,{extra:{...proxy.extra,humanStopped:true,cancelRequested:true,humanStoppedAt:new Date().toISOString()}});
      this.finishTask(this.store.getTask(proxy.id)!,'cancelled',proxy.summary??'');this.suppressStoppedTaskNotices(proxy.id,event?.id);
    }else{
      if(ticket.state!=='active')throw new Error('已结束委派不能自动重开。');
      if(operation==='resume_paused'&&proxy.status!=='paused')throw new Error('只有暂停的委派可以恢复。');
      this.store.updateTask(proxy.id,{status:operation==='pause'?'paused':'running',extra:{...proxy.extra,pauseOrigin:operation==='pause'?'user':undefined,
        userPaused:operation==='pause',delegationUserPaused:operation==='pause',delegationMirroredPause:false,pauseRequested:false,pausedAt:operation==='pause'?new Date().toISOString():undefined,progress:{phase:operation==='pause'?'paused':'running',detail:operation==='pause'?'用户已暂停协作。':'沿原协作任务继续。'}}});
    }
    for(const childId of childIds){const child=this.store.getTask(childId);if(!child||['succeeded','failed','cancelled'].includes(child.status))continue;
      if(operation==='resume_paused'&&child.status!=='paused')continue;
      await this.controlTask(child,cancel?'cancel':operation as 'pause'|'resume_paused',undefined,`${messageId}:${child.id}`,{caller:'user'});
    }
    if(operation==='resume_paused'){
      const pending=Array.isArray(proxy.extra.delegationPendingControls)?proxy.extra.delegationPendingControls as Array<{id:string;text:string}>:[];
      for(const entry of pending)await this.controlDelegation(this.delegations.get(ticket.id)!,'send',entry.text,`deliver:${entry.id}`,{caller:'user'});
      const latest=this.store.getTask(proxy.id)!;this.store.updateTask(proxy.id,{extra:{...latest.extra,delegationPendingControls:[]}});
    }
    if(operation==='remove')await clearBotTaskHistory(this.store,{conversationId:proxy.conversationId,taskId:proxy.id,requestId:messageId});
    const result={accepted:true,taskId:proxy.id,status:this.store.getTask(proxy.id)?.status,meaning:cancel?'已停止此委派及其相关任务。':operation==='pause'?'已暂停，计时冻结。':'已沿原任务恢复。'};
    this.store.setMetadata(key,JSON.stringify({fingerprint,result}));this.changed(proxy.conversationId);this.changed(ticket.peerConversationId);this.maintainSafely();return result;
  }
  /** One bounded event-driven reminder after an actual Router turn. This is
   * delivery recovery, never a new task, synthetic result, timer or self-chat. */
  private afterPublishedReply(event:BotEvent):void{
    try{this.remindDelegationReturn(event);}catch(error){this.options.report?.(error);}
    // A delivery-reminder fault must never suppress a real published peer
    // reply. The observer and the formal task notification are independent.
    try{if(this.store.observeGroupReply(event.id).length)this.scheduler.wake();}catch(error){this.options.report?.(error);}
  }
  private remindDelegationReturn(event:BotEvent):void{
    const ticket=this.delegations.forEvent(event);if(!ticket||ticket.state!=='active')return;
    if(this.store.getTask(ticket.proxyTaskId)?.status==='paused')return;
    this.delegations.assertActive(ticket);
    const tasks=this.delegations.tasks(ticket.id);if(!tasks.length||this.delegations.controlledTasks(ticket.id).some(task=>!['succeeded','failed'].includes(task.status)||task.extra.removedAt||task.extra.humanStopped))return;
    const planIds=[...new Set(tasks.map(task=>task.extra.workflowId).filter((id):id is string=>typeof id==='string'))];
    if(planIds.some(id=>this.workflows.status(event,id).plans.some(plan=>!['completed','blocked'].includes(plan.state))))return;
    const key=`delegation-return-reminders:${ticket.id}`,count=Number(this.store.getMetadata(key)??0);
    if(!Number.isSafeInteger(count)||count>=2)return;
    const task=tasks.at(-1)!,source=this.store.getEvent(task.sourceEventId)!;
    this.store.taskTransaction(()=>{
      this.store.enqueueTaskNotice({conversationId:ticket.peerConversationId,senderId:'task-service',senderName:'协作交付',source:'task',
        sourceMessageId:`delegation-return-reminder:${ticket.id}:${count+1}`,recipientIds:[ticket.recipientId],kind:'task_done',
        content:'正式伙伴委派的实际Worker已返回，原委派聊天尚未收到交付。请现在先核验这些真实结果并调用companion_delegation.result；失败、缺少可用数据或工具不可用也应如实交回，不用询问是否重做代替交付；省略attachmentIds会交回本委派Worker已发布的成果文件。普通正文或message_peer不完成交付，不另派任务，不将其他聊天带入。',
        correlationId:ticket.correlationId,causationId:source.id,payload:{taskId:task.id,attemptId:task.attemptId,hop:Math.min(5,causalHop(event)+1)}});
      this.store.setMetadata(key,String(count+1));
    });this.scheduler.wake();this.changed(ticket.peerConversationId);
  }
  private notifyDelegationPause(ticket:BotDelegationTicket,task:BotTask):void{
    const source=this.store.getEvent(ticket.sourceEventId),proxy=this.store.getTask(ticket.proxyTaskId),room=this.store.getConversation(ticket.sourceConversationId);
    if(!source||!proxy||!room||room.dissolvedAt||room.revision!==ticket.sourceAclRevision||this.store.taskSourcesWithdrawn(proxy.id)||this.store.taskSourcesWithdrawn(task.id))return;
    const incident=task.extra.executorInterruption as {reason?:string;at?:string}|undefined;
    const transition=String(task.extra.pausedAt??incident?.at??'legacy-pause');
    const identity=digest(JSON.stringify([ticket.id,task.id,transition,task.extra.executorInterruptionCount??0,task.extra.pauseOrigin,task.extra.executorPaused===true]));
    const key=`delegation-pause-notice:${ticket.id}:${task.id}`;if(this.store.getMetadata(key)===identity)return;
    const detail=task.extra.progress&&typeof task.extra.progress==='object'?String((task.extra.progress as Record<string,unknown>).detail??'').slice(0,1000):'';
    const recipient=this.store.getCompanion(task.companionId)?.name??'协作伙伴';
    this.store.taskTransaction(()=>{
      this.store.enqueueTaskNotice({conversationId:ticket.sourceConversationId,senderId:'task-service',senderName:'协作状态',source:'task',
        sourceMessageId:`delegation-paused:${ticket.id}:${identity}`,recipientIds:[ticket.requesterId],kind:'task_progress',
        content:`协作伙伴${recipient}的任务已暂停，尚未交回完成结果。${detail}${task.error?`\n执行环境提示：${task.error.slice(0,1000)}`:''}\n原委派和已有进展均已保留。请向当前用户或委派伙伴如实说明暂停原因；不要称已完成、等待回答或要求重复授权，不在本轮自动重建/重试任务。修复执行环境并明确继续后，沿原任务恢复。`,
        correlationId:ticket.correlationId,causationId:source.id,payload:{taskId:ticket.proxyTaskId,delegationId:ticket.id,delegationTaskId:task.id,
          delegationIncidentId:identity,delegationState:'paused',hop:derivedCause(source).hop}});
      this.store.setMetadata(key,identity);
    });this.scheduler.wake();this.changed(ticket.sourceConversationId);
  }
  private refreshDelegations():void{
    const rows=this.store.taskTransaction(sql=>sql.prepare("SELECT id,rowid AS seq FROM bot_delegations WHERE rowid>? AND json_extract(record_json,'$.state')<>'completed' ORDER BY rowid LIMIT 32").all(this.delegationCursor)) as Array<{id:string;seq:number}>;
    this.delegationCursor=rows.at(-1)?.seq??0;
    for(const row of rows){const ticket=this.delegations.get(row.id)!,proxy=this.store.getTask(ticket.proxyTaskId);if(!proxy)continue;
      const needsCleanup=ticket.state==='cancelled'&&this.delegations.controlledTasks(ticket.id).some(task=>!['succeeded','failed','cancelled'].includes(task.status));
      let invalid=false;if(ticket.state==='active'&&proxy.status!=='paused')try{this.delegations.assertActive(ticket);}catch{invalid=true;}
      if(needsCleanup||invalid){if(this.delegationCleanup.size<4&&!this.delegationCleanup.has(ticket.id)){
        this.delegationCleanup.add(ticket.id);void this.controlDelegation(ticket,'cancel',undefined,`host-close:${ticket.id}`,{caller:'user'})
          .catch(error=>this.options.report?.(error)).finally(()=>this.delegationCleanup.delete(ticket.id));}continue;}
      const explicitPause=proxy.extra.delegationUserPaused===true||proxy.extra.userPaused===true&&proxy.extra.delegationMirroredPause!==true;
      if(ticket.state!=='active'||proxy.status==='paused'&&explicitPause||proxy.extra.cancelRequested)continue;
      const tasks=this.delegations.tasks(ticket.id),active=tasks.find(task=>task.status==='running')??tasks.find(task=>task.status==='waiting')??tasks.find(task=>task.status==='paused')??tasks.find(task=>task.status==='queued');
      const executorCause=active&&executorPauseCause(active),pausedDetail=active?.status==='paused'&&active.extra.progress&&typeof active.extra.progress==='object'?String((active.extra.progress as Record<string,unknown>).detail??'').slice(0,1000):'';
      const question=active&&this.taskRuntime.attention(active.id),questionText=question?.state==='queued'?question.questions.map(item=>item.question).join('\n').slice(0,4000):undefined;
      const mirroredPause=active?.status==='paused',status=mirroredPause?'paused':active?.status==='waiting'?'waiting':active?.status==='queued'?'queued':tasks.length?'running':'queued';
      const progress={phase:active?.status==='paused'?'paused':active?.status==='waiting'?'waiting':active?.status==='queued'?'queued':active?'running':'queued',
        detail:`${this.store.getCompanion(ticket.recipientId)?.name??'协作伙伴'} · ${tasks.filter(task=>task.status==='succeeded').length}/${tasks.length} 个执行任务已完成${questionText?'，需要补充信息：'+questionText:pausedDetail?'，已暂停：'+pausedDetail:tasks.length&&!active?'，等待伙伴交回成果。':'。'}`};
      if(JSON.stringify(proxy.extra.progress)!==JSON.stringify(progress)||proxy.status!==status||proxy.extra.delegationMirroredPause!==mirroredPause||proxy.extra.executorPaused!==!!executorCause||proxy.extra.userPaused!==false){
        this.store.updateTask(proxy.id,{status,...(questionText?{summary:questionText}:proxy.extra.delegationQuestionId?{summary:''}:{}),extra:{...proxy.extra,progress,
          delegationQuestionId:questionText?question!.id:undefined,userPaused:false,delegationMirroredPause:mirroredPause,executorPaused:!!executorCause,
          ...(active?.status==='paused'?{pauseOrigin:active.extra.pauseOrigin??'router',pausedAt:active.extra.pausedAt??proxy.extra.pausedAt??new Date().toISOString()}
            :{pauseOrigin:undefined,pausedAt:undefined,pauseRequestedAt:undefined})}});this.changed(proxy.conversationId);
      }
      for(const child of this.delegations.controlledTasks(ticket.id))if(child.status==='paused'&&!child.extra.removedAt&&!child.extra.cancelRequested)this.notifyDelegationPause(ticket,child);
      if(questionText){const source=this.store.getEvent(ticket.sourceEventId)!;this.store.enqueueTaskNotice({conversationId:proxy.conversationId,senderId:'task-service',senderName:'协作进展',source:'task',
        sourceMessageId:`delegation-question:${ticket.id}:${question!.id}`,recipientIds:[proxy.companionId],kind:'task_progress',content:`协作伙伴需要原任务的补充信息：\n${questionText}\n已有事实可通过companion_delegation.send交给对方主脑；缺少用户偏好或授权再询问用户。`,
        correlationId:ticket.correlationId,causationId:source.id,payload:{taskId:proxy.id,delegationId:ticket.id,delegationTaskId:active!.id,delegationQuestionId:question!.id,hop:1}});this.scheduler.wake();}
    }
  }
  private launchTask(task: BotTask): void {
    if (task.extra.delegationProxy === true) return; // Its real Workers belong to the receiving companion.
    const resources = new Set([...this.taskRuns.keys(), ...this.taskPreparations.keys()]).size;
    if (this.closed || this.taskRuns.has(task.id) || this.taskPreparations.has(task.id) || resources >= MAX_WORKER_RUNS || task.extra.cancelRecoveryPaused === true
      || task.extra.pauseRecoveryPaused === true && !task.extra.cancelRequested || !['queued', 'running', 'waiting', 'paused', 'unknown'].includes(task.status)
      || task.status === 'paused' && !task.extra.cancelRequested && !task.extra.pauseRequested
      || Number(task.extra.retryAt ?? 0) > Date.now() && !(task.extra.cancelRequested && task.extra.nativeAttempted !== true)) return;
    if (!task.extra.cancelRequested && !task.extra.pauseRequested && (task.status === 'waiting' && !this.taskRuntime.hasReadyAnswer(task.id)
      || task.status !== 'unknown' && this.runningTasks(task.companionId) >= this.store.workerConcurrency(task.companionId))) return;
    const controller = new AbortController();
    let prepared!: () => void;
    const preparation = new Promise<void>(resolve => { prepared = resolve; }); this.taskPreparations.set(task.id, preparation);
    const releasePreparation = () => {
      prepared();
      if (this.taskPreparations.get(task.id) === preparation) { this.taskPreparations.delete(task.id); if (!this.closed) this.maintainSafely(); }
    };
    const execution = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return this.runTask(task, controller.signal, releasePreparation); }).finally(releasePreparation);
    const promise = abortable(execution, controller.signal).catch(error => {
      if (this.closed) return;
      const current = this.store.getTask(task.id); if (!current || ['succeeded', 'failed', 'cancelled'].includes(current.status)) return;
      if (current.status === 'paused' && !current.extra.cancelRequested) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'BOT_OUTPUT_LIMIT' && error && typeof error === 'object' && 'checkpoint' in error && Number.isSafeInteger(error.checkpoint)) {
        this.store.updateTask(task.id, { status: 'waiting', sessionId: 'sessionId' in error && typeof error.sessionId === 'string' ? error.sessionId : current.sessionId,
          summary: 'partialText' in error && typeof error.partialText === 'string' ? error.partialText : current.summary,
          error: '', extra: { ...current.extra, outputCheckpoint: error.checkpoint, progress: { phase: 'waiting', detail: '已保存当前进展，等待继续；继续会沿用原任务和工作区。', updatedAt: new Date().toISOString() } } });
      } else if (code === 'BOT_ABORT_ACKNOWLEDGED' && error && typeof error === 'object' && 'result' in error) {
        const receipt = error.result as { status: string; text: string; sessionId?: string; outputCheckpoint?: number };
        this.settleWorkerTurn(current, { ...receipt, eventId: `work-${current.id}`, sessionId: receipt.sessionId ?? current.sessionId ?? '', status: receipt.status === 'succeeded' ? 'succeeded' : receipt.status === 'failed' ? 'failed' : 'cancelled' });
      } else if (code === 'BOT_EFFECT_UNKNOWN') {
        // A user may resolve the gate after its HTTP receipt but before the
        // paused native stream detaches. Its late error cannot undo that receipt.
        if (current.status !== 'queued' || this.taskRuntime.pendingEffects(task.id).length) this.taskRuntime.markUnknown(current);
        this.scheduler.wake();
      } else if (code === 'BOT_COMPANION_INSTANCE_REQUIRED') {
        this.pauseForExecutor(current, 'configuration', '伙伴尚未绑定专属 DSH 实例，任务已暂停；绑定后可继续原任务。', errorText(error));
      } else if (code === 'DSH_HOST_UNAVAILABLE') {
        const reason = (error as { reason?: string }).reason;
        // getHost failed before native admission. Do not invent an uncertain
        // delivery or cancellation obligation for a never-submitted task.
        const attempts = Number(current.extra.retryAttempts ?? 0) + 1;
        const extra = { ...current.extra, nativeAttempted: task.extra.nativeAttempted === true, retryAttempts: attempts,
          lastRecoveryError: errorText(error).slice(0, 1000), lastRecoveryStage: 'host' };
        if (reason !== 'startup' || attempts >= 3) {
          this.pauseForExecutor(this.store.updateTask(task.id, { extra }), reason ?? 'startup', reason === 'stopped'
            ? '执行实例已关闭，任务已暂停；点击继续将启动原实例并恢复原任务。'
            : '执行环境暂不可用，任务和进展已保留；修复运行环境后可继续原任务。', errorText(error));
        } else this.store.updateTask(task.id, { status: 'queued', error: '', extra: { ...extra, retryAt: Date.now() + attempts * 3000,
          progress: { phase: 'recovering', detail: '正在重新连接原执行环境，任务和已有进展会保留。', updatedAt: new Date().toISOString() } } });
      } else if (code === 'BOT_LANE_BUSY' && /capacity is occupied|native lane capacity/iu.test(errorText(error))) {
        const waits = Number(current.extra.capacityWaitCount ?? 0) + 1;
        this.store.updateTask(task.id, { status: 'queued', error: '', extra: { ...current.extra,
          nativeAttempted: task.extra.nativeAttempted === true, capacityWaitCount: waits, retryAt: Date.now() + Math.min(5000, waits * 1000),
          progress: { phase: 'queued', detail: '执行环境的并发容量已满，等待空位后继续原任务。', updatedAt: new Date().toISOString() } } });
      } else if (controller.signal.aborted || code === 'BOT_DELIVERY_UNKNOWN' || code === 'BOT_LANE_BUSY' || code === 'MEMORY_CAPACITY') {
        const attempts = Number(current.extra.retryAttempts ?? 0) + 1;
        if (attempts >= 5) {
          this.pauseForExecutor(this.store.updateTask(task.id, { extra: { ...current.extra, retryAttempts: attempts,
            lastRecoveryError: errorText(error).slice(0, 1000), lastRecoveryStage: error && typeof error === 'object' && 'stage' in error ? error.stage : undefined } }),
          'interrupted', '自动重连暂未成功，任务已暂停；进展和原会话已保留，可手动继续。', errorText(error));
        } else this.store.updateTask(task.id, { status: 'queued', error: '', extra: { ...current.extra, retryAttempts: attempts, retryAt: Date.now() + Math.min(30000, attempts * 1000),
          progress: { phase: 'recovering', detail: '连接中断，正在恢复原任务；没有重复创建任务。', updatedAt: new Date().toISOString() },
          lastRecoveryError: errorText(error).slice(0, 1000), lastRecoveryStage: error && typeof error === 'object' && 'stage' in error ? error.stage : undefined } });
      } else if (this.taskRuntime.pendingEffects(task.id).length) { this.taskRuntime.markUnknown(current); this.scheduler.wake();
      } else { this.finishTask(current, 'failed', error && typeof error === 'object' && 'partialText' in error && typeof error.partialText === 'string' ? error.partialText : '', errorText(error)); this.options.report?.(error); }
    })
      .finally(() => { this.toolServer.releaseWorker(`worker-${task.id}`); this.taskRuns.delete(task.id); this.changed(task.conversationId); if (!this.closed) this.maintainSafely(); });
    this.taskRuns.set(task.id, { companionId: task.companionId, controller, promise }); this.lastTaskCompanion = task.companionId;
  }
  /** Local stop/pause is immediate. Native shutdown is a bounded background
   * cleanup, not a second business state or permission to replay the work. */
  private flushExecutorControl(taskId: string): Promise<void> {
    const running = this.executorControlRuns.get(taskId); if (running) return running;
    const task = this.store.getTask(taskId), control = task?.extra.executorControl as ExecutorControl | undefined;
    if (this.closed || !task || !control || control.state !== 'pending' || control.retryAt > Date.now()) return Promise.resolve();
    const operation = (async () => {
      const timeout = AbortSignal.timeout(10000), signal = AbortSignal.any([timeout, this.maintenanceAbort.signal]);
      try {
        const source = this.store.getEvent(task.sourceEventId); if (!source) throw new Error('任务来源事件不存在。');
        const proof = await abortable(this.options.brain.cancelDurable({ role: 'worker', workerAccess: 'full', laneId: `worker-${task.id}`, eventId: `work-${task.id}`,
          cwd: this.taskWorkdir({ ...task, extra: { ...task.extra, workspaceLayout: control.workspaceLayout ?? task.extra.workspaceLayout } }, source.securityDomainId), system: workerSystem,
          model: { apiFormat: 'openai_chat', model: 'cancel-only', baseUrl: 'http://127.0.0.1:1', apiKey: 'cancel-only' }, tools: [],
          callback: await this.toolServer.forWorker(`worker-${task.id}`, `work-${task.id}`), workerTools, signal }, control.kind === 'pause'), signal);
        if (this.closed) return;
        const current = this.store.getTask(taskId), latest = current?.extra.executorControl as ExecutorControl | undefined;
        if (!current || latest?.requestedAt !== control.requestedAt || latest.kind !== control.kind) return;
        if (!proof.result && !proof.absent && !(control.kind === 'pause' && proof.accepted && proof.paused)) throw new Error('执行器控制回执尚未到达。');
        this.store.updateTask(taskId, { extra: { ...current.extra, executorControl: { ...latest, state: 'acknowledged', attempts: latest.attempts + 1, retryAt: 0, error: undefined },
          ...(proof.result ? { turnOutcome: { status: proof.result.status, eventId: proof.result.eventId, receivedAt: new Date().toISOString() } } : {}),
          ...(control.kind === 'pause' && current.status === 'paused' && Number.isSafeInteger(proof.result?.outputCheckpoint) ? { outputCheckpoint: proof.result!.outputCheckpoint } : {}) } });
      } catch (error) {
        if (this.closed) return;
        const current = this.store.getTask(taskId), latest = current?.extra.executorControl as ExecutorControl | undefined;
        if (!current || latest?.requestedAt !== control.requestedAt || latest.kind !== control.kind) return;
        const attempts = latest.attempts + 1;
        this.store.updateTask(taskId, { extra: { ...current.extra, executorControl: { ...latest, attempts, state: attempts >= 3 ? 'unavailable' : 'pending',
          retryAt: attempts >= 3 ? 0 : Date.now() + attempts * 1000, error: errorText(error).slice(0, 1000) } } });
      }
    })().finally(() => { this.executorControlRuns.delete(taskId); if (!this.closed) this.changed(task.conversationId); });
    this.executorControlRuns.set(taskId, operation); return operation;
  }
  /** Only lifecycle and tool identities are public progress; internal reasoning
   * and arbitrary worker token streams never become a chat status message. */
  private taskProgress(taskId: string, phase: string, detail?: string, toolName?: string): void {
    if (this.closed) return;
    const current = this.store.getTask(taskId); if (!current || current.status === 'paused' || current.extra.cancelRecoveryPaused === true || current.extra.pauseRecoveryPaused === true || ['succeeded', 'failed', 'cancelled'].includes(current.status)) return;
    const previous = current.extra.progress as { phase?: string; toolName?: string; updatedAt?: string } | undefined;
    const changed = previous?.phase !== phase || previous?.toolName !== toolName;
    if (!changed && Date.now() - Date.parse(previous?.updatedAt ?? '') < 3000) return;
    const now = new Date().toISOString(), progress = { phase, detail, toolName: toolName?.slice(0, 160), updatedAt: now };
    const activity = Array.isArray(current.extra.activity) ? current.extra.activity : [];
    this.store.updateTask(taskId, { extra: { ...current.extra, progress,
      activity: changed ? [...activity, { ...progress, id: randomUUID(), createdAt: now }].slice(-30) : activity } });
    this.changed(current.conversationId);
  }
  private workerProgress(taskId: string, event: NativeHostEvent): void {
    const task = this.store.getTask(taskId);
    if (!task || task.status === 'paused' || ['succeeded', 'failed', 'cancelled'].includes(task.status)) return;
    if (event.sessionId && task && task.sessionId !== event.sessionId) this.store.updateTask(taskId, { sessionId: event.sessionId });
    const stage = event.stage ?? event.type;
    if (event.type === 'approval_required') this.taskProgress(taskId, 'waiting-approval', '等待在 DSH 工作台确认权限');
    else if (event.type === 'approval_decided') this.taskProgress(taskId, 'waiting-model', '权限选择已记录，等待执行器反馈');
    else if (['tool_start', 'tool_prepare'].includes(stage)) this.taskProgress(taskId, 'using-tool', '正在执行工具', event.toolName);
    else if (['tool_end', 'step_start', 'step_end', 'turn_start', 'session'].includes(stage)) this.taskProgress(taskId, 'waiting-model', '执行器正在处理下一步');
    else if (stage === 'compaction' || stage === 'compacting' || stage === 'compaction_start') this.taskProgress(taskId, 'compacting', '正在整理任务上下文，已保存的工作会保留');
    else if (stage === 'compaction_end') this.taskProgress(taskId, 'waiting-model', '任务上下文已整理，正在继续');
    else if (stage === 'output_continuation') this.taskProgress(taskId, 'continuing', '已保存本段输出，正在沿原任务继续');
    else if (stage === 'message' || ['text_delta', 'text_stream'].includes(event.type)) this.taskProgress(taskId, 'generating', '执行器正在生成输出');
    else if (stage === 'complete') this.taskProgress(taskId, 'finalizing', '正在核对执行结果');
  }
  private taskWorkdir(task: BotTask, securityDomainId: string): string {
    // Persisted tasks retain their old directory; new tasks group first by
    // companion so workers from a shared room cannot rename each other's group.
    return task.extra.workspaceLayout === 'companion-v1'
      ? path.join(this.options.root, 'workspaces', digest(task.companionId), digest(securityDomainId), task.id)
      : path.join(this.options.root, 'workspaces', digest(securityDomainId), task.id);
  }
  private async upgradeTaskAccess(task: BotTask, signal?: AbortSignal): Promise<void> {
    const current = this.store.getTask(task.id);
    if (!current || ['succeeded', 'failed', 'cancelled'].includes(current.status) || current.extra.workerAccess === 'full' && !current.extra.workerAccessUpgradePending) return;
    signal ??= this.maintenanceAbort.signal; signal.throwIfAborted();
    const pending = this.taskAccessUpgrades.get(task.id); if (pending) return abortable(pending, signal);
    const upgrade = (async () => {
      const source = this.store.getEvent(task.sourceEventId); if (!source) throw new Error('任务来源事件不存在。');
      // Persist the desired monotonic identity before contacting native. If the
      // ACK is lost, retries/cancellation must never ask native to downgrade.
      this.store.updateTask(task.id, { extra: { ...current.extra, workerAccess: 'full', workerAccessUpgradePending: current.extra.nativeAttempted === true } });
      if (current.extra.nativeAttempted === true) {
        if (!this.options.brain.upgradeWorkerAccess) throw new Error('执行器暂不支持原会话权限升级，请使用当前版本执行器后继续原任务。');
        await abortable(this.options.brain.upgradeWorkerAccess({ laneId: `worker-${task.id}`, eventId: `work-${task.id}`,
          cwd: this.taskWorkdir(task, source.securityDomainId), system: workerSystem, signal }), signal);
      }
      signal.throwIfAborted();
      const latest = this.store.getTask(task.id); if (latest) this.store.updateTask(task.id, { extra: { ...latest.extra,
        workerAccess: 'full', workerAccessUpgradePending: false, workerAccessUpgradedAt: new Date().toISOString() } });
    })();
    this.taskAccessUpgrades.set(task.id, upgrade);
    try { await upgrade; } finally { if (this.taskAccessUpgrades.get(task.id) === upgrade) this.taskAccessUpgrades.delete(task.id); }
  }
  private async runTask(task: BotTask, signal: AbortSignal, onPrepared: () => void): Promise<void> {
    if (!task.extra.cancelRequested && !task.extra.pauseRequested && !this.store.taskSourcesWithdrawn(task.id)) {
      await this.ensureCompanionBindings([task.companionId]);
      signal.throwIfAborted();
    }
    if (task.extra.hostResumeRequested === true) {
      await this.options.resumeTaskRuntime?.(task.id, signal); signal.throwIfAborted();
    }
    const control = task.extra.executorControl as ExecutorControl | undefined;
    if (control?.kind === 'pause') {
      await this.flushExecutorControl(task.id); signal.throwIfAborted();
      const current = this.store.getTask(task.id), latest = current?.extra.executorControl as ExecutorControl | undefined;
      if (!current || current.status === 'paused' || ['succeeded', 'failed', 'cancelled'].includes(current.status)) return;
      if (latest && latest.state !== 'acknowledged') { this.markTaskPaused(current); return; }
    }
    const source = this.store.getEvent(task.sourceEventId); if (!source) throw new Error('任务来源事件不存在。');
    const stopping = this.store.getTask(task.id)?.extra.cancelRequested || this.store.getTask(task.id)?.extra.pauseRequested || this.store.taskSourcesWithdrawn(task.id);
    if (!stopping && !this.store.isRetiredDevelopmentDefault(task.companionId)) await this.loadTombstones(scopeFor(source));
    signal.throwIfAborted();
    let current = this.store.getTask(task.id); if (!current || ['succeeded', 'failed', 'cancelled'].includes(current.status)) return;
    if (this.store.taskSourcesWithdrawn(task.id)) { this.store.updateTask(task.id, { extra: { ...current.extra, cancelRequested: true } }); return; }
    if (!current.extra.cancelRequested && !current.extra.pauseRequested) {
      this.companionRuntime.validateTask(current);
      await this.upgradeTaskAccess(current, signal); signal.throwIfAborted(); current = this.store.getTask(task.id)!;
    }
    const cwd = this.taskWorkdir(task, source.securityDomainId); await mkdir(cwd, { recursive: true });
    signal.throwIfAborted();
    const model = this.options.model();
    const companionName = this.store.getCompanion(task.companionId)?.name ?? '伙伴';
    const workerModel = { ...model, maxTokens: model.maxOutputTokens ? Math.min(model.maxOutputTokens, (model.contextWindow ?? Number.MAX_SAFE_INTEGER) - 256) : model.maxTokens };
    const input = { role: 'worker' as const, workerAccess: 'full' as const, laneId: `worker-${task.id}`, eventId: `work-${task.id}`, cwd,
      workspaceTitle: companionName.slice(0, 100), sessionTitle: (typeof current.extra.title === 'string' ? current.extra.title : '任务').slice(0, 100),
      workspaceParent: { path: task.extra.workspaceLayout === 'companion-v1' ? path.join(this.options.root, 'workspaces', digest(task.companionId)) : path.dirname(cwd), title: companionName },
      system: workerSystem,
      model: workerModel, tools: [], callback: await this.toolServer.forWorker(`worker-${task.id}`, `work-${task.id}`), signal };
    signal.throwIfAborted();

    if (current.status === 'waiting' && !this.taskRuntime.hasReadyAnswer(task.id)) return;
    const pending = this.taskRuntime.pendingEffects(task.id);
    if (pending.length) {
      const proof = await this.options.brain.inspectEffects({ laneId: input.laneId, eventId: input.eventId, callIds: pending.map(effect => effect.callId),
        effects: pending.map(effect => ({ callId: effect.callId, nativeSessionId: effect.nativeSessionId, nativeCallId: effect.nativeCallId })), signal });
      signal.throwIfAborted();
      if (!this.taskRuntime.reconcileEffects(current, proof)) { this.scheduler.wake(); return; }
    }
    const answers = this.taskRuntime.answeredQuestions(task.id);
    if (current.extra.nativeAttempted === true && answers.length) {
      const proof = await this.options.brain.inspectQuestionAnswers({ laneId: input.laneId, eventId: input.eventId,
        questions: answers.map(answer => ({ questionId: answer.questionId, callId: answer.callId, answersHash: digest(JSON.stringify(answer.answers)), nativeSessionId: answer.nativeSessionId, nativeCallId: answer.nativeCallId })),
        afterOffsets: Object.fromEntries(answers.map(answer => [answer.nativeSessionId!, this.taskRuntime.answerCursor(task.id, answer.nativeSessionId)])),
        afterOffset: this.taskRuntime.answerCursor(task.id), signal });
      signal.throwIfAborted(); this.taskRuntime.recordAnswerProofs(task.id, answers, proof);
    }
    if (this.runningTasks(task.companionId, task.id) >= this.store.workerConcurrency(task.companionId)) {
      this.store.updateTask(task.id, { status: 'queued', extra: { ...this.store.getTask(task.id)!.extra, retryAt: Date.now() + 500 } }); return;
    }
    signal.throwIfAborted();
    current = this.store.getTask(task.id); if (!current || current.status === 'paused' || ['succeeded', 'failed', 'cancelled'].includes(current.status) || current.extra.cancelRequested || current.extra.pauseRequested) return;
    if (current.extra.nativeAttempted !== true && (!current.extra.workerPrompt || current.extra.workerPromptVersion !== 2)) {
      const attachmentIds = Array.isArray(current.extra.attachmentIds) ? current.extra.attachmentIds as string[] : [];
      const inventory = await this.verifiedAttachmentFiles(source, attachmentIds, Number(current.extra.handoffThroughSequence ?? source.sourceMessageSequence), signal);
      const files = [];
      const copyIds = inventory.filter(file => !file.analysisBlocked).map(file => file.id);
      for (let index = 0; index < copyIds.length; index += 64) files.push(...await this.requireMedia().stageForTask({ conversationId: task.conversationId,
        attachmentIds: copyIds.slice(index, index + 64), destination: cwd, signal }));
      signal.throwIfAborted(); current = this.store.getTask(task.id)!;
      if (current.extra.cancelRequested || this.store.taskSourcesWithdrawn(task.id)) throw new Error('任务输入来源已撤回或任务已停止。');
      const inputFiles = files.map(file => ({ ...botHandoffFile(file), relativePath: file.relativePath }));
      const handedFiles = [...inputFiles, ...inventory.filter(file => file.analysisBlocked)];
      // Mirror the task card, not the router's conversational context. Source
      // event IDs and the full chat remain in the host store for provenance.
      const sourceDirectory = path.join(cwd, '.worldlinebox'); await mkdir(sourceDirectory, { recursive: true });
      signal.throwIfAborted();
      const sourcePath = path.join(sourceDirectory, 'task-input.json');
      const { assertBotMediaPhysicalPath } = await import('./media-service'); await assertBotMediaPhysicalPath(sourceDirectory);
      signal.throwIfAborted();
      const original = JSON.stringify({ requirements: task.goal, files: botTaskFileEvidence(handedFiles) });
      try { await writeFile(sourcePath, original, { encoding: 'utf8', flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await assertBotMediaPhysicalPath(sourcePath);
        if (!(await lstat(sourcePath)).isFile() || await readFile(sourcePath, 'utf8') !== original) throw new Error('任务原始请求副本与耐久来源不一致。', { cause: error });
      }
      const sourceRequest = { path: sourcePath, relativePath: '.worldlinebox/task-input.json', sha256: digest(original), eventId: source.id };
      signal.throwIfAborted();
      current = this.store.updateTask(task.id, { extra: { ...current.extra, inputFiles, sourceRequest,
        workerPromptVersion: 2, workerPrompt: buildBotTaskPrompt({ goal: task.goal, files: handedFiles, sourcePath }) } });
    }
    signal.throwIfAborted();
    this.store.updateTask(task.id, { status: 'running', error: '', extra: { ...current.extra, nativeAttempted: true, turnOutcome: undefined } });
    this.taskProgress(task.id, 'connecting', '正在连接任务执行环境，未启动时会按需启动'); this.changed(task.conversationId);
    // Once native admission begins, its durable cancellation protocol owns
    // recovery. Before that point, never overlap old/new attachment staging.
    onPrepared();
    const result = await this.options.brain.run({ ...input, workerTools, prompt: typeof current.extra.workerPrompt === 'string' ? current.extra.workerPrompt : task.goal,
      resumeHost: current.extra.hostResumeRequested === true,
      ...(Number.isSafeInteger(current.extra.continueAfterSeq) ? { continueAfterSeq: Number(current.extra.continueAfterSeq) } : {}),
      ...(current.extra.taskContinuation && typeof current.extra.taskContinuation === 'object' ? { taskContinuation: current.extra.taskContinuation as { id: string; text: string } } : {}),
      answeredQuestions: this.taskRuntime.answeredQuestions(task.id), onEvent: event => { if (!signal.aborted) { this.workerProgress(task.id, event); void this.flushTaskControls(task.id); } } });
    if (this.closed) return;
    signal.throwIfAborted();
    // Quiesce a guidance callback racing the native terminal before deciding
    // whether its durable intent still needs same-session continuation.
    await this.flushTaskControls(task.id);
    signal.throwIfAborted();
    current = this.store.getTask(task.id); if (!current || ['succeeded', 'failed', 'cancelled'].includes(current.status)) return;
    const remaining = this.taskRuntime.pendingEffects(task.id);
    if (remaining.length) {
      const proof = await this.options.brain.inspectEffects({ laneId: input.laneId, eventId: input.eventId, callIds: remaining.map(effect => effect.callId),
        effects: remaining.map(effect => ({ callId: effect.callId, nativeSessionId: effect.nativeSessionId, nativeCallId: effect.nativeCallId })), signal });
      signal.throwIfAborted();
      if (!this.taskRuntime.reconcileEffects(current, proof)) { this.scheduler.wake(); return; }
    }
    this.settleWorkerTurn(current, result);
  }
  /** Reconcile legacy projections from an already persisted native outcome.
   * Never resubmit the original request merely to obtain an optional report. */
  private reconcileFinishedTasks(): void {
    const ids = this.store.taskTransaction(sql => sql.prepare(`SELECT id FROM bot_tasks WHERE status='waiting'
      AND json_extract(extra_json,'$.removedAt') IS NULL AND json_extract(extra_json,'$.outputCheckpoint') IS NULL
      AND json_extract(extra_json,'$.turnOutcome.status') IN ('succeeded','failed','cancelled')
      AND NOT EXISTS(SELECT 1 FROM bot_task_effects e WHERE e.task_id=bot_tasks.id AND e.state IN ('pending','unknown'))
      AND NOT EXISTS(SELECT 1 FROM bot_task_questions q WHERE q.task_id=bot_tasks.id AND q.state='queued')
      ORDER BY updated_at,id LIMIT 100`).all() as Array<{ id: string }>);
    for (const { id } of ids) {
      const task = this.store.getTask(id); if (!task || this.taskRuns.has(id)) continue;
      const outcome = task.extra.turnOutcome as { status: BotDshResult['status']; eventId?: string };
      this.settleWorkerTurn(task, { sessionId: task.sessionId ?? BotDshBrain.sessionId(`worker-${id}`),
        eventId: outcome.eventId ?? `work-${id}`, status: outcome.status, text: task.summary ?? '', error: task.error });
    }
  }
  /** Native terminal receipts close normal work. Reports explain incomplete
   * segments; only real questions or uncertain effects can require an answer. */
  private settleWorkerTurn(task: BotTask, result: BotDshResult): void {
    const current = this.store.getTask(task.id); if (!current || current.status === 'paused' || ['succeeded', 'failed', 'cancelled'].includes(current.status)) return;
    this.store.updateTask(task.id, { sessionId: result.sessionId, extra: { ...current.extra,
      turnOutcome: { status: result.status, eventId: result.eventId, receivedAt: new Date().toISOString() } } });
    const report = this.taskReports.current(this.store.getTask(task.id)!);
    if (result.status !== 'succeeded') { this.finishTask(current, result.status, result.text, result.error, result.sessionId); return; }
    const pending = this.taskRuntime.pendingEffects(task.id);
    if (pending.length) { this.taskRuntime.markUnknown(this.store.getTask(task.id)!); this.scheduler.wake(); return; }
    const controls = Array.isArray(current.extra.pendingControls) ? current.extra.pendingControls as Array<{ id: string; text: string }> : [];
    if (controls.length && !current.extra.cancelRequested && !current.extra.pauseRequested) {
      const [intent, ...remaining] = controls;
      const latest = this.store.getTask(task.id)!;
      this.store.updateTask(task.id, { status: 'queued', extra: { ...latest.extra, pendingControls: remaining,
        taskContinuation: { id: intent!.id, text: intent!.text }, taskContinuationId: intent!.id,
        reportBaseline: (latest.extra.workerReport as { callId?: string } | undefined)?.callId ?? latest.extra.reportBaseline ?? null,
        retryAt: 0, progress: { phase: 'queued', detail: '执行轮次结束，尚未确认接收的指导保留在原任务中继续核实。', updatedAt: new Date().toISOString() } } });
      this.store.setMetadata(`task-control:${task.id}:${intent!.id}`, JSON.stringify({ fingerprint: digest(intent!.text), state: 'continuation' }));
      this.changed(task.conversationId); return;
    }
    const question = this.taskRuntime.attention(task.id);
    if (question?.state === 'queued') {
      this.store.updateTask(task.id, { status: 'waiting', summary: result.text || report?.summary, extra: { ...this.store.getTask(task.id)!.extra,
        progress: { phase: 'waiting-question', detail: '执行器提出了需要回答的问题。', updatedAt: new Date().toISOString() } } });
      this.changed(task.conversationId); return;
    }
    const verified = report && this.taskReports.readyIsCurrent(current, report);
    const deliveryText = this.taskReports.deliveryText(this.store.getTask(task.id)!, result.text);
    if (report?.state === 'failed') { this.finishTask(current, 'failed', report.summary, report.summary, result.sessionId); return; }
    if (report && ['ready', 'dropped'].includes(report.state) && verified) {
      this.finishTask(current, 'succeeded', deliveryText || report.summary, undefined, result.sessionId); return;
    }
    // A missing or stale optional report must not leave a finished native turn
    // permanently open. All root tool effects were reconciled above.
    if (!report || ['ready', 'dropped'].includes(report.state)) {
      const latest = this.store.getTask(task.id)!;
      this.store.updateTask(task.id, { extra: { ...latest.extra, completionBasis: verified ? 'verified-report' : 'native-terminal' } });
      this.finishTask(this.store.getTask(task.id)!, 'succeeded', deliveryText || report?.summary, undefined, result.sessionId); return;
    }
    const phase = report.state === 'blocked' ? 'blocked' : report.state === 'waiting' ? 'waiting-event' : 'incomplete';
    const detail = report.summary;
    const latest = this.store.getTask(task.id)!;
    this.store.updateTask(task.id, { status: 'paused', summary: report.summary || result.text, error: '', extra: { ...latest.extra,
      pauseOrigin: 'router', userPaused: false, pausedAt: new Date().toISOString(), pauseReason: phase,
      progress: { phase, detail, updatedAt: new Date().toISOString() } } });
    const source = this.store.getEvent(task.sourceEventId)!;
    this.store.enqueueTaskNotice({ conversationId: task.conversationId, senderId: 'task-service', senderName: '任务回执', source: 'task',
      sourceMessageId: `task-open:${task.id}:${report?.callId ?? String(latest.extra.taskContinuationId ?? 'initial')}`, recipientIds: [task.companionId], kind: 'task_progress',
      content: `任务 ${task.id} 已暂停，保留当前结果。${detail}\n${result.text.slice(0, 12000)}`,
      correlationId: source.correlationId, causationId: source.id, payload: { taskId: task.id, reportState: report?.state ?? 'missing', hop: derivedCause(source).hop } });
    this.scheduler.wake(); this.changed(task.conversationId);
  }
  private markTaskPaused(task: BotTask): void {
    const current = this.store.getTask(task.id); if (!current || current.extra.cancelRequested || ['succeeded', 'failed', 'cancelled'].includes(current.status)) return;
    const now = new Date().toISOString();
    this.store.updateTask(task.id, { status: 'paused', error: '', extra: { ...current.extra, pauseRequested: false, userPaused: current.extra.pauseOrigin !== 'router', pauseRecoveryPaused: false,
      pausedAt: current.extra.pausedAt ?? now, retryAt: 0, progress: { phase: 'paused', detail: '已暂停；继续会使用原任务、会话和工作目录。', updatedAt: now } } });
    this.changed(task.conversationId);
  }
  private pauseForExecutor(task: BotTask, reason: string, detail: string, error = ''): void {
    const current = this.store.getTask(task.id); if (!current || ['paused', 'succeeded', 'failed', 'cancelled'].includes(current.status)) return;
    const now = new Date().toISOString(), interruptionCount = Number(current.extra.executorInterruptionCount ?? 0) + 1;
    this.store.updateTask(task.id, { status: 'paused', error, extra: { ...current.extra,
      pauseOrigin: 'router', userPaused: false, executorPaused: true, pauseRequested: false, pauseRecoveryPaused: false,
      pausedAt: now, pauseRequestedAt: now, retryAt: 0, hostResumeRequested: false,
      ...(reason === 'interrupted' && current.extra.nativeAttempted === true ? {
        executorControl: { kind: 'pause', requestedAt: now, state: 'pending', attempts: 0, retryAt: 0, workspaceLayout: current.extra.workspaceLayout },
      } : {}),
      executorInterruptionCount: interruptionCount, executorInterruption: { reason, at: now }, progress: { phase: 'paused', detail, updatedAt: now } } });
    const source = this.store.getEvent(current.sourceEventId);
    if (source) this.store.enqueueTaskNotice({ conversationId: current.conversationId, senderId: 'task-service', senderName: '任务回执', source: 'task',
      sourceMessageId: `task-executor-paused:${current.id}:${interruptionCount}`, recipientIds: [current.companionId], kind: 'task_progress',
      content: `任务 ${current.id} 因执行环境问题已暂停。${detail}${error ? `\n执行环境提示：${error.slice(0, 1000)}` : ''}\n不会自动重新派发；修复执行环境并明确继续后沿原任务恢复。请如实传达状态，不要求重复授权，也不在本轮自动重试。`,
      correlationId: source.correlationId, causationId: source.id, payload: { taskId: current.id, hop: derivedCause(source).hop } });
    this.scheduler.wake(); this.changed(task.conversationId);
  }
  private finishTask(task: BotTask, status: 'succeeded' | 'failed' | 'cancelled', text = '', error?: string, sessionId?: string): void {
    const source = this.store.getEvent(task.sourceEventId); if (!source) throw new Error('任务来源事件不存在。');
    const patch = { status, summary: text, error: error ?? '', sessionId };
    if (this.store.isRetiredDevelopmentDefault(task.companionId)) { this.store.updateTask(task.id, { ...patch, status: 'cancelled', summary: '' }); return; }
    if (this.store.taskSourcesWithdrawn(task.id)) { this.store.updateTask(task.id, { status: 'cancelled', summary: '', error: '' }); return; }
    if (status === 'cancelled' && typeof task.extra.batchCancelKey === 'string') {
      this.store.updateTask(task.id, patch); this.publishQueueBatches(); return;
    }
    this.store.finishTask(task.id, patch,
      { conversationId: task.conversationId, senderId: 'task-service', senderName: '任务回执', source: 'task',
      sourceMessageId: `task-result:${task.id}:${task.attemptId}${typeof task.extra.taskContinuationId === 'string' ? ':' + digest(task.extra.taskContinuationId).slice(0, 24) : ''}`, recipientIds: [task.companionId], kind: 'task_done',
      content: `任务 ${task.id} 状态：${status}\n${text.slice(0, 16000)}${text.length > 16000 ? '\n[执行结果尚有后文，完整原文已保存在任务中；用dsh_task_result_read分页读取，不把摘录当作全部交付。]' : ''}${error ? `\n失败原因：${error.slice(0, 2000)}` : ''}${this.store.publicationsForTask(task.id).length ? '\n已实际发送的媒体回执：' + JSON.stringify(this.store.publicationsForTask(task.id)) : ''}`, correlationId: source.correlationId, causationId: source.id,
      payload: { taskId: task.id, attemptId: task.attemptId, ...(typeof task.extra.workflowId === 'string' ? { planId: task.extra.workflowId } : {}), hop: derivedCause(source).hop } });
    this.scheduler.wake();
  }
  private suppressStoppedTaskNotices(taskId: string, controllingEventId?: string): void {
    const notices = this.store.taskTransaction(sql => sql.prepare(`SELECT id FROM bot_inbox WHERE source='task'
      AND status IN ('queued','running') AND json_extract(payload_json,'$.taskId')=?`).all(taskId) as Array<{ id: string }>);
    for (const notice of notices) if (notice.id !== controllingEventId) {
      this.store.cancelEvent(notice.id, true); this.scheduler.cancel(notice.id);
    }
  }
  private async controlTask(task: BotTask, operation: 'status' | 'send' | 'cancel' | 'answer' | 'resume' | 'continue' | 'pause' | 'resume_paused' | 'remove', text?: string, messageId: string = randomUUID(), input: Omit<BotTaskControlInput, 'requestId' | 'text'> = { caller: 'brain' }): Promise<unknown> {
    if (!['status', 'cancel', 'pause', 'remove'].includes(operation) && this.store.getCompanion(task.companionId)?.enabled === false) throw new Error('伙伴已关闭，请先启用后再继续任务。');
    if (!['status', 'cancel', 'pause', 'remove'].includes(operation)) await this.ensureCompanionBindings([task.companionId]);
    const request = input.sourceEventId ? this.store.getEvent(input.sourceEventId) : undefined;
    const userControl = input.caller === 'user' || input.source === 'user' || !!request && request.senderType === 'companion'
      && request.companionId === task.companionId && request.conversationId === task.conversationId
      && isBotParticipantRequest(request, this.store.getConversation(request.conversationId)!) && !!this.companionRuntime.workAuthority(request);
    let routerControl = false;
    if (!userControl && input.caller === 'brain' && input.sourceEventId && ['cancel', 'pause', 'resume_paused', 'remove', 'continue'].includes(operation)) {
      const event = this.store.getEvent(input.sourceEventId);
      if (event && event.source === input.source && event.companionId === task.companionId && event.conversationId === task.conversationId && !this.store.taskSourcesWithdrawn(task.id)) {
        this.assertCurrentEvent(event);
        this.companionRuntime.taskInView(event, task.id, operation === 'remove' || operation === 'cancel' ? { stopping: 'status' } : {});
        routerControl = true;
      }
    }
    if (operation === 'cancel' && !userControl && !routerControl) throw new Error('主脑只能管理当前聊天中自己的有效任务。');
    if (task.extra.delegationProxy === true && typeof task.extra.externalDelegationId === 'string') {
      if(operation==='resume_paused'&&!userControl&&task.extra.executorPaused===true)throw new Error('执行环境暂停需先修复环境，再由用户或伙伴明确继续；后台回执不会自动重试。');
      if(operation==='resume_paused'&&!userControl&&(task.extra.delegationUserPaused===true||task.extra.userPaused===true&&task.extra.delegationMirroredPause!==true))throw new Error('用户暂停的协作只能由用户或伙伴的明确继续请求恢复。');
      const ticket=this.delegations.get(task.extra.externalDelegationId);if(!ticket)throw new Error('委派缺少持久记录。');
      return this.controlDelegation(ticket,operation,text,messageId,input);
    }
    if (!['cancel', 'remove'].includes(operation) && this.store.taskSourcesWithdrawn(task.id)) throw new Error('任务输入的授权来源已撤回，不能继续使用其摘要或文件。');
    if (operation === 'remove') {
      if (!userControl && !routerControl) throw new Error('主脑只能清理当前聊天中自己的任务记录。');
      const current = this.store.getTask(task.id)!;
      if (!['succeeded', 'failed', 'cancelled'].includes(current.status))
        await this.controlTask(current, 'cancel', undefined, `${messageId}:cancel`, input);
      const result = await clearBotTaskHistory(this.store, { conversationId: task.conversationId, taskId: task.id, requestId: messageId, companionId: input.caller === 'brain' ? task.companionId : undefined });
      this.suppressStoppedTaskNotices(task.id, input.sourceEventId);
      this.changed(task.conversationId); return result;
    }
    if (task.extra.removedAt) throw new Error('任务记录已移除。');
    if (operation === 'status') {
      const event = input.sourceEventId ? this.store.getEvent(input.sourceEventId) : undefined;
      const attention = event?.source === 'task' && event.payload.taskId === task.id && typeof event.payload.attention === 'string'
        && event.payload.attention.startsWith('question:') ? event.payload.attention.slice(9) : undefined;
      return input.caller === 'brain' ? this.taskRuntime.routerStatus(task, attention) : this.taskRuntime.card(task);
    }
    if (operation === 'answer' || operation === 'send') {
      await this.upgradeTaskAccess(task); task = this.store.getTask(task.id)!;
      // An access/Host wait yields to membership changes and withdrawal. A
      // pre-await view check cannot authorize the later guidance delivery.
      this.companionRuntime.validateTask(task);
    }
    if (operation === 'pause' || operation === 'resume_paused') {
      if (!userControl && !routerControl) throw new Error('主脑只能管理当前聊天中自己的有效任务。');
      const key = `task-${operation}:${task.id}:${messageId}`, saved = this.store.getMetadata(key);
      if (saved) return { taskId: task.id, accepted: true, status: this.store.getTask(task.id)!.status, meaning: '该控制请求已经保存，未重复执行。' };
      const current = this.store.getTask(task.id)!;
      if (['succeeded', 'failed', 'cancelled'].includes(current.status)) return { taskId: task.id, status: current.status, accepted: false, meaning: '任务已经结束，保留真实结果。' };
      if (current.extra.cancelRequested) throw new Error('任务正在停止，不能改为暂停或继续。');
      if (operation === 'resume_paused') {
        if (current.status !== 'paused') throw new Error('只有已暂停的任务可以继续。');
        if(!userControl&&current.extra.executorPaused===true)throw new Error('执行环境暂停需先修复环境，再由用户或伙伴明确继续；后台回执不会自动重试。');
        if (!userControl && (current.extra.pauseOrigin !== 'router' || current.extra.userPaused === true || current.extra.humanStopped === true)) throw new Error('用户暂停的任务只能由用户明确恢复。');
        this.store.taskTransaction(() => {
          const control = current.extra.executorControl as ExecutorControl | undefined;
          const pending=Array.isArray(current.extra.pendingControls)?current.extra.pendingControls as Array<{id:string;text:string}>:[];
          const resumed={id:`resume-${digest(messageId)}`,text:'宿主最新控制事件：用户已在此前补充信息之后明确要求继续原任务。保留此前补充的业务事实；其中“保持暂停、等待明确继续”等旧控制条件已经被本次恢复替代。只继续原授权范围内尚未完成的工作，不重复已执行操作；重新核验真实成果后报告。'};
          const combined=[...pending.map(entry=>entry.text),resumed.text].join('\n\n');
          const pendingControls=current.extra.nativeAttempted!==true&&!pending.length?[]:combined.length<=16000?[{id:resumed.id,text:combined}]:[...pending,resumed];
          this.store.updateTask(task.id, { status: 'queued', extra: { ...current.extra, userPaused: false, pauseRequested: false, pauseRecoveryPaused: false, pauseRecoveryAttempts: 0, retryAt: 0,
            pendingControls,
            pauseRequestedAt: undefined, pausedAt: undefined, retryAttempts: 0, executorInterruption: undefined, executorPaused: false,
            hostResumeRequested: userControl,
            ...(control && control.state !== 'acknowledged' ? { executorControl: { ...control, state: 'pending', attempts: 0, retryAt: 0 } } : {}),
            ...(Number.isSafeInteger(current.extra.outputCheckpoint) ? { continueAfterSeq: current.extra.outputCheckpoint, outputCheckpoint: undefined } : {}),
            progress: { phase: 'queued', detail: '已保存继续请求，沿原任务和会话继续。', updatedAt: new Date().toISOString() } } });
          this.store.setMetadata(key, JSON.stringify({ acceptedAt: new Date().toISOString() }));
        });
      } else {
        if (current.status === 'paused') {
          if (userControl && current.extra.pauseOrigin === 'router') {
            this.store.updateTask(task.id, { extra: { ...current.extra, pauseOrigin: 'user', userPaused: true, executorPaused: false } });
            this.changed(task.conversationId);
          }
          return { taskId: task.id, status: 'paused', accepted: true, meaning: '任务已经暂停。' };
        }
        this.store.taskTransaction(() => {
          const now = new Date().toISOString();
          this.store.updateTask(task.id, { extra: { ...current.extra, pauseRequested: true, pauseRequestedAt: now, pauseOrigin: userControl ? 'user' : 'router',
            executorPaused: false,
            executorControl: { kind: 'pause', requestedAt: now, state: current.extra.nativeAttempted === true ? 'pending' : 'acknowledged', attempts: 0, retryAt: 0, workspaceLayout: current.extra.workspaceLayout },
            pauseRecoveryAttempts: 0, pauseRecoveryPaused: false, retryAt: 0 } });
          this.store.setMetadata(key, JSON.stringify({ acceptedAt: new Date().toISOString() }));
        });
        this.taskRuns.get(task.id)?.controller.abort(Object.assign(new Error('用户请求暂停任务。'), { code: 'BOT_SUSPEND' }));
        this.toolServer.releaseWorker(`worker-${task.id}`);
        void this.flushExecutorControl(task.id);
      }
      this.maintainSafely(); this.changed(task.conversationId);
      const result = this.store.getTask(task.id)!;
      return { taskId: task.id, accepted: true, status: result.status, paused: result.status === 'paused',
        meaning: operation === 'resume_paused' ? '继续请求已保存，沿原任务和会话继续。' : '已暂停。' };
    }
    if (operation === 'continue') {
      if (!userControl && !routerControl) throw new Error('主脑只能继续当前聊天中自己的任务检查点。');
      const receiptKey = `task-continue:${task.id}:${messageId}`;
      if (this.store.getMetadata(receiptKey)) return { taskId: task.id, accepted: true, meaning: '继续请求已保存，沿用原任务。' };
      const current = this.store.getTask(task.id)!;
      if (current.status !== 'waiting' || !Number.isSafeInteger(current.extra.outputCheckpoint) || current.extra.cancelRequested) throw new Error('该任务当前没有可继续的输出检查点。');
      this.store.taskTransaction(() => {
        this.store.updateTask(task.id, { status: 'queued', error: '', extra: { ...current.extra, continueAfterSeq: current.extra.outputCheckpoint, outputCheckpoint: undefined, retryAt: 0 } });
        this.store.setMetadata(receiptKey, JSON.stringify({ checkpoint: current.extra.outputCheckpoint }));
      });
      this.maintainSafely(); this.changed(task.conversationId); return { taskId: task.id, accepted: true, meaning: '沿用原任务和工作区，从已保存的进展继续。' };
    }
    if (operation === 'answer' || operation === 'resume') {
      const control = { ...input, requestId: messageId, text };
      const result = operation === 'answer' ? this.taskRuntime.answer(task, control, this.taskRuns.has(task.id)) : this.taskRuntime.resume(task, control);
      this.changed(task.conversationId); this.maintainSafely(); return result;
    }
    if (operation === 'send') {
      const content = z.string().trim().min(1).max(16000).parse(text), key = `task-control:${task.id}:${messageId}`, fingerprint = digest(content), saved = this.store.getMetadata(key);
      if (saved && JSON.parse(saved).fingerprint !== fingerprint) throw new Error('指导标识已用于其他内容。');
      if (saved) return { taskId: task.id, accepted: true, meaning: '指导请求已持久保存，等待执行器接收。' };
      const current = this.store.getTask(task.id)!;
      const controls = Array.isArray(current.extra.pendingControls) ? current.extra.pendingControls as Array<{ id: string; text: string }> : [];
      const pending = controls.find(entry => entry.id === messageId);
      if (pending) {
        if (pending.text !== content) throw new Error('指导标识已用于其他内容。');
        this.store.setMetadata(key, JSON.stringify({ fingerprint, state: 'pending' }));
        return { taskId: task.id, accepted: true, meaning: '指导请求已持久保存，等待执行器接收。' };
      }
      const reopening = ['succeeded', 'failed'].includes(current.status);
      if ((!['queued', 'running', 'waiting', 'paused'].includes(current.status) && !reopening) || current.extra.cancelRequested || current.extra.humanStopped) throw new Error('任务已停止或待核实，无法追加指导。');
      const coordinationEvent = input.sourceEventId ? this.store.getEvent(input.sourceEventId) : undefined;
      const workflowRework = reopening && !userControl && coordinationEvent && this.workflows.canCoordinate(coordinationEvent, current);
      if (reopening && !userControl && !workflowRework) throw new Error('已结束任务需要用户明确跟进，自动事件不能重新唤醒。');
      if (controls.length >= 32) throw new Error('任务待投递指导已满，请等待执行器接收。');
      if (reopening) {
        this.companionRuntime.validateTask(current);
        this.store.taskTransaction(() => {
          if (workflowRework) this.workflows.rework(coordinationEvent, current, messageId);
          this.store.reopenTask(task.id, { id: messageId, text: content });
          this.store.setMetadata(key, JSON.stringify({ fingerprint, state: 'continuation' }));
        });
        this.maintainSafely(); this.changed(task.conversationId);
        return { taskId: task.id, accepted: true, meaning: '后续指导已保存，沿原任务、原授权和会话继续；不会重发原始执行。' };
      }
      if (current.status === 'waiting' && current.extra.turnOutcome) {
        // The previous native segment has a terminal receipt. Reopen it with
        // a new guidance receipt, never by replaying the original work input.
        this.store.updateTask(task.id, { status: 'queued', extra: { ...current.extra,
          taskContinuation: { id: messageId, text: content }, taskContinuationId: messageId,
          reportBaseline: (current.extra.workerReport as { callId?: string } | undefined)?.callId ?? null,
          retryAt: 0, progress: { phase: 'queued', detail: '后续指导已保存，沿原任务继续。', updatedAt: new Date().toISOString() } } });
        this.store.setMetadata(key, JSON.stringify({ fingerprint, state: 'continuation' }));
        this.maintainSafely(); this.changed(task.conversationId);
        return { taskId: task.id, accepted: true, meaning: '后续指导已保存，沿原任务和会话继续；未重复原始执行。' };
      }
      // The task row owns pending delivery; the native input receipt deduplicates retries after a crash.
      this.store.updateTask(task.id, { extra: { ...current.extra, pendingControls: [...controls, { id: messageId, text: content }],
        reportBaseline: (current.extra.workerReport as { callId?: string } | undefined)?.callId ?? current.extra.reportBaseline ?? null } });
      this.store.setMetadata(key, JSON.stringify({ fingerprint, state: 'pending' }));
      void this.flushTaskControls(task.id);
      return { taskId: task.id, accepted: true, meaning: '指导请求已持久保存，等待执行器接收；任务尚未完成。' };
    }
    const current = this.store.getTask(task.id)!;
    if (['succeeded', 'failed'].includes(current.status)) {
      this.store.taskTransaction(() => {
        this.companionRuntime.withdraw(task.id);
        this.store.updateTask(task.id, { extra: { ...current.extra, humanStopped: true, humanStoppedAt: new Date().toISOString() } });
        this.store.setMetadata(`task-cancel:${task.id}:${messageId}`, JSON.stringify({ acceptedAt: new Date().toISOString(), humanStopped: true }));
      });
      this.suppressStoppedTaskNotices(task.id, input.sourceEventId);
      this.changed(task.conversationId);
      return { taskId: task.id, status: current.status, humanStopped: true, followupAvailable: false, confirmed: true,
        meaning: '已撤回此任务的后续自动接续授权，保留此前真实完成或失败结果。' };
    }
    if (!['succeeded', 'failed', 'cancelled'].includes(current.status)) {
      const receiptKey = `task-cancel:${task.id}:${messageId}`;
      if (this.store.getMetadata(receiptKey)) return { taskId: task.id, cancelRequested: true, status: current.status, confirmed: current.status === 'cancelled', meaning: '已停止。' };
      this.store.taskTransaction(() => {
        const now = new Date().toISOString();
        this.store.updateTask(task.id, { extra: { ...current.extra, cancelRequested: true, cancelRequestedAt: current.extra.cancelRequestedAt ?? now,
          executorControl: { kind: 'cancel', requestedAt: now, state: current.extra.nativeAttempted === true ? 'pending' : 'acknowledged', attempts: 0, retryAt: 0, workspaceLayout: current.extra.workspaceLayout },
          cancelRecoveryAttempts: 0, cancelRecoveryPaused: false, pauseRequested: false, pauseRecoveryPaused: false, retryAt: 0 } });
        this.companionRuntime.withdraw(task.id);
        this.store.setMetadata(receiptKey, JSON.stringify({ acceptedAt: new Date().toISOString() }));
      });
      this.taskRuns.get(task.id)?.controller.abort(new Error('用户停止任务。'));
      this.toolServer.releaseWorker(`worker-${task.id}`);
      void this.flushExecutorControl(task.id);
      this.finishTask(this.store.getTask(task.id)!, 'cancelled', current.summary ?? '');
      this.suppressStoppedTaskNotices(task.id, input.sourceEventId);
      this.maintainSafely(); this.changed(task.conversationId);
    }
    const result = this.store.getTask(task.id)!;
    return { taskId: task.id, cancelRequested: result.extra.cancelRequested === true, status: result.status, confirmed: result.status === 'cancelled',
      meaning: result.status === 'cancelled' ? '已停止。' : '任务此前已经结束，保留真实执行结果。' };
  }
  private async controlQueue(conversationId: string, operation: 'cancel_queued' | 'cancel_all' | 'clear_finished', requestId: string, companionId?: string, controllingEventId?: string): Promise<unknown> {
    if (operation === 'cancel_all') this.workflows.cancelScope(conversationId, companionId);
    if (!this.store.getConversation(conversationId)) throw new Error('聊天不存在。');
    if (operation === 'clear_finished') { const result = await clearBotTaskHistory(this.store, { conversationId, requestId, companionId }); this.changed(conversationId); return result; }
    const key = `task-queue-control:${conversationId}:${requestId}`, fingerprint = digest(JSON.stringify({ operation, companionId }));
    const saved = this.store.getMetadata(key);
    const receipt = saved ? JSON.parse(saved) as { fingerprint: string; ids: string[] } : this.store.taskTransaction(sql => {
      const ids = sql.prepare(`SELECT id FROM bot_tasks WHERE conversation_id=? AND status ${operation === 'cancel_queued' ? "='queued'" : "IN ('queued','running','waiting','paused','unknown')"}${companionId ? ' AND companion_id=?' : ''}`)
        .all(conversationId, ...(companionId ? [companionId] : [])).map(value => String((value as { id: string }).id));
      const receipt = { fingerprint, ids, conversationId, published: ids.length ? false : true };
      this.store.setMetadata(key, JSON.stringify(receipt));
      for (const id of ids) {
        const task = this.store.getTask(id)!;
        this.store.updateTask(id, { extra: { ...task.extra, batchCancelKey: key } });
      }
      return receipt;
    });
    if (receipt.fingerprint !== fingerprint) throw new Error('同一队列操作标识对应不同请求。');
    for (const id of receipt.ids) {
      const task = this.store.getTask(id); if (task) await this.controlTask(task, 'cancel', undefined, `${requestId}:${id}`, { caller: 'user', sourceEventId: controllingEventId });
    }
    this.publishQueueBatches();
    const items = receipt.ids.map(id => this.store.getTask(id)).filter((task): task is BotTask => !!task).map(task => ({ taskId: task.id, status: task.status,
      cancellation: task.status === 'cancelled' ? 'confirmed' : ['succeeded', 'failed'].includes(task.status) ? 'already-finished' : task.extra.cancelRecoveryPaused ? 'unconfirmed' : 'pending' }));
    const count = (state: string) => items.filter(item => item.cancellation === state).length;
    const counts = { cancelled: count('confirmed'), finished: count('already-finished'), pending: count('pending'), blocked: count('unconfirmed') };
    return { accepted: true, affected: receipt.ids.length, ...counts, items,
      meaning: `已停止 ${counts.cancelled} 项，原已结束 ${counts.finished} 项。` };
  }
  private publishQueueBatches(): void {
    const pending = this.store.taskTransaction(sql => sql.prepare("SELECT key,value FROM bot_metadata WHERE key LIKE 'task-queue-control:%' AND json_extract(value,'$.published')=0 LIMIT 20").all() as Array<{ key: string; value: string }>);
    for (const item of pending) {
      const batch = JSON.parse(item.value) as { ids: string[]; conversationId: string; published: boolean };
      if (!batch.ids.length) continue;
      this.store.taskTransaction(sql => {
        const tasks = sql.prepare(`SELECT id,source_event_id,companion_id,status,COALESCE(json_extract(extra_json,'$.cancelRecoveryPaused'),0) AS stop_blocked FROM bot_tasks WHERE id IN (${batch.ids.map(() => '?').join(',')})`).all(...batch.ids) as Array<{ id: string; source_event_id: string; companion_id: string; status: string; stop_blocked: number }>;
        if (tasks.some(task => !['succeeded', 'failed', 'cancelled'].includes(task.status) && !task.stop_blocked)) return;
        const noticeState = digest(JSON.stringify(tasks.map(task => [task.id, task.status, task.stop_blocked]))), previous = JSON.parse(item.value) as { lastNoticeState?: string };
        if (previous.lastNoticeState === noticeState) return;
        const blocked = tasks.filter(task => !['succeeded', 'failed', 'cancelled'].includes(task.status)).length;
        const first = tasks[0], source = first && this.store.getEvent(first.source_event_id);
        if (first && source && !this.store.taskSourcesWithdrawn(first.id)) this.store.enqueueTaskNotice({ conversationId: batch.conversationId,
          senderId: 'task-service', senderName: '任务状态', source: 'task', sourceMessageId: `task-batch-result:${digest(item.key)}:${noticeState}`,
          recipientIds: [first.companion_id], kind: 'task_progress', content: `本次队列处理${blocked ? '仍需核实' : '已结束'}：已停止 ${tasks.filter(task => task.status === 'cancelled').length} 项；已完成 ${tasks.filter(task => task.status === 'succeeded').length} 项；执行失败 ${tasks.filter(task => task.status === 'failed').length} 项；停止未确认 ${blocked} 项。${blocked ? '未确认项仍保留，请重新核实，不能视为队列已清空。' : ''}已执行的操作不会因停止而撤销。`,
          correlationId: source.correlationId, causationId: source.id, payload: { batchId: digest(item.key), taskId: first.id, hop: 1 } });
        this.store.setMetadata(item.key, JSON.stringify({ ...batch, ...JSON.parse(item.value), lastNoticeState: noticeState, published: blocked === 0 }));
      });
    }
    if (pending.length) this.scheduler.wake();
  }
  private async flushTaskControls(taskId: string): Promise<void> {
    if (this.closed) return;
    const running = this.taskControlRuns.get(taskId); if (running) return running;
    const operation = (async () => {
      while (!this.closed) {
        const task = this.store.getTask(taskId); if (!task || task.status !== 'running' || task.extra.cancelRequested) return;
        const controls = task.extra.pendingControls as Array<{ id: string; text: string }> | undefined, intent = controls?.[0]; if (!intent) return;
        try { await this.options.brain.send(`worker-${taskId}`, { messageId: intent.id, text: intent.text, mode: 'steer' }); }
        catch { return; } // A detached/recovering native task keeps the durable intent for maintenance.
        if (this.closed) return;
        const latest = this.store.getTask(taskId)!;
        this.store.updateTask(taskId, { extra: { ...latest.extra, pendingControls: (latest.extra.pendingControls as Array<{ id: string; text: string }> ?? []).filter(entry => entry.id !== intent.id),
          reportBaseline: (latest.extra.workerReport as { callId?: string } | undefined)?.callId ?? latest.extra.reportBaseline ?? null } });
        this.store.setMetadata(`task-control:${taskId}:${intent.id}`, JSON.stringify({ fingerprint: digest(intent.text), state: 'sent' }));
      }
    })();
    this.taskControlRuns.set(taskId, operation); try { await operation; } finally { this.taskControlRuns.delete(taskId); }
  }
  private maintainSafely(): void { void this.maintain().catch(error => this.options.report?.(error)); }
  private cleanDevelopmentDefault(): void {
    if (this.developmentCleanupRun || this.closed || Date.now() < this.developmentCleanupRetryAt) return;
    const plan = this.store.commitDevelopmentDefaultCleanup(); if (plan?.phase !== 'sql-deleted') return;
    this.developmentCleanupRun = (async () => {
      await eraseDevelopmentWorkspaces(this.options.root, plan);
      await this.options.memory.eraseDevelopmentCompanionData('default-companion', plan.scopes);
      this.store.completeDevelopmentDefaultCleanup(); this.changed();
    })().catch(error => { this.developmentCleanupRetryAt = Date.now() + 30000; this.options.report?.(error); })
      .finally(() => { this.developmentCleanupRun = undefined; });
  }
  private async maintain(): Promise<void> {
    if (this.closed) return;
    this.refreshDelegations();
    this.reconcileFinishedTasks();
    this.publishQueueBatches();
    const cleanup = this.store.taskTransaction(sql => sql.prepare(`SELECT id FROM bot_tasks WHERE json_extract(extra_json,'$.executorControl.state')='pending'
      AND COALESCE(json_extract(extra_json,'$.executorControl.retryAt'),0)<=? ORDER BY updated_at,id LIMIT 8`).all(Date.now()) as Array<{ id: string }>);
    for (const task of cleanup) if (this.executorControlRuns.size < 4 && this.store.getCompanion(this.store.getTask(task.id)?.companionId ?? '')?.enabled !== false) void this.flushExecutorControl(task.id);
    this.memoryMaintenance.poll();
    for (const laneId of this.store.readyNativeRetirementLanes()) {
      if (this.store.getCompanion(this.store.getLane(laneId)?.companionId ?? '')?.enabled === false) continue;
      if (this.retirementRuns.size >= 2) break;
      if (this.retirementRuns.has(laneId)) continue;
      const operation = this.retention.reconcileCancelled(laneId, this.maintenanceAbort.signal).catch(error => {
        if (!this.closed && !(error && typeof error === 'object' && 'code' in error && error.code === 'BOT_DELIVERY_UNKNOWN')) this.options.report?.(error);
      }).finally(() => { this.retirementRuns.delete(laneId); });
      this.retirementRuns.set(laneId, operation);
    }
    this.world.tick(); this.deliverWorldEvents();
    const saturated = [...new Set([...this.taskRuns.values()].map(run => run.companionId))]
      .filter(id => this.runningTasks(id) >= this.store.workerConcurrency(id));
    for (const task of this.store.pendingTasks(100, { afterCompanionId: this.lastTaskCompanion, excludeCompanionIds: saturated })) this.launchTask(task);
    this.cleanDevelopmentDefault();
    for (const id of this.taskRuns.keys()) void this.flushTaskControls(id);
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
          onRemember: input => { this.store.enqueueMemoryJob({ key: `index:${input.sourceEventId}`, kind: 'mutation', payload: { scope, operation: 'remember', input } }); },
          jobId: claim.job.id, sourceEventId: String(payload.sourceEventId), cwd, callback: await this.toolServer.start(), model: this.options.model(),
          messages: payload.messages as BotMemoryMessage[], answer: String(payload.answer ?? ''), answerMessageId: typeof payload.answerMessageId === 'string' ? payload.answerMessageId : undefined,
          policyVersion: payload.policyVersion === 2 ? 2 : undefined,
          contextEpoch: sourceEvent ? this.store.getEventNativeEpoch(sourceEvent.id) : undefined, signal: this.maintenanceAbort.signal });
        resultMetadata = [{ key: `memory-capture-result:${claim.job.id}`, value: JSON.stringify({ policyVersion: payload.policyVersion === 2 ? 2 : 1, notes: result.notes, completedAt: new Date().toISOString() }) }];
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
  async shutdown(): Promise<void> {
    if (this.closed) return; this.closed = true; clearInterval(this.maintenance); clearTimeout(this.presenceExpiry);
    this.store.suspendTaskTimers();
    await this.starting.catch(() => undefined);
    this.maintenanceAbort.abort(Object.assign(new Error('应用关闭，记忆作业保留待恢复。'), { code: 'BOT_SUSPEND' }));
    await this.memoryMaintenance.close();
    await this.scheduler.close();
    await Promise.allSettled([...this.companionControls.values()]);
    await this.restoringCompanions;
    for (const active of this.taskRuns.values()) active.controller.abort(Object.assign(new Error('应用关闭，原任务保留待恢复。'), { code: 'BOT_SUSPEND' }));
    await Promise.allSettled([...this.taskRuns.values()].map(item => item.promise));
    let preparationTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.taskPreparations.values()]), new Promise<void>(resolve => { preparationTimer = setTimeout(resolve, 5000); })]);
    if (preparationTimer) clearTimeout(preparationTimer);
    await Promise.allSettled([...this.taskControlRuns.values()]);
    await Promise.allSettled([...this.executorControlRuns.values()]);
    await Promise.allSettled([...this.taskAccessUpgrades.values()]);
    await Promise.allSettled([...this.retirementRuns.values()]);
    await Promise.allSettled([...this.sourceWithdrawalRuns.values()]);
    await this.developmentCleanupRun;
    await this.historyClearRun;
    await Promise.allSettled([...this.groupAttentionRuns.values()]);
    await this.toolServer.close();
    const outcomes = await Promise.allSettled([this.options.brain.close(), this.options.memory.close(), this.memoryRun]);
    this.store.close();
    const errors = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason as unknown] : []);
    if (errors.length) throw new AggregateError(errors, '伙伴资源关闭时存在错误，耐久记录已保留。');
  }
}
