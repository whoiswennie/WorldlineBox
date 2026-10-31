import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { CompanionAssetIo } from '../../src/main/companions/asset-io';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
const fixture = () => { const value = managedMemoryFiles(); fixtures.push(value); return value; };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-27T10:00:00Z'); });
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); vi.useRealTimers(); });

it('reads exact immutable r1 when r2 differs without returning SQL or creating another memory', async () => {
  const f = fixture(), raw = f.source('正式原始证据。'), first = f.record('任务原本读到的旧正文。', [raw.id]); await f.publish();
  f.store.request({ type: 'memory.revise', ...f.scope, id: first.id, expectedVersion: first.version, candidate: f.candidate('独立修订的当前正文。', [raw.id]) }); f.index(); await f.publish();
  // The public router passes a structurally wider command as scope. Its
  // discriminator must never replace the internal metadata-only command.
  const publicCommand = { type: 'memory.revision.read' as const, ...f.scope, id: first.id, contentRevision: 1 };
  expect((await f.history.read(publicCommand, first.id, 1)).content).toBe(first.content); expect((await f.history.read(f.scope, first.id, 2)).content).toBe('独立修订的当前正文。');
  expect(readFileSync(f.historyFile(first.id, 1), 'utf8')).toContain('worldlinebox.companion-memory-history-v2');
  const before = f.store.listMemory('alice').length; await f.library.sync(); expect(f.store.listMemory('alice')).toHaveLength(before);
  await expect(f.history.read({ companionId: 'bob', conversationId: f.store.openPrivate('bob').id }, first.id, 1)).rejects.toThrow();
  expect(() => f.store.request({ type: 'memory.revision.read', ...f.scope, id: first.id, contentRevision: 1 })).toThrow('文件');
});
it.each(['remove', 'edit', 'hardlink'] as const)('never reconstructs delivered history after %s, including restart', async mode => {
  const f = fixture(), note = f.record('历史不能从SQL重造。'); await f.publish(); const target = f.historyFile(note.id, 1);
  if (mode === 'remove') unlinkSync(target); else if (mode === 'edit') writeFileSync(target, '未知外部历史。'); else linkSync(target, path.join(f.root, 'foreign-link.md'));
  f.restart(); expect(await f.history.flush('alice')).toMatchObject({ completed: 0 }); await expect(f.history.read(f.scope, note.id, 1)).rejects.toThrow();
  if (mode === 'remove') expect(existsSync(target)).toBe(false); if (mode === 'edit') expect(readFileSync(target, 'utf8')).toBe('未知外部历史。');
});
it('recovers an acknowledged registry history but unfinished durable memory job without rewriting history', async () => {
  const f = fixture(), note = f.record('正式发布后、当前正文前崩溃。'); await f.sources.flush('alice');
  const crashing = new CompanionMemoryHistoryFiles({ library: f.library, afterPublish: async () => { throw new Error('CRASH_AFTER_REGISTRY_HISTORY'); } });
  expect(await crashing.flush('alice')).toMatchObject({ failed: 1, completed: 0 });
  const registry = await f.artifacts('alice'), artifact = await registry.get(`history:${note.id}:r1`); expect(artifact).toBeDefined(); expect(await registry.get(`memory:${note.id}`)).toBeUndefined();
  f.restart(); vi.setSystemTime(Date.now() + 31_000); await f.history.flush('alice');
  expect((await registry.get(`history:${note.id}:r1`))?.contentRevision).toBe(1); expect((await f.live.materialize('alice', [note])).notes[0]!.content).toBe(note.content);
});
it('preserves lawful B-only r1 after withdrawal of a later A+B revision and rejects a late revoked publication', async () => {
  const f = fixture(), b = f.source('B仍合法。'), a = f.source('A可能撤回。'), first = f.record('r1仅依据B。', [b.id]); await f.publish();
  f.store.request({ type: 'memory.revise', ...f.scope, id: first.id, expectedVersion: first.version, candidate: f.candidate('r2依据A与B。', [a.id, b.id]) }); f.index(); await f.publish();
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [a.id] }); await f.sources.flush('alice'); await f.history.flush('alice');
  expect((await f.history.read(f.scope, first.id, 1)).content).toBe(first.content); await expect(f.history.read(f.scope, first.id, 2)).rejects.toThrow();
  const c = f.source('C将撤回。'), late = f.record('不允许迟到复活。', [c.id]); await f.sources.flush('alice');
  f.intercept(command => { if (command.type === 'memory.history.outbox.complete' && command.id) { f.intercept(); f.store.request({ type: 'memory.forget', ...f.scope, id: late.id }); } });
  await f.history.flush('alice'); await expect(f.history.read(f.scope, late.id, 1)).rejects.toThrow();
});
it('memoizes a shared immutable DAG dependency and drains the actual registry publication at shutdown', async () => {
  const f = fixture(), base = f.record('共享根。'), left = f.record('左。', undefined, [base.id]), right = f.record('右。', undefined, [base.id]), top = f.record('顶。', undefined, [left.id, right.id]); await f.publish(); f.commands.length = 0;
  await f.history.read(f.scope, top.id, 1); expect(f.commands.filter(command => command.type === 'memory.revision.describe' && command.id === base.id)).toHaveLength(2);
  const next = f.record('关闭等待真实发布。'); await f.sources.flush('alice'); let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), arrived = new Promise<void>(resolve => { reached = resolve; });
  const files = new CompanionMemoryHistoryFiles({ library: f.library, afterPublish: async () => { reached(); await gate; } }), io = new CompanionAssetIo();
  const publishing = io.run(() => files.flush('alice')); await arrived; let closed = false; const closing = io.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
  release(); await publishing; await closing; expect(closed).toBe(true); expect((await f.history.read(f.scope, next.id, 1)).content).toBe(next.content);
});
it('does not turn a read of unpublished SQL history into a filesystem publication', async () => {
  const f = fixture(), note = f.record('尚未发布。'); await f.sources.flush('alice'); f.commands.length = 0;
  await expect(f.history.read(f.scope, note.id, 1)).rejects.toThrow(); expect(f.commands.some(command => command.type === 'memory.history.outbox.claim')).toBe(false);
  expect(await (await f.artifacts('alice')).get(`history:${note.id}:r1`)).toBeUndefined();
});
