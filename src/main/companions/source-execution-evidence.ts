import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { CompanionMemory, CompanionMessage } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';

export type CompanionExecutionSourceProof = NonNullable<CompanionStorageResponse['executionSources']>[number];
type CompanionAuthorityVerifier = (proofs: readonly CompanionExecutionSourceProof[]) => Promise<ReadonlyMap<string, boolean>>;
interface CompanionAuthorityEntry { proof: CompanionExecutionSourceProof; result?: boolean; pending?: Promise<boolean>; consumed: boolean }
interface CompanionAuthorityGroup { verify: CompanionAuthorityVerifier; entries: Map<string, CompanionAuthorityEntry> }
interface CompanionAuthorityFrame { groups: Map<object, CompanionAuthorityGroup>; sealed: boolean; validation?: Promise<void> }
interface CompanionWitnessEntry { key: string; value?: unknown; ready: boolean; consumed: boolean; pending?: Promise<unknown> }
interface CompanionWitnessGroup { entries: Map<string, CompanionWitnessEntry>; verify(entries: readonly { key: string; value: unknown }[]): Promise<void> }
type CompanionSourceReferences = { sourceMessageIds: string[]; memoryIds: string[] };
interface CompanionSourceEntry { references: CompanionSourceReferences; proofs: CompanionExecutionSourceProof[]; consumed: boolean }
interface CompanionSourceGroup {
  storage(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  entries: Map<string, CompanionSourceEntry>;
}
interface CompanionAdmissionEntry { value?: unknown; ready: boolean; cacheable: boolean; consumed: boolean; pending?: Promise<unknown>; verify(): Promise<void> }
type CompanionExecutionValidationFrame = { path: ReadonlySet<string>; completed: Map<string, boolean>; pending: Map<string, Promise<boolean>>;
  identities: Map<object, number>; lifetime: { active: boolean }; authorities: CompanionAuthorityFrame;
  witnesses: Map<object, Map<string, CompanionWitnessGroup>>; sqlWitnesses: Map<object, Map<string, CompanionWitnessGroup>>; sources: Map<object, CompanionSourceGroup>;
  admissions: Map<object, Map<string, CompanionAdmissionEntry>>; signal?: AbortSignal };
const validationFrame = new AsyncLocalStorage<CompanionExecutionValidationFrame>();

function clearValidationFrame(frame: CompanionExecutionValidationFrame): void {
  frame.lifetime.active = false; frame.completed.clear(); frame.pending.clear(); frame.identities.clear();
  frame.authorities.sealed = true; frame.authorities.groups.clear();
  frame.witnesses.clear(); frame.sqlWitnesses.clear(); frame.sources.clear(); frame.admissions.clear();
}

/** Cancellation is task control, never evidence that a source was withdrawn. */
function assertValidationActive(): void { validationFrame.getStore()?.signal?.throwIfAborted(); }
/** Canonical I/O loops stop before starting another chunk after cancellation
 * or closure; already-started filesystem work may still settle normally. */
export function assertCompanionExecutionWitnessActive(): void {
  assertValidationActive();
  const frame = validationFrame.getStore();
  if (frame && !frame.lifetime.active) throw new DOMException('Execution validation session closed.', 'AbortError');
}

/** Start an independently owned background job outside a caller's read DAG.
 * Foreground continuations must keep their inherited frame and cancellation. */
export function detachedCompanionExecutionValidation<T>(operation: () => T): T { return validationFrame.exit(operation); }

function abortableValidation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    // Register both handlers before returning. A cancelled caller need not wait
    // for local I/O to settle, and a later rejection is still fully observed.
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function authorityResults(proofs: readonly CompanionExecutionSourceProof[], results: ReadonlyMap<string, boolean>): void {
  for (const proof of proofs) if (!results.has(proof.id) || typeof results.get(proof.id) !== 'boolean')
    throw new Error('执行来源的当前授权暂不可完整核验。');
}

function authorityProofKey(proof: CompanionExecutionSourceProof): string {
  const capability = proof.capability;
  return createHash('sha256').update(JSON.stringify([proof.kind, proof.id, proof.companionId, proof.conversationId, !!proof.invalidated,
    capability && [capability.name, capability.callId, capability.invocationId, capability.agendaRunId, capability.inputHash, capability.audience], proof.executionReadset])).digest('hex');
}

function sourceProofKey(proof: CompanionExecutionSourceProof): string { return `${proof.kind}:${proof.id}`; }
function sourceReferencesCover(cover: CompanionSourceReferences, wanted: CompanionSourceReferences): boolean {
  const sources = new Set(cover.sourceMessageIds), memories = new Set(cover.memoryIds);
  return wanted.sourceMessageIds.every(id => sources.has(id)) && wanted.memoryIds.every(id => memories.has(id));
}
function strongSourceProof(proof: CompanionExecutionSourceProof): boolean {
  return !proof.invalidated && proof.storageValidatedAuthorityEpoch !== undefined && !!proof.executionReadset
    && proof.storageValidatedReadsetDigest === createHash('sha256').update(JSON.stringify(proof.executionReadset)).digest('hex');
}
function sourceProofBinding(proof: CompanionExecutionSourceProof): string {
  return JSON.stringify([proof.kind, proof.id, proof.companionId, proof.conversationId, !!proof.invalidated,
    proof.executionReadset, proof.capability, proof.storageValidatedReadsetDigest, proof.storageValidatedAuthorityEpoch]);
}
function mergeSourceProof(proofs: Map<string, CompanionExecutionSourceProof>, proof: CompanionExecutionSourceProof): void {
  const key = sourceProofKey(proof), previous = proofs.get(key);
  if (previous && sourceProofBinding(previous) !== sourceProofBinding(proof)) throw new Error('派生来源正在变化，当前执行依赖暂不可稳定核验，请稍后重试。');
  proofs.set(key, previous ? { ...proof, sourceMessageIds: [...new Set([...previous.sourceMessageIds, ...proof.sourceMessageIds])] } : proof);
}

/** SQL proofs are initial witnesses, never permanent authority. Repeated exact
 * reads may share a strong proof only until this gate's fresh union fence. */
async function validateFrameSourceAttestations(frame: CompanionExecutionValidationFrame): Promise<void> {
  for (const group of frame.sources.values()) {
    const entries = [...group.entries.values()].filter(entry => entry.consumed);
    if (!entries.length) continue;
    const expected = new Map<string, CompanionExecutionSourceProof>(), sources = new Set<string>(), memories = new Set<string>();
    for (const entry of entries) {
      entry.references.sourceMessageIds.forEach(id => sources.add(id)); entry.references.memoryIds.forEach(id => memories.add(id));
      for (const proof of entry.proofs) {
        mergeSourceProof(expected, proof);
        // Note-only reads resolve through their original message roots. Make
        // those roots explicit so batching cannot lose a shared association.
        proof.sourceMessageIds.forEach(id => sources.add(id));
      }
    }
    const sourceMessageIds = [...sources].sort(), memoryIds = [...memories].sort(), actual = new Map<string, CompanionExecutionSourceProof>();
    for (let offset = 0; offset < Math.max(sourceMessageIds.length, memoryIds.length); offset += 100) {
      assertValidationActive();
      const result = await group.storage({ type: 'execution.sources', sourceMessageIds: sourceMessageIds.slice(offset, offset + 100), memoryIds: memoryIds.slice(offset, offset + 100) });
      assertValidationActive();
      if (!frame.lifetime.active) throw new Error('执行来源核验窗口已经关闭。');
      if (!result.ok) throw new Error('派生来源的当前执行依赖暂不可核验，请稍后重试。');
      for (const proof of result.executionSources ?? []) mergeSourceProof(actual, proof);
    }
    if (actual.size !== expected.size) throw new Error('派生来源的执行依赖已经变化，旧内容不可继续发布，请重新读取。');
    for (const [key, proof] of expected) {
      const current = actual.get(key);
      if (!current || !strongSourceProof(current) || sourceProofBinding(current) !== sourceProofBinding(proof)
        || JSON.stringify([...new Set(proof.sourceMessageIds)].sort()) !== JSON.stringify([...new Set(current.sourceMessageIds)].sort()))
        throw new Error('派生来源的执行依赖已经变化，旧内容不可继续发布，请重新读取。');
    }
  }
}

/** Seal this finite gate before returning its bodies or dispatching a model.
 * Final checks call the uncached port directly and cannot register new fences. */
function validateFrameAuthorities(frame: CompanionExecutionValidationFrame): Promise<void> {
  if (frame.authorities.validation) return frame.authorities.validation;
  if (!frame.lifetime.active) return Promise.reject(new Error('执行来源核验窗口已经关闭。'));
  frame.authorities.sealed = true;
  const validation = validationFrame.run(frame, () => abortableValidation(async () => {
    // Canonical witnesses are bracketed by their own fresh SQL/file fence.
    // Action authority runs afterwards, so revocation during file I/O cannot
    // pass on an authorization checked before that asynchronous work.
    for (const scopes of frame.witnesses.values()) for (const group of scopes.values()) {
      assertValidationActive();
      await group.verify([...group.entries.values()].filter(entry => entry.consumed).map(entry => ({ key: entry.key, value: entry.value })));
      assertValidationActive();
      if (!frame.lifetime.active) throw new Error('执行来源核验窗口已经关闭。');
    }
    // External library assets can change during canonical file work. Their
    // fresh revalidation precedes SQL source epochs and live action authority.
    for (const entries of frame.admissions.values()) for (const entry of entries.values()) if (entry.consumed) {
      assertValidationActive(); await entry.verify(); assertValidationActive();
      if (!frame.lifetime.active) throw new Error('执行来源核验窗口已经关闭。');
    }
    // Exact SQL file authority follows every asynchronous canonical/asset
    // check, including files belonging to another owner in the same gate.
    for (const scopes of frame.sqlWitnesses.values()) for (const group of scopes.values()) {
      assertValidationActive();
      await group.verify([...group.entries.values()].filter(entry => entry.consumed).map(entry => ({ key: entry.key, value: entry.value })));
      assertValidationActive();
      if (!frame.lifetime.active) throw new Error('执行来源核验窗口已经关闭。');
    }
    // A source closure's final raw SQL snapshot follows all asynchronous file
    // work and precedes live capability checks. No cached proof crosses it.
    await validateFrameSourceAttestations(frame);
    for (const group of frame.authorities.groups.values()) {
      let remaining = [...group.entries.values()].filter(entry => entry.consumed && entry.result === true);
      // A changing exact binding for one action never lets a Map keyed by ID
      // replace an earlier consumed binding. Check each variant independently.
      while (remaining.length) {
        assertValidationActive();
        const ids = new Set<string>(), batch: CompanionAuthorityEntry[] = [], next: CompanionAuthorityEntry[] = [];
        for (const entry of remaining) { if (ids.has(entry.proof.id)) next.push(entry); else { ids.add(entry.proof.id); batch.push(entry); } }
        remaining = next;
        const proofs = batch.map(entry => entry.proof), current = await group.verify(proofs);
        assertValidationActive();
        if (!frame.lifetime.active) throw new Error('执行来源核验窗口已经关闭。');
        authorityResults(proofs, current);
        if (proofs.some(proof => current.get(proof.id) !== true)) throw new Error('执行来源的授权已经变化，旧内容不可继续发布，请重新读取。');
      }
    }
    assertValidationActive();
  }, frame.signal));
  frame.authorities.validation = validation;
  return validation;
}

/** Share healthy first admission only in an already active finite gate. The
 * final verifier must perform fresh I/O, including when initial admission had
 * real side effects and therefore could not be cached. Standalone callers
 * keep their existing operation and error/withdrawal semantics. */
export function memoCompanionExecutionAdmission<T>(key: string, port: {
  identity: object; read(): Promise<T>; cacheable(value: T): boolean; verify(): Promise<void>;
}): Promise<T> {
  const frame = validationFrame.getStore();
  assertValidationActive();
  if (!frame?.lifetime.active) return port.read();
  if (frame.authorities.sealed) return Promise.reject(new Error('执行来源核验窗口已经封口。'));
  if (!frame.identities.has(port.identity)) frame.identities.set(port.identity, frame.identities.size + 1);
  const marker = `admission:${frame.identities.get(port.identity)}:${key}`;
  if (frame.path.has(marker)) return Promise.reject(new Error('来源准入核验发生递归读取。'));
  let entries = frame.admissions.get(port.identity);
  if (!entries) { entries = new Map(); frame.admissions.set(port.identity, entries); }
  let entry = entries.get(key);
  if (entry?.pending && !entry.ready && [...frame.path].some(part => part.startsWith('admission:')))
    return Promise.reject(new Error('来源准入核验发生交叉递归读取。'));
  if (!entry || entry.ready && !entry.cacheable) {
    entry = { ready: false, cacheable: false, consumed: entry?.consumed ?? false, verify: port.verify }; entries.set(key, entry);
    const current = entry, currentEntries = entries;
    current.pending = Promise.resolve().then(() => { assertValidationActive(); return validationFrame.run({ ...frame, path: new Set([...frame.path, marker]) }, port.read); }).then(value => {
      assertValidationActive();
      if (!frame.lifetime.active || frame.authorities.sealed) throw new Error('执行来源核验窗口已经关闭。');
      current.value = structuredClone(value); current.ready = true; current.cacheable = port.cacheable(value); return current.value;
    }).catch(error => {
      if (currentEntries.get(key) === current) {
        if (current.consumed) { current.ready = true; current.cacheable = false; current.pending = undefined; }
        else currentEntries.delete(key);
      }
      throw error;
    });
  }
  const selected = entry;
  return (selected.ready ? Promise.resolve(selected.value) : selected.pending!).then(value => {
    assertValidationActive();
    if (!frame.lifetime.active || frame.authorities.sealed) throw new Error('执行来源核验窗口已经关闭。');
    selected.consumed = true; return structuredClone(value) as T;
  });
}

/** Initial admission is shared only inside one finite gate. The port's final
 * verifier must bypass this ledger and recheck all consumed witnesses fresh. */
export function memoCompanionExecutionWitnesses<T>(keys: readonly string[], port: {
  identity: object; scope: string; revision(): number;
  phase?: 'sql-authority';
  read(keys: readonly string[]): Promise<ReadonlyMap<string, T>>;
  verify(entries: readonly { key: string; value: T }[]): Promise<void>;
}): Promise<ReadonlyMap<string, T>> {
  return withCompanionExecutionValidation(async () => {
    const frame = validationFrame.getStore()!;
    assertValidationActive();
    if (frame.authorities.sealed) throw new Error('执行来源核验窗口已经封口。');
    const ledger = port.phase === 'sql-authority' ? frame.sqlWitnesses : frame.witnesses;
    let scopes = ledger.get(port.identity);
    if (!scopes) { scopes = new Map(); ledger.set(port.identity, scopes); }
    let group = scopes.get(port.scope);
    if (!group) { group = { entries: new Map(), verify: entries => port.verify(entries as readonly { key: string; value: T }[]) }; scopes.set(port.scope, group); }
    if (!frame.identities.has(port.identity)) frame.identities.set(port.identity, frame.identities.size + 1);
    const generation = port.revision(), prefix = `witness:${port.phase ?? 'canonical'}:${frame.identities.get(port.identity)}:${port.scope}:`;
    const selected = new Map<string, CompanionWitnessEntry>(), missing: Array<[string, CompanionWitnessEntry]> = [];
    for (const key of new Set(keys)) {
      const identity = prefix + JSON.stringify([generation, key]);
      if (frame.path.has(identity)) throw new Error('认知登记核验发生递归读取。');
      let entry = group.entries.get(identity);
      if (entry?.pending && !entry.ready && [...frame.path].some(part => part.startsWith('witness:')))
        throw new Error('认知登记核验发生交叉递归读取。');
      if (!entry) { entry = { key, ready: false, consumed: false }; group.entries.set(identity, entry); missing.push([identity, entry]); }
      selected.set(key, entry);
    }
    if (missing.length) {
      const currentGroup = group, requested = missing.map(([, entry]) => entry.key);
      const work = Promise.resolve().then(() => validationFrame.run({ ...frame, path: new Set([...frame.path, ...missing.map(([identity]) => identity)]) },
        () => abortableValidation(() => port.read(requested), frame.signal))).then(values => {
        for (const key of requested) if (!values.has(key)) throw new Error('认知登记核验未返回完整凭证。');
        return values;
      });
      for (const [identity, entry] of missing) entry.pending = work.then(values => {
        assertValidationActive();
        if (!frame.lifetime.active || frame.authorities.sealed) throw new Error('执行来源核验窗口已经关闭。');
        entry.value = structuredClone(values.get(entry.key)); entry.ready = true; return entry.value;
      }).catch(error => { if (currentGroup.entries.get(identity) === entry) currentGroup.entries.delete(identity); throw error; });
    }
    const result = new Map<string, T>();
    await Promise.all([...selected].map(async ([key, entry]) => {
      const value = entry.ready ? entry.value : await entry.pending;
      assertValidationActive();
      if (!frame.lifetime.active || frame.authorities.sealed) throw new Error('执行来源核验窗口已经关闭。');
      entry.consumed = true; result.set(key, structuredClone(value) as T);
    }));
    return result;
  });
}

/** Cache only first admission inside this finite gate. Every consumed success
 * is freshly batch-checked once again at the outer return/dispatch boundary. */
export function memoCompanionExecutionAuthorities(proofs: readonly CompanionExecutionSourceProof[], verifyUncached: CompanionAuthorityVerifier,
  identity: object): Promise<ReadonlyMap<string, boolean>> {
  return withCompanionExecutionValidation(async () => {
    const frame = validationFrame.getStore()!;
    assertValidationActive();
    if (frame.authorities.sealed) throw new Error('执行来源授权核验已经封口，请开启新的读取窗口。');
    const exactIds = new Map<string, string>();
    for (const proof of proofs) {
      const key = authorityProofKey(proof), previous = exactIds.get(proof.id);
      if (previous !== undefined && previous !== key) throw new Error('同一执行来源携带不同授权依赖，暂不可稳定核验。');
      exactIds.set(proof.id, key);
    }
    if (!frame.identities.has(identity)) frame.identities.set(identity, frame.identities.size + 1);
    const marker = (key: string) => 'authority:' + frame.identities.get(identity) + ':' + key;
    let group = frame.authorities.groups.get(identity);
    if (!group) { group = { verify: verifyUncached, entries: new Map() }; frame.authorities.groups.set(identity, group); }
    const selected = new Map<string, CompanionAuthorityEntry>(), missing: Array<[string, CompanionAuthorityEntry]> = [];
    for (const proof of proofs) {
      const key = authorityProofKey(proof);
      if (frame.path.has(marker(key))) throw new Error('执行授权核验发生递归读取，暂不可稳定核验。');
      let entry = group.entries.get(key);
      // An uncached verifier must not wait on another verifier that can wait
      // back on it. Ordinary concurrent callers (outside these ports) coalesce.
      if (entry?.pending && entry.result === undefined && [...frame.path].some(part => part.startsWith('authority:')))
        throw new Error('执行授权核验发生交叉递归读取，暂不可稳定核验。');
      if (!entry) {
        // Hold exact host bindings, never a mutable caller object that a later
        // repair or asynchronous callback can rewrite before the final fence.
        entry = { proof: structuredClone(proof), consumed: false }; group.entries.set(key, entry); missing.push([key, entry]);
      }
      selected.set(proof.id, entry);
    }
    if (missing.length) {
      const currentGroup = group, expected = missing.map(([, entry]) => entry.proof);
      // Fill all pending slots before invoking a port that may reenter Main.
      const work = Promise.resolve().then(() => {
        assertValidationActive();
        const current = validationFrame.getStore()!;
        return validationFrame.run({ ...current, path: new Set([...current.path, ...missing.map(([key]) => marker(key))]) },
          () => abortableValidation(() => verifyUncached(expected), frame.signal));
      }).then(current => { authorityResults(expected, current); return current; });
      for (const [key, entry] of missing) entry.pending = work.then(current => {
        assertValidationActive();
        if (!frame.lifetime.active || frame.authorities.sealed) throw new Error('执行来源核验窗口已经关闭。');
        entry.result = current.get(entry.proof.id)!; return entry.result;
      }).catch(error => { if (currentGroup.entries.get(key) === entry) currentGroup.entries.delete(key); throw error; });
    }
    const results = new Map<string, boolean>();
    await Promise.all([...selected].map(async ([id, entry]) => {
      const valid = entry.result ?? await entry.pending!;
      assertValidationActive();
      if (!frame.lifetime.active || frame.authorities.sealed) throw new Error('执行来源核验窗口已经关闭。');
      if (valid) entry.consumed = true;
      results.set(id, valid);
    }));
    return results;
  });
}

/** Only known host response fields carry source IDs. Source prose, arbitrary
 * native JSON, filenames and metadata lookalikes are never traversed. */
export function companionExecutionSourceReferences(response: CompanionStorageResponse): { sourceMessageIds: string[]; memoryIds: string[] } {
  const sources = new Set<string>(), memories = new Set<string>();
  const message = (value: CompanionMessage | undefined) => {
    // Running text is a UI projection, not a formal inference source. Its
    // same-ID publication may legitimately add the first execution proof
    // while this read gate is open. Tool cards retain their live authority
    // checks, and user/system fields cannot impersonate a companion draft.
    if (value && !(value.kind === 'text' && value.authorId !== 'user' && value.authorId !== 'system'
      && (value.isReplyDraft || value.replyDraft))) sources.add(value.id);
  };
  const note = (value: Pick<CompanionMemory, 'id' | 'sources'> | undefined) => { if (value) { memories.add(value.id); for (const source of value.sources) sources.add(source.messageId); } };
  message(response.message); response.messages?.forEach(message); response.memorySources?.forEach(message); response.activityMessages?.forEach(message);
  response.activityProgressEvidence?.outbound.forEach(item => message(item.message));
  for (const source of response.activityReport?.executionReadset.sources ?? []) sources.add(source.id);
  response.topicCompactionPage?.items.forEach(item => message(item.message));
  response.searchPage?.items.forEach(hit => sources.add(hit.id));
  response.memories?.forEach(note); response.memoryPage?.items.forEach(hit => note(hit.memory)); response.memorySnapshot?.notes.forEach(note);
  response.memoryDescriptors?.forEach(note);
  response.memoryCaptureContributions?.items.forEach(note);
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
  'memory.records.describe',
  'memory.sources.search', 'memory.read', 'memory.inspect', 'memory.browse', 'memory.list', 'memory.library.read', 'memory.library.page',
  'memory.library.index-page', 'memory.library.changes', 'memory.jobs.contributions', 'topic.read', 'topic.sources.valid', 'topic.compaction.sources', 'social.messages', 'social.conversations', 'social.flow', 'activity.progress']);
const validationReads = new Set([...rereadable, 'execution.sources', 'execution.capabilities.validate', 'action.get', 'capability.for-task', 'checkpoint.get', 'collaboration.read',
  'cognition.registry.read', 'cognition.registry.page', 'cognition.registry.publication.read', 'cognition.registry.publication.pending', 'cognition.registry.refs.validate',
  'growth.goals.list', 'jobs.inspect', 'jobs.page', 'character.development', 'character.development.scopes.page', 'memory.lifecycle.state', 'state.get', 'state.inspect',
  'companion.creation.status', 'companion.creation.pending',
  // Calendar/task polling reads existing rows and may redact unavailable
  // bodies, but never edits their sources, grants or execution readsets.
  'agenda.read', 'agenda.event.read', 'agenda.tasks.read', 'agenda.goals.read', 'agenda.goal.read', 'agenda.grants.read', 'agenda.run.read', 'agenda.step.read',
  'activity.agenda.pending', 'activity.agenda.get', 'activity.get',
  // The chat header polls world.status every 1.5 seconds. It advances the
  // same observational clock as world.clock, then reads contact state only.
  // Learning grant/status reads likewise cannot revoke or publish a source.
  'world.status', 'world.tick', 'world.observe', 'learning.status',
  'memory.prohibitions', 'memory.corpus.stamp', 'memory.recall.authority', 'memory.documents.get', 'memory.document.get', 'social.job.game_context', 'activity.handoff', 'state', 'world.clock', 'world.state', 'runtime.read', 'character.development.read',
  'actions', 'actions.invocation', 'actions.ongoing', 'actions.page', 'loop.get', 'work.list', 'memory.status', 'memory.frozen.valid',
  'memory.revision.read', 'memory.revision.describe', 'memory.revisions.describe', 'memory.files.inspect', 'memory.files.state', 'memory.history.outbox.check',
  'memory.projection.state', 'memory.projection.page', 'memory.projection.delta',
  'memory.tags.status', 'memory.tags.validate', 'memory.processing.status', 'memory.policy.list', 'memory.library.index-state', 'memory.library.scope.read', 'memory.outbox.pending',
  'document.catalog.query', 'world.clock.peek', 'routine.get', 'schedule.list', 'schedule.get', 'activity.list', 'social.days', 'social.graph', 'social.reply.progress', 'task-stop.list', 'tasks.page', 'tasks.resolve', 'tasks.concurrency.get']);
// tags.status may discover pending tag jobs, but cannot edit a note. In
// contrast memory.library.scope can create a hidden private conversation and
// its membership, so it deliberately retains the conservative mutation fence.
// Canonical validators use memory.library.scope.read instead: that exact port
// requires an existing entrance/membership and cannot grant new authority.
// These commands change only the disposable file-search catalogue. Catalogue
// candidates are re-read and authorized before publication; none can change a
// message, note, permission, execution proof or context revision.
// routine.get may initialize/reconcile its routine and advance poses, work
// clocks or new experience receipts (as world.clock already does). None edits
// an existing source, indexed note, execution readset, membership or grant.
// Its observational polling must not discard a foreground history DAG memo.
// The 500ms world.tick advances physics and appends new observations; it does
// not rewrite previously consumed bodies. Live leases/grants are separately
// admitted and freshly checked at the finite gate's final authority fence.
// Actual source withdrawals reported by a tick still advance Main's revision.
const derivedCatalogWrites = new Set([
  // Scheduling/lease admission changes live authority, not historical input
  // bytes. Main checks that authority independently before and after using
  // the finite body DAG, including changes made by another SQLite writer.
  'agenda.tick', 'agenda.claim', 'agenda.run.bindGrant', 'agenda.run.checkpoint', 'agenda.run.heartbeat', 'agenda.run.settle',
  'world.work.begin', 'world.work.end', 'social.job.check', 'social.job.progress',
  'interruption.begin', 'interruption.end', 'work.enqueue', 'work.claim', 'agenda.rule.create',
  // Appending another task/message and advancing its private journal do not
  // rewrite this task's captured sources. Each new row still crosses the
  // ordinary ACL/provenance guard, and withdrawal flags remain authoritative.
  'message.append', 'social.send', 'social.conversation.ensure', 'activity.social.route',
  // These update attention/reply bookkeeping or append a new notification
  // message; they never replace a consumed body or its execution proof.
  'world.attention.record', 'reply.checkpoint.complete', 'social.notification.complete',
  'social.job.claim', 'social.notification.claim', 'world.job.claim',
  'social.job.assets.save', 'social.job.preparation.save', 'agent.run.save',
  'social.job.defer', 'social.notification.defer', 'world.job.defer',
  // Durable compaction scheduling changes no message, checkpoint or source ACL.
  'topic.compaction.enqueue', 'topic.compaction.bind', 'topic.compaction.claim', 'topic.compaction.check', 'topic.compaction.settle', 'topic.compaction.fail','document.catalog.touch', 'document.catalog.put', 'document.catalog.drop', 'document.catalog.finish',
  'character.development.scopes.ack', 'cognition.registry.publication.stages-cleaned', 'cognition.registry.body-removed',
  // Capture scheduling may release/retry a lease; it cannot change the raw
  // evidence or any published task/note body. Completion remains a mutation.
  'memory.jobs.defer', 'memory.jobs.fail',
  'memory.jobs.retry-admission', 'memory.tags.retry-admission', 'world.job.retry-admission',
  'memory.jobs.proposal.read', 'memory.jobs.proposal.save',
  'memory.projection.release',
  'memory.sources.outbox.owners', 'memory.sources.outbox.claim', 'memory.sources.outbox.check', 'memory.sources.outbox.complete', 'memory.sources.outbox.fail',
  'memory.history.outbox.owners', 'memory.history.outbox.claim', 'memory.history.outbox.complete', 'memory.history.outbox.fail',
  'companion.assets.initialized', 'companion.assets.mark-initialized', 'companion.assets.portrait.initialized', 'companion.assets.portrait.mark-initialized']);
/** Anything not explicitly body-neutral advances Main's validation generation.
 * This is only a request-local memo boundary, never a permanent proof epoch. */
export function companionExecutionSourceReadOnly(command: CompanionStorageCommand): boolean {
  // In-flight draft/progress saves cannot publish a source or bind an execution
  // proof. Storage rejects done -> running transitions. Treating every clock
  // update as a source mutation invalidated all shared historical DAG checks
  // while a foreground context was still being prepared.
  if (command.type === 'loop.save' && command.checkpoint?.status === 'running' && !command.executionReadset) return true;
  // Typed query ports describe current rows; they do not mutate previously
  // consumed inputs. Treating an omitted getter (player.profile.get, job.read,
  // learning.assets.snapshot, etc.) as a write invalidated the very DAG it
  // was being used to validate. Actual withdrawal flags from any response
  // still advance Main's revision, independently of this query classification.
  if (/\.(?:read|get|list|page|inspect|status|describe|snapshot|filter|search)$/u.test(command.type)) return true;
  return validationReads.has(command.type) || derivedCatalogWrites.has(command.type);
}

/** Share a dependency DAG only within one host read/preparation operation.
 * Every source-affecting storage mutation changes the revision and invalidates
 * its keys; observational clocks and unfinished drafts carry no formal proof. */
export function withCompanionExecutionValidation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const inherited = validationFrame.getStore();
  // Inherited background branches retain cancellation even after their parent's
  // frame has finished. They may never resume in a new signal-free frame.
  inherited?.signal?.throwIfAborted(); signal?.throwIfAborted();
  const effectiveSignal = inherited?.signal && signal && inherited.signal !== signal
    ? AbortSignal.any([inherited.signal, signal]) : signal ?? inherited?.signal;
  if (inherited?.lifetime.active) {
    if (effectiveSignal === inherited.signal) return operation();
    return validationFrame.run({ ...inherited, signal: effectiveSignal }, () => abortableValidation(operation, effectiveSignal));
  }
  const frame: CompanionExecutionValidationFrame = { path: new Set<string>(), completed: new Map<string, boolean>(), pending: new Map<string, Promise<boolean>>(),
    identities: new Map<object, number>(), lifetime: { active: true }, authorities: { groups: new Map(), sealed: false }, witnesses: new Map(), sqlWitnesses: new Map(), sources: new Map(), admissions: new Map(), signal: effectiveSignal };
  return validationFrame.run(frame, async () => {
    try {
      const result = await abortableValidation(operation, effectiveSignal);
      await validateFrameAuthorities(frame);
      return result;
    }
    finally {
      // Background jobs inherit AsyncLocalStorage. They must begin a new read
      // frame after the originating request has returned, never reuse its proof.
      clearValidationFrame(frame);
    }
  });
}

/** A finite preparation can have several sequential host phases. Share their
 * dependency DAG until the caller closes it before model dispatch. The session
 * carries no proof into a later task or dispatch. SQL proofs have fresh initial
 * admission and a final union fence; live authority has its own final check. */
export function createCompanionExecutionValidationSession(signal?: AbortSignal): {
  run<T>(operation: () => Promise<T>): Promise<T>;
  validate(): Promise<void>;
  close(): void;
} {
  const inheritedSignal = validationFrame.getStore()?.signal;
  inheritedSignal?.throwIfAborted(); signal?.throwIfAborted();
  const sessionSignal = inheritedSignal && signal && inheritedSignal !== signal
    ? AbortSignal.any([inheritedSignal, signal]) : signal ?? inheritedSignal;
  const frame: CompanionExecutionValidationFrame = { path: new Set(), completed: new Map(), pending: new Map(), identities: new Map(),
    lifetime: { active: true }, authorities: { groups: new Map(), sealed: false }, witnesses: new Map(), sqlWitnesses: new Map(), sources: new Map(), admissions: new Map(), signal: sessionSignal };
  const closed = new DOMException('Execution validation session closed.', 'AbortError');
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      sessionSignal?.throwIfAborted();
      if (!frame.lifetime.active || frame.authorities.sealed) throw closed;
      const current = validationFrame.getStore();
      current?.signal?.throwIfAborted();
      // A nested session.run must retain its ancestors. Resetting the root path
      // here would allow a cyclic source read to await its own pending proof.
      const branch = current?.lifetime === frame.lifetime ? current : frame;
      const effectiveSignal = current?.signal && sessionSignal && current.signal !== sessionSignal
        ? AbortSignal.any([sessionSignal, current.signal]) : current?.signal ?? sessionSignal;
      return validationFrame.run({ ...branch, signal: effectiveSignal }, () => abortableValidation(operation, effectiveSignal));
    },
    validate(): Promise<void> {
      sessionSignal?.throwIfAborted();
      if (!frame.lifetime.active) return Promise.reject(closed);
      return validateFrameAuthorities(frame);
    },
    close(): void {
      if (!frame.lifetime.active) return;
      clearValidationFrame(frame);
      // Closing is a dispatch boundary, not cancellation. Work already running
      // may finish; subsequent guarded reads start fresh, finite frames and
      // continue to inherit the caller's cancellation signal.
    },
  };
}

/** Shared action dependencies are verified once in this read operation only.
 * Any overlapping write invalidates the result before it can be reused. */
export function memoCompanionExecutionValidation(key: string, revision: () => number, operation: () => Promise<boolean>, owner?: object): Promise<boolean> {
  return withCompanionExecutionValidation(async () => {
    const frame = validationFrame.getStore()!, captured = revision();
    if (owner && !frame.identities.has(owner)) frame.identities.set(owner, frame.identities.size + 1);
    const identity = `action:${owner ? 'owner:' + frame.identities.get(owner) + ':' : ''}${key}:${captured}`;
    if (frame.path.has(identity)) return false;
    const cached = frame.completed.get(identity);
    if (cached !== undefined) return cached;
    // Waiting across different dependency paths can deadlock: concurrent A/B
    // roots may each await the other's pending proof before either local path
    // sees a cycle. Only siblings with the same ancestors share in-flight work.
    // Completed proofs still accelerate the entire request's dependency DAG.
    const pendingIdentity = JSON.stringify([identity, [...frame.path].sort()]);
    const running = frame.pending.get(pendingIdentity);
    if (running) return running;
    const pending = validationFrame.run({ ...frame, path: new Set([...frame.path, identity]) }, async () => operation());
    frame.pending.set(pendingIdentity, pending);
    try {
      const valid = await pending;
      assertValidationActive();
      if (frame.lifetime.active && captured === revision()) frame.completed.set(identity, valid);
      return valid;
    } finally { if (frame.pending.get(pendingIdentity) === pending) frame.pending.delete(pendingIdentity); }
  });
}

/** Batch only unfinished exact proofs in this finite gate. A batch owns its
 * own ancestry marker, never a pending promise for all of its members: an
 * acyclic A -> B dependency may independently finish B while A/B are being
 * admitted together. Successful members are reusable only until the normal
 * fresh file/source/authority fence closes this frame. */
export function memoCompanionExecutionValidationBatch(keys: readonly string[], revision: () => number,
  operation: (missing: readonly string[]) => Promise<boolean>, owner?: object): Promise<boolean> {
  return withCompanionExecutionValidation(async () => {
    const frame = validationFrame.getStore()!, captured = revision();
    if (owner && !frame.identities.has(owner)) frame.identities.set(owner, frame.identities.size + 1);
    const prefix = owner ? 'owner:' + frame.identities.get(owner) + ':' : '';
    const entries = [...new Set(keys)].map(key => ({ key, identity: `action:${prefix}${key}:${captured}` }));
    if (entries.some(entry => frame.path.has(entry.identity) || frame.completed.get(entry.identity) === false)) return false;
    const missing = entries.filter(entry => !frame.completed.has(entry.identity));
    if (!missing.length) return true;
    const marker = 'batch:' + createHash('sha256').update(JSON.stringify(missing.map(entry => entry.identity).sort())).digest('hex');
    if (frame.path.has(marker)) return false;
    const valid = await validationFrame.run({ ...frame, path: new Set([...frame.path, marker]) }, () => operation(missing.map(entry => entry.key)));
    assertValidationActive();
    // A failed batch does not establish which individual member failed. It
    // must not poison an independently valid subset or erase its witnesses.
    if (valid && frame.lifetime.active && captured === revision()) for (const entry of missing) frame.completed.set(entry.identity, true);
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
  /** Recheck live action grants/thought leases separately from the immutable
   * input DAG. Required before using an action's SQL-attested content epoch. */
  actionAuthority?(proof: CompanionExecutionSourceProof): Promise<boolean>;
  /** Same fresh live checks in one storage round trip for a whole closure. */
  actionAuthorities?(proofs: readonly CompanionExecutionSourceProof[]): Promise<ReadonlyMap<string, boolean>>;
  revision?(): number;
  identity?: object;
  invalidated?(response: CompanionStorageResponse): Promise<void> | void;
  /** A bounded host repair may clear only a proven legacy capability-schema
   * mismatch. Actual current capability withdrawals are never recoverable. */
  recoverCapability?(proof: CompanionExecutionSourceProof): Promise<boolean>;
}): Promise<CompanionStorageResponse> {
  assertValidationActive();
  if (command.type.startsWith('execution.') || !response.ok) return response;
  const frame = validationFrame.getStore();
  if (!frame?.lifetime.active) return withCompanionExecutionValidation(() => guardCompanionExecutionSources(command, response, ports));
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
  if (frame.authorities.sealed) throw new Error('执行来源核验窗口已经封口，请开启新的读取窗口。');
  const proofs = new Map<string, CompanionExecutionSourceProof>(), validatedRevisions = new Map<string, number>(), validatedAuthorityEpochs = new Map<string, number>();
  const total = Math.max(references.sourceMessageIds.length, references.memoryIds.length);
  const sourceIdentity = ports.identity ?? ports.storage, sourceRevision = ports.revision?.(), sourceRequestKey = JSON.stringify([
    [...new Set(references.sourceMessageIds)].sort(), [...new Set(references.memoryIds)].sort()]);
  let sourceGroup = frame.sources.get(sourceIdentity);
  // A consumed strong superset already admitted every requested root. Keep
  // that entry's complete proofs and root associations through the final SQL
  // fence; never infer coverage from ancestors or combine unrelated entries.
  const sourceEntry = sourceGroup?.entries.get(sourceRequestKey) ?? [...sourceGroup?.entries.values() ?? []]
    .find(entry => entry.consumed && sourceReferencesCover(entry.references, references));
  let attestationEntry = sourceEntry;
  const admit = (returned: readonly CompanionExecutionSourceProof[], revision: number | undefined) => {
    for (const proof of returned) {
      mergeSourceProof(proofs, proof);
      const key = sourceProofKey(proof);
      if (revision !== undefined && proof.executionReadset
        && proof.storageValidatedReadsetDigest === createHash('sha256').update(JSON.stringify(proof.executionReadset)).digest('hex')) {
        validatedRevisions.set(key, revision);
        if ((proof.kind === 'message' || ports.actionAuthority || ports.actionAuthorities) && proof.storageValidatedAuthorityEpoch !== undefined) validatedAuthorityEpochs.set(key, proof.storageValidatedAuthorityEpoch);
        else validatedAuthorityEpochs.delete(key);
      } else { validatedRevisions.delete(key); validatedAuthorityEpochs.delete(key); }
    }
  };
  if (sourceEntry) admit(structuredClone(sourceEntry.proofs), sourceRevision);
  else {
    for (let offset = 0; offset < total; offset += 100) {
      assertValidationActive();
      const revision = ports.revision?.();
      const result = await ports.storage({ type: 'execution.sources', sourceMessageIds: references.sourceMessageIds.slice(offset, offset + 100), memoryIds: references.memoryIds.slice(offset, offset + 100) });
      assertValidationActive();
      if (!result.ok) throw new Error('派生来源的执行依赖暂不可核验。');
      admit(result.executionSources ?? [], revision);
    }
    // A legacy/capability-only closure retains the per-response fresh SQL and
    // generation fences below. Only complete, strong attestations may enter
    // this finite ledger, including every transitive action's input readset.
    // Exact strong entries survive unrelated Main generations only until the
    // gate's fresh union SQL and live-authority fence; weak entries never enter.
    if (frame.lifetime.active && ports.identity && proofs.size && sourceRevision !== undefined && sourceRevision === ports.revision?.()
      && [...proofs.values()].every(proof => strongSourceProof(proof) && validatedAuthorityEpochs.has(sourceProofKey(proof)))) {
      if (frame.authorities.sealed) throw new Error('执行来源核验窗口已经封口。');
      if (!sourceGroup) { sourceGroup = { storage: ports.storage, entries: new Map() }; frame.sources.set(sourceIdentity, sourceGroup); }
      attestationEntry = { references: structuredClone(references), proofs: structuredClone([...proofs.values()]), consumed: false };
      sourceGroup.entries.set(sourceRequestKey, attestationEntry);
    }
  }
  const invalid = new Set<string>(), owners = new Set<string>(), scopes = new Set<string>();
  const checkedProofs = new Map<string, boolean>();
  const actionProofs = [...proofs.values()].filter(proof => proof.kind === 'action');
  const batchAuthorities = async (actions: readonly CompanionExecutionSourceProof[]) => {
    if (!ports.actionAuthorities) return;
    const result = await ports.actionAuthorities(actions);
    assertValidationActive();
    if (actions.some(proof => !result.has(proof.id))) throw new Error('当前执行授权暂不可完整核验。');
    return result;
  };
  let initialAuthorities = await batchAuthorities(actionProofs);
  const proofKey = (proof: CompanionExecutionSourceProof) => `${proof.kind}:${proof.id}`;
  const check = async (proof: CompanionExecutionSourceProof, sqliteSourcesValidated: boolean): Promise<boolean> => {
    assertValidationActive();
    if (ports.identity && !frame.identities.has(ports.identity)) frame.identities.set(ports.identity, frame.identities.size + 1);
    const key = JSON.stringify([ports.identity ? frame.identities.get(ports.identity) : 0,
      proof.kind, proof.id, proof.companionId, proof.conversationId]), ancestors = frame.path;
    let valid = false;
    if (!proof.invalidated && (proof.executionReadset || proof.kind === 'action' && proof.capability) && !ancestors.has(key)) {
      const revision = ports.revision?.();
      const authorityEpoch = sqliteSourcesValidated ? validatedAuthorityEpochs.get(proofKey(proof)) : undefined;
      // SQL attests the exact immutable input DAG. Action authority is also
      // checked freshly outside this memo, before and after asynchronous I/O.
      // A physical world tick must not replay the historical input DAG.
      const attested = authorityEpoch !== undefined;
      const memoKey = createHash('sha256').update(JSON.stringify([key, proof.executionReadset, proof.capability,
        attested ? ['authority', authorityEpoch] : ['generation', revision]])).digest('hex');
      valid = await memoCompanionExecutionValidation(`source:${attested ? 'attested:' : ''}${memoKey}`, attested ? () => 0 : () => ports.revision?.() ?? 0, async () => {
        const current = validationFrame.getStore()!;
        // Transport failure is availability, never evidence of withdrawal.
        return validationFrame.run({ ...current, path: new Set([...current.path, key]) }, () => ports.valid(proof, sqliteSourcesValidated));
      });
    }
    assertValidationActive();
    return valid;
  };
  for (const proof of proofs.values()) {
    assertValidationActive();
    if (proof.invalidated && proof.kind === 'action' && proof.capability && await ports.recoverCapability?.(proof)) {
      proof.invalidated = false;
      frame.completed.clear();
      if (ports.actionAuthorities) initialAuthorities = new Map([...initialAuthorities ?? [], ...await batchAuthorities([proof]) ?? []]);
    }
    assertValidationActive();
    const authority = proof.kind !== 'action' || (initialAuthorities ? initialAuthorities.get(proof.id) === true
      : !ports.actionAuthority || await ports.actionAuthority(proof));
    checkedProofs.set(proofKey(proof), authority && await check(proof, validatedRevisions.has(proofKey(proof))));
  }
  const attested = [...proofs.values()].filter(proof => validatedRevisions.has(proofKey(proof)));
  const changedLegacy = attested.some(proof => !validatedAuthorityEpochs.has(proofKey(proof)) && validatedRevisions.get(proofKey(proof)) !== ports.revision?.());
  if (!attestationEntry && (validatedAuthorityEpochs.size || changedLegacy)) {
    // Two bounded SQL snapshots bracket the whole closure's async checks.
    // Never refresh every ancestor or wait for a globally idle process.
    const refresh = async () => {
      const current = new Map<string, CompanionExecutionSourceProof>();
      for (let offset = 0; offset < total; offset += 100) {
        assertValidationActive();
        const result = await ports.storage({ type: 'execution.sources', sourceMessageIds: references.sourceMessageIds.slice(offset, offset + 100), memoryIds: references.memoryIds.slice(offset, offset + 100) });
        assertValidationActive();
        if (!result.ok) throw new Error('派生来源的当前执行依赖暂不可核验，请稍后重试。');
        for (const proof of result.executionSources ?? []) current.set(proofKey(proof), proof);
      }
      for (const proof of attested) {
        const actual = current.get(proofKey(proof));
        if (actual?.invalidated) { checkedProofs.set(proofKey(proof), false); continue; }
        if (!actual || actual.companionId !== proof.companionId || actual.conversationId !== proof.conversationId
          || JSON.stringify(actual.executionReadset) !== JSON.stringify(proof.executionReadset)
          || JSON.stringify(actual.capability) !== JSON.stringify(proof.capability)
          || actual.storageValidatedReadsetDigest !== createHash('sha256').update(JSON.stringify(proof.executionReadset)).digest('hex')
          || validatedAuthorityEpochs.has(proofKey(proof)) && actual.storageValidatedAuthorityEpoch !== validatedAuthorityEpochs.get(proofKey(proof))) {
          throw new Error('派生来源正在变化，当前执行依赖暂不可稳定核验，请稍后重试。');
        }
      }
    };
    await refresh();
    if (changedLegacy) {
      // Older workers have no hard authority epoch. Keep their conservative
      // generation fence without evicting freshly SQL-attested file subgraphs.
      // Legacy keys already contain their mutation generation. Deleting the
      // whole frame also evicted unrelated, precisely attested file nodes and
      // made nested action closures repeatedly expand one another.
      for (const proof of attested) if (!validatedAuthorityEpochs.has(proofKey(proof)) && checkedProofs.get(proofKey(proof)))
        checkedProofs.set(proofKey(proof), await check(proof, true));
      await refresh();
    }
  }
  // Live capabilities may have no SQL readset at all. Recheck every successful
  // action after all asynchronous input guards, including legacy/capability
  // actions, without resurrecting an initially rejected authorization.
  const successfulActions = actionProofs.filter(proof => checkedProofs.get(proofKey(proof)));
  const finalAuthorities = await batchAuthorities(successfulActions);
  if (ports.actionAuthority || ports.actionAuthorities) for (const proof of successfulActions) {
    assertValidationActive();
    if (finalAuthorities ? finalAuthorities.get(proof.id) !== true : !await ports.actionAuthority!(proof)) checkedProofs.set(proofKey(proof), false);
  }
  for (const proof of proofs.values()) {
    assertValidationActive();
    const valid = checkedProofs.get(proofKey(proof));
    if (valid) continue;
    proof.sourceMessageIds.forEach(id => invalid.add(id));
    // A historical invalid body still needs redaction on every read. Its
    // immutable tombstone has already advanced the corpus/evidence generation;
    // repeating that notification would prevent any context from stabilizing.
    if (proof.invalidated) continue;
    frame.completed.clear();
    const result = await ports.storage({ type: 'execution.invalidate', kind: proof.kind, id: proof.id, companionId: proof.companionId });
    assertValidationActive();
    if (!result.ok) throw new Error('失效的派生来源暂不可安全撤回。');
    result.memoryInvalidatedCompanionIds?.forEach(id => owners.add(id)); result.memoryInvalidatedScopeIds?.forEach(id => scopes.add(id));
    await ports.invalidated?.(result);
    assertValidationActive();
  }
  assertValidationActive();
  if (!invalid.size) {
    if (attestationEntry) {
      if (!frame.lifetime.active || frame.authorities.sealed) throw new Error('执行来源核验窗口已经关闭。');
      attestationEntry.consumed = true;
    }
    return response;
  }
  if (command.type === 'memory.outbox.claim' && response.memoryOutbox?.operation === 'remember') {
    // The invalidation has withdrawn/versioned the note. Acknowledge the old
    // remember lease without publishing it; the normal forget outbox remains
    // pending and can now run instead of waiting for an abandoned lease.
    const outbox = response.memoryOutbox;
    const settled = await ports.storage({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: false });
    assertValidationActive();
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
  assertValidationActive();
  if (!refreshed.ok) throw new Error('派生资料已撤回，请重新读取当前仍有效的来源。');
  const redact = (message: CompanionMessage): CompanionMessage => invalid.has(message.id)
    ? { ...message, content: '', sourceUnavailable: 'execution_source_changed', attachments: [], segments: undefined, replyProgress: undefined, replyDraft: undefined } : message;
  if (refreshed.message) refreshed.message = redact(refreshed.message);
  if (refreshed.messages) refreshed.messages = refreshed.messages.map(redact);
  if (refreshed.memorySources) refreshed.memorySources = refreshed.memorySources.filter(message => !invalid.has(message.id));
  if (refreshed.memoryDescriptors) refreshed.memoryDescriptors = refreshed.memoryDescriptors.filter(note => !note.sources.some(source => invalid.has(source.messageId)));
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
    if (invalid.has(item.message.message.id)) { item.text = ''; item.textTruncated = false; }
    item.message.message = redact(item.message.message);
  });
  return { ...refreshed,
    ...((owners.size || refreshed.memoryInvalidatedCompanionIds?.length) ? { memoryInvalidatedCompanionIds: [...new Set([...owners, ...refreshed.memoryInvalidatedCompanionIds ?? []])] } : {}),
    ...((scopes.size || refreshed.memoryInvalidatedScopeIds?.length) ? { memoryInvalidatedScopeIds: [...new Set([...scopes, ...refreshed.memoryInvalidatedScopeIds ?? []])] } : {}) };
}
