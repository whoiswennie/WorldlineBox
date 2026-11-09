import type { BotCompanion, BotCompanionPresence, BotConversation, BotRequest, BotResponse } from '../../shared/companion-bot';
import { builtinBotCompanion } from '../../shared/builtin-bot-companions';
import { BotAvatar } from './BotAvatar';
import { BotIcon } from './BotIcon';
import { BotPeerAvatar } from './BotPeerAvatar';
import { BotPresenceText } from './BotPresence';
import { BotGroupOverview } from './BotGroupOverview';
import './bot-chat-context.css';

type Locale = 'zh-CN' | 'en';
export function BotChatContext({ conversation, companions, presence, locale, onClose, onEdit, onMemory, onMembers, onContact, onJoinPeer, joiningPeer, request, onChanged }: {
  conversation: BotConversation; companions: readonly BotCompanion[]; presence?: Record<string, BotCompanionPresence>;
  locale: Locale;
  onClose(): void; onEdit(companion: BotCompanion): void; onMemory(): void; onMembers(): void;
  onContact?(companionId: string): void; request?(input: BotRequest): Promise<BotResponse>; onChanged?(): void;
  onJoinPeer?(): void; joiningPeer?: boolean;
}) {
  const zh = locale === 'zh-CN', direct = conversation.kind === 'direct', person = direct ? companions[0] : undefined;
  const builtin = person ? builtinBotCompanion(person.id) : undefined;
  if (conversation.kind === 'peer') return <aside className="bot-chat-context" aria-label={zh ? '聊天信息' : 'Chat information'}>
    <header><span><BotIcon name="profile" />{zh ? '伙伴私聊' : 'Companion conversation'}</span><button type="button" onClick={onClose} aria-expanded="true" aria-label={zh ? '收起聊天信息' : 'Hide chat information'}><BotIcon name="panel-collapse" /></button></header>
    <section className="bot-context-group"><div className="bot-context-person"><BotPeerAvatar companions={companions} /><div><h3>{conversation.title}</h3><p>{zh ? '两位伙伴的真实私聊 · 你正在旁观' : 'A direct conversation between two companions · Observing'}</p></div></div></section>
    <section className="bot-context-peer-members"><h3>{zh ? '私聊双方' : 'Participants'}</h3><p>{zh ? '消息由双方各自的主脑发送。旁观不会把你加入私聊，也不会转入你的其他聊天记录。' : 'Each companion speaks through its own agent. Observing does not add you or transfer your other conversations.'}</p><ul>{companions.map(member => <li key={member.id}><button type="button" onClick={() => onContact?.(member.id)} title={zh ? `与${member.name}私聊` : `Chat with ${member.name}`}><BotAvatar companion={member} presence={presence?.[member.id]} locale={locale} /><span><strong>{member.name}</strong>{presence?.[member.id] && <BotPresenceText presence={presence[member.id]!} locale={locale} />}</span></button></li>)}</ul>
      {onJoinPeer && <button className="bot-context-peer-join" type="button" disabled={joiningPeer} onClick={onJoinPeer}>{zh ? '创建群聊，一起参与' : 'Create a group to participate'}</button>}
    </section>
  </aside>;
  return <aside className="bot-chat-context" aria-label={zh ? '聊天信息' : 'Chat information'}>
    <header><span><BotIcon name="profile" />{zh ? '聊天摘要' : 'Chat summary'}</span><button type="button" onClick={onClose} aria-expanded="true" aria-label={zh ? '收起聊天信息' : 'Hide chat information'} title={zh ? '收起侧栏' : 'Collapse sidebar'}><BotIcon name="panel-collapse" /></button></header>
    {person ? <section className="bot-context-profile"><div className="bot-context-person"><BotAvatar companion={person} /><div><h3>{person.name}</h3>{presence?.[person.id] && <BotPresenceText presence={presence[person.id]!} locale={locale} />}</div></div>
      {builtin?.summary && <p>{builtin.summary}</p>}
      <div className="bot-context-actions"><button type="button" onClick={() => onEdit(person)}><BotIcon name="profile" />{zh ? '角色卡' : 'Character card'}</button><button type="button" onClick={onMemory}><BotIcon name="memory" />{zh ? '共同记忆' : 'Memories'}</button></div></section>
      : <section className="bot-context-group"><div className="bot-context-person"><BotPeerAvatar companions={companions} /><div><h3>{conversation.title}</h3><p>{zh ? `${conversation.memberIds.length} 位成员${conversation.kind === 'group' ? ' · 你是群主' : ''}` : `${conversation.memberIds.length} members${conversation.kind === 'group' ? ' · You own this group' : ''}`}</p></div></div><button type="button" onClick={conversation.kind === 'group' ? onMembers : onMemory}><BotIcon name={conversation.kind === 'group' ? 'users' : 'memory'} />{conversation.kind === 'group' ? zh ? '管理群成员' : 'Manage members' : zh ? '查看共同记忆' : 'Shared memories'}</button></section>}
    {conversation.kind === 'group' && <BotGroupOverview conversation={conversation} companions={companions} presence={presence} locale={locale} request={request} onChanged={onChanged} onMembers={onMembers} onContact={onContact} />}
  </aside>;
}
