import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionArtifactRegistry } from '../../src/main/companions/artifact-registry';
import { CompanionMemoryLibrary, companionMemoryRegisteredPath } from '../../src/main/companions/memory-library';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import { CompanionMemoryDocuments } from '../../src/main/companions/memory-documents';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMemory } from '../../src/shared/companions';
import type { CompanionMemoryCandidate } from '../../src/shared/companion-memory';

/** Real isolated SQL, typed registry and filesystem. It never opens a user library. */
export function managedMemoryFiles() {
  const root = mkdtempSync(path.join(tmpdir(), 'wlbox-managed-memory-')), filename = path.join(root, 'state.sqlite'), directory = path.join(root, 'owners');
  const seeds = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '有来源的伙伴。', avatar: 'sister' as const, model: '', active: true, proactive: false }));
  let store = new CompanionsStore(filename, seeds);
  for (const seed of seeds) mkdirSync(path.join(directory, seed.id), { recursive: true });
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, commands: CompanionStorageCommand[] = [];
  let intercept: ((command: CompanionStorageCommand) => void | Promise<void>) | undefined;
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => { commands.push(command); await intercept?.(command); return store.request(command); };
  const artifacts = async (owner: string) => new CompanionArtifactRegistry(path.join(directory, owner), owner, { registryStorage: { request } });
  const library = new CompanionMemoryLibrary({ libraryDirectory: directory, artifacts, request, maxFilesPerOwner: 64 });
  const sources = new CompanionMemorySourceFiles({ library }), history = new CompanionMemoryHistoryFiles({ library }), live = new CompanionMemoryLiveFiles({ library, history });
  const documents = new CompanionMemoryDocuments({ library, libraryDirectory: directory, requestStorage: request });
  const source = (content: string, owner = 'alice') => store.appendMessage({ conversationId: store.openPrivate(owner).id, authorId: 'user', content, replyDirective: 'none' });
  const candidate = (content: string, ids: string[], relatedMemoryIds: string[] = []): CompanionMemoryCandidate => ({ artifactKind: 'episode_memory', content, tags: [], sourceMessageIds: ids, relatedMemoryIds, evidence: ids.map(id => ({ sourceMessageId: id, quote: store.getMessage(id).content })) });
  const index = () => { for (;;) { const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!job) break; store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true }); } };
  const record = (content: string, ids = [source(content + ' 的原始依据。').id], dependencies: string[] = []) => { const note = store.request({ type: 'memory.record', ...scope, candidate: candidate(content, ids, dependencies) }).memories![0]!; index(); return note; };
  const publish = async (owner = 'alice') => { while ((await sources.flush(owner)).pending) { /* durable source evidence */ } while ((await history.flush(owner)).pending) { /* history and current bodies share this durable outbox */ } };
  const file = (relative: string, owner = 'alice') => path.join(directory, owner, ...relative.split('/'));
  const noteFile = (note: CompanionMemory) => file(companionMemoryRegisteredPath(note), note.companionId);
  const historyFile = (id: string, revision: number) => file(store.request({ type: 'memory.revision.describe', ...scope, id, contentRevision: revision }).memoryHistoryDescriptor!.relativePath);
  return { root, directory, scope, commands, request, artifacts, library, sources, history, live, documents, source, candidate, index, record, publish, file, noteFile, historyFile,
    get store() { return store; }, intercept: (hook?: typeof intercept) => { intercept = hook; }, restart: () => { store.close(); store = new CompanionsStore(filename, seeds); },
    close: async () => { await documents.close(); await library.close(); store.close(); if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('wlbox-managed-memory-')) throw new Error('Unsafe fixture cleanup'); removeOwnedDirectorySync(root); } };
}
