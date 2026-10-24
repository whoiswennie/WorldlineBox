import path from 'node:path';
import { expect, it } from 'vitest';
import { realMainFixture } from '../fixtures/companion-real-main';
import { prepareTopicNarrativeReferences } from '../../src/main/companions/topic-narrative-references';
import { reviewTopicContinuity } from '../../src/main/companions/topic-continuity-review';
import type { CompanionReplyInput } from '../../src/main/companions/context';

it.skipIf(process.env.WORLDLINEBOX_NARRATIVE_REFERENCES_REAL !== '1')('extracts actual narrative references and independently abstains on actor switches and direct speech', async () => {
  const f = await realMainFixture('reference_semantic_boundaries', [{ id: 'writer', name: '林澄', persona: '独立伙伴', description: '', model: '', avatar: 'sister', active: false, proactive: false }]);
  const output = path.resolve('artifacts/vcp-validation', `topic-narrative-references-real-2026-10-23-${path.basename(f.root)}.json`);
  const cases = [
    { label: 'unambiguous_named_subject_body_continuation', content: '许岚握着提灯的手一紧。他的戒指在灯下没有亮，寒意却顺着掌心往上爬了一截。', expected: '他' },
    { label: 'object_antecedent_ambiguous', content: '许岚看向沈舟，他正站在门边。', expected: undefined },
    { label: 'intermediate_actor_switched', content: '许岚往前走了两步，又在巷子中段停住。短斗篷没有退，也没有让开。他站在雾里像一根插进灰白的木桩。', expected: undefined },
    { label: 'intermediate_noun_actor_switched', content: '许岚没有回答。雾把那人往巷子深处推了半步。他的斗篷边缘融进灰白里。', expected: undefined },
    { label: 'direct_speech_other_person', content: '许岚停在门口，告诉守门人：“他今天不会来，我独自去。”', expected: undefined },
  ];
  const results: unknown[] = [], report: Record<string, unknown> = { status: 'running', fixtureKind: 'fixed_source_semantic_boundary_calls_not_generated_novel_or_Main_publication', results, calls: f.calls };
  let status = 'failed';
  try {
    const room = f.store.openPrivate('writer'), companion = f.store.state().companions.find(role => role.id === 'writer')!;
    for (const [index, sample] of cases.entries()) {
      const topic = f.store.request({ type: 'topic.create', conversationId: room.id, readerId: 'user', title: sample.label, kind: 'story' }).topic!;
      const joined = f.store.request({ type: 'topic.join', conversationId: room.id, readerId: 'writer', topicId: topic.id }).topic!;
      const frame = { companion, conversation: room, topic: joined, messages: [{ id: `source_${index}`, sequence: 1, conversationId: room.id, topicId: topic.id,
        content: sample.content, authorId: 'writer', kind: 'text', status: 'sent', attachments: [], createdAt: new Date().toISOString() }] } as Pick<CompanionReplyInput, 'companion' | 'conversation' | 'topic' | 'messages'>;
      const from = f.calls.length;
      const value = await prepareTopicNarrativeReferences({ frame, config: f.config, fetchFn: f.modelFetch });
      const refs = value.references.filter(ref => ref.subjectName === '许岚');
      results.push({ ...sample, value, newCalls: f.calls.length - from, elapsedMs: f.calls.slice(from).reduce((sum, call) => sum + (call.elapsedMs ?? 0), 0) });
      if (sample.expected) expect(refs.some(ref => ref.sourcePronoun === sample.expected)).toBe(true);
      else expect(refs).toHaveLength(0);
      await prepareTopicNarrativeReferences({ frame, config: f.config, fetchFn: f.modelFetch });
      expect(f.calls.length - from).toBeLessThanOrEqual(2);
      if (index === 0) {
        const reviewCases = [
          { label: 'same_actor_same_pronoun', text: '许岚走向台阶，他把灯举稳。', reject: false },
          { label: 'same_actor_changed_pronoun', text: '许岚走向台阶，她把灯举稳。', reject: true },
          { label: 'same_actor_mixed_pronouns_in_one_draft', text: '许岚举灯，他往前走。许岚停住，她把灯放低。', reject: true },
          { label: 'different_actors_can_use_different_pronouns_in_one_draft', text: '许岚举灯，他往前走。沈舟从旁门出来，她朝灯光望了一眼。', reject: false },
          { label: 'new_actor_can_use_other_pronoun', text: '沈舟从旁门出来，她朝灯光望了一眼。', reject: false },
          { label: 'quoted_other_person', text: '许岚举灯说：“她今晚不会来。”', reject: false },
          { label: 'current_user_same_field_revision', text: '许岚走向台阶，她把灯举稳。', user: '编辑修订：许岚从此改用女性代词“她”，其余设定保持。', reject: false },
          { label: 'current_user_other_field_does_not_revise_pronoun', text: '许岚走向台阶，她把灯举稳。', user: '只把门牌R-107更正为R-701，其余设定保持。', reject: true },
        ];
        for (const check of reviewCases) {
          const source = check.user ? { ...frame.messages[0]!, id: check.label, sequence: 2, authorId: 'user', content: check.user } : undefined;
          const actual = f.store.request({ type: 'topic.read', conversationId: room.id, readerId: 'writer', topicId: topic.id });
          const reviewFrame = { ...frame, topicState: actual.topicState, messages: [...frame.messages, ...(source ? [source] : [])], sourceMessage: source };
          const feedback = await reviewTopicContinuity({ frame: reviewFrame, proposed: { kind: 'reply', text: check.text }, narrativeReferences: value, config: f.config, fetchFn: f.modelFetch });
          results.push({ kind: 'fixed_proposed_reference_checks_not_published_content', ...check, feedback });
          if (check.reject) expect(feedback).toContain('"originalPronoun":"他","proposedPronoun":"她"'); else expect(feedback).toBeUndefined();
        }
      }
    }
    status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; await f.save(output, report, status !== 'passed'); await f.close(status !== 'passed'); }
}, 600000);
