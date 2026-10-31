import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionTaskOverviewStore } from '../../src/companions/task-overview-store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionTaskItem, CompanionTaskPage } from '../../src/shared/companion-task-overview';
import { randomUUID } from 'node:crypto';

const fixtures: Array<{ root: string; store: CompanionsStore; db: CompanionConnection }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.db.close(); f.store.close(); removeOwnedDirectorySync(f.root); } });
const at = '2026-10-26T05:00:00.000Z';
it('distinguishes a durable parked source from a successful task and an explicitly abandoned history record', () => {
  const f = fixture();
  const source = f.store.appendMessage({ conversationId: f.alice, authorId: 'user', content: 'PRECIOUS_SOURCE_BODY_MUST_NOT_ENTER_TASK_LIST', replyDirective: 'none' });
  const job = f.store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'capture', limit: 20 }).jobPage!.items.find(job => job.sourceMessageId === source.id)!;
  expect(job).toBeDefined();
  const parked = f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'capture', id: job.id, inputVersion: job.inputVersion,
    expectedRevision: job.revision, operationId: randomUUID(), action: 'park' }).jobDisposition!;
  const waiting = f.inventory.resolve({ type: 'tasks.resolve', companionId: 'alice', kind: 'memory_capture', id: job.id })!;
  expect(waiting).toMatchObject({ rawStatus: 'parked', status: 'paused', canStop: false });
  expect(JSON.stringify(waiting)).not.toContain(source.content);
  expect(f.inventory.page({ type: 'tasks.page', companionId: 'alice', view: 'current', limit: 20 }).items.some(task => task.id === job.id)).toBe(true);
  f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'capture', id: job.id, inputVersion: parked.inputVersion,
    expectedRevision: parked.revision, operationId: randomUUID(), action: 'abandon' });
  expect(f.inventory.resolve({ type: 'tasks.resolve', companionId: 'alice', kind: 'memory_capture', id: job.id })).toMatchObject({ rawStatus: 'abandoned', status: 'cancelled', canStop: false });
  expect(f.inventory.page({ type: 'tasks.page', companionId: 'alice', view: 'history', limit: 20 }).items.some(task => task.id === job.id)).toBe(true);
  expect(f.store.getMessage(source.id).content).toBe(source.content);
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-task-overview-')), file = path.join(root, 'state.sqlite');
  const store = new CompanionsStore(file, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '测试伙伴', model: '', avatar: 'sister' as const, active: false, proactive: false })));
  const alice = store.openPrivate('alice').id, bob = store.openPrivate('bob').id;
  const db = new (Database as { new(file: string): CompanionConnection })(file), inventory = new CompanionTaskOverviewStore(db);
  fixtures.push({ root, store, db }); inventory.initialize();
  const action = (id: string, owner: string, room: string, status = 'running', updatedAt = at) => db.prepare('INSERT INTO actions(id,conversation_id,companion_id,status,data) VALUES(?,?,?,?,?)').run(id, room, owner, status,
    JSON.stringify({ id, companionId: owner, conversationId: room, title: `实际工具任务 ${id}`, stage: '正在执行浏览器步骤', status,
      createdAt: at, updatedAt, result: 'PRIVATE_TOOL_BODY_DO_NOT_MATERIALIZE', events: [{ content: 'PRIVATE_EVENT_BODY' }] }));
  const reply = (id: string, owner = 'alice', room = alice, status = 'running', updatedAt = at) => db.prepare('INSERT INTO companion_work_queue(id,status,companion_id,data) VALUES(?,?,?,?)').run(id, status, owner,
    JSON.stringify({ id, companionId: owner, conversationId: room, sourceMessageId: 'source_' + id, status, createdAt: at, updatedAt }));
  return { root, store, db, inventory, alice, bob, action, reply };
}

it('lists actual tasks across conversations and owners with bounded metadata only', () => {
  const f = fixture(); f.reply('reply_a'); f.reply('reply_b', 'bob', f.bob, 'queued'); f.action('action_a', 'alice', f.alice); f.action('action_b', 'bob', f.bob, 'succeeded');
  f.db.prepare('INSERT INTO companion_activity_tasks(id,companion_id,conversation_id,status,next_at,client_id,data) VALUES(?,?,?,?,?,?,?)').run('activity_a', 'alice', f.alice, 'waiting', 0, 'client_activity', JSON.stringify({ title: '去公园拜访', goal: 'PRIVATE_ACTIVITY_GOAL', history: [{ result: 'PRIVATE_ACTIVITY_HISTORY' }], stage: '等待伙伴答复', createdAt: at, updatedAt: at }));
  const current = f.inventory.page({ type: 'tasks.page', view: 'current', limit: 20 });
  expect(current.items.map(item => [item.kind, item.id])).toEqual(expect.arrayContaining([['reply', 'reply_a'], ['reply', 'reply_b'], ['action', 'action_a'], ['activity', 'activity_a']]));
  expect(current.items.some(item => item.id === 'action_b')).toBe(false);
  expect(current.current).toBe(4); expect(current.history).toBe(1); expect(current.total).toBe(4);
  expect(current.owners.find(owner => owner.companionId === 'alice')?.current).toBe(3);
  expect(current.owners.find(owner => owner.companionId === 'bob')).toMatchObject({ current: 1, history: 1 });
  expect(JSON.stringify(current)).not.toMatch(/PRIVATE_TOOL_BODY|PRIVATE_EVENT_BODY|PRIVATE_ACTIVITY_GOAL|PRIVATE_ACTIVITY_HISTORY/u);
  const selected = f.inventory.page({ type: 'tasks.page', companionId: 'bob', view: 'all', limit: 20 });
  expect(selected.items.every(item => item.companionId === 'bob')).toBe(true); expect(selected.total).toBe(2);
});

it('includes notification and life-occurrence budget work across owners in exact paged totals', () => {
  const f = fixture();
  for (const [owner, room] of [['alice', f.alice], ['bob', f.bob]] as const) {
    const id = 'notice_' + owner;
    f.db.prepare('INSERT INTO companion_social_notifications(id,companion_id,origin_id,event_key,status,lease_until,attempts,created_at,data) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, owner, 'origin_' + owner, 'event_' + owner, 'running', at, 1, at, JSON.stringify({ id, companionId: owner, conversationId: room, sourceMessageId: 'PRIVATE_SOURCE_BODY', status: 'running', attempts: 1, createdAt: at, dialogue: [{ content: 'PRIVATE_NOTIFICATION_DIALOGUE' }] }));
    const rule = f.store.request({ type: 'life-rule.list', companionId: owner }).lifeRules![0]!;
    f.db.prepare('INSERT INTO companion_life_occurrences VALUES(?,?,?,?,?,?,?)').run('life_' + owner, owner, rule.id, at, 'running', at,
      JSON.stringify({ id: 'life_' + owner, companionId: owner, ruleId: rule.id, rule, windowStart: at, status: 'running', lastRealAt: at }));
  }
  const ids = new Set<string>(); let cursor: CompanionTaskPage['nextCursor'];
  do {
    const result = f.inventory.page({ type: 'tasks.page', view: 'current', limit: 1, ...(cursor ? { cursor } : {}) });
    expect(result.total).toBe(4); expect(result.coverage).toEqual(expect.arrayContaining(['social_notification', 'life_occurrence']));
    for (const item of result.items) {
      expect(ids.has(item.kind + ':' + item.id)).toBe(false); ids.add(item.kind + ':' + item.id);
      if (item.kind === 'life_occurrence') { expect(item.canStop).toBe(false); expect(item.stopReason).toContain('生活规则'); expect(item.createdAt).toBeUndefined(); }
    }
    expect(JSON.stringify(result)).not.toContain('PRIVATE_NOTIFICATION_DIALOGUE'); cursor = result.nextCursor;
  } while (cursor);
  expect(ids.size).toBe(4);
  expect(f.inventory.page({ type: 'tasks.page', view: 'current', companionId: 'bob', limit: 20 }).items.every(item => item.companionId === 'bob')).toBe(true);
});

it('seeks all history without duplicates across equal times and mixed kinds', () => {
  const f = fixture();
  for (let index = 0; index < 53; index++) { f.reply(`reply_${String(index).padStart(3, '0')}`, 'alice', f.alice, 'done'); f.action(`action_${String(index).padStart(3, '0')}`, 'bob', f.bob, 'succeeded'); }
  let cursor: Parameters<typeof f.inventory.page>[0]['cursor']; const ids: string[] = [];
  do { const page = f.inventory.page({ type: 'tasks.page', view: 'history', cursor, limit: 7 });
    expect(page.items.length).toBeLessThanOrEqual(7); expect(page.total).toBe(106);
    ids.push(...page.items.map(item => `${item.kind}:${item.id}`)); cursor = page.nextCursor;
    if (!page.hasMore) break;
  } while (cursor);
  expect(ids).toHaveLength(106); expect(new Set(ids).size).toBe(106);
});

it('merges exact runtime timeline entries into the same pagination and owner counts', () => {
  const f = fixture(); f.reply('reply_a'); f.action('action_a', 'alice', f.alice);
  const runtime: CompanionTaskItem = { id: 'timeline_a', kind: 'memory_timeline', companionId: 'alice', title: '时间线整理', rawStatus: 'running', status: 'running', stage: '生成本月时间线', updatedAt: at, canStop: false, stoppedByUser: false };
  const first = f.inventory.page({ type: 'tasks.page', view: 'current', limit: 1, runtimeItems: [runtime] });
  expect(first.total).toBe(3); expect(first.items[0]!.kind).toBe('action');
  const second = f.inventory.page({ type: 'tasks.page', view: 'current', cursor: first.nextCursor, limit: 1, runtimeItems: [runtime] });
  expect(second.items[0]!.kind).toBe('memory_timeline');
  const third = f.inventory.page({ type: 'tasks.page', view: 'current', cursor: second.nextCursor, limit: 1, runtimeItems: [runtime] });
  expect(third.items[0]!.kind).toBe('reply'); expect(third.hasMore).toBe(false);
});

it('resolves only the actual owner and hides invalidated action metadata', () => {
  const f = fixture(); f.action('action_a', 'alice', f.alice, 'cancelled');
  const stop = { actor: 'user', reason: 'user_requested', requestedAt: at };
  f.db.prepare("UPDATE actions SET data=json_set(data,'$.stop',json(?)) WHERE id=?").run(JSON.stringify(stop), 'action_a');
  f.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('execution-source-invalid/action/action_a', '{}');
  expect(f.inventory.resolve({ type: 'tasks.resolve', kind: 'action', companionId: 'bob', id: 'action_a' })).toBeUndefined();
  const resolved = f.inventory.resolve({ type: 'tasks.resolve', kind: 'action', companionId: 'alice', id: 'action_a' });
  expect(resolved).toMatchObject({ title: '引用资料已变化的工具任务', stage: '旧执行正文不可引用', status: 'cancelled', canStop: false, stoppedByUser: true, stopRequestedAt: at });
});

it('distinguishes reply questions and room labels using bounded user-source snippets, hiding withdrawn sources', () => {
  const f = fixture(), second = f.store.createConversation('另一项核对工作', ['alice']);
  const first = f.store.appendMessage({ conversationId: f.alice, authorId: 'user', content: '请核对蓝色报表。' + '长输入'.repeat(1000), replyDirective: 'none' });
  const other = f.store.appendMessage({ conversationId: second.id, authorId: 'user', content: '请查询今日会议安排。', replyDirective: 'none' });
  f.reply('question_a'); f.reply('question_b', 'alice', second.id);
  f.db.prepare("UPDATE companion_work_queue SET data=json_set(data,'$.sourceMessageId',?) WHERE id=?").run(first.id, 'question_a');
  f.db.prepare("UPDATE companion_work_queue SET data=json_set(data,'$.sourceMessageId',?) WHERE id=?").run(other.id, 'question_b');
  const a = f.inventory.resolve({ type: 'tasks.resolve', kind: 'reply', companionId: 'alice', id: 'question_a' });
  const b = f.inventory.resolve({ type: 'tasks.resolve', kind: 'reply', companionId: 'alice', id: 'question_b' });
  expect(a?.title).toMatch(/^回复 · 请核对蓝色报表/u); expect(a!.title.length).toBeLessThanOrEqual(125);
  expect(b).toMatchObject({ title: '回复 · 请查询今日会议安排。', conversationTitle: '另一项核对工作' });
  expect(a?.title).not.toBe(b?.title);
  f.db.prepare('INSERT INTO vcp_source_blocks(message_id,companion_id,created_at) VALUES(?,?,?)').run(first.id, 'alice', at);
  expect(f.inventory.resolve({ type: 'tasks.resolve', kind: 'reply', companionId: 'alice', id: 'question_a' })?.title).toBe('聊天回复（来源已不可用）');
});

it('projects durable schedule, work, world and learning states without their goal bodies', () => {
  const f = fixture();
  const source = f.store.appendMessage({ conversationId: f.alice, authorId: 'user', content: '安排一次晚间提醒。', replyDirective: 'none' });
  f.db.prepare('INSERT INTO companion_work_orders(id,companion_id,conversation_id,status,data) VALUES(?,?,?,?,?)').run('order_a','alice',f.alice,'offered',JSON.stringify({title:'写报告',instruction:'PRIVATE_ORDER_BODY',revision:1,createdAt:at,updatedAt:at}));
  f.db.prepare('INSERT INTO companion_schedules(id,companion_id,conversation_id,source_message_id,status,next_run_at,identity_key,data) VALUES(?,?,?,?,?,?,?,?)').run('schedule_a','alice',f.alice,source.id,'active',at,'identity_a',JSON.stringify({title:'晚间提醒',prompt:'PRIVATE_SCHEDULE_BODY',revision:1,createdAt:at,updatedAt:at}));
  f.db.prepare('INSERT INTO companion_schedule_occurrences(id,schedule_id,scheduled_at,status,data) VALUES(?,?,?,?,?)').run('occurrence_a','schedule_a',at,'running',JSON.stringify({createdAt:at,updatedAt:at,startedAt:at}));
  f.db.prepare('INSERT INTO companion_world_jobs(id,companion_id,kind,status,data) VALUES(?,?,?,?,?)').run('world_a','alice','dream','running',JSON.stringify({conversationId:f.alice,createdAt:at}));
  f.db.prepare('INSERT INTO companion_learning_goals(id,companion_id,data,state,revision,next_at) VALUES(?,?,?,?,?,?)').run('goal_a','alice',JSON.stringify({text:'PRIVATE_LEARNING_GOAL',phase:'planning',createdAt:at,updatedAt:at}),'active',1,Date.parse(at));
  const page = f.inventory.page({type:'tasks.page',view:'current',companionId:'alice'});
  expect(page.items.map(item=>item.kind)).toEqual(expect.arrayContaining(['work_order','schedule','schedule_occurrence','world','learning_goal']));
  expect(JSON.stringify(page)).not.toContain('PRIVATE_');
  expect(page.items.find(item=>item.id==='occurrence_a')).toMatchObject({parentId:'schedule_a',stopLabel:'停止本次执行'});
});
