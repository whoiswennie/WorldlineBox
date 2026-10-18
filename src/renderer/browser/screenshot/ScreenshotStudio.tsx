import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon, type IconName } from '../../Icons';
import { useLocale } from '../../i18n';
import { useDialogFocusTrap } from '../../use-dialog-focus-trap';
import { commitEdit, EMPTY_HISTORY, imagePoint, integerCrop, MAX_ANNOTATIONS, rectangle, redoEdit, screenshotFilename, undoEdit, type Annotation, type Point, type Rect, type ScreenshotTool } from './model';
import { drawScreenshot, exportScreenshot } from './render';
import { screenshotMessages, type ScreenshotMessageKey } from './messages';
import './screenshot-studio.css';

export type ScreenshotSource = { dataUrl: string; width: number; height: number; title: string; url?: string };
export type ScreenshotMessage = { role: 'user' | 'assistant'; content: string };
export type ScreenshotAIState = { configured: boolean; model: string; visionSupported: boolean | null; reason?: string };
export type ScreenshotAsk = { dataUrl: string; messages: ScreenshotMessage[]; signal: AbortSignal };
export type ScreenshotStudioProps = {
  source: ScreenshotSource;
  onClose(): void;
  onSave(dataUrl: string, filename: string): Promise<void>;
  onSaveFile?(dataUrl: string, filename: string): Promise<void>;
  saveLabel?: string;
  onCopy(dataUrl: string): Promise<void>;
  ai: ScreenshotAIState;
  onAsk(request: ScreenshotAsk): Promise<string>;
  initialTask?: 'screenshot' | 'ocr' | 'translate';
  onLongCapture?(rect: Rect): Promise<void>;
};
type Drawing = { pointer: number; kind: 'crop'; start: Point } | { pointer: number; kind: 'annotation'; item: Annotation };
const TOOLS: ScreenshotTool[] = ['pen', 'highlight', 'arrow', 'rect', 'ellipse', 'text', 'redact', 'mosaic'];
const TOOL_ICONS: Record<ScreenshotTool, IconName> = { pen: 'pen-tool', highlight: 'highlighter', arrow: 'arrow-up-right', rect: 'rectangle', ellipse: 'ellipse', text: 'type', redact: 'redact', mosaic: 'pixelate' };

export function ScreenshotStudio({ source, onClose, onSave, onSaveFile, saveLabel, onCopy, ai, onAsk, initialTask = 'screenshot', onLongCapture }: ScreenshotStudioProps) {
  const { locale } = useLocale();
  const words = screenshotMessages[locale];
  const t = useCallback((key: ScreenshotMessageKey) => words[key], [words]);
  const [image, setImage] = useState<HTMLImageElement>();
  const [failed, setFailed] = useState(false);
  const [phase, setPhase] = useState<'select' | 'edit'>('select');
  const [selection, setSelection] = useState<Rect>();
  const [crop, setCrop] = useState<Rect>({ x: 0, y: 0, width: source.width, height: source.height });
  const [history, setHistory] = useState(EMPTY_HISTORY);
  const [tool, setTool] = useState<ScreenshotTool>('pen');
  const [color, setColor] = useState('#f04452'); const [size, setSize] = useState(4); const [fontSize, setFontSize] = useState(26);
  const [text, setText] = useState(''); const [draft, setDraft] = useState<Annotation>();
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [stageSize, setStageSize] = useState({ width: 900, height: 600 });
  const [action, setAction] = useState(''); const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  const [chatOpen, setChatOpen] = useState(initialTask !== 'screenshot');
  const ocrPrompt = locale === 'zh-CN' ? '请提取这张截图中的全部文字，保留原有段落与表格结构。' : 'Extract all text in this screenshot, preserving paragraphs and table structure.';
  const translatePrompt = locale === 'zh-CN' ? '请将这张截图中的文字翻译为中文，保留原文的段落顺序。' : 'Translate the text in this screenshot into English, preserving paragraph order.';
  const [prompt, setPrompt] = useState(initialTask === 'ocr' ? ocrPrompt : initialTask === 'translate' ? translatePrompt : '');
  const [messages, setMessages] = useState<ScreenshotMessage[]>([]); const [asking, setAsking] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null); const stage = useRef<HTMLDivElement>(null); const chatEnd = useRef<HTMLDivElement>(null);
  const drawing = useRef<Drawing | undefined>(undefined);
  const request = useRef<{ controller: AbortController; previous: ScreenshotMessage[]; question: string } | undefined>(undefined);
  const mounted = useRef(true);
  useDialogFocusTrap(true);

  useEffect(() => {
    mounted.current = true;
    const next = new Image();
    next.onload = () => { if (mounted.current) setImage(next); };
    next.onerror = () => { if (mounted.current) setFailed(true); };
    next.src = source.dataUrl;
    return () => { mounted.current = false; next.onload = null; next.onerror = null; request.current?.controller.abort(); };
  }, [source.dataUrl]);

  useEffect(() => {
    const node = stage.current; if (!node) return;
    const observer = new ResizeObserver(() => setStageSize({ width: Math.max(100, node.clientWidth - 48), height: Math.max(100, node.clientHeight - 48) }));
    observer.observe(node); return () => observer.disconnect();
  }, []);

  useEffect(() => { chatEnd.current?.scrollIntoView?.({ block: 'nearest' }); }, [messages, asking]);

  const imageSize = image ? { width: image.naturalWidth, height: image.naturalHeight } : source;
  const activeCrop = useMemo<Rect>(() => phase === 'edit' ? crop : { x: 0, y: 0, width: imageSize.width, height: imageSize.height }, [phase, crop, imageSize.width, imageSize.height]);
  const scale = zoom === 'fit' || phase === 'select' ? Math.min(1, stageSize.width / activeCrop.width, stageSize.height / activeCrop.height) : zoom;

  useEffect(() => {
    const context = canvas.current?.getContext('2d'); if (!context || !image) return;
    drawScreenshot(context, image, activeCrop, phase === 'edit' ? [...history.present, ...(draft ? [draft] : [])] : []);
  }, [image, activeCrop, phase, history.present, draft]);

  const close = useCallback(() => { request.current?.controller.abort(); onClose(); }, [onClose]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); event.stopPropagation();
        setHistory(previous => event.shiftKey ? redoEdit(previous) : undoEdit(previous));
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault(); event.stopPropagation(); setHistory(redoEdit);
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, [close]);

  const pointFor = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return imagePoint({ x: event.clientX, y: event.clientY }, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, activeCrop);
  };
  const startDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !image) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFor(event); setNotice(''); setError('');
    if (phase === 'select') { drawing.current = { pointer: event.pointerId, kind: 'crop', start: point }; setSelection(rectangle(point, point)); return; }
    if (history.present.length >= MAX_ANNOTATIONS) { setError(t('limit')); return; }
    if (tool === 'text') {
      if (text.trim()) setHistory(previous => commitEdit(previous, [...previous.present, { tool: 'text', at: point, text: text.trim().slice(0, 2000), color, size: fontSize }]));
      return;
    }
    const item: Annotation = tool === 'pen' || tool === 'highlight'
      ? { tool, points: [point], color, size }
      : tool === 'redact' || tool === 'mosaic' ? { tool, from: point, to: point, size } : { tool, from: point, to: point, color, size };
    drawing.current = { pointer: event.pointerId, kind: 'annotation', item }; setDraft(item);
  };
  const moveDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = drawing.current; if (!current || current.pointer !== event.pointerId) return;
    const point = pointFor(event);
    if (current.kind === 'crop') setSelection(rectangle(current.start, point));
    else {
      const item = current.item;
      if ('points' in item) {
        const last = item.points.at(-1);
        if (last && Math.hypot(last.x - point.x, last.y - point.y) < 0.5) return;
        const points = item.points.length >= 4096 ? item.points.filter((_, index) => index % 2 === 0) : item.points;
        current.item = { ...item, points: [...points, point] };
      } else if ('to' in item) current.item = { ...item, to: point };
      setDraft(current.item);
    }
  };
  const endDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = drawing.current; if (!current || current.pointer !== event.pointerId) return;
    moveDrawing(event);
    if (current.kind === 'annotation') setHistory(previous => commitEdit(previous, [...previous.present, current.item]));
    drawing.current = undefined; setDraft(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const confirmCrop = (value: Rect) => {
    setCrop(integerCrop(value, imageSize)); setHistory(EMPTY_HISTORY); setPhase('edit'); setZoom('fit'); setError(''); setNotice('');
  };

  const exportImage = () => {
    if (!image) throw new Error(t('failed'));
    return exportScreenshot(image, crop, history.present);
  };
  const perform = async (kind: 'copy' | 'save' | 'file' | 'long') => {
    if (action) return;
    setAction(kind); setError(''); setNotice('');
    try {
      if (kind === 'long') await onLongCapture?.(integerCrop(selection ?? { x: 0, y: 0, width: imageSize.width, height: imageSize.height }, imageSize));
      else if (kind === 'copy') { await onCopy(exportImage()); if (mounted.current) setNotice(t('copied')); }
      else if (kind === 'file') { await onSaveFile?.(exportImage(), screenshotFilename()); if (mounted.current) setNotice(locale === 'zh-CN' ? '截图已保存到下载目录' : 'Screenshot saved to downloads'); }
      else { await onSave(exportImage(), screenshotFilename()); if (mounted.current) setNotice(t('saved')); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setAction(''); }
  };

  const stopAnswer = () => {
    const active = request.current; if (!active) return;
    active.controller.abort(); request.current = undefined;
    setMessages(active.previous); setPrompt(active.question); setAsking(false); setNotice(t('cancelled'));
  };
  const ask = async () => {
    const question = prompt.trim(); if (!question || asking || !image || !ai.configured || ai.visionSupported === false) return;
    if (question.length > 4000) { setError(t('questionTooLong')); return; }
    if (messages.filter(item => item.role === 'user').length >= 20) { setError(t('questionLimit')); return; }
    const current = { controller: new AbortController(), previous: messages, question };
    const next: ScreenshotMessage[] = [...messages, { role: 'user', content: question }];
    request.current = current; setMessages(next); setPrompt(''); setAsking(true); setError(''); setNotice('');
    try {
      const dataUrl = exportScreenshot(image, crop, history.present, { maxSide: 1600, format: 'image/jpeg' });
      const answer = (await onAsk({ dataUrl, messages: next, signal: current.controller.signal })).trim();
      if (!mounted.current || current.controller.signal.aborted || request.current !== current) return;
      if (!answer) throw new Error(t('emptyAnswer'));
      setMessages([...next, { role: 'assistant', content: answer }]);
    } catch (cause) {
      if (!mounted.current || current.controller.signal.aborted || request.current !== current) return;
      setMessages(current.previous); setPrompt(question); setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current && request.current === current) { request.current = undefined; setAsking(false); }
    }
  };

  const canvasStyle: CSSProperties = { width: Math.max(1, activeCrop.width * scale), height: Math.max(1, activeCrop.height * scale) };
  const aiDisabledReason = !ai.configured ? t('chatUnavailable') : ai.visionSupported === false ? ai.reason || t('chatNoVision') : '';
  return <div className="screenshot-backdrop">
    <section className="screenshot-studio" role="dialog" aria-modal="true" aria-labelledby="screenshot-title">
      <header className="screenshot-header">
        <div className="screenshot-heading"><div className="screenshot-heading-icon"><Icon name="camera" size={21} /></div><div><h2 id="screenshot-title">{t('title')}</h2><span title={source.title}>{source.title || t('viewport')}</span></div></div>
        <div className="screenshot-header-actions">
          {phase === 'edit' && <><button type="button" onClick={() => { setPhase('select'); setSelection(crop); }}><Icon name="crop" size={17} />{t('crop')}</button>
            <button type="button" aria-pressed={chatOpen} onClick={() => setChatOpen(value => !value)}><Icon name="sparkles" size={17} />{t('chatToggle')}</button>
            <button type="button" disabled={!!action} onClick={() => void perform('copy')}><Icon name="copy" size={16} />{t('copy')}</button>
            {onSaveFile && <button type="button" disabled={!!action} onClick={() => void perform('file')}><Icon name="download" size={16} />{locale === 'zh-CN' ? '保存到下载目录' : 'Save to downloads'}</button>}
            <button type="button" className="is-primary" disabled={!!action} onClick={() => void perform('save')}><Icon name="save" size={16} />{saveLabel ?? t('save')}</button></>}
          <button type="button" className="screenshot-icon-button" aria-label={t('close')} title={t('close')} onClick={close}><Icon name="close" size={18} /></button>
        </div>
      </header>
      <div className="screenshot-body">
        <div className="screenshot-workspace">
          {phase === 'edit' && <div className="screenshot-toolbar" role="toolbar" aria-label={t('title')}>
            <div className="screenshot-tool-group">{TOOLS.map(item => <button key={item} type="button" title={t(item)} aria-label={t(item)} aria-pressed={tool === item} onClick={() => setTool(item)}><Icon name={TOOL_ICONS[item]} size={21} /><small>{t(item)}</small></button>)}</div>
            <div className="screenshot-tool-settings">
              {tool !== 'redact' && tool !== 'mosaic' && <label title={t('color')}><input type="color" value={color} aria-label={t('color')} onChange={event => setColor(event.target.value)} /></label>}
              <label>{tool === 'text' ? t('fontSize') : t('size')}<input type="range" min={tool === 'text' ? 12 : 2} max={tool === 'text' ? 100 : 18} value={tool === 'text' ? fontSize : size} aria-label={tool === 'text' ? t('fontSize') : t('size')} onChange={event => tool === 'text' ? setFontSize(Number(event.target.value)) : setSize(Number(event.target.value))} /></label>
              <button type="button" disabled={!history.past.length} onClick={() => setHistory(undoEdit)} title={`${t('undo')} (Ctrl+Z)`}><Icon name="undo" size={16} /><span>{t('undo')}</span></button>
              <button type="button" disabled={!history.future.length} onClick={() => setHistory(redoEdit)} title={`${t('redo')} (Ctrl+Shift+Z)`}><Icon name="redo" size={16} /><span>{t('redo')}</span></button>
              <button type="button" disabled={!history.present.length} onClick={() => setHistory(previous => commitEdit(previous, []))} title={t('reset')} aria-label={t('reset')}><Icon name="trash" size={16} /></button>
            </div>
          </div>}
          {phase === 'edit' && tool === 'text' && <div className="screenshot-text-entry"><textarea rows={2} maxLength={2000} value={text} placeholder={t('textPlaceholder')} aria-label={t('text')} onChange={event => setText(event.target.value)} /><span>{t('textHelp')}</span></div>}
          {phase === 'select' && <div className="screenshot-selection-heading"><strong>{t('select')}</strong><span>{t('selectHelp')}</span></div>}
          <div ref={stage} className={`screenshot-stage ${phase === 'select' ? 'is-selecting' : ''}`}>
            {!image ? <p role={failed ? 'alert' : 'status'}>{t(failed ? 'failed' : 'loading')}</p> : <div className="screenshot-canvas-wrap" style={canvasStyle}>
              <canvas ref={canvas} width={activeCrop.width} height={activeCrop.height} style={canvasStyle} aria-label={t('currentImage')} onPointerDown={startDrawing} onPointerMove={moveDrawing} onPointerUp={endDrawing} onPointerCancel={() => { drawing.current = undefined; setDraft(undefined); }} />
              {phase === 'select' && selection && selection.width > 0 && selection.height > 0 && <div className="screenshot-selection" style={{ left: selection.x * scale, top: selection.y * scale, width: selection.width * scale, height: selection.height * scale }}><span>{Math.round(selection.width)} × {Math.round(selection.height)}</span></div>}
            </div>}
          </div>
          <footer className="screenshot-footer">
            {phase === 'select' ? <><span>{selection && selection.width >= 2 && selection.height >= 2 ? `${Math.round(selection.width)} × ${Math.round(selection.height)} px` : t('select')}</span><div>
              {onLongCapture && <button type="button" disabled={!image || !!action} onClick={() => void perform('long')}><Icon name="fit-window" size={17} />{locale === 'zh-CN' ? '滚动长截图' : 'Scrolling screenshot'}</button>}
              <button type="button" disabled={!image} onClick={() => confirmCrop({ x: 0, y: 0, width: imageSize.width, height: imageSize.height })}>{t('full')}</button>
              <button type="button" className="is-primary" disabled={!image || !selection || selection.width < 2 || selection.height < 2} onClick={() => selection && confirmCrop(selection)}>{t('confirm')}</button></div></>
              : <><span title={t('dimensions')}>{crop.width} × {crop.height} px</span><span className="screenshot-edit-help">{t('editHelp')}</span><label>{t('zoom')}<select aria-label={t('zoom')} value={zoom} onChange={event => setZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))}><option value="fit">{t('fit')}</option>{[0.25, 0.5, 0.75, 1, 1.5, 2, 3].map(value => <option key={value} value={value}>{value * 100}%</option>)}</select></label></>}
          </footer>
          {(error || notice) && <div className={`screenshot-feedback ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}</div>}
        </div>
        {phase === 'edit' && chatOpen && <aside className="screenshot-chat" aria-label={t('chat')}>
          <header><div><h3>{t('chat')}</h3><span>{ai.model || 'LLM'}</span></div><button type="button" title={t('clearChat')} aria-label={t('clearChat')} disabled={asking || !messages.length} onClick={() => { setMessages([]); setError(''); }}><Icon name="trash" size={16} /></button></header>
          <p className="screenshot-chat-hint">{t('chatHint')}</p>
          {aiDisabledReason && <p className="screenshot-ai-warning" role="status">{aiDisabledReason}</p>}
          {ai.configured && ai.visionSupported === null && <p className="screenshot-chat-hint">{t('chatUnknown')}</p>}
          <div className="screenshot-chat-shortcuts"><button type="button" disabled={asking || !!aiDisabledReason} onClick={() => setPrompt(ocrPrompt)}><Icon name="scan-text" size={15} />{locale === 'zh-CN' ? '提取文字' : 'Extract text'}</button><button type="button" disabled={asking || !!aiDisabledReason} onClick={() => setPrompt(translatePrompt)}><Icon name="languages" size={15} />{locale === 'zh-CN' ? '翻译文字' : 'Translate text'}</button></div>
          <div className="screenshot-chat-messages" aria-live="polite" aria-relevant="additions text">{messages.map((message, index) => <article key={index} className={`is-${message.role}`}><strong>{t(message.role === 'user' ? 'user' : 'assistant')}</strong><p>{message.content}</p></article>)}{asking && <p className="screenshot-chat-thinking" role="status">{t('asking')}</p>}<div ref={chatEnd} /></div>
          <form className="screenshot-chat-composer" onSubmit={event => { event.preventDefault(); void ask(); }}>
            <textarea aria-label={t('chatPrompt')} placeholder={t('chatPrompt')} value={prompt} maxLength={4000} disabled={!!aiDisabledReason || asking} rows={3} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }} />
            <div><small>Ctrl / ⌘ + Enter</small>{asking ? <button type="button" onClick={event => { event.preventDefault(); stopAnswer(); }}><Icon name="stop" size={14} />{t('stop')}</button> : <button type="submit" className="is-primary" disabled={!prompt.trim() || !!aiDisabledReason}><Icon name="send" size={15} />{t('ask')}</button>}</div>
          </form>
        </aside>}
      </div>
    </section>
  </div>;
}
