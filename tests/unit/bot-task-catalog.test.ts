import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';
import { buildBotContext } from '../../src/main/companion-bot/context';

const stores: BotStore[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new BotStore(':memory:', { activityBudget: { maxTasks: 200, maxPendingTasks: 200 } }); stores.push(store);
  store.createCompanion({ id: 'catalog-agent', name: 'Catalog agent', persona: 'A protocol fixture.' });
  const conversation = store.openDirect('catalog-agent');
  const source = store.enqueue({ conversationId: conversation.id, senderId: 'user', sourceMessageId: 'catalog-source', content: 'Catalog projection acceptance.' }).events[0]!;
  const create = (id: string, extra: Record<string, unknown> = {}) => store.createTask({ id, conversationId: conversation.id, companionId: 'catalog-agent',
    sourceEventId: source.id, goal: 'G'.repeat(3000) + ' SEARCH_ORIGINAL_TAIL', extra: { title: id, attachmentIds: [], ...extra } });
  return { store, conversation, source, create, runtime: new BotTaskRuntime(store) };
}

it('projects reports and frozen inputs in SQL before crossing the SQLite boundary and keeps full detail explicit', () => {
  const f = fixture(), report = 'R'.repeat(1024 * 1024) + ' FULL_REPORT_TAIL';
  const task = f.create('large-report', { workerPrompt: 'W'.repeat(1024 * 1024), inputFiles: [{ private: 'NOT_CATALOG_DATA' }],
    outputCheckpoint: 71, progress: { phase: 'using-tool', toolName: 'web_fetch', detail: 'Checking a source', updatedAt: new Date().toISOString() } });
  f.store.updateTask(task.id, { summary: report });
  const sql = f.store.taskTransaction(connection => connection), statements = vi.spyOn(sql, 'prepare');
  const fullRead = vi.spyOn(f.store, 'getTask').mockImplementation(() => { throw new Error('Catalog attempted a full task read.'); });
  const context = f.runtime.visibleTasks(f.conversation.id);
  expect(context[0]?.goal).toHaveLength(2000); expect(context[0]?.summary).toHaveLength(2000);
  expect(context[0]?.summaryIsPreview).toBe(true);
  expect(context[0]?.extra).toMatchObject({ title: 'large-report', cancelRequested: false, outputCheckpoint: 71, progress: { phase: 'using-tool', toolName: 'web_fetch' } });
  expect(context[0]?.extra).not.toHaveProperty('workerPrompt'); expect(context[0]?.extra).not.toHaveProperty('inputFiles');
  expect(f.store.taskSourcesWithdrawn(task.id)).toBe(false);
  expect(f.store.taskSourceIds(task.id)).toContain(f.source.sourceMessageRecordId);
  const card = f.runtime.card(context[0]!);
  expect(card.outputs).toEqual([]); expect(card.summaryIsPreview).toBe(true);
  const envelope = JSON.parse(buildBotContext({ companion: f.store.getCompanion('catalog-agent')!, event: f.source, messages: [], tasks: [{ ...card, cancelRequested: false }] }).user);
  expect(envelope.tasks[0]).toMatchObject({ summaryIsPreview: true }); expect(envelope.tasks[0].summary).toHaveLength(2000);
  const stopping = JSON.parse(buildBotContext({ companion: f.store.getCompanion('catalog-agent')!, event: f.source, messages: [], tasks: [{ ...card, cancelRequested: true }] }).user);
  expect(stopping.tasks[0]).toMatchObject({ status: 'cancelled', summaryIsPreview: false, summary: expect.stringContaining('任务已停止') });
  const page = f.runtime.page({ conversationId: f.conversation.id, filter: 'all', query: 'SEARCH_ORIGINAL_TAIL', page: 0, limit: 6 });
  expect(page.total).toBe(1); expect(page.items[0]?.goal).toHaveLength(200); expect(page.items[0]?.summary).toBeUndefined();
  expect(page.items[0]?.cancelRequested).toBe(false); expect(page.items[0]?.continuationAvailable).toBe(false);
  const queries = statements.mock.calls.map(call => call[0]).filter(statement => /\bFROM bot_tasks\b/i.test(statement));
  expect(queries.some(statement => /NULL AS summary/.test(statement))).toBe(true);
  expect(queries.some(statement => /substr\(summary,1,2000\)/.test(statement))).toBe(true);
  expect(queries.some(statement => /length\(summary\)>2000 AS summary_is_preview/.test(statement))).toBe(true);
  expect(queries.every(statement => !/SELECT\s+(?:\*|t\.\*)/i.test(statement))).toBe(true);
  expect(fullRead).not.toHaveBeenCalled(); fullRead.mockRestore();
  expect(f.store.getTask(task.id)?.summary).toBe(report);
  expect(f.store.getTask(task.id)?.extra.workerPrompt).toHaveLength(1024 * 1024);
});

it('exposes recovery diagnostics only on demand with credentials redacted and continuation only while waiting', () => {
  const f = fixture(), task = f.create('diagnostic-task', { outputCheckpoint: 71, retryAttempts: 58, lastRecoveryStage: 'attach',
    lastRecoveryError: 'Host refused sk-live-secret-value; Authorization: Bearer private-bearer-token; apiKey="private-json-key"',
    workerPrompt: 'PRIVATE_TOOL_ARGUMENTS_MUST_NOT_APPEAR' });
  const waiting = f.store.updateTask(task.id, { status: 'waiting' });
  const detail = f.runtime.card(waiting);
  expect(detail.continuationAvailable).toBe(true); expect(detail.diagnostic).toMatchObject({ attempts: 58, stage: 'attach' });
  expect(detail.diagnostic?.message).toContain('[redacted');
  expect(JSON.stringify(detail)).not.toMatch(/live-secret|private-bearer|private-json|PRIVATE_TOOL_ARGUMENTS/);
  expect(f.runtime.card(waiting, false).diagnostic).toBeUndefined();
  const directory = f.runtime.page({ conversationId: f.conversation.id, filter: 'all', page: 0, limit: 6 });
  expect(directory.items[0]?.diagnostic).toBeUndefined();
  const stopping = f.store.updateTask(task.id, { extra: { ...waiting.extra, cancelRequested: true } });
  expect(f.runtime.card(stopping).continuationAvailable).toBe(false);
  const cancelled = f.store.updateTask(task.id, { status: 'cancelled', extra: { ...waiting.extra, cancelRequested: false } });
  expect(f.runtime.card(cancelled).continuationAvailable).toBe(false);
  const legacy = f.create('legacy-extra-shape', { attachmentIds: 'old non-array metadata' });
  expect(f.store.taskSourcesWithdrawn(legacy.id)).toBe(false);
});

it('measures bounded task projection with 48 persisted one MiB reports instead of loading their bodies into catalog results', async () => {
  const f = fixture(), count = 48, report = 'R'.repeat(1024 * 1024);
  for (let index = 0; index < count; index++) {
    const task = f.create(`benchmark-${String(index).padStart(3, '0')}`, { workerPrompt: 'F'.repeat(64000) });
    f.store.updateTask(task.id, { status: 'succeeded', summary: report });
  }
  const baselineStart = performance.now(), full = f.store.listTasks(f.conversation.id, 100), baselineMs = performance.now() - baselineStart;
  const baselineBytes = full.reduce((size, task) => size + Buffer.byteLength(task.summary ?? '') + Buffer.byteLength(String(task.extra.workerPrompt ?? '')), 0);
  const directoryTimes: number[] = [], contextTimes: number[] = []; let directoryBytes = 0, contextBytes = 0;
  const fullRead = vi.spyOn(f.store, 'getTask').mockImplementation(() => { throw new Error('Projection used a full detail fetch.'); });
  for (let iteration = 0; iteration < 5; iteration++) {
    const directoryStart = performance.now(), directory = f.runtime.page({ conversationId: f.conversation.id, filter: 'all', page: 0, limit: 30 });
    directoryTimes.push(performance.now() - directoryStart); directoryBytes = Buffer.byteLength(JSON.stringify(directory));
    const contextStart = performance.now(), context = f.runtime.visibleTasks(f.conversation.id);
    contextTimes.push(performance.now() - contextStart); contextBytes = Buffer.byteLength(JSON.stringify(context));
    expect(context).toHaveLength(count); expect(context.every(task => task.summary?.length === 2000)).toBe(true);
    expect(directory.items).toHaveLength(30); expect(directory.items.every(task => task.summary === undefined)).toBe(true);
  }
  expect(fullRead).not.toHaveBeenCalled();
  expect(directoryBytes).toBeLessThan(40000); expect(contextBytes).toBeLessThan(240000);
  expect(contextBytes / baselineBytes).toBeLessThan(0.01);
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const evidence = { measuredAt: new Date().toISOString(), engine: 'actual SQLite', modelRequests: 0, tasks: count, reportBytesPerTask: report.length,
    fullRead: { elapsedMs: baselineMs, reportAndFrozenInputBytes: baselineBytes },
    directory: { rows: 30, p50Ms: median(directoryTimes), serializedBytes: directoryBytes, fullTaskReads: 0 },
    context: { rows: count, p50Ms: median(contextTimes), serializedBytes: contextBytes, fullTaskReads: 0 },
    interpretation: 'Local projection benchmark, not a network or end-to-end chat latency guarantee.' };
  const artifact = path.resolve('artifacts/superagent-bot-development/task-catalog-projection-benchmark.json');
  await mkdir(path.dirname(artifact), { recursive: true }); await writeFile(artifact, JSON.stringify(evidence, null, 2) + '\n');
});
