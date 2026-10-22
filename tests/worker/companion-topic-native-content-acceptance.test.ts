import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionConversation, CompanionMessage } from '../../src/shared/companions';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import { runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';
import { companionTopicCapabilities } from '../../src/main/companions/topic-capabilities';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';

it.skipIf(process.env.WORLDLINEBOX_TOPIC_NATIVE_ACCEPTANCE !== '1')('uses actual native topic tools for private and peer-group creation, voluntary join, search and independent pointers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-topic-native-'));
  const owned: { store?: CompanionsStore } = {};
  onTestFinished(async () => { owned.store?.close(); await rm(root, { recursive: true, force: true, maxRetries: 10 }); });
  const config = await realGlobalChatConfig(root), stamp = new Date().toISOString();
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), ['alice', 'bob'].map((id, index) => ({ id,
    name: index ? '周岚' : '林澄', description: '独立伙伴', persona: `你是${index ? '周岚' : '林澄'}，稳定ID=${id}。只控制自己，真人user和其他伙伴身份独立，话题不是新的人格。`, model: '', avatar: 'sister' as const, active: true, proactive: false })));
  owned.store = store;
  const calls: unknown[] = [], replies: unknown[] = [];
  const request = async (command: Parameters<CompanionsStore['request']>[0]) => store!.request(command);
  const run = async (owner: string, room: CompanionConversation, source: CompanionMessage, instruction: string) => {
    const companion = store!.state().companions.find(role => role.id === owner)!;
    const refresh = async (): Promise<CompanionReplyInput> => {
      const view = source.topicId ? store!.request({ type: 'topic.read', readerId: owner, conversationId: room.id, topicId: source.topicId }) : undefined;
      const joined = !source.topicId || view?.topic?.participantIds.includes(owner);
      return { companion, conversation: room, sourceMessage: source,
        messages: joined ? store!.messages({ conversationId: room.id, topicId: source.topicId ?? null, before: source.sequence + 1, limit: 100 }).messages : [source],
        memories: [], topic: view?.topic, topicState: joined ? view?.topicState : undefined,
        audience: source.authorId === 'user' ? 'player' : 'peers', invocation: { id: 'native_' + source.id, kind: source.authorId === 'user' ? 'player' : 'peer',
          companionId: owner, conversationId: room.id, topicId: source.topicId, sourceMessageId: source.id, goal: instruction,
          status: 'running', createdAt: stamp, messagePort: { kind: 'conversation' },
          authorization: { kind: source.authorId === 'user' ? 'player' : 'peer', sourceMessageIds: [source.id], externalActions: false } } };
    };
    const tools = companionTopicCapabilities(request, { companionId: owner, conversationId: room.id });
    const result = await runCompanionStructuredAgent({ frame: await refresh(), refresh,
      context: { system: '使用本轮实际world.topic原生工具完成请求。自己决定与自己操作，不替另一成员加入或切换。不能只在文字里声称完成。最终只输出JSON {"text":"简短结果"}。',
        user: JSON.stringify({ purpose: 'topic_native_management_acceptance', instruction }) }, capabilities: { ...tools, execute: async (call, signal) => {
        const result = await tools.execute(call, signal); calls.push({ owner, room: room.id, sourceTopicId: source.topicId,
          parameters: JSON.parse(call.arguments), result }); return result;
      } } }, config, undefined, { timeoutMs: 120000, fetchFn: async (url, init) => {
        const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
        expect(payload.identity.self.id).toBe(owner); expect(payload.invocation.topicId).toBe(source.topicId);
        if (owner === 'bob') expect(JSON.stringify(payload)).not.toContain('ALICE_PRIVATE_SECRET_01');
        if (source.topicId) expect(payload.messages.every((message: { topicId?: string }) => message.topicId === source.topicId)).toBe(true);
        return fetch(url, init);
      } });
    replies.push({ owner, sourceId: source.id, result }); return result;
  };
  let status = 'failed';
  try {
    const privateRoom = store.openPrivate('alice');
    const createPrivate = store.appendMessage({ conversationId: privateRoom.id, authorId: 'user', topicId: null,
      content: '请用原生话题能力新建“海边长篇小说”，类型story，标签“创作”“长篇”，只邀请我user。', replyDirective: 'none' });
    await run('alice', privateRoom, createPrivate, createPrivate.content);
    const novel = store.request({ type: 'topic.list', conversationId: privateRoom.id, readerId: 'alice', query: '海边' }).topics!.find(topic => topic.title === '海边长篇小说')!;
    expect(novel).toMatchObject({ kind: 'story', participantIds: ['alice'], invitedIds: ['user'] }); expect(novel.tags).toEqual(expect.arrayContaining(['创作', '长篇']));
    store.request({ type: 'topic.join', conversationId: privateRoom.id, readerId: 'user', topicId: novel.id });
    const continueNovel = store.appendMessage({ conversationId: privateRoom.id, authorId: 'user', topicId: novel.id,
      content: '继续这篇海边小说：设定主角叫小禾。请用world.topic.update把“主角小禾”存到你本人的workingState.summary，sourceMessageIds引用我本条消息；不要写成现实记忆。', replyDirective: 'none' });
    await run('alice', privateRoom, continueNovel, continueNovel.content);
    expect(store.request({ type: 'topic.read', conversationId: privateRoom.id, readerId: 'alice', topicId: novel.id }).topicState?.workingState?.summary).toContain('小禾');
    const group = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
    const groupRoom = store.request({ type: 'state', includeHidden: true, conversationId: group.id }).state!.conversations.find(room => room.id === group.id)!;
    const bSource = store.appendMessage({ conversationId: group.id, authorId: 'alice', topicId: null, content: '周岚，请你为自己建一个“独立预算B”讨论话题，标签“预算”，参与者只填bob。其他人此时不参加。', replyDirective: 'none' });
    await run('bob', groupRoom, bSource, bSource.content);
    const budget = store.request({ type: 'topic.list', conversationId: group.id, readerId: 'bob', query: '预算B' }).topics![0]!;
    const aSource = store.appendMessage({ conversationId: group.id, authorId: 'bob', topicId: null, content: '林澄，请你新建“旅行计划A”讨论话题，标签“旅行”，邀请我bob；你自己先参加，我之后自行决定。', replyDirective: 'none' });
    await run('alice', groupRoom, aSource, aSource.content);
    const travel = store.request({ type: 'topic.list', conversationId: group.id, readerId: 'alice', query: '旅行计划A' }).topics![0]!;
    expect(travel.participantIds).toEqual(['alice']); expect(travel.invitedIds).toContain('bob');
    store.appendMessage({ conversationId: group.id, authorId: 'bob', content: '原B还继续，不能被另一个成员的选择强制切换。', topicId: budget.id, replyDirective: 'none' });
    const aliceView = store.request({ type: 'topic.read', conversationId: group.id, readerId: 'alice', topicId: travel.id });
    store.request({ type: 'topic.update', conversationId: group.id, readerId: 'alice', topicId: travel.id, expectedRevision: aliceView.topic!.revision,
      patch: { workingState: { summary: 'ALICE_PRIVATE_SECRET_01', sourceMessageIds: [] } } });
    const invitation = store.appendMessage({ conversationId: group.id, authorId: 'alice', topicId: travel.id,
      content: '周岚，我已经建好旅行计划A。若愿意，请先自己调用join加入，再list搜索“旅行”确认可继续的话题；不要创建重复话题。', replyDirective: 'none' });
    await run('bob', groupRoom, invitation, invitation.content);
    expect(store.request({ type: 'topic.read', conversationId: group.id, readerId: 'bob', topicId: travel.id }).topic!.participantIds).toContain('bob');
    expect(calls.some(call => JSON.stringify(call).includes('"action":"join"'))).toBe(true);
    expect(calls.some(call => JSON.stringify(call).includes('"action":"list"'))).toBe(true);
    expect(store.request({ type: 'topic.list', conversationId: group.id, readerId: 'bob', query: '旅行计划A' }).topics).toHaveLength(1);
    status = 'passed';
  } finally {
    const file = path.resolve('artifacts/companion-agent-acceptance/topic-native-content.json'); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ status, startedAt: stamp, finishedAt: new Date().toISOString(), model: config.model,
      setup: 'actual model native topic choices; host creates fixture sources and seeds Alice private sentinel', calls, replies }, null, 2));
  }
}, 900000);
