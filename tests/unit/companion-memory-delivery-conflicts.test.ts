import { expect, it, vi } from 'vitest';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import type { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { CompanionMemory } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

function fixture(error?: Error, disposition: 'completed' | 'stale' = 'completed') {
  const note: CompanionMemory = { id: 'note', companionId: 'alice', scopeId: 'scope', sourceConversationId: 'private', sourceSequence: 1,
    content: '合成实际来源。', tags: [], diaryName: '日记', sources: [{ messageId: 'source', conversationId: 'private', sequence: 1, revision: 1,
      authorId: 'user', checksum: 'fixture', createdAt: '2026-10-26T00:00:00Z' }], createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z',
    captureMethod: 'automatic', origin: 'user', status: 'queued', version: 1 };
  let dispatched = false;
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'memory.outbox.claim') {
      if (dispatched) return { ok: true }; dispatched = true;
      return { ok: true, memoryOutbox: { id: 'delivery', companionId: 'alice', scopeId: 'scope', noteId: 'note', noteVersion: 1,
        operation: 'remember', note, leaseToken: 'lease', attempts: 1 } };
    }
    if (command.type === 'state') return { ok: true, state: { companions: [{ id: 'alice', name: 'Alice' }] } } as CompanionStorageResponse;
    if (command.type === 'memory.outbox.complete') return { ok: true, memoryOutboxDisposition: { state: disposition } };
    return { ok: true };
  });
  const client = { remember: vi.fn(async () => { if (error) throw error; }), interruptScope: vi.fn(async () => undefined) } as unknown as VcpMemoryClient;
  const service = new CompanionMemoryService({ request, runtime: { get: async () => ({ client, profileKey: 'fixture' }), close: async () => undefined },
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fixture' }), fetchFn: async () => { throw Error('No model requests expected.'); },
    busy: () => false, changed: () => undefined, report: () => undefined });
  const deliver = async () => { await (service as unknown as { deliver(): Promise<void> }).deliver(); await service.drainDeliveries(); };
  const continuity = vi.spyOn(service as unknown as { queueContinuity(scope: { companionId: string; conversationId: string }): void }, 'queueContinuity');
  return { service, client, request, deliver, continuity };
}

it.each(['SQLITE_BUSY', 'SQLITE_LOCKED', 'KNOWLEDGE_STORE_SOURCE_SNAPSHOT_CHANGED', 'KNOWLEDGE_STORE_FILE_VERSION_CONFLICT',
  'KNOWLEDGE_STORE_BATCH_EXPIRED', 'KNOWLEDGE_STORE_MODEL_CHANGED_DURING_EMBEDDING'])('requeues transient %s without marking a permanent indexing failure', async code => {
  const f = fixture(Object.assign(new Error('受控原生并发变化'), { code }));
  try {
    await f.deliver();
    expect(f.request).toHaveBeenCalledWith({ type: 'memory.outbox.defer', id: 'delivery', leaseToken: 'lease', retryAfterMs: 1000 });
    expect(f.request.mock.calls.some(([command]) => command.type === 'memory.outbox.fail' || command.type === 'memory.outbox.complete')).toBe(false);
  } finally { await f.service.close(); }
});

it('keeps genuine embedding failures on the bounded failure/backoff path', async () => {
  const f = fixture(Object.assign(new Error('编码返回损坏向量'), { code: 'VCP_MEMORY_EMBEDDING_RESPONSE_INVALID' }));
  try {
    await f.deliver();
    expect(f.request).toHaveBeenCalledWith({ type: 'memory.outbox.fail', id: 'delivery', leaseToken: 'lease', error: '编码返回损坏向量', retryAfterMs: 30000 });
    expect(f.request.mock.calls.some(([command]) => command.type === 'memory.outbox.defer')).toBe(false);
  } finally { await f.service.close(); }
});

it.each(['completed', 'stale'] as const)('does not turn a safely %s completion into a failed delivery', async disposition => {
  const f = fixture(undefined, disposition);
  try {
    await f.deliver();
    expect(f.request.mock.calls.some(([command]) => command.type === 'memory.outbox.fail')).toBe(false);
    expect(f.continuity).toHaveBeenCalledTimes(disposition === 'completed' ? 1 : 0);
  } finally { await f.service.close(); }
});

it('requeues a host authorization generation change and leaves source validity to the next claim', async () => {
  const f = fixture();
  vi.mocked(f.client.remember).mockImplementation(async () => {
    (f.service as unknown as { generations: Map<string, number> }).generations.set('alice', 1);
    return { id: 'note', indexed: true };
  });
  try {
    await f.deliver();
    expect(f.request).toHaveBeenCalledWith({ type: 'memory.outbox.defer', id: 'delivery', leaseToken: 'lease', retryAfterMs: 1000 });
    expect(f.request.mock.calls.some(([command]) => command.type === 'memory.outbox.fail' || command.type === 'memory.outbox.complete')).toBe(false);
  } finally { await f.service.close(); }
});
