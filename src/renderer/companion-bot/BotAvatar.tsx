import { useState } from 'react';
import type { BotCompanion, BotCompanionPresence } from '../../shared/companion-bot';
import { builtinBotCompanion } from '../../shared/builtin-bot-companions';
import { BotPresenceDot } from './BotPresence';

export function botAssetUrl(path: string): string { return new URL(path, document.baseURI).href; }

export function BotPortraitImage({ url, fallback }: { url: string; fallback: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? fallback : <img alt="" src={botAssetUrl(url)} draggable={false} onError={() => setFailed(true)} />;
}

export function BotAvatar({ companion, name, symbol, large = false, presence, locale }: { companion?: BotCompanion; name?: string; symbol?: string; large?: boolean; presence?: BotCompanionPresence; locale?: 'zh-CN' | 'en' }) {
  const portrait = companion && builtinBotCompanion(companion.id)?.portrait;
  const fallback = symbol ?? (companion?.name ?? name ?? '?').slice(0, 1);
  return <span className={`bot-avatar${large ? ' bot-avatar-large' : ''}${portrait ? ' has-portrait' : ''}${presence ? ' has-presence' : ''}`} aria-hidden="true">
    {portrait ? <BotPortraitImage key={portrait.url} url={portrait.url} fallback={fallback} /> : fallback}
    {presence && <BotPresenceDot presence={presence} locale={locale} enabled={companion?.enabled} />}
  </span>;
}
