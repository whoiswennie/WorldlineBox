import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

// Explicit local profiling: read-only SQLite backup, real model and encoder,
// no changes to the user's live database, files, settings or native VCP cache.
it.skipIf(process.env.WORLDLINEBOX_MEMORY_LATENCY_REAL !== '1')('measures cold and warm active/passive recall on an isolated snapshot of the selected companion library', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-memory-latency-'));
  const output = path.resolve('artifacts/vcp-validation/recall-latency.json');
  const records: Array<Record<string, unknown>> = [], modelCalls: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  let store: CompanionsStore | undefined, native: Awaited<ReturnType<typeof realMemoryRuntime>> | undefined, memory: CompanionMemoryService | undefined;
  const save = async () => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify({ realUserDataModified: false,
    actualEncoder: true, actualChatModel: true, recordedAt: new Date().toISOString(), records, modelCalls, errors }, null, 2)); };
  try {
    const workspace = JSON.parse(await readFile(path.join(process.env.APPDATA!, 'WorldlineBox', 'companion-library.json'), 'utf8'));
    const source = new (Database as { new(file: string, options: { readonly: boolean; fileMustExist: boolean }): { backup(file: string): Promise<unknown>; close(): void } })(path.join(workspace.libraryPath, '.worldlinebox', 'companions', 'messages.sqlite'), { readonly: true, fileMustExist: true });
    try { await source.backup(path.join(root, 'messages.sqlite')); } finally { source.close(); }
    store = new CompanionsStore(path.join(root, 'messages.sqlite'), []);
    const state = store.request({ type: 'state' }).state!;
    const owner = state.companions.find(owner => owner.name === '小肥鱼')!;
    expect(owner).toBeDefined();
    const conversation = store.openPrivate(owner.id);
    const config = await realGlobalChatConfig(root);
    const fetchFn: typeof fetch = async (input, init) => {
      const started = performance.now(), response = await fetch(input, init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      const system = String(body.messages?.[0]?.content ?? '');
      modelCalls.push({ elapsedMs: Math.round(performance.now() - started), status: response.status,
        purpose: /聚焦|focus/iu.test(system) ? 'focus' : /总结|摘要|summary/iu.test(system) ? 'summary' : 'vcp_generation',
        inputChars: JSON.stringify(body.messages ?? []).length });
      await save(); return response;
    };
    native = await realMemoryRuntime(root, undefined, { modelFetch: fetchFn });
    let guarded = false;
    const commandMetrics = new Map<string, { count: number; elapsedMs: number }>();
    const rawRequest = async (command: CompanionStorageCommand) => {
      const started = performance.now();
      try { return store!.request(command); }
      finally { const previous = commandMetrics.get(command.type) ?? { count: 0, elapsedMs: 0 }; previous.count++; previous.elapsedMs += performance.now() - started; commandMetrics.set(command.type, previous); }
    };
    const host = Object.create(CompanionService.prototype) as { call(command: CompanionStorageCommand): Promise<CompanionStorageResponse> };
    Object.assign(host, { storage: { request: rawRequest }, sourceValidationRevision: 0, evidenceRevision: 0,
      options: { report: () => undefined, dsh: () => undefined }, resettingCompanions: new Set() });
    memory = new CompanionMemoryService({ request: command => guarded ? host.call(command) : rawRequest(command), configFor: async () => config,
      runtime: native.runtime, cacheRoot: path.join(root, 'views'), fetchFn, busy: () => true, changed: () => undefined,
      report: error => errors.push(error instanceof Error ? error.name : 'unknown') });
    Object.assign(host, { memory });
    for (const [index, mode] of (['active', 'active', 'passive', 'passive', 'passive', 'passive'] as const).entries()) {
      guarded = index === 5; commandMetrics.clear();
      const started = performance.now(), phases: Array<{ stage: string; elapsedMs: number }> = [];
      const progress = (stage: string) => { const phase = { stage, elapsedMs: Math.round(performance.now() - started) }; phases.push(phase); console.info(JSON.stringify({ run: index, mode, ...phase })); };
      const query = index === 5 ? '上海今天的天气情况' : index === 4 ? '明天上海天气如何' : index === 3 ? '现在上海天气怎么样' : '上海天气';
      const sourceMessage = index >= 3 ? store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: query }) : undefined;
      const recalled = sourceMessage ? await memory.recall({ companion: owner, conversation, currentMessage: sourceMessage,
        messages: store.messages({ conversationId: conversation.id, limit: 30 }).messages, config,
        signal: AbortSignal.timeout(240000), onProgress: progress }) : undefined;
      const result = recalled ? { ok: true, memorySearchTimings: recalled.timings, memoryPage: { items: recalled.memories }, memoryContext: recalled.context }
        : await memory.search({ companionId: owner.id, conversationId: conversation.id, query, limit: 8 }, mode, AbortSignal.timeout(240000), progress);
      records.push({ run: index, mode, guardedMainReads: guarded, storageCommands: Object.fromEntries(commandMetrics), actualChatHistory: index >= 3, elapsedMs: Math.round(performance.now() - started), timings: result.memorySearchTimings,
        candidates: result.memoryPage?.items.length, contextChars: result.memoryContext?.text.length, phases });
      await save(); expect(result.ok).toBe(true);
    }
  } finally {
    await save(); await memory?.close(); await native?.close(); store?.close(); await removeOwnedDirectory(root);
  }
}, 1000000);
