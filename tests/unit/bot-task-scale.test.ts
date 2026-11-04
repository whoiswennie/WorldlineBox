import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';
import { clearBotTaskHistory } from '../../src/main/companion-bot/task-history';

it('keeps a 10,000-record task history out of paged UI and router payloads', async () => {
  const store = new BotStore(':memory:');
  try {
    store.createCompanion({ id: 'scale-agent', name: '规模夹具', persona: 'Human-authored scale fixture.' });
    const room = store.openDirect('scale-agent');
    const source = store.enqueue({ conversationId: room.id, senderId: 'user', sourceMessageId: 'scale-source', content: 'Task history scale fixture.' }).events[0]!;
    const count = 10000, report = 'REPORT_BODY_NOT_FOR_DIRECTORY_'.padEnd(4096, 'r'), frozen = 'FROZEN_INPUT_NOT_FOR_DIRECTORY_'.padEnd(8192, 'f');
    const seededAt = performance.now();
    // This is explicitly synthetic history, inserted in one real SQLite
    // transaction. No model, native execution or admission throughput is claimed.
    store.taskTransaction(sql => {
      const insert = sql.prepare('INSERT INTO bot_tasks(id,conversation_id,companion_id,source_event_id,goal,status,attempt_id,summary,created_at,updated_at,extra_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for (let index = 0; index < count; index++) {
        const id = `scale-${String(index).padStart(5, '0')}`, time = new Date(1700000000000 + index).toISOString();
        insert.run(id, room.id, 'scale-agent', source.id, `已结束的合成任务 ${index}`, 'succeeded', `attempt-${id}`, report, time, time,
          JSON.stringify({ title: `合成历史任务 ${index}`, workerPrompt: frozen }));
      }
    });
    const seedMs = performance.now() - seededAt, runtime = new BotTaskRuntime(store), fullRead = vi.spyOn(store, 'getTask');
    const elapsed: number[] = []; let serializedBytes = 0;
    for (const page of [0, 10, 100, 333, 0]) {
      const start = performance.now(), result = runtime.page({ conversationId: room.id, filter: 'all', page, limit: 30 });
      elapsed.push(performance.now() - start);
      expect(result.total).toBe(count); expect(result.items.length).toBeLessThanOrEqual(30);
      const json = JSON.stringify(result); serializedBytes = Math.max(serializedBytes, Buffer.byteLength(json));
      expect(json).not.toContain('REPORT_BODY_NOT_FOR_DIRECTORY'); expect(json).not.toContain('FROZEN_INPUT_NOT_FOR_DIRECTORY');
    }
    const start = performance.now(), context = runtime.visibleTasks(room.id), contextMs = performance.now() - start;
    expect(context).toHaveLength(100); expect(JSON.stringify(context)).not.toContain('FROZEN_INPUT_NOT_FOR_DIRECTORY');
    expect(fullRead).not.toHaveBeenCalled(); fullRead.mockRestore();
    const queryStart = performance.now(), searched = runtime.page({ conversationId: room.id, filter: 'all', query: '9999', page: 0, limit: 30 });
    expect(searched.total).toBe(1);
    const searchMs = performance.now() - queryStart;
    const pending = store.createTask({ id: 'scale-still-active', conversationId: room.id, companionId: 'scale-agent', sourceEventId: source.id, goal: '进行中的任务不会被历史清理删除' });
    const bytes = () => store.taskTransaction(sql => Number((sql.prepare('SELECT SUM(length(goal)+COALESCE(length(summary),0)+length(extra_json)) AS n FROM bot_tasks').get() as { n: number }).n));
    const payloadBefore = bytes(); let lastTick = performance.now(), ticks = 0, largestGap = 0;
    const timer = setInterval(() => { const now = performance.now(); largestGap = Math.max(largestGap, now - lastTick); lastTick = now; ticks++; }, 1);
    const clearStart = performance.now();
    let cleared;
    try { cleared = await clearBotTaskHistory(store, { conversationId: room.id, requestId: 'scale-clear-ended' }); }
    finally { clearInterval(timer); }
    const clearMs = performance.now() - clearStart, payloadAfter = bytes();
    expect(cleared).toEqual({ cleared: count, remaining: 1, recordsOnly: true }); expect(ticks).toBeGreaterThan(0);
    expect(payloadAfter).toBeLessThan(payloadBefore * .1);
    const after = runtime.page({ conversationId: room.id, filter: 'all', page: 333, limit: 30 });
    expect(after.total).toBe(1); expect(after.page).toBe(0); expect(after.items.map(item => item.id)).toEqual([pending.id]);
    expect(runtime.visibleTasks(room.id).map(item => item.id)).toEqual([pending.id]);
    const evidence = { at: new Date().toISOString(), engine: 'actual SQLite in-memory database', syntheticRecords: count,
      reportBytesPerRecord: report.length, frozenInputBytesPerRecord: frozen.length, seedMs,
      page: { limit: 30, maximumReturned: 30, maximumSerializedBytes: serializedBytes, p50Ms: [...elapsed].sort((a, b) => a - b)[2], elapsedMs: elapsed },
      context: { rows: context.length, elapsedMs: contextMs, serializedBytes: Buffer.byteLength(JSON.stringify(context)) },
      searchMs, cleanup: { cleared: cleared.cleared, elapsedMs: clearMs, eventLoopTicks: ticks, maximumObservedEventLoopGapMs: largestGap,
        payloadCharactersBefore: payloadBefore, payloadCharactersAfter: payloadAfter, activeTaskPreserved: true, lastPageReturnedToFirst: true },
      fullDetailReads: 0, modelRequests: 0,
      scope: 'SQL projection and bounded transport; not disk throughput, renderer frame-rate, or production latency guarantee.' };
    const target = path.resolve('artifacts/superagent-bot-development/task-history-scale.json');
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(evidence, null, 2));
  } finally { store.close(); }
}, 30000);
