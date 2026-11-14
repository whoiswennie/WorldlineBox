import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BotMessage } from '../../shared/companion-bot';
import type { WorldlineBoxLocalSpeechApi } from '../../shared/local-speech';
import { localSpeechApi } from './BotVoiceInput';
import { BotCallVoiceSession, type BotCallVoiceState } from './BotCallVoiceSession';
import { CallVoiceCapture } from './call-voice-capture';

export interface BotCallSendReceipt { ok: boolean; replyMessageIds?: readonly string[] }
export type BotCallSend = (text: string, requestId: string) => Promise<boolean | BotCallSendReceipt>;
interface ExpectedReply { turn: number; ids: readonly string[] }
const off: BotCallVoiceState = { phase: 'off', enabled: false, turn: 0 };

/** Microphone/ASR presentation for the meeting topic, with exact reply receipts. */
export function useBotCallVoice({ api = localSpeechApi(), connected, conversationId, companionId, messages, send }: {
  api?: WorldlineBoxLocalSpeechApi; connected: boolean; conversationId: string; companionId: string;
  messages: readonly BotMessage[]; send: BotCallSend;
}) {
  const [state, setState] = useState(off), [level, setLevel] = useState(0), [expected, setExpected] = useState<ExpectedReply>();
  const session = useRef<BotCallVoiceSession>(undefined), sendRef = useRef(send);
  const transport = useRef<(text: string, requestId: string, perform: () => Promise<boolean | BotCallSendReceipt>) => Promise<boolean>>(undefined);
  useLayoutEffect(() => { sendRef.current = send; }, [send]);
  useEffect(() => {
    if (!connected || !api) return;
    let live = true, levelAt = 0;
    const deliver = async (perform: () => Promise<boolean | BotCallSendReceipt>) => {
      const turn = current.state.turn;
      if (live && session.current === current) setExpected({ turn, ids: [] });
      const result = await perform(), ok = typeof result === 'boolean' ? result : result.ok;
      if (live && session.current === current && current.state.enabled && current.state.turn === turn && ok) {
        const ids = typeof result === 'boolean' ? undefined : result.replyMessageIds;
        // Missing receipts are not guessed from unrelated proactive messages.
        if (!ids?.length) throw Error('消息已发送，但语音轮次未能确认。请查看会面记录后重新开启语音。');
        setExpected({ turn, ids });
      }
      return ok;
    };
    const current = new BotCallVoiceSession({ api,
      captureFactory: () => new CallVoiceCapture({ onLevel: value => {
        if (live && (value === 0 || performance.now() - levelAt > 80)) { levelAt = performance.now(); setLevel(value); }
      } }),
      send: (text, requestId) => deliver(() => sendRef.current(text, requestId)),
      changed: next => { if (live) { setState(next); if (next.phase !== 'listening') setLevel(0); } },
    });
    session.current = current;
    transport.current = async (text, requestId, perform) => {
      if (current.state.enabled) return current.sendAction(text, requestId, () => deliver(perform));
      const result = await perform(); return typeof result === 'boolean' ? result : result.ok;
    };
    return () => { live = false; current.dispose(); if (session.current === current) { session.current = undefined; transport.current = undefined; } };
  }, [api, connected, conversationId, companionId]);

  useEffect(() => {
    const current = session.current;
    if (!current || !state.enabled || state.phase !== 'waiting' || current.state.turn !== state.turn || expected?.turn !== state.turn || !expected.ids.length) return;
    const replies = expected.ids.map(id => messages.find(message => message.id === id && message.conversationId === conversationId && message.senderId === companionId));
    const failed = replies.find(message => message && ['failed', 'cancelled'].includes(message.status));
    if (failed) { current.replyFailed(failed.error || '伙伴这次未能完成回复，可以继续打字或重新开启语音。', state.turn); return; }
    if (replies.every(message => message?.status === 'sent')) current.readyForNextTurn(state.turn);
  }, [state, expected, messages, conversationId, companionId]);

  const start = useCallback(() => { setExpected(undefined); void session.current?.start(); }, []);
  const stop = useCallback(() => { session.current?.stop(); setExpected(undefined); }, []);
  const interrupt = useCallback(() => { setExpected(undefined); void session.current?.interruptTalk(); }, []);
  const sendAction = useCallback(async (text: string, requestId: string, perform: () => Promise<boolean | BotCallSendReceipt>): Promise<boolean> => {
    if (transport.current) return transport.current(text, requestId, perform);
    const result = await perform(); return typeof result === 'boolean' ? result : result.ok;
  }, []);
  return { available: !!api, state, level, start, stop, interrupt, sendAction,
    finish: () => session.current?.finishUtterance(), retry: () => void session.current?.retrySend() };
}
