import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CompanionsStore } from '../../src/companions/store';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { assembleCompanionAssetContext } from '../../src/main/companions/asset-context';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { canonicalProjectionInputs } from '../../src/main/companions/canonical-projection-inputs';
import type { CompanionMemoryProjectionNote } from '../../src/shared/companion-memory-projection';
import type { CompanionMemory } from '../../src/shared/companions';
import { loadInitialTimelinePrompts } from '../../src/main/vcp-memory/owner-prompts';
import type { Companion } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionModelConfig } from '../../src/main/companions/model';

/** Composes production file actors for isolated real-model quality probes.
 * This is not a substitute for Main/Electron UI integration coverage. */
export async function canonicalMemoryFiles(root: string, store: CompanionsStore, config: CompanionModelConfig) {
  const vendor = path.resolve('vendor/vcp-memory'), directory = path.join(root, 'owner-assets');
  const raw = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => store.request(command);
  const profiles = new CompanionAssetProfileStore(directory, {
    registryStorage: { request: async command => {
      const response = await raw(command); if (!response.ok) throw new Error(response.error ?? 'Fixture registry storage failed.'); return response;
    } },
    loadInitialFocusPrompt: () => readFile(path.join(vendor, 'Plugin/RAGDiaryPlugin/AIMemoPrompt.txt'), 'utf8'),
    loadInitialTagPrompt: () => readFile(path.join(vendor, 'Plugin/DailyNote/TagMaster.txt'), 'utf8'),
    loadInitialTimelinePrompts: () => loadInitialTimelinePrompts(vendor),
  });
  for (const owner of store.state().companions) await profiles.bootstrap(owner);
  const library = new CompanionMemoryLibrary({ libraryDirectory: directory, profileStore: profiles, request: raw });
  const history = new CompanionMemoryHistoryFiles({ library }), sources = new CompanionMemorySourceFiles({ library });
  const live = new CompanionMemoryLiveFiles({ library, history });
  // The typed history outbox commits both the immutable history and its current
  // body. A read must not rescan/re-publish all existing SQL notes.
  const publish = async (owner: string) => { await sources.flush(owner); await history.flush(owner); };
  for (const owner of store.state().companions) await publish(owner.id);
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'memory.revision.read') { await sources.flush(command.companionId);
      return { ok: true, memories: [await history.read(command, command.id, command.contentRevision)] }; }
    const response = await raw(command);
    const owner = 'companionId' in command && typeof command.companionId === 'string' ? command.companionId : response.memoryOutbox?.companionId;
    if (owner) {
      const notes = response.memorySnapshot?.notes ?? response.memoryCaptureContributions?.items ?? response.memoryPage?.items.map(hit => hit.memory)
        ?? response.memoryLibraryIndexPage?.notes ?? response.memoryLibraryChanges?.changes.flatMap(change => change.note ? [change.note] : [])
        ?? (response.memoryRead ? [response.memoryRead.memory, ...response.memoryRead.related] : response.memoryOutbox?.operation === 'remember' ? [response.memoryOutbox.note] : response.memories);
      if (notes?.length) {
        await publish(owner); const actual = await live.materialize(owner, notes);
        if (response.memorySnapshot) response.memorySnapshot = { ...response.memorySnapshot, notes: actual.notes, fileReceipts: actual.receipts };
        else if (response.memoryCaptureContributions) response.memoryCaptureContributions.items = actual.notes;
        else if (response.memoryPage) response.memoryPage.items = response.memoryPage.items.map((hit, index) => ({ ...hit, memory: actual.notes[index]! }));
        else if (response.memoryLibraryIndexPage) response.memoryLibraryIndexPage.notes = actual.notes;
        else if (response.memoryLibraryChanges) {
          let index = 0;
          response.memoryLibraryChanges.changes = response.memoryLibraryChanges.changes.map(change => change.note ? { ...change, note: actual.notes[index++]! } : change);
        }
        else if (response.memoryRead) { response.memoryRead.memory = actual.notes[0]!; response.memoryRead.related = actual.notes.slice(1); }
        else if (response.memoryOutbox?.operation === 'remember') response.memoryOutbox.note = actual.notes[0]!;
        else response.memories = actual.notes;
      }
      if (response.memorySources?.length) {
        await sources.flush(owner);
        const references = new Map<string, CompanionMemory['sources'][number]>(), requested = new Set(response.memorySources.map(message => message.id));
        let cursor = 0;
        for (;;) {
          const ledger = store.request({ type: 'memory.library.page', companionId: owner, cursor, limit: 64 }).memoryPage;
          if (!ledger) throw new Error('The actual source-reference page is unavailable.');
          for (const hit of ledger.items) for (const source of hit.memory.sources) if (requested.has(source.messageId)) references.set(source.messageId, source);
          if (references.size === requested.size || !ledger.hasMore) break;
          if (ledger.nextCursor === undefined || ledger.nextCursor <= cursor) throw new Error('The actual source-reference cursor did not advance.');
          cursor = ledger.nextCursor;
        }
        response.memorySources = await Promise.all(response.memorySources.map(async message => {
          const reference = references.get(message.id);
          // Fresh communication is the actual task input. Stored cognitive
          // evidence additionally requires its already published owner file.
          return reference ? { ...message, content: await sources.read({ companionId: owner, conversationId: message.conversationId }, reference) } : message;
        }));
      }
    }
    return response;
  };
  const configFor = async (owner: Pick<Companion, 'id'>): Promise<CompanionModelConfig> => ({ ...config,
    resolveAssetContext: async (context, kind) => assembleCompanionAssetContext(context, await profiles.load(owner.id), kind) });
  return { request, profiles, live, history, sources, configFor, publish, library,
    projection: { materializeNotes: (owner: string, notes: readonly CompanionMemory[]) => live.projectionNotes(owner, notes),
      canonicalInputs: (scope: { companionId: string; conversationId: string; beforeSequence?: number }, notes: readonly CompanionMemoryProjectionNote[]) =>
        canonicalProjectionInputs(history, scope, notes, library) },
    close: async () => { await library.close(); } };
}
