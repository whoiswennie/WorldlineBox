import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { realMainFixture } from '../fixtures/companion-real-main';
import { reviewTopicSummaryCanon } from '../../src/main/companions/topic-summary-canon-review';
import { topicUserCanonSchema, type TopicUserCanon } from '../../src/main/companions/topic-user-canon';

/** Read-only semantic boundary controls; the altered texts are review inputs,
 * never generated chapters or summaries submitted into a new fiction run. */
it.skipIf(process.env.WORLDLINEBOX_SUMMARY_CANON_REAL !== '1')('rejects the real total-versus-carried error while allowing correct possession, attributed speech and unrelated quantities', async () => {
  const original = path.resolve('artifacts/vcp-validation/topic-summary-convergence-real-2026-10-24-worldlinebox-real-main-39GHjB.json');
  const previous = JSON.parse(await readFile(original, 'utf8')) as { after: { summary: string; stage: string; state: { __topicUserCanon: unknown } } };
  const f = await realMainFixture('summary_canon_controls', []);
  const output = path.resolve('artifacts/vcp-validation', `topic-summary-canon-real-2026-10-24-${path.basename(f.root)}.json`);
  const checks: unknown[] = [], report: Record<string, unknown> = { status: 'running', original,
    fixtureKind: 'read_only_actual_failed_summary_and_explicit_boundary_controls_not_new_prose_or_summary_publication', checks, calls: f.calls };
  const canon = topicUserCanonSchema.parse(previous.after.state.__topicUserCanon);
  const generic = (quote: string): TopicUserCanon => ({ version: 1, throughSequence: 1, entries: [{ id: 'synthetic_control', sourceMessageId: 'control_source', sourceChecksum: 'a'.repeat(64), quote, rule: quote }] });
  let status = 'failed';
  try {
    const cases = [
      { id: 'actual_bad_total_to_carried', canon, ...previous.after, rejected: true },
      { id: 'correct_first_and_third_only', canon, summary: previous.after.summary.replace('许岚带信与3把钥匙', '许岚携带信与第1、第3把钥匙（第2把仍未找到）'), stage: previous.after.stage, rejected: false },
      { id: 'attributed_other_speech_not_a_fact', canon, summary: '许岚携带第1和第3把钥匙，第2仍未找到。A17声称“你身上有三把钥匙”，摘要只记录他的说法，不据此认定缺失钥匙已找到。', stage: '未交信', rejected: false },
      { id: 'unrelated_cards_total_is_not_possession', canon: generic('共有5张卡，第4张尚未拿到。'), summary: '第4张尚未拿到。他带齐了5张卡进门。', stage: '进门', rejected: true },
      { id: 'unrelated_cards_actual_subset', canon: generic('共有5张卡，第4张尚未拿到。'), summary: '他携带第1、2、3、5张卡，第4张还未到手。', stage: '等第4张', rejected: false },
      { id: 'different_owner_and_set_same_noun', canon: generic('本组共有3把钥匙，第2把尚未找到。'), summary: '张明带着3把备用钥匙，那是另一组备用器材，与本组不是同一组。本组第2把钥匙仍未找到。', stage: '本组未齐', rejected: false },
      { id: 'planned_all_possession_is_not_current', canon: generic('本组共有3把钥匙，第2把尚未找到。'), summary: '她计划日后带齐三把钥匙，目前只有第1和第3把，第2把仍未找到。', stage: '仅是未来计划', rejected: false },
      { id: 'multiple_missing_tool_members', canon: generic('共有7件工具，第3件和第6件仍未拿到。'), summary: '目前7件工具都带齐在他手里。', stage: '带齐', rejected: true },
      { id: 'multiple_missing_legal_subset', canon: generic('共有7件工具，第3件和第6件仍未拿到。'), summary: '他只带了第1、2、4、5、7件工具，第3和第6件仍未拿到。', stage: '持有5件', rejected: false },
      { id: 'planned_use_is_not_actual_use', canon: generic('备用胶囊9枚，当前一枚也没有使用。'), summary: '备用胶囊9枚尚未使用，计划明日再考虑用2枚，尚未实施。', stage: '计划未实施', rejected: false },
      { id: 'actual_use_conflicts_with_none_used', canon: generic('备用胶囊9枚，当前一枚也没有使用。'), summary: '备用胶囊最初9枚，一枚也没有使用。他随后已经用掉2枚，剩7枚。', stage: '已用2枚', rejected: true },
    ];
    for (const test of cases) {
      const start = f.calls.length, correction = await reviewTopicSummaryCanon({ canon: test.canon, summary: test.summary, stage: test.stage, config: f.config, fetchFn: f.modelFetch,
        scope: { ownerId: 'readonly_fixture_auditor', conversationId: f.label, topicId: 'explicit_boundary_controls' } });
      checks.push({ id: test.id, summary: test.summary, stage: test.stage, expectedQuantityRejected: test.rejected, rejected: Boolean(correction), correction,
        addedCalls: f.calls.length - start, elapsedMs: f.calls.slice(start).reduce((sum, call) => sum + (call.elapsedMs ?? 0), 0) });
      expect(!!correction, test.id + '\n' + correction).toBe(test.rejected);
    }
    status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; await f.save(output, report, status !== 'passed'); await f.close(status !== 'passed'); }
}, 600000);
