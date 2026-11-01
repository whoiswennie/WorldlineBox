import { createHash } from 'node:crypto';
import { stat, utimes, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionService } from '../../src/main/companions/service';
import { verifyCompanionExecutionReadset, type CompanionAttestedMemoryFiles } from '../../src/main/companions/execution-evidence';
import { createCompanionExecutionValidationSession, guardCompanionExecutionSources, memoCompanionExecutionAdmission,
  withCompanionExecutionValidation, type CompanionExecutionSourceProof, type CompanionPublishedMessageContexts } from '../../src/main/companions/source-execution-evidence';
import type { CompanionMemoryFileReceipt } from '../../src/shared/companion-memory-files';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import type { CompanionMessagePublicationCandidate, CompanionMessagePublicationMode } from '../../src/shared/companion-message-publication';
import type { CompanionStorageResponse } from '../../src/shared/companion-storage';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {}, utilityProcess: { fork: vi.fn() } }));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
type Context = { revision: string; profileKey: string; fileReceiptOnly?: true; fileReceipts?: readonly CompanionMemoryFileReceipt[] };
type Host = { memoryContextValid(scope: Scope, context: Context, files?: CompanionAttestedMemoryFiles): Promise<boolean> };

async function fixture() {
  const f = managedMemoryFiles(), source = f.source('已经发生的真实原始事件。'), note = f.record('准确的封存输入。', [source.id]);
  await f.publish();
  const receipts = (await f.live.materialize('alice', [note])).receipts;
  const readset: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, ...f.scope,
    beforeSequence: source.sequence, memories: [], sources: [], knowledgeReads: [], topics: [],
    frozenMemories: [{ id: note.id, contentRevision: note.contentRevision!, sources: note.sources.map(reference => ({ id: reference.messageId,
      conversationId: reference.conversationId, checksum: reference.checksum, revision: reference.revision })) }],
    contexts: [{ revision: 'published-task', profileKey: 'canonical-memory-files', fileReceiptOnly: true, fileReceipts: receipts, beforeSequence: source.sequence }] };
  const message = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '这是一条已经正式发出的历史回复。', executionReadset: readset });
  const assets = vi.fn(async () => undefined), contextValid = vi.fn(async (scope: Scope, context: Context) => f.live.validate(scope.companionId, context.fileReceipts ?? []));
  const host = Object.assign(Object.create(CompanionService.prototype), { storage: { request: f.request }, sourceValidationRevision: 0,
    liveFiles: f.live, requireCurrentAssets: assets, memory: { contextValid } }) as Host;
  const certificates = vi.fn(async (messages: readonly (CompanionMessagePublicationCandidate & { mode: CompanionMessagePublicationMode })[]) => {
    const result = await f.request({ type: 'execution.message.certify', messages: [...messages] });
    if (!result.ok) throw new Error(result.error ?? 'Certification failed.');
  });
  const command = { type: 'message.get' as const, id: message.id };
  const valid = async (proof: CompanionExecutionSourceProof, sqliteSourcesValidated?: boolean, publishedFileContexts?: CompanionPublishedMessageContexts) => {
    if (publishedFileContexts) await assets();
    return verifyCompanionExecutionReadset(proof.executionReadset, proof, { sqliteSourcesValidated, publishedFileContexts, request: f.request,
      ...(proof.storageValidatedReadsetDigest && proof.storageValidatedAuthorityEpoch !== undefined ? { memoryFileAttestation: {
        readsetDigest: proof.storageValidatedReadsetDigest, authorityEpoch: proof.storageValidatedAuthorityEpoch } } : {}),
      contextValid: (scope, context, files) => host.memoryContextValid(scope, context, files) });
  };
  const read = () => withCompanionExecutionValidation(() => guardCompanionExecutionSources(command, f.store.request(command), {
    identity: f.store, storage: f.request, revision: () => 0, valid, certifyPublications: certificates,
  }));
  const stored = () => f.store.request({ type: 'execution.sources', sourceMessageIds: [message.id], memoryIds: [] }).executionSources!
    .find(proof => proof.id === message.id)!;
  return { f, source, note, receipts, message, readset, host, assets, contextValid, certificates, read, stored };
}

it('certifies an actual full historical read, then keeps published text after a same-stat current-file edit while direct memory still checks bytes', async () => {
  const h = await fixture();
  try {
    expect(h.stored().publicationCandidate).toBeDefined();
    expect(h.stored().publicationCertificate).toBeUndefined(); // Store.append never mints Main authority.
    const canonical = vi.spyOn(h.f.live, 'validateAttested');
    expect((await h.read()).message?.content).toBe(h.message.content);
    expect(canonical).toHaveBeenCalledOnce();
    expect(h.certificates).toHaveBeenCalledOnce();
    expect(h.stored().publicationCertificate?.mode).toBe('revalidated_historical');
    const file = h.f.noteFile(h.note), before = await stat(file);
    await writeFile(file, h.note.content.replace('准确', '篡改')); await utimes(file, before.atime, before.mtime);
    h.f.commands.length = 0;
    expect((await h.read()).message?.content).toBe(h.message.content);
    expect(canonical).toHaveBeenCalledOnce();
    expect(h.assets).toHaveBeenCalled();
    expect(h.f.commands.filter(command => command.type === 'cognition.registry.read')).toHaveLength(0);
    expect(await h.f.live.validate('alice', h.receipts)).toBe(false);
    expect(h.certificates).toHaveBeenCalledOnce();
    h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [h.source.id], persistent: true });
    const revoked = await h.read();
    expect(revoked.message?.content).toBe(''); expect(revoked.message?.sourceUnavailable).toBe('execution_source_changed');
    expect(h.stored().publicationCertificate).toBeUndefined();
    expect(h.certificates).toHaveBeenCalledOnce();
  } finally { await h.f.close(); }
});

it.each(['final-failure', 'cancelled'] as const)('does not persist a real SQL certificate after complete initial admission followed by %s', async mode => {
  const h = await fixture(), controller = new AbortController(), session = createCompanionExecutionValidationSession(controller.signal);
  try {
    await session.run(async () => {
      expect((await h.read()).message?.content).toBe(h.message.content);
      await memoCompanionExecutionAdmission('external-asset', { identity: h.f.store, read: async () => true, cacheable: () => true,
        verify: async () => { if (mode === 'cancelled') controller.abort(); else throw new Error('Actual final asset admission failed.'); } });
    });
    expect(h.certificates).not.toHaveBeenCalled();
    await expect(session.validate()).rejects.toThrow();
    expect(h.certificates).not.toHaveBeenCalled(); expect(h.stored().publicationCertificate).toBeUndefined();
    const raw: CompanionStorageResponse = h.f.store.request({ type: 'message.get', id: h.message.id });
    expect(hash(raw.message!.content)).toBe(hash(h.message.content));
  } finally { session.close(); await h.f.close(); }
});
