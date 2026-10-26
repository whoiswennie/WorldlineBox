import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
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
  const note = store.request({ type: 'memory.record', ...scope, candidate: { content: '候选方法：先保存结果，再按明确的文件合同验证。', tags: ['方法候选'], procedure: method,
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
  const revised = f.store.request({ type: 'memory.revise', ...f.scope, id: current.id, expectedVersion: f.read().version, candidate: {
    content: '纠正后的候选方法：先检查限制条件，再保存与核对输出。', tags: ['更正后的方法候选'], procedure: { ...f.method, steps: ['先核对限制。', ...f.method.steps] },
    sourceMessageIds: [f.source.id], evidence: [{ sourceMessageId: f.source.id, quote: f.source.content }] } }).memories![0] as CompanionMemory;
  expect(revised.contentRevision).toBeGreaterThan(current.contentRevision!); expect(revised.procedure?.validation).toMatchObject({ state: 'unverified', successes: 0, failures: 0 });
});
