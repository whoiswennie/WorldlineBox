import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionTaskKind } from '../../src/shared/companion-task-overview';
import { companionSearchTokens, companionSearchFacet } from '../../src/shared/companion-search';

const fixtures: Array<{ root: string; store: CompanionsStore; db: CompanionConnection }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.db.close(); f.store.close(); removeOwnedDirectorySync(f.root); } });
const at = '2026-10-26T09:00:00.000Z';
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-task-detail-')), file = path.join(root, 'state.sqlite');
  const roles = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '测试伙伴', model: '', avatar: 'sister' as const, active: false, proactive: false }));
  const store = new CompanionsStore(file, roles), room = store.openPrivate('alice').id;
  const db = new (Database as { new(file: string): CompanionConnection })(file), f = { root, store, db }; fixtures.push(f);
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const source = store.appendMessage({ conversationId: room, authorId: 'user', content: '请核对季度报告，并告诉我结论。', replyDirective: 'none' });
  const reply = store.appendMessage({ conversationId: room, authorId: 'alice', content: '**核对完成**\n\n- 收入已核对\n- 仍有一项待补充', replyDirective: 'none' });
  db.prepare('INSERT INTO companion_work_queue(id,status,companion_id,data) VALUES(?,?,?,?)').run('reply_one', 'done', 'alice', JSON.stringify({
    id: 'reply_one', companionId: 'alice', conversationId: room, sourceMessageId: source.id, messageId: reply.id, status: 'done', createdAt: at, updatedAt: at }));
  const inspect = (kind: CompanionTaskKind, id: string, section: 'input' | 'process' | 'output', offset = 0, limit = 12) =>
    f.store.request({ type: 'task.inspect', companionId: 'alice', kind, id, section, offset, limit }).taskDetail!;
  return { f, file, roles, room, source, reply, inspect };
}

it('reads actual chat inputs and published outputs; list pages contain no cold bodies', () => {
  const { f, inspect } = fixture();
  expect(inspect('reply', 'reply_one', 'input').items.map(item => item.text)).toContain('请核对季度报告，并告诉我结论。');
  expect(inspect('reply', 'reply_one', 'output').items[0]?.text).toContain('**核对完成**');
  const list = f.store.request({ type: 'tasks.page', view: 'history' }).taskPage!;
  expect(JSON.stringify(list)).not.toContain('收入已核对');
  expect(() => f.store.request({ type: 'task.inspect', companionId: 'bob', kind: 'reply', id: 'reply_one' })).toThrow('不属于');
});

it('retains the input captured at the actual start after a later source edit', () => {
  const { f, source, inspect } = fixture();
  f.db.prepare("UPDATE companion_work_queue SET status='running' WHERE id='reply_one'").run();
  f.db.prepare('UPDATE messages SET content=? WHERE id=?').run('这是之后修改的新消息正文。', source.id);
  const inputs = inspect('reply', 'reply_one', 'input').items;
  expect(inputs.find(item => item.id === 'saved:trigger')?.text).toBe(source.content);
  expect(inputs.some(item => item.text === '这是之后修改的新消息正文。')).toBe(false);
});

it('slices long Unicode tool output and formats structured fields without transferring raw objects', () => {
  const { f, inspect, room, source } = fixture();
  const long = '🙂核对内容'.repeat(6000);
  f.db.prepare('INSERT INTO actions(id,conversation_id,companion_id,status,data) VALUES(?,?,?,?,?)').run('tool_one', room, 'alice', 'running', JSON.stringify({
    title: '读取报告', sourceMessageId: source.id, createdAt: at, updatedAt: at, result: JSON.stringify({ summary: long, count: 12, apiKey: 'MUST_NOT_EXPOSE', leaseToken: 'PRIVATE_TOKEN' }) }));
  const detail = inspect('action', 'tool_one', 'output');
  expect(detail.items).toHaveLength(2); expect(detail.items.map(item => item.title)).toContain('工具执行结果 · 摘要');
  expect(JSON.stringify(detail)).not.toContain('MUST_NOT_EXPOSE'); expect(JSON.stringify(detail)).not.toContain('PRIVATE_TOKEN');
  expect(detail.items[0]!.text.length).toBeLessThanOrEqual(8000);
  const record = detail.items[0]!;
  const next = f.store.request({ type: 'task.content', companionId: 'alice', kind: 'action', id: 'tool_one', recordId: record.id, offset: 6000, limit: 6000 }).taskContent!;
  expect(next.text).toBe([...long].slice(6000, 12000).join('')); expect(next.hasMore).toBe(true); expect(next.totalCharacters).toBe([...long].length);
  expect(() => f.store.request({ type: 'task.content', companionId: 'alice', kind: 'action', id: 'tool_one', recordId: 'message:another_task' })).toThrow('不可读取');
  f.db.prepare("INSERT INTO metadata(key,value) VALUES('execution-source-invalid/action/tool_one','{}')").run();
  expect(inspect('action', 'tool_one', 'output').items).toHaveLength(0);
  expect(() => f.store.request({ type: 'task.content', companionId: 'alice', kind: 'action', id: 'tool_one', recordId: record.id })).toThrow('不可读取');
});

it('persists timeline inputs, stages and final documents through an actual SQLite reopen', () => {
  const { f, inspect, room, file, roles, source } = fixture();
  const note = f.store.request({ type: 'memory.record', companionId: 'alice', conversationId: room,
    candidate: { artifactKind: 'episode_memory' as const, content: '十月核对季度报告。', sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const job = { id: 'timeline_one', kind: 'timeline' as const, status: 'running' as const, stage: '正在整理十月时间线', title: '十月时间线整理', attempts: 1, conversationId: room, createdAt: at, startedAt: at, updatedAt: at };
  const first = f.store.request({ type: 'tasks.timeline.record', companionId: 'alice', job, input: JSON.stringify({ count: 1, sources: [{ id: note.id, version: note.version }] }) }).jobDisposition!;
  const progress = f.store.request({ type: 'tasks.timeline.record', companionId: 'alice', expectedDispositionRevision: first.revision, job: { ...job, stage: '核对产出文档' } }).jobDisposition!;
  f.store.request({ type: 'tasks.timeline.record', companionId: 'alice', expectedDispositionRevision: progress.revision, job: { ...job, status: 'completed', stage: '文档已发布' }, output: '# 十月\n\n完成季度核对。' });
  expect(inspect('memory_timeline', job.id, 'process').items.map(item => item.title)).toEqual(expect.arrayContaining(['正在整理十月时间线', '核对产出文档', '文档已发布']));
  f.store.close(); f.store = new CompanionsStore(file, roles);
  expect(inspect('memory_timeline', job.id, 'output').items[0]?.text).toBe('# 十月\n\n完成季度核对。');
  expect(inspect('memory_timeline', job.id, 'input').items.some(item => item.text === note.id)).toBe(true);
  expect(f.store.request({ type: 'tasks.page', view: 'history' }).taskPage?.items.some(item => item.id === job.id)).toBe(true);
  f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: room, id: note.id });
  expect(inspect('memory_timeline', job.id, 'output').items).toHaveLength(0);
});

it('parks an interrupted timeline after reopening instead of automatically repeating an unknown model attempt', () => {
  const { f, room, file, roles, inspect } = fixture();
  f.store.request({ type: 'tasks.timeline.record', companionId: 'alice', job: { id: 'timeline_interrupted', kind: 'timeline', title: '中断的时间线',
    status: 'running', stage: '生成月度摘要', attempts: 1, conversationId: room, createdAt: at, startedAt: at, updatedAt: at } });
  f.store.close(); f.store = new CompanionsStore(file, roles);
  expect(inspect('memory_timeline', 'timeline_interrupted', 'process').task).toMatchObject({ status: 'paused', rawStatus: 'parked', stage: '上次运行已中断，发送结果尚未确认；请核对后明确恢复' });
  expect(f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'timeline', id: 'timeline_interrupted' }).jobDisposition).toMatchObject({ state: 'parked', failureCount: 0 });
});

it('keeps actual world events and distinguishes retry wait from a finished decision', () => {
  const { f, room, inspect } = fixture();
  f.db.prepare('INSERT INTO companion_world_jobs(id,companion_id,kind,status,data) VALUES(?,?,?,?,?)').run('world_one', 'alice', 'decision', 'failed', JSON.stringify({ createdAt: at, conversationId: room, attempts: 1 }));
  expect(inspect('world', 'world_one', 'process').task).toMatchObject({ status: 'waiting', stage: '本轮未完成，等待重试' });
  f.db.prepare('INSERT INTO companion_world_events(id,data) VALUES(?,?)').run('walk_one', JSON.stringify({ actorId: 'alice', kind: 'movement', text: 'alice 到达了公园长椅。', realAt: at, at, sceneId: 'park', behavior: { kind: 'walking', phase: 'completed' } }));
  const page = f.store.request({ type: 'tasks.page', view: 'history' }).taskPage!;
  expect(page.items.some(item => item.kind === 'world_action' && item.id === 'walk_one')).toBe(true);
  expect(inspect('world_action', 'walk_one', 'output').items[0]?.text).toBe('alice 到达了公园长椅。');
});

it('does not manufacture world outputs from an idempotent replay of an already finished job', () => {
  const { f, room, inspect } = fixture();
  f.db.prepare('INSERT INTO companion_world_jobs(id,companion_id,kind,status,data) VALUES(?,?,?,?,?)').run('world_already_done', 'alice', 'decision', 'done', JSON.stringify({
    id: 'world_already_done', companionId: 'alice', conversationId: room, kind: 'decision', status: 'done', leaseToken: 'original_lease', createdAt: at, attempts: 1 }));
  expect(f.store.request({ type: 'world.job.complete', id: 'world_already_done', leaseToken: 'original_lease', activityTask: { title: '不能伪造的新产出', goal: '没有实际执行过的目标。' } }).ok).toBe(true);
  expect(inspect('world', 'world_already_done', 'output').items).toHaveLength(0);
});

it('does not expose a withdrawn message through task inputs or full-content reads', () => {
  const { f, source, inspect } = fixture();
  const record = inspect('reply', 'reply_one', 'input').items[0]!;
  f.db.prepare('INSERT INTO vcp_source_blocks(message_id,companion_id,created_at) VALUES(?,?,?)').run(source.id, 'alice', at);
  expect(inspect('reply', 'reply_one', 'input').items).toHaveLength(0);
  expect(inspect('reply', 'reply_one', 'input').notice).toContain('不可访问');
  expect(() => f.store.request({ type: 'task.content', companionId: 'alice', kind: 'reply', id: 'reply_one', recordId: record.id })).toThrow('不可读取');
});

it('shows actual maintenance inputs and output versions without assuming every captured source produced a diary', () => {
  const { f, room, source, inspect } = fixture();
  const note = f.store.request({ type: 'memory.record', companionId: 'alice', conversationId: room,
    candidate: { artifactKind: 'episode_memory' as const, content: '已保存：本季度报告已完成核对。', tags: ['季度报告'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  f.db.prepare('INSERT INTO vcp_memory_outbox(id,companion_id,scope_id,note_id,note_version,operation,data,status) VALUES(?,?,?,?,?,?,?,?)').run('index_test', 'alice', note.scopeId, note.id, note.version, 'forget', '{}', 'done');
  f.db.prepare('INSERT INTO companion_memory_tag_jobs(id,companion_id,note_id,note_version,content_hash,status) VALUES(?,?,?,?,?,?)').run('tag_test', 'alice', note.id, note.version, 'hash', 'done');
  f.db.prepare('INSERT INTO vcp_capture_jobs(id,companion_id,conversation_id,message_id,source_sequence,through_sequence,source_checksum,source_revision,status,output_note_versions,completed_batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('capture_test', 'alice', room, source.id, source.sequence, source.sequence, 'hash', 1, 'done', JSON.stringify([{ id: note.id, version: note.version }]), 'capture_test');
  expect(inspect('memory_index', 'index_test', 'input').items.some(item => item.text === note.content)).toBe(true);
  expect(inspect('memory_tags', 'tag_test', 'output').items.some(item => item.text === '季度报告')).toBe(true);
  expect(inspect('memory_capture', 'capture_test', 'output').items.some(item => item.text === note.content)).toBe(true);
  f.db.prepare("UPDATE vcp_memory_notes SET data=json_set(data,'$.version',2,'$.content','后来修改的新正文') WHERE id=?").run(note.id);
  expect(inspect('memory_capture', 'capture_test', 'output').items.some(item => item.text.includes('后来修改'))).toBe(false);
  f.db.prepare("UPDATE vcp_capture_jobs SET output_note_versions='[]' WHERE id='capture_test'").run();
  expect(inspect('memory_capture', 'capture_test', 'output').items[0]?.text).toContain('没有新增日记');
});

it('observes sustained activity receipts without representing model summaries as executed effects', () => {
  const { f, room, source, inspect } = fixture();
  f.db.prepare('INSERT INTO companion_activity_tasks(id,companion_id,conversation_id,source_message_id,status,next_at,client_id,data) VALUES(?,?,?,?,?,?,?,?)')
    .run('activity_test', 'alice', room, source.id, 'succeeded', 0, 'activity_test', JSON.stringify({ title: '前往公园', goal: '去公园长椅休息。', createdAt: at, updatedAt: at, stage: '完成', history: [
      { step: 1, at, action: 'observe', result: '我打算去公园。', ok: true }, { step: 2, at, action: 'move', result: '已到达公园长椅。', ok: true, resultProvenance: 'host_receipt' },
    ] }));
  expect(inspect('activity', 'activity_test', 'input').items.some(item => item.text === '去公园长椅休息。')).toBe(true);
  expect(inspect('activity', 'activity_test', 'process').items.find(item => item.text === '我打算去公园。')?.provenance).toBe('model_output');
  expect(inspect('activity', 'activity_test', 'output').items.find(item => item.text === '已到达公园长椅。')?.provenance).toBe('host');
});

it('keeps occurrence input separate from a later edited schedule and exposes the actual saved result', () => {
  const { f, room, source, inspect } = fixture();
  f.db.prepare('INSERT INTO companion_schedules(id,companion_id,conversation_id,source_message_id,status,next_run_at,identity_key,data) VALUES(?,?,?,?,?,?,?,?)')
    .run('schedule_test', 'alice', room, source.id, 'active', at, 'schedule_test', JSON.stringify({ title: '日报提醒', prompt: '请提醒我核对收入。', createdAt: at, updatedAt: at, revision: 1 }));
  f.db.prepare('INSERT INTO companion_schedule_occurrences(id,schedule_id,scheduled_at,status,data) VALUES(?,?,?,?,?)')
    .run('occurrence_test', 'schedule_test', at, 'pending', JSON.stringify({ createdAt: at, updatedAt: at, result: '已发送核对收入的提醒。' }));
  f.db.prepare("UPDATE companion_schedule_occurrences SET status='running' WHERE id='occurrence_test'").run();
  f.db.prepare("UPDATE companion_schedules SET data=json_set(data,'$.prompt','下次请改成核对支出。') WHERE id='schedule_test'").run();
  const input = inspect('schedule_occurrence', 'occurrence_test', 'input');
  expect(input.items.some(item => item.text === '请提醒我核对收入。')).toBe(true);
  expect(input.items.some(item => item.text === '下次请改成核对支出。')).toBe(false);
  expect(inspect('schedule_occurrence', 'occurrence_test', 'output').items.some(item => item.text === '已发送核对收入的提醒。')).toBe(true);
});

it('reads learning source excerpts and round summaries without claiming they are host execution facts', () => {
  const { f, room, source, inspect } = fixture();
  f.db.prepare('INSERT INTO companion_learning_grants(id,companion_id,library_id,enabled,autonomous,revision,data) VALUES(?,?,?,?,?,?,?)')
    .run('grant_test', 'alice', 'library_test', 1, 1, 1, JSON.stringify({ libraryName: '财务资料库', folderName: '季度报告', createdAt: at, updatedAt: at }));
  f.db.prepare('INSERT INTO companion_learning_reads(id,companion_id,grant_id,asset_id,asset_revision,offset,source_message_id,data,status) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('read_test', 'alice', 'grant_test', 'asset_test', 'v1', 0, source.id, JSON.stringify({ assetName: '季度报告', readAt: at }), 'read');
  expect(inspect('learning', 'grant_test', 'input').items.some(item => item.text === '财务资料库')).toBe(true);
  expect(inspect('learning', 'grant_test', 'output').items.some(item => item.text === source.content)).toBe(true);
  f.db.prepare('INSERT INTO companion_learning_goals(id,companion_id,data,state,revision,next_at) VALUES(?,?,?,?,?,?)')
    .run('goal_test', 'alice', JSON.stringify({ text: '学习季度报表的核对方法。', phase: 'reading', createdAt: at, updatedAt: at }), 'active', 1, 0);
  f.db.prepare('INSERT INTO companion_learning_goal_rounds(id,goal_id,companion_id,ordinal,data) VALUES(?,?,?,?,?)')
    .run('round_test', 'goal_test', 'alice', 1, JSON.stringify({ summary: '已整理收入核对方法。', reads: [{ title: '报告摘要', excerpt: '收入需要逐项核对。', readAt: at }], startedAt: at, endedAt: at }));
  expect(inspect('learning_goal', 'goal_test', 'process').items.some(item => item.text === '收入需要逐项核对。')).toBe(true);
  expect(inspect('learning_goal', 'goal_test', 'output').items.find(item => item.text === '已整理收入核对方法。')?.provenance).toBe('model_output');
  f.db.prepare("UPDATE companion_learning_grants SET enabled=0 WHERE id='grant_test'").run();
  expect(inspect('learning', 'grant_test', 'output').items).toHaveLength(0);
  expect(room).toBeTruthy();
});

it('bounds list IPC and selected-detail work with 20000 cold task results', () => {
  const { f, room, inspect } = fixture();
  const insert = f.db.prepare('INSERT INTO actions(id,conversation_id,companion_id,status,data) VALUES(?,?,?,?,?)');
  f.db.transaction(() => { for (let index = 0; index < 20000; index++) insert.run('bulk_' + index.toString().padStart(5, '0'), room, 'alice', 'succeeded', JSON.stringify({ title: '资料核对', result: '归档说明'.repeat(1024), createdAt: at, updatedAt: at })); })();
  const start = performance.now(), page = f.store.request({ type: 'tasks.page', view: 'history', limit: 20 }).taskPage!, listMs = performance.now() - start;
  const selectedAt = performance.now(), detail = inspect('action', 'bulk_00000', 'output'), detailMs = performance.now() - selectedAt;
  expect(page.items.length).toBe(20); expect(page.total).toBeGreaterThanOrEqual(20001); expect(JSON.stringify(page).length).toBeLessThan(30000);
  expect(detail.items[0]?.text.length).toBe(4000); expect(JSON.stringify(detail).length).toBeLessThan(10000);
  expect(listMs).toBeLessThan(1500); expect(detailMs).toBeLessThan(500);
  writeFileSync(path.join(process.cwd(), 'artifacts/task-observation-performance.json'), JSON.stringify({ records: 20000, listMs, detailMs, listCharacters: JSON.stringify(page).length, detailCharacters: JSON.stringify(detail).length }, null, 2));
}, 60000);
