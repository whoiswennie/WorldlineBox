import { useBotCallDocument } from './call-pet';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BotIcon } from './BotIcon';
import type { BotMediaRef, WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { BotStickerPicker } from './BotStickerPicker';
import { BotDraftAttachments } from './BotDraftAttachments';
import type { BotCompanion, WorldlineBoxBotApi } from '../../shared/companion-bot';
import { BotMentionPicker } from './BotMentionPicker';
import { botMentionOptions, botMentionQuery, insertBotMention, type BotMentionOption } from './bot-mentions';
import { BotVoiceInput } from './BotVoiceInput';
import { BotDesktopCapture } from './BotDesktopCapture';

const copy = {
  'zh-CN': { emoji: '表情', emojiTitle: '常用表情', memory: '记忆', history: '聊天记录', message: '发送消息…', send: '发送 ↑', keyboard: 'Enter 发送，Shift + Enter 换行', world: '发布世界事件' },
  en: { emoji: 'Emoji', emojiTitle: 'Common emoji', memory: 'Memory', history: 'Chat history', message: 'Write a message…', send: 'Send ↑', keyboard: 'Enter to send, Shift + Enter for a new line', world: 'Publish world event' },
};
export function useBotInputActivity(api: WorldlineBoxBotApi | undefined, conversationId: string) {
  const last = useRef<{ room: string; at: number }>(undefined);
  return useCallback(() => {
    if (!api || !conversationId) return;
    const now = performance.now();
    if (last.current?.room === conversationId && now - last.current.at < 5000) return;
    last.current = { room: conversationId, at: now };
    void api.request({ type: 'chat.activity', conversationId }).catch(() => undefined);
  }, [api, conversationId]);
}
export function BotSpeechMuteButton({ zh, muted, onChange }: { zh: boolean; muted: boolean; onChange(value: boolean): void }) {
  return <button type="button" aria-label={zh ? '伙伴语音静音' : 'Mute companion speech'} aria-pressed={muted}
    title={zh ? '伙伴语音静音（跳过语音合成）' : 'Mute companion speech and skip synthesis'} onClick={() => onChange(!muted)}>
    <BotIcon name={muted ? 'volume-off' : 'volume'} /></button>;
}
export function BotComposer({ locale, draft, setDraft, disabled, busy, group, world, mentionMembers = [], panel, setPanel, send, mediaApi, conversationId, attachments = [], addingFiles = false, addFiles, removeFile, sendSticker, sendVoice, extraTools, status, topicControls, onVoiceInputStart, onVoiceInputActivity, onTypingActivity, onUserActivity, meeting = false, showInputTools = true, compact = false, desktopCapture, pushToTalkShortcut, voiceCaptureBusy }: {
  locale: 'zh-CN' | 'en'; draft: string; setDraft(value: string): void; disabled: boolean; busy: boolean; group: boolean; world: boolean;
  panel: 'memory' | 'history' | null; setPanel(value: 'memory' | 'history' | null): void; send(kind?: 'message' | 'world'): Promise<unknown>;
  mediaApi?: WorldlineBoxBotMediaApi; conversationId: string; attachments?: readonly BotMediaRef[]; addingFiles?: boolean;
  addFiles(): Promise<void>; removeFile(id: string): void; sendSticker(media: BotMediaRef): Promise<void>;
  mentionMembers?: readonly BotCompanion[];
  sendVoice?(media: BotMediaRef): Promise<void>;
  extraTools?: ReactNode; status?: ReactNode; topicControls?: ReactNode;
  onVoiceInputStart?(): void; onVoiceInputActivity?(active: boolean): void; onTypingActivity?(active: boolean): void; meeting?: boolean; showInputTools?: boolean; compact?: boolean;
  pushToTalkShortcut?: boolean; voiceCaptureBusy?: boolean;
  onUserActivity?(): void;
  desktopCapture?: { surface: 'chat' | 'pet'; companionName?: string; attach(media: BotMediaRef[]): void; statusTarget?: HTMLElement | null; controlsTarget?: HTMLElement | null; interacting?: boolean };
}) {
  const surface = useBotCallDocument();
  const t = copy[locale], field = useRef<HTMLTextAreaElement>(null), popup = useRef<HTMLDivElement>(null);
  const [showExpressions, setShowExpressions] = useState(false), [expressionTab, setExpressionTab] = useState<'emoji' | 'stickers'>('emoji');
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureFileRequest, setCaptureFileRequest] = useState(0);
  const [captureStatus, setCaptureStatus] = useState<HTMLDivElement | null>(null);
  const [captureControls, setCaptureControls] = useState<HTMLDivElement | null>(null);
  const canTranscribeFile = !!desktopCapture && !!mediaApi?.desktopCaptureSupported && !disabled && !busy && !addingFiles && attachments.length < 16;
  const draftNow = useRef(draft);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const markTyping = (active: boolean) => {
    if (!onTypingActivity) return;
    clearTimeout(typingTimer.current);
    onTypingActivity(active);
    if (active) typingTimer.current = setTimeout(() => onTypingActivity(false), 5000);
  };
  useEffect(() => () => { clearTimeout(typingTimer.current); onTypingActivity?.(false); }, [onTypingActivity]);
  useLayoutEffect(() => { draftNow.current = draft; }, [draft]);
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
  useLayoutEffect(() => {
    if (!field.current) return;
    field.current.style.height = '0';
    field.current.style.height = `${Math.min(compact ? 78 : 160, Math.max(compact ? 30 : 48, field.current.scrollHeight))}px`;
  }, [compact, draft, showInputTools, surface]);
  useEffect(() => {
    if (!showExpressions || !showInputTools) return;
    const outside = (event: PointerEvent) => { if (event.target && (event.target as Node).nodeType && !popup.current?.contains(event.target as Node)) setShowExpressions(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setShowExpressions(false); field.current?.focus(); } };
    surface.addEventListener('pointerdown', outside); surface.addEventListener('keydown', escape);
    return () => { surface.removeEventListener('pointerdown', outside); surface.removeEventListener('keydown', escape); };
  }, [showExpressions, showInputTools, surface]);
  const insertEmoji = (emoji: string) => {
    const start = field.current?.selectionStart ?? draft.length, end = field.current?.selectionEnd ?? start;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end)); setShowExpressions(false);
    requestAnimationFrame(() => { field.current?.focus(); field.current?.setSelectionRange(start + emoji.length, start + emoji.length); });
  };
  return <div className="bot-composer-dock">{desktopCapture?.surface === 'chat' && <>
    <div className="bot-capture-controls-row" ref={setCaptureControls} /><div className="bot-capture-status-row" ref={setCaptureStatus} />
  </>}
    {topicControls}<form className={`bot-composer${compact ? ' is-compact' : ''}`} onSubmit={event => { event.preventDefault(); if (!captureBusy) void send(); }}>
    <div className="bot-compose-tools">{showInputTools && <><div className="bot-emoji-anchor bot-expression-tools" ref={popup}>
      <button type="button" disabled={disabled} aria-label={t.emoji} title={locale === 'zh-CN' ? '表情与表情包' : 'Emoji and stickers'} aria-expanded={showExpressions} onClick={() => setShowExpressions(!showExpressions)}><BotIcon name="smile" /></button>
      {showExpressions && <BotStickerPicker api={mediaApi} initialTab={expressionTab} onTabChange={setExpressionTab} sendDisabled={busy} conversationId={conversationId} locale={locale}
        onEmoji={insertEmoji} onClose={() => setShowExpressions(false)}
        onSelect={media => { setShowExpressions(false); void sendSticker(media); }} />}
    </div>
      {mediaApi && <button type="button" disabled={disabled || addingFiles}
        title={locale === 'zh-CN' ? (canTranscribeFile ? '添加文件 · 右键转写音视频文件' : '添加文件（也可拖入）') : (canTranscribeFile ? 'Attach files · Right-click to transcribe media' : 'Attach files (or drop here)')}
        aria-label={locale === 'zh-CN' ? '添加文件' : 'Attach files'} onClick={() => void addFiles()}
        onContextMenu={event => { if (canTranscribeFile) { event.preventDefault(); setCaptureFileRequest(value => value + 1); } }}>
        <BotIcon name="file" /></button>}
      <BotVoiceInput key={conversationId} conversationId={conversationId} locale={locale} disabled={disabled || busy || addingFiles || voiceCaptureBusy}
        pushToTalkShortcut={pushToTalkShortcut} textOnly={!sendVoice} onText={text => setDraft((draft ? draft + '\n' : '') + text)} onVoice={sendVoice} onStart={() => { onUserActivity?.(); onVoiceInputStart?.(); }} onActivityChange={onVoiceInputActivity} />
      </>}
      {desktopCapture && mediaApi?.desktopCaptureSupported && <BotDesktopCapture key={conversationId + ':' + desktopCapture.surface} api={mediaApi} conversationId={conversationId} locale={locale} surface={desktopCapture.surface}
        statusTarget={desktopCapture.statusTarget ?? (desktopCapture.surface === 'chat' ? captureStatus : null)}
        controlsTarget={desktopCapture.controlsTarget ?? (desktopCapture.surface === 'chat' ? captureControls : null)}
        meeting={meeting} interacting={desktopCapture.interacting} companionName={desktopCapture.companionName}
        allowPresence={meeting}
        fileRequest={captureFileRequest} onBusy={setCaptureBusy} onAttachment={media => {
          desktopCapture.attach(media);
          if (!draftNow.current.trim()) setDraft(locale === 'zh-CN'
            ? '请看看这份音频转写。' : 'Take a look at this audio transcript.');
        }} />}
      {extraTools}
      {!meeting && <><span className="bot-tool-separator" />
      {(['memory', 'history'] as const).map(key => <button key={key} type="button" disabled={disabled} title={t[key]} aria-label={t[key]} aria-pressed={panel === key} onClick={() => setPanel(panel === key ? null : key)}><BotIcon name={key} /><span className="bot-sr-only">{t[key]}</span></button>)}</>}
      {(group || world) && <small>{locale === 'zh-CN' ? '输入 @ 选择聊天成员' : 'Type @ to choose a chat member'}</small>}
    </div>
    {(!!attachments.length || addingFiles) && <BotDraftAttachments attachments={attachments} addingFiles={addingFiles}
      removeFile={removeFile} locale={locale} mediaApi={mediaApi} conversationId={conversationId} />}
    {mentionOpen && <BotMentionPicker id={mentionId} options={mentions} active={selectedMention} locale={locale} onSelect={chooseMention} onActive={index => setActiveMention({ key: mentionKey, index })} />}
    <textarea ref={field} aria-label={t.message} placeholder={t.message} value={draft} disabled={disabled} rows={2} maxLength={64000}
      role={mentionOpen ? 'combobox' : undefined} aria-autocomplete={mentionOpen ? 'list' : undefined} aria-expanded={mentionOpen || undefined}
      aria-controls={mentionOpen ? mentionId : undefined} aria-activedescendant={mentionOpen && mentions.length ? `${mentionId}-${selectedMention}` : undefined}
      onFocus={event => { setFocused(true); readSelection(event.currentTarget); }} onBlur={() => setFocused(false)}
      onSelect={event => readSelection(event.currentTarget)} onClick={event => readSelection(event.currentTarget)} onKeyUp={event => readSelection(event.currentTarget)}
      onCompositionStart={() => { onUserActivity?.(); composing.current = true; setComposition(true); markTyping(true); }} onCompositionUpdate={onUserActivity} onCompositionEnd={event => { onUserActivity?.(); composing.current = false; setComposition(false); readSelection(event.currentTarget); }}
      onChange={event => { onUserActivity?.(); setDraft(event.target.value); markTyping(!!event.target.value); readSelection(event.currentTarget); setDismissed(''); }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (mentionOpen && ['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key) && !event.shiftKey) {
          event.preventDefault();
          if (event.key === 'Escape') setDismissed(mentionKey);
          else if (event.key === 'Enter') { if (mentions[selectedMention]) chooseMention(mentions[selectedMention]!); }
          else if (mentions.length) setActiveMention({ key: mentionKey, index: (selectedMention + (event.key === 'ArrowDown' ? 1 : -1) + mentions.length) % mentions.length });
          return;
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!captureBusy) void send(); }
      }} />
    <div className="bot-compose-footer"><small>{t.keyboard}</small>{world && <button type="button" disabled={disabled || !draft.trim() || busy || addingFiles || !!attachments.length} onClick={() => void send('world')}>{t.world}</button>}<button className="bot-send" aria-label={t.send} disabled={disabled || (!draft.trim() && !attachments.length) || attachments.length > 16 || busy || addingFiles || captureBusy}><span className="bot-sr-only">{t.send}</span><BotIcon name="arrow" /></button></div>
  </form>{status}</div>;
}
