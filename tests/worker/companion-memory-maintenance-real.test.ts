import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

/** Fixed, source-backed independent-event journals are fixture inputs. The
 * sleep/reflection/maintenance models and SQLite job transaction are real;
 * this counterexample does not claim native encoder or automatic capture QA. */
it.skipIf(process.env.WORLDLINEBOX_MEMORY_MAINTENANCE_REAL !== '1')('makes a real independent-event maintenance defer without forcing archival or paying again on the next actual sleep', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-maintenance-real-'));
  const config = await realGlobalChatConfig(root), commands: CompanionStorageCommand[] = [], calls: Array<{ purpose: string; response?: string }> = [], errors: string[] = [];
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-23T10:00:00Z');
  const store = new CompanionsStore(path.join(root, 'ledger.sqlite'), [{ id: 'alice', name: '阿澜', description: '', persona: '认真核验事实，保留事件的具体情境和未知，不把不相关的经历混合。',
    model: '', avatar: 'sister', proactive: false, active: true }]);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const request = async (command: CompanionStorageCommand) => { commands.push(command); return store.request(command); };
  const fetchFn: typeof fetch = async (url, init) => {
    let purpose = 'unknown'; try { purpose = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).purpose; } catch { /* No headers/keys recorded. */ }
    const call: { purpose: string; response?: string } = { purpose }; calls.push(call);
    const response = await fetch(url, init);
    try { const body = await response.clone().json(); call.response = body.choices?.[0]?.message?.content; } catch { /* Actual parser owns validity. */ }
    return response;
  };
  const service = new CompanionWorldService({ request, configFor: async () => config, fetchFn, changed: () => undefined, wakeWaiting: () => undefined,
    report: error => errors.push(error instanceof Error ? error.message : String(error)) });
  let result: unknown, status = 'failed';
  const index = () => { for (let count = 0; count < 100; count++) { const outbox = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
    if (!outbox) return; store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true }); } throw new Error('Unexpected fixture outbox backlog'); };
  const step = async () => { vi.setSystemTime(Date.now() + 16000); store.request({ type: 'world.tick' }); await service.tick(); };
  try {
    const sources = ['昨天上午小周向我借了一把蓝色雨伞，约定明天归还，尚未归还；没有发生维修活动。',
      '上周五晚上我独自在书房更换收音机的音量旋钮，试音成功；这件事与小周借伞没有共同参与者、因果或后续任务。']
      .map(content => store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content, replyDirective: 'none' }));
    const capture = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
    const originals = store.request({ type: 'memory.jobs.complete', id: capture.id, leaseToken: capture.leaseToken,
      notes: sources.map(source => ({ artifactKind: 'episode_memory' as const, content: source.content, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] })) }).memories!;
    index();
    const world = store.request({ type: 'world.snapshot' }).world!;
    store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '09:00', wakeAt: '11:00', meals: [], habits: [] } });
    // Dream admission is a real bounded host draw; the counterexample concerns
    // factual seed maintenance and must not need fictional narrative generation.
    const random = vi.spyOn(Math, 'random').mockReturnValue(.99);
    await step();
    const deadline = performance.now() + 180000;
    while (!commands.some(command => command.type === 'world.job.complete' && command.maintenance) && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200)); await service.tick();
    }
    random.mockRestore();
    const completed = commands.find(command => command.type === 'world.job.complete' && command.maintenance);
    result = { completed, calls, errors, originals: originals.map(note => ({ id: note.id, content: note.content, version: note.version })) };
    expect(completed?.type === 'world.job.complete' && completed.maintenance).toMatchObject({ decision: 'defer', reason: expect.any(String) });
    expect(completed?.type === 'world.job.complete' && completed.consolidations).toBeUndefined();
    expect(calls.filter(call => call.purpose === 'vcp_sleep_memory_maintenance')).toHaveLength(1);
    index();
    for (const asleep of [false, true]) {
      const current = store.request({ type: 'routine.get', ...scope }).routine!;
      store.request({ type: 'routine.configure', ...scope, expectedRevision: current.revision, patch: { sleepAt: asleep ? '09:00' : '22:00', wakeAt: asleep ? '11:00' : '08:00' } });
      await step();
    }
    expect(calls.filter(call => call.purpose === 'vcp_sleep_memory_maintenance')).toHaveLength(1);
    const active = store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!.notes;
    for (const original of originals) expect(active.find(note => note.id === original.id)).toMatchObject({ content: original.content, version: original.version });
    expect(active.some(note => note.archivedAt)).toBe(false); status = 'passed';
  } finally {
    await service.close(); store.close(); vi.restoreAllMocks(); vi.useRealTimers();
    const output = path.resolve(process.env.WORLDLINEBOX_MEMORY_MAINTENANCE_RESULT ?? 'artifacts/vcp-validation/real-independent-maintenance-defer-2026-10-23.json');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ status, model: config.model, actualChat: true, actualSQLiteSleepJob: true, automaticCaptureClaim: false, nativeEncoderClaim: false, result, calls, errors }, null, 2));
    await removeOwnedDirectory(root);
  }
}, 240000);
