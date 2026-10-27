import { useEffect, useId, useState, type ReactNode } from 'react';
import type { Companion, CompanionConversation, CompanionsRequest, CompanionsResponse } from '../../shared/companions';
import { initialCompanionContactGroups, type CompanionContactGroups } from '../../shared/companion-contact-groups';
import { Icon } from '../Icons';
import { Avatar } from './CompanionVisuals';
import { CompanionStatusBadge } from './CompanionStatusBadge';
import './companion-contact-list.css';

type GroupKind = 'contacts' | 'conversations';
type GroupMutation = Extract<CompanionsRequest, { type: 'contact.groups.create' | 'contact.groups.rename' | 'contact.groups.remove' | 'contact.groups.assign' }>;
type MutationInput = GroupMutation extends infer T ? T extends GroupMutation ? Omit<T, 'expectedRevision'> : never : never;

export function CompanionContactList({ companions, conversations, selectedId, request, onSelect, onOpenConversation, onAdd, onCreateGroup, renderConversationAvatar }: {
  companions: Companion[]; conversations: CompanionConversation[]; selectedId?: string;
  request: (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>;
  onSelect: (id: string) => void; onOpenConversation: (room: CompanionConversation) => void;
  onAdd: () => void; onCreateGroup: () => void; renderConversationAvatar: (room: CompanionConversation) => ReactNode;
}) {
  const [catalogue, setCatalogue] = useState<CompanionContactGroups>(initialCompanionContactGroups);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [kind, setKind] = useState<GroupKind>('contacts'), [search, setSearch] = useState('');
  const [managing, setManaging] = useState(false), [name, setName] = useState('');
  const [editing, setEditing] = useState<string>(), [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(() => new Set());
  const groupContentPrefix = useId();
  function changeSearch(value: string) { setSearch(value); setSearchCollapsed(new Set()); }
  useEffect(() => {
    let live = true;
    void request({ type: 'contact.groups.read' }).then(result => {
      if (!live) return;
      if (result?.contactGroups) { setCatalogue(result.contactGroups); setLoaded(true); }
      else setError('分组暂时无法读取。');
    });
    return () => { live = false; };
  }, [request]);
  async function mutate(command: MutationInput) {
    if (busy || !loaded) return;
    setBusy(true); setError('');
    try {
      const result = await request({ ...command, expectedRevision: catalogue.revision });
      if (result?.contactGroups) { setCatalogue(result.contactGroups); setName(''); setEditing(undefined); }
      else {
        setError('分组未保存，请重试。');
        const current = await request({ type: 'contact.groups.read' });
        if (current?.contactGroups) setCatalogue(current.contactGroups);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '分组未保存，请重试。'); }
    finally { setBusy(false); }
  }
  const groups = catalogue.groups.filter(group => group.kind === kind);
  const fallback = groups.find(group => group.system)!.id;
  const targetOf = (id: string) => groups.some(group => group.id === catalogue.assignments[id]) ? catalogue.assignments[id] : fallback;
  const needle = search.trim().toLocaleLowerCase();
  const contacts = companions.filter(item => `${item.name} ${item.description}`.toLocaleLowerCase().includes(needle));
  const rooms = conversations.filter(item => item.kind === 'group' && item.title.toLocaleLowerCase().includes(needle));
  function move(id: string, title: string) {
    return managing && <select aria-label={`移动${title}到分组`} value={targetOf(id)} disabled={busy || !loaded}
      onChange={event => void mutate({ type: 'contact.groups.assign', kind, groupId: event.target.value, itemIds: [id] })}>
      {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
    </select>;
  }
  return <div className="companion-contact-book">
    <div className="companion-contact-search-row">
      <label className="companion-contact-search"><Icon name="search" /><input aria-label="搜索联系人" placeholder={kind === 'contacts' ? '搜索联系人' : '搜索群聊'} value={search} onChange={event => changeSearch(event.target.value)} />
        {search && <button aria-label="清空搜索" onClick={() => changeSearch('')}><Icon name="close" /></button>}</label>
      <button className="companion-contact-add" aria-label="添加联系人" title="添加联系人" onClick={onAdd}><Icon name="plus" /></button>
    </div>
    <button className={`companion-contact-manager${managing ? ' is-active' : ''}`} aria-expanded={managing} onClick={() => { setManaging(!managing); setEditing(undefined); setName(''); }}><Icon name="users" />{managing ? '完成分组管理' : '联系人管理'}</button>
    <div className="companion-contact-shortcuts"><button onClick={onAdd}>添加伙伴<Icon name="chevron-right" /></button><button onClick={onCreateGroup}>创建群聊<Icon name="chevron-right" /></button></div>
    <div className="companion-contact-tabs" role="tablist" aria-label="联系人类型">
      <button role="tab" aria-selected={kind === 'contacts'} onClick={() => { setKind('contacts'); setEditing(undefined); setName(''); }}>伙伴</button>
      <button role="tab" aria-selected={kind === 'conversations'} onClick={() => { setKind('conversations'); setEditing(undefined); setName(''); }}>群聊</button>
    </div>
    {managing && <form className="companion-contact-group-form" onSubmit={event => { event.preventDefault(); if (name.trim()) void mutate(editing ? { type: 'contact.groups.rename', id: editing, name: name.trim() } : { type: 'contact.groups.create', kind, name: name.trim() }); }}>
      <label className="sr-only" htmlFor="contact-group-name">{editing ? '修改分组名称' : '新分组名称'}</label>
      <input id="contact-group-name" aria-label={editing ? '修改分组名称' : '新分组名称'} placeholder={editing ? '修改分组名称' : '新分组名称'} maxLength={60} value={name} onChange={event => setName(event.target.value)} />
      <button disabled={busy || !loaded || !name.trim()}>{editing ? '保存' : '新建'}</button>
      {editing && <button type="button" aria-label="取消修改分组" onClick={() => { setEditing(undefined); setName(''); }}><Icon name="close" /></button>}
    </form>}
    {error && <p className="companion-contact-group-error" role="alert">{error}</p>}
    <div className="companion-contact-groups" aria-busy={busy}>
      {groups.map(group => {
        const members = contacts.filter(item => targetOf(item.id) === group.id), chats = rooms.filter(item => targetOf(item.id) === group.id);
        const count = kind === 'contacts' ? members.length : chats.length, expanded = !(needle ? searchCollapsed : collapsed).has(group.id);
        const contentId = `${groupContentPrefix}-${group.id}`;
        if (needle && !count) return null;
        return <section className={'companion-contact-group ' + (expanded ? 'is-expanded' : 'is-collapsed')} key={group.id} aria-label={group.name}>
          <div className="companion-contact-group-heading"><button aria-expanded={expanded} aria-controls={contentId} title={(expanded ? '收起' : '展开') + group.name} onClick={() => {
            const update = needle ? setSearchCollapsed : setCollapsed;
            update(current => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; });
          }}>
            <span className="companion-contact-disclosure" aria-hidden="true" style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}><Icon name="chevron-right" /></span><span className="companion-contact-group-name">{group.name}</span><small className="companion-contact-group-count">{count}</small></button>
            {managing && <span className="companion-contact-group-actions"><button aria-label={`重命名分组${group.name}`} title="重命名分组" disabled={busy} onClick={() => { setEditing(group.id); setName(group.name); }}><Icon name="edit" /></button>
              {!group.system && <button aria-label={`删除分组${group.name}`} title="删除分组，成员回到默认分组" disabled={busy} onClick={() => void mutate({ type: 'contact.groups.remove', id: group.id })}><Icon name="close" /></button>}</span>}
          </div>
          <div id={contentId} className="companion-contact-group-content" hidden={!expanded}>
          {expanded && !count && <p className="companion-contact-group-empty">{kind === 'contacts' ? '暂无伙伴' : '暂无群聊'}</p>}
          {expanded && (kind === 'contacts' ? members.map(item => <div className="companion-contact-entry" key={item.id}>
            <button className={`companions-contact${selectedId === item.id ? ' is-selected' : ''}`} aria-pressed={selectedId === item.id} data-companion-contact={item.id} onClick={() => onSelect(item.id)}><Avatar companion={item} /><span><strong><span className="companions-contact-name">{item.name}</span><CompanionStatusBadge companion={item} showCount /></strong><small>{item.description || '与你一起生活的伙伴'}</small></span></button>{move(item.id, item.name)}
          </div>) : chats.map(item => <div className="companion-contact-entry" key={item.id}>
            <button className="companions-contact" data-companion-contact-group={item.id} onClick={() => onOpenConversation(item)}>{renderConversationAvatar(item)}<span><strong>{item.title}</strong><small>{item.memberIds.length + 1} 位成员</small></span></button>{move(item.id, item.title)}
          </div>))}
          </div>
        </section>;
      })}
      {needle && !(kind === 'contacts' ? contacts.length : rooms.length) && <div className="companions-list-empty">没有找到{kind === 'contacts' ? '相关伙伴' : '相关群聊'}</div>}
    </div>
  </div>;
}
