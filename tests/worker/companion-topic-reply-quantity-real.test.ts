import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { realMainFixture } from '../fixtures/companion-real-main';
import { topicUserCanonSchema } from '../../src/main/companions/topic-user-canon';
import { topicSummaryClauses } from '../../src/main/companions/topic-summary-canon-review';
import { reviewTopicSourceQuantities } from '../../src/main/companions/topic-summary-quantity-review';
import BetterSqlite3 from 'better-sqlite3';

it.skipIf(process.env.WORLDLINEBOX_TOPIC_REPLY_QUANTITY_PHYSICAL_REAL !== '1')('distinguishes a non-key physically carried container count from an abstract collection', async () => {
  const quote = '这套共有5张卡，第4张仍未拿到。';
  const canon = topicUserCanonSchema.parse({ version: 1, throughSequence: 1, entries: [{ id: 'explicit_card_control',
    sourceMessageId: 'explicit_semantic_control_source', sourceChecksum: 'b'.repeat(64), quote, rule: quote }] });
  const f = await realMainFixture('raw_reply_quantity_physical_cards', []);
  const output = path.resolve('artifacts/vcp-validation', `topic-reply-quantity-physical-real-2026-10-24-${path.basename(f.root)}.json`);
  const checks: unknown[] = [], report: Record<string, unknown> = { status: 'running', canon, checks, calls: f.calls,
    fixtureKind: 'two_explicit_non_key_semantic_source_controls_not_stored_human_authority_no_writer_or_publication' };
  let status = 'failed';
  try {
    for (const test of [
      { id: 'physical_container_count_is_actual_inventory', text: '他想起衣袋里的五张卡，卡角正抵着腰侧。', rejected: true },
      { id: 'abstract_collection_size_is_not_carried_inventory', text: '他想着那套一共五张的卡，第四张还未送到，便继续等快递。', rejected: false },
    ]) {
      const start = f.calls.length;
      const correction = await reviewTopicSourceQuantities({ kind: 'reply', canon, summary: test.text, stage: '', clauses: topicSummaryClauses(test.text, ''),
        config: f.config, fetchFn: f.modelFetch, scope: { ownerId: 'physical_quantity_auditor', conversationId: f.label, topicId: 'explicit_card_source_control' } });
      checks.push({ ...test, correction, expectedQuantityRejected: test.rejected, observedCorrectionPresent: !!correction,
        diagnosticType: correction?.includes('unresolved_holding_relation') ? 'unresolved_holding_relation'
          : correction?.includes('mathematical_contradiction') ? 'mathematical_contradiction' : correction ? 'other_correction' : null,
        addedCalls: f.calls.length - start });
      expect(!!correction, test.id + '\n' + correction).toBe(test.rejected);
    }
    status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; await f.save(output, report, status !== 'passed'); await f.close(status !== 'passed'); }
}, 600000);

/** Read-only actual failed prose and explicit controls. No story writer,
 * checkpoint proposal or fictional action is dispatched by these audits. */
it.skipIf(process.env.WORLDLINEBOX_TOPIC_REPLY_QUANTITY_REAL !== '1')('audits the actual north three-in-pocket failure with legal raw-prose quantity controls', async () => {
  const original = path.resolve('artifacts/vcp-validation/long-novel-real-north_gate-2026-10-23-worldlinebox-real-main-tZEkeV.json');
  const previous = JSON.parse(await readFile(original, 'utf8'));
  const chapter = previous.chapters[0], raw = String(chapter.answer.content);
  const canon = topicUserCanonSchema.parse(chapter.checkpoint.turns.at(-1).topicPublicationApproval.userCanon);
  expect(raw).toContain('她想起口袋里的三把钥匙');
  const originalHash = createHash('sha256').update(raw).digest('hex');
  const f = await realMainFixture('raw_reply_quantity_controls', []);
  const output = path.resolve('artifacts/vcp-validation', `topic-reply-quantity-real-2026-10-24-${path.basename(f.root)}.json`);
  const checks: unknown[] = [], report: Record<string, unknown> = { status: 'running', original,
    fixtureKind: 'readonly_actual_failed_raw_reply_and_explicit_boundary_controls_no_writer_or_publication',
    actualSource: { id: chapter.answer.id, checksum: originalHash, text: raw }, canon, checks, calls: f.calls };
  let status = 'failed';
  try {
    const cases = [
      { id: 'actual_full_north_raw_three_in_pocket', text: raw, rejected: true },
      { id: 'full_raw_correct_two_in_pocket', text: raw.replace('口袋里的三把钥匙', '口袋里的两把钥匙'), rejected: false },
      { id: 'only_first_and_third_held', text: '许岚携带第1和第3把钥匙，第2把仍未找到。', rejected: false },
      { id: 'attributed_mans_claim_not_narrator_inventory', text: '男人声称“许岚口袋里有三把钥匙”。这只是他的说法；她实际只有第1和第3把钥匙，第2把仍未找到。', rejected: false },
      { id: 'future_possession_is_only_plan', text: '许岚计划将来找回第2把之后再带齐三把钥匙。现在她只携带第1和第3把钥匙。', rejected: false },
      { id: 'past_possession_is_not_current', text: '多年前，许岚曾把三把钥匙装在口袋里。眼下她只有第1和第3把钥匙，第2把仍未找到。', rejected: false },
      { id: 'another_actors_other_collection', text: '张明携带另一套三把备用钥匙，与许岚这组不是同一组。许岚只持有第1和第3把钥匙，第2把仍未找到。', rejected: false },
      { id: 'missing_member_is_not_held', text: '共有三把钥匙，许岚还没找到第2把。她没有把缺失的钥匙写进实际持有。', rejected: false },
    ];
    for (const test of cases) {
      const start = f.calls.length, clauses = topicSummaryClauses(test.text, '');
      const correction = await reviewTopicSourceQuantities({ kind: 'reply', canon, summary: test.text, stage: '', clauses, config: f.config,
        fetchFn: f.modelFetch, scope: { ownerId: 'readonly_actual_prose_auditor', conversationId: f.label, topicId: 'raw_reply_quantity_controls' } });
      checks.push({ ...test, correction, actualClauses: clauses, addedCalls: f.calls.length - start,
        elapsedMs: f.calls.slice(start).reduce((sum, call) => sum + (call.elapsedMs ?? 0), 0) });
      expect(!!correction, test.id + '\n' + correction).toBe(test.rejected);
    }
    expect(createHash('sha256').update(raw).digest('hex')).toBe(originalHash);
    status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; await f.save(output, report, status !== 'passed'); await f.close(status !== 'passed'); }
}, 600000);

it.skipIf(process.env.WORLDLINEBOX_TOPIC_REPLY_QUANTITY_MIXED_REAL !== '1')('keeps actual key quantities distinct from another object in the same sentence', async () => {
  const original = path.resolve('artifacts/vcp-validation/long-novel-real-north_gate-2026-10-23-worldlinebox-real-main-tZEkeV.json');
  const previous = JSON.parse(await readFile(original, 'utf8'));
  const canon = topicUserCanonSchema.parse(previous.chapters[0].checkpoint.turns.at(-1).topicPublicationApproval.userCanon);
  const f = await realMainFixture('raw_reply_quantity_mixed_objects', []);
  const output = path.resolve('artifacts/vcp-validation', `topic-reply-quantity-mixed-real-2026-10-24-${path.basename(f.root)}.json`);
  const checks: unknown[] = [], report: Record<string, unknown> = { status: 'running', original, canon, checks, calls: f.calls,
    fixtureKind: 'two_explicit_mixed_object_quantity_controls_using_original_actual_key_canon_no_new_writer_or_formal_publication' };
  let status = 'failed';
  try {
    for (const test of [{ text: '她随身携带三把钥匙和两张卡。', rejected: true }, { text: '她随身携带两把钥匙和三张卡。', rejected: false }]) {
      const start = f.calls.length;
      const correction = await reviewTopicSourceQuantities({ kind: 'reply', canon, summary: test.text, stage: '', clauses: topicSummaryClauses(test.text, ''),
        config: f.config, fetchFn: f.modelFetch, scope: { ownerId: 'mixed_quantity_auditor', conversationId: f.label, topicId: 'same_actual_key_canon' } });
      checks.push({ ...test, correction, expectedQuantityRejected: test.rejected, observedCorrectionPresent: !!correction, addedCalls: f.calls.length - start });
      expect(!!correction, test.text + '\n' + correction).toBe(test.rejected);
    }
    status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; await f.save(output, report, status !== 'passed'); await f.close(status !== 'passed'); }
}, 600000);

it.skipIf(process.env.WORLDLINEBOX_TOPIC_REPLY_QUANTITY_REPLAY_REAL !== '1')('replays the three exact ordinal-format-failed drafts without a new writer or quantity contradiction', async () => {
  const original = path.resolve('artifacts/vcp-validation/long-novel-real-north_gate-2026-10-23-worldlinebox-real-main-Wg24cp.json');
  const database = original.replace(/\.json$/u, '-sqlite/messages.sqlite');
  const previous = JSON.parse(await readFile(original, 'utf8')) as { status: string; chapters: unknown[];
    calls: Array<{ purpose: string; visibleText: string }> };
  expect(previous.status).toBe('failed'); expect(previous.chapters).toHaveLength(0);
  const extracted = JSON.parse(previous.calls.find(call => call.purpose === 'topic_user_canon_extract')!.visibleText) as {
    additions: Array<{ sourceMessageId: string; quote: string }> };
  const reader = new (BetterSqlite3 as { new(file: string, options: { readonly: boolean; fileMustExist: boolean }): {
    prepare(sql: string): { get(id: string): unknown }; close(): void } })(database, { readonly: true, fileMustExist: true });
  let source: { id: string; content: string; sequence: number };
  try { source = reader.prepare('SELECT id,content,sequence FROM messages WHERE id=?').get(extracted.additions[0]!.sourceMessageId) as typeof source; }
  finally { reader.close(); }
  expect(source!).toBeDefined();
  const sourceChecksum = createHash('sha256').update(source!.content).digest('hex');
  const canon = topicUserCanonSchema.parse({ version: 1, throughSequence: source!.sequence,
    entries: extracted.additions.map((entry, index) => {
      expect(entry.sourceMessageId).toBe(source!.id); expect(source!.content).toContain(entry.quote);
      return { id: 'actual-canon-' + index, sourceMessageId: source!.id, sourceChecksum, quote: entry.quote, rule: entry.quote };
    }) });
  const drafts = previous.calls.filter(call => call.purpose === 'reply_or_upstream_processor').map(call => call.visibleText);
  expect(drafts).toHaveLength(3);
  const f = await realMainFixture('raw_reply_ordinal_saved_drafts', []);
  const output = path.resolve('artifacts/vcp-validation', `topic-reply-quantity-replay-real-2026-10-24-${path.basename(f.root)}.json`);
  const checks: unknown[] = [], report: Record<string, unknown> = { status: 'running', original, database,
    fixtureKind: 'quantity_only_exact_three_actual_unpublished_drafts_no_new_writer_or_formal_publication',
    sourceId: source!.id, sourceChecksum, canon, checks, calls: f.calls };
  let status = 'failed';
  try {
    for (const [index, text] of drafts.entries()) {
      const start = f.calls.length;
      const correction = await reviewTopicSourceQuantities({ kind: 'reply', canon, summary: text, stage: '', clauses: topicSummaryClauses(text, ''),
        config: f.config, fetchFn: f.modelFetch, scope: { ownerId: 'saved_raw_quantity_auditor', conversationId: f.label, topicId: 'same_saved_source' } });
      checks.push({ writerAttempt: index + 1, text, contentChecksum: createHash('sha256').update(text).digest('hex'), correction,
        addedCalls: f.calls.length - start, expectedQuantityRejected: false, observedCorrectionPresent: !!correction });
      expect(correction, 'quantity-only actual writer attempt ' + (index + 1)).toBeUndefined();
    }
    status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; await f.save(output, report, status !== 'passed'); await f.close(status !== 'passed'); }
}, 600000);

it.skipIf(process.env.WORLDLINEBOX_TOPIC_REPLY_QUANTITY_SOURCE_PREMISE_REAL !== '1')('replays exact tidal drafts and distinguishes physical missing objects from unknown or damaged attributes', async () => {
  const original = path.resolve('artifacts/vcp-validation/long-novel-real-tidal_archive-2026-10-23-worldlinebox-real-main-ULA6xj.json');
  const originalBytes = await readFile(original), previous = JSON.parse(originalBytes.toString('utf8')) as { status: string; chapters: unknown[];
    calls: Array<{ purpose: string; visibleText: string }> };
  expect(previous.status).toBe('failed'); expect(previous.chapters).toHaveLength(0);
  const extracted = JSON.parse(previous.calls.find(call => call.purpose === 'topic_user_canon_extract')!.visibleText) as {
    additions: Array<{ sourceMessageId: string; quote: string }> };
  const database = original.replace(/\.json$/u, '-sqlite/messages.sqlite');
  const reader = new (BetterSqlite3 as { new(file: string, options: { readonly: boolean; fileMustExist: boolean }): {
    prepare(sql: string): { get(id: string): unknown }; close(): void } })(database, { readonly: true, fileMustExist: true });
  let source: { id: string; content: string; sequence: number };
  try { source = reader.prepare('SELECT id,content,sequence FROM messages WHERE id=?').get(extracted.additions[0]!.sourceMessageId) as typeof source; }
  finally { reader.close(); }
  expect(source!).toBeDefined();
  const sourceChecksum = createHash('sha256').update(source!.content).digest('hex');
  const canon = topicUserCanonSchema.parse({ version: 1, throughSequence: source!.sequence, entries: extracted.additions.map((entry, index) => {
    expect(entry.sourceMessageId).toBe(source!.id); expect(source!.content).toContain(entry.quote);
    return { id: 'actual-tidal-canon-' + index, sourceMessageId: source!.id, sourceChecksum, quote: entry.quote, rule: entry.quote };
  }) });
  const drafts = previous.calls.filter(call => call.purpose === 'reply_or_upstream_processor').map(call => call.visibleText);
  expect(drafts).toHaveLength(3);
  const controlCanon = (quote: string) => topicUserCanonSchema.parse({ version: 1, throughSequence: 1, entries: [{ id: 'explicit-source-control',
    sourceMessageId: 'explicit-source-control', sourceChecksum: createHash('sha256').update(quote).digest('hex'), quote, rule: quote }] });
  const missing = controlCanon('这组共有7张照片，第5张照片尚未取得，当前盒内没有这张照片。');
  const cases = [
    ...drafts.map((text, index) => ({ name: 'actual_tidal_draft_' + (index + 1), text, canon, expectedQuantityRejected: false })),
    { name: 'actual_physical_missing_cannot_hold_seven', text: '她把这盒7张照片全拿在手里。', canon: missing, expectedQuantityRejected: true },
    { name: 'actual_physical_missing_allows_six_present_members', text: '她拿着这盒的第1、第2、第3、第4、第6和第7张照片，第5张仍未取得。', canon: missing, expectedQuantityRejected: false },
    { name: 'present_but_damaged_does_not_make_a_missing_member', text: '她把盒内7张照片都拿在手里，第5张背面破损。',
      canon: controlCanon('盒内7张照片都在，第5张照片背面破损。'), expectedQuantityRejected: false },
  ];
  const f = await realMainFixture('raw_reply_source_premise', []);
  const output = path.resolve('artifacts/vcp-validation', `topic-reply-quantity-source-premise-real-2026-10-24-${path.basename(f.root)}.json`);
  const checks: unknown[] = [], report: Record<string, unknown> = { status: 'running', original, database,
    originalReportChecksum: createHash('sha256').update(originalBytes).digest('hex'), sourceId: source!.id, sourceChecksum, canon, checks, calls: f.calls,
    fixtureKind: 'quantity_only_exact_three_tidal_drafts_plus_three_physical_source_countercontrols_no_new_writer_or_publication',
    sourcePremiseCost: { normalCacheMissModelCalls: 4, maximumInitialFormatCalls: 12, authorAttempts: 3 } };
  let status = 'failed';
  try {
    for (const test of cases) {
      const start = f.calls.length;
      const correction = await reviewTopicSourceQuantities({ kind: 'reply', canon: test.canon, summary: test.text, stage: '', clauses: topicSummaryClauses(test.text, ''),
        config: f.config, fetchFn: f.modelFetch, scope: { ownerId: 'source_premise_quantity_auditor', conversationId: f.label, topicId: 'source_premise_controls' } });
      checks.push({ ...test, contentChecksum: createHash('sha256').update(test.text).digest('hex'), correction,
        addedCalls: f.calls.length - start, observedCorrectionPresent: !!correction,
        observedDiagnosticType: correction?.includes('mathematical_contradiction') ? 'mathematical_contradiction'
          : correction?.includes('unresolved_source_premise') ? 'unresolved_source_premise' : correction ? 'other_correction' : 'allowed' });
      expect(!!correction, test.name).toBe(test.expectedQuantityRejected);
    }
    status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; await f.save(output, report, status !== 'passed'); await f.close(status !== 'passed'); }
}, 600000);

it.skipIf(process.env.WORLDLINEBOX_TOPIC_REPLY_QUANTITY_ALL_REAL !== '1')('audits no-numeral whole-set possession separately from a future or negated plan', async () => {
  const original = path.resolve('artifacts/vcp-validation/long-novel-real-north_gate-2026-10-23-worldlinebox-real-main-tZEkeV.json');
  const previous = JSON.parse(await readFile(original, 'utf8'));
  const canon = topicUserCanonSchema.parse(previous.chapters[0].checkpoint.turns.at(-1).topicPublicationApproval.userCanon);
  const f = await realMainFixture('raw_reply_quantity_all_relation', []);
  const output = path.resolve('artifacts/vcp-validation', `topic-reply-quantity-all-real-2026-10-24-${path.basename(f.root)}.json`);
  const checks: unknown[] = [], report: Record<string, unknown> = { status: 'running', original, canon, checks, calls: f.calls,
    fixtureKind: 'two_explicit_no_numeral_all_relation_controls_using_original_actual_key_canon_no_new_writer_or_publication' };
  let status = 'failed';
  try {
    for (const test of [{ text: '她把钥匙全部带在身上。', rejected: true }, { text: '她计划日后带齐钥匙，当前尚未带齐。', rejected: false }]) {
      const start = f.calls.length;
      const correction = await reviewTopicSourceQuantities({ kind: 'reply', canon, summary: test.text, stage: '', clauses: topicSummaryClauses(test.text, ''),
        config: f.config, fetchFn: f.modelFetch, scope: { ownerId: 'all_relation_quantity_auditor', conversationId: f.label, topicId: 'same_actual_key_canon' } });
      checks.push({ ...test, correction, observedCorrectionPresent: !!correction, expectedQuantityRejected: test.rejected, addedCalls: f.calls.length - start });
      expect(!!correction, test.text + '\n' + correction).toBe(test.rejected);
    }
    status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; await f.save(output, report, status !== 'passed'); await f.close(status !== 'passed'); }
}, 600000);

it.skipIf(process.env.WORLDLINEBOX_TOPIC_REPLY_QUANTITY_COGNITIVE_REAL !== '1')('keeps an unconfirmed belief and recalled third-party claim distinct from narrator inventory', async () => {
  const original = path.resolve('artifacts/vcp-validation/long-novel-real-north_gate-2026-10-23-worldlinebox-real-main-tZEkeV.json');
  const previous = JSON.parse(await readFile(original, 'utf8'));
  const canon = topicUserCanonSchema.parse(previous.chapters[0].checkpoint.turns.at(-1).topicPublicationApproval.userCanon);
  const f = await realMainFixture('raw_reply_quantity_cognitive_attribution', []);
  const output = path.resolve('artifacts/vcp-validation', `topic-reply-quantity-cognitive-real-2026-10-24-${path.basename(f.root)}.json`);
  const checks: unknown[] = [], report: Record<string, unknown> = { status: 'running', original, canon, checks, calls: f.calls,
    fixtureKind: 'two_explicit_belief_and_nested_attribution_controls_original_source_canon_no_writer_or_publication' };
  let status = 'failed';
  try {
    for (const test of [
      { id: 'unconfirmed_belief_not_narrator_inventory', text: '许岚以为口袋里有三把钥匙，伸手却只摸到第一把和第三把，第二把仍未找到。' },
      { id: 'recalled_third_party_claim_not_narrator_inventory', text: '许岚想起男人刚才声称“她口袋里有三把钥匙”；她实际拿在手里的仍只有第一把和第三把，第二把没有找到。' },
    ]) {
      const start = f.calls.length;
      const correction = await reviewTopicSourceQuantities({ kind: 'reply', canon, summary: test.text, stage: '', clauses: topicSummaryClauses(test.text, ''),
        config: f.config, fetchFn: f.modelFetch, scope: { ownerId: 'cognitive_quantity_auditor', conversationId: f.label, topicId: 'same_actual_key_canon' } });
      checks.push({ ...test, correction, expectedQuantityRejected: false, observedCorrectionPresent: !!correction, addedCalls: f.calls.length - start });
      expect(correction, test.id).toBeUndefined();
    }
    status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; await f.save(output, report, status !== 'passed'); await f.close(status !== 'passed'); }
}, 600000);
