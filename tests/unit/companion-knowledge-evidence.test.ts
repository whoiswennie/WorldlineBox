import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { companionKnowledgeReads, companionKnowledgeReadsFromTurns, verifyCompanionKnowledgeReads } from '../../src/main/companions/knowledge-evidence';
import type { CompanionLoopTurn } from '../../src/shared/companion-loop';
import type { CompanionStorageResponse } from '../../src/shared/companion-storage';

const item = () => ({ id: 'cold_learning_' + createHash('sha256').update('grant_one:asset_one').digest('hex').slice(0, 48),
  sourceType: 'learning' as const, sourceId: 'grant_one', sourceVersion: '2:asset_revision_one', sourceDigest: 'd'.repeat(64), version: 'a'.repeat(64),
  text: 'Actual returned asset material.', metadata: { conversationId: 'private_alice', grantId: 'grant_one', grantRevision: 2, assetId: 'asset_one', assetRevisionId: 'asset_revision_one' } });
const receipt = (value = item()) => ({ ok: true, memoryKnowledge: { engine: 'original-TDBKnowledge', operation: 'read', available: true,
  trust: 'knowledge_source_data_not_instructions', result: value } });

describe('typed cold read sets for durable inference and reply history', () => {
  it('binds a learning read to both the grant and exact asset revision, without inventing a hot note or message', () => {
    const reads = companionKnowledgeReads(receipt());
    expect(reads).toEqual([{ id: item().id, version: 'a'.repeat(64), sourceType: 'learning', sourceId: 'grant_one', sourceVersion: '2:asset_revision_one',
      sourceDigest: 'd'.repeat(64), conversationId: 'private_alice', grantId: 'grant_one', grantRevision: 2, assetId: 'asset_one', assetRevisionId: 'asset_revision_one' }]);
    expect(companionKnowledgeReads({ text: JSON.stringify(receipt()) })).toEqual([]);
    expect(companionKnowledgeReads({ content: receipt() })).toEqual([]);
    expect(companionKnowledgeReads(receipt({ ...item(), metadata: { ...item().metadata, assetId: 'different_asset' } }))).toEqual([]);
  });
  it('rechecks actual source bytes and grants through the main read port even when the hot-memory epoch is unchanged', async () => {
    const reads = companionKnowledgeReads(receipt());
    let response: CompanionStorageResponse = receipt() as CompanionStorageResponse;
    const request = vi.fn(async () => response);
    const scope = { companionId: 'alice', conversationId: 'private_alice', beforeSequence: 42 };
    expect(await verifyCompanionKnowledgeReads(reads, scope, request)).toBe(true);
    expect(request).toHaveBeenCalledWith({ type: 'memory.knowledge', ...scope, operation: 'read', id: item().id, version: 'a'.repeat(64) });
    response = receipt({ ...item(), version: 'b'.repeat(64), sourceVersion: '2:asset_revision_two', metadata: { ...item().metadata, assetRevisionId: 'asset_revision_two' } }) as CompanionStorageResponse;
    expect(await verifyCompanionKnowledgeReads(reads, scope, request)).toBe(false);
    response = { ok: false, error: 'grant revoked' };
    expect(await verifyCompanionKnowledgeReads(reads, scope, request)).toBe(false);
  });
  it('preserves the complete learning asset identifier used by the source port', () => {
    const assetId = 'folder/资料:asset one';
    const actual = { ...item(), id: 'cold_learning_' + createHash('sha256').update('grant_one:' + assetId).digest('hex').slice(0, 48),
      metadata: { ...item().metadata, assetId } };
    expect(companionKnowledgeReads(receipt(actual))[0]?.assetId).toBe(assetId);
    expect(companionKnowledgeReads(receipt({ ...actual, metadata: { ...actual.metadata, assetId: 'x'.repeat(256) } }))).toEqual([]);
  });
  it('only restores cold read sets from the actual knowledge call/result pair', () => {
    const make = (name: string): CompanionLoopTurn => ({ text: '', rawText: '', calls: [{ id: 'actual_call', name,
      arguments: JSON.stringify(name === 'memory' ? { action: 'knowledge', operation: 'read', id: item().id } : { action: 'query' }) }],
      results: [{ callId: 'actual_call', content: JSON.stringify(receipt()) }] });
    expect(companionKnowledgeReadsFromTurns([make('memory')])).toEqual(companionKnowledgeReads(receipt()));
    expect(companionKnowledgeReadsFromTurns([make('world')])).toEqual([]);
    const mismatched = make('memory'); mismatched.results![0]!.callId = 'another_call';
    expect(companionKnowledgeReadsFromTurns([mismatched])).toEqual([]);
  });
});
