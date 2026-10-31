import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CompanionAttachment } from '../../shared/companions';
import { Icon } from '../Icons';
import { companionAttachmentCoverSource } from './companion-attachment-presentation';

// One actual media element, moved between an inline card and the app-level
// dock. Switching routes never replaces its decoder or playback position.
type Playback = { attachment: CompanionAttachment; ownerId?: string; conversationId?: string; element: HTMLMediaElement; inline: boolean; failed: boolean };
let current: Playback | undefined;
let dock: HTMLElement | null = null;
const anchors = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => current;
function relocate() {
  if (!current) return;
  const target = anchors.get(current.attachment.id), container = target ?? dock;
  if (container && current.element.parentElement !== container) container.append(current.element);
  const inline = !!target;
  if (inline !== current.inline) { current = { ...current, inline }; notify(); }
}
export function stopCompanionMedia(scope?: { ownerId: string; conversationIds: ReadonlySet<string> }) {
  if (!current) return;
  if (scope && current.ownerId !== scope.ownerId && !scope.conversationIds.has(current.conversationId ?? '')) return;
  current.element.pause(); current.element.removeAttribute('src'); current.element.load(); current.element.remove(); current = undefined; notify();
}
export function stopCompanionMediaAttachments(ids: ReadonlySet<string>) { if (current && ids.has(current.attachment.id)) stopCompanionMedia(); }
export function playCompanionMedia(attachment: CompanionAttachment, scope?: { ownerId?: string; conversationId?: string }) {
  if (current?.attachment.id !== attachment.id) {
    stopCompanionMedia();
    const element = document.createElement(attachment.mime.startsWith('video/') ? 'video' : 'audio');
    element.controls = true; element.preload = 'metadata'; element.setAttribute('aria-label', '播放' + (attachment.mime.startsWith('video/') ? '视频：' : '音频：') + attachment.name);
    if (element instanceof HTMLVideoElement) { element.playsInline = true; element.poster = companionAttachmentCoverSource(attachment); }
    element.src = attachment.url || `worldlinebox-companion://attachment/${encodeURIComponent(attachment.id)}`;
    current = { attachment, ...scope, element, inline: false, failed: false };
    element.addEventListener('error', () => { if (current?.element === element) { current = { ...current, failed: true }; notify(); } });
    relocate(); notify();
  }
  void current!.element.play().catch(() => { /* Native controls remain available after autoplay rejection. */ });
}
export function CompanionInlineMedia({ attachment, ownerId, conversationId }: { attachment: CompanionAttachment; ownerId?: string; conversationId?: string }) {
  const playback = useSyncExternalStore(subscribe, snapshot), anchor = useRef<HTMLDivElement>(null);
  const [failedPoster, setFailedPoster] = useState<string>();
  const video = attachment.mime.startsWith('video/'), poster = companionAttachmentCoverSource(attachment);
  useEffect(() => {
    const target = anchor.current!; anchors.set(attachment.id, target); relocate();
    return () => { if (anchors.get(attachment.id) === target) anchors.delete(attachment.id); relocate(); };
  }, [attachment.id]);
  const selected = playback?.attachment.id === attachment.id;
  return <><div ref={anchor} className="companions-media-surface" />{!selected && <button type="button" className={`companions-media-play${video && failedPoster !== poster ? ' has-poster' : ''}`} aria-label={'播放：' + attachment.name} onClick={() => playCompanionMedia(attachment, { ownerId, conversationId })}>{video && failedPoster !== poster && <img loading="lazy" decoding="async" className="companions-media-poster" src={poster} alt="" onError={() => setFailedPoster(poster)} />}<span><Icon name="play" size={20} />播放{video ? '视频' : '音频'}</span></button>}{selected && playback.failed && <p role="status">此格式无法在内置播放器解码，请使用系统应用打开。</p>}</>;
}
export function CompanionMediaPlayer() {
  const playback = useSyncExternalStore(subscribe, snapshot), target = useRef<HTMLDivElement>(null);
  useEffect(() => { dock = target.current; relocate(); return () => { dock = null; stopCompanionMedia(); }; }, []);
  return <section className="companions-media-dock" hidden={!playback || playback.inline} aria-label="聊天媒体播放器"><header><Icon name="music" size={16} /><strong>{playback?.attachment.name}</strong><button type="button" aria-label="关闭聊天播放器" onClick={() => stopCompanionMedia()}><Icon name="close" size={15} /></button></header><div ref={target} />{playback?.failed && <p>媒体暂时无法播放。</p>}</section>;
}
