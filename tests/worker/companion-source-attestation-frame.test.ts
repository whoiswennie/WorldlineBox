import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { CompanionService } from '../../src/main/companions/service';
import { createCompanionExecutionValidationSession, guardCompanionExecutionSources, memoCompanionExecutionWitnesses,
  memoCompanionExecutionAuthorities, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { CompanionPermissionDeniedError } from '../../src/shared/companion-permission';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {}, utilityProcess: { fork: vi.fn() } }));

let root: string, store: CompanionsStore;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'source-attestation-frame-'));
  store = new CompanionsStore(path.join(root, 'state.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '来源核验',
    model: '', avatar: 'sister', active: true, proactive: false })));
});
afterEach(() => { store.close(); removeOwnedDirectorySync(root); });

function fixture(count = 1) {
  const room = store.createConversation('实际来源房间', ['alice', 'bob']), scope = { companionId: 'alice', conversationId: room.id };
  const source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '核对实际输入。', replyDirective: 'none' });
  const messages: CompanionMessage[] = [];
  for (let index = 0; index < count; index++) {
    const message = store.appendMessage({ conversationId: room.id, authorId: 'alice', content: '', loopStep: 0 });
    const inputs = [source, ...messages.slice(-1)], text = '实际正式答复 ' + index;
    store.request({ type: 'loop.save', checkpoint: { ...scope, invocationKey: 'task_' + index, sourceMessageId: source.id, messageId: message.id,
      status: 'done', turns: [{ text, rawText: text, calls: [] }], supplements: [] }, executionReadset: captureCompanionExecutionReadset(scope, {
        sources: inputs.map(input => ({ id: input.id, conversationId: room.id, checksum: createHash('sha256').update(input.content).digest('hex') })),
      }) });
    messages.push(store.getMessage(message.id));
  }
  const identity = {}, valid = vi.fn(async () => true);
  let revision = 0;
  const storage = vi.fn(async (command: CompanionStorageCommand) => store.request(command));
  const read = (ids = [messages.at(-1)!.id]) => guardCompanionExecutionSources({ type: 'messages', conversationId: room.id }, {
    ok: true, messages: ids.map(id => store.getMessage(id)),
  }, { storage, identity, valid, revision: () => revision });
  const sqlCount = () => storage.mock.calls.filter(([command]) => command.type === 'execution.sources').length;
  return { source, scope, messages, identity, valid, storage, read, sqlCount, revision: () => revision, mutate: () => { revision++; } };
}

function externalConnection() {
  const external = new (Database as { new(filename: string): CompanionConnection })(path.join(root, 'state.sqlite'));
  external.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  external.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  return external;
}

function pendingReply(f: ReturnType<typeof fixture>) {
  const message = store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '', loopStep: 0 });
  const checkpoint = { ...f.scope, sourceMessageId: f.source.id, messageId: message.id, status: 'running' as const,
    turns: [], supplements: [], draft: { step: 0, attemptId: 'actual_attempt', text: '尚未正式完成的真实草稿。' } };
  store.request({ type: 'loop.save', checkpoint });
  const publish = () => store.request({ type: 'loop.save', checkpoint: { ...checkpoint, status: 'done', draft: undefined,
    turns: [{ text: '此后真实完成的正式答复。', rawText: '此后真实完成的正式答复。', calls: [] }] },
    executionReadset: captureCompanionExecutionReadset(f.scope, { sources: [{ id: f.source.id, conversationId: f.source.conversationId,
      checksum: createHash('sha256').update(f.source.content).digest('hex') }] }) });
  return { message, checkpoint, publish };
}

it('does not reject an older UI messages snapshot when its real running text bubble becomes formal under the same ID', async () => {
  const f = fixture(), draft = pendingReply(f);
  await withCompanionExecutionValidation(async () => {
    const result = await f.read([f.messages[0]!.id, draft.message.id]);
    expect(result.messages?.at(-1)).toMatchObject({ isReplyDraft: true, replyDraft: { attemptId: 'actual_attempt' } });
    expect(f.sqlCount()).toBe(1); draft.publish();
  });
  expect(f.sqlCount()).toBe(2);
  expect(store.getMessage(draft.message.id).isReplyDraft).not.toBe(true);
  expect(f.valid).toHaveBeenCalledOnce();
});

it.each([false, true])('admits the newly formal same-ID reply freshly in the same gate and retains the hard withdrawal fence (withdraw=%s)', async withdraw => {
  const f = fixture(), draft = pendingReply(f);
  const operation = withCompanionExecutionValidation(async () => {
    await f.read([f.messages[0]!.id, draft.message.id]); draft.publish();
    const formal = await f.read([f.messages[0]!.id, draft.message.id]);
    expect(formal.messages?.at(-1)?.content).toBe('此后真实完成的正式答复。');
    expect(f.sqlCount()).toBe(2); expect(f.valid).toHaveBeenCalledTimes(2);
    if (withdraw) store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  });
  if (withdraw) await expect(operation).rejects.toThrow('执行依赖已经变化'); else await operation;
  expect(f.sqlCount()).toBe(3);
});

it.each(['user', 'system'])('does not let %s draft lookalikes bypass the formal-source guard', async authorId => {
  const f = fixture(), actual = f.messages[0]!;
  const result = await guardCompanionExecutionSources({ type: 'message.get', id: actual.id }, { ok: true,
    message: { ...actual, authorId, isReplyDraft: true, replyDraft: { step: 0, attemptId: 'lookalike', text: '未获权正文' } } }, {
    storage: f.storage, valid: async () => false,
  });
  expect(f.storage.mock.calls.some(([command]) => command.type === 'execution.invalidate')).toBe(true);
  expect(result.message?.sourceUnavailable).toBe('execution_source_changed'); expect(result.message?.content).toBe('');
});

it.each(['running', 'failed'] as const)('keeps actual %s capability cards behind current authority checks even when they carry draft fields', async status => {
  const f = fixture(), draft = pendingReply(f), call = { id: 'agenda_call', name: 'agenda', arguments: '{"action":"tasks.read"}' };
  store.request({ type: 'loop.save', checkpoint: { ...draft.checkpoint, draft: undefined, turns: [{ text: '', rawText: '', calls: [call] }] } });
  const action = store.request({ type: 'capability.begin', ...f.scope, sourceMessageId: f.source.id, parentMessageId: draft.message.id,
    loopStep: 0, title: '核对本人日程', name: call.name, callId: call.id, input: call.arguments, invocationId: f.source.id + ':alice' }).action!;
  if (status === 'failed') store.request({ type: 'action.update', id: action.id, patch: { status: 'failed', error: '真实工具拒绝回执。' } });
  const card = store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', kind: 'action', actionId: action.id, content: '实际能力过程卡片。' });
  const authority = vi.fn(async (proofs: Parameters<typeof memoCompanionExecutionAuthorities>[0]) => {
    const result = store.request({ type: 'execution.capabilities.validate', actions: proofs.map(proof => ({ id: proof.id,
      companionId: proof.companionId, conversationId: proof.conversationId, capability: proof.capability })) });
    return new Map(result.capabilityAuthorityResults!.map(result => [result.id, result.valid]));
  });
  const read = () => guardCompanionExecutionSources({ type: 'message.get', id: card.id }, { ok: true, message: { ...store.getMessage(card.id),
    isReplyDraft: true, replyDraft: { step: 0, attemptId: 'action_view', text: '真实卡片展示' } } }, {
    storage: f.storage, actionAuthorities: authority, valid: async () => true, revision: () => 0,
  });
  expect((await read()).message?.content).toBe(card.content); expect(authority).toHaveBeenCalledTimes(2);
  store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  expect((await read()).message?.sourceUnavailable).toBe('execution_source_changed');
  expect(store.getAction(action.id).status).toBe(status);
});

it('shares one exact strong SQL admission across sequential phases and performs a fresh final union before each new gate returns', async () => {
  const f = fixture(3), session = createCompanionExecutionValidationSession();
  try {
    for (let phase = 0; phase < 4; phase++) expect((await session.run(() => f.read())).messages?.at(-1)?.content).toBe(f.messages.at(-1)!.content);
    expect(f.sqlCount()).toBe(1); expect(f.valid).toHaveBeenCalledTimes(3);
    await session.validate(); expect(f.sqlCount()).toBe(2);
    await expect(session.run(() => f.read())).rejects.toMatchObject({ name: 'AbortError' });
  } finally { session.close(); }
  await f.read(); expect(f.sqlCount()).toBe(4); expect(f.valid).toHaveBeenCalledTimes(6);
});

it('unifies overlapping source closures into one final SQL batch while retaining every requested root association', async () => {
  const f = fixture(4);
  await withCompanionExecutionValidation(async () => {
    await f.read([f.messages[3]!.id]); await f.read([f.messages[1]!.id]);
    await f.read([f.messages[3]!.id]); await f.read([f.messages[1]!.id]);
    expect(f.sqlCount()).toBe(2); expect(f.valid).toHaveBeenCalledTimes(4);
  });
  expect(f.sqlCount()).toBe(3);
  const command = f.storage.mock.calls.at(-1)![0];
  expect(command).toMatchObject({ type: 'execution.sources', memoryIds: [] });
  if (command.type === 'execution.sources') expect(new Set(command.sourceMessageIds)).toEqual(new Set([f.messages[1]!.id, f.messages[3]!.id]));
});

it('reuses one consumed strong superset for source and memory subsets without changing its final root associations', async () => {
  const f = fixture(3), roots = f.messages.map(message => message.id);
  const note = store.request({ type: 'memory.record', ...f.scope, candidate: { artifactKind: 'episode_memory', content: '有实际SQL依据的记忆。', tags: [],
    sourceMessageIds: [f.source.id], evidence: [{ sourceMessageId: f.source.id, quote: f.source.content }] } }).memories![0]!;
  const guard = (response: CompanionStorageResponse) => guardCompanionExecutionSources({ type: 'messages', conversationId: f.scope.conversationId }, response,
    { storage: f.storage, identity: f.identity, valid: f.valid, revision: f.revision });
  await withCompanionExecutionValidation(async () => {
    await guard({ ok: true, messages: roots.map(id => store.getMessage(id)), memories: [note] });
    expect(f.sqlCount()).toBe(1); expect(f.valid).toHaveBeenCalledTimes(3);
    expect((await f.read([roots[0]!])).messages?.[0]?.content).toBe(f.messages[0]!.content);
    const fresh = store.request({ type: 'memory.records.filter', ...f.scope, ids: [note.id] });
    expect((await guard(fresh)).memories?.[0]?.content).toBe(note.content);
    expect(f.sqlCount()).toBe(1); expect(f.valid).toHaveBeenCalledTimes(3);
  });
  expect(f.sqlCount()).toBe(2);
  const final = f.storage.mock.calls.at(-1)![0];
  expect(final).toMatchObject({ type: 'execution.sources', memoryIds: [note.id] });
  if (final.type === 'execution.sources') expect(new Set(final.sourceMessageIds)).toEqual(new Set([...roots, f.source.id]));
});

it('does not combine two strong entries into invented coverage for a new multi-root request', async () => {
  const f = fixture(3), first = f.messages[0]!.id, last = f.messages[2]!.id;
  await withCompanionExecutionValidation(async () => {
    await f.read([first]); await f.read([last]); expect(f.sqlCount()).toBe(2);
    await f.read([first, last]); expect(f.sqlCount()).toBe(3);
  });
  expect(f.sqlCount()).toBe(4);
});

it('shares exact strong admission after an unrelated source generation changes without replaying the attested file DAG', async () => {
  const f = fixture();
  await withCompanionExecutionValidation(async () => {
    await f.read(); f.mutate(); await f.read();
    expect(f.sqlCount()).toBe(1); expect(f.valid).toHaveBeenCalledOnce();
  });
  expect(f.sqlCount()).toBe(2);
});

it('retains one strong admission across the actual Main mutation-generation boundary and performs one fresh final SQL fence', async () => {
  const f = fixture();
  const host = Object.create(CompanionService.prototype) as { sourceValidationRevision: number;
    call(command: CompanionStorageCommand): Promise<CompanionStorageResponse> };
  Object.assign(host, { sourceValidationRevision: 0, evidenceRevision: 0, storage: { request: f.storage },
    options: {}, resettingCompanions: new Set<string>(), memory: { schedule: vi.fn() } });
  await withCompanionExecutionValidation(async () => {
    const command = { type: 'message.get' as const, id: f.messages[0]!.id };
    expect((await host.call(command)).message?.content).toBe(f.messages[0]!.content);
    expect(f.sqlCount()).toBe(1);
    await host.call({ type: 'memory.outbox.claim' }); // Actual Main before/after mutation increments, no fake counter.
    expect(host.sourceValidationRevision).toBe(2);
    expect((await host.call(command)).message?.content).toBe(f.messages[0]!.content);
    expect(f.sqlCount()).toBe(1);
  });
  expect(f.sqlCount()).toBe(2);
});

it.each(['bytes', 'membership'] as const)('rejects an external SQLite %s change at the final fence despite cached admission', async change => {
  const f = fixture(2), external = externalConnection();
  try {
    await expect(withCompanionExecutionValidation(async () => {
      await f.read(f.messages.map(message => message.id)); await f.read([f.messages[0]!.id]); expect(f.sqlCount()).toBe(1);
      if (change === 'bytes') external.prepare('UPDATE messages SET content=? WHERE id=?').run('独立连接改写的来源。', f.source.id);
      else external.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(f.scope.conversationId, f.scope.companionId);
    })).rejects.toThrow('执行依赖已经变化');
    expect(f.sqlCount()).toBe(2);
    expect(f.storage.mock.calls.some(([command]) => command.type === 'execution.invalidate')).toBe(false);
  } finally { external.close(); }
});

it.each(['readset', 'withdrawal', 'extra_ancestor', 'root_association'] as const)('rejects an external SQLite proof %s change without relying on a Main generation event', async change => {
  const f = fixture(2), external = externalConnection(), message = f.messages[0]!;
  let read = f.read, linkedActionId: string | undefined;
  try {
    if (change === 'root_association') {
      // Re-associate a real completed action with another existing root. This
      // changes no immutable action/message readset and introduces no cycle.
      const action = store.createAction({ ...f.scope, sourceMessageId: f.source.id, title: '真实已完成过程', status: 'queued' });
      store.saveCheckpoint(action.id, { prompt: '完成实际过程。', waitForActionIds: [], supplements: [], executionReadset: captureCompanionExecutionReadset(f.scope) });
      store.updateAction(action.id, { status: 'succeeded', result: '已完成。' }); linkedActionId = action.id;
      external.prepare('UPDATE messages SET action_id=? WHERE id=?').run(action.id, f.messages[1]!.id);
      const authorityIdentity = {};
      read = (ids = f.messages.map(message => message.id)) => guardCompanionExecutionSources({ type: 'messages', conversationId: f.scope.conversationId },
        { ok: true, messages: ids.map(id => store.getMessage(id)) }, { storage: f.storage, identity: f.identity, valid: f.valid, revision: f.revision,
          actionAuthorities: proofs => memoCompanionExecutionAuthorities(proofs, async current => new Map(current.map(proof => {
            const actual = store.getAction(proof.id);
            return [proof.id, actual.status === 'succeeded' && actual.companionId === proof.companionId && actual.conversationId === proof.conversationId];
          })), authorityIdentity) });
    }
    await expect(withCompanionExecutionValidation(async () => {
      await read(f.messages.map(message => message.id)); await read([message.id]); expect(f.sqlCount()).toBe(1);
      if (change === 'readset') external.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(captureCompanionExecutionReadset(f.scope)), 'message-execution-readset/' + message.id);
      else if (change === 'withdrawal') external.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('execution-source-invalid/message/' + message.id, '{}');
      else if (change === 'root_association') {
        if (!linkedActionId) throw new Error('真实过程尚未建立。');
        external.prepare('UPDATE messages SET action_id=? WHERE id=?').run(linkedActionId, message.id);
      }
      else {
        const ancestor = store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '', loopStep: 0 });
        const source = { id: f.source.id, conversationId: f.source.conversationId, checksum: createHash('sha256').update(f.source.content).digest('hex') };
        store.request({ type: 'loop.save', checkpoint: { ...f.scope, invocationKey: 'added_ancestor', sourceMessageId: f.source.id,
          messageId: ancestor.id, status: 'done', turns: [{ text: '新增的真实派生祖先。', rawText: '新增的真实派生祖先。', calls: [] }], supplements: [] },
          executionReadset: captureCompanionExecutionReadset(f.scope, { sources: [source] }) });
        const actual = store.getMessage(ancestor.id);
        external.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(captureCompanionExecutionReadset(f.scope, { sources: [source,
          { id: actual.id, conversationId: actual.conversationId, checksum: createHash('sha256').update(actual.content).digest('hex') }] })),
        'message-execution-readset/' + message.id);
      }
    })).rejects.toThrow('执行依赖已经变化');
    expect(f.sqlCount()).toBe(2);
    if (change === 'root_association') {
      const initial: CompanionStorageResponse = await f.storage.mock.results[0]!.value, final: CompanionStorageResponse = await f.storage.mock.results.at(-1)!.value;
      const bindings = (response: CompanionStorageResponse) => response.executionSources?.map(({ sourceMessageIds: _roots, ...proof }) => {
        void _roots; return proof;
      }).sort((left, right) => left.id.localeCompare(right.id));
      expect(bindings(final)).toEqual(bindings(initial)); // Only the root association changed, not any proof binding.
      expect(final.executionSources?.map(proof => proof.sourceMessageIds)).not.toEqual(initial.executionSources?.map(proof => proof.sourceMessageIds));
    }
  } finally { external.close(); }
});

it('checks source attestations after the last asynchronous canonical witness, not its earlier insertion order', async () => {
  const f = fixture(), external = externalConnection(), order: string[] = [];
  try {
    await expect(withCompanionExecutionValidation(async () => {
      await f.read();
      await memoCompanionExecutionWitnesses(['canonical'], { identity: {}, scope: 'files', revision: () => 0,
        read: async keys => new Map(keys.map(key => [key, 'actual bytes'])),
        verify: async () => {
          await Promise.resolve(); order.push('canonical');
          external.prepare('UPDATE messages SET content=? WHERE id=?').run('在最后文件校验期间撤回旧来源。', f.source.id);
        },
      });
    })).rejects.toThrow('执行依赖已经变化');
    expect(order).toEqual(['canonical']); expect(f.sqlCount()).toBe(2);
  } finally { external.close(); }
});

it('checks a real collaboration grant after the final source SQL fence even when its immutable action readset is unchanged', async () => {
  const f = fixture(), child = store.openPrivate('bob');
  const grant = store.request({ type: 'collaboration.create', companionId: 'alice', conversationId: f.scope.conversationId, sourceMessageId: f.source.id,
    title: '独立核对', goal: '请 bob 独立核对。', parentInvocationId: 'parent', evidence: [f.source.content],
    participants: [{ companionId: 'bob', goal: '独立核对。' }], clientId: 'collaboration' }).collaboration!;
  store.request({ type: 'collaboration.respond', id: grant.id, companionId: 'bob', decision: 'accept', reason: '接受。' });
  store.request({ type: 'collaboration.start', id: grant.id, companionId: 'bob', invocationId: 'child', conversationId: child.id });
  const action = store.createAction({ companionId: 'bob', conversationId: child.id, sourceMessageId: f.source.id, authorizationGrantId: grant.id, title: '真实核对', status: 'queued' });
  store.saveCheckpoint(action.id, { prompt: '独立核对。', waitForActionIds: [], supplements: [], executionReadset: captureCompanionExecutionReadset({ companionId: 'bob', conversationId: child.id }) });
  store.updateAction(action.id, { status: 'succeeded', result: '实际核对完成。' });
  const message = store.appendMessage({ conversationId: child.id, authorId: 'bob', kind: 'action', actionId: action.id, content: '实际核对完成。' });
  const anchor = store.appendMessage({ conversationId: child.id, authorId: 'user', content: '同一实际私聊中的独立输入。', replyDirective: 'none' });
  const identity = {}, authorityIdentity = {}, order: string[] = [];
  const storage = async (command: CompanionStorageCommand) => {
    if (command.type === 'execution.sources') order.push('sources');
    return store.request(command);
  };
  const read = (includeAnchor = false) => guardCompanionExecutionSources({ type: 'messages', conversationId: child.id }, { ok: true,
    messages: [message, ...(includeAnchor ? [anchor] : [])] }, {
    storage, identity, revision: () => 0, valid: async () => true,
    actionAuthorities: proofs => memoCompanionExecutionAuthorities(proofs, async current => {
      order.push('authority');
      let allowed = false;
      try { allowed = store.request({ type: 'collaboration.read', companionId: 'bob', id: grant.id }).collaboration?.status === 'running'; }
      catch (error) { if (!(error instanceof CompanionPermissionDeniedError)) throw error; }
      return new Map(current.map(proof => [proof.id, allowed]));
    }, authorityIdentity),
  });
  await expect(withCompanionExecutionValidation(async () => {
    await read(true); await read(); expect(order).toEqual(['sources', 'authority']);
    store.request({ type: 'collaboration.cancel', companionId: 'alice', id: grant.id, reason: '撤回真实授权。' });
  })).rejects.toThrow('授权已经变化');
  expect(order).toEqual(['sources', 'authority', 'sources', 'authority']);
});

it('retains the conservative per-read path for a proof without a strong epoch', async () => {
  const f = fixture(), rawStorage = f.storage, identity = {};
  const storage = vi.fn(async (command: CompanionStorageCommand) => {
    const response = await rawStorage(command);
    if (response.executionSources) response.executionSources = response.executionSources.map(proof => {
      const legacy = { ...proof }; delete legacy.storageValidatedAuthorityEpoch; return legacy;
    });
    return response;
  });
  const read = () => guardCompanionExecutionSources({ type: 'message.get', id: f.messages[0]!.id }, { ok: true, message: f.messages[0] }, {
    storage, identity, revision: f.revision, valid: async () => true,
  });
  await withCompanionExecutionValidation(async () => { await read(); f.mutate(); await read(); });
  expect(f.sqlCount()).toBe(2);
});

it('cancels a cached finite session without invalidating its source and refuses reuse after closure', async () => {
  const f = fixture(), controller = new AbortController(), session = createCompanionExecutionValidationSession(controller.signal), reason = new Error('user_cancelled');
  await session.run(() => f.read()); await session.run(() => f.read()); expect(f.sqlCount()).toBe(1);
  controller.abort(reason);
  await expect(Promise.resolve().then(() => session.validate())).rejects.toBe(reason);
  await expect(session.run(() => f.read())).rejects.toBe(reason);
  session.close();
  expect(f.storage.mock.calls.some(([command]) => command.type === 'execution.invalidate')).toBe(false);
  const next = createCompanionExecutionValidationSession(); next.close();
  await expect(next.run(() => f.read())).rejects.toMatchObject({ name: 'AbortError' });
  await f.read(); expect(f.sqlCount()).toBe(3);
});
