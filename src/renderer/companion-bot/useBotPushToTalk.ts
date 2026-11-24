import { useEffect, useEffectEvent, useState } from 'react';
import type { BotResponse, WorldlineBoxBotApi } from '../../shared/companion-bot';
import { localSpeechApi } from './BotVoiceInput';
import { speechBase64, VoiceRecorder } from './voice-recorder';

export interface BotPushToTalkTarget {
  start(): void;
  send(text: string, requestId: string): Promise<BotResponse>;
}

export function useBotPushToTalk(subscribe: WorldlineBoxBotApi['onPushToTalk'], scope: string,
  getTarget: () => BotPushToTalkTarget | undefined, locale: 'zh-CN' | 'en') {
  const api = localSpeechApi();
  const [recording, setRecording] = useState(false), [pending, setPending] = useState(0);
  const [failure, setFailure] = useState<{ message: string; retry?: () => void }>();
  const pickTarget = useEffectEvent(getTarget);
  useEffect(() => {
    if (!subscribe || !api) return;
    const zh = locale === 'zh-CN';
    type Recording = { recorder: VoiceRecorder; ready: boolean; cancelled: boolean; release(): void; speechId?: string };
    let active: Recording | undefined, live = true, queue = Promise.resolve();
    const outstanding = new Set<Recording>();
    const cancel = () => {
      active = undefined;
      for (const capture of outstanding) {
        capture.cancelled = true;
        capture.recorder.cancel();
        capture.release();
        if (capture.speechId) void api.request({ type: 'speech.cancel', requestId: capture.speechId }).catch(() => undefined);
      }
      if (live) setRecording(false);
    };
    const finish = (discard: boolean) => {
      const capture = active;
      active = undefined;
      setRecording(false);
      if (!capture) return;
      if (capture.ready && !discard) capture.recorder.stop();
      else { capture.cancelled = true; capture.recorder.cancel(); }
      capture.release();
    };
    const off = subscribe(event => {
      if (event === 'cancel') { cancel(); return; }
      if (event === 'release' || event === 'discard') { finish(event === 'discard'); return; }
      if (active) return;
      const target = pickTarget();
      if (!target) return;
      target.start();
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      const capture: Recording = { recorder: new VoiceRecorder(), ready: false, cancelled: false, release };
      active = capture;
      outstanding.add(capture);
      setFailure(undefined); setRecording(true); setPending(value => value + 1);
      const finished = Promise.all([released, capture.recorder.start(() => {}).then(result => {
        capture.ready = !!result;
        return result?.finished;
      })]);
      void finished.catch(() => undefined);
      const requestId = crypto.randomUUID();
      const send = async (text: string) => {
        try {
          const result = await target.send(text, requestId);
          if (!result.ok) throw Error(result.error || (zh ? '语音文字未发送。' : 'Voice text could not be sent.'));
        } catch (error) {
          if (live && !capture.cancelled) setFailure({ message: String(error instanceof Error ? error.message : error), retry: () => {
            setFailure(undefined); setPending(value => value + 1);
            queue = queue.then(async () => { if (live && !capture.cancelled) await send(text); }).finally(() => { if (live) setPending(value => value - 1); });
          } });
        }
      };
      queue = queue.then(async () => {
        try {
          const [, audio] = await finished;
          if (!live || capture.cancelled || !audio) return;
          capture.speechId = requestId;
          const result = await api.request({ type: 'speech.transcribe', requestId, audio: speechBase64(audio.wave) });
          if (!live || capture.cancelled || result.cancelled) return;
          const text = result.transcript?.text.trim();
          if (!result.ok || !text) throw Error(result.error || (zh ? '没有识别到语音，请再说一次。' : 'No speech detected. Try again.'));
          await send(text);
        } catch (error) {
          if (live && !capture.cancelled) setFailure({ message: String(error instanceof Error ? error.message : error) });
        } finally {
          outstanding.delete(capture);
          if (active === capture) { active = undefined; if (live) setRecording(false); }
          if (live) setPending(value => value - 1);
        }
      });
    });
    return () => { live = false; off(); cancel(); setRecording(false); setPending(0); setFailure(undefined); };
  }, [api, subscribe, scope, locale]);
  return { recording, pending, failure };
}
