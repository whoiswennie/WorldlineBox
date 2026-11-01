import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionService } from '../../src/main/companions/service';
import { verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { createCompanionExecutionValidationSession, guardCompanionExecutionSources, withCompanionExecutionValidation, type CompanionExecutionSourceProof,
  type CompanionPublishedMessageContexts } from '../../src/main/companions/source-execution-evidence';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionMessagePublicationCandidate, CompanionMessagePublicationMode, CompanionPublishedActionFrontier } from '../../src/shared/companion-message-publication';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { readPublishedMessageActionPins } from '../../src/companions/published-message-action-pins';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {}, utilityProcess: { fork: vi.fn() } }));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture(count = 12, certifyEach = true) {
  const f = managedMemoryFiles(), source = f.source('早先真实发生且当前仍有权读取的原始事件。'), note = f.record('正式准确的任务输入。', [source.id]);
  await f.publish(); const receipts = (await f.live.materialize('alice', [note])).receipts;
  const base: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, ...f.scope,
    memories: [], sources: [{ id: source.id, conversationId: source.conversationId, checksum: hash(source.content) }], knowledgeReads: [], topics: [],
    frozenMemories: [{ id: note.id, contentRevision: note.contentRevision!, sources: note.sources.map(value => ({ id: value.messageId, conversationId: value.conversationId, checksum: value.checksum })) }],
    contexts: [{ revision: 'exact-task', profileKey: 'canonical-files', fileReceiptOnly: true, fileReceipts: receipts }] };
  const actions = Array.from({ length: 2 }, (_, index) => {
    const action = f.store.request({ type: 'action.create', action: { ...f.scope, sourceMessageId: source.id, title: `已结束的真实任务 ${index}`, status: 'queued' },
      checkpoint: { prompt: '按真实原始事件处理。', executionReadset: base } }).action!;
    f.store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: `真实任务成果 ${index}` } }); return action;
  });
  const cards = f.store.request({ type: 'messages', conversationId: f.scope.conversationId }).messages!.filter(value => actions.some(action => action.id === value.actionId));
  expect(cards).toHaveLength(2);
  const messages: CompanionMessage[] = [];
  for (let index = 0; index < count; index++) {
    const previous = messages.at(-1), proof = structuredClone(base);
    proof.sources.push(...cards.map(value => ({ id: value.id, conversationId: value.conversationId, checksum: hash(value.content) })),
      ...(previous ? [{ id: previous.id, conversationId: previous.conversationId, checksum: hash(previous.content) }] : []));
    const message = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: `这是一条正式连续发言 ${index}。`, executionReadset: proof });
    const observed = f.store.request({ type: 'execution.sources', sourceMessageIds: [message.id] }).executionSources!;
    const candidate = observed.find(value => value.id === message.id)!.publicationCandidate!;
    expect(candidate).toBeDefined();
    if (certifyEach) f.store.request({ type: 'execution.message.certify', messages: [{ ...candidate, mode: 'revalidated_historical' }],
      actionBindings: observed.flatMap(value => value.storageActionBinding ? [value.storageActionBinding] : []) }); messages.push(message);
  }
  const resolve = (ids = messages.map(message => message.id)) => f.store.request({ type: 'execution.sources', sourceMessageIds: ids }).executionSources!;
  const sql = (work: (db: CompanionConnection) => void) => {
    const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
    db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens); db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
    try { work(db); } finally { db.close(); }
  };
  return { f, source, note, receipts, base, actions, cards, messages, resolve, sql };
}

it('returns 39 requested immutable message leaves and exactly two original action obligations with every root association', async () => {
  const h = await fixture(39);
  try {
    const latest = h.messages.at(-1)!, single = h.resolve([latest.id]);
    expect(single.map(value => value.kind).sort()).toEqual(['action', 'action', 'message']);
    expect(single.every(value => value.publishedDependencyCut)).toBe(true);
    const all = h.resolve(), roots = h.messages.map(value => value.id).sort();
    expect(all.filter(value => value.kind === 'message').map(value => value.id).sort()).toEqual(roots);
    const actions = all.filter(value => value.kind === 'action');
    expect(actions.map(value => value.id).sort()).toEqual(h.actions.map(value => value.id).sort());
    expect(actions.every(value => JSON.stringify([...value.sourceMessageIds].sort()) === JSON.stringify(roots))).toBe(true);
    expect(actions.every(value => !value.publicationCertificate && value.executionReadset?.complete)).toBe(true);
    expect(all.filter(value => value.kind === 'message').every(value => value.publishedDependencyCut?.volatileActions.length === 2)).toBe(true);
    h.f.restart(); expect(h.resolve([latest.id])).toHaveLength(3);
  } finally { await h.f.close(); }
});

it('keeps actual Main action/file/final authority checks after the resolver cuts ordinary message ancestry', async () => {
  const h = await fixture(5), latest = h.messages.at(-1)!;
  try {
    const owner = Object.assign(Object.create(CompanionService.prototype), { storage: { request: h.f.request },
      sourceValidationRevision: 0, requireCurrentAssets: async () => undefined }) as { actionAuthorities(proofs: readonly CompanionExecutionSourceProof[]): Promise<ReadonlyMap<string, boolean>> };
    const actionAuthorities = vi.fn((values: readonly CompanionExecutionSourceProof[]) => owner.actionAuthorities(values));
    const contexts = vi.fn(async (scope: { companionId: string }, context: { revision: string; profileKey: string }) =>
      h.f.live.validate(scope.companionId, h.base.contexts.find(value => value.revision === context.revision)?.fileReceipts ?? []));
    const read = () => withCompanionExecutionValidation(() => guardCompanionExecutionSources({ type: 'message.get', id: latest.id },
      h.f.store.request({ type: 'message.get', id: latest.id }), { identity: h.f.store, revision: () => 0, storage: h.f.request, actionAuthorities,
        valid: (proof, sqliteSourcesValidated, publishedFileContexts) => verifyCompanionExecutionReadset(proof.executionReadset, proof, {
          sqliteSourcesValidated, publishedFileContexts, request: h.f.request, contextValid: contexts }) }));
    expect((await read()).message?.content).toBe(latest.content);
    expect(contexts).toHaveBeenCalledTimes(2); // Both original action bodies, no message ancestry.
    expect(actionAuthorities.mock.calls[0]![0].map(value => value.id).sort()).toEqual(h.actions.map(value => value.id).sort());
    expect(actionAuthorities.mock.calls.length).toBeGreaterThanOrEqual(2);
    await writeFile(h.f.noteFile(h.note), '真实任务原输入文件被外部改写。');
    // The initial live check succeeded before the byte failure invalidated its
    // action. The final live check must reject that same consumed binding.
    await expect(read()).rejects.toThrow('执行来源的授权已经变化');
    expect((await read()).message?.content).toBe('');
    expect(h.f.store.getAction(h.actions[0]!.id).status).toBe('succeeded');
  } finally { await h.f.close(); }
});

it.each(['forget', 'observer', 'cursor', 'cycle'] as const)('preserves the original current source/reader gate after structural cuts: %s', async change => {
  const h = await fixture(3), latest = h.messages.at(-1)!;
  try {
    expect(h.resolve([latest.id])).toHaveLength(3);
    if (change === 'forget') h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [h.source.id], persistent: true });
    if (change === 'observer') h.sql(db => db.prepare('DELETE FROM vcp_source_observers WHERE companion_id=? AND message_id=?').run('alice', h.source.id));
    if (change === 'cycle') h.sql(db => {
      const row = db.prepare('SELECT value FROM metadata WHERE key=?').get('message-execution-readset/' + latest.id) as { value: string };
      const readset = JSON.parse(row.value) as CompanionExecutionReadset;
      readset.sources.push({ id: latest.id, conversationId: latest.conversationId, checksum: hash(latest.content) });
      db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(readset), 'message-execution-readset/' + latest.id);
    });
    expect(h.f.store.request({ type: 'memory.sources.filter', ...h.f.scope,
      ...(change === 'cursor' ? { beforeSequence: latest.sequence - 1 } : {}), ids: [latest.id] }).memorySources).toEqual([]);
    if (change !== 'cursor') expect(h.resolve([latest.id]).find(value => value.id === latest.id)?.publishedDependencyCut).toBeUndefined();
  } finally { await h.f.close(); }
});

it.each(['result', 'thought'] as const)('rejects a first-certification action %s change after Main captured its exact SQL header', async change => {
  const h = await fixture(2);
  try {
    const readset = structuredClone(h.base);
    readset.sources.push(...h.cards.map(card => ({ id: card.id, conversationId: card.conversationId, checksum: hash(card.content) })));
    const message = h.f.store.appendMessage({ conversationId: h.f.scope.conversationId, authorId: 'alice', content: '尚未认证的本次真实发言。', executionReadset: readset });
    const before = h.resolve([message.id]), candidate = before.find(value => value.id === message.id)!.publicationCandidate!;
    const actionBindings = before.flatMap(value => value.storageActionBinding ? [value.storageActionBinding] : []);
    expect(actionBindings).toHaveLength(2);
    h.sql(db => change === 'result'
      ? db.prepare("UPDATE actions SET data=json_set(data,'$.result',?) WHERE id=?").run('Main围栏以后才变更的实际结果。', h.actions[0]!.id)
      : db.prepare("UPDATE actions SET data=json_set(data,'$.thought',json(?)) WHERE id=?").run('{}', h.actions[0]!.id));
    expect(() => h.f.store.request({ type: 'execution.message.certify', messages: [{ ...candidate, mode: 'revalidated_historical' }], actionBindings })).toThrow();
    expect(h.resolve([message.id]).find(value => value.id === message.id)?.publicationCertificate).toBeUndefined();
  } finally { await h.f.close(); }
});

it('pins only each candidate actual action subset instead of contaminating an independent message with the batch action union', async () => {
  const h = await fixture(2);
  try {
    const independent = h.f.store.appendMessage({ conversationId: h.f.scope.conversationId, authorId: 'alice', content: '这条独立发言没有读取旧任务。', executionReadset: h.base });
    const latest = h.messages.at(-1)!, observed = h.resolve([independent.id, latest.id]);
    const candidates = [independent.id, latest.id].map(id => observed.find(value => value.id === id)!.publicationCandidate!);
    const result = h.f.store.request({ type: 'execution.message.certify', messages: candidates.map(candidate => ({ ...candidate, mode: 'revalidated_historical' })),
      actionBindings: observed.flatMap(value => value.storageActionBinding ? [value.storageActionBinding] : []) });
    const certificate = result.messagePublicationCertificates!.find(value => value.messageId === independent.id)!;
    h.sql(db => expect(readPublishedMessageActionPins(db, certificate)).toEqual([]));
    const roots = h.resolve([independent.id]);
    expect(roots).toHaveLength(1); expect(roots[0]!.publishedDependencyCut?.volatileActions).toEqual([]);
    expect(h.resolve([latest.id])).toHaveLength(3);
  } finally { await h.f.close(); }
});

it('migrates a cold page newest first after every actual consumed action pin is settled in the same transaction', async () => {
  const h = await fixture(12, false);
  try {
    const observed = h.resolve(), newestFirst = [...h.messages].reverse();
    expect(observed.some(value => value.publishedDependencyCut)).toBe(false);
    const candidates = newestFirst.map(message => observed.find(value => value.id === message.id)!.publicationCandidate!);
    h.f.store.request({ type: 'execution.message.certify', messages: candidates.map(candidate => ({ ...candidate, mode: 'revalidated_historical' })),
      actionBindings: observed.flatMap(value => value.storageActionBinding ? [value.storageActionBinding] : []) });
    const actual = h.resolve();
    expect(actual).toHaveLength(14);
    expect(actual.every(value => value.publishedDependencyCut)).toBe(true);
    expect(h.resolve([newestFirst[0]!.id])).toHaveLength(3);
  } finally { await h.f.close(); }
});

function readers(h: Awaited<ReturnType<typeof fixture>>, options: { request?: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>; beforeFile?(): Promise<void>; revision?(): number } = {}) {
  const request = options.request ?? h.f.request;
  const host = Object.assign(Object.create(CompanionService.prototype), { storage: { request: h.f.request },
    sourceValidationRevision: 0, requireCurrentAssets: async () => undefined }) as { actionAuthorities(proofs: readonly CompanionExecutionSourceProof[]): Promise<ReadonlyMap<string, boolean>> };
  const port = (identity: object, certify = false) => ({ identity, revision: options.revision ?? (() => 0), storage: request,
    actionAuthorities: (proofs: readonly CompanionExecutionSourceProof[]) => host.actionAuthorities(proofs),
    valid: (proof: CompanionExecutionSourceProof, sqliteSourcesValidated?: boolean, publishedFileContexts?: CompanionPublishedMessageContexts) =>
      verifyCompanionExecutionReadset(proof.executionReadset, proof, { sqliteSourcesValidated, publishedFileContexts, request,
        contextValid: async scope => { await options.beforeFile?.(); return h.f.live.validate(scope.companionId, h.receipts); } }),
    ...(certify ? { certifyPublications: async (messages: readonly (CompanionMessagePublicationCandidate & { mode: CompanionMessagePublicationMode })[],
      actionBindings?: readonly CompanionPublishedActionFrontier[]) => {
      await h.f.request({ type: 'execution.message.certify', messages: [...messages], ...(actionBindings ? { actionBindings: [...actionBindings] } : {}) });
    } } : {}) });
  const read = (messages: CompanionMessage[], identity: object, certify = false) => guardCompanionExecutionSources({ type: 'messages', conversationId: h.f.scope.conversationId },
    { ok: true, messages }, port(identity, certify));
  return { read, certify: () => withCompanionExecutionValidation(() => read(h.messages, {}, true)) };
}

function advancingReader(h: Awaited<ReturnType<typeof fixture>>, weak = false) {
  let revision = 0, observations = 0;
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    const response = await h.f.request(command);
    if (command.type !== 'execution.sources') return response;
    if (++observations === 1) {
      // A real unrelated capture commits while Main is awaiting this raw
      // observation. It changes neither the observed sources nor their epoch.
      const source = h.f.source('与这批已正式发布发言无关的新事实。'); h.f.record('另一条未被本轮消费的新记忆。', [source.id]); revision += 2;
    }
    return weak ? { ...response, executionSources: response.executionSources?.map(proof => {
      const { storageValidatedAuthorityEpoch: _epoch, ...legacy } = proof; void _epoch; return legacy;
    }) } : response;
  });
  return { request, r: readers(h, { request, revision: () => revision }), advance: () => { revision += 2; },
    count: () => request.mock.calls.filter(([command]) => command.type === 'execution.sources').length };
}

it('retains one finite 39-message/two-action observation when an unrelated real capture advances Main generation during its SQL await', async () => {
  const h = await fixture(39), session = createCompanionExecutionValidationSession(), identity = {}, observed = advancingReader(h);
  try {
    expect(h.resolve()).toHaveLength(41);
    expect((await session.run(() => observed.r.read(h.messages, identity))).messages?.map(value => value.content)).toEqual(h.messages.map(value => value.content));
    expect(observed.count()).toBe(1);
    expect((await session.run(() => observed.r.read(h.messages, identity))).messages).toHaveLength(39); expect(observed.count()).toBe(1);
    await session.validate(); expect(observed.count()).toBe(2); // One real final union, never a reused final SQL view.
    h.sql(db => expect(db.prepare("SELECT COUNT(*) AS count FROM metadata WHERE key GLOB 'execution-source-invalid/*'").get()).toEqual({ count: 0 }));
  } finally { session.close(); await h.f.close(); }
});

it.each(['rewrite', 'withdraw'] as const)('rejects an actually changed %s source at the fresh final union after the strong observation survived unrelated generation movement', async change => {
  const h = await fixture(3), session = createCompanionExecutionValidationSession(), identity = {}, observed = advancingReader(h);
  try {
    await session.run(() => observed.r.read(h.messages, identity)); expect(observed.count()).toBe(1);
    if (change === 'rewrite') h.sql(db => db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('被外部SQL改写的实际来源。', h.source.id));
    else h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [h.source.id], persistent: true });
    observed.advance(); let publishable = false;
    await expect((async () => { await session.validate(); publishable = true; })()).rejects.toThrow(/执行依赖|来源|授权/u);
    expect(publishable).toBe(false); expect(observed.count()).toBe(2);
    expect(observed.request.mock.calls.some(([command]) => command.type === 'execution.invalidate')).toBe(false);
    expect(h.f.store.getAction(h.actions[0]!.id).status).toBe('succeeded');
  } finally { session.close(); await h.f.close(); }
});

it('does not promote a legacy epoch-less observation into finite strong reuse after the same unrelated capture', async () => {
  const h = await fixture(3), session = createCompanionExecutionValidationSession(), identity = {}, observed = advancingReader(h, true);
  try {
    expect((await session.run(() => observed.r.read(h.messages, identity))).messages).toHaveLength(3);
    const first = observed.count(); expect(first).toBeGreaterThanOrEqual(2); // Legacy generation movement keeps its original fresh recheck.
    expect((await session.run(() => observed.r.read(h.messages, identity))).messages).toHaveLength(3);
    expect(observed.count()).toBeGreaterThan(first);
    await session.validate();
    expect(observed.request.mock.calls.some(([command]) => command.type === 'execution.invalidate')).toBe(false);
  } finally { session.close(); await h.f.close(); }
});

it.each([false, true])('keeps an initial full boundary through another healthy reader migration and a second frame entry (different port=%s)', async differentPort => {
  const h = await fixture(4, false), r = readers(h), session = createCompanionExecutionValidationSession(), identity = {};
  try {
    await session.run(() => r.read([h.messages.at(-1)!], identity));
    expect(h.resolve().some(value => value.publishedDependencyCut)).toBe(false);
    await r.certify(); expect(h.resolve().every(value => value.publishedDependencyCut)).toBe(true);
    await session.run(() => r.read([h.messages[1]!], differentPort ? {} : identity));
    await expect(session.validate()).resolves.toBeUndefined();
  } finally { session.close(); await h.f.close(); }
});

it('serializes only two same-frame raw observations while a third reader migrates the index, then admits the second before the first file gate settles', async () => {
  const h = await fixture(4, false), session = createCompanionExecutionValidationSession(), identity = {};
  const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
  const rawEntered = gate(), releaseRaw = gate(), fileEntered = gate(), releaseFile = gate(), secondRaw = gate();
  let calls = 0, heldFile = false;
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type !== 'execution.sources') return h.f.request(command);
    const ordinal = ++calls;
    const response = await h.f.request(command);
    if (ordinal === 1) { rawEntered.release(); await releaseRaw.promise; }
    if (ordinal === 2) {
      await fileEntered.promise;
      expect(command.expandPublishedSources?.some(value => value.id === h.messages.at(-1)!.id && value.kind === 'message')).toBe(true);
      expect(response.executionSources?.every(value => !value.publishedDependencyCut)).toBe(true);
      secondRaw.release();
    }
    return response;
  });
  const r = readers(h, { request, beforeFile: async () => { if (!heldFile) { heldFile = true; fileEntered.release(); await releaseFile.promise; } } });
  const first = session.run(() => r.read([h.messages.at(-1)!], identity));
  let second: Promise<CompanionStorageResponse> | undefined;
  try {
    await rawEntered.promise;
    second = session.run(() => r.read([h.messages[1]!], identity));
    await Promise.resolve(); expect(calls).toBe(1);
    await readers(h).certify(); // Another real Main frame completes independently.
    expect(h.resolve().every(value => value.publishedDependencyCut)).toBe(true);
    releaseRaw.release(); await fileEntered.promise;
    await vi.waitFor(() => expect(calls).toBe(2)); await secondRaw.promise;
    // A's file gate is still held; B has already received the accurate full
    // representation established by A's raw SQL observation.
    releaseFile.release(); await Promise.all([first, second]);
    await expect(session.validate()).resolves.toBeUndefined();
  } finally { releaseRaw.release(); releaseFile.release(); await Promise.allSettled([first, ...second ? [second] : []]); session.close(); await h.f.close(); }
});

it('rejects loss of a previously consumed cut, while accepting a healthy same-binding rebuild at a new index generation', async () => {
  const h = await fixture(3), r = readers(h), latest = h.messages.at(-1)!;
  try {
    for (const restore of [false, true]) {
      if (restore) await r.certify();
      const session = createCompanionExecutionValidationSession();
      try {
        await session.run(() => r.read([latest], {}));
        h.sql(db => db.prepare('DELETE FROM companion_message_publication_action_pins WHERE message_id=?').run(latest.id));
        expect(h.resolve([latest.id]).find(value => value.id === latest.id)?.publishedDependencyCut).toBeUndefined();
        if (restore) { await r.certify(); await expect(session.validate()).resolves.toBeUndefined(); }
        else await expect(session.validate()).rejects.toThrow('执行依赖已经变化');
        h.sql(db => expect(db.prepare("SELECT COUNT(*) AS count FROM metadata WHERE key GLOB 'execution-source-invalid/*'").get()).toEqual({ count: 0 }));
      } finally { session.close(); }
    }
  } finally { await h.f.close(); }
});
