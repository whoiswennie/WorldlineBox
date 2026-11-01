import { createHash } from 'node:crypto';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionLoopCheckpoint, CompanionWork } from '../../src/shared/companion-loop';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import { executionMessageReadsetKey } from '../../src/companions/execution-source-access';
import { companionReplyElapsedMs } from '../../src/shared/companion-reply-progress';
import { createCompanionExecutionValidationSession, guardCompanionExecutionSources } from '../../src/main/companions/source-execution-evidence';
import { saveCompanionReplyProcessFinish } from '../../src/main/companions/reply-process-finish';
import { companionStorageCommandSchema } from '../../src/shared/companion-storage';
import { companionsRequestSchema } from '../../src/shared/companions';
import { companionExecutionSourceReadOnly } from '../../src/main/companions/source-execution-evidence';
import { companionStorageDispatchPolicy, companionStorageSettlement } from '../../src/main/companions/storage-dispatch-queue';

const begin = '2026-10-01T00:00:00.000Z', liveAt = '2026-10-01T00:00:05.000Z', endAt = '2026-10-01T00:00:15.000Z';
it('keeps progress termination host-private, body-neutral and ordered as a settlement write', () => {
  const command = companionStorageCommandSchema.parse({ type: 'loop.progress.finish', companionId: 'alice', conversationId: 'room', sourceMessageId: 'source',
    progress: { revision: 2, phase: 'interrupted', detail: '当前进程已结束', startedAt: begin, updatedAt: endAt, finishedAt: endAt } });
  expect(companionsRequestSchema.safeParse(command).success).toBe(false);
  expect(companionExecutionSourceReadOnly(command)).toBe(true);
  expect(companionStorageSettlement(command)).toBe(true);
  expect(companionStorageDispatchPolicy(command)).toEqual({ kind: 'writeBarrier', pipelineable: false });
});
async function fixture() {
  const f = managedMemoryFiles(), source = f.source('一个普通的本地任务。');
  const work: CompanionWork = { id: 'process_work', ...f.scope, sourceMessageId: source.id, status: 'queued', proactive: false, createdAt: begin, updatedAt: begin };
  f.store.request({ type: 'work.enqueue', work }); f.store.request({ type: 'work.status', id: work.id, status: 'running' });
  const checkpoint = f.store.request({ type: 'loop.get', companionId: f.scope.companionId, sourceMessageId: source.id }).loop!;
  checkpoint.status = 'done'; checkpoint.turns = [{ text: '这条历史正文已经正式发布。', rawText: '这条历史正文已经正式发布。', calls: [] }];
  checkpoint.progress = { ...checkpoint.progress!, workId: work.id, sourceMessageId: source.id, revision: 5, phase: 'streaming', detail: '正在输出回复',
    startedAt: begin, updatedAt: liveAt, timing: { elapsedMs: 2000, activeSince: liveAt } };
  const executionReadset: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, ...f.scope,
    sources: [{ id: source.id, conversationId: source.conversationId, checksum: createHash('sha256').update(source.content).digest('hex') }],
    memories: [], contexts: [], frozenMemories: [], knowledgeReads: [], topics: [] };
  f.store.request({ type: 'loop.save', checkpoint, executionReadset });
  const proof = f.store.request({ type: 'execution.sources', sourceMessageIds: [checkpoint.messageId!] }).executionSources!.find(value => value.id === checkpoint.messageId)!;
  expect(proof.publicationCandidate).toBeDefined();
  f.store.request({ type: 'execution.message.certify', messages: [{ ...proof.publicationCandidate!, mode: 'new_publication' }] });
  const db = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
  const loopKey = `loop/${source.id}/${f.scope.companionId}`, bubbleKey = 'message-loop/' + checkpoint.messageId;
  const saved = () => f.store.request({ type: 'loop.get', companionId: f.scope.companionId, sourceMessageId: source.id }).loop!;
  const immutable = () => ({
    message: db.prepare('SELECT * FROM messages WHERE id=?').get(checkpoint.messageId!),
    readset: db.prepare("SELECT value FROM metadata WHERE key=?").get(executionMessageReadsetKey(checkpoint.messageId!)),
    certificates: db.prepare('SELECT * FROM companion_message_publication_certificates WHERE message_id=?').all(checkpoint.messageId!),
    pins: db.prepare('SELECT * FROM companion_message_publication_action_pins WHERE message_id=?').all(checkpoint.messageId!),
    // Keep every stored checkpoint field except process presentation exact.
    loops: [loopKey, bubbleKey].map(key => db.prepare("SELECT json_remove(value,'$.progress') AS value FROM metadata WHERE key=?").get(key)) });
  const injectLegacyActive = () => {
    // Simulates a historical application version in this isolated temp SQL only.
    const progress = checkpoint.progress!;
    for (const key of [loopKey, bubbleKey]) db.prepare("UPDATE metadata SET value=json_set(value,'$.progress',json(?)) WHERE key=?").run(JSON.stringify(progress), key);
  };
  return { f, db, work, checkpoint, saved, immutable, injectLegacyActive,
    close: async () => { db.close(); await f.close(); } };
}

it('saves actual terminal process progress after the body frame closes without republishing a done checkpoint', async () => {
  const h = await fixture();
  try {
    const before = h.immutable(), recordedElapsed = h.saved().progress!.timing!.elapsedMs, frame = createCompanionExecutionValidationSession();
    const request = async (command: Parameters<typeof h.f.request>[0]) => guardCompanionExecutionSources(command, h.f.store.request(command), {
      storage: h.f.request, valid: async () => { throw new Error('progress control must not traverse body proofs'); } });
    const checkpoint: CompanionLoopCheckpoint = { ...h.saved(), progress: { ...h.saved().progress!, revision: 6, phase: 'completed', detail: '回复已完成',
      updatedAt: endAt, finishedAt: endAt } };
    h.f.commands.length = 0;
    await frame.run(async () => { frame.close(); await saveCompanionReplyProcessFinish(checkpoint, request); });
    const progress = h.saved().progress!;
    expect(progress.phase).toBe('completed'); expect(progress.finishedAt).toBe(endAt);
    expect(progress.timing?.activeSince).toBeUndefined(); expect(progress.timingIncomplete).toBeUndefined();
    expect(companionReplyElapsedMs(progress, Date.parse('2028-01-01T00:00:00Z'))).toBe(recordedElapsed + 10000);
    expect(h.immutable()).toEqual(before);
    expect(h.f.commands.some(command => ['execution.message.certify', 'execution.sources', 'loop.save'].includes(command.type))).toBe(false);
    await expect(saveCompanionReplyProcessFinish({ ...checkpoint, progress: { ...checkpoint.progress!, revision: 7, phase: 'failed' } }, h.f.request))
      .rejects.toThrow('已有终态');
    expect(h.saved().progress).toEqual(progress);
    const old = { ...h.saved(), progress: { ...h.checkpoint.progress!, revision: 100 } };
    h.f.store.request({ type: 'loop.save', checkpoint: old }); expect(h.saved().progress).toEqual(progress);
  } finally { await h.close(); }
});

it.each(['interrupted', 'cancelled', 'done'] as const)('reconciles legacy %s work with active progress without inventing a finish time or replaying anything', async status => {
  const h = await fixture();
  try {
    h.f.store.request({ type: 'work.status', id: h.work.id, status }); h.injectLegacyActive();
    const before = h.immutable(), workBefore = h.db.prepare('SELECT * FROM companion_work_queue WHERE id=?').get(h.work.id);
    h.f.store.request({ type: 'work.interrupt-running' });
    const progress = h.saved().progress!;
    expect(progress.phase).toBe(status === 'done' ? 'completed' : status);
    expect(progress.finishedAt).toBeUndefined(); expect(progress.timingIncomplete).toBe(true);
    expect(progress.timing).toEqual({ elapsedMs: 2000 });
    expect(companionReplyElapsedMs(progress, Date.parse('2029-01-01T00:00:00Z'))).toBe(2000);
    expect(h.immutable()).toEqual(before); expect(h.db.prepare('SELECT * FROM companion_work_queue WHERE id=?').get(h.work.id)).toEqual(workBefore);
    h.f.store.request({ type: 'work.interrupt-running' }); expect(h.saved().progress).toEqual(progress);
  } finally { await h.close(); }
});

it('does not resume a published checkpoint whose old process was still marked running', async () => {
  const h = await fixture();
  try {
    const before = h.immutable(); h.f.store.request({ type: 'work.interrupt-running' });
    const work = h.f.store.request({ type: 'work.get', id: h.work.id, companionId: h.work.companionId }).work!;
    expect(work.status).toBe('interrupted'); expect(work.resumeOnRestart).toBeUndefined();
    expect(h.saved().progress?.phase).toBe('interrupted'); expect(h.immutable()).toEqual(before);
  } finally { await h.close(); }
});

it('rejects wrong task bindings and preserves a user stop against a later completed receipt', async () => {
  const h = await fixture();
  try {
    const terminal = { ...h.saved(), progress: { ...h.saved().progress!, revision: 6, phase: 'completed' as const,
      detail: '完成', updatedAt: endAt, finishedAt: endAt } };
    await expect(saveCompanionReplyProcessFinish({ ...terminal, conversationId: 'different_room' }, h.f.request)).rejects.toThrow('不属于');
    const cancelled = { ...terminal, progress: { ...terminal.progress, phase: 'cancelled' as const,
      stop: { actor: 'user' as const, reason: 'user_requested' as const, requestedAt: endAt } } };
    await saveCompanionReplyProcessFinish(cancelled, h.f.request);
    await expect(saveCompanionReplyProcessFinish({ ...terminal, progress: { ...terminal.progress, revision: 7 } }, h.f.request)).rejects.toThrow('用户已停止');
    expect(h.saved().progress?.phase).toBe('cancelled');
  } finally { await h.close(); }
});
