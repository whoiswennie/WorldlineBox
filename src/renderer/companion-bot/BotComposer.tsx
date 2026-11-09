import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BotIcon } from './BotIcon';
import type { BotMediaRef, WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { BotStickerPicker } from './BotStickerPicker';
import { formatBotFileSize } from './BotAttachment';
import type { BotCompanion } from '../../shared/companion-bot';
import { BotMentionPicker } from './BotMentionPicker';
import { botMentionOptions, botMentionQuery, insertBotMention, type BotMentionOption } from './bot-mentions';
import { BotVoiceInput } from './BotVoiceInput';

const copy = {
  'zh-CN': { emoji: '表情', emojiTitle: '常用表情', memory: '记忆', history: '聊天记录', message: '发送消息…', send: '发送 ↑', keyboard: 'Enter 发送，Shift + Enter 换行', world: '发布世界事件' },
  en: { emoji: 'Emoji', emojiTitle: 'Common emoji', memory: 'Memory', history: 'Chat history', message: 'Write a message…', send: 'Send ↑', keyboard: 'Enter to send, Shift + Enter for a new line', world: 'Publish world event' },
};
export function BotComposer({ locale, draft, setDraft, disabled, busy, group, world, mentionMembers = [], panel, setPanel, send, mediaApi, conversationId, attachments = [], addingFiles = false, addFiles, removeFile, sendSticker, sendVoice, extraTools, status, cornerControl, onVoiceInputStart, onVoiceInputActivity, returnToChatOnPanel = false }: {
  locale: 'zh-CN' | 'en'; draft: string; setDraft(value: string): void; disabled: boolean; busy: boolean; group: boolean; world: boolean;
  panel: 'memory' | 'history' | null; setPanel(value: 'memory' | 'history' | null): void; send(kind?: 'message' | 'world'): Promise<unknown>;
  mediaApi?: WorldlineBoxBotMediaApi; conversationId: string; attachments?: readonly BotMediaRef[]; addingFiles?: boolean;
  addFiles(): Promise<void>; removeFile(id: string): void; sendSticker(media: BotMediaRef): Promise<void>;
  mentionMembers?: readonly BotCompanion[];
  sendVoice?(media: BotMediaRef): Promise<void>;
  extraTools?: ReactNode; status?: ReactNode; cornerControl?: ReactNode; onVoiceInputStart?(): void; onVoiceInputActivity?(active: boolean): void; returnToChatOnPanel?: boolean;
}) {
  const t = copy[locale], field = useRef<HTMLTextAreaElement>(null), popup = useRef<HTMLDivElement>(null);
  const [showExpressions, setShowExpressions] = useState(false), [expressionTab, setExpressionTab] = useState<'emoji' | 'stickers'>('emoji');
  const mentionId = 'bot-mentions-' + useId().replace(/[^A-Za-z0-9_-]/gu, ''), composing = useRef(false);
  const [selection, setSelection] = useState({ start: draft.length, end: draft.length }), [focused, setFocused] = useState(false);
  const [composition, setComposition] = useState(false), [dismissed, setDismissed] = useState(''), [activeMention, setActiveMention] = useState({ key: '', index: 0 });
  const mention = focused && !composition && !disabled && (group || world) && mentionMembers.length ? botMentionQuery(draft, selection.start, selection.end) : undefined;
  const mentionKey = mention ? `${mention.start}:${mention.end}:${mention.query}` : '', mentionOpen = !!mention && dismissed !== mentionKey;
  const mentions = mentionOpen ? botMentionOptions(mentionMembers, mention!.query, locale) : [];
  const selectedMention = Math.min(activeMention.key === mentionKey ? activeMention.index : 0, Math.max(0, mentions.length - 1));
  const readSelection = (textarea: HTMLTextAreaElement) => setSelection({ start: textarea.selectionStart, end: textarea.selectionEnd });
  const chooseMention = (option: BotMentionOption) => {
    if (!mention) return;
    const next = insertBotMention(draft, mention, option.mention); setDraft(next.text); setDismissed(mentionKey);
    setSelection({ start: next.caret, end: next.caret });
    requestAnimationFrame(() => { field.current?.focus(); field.current?.setSelectionRange(next.caret, next.caret); });
  };
  useLayoutEffect(() => { if (field.current) { field.current.style.height = '0'; field.current.style.height = `${Math.min(160, Math.max(48, field.current.scrollHeight))}px`; } }, [draft]);
  useEffect(() => {
    if (!showExpressions) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !popup.current?.contains(event.target)) setShowExpressions(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setShowExpressions(false); field.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [showExpressions]);
  const insertEmoji = (emoji: string) => {
    const start = field.current?.selectionStart ?? draft.length, end = field.current?.selectionEnd ?? start;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end)); setShowExpressions(false);
    requestAnimationFrame(() => { field.current?.focus(); field.current?.setSelectionRange(start + emoji.length, start + emoji.length); });
  };
  return <div className="bot-composer-dock"><form className="bot-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
    {cornerControl && <span className="bot-composer-corner">{cornerControl}</span>}
    <div className="bot-compose-tools"><div className="bot-emoji-anchor bot-expression-tools" ref={popup}>
      <button type="button" disabled={disabled} aria-label={t.emoji} title={locale === 'zh-CN' ? '表情与表情包' : 'Emoji and stickers'} aria-expanded={showExpressions} onClick={() => setShowExpressions(!showExpressions)}><BotIcon name="smile" /></button>
      {showExpressions && <BotStickerPicker api={mediaApi} initialTab={expressionTab} onTabChange={setExpressionTab} sendDisabled={busy} conversationId={conversationId} locale={locale}
        onEmoji={insertEmoji} onClose={() => setShowExpressions(false)}
        onSelect={media => { setShowExpressions(false); void sendSticker(media); }} />}
    </div>
      {mediaApi && <button type="button" disabled={disabled || addingFiles} title={locale === 'zh-CN' ? '添加文件（也可拖入）' : 'Attach files (or drop here)'} aria-label={locale === 'zh-CN' ? '添加文件' : 'Attach files'} onClick={() => void addFiles()}><BotIcon name="file" /></button>}
      <BotVoiceInput key={conversationId} conversationId={conversationId} locale={locale} disabled={disabled || busy || addingFiles} textOnly={!sendVoice} onText={text => setDraft((draft ? draft + '\n' : '') + text)} onVoice={sendVoice} onStart={onVoiceInputStart} onActivityChange={onVoiceInputActivity} />
      {extraTools}
      <span className="bot-tool-separator" />
      {(['memory', 'history'] as const).map(key => <button key={key} type="button" disabled={disabled} title={returnToChatOnPanel ? locale === 'zh-CN' ? `结束会面，返回私聊查看${t[key]}` : `End meeting and view ${t[key].toLowerCase()} in chat` : t[key]} aria-label={t[key]} aria-pressed={panel === key} onClick={() => setPanel(panel === key ? null : key)}><BotIcon name={key} /><span className="bot-sr-only">{t[key]}</span></button>)}
      {(group || world) && <small>{locale === 'zh-CN' ? '输入 @ 选择聊天成员' : 'Type @ to choose a chat member'}</small>}
    </div>
    {(!!attachments.length || addingFiles) && <div className="bot-draft-attachments">{attachments.map(media => <div key={media.id}>
      {media.previewUrl ? <img alt="" src={media.previewUrl} /> : <BotIcon name="file" />}<span><strong>{media.name}</strong><small>{formatBotFileSize(media.size)}</small></span><button type="button" aria-label={`${locale === 'zh-CN' ? '移除' : 'Remove'} ${media.name}`} onClick={() => removeFile(media.id)}>×</button>
    </div>)}{addingFiles && <small role="status">{locale === 'zh-CN' ? '正在添加文件…' : 'Adding files…'}</small>}</div>}
    {attachments.length > 16 && <small className="bot-attachment-limit" role="alert">{locale === 'zh-CN' ? '每条消息最多16个附件，请移除多余附件后分批发送。' : 'Up to 16 attachments per message. Remove extras and send them separately.'}</small>}
    {mentionOpen && <BotMentionPicker id={mentionId} options={mentions} active={selectedMention} locale={locale} onSelect={chooseMention} onActive={index => setActiveMention({ key: mentionKey, index })} />}
    <textarea ref={field} aria-label={t.message} placeholder={t.message} value={draft} disabled={disabled} rows={2} maxLength={64000}
      role={mentionOpen ? 'combobox' : undefined} aria-autocomplete={mentionOpen ? 'list' : undefined} aria-expanded={mentionOpen || undefined}
      aria-controls={mentionOpen ? mentionId : undefined} aria-activedescendant={mentionOpen && mentions.length ? `${mentionId}-${selectedMention}` : undefined}
      onFocus={event => { setFocused(true); readSelection(event.currentTarget); }} onBlur={() => setFocused(false)}
      onSelect={event => readSelection(event.currentTarget)} onClick={event => readSelection(event.currentTarget)} onKeyUp={event => readSelection(event.currentTarget)}
      onCompositionStart={() => { composing.current = true; setComposition(true); }} onCompositionEnd={event => { composing.current = false; setComposition(false); readSelection(event.currentTarget); }}
      onChange={event => { setDraft(event.target.value); readSelection(event.currentTarget); setDismissed(''); }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (mentionOpen && ['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key) && !event.shiftKey) {
          event.preventDefault();
          if (event.key === 'Escape') setDismissed(mentionKey);
          else if (event.key === 'Enter') { if (mentions[selectedMention]) chooseMention(mentions[selectedMention]!); }
          else if (mentions.length) setActiveMention({ key: mentionKey, index: (selectedMention + (event.key === 'ArrowDown' ? 1 : -1) + mentions.length) % mentions.length });
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
      }} />
    <div className="bot-compose-footer"><small>{t.keyboard}</small>{world && <button type="button" disabled={disabled || !draft.trim() || busy || addingFiles || !!attachments.length} onClick={() => void send('world')}>{t.world}</button>}<button className="bot-send" aria-label={t.send} disabled={disabled || (!draft.trim() && !attachments.length) || attachments.length > 16 || busy || addingFiles}><span className="bot-sr-only">{t.send}</span><BotIcon name="arrow" /></button></div>
  </form>{status}</div>;
}
