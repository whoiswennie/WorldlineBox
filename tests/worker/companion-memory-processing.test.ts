import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '认真', model: '', avatar: 'sister', proactive: false, active: true }));
const fixtures: Array<{ root: string; store: CompanionsStore }> = [];
function fixture() { const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-memory-processing-')); const file = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(file, seeds); fixtures.push({ root, store }); return { root, file, store, room: store.openPrivate('alice').id, peerRoom: store.openPrivate('bob').id }; }
afterEach(() => { for (const item of fixtures.splice(0)) { item.store.close(); if (path.dirname(item.root) !== tmpdir() || !path.basename(item.root).startsWith('worldlinebox-memory-processing-')) throw new Error('Unexpected fixture.'); removeOwnedDirectorySync(item.root); } });
const status = (store: CompanionsStore, companionId = 'alice', limit = 30) => store.request({ type: 'memory.processing.status', companionId, limit }).memoryProcessing!;

it('shows real source queue admission, claimed work and completed checks without claiming every message became a diary', () => {
  const { store, room, peerRoom } = fixture();
  const source = store.appendMessage({ conversationId: room, authorId: 'user', content: '今天想去海边。' });
  store.appendMessage({ conversationId: peerRoom, authorId: 'user', content: '别人的私人内容不在这里。' });
  let report = status(store);
  expect(report.summary).toMatchObject({ pending: 1, running: 0, completed: 0 });
  expect(report.jobs).toHaveLength(1); expect(report.jobs[0]).toMatchObject({ kind: 'capture', status: 'pending', sourceMessageId: source.id, preview: source.content, attempts: 0 });
  expect(report.jobs[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  report = status(store); expect(report.jobs[0]).toMatchObject({ id: job.id, status: 'running', attempts: 1 });
  store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [] });
  report = status(store); expect(report.summary).toMatchObject({ completed: 1, pending: 0, running: 0 });
  expect(report.jobs[0]!.stage).toContain('是否写成日记');
  expect(report.jobs[0]!.updatedAt! >= report.jobs[0]!.createdAt!).toBe(true);
  expect(store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus?.memories).toBe(0);
  expect(JSON.stringify(report)).not.toContain('别人的私人内容');
});

it('reports actual index and TagMaster failures separately and leaves document bodies out of stale evidence', () => {
  const { store, room } = fixture();
  const note = store.saveMemory({ companionId: 'alice', conversationId: room, content: '这是一份等待原文标签整理的资料。', tags: [] });
  let report = status(store); expect(report.jobs.map(job => job.kind).sort()).toEqual(['index', 'tags']);
  const tag = store.request({ type: 'memory.tags.claim' }).memoryTagJob!;
  store.request({ type: 'memory.tags.defer', id: tag.id, leaseToken: tag.leaseToken, reason: 'needs_model', error: '尚未配置聊天模型', retryAfterMs: 1000 });
  const delivery = store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
  store.request({ type: 'memory.outbox.fail', id: delivery.id, leaseToken: delivery.leaseToken, error: '本地向量服务暂时不可用', retryAfterMs: 5000 });
  report = status(store); expect(report.summary).toMatchObject({ pending: 1, failed: 1 });
  expect(report.jobs.find(job => job.kind === 'tags')).toMatchObject({ status: 'waiting_model', error: '尚未配置聊天模型', noteId: note.id });
  expect(report.jobs.find(job => job.kind === 'index')).toMatchObject({ status: 'failed', error: '本地向量服务暂时不可用', attempts: 1 });
  expect(report.jobs.every(job => !!job.createdAt && !!job.updatedAt)).toBe(true);
  store.request({ type: 'memory.forget', companionId: 'alice', conversationId: room, id: note.id });
  expect(status(store).jobs.some(job => job.preview?.includes('等待原文标签整理'))).toBe(false);
});

it('bounds the owner report before returning records, includes older active work, and rejects invalid owners and limits', () => {
  const { store, room, peerRoom } = fixture();
  for (let n = 0; n < 80; n++) store.appendMessage({ conversationId: room, authorId: 'user', content: '本人的来源 ' + n });
  for (let n = 0; n < 8; n++) store.appendMessage({ conversationId: peerRoom, authorId: 'user', content: '其他角色 ' + n });
  const running = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  const report = status(store, 'alice', 7); expect(report.jobs).toHaveLength(7); expect(report.hasMore).toBe(true);
  expect(report.jobs.every(job => job.status === 'running')).toBe(true); expect(report.summary.running).toBe(8);
  expect(report.jobs.some(job => running.sourceMessageIds.includes(job.sourceMessageId!))).toBe(true);
  expect(report.summary.pending).toBe(72); expect(JSON.stringify(report)).not.toContain('其他角色');
  expect(() => status(store, 'missing')).toThrow('伙伴不存在');
  expect(() => status(store, 'alice', 51)).toThrow();
});

it('does not fabricate creation dates for legacy jobs and records subsequent real transitions', () => {
  const { store, room, file } = fixture(); store.appendMessage({ conversationId: room, authorId: 'user', content: '已有来源' });
  const db = new (Database as { new(file: string): CompanionConnection })(file);
  try { db.prepare('UPDATE vcp_capture_jobs SET created_at=NULL,updated_at=NULL WHERE companion_id=?').run('alice'); } finally { db.close(); }
  expect(status(store).jobs[0]).not.toHaveProperty('createdAt'); expect(status(store).jobs[0]).not.toHaveProperty('updatedAt');
  store.request({ type: 'memory.jobs.claim', companionId: 'alice' });
  expect(status(store).jobs[0]).not.toHaveProperty('createdAt'); expect(status(store).jobs[0]!.updatedAt).toBeTruthy();
});

it('uses a matching index for bounded per-state history instead of sorting all owner jobs', () => {
  const { file } = fixture(); const db = new (Database as { new(file: string): CompanionConnection })(file);
  try {
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id,status,attempts,ordinal,created_at,updated_at,next_attempt,error,message_id,conversation_id FROM vcp_capture_jobs WHERE companion_id=? AND status=? ORDER BY updated_at DESC,ordinal DESC LIMIT ?").all('alice', 'done', 31) as Array<{ detail: string }>;
    expect(plan.some(item => item.detail.includes('vcp_capture_jobs_processing_recent'))).toBe(true);
    expect(plan.some(item => item.detail.includes('TEMP B-TREE'))).toBe(false);
  } finally { db.close(); }
});

it('filters completed tasks in SQLite even when pending tasks fill the default page', () => {
  const { store, room } = fixture();
  for (let n = 0; n < 8; n++) store.appendMessage({ conversationId: room, authorId: 'user', content: '已经检查过的来源 ' + n });
  const claimed = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  store.request({ type: 'memory.jobs.complete', id: claimed.id, leaseToken: claimed.leaseToken, notes: [] });
  for (let n = 0; n < 40; n++) store.appendMessage({ conversationId: room, authorId: 'user', content: '新的待处理来源 ' + n });
  expect(status(store).jobs.every(job => job.status === 'pending')).toBe(true);
  const completed = store.request({ type: 'memory.processing.status', companionId: 'alice', filter: 'completed', limit: 5 }).memoryProcessing!;
  expect(completed.jobs).toHaveLength(5); expect(completed.jobs.every(job => job.status === 'completed')).toBe(true); expect(completed.hasMore).toBe(true);
  expect(completed.summary).toMatchObject({ pending: 40, completed: 8 });
});

it('reports durable retry floors and manual exhaustion without inventing a host timer or start ETA', () => {
  const { store, room, file } = fixture(); store.appendMessage({ conversationId: room, authorId: 'user', content: '有价值但尚未整理的来源。' });
  const pending = status(store).jobs[0]!;
  expect(pending.schedule).toMatchObject({ scheduleKind: 'condition', timeBasis: 'real', waitingReason: 'queue' });
  expect(pending.schedule?.nextCheckAt).toBeUndefined(); expect(pending.schedule?.explanation).toContain('不保证');
  const claimed = store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  const before = Date.now();
  store.request({ type: 'memory.jobs.fail', id: claimed.id, leaseToken: claimed.leaseToken, error: '真实模型请求失败。', retryAfterMs: 5000 });
  const retry = status(store).jobs[0]!;
  expect(retry.schedule).toMatchObject({ scheduleKind: 'retry', waitingReason: 'retry_backoff', nextAttemptAt: retry.nextAttemptAt });
  expect(Date.parse(retry.nextAttemptAt!)).toBeGreaterThanOrEqual(before + 5000);
  const db = new (Database as { new(file: string): CompanionConnection })(file);
  try { db.prepare("UPDATE vcp_capture_jobs SET attempts=8 WHERE id=?").run(claimed.id); } finally { db.close(); }
  const exhausted = status(store).jobs[0]!;
  expect(exhausted.schedule).toMatchObject({ scheduleKind: 'manual', waitingReason: 'retry_limit' });
  expect(exhausted.nextAttemptAt).toBeUndefined(); expect(exhausted.schedule?.nextAttemptAt).toBeUndefined();
});

it('distinguishes capture activation requirements from document tag and index work', () => {
  const { store, room, file } = fixture();
  store.appendMessage({ conversationId: room, authorId: 'user', content: '休眠后留在队列的原始来源。' });
  store.saveMemory({ companionId: 'alice', conversationId: room, content: '手工资料的管理流程不依赖虚拟生活是否激活。' });
  const db = new (Database as { new(file: string): CompanionConnection })(file);
  try { db.prepare("UPDATE companions SET data=json_set(data,'$.active',json('false')) WHERE id='alice'").run(); } finally { db.close(); }
  const jobs = status(store).jobs;
  expect(jobs.find(job => job.kind === 'capture')?.schedule).toMatchObject({ waitingReason: 'companion_inactive' });
  expect(jobs.find(job => job.kind === 'tags')?.schedule?.waitingReason).not.toBe('companion_inactive');
  expect(jobs.find(job => job.kind === 'index')?.schedule?.waitingReason).not.toBe('companion_inactive');
  expect(store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob).toBeUndefined();
});

it('shows actual same-scope index contention and never calls a lease expiry an execution time', () => {
  const { store, room } = fixture();
  store.saveMemory({ companionId: 'alice', conversationId: room, content: '第一份有明确手工标签的资料。', tags: ['手工'] });
  store.saveMemory({ companionId: 'alice', conversationId: room, content: '同一记忆范围的第二份资料。', tags: ['手工'] });
  const running = store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
  const queued = status(store).jobs.find(job => job.kind === 'index' && job.id !== running.id)!;
  expect(queued.schedule).toMatchObject({ scheduleKind: 'condition', waitingReason: 'scope_busy' });
  expect(queued.schedule?.nextAttemptAt).toBeUndefined(); expect(queued.schedule?.nextCheckAt).toBeUndefined();
  expect(store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox).toBeUndefined();
});

it('manual retry recovers exhausted pending work for its owner while preserving other owners', () => {
  const { store, room, peerRoom, file } = fixture();
  store.appendMessage({ conversationId: room, authorId: 'user', content: '本人的待收录来源。' });
  store.appendMessage({ conversationId: peerRoom, authorId: 'user', content: '别人的待收录来源。' });
  store.saveMemory({ companionId: 'alice', conversationId: room, content: '本人的待索引及标签文档。' });
  store.saveMemory({ companionId: 'bob', conversationId: peerRoom, content: '别人的待索引及标签文档。' });
  const db = new (Database as { new(file: string): CompanionConnection })(file);
  try {
    for (const table of ['vcp_capture_jobs', 'vcp_memory_outbox', 'companion_memory_tag_jobs']) db.prepare(`UPDATE ${table} SET status='pending',attempts=8,next_attempt=0`).run();
    expect(status(store).jobs.every(job => job.schedule?.scheduleKind === 'manual')).toBe(true);
    store.request({ type: 'memory.jobs.retry', companionId: 'alice' }); store.request({ type: 'memory.tags.retry', companionId: 'alice' });
    for (const table of ['vcp_capture_jobs', 'vcp_memory_outbox', 'companion_memory_tag_jobs']) {
      expect(db.prepare(`SELECT status,attempts FROM ${table} WHERE companion_id='alice'`).get()).toMatchObject({ status: 'pending', attempts: 0 });
      expect(db.prepare(`SELECT status,attempts FROM ${table} WHERE companion_id='bob'`).get()).toMatchObject({ status: 'pending', attempts: 8 });
    }
    expect(store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob?.attempts).toBe(1);
    expect(store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox?.attempts).toBe(1);
    expect(store.request({ type: 'memory.tags.claim' }).memoryTagJob?.companionId).toBe('alice');
  } finally { db.close(); }
});

it('retries exhausted expired leases but never resets a valid running lease', () => {
  const { store, room, file } = fixture();
  store.appendMessage({ conversationId: room, authorId: 'user', content: '有效租约保护的来源。' });
  store.saveMemory({ companionId: 'alice', conversationId: room, content: '有效租约保护的文档。' });
  store.request({ type: 'memory.jobs.claim', companionId: 'alice' }); store.request({ type: 'memory.outbox.claim', companionId: 'alice' }); store.request({ type: 'memory.tags.claim' });
  const db = new (Database as { new(file: string): CompanionConnection })(file);
  try {
    for (const table of ['vcp_capture_jobs', 'vcp_memory_outbox', 'companion_memory_tag_jobs']) db.prepare(`UPDATE ${table} SET attempts=8,lease_until=? WHERE companion_id='alice'`).run(Date.now() + 60000);
    store.request({ type: 'memory.jobs.retry', companionId: 'alice' }); store.request({ type: 'memory.tags.retry', companionId: 'alice' });
    for (const table of ['vcp_capture_jobs', 'vcp_memory_outbox', 'companion_memory_tag_jobs']) {
      const valid = db.prepare(`SELECT status,attempts,lease_token FROM ${table} WHERE companion_id='alice'`).get() as { lease_token: string };
      expect(valid).toMatchObject({ status: 'running', attempts: 8 }); expect(valid.lease_token).toBeTruthy();
      db.prepare(`UPDATE ${table} SET lease_until=? WHERE companion_id='alice'`).run(Date.now() - 1);
    }
    expect(status(store).jobs.every(job => job.schedule?.waitingReason === 'retry_limit')).toBe(true);
    store.request({ type: 'memory.jobs.retry', companionId: 'alice' }); store.request({ type: 'memory.tags.retry', companionId: 'alice' });
    for (const table of ['vcp_capture_jobs', 'vcp_memory_outbox', 'companion_memory_tag_jobs']) expect(db.prepare(`SELECT status,attempts,lease_token,lease_until FROM ${table} WHERE companion_id='alice'`).get())
      .toMatchObject({ status: 'pending', attempts: 0, lease_token: null, lease_until: null });
  } finally { db.close(); }
});
