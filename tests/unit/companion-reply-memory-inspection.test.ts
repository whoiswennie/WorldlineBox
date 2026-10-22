import { describe, expect, it, vi } from 'vitest';
import type { CompanionMemory, CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionReplyMemoryCommand, companionReplyMemorySchema } from '../../src/shared/companion-reply-memory';
import { inspectCompanionReplyMemory, inspectCompanionSocialReplyMemory } from '../../src/main/companions/reply-memory-inspection';
import { recallCorpusHash } from '../../src/main/companions/recall-evidence';
import { createHash } from 'node:crypto';
import type { CompanionSocialReplyReceipt } from '../../src/shared/companion-social-reply';

const createdAt = '2026-10-22T02:00:00.000Z', capturedAt = '2026-10-22T02:01:00.000Z';
function fixture() {
  const source: CompanionMessage = { id: 'source', conversationId: 'peer_alice_bob', authorId: 'bob', content: '玩家之前告诉你的名字是什么？',
    sequence: 10, kind: 'text', status: 'sent', attachments: [], createdAt };
  const evidence: CompanionMessage = { ...source, id: 'intro', authorId: 'user', conversationId: 'private_alice', sequence: 1, content: '你好，我叫天幻。' };
  const bubble: CompanionMessage = { ...source, id: 'reply', authorId: 'alice', sequence: 11, content: '你之前说叫天幻。' };
  const note: CompanionMemory = { id: 'name_note', companionId: 'alice', scopeId: 'alice_private', content: '玩家向我介绍自己叫天幻。',
    sourceConversationId: evidence.conversationId, sourceMessageId: evidence.id, sourceSequence: 1, version: 1, origin: 'user', captureMethod: 'automatic',
    status: 'indexed', tags: ['名字'], createdAt, updatedAt: createdAt, sources: [{ messageId: evidence.id, conversationId: evidence.conversationId,
      sequence: 1, authorId: 'user', revision: 1, checksum: 'source_checksum', createdAt }] };
  const contextText = '【VCP 实际话题聚焦结果】\n玩家之前介绍自己叫天幻。\n' + '原文不折叠成摘要。'.repeat(1500);
  const data = { memories: [note], memoryRecall: { pending: false, degraded: false,
    continuation: { query: { query: source.content } }, context: { text: contextText, revision: 'original_snapshot',
      evidence: { capturedAt, corpusHash: recallCorpusHash([note]) } } } };
  let notes = [note], revision = 'original_snapshot', allowed = true;
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'message.get') return { ok: true, message: bubble };
    if (command.type === 'loop.for-message') return { ok: true, loop: { companionId: 'alice', conversationId: source.conversationId,
      messageId: bubble.id, sourceMessageId: source.id, status: 'done', turns: [], supplements: [], context: { system: '', user: JSON.stringify(data) } } };
    if (command.type === 'memory.sources.filter') return { ok: true, memorySources: allowed ? [source, evidence].filter(item => command.ids.includes(item.id)) : [] };
    if (command.type === 'memory.snapshot') return { ok: true, memorySnapshot: { scopeId: 'owner_alice', revision, notes } };
    throw new Error('Inspection must not execute ' + command.type);
  });
  return { source, note, contextText, data, request,
    inspect: (patch: Record<string, unknown> = {}) => inspectCompanionReplyMemory(companionReplyMemoryCommand.parse({ type: 'reply.memory.inspect', companionId: 'alice', conversationId: source.conversationId, messageId: bubble.id, ...patch }), request),
    update: (next: CompanionMemory[]) => { notes = next; revision = 'new_snapshot'; }, withdraw: () => { allowed = false; } };
}

describe('persisted per-reply native recall inspection', () => {
  it('rechecks a pending peer lease after loading sources and refuses a replacement attempt', async () => {
    const f = fixture(); let reads = 0;
    const receipt: CompanionSocialReplyReceipt = { companionId: 'alice', conversationId: f.source.conversationId, messageId: 'peer_job',
      sourceMessageId: f.source.id, contextThroughSequence: 10, leaseToken: 'first_lease',
      sourceChecksum: createHash('sha256').update(f.source.content).digest('hex'), context: { user: JSON.stringify(f.data) },
      progress: { revision: 1, phase: 'thinking', detail: '回应中', startedAt: createdAt, updatedAt: capturedAt } };
    const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
      if (command.type === 'social.reply.for-job') return { ok: true, socialReplyReceipt: { ...receipt, leaseToken: ++reads === 1 ? 'first_lease' : 'second_lease' } };
      return f.request(command);
    };
    const result = await inspectCompanionSocialReplyMemory({ type: 'social.reply.memory.inspect', companionId: 'alice', conversationId: f.source.conversationId,
      jobId: 'peer_job', contextOffset: 0, contextLimit: 8192 }, request);
    expect(result).toMatchObject({ state: 'withdrawn', messageId: 'peer_job', candidates: [], contextCharacters: 0 });
    expect(reads).toBe(2);
    expect(JSON.stringify(result)).not.toContain('天幻');
    expect(f.request.mock.calls.every(([command]) => command.type !== 'message.get')).toBe(true);
  });
  it('returns exact bounded pages and distinct authorized candidate/source evidence, without rerunning recall', async () => {
    const f = fixture(), first = await f.inspect();
    expect(first).toMatchObject({ state: 'ready', query: f.source.content, contextText: f.contextText.slice(0, 8192), contextOffset: 0,
      nextContextOffset: 8192, contextCharacters: f.contextText.length, contextTruncated: true });
    expect(first.candidates[0]).toMatchObject({ id: f.note.id, version: 1, sourceCount: 1, sources: [{ messageId: 'intro', conversationId: 'private_alice', excerpt: '你好，我叫天幻。' }] });
    const next = await f.inspect({ contextOffset: first.nextContextOffset });
    expect(next.contextText).toBe(f.contextText.slice(8192, 16384));
    expect(companionReplyMemorySchema.safeParse(first).success).toBe(true);
    expect(f.request.mock.calls.every(([command]) => ['message.get', 'loop.for-message', 'memory.sources.filter', 'memory.snapshot'].includes(command.type))).toBe(true);
  });

  it('does not invalidate a historical receipt merely because a later diary or index delivery appeared', async () => {
    const f = fixture();
    f.update([{ ...f.note, status: 'queued', sourceFile: 'new-location.md' }, { ...f.note, id: 'later_note', createdAt: '2026-10-22T02:02:00.000Z' }]);
    expect((await f.inspect()).state).toBe('ready');
  });

  it('inspects candidate version receipts even when raw candidate bodies were excluded from the model prompt', async () => {
    const f = fixture(); f.data.memories = [];
    Object.assign(f.data.memoryRecall, { reasons: [{ id: f.note.id, version: f.note.version, reasons: ['VCP river'], path: [f.note.id] }] });
    expect((await f.inspect()).candidates).toMatchObject([{ id: f.note.id, version: f.note.version }]);
  });

  it.each(['edit', 'delete', 'source'] as const)('redacts actual context and all excerpts after %s of referenced memory', async change => {
    const f = fixture();
    f.update(change === 'delete' ? [] : [{ ...f.note, ...(change === 'edit' ? { version: 2, content: '已经修正' }
      : { sources: [{ ...f.note.sources[0]!, checksum: 'changed' }] }) }]);
    const receipt = await f.inspect();
    expect(receipt).toMatchObject({ state: 'withdrawn', candidates: [], contextCharacters: 0 });
    expect(JSON.stringify(receipt)).not.toContain('天幻');
  });

  it('rechecks after async source loading so a simultaneous withdrawal cannot reappear', async () => {
    const f = fixture(); let snapshots = 0;
    f.request.mockImplementation(async command => {
      if (command.type === 'message.get') return { ok: true, message: { ...f.source, id: 'reply', authorId: 'alice' } };
      if (command.type === 'loop.for-message') return { ok: true, loop: { companionId: 'alice', conversationId: f.source.conversationId, messageId: 'reply', sourceMessageId: 'source', status: 'done', turns: [], supplements: [], context: { system: '', user: JSON.stringify(f.data) } } };
      if (command.type === 'memory.sources.filter') return { ok: true, memorySources: [f.source] };
      if (command.type === 'memory.snapshot') return { ok: true, memorySnapshot: { scopeId: 'alice', revision: 'original_snapshot', notes: ++snapshots > 1 ? [] : [f.note] } };
      throw new Error('Unexpected request');
    });
    expect((await f.inspect()).state).toBe('withdrawn');
  });

  it('rejects another owner or conversation before reading checkpoint/context evidence', async () => {
    const f = fixture();
    expect((await f.inspect({ companionId: 'charlie' })).state).toBe('unavailable');
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('does not invent a memory injection for a ready no-hit reply or older missing receipt', async () => {
    const f = fixture(); f.data.memoryRecall.context.text = ''; f.data.memories = [];
    expect(await f.inspect()).toMatchObject({ state: 'ready', contextCharacters: 0, contextText: '', candidates: [] });
    f.request.mockResolvedValue({ ok: true });
    expect(await f.inspect()).toMatchObject({ state: 'unavailable', contextCharacters: 0 });
  });

  it('does not expose even the query after the triggering message is forgotten', async () => {
    const f = fixture(); f.withdraw();
    const receipt = await f.inspect();
    expect(receipt.state).toBe('withdrawn'); expect(receipt.query).toBeUndefined(); expect(receipt.candidates).toEqual([]);
  });
});
