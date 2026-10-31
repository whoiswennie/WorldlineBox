import { companionAgentRunSchema } from '../../src/shared/companion-agent-run';
import type { CompanionAgentRun } from '../../src/shared/companion-agent-run';
import type { CompanionAgentJournal } from '../../src/main/companions/agent-journal';
import type { CompanionContextFrame } from '../../src/shared/companion-cognition';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { activityDecisionSchema } from '../../src/shared/companion-activity-task';
import type { Companion, CompanionConversation, CompanionMessage } from '../../src/shared/companions';
import { assembleCompanionRoleContext, companionRecallCapabilities, companionTaskInvocation, runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import type { CompanionTopic } from '../../src/shared/companion-topic';
import { createHash } from 'node:crypto';
import { companionThoughtCapabilities } from '../../src/main/companions/thought-capabilities';
import { buildCompanionContext } from '../../src/main/companions/context';
import { COMPANION_DSH_TOOL } from '../../src/shared/companion-dsh-tool';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const companion: Companion = { id: 'a', name: '小澄', description: '妹妹', persona: '平静，认真核对事实。你是小澄，姐姐是小岚，用户是独立真人。',
  model: '', avatar: 'sister', builtin: false, proactive: false, active: true, createdAt: '2026-10-22T00:00:00Z' };
const conversation = (id: string, memberIds = ['a', 'b']): CompanionConversation => ({ id, kind: 'group', title: id, memberIds,
  pinned: false, muted: false, unread: 0, updatedAt: '2026-10-22T00:00:00Z', lastMessage: '' });
const message = (id: string, room: string, authorId: string, content: string, sequence = 1): CompanionMessage => ({ id, conversationId: room,
  authorId, sequence, content, kind: 'text', status: 'sent', attachments: [], createdAt: '2026-10-22T00:00:00Z' });
const config = { apiFormat: 'openai_chat' as const, model: 'test-model', baseUrl: 'https://test.invalid/v1', apiKey: 'synthetic-only' };
const domain = { system: '只输出JSON {answer:string}。', user: JSON.stringify({ purpose: 'isolation_test', messages: [{ content: 'DOMAIN_WINDOW_MUST_NOT_OVERRIDE' }] }) };
const currentWorldTool = { name: 'world', description: '当前联系人查询', parameters: z.toJSONSchema(z.object({ action: z.literal('query'), category: z.literal('contacts') })) };

function durableRepairJournal(initial?: CompanionAgentRun) {
  let persisted = initial ?? companionAgentRunSchema.parse({ id: 'repair_run', companionId: 'a', conversationId: 'group', invocationId: 'repair_invocation',
    requestDigest: '0'.repeat(64), revision: 0, status: 'running', turns: [], sources: [], memories: [], effects: [] });
  const journal: CompanionAgentJournal = { load: async () => structuredClone(persisted), valid: async () => true,
    save: async run => { persisted = companionAgentRunSchema.parse(structuredClone({ ...run, revision: run.revision + 1 })); run.revision = persisted.revision; } };
  return { journal, read: () => structuredClone(persisted) };
}

describe('durable final-output repair', () => {
  it.each(['profile', 'prompt', 'revocation'] as const)('binds repair to the sent frame and cancels recovery after %s changes', async changed => {
    const state = durableRepairJournal(), shape = z.object({ answer: z.string() });
    const repairInputs: Array<{ structuredRepair: { rootInvocationId: string }; originalRequest: { system: string; user: string } }> = [];
    let epoch = 3, profileRevision = '1'.repeat(64), promptRevision = '2'.repeat(64);
    const resolve = vi.fn(async (context: { system: string; user: string }) => {
      const user = JSON.stringify({ ...JSON.parse(context.user), exactProviderInput: 'ACTUAL_PORT_ONLY' });
      const frame: CompanionContextFrame = { schema: 'worldlinebox.companion-context-v2', companionId: 'a', purpose: 'isolation_test',
        profileRevision, promptRevision, revocationEpoch: epoch, conversationId: 'group',
        invocationId: 'actually_sent_invocation', identity: companion.persona, roleGuidance: '已发布指导', processorContract: context.system, input: user,
        sourceRefs: [{ artifactId: 'source:actual', contentRevision: 1, contentHash: '3'.repeat(64) }] };
      return { system: context.system + '\nACTUAL_PROVIDER_SYSTEM', user, frame };
    });
    const globalResolver = async (context: { system: string; user: string }) => {
      const current = await resolve(context); return { ...current, frame: { ...current.frame, purpose: 'companion_structured_repair' } };
    };
    const currentConfig = { ...config, ownerId: 'a', resolveAssetContext: resolve,
      resolveStructuredRepairConfig: async () => ({ ...config, ownerId: 'a', model: 'global-repair-model', resolveAssetContext: globalResolver }) };
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      if (fetchFn.mock.calls.length === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":12}' } }] }));
      repairInputs.push(JSON.parse(wire.messages[1].content));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"核对完成"}' } }] }));
    });
    const input = { context: domain, responseSchema: shape, journal: state.journal,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] } };
    await expect(runCompanionStructuredAgent(input, currentConfig, undefined, { fetchFn })).resolves.toEqual({ answer: '核对完成' });
    const actualResolved = await resolve.mock.results[0]!.value;
    expect(repairInputs).toHaveLength(1); expect(repairInputs[0]!.structuredRepair.rootInvocationId).toBe('actually_sent_invocation');
    expect(repairInputs[0]!.originalRequest).toMatchObject({ system: actualResolved.system, user: actualResolved.user });
    expect(JSON.parse(String(fetchFn.mock.calls[1]![1]?.body)).tools).toBeUndefined();
    const receipt = state.read().turns.at(-1)!.structuredRepair!;
    expect(receipt.rootContext?.frame).toMatchObject({ invocationId: 'actually_sent_invocation', revocationEpoch: 3,
      sourceRefs: [{ artifactId: 'source:actual', contentRevision: 1, contentHash: '3'.repeat(64) }] });
    expect(receipt.rootContext?.frame).toEqual(actualResolved.frame);
    if (changed === 'profile') profileRevision = '4'.repeat(64);
    else if (changed === 'prompt') promptRevision = '5'.repeat(64); else epoch++;
    await expect(runCompanionStructuredAgent(input, currentConfig, undefined, { fetchFn })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('refuses to repair a pending production turn whose original sent frame was not saved', async () => {
    const saved = durableRepairJournal().read(); saved.turns = [{ text: '', rawText: '{"answer":12}', calls: [],
      structuredRepair: { originalHash: createHash('sha256').update('{"answer":12}').digest('hex'), attempts: 1 } }];
    const state = durableRepairJournal(saved), fetchFn = vi.fn<typeof fetch>(), resolver = vi.fn(async (context: { system: string; user: string }) => context);
    await expect(runCompanionStructuredAgent({ context: domain, journal: state.journal, responseSchema: z.object({ answer: z.string() }),
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] } }, { ...config, resolveAssetContext: resolver }, undefined, { fetchFn }))
      .rejects.toThrow('实际已发送');
    expect(fetchFn).not.toHaveBeenCalled(); expect(resolver).not.toHaveBeenCalled();
  });

  it('persists the successful schema repair and resumes without paying again or replaying a confirmed capability', async () => {
    const state = durableRepairJournal(), original = '{"answer":12}', repaired = '{"answer":"经结构修复的回答"}';
    const execute = vi.fn(async () => ({ ok: true, source: 'actual fixture capability receipt' }));
    const shape = z.object({ answer: z.string() }), guard = vi.fn((value: unknown) => shape.parse(value));
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      if (fetchFn.mock.calls.length === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'read_once', type: 'function',
        function: { name: 'world', arguments: '{"action":"query","category":"contacts"}' } }] } }] }));
      if (fetchFn.mock.calls.length === 2) return new Response(JSON.stringify({ choices: [{ message: { content: original } }] }));
      expect(wire.model).toBe('global-repair-model'); expect(wire.tools).toBeUndefined();
      expect(state.read().turns.at(-1)?.structuredRepair).toEqual({ originalHash: createHash('sha256').update(original).digest('hex'), attempts: 1 });
      return new Response(JSON.stringify({ choices: [{ message: { content: repaired } }] }));
    });
    let interrupted = true;
    const input = { context: domain, responseSchema: shape, journal: state.journal,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] },
      capabilities: { tools: [currentWorldTool], execute },
      validateOutput: (value: unknown) => { const checked = guard(value); if (interrupted) throw new Error('模拟修复收据保存后领域尚未提交'); return checked; } };
    const currentConfig = { ...config, resolveStructuredRepairConfig: async () => ({ ...config, model: 'global-repair-model' }) };
    await expect(runCompanionStructuredAgent(input, currentConfig, undefined, { fetchFn })).rejects.toThrow('领域尚未提交');
    const saved = state.read(), final = saved.turns.at(-1)!;
    expect(saved.status).toBe('running'); expect(final.rawText).toBe(original); expect(final.calls).toEqual([]);
    expect(final.structuredRepair).toMatchObject({ attempts: 1, content: repaired, contentHash: createHash('sha256').update(repaired).digest('hex') });
    interrupted = false;
    await expect(runCompanionStructuredAgent(input, currentConfig, undefined, { fetchFn })).resolves.toEqual({ answer: '经结构修复的回答' });
    expect(fetchFn).toHaveBeenCalledTimes(3); expect(execute).toHaveBeenCalledOnce(); expect(guard).toHaveBeenCalledTimes(2);
    expect(state.read().status).toBe('done');
  });

  it('preserves the two-attempt limit across restart after both schema repairs fail', async () => {
    const state = durableRepairJournal(), shape = z.object({ answer: z.string() });
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      if (fetchFn.mock.calls.length > 1) { expect(wire.tools).toBeUndefined(); expect(state.read().turns.at(-1)?.structuredRepair?.attempts).toBe(fetchFn.mock.calls.length - 1); }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":12}' } }] }));
    });
    const input = { context: domain, responseSchema: shape, journal: state.journal,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] } };
    await expect(runCompanionStructuredAgent(input, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(state.read().turns.at(-1)?.structuredRepair?.attempts).toBe(2);
    await expect(runCompanionStructuredAgent(input, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('never turns supplied learning claims into an empty success and persists the bounded failed repair cycle', async () => {
    const state = durableRepairJournal(), original = JSON.stringify({ claims: [{ text: '原材料已有珍贵主张', evidence: [{ sourceId: 'source_actual', quote: '实际读到的原句' }] }], valid: 12 });
    const responseSchema = z.object({ claims: z.array(z.object({ text: z.string(), evidence: z.array(z.object({ sourceId: z.string(), quote: z.string() })) })), valid: z.boolean() });
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      if (fetchFn.mock.calls.length === 1) return new Response(JSON.stringify({ choices: [{ message: { content: original } }] }));
      const repair = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      expect(repair.originalOutput).toBe(original);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"claims":[],"valid":true}' } }] }));
    });
    const validateOutput = vi.fn(), input = { context: domain, responseSchema, repairPreserveCollections: [{ path: ['claims'], fields: ['text', 'evidence'] }],
      journal: state.journal, frame: { companion, conversation: conversation('group'), messages: [], memories: [] }, validateOutput };
    await expect(runCompanionStructuredAgent(input, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(state.read().turns.at(-1)).toMatchObject({ rawText: original, structuredRepair: { attempts: 2 } });
    expect(state.read().turns.at(-1)?.structuredRepair).not.toHaveProperty('content');
    await expect(runCompanionStructuredAgent(input, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetchFn).toHaveBeenCalledTimes(3); expect(validateOutput).not.toHaveBeenCalled();
  });

  it('revalidates conservation of a saved successful repair before accepting its content after restart', async () => {
    const original = '{"claims":[{"text":"不可丢失的原始结论","evidence":[{"sourceId":"actual","quote":"原句"}]}],"valid":12}',
      content = '{"claims":[],"valid":true}', saved = durableRepairJournal().read();
    saved.turns = [{ text: '', rawText: original, calls: [], structuredRepair: { originalHash: createHash('sha256').update(original).digest('hex'),
      attempts: 1, content, contentHash: createHash('sha256').update(content).digest('hex') } }];
    const state = durableRepairJournal(saved), fetchFn = vi.fn<typeof fetch>(), validateOutput = vi.fn();
    await expect(runCompanionStructuredAgent({ context: domain, journal: state.journal,
      responseSchema: z.object({ claims: z.array(z.unknown()), valid: z.boolean() }),
      repairPreserveCollections: [{ path: ['claims'], fields: ['text', 'evidence'] }], validateOutput,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] } }, config, undefined, { fetchFn }))
      .rejects.toThrow('没有保留原提案');
    expect(fetchFn).not.toHaveBeenCalled(); expect(validateOutput).not.toHaveBeenCalled();
  });

  it('never restores an old repaired value that erased a declared original semantic action', async () => {
    const original = '{"action":{"action":"visit","targetCompanionId":"b"}}', content = '{"action":null,"reason":"删除行动以通过格式检查"}', saved = durableRepairJournal().read();
    saved.turns = [{ text: '', rawText: original, calls: [], structuredRepair: { originalHash: createHash('sha256').update(original).digest('hex'), attempts: 1,
      content, contentHash: createHash('sha256').update(content).digest('hex') } }];
    const state = durableRepairJournal(saved), fetchFn = vi.fn<typeof fetch>(), validateOutput = vi.fn();
    await expect(runCompanionStructuredAgent({ context: domain, journal: state.journal, responseSchema: z.object({ action: z.unknown(), reason: z.string() }),
      repairPreserveValues: [{ path: ['action'] }], validateOutput, frame: { companion, conversation: conversation('group'), messages: [], memories: [] } }, config, undefined, { fetchFn }))
      .rejects.toThrow('没有保留原提案');
    expect(fetchFn).not.toHaveBeenCalled(); expect(validateOutput).not.toHaveBeenCalled();
  });

  it.each(['originalHash', 'contentHash'] as const)('refuses a changed %s on a saved successful repair without making another request', async field => {
    const original = '{"answer":12}', content = '{"answer":"已经修复"}';
    const saved = durableRepairJournal().read();
    saved.turns = [{ text: '', rawText: original, calls: [], structuredRepair: {
      originalHash: createHash('sha256').update(original).digest('hex'), attempts: 1, content,
      contentHash: createHash('sha256').update(content).digest('hex'), [field]: 'f'.repeat(64),
    } }];
    const state = durableRepairJournal(saved), fetchFn = vi.fn<typeof fetch>(), validateOutput = vi.fn();
    await expect(runCompanionStructuredAgent({ context: domain, journal: state.journal, responseSchema: z.object({ answer: z.string() }), validateOutput,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] } }, config, undefined, { fetchFn }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetchFn).not.toHaveBeenCalled(); expect(validateOutput).not.toHaveBeenCalled();
  });

  it('keeps the domain authority gate after a shape repair and never sends its refusal to the repair model', async () => {
    const shape = z.object({ target: z.string() }), execute = vi.fn();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"target":12}' } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"target":"other_owner_private_port"}' } }] })));
    const validateOutput = vi.fn(() => { throw new Error('当前来源没有这个伙伴的权限'); });
    await expect(runCompanionStructuredAgent({ context: domain, responseSchema: shape,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] }, validateOutput,
      capabilities: { tools: [], execute } }, config, undefined, { fetchFn })).rejects.toThrow('没有这个伙伴的权限');
    expect(fetchFn).toHaveBeenCalledTimes(2); expect(validateOutput).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
  });
});

describe('same role Agent kernel across independent invocation ports', () => {
  it('projects the actual cognitive DSH binding without chat file operations or a virtual computer prerequisite', async () => {
    const baseFrame = { companion, conversation: conversation('group'), messages: [], memories: [] };
    const ordinary = buildCompanionContext(baseFrame).system;
    expect(ordinary).toContain(COMPANION_DSH_TOOL.description);
    expect(ordinary).not.toContain('可选择压缩时间'); expect(ordinary).not.toContain('现实20分钟对应世界一天');
    const run = vi.fn(), capabilities = companionThoughtCapabilities({ tools: [], execute: vi.fn() }, { run });
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const wire = JSON.parse(String(init?.body)), system = wire.messages[0].content;
      expect(wire.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['dsh', 'wait']);
      expect(system).toContain('当前dsh是独立纯思考扩展');
      expect(system).not.toContain(COMPANION_DSH_TOOL.description);
      expect(system).not.toContain('dsh(operation=read_file/read_image)');
      expect(system).not.toContain('仍须先可见移动到有使用权的空电脑并坐稳');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"依据本入口资料决定下一步"}' } }] }));
    });
    await expect(runCompanionStructuredAgent({ context: domain, frame: baseFrame, capabilities }, config, undefined, { fetchFn }))
      .resolves.toEqual({ answer: '依据本入口资料决定下一步' });
    expect(run).not.toHaveBeenCalled();
  });
  it('distinguishes host-validated final action proposals from the unchanged native recall tool list', async () => {
    const source = message('source', 'group', 'user', '请和认识的伙伴一起组织活动。');
    const proposed = { status: 'continue', action: { action: 'create_group', recipientIds: ['b', 'c'],
      title: '共同活动', text: '愿意的话一起商量活动。' }, wait: null, summary: '提交建群邀约提案，尚未执行。' };
    const execute = vi.fn(async () => ({ ok: true }));
    const validateOutput = vi.fn((value: unknown) => activityDecisionSchema.parse(value));
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content);
      expect(wire.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['wait']);
      expect(data.capabilityAvailability).toMatchObject({ companionId: 'a', conversationId: 'group', boundToolNames: ['wait'] });
      expect(data.identity.self.id).toBe('a'); expect(data.source.content).toBe(source.content);
      expect(data.executionContract).toEqual({ finalProposalIsNotExecution: true });
      expect(data.outputSchema).toEqual(z.toJSONSchema(activityDecisionSchema, { io: 'input' }));
      expect(wire.messages[0].content).toContain('不需要存在同名原生工具');
      expect(wire.messages[0].content).toContain('未提供的字段和行动仍不获授权');
      expect(wire.messages[0].content).toContain('单个完整JSON对象，不附解释正文或Markdown代码块');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposed) } }] }));
    });
    const result = await runCompanionStructuredAgent({ context: { system: '本领域最终行动必须通过原schema与宿主权限核验。',
      user: JSON.stringify({ purpose: 'activity_test', executionContract: { finalProposalIsNotExecution: true },
        outputSchema: z.toJSONSchema(activityDecisionSchema, { io: 'input' }) }) },
      frame: { companion, conversation: conversation('group'), sourceMessage: source, messages: [source], memories: [] },
      capabilities: { tools: [{ name: 'memory', description: '只读本人记忆', parameters: { type: 'object' } }], execute }, validateOutput },
    config, undefined, { fetchFn });
    expect(result).toEqual(proposed); expect(validateOutput).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
  });
  it('bounds global repair of prose-prefixed JSON at two attempts without extracting or executing its proposal', async () => {
    const malformed = '这一步没有执行。\n```json\n{"status":"blocked","action":null,"wait":{"kind":"delay","seconds":60},"summary":"等待"}\n```';
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      if (fetchFn.mock.calls.length > 1) {
        expect(data.purpose).toBe('companion_structured_repair');
        expect(data.invalidOutput).toBe(malformed);
        expect(data.structuredRepair.attempt).toBe(fetchFn.mock.calls.length - 1);
        expect(JSON.parse(String(init?.body)).tools).toBeUndefined();
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: malformed } }] }));
    });
    const execute = vi.fn(async () => ({ ok: true })), validateOutput = vi.fn((value: unknown) => activityDecisionSchema.parse(value));
    await expect(runCompanionStructuredAgent({ context: domain,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] }, validateOutput,
      capabilities: { tools: [], execute } }, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetchFn).toHaveBeenCalledTimes(3); expect(validateOutput).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(activityDecisionSchema.safeParse({ status: 'blocked', action: null, wait: { kind: 'delay', seconds: 60 }, summary: '等待' }).success).toBe(false);
  });
  it('awaits a semantic final-proposal review before committing the final turn and evaluates an accepted turn only once', async () => {
    const validateOutput = vi.fn(async (value: unknown) => {
      await new Promise(resolve => setImmediate(resolve));
      if ((value as { unsafe?: boolean }).unsafe) throw new Error('共享状态含私密内容，原提案未写入。');
      return value;
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"unsafe":true}' } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"safe":true}' } }] })));
    const result = await runCompanionStructuredAgent({ context: domain, validateOutput,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] } }, config, undefined, { fetchFn });
    expect(result).toEqual({ safe: true }); expect(validateOutput).toHaveBeenCalledTimes(2);
    const data = JSON.parse(JSON.parse(String(fetchFn.mock.calls[1]![1]?.body)).messages[1].content);
    expect(data.outputCorrection.error).toContain('私密内容');
  });
  it('sends an extra root closure to the separate global repair port while preserving the original evidence', async () => {
    const malformed = '{"answer":{"detail":"PRIVATE_MODEL_VALUE🧭"}},"next":true}';
    const fetchFn = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
      const wire = JSON.parse(String(init?.body));
      if (fetchFn.mock.calls.length > 1) {
        const repair = JSON.parse(wire.messages[1].content);
        expect(repair.purpose).toBe('companion_structured_repair');
        expect(repair.invalidOutput).toBe(malformed);
        expect(repair.validationErrors).toEqual([expect.objectContaining({ code: 'invalid_json' })]);
        expect(JSON.stringify(repair.validationErrors)).not.toContain('PRIVATE_MODEL_VALUE');
        expect(JSON.stringify(repair.originalRequest)).toContain('isolation_test');
        expect(wire.tools).toBeUndefined();
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: fetchFn.mock.calls.length < 3 ? malformed : '{"answer":"已重新生成合法对象"}' } }] }));
    });
    expect(await runCompanionStructuredAgent({ context: domain,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] } }, config, undefined, { fetchFn }))
      .toEqual({ answer: '已重新生成合法对象' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it('rejects hallucinated memory namespaces despite adapter injection and completes from initial context', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    let calls = 0;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
      const wire = JSON.parse(String(init?.body));
      expect(wire.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['wait']);
      if (++calls === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [
        { id: 'unoffered_search', type: 'function', function: { name: 'memory', arguments: '{"action":"search","query":"same"}' } },
        { id: 'unoffered_read', type: 'function', function: { name: 'memory.read', arguments: '{"id":"same"}' } },
      ] } }] }));
      expect(wire.messages.filter((row: { role: string; content?: string }) => row.role === 'tool' && row.content?.includes('MEMORY_TOOL_DISABLED'))).toHaveLength(2);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"依照系统初始回忆回答。"}' } }] }));
    });
    await expect(runCompanionStructuredAgent({ context: domain,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] }, capabilities: {
        replaySafe: true, tools: [{ name: 'memory', description: 'injected', parameters: { type: 'object' } },
          { name: 'memory.read', description: 'injected dotted', parameters: { type: 'object' } }], execute } }, config, undefined, { fetchFn }))
      .resolves.toEqual({ answer: '依照系统初始回忆回答。' });
    expect(execute).not.toHaveBeenCalled(); expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it('does not allow personal experience recall to replace a retired memory tool', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    let calls = 0;
    const fetchFn = vi.fn<typeof fetch>(async (): Promise<Response> => ++calls === 1
      ? new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'unoffered_experience', type: 'function',
        function: { name: 'world', arguments: '{"action":"experience","parameters":{"action":"list"}}' } }] } }] }))
      : new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"未主动回顾个人经历。"}' } }] })));
    await expect(runCompanionStructuredAgent({ context: domain, frame: { companion, conversation: conversation('group'), messages: [], memories: [] },
      capabilities: { tools: [currentWorldTool], execute } }, config, undefined, { fetchFn })).resolves.toEqual({ answer: '未主动回顾个人经历。' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('retains current world actions with host-only recall so an invited reader can join before final delivery', async () => {
    const source = { ...message('invitation', 'group', 'b', '愿意的话加入共同讨论。'), topicId: 'discussion' };
    let topic: CompanionTopic = { id: 'discussion', conversationId: 'group', title: '共同讨论', kind: 'discussion', status: 'active',
      participantIds: ['b'], invitedIds: ['a'], moderatorId: 'b', tags: [], revision: 1, createdAt: source.createdAt, updatedAt: source.createdAt };
    const frame = (): CompanionReplyInput => ({ companion, conversation: conversation('group'), sourceMessage: source,
      messages: [source], memories: [], topic, audience: 'peers' });
    let inference = 0;
    const execute = vi.fn(async (call: { name: string; arguments: string }) => {
      if (call.name === 'memory') return { ok: true, memoryPage: { items: [], hasMore: false }, memoryRetrieval: {
        authorizedCorpusEmpty: true, authorizedCorpusRevision: 'empty-discussion-owner', engine: 'none', resultCount: 0 } };
      expect(call.name).toBe('world');
      expect(JSON.parse(call.arguments)).toEqual({ action: 'topic', parameters: { action: 'join', topicId: 'discussion' } });
      topic = { ...topic, participantIds: ['a', 'b'], invitedIds: [], revision: 2 };
      return { ok: true, topic };
    });
    let providerAssertion: unknown;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => { try {
      const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content);
      inference++;
      expect(wire.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['world', 'wait']);
      expect(data.capabilityAvailability.boundToolNames).toEqual(['world', 'wait']);
      if (inference === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'own_join',
        type: 'function', function: { name: 'world', arguments: '{"action":"topic","parameters":{"action":"join","topicId":"discussion"}}' } }] } }] }));
      expect(inference).toBe(2);
      expect(data.topic.participantIds).toContain('a');
      expect(wire.messages.filter((row: { role: string }) => row.role === 'tool')).toHaveLength(1);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"我已加入讨论。"}' } }] }));
    } catch (error) { providerAssertion = error; throw error; } });
    const result = await runCompanionStructuredAgent({ context: domain, frame: frame(), refresh: async () => frame(),
      capabilities: { replaySafe: true, tools: [{ name: 'memory', description: '本人记忆', parameters: { type: 'object' } },
        // Production policy projects only concrete offered world actions.
        { name: 'world', description: '本人实际加入话题', parameters: z.toJSONSchema(z.object({ action: z.literal('topic'),
          parameters: z.object({ action: z.literal('join'), topicId: z.string() }) })) }], execute },
      validateOutput: value => { expect(topic.participantIds).toContain('a'); return value; } }, config, undefined, { fetchFn }).catch(error => { throw providerAssertion ?? error; });
    expect(result).toEqual({ answer: '我已加入讨论。' });
    expect(execute.mock.calls.filter(([call]) => call.name === 'memory')).toHaveLength(0);
    expect(execute.mock.calls.filter(([call]) => call.name === 'world')).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it('compresses an actual rejected work pair and retries the same inference without replaying its effect or shrinking identity and goal', async () => {
    const source = message('source', 'group', 'user', '保留这个完整目标：核验record_701，完成后只汇报真实结论。');
    const frame = (): CompanionReplyInput => ({ companion, conversation: conversation('group'), messages: [source], sourceMessage: source, memories: [] });
    const execute = vi.fn(async () => ({ ok: true, recordId: 'record_701', output: 'large real result '.repeat(600) }));
    const purposes: string[] = [], wires: unknown[] = [];
    let inference = 0;
    const fetchFn: typeof fetch = async (_url, init) => {
      const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content); wires.push(wire); purposes.push(data.purpose);
      if (data.purpose === 'companion_loop_compaction') {
        expect(data.steps).toHaveLength(1); expect(data.steps[0].results[0].content).toContain('record_701');
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '已经核验真实回执record_701；不得重执行。', stage: '汇报结果' }) } }] }));
      }
      inference++;
      expect(wire.messages[0].content).toContain(companion.persona);
      expect(wire.messages[0].content).toContain('当前dsh是独立纯思考扩展');
      expect(wire.tools.some((tool: { function: { name: string } }) => tool.function.name === 'dsh')).toBe(true);
      expect(JSON.stringify(data)).toContain(source.content);
      if (inference === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'effect', type: 'function',
        function: { name: 'world', arguments: '{"action":"query","category":"contacts"}' } }] } }] }));
      if (inference === 2) return new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 400 });
      expect(data.loopContinuity.summary).toContain('record_701');
      expect(wire.messages.filter((row: { role: string }) => row.role === 'tool')).toEqual([]);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"已依据真实record_701核验。"}' } }] }));
    };
    const result = await runCompanionStructuredAgent({ context: domain, frame: frame(), refresh: async () => frame(),
      capabilities: companionThoughtCapabilities({ replaySafe: true,
        tools: [currentWorldTool], execute }, { run: vi.fn() }) }, config, undefined, { fetchFn });
    expect(result).toEqual({ answer: '已依据真实record_701核验。' }); expect(execute).toHaveBeenCalledOnce();
    expect(purposes).toEqual(['isolation_test', 'isolation_test', 'companion_loop_compaction', 'isolation_test']); expect(wires).toHaveLength(4);
  });
  it('fails an indivisible current source after one rejected request instead of paying for identical retries', async () => {
    const source = message('source', 'group', 'user', '完整不可静默截断的当前来源。'.repeat(3000));
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 400 }));
    await expect(runCompanionStructuredAgent({ context: domain, frame: { companion, conversation: conversation('group'),
      messages: [source], sourceMessage: source, memories: [] } }, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'CONTEXT_CAPACITY' });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
  it('repairs a rejected topic admission inside the same loop before actually joining and publishing', async () => {
    const source = { ...message('invitation', 'group', 'b', '愿意的话加入游戏。'), topicId: 'game' };
    let topic: CompanionTopic = { id: 'game', conversationId: 'group', title: '共同游戏', kind: 'game', status: 'active',
      participantIds: ['b'], invitedIds: ['a'], moderatorId: 'b', tags: [], revision: 1, createdAt: source.createdAt, updatedAt: source.createdAt };
    const frame = (): CompanionReplyInput => ({ companion, conversation: conversation('group'), sourceMessage: source,
      messages: [source], memories: [], topic, audience: 'peers' });
    const execute = vi.fn(async () => { topic = { ...topic, participantIds: ['a', 'b'], invitedIds: [], revision: 2 }; return { ok: true, topic }; });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'REJECTED_UNJOINED_SPEECH' } }] })))
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages[0].content).toContain('"action":"topic","parameters":{"action":"join","topicId":"game"}');
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'actual_join', type: 'function',
          function: { name: 'world', arguments: '{"action":"topic","parameters":{"action":"join","topicId":"game"}}' } }] } }] }));
      }).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"我已自己加入。"}' } }] })));
    const result = await runCompanionStructuredAgent({ context: domain, frame: frame(), refresh: async () => frame(),
      capabilities: { tools: [{ name: 'world', description: '本人自主加入话题', parameters: { type: 'object' } }], execute } }, config, undefined, { fetchFn });
    expect(result).toEqual({ answer: '我已自己加入。' }); expect(execute).toHaveBeenCalledTimes(1); expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(String(fetchFn.mock.calls[2]![1]?.body)).not.toContain('REJECTED_UNJOINED_SPEECH');
    expect(topic.participantIds).toContain('a');
  });
  it('rejects a well-formed illegal proposal through the original author without invoking format repair', async () => {
    const source = message('source', 'group', 'user', '只选择当前可用的目标。');
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"target":"other_topic"}' } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"target":"current_topic"}' } }] })));
    const result = await runCompanionStructuredAgent({ context: domain, frame: { companion, conversation: conversation('group'),
      messages: [source], sourceMessage: source, memories: [] }, validateOutput: value => {
      if ((value as { target: string }).target !== 'current_topic') throw new Error('只有current_topic合法，提案没有产生行动。');
      return value;
    } }, config, undefined, { fetchFn });
    expect(result).toEqual({ target: 'current_topic' });
    const wire = JSON.parse(JSON.parse(String(fetchFn.mock.calls[1]![1]?.body)).messages[1].content);
    expect(wire.outputCorrection.error).toContain('只有current_topic合法'); expect(wire.identity.self.id).toBe('a');
    expect(wire.messages.map((row: { id: string }) => row.id)).toEqual([source.id]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(wire.purpose).toBe('isolation_test');
  });
  it('does not allow a domain payload, another room or another task to replace short term messages', () => {
    const a = message('m_a', 'peer_b', 'b', 'B_PORT_ONLY');
    const other = message('m_c', 'peer_c', 'c', 'C_SECRET_NEVER_VISIBLE');
    const frame: CompanionReplyInput = { companion, conversation: conversation('peer_b'), messages: [a, other], sourceMessage: a, memories: [], audience: 'peers',
      invocation: { ...companionTaskInvocation({ companion, conversationId: 'peer_b', id: 'run_a', kind: 'peer', goal: '回答B', createdAt: a.createdAt }),
        messagePort: { kind: 'conversation' } } };
    const result = assembleCompanionRoleContext(frame, domain);
    expect(result.user).toContain('B_PORT_ONLY');
    expect(result.user).not.toContain('C_SECRET_NEVER_VISIBLE');
    expect(result.user).not.toContain('DOMAIN_WINDOW_MUST_NOT_OVERRIDE');
    const ownTask = assembleCompanionRoleContext({ ...frame, invocation: companionTaskInvocation({ companion, conversationId: 'peer_b', id: 'different_task',
      kind: 'activity', goal: '自己散步', createdAt: a.createdAt }), sourceMessage: undefined }, domain);
    expect(JSON.parse(ownTask.user).messages).toEqual([]);
    expect(ownTask.user).not.toContain('B_PORT_ONLY');
  });

  it('rebuilds self and actual speaker separately for each member in the same group', () => {
    const source = message('user_msg', 'group', 'user', '我是玩家，不是姐姐。');
    const frame = { companion, conversation: conversation('group'), messages: [source], sourceMessage: source, memories: [],
      members: [{ id: 'b', name: '小岚', description: '姐姐' }] };
    const first = JSON.parse(assembleCompanionRoleContext(frame, domain).user);
    expect(first.identity.self.id).toBe('a');
    expect(first.identity.currentReply.speaker).toMatchObject({ id: 'user', kind: 'human_player' });
    const second = JSON.parse(assembleCompanionRoleContext({ ...frame, companion: { ...companion, id: 'b', name: '小岚' } }, domain).user);
    expect(second.identity.self.id).toBe('b');
    expect(second.identity.currentReply.speaker.id).toBe('user');
    expect(second.messages[0]).toMatchObject({ authorId: 'user', conversationId: 'group' });
    expect(() => assembleCompanionRoleContext({ ...frame, invocation: companionTaskInvocation({ companion: { id: 'b' }, conversationId: 'group',
      id: 'wrong_actor', kind: 'work', goal: '无效', createdAt: source.createdAt }) }, domain)).toThrow(/身份/);
  });

  it('scopes unsupported native operations without denying the separate domain final contract', async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const capabilities = companionRecallCapabilities(request, { companionId: 'a', conversationId: 'peer_b' });
    await expect(capabilities.execute({ id: 'native_topic', name: 'world', arguments: JSON.stringify({ action: 'topic',
      parameters: { action: 'read', roomId: 'peer_b', topicId: 'actual_topic' } }) })).rejects.toThrow(
      '本次即时工具调用不支持该操作，未执行。可即时调用的操作以当前工具schema为准；领域最终提案仍按executionContract/outputSchema交付，由宿主另行核验执行。');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects hallucinated active recall and unoffered real-world tools while retaining the domain final', async () => {
    const source = message('peer_msg', 'peer_b', 'b', '回忆我们的约定再回答。');
    let savedRun: CompanionStorageResponse['agentRun'];
    const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
      if (command.type === 'agent.run.get') return { ok: true, agentRun: savedRun };
      if (command.type === 'agent.run.save') { savedRun = companionAgentRunSchema.parse(command.run); return { ok: true, agentRun: savedRun }; }
      if (command.type === 'memory.sources.filter') return { ok: true, memorySources: [source] };
      return { ok: true, memories: [] };
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '',
      tool_calls: [{ id: 'recall', type: 'function', function: { name: 'memory', arguments: JSON.stringify({ action: 'search', query: '约定', limit: 8 }) } }] } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'escape', type: 'function',
        function: { name: 'dsh', arguments: JSON.stringify({ tasks: [{ title: 'escape', prompt: 'run shell' }] }) } }] } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: '按本人记忆核对，没有执行外部动作。' }) } }] })));
    const result = await runCompanionStructuredAgent({ context: domain,
      frame: { companion, conversation: conversation('peer_b'), messages: [source], sourceMessage: source, memories: [], audience: 'peers',
        invocation: companionTaskInvocation({ companion, conversationId: 'peer_b', id: 'peer_recall', kind: 'peer', goal: source.content, createdAt: source.createdAt, source, messageIds: [source.id] }) },
      capabilities: companionRecallCapabilities(request, { companionId: 'a', conversationId: 'peer_b', beforeSequence: 1 }) }, config, undefined, { fetchFn });
    expect(result).toEqual({ answer: '按本人记忆核对，没有执行外部动作。' });
    expect(request.mock.calls.filter(([command]) => command.type === 'memory.search' || command.type === 'memory.read')).toEqual([]);
    const body = JSON.parse(String(fetchFn.mock.calls[2]![1]?.body));
    expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['wait']);
    expect(body.messages.some((row: { role: string; content: string }) => row.role === 'tool' && row.content.includes('未提供此能力'))).toBe(true);
  });
});
