import {
  AI_API_FORMATS, resolveAnthropicMessagesUrl, resolveDashScopeMultimodalGenerationUrl,
  resolveGeminiGenerateContentUrl, resolveOpenAiChatCompletionsUrl, resolveOpenAiResponsesUrl,
  type AiApiFormat,
} from '../../shared/ai-endpoints';
import type { Companion } from '../../shared/companions';
import { isDeepseekOfficialEndpoint } from '../../shared/llm';
import { buildCompanionContext, type CompanionReplyInput } from './context';
import { COMPANION_DSH_TOOL, companionDshArgumentsSchema } from '../../shared/companion-dsh-tool';

export type { CompanionReplyInput } from './context';
export interface CompanionModelConfig {
  apiFormat: AiApiFormat;
  model: string;
  baseUrl?: string;
  apiKey: string;
}
export interface CompanionReply { text: string; memories?: string[]; topic?: string; action?: { title: string; prompt: string }; actions?: Array<{ title: string; prompt: string; companionId?: string }> }
export interface CompanionModelOptions { fetchFn?: typeof fetch; timeoutMs?: number }
export type CompanionModelErrorCode = 'CONFIG' | 'AUTH' | 'RATE_LIMIT' | 'NETWORK' | 'TIMEOUT' | 'CANCELLED' | 'INVALID_RESPONSE' | 'REFUSED';
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
  validateConfig(config);
  const model = resolveCompanionModel(input.companion, config);
  if (!model || model.length > 160) throw new CompanionModelError('CONFIG', '请在模型设置中配置有效的聊天模型。');
  const context = buildCompanionContext(input);
  const controller = new AbortController();
  let rejectAbort: (error: CompanionModelError) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = () => {
    controller.abort();
    rejectAbort(new CompanionModelError('CANCELLED', '这次回复已取消。'));
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
    rejectAbort(new CompanionModelError('TIMEOUT', '伙伴回复超时，请稍后重试。'));
  }, Math.max(1, Math.min(options.timeoutMs ?? 45_000, 120_000)));
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  try {
    if (signal?.aborted) cancel();
    const operation = async (): Promise<CompanionReply> => {
      const response = await fetchFn(...providerRequest({ ...config, model }, context, controller.signal, !input.proactive && !input.actionResult && !input.chatOnly));
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw httpError(response.status);
      }
      const body = await readBoundedJson(response);
      const calls = extractDshCalls(config.apiFormat, body);
      const raw = extractProviderText(config.apiFormat, body, calls.length > 0);
      const result = raw.trim() ? parseCompanionReply(raw, input.proactive === true || input.conversation.kind === 'group') : { text: '我来处理，进度随时可以查看。', memories: [] } as CompanionReply;
      if (calls.length) result.actions = calls;
      if (!result.text.trim() || input.proactive || input.actionResult || !input.messages.some((message) => message.conversationId === input.conversation.id && message.authorId === 'user')) {
        result.memories = [];
      }
      const latestUser = input.messages.filter(message => message.conversationId === input.conversation.id && message.authorId === 'user' && message.status === 'sent')
        .sort((a, b) => b.sequence - a.sequence)[0];
      if (!result.text.trim() || input.proactive || input.actionResult || input.chatOnly || input.activeTasks?.length && !input.taskRequest || !latestUser || !(input.taskRequest || shouldDelegateUserMessage(latestUser.content))) {
        delete result.action;
        delete result.actions;
      }
      return result;
    };
    return await Promise.race([operation(), aborted]);
  } catch (error) {
    if (error instanceof CompanionModelError) throw error;
    // Never propagate raw network errors: providers can include URLs, headers or credentials.
    throw new CompanionModelError('NETWORK', '无法连接聊天模型，请检查网络和模型设置。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
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

function providerRequest(config: CompanionModelConfig, context: { system: string; user: string }, signal: AbortSignal, enableDsh = true): Parameters<typeof fetch> {
  const deepseek = isDeepseekOfficialEndpoint(config.baseUrl ?? '');
  const bearerHeaders = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
  const init = (headers: Record<string, string>, body: unknown): RequestInit => ({ method: 'POST', headers,
    signal, redirect: 'error', body: JSON.stringify(body) });
  switch (config.apiFormat) {
    case 'openai_chat':
      return [resolveOpenAiChatCompletionsUrl(config.baseUrl), init(bearerHeaders, {
        model: config.model, max_tokens: 2_048, stream: false,
        ...(enableDsh ? { tools: [{ type: 'function', function: COMPANION_DSH_TOOL }], parallel_tool_calls: true } : {}),
        ...(deepseek ? { thinking: { type: 'disabled' }, response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'system', content: context.system }, { role: 'user', content: context.user }],
      })];
    case 'openai_responses':
      return [resolveOpenAiResponsesUrl(config.baseUrl), init(bearerHeaders, {
        model: config.model, max_output_tokens: 2_048, stream: false,
        ...(enableDsh ? { tools: [{ type: 'function', ...COMPANION_DSH_TOOL }], parallel_tool_calls: true } : {}),
        ...(deepseek ? { reasoning: { effort: 'none' }, text: { format: { type: 'json_object' } } } : {}),
        instructions: context.system, input: [{ role: 'user', content: context.user }],
      })];
    case 'anthropic':
      return [resolveAnthropicMessagesUrl(config.baseUrl), init({ 'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, {
        model: config.model, max_tokens: 2_048, system: context.system,
        ...(enableDsh ? { tools: [{ name: COMPANION_DSH_TOOL.name, description: COMPANION_DSH_TOOL.description, input_schema: COMPANION_DSH_TOOL.parameters }] } : {}),
        ...(deepseek ? { thinking: { type: 'disabled' } } : {}),
        messages: [{ role: 'user', content: context.user }],
      })];
    case 'gemini_native':
      return [resolveGeminiGenerateContentUrl(config.model, config.baseUrl), init({ 'x-goog-api-key': config.apiKey,
        'Content-Type': 'application/json' }, {
        system_instruction: { parts: [{ text: context.system }] },
        ...(enableDsh ? { tools: [{ function_declarations: [COMPANION_DSH_TOOL] }] } : {}),
        contents: [{ role: 'user', parts: [{ text: context.user }] }],
        generationConfig: { maxOutputTokens: 2_048, responseMimeType: 'application/json' },
      })];
    case 'dashscope_native':
      return [resolveDashScopeMultimodalGenerationUrl(config.baseUrl), init(bearerHeaders, {
        model: config.model, input: { messages: [{ role: 'system', content: [{ text: context.system }] },
          { role: 'user', content: [{ text: context.user }] }] },
        parameters: { result_format: 'message', max_tokens: 2_048, enable_thinking: false, response_format: { type: 'json_object' },
          ...(enableDsh ? { tools: [{ type: 'function', function: COMPANION_DSH_TOOL }] } : {}) },
      })];
  }
}

/** Accept only the single published capability across all supported provider envelopes. */
function extractDshCalls(format: AiApiFormat, body: unknown): NonNullable<CompanionReply['actions']> {
  const root = asRecord(body);
  const calls: Array<{ name: unknown; arguments: unknown }> = [];
  if (format === 'openai_chat' || format === 'dashscope_native') {
    const message = asRecord(asRecord(asArray((format === 'dashscope_native' ? asRecord(root.output) : root).choices)[0]).message);
    for (const call of asArray(message.tool_calls)) { const fn = asRecord(asRecord(call).function); calls.push({ name: fn.name, arguments: fn.arguments }); }
  } else if (format === 'openai_responses') {
    for (const call of asArray(root.output).map(asRecord).filter(item => item.type === 'function_call')) calls.push({ name: call.name, arguments: call.arguments });
  } else if (format === 'anthropic') {
    for (const call of asArray(root.content).map(asRecord).filter(item => item.type === 'tool_use')) calls.push({ name: call.name, arguments: call.input });
  } else if (format === 'gemini_native') {
    for (const part of asArray(asRecord(asRecord(asArray(root.candidates)[0]).content).parts)) {
      const call = asRecord(asRecord(part).functionCall); calls.push({ name: call.name, arguments: call.args });
    }
  }
  const tasks: NonNullable<CompanionReply['actions']> = [];
  for (const call of calls) {
    if (call.name !== 'dsh') continue;
    let args = call.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { continue; } }
    const parsed = companionDshArgumentsSchema.safeParse(args);
    if (parsed.success) tasks.push(...parsed.data.tasks);
  }
  return tasks.slice(0, 4);
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
  const replyText = reply.text.trim();
  const result = validateReplyText(/^\[PASS\]$/iu.test(replyText) ? '' : replyText, allowSilence);
  result.memories = result.text ? [...new Set(asArray(reply.memories).filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim()).filter((value) => value.length > 0 && value.length <= 1_000))].slice(0, 3) : [];
  if (result.text && typeof reply.topic === 'string' && reply.topic.trim()) result.topic = reply.topic.trim().slice(0, 100);
  if (result.text) {
    const tasks = companionDshArgumentsSchema.safeParse(reply.dsh);
    if (tasks.success) result.actions = tasks.data.tasks;
    const action = asRecord(reply.action);
    // Only an exact, bounded proposal is accepted. Unknown transport/tool fields never become executable input.
    if (Object.keys(action).every(key => key === 'title' || key === 'prompt')
      && typeof action.title === 'string' && typeof action.prompt === 'string') {
      const title = action.title.trim();
      const prompt = action.prompt.trim();
      if (title.length > 0 && title.length <= 100 && prompt.length > 0 && prompt.length <= 16_000) result.action = { title, prompt };
    }
  }
  return result;
}

/** A deliberately conservative intent gate, used with a bounded model proposal and the original user statement. */
export function shouldDelegateUserMessage(content: string): boolean {
  if (!content.trim() || content.length > 16_000) return false;
  const normalized = content.normalize('NFKC').trim();
  // Overall execution prohibitions and fictional examples take precedence over command markers.
  if (/(?:不要|(?<![识区特告])别|不用|不必|无需|不需要|不想|不希望|不准|禁止|暂不|先不|先别)[^\n，,。；;！？!?]{0,10}(?:执行|运行|操作|调用|启动)|(?:只|仅)(?:是)?(?:聊|聊天|讨论|讲解|举例)|先讨论|假设|假如|假装|打个比方|比方说|举(?:个|一个)?例子|例如|如果你(?:是|能|会)|(?:这是|这只是|作为|一段).{0,10}(?:小说|台词|故事|剧本)|角色扮演|扮演|模拟对话/iu.test(normalized)
    || /\b(?:do\s+not|don['’]t|never|no\s+need\s+to)\s+(?:\w+\s+){0,3}(?:execute|run|act|operate|call)\b|\b(?:just\s+chat|discussion\s+only|only\s+discuss|hypothetical|suppose|imagine|for\s+example|what\s+if|if\s+(?:i|you|we)|role[\s-]?play|fictional\s+dialogue|novel\s+dialogue|this\s+is\s+(?:a\s+)?(?:story|dialogue|quote))\b/iu.test(normalized)) return false;
  // A local constraint is not authorization for its forbidden verb and does not erase a separate read-only request.
  // This cleaned string is used only for the intent gate; the original user statement still reaches DSH intact.
  const instruction = normalized
    .replace(/(?:不要|(?<![识区特告])别|不用|不必|无需|不需要|不想|不希望|不准|禁止|暂不|先不|先别)[^\n，,。；;！？!?]*/gu, ' ')
    .replace(/\b(?:do\s+not|don['’]t|never|no\s+need\s+to)\b[^\n,.!?;]*/giu, ' ')
    // Quoted commands and code snippets are source material, not user authorization.
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/gu, ' ').trim();
  const explicit = /^(?:#执行(?:\s|[:：])|\/do\b)\s*[:：]?\s*(\S[\s\S]*)$/iu.exec(instruction);
  if (explicit) return true;
  if (/(?:怎么|如何|能否|是否).{0,16}(?:使用|调用|运行|执行).{0,10}(?:工具|DSH|命令)|\b(?:whether\s+you|how\s+(?:do|can|would)\s+(?:i|you)|your\s+capabilities)\b/iu.test(instruction)) return false;
  if (/(?:请|帮我|帮忙|^)[^\n。？！!?]{0,64}(?:写|续写|撰写)[^\n。？！!?]{0,24}(?:小说|故事|章节|章|剧本|文章)/u.test(instruction)) return true;
  if (/^(?:现在|当地|本地|电脑|系统)?(?:是)?(?:几点(?:钟)?|什么时间|几月几号)(?:了|啦|呀|啊|呢)?[？?。！!\s]*$/u.test(instruction)
    || /^(?:看看|看一下|看一看|查一下|查查|查下|查询)[^\n。？！!?]{0,24}(?:几点|时间|日期)/u.test(instruction)
    || /(?:请|帮我|帮忙|麻烦你|^)[^\n。？！!?]{0,16}搜(?:索|一下|下)?[^\n。？！!?]{1,}/u.test(instruction)
    || /^(?:检查|读取|查看|打开|整理|运行|执行|搜索|检索|修复|修改|备份|下载|生成|创建)[^\n。？！!?]{1,}/u.test(instruction)) return true;
  const chineseTask = '(?:查(?:找|询|阅)?(?:一下|下|一查)?|搜索|检索|调研|整理|归类|分类|重命名|备份|移动|复制|下载|转换|生成|编写|写(?:一(?:个|份|段|套)|个|份|段|套)?(?:代码|脚本|程序|测试|页面|网页|文档|报告|文件)|修改|修复|实现|调试|运行|执行|启动|检查|分析|统计|计算|制作|绘制|导出|导入|安装|卸载|删除|创建|读取|打开|发送|发邮件|回复邮件|发布|(?:查看|看一下|看一看|看看|识别|描述)[^\n。？！!?]{0,24}(?:文件|图片|图像|照片|目录|桌面|截图|这张图|那张图))';
  const chineseRequest = '(?:请(?:你)?|帮我|帮忙|麻烦(?:你)?|劳驾|替我|为我|能不能|能否|可以(?:请)?你|可不可以(?:请)?你|你能(?:帮我)?|能帮我)';
  if (new RegExp(`${chineseRequest}[^\n。？！!?]{0,48}${chineseTask}`, 'u').test(instruction)) return true;
  return /\b(?:please|could\s+you|can\s+you|would\s+you|help\s+me|i\s+need\s+you\s+to|i\s+want\s+you\s+to)\b[^\n.!?]{0,60}\b(?:search|look\s+up|research|organize|sort|write\s+(?:(?:me|a|the|some)\s+){0,2}(?:[a-z][a-z0-9+#-]*\s+)?(?:code|script|program|file|report|document|test)|code|implement|fix|debug|refactor|run|execute|check|inspect|analy[sz]e|build|create|generate|convert|download|rename|move|copy|back\s?up|export|import|install|uninstall|delete|send|reply\s+to|publish|(?:view|read|identify|describe|look\s+at)\b[^\n.!?]{0,40}\b(?:files?|images?|pictures?|photos?|folders?|desktop|screenshots?))\b/iu.test(instruction);
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
