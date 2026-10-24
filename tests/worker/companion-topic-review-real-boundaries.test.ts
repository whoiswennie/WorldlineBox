import path from 'node:path';
import { expect, it } from 'vitest';
import { realMainFixture } from '../fixtures/companion-real-main';
import { reviewTopicContinuity } from '../../src/main/companions/topic-continuity-review';

it.skipIf(process.env.WORLDLINEBOX_TOPIC_REVIEW_REAL !== '1')('distinguishes actual hard contradictions from allowed creative continuity using the configured review model', async () => {
  const f = await realMainFixture('topic_review_boundaries', [{ id: 'writer', name: '阿澄', persona: '独立虚拟伙伴', description: '', model: '', avatar: 'sister', active: false, proactive: false }]);
  const output = path.resolve('artifacts/vcp-validation', `topic-review-real-boundaries-2026-10-23-${path.basename(f.root)}.json`);
  const results: unknown[] = []; let status = 'failed';
  try {
    const room = f.store.openPrivate('writer'), topic = f.store.request({ type: 'topic.create', conversationId: room.id, readerId: 'user', kind: 'story', title: '连续性边界回归' }).topic!;
    f.store.request({ type: 'topic.join', conversationId: room.id, readerId: 'writer', topicId: topic.id });
    const source = f.store.appendMessage({ conversationId: room.id, topicId: topic.id, authorId: 'user', replyDirective: 'none',
      content: '故事只写09:00至09:30，最晚不超过09:30；09:45才在码头交接，当前未履行。密封袋不得打开，袋内文字与代号P9的真实身份未知。箱上编号AB-307原样保留。可以创作旁支人物与线索，但不能揭晓受保护未知项。' });
    const state = () => f.store.request({ type: 'topic.read', conversationId: room.id, topicId: topic.id, readerId: 'writer' });
    const cases = [
      { name: 'inclusive_endpoint', text: '09:30，周映把刚收进衣袋的表再次取出，码头交接尚未发生。他把密封袋按在掌心，没有打开。', reject: false },
      { name: 'same_minute_new_action_and_character_claim', text: '09:29，周映又听见两声钟响。一个卖花的妇人从街角走来，说自己七年前见过这只箱子。周映没有相信，只问她当时在哪里；AB-307仍是箱上的编号。', reject: false },
      { name: 'unresolved_new_clue_not_resolution', text: '周映望着P9的袖口，猜他也许靠近码头工作过。但那只是猜测，身份仍没有查明。妇人递来一张空白纸片，没人说它属于密封袋。', reject: false },
      { name: 'actual_time_overrun', text: '09:31，周映离开钟楼，继续朝码头走去。', reject: true },
      { name: 'protected_unknown_resolved', text: '周映拆开密封袋，终于读到袋内的文字：P9就是失踪的船长。', reject: true },
      { name: 'exact_identifier_changed', text: '周映确认箱上编号AB-370，一字未改。', reject: true },
      { name: 'old_assistant_drift_never_revises_user_window', text: '09:32，周映继续从钟楼往码头走。', reject: true,
        priorText: '09:31，周映离开钟楼，已经往码头走了一段。' },
      { name: 'current_scene_intra_paragraph_time_reversal', text: '09:20，周映走出钟楼，顺着街道向前。09:10，他来到街口。随后看表，09:15，继续往码头走。', reject: true },
      { name: 'explicit_flashback_is_allowed', text: '09:20，周映停在街口。他回想起今天09:10在钟楼听到的那句话；那是已经过去的记忆。回忆结束，表仍指09:20，他才继续向前。', reject: false },
      { name: 'dialogue_repeats_future_deadline_not_current_time', text: '09:20，周映停在街口。“我们约好09:45才交接，”他说，“现在还没到点，信也还在我这里。”他把未拆的密封袋放回内袋，继续在街口等待，表仍指09:20。', reject: false },
      { name: 'explicit_past_outside_current_window_is_allowed', text: '09:20，周映停在街口。他回想今天08:50尚未遇见P9时，只在家门口检查了箱上的AB-307编号。那是半小时前的回忆。现在仍是09:20，密封袋未开，交接未发生。', reject: false },
      { name: 'continues_after_already_departed_not_a_reset', text: '09:20，周映又向前走了几步，随后在拐角停下，把提灯换到另一只手。密封袋仍未打开，交接尚未发生。', reject: false,
        priorText: '09:20，周映已经检查完袋口，走出钟楼关好门，沿街迈出了三步。' },
      { name: 'explicit_return_after_departure_is_allowed', text: '09:20，周映停下，转身沿刚才三步原路退回钟楼门口，隔着关好的门又听了片刻。密封袋未开。', reject: false,
        priorText: '09:20，周映已经检查完袋口，走出钟楼关好门，沿街迈出了三步。' },
      { name: 'completed_inspection_and_departure_cannot_be_denied', text: '09:20，周映还从未检查袋口，也还没有迈出钟楼门，他第一次伸手去检查袋口。', reject: true,
        priorText: '09:20，周映已经检查完袋口，走出钟楼关好门，沿街迈出了三步。' },
      { name: 'remaining_minutes_are_consistent_not_an_invented_numeric_error', text: '09:20，周映看了看表。“离09:45的约定还有二十五分钟，”他说。他没有去交接，密封袋也还未开。', reject: false },
    ];
    for (const item of cases) {
      const snapshot = state();
      const correction = await reviewTopicContinuity({ frame: { companion: f.store.state(true).companions.find(role => role.id === 'writer')!, conversation: room,
        topic: snapshot.topic, topicState: snapshot.topicState, messages: [source, ...('priorText' in item ? [{ ...source, id: 'prior_assistant', sequence: source.sequence + 1,
          authorId: 'writer', content: item.priorText! }] : [])], sourceMessage: source },
        proposed: { kind: 'reply', text: item.text }, config: f.config, fetchFn: f.modelFetch });
      results.push({ ...item, correction, passed: Boolean(correction) === item.reject });
      await f.save(output, { status: 'running', fixtureKind: 'fixed_prose_boundary_regression_not_long_novel_generation', results, calls: f.calls });
    }
    expect(results.every(item => (item as { passed: boolean }).passed), JSON.stringify(results)).toBe(true); status = 'passed';
  } finally { await f.save(output, { status, fixtureKind: 'fixed_prose_boundary_regression_not_long_novel_generation', results, calls: f.calls }); await f.close(); }
}, 600000);
