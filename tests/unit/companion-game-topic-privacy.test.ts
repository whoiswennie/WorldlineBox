import { expect, it, vi } from 'vitest';
import { reviewCompanionGameSharedUpdate, reviewCompanionGamePublicReply, type CompanionGameTopicUpdate } from '../../src/main/companions/game-topic-privacy';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionTopicCapabilities } from '../../src/main/companions/topic-capabilities';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import { reviewCompanionTopicModeratorTransfer } from '../../src/main/companions/topic-moderator-transfer';
import { reviewCompanionProposalQuantities } from '../../src/main/companions/proposal-quantity-review';
vi.mock('../../src/main/companions/proposal-quantity-review', () => ({ reviewCompanionProposalQuantities: vi.fn(async () => ({ allowed: true })) }));

const config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fake', baseUrl: 'https://fixture.invalid' };
const command: CompanionGameTopicUpdate = { type: 'topic.update', conversationId: 'actual_group', topicId: 'actual_game', readerId: 'host',
  expectedRevision: 7, operationId: 'brain_fixed', patch: { shared: { summary: '实际公开规则和阶段', sourceMessageIds: [] } } };
const current = (kind: 'game' | 'discussion' = 'game'): CompanionStorageResponse => ({ ok: true,
  topic: { id: 'actual_game', conversationId: 'actual_group', title: '实际本局', kind, status: 'active', participantIds: ['host', 'a', 'b'],
    invitedIds: ['host', 'a', 'b'], moderatorId: 'host', tags: [], revision: 7, createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' },
  topicState: { topicId: 'actual_game', readerId: 'host', trust: 'topic_state_not_real_world_facts', workingState: {
    summary: '主持本人秘密状态', state: { opaqueRecord: { x: 'a属于夜间秘密阵营', y: 'b属于另一秘密阵营' } }, sourceMessageIds: [],
    sourceEventId: 'actual_private_event', updatedAt: '2026-10-23T00:00:00Z', revision: 1, authorId: 'host' } } });
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
const publicFrame = (): Parameters<typeof reviewCompanionGamePublicReply>[0]['frame'] => ({
  companion: { id: 'host', name: '主持', description: '', persona: '', model: '', avatar: 'sister', active: true, proactive: false, builtin: false, createdAt: '2026-10-23T00:00:00Z' },
  conversation: { id: 'actual_group', kind: 'group', title: '本局', memberIds: ['host', 'a', 'b'], pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: '2026-10-23T00:00:00Z' },
  messages: [], topic: current().topic, topicState: current().topicState });
it.each([true, false])('reviews target consent from exact public sources without reading any private working state accepted=%s', async accepted => {
  const transfer = { type: 'topic.transfer_moderator' as const, conversationId: 'actual_group', topicId: 'actual_game', readerId: 'host',
    expectedRevision: 7, targetCompanionId: 'a', sourceMessageIds: ['actual_target_statement'] };
  const source = { id: 'actual_target_statement', conversationId: 'actual_group', topicId: 'actual_game', authorId: 'a',
    content: accepted ? '我愿意接任本话题主持。' : '我愿意参与讨论，但不接受主持。', sequence: 1,
    kind: 'text' as const, status: 'sent' as const, attachments: [], createdAt: '2026-10-23T00:00:00Z' };
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async input => input.type === 'topic.read' ? current()
    : input.type === 'topic.sources.valid' ? { ok: true, topicSourcesValid: true } : { ok: true, memorySources: [source] });
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data).toMatchObject({ purpose: 'topic_moderator_transfer_consent', publicSources: [expect.objectContaining({ id: source.id, content: source.content })] });
    expect(JSON.stringify(data)).not.toContain('opaqueRecord'); expect(data).not.toHaveProperty('currentOwnState');
    return response({ accepted, confidence: .99, consentMessageId: accepted ? source.id : null, reason: accepted ? '目标本人明确接受主持。' : '只有参与意愿，没有主持意愿。' });
  });
  const result = reviewCompanionTopicModeratorTransfer({ command: transfer, request }, config, undefined, { fetchFn });
  if (accepted) expect(await result).toMatchObject({ previousModeratorId: 'host', targetCompanionId: 'a', consentMessageId: source.id,
    sourceRefs: [{ id: source.id, checksum: expect.stringMatching(/^[a-f0-9]{64}$/u) }] });
  else await expect(result).rejects.toThrow('没有主持意愿');
  expect(fetchFn).toHaveBeenCalledOnce(); expect(request.mock.calls.some(([input]) => input.type === 'topic.transfer_moderator')).toBe(false);
});
it.each([
  { text: '狼人照常出刀：a请私信告诉我刀谁。', allowed: false },
  { text: '我不透牌，我私报狼刀目标是b。', allowed: false },
  { text: '我是预言家，白天我怀疑a，这票投a。', allowed: true },
  { text: '夜间有行动的各位请实际单独联系主持，群里不报目标。', allowed: true },
  { text: '大家已公开投票，a投b，b投a，按已确认规则平票。', allowed: true },
])('reviews public speech by the actual audience with exact semantics: $text', async ({ text, allowed }) => {
  const frame = publicFrame(), fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content);
    expect(data.actualAudience.memberIds).toEqual(['host', 'a', 'b']); expect(data.exactProposedText).toBe(text);
    expect(data.currentOwnState.readerId).toBe('host'); expect(data.currentOwnState.workingState).toEqual(frame.topicState!.workingState);
    expect(wire.messages[0].content).toContain('指定人与秘密角色绑定');
    expect(wire.messages[0].content).toContain('白天跳身份、诈身份、猜测、独立投票');
    return response({ allowed, confidence: .99, reason: allowed ? '公开讨论与必要通用提示可以发表。' : '公开指定人与秘密动作，须修订为实际私下通信。' });
  });
  expect((await reviewCompanionGamePublicReply({ frame, text }, config, undefined, { fetchFn })).allowed).toBe(allowed);
  expect(fetchFn).toHaveBeenCalledOnce();
});
it('permits an actual private port without pretending a public body labelled private changes its audience', async () => {
  const frame = publicFrame(), fetchFn = vi.fn<typeof fetch>();
  frame.conversation = { ...frame.conversation, id: 'actual_pair', kind: 'private', memberIds: ['host', 'a'] };
  expect(await reviewCompanionGamePublicReply({ frame, text: '仅你可见的本局私态。' }, config, undefined, { fetchFn })).toEqual({ allowed: true });
  expect(fetchFn).not.toHaveBeenCalled();
  const foreign = publicFrame(); foreign.topicState = { ...foreign.topicState!, readerId: 'a' };
  expect(await reviewCompanionGamePublicReply({ frame: foreign, text: '试图使用别人的私态。' }, config, undefined, { fetchFn })).toMatchObject({ allowed: false });
  expect(fetchFn).not.toHaveBeenCalled();
});
it('treats two companions plus an implicit human player as a public group while exempting a verified peer-only pair', async () => {
  const frame = publicFrame(); frame.conversation = { ...frame.conversation, memberIds: ['host', 'a'], peerOnly: false };
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.actualAudience).toMatchObject({ memberIds: ['host', 'a'], includesPlayer: true, publicDelivery: true });
    return response({ allowed: false, confidence: .99, reason: '玩家也在真实公开群，不能把单个peer当作唯一收件人。' });
  });
  expect(await reviewCompanionGamePublicReply({ frame, text: '只给a看的私密角色。' }, config, undefined, { fetchFn })).toMatchObject({ allowed: false });
  frame.conversation = { ...frame.conversation, peerOnly: true };
  expect(await reviewCompanionGamePublicReply({ frame, text: '实际仅a可见的秘密。' }, config, undefined, { fetchFn })).toEqual({ allowed: true });
  expect(fetchFn).toHaveBeenCalledOnce();
});
it('supports a legitimate already-closed game reveal with actual public settlement evidence', async () => {
  const frame = publicFrame(); frame.topic = { ...frame.topic!, status: 'closed' };
  frame.messages = [{ id: 'actual_settlement', conversationId: 'actual_group', authorId: 'host', content: '本局按已确认规则结算，胜负成立并允许终局翻牌。',
    sequence: 20, kind: 'text', status: 'sent', attachments: [], createdAt: '2026-10-23T00:00:00Z' }];
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.currentTopic.status).toBe('closed'); expect(data.observedMessages[0].id).toBe('actual_settlement');
    return response({ allowed: true, confidence: .99, reason: '已有真实终局结算和关闭凭证，规则允许揭示。' });
  });
  expect(await reviewCompanionGamePublicReply({ frame: frame as CompanionReplyInput, text: '本局现在按规则揭示身份。' }, config, undefined, { fetchFn })).toEqual({ allowed: true });
});
it.each(['summary', 'state', 'title', 'tags', 'shared_and_private'] as const)('reviews the exact full %s public payload against the real audience and rejects before any write', async location => {
  const proposed = structuredClone(command), secret = '不可提前公开的真实秘密';
  if (location === 'summary') proposed.patch.shared!.summary = secret;
  if (location === 'state') proposed.patch.shared!.state = { innocuous: { nested: [secret] } };
  if (location === 'title') proposed.patch = { title: secret };
  if (location === 'tags') proposed.patch = { tags: [secret] };
  if (location === 'shared_and_private') proposed.patch.workingState = { summary: secret, sourceMessageIds: [] };
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async () => current());
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(data.actualAudience).toMatchObject({ conversationId: 'actual_group', topicId: 'actual_game', participantIds: ['host', 'a', 'b'] });
    expect(data.currentOwnState.readerId).toBe('host'); expect(data.exactProposedPatch).toEqual(proposed.patch);
    return response({ allowed: false, confidence: .99, reason: '公开字段包含未到合法揭示时机的秘密，改写公开内容，秘密保留私态。' });
  });
  expect(await reviewCompanionGameSharedUpdate({ command: proposed, request }, config, undefined, { fetchFn })).toMatchObject({ allowed: false });
  expect(fetchFn).toHaveBeenCalledOnce(); expect(request.mock.calls.map(([input]) => input.type)).toEqual(['topic.read']);
  expect(command.patch.shared!.summary).toBe('实际公开规则和阶段');
});
it('leaves ordinary non-game public and private updates under their existing ACL without extra inference', async () => {
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async () => current('discussion')), fetchFn = vi.fn<typeof fetch>();
  expect(await reviewCompanionGameSharedUpdate({ command: { ...command, patch: { workingState: { summary: '自己的秘密', sourceMessageIds: [] } } }, request }, config, undefined, { fetchFn })).toEqual({ allowed: true });
  expect(request).toHaveBeenCalledOnce();
  expect(await reviewCompanionGameSharedUpdate({ command, request }, config, undefined, { fetchFn })).toEqual({ allowed: true });
  expect(request).toHaveBeenCalledTimes(2); expect(fetchFn).not.toHaveBeenCalled();
});
it('repairs reviewer format in the same read-only slot without changing the original patch or audience', async () => {
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async () => current()), payloads: unknown[] = [];
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content); payloads.push(data);
    if (payloads.length === 1) return response({ allowed: 'yes', confidence: .99, reason: '格式错误' });
    expect(data.reviewCorrection.error).toContain('allowed');
    return response({ allowed: true, confidence: .99, reason: '只有公开规则，没有秘密。' });
  });
  expect(await reviewCompanionGameSharedUpdate({ command, request }, config, undefined, { fetchFn })).toEqual({ allowed: true });
  const [first, second] = payloads as Array<Record<string, unknown>>;
  expect(second!.actualAudience).toEqual(first!.actualAudience); expect(second!.exactProposedPatch).toEqual(first!.exactProposedPatch);
  expect(request).toHaveBeenCalledOnce();
});
it('lets the native author correct a rejected patch under the same real reader without issuing its SQLite write', async () => {
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async () => ({ ok: true }));
  const reviewUpdate = vi.fn(async () => ({ allowed: false, reason: '共享summary包含其他成员秘密。' }));
  const capability = companionTopicCapabilities(request, { companionId: 'host', conversationId: 'actual_group' }, undefined, { reviewUpdate });
  const result = await capability.execute({ name: 'world', id: 'fixed', arguments: JSON.stringify({ action: 'topic', parameters: {
    action: 'update', topicId: 'actual_game', expectedRevision: 7, patch: command.patch } }) });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('共享summary') }); expect(request).not.toHaveBeenCalled();
  expect(reviewUpdate).toHaveBeenCalledWith(expect.objectContaining({ readerId: 'host', conversationId: 'actual_group', patch: command.patch }), undefined);
});

it('checks adopted public quantities in speech and in a stage-only checkpoint update without exposing private state', async () => {
  const frame = publicFrame();
  frame.topicState!.shared = { summary: '五份材料完整一对一分给四位接收者，全部分完。',
    state: { recipients: ['a', 'b', 'c', 'd'], total: 5 }, sourceMessageIds: [],
    sourceEventId: 'public_source', updatedAt: '2026-10-25T00:00:00Z', authorId: 'host', revision: 7 };
  const quantities = vi.mocked(reviewCompanionProposalQuantities); quantities.mockClear();
  quantities.mockResolvedValueOnce({ allowed: false, reason: '5 与 4' }).mockResolvedValueOnce({ allowed: false, reason: '5 与 4' })
    .mockResolvedValueOnce({ allowed: false, reason: '5 与 4' });
  const fetchFn = vi.fn<typeof fetch>(async () => response({ allowed: true, confidence: .99, reason: '公开内容无秘密。' }));
  expect(await reviewCompanionGamePublicReply({ frame, text: '现在按这份安排完整分配。' }, config, undefined, { fetchFn }))
    .toMatchObject({ allowed: false, reason: expect.stringContaining('5 与 4') });
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async () => ({ ...current(), topicState: frame.topicState }));
  expect(await reviewCompanionGameSharedUpdate({ command: { ...command, patch: { shared: { stage: '准备分配', sourceMessageIds: [] } } },
    request }, config, undefined, { fetchFn })).toMatchObject({ allowed: false, reason: expect.stringContaining('5 与 4') });
  expect(await reviewCompanionGameSharedUpdate({ command: { ...command, patch: { workingState: {
    summary: '现在按此前公共安排完整分配。', sourceMessageIds: [] } } }, request }, config, undefined, { fetchFn }))
    .toMatchObject({ allowed: false, reason: expect.stringContaining('5 与 4') });
  expect(quantities).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(quantities.mock.calls)).not.toContain('opaqueRecord');
  expect(quantities.mock.calls[0]![0]).toMatchObject({ proposal: '现在按这份安排完整分配。', adoptedPlan: { state: frame.topicState!.shared!.state } });
  expect(quantities.mock.calls[1]![0].proposal).toMatchObject({ shared: {
    stage: '准备分配', summary: frame.topicState!.shared!.summary, state: frame.topicState!.shared!.state } });
  expect(quantities.mock.calls[2]![0]).toMatchObject({ proposal: { privateUpdate: { summary: '现在按此前公共安排完整分配。' } },
    adoptedPlan: { state: frame.topicState!.shared!.state } });
  expect(fetchFn).toHaveBeenCalledTimes(2); // Private state never goes through the public-privacy reviewer.
  expect(request.mock.calls.map(([value]) => value.type)).toEqual(['topic.read', 'topic.read']);
});
