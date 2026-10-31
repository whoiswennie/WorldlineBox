// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionJobControls } from '../../src/renderer/companions/CompanionJobControls';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionJobDisposition, CompanionJobKind } from '../../src/shared/companion-job-control';
import type { CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });
const record: CompanionJobDisposition = { ownerId: 'alice', kind: 'capture', id: 'capture-a', inputVersion: 'a'.repeat(64), revision: 7,
  state: 'parked', failureCount: 4, cycleFailureCount: 3, lastError: '结构修复后仍未通过来源校验。', lastErrorAt: '2026-10-28T08:00:00.000Z', sourceMessageId: 'event-a', conversationId: 'private-alice' };
type Workspace = NonNullable<WorldlineBoxCompanionsApi['workspace']>;
function connection(workspace: Workspace, request: WorldlineBoxCompanionsApi['request'] = async () => ({ ok: false, error: '原始事件已撤回。' })) {
  const listeners = new Set<() => void>();
  const api: WorldlineBoxCompanionsApi = { workspace, request, onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); }, onReplyStream: () => () => undefined };
  return { api, changed: () => listeners.forEach(listener => listener()) };
}
async function mount(api: WorldlineBoxCompanionsApi, ownerId = 'alice', resultUnknown = false, kind: CompanionJobKind = 'capture', id = 'capture-a') {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<CompanionJobControls ownerId={ownerId} kind={kind} id={id} api={api} resultUnknown={resultUnknown} />));
}
async function click(label: string) { const found = [...host.querySelectorAll('button')].find(button => button.textContent === label); expect(found, label).toBeDefined(); await act(async () => found!.click()); }
it('inspects only the exact selected job and requires an explicit confirmation before abandoning it without deleting its source', async () => {
  const workspace = vi.fn<Workspace>(async command => ({ ok: true, jobDisposition: command.type === 'jobs.control' ? { ...record, state: 'abandoned', revision: 8 } : record }));
  await mount(connection(workspace).api); expect(workspace).not.toHaveBeenCalled(); await click('核对处理状态与依据');
  expect(workspace).toHaveBeenCalledExactlyOnceWith({ type: 'jobs.inspect', ownerId: 'alice', kind: 'capture', id: 'capture-a' });
  expect(host.textContent).toContain('累计失败 4 次'); expect(host.textContent).toContain(record.lastError); expect(host.textContent).toContain('event-a');
  await click('放弃这次处理…'); expect(workspace).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('不删除原始事件');
  await click('确认放弃这次处理'); expect(workspace).toHaveBeenLastCalledWith({ type: 'jobs.control', ownerId: 'alice', kind: 'capture', id: 'capture-a', inputVersion: record.inputVersion, expectedRevision: 7, operationId: expect.any(String), action: 'abandon' });
  expect(host.textContent).toContain('没有被标记为整理成功'); expect([...host.querySelectorAll('button')].some(button => button.textContent === '恢复处理')).toBe(false);
});
it('freezes the operation identity and payload after a lost response and retries exactly that operation', async () => {
  let writes = 0;
  const workspace = vi.fn<Workspace>(async command => command.type !== 'jobs.control' ? { ok: true, jobDisposition: { ...record, state: 'failed' } } : ++writes === 1 ? { ok: false, error: '响应丢失。' } : { ok: true, jobDisposition: { ...record, revision: 8 } });
  await mount(connection(workspace).api); await click('核对处理状态与依据'); await click('搁置这项作业');
  const first = workspace.mock.calls.find(([command]) => command.type === 'jobs.control')![0]; expect(host.textContent).toContain('响应丢失');
  await click('重新核对作业'); await click('重试同一次操作');
  const operations = workspace.mock.calls.filter(([command]) => command.type === 'jobs.control').map(([command]) => command);
  expect(operations).toEqual([first, first]); expect(host.textContent).toContain('已搁置这项作业');
});
it('does not show another owner disposition or offer mutations for it', async () => {
  const workspace = vi.fn<Workspace>(async () => ({ ok: true, jobDisposition: { ...record, ownerId: 'bob', lastError: 'BOB_PRIVATE_ERROR' } }));
  await mount(connection(workspace).api); await click('核对处理状态与依据');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('不属于'); expect(host.textContent).not.toContain('BOB_PRIVATE_ERROR');
  expect([...host.querySelectorAll('button')].some(button => button.textContent === '恢复处理')).toBe(false);
});
it('does not rewind a newer inspected disposition with an older replay receipt', async () => {
  let reads = 0, writes = 0;
  const workspace = vi.fn<Workspace>(async command => command.type === 'jobs.control' ? ++writes === 1 ? { ok: false, error: '回复尚未确认' } : { ok: true, jobDisposition: { ...record, revision: 8 } }
    : { ok: true, jobDisposition: ++reads === 1 ? { ...record, state: 'failed' } : { ...record, state: 'abandoned', revision: 9 } });
  await mount(connection(workspace).api); await click('核对处理状态与依据'); await click('搁置这项作业'); await click('重新核对作业'); await click('重试同一次操作');
  expect(host.querySelector('.companion-job-disposition')?.getAttribute('data-state')).toBe('abandoned'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('未宣称操作完成');
});
it('does not claim success for a mismatched returned input version and keeps the original operation for review', async () => {
  const workspace = vi.fn<Workspace>(async command => ({ ok: true, jobDisposition: command.type === 'jobs.control' ? { ...record, state: 'abandoned', revision: 8, inputVersion: 'b'.repeat(64) } : record }));
  await mount(connection(workspace).api); await click('核对处理状态与依据'); await click('放弃这次处理…'); await click('确认放弃这次处理');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('未宣称操作完成'); expect(host.querySelector('[role="status"]')).toBeNull(); expect(host.textContent).toContain('重试同一次操作');
});
it('keeps unknown-result recovery explicit and does not turn it into an automatic resend', async () => {
  const workspace = vi.fn<Workspace>(async command => ({ ok: true, jobDisposition: command.type === 'jobs.control' ? { ...record, revision: 8, state: 'pending', cycleFailureCount: 0 } : record }));
  await mount(connection(workspace).api, 'alice', true); await click('核对处理状态与依据'); await click('恢复处理');
  expect(host.textContent).toContain('先前调用的结果尚未确认'); expect(host.textContent).toContain('可能再次调用模型'); expect(workspace.mock.calls.some(([command]) => command.type === 'jobs.control')).toBe(false);
  await click('确认恢复这项作业'); expect(workspace.mock.calls.filter(([command]) => command.type === 'jobs.control')).toHaveLength(1);
  expect(host.textContent).toContain('累计失败 4 次 · 本轮 0 次'); expect(host.textContent).not.toContain('已正式发布');
});
it('clears source details and rejects a late original-event read after invalidation', async () => {
  let finish!: (value: Awaited<ReturnType<WorldlineBoxCompanionsApi['request']>>) => void;
  const workspace = vi.fn<Workspace>(async () => ({ ok: true, jobDisposition: record }));
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(() => new Promise(resolve => { finish = resolve; })), c = connection(workspace, request);
  await mount(c.api); await click('核对处理状态与依据'); await click('查看仍获权的原始事件'); await act(() => c.changed());
  await act(async () => finish({ ok: true, message: { id: 'event-a', conversationId: 'private-alice', sequence: 1, revision: 1, authorId: 'user', kind: 'text', content: 'WITHDRAWN_SOURCE_CANARY', status: 'sent', attachments: [], createdAt: '2026-10-28T08:00:00.000Z' } }));
  expect(host.textContent).not.toContain('WITHDRAWN_SOURCE_CANARY'); expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'message.get', id: 'event-a' });
});
it('never exposes an event returned from a different conversation', async () => {
  const workspace = vi.fn<Workspace>(async () => ({ ok: true, jobDisposition: record }));
  const request: WorldlineBoxCompanionsApi['request'] = async () => ({ ok: true, message: { id: 'event-a', conversationId: 'bob-private', sequence: 1, authorId: 'bob', kind: 'text', content: 'WRONG_ROOM_CANARY', status: 'sent', attachments: [], createdAt: '2026-10-28T08:00:00.000Z' } });
  await mount(connection(workspace, request).api); await click('核对处理状态与依据'); await click('查看仍获权的原始事件');
  expect(host.textContent).not.toContain('WRONG_ROOM_CANARY'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('范围不匹配');
});
it('does not display a late previous-owner management receipt after switching owners', async () => {
  let finish!: (value: CompanionWorkspaceResponse) => void;
  const workspace = vi.fn<Workspace>(async command => command.type === 'jobs.inspect' && command.ownerId === 'alice' ? new Promise(resolve => { finish = resolve; }) : { ok: false, error: '无当前记录。' });
  const c = connection(workspace); await mount(c.api); await click('核对处理状态与依据');
  await act(async () => root!.render(<CompanionJobControls ownerId="bob" kind="capture" id="capture-a" api={c.api} />));
  await act(async () => finish({ ok: true, jobDisposition: record }));
  expect(host.textContent).not.toContain(record.lastError); expect(host.textContent).not.toContain('event-a');
});
it('opens the selected source-file original event only on demand and resumes the exact frozen publication operation', async () => {
  const publication: CompanionJobDisposition = { ...record, kind: 'source_files', id: 'source-publish-a' };
  let writes = 0;
  const workspace = vi.fn<Workspace>(async command => command.type !== 'jobs.control' ? { ok: true, jobDisposition: publication }
    : ++writes === 1 ? { ok: false, error: '发布恢复的响应丢失。' } : { ok: true, jobDisposition: { ...publication, state: 'pending', revision: 8, cycleFailureCount: 0 } });
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(async () => ({ ok: true, message: { id: 'event-a', conversationId: 'private-alice', sequence: 1, revision: 2,
    authorId: 'user', kind: 'text', content: 'CURRENT_AUTHORIZED_SOURCE', status: 'sent', attachments: [], createdAt: '2026-10-28T08:00:00.000Z' } }));
  await mount(connection(workspace, request).api, 'alice', false, 'source_files', publication.id);
  await click('核对处理状态与依据'); expect(request).not.toHaveBeenCalled();
  expect(workspace).toHaveBeenCalledExactlyOnceWith({ type: 'jobs.inspect', ownerId: 'alice', kind: 'source_files', id: publication.id });
  await click('查看仍获权的原始事件'); expect(host.textContent).toContain('CURRENT_AUTHORIZED_SOURCE'); expect(host.textContent).toContain('它不替代本次作业固定的输入版本');
  await click('恢复处理'); expect(host.textContent).toContain('不重新生成记忆'); expect(host.textContent).not.toContain('可能再次调用模型');
  await click('确认恢复这项作业'); await click('重试同一次操作');
  const commands = workspace.mock.calls.filter(([command]) => command.type === 'jobs.control').map(([command]) => command);
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]); expect(commands[0]).toEqual({ type: 'jobs.control', ownerId: 'alice', kind: 'source_files', id: publication.id,
    inputVersion: publication.inputVersion, expectedRevision: 7, operationId: expect.any(String), action: 'resume' });
  expect(host.textContent).not.toContain('CURRENT_AUTHORIZED_SOURCE'); expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'message.get', id: 'event-a' });
});
it('shows the exact history-file memory revision without reading current text or guessing a source conversation', async () => {
  const publication: CompanionJobDisposition = { ...record, sourceMessageId: undefined, conversationId: undefined, kind: 'history_files', id: 'history-publish-a', memoryId: 'memory-a', contentRevision: 6 };
  const workspace = vi.fn<Workspace>(async command => ({ ok: true, jobDisposition: command.type === 'jobs.control' ? { ...publication, state: 'abandoned', revision: 8 } : publication }));
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(async () => { throw new Error('No current-note substitution or guessed source read.'); });
  await mount(connection(workspace, request).api, 'alice', false, 'history_files', publication.id); await click('核对处理状态与依据');
  expect(host.textContent).toContain('本次发布的记忆修订 · r6'); expect(host.textContent).toContain('memory-a'); expect(host.textContent).toContain('此任务的正式历史正文尚未可读');
  expect([...host.querySelectorAll('button')].some(button => button.textContent === '查看仍获权的原始事件')).toBe(false); expect(request).not.toHaveBeenCalled();
  await click('放弃这次处理…'); expect(workspace).toHaveBeenCalledTimes(1); await click('确认放弃这次处理');
  expect(workspace).toHaveBeenLastCalledWith({ type: 'jobs.control', ownerId: 'alice', kind: 'history_files', id: publication.id, inputVersion: publication.inputVersion,
    expectedRevision: 7, operationId: expect.any(String), action: 'abandon' });
  expect(host.textContent).toContain('原始事件没有删除'); expect(host.querySelector('.companion-job-disposition')?.getAttribute('data-state')).toBe('abandoned'); expect(request).not.toHaveBeenCalled();
});
it('drops a source-file event response after a newer inspection removes that source pointer', async () => {
  let finish!: (value: Awaited<ReturnType<WorldlineBoxCompanionsApi['request']>>) => void, reads = 0;
  const publication: CompanionJobDisposition = { ...record, kind: 'source_files', id: 'source-publish-a' };
  const workspace = vi.fn<Workspace>(async () => ({ ok: true, jobDisposition: ++reads === 1 ? publication : { ...publication, state: 'stale', revision: 8, sourceMessageId: undefined, conversationId: undefined } }));
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(() => new Promise(resolve => { finish = resolve; }));
  await mount(connection(workspace, request).api, 'alice', false, 'source_files', publication.id); await click('核对处理状态与依据'); await click('查看仍获权的原始事件');
  await click('重新核对作业'); await act(async () => finish({ ok: true, message: { id: 'event-a', conversationId: 'private-alice', sequence: 1, revision: 1,
    authorId: 'user', kind: 'text', content: 'NO_LONGER_AUTHORIZED_CANARY', status: 'sent', attachments: [], createdAt: '2026-10-28T08:00:00.000Z' } }));
  expect(host.textContent).not.toContain('NO_LONGER_AUTHORIZED_CANARY'); expect(host.textContent).toContain('依据已失效');
});
it('shows the exact topic-compaction identity and only an explicitly opened same-topic original, preserving the frozen resume operation', async () => {
  const job: CompanionJobDisposition = { ...record, kind: 'topic_compaction', id: 'compact-a', topicId: 'topic-a' }; let writes = 0;
  const workspace = vi.fn<Workspace>(async command => command.type !== 'jobs.control' ? { ok: true, jobDisposition: job }
    : ++writes === 1 ? { ok: false, error: '恢复回复尚未确认。' } : { ok: true, jobDisposition: { ...job, revision: 8, state: 'pending', cycleFailureCount: 0 } });
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(async () => ({ ok: true, message: { id: 'event-a', conversationId: 'private-alice', topicId: 'topic-a', sequence: 1,
    authorId: 'user', content: 'ACTUAL_TOPIC_ORIGINAL', revision: 2, kind: 'text', status: 'sent', attachments: [], createdAt: '2026-10-28T08:00:00.000Z' } }));
  await mount(connection(workspace, request).api, 'alice', false, 'topic_compaction', job.id); await click('核对处理状态与依据');
  expect(host.textContent).toContain('话题摘要整理'); expect(host.textContent).toContain('待整理部分会保留缺口'); expect(host.textContent).toContain('topic-a'); expect(request).not.toHaveBeenCalled();
  await click('查看仍获权的原始事件'); expect(host.textContent).toContain('ACTUAL_TOPIC_ORIGINAL'); expect(host.textContent).toContain('不代表整段话题已完成摘要');
  await click('恢复处理'); expect(workspace.mock.calls.some(([command]) => command.type === 'jobs.control')).toBe(false);
  await click('确认恢复这项作业'); await click('重试同一次操作');
  const commands = workspace.mock.calls.filter(([command]) => command.type === 'jobs.control').map(([command]) => command);
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]); expect(commands[0]).toEqual({ type: 'jobs.control', ownerId: 'alice', kind: 'topic_compaction', id: job.id,
    inputVersion: job.inputVersion, expectedRevision: 7, operationId: expect.any(String), action: 'resume' }); expect(host.textContent).not.toContain('ACTUAL_TOPIC_ORIGINAL');
});
it.each(['different-topic', 'missing-topic', 'draft', 'failed'] as const)('rejects a %s original returned for topic-compaction without displaying its content', async mode => {
  const job: CompanionJobDisposition = { ...record, kind: 'topic_compaction', id: 'compact-a', topicId: 'topic-a' };
  const workspace = vi.fn<Workspace>(async () => ({ ok: true, jobDisposition: job }));
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(async () => ({ ok: true, message: { id: 'event-a', conversationId: 'private-alice',
    ...(mode === 'missing-topic' ? {} : { topicId: mode === 'different-topic' ? 'topic-b' : 'topic-a' }), sequence: 1, authorId: 'user', kind: 'text',
    content: 'INVALID_TOPIC_ORIGINAL_CANARY', status: mode === 'failed' ? 'failed' : 'sent', ...(mode === 'draft' ? { isReplyDraft: true } : {}), attachments: [], createdAt: '2026-10-28T08:00:00.000Z' } }));
  await mount(connection(workspace, request).api, 'alice', false, 'topic_compaction', job.id); await click('核对处理状态与依据'); await click('查看仍获权的原始事件');
  expect(host.textContent).not.toContain('INVALID_TOPIC_ORIGINAL_CANARY'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('范围不匹配');
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'message.get', id: 'event-a' }); expect(workspace).toHaveBeenCalledTimes(1);
});
