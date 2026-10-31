import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionJobDisposition, CompanionJobKind, CompanionJobPage } from '../../src/shared/companion-job-control';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import Database from 'better-sqlite3';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionMemoryProcessingJob } from '../../src/shared/companion-memory-processing';

const seeds = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '创建起点', model: '', avatar: 'sister' as const, active: true, proactive: false }));
let root: string, file: string, store: CompanionsStore, room: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-28T09:00:00Z');
  root = mkdtempSync(path.join(tmpdir(), 'companion-job-control-')); file = path.join(root, 'state.sqlite');
  store = new CompanionsStore(file, seeds); room = store.openPrivate('alice').id;
});
afterEach(() => { store.close(); vi.useRealTimers();
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-job-control-')) throw new Error('Unexpected fixture root.');
  removeOwnedDirectorySync(root); });
const source = (content: string) => store.appendMessage({ conversationId: room, authorId: 'user', content, replyDirective: 'none' });
const claim = () => store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob;
const inspect = (kind: CompanionJobKind, id: string) => store.request({ type: 'jobs.inspect', ownerId: 'alice', kind, id }).jobDisposition!;
function control(current: CompanionJobDisposition, action: 'park' | 'resume' | 'abandon', operationId = randomUUID()) {
  const command = { type: 'jobs.control' as const, ownerId: current.ownerId, kind: current.kind, id: current.id,
    inputVersion: current.inputVersion, expectedRevision: current.revision, operationId, action };
  return { command, next: store.request(command).jobDisposition! };
}

it('parks three failed attempts durably, isolates the poison event and processes fifty new independent events without losing the original bytes', () => {
  const poison = source('珍贵原始事件 POISON_ORIGINAL_MUST_REMAIN'); let id = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const job = claim()!; if (!id) id = job.id; expect(job.id).toBe(id);
    store.request({ type: 'memory.jobs.fail', id, leaseToken: job.leaseToken, error: 'Controlled processing failure.', retryAfterMs: 1000 });
    expect(inspect('capture', id)).toMatchObject({ failureCount: attempt, cycleFailureCount: attempt, state: attempt === 3 ? 'parked' : 'failed' });
    vi.setSystemTime(Date.now() + 1001);
  }
  store.request({ type: 'memory.jobs.retry', companionId: 'alice' });
  expect(claim()).toBeUndefined(); store.close(); store = new CompanionsStore(file, seeds);
  expect(inspect('capture', id)).toMatchObject({ state: 'parked', failureCount: 3, cycleFailureCount: 3 });
  const later = Array.from({ length: 50 }, (_, index) => source('后续独立事件 ' + index)), consumed = new Set<string>();
  for (let turn = 0; turn < 60; turn++) {
    const job = claim(); if (!job) break; expect(job.sourceMessageIds).not.toContain(poison.id);
    store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: job.sourceMessageIds.map(messageId => {
      const message = store.getMessage(messageId); consumed.add(messageId);
      return { artifactKind: 'episode_memory', content: message.content, sourceMessageIds: [messageId], evidence: [{ sourceMessageId: messageId, quote: message.content }],
        metadata: { autoTags: false }, sourceChecksums: job.sourceChecksums };
    }) });
  }
  expect([...consumed].sort()).toEqual(later.map(message => message.id).sort());
  expect(store.getMessage(poison.id).content).toBe(poison.content);
  expect(inspect('capture', id)).toMatchObject({ state: 'parked', failureCount: 3 });
});

it('invalidates a running capture cohort atomically, rejects its late result and returns unparked original members to pending', () => {
  const first = source('第一份真实事件。'), second = source('第二份独立真实事件。'), job = claim()!;
  expect(job.sourceMessageIds).toEqual([first.id, second.id]);
  const current = inspect('capture', job.id), parked = control(current, 'park').next;
  expect(parked).toMatchObject({ state: 'parked', failureCount: 0 });
  expect(() => store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [] })).toThrow('租约');
  const next = claim()!; expect(next.sourceMessageIds).toEqual([second.id]); expect(next.leaseToken).not.toBe(job.leaseToken);
  expect(store.getMessage(first.id).content).toBe(first.content); expect(store.getMessage(second.id).content).toBe(second.content);
});

it('retries every failed cohort member even when a successful isolated sibling has already completed their shared episode', () => {
  const user = source('玩家提供的重要原始事件。'), reply = store.appendMessage({ conversationId: room, authorId: 'alice', replyToId: user.id, content: '伙伴本人实际回应。' });
  const original = claim()!; expect(original.sourceMessageIds).toEqual([user.id, reply.id]);
  store.request({ type: 'memory.jobs.fail', id: original.id, leaseToken: original.leaseToken, error: 'Actual cohort output failed.', retryAfterMs: 1000 });
  vi.setSystemTime(Date.now() + 1001);
  const first = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  expect(first.sourceMessageIds).toEqual([user.id]);
  store.request({ type: 'memory.jobs.complete', id: first.id, leaseToken: first.leaseToken, notes: [{ artifactKind: 'episode_memory', content: user.content,
    sourceMessageIds: [user.id], evidence: [{ sourceMessageId: user.id, quote: user.content }], sourceChecksums: first.sourceChecksums }] });
  const second = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  expect(second.sourceMessageIds).toEqual([reply.id]); expect(second.id).not.toBe(first.id);
  expect(inspect('capture', second.id)).toMatchObject({ state: 'running', failureCount: 1 });
  store.request({ type: 'memory.jobs.complete', id: second.id, leaseToken: second.leaseToken, notes: [] });
  expect(inspect('capture', second.id).state).toBe('completed');
});

it('keeps lifetime failures through explicit resume cycles, checks CAS/owner/input and never revives an explicitly abandoned job', () => {
  source('原始事件必须保留。'); let id = '';
  for (let cycle = 0; cycle < 2; cycle++) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const job = claim()!; id = job.id;
      store.request({ type: 'memory.jobs.fail', id, leaseToken: job.leaseToken, error: 'Actual quality failure.', retryAfterMs: 1000 });
      vi.setSystemTime(Date.now() + 1001);
    }
    const parked = inspect('capture', id); expect(parked).toMatchObject({ state: 'parked', failureCount: (cycle + 1) * 3, cycleFailureCount: 3 });
    if (cycle === 0) {
      const { command, next } = control(parked, 'resume'); expect(next).toMatchObject({ state: 'pending', failureCount: 3, cycleFailureCount: 0 });
      expect(store.request(command).jobDisposition).toEqual(next);
      expect(() => store.request({ ...command, action: 'abandon' })).toThrow('操作标识');
      expect(() => store.request({ ...command, operationId: randomUUID(), ownerId: 'bob' })).toThrow();
      expect(() => store.request({ ...command, operationId: randomUUID(), inputVersion: '0'.repeat(64) })).toThrow('状态已经变化');
    }
  }
  const abandoned = control(inspect('capture', id), 'abandon').next;
  expect(abandoned).toMatchObject({ state: 'abandoned', failureCount: 6, cycleFailureCount: 3 });
  store.request({ type: 'memory.jobs.retry', companionId: 'alice' });
  expect(claim()).toBeUndefined(); expect(() => control(abandoned, 'resume')).toThrow('已经终结');
  expect(store.messages({ conversationId: room }).messages.some(message => message.content === '原始事件必须保留。')).toBe(true);
});

it('does not count host waiting as a quality failure or let it decrement the lifetime claim count', () => {
  source('等待可用模型的真实事件。');
  const first = claim()!; store.request({ type: 'memory.jobs.defer', id: first.id, leaseToken: first.leaseToken, error: 'Host queue unavailable.', retryAfterMs: 1000 });
  expect(inspect('capture', first.id)).toMatchObject({ state: 'pending', failureCount: 0, cycleFailureCount: 0 });
  vi.setSystemTime(Date.now() + 1001); const next = claim()!;
  expect(next.id).toBe(first.id); expect(next.attempts).toBe(first.attempts + 1);
  expect(inspect('capture', next.id).failureCount).toBe(0);
});

it('pages more than 130 actual parked sources by owner and state without treating the latest fifty as the entire queue', () => {
  const originals = Array.from({ length: 131 }, (_, index) => source('需保留原始事件 ' + index));
  let afterId: string | undefined; const parked: string[] = [];
  for (let page = 0; page < 5; page++) {
    const result: CompanionJobPage = store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'capture', afterId, limit: 50 }).jobPage!;
    for (const item of result.items) { control(item, 'park'); parked.push(item.id); }
    if (!result.hasMore) break; afterId = result.nextId;
  }
  expect(parked).toHaveLength(131); expect(new Set(parked).size).toBe(131);
  store.request({ type: 'memory.jobs.retry', companionId: 'alice' });
  const pages: string[] = []; afterId = undefined;
  for (let page = 0; page < 5; page++) {
    const result: CompanionJobPage = store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'capture', states: ['parked'], afterId, limit: 50 }).jobPage!;
    pages.push(...result.items.map(item => item.id)); if (!result.hasMore) break; afterId = result.nextId;
  }
  expect(pages).toEqual([...parked].sort());
  expect(store.request({ type: 'jobs.page', ownerId: 'bob', kind: 'capture', states: ['parked'], limit: 50 }).jobPage?.items).toEqual([]);
  const db = new (Database as { new(file: string): CompanionConnection })(file);
  try {
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM vcp_capture_jobs WHERE companion_id=? AND id>? AND status IN(SELECT value FROM json_each(?)) ORDER BY id LIMIT ?")
      .all('alice', '', '["parked"]', 51) as Array<{ detail: string }>;
    expect(plan.some(row => /SEARCH vcp_capture_jobs USING INDEX vcp_capture_jobs_control/u.test(row.detail))).toBe(true);
  } finally { db.close(); }
  const fresh = source('新独立事件仍可处理。'), current = claim()!;
  expect(current.sourceMessageIds).toEqual([fresh.id]);
  expect(originals.every(item => store.getMessage(item.id).content === item.content)).toBe(true);
});

it('fences late timeline records through park, resume and restart while atomically keeping actual input and output', () => {
  const job: CompanionMemoryProcessingJob = { id: randomUUID(), kind: 'timeline', status: 'running', stage: '真实开始', title: '时间线', attempts: 1,
    sourceRevision: 'stable-authorized-corpus', conversationId: room, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const first = store.request({ type: 'tasks.timeline.record', companionId: 'alice', job, input: '实际固定输入' }).jobDisposition!;
  expect(first).toMatchObject({ attemptCount: 1, state: 'running' });
  const parked = control(first, 'park').next;
  expect(() => store.request({ type: 'tasks.timeline.record', companionId: 'alice', expectedDispositionRevision: first.revision, job: { ...job, status: 'completed' }, output: '过期结果' })).toThrow('状态已变化');
  const resumed = control(parked, 'resume').next; store.close(); store = new CompanionsStore(file, seeds);
  const second = store.request({ type: 'tasks.timeline.record', companionId: 'alice', expectedDispositionRevision: resumed.revision, job: { ...job, attempts: 0 } }).jobDisposition!;
  expect(second.attemptCount).toBe(2);
  const completed = store.request({ type: 'tasks.timeline.record', companionId: 'alice', expectedDispositionRevision: second.revision, job: { ...job, status: 'completed', attempts: 0 }, output: '实际完成的结果' }).jobDisposition!;
  expect(completed).toMatchObject({ state: 'completed', attemptCount: 2 });
  const db = new (Database as { new(file: string): CompanionConnection })(file);
  try { expect(db.prepare('SELECT input,output FROM companion_task_timeline_jobs WHERE id=?').get(job.id)).toEqual({ input: '实际固定输入', output: '实际完成的结果' }); } finally { db.close(); }
  const processing = store.request({ type: 'memory.processing.status', companionId: 'alice', limit: 50 }).memoryProcessing!;
  expect(processing.jobs.find(item => item.kind === 'timeline' && item.id === job.id)?.disposition).toEqual(completed);
});

it('parks repeated real timeline failures without clearing counters and never accepts an old unversioned record', () => {
  const job: CompanionMemoryProcessingJob = { id: randomUUID(), kind: 'timeline', status: 'running', stage: '开始', title: '时间线', attempts: 1, sourceRevision: 'fixed', conversationId: room };
  let state = store.request({ type: 'tasks.timeline.record', companionId: 'alice', job }).jobDisposition!;
  for (let attempt = 1; attempt <= 3; attempt++) {
    state = store.request({ type: 'tasks.timeline.record', companionId: 'alice', expectedDispositionRevision: state.revision,
      job: { ...job, status: 'failed', error: 'Actual provider failure.' }, failureKind: 'processing' }).jobDisposition!;
    expect(state.failureCount).toBe(attempt);
    if (attempt < 3) state = store.request({ type: 'tasks.timeline.record', companionId: 'alice', expectedDispositionRevision: state.revision, job }).jobDisposition!;
  }
  expect(state).toMatchObject({ state: 'parked', failureCount: 3, cycleFailureCount: 3, attemptCount: 3 });
  expect(() => store.request({ type: 'tasks.timeline.record', companionId: 'alice', job })).toThrow('状态已变化');
  expect(store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'timeline', states: ['parked'], limit: 50 }).jobPage?.items).toEqual([state]);
});

it('parks uncertain running timeline work after restart without charging a failure or silently sending it again', () => {
  const job: CompanionMemoryProcessingJob = { id: randomUUID(), kind: 'timeline', status: 'running', stage: '已发往外部', title: '时间线', attempts: 1,
    sourceRevision: 'fixed-before-crash', conversationId: room };
  const first = store.request({ type: 'tasks.timeline.record', companionId: 'alice', job, input: '保持原始输入字节' }).jobDisposition!;
  store.close(); store = new CompanionsStore(file, seeds);
  const held = inspect('timeline', job.id); expect(held).toMatchObject({ state: 'parked', failureCount: 0, cycleFailureCount: 0, attemptCount: 1 });
  expect(held.revision).toBeGreaterThan(first.revision);
  expect(() => store.request({ type: 'tasks.timeline.record', companionId: 'alice', expectedDispositionRevision: held.revision, job })).toThrow('搁置');
  const resumed = control(held, 'resume').next;
  expect(store.request({ type: 'tasks.timeline.record', companionId: 'alice', expectedDispositionRevision: resumed.revision, job }).jobDisposition)
    .toMatchObject({ state: 'running', attemptCount: 2, failureCount: 0 });
});

it.each(['index', 'tags'] as const)('governs the original %s rows, isolates poison input and never lets a broad retry unseal it', kind => {
  const record = (content: string) => {
    const message = source(content);
    return store.request({ type: 'memory.record', companionId: 'alice', conversationId: room, candidate: { artifactKind: 'knowledge', content,
      tags: [], metadata: { autoTags: kind === 'tags' }, sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: content }] } }).memories![0]!;
  };
  const take = () => kind === 'tags' ? store.request({ type: 'memory.tags.claim' }).memoryTagJob : store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox;
  const original = record('必须保留的真实知识正文。'); let id = '';
  for (let count = 1; count <= 3; count++) {
    const current = take()!; id = current.id;
    if (kind === 'tags') store.request({ type: 'memory.tags.defer', id, leaseToken: current.leaseToken, reason: 'retry', error: 'Actual processing failure.', retryAfterMs: 1000 });
    else store.request({ type: 'memory.outbox.fail', id, leaseToken: current.leaseToken, failureKind: 'processing', error: 'Actual processing failure.', retryAfterMs: 1000 });
    vi.setSystemTime(Date.now() + 1001);
  }
  const parked = inspect(kind, id); expect(parked).toMatchObject({ state: 'parked', failureCount: 3, cycleFailureCount: 3, attemptCount: 3 });
  store.request(kind === 'tags' ? { type: 'memory.tags.retry', companionId: 'alice' } : { type: 'memory.outbox.retry', companionId: 'alice' });
  expect(take()).toBeUndefined();
  const next = record('后续合法资料不应被坏作业挡住。'), nextJob = take()!;
  expect(nextJob.noteId).toBe(next.id); expect(nextJob.id).not.toBe(id);
  expect(store.request({ type: 'memory.library.read', companionId: 'alice', id: original.id }).memoryRead?.memory.content).toBe(original.content);
  const resumed = control(parked, 'resume').next;
  expect(resumed).toMatchObject({ state: 'pending', failureCount: 3, cycleFailureCount: 0 });
  expect(store.request({ type: 'jobs.page', ownerId: 'alice', kind, limit: 50 }).jobPage?.items.some(item => item.id === nextJob.id)).toBe(true);
});

it('scrubs only withdrawn timeline input and copied errors while keeping raw events, unrelated jobs and lifetime counts', () => {
  const make = (content: string) => {
    const message = source(content), memory = store.request({ type: 'memory.record', companionId: 'alice', conversationId: room, candidate: { artifactKind: 'episode_memory',
      content, tags: [], sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: content }] } }).memories![0]!;
    const job: CompanionMemoryProcessingJob = { id: randomUUID(), kind: 'timeline', status: 'running', stage: '开始', title: '时间线', attempts: 1, sourceRevision: memory.id, conversationId: room };
    const first = store.request({ type: 'tasks.timeline.record', companionId: 'alice', job, input: JSON.stringify({ sources: [{ id: memory.id, contentRevision: memory.contentRevision }], text: content }) }).jobDisposition!;
    const failed = store.request({ type: 'tasks.timeline.record', companionId: 'alice', expectedDispositionRevision: first.revision, job: { ...job, status: 'failed', error: content }, failureKind: 'processing' }).jobDisposition!;
    const held = control(failed, 'park'); return { message, memory, job, held };
  };
  const revoked = make('WITHDRAWN_TIMELINE_SECRET_CANARY'), unrelated = make('UNRELATED_TIMELINE_CANARY');
  store.request({ type: 'memory.forget', companionId: 'alice', conversationId: room, id: revoked.memory.id });
  expect(inspect('timeline', revoked.job.id)).toMatchObject({ state: 'stale', failureCount: 1, cycleFailureCount: 1 });
  expect(inspect('timeline', revoked.job.id)).not.toHaveProperty('lastError');
  expect(inspect('timeline', unrelated.job.id)).toMatchObject({ state: 'parked', lastError: 'UNRELATED_TIMELINE_CANARY', failureCount: 1 });
  const db = new (Database as { new(file: string): CompanionConnection })(file);
  try {
    const revokedRow = db.prepare('SELECT input,output,data,last_failure_error FROM companion_task_timeline_jobs WHERE id=?').get(revoked.job.id);
    expect(JSON.stringify(revokedRow)).not.toContain('WITHDRAWN_TIMELINE_SECRET_CANARY');
    expect(db.prepare('SELECT input,output FROM companion_task_timeline_jobs WHERE id=?').get(revoked.job.id)).toEqual({ input: null, output: null });
    expect(JSON.stringify(db.prepare('SELECT data FROM companion_job_control_receipts WHERE owner_id=? AND operation_id=?').get('alice', revoked.held.command.operationId))).not.toContain('WITHDRAWN_TIMELINE_SECRET_CANARY');
    expect(JSON.stringify(db.prepare('SELECT data FROM companion_job_control_receipts WHERE owner_id=? AND operation_id=?').get('alice', unrelated.held.command.operationId))).toContain('UNRELATED_TIMELINE_CANARY');
  } finally { db.close(); }
  expect(() => store.request({ type: 'tasks.timeline.record', companionId: 'alice', expectedDispositionRevision: revoked.held.next.revision, job: { ...revoked.job, status: 'completed' }, output: 'late' })).toThrow();
  expect(store.getMessage(revoked.message.id).content).toBe(revoked.message.content);
  expect(store.getMessage(unrelated.message.id).content).toBe(unrelated.message.content);
});

it('uses owner, exact state and keyset index ranges for SQL job kinds and access histories, including normalized world and learning states', () => {
  const db = new (Database as { new(file: string): CompanionConnection })(file);
  try {
    const layouts = [
      ...['vcp_capture_jobs', 'vcp_memory_outbox', 'companion_memory_tag_jobs', 'companion_task_timeline_jobs', 'companion_learning_goal_rounds', 'companion_learning_grants']
        .map(table => ({ table, id: 'id', state: 'status', index: table + '_control_state_page' })),
      { table: 'companion_world_jobs', id: 'id', state: "CASE WHEN status='done' THEN CASE WHEN json_extract(data,'$.stop.actor')='user' THEN 'cancelled' ELSE 'completed' END ELSE status END", index: 'companion_world_jobs_normalized_state_page' },
      { table: 'companion_learning_observed_assets', id: 'job_id', state: "CASE WHEN job_status IN('parked','abandoned') THEN job_status WHEN status='withdrawn' THEN 'stale' ELSE job_status END", index: 'companion_learning_asset_normalized_state_page' },
      { table: 'companion_learning_asset_job_history', id: 'job_id', state: 'job_status', index: 'companion_learning_asset_history_state_page' },
    ];
    for (const layout of layouts) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT ${layout.id} AS id FROM ${layout.table} INDEXED BY ${layout.index}
        WHERE companion_id=? AND (${layout.state})=? AND ${layout.id}>? ORDER BY ${layout.id} LIMIT ?`).all('alice', 'parked', '', 51) as Array<{ detail: string }>;
      expect(plan, layout.table).toHaveLength(1);
      expect(plan[0]?.detail, layout.table).toMatch(/SEARCH .+ USING (?:COVERING )?INDEX .+ \(companion_id=\? AND (?:status|job_status|<expr>)=\? AND (?:id|job_id)>\?\)/u);
      expect(plan[0]?.detail, layout.table).toContain(layout.index);
    }
  } finally { db.close(); }
});

it('pages every one of 131 held material versions without hiding later work behind a fifty-row management view', () => {
  const grant = store.request({ type: 'learning.grant', companionId: 'alice', libraryId: 'library', libraryName: '真实已授权目录', libraryPath: root, autonomous: false, intervalMinutes: 30 }).learning!.grants[0]!, ids: string[] = [];
  for (let index = 0; index < 131; index++) {
    store.request({ type: 'learning.run', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
    const job = store.request({ type: 'learning.claim', excludedOwners: [] }).learningJob!;
    const current = store.request({ type: 'learning.begin', id: job.id, leaseToken: job.leaseToken, assetId: 'asset_' + index, assetRevisionId: 'version_' + index, offset: 0 }).jobDisposition!;
    ids.push(control(current, 'park').next.id);
  }
  const seen: string[] = []; let afterId: string | undefined;
  for (let page = 0; page < 5; page++) {
    const result: CompanionJobPage = store.request({ type: 'jobs.page', ownerId: 'alice', kind: 'learning', states: ['parked', 'abandoned'], afterId, limit: 50 }).jobPage!;
    seen.push(...result.items.map(item => item.id)); if (!result.hasMore) break; afterId = result.nextId;
  }
  expect(seen).toEqual(ids.sort()); expect(new Set(seen).size).toBe(131);
  store.request({ type: 'learning.run', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  const next = store.request({ type: 'learning.claim', excludedOwners: [] }).learningJob!;
  const current = store.request({ type: 'learning.begin', id: next.id, leaseToken: next.leaseToken, assetId: 'healthy_after_131', assetRevisionId: 'healthy_version', offset: 0 }).jobDisposition!;
  expect(current.state).toBe('running'); expect(seen).not.toContain(current.id);
  const completed = store.request({ type: 'learning.commit', id: next.id, leaseToken: next.leaseToken, assetId: 'healthy_after_131', assetRevisionId: 'healthy_version', assetName: '新资料.md', content: '后续实际获准读取的新资料。', offset: 0, more: false });
  expect(completed.learning?.reads[0]?.assetId).toBe('healthy_after_131');
});
