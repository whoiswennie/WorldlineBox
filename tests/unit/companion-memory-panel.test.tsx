// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMemoryLibraryWorkspace } from '../../src/renderer/companions/CompanionMemoryLibraryWorkspace';
import { CompanionMemoryManager } from '../../src/renderer/companions/CompanionMemoryManager';
import type { CompanionMemoryDraft } from '../../src/renderer/companions/companion-memory-draft';
import type { Companion, CompanionMessage, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionMemoryDocument, CompanionMemoryDocumentRead } from '../../src/shared/companion-memory-documents';
import type { CompanionWorkspaceRequest, CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.useRealTimers(); });
const at = '2026-10-21T09:00:00.000Z';
const owner = { id: 'role', name: '测试伙伴', avatar: 'custom' } as Companion;
const source: CompanionMessage = { id: 'source', conversationId: 'other-room', sequence: 5, authorId: 'user', content: '我们沿着灯塔旁的小路走到了海边。', status: 'sent', kind: 'text', attachments: [], createdAt: at };
const doc: CompanionMemoryDocument = { path: '日记/海边散步.md', name: '海边散步.md', title: '海边散步', directory: '日记', kind: 'note', category: 'diary', updatedAt: at, bytes: 80, contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', revision: 'version-2', readOnly: false, tags: ['海边', '散步'], syncState: 'indexed', noteId: 'memory-a', version: 2, sourceConversationId: source.conversationId, sourceCount: 1, captureMethod: 'automatic', excerpt: '今天与朋友去海边散步。' };
function readFixture(item = doc, content = '# 海边散步\n\n今天与朋友去海边散步。'): CompanionMemoryDocumentRead {
  return { document: item, content, sources: item.kind === 'note' ? [source] : [], hasMoreSources: false,
    ...(item.noteId ? { memory: { id: item.noteId, companionId: 'role', scopeId: 'scope', content, tags: item.tags, diaryName: '生活札记', sourceConversationId: 'other-room', sources: [{ sourceType: 'message' as const, messageId: source.id, conversationId: source.conversationId, sequence: 5, authorId: source.authorId, revision: 1, checksum: 'checksum', createdAt: at }], sourceSequence: 5, createdAt: at, updatedAt: at, origin: 'companion' as const, status: 'indexed' as const, version: item.version ?? 2, captureMethod: 'automatic' as const } } : {}) };
}
const processing = { pending: 1, running: 0, failed: 1, completed: 4, memories: 2, forgotten: 0, indexed: 1, pendingIndex: 1, messageWatermark: 5, captureWatermark: 4, backfillThrough: 5, backfillTarget: 5, lastError: '收录服务暂不可用' };
function fixture() {
  let documents = [readFixture(), readFixture({ ...doc, path: '资料/灯塔路线.md', name: '灯塔路线.md', title: '灯塔路线', directory: '资料', category: 'material', noteId: 'memory-b' }, '从旧灯塔出发，沿着防波堤步行。'), readFixture({ ...doc, path: '时间线/VCP-2026-10.md', name: 'VCP-2026-10.md', title: '十月时间线', directory: '时间线', category: 'timeline', kind: 'timeline', noteId: undefined, version: undefined, readOnly: true, tags: [], syncState: 'generated' }, '## 十月\n\n自动整理的生活时间线。')];
  let changed: (() => void) | undefined;
  const workspace = vi.fn(async (command: CompanionWorkspaceRequest): Promise<CompanionWorkspaceResponse> => {
    if (command.type === 'status') return { ok: true, selected: { displayName: '生活资产库', libraryId: 'lib', libraryPath: 'D:/library', memoryRoot: 'D:/library/伙伴记忆', dataRoot: 'D:/library/.companions' } };
    if (command.type === 'memory.documents.list') return { ok: true, documents: { companionId: command.companionId, directory: command.directory, folders: [{ path: '日记', name: '日记', count: 1 }, { path: '资料', name: '资料', count: 1 }, { path: '自我认识', name: '自我认识', count: 0 }, { path: '世界经历', name: '世界经历', count: 0 }, { path: '时间线', name: '时间线', count: 1 }], items: documents.filter(item => (!command.directory || item.document.path.startsWith(command.directory + '/')) && (!command.query || [item.document.title, item.content].join(' ').includes(command.query)) && (!command.tags?.length || command.tags.every(tag => item.document.tags.includes(tag)))).map(item => item.document), hasMore: false } };
    if (command.type === 'memory.documents.read') { const item = documents.find(item => item.document.path === command.path); return item ? { ok: true, document: item } : { ok: false, error: '文档已移动。' }; }
    if (command.type === 'memory.documents.save') {
      const index = documents.findIndex(item => item.document.path === command.path), previous = documents[index];
      if (!previous || previous.document.revision !== command.expectedRevision) return { ok: false, error: '文档已有新版本，请重新打开后核对。' };
      const next = { ...previous, content: command.content, document: { ...previous.document, tags: command.tags ?? previous.document.tags, version: 3, revision: 'version-3', syncState: 'pending' as const }, memory: previous.memory ? { ...previous.memory, content: command.content, diaryName: command.diaryName ?? previous.memory.diaryName, tags: command.tags ?? previous.memory.tags, version: 3 } : undefined };
      documents[index] = next; return { ok: true, document: next };
    }
    if (command.type === 'memory.documents.create') { const item = readFixture({ ...doc, path: command.path, name: command.path.split('/').at(-1)!, title: command.path.split('/').at(-1)!.replace(/\.md$/u, ''), noteId: 'memory-new', version: 1, tags: command.tags }, command.content); documents = [...documents, item]; return { ok: true, document: item }; }
    if (command.type === 'memory.documents.move') { const previous = documents.find(item => item.document.path === command.path)!; const item = { ...previous, document: { ...previous.document, path: command.targetPath, name: command.targetPath.split('/').at(-1)!, title: command.targetPath.split('/').at(-1)!.replace(/\.md$/u, '') } }; documents = documents.map(entry => entry === previous ? item : entry); return { ok: true, document: item }; }
    if (command.type === 'memory.documents.delete') { documents = documents.filter(item => item.document.path !== command.path); return { ok: true, deletedPath: command.path }; }
    if (command.type === 'memory.documents.mkdir') return { ok: true, createdDirectory: command.path };
    return { ok: true };
  });
  const request = vi.fn(async (command: CompanionsRequest): Promise<CompanionsResponse> => command.type === 'memory.status' ? { ok: true, memoryStatus: processing } : command.type === 'memory.policy.list' ? { ok: true, memoryPolicies: [{ id: 'rule', companionId: 'role', conversationId: 'other-room', requestSnippet: '', reason: 'persistent-topic', tags: ['饮料偏好'], blocked: true, createdAt: at }] } : { ok: true });
  const api = { workspace, onChanged: vi.fn((callback: () => void) => { changed = callback; return () => { changed = undefined; }; }) } as unknown as WorldlineBoxCompanionsApi;
  return { workspace, request, api, emit: () => changed?.() };
}
async function mount(f = fixture(), options: { draft?: CompanionMemoryDraft } = {}) {
  vi.useFakeTimers(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const onOwnerChange = vi.fn(), onClose = vi.fn(), onLocateSource = vi.fn(), onDraftConsumed = vi.fn();
  await act(async () => root!.render(<CompanionMemoryLibraryWorkspace companions={[owner, { ...owner, id: 'other', name: '另一位伙伴' }]} companionId="role" api={f.api} request={f.request} onDraftConsumed={onDraftConsumed} onOwnerChange={onOwnerChange} onLocateSource={onLocateSource} authorName={id => id === 'user' ? '你' : '伙伴'} onClose={onClose} onDismissError={vi.fn()} {...options} />));
  await advance(); return { ...f, onOwnerChange, onClose, onLocateSource, onDraftConsumed };
}
async function advance() { await act(async () => { await vi.advanceTimersByTimeAsync(400); }); }
function element<T extends HTMLElement>(selector: string) { const found = container!.querySelector<T>(selector); if (!found) throw new Error('Missing element ' + selector); return found; }
function button(label: string) { const found = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label); if (!found) throw new Error('Missing button ' + label); return found; }
async function click(label: string) { await act(async () => button(label).click()); await advance(); }
async function fill(label: string, value: string) { const item = element<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`); const prototype = item instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(item, value); item.dispatchEvent(new Event('input', { bubbles: true })); }); }

it('opens the full owner document space independently of the current chat and exposes real folders', async () => {
  const f = await mount(); expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.documents.list', companionId: 'role', directory: '', limit: 64 });
  expect(container!.textContent).toContain('伙伴记忆库'); expect(container!.textContent).toContain('学习资料'); expect(container!.textContent).toContain('世界经历'); expect(container!.textContent).not.toContain('与你有关');
  expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.documents.read', companionId: 'role', path: doc.path, sourceLimit: 30 });
  expect(f.request.mock.calls.some(([command]) => command.type === 'memory.browse' || command.type === 'memory.search')).toBe(false);
  await click('学习资料1'); expect(f.workspace).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'memory.documents.read', path: '资料/灯塔路线.md' }));
});
it('reads full Markdown and exposes literal provenance without duplicating it in the file list', async () => {
  const f = await mount(); expect(element('.memory-library-paper h1').textContent).toBe('海边散步'); await click('查看记忆来源 memory-a'); expect(element('.memory-library-source p').textContent).toBe(source.content); await click('定位记忆来源 source'); expect(f.onLocateSource).toHaveBeenCalledWith(source);
});
it('edits full content, tags and diary metadata using the original optimistic revision', async () => {
  const f = await mount(); await click('编辑记忆 memory-a'); await fill('共同记忆内容', '# 新的日记\n\n这次去了北面的海岸。'); await fill('文档标签', '海岸，散步，海岸'); await fill('文档日记本', '出行札记'); await click('保存修正');
  expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.documents.save', companionId: 'role', path: doc.path, expectedRevision: 'version-2', content: '# 新的日记\n\n这次去了北面的海岸。', tags: ['海岸', '散步'], autoTags: false, diaryName: '出行札记' }); expect(container!.textContent).toContain('文档已保存'); expect(element('.memory-library-markdown').textContent).toContain('这次去了北面的海岸');
});
it('keeps rejected concurrent edits and their revision for review instead of claiming success', async () => {
  const f = fixture(), base = f.workspace.getMockImplementation()!; f.workspace.mockImplementation(command => command.type === 'memory.documents.save' ? Promise.resolve({ ok: false, error: '文档已有新版本，请重新打开后核对。' }) : base(command));
  await mount(f); await click('编辑记忆 memory-a'); await fill('共同记忆内容', '我仍需要保留这份修改。'); await click('保存修正'); expect(element<HTMLTextAreaElement>('textarea').value).toBe('我仍需要保留这份修改。'); expect(container!.textContent).toContain('文档已有新版本'); expect(container!.textContent).not.toContain('文档已保存');
});
it('waits for the latest document after discarding a stale edit before exposing edit actions again', async () => {
  const f = fixture(), base = f.workspace.getMockImplementation()!;
  let deferRead = false, resolveRead: ((value: CompanionWorkspaceResponse) => void) | undefined;
  f.workspace.mockImplementation(command => command.type === 'memory.documents.read' && deferRead ? new Promise(resolve => { resolveRead = resolve; }) : base(command));
  await mount(f); await click('编辑记忆 memory-a'); await fill('共同记忆内容', '尚未保存的修正'); deferRead = true;
  await click('取消编辑'); await click('放弃修改并离开');
  expect(container!.querySelector('[aria-label="编辑记忆 memory-a"]')).toBeNull();
  await act(async () => resolveRead!({ ok: true, document: readFixture({ ...doc, version: 3, revision: 'version-3' }, '来自另一处的新版本') }));
  await click('编辑记忆 memory-a'); expect(element<HTMLTextAreaElement>('textarea').value).toBe('来自另一处的新版本');
});
it('creates a named Markdown document through the human file API with no fake chat message', async () => {
  const f = await mount(); await click('新建记忆文档'); await fill('新文档路径', '资料/阅读/海岸札记'); await fill('共同记忆内容', '这是一篇新写的阅读资料。'); await fill('文档标签', '阅读，海岸'); await click('保存文档'); expect(f.workspace).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.documents.create', path: '资料/阅读/海岸札记.md', content: '这是一篇新写的阅读资料。', tags: ['阅读', '海岸'] })); expect(f.request.mock.calls.some(([command]) => command.type === 'memory.save')).toBe(false);
});
it('preserves the real source when the remember-message action opens a new document draft', async () => {
  const f = await mount(fixture(), { draft: { content: '原始消息', sourceMessageId: 'source', nonce: 7 } }); expect(f.onDraftConsumed).toHaveBeenCalled(); await click('保存文档'); expect(f.workspace).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.documents.create', content: '原始消息', sourceMessageId: 'source' }));
});
it('asks before leaving an unsaved edit and navigates only after explicit discard', async () => {
  const f = await mount(); await click('编辑记忆 memory-a'); await fill('共同记忆内容', '尚未保存的文字'); await click('关闭共同记忆管理'); expect(f.onClose).not.toHaveBeenCalled(); expect(element('[role="alertdialog"]').textContent).toContain('未保存'); await click('继续编辑'); expect(element<HTMLTextAreaElement>('textarea').value).toBe('尚未保存的文字'); await click('关闭共同记忆管理'); await click('放弃修改并离开'); expect(f.onClose).toHaveBeenCalledOnce();
});
it('renames or moves the real file with its revision while retaining the note identity', async () => {
  const f = await mount(); await click('查看记忆来源 memory-a'); await click('重命名或移动'); await fill('文档目标路径', '资料/海边回忆.md'); await click('确认保存'); expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.documents.move', companionId: 'role', path: doc.path, targetPath: '资料/海边回忆.md', expectedRevision: 'version-2' }); expect(container!.textContent).toContain('文件已移动'); expect(button('阅读记忆 memory-a')).toBeTruthy();
});
it('requires explicit confirmation before deleting and withdrawing the document', async () => {
  const f = await mount(); await click('查看记忆来源 memory-a'); await click('删除记忆 memory-a'); expect(f.workspace.mock.calls.some(([command]) => command.type === 'memory.documents.delete')).toBe(false); expect(container!.textContent).toContain('原始聊天仍保留'); await click('确认遗忘'); expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.documents.delete', companionId: 'role', path: doc.path, expectedRevision: 'version-2' }); expect(container!.textContent).toContain('旧来源已退出召回');
});
it('opens generated timelines read-only and explicitly copies them into learning materials', async () => {
  const f = await mount(); await click('阅读文档 时间线/VCP-2026-10.md'); expect(container!.querySelector('button[aria-label="编辑记忆 时间线/VCP-2026-10.md"]')).toBeNull(); await click('另存为资料'); expect(element<HTMLInputElement>('[aria-label="新文档路径"]').value).toBe('资料/十月时间线-副本.md'); expect(element<HTMLTextAreaElement>('textarea').value).toContain('自动整理的生活时间线'); await click('保存文档'); expect(f.workspace).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.documents.create', path: '资料/十月时间线-副本.md' }));
});
it('creates a real nested directory instead of inventing an in-memory notebook', async () => {
  const f = await mount(); await click('新建记忆文件夹'); await fill('记忆文件夹路径', '资料/书籍'); await click('确认保存'); expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.documents.mkdir', companionId: 'role', path: '资料/书籍' }); expect(container!.textContent).toContain('文件夹已创建');
});
it('searches all server documents and passes selected tags to the full-library query', async () => {
  await mount(); await fill('搜索全部记忆文档', '灯塔'); await advance(); expect(container!.querySelectorAll('.memory-library-file')).toHaveLength(1); expect(element('.memory-library-file').textContent).toContain('灯塔路线'); await fill('搜索全部记忆文档', ''); await advance(); await click('#海边'); expect(container!.querySelectorAll('.memory-library-file')).toHaveLength(2);
});
it('uses the real string cursor and replaces later pages with bounded file rows', async () => {
  const f = fixture(), base = f.workspace.getMockImplementation()!;
  f.workspace.mockImplementation(async command => {
    const response = await base(command);
    if (command.type === 'memory.documents.list' && response.documents) return { ...response, documents: { ...response.documents, hasMore: !command.cursor, ...(command.cursor ? {} : { nextCursor: '资料/灯塔路线.md' }) } };
    return response;
  });
  await mount(f); await click('下一页文档');
  expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.documents.list', companionId: 'role', directory: '', limit: 64, cursor: '资料/灯塔路线.md' });
  expect(container!.querySelectorAll('.memory-library-file')).toHaveLength(3);
  await click('上一页文档');
  expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.documents.list', companionId: 'role', directory: '', limit: 64 });
});
it('ignores a late directory response after the user has opened a different notebook', async () => {
  const f = fixture(), base = f.workspace.getMockImplementation()!;
  let resolveOld: ((value: CompanionWorkspaceResponse) => void) | undefined;
  f.workspace.mockImplementation(command => command.type === 'memory.documents.list' && command.directory === '资料' ? new Promise(resolve => { resolveOld = resolve; }) : base(command));
  await mount(f); await click('学习资料1'); await click('日记1');
  await act(async () => resolveOld!({ ok: true, documents: { companionId: 'role', directory: '资料', folders: [], items: [{ ...doc, title: '过时的目录响应' }], hasMore: false } }));
  expect(element('.memory-library-files').textContent).not.toContain('过时的目录响应');
  expect(element('.memory-library-files h3').textContent).toBe('日记');
});
it('keeps background changes from discarding dirty text or forcing narrow navigation', async () => {
  const f = await mount(); await click('阅读记忆 memory-a'); await click('返回文档'); await act(async () => f.emit()); await advance(); expect(element('.companion-memory-library').className).toContain('is-list'); await click('编辑记忆 memory-a'); await fill('共同记忆内容', '尚未完成的长篇日记'); await act(async () => f.emit()); await advance(); expect(element<HTMLTextAreaElement>('textarea').value).toBe('尚未完成的长篇日记');
});
it('shows owner-wide processing and explicit release of future topic restrictions', async () => {
  const f = await mount(); await click('收录与记录规则'); expect(container!.textContent).toContain('收录服务暂不可用'); expect(container!.textContent).toContain('饮料偏好'); await click('重试失败收录'); expect(f.request).toHaveBeenCalledWith({ type: 'memory.jobs.retry', companionId: 'role' }); await click('重建记忆索引'); expect(f.request).toHaveBeenCalledWith({ type: 'memory.index.rebuild', companionId: 'role' }); await click('允许今后记录此主题'); expect(f.request).toHaveBeenCalledWith({ type: 'memory.policy.release', companionId: 'role', id: 'rule' }); expect(container!.textContent).toContain('旧的已遗忘来源仍被排除');
});
it('sends keyword, semantic and arbitrary tag searches to the server instead of filtering the first page', async () => {
  const f = await mount(); await fill('搜索全部记忆文档', '海岸的漫步'); await advance();
  expect(f.workspace).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.documents.list', query: '海岸的漫步', mode: 'keyword' }));
  const select = element<HTMLSelectElement>('[aria-label="记忆文档搜索方式"]');
  await act(async () => { select.value = 'semantic'; select.dispatchEvent(new Event('change', { bubbles: true })); }); await advance();
  expect(f.workspace).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.documents.list', query: '海岸的漫步', mode: 'semantic' }));
  await fill('按标签筛选记忆文档', '第九万篇的标签，学习'); await advance();
  expect(f.workspace).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.documents.list', tags: ['第九万篇的标签', '学习'] }));
});
it('bounds file and notebook DOM even when catalog metadata is very large', async () => {
  const f = fixture(), base = f.workspace.getMockImplementation()!;
  f.workspace.mockImplementation(async command => {
    const result = await base(command); if (command.type !== 'memory.documents.list' || !result.documents) return result;
    return { ...result, documents: { ...result.documents, total: 100000, index: { state: 'building' as const, indexed: 2000, total: 100000 }, folders: Array.from({ length: 10000 }, (_, i) => ({ path: '资料/文件夹' + i, name: '文件夹' + i, count: 10 })), items: Array.from({ length: 2000 }, (_, i) => ({ ...doc, path: '日记/' + i + '.md', title: '第' + i + '篇' })) } };
  });
  await mount(f); expect(container!.querySelectorAll('.memory-library-file')).toHaveLength(64);
  expect(container!.querySelectorAll('.memory-library-folders button').length).toBeLessThan(40);
  expect(container!.textContent).toContain('已扫描2000篇，结果暂未完整');
});
it('retains separate unsaved owner drafts when switching companions within this library', async () => {
  const f = await mount();
  function Harness() { const [ownerId, setOwnerId] = useState('role'); return <CompanionMemoryManager companions={[owner, { ...owner, id: 'other', name: '另一位伙伴' }]} ownerId={ownerId} request={f.request} api={f.api} onDraftConsumed={vi.fn()} onDismissError={vi.fn()} authorName={id => id} onOwnerChange={setOwnerId} onLocateSource={vi.fn()} onClose={vi.fn()} />; }
  await act(async () => root!.render(<Harness />)); await advance();
  await click('编辑记忆 memory-a'); await fill('共同记忆内容', '第一位伙伴未保存的长篇草稿');
  const changeOwner = async (id: string) => { const select = element<HTMLSelectElement>('[aria-label="记忆所属伙伴"]'); await act(async () => { select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })); }); await advance(); };
  await changeOwner('other'); expect(container!.querySelector('textarea')).toBeNull();
  await changeOwner('role'); expect(element<HTMLTextAreaElement>('textarea').value).toBe('第一位伙伴未保存的长篇草稿');
});
it('leaves unchanged tags to the background strategy but treats an explicit empty edit as manual', async () => {
  const f = await mount(); await click('编辑记忆 memory-a'); await fill('共同记忆内容', '只改正文，不改标签。'); await click('保存修正');
  const first = f.workspace.mock.calls.find(([command]) => command.type === 'memory.documents.save')![0];
  expect(first).not.toHaveProperty('tags'); expect(first).not.toHaveProperty('autoTags');
  await click('编辑记忆 memory-a'); await fill('文档标签', ''); await click('保存修正');
  const last = f.workspace.mock.calls.filter(([command]) => command.type === 'memory.documents.save').at(-1)![0];
  expect(last).toMatchObject({ tags: [], autoTags: false });
});
it('shows a real waiting-model tag state and cancels the revisioned job without losing saved text', async () => {
  const f = fixture(), base = f.workspace.getMockImplementation()!;
  const tagged = { ...readFixture(), tagStatus: { pending: 0, running: 0, waitingModel: 1, failed: 0, completed: 0, cancelled: 0, note: { noteId: 'memory-a', version: 2, state: 'waiting_model' as const } } };
  f.workspace.mockImplementation(async command => command.type === 'memory.documents.read' ? { ok: true, document: tagged } : command.type === 'memory.documents.tags.cancel' ? { ok: true, document: { ...tagged, document: { ...tagged.document, autoTagsEnabled: false }, tagStatus: { ...tagged.tagStatus, note: { ...tagged.tagStatus.note, state: 'cancelled' as const } } } } : base(command));
  await mount(f); expect(container!.textContent).toContain('正文已保存，等待全局聊天模型生成标签');
  await click('查看记忆来源 memory-a'); await click('取消自动标签');
  expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.documents.tags.cancel', companionId: 'role', path: doc.path, expectedRevision: 'version-2' });
  expect(element('.memory-library-markdown').textContent).toContain('今天与朋友去海边散步'); expect(container!.textContent).toContain('已取消自动标签');
});
it('offers retry for a failed tag job and reads back the real queue state', async () => {
  const f = fixture(), base = f.workspace.getMockImplementation()!;
  const tagged = { ...readFixture(), tagStatus: { pending: 0, running: 0, waitingModel: 0, failed: 1, completed: 0, cancelled: 0, note: { noteId: 'memory-a', version: 2, state: 'failed' as const, error: '格式无效' } } };
  f.workspace.mockImplementation(async command => command.type === 'memory.documents.read' ? { ok: true, document: tagged } : command.type === 'memory.documents.tags.retry' ? { ok: true, document: { ...tagged, tagStatus: { ...tagged.tagStatus, note: { ...tagged.tagStatus.note, state: 'pending' as const } } } } : base(command));
  await mount(f); await click('查看记忆来源 memory-a'); await click('重试生成标签');
  expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.documents.tags.retry', companionId: 'role', path: doc.path, expectedRevision: 'version-2' });
  expect(container!.textContent).toContain('标签等待自动整理');
});
it('rechecks the first page while building, disables cursors, and pauses polling around a draft', async () => {
  const f = fixture(), base = f.workspace.getMockImplementation()!; let ready = false;
  f.workspace.mockImplementation(async command => {
    const result = await base(command); if (command.type !== 'memory.documents.list' || !result.documents) return result;
    return { ...result, documents: { ...result.documents, hasMore: true, nextCursor: '资料/灯塔路线.md', index: { state: ready ? 'ready' as const : 'building' as const, indexed: 3 } } };
  });
  await mount(f); expect(button('下一页文档').disabled).toBe(true);
  const calls = () => f.workspace.mock.calls.filter(([command]) => command.type === 'memory.documents.list');
  const initial = calls().length; await act(async () => { await vi.advanceTimersByTimeAsync(1100); }); expect(calls().length).toBeGreaterThan(initial);
  expect(calls().at(-1)![0]).not.toHaveProperty('cursor');
  await click('编辑记忆 memory-a'); const editingCalls = calls().length;
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); }); expect(calls()).toHaveLength(editingCalls);
  ready = true; await click('取消编辑'); await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
  expect(button('下一页文档').disabled).toBe(false); expect(container!.textContent).not.toContain('结果暂未完整');
});
it('does not surface stale search errors after a newer full-library query succeeds', async () => {
  const f = fixture(), base = f.workspace.getMockImplementation()!;
  let rejectOld: ((value: CompanionWorkspaceResponse) => void) | undefined;
  f.workspace.mockImplementation(command => command.type === 'memory.documents.list' && command.query === '旧请求' ? new Promise(resolve => { rejectOld = resolve; }) : base(command));
  await mount(f); await fill('搜索全部记忆文档', '旧请求'); await advance(); await fill('搜索全部记忆文档', '海边'); await advance();
  await act(async () => rejectOld!({ ok: false, error: '已经过时的搜索错误' }));
  expect(container!.textContent).not.toContain('已经过时的搜索错误'); expect(element('.memory-library-files').textContent).toContain('海边散步');
});

it('refreshes metadata without repeatedly transferring an unchanged selected document on unrelated background events', async () => {
  const f = await mount();
  const readCalls = () => f.workspace.mock.calls.filter(([command]) => command.type === 'memory.documents.read').length;
  const previous = readCalls();
  await act(async () => { f.emit(); f.emit(); }); await advance();
  expect(readCalls()).toBe(previous);
  expect(element('.memory-library-paper h1').textContent).toBe('海边散步');
});

it('sends explicit time sorting and a complete local date range to the server', async () => {
  const f = await mount(); await click('高级筛选记忆文档');
  const sort = element<HTMLSelectElement>('[aria-label="记忆文档排序"]');
  await act(async () => { sort.value = 'created_asc'; sort.dispatchEvent(new Event('change', { bubbles: true })); });
  await fill('记忆开始日期', '2026-10-20'); await fill('记忆结束日期', '2026-10-22'); await advance();
  const latest = f.workspace.mock.calls.filter(([command]) => command.type === 'memory.documents.list').at(-1)![0];
  expect(latest).toMatchObject({ sort: 'created_asc', dateField: 'updatedAt', from: new Date('2026-10-20T00:00:00.000').toISOString(), to: new Date('2026-10-22T23:59:59.999').toISOString() });
});
