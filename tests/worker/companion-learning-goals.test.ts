import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionLearningGoal } from '../../src/shared/companion-learning-goals';
import { nextCompanionLearningGoalAt } from '../../src/shared/companion-learning-goal-schedule';
import { createCompanionLearningGoalService, type CompanionLearningGoalIntegrationOptions } from '../../src/main/companions/learning-goal-integration';
import type { CompanionLearningGoalService } from '../../src/main/companions/learning-goal-service';
import type { CompanionLearningAssets } from '../../src/main/companions/learning-service';
import type { AssetSummary } from '../../src/shared/asset-types';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { CompanionModelConfig } from '../../src/main/companions/model';
import { CompanionModelAdmissionError } from '../../src/main/companions/model-quota';
import { canonicalMemoryFiles } from '../fixtures/canonical-memory-files';
import { learningTestInput } from '../../src/companions/learning-goal-test-protocol';
import type { CompanionMemoryFileReceipt } from '../../src/shared/companion-memory-files';
import type { CompanionJobDisposition } from '../../src/shared/companion-job-control';

const model = vi.hoisted(() => ({ structured: vi.fn() }));
const roots: string[] = [], stores = new Set<CompanionsStore>(), services = new Set<CompanionLearningGoalService>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-22T10:00:00Z'); model.structured.mockReset(); });
afterEach(async () => { for (const service of services) await service.close(); services.clear(); for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-learning-goals-')); roots.push(root);
  const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '核对来源后再学习。', model: '', avatar: 'sister', proactive: false, active: true }));
  const file = path.join(root, 'state.sqlite'); let store = new CompanionsStore(file, seeds); stores.add(store);
  const grant = store.request({ type: 'learning.grant', companionId: 'alice', libraryId: 'library', libraryName: '获准教材', libraryPath: root, autonomous: false, intervalMinutes: 30 }).learning!.grants[0]!;
  const create = (text = '持续研究核实资料的方法，逐轮练习并复盘，不要自动结束。', companionId = 'alice', windows: CompanionLearningGoal['schedule']['windows'] = []) => store.request({ type: 'learning.goals.create', companionId, text,
    materials: companionId === 'alice' ? [{ kind: 'library', grantId: grant.id }] : [], allowWeb: false, schedule: { intervalMinutes: 5, windows, timeZone: 'UTC' } }).learningGoal!;
  const rounds = (id: string, cursor = 0, limit = 20) => store.request({ type: 'learning.goals.rounds', companionId: 'alice', id, cursor, limit }).learningRounds!;
  const claim = () => store.request({ type: 'learning.goals.claim' }).learningGoalJob;
  return { root, file, seeds, get store() { return store; }, grant, create, rounds, claim,
    reopen() { store.close(); stores.delete(store); store = new CompanionsStore(file, seeds); stores.add(store); } };
}

it('governs the original failed learning round through restart and allows a healthy goal to pass the parked one', () => {
  const f = fixture(), bad = f.create('需保留原轮次的坏处理'), inspect = (id: string) => f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'learning_goal', id }).jobDisposition!;
  let id = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const job = f.claim()!; expect(job.goal.id).toBe(bad.id); if (!id) id = job.round.id; expect(job.round.id).toBe(id);
    f.store.request({ type: 'learning.goals.finish', id: bad.id, leaseToken: job.leaseToken, failureKind: 'processing', retryAfterMs: 1000,
      round: { ...job.round, status: 'failed', error: 'Actual fixed-round processing failure.' } });
    vi.setSystemTime(Date.now() + 1001);
  }
  const held = inspect(id); expect(held).toMatchObject({ state: 'parked', failureCount: 3, cycleFailureCount: 3, attemptCount: 3 });
  f.reopen(); expect(inspect(id)).toEqual(held);
  f.store.request({ type: 'learning.goals.run', companionId: 'alice', id: bad.id, expectedRevision: bad.revision });
  expect(f.claim()).toBeUndefined();
  const healthy = f.create('后续独立学习目标'), next = f.claim()!;
  expect(next.goal.id).toBe(healthy.id); expect(next.round.id).not.toBe(id);
  const command = (current: CompanionJobDisposition, action: 'resume' | 'park' | 'abandon') => ({ type: 'jobs.control' as const, ownerId: 'alice', kind: 'learning_goal' as const,
    id: current.id, inputVersion: current.inputVersion, expectedRevision: current.revision, operationId: randomUUID(), action });
  const resume = command(held, 'resume'), resumed = f.store.request(resume).jobDisposition!;
  expect(resumed).toMatchObject({ state: 'pending', failureCount: 3, cycleFailureCount: 0 });
  expect(f.store.request(resume).jobDisposition).toEqual(resumed);
  const retry = f.claim()!; expect(retry.round.id).toBe(id); expect(inspect(id).attemptCount).toBe(4);
  const abandoned = f.store.request(command(inspect(id), 'abandon')).jobDisposition!;
  expect(abandoned).toMatchObject({ state: 'abandoned', failureCount: 3, attemptCount: 4 });
  f.store.request({ type: 'learning.goals.finish', id: bad.id, leaseToken: retry.leaseToken, failureKind: 'processing', round: { ...retry.round, status: 'failed', error: 'Late result cannot re-open abandoned work.' } });
  expect(inspect(id)).toEqual(abandoned);
  expect(f.store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'learning_goal', states: ['abandoned'], limit: 50 }).jobPage?.items).toEqual([abandoned]);
  expect(f.rounds(bad.id).items[0]?.status).toBe('abandoned');
});
function build(f: ReturnType<typeof fixture>, overrides: Partial<Pick<CompanionLearningGoalIntegrationOptions, 'validateWrite' | 'request' | 'configFor' | 'fetchFn'>> = {}, resolveAssetContext?: CompanionModelConfig['resolveAssetContext']) {
  const material = { text: '先核对资料出处，再记录结论。', claim: '先核对资料出处。', badEvidence: false, unknownAnswer: false };
  const asset = { assetId: 'asset-one', displayName: '教材.md', currentRevisionId: 'revision', relativeFilePath: '教材.md', mediaType: 'text' } as AssetSummary;
  const assets: CompanionLearningAssets = { catalog: async () => [], grant: async () => ({ libraryName: '获准教材', libraryPath: f.root }),
    page: vi.fn(async () => ({ assets: [asset], hasMore: false })), read: vi.fn(async () => ({ content: material.text, revisionId: sha(material.text), truncated: false })) };
  const request = vi.fn(async (command: CompanionStorageCommand) => f.store.request(command));
  // This is a deterministic adapter unit test. The opt-in real-model fixture uses actual VCP.
  const memory = { schedule: vi.fn(() => { let outbox; while ((outbox = f.store.request({ type: 'memory.outbox.claim' }).memoryOutbox)) f.store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true }); }),
    contextValid: vi.fn(async () => true),
    search: vi.fn(async (query: { companionId: string; conversationId: string }) => {
    const page = f.store.request({ type: 'memory.browse', companionId: query.companionId, conversationId: query.conversationId }).memoryPage!;
    return { ok: true, memoryPage: page, memoryContext: { text: page.items.map(hit => hit.memory.content).join('\n'), revision: 'fixture', profileKey: 'fixture',
      evidence: { capturedAt: new Date().toISOString(), corpusHash: sha(JSON.stringify(page.items)), dependencyCoverage: 'complete' as const, dependencies: page.items.map(({ memory }) => ({ id: memory.id, version: memory.version })),
        frozenDependencies: page.items.map(({ memory }) => ({ id: memory.id, contentRevision: memory.contentRevision,
          sources: memory.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) })) } } };
  }) };
  model.structured.mockImplementation(async (input: { system: string; user: string }) => {
    const data = JSON.parse(input.user).data;
    const stage = /阶段=(\w+)/u.exec(input.system)?.[1];
    if (stage === 'plan') return { focus: '核实资料', questions: ['该怎样核对？'], searchQueries: [] };
    if (stage === 'learn') return { summary: material.claim, claims: [{ text: material.claim, evidence: [{ sourceId: data.reads[0].id, quote: material.text }] }] };
    if (stage === 'consolidate') return { action: 'revise', noteId: data.existing[0].id, content: data.existing[0].content + '\n\n新材料补充：' + material.claim, reason: '同一学习目标的新资料补充，保留旧知识与来源。' };
    if (stage === 'questions') return { questions: ['本轮材料建议怎么做？'] };
    if (stage === 'answer') return { answers: [!material.unknownAnswer && data.recalled.includes(material.claim) ? material.claim : '不知道'] };
    if (stage === 'assess') return { evaluations: [{ evaluation: 'supported', rationale: '模型自评；引文存在不证明客观正确。', evidence: [{ sourceId: data.reads[0].id, quote: material.badEvidence ? 'THIS_WAS_NOT_READ' : material.text }] }], gaps: ['还没有核实外部交叉来源。'], nextPlan: ['下一轮核对另一份材料，并检验矛盾。'] };
    throw new Error('Unexpected stage ' + stage);
  });
  const report = vi.fn();
  const service = createCompanionLearningGoalService({ request, assets, files: { readFile: vi.fn() }, attachmentPath: vi.fn(), managedRoots: [path.join(f.root, 'managed')], memory,
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'unit-only', apiKey: 'unit-only', ...(resolveAssetContext ? { resolveAssetContext } : {}) }),
    fetchFn: async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      const value = await model.structured({ system: wire.messages[0].content, user: wire.messages[1].content });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
    }, changed: vi.fn(), report, ...overrides }); services.add(service);
  return { service, material, assets, request, memory, report };
}
async function completed(f: ReturnType<typeof fixture>, service: CompanionLearningGoalService, goal: CompanionLearningGoal, ordinal: number) {
  await service.tick(); await vi.waitFor(() => { const round = f.rounds(goal.id).items[0]; expect(round, round?.error).toMatchObject({ ordinal, status: 'completed' }); });
}

it.each(['plan', 'learn', 'consolidate', 'questions', 'answer', 'assess'] as const)(
  'repairs a malformed %s stage through the shared shape gate while retaining real learning evidence', async stage => {
    const f = fixture(), goal = f.create(), b = build(f), original = model.structured.getMockImplementation()!;
    let corrupted = false, repaired = 0;
    model.structured.mockImplementation(async (context: { system: string; user: string }) => {
      const payload = JSON.parse(context.user);
      if (payload.purpose === 'companion_structured_repair') {
        repaired++; expect(payload.structuredRepair.originalPurpose).toBe('companion_learning_' + stage);
        expect(payload.validationErrors.length).toBeGreaterThan(0);
        expect(payload.originalRequest).toMatchObject({ system: expect.any(String), user: expect.any(String) });
        return original(payload.originalRequest);
      }
      if (!corrupted && payload.purpose === 'companion_learning_' + stage) { corrupted = true; return {}; }
      return original(context);
    });
    await completed(f, b.service, goal, 1);
    if (stage === 'consolidate') {
      b.material.text = '先核对新资料的出处，再与旧资料交叉核实。'; b.material.claim = '新旧资料应交叉核实。';
      vi.setSystemTime(Date.now() + 5 * 60000); await completed(f, b.service, goal, 2);
    }
    expect(corrupted).toBe(true); expect(repaired).toBe(1); expect(b.report).not.toHaveBeenCalled();
    const latest = f.rounds(goal.id).items[0]!;
    expect(latest.memoryIds).toHaveLength(1); expect(latest.reads[0]!.sourceMessageId).toBeTruthy();
    expect(latest.claims.every(claim => claim.evidence.every(item => latest.reads.some(read => read.id === item.sourceId && read.excerpt.includes(item.quote))))).toBe(true);
  });

it.each(['complete', 'external_edit', 'source_withdrawal'] as const)('resumes actual HTTP stages across restart and temporary host unavailability without repeating successful self-test stages (%s)', async outcome => {
  const f = fixture(), goal = f.create(), httpStages: string[] = [], httpErrors: string[] = [], days: Array<Record<string, unknown>> = [];
  const server = createServer((incoming, outgoing) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')), input = { system: wire.messages[0].content, user: wire.messages[1].content };
    httpStages.push(/阶段=(\w+)/u.exec(input.system)?.[1] ?? 'unknown');
    const value = await model.structured(input);
    outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
  })().catch(error => { httpErrors.push(String(error)); outgoing.writeHead(500); outgoing.end(String(error)); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local HTTP fixture address.');
  const config: CompanionModelConfig = { apiFormat: 'openai_chat', model: 'deterministic-learning-checkpoint-fixture', baseUrl: 'http://127.0.0.1:' + address.port, apiKey: 'synthetic-fixture-only' };
  let actual = await canonicalMemoryFiles(f.root, f.store, config), failure: unknown;
  const artifact = { status: 'running', outcome, actualHttp: true, actualSqliteCheckpoints: true, actualCanonicalOwnerFiles: true,
    nativeRecall: 'controlled orchestration fixture; not Rust ranking or encoder quality', realPaidProvider: false, httpStages, days };
  try {
    let roundId = '', memoryId = '', recalls = 0;
    for (let day = 0; day < 5; day++) {
      const httpBefore = httpStages.length;
      const withdrawn = day === 3 && outcome !== 'complete';
      if (withdrawn && outcome === 'external_edit') {
        const receipt = f.rounds(goal.id).items[0]!.selfTestProgress!.recall!.value.executionReadset.contexts.flatMap(context => context.fileReceipts ?? [])[0]!;
        writeFileSync(path.join(f.root, 'owner-assets', 'alice', receipt.path), 'OUTSIDE_EDIT_NOT_THE_FIXED_RECALL');
      }
      if (withdrawn && outcome === 'source_withdrawal') f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: 'world_alice',
        sourceMessageIds: [f.rounds(goal.id).items[0]!.reads[0]!.sourceMessageId!] });
      const b = build(f, { request: actual.request, configFor: async owner => {
        const current = await actual.configFor(owner), resolve = current.resolveAssetContext;
        return { ...current, resolveAssetContext: async (context, kind) => {
          if (!resolve) throw new Error('Canonical fixture resolver is missing.');
          let resolved;
          try { resolved = await resolve(context, kind); } catch (error) { httpErrors.push('canonical: ' + String(error)); throw error; }
          // Test-only host availability: stop between real provider stages.
          // This is not a persisted request/day/token/cost allowance.
          if (httpStages.length >= day + 1) throw new CompanionModelAdmissionError('queue_full', 'Controlled host queue is temporarily unavailable.', new Date(Date.now() + 86400000).toISOString());
          return resolved;
        } };
      }, fetchFn: fetch });
      b.memory.search.mockImplementation(async query => {
        const page = (await actual.request({ type: 'memory.browse', companionId: query.companionId, conversationId: query.conversationId })).memoryPage!;
        const materialized = await actual.live.materialize(query.companionId, page.items.map(item => item.memory));
        return { ok: true, memoryPage: page, memoryContext: { text: materialized.notes.map(note => note.content).join('\n'), revision: 'controlled-canonical-recall', profileKey: 'controlled-canonical',
          fileReceipts: materialized.receipts, evidence: { capturedAt: new Date().toISOString(), corpusHash: sha(JSON.stringify(materialized.notes)), dependencyCoverage: 'complete',
            dependencies: materialized.notes.map(memory => ({ id: memory.id, version: memory.version })),
            frozenDependencies: materialized.notes.map(memory => ({ id: memory.id, contentRevision: memory.contentRevision,
              sources: memory.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) })) } } };
      });
      b.memory.contextValid.mockImplementation(async (_scope?: unknown, context?: { fileReceipts?: readonly CompanionMemoryFileReceipt[] }) =>
        !context?.fileReceipts?.length || await actual.live.validate('alice', context.fileReceipts));
      await b.service.tick();
      await vi.waitFor(() => expect((b.service as unknown as { jobs: Map<string, unknown> }).jobs.size).toBe(0), { timeout: 10000 });
      // An unauthorized byte edit is a registry conflict, not a user stop.
      // The later zero-request assertion still proves it cannot resume or pay
      // for another answer using the changed fixed recall.
      const reported:unknown=b.report.mock.calls.at(-1)?.[0];
      const diagnostic=reported instanceof Error?JSON.stringify({name:reported.name,code:'code' in reported?reported.code:undefined,cause:reported.cause,stack:reported.stack}):String(reported??'');
      expect(f.rounds(goal.id).items[0]!.status, f.rounds(goal.id).items[0]!.error + '\n' + httpErrors.join('\n')+'\n'+diagnostic).toBe(withdrawn ? outcome === 'external_edit' ? 'deferred' : 'stale' : day < 4 ? 'deferred' : 'completed');
      if (withdrawn) expect(f.rounds(goal.id).items[0]!.disposition?.failureCount).toBe(0);
      if (withdrawn && outcome === 'external_edit') expect(f.rounds(goal.id).items[0]!.error)
        .toContain('固定来源文件当前不可核验，等待原文件恢复；尚未发送新的自测请求。');
      const round = f.rounds(goal.id).items[0]!; if (!roundId) roundId = round.id; expect(round.id).toBe(roundId);
      if (round.memoryIds.length) { if (!memoryId) memoryId = round.memoryIds[0]!; expect(round.memoryIds).toEqual([memoryId]); }
      const requests = httpStages.length - httpBefore;
      expect(requests).toBe(withdrawn ? 0 : 1);
      days.push({ day, status: round.status, roundId, memoryIds: round.memoryIds, completedTestStages: Object.keys(round.selfTestProgress ?? {}).filter(key => ['questions', 'recall', 'answer', 'assess'].includes(key)), actualHttpRequests: requests });
      expect(httpStages).toEqual(['plan', 'learn', 'questions', 'answer', 'assess'].slice(0, withdrawn ? 3 : day + 1));
      recalls += b.memory.search.mock.calls.filter(([query]) => (query as { query?: string }).query === '本轮材料建议怎么做？').length;
      if (!withdrawn) expect(b.report).not.toHaveBeenCalled();
      await b.service.close(); services.delete(b.service); await actual.close();
      if (withdrawn) { expect(round.selfTest).toBeUndefined(); artifact.status = 'passed'; return; }
      if (day < 4) { f.reopen(); vi.setSystemTime(Date.now() + 24 * 3600000); actual = await canonicalMemoryFiles(f.root, f.store, config); }
    }
    const final = f.rounds(goal.id).items[0]!;
    expect(final.selfTest?.questions[0]).toMatchObject({ answer: '先核对资料出处。', evaluation: 'supported' });
    expect(final.selfTestProgress).toMatchObject({ questions: {}, recall: {}, answer: {}, assess: {} });
    expect(recalls).toBe(1); expect(f.store.listMemory('alice')).toHaveLength(1); artifact.status = 'passed';
    f.store.request({ type: 'learning.goals.update', companionId: 'alice', id: goal.id, expectedRevision: goal.revision, text: '后来明确指定的新学习目标。' });
    const originalReceipt = f.rounds(goal.id).items.find(round => round.id === roundId)!;
    expect(originalReceipt.selfTest).toEqual(final.selfTest); expect(originalReceipt.selfTestProgress?.goalInput.text).toBe(goal.text);
  } catch (error) { failure = error; artifact.status = 'failed'; throw error; }
  finally {
    const directory = path.resolve('artifacts/vcp-validation'); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'learning-paid-checkpoints-' + outcome + '-' + new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8) + '.json'), JSON.stringify({ ...artifact, ...(failure ? { error: failure instanceof Error ? failure.stack : String(failure), round: f.rounds(goal.id).items[0] } : {}) }, null, 2));
    await actual.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 60000);

it('counts an ordinary processing error even when its prose imitates a typed canonical-file conflict',async()=>{
  const f=fixture(),goal=f.create(),failure=new Error('正文不是合法提交字节，拒绝外部改写。');
  const b=build(f,{validateWrite:async()=>{throw failure;}});
  await b.service.tick();await vi.waitFor(()=>expect((b.service as unknown as {jobs:Map<string,unknown>}).jobs.size).toBe(0),{timeout:10000});
  expect(f.rounds(goal.id).items[0]).toMatchObject({status:'failed',disposition:{failureCount:1,cycleFailureCount:1}});
  expect(b.report).toHaveBeenCalledWith(failure);expect(f.store.listMemory('alice')).toHaveLength(0);
});

it('rejects forged, reordered, rebound or foreign-lease self-test receipts and cancels a deferred prefix when its goal changes', async () => {
  const f = fixture(), goal = f.create(), deadline = Date.now() + 3600000;
  const b = build(f, {}, async context => {
    if (JSON.parse(context.user).purpose === 'companion_learning_answer') throw new CompanionModelAdmissionError('queue_full', 'Unsent answer', new Date(deadline).toISOString());
    return context;
  });
  await b.service.tick(); await vi.waitFor(() => expect(f.rounds(goal.id).items[0]?.status).toBe('deferred'));
  await b.service.drain('alice'); vi.setSystemTime(deadline + 1);
  const job = f.claim()!, progress = job.round.selfTestProgress!;
  expect(progress).toMatchObject({ questions: {}, recall: {} }); expect(progress.answer).toBeUndefined();
  const answer = { stage: 'answer' as const, inputHash: learningTestInput(progress.basisHash, job.round, 'answer'), value: { answers: ['未经模型实际完成的答案'] } };
  const write = (step: Parameters<CompanionsStore['request']>[0] & { type: 'learning.goals.test.checkpoint' }) => f.store.request(step);
  expect(() => f.store.request({ type: 'learning.goals.checkpoint', id: goal.id, leaseToken: job.leaseToken,
    round: { ...job.round, selfTestProgress: { ...progress, answer: { inputHash: answer.inputHash, value: answer.value } } } })).toThrow('宿主逐步回执');
  expect(() => write({ type: 'learning.goals.test.checkpoint', id: goal.id, leaseToken: job.leaseToken + '_foreign', sourceChecksums: progress.sourceChecksums, step: answer })).toThrow('取消');
  expect(() => write({ type: 'learning.goals.test.checkpoint', id: goal.id, leaseToken: job.leaseToken, sourceChecksums: {}, step: answer })).toThrow('已登记来源');
  expect(() => write({ type: 'learning.goals.test.checkpoint', id: goal.id, leaseToken: job.leaseToken, sourceChecksums: progress.sourceChecksums,
    step: { ...answer, inputHash: 'f'.repeat(64) } })).toThrow('输入签名');
  expect(() => write({ type: 'learning.goals.test.checkpoint', id: goal.id, leaseToken: job.leaseToken, sourceChecksums: progress.sourceChecksums,
    step: { stage: 'assess', inputHash: 'f'.repeat(64), value: { review: { evaluations: [], gaps: [], nextPlan: ['不能跳过答题'] } } } })).toThrow('前序回执');
  expect(() => write({ type: 'learning.goals.test.checkpoint', id: goal.id, leaseToken: job.leaseToken, sourceChecksums: progress.sourceChecksums,
    step: { stage: 'questions', inputHash: progress.questions!.inputHash, value: { questions: ['换绑成另一个问题'] } } })).toThrow('不能覆盖');
  expect(() => write({ type: 'learning.goals.test.checkpoint', id: goal.id, leaseToken: job.leaseToken, sourceChecksums: progress.sourceChecksums,
    step: { stage: 'recall', inputHash: progress.recall!.inputHash, value: { text: '伪造有回忆却没有任何来源', candidateMemoryIds: [],
      executionReadset: { schema: 'worldlinebox.companion-execution-readset-v1', companionId: 'alice', conversationId: 'world_alice', complete: true,
        memories: [], sources: [], contexts: [], knowledgeReads: [], topics: [] } } } })).toThrow('真实来源凭证');
  expect(f.rounds(goal.id).items[0]!.selfTestProgress?.answer).toBeUndefined();
  f.store.request({ type: 'learning.goals.finish', id: goal.id, leaseToken: job.leaseToken, round: { ...job.round, status: 'deferred' }, retryAfterMs: 1000 });
  f.store.request({ type: 'learning.goals.update', companionId: 'alice', id: goal.id, expectedRevision: goal.revision, text: '新的明确学习目标不能沿用旧自测输入。' });
  const next = f.claim()!; expect(next.round.id).not.toBe(job.round.id); expect(next.round.selfTestProgress).toBeUndefined();
  const cancelled = f.rounds(goal.id).items.find(round => round.id === job.round.id)!;
  expect(cancelled.status).toBe('cancelled'); expect(cancelled.selfTestProgress).toBeUndefined();
});

it('routes every learning role stage to its canonical purpose and leaves behavior to the actual owner resolver', async () => {
  const f = fixture(), goal = f.create(), purposes = new Set<string>();
  const b = build(f, {}, async context => {
    const data = JSON.parse(context.user); purposes.add(data.purpose);
    expect(data.purpose).toMatch(/^companion_learning_/u);
    expect(context.system).toContain('学习执行合同'); expect(context.system).toContain('evidence必须逐字引用真实sourceId');
    expect(context.system).not.toContain('耐心理解本轮实际读到的材料');
    return { ...context, system: 'FILE_ONLY_LEARNING_BEHAVIOR_本轮按我的方式开展学习。\n' + context.system };
  });
  await completed(f, b.service, goal, 1);
  b.material.text = '新材料要求按条件交叉核实第二个出处。'; b.material.claim = '按条件交叉核实第二个出处。';
  vi.setSystemTime(Date.now() + 5 * 60000); await completed(f, b.service, goal, 2);
  expect([...purposes].sort()).toEqual(['answer', 'assess', 'consolidate', 'learn', 'plan', 'questions'].map(stage => 'companion_learning_' + stage).sort());
  expect(model.structured.mock.calls.every(([input]) => input.system.includes('FILE_ONLY_LEARNING_BEHAVIOR'))).toBe(true);
});
it('defers unsent host queue refusal until its deadline and resumes a real goal round without fabricated reading or self-test', async () => {
  const f = fixture(), goal = f.create(), deadline = Date.parse('2026-10-23T00:00:00Z');
  let available = false;
  const b = build(f, {}, async context => {
    if (!available) throw new CompanionModelAdmissionError('queue_full', '本地模型队列暂不可用。', new Date(deadline).toISOString());
    return context;
  });
  await b.service.tick();
  await vi.waitFor(() => expect(f.rounds(goal.id).items[0]).toMatchObject({ status: 'deferred', reads: [], memoryIds: [], error: '本地模型队列暂不可用。' }));
  expect(f.rounds(goal.id).items[0]!.selfTest).toBeUndefined(); expect(b.report).not.toHaveBeenCalled();
  expect(model.structured).not.toHaveBeenCalled(); expect(b.assets.read).not.toHaveBeenCalled();
  const current = f.store.request({ type: 'learning.goals.list', companionId: 'alice' }).learningGoals!.items[0]!;
  expect(Date.parse(current.nextAt)).toBe(deadline);
  for (let tick = 0; tick < 10; tick++) { vi.setSystemTime(Date.now() + 60_000); await b.service.tick(); }
  expect(f.rounds(goal.id).items).toHaveLength(1);
  available = true; vi.setSystemTime(deadline); await completed(f, b.service, current, 1);
  expect(f.rounds(goal.id).items).toHaveLength(1);
  expect(f.rounds(goal.id).items[0]!.reads).toHaveLength(1);
});

it('runs persistently, reuses unchanged knowledge, revises changed same-goal knowledge with preserved source history, and self-tests through VCP recall', async () => {
  const f = fixture(), goal = f.create(), b = build(f); await completed(f, b.service, goal, 1);
  const first = f.rounds(goal.id).items[0]!;
  expect(first.reads[0]).toMatchObject({ excerpt: b.material.text, contentHash: sha(b.material.text), grantId: f.grant.id });
  expect(first.integration).toMatchObject({ action: 'recorded', version: 1 }); expect(first.selfTest?.questions[0]?.evaluation).toBe('supported');
  expect(first.memoryIds).toHaveLength(1); const noteId = first.memoryIds[0]!;
  expect(f.store.request({ type: 'memory.library.read', companionId: 'alice', id: noteId }).memoryRead?.memory.sources[0]?.messageId).toBe(first.reads[0]!.sourceMessageId);
  vi.setSystemTime(Date.now() + 5 * 60000); await completed(f, b.service, goal, 2);
  expect(f.rounds(goal.id).items[0]!.integration).toMatchObject({ action: 'reused', noteId, version: 1 });
  b.material.text = '雨天出门前要携带雨伞，并核对天气来源。'; b.material.claim = '雨天出门前要带伞。';
  vi.setSystemTime(Date.now() + 5 * 60000); await completed(f, b.service, goal, 3);
  expect(f.rounds(goal.id).items[0]!.integration).toMatchObject({ action: 'revised', noteId, version: 2 });
  const note = f.store.request({ type: 'memory.library.read', companionId: 'alice', id: noteId }).memoryRead!.memory;
  expect(note.sources).toHaveLength(2); expect(note.sources.some(source => source.messageId === first.reads[0]!.sourceMessageId)).toBe(true);
  const current = f.store.request({ type: 'learning.goals.list', companionId: 'alice' }).learningGoals!.items[0]!;
  expect(current).toMatchObject({ state: 'active', totalRounds: 3, phase: 'idle' }); expect(Date.parse(current.nextAt)).toBeGreaterThan(Date.now());
  expect(current.lastRound?.reads).toEqual([]); expect(current.lastRound?.selfTest).toBeUndefined();
  const answerInputs = model.structured.mock.calls.filter(([input]) => input.system.includes('阶段=answer')).map(([input]) => JSON.parse(input.user));
  expect(answerInputs).toHaveLength(3); for (const input of answerInputs) { expect(input.context).toBeUndefined(); expect(Object.keys(input.data).sort()).toEqual(['questions', 'recalled']); }
  const plans = model.structured.mock.calls.filter(([input]) => input.system.includes('阶段=plan')).map(([input]) => JSON.parse(input.user));
  expect(plans[1].data.previousRound).toMatchObject({ gaps: ['还没有核实外部交叉来源。'], nextPlan: ['下一轮核对另一份材料，并检验矛盾。'] }); expect(plans[1].data.previousRound.reads).toBeUndefined();
  expect(b.report).not.toHaveBeenCalled();
});

it('downgrades invented exam citations to unassessed instead of fabricating a correct rate', async () => {
  const f = fixture(), goal = f.create(), b = build(f); b.material.badEvidence = true; await completed(f, b.service, goal, 1);
  const test = f.rounds(goal.id).items[0]!.selfTest!; expect(test).toMatchObject({ supportedAnswers: 0, assessedQuestions: 0 });
  expect(test.questions[0]).toMatchObject({ evaluation: 'unassessed', evidence: [] }); expect(test.disclaimer).toContain('不代表客观考试正确率');
});

it('links optional learning reflection to the exact formal VCP version and real reads without rewarding self-test scores', async () => {
  const f = fixture(), goal = f.create(), b = build(f), original = model.structured.getMockImplementation()!;
  model.structured.mockImplementation(async (input: { system: string; user: string }) => {
    const output = await original(input);
    if (!input.system.includes('阶段=assess')) return output;
    const data = JSON.parse(input.user).data;
    return { ...output, stateReflection: { focus: '下一轮核对第二份资料是否支持同一结论。', reason: '当前资料只有一个出处，先保持待核实。', evidence: [{ sourceId: data.reads[0].id, quote: b.material.text }] } };
  });
  const scope = { companionId: 'alice', conversationId: 'world_alice' }, before = f.store.request({ type: 'state.get', ...scope }).runtimeState!;
  await completed(f, b.service, goal, 1);
  const round = f.rounds(goal.id).items[0]!, after = f.store.request({ type: 'state.get', ...scope }).runtimeState!;
  expect(round.stateReflection).toMatchObject({ outcome: 'applied', expectedRevision: before.revision });
  expect(after.focus).toBe('下一轮核对第二份资料是否支持同一结论。'); expect(after.experience).toEqual(before.experience); expect(after.relationshipRecords).toEqual(before.relationshipRecords);
  expect(after.recentChanges?.[0]).toMatchObject({ kind: 'memory', energyDelta: 0, memoryVersions: [{ id: round.integration!.noteId, version: round.integration!.version }], sourceMessageIds: [round.reads[0]!.sourceMessageId] });
  const authoredRevision = after.revision;
  vi.setSystemTime(Date.now() + 5 * 60000); await completed(f, b.service, goal, 2);
  expect(f.rounds(goal.id).items[0]!.stateReflection).toMatchObject({ outcome: 'not_needed' });
  expect(f.store.request({ type: 'state.get', ...scope }).runtimeState!.revision).toBe(authoredRevision);
  f.store.request({ type: 'learning.revoke', companionId: 'alice', id: f.grant.id, expectedRevision: f.grant.revision });
  const withdrawn = f.store.request({ type: 'state.get', ...scope }).runtimeState!;
  expect(withdrawn.focus).toBeUndefined(); expect(withdrawn.recentChanges?.some(change => change.kind === 'memory')).toBe(false);
  expect(f.rounds(goal.id).items[0]!.stateReflection).toBeUndefined();
});

it('keeps newly changed conversational focus while committing a concurrent learning round and records the skipped reflection', async () => {
  const f = fixture(), goal = f.create(), b = build(f), original = model.structured.getMockImplementation()!;
  model.structured.mockImplementation(async (input: { system: string; user: string }) => {
    const output = await original(input);
    if (!input.system.includes('阶段=assess')) return output;
    const s = { companionId: 'alice', conversationId: f.store.openPrivate('alice').id }, source = f.store.appendMessage({ conversationId: s.conversationId, authorId: 'user', content: '先聊聊我们刚才约好的安排。' });
    f.store.request({ type: 'state.update', ...s, proposal: { focus: '正在回应新的聊天安排', reason: '用户刚提出新的实际聊天话题。', sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], relationshipUpdates: [] } });
    const data = JSON.parse(input.user).data;
    return { ...output, stateReflection: { focus: '继续学习旧资料', reason: '学习阶段较早提出的关注。', evidence: [{ sourceId: data.reads[0].id, quote: b.material.text }] } };
  });
  await completed(f, b.service, goal, 1); const round = f.rounds(goal.id).items[0]!;
  expect(round.stateReflection).toMatchObject({ outcome: 'skipped' }); expect(round.stateReflection!.detail).toContain('更新');
  expect(f.store.request({ type: 'state.get', companionId: 'alice', conversationId: f.store.openPrivate('alice').id }).runtimeState?.focus).toBe('正在回应新的聊天安排');
  expect(f.store.request({ type: 'memory.library.read', companionId: 'alice', id: round.memoryIds[0]! }).memoryRead?.memory.status).toBe('indexed');
  expect(b.report).not.toHaveBeenCalled();
});

it('does not apply a reflection that invents a quote absent from the real read', async () => {
  const f = fixture(), goal = f.create(), b = build(f), original = model.structured.getMockImplementation()!;
  model.structured.mockImplementation(async (input: { system: string; user: string }) => {
    const output = await original(input); if (!input.system.includes('阶段=assess')) return output;
    return { ...output, stateReflection: { focus: '没有证据的关注', reason: '模型给出的无来源推断。', evidence: [{ sourceId: JSON.parse(input.user).data.reads[0].id, quote: 'NOT_IN_REAL_READ' }] } };
  });
  await completed(f, b.service, goal, 1); expect(f.rounds(goal.id).items[0]!.stateReflection).toBeUndefined();
  expect(f.store.request({ type: 'state.get', companionId: 'alice', conversationId: 'world_alice' }).runtimeState?.focus).toBeUndefined();
});

it('never counts a non-answer as supported even when the model grades the existing material instead of the actual answer', async () => {
  const f = fixture(), goal = f.create(), b = build(f); b.material.unknownAnswer = true; await completed(f, b.service, goal, 1);
  const test = f.rounds(goal.id).items[0]!.selfTest!;
  expect(test).toMatchObject({ supportedAnswers: 0, assessedQuestions: 0, questions: [{ answer: '不知道', evaluation: 'unassessed' }] });
  expect(test.questions[0]!.rationale).toContain('不能把材料中存在答案当作已经答对'); expect(test.recall!.contextCharacters).toBeGreaterThan(0);
});

it('uses the common write policy gate and rejects a newly changed prohibition fence inside the atomic goal commit', async () => {
  const f = fixture(), goal = f.create();
  const validateWrite = vi.fn<NonNullable<CompanionLearningGoalIntegrationOptions['validateWrite']>>(async command => {
    command.expectedProhibitionRevision = f.store.request({ type: 'memory.prohibitions', companionId: command.companionId, conversationId: command.conversationId,
      sourceMessageIds: command.candidate.sourceMessageIds }).memoryProhibitionRevision;
    f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: 'world_alice', tag: '校验后新增的主题限制', persistent: true });
  });
  const b = build(f, { validateWrite }); await b.service.tick();
  await vi.waitFor(() => expect(f.rounds(goal.id).items[0]).toMatchObject({ status: 'failed' }));
  expect(validateWrite).toHaveBeenCalledOnce(); expect(f.rounds(goal.id).items[0]!.error).toContain('禁记规则已变化'); expect(f.store.listMemory('alice')).toEqual([]);
});

it('never writes a goal note when the unified semantic policy validator refuses its content', async () => {
  const f = fixture(), goal = f.create(); const validateWrite = vi.fn(async () => { throw new Error('已禁止记录这个主题。'); });
  const b = build(f, { validateWrite }); await b.service.tick();
  await vi.waitFor(() => expect(f.rounds(goal.id).items[0]).toMatchObject({ status: 'failed', error: '已禁止记录这个主题。' }));
  expect(f.store.listMemory('alice')).toEqual([]); expect(b.memory.schedule).not.toHaveBeenCalled();
});

it('rejects paused stale leases atomically before source or memory writes and refuses foreign goal revisions', () => {
  const f = fixture(), goal = f.create(), job = f.claim()!;
  f.store.request({ type: 'learning.goals.update', companionId: 'alice', id: goal.id, expectedRevision: 1, state: 'paused' });
  expect(() => f.store.request({ type: 'learning.goals.checkpoint', id: goal.id, leaseToken: job.leaseToken, round: job.round })).toThrow('取消');
  expect(() => f.store.request({ type: 'learning.goals.integrate', id: goal.id, leaseToken: job.leaseToken, content: '不能写入', claimHash: sha('不能写入'), reason: '不能写入', expectedProhibitionRevision: sha(''), evidence: [{ sourceMessageId: 'nonexistent', quote: '不能写入' }] })).toThrow('取消');
  expect(f.claim()).toBeUndefined(); expect(() => f.store.request({ type: 'learning.goals.update', companionId: 'bob', id: goal.id, expectedRevision: 2, state: 'active' })).toThrow('已变化');
});

it('keeps revoked readings and their derived old test/knowledge unavailable in history and withdrawals reach the same memory ledger', async () => {
  const f = fixture(), goal = f.create(), b = build(f); await completed(f, b.service, goal, 1);
  f.store.request({ type: 'learning.revoke', companionId: 'alice', id: f.grant.id, expectedRevision: f.grant.revision });
  const history = f.rounds(goal.id).items[0]!;
  expect(history.reads[0]!.excerpt).toBe(''); expect(history.claims).toEqual([]); expect(history.selfTest).toBeUndefined(); expect(history.memoryIds).toEqual([]);
  expect(f.store.request({ type: 'memory.browse', companionId: 'alice', conversationId: 'world_alice' }).memoryPage!.items).toEqual([]);
});

it('honors formal forgotten-source barriers in old round history and the next planning context', async () => {
  const f = fixture(), goal = f.create(), b = build(f); await completed(f, b.service, goal, 1);
  const source = f.rounds(goal.id).items[0]!.reads[0]!.sourceMessageId!;
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: 'world_alice', sourceMessageIds: [source] });
  const round = f.rounds(goal.id).items[0]!; expect(round.reads[0]!.excerpt).toBe(''); expect(round.summary).toBeUndefined(); expect(round.selfTest).toBeUndefined(); expect(round.claims).toEqual([]);
  vi.setSystemTime(Date.now() + 5 * 60000); await completed(f, b.service, goal, 2);
  const latestPlan = model.structured.mock.calls.filter(([input]) => input.system.includes('阶段=plan')).at(-1)!;
  expect(JSON.parse(latestPlan[0].user).data.previousRound.summary).toBeUndefined();
});

it('resumes the same checkpoint after restart, keeps all old rounds paginated, and leases at most two goals including two for one owner', () => {
  const f = fixture(), goal = f.create(); f.create('另一个并行目标'); f.create('第三个等待资源');
  const first = f.claim()!, second = f.claim()!; expect(first.goal.companionId).toBe(second.goal.companionId); expect(f.claim()).toBeUndefined();
  first.round.plan = { focus: '已完成的计划', questions: [], searchQueries: [] };
  f.store.request({ type: 'learning.goals.checkpoint', id: first.goal.id, leaseToken: first.leaseToken, round: first.round });
  f.store.close(); stores.delete(f.store); const reopened = new CompanionsStore(f.file, f.seeds); stores.add(reopened);
  const resumed = reopened.request({ type: 'learning.goals.claim' }).learningGoalJob!;
  expect(resumed.round).toMatchObject({ id: first.round.id, ordinal: first.round.ordinal, plan: { focus: '已完成的计划' } });
  expect(resumed.leaseToken).not.toBe(first.leaseToken);
  reopened.request({ type: 'learning.goals.finish', id: resumed.goal.id, leaseToken: resumed.leaseToken, round: { ...resumed.round, status: 'completed' } });
  expect(reopened.request({ type: 'learning.goals.rounds', companionId: 'alice', id: goal.id, limit: 1 }).learningRounds!.items).toHaveLength(1);
});

it('honors overnight windows by the starting weekday and never claims a dormant companion', () => {
  const f = fixture();
  const schedule = { intervalMinutes: 5, timeZone: 'Asia/Shanghai', windows: [{ startMinute: 23 * 60, endMinute: 2 * 60, days: [4] }] };
  expect(nextCompanionLearningGoalAt(schedule, Date.parse('2026-10-22T16:30:00Z'))).toBe(Date.parse('2026-10-22T16:30:00Z'));
  expect(nextCompanionLearningGoalAt(schedule, Date.parse('2026-10-22T19:00:00Z'))).toBe(Date.parse('2026-10-29T15:00:00Z'));
  f.create(); f.store.setCompanionActive('alice', false); expect(f.claim()).toBeUndefined();
});

it('retains old rounds beyond one hundred and pages the stored history without loading it into model context', () => {
  const f = fixture(), goal = f.create();
  for (let index = 0; index < 103; index++) {
    if (index) f.store.request({ type: 'learning.goals.run', companionId: 'alice', id: goal.id, expectedRevision: 1 });
    const job = f.claim()!;
    f.store.request({ type: 'learning.goals.finish', id: goal.id, leaseToken: job.leaseToken,
      round: { ...job.round, status: 'cancelled', error: 'Explicit synthetic cancellation receipt, no learning claimed.' }, failureKind: 'cancelled', retryAfterMs: 1000 });
  }
  expect(f.rounds(goal.id, 0, 50)).toMatchObject({ hasMore: true, nextCursor: 50 });
  const oldest = f.rounds(goal.id, 100, 50); expect(oldest.items.map(round => round.ordinal)).toEqual([3, 2, 1]); expect(oldest.hasMore).toBe(false);
  expect(f.store.request({ type: 'learning.goals.list', companionId: 'alice' }).learningGoals!.items[0]!.state).toBe('active');
});

it('cancels an in-flight read after pause and never lets the late file result become a memory source', async () => {
  const f = fixture(), goal = f.create(), b = build(f); let release!: (value: Awaited<ReturnType<CompanionLearningAssets['read']>>) => void;
  b.assets.read = vi.fn(() => new Promise<Awaited<ReturnType<CompanionLearningAssets['read']>>>(resolve => { release = resolve; }));
  await b.service.tick(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await b.service.handle({ type: 'memory.learning.goals.update', companionId: 'alice', id: goal.id, expectedRevision: 1, state: 'paused' });
  release({ content: '迟到的文件资料。', revisionId: 'late', truncated: false }); await b.service.drain('alice');
  expect(f.rounds(goal.id).items[0]).toMatchObject({ status: 'cancelled', reads: [] }); expect(f.store.listMemory('alice')).toEqual([]);
  expect(f.store.state(true).conversations.flatMap(room => f.store.messages({ conversationId: room.id }).messages).some(message => message.content.includes('迟到的文件资料'))).toBe(false);
});

it('waits for materials before planning and never calls a model when there is no authorized learning entrance', async () => {
  const f = fixture(), goal = f.create(), b = build(f);
  f.store.request({ type: 'learning.goals.update', companionId: 'alice', id: goal.id, expectedRevision: 1, materials: [], allowWeb: false });
  await b.service.tick(); await vi.waitFor(() => expect(f.rounds(goal.id).items[0]).toMatchObject({ status: 'deferred', phase: 'waiting' }));
  expect(model.structured).not.toHaveBeenCalled(); expect(b.assets.read).not.toHaveBeenCalled();
  expect(f.store.request({ type: 'learning.goals.list', companionId: 'alice' }).learningGoals!.items[0]!.waitReason).toContain('本轮尚未调用模型');
  expect(b.report).not.toHaveBeenCalled();
});
