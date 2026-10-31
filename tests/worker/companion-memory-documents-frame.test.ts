import path from 'node:path';
import { stat, utimes, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionConnection } from '../../src/companions/store';
import type { MemoryLibraryDocumentSession } from '../../src/main/companions/memory-library';
import type { CompanionMemoryDocumentRead } from '../../src/shared/companion-memory-documents';
import { companionMemorySourceArtifactId } from '../../src/main/companions/memory-source-files';

async function fixture(count = 12) {
  const f = managedMemoryFiles(), source = f.source('多份正式笔记共享同一条原始来源。');
  const notes = Array.from({ length: count }, (_, index) => f.record(`第${index}条准确的正式事实。`, [source.id]));
  await f.publish();
  const list = () => f.documents.handle({ type: 'memory.documents.list', companionId: 'alice', directory: '记忆/经历', recordsOnly: true, limit: 64 });
  const ready = async () => vi.waitFor(async () => {
    const page = await list(); expect(page.ok, page.error).toBe(true); expect(page.documents?.index?.state).toBe('ready');
  }, { timeout: 15000, interval: 25 });
  return { f, source, notes, list, ready };
}

it('shares one source-metadata admission across a real four-reader page and retains the final fresh SQL fences', async () => {
  const h = await fixture();
  try {
    await h.ready(); h.f.commands.length = 0;
    const subject = h.f.documents as unknown as { read(session: MemoryLibraryDocumentSession, relative: string, limit?: number): Promise<CompanionMemoryDocumentRead> };
    const actual = subject.read.bind(subject); let active = 0, maximum = 0;
    const reads = vi.spyOn(subject, 'read').mockImplementation(async (...args) => {
      maximum = Math.max(maximum, ++active); try { return await actual(...args); } finally { active--; }
    });
    const page = await h.list(); reads.mockRestore();
    expect(page.ok, page.error).toBe(true); expect(page.documents?.items).toHaveLength(12); expect(maximum).toBe(4);
    const source = companionMemorySourceArtifactId(h.source.id, 1);
    expect(h.f.commands.filter(command => command.type === 'cognition.registry.read' && command.artifactIds?.includes(source))).toHaveLength(3);
    h.f.commands.length = 0; expect((await h.list()).ok).toBe(true);
    expect(h.f.commands.filter(command => command.type === 'cognition.registry.read' && command.artifactIds?.includes(source))).toHaveLength(3);
  } finally { await h.f.close(); }
});

it.each(['same_stat_bytes', 'external_sql_permission'] as const)('rejects late %s changes after parallel readers consumed the first file', async change => {
  const h = await fixture(8);
  try {
    await h.ready(); const reads = new Map<string, number>(); let mutated = false;
    h.f.intercept(async command => {
      if (command.type !== 'memory.library.read') return;
      reads.set(command.id, (reads.get(command.id) ?? 0) + 1);
      if (mutated || h.notes.some(note => (reads.get(note.id) ?? 0) < 2)) return;
      mutated = true;
      if (change === 'same_stat_bytes') {
        const target = h.notes.find(note => note.id !== command.id)!, file = h.f.noteFile(target), before = await stat(file);
        await writeFile(file, target.content.replace('准确', '篡改'), 'utf8'); await utimes(file, before.atime, before.mtime);
      } else {
        const db = new (Database as { new(filename: string): CompanionConnection })(path.join(h.f.root, 'state.sqlite'));
        try {
          const id = companionMemorySourceArtifactId(h.source.id, 1);
          const found = db.prepare('SELECT metadata FROM companion_artifacts WHERE owner_id=? AND artifact_id=?').get('alice', id) as { metadata: string };
          db.prepare('UPDATE companion_artifacts SET metadata=? WHERE owner_id=? AND artifact_id=?')
            .run(JSON.stringify({ ...JSON.parse(found.metadata), publicationState: 'revoked' }), 'alice', id);
        } finally { db.close(); }
      }
    });
    const page = await h.list(); expect(mutated).toBe(true); expect(page.ok).toBe(false); expect(page.documents).toBeUndefined();
  } finally { await h.f.close(); }
});

it('lets an owner catalog batch continue after its UI gate returned without inheriting its sealed lifetime', async () => {
  const h = await fixture(16); let release!: () => void, arrived!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { arrived = resolve; });
  let touches = 0;
  h.f.intercept(async command => { if (command.type === 'document.catalog.touch' && ++touches === 13) { arrived(); await blocked; } });
  try {
    const first = h.list();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([waiting, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Background catalog did not start')), 10000); timer.unref(); })]); }
    finally { clearTimeout(timer); }
    expect((await first).ok).toBe(true); // Its final fence does not join the unrelated blocked catalog read.
    release(); await h.ready();
    expect((await h.list()).documents?.items).toHaveLength(16);
  } finally { release(); await h.f.close(); }
});

it('does not label an earlier partial SQL page ready when background indexing completes during its body reads', async () => {
  const f = managedMemoryFiles(); let release!: () => void, finished!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), complete = new Promise<void>(resolve => { finished = resolve; });
  try {
    const registry = await f.artifacts('alice');
    await registry.publishBatch({ operationId: 'fixture:partial-page', items: Array.from({ length: 20 }, (_, index) => ({
      artifactId: 'fixture:page:' + index, kind: 'knowledge' as const, producer: { kind: 'system' as const, id: 'fixture' },
      relativePath: `记忆/知识/page/${String(index).padStart(2, '0')}.md`, expectedRevision: null, content: '正式资料 ' + index,
      sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' as const }, allowedConsumers: ['audit' as const], retentionClass: 'current' as const,
    })) });
    let touches = 0, queried = false, held = false;
    f.intercept(async command => {
      if (command.type === 'document.catalog.touch' && ++touches === 13) await blocked;
      if (command.type === 'document.catalog.query') queried = true;
      if (command.type === 'document.catalog.finish') finished();
      if (queried && !held && command.type === 'cognition.registry.read' && command.relativePath) {
        held = true; release(); await complete;
        // Let the real finish response update catalog state before continuing
        // the UI's already selected twelve canonical files.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    });
    const request = { type: 'memory.documents.list' as const, companionId: 'alice', directory: '记忆/知识/page', limit: 64 };
    const first = await f.documents.handle(request);
    expect(held).toBe(true); expect(first.ok, first.error).toBe(true); expect(first.documents?.items).toHaveLength(12);
    expect(first.documents?.index?.state).toBe('building');
    const fresh = await f.documents.handle(request);
    expect(fresh.ok, fresh.error).toBe(true); expect(fresh.documents?.items).toHaveLength(20); expect(fresh.documents?.index?.state).toBe('ready');
  } finally { release(); await f.close(); }
});
