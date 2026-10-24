import type { CompanionMemory } from '../../shared/companions';
import type { VcpMemoryAutomaticDecayPolicy } from '../vcp-memory/contracts';

/** Query freshness, never a source revocation or a native-index generation. */
export function companionMemoryClockBucket(clock: { now: string; timeZone: string }): string {
  return JSON.stringify([new Intl.DateTimeFormat('sv', { timeZone: clock.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(clock.now)), clock.timeZone]);
}

/** Host activation policy only. Upstream keeps its exponential formula and
 * explicit-time branch; it never forgets a note or treats its age as falsehood. */
export function companionAutomaticRecallDecay(notes: readonly CompanionMemory[], worldMode: 'realtime' | 'compressed'): VcpMemoryAutomaticDecayPolicy {
  const episodic = new Set(['日记', '经历', '活动体验']);
  const important = new Set(['重要', '长期', '重要约定']);
  return { schema: 'episodic-v1', halfLifeDays: 180, minScore: 0, protectedNoteIds: notes.filter(note => note.captureMethod !== 'automatic'
    || !episodic.has(note.diaryName ?? '经历') || note.metadata?.characterDevelopment !== undefined
    || note.tags.some(tag => important.has(tag.normalize('NFKC').trim()))
    // An old real-time source without a proven world timestamp must not age by
    // accelerated-world years. It remains recallable at its original score.
    || worldMode === 'compressed' && !note.sources.some(source => source.worldCreatedAt)).map(note => note.id) };
}
