import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import type { Companion, CompanionConversation, CompanionMessage } from '../../src/shared/companions';
import { generateCompanionReply } from '../../src/main/companions/model';
import { companionTaskInvocation } from '../../src/main/companions/structured-agent';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';

async function cleanRoleFixture(root: string): Promise<void> {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('worldlinebox-agent-role-content-')) throw new Error('Unsafe role QA cleanup.');
  await rm(root, { recursive: true, force: true });
}

/** Real model content checks; no production conversation/store is modified. */
it.skipIf(process.env.WORLDLINEBOX_AGENT_CONTENT_ACCEPTANCE !== '1')('keeps the human, sisters, different groups and independent self tasks distinct in actual model replies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-agent-role-content-'));
  const config = await realGlobalChatConfig(root), time = new Date().toISOString();
  const roles: Companion[] = [
    { id: 'lin', name: '林澄', description: '妹妹', persona: '你是林澄，是周岚(zhou)的妹妹，平静、有一点俏皮，表达简短具体。真人用户是天幻岚(user)，不是你的姐姐。你只能扮演自己，不替别人回答。' },
    { id: 'zhou', name: '周岚', description: '姐姐', persona: '你是周岚，是林澄(lin)的姐姐，沉稳直接，习惯先核对事实。真人用户是天幻岚(user)，不是你的妹妹或姐姐。你只能扮演自己，不替别人回答。' },
    { id: 'song', name: '宋檀', description: '独立朋友', persona: '你是宋檀，是两姐妹的朋友，理性温和，没有姐妹关系。真人用户是天幻岚(user)，你不会把自己或真人认作林澄或周岚。只扮演自己。' },
  ].map(role => ({ ...role, model: '', avatar: 'sister' as const, builtin: false, proactive: false, active: true, createdAt: time }));
  let seq = 0;
  const room = (id: string, members: string[]): CompanionConversation => ({ id, kind: 'group', title: id, memberIds: members,
    pinned: false, muted: false, unread: 0, updatedAt: time, lastMessage: '' });
  const message = (conversationId: string, authorId: string, content: string): CompanionMessage => ({ id: 'qa_' + (++seq),
    sequence: seq, conversationId, authorId, content, kind: 'text', status: 'sent', attachments: [], createdAt: time });
  const group = room('group_sisters', ['lin', 'zhou', 'song']), otherGroup = room('other_group', ['lin', 'song']);
  const privatePeer = room('lin_song_only', ['lin', 'song']);
  const contexts: unknown[] = [], outputs: Array<{ role: string; phase: string; text: string }> = [];
  const fetchFn: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    const context = JSON.parse(body.messages[1].content);
    contexts.push(context);
    // Assert the actual wire input as well as the final reply. No keys/raw headers are retained.
    expect(JSON.stringify(context)).not.toContain('FOREIGN_GROUP_PRIVATE_6b51');
    expect(JSON.stringify(context)).not.toContain('FOREIGN_PEER_PRIVATE_c75a');
    return fetch(url, init);
  };
  const infer = async (role: Companion, conversation: CompanionConversation, messages: CompanionMessage[], source: CompanionMessage, phase: string) => {
    const result = await generateCompanionReply({ companion: role, conversation, messages, sourceMessage: source, memories: [],
      members: roles, identityDirectory: [...roles, { id: 'user', name: '天幻岚' }],
      contextThroughSequence: Math.max(...messages.filter(row => row.conversationId === conversation.id).map(row => row.sequence)),
      audience: 'player' }, config, undefined, { fetchFn, timeoutMs: 120000, loop: true, tools: [] });
    expect(result.turn?.calls).toEqual([]);
    outputs.push({ role: role.id, phase, text: result.text });
    return result.text;
  };
  let status = 'running';
  try {
    const prompt = message(group.id, 'user', '我是天幻岚，是独立真人用户。林澄是周岚的妹妹，宋檀是朋友。你分别叫什么、正在回答谁、你的姐妹是谁？只说你自己，不替其他成员写话。');
    const foreign = message(otherGroup.id, 'song', 'FOREIGN_GROUP_PRIVATE_6b51');
    const foreignPeer = message(privatePeer.id, 'song', 'FOREIGN_PEER_PRIVATE_c75a');
    const history: CompanionMessage[] = [prompt];
    for (const role of roles) {
      const text = await infer(role, group, [...history, foreign, foreignPeer], prompt, 'group_identity');
      expect(text).toContain(role.name); expect(text).toMatch(/天幻岚|真人|用户|玩家/);
      if (role.id === 'lin') { expect(text).toContain('周岚'); expect(text).not.toMatch(/(?:天幻岚|用户|玩家)(?:是|就是|，你是)我(?:的)?姐姐/u); }
      if (role.id === 'zhou') expect(text).toContain('林澄');
      if (role.id === 'song') expect(text).toMatch(/没有|不是|并非|无/u);
      history.push({ ...message(group.id, role.id, text), replyToId: prompt.id });
    }
    const peerQuestion = message(group.id, 'zhou', '林澄，我是周岚。请告诉我刚才那位真人用户叫什么，以及你现在正在回答谁。');
    history.push(peerQuestion);
    const peerAnswer = await infer(roles[0]!, group, [...history, foreignPeer], peerQuestion, 'peer_in_shared_group');
    expect(peerAnswer).toContain('天幻岚'); expect(peerAnswer).toContain('周岚');
    const selfRoom = room('independent_self_task', ['lin']);
    const selfTask = companionTaskInvocation({ companion: roles[0]!, conversationId: selfRoom.id, id: 'self_task_1', kind: 'activity',
      goal: '独立整理今天自己的待办，当前没有聊天来信。', createdAt: time });
    const self = await generateCompanionReply({ companion: roles[0]!, conversation: selfRoom, messages: history, memories: [],
      proactive: true, audience: 'peers', invocation: selfTask }, config, undefined, { loop: true, tools: [], timeoutMs: 120000,
      fetchFn: async (url, init) => { const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content); contexts.push(data);
        expect(data.messages).toEqual([]); expect(JSON.stringify(data)).not.toContain('天幻岚'); return fetch(url, init); } });
    outputs.push({ role: 'lin', phase: 'independent_task', text: self.text });
    expect(self.text).not.toContain('FOREIGN_');
    status = 'passed';
  } finally {
    const output = path.resolve('artifacts/companion-agent-acceptance/role-content.json'); await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ status, model: config.model, apiFormat: config.apiFormat, startedAt: time,
      finishedAt: new Date().toISOString(), outputs, contexts }, null, 2));
    await cleanRoleFixture(root);
  }
}, 900000);
