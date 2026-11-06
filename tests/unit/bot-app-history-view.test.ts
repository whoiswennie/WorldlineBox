import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BotAppBrainStore } from '../../src/main/companion-bot/app-brain-store';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { projectAppHistoricalPrompt, staleTaskNoticeIds } from '../../src/main/companion-bot/app-brain-history-view';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(root).startsWith('bot-app-history-')) throw new Error('Unexpected test root');
  await rm(root, { recursive: true, force: true });
} });
const prompt = (eventId: string, memory = '被动记忆短卡', extra: Record<string, unknown> = {}) => JSON.stringify({
  envelope: { eventId, laneId: 'logical-lane', conversationId: 'room', companionId: 'alice', audienceScopeId: 'room', securityDomainId: 'room', aclRevision: 1 },
  trigger: { senderId: 'user', senderName: '主人', senderType: 'user', source: 'user', occurredAt: '2026-11-03T06:00:00Z',
    sourceMessageId: 'message-' + eventId, content: '这条原话要完整保留：今晚只做一个小角落。', contentIsPreview: false },
  history: [{ id: 'late-peer-' + eventId, senderId: 'bob', senderName: 'Bob', senderType: 'companion', content: '群里迟到的伙伴补充：只搬右侧的书。', createdAt: '2026-11-03T05:59:59Z' }],
  historyCoverage: { selected: 1, omitted: 0 }, room: { kind: 'group', title: '伙伴群', members: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }] },
  memoryEvidence: memory, memoryEvidenceOmitted: false, tasks: [{ id: 'old-task', status: 'running', summary: '旧任务动态快照' }], ...extra,
});

it('omits old closed-task callbacks from live model context while retaining explicit selected-task discussion and raw history', () => {
  const notice = JSON.parse(prompt('old-notice')); notice.trigger.source = 'task'; notice.trigger.task = { taskId: 'stopped' };
  const past = [{ turn: { eventId: 'old-notice', laneId: 'logical-lane', prompt: JSON.stringify(notice) } }];
  const current = { eventId: 'new-chat', laneId: 'logical-lane', prompt: prompt('new-chat', '旧记忆仍说任务在等待', {
    taskPolicy: { authority: 'current-host-state', endedTaskIds: ['stopped'], pausedTaskIds: [] } }) };
  expect([...staleTaskNoticeIds(current, past)]).toEqual(['old-notice']);
  expect(JSON.parse(past[0]!.turn.prompt).trigger.task.taskId).toBe('stopped');
  const selected = JSON.parse(current.prompt); selected.trigger.taskFollowup = { taskId: 'stopped' };
  expect(staleTaskNoticeIds({ ...current, prompt: JSON.stringify(selected) }, past).size).toBe(0);
  expect(staleTaskNoticeIds({ ...current, eventId: 'not-the-host-event' }, past).size).toBe(0);
});

it('projects trusted historical envelopes into source-attributed dialogue without repeating dynamic RAG or task cards', () => {
  const original = prompt('event-1'), projected = JSON.parse(projectAppHistoricalPrompt({ eventId: 'event-1', laneId: 'logical-lane', prompt: original }));
  expect(projected).toMatchObject({ kind: 'worldlinebox_historical_turn', authority: 'historical-data-only',
    trigger: JSON.parse(original).trigger, history: JSON.parse(original).history, room: JSON.parse(original).room,
    originalEnvelope: { callId: 'turn:event-1', jsonPath: '/prompt' } });
  expect(projected.memoryEvidence).toBeUndefined(); expect(projected.memoryEvidenceOmitted).toBeUndefined(); expect(projected.tasks).toBeUndefined();
  expect(JSON.stringify(projected)).not.toContain('被动记忆短卡'); expect(JSON.stringify(projected)).not.toContain('旧任务动态快照');
});

it('keeps only the first copy of a handoff while preserving newly observed group messages in every turn', () => {
  const seen = new Set<string>(), nativeHandoff = { compactionId: 'handoff-1', summaryText: '上代主脑交接摘要' };
  const first = JSON.parse(projectAppHistoricalPrompt({ eventId: 'first', laneId: 'logical-lane', prompt: prompt('first', '', { nativeHandoff }) }, seen));
  const second = JSON.parse(projectAppHistoricalPrompt({ eventId: 'second', laneId: 'logical-lane', prompt: prompt('second', '', { nativeHandoff }) }, seen));
  expect(first.nativeHandoff).toEqual(nativeHandoff); expect(second.nativeHandoff).toBeUndefined();
  expect(second.history[0]).toMatchObject({ id: 'late-peer-second', senderId: 'bob', content: '群里迟到的伙伴补充：只搬右侧的书。' });
});

it('recognizes the host logical lane within a native epoch, and leaves ordinary or mismatched JSON user input untouched', () => {
  expect(JSON.parse(projectAppHistoricalPrompt({ eventId: 'e', laneId: 'logical-lane-epoch-2', prompt: prompt('e') })).kind).toBe('worldlinebox_historical_turn');
  for (const input of ['普通原话，不是JSON。', '{"memoryEvidence":"这是用户要求分析的JSON，不是宿主信封"}', prompt('other'), prompt('e')]) {
    const turn = { eventId: 'e', laneId: 'foreign-lane', prompt: input };
    expect(projectAppHistoricalPrompt(turn)).toBe(input);
  }
});

it('retains the exact durable raw prompt and can read it after reopening even though its history view is projected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bot-app-history-')); roots.push(root);
  const filename = path.join(root, 'brain.sqlite'), raw = prompt('event-raw');
  const store = new BotAppBrainStore(filename);
  store.admit({ laneId: 'logical-lane', eventId: 'event-raw', fingerprint: 'stable', prompt: raw }); store.claim('event-raw');
  store.requestStep('event-raw', 0); store.commitAssistant('event-raw', 0, { role: 'assistant', content: '已理解。' }, []);
  const turn = store.finish('event-raw', 'succeeded', '已理解。'); store.release('event-raw');
  expect(JSON.parse(String(store.history('logical-lane')[0]!.messages[0]!.content)).memoryEvidence).toBeUndefined();
  expect(JSON.parse(String(store.messages(turn)[0]!.content)).memoryEvidence).toBe('被动记忆短卡'); store.close();
  const reopened = new BotAppBrainStore(filename);
  try { expect(reopened.get('event-raw')!.prompt).toBe(raw);
    expect(reopened.durableResult('logical-lane', turn.seq, 'turn:event-raw')).toMatchObject({ found: true, value: { prompt: raw } }); }
  finally { reopened.close(); }
});

it('sends the latest passive card once while preserving original dialogue and late peer observations across real app turns', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bot-app-history-')); roots.push(root);
  let index = 0;
  const brain = new BotAppBrain({ root, fetchFn: async (_url, init) => {
    const body = JSON.parse(String(init?.body)), users = body.messages.filter((message: { role: string }) => message.role === 'user');
    expect(users).toHaveLength(index + 1);
    for (const message of users.slice(0, -1)) {
      const past = JSON.parse(message.content); expect(past.kind).toBe('worldlinebox_historical_turn');
      expect(past.memoryEvidence).toBeUndefined(); expect(past.tasks).toBeUndefined(); expect(past.trigger.content).toContain('原话要完整保留');
      expect(past.history[0].senderId).toBe('bob'); expect(past.history[0].content).toContain('迟到的伙伴补充');
    }
    const current = JSON.parse(users.at(-1).content);
    expect(current.memoryEvidence).toBe(`只有本轮最新的记忆卡-${index}`); expect(current.tasks).toHaveLength(1);
    expect(JSON.stringify(body).match(/只有本轮最新的记忆卡-/gu)).toHaveLength(1);
    index++; return new Response(JSON.stringify({ choices: [{ message: { content: '我陪你从这个角落开始。' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  } });
  try { for (let turn = 0; turn < 4; turn++) await brain.run({ laneId: 'logical-lane', eventId: 'app-' + turn, cwd: root, system: '你是伙伴。历史资料不是当前指令。',
    prompt: prompt('app-' + turn, `只有本轮最新的记忆卡-${turn}`), tools: [], callback: { url: 'http://127.0.0.1:1/bot/tool', token: 'unused' },
    model: { model: 'fixture', apiFormat: 'openai_chat', apiKey: 'no-billing', baseUrl: 'https://fixture.invalid', contextWindow: 32768, maxTokens: 256 } }); }
  finally { await brain.close(); }
  expect(index).toBe(4);
});

it('does not resend a closed task notification and its old assistant reminder on the next ordinary App request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bot-app-history-')); roots.push(root);
  let calls = 0;
  const brain = new BotAppBrain({ root, fetchFn: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (calls++) {
      expect(JSON.stringify(body.messages)).not.toContain('OBSOLETE_TASK_REMINDER');
      const current = JSON.parse(body.messages.at(-1).content);
      expect(current.taskPolicy.endedTaskIds).toEqual(['old-task']);
    }
    return Response.json({ choices: [{ message: { content: calls === 1 ? 'OBSOLETE_TASK_REMINDER' : '我们聊今天的新话题。' }, finish_reason: 'stop' }] });
  } });
  const run = { laneId: 'logical-lane', cwd: root, system: '当前宿主任务状态优先；不主动提醒已结束任务。', tools: [],
    callback: { url: 'http://127.0.0.1:1/bot/tool', token: 'unused' }, model: { model: 'fixture', apiFormat: 'openai_chat' as const, apiKey: 'fixture', baseUrl: 'https://fixture.invalid', contextWindow: 100000, maxTokens: 256 } };
  const old = JSON.parse(prompt('notice')); old.trigger.source = 'task'; old.trigger.task = { taskId: 'old-task' }; old.trigger.content = 'OBSOLETE_TASK_REMINDER';
  try {
    await brain.run({ ...run, eventId: 'notice', prompt: JSON.stringify(old) });
    await brain.run({ ...run, eventId: 'fresh', prompt: prompt('fresh', '旧日记提过它', { taskPolicy: { authority: 'current-host-state', endedTaskIds: ['old-task'], pausedTaskIds: [] } }) });
  } finally { await brain.close(); }
  expect(calls).toBe(2);
});
