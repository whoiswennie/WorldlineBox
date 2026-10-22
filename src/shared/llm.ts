import type { WorldlineBoxLibraryApi } from './library-api';
import { DEFAULT_AI_MODELS, migrateLegacyProviderToApiFormat, type AiApiFormat } from './ai-endpoints';

/** Application model settings. Asset analysis consumes this same encrypted, user-level store. */
export const DEFAULT_GLOBAL_LLM_CONFIG = {
  apiFormat: 'openai_chat',
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com',
} as const;

export const DEEPSEEK_OFFICIAL_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;

/** Existing explicit providers and blank legacy URL prefixes keep their routing. */
export function resolveStoredLlmConfig(stored: { apiFormat?: unknown; provider?: unknown; model?: unknown; baseUrl?: unknown }): {
  apiFormat: AiApiFormat; model: string; baseUrl: string;
} {
  const explicit = migrateLegacyProviderToApiFormat(stored.apiFormat) ?? migrateLegacyProviderToApiFormat(stored.provider);
  const apiFormat = explicit ?? DEFAULT_GLOBAL_LLM_CONFIG.apiFormat;
  return {
    apiFormat,
    model: typeof stored.model === 'string' && stored.model.trim() ? stored.model : explicit ? DEFAULT_AI_MODELS[apiFormat] : DEFAULT_GLOBAL_LLM_CONFIG.model,
    baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : explicit ? '' : DEFAULT_GLOBAL_LLM_CONFIG.baseUrl,
  };
}

export function isDeepseekOfficialEndpoint(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'api.deepseek.com' && !url.username && !url.password; }
  catch { return false; }
}

/** Short probes and structured output need final content instead of a reasoning-only budget. */
export function deepseekStructuredRequestDefaults(baseUrl: string | undefined, model: string): Record<string, unknown> {
  return baseUrl && isDeepseekOfficialEndpoint(baseUrl) && /^deepseek-(?:flash|v4-)/.test(model)
    ? { thinking: { type: 'disabled' } } : {};
}

/** No library identity is required. Credentials never return through getConfig. */
export interface WorldlineBoxLlmApi {
  getConfig: WorldlineBoxLibraryApi['getAiConfig'];
  setConfig(input: Partial<Parameters<WorldlineBoxLibraryApi['setAiConfig']>[0]>): ReturnType<WorldlineBoxLibraryApi['setAiConfig']>;
  testConnection: WorldlineBoxLibraryApi['testAiConnection'];
  listModels: WorldlineBoxLibraryApi['listAiModels'];
}
