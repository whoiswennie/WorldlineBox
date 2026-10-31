import { expect, it } from 'vitest';
import { CompanionMemoryDocumentCatalog } from '../../src/main/companions/memory-document-catalog';
import type { CompanionMemoryLibrary, MemoryLibraryDocumentSession } from '../../src/main/companions/memory-library';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMemoryDocument } from '../../src/shared/companion-memory-documents';
import type { CompanionArtifact } from '../../src/shared/companion-artifact';

function fixture() {
  const files: MemoryLibraryDocumentSession['manifest']['files'] = {};
  for (let i = 0; i < 20; i++) {
    const relativePath = `记忆/知识/${String(i).padStart(2, '0')}.md`;
    const artifact: CompanionArtifact = { schema: 'worldlinebox.companion-artifact-v2', artifactId: `knowledge:${i}`, ownerId: 'alice', kind: 'knowledge',
      relativePath, producer: { kind: 'system', id: 'fixture' }, contentRevision: 1, contentHash: 'a'.repeat(64), sourceRefs: [], dependencyRefs: [],
      visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'current', publicationState: 'committed', operationId: `fixture:${i}`, committedAt: '2026-10-29T00:00:00.000Z' };
    files[relativePath] = { artifact, hash: artifact.contentHash, state: 'tracked' };
  }
  const stamps = new Map<string, string>(); let bodyReads = 0, gate: Promise<void> | undefined;
  const session = { owner: { id: 'alice' }, manifest: { files }, currentEntry: async (file: string) => files[file],
    text: async (file: string) => { bodyReads++; if (file.endsWith('/12.md')) await gate; return '# Registered knowledge'; },
  } as unknown as MemoryLibraryDocumentSession;
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'document.catalog.touch') return { ok: true, documentCatalogUnchanged: stamps.get(command.path) === command.stamp };
    if (command.type === 'document.catalog.put') for (const entry of command.entries) stamps.set(entry.document.path, entry.stamp);
    return { ok: true };
  };
  const make = () => new CompanionMemoryDocumentCatalog({ library: { withDocuments: async (_owner: string, work: (value: MemoryLibraryDocumentSession) => Promise<void>) => work(session) } as unknown as CompanionMemoryLibrary,
    request, describe: relative => ({ path: relative } as CompanionMemoryDocument) });
  return { session, make, stamps, get bodyReads() { return bodyReads; }, block(value: Promise<void>) { gate = value; } };
}

it('returns the first twelve catalogue entries without waiting for an unrelated background body, and subsequent reads do not queue behind it', async () => {
  const f = fixture(), catalog = f.make(); let release!: () => void;
  f.block(new Promise<void>(resolve => { release = resolve; }));
  try {
    const initial = await catalog.ensure(f.session); expect(initial.indexed).toBe(12); expect(f.bodyReads).toBe(12);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.bodyReads).toBe(13);
    let accepted = false;
    const followup = catalog.ensure(f.session).then(() => { accepted = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(accepted).toBe(true);
    release(); await followup;
  } finally { release(); await catalog.close(); }
});

it('reuses exact persisted catalogue stamps after reopening rather than rereading unchanged registered bodies', async () => {
  const f = fixture(), first = f.make();
  await first.ensure(f.session); await first.close(); const previous = f.bodyReads;
  expect(f.stamps.size).toBe(12);
  const reopened = f.make();
  try { const state = await reopened.ensure(f.session); expect(state.indexed).toBe(12); expect(f.bodyReads).toBe(previous); }
  finally { await reopened.close(); }
});
