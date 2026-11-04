import { useEffect, useRef } from 'react';
import { BotAvatar } from './BotAvatar';
import { BotIcon } from './BotIcon';
import type { BotMentionOption } from './bot-mentions';
import './bot-mentions.css';

export function BotMentionPicker({ id, options, active, locale, onSelect, onActive }: {
  id: string; options: readonly BotMentionOption[]; active: number; locale: 'zh-CN' | 'en'; onSelect(option: BotMentionOption): void; onActive(index: number): void;
}) {
  const list = useRef<HTMLDivElement>(null), zh = locale === 'zh-CN';
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [active]);
  return <section className="bot-mention-picker" aria-label={zh ? '选择要提及的成员' : 'Choose someone to mention'}>
    <header><span>{zh ? '提及聊天成员' : 'Mention a member'}</span><small>↑ ↓ Enter</small></header>
    <div ref={list} id={id} role="listbox" aria-label={zh ? '聊天成员' : 'Chat members'}>
      {options.map((option, index) => <button type="button" role="option" tabIndex={-1} key={option.id} id={`${id}-${index}`} aria-selected={index === active}
        onPointerDown={event => event.preventDefault()} onMouseEnter={() => onActive(index)} onClick={() => onSelect(option)}>
        {option.companion ? <BotAvatar companion={option.companion} /> : <span className="bot-mention-all"><BotIcon name="users" /></span>}
        <span><strong>{option.name}</strong><small>{option.companion ? zh ? '当前聊天成员' : 'In this chat' : zh ? '邀请当前聊天的所有伙伴' : 'All companions in this chat'}</small></span>
      </button>)}
      {!options.length && <p role="status">{zh ? '没有匹配的聊天成员' : 'No matching chat members'}</p>}
    </div>
  </section>;
}
