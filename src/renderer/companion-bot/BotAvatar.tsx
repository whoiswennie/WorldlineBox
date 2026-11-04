import type { BotCompanion, BotCompanionPresence } from '../../shared/companion-bot';
import { builtinBotCompanion } from '../../shared/builtin-bot-companions';
import { BotPresenceDot } from './BotPresence';

export function botAssetUrl(path: string): string { return new URL(path, document.baseURI).href; }

export function BotAvatar({ companion, name, symbol, large = false, presence, locale }: { companion?: BotCompanion; name?: string; symbol?: string; large?: boolean; presence?: BotCompanionPresence; locale?: 'zh-CN' | 'en' }) {
  const portrait = companion && builtinBotCompanion(companion.id)?.portrait;
  return <span className={`bot-avatar${large ? ' bot-avatar-large' : ''}${portrait ? ' has-portrait' : ''}${presence ? ' has-presence' : ''}`} aria-hidden="true">
    {portrait ? <img alt="" src={botAssetUrl(portrait.url)} draggable={false} /> : symbol ?? (companion?.name ?? name ?? '?').slice(0, 1)}
    {presence && <BotPresenceDot presence={presence} locale={locale} />}
  </span>;
}
