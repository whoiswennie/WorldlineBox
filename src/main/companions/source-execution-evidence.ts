import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { CompanionMemory, CompanionMessage } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';

export type CompanionExecutionSourceProof = NonNullable<CompanionStorageResponse['executionSources']>[number];
const validationFrame = new AsyncLocalStorage<{ path: ReadonlySet<string>; completed: Map<string, boolean>; identities: Map<object, number> }>();

/** Only known host response fields carry source IDs. Source prose, arbitrary
 * native JSON, filenames and metadata lookalikes are never traversed. */
export function companionExecutionSourceReferences(response: CompanionStorageResponse): { sourceMessageIds: string[]; memoryIds: string[] } {
  const sources = new Set<string>(), memories = new Set<string>();
  const message = (value: CompanionMessage | undefined) => { if (value) sources.add(value.id); };
  const note = (value: CompanionMemory | undefined) => { if (value) { memories.add(value.id); for (const source of value.sources) sources.add(source.messageId); } };
  message(response.message); response.messages?.forEach(message); response.memorySources?.forEach(message); response.activityMessages?.forEach(message);
  response.activityProgressEvidence?.outbound.forEach(item => message(item.message));
  for (const source of response.activityReport?.executionReadset.sources ?? []) sources.add(source.id);
  response.topicCompactionPage?.items.forEach(item => message(item.message));
  response.searchPage?.items.forEach(hit => sources.add(hit.id));
  response.memories?.forEach(note); response.memoryPage?.items.forEach(hit => note(hit.memory)); response.memorySnapshot?.notes.forEach(note);
  note(response.memoryRead?.memory); response.memoryRead?.related.forEach(note); response.memoryRead?.sources.forEach(message);
  if (response.memoryOutbox?.operation === 'remember') note(response.memoryOutbox.note);
  response.memoryLibraryIndexPage?.notes.forEach(note); response.memoryLibraryChanges?.changes.forEach(change => note(change.note));
  for (const reference of response.memoryContext?.evidence?.references ?? []) {
    memories.add(reference.id);
    for (const source of reference.sources) sources.add(source.messageId);
  }
  for (const checkpoint of [response.topicState?.shared, response.topicState?.workingState,
    response.socialGameContext?.topicState.shared, response.socialGameContext?.topicState.workingState]) {
    for (const id of checkpoint?.sourceMessageIds ?? []) sources.add(id);
  }
  if (response.worldKnowledge?.evidenceMessageId) sources.add(response.worldKnowledge.evidenceMessageId);
  message(response.socialMessage?.message); response.socialMessagePage?.items.forEach(item => message(item.message));
  if (response.socialNotification) {
    const notice = response.socialNotification;
    sources.add(notice.sourceMessageId); notice.dialogue?.forEach(message);
    notice.progressEvidence?.outbound.forEach(item => message(item.message));
    for (const event of notice.events ?? [notice]) if (event.evidence.messageId) sources.add(event.evidence.messageId);
  }
  message(response.socialConversation?.lastMessage?.message); response.socialConversationPage?.items.forEach(room => message(room.lastMessage?.message));
  response.socialFlowPage?.items.forEach(item => message(item.message?.message));
  return { sourceMessageIds: [...sources], memoryIds: [...memories] };
}

const rereadable = new Set(['messages', 'message.get', 'message.search', 'memory.snapshot', 'memory.records.filter', 'memory.sources.filter',
  'memory.sources.search', 'memory.read', 'memory.inspect', 'memory.browse', 'memory.list', 'memory.library.read', 'memory.library.page',
  'memory.library.index-page', 'memory.library.changes', 'topic.read', 'topic.sources.valid', 'topic.compaction.sources', 'social.messages', 'social.conversations', 'social.flow', 'activity.progress']);
const validationReads = new Set([...rereadable, 'execution.sources', 'action.get', 'checkpoint.get', 'collaboration.read',
  'memory.prohibitions', 'memory.corpus.stamp', 'memory.documents.get', 'memory.document.get', 'social.job.game_context', 'activity.handoff', 'state', 'world.clock', 'world.state', 'runtime.read', 'character.development.read',
  'actions', 'actions.invocation', 'loop.get', 'work.list', 'memory.status']);
/** Anything not explicitly read-only advances Main's validation generation.
 * This is only a request-local memo boundary, never a permanent proof epoch. */
export function companionExecutionSourceReadOnly(command: CompanionStorageCommand): boolean { return validationReads.has(command.type); }

/** Share a dependency DAG only within one host read/preparation operation.
 * Every storage mutation still changes the revision and invalidates its keys. */
export function withCompanionExecutionValidation<T>(operation: () => Promise<T>): Promise<T> {
  return validationFrame.getStore() ? operation()
    : validationFrame.run({ path: new Set(), completed: new Map(), identities: new Map() }, operation);
}

/** Shared action dependencies are verified once in this read operation only.
 * Any overlapping write invalidates the result before it can be reused. */
export function memoCompanionExecutionValidation(key: string, revision: () => number, operation: () => Promise<boolean>): Promise<boolean> {
  return withCompanionExecutionValidation(async () => {
    const frame = validationFrame.getStore()!, captured = revision(), identity = `action:${key}:${captured}`;
    if (frame.path.has(identity)) return false;
    const cached = frame.completed.get(identity);
    if (cached !== undefined) return cached;
    const valid = await validationFrame.run({ ...frame, path: new Set([...frame.path, identity]) }, operation);
    if (captured === revision()) frame.completed.set(identity, valid);
    return valid;
  });
}

/** One Main boundary for snapshots, source reads and derived journals. The
 * storage port must be raw (not recursively routed through this function).
 * valid() may call normal guarded reads: AsyncLocalStorage tracks the current
 * dependency path, so A→B is legal, A→B→A fails, and parallel shared ancestors
 * do not falsely revoke each other. Mutations are never replayed here. */
export async function guardCompanionExecutionSources(command: CompanionStorageCommand, response: CompanionStorageResponse, ports: {
  storage(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  valid(proof: CompanionExecutionSourceProof, sqliteSourcesValidated?: boolean): Promise<boolean>;
  revision?(): number;
  identity?: object;
  invalidated?(response: CompanionStorageResponse): Promise<void> | void;
}): Promise<CompanionStorageResponse> {
  if (command.type.startsWith('execution.') || !response.ok) return response;
  const frame = validationFrame.getStore();
  if (!frame) return validationFrame.run({ path: new Set(), completed: new Map(), identities: new Map() }, () => guardCompanionExecutionSources(command, response, ports));
  if (response.memoryOutbox?.operation === 'forget') {
    const outbox = response.memoryOutbox;
    // Deletion consumes identity/version/lease only. Historical source data is
    // neither needed nor authorized merely to remove an obsolete native row.
    response = { ...response, memoryOutbox: { ...outbox, maintenanceOnly: true, contentAvailable: false,
      note: { ...outbox.note, content: '仅用于移除过期原生索引的维护凭证。', tags: [], sources: [], metadata: undefined,
        sourceFile: undefined, sourceMessageId: undefined, occurredAt: undefined, diaryName: undefined, sourceSequence: 0 } } };
  }
  const references = companionExecutionSourceReferences(response);
  if (!references.sourceMessageIds.length && !references.memoryIds.length) return response;
  const proofs = new Map<string, CompanionExecutionSourceProof>(), validatedRevisions = new Map<string, number>();
  const total = Math.max(references.sourceMessageIds.length, references.memoryIds.length);
  for (let offset = 0; offset < total; offset += 100) {
    const revision = ports.revision?.();
    const result = await ports.storage({ type: 'execution.sources', sourceMessageIds: references.sourceMessageIds.slice(offset, offset + 100), memoryIds: references.memoryIds.slice(offset, offset + 100) });
    if (!result.ok) throw new Error('派生来源的执行依赖暂不可核验。');
    for (const proof of result.executionSources ?? []) {
      const key = `${proof.kind}:${proof.id}`, previous = proofs.get(key);
      proofs.set(key, previous ? { ...proof, sourceMessageIds: [...new Set([...previous.sourceMessageIds, ...proof.sourceMessageIds])] } : proof);
      if (revision !== undefined && revision === ports.revision?.() && proof.executionReadset
        && proof.storageValidatedReadsetDigest === createHash('sha256').update(JSON.stringify(proof.executionReadset)).digest('hex')) validatedRevisions.set(key, revision);
      else validatedRevisions.delete(key);
    }
  }
  const invalid = new Set<string>(), owners = new Set<string>(), scopes = new Set<string>();
  for (const proof of proofs.values()) {
    if (ports.identity && !frame.identities.has(ports.identity)) frame.identities.set(ports.identity, frame.identities.size + 1);
    const key = JSON.stringify([ports.identity ? frame.identities.get(ports.identity) : 0,
      proof.kind, proof.id, proof.companionId, proof.conversationId]), ancestors = frame.path;
    let valid = false;
    if (!proof.invalidated && proof.executionReadset && !ancestors.has(key)) {
      const revision = ports.revision?.();
      const memoKey = createHash('sha256').update(JSON.stringify([key, proof.executionReadset, revision])).digest('hex');
      const completed = frame.completed.get(memoKey);
      if (completed !== undefined) valid = completed;
      else {
        const sqliteSourcesValidated = revision !== undefined && validatedRevisions.get(`${proof.kind}:${proof.id}`) === revision;
        try { valid = await validationFrame.run({ ...frame, path: new Set([...ancestors, key]) }, () => ports.valid(proof, sqliteSourcesValidated)); } catch { valid = false; }
        // A worker attestation cannot replace fresh SQL reads after a write
        // overlaps its use. Ordinary concurrent progress is not itself a
        // revocation: fall back to the original full verifier, without caching
        // a result across the mutation or replaying any effect.
        if (sqliteSourcesValidated && revision !== ports.revision?.()) {
          frame.completed.clear();
          try { valid = await validationFrame.run({ ...frame, path: new Set([...ancestors, key]) }, () => ports.valid(proof, false)); } catch { valid = false; }
        }
        if (revision === ports.revision?.()) frame.completed.set(memoKey, valid);
      }
    }
    if (valid) continue;
    proof.sourceMessageIds.forEach(id => invalid.add(id));
    // A historical invalid body still needs redaction on every read. Its
    // immutable tombstone has already advanced the corpus/evidence generation;
    // repeating that notification would prevent any context from stabilizing.
    if (proof.invalidated) continue;
    frame.completed.clear();
    const result = await ports.storage({ type: 'execution.invalidate', kind: proof.kind, id: proof.id, companionId: proof.companionId });
    if (!result.ok) throw new Error('失效的派生来源暂不可安全撤回。');
    result.memoryInvalidatedCompanionIds?.forEach(id => owners.add(id)); result.memoryInvalidatedScopeIds?.forEach(id => scopes.add(id));
    await ports.invalidated?.(result);
  }
  if (!invalid.size) return response;
  if (command.type === 'memory.outbox.claim' && response.memoryOutbox?.operation === 'remember') {
    // The invalidation has withdrawn/versioned the note. Acknowledge the old
    // remember lease without publishing it; the normal forget outbox remains
    // pending and can now run instead of waiting for an abandoned lease.
    const outbox = response.memoryOutbox;
    const settled = await ports.storage({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: false });
    if (!settled.ok) throw new Error('失效记忆的旧投递租约暂不可安全结算。');
    return { ...response, memoryOutbox: undefined,
      ...((owners.size || response.memoryInvalidatedCompanionIds?.length) ? { memoryInvalidatedCompanionIds: [...new Set([...owners, ...response.memoryInvalidatedCompanionIds ?? []])] } : {}),
      ...((scopes.size || response.memoryInvalidatedScopeIds?.length) ? { memoryInvalidatedScopeIds: [...new Set([...scopes, ...response.memoryInvalidatedScopeIds ?? []])] } : {}) };
  }
  // The worker's normal withdrawal changes the actual snapshot revision and
  // clears affected journal/state/outbox dependencies. Never reuse an old
  // snapshot revision or an old monthly artifact after merely filtering text.
  if (!rereadable.has(command.type)) throw new Error('本次读取的派生资料来源已经变化，旧正文不可继续使用。');
  const refreshed = await ports.storage(command);
  if (!refreshed.ok) throw new Error('派生资料已撤回，请重新读取当前仍有效的来源。');
  const redact = (message: CompanionMessage): CompanionMessage => invalid.has(message.id)
    ? { ...message, content: '这条记录的引用来源已经变化，旧正文不可再用。', attachments: [], segments: undefined, replyProgress: undefined, replyDraft: undefined } : message;
  if (refreshed.message) refreshed.message = redact(refreshed.message);
  if (refreshed.messages) refreshed.messages = refreshed.messages.map(redact);
  if (refreshed.memorySources) refreshed.memorySources = refreshed.memorySources.filter(message => !invalid.has(message.id));
  if (refreshed.topicCompactionPage) refreshed.topicCompactionPage.items = refreshed.topicCompactionPage.items.filter(item => !invalid.has(item.message.id));
  if (refreshed.activityMessages) refreshed.activityMessages = refreshed.activityMessages.filter(message => !invalid.has(message.id));
  // A refreshed native result must not recycle a withdrawn outgoing body as
  // sent-content evidence. Drop its observation as a whole rather than turn a
  // redaction placeholder into an alleged delivery or reuse its old checksum.
  if (refreshed.activityProgressEvidence?.outbound.some(item => invalid.has(item.message.id))) refreshed.activityProgressEvidence = undefined;
  if (refreshed.searchPage) refreshed.searchPage.items = refreshed.searchPage.items.filter(message => !invalid.has(message.id));
  if (refreshed.socialMessage) refreshed.socialMessage.message = redact(refreshed.socialMessage.message);
  refreshed.socialMessagePage?.items.forEach(item => { item.message = redact(item.message); });
  if (refreshed.socialConversation?.lastMessage) refreshed.socialConversation.lastMessage.message = redact(refreshed.socialConversation.lastMessage.message);
  refreshed.socialConversationPage?.items.forEach(room => { if (room.lastMessage) room.lastMessage.message = redact(room.lastMessage.message); });
  refreshed.socialFlowPage?.items.forEach(item => {
    if (!item.message) return;
    if (invalid.has(item.message.message.id)) { item.text = '这条记录的引用来源已经变化，旧正文不可再用。'; item.textTruncated = false; }
    item.message.message = redact(item.message.message);
  });
  return { ...refreshed,
    ...((owners.size || refreshed.memoryInvalidatedCompanionIds?.length) ? { memoryInvalidatedCompanionIds: [...new Set([...owners, ...refreshed.memoryInvalidatedCompanionIds ?? []])] } : {}),
    ...((scopes.size || refreshed.memoryInvalidatedScopeIds?.length) ? { memoryInvalidatedScopeIds: [...new Set([...scopes, ...refreshed.memoryInvalidatedScopeIds ?? []])] } : {}) };
}
