// @vitest-environment happy-dom
import { Activity, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMemoryLibraryWorkspace } from '../../src/renderer/companions/CompanionMemoryLibraryWorkspace';
import { CompanionMemoryManager } from '../../src/renderer/companions/CompanionMemoryManager';
import { CompanionRecentReadCache } from '../../src/renderer/companions/recent-read-cache';
import type { Companion, CompanionMemory, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionMemoryDocumentRead } from '../../src/shared/companion-memory-documents';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
const at = '2026-10-28T08:00:00.000Z', owner: Companion = { id: 'alice', name: 'Alice', description: '', persona: '完整角色起点', model: '', avatar: 'custom', builtin: false, proactive: false, createdAt: at };
const memory: CompanionMemory = { artifactKind: 'knowledge', id: 'note1', companionId: 'alice', scopeId: 'scope', content: '这份知识只在小文件上经过验证。', tags: ['适用条件'], diaryName: '阅读', sourceConversationId: 'room', sourceSequence: 1, sources: [], origin: 'companion', status: 'indexed', captureMethod: 'automatic', version: 2, contentRevision: 2, createdAt: at, updatedAt: at };
const read: CompanionMemoryDocumentRead = { document: { path: '记忆/知识/阅读/note1.md', name: 'note1.md', title: '有条件的知识', directory: '记忆/知识/阅读', kind: 'note', category: 'material', updatedAt: at, createdAt: at, bytes: 50, revision: 'revision2', contentHash: 'a'.repeat(64), readOnly: false, tags: ['适用条件'], syncState: 'indexed', noteId: 'note1', version: 2, captureMethod: 'automatic' }, content: memory.content, memory, sources: [{ id: 'message1', conversationId: 'room', sequence: 1, revision: 1, authorId: 'user', kind: 'text', content: '真实原消息，并未说所有情况都有效。', createdAt: at, status: 'sent', attachments: [] }], hasMoreSources: false };
async function mount(draft = false, manager = false) {
  vi.useFakeTimers();
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command => command.type === 'memory.documents.list' ? { ok: true, documents: { companionId: 'alice', directory: '', folders: [{ path: '记忆/知识', name: '知识', count: 1 }, { path: '证据/来源', name: '来源', count: 1 }], items: [read.document], hasMore: false, total: 1 } } : command.type === 'memory.documents.read' ? { ok: true, document: read } : command.type === 'memory.documents.delete' ? { ok: true, deletedPath: read.document.path } : { ok: true });
  const listeners = new Set<Parameters<WorldlineBoxCompanionsApi['onChanged']>[0]>();
  const request = vi.fn(async () => ({ ok: true }));
  const api: WorldlineBoxCompanionsApi = { workspace, request, onChanged: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, onReplyStream: () => () => undefined };
  const consumed = vi.fn(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const common = { companions: [owner], api, request, draft: draft ? { content: '用户改写的记忆草稿', sourceMessageId: 'message1', nonce: 1 } : undefined, onDraftConsumed: consumed, onOwnerChange: vi.fn(), onLocateSource: vi.fn(), authorName: (id: string) => id, onClose: vi.fn(), onDismissError: vi.fn() };
  const render = async (active = true, hidden = false) => { await act(async () => root!.render(<Activity mode={hidden ? 'hidden' : 'visible'}>{manager ? <CompanionMemoryManager {...common} ownerId="alice" active={active} /> : <CompanionMemoryLibraryWorkspace {...common} companionId="alice" active={active} />}</Activity>)); };
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(400); }); return { workspace, consumed, request, render, listeners, emit: (change?: Parameters<Parameters<WorldlineBoxCompanionsApi['onChanged']>[0]>[0]) => listeners.forEach(callback => callback(change)) };
}
async function click(label: string) { await act(async () => [...host.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label || button.textContent === label)!.click()); }
it('keeps memories read-only even when an old server object incorrectly says editable, while preserving exact text and provenance', async () => {
  const f = await mount(); expect(host.textContent).toContain(memory.content); expect(host.textContent).toContain('知识与方法');
  expect(host.querySelector('textarea')).toBeNull(); for (const label of ['新建记忆文档', '新建记忆文件夹', '编辑记忆 note1']) expect(host.querySelector(`[aria-label="${label}"]`)).toBeNull();
  expect(host.textContent).not.toContain('另存为资料'); expect(host.textContent).not.toContain('保存修正');
  await click('查看记忆来源 note1'); expect(host.textContent).toContain(read.sources[0]!.content); expect(host.textContent).toContain('修订2');
  expect(f.workspace.mock.calls.some(([command]) => ['memory.documents.create', 'memory.documents.save', 'memory.documents.move', 'memory.documents.mkdir'].includes(command.type))).toBe(false);
});
it('does not convert an incoming remember-message draft into editable or artificial experience', async () => {
  const f = await mount(true); expect(f.consumed).toHaveBeenCalledOnce(); expect(host.querySelector('textarea')).toBeNull();
  expect(host.textContent).toContain('不能把摘录草稿直接作为新的经历'); expect(host.textContent).not.toContain('用户改写的记忆草稿');
  expect(f.workspace.mock.calls.some(([command]) => command.type === 'memory.documents.create')).toBe(false);
});
it('treats privacy withdrawal as an explicit revisioned operation rather than an editor', async () => {
  const f = await mount(); await click('查看记忆来源 note1'); await click('撤回记忆 note1');
  expect(f.workspace.mock.calls.some(([command]) => command.type === 'memory.documents.delete')).toBe(false);
  await click('确认撤回记忆'); expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.documents.delete', companionId: 'alice', path: read.document.path, expectedRevision: 'revision2' });
});

it('keeps memory metadata cached and avoids document or policy reads during progress notifications', async () => {
  const clear = vi.spyOn(CompanionRecentReadCache.prototype, 'clear');
  const f = await mount(false, true), calls = f.workspace.mock.calls.length, statuses = f.request.mock.calls.length;
  expect(host.textContent).toContain(memory.content);
  await act(async () => { for (let index = 0; index < 20; index++) f.emit({ kind: 'progress' }); await vi.advanceTimersByTimeAsync(1100); });
  expect(f.workspace).toHaveBeenCalledTimes(calls); expect(f.request).toHaveBeenCalledTimes(statuses); expect(clear).not.toHaveBeenCalled();
  expect(host.textContent).toContain(memory.content);
});

it('revalidates the selected body on a semantic signal even if file metadata is unchanged', async () => {
  const f = await mount(false, true), original = f.workspace.getMockImplementation()!;
  f.workspace.mockImplementation(command => command.type === 'memory.documents.read' ? Promise.resolve({ ok: false, error: '这条记忆的来源已经撤回。' }) : original(command));
  const reads = f.workspace.mock.calls.filter(([command]) => command.type === 'memory.documents.read').length;
  await act(async () => f.emit());
  expect(host.textContent).not.toContain(memory.content);
  await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
  expect(f.workspace.mock.calls.filter(([command]) => command.type === 'memory.documents.read')).toHaveLength(reads + 1);
  expect(host.textContent).toContain('来源已经撤回'); expect(host.textContent).not.toContain(memory.content);
});

it.each(['inactive', 'activity'] as const)('keeps a former memory body hidden on the first restored frame while its fresh read is pending (%s)', async mode => {
  const f = await mount(false, true), original = f.workspace.getMockImplementation()!;
  let finish!: (value: { ok: false; error: string }) => void;
  f.workspace.mockImplementation(command => command.type === 'memory.documents.read' ? new Promise(resolve => { finish = resolve; }) : original(command));
  await f.render(mode !== 'inactive', mode === 'activity');
  const calls = f.workspace.mock.calls.length;
  await act(async () => { for (let index = 0; index < 20; index++) f.emit({ kind: 'progress' }); await vi.advanceTimersByTimeAsync(1100); });
  expect(f.workspace).toHaveBeenCalledTimes(calls);
  await f.render();
  expect(host.textContent).not.toContain(memory.content);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); finish({ ok: false, error: '恢复时来源已撤回。' }); });
  expect(host.textContent).not.toContain(memory.content); expect(host.textContent).toContain('恢复时来源已撤回');
});
