import type { CompanionRegistryPublication } from '../../shared/companion-registry-storage';
import type { CompanionJobDisposition } from '../../shared/companion-job-control';
import type { CompanionArtifact } from '../../shared/companion-artifact';
import { CompanionArtifactError } from './artifact-registry';
import type { MemoryLibraryDocumentSession } from './memory-library';

export function memoryFilePublicationOperation(kind: 'source' | 'history' | 'memory', jobId: string, retryCycle: number): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(jobId) || !Number.isSafeInteger(retryCycle) || retryCycle < 0) throw new Error('文件发布的固定作业周期无效。');
  return `${kind}-file:${jobId}:cycle:${retryCycle}`;
}

function belongsToJob(publication: CompanionRegistryPublication, job: CompanionJobDisposition, prefix: string): boolean {
  if (publication.ownerId !== job.ownerId || publication.items.length !== 1) return false;
  const artifact = publication.items[0]!.next;
  if (prefix === 'source') return job.kind === 'source_files' && artifact.kind === 'source_evidence' && artifact.producer.id === 'source-outbox'
    && artifact.producer.kind === 'host' && artifact.artifactId === `source:${job.sourceMessageId}:r${job.sourceRevision}`;
  if (job.kind !== 'history_files') return false;
  return prefix === 'history' ? artifact.kind === 'revision_history' && artifact.producer.kind === 'host' && artifact.producer.id === 'history-outbox'
    && artifact.artifactId === `history:${job.memoryId}:r${job.contentRevision}`
    : ['episode_memory', 'knowledge', 'procedure', 'self_understanding', 'navigation', 'dream_fiction'].includes(artifact.kind)
      && artifact.producer.kind === 'system' && artifact.producer.id === 'memory-commit' && artifact.artifactId === `memory:${job.memoryId}`;
}

function restoreValidator(session: MemoryLibraryDocumentSession): (previous: CompanionArtifact) => Promise<void> {
  let epoch: number | undefined;
  return async previous => {
    const before = (await session.request({ type: 'memory.lifecycle.state', companionId: session.owner.id })).memoryLifecycleState?.revocationEpoch;
    if (before === undefined || epoch !== undefined && before !== epoch) throw new CompanionArtifactError('DENIED', '旧正文恢复期间来源撤销版本已变化。');
    epoch = before;
    const memoryId = previous.artifactId.startsWith('memory:') ? previous.artifactId.slice('memory:'.length) : undefined;
    const directPublication = /^memory:([a-zA-Z0-9_-]{1,100}):r([1-9][0-9]*):[a-f0-9]{16}$/u.exec(previous.operationId);
    const bound = /^memory-file:([a-zA-Z0-9_-]{1,100}):cycle:(\d+)$/u.exec(previous.operationId);
    let revision = directPublication && directPublication[1] === memoryId ? Number(directPublication[2]) : undefined;
    if (bound) {
      const job = (await session.request({ type: 'jobs.inspect', ownerId: session.owner.id, kind: 'history_files', id: bound[1]! })).jobDisposition;
      if (job && job.memoryId === memoryId && job.retryCycle !== undefined && job.retryCycle >= Number(bound[2])) revision = job.contentRevision;
    }
    const scope = (await session.request({ type: 'memory.library.scope.read', companionId: session.owner.id })).conversation;
    if (!memoryId || !revision || !scope) throw new CompanionArtifactError('DENIED', '旧正文没有可核对的正式历史修订。');
    const descriptor = (await session.request({ type: 'memory.revision.describe', companionId: session.owner.id, conversationId: scope.id, id: memoryId, contentRevision: revision })).memoryHistoryDescriptor;
    if (!descriptor || descriptor.id !== memoryId || descriptor.contentRevision !== revision
      || (await session.request({ type: 'memory.lifecycle.state', companionId: session.owner.id })).memoryLifecycleState?.revocationEpoch !== epoch)
      throw new CompanionArtifactError('DENIED', '旧正文的真实来源或撤销版本已失效。');
  };
}

async function cleanKnownRetiredFilePublication(session: MemoryLibraryDocumentSession, publication: CompanionRegistryPublication, report?: (error: unknown) => void): Promise<void> {
  if (!['prepared', 'validated', 'file_published'].includes(publication.state)) return;
  const match = /^(source|history|memory)-file:([a-zA-Z0-9_-]{1,100}):cycle:(\d+)$/u.exec(publication.operationId);
  if (!match) return;
  const job = (await session.request({ type: 'jobs.inspect', ownerId: session.owner.id, kind: match[1] === 'source' ? 'source_files' : 'history_files', id: match[2]! })).jobDisposition;
  const cycle = Number(match[3]);
  if (!job || !belongsToJob(publication, job, match[1]!) || !Number.isSafeInteger(cycle) || job.retryCycle === undefined || job.retryCycle < cycle) return;
  if (!['parked', 'abandoned', 'cancelled', 'stale', 'completed'].includes(job.state) && job.retryCycle === cycle) return;
  await session.registry.cancelPublication(publication.operationId);
  for (const clean of [() => session.registry.discardPublishedFiles(publication.operationId, { validateMemoryRestore: restoreValidator(session) }), () => session.registry.purgePublicationStages(publication.operationId)]) {
    try { await clean(); } catch (cause) {
      // Only the exact retired package may be cleaned. Unknown canonical or
      // staged bytes remain conflicts and never authorize an overwrite.
      if (!(cause instanceof CompanionArtifactError) || cause.code !== 'CHANGED') throw cause;
      report?.(cause);
    }
  }
}

/** An interrupted package remains resumable in the same automatic cycle. Only
 * a durable hold/termination or an explicit newer recovery cycle can cancel it.
 * Registry cleanup independently verifies every canonical/staged byte; unknown
 * bytes remain a reported conflict, and never become permission to overwrite. */
export async function prepareMemoryFilePublication(session: MemoryLibraryDocumentSession, operationId?: string, report?: (error: unknown) => void): Promise<void> {
  const newCycle = operationId && /^(source|history|memory)-file:([a-zA-Z0-9_-]{1,100}):cycle:([1-9][0-9]*)$/u.exec(operationId);
  if (newCycle && Number.isSafeInteger(Number(newCycle[3]))) {
    // Start with the exact predecessor. Explicit recovery never scans an
    // owner's history, and a conflict remains a terminal record.
    const previousId = `${newCycle[1]}-file:${newCycle[2]}:cycle:${Number(newCycle[3]) - 1}`;
    const previous = await session.registry.publication(previousId);
    if (previous?.state === 'conflict') {
      try { await session.registry.purgePublicationStages(previousId); }
      catch (cause) { if (!(cause instanceof CompanionArtifactError) || cause.code !== 'CHANGED') throw cause; report?.(cause); }
    } else if (previous) await cleanKnownRetiredFilePublication(session, previous, report);
    // A user can hold/resume before an intermediate cycle ever prepares a
    // package. Query only this fixed job's indexed pending namespace; unrelated
    // active packages must not hide its older reservation behind owner page 1.
    const prefix = `${newCycle[1]}-file:${newCycle[2]}:cycle:`;
    for (const publication of await session.registry.pendingPublications({ operationPrefix: prefix, limit: 16 })) {
      const cycle = Number(publication.operationId.slice(prefix.length));
      if (Number.isSafeInteger(cycle) && cycle < Number(newCycle[3])) await cleanKnownRetiredFilePublication(session, publication, report);
    }
  }
  for (const publication of await session.registry.pendingPublications({ limit: 16 })) {
    if (publication.operationId === operationId) continue;
    const match = /^(source|history|memory)-file:([a-zA-Z0-9_-]{1,100}):cycle:(\d+)$/u.exec(publication.operationId);
    // An unrelated live package is not an owner-wide lock. The Registry's
    // indexed read/write/path reservations decide the exact target conflict.
    // Unknown packages remain intact; this helper never grants their deletion.
    if (!match) continue;
    await cleanKnownRetiredFilePublication(session, publication, report);
  }
}

export async function releaseHeldMemoryFilePublications(session: MemoryLibraryDocumentSession, report?: (error: unknown) => void): Promise<void> {
  try { await prepareMemoryFilePublication(session, undefined, report); }
  catch (cause) { report?.(cause); }
}
