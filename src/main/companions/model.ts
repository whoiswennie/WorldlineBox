import {
  AI_API_FORMATS, resolveAnthropicMessagesUrl, resolveDashScopeMultimodalGenerationUrl,
  resolveGeminiGenerateContentUrl, resolveOpenAiChatCompletionsUrl, resolveOpenAiResponsesUrl,
  type AiApiFormat,
} from '../../shared/ai-endpoints';
import type { Companion } from '../../shared/companions';
import { randomUUID } from 'node:crypto';
import type { CompanionModelUsageCurrent, CompanionReportedUsage } from '../../shared/companion-model-usage';
import { companionProviderUsage, estimateCompanionProviderInput, mergeCompanionProviderUsage } from './model-usage';
import { compileCompanionAgentContext, companionAgentContextSize } from './agent-context';
import { isDeepseekOfficialEndpoint } from '../../shared/llm';
import { buildCompanionContext, refreshCompanionContextClock, refreshCompanionRuntimeStateContext, refreshCompanionCharacterDevelopmentContext, refreshCompanionIdentityContext, refreshCompanionFilesContext, type CompanionReplyInput } from './context';
import { companionPerceivedToolTurns } from './world-perception-context';
import { companionStateToolTurns } from './state-context';
import { COMPANION_DSH_CAPABILITY_TOOL, COMPANION_MEMORY_CAPABILITY_TOOL, COMPANION_WORLD_CAPABILITY_TOOL } from '../../shared/companion-capability-tools';
import { COMPANION_AGENDA_TOOL } from '../../shared/companion-agenda-tool';
import { companionProviderToolParameters } from '../../shared/companion-tool-json-schema';
import { assembleCompanionInvocation } from './invocation-context';
import { companionRepeatedObservation, projectCompanionToolHistory } from './context-tool-history';
import { companionReplyIdentityIssue } from './reply-identity';
import type { CompanionLoopCall, CompanionLoopTurn } from '../../shared/companion-loop';
import { CompanionProviderStreamError, readCompanionProviderStream } from './provider-stream';
import { companionProviderContextCapacity } from './provider-capacity';
import type { CompanionVisualInput } from '../../shared/companion-public-profile';
import { companionUnsupportedImageError, prepareCompanionVisualContext, refreshCompanionPublicProfileContext } from './public-profile-context';
import { type ToolVisualInput } from '../../shared/companion-file-tool';
import { companionToolResultText, prepareCompanionLoopVisuals, type CompanionToolImageDelivery } from './tool-image-context';
import { prepareTopicContinuityFocus, projectTopicContinuityFocus, type TopicContinuityFocusFrame } from './topic-continuity-focus';
import type { CompanionHostObservationChange } from '../../shared/companion-agent-run';
import { COMPANION_BROWSER_CAPABILITY_TOOL } from '../../shared/companion-browser';
import { filterCompanionTools, normalizeCompanionToolPolicy, COMPANION_DSH_TASK_ROUTING_RULES, type CompanionToolPolicy } from '../../shared/companion-tool-policy';
import { COMPANION_WAIT_TOOL } from '../../shared/companion-wait';
import { projectCompanionMemoryContextForModel, projectCompanionMemoryToolTurnsForModel } from './memory-model-context';
import { companionModelQuota, companionModelConnection, CompanionModelAdmissionError, type CompanionModelPriority } from './model-quota';
import { companionAssetReplyIdentity } from './asset-context';
import type { CompanionModelRequestPurpose } from '../../shared/companion-model-purpose';
import { companionContextFrameSchema, type CompanionContextFrame } from '../../shared/companion-cognition';
import { companionStructuredRepairContext, companionStructuredRepairConservation, parseCompanionStructured, structuredHash, type CompanionStructuredModelOptions } from './structured-repair';
export type { CompanionStructuredModelOptions, CompanionStructuredResponseSchema } from './structured-repair';

export type { CompanionReplyInput } from './context';
/** Included in the memory focus generation profile as well as actual requests. */
export const COMPANION_TEXT_GENERATION_PROFILE = Object.freeze({ maxOutputTokens: 8_192, providerAdapterVersion: 1, sampling: 'provider-default' });
export interface CompanionTransportAttemptInput { frame: CompanionContextFrame; providerFormat: AiApiFormat; model: string; providerBody: string; imageFallback: boolean;
  /** Ephemeral preparation control, never part of the saved/provider body. */
  signal?: AbortSignal }
export interface CompanionTransportAttempt {
  beforeDispatch(): Promise<void>;
  dispatched(): Promise<void>;
  complete(outcome: 'response' | 'network_error' | 'cancelled_before_send', httpStatus?: number): Promise<void>;
}
export interface CompanionModelConfig {
  /** Explicit host/provider model metadata only. Unknown capacity stays absent. */
  contextWindowTokens?: number;
  /** Host-only scheduling metadata; never serialized as provider parameters. */
  ownerId?: string;
  workPriority?: CompanionModelPriority;
  requestPurpose?: CompanionModelRequestPurpose;
  /** The public call may cancel before local preparation/transport receipts
   * settle. Hosts retain the actual scheduled operation for safe shutdown. */
  trackOperation?(operation: Promise<unknown>): void;
  /** Live owner assets are resolved inside provider admission, including after
   * a queue wait. The host callback is never a provider parameter. */
  resolveAssetContext?(context: { system: string; user: string }, kind: 'reply' | 'structured' | 'text'): Promise<{ system: string; user: string; frame?: CompanionContextFrame }>;
  /** Host-only evidence port; only the final visible body is supplied. No URL,
   * headers, credentials, provider response or hidden reasoning enters it. */
  transportObserver?: { prepareAttempt(input: CompanionTransportAttemptInput): Promise<CompanionTransportAttempt> };
  /** Host-only global connection for bounded background format repair. It must
   * retain this owner and its real context/transport/resource bindings. */
  resolveStructuredRepairConfig?(): Promise<CompanionModelConfig>;
  /** Source/lease validation after queue admission, before actual dispatch.
   * This hook never imposes request, time-window, token or spending quotas. */
  providerLifecycle?: { beforeDispatch(): Promise<(outcome: 'response' | 'network_error' | 'cancelled_before_send', durationMs: number, httpStatus?: number) => Promise<void>> };
  /** Owner-loopback capability lookup. Resolved per native call before model
   * admission, never cached as one timeline run or serialized to providers. */
  resolveNativeLifecycle?(dispatchToken?: string): CompanionModelConfig['providerLifecycle'];
  apiFormat: AiApiFormat;
  model: string;
  baseUrl?: string;
  apiKey: string;
}
export function companionNativeProviderLifecycle(config: CompanionModelConfig, dispatchToken?: string): CompanionModelConfig['providerLifecycle'] {
  return config.resolveNativeLifecycle ? config.resolveNativeLifecycle(dispatchToken) : config.providerLifecycle;
}
export interface CompanionReply { text: string; memories?: string[]; topic?: string; turn?: CompanionLoopTurn }
export interface CompanionNativeTool { name: string; description: string; parameters: object }
export interface CompanionModelOptions { fetchFn?: typeof fetch; timeoutMs?: number; loop?: boolean; context?: ReturnType<typeof buildCompanionContext>; turns?: readonly CompanionLoopTurn[]; supplements?: readonly { id: string; content: string }[];
  /** Host-only final source fence, awaited after transport admission and before
   * invoking fetch. A rejected fence is never a dispatched network attempt. */
  beforeNetworkDispatch?(): Promise<void>;
  onUsage?: (usage: CompanionModelUsageCurrent) => void;
  browser?: boolean;
  toolPolicy?: CompanionToolPolicy;
  /** Trusted host validation of an unexecuted proposal, never new user authority. */
  hostValidationFeedback?: { rejectedProposalChecksum: string; error: string; instruction: string;
    kind?: 'validation_rejection' | 'host_observation_changed'; hostObservation?: CompanionHostObservationChange };
  /** Main's already source-validated typed topic frame, never model JSON. */
  topicReviewFrame?: TopicContinuityFocusFrame;
  tools?: readonly CompanionNativeTool[];
  additionalTools?: readonly CompanionNativeTool[];
  projectContext?: (context: { system: string; user: string }) => { system: string; user: string };
  identityCorrection?: string;
  deliveryCorrection?: string;
  /** In-memory image payloads for structured peer/world reasoning; never persisted. */
  visualInputs?: readonly CompanionVisualInput[];
  /** Authorized immutable tool snapshots, reloaded for the current inference only. */
  toolImages?: readonly ToolVisualInput[];
  /** Current turn's cumulative visible text, emitted only from real SSE events. */
  onTextDelta?: (text: string) => void }
export type CompanionModelErrorCode = 'CONFIG' | 'AUTH' | 'RATE_LIMIT' | 'NETWORK' | 'TIMEOUT' | 'CANCELLED' | 'INVALID_RESPONSE' | 'REFUSED' | 'IDENTITY' | 'CONTEXT_CAPACITY' | 'CONTEXT_RECORD_FAILED';
export class CompanionModelError extends Error {
  constructor(readonly code: CompanionModelErrorCode, message: string, readonly diagnostic?: string,
    readonly admission?: Pick<CompanionModelAdmissionError, 'reason' | 'retryAt'>) {
    super(message);
    this.name = 'CompanionModelError';
  }
}

/** Only a trusted host refusal before HTTP is deferrable without consuming a
 * semantic attempt. A provider HTTP 429 has no admission receipt. */
export function companionModelAdmissionRetryAfter(error: unknown, now = Date.now()): number | undefined {
  const admission = error instanceof CompanionModelAdmissionError ? error : error instanceof CompanionModelError ? error.admission : undefined;
  if (!admission) return undefined;
  const until = admission.retryAt ? Date.parse(admission.retryAt) : NaN;
  return Math.max(1000, Math.min(86_400_000, Number.isFinite(until) ? until - now : 30_000));
}

const RESPONSE_LIMIT = 256 * 1_024;
const REPLY_LIMIT = 16_000;

/** The caller selects either the full global config or the character's full override. Identity never routes models. */
export function resolveCompanionModel(_companion: Companion, config: CompanionModelConfig): string {
  return config.model.trim();
}

/** Stateless provider call. No provider response or chain-of-thought is retained by this layer. */
export async function generateCompanionReply(
  input: CompanionReplyInput,
  config: CompanionModelConfig,
  signal?: AbortSignal,
  options: CompanionModelOptions = {},
): Promise<CompanionReply> {
  if (signal?.aborted) throw new CompanionModelError('CANCELLED', '这次回复已取消。');
  assembleCompanionInvocation(input);
  validateConfig(config);
  const model = resolveCompanionModel(input.companion, config);
  if (!model || model.length > 160) throw configurationError('请在模型设置中配置有效的聊天模型。');
  const assembledContext = refreshCompanionContextClock(refreshCompanionFilesContext(refreshCompanionPublicProfileContext(refreshCompanionIdentityContext(refreshCompanionCharacterDevelopmentContext(refreshCompanionRuntimeStateContext(
    options.context ?? buildCompanionContext({ ...input, agentLoop: options.loop }), input.runtimeState, input.companion.id, input.conversation), input.characterDevelopment, input.companion.id, input.conversation.id), input),
  { companionId: input.companion.id, memberIds: input.conversation.memberIds, publicProfileIds: input.publicProfileIds, audience: input.audience, publicProfiles: input.publicProfiles }), input.fileInputs), input.world, input.companion.id);
  let context = options.projectContext?.(assembledContext) ?? assembledContext;
  if (options.loop) {
    const { memory: _legacyMemory, ...toolPolicy } = normalizeCompanionToolPolicy(options.toolPolicy ?? input.sourceMessage?.toolPolicy);
    void _legacyMemory;
    context = { ...context, system: context.system + '\n' + COMPANION_DSH_TASK_ROUTING_RULES + '\n本次原生能力选择：' + JSON.stringify(toolPolicy) };
  }
  const topicFrame = options.topicReviewFrame;
  if (topicFrame?.topic?.kind === 'story') {
    const actualSource = input.sourceMessage, capturedSource = topicFrame.sourceMessage;
    if (topicFrame.companion.id !== input.companion.id || topicFrame.conversation.id !== input.conversation.id
      || !actualSource || !capturedSource || actualSource.id !== capturedSource.id || actualSource.content !== capturedSource.content
      || actualSource.conversationId !== input.conversation.id || capturedSource.conversationId !== input.conversation.id
      || actualSource.authorId !== capturedSource.authorId
      || actualSource.topicId !== topicFrame.topic.id || capturedSource.topicId !== topicFrame.topic.id)
      throw new CompanionModelError('INVALID_RESPONSE', '话题写作焦点与当前推理身份或实际来源不一致，未调用作者模型。');
    const focus = await prepareTopicContinuityFocus({ frame: topicFrame, config, signal, fetchFn: options.fetchFn });
    context = projectTopicContinuityFocus(context, focus);
  }
  if (options.identityCorrection) context.system += '\n【宿主身份纠错】\n' + options.identityCorrection;
  if (options.deliveryCorrection) context.system += '\n【宿主交付事实核验】\n' + options.deliveryCorrection;
  const turns = projectCompanionToolHistory(companionStateToolTurns(companionPerceivedToolTurns(options.turns ?? [], input.companion.id, input.world)));
  const repeatedObservation = companionRepeatedObservation(options.turns ?? []);
  if (repeatedObservation) context.system += '\n【宿主进展检查】\n' + JSON.stringify(repeatedObservation)
    + '：最近多次查询已返回相同世界资料，完整结果仍在原生tool回执中。查询不是联系、邀约或建群。请使用已有真实标识执行当前目标的下一步，或说明实际阻碍后结束；不要继续用同样查询搭配“我先看看”来代替行动。新证据与真实行动会重新计算此提示。这不是任务轮数上限，也不改变你的身份、目标或权限。';
  const controller = new AbortController();
  let httpStarted = false, operationStarted = false;
  let rejectAbort: (error: CompanionModelError | CompanionModelAdmissionError) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = () => {
    const error = new CompanionModelError('CANCELLED', '这次回复已取消。'); rejectAbort(error); controller.abort(error);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const expire = () => {
    const error = httpStarted ? new CompanionModelError('TIMEOUT', '伙伴回复超时，请稍后重试。')
      : new CompanionModelAdmissionError(operationStarted ? 'preflight_timeout' : 'queue_timeout', '模型尚未发送请求，等待资源后继续。');
    rejectAbort(error); controller.abort(error);
  };
  const idleMs = Math.max(1, Math.min(options.timeoutMs ?? 45_000, 120_000));
  let timer = setTimeout(expire, idleMs), streamDeadline: ReturnType<typeof setTimeout> | undefined;
  const streamActivity = () => { if (!controller.signal.aborted) { clearTimeout(timer); timer = setTimeout(expire, idleMs); } };
  const providerFetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  let modelUsage: CompanionModelUsageCurrent | undefined;
  const emitUsage = () => { try { if (modelUsage) options.onUsage?.(modelUsage); } catch { /* Telemetry cannot replay or fail the paid operation. */ } };
  const reportUsage = (actual: CompanionReportedUsage) => {
    if (!modelUsage) return;
    modelUsage = { ...modelUsage, phase: 'streaming', updatedAt: new Date().toISOString(), actual: mergeCompanionProviderUsage(modelUsage.actual, actual) }; emitUsage();
  };
  const fetchFn: typeof fetch = (...args) => {
    httpStarted = true;
    if (modelUsage) { modelUsage = { ...modelUsage, phase: 'dispatched', updatedAt: new Date().toISOString() }; emitUsage(); }
    return providerFetch(...args);
  };
  try {
    if (signal?.aborted) cancel();
    const operation = async (): Promise<CompanionReply> => {
      operationStarted = true;
      if (config.resolveAssetContext) context = await config.resolveAssetContext(context, 'reply');
      controller.signal.throwIfAborted();
      const transport = await fetchCompanionProvider(controller.signal, fetchFn, rejected => {
        const current = prepareCompanionLoopVisuals(context, input.visualInputs ?? options.visualInputs, options.loop ? options.toolImages : undefined, options.loop ? turns : [], config, rejected);
        const request = providerRequest({ ...config, model }, projectCompanionMemoryContextForModel(current.context), controller.signal, options.loop === true, options.loop === true, true, current.images, true,
          options.loop ? filterCompanionTools(options.tools ?? [COMPANION_DSH_CAPABILITY_TOOL, COMPANION_MEMORY_CAPABILITY_TOOL, COMPANION_WORLD_CAPABILITY_TOOL, COMPANION_AGENDA_TOOL, COMPANION_WAIT_TOOL,
            ...(options.browser ? [COMPANION_BROWSER_CAPABILITY_TOOL] : []), ...(options.additionalTools ?? [])], normalizeCompanionToolPolicy(options.toolPolicy ?? input.sourceMessage?.toolPolicy)) : options.tools, true);
        if (options.loop) appendLoopHistory(request, config, projectCompanionMemoryToolTurnsForModel(turns), options.supplements ?? [], current.tools, options.hostValidationFeedback);
        modelUsage = { attemptId: randomUUID(), model, providerFormat: config.apiFormat, phase: 'prepared', updatedAt: new Date().toISOString(),
          estimate: estimateCompanionProviderInput(config.apiFormat, JSON.parse(String(request[1]?.body))),
          ...(Number.isSafeInteger(config.contextWindowTokens) && config.contextWindowTokens! > 0 ? { contextLimit: config.contextWindowTokens } : {}) }; emitUsage();
        return { request, hasImages: current.images.length > 0 || current.tools.some(tool => !!tool.image), frame: (context as { frame?: CompanionContextFrame }).frame };
      }, config.providerLifecycle, config, options.beforeNetworkDispatch);
      const response = transport.response;
      let body: unknown;
      try {
        if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
          streamActivity(); streamDeadline = setTimeout(expire, 10 * 60_000);
          body = await readCompanionProviderStream(response, config.apiFormat, { signal: controller.signal,
            onText: text => { if (!controller.signal.aborted) options.onTextDelta?.(text); }, onActivity: streamActivity, ...(options.onUsage ? { onUsage: reportUsage } : {}) });
        } else { body = await readBoundedJson(response); const actual = companionProviderUsage(config.apiFormat, body); if (actual) reportUsage(actual); }
      } finally { await transport.complete(); }
      if (modelUsage) { modelUsage = { ...modelUsage, phase: 'finished', updatedAt: new Date().toISOString() }; emitUsage(); }
      const loopCalls = options.loop ? extractLoopCalls(config.apiFormat, body) : [];
      const raw = extractProviderText(config.apiFormat, body, loopCalls.length > 0);
      const result = options.loop ? parseLoopText(raw, loopCalls.length > 0) : parseCompanionReply(raw, input.proactive === true || input.conversation.kind === 'group');
      let topic: { id: string; participantIds: string[]; invitedIds: string[] } | undefined;
      try { topic = (JSON.parse(context.user) as { topic?: typeof topic }).topic; } catch { /* Plain custom contexts have no host topic frame. */ }
      if (topic && !topic.participantIds.includes(input.companion.id) && topic.invitedIds.includes(input.companion.id)
        && result.text.trim() && !/^[\s`]*[[{]/u.test(result.text)
        && !loopCalls.some(call => { try { const args = JSON.parse(call.arguments); return call.name === 'world' && args.action === 'topic'
          && args.parameters?.action === 'join' && args.parameters.topicId === topic.id; } catch { return false; } })) {
        throw new CompanionModelError('IDENTITY', '你目前只是这个话题的受邀者，尚未加入。愿意参与请先原生调用world，参数'
          + JSON.stringify({ action: 'topic', parameters: { action: 'join', topicId: topic.id } })
          + '，收到成功回执后再正式发言。不参加时按本入口约定返回空text/null/PASS；不代其他伙伴加入。');
      }
      const identityIssue = companionReplyIdentityIssue(result.text, companionAssetReplyIdentity(input, context));
      if (identityIssue) throw new CompanionModelError('IDENTITY', identityIssue);
      if (options.loop) {
        if (!raw.trim() && !loopCalls.length) throw new CompanionModelError('INVALID_RESPONSE', '模型没有返回正文或能力调用。');
        const cleaned = stripCompanionThoughts(raw);
        let rawText = cleaned;
        try {
          const value = JSON.parse(cleaned.replace(/^```json\s*/u, '').replace(/\s*```$/u, ''));
          if (value && typeof value.text === 'string') rawText = JSON.stringify({ ...value, text: result.text });
        } catch { /* Native assistant Markdown stays as supplied, excluding thoughts. */ }
        result.turn = { text: result.text, rawText, calls: loopCalls };
        return result;
      }
      if (!result.text.trim() || input.proactive || input.actionResult || !input.messages.some((message) => message.conversationId === input.conversation.id && message.authorId === 'user')) {
        result.memories = [];
      }
      return result;
    };
    const scheduled = companionModelQuota.run({ ownerId: input.companion.id, connectionId: companionModelConnection(config),
      priority: config.workPriority ?? 'foreground', estimatedInputTokens: Math.ceil((companionAgentContextSize(projectCompanionMemoryContextForModel(context))
        + (options.loop ? JSON.stringify(projectCompanionMemoryToolTurnsForModel(turns)).length : 0)) / 4) }, operation, controller.signal);
    await retainCompanionModelOperation(config, scheduled, controller, cancel);
    return await Promise.race([scheduled, aborted]);
  } catch (error) {
    if (error instanceof CompanionModelError) throw error;
    if (error instanceof CompanionModelAdmissionError) throw new CompanionModelError('RATE_LIMIT', error.message, undefined, { reason: error.reason, retryAt: error.retryAt });
    if (error instanceof CompanionProviderStreamError) throw new CompanionModelError(error.code, error.message, error.diagnostic);
    // Never propagate raw network errors: providers can include URLs, headers or credentials.
    throw new CompanionModelError('NETWORK', '无法连接聊天模型，请检查网络和模型设置。');
  } finally {
    clearTimeout(timer);
    clearTimeout(streamDeadline);
    signal?.removeEventListener('abort', cancel);
  }
}

/** Structured cognition uses the same provider transport as ordinary conversation. */
export async function generateCompanionStructured(
  context: { system: string; user: string }, config: CompanionModelConfig, signal?: AbortSignal,
  options: CompanionStructuredModelOptions = {},
): Promise<unknown> {
  let resolvedContext: { system: string; user: string; frame?: CompanionContextFrame } | undefined;
  const originalResolver = config.resolveAssetContext;
  const observed = originalResolver ? { ...config, resolveAssetContext: async (value: { system: string; user: string }, kind: 'reply' | 'structured' | 'text') => {
    const result = await originalResolver(value, kind); resolvedContext = result; return result;
  } } : config;
  const raw = await generateCompanionContent(context, observed, signal, options, true);
  return repairCompanionStructured({ context, raw, config, signal, options, resolvedContext });
}

/** One completed output, at most two global-model repair requests. No repair
 * path replays native tools, retries a network-unknown result, or commits a
 * domain effect. Every child request uses normal background admission and a
 * deterministic invocation, so restart cannot evade the unknown-send barrier. */
export async function repairCompanionStructured(input: {
  context: { system: string; user: string }; raw: string; config: CompanionModelConfig; signal?: AbortSignal; options?: CompanionStructuredModelOptions;
  resolvedContext?: { system: string; user: string; frame?: CompanionContextFrame };
}): Promise<unknown> {
  const { context, config, signal } = input, options = input.options ?? {};
  let raw = input.raw, parsed = parseCompanionStructured(raw, options.responseSchema);
  if (parsed.success) return parsed.value;
  const maximum = options.maxRepairAttempts ?? 2, initial = options.initialRepairAttempts ?? 0;
  if (![0, 1, 2].includes(maximum) || ![0, 1, 2].includes(initial)) throw new CompanionModelError('CONFIG', '结构修复次数配置无效。');
  if (initial >= maximum) throw new CompanionModelError('INVALID_RESPONSE', '结构化输出未通过校验，已达到本次修复上限；原始依据保留待处理。', 'structured_repair_exhausted');
  if (Buffer.byteLength(raw, 'utf8') > 256 * 1024 || Buffer.byteLength(context.system + context.user, 'utf8') > 1024 * 1024)
    throw new CompanionModelError('CONTEXT_CAPACITY', '待修复内容超出有界修复容量，原始依据保留，未发送额外模型请求。');
  const resolved = input.resolvedContext ?? (config.resolveAssetContext ? await config.resolveAssetContext(context, 'structured') : undefined);
  const rootFrame = resolved?.frame, originalHash = structuredHash(input.raw);
  const rootInvocationId = rootFrame?.invocationId ?? `structured:${structuredHash(JSON.stringify([config.ownerId ?? 'host', context, rootFrame?.profileRevision, rootFrame?.revocationEpoch]))}`;
  let previousInvocationId = initial ? `structured-repair:${structuredHash(rootInvocationId)}:${initial}` : rootInvocationId;
  for (let n = initial + 1; n <= maximum; n++) {
    if (signal?.aborted) throw new CompanionModelError('CANCELLED', '结构修复已取消。');
    const attempt = n as 1 | 2;
    const repair = companionStructuredRepairContext({ context, raw, originalRaw: input.raw, preserveCollections: options.repairPreserveCollections,
      preserveValues: options.repairPreserveValues,
      problem: parsed.problem, frame: rootFrame, rootInvocationId, previousInvocationId, attempt });
    const globalConfig = config.resolveStructuredRepairConfig ? await config.resolveStructuredRepairConfig() : config;
    if (globalConfig.ownerId !== config.ownerId) throw new CompanionModelError('CONFIG', '结构修复不能更换伙伴归属。');
    const resolveRepairContext = globalConfig.resolveAssetContext;
    const repairConfig: CompanionModelConfig = { ...globalConfig, workPriority: 'background', requestPurpose: 'repair',
      providerLifecycle: combineProviderLifecycles(config.providerLifecycle, globalConfig.providerLifecycle),
      ...(resolveRepairContext ? { resolveAssetContext: async (value, kind) => {
        const current = await resolveRepairContext(value, kind);
        if (rootFrame && (!current.frame || current.frame.companionId !== rootFrame.companionId || current.frame.profileRevision !== rootFrame.profileRevision
          || current.frame.promptRevision !== rootFrame.promptRevision || current.frame.revocationEpoch !== rootFrame.revocationEpoch))
          throw new CompanionModelError('CANCELLED', '修复前人格、指导或来源版本已变化，旧结果未继续处理。');
        return { ...current, ...(current.frame ? { frame: { ...current.frame, conversationId: rootFrame?.conversationId ?? current.frame.conversationId,
          sourceRefs: rootFrame?.sourceRefs ?? current.frame.sourceRefs, dependencyRefs: rootFrame?.dependencyRefs ?? current.frame.dependencyRefs,
          invocationId: repair.invocationId, structuredRepair: repair.structuredRepair } } : {}) };
      } } : {}) };
    await options.onRepairAttempt?.({ attempt, originalHash });
    // Deliberately call the raw content port: repaired output cannot recurse
    // into a fresh repair budget and no original tools are exposed here.
    raw = await generateCompanionContent(repair.context, repairConfig, signal, options, true);
    parsed = parseCompanionStructured(raw, options.responseSchema);
    if (parsed.success) {
      const loss = companionStructuredRepairConservation(input.raw, parsed.value, options.repairPreserveCollections, options.repairPreserveValues);
      if (loss) parsed = { success: false, problem: loss };
    }
    if (parsed.success) {
      await options.onRepairResult?.({ attempt, originalHash, content: raw, contentHash: structuredHash(raw) });
      return parsed.value;
    }
    previousInvocationId = repair.invocationId;
  }
  throw new CompanionModelError('INVALID_RESPONSE', '结构化输出在有限修复后仍未通过校验；原始依据保留待处理。', 'structured_repair_exhausted');
}

/** VCP timeline prompts retain their plain text output across every configured API format. */
export async function generateCompanionText(
  context: { system: string; user: string },
  config: CompanionModelConfig,
  signal?: AbortSignal,
  options: Pick<CompanionModelOptions, 'fetchFn' | 'timeoutMs' | 'visualInputs' | 'beforeNetworkDispatch'> = {},
): Promise<string> {
  return generateCompanionContent(context, config, signal, options, false);
}
async function generateCompanionContent(
  context: { system: string; user: string }, config: CompanionModelConfig, signal: AbortSignal | undefined,
  options: Pick<CompanionModelOptions, 'fetchFn' | 'timeoutMs' | 'visualInputs' | 'beforeNetworkDispatch'>, structured: boolean,
): Promise<string> {
  if (signal?.aborted) throw new CompanionModelError('CANCELLED', '记忆处理已取消。');
  validateConfig(config);
  const model = config.model.trim();
  if (!model || model.length > 160) throw configurationError('请在模型设置中配置有效的聊天模型。');
  const controller = new AbortController();
  let httpStarted = false, operationStarted = false;
  let rejectAbort: (error: CompanionModelError | CompanionModelAdmissionError) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = () => { const error = new CompanionModelError('CANCELLED', '记忆处理已取消。'); rejectAbort(error); controller.abort(error); };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    const error = httpStarted ? new CompanionModelError('TIMEOUT', '记忆处理超时，请稍后重试。')
      : new CompanionModelAdmissionError(operationStarted ? 'preflight_timeout' : 'queue_timeout', '模型尚未发送请求，等待资源后继续。');
    rejectAbort(error); controller.abort(error);
  }, Math.max(1, Math.min(options.timeoutMs ?? 45_000, 120_000)));
  const providerFetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const fetchFn: typeof fetch = (...args) => { httpStarted = true; return providerFetch(...args); };
  try {
    if (signal?.aborted) cancel();
    const operation = async () => {
      operationStarted = true;
      if (config.resolveAssetContext) context = await config.resolveAssetContext(context, structured ? 'structured' : 'text');
      controller.signal.throwIfAborted();
      const transport = await fetchCompanionProvider(controller.signal, fetchFn, rejected => {
        const current = prepareCompanionVisualContext(context, options.visualInputs, config, rejected);
        return { request: providerRequest({ ...config, model }, current.context, controller.signal, false, false, false, current.images, structured), hasImages: current.images.length > 0, frame: (context as { frame?: CompanionContextFrame }).frame };
      }, config.providerLifecycle, config, options.beforeNetworkDispatch);
      let envelope: unknown;
      try { envelope = await readBoundedJson(transport.response); } finally { await transport.complete(); }
      if (extractLoopCalls(config.apiFormat, envelope).length) throw new CompanionModelError('INVALID_RESPONSE', '记忆模型不应调用工具。');
      const raw = extractProviderText(config.apiFormat, envelope).trim();
      return stripCompanionThoughts(raw);
    };
    const scheduled = companionModelQuota.run({ ownerId: config.ownerId ?? 'host', connectionId: companionModelConnection(config),
      priority: config.workPriority ?? 'foreground', estimatedInputTokens: Math.ceil((context.system.length + context.user.length) / 4) }, operation, controller.signal);
    await retainCompanionModelOperation(config, scheduled, controller, cancel);
    return await Promise.race([scheduled, aborted]);
  } catch (error) {
    if (error instanceof CompanionModelError) throw error;
    if (error instanceof CompanionModelAdmissionError) throw new CompanionModelError('RATE_LIMIT', error.message, undefined, { reason: error.reason, retryAt: error.retryAt });
    throw new CompanionModelError('NETWORK', '无法连接聊天模型，请检查网络和模型设置。');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

const companionOperationCancels = new WeakMap<Promise<unknown>, () => void>();
/** Main can cancel every admitted operation of one owner, including a
 * recovered feedback generation which has no live action controller. */
export function cancelCompanionModelOperation(operation: Promise<unknown>): void { companionOperationCancels.get(operation)?.(); }
async function retainCompanionModelOperation(config: CompanionModelConfig, scheduled: Promise<unknown>, controller: AbortController, cancel: () => void): Promise<void> {
  companionOperationCancels.set(scheduled, cancel);
  void scheduled.finally(() => companionOperationCancels.delete(scheduled)).catch(() => undefined);
  try { config.trackOperation?.(scheduled); }
  catch {
    const error = new CompanionModelError('CONFIG', '模型操作未能登记到宿主生命周期，本次处理已停止。');
    controller.abort(error);
    await scheduled.catch(() => undefined);
    throw error;
  }
}

function validateConfig(config: CompanionModelConfig): void {
  if (!(AI_API_FORMATS as readonly string[]).includes(config.apiFormat)) {
    throw configurationError('当前模型接口格式不受支持，请重新选择。');
  }
  if (!config.apiKey.trim()) throw configurationError('请先在模型设置中配置 API 密钥。');
  if (!config.baseUrl?.trim()) return;
  try {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    throw configurationError('模型接口地址无效，请填写不含凭据和查询参数的 HTTP 地址。');
  }
}
function configurationError(message: string): CompanionModelError {
  return new CompanionModelError('CONFIG', message, undefined, { reason: 'configuration_unavailable' });
}

type CompanionProviderResponse = { response: Response; complete(): Promise<void> };
function combineProviderLifecycles(...values: Array<CompanionModelConfig['providerLifecycle']>): CompanionModelConfig['providerLifecycle'] {
  const hooks = [...new Set(values.filter((value): value is NonNullable<typeof value> => !!value))];
  if (!hooks.length) return undefined;
  return { beforeDispatch: async () => {
    const finishes: Array<Awaited<ReturnType<(typeof hooks)[number]['beforeDispatch']>>> = [];
    try { for (const hook of hooks) finishes.push(await hook.beforeDispatch()); }
    catch (error) { await Promise.allSettled(finishes.map(finish => finish('cancelled_before_send', 0))); throw error; }
    return async (...args) => {
      const outcomes = await Promise.allSettled(finishes.map(finish => finish(...args)));
      const failed = outcomes.find(outcome => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    };
  } };
}
async function fetchCompanionProvider(signal: AbortSignal, fetchFn: typeof fetch,
  build: (rejected: boolean) => { request: Parameters<typeof fetch>; hasImages: boolean; frame?: CompanionContextFrame }, lifecycle?: CompanionModelConfig['providerLifecycle'], config?: CompanionModelConfig,
  beforeNetworkDispatch?: CompanionModelOptions['beforeNetworkDispatch']): Promise<CompanionProviderResponse> {
  const send = async (current: ReturnType<typeof build>, imageFallback: boolean): Promise<CompanionProviderResponse> => {
    if (signal.aborted) throw new CompanionModelError('CANCELLED', '这次模型请求已取消。');
    const request = current.request;
    const body = request[1]?.body;
    let finish: Awaited<ReturnType<NonNullable<CompanionModelConfig['providerLifecycle']>['beforeDispatch']>> | undefined;
    try { finish = await lifecycle?.beforeDispatch(); }
    catch (error) {
      if (error instanceof CompanionModelAdmissionError || error instanceof CompanionModelError) throw error;
      throw new CompanionModelError('CANCELLED', '实际发送前来源、权限或任务租约未通过核验，本次没有发送模型。');
    }
    let evidence: CompanionTransportAttempt | undefined;
    if (config?.transportObserver) {
      if (typeof body !== 'string' || !current.frame || !companionContextFrameSchema.safeParse(current.frame).success || current.frame.companionId !== config.ownerId)
        throw new CompanionModelError('CONFIG', '实际请求缺少当前伙伴的正式上下文版本，未发送。');
      try { evidence = await config.transportObserver.prepareAttempt({ frame: current.frame, providerFormat: config.apiFormat, model: config.model.trim(), providerBody: body, imageFallback, signal }); }
      catch (cause) { await finish?.('cancelled_before_send', 0); if (signal.aborted) throw new CompanionModelError('CANCELLED', '这次模型请求已取消。'); if (cause instanceof CompanionModelAdmissionError) throw cause; if (cause instanceof Error && 'code' in cause && cause.code === 'CONTEXT_RECORD_FAILED') throw new CompanionModelError('CONTEXT_RECORD_FAILED', cause.message); throw new CompanionModelError('CONTEXT_CAPACITY', '实际请求正文未能完整保存，未发送模型。请检查认知档案存储或缩小本次输入。'); }
    }
    const started = performance.now();
    if (signal.aborted) { await evidence?.complete('cancelled_before_send'); await finish?.('cancelled_before_send', 0); throw new CompanionModelError('CANCELLED', '这次模型请求已取消。'); }
    try { await evidence?.beforeDispatch(); await beforeNetworkDispatch?.(); }
    catch { await Promise.allSettled([evidence?.complete('cancelled_before_send'), finish?.('cancelled_before_send', 0)]); throw new CompanionModelError('CANCELLED', '实际发送前来源已撤回或授权已变化，旧上下文未发送。'); }
    if (signal.aborted) { await evidence?.complete('cancelled_before_send'); await finish?.('cancelled_before_send', 0); throw new CompanionModelError('CANCELLED', '这次模型请求已取消。'); }
    let response: Response;
    try {
      // Invoke fetch first: a prepared/cancelled attempt is never labelled sent.
      // Attach both handlers immediately, including if durable state I/O yields.
      const pending = Promise.resolve(fetchFn(...request)).then(value => ({ value }), error => ({ error }));
      try { await evidence?.dispatched(); }
      catch { const result = await pending; if ('value' in result) await result.value.body?.cancel().catch(() => undefined); await finish?.('value' in result ? 'response' : 'network_error', performance.now() - started, 'value' in result ? result.value.status : undefined); throw new CompanionModelError('CONTEXT_RECORD_FAILED', '请求已交给网络层，但发送凭证未能完成保存。为避免重复付费，本次不自动重发。'); }
      const outcome = await pending;
      if ('error' in outcome) throw outcome.error;
      response = outcome.value;
    } catch (error) { if (error instanceof CompanionModelError && error.code === 'CONTEXT_RECORD_FAILED') throw error; try { await evidence?.complete('network_error'); } catch { throw new CompanionModelError('CONTEXT_RECORD_FAILED', '网络请求已尝试，但结果凭证未能保存。本次不自动重发。'); } finally { await finish?.('network_error', performance.now() - started); } throw error; }
    let completed = false;
    return { response, complete: async () => {
      if (completed) return; completed = true;
      try { await evidence?.complete('response', response.status); }
      catch { throw new CompanionModelError('CONTEXT_RECORD_FAILED', '提供方已响应，但结果凭证未能保存。本次不自动重发。'); }
      finally { await finish?.('response', performance.now() - started, response.status); }
    } };
  };
  const readError = async (value: CompanionProviderResponse) => {
    try { return await readBoundedJson(value.response); } finally { await value.complete(); }
  };
  const current = build(false);
  let transport = await send(current, false);
  if (!transport.response.ok && current.hasImages && [400, 415].includes(transport.response.status)) {
    const status = transport.response.status;
    let error: unknown; try { error = await readError(transport); } catch (cause) { if (cause instanceof CompanionModelError && cause.code === 'CONTEXT_RECORD_FAILED') throw cause; throw httpError(status); }
    if (!companionUnsupportedImageError(error)) throw companionContextCapacityError(error) ?? httpError(status, error);
    if (signal.aborted) throw new CompanionModelError('CANCELLED', '这次模型请求已取消。');
    transport = await send(build(true), true);
  }
  if (!transport.response.ok) {
    const response = transport.response;
    let error: unknown;
    try { error = await readError(transport); } catch (cause) { if (cause instanceof CompanionModelError && cause.code === 'CONTEXT_RECORD_FAILED') throw cause; throw httpError(response.status); }
    throw ([400, 413, 422].includes(response.status) ? companionContextCapacityError(error) : undefined) ?? httpError(response.status, error);
  }
  return transport;
}
function companionImageParts(format: AiApiFormat, images: readonly CompanionVisualInput[]): Array<Record<string, unknown>> {
  return images.flatMap<Record<string, unknown>>(image => {
    const label = JSON.stringify({ publicImage: { personId: image.personId, role: image.role, sha256: image.sha256 } });
    const detail = image.role === 'orthographic' ? 'high' : 'low';
    return [companionTextPart(format, label), companionImagePart(format, image, detail)];
  });
}
function companionTextPart(format: AiApiFormat, text: string): Record<string, unknown> {
  return format === 'gemini_native' || format === 'dashscope_native' ? { text } : { type: format === 'openai_responses' ? 'input_text' : 'text', text };
}
function companionImagePart(format: AiApiFormat, image: Pick<ToolVisualInput, 'mime' | 'base64'>, detail = 'high'): Record<string, unknown> {
  const url = `data:${image.mime};base64,${image.base64}`;
  if (format === 'gemini_native') return { inlineData: { mimeType: image.mime, data: image.base64 } };
  if (format === 'dashscope_native') return { image: url };
  if (format === 'anthropic') return { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } };
  if (format === 'openai_responses') return { type: 'input_image', image_url: url, detail };
  return { type: 'image_url', image_url: { url, detail } };
}
function providerRequest(config: CompanionModelConfig, context: { system: string; user: string }, signal: AbortSignal, enableDsh = true, enableMemory = false, stream = false, images: readonly CompanionVisualInput[] = [], structured = true, suppliedTools?: readonly CompanionNativeTool[], agent = false): Parameters<typeof fetch> {
  const compiled = agent ? compileCompanionAgentContext(context) : { system: context.system, messages: [{ role: 'user' as const, content: context.user }] };
  const deepseek = isDeepseekOfficialEndpoint(config.baseUrl ?? '');
  const tools = (suppliedTools ?? [...(enableDsh ? [COMPANION_DSH_CAPABILITY_TOOL] : []), ...(enableMemory ? [COMPANION_MEMORY_CAPABILITY_TOOL, COMPANION_WORLD_CAPABILITY_TOOL, COMPANION_AGENDA_TOOL] : [])])
    .map(tool => ({ ...tool, parameters: companionProviderToolParameters(tool.parameters) }));
  const bearerHeaders = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
  const imageMessage = images.length ? [{ role: 'user', content: companionImageParts(config.apiFormat, images) }] : [];
  const init = (headers: Record<string, string>, body: unknown): RequestInit => ({ method: 'POST', headers: { ...headers, ...(stream ? { Accept: 'text/event-stream' } : {}) },
    signal, redirect: 'error', body: JSON.stringify(body) });
  switch (config.apiFormat) {
    case 'openai_chat':
      return [resolveOpenAiChatCompletionsUrl(config.baseUrl), init(bearerHeaders, {
        model: config.model, max_tokens: COMPANION_TEXT_GENERATION_PROFILE.maxOutputTokens, stream, ...(stream ? { stream_options: { include_usage: true } } : {}),
        ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: { ...tool, strict: false } })), parallel_tool_calls: true } : {}),
        ...(deepseek ? { thinking: { type: 'disabled' }, ...(structured ? { response_format: { type: 'json_object' } } : {}) } : {}),
        messages: [{ role: 'system', content: compiled.system }, ...compiled.messages, ...imageMessage],
      })];
    case 'openai_responses':
      return [resolveOpenAiResponsesUrl(config.baseUrl), init(bearerHeaders, {
        model: config.model, max_output_tokens: COMPANION_TEXT_GENERATION_PROFILE.maxOutputTokens, stream,
        ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', ...tool, strict: false })), parallel_tool_calls: true } : {}),
        ...(deepseek ? { reasoning: { effort: 'none' }, ...(structured ? { text: { format: { type: 'json_object' } } } : {}) } : {}),
        instructions: compiled.system, input: [...compiled.messages, ...imageMessage],
      })];
    case 'anthropic':
      return [resolveAnthropicMessagesUrl(config.baseUrl), init({ 'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, {
        model: config.model, max_tokens: COMPANION_TEXT_GENERATION_PROFILE.maxOutputTokens, stream, system: compiled.system,
        ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
        ...(deepseek ? { thinking: { type: 'disabled' } } : {}),
        messages: [...compiled.messages, ...imageMessage],
      })];
    case 'gemini_native':
      return [resolveGeminiGenerateContentUrl(config.model, config.baseUrl).replace(/:generateContent$/u, stream ? ':streamGenerateContent?alt=sse' : ':generateContent'), init({ 'x-goog-api-key': config.apiKey,
        'Content-Type': 'application/json' }, {
        system_instruction: { parts: [{ text: compiled.system }] },
        ...(tools.length ? { tools: [{ function_declarations: tools.map(tool => ({ name: tool.name,
          description: tool.description, parametersJsonSchema: tool.parameters })) }] } : {}),
        contents: [...compiled.messages.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })), ...(images.length ? [{ role: 'user', parts: companionImageParts(config.apiFormat, images) }] : [])],
        generationConfig: { maxOutputTokens: COMPANION_TEXT_GENERATION_PROFILE.maxOutputTokens, ...(structured ? { responseMimeType: 'application/json' } : {}) },
      })];
    case 'dashscope_native':
      return [resolveDashScopeMultimodalGenerationUrl(config.baseUrl), init({ ...bearerHeaders, ...(stream ? { 'X-DashScope-SSE': 'enable' } : {}) }, {
        model: config.model, input: { messages: [{ role: 'system', content: [{ text: compiled.system }] },
          ...compiled.messages.map(message => ({ role: message.role, content: [{ text: message.content }] })), ...imageMessage] },
        parameters: { result_format: 'message', max_tokens: COMPANION_TEXT_GENERATION_PROFILE.maxOutputTokens, enable_thinking: false, ...(structured ? { response_format: { type: 'json_object' } } : {}),
          ...(stream ? { incremental_output: true } : {}),
          ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })) } : {}) },
      })];
  }
}

function extractLoopCalls(format: AiApiFormat, body: unknown): CompanionLoopCall[] {
  const root = asRecord(body);
  const calls: CompanionLoopCall[] = [];
  const add = (id: unknown, name: unknown, args: unknown, thoughtSignature?: unknown) => {
    if (typeof name !== 'string' || name.length > 100 || calls.length >= 16) return;
    const argumentText = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    if (argumentText.length > 65536) throw new CompanionModelError('INVALID_RESPONSE', '能力调用参数过长。');
    if (typeof thoughtSignature === 'string' && thoughtSignature.length > 65536) throw new CompanionModelError('INVALID_RESPONSE', '模型协议标识过长。');
    calls.push({ id: typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : `call_${calls.length}`, name, arguments: argumentText,
      ...(typeof thoughtSignature === 'string' && thoughtSignature.length ? { thoughtSignature } : {}) });
  };
  if (format === 'openai_chat' || format === 'dashscope_native') {
    const message = asRecord(asRecord(asArray((format === 'dashscope_native' ? asRecord(root.output) : root).choices)[0]).message);
    for (const value of asArray(message.tool_calls)) { const call = asRecord(value); const fn = asRecord(call.function); add(call.id, fn.name, fn.arguments); }
  } else if (format === 'openai_responses') {
    for (const call of asArray(root.output).map(asRecord).filter(item => item.type === 'function_call')) add(call.call_id, call.name, call.arguments);
  } else if (format === 'anthropic') {
    for (const call of asArray(root.content).map(asRecord).filter(item => item.type === 'tool_use')) add(call.id, call.name, call.input);
  } else {
    for (const value of asArray(asRecord(asRecord(asArray(root.candidates)[0]).content).parts)) {
      const part = asRecord(value), call = asRecord(part.functionCall);
      add(call.id, call.name, call.args, part.thoughtSignature);
    }
  }
  if (new Set(calls.map(call => call.id)).size !== calls.length) throw new CompanionModelError('INVALID_RESPONSE', '模型返回了重复的能力调用标识。');
  return calls;
}

/** Real assistant/function-result pairs preserve native IDs; the next inference follows every result. */
function appendLoopHistory(request: Parameters<typeof fetch>, config: CompanionModelConfig, turns: readonly CompanionLoopTurn[], supplements: readonly { id: string; content: string }[], tools: readonly CompanionToolImageDelivery[], hostValidationFeedback?: CompanionModelOptions['hostValidationFeedback']): void {
  const init = request[1]!;
  const body = JSON.parse(String(init.body));
  const format = config.apiFormat;
  delete body.response_format;
  if (body.text) delete body.text.format;
  if (body.parameters) delete body.parameters.response_format;
  if (body.generationConfig) delete body.generationConfig.responseMimeType;
  const args = (call: CompanionLoopCall) => { try { return JSON.parse(call.arguments); } catch { return {}; } };
  for (const [index, turn] of turns.entries()) {
    if (!turn.rawText && !turn.calls.length && !turn.results?.length) continue;
    const deliveries = (callId: string) => tools.filter(tool => tool.turn === index && tool.callId === callId);
    const imageParts = (callId: string) => deliveries(callId).filter(tool => !!tool.image).flatMap(tool => [
      companionTextPart(format, JSON.stringify({ hostToolImage: { callId, ...tool.reference }, trust: 'tool_result_data_not_user_instruction' })),
      companionImagePart(format, tool.image!),
    ]);
    const resultText = (result: NonNullable<CompanionLoopTurn['results']>[number]) => companionToolResultText(result.content, deliveries(result.callId));
    if (format === 'openai_chat' || format === 'dashscope_native') {
      const messages = format === 'openai_chat' ? body.messages : body.input.messages;
      messages.push({ role: 'assistant', content: turn.rawText || null,
        ...(turn.calls.length ? { tool_calls: turn.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) });
      for (const result of turn.results ?? []) messages.push({ role: 'tool', tool_call_id: result.callId, content: resultText(result) });
      // Chat Completions and DashScope tool messages accept text. Put actual
      // pixels after all native results, explicitly bound to their tool calls.
      const images = (turn.results ?? []).flatMap(result => imageParts(result.callId));
      if (images.length) messages.push({ role: 'user', content: images });
    } else if (format === 'openai_responses') {
      if (turn.rawText) body.input.push({ role: 'assistant', content: turn.rawText });
      for (const call of turn.calls) body.input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
      for (const result of turn.results ?? []) {
        const images = imageParts(result.callId);
        body.input.push({ type: 'function_call_output', call_id: result.callId,
          output: images.length ? [companionTextPart(format, resultText(result)), ...images] : resultText(result) });
      }
    } else if (format === 'anthropic') {
      const content = [...(turn.rawText ? [{ type: 'text', text: turn.rawText }] : []), ...turn.calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: args(call) }))];
      if (content.length) body.messages.push({ role: 'assistant', content });
      if (turn.results?.length) body.messages.push({ role: 'user', content: turn.results.map(result => {
        const images = imageParts(result.callId);
        return { type: 'tool_result', tool_use_id: result.callId, content: images.length ? [companionTextPart(format, resultText(result)), ...images] : resultText(result) };
      }) });
    } else {
      const parts = [...(turn.rawText ? [{ text: turn.rawText }] : []), ...turn.calls.map(call => ({ functionCall: { id: call.id, name: call.name, args: args(call) },
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) }))];
      if (parts.length) body.contents.push({ role: 'model', parts });
      if (turn.results?.length) {
        const nativeImages = /^gemini-3(?:[.-]|$)/iu.test(config.model);
        const responses = turn.results.map(result => {
          const images = deliveries(result.callId).filter(tool => !!tool.image);
          return { functionResponse: { id: result.callId, name: turn.calls.find(call => call.id === result.callId)!.name,
            response: { result: resultText(result), ...(nativeImages && images.length ? { image_refs: images.map(tool => ({ $ref: tool.reference.attachmentId })) } : {}) },
            ...(nativeImages && images.length ? { parts: images.map(tool => ({ inlineData: { mimeType: tool.image!.mime, data: tool.image!.base64, displayName: tool.reference.attachmentId } })) } : {}) } };
        });
        body.contents.push({ role: 'user', parts: [...responses, ...(!nativeImages ? turn.results.flatMap(result => imageParts(result.callId)) : [])] });
      }
    }
  }
  const appendUser = (text: string) => {
    if (format === 'gemini_native') body.contents.push({ role: 'user', parts: [{ text }] });
    else if (format === 'openai_responses') body.input.push({ role: 'user', content: text });
    else (format === 'dashscope_native' ? body.input.messages : body.messages).push({ role: 'user', content: text });
  };
  if (supplements.length) appendUser('用户在本次执行过程中给出的补充要求：\n' + supplements.map(item => item.content).join('\n'));
  // The rejected assistant bytes remain unchanged above. Give the author the
  // current host result after that proposal, including across provider formats.
  if (hostValidationFeedback) appendUser(JSON.stringify({ hostValidationFeedback: {
    ...hostValidationFeedback, trust: 'host_validation_data_not_new_authorization' } }));
  init.body = JSON.stringify(body);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const advertisedLength = Number(response.headers.get('content-length'));
  if (advertisedLength > RESPONSE_LIMIT) {
    void response.body?.cancel().catch(() => undefined);
    throw new CompanionModelError('INVALID_RESPONSE', '模型返回内容过大，请重试。');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CompanionModelError('INVALID_RESPONSE', '模型没有返回消息内容。');
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_LIMIT) throw new CompanionModelError('INVALID_RESPONSE', '模型返回内容过大，请重试。');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); }
    catch { throw new CompanionModelError('INVALID_RESPONSE', '模型接口返回了无法读取的内容，请检查接口格式。'); }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

function extractProviderText(format: AiApiFormat, body: unknown, allowToolOnly = false): string {
  const record = asRecord(body);
  if (record.error || record.code && !record.output && !record.candidates && !record.content && !record.choices) {
    const capacity = companionContextCapacityError(body); if (capacity) throw capacity;
    throw new CompanionModelError('INVALID_RESPONSE', '模型接口返回错误，请检查接口格式和模型名称。');
  }
  if (format === 'openai_chat' || format === 'dashscope_native') {
    const root = format === 'dashscope_native' ? asRecord(record.output) : record;
    const choice = asRecord(asArray(root.choices)[0]);
    if (choice.finish_reason === 'length') throw new CompanionModelError('INVALID_RESPONSE', '模型回复被截断，请重试。');
    if (choice.finish_reason === 'content_filter') throw new CompanionModelError('REFUSED', '模型未能回复这条消息。');
    const message = asRecord(choice.message);
    if (message.refusal) throw new CompanionModelError('REFUSED', '模型未能回复这条消息。');
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return textParts(message.content, false);
  } else if (format === 'openai_responses') {
    if (record.status === 'incomplete' || record.status === 'failed') throw new CompanionModelError('INVALID_RESPONSE', '模型回复未完成，请重试。');
    if (typeof record.output_text === 'string') return record.output_text;
    const messages = asArray(record.output).map(asRecord).filter((item) => item.type === 'message');
    const parts = messages.flatMap((item) => asArray(item.content));
    if (parts.map(asRecord).some((item) => item.type === 'refusal')) throw new CompanionModelError('REFUSED', '模型未能回复这条消息。');
    return textParts(parts, true);
  } else if (format === 'anthropic') {
    if (record.stop_reason === 'max_tokens') throw new CompanionModelError('INVALID_RESPONSE', '模型回复被截断，请重试。');
    if (record.stop_reason === 'refusal') throw new CompanionModelError('REFUSED', '模型未能回复这条消息。');
    return textParts(asArray(record.content), true);
  } else if (format === 'gemini_native') {
    const candidate = asRecord(asArray(record.candidates)[0]);
    if (asRecord(record.promptFeedback).blockReason || ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(String(candidate.finishReason))) {
      throw new CompanionModelError('REFUSED', '模型未能回复这条消息。');
    }
    if (candidate.finishReason === 'MAX_TOKENS') throw new CompanionModelError('INVALID_RESPONSE', '模型回复被截断，请重试。');
    return textParts(asArray(asRecord(candidate.content).parts), false);
  }
  if (allowToolOnly) return '';
  throw new CompanionModelError('INVALID_RESPONSE', '模型接口没有返回可读取的聊天消息。');
}

function textParts(parts: unknown[], requireTextType: boolean): string {
  return parts.map(asRecord).filter((part) => part.thought !== true
    && !['thinking', 'reasoning', 'analysis', 'refusal'].includes(String(part.type))
    && (!requireTextType || part.type === 'text' || part.type === 'output_text'))
    .map((part) => typeof part.text === 'string' ? part.text : '').join('');
}

export function parseCompanionReply(raw: string, allowSilence = false): CompanionReply {
  if (raw.length > 65_536) throw new CompanionModelError('INVALID_RESPONSE', '模型回复过长，请重试。');
  let text = raw.trim().replace(/<(think|analysis|reasoning)>[\s\S]*?<\/\1>/giu, '').trim();
  if (/<(?:think|analysis|reasoning)>/iu.test(text)) throw new CompanionModelError('INVALID_RESPONSE', '模型没有返回最终聊天消息，请重试。');
  text = text.replace(/^```(?:json)?\s*\n?/iu, '').replace(/\n?```\s*$/u, '').trim();
  if (!text) throw new CompanionModelError('INVALID_RESPONSE', '模型没有返回聊天消息或明确的不发言决定，请重试。');
  if (/^\[PASS\]$/iu.test(text)) return { ...validateReplyText('', allowSilence), memories: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch {
    if (/^[{[]/u.test(text)) throw new CompanionModelError('INVALID_RESPONSE', '模型返回了不完整的聊天消息，请重试。');
    return validateReplyText(text, allowSilence);
  }
  const reply = asRecord(parsed);
  if (typeof reply.text !== 'string') throw new CompanionModelError('INVALID_RESPONSE', '模型没有返回聊天文本，请重试。');
  const replyText = stripCompanionThoughts(reply.text);
  const result = validateReplyText(/^\[PASS\]$/iu.test(replyText) ? '' : replyText, allowSilence);
  result.memories = result.text ? [...new Set(asArray(reply.memories).filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim()).filter((value) => value.length > 0 && value.length <= 1_000))].slice(0, 3) : [];
  if (result.text && typeof reply.topic === 'string' && reply.topic.trim()) result.topic = reply.topic.trim().slice(0, 100);
  return result;
}

function parseLoopText(raw: string, hasCalls: boolean): CompanionReply {
  const text = stripCompanionThoughts(raw);
  if (hasCalls && /^(?:\{|\[|```(?:json)?\s*)$/u.test(text)) return { text: '' };
  let value: unknown;
  try { value = JSON.parse(text.replace(/^```json\s*/u, '').replace(/\s*```$/u, '')); } catch { /* Ordinary Markdown is the normal loop output. */ }
  if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') return parseCompanionReply(text, true);
  return validateReplyText(text === '[PASS]' ? '' : text, true);
}

function stripCompanionThoughts(raw: string): string {
  const text = raw.trim().replace(/<(think|analysis|reasoning)>[\s\S]*?<\/\1>/giu, '').trim();
  if (/<(?:think|analysis|reasoning)>/iu.test(text)) throw new CompanionModelError('INVALID_RESPONSE', '模型只返回了未完成的内部内容。');
  return text;
}

function validateReplyText(text: string, allowSilence: boolean): CompanionReply {
  if ((!text && !allowSilence) || text.length > REPLY_LIMIT) throw new CompanionModelError('INVALID_RESPONSE', '模型没有返回有效的聊天文本，请重试。');
  return { text };
}

function httpError(status: number, body?: unknown): CompanionModelError {
  if (status === 401 || status === 403) return new CompanionModelError('AUTH', '模型认证失败，请检查 API 密钥和访问权限。');
  if (status === 429 || status === 402) return new CompanionModelError('RATE_LIMIT', '模型服务暂时受限，请检查额度或稍后重试。');
  if (status >= 500) return new CompanionModelError('NETWORK', '模型服务暂时不可用，请稍后重试。');
  const provider = asRecord(asRecord(body).error);
  // Keep only machine-readable field names/codes. Provider prose may contain
  // request content or credentials and is never copied into durable errors.
  const safe = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.[\]-]{1,160}$/u.test(value) ? value : undefined;
  const diagnostic = { httpStatus: status, providerCode: safe(provider.code), providerType: safe(provider.type), parameter: safe(provider.param) };
  const schemaRejected = [400, 422].includes(status) && typeof provider.message === 'string'
    && /(?:schema|input_schema|parameters)/iu.test(provider.message) && /(?:invalid|unsupported|not supported|anyOf|oneOf|allOf|must|not allowed)/iu.test(provider.message);
  if (schemaRejected) return new CompanionModelError('CONFIG', `模型接口拒绝了工具参数定义（HTTP ${status}）${diagnostic.parameter ? '，参数：' + diagnostic.parameter : ''}。`, JSON.stringify(diagnostic));
  return new CompanionModelError('INVALID_RESPONSE', `模型接口请求失败（HTTP ${status}），请检查接口格式和模型名称。`);
}
/** Act only on an explicit provider input/context rejection. Output limits,
 * account quotas and arbitrary HTTP 400/413 failures are different failures.
 * Provider prose is inspected in memory and never exposed with credentials. */
export function companionContextCapacityError(body: unknown): CompanionModelError | undefined {
  return companionProviderContextCapacity(body) ? new CompanionModelError('CONTEXT_CAPACITY',
    '模型服务明确拒绝了本次输入的上下文容量。可受控压缩较早的工作历史或话题原文后重试；完整人格、当前目标和未完成工具调用必须保留。') : undefined;
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
