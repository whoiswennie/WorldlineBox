import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { CaptureImageSource } from '../../shared/capture-tools';
import { Icon, type IconName } from '../Icons';
import { useLocale } from '../i18n';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import type { ScreenshotMessage, ScreenshotStudioProps } from '../browser/screenshot/ScreenshotStudio';
import { commitEdit, EMPTY_HISTORY, imagePoint, integerCrop, MAX_ANNOTATIONS, rectangle, redoEdit, screenshotFilename, undoEdit, type Annotation, type Point, type Rect, type ScreenshotTool, type Size } from '../browser/screenshot/model';
import { drawScreenshot, exportScreenshot } from '../browser/screenshot/render';
import { screenshotMessages } from '../browser/screenshot/messages';
import { desktopRectToPixels, moveScreenshotSelection, pixelRectToViewport, pointInRect, relativeScreenshotAnnotations, resizeScreenshotSelection, screenshotChatPosition, screenshotToolbarPosition, type ResizeHandle } from './desktop-screenshot-geometry';
import './desktop-screenshot-overlay.css';

export type DesktopScreenshotOverlayProps = Omit<ScreenshotStudioProps, 'source'> & {
  source: CaptureImageSource;
  recording?: { onSelection(rect: Rect | undefined): void; toolbar: ReactNode; disabled?: boolean };
};
type Gesture = { pointer: number; start: Point; client: Point } & (
  { kind: 'select'; candidate?: Rect } | { kind: 'move'; original: Rect } | { kind: 'resize'; original: Rect; handle: ResizeHandle } | { kind: 'annotation'; item: Annotation }
);
type TextDraft = { at: Point; value: string };
const TOOLS: ScreenshotTool[] = ['rect', 'ellipse', 'arrow', 'pen', 'highlight', 'text', 'redact', 'mosaic'];
const TOOL_ICONS: Record<ScreenshotTool, IconName> = { pen: 'pen-tool', highlight: 'highlighter', arrow: 'arrow-up-right', rect: 'rectangle', ellipse: 'ellipse', text: 'type', redact: 'redact', mosaic: 'pixelate' };
const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const COLORS = ['#f04452', '#ffab35', '#45c08a', '#35a7f2', '#8368ed', '#ffffff', '#171d2a'];
function ScreenshotIconButton({ label, icon, onClick, disabled, pressed, primary }: { label: string; icon: IconName; onClick(): void; disabled?: boolean; pressed?: boolean; primary?: boolean }) {
  return <button type="button" title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} className={primary ? 'is-primary' : undefined} onClick={onClick}><Icon name={icon} size={19} /></button>;
}

/** One frozen monitor fills its native desktop bounds. Selection and editing never leave that surface. */
export function DesktopScreenshotOverlay({ source, onClose, onSave, onSaveFile, onCopy, ai, onAsk, initialTask = 'screenshot', onLongCapture, recording }: DesktopScreenshotOverlayProps) {
  const { locale } = useLocale(); const zh = locale === 'zh-CN'; const words = screenshotMessages[locale];
  const [image, setImage] = useState<HTMLImageElement>(); const [failed, setFailed] = useState(false);
  const [viewport, setViewport] = useState<Size>(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [crop, setCrop] = useState<Rect>(); const [pendingCrop, setPendingCrop] = useState<Rect>();
  const [hover, setHover] = useState<Point>(() => {
    const desktop = source.desktop; const cursor = desktop?.cursor;
    return cursor && desktop ? { x: (cursor.x - desktop.bounds.x) / desktop.bounds.width * source.width, y: (cursor.y - desktop.bounds.y) / desktop.bounds.height * source.height } : { x: source.width / 2, y: source.height / 2 };
  });
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [history, setHistory] = useState(EMPTY_HISTORY); const [draft, setDraft] = useState<Annotation>();
  const [tool, setTool] = useState<ScreenshotTool>();
  const [color, setColor] = useState(COLORS[0]!); const [size, setSize] = useState(4); const [fontSize, setFontSize] = useState(26);
  const [settingsOpen, setSettingsOpen] = useState(false); const [textDraft, setTextDraft] = useState<TextDraft>();
  const [action, setAction] = useState(''); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [toolbarSize, setToolbarSize] = useState<Size>({ width: 740, height: 50 });
  const [chatOpen, setChatOpen] = useState(initialTask !== 'screenshot');
  const [chatSize, setChatSize] = useState<Size>({ width: 352, height: 520 });
  const [messages, setMessages] = useState<ScreenshotMessage[]>([]); const [asking, setAsking] = useState(false);
  const ocrPrompt = zh ? '请提取这张截图中的全部文字，保留原有段落与表格结构。' : 'Extract all text in this screenshot, preserving paragraphs and table structure.';
  const translatePrompt = zh ? '请将这张截图中的文字翻译为中文，保留原文的段落顺序。' : 'Translate the text in this screenshot into English, preserving paragraph order.';
  const [prompt, setPrompt] = useState(initialTask === 'ocr' ? ocrPrompt : initialTask === 'translate' ? translatePrompt : '');
  const surface = useRef<HTMLDivElement>(null); const canvas = useRef<HTMLCanvasElement>(null); const toolbar = useRef<HTMLDivElement>(null);
  const chat = useRef<HTMLElement>(null); const textInput = useRef<HTMLTextAreaElement>(null); const chatEnd = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined); const mounted = useRef(true);
  const request = useRef<{ controller: AbortController; previous: ScreenshotMessage[]; question: string } | undefined>(undefined);
  const textDraftRef = useRef<TextDraft | undefined>(undefined);
  useLayoutEffect(() => { textDraftRef.current = textDraft; }, [textDraft]);
  useDialogFocusTrap(true);

  useEffect(() => {
    mounted.current = true; const next = new Image();
    next.onload = () => { if (mounted.current) setImage(next); };
    next.onerror = () => { if (mounted.current) setFailed(true); }; next.src = source.dataUrl;
    return () => { mounted.current = false; next.onload = null; next.onerror = null; request.current?.controller.abort(); };
  }, [source.dataUrl]);
  useLayoutEffect(() => {
    const update = () => {
      const bounds = surface.current?.getBoundingClientRect();
      setViewport({ width: bounds?.width || window.innerWidth, height: bounds?.height || window.innerHeight });
    };
    window.addEventListener('resize', update); update(); return () => window.removeEventListener('resize', update);
  }, []);
  useLayoutEffect(() => {
    if (!crop) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const value = { width: entry.target.getBoundingClientRect().width, height: entry.target.getBoundingClientRect().height };
        if (entry.target === toolbar.current) setToolbarSize(previous => previous.width === value.width && previous.height === value.height ? previous : value);
        if (entry.target === chat.current) setChatSize(previous => previous.width === value.width && previous.height === value.height ? previous : value);
      }
    });
    if (toolbar.current) observer.observe(toolbar.current); if (chat.current) observer.observe(chat.current);
    return () => observer.disconnect();
  }, [crop, chatOpen, settingsOpen]);
  const textX = textDraft?.at.x; const textY = textDraft?.at.y;
  useEffect(() => { if (textX !== undefined) textInput.current?.focus(); }, [textX, textY]);
  useEffect(() => { chatEnd.current?.scrollIntoView?.({ block: 'nearest' }); }, [messages, asking]);
  const onRecordingSelection = recording?.onSelection;
  useEffect(() => { onRecordingSelection?.(crop); }, [crop, onRecordingSelection]);

  const imageSize = useMemo(() => ({ width: image?.naturalWidth ?? source.width, height: image?.naturalHeight ?? source.height }), [image, source.width, source.height]);
  const candidates = useMemo(() => {
    const desktop = source.desktop;
    return desktop ? desktop.candidates.map(item => ({ ...item, rect: desktopRectToPixels(item.bounds, desktop.bounds, imageSize) }))
      : [{ id: 'screen', name: source.title, kind: 'screen' as const, rect: { x: 0, y: 0, ...imageSize } }];
  }, [source.desktop, source.title, imageSize]);
  const underPointer = useMemo(() => candidates.filter(item => pointInRect(hover, item.rect)), [candidates, hover]);
  const candidate = underPointer[candidateIndex % Math.max(1, underPointer.length)];
  const selectedRect = crop ?? pendingCrop ?? candidate?.rect;
  const displayRect = selectedRect ? pixelRectToViewport(selectedRect, imageSize, viewport) : undefined;
  const chatPoint = displayRect ? screenshotChatPosition(displayRect, chatSize, viewport) : { x: 12, y: 12 };
  // Reserve a side for Q&A instead of letting its composer or the tools obscure each other.
  const chatRight = chatPoint.x + chatSize.width + 12;
  const leftSpace = chatPoint.x - 12; const rightSpace = viewport.width - chatRight;
  const toolbarArea = chatOpen && !recording && Math.max(leftSpace, rightSpace) >= 300
    ? leftSpace >= rightSpace ? { x: 0, width: leftSpace } : { x: chatRight, width: rightSpace }
    : { x: 0, width: viewport.width };
  const localToolbarPoint = displayRect ? screenshotToolbarPosition({ ...displayRect, x: displayRect.x - toolbarArea.x }, { ...toolbarSize, width: Math.min(toolbarSize.width, toolbarArea.width - 24) }, { width: toolbarArea.width, height: viewport.height }) : { x: 12, y: 12 };
  const toolbarPoint = { x: localToolbarPoint.x + toolbarArea.x, y: localToolbarPoint.y };
  const scale = viewport.width / imageSize.width;
  const textAnnotation = useCallback((value: TextDraft | undefined): Annotation | undefined => value?.value.trim()
    ? { tool: 'text', at: value.at, text: value.value.trim().slice(0, 2000), color, size: fontSize } : undefined, [color, fontSize]);
  const commitText = () => {
    const value = textAnnotation(textDraftRef.current);
    if (value) setHistory(previous => commitEdit(previous, [...previous.present, value]));
    textDraftRef.current = undefined; setTextDraft(undefined);
  };
  useEffect(() => {
    const context = canvas.current?.getContext('2d'); if (!context || !image || !crop) return;
    drawScreenshot(context, image, crop, relativeScreenshotAnnotations([...history.present, ...(draft ? [draft] : [])], crop));
  }, [image, crop, history.present, draft]);

  const close = useCallback(() => { request.current?.controller.abort(); onClose(); }, [onClose]);
  function clearSelection() {
    request.current?.controller.abort(); request.current = undefined; setAsking(false); setMessages([]); setPrompt('');
    gesture.current = undefined; setCrop(undefined); setPendingCrop(undefined); setDraft(undefined); setHistory(EMPTY_HISTORY);
    setCandidateIndex(0);
    setTextDraft(undefined); setTool(undefined); setSettingsOpen(false); setError(''); setNotice('');
  }
  function select(value: Rect) {
    setCrop(integerCrop(value, imageSize)); setPendingCrop(undefined); setHistory(EMPTY_HISTORY); setDraft(undefined); setTool(undefined); setError(''); setNotice('');
  }
  const pointFor = (event: { clientX: number; clientY: number }): Point => imagePoint({ x: event.clientX, y: event.clientY }, { x: 0, y: 0, ...viewport }, imageSize);
  function startGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !image || action || recording?.disabled) return;
    if ((event.target as HTMLElement).closest('[data-screenshot-ui]')) return;
    event.preventDefault(); commitText(); setSettingsOpen(false); setError(''); setNotice('');
    const point = pointFor(event); const client = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-resize-handle]')?.dataset.resizeHandle as ResizeHandle | undefined;
    if (crop && handle) { gesture.current = { pointer: event.pointerId, kind: 'resize', original: crop, start: point, client, handle }; return; }
    if (!crop || !pointInRect(point, crop)) {
      const hit = candidates.filter(item => pointInRect(point, item.rect));
      if (crop) clearSelection();
      gesture.current = { pointer: event.pointerId, kind: 'select', start: point, client, candidate: hit[candidateIndex % Math.max(1, hit.length)]?.rect };
      return;
    }
    if (!tool) { gesture.current = { pointer: event.pointerId, kind: 'move', original: crop, start: point, client }; return; }
    if (history.present.length >= MAX_ANNOTATIONS) { setError(words.limit); return; }
    if (tool === 'text') { setTextDraft({ at: point, value: '' }); return; }
    const item: Annotation = tool === 'pen' || tool === 'highlight' ? { tool, points: [point], color, size }
      : tool === 'redact' || tool === 'mosaic' ? { tool, from: point, to: point, size } : { tool, from: point, to: point, color, size };
    gesture.current = { pointer: event.pointerId, kind: 'annotation', start: point, client, item }; setDraft(item);
  }
  function moveGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const point = pointFor(event); const current = gesture.current;
    if (!current) {
      if (!crop && !(event.target as HTMLElement).closest('[data-screenshot-ui]')) {
        if (Math.hypot(hover.x - point.x, hover.y - point.y) >= 1) { setHover(point); setCandidateIndex(0); }
      }
      return;
    }
    if (current.pointer !== event.pointerId) return;
    if (current.kind === 'select') {
      if (Math.hypot(event.clientX - current.client.x, event.clientY - current.client.y) >= 4) setPendingCrop(integerCrop(rectangle(current.start, point), imageSize));
    } else if (current.kind === 'move') setCrop(moveScreenshotSelection(current.original, { x: point.x - current.start.x, y: point.y - current.start.y }, imageSize));
    else if (current.kind === 'resize') setCrop(resizeScreenshotSelection(current.original, current.handle, point, imageSize));
    else {
      const item = current.item;
      if ('points' in item) {
        const last = item.points.at(-1); if (last && Math.hypot(last.x - point.x, last.y - point.y) < .5) return;
        const points = item.points.length >= 4096 ? item.points.filter((_, index) => index % 2 === 0) : item.points;
        current.item = { ...item, points: [...points, point] };
      } else if ('to' in item) current.item = { ...item, to: point };
      setDraft(current.item);
    }
  }
  function endGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current; if (!current || current.pointer !== event.pointerId) return;
    moveGesture(event);
    if (current.kind === 'select') {
      const dragged = Math.hypot(event.clientX - current.client.x, event.clientY - current.client.y) >= 4;
      select(dragged ? rectangle(current.start, pointFor(event)) : current.candidate ?? { x: 0, y: 0, ...imageSize });
    } else if (current.kind === 'annotation') setHistory(previous => commitEdit(previous, [...previous.present, current.item]));
    gesture.current = undefined; setDraft(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function exportImage(options?: { maxSide: number; format: 'image/jpeg' | 'image/png' }) {
    if (!image || !crop) throw Error(words.failed);
    const pendingText = textAnnotation(textDraftRef.current);
    return exportScreenshot(image, crop, relativeScreenshotAnnotations([...history.present, ...(pendingText ? [pendingText] : [])], crop), options);
  }
  async function perform(kind: 'copy' | 'done' | 'save' | 'file' | 'long') {
    if (action || !crop) return;
    setAction(kind); setError(''); setNotice('');
    try {
      if (kind === 'long') await onLongCapture?.(crop);
      else if (kind === 'copy' || kind === 'done') { await onCopy(exportImage()); if (kind === 'done') close(); else if (mounted.current) setNotice(words.copied); }
      else if (kind === 'file') { await onSaveFile?.(exportImage(), screenshotFilename()); close(); }
      else { await onSave(exportImage(), screenshotFilename()); if (mounted.current) setNotice(words.saved); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setAction(''); }
  }
  function cycleCandidate(direction = 1) { setCandidateIndex(value => (value + direction + Math.max(1, underPointer.length)) % Math.max(1, underPointer.length)); }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (recording?.disabled) return;
      const editing = event.target instanceof Element && event.target.closest('textarea,input,select,[contenteditable="true"]');
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (textDraftRef.current) { textDraftRef.current = undefined; setTextDraft(undefined); } else close(); return;
      }
      if (editing) return;
      if (!crop && event.key === 'Tab') { event.preventDefault(); cycleCandidate(event.shiftKey ? -1 : 1); return; }
      if (event.key === 'Enter') { event.preventDefault(); if (crop && !recording) void perform('done'); else if (!crop && candidate) select(candidate.rect); return; }
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'z') { event.preventDefault(); setHistory(previous => event.shiftKey ? redoEdit(previous) : undoEdit(previous)); }
      else if (key === 'y') { event.preventDefault(); setHistory(redoEdit); }
      else if (crop && key === 'c' && !recording) { event.preventDefault(); void perform('done'); }
      else if (crop && key === 's' && onSaveFile && !recording) { event.preventDefault(); void perform('file'); }
    };
    document.addEventListener('keydown', keydown, true); return () => document.removeEventListener('keydown', keydown, true);
  });
  const stopAnswer = () => {
    const active = request.current; if (!active) return;
    active.controller.abort(); request.current = undefined; setMessages(active.previous); setPrompt(active.question); setAsking(false); setNotice(words.cancelled);
  };
  async function ask() {
    const question = prompt.trim(); if (!question || asking || !image || !crop || !ai.configured || ai.visionSupported === false) return;
    if (question.length > 4000) { setError(words.questionTooLong); return; }
    if (messages.filter(item => item.role === 'user').length >= 20) { setError(words.questionLimit); return; }
    const active = { controller: new AbortController(), previous: messages, question }; const next: ScreenshotMessage[] = [...messages, { role: 'user', content: question }];
    request.current = active; setMessages(next); setPrompt(''); setAsking(true); setError(''); setNotice('');
    try {
      const answer = (await onAsk({ dataUrl: exportImage({ maxSide: 1600, format: 'image/jpeg' }), messages: next, signal: active.controller.signal })).trim();
      if (!mounted.current || active.controller.signal.aborted || request.current !== active) return;
      if (!answer) throw Error(words.emptyAnswer); setMessages([...next, { role: 'assistant', content: answer }]);
    } catch (cause) {
      if (!mounted.current || active.controller.signal.aborted || request.current !== active) return;
      setMessages(active.previous); setPrompt(question); setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (mounted.current && request.current === active) { request.current = undefined; setAsking(false); } }
  }
  const aiDisabledReason = !ai.configured ? words.chatUnavailable : ai.visionSupported === false ? ai.reason || words.chatNoVision : '';
  const areaButton = (kind: 'screen' | 'workarea') => {
    const target = candidates.find(item => item.kind === kind); if (!target) return null;
    const label = kind === 'screen' ? zh ? '使用整个屏幕' : 'Use entire screen' : zh ? '不含任务栏' : 'Exclude taskbar';
    return <button type="button" disabled={recording?.disabled} onClick={() => select(target.rect)} aria-label={label} title={kind === 'screen' ? zh ? '使用整个屏幕（包含任务栏）' : 'Use the entire screen, including the taskbar' : label}><Icon name={kind === 'screen' ? 'fit-window' : 'rectangle'} size={16} /><span>{label}</span></button>;
  };
  const selectionStyle: CSSProperties | undefined = displayRect ? { left: displayRect.x, top: displayRect.y, width: displayRect.width, height: displayRect.height } : undefined;
  return <div ref={surface} className={`desktop-screenshot-overlay ${crop ? 'is-editing' : 'is-selecting'} ${tool ? 'has-tool' : ''}`} role="dialog" aria-modal="true" aria-label={recording ? zh ? '桌面录屏' : 'Desktop recording' : zh ? '屏幕截图' : 'Desktop screenshot'} data-capture-mode={recording ? 'recording' : 'screenshot'}
    data-screenshot-display-id={source.desktop?.displayId} onPointerDown={startGesture} onPointerMove={moveGesture} onPointerUp={endGesture}
    onPointerCancel={() => { gesture.current = undefined; setDraft(undefined); setPendingCrop(undefined); }}
    onContextMenu={event => { if ((event.target as HTMLElement).closest('textarea,input')) return; event.preventDefault(); if (recording?.disabled) return; if (crop) clearSelection(); else close(); }}
    onWheel={event => { if (!crop && !gesture.current && !recording?.disabled) { event.preventDefault(); cycleCandidate(event.deltaY < 0 ? -1 : 1); } }}>
    <img className="desktop-screenshot-surface" src={source.dataUrl} alt="" draggable={false} />
    {!image && <div className="desktop-screenshot-loading" role={failed ? 'alert' : 'status'}>{words[failed ? 'failed' : 'loading']}<button data-screenshot-ui type="button" onClick={close}>{words.close}</button></div>}
    {image && displayRect && selectedRect && <>
      <div className={`desktop-screenshot-selection ${crop ? 'is-committed' : 'desktop-screenshot-hover'}`} style={selectionStyle} data-pixel-crop={JSON.stringify(selectedRect)} data-candidate-id={!crop && !pendingCrop ? candidate?.id : undefined} data-candidate-kind={!crop && !pendingCrop ? candidate?.kind : undefined}>
        {crop && <canvas ref={canvas} className="desktop-screenshot-selection-canvas" width={crop.width} height={crop.height} aria-label={words.currentImage} />}
        {crop && HANDLES.map(handle => <span key={handle} className={`desktop-screenshot-resize is-${handle}`} data-resize-handle={handle} aria-hidden="true" />)}
      </div>
      <div className="desktop-screenshot-dimensions" style={{ left: Math.min(Math.max(8, displayRect.x), Math.max(8, viewport.width - 250)), top: displayRect.y >= 32 ? displayRect.y - 29 : Math.min(viewport.height - 32, displayRect.y + 9) }}>
        <strong>{Math.round(selectedRect.width)} × {Math.round(selectedRect.height)}</strong><span>{!crop && !pendingCrop ? candidate?.name : zh ? '拖动边角调整' : 'Drag edges to resize'}</span>
      </div>
    </>}
    {!crop && image && <div className="desktop-screenshot-guide" data-screenshot-ui>
      <div><Icon name="crop" size={19} /><strong>{zh ? '单击选择窗口 · 拖动自由框选' : 'Click a window · Drag a custom area'}</strong><span>{zh ? '滚轮 / Tab 切换窗口、工作区、整个屏幕 · Esc 取消' : 'Wheel / Tab: window, work area, screen · Esc: cancel'}</span></div>
      <div className="desktop-screenshot-guide-actions">{areaButton('workarea')}{areaButton('screen')}<ScreenshotIconButton label={words.close} icon="close" onClick={close} /></div>
    </div>}
    {crop && <div ref={toolbar} className="desktop-screenshot-toolbar" role="toolbar" aria-label={recording ? zh ? '录屏工具栏' : 'Recording tools' : zh ? '截图工具栏' : 'Screenshot tools'} data-screenshot-ui style={{ left: toolbarPoint.x, top: toolbarPoint.y, maxWidth: Math.max(100, toolbarArea.width - 24) }}>
      {recording ? recording.toolbar : <><div className="desktop-screenshot-toolbar-row">
        <div className="desktop-screenshot-tools">{TOOLS.map(item => <button key={item} type="button" title={words[item]} aria-label={words[item]} aria-pressed={tool === item} data-screenshot-tool={item} disabled={!!action} onClick={() => { commitText(); setTool(previous => previous === item ? undefined : item); setSettingsOpen(true); }}><Icon name={TOOL_ICONS[item]} size={21} /></button>)}</div>
        <span className="desktop-screenshot-separator" />
        <ScreenshotIconButton label={words.undo} icon="undo" onClick={() => { commitText(); setHistory(undoEdit); }} disabled={!!action || !history.past.length} />
        <ScreenshotIconButton label={words.redo} icon="redo" onClick={() => setHistory(redoEdit)} disabled={!!action || !history.future.length} />
        <ScreenshotIconButton label={zh ? '重新选择' : 'Select another area'} icon="crop" onClick={clearSelection} disabled={!!action} />
        {onLongCapture && <ScreenshotIconButton label={zh ? '滚动长截图' : 'Scrolling screenshot'} icon="fit-window" onClick={() => void perform('long')} disabled={!!action} />}
        <ScreenshotIconButton label={words.chatToggle} icon="sparkles" onClick={() => { commitText(); setChatOpen(value => !value); }} pressed={chatOpen} disabled={!!action} />
        <span className="desktop-screenshot-separator" />
        <ScreenshotIconButton label={words.copy} icon="copy" onClick={() => void perform('copy')} disabled={!!action} />
        {onSaveFile && <ScreenshotIconButton label={zh ? '保存到下载目录' : 'Save to downloads'} icon="download" onClick={() => void perform('file')} disabled={!!action} />}
        <ScreenshotIconButton label={words.save} icon="save" onClick={() => void perform('save')} disabled={!!action} />
        <ScreenshotIconButton label={words.close} icon="close" onClick={close} disabled={!!action} />
        <ScreenshotIconButton label={zh ? '复制并完成' : 'Copy and finish'} icon="check" onClick={() => void perform('done')} primary disabled={!!action} />
      </div>
      {tool && settingsOpen && <div className="desktop-screenshot-brush-settings">
        <span>{words[tool]}</span>
        {tool !== 'redact' && tool !== 'mosaic' && <div className="desktop-screenshot-colors">{COLORS.map(value => <button key={value} type="button" style={{ '--swatch': value } as CSSProperties} aria-label={`${words.color} ${value}`} aria-pressed={color === value} onClick={() => setColor(value)} />)}<input type="color" aria-label={words.color} value={color} onChange={event => setColor(event.target.value)} /></div>}
        <label>{tool === 'text' ? words.fontSize : words.size}<input type="range" aria-label={tool === 'text' ? words.fontSize : words.size} min={tool === 'text' ? 12 : 2} max={tool === 'text' ? 100 : 18} value={tool === 'text' ? fontSize : size} onChange={event => tool === 'text' ? setFontSize(Number(event.target.value)) : setSize(Number(event.target.value))} /><output>{tool === 'text' ? fontSize : size}</output></label>
        <ScreenshotIconButton label={words.reset} icon="trash" onClick={() => { setHistory(previous => commitEdit(previous, [])); setTextDraft(undefined); }} disabled={!!action || (!history.present.length && !textDraft)} />
        {tool === 'text' && <small>{zh ? '在选区内单击输入文字' : 'Click in the selection to type'}</small>}
      </div>}</>}
    </div>}
    {textDraft && crop && <textarea ref={textInput} className="desktop-screenshot-text-input" data-screenshot-ui aria-label={words.text} placeholder={zh ? '输入文字' : 'Type here'} value={textDraft.value} maxLength={2000}
      style={{ left: Math.min(textDraft.at.x * scale, viewport.width - 180), top: Math.min(textDraft.at.y / imageSize.height * viewport.height, viewport.height - 100), fontSize: Math.max(12, fontSize * scale), color }}
      onChange={event => setTextDraft(previous => previous ? { ...previous, value: event.target.value } : previous)} onBlur={commitText}
      onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); commitText(); } }} />}
    {crop && chatOpen && !recording && <aside ref={chat} className="desktop-screenshot-chat screenshot-chat" data-screenshot-ui aria-label={words.chat} style={{ left: chatPoint.x, top: chatPoint.y }}>
      <header><div><h3><Icon name="sparkles" size={17} />{words.chat}</h3><span>{ai.model || 'LLM'} · {zh ? '临时对话' : 'Temporary conversation'}</span></div><div><ScreenshotIconButton label={words.clearChat} icon="trash" onClick={() => { setMessages([]); setError(''); }} disabled={asking || !messages.length} /><ScreenshotIconButton label={zh ? '收起问答' : 'Hide Q&A'} icon="close" onClick={() => setChatOpen(false)} /></div></header>
      <p className="screenshot-chat-hint">{words.chatHint}</p>
      {aiDisabledReason && <p className="screenshot-ai-warning" role="status">{aiDisabledReason}</p>}
      {ai.configured && ai.visionSupported === null && <p className="screenshot-chat-hint">{words.chatUnknown}</p>}
      <div className="screenshot-chat-shortcuts"><button type="button" disabled={asking || !!aiDisabledReason} onClick={() => setPrompt(ocrPrompt)}><Icon name="scan-text" size={15} />{zh ? '提取文字' : 'Extract text'}</button><button type="button" disabled={asking || !!aiDisabledReason} onClick={() => setPrompt(translatePrompt)}><Icon name="languages" size={15} />{zh ? '翻译文字' : 'Translate text'}</button></div>
      <div className="screenshot-chat-messages" aria-live="polite" aria-relevant="additions text">{messages.map((message, index) => <article key={index} className={`is-${message.role}`}><strong>{words[message.role === 'user' ? 'user' : 'assistant']}</strong><p>{message.content}</p></article>)}{asking && <p className="screenshot-chat-thinking" role="status">{words.asking}</p>}<div ref={chatEnd} /></div>
      <form className="screenshot-chat-composer" onSubmit={event => { event.preventDefault(); void ask(); }}>
        <textarea aria-label={words.chatPrompt} placeholder={words.chatPrompt} value={prompt} maxLength={4000} disabled={!!aiDisabledReason || asking} rows={3} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }} />
        <div><small>Ctrl / ⌘ + Enter</small>{asking ? <button type="button" onClick={event => { event.preventDefault(); stopAnswer(); }}><Icon name="stop" size={14} />{words.stop}</button> : <button type="submit" className="is-primary" disabled={!prompt.trim() || !!aiDisabledReason}><Icon name="send" size={15} />{words.ask}</button>}</div>
      </form>
    </aside>}
    {(error || notice) && <div className={`desktop-screenshot-feedback ${error ? 'is-error' : ''}`} data-screenshot-ui role={error ? 'alert' : 'status'}>{error || notice}</div>}
  </div>;
}
