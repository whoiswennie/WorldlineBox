import { isDeepStrictEqual } from 'node:util';
import type { CompanionMemoryHistoryDescriptor } from '../../shared/companion-memory-history';
import type { MemoryLibraryDocumentSession } from './memory-library';
import { assertCompanionExecutionWitnessActive, createCompanionExecutionValidationSession, memoCompanionExecutionWitnesses } from './source-execution-evidence';

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
type Root = { id: string; contentRevision: number };
type Descriptor = Omit<CompanionMemoryHistoryDescriptor, 'procedureValidation'>;
type Witness = { root: Root; descriptors: Map<string, Descriptor> };
const key = (root: Root) => JSON.stringify([root.id, root.contentRevision]);

/** A focusing HTTP request/publication cannot reuse an enclosing task's old
 * admission. The callback's own Registry and SQL witnesses are sealed here. */
export async function validateFreshCompanionRecallInputs(operation: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  const fresh = createCompanionExecutionValidationSession(signal);
  try { await fresh.run(operation); await fresh.validate(); }
  finally { fresh.close(); }
}

function closure(root: Root, descriptors: ReadonlyMap<string, Descriptor>): Map<string, Descriptor> {
  const result = new Map<string, Descriptor>(), active = new Set<string>(), pending = [{ id: key(root), closing: false }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.closing) { active.delete(item.id); result.set(item.id, descriptors.get(item.id)!); continue; }
    if (result.has(item.id)) continue;
    const descriptor = descriptors.get(item.id);
    if (!descriptor || active.has(item.id) || active.size + result.size >= 10000) throw new Error('历史描述缺少准确依赖、存在环路或超过闭包预算。');
    active.add(item.id); pending.push({ ...item, closing: true });
    for (const dependency of descriptor.dependencies) pending.push({ id: key(dependency), closing: false });
  }
  return result;
}
function union(witnesses: Iterable<Witness>): Map<string, Descriptor> {
  const result = new Map<string, Descriptor>();
  for (const witness of witnesses) for (const [id, descriptor] of witness.descriptors) {
    if (result.has(id) && !isDeepStrictEqual(result.get(id), descriptor)) throw new Error('准确历史描述在本轮读取期间变化。');
    result.set(id, descriptor);
  }
  return result;
}

/** Only explicit projection-input reads share metadata. Files remain the sole
 * prose authority, with Registry's independent fresh byte fence. Each logical
 * entrance/cursor retains its own SQL authority and fresh final union. */
export async function projectionHistoryDescriptors(session: MemoryLibraryDocumentSession, scope: Scope,
  roots: readonly Root[]): Promise<Map<string, CompanionMemoryHistoryDescriptor> | undefined> {
  const port = session.historyAuthority;
  if (!port) return;
  const byKey = new Map(roots.map(root => [key(root), root]));
  const capture = async (selected: readonly Root[]): Promise<Map<string, Witness>> => {
    assertCompanionExecutionWitnessActive();
    const response = await port.describe({ type: 'memory.revisions.describe', companionId: scope.companionId, conversationId: scope.conversationId,
      ...(scope.beforeSequence !== undefined ? { beforeSequence: scope.beforeSequence } : {}), roots: [...selected] });
    assertCompanionExecutionWitnessActive();
    if (!response.ok || !response.memoryHistoryDescriptors) throw new Error('历史修订元数据的当前权限暂不可核验。');
    const descriptors = new Map<string, Descriptor>();
    for (const value of response.memoryHistoryDescriptors) {
      if (value.companionId !== scope.companionId || descriptors.has(key(value))) throw new Error('历史描述包含外部归属或重复身份。');
      // Projection consumers overlay their captured annotations separately.
      // Mutable practice status is never cached as immutable file authority.
      const { procedureValidation: _practice, ...descriptor } = value; void _practice;
      descriptors.set(key(descriptor), descriptor);
    }
    const result = new Map(selected.map(root => [key(root), { root, descriptors: closure(root, descriptors) }]));
    if (union(result.values()).size !== descriptors.size) throw new Error('历史描述包含未请求的额外修订。');
    return result;
  };
  const values = await memoCompanionExecutionWitnesses([...byKey.keys()], { identity: port.identity, phase: 'sql-authority',
    scope: JSON.stringify(['projection-history', session.root, scope.companionId, scope.conversationId, scope.beforeSequence ?? null]), revision: () => 0,
    read: keys => capture(keys.map(id => byKey.get(id)!)),
    verify: async entries => {
      const used = entries.map(entry => entry.value), expected = union(used);
      const current = await capture(used.map(witness => witness.root));
      if (!isDeepStrictEqual(union(current.values()), expected)) throw new Error('历史正文、准确来源、依赖或读取权限已经变化。');
    } });
  return union(values.values());
}
