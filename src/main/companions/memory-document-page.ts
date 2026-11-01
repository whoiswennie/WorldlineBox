import { createHash } from 'node:crypto';
import { readMemoryDocumentAuthorityPage } from './memory-document-authority';
import type { CompanionMemory } from '../../shared/companions';
import type { CompanionMemoryHistoryDescriptor } from '../../shared/companion-memory-history';
import { companionMemoryHistoryDependencySchema } from '../../shared/companion-memory-history';
import { memoryLibraryEntry, companionMemoryRegisteredPath, type MemoryLibraryDocumentSession, type MemoryLibraryEntry } from './memory-library';
import { detachedCompanionExecutionValidation, memoCompanionExecutionWitnesses } from './source-execution-evidence';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export type MemoryDocumentPageValue = { path: string; content: string; entry: MemoryLibraryEntry; note?: CompanionMemory };
function noteBinding(note: CompanionMemory) {
  return JSON.stringify([note.id, note.companionId, note.artifactKind, note.version, note.contentRevision, hash(note.content), note.status,
    note.sourceConversationId, note.sourceSequence, note.sources, note.tags, note.createdAt, note.updatedAt, note.occurredAt,
    note.diaryName, note.captureMethod, note.metadata?.autoTags]);
}
async function currentNotes(session: MemoryLibraryDocumentSession, ids: string[]): Promise<ReadonlyMap<string, CompanionMemory | undefined>> {
  const authority = session.currentNotesAuthority;
  if (!authority) throw new Error('目录缺少当前记忆的最终准确权限端口。');
  const lookup = async (keys: readonly string[], final = false) => {
    const result = new Map<string, CompanionMemory | undefined>(keys.map(id => [id, undefined]));
    for (let offset = 0; offset < keys.length; offset += 100) {
      const command = { type: 'memory.library.read-many' as const, companionId: session.owner.id, ids: keys.slice(offset, offset + 100) };
      const response = await (final ? authority.read(command) : session.request(command));
      if (!response.ok || !response.memories) throw new Error('目录记忆的当前权限暂不可核验。');
      const seen = new Set<string>();
      for (const note of response.memories) {
        if (note.companionId !== session.owner.id || !command.ids.includes(note.id) || seen.has(note.id)) throw new Error('目录记忆批次返回外部或重复身份。');
        seen.add(note.id); result.set(note.id, note);
      }
    }
    return result;
  };
  return memoCompanionExecutionWitnesses(ids, { identity: authority.identity, scope: 'memory-document-notes:' + session.owner.id,
    phase: 'sql-authority', revision: () => 0, read: lookup,
    verify: async entries => {
      const actual = await lookup(entries.map(item => item.key), true);
      for (const { key, value } of entries) if (value && (!actual.get(key) || noteBinding(actual.get(key)!) !== noteBinding(value)))
        throw new Error('目录记忆的正文、版本或真实来源在读取期间变化。');
    } });
}

/** A list page consumes canonical title/excerpt bytes and current metadata,
 * not N original-source pages or tag-job payloads. SQL proof sharing is limited
 * to this finite page; all consumed note/header and file witnesses remain fresh
 * at its final fence. Opening the selected document retains the full reader. */
export async function readMemoryDocumentPage(session: MemoryLibraryDocumentSession, paths: readonly string[]): Promise<MemoryDocumentPageValue[]> {
  if (!paths.length) return [];
  const files = await session.registry.readManyByPaths(paths, () => 'audit');
  const values: MemoryDocumentPageValue[] = files.map((file, index) => {
    if (file.artifact.ownerId !== session.owner.id || file.artifact.relativePath !== paths[index]) throw new Error('目录正文的归属或准确位置已变化。');
    return { path: paths[index]!, content: file.text, entry: memoryLibraryEntry(file.artifact) };
  });
  if (session.pageAuthority) return readMemoryDocumentAuthorityPage(session, values);
  const ids = [...new Set(values.flatMap(value => value.entry.noteId ? [value.entry.noteId] : []))];
  const notes = await currentNotes(session, ids);
  const navigation = values.filter(value => value.entry.artifact.kind === 'navigation');
  const navigationValidity = session.timelineValidMany
    ? await session.timelineValidMany(navigation.map(value => ({ path: value.path, contentHash: value.entry.hash })))
    : new Map(await Promise.all(navigation.map(async value => [value.path, await session.timelineValid(value.path, value.entry.hash)] as const)));
  const visible: MemoryDocumentPageValue[] = [];
  for (const value of values) {
    if (value.entry.noteId) {
      const note = notes.get(value.entry.noteId);
      if (!note) continue;
      if (!note.contentRevision || note.artifactKind !== value.entry.artifact.kind || companionMemoryRegisteredPath(note) !== value.path
        || note.content !== value.content) throw new Error('目录正文、类型或当前准确修订不一致；不会展示SQL替代正文。');
      value.note = note;
    }
    if (value.entry.artifact.kind === 'navigation' && !navigationValidity.get(value.path)) continue;
    visible.push(value);
  }
  const references = new Map<string, { artifactId: string; contentRevision: number; contentHash: string }>();
  for (const value of visible) for (const ref of value.entry.artifact.sourceRefs) {
    const previous = references.get(ref.artifactId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(ref)) throw new Error('目录共享来源携带不同修订。');
    references.set(ref.artifactId, ref);
  }
  if (references.size) {
    const refs = [...references.values()], actual = await session.registry.readMany(refs.map(ref => ({ artifactId: ref.artifactId, consumer: 'audit' as const })));
    refs.forEach((ref, index) => { if (actual[index]!.artifact.contentRevision !== ref.contentRevision || actual[index]!.artifact.contentHash !== ref.contentHash)
      throw new Error('目录的真实来源文件在读取期间变化。'); });
  }
  const histories = visible.filter(value => value.entry.artifact.kind === 'revision_history');
  const sources = visible.filter(value => value.entry.artifact.kind === 'source_evidence');
  if (histories.length || sources.length) {
    const scope = (await session.request({ type: 'memory.library.scope.read', companionId: session.owner.id })).conversation;
    if (!scope) throw new Error('目录的来源作用域已不可访问。');
    if (histories.length) await validateHistories(session, scope.id, histories);
    if (sources.length) {
      const current = await validateSources(session, scope.id, sources);
      return visible.filter(value => value.entry.artifact.kind !== 'source_evidence' || current.has(value.path));
    }
  }
  return visible;
}

async function validateHistories(session: MemoryLibraryDocumentSession, conversationId: string, values: MemoryDocumentPageValue[]) {
  const roots = values.map(value => {
    const match = /^---\n([^]*?)\n---\n/u.exec(value.content); if (!match) throw new Error('历史封装无效。');
    const header: unknown = JSON.parse(match[1]!);
    if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('历史封装无效。');
    const root = companionMemoryHistoryDependencySchema.parse({ id: Reflect.get(header, 'id'), contentRevision: Reflect.get(header, 'contentRevision') });
    if (value.entry.artifact.artifactId !== `history:${root.id}:r${root.contentRevision}`) throw new Error('历史文档与准确登记身份不一致。');
    return root;
  });
  const authority = session.historyAuthority;
  if (!authority) throw new Error('历史文档缺少最终准确权限端口。');
  const command = { type: 'memory.revisions.describe' as const, companionId: session.owner.id, conversationId, roots };
  const key = hash(JSON.stringify(command));
  const lookup = async (final = false) => {
    const response = await (final ? authority.describe(command) : session.request(command));
    if (!response.ok || !response.memoryHistoryDescriptors) throw new Error('历史文档来源或权限已撤回。');
    const descriptors = new Map<string, CompanionMemoryHistoryDescriptor>();
    for (const descriptor of response.memoryHistoryDescriptors) {
      if (descriptor.companionId !== session.owner.id) throw new Error('历史文档的来源归属不一致。');
      const id = descriptor.id + ':' + descriptor.contentRevision;
      if (descriptors.has(id)) throw new Error('历史文档闭包返回重复身份。');
      descriptors.set(id, descriptor);
    }
    values.forEach((value, index) => { const root = roots[index]!, descriptor = descriptors.get(root.id + ':' + root.contentRevision);
      if (!descriptor || descriptor.documentHash !== value.entry.hash || descriptor.relativePath !== value.path) throw new Error('历史文档或准确修订已变化。'); });
    return [...descriptors].sort(([a], [b]) => a.localeCompare(b));
  };
  await memoCompanionExecutionWitnesses([key], { identity: authority.identity, scope: 'memory-document-history:' + key,
    phase: 'sql-authority', revision: () => 0,
    read: async () => new Map([[key, await lookup()]]),
    verify: async entries => { if (JSON.stringify(await lookup(true)) !== JSON.stringify(entries[0]!.value)) throw new Error('历史文档完整来源在读取期间变化。'); } });
}

async function validateSources(session: MemoryLibraryDocumentSession, conversationId: string, values: MemoryDocumentPageValue[]) {
  const tuples = values.map(value => {
    const identity = /^source:([a-zA-Z0-9_-]+):r(\d+)$/u.exec(value.entry.artifact.artifactId);
    if (!identity) throw new Error('来源文档缺少准确登记身份。');
    return { id: identity[1]!, revision: Number(identity[2]), checksum: value.entry.hash, path: value.path };
  });
  // Several immutable files can represent different revisions of one source.
  // Keep every expected tuple; only SQL's exact current tuple can be displayed.
  const keys = tuples.map(tuple => JSON.stringify(tuple)), ids = [...new Set(tuples.map(tuple => tuple.id))];
  const lookup = async () => {
    const response = await session.request({ type: 'memory.sources.headers', companionId: session.owner.id, conversationId, ids });
    if (!response.ok || !response.memorySourceHeaders) throw new Error('目录的来源权限暂不可核验。');
    const actual = new Map<string, { revision: number; checksum: string }>();
    for (const header of response.memorySourceHeaders.headers) {
      if (!ids.includes(header.id) || actual.has(header.id)) throw new Error('目录来源批次返回外部或重复身份。');
      actual.set(header.id, { revision: header.revision, checksum: header.checksum });
    }
    if (response.memorySourceHeaders.unsupportedIds.length) {
      if (new Set(response.memorySourceHeaders.unsupportedIds).size !== response.memorySourceHeaders.unsupportedIds.length
        || response.memorySourceHeaders.unsupportedIds.some(id => !ids.includes(id) || actual.has(id))) throw new Error('旧来源回退范围不一致。');
      const legacy = await session.request({ type: 'memory.sources.filter', companionId: session.owner.id, conversationId, ids: response.memorySourceHeaders.unsupportedIds });
      if (!legacy.ok) throw new Error('旧来源权限暂不可核验。');
      for (const source of legacy.memorySources ?? []) {
        if (!response.memorySourceHeaders.unsupportedIds.includes(source.id) || !source.revision || actual.has(source.id)) throw new Error('旧来源缺少准确修订或返回重复身份。');
        actual.set(source.id, { revision: source.revision, checksum: hash(source.content) });
      }
    }
    return new Map(tuples.map((tuple, index) => [keys[index]!, actual.get(tuple.id)?.revision === tuple.revision && actual.get(tuple.id)?.checksum === tuple.checksum]));
  };
  const matches = await memoCompanionExecutionWitnesses(keys, { identity: session.currentNotesAuthority!.identity,
    scope: 'memory-document-sources:' + session.owner.id + ':' + conversationId + ':' + hash(JSON.stringify(tuples)), phase: 'sql-authority', revision: () => 0,
    read: lookup, verify: async entries => {
      const actual = await detachedCompanionExecutionValidation(lookup);
      for (const item of entries) if (item.value && actual.get(item.key) !== true) throw new Error('真实来源在读取期间变化。');
    } });
  return new Set(tuples.filter((_tuple, index) => matches.get(keys[index]!) === true).map(tuple => tuple.path));
}
