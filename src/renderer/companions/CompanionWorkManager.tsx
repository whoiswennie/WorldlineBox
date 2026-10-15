import { useRef, useState } from 'react';
import type { CompanionWorkOrder } from '../../shared/companion-work-order';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import { companionTimestamp } from '../../shared/companion-time';
import { Icon } from '../Icons';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { Avatar } from './CompanionVisuals';
import type { ScheduleRequest } from './companion-schedules';
import { activeWorkOrder, useCompanionWorkOrders, WORK_ORDER_STATUS } from './companion-work-orders';
import './companion-work-orders.css';

export function CompanionWorkManager({ companion, companions, conversationId, request, api, initialOrderId, onClose, onOpenAction, requestError, onDismissError }: {
  readonly companion: Companion; readonly companions: Companion[]; readonly conversationId: string; readonly request: ScheduleRequest;
  readonly api?: WorldlineBoxCompanionsApi; readonly initialOrderId?: string; readonly onClose: () => void; readonly onOpenAction: (id: string) => void;
  readonly requestError?: string; readonly onDismissError: () => void;
}) {
  useDialogFocusTrap(true, '伙伴工作台');
  const [history, setHistory] = useState(false), [selectedId, setSelectedId] = useState(initialOrderId);
  const { orders, loading, loadingMore, hasMore, error: loadError, refresh, loadMore } = useCompanionWorkOrders(companion.id, conversationId, request, api, history);
  const [editor, setEditor] = useState<{ order?: CompanionWorkOrder; title: string; instruction: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmCancel, setConfirmCancel] = useState<string>();
  const clientId = useRef(crypto.randomUUID()), submitted = useRef('');
  const selected = orders.find(order => order.id === selectedId) ?? orders[0];
  const name = (id: string) => id === 'user' ? '你' : companions.find(item => item.id === id)?.name ?? '伙伴';
  function begin(order?: CompanionWorkOrder) { setEditor({ order, title: order?.title ?? '', instruction: order?.instruction ?? '' }); setError(''); setConfirmCancel(undefined); clientId.current = crypto.randomUUID(); submitted.current = ''; }
  async function save() {
    if (!editor) return;
    const title = editor.title.trim(), instruction = editor.instruction.trim();
    if (!title || !instruction) { setError('请写下工作标题和完整要求。'); return; }
    if (title.length > 200 || instruction.length > 16000) { setError('标题最多200字，工作要求最多16000字。'); return; }
    const signature = JSON.stringify({ title, instruction });
    if (submitted.current && submitted.current !== signature) clientId.current = crypto.randomUUID();
    submitted.current = signature; setBusy(true); setError('');
    try {
      const response = editor.order ? await request({ type: 'work-order.update', companionId: companion.id, conversationId, id: editor.order.id, expectedRevision: editor.order.revision, patch: { title, instruction } }) : await request({ type: 'work-order.create', companionId: companion.id, conversationId, title, instruction, clientId: clientId.current });
      if (!response?.workOrder) { setError(response?.error || '工作未保存。请刷新确认最新状态后重试。'); return; }
      setSelectedId(response.workOrder.id); setEditor(undefined); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '工作未保存，请重试。'); }
    finally { setBusy(false); }
  }
  async function act(order: CompanionWorkOrder, operation: 'accept' | 'pause' | 'cancel') {
    setBusy(true); setError('');
    const scope = { companionId: companion.id, conversationId, id: order.id, expectedRevision: order.revision };
    try {
      const response = operation === 'accept' ? await request({ type: 'work-order.accept', ...scope }) : operation === 'cancel' ? await request({ type: 'work-order.cancel', ...scope }) : await request({ type: 'work-order.pause', ...scope, paused: order.status !== 'paused' });
      if (!response?.ok) { setError(response?.error || '工作状态已变化，请刷新后重试。'); return; }
      setConfirmCancel(undefined); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，请重试。'); }
    finally { setBusy(false); }
  }
  return <div className="companions-modal-backdrop companions-workspace-backdrop" onClick={onClose}>
    <section className="companions-work-manager" role="dialog" aria-modal="true" aria-label="伙伴工作台" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); onClose(); } }}>
      <header><div className="companions-workspace-title"><span className="companions-workspace-symbol"><Icon name="clipboard" /></span><div><h2>把事情交给伙伴</h2><p>工作集中处理，日常安排留在生活手帐</p></div></div><div className="companions-memory-manager-owner"><Avatar companion={companion} showPresence={false} /><span>{companion.name}</span><button className="companion-icon-button" aria-label="关闭伙伴工作台" onClick={onClose}>×</button></div></header>
      {requestError && <div className="companions-workspace-request-error" role="alert"><span>{requestError}</span><button aria-label="关闭错误提示" onClick={onDismissError}>×</button></div>}
      <div className="companions-work-toolbar"><nav aria-label="工作范围"><button aria-pressed={!history} onClick={() => { setHistory(false); setEditor(undefined); }}>当前工作</button><button aria-pressed={history} onClick={() => { setHistory(true); setEditor(undefined); }}>全部记录</button></nav><div className="companions-work-toolbar-actions"><button className="companion-icon-button" aria-label="刷新工作台" disabled={busy} onClick={() => void refresh()}><Icon name="refresh" /></button><button className="companion-primary-button" onClick={() => begin()}><Icon name="plus" />发布工作</button></div></div>
      {(error || loadError) && <p className="companions-memory-error" role="alert">{error || loadError}<button disabled={busy} onClick={() => void refresh()}>刷新工作</button></p>}
      <div className="companions-work-workspace"><div className="companions-work-list" aria-label="工作列表">
        {loading && <p className="companions-subtle">正在读取工作…</p>}
        {!loading && !orders.length && <div className="companions-work-empty"><Icon name="clipboard" /><h3>留一张清楚的工作单</h3><p>写下目标和要求，伙伴会前往电脑处理。普通聊天不占用工作台。</p><button className="companion-secondary-button" onClick={() => begin()}>发布第一份工作</button></div>}
        {orders.map(order => <button className={'companions-work-list-item' + (selected?.id === order.id && !editor ? ' is-selected' : '')} key={order.id} data-work-order={order.id} aria-pressed={selected?.id === order.id && !editor} onClick={() => { setSelectedId(order.id); setEditor(undefined); setConfirmCancel(undefined); setError(''); }}><span className="companions-work-status" data-status={order.status}>{WORK_ORDER_STATUS[order.status]}</span><strong>{order.title}</strong><small>{name(order.publisherId)}发布 · {companionTimestamp(order.worldCreatedAt)}</small></button>)}
        {hasMore && <button className="companions-work-load-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? '正在读取…' : '读取更多工作'}</button>}
      </div><div className="companions-work-detail">
        {editor ? <form className="companions-work-form" onSubmit={event => { event.preventDefault(); void save(); }}><span className="companions-work-eyebrow">{editor.order ? '修改工作要求' : '一份新的委托'}</span><h3>{editor.order ? '让要求保持清楚' : '这次想一起完成什么'}</h3><label>工作标题<input aria-label="工作标题" maxLength={200} required value={editor.title} onChange={event => setEditor({ ...editor, title: event.target.value })} placeholder="例如：整理这周的读书笔记" /></label><label>完整要求<textarea aria-label="工作要求" maxLength={16000} rows={10} required value={editor.instruction} onChange={event => setEditor({ ...editor, instruction: event.target.value })} placeholder="写清目标、资料位置、交付方式，以及需要遵守的边界。" /></label><p className="companions-work-form-note">你发布的工作会直接进入待处理队列。电脑任务通过 DSH 执行，应用需要保持运行。</p><footer><button className="companion-secondary-button" type="button" disabled={busy} onClick={() => setEditor(undefined)}>暂不保存</button><button className="companion-primary-button" type="submit" disabled={busy}>{busy ? '正在保存…' : editor.order ? '保存工作修改' : '确认发布工作'}</button></footer></form> : selected ? <article className="companions-work-order-detail"><span className="companions-work-status" data-status={selected.status}>{WORK_ORDER_STATUS[selected.status]}</span><h3>{selected.title}</h3><p className="companions-work-meta">{name(selected.publisherId)}发布 · {selected.execution === 'external' ? '电脑工作' : '伙伴内部工作'} · 修订 {selected.revision}</p><section><h4>工作要求</h4><p>{selected.instruction}</p></section>{selected.result && <section className="companions-work-result"><h4>交付结果</h4><p>{selected.result}</p></section>}{selected.error && <section role="alert"><h4>需要关注</h4><p>{selected.error}</p></section>}
          {selected.execution === 'internal' && <p className="companions-work-form-note">这是伙伴之间的内部工作。要求由原发布伙伴给出；如果你想委托电脑工作，可以另发一份工作单。</p>}
          <div className="companions-work-detail-actions">{selected.actionId && <button className="companion-secondary-button" onClick={() => onOpenAction(selected.actionId!)}><Icon name="activity" />查看执行过程</button>}{activeWorkOrder(selected) && <>{selected.status === 'offered' && <button className="companion-primary-button" disabled={busy} onClick={() => void act(selected, 'accept')}>接受工作</button>}{selected.execution === 'external' && selected.conversationId === conversationId && ['offered', 'paused'].includes(selected.status) && <button className="companion-secondary-button" disabled={busy} onClick={() => begin(selected)}>修改要求</button>}{selected.status !== 'offered' && <button className="companion-secondary-button" disabled={busy} onClick={() => void act(selected, 'pause')}>{selected.status === 'paused' ? '恢复工作' : '暂停工作'}</button>}<button className="companions-work-text-button" disabled={busy} onClick={() => setConfirmCancel(selected.id)}>取消工作</button></>}</div>
          {confirmCancel === selected.id && <div className="companions-work-confirm"><p>取消后停止这份工作，已产生的文件和成果保留。</p><button className="companion-secondary-button" onClick={() => setConfirmCancel(undefined)}>继续保留</button><button className="companion-primary-button" disabled={busy} onClick={() => void act(selected, 'cancel')}>确认取消工作</button></div>}
        </article> : <div className="companions-work-detail-idle"><Icon name="activity" /><h3>给每件事一个去处</h3><p>在左侧选择工作，查看完整要求与实际结果。</p></div>}
      </div></div>
    </section>
  </div>;
}
