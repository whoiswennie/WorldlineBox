import type { CompanionMemory } from './companions';

type Note = Pick<CompanionMemory, 'metadata' | 'sources'>;

/** A host-marked reflection or merge can remain useful without becoming a new
 * original event just because a later sleep reads it again. */
export function companionMemoryIsOriginalJournal(note: Note): boolean {
  return note.metadata?.consolidation === undefined && note.metadata?.automaticConsolidation !== true
    && note.metadata?.sleepReflection !== true && note.metadata?.dream !== true && note.metadata?.simulation !== true;
}

/** Novelty governs automatic archival only, never the right to reflect. */
export function companionAutomaticConsolidationHasNovelty(notes: readonly Note[]): boolean {
  if (notes.length < 2) return false;
  const originals = notes.filter(companionMemoryIsOriginalJournal);
  if (!originals.length) return false;
  const prior = notes.filter(note => note.metadata?.automaticConsolidation === true);
  if (!prior.length) return true;
  const covered = new Set(prior.flatMap(note => note.sources.map(source => source.messageId)));
  return originals.some(note => note.sources.some(source => !covered.has(source.messageId)));
}
