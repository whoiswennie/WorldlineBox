import type { AiApiFormat } from '../../shared/ai-endpoints';
import { CAPTURE_ANSWER_REASONING_BYTES, CAPTURE_ANSWER_TEXT_BYTES, type CaptureAnswerUpdate } from '../../shared/capture-answer';

/** Both transports are bounded independently of the provider's Content-Length. */
const JSON_BYTES = 256 * 1024, STREAM_BYTES = 1024 * 1024, EVENT_BYTES = 128 * 1024;
type ObjectValue = Record<string, unknown>;
const record = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export class CaptureProviderAnswerError extends Error {
  constructor(readonly code: 'INVALID_RESPONSE' | 'REFUSED' | 'NETWORK', message: string) { super(message); this.name = 'CaptureProviderAnswerError'; }
}
const invalid = () => new CaptureProviderAnswerError('INVALID_RESPONSE', '模型流式回复不完整、内容过大或接口格式无效，请重试。');
const refused = () => new CaptureProviderAnswerError('REFUSED', '模型未能回答这个问题，请调整问题后重试。');
type Options = { signal: AbortSignal; secret: string; onUpdate?: (snapshot: CaptureAnswerUpdate) => void; inspect?: (value: unknown) => void; dashscopeIncremental?: boolean };

/** Only public textual fields are read; signatures, encrypted content and tools never reach the UI. */
export async function readCaptureProviderAnswer(response: Response, format: AiApiFormat, options: Options): Promise<string> {
  if (!/^text\/event-stream(?:;|$)/iu.test(response.headers.get('content-type') ?? '')) {
    const body = await readCaptureResponseJson(response, options.signal);
    options.inspect?.(body);
    const snapshot = envelope(format, body), output = sanitize(snapshot, options.secret, true);
    if (!output.text.trim()) throw invalid();
    options.onUpdate?.(output);
    return output.text;
  }
  const accumulator = new AnswerAccumulator(format, options), reader = response.body?.getReader();
  if (!reader) throw invalid();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, pending = '', eventName = '', data: string[] = [], eventBytes = 0, skipLf = false, completed = false;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  options.signal.addEventListener('abort', cancel, { once: true });
  const dispatch = () => {
    options.signal.throwIfAborted();
    if (data.length) {
      const value = data.join('\n');
      if (value === '[DONE]') { if (!accumulator.finished) throw invalid(); }
      else {
        let parsed: unknown;
        try { parsed = JSON.parse(value); } catch { throw invalid(); }
        options.inspect?.(parsed);
        accumulator.accept(eventName, parsed);
      }
    }
    data = []; eventName = ''; eventBytes = 0;
  };
  const line = (value: string) => {
    if (!value) { dispatch(); return; }
    eventBytes += Buffer.byteLength(value);
    if (eventBytes > EVENT_BYTES) throw invalid();
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':'), key = colon < 0 ? value : value.slice(0, colon);
    const field = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /u, '');
    if (key === 'event') eventName = field;
    if (key === 'data') data.push(field);
  };
  try {
    options.signal.throwIfAborted();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await abortable(reader.read(), options.signal); }
      catch (cause) {
        options.signal.throwIfAborted();
        if (cause instanceof CaptureProviderAnswerError) throw cause;
        throw new CaptureProviderAnswerError('NETWORK', '模型流式连接中断，请检查网络后重试。');
      }
      options.signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > STREAM_BYTES) throw invalid();
      try { pending += decoder.decode(chunk.value, { stream: true }); } catch { throw invalid(); }
      if (skipLf && pending) { if (pending.startsWith('\n')) pending = pending.slice(1); skipLf = false; }
      let end: number;
      while ((end = pending.search(/[\r\n]/u)) >= 0) {
        line(pending.slice(0, end));
        const cr = pending[end] === '\r'; skipLf = cr && end === pending.length - 1;
        pending = pending.slice(end + (cr && pending[end + 1] === '\n' ? 2 : 1));
        if (accumulator.finished) break;
      }
      if (accumulator.finished) { const result = accumulator.finish(); completed = true; cancel(); return result; }
      if (Buffer.byteLength(pending) > EVENT_BYTES) throw invalid();
    }
    try { pending += decoder.decode(); } catch { throw invalid(); }
    if (pending) line(pending);
    dispatch();
    const result = accumulator.finish(); completed = true; return result;
  } finally {
    options.signal.removeEventListener('abort', cancel);
    if (!completed || options.signal.aborted) cancel();
    reader.releaseLock();
  }
}

class AnswerAccumulator {
  private snapshot: CaptureAnswerUpdate = { text: '', reasoning: '' };
  private emitted: CaptureAnswerUpdate = { text: '', reasoning: '' };
  private terminal = false;
  private textParts = new Map<string, string>();
  private reasoningParts = new Map<string, string>();
  private blocks = new Map<number, string>();
  private openBlocks = new Set<number>();
  private stopReason = '';
  constructor(private readonly format: AiApiFormat, private readonly options: Options) {}
  get finished(): boolean { return this.terminal; }
  accept(event: string, value: unknown): void {
    const root = record(value), type = typeof root.type === 'string' ? root.type : event;
    checkError(root);
    if (type === 'error') throw invalid();
    if (this.format === 'openai_chat' || this.format === 'dashscope_native') this.chat(root);
    else if (this.format === 'openai_responses') this.responses(type, root);
    else if (this.format === 'anthropic') this.anthropic(type, root);
    else this.gemini(root);
    this.publish(false);
  }
  private append(channel: keyof CaptureAnswerUpdate, value: string, cumulative = false): void {
    if (cumulative) {
      if (!value.startsWith(this.snapshot[channel])) throw invalid();
      this.snapshot[channel] = value;
    } else this.snapshot[channel] += value;
    // This raw bound also includes credentials withheld from snapshots.
    if (Buffer.byteLength(this.snapshot.text) + Buffer.byteLength(this.snapshot.reasoning) > STREAM_BYTES) throw invalid();
  }
  private chat(root: ObjectValue): void {
    const choice = firstChoice(this.format === 'dashscope_native' ? record(root.output) : root);
    if (!choice) return;
    const message = record(this.format === 'dashscope_native' ? choice.message : choice.delta ?? choice.message);
    if (message.refusal || choice.finish_reason === 'content_filter') throw refused();
    const text = parts(message.content), reasoning = publicReasoning(message);
    // The requested mode is explicit: inferring from repeated prefixes would
    // incorrectly drop legitimate repeated words from incremental deltas.
    const cumulative = this.format === 'dashscope_native' && !this.options.dashscopeIncremental;
    if (message.content !== undefined && message.content !== null) this.append('text', text.text, cumulative);
    if (reasoning || text.reasoning) this.append('reasoning', reasoning + text.reasoning, cumulative);
    if (choice.finish_reason && choice.finish_reason !== 'null') {
      if (!['stop', 'end_turn'].includes(String(choice.finish_reason))) throw invalid();
      this.terminal = true;
    }
  }
  private responses(type: string, root: ObjectValue): void {
    if (['response.failed', 'response.incomplete'].includes(type)) throw invalid();
    if (/^response\.refusal\./u.test(type)) throw refused();
    const index = Number(root.output_index ?? 0), partIndex = Number(root.summary_index ?? root.content_index ?? 0);
    if (!Number.isInteger(index) || index < 0 || index > 64 || !Number.isInteger(partIndex) || partIndex < 0 || partIndex > 64) throw invalid();
    const channel = /^response\.output_text\./u.test(type) ? 'text'
      : /^response\.reasoning_(?:summary_)?text\./u.test(type) ? 'reasoning' : undefined;
    if (channel && (type.endsWith('.delta') || type.endsWith('.done'))) {
      const field = type.endsWith('.delta') ? root.delta : root.text;
      if (typeof field !== 'string') throw invalid();
      const map = channel === 'text' ? this.textParts : this.reasoningParts, key = `${index}:${partIndex}`;
      const previous = map.get(key) ?? '', next = type.endsWith('.delta') ? previous + field : field;
      if (!next.startsWith(previous)) throw invalid();
      map.set(key, next);
      const combined = [...map].sort(([a], [b]) => compareIndex(a, b)).map(([, text]) => text).join('');
      this.append(channel, combined, true);
    }
    if (type === 'response.completed') {
      const response = record(root.response);
      if (response.status && response.status !== 'completed') throw invalid();
      if (Array.isArray(response.output) || typeof response.output_text === 'string') {
        const final = envelope('openai_responses', response);
        if (final.text) this.append('text', final.text, true);
        if (final.reasoning) this.append('reasoning', final.reasoning, true);
      }
      this.terminal = true;
    }
  }
  private anthropic(type: string, root: ObjectValue): void {
    const index = Number(root.index ?? 0);
    if (!Number.isInteger(index) || index < 0 || index > 64) throw invalid();
    if (type === 'content_block_start') {
      const block = record(root.content_block);
      this.blocks.set(index, String(block.type ?? '')); this.openBlocks.add(index);
      if (block.type === 'text' && typeof block.text === 'string') this.append('text', block.text);
      if (block.type === 'thinking' && typeof block.thinking === 'string') this.append('reasoning', block.thinking);
    } else if (type === 'content_block_delta') {
      if (!this.openBlocks.has(index)) throw invalid();
      const delta = record(root.delta);
      if (this.blocks.get(index) === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') this.append('text', delta.text);
      if (this.blocks.get(index) === 'thinking' && delta.type === 'thinking_delta' && typeof delta.thinking === 'string') this.append('reasoning', delta.thinking);
      // signature_delta / redacted_thinking are intentionally never read.
    } else if (type === 'content_block_stop') {
      if (!this.openBlocks.delete(index)) throw invalid();
    } else if (type === 'message_delta') {
      const reason = record(root.delta).stop_reason;
      if (reason === 'refusal') throw refused();
      if (typeof reason === 'string') this.stopReason = reason;
    } else if (type === 'message_stop') {
      if (this.openBlocks.size || !['end_turn', 'stop_sequence'].includes(this.stopReason)) throw invalid();
      this.terminal = true;
    }
  }
  private gemini(root: ObjectValue): void {
    if (record(root.promptFeedback).blockReason) throw refused();
    const candidate = firstCandidate(root); if (!candidate) return;
    checkGeminiFinish(candidate);
    const content = parts(record(candidate.content).parts);
    this.append('text', content.text); this.append('reasoning', content.reasoning);
    if (candidate.finishReason === 'STOP') this.terminal = true;
  }
  private publish(final: boolean): CaptureAnswerUpdate {
    const next = sanitize(this.snapshot, this.options.secret, final);
    if (next.text !== this.emitted.text || next.reasoning !== this.emitted.reasoning) {
      this.emitted = next; this.options.onUpdate?.(next);
    }
    return next;
  }
  finish(): string {
    if (!this.terminal) throw invalid();
    const final = this.publish(true);
    if (!final.text.trim()) throw invalid();
    return final.text;
  }
}

function firstChoice(root: ObjectValue): ObjectValue | undefined {
  const choices = array(root.choices); return choices.length ? record(choices.find(value => record(value).index === 0) ?? choices[0]) : undefined;
}
function firstCandidate(root: ObjectValue): ObjectValue | undefined {
  const candidates = array(root.candidates); return candidates.length ? record(candidates.find(value => record(value).index === 0) ?? candidates[0]) : undefined;
}
function checkError(root: ObjectValue): void {
  if (root.error || typeof root.code === 'string' && !['', 'Success', '200'].includes(root.code)) throw invalid();
}
function checkGeminiFinish(candidate: ObjectValue): void {
  if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION'].includes(String(candidate.finishReason))) throw refused();
  if (candidate.finishReason && candidate.finishReason !== 'STOP') throw invalid();
}
function parts(value: unknown): CaptureAnswerUpdate {
  if (typeof value === 'string') return { text: value, reasoning: '' };
  let text = '', reasoning = '';
  for (const valuePart of array(value)) {
    const part = record(valuePart);
    if (part.type === 'refusal') throw refused();
    if (part.thought === true && typeof part.text === 'string') reasoning += part.text;
    else if (part.type === 'thinking' && typeof part.thinking === 'string') reasoning += part.thinking;
    else if (['reasoning', 'reasoning_text', 'summary_text'].includes(String(part.type)) && typeof part.text === 'string') reasoning += part.text;
    else if ((part.type === undefined || part.type === 'text' || part.type === 'output_text') && typeof part.text === 'string') text += part.text;
  }
  return { text, reasoning };
}
function publicReasoning(value: ObjectValue): string {
  return typeof value.reasoning_content === 'string' ? value.reasoning_content : typeof value.reasoning === 'string' ? value.reasoning : '';
}
function envelope(format: AiApiFormat, value: unknown): CaptureAnswerUpdate {
  const root = record(value); checkError(root);
  if (format === 'openai_chat' || format === 'dashscope_native') {
    const choice = firstChoice(format === 'dashscope_native' ? record(root.output) : root) ?? {}, message = record(choice.message);
    if (message.refusal || choice.finish_reason === 'content_filter') throw refused();
    const content = parts(message.content);
    return { text: content.text, reasoning: publicReasoning(message) + content.reasoning };
  }
  if (format === 'openai_responses') {
    let text = '', reasoning = '';
    for (const output of array(root.output)) {
      const item = record(output);
      if (item.type === 'message') text += parts(item.content).text;
      if (item.type === 'reasoning') {
        const summary = parts(item.summary), content = parts(item.content);
        reasoning += summary.text + summary.reasoning + content.reasoning;
      }
    }
    return { text: typeof root.output_text === 'string' ? root.output_text : text, reasoning };
  }
  if (format === 'anthropic') return parts(root.content);
  const candidate = firstCandidate(root) ?? {};
  if (record(root.promptFeedback).blockReason) throw refused(); checkGeminiFinish(candidate);
  return parts(record(candidate.content).parts);
}
function compareIndex(left: string, right: string): number {
  const [a, b] = left.split(':').map(Number), [c, d] = right.split(':').map(Number); return a! - c! || b! - d!;
}
function sanitize(snapshot: CaptureAnswerUpdate, secret: string, final: boolean): CaptureAnswerUpdate {
  return { text: safeText(snapshot.text, secret, CAPTURE_ANSWER_TEXT_BYTES, final), reasoning: safeText(snapshot.reasoning, secret, CAPTURE_ANSWER_REASONING_BYTES, final) };
}
function safeText(raw: string, secret: string, limit: number, final: boolean): string {
  let value = secret ? raw.replaceAll(secret, '[redacted]') : raw;
  if (!final && secret) {
    // A key may span provider deltas. Do not publish an unresolved key prefix.
    const length = secretPrefixSuffix(value, secret);
    if (length) value = value.slice(0, -length);
  }
  value = value.replace(/[\uD800-\uDBFF]$/u, '');
  return truncateUtf8(final ? value.trim() : value.trimStart(), limit);
}
/** Linear in key length, including unusually long user-supplied credentials. */
function secretPrefixSuffix(value: string, secret: string): number {
  const failure = new Uint16Array(secret.length);
  for (let index = 1, matched = 0; index < secret.length; index++) {
    while (matched && secret[index] !== secret[matched]) matched = failure[matched - 1]!;
    if (secret[index] === secret[matched]) matched++;
    failure[index] = matched;
  }
  let matched = 0;
  for (let index = Math.max(0, value.length - secret.length + 1); index < value.length; index++) {
    while (matched && value[index] !== secret[matched]) matched = failure[matched - 1]!;
    if (value[index] === secret[matched]) matched++;
  }
  return matched;
}
function truncateUtf8(text: string, bytes: number): string { return Buffer.from(text).subarray(0, bytes).toString('utf8').replace(/\uFFFD$/u, ''); }

export async function readCaptureResponseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > JSON_BYTES) { void response.body?.cancel().catch(() => undefined); throw invalid(); }
  const reader = response.body?.getReader(); if (!reader) throw invalid();
  const chunks: Uint8Array[] = []; let bytes = 0, completed = false;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal); signal.throwIfAborted(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > JSON_BYTES) throw invalid(); chunks.push(next.value);
    }
    try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); completed = true; return value; } catch { throw invalid(); }
  } finally { if (!completed || signal.aborted) void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) { Promise.resolve(promise).catch(() => undefined); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, cause => { signal.removeEventListener('abort', abort); reject(cause); });
  });
}
