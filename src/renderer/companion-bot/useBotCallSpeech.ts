import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BotMessage } from '../../shared/companion-bot';
import type { WorldlineBoxBotSpeechApi } from '../../shared/companion-bot-speech';
import type { BotLive2DControls } from './BotLive2DStage';
import { BotSpeechPlayer, type BotSpeechFrame } from './BotSpeechPlayer';
import { BotCallSpeechSession, type BotCallSpeechState } from './BotCallSpeechSession';

const preference = 'worldlinebox.companion-call.speech.v1';
export function useBotCallSpeech({ api, conversationId, companionId, connected, messages, control }: {
  api?: WorldlineBoxBotSpeechApi; conversationId: string; companionId: string; connected: boolean; messages: readonly BotMessage[]; control?: BotLive2DControls;
}) {
  const [enabled, setEnabled] = useState(() => { try { return localStorage.getItem(preference) !== 'off'; } catch { return true; } });
  const [state, setState] = useState<BotCallSpeechState>(() => ({ phase: 'idle', textMessageIds: messages.filter(message => message.conversationId === conversationId && message.senderId === companionId && message.status === 'sent').map(message => message.id) }));
  const currentMessages = useRef(messages), controls = useRef(control), player = useRef<BotSpeechPlayer>(undefined), session = useRef<BotCallSpeechSession>(undefined);
  const currentEnabled = useRef(enabled);
  const lastFrame = useRef<BotSpeechFrame>({ playing: false, level: 0 });
  useLayoutEffect(() => { currentMessages.current = messages; }, [messages]);
  useLayoutEffect(() => { currentEnabled.current = enabled; }, [enabled]);
  useLayoutEffect(() => { controls.current = control; control?.speech(lastFrame.current); }, [control]);
  const unlock = useCallback(() => {
    if (!player.current) player.current = new BotSpeechPlayer(frame => {
      lastFrame.current = frame; controls.current?.speech(frame);
      session.current?.updateFrame(frame);
    });
    player.current.unlock();
  }, []);
  useLayoutEffect(() => {
    if (!connected || !api) return;
    unlock();
    let alive = true, lastPublished: BotCallSpeechState | undefined, publishedAt = -Infinity;
    let pending: BotCallSpeechState | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const publish = (next: BotCallSpeechState) => {
      if (!alive) return;
      if (timer) { clearTimeout(timer); timer = undefined; }
      pending = undefined; lastPublished = next; publishedAt = performance.now(); setState(next);
    };
    const changed = (next: BotCallSpeechState) => {
      const previous = lastPublished;
      const important = !previous || next.phase !== previous.phase || next.messageId !== previous.messageId || next.error !== previous.error
        || next.pendingMessageIds !== previous.pendingMessageIds || next.textMessageIds !== previous.textMessageIds
        || next.revealComplete !== previous.revealComplete || next.completedMessageIds !== previous.completedMessageIds
        || next.failures?.length !== previous.failures?.length || next.failures?.some((failure, index) => failure.messageId !== previous.failures?.[index]?.messageId || failure.error !== previous.failures?.[index]?.error);
      // Audio analysis remains frame-rate driven; only React's subtitle paint is capped.
      const delay = 90 - (performance.now() - publishedAt);
      if (important || delay <= 0) { publish(next); return; }
      pending = next;
      timer ??= setTimeout(() => { timer = undefined; if (pending) publish(pending); }, delay);
    };
    const current = new BotCallSpeechSession({ api, conversationId, companionId, initialMessages: currentMessages.current, player: player.current!, enabled: currentEnabled.current, changed });
    session.current = current;
    changed(current.snapshot()); current.observe(currentMessages.current);
    return () => { alive = false; if (timer) clearTimeout(timer); current.dispose(); session.current = undefined; player.current?.destroy(); player.current = undefined; };
  }, [api, connected, conversationId, companionId, unlock]);
  useLayoutEffect(() => { session.current?.setEnabled(enabled); }, [enabled, connected]);
  useLayoutEffect(() => { session.current?.observe(messages); }, [messages, enabled, connected]);
  useEffect(() => () => { player.current?.destroy(); player.current = undefined; }, []);
  const toggle = () => { const next = !enabled; setEnabled(next); session.current?.setEnabled(next); try { localStorage.setItem(preference, next ? 'on' : 'off'); } catch { /* This visit still uses the selected preference. */ } };
  return { enabled, available: !!api, state, toggle, unlock, stop: () => session.current?.stop(), replay: (messageId: string) => { unlock(); session.current?.replay(messageId); } };
}
