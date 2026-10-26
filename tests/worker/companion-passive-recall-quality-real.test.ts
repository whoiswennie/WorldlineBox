import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { probeCompanionMemory } from '../../src/main/companions/memory-probe';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMemory } from '../../src/shared/companions';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

/** Explicit paid-model opt-in. Uses only the existing encrypted connection
 * configuration; all tested conversations, memories and files are synthetic.
 * No live user memory database or personal conversation is read or modified. */
it.skipIf(process.env.WORLDLINEBOX_PASSIVE_RECALL_QUALITY_REAL !== '1')('checks factual grounding, corrections, unfinished plans and irrelevant-topic boundaries with the actual encoder and model', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-passive-quality-'));
  const output = path.resolve('artifacts/vcp-validation/passive-recall-quality-real.json');
  const records: Array<Record<string, unknown>> = [], modelCalls: Array<Record<string, unknown>> = [], errors: string[] = [];
  const foreignSecret = 'BOB_ONLY_SECRET_4f91c7d2_紫色月鲸';
  let store: CompanionsStore | undefined, service: CompanionMemoryService | undefined;
  let native: Awaited<ReturnType<typeof realMemoryRuntime>> | undefined;
  let activeCase = 'setup';
  const save = async () => {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ recordedAt: new Date().toISOString(), syntheticFixtureOnly: true, realUserDataModified: false,
      actualEncoder: true, actualChatModel: true, qualityCriteria: 'Required facts, correction precedence, unfinished-state preservation, unknowns, unrelated-topic and owner boundaries',
      records, modelCalls, errors }, null, 2));
  };
  try {
    const config = await realGlobalChatConfig(root);
    const modelFetch: typeof fetch = async (input, init) => {
      const started = performance.now();
      const response = await fetch(input, init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      // This duration ends at headers; query elapsedMs below includes the full
      // generation. Do not misrepresent streaming headers as model latency.
      modelCalls.push({ case: activeCase, status: response.status, headerElapsedMs: performance.now() - started,
        streaming: body.stream === true, inputChars: JSON.stringify(body.messages ?? body.input ?? []).length });
      return response;
    };
    native = await realMemoryRuntime(root, undefined, { modelFetch });
    const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '合成质量验收伙伴', persona: '依据实际记录交流。',
      model: '', avatar: 'sister', active: true, proactive: false }));
    store = new CompanionsStore(path.join(root, 'messages.sqlite'), seeds);
    const conversation = store.openPrivate('alice'), scope = { companionId: 'alice', conversationId: conversation.id };
    const corpus = [
      '合成玩家明确说明：蓝色保险资料袋放在书房东侧书柜最下层。该资料袋是本次合成测试物品，与任何实际用户的文件无关。',
      '合成玩家早先随口说“我不喝咖啡”。该说法后来已被新的明确更正替代，不能作为当前习惯。记录者 alice 不能把合成玩家的习惯误认成自己的习惯。',
      '合成玩家的最新明确更正：我白天仍然喝淡咖啡，只在晚上不喝；不是完全戒咖啡，也不是不喝所有咖啡。这是合成玩家的当前习惯，优先于早先不准确的说法。',
      '合成玩家与 alice 约定：周六下午去植物交流会，alice 答应带蓝色雨伞，合成玩家准备空白观察表。目前只是尚未实施的计划，两者都没有出发，也没有参加或完成这场交流会。',
      '合成玩家补充：蓝色保险资料袋内只有一份空白保单样本，合成玩家没有实际购买保险，也从未提供任何真实保单编号。不要根据样本或资料袋猜造保险编号。',
    ];
    for (const content of corpus) store.saveMemory({ ...scope, content, diaryName: '资料', tags: ['合成玩家', '明确记录'] });
    store.saveMemory({ companionId: 'bob', conversationId: store.openPrivate('bob').id,
      content: `bob 独占资料声称合成玩家的保单编号为 ${foreignSecret}。只有 bob 见过这条内容，没有向 alice 分享；它不能被当作 alice 获权知道的保险信息。`, diaryName: '资料', tags: ['独占秘密', '保单编号'] });
    for (;;) {
      const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
      if (!job) break;
      store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true });
    }
    const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => store!.request(command);
    service = new CompanionMemoryService({ request, runtime: native.runtime, cacheRoot: path.join(root, 'views'), configFor: async () => config,
      fetchFn: modelFetch, busy: () => true, changed: () => undefined, report: error => errors.push(error instanceof Error ? error.name : 'unknown') });
    vi.spyOn(service, 'schedule').mockImplementation(() => undefined);
    const alice = store.request({ type: 'state' }).state!.companions.find(owner => owner.id === 'alice')!;
    const cases: Array<{ id: string; entry: 'recall' | 'search' | 'probe'; query: string; checks(text: string): Record<string, boolean> }> = [
      { id: 'material_location', entry: 'recall', query: '合成玩家把蓝色保险资料袋放在哪里？请保留具体位置。', checks: text => ({
        room: /书房/u.test(text), east: /东侧|东边|东面/u.test(text), furniture: /书柜/u.test(text), shelf: /最下层|最底层|底层/u.test(text),
      }) },
      { id: 'coffee_correction', entry: 'recall', query: '合成玩家现在喝咖啡吗？以最后的明确更正为准，区分白天和晚上。', checks: text => ({
        currentCoffee: /淡咖啡/u.test(text), daytime: /白天/u.test(text), eveningRestriction: /(?:晚上|夜间|夜里)[^。；\n]{0,30}不喝|不喝[^。；\n]{0,30}(?:晚上|夜间|夜里)/u.test(text),
        correctionRetained: /更正|优先|不是完全戒|并非完全戒|仍然喝|仍喝/u.test(text), attributedToPlayer: /合成玩家/u.test(text),
      }) },
      { id: 'unfinished_plan', entry: 'search', query: '合成玩家和 alice 已经参加完植物交流会了吗？还有哪些尚未实施的安排？', checks: text => ({
        plannedTime: /周六下午|星期六下午/u.test(text), umbrella: /蓝色雨伞/u.test(text), observationSheet: /空白观察表/u.test(text),
        unfinished: /尚未|没有出发|未出发|没有参加|未参加|尚未实施|只是.*计划/u.test(text),
        noCompletedClaim: !text.split(/[。；;\n]/u).some(clause => /已(?:经)?(?:参加|完成|出发)/u.test(clause) && !/未|没有|并非|不是|不代表/u.test(clause)),
      }) },
      { id: 'unknown_policy_number', entry: 'search', query: '合成玩家实际购买保险的保单编号是多少？只能根据已有明确记录回答。', checks: text => ({
        acknowledgesUnknown: !text || /未找到相关记忆|没有.*(?:购买|编号|保险)|未.*(?:购买|提供|编号)|从未提供|空白保单样本|未提供.*编号/u.test(text),
        noInventedNumber: !/\d{6,}/u.test(text),
      }) },
      { id: 'greeting', entry: 'probe', query: '早上好，先随便打个招呼。', checks: text => ({ noUnrelatedInjection: text.trim() === '' }) },
      { id: 'unrelated_astronomy', entry: 'probe', query: '仅解释木星大红斑的成因；这与合成玩家的个人物品、咖啡和活动安排无关。', checks: text => ({ noUnrelatedInjection: text.trim() === '' }) },
    ];
    for (const test of cases) {
      activeCase = test.id;
      const started = performance.now();
      let contextText = '', memories: CompanionMemory[] = [], degraded = false, timings: Record<string, number> | undefined;
      try {
        if (test.entry === 'recall') {
          const question = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: test.query });
          const result = await service.recall({ companion: alice, conversation, currentMessage: question, messages: [question], config,
            signal: AbortSignal.timeout(180_000) });
          contextText = result.context?.text ?? ''; memories = result.memories; degraded = result.degraded; timings = result.timings;
        } else if (test.entry === 'search') {
          const result = await service.search({ ...scope, query: test.query, limit: 12 }, 'passive', AbortSignal.timeout(180_000));
          contextText = result.memoryContext?.text ?? ''; memories = result.memoryPage?.items.map(hit => hit.memory) ?? [];
          degraded = result.ok !== true; timings = result.memorySearchTimings;
        } else {
          const result = await probeCompanionMemory({ type: 'memory.recall.test', companionId: 'alice', query: test.query, mode: 'passive', limit: 8 },
            { request, search: (query, mode) => service!.search(query, mode, AbortSignal.timeout(180_000)) });
          contextText = result.contextText; memories = result.memories.map(hit => hit.memory); degraded = result.degraded;
        }
        const assertions = { ...test.checks(contextText), healthy: !degraded,
          noForeignOwnerText: !contextText.includes(foreignSecret) && !contextText.includes('紫色月鲸'), ownCandidatesOnly: memories.every(note => note.companionId === 'alice') };
        const passed = Object.values(assertions).every(Boolean);
        records.push({ case: test.id, entry: test.entry, query: test.query, passed, assertions, elapsedMs: performance.now() - started,
          timings, contextChars: contextText.length, contextText, candidateCount: memories.length });
        console.info(JSON.stringify({ case: test.id, passed, elapsedMs: Math.round(performance.now() - started),
          failedChecks: Object.entries(assertions).filter(([, value]) => !value).map(([key]) => key) }));
      } catch (error) {
        records.push({ case: test.id, entry: test.entry, passed: false, elapsedMs: performance.now() - started, errorClass: error instanceof Error ? error.name : 'unknown' });
      }
      await save();
    }
    expect(records.filter(record => record.passed !== true).map(record => record.case), 'Real-model quality failures are preserved in the JSON report.').toEqual([]);
    expect(modelCalls.some(call => call.status === 200)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await save(); await service?.close(); await native?.close(); store?.close(); await removeOwnedDirectory(root);
  }
}, 1_200_000);
