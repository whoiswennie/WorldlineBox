import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { captureCompanionExecutionReadset, verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';

let store: CompanionsStore, root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-player-social-room-'));
  store = new CompanionsStore(path.join(root, 'messages.sqlite'), ['alice', 'bob', 'carol'].map(id => ({ id, name: id, description: '',
    persona: '合成独立伙伴', avatar: 'sister', model: '', active: true, proactive: false })));
});
afterEach(() => {
  store.close();
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-player-social-room-')) throw new Error('Unexpected fixture cleanup path.');
  rmSync(root, { recursive: true, force: true });
});

it('keeps a normal user group editable after a formal introduction without granting a new member prior messages or acquaintance', () => {
  const group = store.createConversation('用户主持的正常群', ['alice', 'bob']);
  const original = store.appendMessage({ conversationId: group.id, authorId: 'alice', content: 'bob你好，先认识一下。' });
  store.updateConversation(group.id, { title: '用户重新命名', memberIds: ['alice', 'carol'] });
  expect(store.request({ type: 'messages', conversationId: group.id }).messages?.map(message => message.id)).toEqual([original.id]);
  expect(() => store.request({ type: 'memory.sources.filter', companionId: 'bob', conversationId: group.id, ids: [original.id] })).toThrow('不是聊天成员');
  expect(store.request({ type: 'memory.sources.filter', companionId: 'carol', conversationId: group.id, ids: [original.id] }).memorySources).toEqual([]);
  expect(() => store.request({ type: 'social.contact.check', companionId: 'alice', recipientIds: ['carol'] })).toThrow('还不是你认识');
  const fresh = store.appendMessage({ conversationId: group.id, authorId: 'alice', content: 'carol你好，这次是对你正式说的介绍。' });
  expect(store.request({ type: 'memory.sources.filter', companionId: 'carol', conversationId: group.id, ids: [fresh.id] }).memorySources?.map(message => message.id)).toEqual([fresh.id]);
  expect(store.request({ type: 'social.contact.check', companionId: 'alice', recipientIds: ['carol'] }).ok).toBe(true);
  expect(store.request({ type: 'social.conversations', companionId: 'alice', query: '重新命名' }).socialConversationPage?.items.map(room => room.id)).toContain(group.id);
});

it('keeps same-member groups and their primary topics independent while retaining actual historical recipients', () => {
  const canonical = store.createConversation('原群', ['alice', 'bob']), other = store.createConversation('待合并群', ['bob', 'carol']);
  const first = store.appendMessage({ conversationId: canonical.id, authorId: 'alice', content: '原群的真实介绍。' });
  const second = store.appendMessage({ conversationId: other.id, authorId: 'carol', content: '旧群只有bob实际听到。' });
  const merged = store.updateConversation(other.id, { memberIds: ['bob', 'alice'] });
  expect(merged.id).toBe(other.id);
  expect(store.request({ type: 'messages', conversationId: canonical.id }).messages?.map(message => message.id)).toEqual([first.id]);
  const social = store.request({ type: 'social.messages', conversationId: other.id }).socialMessagePage!;
  expect(social.total).toBe(1); expect(social.items.find(item => item.message.id === second.id)?.recipientIds).toEqual(['bob']);
  expect(store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: other.id, ids: [second.id] }).memorySources).toEqual([]);
  expect(store.request({ type: 'memory.sources.filter', companionId: 'bob', conversationId: other.id, ids: [second.id] }).memorySources?.map(message => message.id)).toEqual([second.id]);
});

it.each(['source', 'target'] as const)('keeps both user room identities when the %s room has a durable topic checkpoint', side => {
  const canonical = store.createConversation('独立原群', ['alice', 'bob']), other = store.createConversation('独立故事群', ['alice', 'carol']);
  const scoped = side === 'source' ? other : canonical;
  const topic = store.request({ type: 'topic.create', conversationId: scoped.id, readerId: 'alice', title: '不能改写的小说', kind: 'story' }).topic!;
  store.request({ type: 'topic.join', conversationId: scoped.id, topicId: topic.id, readerId: 'user' });
  const source = store.appendMessage({ conversationId: scoped.id, topicId: topic.id, authorId: 'user', content: '钥匙编号A17，门尚未打开。', replyDirective: 'none' });
  store.request({ type: 'topic.update', conversationId: scoped.id, topicId: topic.id, readerId: 'alice', expectedRevision: topic.revision + 1,
    patch: { workingState: { summary: source.content, sourceMessageIds: [source.id] } } });
  const read = () => store.request({ type: 'topic.read', conversationId: scoped.id, topicId: topic.id, readerId: 'alice' });
  const before = read();
  expect(store.updateConversation(other.id, { memberIds: ['alice', 'bob'] }).id).toBe(other.id);
  expect(store.state().conversations.map(room => room.id)).toEqual(expect.arrayContaining([canonical.id, other.id]));
  expect(read()).toEqual(before);
  expect(store.getMessage(source.id).conversationId).toBe(scoped.id);
  expect(store.state().conversations.find(room => room.id === scoped.id)?.activeTopicId).toBe(topic.id);
});

it('preserves a real collaboration grant, original human source, action and immutable execution proof when user rooms acquire the same members', async () => {
  const canonical = store.createConversation('已有独立群', ['alice', 'bob']), other = store.createConversation('独立授权群', ['alice', 'carol']);
  const source = store.appendMessage({ conversationId: other.id, authorId: 'user', content: '请alice整理数据，并请bob独立核验，只操作本次目录。', replyDirective: 'none' });
  const scope = { companionId: 'alice', conversationId: other.id };
  const grant = store.request({ type: 'collaboration.create', ...scope, sourceMessageId: source.id, title: '保留原始授权', goal: source.content,
    parentInvocationId: 'separate_room_goal', evidence: ['请bob独立核验'], participants: [{ companionId: 'bob', goal: '独立核验本次数据。' }], clientId: 'separate_room_grant' }).collaboration!;
  const executionReadset = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ conversation: { id: other.id }, messages: [source] }) } });
  const action = store.request({ type: 'action.create', action: { ...scope, sourceMessageId: source.id, title: '真实授权的待执行任务', status: 'queued' },
    checkpoint: { prompt: source.content, executionReadset, supplements: [], waitForActionIds: [] } }).action!;
  const beforeCheckpoint = store.checkpoint(action.id), beforeAction = store.getAction(action.id);
  const request = async (command: Parameters<CompanionsStore['request']>[0]) => store.request(command);
  expect(await verifyCompanionExecutionReadset(executionReadset, scope, { request })).toBe(true);
  expect(store.updateConversation(other.id, { memberIds: ['alice', 'bob'] }).id).toBe(other.id);
  expect(store.state().conversations.map(room => room.id)).toEqual(expect.arrayContaining([canonical.id, other.id]));
  expect(store.request({ type: 'collaboration.read', id: grant.id, companionId: 'alice' }).collaboration).toEqual(grant);
  expect(store.checkpoint(action.id)).toEqual(beforeCheckpoint); expect(store.getAction(action.id)).toEqual(beforeAction);
  expect(store.getMessage(source.id).conversationId).toBe(other.id);
  expect(await verifyCompanionExecutionReadset(executionReadset, scope, { request })).toBe(true);
});

it('keeps a room with only a persisted agent checkpoint independent even before any action or topic exists', () => {
  const canonical = store.createConversation('普通原群', ['alice', 'bob']), other = store.createConversation('已有推理群', ['alice', 'carol']);
  const run = store.request({ type: 'agent.run.save', expectedRevision: 0, run: { id: 'independent_reasoning', companionId: 'alice', conversationId: other.id,
    invocationId: 'separate_goal', requestDigest: 'a'.repeat(64), revision: 1, status: 'running', turns: [], sources: [], memories: [], effects: [] } }).agentRun!;
  expect(store.updateConversation(other.id, { memberIds: ['alice', 'bob'] }).id).toBe(other.id);
  expect(store.state().conversations.map(room => room.id)).toEqual(expect.arrayContaining([canonical.id, other.id]));
  expect(store.request({ type: 'agent.run.get', companionId: 'alice', id: run.id }).agentRun).toEqual(run);
});

it('preserves a real delegated participant port even when its grant belongs to a different conversation', () => {
  const canonical = store.createConversation('普通原群', ['alice', 'bob']), child = store.createConversation('bob原独立入口', ['bob', 'carol']);
  const origin = store.openPrivate('alice'), source = store.appendMessage({ conversationId: origin.id, authorId: 'user', content: '请bob独立核对这次结果。', replyDirective: 'none' });
  const grant = store.request({ type: 'collaboration.create', companionId: 'alice', conversationId: origin.id, sourceMessageId: source.id,
    title: '独立核对', goal: source.content, parentInvocationId: 'parent_port', evidence: ['请bob独立核对'],
    participants: [{ companionId: 'bob', goal: '独立核对这次结果。' }], clientId: 'participant_port_grant' }).collaboration!;
  store.request({ type: 'collaboration.respond', id: grant.id, companionId: 'bob', decision: 'accept', reason: '我接受这次核对。' });
  const running = store.request({ type: 'collaboration.start', id: grant.id, companionId: 'bob', invocationId: 'child_port_goal', conversationId: child.id }).collaboration!;
  expect(store.updateConversation(child.id, { memberIds: ['alice', 'bob'] }).id).toBe(child.id);
  expect(store.state().conversations.map(room => room.id)).toEqual(expect.arrayContaining([canonical.id, child.id]));
  expect(store.request({ type: 'collaboration.read', id: grant.id, companionId: 'bob' }).collaboration).toEqual(running);
  expect(running.participants[0]?.conversationId).toBe(child.id);
});

it('keeps an otherwise plain room independent when another room has captured its original source in an execution proof', async () => {
  const canonical = store.createConversation('普通原群', ['alice', 'bob']), evidenceRoom = store.createConversation('真实资料群', ['alice', 'carol']);
  const source = store.appendMessage({ conversationId: evidenceRoom.id, authorId: 'carol', content: '本次资料校验值是17。' });
  const privateRoom = store.openPrivate('alice'), authority = store.appendMessage({ conversationId: privateRoom.id, authorId: 'user', content: '请核对刚才资料群的真实校验值。', replyDirective: 'none' });
  const scope = { companionId: 'alice', conversationId: privateRoom.id };
  const executionReadset = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ conversation: privateRoom, messages: [authority], memorySources: [source] }) } });
  const action = store.request({ type: 'action.create', action: { ...scope, sourceMessageId: authority.id, title: '使用真实资料的任务', status: 'queued' },
    checkpoint: { prompt: authority.content, executionReadset, supplements: [], waitForActionIds: [] } }).action!;
  const before = store.checkpoint(action.id), request = async (command: Parameters<CompanionsStore['request']>[0]) => store.request(command);
  expect(await verifyCompanionExecutionReadset(executionReadset, scope, { request })).toBe(true);
  expect(store.updateConversation(evidenceRoom.id, { memberIds: ['alice', 'bob'] }).id).toBe(evidenceRoom.id);
  expect(store.state().conversations.map(room => room.id)).toEqual(expect.arrayContaining([canonical.id, evidenceRoom.id]));
  expect(store.getMessage(source.id).conversationId).toBe(evidenceRoom.id); expect(store.checkpoint(action.id)).toEqual(before);
  expect(await verifyCompanionExecutionReadset(executionReadset, scope, { request })).toBe(true);
});

it('continues to reject user edits of a real peer-only room with a canonical actual audience', () => {
  const peer = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
  expect(() => store.updateConversation(peer.id, { memberIds: ['alice', 'carol'] })).toThrow('实际通信');
  expect(() => store.updateConversation(peer.id, { title: '不能伪造入口' })).toThrow('实际通信');
  expect(store.request({ type: 'social.messages', conversationId: peer.id }).socialMessagePage?.total).toBe(0);
});
