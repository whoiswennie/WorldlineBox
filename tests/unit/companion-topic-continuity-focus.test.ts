// This suite isolates the host contract; semantic source binding has its own
// mechanism and opt-in actual-model suites.
vi.mock('../../src/main/companions/topic-narrative-references', () => ({ prepareTopicNarrativeReferences: async () => ({
  status: 'abstained', scope: 'recent_authorized_formal_story_text_not_a_permanent_identity_ledger', selectedSources: [], references: [], conflicts: [],
}) }));
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { prepareTopicContinuityFocus, projectTopicContinuityFocus, type TopicContinuityFocusFrame } from '../../src/main/companions/topic-continuity-focus';
import { topicCanonRangeDigest, type TopicUserCanon } from '../../src/main/companions/topic-user-canon';
import { generateCompanionReply } from '../../src/main/companions/model';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fixture' };
function fixture() {
  const at = '2026-10-23T00:00:00Z';
  const source = { id: 'request', sequence: 3, conversationId: 'room', topicId: 'story', authorId: 'user', kind: 'text' as const,
    status: 'sent' as const, content: '只把门牌改为R-307，继续。SOURCE_TEXT_DOES_NOT_BECOME_SYSTEM', createdAt: at, attachments: [] };
  const published = { ...source, id: 'published', sequence: 2, authorId: 'writer', content: '09:30，他已经检查完封口，走出门外，与守门人分别。' };
  const canon: TopicUserCanon = { version: 1, throughSequence: 3, entries: [{ id: 'window', sourceMessageId: 'setup', sourceChecksum: 'a'.repeat(64),
    quote: '只写09:00至09:30，包含端点', rule: 'UNSOURCED_PARAPHRASE_FEMALE', timeRange: { start: 540, end: 570, includeStart: true, includeEnd: true } }] };
  const frame: TopicContinuityFocusFrame = { companion: { id: 'writer', name: '林澄', description: '', persona: '独立伙伴', model: '', avatar: 'sister', builtin: false, proactive: false, createdAt: at },
    conversation: { id: 'room', kind: 'private', title: '私聊', memberIds: ['writer'], pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: at },
    topic: { id: 'story', conversationId: 'room', kind: 'story', title: '故事', status: 'active', participantIds: ['writer', 'user'], invitedIds: [], moderatorId: 'user', tags: [], revision: 1, createdAt: at, updatedAt: at },
    topicState: { topicId: 'story', readerId: 'writer', trust: 'topic_state_not_real_world_facts', workingState: { sourceEventId: 'event', authorId: 'writer', revision: 1, updatedAt: at,
      sourceMessageIds: ['published'], summary: '旧摘要错误地写成她尚未检查封口。', stage: '等待旧段落指令', state: { __topicUserCanon: canon,
        __continuity: { topicId: 'story', companionId: 'writer', conversationId: 'room', throughSequence: 1, scannedThroughSequence: 3 },
        __topicNarrativeTime: { sourceMessageId: published.id, sourceChecksum: sha(published.content), minutes: 570, quote: '09:30', rangeDigest: topicCanonRangeDigest(canon) } } } },
    messages: [published, source], sourceMessage: source };
  return { frame, source, published, canon };
}

it('puts exact latest formal actions, pronouns and zero forward minutes next to the actual request as source data', async () => {
  const f = fixture(), focus = await prepareTopicContinuityFocus({ frame: f.frame, config });
  expect(focus!.latestPublishedText).toMatchObject({ id: f.published.id, content: f.published.content, sourceChecksum: sha(f.published.content) });
  expect(focus!.allowedTimeWindows[0]).toMatchObject({ remainingWholeMinutes: 0, sameMinuteContinuationAllowed: true, noLaterWholeMinuteAvailable: true });
  const projected = projectTopicContinuityFocus({ system: '系统身份', user: JSON.stringify({ old: 'context', topicState: f.frame.topicState,
    taskRequest: { sourceMessageId: f.source.id, prompt: f.source.content } }) }, focus);
  const data = JSON.parse(projected.user);
  expect(Object.keys(data).slice(-2)).toEqual(['topicContinuityFocus', 'taskRequest']);
  expect(data.topicContinuityFocus.latestPublishedText.content).toContain('他已经检查完');
  expect(projected.user).not.toContain('UNSOURCED_PARAPHRASE_FEMALE');
  expect(f.canon.entries[0]!.rule).toBe('UNSOURCED_PARAPHRASE_FEMALE');
  expect(data.topicState.workingState.summary).toBeUndefined(); expect(data.topicState.workingState.stage).toBeUndefined();
  expect(data.topicState.workingState.summaryOfCoveredPrefix).toContain('旧摘要错误地');
  expect(data.topicState.workingState.coverage).toMatchObject({ coveredThroughSequence: 1, latestPublishedSequence: 2, currentRequestSequence: 3 });
  expect(projected.system).not.toContain('SOURCE_TEXT_DOES_NOT_BECOME_SYSTEM');
  expect(data.topicContinuityFocus.currentRequest.content).toContain('SOURCE_TEXT_DOES_NOT_BECOME_SYSTEM');
});

it('keeps inclusive/exclusive and midnight remaining-minute arithmetic deterministic', async () => {
  const f = fixture(); f.canon.entries[0]!.timeRange = { start: 1410, end: 30, includeStart: true, includeEnd: false };
  f.frame.topicState!.workingState!.state!.__topicNarrativeTime = { sourceMessageId: f.published.id, sourceChecksum: sha(f.published.content),
    minutes: 570, quote: '09:30', rangeDigest: topicCanonRangeDigest(f.canon) };
  const outside = await prepareTopicContinuityFocus({ frame: f.frame, config });
  expect(outside!.allowedTimeWindows[0]).toMatchObject({ lastPublishedWithinWindow: false, remainingWholeMinutes: null });
  f.published.content = '00:29，他已经走出门外。';
  f.frame.topicState!.workingState!.state!.__topicNarrativeTime = { sourceMessageId: f.published.id, sourceChecksum: sha(f.published.content),
    minutes: 29, quote: '00:29', rangeDigest: topicCanonRangeDigest(f.canon) };
  const endpoint = await prepareTopicContinuityFocus({ frame: f.frame, config });
  expect(endpoint!.allowedTimeWindows[0]).toMatchObject({ start: '23:30', end: '00:30', includeEnd: false, remainingWholeMinutes: 0, sameMinuteContinuationAllowed: true });
});

it('uses actual publication order for an earlier-created bubble without changing the current request', async () => {
  const f = fixture(), late = { ...f.published, id: 'earlier_pending_late_publication', sequence: 1,
    content: '林澄已经离开屋门，正在走廊检查门牌。' };
  f.frame.topic!.formalPublicationRevision = 8;
  f.frame.topic!.lastPublicationAvailability = 'available';
  f.frame.topic!.lastPublicationRef = { messageId: late.id, authorId: late.authorId, contentChecksum: sha(late.content) };
  f.frame.topicPublicationReference = { formalPublicationRevision: 8, contentChecksum: sha(late.content), message: late };
  const focus = await prepareTopicContinuityFocus({ frame: f.frame, config });
  expect(focus!.latestPublishedText).toMatchObject({ id: late.id, sequence: 1, content: late.content });
  expect(focus!.currentRequest).toMatchObject({ id: f.source.id, content: f.source.content });
  expect(focus!.lastPublishedNarrativeTime).toMatchObject({ sourceMessageId: f.published.id, minutes: 570 });
  expect(f.frame.messages.map(message => message.id)).not.toContain(late.id);
});

it('keeps the exact narrative tail after a newer human input becomes the global publication', async () => {
  const f = fixture(), late = { ...f.published, id: 'late_body', sequence: 1, content: '他已走到走廊，门已经关好。' };
  f.frame.topic!.formalPublicationRevision = 9;
  f.frame.topic!.lastPublicationAvailability = 'available';
  f.frame.topic!.lastPublicationRef = { messageId: f.source.id, authorId: 'user', contentChecksum: sha(f.source.content) };
  f.frame.topic!.lastNarrativePublicationAvailability = 'available';
  f.frame.topic!.lastNarrativePublicationRef = { messageId: late.id, authorId: late.authorId, contentChecksum: sha(late.content), publicationRevision: 8 };
  f.frame.topicPublicationReference = { formalPublicationRevision: 9, contentChecksum: sha(late.content), message: late };
  const focus = await prepareTopicContinuityFocus({ frame: f.frame, config });
  expect(focus!.latestPublishedText).toMatchObject({ id: late.id, content: late.content });
  expect(focus!.currentRequest!.id).toBe(f.source.id);
});

it.each(['legacy_order_unknown', 'unavailable', 'none'] as const)('does not invent a creation-order tail when actual publication availability is %s', async availability => {
  const f = fixture(); f.frame.topic!.lastNarrativePublicationAvailability = availability;
  const focus = await prepareTopicContinuityFocus({ frame: f.frame, config });
  expect(focus!.latestPublishedText).toBeUndefined();
  expect(focus!.latestPublishedTextAvailability).toBe(availability);
  expect(focus!.lastPublishedNarrativeTime!.sourceMessageId).toBe(f.published.id);
});

it.each([0, 10, Number.NaN])('rejects a derived narrative revision outside the actual formal counter (%s)', async publicationRevision => {
  const f = fixture(); f.frame.topic!.formalPublicationRevision = 9;
  f.frame.topic!.lastNarrativePublicationAvailability = 'available';
  f.frame.topic!.lastNarrativePublicationRef = { messageId: f.published.id, authorId: f.published.authorId,
    contentChecksum: sha(f.published.content), publicationRevision };
  f.frame.topicPublicationReference = { formalPublicationRevision: 9, contentChecksum: sha(f.published.content), message: f.published };
  await expect(prepareTopicContinuityFocus({ frame: f.frame, config })).rejects.toThrow('最新正式话题资料');
});

it('uses exact host raw-source hashes for late publications rather than treating creation coverage as a full prefix', async () => {
  const f = fixture();
  f.frame.topicState!.workingState!.state!.__continuity = { topicId: 'story', companionId: 'writer', conversationId: 'room', throughSequence: 20,
    publicationCoverage: { version: 1, publicationRevision: 5, protectedSource: { messageId: f.source.id, sourceChecksum: sha(f.source.content), publicationRevision: 4 } } };
  f.frame.topicUncompactedSources = [{ messageId: f.published.id, sourceChecksum: sha(f.published.content) }];
  const focus = await prepareTopicContinuityFocus({ frame: f.frame, config });
  expect(focus!.workingCheckpointCoverage.uncompactedPublishedMessages).toEqual([{ id: f.published.id, sequence: 2, sourceChecksum: sha(f.published.content) }]);
  expect(focus!.workingCheckpointCoverage).toMatchObject({ rawCoverageKnown: true, creationSequenceIsNotCompletePrefixCoverage: true, publicationCoveredThroughRevision: 5 });
  f.frame.topicUncompactedSources = [{ messageId: f.published.id, sourceChecksum: sha('changed bytes') }];
  expect((await prepareTopicContinuityFocus({ frame: f.frame, config }))!.workingCheckpointCoverage.uncompactedPublishedMessages).toEqual([]);
  f.frame.topicUncompactedSources = undefined;
  const unknown = await prepareTopicContinuityFocus({ frame: f.frame, config });
  expect(unknown!.workingCheckpointCoverage).toMatchObject({ rawCoverageKnown: false, uncompactedPublishedMessages: [] });
});

it.each(['hash', 'counter', 'topic', 'room', 'draft', 'author', 'pointer', 'unavailable'] as const)('rejects an inconsistent latest publication reference (%s)', async failure => {
  const f = fixture(), late = { ...f.published, id: 'latest_formal' };
  f.frame.topic!.formalPublicationRevision = 8;
  f.frame.topic!.lastPublicationAvailability = 'available';
  f.frame.topic!.lastPublicationRef = { messageId: late.id, authorId: late.authorId, contentChecksum: sha(late.content) };
  f.frame.topicPublicationReference = { formalPublicationRevision: 8, contentChecksum: sha(late.content), message: late };
  if (failure === 'hash') f.frame.topicPublicationReference.contentChecksum = sha('other');
  if (failure === 'counter') f.frame.topicPublicationReference.formalPublicationRevision = 7;
  if (failure === 'topic') late.topicId = 'other_topic';
  if (failure === 'room') late.conversationId = 'other_room';
  if (failure === 'draft') Object.assign(late, { isReplyDraft: true });
  if (failure === 'author') late.authorId = 'user';
  if (failure === 'pointer') f.frame.topic!.lastPublicationRef.messageId = 'other_formal';
  if (failure === 'unavailable') f.frame.topic!.lastPublicationAvailability = 'unavailable';
  await expect(prepareTopicContinuityFocus({ frame: f.frame, config })).rejects.toThrow('最新正式话题资料');
});

it('does not turn a forged/draft/mismatched formal tail into a generation anchor', async () => {
  for (const alteration of ['bytes', 'draft'] as const) {
    const f = fixture();
    if (alteration === 'bytes') f.published.content += '篡改';
    if (alteration === 'draft') Object.assign(f.published, { isReplyDraft: true });
    await expect(prepareTopicContinuityFocus({ frame: f.frame, config })).rejects.toThrow('正式尾锚');
  }
  const f = fixture(); f.published.topicId = 'foreign';
  const missing = await prepareTopicContinuityFocus({ frame: f.frame, config });
  expect(missing!.missingFormalTailSource?.id).toBe(f.published.id);
  expect(missing!.latestPublishedText).toBeUndefined();
  expect(missing!.lastPublishedNarrativeTime!.provenance).toBe('host_validated_checkpoint_original_body_not_loaded');
});

it('uses the latest formal actions even when a later paragraph did not repeat the older clock marker', async () => {
  const f = fixture(); f.source.sequence = 4; f.canon.throughSequence = 4;
  const latest = { ...f.published, id: 'later_without_clock', sequence: 3, content: '他已经走下台阶，把门钥匙收好。' };
  f.frame.messages = [f.published, latest, f.source];
  const focus = await prepareTopicContinuityFocus({ frame: f.frame, config });
  expect(focus!.lastPublishedNarrativeTime!.sourceMessageId).toBe(f.published.id);
  expect(focus!.latestPublishedText!.id).toBe(latest.id);
  expect(focus!.workingCheckpointCoverage.latestPublishedSequence).toBe(3);
});

it('runs the focus through the real model serialization path and skips the game path', async () => {
  const f = fixture(), fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    const user = JSON.parse(body.messages.findLast((item: { role: string }) => item.role === 'user').content);
    expect(user.topicContinuityFocus.latestPublishedText.content).toBe(f.published.content);
    expect(user.topicContinuityFocus.allowedTimeWindows[0].remainingWholeMinutes).toBe(0);
    return new Response(JSON.stringify({ choices: [{ message: { content: '他在门外继续等候。' } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  await generateCompanionReply({ ...f.frame, memories: [] }, config, undefined, { topicReviewFrame: f.frame, fetchFn, loop: true });
  expect(fetchFn).toHaveBeenCalledOnce();
  f.frame.topic!.kind = 'game';
  const gameFetch = vi.fn<typeof fetch>(async (_url, init) => {
    expect(String(init!.body)).not.toContain('topicContinuityFocus');
    return new Response(JSON.stringify({ choices: [{ message: { content: '继续游戏。' } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  await generateCompanionReply({ ...f.frame, memories: [] }, config, undefined, { topicReviewFrame: f.frame, fetchFn: gameFetch, loop: true });
  expect(gameFetch).toHaveBeenCalledOnce();
});

it('rejects a foreign owner or changed actual source before contacting the author model', async () => {
  const f = fixture(), fetchFn = vi.fn();
  await expect(generateCompanionReply({ ...f.frame, memories: [], sourceMessage: { ...f.source, content: 'changed' } }, config, undefined,
    { topicReviewFrame: f.frame, fetchFn })).rejects.toThrow('实际来源不一致');
  await expect(generateCompanionReply({ ...f.frame, memories: [], companion: { ...f.frame.companion, id: 'other' } }, config, undefined,
    { topicReviewFrame: f.frame, fetchFn })).rejects.toThrow('实际来源不一致');
  expect(fetchFn).not.toHaveBeenCalled();
});
