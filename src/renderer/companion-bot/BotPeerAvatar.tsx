import type { BotCompanion, BotCompanionPresence } from '../../shared/companion-bot';
import { botAssetUrl } from './BotAvatar';
import { builtinBotCompanion } from '../../shared/builtin-bot-companions';
import './bot-peer-avatar.css';

export function BotPeerAvatar({ companions, presence, locale }: { companions: readonly BotCompanion[]; presence?: Record<string, BotCompanionPresence>; locale?: 'zh-CN' | 'en' }) {
  // A group has one portrait, not a stack of independent online badges. Keep
  // the first nine members visible even when the room has more participants.
  const visible = companions.slice(0, 9);
  const busy = companions.filter(person => (presence?.[person.id]?.counts.activeTasks ?? 0) > 0).length;
  return <span className="bot-peer-avatar bot-group-collage" data-count={visible.length} aria-hidden="true"
    title={companions.map(person => person.name).join('、') + (busy ? locale === 'en' ? ` · ${busy} working` : ` · ${busy} 位伙伴有任务` : '')}>
    {visible.map(person => { const portrait = builtinBotCompanion(person.id)?.portrait; return <span className="bot-group-portrait" key={person.id} data-companion-id={person.id}>
      {portrait ? <img alt="" src={botAssetUrl(portrait.url)} draggable={false} /> : person.name.slice(0, 1)}
    </span>; })}
  </span>;
}
