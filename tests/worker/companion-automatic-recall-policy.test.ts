import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { nativeManagementHarness } from '../fixtures/vcp-management-native';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
it('automatically applies original gentle decay during ordinary recall while retaining important old material and exact-time recall', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-auto-recall-'));
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-auto-recall-')) throw new Error('Unsafe fixture cleanup');
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), [{ id: 'alice', name: 'Alice', persona: '核验原生记忆', description: '', model: '', avatar: 'sister', active: true, proactive: false }]);
  const conversation = store.openPrivate('alice');
  const today = Date.now(), dates = [new Date(today - 360 * 86400000).toISOString(), new Date(today - 86400000).toISOString(), new Date(today - 360 * 86400000).toISOString()];
  const tokens = ['EPISODE_OLD', 'EPISODE_NEW', 'IMPORTANT_OLD'];
  const messages = tokens.map((token, i) => store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: `group0 alpha umbrella ${token} recorded at ${dates[i]}`, replyDirective: 'none' }));
  const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  const notes = store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: messages.map((source, i) => ({ content: source.content,
    occurredAt: dates[i], diaryName: '日记', tags: ['group0', 'umbrella', ...(i === 2 ? ['重要'] : [])], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] })) }).memories!;
  expect(notes.every(note => note.captureMethod === 'automatic')).toBe(true);
  for (let i = 0; i < notes.length; i++) { const outbox = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!; store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true }); }
  const native = await nativeManagementHarness(root, async command => store.request(command), { chatReply: '按有出处的旧资料与近期经历核对后再回答。', semanticVariants: true });
  const service = new CompanionMemoryService({ request: async command => store.request(command), cacheRoot: path.join(root, 'views'), runtime: { get: async () => ({ client: native.client, profileKey: 'automatic-recall-test' }), close: () => native.client.close() },
    configFor: async () => { throw new Error('Synthetic background capture disabled'); }, busy: () => true, fetchFn: fetch, changed: () => undefined, report: () => undefined });
  try {
    const preprocess = vi.spyOn(native.client, 'preprocess');
    const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: 'group0 alpha umbrella 有哪些经历？', replyDirective: 'none' });
    const recall = await service.recall({ companion: store.state().companions[0]!, conversation, currentMessage: source, messages: [source], config: { apiFormat: 'openai_chat', baseUrl: '', model: 'synthetic', apiKey: '' } });
    expect(recall.context?.text).toContain('按有出处');
    expect(recall.context?.evidence?.recallPolicy).toMatchObject({ schema: 'episodic-v1', halfLifeDays: 180, minScore: 0, applied: true, eligibleCount: expect.any(Number) });
    expect(recall.context?.evidence?.recallPolicy?.protectedNoteIds, JSON.stringify({ notes: notes.map(note => ({ id: note.id, tags: note.tags, text: note.content })), recalled: recall.memories.map(note => note.content) })).toContain(notes[2]!.id);
    expect(recall.context?.evidence?.queryClock).toMatchObject({ domain: 'world', timeZone: expect.any(String) });
    const args = preprocess.mock.calls[0]!;
    expect(JSON.stringify(args[1])).toContain('::RiverMemo::TimeDecay180/0::AIMemo+');
    const actual = await preprocess.mock.results[0]!.value as Awaited<ReturnType<typeof native.client.preprocess>>, rows = actual.automaticDecay!.flatMap(observation => observation.results);
    const old = rows.find(row => row.id === notes[0]!.id)!, recent = rows.find(row => row.id === notes[1]!.id)!, important = rows.find(row => row.id === notes[2]!.id)!;
    expect(old).toMatchObject({ protected: false, explicitTime: false }); expect(old.diffDays).toBeGreaterThanOrEqual(359);
    expect(old.decayFactor).toBeCloseTo(Math.pow(.5, old.diffDays! / 180), 12); expect(old.score).toBeCloseTo(old.originalScore! * old.decayFactor!, 12);
    expect(recent.score!).toBeGreaterThan(old.score!); expect(important).toMatchObject({ protected: true }); expect(important.score).toBe(important.originalScore);
    expect(native.chatRequests.some(request => request.includes('EPISODE_OLD') && request.includes('EPISODE_NEW') && request.includes('IMPORTANT_OLD'))).toBe(true);
    // The automatic suffix's original Time alias is inert without a time range.
    expect(actual.parsedTimeRanges).toEqual([]);
    const exactSource = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: '昨天 group0 alpha umbrella 发生了什么？', replyDirective: 'none' });
    await service.recall({ companion: store.state().companions[0]!, conversation, currentMessage: exactSource, messages: [exactSource], config: { apiFormat: 'openai_chat', baseUrl: '', model: 'synthetic', apiKey: '' } });
    const exact = await preprocess.mock.results.at(-1)!.value as Awaited<ReturnType<typeof native.client.preprocess>>;
    expect(exact.automaticDecay!.flatMap(observation => observation.results).some(row => row.id === notes[1]!.id && row.explicitTime && row.decayFactor === undefined)).toBe(true);
    const output = path.resolve('artifacts/vcp-validation'); await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'automatic-passive-recall-2026-10-23.json'), JSON.stringify({ schema: 'worldlinebox.automatic-passive-recall-acceptance-v1',
      fixture: 'synthetic-only loopback embedding/focusing endpoints; real SQLite/Rust/original-RAG/original-AIMemo pipeline',
      input: 'ordinary service.recall without retrievalOptions', queryClock: actual.queryClock, policy: recall.context?.evidence?.recallPolicy,
      equalQueryCosine: 1 / Math.sqrt(1 + .4 * .4), rows: { old, recent, important }, originalFormula: 'originalScore * pow(0.5, diffDays / 180)',
      oldMaterialStillInFocusingPrompt: true, noRelativeWordTimeRanges: actual.parsedTimeRanges, explicitYesterdayRanges: exact.parsedTimeRanges,
      explicitYesterdayExempt: true, candidateOrder: recall.context?.evidence?.candidateOrder, contextOrder: recall.context?.evidence?.contextOrder,
    }, null, 2));
  } finally { await service.close(); await native.close(); store.close(); await removeOwnedDirectory(root); }
}, 120000);
