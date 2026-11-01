import { createHash } from 'node:crypto';
import { companionMemorySnapshotRevisionScopeKey, companionMemorySnapshotRevisionScopeSchema,
  normalizeCompanionMemorySnapshotRevisionScope, type CompanionMemorySnapshotRevisionScope } from '../../shared/companion-memory-snapshot-revisions';
import type { MemoryLibraryDocumentSession } from './memory-library';
import { memoCompanionExecutionWitnesses } from './source-execution-evidence';
import { rethrowCompanionValidationUnavailable } from './validation-unavailable';

type NavigationInput = { path: string; contentHash?: string };
type Revision = { valid: boolean; revision: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Navigation consumes a current semantic predicate, not the current notes'
 * prose. Its own canonical bytes remain Registry inputs. Snapshot descriptors
 * retain the original Main source/volatile authority obligations; initial and
 * fresh-final SQL compute the unchanged snapshot algorithm in one batch. */
export async function memoryNavigationValidMany(session: MemoryLibraryDocumentSession, inputs: readonly NavigationInput[]): Promise<ReadonlyMap<string, boolean>> {
  const result = new Map(inputs.map(input => [input.path, false]));
  if (!inputs.length) return result;
  const authority = session.snapshotRevisionAuthority;
  if (!authority) throw new Error('导航缺少准确语义版本权限端口。');
  const files = await session.registry.readManyByPaths(inputs.map(input => input.path), () => 'navigation');
  const expected = new Map<string, { key: string; revision: string }>();
  for (let index = 0; index < files.length; ++index) {
    const input = inputs[index]!, file = files[index]!;
    if (file.artifact.kind !== 'navigation' || file.artifact.ownerId !== session.owner.id
      || file.artifact.relativePath !== input.path || input.contentHash && hash(file.text) !== input.contentHash) continue;
    try {
      const match = /^---\n([^]*?)\n---\n/u.exec(file.text); if (!match) continue;
      const metadata: unknown = JSON.parse(match[1]!);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Reflect.get(metadata, 'schema') !== 'worldlinebox.companion-navigation-v2') continue;
      const rawScope: unknown = Reflect.get(metadata, 'scope'), revision: unknown = Reflect.get(metadata, 'sourceRevision');
      if (!rawScope || typeof rawScope !== 'object' || Array.isArray(rawScope) || typeof revision !== 'string') continue;
      // Match the original call's explicit episode-only override. Every other
      // scope field is parsed by the exact original strict snapshot schema.
      const scope = normalizeCompanionMemorySnapshotRevisionScope(companionMemorySnapshotRevisionScopeSchema.parse({ ...rawScope, contentKinds: ['episode_memory'] }));
      if (scope.companionId !== session.owner.id) continue;
      expected.set(input.path, { key: JSON.stringify(scope), revision });
    } catch (error) { rethrowCompanionValidationUnavailable(error); }
  }
  const keys = [...new Set([...expected.values()].map(value => value.key))];
  if (!keys.length) return result;
  const scopesFor = (values: readonly string[]): CompanionMemorySnapshotRevisionScope[] => values.map(value => {
    const scope = normalizeCompanionMemorySnapshotRevisionScope(companionMemorySnapshotRevisionScopeSchema.parse(JSON.parse(value)));
    if (scope.companionId !== session.owner.id || JSON.stringify(scope) !== value) throw new Error('导航作用域或准确读取边界不一致。');
    return scope;
  });
  const lookup = async (requested: readonly string[], final = false) => {
    const scopes = scopesFor(requested), values = new Map<string, Revision>();
    for (let offset = 0; offset < scopes.length; offset += 100) {
      const batch = scopes.slice(offset, offset + 100), command = { type: 'memory.snapshot.revisions' as const, scopes: batch };
      const response = await (final ? authority.read(command) : session.request(command));
      if (!response.ok || !response.memorySnapshotRevisions) throw new Error('导航的当前语义版本暂不可核验。');
      const required = new Map(batch.map(scope => [companionMemorySnapshotRevisionScopeKey(scope), JSON.stringify(normalizeCompanionMemorySnapshotRevisionScope(scope))]));
      for (const group of response.memorySnapshotRevisions.groups) {
        const key = required.get(companionMemorySnapshotRevisionScopeKey(group.scope));
        if (!key || values.has(key) || group.memories.some(note => note.companionId !== session.owner.id
          || !group.scope.contentKinds.includes(note.artifactKind)) || !group.valid && group.memories.length)
          throw new Error('导航版本批次返回重复、外部或错误类型的作用域。');
        values.set(key, { valid: group.valid, revision: group.semanticRevision ?? group.revision });
      }
      if (batch.some(scope => !values.has(JSON.stringify(normalizeCompanionMemorySnapshotRevisionScope(scope))))) throw new Error('导航版本批次缺少完整作用域。');
    }
    return values;
  };
  const revisions = await memoCompanionExecutionWitnesses(keys, { identity: authority.identity, scope: 'memory-navigation-revisions:' + session.owner.id,
    phase: 'sql-authority', revision: () => 0,
    read: values => lookup(values),
    verify: async entries => {
      const current = await lookup(entries.map(entry => entry.key), true);
      for (const entry of entries) if (entry.value.valid && (!current.get(entry.key)?.valid || current.get(entry.key)?.revision !== entry.value.revision))
        throw new Error('导航的当前来源或语义版本在读取期间变化。');
    } });
  for (const [path, value] of expected) result.set(path, revisions.get(value.key)?.valid === true && revisions.get(value.key)?.revision === value.revision);
  return result;
}
