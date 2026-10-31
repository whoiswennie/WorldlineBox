import { expect, it, vi } from 'vitest';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import type { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { VcpMemoryNote, VcpMemoryScope } from '../../src/main/vcp-memory/contracts';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { createCoalescedRefresh } from '../../src/renderer/companions/coalesced-refresh';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

it('keeps pure memory timer ticks on progress reads while a real durable delivery still refreshes message and action content', async () => {
  const f = managedMemoryFiles(), notifications: Array<'progress' | 'content'> = [], report = vi.fn();
  let memory: CompanionMemoryService | undefined, fullPending = false, settled: Promise<void> = Promise.resolve();
  const ui = vi.fn(async (command: CompanionStorageCommand) => f.store.request(command));
  const progress = vi.fn(async () => { await ui({ type: 'work.list', unfinishedOnly: true }); });
  const full = vi.fn(async () => { await Promise.all([
    ui({ type: 'state' }), ui({ type: 'messages', conversationId: f.scope.conversationId }), ui({ type: 'actions', conversationId: f.scope.conversationId }),
  ]); });
  // This is the production renderer's typed-change/coalesced-read contract.
  // The event source below is the actual memory scheduler and SQL outbox.
  const refresh = createCoalescedRefresh(async () => {
    if (!fullPending) { await progress(); return; }
    fullPending = false; await full();
  }, report, 500);
  const changed = (kind?: 'progress') => {
    notifications.push(kind ?? 'content'); if (kind !== 'progress') fullPending = true;
    settled = refresh.trigger();
  };
  const client = { remember: vi.fn(async (_scope: VcpMemoryScope, note: VcpMemoryNote) => ({ id: note.id, indexed: true as const })),
    interruptScope: vi.fn(async () => undefined), purgeScope: vi.fn(async () => undefined) };
  const model = vi.fn(async () => { throw new Error('A physical delivery or timer must not acquire a model.'); });
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    memory = new CompanionMemoryService({ request: async command => f.store.request(command),
      runtime: { get: async () => ({ client: client as unknown as VcpMemoryClient, profileKey: 'controlled-index', release: async () => undefined }), close: async () => undefined },
      // Controlled canonical admission isolates scheduling. Registry/file byte
      // authority is exercised by the separate real-file test suites.
      canonicalDelivery: async note => note, configFor: model, fetchFn: model, busy: () => false, changed, report });
    memory.setAgendaDriven(vi.fn());
    await vi.advanceTimersByTimeAsync(2500); await settled;
    memory.schedule(2000); await vi.advanceTimersByTimeAsync(2500); await settled;
    expect(notifications.length).toBeGreaterThan(2); expect(notifications.every(kind => kind === 'progress')).toBe(true);
    expect(progress).toHaveBeenCalled(); expect(full).not.toHaveBeenCalled();
    expect(ui.mock.calls.every(([command]) => command.type === 'work.list')).toBe(true);

    const source = f.source('真实新资料：雨天携带折叠伞。');
    const note = f.store.request({ type: 'memory.record', ...f.scope, candidate: f.candidate(source.content, [source.id]) }).memories![0]!;
    const beforeActualChange = notifications.length;
    memory.changed(note.companionId);
    expect(notifications[beforeActualChange]).toBe('content');
    await vi.advanceTimersByTimeAsync(500); await settled;
    expect(full).toHaveBeenCalledOnce(); expect(client.remember).not.toHaveBeenCalled();
    memory.schedule(0); await vi.advanceTimersByTimeAsync(500); await memory.drainDeliveries();
    await vi.advanceTimersByTimeAsync(500); await settled;
    expect(client.remember).toHaveBeenCalledOnce(); expect(client.remember.mock.calls[0]![1]).toMatchObject({ id: note.id, content: source.content });
    expect(f.store.request({ type: 'memory.records.filter', ...f.scope, ids: [note.id] }).memories?.[0]?.status).toBe('indexed');
    expect(notifications).toContain('content'); expect(full).toHaveBeenCalled();
    expect(ui.mock.calls.some(([command]) => command.type === 'messages')).toBe(true);
    expect(ui.mock.calls.some(([command]) => command.type === 'actions')).toBe(true);
    expect(model).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled();
  } finally { refresh.dispose(); await memory?.close(); vi.useRealTimers(); await f.close(); }
});
