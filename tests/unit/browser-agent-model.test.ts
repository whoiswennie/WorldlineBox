import { expect, it } from 'vitest';
import { browserAgentRequest, parseBrowserAgentReply, type BrowserAgentMessage } from '../../src/main/browser/agent-model';
import { AI_API_FORMATS } from '../../src/shared/ai-endpoints';
import { compactBrowserAgentHistory, estimateBrowserAgentTokens } from '../../src/main/browser/agent-context';

const messages: BrowserAgentMessage[] = [
  { role: 'user', text: 'Find official docs' },
  { role: 'assistant', text: 'Searching', calls: [{ id: 'native-call-1', name: 'browser_search', arguments: '{"query":"site:electronjs.org Browser"}' }] },
  { role: 'tool', callId: 'native-call-1', name: 'browser_search', text: '{"source":"https://www.electronjs.org"}' },
];
it.each(AI_API_FORMATS)('preserves native tool-call IDs/results and complete tool declarations for %s', apiFormat => {
  const [url, init] = browserAgentRequest({ apiFormat, model: 'test-model', apiKey: 'not-logged', baseUrl: 'https://model.example.com' }, 'Instructions', messages, new AbortController().signal);
  expect(url).toContain('model.example.com'); expect(init.redirect).toBe('error');
  const body = String(init.body); expect(body).toContain('browser_search'); expect(body).toContain('native-call-1'); expect(body).toContain('electronjs.org');
  if (apiFormat !== 'gemini_native') expect(body).not.toContain('not-logged');
});

it('normalizes actual function-call responses from all five provider formats', () => {
  const call = { id: 'c1', name: 'browser_tabs', arguments: '{}' };
  expect(parseBrowserAgentReply('openai_chat', { choices: [{ message: { tool_calls: [{ id: 'c1', function: call }] } }] }).calls).toEqual([call]);
  expect(parseBrowserAgentReply('openai_responses', { output: [{ type: 'function_call', call_id: 'c1', name: 'browser_tabs', arguments: '{}' }] }).calls).toEqual([call]);
  expect(parseBrowserAgentReply('anthropic', { content: [{ type: 'tool_use', id: 'c1', name: 'browser_tabs', input: {} }] }).calls).toEqual([call]);
  expect(parseBrowserAgentReply('gemini_native', { candidates: [{ content: { parts: [{ functionCall: { id: 'c1', name: 'browser_tabs', args: {} }, thoughtSignature: 'sig' }] } }] }).calls).toEqual([{ ...call, thoughtSignature: 'sig' }]);
  expect(parseBrowserAgentReply('dashscope_native', { output: { choices: [{ message: { content: 'Done' } }] } }).text).toBe('Done');
});

it('routes DashScope vision and Qwen 3.5 models to the multimodal endpoint with text parts and native call IDs', () => {
  const [url, init] = browserAgentRequest({ apiFormat: 'dashscope_native', model: 'qwen3-vl-plus', apiKey: 'fixture' }, 'Instructions', messages, new AbortController().signal);
  expect(url).toContain('/multimodal-generation/generation');
  const body = JSON.parse(String(init.body)); expect(body.input.messages[0].content).toEqual([{ text: 'Instructions' }]);
  expect(body.input.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'native-call-1', content: [{ text: '{"source":"https://www.electronjs.org"}' }] });
  expect(browserAgentRequest({ apiFormat: 'dashscope_native', model: 'qwen3.5-plus', apiKey: 'fixture' }, '', messages, new AbortController().signal)[0]).toContain('/multimodal-generation/');
  expect(browserAgentRequest({ apiFormat: 'dashscope_native', model: 'qwen-plus', apiKey: 'fixture' }, '', messages, new AbortController().signal)[0]).toContain('/text-generation/');
});

it('rejects empty responses and duplicate native tool IDs', () => {
  expect(() => parseBrowserAgentReply('openai_chat', { choices: [{ message: {} }] })).toThrow('为空');
  expect(() => parseBrowserAgentReply('openai_chat', { choices: [{ message: { tool_calls: [1, 2].map(() => ({ id: 'same', function: { name: 'browser_tabs', arguments: '{}' } })) } }] })).toThrow('重复');
});

it('compacts long conversations at complete request/call/result boundaries and retains the new request', () => {
  const long: BrowserAgentMessage[] = Array.from({ length: 20 }, (_, index) => messages.map(message => message.role === 'tool'
    ? { ...message, text: JSON.stringify({ content: 'source '.repeat(800), index }) } : structuredClone(message))).flat();
  long.push({ role: 'user', text: 'Now compare these sources without changing the date constraint.' });
  const result = compactBrowserAgentHistory(long, 9000);
  expect(result.removed).toBeGreaterThan(0); expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThanOrEqual(9000);
  expect(result.messages.at(-1)).toMatchObject({ role: 'user', text: expect.stringContaining('date constraint') });
  expect(result.summary).toContain('Find official docs');
  const pending = new Set<string>();
  for (const message of result.messages) {
    if (message.role === 'assistant') message.calls.forEach(call => pending.add(call.id));
    if (message.role === 'tool') { expect(pending.has(message.callId)).toBe(true); pending.delete(message.callId); }
  }
});

it('preserves grounded element refs, target tab IDs and actual outcomes when compacting large observations', () => {
  const observation: BrowserAgentMessage[] = [{ role: 'user', text: 'Click the real control' },
    { role: 'assistant', text: '', calls: [{ id: 'observe1', name: 'browser_observe', arguments: '{}' }] },
    { role: 'tool', callId: 'observe1', name: 'browser_observe', text: JSON.stringify({ tabId: 'real-tab', text: 'Long page '.repeat(1200), elements: [{ ref: 'e1', label: 'Run query' }], denied: false }) }];
  const compacted = compactBrowserAgentHistory(observation, 2200).messages.at(-1)!;
  expect(compacted.role).toBe('tool'); expect(compacted.text).toContain('real-tab'); expect(compacted.text).toContain('e1'); expect(compacted.text).toContain('Run query');
});

it('uses token budgets consistently for mixed CJK/Latin text, retains complete pairs and leaves a stable low-water mark', () => {
  const history: BrowserAgentMessage[] = Array.from({ length: 100 }, (_, index) => [
    { role: 'user' as const, text: `Question ${index} ` + '需要核实的内容'.repeat(180) },
    { role: 'assistant' as const, text: 'Searching actual sources', calls: [{ id: `c${index}`, name: 'browser_search', arguments: '{}' }] },
    { role: 'tool' as const, callId: `c${index}`, name: 'browser_search', text: JSON.stringify({ id: index, url: 'https://example.com', snippet: 'Actual facts '.repeat(140) }) },
  ]).flat();
  history.push({ role: 'user', text: 'Keep the latest request' });
  expect(estimateBrowserAgentTokens(JSON.stringify(history))).toBeGreaterThan(200000);
  const result = compactBrowserAgentHistory(history, 80000, '', 'tokens');
  expect(result.changed).toBe(true); expect(result.removed).toBeGreaterThan(0);
  expect(estimateBrowserAgentTokens(JSON.stringify(result.messages))).toBeLessThanOrEqual(80000);
  const ids = new Set(result.messages.flatMap(message => message.role === 'assistant' ? message.calls.map(call => call.id) : []));
  for (const message of result.messages) if (message.role === 'tool') expect(ids.has(message.callId)).toBe(true);
  const next = compactBrowserAgentHistory([...result.messages, { role: 'assistant', text: 'A small follow-up', calls: [] }], 100000, result.summary, 'tokens');
  expect(next.changed).toBe(false); expect(next.summary).toBe(result.summary);
});

it('retains a near-600K context without cloning or compressing evidence that still fits', () => {
  const text = '真实网页内容'.repeat(46000);
  const history: BrowserAgentMessage[] = [{ role: 'user', text: 'Analyze this page' }, { role: 'assistant', text, calls: [] }];
  expect(estimateBrowserAgentTokens(JSON.stringify(history))).toBeGreaterThan(550000);
  const result = compactBrowserAgentHistory(history, 595000, 'Earlier verified facts', 'tokens');
  expect(result.changed).toBe(false); expect(result.messages[1]).toBe(history[1]); expect(result.summary).toBe('Earlier verified facts');
});
