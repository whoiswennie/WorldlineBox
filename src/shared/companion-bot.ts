import { z } from 'zod';
import type { BrowserPageContext } from './browser-page-context';
import type {BotTopicContext} from './companion-native-context';
import { botWorldCommandSchema, type BotWorldSnapshot } from './companion-bot-world';
import type { BotTaskAttention, BotTaskPendingEffect } from './companion-bot-task';
import type { BotMediaRef } from './companion-bot-media';
import { botMemoryMaintenanceSchemas } from './companion-bot-maintenance';
import type { BotBrainContextSummary } from './companion-bot-context';
import type { BotChatRuntime, BotNativeTopic } from './companion-bot-topics';
export type { BotBrainContextSummary, BotBrainRequestMetrics } from './companion-bot-context';

export const BOT_CHANNEL = 'companion-bot:request';
export const BOT_EVENT_CHANNEL = 'companion-bot:event';
const id = z.string().min(1).max(160);
export const BOT_WORKER_CONCURRENCY_DEFAULT = 5;
export const BOT_WORKER_CONCURRENCY_MIN = 1;
export const BOT_WORKER_CONCURRENCY_MAX = 32;
export const botWorkerConcurrencySchema = z.number().int().min(BOT_WORKER_CONCURRENCY_MIN).max(BOT_WORKER_CONCURRENCY_MAX);
export interface BotCompanion { id: string; name: string; persona: string; createdAt: string; activePersonaId?: string; enabled?: boolean; workerConcurrency?: number }
export const BOT_PERSONA_TEMPLATE_LIMIT = 64;
export interface BotPersonaTemplateSummary {
  id: string; name: string; builtin: boolean; isDefault: boolean; modified: boolean; charCount: number; updatedAt: string;
}
export interface BotPersonaTemplate extends BotPersonaTemplateSummary { prompt: string }
export interface BotPersonaTemplateList { items: BotPersonaTemplateSummary[]; activeId: string; limit: number }
export type BotParticipationMode = 'automatic' | 'all' | 'mentions';
export type BotHistoryFilter = 'all' | 'media' | 'stickers' | 'files' | 'links';
export interface BotReplyTiming { elapsedMs: number; queueMs?: number; prepareMs?: number; firstTextMs?: number; modelMs?: number; finishMs?: number }
export interface BotReplyProgress {
  phase: 'queued' | 'memory-starting' | 'memory-verifying' | 'memory-indexing' | 'recalling-memory' | 'preparing-context' | 'compacting-context' | 'waiting-runtime' | 'waiting-model' | 'using-tool' | 'generating' | 'retrying' | 'reconciling';
  toolName?: string; detail?: string;
}
export interface BotGroupAnnouncement { text: string; updatedAt: string }
export interface BotTaskFollowupReceipt {
  taskId: string; title?: string;
  state: 'queued' | 'delivered' | 'needs-attention' | 'failed' | 'cancelled';
}
export interface BotConversation { id: string; title: string; kind: 'direct' | 'group' | 'world' | 'peer'; memberIds: string[]; createdAt: string; participationMode?: BotParticipationMode; peerConversation?: boolean; userRole?: 'observer'; ownerId?:'user';dissolvedAt?:string; announcement?: BotGroupAnnouncement }
/** Native DSH execution events belong to one reply in its selected topic Session. */
export interface BotExecution {
  sessionId?: string;
  phase?: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  question?: { id: string; text: string };
  continuation?: { checkpoint: number };
  /** Explicit user interruption; only a durable native stop makes it resumable. */
  interruption?: { state: 'stopping' | 'ready' };
  steps: BotExecutionStep[];
}
export interface BotExecutionStep {
  id: string; type: string; summary?: string; text?: string; output?: string; toolName?: string; status?: string; at: string;
  stage?: string; sequence?: number; streamId?: string; callId?: string; nativeSessionId?: string; nativeTurn?: number; nativeStep?: number;
  textMode?: 'delta' | 'snapshot'; outputState?: 'draft' | 'committed' | 'abandoned';
  streamGeneration?: string; updatedAt?: string;
}
export interface BotMessage {
  browserContext?: BrowserPageContext;
  id: string; eventId: string; conversationId: string; senderId: string; senderName: string;
  content: string; sequence: number; status: 'queued' | 'running' | 'sent' | 'failed' | 'cancelled'; createdAt: string; error?: string;
  attachments?: BotMediaRef[];
  timing?: BotReplyTiming;
  progress?: BotReplyProgress;
  execution?: BotExecution;
  topic?: { id:string;title:string };
  parts?:BotReplyPart[];
  taskFollowup?: BotTaskFollowupReceipt;
  taskNotice?: { taskId: string; kind: 'task_done' | 'task_progress'; replyMessageId?: string; companionId?: string; companionName?: string; title?: string; status?: string };
}
export interface BotReplyPart { id:string;kind:'text'|'media';sequence:number;text?:string;attachments?:BotMediaRef[];publicationId?:string }
export interface BotNativeReplyOutput {id:string;sequence:number;text?:string;files?:Array<{path:string;description?:string}>}
export interface BotTaskProgress { phase: string; detail?: string; updatedAt?: string; toolName?: string }
export interface BotTask { id: string; conversationId: string; companionId: string; companionName?: string; goal: string; status: string; summary?: string; summaryIsPreview?: boolean; error?: string;
  title?: string; createdAt?: string; startedAt?: string; updatedAt?: string; sessionId?: string; progress?: BotTaskProgress; cancelRequested?: boolean; stopRequestedAt?: string; continuationAvailable?: boolean;
  pauseRequested?: boolean; pauseRequestedAt?: string; pausedAt?: string; pauseOrigin?: 'user' | 'router'; followupAvailable?: boolean; humanStopped?: boolean;
  /** Completed execution intervals; paused and stopped time never accumulates. */
  elapsedMs?: number; timerStartedAt?: string;
  /** A real, unanswered Worker question; directory cards do not carry its full body. */
  waitingForAnswer?: boolean;
  report?: { state: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'; summary: string; verification: string[]; receivedAt: string };
  executionTurn?: { status: string; receivedAt: string };
  activity?: Array<BotTaskProgress & { id: string; createdAt: string }>;
  diagnostic?: { attempts: number; stage?: string; message: string };
  attention?: BotTaskAttention; pendingEffects?: BotTaskPendingEffect[]; outputs?: BotTaskOutput[] }
export interface BotTaskPage { items: BotTask[]; total: number; page: number; limit: number; activeCount: number; queuedCount: number; finishedCount?: number }
export interface BotTaskSummary { items: BotTask[]; activeCount: number; queuedCount: number }
export interface BotTaskOutput { messageId: string; attachmentIds: string[]; relativePath?: string }
export interface BotCompanionPresenceCounts { activeTasks: number; queued: number; running: number; waiting: number; stopping: number; blocked: number; paused?: number; replying: number; pendingMessages: number }
export interface BotCompanionPresenceEvent {
  id: string; sequence: number; kind: 'task-started' | 'task-completed' | 'task-needs-attention' | 'task-failed';
  taskId: string; conversationId: string; title: string; status: string; occurredAt: string;
}
export interface BotCompanionPresence {
  status: 'needs-attention' | 'error' | 'waiting' | 'working' | 'replying' | 'idle' | 'unconfigured';
  counts: BotCompanionPresenceCounts; updatedAt: string;
  /** Recent failure color expires; a past terminal failure is not permanent presence. */
  expiresAt?: string;
  activity?: { taskId: string; conversationId: string; title: string; phase: string; updatedAt: string };
  lastEvent?: BotCompanionPresenceEvent;
  events?: BotCompanionPresenceEvent[];
}
export interface BotRuntimeStatus {
  engine: 'dsh-native'; memory: 'vcp-memory'; embedding: string; activeLanes: number;
  ready: boolean; detail?: string; dataRoot: string;
  modelContext?: { window: number; source: 'explicit' | 'metadata' | 'official-default' | 'unknown'; estimate: 'utf8-byte-upper-bound' };
}
export interface BotDataCleanup {
  id: string; companionId: string; status: 'pending' | 'running' | 'retrying' | 'completed';
  phase: 'stopping' | 'planning' | 'memory' | 'records' | 'attachments' | 'completed';
  removed: number; createdAt: string; completedAt?: string; error?: string;
}
export interface BotConversationActivity { messageId: string; sequence: number; senderName: string; preview: string; updatedAt: string }
export interface BotSnapshot {
  companions: BotCompanion[]; conversations: BotConversation[]; messages: BotMessage[]; tasks: BotTask[];
  presence?: Record<string, BotCompanionPresence>;
  conversationActivity?: Record<string, BotConversationActivity>;
  brainContexts?: Record<string, BotBrainContextSummary>;
  taskSummary?: BotTaskSummary;
  chatRuntime?: BotChatRuntime;
  hasMore: boolean; runtime: BotRuntimeStatus;
}
export interface BotHistoryPage { items: BotMessage[]; hasMore: boolean; nextBefore?: number }
export const botRequestSchema = z.discriminatedUnion('type', [
  ...botMemoryMaintenanceSchemas,
  z.strictObject({ type: z.literal('state'), conversationId: id.optional(), before: z.number().int().positive().optional() }),
  z.strictObject({ type: z.literal('history.search'), conversationId: id, query: z.string().max(200).refine(value => !value.includes('\0')).default(''), filter: z.enum(['all', 'media', 'stickers', 'files', 'links']).optional(), before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(80).optional() }),
  z.strictObject({ type: z.literal('companion.create'), name: z.string().trim().min(1).max(80), persona: z.string().max(24000), workerConcurrency: botWorkerConcurrencySchema.optional() }),
  z.strictObject({ type: z.literal('companion.update'), companionId: id, name: z.string().trim().min(1).max(80), persona: z.string().max(24000).optional(), workerConcurrency: botWorkerConcurrencySchema.optional() }),
  z.strictObject({ type: z.literal('companion.runtime'), companionId: id, operation: z.enum(['start', 'stop']) }),
  z.strictObject({ type: z.literal('companion.data.clear'), companionId: id, requestId: id }),
  z.strictObject({ type: z.literal('companion.data.clear.status'), companionId: id }),
  z.strictObject({ type: z.literal('companion.personas.list'), companionId: id }),
  z.strictObject({ type: z.literal('companion.personas.get'), companionId: id, id }),
  z.strictObject({ type: z.literal('companion.personas.save'), companionId: id, id: id.optional(), name: z.string().trim().min(1).max(80), prompt: z.string().min(1).max(24000).refine(value => !!value.trim() && !value.includes('\0')), activate: z.boolean().optional() }),
  z.strictObject({ type: z.literal('companion.personas.activate'), companionId: id, id }),
  z.strictObject({ type: z.literal('companion.personas.delete'), companionId: id, id }),
  z.strictObject({ type: z.literal('companion.personas.restore'), companionId: id, id: id.optional() }),
  z.strictObject({ type: z.literal('conversation.open'), companionId: id }),
  z.strictObject({ type: z.literal('conversation.peer.open'), memberIds: z.tuple([id, id]) }),
  z.strictObject({ type: z.literal('conversation.peer.join'), conversationId: id, title: z.string().trim().min(1).max(120).optional() }),
  z.strictObject({ type: z.literal('conversation.create'), title: z.string().trim().min(1).max(120), kind: z.enum(['group', 'world']), memberIds: z.array(id).min(1).max(16), participationMode: z.enum(['automatic', 'all', 'mentions']).optional() }),
  z.strictObject({ type: z.literal('conversation.members'), conversationId:id, memberIds:z.array(id).min(1).max(17) }),
  z.strictObject({ type: z.literal('conversation.dissolve'), conversationId:id }),
  z.strictObject({ type: z.literal('conversation.announcement'), conversationId: id, content: z.string().max(4000).refine(value => !value.includes('\0')),
    expectedUpdatedAt: z.string().datetime().nullable().optional() }),
  z.strictObject({ type: z.literal('conversation.policy'), conversationId: id, participationMode: z.enum(['automatic', 'all', 'mentions']) }),
  z.strictObject({ type: z.literal('message.send'), conversationId: id, content: z.string().trim().max(64000), requestId: id, attachmentIds: z.array(id).max(16).optional(), topicId: id.optional(), newTopic: z.boolean().optional(), delivery: z.enum(['queue','steer']).optional(), browserContextId: z.string().uuid().optional() })
    .refine(input => !!input.content || !!input.attachmentIds?.length, { message: '消息需要文字或真实附件。' }),
  z.strictObject({ type: z.literal('reply.cancel'), messageId: id }),
  z.strictObject({ type: z.literal('execution.answer'), messageId: id, questionId: id, text: z.string().trim().min(1).max(12000) }),
  z.strictObject({ type: z.literal('execution.continue'), messageId: id, requestId: id }),
  z.strictObject({ type: z.literal('topic.list'), conversationId: id, query: z.string().max(200).optional(), before: z.string().max(300).optional(),mode:z.enum(['recent','all','favorites']).optional() }),
  z.strictObject({type:z.literal('topic.flags'),conversationId:id,topicId:id,pinned:z.boolean().optional(),favorite:z.boolean().optional()}),
  z.strictObject({type:z.literal('topic.rename'),conversationId:id,topicId:id,title:z.string().trim().min(1).max(100).refine(value=>!value.includes('\0')),requestId:id}),
  z.strictObject({ type: z.literal('topic.new'), conversationId: id, requestId: id }),
  z.strictObject({ type: z.literal('topic.select'), conversationId: id, topicId: id }),
  z.strictObject({type:z.literal('topic.context'),conversationId:id,topicId:id,companionId:id}),
  z.strictObject({ type: z.literal('topic.compact'), conversationId: id, topicId: id, companionId: id, requestId: id }),
  z.strictObject({ type: z.literal('message.guide'), conversationId: id, messageId: id }),
  z.strictObject({ type: z.literal('message.dequeue'), conversationId: id, messageId: id }),




  z.strictObject({ type: z.literal('memory.search'), conversationId: id, companionId: id, query: z.string().trim().min(1).max(4000) }),
  z.strictObject({ type: z.literal('memory.remember'), conversationId: id, companionId: id, content: z.string().trim().min(1).max(24000), requestId: id.optional(), tags: z.array(z.string().trim().min(1).max(64)).max(12).optional() }),
  z.strictObject({ type: z.literal('memory.inspect'), conversationId: id, companionId: id }),
  z.strictObject({ type: z.literal('memory.list'), conversationId: id, companionId: id }),
  z.strictObject({ type: z.literal('memory.catalog'), conversationId: id, companionId: id, query: z.string().max(4000).optional(), tag: z.string().max(64).optional(), cursor: z.string().max(1000).optional(), limit: z.number().int().min(1).max(60).optional() }),
  z.strictObject({ type: z.literal('memory.note'), conversationId: id, companionId: id, id }),
  z.strictObject({ type: z.literal('memory.update'), conversationId: id, companionId: id, id, expectedChecksum: z.string().regex(/^[a-f0-9]{32}$/), content: z.string().trim().min(1).max(24000), tags: z.array(z.string().trim().min(1).max(64)).max(12).optional() }),
  z.strictObject({ type: z.literal('memory.organize'), conversationId: id, companionId: id,
    sources: z.array(z.strictObject({ id, expectedChecksum: z.string().regex(/^[a-f0-9]{32}$/) })).min(2).max(16),
    content: z.string().trim().min(1).max(24000), tags: z.array(z.string().trim().min(1).max(64)).max(12).optional() }),
  z.strictObject({ type: z.literal('memory.recall'), conversationId: id, companionId: id, query: z.string().trim().min(1).max(4000), mode: z.enum(['passive', 'semantic', 'history']) }),
  z.strictObject({ type: z.literal('memory.recall.records'), conversationId: id, companionId: id, limit: z.number().int().min(1).max(20).optional() }),
  z.strictObject({ type: z.literal('memory.forget'), conversationId: id, companionId: id, id }),
  z.strictObject({ type: z.literal('world.event'), conversationId: id, content: z.string().trim().min(1).max(16000), requestId: id }),
  z.strictObject({ type: z.literal('world.observe'), conversationId: id, companionId: id }),
  z.strictObject({ type: z.literal('world.act'), conversationId: id, companionId: id, command: botWorldCommandSchema, effectId: id }),
]);
export type BotRequest = z.infer<typeof botRequestSchema>;
export interface BotResponse { topicContext?:BotTopicContext; ok: boolean; error?: string; snapshot?: BotSnapshot; conversationId?: string; messageId?: string; replyMessageIds?: string[]; memory?: unknown; world?: BotWorldSnapshot; history?: BotHistoryPage; taskPage?: BotTaskPage; task?: BotTask; taskRemoved?: boolean; personas?: BotPersonaTemplateList; persona?: BotPersonaTemplate; cleanup?: BotDataCleanup; topics?: BotNativeTopic[]; nextTopicCursor?: string; topic?: BotNativeTopic; compacted?: boolean; compactionSettled?: boolean }
export type BotEvent = { type: 'changed'; conversationId?: string }
  | { type: 'data-cleared'; companionId: string }
  | { type: 'text'; conversationId: string; messageId: string; text: string }
  | { type: 'error'; conversationId?: string; message: string };
export interface WorldlineBoxBotApi {
  request(input: BotRequest): Promise<BotResponse>;
  onEvent(listener: (event: BotEvent) => void): () => void;
}
