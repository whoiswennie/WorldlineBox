import { useEffect, useRef, useState } from 'react';

import type { BrowserCaptureRequest, BrowserCaptureResponse, BrowserCaptureTextDraft } from '../../shared/browser-capture';
import { Icon } from '../Icons';
import { useT } from '../i18n';
import { Button, TextField } from '../ui';

/** Selection drafts live only in this mounted page, never in browser storage. */
export function BrowserCaptureTextSave({ disabled, busy, run }: {
  disabled: boolean;
  busy: boolean;
  run(request: BrowserCaptureRequest): Promise<BrowserCaptureResponse | undefined>;
}) {
  const t = useT();
  const b = (key: string) => t('browser.' + key);
  const [draft, setDraft] = useState<BrowserCaptureTextDraft>();
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);

  async function prepare() {
    const current = ++sequence.current;
    const result = await run({ type: 'text.prepare' });
    if (current === sequence.current && result?.ok && result.textDraft) setDraft(result.textDraft);
  }

  async function save() {
    if (!draft || disabled || !draft.text.trim() || !draft.title.trim()) return;
    const current = ++sequence.current;
    const result = await run({ type: 'text.save', draftId: draft.id, text: draft.text, title: draft.title.trim() });
    if (current === sequence.current && result?.ok) setDraft(undefined);
  }

  function cancel() { sequence.current++; setDraft(undefined); }

  return <>
    <button className="capture-action" disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={() => void prepare()} type="button"><Icon name="type" size={19} /><span>{b('captureSelectedText')}</span></button>
    {draft ? <section aria-label={b('captureTextPreview')} className="capture-text-preview">
      <div className="capture-section-heading"><h3><Icon name="type" size={15} />{b('captureTextPreview')}</h3><Button iconName="close" size="sm" variant="quiet" aria-label={b('cancel')} disabled={busy} onClick={cancel} /></div>
      <p className="capture-text-hint">{b('captureTextHint')}</p>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <TextField label={b('captureTextTitle')} maxLength={180} disabled={busy} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} />
        <label className="capture-text-content"><span>{b('captureTextContent')}</span><textarea aria-label={b('captureTextContent')} disabled={busy} value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })} onKeyDown={event => {
          if (!event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!disabled && draft.text.trim() && draft.title.trim()) event.currentTarget.form?.requestSubmit(); }
        }} spellCheck={false} /></label>
        <div className="capture-text-meta"><span>{b('captureTextLength')} {draft.text.length.toLocaleString()}</span><span>TXT</span></div>
        <details className="capture-text-source"><summary>{b('captureTextSource')}</summary><strong>{draft.pageTitle}</strong><span>{draft.sourcePageUrl}</span></details>
        <div className="capture-text-actions"><Button iconName="refresh" size="sm" variant="quiet" disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={() => void prepare()}>{b('captureTextReadAgain')}</Button><Button iconName="save" size="sm" disabled={disabled || !draft.text.trim() || !draft.title.trim()} type="submit">{b('captureTextSave')}</Button></div>
      </form>
    </section> : null}
  </>;
}
