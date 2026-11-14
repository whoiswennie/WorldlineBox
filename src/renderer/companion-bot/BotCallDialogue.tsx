import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BotCompanion, BotMessage, WorldlineBoxBotApi } from '../../shared/companion-bot';
import { botCallGestureLabels, botCallMotionId, type BotCallCue, type BotCallModelCatalog, type BotCallStage } from '../../shared/companion-call';
import { buildCallCaptionPages } from './call-caption-pages';
import type { BotLive2DControls } from './BotLive2DStage';
import { BotAvatar } from './BotAvatar';
import { BotIcon } from './BotIcon';
import { BotReplyProgressIndicator } from './BotReplyProgress';
import { useBotSpeech } from './useBotSpeech';

interface Beat { id: string; messageId: string; sequence: number; text: string; cue: BotCallCue }
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

export function BotCallDialogue({ messages, baseline, ignored, connectedAt, catalog, stage, control, modelLoading, hidden, companion, zh, onHistory, onPresent, onPlayback, onInterrupt, interrupted, extra, turn, speechApi, conversationId, muted }: {
  messages: readonly BotMessage[]; baseline: ReadonlySet<string>; connectedAt: number; control?: BotLive2DControls; hidden: boolean;
  catalog?: BotCallModelCatalog;
  stage?: BotCallStage;
  modelLoading?: boolean;
  ignored: ReadonlySet<string>; interrupted: boolean;
  onPresent(messageId: string, segmentId: string, sequence: number): void;
  onPlayback(playback: BotCallPlayback): void;
  onInterrupt(): void;
  companion: BotCompanion; zh: boolean; onHistory(messageId: string): void; extra?: ReactNode;
  turn?: BotCallTurn;
  speechApi?: WorldlineBoxBotApi;
  conversationId?: string;
  muted?: boolean;
}) {
  const [speechError, setSpeechError] = useState('');
  const { active: speakingPart, play: playSpeech, stop: stopSpeech } = useBotSpeech(speechApi, setSpeechError);
  const [timeline, setTimeline] = useState<{ source?: readonly BotMessage[]; ignored?: ReadonlySet<string>; turn?: BotCallTurn; beats: Beat[] }>({ beats: [] });
  let beats = timeline.beats;
  const [position, setPosition] = useState(0);
  const [paused, setPaused] = useState(false);
  const [expired, setExpired] = useState<string>();
  const [replay, setReplay] = useState(0);
  const [manual, setManual] = useState(false);
  const startedAt = useRef(0);
  const completedThrough = useRef(-1);
  if (timeline.source !== messages || timeline.ignored !== ignored || timeline.turn !== turn) {
    const incoming = messages.flatMap(message => ignored.has(message.id) || !isCallTurnReply(message, turn) ? [] : message.parts?.flatMap(part =>
      part.presentation && part.text && !baseline.has(part.id)
      && (Date.parse(message.createdAt) >= connectedAt || ['queued', 'running'].includes(message.status))
        ? [{ id: part.id, messageId: message.id, sequence: part.sequence, text: part.text, cue: part.presentation }] : []) ?? []);
    const known = new Set(beats.map(beat => beat.id));
    const added = incoming.filter(beat => !known.has(beat.id));
    if (added.length) beats = [...beats, ...added];
    setTimeline({ source: messages, ignored, turn, beats });
  }
  const pages = useMemo(() => beats.flatMap(beat => {
    const pages = buildCallCaptionPages(beat.text, 64).map(page => ({ ...page, beat, hold: Math.min(8500, 900 + Array.from(page.text).length * 82) }));
    const motion = catalog?.motions.find(item => botCallMotionId(item) === beat.cue.motion);
    const readingTime = pages.reduce((total, page) => total + page.hold, 0);
    const minimum = Math.max(beat.cue.durationMs ?? 0, (motion?.duration ?? 0) * 1000, beat.cue.expression ? 1800 : 0, beat.cue.gesture ? 900 : 0);
    pages[pages.length - 1]!.hold += Math.max(0, minimum - readingTime);
    return pages;
  }), [beats, catalog]);
  const page = pages[position], beat = page?.beat;
  const pageKey = page && `${page.beat.id}:${page.start}`;
  const activeBeat = hidden || pageKey === expired ? undefined : beat;
  const currentCue = modelLoading ? undefined : activeBeat?.cue;
  const speechBeat = !muted && !hidden && (!paused || manual) && !modelLoading ? beat : undefined;
  useEffect(() => {
    if (!speechBeat || !conversationId) return;
    playSpeech(conversationId, speechBeat.messageId, speechBeat.id, control?.audio);
    return stopSpeech;
  }, [speechBeat, conversationId, control, replay, playSpeech, stopSpeech]);
  const language = zh ? 0 : 1;
  const expression = currentCue?.expression ? stage?.expressions.find(item => item.name === currentCue.expression) : undefined;
  const motion = currentCue?.motion ? stage?.motions.find(item => item.id === currentCue.motion) : undefined;
  const gesture = currentCue?.gesture && stage?.gestures.includes(currentCue.gesture) ? botCallGestureLabels[currentCue.gesture][language] : undefined;
  const latest = messages.findLast(message => isCallTurnReply(message, turn) && !ignored.has(message.id)
    && (Date.parse(message.createdAt) >= connectedAt || ['queued', 'running'].includes(message.status)));
  const pending = latest ? ['queued', 'running'].includes(latest.status)
    : !!turn && !turn.failed && (turn.replyIds === undefined || (!interrupted && turn.replyIds.length > 0));
  const noPresentation = latest?.status === 'sent' && !latest.parts?.some(part => part.presentation) && !latest.attachments?.length;
  const error = latest?.status === 'failed';
  const presenting = !!page && (pageKey !== expired || position + 1 < pages.length);
  const active = !!pending || presenting;
  const progress = pending ? latest : undefined;
  const status = turn?.failed ? (zh ? '消息未发出' : 'Message not sent')
    : error || noPresentation ? (zh ? '这次会面回应未能发布，请再试一次。' : 'The meeting reply could not be published. Try again.')
    : latest?.status === 'cancelled' ? (zh ? '这次回应已中止' : 'The reply stopped')
      : presenting ? (paused ? (zh ? '呈现已暂停' : 'Presentation paused') : (zh ? '正在呈现' : 'Presenting'))
        : pending ? (zh ? '正在回应…' : 'Replying…')
          : latest ? (zh ? '回应结束 · 可以继续' : 'Reply complete · Your turn')
            : interrupted ? (zh ? '已打断 · 可以继续' : 'Interrupted · Your turn')
              : turn?.replyIds?.length === 0 ? (zh ? '消息已发送' : 'Message sent') : '';

  useLayoutEffect(() => {
    control?.present(activeBeat?.cue);
  }, [control, activeBeat, replay]);
  useLayoutEffect(() => {
    control?.presence?.(activeBeat ? 'speaking' : pending ? 'waiting' : 'idle');
  }, [control, activeBeat, pending]);
  useLayoutEffect(() => () => { control?.present(); control?.presence?.('idle'); }, [control]);
  useLayoutEffect(() => {
    if (beat && !hidden) onPresent(beat.messageId, beat.id, beat.sequence);
  }, [beat, hidden, onPresent]);
  useLayoutEffect(() => {
    const replies = [...new Set(beats.map(item => item.messageId))];
    if (pageKey && pageKey === expired) completedThrough.current = Math.max(completedThrough.current, position);
    const pending = [...new Set(pages.slice(Math.max(position, completedThrough.current + 1)).map(item => item.beat.messageId))];
    onPlayback({ replies, pending });
    return () => onPlayback({ replies: [], pending: [] });
  }, [beats, pages, position, pageKey, expired, onPlayback]);
  useLayoutEffect(() => { startedAt.current = performance.now(); }, [pageKey, hidden, paused, modelLoading, replay]);
  useEffect(() => {
    if (!page || (paused && !manual) || hidden || modelLoading || pageKey === expired && (manual || position + 1 >= pages.length)) return;
    if (beat && speakingPart === beat.id && pages[position + 1]?.beat.id !== beat.id) return;
    const remaining = pageKey === expired ? 0 : Math.max(0, page.hold - (performance.now() - startedAt.current));
    const timer = setTimeout(() => {
      if (!paused && position + 1 < pages.length) {
        completedThrough.current = Math.max(completedThrough.current, position);
        setPosition(index => index === position ? index + 1 : index);
      }
      else { setExpired(pageKey); setManual(false); }
    }, remaining);
    return () => clearTimeout(timer);
  }, [page, pageKey, expired, hidden, paused, manual, modelLoading, position, pages, beat, replay, speakingPart]);

  const step = (next: number, auto = false) => {
    setPaused(!auto); setManual(!auto); setExpired(undefined); setPosition(next); setReplay(value => value + 1);
  };
  const toggleAutoplay = () => {
    if (paused) {
      setPaused(false);
      setManual(false);
    } else if (presenting) {
      setPaused(true);
      setManual(false);
    } else step(0, true);
  };
  const autoLabel = paused ? (zh ? '继续自动播放' : 'Resume autoplay') : (zh ? '自动播放' : 'Autoplay');
  const historyLabel = zh ? '完整对话' : 'Transcript';

  if (hidden || (!page && !status && !extra)) return null;
  return <section className="bot-call-visual-novel" aria-label={zh ? '伙伴当前回应' : 'Current companion reply'}
    data-call-dialogue-message={beat?.messageId} data-call-segment={beat?.id}>
    {progress && <div className="bot-call-progress"><BotReplyProgressIndicator key={progress.id} message={progress} locale={zh ? 'zh-CN' : 'en'} /></div>}
    <div className="bot-call-bubble">
      <header className="bot-call-speaker"><span><BotAvatar companion={companion} />{companion.name}</span>
        {status && <p className="bot-call-bubble-status" role="status">{pending && !page && <i aria-hidden="true" />}{status}</p>}
        {speechError && <p className="bot-call-bubble-status" role="status">{speechError}</p>}
      </header>
      {(expression || motion || gesture) && <div className="bot-call-cues" role="group" aria-label={zh ? '当前表演' : 'Current performance'}>
        {expression && <span title={expression.description?.[language]}><BotIcon name="smile" />{expression.label?.[language] ?? expression.name}</span>}
        {motion && <span title={motion.description?.[language]}><BotIcon name="full-body" />{motion.label?.[language] ?? motion.aliases?.[0] ?? motion.name}</span>}
        {gesture && <span><BotIcon name="full-body" />{gesture}</span>}
      </div>}
      {turn && !page && <p className="bot-call-user-line"><b>{zh ? '我' : 'You'}</b> {turn.content || (zh ? '发送了附件' : 'Sent an attachment')}</p>}
      {page && <p className="bot-call-bubble-text" key={page.beat.id + ':' + page.start + ':' + replay} aria-live="polite">{page.text}</p>}
      {extra}
      {(page || active) && <footer className="bot-call-bubble-controls">
        {page && <button type="button" title={historyLabel} onClick={() => onHistory(page.beat.messageId)}><BotIcon name="history" />{historyLabel}</button>}
        <div>
          {active && <button type="button" className="bot-call-interrupt" disabled={!!turn && !turn.replyIds} title={zh ? '打断' : 'Interrupt'} onClick={() => {
            if (!pending && position <= completedThrough.current && completedThrough.current + 1 >= pages.length) {
              setPaused(true); setManual(false); setExpired(pageKey);
            } else onInterrupt();
          }}><BotIcon name="stop" />{zh ? '打断' : 'Interrupt'}</button>}
          {page && <>
            <button type="button" aria-label={zh ? '从头播放' : 'Replay from start'} title={zh ? '从头播放' : 'Replay from start'} onClick={() => step(0, true)}><BotIcon name="replay" /></button>
            <button type="button" aria-label={autoLabel} title={autoLabel} aria-pressed={!paused && presenting} onClick={toggleAutoplay}><BotIcon name={paused || !presenting ? 'play' : 'pause'} /></button>
            <button type="button" aria-label={zh ? '上一段' : 'Previous segment'} title={zh ? '上一段' : 'Previous segment'} disabled={position === 0} onClick={() => step(position - 1)}><BotIcon name="chevron-left" /></button>
            <span>{position + 1}<i>/</i>{pages.length}</span>
            <button type="button" className="bot-call-dialogue-next" aria-label={zh ? '下一段' : 'Next segment'} title={zh ? '下一段' : 'Next segment'} disabled={position + 1 >= pages.length} onClick={() => step(position + 1)}><BotIcon name="chevron-right" /></button>
          </>}
        </div>
      </footer>}
    </div>
  </section>;
}
