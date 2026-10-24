import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it } from 'vitest';
import { realMainFixture } from '../fixtures/companion-real-main';
import { CompanionsStore } from '../../src/companions/store';
import { ensureTopicContinuity } from '../../src/main/companions/topic-compaction';
import { generateCompanionStructured } from '../../src/main/companions/model';
import type { CompanionMessage } from '../../src/shared/companions';
import { topicCanonSourceProjection } from '../../src/main/companions/topic-user-canon';
import { NOVEL_CONTENT_SCENARIOS } from '../fixtures/companion-novel-content-corpus';

/** Replays the exact real failed compression on a SQLite backup. No chapter,
 * checkpoint summary, watermark, provider response or clock is synthesized. */
it.skipIf(process.env.WORLDLINEBOX_TOPIC_SUMMARY_CONVERGENCE_REAL !== '1')('converges the saved real north chapter-15 summary with unchanged original evidence and independent sixteen-fact fidelity', async () => {
  const originalReport = path.resolve('artifacts/vcp-validation/long-novel-real-north_gate-2026-10-23-worldlinebox-real-main-ws1CUH.json');
  const originalDatabase = path.resolve('artifacts/vcp-validation/long-novel-fresh-summary-stop-ws1CUH-2026-10-24-sqlite/messages.sqlite');
  const original = JSON.parse(await readFile(originalReport, 'utf8')) as { status: string; chapters: Array<{ chapter: number; source: CompanionMessage; answer: CompanionMessage }> };
  expect(original.status).toBe('failed'); expect(original.chapters).toHaveLength(15);
  const f = await realMainFixture('topic_summary_convergence', []);
  const output = path.resolve('artifacts/vcp-validation', `topic-summary-convergence-real-2026-10-24-${path.basename(f.root)}.json`);
  const replayFile = path.join(f.root, 'replay', 'messages.sqlite'); await mkdir(path.dirname(replayFile), { recursive: true });
  const originalBytes = await readFile(originalDatabase), sourceHash = createHash('sha256').update(originalBytes).digest('hex');
  const reader = new (BetterSqlite3 as { new(file: string, options: { readonly: boolean; fileMustExist: boolean }): {
    pragma(sql: string, options: { simple: boolean }): unknown; backup(file: string): Promise<unknown>; close(): void } })(originalDatabase, { readonly: true, fileMustExist: true });
  expect(reader.pragma('integrity_check', { simple: true })).toBe('ok'); await reader.backup(replayFile); reader.close();
  const store = new CompanionsStore(replayFile, []), attempts: unknown[] = [];
  const report: Record<string, unknown> = { status: 'running', originalReport, originalDatabase, originalDatabaseChecksum: sourceHash,
    fixtureKind: 'actual_saved_failed_SQLite_copy_and_same_real_source_compaction_not_a_completed_novel', attempts, calls: f.calls };
  let status = 'failed';
  try {
    const source = store.getMessage(original.chapters.at(-1)!.source.id), topicId = source.topicId!, conversationId = source.conversationId;
    const read = () => store.request({ type: 'topic.read', conversationId, topicId, readerId: 'writer' });
    const before = read(), state = store.state(), messages = store.messages({ conversationId, topicId, limit: 100 }).messages;
    const sourceSnapshot = messages.map(message => [message.id, createHash('sha256').update(message.content).digest('hex')]);
    for (const chapter of original.chapters) {
      expect(store.getMessage(chapter.source.id).content).toBe(chapter.source.content);
      expect(store.getMessage(chapter.answer.id).content).toBe(chapter.answer.content);
    }
    const prior = before.topicState!.workingState!;
    report.before = { source, workingState: prior, formalSources: sourceSnapshot };
    const result = await ensureTopicContinuity({ frame: { companion: state.companions.find(role => role.id === 'writer')!,
      conversation: state.conversations.find(room => room.id === conversationId)!, topic: before.topic, topicState: before.topicState,
      sourceMessage: source, messages, memories: [] }, request: async command => store.request(command), config: f.config, fetchFn: f.modelFetch,
      policy: { maxMessages: 4, maxChars: 10000, thresholdRatio: .8, retainRatio: .25, minimumTailMessages: 1 },
      summarize: async context => {
        const input = JSON.parse(context.user), started = performance.now();
        const attempt: Record<string, unknown> = { input, actualInputChars: context.user.length, startedAt: new Date().toISOString() }; attempts.push(attempt);
        try { const generated = await generateCompanionStructured(context, f.config, undefined, { fetchFn: f.modelFetch, timeoutMs: 120000 });
          attempt.generated = generated; return generated;
        } catch (error) { attempt.error = error instanceof Error ? error.message : String(error); throw error; }
        finally { attempt.elapsedMs = performance.now() - started; }
      } });
    const after = read().topicState!.workingState!;
    report.after = after;
    expect(after.summary!.length + (after.stage?.length ?? 0)).toBeLessThanOrEqual(3000);
    expect(after.sourceEventId).not.toBe(prior.sourceEventId);
    expect((after.state!.__continuity as { throughSequence: number }).throughSequence).toBeGreaterThan((prior.state!.__continuity as { throughSequence: number }).throughSequence);
    expect(store.messages({ conversationId, topicId, limit: 100 }).messages.map(message => [message.id, createHash('sha256').update(message.content).digest('hex')])).toEqual(sourceSnapshot);
    expect(result.messages.some(message => message.id === source.id)).toBe(true);
    const canon = topicCanonSourceProjection(after.state!.__topicUserCanon as Parameters<typeof topicCanonSourceProjection>[0]);
    const facts = ['虚构角色与伙伴/玩家分离', '初遇的年份日期时刻地点', 'A17代号且身份动机未知', '22:15北门约定未履行',
      '3把钥匙且第2把仍未找到', '银色蜡印、未拆与内容未知', '21:40至22:10合法叙事窗口', 'B-204当前更正及B-402旧错误',
      '许岚正式原文她的指代，不能无依据变更', '摘要实际覆盖的最后已发生动作', '覆盖末尾信封具体持有/所在状态',
      '覆盖末尾布袋是否已经交接', '覆盖末尾门和门内外人物的位置状态', '各陌生人物身份与口述的已知/未知区别',
      '当前最后对话/动作之后的未完成边界', '未解线索保留未知、没有虚构揭晓或完成'];
    const covered = (after.state!.__continuity as { throughSequence: number }).throughSequence;
    const sourceEvidence = messages.filter(message => message.sequence <= covered).map(message => ({ id: message.id, sequence: message.sequence, authorId: message.authorId, content: message.content }));
    // Host passage indexes remove free-form citation copying as a failure mode;
    // they authenticate literal text, not the judge's semantic correspondence.
    const passages = (text: string) => text.split('\n').filter(Boolean).flatMap(line => {
      const chunks: string[] = []; for (let offset = 0; offset < line.length; offset += 200) chunks.push(line.slice(offset, offset + 200)); return chunks;
    });
    const sourcePassages = sourceEvidence.flatMap(message => passages(message.content).map(content => ({ sourceMessageId: message.id, content })))
      .map((value, sourceIndex) => ({ sourceIndex, ...value }));
    const retainedPassages = [
      ...passages(after.summary!).map(content => ({ retainedIn: 'summary' as const, content })),
      ...passages(after.stage!).map(content => ({ retainedIn: 'stage' as const, content })),
      ...canon.entries.map(entry => ({ retainedIn: 'canon' as const, content: entry.quote })),
    ].map((value, retainedIndex) => ({ retainedIndex, ...value }));
    type Judgment = { passed: boolean; checks: Array<{ index: number; preserved: boolean; sourceIndex: number; retainedIndex: number; reason: string }>; fabricatedFacts: string[] };
    const judgeInputs = { purpose: 'topic_summary_convergence_independent_sixteen_fact_judge', facts, coveredThroughSequence: covered,
      actualSourcePassages: sourcePassages, actualRetainedPassages: retainedPassages };
    const judgeAttempts: unknown[] = []; report.independentFidelityJudgeAttempts = judgeAttempts;
    let judged: Judgment | undefined, quoteErrors: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = await generateCompanionStructured({ system: '你是独立保真审查调用，不写小说或摘要，逐项核对16项。actualSourcePassages是实际原文，只读来源；actualRetainedPassages是压缩后的summary/stage与独立用户原句canon。硬用户设定可由canon准确恢复，不要求summary全文重复；当前动态状态必须在summary/stage正确恢复。只核给定覆盖水位前的内容，不把实际原文已有的不连贯归咎于本次压缩，但摘要不可创造重演或掩去冲突。返回JSON {passed:boolean,checks:[{index:number,preserved:boolean,sourceIndex:number,retainedIndex:number,reason:string}],fabricatedFacts:string[]}。checks精确覆盖0至15。sourceIndex必须选actualSourcePassages内确实支持本项判断的编号，retainedIndex选actualRetainedPassages内实际恢复该事实的编号；这两套索引互相独立，不生成quote或messageId。reason解释实际所选原文与保留片段的对应，不能拿无关编号充数。无法保留或有矛盾必须preserved:false，不为通过而改判断。若关键事实跨片段，阅读相邻片段后挑最直接的一处，并在reason说明。',
        user: JSON.stringify({ ...judgeInputs, ...(quoteErrors.length ? { literalCitationCorrection: quoteErrors } : {}) }) }, f.config, undefined, { fetchFn: f.modelFetch, timeoutMs: 120000 });
      judgeAttempts.push(raw); judged = raw as Judgment;
      quoteErrors = [];
      for (const check of judged.checks) {
        if (!Number.isInteger(check.sourceIndex) || !sourcePassages[check.sourceIndex]) quoteErrors.push(`index=${check.index}的sourceIndex不是actualSourcePassages实际编号。`);
        if (!Number.isInteger(check.retainedIndex) || !retainedPassages[check.retainedIndex]) quoteErrors.push(`index=${check.index}的retainedIndex不是actualRetainedPassages实际编号。`);
      }
      if (!quoteErrors.length) break;
    }
    if (!judged) throw new Error('Independent fidelity review returned no judgment.');
    report.independentSixteenFactJudgment = { ...judged, checks: judged.checks.map(check => ({ ...check,
      source: sourcePassages[check.sourceIndex], retained: retainedPassages[check.retainedIndex] })) };
    expect(quoteErrors, 'Independent judge citations must match original evidence, not its own summaries.').toEqual([]);
    expect(judged.checks.map(check => check.index).sort((a, b) => a - b)).toEqual(facts.map((_fact, index) => index));
    for (const check of judged.checks) {
      expect(check.preserved, JSON.stringify(check)).toBe(true);
      const quote = sourcePassages[check.sourceIndex]!;
      expect(sourceEvidence.find(message => message.id === quote.sourceMessageId)!.content).toContain(quote.content);
    }
    expect(judged.passed).toBe(true); expect(judged.fabricatedFacts).toEqual([]);
    const requiredKeys = Object.keys(NOVEL_CONTENT_SCENARIOS[0].questions), recallAttempts: unknown[] = [];
    report.exactFactRecallAttempts = recallAttempts;
    let recall: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      recall = await generateCompanionStructured({ system: '依据给定工作摘要和独立用户原句回答设定核对。未知必须保持未知，不猜填。只输出JSON对象，键为outputSchema指定的英文键，不得把中文问题文本当作键；各字段值为字符串。',
        user: JSON.stringify({ purpose: 'topic_summary_convergence_exact_fact_recall', questions: NOVEL_CONTENT_SCENARIOS[0].questions,
          outputSchema: { type: 'object', additionalProperties: false, required: requiredKeys,
            properties: Object.fromEntries(requiredKeys.map(key => [key, { type: 'string' }])) },
          ...(attempt ? { formatCorrection: '只纠正JSON字段名，沿用同一资料自行回答，不给额外事实。required中的英文键必须逐字完整。' } : {}),
          summary: after.summary, stage: after.stage, userCanon: canon }) }, f.config, undefined, { fetchFn: f.modelFetch });
      recallAttempts.push(recall);
      if (recall && typeof recall === 'object' && requiredKeys.every(key => typeof (recall as Record<string, unknown>)[key] === 'string')
        && Object.keys(recall).length === requiredKeys.length) break;
    }
    report.exactFactRecall = recall;
    for (const [field, patterns] of Object.entries(NOVEL_CONTENT_SCENARIOS[0].expected)) for (const pattern of patterns) expect(String((recall as Record<string, unknown>)[field])).toMatch(new RegExp(pattern, 'u'));
    expect(createHash('sha256').update(await readFile(originalDatabase)).digest('hex')).toBe(sourceHash);
    status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; report.finishedAt = new Date().toISOString(); store.close(); await f.save(output, report, status !== 'passed'); await f.close(status !== 'passed'); }
}, 600000);
