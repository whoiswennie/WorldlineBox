import { expect, it } from 'vitest';
import { CompanionModelQuota, companionModelConnection } from '../../src/main/companions/model-quota';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const work = (ownerId: string, priority: 'foreground' | 'background' = 'foreground', connectionId = 'provider') => ({ ownerId, connectionId, priority });

it('keeps a provider permit until the response operation really settles even after caller cancellation', async () => {
  const quota = new CompanionModelQuota({ active: 1, connection: 1, background: 1, foregroundBurst: 2 });
  const finish = deferred(), controller = new AbortController(), started: string[] = [];
  const first = quota.run(work('alice'), async () => { started.push('alice'); await finish.promise; }, controller.signal);
  await flush(); controller.abort();
  const second = quota.run(work('bob'), async () => { started.push('bob'); });
  await flush(); expect(started).toEqual(['alice']); expect(quota.snapshot().active).toBe(1);
  finish.resolve(); await Promise.all([first, second]); expect(started).toEqual(['alice', 'bob']);
  await flush(); expect(quota.snapshot()).toMatchObject({ active: 0, queued: 0, completed: 2 });
});

it('gives a waiting maintenance request service during continuous foreground demand', async () => {
  const quota = new CompanionModelQuota({ active: 1, connection: 1, background: 1, foregroundBurst: 2 });
  const order: string[] = [], jobs: Promise<void>[] = [];
  for (let index = 0; index < 8; index++) jobs.push(quota.run(work('chat'), async () => { order.push('f' + index); }));
  jobs.push(quota.run(work('learner', 'background'), async () => { order.push('maintenance'); }));
  await Promise.all(jobs); expect(order.indexOf('maintenance')).toBe(2); expect(order).toHaveLength(9);
});

it('shares a connection ceiling across owners without blocking an independent provider', async () => {
  const quota = new CompanionModelQuota({ active: 3, connection: 1, background: 2, foregroundBurst: 2 });
  const finish = deferred(), started: string[] = [];
  const first = quota.run(work('alice'), async () => { started.push('alice'); await finish.promise; });
  const second = quota.run(work('bob'), async () => { started.push('bob'); });
  const third = quota.run(work('carol', 'foreground', 'other'), async () => { started.push('carol'); });
  await flush(); expect(started).toEqual(['alice', 'carol']);
  finish.resolve(); await Promise.all([first, second, third]); expect(started).toEqual(['alice', 'carol', 'bob']);
});

it('runs at most one background model operation per owner and rotates independent owners', async () => {
  const quota = new CompanionModelQuota({ active: 3, connection: 3, background: 2, foregroundBurst: 2 });
  const finish = deferred(), started: string[] = [];
  const first = quota.run(work('alice', 'background'), async () => { started.push('a1'); await finish.promise; });
  const second = quota.run(work('alice', 'background'), async () => { started.push('a2'); });
  const third = quota.run(work('bob', 'background'), async () => { started.push('b'); });
  await flush(); expect(started).toEqual(['a1', 'b']);
  finish.resolve(); await Promise.all([first, second, third]); expect(started).toEqual(['a1', 'b', 'a2']);
});

it('removes cancelled queued work without making a provider request', async () => {
  const quota = new CompanionModelQuota({ active: 1, connection: 1, background: 1, foregroundBurst: 2 });
  const finish = deferred(), controller = new AbortController(); let invoked = false;
  const first = quota.run(work('alice'), () => finish.promise); await flush();
  const second = quota.run(work('bob'), async () => { invoked = true; }, controller.signal);
  const rejected = expect(second).rejects.toThrow('cancelled'); controller.abort(new Error('cancelled')); await rejected;
  finish.resolve(); await first; expect(invoked).toBe(false); await flush(); expect(quota.snapshot().queued).toBe(0);
});

it('bounds waiting memory globally, per connection and per owner without starting rejected operations', async () => {
  const quota = new CompanionModelQuota({ active: 1, connection: 1, background: 1, foregroundBurst: 2,
    pending: 3, pendingPerConnection: 2, pendingPerOwner: 1 });
  const hold = deferred(), order: string[] = [], controller = new AbortController();
  const first = quota.run(work('running'), () => hold.promise); await flush();
  const alice = quota.run(work('alice'), async () => { order.push('alice'); }, controller.signal);
  await expect(quota.run(work('alice'), async () => { throw Error('Rejected owner must never execute.'); }))
    .rejects.toMatchObject({ reason: 'owner_full', code: 'RATE_LIMIT' });
  const bob = quota.run(work('bob'), async () => { order.push('bob'); });
  await expect(quota.run(work('cara'), async () => { throw Error('Rejected connection must never execute.'); }))
    .rejects.toMatchObject({ reason: 'connection_full' });
  const dora = quota.run(work('dora', 'foreground', 'independent'), async () => { order.push('dora'); });
  await expect(quota.run(work('erin', 'foreground', 'another'), async () => { throw Error('Rejected global queue must never execute.'); }))
    .rejects.toMatchObject({ reason: 'queue_full' });
  expect(quota.snapshot().queued).toBe(3);
  const cancelled = expect(alice).rejects.toThrow('cancelled'); controller.abort(new Error('cancelled')); await cancelled;
  const replacement = quota.run(work('erin', 'foreground', 'another'), async () => { order.push('erin'); });
  hold.resolve(); await Promise.all([first, bob, dora, replacement]);
  expect(order).toEqual(['bob', 'dora', 'erin']);
  await flush(); expect(quota.snapshot()).toMatchObject({ active: 0, queued: 0 });
});

it('serves every queued owner before returning to heavily queued residents', async () => {
  const quota = new CompanionModelQuota({ active: 1, connection: 1, background: 1, foregroundBurst: 8 });
  const order: string[] = [], jobs: Promise<void>[] = [];
  for (const owner of ['alice', 'alice', 'alice', 'bob', 'bob', 'bob', 'carol', 'dora']) {
    jobs.push(quota.run(work(owner), async () => { order.push(owner); }));
  }
  await Promise.all(jobs);
  expect(order.slice(0, 4)).toEqual(['alice', 'bob', 'carol', 'dora']);
});

it('keeps connection identities opaque and shares one credential across model names', () => {
  const config = { apiFormat: 'openai_chat', baseUrl: 'https://provider.example/v1', apiKey: 'PRIVATE_TEST_KEY' };
  const identity = companionModelConnection(config); expect(identity).toMatch(/^[a-f0-9]{64}$/u);
  expect(identity).not.toContain(config.apiKey); expect(companionModelConnection({ ...config })).toBe(identity);
  expect(companionModelConnection({ ...config, apiKey: 'another' })).not.toBe(identity);
});

it('keeps the strictest live connection policy until its owning resource manager releases it', async () => {
  const quota = new CompanionModelQuota({ active: 2, connection: 2, background: 2, foregroundBurst: 2 });
  quota.configureConnection('provider', 1, 'first-library'); quota.configureConnection('provider', 2, 'second-library');
  const hold = deferred(), started: string[] = [];
  const a = quota.run(work('alice'), async () => { started.push('alice'); await hold.promise; });
  const b = quota.run(work('bob'), async () => { started.push('bob'); await hold.promise; });
  await flush(); expect(started).toEqual(['alice']);
  quota.releaseConnectionPolicy('provider', 'second-library'); await flush(); expect(started).toEqual(['alice']);
  quota.releaseConnectionPolicy('provider', 'first-library'); await flush(); expect(started).toEqual(['alice', 'bob']);
  hold.resolve(); await Promise.all([a, b]);
});
