import { createHash } from 'node:crypto';
import { stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionService } from '../../src/main/companions/service';
import type { CompanionConnection } from '../../src/companions/store';
import { verifyCompanionExecutionReadset, type CompanionAttestedMemoryFiles } from '../../src/main/companions/execution-evidence';
import { guardCompanionExecutionSources, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { companionReplyPublication } from '../../src/main/companions/reply-publication';
import { CompanionValidationUnavailableError } from '../../src/main/companions/validation-unavailable';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import type { CompanionMemoryFileReceipt } from '../../src/shared/companion-memory-files';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionMessagePublicationCandidate, CompanionMessagePublicationMode } from '../../src/shared/companion-message-publication';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {}, utilityProcess: { fork: vi.fn() } }));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Context = { revision: string; profileKey: string; fileReceiptOnly?: true; fileReceipts?: readonly CompanionMemoryFileReceipt[] };
type Host = { memoryContextValid(scope: { companionId: string; conversationId: string; beforeSequence?: number }, context: Context, files?: CompanionAttestedMemoryFiles): Promise<boolean> };

async function fixture() {
  const f = managedMemoryFiles(), source = f.source('本任务仍有权读取的真实原始事件。'), note = f.record('准确的封存输入。', [source.id]);
  await f.publish(); const receipts = (await f.live.materialize('alice', [note])).receipts;
  const message = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '', loopStep: 0, replyToId: source.id });
  const checkpoint: CompanionLoopCheckpoint = { ...f.scope, sourceMessageId: source.id, messageId: message.id, status: 'done',
    turns: [{ text: '根据准确来源完成的正式回复。', rawText: '根据准确来源完成的正式回复。', calls: [] }], supplements: [] };
  const readset: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, ...f.scope,
    beforeSequence: source.sequence, sources: [{ id: source.id, conversationId: source.conversationId, checksum: hash(source.content) }],
    memories: [], knowledgeReads: [], topics: [], frozenMemories: [{ id: note.id, contentRevision: note.contentRevision!,
      sources: note.sources.map(reference => ({ id: reference.messageId, conversationId: reference.conversationId, checksum: reference.checksum })) }],
    contexts: [{ revision: 'actual-published-task', profileKey: 'canonical-memory-files', beforeSequence: source.sequence, fileReceiptOnly: true, fileReceipts: receipts }] };
  const command = { type: 'loop.save', checkpoint, executionReadset: readset } as const;
  const db = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
  let unavailable = false;
  const request = async (input: CompanionStorageCommand) => {
    if (unavailable && input.type === 'execution.sources') throw new CompanionValidationUnavailableError('Actual current SQL transport unavailable.');
    return f.request(input);
  };
  const host = Object.assign(Object.create(CompanionService.prototype), { storage: { request }, sourceValidationRevision: 0, liveFiles: f.live,
    requireCurrentAssets: vi.fn(async () => undefined),
    memory: { contextValid: async (scope: { companionId: string }, context: Context) => f.live.validate(scope.companionId, context.fileReceipts ?? []) } }) as Host;
  const certificates = vi.fn(async (messages: readonly (CompanionMessagePublicationCandidate & { mode: CompanionMessagePublicationMode })[]) => {
    const result = await request({ type: 'execution.message.certify', messages: [...messages] });
    if (!result.ok) throw new Error(result.error);
  });
  const valid = (proof: Parameters<Parameters<typeof guardCompanionExecutionSources>[2]['valid']>[0], sqliteSourcesValidated?: boolean,
    publishedFileContexts?: Parameters<Parameters<typeof guardCompanionExecutionSources>[2]['valid']>[2]) =>
    verifyCompanionExecutionReadset(proof.executionReadset, proof, { sqliteSourcesValidated, publishedFileContexts, request,
      ...(proof.storageValidatedReadsetDigest && proof.storageValidatedAuthorityEpoch !== undefined ? { memoryFileAttestation: {
        readsetDigest: proof.storageValidatedReadsetDigest, authorityEpoch: proof.storageValidatedAuthorityEpoch } } : {}),
      contextValid: (scope, context, files) => host.memoryContextValid(scope, context, files) });
  const controller = new AbortController();
  const publish = (afterInitial?: () => Promise<void>) => withCompanionExecutionValidation(async () => {
    const response = await guardCompanionExecutionSources(command, f.store.request(command), { identity: f.store, revision: () => 0, storage: request, valid, certifyPublications: certificates });
    expect(companionReplyPublication(command, response)?.message.id).toBe(message.id);
    await afterInitial?.(); return response;
  }, controller.signal);
  const read = () => withCompanionExecutionValidation(() => guardCompanionExecutionSources({ type: 'message.get', id: message.id },
    f.store.request({ type: 'message.get', id: message.id }), { identity: f.store, revision: () => 0, storage: request, valid, certifyPublications: certificates }));
  const certificate = () => db.prepare('SELECT data FROM companion_message_publication_certificates WHERE message_id=?').get(message.id);
  return { f, source, note, message, checkpoint, readset, command, db, controller, certificates, publish, read, certificate,
    failTransport: () => { unavailable = true; }, close: async () => { db.close(); await f.close(); } };
}

it('publishes and certifies the actual terminal transaction before its first history read, while progress stays body-free', async () => {
  const h = await fixture();
  try {
    const running: Extract<CompanionStorageCommand, { type: 'loop.save' }> = { type: 'loop.save', checkpoint: { ...h.checkpoint, status: 'running', turns: [] } };
    h.f.commands.length = 0;
    const progress = await withCompanionExecutionValidation(() => guardCompanionExecutionSources(running, h.f.store.request(running), {
      storage: h.f.request, valid: vi.fn(async () => true), certifyPublications: h.certificates }));
    expect(progress).toEqual({ ok: true }); expect(h.f.commands.some(command => command.type === 'execution.sources')).toBe(false);
    expect(h.certificate()).toBeUndefined();
    const published = await h.publish(); expect(published.replyPublication?.message.content).toBe(h.checkpoint.turns[0]!.text);
    expect(published.replyPublication?.newlyPublished).toBe(true);
    expect(h.certificate()).toBeDefined(); expect(h.certificates).toHaveBeenCalledOnce();
    expect(h.certificates.mock.calls[0]![0].some(value => value.messageId === h.message.id && value.mode === 'new_publication')).toBe(true);
    expect((await h.read()).message?.content).toBe(h.checkpoint.turns[0]!.text); expect(h.certificates).toHaveBeenCalledOnce();
  } finally { await h.close(); }
});

it('labels a previously formal terminal replay as historical revalidation rather than a new publication fact', async () => {
  const h = await fixture();
  try {
    expect(h.f.store.request(h.command).replyPublication?.newlyPublished).toBe(true);
    expect(h.certificate()).toBeUndefined();
    expect((await h.publish()).replyPublication?.newlyPublished).toBe(false);
    expect(h.certificates).toHaveBeenCalledOnce();
    expect(h.certificates.mock.calls[0]![0].find(value => value.messageId === h.message.id)?.mode).toBe('revalidated_historical');
  } finally { await h.close(); }
});

it.each(['canonical', 'source', 'membership', 'unavailable', 'cancelled'] as const)('issues no certificate or committed callback when the actual %s gate changes after terminal initial admission', async failure => {
  const h = await fixture(); let committed = false, injected = false;
  try {
    const pending = h.publish(async () => {
      injected = true;
      if (failure === 'canonical') {
        const file = h.f.noteFile(h.note), previous = await stat(file);
        await writeFile(file, h.note.content.replace('封存', '篡改')); await utimes(file, previous.atime, previous.mtime);
      } else if (failure === 'source') h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [h.source.id], persistent: true });
      else if (failure === 'membership') h.db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(h.f.scope.conversationId, h.f.scope.companionId);
      else if (failure === 'unavailable') h.failTransport();
      else h.controller.abort(new DOMException('Task cancelled before formal publication.', 'AbortError'));
    }).then(() => { committed = true; });
    await expect(pending).rejects.toThrow(); expect(injected).toBe(true); expect(committed).toBe(false);
    expect(h.certificates).not.toHaveBeenCalled(); expect(h.certificate()).toBeUndefined();
  } finally { await h.close(); }
});

it('rejects a returned same-text receipt from a different recipient or source scope', async () => {
  const h = await fixture();
  try {
    const response = h.f.store.request(h.command); expect(response.replyPublication).toBeDefined();
    for (const patch of [{ companionId: 'bob' }, { conversationId: 'world_alice' }, { sourceMessageId: 'other_source' }, { executionReadsetDigest: hash('different actual readset') }])
      expect(() => companionReplyPublication(h.command, { ...response, replyPublication: { ...response.replyPublication!, ...patch } })).toThrow();
    expect(() => companionReplyPublication({ type: 'message.get', id: h.message.id }, response)).toThrow();
    expect(h.certificate()).toBeUndefined();
  } finally { await h.close(); }
});

it.each(['live', 'cancelled'] as const)('requires the actual cross-room collaboration grant at the %s terminal gate', async state => {
  const f = managedMemoryFiles();
  try {
    const source = f.source('请让另一位伙伴独立核验这项任务。');
    const grant = f.store.request({ type: 'collaboration.create', ...f.scope, sourceMessageId: source.id, title: '独立核验', goal: source.content,
      parentInvocationId: 'parent', evidence: [source.content], participants: [{ companionId: 'bob', goal: '独立核验这项任务。' }], clientId: 'publication-grant' }).collaboration!;
    const room = f.store.createConversation('协作执行入口', ['bob']), invocationKey = 'publication-invocation';
    f.store.request({ type: 'collaboration.respond', id: grant.id, companionId: 'bob', decision: 'accept', reason: '接受核验。' });
    f.store.request({ type: 'collaboration.start', id: grant.id, companionId: 'bob', conversationId: room.id, invocationId: invocationKey });
    const message = f.store.appendMessage({ conversationId: room.id, authorId: 'bob', content: '', loopStep: 0 });
    const checkpoint: CompanionLoopCheckpoint = { companionId: 'bob', conversationId: room.id, sourceMessageId: source.id, messageId: message.id,
      invocationKey, authorizationGrantId: grant.id, status: 'done', turns: [{ text: '已完成独立核验。', rawText: '已完成独立核验。', calls: [] }], supplements: [] };
    const executionReadset: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, companionId: 'bob',
      conversationId: room.id, sources: [], memories: [], frozenMemories: [], knowledgeReads: [], topics: [], contexts: [] };
    const command = { type: 'loop.save', checkpoint, executionReadset } as const;
    const certificates = vi.fn(async (messages: readonly (CompanionMessagePublicationCandidate & { mode: CompanionMessagePublicationMode })[]) => {
      expect((await f.request({ type: 'execution.message.certify', messages: [...messages] })).ok).toBe(true);
    });
    const pending = withCompanionExecutionValidation(async () => {
      const response = await guardCompanionExecutionSources(command, f.store.request(command), { identity: f.store, storage: f.request, certifyPublications: certificates,
        valid: (proof, sqliteSourcesValidated) => verifyCompanionExecutionReadset(proof.executionReadset, proof, { request: f.request, sqliteSourcesValidated }) });
      expect(companionReplyPublication(command, response)?.authorizationGrantId).toBe(grant.id);
      if (state === 'cancelled') f.store.request({ type: 'collaboration.cancel', id: grant.id, companionId: 'alice', reason: '发布前取消。' });
    });
    if (state === 'cancelled') { await expect(pending).rejects.toThrow(); expect(certificates).not.toHaveBeenCalled(); }
    else { await pending; expect(certificates.mock.calls.some(([messages]) => messages.some(value => value.messageId === message.id))).toBe(true); }
    expect(f.commands.filter(value => value.type === 'collaboration.read')).toHaveLength(2);
  } finally { await f.close(); }
});
