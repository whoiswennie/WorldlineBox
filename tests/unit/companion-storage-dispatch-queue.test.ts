import { expect, it } from 'vitest';
import { CompanionStorageDispatchQueue, companionStorageDispatchPolicy, companionStorageReorderableQuery, companionStorageSettlement } from '../../src/main/companions/storage-dispatch-queue';
import { companionStorageSchedulingContext, currentCompanionStorageOperation, currentCompanionStorageOperationHash, withCompanionStorageBackgroundPoll, withCompanionStorageBarrier, withCompanionStorageOperation } from '../../src/main/companions/storage-operation-context';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

const entry = (id: string, priority: 'interactive' | 'background' | 'control', lane = id, barrier = false, settlement = false) => ({ id, priority, lane,
  policy: { kind: barrier ? 'writeBarrier' as const : 'pureQuery' as const, pipelineable: !barrier }, settlement, value: id });
it('serves eight interactive queries then one waiting background query', () => {
  const queue = new CompanionStorageDispatchQueue<string>();
  for (let n = 0; n < 3; n++) queue.enqueue(entry('b' + n, 'background'));
  for (let n = 0; n < 18; n++) queue.enqueue(entry('i' + n, 'interactive'));
  const order: string[] = [];
  while (queue.size) { const work = queue.take()!; order.push(work.id); queue.settle(work.id); }
  expect(order.slice(0, 18)).toEqual([...Array.from({ length: 8 }, (_, n) => 'i' + n), 'b0', ...Array.from({ length: 8 }, (_, n) => 'i' + (n + 8)), 'b1']);
});
it('keeps lane FIFO even for nested control and never crosses an earlier create or final-read barrier', () => {
  const queue = new CompanionStorageDispatchQueue<string>();
  queue.enqueue(entry('bg-parent', 'background', 'same'));
  queue.enqueue(entry('nested-control', 'control', 'same'));
  queue.enqueue(entry('independent-control', 'control'));
  queue.enqueue(entry('action.create', 'background', 'task', true));
  queue.enqueue(entry('action.cancel', 'control', 'task', true));
  queue.enqueue(entry('final', 'background', 'final-lane', true));
  queue.enqueue(entry('late-interactive', 'interactive'));
  const order: string[] = [];
  while (queue.size) { const work = queue.take()!; order.push(work.id); queue.settle(work.id); }
  expect(order).toEqual(['independent-control', 'bg-parent', 'nested-control', 'action.create', 'action.cancel', 'final', 'late-interactive']);
});
it('reserves bounded control and terminal settlement capacity and permanently removes unposted work', () => {
  const queue = new CompanionStorageDispatchQueue<string>(1, 1, 1);
  expect(queue.enqueue(entry('ordinary', 'background'))).toBe(true);
  expect(queue.enqueue(entry('excess', 'interactive'))).toBe(false);
  expect(queue.enqueue(entry('control', 'control'))).toBe(true);
  expect(queue.enqueue(entry('excess-control', 'control'))).toBe(false);
  expect(queue.enqueue(entry('settlement', 'background', 'paid', true, true))).toBe(true);
  expect(queue.enqueue(entry('overflow-settlement', 'control', 'other', true, true))).toBe(false);
  expect(queue.remove('ordinary')).toBe(true);
  expect(queue.take()?.id).toBe('control'); queue.settle('control');
  expect(queue.take()?.id).toBe('settlement'); queue.settle('settlement'); expect(queue.take()).toBeUndefined();
});
it('uses an explicit query whitelist and never treats ordinary progress saves or unknown/writes as reserved query work', () => {
  expect(companionStorageReorderableQuery({ type: 'message.get', id: 'source' })).toBe(true);
  expect(companionStorageReorderableQuery({ type: 'messages', conversationId: 'room', topicId: null })).toBe(false);
  expect(companionStorageReorderableQuery({ type: 'messages', conversationId: 'room', topicId: 'existing_topic' })).toBe(true);
  expect(companionStorageReorderableQuery({ type: 'action.update', id: 'action', patch: { status: 'cancelled' } })).toBe(false);
  const progress = { type: 'loop.save' as const, checkpoint: { status: 'running' } } as Parameters<typeof companionStorageSettlement>[0];
  expect(companionStorageReorderableQuery(progress)).toBe(false); expect(companionStorageSettlement(progress)).toBe(false);
  expect(companionStorageSettlement({ ...progress, checkpoint: { status: 'done' } } as Parameters<typeof companionStorageSettlement>[0])).toBe(true);
  for (const type of ['memory.jobs.proposal.save', 'world.job.proposal.save'] as const) {
    const paid = { type } as Parameters<typeof companionStorageSettlement>[0];
    expect(companionStorageSettlement(paid)).toBe(true); expect(companionStorageReorderableQuery(paid)).toBe(false);
  }
});

it('classifies only verified predicate projections as strict reads, preserving explicit final fences', () => {
  const commands = [{ type: 'memory.snapshot' as const, companionId: 'alice', conversationId: 'room' },
    { type: 'social.notifications.receipts' as const, companionId: 'alice', conversationId: 'room', messageIds: ['notice'] },
    { type: 'memory.snapshot.revisions' as const, scopes: [{ companionId: 'alice', conversationId: 'room' },
      { companionId: 'bob', conversationId: 'other_room', beforeSequence: 100, publishedOnly: true }] },
    { type: 'memory.procedures.status' as const, companionId: 'alice', conversationId: 'room', references: [{ id: 'method', contentRevision: 1 }] },
    { type: 'memory.sources.headers' as const, companionId: 'alice', conversationId: 'room', beforeSequence: 100, ids: ['source'] },
    { type: 'memory.references.validate' as const, groups: [{ companionId: 'alice', conversationId: 'room', sources: [], memories: [] }] },
    { type: 'topic.compaction.sources' as const, conversationId: 'room', topicId: 'topic', readerId: 'alice',
      afterPublicationRevision: 0, legacyAfterSequence: 0, beforeSequence: 100 }];
  for (const command of commands) {
    expect(companionStorageDispatchPolicy(command)).toEqual({ kind: 'pureQuery', pipelineable: true });
    expect(companionStorageDispatchPolicy(command, { lane: 'final', priority: 'interactive', barrier: true })).toEqual({ kind: 'readFence', pipelineable: true });
  }
  expect(companionStorageDispatchPolicy({ type: 'topic.list', readerId: 'alice', conversationId: 'room' }).kind).toBe('writeBarrier');
});
it('keeps the exact page authority bundle equivalent to its four original query readers and fences its final packet', () => {
  const commands: CompanionStorageCommand[] = [
    { type: 'memory.library.read-many', companionId: 'alice', ids: ['note'] },
    { type: 'memory.snapshot.revisions', scopes: [{ companionId: 'alice', conversationId: 'room', beforeSequence: 5, contentKinds: ['episode_memory'], publishedOnly: true }] },
    { type: 'memory.revisions.describe', companionId: 'alice', conversationId: 'room', roots: [{ id: 'note', contentRevision: 1 }] },
    { type: 'memory.sources.headers', companionId: 'alice', conversationId: 'room', ids: ['source'] },
    { type: 'memory.documents.authority', companionId: 'alice', noteIds: ['note'],
      navigation: [{ scope: { companionId: 'alice', conversationId: 'room', beforeSequence: 5, contentKinds: ['episode_memory'], publishedOnly: true }, expectedRevision: 'semantic' }],
      history: { conversationId: 'room', roots: [{ id: 'note', contentRevision: 1 }] }, sources: { conversationId: 'room', ids: ['source'] } },
  ];
  for (const command of commands) {
    expect(companionStorageDispatchPolicy(command)).toEqual({ kind: 'pureQuery', pipelineable: true });
    expect(companionStorageDispatchPolicy(command, { lane: 'page-final', priority: 'interactive', barrier: true })).toEqual({ kind: 'readFence', pipelineable: true });
  }
  const unknown = { type: 'memory.documents.authority.unreviewed' } as unknown as CompanionStorageCommand;
  expect(companionStorageDispatchPolicy(unknown)).toEqual({ kind: 'writeBarrier', pipelineable: false });
  expect(companionStorageDispatchPolicy(unknown, { lane: 'page-final', priority: 'interactive', barrier: true })).toEqual({ kind: 'writeBarrier', pipelineable: false });
});
it('isolates independent async operation lanes while preserving a same-lane control final barrier', async () => {
  expect(currentCompanionStorageOperation()).toBeUndefined();
  await withCompanionStorageOperation({ priority: 'interactive', lane: 'parent' }, async () => {
    await withCompanionStorageBarrier(async () => {
      await Promise.resolve(); expect(companionStorageSchedulingContext()).toEqual({ lane: 'parent', priority: 'interactive', barrier: true });
      withCompanionStorageOperation({ priority: 'control', lane: currentCompanionStorageOperation()!.lane }, () => {
        expect(companionStorageSchedulingContext()).toEqual({ lane: 'parent', priority: 'control', barrier: true });
      });
      await withCompanionStorageOperation({ priority: 'background' }, async () => {
        await Promise.resolve(); const current = companionStorageSchedulingContext();
        expect(current.priority).toBe('background'); expect(current.lane).not.toBe('parent'); expect(current.barrier).toBeUndefined();
      });
      expect(companionStorageSchedulingContext().barrier).toBe(true);
    });
    expect(companionStorageSchedulingContext()).toEqual({ lane: 'parent', priority: 'interactive' });
  });
  expect(currentCompanionStorageOperation()).toBeUndefined();
});

it('allows only explicitly marked background clock/lease polls to yield, never same-named paid or final checks', async () => {
  const check = { type: 'world.job.check' as const, id: 'job', leaseToken: 'lease' }, context = { lane: 'poll', priority: 'background' as const, backgroundPoll: true };
  expect(companionStorageReorderableQuery(check)).toBe(false);
  expect(companionStorageReorderableQuery(check, context)).toBe(true);
  expect(companionStorageReorderableQuery({ type: 'world.tick' }, context)).toBe(true);
  expect(companionStorageReorderableQuery(check, { ...context, priority: 'interactive' })).toBe(false);
  expect(companionStorageReorderableQuery(check, { ...context, barrier: true })).toBe(false);
  const poll = { type: 'world.job.poll' as const, companionId: 'alice', id: 'job', leaseToken: 'lease' };
  expect(companionStorageDispatchPolicy(poll)).toEqual({ kind: 'writeBarrier', pipelineable: false });
  expect(companionStorageDispatchPolicy(poll, context)).toEqual({ kind: 'pureQuery', pipelineable: false });
  expect(companionStorageDispatchPolicy(poll, { ...context, barrier: true })).toEqual({ kind: 'writeBarrier', pipelineable: false });
  const queue = new CompanionStorageDispatchQueue<string>();
  queue.enqueue({ ...entry('poll', 'background', 'poll'), policy: companionStorageDispatchPolicy(check, context) });
  queue.enqueue(entry('foreground', 'interactive'));
  expect(queue.take()?.id).toBe('foreground'); queue.settle('foreground'); expect(queue.take()?.id).toBe('poll');
  await withCompanionStorageOperation({ priority: 'background', lane: 'parent' }, async () => {
    await withCompanionStorageBackgroundPoll(async () => {
      expect(companionStorageSchedulingContext().backgroundPoll).toBe(true);
      await withCompanionStorageOperation({ priority: 'background' }, async () => {
        await Promise.resolve(); expect(companionStorageSchedulingContext().backgroundPoll).toBeUndefined();
      });
      withCompanionStorageBarrier(() => expect(companionStorageReorderableQuery(check, companionStorageSchedulingContext())).toBe(false));
    });
    expect(companionStorageSchedulingContext().backgroundPoll).toBeUndefined();
    expect(companionStorageReorderableQuery(check, companionStorageSchedulingContext())).toBe(false);
  });
});

it('lets a final strict read fence pass independent background queries while preserving writes and lane post order', () => {
  const fence = companionStorageDispatchPolicy({ type: 'message.get', id: 'source' }, { lane: 'final', priority: 'interactive', barrier: true });
  expect(fence).toEqual({ kind: 'readFence', pipelineable: true });
  const queue = new CompanionStorageDispatchQueue<string>();
  queue.enqueue(entry('old-background', 'background'));
  queue.enqueue({ ...entry('final', 'interactive'), policy: fence });
  queue.enqueue(entry('write', 'background', 'writer', true));
  queue.enqueue(entry('later', 'control'));
  expect(queue.take()?.id).toBe('final'); expect(queue.take()?.id).toBe('old-background'); expect(queue.take()).toBeUndefined();
  queue.settle('final'); expect(queue.take()).toBeUndefined();
  queue.settle('old-background'); expect(queue.take()?.id).toBe('write'); expect(queue.take()).toBeUndefined();
  queue.settle('write'); expect(queue.take()?.id).toBe('later');
  const lane = new CompanionStorageDispatchQueue<string>();
  lane.enqueue(entry('prior-same-lane', 'background', 'same'));
  lane.enqueue({ ...entry('same-lane-final', 'interactive', 'same'), policy: fence });
  expect(lane.take()?.id).toBe('prior-same-lane'); expect(lane.take()?.id).toBe('same-lane-final');
  const beforeWrite = new CompanionStorageDispatchQueue<string>();
  beforeWrite.enqueue(entry('earlier-write', 'background', 'writer', true));
  beforeWrite.enqueue({ ...entry('final', 'control'), policy: fence });
  expect(beforeWrite.take()?.id).toBe('earlier-write'); expect(beforeWrite.take()).toBeUndefined();
});

it('posts at most two strict queries, at most one background query, and reserves the other credit for foreground', () => {
  const queue = new CompanionStorageDispatchQueue<string>();
  queue.enqueue(entry('bg1', 'background')); queue.enqueue(entry('bg2', 'background')); queue.enqueue(entry('fg1', 'interactive'));
  expect(queue.take()?.id).toBe('fg1'); expect(queue.take()?.id).toBe('bg1'); expect(queue.take()).toBeUndefined();
  queue.settle('fg1'); expect(queue.take()).toBeUndefined();
  queue.enqueue(entry('fg2', 'control')); expect(queue.take()?.id).toBe('fg2'); expect(queue.take()).toBeUndefined();
});

it('keeps reorderable mutating background polls exclusive in both directions and drains for their fair turn', () => {
  const policy = companionStorageDispatchPolicy({ type: 'world.tick' }, { lane: 'poll', priority: 'background', backgroundPoll: true });
  expect(policy).toEqual({ kind: 'pureQuery', pipelineable: false });
  const queue = new CompanionStorageDispatchQueue<string>();
  queue.enqueue({ ...entry('poll', 'background'), policy }); expect(queue.take()?.id).toBe('poll');
  queue.enqueue(entry('fg', 'interactive')); expect(queue.take()).toBeUndefined();
  queue.settle('poll'); expect(queue.take()?.id).toBe('fg');
  queue.enqueue({ ...entry('poll2', 'background'), policy }); expect(queue.take()).toBeUndefined();
  queue.settle('fg'); expect(queue.take()?.id).toBe('poll2');
});

it('lets the first foreground writer pass independent queued ordinary reads, while later reads and writers stay behind it', () => {
  const queue = new CompanionStorageDispatchQueue<string>();
  queue.enqueue(entry('old-query-a', 'background')); queue.enqueue(entry('old-query-b', 'background'));
  queue.enqueue(entry('first-write', 'interactive', 'writer', true));
  queue.enqueue(entry('late-control-read', 'control')); queue.enqueue(entry('later-control-write', 'control', 'later-writer', true));
  expect(queue.take()?.id).toBe('first-write'); expect(queue.take()).toBeUndefined();
  queue.settle('first-write'); expect(queue.take()?.id).toBe('late-control-read');
  expect(queue.take()).toBeUndefined(); queue.settle('late-control-read');
  expect(queue.take()?.id).toBe('later-control-write');
});

it.each(['same-lane', 'read-fence', 'mutating-poll'] as const)('never advances a writer across an earlier %s', kind => {
  const queue = new CompanionStorageDispatchQueue<string>();
  const prior = entry('prior', 'background', kind === 'same-lane' ? 'writer' : 'reader');
  queue.enqueue(kind === 'read-fence' ? { ...prior, policy: { kind: 'readFence', pipelineable: true } }
    : kind === 'mutating-poll' ? { ...prior, policy: { kind: 'pureQuery', pipelineable: false } } : prior);
  queue.enqueue(entry('write', 'control', 'writer', true));
  expect(queue.take()?.id).toBe('prior'); expect(queue.take()).toBeUndefined();
  queue.settle('prior'); expect(queue.take()?.id).toBe('write');
});

it('drains both actual posted credits before an eligible writer, then keeps that write exclusive', () => {
  const queue = new CompanionStorageDispatchQueue<string>();
  queue.enqueue(entry('posted-background', 'background')); expect(queue.take()?.id).toBe('posted-background');
  queue.enqueue(entry('posted-interactive', 'interactive')); expect(queue.take()?.id).toBe('posted-interactive');
  queue.enqueue(entry('unposted-query', 'background')); queue.enqueue(entry('write', 'control', 'writer', true));
  expect(queue.take()).toBeUndefined(); queue.settle('posted-background'); expect(queue.take()).toBeUndefined();
  queue.settle('posted-interactive'); expect(queue.take()?.id).toBe('write');
  queue.enqueue(entry('late-query', 'interactive')); expect(queue.take()).toBeUndefined();
  queue.settle('write'); expect(queue.take()?.id).toBe('late-query');
});

it('isolates hashed operation identity across nested async lanes without exposing the private lane', async () => {
  expect(currentCompanionStorageOperationHash()).toBeUndefined();
  const hashes = await withCompanionStorageOperation({ priority: 'interactive', lane: 'PRIVATE_PARENT_LANE' }, async () => {
    const parent = currentCompanionStorageOperationHash(); await Promise.resolve();
    expect(currentCompanionStorageOperationHash()).toBe(parent);
    const sameLane = withCompanionStorageOperation({ priority: 'control', lane: currentCompanionStorageOperation()!.lane }, currentCompanionStorageOperationHash);
    const child = await withCompanionStorageOperation({ priority: 'background' }, async () => { await Promise.resolve(); return currentCompanionStorageOperationHash(); });
    expect(sameLane).toBe(parent); expect(child).not.toBe(parent); expect(currentCompanionStorageOperationHash()).toBe(parent);
    return { parent, child };
  });
  expect(hashes.parent).toMatch(/^[a-f0-9]{64}$/u); expect(hashes.child).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(hashes)).not.toContain('PRIVATE_PARENT_LANE'); expect(currentCompanionStorageOperationHash()).toBeUndefined();
});

it('holds optional background service at zero credit while serving independent foreground work', () => {
  const queue = new CompanionStorageDispatchQueue<string>();
  queue.enqueue(entry('optional', 'background')); expect(queue.take(false)).toBeUndefined();
  queue.enqueue(entry('foreground', 'interactive')); expect(queue.take(false)?.id).toBe('foreground');
  expect(queue.take(false)).toBeUndefined(); queue.settle('foreground');
  expect(queue.take(false)).toBeUndefined(); expect(queue.take(true)?.id).toBe('optional');
});

it.each(['same-lane', 'earlier-write', 'earlier-fence', 'paid-settlement'] as const)('lets a necessary %s borrow service credit without relaxing its order', kind => {
  const queue = new CompanionStorageDispatchQueue<string>();
  const prior = entry('prerequisite', 'background', kind === 'same-lane' ? 'task' : 'prerequisite', kind === 'earlier-write', kind === 'paid-settlement');
  queue.enqueue(kind === 'earlier-fence' ? { ...prior, policy: { kind: 'readFence', pipelineable: true } } : prior);
  if (kind !== 'paid-settlement') queue.enqueue(entry('foreground', 'control', 'task', kind === 'earlier-fence'));
  expect(queue.take(false)?.id).toBe('prerequisite');
  if (kind === 'earlier-write' || kind === 'earlier-fence') expect(queue.take(false)).toBeUndefined();
  queue.settle('prerequisite');
  if (kind !== 'paid-settlement') expect(queue.take(false)?.id).toBe('foreground');
});

it.each(['interactive', 'background'] as const)('does not lend credit to skippable old pure reads ahead of a runnable %s writer after eight interactive turns', priority => {
  const queue = new CompanionStorageDispatchQueue<string>();
  for (let index = 0; index < 8; index++) { queue.enqueue(entry('served-' + index, 'interactive')); const next = queue.take(false)!; queue.settle(next.id); }
  queue.enqueue(entry('optional-a', 'background')); queue.enqueue(entry('optional-b', 'background'));
  queue.enqueue(entry('writer', priority, 'writer', true));
  if (priority === 'background') queue.enqueue(entry('blocked-foreground', 'interactive'));
  expect(queue.take(false)?.id).toBe('writer'); expect(queue.take(false)).toBeUndefined(); queue.settle('writer');
  if (priority === 'background') { expect(queue.take(false)?.id).toBe('blocked-foreground'); queue.settle('blocked-foreground'); }
  expect(queue.take(false)).toBeUndefined();
});

it.each(['read-fence', 'mutating-poll', 'same-writer-lane'] as const)('lends only to the true %s frontier and its lane predecessor, skipping unrelated pure reads', kind => {
  const queue = new CompanionStorageDispatchQueue<string>();
  queue.enqueue(entry('optional', 'background'));
  const lane = kind === 'same-writer-lane' ? 'writer' : 'blocker';
  queue.enqueue(entry('lane-predecessor', 'background', lane));
  const blocker = entry('blocker', 'background', lane);
  queue.enqueue(kind === 'read-fence' ? { ...blocker, policy: { kind: 'readFence', pipelineable: true } }
    : kind === 'mutating-poll' ? { ...blocker, policy: { kind: 'pureQuery', pipelineable: false } } : blocker);
  queue.enqueue(entry('writer', 'interactive', 'writer', true));
  expect(queue.take(false)?.id).toBe('lane-predecessor'); queue.settle('lane-predecessor');
  expect(queue.take(false)?.id).toBe('blocker'); expect(queue.take(false)).toBeUndefined(); queue.settle('blocker');
  expect(queue.take(false)?.id).toBe('writer'); queue.settle('writer'); expect(queue.take(false)).toBeUndefined();
});
