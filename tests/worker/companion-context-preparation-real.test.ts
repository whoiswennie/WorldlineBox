import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

// An opt-in diagnosis of a read-only SQLite backup. It never connects a model,
// starts native indexing, changes the user's DB, or writes source text to logs.
it.skipIf(process.env.WORLDLINEBOX_CONTEXT_PREPARATION_REAL !== '1')('measures actual historical proof preparation on an isolated read-only backup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-context-preparation-'));
  const records: Array<Record<string, unknown>> = [], counts: Record<string, number> = {}, times: Record<string, number> = {};
  const profiles = new Set<string>();
  const inspect = (value: unknown): void => {
    if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) { try { inspect(JSON.parse(value)); } catch { /* Ordinary source text. */ } }
    else if (Array.isArray(value)) value.forEach(inspect);
    else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      if (typeof object.profileKey === 'string') profiles.add(object.profileKey);
      Object.values(object).forEach(inspect);
    }
  };
  let store: CompanionsStore | undefined, memory: CompanionMemoryService | undefined;
  let traffic: ReturnType<typeof setInterval> | undefined;
  let stopTraffic: ReturnType<typeof setTimeout> | undefined;
  const output = path.resolve(`artifacts/vcp-validation/context-preparation-${process.env.WORLDLINEBOX_CONTEXT_PREPARATION_LABEL ?? 'current'}.json`);
  const save = async () => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output,
    JSON.stringify({ realUserDataModified: false, modelOrEncoderStarted: false, records, counts, times }, null, 2)); };
  try {
    const locator = JSON.parse(await readFile(path.join(process.env.APPDATA!, 'WorldlineBox', 'companion-library.json'), 'utf8'));
    const SourceDatabase = Database as { new(file: string, options: { readonly: boolean; fileMustExist: boolean }): {
      prepare(sql: string): { all(): unknown }; backup(file: string): Promise<unknown>; close(): void } };
    const source = new SourceDatabase(path.join(locator.libraryPath, '.worldlinebox', 'companions', 'messages.sqlite'), { readonly: true, fileMustExist: true });
    try {
      for (const row of source.prepare("SELECT value FROM metadata WHERE key LIKE 'message-loop/%'").all() as Array<{ value: string }>) inspect(JSON.parse(row.value));
      await source.backup(path.join(root, 'messages.sqlite'));
    } finally { source.close(); }
    store = new CompanionsStore(path.join(root, 'messages.sqlite'), []);
    const owner = store.request({ type: 'state', includeConversations: false }).state!.companions.find(owner => owner.name === '小肥鱼')!;
    const room = store.openPrivate(owner.id);
    const generationProfile = [...profiles].find(profile => profile.includes(':owner-generation-v1-')) ?? [...profiles][0] ?? 'unconfigured';
    const embeddingProfile = generationProfile.split(':owner-generation-v1-')[0]!;
    const raw = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
      const at = performance.now(); counts[command.type] = (counts[command.type] ?? 0) + 1;
      try {
        const result = store!.request(command);
        if (process.env.WORLDLINEBOX_CONTEXT_PREPARATION_TRAFFIC === '1') await new Promise(resolve => setTimeout(resolve, 2));
        return result;
      } finally { times[command.type] = (times[command.type] ?? 0) + performance.now() - at; }
    };
    const host = Object.create(CompanionService.prototype) as { call(command: CompanionStorageCommand): Promise<CompanionStorageResponse> };
    Object.assign(host, { storage: { request: raw }, sourceValidationRevision: 0, evidenceRevision: 0,
      options: { report: () => undefined, dsh: () => undefined }, resettingCompanions: new Set() });
    memory = new CompanionMemoryService({ request: command => host.call(command),
      runtime: { describeEmbedding: async () => ({ profileKey: embeddingProfile }), describeGeneration: async input => ({ ownerId: input.ownerId, profileKey: generationProfile }),
        get: async () => { throw Error('A preparation read must not initialize a model'); }, close: async () => undefined },
      configFor: async () => ({ apiFormat: 'openai_chat', model: 'metadata-only', apiKey: 'metadata-only' }),
      fetchFn: async () => { throw Error('No provider requests are allowed'); }, busy: () => true, changed: () => undefined, report: () => undefined });
    Object.assign(host, { memory }); vi.spyOn(memory, 'schedule').mockImplementation(() => undefined);
    const operations = [{ type: 'messages', conversationId: room.id, limit: 30 },
      { type: 'memory.snapshot', companionId: owner.id, conversationId: room.id }] as CompanionStorageCommand[];
    const projection = (value: CompanionStorageResponse) => JSON.stringify({ messages: value.messages?.map(item => [item.id, item.content]),
      notes: value.memorySnapshot?.notes.map(item => [item.id, item.version, item.content]) });
    const expected: string[] = [];
    for (const command of operations) expected.push(projection(await host.call(command)));
    Object.keys(counts).forEach(key => delete counts[key]); Object.keys(times).forEach(key => delete times[key]);
    if (process.env.WORLDLINEBOX_CONTEXT_PREPARATION_TRAFFIC === '1') traffic = setInterval(() => {
      const command: CompanionStorageCommand = process.env.WORLDLINEBOX_CONTEXT_PREPARATION_TRAFFIC_KIND === 'cursor'
        ? { type: 'conversation.read', id: room.id } : { type: 'routine.get', companionId: owner.id, conversationId: room.id };
      void host.call(command).catch(() => undefined);
    }, 25);
    if (process.env.WORLDLINEBOX_CONTEXT_PREPARATION_MAX_TRAFFIC_MS === '10000') stopTraffic = setTimeout(() => { if (traffic) clearInterval(traffic); }, 10000);
    for (const [index, command] of operations.entries()) {
      const started = performance.now();
      const result = await host.call(command);
      records.push({ operation: command.type, elapsedMs: performance.now() - started, items: result.messages?.length ?? result.memorySnapshot?.notes.length });
      await save(); expect(result.ok).toBe(true);
      expect(projection(result)).toBe(expected[index]);
    }
    if (!process.env.WORLDLINEBOX_CONTEXT_PREPARATION_LABEL?.startsWith('baseline')) for (const record of records) expect(record.elapsedMs).toBeLessThan(5000);
  } finally { if (traffic) clearInterval(traffic); if (stopTraffic) clearTimeout(stopTraffic); await save(); await memory?.close(); store?.close(); await removeOwnedDirectory(root); }
}, 600_000);
