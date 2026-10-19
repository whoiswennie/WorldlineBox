import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { CAPTURE_SELECTION_MAX_BYTES, type CaptureToolsState, type WorldlineBoxCaptureToolsApi } from '../../shared/capture-tools';
import type { CaptureAnswerUpdate } from '../../shared/capture-answer';
import { Icon } from '../Icons';
import { useLocale } from '../i18n';
import { useCaptureWords } from './messages';
import { CaptureAnswerContent } from './CaptureAnswerContent';
import './selection-assistant.css';

type Message = { role: 'user' | 'assistant'; content: string; reasoning?: string };
type ActiveQuestion = { id: string; previous: Message[]; question: string; sequence: number; update?: CaptureAnswerUpdate; unsubscribe?: () => void };

export function SelectionAssistant({ api, state, initialText = '', onClose }: {
  api: WorldlineBoxCaptureToolsApi;
  state: CaptureToolsState;
  initialText?: string;
  onClose(): void;
}) {
  const words = useCaptureWords();
  const [selection, setSelection] = useState(initialText);
  const { locale } = useLocale();
  const labels = locale === 'zh-CN' ? {
    pin: '保持在最前面', unpin: '取消置顶', edit: '编辑原文', collapse: '收起原文', temporary: '临时对话',
    explain: '解释', summarize: '总结', translate: '翻译', inputHint: 'Enter 发送 · Shift + Enter 换行',
    empty: '选中文字后，在任意应用中使用划词快捷键唤起。也可以粘贴或输入文字。',
    ready: '点击上方操作，或直接输入问题。可继续追问，关闭后清除。',
  } : {
    pin: 'Keep on top', unpin: 'Unpin window', edit: 'Edit original text', collapse: 'Collapse original text', temporary: 'Temporary',
    explain: 'Explain', summarize: 'Summarize', translate: 'Translate', inputHint: 'Enter to send · Shift + Enter for a new line',
    empty: 'Select text in any app and use the selection shortcut. You can also paste or type text here.',
    ready: 'Choose an action or ask a question. Follow up freely; closing clears this chat.',
  };
  const [expanded, setExpanded] = useState(!initialText.trim());
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<CaptureAnswerUpdate | undefined>();
  const [pasting, setPasting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pinning, setPinning] = useState(false);
  const active = useRef<ActiveQuestion | undefined>(undefined);
  const mounted = useRef(true);
  const conversation = useRef<HTMLElement>(null);
  const originalInput = useRef<HTMLTextAreaElement>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const bytes = new TextEncoder().encode(selection).length;
  const tooLong = bytes > CAPTURE_SELECTION_MAX_BYTES;
  const canSubmit = Boolean(state.ai.configured && selection.trim() && !tooLong && !asking && !pasting);
  const canAsk = Boolean(canSubmit && prompt.trim());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current) {
        releaseProgress(active.current);
        void api.request({ type: 'ask.cancel', id: active.current.id }).catch(() => undefined);
      }
      active.current = undefined;
    };
  }, [api]);
  useEffect(() => {
    const scroller = conversation.current;
    if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }, [messages, asking, answer]);
  useEffect(() => { (initialText.trim() ? questionInput : originalInput).current?.focus(); }, [initialText]);

  function releaseProgress(current: ActiveQuestion) {
    current.unsubscribe?.(); current.unsubscribe = undefined;
  }
  function stop() {
    const current = active.current; if (!current) return;
    active.current = undefined;
    releaseProgress(current);
    void api.request({ type: 'ask.cancel', id: current.id }).catch(() => undefined);
    setMessages(current.previous); setPrompt(current.question); setAsking(false); setAnswer(undefined); setNotice(words.selectionStopped);
  }
  function close() { stop(); onClose(); }
  const closeFromKeyboard = useEffectEvent(close);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); closeFromKeyboard(); } };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, []);
  function clear() {
    stop(); setMessages([]); setPrompt(''); setError(''); setNotice(''); setExpanded(!selection.trim());
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
  async function ask(value = prompt) {
    const question = value.trim();
    if (!canSubmit || !question || active.current) return;
    if (messages.filter(item => item.role === 'user').length >= 20) { setError(words.selectionTurnLimit); return; }
    const current: ActiveQuestion = { id: crypto.randomUUID(), previous: messages, question, sequence: 0 };
    const next: Message[] = [...messages, { role: 'user', content: question }];
    active.current = current; setMessages(next); setPrompt(''); setAsking(true); setAnswer(undefined); setError(''); setNotice(''); setExpanded(false);
    try {
      // Listen before invoking so the first provider token cannot race IPC setup.
      current.unsubscribe = api.onAnswerProgress?.(update => {
        if (!mounted.current || active.current !== current || update.id !== current.id || update.sequence <= current.sequence) return;
        current.sequence = update.sequence; current.update = { text: update.text, reasoning: update.reasoning };
        setAnswer(current.update);
      });
      const response = await api.request({ type: 'selection.ask', id: current.id, selection: selection.trim(), messages: next.map(({ role, content }) => ({ role, content })) });
      if (!mounted.current || active.current !== current) return;
      if (!response.ok) throw Error(response.error);
      if (!response.text?.trim()) throw Error(words.selectionEmptyAnswer);
      setMessages([...next, { role: 'assistant', content: response.text.trim(), reasoning: current.update?.reasoning }]);
    } catch (cause) {
      if (!mounted.current || active.current !== current) return;
      setMessages(current.previous); setPrompt(question); setError(cause instanceof Error ? cause.message : words.failed);
    } finally {
      releaseProgress(current);
      if (mounted.current && active.current === current) { active.current = undefined; setAsking(false); setAnswer(undefined); }
    }
  }
  async function copy(text: string) {
    try {
      const response = await api.request({ type: 'selection.copy', text });
      if (!response.ok) throw Error(response.error);
      if (mounted.current) setNotice(words.selectionCopied);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : words.failed); }
  }
  async function openLink(url: string) {
    try {
      const response = await api.request({ type: 'link.open', url });
      if (!response.ok) throw Error(response.error);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : words.failed); }
  }
  async function togglePin() {
    if (pinning) return;
    setPinning(true);
    try {
      const response = await api.request({ type: 'selection.pin', pinned: !state.selectionPinned });
      if (!response.ok) throw Error(response.error);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : words.failed); }
    finally { if (mounted.current) setPinning(false); }
  }
  const unavailable = !state.ai.configured;
  return <main className="capture-tools-window selection-assistant" data-selection-assistant>
    <header><div className="selection-heading"><span><Icon name="sparkles" size={17} /></span><h1>{words.selection}</h1><small title={words.selectionTemporary}>{labels.temporary}</small></div><div className="selection-header-actions"><button type="button" className="selection-icon-button selection-pin" aria-label={state.selectionPinned ? labels.unpin : labels.pin} title={state.selectionPinned ? labels.unpin : labels.pin} aria-pressed={Boolean(state.selectionPinned)} disabled={pinning} onClick={() => void togglePin()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m16 3 5 5-4 2-3 5-2-2-4 4-1-1 4-4-2-2 5-3 2-4Z" /><path d="m8 16-5 5" /></svg></button><button type="button" className="selection-icon-button" aria-label={words.selectionClear} title={words.selectionClear} disabled={!messages.length && !prompt} onClick={clear}><Icon name="trash" size={16} /></button><button type="button" className="selection-icon-button" aria-label={words.close} title={words.close} onClick={close}><Icon name="close" size={18} /></button></div></header>
    <section className={'selection-source' + (expanded ? ' is-expanded' : '')} aria-label={words.selectionOriginal}>
      <div className="selection-source-heading"><button type="button" aria-expanded={expanded} aria-controls="selection-source-text" title={expanded ? labels.collapse : labels.edit} onClick={() => setExpanded(value => !value)}><Icon name="type" size={13} /><strong>{words.selectionOriginal}</strong><Icon name={expanded ? 'chevron' : 'chevron-right'} size={13} /></button><button type="button" className="selection-icon-button" aria-label={words.selectionPaste} title={words.selectionPaste} disabled={asking || pasting} onClick={() => void paste()}><Icon name="clipboard" size={14} /></button></div>
      {expanded ? <div id="selection-source-text"><textarea ref={originalInput} aria-label={words.selectionOriginal} placeholder={words.selectionPlaceholder} value={selection} maxLength={32768} disabled={asking || pasting} onChange={event => updateSelection(event.target.value)} rows={3} /><p className="selection-source-hint">{tooLong ? words.selectionTooLong : selection.trim() ? words.selectionEditHint : labels.empty}</p></div> : <button type="button" className="selection-source-summary" onClick={() => setExpanded(true)} title={labels.edit}>{selection || labels.empty}</button>}
    </section>
    {!messages.length ? <nav className="selection-presets" aria-label={words.selectionEmptyTitle}>{([['sparkles', labels.explain, words.selectionExplain], ['scan-text', labels.summarize, words.selectionSummarize], ['languages', labels.translate, words.selectionTranslate]] as const).map(([icon, label, question]) => <button type="button" key={icon} aria-label={question} disabled={!canSubmit} onClick={() => void ask(question)}><Icon name={icon} size={14} />{label}</button>)}</nav> : null}
    <section ref={conversation} className="selection-conversation" aria-label={words.selectionConversation}>
      {!messages.length ? <div className="selection-empty"><Icon name="message-circle" size={17} /><p>{selection.trim() ? labels.ready : labels.empty}</p></div> : null}
      <div className="selection-messages" aria-live="polite" aria-relevant="additions text">{messages.map((message, index) => <article className={'is-' + message.role} key={index} aria-label={message.role === 'user' ? words.selectionYou : words.selectionModel}>{message.role === 'assistant' ? <><button type="button" className="selection-icon-button" aria-label={words.selectionCopy} title={words.selectionCopy} onClick={() => void copy(message.content)}><Icon name="copy" size={13} /></button><CaptureAnswerContent text={message.content} reasoning={message.reasoning} onOpenLink={url => void openLink(url)} /></> : <p>{message.content}</p>}</article>)}{asking ? <div className="selection-answer-draft" aria-label={words.selectionModel}><CaptureAnswerContent text={answer?.text ?? ''} reasoning={answer?.reasoning} pending onOpenLink={url => void openLink(url)} /></div> : null}</div>
    </section>
    <div className="selection-bottom">
      {unavailable || tooLong || error ? <p className="selection-error" role="alert">{error || (tooLong ? words.selectionTooLong : words.selectionConfigure)}</p> : notice ? <p className="selection-notice" role="status">{notice}</p> : null}
      <form className="selection-composer" onSubmit={event => { event.preventDefault(); void ask(); }}><textarea ref={questionInput} aria-label={words.selectionPrompt} placeholder={words.selectionPrompt} rows={2} maxLength={4000} value={prompt} disabled={unavailable || asking || pasting} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (!event.shiftKey || event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }} /><div><span title={state.ai.model}>{state.ai.model || 'LLM'}</span><small>{labels.inputHint}</small>{asking ? <button type="button" className="selection-submit is-stopping" aria-label={words.selectionStop} title={words.selectionStop} onClick={event => { event.preventDefault(); stop(); }}><Icon name="stop" size={14} /></button> : <button type="submit" className="selection-submit is-primary" aria-label={words.selectionSend} title={words.selectionSend} disabled={!canAsk}><Icon name="send" size={15} /></button>}</div></form>
    </div>
  </main>;
}
