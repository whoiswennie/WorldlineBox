import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it } from 'vitest';
import { realMainFixture } from '../fixtures/companion-real-main';
import { CompanionsStore } from '../../src/companions/store';
import { reviewTopicSummaryCanon } from '../../src/main/companions/topic-summary-canon-review';
import { reviewTopicContinuity } from '../../src/main/companions/topic-continuity-review';
import { generateCompanionStructured } from '../../src/main/companions/model';
import { topicCanonSourceProjection, topicUserCanonSchema } from '../../src/main/companions/topic-user-canon';
import { NOVEL_CONTENT_SCENARIOS } from '../fixtures/companion-novel-content-corpus';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionTopicState } from '../../src/shared/companion-topic';

it.skipIf(process.env.WORLDLINEBOX_TOPIC_SUMMARY_RESUME_REAL !== '1')('resumes the preserved actual north summary validation after its format-only recall failure without rewriting its persisted summary', async () => {
  const parentReport = path.resolve('artifacts/vcp-validation/topic-summary-convergence-real-2026-10-24-worldlinebox-real-main-pMgx28.json');
  const originalDatabase = path.join(tmpdir(), 'worldlinebox-real-main-pMgx28', 'replay', 'messages.sqlite');
  const parent = JSON.parse(await readFile(parentReport, 'utf8')) as { status: string; error: string; before: { source: CompanionMessage; formalSources: [string, string][] };
    after: NonNullable<CompanionTopicState['workingState']> };
  expect(parent.status).toBe('failed'); expect(parent.error).toContain('undefined');
  const f = await realMainFixture('summary_actual_persisted_resume', []), replayFile = path.join(f.root, 'replay', 'messages.sqlite');
  const output = path.resolve('artifacts/vcp-validation', `topic-summary-resume-real-2026-10-24-${path.basename(f.root)}.json`);
  await mkdir(path.dirname(replayFile), { recursive: true });
  const originalHash = createHash('sha256').update(await readFile(originalDatabase)).digest('hex');
  const sourceDb = new (BetterSqlite3 as { new(file: string, options: { readonly: boolean; fileMustExist: boolean }): {
    pragma(sql: string, options: { simple: boolean }): unknown; backup(file: string): Promise<unknown>; close(): void } })(originalDatabase, { readonly: true, fileMustExist: true });
  expect(sourceDb.pragma('integrity_check', { simple: true })).toBe('ok'); await sourceDb.backup(replayFile); sourceDb.close();
  const store = new CompanionsStore(replayFile, []), checks: unknown[] = [], recallAttempts: unknown[] = [];
  const report: Record<string, unknown> = { status: 'running', parentReport, originalDatabase, originalHash, replayFile,
    fixtureKind: 'resume_actual_persisted_summary_validation_only_not_new_compaction_or_new_novel_or_from_zero_current_source_run',
    originalFailureKind: 'correct_values_but_first_four_recall_keys_used_Chinese_question_labels', checks, recallAttempts, calls: f.calls };
  let status = 'failed';
  try {
    const source = store.getMessage(parent.before.source.id), conversationId = source.conversationId, topicId = source.topicId!;
    const read = () => store.request({ type: 'topic.read', conversationId, topicId, readerId: 'writer' });
    const before = read(), actual = before.topicState!.workingState!, messages = store.messages({ conversationId, topicId, limit: 100 }).messages;
    expect(actual).toEqual(parent.after);
    const fingerprints = () => store.messages({ conversationId, topicId, limit: 100 }).messages.map(message => [message.id, createHash('sha256').update(message.content).digest('hex')]);
    expect(fingerprints()).toEqual(parent.before.formalSources);
    const continuity = actual.state!.__continuity as { throughSequence: number }, state = store.state();
    const canon = topicUserCanonSchema.parse(actual.state!.__topicUserCanon), scope = { ownerId: 'writer', conversationId, topicId };
    report.actualPersistedSummary = actual; report.coveredThroughSequence = continuity.throughSequence;
    const quantityAndCanonCorrection = await reviewTopicSummaryCanon({ canon, summary: actual.summary!, stage: actual.stage!, scope, config: f.config, fetchFn: f.modelFetch });
    report.currentQuantityAndCanonCorrection = quantityAndCanonCorrection; expect(quantityAndCanonCorrection).toBeUndefined();
    const genericCorrection = await reviewTopicContinuity({ frame: { companion: state.companions.find(role => role.id === 'writer')!,
      conversation: state.conversations.find(room => room.id === conversationId)!, topic: before.topic, topicState: before.topicState,
      sourceMessage: source, messages: messages.filter(message => message.sequence <= continuity.throughSequence), topicPublicationReference: undefined },
      proposed: { kind: 'summary', summary: actual.summary!, stage: actual.stage! }, config: f.config, fetchFn: f.modelFetch, canon });
    report.currentContinuityCorrection = genericCorrection; expect(genericCorrection).toBeUndefined();
    const questions = NOVEL_CONTENT_SCENARIOS[0].questions, required = Object.keys(questions);
    let recall: Record<string, string> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = await generateCompanionStructured({ system: '依据实际工作摘要与用户原句独立回答核对。只返回JSON对象，使用outputSchema要求的英文键，值是字符串；不要将中文question当键。按资料回答，未知保持未知，不猜填；同一个值中不可一面给出已知答案又称它未知。',
        user: JSON.stringify({ purpose: 'topic_summary_actual_resume_fact_recall', questions,
          outputSchema: { type: 'object', required, additionalProperties: false, properties: Object.fromEntries(required.map(key => [key, { type: 'string' }])) },
          summary: actual.summary, stage: actual.stage, userCanon: topicCanonSourceProjection(canon),
          ...(attempt ? { formatCorrection: '只纠正JSON键与字符串结构；没有新增事实，请从同一资料自行回答。' } : {}) }) }, f.config, undefined, { fetchFn: f.modelFetch });
      recallAttempts.push(raw);
      if (raw && typeof raw === 'object' && required.every(key => typeof (raw as Record<string, unknown>)[key] === 'string') && Object.keys(raw).length === required.length) { recall = raw as Record<string, string>; break; }
    }
    expect(recall).toBeDefined(); report.exactFactRecall = recall;
    for (const [field, patterns] of Object.entries(NOVEL_CONTENT_SCENARIOS[0].expected)) for (const pattern of patterns) {
      const passed = new RegExp(pattern, 'u').test(recall![field]!); checks.push({ field, pattern, passed }); expect(passed).toBe(true);
    }
    const judgment = await generateCompanionStructured({ system: '你独立审查实际回忆答案的语义准确性，不改写答案。只核原用户引文与当前工作摘要；每个答案不仅需有正确关键词，也不得夹带与同字段已知答案相反的未知/否定或补造。明确已给时间地点，不能同字段又说地点未明。返回JSON {passed:boolean,contradictions:[{field:string,answerQuote:string,sourceQuote:string,reason:string}]}。所有引用逐字匹配实际答案字段和source，真实错误必须指出，不为通过测试改判。',
      user: JSON.stringify({ purpose: 'topic_summary_actual_resume_recall_semantic_judge', actualAnswers: recall,
        actualSummary: actual.summary, userCanon: topicCanonSourceProjection(canon) }) }, f.config, undefined, { fetchFn: f.modelFetch });
    report.independentRecallSemanticJudgment = judgment;
    expect(judgment).toMatchObject({ passed: true, contradictions: [] });
    expect(read().topicState!.workingState).toEqual(parent.after); expect(fingerprints()).toEqual(parent.before.formalSources);
    expect(createHash('sha256').update(await readFile(originalDatabase)).digest('hex')).toBe(originalHash);
    report.noSummaryOrProseRewritten = true; report.noNewWatermarkOrSourceGraph = true; status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; report.finishedAt = new Date().toISOString(); store.close(); await f.save(output, report, status !== 'passed'); await f.close(status !== 'passed'); }
}, 600000);
