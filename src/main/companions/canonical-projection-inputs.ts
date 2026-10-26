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
  const results = new Array<CompanionMemory>(notes.length); let cursor = 0, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(8, notes.length) }, async () => {
    while (cursor < notes.length && failure === undefined) {
      const index = cursor++, expected = notes[index]!;
      try {
        if (expected.companionId !== scope.companionId || expected.contentRevision === undefined) throw new Error('原生候选缺少当前伙伴的宿主正文修订。');
        const contentRevision = expected.contentRevision;
        // A warm selected set shares one immutable directory manifest. Every
        // historical body/source is still opened and authenticated. Only the
        // existing publisher may finish a pending durable history operation;
        // its read path rejects missing or edited already-published files.
        const actual = session ? await history.readInSession(session, scope, expected.id, contentRevision)
          .catch(() => history.read(scope, expected.id, contentRevision))
          : await history.read(scope, expected.id, contentRevision);
        if (actual.id !== expected.id || actual.companionId !== scope.companionId || actual.contentRevision !== expected.contentRevision
          || actual.sources.length !== expected.sources.length || actual.sources.some(source => !expected.sources.some(reference => reference.messageId === source.messageId
            && reference.revision === source.revision && reference.checksum === source.checksum))) throw new Error('原生候选的实际历史来源与捕获元数据不一致。');
        results[index] = companionMemorySchema.parse({ ...expected, content: actual.content });
      } catch (error) { failure ??= error; }
    }
  }));
  if (failure !== undefined) throw failure; return results;
  };
  return library ? library.withDocuments(scope.companionId, session => read(session),
    { synchronize: false, sourceDelivery: true, readOnly: true }) : read();
}
