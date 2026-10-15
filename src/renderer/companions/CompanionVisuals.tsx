import type { CSSProperties } from 'react';
import type { Companion } from '../../shared/companions';
import { COMPANION_PRESENCE_LABELS } from '../../shared/companion-presence';
import sisterImage from '../../../assets/companions/deepseek-sister.jpg';
import flashImage from '../../../assets/companions/deepseek-flash.jpg';
import whiteImage from '../../../assets/companions/portraits/huan-white-v1.png';
import blackImage from '../../../assets/companions/portraits/huan-black-v1.png';
import geminiImage from '../../../assets/companions/portraits/gemini-v2.png';
import gptImage from '../../../assets/companions/portraits/gpt-v2.png';
import grokImage from '../../../assets/companions/portraits/grok-v1.png';
import kimiImage from '../../../assets/companions/portraits/kimi-v1.png';
import minimaxImage from '../../../assets/companions/portraits/minimax-v2.png';
import qwenImage from '../../../assets/companions/portraits/qwen-v2.png';
import gugugagaImage from '../../../assets/companions/portraits/gugugaga-v1.png';
import gugaImage from '../../../assets/companions/portraits/guga-v1.png';
import doroImage from '../../../assets/companions/portraits/doro-v1.png';
import phoebeImage from '../../../assets/companions/portraits/phoebe-v1.png';
import phrolovaImage from '../../../assets/companions/portraits/phrolova-v1.png';
import './companion-visuals.css';

export const companionImages: Record<Exclude<Companion['avatar'], 'custom'>, string> = {
  sister: sisterImage, flash: flashImage, 'huan-white': whiteImage, 'huan-black': blackImage,
  gemini: geminiImage, gpt: gptImage, grok: grokImage, kimi: kimiImage, minimax: minimaxImage, qwen: qwenImage,
  gugugaga: gugugagaImage, guga: gugaImage, doro: doroImage, phoebe: phoebeImage, phrolova: phrolovaImage,
};
export function companionPortrait(companion: Pick<Companion, 'avatar' | 'avatarAttachmentId'>): string | undefined {
  return companion.avatarAttachmentId ? `worldlinebox-companion://attachment/${encodeURIComponent(companion.avatarAttachmentId)}`
    : companion.avatar !== 'custom' ? companionImages[companion.avatar] : undefined;
}

export function Avatar({ companion, large = false, showPresence = true }: { companion?: Pick<Companion, 'name' | 'avatar' | 'avatarAttachmentId'> & Partial<Pick<Companion, 'availability' | 'availabilityReason'>>; large?: boolean; showPresence?: boolean }) {
  const localImage = companion?.avatarAttachmentId ? `worldlinebox-companion://attachment/${encodeURIComponent(companion.avatarAttachmentId)}` : undefined;
  const image = companion ? companionPortrait(companion) : undefined;
  const squareImage = localImage || (image && companion?.avatar !== 'sister' && companion?.avatar !== 'flash');
  const presence = showPresence ? companion?.availability : undefined;
  return <span className={`companion-avatar${large ? ' is-large' : ''}${image ? ' has-image' : ''}${squareImage ? ' has-square-image' : ''}${localImage ? ' has-local-image' : ''}`} aria-hidden="true" title={presence ? COMPANION_PRESENCE_LABELS[presence] + (companion?.availabilityReason ? ' · ' + companion.availabilityReason : '') : undefined} style={image ? { backgroundImage: `url("${image}")` } as CSSProperties : undefined}>{image ? '' : companion?.name.slice(0, 1) || '我'}{presence && <i className="companion-avatar-presence" data-status={presence} />}</span>;
}

export function ChatGlyph({ name }: { name: 'chat' | 'contacts' | 'smile' | 'attach' | 'image' | 'reply' | 'send' | 'group' | 'pin' | 'bell' | 'more' }) {
  const paths = {
    chat: <><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H7l-4 2v-5.5A8.5 8.5 0 1 1 21 11.5Z" /><path d="M8 11h.01M12 11h.01M16 11h.01" /></>,
    contacts: <><circle cx="12" cy="7" r="4" /><path d="M4 21v-3a8 8 0 0 1 16 0v3Z" /></>,
    smile: <><circle cx="12" cy="12" r="9" /><path d="M8 14s1.5 3 4 3 4-3 4-3M8 9h.01M16 9h.01" /></>,
    attach: <path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L12 3a2 2 0 0 1 3 3L5 16" />,
    image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m4 17 5-5 4 4 3-3 5 5" /></>,
    reply: <><path d="m9 5-6 6 6 6M3 11h11a6 6 0 0 1 6 6v3" /></>,
    send: <><path d="m6 10 6-6 6 6M12 4v16" /></>,
    group: <><circle cx="9" cy="7" r="3" /><path d="M2 20v-2a7 7 0 0 1 14 0v2M17 4a3 3 0 0 1 0 6M19 14a5 5 0 0 1 3 4v2" /></>,
    pin: <><path d="m14 3 7 7-4 1-4 5-2-2-7 7M14 3l-1 4-5 4 5 5" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
    more: <><circle cx="5" cy="12" r=".8" /><circle cx="12" cy="12" r=".8" /><circle cx="19" cy="12" r=".8" /></>,
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
