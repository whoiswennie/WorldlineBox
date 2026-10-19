import { resolveGeminiGenerateContentUrl } from '../../shared/ai-endpoints';
import type { CompanionModelConfig } from '../companions/model';

/** Public summaries are opt-in only for model families that document these fields.
 * Unknown compatible services keep their own defaults; no speculative parameters. */
export function captureResponseReasoning(config: CompanionModelConfig, stream: boolean): Record<string, unknown> {
  if (/^gpt-[56](?:\.\d+)?-chat(?:[-.]|$)/iu.test(config.model)) return {};
  if (stream && /^(?:o[134](?:[-.]|$)|gpt-[56](?:[-.]|$))/iu.test(config.model)) return { reasoning: { summary: 'auto' } };
  return {};
}
export function captureAnthropicThinking(config: CompanionModelConfig, stream: boolean): Record<string, unknown> {
  if (!stream) return {};
  if (/^claude-(?:(?:opus|sonnet)-4[.-][6-9]|(?:opus|sonnet|mythos|fable)-5)(?:[-.]|$)/iu.test(config.model)) return { thinking: { type: 'adaptive', display: 'summarized' } };
  if (/^claude-(?:3-7-|(?:sonnet|opus|haiku)-4(?:[-.]|$))/iu.test(config.model)) return { thinking: { type: 'enabled', budget_tokens: 1024 } };
  return {};
}
export function captureGeminiThinking(config: CompanionModelConfig, stream: boolean): Record<string, unknown> {
  return stream && /^(?:models\/)?gemini-(?:2\.5(?:[-.]|$)|[3-9](?:[-.]|$))/iu.test(config.model) ? { thinkingConfig: { includeThoughts: true } } : {};
}
export function captureGeminiAnswerUrl(config: CompanionModelConfig, stream: boolean): string {
  const url = resolveGeminiGenerateContentUrl(config.model, config.baseUrl);
  return stream ? `${url.replace(/:generateContent$/u, ':streamGenerateContent')}?alt=sse` : url;
}
export function captureDashScopeIncremental(config: CompanionModelConfig): boolean {
  if (/(?:instruct|non-thinking|coder|embedding|rerank|asr|tts|omni)/iu.test(config.model)) return false;
  return /^(?:qwen3(?:\.\d+)?-(?:plus|max|flash|vl-|\d+b|next-)|qwq(?:[-.]|$)|qvq(?:[-.]|$)|deepseek-(?:r1|v[34]|flash)(?:[-.]|$))/iu.test(config.model);
}
export function captureDashScopeStreaming(config: CompanionModelConfig, stream: boolean): Record<string, unknown> {
  if (!stream) return {};
  const incremental = captureDashScopeIncremental(config);
  return { incremental_output: incremental, ...(incremental && /^qwen3/iu.test(config.model) && !/thinking/iu.test(config.model) ? { enable_thinking: true } : {}) };
}
