import type { AiApiFormat } from '../../shared/ai-endpoints';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const MAX_STREAM_BYTES = 4 * 1_024 * 1_024, MAX_EVENT_LENGTH = 256 * 1_024;
export class CompanionProviderStreamError extends Error {
  constructor(readonly code: 'INVALID_RESPONSE' | 'REFUSED' | 'CANCELLED' | 'NETWORK', message: string) { super(message); }
}
const invalid = () => new CompanionProviderStreamError('INVALID_RESPONSE', '模型流式回复不完整或格式无效，请重试。');
const refused = () => new CompanionProviderStreamError('REFUSED', '模型未能回复这条消息。');
type Call = { id: string; name: string; arguments: string; thoughtSignature?: string };

/** SSE adapters build the same final envelopes as non-streaming provider calls. */
export async function readCompanionProviderStream(response: Response, format: AiApiFormat,
  options: { signal: AbortSignal; onText?: (text: string) => void; onActivity?: () => void }): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw invalid();
  const accumulator = new ProviderAccumulator(format, options.onText), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, pending = '', eventName = '', data: string[] = [], completed = false, skipLeadingLf = false;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  options.signal.addEventListener('abort', abort, { once: true });
  const dispatch = () => {
    if (options.signal.aborted) throw new CompanionProviderStreamError('CANCELLED', '这次回复已取消。');
    if (accumulator.isFinished) { data = []; return; }
    if (data.length) {
      const value = data.join('\n'); data = [];
      if (value !== '[DONE]') {
        let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw invalid(); }
        accumulator.accept(eventName, parsed);
        if (streamActivity(format, eventName, parsed)) options.onActivity?.();
      } else accumulator.done();
    }
    eventName = '';
  };
  const line = (value: string) => {
    if (!value) { dispatch(); return; }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':'), key = colon < 0 ? value : value.slice(0, colon);
    const field = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /u, '');
    if (key === 'event') eventName = field;
    if (key === 'data') data.push(field);
    if (data.reduce((sum, part) => sum + part.length, 0) > MAX_EVENT_LENGTH) throw invalid();
  };
  try {
    if (options.signal.aborted) throw new CompanionProviderStreamError('CANCELLED', '这次回复已取消。');
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch {
        if (options.signal.aborted) throw new CompanionProviderStreamError('CANCELLED', '这次回复已取消。');
        throw new CompanionProviderStreamError('NETWORK', '无法连接聊天模型，请检查网络和模型设置。');
      }
      if (options.signal.aborted) throw new CompanionProviderStreamError('CANCELLED', '这次回复已取消。');
      if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > MAX_STREAM_BYTES) throw invalid();
      pending += decoder.decode(chunk.value, { stream: true });
      if (skipLeadingLf && pending) { if (pending.startsWith('\n')) pending = pending.slice(1); skipLeadingLf = false; }
      let end: number;
      while ((end = pending.search(/[\r\n]/u)) >= 0) {
        line(pending.slice(0, end));
        const cr = pending[end] === '\r'; skipLeadingLf = cr && end === pending.length - 1;
        pending = pending.slice(end + (cr && pending[end + 1] === '\n' ? 2 : 1));
      }
      if (accumulator.isFinished) {
        const result = accumulator.finish(); completed = true;
        void reader.cancel().catch(() => undefined); return result;
      }
      if (pending.length > MAX_EVENT_LENGTH) throw invalid();
    }
    pending += decoder.decode();
    if (pending) line(pending.replace(/\r$/u, ''));
    dispatch();
    const result = accumulator.finish(); completed = true; return result;
  } catch (error) {
    if (error instanceof CompanionProviderStreamError) throw error;
    throw invalid();
  } finally {
    options.signal.removeEventListener('abort', abort);
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function streamActivity(format: AiApiFormat, name: string, value: unknown): boolean {
  const chunk = record(value), type = String(chunk.type ?? name);
  if (format === 'openai_chat' || format === 'dashscope_native') {
    const root = format === 'dashscope_native' ? record(chunk.output) : chunk;
    return array(root.choices).some(value => {
      const choice = record(value), delta = record(choice.delta ?? choice.message);
      return Boolean(typeof choice.finish_reason === 'string' && choice.finish_reason !== 'null'
        || typeof delta.content === 'string' && delta.content.length || array(delta.content).length || array(delta.tool_calls).length
        || typeof delta.reasoning_content === 'string' && delta.reasoning_content.length || delta.role);
    });
  }
  if (format === 'openai_responses') return /^response\.(?:created|in_progress|completed|output_item\.(?:added|done)|content_part\.(?:added|done)|(?:output_text|function_call_arguments|reasoning_text|reasoning_summary_text)\.(?:delta|done))$/u.test(type);
  if (format === 'anthropic') return /^(?:message_(?:start|delta|stop)|content_block_(?:start|delta|stop))$/u.test(type);
  return array(chunk.candidates).some(value => array(record(record(value).content).parts).length > 0 || record(value).finishReason);
}

class ProviderAccumulator {
  private text = '';
  private visible = '';
  private terminal = false;
  private calls = new Map<number, Call>();
  private items = new Map<number, RecordValue>();
  private blocks = new Map<number, RecordValue>();
  private openBlocks = new Set<number>();
  private response?: RecordValue;
  private stopReason = '';
  constructor(private readonly format: AiApiFormat, private readonly onText?: (text: string) => void) {}
  get isFinished(): boolean { return this.terminal; }
  done(): void {
    // Chat/DashScope also require their native finish reason before [DONE].
    if (!this.terminal) throw invalid();
  }
  private updateText(value: string, cumulative = false): void {
    if (cumulative) { if (!value.startsWith(this.text)) throw invalid(); this.text = value; }
    else this.text += value;
    if (this.text.length > 65_536) throw invalid();
    const visible = visibleCompanionStreamText(this.text);
    if (visible.length > 16_000) throw invalid();
    if (visible && visible !== this.visible) {
      if (!visible.startsWith(this.visible)) throw invalid();
      this.visible = visible; this.onText?.(visible);
    }
  }
  accept(eventName: string, value: unknown): void {
    const chunk = record(value), type = typeof chunk.type === 'string' ? chunk.type : eventName;
    if (chunk.error || type === 'error' || chunk.code && !chunk.output) throw invalid();
    if (this.format === 'openai_chat' || this.format === 'dashscope_native') this.chat(chunk);
    else if (this.format === 'openai_responses') this.responses(type, chunk);
    else if (this.format === 'anthropic') this.anthropic(type, chunk);
    else this.gemini(chunk);
  }
  private chat(chunk: RecordValue): void {
    const root = this.format === 'dashscope_native' ? record(chunk.output) : chunk;
    const choices = array(root.choices); if (!choices.length) return;
    const choice = record(choices.find(value => record(value).index === 0) ?? choices[0]);
    const delta = record(this.format === 'dashscope_native' ? choice.message : choice.delta);
    if (delta.refusal || choice.finish_reason === 'content_filter') throw refused();
    if (choice.finish_reason === 'length') throw invalid();
    if (typeof delta.content === 'string') this.updateText(delta.content);
    else for (const value of array(delta.content)) {
      const part = record(value); if (part.type === 'refusal') throw refused();
      if (part.thought !== true && !['thinking', 'reasoning', 'analysis'].includes(String(part.type)) && typeof part.text === 'string') this.updateText(part.text);
    }
    for (const value of array(delta.tool_calls)) {
      const part = record(value), fn = record(part.function), index = Number(part.index ?? 0);
      if (!Number.isInteger(index) || index < 0 || index >= 16) throw invalid();
      const call = this.calls.get(index) ?? { id: '', name: '', arguments: '' };
      if (typeof part.id === 'string' && call.id !== part.id) call.id += part.id;
      if (typeof fn.name === 'string' && call.name !== fn.name) call.name += fn.name;
      if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
      this.checkCall(call); this.calls.set(index, call);
    }
    if (typeof choice.finish_reason === 'string' && !['', 'null'].includes(choice.finish_reason)) {
      if (!['stop', 'tool_calls', 'function_call'].includes(choice.finish_reason)) throw invalid();
      this.stopReason = choice.finish_reason; this.terminal = true;
    }
  }
  private responses(type: string, chunk: RecordValue): void {
    if (['response.failed', 'response.incomplete'].includes(type)) throw invalid();
    if (type === 'response.refusal.delta' || type === 'response.refusal.done') throw refused();
    const index = Number(chunk.output_index ?? 0);
    if (!Number.isInteger(index) || index < 0 || index > 32) throw invalid();
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = record(chunk.item), previous = this.items.get(index);
      if (item.type === 'function_call') {
        const call = this.calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof item.call_id === 'string') call.id = item.call_id;
        if (typeof item.name === 'string') call.name = item.name;
        if (typeof item.arguments === 'string' && (type.endsWith('.done') || !call.arguments)) call.arguments = item.arguments;
        this.checkCall(call); this.calls.set(index, call);
      }
      this.items.set(index, { ...previous, ...item });
    } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
      const call = this.calls.get(index); if (!call) throw invalid();
      if (type.endsWith('.delta') && typeof chunk.delta === 'string') call.arguments += chunk.delta;
      else if (typeof chunk.arguments === 'string') call.arguments = chunk.arguments;
      this.checkCall(call);
    } else if (type === 'response.output_text.delta') {
      if (typeof chunk.delta !== 'string') throw invalid(); this.updateText(chunk.delta);
    } else if (type === 'response.completed') {
      const response = record(chunk.response);
      if (response.status && response.status !== 'completed') throw invalid();
      if (Array.isArray(response.output)) {
        const text = responseText(response);
        if (text || !this.text) this.updateText(text, true);
        const ids = new Set<string>(); let count = 0;
        for (const item of response.output.map(record).filter(item => item.type === 'function_call')) {
          if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string' || !item.call_id || !item.name || ids.has(item.call_id) || ++count > 16) throw invalid();
          this.checkCall({ id: item.call_id, name: item.name, arguments: item.arguments });
          try { JSON.parse(item.arguments); } catch { throw invalid(); } ids.add(item.call_id);
        }
        this.response = response;
      }
      this.terminal = true;
    }
  }
  private anthropic(type: string, chunk: RecordValue): void {
    const index = Number(chunk.index ?? 0);
    if (!Number.isInteger(index) || index < 0 || index > 32) throw invalid();
    if (type === 'content_block_start') {
      const block = record(chunk.content_block); this.blocks.set(index, { ...block }); this.openBlocks.add(index);
      if (block.type === 'text' && typeof block.text === 'string') this.updateText(block.text);
      if (block.type === 'tool_use') this.calls.set(index, { id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: '' });
    } else if (type === 'content_block_delta') {
      const block = this.blocks.get(index), delta = record(chunk.delta); if (!block || !this.openBlocks.has(index)) throw invalid();
      if (block.type === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') this.updateText(delta.text);
      if (block.type === 'tool_use' && delta.type === 'input_json_delta') {
        const call = this.calls.get(index)!; if (typeof delta.partial_json !== 'string') throw invalid();
        call.arguments += delta.partial_json; this.checkCall(call);
      }
    } else if (type === 'content_block_stop') {
      if (!this.openBlocks.delete(index)) throw invalid();
      const call = this.calls.get(index); if (call && !call.arguments) call.arguments = JSON.stringify(this.blocks.get(index)!.input ?? {});
    } else if (type === 'message_delta') {
      const reason = record(chunk.delta).stop_reason;
      if (reason === 'max_tokens') throw invalid(); if (reason === 'refusal') throw refused();
      if (typeof reason === 'string') this.stopReason = reason;
    } else if (type === 'message_stop') {
      if (this.openBlocks.size || !this.stopReason) throw invalid(); this.terminal = true;
    }
  }
  private gemini(chunk: RecordValue): void {
    if (record(chunk.promptFeedback).blockReason) throw refused();
    const candidates = array(chunk.candidates); if (!candidates.length) return;
    const candidate = record(candidates.find(value => record(value).index === 0) ?? candidates[0]);
    const reason = candidate.finishReason;
    if (['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'RECITATION'].includes(String(reason))) throw refused();
    if (reason && reason !== 'STOP') throw invalid();
    for (const value of array(record(candidate.content).parts)) {
      const part = record(value);
      if (part.thought !== true && typeof part.text === 'string') this.updateText(part.text);
      const fn = record(part.functionCall); if (typeof fn.name !== 'string') continue;
      const existing = typeof fn.id === 'string' ? [...this.calls].find(([, call]) => call.id === fn.id) : undefined;
      const index = existing?.[0] ?? this.calls.size;
      const call: Call = { id: typeof fn.id === 'string' ? fn.id : `call_${index}`, name: fn.name,
        arguments: JSON.stringify(fn.args ?? {}), ...(typeof part.thoughtSignature === 'string' ? { thoughtSignature: part.thoughtSignature } : {}) };
      this.checkCall(call); this.calls.set(index, { ...existing?.[1], ...call });
    }
    if (reason === 'STOP') this.terminal = true;
  }
  private checkCall(call: Call): void {
    if (this.calls.size > 16 || call.id.length > 200 || call.name.length > 100 || call.arguments.length > 65_536 || (call.thoughtSignature?.length ?? 0) > 65_536) throw invalid();
  }
  finish(): unknown {
    if (!this.terminal || this.calls.size > 16) throw invalid();
    const calls = [...this.calls].sort(([left], [right]) => left - right).map(([, call]) => {
      this.checkCall(call); if (!call.id || !call.name) throw invalid();
      try { JSON.parse(call.arguments); } catch { throw invalid(); } return call;
    });
    if (new Set(calls.map(call => call.id)).size !== calls.length) throw invalid();
    if (this.format === 'openai_chat' || this.format === 'dashscope_native') {
      const root = { choices: [{ finish_reason: this.stopReason, message: { content: this.text,
        tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } }] };
      return this.format === 'dashscope_native' ? { output: root } : root;
    }
    if (this.format === 'openai_responses') return this.response ?? { status: 'completed', output: [
      ...(this.text ? [{ type: 'message', content: [{ type: 'output_text', text: this.text }] }] : []),
      ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }))] };
    if (this.format === 'anthropic') return { stop_reason: this.stopReason, content: [
      ...(this.text ? [{ type: 'text', text: this.text }] : []), ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) }))] };
    return { candidates: [{ finishReason: 'STOP', content: { parts: [
      ...(this.text ? [{ text: this.text }] : []), ...calls.map(call => ({ functionCall: { id: call.id, name: call.name, args: JSON.parse(call.arguments) },
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) }))] } }] };
  }
}

function responseText(response: RecordValue): string {
  return array(response.output).map(record).filter(item => item.type === 'message').flatMap(item => array(item.content))
    .map(record).filter(part => part.type === 'output_text').map(part => typeof part.text === 'string' ? part.text : '').join('');
}

/** Incrementally exposes only an assistant's text field, never its JSON wrapper. */
export function visibleCompanionStreamText(raw: string): string {
  let text = redactThoughts(raw).trimStart();
  if (text.startsWith('```')) {
    const newline = text.indexOf('\n'); if (newline < 0) return '';
    if (/^```(?:json)?\s*$/iu.test(text.slice(0, newline))) text = text.slice(newline + 1).trimStart();
  } else if ('```'.startsWith(text)) return '';
  if (text.startsWith('{')) text = partialTopLevelText(text);
  else if (text.startsWith('[') && '[PASS]'.startsWith(text.trim())) return '';
  text = redactThoughts(text);
  // Some JSON SSE frames split UTF-16 surrogate pairs even though each frame
  // is valid UTF-8. Hold the high half until its next delta arrives.
  text = text.trim().replace(/[\uD800-\uDBFF]$/u, '').trimEnd();
  if ('[PASS]'.startsWith(text) || text === '[PASS]') return '';
  return text;
}
function redactThoughts(raw: string): string {
  const pattern = /<(think|analysis|reasoning)>/giu;
  let result = '', at = 0, found: RegExpExecArray | null;
  while ((found = pattern.exec(raw))) {
    result += raw.slice(at, found.index);
    const end = new RegExp(`</${found[1]}>`, 'iu').exec(raw.slice(pattern.lastIndex));
    if (!end) return result;
    at = pattern.lastIndex + end.index + end[0].length; pattern.lastIndex = at;
  }
  result += raw.slice(at);
  const lower = result.toLowerCase();
  for (let length = Math.min(12, result.length); length > 0; length--) {
    const suffix = lower.slice(-length);
    if (['<think>', '<analysis>', '<reasoning>'].some(tag => tag.startsWith(suffix))) return result.slice(0, -length);
  }
  return result;
}
function partialTopLevelText(text: string): string {
  let index = 1;
  while (index < text.length) {
    while (/\s|,/u.test(text[index] ?? '') && index < text.length) index++;
    if (text[index] !== '"') return '';
    const key = partialString(text, index); if (!key.complete) return ''; index = key.end;
    while (/\s/u.test(text[index] ?? '') && index < text.length) index++;
    if (text[index++] !== ':') return '';
    while (/\s/u.test(text[index] ?? '') && index < text.length) index++;
    if (key.value === 'text') return text[index] === '"' ? partialString(text, index).value : '';
    let depth = 0;
    while (index < text.length) {
      const char = text[index]!;
      if (char === '"') { const value = partialString(text, index); if (!value.complete) return ''; index = value.end; continue; }
      if (char === '{' || char === '[') depth++;
      if (char === '}' || char === ']') { if (depth === 0) return ''; depth--; }
      if (char === ',' && depth === 0) { index++; break; } index++;
    }
  }
  return '';
}
function partialString(text: string, start: number): { value: string; end: number; complete: boolean } {
  let value = '', index = start + 1;
  while (index < text.length) {
    const char = text[index++]!;
    if (char === '"') return { value, end: index, complete: true };
    if (char !== '\\') { if (char.charCodeAt(0) < 32) throw invalid(); value += char; continue; }
    if (index >= text.length) break;
    const escaped = text[index++]!, map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    if (escaped !== 'u') { if (!(escaped in map)) throw invalid(); value += map[escaped]; continue; }
    const code = text.slice(index, index + 4); if (code.length < 4) break;
    if (!/^[\da-f]{4}$/iu.test(code)) throw invalid(); index += 4;
    const point = parseInt(code, 16);
    if (point >= 0xd800 && point <= 0xdbff) {
      const following = text.slice(index, index + 6); if (following.length < 6) break;
      if (!/^\\u[dD][c-fC-F][\da-f]{2}$/u.test(following)) throw invalid();
      value += String.fromCharCode(point, parseInt(following.slice(2), 16)); index += 6;
    } else value += String.fromCharCode(point);
  }
  return { value, end: index, complete: false };
}
