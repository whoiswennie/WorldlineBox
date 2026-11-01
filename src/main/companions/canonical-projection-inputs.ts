import type { CompanionMemory } from '../../shared/companions';
import type { CompanionMemoryProjectionNote } from '../../shared/companion-memory-projection';
import type { CompanionMemoryHistoryFiles } from './memory-history-files';
import type { CompanionMemoryLibrary, MemoryLibraryDocumentSession } from './memory-library';
import { companionMemorySchema } from '../../shared/companion-memory';
import { withCompanionExecutionValidation } from './source-execution-evidence';
import { createHash } from 'node:crypto';
import type { CompanionMemoryFileReceipt } from '../../shared/companion-memory-files';

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
async function readCanonical(history: CompanionMemoryHistoryFiles, scope: Scope, notes: readonly CompanionMemoryProjectionNote[], session?: MemoryLibraryDocumentSession) {
  const roots = notes.map(expected => {
    if (expected.companionId !== scope.companionId || expected.contentRevision === undefined) throw new Error('原生候选缺少当前伙伴的宿主正文修订。');
    return { id: expected.id, contentRevision: expected.contentRevision };
  });
  const actuals = session ? await history.readManyInSession(session, scope, roots, { projectionInputs: true }) : await history.readMany(scope, roots);
  return notes.map((expected, index) => {
    const actual = actuals[index]!;
    if (actual.id !== expected.id || actual.companionId !== scope.companionId || actual.contentRevision !== expected.contentRevision
      || actual.sources.length !== expected.sources.length || actual.sources.some(source => !expected.sources.some(reference => reference.messageId === source.messageId
        && reference.revision === source.revision && reference.checksum === source.checksum))) throw new Error('原生候选的实际历史来源与捕获元数据不一致。');
    return { actual, memory: companionMemorySchema.parse({ ...expected, content: actual.content }) };
  });
}

/** The cached catalogue describes captured annotations; immutable owner files
 * supply bodies and recheck every original source file/ACL. No SQL body fallback. */
export async function canonicalProjectionInputs(history: CompanionMemoryHistoryFiles,
  scope: { companionId: string; conversationId: string; beforeSequence?: number }, notes: readonly CompanionMemoryProjectionNote[],
  library?: CompanionMemoryLibrary): Promise<CompanionMemory[]> {
  const read = async (session?: MemoryLibraryDocumentSession): Promise<CompanionMemory[]> => (await readCanonical(history, scope, notes, session)).map(value => value.memory);
  return withCompanionExecutionValidation(() => library ? library.withDocuments(scope.companionId, session => read(session),
    { synchronize: false, sourceDelivery: true, readOnly: true }) : read());
}

/** Selected native inputs and their canonical receipts share the exact query
 * entrance/cursor, document session and finite final fences. A second owner-
 * private history pass cannot widen the query or validate the same closure
 * again. Current files are still read even for a lawful historical receipt. */
export function canonicalProjectionInputsAndFiles(history: CompanionMemoryHistoryFiles, scope: Scope,
  notes: readonly CompanionMemoryProjectionNote[], library: CompanionMemoryLibrary): Promise<{ notes: CompanionMemory[]; receipts: CompanionMemoryFileReceipt[] }> {
  return withCompanionExecutionValidation(() => library.withDocuments(scope.companionId, async session => {
    const values = await readCanonical(history, scope, notes, session);
    const current = await session.registry.readMany(notes.map(note => ({ artifactId: `memory:${note.id}`, consumer: 'audit' as const })));
    for (let index = 0; index < notes.length; ++index) if (values[index]!.actual.artifactKind !== notes[index]!.artifactKind)
      throw new Error('捕获正文与正式历史版本的记忆类型不一致。');
    return { notes: values.map(value => value.memory), receipts: values.map((value, index) => ({ companionId: scope.companionId,
      noteId: value.memory.id, contentRevision: value.memory.contentRevision!, path: current[index]!.artifact.relativePath,
      contentHash: createHash('sha256').update(value.actual.content).digest('hex') })) };
  }, { synchronize: false, sourceDelivery: true, readOnly: true }));
}
