import { memo, useEffect, useState } from 'react';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionTaskItem } from '../../shared/companion-task-overview';
import type { CompanionTaskDetail, CompanionTaskRecord, CompanionTaskSection } from '../../shared/companion-task-detail';
import { companionTimestamp } from '../../shared/companion-time';
import type { CompanionRequest } from './CompanionDialogs';
import { createCoalescedRefresh } from './coalesced-refresh';
import { Icon } from '../Icons';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CompanionNativeTaskRecords } from './CompanionNativeTaskRecords';

const sections: Record<CompanionTaskSection, string> = { input: '输入', process: '过程', output: '结果' };
const provenance: Record<CompanionTaskRecord['provenance'], string> = { source: '来源内容', host: '实际记录', model_proposal: '模型请求', model_output: '伙伴生成的内容', legacy: '历史记录' };
const phaseNames: Record<string, string> = { queued: '等待处理', pending: '等待处理', running: '正在执行', waiting: '等待条件', context: '准备上下文',
  memory: '被动回忆', thinking: '生成回复', tools: '使用工具', streaming: '正在回复', done: '已完成', completed: '已完成', succeeded: '已完成',
  failed: '本轮未完成', cancelled: '已停止', interrupted: '已中断', stale: '已由新版本替代', observing: '核对触发条件', active: '正在持续进行',
  silent: '本轮未发起行动', expired: '本次时间窗口已结束', offered: '等待受理', accepted: '已受理', waiting_model: '等待模型',
  message: '发送消息', visit: '拜访伙伴', rest: '休息', study: '学习', leisure: '休闲活动', park_walk: '在公园散步' };
const outputStates: Record<string, string> = { draft: '执行草稿', committed: '已确认', abandoned: '已丢弃', failed: '未完成', succeeded: '已完成' };

const TaskRecord = memo(function TaskRecord({ record, task, request }: { record: CompanionTaskRecord; task: CompanionTaskItem; request: CompanionRequest }) {
  const [expanded, setExpanded] = useState(false), [offset, setOffset] = useState(0), [chunk, setChunk] = useState<{ text: string; total: number; more: boolean }>();
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    void request({ type: 'task.content', companionId: task.companionId, kind: task.kind, id: task.id, recordId: record.id, offset, limit: 6000 }).then(response => {
      if (cancelled) return;
      if (!response?.taskContent) { setError(response?.error ?? '内容暂不可读取，请重试。'); setChunk(undefined); }
      else { setError(''); setChunk({ text: response.taskContent.text, total: response.taskContent.totalCharacters, more: response.taskContent.hasMore }); }
    }).catch(() => { if (!cancelled) { setError('内容读取失败，请重试。'); setChunk(undefined); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, offset, record.id, request, task.companionId, task.id, task.kind, record.totalCharacters]);
  const text = expanded ? chunk?.text ?? '' : record.text.slice(0, 600), large = record.totalCharacters > 600;
  return <section className="task-record" data-task-record={record.id}>
    <header><h5>{record.title}</h5><span title={record.provenance === 'model_proposal' ? '模型请求或总结本身不代表工具已成功执行，请结合宿主返回查看。' : undefined}>{record.state && outputStates[record.state] || provenance[record.provenance]}</span>{record.at && <time dateTime={record.at} title={companionTimestamp(record.at)}>{new Date(record.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>}</header>
    <div className="task-record-text" aria-busy={loading}>{loading ? '正在读取这一段…' : error || <Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={value => /^https?:\/\//iu.test(value) ? value : ''} components={{ img: ({ alt }) => <span>{alt || '图片'}</span>, a: ({ children, href }) => <span className="task-record-link" title={href}>{children}</span> }}>{phaseNames[text] || text}</Markdown>}</div>
    {large && <footer><button type="button" aria-expanded={expanded} onClick={() => { setExpanded(value => !value); setOffset(0); setLoading(!expanded); setError(''); }}>{expanded ? '收起' : '展开内容'}<Icon name="chevron" size={12} /></button><small>{record.totalCharacters.toLocaleString()} 字</small>{expanded && chunk && chunk.total > 6000 && <div className="task-record-chunks"><button type="button" disabled={loading || offset === 0} onClick={() => { setLoading(true); setOffset(value => Math.max(0, value - 6000)); }}>上一段</button><span>{Math.floor(offset / 6000) + 1} / {Math.ceil(chunk.total / 6000)}</span><button type="button" disabled={loading || !chunk.more} onClick={() => { setLoading(true); setOffset(value => value + 6000); }}>下一段</button></div>}</footer>}
  </section>;
}, (a, b) => a.request === b.request && a.task.id === b.task.id && a.task.kind === b.task.kind && a.task.companionId === b.task.companionId
  && a.record.id === b.record.id && a.record.text === b.record.text && a.record.totalCharacters === b.record.totalCharacters
  && a.record.title === b.record.title && a.record.at === b.record.at && a.record.provenance === b.record.provenance && a.record.state === b.record.state);

/** Selection, section and content are independent cold reads. Only one bounded
 * section is mounted; late replies cannot replace a newly selected task. */
export function CompanionTaskInspector({ task, request, api, refresh = 0 }: { task: CompanionTaskItem; request: CompanionRequest;
  api?: Pick<WorldlineBoxCompanionsApi, 'onChanged'>; refresh?: number }) {
  const [section, setSection] = useState<CompanionTaskSection>('input'), [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<CompanionTaskDetail>(), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const reads = createCoalescedRefresh(async () => {
      const response = await request({ type: 'task.inspect', companionId: task.companionId, kind: task.kind, id: task.id, section, offset, limit: 12 });
      if (cancelled) return;
      setLoading(false);
      if (!response?.taskDetail) { setError(response?.error ?? '这部分执行记录暂不可读取。'); return; }
      setError(''); setDetail(response.taskDetail);
    }, () => { if (!cancelled) { setLoading(false); setError('执行记录读取失败，请重试。'); } }, 800);
    void reads.trigger();
    const active = !['completed', 'failed', 'cancelled'].includes(task.status);
    const timer = active ? setInterval(() => void reads.trigger(), 1500) : undefined;
    const unsubscribe = api?.onChanged(() => void reads.trigger());
    return () => { cancelled = true; reads.dispose(); if (timer) clearInterval(timer); unsubscribe?.(); };
  }, [task.companionId, task.id, task.kind, task.status, request, api, section, offset, refresh]);
  return <section className="task-inspector" aria-label="任务输入、过程与结果">
    <div className="task-inspector-tabs" role="tablist" aria-label="执行详情">{(Object.keys(sections) as CompanionTaskSection[]).map(key => <button type="button" role="tab" aria-selected={section === key} aria-label={'任务' + sections[key]} key={key} onClick={() => { if (section === key) return; setSection(key); setOffset(0); setLoading(true); setDetail(undefined); setError(''); }}>{sections[key]}{section === key && detail && <small>{detail.total}</small>}</button>)}<span><i />实时同步</span></div>
    {detail && <p className="task-inspector-purpose">{detail.purpose}</p>}
    {error && <p className="task-inspector-empty" role="alert">{error}</p>}
    <div className="task-inspector-records" aria-busy={loading}>
      {detail?.items.map(record => <TaskRecord key={record.id} record={record} task={task} request={request} />)}
      {!detail?.items.length && !error && <p className="task-inspector-empty">{loading ? '正在读取这部分记录…' : detail?.notice ?? '尚无已保存的内容。'}</p>}
      {!!detail?.items.length && detail.notice && <p className="task-inspector-empty">{detail.notice}</p>}
    </div>
    {detail?.nativeRecordId && (section === 'process' || section === 'output') && <CompanionNativeTaskRecords key={detail.nativeRecordId} actionId={task.id} recordId={detail.nativeRecordId} request={request} api={api} active={!['completed', 'failed', 'cancelled'].includes(task.status)} />}
    {detail && detail.total > 12 && <footer className="task-inspector-pagination"><span>第 {offset + 1}–{offset + detail.items.length} 项 · 共 {detail.total} 项</span><button type="button" disabled={loading || offset === 0} onClick={() => { setOffset(value => Math.max(0, value - 12)); setLoading(true); }}>上一页</button><button type="button" disabled={loading || !detail.hasMore} onClick={() => { setOffset(value => value + 12); setLoading(true); }}>下一页</button></footer>}
  </section>;
}
