import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { probeCompanionMemory } from '../../src/main/companions/memory-probe';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { CompanionMemory } from '../../src/shared/companions';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';
import { canonicalMemoryFiles } from '../fixtures/canonical-memory-files';
import { generateCompanionReply } from '../../src/main/companions/model';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { verifyDshDelivery } from '../../src/main/dsh/task-delivery';
import type { DshTaskResult } from '../../src/shared/dsh-tasks';
import { EXTENDED_RECALL_CASES } from '../fixtures/passive-recall-extended-cases';

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
  let files: Awaited<ReturnType<typeof canonicalMemoryFiles>> | undefined;
  let activeCase = 'setup', activeStage = 'focus';
  const livePromptRule = '验收文件指导：请依据当前文件和有来源的记忆自然简短作答，不补造缺失事实。';
  const liveFocusPromptRule = '验收文件标记：本次聚焦指导确实来自当前伙伴提示词文件。';
  const save = async () => {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ recordedAt: new Date().toISOString(), syntheticFixtureOnly: true, realUserDataModified: false,
      actualEncoder: true, actualChatModel: true, actualCanonicalOwnerFiles: true, actualFinalReplyModel: true,
      limitation: 'Six small synthetic cases; not a large-corpus recall or semantic duplicate-rate benchmark, and not the full Electron UI.',
      qualityCriteria: 'Required facts, correction precedence, unfinished-state preservation, unknowns, unrelated-topic and owner boundaries in both focused memory and final natural replies',
      providerRequestCount: modelCalls.filter(call => call.providerRequest === true).length,
      internalGatewayRequestCount: modelCalls.filter(call => call.providerRequest === false).length,
      budgetedRequestCount: store?.request({ type: 'model.resources.usage', companionId: 'alice' }).modelResourceUsage?.requests,
      records, modelCalls, errors }, null, 2));
  };
  try {
    const config = await realGlobalChatConfig(root);
    const modelFetch: typeof fetch = async (input, init) => {
      const started = performance.now();
      const response = await fetch(input, init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      const headers = new Headers(init?.headers), providerRequest = headers.get('authorization') === 'Bearer ' + config.apiKey
        || headers.get('x-api-key') === config.apiKey || headers.get('x-goog-api-key') === config.apiKey;
      // This duration ends at headers; query elapsedMs below includes the full
      // generation. Do not misrepresent streaming headers as model latency.
      const observed: Record<string, unknown> = { case: activeCase, stage: activeStage, providerRequest, status: response.status, headerElapsedMs: performance.now() - started,
        ...(activeStage === 'answer' ? { actualLivePromptRule: JSON.stringify(body.messages ?? body.input ?? []).includes(livePromptRule) } : {}),
        ...(activeStage === 'focus' ? { actualLiveFocusRule: JSON.stringify(body.messages ?? body.input ?? []).includes(liveFocusPromptRule) } : {}),
        streaming: body.stream === true, inputChars: JSON.stringify(body.messages ?? body.input ?? []).length };
      if (activeStage === 'answer') {
        // Synthetic visible answers only. Never persist reasoning/thinking
        // fields, raw provider envelopes, headers or connection credentials.
        const visible: string[] = [], text = await response.clone().text();
        const collect = (value: { choices?: Array<{ message?: { content?: unknown }; delta?: { content?: unknown } }> }) => {
          for (const choice of value.choices ?? []) { const content = choice.delta?.content ?? choice.message?.content; if (typeof content === 'string') visible.push(content); }
        };
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          for (const line of text.split('\n')) if (line.startsWith('data:') && line.slice(5).trim() !== '[DONE]') try { collect(JSON.parse(line.slice(5))); } catch { /* Transport validation remains in the production reader. */ }
        } else try { collect(JSON.parse(text)); } catch { /* Production reader owns invalid response handling. */ }
        observed.visibleAnswer = visible.join('').slice(0, 16000);
      }
      modelCalls.push(observed);
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
    files = await canonicalMemoryFiles(root, store, config);
    const ownerAssets = await files.profiles.load('alice'), replyModule = ownerAssets.modules.find(module => module.purposes.includes('companion_reply'))!;
    expect(replyModule).toBeDefined();
    await files.profiles.writePrompt({ companionId: 'alice', relativePath: replyModule.path, expectedRevision: replyModule.revision, content: replyModule.content + '\n' + livePromptRule });
    const focusModule = (await files.profiles.load('alice')).modules.find(module => module.purposes.includes('vcp_focus_guidance'));
    expect(focusModule).toBeDefined();
    await files.profiles.writePrompt({ companionId: 'alice', relativePath: focusModule!.path, expectedRevision: focusModule!.revision,
      content: focusModule!.content + '\n' + liveFocusPromptRule });
    const request = files.request;
    service = new CompanionMemoryService({ request, runtime: native.runtime, cacheRootFor: async owner => path.join(root, 'owner-assets', owner, '.认知索引', 'views'), configFor: files.configFor,
      validateFiles: (owner, receipts, window) => files!.live.validate(owner, receipts, window),
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
      activeCase = test.id; activeStage = 'focus';
      const started = performance.now();
      let contextText = '', memories: CompanionMemory[] = [], degraded = false, timings: Record<string, number> | undefined;
      try {
        const question = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: test.query });
        if (test.entry === 'recall') {
          const result = await service.recall({ companion: alice, conversation, currentMessage: question, messages: [question], config: await files.configFor(alice),
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
        activeStage = 'answer'; const answerStarted = performance.now();
        const answer = (await generateCompanionReply({ companion: alice, conversation, sourceMessage: question, messages: [question], memories,
          world: store.request({ type: 'world.snapshot' }).world,
          memoryRecall: { reasons: [], pending: false, degraded, context: { text: contextText, revision: 'quality-fixed-result', profileKey: 'quality-fixed-result' } } },
          await files.configFor(alice), AbortSignal.timeout(180000), { fetchFn: modelFetch, timeoutMs: 120000, loop: true, tools: [] })).text;
        const finalChecks = test.id === 'greeting' || test.id === 'unrelated_astronomy'
          ? { noUnrelatedPersonalMemory: !/保险资料袋|书房东侧|淡咖啡|植物交流会|蓝色雨伞/u.test(answer) }
          : Object.fromEntries(Object.entries(test.checks(answer)).filter(([key]) => key !== 'attributedToPlayer'));
        const answerAssertions = { ...finalChecks, noForeignOwnerText: !answer.includes(foreignSecret) && !answer.includes('紫色月鲸'),
          livePromptUsed: modelCalls.some(call => call.case === test.id && call.stage === 'answer' && call.actualLivePromptRule === true) };
        const passed = Object.values(assertions).every(Boolean) && Object.values(answerAssertions).every(Boolean);
        records.push({ case: test.id, entry: test.entry, query: test.query, passed, assertions, elapsedMs: performance.now() - started,
          timings, contextChars: contextText.length, contextText, candidateCount: memories.length, answer, answerAssertions, answerElapsedMs: performance.now() - answerStarted });
        console.info(JSON.stringify({ case: test.id, passed, elapsedMs: Math.round(performance.now() - started),
          failedChecks: [...Object.entries(assertions), ...Object.entries(answerAssertions)].filter(([, value]) => !value).map(([key]) => key) }));
      } catch (error) {
        const diagnostic = error instanceof Error ? error.message.split(config.apiKey).join('[redacted]').replace(/https?:\/\/[^\s)]+/gu, '[endpoint]').slice(0, 500) : 'unknown';
        records.push({ case: test.id, entry: test.entry, passed: false, elapsedMs: performance.now() - started, errorClass: error instanceof Error ? error.name : 'unknown', diagnostic });
      }
      await save();
    }
    expect(records.filter(record => record.passed !== true).map(record => record.case), 'Real-model quality failures are preserved in the JSON report.').toEqual([]);
    expect(modelCalls.some(call => call.status === 200)).toBe(true);
    const providerCalls = modelCalls.filter(call => call.providerRequest === true);
    expect(providerCalls.length).toBeGreaterThan(0);
    const actualFocusCalls = providerCalls.filter(call => call.stage === 'focus');
    expect(actualFocusCalls).toHaveLength(cases.length);
    expect(actualFocusCalls.every(call => call.actualLiveFocusRule === true), 'Every actual focus request must contain the current owner guidance file.').toBe(true);
    expect(store.request({ type: 'model.resources.usage', companionId: 'alice' }).modelResourceUsage?.requests).toBe(providerCalls.length);
    expect(errors).toEqual([]);
  } finally {
    await save(); await writeFile(output.replace(/\.json$/u, '-' + Date.now() + '.json'), await readFile(output));
    await service?.close(); await files?.close(); await native?.close(); store?.close(); await removeOwnedDirectory(root);
  }
}, 1_200_000);

/** Independent opt-in and report: preserve the original six-case baseline. */
it.skipIf(process.env.WORLDLINEBOX_PASSIVE_RECALL_QUALITY_EXTENDED_REAL !== '1')('checks twelve additional fixed semantic boundaries with actual Gemma, focus and final reply', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-passive-extended-'));
  const output = path.resolve('artifacts/vcp-validation/passive-recall-quality-extended-real-' + new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8) + '.json');
  const records: Array<Record<string, unknown>> = [], calls: Array<Record<string, unknown>> = [], sources: Array<Record<string, unknown>> = [], errors: string[] = [];
  const foreignSecret = 'EXTENDED_BOB_ONLY_f680a2_霜蓝月鲸', livePromptRule = '验收文件指导：请依据当前文件和有来源的记忆自然简短作答，不补造缺失事实。';
  let store: CompanionsStore | undefined, service: CompanionMemoryService | undefined, native: Awaited<ReturnType<typeof realMemoryRuntime>> | undefined;
  let files: Awaited<ReturnType<typeof canonicalMemoryFiles>> | undefined, activeCase = 'setup', stage = 'focus', status = 'running';
  let modelName: string | undefined, taskProof: Record<string, unknown> | undefined;
  const save = async () => {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ status, recordedAt: new Date().toISOString(), syntheticFixtureOnly: true, realUserDataModified: false,
      actualEncoder: true, encoderModel: native?.profile.modelName, actualChatModel: modelName, actualCanonicalOwnerFiles: true,
      actualFocusAndFinalReply: true, routeMode: 'production_delta_projection', judgeVersion: 'extended-v2-personal-feeling-synonym-with-universal-proof-negative', caseCount: EXTENDED_RECALL_CASES.length,
      limitations: ['Fixed small synthetic recall/final-response acceptance cases, not semantic duplicate-rate or corpus-scale statistics.',
        'Sources are host-seeded synthetic records; this run does not measure automatic capture quality or full Electron UI.',
        'Canonical delta hooks are connected for this run; this small fixture does not establish a latency percentile or large-corpus throughput.',
        'The artifact-negative control really runs an exiting process and the production file verifier; it does not run a long DSH agent session.'],
      criteria: 'Exact named facts, authorship, negation, conditions, epistemic limits, unfinished state, game/dream versus reality and artifact failure.',
      providerRequestCount: calls.filter(call => call.providerRequest).length,
      budgetedRequestCount: store?.request({ type: 'model.resources.usage', companionId: 'alice' }).modelResourceUsage?.requests,
      taskProof, sources, records, modelCalls: calls, errors }, null, 2));
  };
  try {
    const config = await realGlobalChatConfig(root); modelName = config.model;
    const observedFetch: typeof fetch = async (input, init) => {
      const started = performance.now(), response = await fetch(input, init), headers = new Headers(init?.headers);
      const providerRequest = headers.get('authorization') === 'Bearer ' + config.apiKey || headers.get('x-api-key') === config.apiKey || headers.get('x-goog-api-key') === config.apiKey;
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ case: activeCase, stage, providerRequest, status: response.status, headerElapsedMs: performance.now() - started,
        inputChars: JSON.stringify(body.messages ?? body.input ?? []).length,
        ...(stage === 'focus' && providerRequest ? { syntheticFocusInputs: body.messages ?? body.input ?? [],
          promptSourceMembership: sources.flatMap(source => (source.texts as string[]).map((text, index) => ({ case: source.case, part: index + 1,
            memoryId: (source.memoryIds as string[])[index], containsEntireBody: JSON.stringify(body.messages ?? body.input ?? []).includes(text) }))) } : {}),
        ...(stage === 'answer' ? { actualLivePromptRule: JSON.stringify(body.messages ?? body.input ?? []).includes(livePromptRule) } : {}) });
      return response;
    };
    const seeds: CompanionSeed[] = [{ id: 'alice', name: '阿澄', description: '合成内容验收伙伴', persona: '根据有据记录交流。', model: '', avatar: 'sister', active: true, proactive: false },
      { id: 'bob', name: '柏舟', description: '独立授权负对照', persona: '保留自己的获权资料。', model: '', avatar: 'sister', active: true, proactive: false }];
    store = new CompanionsStore(path.join(root, 'messages.sqlite'), seeds);
    const conversation = store.openPrivate('alice'), scope = { companionId: 'alice', conversationId: conversation.id };
    const workspace = path.join(root, 'task-result'); await mkdir(workspace);
    const processExit = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      child.once('error', reject); child.once('exit', code => code === null ? reject(new Error('Synthetic process did not exit normally.')) : resolve(code));
    });
    const report = path.join(workspace, 'final-report.txt'); await writeFile(report, 'DRAFT_ONLY');
    const result: DshTaskResult = { taskId: randomUUID(), instanceId: 'synthetic-actual-process', runtimeId: 'fixture-runtime', runtimeVersion: 'fixture', code: processExit,
      text: '进程返回0，随后必须核验产物。', artifacts: [{ path: report }] };
    let verificationError: string | undefined;
    try { await verifyDshDelivery(result, { format: 'text', artifacts: [{ path: 'final-report.txt', containsText: 'FINAL_REPORT' }] }, workspace); }
    catch (error) { verificationError = error instanceof Error ? error.message : String(error); }
    expect(processExit).toBe(0); expect(verificationError).toContain('required text');
    taskProof = { processExit, verificationPassed: false, verifier: 'verifyDshDelivery', verificationError,
      actualBytesHash: createHash('sha256').update(await readFile(report)).digest('hex'), requiredText: 'FINAL_REPORT', actualText: 'DRAFT_ONLY' };
    for (const test of EXTENDED_RECALL_CASES) {
      const texts = test.id === 'task_exit_zero_artifact_failed' ? [
        '合成受管长任务的实际收尾记录：生成终稿的进程退出码为0；真实文件final-report.txt只有DRAFT_ONLY，缺少交付合同要求的FINAL_REPORT。生产产物核验器已经拒绝该文件，因此交付尚未完成。下一步需要修正产物并重新核验，不能仅凭退出码0宣布交付。',
      ] : test.sources;
      const ids: string[] = [];
      for (const content of texts) {
        if (test.id === 'method_candidate_unverified') {
          const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content, replyDirective: 'none' });
          ids.push(store.request({ type: 'memory.record', ...scope, candidate: { content, tags: ['候选方法'], diaryName: '资料', sourceMessageIds: [source.id],
            evidence: [{ sourceMessageId: source.id, quote: content }], metadata: { autoTags: false },
            procedure: { applicability: '本轮合成受管备份目录', steps: ['建立冷备副本', '实际恢复', '核验RESTORE_OK产物'], limitations: ['尚未实际试验'],
              verification: { kind: 'artifact_delivery', artifactRequirements: [{ path: 'RESTORE_OK.txt', containsText: 'RESTORE_OK' }] } } } }).memories![0]!.id);
        } else ids.push(store.saveMemory({ ...scope, content, diaryName: test.id === 'dream_is_not_experience' ? '梦境' : '资料', tags: ['合成验收', test.id] }).id);
      }
      sources.push({ case: test.id, memoryIds: ids, texts });
    }
    store.saveMemory({ companionId: 'bob', conversationId: store.openPrivate('bob').id, content: foreignSecret + '仅柏舟获权知道，不能提供给阿澄。', tags: ['私有负对照'] });
    for (;;) { const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!job) break; store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true }); }
    files = await canonicalMemoryFiles(root, store, config);
    const assets = await files.profiles.load('alice'), reply = assets.modules.find(module => module.purposes.includes('companion_reply'))!;
    await files.profiles.writePrompt({ companionId: 'alice', relativePath: reply.path, expectedRevision: reply.revision, content: reply.content + '\n' + livePromptRule });
    native = await realMemoryRuntime(root, undefined, { modelFetch: observedFetch });
    service = new CompanionMemoryService({ request: files.request, runtime: native.runtime, cacheRootFor: async owner => path.join(root, 'owner-assets', owner, '.认知索引', 'views'),
      ...files.projection,
      configFor: files.configFor, validateFiles: (owner, receipts, window) => files!.live.validate(owner, receipts, window), fetchFn: observedFetch,
      busy: () => true, changed: () => undefined, report: error => errors.push(error instanceof Error ? error.message.split(config.apiKey).join('[redacted]').slice(0, 500) : 'unknown') });
    vi.spyOn(service, 'schedule').mockImplementation(() => undefined);
    const alice = store.state().companions.find(owner => owner.id === 'alice')!;
    for (const test of EXTENDED_RECALL_CASES) {
      activeCase = test.id; stage = 'focus'; const started = performance.now();
      try {
        const question = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: test.query, replyDirective: 'none' });
        const recalled = await service.recall({ companion: alice, conversation, currentMessage: question, messages: [question], config: await files.configFor(alice), signal: AbortSignal.timeout(180000) });
        const focused = recalled.context?.text ?? '', assertions = { ...test.checks(focused), healthy: !recalled.degraded,
          noForeignOwner: !focused.includes(foreignSecret) && !focused.includes('霜蓝月鲸'), ownCandidates: recalled.memories.every(note => note.companionId === 'alice'),
          fixedReceiptCurrent: await service.contextValid(scope, recalled.context) };
        stage = 'answer'; const answerStarted = performance.now();
        const answered = await generateCompanionReply({ companion: alice, conversation, sourceMessage: question, messages: [question], memories: recalled.memories,
          world: store.request({ type: 'world.snapshot' }).world, memoryRecall: recalled }, await files.configFor(alice), AbortSignal.timeout(180000),
          { fetchFn: observedFetch, timeoutMs: 120000, loop: true, tools: [] });
        const answer = answered.text, answerAssertions = { ...test.checks(answer), noForeignOwner: !answer.includes(foreignSecret) && !answer.includes('霜蓝月鲸'),
          fixedReceiptStillCurrent: await service.contextValid(scope, recalled.context),
          actualOwnerPrompt: calls.some(call => call.case === test.id && call.stage === 'answer' && call.actualLivePromptRule === true) };
        const passed = Object.values(assertions).every(Boolean) && Object.values(answerAssertions).every(Boolean);
        records.push({ case: test.id, query: test.query, passed, assertions, focused, answer, answerAssertions,
          elapsedMs: performance.now() - started, answerElapsedMs: performance.now() - answerStarted, timings: recalled.timings,
          actualMemoryIds: recalled.memories.map(note => note.id), nativeEvidence: recalled.context?.evidence, proceduralStatus: recalled.context?.proceduralStatus });
        console.info(JSON.stringify({ extendedCase: test.id, passed, failedChecks: [...Object.entries(assertions), ...Object.entries(answerAssertions)].filter(([, value]) => !value).map(([key]) => key) }));
      } catch (error) { records.push({ case: test.id, query: test.query, passed: false, error: error instanceof Error ? error.message.split(config.apiKey).join('[redacted]').replace(/https?:\/\/[^\s)]+/gu, '[endpoint]').slice(0, 1000) : 'unknown' }); }
      await save();
    }
    status = records.every(record => record.passed === true) ? 'passed' : 'failed'; await save();
    expect(records).toHaveLength(12);
    expect(records.filter(record => record.passed !== true).map(record => record.case), 'Fixed extended checks failed; raw focused text and final replies remain in the independent report.').toEqual([]);
    expect(store.request({ type: 'model.resources.usage', companionId: 'alice' }).modelResourceUsage?.requests).toBe(calls.filter(call => call.providerRequest).length);
    expect(errors).toEqual([]);
  } catch (error) { status = 'failed'; throw error; }
  finally { await save(); await service?.close(); await files?.close(); await native?.close(); store?.close(); await removeOwnedDirectory(root); }
}, 1_800_000);
