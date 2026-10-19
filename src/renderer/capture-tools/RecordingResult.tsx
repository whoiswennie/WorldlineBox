import { useEffect, useState } from 'react';
import type { WorldlineBoxCaptureToolsApi } from '../../shared/capture-tools';
import { Icon } from '../Icons';
import { Button } from '../ui';
import { useCaptureWords } from './messages';
import { recordingClock } from './recording-media';

type Preview = { url: string; mimeType: string; name: string; bytes: number };

/** Review the saved file itself. Desktop-source thumbnails are never results. */
export function RecordingResult({ api, id, path, elapsed, status, error, notice, onAgain, onClose }: {
  api: WorldlineBoxCaptureToolsApi; id: string; path: string; elapsed: number;
  status: 'saved' | 'failed' | 'cancelled'; error: string; notice: string; onAgain(): void; onClose(): void;
}) {
  const words = useCaptureWords();
  const [preview, setPreview] = useState<Preview>();
  const [loading, setLoading] = useState(Boolean(path));
  const [playbackError, setPlaybackError] = useState('');
  const [actionError, setActionError] = useState('');
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>();
  const [duration, setDuration] = useState(elapsed);
  const [originalSize, setOriginalSize] = useState(false);
  const [opening, setOpening] = useState(false);
  const [pixelRatio, setPixelRatio] = useState(() => window.devicePixelRatio || 1);
  const previewFailure = words.recordingPreviewFailed;
  useEffect(() => {
    const resize = () => setPixelRatio(window.devicePixelRatio || 1);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!id || !path) return;
    let current = true;
    void api.request({ type: 'recording.preview', id }).then(result => {
      if (!current) return;
      if (!result.ok || !result.preview) { setPlaybackError(result.ok ? previewFailure : result.error); return; }
      setPreview(result.preview);
    }).catch(() => { if (current) setPlaybackError(previewFailure); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, id, path, previewFailure]);
  async function openPlayer() {
    setOpening(true); setActionError('');
    try { const result = await api.request({ type: 'recording.open', id }); if (!result.ok) setActionError(result.error); }
    catch { setActionError(words.failed); }
    finally { setOpening(false); }
  }
  const filename = preview?.name || path.split(/[\\/]/u).at(-1) || words.recording;
  const gif = preview?.mimeType === 'image/gif';
  const label = status === 'saved' ? words.recordingSaved : status === 'failed' ? words.recordingFailed : words.recordingCancelled;
  const bytes = preview?.bytes;
  const size = bytes === undefined ? '' : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  // Screen recordings carry physical pixels. Account for OS display scaling so
  // 100% really maps one recorded pixel to one screen pixel, including at 150%.
  const mediaStyle = dimensions ? originalSize ? { width: dimensions.width / pixelRatio, height: dimensions.height / pixelRatio }
    : { maxWidth: dimensions.width / pixelRatio, maxHeight: dimensions.height / pixelRatio } : undefined;
  return <main className="capture-tools-window capture-recorder capture-recording-result" data-capture-recorder>
    <header>
      <div className="capture-result-heading"><span className="capture-result-icon"><Icon name={gif ? 'camera' : 'video'} size={20} /></span><div>
        <div className={'capture-recording-status is-' + status} role="status"><span /><strong>{label}</strong></div>
        {path ? <h1 title={path}>{filename}</h1> : null}
      </div></div>
      <div className="capture-result-actions">
        {path ? <Button iconName="folder" variant="quiet" aria-label={words.reveal} title={words.reveal} onClick={() => { setActionError(''); void api.request({ type: 'reveal', path }).then(result => { if (!result.ok) setActionError(result.error); }).catch(() => setActionError(words.failed)); }} /> : null}
        <Button iconName="video" variant="quiet" aria-label={words.recordAgain} title={words.recordAgain} onClick={onAgain}>{words.recordAgain}</Button>
        <Button iconName="close" variant="quiet" aria-label={words.close} title={words.close} onClick={onClose} />
      </div>
    </header>
    <section className={'capture-result-stage' + (originalSize ? ' is-original-size' : '')} aria-label={words.recordingPreview}>
      {preview && !playbackError ? gif ? <img src={preview.url} style={mediaStyle} alt={words.recordingPreview} onLoad={event => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setPlaybackError(previewFailure)} />
        : <video src={preview.url} style={mediaStyle} controls preload="auto" playsInline aria-label={words.recordingPreview}
          onLoadedMetadata={event => { const player = event.currentTarget; setDimensions({ width: player.videoWidth, height: player.videoHeight }); if (Number.isFinite(player.duration)) setDuration(player.duration * 1000); }}
          onDurationChange={event => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration * 1000); }}
          onError={() => setPlaybackError(previewFailure)} />
        : <div className="capture-result-placeholder"><Icon name={playbackError ? 'warning' : 'video'} size={32} /><p role={playbackError ? 'alert' : 'status'}>{playbackError || (loading ? words.recordingPreviewLoading : label)}</p>
          {path && !loading ? <Button iconName="external-link" variant="quiet" loading={opening} onClick={() => void openPlayer()}>{words.recordingOpenPlayer}</Button> : null}
        </div>}
    </section>
    {error || notice || actionError ? <div className="capture-result-notice" role={error || actionError ? 'alert' : 'status'}><Icon name={error || actionError ? 'warning' : 'info'} size={15} /><span>{[error, notice, actionError].filter(Boolean).join(' ')}</span></div> : null}
    <footer>
      <div className="capture-result-metadata" aria-label={words.recordingDetails}>
        <span>{preview ? gif ? 'GIF' : preview.mimeType === 'video/mp4' ? 'MP4' : 'WebM' : ''}</span>
        {dimensions ? <span>{dimensions.width} × {dimensions.height}</span> : null}
        {path ? <time aria-label={words.elapsed}>{recordingClock(duration)}</time> : null}
        {size ? <span>{size}</span> : null}
      </div>
      <div className="capture-result-actions">
        {preview && !playbackError ? <Button iconName={originalSize ? 'fit-window' : 'fullscreen'} variant="quiet" size="sm" aria-label={originalSize ? words.recordingFit : words.recordingActualSize} title={originalSize ? words.recordingFit : words.recordingActualSize} aria-pressed={originalSize} onClick={() => setOriginalSize(value => !value)}>{originalSize ? words.recordingFit : '100%'}</Button> : null}
        {path ? <Button iconName="external-link" variant="quiet" size="sm" aria-label={words.recordingOpenPlayer} title={words.recordingOpenPlayer} loading={opening} onClick={() => void openPlayer()} /> : null}
      </div>
    </footer>
  </main>;
}
