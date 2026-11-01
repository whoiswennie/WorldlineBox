import path from 'node:path';
import { createRequire } from 'node:module';
import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionMemory } from '../../src/shared/companions';
import { canonicalProjectionInputs } from '../../src/main/companions/canonical-projection-inputs';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { validateFreshCompanionRecallInputs } from '../../src/main/companions/memory-history-descriptor-witness';
import { createCompanionExecutionValidationSession, memoCompanionExecutionAdmission, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import type { VcpMemoryFocusOptions, VcpMemoryPluginConfiguration, VcpMemoryPreparedPayload, VcpMemoryPreprocessResult } from '../../src/main/vcp-memory/contracts';

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
async function fixture() {
  const f = managedMemoryFiles(), source = f.source('准确的原始来源。'), base = f.record('原本准确的事实。', [source.id]), child = f.record('依赖原本准确事实的后续。', [source.id], [base.id]);
  await f.publish(); f.commands.length = 0;
  const read = (notes: readonly CompanionMemory[], scope: Scope = f.scope, optimized = true) => f.library.withDocuments(scope.companionId,
    session => f.history.readManyInSession(session, scope, notes.map(note => ({ id: note.id, contentRevision: note.contentRevision! })),
      optimized ? { projectionInputs: true } : undefined), { readOnly: true, sourceDelivery: true });
  const describe = () => f.commands.flatMap(command => command.type === 'memory.revisions.describe' ? [{
    room: command.conversationId, cursor: command.beforeSequence, roots: command.roots.map(root => root.id).sort(),
  }] : []);
  const sql = (operation: (db: CompanionConnection) => void) => {
    const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
    try { operation(db); } finally { db.close(); }
  };
  return { f, source, base, child, read, describe, sql };
}

it('shares only exact projection-input descriptors across new sessions and finally verifies the consumed dependency union', async () => {
  const h = await fixture();
  try {
    await withCompanionExecutionValidation(async () => {
      expect((await h.read([h.base]))[0]!.content).toBe(h.base.content);
      expect((await h.read([h.child, h.base]))[0]!.content).toBe(h.child.content);
      await h.read([h.base, h.child]);
      expect(h.describe().map(call => call.roots)).toEqual([[h.base.id], [h.child.id]]);
    });
    expect(h.describe().map(call => call.roots)).toEqual([[h.base.id], [h.child.id], [h.base.id, h.child.id].sort()]);
    h.f.commands.length = 0;
    await h.read([h.base]); expect(h.describe()).toHaveLength(2); // A new task opens both sides afresh.
    h.f.commands.length = 0;
    await withCompanionExecutionValidation(async () => { await h.read([h.base], h.f.scope, false); await h.read([h.base], h.f.scope, false); });
    expect(h.describe()).toHaveLength(4); // Generic history preserves its original paired metadata reads.
  } finally { await h.f.close(); }
});

it('keeps entrances, cursors and owning ports distinct and rejects a foreign owner', async () => {
  const h = await fixture();
  const other = new CompanionMemoryLibrary({ libraryDirectory: h.f.directory, artifacts: h.f.artifacts, request: async command => h.f.request(command) });
  try {
    const second = h.f.store.createConversation('another entrance', ['alice']);
    await withCompanionExecutionValidation(async () => {
      await h.read([h.base]);
      await h.read([h.base], { ...h.f.scope, beforeSequence: h.source.sequence });
      await h.read([h.base], { companionId: 'alice', conversationId: second.id });
      await other.withDocuments('alice', session => h.f.history.readManyInSession(session, h.f.scope,
        [{ id: h.base.id, contentRevision: h.base.contentRevision! }], { projectionInputs: true }), { readOnly: true });
      expect(h.describe()).toHaveLength(4);
    });
    expect(h.describe()).toHaveLength(8);
    await expect(h.read([h.base], { companionId: 'bob', conversationId: h.f.store.openPrivate('bob').id })).rejects.toThrow();
  } finally { await other.close(); await h.f.close(); }
});

it.each(['forget', 'membership', 'history_sources', 'same_stat_bytes'] as const)('keeps the projection history final fence for %s', async change => {
  const h = await fixture(); let admitted = false;
  try {
    await expect(withCompanionExecutionValidation(async () => {
      await h.read([h.child]); admitted = true;
      if (change === 'forget') h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [h.source.id] });
      if (change === 'membership') h.sql(db => db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(h.f.scope.conversationId, 'alice'));
      if (change === 'history_sources') h.sql(db => db.prepare("UPDATE companion_memory_history_files SET sources=json_set(sources,'$[0].checksum',?) WHERE note_id=?")
        .run('0'.repeat(64), h.base.id));
      if (change === 'same_stat_bytes') {
        const file = h.f.historyFile(h.base.id, 1), before = await stat(file), original = await readFile(file, 'utf8');
        await writeFile(file, original.replace('准确的事实', '篡改的事实')); await utimes(file, before.atime, before.mtime);
      }
    })).rejects.toThrow();
    expect(admitted).toBe(true);
  } finally { await h.f.close(); }
});

it('preserves an accurate old version across an ordinary revision and never consumes an unread sibling', async () => {
  const h = await fixture();
  try {
    await withCompanionExecutionValidation(async () => {
      await h.read([h.base]);
      h.f.store.request({ type: 'memory.revise', ...h.f.scope, id: h.base.id, expectedVersion: h.base.version,
        candidate: h.f.candidate('属于下一个任务的新事实。', [h.source.id]) });
      h.f.index();
      expect((await h.read([h.base]))[0]!.content).toBe(h.base.content);
    });
    expect(h.describe().every(call => call.roots.length === 1 && call.roots[0] === h.base.id)).toBe(true);
  } finally { await h.f.close(); }
});

it('rechecks SQL after external-asset final work and retains cancellation between tasks', async () => {
  const h = await fixture(), controller = new AbortController(), session = createCompanionExecutionValidationSession(controller.signal);
  try {
    await expect(withCompanionExecutionValidation(async () => {
      await h.read([h.base]);
      await memoCompanionExecutionAdmission('external-final', { identity: {}, read: async () => true, cacheable: () => true,
        verify: async () => h.sql(db => db.prepare("UPDATE companion_memory_history_files SET state='retracted' WHERE note_id=?").run(h.base.id)) });
    })).rejects.toThrow();
    controller.abort(); await expect(session.run(() => h.read([h.child]))).rejects.toMatchObject({ name: 'AbortError' });
  } finally { session.close(); await h.f.close(); }
});

it('uses a fresh projection input fence before the real upstream focusing transport can send HTTP', async () => {
  const h = await fixture();
  const load = createRequire(path.resolve('package.json'));
  const { focusPreparedRecall, modelIdentity } = load(path.resolve('src/main/vcp-memory/prepared-focus.cjs')) as {
    focusPreparedRecall(payload: VcpMemoryPreparedPayload, configuration: { vendorRoot: string; chat: VcpMemoryPluginConfiguration['chat'] }, options?: VcpMemoryFocusOptions): Promise<VcpMemoryPreprocessResult>;
    modelIdentity(chat: VcpMemoryPluginConfiguration['chat']): string;
  };
  const chat = { baseUrl: 'http://127.0.0.1/not-used', apiKey: 'fixture', model: 'controlled-focus' }, fetchFn = vi.fn();
  try {
    const token = 'WORLDLINE_PREPARED_FOCUS_' + 'a'.repeat(32);
    const payload: VcpMemoryPreparedPayload = { schema: 'worldlinebox.prepared-recall-payload', modelIdentity: modelIdentity(chat),
      receipt: { messages: [{ role: 'system', content: token }], events: [] },
      groups: [{ token, dbNames: ['alice'], userContent: '准确事实是什么？', aiContent: null, combinedQueryForDisplay: 'query',
        promptTemplate: '{{knowledge_base}} {{current_user_prompt}}', config: { model: chat.model, batchSize: 2, maxTokensPerBatch: 18000, promptFile: 'AIMemoPrompt.txt' },
        options: { sourceFiles: [{ name: 'actual-note', dbName: 'alice', content: h.base.content, tokens: 20, score: .9 }] } }] };
    await expect(withCompanionExecutionValidation(async () => {
      await h.read([h.base]);
      const file = h.f.historyFile(h.base.id, 1), before = await stat(file), original = await readFile(file, 'utf8');
      await writeFile(file, original.replace('准确的事实', '篡改的事实')); await utimes(file, before.atime, before.mtime);
      await focusPreparedRecall(payload, { vendorRoot: path.resolve('vendor/vcp-memory'), chat }, { fetchFn,
        validate: reason => reason === 'model_admission' ? validateFreshCompanionRecallInputs(async () => { await h.read([h.base]); }) : Promise.resolve() });
    })).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  } finally { await h.f.close(); }
});

it('canonical projection inputs retain physical prose while sharing only SQL descriptors', async () => {
  const h = await fixture();
  try {
    const expected = h.f.store.request({ type: 'memory.projection.state', ...h.f.scope }).memoryProjectionState!;
    const metadata = h.f.store.request({ type: 'memory.projection.page', ...h.f.scope, expected, limit: 100 }).memoryProjectionPage!.notes;
    h.f.commands.length = 0;
    await withCompanionExecutionValidation(async () => {
      const first = await canonicalProjectionInputs(h.f.history, h.f.scope, metadata, h.f.library);
      const second = await canonicalProjectionInputs(h.f.history, h.f.scope, metadata, h.f.library);
      expect(first.map(note => note.content)).toEqual(second.map(note => note.content));
      expect(first.find(note => note.id === h.base.id)?.content).toBe(h.base.content);
      expect(h.describe()).toHaveLength(1);
    });
    expect(h.describe()).toHaveLength(2);
  } finally { await h.f.close(); }
});
