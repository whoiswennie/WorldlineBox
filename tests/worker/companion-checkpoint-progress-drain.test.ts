import { expect, it } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { createCompanionCheckpointProgressDrain } from '../../src/main/companions/checkpoint-progress-drain';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

it('preserves actual committed tool receipts and the SQL cancellation fence when a held old progress write settles late', async () => {
  const f = managedMemoryFiles();
  try {
    const source = f.source('这项任务随后由用户明确停止。');
    const bubble = f.store.appendMessage({ conversationId: source.conversationId, authorId: 'alice', content: '', loopStep: 0, replyToId: source.id });
    const checkpoint: CompanionLoopCheckpoint = { ...f.scope, sourceMessageId: source.id, messageId: bubble.id, status: 'running', turns: [], supplements: [],
      progress: { revision: 1, phase: 'memory', detail: '正在读取已授权来源', startedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' } };
    f.store.request({ type: 'loop.save', checkpoint });
    const held = deferred(), entered = deferred(), errors: unknown[] = []; let writes = 0;
    const drain = createCompanionCheckpointProgressDrain(async () => {
      const payload = structuredClone(checkpoint);
      if (++writes === 1) { entered.resolve(); await held.promise; }
      f.store.request({ type: 'loop.save', checkpoint: payload });
    }, error => errors.push(error));
    drain.request(); await entered.promise;
    const note = f.record('用户停止之前已经正式写入的事实。', [source.id]);
    checkpoint.turns.push({ text: '', rawText: '', calls: [{ id: 'committed_record', name: 'memory.record', arguments: '{}' }],
      results: [{ callId: 'committed_record', content: JSON.stringify({ ok: true, memories: [note] }) }] });
    checkpoint.progress = { ...checkpoint.progress!, revision: 2, phase: 'tools', detail: '实际记忆写入已经提交', updatedAt: '2026-11-01T00:00:01.000Z' };
    drain.request();
    checkpoint.progress = { ...checkpoint.progress, revision: 3, phase: 'cancelled', detail: '用户已停止', updatedAt: '2026-11-01T00:00:02.000Z',
      finishedAt: '2026-11-01T00:00:02.000Z', stop: { actor: 'user', reason: 'user_requested', requestedAt: '2026-11-01T00:00:02.000Z' } };
    // The host's immediate cancellation boundary remains authoritative. The
    // in-flight older write is deliberately allowed to arrive after it.
    f.store.request({ type: 'loop.save', checkpoint }); drain.request();
    held.resolve(); await drain.drain();
    const saved = f.store.request({ type: 'loop.get', companionId: f.scope.companionId, sourceMessageId: source.id }).loop!;
    expect(writes).toBe(2); expect(errors).toEqual([]); expect(saved.progress?.phase).toBe('cancelled');
    expect(saved.progress?.stop).toEqual(checkpoint.progress.stop); expect(saved.turns).toEqual(checkpoint.turns);
    expect(f.store.request({ type: 'memory.read', ...f.scope, id: note.id }).memoryRead?.memory.content).toBe(note.content);
    expect(() => f.store.request({ type: 'loop.save', checkpoint: { ...checkpoint, status: 'done' } })).toThrow('用户已停止');
  } finally { await f.close(); }
});
