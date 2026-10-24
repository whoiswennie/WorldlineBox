import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { buildCompanionContext } from '../../src/main/companions/context';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import { companionStorageCommandSchema, type CompanionStorageCommand } from '../../src/shared/companion-storage';
import { companionsResponseSchema } from '../../src/shared/companions';
import { companionExecutionReadsetSchema } from '../../src/shared/companion-execution-evidence';
import { controlledMemoryRuntime } from '../fixtures/controlled-memory-runtime';
import { nativeManagementHarness } from '../fixtures/vcp-management-native';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
let root: string | undefined, store: CompanionsStore | undefined;
afterEach(() => {
  vi.useRealTimers(); store?.close(); store = undefined;
  if (!root) return;
  const resolved = path.resolve(root); root = undefined;
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('companion-social-memory-context-')) throw Error('Unexpected owned social-memory fixture');
  removeOwnedDirectorySync(resolved);
});

it('roundtrips the complete production VCP context through live social storage and execution evidence without accepting unknown or malformed fields', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-15T10:00:00Z');
  root = mkdtempSync(path.join(tmpdir(), 'companion-social-memory-context-'));
  const current = store = new CompanionsStore(path.join(root, 'state.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '核验真实来源。', model: '', avatar: 'sister', active: true, proactive: true })));
  const world = current.request({ type: 'world.snapshot' }).world!;
  current.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const companionId of ['alice', 'bob']) {
    const scope = { companionId, conversationId: current.openPrivate(companionId).id }, routine = current.request({ type: 'routine.get', ...scope }).routine!;
    current.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } });
  }
  const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms); current.request({ type: 'world.tick' }); };
  advance(10000);
  const privateScope = { companionId: 'bob', conversationId: current.openPrivate('bob').id };
  const fact = current.appendMessage({ conversationId: privateScope.conversationId, authorId: 'user', content: 'group0 SYNTHETIC_SOCIAL_FACT：棉线在第二层抽屉。', replyDirective: 'none' });
  const parent = current.request({ type: 'memory.record', ...privateScope, candidate: { content: fact.content, tags: ['group0'], sourceMessageIds: [fact.id], evidence: [{ sourceMessageId: fact.id, quote: fact.content }] } }).memories![0]!;
  for (let n = 0; n < 10; n++) { const outbox = current.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!outbox) break; current.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true }); }
  const pair = current.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'], title: '实际伙伴入口' }).socialConversation!;
  const send = { type: 'social.send', companionId: 'alice', conversationId: pair.id, channel: 'phone', content: 'group0 请核对棉线的位置。', clientId: 'schema-real-source' } as const;
  current.request(send); advance(1300); expect(current.request(send).socialMessage).toBeDefined();
  const job = current.request({ type: 'social.job.claim' }).socialJob!; expect(job.companionId).toBe('bob');
  const scope = { companionId: job.companionId, conversationId: job.conversationId, beforeSequence: job.throughSequence };
  const request = async (command: CompanionStorageCommand) => current.request(command);
  const native = await nativeManagementHarness(root, request, { chatReply: '已核验的 SYNTHETIC_SOCIAL_FACT：棉线在第二层抽屉。' });
  const service = new CompanionMemoryService({ request, runtime: controlledMemoryRuntime({ get: async () => ({ client: native.client, profileKey: 'synthetic-social-context' }), close: () => native.client.close() }),
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'controlled-local-focusing', apiKey: 'controlled-key', baseUrl: 'https://fixture.invalid' }), fetchFn: fetch, busy: () => true, changed: () => undefined, report: () => undefined });
  try {
    const actual = await service.search({ ...scope, query: 'group0 棉线的位置' }, 'passive'), context = actual.memoryContext!;
    expect(context.text.length).toBeGreaterThan(0);
    expect(context.evidence).toMatchObject({ queryClock: { domain: 'world', timeZone: 'UTC' }, recallPolicy: { schema: 'episodic-v1' },
      queryCorpusHash: expect.any(String), pageMemoryIds: [parent.id], dependencies: [{ id: parent.id, version: parent.version }], dependencyCoverage: 'complete',
      references: expect.any(Array), referenceCoverage: expect.any(String), candidateOrder: 'independent_native_query', contextOrder: 'original_context_pipeline' });
    const recall = { reasons: [], pending: false, degraded: false, context };
    const progress = { type: 'social.job.progress', id: job.id, leaseToken: job.leaseToken!, phase: 'thinking', detail: '核验后的真实聚焦上下文', memoryRecall: recall } as const;
    // This is the actual failing storage boundary, before any receipt is saved.
    current.request(progress);
    expect(companionsResponseSchema.parse(actual).memoryContext).toEqual(context);
    const pending = current.request({ type: 'social.reply.for-job', jobId: job.id }).socialReplyReceipt!;
    expect(JSON.parse(pending.context.user).memoryRecall.context).toEqual(context);
    const source = current.getMessage(job.sourceMessageId), frame = buildCompanionContext({ companion: current.state().companions.find(companion => companion.id === 'bob')!,
      conversation: current.state(true).conversations.find(conversation => conversation.id === pair.id)!, sourceMessage: source, messages: [source], memories: [], memoryRecall: recall });
    const readset = captureCompanionExecutionReadset(scope, { context: frame });
    expect(readset).toMatchObject({ complete: true, memories: [{ id: parent.id, version: parent.version }], contexts: [] });
    expect(companionExecutionReadsetSchema.parse(JSON.parse(JSON.stringify(readset)))).toEqual(readset);
    advance(Math.max(1, Date.parse(job.typingNotBefore) - Date.now() + 1));
    const reply = current.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: '核验后，棉线在第二层抽屉。', memoryRecall: recall,
      expectedMemoryRevision: context.revision, executionReadset: readset }).socialMessage!;
    expect(reply.message.content).toContain('第二层抽屉');
    const persisted = current.request({ type: 'social.reply.for-message', messageId: reply.message.id }).socialReplyReceipt!;
    expect(JSON.parse(persisted.context.user).memoryRecall.context).toEqual(context);
    for (const evidence of [{ ...context.evidence, forgedSource: 'not-host-evidence' },
      { ...context.evidence, dependencies: [{ id: parent.id, version: 0 }] },
      { ...context.evidence, queryClock: { ...context.evidence!.queryClock, domain: 'real' } }]) {
      const malformed = { ...context, evidence };
      expect(companionStorageCommandSchema.safeParse({ ...progress, memoryRecall: { ...recall, context: malformed } }).success).toBe(false);
      expect(companionsResponseSchema.safeParse({ ok: true, memoryContext: malformed }).success).toBe(false);
    }
  } finally { await service.close(); await native.close(); }
}, 120000);
