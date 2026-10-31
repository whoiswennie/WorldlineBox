import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Companion, CompanionConversation, CompanionsRequest } from '../../shared/companions';
import type { CompanionContactGroups } from '../../shared/companion-contact-groups';
import { Icon } from '../Icons';
import { isImeKeyboardEvent } from '../ime-safe-dismiss';
import { createShellPortal } from '../ui/ShellStyleScope';
import { Select } from '../ui/primitives/Select';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { Avatar } from './CompanionVisuals';
import './companion-contact-group-manager.css';

type GroupKind = 'contacts' | 'conversations';
type GroupCommand = Extract<CompanionsRequest, { type: 'contact.groups.create' | 'contact.groups.rename' | 'contact.groups.remove' | 'contact.groups.assign' }>;
export type ContactGroupMutation = GroupCommand extends infer T ? T extends GroupCommand ? Omit<T, 'expectedRevision'> : never : never;

export function CompanionContactGroupManager({ catalogue, companions, conversations, initialKind, busy, loaded, error, onMutate, onClose, renderConversationAvatar }: {
  catalogue: CompanionContactGroups; companions: Companion[]; conversations: CompanionConversation[]; initialKind: GroupKind;
  busy: boolean; loaded: boolean; error: string; onMutate(command: ContactGroupMutation): Promise<boolean>; onClose(): void;
  renderConversationAvatar(room: CompanionConversation): ReactNode;
}) {
  const [kind, setKind] = useState(initialKind), [groupId, setGroupId] = useState('');
  const [query, setQuery] = useState(''), [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [editor, setEditor] = useState<'new' | 'rename'>(), [name, setName] = useState('');
  const [portal] = useState(() => document.createElement('div')), field = useRef<HTMLInputElement>(null), moving = useRef(false);
  useLayoutEffect(() => { document.body.append(portal); return () => portal.remove(); }, [portal]);
  useDialogFocusTrap(true, 'companion-contact-group-manager');
  useEffect(() => { if (editor) field.current?.focus(); }, [editor]);
  const groups = catalogue.groups.filter(group => group.kind === kind), fallback = groups.find(group => group.system)!;
  const group = groups.find(group => group.id === groupId) ?? fallback;
  const targetOf = (id: string) => groups.some(item => item.id === catalogue.assignments[id]) ? catalogue.assignments[id] : fallback.id;
  const items = kind === 'contacts' ? companions.map(item => ({ id: item.id, name: item.name, description: item.description || '与你一起生活的伙伴', avatar: <Avatar companion={item} showPresence={false} /> }))
    : conversations.filter(item => item.kind === 'group').map(item => ({ id: item.id, name: item.title, description: `${item.memberIds.length + 1} 位成员`, avatar: renderConversationAvatar(item) ?? <span className="contact-manager-chat-avatar"><Icon name="users" /></span> }));
  const members = items.filter(item => targetOf(item.id) === group.id), needle = query.trim().toLocaleLowerCase();
  const visible = members.filter(item => `${item.name} ${item.description}`.toLocaleLowerCase().includes(needle));
  const selectedIds = members.filter(item => selected.has(item.id)).map(item => item.id);
  const allSelected = visible.length > 0 && visible.every(item => selected.has(item.id));
  function changeGroup(id: string) { setGroupId(id); setSelected(new Set()); setQuery(''); setEditor(undefined); setName(''); }
  function changeKind(value: GroupKind) { setKind(value); changeGroup(''); }
  async function saveName() {
    if (!name.trim() || busy) return;
    const saved = await onMutate(editor === 'rename' ? { type: 'contact.groups.rename', id: group.id, name: name.trim() }
      : { type: 'contact.groups.create', kind, name: name.trim() });
    if (saved) { setEditor(undefined); setName(''); }
  }
  async function moveTo(target: string) {
    if (moving.current || busy || !selectedIds.length || target === group.id) return;
    moving.current = true;
    try {
      for (let offset = 0; offset < selectedIds.length; offset += 500) {
        if (!await onMutate({ type: 'contact.groups.assign', kind, groupId: target, itemIds: selectedIds.slice(offset, offset + 500) })) {
          setSelected(new Set(selectedIds.slice(offset))); return;
        }
      }
      setSelected(new Set());
    } finally { moving.current = false; }
  }
  return createShellPortal(<div className="contact-manager-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }} onKeyDown={event => {
    if (event.key !== 'Escape' || isImeKeyboardEvent(event.nativeEvent)) return;
    event.stopPropagation(); if (!busy) onClose();
  }}>
    <section className="contact-manager" role="dialog" aria-modal="true" aria-label="联系人管理" aria-describedby="contact-manager-description" aria-busy={busy}>
      <header className="contact-manager-header"><span className="contact-manager-mark"><Icon name="users" /></span><div><h2>联系人管理</h2><p id="contact-manager-description">让每一段关系，都有自己的位置。</p></div><button className="contact-manager-icon" type="button" aria-label="关闭联系人管理" onClick={onClose} disabled={busy}><Icon name="close" /></button></header>
      <div className="contact-manager-type" role="tablist" aria-label="管理联系人类型"><button role="tab" aria-selected={kind === 'contacts'} disabled={busy} onClick={() => changeKind('contacts')}><Icon name="user" />伙伴<span>{companions.length}</span></button><button role="tab" aria-selected={kind === 'conversations'} disabled={busy} onClick={() => changeKind('conversations')}><Icon name="message-circle" />群聊<span>{conversations.filter(item => item.kind === 'group').length}</span></button></div>
      <div className="contact-manager-body">
        <nav className="contact-manager-groups" aria-label="管理分组"><div className="contact-manager-section-label">我的分组<span>{groups.length}</span></div><div className="contact-manager-group-list">{groups.map(item => <button key={item.id} className={item.id === group.id ? 'is-current' : ''} aria-pressed={item.id === group.id} disabled={busy} onClick={() => changeGroup(item.id)}><Icon name="folder" /><span>{item.name}</span><small>{items.filter(member => targetOf(member.id) === item.id).length}</small></button>)}</div><button className="contact-manager-new" type="button" disabled={busy || !loaded} onClick={() => { setEditor('new'); setName(''); }}><Icon name="plus" />新建分组</button></nav>
        <div className="contact-manager-members"><div className="contact-manager-group-title"><div><h3>{group.name}</h3><p>{members.length} {kind === 'contacts' ? '位伙伴' : '个群聊'}{group.system ? ' · 默认分组' : ''}</p></div><button className="contact-manager-icon" type="button" aria-label={`重命名分组${group.name}`} title="重命名分组" disabled={busy || !loaded} onClick={() => { setEditor('rename'); setName(group.name); }}><Icon name="edit" /></button>{!group.system && <button className="contact-manager-icon" type="button" aria-label={`删除分组${group.name}`} title={`删除分组，成员移回${fallback.name}`} disabled={busy || !loaded} onClick={() => void onMutate({ type: 'contact.groups.remove', id: group.id }).then(saved => { if (saved) changeGroup(fallback.id); })}><Icon name="trash" /></button>}</div>
          {editor && <form className="contact-manager-editor" onSubmit={event => { event.preventDefault(); void saveName(); }}><label htmlFor="contact-manager-group-name">{editor === 'new' ? '新分组名称' : '修改分组名称'}</label><div><input id="contact-manager-group-name" ref={field} value={name} maxLength={60} placeholder="给分组起个名字" disabled={busy} onChange={event => setName(event.target.value)} /><button className="contact-manager-primary" disabled={busy || !name.trim()}>{editor === 'new' ? '创建分组' : '保存名称'}</button><button type="button" className="contact-manager-quiet" disabled={busy} onClick={() => setEditor(undefined)}>取消</button></div></form>}
          <label className="contact-manager-search"><Icon name="search" /><input aria-label="搜索分组成员" placeholder={kind === 'contacts' ? '搜索此分组的伙伴' : '搜索此分组的群聊'} value={query} onChange={event => setQuery(event.target.value)} /></label>
          {!!visible.length && <label className="contact-manager-select-all"><input type="checkbox" checked={allSelected} disabled={busy} onChange={() => setSelected(current => { const next = new Set(current); for (const item of visible) { if (allSelected) next.delete(item.id); else next.add(item.id); } return next; })} /><span>全选{needle ? '搜索结果' : ''}</span><small>{visible.length} {kind === 'contacts' ? '位' : '个'}</small></label>}
          <div className="contact-manager-member-list">{visible.length ? visible.map(item => <label className={'contact-manager-member' + (selected.has(item.id) ? ' is-selected' : '')} key={item.id}><input type="checkbox" aria-label={`选择${item.name}`} checked={selected.has(item.id)} disabled={busy} onChange={() => setSelected(current => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} />{item.avatar}<span><strong>{item.name}</strong><small>{item.description}</small></span></label>) : <div className="contact-manager-empty"><Icon name={needle ? 'search' : 'users'} /><strong>{needle ? '没有找到相关成员' : '这个分组还很安静'}</strong><p>{needle ? '试试其他名字或关键词。' : '在其他分组选中成员，即可移动到这里。'}</p></div>}</div>
        </div>
      </div>
      {error && <p className="contact-manager-error" role="alert"><Icon name="alert-circle" />{error}</p>}
      <footer className="contact-manager-footer"><div><strong>{selectedIds.length ? `已选择 ${selectedIds.length} ${kind === 'contacts' ? '位伙伴' : '个群聊'}` : '整理分组，轻松找到彼此'}</strong><p>{selectedIds.length ? '选择目标分组，即可完成移动。' : '删除分组只会将成员移回默认分组。'}</p></div><Select appearance="inline" className="contact-manager-move" aria-label="移动到分组" placeholder="移动到分组" value="" options={groups.filter(item => item.id !== group.id).map(item => ({ value: item.id, label: item.name }))} disabled={busy || !loaded || !selectedIds.length || groups.length < 2} onValueChange={value => void moveTo(value)} layer="modal" /><button className="contact-manager-primary" type="button" disabled={busy} onClick={onClose}>完成</button></footer>
    </section>
  </div>, portal);
}
