import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import { CompanionProviderStreamError, readCompanionProviderStream } from '../../src/main/companions/provider-stream';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const JSON_LIMIT = 256 * 1024, EVENT_LIMIT = 256 * 1024;
const finishReasons = new Set(['stop', 'tool_calls', 'function_call', 'length', 'content_filter', 'end_turn', 'stop_sequence',
  'tool_use', 'max_tokens', 'pause_turn', 'refusal', 'completed', 'incomplete', 'failed', 'cancelled', 'in_progress', 'queued',
  'STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'IMAGE_SAFETY']);
const usagePaths = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
  'cache_creation_input_tokens', 'cache_read_input_tokens', 'prompt_tokens_details.cached_tokens',
  'completion_tokens_details.reasoning_tokens', 'input_tokens_details.cached_tokens', 'output_tokens_details.reasoning_tokens',
  'promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'thoughtsTokenCount', 'cachedContentTokenCount'];

function hidden(value: RecordValue): boolean {
  return value.thought === true || value.thinking === true || [value.type, value.channel, value.role].some(item => typeof item === 'string'
    && /(?:^|[_-])(?:think|thinking|reasoning|analysis|thought)(?:$|[_-])/iu.test(item));
}
function textParts(value: unknown): string {
  if (typeof value === 'string') return value;
  return array(value).map(record).filter(part => !hidden(part) && (!part.type || ['text', 'output_text', 'input_text'].includes(String(part.type))))
    .map(part => typeof part.text === 'string' ? part.text : '').join('');
}
function visibleOnly(text: string): string {
  const tags = /<(\/?)(think|thinking|analysis|reasoning|thought)\s*>/giu, stack: string[] = [];
  let result = '', at = 0, match: RegExpExecArray | null;
  while ((match = tags.exec(text))) {
    if (!stack.length) result += text.slice(at, match.index);
    const name = match[2]?.toLowerCase();
    if (!name) return result.trim();
    if (!match[1]) stack.push(name);
    else if (stack.length) {
      // Crossed hidden tags have no trustworthy visible boundary. Keep only
      // already observed visible text rather than exposing the remaining tail.
      if (stack.at(-1) !== name) return result.trim();
      stack.pop();
    }
    at = tags.lastIndex;
  }
  result += stack.length ? '' : text.slice(at);
  const lower = result.toLowerCase();
  for (let size = Math.min(12, result.length); size > 0; size--) {
    if (['<think>', '<thinking>', '<analysis>', '<reasoning>', '<thought>'].some(tag => tag.startsWith(lower.slice(-size)))) {
      return result.slice(0, -size).trim();
    }
  }
  return result.trim();
}

/** This observer never mutates a request, selects a model, or dispatches fetch. */
export function observeCompanionProviderRequest(format: AiApiFormat, serializedBody: string): {
  userText?: string; payload: RecordValue; evidenceMissing?: 'request_json_invalid' | 'request_user_text_missing';
} {
  try {
    const body = record(JSON.parse(serializedBody));
    let userText: string;
    if (format === 'openai_responses') userText = typeof body.input === 'string' ? body.input
      : textParts(record(array(body.input).find(item => record(item).role === 'user')).content);
    else if (format === 'gemini_native') userText = textParts(record(array(body.contents).find(item => record(item).role === 'user')).parts);
    else {
      const root = format === 'dashscope_native' ? record(body.input) : body;
      userText = textParts(record(array(root.messages).find(item => record(item).role === 'user')).content);
    }
    if (!userText) return { payload: {}, evidenceMissing: 'request_user_text_missing' };
    let payload: RecordValue = {};
    try { payload = record(JSON.parse(userText)); } catch { /* Ordinary upstream prompts need not be JSON. */ }
    return { userText, payload };
  } catch { return { payload: {}, evidenceMissing: 'request_json_invalid' }; }
}

export interface CompanionProviderResponseObservation {
  status: 'observed' | 'unavailable'; visibleText: string; finishReason?: string; usage?: Record<string, number>;
  diagnostic?: 'response_json_invalid' | 'response_bytes_limit' | 'response_body_missing' | 'response_cancelled'
    | 'response_stream_invalid' | 'response_observation_failed' | 'unrecognized_finish_reason';
}
function metadata(value: unknown, usage: Record<string, number>, completion: { finishReason?: string; unrecognized?: boolean }): void {
  const body = record(value), output = record(body.output), response = record(body.response), message = record(body.message);
  for (const source of [body.usage, body.usageMetadata, message.usage, response.usage]) {
    for (const path of usagePaths) {
      let amount: unknown = source;
      for (const key of path.split('.')) amount = record(amount)[key];
      if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) usage[path] = amount;
    }
  }
  const reasons = [record(array(body.choices)[0]).finish_reason, record(array(output.choices)[0]).finish_reason,
    body.stop_reason, record(body.delta).stop_reason, record(array(body.candidates)[0]).finishReason, body.status, response.status];
  for (const reason of reasons) {
    if (typeof reason !== 'string' || !reason || reason === 'null') continue;
    if (finishReasons.has(reason)) completion.finishReason = reason;
    else completion.unrecognized = true;
  }
}
function visibleEnvelope(value: unknown, format: AiApiFormat): string {
  const body = record(value);
  if (format === 'openai_chat' || format === 'dashscope_native') {
    const root = format === 'dashscope_native' ? record(body.output) : body, message = record(record(array(root.choices)[0]).message);
    return hidden(message) ? '' : textParts(message.content);
  }
  if (format === 'openai_responses') {
    if (typeof body.output_text === 'string') return body.output_text;
    return array(body.output).map(record).filter(item => item.type === 'message' && !hidden(item)).map(item => textParts(item.content)).join('');
  }
  if (format === 'anthropic') return textParts(body.content);
  return textParts(record(record(array(body.candidates)[0]).content).parts);
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > JSON_LIMIT) throw new Error('response_bytes_limit');
  const reader = response.body?.getReader(); if (!reader) throw new Error('response_body_missing');
  let bytes = 0; const chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read(); signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > JSON_LIMIT) throw new Error('response_bytes_limit');
      chunks.push(chunk.value);
    }
    const joined = new Uint8Array(bytes); let at = 0;
    for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)); }
    catch { throw new Error('response_json_invalid'); }
  } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

/** Parse only a clone. Production owns its original response and all validity
 * decisions. SSE text is assembled by the unchanged production parser; the
 * bounded tap retains only whitelisted numeric usage and terminal diagnostics. */
export async function observeCompanionProviderResponse(response: Response, format: AiApiFormat,
  options: { signal?: AbortSignal } = {}): Promise<CompanionProviderResponseObservation> {
  const signal = options.signal ?? new AbortController().signal, usage: Record<string, number> = {}, completion: { finishReason?: string; unrecognized?: boolean } = {};
  try {
    const clone = response.clone(); let envelope: unknown;
    if (clone.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      if (!clone.body) throw new Error('response_body_missing');
      const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = '', data: string[] = [], size = 0, skipLeadingLf = false;
      const line = (line: string) => {
        if (!line) {
          const value = data.join('\n'); data = []; size = 0;
          if (value && value !== '[DONE]') { try { metadata(JSON.parse(value), usage, completion); } catch { /* Production diagnoses malformed frames. */ } }
        } else if (line.startsWith('data:')) {
          const part = line.slice(5).replace(/^ /u, ''); size += part.length;
          if (size > EVENT_LIMIT) throw new Error('response_stream_invalid'); data.push(part);
        }
      };
      const lines = (text: string) => {
        pending += text;
        if (skipLeadingLf && pending) { if (pending.startsWith('\n')) pending = pending.slice(1); skipLeadingLf = false; }
        let end: number;
        while ((end = pending.search(/[\r\n]/u)) >= 0) {
          line(pending.slice(0, end));
          const cr = pending[end] === '\r'; skipLeadingLf = cr && end === pending.length - 1;
          pending = pending.slice(end + (cr && pending[end + 1] === '\n' ? 2 : 1));
        }
        if (pending.length > EVENT_LIMIT) throw new Error('response_stream_invalid');
      };
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          lines(decoder.decode(chunk, { stream: true })); controller.enqueue(chunk);
        },
        flush() { lines(decoder.decode()); if (pending) line(pending); line(''); },
      });
      envelope = await readCompanionProviderStream(new Response(clone.body.pipeThrough(tap), { headers: clone.headers }), format, { signal });
    } else envelope = await boundedJson(clone, signal);
    metadata(envelope, usage, completion);
    return { status: 'observed', visibleText: visibleOnly(visibleEnvelope(envelope, format)),
      ...(completion.finishReason ? { finishReason: completion.finishReason } : {}), ...(Object.keys(usage).length ? { usage } : {}),
      ...(completion.unrecognized ? { diagnostic: 'unrecognized_finish_reason' as const } : {}) };
  } catch (error) {
    const controlled = error instanceof Error && ['response_json_invalid', 'response_bytes_limit', 'response_body_missing'].includes(error.message)
      ? error.message as 'response_json_invalid' | 'response_bytes_limit' | 'response_body_missing'
      : error instanceof CompanionProviderStreamError ? 'response_stream_invalid' as const : 'response_observation_failed' as const;
    return { status: 'unavailable', visibleText: '', diagnostic: signal.aborted ? 'response_cancelled' : controlled };
  }
}
