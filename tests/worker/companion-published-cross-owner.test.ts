import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionService } from '../../src/main/companions/service';
import { verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { createCompanionExecutionValidationSession, guardCompanionExecutionSources, withCompanionExecutionValidation,
  type CompanionExecutionSourceProof, type CompanionPublishedMessageContexts } from '../../src/main/companions/source-execution-evidence';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionMessagePublicationCandidate, CompanionMessagePublicationMode, CompanionPublishedActionFrontier } from '../../src/shared/companion-message-publication';
import { companionPublishedDependencyCutSchema } from '../../src/shared/companion-message-publication';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {}, utilityProcess: { fork: vi.fn() } }));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(withAction = true) {
  const f = managedMemoryFiles(), bobScope = { companionId: 'bob', conversationId: f.store.openPrivate('bob').id };
  const source = f.source('乙伙伴自己的私有原始事实。', 'bob');
  const note = f.store.request({ type: 'memory.record', ...bobScope, candidate: f.candidate('乙伙伴的私有准确输入正文。', [source.id]) }).memories![0]!;
  f.index(); await f.publish('bob'); const receipts = (await f.live.materialize('bob', [note])).receipts;
  const base: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, ...bobScope,
    memories: [], sources: [{ id: source.id, conversationId: source.conversationId, checksum: hash(source.content) }], knowledgeReads: [], topics: [],
    frozenMemories: [{ id: note.id, contentRevision: note.contentRevision!, sources: note.sources.map(value => ({ id: value.messageId, conversationId: value.conversationId, checksum: value.checksum })) }],
    contexts: [{ revision: 'private-owner-input', profileKey: 'canonical-files', fileReceiptOnly: true, fileReceipts: receipts }] };
  const action = withAction ? f.store.request({ type: 'action.create', action: { ...bobScope, sourceMessageId: source.id, title: '乙伙伴已经结束的私有任务', status: 'queued' },
    checkpoint: { prompt: '按自己的准确事实执行。', executionReadset: base } }).action! : undefined;
  if (action) f.store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: '乙伙伴的私有原任务成果。' } });
  const card = action ? f.store.request({ type: 'messages', conversationId: bobScope.conversationId }).messages!.find(value => value.actionId === action.id)! : undefined;
  const group = f.store.request({ type: 'conversation.create-group', title: '真实共享交流', memberIds: ['alice', 'bob'] }).conversation!;
  const initial = structuredClone(base); initial.conversationId = group.id;
  if (card) initial.sources.push({ id: card.id, conversationId: card.conversationId, checksum: hash(card.content) });
  let unavailableOwner: string | undefined;
  const revalidate = vi.fn(async (filter: { companionId?: string } = {}) => ({ changedCompanionIds: [], unavailableCompanionIds:
    filter.companionId === unavailableOwner ? [unavailableOwner!] : [], revokedSourceCount: 0 }));
  type Host = { actionAuthorities(proofs: readonly CompanionExecutionSourceProof[]): Promise<ReadonlyMap<string, boolean>>;
    requireExecutionSourceAssets(proof: CompanionExecutionSourceProof, published: boolean): Promise<void> };
  const host = Object.assign(Object.create(CompanionService.prototype), { storage: { request: f.request }, sourceValidationRevision: 0,
    assetValidations: new Map(), options: { learningAssets: { revalidate } } }) as Host;
  const certify = async (messages: readonly (CompanionMessagePublicationCandidate & { mode: CompanionMessagePublicationMode })[], actionBindings?: readonly CompanionPublishedActionFrontier[]) => {
    const result = await f.request({ type: 'execution.message.certify', messages: [...messages], ...(actionBindings ? { actionBindings: [...actionBindings] } : {}) });
    if (!result.ok) throw new Error('Actual private certification refused.');
  };
  const read = (messages: CompanionMessage[], publish = false) => guardCompanionExecutionSources({ type: 'messages', conversationId: group.id }, { ok: true, messages }, {
    identity: f.store, storage: f.request, revision: () => 0, actionAuthorities: proofs => host.actionAuthorities(proofs),
    ...(publish ? { certifyPublications: certify } : {}),
    valid: async (proof, sqliteSourcesValidated, published: CompanionPublishedMessageContexts | undefined) => {
      await host.requireExecutionSourceAssets(proof, !!published);
      return verifyCompanionExecutionReadset(proof.executionReadset, proof, { sqliteSourcesValidated, publishedFileContexts: published,
        request: f.request, contextValid: scope => f.live.validate(scope.companionId, receipts) });
    },
  });
  const messages: CompanionMessage[] = [];
  for (let index = 0; index < 12; index++) {
    const owner = index % 2 ? 'alice' : 'bob', previous = messages.at(-1);
    const readset: CompanionExecutionReadset = previous ? { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, companionId: owner,
      conversationId: group.id, memories: [], sources: [{ id: previous.id, conversationId: previous.conversationId, checksum: hash(previous.content) }],
      knowledgeReads: [], topics: [], contexts: [] } : initial;
    const message = f.store.appendMessage({ conversationId: group.id, authorId: owner, content: '这是共享房间的正式发言 ' + index, executionReadset: readset });
    expect((await withCompanionExecutionValidation(() => read([message], true))).messages?.[0]?.content).toBe(message.content); messages.push(message);
  }
  const resolve = (ids = [messages.at(-1)!.id]) => f.store.request({ type: 'execution.sources', sourceMessageIds: ids }).executionSources!;
  const sql = (operation: (db: CompanionConnection) => void) => {
    const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
    db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens); db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
    try { operation(db); } finally { db.close(); }
  };
  return { f, source, note, action, card, group, bobScope, messages, host, read, resolve, revalidate, sql,
    unavailable: (owner?: string) => { unavailableOwner = owner; } };
}

it('keeps alternating shared chat as immutable leaves plus the exact foreign action and preserves private bodies behind the host-only proof boundary', async () => {
  const h = await fixture();
  try {
    const latest = h.messages.at(-1)!, proofs = h.resolve();
    expect(proofs.map(proof => proof.kind).sort()).toEqual(['action', 'message']);
    const root = proofs.find(proof => proof.kind === 'message')!, action = proofs.find(proof => proof.kind === 'action')!;
    expect(root.companionId).toBe('alice'); expect(root.publishedDependencyCut?.assetOwners).toEqual(['alice', 'bob']);
    expect(action.companionId).toBe('bob'); expect(action.storageActionBinding?.companionId).toBe('bob'); expect(action.sourceMessageIds).toEqual([latest.id]);
    const response = await withCompanionExecutionValidation(() => h.read([latest]));
    expect(response.messages?.map(message => message.content)).toEqual([latest.content]);
    expect(JSON.stringify(response)).not.toContain(h.note.content); expect(JSON.stringify(response)).not.toContain(h.source.content);
    expect(() => h.f.store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: h.bobScope.conversationId, ids: [h.source.id] })).toThrow('聊天成员');
    h.f.restart(); expect(h.resolve().map(proof => proof.kind).sort()).toEqual(['action', 'message']);
  } finally { await h.f.close(); }
});

it.each([true, false])('freshly checks every folded asset owner at the final Main gate without turning a foreign infrastructure outage into source withdrawal (action=%s)', async withAction => {
  const h = await fixture(withAction), session = createCompanionExecutionValidationSession();
  try {
    expect(h.resolve()).toHaveLength(withAction ? 2 : 1);
    expect(h.resolve().find(proof => proof.kind === 'message')?.publishedDependencyCut?.assetOwners).toEqual(['alice', 'bob']);
    h.revalidate.mockClear();
    expect((await session.run(() => h.read([h.messages.at(-1)!]))).messages?.[0]?.content).toBe(h.messages.at(-1)!.content);
    expect(h.revalidate.mock.calls.map(([filter]) => filter?.companionId)).toEqual(['alice', 'bob']);
    h.unavailable('bob'); await expect(session.validate()).rejects.toMatchObject({ code: 'NETWORK' });
    expect(h.revalidate.mock.calls.map(([filter]) => filter?.companionId)).toEqual(['alice', 'bob', 'alice', 'bob']);
    h.sql(db => expect(db.prepare("SELECT COUNT(*) AS count FROM metadata WHERE key GLOB 'execution-source-invalid/*'").get()).toEqual({ count: 0 }));
    if (h.action) expect(h.f.store.getAction(h.action.id).status).toBe('succeeded');
  } finally { session.close(); await h.f.close(); }
});

it('retains the foreign action real canonical-byte gate after message ancestry is folded', async () => {
  const h = await fixture();
  try {
    await writeFile(h.f.noteFile(h.note), '外部改写了另一个伙伴原任务的真实输入。');
    await expect(withCompanionExecutionValidation(() => h.read([h.messages.at(-1)!]))).rejects.toThrow('执行来源的授权已经变化');
    expect(h.f.store.getAction(h.action!.id).status).toBe('succeeded');
  } finally { await h.f.close(); }
});

it.each(['reader-exit', 'reader-forget', 'reader-observer', 'author-private-forget'] as const)('keeps exact foreign-author and parent-reader live authority: %s', async change => {
  const h = await fixture();
  try {
    const latest = h.messages.at(-1)!, shared = h.messages[0]!;
    expect(h.resolve()).toHaveLength(2);
    if (change === 'reader-exit') h.f.store.request({ type: 'conversation.update', id: h.group.id, memberIds: ['bob'] });
    if (change === 'reader-forget') h.f.store.request({ type: 'memory.forget', companionId: 'alice', conversationId: h.group.id, sourceMessageIds: [shared.id], persistent: true });
    if (change === 'reader-observer') h.sql(db => db.prepare('DELETE FROM vcp_source_observers WHERE companion_id=? AND message_id=?').run('alice', shared.id));
    if (change === 'author-private-forget') h.f.store.request({ type: 'memory.forget', ...h.bobScope, sourceMessageIds: [h.source.id], persistent: true });
    expect(h.resolve().find(proof => proof.id === latest.id)?.publishedDependencyCut).toBeUndefined();
    if (change !== 'reader-exit') expect(h.f.store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: h.group.id, ids: [latest.id] }).memorySources).toEqual([]);
  } finally { await h.f.close(); }
});

it('rejects missing, reordered, duplicate or mismatched asset-owner witnesses rather than defaulting to the current author', async () => {
  const h = await fixture();
  try {
    const proof = h.resolve().find(proof => proof.kind === 'message')!, cut = proof.publishedDependencyCut!;
    for (const owners of [[], ['bob', 'alice'], ['alice', 'alice']]) expect(companionPublishedDependencyCutSchema.safeParse({ ...cut, assetOwners: owners }).success).toBe(false);
    await expect(h.host.requireExecutionSourceAssets({ ...proof, publishedDependencyCut: { ...cut, assetOwners: ['bob'] } }, true)).rejects.toMatchObject({ code: 'EXECUTION_VALIDATION_UNAVAILABLE' });
    await expect(h.host.requireExecutionSourceAssets({ ...proof, publishedDependencyCut: { ...cut, assetOwners: ['alice'] } }, true)).rejects.toMatchObject({ code: 'EXECUTION_VALIDATION_UNAVAILABLE' });
  } finally { await h.f.close(); }
});
