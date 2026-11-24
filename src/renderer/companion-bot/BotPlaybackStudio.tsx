import { useCallback, useRef, useState } from 'react';
import type { AttachmentEdit } from '../../shared/companion-bot-media';
import { BotIcon } from './BotIcon';

type Props = {
  kind: 'audio' | 'video'; src: string; name: string; zh: boolean; busy: boolean;
  onPlay(node: HTMLMediaElement): void; onError(): void; onExport?(edit: AttachmentEdit): Promise<boolean>;
};
const clock = (value: number) => Math.floor(value / 60) + ':' + String(Math.floor(value % 60)).padStart(2, '0');
export function BotPlaybackStudio({ kind, src, name, zh, busy, onPlay, onError, onExport }: Props) {
  const player = useRef<HTMLMediaElement | null>(null), [rate, setRate] = useState(1), [loop, setLoop] = useState(false);
  const [duration, setDuration] = useState(0), [trim, setTrim] = useState(false), [audition, setAudition] = useState(false);
  const [start, setStart] = useState('0'), [end, setEnd] = useState(''), [problem, setProblem] = useState('');
  const bindPlayer = useCallback((node: HTMLMediaElement | null) => {
    if (player.current && player.current !== node) player.current.pause();
    player.current = node;
  }, []);
  const from = Number(start), to = Number(end);
  const valid = start !== '' && end !== '' && from >= 0 && to > from && to <= duration;
  function seek(seconds: number) {
    const p = player.current; if (p && duration) p.currentTime = Math.max(0, Math.min(duration, p.currentTime + seconds));
  }
  const props = {
    src, controls: true, preload: 'metadata', 'data-bot-attachment-player': true, 'aria-label': name, loop: loop && !audition,
    onPlay: (e: React.SyntheticEvent<HTMLMediaElement>) => onPlay(e.currentTarget), onError,
    onRateChange: (e: React.SyntheticEvent<HTMLMediaElement>) => setRate(e.currentTarget.playbackRate),
    onDurationChange: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const seconds = e.currentTarget.duration;
      if (Number.isFinite(seconds) && seconds > 0) { setDuration(seconds); setEnd(String(seconds)); }
    },
    onPause: () => setAudition(false),
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const p = e.currentTarget;
      if (audition && (p.currentTime >= to || p.currentTime < from - 0.1)) { p.pause(); setAudition(false); }
    },
  };
  const toggleTrim = () => { player.current?.pause(); setAudition(false); setTrim(!trim); };
  const label = zh ? '播放速度' : 'Playback speed';
  return <>
    <div className="attachment-tools"><label>{label} <select aria-label={label} value={rate} onChange={e => {
      const speed = Number(e.target.value); if (player.current) player.current.playbackRate = speed; setRate(speed);
    }}>{[...new Set([0.5, 0.75, 1, 1.25, 1.5, 2, rate])].sort((a,b) => a-b).map(r => <option key={r} value={r}>{r}×</option>)}</select></label>
      <button aria-pressed={loop} onClick={() => setLoop(!loop)}><BotIcon name="replay"/>{zh ? '循环' : 'Loop'}</button><i/>
      <button disabled={!duration} onClick={() => seek(-5)}>−5 s</button><button disabled={!duration} onClick={() => seek(5)}>+5 s</button>
      <div className="attachment-spacer"/>{onExport && <button disabled={!duration || busy} aria-expanded={trim} onClick={toggleTrim}><BotIcon name="edit"/>{zh ? '截取片段' : 'Trim clip'}</button>}
    </div>
    <div className={'bot-attachment-viewer-content attachment-playback-stage is-' + kind}>
      {kind === 'video' ? <div className="bot-attachment-player"><video {...props} playsInline ref={bindPlayer}/></div>
        : <div className="bot-attachment-audio-player"><span><BotIcon name="music"/></span><strong>{name}</strong><audio {...props} ref={bindPlayer}/></div>}
    </div>
    {trim && <div className="attachment-tools attachment-clip-tools">
      {([[zh ? '起点（秒）' : 'Start (s)', start, setStart], [zh ? '终点（秒）' : 'End (s)', end, setEnd]] as const).map(([caption, value, update]) =>
        <label key={caption}>{caption} <input type="number" min="0" max={duration} step="any" value={value} disabled={busy} onChange={e => { player.current?.pause(); update(e.target.value); }}/>
          <button disabled={busy} onClick={() => { player.current?.pause(); update(String(Math.min(duration, Number((player.current?.currentTime || 0).toFixed(3))))); }} aria-label={(zh ? '用播放位置设置' : 'Set from playhead: ') + caption}>{zh ? '取当前' : 'Mark'}</button></label>)}
      <button disabled={!valid} onClick={async () => {
        const p = player.current; if (!p) return;
        if (audition) { p.pause(); return; }
        p.currentTime = from; setAudition(true); setProblem('');
        try { await p.play(); } catch { setAudition(false); setProblem(zh ? '片段暂时无法播放。' : 'Could not play selection.'); }
      }}>{audition ? zh ? '暂停' : 'Pause' : zh ? '预览片段' : 'Preview clip'}</button>
      <div className="attachment-spacer"/>{!valid && <span>{zh ? '请选择有效的起止时间' : 'Choose a valid interval'}</span>}
      <button className="attachment-primary" disabled={!valid || busy} onClick={() => void onExport?.({ kind: 'clip', start: from, end: to })}><BotIcon name="download"/>{zh ? '导出片段' : 'Export clip'} · {kind === 'video' ? 'WebM' : 'M4A'}</button>
    </div>}
    {problem && <span role="alert">{problem}</span>}
    <footer className="attachment-tools attachment-status"><span>{duration ? (zh ? '时长 ' : 'Duration ') + clock(duration) : zh ? '正在读取媒体信息…' : 'Loading metadata…'}</span>{trim && valid && <span>{zh ? '所选片段 ' : 'Selection '}{(to - from).toFixed(2)} s</span>}</footer>
  </>;
}

