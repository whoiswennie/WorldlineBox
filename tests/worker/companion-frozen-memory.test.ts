import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionMemory } from '../../src/shared/companions';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

let root: string, store: CompanionsStore;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'companion-frozen-memory-'));
  store = new CompanionsStore(path.join(root, 'messages.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, persona: '真实资料', description: '', model: '', avatar: 'sister' as const, active: true, proactive: false })));
});
afterEach(() => { store.close(); removeOwnedDirectorySync(root); });
function setup() {
  const room = store.openPrivate('alice'), source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '旧快照依据：原始资料只有这一条。', replyDirective: 'none' });
  const scope = { companionId: 'alice', conversationId: room.id };
  const note = store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory' as const, content: '旧任务应该保留这条当时读到的资料。', tags: ['快照'],
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const question = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '请按现在的回忆继续本任务。', replyDirective: 'none' });
  const memory = { id: note.id, sources: note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) };
  const valid = () => store.request({ type: 'memory.frozen.valid', ...scope, beforeSequence: question.sequence, memories: [memory] }).memoryFrozenValid;
  return { room, source, scope, note, question, memory, valid };
}
function revise(f: ReturnType<typeof setup>, source = f.source): CompanionMemory {
  return store.request({ type: 'memory.revise', ...f.scope, id: f.note.id, expectedVersion: f.note.version,
    candidate: { artifactKind: 'episode_memory' as const, content: '当前记忆已被普通编辑为新内容。', tags: ['新标签'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
}

it('keeps passive snapshot facts after an ordinary note revision while active versioned reads remain exact', () => {
  const f = setup(); expect(f.valid()).toBe(true); const updated = revise(f); expect(updated.version).toBeGreaterThan(f.note.version);
  expect(f.valid()).toBe(true);
  expect(store.request({ type: 'memory.records.filter', ...f.scope, ids: [f.note.id] }).memories?.some(note => note.version === f.note.version)).toBe(false);
});

it('withdraws the frozen receipt after explicit note forgetting', () => {
  const f = setup(); revise(f);
  store.request({ type: 'memory.forget', ...f.scope, id: f.note.id });
  expect(f.valid()).toBe(false);
});

it('checks the original source after a revised note switches to a different valid source', () => {
  const f = setup(), replacement = store.appendMessage({ conversationId: f.room.id, authorId: 'user', content: '新版资料从这里开始，旧来源稍后撤回。', replyDirective: 'none' });
  revise(f, replacement); expect(f.valid()).toBe(true);
  store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  expect(store.request({ type: 'memory.records.filter', ...f.scope, ids: [f.note.id] }).memories?.length).toBe(1);
  expect(f.valid()).toBe(false);
});

it('rejects another owner or a fabricated source outside the note witness history', () => {
  const f = setup(), other = store.openPrivate('bob');
  expect(store.request({ type: 'memory.frozen.valid', companionId: 'bob', conversationId: other.id, memories: [f.memory] }).memoryFrozenValid).toBe(false);
  const unrelated = store.appendMessage({ conversationId: f.room.id, authorId: 'user', content: '本人可见但不属于该记忆的原始依据。', replyDirective: 'none' });
  const source = store.request({ type: 'memory.sources.filter', ...f.scope, ids: [unrelated.id] }).memorySources![0]!;
  // Reuse a real checksum from a genuine source-backed note to avoid testing
  // only malformed bytes; a source must actually belong to this note history.
  const second = store.request({ type: 'memory.record', ...f.scope, candidate: { artifactKind: 'episode_memory' as const, content: '另一份独立资料。', tags: [], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  expect(store.request({ type: 'memory.frozen.valid', ...f.scope, memories: [{ id: f.note.id, sources: second.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) }] }).memoryFrozenValid).toBe(false);
});

it('attests persisted frozen reply dependencies after editing and refuses them once their original evidence is withdrawn', () => {
  const f = setup(), bubble = store.appendMessage({ conversationId: f.room.id, authorId: 'alice', content: '', loopStep: 0 });
  const proof: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', ...f.scope, beforeSequence: f.question.sequence,
    complete: true, memories: [], frozenMemories: [f.memory], sources: f.memory.sources, contexts: [], knowledgeReads: [], topics: [] };
  store.request({ type: 'loop.save', checkpoint: { ...f.scope, sourceMessageId: f.question.id, messageId: bubble.id, status: 'done', turns: [{ text: '当时读到的旧信息。', rawText: '当时读到的旧信息。', calls: [] }], supplements: [] }, executionReadset: proof });
  revise(f);
  expect(store.request({ type: 'execution.sources', sourceMessageIds: [bubble.id] }).executionSources?.find(item => item.id === bubble.id)?.storageValidatedReadsetDigest).toBeTruthy();
  store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  expect(store.request({ type: 'execution.sources', sourceMessageIds: [bubble.id] }).executionSources?.find(item => item.id === bubble.id)?.storageValidatedReadsetDigest).toBeUndefined();
});

it('restores a durable agent journal with the same frozen input after ordinary edits and rejects dropping or withdrawing its witnesses', () => {
  const f = setup(), run = { id: 'frozen_journal', ...f.scope, invocationId: 'same_task', requestDigest: 'a'.repeat(64), revision: 1,
    status: 'running' as const, turns: [], sources: f.memory.sources, memories: [], frozenMemories: [f.memory], effects: [] };
  store.request({ type: 'agent.run.save', run, expectedRevision: 0 });
  revise(f);
  expect(store.request({ type: 'agent.run.get', companionId: 'alice', id: run.id }).agentRun?.frozenMemories).toEqual([f.memory]);
  expect(() => store.request({ type: 'agent.run.save', run: { ...run, revision: 2, frozenMemories: [] }, expectedRevision: 1 })).toThrow('任务记忆快照来源');
  store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  expect(() => store.request({ type: 'agent.run.get', companionId: 'alice', id: run.id })).toThrow('来源');
});

it('keeps feedback input cold during ordinary checkpoint reads and restores its immutable receipt after reopening SQLite', () => {
  const f = setup(), action = store.createAction({ ...f.scope, sourceMessageId: f.question.id, title: '已有任务的回报', status: 'queued' });
  const checkpoint = { prompt: '已有执行目标', executionReadset: { schema: 'worldlinebox.companion-execution-readset-v1' as const, ...f.scope,
    complete: true, memories: [], frozenMemories: [f.memory], sources: f.memory.sources, contexts: [], knowledgeReads: [], topics: [] }, waitForActionIds: [], supplements: [] };
  const feedbackRecall = { prepared: true as const, memories: [f.note], sources: [f.source] };
  store.request({ type: 'checkpoint.save', id: action.id, checkpoint: { ...checkpoint, feedbackRecall } });
  expect(store.request({ type: 'checkpoint.get', id: action.id }).checkpoint?.feedbackRecall).toBeUndefined();
  store.close(); store = new CompanionsStore(path.join(root, 'messages.sqlite'), []);
  expect(store.request({ type: 'checkpoint.get', id: action.id, includeFeedbackRecall: true }).checkpoint?.feedbackRecall).toEqual(feedbackRecall);
  store.request({ type: 'checkpoint.save', id: action.id, checkpoint });
  expect(() => store.request({ type: 'checkpoint.save', id: action.id, checkpoint: { ...checkpoint, feedbackRecall: { ...feedbackRecall, memories: [] } } })).toThrow('初次回忆快照');
});
