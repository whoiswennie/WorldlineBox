import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BotMessage } from '../../shared/companion-bot';
import { botSpeechText } from '../../shared/companion-bot-speech';
import type { WorldlineBoxLocalSpeechApi } from '../../shared/local-speech';
import { localSpeechApi } from './BotVoiceInput';
import { BotCallVoiceSession, type BotCallVoiceState } from './BotCallVoiceSession';
import type { BotCallSpeechState } from './BotCallSpeechSession';
import { CallVoiceCapture } from './call-voice-capture';

export interface BotCallSendReceipt { ok: boolean; replyMessageIds?: readonly string[] }
export type BotCallSend = (text: string, requestId: string) => Promise<boolean | BotCallSendReceipt>;
interface ExpectedReply { turn: number; ids: readonly string[] }
const off: BotCallVoiceState = { phase: 'off', enabled: false, turn: 0 };

/** Microphone/ASR presentation for the original chat, with exact reply receipts. */
export function useBotCallVoice({ api = localSpeechApi(), connected, conversationId, companionId, messages, send, speech }: {
  api?: WorldlineBoxLocalSpeechApi; connected: boolean; conversationId: string; companionId: string;
  messages: readonly BotMessage[]; send: BotCallSend;
  speech: { available: boolean; enabled: boolean; state: BotCallSpeechState; stop(): void; unlock(): void };
}) {
  const [state, setState] = useState(off), [level, setLevel] = useState(0), [expected, setExpected] = useState<ExpectedReply>();
  const session = useRef<BotCallVoiceSession>(undefined), callbacks = useRef({ send, speech });
  const playback = useRef<{ turn: number; id?: string }>(undefined);
  const previousPlayback = useRef<BotCallSpeechState>(undefined);
  const completed = useRef(new Set<string>());
  const transport = useRef<(text: string, requestId: string, perform: () => Promise<boolean | BotCallSendReceipt>) => Promise<boolean>>(undefined);
  useLayoutEffect(() => { callbacks.current = { send, speech }; }, [send, speech]);
  useEffect(() => {
    if (!connected || !api) return;
    let live = true, levelAt = 0;
    const completedIds = completed.current;
    const deliver = async (perform: () => Promise<boolean | BotCallSendReceipt>) => {
      const turn = current.state.turn;
      if (live && session.current === current) setExpected({ turn, ids: [] });
      const result = await perform(), ok = typeof result === 'boolean' ? result : result.ok;
      if (live && session.current === current && current.state.enabled && current.state.turn === turn && ok) {
        const ids = typeof result === 'boolean' ? undefined : result.replyMessageIds;
        // Missing receipts are not guessed from unrelated proactive messages.
        if (!ids?.length) throw Error('消息已发送，但语音轮次未能确认。请查看私聊后重新开启语音。');
        setExpected({ turn, ids });
      }
      return ok;
    };
    const current = new BotCallVoiceSession({ api,
      captureFactory: () => new CallVoiceCapture({ onLevel: value => {
        if (live && (value === 0 || performance.now() - levelAt > 80)) { levelAt = performance.now(); setLevel(value); }
      } }),
      send: (text, requestId) => deliver(() => callbacks.current.send(text, requestId)),
      stopSpeech: () => callbacks.current.speech.stop(),
      changed: next => { if (live) { setState(next); if (next.phase !== 'listening') setLevel(0); } },
    });
    session.current = current;
    transport.current = async (text, requestId, perform) => {
      if (current.state.enabled) return current.sendAction(text, requestId, () => deliver(perform));
      const result = await perform(); return typeof result === 'boolean' ? result : result.ok;
    };
    return () => { live = false; current.dispose(); if (session.current === current) { session.current = undefined; transport.current = undefined; } playback.current = undefined; previousPlayback.current = undefined; completedIds.clear(); };
  }, [api, connected, conversationId, companionId]);

  useEffect(() => {
    const current = session.current;
    if (!current || !state.enabled || current.state.turn !== state.turn) return;
    const { phase, messageId, completedMessageIds, error } = speech.state;
    // A deliberate retry must not immediately consume the preceding failed or
    // completed playback snapshot before the replay queue publishes its update.
    if (previousPlayback.current === speech.state) return;
    previousPlayback.current = undefined;
    if (messageId && ['preparing', 'speaking'].includes(phase)) completed.current.delete(messageId);
    for (const failure of speech.state.failures ?? []) completed.current.delete(failure.messageId);
    for (const id of completedMessageIds ?? []) completed.current.add(id);
    while (completed.current.size > 512) completed.current.delete(completed.current.values().next().value!);
    const target = expected?.turn === state.turn ? expected : undefined;
    const targetFailure = speech.state.failures?.find(failure => target?.ids.includes(failure.messageId));
    if (targetFailure) { current.replyFailed(targetFailure.error, state.turn); return; }
    if (['preparing', 'speaking'].includes(phase)) {
      playback.current = { turn: state.turn, id: messageId };
      if (current.state.phase !== 'speaking') current.markSpeaking(state.turn);
      return;
    }
    const replies = target?.ids.map(id => messages.find(message => message.id === id && message.conversationId === conversationId && message.senderId === companionId));
    const failed = replies?.find(message => message && ['failed', 'cancelled'].includes(message.status));
    if (failed) { current.replyFailed(failed.error || '伙伴这次未能完成回复，可以继续打字或重新开启语音。', state.turn); return; }
    if (phase === 'error' && (!target || !!messageId && target.ids.includes(messageId)) && (playback.current?.turn === state.turn || !!messageId && !!target?.ids.includes(messageId))) {
      current.replyFailed(error || '朗读失败，可以重试朗读或继续说话。', state.turn); return;
    }
    if (!['waiting', 'speaking'].includes(state.phase)) return;
    const allSent = !!replies?.length && replies.every(message => message?.status === 'sent');
    if (target && !allSent) return;
    const voiceNeeded = speech.available && speech.enabled && replies?.some(message => botSpeechText(message!.content));
    const finished = target ? target.ids.every(id => completed.current.has(id) || id === messageId || !botSpeechText(replies?.find(message => message?.id === id)?.content ?? ''))
      : playback.current?.turn === state.turn && playback.current.id === messageId;
    if (allSent && !voiceNeeded || phase === 'idle' && finished) {
      playback.current = undefined; current.readyForNextTurn(state.turn);
    }
  }, [state, expected, messages, conversationId, companionId, speech.state, speech.available, speech.enabled]);

  const start = useCallback(() => { callbacks.current.speech.unlock(); setExpected(undefined); playback.current = undefined; previousPlayback.current = undefined; void session.current?.start(); }, []);
  const stop = useCallback(() => { session.current?.stop(); setExpected(undefined); playback.current = undefined; previousPlayback.current = undefined; }, []);
  const interrupt = useCallback(() => { setExpected(undefined); playback.current = undefined; previousPlayback.current = undefined; callbacks.current.speech.unlock(); void session.current?.interruptTalk(); }, []);
  const waitForPlayback = useCallback(() => { previousPlayback.current = callbacks.current.speech.state; playback.current = undefined; session.current?.waitForPlayback(); }, []);
  const sendTyped: BotCallSend = async (text, requestId) => session.current?.state.enabled ? session.current.sendText(text, requestId) : callbacks.current.send(text, requestId);
  const sendAction = useCallback(async (text: string, requestId: string, perform: () => Promise<boolean | BotCallSendReceipt>): Promise<boolean> => {
    if (transport.current) return transport.current(text, requestId, perform);
    const result = await perform(); return typeof result === 'boolean' ? result : result.ok;
  }, []);
  return { available: !!api, state, level, start, stop, interrupt, waitForPlayback, sendTyped, sendAction,
    finish: () => session.current?.finishUtterance(), retry: () => void session.current?.retrySend() };
}
