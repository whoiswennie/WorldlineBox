import { expect, it } from 'vitest';
import { preparedObservedFileReceipts } from '../../src/main/vcp-memory/prepared-recall-recovery';
import type { CompanionMemoryFileReceipt } from '../../src/shared/companion-memory-files';

const files: CompanionMemoryFileReceipt[] = ['unused', 'expanded', 'returned'].map(noteId => ({ companionId: 'alice', noteId,
  contentRevision: 1, path: `资料/${noteId}.md`, contentHash: 'a'.repeat(64) }));
const reference = (id: string, role: 'returned' | 'focus_input' = 'focus_input') => ({ id, role, textHash: 'b'.repeat(64) });
it('checks every observed full-file focus input and returned source without changing original native order or graph closure', () => {
  const references = [reference('expanded'), reference('returned', 'returned'), reference('expanded')];
  expect(preparedObservedFileReceipts({ contextReferences: references, contextReferenceCoverage: 'observed' }, files)).toEqual(files.slice(1));
  expect(files).toHaveLength(3); expect(references).toHaveLength(3);
});
it('keeps the complete original physical closure when any native provenance is missing or unmapped', () => {
  expect(preparedObservedFileReceipts({ contextReferenceCoverage: 'partial', contextReferences: [reference('expanded')] }, files)).toBe(files);
  expect(preparedObservedFileReceipts({ contextReferenceCoverage: 'observed' }, files)).toBe(files);
  expect(preparedObservedFileReceipts({ contextReferenceCoverage: 'observed', contextReferences: [reference('unknown')] }, files)).toBe(files);
});
it('admits an observed empty native result without inventing source input', () => {
  expect(preparedObservedFileReceipts({ contextReferenceCoverage: 'observed', contextReferences: [] }, files)).toEqual([]);
});
