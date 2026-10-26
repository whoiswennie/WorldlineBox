import { useEffect, useRef, useState } from 'react';
import type { CompanionTaskConcurrency } from '../../shared/companion-task-concurrency';
import type { CompanionRequest } from './CompanionDialogs';
import { createCoalescedRefresh } from './coalesced-refresh';
import { Icon } from '../Icons';
import './companion-task-concurrency.css';

export function CompanionTaskConcurrencySettings({ companions, companionId, request }: {
  companions: Array<{ id: string; name: string }>; companionId?: string; request: CompanionRequest;
}) {
  const [data, setData] = useState<CompanionTaskConcurrency>(), [drafts, setDrafts] = useState<Record<string, number>>({});
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState<string>();
  const container = useRef<HTMLDetailsElement>(null);
  const ids = companions.map(owner => owner.id).join(',');
  useEffect(() => {
    if (!ids) return;
    let current = true;
    const refresh = createCoalescedRefresh(async () => {
      const result = await request({ type: 'tasks.concurrency.get', ...(companionId ? { companionId } : {}) });
      if (!current) return;
      if (!result?.taskConcurrency) { setError(result?.error ?? '并发设置暂时无法读取。'); return; }
      setData(result.taskConcurrency); setError('');
    }, () => { if (current) setError('并发设置读取失败，请重新打开任务中心。'); }, 1000);
    void refresh.trigger(); const timer = setInterval(() => void refresh.trigger(), 2000);
    return () => { current = false; clearInterval(timer); refresh.dispose(); };
  }, [ids, companionId, request]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (container.current?.open && !container.current.contains(event.target as Node)) container.current.open = false; };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, []);
  async function save(owner: string, limit: number) {
    setSaving(owner); setError(''); setNotice('');
    try {
      const result = await request({ type: 'tasks.concurrency.set', companionId: owner, limit });
      if (!result?.taskConcurrency) { setError(result?.error ?? '并发设置尚未保存。'); return; }
      setData(current => ({ defaultLimit: 3, policies: [...(current?.policies ?? []).filter(policy => !result.taskConcurrency!.policies.some(next => next.companionId === policy.companionId)), ...result.taskConcurrency!.policies] }));
      setDrafts(current => { const next = { ...current }; delete next[owner]; return next; });
      setNotice('并发设置已保存。正在执行的任务保留进度，后续任务按新上限启动。');
    } catch { setError('并发设置尚未确认，请刷新后重试。'); }
    finally { setSaving(undefined); }
  }
  if (!companions.length) return null;
  return <details ref={container} className="companions-task-concurrency" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (container.current) container.current.open = false; } }}><summary aria-label="并发设置" title="管理每位伙伴同时执行的任务数"><Icon name="sliders" size={15} /><span>并发设置</span></summary><div className="task-concurrency-popover">
    <header><div><h3>任务并发</h3><p>每位伙伴独立计算，跨聊天共用</p></div><span>默认 3</span></header>
    {error && <p className="task-concurrency-message is-error" role="alert">{error}</p>}{notice && <p className="task-concurrency-message" role="status"><Icon name="check" size={14} />并发设置已保存</p>}
    {companions.filter(owner => !companionId || owner.id === companionId).map(owner => {
      const policy = data?.policies.find(policy => policy.companionId === owner.id);
      const value = drafts[owner.id] ?? policy?.limit ?? 3;
      const set = (limit: number) => setDrafts(current => ({ ...current, [owner.id]: limit }));
      return <div className="task-concurrency-owner" key={owner.id}><div className="task-concurrency-owner-heading"><strong>{owner.name}</strong><span>{policy ? <><i />{policy.active} 项执行<span>·</span>{policy.queued} 项排队</> : '正在读取…'}</span></div><div className="task-concurrency-edit"><label>同时执行上限</label><div className="task-concurrency-stepper"><button type="button" aria-label={`减少 ${owner.name} 并发上限`} disabled={!policy || !!saving || value <= 1} onClick={() => set(Math.max(1, value - 1))}>−</button><select aria-label={`${owner.name} 并发任务上限`} disabled={!policy || !!saving} value={value} onChange={event => set(Number(event.target.value))}>
          {Array.from({ length: 10 }, (_, index) => index + 1).map(limit => <option key={limit} value={limit}>{limit} 个</option>)}
        </select><button type="button" aria-label={`增加 ${owner.name} 并发上限`} disabled={!policy || !!saving || value >= 10} onClick={() => set(Math.min(10, value + 1))}>+</button></div><button className="task-concurrency-save" type="button" aria-label={`保存 ${owner.name} 并发设置`} disabled={!policy || value === policy.limit || !!saving} onClick={() => void save(owner.id, value)}>{saving === owner.id ? '保存中…' : '保存'}</button></div>{policy && policy.active > value && <p className="task-concurrency-soft-limit">现有 {policy.active} 项会继续完成，新的任务等待空余名额。</p>}</div>;
    })}
    <footer><Icon name="info" size={14} /><p>正在执行的任务保留进度，后续任务按新上限启动。</p></footer></div>
  </details>;
}
