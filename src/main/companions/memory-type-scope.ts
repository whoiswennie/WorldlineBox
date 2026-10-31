import type { CompanionMemory } from '../../shared/companions';
import { companionMemoryKindAllowed, companionMemoryKinds, COMPANION_MEMORY_SCOPE_MEANINGS,
  type CompanionMemoryArtifactKind, type CompanionMemoryRetrievalScope } from '../../shared/companion-memory-scope';

export function companionMemoryTypeScope(scope: CompanionMemoryRetrievalScope = 'facts') {
  return { schema: 'worldlinebox.memory-type-scope-v2' as const, consumer: scope, contentKinds: companionMemoryKinds(scope), meaning: COMPANION_MEMORY_SCOPE_MEANINGS[scope] };
}
export function companionMemoryForScope<T extends Pick<CompanionMemory, 'artifactKind'>>(notes: readonly T[], scope: CompanionMemoryRetrievalScope = 'facts'): T[] {
  const kinds = companionMemoryKinds(scope); return notes.filter(note => companionMemoryKindAllowed(note.artifactKind, kinds));
}
export function companionMemoryForKinds<T extends Pick<CompanionMemory, 'artifactKind'>>(notes: readonly T[], kinds: readonly CompanionMemoryArtifactKind[]): T[] {
  return notes.filter(note => companionMemoryKindAllowed(note.artifactKind, kinds));
}
export const COMPANION_MEMORY_MAINTENANCE_KINDS = {
  memory_consolidation: ['episode_memory'], reflection: ['episode_memory', 'knowledge', 'procedure'],
  knowledge_review: ['knowledge', 'procedure'], self_integration: ['self_understanding'], timeline: ['episode_memory'],
  dream_input: ['episode_memory', 'knowledge', 'procedure'],
} as const satisfies Record<string, readonly CompanionMemoryArtifactKind[]>;
