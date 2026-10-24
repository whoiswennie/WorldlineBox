import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { captureCompanionExecutionReadset, companionExecutionReadsetDigest } from '../../src/main/companions/execution-evidence';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { DshRecordQuery, DshRecordScope } from '../../src/shared/dsh-task-record';
import type { DshLauncher } from '../../src/main/dsh/launcher';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {} }));

let root: string, store: CompanionsStore, service: {
  call(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  captureExecutionEvidence(checkpoint: CompanionLoopCheckpoint, scope: { companionId: string; conversationId: string; beforeSequence: number }): Promise<CompanionExecutionReadset>;
  readDshRecord(query: DshRecordQuery, scope: { companionId: string; conversationId: string }): Promise<unknown>;
};
let ownerScope: { companionId: string; conversationId: string };
let nativeScope: DshRecordScope;
let corpusCurrent: boolean;
const readNative = vi.fn(async () => ({ overview: { finalReply: 'DERIVED_PRIVATE_CONTENT', artifacts: [{ path: 'private-result.json' }] } }));
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'companion-execution-host-'));
  store = new CompanionsStore(path.join(root, 'state.sqlite'), [{ id: 'alice', name: 'Alice', description: '', persona: '认真', model: '', avatar: 'sister', active: true, proactive: false }]);
  ownerScope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const instance = Object.create(CompanionService.prototype);
  corpusCurrent = true;
  Object.assign(instance, { storage: { request: async (command: CompanionStorageCommand) => store.request(command) },
    memory: { contextValid: async () => corpusCurrent, schedule: () => undefined, invalidate: async () => undefined }, evidenceRevision: 0, resettingCompanions: new Set(),
    options: { dsh: () => ({ taskRecordScope: async () => nativeScope, readTaskRecord: readNative } as unknown as DshLauncher) } });
  service = instance; readNative.mockClear();
});
afterEach(() => {
  store.close();
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-execution-host-')) throw new Error('Invalid owned cleanup target');
  rmSync(root, { recursive: true, force: true });
});

function completedAction() {
  const authorization = store.appendMessage({ conversationId: ownerScope.conversationId, authorId: 'user', content: '请按已读资料完成计算。', replyDirective: 'none' });
  const source = store.appendMessage({ conversationId: ownerScope.conversationId, authorId: 'user', content: '独立资料：标识为 DERIVED_PRIVATE_CONTENT。', replyDirective: 'none' });
  const readset = captureCompanionExecutionReadset(ownerScope, { context: { user: JSON.stringify({ messages: [authorization, source] }) } });
  const action = store.request({ type: 'action.create', action: { ...ownerScope, sourceMessageId: authorization.id, title: '真实完成的任务', status: 'queued' },
    checkpoint: { prompt: '执行原目标。', executionReadset: readset, supplements: [], waitForActionIds: [] } }).action!;
  const recordId = randomUUID();
  nativeScope = { actionId: action.id, ...ownerScope, sourceMessageId: authorization.id,
    sourceDigest: createHash('sha256').update(authorization.content).digest('hex'), executionReadsetDigest: companionExecutionReadsetDigest(readset) };
  store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', taskId: recordId, result: 'DERIVED_PRIVATE_CONTENT' } });
  return { action, source, recordId };
}
it('preserves actual success while withholding stale derived action content through both direct and paged Main reads', async () => {
  const { action, source } = completedAction();
  expect((await service.call({ type: 'action.get', id: action.id })).action?.result).toBe('DERIVED_PRIVATE_CONTENT');
  store.request({ type: 'memory.forget', ...ownerScope, sourceMessageIds: [source.id] });
  const direct = (await service.call({ type: 'action.get', id: action.id })).action!;
  expect(direct).toMatchObject({ id: action.id, status: 'succeeded', canResume: false, contentAvailable: false });
  expect(direct.result).toBeUndefined(); expect(direct.executionSummary).toBeUndefined();
  const page = await service.call({ type: 'actions.page', conversationId: ownerScope.conversationId, limit: 20 });
  expect(page.actionPage!.items[0]).toMatchObject({ status: 'succeeded', contentAvailable: false });
  expect(JSON.stringify(page)).not.toContain('DERIVED_PRIVATE_CONTENT');
});
it('checks immutable execution dependencies before native record IO and rechecks after it', async () => {
  const { source, recordId } = completedAction();
  expect(await service.readDshRecord({ recordId }, ownerScope)).toMatchObject({ overview: { finalReply: 'DERIVED_PRIVATE_CONTENT' } });
  readNative.mockImplementationOnce(async () => {
    store.request({ type: 'memory.forget', ...ownerScope, sourceMessageIds: [source.id] });
    return { overview: { finalReply: 'DERIVED_PRIVATE_CONTENT', artifacts: [{ path: 'private-result.json' }] } };
  });
  await expect(service.readDshRecord({ recordId }, ownerScope)).rejects.toThrow('不能读取旧记录');
  readNative.mockClear();
  await expect(service.readDshRecord({ recordId }, ownerScope)).rejects.toThrow('不能读取旧记录');
  expect(readNative).not.toHaveBeenCalled();
});

it('captures the actual message behind a world observation and withdraws its derived result without erasing the completed effect', async () => {
  const source = store.appendMessage({ conversationId: ownerScope.conversationId, authorId: 'user', content: '现场见闻的原始说明 WORLD_OBSERVATION_SOURCE。', replyDirective: 'none' });
  const authorization = store.appendMessage({ conversationId: ownerScope.conversationId, authorId: 'user', content: '请根据实际见闻计算。', replyDirective: 'none' });
  const checkpoint: CompanionLoopCheckpoint = { ...ownerScope, sourceMessageId: authorization.id, status: 'running', supplements: [], turns: [],
    context: { system: '真实宿主上下文', user: JSON.stringify({ messages: [authorization], world: { events: [{ id: 'actual_world_event', sourceMessageId: source.id,
      conversationId: source.conversationId, sourceReads: [{ id: source.id, conversationId: source.conversationId, checksum: createHash('sha256').update(source.content).digest('hex') }] }], visits: [] },
      metadata: { world: { events: [{ sourceMessageId: 'NOT_A_HOST_SOURCE' }] } } }) } };
  const proof = await service.captureExecutionEvidence(checkpoint, { ...ownerScope, beforeSequence: authorization.sequence });
  expect(proof.complete).toBe(true);
  expect(proof.sources).toContainEqual({ id: source.id, conversationId: source.conversationId, checksum: createHash('sha256').update(source.content).digest('hex') });
  expect(proof.sources.some(item => item.id === 'NOT_A_HOST_SOURCE')).toBe(false);
  const action = store.request({ type: 'action.create', action: { ...ownerScope, sourceMessageId: authorization.id, title: '实际执行', status: 'queued' },
    checkpoint: { prompt: '根据实际见闻计算', executionReadset: proof, supplements: [], waitForActionIds: [] } }).action!;
  store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: 'DERIVED_FROM_WORLD_OBSERVATION_SOURCE' } });
  expect((await service.call({ type: 'action.get', id: action.id })).action?.result).toContain('DERIVED_FROM_WORLD');
  store.request({ type: 'memory.forget', ...ownerScope, sourceMessageIds: [source.id] });
  const withdrawn = (await service.call({ type: 'action.get', id: action.id })).action!;
  expect(withdrawn).toMatchObject({ id: action.id, status: 'succeeded', contentAvailable: false, canResume: false });
  expect(withdrawn.result).toBeUndefined();
});

it('keeps the observed world source hash and rejects a same-ID reply revision before a new formal proof is published', async () => {
  const authorization = store.appendMessage({ conversationId: ownerScope.conversationId, authorId: 'user', content: '请说明现场进展。', replyDirective: 'none' });
  const source = store.appendMessage({ conversationId: ownerScope.conversationId, authorId: 'alice', content: '', loopStep: 0 });
  const original = '我只完成了上半部修复。', changed = '更正：此前描述有误，尚未开始修复。';
  const sourceProof = captureCompanionExecutionReadset(ownerScope, { context: { user: JSON.stringify({ messages: [authorization] }) } });
  const saved = { ...ownerScope, sourceMessageId: authorization.id, messageId: source.id, status: 'done' as const,
    turns: [{ text: original, rawText: original, calls: [] }] };
  store.request({ type: 'loop.save', checkpoint: saved, executionReadset: sourceProof });
  const observedHash = createHash('sha256').update(original).digest('hex');
  const checkpoint: CompanionLoopCheckpoint = { ...ownerScope, sourceMessageId: authorization.id, status: 'running', supplements: [], turns: [], context: {
    system: '真实宿主世界观察', user: JSON.stringify({ messages: [authorization], world: { events: [{ id: 'actual_world_event',
      sourceMessageId: source.id, conversationId: source.conversationId, text: original,
      sourceReads: [{ id: source.id, conversationId: source.conversationId, checksum: observedHash }] }], visits: [] } }),
  } };
  expect((await service.captureExecutionEvidence(checkpoint, { ...ownerScope, beforeSequence: authorization.sequence })).complete).toBe(true);
  store.request({ type: 'loop.save', checkpoint: { ...saved, turns: [{ text: changed, rawText: changed, calls: [] }] }, executionReadset: sourceProof });
  expect(store.getMessage(source.id).content).toBe(changed);
  const stale = await service.captureExecutionEvidence(checkpoint, { ...ownerScope, beforeSequence: authorization.sequence });
  expect(stale.complete).toBe(false);
  expect(stale.sources).toContainEqual({ id: source.id, conversationId: source.conversationId, checksum: observedHash });
  expect(stale.sources.some(reference => reference.checksum === createHash('sha256').update(changed).digest('hex'))).toBe(false);
});

it.each(['revise', 'forget'] as const)('retains a published reply and its new diary across unrelated indexing, then withdraws them after its actual parent %s', async mutation => {
  const source = store.appendMessage({ conversationId: ownerScope.conversationId, authorId: 'user', content: '修书材料是米色棉线，放在第二层抽屉。', replyDirective: 'none' });
  const parent = store.request({ type: 'memory.record', ...ownerScope, candidate: { content: source.content, diaryName: '经历', tags: ['修书'],
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const indexPending = () => {
    for (;;) {
      const outbox = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
      if (!outbox) break;
      store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true, sourceFile: 'fixture/' + outbox.noteId + '.md' });
    }
  };
  indexPending();
  const task = store.appendMessage({ conversationId: ownerScope.conversationId, authorId: 'user', content: '材料在哪？', replyDirective: 'none' });
  const snapshot = store.request({ type: 'memory.snapshot', ...ownerScope }).memorySnapshot!;
  const checkpoint: CompanionLoopCheckpoint = { ...ownerScope, sourceMessageId: task.id, status: 'running', supplements: [], turns: [], context: {
    system: '实际宿主上下文', user: JSON.stringify({ messages: [task], memoryRecall: { context: { text: parent.content,
      revision: snapshot.revision, profileKey: 'actual-profile-at-inference', evidence: {
        dependencyCoverage: 'complete', dependencies: [{ id: parent.id, version: parent.version }], referenceCoverage: 'partial', references: [],
      } } } }),
  } };
  const proof = await service.captureExecutionEvidence(checkpoint, { ...ownerScope, beforeSequence: task.sequence });
  expect(proof.complete).toBe(true); expect(proof.contexts).toEqual([]); expect(proof.memories).toEqual([{ id: parent.id, version: parent.version }]);
  const bubble = store.appendMessage({ conversationId: ownerScope.conversationId, authorId: 'alice', content: '', loopStep: 0 });
  store.request({ type: 'loop.save', checkpoint: { ...checkpoint, messageId: bubble.id, status: 'done', turns: [{ text: parent.content, rawText: parent.content, calls: [] }] }, executionReadset: proof });
  const published = store.getMessage(bubble.id);
  const diary = store.request({ type: 'memory.record', ...ownerScope, candidate: { content: published.content, diaryName: '回忆', tags: ['出处'],
    sourceMessageIds: [published.id], evidence: [{ sourceMessageId: published.id, quote: published.content }] } }).memories![0]!;
  store.saveMemory({ ...ownerScope, content: '无关的新观察：阳台薄荷长出了新叶。' }); indexPending();
  expect(store.request({ type: 'memory.snapshot', ...ownerScope }).memorySnapshot!.revision).not.toBe(snapshot.revision);
  corpusCurrent = false;
  expect((await service.call({ type: 'memory.sources.filter', ...ownerScope, ids: [published.id] })).memorySources?.[0]?.content).toBe(parent.content);
  expect((await service.call({ type: 'memory.records.filter', ...ownerScope, ids: [diary.id] })).memories?.[0]?.id).toBe(diary.id);
  if (mutation === 'forget') store.request({ type: 'memory.forget', ...ownerScope, id: parent.id });
  else {
    const correction = store.appendMessage({ conversationId: ownerScope.conversationId, authorId: 'user', content: '更正：棉线后来移到了第一层。', replyDirective: 'none' });
    store.request({ type: 'memory.revise', ...ownerScope, id: parent.id, expectedVersion: parent.version, candidate: {
      content: correction.content, diaryName: '经历', tags: ['修书', '更正'], sourceMessageIds: [correction.id], evidence: [{ sourceMessageId: correction.id, quote: correction.content }],
    } });
  }
  expect((await service.call({ type: 'memory.sources.filter', ...ownerScope, ids: [published.id] })).memorySources).toEqual([]);
  expect((await service.call({ type: 'memory.records.filter', ...ownerScope, ids: [diary.id] })).memories).toEqual([]);
});
