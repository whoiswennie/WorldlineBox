import type { CompanionMemory } from '../../shared/companions';
import type { CompanionMemoryProjectionNote } from '../../shared/companion-memory-projection';
import type { CompanionMemoryHistoryFiles } from './memory-history-files';
import type { CompanionMemoryLibrary, MemoryLibraryDocumentSession } from './memory-library';
import { companionMemorySchema } from '../../shared/companion-memory';

/** The cached catalogue describes captured annotations; immutable owner files
 * supply bodies and recheck every original source file/ACL. No SQL body fallback. */
export async function canonicalProjectionInputs(history: CompanionMemoryHistoryFiles,
  scope: { companionId: string; conversationId: string; beforeSequence?: number }, notes: readonly CompanionMemoryProjectionNote[],
  library?: CompanionMemoryLibrary): Promise<CompanionMemory[]> {
  const read = async (session?: MemoryLibraryDocumentSession): Promise<CompanionMemory[]> => {
    const roots = notes.map(expected => {
      if (expected.companionId !== scope.companionId || expected.contentRevision === undefined) throw new Error('原生候选缺少当前伙伴的宿主正文修订。');
      return { id: expected.id, contentRevision: expected.contentRevision };
    });
    const actuals = session ? await history.readManyInSession(session, scope, roots) : await history.readMany(scope, roots);
    return notes.map((expected, index) => {
      const actual = actuals[index]!;
      if (actual.id !== expected.id || actual.companionId !== scope.companionId || actual.contentRevision !== expected.contentRevision
        || actual.sources.length !== expected.sources.length || actual.sources.some(source => !expected.sources.some(reference => reference.messageId === source.messageId
          && reference.revision === source.revision && reference.checksum === source.checksum))) throw new Error('原生候选的实际历史来源与捕获元数据不一致。');
      return companionMemorySchema.parse({ ...expected, content: actual.content });
    });
  };
  return library ? library.withDocuments(scope.companionId, session => read(session),
    { synchronize: false, sourceDelivery: true, readOnly: true }) : read();
}
