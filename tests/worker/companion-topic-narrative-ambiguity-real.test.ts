import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it } from 'vitest';
import { realMainFixture } from '../fixtures/companion-real-main';
import { CompanionsStore } from '../../src/companions/store';
import { ensureTopicContinuity } from '../../src/main/companions/topic-compaction';
import { prepareTopicNarrativeReferences } from '../../src/main/companions/topic-narrative-references';
import { reviewTopicContinuity } from '../../src/main/companions/topic-continuity-review';
import { topicUserCanonSchema } from '../../src/main/companions/topic-user-canon';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionReplyInput } from '../../src/main/companions/context';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
it.skipIf(process.env.WORLDLINEBOX_TOPIC_NARRATIVE_AMBIGUITY_REAL !== '1')('reviews actual north4-to5 without the false male anchor and preserves clean literal male/female controls', async () => {
  const originalReport = path.resolve('artifacts/vcp-validation/long-novel-real-north_gate-2026-10-23-worldlinebox-real-main-tZEkeV.json');
  const originalDatabase = originalReport.replace(/\.json$/u, '-sqlite/messages.sqlite');
  const parent = JSON.parse(await readFile(originalReport, 'utf8')) as { status: string; chapters: Array<{ source: CompanionMessage; answer: CompanionMessage }>;
    calls: Array<{ purpose: string; visibleText?: string; storyFocusWire?: { sourceId: string } }> };
  expect(parent.status).toBe('failed'); expect(parent.chapters).toHaveLength(4);
  const f = await realMainFixture('actual_north_ambiguous_reference', [{ id: 'writer', name: '林澄', description: '', persona: '独立虚拟伙伴。', model: '', avatar: 'sister', active: false, proactive: false }]);
  const output = path.resolve('artifacts/vcp-validation', `topic-narrative-ambiguity-real-2026-10-24-${path.basename(f.root)}.json`);
  const replayFile = path.join(f.root, 'replay', 'messages.sqlite'); await mkdir(path.dirname(replayFile), { recursive: true });
  const originalHash = sha(await readFile(originalDatabase));
  const reader = new (BetterSqlite3 as { new(file: string, options: { readonly: boolean; fileMustExist: boolean }): {
    backup(file: string): Promise<unknown>; close(): void } })(originalDatabase, { readonly: true, fileMustExist: true });
  await reader.backup(replayFile); reader.close();
  const store = new CompanionsStore(replayFile, []), controls: unknown[] = [];
  const report: Record<string, unknown> = { status: 'running', originalReport, originalDatabase, originalHash, replayFile,
    fixtureKind: 'actual_saved_failed_Main_port_read_only_review_plus_explicit_synthetic_grammar_controls_not_new_chapters_or_completed_novel', controls, calls: f.calls };
  let status = 'failed';
  try {
    const sourceId = parent.calls.findLast(call => call.storyFocusWire)?.storyFocusWire?.sourceId;
    if (!sourceId) throw new Error('Original actual current source is missing.');
    const source = store.getMessage(sourceId), prior = parent.chapters.at(-1)!.answer;
    expect(store.getMessage(prior.id).content).toBe(prior.content);
    const proposed = parent.calls.filter(call => call.purpose === 'reply_or_upstream_processor' && call.storyFocusWire?.sourceId === source.id).at(-1)?.visibleText;
    if (!proposed) throw new Error('Original final rejected actual writer draft is missing.');
    const view = store.request({ type: 'topic.read', conversationId: source.conversationId, topicId: source.topicId!, readerId: 'writer' });
    const rebuilt = await ensureTopicContinuity({ frame: { companion: store.state().companions.find(owner => owner.id === 'writer')!,
      conversation: store.openPrivate('writer'), topic: view.topic, topicState: view.topicState, sourceMessage: source,
      messages: store.messages({ conversationId: source.conversationId, topicId: source.topicId, limit: 100 }).messages, memories: [] },
      request: async command => store.request(command), config: f.config, fetchFn: f.modelFetch });
    const canon = topicUserCanonSchema.parse(rebuilt.topicState!.workingState!.state!.__topicUserCanon);
    const start = f.calls.length, references = await prepareTopicNarrativeReferences({ frame: rebuilt, config: f.config, fetchFn: f.modelFetch });
    expect(f.calls.slice(start).filter(call => call.purpose.startsWith('topic_narrative_reference_')).length).toBeLessThanOrEqual(2);
    expect(references.references.some(reference => reference.subjectName === '许岚' && reference.sourcePronoun === '她')).toBe(true);
    expect(references.references.some(reference => reference.subjectName === '许岚' && reference.sourcePronoun === '他')).toBe(false);
    const good = await reviewTopicContinuity({ frame: rebuilt, proposed: { kind: 'reply', text: proposed }, canon,
      narrativeReferences: references, config: f.config, fetchFn: f.modelFetch });
    const bad = await reviewTopicContinuity({ frame: rebuilt, proposed: { kind: 'reply', text: proposed.replaceAll('她', '他') }, canon,
      narrativeReferences: references, config: f.config, fetchFn: f.modelFetch });
    report.actualReplay = { source, priorId: prior.id, priorChecksum: sha(prior.content), proposed, proposedChecksum: sha(proposed), references, good, bad,
      rebuiltSources: rebuilt.messages.map(message => ({ messageId: message.id, sourceChecksum: sha(message.content) })) };
    expect(good).toBeUndefined(); expect(bad).toMatch(/指代|代词|originalPronoun/u); expect(bad).toContain('许岚');
    const reset = await reviewTopicContinuity({ frame: rebuilt, proposed: { kind: 'reply', text: '二十二点零九分，许岚还没有迈出第一步，仍站在离墙垛两步的原地。' }, canon,
      narrativeReferences: references, config: f.config, fetchFn: f.modelFetch });
    report.actualSourceResetNegativeControl = { kind: 'explicit_negative_candidate_only_not_published_prose', reset };
    expect(reset).toBeTypeOf('string'); expect(reset).toMatch(/迈|站|位置|动作/u);
    for (const pronoun of ['他', '她'] as const) {
      const room = f.store.openPrivate('writer');
      const topic = f.store.request({ type: 'topic.create', conversationId: room.id, readerId: 'user', kind: 'story', title: '明确指代正反控制_' + pronoun }).topic!;
      f.store.request({ type: 'topic.join', conversationId: room.id, topicId: topic.id, readerId: 'writer' });
      const formal = f.store.appendMessage({ conversationId: room.id, topicId: topic.id, authorId: 'writer', content: `许岚握着提灯的手一紧。${pronoun}的戒指没有亮。`, replyDirective: 'none' });
      const request = f.store.appendMessage({ conversationId: room.id, topicId: topic.id, authorId: 'user', content: '继续这个虚构场景。', replyDirective: 'none' });
      const state = f.store.request({ type: 'topic.read', conversationId: room.id, topicId: topic.id, readerId: 'writer' });
      const frame: CompanionReplyInput = { companion: f.store.state().companions.find(owner => owner.id === 'writer')!, conversation: room,
        topic: state.topic, topicState: state.topicState, sourceMessage: request, messages: [formal, request], memories: [] };
      const refs = await prepareTopicNarrativeReferences({ frame, config: f.config, fetchFn: f.modelFetch });
      expect(refs.references).toHaveLength(1); expect(refs.references[0]!.sourcePronoun).toBe(pronoun);
      const text = `许岚站在窗边。${pronoun}把灯放下。`, opposite = pronoun === '他' ? '她' : '他';
      const positive = await reviewTopicContinuity({ frame, proposed: { kind: 'reply', text }, canon: { version: 1, throughSequence: request.sequence, entries: [] },
        narrativeReferences: refs, config: f.config, fetchFn: f.modelFetch });
      const negative = await reviewTopicContinuity({ frame, proposed: { kind: 'reply', text: text.replaceAll(pronoun, opposite) }, canon: { version: 1, throughSequence: request.sequence, entries: [] },
        narrativeReferences: refs, config: f.config, fetchFn: f.modelFetch });
      controls.push({ kind: 'explicit_synthetic_source_grammar_boundary_not_new_novel_prose', formal, request, refs, positive, negative });
      expect(positive).toBeUndefined(); expect(negative).toContain(`"originalPronoun":"${pronoun}","proposedPronoun":"${opposite}"`);
    }
    expect(sha(await readFile(originalDatabase))).toBe(originalHash); status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; store.close(); await f.close(true); await f.save(output, report, true); }
}, 600000);
