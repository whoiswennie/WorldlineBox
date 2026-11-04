import type { BotDshTool } from './dsh-brain';

export const APP_TOOL_RESULT_READER: BotDshTool = {
  name: 'agent_read_tool_result',
  description: '按callId回读本会话已确认工具回执原件。view只是有界预览，不能当作全量。jsonPath用JSON Pointer定位字段或数组项，例如/stickers/0；offset/limit分页，按nextOffset继续，不会重执行原工具。turn:事件ID可回读整轮步骤索引，summary可回读历史摘要。',
  parameters: { type: 'object', properties: { callId: { type: 'string', minLength: 1, maxLength: 200 },
    jsonPath: { type: 'string', maxLength: 1000 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 4096 } },
    required: ['callId'], additionalProperties: false },
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
const pointer = (parent: string, key: string | number) => `${parent}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
const kind = (value: unknown) => Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
const priority = (key: string) => /^(?:id|.*Id|.*Ids|status|sent|alreadySent|success|ok|error|name|originalName|filename|title|hasMore)$/u.test(key) ? 0 : 1;
function prefix(value: string, maxBytes: number, maxChars = value.length): string {
  let low = 0, high = Math.min(value.length, maxChars);
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (Buffer.byteLength(JSON.stringify(value.slice(0, mid)), 'utf8') <= maxBytes) low = mid; else high = mid - 1; }
  if (low && value.charCodeAt(low - 1) >= 0xD800 && value.charCodeAt(low - 1) <= 0xDBFF) low--;
  if (!low && value.charCodeAt(0) >= 0xD800 && value.charCodeAt(0) <= 0xDBFF && value.charCodeAt(1) >= 0xDC00 && value.charCodeAt(1) <= 0xDFFF
    && bytes(value.slice(0, 2)) <= maxBytes) return value.slice(0, 2);
  return value.slice(0, low);
}
/** Deterministic data projection. The original value is never overwritten. */
function project(value: unknown, path: string, budget: number, depth = 0): unknown {
  if (bytes(value) <= budget) return value;
  if (typeof value === 'string') return { preview: prefix(value, Math.max(32, budget - 160)), totalChars: value.length, jsonPath: path, omitted: true };
  if (!value || typeof value !== 'object') return value;
  if (depth >= 5 || budget < 220) return { valueType: kind(value), jsonPath: path, omitted: true };
  const entries = Array.isArray(value) ? value.slice(0, 8).map((item, index) => [String(index), item] as const)
    : Object.entries(value).sort(([a], [b]) => priority(a) - priority(b)).slice(0, 16);
  const allowance = Math.max(100, Math.floor((budget - 180) / Math.max(1, entries.length)));
  const projected = entries.map(([key, item]) => [key, project(item, pointer(path, key), allowance, depth + 1)] as const);
  for (let remaining = projected.length; remaining >= 0; remaining--) {
    const result = Array.isArray(value) ? { items: projected.map(([, item]) => item), total: value.length, jsonPath: path, omitted: true }
      : { ...Object.fromEntries(projected), _view: { keys: Object.keys(value).length, jsonPath: path, omitted: true } };
    if (bytes(result) <= budget || !projected.length) return result;
    projected.pop();
  }
  return { valueType: kind(value), jsonPath: path, omitted: true };
}
export function toolResultView(callId: string, result: unknown, budget = 3500): string {
  if (bytes(result) <= budget) return JSON.stringify(result ?? null);
  const reference = { kind: 'durable_tool_result_view', callId, originalBytes: bytes(result),
    read: { tool: APP_TOOL_RESULT_READER.name, callId, jsonPath: '', offset: 0, limit: 1024 } };
  const view = JSON.stringify({ ...reference,
    view: project(result, '', Math.max(220, budget - 350)),
  });
  return Buffer.byteLength(view, 'utf8') <= Math.min(8192, budget + 512) ? view : JSON.stringify({ ...reference, omitted: true });
}
export interface ToolResultPageInput { callId: string; jsonPath?: string; offset?: number; limit?: number }
export function toolResultPage(result: unknown, input: ToolResultPageInput, maxBytes = 7000): unknown {
  const path = input.jsonPath ?? '', offset = input.offset ?? 0, limit = input.limit ?? 1024;
  if (typeof path !== 'string' || path.length > 1000 || path && !path.startsWith('/') || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 4096) return { error: '回执分页参数无效。' };
  let value: unknown = result;
  for (const raw of path ? path.slice(1).split('/') : []) {
    if (/~(?![01])/u.test(raw)) return { error: 'JSON Pointer无效。' };
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return { error: '回执中没有这个JSON Pointer。' };
    value = (value as Record<string, unknown>)[key];
  }
  const valueType = kind(value), base = { kind: 'tool_result_page', callId: input.callId, jsonPath: path, valueType, offset };
  if (typeof value === 'string') {
    const available = maxBytes - bytes({ ...base, total: value.length, value: '', nextOffset: value.length }) - 16;
    if (available < 16) return { error: '当前回读路径与模型预算无法容纳一页，请使用更短的定位或更小的本次输入。' };
    const page = prefix(value.slice(offset), Math.min(6000, available), limit), end = offset + page.length;
    return { ...base, total: value.length, value: page, ...(end < value.length ? { nextOffset: end } : {}) };
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value), chosen: Array<[string, unknown]> = [], childPaths: string[] = [];
    for (const [key, item] of entries.slice(offset, offset + Math.min(64, limit))) {
      const projected = project(item, pointer(path, key), Math.max(220, Math.min(3500, maxBytes - bytes(base) - 500)));
      const nextValue = Array.isArray(value) ? [...chosen.map(([, item]) => item), projected] : Object.fromEntries([...chosen, [key, projected]]);
      if (chosen.length && bytes({ ...base, value: nextValue, childPaths: [...childPaths, pointer(path, key)], total: entries.length, nextOffset: offset + chosen.length + 1 }) > maxBytes) break;
      chosen.push([key, projected]); childPaths.push(pointer(path, key));
    }
    const end = offset + chosen.length;
    const page = { ...base, total: entries.length, value: Array.isArray(value) ? chosen.map(([, item]) => item) : Object.fromEntries(chosen), childPaths,
      ...(end < entries.length ? { nextOffset: end } : {}) };
    return bytes(page) <= maxBytes ? page : { error: '当前回读路径与模型预算无法容纳一页，请使用更短的JSON Pointer。' };
  }
  return { ...base, total: 1, value };
}
