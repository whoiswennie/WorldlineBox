import { expect, it } from 'vitest';
import { auditNaturalGameRosters, naturalGamePublicPatch, prepareNaturalGameEvidenceRisks } from '../helpers/natural-game-content-audit';
import { createHash } from 'node:crypto';
const topic = { id: 'game', moderatorId: 'host', participantIds: ['host', 'a', 'b', 'c'] };
const sha = (content: string) => createHash('sha256').update(content).digest('hex');
function retainedRiskFixture() {
  const legacy = { at: '2026-10-24T00:00:00Z', database: 'C:/isolated/messages.sqlite',
    note: { id: 'old_note', companionId: 'host', content: '旧笔记曾声称给四人发出了邀请。', sources: [
      { messageId: 'original_user', conversationId: 'private_host', authorId: 'user', checksum: sha('原目标') },
      { messageId: 'old_false_formal', conversationId: 'private_host', authorId: 'host', checksum: sha('原来四人已邀请的旧假汇报') },
    ] }, noteBodySha256: sha('旧笔记曾声称给四人发出了邀请。'), actualOutbox: [{ message_id: 'old_actual_invitation' }] };
  const content = '6人配置已经告诉她们了', noteContent = '旧派生笔记声称配置已经发送。';
  return { legacy, combined: { recordedAt: '2026-10-24T01:00:00Z', legacy: { evidence: legacy }, newHistoricalFalseReport: {
    id: 'new_false_formal', author_id: 'host', content, contentChecksum: sha(content), unsupportedClaim: content,
    actualEffectsAudit: { path: 'artifacts/vcp-validation/actual-effects.json', sha256: 'a'.repeat(64) },
    derivedNotes: [{ id: 'new_note', bodyChecksum: sha(noteContent), note: { id: 'new_note', companionId: 'host', content: noteContent,
      sources: [{ messageId: 'new_false_formal', conversationId: 'private_host', authorId: 'host', checksum: sha(content) }] } }],
  } } };
}
it('retains the old single-risk format with its exact note and formal source hashes', () => {
  const { legacy } = retainedRiskFixture(), before = JSON.stringify(legacy), result = prepareNaturalGameEvidenceRisks(legacy);
  expect(result).toMatchObject({ database: legacy.database, format: 'legacy', scope: 'judge_only',
    notes: [{ id: 'old_note', checksum: legacy.noteBodySha256 }],
    formalMessages: [{ id: 'old_false_formal', checksum: sha('原来四人已邀请的旧假汇报') }] });
  expect(result.knownEvidenceRisks).toHaveLength(1);
  expect(result.knownEvidenceRisks[0]).toMatchObject({ originalNoteContent: legacy.note.content, actualOutboxAsOfAudit: legacy.actualOutbox });
  expect(JSON.stringify(legacy)).toBe(before);
});
it('includes both preserved formal messages and both notes as judge-only risks without rewriting the audit input', () => {
  const { combined } = retainedRiskFixture(), before = JSON.stringify(combined), result = prepareNaturalGameEvidenceRisks(combined);
  expect(result.format).toBe('combined'); expect(result.scope).toBe('judge_only');
  expect(result.formalMessages).toEqual([{ id: 'old_false_formal', checksum: sha('原来四人已邀请的旧假汇报') },
    { id: 'new_false_formal', checksum: combined.newHistoricalFalseReport.contentChecksum }]);
  expect(result.notes).toEqual([{ id: 'old_note', ownerId: 'host', checksum: combined.legacy.evidence.noteBodySha256 },
    { id: 'new_note', ownerId: 'host', checksum: combined.newHistoricalFalseReport.derivedNotes[0]!.bodyChecksum }]);
  expect(result.legacyAuthorityNote).toEqual(combined.legacy.evidence.note);
  expect(result.knownEvidenceRisks).toHaveLength(2);
  expect(result.knownEvidenceRisks[1]).toMatchObject({ kind: 'legacy_configuration_claim_is_not_native_delivery_evidence',
    retainedFormal: { content: combined.newHistoricalFalseReport.content, checksum: combined.newHistoricalFalseReport.contentChecksum },
    originalNoteContent: combined.newHistoricalFalseReport.derivedNotes[0]!.note.content });
  expect(JSON.stringify(result.knownEvidenceRisks)).toContain('后来实际发送不能追溯洗白');
  expect(JSON.stringify(combined)).toBe(before);
});
it.each(['old_note_body', 'new_note_body', 'new_formal_body', 'new_note_source', 'missing_note', 'duplicate_formal', 'wrong_owner', 'wrong_quote'] as const)('rejects incomplete or changed retained historical risk evidence (%s)', mutation => {
  const { combined } = retainedRiskFixture(), current = combined.newHistoricalFalseReport, note = current.derivedNotes[0]!;
  if (mutation === 'old_note_body') combined.legacy.evidence.note.content += ' changed';
  if (mutation === 'new_note_body') note.note.content += ' changed';
  if (mutation === 'new_formal_body') current.content += ' changed';
  if (mutation === 'new_note_source') note.note.sources[0]!.checksum = 'b'.repeat(64);
  if (mutation === 'missing_note') current.derivedNotes = [];
  if (mutation === 'duplicate_formal') { current.id = 'old_false_formal'; note.note.sources[0]!.messageId = current.id; }
  if (mutation === 'wrong_owner') note.note.companionId = 'foreign_owner';
  if (mutation === 'wrong_quote') current.unsupportedClaim = '不存在于原正式正文的另一条断言';
  expect(() => prepareNaturalGameEvidenceRisks(combined)).toThrow();
});
it('projects only actual public fields to the public-write oracle, preserving nested shared bytes and excluding real private delivery', () => {
  expect(naturalGamePublicPatch({ privateRecipientId: 'a', workingState: { state: { role: 'secret' } } })).toBeUndefined();
  expect(naturalGamePublicPatch({ shared: { summary: '公开', state: { nested: { workingState: { role: 'still-public-here' } } } },
    privateRecipientId: 'a', workingState: { state: { role: 'actually-private' } }, title: '公开标题', tags: ['公开标签'] }))
    .toEqual({ shared: { summary: '公开', state: { nested: { workingState: { role: 'still-public-here' } } } }, title: '公开标题', tags: ['公开标签'] });
});
it('catches a nonplaying moderator and four cards counted against only three drawing players regardless of a model judge', () => {
  const result = auditNaturalGameRosters([{ topics: [{ topic, states: [{ shared: { summary: '主持人不抽牌，只做主持和记录。',
    state: { players: ['host', 'a', 'b', 'c'], playerCount: 4, board: '1狼+1预言家+2平民' } } }] }] }]);
  expect(result.passed).toBe(false);
  expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['nonplaying_moderator_counted_as_player', 'player_count_mismatch', 'role_card_count_mismatch']));
});
it('accepts a consistent explicit roster without choosing the actors or inventing unspecified card counts', () => {
  expect(auditNaturalGameRosters([{ topics: [{ topic, states: [{ shared: { summary: '主持人不抽牌。',
    state: { players: ['a', 'b', 'c'], playerCount: 3, board: '1狼+1预言家+1平民' } } }] }] }])).toMatchObject({ passed: true, explicitCardCounts: 1 });
  expect(auditNaturalGameRosters([{ topics: [{ topic, states: [] }] }])).toMatchObject({ passed: true, explicitPlayerLists: 0, explicitCardCounts: 0 });
});
