import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import type { CompanionContextSnapshot } from '../../shared/companion-cognition';
import { companionPurposeLabel } from './companion-purpose-labels';
import { createCoalescedRefresh } from './coalesced-refresh';

const statusLabels: Record<CompanionContextSnapshot['status'], string> = { prepared: '已准备 · 尚无发送凭证', dispatched: '已交给网络层', cancelled_before_send: '发送前取消', response: '已有响应凭证', network_error: '网络失败', unknown: '发送或结果未确认 · 不自动重发', redacted: '来源撤回 · 正文不可用' };
export function ContextSnapshotText({ text }: { text: string }) {
  const [page, setPage] = useState(0), size = 24_000, pages = Math.max(1, Math.ceil(text.length / size)), current = Math.min(page, pages - 1);
  return <div className="cognition-context-text">{pages > 1 && <nav aria-label="长上下文正文分页"><button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>上一部分</button><span>完整正文分 {pages} 部分展示 · 当前 {current + 1}</span><button type="button" disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>下一部分</button></nav>}<pre>{text.slice(current * size, (current + 1) * size) || '本次没有此项内容。'}</pre></div>;
}
type Props = { companionId: string; api?: WorldlineBoxCompanionsApi };
export function CompanionActualContext(props: Props) { return <ActualContextBody key={props.companionId} {...props} />; }
function ActualContextBody({ companionId, api }: Props) {
  const [items, setItems] = useState<NonNullable<CompanionWorkspaceResponse['contextSnapshots']>>([]), [retention, setRetention] = useState<CompanionWorkspaceResponse['contextSnapshotRetention']>();
  const [selected, setSelected] = useState(''), [record, setRecord] = useState<CompanionContextSnapshot>(), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [reading, setReading] = useState(false), [scope, setScope] = useState('all');
  const alive = useRef(false), sequence = useRef(0), reads = useRef(0), selectedId = useRef('');
  const invalidate = useCallback(() => { ++sequence.current; ++reads.current; }, []);
  const open = useCallback(async (id: string, refreshing = false) => {
    const epoch = ++reads.current; selectedId.current = id; setSelected(id); if (!refreshing) setRecord(undefined); setReading(true); setError('');
    try {
      const result = await api?.workspace?.({ type: 'cognition.context.read', companionId, id });
      if (!alive.current || epoch !== reads.current || selectedId.current !== id) return;
      if (!result?.ok || result.contextSnapshot?.companionId !== companionId || result.contextSnapshot.id !== id || result.contextSnapshot.status === 'redacted') throw new Error(result?.error || '这次实际请求已撤回或不可读取。');
      setRecord(result.contextSnapshot);
    } catch (cause) { if (alive.current && epoch === reads.current) { setRecord(undefined); setError(cause instanceof Error ? cause.message : '实际请求读取失败。'); } }
    finally { if (alive.current && epoch === reads.current) setReading(false); }
  }, [api, companionId]);
  const load = useCallback(async () => {
    const epoch = ++sequence.current; setLoading(true); setError('');
    try {
      const result = await api?.workspace?.({ type: 'cognition.context.list', companionId, limit: 40 });
      if (!alive.current || epoch !== sequence.current) return;
      if (!result?.ok || !result.contextSnapshots || result.contextSnapshots.some(item => item.companionId !== companionId)) throw new Error(result?.error || '实际请求索引暂不可核实。');
      setItems(result.contextSnapshots); setRetention(result.contextSnapshotRetention);
      const current = selectedId.current, item = result.contextSnapshots.find(item => item.id === current);
      if (current && item && item.status !== 'redacted') await open(current, true);
      else if (current) { selectedId.current = ''; setSelected(''); setRecord(undefined); ++reads.current; setReading(false); }
    } catch (cause) { if (alive.current && epoch === sequence.current) { selectedId.current = ''; ++reads.current; setReading(false); setItems([]); setRecord(undefined); setSelected(''); setError(cause instanceof Error ? cause.message : '实际请求不可读取。'); } }
    finally { if (alive.current && epoch === sequence.current) setLoading(false); }
  }, [api, companionId, open]);
  useEffect(() => { alive.current = true; const updates = createCoalescedRefresh(load, undefined, 300); void updates.trigger(); const unsubscribe = api?.onChanged(() => void updates.trigger()); return () => { alive.current = false; updates.dispose(); invalidate(); unsubscribe?.(); }; }, [api, load, invalidate]);
  const scopes = [...new Set(items.map(item => item.taskId ? 'task:' + item.taskId : item.conversationId ? 'chat:' + item.conversationId : 'purpose:' + item.purpose))];
  const visible = items.filter(item => scope === 'all' || (item.taskId ? 'task:' + item.taskId : item.conversationId ? 'chat:' + item.conversationId : 'purpose:' + item.purpose) === scope);
  const rootInvocation = record?.frame.structuredRepair?.rootInvocationId ?? record?.frame.invocationId;
  const chain = rootInvocation ? items.filter(item => item.invocationId === rootInvocation || item.structuredRepair?.rootInvocationId === rootInvocation)
    .sort((left, right) => (left.structuredRepair?.attempt ?? 0) - (right.structuredRepair?.attempt ?? 0) || left.preparedAt.localeCompare(right.preparedAt)) : [];
  return <div className="cognition-actual-context"><h4>实际模型请求</h4><p>选择某次聊天、任务或步骤，核对当时采用的版本和最终协议正文。发送凭证只证明交给了网络层；处理成功与否另行记录。</p>
    <div className="cognition-context-controls"><label>请求范围<select aria-label="实际上下文范围" value={scope} onChange={event => { setScope(event.target.value); selectedId.current = ''; setSelected(''); setRecord(undefined); ++reads.current; setReading(false); }}><option value="all">本次读取的全部请求</option>{scopes.map(value => <option key={value} value={value}>{value.startsWith('task:') ? '任务 ' : value.startsWith('chat:') ? '聊天 ' : '用途 '}{value.slice(value.indexOf(':') + 1)}</option>)}</select></label><button type="button" disabled={loading} onClick={() => void load()}>重新核对实际请求</button></div>
    {error && <p role="alert">{error}</p>}
    {loading && !items.length ? <p role="status">正在读取已保存的实际请求索引…</p> : error ? null : !items.length ? <p className="cognition-empty">尚无可核实的实际请求快照。当前档案及职能指导是资料查看，不能证明它们已发送给某次模型请求。</p> : <ul className="cognition-context-list" aria-label="已保存的实际请求">{visible.map(item => <li key={item.id} data-context-snapshot={item.id}><button type="button" aria-pressed={selected === item.id} disabled={item.status === 'redacted'} onClick={() => void open(item.id)}><strong title={item.purpose}>{companionPurposeLabel(item.purpose)}</strong>{item.structuredRepair && <small>第 {item.structuredRepair.attempt} / 2 次结构修复 · 原用途：{companionPurposeLabel(item.structuredRepair.originalPurpose)}</small>}<span>{statusLabels[item.status]}{item.imageFallback ? ' · 视觉回退后的独立请求' : ''}</span><time dateTime={item.sentAt ?? item.preparedAt}>{new Date(item.sentAt ?? item.preparedAt).toLocaleString('zh-CN', { hour12: false })}</time><small>{item.taskId ? '任务 ' + item.taskId : item.conversationId ? '聊天 ' + item.conversationId : '独立职能调用'}{item.invocationId ? ' · 步骤 ' + item.invocationId : ''}</small></button></li>)}</ul>}
    {retention && <p className="cognition-caption">每位伙伴最多保留最近 {retention.limit} 次请求正文。{retention.truncated ? '本页只显示已保留请求的一部分。' : '已退役或撤回的正文不重新提供。'}</p>}
    {reading && <p role="status">正在核对这次实际请求的正文与授权…</p>}
    {record && record.status !== 'redacted' && <article className="cognition-context-record" aria-label="选中的实际请求正文"><h4>{statusLabels[record.status]}</h4><dl><dt>请求凭证</dt><dd><code>{record.id}</code></dd><dt>本次人格编译版本</dt><dd><code>{record.frame.profileRevision}</code></dd><dt>职能指导版本</dt><dd><code>{record.frame.promptRevision}</code></dd><dt>提供方协议与模型</dt><dd>{record.providerFormat} · {record.model}</dd><dt>最终正文校验</dt><dd><code>{record.bodyHash}</code></dd>{record.httpStatus && <><dt>HTTP 响应</dt><dd>{record.httpStatus}</dd></>}</dl><p className="cognition-caption">来源撤回保护按伙伴执行；这些文本和版本对应这次请求，不随后续人格发布改写。</p>
      {(record.frame.structuredRepair || chain.some(item => item.structuredRepair)) && <section className="cognition-repair-chain" aria-label="结构化修复调用链"><h4>原请求与有限修复</h4><p>每次修复都是一次独立模型请求，保留自己的发送与响应凭据。响应凭据不证明结构已经有效，也不代表记忆或人格已发布；仍须通过结构校验和原业务核验。</p>{record.frame.structuredRepair && <dl><dt>原用途</dt><dd>{companionPurposeLabel(record.frame.structuredRepair.originalPurpose)}</dd><dt>修复原因</dt><dd>{record.frame.structuredRepair.reason === 'syntax' ? 'JSON 语法未通过' : '输出结构未通过'}</dd><dt>本次有限修复</dt><dd>第 {record.frame.structuredRepair.attempt} 次，最多两次</dd><dt>原始调用</dt><dd><code>{record.frame.structuredRepair.rootInvocationId}</code></dd><dt>前一次调用</dt><dd><code>{record.frame.structuredRepair.previousInvocationId}</code></dd></dl>}<ol>{chain.map(item => <li key={item.id}><button type="button" aria-pressed={selected === item.id} disabled={item.status === 'redacted'} onClick={() => void open(item.id)}>{item.structuredRepair ? `第 ${item.structuredRepair.attempt} 次结构修复` : '原始请求'}{item.imageFallback ? ' · 视觉回退请求' : ''} · {statusLabels[item.status]}</button></li>)}</ol><p className="cognition-caption">这里只列当前保留区的正式凭据。已撤回、超出保留范围或未取得凭据的尝试不会补造；发送或结果未确认的同一次调用禁止自动重发。</p></section>}
      <details><summary>本次身份正文</summary><ContextSnapshotText key={record.id + ':identity'} text={record.frame.identity} /></details><details><summary>本次角色职能指导</summary><ContextSnapshotText key={record.id + ':role'} text={record.frame.roleGuidance} /></details><details><summary>本次处理合同</summary><ContextSnapshotText key={record.id + ':contract'} text={record.frame.processorContract} /></details><details><summary>本次任务与资料输入</summary><ContextSnapshotText key={record.id + ':input'} text={record.frame.input} /></details><details><summary>实际工具声明</summary><ContextSnapshotText key={record.id + ':tools'} text={record.toolDeclarations} /></details>
      <details><summary>实际视觉输入</summary>{record.visualManifest.length ? <ul>{record.visualManifest.map(item => <li key={item.pointer}><strong>{item.delivery === 'inline_bytes' ? '本次实际包含像素' : '本次提供远程图片 URL'}</strong><code>{item.pointer}</code>{item.mime && <span>{item.mime}</span>}{item.bytes !== undefined && <span>{item.bytes.toLocaleString()} 字节</span>}{item.sha256 && <code>{item.sha256}</code>}{item.url && <p>{item.url}（本地不证明提供方已下载。）</p>}</li>)}</ul> : <p>这次协议正文不含可核实的图片像素或远程图片输入。资料中的图片路径不等于已发送像素。</p>}</details>
      <details open><summary>{record.sentAt ? '最终提供方协议正文 · 交给网络层的原文' : '已准备的协议正文 · 尚无发送凭证'}</summary><ContextSnapshotText key={record.id + ':body'} text={record.providerBody} /></details>
    </article>}
  </div>;
}
