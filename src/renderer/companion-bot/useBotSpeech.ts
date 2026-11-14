import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorldlineBoxBotApi } from '../../shared/companion-bot';

export function useBotSpeech(api: WorldlineBoxBotApi | undefined, report: (error: string) => void) {
  const [active, setActive] = useState<string>();
  const current = useRef<{ id: string; key: string; context: AudioContext; level?: (level: number) => void; cancel: () => void }>(undefined);
  const stop = useCallback(() => { current.current?.cancel(); }, []);
  useEffect(() => stop, [stop]);
  const play = useCallback((conversationId: string, messageId: string, partId?: string, level?: (value: number) => void) => {
    const key = partId ?? messageId;
    if (current.current?.key === key) { stop(); return; }
    stop();
    if (!api?.speech || !api.onSpeech) return;
    const id = crypto.randomUUID(), context = new AudioContext();
    const analyser = context.createAnalyser(); analyser.fftSize = 512; analyser.connect(context.destination);
    const samples = new Float32Array(analyser.fftSize);
    let nextTime = 0, remainder: number | undefined, frame = 0, count = 0, done = false;
    let unsubscribe = () => {};
    const close = (abort: boolean) => {
      if (current.current?.id !== id) return;
      current.current = undefined;
      unsubscribe(); cancelAnimationFrame(frame); level?.(0); setActive(undefined);
      void context.close().catch(() => undefined);
      if (abort) void api.speech?.({ type: 'stop', id }).catch(() => undefined);
    };
    const failure = (error: string) => { close(true); report(error); };
    current.current = { id, key, context, level, cancel: () => close(true) };
    setActive(key);
    const measure = () => {
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      level?.(Math.min(1, Math.max(0, (rms - .012) * 4.8)));
      frame = requestAnimationFrame(measure);
    };
    if (level) frame = requestAnimationFrame(measure);
    unsubscribe = api.onSpeech(event => {
      if (event.id !== id || current.current?.id !== id) return;
      if (event.error) { failure(event.error); return; }
      if (event.done) { done = true; if (remainder !== undefined) failure('音频数据不完整。'); else if (!count) close(false); return; }
      if (!event.audio?.length) return;
      const bytes = new Uint8Array(event.audio.length + (remainder === undefined ? 0 : 1));
      if (remainder !== undefined) bytes[0] = remainder;
      bytes.set(event.audio, bytes.length - event.audio.length);
      remainder = bytes.length % 2 ? bytes.at(-1) : undefined;
      const length = Math.floor(bytes.length / 2);
      if (!length) return;
      const buffer = context.createBuffer(1, length, 24_000), pcm = new DataView(bytes.buffer), data = buffer.getChannelData(0);
      for (let index = 0; index < length; index++) data[index] = pcm.getInt16(index * 2, true) / 32768;
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(analyser);
      if (nextTime < context.currentTime) nextTime = context.currentTime + .045;
      source.start(nextTime); nextTime += buffer.duration; count++;
      source.onended = () => { count--; if (done && !count) close(false); };
    });
    void context.resume().then(() => current.current?.id === id ? api.speech?.({ type: 'play', id, conversationId, messageId, partId }) : undefined).then(result => {
      if (result && !result.ok && current.current?.id === id) failure(result.error ?? '语音播放失败。');
      if (current.current?.id !== id) void api.speech?.({ type: 'stop', id }).catch(() => undefined);
    }).catch(() => { if (current.current?.id === id) failure('语音播放失败。'); });
  }, [api, report, stop]);
  return { active, play, stop };
}
