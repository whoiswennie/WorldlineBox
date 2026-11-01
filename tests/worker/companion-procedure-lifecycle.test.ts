import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import Database from 'better-sqlite3';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { readCompanionProcedureStatuses } from '../../src/main/companions/procedure-status';
import { createCompanionExecutionValidationSession } from '../../src/main/companions/source-execution-evidence';
import { companionProcedureStatusCommandSchema, companionProcedureStatusResult } from '../../src/shared/companion-procedure-status';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionsRequestSchema } from '../../src/shared/companions';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { verifyDshDelivery } from '../../src/main/dsh/task-delivery';
import { companionSourceChecksum } from '../../src/companions/source-access';
import type { CompanionMemory } from '../../src/shared/companions';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import type { DshTaskResult } from '../../src/shared/dsh-tasks';
import type { CompanionMemoryProcedureProposal } from '../../src/shared/companion-procedure';

const roots: string[] = [], stores = new Set<CompanionsStore>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-26T10:00:00Z'); });
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-procedure-lifecycle-')) throw Error('Unexpected cleanup');
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks(); vi.useRealTimers();
});
function fixture(shared = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-procedure-lifecycle-')); roots.push(root);
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, model: '', avatar: 'sister' as const,
    description: '', persona: '谨慎区分方法候选与实际验证。', active: true, proactive: false }))); stores.add(store);
  const privateRoom = store.openPrivate('alice').id;
  const scope = { companionId: 'alice', conversationId: shared ? store.createConversation('有来源的方法讨论', ['alice', 'bob']).id : privateRoom };
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '用明确的方法生成结果文件，并核对其内容后再判断是否有效。', replyDirective: 'none' });
  const method: CompanionMemoryProcedureProposal = { applicability: '在本地受管测试目录生成受约束的结果文本时。', steps: ['写入结果文件。', '实际读取并核对输出正文。'],
    limitations: ['只验证当前文件交付合同，不代表其他任务都成功。'], verification: { kind: 'artifact_delivery', artifactRequirements: [{ path: 'trial-output.txt', containsText: 'ACTUAL_VERIFIED_RESULT' }] } };
  const note = store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'procedure' as const, content: '候选方法：先保存结果，再按明确的文件合同验证。', tags: ['方法候选'], procedure: method,
    metadata: { validation: 'validated', procedureValidation: { state: 'validated' } }, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const index = () => { for (let n = 0; n < 100; n++) { const entry = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!entry) break;
    store.request({ type: 'memory.outbox.complete', id: entry.id, leaseToken: entry.leaseToken, indexed: true }); } };
  index();
  const read = () => store.request({ type: 'memory.read', ...scope, id: note.id }).memoryRead!.memory;
  /** Controlled executor fixture, with actual host artifact verification and
   * the production action/checkpoint/result-source SQLite protocol. */
  const trial = async (options: { status?: 'succeeded' | 'failed'; checked?: boolean; focused?: boolean; wrongContract?: boolean; owner?: string } = {}) => {
    const owner = options.owner ?? 'alice', room = owner === 'alice' ? privateRoom : store.openPrivate(owner).id;
    const requestSource = owner === 'alice' && source.conversationId === room ? source
      : store.appendMessage({ conversationId: room, authorId: 'user', content: '在此私聊范围内进行自己的测试。', replyDirective: 'none' });
    const current = read(), status = options.status ?? 'succeeded', taskId = randomUUID(), at = new Date().toISOString();
    const readset: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', companionId: owner, conversationId: room,
      complete: true, memories: options.focused === false ? [] : [{ id: current.id, version: current.version }],
      sources: [{ id: requestSource.id, conversationId: room, checksum: companionSourceChecksum(requestSource.content) }], knowledgeReads: [], contexts: [], topics: [] };
    const artifacts = options.wrongContract ? [{ path: 'another-output.txt' }] : method.verification.artifactRequirements;
    const action = store.request({ type: 'action.create', action: { companionId: owner, conversationId: room, sourceMessageId: requestSource.id,
      title: '受控方法验证任务', status: 'queued' }, checkpoint: { prompt: '应用已读方法，在限定作用域内按客观文件合同交付。',
      dshTask: { delivery: { format: 'text', artifacts } }, executionReadset: readset } }).action!;
    store.request({ type: 'tasks.capacity.claim-action', id: action.id });
    const result: DshTaskResult = { taskId, instanceId: 'controlled-instance', runtimeId: 'controlled-runtime', runtimeVersion: 'test', code: status === 'succeeded' ? 0 : 1,
      text: '这是执行器文字，本身不构成方法已验证的证明。', artifacts: [] };
    if (options.checked !== false && status === 'succeeded') {
      const output = path.join(root, artifacts[0]!.path); writeFileSync(output, 'ACTUAL_VERIFIED_RESULT'); result.artifacts = [{ path: output }];
      await verifyDshDelivery(result, { format: 'text', artifacts }, root);
    }
    store.request({ type: 'checkpoint.execution', id: action.id, execution: { id: taskId, operationId: taskId, instanceId: 'controlled-instance', runtimeId: 'controlled-runtime',
      runtimeVersion: 'test', title: action.title, status, code: result.code, startedAt: at, finishedAt: at, taskWorkspaceRoot: root } });
    store.request({ type: 'action.update', id: action.id, patch: { taskId, status, result: result.text,
      executionSummary: { recordId: taskId, title: action.title, status, createdAt: at, executionStartedAt: at, finishedAt: at, durationMs: 1,
        turns: 1, steps: 1, toolCalls: 1, recordCount: 1, storedBytes: 100, finalReply: result.text!, finalReplyChars: result.text!.length,
        finalReplyTruncated: false, complete: true, storageLimited: false, artifacts: result.artifacts, verification: result.verification } } });
    const outcome = store.messages({ conversationId: room }).messages.find(message => message.actionId === action.id && message.kind === 'action')!;
    expect(outcome).toBeDefined();
    store.request({ type: 'memory.procedure.observe-action', actionId: action.id }); return { action, outcome, before: current };
  };
  return { root, store, scope, source, method, note, index, read, trial };
}

it('returns fresh procedure annotations and source headers without canonical prose, retaining private-trial scope and exact content revision', async () => {
  const f = fixture(true), read = () => f.store.request({ type: 'memory.procedures.status', ...f.scope, references: [{ id: f.note.id, contentRevision: f.note.contentRevision! }] });
  expect(read().memoryProcedureStatuses).toEqual([{ memoryId: f.note.id, contentRevision: f.note.contentRevision, ...f.read().procedure!.validation }]);
  const trial = await f.trial(), privateScope = { companionId: 'alice', conversationId: f.store.openPrivate('alice').id };
  const privateRead = f.store.request({ type: 'memory.procedures.status', ...privateScope, references: [{ id: f.note.id, contentRevision: f.note.contentRevision! }] });
  expect(privateRead.memoryProcedureStatuses?.[0]).toMatchObject({ state: 'validated', successes: 1 });
  expect(read().memoryProcedureStatuses?.[0]).toMatchObject({ state: 'unverified', evidence: [] });
  expect(JSON.stringify(read())).not.toContain(trial.action.id); expect(JSON.stringify(privateRead)).not.toContain(f.note.content);
  expect(privateRead).not.toHaveProperty('memories');
  expect(f.store.request({ type: 'memory.procedures.status', ...f.scope, references: [{ id: f.note.id, contentRevision: f.note.contentRevision! + 1 }] }).memoryProcedureStatuses).toEqual([]);
  expect(f.store.request({ type: 'memory.procedures.status', companionId: 'bob', conversationId: f.store.openPrivate('bob').id,
    references: [{ id: f.note.id, contentRevision: f.note.contentRevision! }] }).memoryProcedureStatuses).toEqual([]);
  expect(f.store.request({ type: 'memory.procedures.status', ...f.scope, beforeSequence: 0, references: [{ id: f.note.id, contentRevision: f.note.contentRevision! }] }).memoryProcedureStatuses).toEqual([]);
});

function metadataHost(f: ReturnType<typeof fixture>) {
  const ensure = vi.fn(async () => { throw new Error('Status predicates cannot open canonical bodies.'); }), materialize = vi.fn();
  const storage = { request: vi.fn(async (command: CompanionStorageCommand) => f.store.request(command)) };
  const host = Object.assign(Object.create(CompanionService.prototype), { storage, fileReadiness: { ensure }, liveFiles: { materialize },
    resettingCompanions: new Set(), sourceValidationRevision: 0, evidenceRevision: 0, options: { report: () => undefined }, memory: { schedule: () => undefined } }) as {
      call(command: CompanionStorageCommand): Promise<CompanionStorageResponse> };
  const read = () => readCompanionProcedureStatuses({ scope: f.scope, references: [{ id: f.note.id, contentRevision: f.note.contentRevision! }],
    identity: storage, request: command => host.call(command), requestFresh: storage.request });
  return { ensure, materialize, storage, host, read };
}

it('does not adopt another requested procedure identity from a corrupted SQL data row', () => {
  const f = fixture(), second = f.store.request({ type: 'memory.record', ...f.scope, candidate: { artifactKind: 'procedure', content: '另一个准确方法。', tags: [],
    procedure: f.method, sourceMessageIds: [f.source.id], evidence: [{ sourceMessageId: f.source.id, quote: f.source.content }] } }).memories![0]!;
  const db = new (Database as new(filename: string) => CompanionConnection)(path.join(f.root, 'state.sqlite'));
  try { db.prepare("UPDATE vcp_memory_notes SET data=json_set(data,'$.id',?) WHERE id=?").run(second.id, f.note.id); }
  finally { db.close(); }
  expect(() => f.store.request({ type: 'memory.procedures.status', ...f.scope, references: [
    { id: f.note.id, contentRevision: f.note.contentRevision! }, { id: second.id, contentRevision: second.contentRevision! }] })).toThrow('SQL行与正文身份');
});

it('uses the real Main metadata gate and a fresh final SQL status witness without readiness or materialization', async () => {
  const f = fixture(), h = metadataHost(f), gate = createCompanionExecutionValidationSession();
  try {
    expect(await gate.run(h.read)).toEqual([{ memoryId: f.note.id, contentRevision: f.note.contentRevision, ...f.read().procedure!.validation }]);
    await gate.validate(); expect(h.ensure).not.toHaveBeenCalled(); expect(h.materialize).not.toHaveBeenCalled();
    expect(h.storage.request.mock.calls.filter(([command]) => command.type === 'memory.procedures.status')).toHaveLength(2);
  } finally { gate.close(); }
});

it.each(['source', 'forget', 'content-revision', 'membership', 'practice-status'] as const)('rejects an actual %s change at the Main procedure-status final witness', async mutation => {
  const f = fixture(), h = metadataHost(f), gate = createCompanionExecutionValidationSession();
  try {
    expect(await gate.run(h.read)).toHaveLength(1);
    if (mutation === 'forget') f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
    if (mutation === 'content-revision') f.store.request({ type: 'memory.revise', ...f.scope, id: f.note.id, expectedVersion: f.note.version,
      candidate: { artifactKind: 'procedure', content: '合法更正后的方法。', tags: [], procedure: f.method, sourceMessageIds: [f.source.id], evidence: [{ sourceMessageId: f.source.id, quote: f.source.content }] } });
    if (mutation === 'practice-status') await f.trial();
    if (mutation === 'source' || mutation === 'membership') {
      const db = new (Database as new(filename: string) => CompanionConnection)(path.join(f.root, 'state.sqlite'));
      db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens); db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
      try {
        if (mutation === 'source') db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('实际来源已经改写。', f.source.id);
        else db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(f.scope.conversationId, 'alice');
      } finally { db.close(); }
    }
    await expect(gate.validate()).rejects.toThrow();
    expect(h.ensure).not.toHaveBeenCalled(); expect(h.storage.request.mock.calls.some(([command]) => command.type === 'execution.invalidate')).toBe(false);
  } finally { gate.close(); }
});

it('keeps memory-service current status selection equivalent while rejecting malformed or foreign metadata and exposing no public command', async () => {
  const f = fixture(), request = vi.fn(async (command: CompanionStorageCommand) => f.store.request(command));
  const service = new CompanionMemoryService({ request, changed: () => undefined, busy: () => true, report: () => undefined,
    configFor: async () => { throw new Error('Status reads do not request a model'); }, fetchFn: async () => { throw new Error('Status reads do not request a model'); } });
  const read = Reflect.get(service, 'currentProcedureStatuses') as (scope: typeof f.scope, references: Array<{ id: string; contentRevision: number }>) => Promise<unknown>;
  const command = { type: 'memory.procedures.status' as const, ...f.scope, references: [{ id: f.note.id, contentRevision: f.note.contentRevision! }] };
  try {
    expect(await read.call(service, f.scope, command.references)).toEqual([{ memoryId: f.note.id, contentRevision: f.note.contentRevision, ...f.read().procedure!.validation }]);
    await f.trial(); expect(await read.call(service, f.scope, command.references)).toEqual([{ memoryId: f.note.id, contentRevision: f.note.contentRevision, ...f.read().procedure!.validation }]);
    expect(request.mock.calls.every(([command]) => command.type === 'memory.procedures.status')).toBe(true);
    expect(await read.call(service, f.scope, [{ id: f.note.id, contentRevision: f.note.contentRevision! + 1 }])).toEqual([]);
    const actual = f.store.request(command);
    expect(companionProcedureStatusResult(command, { ...actual, memoryProcedureStatuses: [...actual.memoryProcedureStatuses!, ...actual.memoryProcedureStatuses!] })).toBeUndefined();
    expect(companionProcedureStatusResult(command, { ...actual, memoryDescriptors: actual.memoryDescriptors!.map(header => ({ ...header, companionId: 'bob' })) })).toBeUndefined();
    expect(companionProcedureStatusCommandSchema.safeParse({ ...command, body: 'never accepted' }).success).toBe(false);
    expect(companionsRequestSchema.safeParse(command).success).toBe(false);
    request.mockResolvedValueOnce({ ok: true }); await expect(read.call(service, f.scope, command.references)).rejects.toThrow('准确的当前修订');
  } finally { await service.close(); }
});

it('starts unverified and accepts only an exact objective delivery contract from an actual focused action result', async () => {
  const f = fixture(); expect(f.note.procedure?.validation).toMatchObject({ state: 'unverified', successes: 0, failures: 0 });
  await f.trial({ checked: false }); expect(f.read().procedure?.validation.state).toBe('unverified');
  await f.trial({ focused: false }); expect(f.read().procedure?.validation.state).toBe('unverified');
  await f.trial({ wrongContract: true }); expect(f.read().procedure?.validation.state).toBe('unverified');
  const verified = await f.trial(); const after = f.read();
  expect(after.procedure?.validation).toMatchObject({ state: 'validated', successes: 1, failures: 0,
    evidence: [{ actionId: verified.action.id, sourceMessageId: verified.outcome.id, outcome: 'passed' }] });
  expect(after.contentRevision).toBe(verified.before.contentRevision); expect(after.annotationRevision).toBeGreaterThan(verified.before.annotationRevision!);
  f.store.request({ type: 'memory.procedure.observe-action', actionId: verified.action.id });
  expect(f.read().version).toBe(after.version);
});

it('withdraws practice validation without deleting the still-lawful original method', async () => {
  const f = fixture(), verified = await f.trial(); expect(f.read().procedure?.validation.state).toBe('validated');
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [verified.outcome.id] });
  expect(f.read()).toMatchObject({ id: f.note.id, content: f.note.content, procedure: { validation: { state: 'unverified', successes: 0, evidence: [] } } });
});

it('does not expose a private trial result through a shared entrance or credit it to another owner', async () => {
  const f = fixture(true); await f.trial();
  expect(f.store.request({ type: 'memory.library.read', companionId: 'alice', id: f.note.id }).memoryRead!.memory.procedure?.validation.state).toBe('validated');
  expect(f.read().procedure?.validation).toMatchObject({ state: 'unverified', successes: 0, evidence: [] });
  const privateNote = f.store.request({ type: 'memory.library.read', companionId: 'alice', id: f.note.id }).memoryRead!.memory;
  const before = privateNote.version; await f.trial({ owner: 'bob' });
  expect(f.store.request({ type: 'memory.library.read', companionId: 'alice', id: f.note.id }).memoryRead!.memory.version).toBe(before);
});

it('keeps a real failed trial as counterevidence and resets validation after an explicit content correction', async () => {
  const f = fixture(); await f.trial(); const failed = await f.trial({ status: 'failed' });
  const current = f.read(); expect(current.procedure?.validation).toMatchObject({ state: 'disabled', successes: 1, failures: 1 });
  expect(current.procedure?.validation.evidence.some(evidence => evidence.actionId === failed.action.id && evidence.outcome === 'failed')).toBe(true);
  await f.trial(); expect(f.read().procedure?.validation.state).toBe('disabled');
  const revised = f.store.request({ type: 'memory.revise', ...f.scope, id: current.id, expectedVersion: f.read().version, candidate: { artifactKind: 'procedure' as const,
    content: '纠正后的候选方法：先检查限制条件，再保存与核对输出。', tags: ['更正后的方法候选'], procedure: { ...f.method, steps: ['先核对限制。', ...f.method.steps] },
    sourceMessageIds: [f.source.id], evidence: [{ sourceMessageId: f.source.id, quote: f.source.content }] } }).memories![0] as CompanionMemory;
  expect(revised.contentRevision).toBeGreaterThan(current.contentRevision!); expect(revised.procedure?.validation).toMatchObject({ state: 'unverified', successes: 0, failures: 0 });
});
