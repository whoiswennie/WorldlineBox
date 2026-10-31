import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { observedPreparedHostEvidence, recoveryFromPayload, preparedRecoveryContext } from '../../src/main/vcp-memory/prepared-recall-recovery';
import type { VcpMemoryPreparedHostEvidence, VcpMemoryPreprocessResult } from '../../src/main/vcp-memory/contracts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function evidence(): VcpMemoryPreparedHostEvidence {
  const now = '2026-10-29T00:00:00Z';
  const frozen = Array.from({ length: 64 }, (_, index) => ({ id: `note_${index}`, contentRevision: 1,
    sources: [{ id: `raw_${index}`, conversationId: 'room', checksum: 'a'.repeat(64) }] }));
  return { schema: 'worldlinebox.prepared-recall-host-evidence', ownerId: 'alice', revocationEpoch: 3, capturedAt: now, sourceClosureDigest: hash(frozen),
    recovery: { schema: 'worldlinebox.prepared-recall-recovery-v1', taskKey: 'a'.repeat(64), requestHash: 'b'.repeat(64), revocationEpoch: 3,
      scope: { companionId: 'alice', conversationId: 'room' }, profileKey: 'fixture', algorithmSignature: 'c'.repeat(64),
      owner: { version: 2, companionId: 'alice', name: 'Alice', agentName: 'Alice' }, frozen, rawSources: [],
      fileReceipts: frozen.map(note => ({ companionId: 'alice', noteId: note.id, contentRevision: 1, path: `记忆/经历/${note.id}.md`, contentHash: 'a'.repeat(64) })),
      contextSeed: { revision: 'captured', corpusHash: 'd'.repeat(64), queryCorpusHash: 'e'.repeat(64), capturedAt: now, queryClock: { now, timeZone: 'Asia/Shanghai' },
        notes: frozen.map(note => ({ id: note.id, version: 1, contentRevision: 1, procedure: false,
          sources: note.sources.map(source => ({ messageId: source.id, revision: 1, checksum: source.checksum })) })), cursor: 0, limit: 8 } } };
}
const receipt: VcpMemoryPreprocessResult = { messages: [{ role: 'system', content: '真实返回的一个片段。' }], events: [],
  contextReferenceCoverage: 'observed', contextReferences: [{ id: 'note_7', role: 'returned', textHash: 'f'.repeat(64) }] };

it('persists only actual native input dependencies and preserves full graph identity and recoverable proof', () => {
  const source = evidence(), original = JSON.stringify(source);
  const narrowed = observedPreparedHostEvidence(source, receipt)!;
  expect(source.recovery?.frozen).toHaveLength(64); expect(JSON.stringify(source)).toBe(original);
  expect(narrowed.recovery?.frozen.map(note => note.id)).toEqual(['note_7']);
  expect(narrowed.recovery?.fileReceipts.map(note => note.noteId)).toEqual(['note_7']);
  expect(narrowed.recovery?.contextSeed.notes.map(note => note.id)).toEqual(['note_7']);
  expect(narrowed.recovery?.contextSeed.corpusHash).toBe(source.recovery?.contextSeed.corpusHash);
  expect(JSON.stringify(narrowed).length).toBeLessThan(original.length / 8);
  const recovery = recoveryFromPayload({ schema: 'worldlinebox.prepared-recall-payload', modelIdentity: 'unused', groups: [], receipt, hostEvidence: narrowed });
  const context = preparedRecoveryContext(recovery, receipt);
  expect(context.evidence.frozenDependencies?.map(note => note.id)).toEqual(['note_7']);
  expect(context.text).toBe('真实返回的一个片段。');
});

it('retains incomplete or unmapped provenance and rejects mismatched authority', () => {
  const source = evidence();
  expect(observedPreparedHostEvidence(source, { ...receipt, contextReferenceCoverage: 'partial' })).toBe(source);
  expect(observedPreparedHostEvidence(source, { ...receipt, contextReferences: [{ id: 'unknown', role: 'returned', textHash: 'f'.repeat(64) }] })).toBe(source);
  expect(() => observedPreparedHostEvidence({ ...source, sourceClosureDigest: '0'.repeat(64) }, receipt)).toThrow('closure');
  const empty = observedPreparedHostEvidence(source, { ...receipt, contextReferences: [] });
  expect(empty?.recovery?.frozen).toEqual([]);
  expect(empty?.recovery?.contextSeed.notes).toEqual([]);
});
