import { companionArtifactPathMatchesKind, type CompanionArtifact } from '../../shared/companion-artifact';
import type { CompanionArtifactRegistry } from './artifact-registry';

export async function cancelRetiredMemoryPublications(registry: CompanionArtifactRegistry, artifactId: string, producerId: 'source-outbox' | 'history-outbox', kind: 'source_evidence' | 'revision_history'): Promise<void> {
  let afterOperationId: string | undefined;
  for (;;) {
    const pending = await registry.pendingPublications({ artifactId, producerId, includeRevoked: true, afterOperationId, limit: 16 }); if (!pending.length) break;
    for (const publication of pending) {
      if (publication.ownerId !== registry.ownerId || publication.items.length !== 1 || publication.items[0]!.next.artifactId !== artifactId || publication.items[0]!.next.kind !== kind) throw new Error('来源或历史撤回发布身份不一致。');
      afterOperationId = publication.operationId;
      await registry.cancelPublication(publication.operationId); await registry.discardPublishedFiles(publication.operationId); await registry.purgePublicationStages(publication.operationId);
    }
  }
}

/** A withdrawal removes only the exact registered bytes. Unknown external
 * edits remain a conflict; no directory walk or SQL reconstruction is used. */
export async function removeRetiredMemoryFile(registry: CompanionArtifactRegistry, artifact: CompanionArtifact): Promise<void> {
  if (!['source_evidence', 'revision_history'].includes(artifact.kind) || artifact.ownerId !== registry.ownerId || !companionArtifactPathMatchesKind(artifact.kind, artifact.relativePath)) throw new Error('不是可精确撤回的来源或历史文件。');
  const actual = await registry.get(artifact.artifactId, true);
  if (!actual || actual.publicationState !== 'revoked' || actual.contentHash !== artifact.contentHash || actual.contentRevision !== artifact.contentRevision) throw new Error('清理前登记撤回版本已变化。');
  await registry.purgeRevokedBody(artifact.artifactId);
  await registry.purgePublicationStages(artifact.operationId);
}
