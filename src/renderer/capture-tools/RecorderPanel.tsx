import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { CAPTURE_GIF_LIMIT_SECONDS, CAPTURE_VIDEO_LIMIT_SECONDS, type CaptureDesktopSource, type CaptureImageSource, type CaptureToolsSettings, type CaptureToolsState, type WorldlineBoxCaptureToolsApi } from '../../shared/capture-tools';
import { Icon } from '../Icons';
import { Button, Select } from '../ui';
import { RecordingRegionPicker } from './RecordingRegionPicker';
import { useCaptureWords } from './messages';
import { desktopRecordingMedia, recordingBitrate, recordingClock, recordingMimeType, recordingOutputSize, type CaptureRegion } from './recording-media';
import type { Rect } from '../browser/screenshot/model';
import { DesktopScreenshotOverlay } from './DesktopScreenshotOverlay';
import { RecordingResult } from './RecordingResult';

type Phase = 'idle' | 'preparing' | 'recording' | 'paused' | 'finalizing' | 'saved' | 'failed' | 'cancelled';
type Session = {
  id: string; recorder: MediaRecorder; cleanup(): void; queue: Promise<void>; sequence: number; started: number;
  pausedAt?: number; pausedTotal: number; cancelled: boolean; queuedBytes: number; failed?: Error;
  done: Promise<void>; settle(): void;
  finalizing: boolean;
  setSystemAudioEnabled?(enabled: boolean): void; setMicrophoneEnabled?(enabled: boolean): void;
};

export function RecorderPanel({ api, state, onClose, source: desktopSource, onSourceChange }: { api: WorldlineBoxCaptureToolsApi; state: CaptureToolsState; onClose(): void; source?: CaptureImageSource; onSourceChange?(source: CaptureImageSource): void }) {
  const words = useCaptureWords();
  const [sources, setSources] = useState<CaptureDesktopSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [options, setOptions] = useState<CaptureToolsSettings>(state.settings);
  const [regionEnabled, setRegionEnabled] = useState(false);
  const [region, setRegion] = useState<CaptureRegion>({ x: 0, y: 0, width: 1, height: 1 });
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [savedPath, setSavedPath] = useState('');
  const [recordingId, setRecordingId] = useState('');
  const [capturedAudio, setCapturedAudio] = useState({ system: false, microphone: false });
  const [enabledAudio, setEnabledAudio] = useState({ system: false, microphone: false });
  const [loadingSources, setLoadingSources] = useState(false);
  const [capturingSource, setCapturingSource] = useState(false);
  const [selectedRect, setSelectedRect] = useState<Rect>();
  const [overlayRevision, setOverlayRevision] = useState(0);
  const [controlsPrepared, setControlsPrepared] = useState(false);
  const [awaitingMedia, setAwaitingMedia] = useState(false);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const session = useRef<Session | undefined>(undefined);
  const alive = useRef(true);
  const preparing = useRef<{ aborted: boolean; id?: string } | undefined>(undefined);
  const source = sources.find(item => item.id === sourceId);
  const active = phase === 'recording' || phase === 'paused';
  const locked = active || phase === 'preparing' || phase === 'finalizing' || awaitingMedia;
  const revealPath = phase === 'failed' && state.recording?.id === recordingId && state.recording.path ? state.recording.path : savedPath;

  async function loadSources() {
    setLoadingSources(true); setError('');
    try {
      const result = await api.request({ type: 'sources.list' });
      if (!alive.current) return;
      if (!result.ok) { setError(result.error); return; }
      const next = result.sources ?? []; setSources(next);
      setSourceId(previous => next.some(item => item.id === previous) ? previous : next.find(item => item.kind === 'screen' && item.displayId === desktopSource?.desktop?.displayId)?.id ?? next[0]?.id ?? '');
    } catch { if (alive.current) setError(words.failed); }
    finally { if (alive.current) setLoadingSources(false); }
  }
  const initialLoad = useEffectEvent(loadSources);
  useEffect(() => {
    alive.current = true; queueMicrotask(() => { if (alive.current) void initialLoad(); });
    return () => {
      alive.current = false;
      if (preparing.current) preparing.current.aborted = true;
      const running = session.current;
      if (running && !running.finalizing) {
        running.cancelled = true; running.cleanup();
        if (running.recorder.state !== 'inactive') running.recorder.stop();
        void api.request({ type: 'recording.cancel', id: running.id }).catch(() => undefined);
      }
    };
  }, [api]);

  function elapsedTime(running: Session) {
    return (running.pausedAt ?? performance.now()) - running.started - running.pausedTotal;
  }
  function stop() {
    const running = session.current;
    if (!running) {
      const pending = preparing.current;
      if (pending) {
        pending.aborted = true;
        if (pending.id) void api.request({ type: 'recording.cancel', id: pending.id }).catch(() => undefined);
        if (alive.current) { setPhase('cancelled'); setNotice(words.recordingCancelled); }
      }
      return;
    }
    if (running.recorder.state === 'inactive') return;
    if (alive.current) setPhase('finalizing');
    running.recorder.stop();
  }
  const stopFromShortcut = useEffectEvent(stop);
  useEffect(() => api.onStopRecording(() => stopFromShortcut()), [api]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const running = session.current; if (!running) return;
      const duration = elapsedTime(running); setElapsed(duration);
      if (duration >= (options.format === 'gif' ? CAPTURE_GIF_LIMIT_SECONDS : CAPTURE_VIDEO_LIMIT_SECONDS) * 1000) stopFromShortcut();
    }, 250);
    return () => clearInterval(timer);
  }, [active, options.format]);

  async function finish(running: Session) {
    running.finalizing = true;
    let submittedFinish = false;
    try {
      running.cleanup();
      await running.queue;
      if (running.failed && !running.cancelled) throw running.failed;
      if (running.cancelled) {
        await api.request({ type: 'recording.cancel', id: running.id });
        if (alive.current) setPhase('cancelled');
      } else {
        submittedFinish = true;
        const result = await api.request({ type: 'recording.finish', id: running.id });
        if (!result.ok) throw Error(result.error);
        if (alive.current) { setSavedPath(result.path ?? result.state?.recording?.path ?? ''); setPhase('saved'); }
      }
    } catch (cause) {
      // A failed write may still be closing in Main when its first state reply
      // arrives. Never cancel implicitly: salvage already accepted chunks, then
      // reconcile the latest state and reveal whichever recovery file survived.
      const streamFailure = !submittedFinish;
      let recoveredPath = '';
      if (streamFailure && !running.cancelled) {
        const salvaged = await api.request({ type: 'recording.finish', id: running.id }).catch(() => undefined);
        if (salvaged?.ok) recoveredPath = salvaged.path ?? salvaged.state?.recording?.path ?? '';
      }
      let snapshot = await api.request({ type: 'state' }).catch(() => undefined);
      for (let attempt = 0; attempt < 3 && alive.current && snapshot?.ok && snapshot.state?.recording?.id === running.id
        && ['recording', 'paused', 'finalizing'].includes(snapshot.state.recording.status); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        snapshot = await api.request({ type: 'state' }).catch(() => undefined);
      }
      const retained = snapshot?.ok && snapshot.state?.recording?.id === running.id ? snapshot.state.recording : undefined;
      if (!streamFailure && retained?.status === 'saved' && retained.path) {
        if (alive.current) { setSavedPath(retained.path); setError(''); setPhase('saved'); }
      } else {
        if (alive.current) {
          setError(cause instanceof Error ? cause.message : words.failed); setPhase('failed');
          const recoveryPath = recoveredPath || (retained?.status === 'failed' || retained?.status === 'saved' ? retained.path : '');
          if (recoveryPath) { setSavedPath(recoveryPath); setNotice(recoveredPath ? words.recordingPartialPreserved : words.recordingSourcePreserved); }
          else { setSavedPath(state.downloadPath); setNotice(words.recordingCheckDownloads); }
        }
      }
    } finally { if (session.current === running) session.current = undefined; running.settle(); }
  }

  async function start() {
    if (!sourceId || locked) return;
    if (desktopSource?.desktop && source?.kind !== 'window' && !selectedRect) { setError(words.recordingNoSelection); return; }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) { setError(words.missingMediaRecorder); return; }
    setPhase('preparing'); setAwaitingMedia(true); setControlsPrepared(false); setError(''); setNotice(''); setSavedPath(''); setElapsed(0); setCapturedAudio({ system: false, microphone: false });
    const pending = { aborted: false, id: undefined as string | undefined }; preparing.current = pending;
    let media: Awaited<ReturnType<typeof desktopRecordingMedia>> | undefined;
    try {
      const overlayCrop = desktopSource?.desktop && source?.kind !== 'window' ? selectedRect : undefined;
      const prepared = await api.request({ type: 'recording.prepare', sourceId, format: options.format, systemAudio: options.format !== 'gif' && options.systemAudio, microphone: options.format !== 'gif' && options.microphone, quality: options.quality, ...(overlayCrop ? { rect: overlayCrop } : {}) });
      if (!prepared.ok) throw Error(prepared.error);
      if (!prepared.id) throw Error(words.failed);
      setRecordingId(prepared.id);
      setControlsPrepared(true);
      pending.id = prepared.id;
      if (pending.aborted) throw Error('cancelled');
      const crop = overlayCrop && desktopSource ? { x: overlayCrop.x / desktopSource.width, y: overlayCrop.y / desktopSource.height, width: overlayCrop.width / desktopSource.width, height: overlayCrop.height / desktopSource.height } : regionEnabled ? region : undefined;
      const isFull = crop && crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
      const desktop = desktopSource?.desktop;
      media = await desktopRecordingMedia({ systemAudio: options.format !== 'gif' && options.systemAudio, microphone: options.format !== 'gif' && options.microphone, quality: options.quality,
        ...(crop && !isFull ? { region: crop } : {}), ...(desktop && source?.kind !== 'window' ? { sourceSize: { width: desktop.pixelBounds?.width ?? Math.round(desktop.bounds.width * desktop.scaleFactor), height: desktop.pixelBounds?.height ?? Math.round(desktop.bounds.height * desktop.scaleFactor) } } : {}) });
      if (pending.aborted || !alive.current) throw Error('cancelled');
      if (media.missingSystemAudio) setNotice(words.missingAudio);
      setCapturedAudio({ system: media.hasSystemAudio, microphone: media.hasMicrophone });
      setEnabledAudio({ system: media.hasSystemAudio, microphone: media.hasMicrophone });
      const mimeType = recordingMimeType(value => MediaRecorder.isTypeSupported(value), media.stream.getAudioTracks().length > 0);
      const encodedSize = media.stream.getVideoTracks()[0]?.getSettings();
      const recorder = new MediaRecorder(media.stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: options.format === 'gif' ? 2_000_000 : recordingBitrate(encodedSize?.width ?? 1920, encodedSize?.height ?? 1080) });
      let settle!: () => void;
      const done = new Promise<void>(resolve => { settle = resolve; });
      const running: Session = { id: prepared.id, recorder, cleanup: media.cleanup, queue: Promise.resolve(), sequence: 0, started: performance.now(), pausedTotal: 0, cancelled: false, queuedBytes: 0, done, settle, finalizing: false,
        setSystemAudioEnabled: media.setSystemAudioEnabled, setMicrophoneEnabled: media.setMicrophoneEnabled };
      session.current = running;
      recorder.ondataavailable = event => {
        if (!event.data.size || running.cancelled || running.failed) return;
        if (running.queuedBytes + event.data.size > 64 * 1024 * 1024) {
          running.failed = Error(words.recordingFailed);
          if (recorder.state !== 'inactive') recorder.stop();
          return;
        }
        running.queuedBytes += event.data.size;
        // Queue Blob conversion as well as IPC so asynchronous arrayBuffer calls
        // cannot reorder chunks; never retain the full recording in the renderer.
        running.queue = running.queue.then(async () => {
          if (running.cancelled || running.failed) return;
          const data = new Uint8Array(await event.data.arrayBuffer());
          for (let offset = 0; offset < data.length; offset += 16 * 1024 * 1024) {
            const result = await api.request({ type: 'recording.chunk', id: running.id, sequence: running.sequence++, chunk: data.slice(offset, offset + 16 * 1024 * 1024) });
            if (!result.ok) throw Error(result.error);
          }
        }).catch((cause: unknown) => {
          if (running.cancelled) return;
          running.failed = cause instanceof Error ? cause : Error(words.failed);
          if (recorder.state !== 'inactive') recorder.stop();
        }).finally(() => { running.queuedBytes -= event.data.size; });
      };
      recorder.onerror = () => { running.failed = Error(words.recordingFailed); if (recorder.state !== 'inactive') recorder.stop(); };
      recorder.onstop = () => { if (alive.current && !running.cancelled) setPhase('finalizing'); void finish(running); };
      for (const track of media.display.getVideoTracks()) track.addEventListener('ended', () => { if (!running.cancelled && recorder.state !== 'inactive') { if (alive.current) setNotice(words.recordingSourceLost); stop(); } }, { once: true });
      recorder.start(1000); setPhase('recording');
    } catch (cause) {
      media?.cleanup();
      if (pending.id) await api.request({ type: 'recording.cancel', id: pending.id }).catch(() => undefined);
      if (alive.current) {
        const message = pending.aborted ? 'cancelled' : cause instanceof Error ? cause.message : words.failed;
        setError(message === 'microphone' ? words.micDenied : message === 'display' || (cause instanceof DOMException && cause.name === 'NotAllowedError') ? words.captureDenied : message === 'cancelled' ? '' : message);
        setPhase(message === 'cancelled' ? 'cancelled' : 'failed');
      }
    } finally { if (preparing.current === pending) { preparing.current = undefined; if (alive.current) setAwaitingMedia(false); } }
  }

  async function pause() {
    const running = session.current; if (!running) return;
    const paused = running.recorder.state === 'recording';
    try {
      const result = await api.request({ type: 'recording.pause', id: running.id, paused });
      if (!result.ok) throw Error(result.error);
      if (paused && running.recorder.state === 'recording') { running.recorder.pause(); running.pausedAt = performance.now(); setPhase('paused'); }
      else if (!paused && running.recorder.state === 'paused') { running.recorder.resume(); running.pausedTotal += performance.now() - (running.pausedAt ?? performance.now()); running.pausedAt = undefined; setPhase('recording'); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : words.failed); }
  }
  async function cancel() {
    if (!window.confirm(words.cancelConfirm)) return false;
    const running = session.current;
    if (running) {
      running.cancelled = true;
      setPhase('finalizing');
      if (running.recorder.state !== 'inactive') running.recorder.stop();
      else await api.request({ type: 'recording.cancel', id: running.id });
      await running.done;
    }
    if (preparing.current) { preparing.current.aborted = true; if (preparing.current.id) await api.request({ type: 'recording.cancel', id: preparing.current.id }); }
    setPhase('cancelled'); return true;
  }
  async function selectDesktopSource(id: string) {
    if (locked) return;
    setLoadingSources(true); setCapturingSource(true); setError('');
    try {
      const next = await api.request({ type: 'screenshot.capture', sourceId: id });
      if (!next.ok) throw Error(next.error);
      if (!next.source) throw Error(words.failed);
      setSourceId(id); setSelectedRect(undefined); setOverlayRevision(value => value + 1);
      setControlsPrepared(false); setPhase('idle'); onSourceChange?.(next.source);
    } catch (cause) { setError(cause instanceof Error ? cause.message : words.failed); }
    finally { setLoadingSources(false); setCapturingSource(false); }
  }
  const qualityOptions = [
    { value: 'original', label: words.qualityOriginal }, { value: '1080p', label: words.quality1080 }, { value: '720p', label: words.quality720 },
  ];
  function toggleAudio(kind: 'system' | 'microphone') {
    const enabled = !enabledAudio[kind];
    if (kind === 'system') session.current?.setSystemAudioEnabled?.(enabled); else session.current?.setMicrophoneEnabled?.(enabled);
    setEnabledAudio(previous => ({ ...previous, [kind]: enabled }));
  }
  const phaseLabel = phase === 'recording' ? words.live : phase === 'paused' ? words.paused : phase === 'preparing' ? words.preparing : phase === 'finalizing' ? words.finalizing : phase === 'saved' ? words.recordingSaved : phase === 'failed' ? words.recordingFailed : phase === 'cancelled' ? words.recordingCancelled : words.ready;
  if (phase === 'saved' || phase === 'failed' || phase === 'cancelled') return <RecordingResult key={recordingId + phase} api={api} id={recordingId}
    path={revealPath === state.downloadPath ? '' : revealPath} elapsed={elapsed} status={phase} error={error} notice={notice}
    onClose={onClose} onAgain={() => { if (desktopSource?.desktop) void selectDesktopSource(sourceId); else { setPhase('idle'); setError(''); setNotice(''); setSavedPath(''); } }} />;
  if (active || phase === 'finalizing' || phase === 'preparing' && controlsPrepared) return <main className={'capture-tools-window capture-recorder capture-recorder-floating' + (active ? ' is-active' : '')} data-capture-recorder>
    <div className={'capture-recording-status is-' + phase} role="status"><span /><strong>{phaseLabel}</strong><time aria-label={words.elapsed}>{recordingClock(elapsed)}</time></div>
    <div className="capture-recorder-floating-actions"><div className="capture-recording-audio"><span><button type="button" title={words.systemAudio} aria-label={words.systemAudio} aria-pressed={enabledAudio.system} disabled={!active || !capturedAudio.system} onClick={() => toggleAudio('system')}><Icon name={enabledAudio.system ? 'volume' : 'volume-off'} size={17} /><span className="capture-audio-description">{words.systemAudio}: {enabledAudio.system ? '✓' : '—'}</span></button></span><span><button type="button" title={words.microphone} aria-label={words.microphone} aria-pressed={enabledAudio.microphone} disabled={!active || !capturedAudio.microphone} onClick={() => toggleAudio('microphone')}><Icon name="microphone" size={17} /><span className="capture-audio-description">{words.microphone}: {enabledAudio.microphone ? '✓' : '—'}</span></button></span></div>
      <Button size="sm" iconName={phase === 'paused' ? 'play' : 'pause'} variant="quiet" aria-label={phase === 'paused' ? words.resume : words.pause} title={phase === 'paused' ? words.resume : words.pause} disabled={!active} onClick={() => void pause()} /><Button size="sm" iconName="stop" aria-label={words.stop} title={words.stop} disabled={!active} onClick={stop} />
      <Button size="sm" iconName="close" variant="quiet" aria-label={words.cancel} title={words.cancel} disabled={phase === 'finalizing'} onClick={() => void cancel()} />
    </div>
    {notice ? <small className="capture-recorder-floating-notice" role="status" title={notice}><Icon name="info" size={13} /><span className="capture-audio-description">{notice}</span></small> : null}
  </main>;
  if (desktopSource?.desktop && (phase === 'idle' || phase === 'preparing' && !controlsPrepared)) {
    const desktop = desktopSource.desktop;
    const physical = selectedRect ? recordingOutputSize(selectedRect.width / desktopSource.width * (desktop.pixelBounds?.width ?? desktop.bounds.width * desktop.scaleFactor),
      selectedRect.height / desktopSource.height * (desktop.pixelBounds?.height ?? desktop.bounds.height * desktop.scaleFactor), options.quality) : undefined;
    const toolbar = <div className="desktop-recording-toolbar" data-desktop-recording-toolbar>
      <fieldset disabled={locked || loadingSources}>
        <label title={words.format}><select aria-label={words.format} value={options.format} onChange={event => setOptions({ ...options, format: event.target.value as CaptureToolsSettings['format'] })}>{['mp4', 'webm', 'gif'].map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
        <label title={words.quality}><select aria-label={words.quality} value={options.quality} onChange={event => setOptions({ ...options, quality: event.target.value as CaptureToolsSettings['quality'] })}>{qualityOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <span className="desktop-screenshot-separator" />
        <label className="desktop-recording-audio-toggle" title={words.systemAudio}><input type="checkbox" aria-label={words.systemAudio} disabled={options.format === 'gif'} checked={options.systemAudio && options.format !== 'gif'} onChange={event => setOptions({ ...options, systemAudio: event.target.checked })} /><Icon name={options.systemAudio && options.format !== 'gif' ? 'volume' : 'volume-off'} size={17} /></label>
        <label className="desktop-recording-audio-toggle" title={words.microphone}><input type="checkbox" aria-label={words.microphone} disabled={options.format === 'gif'} checked={options.microphone && options.format !== 'gif'} onChange={event => setOptions({ ...options, microphone: event.target.checked })} /><Icon name="microphone" size={17} /></label>
        <Button iconName="fit-window" variant="quiet" aria-label={words.source} title={words.source} aria-expanded={sourceMenuOpen} onClick={() => setSourceMenuOpen(previous => !previous)} />
        {sourceMenuOpen && <label className="desktop-recording-source"><select aria-label={words.source} value={sourceId} onChange={event => { setSourceMenuOpen(false); void selectDesktopSource(event.target.value); }}>{sources.map(item => <option key={item.id} value={item.id}>{(item.kind === 'screen' ? words.screen : words.window) + ' · ' + item.name}</option>)}</select></label>}
        <span className="desktop-screenshot-separator" />
        <Button iconName="close" variant="quiet" aria-label={words.close} title={words.close} onClick={onClose} />
        <Button iconName="video" className="is-primary" aria-label={words.start} title={words.start} disabled={!sourceId || !selectedRect} loading={phase === 'preparing'} onClick={() => void start()} />
      </fieldset>
      <div className="desktop-recording-hint"><span>{physical ? `${physical.width} × ${physical.height} · 30 fps` : words.recordingNoSelection}</span><span className="desktop-recording-info" tabIndex={0} aria-label={`${options.format === 'gif' ? words.gifHint : words.videoHint} ${words.recordingHiddenControls}`} title={`${options.format === 'gif' ? words.gifHint : words.videoHint}\n${words.recordingHiddenControls}`}><Icon name="info" size={14} /></span></div>
      {error ? <p role="alert" className="capture-tools-error">{error}</p> : null}
    </div>;
    return <DesktopScreenshotOverlay key={overlayRevision} source={desktopSource} ai={state.ai} onClose={() => { if (!locked) onClose(); }}
      recording={{ onSelection: setSelectedRect, toolbar, disabled: locked || capturingSource }} onSave={async () => undefined} onCopy={async () => undefined} onAsk={async () => ''} />;
  }
  return <main className={'capture-tools-window capture-recorder' + (active ? ' is-active' : '')} data-capture-recorder>
    <header><div><Icon name="fit-window" size={21} /><h1>{words.recording}</h1></div><Button iconName="close" variant="quiet" aria-label={words.close} onClick={() => { if (locked) void cancel().then(ok => { if (ok) onClose(); }); else onClose(); }} /></header>
    <div className="capture-recorder-body">
      <div className={'capture-recording-status is-' + phase} role="status"><span /><strong>{phaseLabel}</strong><time aria-label={words.elapsed}>{recordingClock(elapsed)}</time></div>
      {error ? <p className="capture-tools-error" role="alert">{error}</p> : null}
      {notice ? <p className="capture-tools-muted" role="status">{notice}</p> : null}
      {active ? <div className="capture-recording-audio"><span><Icon name="music" size={13} />{words.systemAudio}: {capturedAudio.system ? '✓' : '—'}</span><span>{words.microphone}: {capturedAudio.microphone ? '✓' : '—'}</span></div> : null}
      <fieldset disabled={locked} hidden={active}><div className="capture-source-heading"><Select label={words.source} value={sourceId} onValueChange={value => { if (sources.find(item => item.id === value)?.kind === 'screen') void selectDesktopSource(value); else { setSourceId(value); setRegion({ x: 0, y: 0, width: 1, height: 1 }); } }} options={sources.map(item => ({ value: item.id, label: (item.kind === 'screen' ? words.screen : words.window) + ' · ' + item.name }))} /><Button iconName="refresh" variant="quiet" aria-label={words.refresh} loading={loadingSources} onClick={() => void loadSources()} /></div>
        {!sources.length && !loadingSources ? <p className="capture-tools-muted">{words.sourcesEmpty}</p> : null}
        {source ? <><label className="capture-option"><input type="checkbox" checked={regionEnabled} onChange={event => setRegionEnabled(event.target.checked)} />{words.region}</label><RecordingRegionPicker thumbnail={source.thumbnail} enabled={regionEnabled} value={region} onChange={setRegion} /></> : null}
        <div className="capture-recording-options"><Select label={words.format} value={options.format} options={['mp4', 'webm', 'gif'].map(value => ({ value, label: value.toUpperCase() }))} onValueChange={value => setOptions({ ...options, format: value as CaptureToolsSettings['format'] })} /><Select label={words.quality} value={options.quality} options={qualityOptions} onValueChange={value => setOptions({ ...options, quality: value as CaptureToolsSettings['quality'] })} /><div><label className="capture-option"><input type="checkbox" disabled={options.format === 'gif'} checked={options.systemAudio && options.format !== 'gif'} onChange={event => setOptions({ ...options, systemAudio: event.target.checked })} />{words.systemAudio}</label><label className="capture-option"><input type="checkbox" disabled={options.format === 'gif'} checked={options.microphone && options.format !== 'gif'} onChange={event => setOptions({ ...options, microphone: event.target.checked })} />{words.microphone}</label></div></div>
      </fieldset>
      <p className="capture-tools-muted" hidden={active}>{options.format === 'gif' ? words.gifHint : words.videoHint}</p>
      {revealPath ? <div className="capture-tools-location"><span title={revealPath}>{revealPath}</span><Button iconName="folder" size="sm" onClick={() => void api.request({ type: 'reveal', path: revealPath })}>{words.reveal}</Button></div> : null}
    </div>
    <footer className="capture-tools-actions"><Button disabled={!source || locked} loading={phase === 'preparing'} iconName="fit-window" onClick={() => { if (desktopSource?.desktop && phase !== 'preparing') void selectDesktopSource(sourceId); else void start(); }}>{desktopSource?.desktop ? words.recordAgain : words.start}</Button></footer>
  </main>;
}
