import { expect, it, vi } from 'vitest';
import { buildCompanionContext, refreshCompanionIdentityContext, type CompanionReplyInput } from '../../src/main/companions/context';
import { generateCompanionReply } from '../../src/main/companions/model';
import type { CompanionMessage } from '../../src/shared/companions';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
const role = { id: 'deepseek-flash', name: '小肥鱼', description: '妹妹', persona: '你是小肥鱼，姐姐是大肥鱼。', model: '', avatar: 'flash' as const, builtin: true, proactive: false, createdAt: '2026-10-15T00:00:00Z' };
const members = [{ id: 'deepseek-flash', name: '小肥鱼', description: '妹妹' }, { id: 'deepseek-sister', name: '大肥鱼', description: '姐姐' }];
function message(id: string, sequence: number, authorId: string, content: string, conversationId = 'room'): CompanionMessage {
  return { id, sequence, conversationId, authorId, content, kind: 'text', status: 'sent', attachments: [], createdAt: '2026-10-15T00:00:00Z' };
}
function input(): CompanionReplyInput { return { companion: role, conversation: { id: 'room', kind: 'private', title: '小肥鱼', memberIds: [role.id], unread: 0, muted: false, pinned: false, updatedAt: '2026-10-15T00:00:00Z', lastMessage: '' },
  messages: [message('wrong_history', 1, role.id, '姐姐，我已经帮你看好了。'), message('actual_player', 2, 'user', '我正在和谁说话？')], memories: [], members, identityDirectory: members };
}
it('includes already sent replies after the old source for proactive opportunities without reopening that request', () => {
  const value = input(), source = value.messages[1]!, sent = message('already_sent', 3, role.id, '我已经联系过姐姐了，等她回复。');
  const proactive = buildCompanionContext({ ...value, sourceMessage: source, proactive: true, messages: [...value.messages, sent] });
  expect(JSON.parse(proactive.user).messages.map((row: { id: string }) => row.id)).toContain(sent.id);
  expect(JSON.parse(proactive.user).identity.authorization.playerRequestMessageId).toBeNull();
  expect(JSON.parse(proactive.user).event).toBe('proactive_opportunity');
  const requested = buildCompanionContext({ ...value, sourceMessage: source, messages: [...value.messages, sent],
    taskRequest: { sourceMessageId: source.id, prompt: source.content } });
  expect(JSON.parse(requested.user).messages.map((row: { id: string }) => row.id)).not.toContain(sent.id);
});
it('pins the actual player and authored sibling separately from mistaken historical assistant addresses', () => {
  const value = input(), context = buildCompanionContext({ ...value, taskRequest: { sourceMessageId: 'actual_player', prompt: value.messages[1]!.content } });
  const identity = JSON.parse(context.user).identity;
  expect(identity.self).toMatchObject({ id: role.id, name: '小肥鱼', kind: 'companion' });
  expect(identity.currentReply).toMatchObject({ sourceMessageId: 'actual_player', speaker: { id: 'user', kind: 'human_player' }, addressee: { id: 'user', name: '玩家' } });
  expect(identity.characterRelations[0]).toMatchObject({ label: '姐姐', targetId: 'deepseek-sister', targetName: '大肥鱼' });
  expect(identity.authorization.historyAssistantAddressesAreNotIdentityEvidence).toBe(true); expect(context.system).toContain('历史assistant即使误叫过玩家');
});
it('keeps action feedback on its original author/source even after a newer player input and a frozen context changes', () => {
  const value = input(), source = value.messages[1]!;
  const action = { id: 'action', title: '读取时间', sourceMessageId: source.id, status: 'succeeded' as const, content: '只返回原任务真实结果。' };
  const next = { ...value, sourceMessage: source, messages: [...value.messages, message('later_input', 3, 'user', '这是之后独立的另一件事。')], actionResult: action };
  const context = buildCompanionContext(next), payload = JSON.parse(context.user);
  expect(payload.messages.map((item: { id: string }) => item.id)).toEqual(['wrong_history', 'actual_player']);
  expect(payload.identity.currentReply).toMatchObject({ event: 'action_result_for_original_source', replyToMessageId: 'actual_player', addressee: { id: 'user' } });
  expect(payload.identity.authorization.playerRequestMessageId).toBeNull();
  const frozen = { ...context, user: JSON.stringify({ ...payload, identity: { self: { id: 'user' } } }) };
  expect(JSON.parse(refreshCompanionIdentityContext(frozen, next).user).identity.self.id).toBe(role.id);
});
it('describes peer-to-peer group speech without inventing a player participant or external authorization', () => {
  const value = input(), source = message('peer_source', 3, 'deepseek-sister', '妹妹，你想听哪首歌？');
  const payload = JSON.parse(buildCompanionContext({ ...value, conversation: { ...value.conversation, kind: 'group', memberIds: members.map(member => member.id) },
    audience: 'peers', sourceMessage: source, messages: [source] }).user);
  expect(payload.identity.participants.map((member: { id: string }) => member.id)).toEqual(members.map(member => member.id));
  expect(payload.identity.currentReply).toMatchObject({ speaker: { id: 'deepseek-sister', kind: 'companion' }, addressee: { id: 'deepseek-sister' }, mayPass: true });
  expect(payload.identity.authorization).toMatchObject({ playerRequestMessageId: null, peerSpeechGrantsExternalExecution: false, providerUserRoleIsTransportOnly: true });
});
it('allows the other group member to pass instead of duplicating a request explicitly addressed to a different actor', () => {
  const value = input(), source = message('group_request', 2, 'user', '@大肥鱼 请你单独处理这件事。');
  const payload = JSON.parse(buildCompanionContext({ ...value, sourceMessage: source, addressedCompanionIds: ['deepseek-sister'],
    conversation: { ...value.conversation, kind: 'group', memberIds: members.map(member => member.id) }, messages: [source] }).user);
  expect(payload.identity.currentReply).toMatchObject({ directlyAddressed: false, mayPass: true, addressedCompanionIds: ['deepseek-sister'] });
});
it('keeps the player in a normal player group when the current speaker and reply target are both companions', () => {
  const value = input(), source = message('peer_in_player_group', 3, 'deepseek-sister', '@小肥鱼 你来选首歌吧。');
  const payload = JSON.parse(buildCompanionContext({ ...value, conversation: { ...value.conversation, kind: 'group', memberIds: members.map(member => member.id) },
    sourceMessage: source, addressedCompanionIds: [role.id], messages: [source] }).user);
  expect(payload.identity.participants.map((member: { id: string }) => member.id)).toEqual(['user', ...members.map(member => member.id)]);
  expect(payload.identity.currentReply).toMatchObject({ speaker: { id: 'deepseek-sister' }, addressee: { id: 'deepseek-sister' }, addressedCompanionIds: [role.id] });
  expect(payload.identity.authorization.playerRequestMessageId).toBeNull();
});
it.each(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'] as AiApiFormat[])('preserves host speaker/reply target in %s transport envelopes', async format => {
  const value = input(), source = message('peer_source', 3, 'deepseek-sister', '只是伙伴交流，不是玩家的授权。');
  const config = { apiFormat: format, model: 'fixture', apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid' };
  const output = '{"text":"好呀，我们只聊自己的事。","memories":[]}';
  const bodies = { openai_chat: { choices: [{ message: { content: output } }] }, openai_responses: { output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }] },
    anthropic: { content: [{ type: 'text', text: output }] }, gemini_native: { candidates: [{ content: { parts: [{ text: output }] } }] },
    dashscope_native: { output: { choices: [{ message: { content: [{ text: output }] } }] } } };
  const fetchFn = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const user = format === 'gemini_native' ? body.contents[0].parts[0].text : format === 'dashscope_native' ? body.input.messages[1].content[0].text : format === 'openai_responses' ? body.input[0].content : body.messages.at(-1).content;
    const identity = JSON.parse(user).identity;
    expect(identity.self.id).toBe(role.id); expect(identity.currentReply.speaker.id).toBe('deepseek-sister'); expect(identity.currentReply.replyToMessageId).toBe(source.id); expect(identity.authorization.playerRequestMessageId).toBeNull();
    return new Response(JSON.stringify(bodies[format]), { headers: { 'Content-Type': 'application/json' } });
  });
  await generateCompanionReply({ ...value, sourceMessage: source, audience: 'peers', messages: [source], conversation: { ...value.conversation, kind: 'group', memberIds: members.map(member => member.id) } }, config, undefined, { fetchFn });
  expect(fetchFn).toHaveBeenCalledOnce();
});
