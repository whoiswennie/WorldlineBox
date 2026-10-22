import { createHash } from 'node:crypto';
import type { CompanionMemory } from '../../shared/companions';

/** Index delivery and file placement may change without changing recalled facts. */
export function recallCorpusHash(notes: readonly CompanionMemory[]): string {
  const hash = createHash('sha256');
  for (const note of [...notes].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(JSON.stringify([note.id, note.companionId, note.version, note.content, note.tags,
      note.diaryName, note.occurredAt, note.metadata, note.sources]));
    hash.update('\n');
  }
  return hash.digest('hex');
}
