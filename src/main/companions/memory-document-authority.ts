import { createHash } from 'node:crypto';
import type { CompanionMemory, CompanionMessage } from '../../shared/companions';
import type { CompanionStorageResponse } from '../../shared/companion-storage';
import { companionMemoryDocumentAuthorityCommandSchema, companionMemoryDocumentAuthorityResultSchema,
  type CompanionMemoryDocumentAuthorityCommand } from '../../shared/companion-memory-document-authority';
import { companionMemorySnapshotRevisionScopeKey, companionMemorySnapshotRevisionScopeSchema,
  normalizeCompanionMemorySnapshotRevisionScope } from '../../shared/companion-memory-snapshot-revisions';
import { companionMemoryHistoryDependencySchema } from '../../shared/companion-memory-history';
import { companionMemoryRegisteredPath, type MemoryLibraryDocumentSession } from './memory-library';
import type { MemoryDocumentPageValue } from './memory-document-page';
import { memoCompanionExecutionWitnesses } from './source-execution-evidence';
import { rethrowCompanionValidationUnavailable } from './validation-unavailable';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const noteBinding = (note: CompanionMemory) => JSON.stringify([note.id, note.companionId, note.artifactKind, note.version, note.contentRevision, hash(note.content), note.status,
  note.sourceConversationId, note.sourceSequence, note.sources, note.tags, note.createdAt, note.updatedAt, note.occurredAt,
  note.diaryName, note.captureMethod, note.metadata?.autoTags]);
const sourceBinding = (source: CompanionMessage) => JSON.stringify([source.id, source.authorId, source.conversationId,
  source.revision, hash(source.content)]);
const navigationKey = (scope: Parameters<typeof companionMemorySnapshotRevisionScopeKey>[0], expected: string) =>
  JSON.stringify([companionMemorySnapshotRevisionScopeKey(scope), expected]);

/** One finite page shares physical SQL reads; it never shares authority across
 * requests. Registry bytes/consumer admissions precede this call and retain
 * their original independent final witnesses. SQL prose is only compared. */
export async function readMemoryDocumentAuthorityPage(session: MemoryLibraryDocumentSession,
  values: MemoryDocumentPageValue[]): Promise<MemoryDocumentPageValue[]> {
  const authority = session.pageAuthority;
  if (!authority) throw new Error('目录缺少准确页级权限端口。');
  const navigationFiles = values.filter(value => value.entry.artifact.kind === 'navigation');
  // Navigation is a separate consumer from audit. Keep its exact admission even
  // when the canonical file was already read by this same finite page.
  const navigationReads = navigationFiles.length ? await session.registry.readManyByPaths(navigationFiles.map(value => value.path), () => 'navigation') : [];
  const navigationByPath = new Map<string, { key: string; scope: CompanionMemoryDocumentAuthorityCommand['navigation'][number]['scope']; expectedRevision: string }>();
  navigationReads.forEach((file, index) => {
    const value = navigationFiles[index]!;
    if (file.artifact.kind !== 'navigation' || file.artifact.ownerId !== session.owner.id
      || file.artifact.relativePath !== value.path || hash(file.text) !== value.entry.hash) return;
    try {
      const match = /^---\n([^]*?)\n---\n/u.exec(file.text); if (!match) return;
      const metadata: unknown = JSON.parse(match[1]!);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || Reflect.get(metadata, 'schema') !== 'worldlinebox.companion-navigation-v2') return;
      const rawScope: unknown = Reflect.get(metadata, 'scope'), expectedRevision: unknown = Reflect.get(metadata, 'sourceRevision');
      if (!rawScope || typeof rawScope !== 'object' || Array.isArray(rawScope) || typeof expectedRevision !== 'string') return;
      const scope = normalizeCompanionMemorySnapshotRevisionScope(companionMemorySnapshotRevisionScopeSchema.parse({ ...rawScope, contentKinds: ['episode_memory'] }));
      if (scope.companionId !== session.owner.id) return;
      navigationByPath.set(value.path, { key: navigationKey(scope, expectedRevision), scope, expectedRevision });
    } catch (cause) { rethrowCompanionValidationUnavailable(cause); }
  });
  const histories = values.filter(value => value.entry.artifact.kind === 'revision_history');
  const historyRoots = histories.map(value => {
    const match = /^---\n([^]*?)\n---\n/u.exec(value.content); if (!match) throw new Error('历史封装无效。');
    const header: unknown = JSON.parse(match[1]!);
    if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('历史封装无效。');
    const root = companionMemoryHistoryDependencySchema.parse({ id: Reflect.get(header, 'id'), contentRevision: Reflect.get(header, 'contentRevision') });
    if (value.entry.artifact.artifactId !== `history:${root.id}:r${root.contentRevision}`) throw new Error('历史文档与准确登记身份不一致。');
    return root;
  });
  const sources = values.filter(value => value.entry.artifact.kind === 'source_evidence').map(value => {
    const match = /^source:([a-zA-Z0-9_-]+):r(\d+)$/u.exec(value.entry.artifact.artifactId);
    if (!match) throw new Error('来源文档缺少准确登记身份。');
    return { path: value.path, id: match[1]!, revision: Number(match[2]), checksum: value.entry.hash };
  });
  const scope = histories.length || sources.length
    ? (await session.request({ type: 'memory.library.scope.read', companionId: session.owner.id })).conversation : undefined;
  if ((histories.length || sources.length) && !scope) throw new Error('目录的来源作用域已不可访问。');
  const navigation = [...new Map([...navigationByPath.values()].map(({ key, scope, expectedRevision }) => [key, { scope, expectedRevision }])).values()];
  const command = companionMemoryDocumentAuthorityCommandSchema.parse({ type: 'memory.documents.authority', companionId: session.owner.id,
    noteIds: [...new Set(values.flatMap(value => value.entry.noteId ? [value.entry.noteId] : []))], navigation,
    ...(histories.length ? { history: { conversationId: scope!.id, roots: historyRoots } } : {}),
    ...(sources.length ? { sources: { conversationId: scope!.id, ids: [...new Set(sources.map(source => source.id))] } } : {}) });
  const key = JSON.stringify(command);
  type Packet = {
    notes: Map<string, CompanionMemory>;
    noteBindings: Map<string, string>;
    navigation: Map<string, boolean>;
    historyJSON: string;
    sourceHeadersJSON: string;
    legacyJSON: string;
    sourceCurrent: Map<string, { revision: number; checksum: string }>;
  };
  const checked = (response: CompanionStorageResponse): Packet => {
    if (!response.ok || !response.memories || !response.memoryDocumentAuthority) throw new Error('目录页级权限尚未完整核验。');
    const result = companionMemoryDocumentAuthorityResultSchema.parse(response.memoryDocumentAuthority);
    const notes = new Map<string, CompanionMemory>();
    for (const note of response.memories) {
      if (note.companionId !== session.owner.id || !command.noteIds.includes(note.id) || notes.has(note.id)) throw new Error('目录返回外部或重复记忆身份。');
      notes.set(note.id, note);
    }
    const requestedNavigation = new Set(command.navigation.map(item => navigationKey(item.scope, item.expectedRevision)));
    const actualNavigation = new Map<string, boolean>();
    const groups = new Map<string, NonNullable<CompanionStorageResponse['memorySnapshotRevisions']>['groups'][number]>();
    for (const group of response.memorySnapshotRevisions?.groups ?? []) {
      const scopeKey = companionMemorySnapshotRevisionScopeKey(group.scope);
      if (groups.has(scopeKey) || !command.navigation.some(item => companionMemorySnapshotRevisionScopeKey(item.scope) === scopeKey)
        || group.memories.some(note => note.companionId !== session.owner.id || !group.scope.contentKinds.includes(note.artifactKind))
        || !group.valid && group.memories.length) throw new Error('导航消费义务的准确作用域不一致。');
      groups.set(scopeKey, group);
    }
    for (const item of result.navigation) {
      const itemKey = navigationKey(item.scope, item.expectedRevision), group = groups.get(companionMemorySnapshotRevisionScopeKey(item.scope));
      if (!requestedNavigation.has(itemKey) || actualNavigation.has(itemKey) || !group) throw new Error('导航谓词批次返回外部、重复或缺失作用域。');
      const matched = item.valid && item.matches && (item.semanticRevision ?? item.revision) === item.expectedRevision
        && group.valid && (group.semanticRevision ?? group.revision) === item.expectedRevision;
      if (item.matches && !matched) throw new Error('导航匹配未携带实际获权的来源消费义务。');
      actualNavigation.set(itemKey, matched);
    }
    if (actualNavigation.size !== requestedNavigation.size) throw new Error('导航缺少完整准确谓词。');
    const descriptors = new Map<string, NonNullable<CompanionStorageResponse['memoryHistoryDescriptors']>[number]>();
    if (command.history && !response.memoryHistoryDescriptors) throw new Error('历史闭包缺少准确权限描述。');
    for (const descriptor of response.memoryHistoryDescriptors ?? []) {
      const identity = descriptor.id + ':' + descriptor.contentRevision;
      if (!command.history || descriptor.companionId !== session.owner.id || descriptors.has(identity)) throw new Error('历史批次的身份或归属不一致。');
      descriptors.set(identity, descriptor);
    }
    histories.forEach((value, index) => {
      const root = historyRoots[index]!, descriptor = descriptors.get(root.id + ':' + root.contentRevision);
      if (!descriptor || descriptor.documentHash !== value.entry.hash || descriptor.relativePath !== value.path) throw new Error('历史文档或准确修订已变化。');
    });
    const currentSources = new Map<string, { revision: number; checksum: string }>();
    const headers = response.memorySourceHeaders;
    if (command.sources && !headers) throw new Error('来源批次缺少准确获权元数据。');
    const unsupported = new Set(headers?.unsupportedIds ?? []);
    if (unsupported.size !== (headers?.unsupportedIds.length ?? 0) || [...unsupported].some(id => !command.sources?.ids.includes(id))) throw new Error('旧来源回退范围不一致。');
    for (const header of headers?.headers ?? []) {
      if (!command.sources?.ids.includes(header.id) || currentSources.has(header.id) || unsupported.has(header.id)) throw new Error('来源批次返回外部或重复身份。');
      currentSources.set(header.id, { revision: header.revision, checksum: header.checksum });
    }
    for (const source of response.memorySources ?? []) {
      if (!unsupported.has(source.id) || !source.revision || currentSources.has(source.id)) throw new Error('旧来源缺少准确修订或重复返回身份。');
      currentSources.set(source.id, { revision: source.revision, checksum: hash(source.content) });
    }
    return { notes, noteBindings: new Map([...notes].map(([id, note]) => [id, noteBinding(note)])), navigation: actualNavigation, sourceCurrent: currentSources,
      historyJSON: JSON.stringify([...descriptors].sort(([a], [b]) => a.localeCompare(b))),
      sourceHeadersJSON: JSON.stringify([...(headers?.headers ?? [])].sort((a, b) => a.id.localeCompare(b.id))),
      legacyJSON: JSON.stringify((response.memorySources ?? []).map(sourceBinding).sort()) };
  };
  const packets = await memoCompanionExecutionWitnesses([key], { identity: authority.identity,
    scope: 'memory-document-authority:' + session.owner.id, phase: 'sql-authority', revision: () => 0,
    read: async () => new Map([[key, checked(await session.request(command))]]),
    verify: async entries => {
      for (const entry of entries) {
        const fresh = checked(await authority.read(companionMemoryDocumentAuthorityCommandSchema.parse(JSON.parse(entry.key))));
        for (const [id, binding] of entry.value.noteBindings) if (fresh.noteBindings.get(id) !== binding)
          throw new Error('目录记忆的正文、版本或真实来源在读取期间变化。');
        if (fresh.historyJSON !== entry.value.historyJSON || fresh.sourceHeadersJSON !== entry.value.sourceHeadersJSON || fresh.legacyJSON !== entry.value.legacyJSON)
          throw new Error('目录历史或真实来源在读取期间变化。');
        for (const [input, matched] of entry.value.navigation) if (matched && fresh.navigation.get(input) !== true)
          throw new Error('导航的当前来源或语义版本在读取期间变化。');
      }
    } });
  const packet = packets.get(key); if (!packet) throw new Error('目录缺少准确页级权限回执。');
  const visible: MemoryDocumentPageValue[] = [];
  for (const value of values) {
    if (value.entry.noteId) {
      const note = packet.notes.get(value.entry.noteId); if (!note) continue;
      if (!note.contentRevision || note.artifactKind !== value.entry.artifact.kind || companionMemoryRegisteredPath(note) !== value.path || note.content !== value.content)
        throw new Error('目录正文、类型或当前准确修订不一致；不会展示SQL替代正文。');
      value.note = note;
    }
    if (value.entry.artifact.kind === 'navigation' && packet.navigation.get(navigationByPath.get(value.path)?.key ?? '') !== true) continue;
    if (value.entry.artifact.kind === 'source_evidence') {
      const expected = sources.find(source => source.path === value.path)!, actual = packet.sourceCurrent.get(expected.id);
      if (actual?.revision !== expected.revision || actual.checksum !== expected.checksum) continue;
    }
    visible.push(value);
  }
  const references = new Map<string, { artifactId: string; contentRevision: number; contentHash: string }>();
  for (const value of visible) for (const ref of value.entry.artifact.sourceRefs) {
    const previous = references.get(ref.artifactId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(ref)) throw new Error('目录共享来源携带不同修订。');
    references.set(ref.artifactId, ref);
  }
  if (references.size) {
    const refs = [...references.values()], files = await session.registry.readMany(refs.map(ref => ({ artifactId: ref.artifactId, consumer: 'audit' as const })));
    refs.forEach((ref, index) => { if (files[index]!.artifact.contentRevision !== ref.contentRevision || files[index]!.artifact.contentHash !== ref.contentHash)
      throw new Error('目录的真实来源文件在读取期间变化。'); });
  }
  return visible;
}
