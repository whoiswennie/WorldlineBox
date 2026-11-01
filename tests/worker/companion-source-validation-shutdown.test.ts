import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { guardCompanionExecutionSources } from '../../src/main/companions/source-execution-evidence';
import { CompanionValidationUnavailableError } from '../../src/main/companions/validation-unavailable';
import { companionMemoryRegisteredPath } from '../../src/main/companions/memory-library';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import type { CompanionMemoryFileReceipt } from '../../src/shared/companion-memory-files';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['library-closed', 'host-closing'] as const)('does not permanently invalidate real canonical sources when capture overlaps %s, but still withdraws an actual forget', async mode => {
  vi.useFakeTimers({ toFake: ['Date'] }); const now = Date.now(); vi.setSystemTime(now - 30 * 60_000);
  const f = managedMemoryFiles(), source = f.source('已经发生而且仍有权读取的真实事件。'), note = f.record('正式登记的准确记忆。', [source.id]);
  await f.publish(); const receipts = (await f.live.materialize('alice', [note])).receipts;
  const readset: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, ...f.scope,
    memories: [], sources: [], knowledgeReads: [], topics: [], frozenMemories: [{ id: note.id, contentRevision: note.contentRevision!,
      sources: note.sources.map(reference => ({ id: reference.messageId, conversationId: reference.conversationId, checksum: reference.checksum })) }],
    contexts: [{ revision: 'actual-history', profileKey: 'canonical-files', fileReceiptOnly: true, fileReceipts: receipts }] };
  const derived = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '根据该实际事件形成的正式发言。', executionReadset: readset });
  vi.setSystemTime(now);
  const entered = gate(), release = gate(), identity = {}, commands: CompanionStorageCommand[] = [];
  let hold = false, hostClosing = false;
  const contextValid = (scope: { companionId: string }, context: { revision: string; profileKey: string; fileReceipts?: readonly CompanionMemoryFileReceipt[] }) =>
    f.live.validate(scope.companionId, context.fileReceipts ?? []);
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    commands.push(command);
    const response = await f.request(command);
    if (hold && command.type === 'memory.sources.filter' && response.memorySources?.some(message => message.id === derived.id)) {
      entered.release(); await release.promise;
    }
    return guardCompanionExecutionSources(command, response, { identity, revision: () => 0, storage: f.request,
      assertAvailable: () => { if (hostClosing) throw new CompanionValidationUnavailableError('Main is closing.'); },
      valid: (proof, sqliteSourcesValidated) => verifyCompanionExecutionReadset(proof.executionReadset, proof, { sqliteSourcesValidated,
        request, contextValid }) });
  };
  const fetchFn = vi.fn<typeof fetch>(async () => { throw new Error('Closing capture must never dispatch a model.'); });
  const memory = new CompanionMemoryService({ request, configFor: async () => ({ apiFormat: 'openai_chat', model: 'controlled', apiKey: 'fixture' }),
    fetchFn, changed: vi.fn(), report: vi.fn(), busy: () => false });
  memory.setAgendaDriven(vi.fn());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    expect((await request({ type: 'message.get', id: derived.id })).message?.content).toBe(derived.content);
    hold = true;
    const capture = memory.runAgendaQuantum('alice', new AbortController().signal);
    await Promise.race([entered.promise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Capture never reached its actual derived-source read.')), 5000); })]);
    if (timeout) clearTimeout(timeout);
    const closing = memory.close();
    if (mode === 'library-closed') await f.library.close(); else hostClosing = true;
    release.release();
    expect((await capture).outcome).toBe('cancelled'); await closing;
    expect(fetchFn).not.toHaveBeenCalled();
    expect(commands.some(command => command.type === 'execution.invalidate')).toBe(false);
    expect(f.commands.some(command => command.type === 'execution.invalidate')).toBe(false);
    const proof = f.store.request({ type: 'execution.sources', sourceMessageIds: [derived.id], memoryIds: [] }).executionSources!.find(value => value.id === derived.id)!;
    expect(proof.invalidated).not.toBe(true);
    expect(f.store.request({ type: 'memory.records.filter', ...f.scope, ids: [note.id] }).memories?.[0]?.content).toBe(note.content);
    hostClosing = false; hold = false;
    f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id], persistent: true });
    expect((await request({ type: 'message.get', id: derived.id })).message?.content).toBe('');
    expect(hash(f.store.getMessage(source.id).content)).toBe(hash(source.content));
    expect(f.store.request({ type: 'memory.records.filter', ...f.scope, ids: [note.id] }).memories).toHaveLength(0);
  } finally { if (timeout) clearTimeout(timeout); release.release(); await memory.close(); await f.close(); }
}, 15000);

it('keeps an actual unfinished publication pending instead of permanently withdrawing its derived history', async () => {
  const f = managedMemoryFiles(), source = f.source('准确来源尚待发布为文件。'), note = f.record('准确正文尚待系统正式发布。', [source.id]);
  try {
    f.store.request({ type: 'memory.library.scope', companionId: 'alice' });
    const receipt = { companionId: 'alice', noteId: note.id, contentRevision: note.contentRevision!, path: companionMemoryRegisteredPath(note), contentHash: hash(note.content) };
    await expect(f.live.validate('alice', [receipt])).rejects.toMatchObject({ reason: 'files_pending' });
    expect(f.commands.some(command => command.type === 'execution.invalidate')).toBe(false);
    expect(f.store.request({ type: 'memory.records.filter', ...f.scope, ids: [note.id] }).memories?.[0]?.content).toBe(note.content);
    await f.publish(); expect(await f.live.validate('alice', [receipt])).toBe(true);
  } finally { await f.close(); }
});

it('propagates a real canonical-reader transport failure without converting it to definitive invalidity', async () => {
  const f = managedMemoryFiles(), note = f.record('仍有效的正式正文。'); await f.publish();
  try {
    const { receipts } = await f.live.materialize('alice', [note]), failure = new CompanionValidationUnavailableError('Storage transport stopped.');
    f.intercept(command => { if (command.type === 'memory.library.scope.read') throw failure; });
    await expect(f.live.validate('alice', receipts)).rejects.toBe(failure);
    expect(f.commands.some(command => command.type === 'execution.invalidate')).toBe(false);
    f.intercept(); expect(await f.live.validate('alice', receipts)).toBe(true);
  } finally { await f.close(); }
});
