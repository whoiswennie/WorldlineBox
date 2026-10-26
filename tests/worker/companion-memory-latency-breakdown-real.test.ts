import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

// Opt-in diagnosis on a read-only backup. Results contain only counts/timings.
// The short header latency of a streaming response is NOT generation latency.
it.skipIf(process.env.WORLDLINEBOX_MEMORY_LATENCY_BREAKDOWN_REAL !== '1')('separates real native retrieval, encoding, view rebuilds and complete model responses', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-recall-breakdown-'));
  const prepareBeforeQuery = process.env.WORLDLINEBOX_MEMORY_LATENCY_PREPARE === '1';
  const output = path.resolve(`artifacts/vcp-validation/recall-latency-breakdown${prepareBeforeQuery ? '-prepared' : ''}${process.env.WORLDLINEBOX_MEMORY_LATENCY_CONTEXT_FIX === '1' ? '-context-fix' : ''}.json`);
  const events: Array<Record<string, unknown>> = [], records: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const backgroundScheduling = process.env.WORLDLINEBOX_MEMORY_LATENCY_BACKGROUND === '1';
  let run = 'setup', store: CompanionsStore | undefined;
  let native: Awaited<ReturnType<typeof realMemoryRuntime>> | undefined, memory: CompanionMemoryService | undefined;
  const epoch = performance.now();
  const emit = (event: Record<string, unknown>) => events.push({ run, atMs: Math.round(performance.now() - epoch), ...event });
  const save = async () => {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ recordedAt: new Date().toISOString(), realUserDataModified: false,
      actualEncoder: true, actualChatModel: true, backgroundScheduling, prepareBeforeQuery, records, events, errors }, null, 2));
  };
  const originalRequest = (VcpMemoryClient.prototype as unknown as { request: (...args: unknown[]) => Promise<unknown> }).request;
  const requestSpy = vi.spyOn(VcpMemoryClient.prototype as unknown as { request: (...args: unknown[]) => Promise<unknown> }, 'request')
    .mockImplementation(async function (this: VcpMemoryClient, ...args: unknown[]) {
      const started = performance.now();
      const command = args[1] as { type: string; notes?: unknown[] };
      try { return await originalRequest.apply(this, args); }
      finally { emit({ kind: 'client', operation: command.type, elapsedMs: performance.now() - started,
        ...(command.notes ? { notes: command.notes.length } : {}) }); }
    });
  try {
    const workspace = JSON.parse(await readFile(path.join(process.env.APPDATA!, 'WorldlineBox', 'companion-library.json'), 'utf8'));
    const source = new (Database as { new(file: string, options: { readonly: boolean; fileMustExist: boolean }): { backup(file: string): Promise<unknown>; close(): void } })(path.join(workspace.libraryPath, '.worldlinebox', 'companions', 'messages.sqlite'), { readonly: true, fileMustExist: true });
    try { await source.backup(path.join(root, 'messages.sqlite')); } finally { source.close(); }
    store = new CompanionsStore(path.join(root, 'messages.sqlite'), []);
    const owner = store.request({ type: 'state' }).state!.companions.find(owner => owner.name === '小肥鱼')!;
    expect(owner).toBeDefined();
    const conversation = store.openPrivate(owner.id), config = await realGlobalChatConfig(root);
    const modelFetch: typeof fetch = async (input, init) => {
      const started = performance.now(), body = JSON.parse(String(init?.body ?? '{}'));
      const response = await fetch(input, init);
      const headerMs = performance.now() - started;
      const metadata = { kind: 'model', model: body.model, inputChars: JSON.stringify(body.messages ?? body.input ?? []).length,
        streaming: body.stream === true, status: response.status, headerMs };
      if (!response.body) { emit({ ...metadata, completeMs: headerMs }); return response; }
      let bytes = 0;
      const monitored = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { bytes += chunk.length; controller.enqueue(chunk); },
        flush() { emit({ ...metadata, completeMs: performance.now() - started, responseBytes: bytes }); },
      });
      return new Response(response.body.pipeThrough(monitored), { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    native = await realMemoryRuntime(root, undefined, { modelFetch, observeHotLatency: event => emit({ kind: 'worker', ...event }) });
    const originalEmbed = native.encoder.embed.bind(native.encoder);
    vi.spyOn(native.encoder, 'embed').mockImplementation(async (texts, input) => {
      const started = performance.now();
      try { return await originalEmbed(texts, input); }
      finally { emit({ kind: 'encoder', purpose: input.purpose, count: texts.length,
        inputChars: texts.reduce((sum, text) => sum + text.length, 0), elapsedMs: performance.now() - started }); }
    });
    const rawRequest = async (command: CompanionStorageCommand) => store!.request(command);
    const host = Object.create(CompanionService.prototype) as { call(command: CompanionStorageCommand): Promise<CompanionStorageResponse> };
    Object.assign(host, { storage: { request: rawRequest }, sourceValidationRevision: 0, evidenceRevision: 0,
      options: { report: () => undefined, dsh: () => undefined }, resettingCompanions: new Set() });
    memory = new CompanionMemoryService({ request: command => host.call(command), configFor: async () => config,
      runtime: native.runtime, cacheRoot: path.join(root, 'views'), fetchFn: modelFetch,
      busy: () => run !== 'idle-preparation', changed: () => undefined, report: error => errors.push(error instanceof Error ? error.name : 'unknown') });
    Object.assign(host, { memory });
    // Keep a second controlled run free from background capture. With the flag
    // enabled this exercises the real scheduler, including its shared queue.
    if (!backgroundScheduling) vi.spyOn(memory, 'schedule').mockImplementation(() => undefined);
    if (prepareBeforeQuery) {
      run = 'idle-preparation';
      const started = performance.now();
      // Exercise the same idle preparation hook, in the isolated owner snapshot.
      const port = memory as unknown as { startWarmup(owners: readonly typeof owner[], rooms: readonly typeof conversation[]): void; warmup?: Promise<void>; startContinuity(): void };
      vi.spyOn(port, 'startContinuity').mockImplementation(() => undefined);
      const recentRoom = store.request({ type: 'state', conversationId: conversation.id }).state?.conversations.find(room => room.id === conversation.id) ?? conversation;
      port.startWarmup([owner], [recentRoom]); await port.warmup;
      expect(events.some(event => event.kind === 'client' && event.operation === 'prepare')).toBe(true);
      records.push({ run, elapsedMs: performance.now() - started });
    }
    const queries = ['上海天气', '现在上海天气怎么样', '明天上海天气如何', '我之前交代过的记忆功能和浏览器操作问题有哪些'];
    for (const [index, query] of (prepareBeforeQuery ? queries.slice(0, 1)
      : process.env.WORLDLINEBOX_MEMORY_LATENCY_CONTEXT_FIX === '1' ? queries.slice(0, 2) : queries).entries()) {
      run = `passive-${index}`;
      const sourceMessage = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: query });
      const corpus = store.request({ type: 'memory.snapshot', companionId: owner.id, conversationId: conversation.id, beforeSequence: sourceMessage.sequence }).memorySnapshot!;
      const started = performance.now();
      const result = await memory.recall({ companion: owner, conversation, currentMessage: sourceMessage,
        messages: store.messages({ conversationId: conversation.id, limit: 30 }).messages, config,
        signal: AbortSignal.timeout(240_000), onProgress: stage => {
          const elapsedMs = Math.round(performance.now() - started);
          emit({ kind: 'progress', stage, elapsedMs }); console.info(JSON.stringify({ run, stage, elapsedMs }));
        } });
      records.push({ run, elapsedMs: performance.now() - started, corpusNotes: corpus.notes.length,
        corpusChars: corpus.notes.reduce((sum, note) => sum + note.content.length, 0), timings: result.timings,
        candidateCount: result.memories.length, contextChars: result.context?.text.length ?? 0, degraded: result.degraded });
      await save();
      expect(result.degraded).toBe(false);
      expect(result.context).toBeDefined();
    }
  } finally {
    await save(); await memory?.close(); await native?.close(); store?.close(); requestSpy.mockRestore();
    await removeOwnedDirectory(root);
  }
}, 1_000_000);
