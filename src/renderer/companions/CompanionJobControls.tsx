import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import { companionJobDispositionSchema, type CompanionJobControlCommand, type CompanionJobDisposition, type CompanionJobKind } from '../../shared/companion-job-control';
import './companion-job-controls.css';

export const companionJobStateLabels: Record<CompanionJobDisposition['state'], string> = {
  pending: '等待处理', running: '正在处理', completed: '本次处理已结束', failed: '处理失败', parked: '已搁置', abandoned: '已明确放弃', cancelled: '已取消', stale: '依据已失效', waiting_model: '等待模型',
};
type Props = { ownerId: string; kind: CompanionJobKind; id: string; api?: WorldlineBoxCompanionsApi; resultUnknown?: boolean;
  onDisposition?(value: CompanionJobDisposition): void };
export function CompanionJobControls(props: Props) { return <JobControlsBody key={props.ownerId + ':' + props.kind + ':' + props.id} {...props} />; }
function JobControlsBody({ ownerId, kind, id, api, resultUnknown = false, onDisposition }: Props) {
  const [record, setRecord] = useState<CompanionJobDisposition>(), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [confirming, setConfirming] = useState<'resume' | 'abandon'>();
  const [submission, setSubmission] = useState<CompanionJobControlCommand>(), [source, setSource] = useState<{ content: string; authorId: string; revision?: number }>();
  const [sourceLoading, setSourceLoading] = useState(false);
  const alive = useRef(false), sequence = useRef(0), sourceSequence = useRef(0), writing = useRef(false);
  const invalidate = useCallback(() => { ++sequence.current; ++sourceSequence.current; }, []);
  useEffect(() => { alive.current = true; const unsubscribe = api?.onChanged(() => { ++sourceSequence.current; setSource(undefined); setSourceLoading(false); });
    return () => { alive.current = false; invalidate(); unsubscribe?.(); }; }, [api, invalidate]);
  const accept = (value: unknown) => { const checked = companionJobDispositionSchema.parse(value);
    if (checked.ownerId !== ownerId || checked.kind !== kind || checked.id !== id) throw new Error('处理凭据不属于当前伙伴或当前作业。'); return checked; };
  const inspect = async () => {
    if (loading || writing.current) return; const epoch = ++sequence.current; ++sourceSequence.current; setLoading(true); setError(''); setSource(undefined); setSourceLoading(false);
    try { const result = await api?.workspace?.({ type: 'jobs.inspect', ownerId, kind, id }); if (!alive.current || epoch !== sequence.current) return;
      if (!result?.ok || !result.jobDisposition) throw new Error(result?.error || '这项记录没有可核验的耐久处理凭据，暂不能改变状态。');
      const checked = accept(result.jobDisposition); setRecord(checked); onDisposition?.(checked);
    } catch (cause) { if (alive.current && epoch === sequence.current) { setRecord(undefined); setError(cause instanceof Error ? cause.message : '处理凭据未能核实。'); } }
    finally { if (alive.current && epoch === sequence.current) setLoading(false); }
  };
  const execute = async (command: CompanionJobControlCommand) => {
    if (writing.current) return; writing.current = true; setSubmission(command); setBusy(true); setError(''); setNotice('');
    const epoch = ++sequence.current; ++sourceSequence.current;
    try { const result = await api?.workspace?.(command); if (!alive.current || epoch !== sequence.current) return;
      if (!result?.ok || !result.jobDisposition) throw new Error(result?.error || '操作结果尚未确认；请重试同一次操作核对。');
      const checked = accept(result.jobDisposition);
      if (checked.inputVersion !== command.inputVersion || checked.revision <= command.expectedRevision
        || record && checked.revision < record.revision
        || command.action === 'park' && checked.state !== 'parked' || command.action === 'abandon' && checked.state !== 'abandoned'
        || command.action === 'resume' && ['abandoned', 'parked', 'cancelled', 'stale'].includes(checked.state)) throw new Error('返回的输入版本或处理状态不匹配，未宣称操作完成。');
      setRecord(checked); onDisposition?.(checked); setSubmission(undefined); setConfirming(undefined); setSource(undefined);
      setNotice(command.action === 'park' ? '已搁置这项作业，原始事件保留；其他独立事件可以继续处理。' : command.action === 'abandon' ? '已明确放弃这次处理，原始事件没有删除，也没有被标记为整理成功。' : '恢复请求已核对；是否形成记忆或人格变化，仍以之后的正式结果为准。');
    } catch (cause) { if (alive.current && epoch === sequence.current) setError(cause instanceof Error ? cause.message : '操作未能确认。'); }
    finally { writing.current = false; if (alive.current) setBusy(false); }
  };
  const submit = (action: CompanionJobControlCommand['action']) => {
    if (!record || busy || submission || ['completed', 'abandoned', 'cancelled', 'stale'].includes(record.state)) return;
    if (action === 'resume' && record.state !== 'parked') return;
    if (action !== 'park' && confirming !== action) return;
    void execute({ type: 'jobs.control', ownerId, kind, id, inputVersion: record.inputVersion, expectedRevision: record.revision, operationId: crypto.randomUUID(), action });
  };
  const readSource = async () => {
    if (!record?.sourceMessageId || !record.conversationId || sourceLoading || busy) return;
    const epoch = ++sourceSequence.current, checked = record; setSourceLoading(true); setError('');
    try { const result = await api?.request({ type: 'message.get', id: checked.sourceMessageId! }); if (!alive.current || epoch !== sourceSequence.current) return;
      if (!result?.ok || !result.message || result.message.sourceUnavailable || result.message.id !== checked.sourceMessageId || result.message.conversationId !== checked.conversationId
        || result.message.status !== 'sent' || result.message.isReplyDraft || checked.topicId && result.message.topicId !== checked.topicId)
        throw new Error(result?.error || '原始事件已不可读取或范围不匹配；没有用其他记录替代。');
      setSource({ content: result.message.content, authorId: result.message.authorId, revision: result.message.revision });
    } catch (cause) { if (alive.current && epoch === sourceSequence.current) { setSource(undefined); setError(cause instanceof Error ? cause.message : '原始事件不可读取。'); } }
    finally { if (alive.current && epoch === sourceSequence.current) setSourceLoading(false); }
  };
  const terminal = record && ['completed', 'abandoned', 'cancelled', 'stale'].includes(record.state);
  const filePublication = kind === 'source_files' || kind === 'history_files';
  return <section className="companion-job-controls" aria-label="作业故障与处理管理">
    <div className="companion-job-controls-heading"><strong>故障与处理管理</strong><button type="button" disabled={loading || busy || !api?.workspace} onClick={() => void inspect()}>{loading ? '正在核对…' : record ? '重新核对作业' : '核对处理状态与依据'}</button></div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!api?.workspace && <p>处理管理接口尚未连接，原记录仍可查看。</p>}
    {record && <><div className="companion-job-disposition" data-state={record.state}><strong>{companionJobStateLabels[record.state]}</strong><span>累计失败 {record.failureCount} 次 · 本轮 {record.cycleFailureCount} 次</span></div>
      {record.state === 'parked' && <p>这项作业已停止自动重试。原始事件保留，后续独立事件不会因它而停止。</p>}
      {record.state === 'abandoned' && <p>这次处理已由用户明确放弃，不能通过普通恢复重新启动；原始事件和其他有效记录仍保留。</p>}
      {record.lastError && <div className="companion-job-last-error"><h5>最近一次错误{record.lastErrorAt && <time dateTime={record.lastErrorAt}>{new Date(record.lastErrorAt).toLocaleString('zh-CN', { hour12: false })}</time>}</h5><pre>{record.lastError}</pre></div>}
      {kind === 'topic_compaction' && <div className="companion-job-source-entry"><strong>话题摘要整理</strong><p>把较早的话题消息整理为后续交流可用的摘要，原始消息作为依据保留。待整理部分会保留缺口，摘要不作为新的经历或人格变化。</p></div>}
      {record.memoryId && record.contentRevision && <div className="companion-job-source-entry"><strong>本次发布的记忆修订 · r{record.contentRevision}</strong><p>这一项负责把已形成的准确修订发布为历史文件，并在它仍是当前版本时发布当前正文。恢复发布不会把其他版本替换成本次修订。</p><p>此任务的正式历史正文尚未可读。这里只展示准确的身份与修订，不以最新正文代替，也不从多条来源中猜选一个事件。</p></div>}
      {record.sourceMessageId && record.conversationId ? <div className="companion-job-source-entry"><strong>这次处理对应什么经历</strong><p>先核对仍可读取的原始事件，再决定是否继续处理。</p><button type="button" disabled={sourceLoading || busy} onClick={() => void readSource()}>{sourceLoading ? '正在读取事件…' : '查看仍获权的原始事件'}</button></div> : !record.memoryId && <p>此作业没有可直接打开的消息依据，不从其他会话推测或拼接。</p>}
      {source && <div className="companion-job-source"><p>当前可读取版本 · 作者 {source.authorId}{source.revision ? ` · 修订 ${source.revision}` : ''}。它不替代本次作业固定的输入版本。{kind === 'topic_compaction' && '这是一条原始消息入口，不代表整段话题已完成摘要。'}</p><pre>{source.content}</pre></div>}
      <details className="companion-job-evidence"><summary>技术凭据与版本</summary><dl><div><dt>作业</dt><dd><code>{record.kind}:{record.id}</code></dd></div><div><dt>输入版本</dt><dd><code>{record.inputVersion}</code></dd></div><div><dt>管理修订</dt><dd>{record.revision}</dd></div>{record.memoryId && <div><dt>记忆</dt><dd><code>{record.memoryId}</code></dd></div>}{record.contentRevision && <div><dt>正文修订</dt><dd>r{record.contentRevision}</dd></div>}{record.sourceMessageId && <div><dt>原始事件</dt><dd><code>{record.sourceMessageId}</code></dd></div>}{record.conversationId && <div><dt>所属会话</dt><dd><code>{record.conversationId}</code></dd></div>}{record.topicId && <div><dt>所属话题</dt><dd><code>{record.topicId}</code></dd></div>}</dl></details>
      {!terminal && !submission && <div className="companion-job-actions">{record.state !== 'parked' && <button type="button" disabled={busy} onClick={() => submit('park')}>搁置这项作业</button>}{record.state === 'parked' && <button type="button" disabled={busy} onClick={() => setConfirming('resume')}>恢复处理</button>}<button type="button" disabled={busy} onClick={() => setConfirming('abandon')}>放弃这次处理…</button></div>}
      {confirming && !submission && <div className="companion-job-confirm" role="group" aria-label={confirming === 'abandon' ? '确认放弃这次处理' : '确认恢复处理'}><p>{confirming === 'abandon' ? '只放弃这一次处理，不删除原始事件或已有的有效记忆；不会把失败标成成功。' : filePublication ? '恢复后重新尝试发布已保存的文件，不重新生成记忆。累计失败仍保留，本轮失败计数重新开始；其他独立事件可以继续处理。' : `${resultUnknown ? '先前调用的结果尚未确认。' : ''}恢复后可能再次调用模型；累计失败仍保留，本轮失败计数重新开始。恢复不表示已经学会或形成新性格。`}</p><div><button type="button" onClick={() => setConfirming(undefined)}>暂不操作</button><button type="button" onClick={() => submit(confirming)}>{confirming === 'abandon' ? '确认放弃这次处理' : '确认恢复这项作业'}</button></div></div>}
    </>}
    {submission && <div className="companion-job-submission"><p>{busy ? '正在提交已固定的操作…' : '操作结果尚未确认。重试沿用同一操作身份、输入版本和修订，不会自动换成新的处理请求。'}</p><button type="button" disabled={busy} onClick={() => void execute(submission)}>{busy ? '正在核对…' : '重试同一次操作'}</button></div>}
  </section>;
}
