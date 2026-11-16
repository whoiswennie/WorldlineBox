import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { BotMessage, WorldlineBoxBotApi } from '../../shared/companion-bot';
import { botCallGestureLabels, botCallMotionId, type BotCallCue, type BotCallModelCatalog, type BotCallStage } from '../../shared/companion-call';
import { callCaptionPlaybackPages, CALL_CAPTION_AUTO_HIDE_MS, callCaptionHoldMs } from '../../shared/companion-call-captions';
import type { BotLive2DControls } from './BotLive2DStage';
import { BotIcon } from './BotIcon';
import { BotCallProgress } from './BotReplyProgress';
import { speechPlaybackKey, useBotSpeech } from './useBotSpeech';
import { observeCallBubble } from './call-bubble-placement';
import { useBotCallDocument } from './call-pet';

interface Beat { id: string; messageId: string; partId?: string; sequence: number; text: string; cue: BotCallCue }
export interface BotCallPlayback {
  replies: readonly string[];
  pending: readonly string[];
}
export interface BotCallTurn {
  id: string;
  content: string;
  replyIds?: readonly string[];
  failed?: boolean;
}

export function isCallTurnReply(message: BotMessage, turn?: BotCallTurn): boolean {
  return message.senderId !== 'user' && (!turn || !!turn.replyIds?.includes(message.id));
}

export function BotCallDialogue({ messages, baseline, ignored, connectedAt, catalog, stage, control, modelLoading, hidden, zh, onHistory, onPresent, onPlayback, onInterrupt, onNotice, onReplay, interrupted, extra, turn, speechApi, conversationId, muted, voiceHold, speechStop }: {
  messages: readonly BotMessage[]; baseline: ReadonlySet<string>; connectedAt: number; control?: BotLive2DControls; hidden: boolean;
  catalog?: BotCallModelCatalog;
  stage?: BotCallStage;
  modelLoading?: boolean;
  ignored: ReadonlySet<string>; interrupted: boolean;
  onPresent(messageId: string, segmentId: string, sequence: number): void;
  onPlayback(playback: BotCallPlayback): void;
  onInterrupt(): void;
  onNotice(text: string): void;
  onReplay?(): void;
  zh: boolean; onHistory(messageId: string): void; extra?: ReactNode;
  turn?: BotCallTurn;
  speechApi?: WorldlineBoxBotApi;
  conversationId?: string;
  muted?: boolean;
  voiceHold?: boolean;
  speechStop?: RefObject<(() => void) | undefined>;
}) {
  const [speechError, setSpeechError] = useState('');
  const { active: speakingPart, play: playSpeech, stop: stopSpeech } = useBotSpeech(speechApi, setSpeechError);
  useLayoutEffect(() => {
    if (!speechStop) return;
    speechStop.current = stopSpeech;
    return () => { if (speechStop.current === stopSpeech) speechStop.current = undefined; };
  }, [speechStop, stopSpeech]);
  const [timeline, setTimeline] = useState<{ source?: readonly BotMessage[]; ignored?: ReadonlySet<string>; turn?: BotCallTurn; beats: Beat[] }>({ beats: [] });
  let beats = timeline.beats;
  const [position, setPosition] = useState(0);
  const [paused, setPaused] = useState(false);
  const [expired, setExpired] = useState<string>();
  const [replay, setReplay] = useState(0);
  const [manual, setManual] = useState(false);
  const [bubbleView, setBubbleView] = useState<{ reply: string; mode: 'collapsed' | 'reviewing' }>();
  const startedAt = useRef(0);
  const completedThrough = useRef(-1);
  const bubble = useRef<HTMLElement>(null);
  if (timeline.source !== messages || timeline.ignored !== ignored || timeline.turn !== turn) {
    const incoming = messages.flatMap((message): Beat[] => {
      if (ignored.has(message.id) || !isCallTurnReply(message, turn)
        || (Date.parse(message.createdAt) < connectedAt && !['queued', 'running'].includes(message.status))) return [];
      const presentation = message.parts?.filter(part => part.presentation && part.text?.trim()) ?? [];
      if (presentation.length) return presentation.flatMap(part => baseline.has(part.id) ? [] : [{
        id: part.id, partId: part.id, messageId: message.id, sequence: part.sequence, text: part.text!, cue: part.presentation!,
      }]);
      const id = `message:${message.id}`;
      return message.status === 'sent' && message.content.trim() && !baseline.has(id)
        ? [{ id, messageId: message.id, sequence: message.sequence, text: message.content, cue: {} }] : [];
    });
    const known = new Set(beats.map(beat => beat.id));
    const added = incoming.filter(beat => !known.has(beat.id));
    if (added.length) beats = [...beats, ...added];
    setTimeline({ source: messages, ignored, turn, beats });
  }
  const pages = useMemo(() => beats.flatMap(beat => {
    const pages = callCaptionPlaybackPages(beat.text).map((page, speechPage) => ({ ...page, beat, speechPage, hold: callCaptionHoldMs(page.text) }));
    if (!pages.length) return pages;
    const motion = catalog?.motions.find(item => botCallMotionId(item) === beat.cue.motion);
    const readingTime = pages.reduce((total, page) => total + page.hold, 0);
    const minimum = Math.max(beat.cue.durationMs ?? 0, (motion?.duration ?? 0) * 1000, beat.cue.expression ? 1800 : 0, beat.cue.gesture ? 900 : 0);
    pages[pages.length - 1]!.hold += Math.max(0, minimum - readingTime);
    return pages;
  }), [beats, catalog]);
  const page = pages[position], beat = page?.beat;
  const replyKey = beat?.messageId;
  const bubbleMode = bubbleView?.reply === replyKey ? bubbleView?.mode : undefined;
  const pageKey = page && `${page.beat.id}:${page.start}`;
  const activeBeat = hidden || voiceHold || paused && !manual || pageKey === expired ? undefined : beat;
  const currentCue = modelLoading ? undefined : activeBeat?.cue;
  const speechIndex = page?.speechPage;
  const speechBeat = !muted && !modelLoading ? activeBeat : undefined;
  useEffect(() => {
    if (!speechBeat || !conversationId) return;
    playSpeech(conversationId, speechBeat.messageId, speechBeat.partId, control?.audio, speechIndex);
    return stopSpeech;
  }, [speechBeat, speechIndex, conversationId, control, replay, playSpeech, stopSpeech]);
  const language = zh ? 0 : 1;
  const expression = currentCue?.expression ? stage?.expressions.find(item => item.name === currentCue.expression) : undefined;
  const motion = currentCue?.motion ? stage?.motions.find(item => item.id === currentCue.motion) : undefined;
  const gesture = currentCue?.gesture && stage?.gestures.includes(currentCue.gesture) ? botCallGestureLabels[currentCue.gesture][language] : undefined;
  const latest = messages.findLast(message => isCallTurnReply(message, turn) && !ignored.has(message.id)
    && (Date.parse(message.createdAt) >= connectedAt || ['queued', 'running'].includes(message.status)));
  const pending = latest ? ['queued', 'running'].includes(latest.status)
    : !!turn && !turn.failed && (turn.replyIds === undefined || (!interrupted && turn.replyIds.length > 0));
  const noPresentation = latest?.status === 'sent' && !latest.content.trim() && !latest.parts?.some(part => part.presentation) && !latest.attachments?.length;
  const error = latest?.status === 'failed';
  const presenting = !!page && (pageKey !== expired || position + 1 < pages.length);
  const completed = !!page && !pending && !presenting && !paused && !extra;
  const collapsed = !!page && bubbleMode === 'collapsed';
  const active = !!pending || presenting;
  const status = turn?.failed ? (zh ? '消息未发出' : 'Message not sent')
    : error || noPresentation ? (zh ? '这次会面回应未能发布，请再试一次。' : 'The meeting reply could not be published. Try again.')
    : latest?.status === 'cancelled' ? (zh ? '这次回应已中止' : 'The reply stopped')
      : presenting ? (paused ? (zh ? '呈现已暂停' : 'Presentation paused') : (zh ? '正在呈现' : 'Presenting'))
        : pending ? (zh ? '正在回应…' : 'Replying…')
          : latest ? (zh ? '回应结束 · 可以继续' : 'Reply complete · Your turn')
            : interrupted ? (zh ? '已打断 · 可以继续' : 'Interrupted · Your turn')
              : turn?.replyIds?.length === 0 ? (zh ? '消息已发送' : 'Message sent') : '';

  useLayoutEffect(() => {
    control?.present(activeBeat?.cue, activeBeat?.text);
  }, [control, activeBeat, replay]);
  useLayoutEffect(() => {
    control?.presence?.(activeBeat ? 'speaking' : pending ? 'waiting' : 'idle');
  }, [control, activeBeat, pending]);
  useLayoutEffect(() => () => { control?.present(); control?.presence?.('idle'); }, [control]);
  useLayoutEffect(() => {
    if (beat?.partId && !hidden) onPresent(beat.messageId, beat.partId, beat.sequence);
  }, [beat, hidden, onPresent]);
  useLayoutEffect(() => {
    const replies = [...new Set(beats.map(item => item.messageId))];
    if (pageKey && pageKey === expired) completedThrough.current = Math.max(completedThrough.current, position);
    const pending = [...new Set(pages.slice(Math.max(position, completedThrough.current + 1)).map(item => item.beat.messageId))];
    onPlayback({ replies, pending });
    return () => onPlayback({ replies: [], pending: [] });
  }, [beats, pages, position, pageKey, expired, onPlayback]);
  useLayoutEffect(() => { startedAt.current = performance.now(); }, [pageKey, hidden, paused, modelLoading, replay, voiceHold]);
  useEffect(() => {
    if (!page || (paused && !manual) || hidden || modelLoading || voiceHold || pageKey === expired && (manual || position + 1 >= pages.length)) return;
    if (speakingPart === speechPlaybackKey(page.beat.messageId, page.beat.partId, page.speechPage)) return;
    const remaining = pageKey === expired ? 0 : Math.max(0, page.hold - (performance.now() - startedAt.current));
    const timer = setTimeout(() => {
      if (!paused && position + 1 < pages.length) {
        completedThrough.current = Math.max(completedThrough.current, position);
        setPosition(index => index === position ? index + 1 : index);
      }
      else { setExpired(pageKey); setManual(false); }
    }, remaining);
    return () => clearTimeout(timer);
  }, [page, pageKey, expired, hidden, paused, manual, modelLoading, position, pages, replay, speakingPart, voiceHold]);
  useEffect(() => {
    if (!completed || hidden || !replyKey || bubbleMode) return;
    const timer = setTimeout(() => setBubbleView({ reply: replyKey, mode: 'collapsed' }), CALL_CAPTION_AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [completed, hidden, replyKey, bubbleMode]);

  const step = (next: number, auto = false) => {
    onReplay?.();
    setPaused(!auto); setManual(!auto); setExpired(undefined); setBubbleView(undefined); setPosition(next); setReplay(value => value + 1);
  };
  const toggleAutoplay = () => {
    if (paused) {
      step(position, true);
    } else if (presenting) {
      setPaused(true);
      setManual(false);
    } else step(0, true);
  };
  const autoLabel = paused ? (zh ? '继续自动播放' : 'Resume autoplay') : (zh ? '自动播放' : 'Autoplay');
  const historyLabel = zh ? '完整对话' : 'Transcript';
  const interruptLabel = zh ? '打断' : 'Interrupt';
  const expandLabel = zh ? '展开对白' : 'Expand dialogue';
  const collapseLabel = zh ? '收起对白' : 'Collapse dialogue';
  const shown = !hidden && !!(page || status || extra);
  const surface = useBotCallDocument();
  useLayoutEffect(() => {
    const node = bubble.current, scene = node?.closest<HTMLElement>('.bot-call-scene');
    if (node && scene) return observeCallBubble(node, scene);
  }, [shown, surface, modelLoading]);

  if (!shown) return null;
  const interrupt = active && <button type="button" className="bot-call-interrupt" disabled={!!turn && !turn.replyIds}
    aria-label={interruptLabel} title={interruptLabel} onClick={() => {
      if (!pending && position <= completedThrough.current && completedThrough.current + 1 >= pages.length) {
        setPaused(true); setManual(false); setExpired(pageKey);
      } else onInterrupt();
    }}><BotIcon name="stop" /></button>;
  const visibleStatus = !page || turn?.failed || error || noPresentation || latest?.status === 'cancelled';
  return <section ref={bubble} className="bot-call-visual-novel" aria-label={zh ? '伙伴当前回应' : 'Current companion reply'}
    data-call-dialogue-message={beat?.messageId} data-call-segment={beat?.id} data-bubble-collapsed={collapsed || undefined}>
    {collapsed ? <button type="button" className="bot-call-review" aria-expanded="false" aria-label={expandLabel} title={expandLabel}
      onClick={() => setBubbleView(replyKey && (paused || !active) ? { reply: replyKey, mode: 'reviewing' } : undefined)}>
      <span className="bot-call-review-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="bot-call-review-sparkle"><BotIcon name="sparkles" /></span>
    </button> : <div className="bot-call-bubble" data-waiting={pending && !page || undefined}>
      {(expression || motion || gesture) && <div className="bot-call-cues" role="group" aria-label={zh ? '当前表演' : 'Current performance'}>
        {expression && <span>{expression.label?.[language] ?? expression.name}</span>}
        {motion && <span>{motion.label?.[language] ?? motion.aliases?.[0] ?? motion.name}</span>}
        {gesture && <span>{gesture}</span>}
      </div>}
      {turn && !page && <p className="bot-call-user-line">{zh ? '我' : 'You'} {turn.content || (zh ? '发送了附件' : 'Sent an attachment')}</p>}
      {page && <p className="bot-call-bubble-text" key={page.beat.id + ':' + page.start + ':' + replay} aria-live="polite">{page.text}</p>}
      {speechError && <p className="bot-sr-only" role="status">{speechError}</p>}
      {!pending && status && <p className={`bot-call-bubble-status${visibleStatus ? '' : ' bot-sr-only'}`} role="status">{status}</p>}
      {extra}
      {pending && <BotCallProgress message={latest} zh={zh} action={interrupt} />}
      {page && <footer className="bot-call-bubble-controls">
            <button type="button" aria-label={historyLabel} title={historyLabel} onClick={() => onHistory(page.beat.messageId)}><BotIcon name="history" /></button>
            <button type="button" aria-label={zh ? '从头播放' : 'Replay from start'} title={zh ? '从头播放' : 'Replay from start'} onClick={() => step(0, true)}><BotIcon name="replay" /></button>
            <button type="button" aria-label={zh ? '上一段' : 'Previous segment'} title={zh ? '上一段' : 'Previous segment'} disabled={position === 0} onClick={() => step(position - 1)}><BotIcon name="chevron-left" /></button>
            <span>{position + 1}<i>/</i>{pages.length}</span>
            <button type="button" className="bot-call-dialogue-next" aria-label={zh ? '下一段' : 'Next segment'} title={zh ? '下一段' : 'Next segment'} disabled={position + 1 >= pages.length} onClick={() => step(position + 1)}><BotIcon name="chevron-right" /></button>
            <button type="button" aria-label={autoLabel} title={autoLabel} aria-pressed={!paused && presenting} onClick={toggleAutoplay}><BotIcon name={paused || !presenting ? 'play' : 'pause'} /></button>
            {!pending && interrupt}
            {speechError && <button type="button" aria-label={zh ? '语音播放提示' : 'Speech playback notice'} title={speechError} onClick={() => onNotice(speechError)}><BotIcon name="info" /></button>}
            <button type="button" className="bot-call-bubble-collapse" aria-label={collapseLabel} aria-expanded="true" title={collapseLabel}
              onClick={() => { if (replyKey) setBubbleView({ reply: replyKey, mode: 'collapsed' }); }}><BotIcon name="chevron-down" /></button>
      </footer>}
    </div>}
  </section>;
}
