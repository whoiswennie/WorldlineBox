import { useEffect, useRef, useState } from 'react';
import type { BotDesktopCaptureScope, WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';

// Each part is an independently decodable WebM. Chromium can join them on a
// seekable timeline without spawning an encoder or creating another disk file.
export function BotHeartbeatPlayer({ ids, kind, api, scope, zh }: {
  ids: string; kind: 'screen' | 'video'; api: WorldlineBoxBotMediaApi; scope: BotDesktopCaptureScope; zh: boolean;
}) {
  const player = useRef<HTMLVideoElement>(null);
  const [picture, setPicture] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(), { signal } = controller;
    const element = player.current;
    let url: string | undefined;
    const read = async (id: string) => {
      const response = await api.request({ type: 'desktop.presence.archive.read', ...scope, id });
      signal.throwIfAborted();
      if (!response.ok || !response.recordingBytes) throw Error(response.error || (zh ? '这份素材已经清理了。' : 'This item has expired.'));
      return new Uint8Array(response.recordingBytes);
    };
    const parts = ids.split(',');
    const show = async () => {
      if (parts.length === 1) {
        const bytes = await read(parts[0]!);
        signal.throwIfAborted();
        url = URL.createObjectURL(new Blob([bytes], { type: kind === 'video' ? 'video/webm' : 'image/jpeg' }));
        if (element) element.src = url; else setPicture(url);
        return;
      }
      const mime = 'video/webm; codecs="vp8,opus"';
      if (!element || !window.MediaSource?.isTypeSupported(mime)) throw Error(zh ? '当前播放器无法连播，可以点下方任一片段回看。' : 'Select an individual clip below to play it.');
      const source = new MediaSource();
      url = URL.createObjectURL(source);
      const opened = mediaEvent(source, 'sourceopen', signal);
      element.src = url;
      await opened;
      const buffer = source.addSourceBuffer(mime);
      buffer.mode = 'sequence';
      const joins: number[] = [];
      // Each recorder starts its own audio and video clocks. MSE concatenates
      // at the later track end, leaving a short gap in the other track.
      const crossJoin = (event: Event) => {
        if (element.paused || element.seeking) return;
        const time = element.currentTime, ranges = element.buffered;
        for (let i = 1; i < ranges.length; i++) {
          const end = ranges.end(i - 1), start = ranges.start(i);
          if (time >= end - .12 && time < start && joins.some(join => join >= end - .5 && join <= start + .5)) {
            element.currentTime = start + .001;
            return;
          }
        }
        // Chromium can report a single merged range even when its decoder
        // waits for the first keyframe of the following independent WebM.
        if (event.type === 'waiting') {
          const join = joins.find(at => time >= at - .5 && time <= at + .05);
          if (join !== undefined && ranges.length && ranges.end(ranges.length - 1) > join + .3) element.currentTime = join + .25;
        }
      };
      element.addEventListener('waiting', crossJoin, { signal });
      element.addEventListener('timeupdate', crossJoin, { signal });
      for (const [index, part] of parts.entries()) {
        const bytes = await read(part);
        signal.throwIfAborted();
        buffer.appendBuffer(bytes);
        await mediaEvent(buffer, 'updateend', signal);
        if (index) joins.push(buffer.timestampOffset);
        if (index < parts.length - 1 && buffer.buffered.length) joins.push(buffer.buffered.end(buffer.buffered.length - 1));
      }
      source.endOfStream();
    };
    void show().catch(reason => { if (!signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => {
      controller.abort();
      if (element) { element.pause(); element.removeAttribute('src'); element.load(); }
      if (url) URL.revokeObjectURL(url);
    };
  }, [ids, kind, api, scope, zh]);
  return <div className="bot-heartbeat-media">
    {kind === 'video' ? <video ref={player} controls preload="auto" aria-label={zh ? '录像回放' : 'Recording playback'} /> :
      picture && <img src={picture} alt={zh ? '本轮截取的画面' : 'Screenshot from this heartbeat'} />}
    {error && <p role="alert">{error}</p>}
  </div>;
}

function mediaEvent(target: EventTarget, event: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const finish = (result: Event) => {
      target.removeEventListener(event, finish);
      target.removeEventListener('error', finish);
      signal.removeEventListener('abort', finish);
      if (result.type === event) resolve(); else reject(signal.reason ?? Error('无法读取连续录像，请选择单个片段。'));
    };
    target.addEventListener(event, finish);
    target.addEventListener('error', finish);
    signal.addEventListener('abort', finish, { once: true });
  });
}
