import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { CAPTURE_SELECTION_MAX_BYTES, type CaptureToolsState, type WorldlineBoxCaptureToolsApi } from '../../shared/capture-tools';
import { Icon } from '../Icons';
import { useCaptureWords } from './messages';
import './selection-assistant.css';

type Message = { role: 'user' | 'assistant'; content: string };
type ActiveQuestion = { id: string; previous: Message[]; question: string };

export function SelectionAssistant({ api, state, initialText = '', onClose }: {
  api: WorldlineBoxCaptureToolsApi;
  state: CaptureToolsState;
  initialText?: string;
  onClose(): void;
}) {
  const words = useCaptureWords();
  const [selection, setSelection] = useState(initialText);
  const [expanded, setExpanded] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState('');
  const [asking, setAsking] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef<ActiveQuestion | undefined>(undefined);
  const mounted = useRef(true);
  const end = useRef<HTMLDivElement>(null);
  const originalInput = useRef<HTMLTextAreaElement>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const bytes = new TextEncoder().encode(selection).length;
  const tooLong = bytes > CAPTURE_SELECTION_MAX_BYTES;
  const canAsk = Boolean(state.ai.configured && selection.trim() && prompt.trim() && !tooLong && !asking && !pasting);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current) void api.request({ type: 'ask.cancel', id: active.current.id }).catch(() => undefined);
      active.current = undefined;
    };
  }, [api]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'nearest' }); }, [messages, asking]);
  useEffect(() => { (initialText.trim() ? questionInput : originalInput).current?.focus(); }, [initialText]);

  function stop() {
    const current = active.current; if (!current) return;
    active.current = undefined;
    void api.request({ type: 'ask.cancel', id: current.id }).catch(() => undefined);
    setMessages(current.previous); setPrompt(current.question); setAsking(false); setNotice(words.selectionStopped);
  }
  function close() { stop(); onClose(); }
  const closeFromKeyboard = useEffectEvent(close);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); closeFromKeyboard(); } };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, []);
  function clear() {
    stop(); setMessages([]); setPrompt(''); setError(''); setNotice(''); setExpanded(true);
  }
  function updateSelection(value: string) {
    if (asking) return;
    if (messages.length) { setMessages([]); setPrompt(''); setNotice(words.selectionReset); }
    setSelection(value); setError('');
  }
  async function paste() {
    setPasting(true); setError(''); setNotice('');
    try {
      const response = await api.request({ type: 'selection.clipboard' });
      if (!mounted.current) return;
      if (!response.ok) throw Error(response.error);
      updateSelection(response.text ?? ''); setExpanded(true);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : words.failed); }
    finally { if (mounted.current) setPasting(false); }
  }
  async function ask() {
    if (!canAsk) return;
    const question = prompt.trim();
    if (messages.filter(item => item.role === 'user').length >= 20) { setError(words.selectionTurnLimit); return; }
    const current: ActiveQuestion = { id: crypto.randomUUID(), previous: messages, question };
    const next: Message[] = [...messages, { role: 'user', content: question }];
    active.current = current; setMessages(next); setPrompt(''); setAsking(true); setError(''); setNotice(''); setExpanded(false);
    try {
      const response = await api.request({ type: 'selection.ask', id: current.id, selection: selection.trim(), messages: next });
      if (!mounted.current || active.current !== current) return;
      if (!response.ok) throw Error(response.error);
      if (!response.text?.trim()) throw Error(words.selectionEmptyAnswer);
      setMessages([...next, { role: 'assistant', content: response.text.trim() }]);
    } catch (cause) {
      if (!mounted.current || active.current !== current) return;
      setMessages(current.previous); setPrompt(question); setError(cause instanceof Error ? cause.message : words.failed);
    } finally {
      if (mounted.current && active.current === current) { active.current = undefined; setAsking(false); }
    }
  }
  async function copy(text: string) {
    try {
      const response = await api.request({ type: 'selection.copy', text });
      if (!response.ok) throw Error(response.error);
      if (mounted.current) setNotice(words.selectionCopied);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : words.failed); }
  }
  const unavailable = !state.ai.configured;
  return <main className="capture-tools-window selection-assistant" data-selection-assistant>
    <header><div className="selection-heading"><span><Icon name="type" size={21} /></span><div><h1>{words.selection}</h1><p>{words.selectionTemporary}</p></div></div><div className="selection-header-actions"><button type="button" className="selection-icon-button" aria-label={words.selectionClear} title={words.selectionClear} disabled={!messages.length && !prompt} onClick={clear}><Icon name="trash" size={17} /></button><button type="button" className="selection-icon-button" aria-label={words.close} title={words.close} onClick={close}><Icon name="close" size={19} /></button></div></header>
    <section className="selection-source" aria-label={words.selectionOriginal}>
      <div className="selection-source-heading"><button type="button" aria-expanded={expanded} aria-controls="selection-source-text" onClick={() => setExpanded(value => !value)}><Icon name={expanded ? 'chevron' : 'chevron-right'} size={15} /><strong>{words.selectionOriginal}</strong><span>{bytes.toLocaleString()} B</span></button><button type="button" disabled={asking || pasting} onClick={() => void paste()}><Icon name="clipboard" size={14} />{words.selectionPaste}</button></div>
      {expanded ? <div id="selection-source-text"><textarea ref={originalInput} aria-label={words.selectionOriginal} placeholder={words.selectionPlaceholder} value={selection} maxLength={32768} disabled={asking || pasting} onChange={event => updateSelection(event.target.value)} rows={4} /><p className="selection-source-hint">{tooLong ? words.selectionTooLong : words.selectionEditHint}</p></div> : <button type="button" className="selection-source-summary" onClick={() => setExpanded(true)} title={selection.slice(0, 500)}>{selection}</button>}
    </section>
    <section className="selection-conversation" aria-label={words.selectionConversation}>
      {!messages.length ? <div className="selection-empty"><span><Icon name="sparkles" size={25} /></span><h2>{words.selectionEmptyTitle}</h2><p>{words.selectionEmptyHint}</p><div className="selection-presets">{([['scan-text', words.selectionSummarize], ['sparkles', words.selectionExplain], ['languages', words.selectionTranslate]] as const).map(([icon, label]) => <button type="button" key={icon} disabled={asking || unavailable} onClick={() => setPrompt(label)}><Icon name={icon} size={15} />{label}</button>)}</div></div> : null}
      <div className="selection-messages" aria-live="polite" aria-relevant="additions text">{messages.map((message, index) => <article className={'is-' + message.role} key={index}><div><strong>{message.role === 'user' ? words.selectionYou : words.selectionModel}</strong>{message.role === 'assistant' ? <button type="button" className="selection-icon-button" aria-label={words.selectionCopy} title={words.selectionCopy} onClick={() => void copy(message.content)}><Icon name="copy" size={13} /></button> : null}</div><p>{message.content}</p></article>)}{asking ? <p className="selection-thinking" role="status"><Icon name="loader" size={15} />{words.selectionThinking}</p> : null}<div ref={end} /></div>
    </section>
    <div className="selection-bottom">
      {unavailable || tooLong || error ? <p className="selection-error" role="alert">{error || (tooLong ? words.selectionTooLong : words.selectionConfigure)}</p> : notice ? <p className="selection-notice" role="status">{notice}</p> : null}
      <form className="selection-composer" onSubmit={event => { event.preventDefault(); void ask(); }}><textarea ref={questionInput} aria-label={words.selectionPrompt} placeholder={words.selectionPrompt} rows={2} maxLength={4000} value={prompt} disabled={unavailable || asking || pasting} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }} /><div><span title={state.ai.model}>{state.ai.model || 'LLM'}</span><small>Ctrl / ⌘ + Enter</small>{asking ? <button type="button" onClick={event => { event.preventDefault(); stop(); }}><Icon name="stop" size={15} />{words.selectionStop}</button> : <button type="submit" className="is-primary" disabled={!canAsk}><Icon name="send" size={16} />{words.selectionSend}</button>}</div></form>
    </div>
  </main>;
}
