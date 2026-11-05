import { useCallback, useRef, useState } from 'react';
import type { BotMediaRef, WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { BotIcon } from './BotIcon';
import { BotMediaPreview } from './BotMediaPreview';
import { formatBotFileSize } from './media-presentation';
import { botAttachmentDetails, type BotAttachmentKind } from './attachment-presentation';
import './bot-attachment.css';
import { BotVoiceMessage } from './BotVoiceMessage';
export { formatBotFileSize } from './media-presentation';

export interface BotAttachmentProps { media: BotMediaRef; api?: WorldlineBoxBotMediaApi; conversationId: string; locale: 'zh-CN' | 'en'; onOpenUrl?(url: string): void; variant?: 'row' | 'tile' | 'list' }
export function AttachmentKindIcon({ kind }: { kind: BotAttachmentKind | 'bundle' }) {
  const paths = { image: 'M3 5h18v14H3zM3 15l5-5 5 5 3-3 5 5M15 9h.01', video: 'M3 5h18v14H3zM10 9l6 3-6 3z',
    audio: 'M9 18V5l12-2v13M9 8l12-2M9 18a3 3 0 1 1-3-3c2 0 3 1 3 3M21 16a3 3 0 1 1-3-3c2 0 3 1 3 3',
    text: 'M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6', file: 'M5 3h10l4 4v14H5zM14 3v5h5', bundle: 'M3 7V5h6l2 2h10v13H3zM3 10h18' };
  return <svg className="bot-attachment-kind-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}
export function BotAttachment({ media, api, conversationId, locale, onOpenUrl, variant = 'row' }: BotAttachmentProps) {
  const zh = locale === 'zh-CN', [preview, setPreview] = useState(false), [saving, setSaving] = useState(false), [opening, setOpening] = useState(false), [error, setError] = useState(''), [thumbnailFailed, setThumbnailFailed] = useState(false);
  const { name, kind, canPreview, policy, extension, imageUrl } = botAttachmentDetails(media, !!api);
  const eligibility = policy.previewEligibility;
  const player = useRef<HTMLMediaElement | null>(null), [playbackFailed, setPlaybackFailed] = useState(false);
  const assignPlayer=useCallback((element:HTMLMediaElement|null)=>{if(player.current&&player.current!==element)player.current.pause();player.current=element;},[]);
  const inline = variant === 'row' && media.kind !== 'sticker' && eligibility === 'inline' && ['image', 'audio', 'video'].includes(kind);
  const openPreview = () => { player.current?.pause(); setPreview(true); };
  const play = (current: HTMLMediaElement) => { for (const other of document.querySelectorAll<HTMLMediaElement>('[data-bot-attachment-player]')) if (other !== current) other.pause(); };
  const closePreview = useCallback(() => setPreview(false), []);
  const tile = variant === 'tile', sticker = variant === 'row' && media.kind === 'sticker' && kind === 'image' && eligibility === 'inline';
  const typeLabel = kind === 'image' ? zh ? '图片' : 'Image' : kind === 'video' ? zh ? '视频' : 'Video' : kind === 'audio' ? zh ? '音频' : 'Audio' : extension;
  // Opening an original, AV stream or text page requires an explicit click.
  const thumbnail = canPreview && kind === 'image' && !thumbnailFailed ? media.previewUrl : undefined;
  const automaticStickerUrl = media.size <= 4 * 1024 * 1024 ? imageUrl : thumbnail;
  const perform = async (operation: 'attachment.save' | 'attachment.open') => {
    if (!api || saving || opening) return;
    if (operation === 'attachment.save') setSaving(true); else setOpening(true);
    setError('');
    try { const result = await api.request({ type: operation, conversationId, id: media.id }); if (!result.ok) setError(result.error ?? (zh ? '操作失败，请重试。' : 'The operation failed. Try again.')); }
    catch { setError(zh ? '操作失败，请重试。' : 'The operation failed. Try again.'); } finally { setSaving(false); setOpening(false); }
  };
  return <div className={`bot-attachment ${sticker ? 'is-sticker' : tile ? 'bot-attachment-tile' : 'bot-attachment-card'}${inline ? ' has-inline-preview' : ''}`} data-media-kind={kind}>
    {sticker ? <button className="bot-attachment-image" type="button" title={media.name} aria-label={zh ? `预览 ${media.name}` : `Preview ${media.name}`} onClick={() => setPreview(true)}>{automaticStickerUrl ? <img alt={media.name} src={automaticStickerUrl} loading="lazy" draggable={false} /> : <span className="bot-sticker-open-original"><AttachmentKindIcon kind="image" /><small>{zh ? '点击查看表情' : 'Open sticker'}</small></span>}</button>
      : <><button className="bot-attachment-main" type="button" title={name} disabled={saving || opening || !canPreview && !api} aria-label={zh ? `${canPreview ? '打开预览' : '系统打开'} ${name}` : `${canPreview ? 'Preview' : 'Open'} ${name}`} onClick={() => { setError(''); if (canPreview) openPreview(); else void perform('attachment.open'); }}>
        <span className="bot-attachment-cover">{thumbnail ? <img alt="" src={thumbnail} loading="lazy" onError={() => setThumbnailFailed(true)} /> : <><AttachmentKindIcon kind={kind} /><small>{kind === 'audio' ? 'AUDIO' : kind === 'video' ? 'VIDEO' : extension}</small></>}</span>
        <span className="bot-attachment-meta"><strong title={name}>{name}</strong><span>{typeLabel} · {formatBotFileSize(media.size)}</span>{eligibility === 'external-only' && <em>{zh ? '超过 200 MiB · 系统打开' : 'Over 200 MiB · System app'}</em>}</span>
        {!tile && <span className="bot-attachment-open-hint">{canPreview ? zh ? '预览' : 'Preview' : zh ? '打开' : 'Open'}<BotIcon name="chevron-right" /></span>}
      </button>{!tile && <footer className="bot-attachment-actions">{api && <><button className="bot-file-save" type="button" disabled={saving || opening} title={zh ? '保存' : 'Save'} aria-label={`${zh ? '保存' : 'Save'} ${name}`} onClick={() => void perform('attachment.save')}><BotIcon name="download" /><span className="bot-attachment-action-label">{zh ? '保存' : 'Save'}</span></button><button className="bot-file-open" type="button" disabled={saving || opening} title={zh ? '系统打开' : 'System app'} aria-label={`${zh ? '系统打开' : 'System app'} ${name}`} onClick={() => void perform('attachment.open')}><BotIcon name="external" /><span className="bot-attachment-action-label">{zh ? '系统打开' : 'System app'}</span></button></>}</footer>}</>}
    {inline && <div className="bot-attachment-inline-preview">
      {kind === 'image' && thumbnail && <button type="button" className="bot-attachment-inline-picture" aria-label={zh ? `放大查看 ${name}` : `Enlarge ${name}`} onClick={openPreview}><img src={thumbnail} alt={name} loading="lazy" onError={() => setThumbnailFailed(true)} /></button>}
      {kind === 'video' && !playbackFailed && !preview && <video ref={assignPlayer} data-bot-attachment-player controls playsInline preload="none" src={media.url} aria-label={name} onPlay={event => play(event.currentTarget)} onError={() => setPlaybackFailed(true)} />}
      {kind === 'audio' && !playbackFailed && !preview && <audio ref={assignPlayer} data-bot-attachment-player controls preload="none" src={media.url} aria-label={name} onPlay={event => play(event.currentTarget)} onError={() => setPlaybackFailed(true)} />}
      {playbackFailed && <small role="status">{zh ? '此格式无法直接播放，可用系统应用打开。' : 'Use your system app to play this format.'}</small>}
      <button type="button" className="bot-attachment-enlarge" onClick={openPreview}>{zh ? '大窗查看' : 'Open viewer'}<BotIcon name="external" /></button>
    </div>}
    {error && !preview && <small className="bot-attachment-action-error" role="alert">{error}</small>}
    {kind === 'audio' && eligibility === 'inline' && variant === 'row' && <BotVoiceMessage media={media} conversationId={conversationId} locale={locale} transcriptOnly />}
    {preview && kind !== 'file' && <BotMediaPreview media={media} api={api} conversationId={conversationId} locale={locale} kind={kind} imageUrl={imageUrl} onClose={closePreview} onOpenUrl={onOpenUrl} busy={saving || opening} actionError={error} onSave={api ? () => perform('attachment.save') : undefined} onSystemOpen={api ? () => perform('attachment.open') : undefined} />}
  </div>;
}
