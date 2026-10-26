import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { nativeManagementHarness } from '../fixtures/vcp-management-native';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { VcpMemoryAutomaticDecayPolicy } from '../../src/main/vcp-memory/contracts';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

it('prepares the actual worker without query/model calls and invalidates focused receipts after native mutations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-vcp-preparation-native-'));
  const harness = await nativeManagementHarness(root, async () => ({ ok: true }), {
    chatReply: '这是我获取的所有相关知识/记忆[[SYNTHETIC_ALPHA_MEMORY]]',
  });
  const client = harness.client, scope = { scopeId: 'stable-full-owner' };
  try {
    const notes = Array.from({ length: 101 }, (_, index) => ({ id: `note-${index}`, content: `group${index % 16} alpha synthetic memory ${index}`,
      tags: [`group${index % 16}`, 'alpha'], occurredAt: '2026-10-20T08:00:00+08:00', author: 'owner' }));
    await client.replace(scope, notes);
    const requestCount = harness.embeddingRequests.length;
    const prepared = await client.prepare(scope);
    expect(prepared.ready).toBe(true);
    expect(harness.chatRequests).toHaveLength(0);
    expect(harness.embeddingRequests.slice(requestCount).some(request => request.path.startsWith('/query/'))).toBe(false);
    const messages = [{ role: 'system', content: '[[AIMemo=True]]\n[[memories日记本::RiverMemo::TimeDecay180/0::AIMemo+]]' },
      { role: 'user', content: 'group0 alpha synthetic memory' }];
    const clock = { now: '2026-10-26T08:00:00+08:00', timeZone: 'Asia/Shanghai' };
    const policy: VcpMemoryAutomaticDecayPolicy = { schema: 'episodic-v1', halfLifeDays: 180, minScore: 0, protectedNoteIds: notes.map(note => note.id) };
    const first = await client.preprocess(scope, messages, clock, policy);
    expect(first.receiptCache?.hit).toBe(false);
    expect(first.contextReferences?.length).toBeGreaterThan(0);
    const modelCalls = harness.chatRequests.length;
    expect(modelCalls).toBeGreaterThan(0);
    const repeated = await client.preprocess(scope, messages, clock, policy);
    expect(repeated.receiptCache).toMatchObject({ hit: true, corpusEpoch: first.receiptCache!.corpusEpoch });
    expect(repeated.contextReferences).toEqual(first.contextReferences);
    expect(harness.chatRequests).toHaveLength(modelCalls);
    await client.remember(scope, { id: 'new-source', content: 'group0 alpha corrected synthetic memory', tags: ['group0', 'alpha'] });
    const added = await client.preprocess(scope, messages, clock, policy);
    expect(added.receiptCache?.hit).toBe(false);
    expect(added.receiptCache!.corpusEpoch).toBeGreaterThan(first.receiptCache!.corpusEpoch);
    await client.forget(scope, 'new-source');
    const forgotten = await client.preprocess(scope, messages, clock, policy);
    expect(forgotten.receiptCache?.hit).toBe(false);
    expect(forgotten.receiptCache!.corpusEpoch).toBeGreaterThan(added.receiptCache!.corpusEpoch);
    await client.replace(scope, await client.list(scope));
    expect((await client.preprocess(scope, messages, clock, policy)).receiptCache?.hit).toBe(true);
  } finally { await harness.close(); await removeOwnedDirectory(root); }
}, 120_000);

it('reopens 101 persisted native memories without re-encoding and encodes only actual document changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-vcp-restart-incremental-'));
  const output = path.resolve('artifacts/vcp-validation/native-restart-incremental.json');
  const harness = await nativeManagementHarness(root, async () => ({ ok: true }));
  const scope = { scopeId: 'persistent-owner-memory' }, records: Array<Record<string, unknown>> = [];
  let reopened: VcpMemoryClient | undefined;
  const createClient = () => new VcpMemoryClient({ dataRoot: path.join(root, 'native'),
    vendorRoot: path.resolve('vendor/vcp-memory'), workerPath: path.resolve('src/main/vcp-memory/worker.cjs'),
    embedding: harness.embedding, launch: harness.launch, maxOpenScopes: 1, requestTimeoutMs: 120_000 });
  const measure = async <T>(stage: string, task: () => Promise<T>) => {
    const offset = harness.embeddingRequests.length, started = performance.now();
    const before = harness.audit();
    const value = await task();
    const requests = harness.embeddingRequests.slice(offset);
    const documentRequests = requests.filter(request => request.path.startsWith('/document/'));
    const documentInputs = documentRequests.flatMap(request => request.input);
    const after = harness.audit();
    records.push({ stage, elapsedMs: performance.now() - started, documentRequests: documentRequests.length,
      documentInputs: documentInputs.length, documentCharacters: documentInputs.reduce((sum, text) => sum + text.length, 0),
      queryRequests: requests.filter(request => request.path.startsWith('/query/')).length,
      recordReads: after.recordReads - before.recordReads, recordDirectoryScans: after.recordDirectoryScans - before.recordDirectoryScans });
    return { value, documentInputs };
  };
  try {
    const notes = Array.from({ length: 101 }, (_, index) => ({ id: `restart-note-${index}`,
      content: index === 0 ? 'group0 RESTART_NOTE_0 ORIGINAL_REVISION_PROOF' : `group${1 + index % 13} RESTART_NOTE_${index} unchanged source`,
      tags: ['alpha'], author: 'owner', occurredAt: '2026-10-20T08:00:00+08:00' }));
    const initial = await measure('initial-101', async () => { await harness.client.replace(scope, notes); await harness.client.prepare(scope); });
    expect(initial.documentInputs.filter(text => /RESTART_NOTE_/u.test(text))).toHaveLength(101);
    expect(await harness.client.list(scope)).toHaveLength(101);
    await harness.client.close();

    reopened = createClient();
    const restart = await measure('restart-same-101', async () => { await reopened!.replace(scope, notes); await reopened!.prepare(scope); });
    expect(restart.documentInputs).toHaveLength(0);
    expect(await reopened.list(scope)).toHaveLength(101);

    const added = { id: 'restart-added-note', content: 'group15 RESTART_ADDED_NOTE incremental source',
      tags: ['alpha'], author: 'owner', occurredAt: '2026-10-21T08:00:00+08:00' };
    const withAddition = [...notes, added];
    const addition = await measure('add-one-to-102', async () => { await reopened!.replace(scope, withAddition); await reopened!.prepare(scope); });
    expect(addition.documentInputs).toHaveLength(1);
    expect(addition.documentInputs[0]).toContain('RESTART_ADDED_NOTE');
    expect((await reopened.search(scope, { text: 'group15 RESTART_ADDED_NOTE', topK: 100 })).results.some(hit => hit.id === added.id)).toBe(true);

    const revised = { ...notes[0]!, content: 'group0 RESTART_NOTE_0 FINAL_REVISION_PROOF' };
    const withRevision = [revised, ...notes.slice(1), added];
    const revision = await measure('revise-one-of-102', async () => { await reopened!.replace(scope, withRevision); await reopened!.prepare(scope); });
    expect(revision.documentInputs).toHaveLength(1);
    expect(revision.documentInputs[0]).toContain('FINAL_REVISION_PROOF');
    expect(revision.documentInputs[0]).not.toContain('ORIGINAL_REVISION_PROOF');
    const revisedHits = await reopened.search(scope, { text: 'group0 ORIGINAL_REVISION_PROOF', topK: 100 });
    expect(revisedHits.results.find(hit => hit.id === revised.id)?.content).toBe(revised.content);
    expect(revisedHits.results.some(hit => hit.content.includes('ORIGINAL_REVISION_PROOF'))).toBe(false);

    // Delete the addition and one original: exactly 100 original/revised notes
    // remain. Their document vectors must survive both deletion and restart.
    const remaining = withRevision.filter(note => note.id !== added.id && note.id !== 'restart-note-100');
    const deletion = await measure('delete-two-keep-100', async () => {
      await reopened!.replace(scope, remaining); await reopened!.prepare(scope);
      const hits = await reopened!.search(scope, { text: 'group15 RESTART_ADDED_NOTE RESTART_NOTE_100', topK: 100 });
      expect(hits.results.some(hit => [added.id, 'restart-note-100'].includes(hit.id))).toBe(false);
      expect(hits.results.some(hit => /RESTART_ADDED_NOTE|RESTART_NOTE_100|ORIGINAL_REVISION_PROOF/u.test(hit.content))).toBe(false);
    });
    expect(deletion.documentInputs).toHaveLength(0);
    expect(await reopened.list(scope)).toHaveLength(100);
    expect(await reopened.read(scope, added.id)).toBeNull();
    expect(await reopened.read(scope, 'restart-note-100')).toBeNull();
    await reopened.close();

    reopened = createClient();
    const finalRestart = await measure('restart-final-100', async () => { await reopened!.replace(scope, remaining); await reopened!.prepare(scope); });
    expect(finalRestart.documentInputs).toHaveLength(0);
    expect(await reopened.list(scope)).toHaveLength(100);
    expect((await reopened.read(scope, revised.id))?.content).toBe(revised.content);
    expect(harness.chatRequests).toHaveLength(0);
  } finally {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ recordedAt: new Date().toISOString(), nativeEngine: true,
      embedding: 'synthetic-localhost', realUserDataModified: false, modelRequests: harness.chatRequests.length, records }, null, 2));
    await reopened?.close(); await harness.close(); await removeOwnedDirectory(root);
  }
}, 120_000);
