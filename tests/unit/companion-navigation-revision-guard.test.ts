import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { guardCompanionExecutionSources, companionExecutionSourceReadOnly, type CompanionExecutionSourceProof } from '../../src/main/companions/source-execution-evidence';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionsRequestSchema } from '../../src/shared/companions';

it('keeps a Worker-successful navigation predicate denied when Main rejects its real source obligation', async () => {
  const scope = { companionId: 'alice', conversationId: 'room_one' }, content = '真实来源正文';
  const actual: CompanionExecutionSourceProof = { kind: 'message', id: 'source', ...scope, sourceMessageIds: ['source'], executionReadset: captureCompanionExecutionReadset(scope) };
  const command: CompanionStorageCommand = { type: 'memory.snapshot.revisions', scopes: [{ ...scope, contentKinds: ['episode_memory'] }] };
  const response: CompanionStorageResponse = { ok: true, memorySnapshotRevisions: { groups: [{ scope: { ...scope, contentKinds: ['episode_memory'], publishedOnly: false },
    valid: true, revision: 'r', semanticRevision: 's', memories: [{ id: 'note', companionId: 'alice', artifactKind: 'episode_memory', version: 1,
      contentRevision: 1, status: 'indexed', sourceConversationId: scope.conversationId, sourceSequence: 1,
      sources: [{ messageId: 'source', conversationId: scope.conversationId, revision: 1, sequence: 1, authorId: scope.companionId,
        createdAt: '2026-11-01T00:00:00.000Z', checksum: createHash('sha256').update(content).digest('hex') }] }] }] } };
  const storage = vi.fn(async (input: CompanionStorageCommand): Promise<CompanionStorageResponse> => input.type === 'execution.sources'
    ? { ok: true, executionSources: [actual] } : { ok: true });
  const result = await guardCompanionExecutionSources(command, response, { storage, valid: async () => false });
  expect(result.memorySnapshotRevisions?.groups[0]).toMatchObject({ valid: false, memories: [] });
  expect(storage.mock.calls.some(([input]) => input.type === 'execution.invalidate')).toBe(true);
  expect(companionExecutionSourceReadOnly(command)).toBe(true);
  expect(companionsRequestSchema.safeParse(command).success).toBe(false);
});
