import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { companionExecutionSourceReadOnly, companionExecutionSourceReferences, guardCompanionExecutionSources, memoCompanionExecutionValidation,
  withCompanionExecutionValidation, type CompanionExecutionSourceProof } from '../../src/main/companions/source-execution-evidence';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const scope = { companionId: 'alice', conversationId: 'room_one' };
const message = (id: string): CompanionMessage => ({ id, conversationId: scope.conversationId, authorId: 'alice', content: 'ACTUAL_PRIVATE_BYTES', kind: 'text', status: 'sent',
  sequence: 1, createdAt: '2026-10-23T00:00:00.000Z', attachments: [] });
const proof = (id: string): CompanionExecutionSourceProof => ({ kind: 'message', id, ...scope, sourceMessageIds: [id], executionReadset: captureCompanionExecutionReadset(scope) });

it('does not invalidate source proofs for pure status reads or disposable catalogue maintenance', () => {
  for (const type of ['memory.tags.status', 'memory.processing.status', 'memory.policy.list', 'memory.library.index-state', 'memory.outbox.pending',
    'actions.page', 'document.catalog.query', 'document.catalog.touch', 'document.catalog.put', 'document.catalog.drop', 'document.catalog.finish', 'world.clock.peek',
    'routine.get', 'schedule.list', 'schedule.get', 'activity.list', 'social.reply.progress', 'social.days', 'social.graph',
    'memory.revision.read', 'memory.revision.describe', 'memory.history.outbox.check', 'memory.history.outbox.owners',
    'memory.history.outbox.claim', 'memory.history.outbox.complete', 'memory.history.outbox.fail', 'memory.jobs.defer', 'memory.jobs.fail',
    'memory.jobs.retry-admission', 'memory.tags.retry-admission', 'world.job.retry-admission', 'memory.jobs.proposal.read', 'memory.jobs.proposal.save']) {
    expect(companionExecutionSourceReadOnly({ type } as CompanionStorageCommand), type).toBe(true);
  }
  for (const type of ['memory.forget', 'memory.revise', 'memory.library.delete', 'memory.library.scope', 'memory.tags.complete', 'memory.jobs.complete', 'conversation.update', 'execution.invalidate', 'loop.save']) {
    expect(companionExecutionSourceReadOnly({ type } as CompanionStorageCommand), type).toBe(false);
  }
});

it('refreshes a whole attested history batch once under concurrent progress instead of refreshing each ancestor', async () => {
  let revision = 0;
  const proofs = Array.from({ length: 16 }, (_, index) => {
    const actual = proof('history_' + index);
    return { ...actual, storageValidatedReadsetDigest: createHash('sha256').update(JSON.stringify(actual.executionReadset)).digest('hex') };
  });
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: proofs };
    throw new Error('An observer read must not dispatch or invalidate effects.');
  });
  const valid = vi.fn(async () => { revision++; return true; });
  const result = await guardCompanionExecutionSources({ type: 'messages', conversationId: scope.conversationId },
    { ok: true, messages: proofs.map(value => message(value.id)) }, { storage, valid, revision: () => revision });
  expect(result.messages).toHaveLength(16);
  expect(storage).toHaveBeenCalledTimes(3);
  expect(valid).toHaveBeenCalledTimes(32);
});

it('never persistently withdraws a healthy source because its verification transport temporarily failed', async () => {
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: [proof('healthy')] };
    throw new Error('Temporary verification failure must not invalidate a source.');
  });
  await expect(guardCompanionExecutionSources({ type: 'message.get', id: 'healthy' }, { ok: true, message: message('healthy') }, {
    storage, valid: async () => { throw new Error('The storage transport is temporarily busy.'); },
  })).rejects.toThrow('temporarily busy');
  expect(storage.mock.calls.map(([command]) => command.type)).toEqual(['execution.sources']);
});

it('keeps unfinished progress saves outside the formal-source generation but fences final publication', () => {
  const checkpoint = { ...scope, sourceMessageId: 'actual_source', status: 'running' as const, turns: [], supplements: [] };
  expect(companionExecutionSourceReadOnly({ type: 'loop.save', checkpoint })).toBe(true);
  expect(companionExecutionSourceReadOnly({ type: 'loop.save', checkpoint: { ...checkpoint, status: 'done' } })).toBe(false);
  expect(companionExecutionSourceReadOnly({ type: 'loop.save', checkpoint, executionReadset: captureCompanionExecutionReadset(scope) })).toBe(false);
});

it('coalesces concurrent proof checks within one read and rechecks them on the next read', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const valid = vi.fn(async () => { await gate; return true; });
  const storage = async (): Promise<CompanionStorageResponse> => ({ ok: true, executionSources: [proof('shared')] });
  const read = () => guardCompanionExecutionSources({ type: 'message.get', id: 'shared' }, { ok: true, message: message('shared') }, { storage, valid, revision: () => 0 });
  const first = withCompanionExecutionValidation(() => Promise.all([read(), read(), read(), read()]));
  await vi.waitFor(() => expect(valid).toHaveBeenCalledOnce());
  release();
  expect((await first).every(result => result.message?.content === 'ACTUAL_PRIVATE_BYTES')).toBe(true);
  await read();
  expect(valid).toHaveBeenCalledTimes(2);
});

it('expires a read frame even in background work that inherited its async context', async () => {
  let release!: () => void, background!: Promise<boolean>;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const check = vi.fn(async () => true);
  await withCompanionExecutionValidation(async () => {
    expect(await memoCompanionExecutionValidation('shared', () => 0, check)).toBe(true);
    background = gate.then(() => memoCompanionExecutionValidation('shared', () => 0, check));
  });
  release(); expect(await background).toBe(true);
  expect(check).toHaveBeenCalledTimes(2);
});

it('settles concurrent cross-dependent proof roots without an in-flight wait cycle', async () => {
  let entered = 0, release!: () => void;
  const bothRoots = new Promise<void>(resolve => { release = resolve; });
  const response = (id: string): CompanionStorageResponse => ({ ok: true, message: message(id) });
  const storage = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: command.sourceMessageIds.map(proof) };
    if (command.type === 'execution.invalidate') return { ok: true };
    if (command.type === 'message.get') return response(command.id);
    throw new Error('Unexpected command');
  };
  const read = (id: string): Promise<CompanionStorageResponse> => guardCompanionExecutionSources({ type: 'message.get', id }, response(id), {
    storage, revision: () => 0, valid: async source => {
      if (++entered === 2) release();
      await bothRoots;
      return (await read(source.id === 'A' ? 'B' : 'A')).message?.content === 'ACTUAL_PRIVATE_BYTES';
    },
  });
  let timer!: ReturnType<typeof setTimeout>;
  try {
    const results = await Promise.race([withCompanionExecutionValidation(() => Promise.all([read('A'), read('B')])),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Concurrent source cycle deadlocked')), 1000); timer.unref(); })]);
    expect(results.every(result => result.message?.content !== 'ACTUAL_PRIVATE_BYTES')).toBe(true);
  } finally { clearTimeout(timer); }
});

it('does not share a pending check across source mutation and retries rejected checks', async () => {
  let revision = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await withCompanionExecutionValidation(async () => {
    const before = memoCompanionExecutionValidation('shared', () => revision, async () => { await gate; return true; });
    revision++;
    expect(await memoCompanionExecutionValidation('shared', () => revision, async () => false)).toBe(false);
    release(); expect(await before).toBe(true);
    expect(await memoCompanionExecutionValidation('shared', () => revision, async () => true)).toBe(false);
    await expect(memoCompanionExecutionValidation('error', () => revision, async () => { throw new Error('read failed'); })).rejects.toThrow('read failed');
    expect(await memoCompanionExecutionValidation('error', () => revision, async () => true)).toBe(true);
  });
});

it.each([true, false])('keeps exact historical sent progress only while its derived body remains valid (valid=%s)', async available => {
  const actual = message('own_historical_sent');
  const command = { type: 'activity.progress', ...scope, id: 'exact_task' } as const;
  const raw: CompanionStorageResponse = { ok: true, activityProgressEvidence: { observationChecksum: 'a'.repeat(64), complete: true,
    outbound: [{ message: actual, recipientIds: ['bob'] }] } };
  const storage = vi.fn(async (request: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (request.type === 'execution.sources') return { ok: true, executionSources: [proof(actual.id)] };
    if (request.type === 'execution.invalidate') return { ok: true };
    if (request.type === 'activity.progress') return structuredClone(raw);
    throw new Error('Validation must not dispatch effects.');
  });
  const result = await guardCompanionExecutionSources(command, structuredClone(raw), { storage, valid: async () => available });
  if (available) expect(result.activityProgressEvidence).toEqual(raw.activityProgressEvidence);
  else {
    expect(result.activityProgressEvidence).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(actual.content);
    expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
  }
  expect(storage.mock.calls.map(([request]) => request.type)).toEqual(available ? ['execution.sources']
    : ['execution.sources', 'execution.invalidate', 'activity.progress']);
});

it.each([true, false])('validates actual publication-page bodies through the existing derived-source boundary (valid=%s)', async available => {
  const actual = message('derived_publication'), checksum = createHash('sha256').update(actual.content).digest('hex');
  const command = { type: 'topic.compaction.sources', conversationId: scope.conversationId, readerId: scope.companionId, topicId: 'actual_topic',
    afterPublicationRevision: 3, throughPublicationRevision: 4, legacyAfterSequence: 0, beforeSequence: 10 } as const;
  const raw: CompanionStorageResponse = { ok: true, topicCompactionPage: { items: [{ message: actual, publicationRevision: 4, sourceChecksum: checksum }],
    afterPublicationRevision: 4, throughPublicationRevision: 4, legacyScannedThroughSequence: 10, legacyThroughSequence: 10, legacyComplete: true, hasMore: false } };
  const storage = vi.fn(async (request: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (request.type === 'execution.sources') return { ok: true, executionSources: [proof(actual.id)] };
    if (request.type === 'execution.invalidate') return { ok: true };
    if (request.type === 'topic.compaction.sources') return structuredClone(raw);
    throw new Error('Publication validation must not dispatch an effect.');
  });
  expect(companionExecutionSourceReadOnly(command)).toBe(true);
  const result = await guardCompanionExecutionSources(command, raw, { storage, valid: async () => available });
  expect(result.topicCompactionPage?.items).toHaveLength(available ? 1 : 0);
  expect(result.topicCompactionPage?.afterPublicationRevision).toBe(4);
  expect(result.topicCompactionPage?.legacyScannedThroughSequence).toBe(10);
  if (!available) expect(JSON.stringify(result)).not.toContain(actual.content);
  expect(storage.mock.calls.map(([request]) => request.type)).toEqual(available ? ['execution.sources']
    : ['execution.sources', 'execution.invalidate', 'topic.compaction.sources']);
});

it.each([true, false])('accepts only an exact current worker readset digest as the SQLite fast path (matching=%s)', async matching => {
  const actual = proof('derived_one');
  actual.storageValidatedReadsetDigest = matching ? createHash('sha256').update(JSON.stringify(actual.executionReadset)).digest('hex') : '0'.repeat(64);
  const valid = vi.fn(async (_proof: CompanionExecutionSourceProof, sqliteSourcesValidated?: boolean) => { expect(sqliteSourcesValidated).toBe(matching); return true; });
  const result = await guardCompanionExecutionSources({ type: 'message.get', id: actual.id }, { ok: true, message: message(actual.id) }, {
    revision: () => 4, storage: async () => ({ ok: true, executionSources: [actual] }), valid,
  });
  expect(result.message?.content).toBe('ACTUAL_PRIVATE_BYTES'); expect(valid).toHaveBeenCalledOnce();
});

it('does not return an old valid result after a concurrent source mutation completes during verification', async () => {
  let revision = 1, checks = 0;
  const actual = proof('derived_one'), invalidations: string[] = [];
  actual.storageValidatedReadsetDigest = createHash('sha256').update(JSON.stringify(actual.executionReadset)).digest('hex');
  const result = await guardCompanionExecutionSources({ type: 'message.get', id: actual.id }, { ok: true, message: message(actual.id) }, {
    revision: () => revision,
    storage: async command => {
      if (command.type === 'execution.sources') return { ok: true, executionSources: [{ ...actual, ...(checks ? { invalidated: true, storageValidatedReadsetDigest: undefined } : {}) }] };
      if (command.type === 'execution.invalidate') { invalidations.push(command.id); return { ok: true }; }
      if (command.type === 'message.get') return { ok: true, message: message(actual.id) };
      throw new Error('Unexpected command');
    },
    valid: async (_proof, sqliteSourcesValidated) => {
      checks++;
      if (checks === 1) { expect(sqliteSourcesValidated).toBe(true); revision++; return true; }
      throw new Error('A revoked worker proof must be rejected before any old async body can be reused');
    },
  });
  expect(checks).toBe(1); expect(invalidations).toEqual([actual.id]);
  expect(result.message?.content).not.toBe('ACTUAL_PRIVATE_BYTES');
});

it('refreshes SQL without treating concurrent progress as revocation or replaying an effect', async () => {
  let revision = 0;
  const actual = proof('derived_one');
  actual.storageValidatedReadsetDigest = createHash('sha256').update(JSON.stringify(actual.executionReadset)).digest('hex');
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: [actual] };
    throw new Error('A mutation or replay was attempted');
  });
  const valid = vi.fn(async () => { revision++; return true; });
  const result = await guardCompanionExecutionSources({ type: 'message.get', id: 'derived_one' }, { ok: true, message: message('derived_one') }, {
    storage, revision: () => revision, valid,
  });
  expect(result.message?.content).toBe('ACTUAL_PRIVATE_BYTES'); expect(valid).toHaveBeenCalledTimes(2);
  expect(storage.mock.calls.map(([command]) => command.type)).toEqual(['execution.sources', 'execution.sources', 'execution.sources']);
});

it('refreshes the exact worker SQL attestation instead of recursively re-expanding history after a concurrent routine write', async () => {
  let revision = 0;
  const actual = proof('shared_history');
  actual.storageValidatedReadsetDigest = createHash('sha256').update(JSON.stringify(actual.executionReadset)).digest('hex');
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: [actual] };
    throw new Error('The refresh must read provenance only');
  });
  const checks: boolean[] = [];
  const result = await guardCompanionExecutionSources({ type: 'message.get', id: actual.id }, { ok: true, message: message(actual.id) }, {
    storage, revision: () => revision,
    valid: async (_proof, sqlite) => { checks.push(!!sqlite); revision++; return true; },
  });
  expect(result.message?.content).toBe('ACTUAL_PRIVATE_BYTES');
  expect(checks).toEqual([true, true]);
  expect(storage.mock.calls.map(([command]) => command.type)).toEqual(['execution.sources', 'execution.sources', 'execution.sources']);
});

it('does not use a refreshed SQL proof with a changed exact readset as the fast path', async () => {
  let revision = 0, reads = 0;
  const actual = proof('changed_history');
  actual.storageValidatedReadsetDigest = createHash('sha256').update(JSON.stringify(actual.executionReadset)).digest('hex');
  const replacement = { ...actual, executionReadset: captureCompanionExecutionReadset(scope, { sources: [{ id: 'different_source', conversationId: scope.conversationId, checksum: 'a'.repeat(64) }] }) };
  replacement.storageValidatedReadsetDigest = createHash('sha256').update(JSON.stringify(replacement.executionReadset)).digest('hex');
  const checks: boolean[] = [], invalidations: string[] = [];
  await expect(guardCompanionExecutionSources({ type: 'message.get', id: actual.id }, { ok: true, message: message(actual.id) }, {
    revision: () => revision,
    storage: async command => {
      if (command.type === 'execution.sources') return { ok: true, executionSources: [++reads === 1 ? actual : replacement] };
      if (command.type === 'execution.invalidate') { invalidations.push(command.id); return { ok: true }; }
      return { ok: true, message: message(actual.id) };
    },
    valid: async (_proof, sqlite) => { checks.push(!!sqlite); if (checks.length === 1) { revision++; return true; } return false; },
  })).rejects.toThrow('暂不可稳定核验');
  expect(checks).toEqual([true]);
  expect(invalidations).toEqual([]);
});

it('treats an indeterminate worker attestation as temporary unavailability without tombstoning healthy content', async () => {
  let revision = 0, reads = 0;
  const actual = proof('healthy_external_write'), invalidations: string[] = [];
  actual.storageValidatedReadsetDigest = createHash('sha256').update(JSON.stringify(actual.executionReadset)).digest('hex');
  await expect(guardCompanionExecutionSources({ type: 'message.get', id: actual.id }, { ok: true, message: message(actual.id) }, {
    revision: () => revision,
    storage: async command => {
      if (command.type === 'execution.sources') return { ok: true, executionSources: [{ ...actual, ...(reads++ ? { storageValidatedReadsetDigest: undefined } : {}) }] };
      if (command.type === 'execution.invalidate') invalidations.push(command.id);
      return { ok: true };
    }, valid: async () => { revision++; return true; },
  })).rejects.toThrow('暂不可稳定核验');
  expect(reads).toBe(2); expect(invalidations).toEqual([]);
});

it('checks the final SQL state after async external guards and withholds a source revoked during that check', async () => {
  let revision = 0, checks = 0, withdrawn = false;
  const actual = proof('revoked_during_async_check'), invalidations: string[] = [];
  actual.storageValidatedReadsetDigest = createHash('sha256').update(JSON.stringify(actual.executionReadset)).digest('hex');
  const result = await guardCompanionExecutionSources({ type: 'message.get', id: actual.id }, { ok: true, message: message(actual.id) }, {
    revision: () => revision,
    storage: async command => {
      if (command.type === 'execution.sources') return { ok: true, executionSources: [{ ...actual, ...(withdrawn ? { invalidated: true } : {}) }] };
      if (command.type === 'execution.invalidate') { invalidations.push(command.id); return { ok: true }; }
      return { ok: true, message: message(actual.id) };
    }, valid: async () => { revision++; if (++checks === 2) withdrawn = true; return true; },
  });
  expect(checks).toBe(2); expect(invalidations).toEqual([actual.id]);
  expect(result.message?.content).not.toBe('ACTUAL_PRIVATE_BYTES');
});

it('collects only real host source fields and ignores prose that resembles a provenance receipt', () => {
  const actual = message('actual_message');
  actual.content = JSON.stringify({ message: message('invented_message'), memoryContext: { evidence: { references: [{ id: 'invented_note' }] } } });
  expect(companionExecutionSourceReferences({ ok: true, message: actual })).toEqual({ sourceMessageIds: ['actual_message'], memoryIds: [] });
  expect(companionExecutionSourceReferences({ ok: true, memoryJob: { id: 'lease_job', ...scope, sourceMessageIds: ['id_only'], throughSequence: 1,
    leaseToken: 'lease_token', attempts: 1, sourceChecksums: {}, sourceRevisions: {} } })).toEqual({ sourceMessageIds: [], memoryIds: [] });
  expect(companionExecutionSourceReferences({ ok: true, memoryContext: { text: 'Native output', revision: 'corpus', profileKey: 'profile', evidence: {
    capturedAt: actual.createdAt, corpusHash: 'hash', references: [{ id: 'actual_note', version: 1, textHash: 'hash', role: 'focus_input', sources: [] }],
  } } })).toEqual({ sourceMessageIds: [], memoryIds: ['actual_note'] });
});

it('rereads a withdrawn source using the real new corpus and redacts historical bytes without replaying a mutation', async () => {
  const raw = { ok: true, message: message('derived_one') } satisfies CompanionStorageResponse;
  const commands: CompanionStorageCommand[] = [];
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    commands.push(command);
    if (command.type === 'execution.sources') return { ok: true, executionSources: [proof('derived_one')] };
    if (command.type === 'execution.invalidate') return { ok: true, memoryInvalidatedCompanionIds: ['alice'] };
    if (command.type === 'message.get') return structuredClone(raw);
    throw new Error('Unexpected command');
  });
  const invalidated = vi.fn();
  const result = await guardCompanionExecutionSources({ type: 'message.get', id: 'derived_one' }, raw, { storage, valid: async () => false, invalidated });
  expect(JSON.stringify(result)).not.toContain('ACTUAL_PRIVATE_BYTES');
  expect(result.message?.content).toBe(''); expect(result.message?.sourceUnavailable).toBe('execution_source_changed');
  expect(result.memoryInvalidatedCompanionIds).toEqual(['alice']); expect(invalidated).toHaveBeenCalledOnce();
  expect(commands.map(command => command.type)).toEqual(['execution.sources', 'execution.invalidate', 'message.get']);
  commands.splice(0);
  await expect(guardCompanionExecutionSources({ type: 'message.append', message: { conversationId: scope.conversationId, authorId: 'alice', content: 'New reply' } }, raw,
    { storage, valid: async () => false })).rejects.toThrow('旧正文不可继续使用');
  expect(commands.map(command => command.type)).toEqual(['execution.sources', 'execution.invalidate']);
});

it('rejects dependency cycles while allowing parallel readers of the same valid ancestor', async () => {
  let cyclic = true;
  const invalidations: string[] = [];
  const response = (id: string): CompanionStorageResponse => ({ ok: true, message: message(id) });
  const storage = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: command.sourceMessageIds.map(proof) };
    if (command.type === 'execution.invalidate') { invalidations.push(command.id); return { ok: true }; }
    if (command.type === 'message.get') return response(command.id);
    throw new Error('Unexpected command');
  };
  const read = (id: string) => guardCompanionExecutionSources({ type: 'message.get', id }, response(id), { storage, valid });
  const valid = async (source: CompanionExecutionSourceProof): Promise<boolean> => {
    if (source.id === 'ancestor') return true;
    const dependency = cyclic ? (source.id === 'one' ? 'two' : 'one') : 'ancestor';
    const checked = await read(dependency);
    return checked.message?.content === 'ACTUAL_PRIVATE_BYTES';
  };
  expect((await read('one')).message?.content).not.toBe('ACTUAL_PRIVATE_BYTES');
  expect(invalidations).toContain('one');
  invalidations.splice(0); cyclic = false;
  const parallel = await Promise.all([read('one'), read('two')]);
  expect(parallel.every(result => result.message?.content === 'ACTUAL_PRIVATE_BYTES')).toBe(true);
  expect(invalidations).toEqual([]);
});

it('validates a shared dependency DAG once per node and rechecks a later read after revocation', async () => {
  let calls = 0, available = true;
  const invalidated = new Set<string>();
  const response = (id: string): CompanionStorageResponse => ({ ok: true, message: message(id) });
  const storage = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: command.sourceMessageIds.map(id => ({ ...proof(id), invalidated: invalidated.has(id) })) };
    if (command.type === 'execution.invalidate') { invalidated.add(command.id); return { ok: true }; }
    if (command.type === 'message.get') return response(command.id);
    throw new Error('Unexpected command');
  };
  const read = (level: number) => guardCompanionExecutionSources({ type: 'message.get', id: 'node_' + level }, response('node_' + level), { storage, valid });
  const valid = async (source: CompanionExecutionSourceProof): Promise<boolean> => {
    if (++calls > 80) throw new Error('Shared ancestors were repeatedly expanded.');
    const level = Number(source.id.slice(5));
    if (level < 2) return available;
    if ((await read(level - 1)).message?.content !== 'ACTUAL_PRIVATE_BYTES') return false;
    return (await read(level - 2)).message?.content === 'ACTUAL_PRIVATE_BYTES';
  };
  expect((await read(24)).message?.content).toBe('ACTUAL_PRIVATE_BYTES');
  expect(calls).toBe(25);
  available = false;
  expect((await read(24)).message?.content).not.toBe('ACTUAL_PRIVATE_BYTES');
  expect(invalidated.has('node_24')).toBe(true);
});

it('does not reuse a completed ancestor after a mutation inside the same traversal', async () => {
  let revision = 0, available = true, leafChecks = 0;
  const response = (id: string): CompanionStorageResponse => ({ ok: true, message: message(id) });
  const storage = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: command.sourceMessageIds.map(proof) };
    if (command.type === 'execution.invalidate') return { ok: true };
    if (command.type === 'message.get') return response(command.id);
    throw new Error('Unexpected command');
  };
  const read = (id: string) => guardCompanionExecutionSources({ type: 'message.get', id }, response(id), { storage, valid, revision: () => revision });
  const valid = async (source: CompanionExecutionSourceProof): Promise<boolean> => {
    if (source.id === 'leaf') { leafChecks++; return available; }
    expect((await read('leaf')).message?.content).toBe('ACTUAL_PRIVATE_BYTES');
    available = false; revision++;
    return (await read('leaf')).message?.content === 'ACTUAL_PRIVATE_BYTES';
  };
  expect((await read('root')).message?.content).not.toBe('ACTUAL_PRIVATE_BYTES');
  expect(leafChecks).toBe(2);
});

it('keeps identical proof identities in independent storage ports separate', async () => {
  const identities = [{}, {}], checked = [0, 0];
  const response = (id: string): CompanionStorageResponse => ({ ok: true, message: message(id) });
  const storage = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: command.sourceMessageIds.map(proof) };
    if (command.type === 'execution.invalidate') return { ok: true };
    if (command.type === 'message.get') return response(command.id);
    throw new Error('Unexpected command');
  };
  const read = (id: string, port: number): Promise<CompanionStorageResponse> => guardCompanionExecutionSources({ type: 'message.get', id }, response(id), {
    storage, identity: identities[port], valid: async source => {
      if (source.id === 'shared') { checked[port] = (checked[port] ?? 0) + 1; return port === 0; }
      expect((await read('shared', 0)).message?.content).toBe('ACTUAL_PRIVATE_BYTES');
      return (await read('shared', 1)).message?.content === 'ACTUAL_PRIVATE_BYTES';
    },
  });
  expect((await read('root', 0)).message?.content).not.toBe('ACTUAL_PRIVATE_BYTES');
  expect(checked).toEqual([1, 1]);
});

it('withholds both the message and the duplicated social-flow excerpt after its source is invalidated', async () => {
  const original = message('derived_one'), at = original.createdAt;
  const response: CompanionStorageResponse = { ok: true, socialFlowPage: { timeZone: 'Asia/Shanghai', observedDay: '2026-10-23', virtualNow: at, backlog: false,
    hasMore: false, visits: [], items: [{ id: 'flow_one', at, realAt: at, actorId: 'alice', targetIds: ['bob'], kind: 'phone', label: '真实通信',
      text: original.content, message: { message: original, virtualCreatedAt: at, recipientIds: ['bob'], channel: 'phone' } }] } };
  const storage = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: [proof('derived_one')] };
    if (command.type === 'execution.invalidate') return { ok: true };
    if (command.type === 'social.flow') return structuredClone(response);
    throw new Error('Unexpected command');
  };
  const result = await guardCompanionExecutionSources({ type: 'social.flow', conversationId: scope.conversationId }, response, { storage, valid: async () => false });
  expect(JSON.stringify(result)).not.toContain('ACTUAL_PRIVATE_BYTES');
  expect(result.socialFlowPage!.items[0]).toMatchObject({ id: 'flow_one', kind: 'phone', textTruncated: false });
});

it('redacts a permanently invalid historical source without continuously advancing the inference generation', async () => {
  const response: CompanionStorageResponse = { ok: true, message: message('derived_one') };
  const invalidated = vi.fn(), valid = vi.fn(async () => false);
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: [{ ...proof('derived_one'), invalidated: true }] };
    if (command.type === 'message.get') return structuredClone(response);
    throw new Error('A permanent tombstone must not be invalidated again');
  });
  for (let count = 0; count < 3; count++) {
    const result = await guardCompanionExecutionSources({ type: 'message.get', id: 'derived_one' }, response, { storage, valid, invalidated });
    expect(JSON.stringify(result)).not.toContain('ACTUAL_PRIVATE_BYTES');
  }
  expect(valid).not.toHaveBeenCalled(); expect(invalidated).not.toHaveBeenCalled();
  expect(storage.mock.calls.some(([command]) => command.type === 'execution.invalidate')).toBe(false);
});
