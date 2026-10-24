import { expect, it, vi } from 'vitest';
import { companionTopicCapabilities } from '../../src/main/companions/topic-capabilities';
import { companionTopicPublicCommands, companionTopicOperationSchema, companionTopicOperationExample } from '../../src/shared/companion-topic';
import type { CompanionLoopCall } from '../../src/shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionTopicModeratorTransferApproval } from '../../src/shared/companion-topic';

const call = (parameters: unknown): CompanionLoopCall => ({ id: 'stable_host_slot', name: 'world', arguments: JSON.stringify({ action: 'topic', parameters }) });
function fixture() {
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async () => ({ ok: true }));
  return { request, capabilities: companionTopicCapabilities(request, { companionId: 'alice', conversationId: 'private_alice' }) };
}

it.each(companionTopicPublicCommands.map(command => command.shape.type.value.slice('topic.'.length)))('provides a valid minimal shape for the exact %s operation', action => {
  const example = companionTopicOperationExample(action) as { action: string; parameters: unknown };
  expect(example.action).toBe('topic'); expect(companionTopicOperationSchema(action)?.safeParse(example.parameters).success).toBe(true);
});

it('points misplaced update identifiers to their exact sibling paths without executing or silently relocating them', async () => {
  const f = fixture(), bad = call({ action: 'update', patch: { roomId: 'actual_room', topicId: 'actual_topic', expectedRevision: 7,
    workingState: { summary: '已经确认的本人进度', sourceMessageIds: [] } } });
  const original = bad.arguments, result = await f.capabilities.execute(bad);
  expect(result).toMatchObject({ ok: false, argumentIssues: expect.arrayContaining([
    expect.objectContaining({ path: 'parameters.patch.roomId', message: expect.stringContaining('parameters.roomId') }),
    expect.objectContaining({ path: 'parameters.patch.topicId', message: expect.stringContaining('parameters.topicId') }),
    expect.objectContaining({ path: 'parameters.patch.expectedRevision', message: expect.stringContaining('parameters.expectedRevision') }),
    expect.objectContaining({ path: 'parameters.expectedRevision', message: expect.stringContaining('最新正整数revision') }),
  ]), minimumExample: companionTopicOperationExample('update') });
  expect(f.request).not.toHaveBeenCalled(); expect(bad.arguments).toBe(original);
});

it('explains the state container while keeping room targeting and reader identity host-bound', async () => {
  const f = fixture();
  expect(await f.capabilities.execute(call({ action: 'update', roomId: 'actual_group', topicId: 'actual_topic', expectedRevision: 7,
    patch: { state: { phase: 'proposal' } } }))).toMatchObject({ ok: false,
    argumentIssues: [expect.objectContaining({ path: 'parameters.patch.state', message: expect.stringContaining('patch.shared.state') })] });
  expect(f.request).not.toHaveBeenCalled();
  const stored = await f.capabilities.execute(call({ action: 'update', roomId: 'actual_group', topicId: 'actual_topic', expectedRevision: 7,
    patch: { workingState: { state: { phase: 'confirmed' }, sourceMessageIds: [] } } }));
  expect(stored).toMatchObject({ topicDelivery: { stateStored: true, messageSent: false, recipientAwakened: false,
    notice: expect.stringContaining('未发送消息或唤醒接收者') } });
  expect(f.request).toHaveBeenCalledExactlyOnceWith({ type: 'topic.update', conversationId: 'actual_group', readerId: 'alice',
    topicId: 'actual_topic', expectedRevision: 7, patch: { workingState: { state: { phase: 'confirmed' }, sourceMessageIds: [] } }, operationId: 'brain_stable_host_slot' });
  expect(await f.capabilities.execute(call({ action: 'read', topicId: 'actual_topic', readerId: 'bob' }))).toMatchObject({ ok: false,
    argumentIssues: [expect.objectContaining({ path: 'parameters.readerId', code: 'unrecognized_keys' })] });
  expect(f.request).toHaveBeenCalledOnce();
});

it('reports unknown operation and malformed JSON precisely without dispatch or broad union diagnostics', async () => {
  const f = fixture();
  expect(await f.capabilities.execute(call({ action: 'rewrite_everyone', topicId: 'actual_topic' }))).toMatchObject({ ok: false,
    argumentIssues: [{ path: 'parameters.action', code: 'invalid_value', message: expect.any(String) }] });
  expect(await f.capabilities.execute({ ...call({}), arguments: '{broken' })).toMatchObject({ ok: false,
    argumentIssues: [{ path: '$', code: 'invalid_json', message: expect.any(String) }] });
  expect(f.request).not.toHaveBeenCalled(); expect(companionTopicOperationSchema('rewrite_everyone')).toBeUndefined();
  expect(companionTopicOperationExample('rewrite_everyone')).toBeUndefined();
});
it('requires host consent review for moderator transfer and never accepts model-supplied approval', async () => {
  const f = fixture(), args = { action: 'transfer_moderator', roomId: 'actual_group', topicId: 'actual_topic', expectedRevision: 7,
    targetCompanionId: 'bob', sourceMessageIds: ['actual_bob_acceptance'] };
  expect(await f.capabilities.execute(call(args))).toMatchObject({ ok: false, error: expect.stringContaining('核验能力') });
  expect(f.request).not.toHaveBeenCalled();
  const approval: CompanionTopicModeratorTransferApproval = { schema: 'worldlinebox.companion-topic-moderator-transfer-v1', companionId: 'alice',
    conversationId: 'actual_group', topicId: 'actual_topic', previousModeratorId: 'alice', targetCompanionId: 'bob', expectedRevision: 7,
    consentMessageId: 'actual_bob_acceptance', sourceRefs: [{ id: 'actual_bob_acceptance', checksum: 'a'.repeat(64) }] };
  const reviewTransfer = vi.fn(async () => approval);
  const capability = companionTopicCapabilities(f.request, { companionId: 'alice', conversationId: 'actual_group' }, undefined, { reviewTransfer });
  expect(await capability.execute(call({ ...args, moderatorTransferApproval: approval }))).toMatchObject({ ok: false });
  expect(reviewTransfer).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  await capability.execute(call(args));
  expect(reviewTransfer).toHaveBeenCalledOnce();
  expect(f.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'topic.transfer_moderator', readerId: 'alice', moderatorTransferApproval: approval }));
});
