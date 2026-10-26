import { describe, expect, it, vi } from 'vitest';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import type { Companion, CompanionConversation, CompanionMemory, CompanionMessage } from '../../src/shared/companions';
import { generateCompanionJournal } from '../../src/main/companions/memory-model';
import type { CompanionModelConfig } from '../../src/main/companions/model';

const at = '2026-10-14T00:00:00Z';
const companion: Companion = { id: 'sister', name: '大肥鱼', description: '姐姐', persona: '温柔，沉稳。', model: 'character-model-must-not-route-journals',
  avatar: 'sister', builtin: true, proactive: false, createdAt: at };
const conversation: CompanionConversation = { id: 'private_sister', kind: 'private', title: '大肥鱼', memberIds: ['sister'],
  pinned: false, muted: false, unread: 0, updatedAt: at, lastMessage: '' };
const config: CompanionModelConfig = { apiFormat: 'openai_chat', model: 'configured-chat-model', baseUrl: 'https://api.deepseek.com', apiKey: 'test-private-key' };
function message(id: string, sequence: number, content: string, overrides: Partial<CompanionMessage> = {}): CompanionMessage {
  return { id, sequence, content, conversationId: conversation.id, authorId: 'user', kind: 'text',
    createdAt: at, attachments: [], status: 'sent', ...overrides };
}
const input = { companion, conversation, messages: [message('coffee', 4, '现在已经不喝咖啡了，聊天功能忙完了。')] };
const note = { content: '用户说：“现在已经不喝咖啡了”，并说明聊天功能已经忙完；没有说明这一改变会持续多久。',
  tags: ['用户', '聊天功能', '咖啡'], sourceMessageIds: ['coffee'],
  evidence: [{ sourceMessageId: 'coffee', quote: '现在已经不喝咖啡了，聊天功能忙完了' }] };
function memory(overrides: Partial<CompanionMemory> = {}): CompanionMemory {
  return { id: 'coffee_note', companionId: companion.id, scopeId: 'scope_private_sister', content: '用户以前喝咖啡。', tags: ['用户', '咖啡'],
    sourceMessageId: 'old', sourceConversationId: conversation.id, sourceSequence: 3,
    sources: [{ messageId: 'old', conversationId: conversation.id, sequence: 3, authorId: 'user', revision: 1, checksum: 'host-checksum', createdAt: at }],
    origin: 'companion', status: 'indexed', captureMethod: 'automatic', version: 1, createdAt: at, updatedAt: at, ...overrides };
}
function response(format: AiApiFormat, value: unknown): Response {
  const text = JSON.stringify(value);
  const body = format === 'openai_chat' ? { choices: [{ message: { content: text } }] }
    : format === 'openai_responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
      : format === 'anthropic' ? { content: [{ type: 'text', text }] }
        : format === 'gemini_native' ? { candidates: [{ content: { parts: [{ text }] } }] }
          : { output: { choices: [{ message: { content: text } }] } };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}
function fetchFor(value: unknown) { return vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat', value)); }
function request(fetchFn: ReturnType<typeof fetchFor>) {
  const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
  return { body, payload: JSON.parse(body.messages[1].content), system: String(body.messages[0].content) };
}

describe('source-grounded VCP experience journals', () => {
  it('can propose a sourced procedure candidate while exposing only host-owned validation on read methods', async () => {
    const source = message('method_source', 6, '保存output.txt后，再检查文件是否包含已核验结果。');
    const procedure = { applicability: '生成当前约定的文本文件时', steps: ['保存output.txt。', '检查是否包含已核验结果。'], limitations: ['仅适用当前约定'],
      verification: { kind: 'artifact_delivery' as const, artifactRequirements: [{ path: 'output.txt', containsText: '已核验结果' }] } };
    const draft = { content: source.content, tags: ['方法候选'], procedure, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] };
    const fetchFn = fetchFor({ notes: [draft] });
    const old = memory({ procedure: { ...procedure, validation: { state: 'disabled', successes: 0, failures: 1, evidence: [] } } });
    const result = await generateCompanionJournal({ ...input, messages: [source], relevantMemories: [old] }, config, undefined, { fetchFn });
    expect(result.notes[0]?.procedure).toEqual(procedure); expect(request(fetchFn).payload.relevantMemories[0].procedure.validation.state).toBe('disabled');
    expect(request(fetchFn).system).toContain('方法一律先是未验证候选');
    await expect(generateCompanionJournal({ ...input, messages: [source] }, config, undefined,
      { fetchFn: fetchFor({ notes: [{ ...draft, procedure: { ...procedure, validation: { state: 'validated' } } }] }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('distinguishes a new peer enquiry episode from repeating the already-known name fact', async () => {
    const peerRoom = { ...conversation, id: 'peer_sisters', kind: 'group' as const, memberIds: ['sister', 'younger'] };
    const question = message('peer_question', 5, '姐姐，那位玩家让我来问，你还记得他叫什么吗？', { conversationId: peerRoom.id, authorId: 'younger' });
    const answer = message('peer_answer', 6, '我记得，他亲口向我介绍过自己叫天幻。', { conversationId: peerRoom.id, authorId: companion.id });
    const draft = { content: '妹妹来询问那位玩家的姓名，我依据自己的旧记忆回答天幻；这是本次实际发生的交流。', diaryName: '日记', tags: ['妹妹', '姓名询问'],
      sourceMessageIds: [question.id, answer.id], relatedMemoryIds: ['coffee_note'], evidence: [{ sourceMessageId: question.id, quote: question.content }, { sourceMessageId: answer.id, quote: answer.content }] };
    const fetchFn = fetchFor({ notes: [draft] });
    const result = await generateCompanionJournal({ companion, conversation: peerRoom, messages: [question, answer],
      relevantMemories: [memory({ content: '玩家之前已向我介绍自己叫天幻。' })], participants: [{ id: 'younger', name: '妹妹' }] }, config, undefined, { fetchFn });
    const sent = request(fetchFn);
    expect(sent.system).toContain('区分知识重复与经历新增');
    expect(sent.system).toContain('文字来信或“来问我”只证明实际发生了联系');
    expect(sent.payload.messages.map((source: { speaker: string }) => source.speaker)).toEqual(['other_companion', 'self']);
    expect(result.notes[0]?.sourceMessageIds).toEqual([question.id, answer.id]);
    expect(result.notes[0]?.evidence).toEqual(draft.evidence);
  });
  it('labels the real player and self while using its own retrieved memories across entrances', async () => {
    const fetchFn = fetchFor({ notes: [] });
    await generateCompanionJournal({ ...input, participants: [{ id: 'peer', name: '周岚' }, { id: companion.id, name: companion.name }],
      contextMessages: [message('self', 1, '我刚才和周岚聊了观察表。', { authorId: companion.id })],
      relevantMemories: [memory({ sourceConversationId: 'other_domain', content: 'OTHER_SCOPE_JOURNAL' })] }, config, undefined, { fetchFn });
    const sent = request(fetchFn);
    expect(sent.payload.identity).toMatchObject({ self: { id: companion.id, name: companion.name }, player: { id: 'user', kind: 'human_player' } });
    expect(sent.payload.messages[0]).toMatchObject({ authorId: 'user', speaker: 'human_player' });
    expect(sent.payload.contextMessages[0]).toMatchObject({ authorId: companion.id, speaker: 'self' });
    expect(sent.payload.relevantMemories).toHaveLength(1);
    expect(JSON.stringify(sent.payload)).toContain('OTHER_SCOPE_JOURNAL');
    expect(sent.system).toContain('authorId=user 永远是独立真人玩家');
    expect(sent.system).toContain('真人首次明确介绍自己的姓名');
  });
  it.each<AiApiFormat>(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'])(
    'uses the supplied global chat model and ordinary structured transport for %s', async format => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(format, { notes: [note] }));
      const result = await generateCompanionJournal(input, { ...config, apiFormat: format }, undefined, { fetchFn });
      expect(result.notes[0]).toMatchObject(note);
      const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
      expect(body.tools).toBeUndefined(); expect(body.parameters?.tools).toBeUndefined();
      expect(body.model ?? String(fetchFn.mock.calls[0]?.[0])).toContain(config.model);
      expect(format === 'openai_responses' ? body.max_output_tokens : format === 'gemini_native' ? body.generationConfig.maxOutputTokens
        : format === 'dashscope_native' ? body.parameters.max_tokens : body.max_tokens).toBe(8192);
      expect(JSON.stringify(body)).toContain('vcp_experience_journal');
      expect(String(fetchFn.mock.calls[0]?.[0])).not.toContain('embedding');
      expect(JSON.stringify(body)).not.toContain(config.apiKey);
      expect(JSON.stringify(body)).not.toContain(companion.model);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  it('preserves narrative qualifiers, exact evidence and VCP Tag order without a remember request', async () => {
    const result = await generateCompanionJournal(input, config, undefined, { fetchFn: fetchFor({ notes: [note] }) });
    expect(result.notes[0]).toEqual({ ...note, relatedMemoryIds: [] });
    expect(result.notes[0]?.tags).toEqual(['用户', '聊天功能', '咖啡']);
    expect(result.notes[0]).not.toHaveProperty('factKey');
    expect(result.notes[0]).not.toHaveProperty('epistemicStatus');
  });
  it('accepts a no-change batch without manufacturing a journal or state update', async () => {
    expect(await generateCompanionJournal(input, config, undefined, { fetchFn: fetchFor({ notes: [] }) })).toEqual({ notes: [] });
  });
  it('keeps valid diaries when optional state prose contains no actual change', async () => {
    const result = await generateCompanionJournal(input, config, undefined, { fetchFn: fetchFor({ notes: [note], stateProposal: {
      reason: '状态保持不变。', sourceMessageIds: ['coffee'], evidence: note.evidence,
    } }) });
    expect(result.notes).toHaveLength(1); expect(result).not.toHaveProperty('stateProposal');
  });
  it.each([
    { ...note, sourceMessageIds: ['invented'] }, { ...note, sourceMessageIds: ['coffee', 'coffee'] },
    { ...note, evidence: [{ sourceMessageId: 'coffee', quote: '用户长期讨厌咖啡' }] },
    { ...note, evidence: [{ sourceMessageId: 'other', quote: '现在已经不喝咖啡了' }] },
    { ...note, evidence: [] }, { ...note, relatedMemoryIds: ['never_read'] },
    { ...note, tags: [{ name: '咖啡', aliases: ['coffee'] }] }, { ...note, companionId: 'other_persona' },
    { ...note, sql: 'SELECT * FROM messages' }, { ...note, content: '' },
  ])('rejects unverifiable evidence, scope injection or non-journal structure %#', async invalidNote => {
    await expect(generateCompanionJournal(input, config, undefined, { fetchFn: fetchFor({ notes: [invalidNote] }) }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('requires a verbatim quotation for every claimed source', async () => {
    const second = message('result', 5, '我把聊天导出功能也完成了。');
    await expect(generateCompanionJournal({ ...input, messages: [...input.messages, second] }, config, undefined,
      { fetchFn: fetchFor({ notes: [{ ...note, sourceMessageIds: ['coffee', second.id] }] }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('exposes neighboring history for reference resolution but never accepts it as new evidence', async () => {
    const oldMessage = message('old', 3, '以前喝咖啡。');
    const fetchFn = fetchFor({ notes: [{ ...note, sourceMessageIds: ['old'], evidence: [{ sourceMessageId: 'old', quote: '以前喝咖啡' }] }] });
    await expect(generateCompanionJournal({ ...input, contextMessages: [oldMessage] }, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(request(fetchFn).payload.contextMessages[0].id).toBe('old');
    expect(request(fetchFn).payload.messages.map((source: { id: string }) => source.id)).toEqual(['coffee']);
  });
  it('does not send failed, streamed or checkpoint drafts as evidence or surrounding context', async () => {
    const excluded = [message('failed', 1, 'UNSENT_PRIVATE', { status: 'failed' }),
      message('streaming', 2, 'STREAM_PRIVATE', { isReplyDraft: true }),
      message('checkpoint', 3, 'CHECKPOINT_PRIVATE', { replyDraft: { step: 0, attemptId: 'attempt', text: 'UNCOMMITTED_TEXT' } })];
    const fetchFn = fetchFor({ notes: [] });
    await generateCompanionJournal({ ...input, messages: [...excluded, ...input.messages], contextMessages: excluded }, config, undefined, { fetchFn });
    const { payload } = request(fetchFn);
    expect(payload.messages.map((source: { id: string }) => source.id)).toEqual(['coffee']);
    expect(payload.contextMessages).toEqual([]);
    expect(JSON.stringify(payload)).not.toMatch(/UNSENT_PRIVATE|STREAM_PRIVATE|CHECKPOINT_PRIVATE|UNCOMMITTED_TEXT/u);
  });
  it.each<Partial<CompanionMessage>>([{ status: 'failed' }, { isReplyDraft: true },
    { replyDraft: { step: 0, attemptId: 'attempt', text: 'private draft' } }, { conversationId: 'other_group' }])(
    'rejects a model citation of a filtered message %#', async overrides => {
      await expect(generateCompanionJournal({ ...input, messages: [message('coffee', 4, input.messages[0]!.content, overrides)] }, config, undefined,
        { fetchFn: fetchFor({ notes: [note] }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });
  it('keeps new group evidence local while allowing its own retrieved background across entrances', async () => {
    const group = { ...conversation, id: 'group_current', kind: 'group' as const };
    const visible = message('group_source', 9, '这个群的聊天导出已经上线。', { conversationId: group.id });
    const fetchFn = fetchFor({ notes: [] });
    await generateCompanionJournal({ ...input, conversation: group, messages: [...input.messages, visible], contextMessages: input.messages,
      relevantMemories: [memory(), memory({ id: 'another_group', sourceConversationId: 'group_other' }),
        memory({ id: 'same_group', sourceConversationId: group.id }), memory({ id: 'other_companion', companionId: 'other', sourceConversationId: group.id })] },
    config, undefined, { fetchFn });
    const { payload } = request(fetchFn);
    expect(payload.messages.map((source: { id: string }) => source.id)).toEqual(['group_source']);
    expect(payload.contextMessages).toEqual([]);
    expect(payload.relevantMemories.map((item: { id: string }) => item.id)).toEqual(['coffee_note', 'another_group', 'same_group']);
    await expect(generateCompanionJournal({ ...input, conversation: group, messages: [visible] }, config, undefined,
      { fetchFn: fetchFor({ notes: [note] }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('links a new correction to actually read own diaries across entrances without treating old sources as new evidence', async () => {
    const old = memory({ sources: [{ ...memory().sources[0]!, messageId: 'coffee' }] });
    const linked = { ...note, relatedMemoryIds: [old.id] };
    expect((await generateCompanionJournal({ ...input, relevantMemories: [old] }, config, undefined,
      { fetchFn: fetchFor({ notes: [linked] }) })).notes[0]?.relatedMemoryIds).toEqual([old.id]);
    expect((await generateCompanionJournal({ ...input, relevantMemories: [memory()] }, config, undefined,
      { fetchFn: fetchFor({ notes: [linked] }) })).notes[0]?.relatedMemoryIds).toEqual([old.id]);
    expect((await generateCompanionJournal({ ...input, relevantMemories: [memory({ sourceConversationId: 'other_domain' })] }, config, undefined,
      { fetchFn: fetchFor({ notes: [linked] }) })).notes[0]?.relatedMemoryIds).toEqual([old.id]);
    await expect(generateCompanionJournal({ ...input, relevantMemories: [memory({ companionId: 'another_owner' })] }, config, undefined,
      { fetchFn: fetchFor({ notes: [linked] }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('removes a redundant target self-link from a verified correction while rejecting unread, stale or cross-domain targets', async () => {
    const target = memory(), other = memory({ id: 'another_read_note' });
    const corrected = { ...note, encoding: { action: 'correct' as const, targetId: target.id, expectedVersion: target.version }, relatedMemoryIds: [target.id, other.id] };
    const result = await generateCompanionJournal({ ...input, relevantMemories: [target, other] }, config, undefined,
      { fetchFn: fetchFor({ notes: [corrected] }) });
    expect(result.notes[0]?.relatedMemoryIds).toEqual([other.id]);
    expect(result.notes[0]?.encoding).toEqual(corrected.encoding);
    for (const relevantMemories of [[other], [{ ...target, version: target.version + 1 }, other], [{ ...target, sourceConversationId: 'other_domain' }, other]]) {
      await expect(generateCompanionJournal({ ...input, relevantMemories }, config, undefined,
        { fetchFn: fetchFor({ notes: [corrected] }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });
  it('uses each source historical world time zone without replacing event time by the current wall clock', async () => {
    const fetchFn = fetchFor({ notes: [] });
    await generateCompanionJournal({ ...input, messages: [message('dated', 1, '实际来过。', {
      createdAt: '2026-10-22T09:37:00.000Z', worldCreatedAt: '2026-08-04T09:37:00.000Z', worldTimeZone: 'Asia/Shanghai' })] }, config, undefined, { fetchFn });
    expect(request(fetchFn).payload.messages[0]).toMatchObject({ createdAt: '2026-08-04T09:37:00.000Z', realCreatedAt: '2026-10-22T09:37:00.000Z',
      eventTimeZone: 'Asia/Shanghai', eventLocalTime: '2026-08-04 17:37:00' });
    expect(request(fetchFn).system).toContain('不能把不带时区的eventLocalTime复制到该字段');
    const noZone = fetchFor({ notes: [] });
    await generateCompanionJournal(input, config, undefined, { fetchFn: noZone });
    expect(request(noZone).payload.messages[0]).not.toHaveProperty('eventLocalTime');
  });
  it('keeps transient world snapshots out of automatic diaries without erasing meaningful dated experience', async () => {
    const fetchFn = fetchFor({ notes: [] });
    await generateCompanionJournal({ ...input, messages: [message('snapshot', 9, '当前天气小雨18度，我仍在家里忙着。', { authorId: companion.id })] }, config, undefined, { fetchFn });
    const sent = request(fetchFn);
    expect(sent.system).toContain('仅刷新这些瞬态快照、没有其他意义时不单独写长期日记');
    expect(sent.system).toContain('有意义的变化、实际感受、赴约受天气影响');
    expect(sent.system).toContain('保留原始来源与有价值的历史，不删除旧观察');
    expect(sent.payload.messages[0].content).toBe('当前天气小雨18度，我仍在家里忙着。');
  });
  it('rejects conversational or partial JSON instead of reporting capture success', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '好的，我已经记住了。' } }] })));
    await expect(generateCompanionJournal(input, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('sanitizes authentication, network, timeout and cancellation errors without claiming capture success', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(`private provider error ${config.apiKey}`, { status: 401 }));
    const auth = await generateCompanionJournal(input, config, undefined, { fetchFn }).catch(error => error);
    expect(auth).toMatchObject({ code: 'AUTH' }); expect(String(auth)).not.toContain(config.apiKey);
    fetchFn.mockRejectedValue(new Error(`https://private.example/?api_key=${config.apiKey}`));
    const network = await generateCompanionJournal(input, config, undefined, { fetchFn }).catch(error => error);
    expect(network).toMatchObject({ code: 'NETWORK' }); expect(String(network)).not.toContain('private.example');
    fetchFn.mockImplementation(() => new Promise(() => undefined));
    await expect(generateCompanionJournal(input, config, undefined, { fetchFn, timeoutMs: 5 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const controller = new AbortController(); controller.abort();
    await expect(generateCompanionJournal(input, config, controller.signal, { fetchFn })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

describe('journal current-state provenance', () => {
  const stateProposal = { expression: 'direct', focus: '聊天功能', reason: '用户明确报告聊天功能已完成。', sourceMessageIds: ['coffee'], evidence: note.evidence,
    appraisals: [{ type: 'shared_success', target: 'user', intensity: 0.4, confidence: 0.8 }] };
  it('accepts a quoted current user appraisal independently of whether a new journal is needed', async () => {
    expect(await generateCompanionJournal(input, config, undefined, { fetchFn: fetchFor({ notes: [], stateProposal }) }))
      .toEqual({ notes: [], stateProposal });
  });
  it.each([
    { ...stateProposal, sourceMessageIds: ['invented'] }, { ...stateProposal, sourceMessageIds: ['coffee', 'coffee'] },
    { ...stateProposal, evidence: [{ sourceMessageId: 'coffee', quote: '用户非常信任我' }] }, { ...stateProposal, evidence: [] },
    { ...stateProposal, relationship: { affinity: 100, trust: 100, respect: 100 } }, { ...stateProposal, persona: '改变稳定人格' },
  ])('rejects ungrounded or host-owned state changes %#', async invalidState => {
    await expect(generateCompanionJournal(input, config, undefined, { fetchFn: fetchFor({ notes: [], stateProposal: invalidState }) }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('does not treat a companion-authored account as user relationship evidence', async () => {
    await expect(generateCompanionJournal({ ...input, messages: [{ ...input.messages[0]!, authorId: companion.id }] }, config, undefined,
      { fetchFn: fetchFor({ notes: [], stateProposal }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('cannot cite context-only user speech for a current-state change', async () => {
    await expect(generateCompanionJournal({ ...input, messages: [], contextMessages: input.messages }, config, undefined,
      { fetchFn: fetchFor({ notes: [], stateProposal }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
