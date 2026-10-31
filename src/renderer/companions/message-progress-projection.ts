import type { CompanionMessage, CompanionReplyStreamEvent, CompanionState } from '../../shared/companions';

/** Identity is supplied only by the host for an already persisted draft. */
export function companionProgressMessage(event: CompanionReplyStreamEvent, state: CompanionState | null, conversationId: string | null, messages: readonly CompanionMessage[], topicId: string | null | undefined): CompanionMessage | undefined {
  const identity = event.messageIdentity, progress = event.progress;
  if (event.phase !== 'progress' || !identity || !progress || conversationId !== event.conversationId) return;
  const room = state?.conversations.find(item => item.id === conversationId);
  if (!room?.memberIds.includes(event.companionId) || !state?.companions.some(item => item.id === event.companionId)
    || state.resetJobs?.some(job => job.companionId === event.companionId && job.status !== 'completed')) return;
  if (progress.sourceMessageId !== undefined && progress.sourceMessageId !== event.sourceMessageId) return;
  if (topicId !== undefined && (identity.topicId ?? null) !== topicId) return;
  const source = messages.find(item => item.id === event.sourceMessageId);
  const existing = messages.find(item => item.id === event.messageId);
  if (source?.audience === 'agenda' || existing?.audience === 'agenda') return;
  const existingSource = existing?.replyToId ?? existing?.replyProgress?.sourceMessageId;
  if (existing && (existing.conversationId !== conversationId || existing.authorId !== event.companionId || existingSource !== event.sourceMessageId || existing.sequence !== identity.sequence || (existing.topicId ?? null) !== (identity.topicId ?? null))) return;
  const work = state.queue?.find(item => item.id === progress.workId);
  if (work && (work.conversationId !== conversationId || work.companionId !== event.companionId || work.sourceMessageId !== event.sourceMessageId || work.messageId !== undefined && work.messageId !== event.messageId)) return;
  if (source) {
    if (source.conversationId !== conversationId || source.status !== 'sent' || source.memoryEvidenceOnly || source.isReplyDraft || source.replyDraft
      || (source.topicId ?? null) !== (identity.topicId ?? null) || source.sequence >= identity.sequence) { if (!existing) return; }
  } else if ((!work || !['queued', 'running', 'interrupted'].includes(work.status)) && existingSource !== event.sourceMessageId) return;
  if (existing && (!existing.isReplyDraft && !existing.replyDraft && !!existing.segments?.length || (existing.replyProgress?.revision ?? 0) >= progress.revision)) return existing;
  return existing ? { ...existing, replyProgress: progress } : {
    id: event.messageId, conversationId, sequence: identity.sequence, authorId: event.companionId,
    kind: 'text', content: '', attachments: [], status: 'sent', createdAt: identity.createdAt,
    ...(identity.topicId ? { topicId: identity.topicId } : {}), replyToId: event.sourceMessageId,
    isReplyDraft: true, segments: [], replyProgress: progress,
  };
}

/** Retain only a newer live identity, never arbitrary old rows from a snapshot. */
export function preserveCompanionProgressMessages(page: CompanionMessage[], current: readonly CompanionMessage[], events: Iterable<CompanionReplyStreamEvent>, state: CompanionState | null, conversationId: string, topicId: string | null | undefined): CompanionMessage[] {
  const result = new Map(page.map(item => [item.id, item]));
  const newest = page.at(-1)?.sequence ?? 0;
  // A visible draft can outlive the bounded IPC identity buffer. Retain only its
  // newer progress on the exact row that the fresh host page still authorizes;
  // never resurrect its former content or an identity absent from that page.
  for (const draft of current) {
    const persisted = result.get(draft.id), progress = draft.replyProgress;
    const sourceMessageId = draft.replyToId ?? progress?.sourceMessageId;
    if (!persisted || !progress || !sourceMessageId || !draft.isReplyDraft && !draft.replyDraft
      || (persisted.replyProgress?.revision ?? 0) >= progress.revision) continue;
    const projected = companionProgressMessage({ conversationId: draft.conversationId, companionId: draft.authorId,
      sourceMessageId, messageId: draft.id, step: 0, attemptId: 'snapshot-progress', phase: 'progress', text: '', progress,
      messageIdentity: { sequence: draft.sequence, createdAt: draft.createdAt, ...(draft.topicId ? { topicId: draft.topicId } : {}) } }, state, conversationId, page, topicId);
    if (projected && projected.replyProgress === progress) result.set(draft.id, { ...persisted, replyProgress: progress });
  }
  for (const event of events) {
    const persisted = result.get(event.messageId);
    if (!persisted && (event.messageIdentity?.sequence ?? 0) <= newest) continue;
    const draft = companionProgressMessage(event, state, conversationId, [...current, ...page], topicId);
    if (!draft) continue;
    if (persisted) {
      if (!persisted.isReplyDraft && !persisted.replyDraft && !!persisted.segments?.length) continue;
      if ((persisted.replyProgress?.revision ?? 0) >= (draft.replyProgress?.revision ?? 0)) continue;
      result.set(draft.id, { ...persisted, replyProgress: draft.replyProgress });
    } else {
      result.set(draft.id, draft);
      // The user acknowledgement may also be newer than a history read that
      // started before sending. Keep that exact scoped source beside its draft.
      const source = current.find(item => item.id === event.sourceMessageId);
      if (source && source.sequence > newest) result.set(source.id, source);
    }
  }
  return [...result.values()].sort((left, right) => left.sequence - right.sequence);
}
