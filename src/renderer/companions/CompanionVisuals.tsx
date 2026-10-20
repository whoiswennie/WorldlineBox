import type { CSSProperties } from 'react';
import type { Companion } from '../../shared/companions';
import { COMPANION_PRESENCE_LABELS } from '../../shared/companion-presence';
import { COMPANION_APPEARANCE_FILES, COMPANION_PORTRAIT_FILES } from '../../shared/companion-portrait-files';
import './companion-visuals.css';

const portraitUrls = import.meta.glob<string>(['../../../assets/companions/*.{jpg,png}', '../../../assets/companions/portraits/*.{jpg,png}'], { eager: true, query: '?url', import: 'default' });
const appearanceUrls = import.meta.glob<string>('../../../assets/companions/appearance/*.{jpg,png}', { eager: true, query: '?url', import: 'default' });
export const companionImages = Object.fromEntries(Object.entries(COMPANION_PORTRAIT_FILES).map(([avatar, file]) => [avatar, portraitUrls['../../../' + file]])) as Record<Exclude<Companion['avatar'], 'custom'>, string>;
export const companionAppearanceImages = Object.fromEntries(Object.entries(COMPANION_APPEARANCE_FILES).map(([id, file]) => [id, appearanceUrls['../../../' + file]])) as Record<string, string | undefined>;
export function companionPortrait(companion: Pick<Companion, 'avatar' | 'avatarAttachmentId'>): string | undefined {
  return companion.avatarAttachmentId ? `worldlinebox-companion://attachment/${encodeURIComponent(companion.avatarAttachmentId)}`
    : companion.avatar !== 'custom' ? companionImages[companion.avatar] : undefined;
}
export function companionAppearance(companion: Pick<Companion, 'avatar' | 'appearanceAttachmentId'> & Partial<Pick<Companion, 'id' | 'builtin'>>): string | undefined {
  return companion.appearanceAttachmentId ? `worldlinebox-companion://attachment/${encodeURIComponent(companion.appearanceAttachmentId)}`
    : companion.builtin && companion.id ? companionAppearanceImages[companion.id] : undefined;
}

export function Avatar({ companion, large = false, showPresence = true }: { companion?: Pick<Companion, 'name' | 'avatar' | 'avatarAttachmentId'> & Partial<Pick<Companion, 'id' | 'availability' | 'availabilityReason'>>; large?: boolean; showPresence?: boolean }) {
  const localImage = companion?.avatarAttachmentId ? `worldlinebox-companion://attachment/${encodeURIComponent(companion.avatarAttachmentId)}` : undefined;
  const image = companion ? companionPortrait(companion) : undefined;
  const squareImage = !!image;
  const presence = showPresence ? companion?.availability : undefined;
  return <span className={`companion-avatar${large ? ' is-large' : ''}${image ? ' has-image' : ''}${squareImage ? ' has-square-image' : ''}${localImage ? ' has-local-image' : ''}`} aria-hidden="true" title={presence ? COMPANION_PRESENCE_LABELS[presence] + (companion?.availabilityReason ? ' · ' + companion.availabilityReason : '') : undefined} style={image ? { backgroundImage: `url("${image}")` } as CSSProperties : undefined}>{!image && <span className="companion-avatar-letter">{companion?.name.slice(0, 1) || '我'}</span>}{presence && <i className="companion-avatar-presence" data-status={presence} />}</span>;
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
