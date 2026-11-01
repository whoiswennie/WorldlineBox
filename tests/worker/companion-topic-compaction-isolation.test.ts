import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionTopicCompactionService } from '../../src/main/companions/topic-compaction-service';
import { createCompanionExecutionValidationSession, guardCompanionExecutionSources, memoCompanionExecutionWitnesses, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { currentCompanionStorageOperation, currentCompanionStorageOperationHash, withCompanionStorageOperation } from '../../src/main/companions/storage-operation-context';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

it.each([false, true])('isolates a foreground wake from its closed frame and independently fences background files, tampered=%s', async tampered => {
  const f = managedMemoryFiles(); fixtures.push(f);
  const room = f.store.openPrivate('alice'), source = f.source('后台仅检查这条真实消息的整理欠账。');
  const job = f.store.request({ type: 'topic.compaction.enqueue', ...f.scope, topicId: room.activeTopicId!, sourceMessageId: source.id }).topicCompactionJob!;
  const foregroundFile = path.join(f.root, 'foreground.txt'), backgroundFile = path.join(f.root, 'background.txt');
  await writeFile(foregroundFile, 'foreground exact'); await writeFile(backgroundFile, 'background exact');
  const foreground = createCompanionExecutionValidationSession(), entered = deferred(), proceed = deferred(), errors: unknown[] = [];
  const foregroundFinal = vi.fn(), backgroundFinal = vi.fn(), calls: Array<{ type: string; priority?: string; hash?: string }> = [];
  let foregroundHash: string | undefined, firstClaim = true;
  const storage = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    calls.push({ type: command.type, priority: currentCompanionStorageOperation()?.priority, hash: currentCompanionStorageOperationHash() });
    return f.store.request(command);
  };
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'topic.compaction.claim' && firstClaim) {
      firstClaim = false;
      // A real local reader before the claim owns its own finite final fence.
      // The foreground must neither validate nor close this pending reader.
      await withCompanionExecutionValidation(async () => {
        await memoCompanionExecutionWitnesses(['background-file'], { identity: storage, scope: 'background-local-input', revision: () => 0,
          read: async () => new Map([['background-file', await readFile(backgroundFile, 'utf8')]]), verify: async entries => {
            backgroundFinal();
            if (await readFile(backgroundFile, 'utf8') !== entries[0]!.value) throw new Error('background file changed');
          } });
        entered.resolve(); await proceed.promise;
      });
    }
    return withCompanionExecutionValidation(async () => guardCompanionExecutionSources(command, await storage(command), {
      storage, identity: storage, revision: () => 0, valid: async () => true,
    }));
  };
  const fetchFn = vi.fn<typeof fetch>(async () => { throw new Error('This bounded debt check must not call a provider'); });
  const actor = new CompanionTopicCompactionService({ request, configFor: async () => ({ apiFormat: 'openai_chat', model: 'not-called', apiKey: 'fixture' }), fetchFn, report: error => errors.push(error) });
  try {
    await withCompanionStorageOperation({ priority: 'interactive', lane: 'foreground-trigger' }, () => foreground.run(async () => {
      foregroundHash = currentCompanionStorageOperationHash();
      await memoCompanionExecutionWitnesses(['foreground-file'], { identity: actor, scope: 'foreground-local-input', revision: () => 0,
        read: async () => new Map([['foreground-file', await readFile(foregroundFile, 'utf8')]]), verify: async entries => {
          foregroundFinal(); expect(await readFile(foregroundFile, 'utf8')).toBe(entries[0]!.value);
        } });
      actor.wake(); await entered.promise;
    }));
    await foreground.validate(); expect(foregroundFinal).toHaveBeenCalledOnce(); expect(backgroundFinal).not.toHaveBeenCalled();
    foreground.close(); await writeFile(foregroundFile, 'foreground changed after its own final');
    if (tampered) await writeFile(backgroundFile, 'background changed before its own final');
    proceed.resolve();
    if (tampered) {
      await vi.waitFor(() => expect(errors.some(error => error instanceof Error && error.message === 'background file changed')).toBe(true));
      expect(f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'topic_compaction', id: job.id }).jobDisposition?.state).toBe('pending');
      expect(calls.some(call => call.type === 'topic.compaction.claim')).toBe(false);
    } else {
      await vi.waitFor(() => expect(f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'topic_compaction', id: job.id }).jobDisposition?.state).toBe('completed'));
      expect(errors).toEqual([]);
      const claim = calls.find(call => call.type === 'topic.compaction.claim')!, running = calls.find(call => call.type === 'topic.compaction.check')!;
      expect(claim.hash).not.toBe(running.hash); expect(calls.some(call => call.type === 'memory.sources.headers')).toBe(true);
      expect(calls.every(call => call.priority === 'background' && call.hash && call.hash !== foregroundHash)).toBe(true);
    }
    expect(backgroundFinal).toHaveBeenCalledOnce(); expect(foregroundFinal).toHaveBeenCalledOnce(); expect(fetchFn).not.toHaveBeenCalled();
    expect(f.store.getMessage(source.id).content).toBe(source.content);
  } finally { foreground.close(); proceed.resolve(); await actor.close(); }
});
