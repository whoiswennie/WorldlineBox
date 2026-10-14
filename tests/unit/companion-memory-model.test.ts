import { describe, expect, it, vi } from 'vitest';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import type { Companion, CompanionConversation, CompanionMessage } from '../../src/shared/companions';
import {
  buildDirectCompanionMemoryQuery, generateCompanionMemoryExtraction, generateCompanionMemoryMaintenance,
  planCompanionMemoryQuery,
} from '../../src/main/companions/memory-model';
import type { CompanionModelConfig } from '../../src/main/companions/model';

const companion: Companion = { id: 'sister', name: '大肥鱼', description: '姐姐', persona: '温柔，沉稳。', model: '',
  avatar: 'sister', builtin: true, proactive: false, createdAt: '2026-10-14T00:00:00Z' };
const conversation: CompanionConversation = { id: 'private_sister', kind: 'private', title: '大肥鱼', memberIds: ['sister'],
  pinned: false, muted: false, unread: 0, updatedAt: '2026-10-14T00:00:00Z', lastMessage: '' };
const config: CompanionModelConfig = { apiFormat: 'openai_chat', model: 'configured-chat-model', baseUrl: 'https://api.deepseek.com', apiKey: 'test-private-key' };
function message(id: string, sequence: number, content: string, overrides: Partial<CompanionMessage> = {}): CompanionMessage {
  return { id, sequence, content, conversationId: conversation.id, authorId: 'user', kind: 'text',
    createdAt: '2026-10-14T00:00:00Z', attachments: [], status: 'sent', ...overrides };
}
const input = { companion, conversation, messages: [message('coffee', 4, '现在已经不喝咖啡了，聊天功能忙完了。')] };
const candidate = { kind: 'preference', subject: 'user', factKey: 'coffee.preference', value: '不喝咖啡',
  content: '用户现在不喝咖啡。', sourceMessageIds: ['coffee'], evidence: [{ sourceMessageId: 'coffee', quote: '现在已经不喝咖啡了' }],
  polarity: 'negative', correction: true, tags: [{ name: '咖啡', aliases: ['coffee'] }] };
function response(format: AiApiFormat, value: unknown): Response {
  const text = JSON.stringify(value);
  const body = format === 'openai_chat' ? { choices: [{ message: { content: text } }] }
    : format === 'openai_responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
      : format === 'anthropic' ? { content: [{ type: 'text', text }] }
        : format === 'gemini_native' ? { candidates: [{ content: { parts: [{ text }] } }] }
          : { output: { choices: [{ message: { content: text } }] } };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

describe('source-grounded automatic memory formation', () => {
  it.each<AiApiFormat>(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'])(
    'uses only the configured chat model without tools or embeddings for %s', async format => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(format, { candidates: [candidate] }));
      const result = await generateCompanionMemoryExtraction(input, { ...config, apiFormat: format }, undefined, { fetchFn });
      expect(result.candidates[0]).toMatchObject(candidate);
      const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
      expect(body.tools).toBeUndefined();
      expect(body.parameters?.tools).toBeUndefined();
      expect(body.model ?? String(fetchFn.mock.calls[0]?.[0])).toContain('configured-chat-model');
      expect(format === 'openai_responses' ? body.max_output_tokens : format === 'gemini_native' ? body.generationConfig.maxOutputTokens
        : format === 'dashscope_native' ? body.parameters.max_tokens : body.max_tokens).toBe(8192);
      expect(JSON.stringify(body)).toContain('memory_extraction');
      expect(String(fetchFn.mock.calls[0]?.[0])).not.toContain('embedding');
      expect(JSON.stringify(body)).not.toContain(config.apiKey);
    });
  it('forms a spontaneous preference without a user request to remember and preserves correction and evidence', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat', { candidates: [candidate] }));
    const result = await generateCompanionMemoryExtraction(input, config, undefined, { fetchFn });
    expect(result.candidates[0]).toMatchObject({ correction: true, polarity: 'negative', epistemicStatus: 'asserted', evidence: candidate.evidence });
    expect(JSON.stringify(result)).not.toContain('confirmed');
  });
  it('accepts a no-change batch as an empty candidate list', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat', { candidates: [] }));
    expect(await generateCompanionMemoryExtraction(input, config, undefined, { fetchFn })).toEqual({ candidates: [] });
  });
  it.each([
    { ...candidate, sourceMessageIds: ['invented'] },
    { ...candidate, sourceMessageIds: ['coffee', 'coffee'] },
    { ...candidate, evidence: [{ sourceMessageId: 'coffee', quote: '用户长期讨厌咖啡' }] },
    { ...candidate, evidence: [] },
    { ...candidate, relatedMemoryIds: ['never_read'] },
    { ...candidate, subject: undefined },
    { ...candidate, factKey: undefined },
    { ...candidate, kind: 'reflection', subject: 'user', epistemicStatus: 'subjective' },
    { ...candidate, kind: 'hypothesis', epistemicStatus: 'confirmed' },
    { ...candidate, companionId: 'other_persona' },
  ])('rejects unsupported sources, misclassified evidence or invented structure %#', async invalidCandidate => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat', { candidates: [invalidCandidate] }));
    await expect(generateCompanionMemoryExtraction(input, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('uses neighboring history only to resolve references and rejects its IDs as new job sources', async () => {
    const oldMessage = message('old', 3, '以前喝咖啡。');
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat', { candidates: [{ ...candidate,
      sourceMessageIds: ['old'], evidence: [{ sourceMessageId: 'old', quote: '以前喝咖啡' }] }] }));
    await expect(generateCompanionMemoryExtraction({ ...input, contextMessages: [oldMessage] }, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    const payload = JSON.parse(body.messages[1].content);
    expect(payload.contextMessages[0].id).toBe('old');
    expect(payload.messages.map((source: { id: string }) => source.id)).toEqual(['coffee']);
  });
  it('does not turn unsent drafts or another group into evidence', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat', { candidates: [candidate] }));
    await expect(generateCompanionMemoryExtraction({ ...input, messages: [message('coffee', 4, '现在已经不喝咖啡了', { status: 'failed' })] }, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(generateCompanionMemoryExtraction({ ...input, conversation: { ...conversation, id: 'group', kind: 'group' } }, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects conversational or partial JSON output rather than treating it as a memory', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '好的，我已经记住了。' } }] })));
    await expect(generateCompanionMemoryExtraction(input, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('reports sanitized authentication, network, timeout and cancellation errors without claiming memory success', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(`private provider error ${config.apiKey}`, { status: 401 }));
    const auth = await generateCompanionMemoryExtraction(input, config, undefined, { fetchFn }).catch(error => error);
    expect(auth).toMatchObject({ code: 'AUTH' });
    expect(String(auth)).not.toContain(config.apiKey);
    fetchFn.mockRejectedValue(new Error(`https://private.example/?api_key=${config.apiKey}`));
    const network = await generateCompanionMemoryExtraction(input, config, undefined, { fetchFn }).catch(error => error);
    expect(network).toMatchObject({ code: 'NETWORK' });
    expect(String(network)).not.toContain('private.example');
    fetchFn.mockImplementation(() => new Promise(() => undefined));
    await expect(generateCompanionMemoryExtraction(input, config, undefined, { fetchFn, timeoutMs: 5 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const controller = new AbortController(); controller.abort();
    await expect(generateCompanionMemoryExtraction(input, config, controller.signal, { fetchFn })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

describe('automatic query understanding', () => {
  it('pins the current topic before historical replies and excludes subsequent messages', async () => {
    const messages = [message('old', 1, '之前那个方案'), message('assistant', 2, '刚才讨论的是旅行。', { authorId: 'sister' }),
      message('current', 3, '不是旅行。我说的是 WorldlineBox 记忆方案，谁提出、为什么改、现在怎样？'),
      message('later', 4, '下一次才问的消息')];
    const query = { query: 'WorldlineBox 记忆方案', terms: ['WorldlineBox', '记忆', '提出者', '修改原因', '当前状态'], tags: ['记忆管理'], includeHistory: false };
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat', query));
    expect(await planCompanionMemoryQuery({ companion, conversation, messages, currentMessageId: 'current' }, config, undefined, { fetchFn })).toMatchObject(query);
    const payload = JSON.parse(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).messages[1].content);
    expect(payload.currentMessage.content).toBe(messages[2]!.content);
    expect(payload.messages.map((source: { id: string }) => source.id)).toEqual(['old', 'assistant', 'current']);
    expect(JSON.stringify(payload)).not.toContain('下一次才问');
    expect(payload.purpose).toBe('memory_query');
  });
  it('keeps aliases, time range and historical intent as structured query values', async () => {
    const query = { query: '以前阿林那个项目', terms: ['阿林', '林林', 'WorldlineBox'], subject: 'person_lin',
      eventId: 'old_project', from: '2026-01-01', to: '2026-09-01', includeHistory: true, limit: 40 };
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat', query));
    expect(await planCompanionMemoryQuery({ ...input, currentMessage: '以前阿林那个项目怎样了？' }, config, undefined, { fetchFn })).toMatchObject(query);
  });
  it('rejects scope injection and unsupported output instead of routing model-authored SQL', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat', { query: '生日', companionId: 'other', sql: 'SELECT *' }));
    await expect(planCompanionMemoryQuery(input, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('falls back to the current message when a model emits an empty query', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat', {}));
    const query = await planCompanionMemoryQuery(input, config, undefined, { fetchFn });
    expect(query.query).toBe(input.messages[0]!.content.normalize('NFKC'));
    expect(query.terms.length).toBeGreaterThan(0);
  });
  it('has a model-free path and recognizes historical questions without using prior assistant text', () => {
    const query = buildDirectCompanionMemoryQuery({ ...input, messages: [message('past', 1, '以前喝咖啡时说了什么？'),
      message('assistant', 2, '换个主题：旅行。', { authorId: 'sister' })] });
    expect(query.query).toBe('以前喝咖啡时说了什么？'.normalize('NFKC'));
    expect(query.includeHistory).toBe(true);
    expect(query.query).not.toContain('旅行');
  });
});

describe('source-grounded autonomous maintenance', () => {
  const old = { id: 'coffee_fact', companionId: 'sister', content: '用户不喝咖啡。', kind: 'preference' as const,
    sourceMessageId: 'coffee', sourceConversationId: 'private_sister', version: 1, origin: 'companion' as const,
    createdAt: '2026-10-14', updatedAt: '2026-10-14' };
  const overview = { kind: 'overview', content: '聊天功能完成后，用户调整了咖啡习惯。', sourceMessageIds: ['coffee'],
    evidence: [{ sourceMessageId: 'coffee', quote: '现在已经不喝咖啡了，聊天功能忙完了' }], relatedMemoryIds: ['coffee_fact'],
    tags: [{ name: '聊天功能', type: 'project' }] };
  it('derives a phase directory from atomic facts and actual source text while excluding earlier summaries', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat', { candidates: [overview] }));
    const result = await generateCompanionMemoryMaintenance({ ...input, relevantMemories: [old, { ...old, id: 'summary', kind: 'overview', content: 'OLD SUMMARY MUST NOT BECOME EVIDENCE' }], intent: '聊天功能阶段' }, config, undefined, { fetchFn });
    expect(result.candidates[0]).toMatchObject(overview);
    const payload = JSON.parse(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).messages[1].content);
    expect(payload.purpose).toBe('memory_maintenance');
    expect(payload.relevantMemories.map((memory: { id: string }) => memory.id)).toEqual(['coffee_fact']);
    expect(JSON.stringify(payload)).not.toContain('OLD SUMMARY');
  });
  it.each([
    { ...overview, relatedMemoryIds: [] }, { ...overview, sourceMessageIds: ['invented'] },
    { ...overview, kind: 'fact', subject: 'user', factKey: 'new_fact' },
    { ...overview, relatedMemoryIds: ['old_summary'] },
  ])('rejects ungrounded maintenance or unsupported atomic output %#', async invalidCandidate => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat', { candidates: [invalidCandidate] }));
    await expect(generateCompanionMemoryMaintenance({ ...input, relevantMemories: [old] }, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects an unrelated dependency with no contributing source', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat', { candidates: [{ ...overview, relatedMemoryIds: ['unrelated'] }] }));
    await expect(generateCompanionMemoryMaintenance({ ...input, relevantMemories: [{ ...old, id: 'unrelated', sourceMessageId: 'another_source' }] }, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
