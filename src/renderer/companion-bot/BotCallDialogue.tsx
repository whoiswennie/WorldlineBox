import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { BotMessage, WorldlineBoxBotApi } from '../../shared/companion-bot';
import { botCallGestureLabels, botCallMotionId, type BotCallCue, type BotCallModelCatalog, type BotCallStage } from '../../shared/companion-call';
import { callBeatKey, callCaptionPlaybackPages, CALL_CAPTION_AUTO_HIDE_MS, callCaptionHoldMs } from '../../shared/companion-call-captions';
import type { BotLive2DControls } from './BotLive2DStage';
import { BotIcon } from './BotIcon';
import { BotErrorNotice } from './BotErrorNotice';
import { BotCallProgress } from './BotReplyProgress';
import { speechPlaybackKey, useBotSpeech } from './useBotSpeech';
import { observeCallBubble } from './call-bubble-placement';
import { useBotCallDocument } from './call-pet';
import { callReplyText } from '../../shared/companion-bot-reply';

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

export function isLiveCallReply(message: BotMessage, companionId: string, connectedAt: number, activeAtConnect: ReadonlySet<string>): boolean {
  return message.senderId === companionId && (Date.parse(message.createdAt) >= connectedAt || activeAtConnect.has(message.id));
}

function scrollCaption(node: HTMLElement, duration: number): (() => void) | undefined {
  const view = node.ownerDocument.defaultView;
  if (!view || view.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const started = view.performance.now();
  const initial = node.scrollTop;
  const lead = Math.min(900, duration * .25);
  const travel = Math.max(1, duration - lead - Math.min(700, duration * .2));
  let frame = view.requestAnimationFrame(advance);
  function advance(now: number) {
    const fraction = Math.max(0, Math.min(1, (now - started - lead) / travel));
    const limit = node.scrollHeight - node.clientHeight;
    if (limit > initial) node.scrollTop = initial + (limit - initial) * fraction;
    if (fraction < 1) frame = view!.requestAnimationFrame(advance);
  }
  const stop = () => view.cancelAnimationFrame(frame);
  const inputs = ['wheel', 'pointerdown', 'keydown'] as const;
  for (const input of inputs) node.addEventListener(input, stop, { passive: true });
  return () => {
    stop();
    for (const input of inputs) node.removeEventListener(input, stop);
  };
}

export function BotCallDialogue({ messages, baseline, ignored, connectedAt, activeAtConnect, companionId, catalog, stage, control, modelLoading, hideDialogue, desktopPet, progressTarget, zh, onPresent, onPlayback, onInterrupt, onNotice, interrupted, extra, turn, speechApi, conversationId, muted, voiceHold, speechStop: speechStopRef }: {
  messages: readonly BotMessage[]; baseline: ReadonlySet<string>; connectedAt: number; control?: BotLive2DControls; hideDialogue: boolean;
  companionId: string; activeAtConnect: ReadonlySet<string>;
  desktopPet?: boolean;
  progressTarget?: HTMLElement | null;
  catalog?: BotCallModelCatalog;
  stage?: BotCallStage;
  modelLoading?: boolean;
  ignored: ReadonlySet<string>; interrupted: boolean;
  onPresent(messageId: string, segmentId: string, sequence: number): void;
  onPlayback(playback: BotCallPlayback): void;
  onInterrupt(): void;
  onNotice(text: string): void;
  zh: boolean; extra?: ReactNode;
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
    if (!speechStopRef) return;
    speechStopRef.current = stopSpeech;
    return () => { if (speechStopRef.current === stopSpeech) speechStopRef.current = undefined; };
  }, [speechStopRef, stopSpeech]);
  const [timeline, setTimeline] = useState<{ source?: readonly BotMessage[]; ignored?: ReadonlySet<string>; beats: Beat[] }>({ beats: [] });
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
  const caption = useRef<HTMLParagraphElement>(null);
  if (timeline.source !== messages || timeline.ignored !== ignored) {
    const incoming = messages.flatMap((message): Beat[] => {
      if (ignored.has(message.id) || !isLiveCallReply(message, companionId, connectedAt, activeAtConnect)) return [];
      const presentation = message.parts?.filter(part => part.presentation && part.text?.trim()) ?? [];
      if (presentation.length) return presentation.flatMap(part => baseline.has(callBeatKey(message.id, part.id)) ? [] : [{
        id: callBeatKey(message.id, part.id), partId: part.id, messageId: message.id, sequence: part.sequence, text: part.text!, cue: part.presentation!,
      }]);
      const id = callBeatKey(message.id);
      const text = callReplyText(message);
      return message.status === 'sent' && text.trim() && !baseline.has(id)
        ? [{ id, messageId: message.id, sequence: message.sequence, text, cue: {} }] : [];
    });
    const known = new Set(beats.map(beat => beat.id));
    const added = incoming.filter(beat => !known.has(beat.id));
    if (added.length) {
      // Reviewing an old reply should not strand the next reply behind the manual page controls.
      if (paused && (manual || expired) && beats.length && added[0]!.messageId !== beats.at(-1)!.messageId) {
        setPosition(beats.reduce((count, beat) => count + callCaptionPlaybackPages(beat.text, beat.partId).length, 0));
        setPaused(false); setManual(false); setExpired(undefined); setBubbleView(undefined);
      }
      beats = [...beats, ...added];
    }
    setTimeline({ source: messages, ignored, beats });
  }
  const pages = useMemo(() => beats.flatMap(beat => {
    const pages = callCaptionPlaybackPages(beat.text, beat.partId).map((page, speechPage) => ({ ...page, beat, speechPage, hold: callCaptionHoldMs(page.text) }));
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
  // Menus may hide the dialogue, while playback keeps advancing through the reply.
  const activeBeat = voiceHold || paused && !manual || pageKey === expired ? undefined : beat;
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
  const liveReplies = messages.filter(message => !ignored.has(message.id) && isLiveCallReply(message, companionId, connectedAt, activeAtConnect));
  const latest = liveReplies.at(-1);
  const running = liveReplies.findLast(message => ['queued', 'running'].includes(message.status));
  const waitingForReceipt = !!turn && !turn.failed && !interrupted && (turn.replyIds === undefined
    || turn.replyIds.some(id => !messages.some(message => message.id === id) && !ignored.has(id)));
  const pending = !!running || waitingForReceipt;
  const noPresentation = latest?.status === 'sent' && !latest.content.trim() && !latest.parts?.some(part => part.presentation) && !latest.attachments?.length;
  const error = latest?.status === 'failed';
  const presenting = !!page && (pageKey !== expired || position + 1 < pages.length);
  const completed = !!page && !pending && !presenting && !paused && !extra;
  const collapsed = !!page && bubbleMode === 'collapsed';
  const active = !!pending || presenting;
  const status = turn?.failed && !latest ? (zh ? '消息未发出' : 'Message not sent')
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
    if (beat?.partId) onPresent(beat.messageId, beat.partId, beat.sequence);
  }, [beat, onPresent]);
  useLayoutEffect(() => {
    const replies = [...new Set(beats.map(item => item.messageId))];
    if (pageKey && pageKey === expired) completedThrough.current = Math.max(completedThrough.current, position);
    const pending = [...new Set(pages.slice(Math.max(position, completedThrough.current + 1)).map(item => item.beat.messageId))];
    onPlayback({ replies, pending });
    return () => onPlayback({ replies: [], pending: [] });
  }, [beats, pages, position, pageKey, expired, onPlayback]);
  useLayoutEffect(() => { startedAt.current = performance.now(); }, [pageKey, paused, modelLoading, replay, voiceHold]);
  useEffect(() => {
    if (!page || (paused && !manual) || modelLoading || voiceHold || pageKey === expired && (manual || position + 1 >= pages.length)) return;
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
  }, [page, pageKey, expired, paused, manual, modelLoading, position, pages, replay, speakingPart, voiceHold]);
  useEffect(() => {
    if (!completed || !replyKey || bubbleMode) return;
    const timer = setTimeout(() => setBubbleView({ reply: replyKey, mode: 'collapsed' }), CALL_CAPTION_AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [completed, replyKey, bubbleMode]);

  const step = (next: number, auto = false) => {
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
  const interruptLabel = zh ? '打断' : 'Interrupt';
  const expandLabel = zh ? '展开对白' : 'Expand dialogue';
  const collapseLabel = zh ? '收起对白' : 'Collapse dialogue';
  const separateProgress = !!desktopPet && pending;
  const shown = !hideDialogue && !!(page || extra || !separateProgress && status);
  const showProgress = separateProgress && !hideDialogue;
  const surface = useBotCallDocument();
  useLayoutEffect(() => {
    const node = bubble.current, scene = node?.closest<HTMLElement>('.bot-call-scene');
    if (node && scene) return observeCallBubble(node, scene);
  }, [shown, surface, modelLoading]);
  const hold = page?.hold ?? 0;
  useEffect(() => {
    const node = caption.current;
    if (shown && !collapsed && !paused && !modelLoading && !voiceHold && pageKey !== expired && node && hold && node.scrollHeight > node.clientHeight) return scrollCaption(node, hold);
  }, [desktopPet, shown, collapsed, paused, modelLoading, voiceHold, pageKey, expired, replay, hold, surface]);

  if (!shown && !showProgress) return null;
  const interrupt = active && <button type="button" className="bot-call-interrupt" disabled={!!turn && !turn.replyIds}
    aria-label={interruptLabel} title={interruptLabel} onClick={() => {
      if (!pending && position <= completedThrough.current && completedThrough.current + 1 >= pages.length) {
        setPaused(true); setManual(false); setExpired(pageKey);
      } else onInterrupt();
    }}><BotIcon name="stop" /></button>;
  const visibleStatus = !page || turn?.failed || error || noPresentation || latest?.status === 'cancelled';
  const dialogue = shown && <section ref={bubble} className="bot-call-visual-novel" aria-label={zh ? '伙伴当前回应' : 'Current companion reply'}
    data-call-dialogue-message={beat?.messageId} data-call-segment={beat?.partId ?? beat?.id} data-bubble-collapsed={collapsed || undefined}>
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
      {page && <p ref={caption} className="bot-call-bubble-text" key={page.beat.id + ':' + page.start + ':' + replay} aria-live="polite" tabIndex={desktopPet ? 0 : undefined}>{page.text}</p>}
      {speechError && <p className="bot-sr-only" role="status">{speechError}</p>}
      {!pending && status && <p className={`bot-call-bubble-status${visibleStatus ? '' : ' bot-sr-only'}`} role="status">{status}</p>}
      {!pending && error && latest.error && <BotErrorNotice message={latest.error} zh={zh} />}
      {extra}
      {pending && !separateProgress && <BotCallProgress message={running} zh={zh} action={interrupt} />}
      {page && <footer className="bot-call-bubble-controls">
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
  const progress = showProgress && <div className="bot-call-pet-progress"><BotCallProgress message={running} zh={zh} action={interrupt} /></div>;
  return <>
    {dialogue}
    {progressTarget === undefined ? progress : progressTarget && progress && createPortal(progress, progressTarget)}
  </>;
}
