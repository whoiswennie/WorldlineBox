import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Companion, CompanionMessage, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionMemoryDocument, CompanionMemoryDocumentCommand, CompanionMemoryDocumentRead, CompanionMemoryDocumentsPage } from '../../shared/companion-memory-documents';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import type { CompanionMemoryDraft } from './companion-memory-draft';
import { Avatar } from './CompanionVisuals';
import { MessageContent } from './MessageContent';
import { MemoryDocumentProcessing, MemoryDocumentTimes, MemoryReading } from './CompanionMemoryReading';
import { CompanionMemoryProcessingPanel, CompanionMemoryProcessingSummary } from './CompanionMemoryProcessingPanel';
import { memoryDocumentTitle, memoryFilterDate } from './companion-memory-presentation';
import { Icon } from '../Icons';
import { companionTimestamp } from '../../shared/companion-time';
import './companion-memory-library.css';

const categoryLabels: Record<CompanionMemoryDocument['category'], string> = { diary: '日记', material: '学习资料', self: '自我认识', world: '世界经历', timeline: '时间线', profile: '伙伴档案', other: '文本' };
const syncLabels: Record<CompanionMemoryDocument['syncState'], string> = { indexed: '已收录', pending: '正在收录', conflict: '需要核对', untracked: '等待登记', generated: '自动生成' };
function dateLabel(value: string, time = false) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value.slice(0, 16) : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit', hour12: false } as const : {}) }).format(date); }
function parseTags(value: string) { return [...new Set(value.split(/[,，\n]/u).map(tag => tag.trim().replace(/^#/u, '')).filter(Boolean))]; }
function filename(value: string) { const clean = value.trim(); return /\.(?:md|txt)$/iu.test(clean) ? clean : clean + '.md'; }
function readingContent(value: CompanionMemoryDocumentRead) {
  const heading = /^#{1,6}\s+([^\r\n]+)\r?\n+/u.exec(value.content);
  const remainder = heading ? value.content.slice(heading[0].length) : '';
  return heading?.[1]?.trim() === value.document.title && remainder.trim() ? remainder : value.content;
}
function directoryOf(value: string) { return value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : ''; }
function folderLabel(value: string) { return value === '资料' ? '学习资料' : value.split('/').at(-1) || '全部文档'; }
const directoryOrder = ['日记', '资料', '自我认识', '世界经历', '时间线'];
function excerpt(item: CompanionMemoryDocument) {
  if (item.kind === 'profile') return '稳定人格与伙伴设定，日记不会自动改写人格。';
  const raw = item.excerpt ?? '';
  if (!/^#{1,6}\s+/u.test(raw)) return raw;
  const plain = raw.replace(/^#{1,6}\s+/u, '');
  return plain.startsWith(item.title) ? plain.slice(item.title.length).trimStart() : plain;
}
export type CompanionMemoryDocumentDraft = { path: string; content: string; tags: string; diaryName: string; original?: CompanionMemoryDocumentRead; sourceMessageId?: string };
type Editor = CompanionMemoryDocumentDraft;
type Operation = { kind: 'move' | 'mkdir'; value: string } | { kind: 'delete' };
function MemoryLibraryFolders({ folders, selected, onSelect }: { folders: CompanionMemoryDocumentsPage['folders']; selected: string; onSelect(path: string): void }) {
  const host = useRef<HTMLElement>(null), [viewport, setViewport] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const node = host.current; if (!node) return;
    const measure = () => setViewport(current => ({ ...current, height: node.clientHeight || 600 }));
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(node); void Promise.resolve().then(measure); return () => observer?.disconnect();
  }, []);
  const rows = useMemo(() => [{ path: '', name: '全部文档', count: -1 }, ...folders], [folders]), size = 39;
  const start = Math.max(0, Math.floor(viewport.top / size) - 5), end = Math.min(rows.length, start + Math.ceil(viewport.height / size) + 10);
  return <nav className="memory-library-folders" aria-label="记忆文档目录" ref={host} onScroll={event => { const top = event.currentTarget.scrollTop; setViewport(current => ({ ...current, top })); }}><div style={{ height: rows.length * size, position: 'relative' }}><div style={{ position: 'absolute', top: start * size, left: 0, right: 0 }}>{rows.slice(start, end).map(folder => <button key={folder.path} aria-current={selected === folder.path ? 'page' : undefined} onClick={() => onSelect(folder.path)} style={{ paddingLeft: 14 + Math.min(Math.max(0, folder.path.split('/').length - 1), 5) * 12 }}><Icon name={!folder.path ? 'layers' : folder.path === '时间线' ? 'clock' : folder.path === '自我认识' ? 'heart' : folder.path === '世界经历' ? 'globe' : 'folder'} /><span>{folderLabel(folder.path)}</span>{folder.count >= 0 && <small>{folder.count}</small>}</button>)}</div></div></nav>;
}

export function CompanionMemoryLibraryWorkspace({ companions, companionId, api, request, draft, onDraftConsumed, onOwnerChange, onLocateSource, authorName, onClose, requestError, onDismissError, initialEditor, onEditorChange, onLearningSources, onMemoryTrace, onMemoryProbe, active = true, processingRequest, onProcessingRequestConsumed, noteRequest, onNoteRequestConsumed }: {
  companions: Companion[]; companionId: string; api?: WorldlineBoxCompanionsApi;
  request: (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>;
  draft?: CompanionMemoryDraft; onDraftConsumed(): void; onOwnerChange(id: string): void;
  onLocateSource(message: CompanionMessage): void; authorName(id: string): string; onClose(): void;
  requestError?: string; onDismissError(): void; onLearningSources?(): void; onMemoryTrace?(): void; onMemoryProbe?(query?: string): void;
  initialEditor?: CompanionMemoryDocumentDraft; onEditorChange?(owner: string, editor?: CompanionMemoryDocumentDraft): void;
  active?: boolean; processingRequest?: number; onProcessingRequestConsumed?(): void;
  noteRequest?: { noteId: string; nonce: number }; onNoteRequestConsumed?(): void;
}) {
  const owner = companions.find(item => item.id === companionId);
  const [page, setPage] = useState<CompanionMemoryDocumentsPage>();
  const [directory, setDirectory] = useState(''), [query, setQuery] = useState(''), [tag, setTag] = useState('');
  const [sort, setSort] = useState<'updated_desc' | 'created_desc' | 'created_asc'>('updated_desc');
  const [filters, setFilters] = useState(false), [dateField, setDateField] = useState<'createdAt' | 'updatedAt'>('updatedAt');
  const [fromDate, setFromDate] = useState(''), [toDate, setToDate] = useState('');
  const [showProcessing, setShowProcessing] = useState(false);
  useEffect(() => {
    if (processingRequest === undefined) return;
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) { setShowProcessing(true); onProcessingRequestConsumed?.(); } });
    return () => { cancelled = true; };
  }, [processingRequest, onProcessingRequestConsumed]);
  const [cursor, setCursor] = useState<string>(), [previousCursors, setPreviousCursors] = useState<Array<string | undefined>>([]);
  const [selectedPath, setSelectedPath] = useState<string>(), [read, setRead] = useState<CompanionMemoryDocumentRead>();
  const [editor, setEditor] = useState<Editor | undefined>(initialEditor), [preview, setPreview] = useState(false), [inspector, setInspector] = useState(false);
  const [operation, setOperation] = useState<Operation>(), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [reading, setReading] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [mobile, setMobile] = useState<'list' | 'document' | 'folders'>(initialEditor ? 'document' : 'list');
  const [pendingNavigation, setPendingNavigation] = useState<{ proceed(): void }>();
  const [processing, setProcessing] = useState<CompanionsResponse['memoryStatus']>();
  const [policies, setPolicies] = useState<NonNullable<CompanionsResponse['memoryPolicies']>>([]);
  const [libraryName, setLibraryName] = useState(''), [maintenance, setMaintenance] = useState(false);
  const alive = useRef(true), listEpoch = useRef(0), readEpoch = useRef(0), textarea = useRef<HTMLTextAreaElement>(null), fileScroll = useRef<HTMLDivElement>(null), paperScroll = useRef<HTMLDivElement>(null);
  const firstList = useRef(true);
  const pendingList = useRef<{ key: string; epoch: number; promise: Promise<CompanionMemoryDocumentsPage | undefined> } | undefined>(undefined);
  const locatedNoteRequest = useRef<string | undefined>(undefined);
  const dirty = !!editor && (!editor.original || editor.content !== editor.original.content || editor.tags !== editor.original.document.tags.join('，') || editor.diaryName !== (editor.original.memory?.diaryName ?? ''));

  const call = useCallback(async (command: CompanionMemoryDocumentCommand, reportError = true): Promise<CompanionWorkspaceResponse | undefined> => {
    if (!api?.workspace) { setError('记忆文档接口暂不可用，请重新打开伙伴页面。'); return; }
    try { const result = await api.workspace(command); if (!result.ok && reportError && alive.current) setError(result.error || '文档操作未完成。'); return result; }
    catch (cause) { const error = cause instanceof Error ? cause.message : '文档操作未完成，请重试。'; if (reportError && alive.current) setError(error); return { ok: false, error }; }
  }, [api]);
  const load = useCallback((pageCursor: string | undefined = cursor, preserveSelection = false): Promise<CompanionMemoryDocumentsPage | undefined> => {
    if (parseTags(tag).length > 20) { setError('一次最多按20个标签筛选。'); setLoading(false); return Promise.resolve(undefined); }
    if (fromDate && toDate && fromDate > toDate) { setError('开始日期不能晚于结束日期。'); setLoading(false); return Promise.resolve(undefined); }
    const command: CompanionMemoryDocumentCommand = { type: 'memory.documents.list', companionId, directory, limit: 64, ...(sort !== 'updated_desc' ? { sort } : {}),
      ...(fromDate || toDate ? { dateField, ...(fromDate ? { from: memoryFilterDate(fromDate, false) } : {}), ...(toDate ? { to: memoryFilterDate(toDate, true) } : {}) } : {}),
      ...(query.trim() ? { query: query.trim(), mode: 'keyword' } : {}), ...(parseTags(tag).length ? { tags: parseTags(tag) } : {}), ...(pageCursor ? { cursor: pageCursor } : {}) };
    const key = JSON.stringify(command);
    // Frequent life/memory notifications must not start another identical read
    // and invalidate its still-pending result on every refresh tick.
    if (pendingList.current?.key === key && pendingList.current.epoch === listEpoch.current) return pendingList.current.promise;
    const epoch = ++listEpoch.current; setLoading(true);
    const promise = (async () => {
      const result = await call(command, false);
      if (!alive.current || epoch !== listEpoch.current) return;
      setLoading(false);
      if (result?.documents) {
        setPage({ ...result.documents, items: result.documents.items.slice(0, 64) });
        setSelectedPath(current => current && (preserveSelection || result.documents!.items.some(item => item.path === current)) ? current : result.documents!.items.find(item => item.category === 'diary')?.path ?? result.documents!.items.find(item => item.kind === 'note')?.path ?? result.documents!.items[0]?.path);
        return result.documents;
      } else { setPage(undefined); setError(result?.error || '文档列表暂时无法读取。'); }
    })();
    pendingList.current = { key, epoch, promise };
    void promise.finally(() => { if (pendingList.current?.promise === promise) pendingList.current = undefined; });
    return promise;
  }, [call, companionId, directory, cursor, query, tag, sort, dateField, fromDate, toDate]);
  const readDocument = useCallback(async (path: string, sourceCursor?: number) => {
    const epoch = ++readEpoch.current; setReading(true);
    const result = await call({ type: 'memory.documents.read', companionId, path, sourceLimit: 30, ...(sourceCursor === undefined ? {} : { sourceCursor }) }, false);
    if (!alive.current || epoch !== readEpoch.current) return;
    setReading(false);
    if (result?.document) setRead(current => sourceCursor === undefined ? result.document : { ...result.document!, sources: [...new Map([...(current?.sources ?? []), ...result.document!.sources].map(source => [source.id, source])).values()] });
    else { setRead(undefined); setError(result?.error || '文档暂时无法读取。'); }
  }, [call, companionId]);
  const status = useCallback(async () => {
    const [result, rules] = await Promise.all([request({ type: 'memory.status', companionId }), request({ type: 'memory.policy.list', companionId })]);
    if (alive.current) { setProcessing(result?.memoryStatus); setPolicies(rules?.memoryPolicies ?? []); }
  }, [request, companionId]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onEditorChange?.(companionId, editor); }, [companionId, editor, onEditorChange]);
  useEffect(() => { if (!active) return; const timer = setTimeout(() => { if (alive.current) { firstList.current = false; void load(); } }, firstList.current ? 0 : 240); return () => clearTimeout(timer); }, [load, active]);
  useEffect(() => { if (fileScroll.current) fileScroll.current.scrollTop = 0; }, [cursor, query, tag, directory, sort, dateField, fromDate, toDate]);
  useEffect(() => { if (paperScroll.current) paperScroll.current.scrollTop = 0; }, [selectedPath]);
  useEffect(() => {
    if (!active || page?.index?.state !== 'building' || editor) return;
    const timer = setInterval(() => {
      setPreviousCursors(current => current.length ? [] : current);
      if (cursor) setCursor(undefined); else void load(undefined, true);
    }, 1000);
    return () => clearInterval(timer);
  }, [page?.index?.state, editor, cursor, load, active]);
  useEffect(() => { if (!active) return; void Promise.resolve().then(() => { if (!alive.current) return; if (selectedPath) void readDocument(selectedPath); else setRead(undefined); }); }, [selectedPath, readDocument, active]);
  useEffect(() => { if (!active) return; void status(); void api?.workspace?.({ type: 'status' }).then(result => { if (alive.current) setLibraryName(result.selected?.displayName ?? ''); }).catch(() => undefined); }, [api, status, active]);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api?.onChanged(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const selectedEpoch = readEpoch.current;
        void status();
        void load(cursor, true).then(next => {
          if (!next || !alive.current || readEpoch.current !== selectedEpoch || !selectedPath || editor) return;
          const entry = next.items.find(item => item.path === selectedPath), previous = read?.document;
          if (!entry || !previous || entry.revision !== previous.revision || entry.syncState !== previous.syncState || entry.updatedAt !== previous.updatedAt || entry.sourceCount !== previous.sourceCount) void readDocument(selectedPath);
        });
      }, 350);
    });
    return () => { clearTimeout(timer); unsubscribe?.(); };
  }, [api, load, status, selectedPath, editor, readDocument, cursor, read, active]);
  useEffect(() => {
    if (!active || !processing || !(processing.pending || processing.running || processing.pendingIndex)) return;
    const timer = setInterval(() => { void status(); }, 3000); return () => clearInterval(timer);
  }, [processing, status, active]);
  useEffect(() => {
    const state = read?.tagStatus?.note?.state, path = read?.document.path;
    if (!active || !path || !state || !['pending', 'running', 'waiting_model'].includes(state) || editor) return;
    const timer = setInterval(() => { const epoch = readEpoch.current; void call({ type: 'memory.documents.tags.status', companionId, path }, false).then(result => { if (alive.current && epoch === readEpoch.current && result?.document) setRead(current => current?.document.path === path ? result.document : current); }); }, 5000);
    return () => clearInterval(timer);
  }, [read?.tagStatus?.note?.state, read?.document.path, editor, call, companionId, active]);
  useEffect(() => {
    if (!draft) return;
    void Promise.resolve().then(() => { setEditor({ path: '日记/聊天摘记.md', content: draft.content, tags: '', diaryName: '日记', sourceMessageId: draft.sourceMessageId }); setMobile('document'); onDraftConsumed(); });
  }, [draft, onDraftConsumed]);

  const navigate = useCallback((proceed: () => void) => { if (dirty) setPendingNavigation({ proceed }); else proceed(); }, [dirty]);
  useEffect(() => {
    if (!active || !noteRequest) return;
    const key = `${companionId}:${noteRequest.noteId}:${noteRequest.nonce}`;
    if (locatedNoteRequest.current === key) return;
    locatedNoteRequest.current = key;
    void Promise.resolve().then(() => {
      if (!alive.current || locatedNoteRequest.current !== key) return;
      navigate(() => { void (async () => {
        const epoch = ++readEpoch.current; setReading(true); setError(''); setShowProcessing(false);
        const result = await call({ type: 'memory.documents.locate', companionId, noteId: noteRequest.noteId }, false);
        if (!alive.current || epoch !== readEpoch.current || locatedNoteRequest.current !== key) return;
        setReading(false);
        if (!result?.document || result.document.document.noteId !== noteRequest.noteId) { setError(result?.error || '没有找到这条记忆的当前文档，可能已撤回、移动或发生变化。'); return; }
        ++listEpoch.current; setEditor(undefined); setOperation(undefined); setSelectedPath(result.document.document.path); setRead(result.document); setMobile('document'); setInspector(false); setShowProcessing(false);
      })(); });
      onNoteRequestConsumed?.();
    });
  }, [active, noteRequest, companionId, call, navigate, onNoteRequestConsumed]);
  function resetSearch() { ++listEpoch.current; setCursor(undefined); setPreviousCursors([]); setError(''); }
  function selectFolder(path: string) { navigate(() => { resetSearch(); setDirectory(path); setQuery(''); setTag(''); setEditor(undefined); setOperation(undefined); setMobile('list'); }); }
  function selectDocument(item: CompanionMemoryDocument) { navigate(() => { ++readEpoch.current; if (selectedPath === item.path) void readDocument(item.path); setEditor(undefined); setOperation(undefined); setSelectedPath(item.path); if (read?.document.path !== item.path) setRead(undefined); setMobile('document'); setInspector(false); setError(''); }); }
  function create(copy = false) {
    navigate(() => {
      const target = copy ? '资料' : directory || '日记';
      setEditor({ path: target + '/' + (copy && read ? read.document.title + '-副本.md' : '未命名文档.md'), content: copy ? read?.content ?? '' : '', tags: copy ? read?.document.tags.join('，') ?? '' : '', diaryName: target.split('/')[0]! });
      setPreview(false); setMobile('document'); setOperation(undefined); setNotice(''); setError('');
    });
  }
  function edit() { if (read && !read.document.readOnly) { setEditor({ path: read.document.path, content: read.content, tags: read.document.tags.join('，'), diaryName: read.memory?.diaryName ?? '', original: read }); setPreview(false); setMobile('document'); setError(''); } }
  function cancelEditing() { navigate(() => { setEditor(undefined); setRead(undefined); setError(''); if (selectedPath) void readDocument(selectedPath); }); }
  async function save() {
    if (!editor?.content.trim() || busy) return; if (editor.content.length > 65536) { setError('正文最多65,536字符，请拆分为多篇文档后保存。'); return; }
    const tags = parseTags(editor.tags);
    if (tags.length > 50 || tags.some(value => value.length > 100)) { setError('最多添加50个标签，每个标签不超过100字。'); return; }
    const tagsChanged = !!editor.original && JSON.stringify(tags) !== JSON.stringify(editor.original.document.tags);
    setBusy(true); setError(''); setNotice('');
    const path = editor.original ? editor.path : editor.path.split('/').slice(0, -1).concat(filename(editor.path.split('/').at(-1) || '')).join('/');
    const result = await call(editor.original ? { type: 'memory.documents.save', companionId, path, expectedRevision: editor.original.document.revision, content: editor.content, ...(tagsChanged ? { tags, autoTags: false } : {}), ...(editor.diaryName.trim() ? { diaryName: editor.diaryName.trim() } : {}) } : { type: 'memory.documents.create', companionId, path, content: editor.content, tags, ...(editor.sourceMessageId ? { sourceMessageId: editor.sourceMessageId } : {}), ...(editor.diaryName.trim() ? { diaryName: editor.diaryName.trim() } : {}) });
    if (!alive.current) return; setBusy(false);
    if (!result?.ok || !result.document) return;
    setEditor(undefined); setRead(result.document); setSelectedPath(result.document.document.path); setNotice('文档已保存，记忆收录会继续在后台完成。');
    await load(); await status();
  }
  async function runOperation() {
    if (!operation || busy) return;
    setBusy(true); setError(''); setNotice('');
    const result = operation.kind === 'mkdir' ? await call({ type: 'memory.documents.mkdir', companionId, path: operation.value.trim() }) : !read ? undefined : operation.kind === 'move' ? await call({ type: 'memory.documents.move', companionId, path: read.document.path, targetPath: operation.value.trim(), expectedRevision: read.document.revision }) : await call({ type: 'memory.documents.delete', companionId, path: read.document.path, expectedRevision: read.document.revision });
    if (!alive.current) return; setBusy(false);
    if (!result?.ok) return;
    setOperation(undefined);
    if (result.document) { setRead(result.document); setSelectedPath(result.document.document.path); }
    if (result.deletedPath) { setRead(undefined); setSelectedPath(undefined); setMobile('list'); }
    setNotice(result.deletedPath ? '文档已删除，其记忆与旧来源已退出召回。' : result.createdDirectory ? '文件夹已创建。' : '文件已移动，记忆标识与来源保留。');
    await load(); await status();
  }
  async function maintain(type: 'memory.index.rebuild' | 'memory.jobs.retry' | 'memory.policy.release', id?: string) {
    setBusy(true); setError('');
    try { const result = await request(type === 'memory.policy.release' ? { type, companionId, id: id! } : { type, companionId }); if (!result?.ok) setError(result?.error || '操作未完成，请重试。'); else { setNotice(type === 'memory.policy.release' ? '今后的记录规则已更新，旧的已遗忘来源仍被排除。' : '已开始后台处理。'); await status(); await load(); } }
    catch { setError('操作未完成，请重试。'); } finally { if (alive.current) setBusy(false); }
  }
  async function tagAction(action: 'retry' | 'cancel') {
    if (!read || busy) return;
    setBusy(true); setError('');
    const result = await call({ type: action === 'retry' ? 'memory.documents.tags.retry' : 'memory.documents.tags.cancel', companionId, path: read.document.path, expectedRevision: read.document.revision });
    if (!alive.current) return; setBusy(false);
    if (result?.document) { setRead(result.document); setNotice(action === 'retry' ? '已重新安排标签整理，正文保持已保存状态。' : '已取消自动标签，正文与已有标签保留。'); }
  }
  function insert(before: string, after = '') {
    if (!editor || !textarea.current) return;
    const start = textarea.current.selectionStart, end = textarea.current.selectionEnd;
    setEditor({ ...editor, content: editor.content.slice(0, start) + before + editor.content.slice(start, end) + after + editor.content.slice(end) });
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(start + before.length, end + before.length); });
  }

  const items = page?.items ?? [];
  const visible = items;
  const tags = useMemo(() => [...new Set((page?.items ?? []).flatMap(item => item.tags))].sort().slice(0, 12), [page?.items]);
  const current = editor?.original?.document ?? read?.document;
  const docKey = current?.noteId ?? current?.path;
  const folders = useMemo(() => [...page?.folders ?? []].sort((a, b) => {
    const rank = (value: string) => { const index = directoryOrder.indexOf(value.split('/')[0]!); return index < 0 ? directoryOrder.length : index; };
    return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path);
  }), [page?.folders]);
  const working = !!processing && !!(processing.pending || processing.running || processing.pendingIndex);
  const tagState = read?.tagStatus?.note?.state;
  const tagMessage = tagState === 'waiting_model' ? '正文已保存，等待全局聊天模型生成标签。' : tagState === 'pending' ? '正文已保存，标签等待自动整理。' : tagState === 'running' ? '正在自动整理标签…' : tagState === 'failed' ? '自动标签未完成，正文已保存。' : tagState === 'stale' ? '标签任务对应旧修订，请重新整理。' : tagState === 'cancelled' ? '已取消自动标签。' : '';
  return <section className={'companion-memory-library' + ' is-' + mobile} aria-label="伙伴记忆库" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && editor) { event.preventDefault(); void save(); }
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); if (pendingNavigation) setPendingNavigation(undefined); else if (operation) setOperation(undefined); else if (maintenance) setMaintenance(false); else navigate(onClose); }
  }}>
    <header className="memory-library-header"><div className="memory-library-brand"><button className="memory-library-icon memory-library-mobile-folders" aria-label="浏览日记本目录" onClick={() => navigate(() => { setEditor(undefined); setMobile('folders'); })}><Icon name="panel-left" /></button><span className="memory-library-mark"><Icon name="file-text" /></span><div><h2>伙伴记忆库</h2><p>{libraryName || '共同的资产库'}<span> / </span>{owner?.name}</p></div></div><div className="memory-library-header-actions">{onLearningSources && <button className="memory-library-quiet" onClick={() => navigate(onLearningSources)}><Icon name="sparkles" />学习与成长</button>}<button className="memory-library-icon" aria-label="关闭共同记忆管理" data-dialog-initial-focus="true" title="返回伙伴" onClick={() => navigate(onClose)}><Icon name="close" /></button></div></header>
    <div className="memory-library-body">
      <aside className="memory-library-sidebar" aria-label="伙伴与日记本"><label className="memory-library-owner"><Avatar companion={owner} showPresence={false} /><span><small>正在管理</small><select aria-label="记忆所属伙伴" value={companionId} onChange={event => { const id = event.target.value; onOwnerChange(id); }}>{companions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></span></label><div className="memory-library-sidebar-heading"><span>日记本</span><button className="memory-library-icon" aria-label="新建记忆文件夹" title="新建文件夹" onClick={() => navigate(() => { setOperation({ kind: 'mkdir', value: directory ? directory + '/新文件夹' : '新文件夹' }); setMobile('document'); })}><Icon name="plus" /></button></div>
        <MemoryLibraryFolders folders={folders} selected={directory} onSelect={selectFolder} />
        <div className="memory-library-sidebar-footer"><span><i className={processing?.failed ? 'has-error' : working ? 'is-working' : ''} />{processing?.failed ? '有收录需要处理' : working ? '记忆正在更新' : '持续生活，持续记录'}</span>{active && <CompanionMemoryProcessingSummary companionId={companionId} companionName={owner?.name} api={api} request={request} onOpen={() => navigate(() => setShowProcessing(true))} />}{onMemoryProbe && <button className="memory-library-quiet" onClick={() => navigate(onMemoryProbe)}><Icon name="search" />回忆</button>}{onMemoryTrace && <button className="memory-library-quiet" onClick={() => navigate(onMemoryTrace)}><Icon name="layers" />成长足迹</button>}<button className="memory-library-quiet" onClick={() => { setMaintenance(value => !value); setMobile('document'); }}><Icon name="sliders" />收录与记录规则</button></div>
      </aside>
      <section className="memory-library-files" aria-label="记忆文件列表"><header><div><h3>{folderLabel(directory)}</h3><span>{page?.index?.state === 'building' ? '已找到 ' : ''}{page?.total ?? items.length}{page?.total === undefined && page?.hasMore ? '+' : ''} 篇</span></div><button className="memory-library-icon" aria-label="新建记忆文档" title="新建文档" onClick={() => create()}><Icon name="plus" /></button></header><label className="memory-library-search"><Icon name="search" /><input type="search" aria-label="搜索全部记忆文档" maxLength={1000} placeholder="搜索全文、标题或文件名" value={query} onChange={event => { resetSearch(); setQuery(event.target.value); }} /></label><div className="memory-library-search-options">
          <select aria-label="记忆文档搜索方式" value="keyword" onChange={event => { if (event.target.value === 'recall' && onMemoryProbe) navigate(() => onMemoryProbe(query)); }}><option value="keyword">文档全文</option>{onMemoryProbe && <option value="recall">伙伴回忆</option>}</select>
          <select aria-label="记忆文档排序" value={sort} onChange={event => { resetSearch(); setSort(event.target.value as typeof sort); }}><option value="updated_desc">最近修改</option><option value="created_desc">最近创建</option><option value="created_asc">最早创建</option></select>
          <button className={'memory-library-filter-toggle' + (filters || tag || fromDate || toDate ? ' is-active' : '')} aria-label="高级筛选记忆文档" aria-expanded={filters} onClick={() => setFilters(value => !value)}><Icon name="sliders" /></button>
        </div>
        {onMemoryProbe && <button className="memory-library-vcp-entry" type="button" onClick={() => navigate(() => onMemoryProbe(query))}><Icon name="sparkles" size={13} />用 VCP 回忆<Icon name="chevron-right" size={12} /></button>}
        <div className="memory-library-advanced-filters" hidden={!filters}>
          <label>标签<input aria-label="按标签筛选记忆文档" placeholder="多个标签用逗号分隔" value={tag} onChange={event => { resetSearch(); setTag(event.target.value); }} /></label>
          <label>时间范围<select aria-label="记忆筛选时间类型" value={dateField} onChange={event => { resetSearch(); setDateField(event.target.value as typeof dateField); }}><option value="updatedAt">修改时间</option><option value="createdAt">创建时间</option></select></label>
          <div className="memory-library-date-range"><label>从<input type="date" aria-label="记忆开始日期" value={fromDate} onChange={event => { resetSearch(); setFromDate(event.target.value); }} /></label><label>至<input type="date" aria-label="记忆结束日期" value={toDate} onChange={event => { resetSearch(); setToDate(event.target.value); }} /></label></div>
          <button className="memory-library-quiet" onClick={() => { resetSearch(); setTag(''); setFromDate(''); setToDate(''); }}>清除筛选</button>
        </div>{page?.index && page.index.state !== 'ready' && <p className="memory-library-catalog-status" role={page.index.state === 'error' ? 'alert' : 'status'}>{page.index.state === 'building' ? `后台建立目录索引 · 已扫描${page.index.indexed}篇，结果暂未完整` : page.index.error || '目录索引尚不可用，请稍后重试。'}</p>}{!!tags.length && <div className="memory-library-tag-filter" aria-label="文档标签筛选"><button aria-pressed={!tag} onClick={() => { resetSearch(); setTag(''); }}>全部</button>{tags.map(value => <button key={value} aria-pressed={parseTags(tag).includes(value)} onClick={() => { resetSearch(); setTag(current => parseTags(current).includes(value) ? parseTags(current).filter(item => item !== value).join('，') : [...parseTags(current), value].join('，')); }}>#{value}</button>)}</div>}
        <div className="memory-library-file-scroll" ref={fileScroll}>{loading && !items.length && <p className="memory-library-helper" role="status">正在打开日记本…</p>}{!loading && !visible.length && <div className="memory-library-empty-list"><Icon name="file-text" /><h4>{query || tag ? '没有匹配的文档' : '这一页，等着新的故事'}</h4><p>{query || tag ? '试试其他关键词、标签，或切换到语义搜索。' : '日常经历会慢慢留下，也可以放入自己的文字和资料。'}</p><button className="memory-library-quiet" onClick={() => create()}>新建第一篇文档<Icon name="plus" /></button></div>}{visible.map(item => <button className={'memory-library-file' + (selectedPath === item.path && !editor ? ' is-selected' : '')} key={item.path} data-memory-document={item.path} aria-label={item.noteId ? '阅读记忆 ' + item.noteId : '阅读文档 ' + item.path} aria-pressed={selectedPath === item.path && !editor} onClick={() => selectDocument(item)}><span className="memory-library-file-top"><span>{categoryLabels[item.category]}</span><time title={'修改：' + companionTimestamp(item.updatedAt) + (item.createdAt ? '\n创建：' + companionTimestamp(item.createdAt) : '')} dateTime={sort === 'updated_desc' ? item.updatedAt : item.createdAt ?? item.updatedAt}>{dateLabel(sort === 'updated_desc' ? item.updatedAt : item.createdAt ?? item.updatedAt, true)}</time></span><strong title={item.title}>{memoryDocumentTitle(item)}</strong>{item.excerpt && <p>{excerpt(item)}</p>}<span className="memory-library-file-meta"><span>{item.tags.slice(0, 2).map(value => '#' + value).join(' · ') || (item.kind === 'timeline' ? '月度整理' : item.captureMethod === 'automatic' ? '自主记录' : item.kind === 'profile' ? '稳定人格' : '文本资料')}</span><span className="memory-library-file-state" data-state={item.syncState}>{item.syncState === 'indexed' ? '已收录' : item.syncState === 'generated' ? '只读' : item.syncState === 'conflict' ? '需核对' : '待处理'}</span></span></button>)}</div>
        {(page?.hasMore || previousCursors.length > 0) && <div className="memory-library-pagination"><button className="memory-library-icon" aria-label="上一页文档" disabled={loading || page?.index?.state === 'building' || !previousCursors.length} onClick={() => { setCursor(previousCursors.at(-1)); setPreviousCursors(current => current.slice(0, -1)); }}><Icon name="chevron-left" /></button><span>第 {previousCursors.length + 1} 页 · 每页最多64篇</span><button className="memory-library-icon" aria-label="下一页文档" disabled={loading || page?.index?.state === 'building' || !page?.hasMore || !page.nextCursor} onClick={() => { setPreviousCursors(current => [...current, cursor]); setCursor(page?.nextCursor); }}><Icon name="chevron-right" /></button></div>}
        <footer><Icon name="shield" /><span>管理此伙伴的完整文本空间</span><button className="memory-library-icon" aria-label="刷新记忆文件列表" disabled={loading} onClick={() => void load()}><Icon name="refresh" /></button></footer>
      </section>
      <main className="memory-library-document" aria-label="记忆文档工作区"><div className="memory-library-document-toolbar"><button className="memory-library-quiet memory-library-back" onClick={() => navigate(() => { setEditor(undefined); setMobile('list'); })}><Icon name="chevron-left" />返回文档</button><span className="memory-library-breadcrumb" title={editor?.path ?? read?.document.path}><span className="memory-library-breadcrumb-owner">{owner?.name}</span><Icon name="chevron-right" /><span className="memory-library-breadcrumb-title">{editor?.path ?? (read ? memoryDocumentTitle(read.document) : folderLabel(directory))}</span></span><div>{editor ? <><button className="memory-library-quiet" disabled={busy} onClick={cancelEditing}>取消编辑</button><button className="memory-library-primary" disabled={busy || !editor.content.trim() || editor.content.length > 65536} onClick={() => void save()}><Icon name="check" />{busy ? '正在保存…' : editor.original ? '保存修正' : '保存文档'}</button></> : read ? <>{read.document.readOnly ? <button className="memory-library-quiet" onClick={() => create(true)}><Icon name="copy" />另存为资料</button> : <button className="memory-library-quiet" aria-label={'编辑记忆 ' + docKey} onClick={edit}><Icon name="edit" />编辑文档</button>}<button className={'memory-library-icon' + (inspector ? ' is-active' : '')} aria-label={'查看记忆来源 ' + docKey} aria-expanded={inspector} title="来源与文档信息" onClick={() => setInspector(value => !value)}><Icon name="panel-right" /></button></> : <button className="memory-library-quiet" onClick={() => create()}><Icon name="plus" />新建文档</button>}</div></div>
        {(error || requestError) && <div className="memory-library-alert" role="alert"><span>{error || requestError}</span><button className="memory-library-quiet" onClick={() => { setError(''); onDismissError(); }}>关闭提示</button></div>}{notice && <p className="memory-library-notice" role="status"><Icon name="check" />{notice}</p>}
        {pendingNavigation && <div className="memory-library-confirm" role="alertdialog" aria-label="保留未保存的修改"><strong>这篇文档还有未保存的修改</strong><p>可以继续编辑，或放弃这次修改后离开。</p><div><button className="memory-library-quiet" onClick={() => setPendingNavigation(undefined)}>继续编辑</button><button className="memory-library-danger" onClick={() => { const next = pendingNavigation; setPendingNavigation(undefined); next.proceed(); }}>放弃修改并离开</button></div></div>}
        {operation && <form className="memory-library-operation" onSubmit={event => { event.preventDefault(); void runOperation(); }}><strong>{operation.kind === 'delete' ? '删除并遗忘这篇文档' : operation.kind === 'mkdir' ? '新建日记本文件夹' : '重命名或移动文档'}</strong>{operation.kind === 'delete' ? <p>这篇文档及其旧来源的衍生记忆将退出召回，原始聊天仍保留。此操作不会删除其他日记。</p> : <label>{operation.kind === 'mkdir' ? '文件夹路径' : '目标文件路径'}<input aria-label={operation.kind === 'mkdir' ? '记忆文件夹路径' : '文档目标路径'} value={operation.value} maxLength={1024} required onChange={event => setOperation({ ...operation, value: event.target.value })} /><small>相对于当前伙伴的记忆目录，例如：资料/阅读/读书摘记.md</small></label>}<div><button type="button" className="memory-library-quiet" disabled={busy} onClick={() => setOperation(undefined)}>取消操作</button><button type="submit" className={operation.kind === 'delete' ? 'memory-library-danger' : 'memory-library-primary'} disabled={busy}>{busy ? '正在处理…' : operation.kind === 'delete' ? '确认遗忘' : '确认保存'}</button></div></form>}
        {maintenance ? <section className="memory-library-maintenance"><header><div><span>记忆维护</span><h3>让记录保持清楚</h3></div><button className="memory-library-icon" aria-label="关闭记忆维护" onClick={() => setMaintenance(false)}><Icon name="close" /></button></header><p>这里的设置影响今后的收录，不会恢复已经遗忘的来源。</p><dl><div><dt>等待处理 / 进行中</dt><dd>{processing?.pending ?? '—'} / {processing?.running ?? '—'}</dd></div><div><dt>等待索引 / 可供回忆</dt><dd>{processing?.pendingIndex ?? '—'} / {processing?.indexed ?? '—'}</dd></div><div><dt>需要重试</dt><dd>{processing?.failed ?? '—'}</dd></div></dl>{processing?.lastError && <p role="alert">{processing.lastError}</p>}<div className="memory-library-maintenance-actions">{!!processing?.failed && <button className="memory-library-quiet" disabled={busy} onClick={() => void maintain('memory.jobs.retry')}>重试失败收录</button>}<button className="memory-library-quiet" disabled={busy} onClick={() => void maintain('memory.index.rebuild')}><Icon name="refresh" />重建记忆索引</button></div>{policies.filter(rule => rule.blocked).map(rule => <section className="memory-library-policy" key={rule.id}><h4>{rule.reason === 'persistent-topic' ? '暂停记录：' + rule.tags?.join('、') : '旧版范围限制'}</h4><p>{rule.reason === 'persistent-topic' ? '允许今后记录后，只处理新的输入；旧来源继续排除。' : rule.requestSnippet}</p><button className="memory-library-quiet" disabled={busy} onClick={() => void maintain('memory.policy.release', rule.id)}>{rule.reason === 'persistent-topic' ? '允许今后记录此主题' : '解除旧版范围限制'}</button></section>)}</section> : <div className={'memory-library-paper-layout' + (inspector && read && !editor ? ' has-inspector' : '')}>
          <div className="memory-library-paper-scroll" ref={paperScroll}>{editor ? <article className="memory-library-paper is-editor"><div className="memory-library-eyebrow">{editor.original ? '编辑文档' : '一篇新的记录'}<span>{dirty ? '未保存' : '已保存'}</span></div>{!editor.original ? <label className="memory-library-path-field">文档路径<input aria-label="新文档路径" maxLength={1024} value={editor.path} onChange={event => setEditor({ ...editor, path: event.target.value })} /></label> : <h1>{editor.original.document.title}</h1>}<div className="memory-library-editor-metadata"><label>日记本<input aria-label="文档日记本" list="memory-library-diary-names" maxLength={160} value={editor.diaryName} placeholder="日记本名称" onChange={event => setEditor({ ...editor, diaryName: event.target.value })} /></label><label>标签<input aria-label="文档标签" value={editor.tags} placeholder="用逗号分隔标签" onChange={event => setEditor({ ...editor, tags: event.target.value })} /></label></div>{!editor.original && <p className="memory-library-helper">标签留空时会自动生成；你填写的标签会优先保留。</p>}<datalist id="memory-library-diary-names">{folders.map(folder => <option key={folder.path} value={folder.path} />)}</datalist><div className="memory-library-editor-tools"><div>{([['type', '标题', '# ', ''], ['edit', '加粗', '**', '**'], ['clipboard', '列表', '- ', ''], ['link', '链接', '[', '](https://)']] as const).map(([icon, label, before, after]) => <button type="button" className="memory-library-icon" key={label} aria-label={label} title={label} disabled={preview} onClick={() => insert(before, after)}><Icon name={icon} /></button>)}</div><div role="tablist" aria-label="文档编辑视图"><button role="tab" aria-selected={!preview} onClick={() => setPreview(false)}>Markdown</button><button role="tab" aria-selected={preview} onClick={() => setPreview(true)}>预览</button></div></div>{preview ? <div className="memory-library-markdown"><MessageContent content={editor.content} /></div> : <textarea ref={textarea} aria-label="共同记忆内容" maxLength={65536} spellCheck={false} placeholder="写下完整的经历、学习资料，或此刻的想法。支持 Markdown。" value={editor.content} onChange={event => setEditor({ ...editor, content: event.target.value })} />}<footer className="memory-library-editor-footer"><span>{editor.content.length.toLocaleString()} / 65,536 字符</span><span>Ctrl + S 保存</span></footer>{editor.sourceMessageId && <p className="memory-library-helper">此草稿来自聊天消息，保存时将保留真实来源。</p>}</article> : read ? <article className="memory-library-paper" data-memory-status={read.memory?.status}><div className="memory-library-eyebrow">{categoryLabels[read.document.category]}<span>{read.document.readOnly ? '只读文档' : syncLabels[read.document.syncState]}</span></div><h1 title={read.document.title}>{memoryDocumentTitle(read.document)}</h1><MemoryDocumentTimes read={read} /><div className="memory-library-document-meta">{read.document.version && <span>修订 {read.document.version}</span>}<span>{read.document.captureMethod === 'automatic' ? '伙伴自主记录' : read.document.kind === 'timeline' ? '自动整理的月度记录' : read.document.kind === 'profile' ? '稳定人格档案' : read.document.captureMethod === 'manual' ? '手工记录' : '文本资料'}</span></div><MemoryDocumentProcessing read={read} onOpen={() => setShowProcessing(true)} />{!!read.document.tags.length && <div className="memory-library-document-tags">{read.document.tags.map(value => <button key={value} onClick={() => { resetSearch(); setTag(value); setMobile('list'); }}>#{value}</button>)}</div>}<>{tagMessage && <p className="memory-library-tag-status" role="status"><Icon name={tagState === 'failed' ? 'alert-circle' : 'tag'} />{tagMessage}</p>}</><MemoryReading key={read.document.path + ":" + read.document.contentHash} content={readingContent(read)} onPageChange={() => { if (paperScroll.current) paperScroll.current.scrollTop = 0; }} />{read.document.readOnly && <p className="memory-library-readonly-note"><Icon name="info" />{read.document.kind === 'profile' ? '稳定人格在伙伴资料中管理，日记不会自动改写人格。' : '这份月度记录由已有记忆整理。需要补充时，可以另存为资料。'}</p>}</article> : <div className="memory-library-paper-empty"><Icon name={reading ? 'loader' : 'file-text'} /><h3>{reading ? '正在打开文档…' : '每位伙伴，都有自己的日记本'}</h3><p>选择一篇文字，读读她的经历与想法。<br />日记、学习和对世界的理解，都保存在这里。</p><button className="memory-library-primary" onClick={() => create()}><Icon name="plus" />新建文档</button></div>}</div>
          {inspector && read && !editor && <aside className="memory-library-inspector" aria-label="记忆来源与修订"><header><h3>文档信息</h3><button className="memory-library-icon" aria-label="关闭文档信息" onClick={() => setInspector(false)}><Icon name="close" /></button></header><dl><div><dt>文件</dt><dd>{read.document.name}</dd></div><div><dt>日记本</dt><dd>{read.memory?.diaryName || directoryOf(read.document.path) || '根目录'}</dd></div><div><dt>收录</dt><dd>{syncLabels[read.document.syncState]}</dd></div>{read.document.version && <div><dt>修订</dt><dd>{read.document.version}</dd></div>}<div><dt>创建时间</dt><dd>{read.document.createdAt || read.memory?.createdAt ? companionTimestamp(read.document.createdAt ?? read.memory!.createdAt) : "未记录"}</dd></div><div><dt>修改时间</dt><dd>{companionTimestamp(read.document.updatedAt)}</dd></div></dl>{!read.document.readOnly && <div className="memory-library-file-actions"><button className="memory-library-quiet" onClick={() => setOperation({ kind: 'move', value: read.document.path })}><Icon name="edit" />重命名或移动</button><button className="memory-library-quiet is-danger" aria-label={'删除记忆 ' + docKey} onClick={() => setOperation({ kind: 'delete' })}><Icon name="trash" />删除并遗忘</button></div>}{read.memory && <section className="memory-library-tag-management"><h4>自动标签</h4><p>{tagMessage || (read.document.autoTagsEnabled === false ? '按你手动编辑的标签保存，不自动改写。' : tagState === 'completed' ? '自动整理已完成，手动标签不会被覆盖。' : '正文保存后，可使用全局聊天模型自动整理标签。')}</p>{read.tagStatus?.note?.error && <p>{read.tagStatus.note.error}</p>}<div>{tagState && ['failed', 'cancelled', 'stale'].includes(tagState) && <button className="memory-library-quiet" disabled={busy} onClick={() => void tagAction('retry')}>重试生成标签</button>}{tagState && ['pending', 'running', 'waiting_model'].includes(tagState) && <button className="memory-library-quiet" disabled={busy} onClick={() => void tagAction('cancel')}>取消自动标签</button>}</div></section>}<section className="memory-library-sources"><h4>来源 <span>{read.document.sourceCount ?? read.sources.length}</span></h4>{!read.sources.length && <p className="memory-library-helper">{read.document.readOnly ? '自动文档的来源范围随记忆撤回更新。' : '文本内容由你通过记忆库提供。'}</p>}{read.sources.map(source => { const kind = read.memory?.sources.find(item => item.messageId === source.id)?.sourceType; return <details className="memory-library-source" key={source.id}><summary><span>{kind === 'manual_input' ? '手工日记输入' : kind === 'world_observation' ? '世界观察凭证' : authorName(source.authorId)}</span><Icon name="chevron" /></summary><time>{dateLabel(source.createdAt, true)}</time><p>{source.content}</p>{kind !== 'manual_input' && kind !== 'world_observation' && <button className="memory-library-quiet" aria-label={'定位记忆来源 ' + source.id} onClick={() => navigate(() => onLocateSource(source))}>查看原消息<Icon name="arrow-up-right" /></button>}</details>; })}{read.hasMoreSources && <button className="memory-library-quiet" disabled={reading} onClick={() => void readDocument(read.document.path, read.nextSourceCursor)}>展开更多来源</button>}</section></aside>}
        </div>}
      </main>
    </div>
    {showProcessing && active && <CompanionMemoryProcessingPanel companionId={companionId} companionName={owner?.name} api={api} request={request} onClose={() => setShowProcessing(false)} />}
  </section>;
}
