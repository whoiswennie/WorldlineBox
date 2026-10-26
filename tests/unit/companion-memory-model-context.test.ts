import { expect, it, vi } from 'vitest';
import { buildCompanionContext, type CompanionReplyInput } from '../../src/main/companions/context';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { projectCompanionMemoryContextForModel, projectCompanionMemoryToolTurnsForModel } from '../../src/main/companions/memory-model-context';
import { generateCompanionReply, generateCompanionText } from '../../src/main/companions/model';
import { runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import type { CompanionLoopTurn } from '../../src/shared/companion-loop';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';

const clock = { now: '2026-10-26T00:00:00Z', timeZone: 'Asia/Shanghai', domain: 'world' as const };
const scope = { companionId: 'fish', conversationId: 'private_fish' };
function fixture(count = 10_000) {
  const dependencies = Array.from({ length: count }, (_, index) => ({ id: `UNCALLED_CORPUS_MEMBER_${index}`, version: 1 }));
  const receipt = { text: '伙伴实际聚焦到的相关约定：周六在花园见面。', revision: 'HOST_ONLY_CORPUS_REVISION', profileKey: 'HOST_ONLY_ENCODER_PROFILE',
    evidence: { capturedAt: clock.now, corpusHash: 'HOST_ONLY_CORPUS_HASH', queryCorpusHash: 'HOST_ONLY_QUERY_HASH', queryClock: clock,
      dependencies, dependencyCoverage: 'complete' as const, pageMemoryIds: dependencies.slice(0, 12).map(note => note.id),
      references: [{ id: dependencies[0]!.id, version: 1, role: 'focus_input' as const, textHash: 'HOST_ONLY_TEXT_HASH', sourceFile: 'HOST_ONLY_RUNTIME_PATH',
        sources: [{ messageId: 'source_ref', revision: 2, checksum: 'HOST_ONLY_SOURCE_HASH' }] }], referenceCoverage: 'partial' as const,
      recallPolicy: { schema: 'episodic-v1' as const, halfLifeDays: 180 as const, minScore: 0 as const, applied: true, eligibleCount: 0, protectedCount: count,
        protectedNoteIds: dependencies.map(note => note.id) } } };
  const source = { id: 'task_source', sequence: 1, conversationId: scope.conversationId, authorId: 'user', content: '我们原先的约定是什么？',
    kind: 'text' as const, status: 'sent' as const, createdAt: clock.now, attachments: [] };
  const frame: CompanionReplyInput = { companion: { id: scope.companionId, name: '小肥鱼', description: '合成伙伴', persona: '本轮角色保持独立。',
    model: '', avatar: 'sister', builtin: false, proactive: false, createdAt: clock.now },
    conversation: { id: scope.conversationId, kind: 'private', title: '独立私聊', memberIds: [scope.companionId],
      pinned: false, muted: false, unread: 0, updatedAt: clock.now, lastMessage: source.content },
    messages: [source], sourceMessage: source, memories: [], agentLoop: true,
    memoryRecall: { reasons: [], pending: false, degraded: false, context: receipt } };
  const context = buildCompanionContext(frame);
  const turns: CompanionLoopTurn[] = [{ text: '', rawText: '', calls: [{ id: 'actual_memory_call', name: 'memory',
    arguments: '{"action":"search","query":"花园约定"}' }], results: [{ callId: 'actual_memory_call', content: JSON.stringify({ ok: true,
    memoryContext: receipt, memorySearchTimings: { retrieval: 123 }, memoryPage: { items: [], hasMore: false } }) }] }];
  return { frame, context, receipt, dependencies, turns };
}
const config = { apiFormat: 'openai_chat' as const, model: 'synthetic-model', baseUrl: 'https://provider.invalid', apiKey: 'synthetic-key' };
function envelope(format: AiApiFormat, text = '我记得是周六在花园见面。') {
  return format === 'openai_responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
    : format === 'anthropic' ? { content: [{ type: 'text', text }] }
      : format === 'gemini_native' ? { candidates: [{ content: { parts: [{ text }] } }] }
        : format === 'dashscope_native' ? { output: { choices: [{ message: { content: text } }] } }
          : { choices: [{ message: { content: text } }] };
}
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

it('retains complete host evidence while projecting only focused text, observation meaning and source references', () => {
  const f = fixture(), original = structuredClone(f.context), rawTurns = structuredClone(f.turns);
  const projected = projectCompanionMemoryContextForModel(f.context), payload = JSON.parse(projected.user);
  expect(payload.memoryRecall.context).toEqual({ text: f.receipt.text, evidence: { queryClock: clock,
    references: [{ id: f.dependencies[0]!.id, version: 1, role: 'focus_input', sources: [{ messageId: 'source_ref', revision: 2 }] }],
    referenceCoverage: 'partial' } });
  expect(projected.system).toBe(original.system); expect(projected.user.length).toBeLessThan(20_000);
  expect(projected.user).not.toContain('UNCALLED_CORPUS_MEMBER_9999'); expect(projected.user).not.toContain('HOST_ONLY_');
  expect(f.context).toEqual(original);
  const projectedTurns = projectCompanionMemoryToolTurnsForModel(f.turns);
  expect(JSON.parse(projectedTurns[0]!.results![0]!.content).memoryContext).toEqual(payload.memoryRecall.context);
  expect(projectedTurns[0]!.results![0]!.content).not.toContain('memorySearchTimings'); expect(f.turns).toEqual(rawTurns);
  const readset = captureCompanionExecutionReadset(scope, { context: f.context, turns: f.turns });
  expect(readset.complete).toBe(true); expect(readset.memories).toHaveLength(10_000);
  expect(readset.memories).toContainEqual(f.dependencies[9999]);
});

it('does not reinterpret raw dialogue, source metadata, plain templates or a different tool\'s result as host memory receipts', () => {
  const f = fixture(2), foreign = { text: '原始资料', revision: 'SOURCE_PRIVATE_REVISION', profileKey: 'SOURCE_PRIVATE_PROFILE',
    evidence: { dependencies: [{ id: 'raw_source_dependency', version: 1 }] } };
  const context = { system: '角色', user: JSON.stringify({ messages: [{ content: JSON.stringify({ memoryContext: foreign }) }],
    metadata: { memoryContext: foreign }, memoryRecall: { context: f.receipt } }) };
  const projected = JSON.parse(projectCompanionMemoryContextForModel(context).user);
  expect(projected.messages).toEqual(JSON.parse(context.user).messages); expect(projected.metadata.memoryContext).toEqual(foreign);
  const other: CompanionLoopTurn[] = [{ ...f.turns[0]!, calls: [{ id: 'actual_memory_call', name: 'dsh', arguments: '{}' }] }];
  expect(projectCompanionMemoryToolTurnsForModel(other)).toEqual(other);
  expect(projectCompanionMemoryContextForModel({ system: '模板', user: '原版AIMemo正文不需要JSON解析。' })).toEqual({ system: '模板', user: '原版AIMemo正文不需要JSON解析。' });
});

it.each(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'] as const)('bounds %s wire payloads without altering original context or native evidence pairs', async apiFormat => {
  const f = fixture(), before = JSON.stringify({ context: f.context, turns: f.turns });
  const fetchFn = vi.fn<typeof fetch>(async () => response(envelope(apiFormat)));
  const result = await generateCompanionReply(f.frame, { ...config, apiFormat }, undefined,
    { loop: true, context: f.context, turns: f.turns, fetchFn });
  expect(result.text).toBe('我记得是周六在花园见面。'); expect(fetchFn).toHaveBeenCalledOnce();
  const wire = String(fetchFn.mock.calls[0]![1]?.body);
  expect(wire.length).toBeLessThan(100_000); expect(wire).toContain(f.receipt.text);
  expect(wire).toContain('focus_input'); expect(wire).toContain('source_ref'); expect(wire).toContain('actual_memory_call');
  expect(wire).not.toContain('UNCALLED_CORPUS_MEMBER_9999'); expect(wire).not.toContain('HOST_ONLY_');
  expect(JSON.stringify({ context: f.context, turns: f.turns })).toBe(before);
  expect(captureCompanionExecutionReadset(scope, { context: f.context, turns: f.turns }).memories).toHaveLength(10_000);
});

it('applies the same wire projection to structured invocation while its readset still records every graph dependency', async () => {
  const f = fixture(), reads: CompanionExecutionReadset[] = [], original = JSON.stringify(f.frame);
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = String(init?.body); expect(wire.length).toBeLessThan(35_000);
    expect(wire).toContain(f.receipt.text); expect(wire).not.toContain('UNCALLED_CORPUS_MEMBER_9999'); expect(wire).not.toContain('HOST_ONLY_');
    return response(envelope('openai_chat', '{"answer":"依据同一份当前被动回忆"}'));
  });
  await expect(runCompanionStructuredAgent({ context: { system: '当前领域只输出JSON {answer:string}。', user: '{"purpose":"model_projection_test"}' },
    frame: f.frame, observeReadset: readset => { reads.push(readset); } }, config, undefined, { fetchFn })).resolves.toEqual({ answer: '依据同一份当前被动回忆' });
  expect(reads.length).toBeGreaterThan(0); expect(reads.every(readset => readset.complete && readset.memories.length === 10_000)).toBe(true);
  expect(JSON.stringify(f.frame)).toBe(original);
});

it('leaves generateCompanionText original AIMemo templates untouched even when their source text resembles reserved context JSON', async () => {
  const f = fixture(2), template = { system: 'VCP原版聚焦模板', user: JSON.stringify({ memoryRecall: { context: f.receipt }, sourceText: '原版模板中的完整原文' }) };
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    expect(JSON.parse(String(init?.body)).messages[1].content).toBe(template.user);
    return response(envelope('openai_chat', '这是我获取的所有相关知识/记忆[[保留原版模板]]'));
  });
  await expect(generateCompanionText(template, config, undefined, { fetchFn })).resolves.toContain('保留原版模板');
});
