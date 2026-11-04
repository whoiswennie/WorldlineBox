import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BotCompanion, BotCompanionPresence, BotConversation, BotRequest, BotResponse } from '../../shared/companion-bot';
import { BotAvatar } from './BotAvatar';
import { BotIcon } from './BotIcon';
import { BotPresenceText } from './BotPresence';
import './bot-group-members.css';

interface Props {
  conversation: BotConversation; companions: readonly BotCompanion[]; locale: 'zh-CN' | 'en';
  presence?: Record<string, BotCompanionPresence>;
  request(input: BotRequest): Promise<BotResponse>; onChanged(): Promise<unknown>; onClose(): void; onDissolved?(): void;
}
const pageSize = 40, maximum = 16;

/** A new room always gets an independent draft and request lifetime. */
export function BotGroupMembers(props: Props) {
  return createPortal(<GroupMemberDialog key={props.conversation.id} {...props} />, document.body);
}
function GroupMemberDialog({ conversation, companions, locale, presence, request, onChanged, onClose, onDissolved }: Props) {
  const zh = locale === 'zh-CN', titleId = useId(), dialog = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null), alive = useRef(true);
  const [selected, setSelected] = useState(() => new Set(conversation.memberIds.filter(id => id !== 'user')));
  const [baseline, setBaseline] = useState(() => new Set(conversation.memberIds.filter(id => id !== 'user')));
  const [tab, setTab] = useState<'members' | 'add'>('members'), [query, setQuery] = useState('');
  const [paging, setPaging] = useState({ key: '', index: 0 }), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState(false);
  const canManage = conversation.kind === 'group' && conversation.memberIds.includes('user') && !conversation.dissolvedAt;
  useEffect(() => {
    const previous = document.activeElement; alive.current = true; close.current?.focus();
    return () => { alive.current = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const known = new Map(companions.map(companion => [companion.id, companion]));
  const key = query.normalize('NFKC').toLocaleLowerCase().trim(), pageKey = `${tab}:${key}`;
  const available = tab === 'members' ? [...selected].map(id => ({ id, companion: known.get(id) })) : companions.filter(companion => !selected.has(companion.id) && companion.id !== 'user').map(companion => ({ id: companion.id, companion }));
  const matches = available.filter(item => (item.companion?.name ?? item.id).normalize('NFKC').toLocaleLowerCase().includes(key));
  const pages = Math.max(1, Math.ceil(matches.length / pageSize)), pageIndex = Math.min(paging.key === pageKey ? paging.index : 0, pages - 1), visible = matches.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
  const dirty = selected.size !== baseline.size || [...selected].some(id => !baseline.has(id));
  const toggle = (id: string) => {
    if (busy || !canManage || id === 'user') return;
    if (!selected.has(id) && selected.size >= maximum) { setError(zh ? `一个群聊最多加入 ${maximum} 位伙伴。` : `A group can include up to ${maximum} companions.`); return; }
    setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); setError('');
  };
  const save = async () => {
    if (!canManage || busy || !dirty || !selected.size || selected.size > maximum) return;
    setBusy(true); setError('');
    try {
      const result = await request({ type: 'conversation.members', conversationId: conversation.id, memberIds: [...selected] });
      if (!alive.current) return;
      if (!result.ok) { setError(result.error ?? (zh ? '成员未能保存，请重试。' : 'The members could not be saved.')); return; }
      setBaseline(new Set(selected));
      await onChanged(); if (alive.current) onClose();
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : zh ? '保存失败，请重试。' : 'The members could not be saved.'); }
    finally { if (alive.current) setBusy(false); }
  };
  const dissolve = async () => {
    if (!canManage || busy || !confirm) return;
    setBusy(true); setError('');
    try {
      const result = await request({ type: 'conversation.dissolve', conversationId: conversation.id });
      if (!alive.current) return;
      if (!result.ok) { setError(result.error ?? (zh ? '暂时无法解散群聊。' : 'The group could not be dissolved.')); return; }
      onDissolved?.(); onClose();
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : zh ? '解散失败，请重试。' : 'The group could not be dissolved.'); }
    finally { if (alive.current) setBusy(false); }
  };
  const keyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (confirm) setConfirm(false); else onClose(); return; }
    if (event.key !== 'Tab') return;
    const scope = confirm ? dialog.current?.querySelector('[role=alertdialog]') : dialog.current;
    const controls = [...scope?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? []], first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return <div className="bot-group-members-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <section className="bot-group-members" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={keyboard}>
      <header className="bot-group-members-header"><span className="bot-group-members-symbol"><BotIcon name="users" /></span><div><h2 id={titleId}>{zh ? '群聊成员' : 'Group members'}</h2><p title={conversation.title}>{conversation.title}</p></div><button type="button" ref={close} aria-label={zh ? '关闭成员管理' : 'Close member management'} onClick={onClose}>×</button></header>
      <nav className="bot-group-members-tabs" aria-label={zh ? '成员视图' : 'Member view'}><button type="button" aria-pressed={tab === 'members'} onClick={() => setTab('members')}>{zh ? '群内成员' : 'In this group'}<span>{selected.size + 1}</span></button><button type="button" aria-pressed={tab === 'add'} onClick={() => setTab('add')}>{zh ? '添加伙伴' : 'Add companions'}</button><small>{zh ? `已加入 ${selected.size} / ${maximum} 位伙伴` : `${selected.size} / ${maximum} companions`}</small></nav>
      <div className="bot-group-members-search"><BotIcon name="search" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={zh ? '搜索伙伴名称' : 'Search companions'} aria-label={zh ? '搜索群成员' : 'Search group members'} />{query && <button type="button" aria-label={zh ? '清除搜索' : 'Clear search'} onClick={() => setQuery('')}>×</button>}</div>
      <div className="bot-group-members-list" aria-label={zh ? '伙伴列表' : 'Companion list'}>
        {tab === 'members' && !key && <div className="bot-group-member is-owner"><BotAvatar name={zh ? '我' : 'Me'} /><span><strong>{zh ? '我' : 'Me'}</strong><small>{zh ? '群主 · 始终在群内' : 'Owner · always in this group'}</small></span><span className="bot-group-owner-label">{zh ? '群主' : 'Owner'}</span></div>}
        {visible.map(({ id, companion }) => <div className="bot-group-member" key={id}>
          <BotAvatar companion={companion} name={companion?.name ?? id} presence={tab === 'members' ? presence?.[id] : undefined} locale={locale} /><span><strong title={companion?.name ?? id}>{companion?.name ?? id}</strong><small>{tab === 'members' && presence?.[id] ? <BotPresenceText presence={presence[id]} locale={locale} /> : tab === 'members' ? zh ? '群聊成员' : 'Group member' : zh ? '可添加的伙伴' : 'Available companion'}</small></span>
          <button type="button" disabled={busy || !canManage} className={tab === 'members' ? 'is-remove' : 'is-add'} aria-label={`${tab === 'members' ? zh ? '移除' : 'Remove' : zh ? '添加' : 'Add'} ${companion?.name ?? id}`} onClick={() => toggle(id)}>{tab === 'members' ? zh ? '移除' : 'Remove' : zh ? '添加' : 'Add'}</button>
        </div>)}
        {!visible.length && <div className="bot-group-members-empty"><BotIcon name="users" /><strong>{key ? zh ? '没有匹配的伙伴' : 'No matching companions' : tab === 'add' ? zh ? '所有伙伴都已加入' : 'All companions are in this group' : zh ? '还没有其他成员' : 'No other members yet'}</strong><span>{key ? zh ? '试试其他名称。' : 'Try another name.' : zh ? '可从“添加伙伴”中选择聊天对象。' : 'Choose someone from Add companions.'}</span></div>}
      </div>
      <div className="bot-group-members-pagination"><span>{zh ? `${matches.length} 位伙伴` : `${matches.length} companions`}{dirty && <em>{zh ? ' · 尚未保存' : ' · Unsaved'}</em>}</span>{pages > 1 && <div><button type="button" disabled={!pageIndex} onClick={() => setPaging({ key: pageKey, index: pageIndex - 1 })}>{zh ? '上一页' : 'Previous'}</button><small>{pageIndex + 1} / {pages}</small><button type="button" disabled={pageIndex + 1 >= pages} onClick={() => setPaging({ key: pageKey, index: pageIndex + 1 })}>{zh ? '下一页' : 'Next'}</button></div>}</div>
      <footer className="bot-group-members-footer"><button type="button" className="is-danger" disabled={busy || !canManage} onClick={() => { setError(''); setConfirm(true); }}>{zh ? '解散群聊' : 'Dissolve group'}</button><span />{!selected.size && <small>{zh ? '请至少保留一位伙伴' : 'Keep at least one companion'}</small>}<button type="button" onClick={onClose}>{zh ? '取消' : 'Cancel'}</button><button type="button" className="is-primary" disabled={busy || !canManage || !dirty || !selected.size || selected.size > maximum} onClick={() => void save()}>{busy ? zh ? '正在处理…' : 'Working…' : zh ? '保存成员' : 'Save members'}</button></footer>
      {!canManage && <div className="bot-group-members-notice" role="status">{zh ? '此会话不支持群成员管理。' : 'Member management is unavailable for this conversation.'}</div>}
      {error && !confirm && <div className="bot-group-members-notice is-error" role="alert">{error}<button type="button" aria-label={zh ? '关闭提示' : 'Dismiss notice'} onClick={() => setError('')}>×</button></div>}
      {confirm && <DissolveConfirmation title={conversation.title} locale={locale} busy={busy} error={error} onCancel={() => setConfirm(false)} onConfirm={() => void dissolve()} />}
    </section>
  </div>;
}
function DissolveConfirmation({ title, locale, busy, error, onCancel, onConfirm }: { title: string; locale: 'zh-CN' | 'en'; busy: boolean; error?: string; onCancel(): void; onConfirm(): void }) {
  const zh = locale === 'zh-CN', id = useId(), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement; cancel.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  return <div className="bot-group-dissolve-backdrop"><section role="alertdialog" aria-modal="true" aria-labelledby={id} className="bot-group-dissolve-confirm"><span className="bot-group-members-symbol"><BotIcon name="users" /></span><h3 id={id}>{zh ? '解散这个群聊？' : 'Dissolve this group?'}</h3><p>{title}</p><span>{zh ? '解散后无法继续在这里发送消息。请确认要结束这个群聊。' : 'You will no longer be able to send messages here. Confirm to end this group.'}</span><footer><button type="button" ref={cancel} disabled={busy} onClick={onCancel}>{zh ? '保留群聊' : 'Keep group'}</button><button type="button" className="is-danger-solid" disabled={busy} onClick={onConfirm}>{busy ? zh ? '正在解散…' : 'Dissolving…' : zh ? '确认解散' : 'Confirm dissolve'}</button></footer>{error && <div role="alert" className="bot-group-dissolve-error">{error}</div>}</section></div>;
}
