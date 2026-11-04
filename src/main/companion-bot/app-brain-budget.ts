import { deepseekStructuredRequestDefaults } from '../../shared/llm';
import type { BotDshModel, BotDshTool } from './dsh-brain';
import { APP_TOOL_RESULT_READER } from './app-brain-tool-view';
import { resolveBotModelLimits } from './model-limits';

export interface AppRequestMessage { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }
/** One budget calculation for the prepared envelope and the actual wire request. */
export function appBrainRequest(model: BotDshModel, system: string, messages: AppRequestMessage[], tools: readonly BotDshTool[], allowTools: boolean) {
  const limits = resolveBotModelLimits(model);
  const maxTokens = allowTools ? limits.maxTokens : Math.min(2048, limits.maxTokens, Math.max(1, Math.floor(limits.window / 8)));
  const catalog = allowTools && tools.length ? [...tools.filter(tool => tool.name !== APP_TOOL_RESULT_READER.name), APP_TOOL_RESULT_READER] : [];
  return { model: model.model, stream: true, max_tokens: maxTokens,
    ...deepseekStructuredRequestDefaults(model.baseUrl, model.model), messages: [{ role: 'system', content: system }, ...messages],
    ...(catalog.length ? { tools: catalog.map(tool => ({ type: 'function', function: tool })), parallel_tool_calls: false } : {}) };
}
export function fitsAppBrainRequest(body: ReturnType<typeof appBrainRequest>, model: BotDshModel, maxContextChars?: number): boolean {
  const serialized = JSON.stringify(body);
  return Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0
    && (maxContextChars === undefined || serialized.length <= Math.max(512, maxContextChars))
    && Buffer.byteLength(serialized, 'utf8') + body.max_tokens + 256 <= resolveBotModelLimits(model).window;
}
