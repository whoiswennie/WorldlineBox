import { useEffect, useState } from 'react';
import { BOT_MEDIA_TEXT_PAGE_MAX_BYTES, BOT_TEXT_EDIT_BYTES, type BotMediaTextPage, type WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';

type Props = {
  first: BotMediaTextPage; api: WorldlineBoxBotMediaApi; conversationId: string; id: string; zh: boolean; busy: boolean;
  setDirty(value: boolean): void; onBack(): void; onExport(content: string): Promise<boolean>;
};
export function BotTextEditor({ first, api, conversationId, id, zh, busy, setDirty, onBack, onExport }: Props) {
  const [source, setSource] = useState<string>(), [draft, setDraft] = useState(''), [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0), [savedDraft, setSavedDraft] = useState<string>();
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        let page = first, content = first.offset === 0 ? first.content : '', next = first.offset === 0 ? first.nextOffset : 0;
        if (first.totalBytes > BOT_TEXT_EDIT_BYTES) throw Error(zh ? '文档超过编辑容量。' : 'Document exceeds editor capacity.');
        while (next !== undefined && active) {
          const result = await api.request({ type: 'media.text.read', conversationId, id, offset: next, limit: BOT_MEDIA_TEXT_PAGE_MAX_BYTES });
          page = result.textPage!;
          if (!result.ok || !page || page.totalBytes !== first.totalBytes || page.offset !== next ||
            (page.nextOffset !== undefined && (page.nextOffset <= next || page.nextOffset > first.totalBytes))) throw Error(result.error || (zh ? '无法读取完整文档。' : 'Could not load the full document.'));
          content += page.content;
          next = page.nextOffset;
        }
        if (active) { setSource(content); setDraft(content.replace(/\r\n?/g, '\n')); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : String(e)); }
    }
    void load();
    return () => { active = false; };
  }, [first, api, conversationId, id, zh, attempt]);
  const original = source?.replace(/\r\n?/g, '\n');
  const crlf = source?.includes('\r\n') && !source.replaceAll('\r\n', '').includes('\n');
  return <div className="bot-text-reader"><div className="attachment-tools"><strong>{zh ? '编辑原文' : 'Edit source'}</strong><span>UTF-8</span><div className="attachment-spacer"/>
    <button disabled={busy} onClick={onBack}>{zh ? '返回阅读' : 'Back to reader'}</button>
    <button className="attachment-primary" disabled={busy || source === undefined} onClick={async () => {
      const text = original === draft ? source! : crlf ? draft.replaceAll('\n', '\r\n') : draft;
      if (await onExport(text)) { setSavedDraft(draft); setDirty(false); }
    }}>{zh ? '另存副本' : 'Save copy'}</button></div>
    {source === undefined ? <div className="bot-attachment-viewer-empty" role="status">{error || (zh ? '正在读取完整文档…' : 'Loading document…')}{error && <button onClick={() => { setError(''); setAttempt(n => n + 1); }}>{zh ? '重试' : 'Retry'}</button>}</div>
    : <textarea autoFocus className="attachment-text-editor" aria-label={zh ? '文档编辑区' : 'Document editor'} spellCheck={false} readOnly={busy} value={draft} onChange={e => { setDraft(e.target.value); setDirty(e.target.value !== (savedDraft ?? original)); }}/>}
    <footer className="attachment-tools attachment-status">{zh ? '导出编码 UTF-8' : 'Export encoding UTF-8'}<div className="attachment-spacer"/>{draft.length.toLocaleString()} {zh ? '字符' : 'characters'}</footer>
  </div>;
}

