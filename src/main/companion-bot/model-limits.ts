import { DEFAULT_MODEL_CONTEXT_WINDOW } from '../../shared/model-budget';

/** Model capacity policy, not tokenization or a claim about compression ratios.
 * Discovery is supplied by the caller; resolving limits never calls a model. */
export interface BotModelLimitInput { model: string; baseUrl: string; contextWindow?: number; maxTokens?: number }
export interface BotModelLimits {
  window: number; maxTokens: number; maxOutputTokens?: number;
  source: 'explicit' | 'metadata' | 'official-default' | 'unknown'; sourceUrl?: string;
  contextEstimate: 'utf8-byte-upper-bound'; outputClamped: boolean;
}
const DEEPSEEK_DOC = 'https://api-docs.deepseek.com/api/list-models/';
const OPENAI_DOC = 'https://developers.openai.com/api/docs/models/gpt-6.1-sol';
const positiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function integer(objects: Record<string, unknown>[], keys: string[]): number | undefined {
  for (const object of objects) for (const key of keys) if (positiveInt(object[key])) return object[key];
  return undefined;
}
/** An endpoint URL without credentials/query data, safe for limit provenance. */
export function botModelsMetadataUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol)) throw new TypeError('Model endpoint must be HTTP(S).');
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  const base = url.pathname.replace(/\/+$/u, '').replace(/\/(?:chat\/completions|responses|models)$/u, '');
  url.pathname = `${base}/models`; return url.toString();
}
function matchingMetadata(model: string, discovered: unknown): Record<string, unknown> | undefined {
  const outer = record(discovered), rows = Array.isArray(discovered) ? discovered : Array.isArray(outer.data) ? outer.data : [outer];
  return rows.map(record).find(row => (typeof row.id === 'string' ? row.id : typeof row.model === 'string' ? row.model : row.name) === model);
}
function official(input: BotModelLimitInput): { window: number; maxOutputTokens: number; sourceUrl: string } | undefined {
  let url: URL; try { url = new URL(input.baseUrl); } catch { return; }
  // An identically named model at a proxy/local endpoint has no implied limits.
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return;
  if (url.hostname === 'api.deepseek.com' && ['deepseek-flash', 'deepseek-v4-pro'].includes(input.model))
    return { window: 1048576, maxOutputTokens: 393216, sourceUrl: DEEPSEEK_DOC };
  if (url.hostname === 'api.openai.com' && /^gpt-6\.1(?:-sol)?(?:-\d{4}-\d{2}-\d{2})?$/u.test(input.model))
    return { window: 1050000, maxOutputTokens: 128000, sourceUrl: OPENAI_DOC };
  return undefined;
}
export function resolveBotModelLimits(input: BotModelLimitInput, discovered?: unknown): BotModelLimits {
  if (typeof input.model !== 'string' || !input.model.trim()) throw new TypeError('A concrete model id is required.');
  if (input.contextWindow !== undefined && !positiveInt(input.contextWindow)) throw new TypeError('Explicit model contextWindow must be a positive safe integer.');
  if (input.maxTokens !== undefined && !positiveInt(input.maxTokens)) throw new TypeError('Explicit model maxTokens must be a positive safe integer.');
  const row = matchingMetadata(input.model, discovered), structures = row ? [row, record(row.limits), record(row.metadata), record(row.architecture)] : [];
  const metadataWindow = integer(structures, ['context_window', 'context_length', 'contextWindow', 'max_context_tokens', 'max_context_length']);
  const metadataOutput = integer(structures, ['max_output_tokens', 'max_completion_tokens', 'maxOutputTokens', 'output_token_limit']);
  const documented = official(input);
  const window = input.contextWindow ?? metadataWindow ?? documented?.window ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  const source: BotModelLimits['source'] = input.contextWindow !== undefined ? 'explicit' : metadataWindow !== undefined ? 'metadata' : documented ? 'official-default' : 'unknown';
  const maxOutputTokens = metadataOutput ?? documented?.maxOutputTokens;
  const requested = input.maxTokens ?? Math.min(4096, Math.max(1, Math.floor(window / 4)));
  const maxTokens = Math.min(requested, maxOutputTokens ?? Number.MAX_SAFE_INTEGER, Math.max(1, window - 256));
  return { window, maxTokens, ...(maxOutputTokens ? { maxOutputTokens } : {}), source,
    ...(source === 'metadata' ? { sourceUrl: botModelsMetadataUrl(input.baseUrl) } : source === 'official-default' ? { sourceUrl: documented!.sourceUrl } : {}),
    contextEstimate: 'utf8-byte-upper-bound', outputClamped: maxTokens !== requested };
}

/** Native sessions generate tool arguments and project files as well as chat.
 * Keep explicit limits authoritative and bound the default by actual capacity. */
export function resolveBotExecutionModelLimits(input: BotModelLimitInput, discovered?: unknown): BotModelLimits {
  const limits = resolveBotModelLimits(input, discovered);
  return input.maxTokens !== undefined ? limits : resolveBotModelLimits({ ...input,
    maxTokens: Math.min(16384, Math.max(1, Math.floor(limits.window / 4))) }, discovered);
}
