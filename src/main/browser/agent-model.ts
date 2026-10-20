import { AI_API_FORMATS, resolveOpenAiChatCompletionsUrl, resolveOpenAiResponsesUrl, resolveAnthropicMessagesUrl,
  resolveGeminiGenerateContentUrl, resolveDashScopeTextGenerationUrl, resolveDashScopeMultimodalGenerationUrl, type AiApiFormat } from '../../shared/ai-endpoints';
import { deepseekStructuredRequestDefaults } from '../../shared/llm';
import type { CompanionModelConfig } from '../companions/model';
import { readCompanionProviderStream } from '../companions/provider-stream';
import { browserAgentDeclarations } from '../../shared/browser-agent-tools';

export interface BrowserAgentCall { id: string; name: string; arguments: string; thoughtSignature?: string }
export type BrowserAgentMessage = { role: 'user'; text: string } | { role: 'assistant'; text: string; calls: BrowserAgentCall[] }
  | { role: 'tool'; callId: string; name: string; text: string };
export interface BrowserAgentReply { text: string; calls: BrowserAgentCall[] }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' ? value : array(value).map(item => String(record(item).text ?? '')).join('');

export function browserAgentRequest(config: CompanionModelConfig, system: string, messages: readonly BrowserAgentMessage[], signal: AbortSignal, tools = true, outputTokens = 4096): [string, RequestInit] {
  const functions = tools ? browserAgentDeclarations : [];
  const chat = messages.map(message => message.role === 'user' ? { role: 'user', content: message.text }
    : message.role === 'tool' ? { role: 'tool', tool_call_id: message.callId, content: message.text }
      : { role: 'assistant', content: message.text || null, ...(message.calls.length ? { tool_calls: message.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) });
  const init = (headers: Record<string, string>, body: unknown): RequestInit => ({ method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers }, body: JSON.stringify(body) });
  const bearer = { Authorization: `Bearer ${config.apiKey.trim()}` };
  switch (config.apiFormat) {
    case 'openai_chat': return [resolveOpenAiChatCompletionsUrl(config.baseUrl), init(bearer, { model: config.model, stream: true, max_tokens: outputTokens,
      ...deepseekStructuredRequestDefaults(config.baseUrl, config.model), messages: [{ role: 'system', content: system }, ...chat],
      ...(functions.length ? { tools: functions.map(fn => ({ type: 'function', function: fn })), parallel_tool_calls: false } : {}) })];
    case 'openai_responses': {
      const input = messages.flatMap<Record<string, unknown>>(message => message.role === 'tool'
        ? [{ type: 'function_call_output', call_id: message.callId, output: message.text }]
        : message.role === 'user' ? [{ role: 'user', content: message.text }]
          : [...(message.text ? [{ role: 'assistant', content: message.text }] : []), ...message.calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }))]);
      return [resolveOpenAiResponsesUrl(config.baseUrl), init(bearer, { model: config.model, stream: true, store: false, max_output_tokens: outputTokens, instructions: system, input,
        ...(functions.length ? { tools: functions.map(fn => ({ type: 'function', ...fn, strict: false })), parallel_tool_calls: false } : {}) })];
    }
    case 'anthropic': {
      const converted: Array<{ role: string; content: unknown[] }> = [];
      for (const message of messages) {
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        const content = message.role === 'tool' ? [{ type: 'tool_result', tool_use_id: message.callId, content: message.text }]
          : [...(message.text ? [{ type: 'text', text: message.text }] : []), ...(message.role === 'assistant' ? message.calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) })) : [])];
        if (converted.at(-1)?.role === role) converted.at(-1)!.content.push(...content); else converted.push({ role, content });
      }
      return [resolveAnthropicMessagesUrl(config.baseUrl), init({ 'x-api-key': config.apiKey.trim(), 'anthropic-version': '2023-06-01' }, {
        model: config.model, max_tokens: outputTokens, stream: true, system, messages: converted,
        ...(functions.length ? { tools: functions.map(fn => ({ name: fn.name, description: fn.description, input_schema: fn.parameters })) } : {}) })];
    }
    case 'gemini_native': {
      const contents: Array<{ role: string; parts: unknown[] }> = [];
      for (const message of messages) {
        const role = message.role === 'assistant' ? 'model' : 'user';
        const parts = message.role === 'tool' ? [{ functionResponse: { id: message.callId, name: message.name, response: { result: message.text } } }]
          : [...(message.text ? [{ text: message.text }] : []), ...(message.role === 'assistant' ? message.calls.map(call => ({ functionCall: { id: call.id, name: call.name, args: JSON.parse(call.arguments) }, ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) })) : [])];
        if (contents.at(-1)?.role === role) contents.at(-1)!.parts.push(...parts); else contents.push({ role, parts });
      }
      return [resolveGeminiGenerateContentUrl(config.model, config.baseUrl).replace(/:generateContent$/, ':streamGenerateContent?alt=sse'), init({ 'x-goog-api-key': config.apiKey.trim() }, {
        system_instruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: outputTokens },
        ...(functions.length ? { tools: [{ function_declarations: functions.map(fn => ({ ...fn, parametersJsonSchema: fn.parameters, parameters: undefined })) }] } : {}) })];
    }
    case 'dashscope_native': {
      const multimodal = /^qwen3\.[5-9](?:[-.]|$)/iu.test(config.model) || /(?:^|[-/])(?:vl|omni|qvq)(?:[-/]|$)|vision/iu.test(config.model);
      const input = [{ role: 'system', content: system }, ...chat].map(message => multimodal
        ? { ...message, content: message.content ? [{ text: message.content }] : [] } : message);
      return [(multimodal ? resolveDashScopeMultimodalGenerationUrl : resolveDashScopeTextGenerationUrl)(config.baseUrl), init({ ...bearer, 'X-DashScope-SSE': 'enable' }, {
        model: config.model, input: { messages: input }, parameters: { result_format: 'message', incremental_output: true,
          enable_thinking: false, max_tokens: outputTokens, ...(functions.length ? { tools: functions.map(fn => ({ type: 'function', function: fn })) } : {}) } })];
    }
  }
}

export function parseBrowserAgentReply(format: AiApiFormat, value: unknown): BrowserAgentReply {
  const root = record(value); const calls: BrowserAgentCall[] = []; let output = '';
  const add = (raw: unknown, signature?: unknown) => {
    const call = record(raw); const name = call.name;
    if (typeof name !== 'string' || !name || name.length > 100) throw Error('模型返回了无效的工具名称。');
    const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.args ?? call.input ?? {});
    if (args.length > 24000 || calls.length >= 8) throw Error('模型返回了过多或过大的工具调用。');
    calls.push({ id: typeof call.id === 'string' && call.id.length <= 100 ? call.id : `browser_call_${calls.length}`, name, arguments: args,
      ...(typeof signature === 'string' && signature.length <= 65536 ? { thoughtSignature: signature } : {}) });
  };
  if (format === 'openai_chat' || format === 'dashscope_native') {
    const message = record(record(array((format === 'dashscope_native' ? record(root.output) : root).choices)[0]).message);
    output = text(message.content); for (const item of array(message.tool_calls)) { const call = record(item); add({ ...record(call.function), id: call.id }); }
  } else if (format === 'openai_responses') {
    for (const item of array(root.output).map(record)) { if (item.type === 'function_call') add({ ...item, id: item.call_id });
      else if (item.type === 'message') output += array(item.content).map(part => String(record(part).text ?? '')).join(''); }
  } else if (format === 'anthropic') {
    for (const part of array(root.content).map(record)) { if (part.type === 'tool_use') add(part); else if (part.type === 'text') output += String(part.text ?? ''); }
  } else {
    for (const part of array(record(record(array(root.candidates)[0]).content).parts).map(record)) {
      if (part.functionCall) add(part.functionCall, part.thoughtSignature); else if (part.thought !== true) output += String(part.text ?? '');
    }
  }
  if (new Set(calls.map(call => call.id)).size !== calls.length || output.length > 24000 || !output.trim() && !calls.length) throw Error('模型回复为空、过长或包含重复工具调用。');
  return { text: output, calls };
}

export async function generateBrowserAgentReply(input: { config: CompanionModelConfig; system: string; messages: readonly BrowserAgentMessage[];
  signal: AbortSignal; tools?: boolean; onText?(text: string): void; fetchFn?: typeof fetch; outputTokens?: number }): Promise<BrowserAgentReply> {
  const config = input.config;
  if (!AI_API_FORMATS.includes(config.apiFormat) || !config.apiKey.trim() || /[\r\n]/.test(config.apiKey) || !config.model.trim()) throw Error('请先在全局模型设置中配置有效的模型和密钥。');
  const controller = new AbortController(); const cancel = () => controller.abort(); input.signal.addEventListener('abort', cancel, { once: true });
  if (input.signal.aborted) controller.abort();
  const timer = setTimeout(cancel, 90000); timer.unref();
  try {
    controller.signal.throwIfAborted();
    const response = await (input.fetchFn ?? fetch)(...browserAgentRequest(config, input.system, input.messages, controller.signal, input.tools, input.outputTokens));
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw Error([401, 403].includes(response.status) ? '全局模型鉴权失败，请检查模型设置。'
      : response.status === 429 ? '全局模型请求频率受限，请稍后再试。' : `全局模型调用失败（HTTP ${response.status}）。`); }
    let body: unknown;
    if (response.headers.get('content-type')?.includes('application/json')) {
      const reader = response.body?.getReader(); if (!reader) throw Error('模型返回了空响应。');
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 512 * 1024) throw Error('模型返回内容过大。'); chunks.push(next.value); }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    } else body = await readCompanionProviderStream(response, config.apiFormat, { signal: controller.signal, onText: input.onText });
    return parseBrowserAgentReply(config.apiFormat, body);
  } catch (error) {
    if (input.signal.aborted) throw Error('会话已停止。', { cause: error });
    if (controller.signal.aborted) throw Error('模型响应超时，请重试。', { cause: error });
    if (error instanceof Error && !error.message.includes(config.apiKey)) throw error;
    throw Error('模型连接失败，请检查全局模型与网络设置。', { cause: error });
  } finally { clearTimeout(timer); input.signal.removeEventListener('abort', cancel); }
}
