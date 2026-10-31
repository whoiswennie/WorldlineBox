import type { CompanionsStore } from '../../src/companions/store';
import type { CompanionMemoryArtifactKind } from '../../src/shared/companion-memory-scope';

/** Test producer using a real authorized source event and the production
 * typed writer. It grants no filesystem identity or scope of its own. */
export function recordSourceBackedMemory(store: CompanionsStore, input: {
  companionId: string; conversationId: string; content: string; tags?: string[];
  diaryName?: string; artifactKind?: CompanionMemoryArtifactKind; autoTags?: boolean;
}) {
  const source = store.appendMessage({ conversationId: input.conversationId, authorId: 'user', content: input.content, replyDirective: 'none' });
  const response = store.request({ type: 'memory.record', companionId: input.companionId, conversationId: input.conversationId,
    candidate: { artifactKind: input.artifactKind ?? 'episode_memory', content: input.content, tags: input.tags ?? [], diaryName: input.diaryName,
      ...(input.autoTags === undefined ? {} : { metadata: { autoTags: input.autoTags } }),
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } });
  if (!response.ok || !response.memories?.[0]) throw new Error(response.error ?? 'Actual source-backed fixture record was not committed.');
  return response.memories[0];
}
