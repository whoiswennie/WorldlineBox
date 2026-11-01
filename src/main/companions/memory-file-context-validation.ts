import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { companionMemoryFileReceiptsSchema, type CompanionMemoryFileReceipt } from '../../shared/companion-memory-files';
import type { CompanionMemoryHistoryDescriptor } from '../../shared/companion-memory-history';
import type { CompanionMemory } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { companionMemoryRegisteredPath } from './memory-library';
import { assertCompanionExecutionWitnessActive, memoCompanionExecutionValidation, memoCompanionExecutionWitnesses,
  preloadCompanionExecutionWitnesses } from './source-execution-evidence';
import { companionAttestedMemoryFileCurrent, companionAttestedMemoryFilesKey, companionAttestedMemoryFilesMatch, type CompanionAttestedMemoryFiles } from './execution-evidence';

type Request = (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>;
type Descriptor = Omit<CompanionMemoryHistoryDescriptor, 'procedureValidation'>;
type Witness = { receipt: CompanionMemoryFileReceipt; conversationId: string; current?: ReturnType<typeof currentAuthority>;
  /** Complete dependencies of this root, without unrelated prefetched roots. */
  descriptors: ReadonlyMap<string, Descriptor> };
const currentFileWitnessBrand = Symbol('Consumed current memory SQL witnesses');
export type CompanionCurrentMemoryFileWitness = Readonly<{ [currentFileWitnessBrand]: true }>;
const currentFileWitnessInputs = new WeakMap<CompanionCurrentMemoryFileWitness, {
  authority: CompanionAttestedMemoryFiles; witnesses: ReadonlyMap<string, Witness>;
}>();
/** Only the awaited canonical callback can use this consumed SQL observation.
 * Persisted/model JSON cannot manufacture it, and it grants no file authority. */
export function companionCurrentMemoryFileWitnessInputs(value: CompanionCurrentMemoryFileWitness, authority: CompanionAttestedMemoryFiles,
  receipts: readonly CompanionMemoryFileReceipt[]): { conversationId: string; notes: ReturnType<typeof currentAuthority>[] } | undefined {
  assertCompanionExecutionWitnessActive();
  const input = currentFileWitnessInputs.get(value);
  if (!input || input.authority !== authority || !receipts.length) return;
  const selected = receipts.map(receipt => input.witnesses.get(receiptKey(receipt)));
  if (selected.some(witness => !witness?.current || !companionAttestedMemoryFileCurrent(authority, witness.current))) return;
  const conversationId = selected[0]!.conversationId;
  if (selected.some(witness => witness!.conversationId !== conversationId)) return;
  return structuredClone({ conversationId, notes: selected.map(witness => witness!.current!) });
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const receiptKey = (receipt: CompanionMemoryFileReceipt) => 'receipt:' + JSON.stringify(receipt);
const descriptorKey = (descriptor: { id: string; contentRevision: number }) => `history:${descriptor.id}:${descriptor.contentRevision}`;
class CurrentHistoryNotPublished extends Error {}
function equivalent(left: Witness | undefined, right: Witness): boolean {
  if (!left) return false;
  const { current: before, descriptors: _oldDescriptors, ...old } = left, { current: after, descriptors: _freshDescriptors, ...fresh } = right;
  void _oldDescriptors; void _freshDescriptors;
  // Ordinary revision can move this exact old body from current to historical
  // without withdrawing its captured source. Its exact history proof remains.
  return isDeepStrictEqual(old, fresh) && (!before || !after || isDeepStrictEqual(before, after));
}
function descriptorUnion(values: Iterable<Witness>): Map<string, Descriptor> {
  const descriptors = new Map<string, Descriptor>();
  for (const witness of values) for (const [key, descriptor] of witness.descriptors) {
    const previous = descriptors.get(key);
    if (previous && !isDeepStrictEqual(previous, descriptor)) throw new Error('历史记忆的SQL闭包在核验期间改变。');
    descriptors.set(key, descriptor);
  }
  return descriptors;
}
function descriptorClosure(root: { id: string; contentRevision: number }, descriptors: ReadonlyMap<string, Descriptor>): Map<string, Descriptor> {
  const result = new Map<string, Descriptor>(), active = new Set<string>();
  const pending = [{ key: descriptorKey(root), exit: false }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.exit) { active.delete(item.key); result.set(item.key, descriptors.get(item.key)!); continue; }
    if (active.has(item.key)) throw new Error('历史记忆的SQL依赖存在环路。');
    if (result.has(item.key)) continue;
    if (active.size + result.size >= 10_000) throw new Error('历史记忆的SQL依赖超过可核验闭包。');
    const descriptor = descriptors.get(item.key);
    if (!descriptor) throw new Error('历史记忆的SQL依赖缺少准确修订。');
    active.add(item.key); pending.push({ key: item.key, exit: true });
    for (const dependency of [...descriptor.dependencies].reverse()) pending.push({ key: descriptorKey(dependency), exit: false });
  }
  return result;
}
function currentAuthority(note: CompanionMemory) {
  return { companionId: note.companionId, id: note.id, contentRevision: note.contentRevision, artifactKind: note.artifactKind,
    sourceConversationId: note.sourceConversationId, path: companionMemoryRegisteredPath(note), bodyHash: hash(note.content), sources: note.sources };
}

/** SQL is authority metadata only, never a replacement for canonical prose.
 * This mirrors live-file validation's current-vs-historical distinction and
 * owner library scope. Chat cursors remain in the outer semantic memo/readset. */
async function capture(owner: string, receipts: readonly CompanionMemoryFileReceipt[], request: Request): Promise<Map<string, Witness>> {
  const scope = await request({ type: 'memory.library.scope.read', companionId: owner }), conversationId = scope.conversation?.id;
  if (!scope.ok || !conversationId) throw new Error('正式记忆的当前库权限暂不可核验。');
  const ids = [...new Set(receipts.map(receipt => receipt.noteId))], notes = new Map<string, CompanionMemory>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const response = await request({ type: 'memory.records.filter', companionId: owner, conversationId, ids: ids.slice(offset, offset + 100) });
    if (!response.ok || !response.memories) throw new Error('正式记忆的准确修订暂不可核验。');
    response.memories.forEach(note => notes.set(note.id, note));
  }
  const witnesses = new Map<string, Witness>(); let allCurrent = true;
  for (const receipt of receipts) {
    const note = notes.get(receipt.noteId);
    if (note?.contentRevision === receipt.contentRevision) {
      const authority = currentAuthority(note);
      if (authority.companionId !== owner || authority.bodyHash !== receipt.contentHash || authority.path !== receipt.path)
        throw new Error('正式记忆的当前SQL正文、类型或修订与文件凭证不一致。');
      witnesses.set(receiptKey(receipt), { receipt, conversationId, current: authority, descriptors: new Map() });
    } else { allCurrent = false; witnesses.set(receiptKey(receipt), { receipt, conversationId, descriptors: new Map() }); }
  }
  const descriptors = new Map<string, CompanionMemoryHistoryDescriptor>();
  for (let offset = 0; offset < receipts.length; offset += 100) {
    const response = await request({ type: 'memory.revisions.describe', companionId: owner, conversationId,
      roots: receipts.slice(offset, offset + 100).map(receipt => ({ id: receipt.noteId, contentRevision: receipt.contentRevision })) });
    if (!response.ok || !response.memoryHistoryDescriptors) {
      if (allCurrent) throw new CurrentHistoryNotPublished();
      throw new Error('历史记忆的完整SQL来源或权限已不可核验。');
    }
    for (const descriptor of response.memoryHistoryDescriptors) {
      if (descriptor.companionId !== owner) throw new Error('历史记忆的SQL归属不一致。');
      const previous = descriptors.get(descriptorKey(descriptor));
      if (previous && !isDeepStrictEqual(previous, descriptor)) throw new Error('历史记忆的SQL闭包在核验期间改变。');
      descriptors.set(descriptorKey(descriptor), descriptor);
    }
  }
  for (const receipt of receipts) {
    const descriptor = descriptors.get(descriptorKey({ id: receipt.noteId, contentRevision: receipt.contentRevision }));
    // descriptor.bodyHash is the ledger's structured content/source identity,
    // not SHA256(prose). The initial canonical validator binds the actual
    // receipt prose to this exact revision; retain the complete SQL descriptor
    // on both sides of that file check instead of confusing the two hashes.
    if (!descriptor) throw new Error('历史正式正文或其准确修订已经变化。');
    const current = witnesses.get(receiptKey(receipt));
    if (current?.current) {
      const actual = current.current.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum, revision: source.revision }));
      const ordered = (values: readonly unknown[]) => [...values].map(value => JSON.stringify(value)).sort();
      if (!isDeepStrictEqual(ordered(actual), ordered(descriptor.sources))) throw new Error('当前SQL来源与准确历史凭证不一致。');
    }
  }
  const authorityDescriptors = new Map<string, Descriptor>();
  for (const [key, value] of descriptors) {
    // Practice annotations have their own execution readset guards. Ordinary
    // annotation changes do not rewrite this exact historical file authority.
    const { procedureValidation: _practice, ...descriptor } = value; void _practice;
    authorityDescriptors.set(key, descriptor);
  }
  // Prefetched siblings may never be consumed (for example an invalid second
  // message is redacted). Bind each root only to its own complete closure;
  // the final verifier unions every actually consumed root and dependency.
  const reached = new Set<string>();
  for (const witness of witnesses.values()) {
    witness.descriptors = descriptorClosure({ id: witness.receipt.noteId, contentRevision: witness.receipt.contentRevision }, authorityDescriptors);
    for (const key of witness.descriptors.keys()) reached.add(key);
  }
  if (reached.size !== authorityDescriptors.size) throw new Error('历史记忆的SQL闭包包含未请求的额外修订。');
  return witnesses;
}

function sqlWitnessPort(owner: string, receipts: readonly CompanionMemoryFileReceipt[], ports: { identity: object; request: Request }) {
  const byKey = new Map(receipts.map(receipt => [receiptKey(receipt), receipt]));
  return { identity: ports.identity, scope: 'memory-file-sql:' + owner, phase: 'sql-authority' as const, revision: () => 0,
    read: (keys: readonly string[]) => capture(owner, keys.map(key => byKey.get(key)!), ports.request),
    verify: async (entries: readonly { key: string; value: Witness }[]) => {
      if (!entries.length) return;
      const used = entries.map(entry => entry.value.receipt), expectedDescriptors = descriptorUnion(entries.map(entry => entry.value));
      let current: Map<string, Witness>;
      try { current = await capture(owner, used, ports.request); }
      catch (error) {
        if (error instanceof CurrentHistoryNotPublished) throw new Error('准确历史来源已撤回或尚不可核验，旧内容未继续使用。', { cause: error });
        throw error;
      }
      if (current.size !== entries.length || entries.some(entry => !equivalent(current.get(entry.key), entry.value))
        || !isDeepStrictEqual(descriptorUnion(current.values()), expectedDescriptors))
        throw new Error('正式记忆的SQL修订、原始来源或当前访问权限已经变化，旧内容未继续使用。');
    } };
}

/** Body-free union prefetch in the current frame. It never authorizes a root,
 * and a failed optimization leaves the ordinary per-context path in charge. */
export async function preloadCompanionMemoryFileContexts(inputs: readonly { companionId: string;
  contexts: readonly { fileReceiptOnly?: true; fileReceipts?: readonly CompanionMemoryFileReceipt[] }[] }[],
ports: { identity: object; request: Request }): Promise<void> {
  const owners = new Map<string, Map<string, CompanionMemoryFileReceipt>>();
  for (const input of inputs) for (const context of input.contexts) {
    if (!context.fileReceiptOnly) continue;
    const parsed = companionMemoryFileReceiptsSchema.safeParse(context.fileReceipts);
    if (!parsed.success || parsed.data.some(receipt => receipt.companionId !== input.companionId)) continue;
    const receipts = owners.get(input.companionId) ?? new Map<string, CompanionMemoryFileReceipt>();
    for (const receipt of parsed.data) receipts.set(receiptKey(receipt), receipt);
    if (receipts.size) owners.set(input.companionId, receipts);
  }
  for (const [owner, receipts] of owners) try {
    await preloadCompanionExecutionWitnesses([...receipts.keys()], sqlWitnessPort(owner, [...receipts.values()], ports));
  } catch {
    // Cancellation/closure still stops the caller. Other failures are retried
    // by the original exact-root admission, never reported as withdrawal here.
    assertCompanionExecutionWitnessActive();
  }
}

/** Stable admission is safe only for file-only receipts with both fences:
 * initial full canonical/source validation and final fresh SQL authority.
 * Registry's independent final fence still reopens every consumed file. */
export function validateCompanionMemoryFileContext(scope: { companionId: string; conversationId: string; beforeSequence?: number }, context: {
  revision: string; profileKey: string; fileReceiptOnly?: true; fileReceipts?: readonly CompanionMemoryFileReceipt[];
}, ports: { identity: object; request: Request; validate(): Promise<boolean>; fallback(): Promise<boolean>;
  attestedFiles?: CompanionAttestedMemoryFiles;
  validateAttested?(authority: CompanionAttestedMemoryFiles, current: CompanionCurrentMemoryFileWitness): Promise<boolean | undefined> }): Promise<boolean> {
  const parsed = companionMemoryFileReceiptsSchema.safeParse(context.fileReceipts);
  if (context.fileReceiptOnly !== true || !parsed.success || !parsed.data.length || parsed.data.some(receipt => receipt.companionId !== scope.companionId)) return Promise.resolve(false);
  const receipts = [...new Map(parsed.data.map(receipt => [receiptKey(receipt), receipt])).values()];
  const byKey = new Map(receipts.map(receipt => [receiptKey(receipt), receipt]));
  const attested = companionAttestedMemoryFilesMatch(ports.attestedFiles, scope, context) ? ports.attestedFiles : undefined;
  const key = attested ? 'file-context:sql-attested:' + companionAttestedMemoryFilesKey(attested)
    : 'file-context:full:' + hash(JSON.stringify([scope, context]));
  return memoCompanionExecutionValidation(key, () => 0, async () => {
    const witnesses = await memoCompanionExecutionWitnesses([...byKey.keys()], sqlWitnessPort(scope.companionId, receipts, ports));
    if (attested && ports.validateAttested && receipts.every(receipt => {
      const current = witnesses.get(receiptKey(receipt))?.current;
      return !!current && companionAttestedMemoryFileCurrent(attested, current);
    })) {
      const current: CompanionCurrentMemoryFileWitness = Object.freeze({ [currentFileWitnessBrand]: true });
      currentFileWitnessInputs.set(current, { authority: attested, witnesses });
      try {
        const checked = await ports.validateAttested(attested, current);
        if (checked !== undefined) return checked;
      } finally { currentFileWitnessInputs.delete(current); }
    }
    return ports.validate();
  }, ports.identity).catch(error => {
    // An unpublished current history cannot establish this stronger stable
    // proof. Keep its original generation-bound path; do not cache it here.
    if (error instanceof CurrentHistoryNotPublished) return ports.fallback();
    throw error;
  });
}
