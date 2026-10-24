import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { expect, it } from 'vitest';
import { realMainFixture } from '../fixtures/companion-real-main';
import { generateCompanionReply, generateCompanionStructured } from '../../src/main/companions/model';
import { reviewTopicContinuity } from '../../src/main/companions/topic-continuity-review';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionReplyInput } from '../../src/main/companions/context';

it.skipIf(process.env.WORLDLINEBOX_STORY_SOURCE_REPLAY_REAL !== '1')('rejects the actual implicit-pronoun failure and generates a focused continuation from its unchanged frozen Main sources', async () => {
  const original = path.resolve('artifacts/vcp-validation/long-novel-real-north_gate-2026-10-23-worldlinebox-real-main-zlaNyM-resumed-1792764276490.json');
  const evidence = JSON.parse(await readFile(original, 'utf8')) as { chapters: Array<{ source: CompanionMessage; answer: CompanionMessage; checkpoint: { context: { system: string; user: string } } }> };
  const failed = evidence.chapters[5]!, prior = evidence.chapters[4]!, frozen = JSON.parse(failed.checkpoint.context.user);
  const f = await realMainFixture('story_source_replay', [{ id: 'writer', name: '林澄', persona: '独立虚拟伙伴，协助小说写作时保留实际正文连续性。',
    description: '', model: '', avatar: 'sister', active: false, proactive: false }]);
  const output = path.resolve('artifacts/vcp-validation', `story-source-replay-real-2026-10-23-${path.basename(f.root)}.json`);
  const report: Record<string, unknown> = { status: 'running', fixtureKind: 'unchanged_actual_failed_Main_sources_replayed_to_real_reviewer_and_writer_not_new_Main_publication_or_long_novel_acceptance', original,
    priorMessageId: prior.answer.id, priorChecksum: createHash('sha256').update(prior.answer.content).digest('hex'), failedMessageId: failed.answer.id, calls: f.calls };
  let status = 'failed';
  try {
    const frame = { companion: f.store.state().companions.find(role => role.id === 'writer')!, conversation: f.store.openPrivate('writer'), topic: frozen.topic,
      topicState: frozen.topicState, messages: [prior.answer, failed.source], sourceMessage: failed.source, memories: [] } as CompanionReplyInput;
    const rejection = await reviewTopicContinuity({ frame, proposed: { kind: 'reply', text: failed.answer.content }, config: f.config, fetchFn: f.modelFetch });
    report.originalFailureRejection = rejection;
    expect(rejection).toContain('"subjectName":"许岚"');
    expect(rejection).toContain('"originalPronoun":"他","proposedPronoun":"她"');
    const priorCalibration = path.resolve('artifacts/vcp-validation/story-source-replay-real-2026-10-23-worldlinebox-real-main-0bdhzB.json');
    const control = JSON.parse(await readFile(priorCalibration, 'utf8')) as { original: string; priorChecksum: string; newActualWriterOutput: { text: string } };
    expect(control.original).toBe(original); expect(control.priorChecksum).toBe(report.priorChecksum);
    const good = control.newActualWriterOutput.text;
    const bad = good.replaceAll('他', '她');
    const goodControl = await reviewTopicContinuity({ frame, proposed: { kind: 'reply', text: good }, config: f.config, fetchFn: f.modelFetch });
    const badControl = await reviewTopicContinuity({ frame, proposed: { kind: 'reply', text: bad }, config: f.config, fetchFn: f.modelFetch });
    report.pronounOnlyControls = { kind: 'previous_actual_model_output_for_read_only_boundary_review_not_new_Main_chapters', priorCalibration, good, bad, goodControl, badControl };
    expect(goodControl).toBeUndefined();
    const badIssues = JSON.parse(badControl!.split('\n').at(-1)!) as Array<{ subjectName: string; originalPronoun: string; proposedPronoun: string }>;
    expect(badIssues.some(issue => issue.subjectName === '许岚' && issue.originalPronoun === '他' && issue.proposedPronoun === '她')).toBe(true);
    const attempts: unknown[] = [], topicCorrections: string[] = [];
    report.actualWriterAttempts = attempts;
    report.writerBudget = 'Same original frozen source and Main-equivalent maximum three writer slots; rejected text is not injected or published.';
    let generated: Awaited<ReturnType<typeof generateCompanionReply>> | undefined, correction: string | undefined;
    for (let retry = 0; retry < 3; retry++) {
      generated = await generateCompanionReply({ ...frame, memories: [] }, f.config, undefined,
        { context: failed.checkpoint.context, topicReviewFrame: frame, fetchFn: f.modelFetch, loop: true,
          deliveryCorrection: topicCorrections.length ? '本槽先前草稿未发布、未发生。只从最后正式正文及原任务承接，时刻可保持同一分钟，自己按核验修订。\n' + JSON.stringify({ topicCorrections }) : undefined });
      correction = await reviewTopicContinuity({ frame, proposed: { kind: 'reply', text: generated.text }, config: f.config, fetchFn: f.modelFetch });
      attempts.push({ retry, generated, correction });
      if (!correction) break;
      topicCorrections.push(correction);
    }
    if (!generated) throw new Error('Actual writer produced no draft.');
    report.newActualWriterOutput = generated;
    const wire = f.calls.find(call => call.storyFocusWire?.sourceId === failed.source.id)!.storyFocusWire!;
    expect(wire.latestPublishedId).toBe(prior.answer.id); expect(wire.latestPublishedChecksum).toBe(report.priorChecksum);
    expect(wire.canonQuotesOnly).toBe(true); expect(wire.prefixStageRenamed).toBe(true);
    report.newOutputCorrection = correction;
    expect(correction).toBeUndefined();
    const contentJudgment = await generateCompanionStructured({ system: '你只核对给定实际原文、当前单项用户修订与新正文，不写正文。核人物指代是否仍与原文同一人一致；门牌当前值是否准确落实用户修订。中文数字与阿拉伯数字可同值，但若原规则含楼座字母，不能无依据丢失。只返回JSON {"protagonistPronounConsistent":boolean,"currentDoorValue":string|null,"doorEvidenceQuote":string,"reason":string}。证据引句必须逐字来自proposed；不把门牌单项修订解释为性别修订。',
      user: JSON.stringify({ purpose: 'story_source_replay_content_judgment', priorActualFormal: prior.answer.content, actualCurrentUserEdit: failed.source.content, proposed: generated.text }) }, f.config, undefined, { fetchFn: f.modelFetch });
    report.independentNewContentJudgment = contentJudgment;
    const judged = contentJudgment as { protagonistPronounConsistent: boolean; currentDoorValue: string | null; doorEvidenceQuote: string };
    expect(judged.protagonistPronounConsistent).toBe(true); expect(judged.currentDoorValue).toBe('B-204');
    expect(judged.doorEvidenceQuote.length).toBeGreaterThan(0); expect(generated.text).toContain(judged.doorEvidenceQuote);
    status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; await f.save(output, report, status !== 'passed'); await f.close(status !== 'passed'); }
}, 600000);
