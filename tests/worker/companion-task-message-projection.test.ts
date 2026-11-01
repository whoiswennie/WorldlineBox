import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionService } from '../../src/main/companions/service';
import { captureCompanionExecutionReadset, verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { createCompanionExecutionValidationSession, guardCompanionExecutionSources } from '../../src/main/companions/source-execution-evidence';
import { companionReplyTaskMessageSchema, type CompanionReplyTaskMessage, type CompanionReplyTaskSnapshot } from '../../src/shared/companion-reply-task-snapshot';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import type { CompanionConnection } from '../../src/companions/store';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {}, utilityProcess: { fork: vi.fn() } }));
const fixtures: Array<{ f: ReturnType<typeof managedMemoryFiles>; db: CompanionConnection }> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const { f, db } of fixtures.splice(0)) { db.close(); await f.close(); } });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const f = managedMemoryFiles(), db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens); db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  fixtures.push({ f, db });
  const prior = f.source('历史回答所依据的实际消息。');
  const reply = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '这是已经完成的正式回答。',
    executionReadset: captureCompanionExecutionReadset(f.scope, { sources: [{ id: prior.id, conversationId: prior.conversationId, checksum: hash(prior.content) }] }) });
  const source = f.source('这是下一项独立任务。');
  const read = () => f.store.request({ type: 'reply.task.snapshot', conversationId: f.scope.conversationId, sourceMessageId: source.id });
  return { f, db, prior, reply, source, read, key: 'message-loop/' + reply.id };
}

it('projects each historical task message once without hydrating UI loop fields or segments and leaves full UI messages unchanged', () => {
  const h = fixture(), checkpoint = { status: 'done', sourceMessageId: h.prior.id,
    context: { system: '保存的完整模型输入。'.repeat(10000), user: JSON.stringify({ memoryEvidenceThroughStep: 0, payload: 'UNRELATED_CONTEXT_'.repeat(50000) }) },
    turns: [{ text: '原工具步骤的展示片段。', calls: [], results: [] }] };
  h.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(h.key, JSON.stringify(checkpoint));
  const ui = h.f.store.getMessage(h.reply.id); expect(ui.segments).toHaveLength(1);
  const prototype = Object.getPrototypeOf(h.db.prepare('SELECT 1')), original = prototype.get;
  let uiReads = 0, draftProbes = 0;
  const spy = vi.spyOn(prototype, 'get').mockImplementation(function (this: object, ...args: unknown[]) {
    const sql = String(Reflect.get(this, 'source'));
    if (args[0] === h.key) {
      if (sql.includes("json_object('status'") || sql.includes('$.context.user')) uiReads++;
      if (sql === "SELECT json_type(value,'$.draft') AS kind FROM metadata WHERE key=?") draftProbes++;
    }
    return Reflect.apply(original, this, args);
  });
  const result = h.read(); spy.mockRestore();
  expect(companionStorageResponseSchema.parse(result).replyTaskMessages).toEqual(result.replyTaskMessages);
  expect(result.messages).toBeUndefined();
  const projected = result.replyTaskMessages!.find(message => message.id === h.reply.id)!;
  expect(projected).toEqual(companionReplyTaskMessageSchema.strip().parse(ui));
  expect(uiReads).toBe(0); expect(draftProbes).toBe(0); // Draft absence is a transactionally maintained PK projection too.
  expect(projected).not.toHaveProperty('segments'); expect(projected).not.toHaveProperty('replyProgress'); expect(projected).not.toHaveProperty('modelUsage');
  expect(h.f.store.getMessage(h.reply.id)).toEqual(ui);
});

it('preserves the exact old draft-exclusion truthiness and errors for unusual legacy checkpoint shapes', () => {
  const h = fixture();
  const replace = h.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)');
  for (const draft of [undefined, null, false, 0, '', {}, [], { text: '尚未正式发布的草稿。', rawText: '', step: 0 }]) {
    replace.run(h.key, JSON.stringify({ status: 'done', sourceMessageId: h.prior.id, ...(draft === undefined ? {} : { draft }) }));
    const original = h.f.store.getMessage(h.reply.id), denied = !!original.isReplyDraft || !!original.replyDraft;
    expect(h.read().replyTaskMessages!.some(message => message.id === h.reply.id)).toBe(!denied);
  }
  replace.run(h.key, 'damaged checkpoint JSON');
  expect(() => h.f.store.getMessage(h.reply.id)).toThrow('malformed JSON'); expect(() => h.read()).toThrow('malformed JSON');
});

it('keeps real attachments, reply links and timestamps in the task protocol while checking the same current actor scope', () => {
  const h = fixture();
  const attachment = { id: 'task_attachment', name: '真实附件.txt', mime: 'text/plain', size: 8, url: 'https://example.invalid/fixture' };
  h.f.store.registerAttachment({ attachment, relativePath: 'attachments/task_attachment.txt' });
  const source = h.f.store.appendMessage({ conversationId: h.f.scope.conversationId, authorId: 'user', content: '请查看这条带附件的消息。',
    attachmentIds: [attachment.id], replyToId: h.prior.id });
  const actual = h.f.store.getMessage(source.id), result = h.f.store.request({ type: 'reply.task.snapshot', conversationId: h.f.scope.conversationId, sourceMessageId: source.id });
  expect(result.message).toEqual(companionReplyTaskMessageSchema.strip().parse(actual));
  expect(result.replyTaskMessages!.find(message => message.id === source.id)?.attachments).toEqual(actual.attachments);
  expect(result.replyTaskSnapshot!.actors[0]!.referenceId).toBe(h.prior.id);
  h.db.prepare('DELETE FROM vcp_source_observers WHERE message_id=? AND companion_id=?').run(h.prior.id, 'alice');
  const denied = h.f.store.request({ type: 'reply.task.snapshot', conversationId: h.f.scope.conversationId, sourceMessageId: source.id });
  expect(denied.replyTaskSnapshot!.actors[0]!.referenceId).toBeUndefined();
  expect(denied.replyTaskMessages!.some(message => message.id === h.prior.id)).toBe(false);
});

it('registers task-model message bodies in the real Main gate and rejects a same-ID edit at the final source fence', async () => {
  const h = fixture(), session = createCompanionExecutionValidationSession();
  const command = { type: 'reply.task.snapshot' as const, conversationId: h.f.scope.conversationId, sourceMessageId: h.source.id };
  type Host = { replySnapshotInputs(snapshot: CompanionReplyTaskSnapshot, messages: readonly CompanionReplyTaskMessage[], owner: string): { messages: CompanionReplyTaskMessage[] } };
  const host = Object.create(CompanionService.prototype) as Host;
  try {
    const result = await session.run(() => guardCompanionExecutionSources(command, h.f.store.request(command), { identity: h.f.store, revision: () => 0, storage: h.f.request,
      valid: (proof, sqliteSourcesValidated, publishedFileContexts) => verifyCompanionExecutionReadset(proof.executionReadset, proof,
        { request: h.f.request, sqliteSourcesValidated, publishedFileContexts }) }));
    expect(host.replySnapshotInputs(result.replyTaskSnapshot!, result.replyTaskMessages!, 'alice').messages.some(message => message.id === h.reply.id)).toBe(true);
    h.db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('同一个标识的当前正式原文已经改变。', h.reply.id);
    await expect(session.validate()).rejects.toThrow();
    expect(h.f.store.getMessage(h.reply.id).content).toBe('同一个标识的当前正式原文已经改变。');
  } finally { session.close(); }
});
