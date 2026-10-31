import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import { companionMemoryRegisteredPath, type CompanionMemoryLibrary, type MemoryLibraryDocumentSession, type MemoryLibraryEntry } from '../../src/main/companions/memory-library';
import type { CompanionMemory } from '../../src/shared/companions';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

it('materializes a thousand actual files without rescanning the complete document catalogue for every note', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-memory-live-scale-'));
  try {
    const notes: CompanionMemory[] = Array.from({ length: 1000 }, (_, index) => ({ artifactKind: 'episode_memory', id: 'note_' + index, companionId: 'alice', scopeId: 'owner', content: 'Actual canonical text ' + index,
      tags: [], sourceConversationId: 'private_alice', sources: [], sourceSequence: 1, createdAt: '2026-10-26', updatedAt: '2026-10-26', origin: 'user', status: 'indexed', version: 1, contentRevision: 1, captureMethod: 'manual' }));
    await mkdir(path.dirname(path.join(root, ...companionMemoryRegisteredPath(notes[0]!).split('/'))), { recursive: true });
    for (let offset = 0; offset < notes.length; offset += 8) await Promise.all(notes.slice(offset, offset + 8).map(note => writeFile(path.join(root, ...companionMemoryRegisteredPath(note).split('/')), note.content)));
    const records = Object.fromEntries(notes.map(note => [companionMemoryRegisteredPath(note), { noteId: note.id, state: 'tracked', version: 1 } as MemoryLibraryEntry]));
    let catalogueEnumerations = 0;
    const files = new Proxy(records, { ownKeys(target) { catalogueEnumerations++; return Reflect.ownKeys(target); } });
    const byId = new Map(notes.map(note => [note.id, note]));
    // This unit probe isolates point-read scaling. Real registry admission and
    // filesystem tamper checks have their own SQL-backed worker coverage.
    const session = { root, owner: { id: 'alice' }, manifest: { files },
      request: async (command: { id: string }) => ({ ok: true, memoryRead: { memory: byId.get(command.id) } }),
      registry: { read: async ({ artifactId }: { artifactId: string }) => { const note = byId.get(artifactId.slice('memory:'.length))!, relativePath = companionMemoryRegisteredPath(note), text = await readFile(path.join(root, ...relativePath.split('/')), 'utf8'); return { text, artifact: { kind: note.artifactKind, relativePath, contentHash: createHash('sha256').update(text).digest('hex'), sourceRefs: [] } }; } },
    } as unknown as MemoryLibraryDocumentSession;
    const library = { withDocuments: async <T>(_owner: string, callback: (session: MemoryLibraryDocumentSession) => Promise<T>) => callback(session) } as CompanionMemoryLibrary;
    const materialized = await new CompanionMemoryLiveFiles({ library }).materialize('alice', notes);
    expect(materialized.receipts).toHaveLength(1000); expect(materialized.notes[999]!.content).toBe(notes[999]!.content);
    expect(catalogueEnumerations).toBeLessThanOrEqual(2);
  } finally { await removeOwnedDirectory(root); }
}, 30000);
