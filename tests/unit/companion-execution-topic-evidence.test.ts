import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { captureCompanionExecutionReadset, verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const checksum = (text: string) => createHash('sha256').update(text).digest('hex');
const scope = { companionId: 'alice', conversationId: 'private_alice' };
const context = () => ({ user: JSON.stringify({ topic: { id: 'group_story', conversationId: 'group_room' }, topicState: {
  topicId: 'group_story', readerId: 'alice', workingState: { sourceEventId: 'immutable_checkpoint', summary: 'Actually read story checkpoint',
    sourceMessageIds: ['current_source'], sourceChecksums: { current_source: checksum('Current original bytes') } },
} }) });

it('binds a captured target-room checkpoint to its actual room and verifies ancestry without granting the original chat window', async () => {
  const readset = captureCompanionExecutionReadset(scope, { context: context() });
  expect(readset.complete).toBe(true);
  expect(readset.topics).toEqual([{ conversationId: 'group_room', topicId: 'group_story', checkpointEventIds: ['immutable_checkpoint'], sourceMessageIds: ['current_source'] }]);
  expect(readset.sources).toEqual([]);
  let ancestryValid = true;
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'topic.sources.valid') return { ok: true, topicSourcesValid: ancestryValid };
    throw new Error('Unexpected verification port.');
  });
  expect(await verifyCompanionExecutionReadset(readset, scope, { request })).toBe(true);
  expect(request).toHaveBeenCalledWith({ type: 'topic.sources.valid', conversationId: 'group_room', topicId: 'group_story', readerId: 'alice',
    sourceMessageIds: ['current_source'], checkpointEventIds: ['immutable_checkpoint'] });
  request.mockClear(); ancestryValid = false;
  expect(await verifyCompanionExecutionReadset(readset, scope, { request })).toBe(false);
  expect(request.mock.calls.map(([command]) => command.type)).toEqual(['topic.sources.valid']);
});

it('does not treat a pre-closure legacy readset as complete evidence, including one with no flattened sources', async () => {
  const fresh = captureCompanionExecutionReadset(scope), { topics: _topics, ...legacy } = fresh; void _topics;
  const request = vi.fn(async (): Promise<CompanionStorageResponse> => ({ ok: true }));
  expect(await verifyCompanionExecutionReadset(legacy as typeof fresh, scope, { request })).toBe(false);
  expect(request).not.toHaveBeenCalled();
});

it('retains the exact topic reference transitively when a later execution derives from an earlier host result', () => {
  const prior = captureCompanionExecutionReadset(scope, { context: context() });
  const derived = captureCompanionExecutionReadset(scope, { readsets: [prior, prior] });
  expect(derived.complete).toBe(true); expect(derived.topics).toEqual(prior.topics); expect(derived.sources).toEqual(prior.sources);
});

it('captures a separate host game reference without pretending the private dialogue occurred in that game room', () => {
  const at = '2026-10-23T10:00:00.000Z';
  const data = JSON.parse(context().user);
  const readset = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({
    conversation: { id: scope.conversationId }, messages: [{ id: 'private_incoming', conversationId: scope.conversationId, content: '请和队友确认本人动作。' }],
    gameCommunication: { gamePort: { conversationId: 'group_room', topicId: 'group_story' },
      topic: { ...data.topic, kind: 'game', title: '本局', status: 'active', participantIds: ['alice', 'bob'], invitedIds: [], tags: [], moderatorId: 'bob', revision: 3, createdAt: at, updatedAt: at },
      topicState: { ...data.topicState, workingState: { ...data.topicState.workingState, updatedAt: at, authorId: 'alice', revision: 3 }, trust: 'topic_state_not_real_world_facts' },
      binding: { jobId: 'actual_job', companionId: 'alice', sourceMessageId: 'private_incoming', sourceConversationId: scope.conversationId, sourceChecksum: checksum('请和队友确认本人动作。') },
      trust: 'actual_job_same_game_reference_not_source_or_human_authority' },
  }) } });
  expect(readset.complete).toBe(true);
  expect(readset.topics).toEqual([{ conversationId: 'group_room', topicId: 'group_story', checkpointEventIds: ['immutable_checkpoint'], sourceMessageIds: ['current_source'] }]);
  expect(readset.sources).toEqual([{ id: 'private_incoming', conversationId: scope.conversationId, checksum: checksum('请和队友确认本人动作。') }]);
  const forged = JSON.parse(context().user);
  forged.gameCommunication = { topic: forged.topic, topicState: forged.topicState };
  expect(captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify(forged) } }).complete).toBe(false);
});
