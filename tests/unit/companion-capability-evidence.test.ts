import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { verifyCompanionCapabilityEvidence } from '../../src/main/companions/capability-evidence';
import { companionCapabilityRecordId } from '../../src/main/companions/capability-journal';
import type { CompanionAction, CompanionMessage } from '../../src/shared/companions';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { boundaryGrant, boundaryNow, boundaryRun } from './companion-agenda-boundary-fixtures';
import { guardCompanionExecutionSources } from '../../src/main/companions/source-execution-evidence';

function fixture(self = false, name = self ? 'think' : 'memory.search') {
  const invocationId = self ? 'run' : 'source:alice', callId = 'actual_call';
  const action: CompanionAction = { id: companionCapabilityRecordId({ companionId: 'alice', conversationId: 'own_room', invocationId }, callId),
    companionId: 'alice', conversationId: 'own_room', title: '实际能力过程', status: 'succeeded', createdAt: boundaryNow, updatedAt: boundaryNow,
    ...(self ? {} : { sourceMessageId: 'source', parentMessageId: 'reply', loopStep: 0 }),
    capability: { name, callId, invocationId, inputHash: createHash('sha256').update('{}').digest('hex'), ...(self || name === 'observe' ? { agendaRunId: 'run' } : {}) },
    result: '实际返回', events: [{ sequence: 0, type: 'capability.succeeded', summary: '已经返回', receivedAt: boundaryNow }] };
  const message = (id: string, authorId: string, content = '请看看实际安排。'): CompanionMessage => ({ id, sequence: 1, authorId, content, conversationId: 'own_room', kind: 'text', status: 'sent', attachments: [], createdAt: boundaryNow });
  const source = message('source', 'user'), parent = { ...message('reply', 'alice'), replyToId: 'source' };
  const loop: CompanionLoopCheckpoint = { companionId: 'alice', conversationId: 'own_room', sourceMessageId: 'source', messageId: 'reply', status: 'done', supplements: [],
    context: { system: '', user: JSON.stringify({ taskRequest: { sourceMessageId: source.id, prompt: source.content } }) },
    turns: [{ text: '', rawText: '', calls: [{ id: callId, name: name === 'memory.search' ? 'memory' : name,
      arguments: name === 'memory.search' ? '{"action":"search","query":"之前的事"}' : '{}' }], results: [{ callId, content: '{"ok":true}' }] }] };
  const run = { ...boundaryRun(), status: 'completed' as const, activeGrantId: 'grant', activeGrantRevision: 1 };
  const grant = { ...boundaryGrant(), capabilities: ['dsh', 'observe'] as Array<'dsh' | 'observe'> };
  const state = { action, source: source as CompanionMessage | undefined, parent, loop, run, grant, peerOnly: false, memberIds: ['alice'] };
  const commands: string[] = [];
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    commands.push(command.type);
    if (command.type === 'action.get') return { ok: true, action: state.action };
    if (command.type === 'state') return { ok: true, state: { companions: [{ id: 'alice' }], conversations: [{ id: 'own_room', kind: 'private', peerOnly: state.peerOnly, memberIds: state.memberIds }] } as CompanionStorageResponse['state'] };
    if (command.type === 'message.get') return { ok: true, message: state.parent };
    if (command.type === 'loop.for-message') return { ok: true, loop: state.loop };
    if (command.type === 'loop.get') return { ok: true, loop: state.loop };
    if (command.type === 'memory.sources.filter') return { ok: true, memorySources: state.source ? [state.source] : [] };
    if (command.type === 'agenda.run.read') return { ok: true, agendaRun: state.run };
    if (command.type === 'agenda.grants.read') return { ok: true, agendaGrants: [state.grant] };
    throw new Error('Unexpected visibility command: ' + command.type);
  });
  const verify = (validateParentLoop?: (loop: CompanionLoopCheckpoint, action: CompanionAction) => Promise<boolean>) => verifyCompanionCapabilityEvidence(action,
    { request, now: () => Date.parse(boundaryNow), validateParentLoop });
  return { state, request, commands, verify };
}

it('keeps an actual ordinary memory capability visible through its exact source and parent loop without an old DSH checkpoint', async () => {
  const f = fixture(); expect(await f.verify()).toBe(true); expect(f.commands).not.toContain('checkpoint.get');
  expect(f.commands).toContain('memory.sources.filter'); expect(f.commands).toContain('loop.for-message'); expect(f.commands).not.toContain('agenda.run.read');
});

it.each(['withdrawn', 'edited', 'wrong-parent-author', 'wrong-parent-source', 'wrong-loop-owner', 'wrong-loop-source', 'wrong-call', 'wrong-invocation', 'old-parent-proof'] as const)('withholds a source capability when %s breaks its actual parent boundary', async change => {
    const f = fixture();
    if (change === 'withdrawn') f.state.source = undefined;
    if (change === 'edited') f.state.source!.content = '原始消息已经被修改。';
    if (change === 'wrong-parent-author') f.state.parent.authorId = 'bob';
    if (change === 'wrong-parent-source') f.state.parent.replyToId = 'another_source';
    if (change === 'wrong-loop-owner') f.state.loop.companionId = 'bob';
    if (change === 'wrong-loop-source') f.state.loop.sourceMessageId = 'another_source';
    if (change === 'wrong-call') f.state.loop.turns[0]!.calls[0]!.name = 'different_capability';
    if (change === 'wrong-invocation') f.state.action.capability!.invocationId = 'another_invocation';
    expect(await f.verify(change === 'old-parent-proof' ? async () => false : undefined)).toBe(false);
  });

it('verifies the actual current source invocation before an assistant parent message exists', async () => {
  const f = fixture(); delete f.state.action.parentMessageId; delete f.state.loop.messageId;
  expect(await f.verify()).toBe(true); expect(f.commands).toContain('loop.get'); expect(f.commands).not.toContain('message.get');
});

it('keeps the real in-progress capability visible before parent call/results are durably published', async () => {
  const f = fixture(); f.state.action.status = 'running'; f.state.loop.status = 'running'; f.state.loop.turns = [];
  expect(await f.verify()).toBe(true);
});

it('accepts the actual umbrella memory name recorded by the native tool journal', async () => {
  const f = fixture(false, 'memory');
  f.state.loop.turns[0]!.calls[0]!.arguments = '{"action":"search","query":"之前的事"}';
  expect(await f.verify()).toBe(true);
});

it('keeps completed self-thought history visible in the human private room using its real run and grant, with no artificial source', async () => {
  const f = fixture(true); expect(await f.verify()).toBe(true);
  expect(f.commands).not.toContain('message.get'); expect(f.commands).not.toContain('checkpoint.get'); expect(f.commands).toContain('agenda.run.read');
});

it.each(['peer-room', 'foreign-member', 'foreign-run', 'no-run', 'revoked', 'revision', 'expired', 'no-capability', 'unbound-grant'] as const)('withholds a self record when %s invalidates its actual private scope', async change => {
    const f = fixture(true);
    if (change === 'peer-room') f.state.peerOnly = true;
    if (change === 'foreign-member') f.state.memberIds = ['bob'];
    if (change === 'foreign-run') f.state.run.companionId = 'bob';
    if (change === 'no-run') delete f.state.action.capability!.agendaRunId;
    if (change === 'revoked') f.state.grant.status = 'revoked';
    if (change === 'revision') f.state.grant.revision++;
    if (change === 'expired') f.state.grant.expiresAt = boundaryNow;
    if (change === 'no-capability') f.state.grant.capabilities = ['observe'];
    if (change === 'unbound-grant') delete (f.state.run as Partial<typeof f.state.run>).activeGrantId;
    expect(await f.verify()).toBe(false);
  });

it('checks both the human source and agenda grant for an ordinary chat observation, and fails closed on raw storage errors', async () => {
  const f = fixture(false, 'observe'); expect(await f.verify()).toBe(true);
  f.state.source = undefined; expect(await f.verify()).toBe(false); f.request.mockRejectedValueOnce(new Error('Storage unavailable'));
  expect(await f.verify()).toBe(false);
});

it.each(['rejected', 'unavailable-response'] as const)('never persists a withdrawal when capability verification is temporarily %s', async mode => {
  const f = fixture(true), card: CompanionMessage = { id: 'actual_card', sequence: 1, conversationId: 'own_room',
    authorId: 'alice', kind: 'action', actionId: f.state.action.id, content: '实际能力过程', status: 'sent', attachments: [], createdAt: boundaryNow };
  if (mode === 'rejected') f.request.mockRejectedValueOnce(new Error('Busy verification port'));
  else f.request.mockResolvedValueOnce({ ok: false, error: 'Busy verification port' });
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: [{ kind: 'action', id: f.state.action.id,
      companionId: 'alice', conversationId: 'own_room', capability: f.state.action.capability, sourceMessageIds: [card.id] }] };
    throw new Error('Temporary capability verification must never write a source withdrawal.');
  });
  await expect(guardCompanionExecutionSources({ type: 'message.get', id: card.id }, { ok: true, message: card }, { storage,
    valid: proof => verifyCompanionCapabilityEvidence(proof, { request: f.request, throwTemporaryUnavailable: true }) })).rejects.toThrow('暂不可核验');
  expect(storage.mock.calls.map(([command]) => command.type)).toEqual(['execution.sources']);
});
