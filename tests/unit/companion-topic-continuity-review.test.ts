// This suite isolates the host contract; semantic source binding has its own
// mechanism and opt-in actual-model suites.
vi.mock('../../src/main/companions/topic-narrative-references', () => ({ prepareTopicNarrativeReferences: async () => ({
  status: 'abstained', scope: 'recent_authorized_formal_story_text_not_a_permanent_identity_ledger', selectedSources: [], references: [], conflicts: [],
}) }));
const quantityReview = vi.hoisted(() => vi.fn<(input: unknown) => Promise<string | undefined>>(async () => undefined));
vi.mock('../../src/main/companions/topic-summary-quantity-review', () => ({ reviewTopicSourceQuantities: quantityReview,
  reviewTopicSummaryQuantities: async () => undefined }));
import { expect, it, vi } from 'vitest';
import { reviewTopicContinuity, type TopicContinuityReviewInput } from '../../src/main/companions/topic-continuity-review';
import { createHash } from 'node:crypto';
import { topicCanonRangeDigest, type TopicUserCanon } from '../../src/main/companions/topic-user-canon';

function fixture(): TopicContinuityReviewInput {
  const stamp = '2026-10-23T00:00:00Z';
  return { config: { apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fixture' }, proposed: { kind: 'reply', text: '继续当前场景。' }, extractCanon: async () => ({ additions: [], revisions: [] }),
    frame: { companion: { id: 'alice', name: '阿澄', persona: '本人', description: '', model: '', avatar: 'sister', createdAt: stamp, builtin: false, proactive: false },
      conversation: { id: 'group', kind: 'group', title: '群', memberIds: ['alice'], muted: false, pinned: false, unread: 0, lastMessage: '', updatedAt: stamp },
      topic: { id: 'story', conversationId: 'group', kind: 'story', status: 'active', title: '小说', moderatorId: 'user', revision: 1, participantIds: ['alice'], invitedIds: [], tags: [], createdAt: stamp, updatedAt: stamp },
      topicState: { topicId: 'story', readerId: 'alice', trust: 'topic_state_not_real_world_facts', workingState: { sourceEventId: 'checkpoint', authorId: 'alice', revision: 1, updatedAt: stamp,
        sourceMessageIds: ['old'], summary: '信件尚未打开，收件人身份未知。', state: { privateHypothesis: '本人推测，尚未公开。' } } },
      messages: [{ id: 'legal', sequence: 1, conversationId: 'group', topicId: 'story', authorId: 'user', kind: 'text', status: 'sent', content: '继续场景，不揭晓信内内容。', createdAt: stamp, attachments: [] }] } };
}

it('checks the entire actual story reply quantity assertion before approving publication without letting a generic critic waive arithmetic', async () => {
  const f = fixture(), review = vi.fn(async () => ({ supported: true, issues: [] })), approval = vi.fn();
  f.proposed = { kind: 'reply', text: '她带着3把钥匙。第2把仍未找到。' };
  quantityReview.mockResolvedValueOnce('实际持有3超过来源上界2。');
  expect(await reviewTopicContinuity({ ...f, review, onPublicationApproved: approval })).toBe('实际持有3超过来源上界2。');
  expect(quantityReview).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'reply', summary: f.proposed.text, stage: '',
    scope: { ownerId: 'alice', conversationId: 'group', topicId: 'story' },
    clauses: [expect.objectContaining({ text: '她带着3把钥匙。' }), expect.objectContaining({ text: '第2把仍未找到。' })] }));
  expect(review).not.toHaveBeenCalled(); expect(approval).not.toHaveBeenCalled();
});

it('gives the second reader only actual quote pairs and sources instead of the first critic conclusion', async () => {
  const f = fixture(); f.proposed = { kind: 'reply', text: '男人往墙垛靠了一步。' };
  f.frame.messages = [{ ...f.frame.messages[0]!, content: '许岚迈了两步，站到墙垛背风处。' }];
  const feedback = await reviewTopicContinuity({ ...f, review: async () => ({ supported: false, issues: [{
    claim: 'MISLEADING_SAME_PERSON_TIME_RESET', basis: 'MISLEADING_ASSUMED_ACTOR', correction: 'UNSUPPORTED_REWRITE',
    claimQuote: '男人往墙垛靠了一步。', basisQuote: '许岚迈了两步，站到墙垛背风处。' }] }), adjudicate: async context => {
      expect(context.user).not.toMatch(/MISLEADING_SAME_PERSON_TIME_RESET|MISLEADING_ASSUMED_ACTOR|UNSUPPORTED_REWRITE/u);
      const data = JSON.parse(context.user); expect(data.proposedIssues).toEqual([{ claimQuote: '男人往墙垛靠了一步。', basisQuote: '许岚迈了两步，站到墙垛背风处。' }]);
      expect(data.issueSources[0].messages[0].content).toBe(f.frame.messages[0]!.content);
      return { upheldIssueIndexes: [] };
    } });
  expect(feedback).toBeUndefined();
});

it('reviews only this owner/topic formal authorized snapshot and carries exact negative and unknown constraints', async () => {
  const f = fixture(), legal = f.frame.messages[0]!;
  f.frame.messages = [...f.frame.messages, { ...legal, id: 'other_topic', topicId: 'else', content: 'UNRELATED_SECRET' },
    { ...legal, id: 'draft', isReplyDraft: true, content: 'REJECTED_DRAFT' }];
  const review = vi.fn(async context => {
    const data = JSON.parse(context.user);
    expect(data.messages.map((message: { id: string }) => message.id)).toEqual(['legal']);
    expect(data.checkpoints.readerPrivate.summary).toContain('未知');
    expect(data.delivery).toEqual({ conversationKind: 'group', memberIds: ['alice'] });
    expect(context.user).not.toMatch(/UNRELATED_SECRET|REJECTED_DRAFT/u);
    return { supported: true, issues: [] };
  });
  expect(await reviewTopicContinuity({ ...f, review })).toBeUndefined(); expect(review).toHaveBeenCalledOnce();
});

it('returns precise same-source repair feedback without fabricating replacement prose', async () => {
  const f = fixture(); f.proposed = { kind: 'reply', text: '她打开信，读到了收件人的真名。' };
  const correction = await reviewTopicContinuity({ ...f, adjudicate: async () => ({ upheldIssueIndexes: [0] }), review: async () => ({ supported: false, issues: [{
    claim: '她打开信', claimQuote: '她打开信', basis: 'legal明确禁止揭晓；checkpoint记为尚未打开', basisQuote: '不揭晓信内内容', correction: '保留信件未开、身份未知，改写越界动作。' }] }) });
  expect(correction).toContain('legal'); expect(correction).toContain('未知'); expect(correction).toContain('未发布草稿');
});

it('does not let unsupported critic suggestions block legitimate new creation', async () => {
  const f = fixture(); f.proposed = { kind: 'reply', text: '再次看表' };
  const review = vi.fn(async () => ({ supported: false, issues: [{ claim: '再次看表', claimQuote: '再次看表', basis: '先前看过表', basisQuote: '信件尚未打开', correction: '不得再看表' }] }));
  expect(await reviewTopicContinuity({ ...f, review, adjudicate: async context => {
    expect(JSON.parse(context.user).proposedIssues[0]).toEqual({ claimQuote: '再次看表', basisQuote: '信件尚未打开' });
    return { upheldIssueIndexes: [] };
  } })).toBeUndefined();
});

it('gives the issue adjudicator matched source evidence rather than unrelated old checkpoint interpretations', async () => {
  const f = fixture(); f.frame.topicState!.workingState!.summary += ' UNRELATED_OLD_CHECKPOINT_INTERPRETATION';
  f.proposed = { kind: 'reply', text: '再次看表' };
  const correction = await reviewTopicContinuity({ ...f,
    review: async () => ({ supported: false, issues: [{ claim: '重复看表', claimQuote: '再次看表', basis: '旧摘要', basisQuote: '信件尚未打开', correction: '不得再看' }] }),
    adjudicate: async context => {
      const data = JSON.parse(context.user);
      expect(context.user).not.toContain('UNRELATED_OLD_CHECKPOINT_INTERPRETATION');
      expect(data.issueSources[0].checkpointQuotedBasis.quote).toBe('信件尚未打开');
      expect(data.hostExplicitCurrentClockArithmeticPassed).toBe(true);
      return { upheldIssueIndexes: [] };
    } });
  expect(correction).toBeUndefined();
});

it('does not expose the unconsumed current source to a prefix summary reviewer', async () => {
  const f = fixture(); f.proposed = { kind: 'summary', summary: '信件未开。', stage: '调查中' };
  f.frame.sourceMessage = { ...f.frame.messages[0]!, id: 'future_source', sequence: 3, content: 'FUTURE_UNCONSUMED_CONTENT' };
  f.frame.topicState!.workingState!.state!.__topicNarrativeTime = { sourceMessageId: 'future_reply', sourceChecksum: 'a'.repeat(64),
    minutes: 600, quote: 'FUTURE_ATOMIC_NARRATIVE_TAIL', rangeDigest: 'b'.repeat(64) };
  await reviewTopicContinuity({ ...f, review: async context => {
    expect(context.user).not.toMatch(/FUTURE_UNCONSUMED_CONTENT|FUTURE_ATOMIC_NARRATIVE_TAIL/u); return { supported: true, issues: [] };
  } });
});

it('does not let a malformed or contradictory review authorize publication', async () => {
  const f = fixture();
  for (const raw of [{ supported: true }, { supported: false, issues: [] }, { supported: true, issues: [{ claim: 'a', basis: 'b', correction: 'c' }] }]) {
    await expect(reviewTopicContinuity({ ...f, review: async () => raw })).rejects.toThrow('未发布');
  }
});

it.each(['direct', 'adjudicated'] as const)('approves exact clockless prose for publication after %s review without inventing a clock anchor', async mode => {
  const f = fixture(), onApproved = vi.fn(), onPublicationApproved = vi.fn();
  const text = '门锁检查完毕，屋门重新关上。';
  f.proposed = { kind: 'reply', text };
  expect(await reviewTopicContinuity({ ...f, onApproved, onPublicationApproved,
    review: async () => mode === 'direct' ? { supported: true, issues: [] } : { supported: false, issues: [{
      claim: '新动作', claimQuote: '门锁检查完毕', basis: '原有场景', basisQuote: '信件尚未打开', correction: '无依据的创作限制' }] },
    adjudicate: async () => ({ upheldIssueIndexes: [] }) })).toBeUndefined();
  expect(onApproved).not.toHaveBeenCalled();
  expect(onPublicationApproved).toHaveBeenCalledOnce();
  expect(onPublicationApproved).toHaveBeenCalledWith({ contentChecksum: createHash('sha256').update(text).digest('hex'),
    userCanon: { version: 1, throughSequence: 1, entries: [] } });
});

it('never approves clockless prose when a sourced contradiction is upheld', async () => {
  const f = fixture(), onPublicationApproved = vi.fn();
  f.proposed = { kind: 'reply', text: '信件已经打开。' };
  expect(await reviewTopicContinuity({ ...f, onPublicationApproved,
    review: async () => ({ supported: false, issues: [{ claim: '信已打开', claimQuote: '信件已经打开',
      basis: '检查点', basisQuote: '信件尚未打开', correction: '保留未开状态' }] }),
    adjudicate: async () => ({ upheldIssueIndexes: [0] }) })).toContain('未发布草稿');
  expect(onPublicationApproved).not.toHaveBeenCalled();
});

it('reviews the exact latest publication independently of frozen dialogue and message creation order', async () => {
  const f = fixture(), late = { ...f.frame.messages[0]!, id: 'earlier_created_formal', authorId: 'alice', sequence: 1,
    content: '屋门已重新关上，阿澄走进走廊。' };
  f.frame.messages = [{ ...late, id: 'later_created_formal', sequence: 8, content: '阿澄还在门内。' }];
  f.frame.topic!.formalPublicationRevision = 9;
  f.frame.topic!.lastPublicationAvailability = 'available';
  f.frame.topic!.lastPublicationRef = { messageId: late.id, authorId: late.authorId, contentChecksum: createHash('sha256').update(late.content).digest('hex') };
  f.frame.topicPublicationReference = { formalPublicationRevision: 9, contentChecksum: createHash('sha256').update(late.content).digest('hex'), message: late };
  expect(await reviewTopicContinuity({ ...f, review: async context => {
    const data = JSON.parse(context.user);
    expect(data.latestFormalContinuation).toMatchObject({ id: late.id, sequence: 1, content: late.content });
    expect(data.messages.find((message: { id: string }) => message.id === late.id)?.content).toBe(late.content);
    return { supported: true, issues: [] };
  } })).toBeUndefined();
  expect(f.frame.messages.map(message => message.id)).toEqual(['later_created_formal']);
});

it('repairs only malformed critic structure or quotations on the unchanged candidate and sources', async () => {
  const f = fixture(), adjudicate = vi.fn(), onApproved = vi.fn();
  const seen: Array<{ proposed: unknown; messages: unknown; userCanon: unknown }> = [];
  const review = vi.fn(async context => {
    const data = JSON.parse(context.user);
    if (seen.length) expect(data.criticFormatCorrection).toContain('仅重新核验以上同一拟稿');
    seen.push({ proposed: data.proposed, messages: data.messages, userCanon: data.userCanon });
    if (seen.length === 1) return { supported: true, issues: [{ claim: '错误', claimQuote: '继续当前场景。', basis: '来源', basisQuote: '信件尚未打开', correction: '修复' }] };
    if (seen.length === 2) return { supported: false, issues: [{ claim: '错误', claimQuote: '继续……场景', basis: '来源', basisQuote: '信件尚未打开', correction: '修复' }] };
    return { supported: true, issues: [] };
  });
  expect(await reviewTopicContinuity({ ...f, review, adjudicate, onApproved })).toBeUndefined();
  expect(review).toHaveBeenCalledTimes(3); expect(seen[1]).toEqual(seen[0]); expect(seen[2]).toEqual(seen[0]);
  expect(adjudicate).not.toHaveBeenCalled(); expect(onApproved).not.toHaveBeenCalled();
});

it('repairs incomplete clock classification but never asks the critic to overrule host arithmetic', async () => {
  const f = fixture(); f.proposed = { kind: 'reply', text: '09:31，她看表。' };
  const canon: TopicUserCanon = { version: 1, throughSequence: 1, entries: [{ id: 'rule', sourceMessageId: 'legal', sourceChecksum: 'a'.repeat(64),
    quote: '09:00至09:30', rule: '时间窗', timeRange: { start: 540, end: 570, includeStart: true, includeEnd: true } }] };
  const review = vi.fn().mockResolvedValueOnce({ supported: true, issues: [], clockClaims: [] })
    .mockResolvedValueOnce({ supported: true, issues: [], clockClaims: [{ index: 0, usage: 'narration_now', reason: '实际当前时刻' }] });
  const adjudicate = vi.fn(), onApproved = vi.fn();
  expect(await reviewTopicContinuity({ ...f, canon, review, adjudicate, onApproved })).toContain('当前叙事时刻超出');
  expect(review).toHaveBeenCalledTimes(2); expect(adjudicate).not.toHaveBeenCalled(); expect(onApproved).not.toHaveBeenCalled();
});

it('rejects fabricated proposed or source quotations before they can become correction authority', async () => {
  const f = fixture(), adjudicate = vi.fn();
  const issue = { claim: '错误', claimQuote: '继续当前场景。', basis: 'checkpoint', basisQuote: '信件尚未打开', correction: '修正错误' };
  for (const altered of [{ ...issue, claimQuote: '不存在于当前拟稿' }, { ...issue, basisQuote: '不存在于合法依据' }]) {
    await expect(reviewTopicContinuity({ ...f, adjudicate, review: async () => ({ supported: false, issues: [altered] }) })).rejects.toThrow('引文不在');
  }
  expect(adjudicate).not.toHaveBeenCalled();
});

it('does not accept an adjudication index outside its actual original issue list', async () => {
  const f = fixture();
  await expect(reviewTopicContinuity({ ...f, adjudicate: async () => ({ upheldIssueIndexes: [1] }),
    review: async () => ({ supported: false, issues: [{ claim: '错误', claimQuote: '继续当前场景。', basis: 'checkpoint', basisQuote: '信件尚未打开', correction: '修正错误' }] }) }))
    .rejects.toThrow('异议复核');
});

it('skips daily ports and refuses to send a foreign owner checkpoint to the reviewer', async () => {
  const f = fixture(), review = vi.fn();
  f.frame.topicState!.readerId = 'bob'; await reviewTopicContinuity({ ...f, review });
  f.frame.topic = undefined; await reviewTopicContinuity({ ...f, review });
  expect(review).not.toHaveBeenCalled();
});

it('approves a typed tail only after all checks and rejects a later paragraph before the source-backed published tail', async () => {
  const f = fixture(), onApproved = vi.fn();
  const canon: TopicUserCanon = { version: 1, throughSequence: 1, entries: [{ id: 'user_rule', sourceMessageId: 'legal',
    sourceChecksum: createHash('sha256').update(f.frame.messages[0]!.content).digest('hex'), quote: '09:00至09:30', rule: '有效时间窗',
    timeRange: { start: 540, end: 570, includeStart: true, includeEnd: true } }] };
  f.proposed = { kind: 'reply', text: '09:25，她看表。' };
  const review = async () => ({ supported: true, issues: [], clockClaims: [{ index: 0, usage: 'narration_now', reason: '当前场景' }] });
  expect(await reviewTopicContinuity({ ...f, canon, onApproved, review })).toBeUndefined();
  expect(onApproved).toHaveBeenCalledWith({ minutes: 565, quote: '09:25', contentChecksum: createHash('sha256').update(f.proposed.text).digest('hex'), rangeDigest: topicCanonRangeDigest(canon), userCanon: canon });
  f.frame.topicState!.workingState!.state!.__topicNarrativeTime = { sourceMessageId: 'published', sourceChecksum: 'a'.repeat(64),
    minutes: 565, quote: '09:25', rangeDigest: topicCanonRangeDigest(canon) };
  f.proposed = { kind: 'reply', text: '09:20，她继续往前走。' }; onApproved.mockClear();
  expect(await reviewTopicContinuity({ ...f, canon, onApproved, review })).toContain('上一份正式正文');
  expect(onApproved).not.toHaveBeenCalled();
});

it('requires complete source-reference checks and compares only verified same-entity literal pronouns', async () => {
  const f = fixture(), content = '许岚没有上前。他把灯举高。';
  const formal = { ...f.frame.messages[0]!, id: 'formal', authorId: 'alice', sequence: 2, content };
  f.frame.messages = [...f.frame.messages, formal];
  const narrativeReferences = { status: 'reviewed' as const, scope: 'recent_authorized_formal_story_text_not_a_permanent_identity_ledger' as const,
    selectedSources: [{ id: formal.id, checksum: createHash('sha256').update(content).digest('hex'), sequence: 2 }], conflicts: [], references: [{
      subjectName: '许岚', sourceMessageId: formal.id, sourceChecksum: createHash('sha256').update(content).digest('hex'), sourceSequence: 2,
      quote: content, quoteStart: 0, quoteEnd: content.length, nameStart: 0, nameEnd: 2, referenceStart: content.indexOf('他'), referenceEnd: content.indexOf('他') + 1,
      sourcePronoun: '他' as const, bindingMethod: 'extraction_and_independent_source_only_semantic_review' as const }] };
  f.proposed = { kind: 'reply', text: '许岚走向台阶，他没有回头。' };
  const incomplete = vi.fn(async () => ({ supported: true, issues: [] }));
  await expect(reviewTopicContinuity({ ...f, narrativeReferences, review: incomplete })).rejects.toThrow('完整逐项'); expect(incomplete).toHaveBeenCalledTimes(3);
  for (const pronoun of ['他', '她'] as const) {
    f.proposed = { kind: 'reply', text: `许岚走向台阶，${pronoun}没有回头。` };
    const feedback = await reviewTopicContinuity({ ...f, narrativeReferences, review: async () => ({ supported: true, issues: [],
      narrativeReferenceChecks: [{ sourceAnchorIndex: 0, status: 'same_entity', reason: '同名主语与动作延续', targetMentionIndex: 0 }] }) });
    if (pronoun === '他') expect(feedback).toBeUndefined(); else expect(feedback).toContain('"originalPronoun":"他","proposedPronoun":"她"');
  }
  for (const status of ['other', 'ambiguous'] as const) {
    f.proposed = { kind: 'reply', text: '沈舟走向台阶，她没有回头。' };
    expect(await reviewTopicContinuity({ ...f, narrativeReferences, review: async () => ({ supported: true, issues: [],
      narrativeReferenceChecks: [{ sourceAnchorIndex: null, status, reason: '不同角色或不确定所指，不得强绑旧人物。', targetMentionIndex: 0 }] }) })).toBeUndefined();
  }
  await expect(reviewTopicContinuity({ ...f, narrativeReferences, review: async () => ({ supported: true, issues: [],
    narrativeReferenceChecks: [{ sourceAnchorIndex: 0, status: 'same_entity', reason: '故意返回不存在的拟稿位置', targetMentionIndex: 99 }] }) })).rejects.toThrow('非引语代词位置');
  for (const quoted of ['许岚说：“她今晚不会来。”', '许岚说：「她今晚不会来。」', '许岚说："她今晚不会来。"']) {
    f.proposed = { kind: 'reply', text: quoted };
    expect(await reviewTopicContinuity({ ...f, narrativeReferences, review: async context => {
      expect(JSON.parse(context.user).proposedNarrativeMentions).toEqual([]);
      return { supported: true, issues: [], narrativeReferenceChecks: [] };
    } })).toBeUndefined();
  }
  f.proposed = { kind: 'reply', text: '“他今晚会来。”许岚说。她把灯举高。' };
  expect(await reviewTopicContinuity({ ...f, narrativeReferences, review: async context => {
    const mentions = JSON.parse(context.user).proposedNarrativeMentions; expect(mentions.map((item: { targetMentionIndex: number }) => item.targetMentionIndex)).toEqual([1]);
    return { supported: true, issues: [], narrativeReferenceChecks: [{ sourceAnchorIndex: 0, status: 'same_entity', reason: '引号外叙述回指许岚', targetMentionIndex: 1 }] };
  } })).toContain('"originalPronoun":"他","proposedPronoun":"她"');
  f.proposed = { kind: 'reply', text: '许岚向前走，他没有停。许岚又举灯，她抬头看门。' };
  expect(await reviewTopicContinuity({ ...f, narrativeReferences, review: async () => ({ supported: true, issues: [],
    narrativeReferenceChecks: [0, 1].map(targetMentionIndex => ({ sourceAnchorIndex: 0, status: 'same_entity', reason: '同一具名主语', targetMentionIndex })) }) })).toContain('"originalPronoun":"他","proposedPronoun":"她"');
  f.frame.sourceMessage = { ...f.frame.messages[0]!, content: '编辑修订：许岚今后代词改用她。' };
  f.frame.messages = [f.frame.sourceMessage, ...f.frame.messages.slice(1)];
  f.proposed = { kind: 'reply', text: '许岚走向台阶，她没有回头。' };
  expect(await reviewTopicContinuity({ ...f, narrativeReferences, review: async () => ({ supported: true, issues: [],
    narrativeReferenceChecks: [{ sourceAnchorIndex: 0, status: 'explicit_user_revision', reason: '当前user明确修订同一人物的代词', targetMentionIndex: 0,
      revisionSourceMessageId: f.frame.sourceMessage!.id, revisionQuote: f.frame.sourceMessage!.content }] }) })).toBeUndefined();
  await expect(reviewTopicContinuity({ ...f, narrativeReferences, review: async () => ({ supported: true, issues: [],
    narrativeReferenceChecks: [{ sourceAnchorIndex: 0, status: 'explicit_user_revision', reason: '伪造修订不能绕过', targetMentionIndex: 0,
      revisionSourceMessageId: formal.id, revisionQuote: content }] }) })).rejects.toThrow('当前真实user逐字来源');
});
