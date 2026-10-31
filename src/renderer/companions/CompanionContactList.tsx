import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Companion, CompanionConversation, CompanionsRequest, CompanionsResponse } from '../../shared/companions';
import { initialCompanionContactGroups, type CompanionContactGroups } from '../../shared/companion-contact-groups';
import { Icon } from '../Icons';
import { Avatar } from './CompanionVisuals';
import { CompanionStatusBadge } from './CompanionStatusBadge';
import { CompanionContactGroupManager, type ContactGroupMutation } from './CompanionContactGroupManager';
import './companion-contact-list.css';

type GroupKind = 'contacts' | 'conversations';
export function CompanionContactList({ companions, conversations, selectedId, request, onSelect, onOpenConversation, onAdd, onCreateGroup, renderConversationAvatar, active = true }: {
  companions: Companion[]; conversations: CompanionConversation[]; selectedId?: string;
  request: (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>;
  onSelect: (id: string) => void; onOpenConversation: (room: CompanionConversation) => void;
  onAdd: () => void; onCreateGroup: () => void; renderConversationAvatar: (room: CompanionConversation) => ReactNode; active?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{ scope: typeof request; catalogue: CompanionContactGroups }>();
  const catalogue = snapshot?.scope === request ? snapshot.catalogue : initialCompanionContactGroups(), loaded = snapshot?.scope === request;
  const [busyScope, setBusyScope] = useState<{ scope: typeof request }>(), [failure, setFailure] = useState<{ scope: typeof request; message: string }>();
  const busy = busyScope?.scope === request, error = failure?.scope === request ? failure.message : '';
  function setBusy(value: boolean) { setBusyScope(value ? { scope: request } : undefined); }
  function setError(message: string) { setFailure(message ? { scope: request, message } : undefined); }
  function setCatalogue(value: CompanionContactGroups) { setSnapshot({ scope: request, catalogue: value }); }
  const [kind, setKind] = useState<GroupKind>('contacts'), [search, setSearch] = useState('');
  const [managing, setManaging] = useState(false), [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(() => new Set());
  const groupContentPrefix = useId(), currentCatalogue = useRef(catalogue), operations = useRef({ epoch: 0, busy: false, live: false });
  function changeSearch(value: string) { setSearch(value); setSearchCollapsed(new Set()); }
  const [previousView, setPreviousView] = useState({ active, request });
  if (previousView.active !== active || previousView.request !== request) { setPreviousView({ active, request }); if (!active || previousView.request !== request) setManaging(false); }
  useEffect(() => {
    const state = operations.current, epoch = ++state.epoch; state.live = true; state.busy = false;
    void request({ type: 'contact.groups.read' }).then(result => {
      if (!state.live || epoch !== state.epoch) return;
      if (result?.ok && result.contactGroups) { currentCatalogue.current = result.contactGroups; setSnapshot({ scope: request, catalogue: result.contactGroups }); }
      else setFailure({ scope: request, message: '分组暂时无法读取。' });
    }).catch(() => { if (state.live && epoch === state.epoch) setFailure({ scope: request, message: '分组暂时无法读取，请稍后重试。' }); });
    return () => { state.live = false; ++state.epoch; };
  }, [request]);
  async function mutate(command: ContactGroupMutation): Promise<boolean> {
    const state = operations.current, epoch = state.epoch;
    if (state.busy || !loaded || !state.live) return false;
    state.busy = true; setBusy(true); setError('');
    try {
      const result = await request({ ...command, expectedRevision: currentCatalogue.current.revision });
      if (!state.live || epoch !== state.epoch) return false;
      if (result?.ok && result.contactGroups) { currentCatalogue.current = result.contactGroups; setCatalogue(result.contactGroups); return true; }
      setError(result?.error || '分组未保存，请重试。');
      const current = await request({ type: 'contact.groups.read' });
      if (state.live && epoch === state.epoch && current?.ok && current.contactGroups) { currentCatalogue.current = current.contactGroups; setCatalogue(current.contactGroups); }
    } catch (cause) { if (state.live && epoch === state.epoch) setError(cause instanceof Error ? cause.message : '分组未保存，请重试。'); }
    finally { if (state.live && epoch === state.epoch) { state.busy = false; setBusy(false); } }
    return false;
  }
  const groups = catalogue.groups.filter(group => group.kind === kind), fallback = groups.find(group => group.system)!.id;
  const targetOf = (id: string) => groups.some(group => group.id === catalogue.assignments[id]) ? catalogue.assignments[id] : fallback;
  const needle = search.trim().toLocaleLowerCase(), contacts = companions.filter(item => `${item.name} ${item.description}`.toLocaleLowerCase().includes(needle));
  const rooms = conversations.filter(item => item.kind === 'group' && item.title.toLocaleLowerCase().includes(needle));
  return <div className="companion-contact-book">
    <div className="companion-contact-search-row"><label className="companion-contact-search"><Icon name="search" /><input aria-label="搜索联系人" placeholder={kind === 'contacts' ? '搜索联系人' : '搜索群聊'} value={search} onChange={event => changeSearch(event.target.value)} />{search && <button aria-label="清空搜索" onClick={() => changeSearch('')}><Icon name="close" /></button>}</label><button className="companion-contact-add" aria-label="添加联系人" title="添加联系人" onClick={onAdd}><Icon name="plus" /></button></div>
    <button className="companion-contact-manager" aria-haspopup="dialog" aria-expanded={managing && active} onClick={() => setManaging(true)}><Icon name="users" /><span>联系人管理</span><Icon name="chevron-right" /></button>
    <div className="companion-contact-shortcuts"><button onClick={onAdd}>添加伙伴<Icon name="chevron-right" /></button><button onClick={onCreateGroup}>创建群聊<Icon name="chevron-right" /></button></div>
    <div className="companion-contact-tabs" role="tablist" aria-label="联系人类型"><button role="tab" aria-selected={kind === 'contacts'} onClick={() => setKind('contacts')}>伙伴</button><button role="tab" aria-selected={kind === 'conversations'} onClick={() => setKind('conversations')}>群聊</button></div>
    {error && !managing && <p className="companion-contact-group-error" role="alert">{error}</p>}
    <div className="companion-contact-groups" aria-busy={busy}>{groups.map(group => {
      const members = contacts.filter(item => targetOf(item.id) === group.id), chats = rooms.filter(item => targetOf(item.id) === group.id);
      const count = kind === 'contacts' ? members.length : chats.length, expanded = !(needle ? searchCollapsed : collapsed).has(group.id), contentId = `${groupContentPrefix}-${group.id}`;
      if (needle && !count) return null;
      return <section className={'companion-contact-group ' + (expanded ? 'is-expanded' : 'is-collapsed')} key={group.id} aria-label={group.name}>
        <div className="companion-contact-group-heading"><button aria-expanded={expanded} aria-controls={contentId} title={(expanded ? '收起' : '展开') + group.name} onClick={() => { const update = needle ? setSearchCollapsed : setCollapsed; update(current => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; }); }}><span className="companion-contact-disclosure" aria-hidden="true" style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}><Icon name="chevron-right" /></span><span className="companion-contact-group-name">{group.name}</span><small className="companion-contact-group-count">{count}</small></button></div>
        <div id={contentId} className="companion-contact-group-content" hidden={!expanded}>
          {expanded && !count && <p className="companion-contact-group-empty">{kind === 'contacts' ? '暂无伙伴' : '暂无群聊'}</p>}
          {expanded && (kind === 'contacts' ? members.map(item => <div className="companion-contact-entry" key={item.id}><button className={`companions-contact${selectedId === item.id ? ' is-selected' : ''}`} aria-pressed={selectedId === item.id} data-companion-contact={item.id} onClick={() => onSelect(item.id)}><Avatar companion={item} /><span><strong><span className="companions-contact-name">{item.name}</span><CompanionStatusBadge companion={item} showCount /></strong><small>{item.description || '与你一起生活的伙伴'}</small></span></button></div>) : chats.map(item => <div className="companion-contact-entry" key={item.id}><button className="companions-contact" data-companion-contact-group={item.id} onClick={() => onOpenConversation(item)}>{renderConversationAvatar(item)}<span><strong>{item.title}</strong><small>{item.memberIds.length + 1} 位成员</small></span></button></div>))}
        </div>
      </section>;
    })}{needle && !(kind === 'contacts' ? contacts.length : rooms.length) && <div className="companions-list-empty">没有找到{kind === 'contacts' ? '相关伙伴' : '相关群聊'}</div>}</div>
    {managing && active && <CompanionContactGroupManager catalogue={catalogue} companions={companions} conversations={conversations} initialKind={kind} loaded={loaded} busy={busy} error={error} onMutate={mutate} onClose={() => setManaging(false)} renderConversationAvatar={renderConversationAvatar} />}
  </div>;
}
