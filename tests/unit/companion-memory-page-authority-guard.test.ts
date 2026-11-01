import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { companionExecutionSourceReadOnly, guardCompanionExecutionSources, type CompanionExecutionSourceProof } from '../../src/main/companions/source-execution-evidence';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionsRequestSchema } from '../../src/shared/companions';

const scope = { companionId: 'alice', conversationId: 'room_one' }, checksum = 'a'.repeat(64);
const header = { id: 'source', authorId: 'alice', conversationId: scope.conversationId, revision: 1, checksum,
  sequence: 1, kind: 'text' as const, status: 'sent' as const, createdAt: '2026-11-01T00:00:00.000Z',
  memoryEvidenceOnly: false, hasWorldObservation: false, hasAttachments: false, hasAction: false };
const command: CompanionStorageCommand = { type: 'memory.documents.authority', companionId: 'alice', noteIds: ['note'],
  navigation: [{ scope: { ...scope, contentKinds: ['episode_memory'] }, expectedRevision: 's' }],
  sources: { conversationId: scope.conversationId, ids: ['source'] } };
const response = (): CompanionStorageResponse => ({ ok: true, memories: [], memorySourceHeaders: { headers: [{ ...header }], unsupportedIds: [] },
  memoryDocumentAuthority: { navigation: [{ scope: { ...scope, contentKinds: ['episode_memory'], publishedOnly: false }, expectedRevision: 's', valid: true, matches: true, revision: 'r', semanticRevision: 's' }] },
  memorySnapshotRevisions: { groups: [{ scope: { ...scope, contentKinds: ['episode_memory'], publishedOnly: false }, valid: true, revision: 'r', semanticRevision: 's',
    memories: [{ id: 'note', companionId: 'alice', artifactKind: 'episode_memory', version: 1, contentRevision: 1, status: 'indexed', sourceConversationId: scope.conversationId,
      sourceSequence: 1, sources: [{ messageId: 'source', conversationId: scope.conversationId, revision: 1, sequence: 1,
        authorId: 'alice', createdAt: '2026-11-01T00:00:00.000Z', checksum }] }] }] } });

it('rejects the entire composite packet when Main denies a source, without retaining another component Worker true', async () => {
  const actual: CompanionExecutionSourceProof = { kind: 'message', id: 'source', ...scope, sourceMessageIds: ['source'], executionReadset: captureCompanionExecutionReadset(scope) };
  const storage = vi.fn(async (input: CompanionStorageCommand): Promise<CompanionStorageResponse> => input.type === 'execution.sources'
    ? { ok: true, executionSources: [actual] } : { ok: true });
  await expect(guardCompanionExecutionSources(command, response(), { storage, valid: async () => false })).rejects.toThrow('目录页的实际来源');
  expect(storage.mock.calls.some(([input]) => input.type === 'execution.invalidate')).toBe(true);
  expect(companionExecutionSourceReadOnly(command)).toBe(true); expect(companionsRequestSchema.safeParse(command).success).toBe(false);
});

it.each(['author', 'room', 'revision', 'checksum'] as const)('binds bundle headers to the actual published candidate (%s)', async changed => {
  const readset = captureCompanionExecutionReadset(scope), digest = createHash('sha256').update(JSON.stringify(readset)).digest('hex');
  const actual: CompanionExecutionSourceProof = { kind: 'message', id: 'source', ...scope, sourceMessageIds: ['source'], executionReadset: readset,
    storageValidatedAuthorityEpoch: 1, storageValidatedReadsetDigest: digest,
    publicationCandidate: { policyVersion: 1, ...scope, messageId: 'source', messageRevision: 1, bodySHA: checksum, readsetDigest: digest, contextClosureDigest: checksum } };
  const raw = response(), original = raw.memorySourceHeaders!.headers[0]!;
  if (changed === 'author') original.authorId = 'bob';
  else if (changed === 'room') original.conversationId = 'other_room';
  else if (changed === 'revision') original.revision = 2;
  else original.checksum = 'b'.repeat(64);
  const storage = vi.fn(async (): Promise<CompanionStorageResponse> => ({ ok: true, executionSources: [actual] })), valid = vi.fn(async () => true);
  await expect(guardCompanionExecutionSources(command, raw, { storage, valid })).rejects.toThrow('准确版本');
  expect(valid).not.toHaveBeenCalled();
});

const historicalPacket = (): CompanionStorageResponse => ({ ok: true, memories: [], memoryDocumentAuthority: { navigation: [] },
  memoryHistoryDescriptors: [{ companionId: 'alice', id: 'historical_note', contentRevision: 1, bodyHash: checksum, documentHash: checksum,
    relativePath: '记忆/历史/historical.md', sources: [{ id: 'source', conversationId: scope.conversationId, revision: 1, checksum }], dependencies: [] }] });
const historicalCommand: CompanionStorageCommand = { type: 'memory.documents.authority', companionId: 'alice', noteIds: [], navigation: [],
  history: { conversationId: scope.conversationId, roots: [{ id: 'historical_note', contentRevision: 1 }] } };

it('keeps a history-only page subject to its actual action authority without treating the old note as current memory', async () => {
  const source: CompanionExecutionSourceProof = { kind: 'message', id: 'source', ...scope, sourceMessageIds: ['source'], executionReadset: captureCompanionExecutionReadset(scope) };
  const action: CompanionExecutionSourceProof = { kind: 'action', id: 'old_action', ...scope, sourceMessageIds: ['source'], executionReadset: captureCompanionExecutionReadset(scope) };
  const storage = vi.fn(async (input: CompanionStorageCommand): Promise<CompanionStorageResponse> => input.type === 'execution.sources'
    ? { ok: true, executionSources: [source, action] } : { ok: true });
  const actionAuthority = vi.fn(async () => false);
  await expect(guardCompanionExecutionSources(historicalCommand, historicalPacket(), { storage, valid: async () => true, actionAuthority })).rejects.toThrow('目录页的实际来源');
  expect(actionAuthority).toHaveBeenCalled();
  const reads = storage.mock.calls.flatMap(([input]) => input.type === 'execution.sources' ? [input] : []);
  expect(reads.length).toBeGreaterThan(0);
  for (const read of reads) { expect(read.sourceMessageIds).toEqual(['source']); expect(read.memoryIds).toEqual([]); }
});

it('rejects a changed exact historical source tuple before accepting a newly published body with the same ID', async () => {
  const readset = captureCompanionExecutionReadset(scope), digest = createHash('sha256').update(JSON.stringify(readset)).digest('hex');
  const actual: CompanionExecutionSourceProof = { kind: 'message', id: 'source', ...scope, sourceMessageIds: ['source'], executionReadset: readset,
    storageValidatedAuthorityEpoch: 1, storageValidatedReadsetDigest: digest,
    publicationCandidate: { policyVersion: 1, ...scope, messageId: 'source', messageRevision: 1, bodySHA: 'b'.repeat(64), readsetDigest: digest, contextClosureDigest: checksum } };
  const storage = vi.fn(async (): Promise<CompanionStorageResponse> => ({ ok: true, executionSources: [actual] })), valid = vi.fn(async () => true);
  await expect(guardCompanionExecutionSources(historicalCommand, historicalPacket(), { storage, valid })).rejects.toThrow('历史文档的来源正文');
  expect(valid).not.toHaveBeenCalled();
});
