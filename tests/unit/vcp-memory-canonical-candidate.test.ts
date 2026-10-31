import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import { VcpPreparedRecallStore } from '../../src/main/vcp-memory/prepared-recall-store';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { VcpMemoryNote, VcpMemoryPreparedPayload } from '../../src/main/vcp-memory/contracts';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const renderer = createRequire(import.meta.url)(path.resolve('src/main/vcp-memory/runtime.cjs')) as {
  renderNativeDiaryText(note: VcpMemoryNote): string; renderNativeDiaryFileText(note: VcpMemoryNote): string;
};
it('authenticates normal semantic chunks and original Expand files while rejecting changed prose, foreign anchors and tags', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-canonical-candidate-'));
  const store = new VcpPreparedRecallStore(root), client = new VcpMemoryClient({ dataRoot: root, vendorRoot: path.resolve('vendor/vcp-memory'),
    workerPath: path.resolve('src/main/vcp-memory/worker.cjs'), embedding: { baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'unused', dimension: 4 } });
  const note: VcpMemoryNote = { id: 'knowledge_one', content: '合成教材：普通读者同时最多借三本，每本十四天；已预约不得续借。',
    tags: ['合成教材', '借阅规则'], occurredAt: '2026-10-28T10:00:00Z', author: 'Alice', diaryName: '知识' };
  const semantic = renderer.renderNativeDiaryText(note), expanded = renderer.renderNativeDiaryFileText(note);
  expect(semantic).not.toContain('WorldlineBoxMemory:'); expect(expanded).toContain(digest(note.id));
  try {
    for (const [text, accepted] of [[semantic, true], [note.content, true], [expanded, true],
      [expanded.replace('三本', '九本'), false], [expanded.replace(digest(note.id), digest('foreign_note')), false],
      [expanded.replace('借阅规则', '新增无来源要求'), false]] as const) {
      const payload: VcpMemoryPreparedPayload = { schema: 'worldlinebox.prepared-recall-payload', modelIdentity: 'unused',
        receipt: { messages: [], events: [], contextReferences: [{ id: note.id, role: 'focus_input', textHash: digest(text.trim()) }], contextReferenceCoverage: 'observed' },
        groups: [{ token: 'token', dbNames: ['knowledge'], userContent: 'question', aiContent: null, combinedQueryForDisplay: 'question', promptTemplate: 'fixed',
          config: { model: 'unused', batchSize: 1, maxTokensPerBatch: 100, promptFile: 'unused' }, options: { sourceFiles: [{ name: 'original', content: text }] } }] };
      const handle = await store.save('fixed_scope', payload), verification = client.verifyPreparedCanonicalNotes(handle, [note]);
      if (accepted) await expect(verification).resolves.toBeUndefined();
      else await expect(verification).rejects.toMatchObject({ code: 'VCP_MEMORY_CANONICAL_SOURCE_CHANGED' });
      await store.remove(handle);
    }
  } finally { await client.close(); await store.close(); await removeOwnedDirectory(root); }
});

it('authenticates the actual returned native fragment without a model group or a whole-note hash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-native-returned-'));
  const store = new VcpPreparedRecallStore(root), client = new VcpMemoryClient({ dataRoot: root, vendorRoot: path.resolve('vendor/vcp-memory'),
    workerPath: path.resolve('src/main/vcp-memory/worker.cjs'), embedding: { baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'unused', dimension: 4 } });
  const note: VcpMemoryNote = { id: 'knowledge_one', content: '前文背景。普通读者同时最多借三本，每本十四天。已预约不得续借。',
    tags: ['借阅规则'], occurredAt: '2026-10-28T10:00:00Z', author: 'Alice', diaryName: '知识' };
  const fragment = '普通读者同时最多借三本，每本十四天。';
  try {
    for (const variant of ['valid', 'tampered', 'foreign', 'hash', 'missing', 'unreferenced'] as const) {
      const text = variant === 'tampered' ? fragment.replace('三本', '九本') : fragment;
      const id = variant === 'foreign' ? 'knowledge_foreign' : note.id;
      const textHash = variant === 'hash' ? digest('other text') : digest(text);
      const payload: VcpMemoryPreparedPayload = { schema: 'worldlinebox.prepared-recall-payload', modelIdentity: 'unused', groups: [],
        receipt: { messages: [{ role: 'system', content: fragment }], events: [], contextReferences: [{ id, role: 'returned', textHash }], contextReferenceCoverage: 'observed' },
        ...(variant === 'missing' ? {} : { nativeSources: [{ id: variant === 'unreferenced' ? 'unobserved' : id, text, textHash }] }) };
      const handle = await store.save('fixed_scope', payload), verification = client.verifyPreparedCanonicalNotes(handle, [note]);
      if (variant === 'valid') await expect(verification).resolves.toBeUndefined();
      else await expect(verification).rejects.toHaveProperty('code', variant === 'missing' ? 'VCP_MEMORY_CANONICAL_PROVENANCE_UNAVAILABLE' : 'VCP_MEMORY_CANONICAL_SOURCE_CHANGED');
      await store.remove(handle);
    }
  } finally { await client.close(); await store.close(); await removeOwnedDirectory(root); }
});
