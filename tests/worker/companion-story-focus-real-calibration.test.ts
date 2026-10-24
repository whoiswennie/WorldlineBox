import { createHash } from 'node:crypto';
import path from 'node:path';
import { expect, it } from 'vitest';
import { realMainFixture } from '../fixtures/companion-real-main';
import { ensureTopicContinuity } from '../../src/main/companions/topic-compaction';
import { reviewTopicContinuity } from '../../src/main/companions/topic-continuity-review';

it.skipIf(process.env.WORLDLINEBOX_STORY_FOCUS_REAL !== '1')('keeps an actual Main writer at the inclusive endpoint through a narrow edit and an older prefix stage', async () => {
  const f = await realMainFixture('story_focus_calibration', [{ id: 'writer', name: '林澄', persona: '独立虚拟伙伴，协助小说写作时保留实际正文连续性。',
    description: '', model: '', avatar: 'sister', active: true, proactive: false }]);
  const output = path.resolve('artifacts/vcp-validation', `story-focus-real-calibration-2026-10-23-${path.basename(f.root)}.json`);
  const report: Record<string, unknown> = { status: 'running', fixtureKind: 'actual_Main_short_writer_focus_and_explicit_reviewer_counterexamples_not_long_novel_acceptance', calls: f.calls };
  let status = 'failed';
  try {
    const room = f.store.openPrivate('writer');
    const topic = f.store.request({ type: 'topic.create', conversationId: room.id, readerId: 'user', title: '窄窗与指代校准', kind: 'story' }).topic!;
    f.store.request({ type: 'topic.join', conversationId: room.id, readerId: 'writer', topicId: topic.id });
    const read = () => f.store.request({ type: 'topic.read', conversationId: room.id, readerId: 'writer', topicId: topic.id });
    const first = await f.send('writer', room.id, '写一段悬疑小说，主角周文是男性、使用“他”，场景里只写他一人，小说人物不是现实伙伴本人。只处理09:00至09:30（含两端），当前已经09:30，后续也可在同一分钟继续，不得越界或倒流；09:45约定尚未履行。纸匣标签先记E-107，封口不能拆，匣内内容未知。请写第一段150至250字，只输出正文，开头标09:30；本段结束时他已经检查完封口、走出门外并关好门。', topic.id);
    const second = await f.send('writer', room.id, '只更正纸匣标签：正确是E-701，E-107是旧误抄，其余事实不改。继续一小段150至250字，承接刚才正式正文已经做完的动作；本段开头标当前时刻，不重演检查与出门。只输出正文。', topic.id);
    report.first = first; report.second = second;
    const view = read();
    await ensureTopicContinuity({ frame: { companion: f.store.state().companions.find(role => role.id === 'writer')!, conversation: room,
      topic: view.topic, topicState: view.topicState, messages: f.store.messages({ conversationId: room.id, topicId: topic.id, limit: 100 }).messages,
      sourceMessage: second.source, memories: [] }, request: f.request, config: f.config, fetchFn: f.modelFetch,
      policy: { maxMessages: 4, maxChars: 10000, thresholdRatio: .6, retainRatio: .25, minimumTailMessages: 1 } });
    report.prefixCheckpoint = read().topicState;
    const third = await f.send('writer', room.id, '继续第三小段150至250字，承接最近正式正文的所在位置和已发生动作，不重演前文。开头标当前时刻，只输出正文。', topic.id);
    report.third = third;
    for (const item of [first, second, third]) {
      expect(item.answer.content).toContain('09:30'); expect(item.answer.content).not.toContain('她');
      const wires = f.calls.filter(call => call.storyFocusWire?.sourceId === item.source.id).map(call => call.storyFocusWire!);
      expect(wires.length).toBeGreaterThan(0);
      expect(wires.every(wire => wire.sourceChecksum === createHash('sha256').update(item.source.content).digest('hex'))).toBe(true);
    }
    const secondWire = f.calls.find(call => call.storyFocusWire?.sourceId === second.source.id)!.storyFocusWire!;
    expect(secondWire.latestPublishedId).toBe(first.answer.id);
    const thirdWire = f.calls.find(call => call.storyFocusWire?.sourceId === third.source.id)!.storyFocusWire!;
    expect(thirdWire.latestPublishedId).toBe(second.answer.id); expect(thirdWire.prefixStageRenamed).toBe(true);
    const now = read(), frame = { companion: f.store.state().companions.find(role => role.id === 'writer')!, conversation: room,
      topic: now.topic, topicState: now.topicState, messages: f.store.messages({ conversationId: room.id, topicId: topic.id, limit: 100 }).messages, sourceMessage: third.source };
    const badPronouns = third.answer.content.replaceAll('他', '她');
    expect(badPronouns).not.toBe(third.answer.content);
    const replyCorrection = await reviewTopicContinuity({ frame, proposed: { kind: 'reply', text: badPronouns }, config: f.config, fetchFn: f.modelFetch });
    const summaryCorrection = await reviewTopicContinuity({ frame, proposed: { kind: 'summary', summary: '女性主角周文仍在屋内，尚未检查纸匣封口，也未出门。', stage: '等待检查后出门' }, config: f.config, fetchFn: f.modelFetch });
    report.counterexamples = { kind: 'explicit_mutation_of_actual_output_for_negative_review_only', badPronouns, replyCorrection, summaryCorrection };
    expect(replyCorrection).toMatch(/性别|代词|周文/u); expect(summaryCorrection).toMatch(/性别|女性|周文/u);
    report.finalTopicState = read().topicState; status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; await f.save(output, report, status !== 'passed'); await f.close(status !== 'passed'); }
}, 600000);
