import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionConnection } from '../../src/companions/store';
import BetterSqlite3 from 'better-sqlite3';
import { CompanionMemoryStore } from '../../src/companions/memory-store';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionJobDisposition } from '../../src/shared/companion-job-control';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import { canonicalInferenceHost } from '../fixtures/companion-canonical-inference';
import { CompanionTopicCompactionService } from '../../src/main/companions/topic-compaction-service';
import { prepareTopicContinuity } from '../../src/main/companions/topic-compaction';
import { generateCompanionReply } from '../../src/main/companions/model';
import { COMPANION_DIALOGUE_WINDOW } from '../../src/main/companions/context-window';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import type { CompanionModelConfig, CompanionTransportAttempt } from '../../src/main/companions/model';
import { companionTopicArgumentsSchema } from '../../src/shared/companion-topic';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

/** Independent acceptance registration, fixed before the new actor is wired:
 * - a held background model never delays a native current-source reply;
 * - a real restart holds unknown work rather than silently paying again;
 * - three genuine failures park the stable thread despite a new horizon;
 * - exact explicit resume retains lifetime failures and a peer remains usable;
 * - ordinary configuration waiting never counts as a quality failure.
 * This file uses an isolated real SQLite ledger, never a user library. */
const fixtures: Array<{ root: string; store: CompanionsStore }> = [];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '只承认真实输入与结果。', model: '', avatar: 'sister', active: true, proactive: false }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-29T00:00:00Z'); });
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); removeOwnedDirectorySync(f.root); } vi.useRealTimers(); });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldline-topic-background-')), filename = path.join(root, 'state.sqlite');
  let store = new CompanionsStore(filename, seeds);
  const scopes = Object.fromEntries(seeds.map(owner => {
    const conversation = store.openPrivate(owner.id);
    let topic = store.request({ type: 'topic.create', conversationId: conversation.id, readerId: 'user', title: `本人讨论_${owner.id}`, kind: 'discussion' }).topic!;
    topic = store.request({ type: 'topic.join', conversationId: conversation.id, topicId: topic.id, readerId: owner.id }).topic!;
    return [owner.id, { companionId: owner.id, conversationId: conversation.id, topicId: topic.id }];
  }));
  const request = (command: CompanionStorageCommand): CompanionStorageResponse => store.request(command);
  const source = (owner = 'alice') => store.appendMessage({ conversationId: scopes[owner]!.conversationId, topicId: scopes[owner]!.topicId,
    authorId: 'user', content: `真实独立输入_${owner}_${randomUUID()}：尚未完成部分必须保留。`, replyDirective: 'none' });
  const enqueue = (owner = 'alice', message = source(owner)) => request({ type: 'topic.compaction.enqueue', ...scopes[owner]!, sourceMessageId: message.id }).topicCompactionJob!;
  const claim = (owner = 'alice') => request({ type: 'topic.compaction.claim', excludedCompanionIds: seeds.filter(seed => seed.id !== owner).map(seed => seed.id) }).topicCompactionJob;
  const inspect = (id: string, owner = 'alice') => request({ type: 'jobs.inspect', ownerId: owner, kind: 'topic_compaction', id }).jobDisposition!;
  const messages = (owner = 'alice') => {
    const result: CompanionMessage[] = []; let before: number | undefined;
    for (;;) {
      const page = store.messages({ conversationId: scopes[owner]!.conversationId, topicId: scopes[owner]!.topicId, limit: 100, before }).messages;
      result.unshift(...page); if (page.length < 100) return result; before = page[0]!.sequence;
    }
  };
  const originals = (owner = 'alice') => messages(owner).map(message => [message.id, message.revision, message.sequence, hash(message.content)]);
  const control = (current: CompanionJobDisposition, action: 'park' | 'resume' | 'abandon') => request({ type: 'jobs.control', ownerId: current.ownerId, kind: 'topic_compaction',
    id: current.id, inputVersion: current.inputVersion, expectedRevision: current.revision, operationId: randomUUID(), action }).jobDisposition!;
  const result = { root, filename, scopes, request, source, enqueue, claim, inspect, originals, messages, control, advance: () => vi.setSystemTime(Date.now() + 1001),
    get store() { return store; }, restart: () => { store.close(); store = new CompanionsStore(filename, seeds); } };
  fixtures.push(result); return result;
}

it('holds unknown running compaction across an actual SQLite reopen without changing original events or consuming another attempt', () => {
  const f = fixture(), source = f.source(), queued = f.enqueue('alice', source), claimed = f.claim()!, before = f.originals(), running = f.inspect(queued.id);
  expect(claimed.id).toBe(queued.id); expect(running.state).toBe('running');
  f.restart();
  const held = f.inspect(queued.id);
  expect(held).toMatchObject({ id: queued.id, state: 'parked', failureCount: 0 });
  expect(held.attemptCount).toBe(running.attemptCount); expect(held.revision).toBeGreaterThan(running.revision);
  expect(f.claim()).toBeUndefined();
  expect(() => f.request({ type: 'topic.compaction.settle', id: claimed.id, leaseToken: claimed.leaseToken!, hasMore: false })).toThrow();
  expect(f.originals()).toEqual(before);
  expect(f.request({ type: 'jobs.page', ownerId: 'alice', kind: 'topic_compaction', states: ['parked'], limit: 1 }).jobPage?.items.map(job => job.id)).toEqual([queued.id]);
});

it('parks three real failures despite later events and permits an independent peer and an exact explicit resume', () => {
  const f = fixture(), original = f.source(), queued = f.enqueue('alice', original), before = f.originals();
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = f.claim()!; expect(job.id).toBe(queued.id);
    f.request({ type: 'topic.compaction.fail', id: job.id, leaseToken: job.leaseToken!, error: `实际处理失败_${attempt}`, failureKind: 'processing', retryAfterMs: 1000 }); f.advance();
  }
  const held = f.inspect(queued.id); expect(held).toMatchObject({ state: 'parked', failureCount: 3, cycleFailureCount: 3 });
  const later = f.source(), next = f.enqueue('alice', later);
  expect(next.id).toBe(queued.id); expect(f.inspect(queued.id)).toMatchObject({ state: 'parked', failureCount: 3 }); expect(f.claim()).toBeUndefined();
  expect(f.originals().filter(row => row[0] === original.id)).toEqual(before);
  const peerSource = f.source('bob'), peer = f.enqueue('bob', peerSource), peerClaim = f.claim('bob')!;
  expect(peerClaim.id).toBe(peer.id);
  f.request({ type: 'topic.compaction.settle', id: peerClaim.id, leaseToken: peerClaim.leaseToken!, hasMore: false });
  expect(f.inspect(peer.id, 'bob').state).toBe('completed'); expect(f.inspect(queued.id).state).toBe('parked');
  const current = f.inspect(queued.id); expect(() => f.control(held, 'resume')).toThrow();
  const resumed = f.control(current, 'resume'); expect(resumed).toMatchObject({ failureCount: 3, cycleFailureCount: 0, state: 'pending' });
  const retry = f.claim()!; expect(retry.id).toBe(queued.id); expect(retry.claimedThroughSequence).toBe(later.sequence);
  f.request({ type: 'topic.compaction.settle', id: retry.id, leaseToken: retry.leaseToken!, hasMore: false });
  expect(f.inspect(queued.id)).toMatchObject({ state: 'completed', failureCount: 3 });
  expect(f.originals()).toHaveLength(2); expect(f.originals('bob')).toHaveLength(1);
});

it('keeps repeated configuration waiting separate from failures and never lets an unrelated owner enqueue private input', () => {
  const f = fixture(), message = f.source(), queued = f.enqueue('alice', message), before = f.originals();
  expect(() => f.request({ type: 'topic.compaction.enqueue', companionId: 'bob', conversationId: f.scopes.alice!.conversationId,
    topicId: f.scopes.alice!.topicId, sourceMessageId: message.id })).toThrow();
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = f.claim()!;
    f.request({ type: 'topic.compaction.fail', id: job.id, leaseToken: job.leaseToken!, error: '缺少模型配置或等待工程队列。', failureKind: 'waiting', retryAfterMs: 1000 }); f.advance();
  }
  expect(f.inspect(queued.id)).toMatchObject({ failureCount: 0, cycleFailureCount: 0, state: 'pending' });
  expect(f.claim()?.id).toBe(queued.id); expect(f.originals()).toEqual(before);
});

it('finishes a native foreground reply while the actual same-topic background model remains held and preserves every original source version', async () => {
  const f = fixture(); let release!: () => void, entered!: () => void, backgroundSettled = false, summaries = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), modelEntered = new Promise<void>(resolve => { entered = resolve; });
  const originals = Array.from({ length: 513 }, () => f.source()), originalBytes = f.originals();
  const config = { apiFormat: 'openai_chat' as const, model: 'controlled-topic-background', apiKey: 'isolated-fixture', baseUrl: 'http://127.0.0.1/never-network' };
  const host = await canonicalInferenceHost(f.root, f.store, config), errors: unknown[] = [], foregroundBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const reply = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }), { headers: { 'content-type': 'application/json' } });
  const backgroundFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const data = JSON.parse(body.messages.find(message => message.role === 'user')!.content) as { purpose: string };
    if (data.purpose === 'topic_context_compaction') {
      summaries++; entered(); await held;
      return reply({ summary: '正式摘要只覆盖这批真实旧输入，尚未完成部分仍保留。', stage: '继续当前话题' });
    }
    if (data.purpose === 'topic_user_canon_extract') return reply({ additions: [], revisions: [] });
    if (data.purpose === 'topic_summary_canon_audit' || data.purpose === 'topic_summary_canon_review') return reply({ supported: true, issues: [] });
    throw new Error('Unexpected deterministic background model purpose ' + data.purpose);
  };
  const actor = new CompanionTopicCompactionService({ request: host.request, configFor: owner => host.configFor(owner), fetchFn: backgroundFetch, report: error => errors.push(error) });
  let running: Promise<boolean> | undefined;
  const within = async <T>(promise: Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Foreground waited for the held background summary')), 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  try {
    const queued = f.enqueue('alice', originals.at(-1)!);
    running = actor.runOnce().finally(() => { backgroundSettled = true; });
    await within(modelEntered);
    const source = f.source(), scope = f.scopes.alice!, view = f.request({ type: 'topic.read', conversationId: scope.conversationId, topicId: scope.topicId, readerId: 'alice' });
    const companion = f.store.state(false, { companionId: 'alice', includeConversations: false }).companions.find(owner => owner.id === 'alice')!;
    const frame: CompanionReplyInput = { companion, conversation: f.store.openPrivate('alice'), topic: view.topic, topicState: view.topicState,
      sourceMessage: source, messages: f.messages().slice(-COMPANION_DIALOGUE_WINDOW.maxMessages), memories: [] };
    const prepared = await within(prepareTopicContinuity({ frame, request: host.request, config: await host.configFor(companion), fetchFn: backgroundFetch }));
    expect(prepared.topicContinuityCoverage).toMatchObject({ completeHistory: false, rawMessagesRetained: true, maintenanceState: 'running' });
    expect(prepared.messages).toHaveLength(COMPANION_DIALOGUE_WINDOW.maxMessages);
    expect(prepared.messages.at(-1)?.id).toBe(source.id); expect(prepared.topicState?.workingState?.summary).toBeUndefined();
    const result = await within(generateCompanionReply(prepared, await host.configFor(companion), undefined, { loop: true, tools: [], fetchFn: async (_url, init) => {
      foregroundBodies.push(JSON.parse(String(init?.body))); return reply('这次当前输入已经收到，旧记录仍在，后台整理可以继续。');
    } }));
    expect(result.text).toContain('当前输入'); expect(backgroundSettled).toBe(false); expect(summaries).toBe(1);
    const envelope = JSON.parse(foregroundBodies[0]!.messages.find(message => message.role === 'user')!.content);
    expect(envelope.topicContinuityCoverage).toMatchObject({ completeHistory: false, rawMessagesRetained: true });
    expect(envelope.messages.map((message: { id: string }) => message.id)).toContain(source.id);
    expect(JSON.stringify(foregroundBodies)).not.toContain('正式摘要只覆盖这批真实旧输入');
    expect(f.originals().filter(row => row[0] !== source.id)).toEqual(originalBytes);
    release(); await running; await actor.close();
    expect(errors).toEqual([]); expect(summaries).toBe(1);
    const current = f.request({ type: 'topic.read', conversationId: scope.conversationId, topicId: scope.topicId, readerId: 'alice' });
    // A new publication beyond the claim's fixed horizon is not a change to
    // its exact old prefix. It must not starve maintenance during active chat.
    expect(current.topicState?.workingState?.summary, JSON.stringify(f.inspect(queued.id))).toContain('正式摘要只覆盖这批真实旧输入');
    expect(f.inspect(queued.id)).toMatchObject({ state: 'pending', failureCount: 0 });
    expect(f.originals().filter(row => row[0] !== source.id)).toEqual(originalBytes);
  } finally { release(); await running?.catch(() => undefined); await actor.close(); await host.close(); }
}, 60000);

it.each([
  { mutation: 'forget', newer: false, held: 'parked' },
  { mutation: 'forget', newer: true, held: 'running' },
  { mutation: 'edit', newer: false, held: 'abandoned' },
  { mutation: 'edit', newer: true, held: 'running' },
] as const)('erases exact $mutation source failures ($held, newer horizon $newer) without washing holds or changing a peer', ({ mutation, newer, held }) => {
  const f = fixture(), secret = 'PRIVATE_TOPIC_SOURCE_' + randomUUID();
  const original = f.store.appendMessage({ conversationId: f.scopes.alice!.conversationId, topicId: f.scopes.alice!.topicId,
    authorId: 'user', content: secret, replyDirective: 'none' });
  const queued = f.enqueue('alice', original), first = f.claim()!;
  f.request({ type: 'topic.compaction.fail', id: first.id, leaseToken: first.leaseToken!, error: secret, failureKind: 'processing', retryAfterMs: 1000 });
  const parked = f.control(f.inspect(queued.id), 'park');
  let lateToken = first.leaseToken!;
  if (held === 'abandoned') f.control(parked, 'abandon');
  else if (held === 'running') { f.control(parked, 'resume'); lateToken = f.claim()!.leaseToken!; }
  if (newer) f.enqueue('alice', f.source());
  const peer = f.enqueue('bob'), peerClaim = f.claim('bob')!;
  f.request({ type: 'topic.compaction.fail', id: peerClaim.id, leaseToken: peerClaim.leaseToken!, error: 'PEER_LEGAL_ERROR', failureKind: 'processing', retryAfterMs: 1000 });
  const db = new (BetterSqlite3 as { new(file: string): CompanionConnection })(f.filename);
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  try {
    const peerBefore = JSON.stringify(db.prepare('SELECT * FROM companion_topic_compaction_jobs WHERE id=?').get(peer.id));
    const before = f.inspect(queued.id);
    const priorReceipts = JSON.stringify(db.prepare('SELECT * FROM companion_job_control_receipts WHERE owner_id=?').all('alice'));
    // A fresh exact claim now redacts the previous attempt's diagnostics
    // before replacing its bound inputs. Held attempts still retain them
    // until this explicit source withdrawal, which must clear both paths.
    if (held === 'running') expect(priorReceipts).not.toContain(secret);
    else expect(priorReceipts).toContain(secret);
    if (mutation === 'forget') f.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.scopes.alice!.conversationId, sourceMessageIds: [original.id] });
    else {
      // The product has no public raw-message editor. This is the same exact
      // host edit/enqueue boundary used by the existing source-version tests.
      db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('用户已明确更正为新的有效内容。', original.id);
      new CompanionMemoryStore(db, id => f.store.getMessage(id)).enqueueMessage(original.id);
    }
    const current = f.inspect(queued.id);
    expect(current).toMatchObject({ state: held === 'running' ? 'stale' : held, failureCount: 1 });
    expect(current.revision).toBeGreaterThan(before.revision); expect(current.lastError).toBeUndefined();
    expect(JSON.stringify(db.prepare('SELECT * FROM companion_topic_compaction_jobs WHERE id=?').get(queued.id))).not.toContain(secret);
    expect(JSON.stringify(db.prepare('SELECT * FROM companion_job_control_receipts WHERE owner_id=?').all('alice'))).not.toContain(secret);
    expect(f.request({ type: 'topic.compaction.check', id: queued.id, leaseToken: lateToken }).topicCompactionJob).toBeUndefined();
    f.request({ type: 'topic.compaction.fail', id: queued.id, leaseToken: lateToken, error: secret, failureKind: 'processing', retryAfterMs: 1000 });
    expect(f.inspect(queued.id)).toEqual(current);
    expect(JSON.stringify(db.prepare('SELECT * FROM companion_topic_compaction_jobs WHERE id=?').get(peer.id))).toBe(peerBefore);
    expect(f.store.getMessage(original.id)).toMatchObject({ id: original.id, revision: mutation === 'edit' ? 2 : 1 });
    if (mutation === 'forget') expect(f.store.getMessage(original.id).content).toBe(secret);
  } finally { db.close(); }
});

it('rejects the old summary atomically when its final publication races an exact park, resume and replacement lease', async () => {
  const f = fixture(), sources = Array.from({ length: 220 }, () => f.source()), originalBytes = f.originals(), queued = f.enqueue('alice', sources.at(-1)!);
  const config = { apiFormat: 'openai_chat' as const, model: 'controlled-topic-publication-race', apiKey: 'isolated-fixture', baseUrl: 'http://127.0.0.1/never-network' };
  const host = await canonicalInferenceHost(f.root, f.store, config), errors: unknown[] = [];
  let publicationRaced = false, replacementToken: string | undefined;
  const actor = new CompanionTopicCompactionService({ configFor: owner => host.configFor(owner), report: error => errors.push(error),
    request: async command => {
      if (command.type === 'topic.update' && command.compaction) {
        publicationRaced = true;
        expect(command.compaction.jobGuard).toMatchObject({ id: queued.id });
        const oldToken = command.compaction.jobGuard!.leaseToken, held = f.control(f.inspect(queued.id), 'park');
        f.control(held, 'resume'); const next = f.claim()!; replacementToken = next.leaseToken;
        expect(replacementToken).not.toBe(oldToken);
      }
      return host.request(command);
    }, fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages.find((message: { role: string }) => message.role === 'user').content);
      const value = data.purpose === 'topic_context_compaction' ? { summary: 'OLD_LEASE_MUST_NOT_PUBLISH', stage: '旧工作' }
        : data.purpose === 'topic_user_canon_extract' ? { additions: [], revisions: [] } : { supported: true, issues: [] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'content-type': 'application/json' } });
    } });
  try {
    expect(await actor.runOnce()).toBe(true); await actor.close();
    expect(publicationRaced).toBe(true); expect(errors).toEqual([]);
    expect(f.inspect(queued.id)).toMatchObject({ state: 'running', failureCount: 0, cycleFailureCount: 0, attemptCount: 2 });
    expect(f.request({ type: 'topic.compaction.check', id: queued.id, leaseToken: replacementToken! }).topicCompactionJob?.id).toBe(queued.id);
    const scope = f.scopes.alice!, state = f.request({ type: 'topic.read', readerId: 'alice', conversationId: scope.conversationId, topicId: scope.topicId }).topicState;
    expect(JSON.stringify(state)).not.toContain('OLD_LEASE_MUST_NOT_PUBLISH'); expect(state?.workingState).toBeUndefined();
    expect(f.originals()).toEqual(originalBytes);
  } finally { await actor.close(); await host.close(); }
}, 60000);

it('rejects an actual working-checkpoint conflict after the last check without charging it as a quality failure or losing source debt', async () => {
  const f = fixture(), sources = Array.from({ length: 220 }, () => f.source()), originalBytes = f.originals(), queued = f.enqueue('alice', sources.at(-1)!);
  const config = { apiFormat: 'openai_chat' as const, model: 'controlled-topic-working-cas', apiKey: 'isolated-fixture', baseUrl: 'http://127.0.0.1/never-network' };
  const host = await canonicalInferenceHost(f.root, f.store, config), errors: unknown[] = []; let raced = false;
  const actor = new CompanionTopicCompactionService({ configFor: owner => host.configFor(owner), report: error => errors.push(error),
    request: async command => {
      if (command.type === 'topic.update' && command.compaction) {
        raced = true; const scope = f.scopes.alice!, before = f.request({ type: 'topic.read', readerId: 'alice', conversationId: scope.conversationId, topicId: scope.topicId });
        f.request({ type: 'topic.update', readerId: 'alice', conversationId: scope.conversationId, topicId: scope.topicId, expectedRevision: before.topic!.revision,
          patch: { workingState: { summary: 'ACTUAL_NEWER_WORKING_CHECKPOINT', sourceMessageIds: [sources.at(-1)!.id], state: { currentStage: '已实际更新' } } } });
      }
      return host.request(command);
    }, fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages.find((message: { role: string }) => message.role === 'user').content);
      const value = data.purpose === 'topic_context_compaction' ? { summary: 'STALE_SUMMARY_MUST_NOT_REPLACE_NEW_CHECKPOINT', stage: '旧阶段' }
        : data.purpose === 'topic_user_canon_extract' ? { additions: [], revisions: [] } : { supported: true, issues: [] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'content-type': 'application/json' } });
    } });
  try {
    expect(await actor.runOnce()).toBe(true); await actor.close(); expect(raced).toBe(true); expect(errors).toEqual([]);
    expect(f.inspect(queued.id)).toMatchObject({ state: 'pending', failureCount: 0, cycleFailureCount: 0 });
    const scope = f.scopes.alice!, current = f.request({ type: 'topic.read', readerId: 'alice', conversationId: scope.conversationId, topicId: scope.topicId });
    expect(current.topicState?.workingState?.summary).toBe('ACTUAL_NEWER_WORKING_CHECKPOINT');
    expect(JSON.stringify(current.topicState)).not.toContain('STALE_SUMMARY_MUST_NOT_REPLACE_NEW_CHECKPOINT');
    expect(f.originals()).toEqual(originalBytes);
  } finally { await actor.close(); await host.close(); }
}, 60000);

it.each(['before_http', 'after_http'] as const)('distinguishes actual %s cancellation from a safe unissued retry without losing source debt', async boundary => {
  const f = fixture(), sources = Array.from({ length: 220 }, () => f.source()), originalBytes = f.originals(), queued = f.enqueue('alice', sources.at(-1)!);
  const config = { apiFormat: 'openai_chat' as const, model: 'controlled-topic-cancellation', apiKey: 'isolated-fixture', baseUrl: 'http://127.0.0.1/never-network' };
  const host = await canonicalInferenceHost(f.root, f.store, config), errors: unknown[] = [];
  let entered!: () => void, release!: () => void, fetches = 0;
  const reached = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const actor = new CompanionTopicCompactionService({ request: host.request, report: error => errors.push(error),
    configFor: async owner => { if (boundary === 'before_http') { entered(); await held; } return host.configFor(owner); },
    fetchFn: async (_url, init) => {
      fetches++; entered();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('Explicit owner stop after actual dispatch', 'AbortError'));
        if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    } });
  let running: Promise<boolean> | undefined;
  try {
    running = actor.runOnce();
    let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([reached, new Promise<never>((_resolve, reject) => { boundaryTimer = setTimeout(() => reject(new Error('Cancellation boundary was never reached')), 5000); boundaryTimer.unref(); })]); }
    finally { if (boundaryTimer) clearTimeout(boundaryTimer); }
    if (boundary === 'after_http') await vi.waitFor(async () => {
      const snapshots = await host.snapshots.list('alice', 20);
      expect(snapshots.items.some(snapshot => snapshot.status === 'dispatched')).toBe(true);
    }, { timeout: 5000 });
    actor.cancel('alice', queued.id); release(); await running; await actor.close();
    expect(errors).toEqual([]); expect(fetches).toBe(boundary === 'after_http' ? 1 : 0);
    expect(f.inspect(queued.id)).toMatchObject({ state: boundary === 'after_http' ? 'parked' : 'pending', failureCount: 0, cycleFailureCount: 0 });
    expect(f.originals()).toEqual(originalBytes);
    if (boundary === 'after_http') {
      f.enqueue('alice', f.source()); expect(f.claim()).toBeUndefined(); expect(fetches).toBe(1);
    }
  } finally { release(); actor.cancel('alice'); await running?.catch(() => undefined); await actor.close(); await host.close(); }
}, 60000);

it('withdraws a failure quote from an actually read earlier prefix source even when neither current nor claimed tail identifies it', () => {
  const f = fixture(), sources = Array.from({ length: 220 }, () => f.source()), oldest = sources[0]!, tail = sources.at(-1)!;
  const queued = f.enqueue('alice', tail), claimed = f.claim()!;
  const page = f.request({ type: 'topic.compaction.sources', readerId: 'alice', conversationId: f.scopes.alice!.conversationId, topicId: f.scopes.alice!.topicId,
    afterPublicationRevision: 0, throughPublicationRevision: claimed.claimedPublicationRevision,
    legacyAfterSequence: 0, beforeSequence: claimed.claimedThroughSequence! + 1,
    sourceMessageId: tail.id, sourceChecksum: createHash('sha256').update(tail.content).digest('hex'), limit: 100 }).topicCompactionPage!;
  expect(page.items.some(item => item.message.id === oldest.id)).toBe(true); expect(oldest.id).not.toBe(claimed.sourceMessageId);
  expect(f.request({ type: 'topic.compaction.bind', id: queued.id, leaseToken: claimed.leaseToken!, checkpointEventIds: [],
    sources: page.items.map(item => ({ id: item.message.id, revision: item.message.revision!, checksum: item.sourceChecksum })) }).topicCompactionJob?.id).toBe(queued.id);
  f.request({ type: 'topic.compaction.fail', id: queued.id, leaseToken: claimed.leaseToken!, failureKind: 'processing',
    error: oldest.content, retryAfterMs: 1000 });
  const held = f.control(f.inspect(queued.id), 'park'); expect(held.lastError).toBe(oldest.content);
  f.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.scopes.alice!.conversationId, sourceMessageIds: [oldest.id] });
  expect(f.inspect(queued.id)).toMatchObject({ state: 'parked', failureCount: 1 });
  expect(f.inspect(queued.id).lastError).toBeUndefined();
  expect(f.store.getMessage(oldest.id).content).toBe(oldest.content);
});

it('rejects a non-tail prefix withdrawal after its durable bind and before any canon or summary HTTP dispatch', async () => {
  const f = fixture(), sources = Array.from({ length: 220 }, () => f.source()), oldest = sources[0]!, before = f.originals();
  const queued = f.enqueue('alice', sources.at(-1)!);
  const config = { apiFormat: 'openai_chat' as const, model: 'controlled-prefix-dispatch', apiKey: 'isolated-fixture', baseUrl: 'http://127.0.0.1/never-network' };
  const host = await canonicalInferenceHost(f.root, f.store, config), errors: unknown[] = [];
  let bound = false, fetches = 0;
  const actor = new CompanionTopicCompactionService({ configFor: owner => host.configFor(owner), report: error => errors.push(error),
    request: async command => {
      const result = await host.request(command);
      if (command.type === 'topic.compaction.bind' && !bound) {
        expect(command.sources.some(source => source.id === oldest.id)).toBe(true);
        expect(result.topicCompactionJob?.id).toBe(queued.id); bound = true;
        f.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.scopes.alice!.conversationId, sourceMessageIds: [oldest.id] });
      }
      return result;
    }, fetchFn: async () => { fetches++; throw new Error('A withdrawn prefix must fail before every actual provider dispatch'); } });
  try {
    expect(await actor.runOnce()).toBe(true); await actor.close();
    expect(bound).toBe(true); expect(fetches).toBe(0); expect(errors).toEqual([]);
    expect(f.inspect(queued.id)).toMatchObject({ state: 'stale', failureCount: 0, cycleFailureCount: 0 });
    const scope = f.scopes.alice!, current = f.request({ type: 'topic.read', readerId: 'alice', conversationId: scope.conversationId, topicId: scope.topicId });
    expect(current.topicState?.workingState).toBeUndefined(); expect(f.originals()).toEqual(before);
  } finally { await actor.close(); await host.close(); }
}, 60000);

it('withdraws an ancestor known only through the real checkpoint DAG without revoking a peer shared-checkpoint permission', () => {
  const f = fixture(), room = f.store.createConversation('共同合法检查点的独立撤回', ['alice', 'bob']);
  let topic = f.request({ type: 'topic.create', conversationId: room.id, readerId: 'user', title: '真实继承来源', kind: 'discussion' }).topic!;
  for (const readerId of ['alice', 'bob']) topic = f.request({ type: 'topic.join', conversationId: room.id, topicId: topic.id, readerId }).topic!;
  const scope = { conversationId: room.id, topicId: topic.id };
  const source = (content: string) => f.store.appendMessage({ ...scope, authorId: 'user', content, replyDirective: 'none' });
  const ancestor = source('CHECKPOINT_ANCESTOR_SECRET_' + randomUUID()), next = source('真实后续块B'), tail = source('本次当前前缀C');
  const originalBytes = [ancestor, next, tail].map(message => [message.id, message.revision, message.content]);
  const shared = f.request({ type: 'topic.update', ...scope, readerId: 'user', expectedRevision: topic.revision,
    patch: { shared: { summary: ancestor.content, sourceMessageIds: [ancestor.id] } } }).topicState!.shared!;
  const queued = f.request({ type: 'topic.compaction.enqueue', ...scope, companionId: 'alice', sourceMessageId: tail.id }).topicCompactionJob!;
  const first = f.claim()!, digest = createHash('sha256').update(next.content).digest('hex');
  expect(f.request({ type: 'topic.compaction.bind', id: queued.id, leaseToken: first.leaseToken!, checkpointEventIds: [shared.sourceEventId],
    sources: [{ id: next.id, revision: next.revision!, checksum: digest }] }).topicCompactionJob?.id).toBe(queued.id);
  const current = f.request({ type: 'topic.read', ...scope, readerId: 'alice' });
  const child = f.request({ type: 'topic.update', ...scope, readerId: 'alice', expectedRevision: current.topic!.revision, maintenance: true,
    patch: { workingState: { summary: '只在本人与合法共享检查点之上继续B', sourceMessageIds: [next.id], state: { __continuity: {
      topicId: topic.id, companionId: 'alice', conversationId: room.id, throughSequence: next.sequence,
      sourceDigest: digest, compactedMessages: 1, createdAt: new Date().toISOString() } } } },
    compaction: { previousWorkingEventId: null, sharedEventId: shared.sourceEventId, sourceChecksums: { [next.id]: digest },
      jobGuard: { id: first.id, leaseToken: first.leaseToken! } } }).topicState!.workingState!;
  f.request({ type: 'topic.compaction.settle', id: first.id, leaseToken: first.leaseToken!, checkpointEventId: child.sourceEventId, hasMore: true });
  const second = f.claim()!, tailReference = { id: tail.id, revision: tail.revision!, checksum: createHash('sha256').update(tail.content).digest('hex') };
  expect(f.request({ type: 'topic.compaction.bind', id: second.id, leaseToken: second.leaseToken!, checkpointEventIds: [child.sourceEventId],
    sources: [tailReference] }).topicCompactionJob?.id).toBe(second.id);
  const peer = f.request({ type: 'topic.compaction.enqueue', ...scope, companionId: 'bob', sourceMessageId: tail.id }).topicCompactionJob!, peerClaim = f.claim('bob')!;
  expect(f.request({ type: 'topic.compaction.bind', id: peer.id, leaseToken: peerClaim.leaseToken!, checkpointEventIds: [shared.sourceEventId],
    sources: [tailReference] }).topicCompactionJob?.id).toBe(peer.id);
  f.request({ type: 'topic.compaction.fail', id: second.id, leaseToken: second.leaseToken!, failureKind: 'processing', error: ancestor.content, retryAfterMs: 1000 });
  f.control(f.inspect(second.id), 'park');
  const db = new (BetterSqlite3 as { new(file: string): CompanionConnection })(f.filename);
  try {
    const refs = db.prepare("SELECT input_kind,input_id FROM companion_job_input_refs WHERE owner_id='alice' AND kind='topic_compaction' AND job_id=?").all(second.id);
    expect(refs).toEqual(expect.arrayContaining([{ input_kind: 'source', input_id: tail.id }, { input_kind: 'topic_checkpoint', input_id: child.sourceEventId }]));
    expect(JSON.stringify(refs)).not.toContain(ancestor.id); expect(JSON.stringify(refs)).not.toContain(shared.sourceEventId);
    const peerBefore = JSON.stringify(db.prepare('SELECT * FROM companion_topic_compaction_jobs WHERE id=?').get(peer.id));
    f.request({ type: 'memory.forget', companionId: 'alice', conversationId: room.id, sourceMessageIds: [ancestor.id] });
    expect(f.inspect(second.id)).toMatchObject({ state: 'parked', failureCount: 1 }); expect(f.inspect(second.id).lastError).toBeUndefined();
    expect(JSON.stringify(db.prepare('SELECT * FROM companion_job_control_receipts WHERE owner_id=?').all('alice'))).not.toContain(ancestor.content);
    const blocked = db.prepare('SELECT event_id FROM companion_topic_checkpoint_owner_blocks WHERE owner_id=? ORDER BY event_id').all('alice');
    expect(blocked).toEqual([shared.sourceEventId, child.sourceEventId].sort().map(event_id => ({ event_id })));
    expect(db.prepare('SELECT 1 FROM companion_topic_checkpoint_owner_blocks WHERE owner_id=?').get('bob')).toBeUndefined();
    expect(f.request({ type: 'topic.compaction.check', id: peer.id, leaseToken: peerClaim.leaseToken! }).topicCompactionJob?.id).toBe(peer.id);
    expect(JSON.stringify(db.prepare('SELECT * FROM companion_topic_compaction_jobs WHERE id=?').get(peer.id))).toBe(peerBefore);
    f.control(f.inspect(second.id), 'resume'); const resumed = f.claim()!;
    expect(f.request({ type: 'topic.compaction.bind', id: resumed.id, leaseToken: resumed.leaseToken!, checkpointEventIds: [child.sourceEventId],
      sources: [tailReference] }).topicCompactionJob).toBeUndefined();
    expect([ancestor, next, tail].map(message => { const actual = f.store.getMessage(message.id); return [actual.id, actual.revision, actual.content]; })).toEqual(originalBytes);
  } finally { db.close(); }
});

it.each(['replacement_lease', 'source_withdrawal', 'owner_blocked'] as const)('rechecks the actual %s after durable request preparation and before fetch without washing a replacement lease', async boundary => {
  const f = fixture(), sources = Array.from({ length: 220 }, () => f.source()), before = f.originals(), queued = f.enqueue('alice', sources.at(-1)!);
  const config = { apiFormat: 'openai_chat' as const, model: 'controlled-final-topic-gate', apiKey: 'isolated-fixture', baseUrl: 'http://127.0.0.1/never-network' };
  const host = await canonicalInferenceHost(f.root, f.store, config), errors: unknown[] = [];
  let prepared = false, fetches = 0, blocked = false, replacementToken: string | undefined;
  const actor = new CompanionTopicCompactionService({ request: host.request, blocked: () => blocked, report: error => errors.push(error),
    configFor: async owner => {
      const current = await host.configFor(owner);
      return { ...current, transportObserver: { prepareAttempt: async input => {
        const attempt = await current.transportObserver!.prepareAttempt(input);
        expect((await host.snapshots.list('alice')).items[0]?.status).toBe('prepared'); prepared = true;
        if (boundary === 'replacement_lease') {
          const held = f.control(f.inspect(queued.id), 'park'); f.control(held, 'resume'); replacementToken = f.claim()!.leaseToken!;
        } else if (boundary === 'source_withdrawal') {
          f.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.scopes.alice!.conversationId, sourceMessageIds: [sources[0]!.id] });
        } else blocked = true;
        return attempt;
      } } };
    }, fetchFn: async () => { fetches++; throw new Error('A lost final source or lease must not dispatch'); } });
  try {
    expect(await actor.runOnce()).toBe(true); await actor.close();
    expect(prepared).toBe(true); expect(fetches).toBe(0); expect(errors).toEqual([]); expect(f.originals()).toEqual(before);
    expect(f.inspect(queued.id)).toMatchObject({ state: boundary === 'replacement_lease' ? 'running' : boundary === 'source_withdrawal' ? 'stale' : 'pending', failureCount: 0 });
    if (replacementToken) expect(f.request({ type: 'topic.compaction.check', id: queued.id, leaseToken: replacementToken }).topicCompactionJob?.id).toBe(queued.id);
    if (boundary !== 'source_withdrawal') expect((await host.snapshots.list('alice')).items[0]?.status).toBe('cancelled_before_send');
  } finally { await actor.close(); await host.close(); }
}, 60000);

it('keeps an actual dispatched unknown attempt held across restart and authorizes a fresh deterministic attempt only after explicit resume', async () => {
  const f = fixture(), sources = Array.from({ length: 220 }, () => f.source()), before = f.originals(), queued = f.enqueue('alice', sources.at(-1)!);
  const config = { apiFormat: 'openai_chat' as const, model: 'controlled-topic-unknown-resume', apiKey: 'isolated-fixture', baseUrl: 'http://127.0.0.1/never-network' };
  let host = await canonicalInferenceHost(f.root, f.store, config), oldToken: string | undefined, fetches = 0;
  const errors: unknown[] = [], observedInvocations: string[] = [];
  const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }), { headers: { 'content-type': 'application/json' } });
  const value = (purpose: string) => purpose === 'topic_context_compaction' ? { summary: '明确恢复的新尝试已正式整理这批原文。', stage: '继续尚未完成部分' }
    : purpose === 'topic_user_canon_extract' ? { additions: [], revisions: [] } : { supported: true, issues: [] };
  const first = new CompanionTopicCompactionService({ report: error => errors.push(error), request: async command => {
    const result = await host.request(command); if (command.type === 'topic.compaction.claim') oldToken = result.topicCompactionJob?.leaseToken; return result;
  }, configFor: async owner => {
    const current = await host.configFor(owner);
    return { ...current, transportObserver: { prepareAttempt: async input => {
      observedInvocations.push(input.frame.invocationId!);
      const actual: CompanionTransportAttempt = await current.transportObserver!.prepareAttempt(input);
      // The actual fetch and durable dispatched receipt have happened. A
      // missing completion write leaves an unknown result after real recovery.
      return { ...actual, complete: async () => { throw new Error('Simulated process loss before its durable completion receipt'); } };
    } } };
  }, fetchFn: async (_url, init) => { fetches++; const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages.find((message: { role: string }) => message.role === 'user').content); return response(value(data.purpose)); } });
  let second: CompanionTopicCompactionService | undefined;
  try {
    expect(await first.runOnce()).toBe(true); await first.close();
    expect(fetches).toBe(1); expect(f.inspect(queued.id)).toMatchObject({ state: 'parked', failureCount: 0, attemptCount: 1 });
    const old = (await host.snapshots.list('alice')).items[0]!; expect(old.status).toBe('dispatched');
    await host.snapshots.recoverOwner('alice'); expect((await host.snapshots.read('alice', old.id)).status).toBe('unknown');
    await host.close(); f.restart(); host = await canonicalInferenceHost(f.root, f.store, config);
    expect(f.claim()).toBeUndefined(); expect(fetches).toBe(1); expect(f.inspect(queued.id).attemptCount).toBe(1);
    f.control(f.inspect(queued.id), 'resume'); let firstNewOutput = true;
    second = new CompanionTopicCompactionService({ request: host.request, report: error => errors.push(error), configFor: async owner => {
      const current = await host.configFor(owner);
      const observe = (base: CompanionModelConfig): CompanionModelConfig => ({ ...base, transportObserver: { prepareAttempt: async input => {
        observedInvocations.push(input.frame.invocationId!); return base.transportObserver!.prepareAttempt(input);
      } }, ...(base.resolveStructuredRepairConfig ? { resolveStructuredRepairConfig: async () => observe(await base.resolveStructuredRepairConfig!()) } : {}) });
      return observe(current);
    }, fetchFn: async (_url, init) => {
      fetches++; const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages.find((message: { role: string }) => message.role === 'user').content);
      if (firstNewOutput) { firstNewOutput = false; return response('{"summary":'); }
      return response(value(data.structuredRepair?.originalPurpose ?? data.purpose));
    } });
    expect(await second.runOnce()).toBe(true); await second.close(); expect(errors).toEqual([]);
    expect(f.inspect(queued.id)).toMatchObject({ state: 'pending', failureCount: 0, attemptCount: 2 });
    const scope = f.scopes.alice!, current = f.request({ type: 'topic.read', readerId: 'alice', conversationId: scope.conversationId, topicId: scope.topicId });
    expect(current.topicState?.workingState?.summary).toContain('明确恢复的新尝试');
    const snapshots = await host.snapshots.list('alice', 20), repair = snapshots.items.find(snapshot => snapshot.purpose === 'companion_structured_repair');
    expect(repair?.structuredRepair?.rootInvocationId).toContain(`topic-compaction:${queued.id}:attempt:2:`);
    expect(repair?.invocationId).toBe('structured-repair:' + createHash('sha256').update(repair!.structuredRepair!.rootInvocationId).digest('hex') + ':1');
    expect(observedInvocations[0]).toContain(`topic-compaction:${queued.id}:attempt:1:`);
    expect(snapshots.items.find(snapshot => snapshot.id === old.id)?.status).toBe('unknown');
    const settled = f.inspect(queued.id);
    f.request({ type: 'topic.compaction.fail', id: queued.id, leaseToken: oldToken!, error: 'LATE_OLD_ATTEMPT', failureKind: 'processing', retryAfterMs: 1000 });
    expect(f.inspect(queued.id)).toEqual(settled); expect(f.originals()).toEqual(before);
  } finally { await first.close(); await second?.close(); await host.close(); }
}, 60000);

it.each(['non_tail', 'tail'] as const)('automatically rebuilds lawful remaining compaction debt after a %s withdrawal without a new enqueue or manual resume', async boundary => {
  const f = fixture(), sources = Array.from({ length: 220 }, () => f.source()), withdrawnSource = boundary === 'tail' ? sources.at(-1)! : sources[0]!, before = f.originals();
  const queued = f.enqueue('alice', sources.at(-1)!);
  const peer = f.enqueue('bob'), peerClaim = f.claim('bob')!;
  f.request({ type: 'topic.compaction.fail', id: peer.id, leaseToken: peerClaim.leaseToken!, failureKind: 'processing', error: 'PEER_LEGAL_DIAGNOSTIC', retryAfterMs: 1000 });
  f.control(f.inspect(peer.id, 'bob'), 'park');
  const db = new (BetterSqlite3 as { new(file: string): CompanionConnection })(f.filename);
  const peerBefore = JSON.stringify(db.prepare('SELECT * FROM companion_topic_compaction_jobs WHERE id=?').get(peer.id));
  const config = { apiFormat: 'openai_chat' as const, model: 'controlled-topic-reconciliation', apiKey: 'isolated-fixture', baseUrl: 'http://127.0.0.1/never-network' };
  const host = await canonicalInferenceHost(f.root, f.store, config), errors: unknown[] = [], laterCommands: string[] = [], wires: string[] = [], requestFailures: string[] = [];
  let withdrawn = false, oldFetches = 0, oldToken: string | undefined;
  const first = new CompanionTopicCompactionService({ report: error => errors.push(error), configFor: owner => host.configFor(owner),
    request: async command => {
      const result = await host.request(command);
      if (command.type === 'topic.compaction.claim') oldToken = result.topicCompactionJob?.leaseToken;
      if (command.type === 'topic.compaction.bind' && !withdrawn) {
        if (boundary === 'non_tail') expect(command.sources.some(source => source.id === withdrawnSource.id)).toBe(true);
        expect(result.topicCompactionJob?.id).toBe(queued.id);
        if (boundary === 'tail') expect(result.topicCompactionJob?.sourceMessageId).toBe(withdrawnSource.id);
        f.request({ type: 'memory.forget', companionId: 'alice', conversationId: f.scopes.alice!.conversationId, sourceMessageIds: [withdrawnSource.id] }); withdrawn = true;
      }
      return result;
    }, fetchFn: async () => { oldFetches++; throw new Error('The withdrawn old attempt must never reach HTTP'); } });
  const validRequest = async (command: CompanionStorageCommand) => {
    laterCommands.push(command.type);
    try { const result = await host.request(command); if (!result.ok) requestFailures.push(String(result.error)); return result; }
    catch (error) { requestFailures.push(String(error)); throw error; }
  };
  const validFetch: typeof fetch = async (_url, init) => {
    const raw = String(init?.body); wires.push(raw); expect(raw).not.toContain(withdrawnSource.content); expect(raw).not.toContain(withdrawnSource.id);
    const body = JSON.parse(raw), data = JSON.parse(body.messages.find((message: { role: string }) => message.role === 'user').content);
    const value = data.purpose === 'topic_context_compaction' ? { summary: '撤回之后，只总结仍然合法的剩余真实来源。', stage: '继续有效部分' }
      : data.purpose === 'topic_user_canon_extract' ? { additions: [], revisions: [] } : { supported: true, issues: [] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'content-type': 'application/json' } });
  };
  let continuation: CompanionTopicCompactionService | undefined, settlement: CompanionTopicCompactionService | undefined;
  try {
    expect(await first.runOnce()).toBe(true); await first.close(); expect(withdrawn).toBe(true); expect(oldFetches).toBe(0);
    expect(f.inspect(queued.id)).toMatchObject({ state: 'stale', failureCount: 0, cycleFailureCount: 0, attemptCount: 1 });
    continuation = new CompanionTopicCompactionService({ request: validRequest, configFor: owner => host.configFor(owner), fetchFn: validFetch, report: error => errors.push(error) });
    expect(await continuation.runOnce()).toBe(true); await continuation.close();
    expect(wires.length, JSON.stringify(requestFailures)).toBeGreaterThan(0);
    const scope = f.scopes.alice!, state = f.request({ type: 'topic.read', readerId: 'alice', conversationId: scope.conversationId, topicId: scope.topicId }).topicState;
    expect(state?.workingState?.summary).toContain('仍然合法'); expect(state?.workingState?.sourceMessageIds).not.toContain(withdrawnSource.id);
    expect(f.inspect(queued.id)).toMatchObject({ id: queued.id, state: 'pending', failureCount: 0, cycleFailureCount: 0, attemptCount: 2 });
    const newCheckpoint = state!.workingState!, settledFetches = wires.length;
    settlement = new CompanionTopicCompactionService({ request: validRequest, configFor: owner => host.configFor(owner), fetchFn: validFetch, report: error => errors.push(error) });
    expect(await settlement.runOnce()).toBe(true); await settlement.close();
    expect(wires).toHaveLength(settledFetches); expect(f.inspect(queued.id)).toMatchObject({ id: queued.id, state: 'completed', failureCount: 0, cycleFailureCount: 0, attemptCount: 3 });
    expect(laterCommands).not.toContain('topic.compaction.enqueue'); expect(laterCommands).not.toContain('jobs.control');
    const completed = f.inspect(queued.id);
    f.request({ type: 'topic.compaction.fail', id: queued.id, leaseToken: oldToken!, failureKind: 'processing', error: 'LATE_WITHDRAWN_ATTEMPT', retryAfterMs: 1000 });
    expect(f.inspect(queued.id)).toEqual(completed); expect(f.originals()).toEqual(before); expect(f.store.getMessage(withdrawnSource.id).content).toBe(withdrawnSource.content);
    expect(f.request({ type: 'topic.read', readerId: 'alice', conversationId: scope.conversationId, topicId: scope.topicId }).topicState?.workingState).toEqual(newCheckpoint);
    expect(JSON.stringify(db.prepare('SELECT * FROM companion_topic_compaction_jobs WHERE id=?').get(peer.id))).toBe(peerBefore);
    expect(errors).toEqual([]);
  } finally { await first.close(); await continuation?.close(); await settlement?.close(); await host.close(); db.close(); }
}, 60000);

it('keeps the source-page guard host-only and rejects an old lease without consuming or changing its replacement', () => {
  const f = fixture(), sources = Array.from({ length: 3 }, () => f.source()), tail = sources.at(-1)!, queued = f.enqueue('alice', tail), first = f.claim()!;
  const scope = f.scopes.alice!, page = { type: 'topic.compaction.sources' as const, readerId: 'alice', conversationId: scope.conversationId, topicId: scope.topicId,
    afterPublicationRevision: 0, throughPublicationRevision: first.claimedPublicationRevision!, legacyAfterSequence: 0,
    beforeSequence: first.claimedThroughSequence!, sourceMessageId: tail.id, sourceChecksum: createHash('sha256').update(tail.content).digest('hex'), limit: 100 };
  const oldGuard = { id: first.id, leaseToken: first.leaseToken! };
  expect(companionTopicArgumentsSchema.safeParse({ action: 'read', roomId: scope.conversationId, topicId: scope.topicId, jobGuard: oldGuard }).success).toBe(false);
  expect(f.request({ ...page, jobGuard: oldGuard }).topicCompactionPage?.items.map(item => item.message.id)).toEqual(sources.map(message => message.id));
  expect(() => f.request({ ...page, jobGuard: oldGuard, beforeSequence: page.beforeSequence + 1 })).toThrow();
  expect(() => f.request({ ...page, jobGuard: oldGuard, throughPublicationRevision: page.throughPublicationRevision + 1 })).toThrow();
  const held = f.control(f.inspect(queued.id), 'park'); f.control(held, 'resume'); const replacement = f.claim()!, before = f.inspect(queued.id);
  expect(replacement.leaseToken).not.toBe(first.leaseToken);
  expect(() => f.request({ ...page, jobGuard: oldGuard })).toThrow();
  f.request({ type: 'topic.compaction.fail', id: first.id, leaseToken: first.leaseToken!, error: 'OLD_SOURCE_PAGE_ATTEMPT', failureKind: 'processing', retryAfterMs: 1000 });
  expect(f.inspect(queued.id)).toEqual(before);
  expect(f.request({ ...page, jobGuard: { id: replacement.id, leaseToken: replacement.leaseToken! } }).topicCompactionPage?.items.map(item => item.message.id)).toEqual(sources.map(message => message.id));
  expect(f.inspect(queued.id)).toEqual(before);
});
