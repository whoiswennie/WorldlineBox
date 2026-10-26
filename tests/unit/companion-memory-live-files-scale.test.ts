import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import type { CompanionMemoryLibrary, MemoryLibraryDocumentSession, MemoryLibraryEntry } from '../../src/main/companions/memory-library';
import type { CompanionMemory } from '../../src/shared/companions';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

it('materializes a thousand actual files without rescanning the complete document catalogue for every note', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-memory-live-scale-'));
  try {
    await mkdir(path.join(root, '日记'));
    const notes: CompanionMemory[] = Array.from({ length: 1000 }, (_, index) => ({ id: 'note_' + index, companionId: 'alice', scopeId: 'owner', content: 'Actual canonical text ' + index,
      tags: [], sourceConversationId: 'private_alice', sources: [], sourceSequence: 1, createdAt: '2026-10-26', updatedAt: '2026-10-26', origin: 'user', status: 'indexed', version: 1, contentRevision: 1, captureMethod: 'manual' }));
    for (let offset = 0; offset < notes.length; offset += 8) await Promise.all(notes.slice(offset, offset + 8).map(note => writeFile(path.join(root, '日记', note.id + '.md'), note.content)));
    const records = Object.fromEntries(notes.map(note => ['日记/' + note.id + '.md', { noteId: note.id, state: 'tracked', version: 1 } as MemoryLibraryEntry]));
    let catalogueEnumerations = 0;
    const files = new Proxy(records, { ownKeys(target) { catalogueEnumerations++; return Reflect.ownKeys(target); } });
    const byId = new Map(notes.map(note => [note.id, note]));
    const session = { root, manifest: { files }, file: (relative: string) => path.join(root, ...relative.split('/')),
      current: async (entry: MemoryLibraryEntry) => byId.get(entry.noteId!) } as MemoryLibraryDocumentSession;
    const library = { withDocuments: async <T>(_owner: string, callback: (session: MemoryLibraryDocumentSession) => Promise<T>) => callback(session) } as CompanionMemoryLibrary;
    const materialized = await new CompanionMemoryLiveFiles({ library }).materialize('alice', notes);
    expect(materialized.receipts).toHaveLength(1000); expect(materialized.notes[999]!.content).toBe(notes[999]!.content);
    expect(catalogueEnumerations).toBeLessThanOrEqual(2);
  } finally { await removeOwnedDirectory(root); }
}, 30000);
