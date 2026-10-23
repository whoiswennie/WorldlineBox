import {
  AI_API_FORMATS, resolveAnthropicMessagesUrl, resolveDashScopeMultimodalGenerationUrl,
  resolveGeminiGenerateContentUrl, resolveOpenAiChatCompletionsUrl, resolveOpenAiResponsesUrl,
  type AiApiFormat,
} from '../../shared/ai-endpoints';
import type { Companion } from '../../shared/companions';
import { isDeepseekOfficialEndpoint } from '../../shared/llm';
import { buildCompanionContext, refreshCompanionContextClock, refreshCompanionRuntimeStateContext, refreshCompanionCharacterDevelopmentContext, refreshCompanionIdentityContext, refreshCompanionFilesContext, type CompanionReplyInput } from './context';
import { companionPerceivedToolTurns } from './world-perception-context';
import { companionStateToolTurns } from './state-context';
import { COMPANION_DSH_CAPABILITY_TOOL, COMPANION_MEMORY_CAPABILITY_TOOL, COMPANION_WORLD_CAPABILITY_TOOL } from '../../shared/companion-capability-tools';
import { assembleCompanionInvocation } from './invocation-context';
import { companionRepeatedObservation, projectCompanionToolHistory } from './context-tool-history';
import { companionReplyIdentityIssue } from './reply-identity';
import type { CompanionLoopCall, CompanionLoopTurn } from '../../shared/companion-loop';
import { CompanionProviderStreamError, readCompanionProviderStream } from './provider-stream';
import type { CompanionVisualInput } from '../../shared/companion-public-profile';
import { companionUnsupportedImageError, prepareCompanionVisualContext, refreshCompanionPublicProfileContext } from './public-profile-context';
import { type ToolVisualInput } from '../../shared/companion-file-tool';
import { companionToolResultText, prepareCompanionLoopVisuals, type CompanionToolImageDelivery } from './tool-image-context';

export type { CompanionReplyInput } from './context';
export interface CompanionModelConfig {
  apiFormat: AiApiFormat;
  model: string;
  baseUrl?: string;
  apiKey: string;
}
export interface CompanionReply { text: string; memories?: string[]; topic?: string; turn?: CompanionLoopTurn }
export interface CompanionNativeTool { name: string; description: string; parameters: object }
export interface CompanionModelOptions { fetchFn?: typeof fetch; timeoutMs?: number; loop?: boolean; context?: ReturnType<typeof buildCompanionContext>; turns?: readonly CompanionLoopTurn[]; supplements?: readonly { id: string; content: string }[];
  tools?: readonly CompanionNativeTool[];
  projectContext?: (context: { system: string; user: string }) => { system: string; user: string };
  identityCorrection?: string;
  deliveryCorrection?: string;
  /** In-memory image payloads for structured peer/world reasoning; never persisted. */
  visualInputs?: readonly CompanionVisualInput[];
  /** Authorized immutable tool snapshots, reloaded for the current inference only. */
  toolImages?: readonly ToolVisualInput[];
  /** Current turn's cumulative visible text, emitted only from real SSE events. */
  onTextDelta?: (text: string) => void }
export type CompanionModelErrorCode = 'CONFIG' | 'AUTH' | 'RATE_LIMIT' | 'NETWORK' | 'TIMEOUT' | 'CANCELLED' | 'INVALID_RESPONSE' | 'REFUSED' | 'IDENTITY';
export class CompanionModelError extends Error {
  constructor(readonly code: CompanionModelErrorCode, message: string) {
    super(message);
    this.name = 'CompanionModelError';
  }
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
  if (!model || model.length > 160) throw new CompanionModelError('CONFIG', '请在模型设置中配置有效的聊天模型。');
  const assembledContext = refreshCompanionContextClock(refreshCompanionFilesContext(refreshCompanionPublicProfileContext(refreshCompanionIdentityContext(refreshCompanionCharacterDevelopmentContext(refreshCompanionRuntimeStateContext(
    options.context ?? buildCompanionContext({ ...input, agentLoop: options.loop }), input.runtimeState, input.companion.id, input.conversation), input.characterDevelopment, input.companion.id, input.conversation.id), input),
  { companionId: input.companion.id, memberIds: input.conversation.memberIds, publicProfileIds: input.publicProfileIds, audience: input.audience, publicProfiles: input.publicProfiles }), input.fileInputs), input.world, input.companion.id);
  const context = options.projectContext?.(assembledContext) ?? assembledContext;
  if (options.identityCorrection) context.system += '\n【宿主身份纠错】\n' + options.identityCorrection;
  if (options.deliveryCorrection) context.system += '\n【宿主交付事实核验】\n' + options.deliveryCorrection;
  const turns = projectCompanionToolHistory(companionStateToolTurns(companionPerceivedToolTurns(options.turns ?? [], input.companion.id, input.world)));
  const repeatedObservation = companionRepeatedObservation(options.turns ?? []);
  if (repeatedObservation) context.system += '\n【宿主进展检查】\n' + JSON.stringify(repeatedObservation)
    + '：最近多次查询已返回相同世界资料，完整结果仍在原生tool回执中。查询不是联系、邀约或建群。请使用已有真实标识执行当前目标的下一步，或说明实际阻碍后结束；不要继续用同样查询搭配“我先看看”来代替行动。新证据与真实行动会重新计算此提示。这不是任务轮数上限，也不改变你的身份、目标或权限。';
  const controller = new AbortController();
  let rejectAbort: (error: CompanionModelError) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = () => {
    controller.abort();
    rejectAbort(new CompanionModelError('CANCELLED', '这次回复已取消。'));
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const expire = () => {
    controller.abort();
    rejectAbort(new CompanionModelError('TIMEOUT', '伙伴回复超时，请稍后重试。'));
  };
  const idleMs = Math.max(1, Math.min(options.timeoutMs ?? 45_000, 120_000));
  let timer = setTimeout(expire, idleMs), streamDeadline: ReturnType<typeof setTimeout> | undefined;
  const streamActivity = () => { if (!controller.signal.aborted) { clearTimeout(timer); timer = setTimeout(expire, idleMs); } };
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  try {
    if (signal?.aborted) cancel();
    const operation = async (): Promise<CompanionReply> => {
      const response = await fetchCompanionProvider(controller.signal, fetchFn, rejected => {
        const current = prepareCompanionLoopVisuals(context, input.visualInputs ?? options.visualInputs, options.loop ? options.toolImages : undefined, options.loop ? turns : [], config, rejected);
        const request = providerRequest({ ...config, model }, current.context, controller.signal, options.loop === true, options.loop === true, true, current.images, true, options.tools);
        if (options.loop) appendLoopHistory(request, config, turns, options.supplements ?? [], current.tools);
        return { request, hasImages: current.images.length > 0 || current.tools.some(tool => !!tool.image) };
      });
      let body: unknown;
      if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        streamActivity(); streamDeadline = setTimeout(expire, 10 * 60_000);
        body = await readCompanionProviderStream(response, config.apiFormat, { signal: controller.signal,
          onText: text => { if (!controller.signal.aborted) options.onTextDelta?.(text); }, onActivity: streamActivity });
      } else body = await readBoundedJson(response);
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
      const identityIssue = companionReplyIdentityIssue(result.text, input);
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
    return await Promise.race([operation(), aborted]);
  } catch (error) {
    if (error instanceof CompanionModelError) throw error;
    if (error instanceof CompanionProviderStreamError) throw new CompanionModelError(error.code, error.message);
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
  options: Pick<CompanionModelOptions, 'fetchFn' | 'timeoutMs' | 'visualInputs'> = {},
): Promise<unknown> {
  const raw = await generateCompanionContent(context, config, signal, options, true);
  try { return JSON.parse(raw.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '').trim()); }
  catch { throw new CompanionModelError('INVALID_RESPONSE', '记忆模型返回的结构无效，稍后会重新处理。'); }
}

/** VCP timeline prompts retain their plain text output across every configured API format. */
export async function generateCompanionText(
  context: { system: string; user: string },
  config: CompanionModelConfig,
  signal?: AbortSignal,
  options: Pick<CompanionModelOptions, 'fetchFn' | 'timeoutMs' | 'visualInputs'> = {},
): Promise<string> {
  return generateCompanionContent(context, config, signal, options, false);
}
async function generateCompanionContent(
  context: { system: string; user: string }, config: CompanionModelConfig, signal: AbortSignal | undefined,
  options: Pick<CompanionModelOptions, 'fetchFn' | 'timeoutMs' | 'visualInputs'>, structured: boolean,
): Promise<string> {
  if (signal?.aborted) throw new CompanionModelError('CANCELLED', '记忆处理已取消。');
  validateConfig(config);
  const model = config.model.trim();
  if (!model || model.length > 160) throw new CompanionModelError('CONFIG', '请在模型设置中配置有效的聊天模型。');
  const controller = new AbortController();
  let rejectAbort: (error: CompanionModelError) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = () => { controller.abort(); rejectAbort(new CompanionModelError('CANCELLED', '记忆处理已取消。')); };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { controller.abort(); rejectAbort(new CompanionModelError('TIMEOUT', '记忆处理超时，请稍后重试。')); }, Math.max(1, Math.min(options.timeoutMs ?? 45_000, 120_000)));
  try {
    if (signal?.aborted) cancel();
    const operation = async () => {
      const response = await fetchCompanionProvider(controller.signal, options.fetchFn ?? globalThis.fetch.bind(globalThis), rejected => {
        const current = prepareCompanionVisualContext(context, options.visualInputs, config, rejected);
        return { request: providerRequest({ ...config, model }, current.context, controller.signal, false, false, false, current.images, structured), hasImages: current.images.length > 0 };
      });
      const envelope = await readBoundedJson(response);
      if (extractLoopCalls(config.apiFormat, envelope).length) throw new CompanionModelError('INVALID_RESPONSE', '记忆模型不应调用工具。');
      const raw = extractProviderText(config.apiFormat, envelope).trim();
      return stripCompanionThoughts(raw);
    };
    return await Promise.race([operation(), aborted]);
  } catch (error) {
    if (error instanceof CompanionModelError) throw error;
    throw new CompanionModelError('NETWORK', '无法连接聊天模型，请检查网络和模型设置。');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

function validateConfig(config: CompanionModelConfig): void {
  if (!(AI_API_FORMATS as readonly string[]).includes(config.apiFormat)) {
    throw new CompanionModelError('CONFIG', '当前模型接口格式不受支持，请重新选择。');
  }
  if (!config.apiKey.trim()) throw new CompanionModelError('CONFIG', '请先在模型设置中配置 API 密钥。');
  if (!config.baseUrl?.trim()) return;
  try {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    throw new CompanionModelError('CONFIG', '模型接口地址无效，请填写不含凭据和查询参数的 HTTP 地址。');
  }
}

async function fetchCompanionProvider(signal: AbortSignal, fetchFn: typeof fetch,
  build: (rejected: boolean) => { request: Parameters<typeof fetch>; hasImages: boolean }): Promise<Response> {
  const current = build(false);
  let response = await fetchFn(...current.request);
  if (!response.ok && current.hasImages && [400, 415].includes(response.status)) {
    const status = response.status;
    let error: unknown; try { error = await readBoundedJson(response); } catch { throw httpError(status); }
    if (!companionUnsupportedImageError(error)) throw httpError(status);
    if (signal.aborted) throw new CompanionModelError('CANCELLED', '这次模型请求已取消。');
    response = await fetchFn(...build(true).request);
  }
  if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw httpError(response.status); }
  return response;
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
function providerRequest(config: CompanionModelConfig, context: { system: string; user: string }, signal: AbortSignal, enableDsh = true, enableMemory = false, stream = false, images: readonly CompanionVisualInput[] = [], structured = true, suppliedTools?: readonly CompanionNativeTool[]): Parameters<typeof fetch> {
  const deepseek = isDeepseekOfficialEndpoint(config.baseUrl ?? '');
  const tools = suppliedTools ?? [...(enableDsh ? [COMPANION_DSH_CAPABILITY_TOOL] : []), ...(enableMemory ? [COMPANION_MEMORY_CAPABILITY_TOOL, COMPANION_WORLD_CAPABILITY_TOOL] : [])];
  const bearerHeaders = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
  const imageMessage = images.length ? [{ role: 'user', content: companionImageParts(config.apiFormat, images) }] : [];
  const init = (headers: Record<string, string>, body: unknown): RequestInit => ({ method: 'POST', headers: { ...headers, ...(stream ? { Accept: 'text/event-stream' } : {}) },
    signal, redirect: 'error', body: JSON.stringify(body) });
  switch (config.apiFormat) {
    case 'openai_chat':
      return [resolveOpenAiChatCompletionsUrl(config.baseUrl), init(bearerHeaders, {
        model: config.model, max_tokens: 8_192, stream,
        ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })), parallel_tool_calls: true } : {}),
        ...(deepseek ? { thinking: { type: 'disabled' }, ...(structured ? { response_format: { type: 'json_object' } } : {}) } : {}),
        messages: [{ role: 'system', content: context.system }, { role: 'user', content: context.user }, ...imageMessage],
      })];
    case 'openai_responses':
      return [resolveOpenAiResponsesUrl(config.baseUrl), init(bearerHeaders, {
        model: config.model, max_output_tokens: 8_192, stream,
        ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', ...tool, strict: false })), parallel_tool_calls: true } : {}),
        ...(deepseek ? { reasoning: { effort: 'none' }, ...(structured ? { text: { format: { type: 'json_object' } } } : {}) } : {}),
        instructions: context.system, input: [{ role: 'user', content: context.user }, ...imageMessage],
      })];
    case 'anthropic':
      return [resolveAnthropicMessagesUrl(config.baseUrl), init({ 'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, {
        model: config.model, max_tokens: 8_192, stream, system: context.system,
        ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
        ...(deepseek ? { thinking: { type: 'disabled' } } : {}),
        messages: [{ role: 'user', content: context.user }, ...imageMessage],
      })];
    case 'gemini_native':
      return [resolveGeminiGenerateContentUrl(config.model, config.baseUrl).replace(/:generateContent$/u, stream ? ':streamGenerateContent?alt=sse' : ':generateContent'), init({ 'x-goog-api-key': config.apiKey,
        'Content-Type': 'application/json' }, {
        system_instruction: { parts: [{ text: context.system }] },
        ...(tools.length ? { tools: [{ function_declarations: tools.map(tool => ({ name: tool.name,
          description: tool.description, parametersJsonSchema: tool.parameters })) }] } : {}),
        contents: [{ role: 'user', parts: [{ text: context.user }] }, ...(images.length ? [{ role: 'user', parts: companionImageParts(config.apiFormat, images) }] : [])],
        generationConfig: { maxOutputTokens: 8_192, ...(structured ? { responseMimeType: 'application/json' } : {}) },
      })];
    case 'dashscope_native':
      return [resolveDashScopeMultimodalGenerationUrl(config.baseUrl), init({ ...bearerHeaders, ...(stream ? { 'X-DashScope-SSE': 'enable' } : {}) }, {
        model: config.model, input: { messages: [{ role: 'system', content: [{ text: context.system }] },
          { role: 'user', content: [{ text: context.user }] }, ...imageMessage] },
        parameters: { result_format: 'message', max_tokens: 8_192, enable_thinking: false, ...(structured ? { response_format: { type: 'json_object' } } : {}),
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
function appendLoopHistory(request: Parameters<typeof fetch>, config: CompanionModelConfig, turns: readonly CompanionLoopTurn[], supplements: readonly { id: string; content: string }[], tools: readonly CompanionToolImageDelivery[]): void {
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
  if (supplements.length) {
    const text = '用户在本次执行过程中给出的补充要求：\n' + supplements.map(item => item.content).join('\n');
    if (format === 'gemini_native') body.contents.push({ role: 'user', parts: [{ text }] });
    else if (format === 'openai_responses') body.input.push({ role: 'user', content: text });
    else (format === 'dashscope_native' ? body.input.messages : body.messages).push({ role: 'user', content: text });
  }
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

function httpError(status: number): CompanionModelError {
  if (status === 401 || status === 403) return new CompanionModelError('AUTH', '模型认证失败，请检查 API 密钥和访问权限。');
  if (status === 429 || status === 402) return new CompanionModelError('RATE_LIMIT', '模型服务暂时受限，请检查额度或稍后重试。');
  if (status >= 500) return new CompanionModelError('NETWORK', '模型服务暂时不可用，请稍后重试。');
  return new CompanionModelError('INVALID_RESPONSE', `模型接口请求失败（HTTP ${status}），请检查接口格式和模型名称。`);
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
