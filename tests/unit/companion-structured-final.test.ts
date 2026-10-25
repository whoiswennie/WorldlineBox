import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import { companionAgentRunSchema, companionFinalValidationFailures, type CompanionAgentRun } from '../../src/shared/companion-agent-run';
import { COMPANION_SUBMIT_RESULT_TOOL, companionFinalProposalBytes, companionFinalProposalReceipt } from '../../src/shared/companion-final-proposal';
import type { CompanionLoopCall, CompanionLoopTurn } from '../../src/shared/companion-loop';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import type { CompanionAgentJournal } from '../../src/main/companions/agent-journal';
import { runCompanionStructuredAgent, type CompanionStructuredAgentInput } from '../../src/main/companions/structured-agent';

const formats: AiApiFormat[] = ['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'];
const config = { model: 'user-selected-model', baseUrl: 'https://offline.invalid/v1', apiKey: 'synthetic-only' };
const frame: CompanionReplyInput = {
  companion: { id: 'alice', name: 'Alice', description: '', persona: '核对真实资料后再提案。', avatar: 'sister', model: '',
    builtin: false, proactive: false, active: true, createdAt: '2026-10-25T00:00:00Z' },
  conversation: { id: 'room', kind: 'group', title: '离线协议核验', memberIds: ['alice', 'bob'], pinned: false,
    muted: false, unread: 0, lastMessage: '', updatedAt: '2026-10-25T00:00:00Z' },
  messages: [], memories: [],
};
const output = z.strictObject({ answer: z.string(),
  memorySources: z.array(z.object({ id: z.string(), conversationId: z.string(), content: z.string() })).optional(),
  memories: z.array(z.object({ id: z.string(), companionId: z.string(), version: z.number(), content: z.string() })).optional() });
const finalSchema = z.toJSONSchema(output, { io: 'input' });
const context = { system: '依据本入口契约提交提案，提案尚未执行。',
  user: JSON.stringify({ purpose: 'offline_non_activity_final', outputSchema: finalSchema }) };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value as Row;
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value : []).map(object);

/** A controlled durable journal, not a SQLite or real-model acceptance. The
 * production shared schema and proposal receipt validate every saved turn. */
function journalFixture() {
  let saved: CompanionAgentRun = { id: 'native_final_run', companionId: 'alice', conversationId: 'room',
    invocationId: 'offline_non_activity_final', requestDigest: '0'.repeat(64), revision: 0, status: 'running',
    turns: [], sources: [], memories: [], effects: [] };
  const snapshots: CompanionAgentRun[] = [];
  const journal: CompanionAgentJournal = {
    load: async () => structuredClone(saved), valid: async run => run.revision === saved.revision,
    save: async run => { run.revision++; saved = companionAgentRunSchema.parse(structuredClone(run)); snapshots.push(structuredClone(saved)); },
  };
  const reviseFinal: NonNullable<CompanionStructuredAgentInput['reviseFinal']> = async input => {
    expect(input.runId).toBe(saved.id); expect(input.expectedRevision).toBe(saved.revision);
    const next = structuredClone(saved), turn = next.turns[input.step]!;
    expect(input.proposalChecksum).toBe(hash(companionFinalProposalBytes(turn)));
    turn.results = companionFinalProposalReceipt(turn, 'rejected_before_execution', input.proposalChecksum, input.reason);
    next.rejectedFinals = [...next.rejectedFinals ?? [], { step: input.step, proposalChecksum: input.proposalChecksum,
      reason: input.reason, rejectedAt: new Date().toISOString(), activityTaskId: 'controlled_activity', activityStep: 0,
      leaseTokenChecksum: '1'.repeat(64), ...(input.hostObservation ? { hostObservation: input.hostObservation } : {}) }];
    next.revision++; next.status = 'running'; saved = companionAgentRunSchema.parse(next);
    return structuredClone(saved);
  };
  return { journal, reviseFinal, snapshots, read: () => structuredClone(saved) };
}
function call(id: string, value: unknown, name = COMPANION_SUBMIT_RESULT_TOOL): CompanionLoopCall {
  return { id, name, arguments: JSON.stringify(value) };
}
function envelope(format: AiApiFormat, calls: CompanionLoopCall[], text = ''): Response {
  const message = { content: text || null, tool_calls: calls.map(item => ({ id: item.id, type: 'function',
    function: { name: item.name, arguments: item.arguments } })) };
  const body = format === 'openai_chat' ? { choices: [{ message }] }
    : format === 'dashscope_native' ? { output: { choices: [{ message }] } }
      : format === 'openai_responses' ? { output: [...(text ? [{ type: 'message', content: [{ type: 'output_text', text }] }] : []),
        ...calls.map(item => ({ type: 'function_call', call_id: item.id, name: item.name, arguments: item.arguments }))] }
        : format === 'anthropic' ? { content: [...(text ? [{ type: 'text', text }] : []),
          ...calls.map(item => ({ type: 'tool_use', id: item.id, name: item.name, input: JSON.parse(item.arguments) }))] }
          : { candidates: [{ content: { parts: [...(text ? [{ text }] : []), ...calls.map(item => ({
            functionCall: { id: item.id, name: item.name, args: JSON.parse(item.arguments) }, thoughtSignature: 'opaque_' + item.id }))] } }] };
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}
function messages(format: AiApiFormat, wire: Row): Row[] {
  return rows(format === 'gemini_native' ? wire.contents : format === 'openai_responses' ? wire.input
    : format === 'dashscope_native' ? object(wire.input).messages : wire.messages);
}
function definitions(format: AiApiFormat, wire: Row): Row[] {
  const tools = rows(format === 'dashscope_native' ? object(wire.parameters).tools : wire.tools);
  return format === 'gemini_native' ? rows(tools[0]?.function_declarations) : tools.map(tool => object(tool.function ?? tool));
}
function assertNativeHistory(format: AiApiFormat, wire: Row, turn: CompanionLoopTurn) {
  const history = messages(format, wire);
  for (const item of turn.calls) {
    const result = turn.results!.find(value => value.callId === item.id)!;
    if (format === 'openai_chat' || format === 'dashscope_native') {
      expect(history).toContainEqual({ role: 'assistant', content: turn.rawText || null, tool_calls: turn.calls.map(value => ({
        id: value.id, type: 'function', function: { name: value.name, arguments: value.arguments } })) });
      expect(history).toContainEqual({ role: 'tool', tool_call_id: item.id, content: result.content });
    } else if (format === 'openai_responses') {
      expect(history).toContainEqual({ type: 'function_call', call_id: item.id, name: item.name, arguments: item.arguments });
      expect(history).toContainEqual({ type: 'function_call_output', call_id: item.id, output: result.content });
    } else if (format === 'anthropic') {
      expect(history.some(row => row.role === 'assistant' && rows(row.content).some(part => part.type === 'tool_use'
        && part.id === item.id && part.name === item.name && JSON.stringify(part.input) === item.arguments))).toBe(true);
      expect(history.some(row => row.role === 'user' && rows(row.content).some(part => part.type === 'tool_result'
        && part.tool_use_id === item.id && part.content === result.content))).toBe(true);
    } else {
      expect(history.some(row => row.role === 'model' && rows(row.parts).some(part => part.thoughtSignature === 'opaque_' + item.id
        && JSON.stringify(part.functionCall) === JSON.stringify({ id: item.id, name: item.name, args: JSON.parse(item.arguments) })))).toBe(true);
      expect(history.some(row => row.role === 'user' && rows(row.parts).some(part => JSON.stringify(part.functionResponse)
        === JSON.stringify({ id: item.id, name: item.name, response: { result: result.content } })))).toBe(true);
    }
  }
}
function finalFeedback(format: AiApiFormat, wire: Row): Row {
  const last = messages(format, wire).at(-1)!; expect(last.role).toBe('user');
  return object(JSON.parse(String(format === 'gemini_native' ? rows(last.parts)[0]!.text : last.content)).hostValidationFeedback);
}

it.each(formats)('preserves actual native IDs, schema and rejected call/result pairs through %s final correction', async format => {
  const f = journalFixture(), expectedSchema = { ...finalSchema }; delete expectedSchema.$schema;
  const auxiliary = call('actual_read', { action: 'read', id: 'existing' }, 'memory');
  const badShape = call('final_shape', { answer: 7 }), badMeaning = call('final_meaning', { answer: 'UNVERIFIED_DONE' });
  const accepted = call('final_accepted', { answer: 'host-reviewed result' });
  const calls = [auxiliary, badShape, badMeaning, accepted], raw = '这是一份尚未执行的提案。';
  const execute = vi.fn(async () => ({ ok: true, result: 'actual auxiliary receipt' }));
  const validateOutput = vi.fn((value: unknown) => { const parsed = output.parse(value);
    if (parsed.answer === 'UNVERIFIED_DONE') throw new Error('缺少真实完成回执，提案未执行。'); return parsed; });
  let inference = 0;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = object(JSON.parse(String(init?.body))), defs = definitions(format, wire);
    expect(defs.map(tool => tool.name)).toEqual(['memory', 'wait', COMPANION_SUBMIT_RESULT_TOOL]);
    const final = defs.find(tool => tool.name === COMPANION_SUBMIT_RESULT_TOOL)!;
    expect(final.parameters ?? final.parametersJsonSchema ?? final.input_schema).toEqual(expectedSchema);
    if (inference >= 1) assertNativeHistory(format, wire, f.read().turns[0]!);
    if (inference >= 2) {
      const rejected = f.read().turns[inference - 1]!; assertNativeHistory(format, wire, rejected);
      const feedback = finalFeedback(format, wire);
      expect(feedback.rejectedProposalChecksum).toBe(hash(companionFinalProposalBytes(rejected)));
      expect(feedback.error).toBe(f.read().rejectedFinals!.at(-1)!.reason);
      expect(feedback.kind).toBe('validation_rejection');
      expect(feedback.trust).toBe('host_validation_data_not_new_authorization');
    }
    if (!calls[inference]) throw new Error('Unexpected extra inference');
    return envelope(format, [calls[inference++]!], raw);
  });
  expect(await runCompanionStructuredAgent({ context, frame, finalSchema, journal: f.journal, reviseFinal: f.reviseFinal,
    validateOutput, capabilities: { tools: [{ name: 'memory', description: '实际辅助读取', parameters: { type: 'object' } }], execute } },
  { ...config, apiFormat: format }, undefined, { fetchFn })).toEqual({ answer: 'host-reviewed result' });
  const saved = f.read(); expect(saved.status).toBe('done'); expect(fetchFn).toHaveBeenCalledTimes(4);
  expect(execute).toHaveBeenCalledOnce(); expect(validateOutput).toHaveBeenCalledTimes(3);
  expect(saved.effects).toHaveLength(1); expect(saved.effects[0]?.callId).toBe(auxiliary.id);
  expect(saved.rejectedFinals).toHaveLength(2);
  for (const [index, turn] of saved.turns.entries()) {
    expect(turn.rawText).toBe(raw); expect(turn.calls[0]).toEqual({ ...calls[index],
      ...(format === 'gemini_native' ? { thoughtSignature: 'opaque_' + calls[index]!.id } : {}) });
    if (index) expect(turn.finalProposal).toEqual({ callId: calls[index]!.id, schemaDigest: hash(JSON.stringify(expectedSchema)) });
  }
  expect(JSON.parse(saved.turns.at(-1)!.results![0]!.content)).toMatchObject({ status: 'accepted_for_domain_commit' });
});

it.each(['auxiliary-before-final', 'two-final-calls'] as const)('rejects %s before any effect and retains every original call', async mode => {
  const f = journalFixture(), final = call('invalid_final', { answer: 'not executed' });
  const rejected = mode === 'auxiliary-before-final' ? [call('must_not_dispatch', { action: 'read' }, 'memory'), final]
    : [final, call('second_final', { answer: 'also not executed' })];
  const execute = vi.fn(async () => ({ ok: true })); let inference = 0;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    if (inference++) {
      const turn = f.read().turns[0]!; expect(turn.calls).toEqual(rejected);
      expect(turn.results?.map(result => result.callId)).toEqual(rejected.map(item => item.id));
      for (const result of turn.results!) expect(JSON.parse(result.content).status).toBe('rejected_before_execution');
      assertNativeHistory('openai_chat', object(JSON.parse(String(init?.body))), turn);
    }
    return envelope('openai_chat', inference === 1 ? rejected : [call('valid_final', { answer: 'corrected' })]);
  });
  expect(await runCompanionStructuredAgent({ context, frame, finalSchema, journal: f.journal,
    validateOutput: value => output.parse(value), capabilities: { tools: [{ name: 'memory', description: '辅助读取', parameters: {} }], execute } },
  { ...config, apiFormat: 'openai_chat' }, undefined, { fetchFn })).toEqual({ answer: 'corrected' });
  expect(execute).not.toHaveBeenCalled(); expect(f.read().effects).toEqual([]); expect(fetchFn).toHaveBeenCalledTimes(2);
});

it('keeps model-supplied source and note objects in final arguments out of actual evidence', async () => {
  const f = journalFixture(), observed: CompanionExecutionReadset[] = [];
  const proposal = { answer: '仅提交模型拟议输出', memorySources: [{ id: 'forged_source', conversationId: 'room', content: 'FORGED_ONLY' }],
    memories: [{ id: 'forged_note', companionId: 'alice', version: 99, content: 'FORGED_ONLY' }] };
  const execute = vi.fn(async () => ({ ok: true }));
  const fetchFn = vi.fn<typeof fetch>(async () => envelope('openai_chat', [call('final_with_data', proposal)]));
  expect(await runCompanionStructuredAgent({ context, frame, finalSchema, journal: f.journal,
    observeReadset: readset => { observed.push(structuredClone(readset)); }, validateOutput: value => output.parse(value),
    capabilities: { tools: [], execute } }, { ...config, apiFormat: 'openai_chat' }, undefined, { fetchFn })).toEqual(proposal);
  expect(observed.length).toBeGreaterThan(0); expect(JSON.stringify(observed)).not.toContain('forged_');
  expect(f.read().sources).toEqual([]); expect(f.read().memories).toEqual([]); expect(f.read().effects).toEqual([]);
  expect(f.read().turns[0]!.calls[0]!.arguments).toBe(JSON.stringify(proposal)); expect(execute).not.toHaveBeenCalled();
});

it('persists the three native-final validation slots across a non-activity journal restart without reviseFinal', async () => {
  const f = journalFixture(), controller = new AbortController(); let inference = 0;
  const first = vi.fn<typeof fetch>(async () => {
    if (++inference === 3) { controller.abort(); throw new Error('Controlled interruption after two durable rejections'); }
    return envelope('openai_chat', [call('rejected_' + inference, { answer: null })]);
  });
  const input: CompanionStructuredAgentInput = { context, frame, finalSchema, journal: f.journal, validateOutput: value => output.parse(value) };
  await expect(runCompanionStructuredAgent(input, { ...config, apiFormat: 'openai_chat' }, controller.signal, { fetchFn: first }))
    .rejects.toMatchObject({ code: 'CANCELLED' });
  expect(companionFinalValidationFailures(f.read())).toBe(2);
  const before = f.read().turns.map(turn => ({ rawText: turn.rawText, calls: turn.calls, results: turn.results }));
  const resumed = vi.fn<typeof fetch>(async () => envelope('openai_chat', [call('third_rejection', { answer: null })]));
  await expect(runCompanionStructuredAgent(input, { ...config, apiFormat: 'openai_chat' }, undefined, { fetchFn: resumed }))
    .rejects.toBeInstanceOf(Error);
  expect(resumed).toHaveBeenCalledOnce(); expect(companionFinalValidationFailures(f.read())).toBe(3);
  expect(f.read().turns.slice(0, 2).map(turn => ({ rawText: turn.rawText, calls: turn.calls, results: turn.results }))).toEqual(before);
  const noFourth = vi.fn<typeof fetch>();
  await expect(runCompanionStructuredAgent(input, { ...config, apiFormat: 'openai_chat' }, undefined, { fetchFn: noFourth }))
    .rejects.toBeInstanceOf(Error);
  expect(noFourth).not.toHaveBeenCalled(); expect(f.read().status).toBe('running'); expect(f.read().effects).toEqual([]);
});

it('keeps observation invalidation distinct from an incorrect conclusion across a durable restart', async () => {
  const f = journalFixture(), proposal = { answer: '依据原始来源保留当前方案' };
  const input: CompanionStructuredAgentInput = { context, frame, finalSchema, journal: f.journal, reviseFinal: f.reviseFinal,
    finalObservationFingerprint: 'original-authorized-observation', validateOutput: value => output.parse(value) };
  await expect(runCompanionStructuredAgent(input, { ...config, apiFormat: 'openai_chat' }, undefined,
    { fetchFn: async () => envelope('openai_chat', [call('original_final', proposal)]) })).resolves.toEqual(proposal);
  const originalBytes = companionFinalProposalBytes(f.read().turns[0]!);
  const controller = new AbortController(), changed = { ...input, finalObservationFingerprint: 'same-source-new-peer-claim' };
  const inspect = (wire: Row) => {
    const feedback = finalFeedback('openai_chat', wire);
    expect(feedback.kind).toBe('host_observation_changed');
    expect(object(feedback.hostObservation).kind).toBe('host_observation_changed');
    expect(feedback.instruction).toContain('不是格式或语义错误判定');
    expect(feedback.instruction).toContain('可重新提交仍正确的原方案');
    const data = JSON.parse(String(messages('openai_chat', wire)[1]!.content));
    expect(data.outputCorrection.kind).toBe(feedback.kind);
    expect(data.outputCorrection.hostObservation).toEqual(feedback.hostObservation);
  };
  await expect(runCompanionStructuredAgent(changed, { ...config, apiFormat: 'openai_chat' }, controller.signal,
    { fetchFn: async (_url, init) => { inspect(object(JSON.parse(String(init?.body)))); controller.abort(); throw Error('Controlled restart'); } }))
    .rejects.toMatchObject({ code: 'CANCELLED' });
  expect(companionFinalValidationFailures(f.read())).toBe(0);
  expect(f.read().rejectedFinals).toHaveLength(1);
  expect(companionFinalProposalBytes(f.read().turns[0]!)).toBe(originalBytes);
  const resumed = vi.fn<typeof fetch>(async (_url, init) => { inspect(object(JSON.parse(String(init?.body))));
    return envelope('openai_chat', [call('revalidated_unchanged_conclusion', proposal)]); });
  await expect(runCompanionStructuredAgent(changed, { ...config, apiFormat: 'openai_chat' }, undefined, { fetchFn: resumed })).resolves.toEqual(proposal);
  expect(resumed).toHaveBeenCalledOnce(); expect(companionFinalValidationFailures(f.read())).toBe(0);
  expect(f.read().effects).toEqual([]);
});
