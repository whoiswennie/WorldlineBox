import type { AiApiFormat } from '../../shared/ai-endpoints';
import type { CompanionModelUsageCurrent, CompanionReportedUsage } from '../../shared/companion-model-usage';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
/** Native usage is cumulative per HTTP attempt, including partial SSE usage.
 * Cache misses are not cache writes; absent buckets stay unknown. */
export function companionProviderUsage(format: AiApiFormat, value: unknown): CompanionReportedUsage | undefined {
  const root = record(value), response = record(root.response), message = record(root.message);
  const usage = record(format === 'gemini_native' ? root.usageMetadata : root.usage ?? response.usage ?? message.usage);
  if (!Object.keys(usage).length) return;
  const result: CompanionReportedUsage = {};
  const assign = (key: keyof CompanionReportedUsage, value: unknown) => { const n = count(value); if (n !== undefined) result[key] = n; };
  if (format === 'openai_chat') {
    assign('inputTokens', usage.prompt_tokens); assign('outputTokens', usage.completion_tokens); assign('totalTokens', usage.total_tokens);
    assign('cacheReadTokens', record(usage.prompt_tokens_details).cached_tokens ?? usage.prompt_cache_hit_tokens);
    assign('reasoningTokens', record(usage.completion_tokens_details).reasoning_tokens);
  } else if (format === 'anthropic') {
    const input = count(usage.input_tokens), read = count(usage.cache_read_input_tokens), write = count(usage.cache_creation_input_tokens);
    if (input !== undefined && Number.isSafeInteger(input + (read ?? 0) + (write ?? 0))) result.inputTokens = input + (read ?? 0) + (write ?? 0);
    assign('outputTokens', usage.output_tokens); assign('cacheReadTokens', read); assign('cacheWriteTokens', write);
  } else if (format === 'gemini_native') {
    assign('inputTokens', usage.promptTokenCount); assign('outputTokens', usage.candidatesTokenCount); assign('totalTokens', usage.totalTokenCount);
    assign('cacheReadTokens', usage.cachedContentTokenCount); assign('reasoningTokens', usage.thoughtsTokenCount);
    const thoughts = count(usage.thoughtsTokenCount);
    if (result.outputTokens !== undefined && thoughts !== undefined) {
      const output = result.outputTokens + thoughts; if (Number.isSafeInteger(output)) result.outputTokens = output; else delete result.outputTokens;
    }
  } else {
    assign('inputTokens', usage.input_tokens); assign('outputTokens', usage.output_tokens); assign('totalTokens', usage.total_tokens);
    assign('cacheReadTokens', record(usage.input_tokens_details).cached_tokens ?? usage.cached_tokens);
    assign('reasoningTokens', record(usage.output_tokens_details).reasoning_tokens);
  }
  return Object.keys(result).length ? result : undefined;
}
export function mergeCompanionProviderUsage(previous: CompanionReportedUsage | undefined, next: CompanionReportedUsage): CompanionReportedUsage {
  const result = { ...previous, ...next };
  if (next.totalTokens === undefined && result.inputTokens !== undefined && result.outputTokens !== undefined) {
    const total = result.inputTokens + result.outputTokens; if (Number.isSafeInteger(total)) result.totalTokens = total; else delete result.totalTokens;
  }
  return result;
}

/** Counts the text actually projected to the provider, never raw host proof or
 * base64 image bytes. This explicit heuristic is not the model's tokenizer. */
export function estimateCompanionProviderInput(format: AiApiFormat, body: unknown): CompanionModelUsageCurrent['estimate'] {
  const root = record(body), buckets = { system: 0, dialogue: 0, toolDefinitions: 0, toolHistory: 0, other: 0 };
  let hasUnmeteredImages = false;
  const text = (value: unknown): string => {
    if (typeof value === 'string') { if (/^data:(?:image|audio|video)\//u.test(value)) { hasUnmeteredImages = true; return ''; } return value; }
    if (Array.isArray(value)) return value.map(text).join('\n');
    if (value && typeof value === 'object') {
      const item = record(value);
      if (['image_url', 'input_image', 'image', 'input_audio'].includes(String(item.type)) || item.inlineData || item.fileData || item.image) { hasUnmeteredImages = true; return ''; }
      return Object.entries(item).map(([key, value]) => key + ':' + text(value)).join('\n');
    }
    return '';
  };
  const measure = (value: unknown) => Math.ceil(new TextEncoder().encode(text(value)).length / 3);
  const messages = format === 'openai_responses' ? root.input : format === 'gemini_native' ? root.contents : format === 'dashscope_native' ? record(root.input).messages : root.messages;
  buckets.system = measure(root.instructions ?? root.system ?? root.system_instruction);
  for (const message of Array.isArray(messages) ? messages : []) {
    const item = record(message), content = item.content ?? item.parts ?? item;
    if (item.role === 'system' || item.role === 'developer') buckets.system += measure(content);
    else if (item.role === 'tool' || item.tool_calls || ['function_call', 'function_call_output'].includes(String(item.type))
      || Array.isArray(content) && content.some(part => ['tool_use', 'tool_result'].includes(String(record(part).type)) || record(part).functionCall || record(part).functionResponse)) buckets.toolHistory += measure(item);
    else buckets.dialogue += measure(content);
  }
  buckets.toolDefinitions = measure(root.tools ?? record(root.parameters).tools);
  return { inputTokens: Object.values(buckets).reduce((sum, value) => sum + value, 0), method: 'utf8_bytes_div_3', breakdown: buckets, hasUnmeteredImages };
}
