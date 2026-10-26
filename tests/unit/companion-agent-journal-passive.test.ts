import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { companionAgentJournal } from '../../src/main/companions/agent-journal';
import { runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionAgentRunSchema, type CompanionAgentRun } from '../../src/shared/companion-agent-run';

const checksum = createHash('sha256').update('原始来源').digest('hex');
const context = { text: 'FROZEN_PASSIVE_FACT', revision: 'old-corpus', profileKey: 'old-model', evidence: {
  capturedAt: '2026-10-26T00:00:00Z', corpusHash: 'old', dependencyCoverage: 'complete' as const, dependencies: [{ id: 'note', version: 1 }],
  snapshotPolicy: 'task_passive_v1' as const, frozenDependencies: [{ id: 'note', sources: [{ id: 'source', conversationId: 'room', checksum }] }] } };
const domain = { system: '返回JSON。', user: JSON.stringify({ purpose: 'journal_passive_test' }) };
const frame = (id = 'invocation'): CompanionReplyInput => ({
  companion: { id: 'owner', name: '伙伴', persona: '自己的稳定角色', description: '', model: '', avatar: 'sister', builtin: false, proactive: false,
    active: true, createdAt: '2026-10-26T00:00:00Z' },
  conversation: { id: 'room', kind: 'private', title: '本入口', memberIds: ['owner'], pinned: false, muted: false, unread: 0,
    updatedAt: '2026-10-26T00:00:00Z', lastMessage: '' }, messages: [], memories: [],
  memoryRecall: { context, reasons: [], pending: false, degraded: false },
  invocation: { id, kind: 'self', companionId: 'owner', conversationId: 'room', goal: '完成本项独立任务', status: 'running',
    createdAt: '2026-10-26T00:00:00Z', participants: ['owner'], messagePort: { kind: 'invocation', messageIds: [] },
    authorization: { kind: 'self', sourceMessageIds: [], externalActions: false } },
});
function storageFixture() {
  const runs = new Map<string, CompanionAgentRun>();
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'agent.run.get') return { ok: true, agentRun: runs.get(command.id) && structuredClone(runs.get(command.id)!) };
    if (command.type === 'agent.run.save') { const run = companionAgentRunSchema.parse(command.run); runs.set(run.id, structuredClone(run)); return { ok: true, agentRun: run }; }
    throw Error('Unexpected journal command ' + command.type);
  });
  return { runs, request };
}

it.each([true, false])('persists one focused or empty passive preparation across journal restart (focused=%s)', async focused => {
  const f = storageFixture(), initial = frame(focused ? 'focused' : 'empty');
  if (!focused) initial.memoryRecall = { reasons: [], pending: false, degraded: false };
  const journal = companionAgentJournal(f.request), run = await journal.load(initial, domain);
  expect(run.memories).toEqual([]);
  expect(run.frozenMemories).toEqual(focused ? context.evidence.frozenDependencies : undefined);
  expect(run.passiveRecall).toEqual({ prepared: true, ...(focused ? { context } : {}) });
  run.turns = [{ text: '真实已确认的一步。', rawText: '真实已确认的一步。', calls: [{ id: 'confirmed_wait', name: 'wait', arguments: '{"ms":1}' }],
    results: [{ callId: 'confirmed_wait', content: '{"ok":true}' }] }];
  await journal.save(run);
  const resumed = frame(initial.invocation!.id);
  resumed.memoryRecall = { reasons: [], pending: false, degraded: false, context: { ...context, text: 'NEW_UNRELATED_RECALL_MUST_NOT_REPLACE_TASK' } };
  const restartedJournal = companionAgentJournal(f.request), restored = await restartedJournal.load(resumed, domain);
  expect(restored.passiveRecall).toEqual(run.passiveRecall);
  const execute = vi.fn(async () => ({ ok: true })), observed = vi.fn();
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)), text = JSON.stringify(wire.messages);
    expect(text).not.toContain('NEW_UNRELATED_RECALL_MUST_NOT_REPLACE_TASK');
    if (focused) expect(text).toContain('FROZEN_PASSIVE_FACT'); else expect(text).not.toContain('FROZEN_PASSIVE_FACT');
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"completed":true}' } }] }));
  });
  await expect(runCompanionStructuredAgent({ context: domain, frame: resumed, refresh: async () => resumed,
    capabilities: { tools: [], execute, journal: restartedJournal }, observeReadset: observed },
  { apiFormat: 'openai_chat', model: 'fixture', apiKey: 'test', baseUrl: 'https://provider.invalid' }, undefined, { fetchFn }))
    .resolves.toEqual({ completed: true });
  expect(fetchFn).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
  expect(observed).toHaveBeenCalledWith(expect.objectContaining({ memories: [], ...(focused ? { frozenMemories: context.evidence.frozenDependencies } : {}) }));
  expect(f.runs.get(run.id)!.turns[0]).toEqual(run.turns[0]);
});
