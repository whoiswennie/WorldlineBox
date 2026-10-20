import { useEffect, useRef, useState } from 'react';
import type { CaptureDesktopSource, CaptureImageSource, CaptureToolsRequest, CaptureToolsResponse, CaptureToolsState, WorldlineBoxCaptureToolsApi } from '../../shared/capture-tools';
import type { ScreenshotAsk } from '../browser/screenshot/types';
import { DesktopScreenshotOverlay } from './DesktopScreenshotOverlay';
import type { Rect } from '../browser/screenshot/model';
import { Button, Select } from '../ui';
import { RecorderPanel } from './RecorderPanel';
import { SelectionAssistant } from './SelectionAssistant';
import { getCaptureToolsApi } from './CaptureToolsSettingsPage';
import { useCaptureWords } from './messages';
import './capture-tools.css';
import { afterStartupPaint } from '../startup-lifecycle';

export function CaptureToolsWindow({ api = getCaptureToolsApi() }: { api?: WorldlineBoxCaptureToolsApi }) {
  const words = useCaptureWords();
  const [state, setState] = useState<CaptureToolsState>();
  const [source, setSource] = useState<CaptureImageSource>();
  const [sourceRevision, setSourceRevision] = useState(0);
  const [selectedText, setSelectedText] = useState('');
  const [sources, setSources] = useState<CaptureDesktopSource[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [long, setLong] = useState<{ frames: number; width: number; height: number }>();
  const surfaceReported = useRef(false);
  const hasContext = state !== undefined;
  useEffect(() => {
    if (!api || surfaceReported.current || !hasContext && !error) return;
    let current = true; let cancelPaint: (() => void) | undefined;
    const image = document.querySelector<HTMLImageElement>('.desktop-screenshot-surface');
    // Decode the displayed bitmap, rather than showing a loading card over the
    // desktop and swapping it for the captured screen a moment later.
    void (image?.decode().catch(() => undefined) ?? Promise.resolve()).then(() => {
      if (current) cancelPaint = afterStartupPaint(() => { surfaceReported.current = true; void api.request({ type: 'surface.ready' }).catch(() => undefined); });
    });
    return () => { current = false; cancelPaint?.(); };
  }, [api, hasContext, source, error]);
  useEffect(() => {
    if (!api) return;
    let current = true;
    void api.request({ type: 'context' }).then(async result => {
      if (!current) return;
      if (!result.ok) { setError(result.error); return; }
      if (result.state) setState(result.state);
      if (result.source) { setSource(result.source); setSourceRevision(value => value + 1); }
      if (result.state?.task === 'selection') { setSelectedText(result.text ?? ''); setSourceRevision(value => value + 1); }
      if (result.state?.task !== 'recording' && result.state?.task !== 'selection' && !result.source) {
        const listed = await api.request({ type: 'sources.list' });
        if (!current) return;
        if (listed.ok) { setSources(listed.sources ?? []); setSourceId(listed.sources?.[0]?.id ?? ''); }
        else setError(listed.error);
      }
    }).catch(() => { if (current) setError(words.failed); });
    const unsubscribe = api.onChanged(next => { if (current) setState(previous => previous && previous.revision > next.revision ? previous : next); });
    return () => { current = false; unsubscribe(); };
  }, [api, words]);

  async function request(input: CaptureToolsRequest): Promise<Extract<CaptureToolsResponse, { ok: true }>> {
    if (!api) throw Error(words.unavailable);
    const result = await api.request(input);
    if (!result.ok) throw Error(result.error);
    if (result.state) setState(result.state);
    return result;
  }
  async function capture() {
    setBusy(true); setError('');
    try { const result = await request({ type: 'screenshot.capture', ...(sourceId ? { sourceId } : {}) }); if (result.source) { setSource(result.source); setSourceRevision(value => value + 1); } else setError(words.failed); }
    catch (cause) { setError(cause instanceof Error ? cause.message : words.failed); }
    finally { setBusy(false); }
  }
  async function ask({ dataUrl, messages, signal, onUpdate }: ScreenshotAsk) {
    const id = crypto.randomUUID();
    let sequence = 0;
    const abort = () => { void api?.request({ type: 'ask.cancel', id }).catch(() => undefined); };
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    signal.addEventListener('abort', abort, { once: true });
    const unsubscribe = api?.onAnswerProgress?.(update => {
      if (signal.aborted || update.id !== id || update.sequence <= sequence) return;
      sequence = update.sequence; onUpdate?.({ text: update.text, reasoning: update.reasoning });
    });
    try {
      const result = await request({ type: 'screenshot.ask', id, dataUrl, messages });
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (!result.text) throw Error(words.failed);
      return result.text;
    } finally { unsubscribe?.(); signal.removeEventListener('abort', abort); }
  }
  function close() { void request({ type: 'close' }).catch(cause => setError(cause instanceof Error ? cause.message : words.failed)); }
  if (state?.task === 'recording' && api) return <RecorderPanel api={api} state={state} source={source} onSourceChange={next => { setSource(next); setSourceRevision(value => value + 1); }} onClose={close} />;
  if (state?.task === 'selection' && api) return <SelectionAssistant key={sourceRevision + state.task} api={api} state={state} initialText={selectedText} onClose={close} />;
  async function startLong(rect: Rect) {
    setError('');
    const result = await request({ type: 'long.begin', rect, ...(sourceId ? { sourceId } : {}) });
    if (result.long) setLong(result.long); else throw Error(words.failed);
  }
  async function longAction(action: 'long.append' | 'long.finish' | 'long.cancel') {
    setBusy(true); setError('');
    try {
      const result = await request({ type: action });
      if (action === 'long.cancel') setLong(undefined);
      else if (action === 'long.finish') {
        if (!result.source) throw Error(words.failed);
        setSource(result.source); setSourceRevision(value => value + 1); setLong(undefined);
      } else if (result.long) setLong(result.long);
    } catch (cause) { setError(cause instanceof Error ? cause.message : words.failed); }
    finally { setBusy(false); }
  }
  if (long) return <main className="capture-tools-window capture-long-controls"><header><h1>{words['long-screenshot']}</h1><span>{words.longFrames} {long.frames}</span></header><p className="capture-tools-muted">{words.longHint}</p>{error ? <p className="capture-tools-error" role="alert">{error}</p> : null}<footer className="capture-tools-actions"><Button disabled={busy} variant="quiet" onClick={() => void longAction('long.cancel')}>{words.longCancel}</Button><Button disabled={busy} loading={busy} onClick={() => void longAction('long.append')}>{words.longAppend}</Button><Button disabled={busy} onClick={() => void longAction('long.finish')}>{words.longFinish}</Button></footer></main>;
  if (source && state) return <DesktopScreenshotOverlay key={sourceRevision + state.task} source={source} ai={state.ai} initialTask={state.task === 'ocr' || state.task === 'translate' ? state.task : 'screenshot'} onClose={close}
    onSave={async (dataUrl, filename) => { await request({ type: 'screenshot.save', dataUrl, filename, destination: 'library' }); }}
    onSaveFile={async (dataUrl, filename) => { await request({ type: 'screenshot.save', dataUrl, filename, destination: 'downloads' }); }}
    onCopy={async dataUrl => { await request({ type: 'screenshot.copy', dataUrl }); }}
    onAsk={ask}
    onOpenLink={async url => { await request({ type: 'link.open', url }); }}
    onLongCapture={startLong}
  />;
  return <main className="capture-tools-window capture-tools-source-picker">
    <header><h1>{words.title}</h1><Button iconName="close" variant="quiet" aria-label={words.close} onClick={close} /></header>
    {!api || error ? <p className="capture-tools-error" role="alert">{error || words.unavailable}</p> : null}
    {api && !state && !error ? <p role="status">{words.loading}</p> : api && state ? <section>
      <Select label={words.source} value={sourceId} options={sources.map(item => ({ value: item.id, label: item.name }))} onValueChange={setSourceId} />
      {sources.find(item => item.id === sourceId)?.thumbnail ? <img className="capture-source-image" src={sources.find(item => item.id === sourceId)!.thumbnail} alt={words.source} /> : null}
      <Button iconName="fit-window" disabled={busy || !sourceId} loading={busy} onClick={() => void capture()}>{words.capture}</Button>
    </section> : null}
  </main>;
}
