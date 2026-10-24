import { expect, it, vi } from 'vitest';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { companionExecutionSourceReferences, guardCompanionExecutionSources } from '../../src/main/companions/source-execution-evidence';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const at = '2026-10-23T10:00:00.000Z';
const response: CompanionStorageResponse = { ok: true, socialGameContext: {
  gamePort: { conversationId: 'actual_game_room', topicId: 'actual_game' },
  topic: { id: 'actual_game', conversationId: 'actual_game_room', kind: 'game', title: '本局', status: 'active',
    moderatorId: 'host', participantIds: ['alice', 'host'], invitedIds: [], tags: [], revision: 3, createdAt: at, updatedAt: at },
  topicState: { readerId: 'alice', topicId: 'actual_game', trust: 'topic_state_not_real_world_facts', workingState: {
    summary: 'ACTUAL_PRIVATE_ROLE_BYTES', state: { role: 'seer' }, sourceMessageIds: ['actual_private_source'], sourceEventId: 'actual_private_checkpoint',
    sourceChecksums: { actual_private_source: 'a'.repeat(64) }, authorId: 'host', revision: 3, updatedAt: at } },
  binding: { jobId: 'actual_job', companionId: 'alice', sourceMessageId: 'incoming_private', sourceConversationId: 'actual_pair', sourceChecksum: 'b'.repeat(64) },
  trust: 'actual_job_same_game_reference_not_source_or_human_authority',
} };
const command: CompanionStorageCommand = { type: 'social.job.game_context', id: 'actual_job', leaseToken: 'actual_lease',
  companionId: 'alice', conversationId: 'actual_pair', sourceMessageId: 'incoming_private', sourceChecksum: 'b'.repeat(64) };

it('recursively checks the authorized secondary game checkpoint source without treating its prose as another source port', () => {
  expect(companionExecutionSourceReferences(response)).toEqual({ sourceMessageIds: ['actual_private_source'], memoryIds: [] });
  expect(JSON.stringify(response.socialGameContext?.binding)).not.toContain('human');
});

it('withholds game-context private bytes when Main detects a changed source dependency beyond the worker SQL proof', async () => {
  const storage = vi.fn(async (request: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (request.type === 'execution.sources') return { ok: true, executionSources: [{ kind: 'message', id: 'actual_private_source',
      companionId: 'host', conversationId: 'actual_game_room', sourceMessageIds: ['actual_private_source'],
      executionReadset: captureCompanionExecutionReadset({ companionId: 'host', conversationId: 'actual_game_room' }) }] };
    if (request.type === 'execution.invalidate') return { ok: true };
    throw new Error('A game query or world effect must not replay during invalidation');
  });
  const valid = vi.fn(async () => false);
  await expect(guardCompanionExecutionSources(command, response, { storage, valid })).rejects.toThrow('来源已经变化');
  expect(valid).toHaveBeenCalledOnce();
  expect(storage.mock.calls.map(([request]) => request.type)).toEqual(['execution.sources', 'execution.invalidate']);
});
